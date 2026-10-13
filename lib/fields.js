'use strict';

/**
 * Commands of the Arylic UART API (https://developer.arylic.com/uartapi/).
 * `CODE;` reads, `CODE:value;` sets, the device answers `CODE:value;` and also
 * pushes changes on its own.
 */

// How a value is read from and written to the device, per kind.
// `button` fields are never read; a write sends `code:value` and springs back.
const KINDS = {
    int: {
        type: 'number',
        def: 0,
        parse: raw => parseInt(raw, 10),
        format: val => String(Math.round(Number(val))),
    },
    bool: {
        type: 'boolean',
        def: false,
        parse: raw => raw === '1',
        format: val => (val ? '1' : '0'),
    },
    text: {
        type: 'string',
        def: '',
        parse: raw => raw,
        format: val => String(val),
    },
    // UTF-8 text sent as hex digits, e.g. the device name.
    hex: {
        type: 'string',
        def: '',
        parse: raw => Buffer.from(raw, 'hex').toString('utf8'),
        format: val => Buffer.from(String(val), 'utf8').toString('hex').toUpperCase(),
    },
    button: {
        type: 'boolean',
        def: false,
    },
};

// id: state below the device. once: read on connect only, the value does not
// change at runtime.
const FIELDS = [
    { code: 'VOL', id: 'volume', kind: 'int', write: true, common: { role: 'level.volume', min: 0, max: 100 } },
    { code: 'MXV', id: 'maxVolume', kind: 'int', write: true, common: { role: 'level.volume.max', min: 30, max: 100 } },
    { code: 'MUT', id: 'mute', kind: 'bool', write: true, common: { role: 'media.mute' } },
    { code: 'SRC', id: 'source', kind: 'text', write: true, common: { role: 'media.input' } },
    { code: 'BAS', id: 'bass', kind: 'int', write: true, common: { role: 'level', min: -10, max: 10, unit: 'dB' } },
    { code: 'MID', id: 'mid', kind: 'int', write: true, common: { role: 'level', min: -10, max: 10, unit: 'dB' } },
    { code: 'TRE', id: 'treble', kind: 'int', write: true, common: { role: 'level', min: -10, max: 10, unit: 'dB' } },
    { code: 'LED', id: 'led', kind: 'bool', write: true, common: { role: 'switch' } },
    { code: 'BEP', id: 'beep', kind: 'bool', write: true, common: { role: 'switch' } },
    { code: 'NAM', id: 'name', kind: 'hex', write: true, common: { role: 'info.name' } },
    { code: 'PLA', id: 'playing', kind: 'bool', write: false, common: { role: 'media.state' } },
    { code: 'LST', id: 'sources', kind: 'text', write: false, once: true, common: { role: 'text' } },
    { code: 'IPA', id: 'info.ip', kind: 'text', write: false, common: { role: 'info.ip' } },
    { code: 'VER', id: 'info.mcuVersion', kind: 'text', write: false, once: true, common: { role: 'info.firmware' } },
    // ⚠️ Nothing over the network wakes the LA50 up again (no web UI, no command) — only the IR remote.
    { code: 'SYS', id: 'standby', kind: 'button', value: 'STANDBY', write: true, common: { role: 'button' } },
];

const BY_CODE = new Map(FIELDS.filter(f => f.kind !== 'button').map(f => [f.code, f]));
const BY_ID = new Map(FIELDS.map(f => [f.id, f]));

/**
 * Splits one message such as `VOL:30` into its field and parsed value.
 *
 * @param {string} message one message without the trailing `;`
 * @returns {{ code: string, field?: object, value?: any } | null} null if it is no `CODE:value` message
 */
function parseMessage(message) {
    const sep = message.indexOf(':');
    if (sep < 0) {
        return null;
    }
    const code = message.slice(0, sep);
    const field = BY_CODE.get(code);
    if (!field) {
        return { code };
    }
    return { code, field, value: KINDS[field.kind].parse(message.slice(sep + 1)) };
}

/**
 * Builds the command text for a write to a field, without the trailing `;`.
 *
 * @param {object} field entry of FIELDS
 * @param {any} val value written by the user
 * @returns {string | null} null for a button that was not pressed
 */
function commandFor(field, val) {
    if (field.kind === 'button') {
        return val ? `${field.code}:${field.value}` : null;
    }
    return `${field.code}:${KINDS[field.kind].format(val)}`;
}

module.exports = { KINDS, FIELDS, BY_CODE, BY_ID, parseMessage, commandFor };
