'use strict';

/**
 * Commands of the Arylic UART API (https://developer.arylic.com/uartapi/).
 * `CODE;` reads, `CODE:value;` sets, the device answers `CODE:value;` and also
 * pushes changes on its own.
 */

/**
 * Reads a written value as a boolean. Scripts and other adapters often write
 * strings or numbers, and `Boolean('false')` would be true.
 *
 * @param {ioBroker.StateValue} val written value
 * @returns {boolean} the value as boolean
 */
function toBool(val) {
    if (val === true || val === 1 || val === '1' || String(val).toLowerCase() === 'true') {
        return true;
    }
    if (val === false || val === 0 || val === '0' || String(val).toLowerCase() === 'false') {
        return false;
    }
    throw new RangeError(`not a boolean: ${JSON.stringify(val)}`);
}

/**
 * @param {ioBroker.StateValue} val written value
 * @returns {string} the value as text, without characters that end or split a command
 */
function toText(val) {
    if (val === null || val === undefined) {
        throw new RangeError('empty value');
    }
    const text = String(val);
    if (/[;\r\n]/.test(text)) {
        throw new RangeError(`must not contain ";" or line breaks: ${JSON.stringify(text)}`);
    }
    return text;
}

// How a value is read from and written to the device, per kind. parse returns
// undefined for an answer it cannot read; format throws a RangeError for a value
// that must not be sent.
const KINDS = {
    int: {
        type: 'number',
        def: 0,
        parse: raw => (/^-?\d+$/.test(raw) ? parseInt(raw, 10) : undefined),
        format: (val, common) => {
            const num = typeof val === 'string' && val.trim() === '' ? NaN : Number(val);
            if (val === null || typeof val === 'boolean' || !Number.isFinite(num)) {
                throw new RangeError(`not a number: ${JSON.stringify(val)}`);
            }
            const min = common.min ?? -Infinity;
            const max = common.max ?? Infinity;
            return String(Math.min(max, Math.max(min, Math.round(num))));
        },
    },
    bool: {
        type: 'boolean',
        def: false,
        parse: raw => (raw === '1' ? true : raw === '0' ? false : undefined),
        format: val => (toBool(val) ? '1' : '0'),
    },
    text: {
        type: 'string',
        def: '',
        parse: raw => raw,
        format: toText,
    },
    // UTF-8 text sent as hex digits, e.g. the device name.
    hex: {
        type: 'string',
        def: '',
        parse: raw => (/^([0-9a-f]{2})*$/i.test(raw) ? Buffer.from(raw, 'hex').toString('utf8') : undefined),
        format: val => Buffer.from(toText(val), 'utf8').toString('hex').toUpperCase(),
    },
    // Never read; a write sends `CODE` or `CODE:value` and springs back.
    button: {
        type: 'boolean',
        def: false,
    },
};

const TONE = { role: 'level', min: -10, max: 10, unit: 'dB' };
const SWITCH = { role: 'switch' };
const TEXT = { role: 'text' };

