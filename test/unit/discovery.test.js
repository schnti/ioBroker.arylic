'use strict';

const assert = require('node:assert');
const { parseService } = require('../../lib/discovery');

const LA50 = {
    name: 'Kueche',
    addresses: ['fe80::1', '10.0.0.61'],
    txt: { manufacturer: 'Arylic', model: 'LA50', serialNumber: 'RKARYLLA504725001777', fv: 'p20.AR241CP_8647.14.1' },
};

describe('parseService', () => {
    it('reads an Arylic announcement and picks the IPv4 address', () => {
        assert.deepStrictEqual(parseService(LA50), {
            name: 'Kueche',
            host: '10.0.0.61',
            info: { model: 'LA50', serial: 'RKARYLLA504725001777', firmware: 'p20.AR241CP_8647.14.1' },
        });
    });

    it('ignores other AirPlay receivers', () => {
        assert.strictEqual(parseService({ ...LA50, txt: { ...LA50.txt, manufacturer: 'Apple' } }), null);
    });

    it('ignores announcements without a serial number or address', () => {
        assert.strictEqual(parseService({ ...LA50, txt: { manufacturer: 'Arylic' } }), null);
        assert.strictEqual(parseService({ ...LA50, addresses: ['fe80::1'] }), null);
    });

    it('falls back to the address the announcement came from', () => {
        assert.strictEqual(parseService({ ...LA50, addresses: [], referer: { address: '10.0.0.62' } }).host, '10.0.0.62');
    });
});
