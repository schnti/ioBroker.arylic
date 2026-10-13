'use strict';

const utils = require('@iobroker/adapter-core');
const { Bonjour } = require('bonjour-service');
const { ArylicDevice } = require('./lib/device');
const { FIELDS } = require('./lib/fields');
const { SERVICE_TYPE, parseService } = require('./lib/discovery');
const { ArylicDeviceManagement } = require('./lib/device-management');

class Arylic extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] adapter options
     */
    constructor(options = {}) {
        super({ ...options, name: 'arylic' });
        this.devices = new Map();
        this.bonjour = null;
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
            await this.addDevice({ id: this.toId(name), name, host: entry.host });
        }

        if (this.config.discovery) {
            this.startDiscovery();
        }
        if (!this.devices.size && !this.config.discovery) {
            this.log.warn('No devices configured and discovery is off');
        }
    }

    startDiscovery() {
        this.bonjour = new Bonjour();
        this.bonjour.find({ type: SERVICE_TYPE }).on('up', service => {
            this.onServiceUp(service).catch(err => this.log.error(`Discovery: ${err.message}`));
        });
        this.log.info(`Discovery started (mDNS, _${SERVICE_TYPE}._tcp)`);
    }

    /**
     * @param {import('bonjour-service').Service} service announced AirPlay service
     */
    async onServiceUp(service) {
        const found = parseService(service);
        if (!found) {
            return;
        }
        // Known by serial number, or a manually configured device at this address.
        const known = [...this.devices.values()].find(
            d => d.info.serial === found.info.serial || d.host === found.host,
        );
        if (known) {
            known.setInfo(found.info);
            known.setHost(found.host);
            return;
        }
        this.log.info(`Discovered ${found.info.model || 'Arylic'} "${found.name}" at ${found.host}`);
        await this.addDevice({ id: this.toId(found.info.serial), ...found });
    }

    /**
     * @param {object} options device options
     * @param {string} options.id object id below the instance
     * @param {string} options.name display name
     * @param {string} options.host IP address or host name
     * @param {Record<string, string>} [options.info] model, serial, firmware from mDNS
     * @returns {Promise<ArylicDevice>} the started device
     */
    async addDevice({ id, name, host, info }) {
        const device = new ArylicDevice(this, {
            id,
            name,
            host,
            info,
            pollMs: this.pollMs,
            onConnectionChange: () => this.updateConnection(),
        });
        this.devices.set(id, device);
        await device.createObjects();
        await Promise.all(FIELDS.filter(f => f.write).map(f => this.subscribeStatesAsync(`${id}.${f.id}`)));
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
        return String(text).toLowerCase().replace(this.FORBIDDEN_CHARS, '_').replace(/[.\s]/g, '_');
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