// id: state below the device. once: read on connect only, the value does not
// change at runtime. statesOf: the value is the list of choices for that field.
// prettier-ignore
const FIELDS = [
    { code: 'VOL', id: 'volume', name: { en: 'Volume', de: 'Lautstärke' }, kind: 'int', write: true, common: { role: 'level.volume', min: 0, max: 100 } },
    { code: 'MXV', id: 'maxVolume', name: { en: 'Maximum volume', de: 'Höchstlautstärke' }, kind: 'int', write: true, common: { role: 'level.volume.max', min: 30, max: 100 } },
    { code: 'MUT', id: 'mute', name: { en: 'Mute', de: 'Stumm' }, kind: 'bool', write: true, common: { role: 'media.mute' } },
    { code: 'SRC', id: 'source', name: { en: 'Input', de: 'Eingang' }, kind: 'text', write: true, common: { role: 'media.input' } },
    { code: 'LST', id: 'sources', name: { en: 'Available inputs', de: 'Verfügbare Eingänge' }, kind: 'text', write: false, once: true, statesOf: 'source', common: TEXT },
    { code: 'PLA', id: 'playing', name: { en: 'Playing', de: 'Wiedergabe läuft' }, kind: 'bool', write: false, common: { role: 'media.state' } },
    { code: 'POP', id: 'playPause', name: { en: 'Play/pause', de: 'Wiedergabe/Pause' }, kind: 'button', write: true, common: { role: 'button' } },
    { code: 'STP', id: 'stop', name: { en: 'Stop', de: 'Stopp' }, kind: 'button', write: true, common: { role: 'button.stop' } },
    { code: 'NXT', id: 'next', name: { en: 'Next track', de: 'Nächster Titel' }, kind: 'button', write: true, common: { role: 'button.next' } },
    { code: 'PRE', id: 'previous', name: { en: 'Previous track', de: 'Vorheriger Titel' }, kind: 'button', write: true, common: { role: 'button.prev' } },

    { code: 'BAS', id: 'sound.bass', name: { en: 'Bass', de: 'Bass' }, kind: 'int', write: true, common: TONE },
    { code: 'MID', id: 'sound.mid', name: { en: 'Mid', de: 'Mitten' }, kind: 'int', write: true, common: TONE },
    { code: 'TRE', id: 'sound.treble', name: { en: 'Treble', de: 'Höhen' }, kind: 'int', write: true, common: TONE },
    { code: 'BAL', id: 'sound.balance', name: { en: 'Balance', de: 'Balance' }, kind: 'int', write: true, common: { role: 'level', min: -100, max: 100 } },
    { code: 'VBS', id: 'sound.virtualBass', name: { en: 'Virtual bass', de: 'Virtueller Bass' }, kind: 'bool', write: true, common: SWITCH },
    { code: 'EQE', id: 'sound.eqEnabled', name: { en: 'Equalizer on', de: 'Equalizer an' }, kind: 'bool', write: true, common: SWITCH },
    { code: 'EQS', id: 'sound.eqPreset', name: { en: 'Equalizer preset', de: 'Equalizer-Voreinstellung' }, kind: 'int', write: true, common: { role: 'level' } },
    { code: 'PEQ', id: 'sound.eqPresets', name: { en: 'Available equalizer presets', de: 'Verfügbare Equalizer-Voreinstellungen' }, kind: 'text', write: false, once: true, statesOf: 'sound.eqPreset', common: TEXT },
    { code: 'CFE', id: 'sound.crossover', name: { en: 'Crossover on', de: 'Frequenzweiche an' }, kind: 'bool', write: true, common: SWITCH },
    { code: 'CFF', id: 'sound.crossoverFrequency', name: { en: 'Crossover frequency', de: 'Übergangsfrequenz' }, kind: 'int', write: true, common: { role: 'level', min: 50, max: 300, unit: 'Hz' } },

    { code: 'LED', id: 'settings.led', name: { en: 'LED', de: 'LED' }, kind: 'bool', write: true, common: SWITCH },
    { code: 'BEP', id: 'settings.beep', name: { en: 'Confirmation tone', de: 'Bestätigungston' }, kind: 'bool', write: true, common: SWITCH },
    { code: 'NAM', id: 'settings.name', name: { en: 'Device name', de: 'Gerätename' }, kind: 'hex', write: true, common: { role: 'info.name' } },
    { code: 'DLY', id: 'settings.muteDelay', name: { en: 'Mute after silence', de: 'Stumm nach Stille' }, kind: 'int', write: true, common: { role: 'level', min: 0, max: 32767, unit: 's' } },
    { code: 'POM', id: 'settings.powerOnSource', name: { en: 'Input after power-on', de: 'Eingang nach dem Einschalten' }, kind: 'text', write: true, common: TEXT },
    { code: 'ASW', id: 'settings.autoSwitch', name: { en: 'Switch back to previous input', de: 'Zurück zum vorherigen Eingang' }, kind: 'bool', write: true, common: SWITCH },
    { code: 'VST', id: 'settings.volumeStep', name: { en: 'Volume step', de: 'Lautstärke-Schrittweite' }, kind: 'int', write: true, common: { role: 'level', min: 0, max: 10 } },
    { code: 'VOF', id: 'settings.fixedVolume', name: { en: 'Fixed output level', de: 'Fester Ausgangspegel' }, kind: 'int', write: true, common: { role: 'level.volume', min: 0, max: 100 } },
    { code: 'SOP', id: 'settings.standbyOnPower', name: { en: 'Start in standby', de: 'Im Standby starten' }, kind: 'bool', write: true, common: SWITCH },

    { code: 'IPA', id: 'info.ip', name: { en: 'IP address', de: 'IP-Adresse' }, kind: 'text', write: false, common: { role: 'info.ip' } },
    { code: 'ETH', id: 'info.ethernet', name: { en: 'Ethernet connected', de: 'LAN verbunden' }, kind: 'bool', write: false, common: { role: 'indicator.connected' } },
    { code: 'WIF', id: 'info.wifi', name: { en: 'Wi-Fi connected', de: 'WLAN verbunden' }, kind: 'bool', write: false, common: { role: 'indicator.connected' } },
    { code: 'CHN', id: 'info.multiroomChannel', name: { en: 'Multiroom channel', de: 'Multiroom-Kanal' }, kind: 'text', write: false, common: TEXT },
    { code: 'MRM', id: 'info.multiroomMode', name: { en: 'Multiroom mode', de: 'Multiroom-Modus' }, kind: 'text', write: false, common: TEXT },
    { code: 'VER', id: 'info.mcuVersion', name: { en: 'Amplifier chip firmware', de: 'Firmware Verstärker-Chip' }, kind: 'text', write: false, once: true, common: { role: 'info.firmware' } },

    // ⚠️ Nothing over the network wakes the LA50 up again (no web UI, no command) — only the IR remote.
    { code: 'SYS', id: 'standby', name: { en: 'Standby', de: 'Standby' }, kind: 'button', value: 'STANDBY', write: true, common: { role: 'button' } },
];

