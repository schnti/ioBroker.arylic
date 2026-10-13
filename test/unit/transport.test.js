'use strict';

const assert = require('node:assert');
const { RawTcpTransport } = require('../../lib/transport');

describe('RawTcpTransport framing', () => {
    it('splits at semicolons and keeps an incomplete rest', () => {
        const t = new RawTcpTransport('127.0.0.1');
        const messages = [];
        t.on('message', m => messages.push(m));
        t.receive('VOL:53;MX');
        t.receive('V:50;\r\n;PLA:0;');
        assert.deepStrictEqual(messages, ['VOL:53', 'MXV:50', 'PLA:0']);
        assert.strictEqual(t.buffer, '');
    });

    it('refuses to send without a connection', () => {
        assert.strictEqual(new RawTcpTransport('127.0.0.1').send('VOL'), false);
    });
});
