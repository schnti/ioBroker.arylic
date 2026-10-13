'use strict';

const utils = require('@iobroker/adapter-core');
const { Bonjour } = require('bonjour-service');
const { ArylicDevice } = require('./lib/device');

class Arylic extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] adapter options
     */
    constructor(options = {}) {
        super({ ...options, name: 'arylic' });
        /** @type {Map<string, ArylicDevice>} */
        this.devices = new Map();
        this.bonjour = null;
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
            const id = this.toId(entry.name || entry.host);
            await this.addDevice(id, entry.name || entry.host, entry.host);
        }

        if (this.config.discovery) {
            this.startDiscovery();
        }
        if (!this.devices.size && !this.config.discovery) {
            this.log.warn('No devices configured and discovery is off');
        }

        this.subscribeStates('*');
    }

    /**
     * Arylic devices announce themselves as AirPlay receivers with
     * `manufacturer=Arylic` and their serial number in the TXT record.
     */
    startDiscovery() {
        this.bonjour = new Bonjour();
        const browser = this.bonjour.find({ type: 'airplay' });
        browser.on('up', service => {
            this.onServiceUp(service).catch(err => this.log.error(`Discovery: ${err.message}`));
        });
        this.log.info('Discovery started (mDNS, _airplay._tcp)');
    }

    /**
     * @param {import('bonjour-service').Service} service announced AirPlay service
     */
    async onServiceUp(service) {
        const txt = service.txt || {};
        if (String(txt.manufacturer).toLowerCase() !== 'arylic') {
            return;
        }
        const host = (service.addresses || []).find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || service.referer?.address;
        if (!host) {
            return;
        }
        const info = { model: txt.model, serial: txt.serialNumber, firmware: txt.fv };

        // A manually configured device with this address takes precedence.
        const known = [...this.devices.values()].find(d => d.serial === txt.serialNumber || d.host === host);
        if (known) {
            known.serial = txt.serialNumber;
            known.setHost(host);
            await known.setInfo(info);
            return;
        }
        if (!txt.serialNumber) {
            return;
        }
        this.log.info(`Discovered ${txt.model || 'Arylic'} "${service.name}" at ${host}`);
        const device = await this.addDevice(this.toId(txt.serialNumber), service.name, host);
        device.serial = txt.serialNumber;
        await device.setInfo(info);
    }

    /**
     * @param {string} id object id below the instance
     * @param {string} name display name
     * @param {string} host IP address or host name
     * @returns {Promise<ArylicDevice>} the started device
     */
    async addDevice(id, name, host) {
        const device = new ArylicDevice(this, {
            id,
            name,
            host,
            pollMs: this.pollMs,
            onConnectionChange: () => this.updateConnection(),
        });
        this.devices.set(id, device);
        await device.createObjects();
        device.start();
        return device;
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
        return String(text)
            .toLowerCase()
            .replace(this.FORBIDDEN_CHARS, '_')
            .replace(/[.\s]/g, '_');
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
            this.devices.forEach(d => d.stop());
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
