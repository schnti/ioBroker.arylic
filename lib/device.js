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
// Buttons get no answer of their own; this is only a gap before the next command.
const BUTTON_GAP_MS = 300;
const RECONNECT_MIN_MS = 10 * 1000;
const RECONNECT_MAX_MS = 5 * 60 * 1000;

const ON_CONNECT = READABLE.map(f => f.code);
const ON_POLL = READABLE.filter(f => !f.once).map(f => f.code);
const KNOWN_STATES = new Set(STATES.map(f => f.id));
// A whole poll without a single answer: the connection is dead even if TCP has not noticed.
const MAX_MISSES = ON_POLL.length;

/**
 * One amplifier: keeps the connection, reads all values on connect and on every
 * poll, and turns writes from ioBroker into commands.
 *
 * Restart-safe: every (re)connect reads the device. A write (ack=false) is a
 * command; the device's answer sets the value again with ack=true — if no answer
 * comes, the command was not accepted. Between full reads, a value is only
 * written when it changed or answers a command.
 */
class ArylicDevice {
    /**
     * @param {ioBroker.Adapter} adapter adapter instance
     * @param {object} options device options
     * @param {string} options.id object id below the instance
     * @param {string} options.name display name, used until the device reports its own
     * @param {string} options.host IP address or host name
     * @param {string} [options.address] resolved IP address of host, for matching announcements
     * @param {Record<string, string>} [options.info] model, serial, firmware from mDNS
     * @param {number} options.pollMs poll interval in ms
     * @param {(device: ArylicDevice) => void} options.onConnectionChange called when connected changes
     */
    constructor(adapter, { id, name, host, address, info = {}, pollMs, onConnectionChange }) {
        this.adapter = adapter;
        this.id = id;
        this.name = name;
        this.host = host;
        this.address = address || host;
        /** model, serial, firmware from mDNS */
        this.info = { ...info };
        this.pollMs = pollMs;
        this.onConnectionChange = onConnectionChange;

        this.transport = null;
        this.connected = false;
        this.stopped = false;
        this.lastError = null;
        this.delay = RECONNECT_MIN_MS;
        this.reconnectTimer = null;
        this.pollTimer = null;
        this.waiting = null;
        this.waitTimer = null;
        this.misses = 0;
        // Pending commands. Reads and writes are keyed by code: a newer write
        // replaces a queued one, a read is skipped if that code is already queued.
        // Every button press gets its own key.
        this.queue = new Map();
        this.presses = 0;
        /** Last value written per state id. */
        this.values = new Map();
        /** States written from ioBroker whose answer has not arrived yet. */
        this.pendingWrites = new Set();
    }

    /** Creates or updates the device's objects and removes outdated ones. */
    async createObjects() {
        const existing = await this.adapter.getObjectAsync(this.id);
        if (!this.info.serial && existing && existing.native && existing.native.serial) {
            this.info.serial = existing.native.serial;
        }
        await this.adapter.extendObjectAsync(this.id, {
            type: 'device',
            // A name set by the user or reported by the device is kept.
            common: existing ? {} : { name: this.name },
            native: { host: this.host, serial: this.info.serial },
        });
        if (existing && existing.common && existing.common.name) {
            this.name = existing.common.name;
        }
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
                        name: field.name,
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
        // Buttons are never read; without a value they look unfinished in the admin.
        STATES.filter(f => f.kind === 'button').forEach(f => this.adapter.setState(`${this.id}.${f.id}`, false, true));
        // Not connected yet — whatever an earlier run left there is stale.
        this.setValue('info.connected', false);
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
        if (info.serial && info.serial !== this.info.serial) {
            this.extend({ native: { serial: info.serial } });
        }
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

    /**
     * Updates the device object without waiting for it.
     *
     * @param {object} obj partial object, e.g. { common: { name } }
     */
    extend(obj) {
        this.adapter
            .extendObjectAsync(this.id, obj)
            .catch(err => this.adapter.log.warn(`${this.name}: ${err.message}`));
    }

    /** Reads all values now and writes them even if unchanged, e.g. from the device manager. */
    refresh() {
        // A state may have been changed by someone else; the full read puts the device's value back.
        READABLE.forEach(f => this.values.delete(f.id));
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
        if (this.transport) {
            this.transport.destroy();
            this.transport = null;
        }
        this.reset();
    }

    /** Forgets everything that belongs to one connection. */
    reset() {
        this.adapter.clearInterval(this.pollTimer);
        this.adapter.clearTimeout(this.waitTimer);
        this.waiting = null;
        this.queue.clear();
        this.misses = 0;
        this.pendingWrites.clear();
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
        this.address = host;
        this.extend({ native: { host } });
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
            this.lastError = null;
            this.delay = RECONNECT_MIN_MS;
            this.setConnected(true);
            this.refresh();
            this.pollTimer = this.adapter.setInterval(() => ON_POLL.forEach(code => this.send(code)), this.pollMs);
        });
        transport.on('message', message => this.handle(message));
        transport.on('error', err => {
            // The first failure is worth a warning, the same one on every retry is not.
            const text = `${this.name}: ${this.host}: ${err.message}`;
            if (err.message === this.lastError) {
                this.adapter.log.debug(text);
            } else {
                this.adapter.log.warn(text);
                this.lastError = err.message;
            }
        });
        transport.on('close', () => {
            this.reset();
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
            this.queue.set(code, { code, text, write: true });
        } else if (!this.queue.has(code)) {
            this.queue.set(code, { code, text: code });
        }
        this.pump();
    }

