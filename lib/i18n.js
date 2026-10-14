'use strict';

// The languages beyond English and German, keyed by the English text. English
// and German stay next to the code that uses them.
const MORE = require('./i18n.json');

/**
 * @param {{ en: string, de: string }} text text in English and German
 * @returns {ioBroker.Translated} the text in all languages of ioBroker
 */
function translate(text) {
    return { ...text, ...MORE[text.en] };
}

module.exports = { translate, MORE };
