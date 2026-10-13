'use strict';

const { RawTcpTransport } = require('./transport');
const {
    KINDS,
    STATES,
    CHANNELS,
    CHANNEL_NAMES,
    READABLE,
    BY_ID,
    parseMessage,
    commandFor,
    statesFromList,
} = require('./fields');

const ANSWER_MS = 1500;
const RECONNECT_MIN_MS = 10 * 1000;
const RECONNECT_MAX_MS = 5 * 60 * 1000;

const ON_CONNECT = READABLE.map(f => f.code);
const ON_POLL = READABLE.filter(f => !f.once).map(f => f.code);
const KNOWN_STATES = new Set(STATES.map(f => f.id));

/**
 * One amplifier: keeps the connection, reads all values on connect and on every
 * poll, and turns writes from ioBroker into commands.
 *
 * Restart-safe: nothing is remembered, every (re)connect reads the device.
 * A write (ack=false) is a command; the device's answer sets the value again
 * with ack=true — if no answer comes, the command was not accepted.
 * Unchanged values are not written again, except as the answer to a command.
 */
class ArylicDevice {
    /**
     * @param {ioBroker.Adapter} adapter adapter instance
     * @param {object} options device options
     * @param {string} options.id object id below the instance
     * @param {string} options.name display name
     * @param {string} options.host IP address or host name
     * @param {Record<string, string>} [options.info] model, serial, firmware from mDNS
     * @param {number} options.pollMs poll interval in ms
     * @param {(device: ArylicDevice) => void} options.onConnectionChange called when connected changes
     */
    constructor(adapter, { id, name, host, info = {}, pollMs, onConnectionChange }) {
        this.adapter = adapter;
        this.id = id;
        this.name = name;
        this.host = host;
        /** model, serial, firmware from mDNS */
        this.info = { ...info };
        this.pollMs = pollMs;
        this.onConnectionChange = onConnectionChange;

        this.transport = null;
        this.connected = false;
        this.stopped = false;
        this.delay = RECONNECT_MIN_MS;
        this.reconnectTimer = null;
        this.pollTimer = null;
        this.waiting = null;
        this.waitTimer = null;
        // Pending commands by code: a newer write replaces a queued one, a read
        // is skipped if that code is already queued.
        this.queue = new Map();
        /** Last value written per state id. */
        this.values = new Map();
        /** States written from ioBroker whose answer has not arrived yet. */
        this.pendingWrites = new Set();
    }

    /** Creates or updates the device's objects and removes outdated ones. */
    async createObjects() {
        await this.adapter.extendObjectAsync(this.id, {
            type: 'device',
            common: { name: this.name },
            native: { host: this.host },
        });
        await Promise.all(
            CHANNELS.map(channel =>
                this.adapter.extendObjectAsync(`${this.id}.${channel}`, {
                    type: 'channel',
                    common: { name: CHANNEL_NAMES[channel] || channel },
                    native: {},
                }),
            ),
        );
        await Promise.all(
            STATES.map(field => {
                const kind = KINDS[field.kind];
                return this.adapter.extendObjectAsync(`${this.id}.${field.id}`, {
                    type: 'state',
                    common: {
                        name: field.code || field.id.split('.').pop(),
                        type: kind.type,
                        def: kind.def,
                        read: field.kind !== 'button',
                        write: !!field.write,
                        ...field.common,
                    },
                    native: field.code ? { code: field.code } : {},
                });
            }),
        );
        await this.removeLeftovers();
        this.setInfo(this.info);
    }

    /** Deletes states below the device that no field defines any more. */
    async removeLeftovers() {
        const prefix = `${this.adapter.namespace}.${this.id}.`;
        const objects = await this.adapter.getForeignObjectsAsync(`${prefix}*`, 'state');
        for (const fullId of Object.keys(objects)) {
            const stateId = fullId.slice(prefix.length);
            if (!KNOWN_STATES.has(stateId)) {
                this.adapter.log.info(`${this.name}: removing outdated state ${stateId}`);
                await this.adapter.delObjectAsync(`${this.id}.${stateId}`);
            }
        }
    }

    /**
     * Sets read-only information that comes from outside the UART API (mDNS).
     *
     * @param {Record<string, string>} info e.g. { model, serial, firmware }
     */
    setInfo(info) {
        Object.assign(this.info, info);
        for (const [key, val] of Object.entries(info)) {
            if (val !== undefined) {
                this.setValue(`info.${key}`, val);
            }
        }
    }

    /**
     * Writes a value with ack=true if it changed, or if it answers a command.
     *
     * @param {string} stateId state id below the device
     * @param {ioBroker.StateValue} val new value
     * @returns {boolean} true if the value changed
     */
    setValue(stateId, val) {
        const changed = this.values.get(stateId) !== val;
        if (changed || this.pendingWrites.delete(stateId)) {
            this.values.set(stateId, val);
            this.adapter.setState(`${this.id}.${stateId}`, val, true);
        }
        return changed;
    }

