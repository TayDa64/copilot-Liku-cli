/**
 * Token Counter — accurate BPE tokenization via js-tiktoken
 *
 * Uses cl100k_base encoding (standard for GPT-4o / o1 family).
 * Pure JavaScript — no native bindings, safe for Electron + CLI.
 */

const { getEncoding } = require('js-tiktoken');

let _enc;

function getEncoder() {
  if (!_enc) {
    _enc = getEncoding('cl100k_base');
  }
  return _enc;
}

/**
 * Count tokens in a string using BPE tokenization.
 * @param {string} text
 * @returns {number}
 */
function countTokens(text) {
  if (!text) return 0;
  return getEncoder().encode(text).length;
}

/**
 * Truncate text to fit within a token budget.
 * Returns the largest prefix that stays within the budget.
 * @param {string} text
 * @param {number} maxTokens
 * @returns {string}
 */
function truncateToTokenBudget(text, maxTokens) {
  if (!text) return '';
  const enc = getEncoder();
  const tokens = enc.encode(text);
  if (tokens.length <= maxTokens) return text;
  const truncated = tokens.slice(0, maxTokens);
  return enc.decode(truncated);
}

module.exports = { countTokens, truncateToTokenBudget };
