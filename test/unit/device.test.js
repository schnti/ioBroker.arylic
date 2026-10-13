'use strict';

const assert = require('node:assert');
const { ArylicDevice } = require('../../lib/device');

function fakeAdapter() {
    const timers = [];
    return {
        states: {},
        timers,
        log: { info() {}, warn() {}, debug() {}, error() {} },
        setState(id, val, ack) {
            this.states[id] = { val, ack };
        },
        setTimeout(fn) {
            timers.push(fn);
            return fn;
        },
        clearTimeout(fn) {
            const i = timers.indexOf(fn);
            if (i >= 0) {
                timers.splice(i, 1);
            }
        },
        setInterval() {
            return null;
        },
        clearInterval() {},
    };
}

function deviceWithTransport() {
    const adapter = fakeAdapter();
    const device = new ArylicDevice(adapter, {
        id: 'kueche',
        name: 'Kueche',
        host: '127.0.0.1',
        pollMs: 60000,
        onConnectionChange() {},
    });
    const sent = [];
    device.transport = { send: text => (sent.push(text), true) };
    return { adapter, device, sent };
}

describe('ArylicDevice queue', () => {
    it('sends one command at a time and moves on with the answer', () => {
        const { device, sent } = deviceWithTransport();
        device.send('VOL');
        device.send('MXV');
        assert.deepStrictEqual(sent, ['VOL']);
        device.handle('VOL:53');
        assert.deepStrictEqual(sent, ['VOL', 'MXV']);
    });

    it('moves on after the answer timeout', () => {
        const { adapter, device, sent } = deviceWithTransport();
        device.send('VOL');
        device.send('MXV');
        adapter.timers[0]();
        assert.deepStrictEqual(sent, ['VOL', 'MXV']);
    });

    it('lets a newer write replace a queued one and skips duplicate reads', () => {
        const { device, sent } = deviceWithTransport();
        device.send('PLA');
        device.write('volume', 20);
        device.write('volume', 25);
        device.send('VOL');
        device.handle('PLA:0');
        device.handle('VOL:25');
        assert.deepStrictEqual(sent, ['PLA', 'VOL:25']);
    });

    it('confirms values with ack=true from the device answer', () => {
        const { adapter, device } = deviceWithTransport();
        device.handle('MXV:50');
        assert.deepStrictEqual(adapter.states['kueche.maxVolume'], { val: 50, ack: true });
    });

    it('resets the standby button and sends nothing when released', () => {
        const { adapter, device, sent } = deviceWithTransport();
        device.write('standby', false);
        assert.deepStrictEqual(sent, []);
        device.write('standby', true);
        assert.deepStrictEqual(sent, ['SYS:STANDBY']);
        assert.deepStrictEqual(adapter.states['kueche.standby'], { val: false, ack: true });
    });

    it('ignores writes to read-only states', () => {
        const { device, sent } = deviceWithTransport();
        device.write('playing', true);
        device.write('info.ip', '1.2.3.4');
        assert.deepStrictEqual(sent, []);
    });
});
