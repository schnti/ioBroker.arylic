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
        objects: {},
        extended: [],
        async extendObjectAsync(id, obj) {
            this.extended.push({ id, obj });
        },
        async getObjectAsync(id) {
            return this.objects[id] || { common: {} };
        },
        async setObjectAsync(id, obj) {
            this.objects[id] = obj;
        },
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
    const transport = { closed: false, send: text => (sent.push(text), true), close: () => (transport.closed = true), destroy() {} };
    device.transport = transport;
    return { adapter, device, sent, transport };
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

    it('does not write an unchanged value again', () => {
        const { adapter, device } = deviceWithTransport();
        device.handle('VOL:10');
        adapter.states['kueche.volume'].ack = 'marker';
        device.handle('VOL:10');
        assert.strictEqual(adapter.states['kueche.volume'].ack, 'marker');
    });

    it('always confirms the answer to a command, even if the value did not change', () => {
        const { adapter, device } = deviceWithTransport();
        device.handle('VOL:10');
        device.write('volume', 30);
        adapter.states['kueche.volume'] = { val: 30, ack: false };
        device.handle('VOL:10');
        assert.deepStrictEqual(adapter.states['kueche.volume'], { val: 10, ack: true });
    });

    it('ignores writes to read-only states', () => {
        const { device, sent } = deviceWithTransport();
        device.write('playing', true);
        device.write('info.ip', '1.2.3.4');
        assert.deepStrictEqual(sent, []);
    });

    it('sends again after stop/start with a command in flight (address change)', () => {
        const { device, sent } = deviceWithTransport();
        device.send('VOL');
        device.send('MXV');
        device.stop();
        assert.strictEqual(device.waiting, null);
        assert.strictEqual(device.queue.size, 0);
        device.transport = { send: text => (sent.push(text), true) };
        device.send('PLA');
        assert.deepStrictEqual(sent, ['VOL', 'PLA']);
    });

    it('drops the connection after a whole poll without any answer', () => {
        const { adapter, device, transport } = deviceWithTransport();
        ['VOL', 'MXV', 'MUT', 'SRC', 'PLA', 'BAS', 'MID', 'TRE', 'BAL', 'VBS', 'EQE', 'EQS', 'CFE', 'CFF', 'LED']
            .concat(['BEP', 'NAM', 'DLY', 'POM', 'ASW', 'VST', 'VOF', 'SOP', 'IPA', 'ETH', 'WIF', 'CHN', 'MRM', 'VER'])
            .forEach(code => device.send(code));
        while (adapter.timers.length && !transport.closed) {
            adapter.timers.shift()();
        }
        assert.strictEqual(transport.closed, true);
    });

    it('keeps the connection while the device answers something', () => {
        const { adapter, device, transport } = deviceWithTransport();
        for (let i = 0; i < 40; i++) {
            device.send('VOL');
            adapter.timers.shift()();
            device.handle('NET:1');
        }
        assert.strictEqual(transport.closed, false);
    });

    it('does not merge quick button presses', () => {
        const { adapter, device, sent } = deviceWithTransport();
        device.write('next', true);
        device.write('next', true);
        device.write('next', true);
        while (adapter.timers.length) {
            adapter.timers.shift()();
        }
        assert.deepStrictEqual(sent, ['NXT', 'NXT', 'NXT']);
    });

    it('sends writes before queued reads', () => {
        const { device, sent } = deviceWithTransport();
        device.send('VOL');
        device.send('MXV');
        device.send('MUT');
        device.write('settings.led', false);
        device.handle('VOL:10');
        assert.deepStrictEqual(sent, ['VOL', 'LED:0']);
    });

    it('rejects an invalid write and puts the device value back', () => {
        const { adapter, device, sent } = deviceWithTransport();
        device.handle('MXV:50');
        device.write('maxVolume', null);
        device.write('source', 'NET;SYS:STANDBY');
        device.write('standby', 'false');
        assert.deepStrictEqual(sent, []);
        assert.deepStrictEqual(adapter.states['kueche.maxVolume'], { val: 50, ack: true });
    });

    it('writes all values again on refresh, so outside changes are repaired', () => {
        const { adapter, device } = deviceWithTransport();
        device.handle('VOL:53');
        adapter.states['kueche.volume'] = { val: 30, ack: true };
        device.handle('VOL:53');
        assert.strictEqual(adapter.states['kueche.volume'].val, 30);
        device.refresh();
        device.handle('VOL:53');
        assert.strictEqual(adapter.states['kueche.volume'].val, 53);
    });

    it('replaces the choices of a state instead of merging them', async () => {
        const { adapter, device } = deviceWithTransport();
        adapter.objects['kueche.source'] = { common: { states: { NET: 'NET', USBDAC: 'USBDAC' } } };
        device.handle('LST:NET,BT');
        await new Promise(resolve => setImmediate(resolve));
        assert.deepStrictEqual(adapter.objects['kueche.source'].common.states, { NET: 'NET', BT: 'BT' });
    });

    it('takes its display name from the device', () => {
        const { adapter, device } = deviceWithTransport();
        device.handle('NAM:4BC3BC636865');
        assert.strictEqual(device.name, 'Küche');
        assert.deepStrictEqual(adapter.extended.pop(), { id: 'kueche', obj: { common: { name: 'Küche' } } });
    });
});
