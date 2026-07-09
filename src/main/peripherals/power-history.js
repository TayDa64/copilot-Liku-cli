/**
 * Power Telemetry History — rolling per-device power log + trending (Phase 12).
 *
 * Persists timestamped power snapshots under ~/.liku/power-history.jsonl so the
 * PAL can answer "what has our power draw looked like over time?" — current vs.
 * historical, peaks, and per-device trends.
 *
 * DISCIPLINE (mirrors supervisor-task-store / notification-channels):
 *   - FEATURE-FLAG GATED: only touches disk when LIKU_ENABLE_PERIPHERALS=1.
 *     When off, record() is a no-op and query()/summary() return empty.
 *   - BOUNDED: the JSONL file is capped (MAX_SAMPLES) and rewritten atomically
 *     under the shared advisory lock, so it can never grow without limit and a
 *     reader never observes a torn file.
 *   - PURE OBSERVATION: recording power history NEVER actuates anything.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { LIKU_HOME } = require('../../shared/liku-home');
const { atomicWriteFileSync } = require('../../shared/atomic-file');

const FLAG = 'LIKU_ENABLE_PERIPHERALS';
const HISTORY_FILE = path.join(LIKU_HOME, 'power-history.jsonl');
const MAX_SAMPLES = 1000; // rolling window (oldest dropped)

function enabled() {
  return String(process.env[FLAG] || '').trim() === '1';
}

/** Read all persisted samples (newest last). Corruption-tolerant. @private */
function _readSamples() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    return fs.readFileSync(HISTORY_FILE, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((s) => s && typeof s === 'object');
  } catch {
    return [];
  }
}

/** Coerce a snapshot into a compact, JSON-safe record. @private */
function _sanitize(snapshot) {
  const s = snapshot || {};
  const devices = Array.isArray(s.devices) ? s.devices.slice(0, 64).map((d) => ({
    id: String(d.id || '?').slice(0, 80),
    loadW: Number.isFinite(Number(d.loadW)) ? Number(d.loadW) : 0,
    active: !!d.active
  })) : [];
  return {
    at: typeof s.at === 'string' ? s.at : new Date().toISOString(),
    totalW: Number.isFinite(Number(s.totalW)) ? Number(s.totalW) : 0,
    budgetW: Number.isFinite(Number(s.budgetW)) ? Number(s.budgetW) : null,
    overBudget: !!s.overBudget,
    devices
  };
}

/**
 * Append a power snapshot to the rolling history (atomic + locked). No-op when
 * the feature flag is off. Returns the record written (or null).
 * @param {{at?:string,totalW:number,budgetW?:number,overBudget?:boolean,devices?:object[]}} snapshot
 */
function record(snapshot) {
  if (!enabled()) return null;
  try {
    const rec = _sanitize(snapshot);
    let samples = _readSamples();
    samples.push(rec);
    if (samples.length > MAX_SAMPLES) samples = samples.slice(-MAX_SAMPLES);
    if (!fs.existsSync(LIKU_HOME)) fs.mkdirSync(LIKU_HOME, { recursive: true, mode: 0o700 });
    atomicWriteFileSync(HISTORY_FILE, samples.map((s) => JSON.stringify(s)).join('\n') + '\n', { mode: 0o600 });
    return rec;
  } catch (err) {
    console.warn('[PowerHistory] Failed to record (non-fatal):', err.message);
    return null;
  }
}

/**
 * Query recent samples, optionally within a time window and/or limited count.
 * @param {{ sinceMs?:number, limit?:number }} [opts]
 * @returns {object[]} newest last
 */
function query(opts = {}) {
  if (!enabled()) return [];
  let samples = _readSamples();
  if (Number.isFinite(opts.sinceMs)) {
    const cutoff = Date.now() - opts.sinceMs;
    samples = samples.filter((s) => { const t = Date.parse(s.at); return Number.isFinite(t) && t >= cutoff; });
  }
  if (Number.isFinite(opts.limit) && opts.limit > 0) samples = samples.slice(-opts.limit);
  return samples;
}

/**
 * Compute a trend summary over the retained window: peak / average / latest
 * total watts, sample count, and per-device peak draw.
 * @param {{ sinceMs?:number }} [opts]
 * @returns {{ count:number, peakW:number, avgW:number, currentW:number, budgetW:(number|null), perDevicePeakW:object }}
 */
function summary(opts = {}) {
  const samples = query({ sinceMs: opts.sinceMs });
  if (!samples.length) return { count: 0, peakW: 0, avgW: 0, currentW: 0, budgetW: null, perDevicePeakW: {} };
  let peakW = 0;
  let sum = 0;
  const perDevicePeakW = {};
  for (const s of samples) {
    const total = Number(s.totalW) || 0;
    peakW = Math.max(peakW, total);
    sum += total;
    for (const d of s.devices || []) {
      const w = Number(d.loadW) || 0;
      if (!(d.id in perDevicePeakW) || w > perDevicePeakW[d.id]) perDevicePeakW[d.id] = w;
    }
  }
  const last = samples[samples.length - 1];
  return {
    count: samples.length,
    peakW: Math.round(peakW * 100) / 100,
    avgW: Math.round((sum / samples.length) * 100) / 100,
    currentW: Number(last.totalW) || 0,
    budgetW: last.budgetW != null ? Number(last.budgetW) : null,
    perDevicePeakW
  };
}

/** Remove the history file (governance/tests). No-op when disabled. */
function clear() {
  if (!enabled()) return false;
  try { if (fs.existsSync(HISTORY_FILE)) fs.rmSync(HISTORY_FILE); return true; }
  catch { return false; }
}

module.exports = { FLAG, HISTORY_FILE, MAX_SAMPLES, enabled, record, query, summary, clear };
