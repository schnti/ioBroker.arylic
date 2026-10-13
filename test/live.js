'use strict';

/**
 * Reads all values from a real device, without ioBroker. Nothing is written.
 *
 *   npm run live              find devices via mDNS
 *   npm run live -- 10.0.0.61 connect to this address
 */

const { Bonjour } = require('bonjour-service');
const { ArylicDevice } = require('../lib/device');

const RUN_MS = 20 * 1000;

const adapter = {
    log: {
        info: msg => console.log(msg),
        warn: msg => console.warn(msg),
        debug() {},
        error: msg => console.error(msg),
    },
    async extendObjectAsync() {},
    async setStateAsync(id, val) {
        console.log(`${id.padEnd(40)} ${JSON.stringify(val)}`);
    },
    setState(id, val) {
        console.log(`${id.padEnd(40)} ${JSON.stringify(val)}`);
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: timer => clearTimeout(timer),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: timer => clearInterval(timer),
};

const devices = new Map();

function start(id, name, host, info) {
    if (devices.has(id)) {
        return;
    }
    const device = new ArylicDevice(adapter, { id, name, host, pollMs: RUN_MS, onConnectionChange() {} });
    devices.set(id, device);
    if (info) {
        device.setInfo(info);
    }
    device.start();
}

let bonjour = null;
const host = process.argv[2];
if (host) {
    start(host, host, host);
} else {
    console.log('Searching via mDNS (_airplay._tcp, manufacturer=Arylic) …');
    bonjour = new Bonjour();
    bonjour.find({ type: 'airplay' }).on('up', service => {
        const txt = service.txt || {};
        if (String(txt.manufacturer).toLowerCase() !== 'arylic' || !txt.serialNumber) {
            return;
        }
        const address = (service.addresses || []).find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a));
        console.log(`Found ${txt.model} "${service.name}" at ${address}`);
        start(txt.serialNumber.toLowerCase(), service.name, address, {
            model: txt.model,
            serial: txt.serialNumber,
            firmware: txt.fv,
        });
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
