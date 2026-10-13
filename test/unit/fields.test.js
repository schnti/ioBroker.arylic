'use strict';

const assert = require('node:assert');
const { BY_ID, parseMessage, commandFor, statesFromList } = require('../../lib/fields');

describe('fields', () => {
    it('parses numbers, booleans and text', () => {
        assert.deepStrictEqual(parseMessage('VOL:53').value, 53);
        assert.deepStrictEqual(parseMessage('MUT:0').value, false);
        assert.deepStrictEqual(parseMessage('LED:1').value, true);
        assert.deepStrictEqual(parseMessage('LST:NET,BT,LINE-IN').value, 'NET,BT,LINE-IN');
        assert.deepStrictEqual(parseMessage('BAS:-3').value, -3);
        assert.deepStrictEqual(parseMessage('ETH:1').field.id, 'info.ethernet');
    });

    it('decodes the hex device name', () => {
        assert.strictEqual(parseMessage('NAM:4B7565636865').value, 'Kueche');
        assert.strictEqual(parseMessage('NAM:4BC3BC636865').value, 'Küche');
    });

    it('keeps text after the first colon', () => {
        assert.strictEqual(parseMessage('IPA:10.0.0.61').value, '10.0.0.61');
    });

    it('returns the code of unknown messages without a field', () => {
        assert.deepStrictEqual(parseMessage('NET:1'), { code: 'NET' });
        assert.strictEqual(parseMessage('garbage'), null);
    });

    it('builds write commands', () => {
        assert.strictEqual(commandFor(BY_ID.get('maxVolume'), 50), 'MXV:50');
        assert.strictEqual(commandFor(BY_ID.get('volume'), '30.6'), 'VOL:31');
        assert.strictEqual(commandFor(BY_ID.get('mute'), true), 'MUT:1');
        assert.strictEqual(commandFor(BY_ID.get('settings.name'), 'Backyard'), 'NAM:4261636B79617264');
    });

    it('sends plain buttons without a value', () => {
        assert.strictEqual(commandFor(BY_ID.get('next'), true), 'NXT');
        assert.strictEqual(commandFor(BY_ID.get('playPause'), true), 'POP');
    });

    it('turns list answers into state choices', () => {
        assert.deepStrictEqual(statesFromList('NET,BT,LINE-IN'), { NET: 'NET', BT: 'BT', 'LINE-IN': 'LINE-IN' });
        assert.deepStrictEqual(statesFromList('0@Flat,1@Classical'), { 0: 'Flat', 1: 'Classical' });
    });

    it('has no unknown WWW field', () => {
        assert.deepStrictEqual(parseMessage('WWW:0'), { code: 'WWW' });
    });

    it('sends standby only when the button is pressed', () => {
        assert.strictEqual(commandFor(BY_ID.get('standby'), true), 'SYS:STANDBY');
        assert.strictEqual(commandFor(BY_ID.get('standby'), false), null);
    });
});
