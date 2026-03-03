/**
 * verify-hash command - Poll screenshot hash until it changes
 * @module cli/commands/verify-hash
 */

const path = require('path');
const { success, error, info } = require('../util/output');

const UI_MODULE = path.resolve(__dirname, '../../main/ui-automation');
let ui;

function loadUI() {
  if (!ui) {
    ui = require(UI_MODULE);
  }
  return ui;
}

function parseNumber(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Run the verify-hash command
 *
 * Usage:
 *   liku verify-hash --json
 *   liku verify-hash --baseline <sha256> --timeout 8000 --interval 250 --json
 *
 * Behavior:
 * - If --baseline is omitted, captures an initial baseline hash.
 * - Polls until the hash differs from baseline, or timeout elapses.
 */
async function run(args, options) {
  loadUI();

  const timeoutMs = Math.max(0, Math.min(60000, parseNumber(options.timeout, 5000)));
  const intervalMs = Math.max(50, Math.min(5000, parseNumber(options.interval, 250)));

  let baselineHash = typeof options.baseline === 'string' ? options.baseline.trim() : null;
  const startedAt = Date.now();
  let baselineCaptured = false;

  async function captureHash() {
    const res = await ui.screenshot({ memory: true });
    if (!res?.success || !res.hash) {
      return { success: false, error: res?.error || 'Failed to capture screenshot hash' };
    }
    return { success: true, hash: res.hash };
  }

  if (!options.quiet && !options.json) {
    info('Waiting for active frame hash to change...');
  }

  if (!baselineHash) {
    const first = await captureHash();
    if (!first.success) {
      if (!options.json) error(first.error);
      return { success: false, error: first.error };
    }
    baselineHash = first.hash;
    baselineCaptured = true;
  }

  let attempts = 0;
  if (baselineCaptured) attempts = 1;
  while (true) {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > timeoutMs) {
      const message = 'Timed out waiting for frame hash to change';
      if (!options.json) error(message);
      return {
        success: false,
        changed: false,
        baselineHash,
        hash: baselineHash,
        attempts,
        elapsedMs,
        timeoutMs,
      };
    }

    const cap = await captureHash();
    attempts++;
    if (!cap.success) {
      if (!options.json) error(cap.error);
      return { success: false, error: cap.error, baselineHash, attempts, elapsedMs };
    }

    if (cap.hash !== baselineHash) {
      const elapsedMs2 = Date.now() - startedAt;
      if (!options.quiet && !options.json) {
        success('Frame hash changed');
      }
      return {
        success: true,
        changed: true,
        baselineHash,
        hash: cap.hash,
        attempts,
        elapsedMs: elapsedMs2,
        timeoutMs,
        intervalMs,
      };
    }

    await new Promise(r => setTimeout(r, intervalMs));
  }
}

module.exports = { run };
