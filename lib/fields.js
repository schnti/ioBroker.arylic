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
// change at runtime. statesOf: the value is the list of choices for that field.
const FIELDS = [
    { code: 'VOL', id: 'volume', kind: 'int', write: true, common: { role: 'level.volume', min: 0, max: 100 } },
    { code: 'MXV', id: 'maxVolume', kind: 'int', write: true, common: { role: 'level.volume.max', min: 30, max: 100 } },
    { code: 'MUT', id: 'mute', kind: 'bool', write: true, common: { role: 'media.mute' } },
    { code: 'SRC', id: 'source', kind: 'text', write: true, common: { role: 'media.input' } },
    {
        code: 'LST',
        id: 'sources',
        kind: 'text',
        write: false,
        once: true,
        statesOf: 'source',
        common: { role: 'text' },
    },
    { code: 'PLA', id: 'playing', kind: 'bool', write: false, common: { role: 'media.state' } },
    { code: 'POP', id: 'playPause', kind: 'button', write: true, common: { role: 'button' } },
    { code: 'STP', id: 'stop', kind: 'button', write: true, common: { role: 'button.stop' } },
    { code: 'NXT', id: 'next', kind: 'button', write: true, common: { role: 'button.next' } },
    { code: 'PRE', id: 'previous', kind: 'button', write: true, common: { role: 'button.prev' } },

    {
        code: 'BAS',
        id: 'sound.bass',
        kind: 'int',
        write: true,
        common: { role: 'level', min: -10, max: 10, unit: 'dB' },
    },
    {
        code: 'MID',
        id: 'sound.mid',
        kind: 'int',
        write: true,
        common: { role: 'level', min: -10, max: 10, unit: 'dB' },
    },
    {
        code: 'TRE',
        id: 'sound.treble',
        kind: 'int',
        write: true,
        common: { role: 'level', min: -10, max: 10, unit: 'dB' },
    },
    { code: 'BAL', id: 'sound.balance', kind: 'int', write: true, common: { role: 'level', min: -100, max: 100 } },
    { code: 'VBS', id: 'sound.virtualBass', kind: 'bool', write: true, common: { role: 'switch' } },
    { code: 'EQE', id: 'sound.eqEnabled', kind: 'bool', write: true, common: { role: 'switch' } },
    { code: 'EQS', id: 'sound.eqPreset', kind: 'int', write: true, common: { role: 'level' } },
    {
        code: 'PEQ',
        id: 'sound.eqPresets',
        kind: 'text',
        write: false,
        once: true,
        statesOf: 'sound.eqPreset',
        common: { role: 'text' },
    },
    { code: 'CFE', id: 'sound.crossover', kind: 'bool', write: true, common: { role: 'switch' } },
    {
        code: 'CFF',
        id: 'sound.crossoverFrequency',
        kind: 'int',
        write: true,
        common: { role: 'level', min: 50, max: 300, unit: 'Hz' },
    },

    { code: 'LED', id: 'settings.led', kind: 'bool', write: true, common: { role: 'switch' } },
    { code: 'BEP', id: 'settings.beep', kind: 'bool', write: true, common: { role: 'switch' } },
    { code: 'NAM', id: 'settings.name', kind: 'hex', write: true, common: { role: 'info.name' } },
    {
        code: 'DLY',
        id: 'settings.muteDelay',
        kind: 'int',
        write: true,
        common: { role: 'level', min: 0, max: 32767, unit: 's' },
    },
    { code: 'POM', id: 'settings.powerOnSource', kind: 'text', write: true, common: { role: 'text' } },
    { code: 'ASW', id: 'settings.autoSwitch', kind: 'bool', write: true, common: { role: 'switch' } },
    { code: 'VST', id: 'settings.volumeStep', kind: 'int', write: true, common: { role: 'level', min: 0, max: 10 } },
    {
        code: 'VOF',
        id: 'settings.fixedVolume',
        kind: 'int',
        write: true,
        common: { role: 'level.volume', min: 0, max: 100 },
    },
    { code: 'SOP', id: 'settings.standbyOnPower', kind: 'bool', write: true, common: { role: 'switch' } },

    { code: 'IPA', id: 'info.ip', kind: 'text', write: false, common: { role: 'info.ip' } },
    { code: 'ETH', id: 'info.ethernet', kind: 'bool', write: false, common: { role: 'indicator.connected' } },
    { code: 'WIF', id: 'info.wifi', kind: 'bool', write: false, common: { role: 'indicator.connected' } },
    { code: 'CHN', id: 'info.multiroomChannel', kind: 'text', write: false, common: { role: 'text' } },
    { code: 'MRM', id: 'info.multiroomMode', kind: 'text', write: false, common: { role: 'text' } },
    { code: 'VER', id: 'info.mcuVersion', kind: 'text', write: false, once: true, common: { role: 'info.firmware' } },

    // ⚠️ Nothing over the network wakes the LA50 up again (no web UI, no command) — only the IR remote.
    { code: 'SYS', id: 'standby', kind: 'button', value: 'STANDBY', write: true, common: { role: 'button' } },
];

/** Channels below the device, by the first segment of a field id. */
const CHANNELS = { sound: 'Sound', settings: 'Settings', info: 'Information' };

const BY_CODE = new Map(FIELDS.filter(f => f.kind !== 'button').map(f => [f.code, f]));
const BY_ID = new Map(FIELDS.map(f => [f.id, f]));

/**
 * Splits one message such as `VOL:30` into its field and parsed value.
 *
 * @param {string} message one message without the trailing `;`
 * @returns {{ code: string, field?: object, value?: ioBroker.StateValue } | null} null if it is no `CODE:value` message
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
 * @param {ioBroker.StateValue} val value written by the user
 * @returns {string | null} null for a button that was not pressed
 */
function commandFor(field, val) {
    if (field.kind === 'button') {
        if (!val) {
            return null;
        }
        return field.value ? `${field.code}:${field.value}` : field.code;
    }
    return `${field.code}:${KINDS[field.kind].format(val)}`;
}

/**
 * Turns a list answer into choices for a state: `NET,BT` → { NET: 'NET', BT: 'BT' },
 * `0@Flat,1@Pop` → { 0: 'Flat', 1: 'Pop' }.
 *
 * @param {string} list value of a list field such as LST or PEQ
 * @returns {Record<string, string>} common.states
 */
function statesFromList(list) {
    const states = {};
    for (const item of String(list).split(',')) {
        const [key, label] = item.split('@');
        if (key) {
            states[key] = label === undefined ? key : label;
        }
    }
    return states;
}

module.exports = { KINDS, FIELDS, CHANNELS, BY_CODE, BY_ID, parseMessage, commandFor, statesFromList };
