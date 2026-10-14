'use strict';

const { isIP } = require('node:net');
const dns = require('node:dns').promises;
const utils = require('@iobroker/adapter-core');
const { Bonjour } = require('bonjour-service');
const { ArylicDevice } = require('./lib/device');
const { FIELDS } = require('./lib/fields');
const { SERVICE_TYPE, parseService } = require('./lib/discovery');
const { ArylicDeviceManagement } = require('./lib/device-management');

// A fresh mDNS browser this often: the browser reports a service only once and
// misses an address change of a service it already knows.
const REDISCOVER_MS = 5 * 60 * 1000;
// Taken by the instance's own `info` channel.
const RESERVED_IDS = new Set(['info']);

class Arylic extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] adapter options
     */
    constructor(options = {}) {
        super({ ...options, name: 'arylic' });
        this.devices = new Map();
        this.bonjour = null;
        this.browser = null;
        this.rediscoverTimer = null;
        /** Serial numbers whose device is being created. */
        this.adding = new Set();
        this.unloaded = false;
        this.deviceManagement = new ArylicDeviceManagement(this);
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        await this.setState('info.connection', false, true);
        this.pollMs = Math.max(10, Number(this.config.pollInterval) || 60) * 1000;

        for (const entry of this.config.devices || []) {
            if (!entry.host) {
                continue;
            }
            const name = entry.name || entry.host;
            const address = await this.resolve(entry.host);
            await this.addDevice({ id: this.uniqueId(this.toId(name)), name, host: entry.host, address });
        }

        if (this.config.discovery) {
            await this.restoreDiscovered();
            if (!this.unloaded) {
                this.startDiscovery();
            }
        }
        if (!this.devices.size && !this.config.discovery) {
            this.log.warn('No devices configured and discovery is off');
        }
    }

    /** Starts the devices found in an earlier run right away, instead of waiting for their next announcement. */
    async restoreDiscovered() {
        const objects = await this.getForeignObjectsAsync(`${this.namespace}.*`, 'device');
        for (const [fullId, obj] of Object.entries(objects)) {
            const id = fullId.slice(this.namespace.length + 1);
            const { host, serial } = obj.native || {};
            if (!host || !serial || this.devices.has(id) || this.findBySerial(serial)) {
                continue;
            }
            const name = typeof obj.common.name === 'string' ? obj.common.name : id;
            await this.addDevice({ id, name, host, info: { serial } });
        }
    }

    startDiscovery() {
        this.bonjour = new Bonjour();
        // Without a listener, a failed bind of UDP 5353 would crash the adapter.
        this.bonjour.server.mdns.on('error', err => this.log.warn(`Discovery: ${err.message}`));
        this.browse();
        this.rediscoverTimer = this.setInterval(() => this.browse(), REDISCOVER_MS);
        this.log.info(`Discovery started (mDNS, _${SERVICE_TYPE}._tcp)`);
    }

    /** Asks the network for all Arylic devices with a fresh browser. */
    browse() {
        if (this.browser) {
            this.browser.stop();
        }
        this.browser = this.bonjour.find({ type: SERVICE_TYPE });
        const onService = service => {
            this.onService(service).catch(err => this.log.error(`Discovery: ${err.message}`));
        };
        this.browser.on('up', onService);
        this.browser.on('srv-update', onService);
        this.browser.on('txt-update', onService);
    }

    /**
     * @param {import('bonjour-service').Service} service announced AirPlay service
     */
    async onService(service) {
        const found = parseService(service);
        if (!found || this.unloaded || this.adding.has(found.info.serial)) {
            return;
        }
        // Known by serial number — or, only for a configured device whose serial
        // number is not known yet, by its address.
        const known =
            this.findBySerial(found.info.serial) ||
            [...this.devices.values()].find(d => !d.info.serial && (d.host === found.host || d.address === found.host));
        if (known) {
            known.setInfo(found.info);
            known.setHost(found.host);
            return;
        }
        this.log.info(`Discovered ${found.info.model || 'Arylic'} "${found.name}" at ${found.host}`);
        this.adding.add(found.info.serial);
        try {
            await this.addDevice({ id: this.uniqueId(this.toId(found.info.serial)), ...found });
        } finally {
            this.adding.delete(found.info.serial);
        }
    }

    /**
     * @param {string} serial serial number
     * @returns {ArylicDevice | undefined} the device with this serial number
     */
    findBySerial(serial) {
        return [...this.devices.values()].find(d => d.info.serial === serial);
    }

    /**
     * @param {object} options device options
     * @param {string} options.id object id below the instance
     * @param {string} options.name display name
     * @param {string} options.host IP address or host name
     * @param {string} [options.address] resolved IP address of host
     * @param {Record<string, string>} [options.info] model, serial, firmware from mDNS
     * @returns {Promise<ArylicDevice>} the device, started unless the adapter is stopping
     */
    async addDevice({ id, name, host, address, info }) {
        const device = new ArylicDevice(this, {
            id,
            name,
            host,
            address,
            info,
            pollMs: this.pollMs,
            onConnectionChange: () => this.updateConnection(),
        });
        this.devices.set(id, device);
        await device.createObjects();
        await Promise.all(FIELDS.filter(f => f.write).map(f => this.subscribeStatesAsync(`${id}.${f.id}`)));
        if (!this.unloaded) {
            device.start();
        }
        return device;
    }

    /**
     * @param {string} host IP address or host name from the configuration
     * @returns {Promise<string>} its IP address, or host if it cannot be resolved
     */
    async resolve(host) {
        if (isIP(host)) {
            return host;
        }
        try {
            return (await dns.lookup(host, { family: 4 })).address;
        } catch {
            return host;
        }
    }

    updateConnection() {
        const connected = [...this.devices.values()].some(d => d.connected);
        this.setState('info.connection', connected, true);
    }

    /**
     * @param {string} text device name, host or serial number
     * @returns {string} usable as an object id segment
     */
    toId(text) {
        return String(text).toLowerCase().replace(this.FORBIDDEN_CHARS, '_').replace(/[.\s]/g, '_');
    }

    /**
     * Two configured names can map to the same id ("Bad oben", "Bad.oben"); the second gets a suffix.
     *
     * @param {string} base id from toId()
     * @returns {string} an id no other device uses
     */
    uniqueId(base) {
        const start = RESERVED_IDS.has(base) ? `${base}_device` : base;
        let id = start;
        for (let n = 2; this.devices.has(id); n++) {
            id = `${start}_${n}`;
        }
        return id;
    }

    /**
     * @param {string} id full state id
     * @param {ioBroker.State | null | undefined} state new state
     */
    onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        }
        const [deviceId, ...rest] = id.slice(this.namespace.length + 1).split('.');
        const device = this.devices.get(deviceId);
        if (device) {
            device.write(rest.join('.'), state.val);
        }
    }

    /**
     * @param {() => void} callback must be called at the end
     */
    onUnload(callback) {
        try {
            this.unloaded = true;
            this.clearInterval(this.rediscoverTimer);
            this.devices.forEach(d => d.stop());
            if (this.browser) {
                this.browser.stop();
            }
            if (this.bonjour) {
                this.bonjour.destroy();
            }
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new Arylic(options);
} else {
    new Arylic();
}
