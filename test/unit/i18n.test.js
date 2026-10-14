'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { translate, MORE } = require('../../lib/i18n');

const LANGUAGES = ['ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];

/** Every `{ en: '…', de: '…' }` in the adapter's code. */
function textsInCode() {
    const dir = path.join(__dirname, '../../lib');
    const texts = new Set();
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
        const source = fs.readFileSync(path.join(dir, file), 'utf8');
        for (const match of source.matchAll(/\{ en: '([^']*)', de: '[^']*' \}/g)) {
            texts.add(match[1]);
        }
    }
    return texts;
}

describe('i18n', () => {
    it('has every language for every text in the code', () => {
        for (const en of textsInCode()) {
            const missing = LANGUAGES.filter(lang => !(MORE[en] && MORE[en][lang]));
            assert.deepStrictEqual(missing, [], `"${en}" lacks ${missing.join(', ')}`);
        }
    });

    it('has no translations for texts the code no longer uses', () => {
        const used = textsInCode();
        assert.deepStrictEqual(
            Object.keys(MORE).filter(en => !used.has(en)),
            [],
        );
    });

    it('keeps English and German from the code', () => {
        const name = translate({ en: 'Volume', de: 'Lautstärke' });
        assert.strictEqual(name.en, 'Volume');
        assert.strictEqual(name.de, 'Lautstärke');
        assert.strictEqual(name.fr, 'Volume');
    });
});