// States that do not come from a UART command: the connection, and what the device
// announces via mDNS.
// prettier-ignore
const EXTRA = [
    { id: 'info.connected', name: { en: 'Connected', de: 'Verbunden' }, kind: 'bool', common: { role: 'indicator.reachable' } },
    { id: 'info.model', name: { en: 'Model', de: 'Modell' }, kind: 'text', common: TEXT },
    { id: 'info.serial', name: { en: 'Serial number', de: 'Seriennummer' }, kind: 'text', common: TEXT },
    { id: 'info.firmware', name: { en: 'Firmware', de: 'Firmware' }, kind: 'text', common: { role: 'info.firmware' } },
];

/** Every state below a device; anything else there is a leftover of an older version. */
const STATES = [...FIELDS, ...EXTRA];

const CHANNEL_NAMES = {
    sound: { en: 'Sound', de: 'Klang' },
    settings: { en: 'Settings', de: 'Einstellungen' },
    info: { en: 'Information', de: 'Information' },
};
/** Channels below the device: the first segment of every dotted state id. */
const CHANNELS = [...new Set(STATES.filter(f => f.id.includes('.')).map(f => f.id.split('.')[0]))];

/** Fields the device answers on a read; buttons are only ever sent. */
const READABLE = FIELDS.filter(f => f.kind !== 'button');

const BY_CODE = new Map(READABLE.map(f => [f.code, f]));
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
    const value = KINDS[field.kind].parse(message.slice(sep + 1));
    return value === undefined ? { code } : { code, field, value };
}

/**
 * Builds the command text for a write to a field, without the trailing `;`.
 *
 * @param {object} field entry of FIELDS
 * @param {ioBroker.StateValue} val value written by the user
 * @returns {string | null} null for a button that was released
 * @throws {RangeError} for a value that must not be sent
 */
function commandFor(field, val) {
    if (field.kind === 'button') {
        if (!toBool(val)) {
            return null;
        }
        return field.value ? `${field.code}:${field.value}` : field.code;
    }
    return `${field.code}:${KINDS[field.kind].format(val, field.common)}`;
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

module.exports = {
    KINDS,
    FIELDS,
    STATES,
    CHANNELS,
    CHANNEL_NAMES,
    READABLE,
    BY_CODE,
    BY_ID,
    parseMessage,
    commandFor,
    statesFromList,
};