    /** Reads all values now, e.g. from the device manager. */
    refresh() {
        ON_CONNECT.forEach(code => this.send(code));
    }

    /** Connects and keeps reconnecting until stop(). */
    start() {
        this.stopped = false;
        this.connect();
    }

    /** Closes the connection for good and clears all timers. */
    stop() {
        this.stopped = true;
        this.adapter.clearTimeout(this.reconnectTimer);
        this.adapter.clearTimeout(this.waitTimer);
        this.adapter.clearInterval(this.pollTimer);
        if (this.transport) {
            this.transport.destroy();
            this.transport = null;
        }
        this.setConnected(false);
    }

    /**
     * Follows an address change (mDNS) by reconnecting right away.
     *
     * @param {string} host new IP address
     */
    setHost(host) {
        if (host === this.host) {
            return;
        }
        this.adapter.log.info(`${this.name}: address changed ${this.host} → ${host}`);
        this.host = host;
        this.stop();
        this.delay = RECONNECT_MIN_MS;
        this.start();
    }

    /** Opens one connection; on close, schedules the next attempt with backoff. */
    connect() {
        const transport = new RawTcpTransport(this.host);
        this.transport = transport;

        transport.on('connect', () => {
            this.adapter.log.info(`${this.name}: connected to ${this.host}`);
            this.delay = RECONNECT_MIN_MS;
            this.setConnected(true);
            this.refresh();
            this.pollTimer = this.adapter.setInterval(() => ON_POLL.forEach(code => this.send(code)), this.pollMs);
        });
        transport.on('message', message => this.handle(message));
        transport.on('error', err => this.adapter.log.debug(`${this.name}: ${err.message}`));
        transport.on('close', () => {
            this.adapter.clearInterval(this.pollTimer);
            this.queue.clear();
            this.done();
            this.setConnected(false);
            if (this.stopped) {
                return;
            }
            this.reconnectTimer = this.adapter.setTimeout(() => this.connect(), this.delay);
            this.delay = Math.min(this.delay * 2, RECONNECT_MAX_MS);
        });
        transport.connect();
    }

    /**
     * @param {boolean} connected new connection state
     */
    setConnected(connected) {
        if (connected === this.connected) {
            return;
        }
        this.connected = connected;
        this.setValue('info.connected', connected);
        if (!connected && !this.stopped) {
            this.adapter.log.warn(`${this.name}: connection to ${this.host} lost`);
        }
        this.onConnectionChange(this);
    }

    /**
     * Queues a read (`text` undefined) or a write.
     *
     * @param {string} code UART command
     * @param {string} [text] full command text for a write
     */
    send(code, text) {
        if (text !== undefined) {
            this.queue.set(code, text);
        } else if (!this.queue.has(code)) {
            this.queue.set(code, code);
        }
        this.pump();
    }

    /**
     * Sends the next queued command.
     *
     * ⚠️ One command at a time: sent in a burst, the MCU drops some of the answers.
     * The next one goes out when the answer arrives, or after ANSWER_MS without one.
     */
    pump() {
        if (this.waiting || !this.queue.size || !this.transport) {
            return;
        }
        const [code, text] = this.queue.entries().next().value;
        this.queue.delete(code);
        if (!this.transport.send(text)) {
            this.queue.clear();
            return;
        }
        this.waiting = code;
        this.waitTimer = this.adapter.setTimeout(() => this.done(), ANSWER_MS);
    }

    /** Ends the wait for an answer and sends the next command. */
    done() {
        this.adapter.clearTimeout(this.waitTimer);
        this.waiting = null;
        this.pump();
    }

    /**
     * @param {string} message one message from the device, without `;`
     */
    handle(message) {
        const parsed = parseMessage(message);
        if (!parsed) {
            return;
        }
        if (parsed.code === this.waiting) {
            this.done();
        }
        // Everything else (NET, CFG, UPG, …) is chatter between the firmware and the MCU.
        if (!parsed.field) {
            return;
        }
        const changed = this.setValue(parsed.field.id, parsed.value);
        if (changed && parsed.field.statesOf) {
            this.adapter
                .extendObjectAsync(`${this.id}.${parsed.field.statesOf}`, {
                    common: { states: statesFromList(parsed.value) },
                })
                .catch(err => this.adapter.log.warn(`${this.name}: ${err.message}`));
        }
    }

    /**
     * Turns a write from ioBroker into a command.
     *
     * @param {string} stateId state id below the device, e.g. `volume`
     * @param {ioBroker.StateValue} val written value
     */
    write(stateId, val) {
        const field = BY_ID.get(stateId);
        if (!field || !field.write) {
            return;
        }
        const text = commandFor(field, val);
        if (text) {
            this.send(field.code, text);
        }
        if (field.kind === 'button') {
            this.adapter.setState(`${this.id}.${field.id}`, false, true);
        } else {
            this.pendingWrites.add(field.id);
        }
    }
}

module.exports = { ArylicDevice };
