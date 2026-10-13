'use strict';

const { isIPv4 } = require('node:net');

/** Arylic devices announce themselves as AirPlay receivers. */
const SERVICE_TYPE = 'airplay';

/**
 * Reads an AirPlay announcement. Arylic devices carry `manufacturer=Arylic` and
 * their serial number in the TXT record.
 *
 * @param {import('bonjour-service').Service} service announced AirPlay service
 * @returns {{ name: string, host: string, info: { model?: string, serial: string, firmware?: string } } | null}
 *   null if it is not an Arylic device or has no usable address
 */
function parseService(service) {
    const txt = service.txt || {};
    if (String(txt.manufacturer).toLowerCase() !== 'arylic' || !txt.serialNumber) {
        return null;
    }
    const host = (service.addresses || []).find(isIPv4) || service.referer?.address;
    if (!host) {
        return null;
    }
    return {
        name: service.name,
        host,
        info: { model: txt.model, serial: txt.serialNumber, firmware: txt.fv },
    };
}

module.exports = { SERVICE_TYPE, parseService };
