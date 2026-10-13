'use strict';

/**
 * Reads all values from a real device, without ioBroker. Nothing is written.
 *
 *   npm run live              find devices via mDNS
 *   npm run live -- 10.0.0.61 connect to this address
 */

const { Bonjour } = require('bonjour-service');
const { ArylicDevice } = require('../lib/device');
const { SERVICE_TYPE, parseService } = require('../lib/discovery');

const RUN_MS = 20 * 1000;

const adapter = {
    log: { info: console.log, warn: console.warn, debug() {}, error: console.error },
    async extendObjectAsync() {},
    setState: (id, val) => console.log(`${id.padEnd(40)} ${JSON.stringify(val)}`),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
};

const devices = new Map();

function start(id, name, host, info) {
    if (devices.has(id)) {
        return;
    }
    const device = new ArylicDevice(adapter, { id, name, host, info, pollMs: RUN_MS, onConnectionChange() {} });
    devices.set(id, device);
    device.setInfo(device.info);
    device.start();
}

let bonjour = null;
const host = process.argv[2];
if (host) {
    start(host, host, host);
} else {
    console.log(`Searching via mDNS (_${SERVICE_TYPE}._tcp, manufacturer=Arylic) …`);
    bonjour = new Bonjour();
    bonjour.find({ type: SERVICE_TYPE }).on('up', service => {
        const found = parseService(service);
        if (found) {
            console.log(`Found ${found.info.model} "${found.name}" at ${found.host}`);
            start(found.info.serial.toLowerCase(), found.name, found.host, found.info);
        }
    });
}

setTimeout(() => {
    if (!devices.size) {
        console.log('No device found.');
    }
    devices.forEach(device => device.stop());
    if (bonjour) {
        bonjour.destroy();
    }
    process.exit(0);
}, RUN_MS);