    /**
     * Queues a button press; presses are never merged.
     *
     * @param {string} code UART command
     * @param {string} text full command text
     */
    press(code, text) {
        this.queue.set(`${code}#${++this.presses}`, { code, text, write: true, button: true });
        this.pump();
    }

    /**
     * Sends the next queued command, writes before reads.
     *
     * ⚠️ One command at a time: sent in a burst, the MCU drops some of the answers.
     * The next one goes out when the answer arrives, or after ANSWER_MS without one.
     */
    pump() {
        if (this.waiting || !this.queue.size || !this.transport) {
            return;
        }
        let key = this.queue.keys().next().value;
        for (const [k, entry] of this.queue) {
            if (entry.write) {
                key = k;
                break;
            }
        }
        const entry = this.queue.get(key);
        this.queue.delete(key);
        if (!this.transport.send(entry.text)) {
            this.queue.clear();
            return;
        }
        this.waiting = entry.code;
        this.waitTimer = this.adapter.setTimeout(() => this.timeout(entry), entry.button ? BUTTON_GAP_MS : ANSWER_MS);
    }

    /**
     * No answer in time: move on, and give up the connection after a whole poll of silence.
     *
     * @param {{ button?: boolean }} entry the command that got no answer
     */
    timeout(entry) {
        if (!entry.button && ++this.misses >= MAX_MISSES && this.transport) {
            this.adapter.log.warn(`${this.name}: no answer from ${this.host}, reconnecting`);
            this.transport.close();
            return;
        }
        this.done();
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
        this.misses = 0;
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
        const { field, value } = parsed;
        if (!this.setValue(field.id, value)) {
            return;
        }
        if (field.statesOf) {
            this.replaceStates(field.statesOf, statesFromList(value)).catch(err =>
                this.adapter.log.warn(`${this.name}: ${err.message}`),
            );
        }
        if (field.id === 'settings.name' && value) {
            this.name = String(value);
            this.extend({ common: { name: this.name } });
        }
    }

    /**
     * Replaces the choices of a state. extendObject would merge them, so choices
     * the device no longer offers would stay.
     *
     * @param {string} stateId state id below the device
     * @param {Record<string, string>} states new choices
     */
    async replaceStates(stateId, states) {
        const obj = await this.adapter.getObjectAsync(`${this.id}.${stateId}`);
        if (obj) {
            obj.common.states = states;
            await this.adapter.setObjectAsync(`${this.id}.${stateId}`, obj);
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
        let text;
        try {
            text = commandFor(field, val);
        } catch (err) {
            this.adapter.log.warn(`${this.name}: ${stateId} not sent, ${err.message}`);
            this.restore(field);
            return;
        }
        if (field.kind === 'button') {
            this.adapter.setState(`${this.id}.${field.id}`, false, true);
            if (text) {
                this.press(field.code, text);
            }
            return;
        }
        this.pendingWrites.add(field.id);
        this.send(field.code, text);
    }

    /**
     * Puts the device's value back after a write that was not sent.
     *
     * @param {object} field entry of FIELDS
     */
    restore(field) {
        const val = field.kind === 'button' ? false : this.values.get(field.id);
        if (val !== undefined) {
            this.adapter.setState(`${this.id}.${field.id}`, val, true);
        }
    }
}

module.exports = { ArylicDevice };
