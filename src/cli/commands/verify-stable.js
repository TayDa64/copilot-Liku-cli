/**
 * verify-stable command - Wait until the visual output is stable for a dynamic number of polls
 * @module cli/commands/verify-stable
 */

const path = require('path');
const { success, error, info } = require('../util/output');

const UI_MODULE = path.resolve(__dirname, '../../main/ui-automation');
let ui;

function loadUI() {
  if (!ui) ui = require(UI_MODULE);
  return ui;
}

function parseNumber(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function hamming64Hex(a, b) {
  if (!a || !b || String(a).length !== 16 || String(b).length !== 16) return null;
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let count = 0;
  while (x) {
    x &= (x - 1n);
    count++;
  }
  return count;
}

async function run(args, options) {
  loadUI();

  const metric = String(options.metric || 'dhash').toLowerCase();
  const timeoutMs = clamp(parseNumber(options.timeout, 10000), 0, 60000);
  const intervalMs = clamp(parseNumber(options.interval, 250), 50, 5000);
  const stableMs = clamp(parseNumber(options['stable-ms'], options.stableMs ?? 750), 0, 60000);

  const defaultEpsilon = metric === 'dhash' ? 4 : 0;
  const epsilon = clamp(parseNumber(options.epsilon, defaultEpsilon), 0, 64);

  const requireChange = options['require-change'] === true || options.requireChange === true;

  const requiredSamples = Math.max(1, Math.ceil(stableMs / intervalMs));
  const startedAt = Date.now();

  function pickValue(sample) {
    if (!sample?.success) return { ok: false, error: sample?.error || 'capture failed' };
    if (metric === 'dhash') {
      return sample.dhash ? { ok: true, value: sample.dhash } : { ok: false, error: 'dhash missing' };
    }
    // default sha256 of bytes
    return sample.hash ? { ok: true, value: sample.hash } : { ok: false, error: 'hash missing' };
  }

  function distance(prev, curr) {
    if (metric === 'dhash') {
      return hamming64Hex(prev, curr);
    }
    // sha256 exact match only
    return prev === curr ? 0 : 9999;
  }

  async function capture() {
    // For stability polling we only need the metric; suppress base64 to reduce overhead.
    const res = await ui.screenshot({ memory: true, base64: false, metric });
    return res;
  }

  if (!options.quiet && !options.json) {
    info(`Waiting for stability: metric=${metric} epsilon<=${epsilon} stableMs=${stableMs} intervalMs=${intervalMs} (N=${requiredSamples})`);
  }

  const first = await capture();
  const firstPicked = pickValue(first);
  if (!firstPicked.ok) {
    if (!options.json) error(firstPicked.error);
    return { success: false, error: firstPicked.error };
  }

  let lastValue = firstPicked.value;
  let firstValue = firstPicked.value;
  let samples = 1;
  let stableCount = 1; // first sample counts toward stability window
  let sawChange = false;

  while (true) {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > timeoutMs) {
      const payload = {
        success: false,
        stable: false,
        metric,
        epsilon,
        requireChange,
        sawChange,
        stableMs,
        intervalMs,
        requiredSamples,
        samples,
        stableCount,
        firstValue,
        lastValue,
        elapsedMs,
        timeoutMs,
      };
      if (!options.json) error('Timed out waiting for stability');
      return payload;
    }

    if (!requireChange || sawChange) {
      if (stableCount >= requiredSamples) {
        const elapsedMs2 = Date.now() - startedAt;
        if (!options.quiet && !options.json) success('Visual output is stable');
        return {
          success: true,
          stable: true,
          metric,
          epsilon,
          requireChange,
          sawChange,
          stableMs,
          intervalMs,
          requiredSamples,
          samples,
          stableCount,
          firstValue,
          lastValue,
          elapsedMs: elapsedMs2,
          timeoutMs,
        };
      }
    }

    await new Promise(r => setTimeout(r, intervalMs));

    const next = await capture();
    const picked = pickValue(next);
    if (!picked.ok) {
      if (!options.json) error(picked.error);
      return { success: false, error: picked.error, metric, samples, elapsedMs };
    }

    samples++;
    const currValue = picked.value;
    const d = distance(lastValue, currValue);

    if (d === null) {
      if (!options.json) error('distance computation failed');
      return { success: false, error: 'distance computation failed', metric, samples, elapsedMs };
    }

    if (d > epsilon) {
      sawChange = true;
      stableCount = 1; // restart window on change (current sample counts as start)
    } else {
      stableCount++;
    }

    lastValue = currValue;
  }
}

module.exports = { run };
