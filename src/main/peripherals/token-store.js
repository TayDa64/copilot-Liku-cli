/**
 * Peripheral Token Lifecycle Store — capability tokens bound to the device
 * pairing lifecycle (Pillar 3, Phase 18).
 *
 * Capability tokens (dcp-protocol.js) are stateless HMAC artifacts, so on their
 * own they cannot be revoked. This store adds the missing lifecycle state:
 *
 *   - ISSUE on successful pairing (generation 1).
 *   - ROTATE on re-pair or explicit rotation (generation++ — stale tokens with a
 *     lower generation no longer verify).
 *   - REVOKE on unpair or explicit revocation (marked revoked + generation++ so
 *     any outstanding token is invalidated).
 *   - Per-device signed IDENTITY fingerprint (stable HMAC over the deviceId),
 *     bound into every issued token so a token minted for one device identity is
 *     rejected for another.
 *
 * DISCIPLINE (mirrors supervisor-task-store / power-history):
 *   - FEATURE-FLAG GATED (LIKU_ENABLE_PERIPHERALS=1) — no disk touched otherwise.
 *   - Atomic + locked writes, corruption-tolerant reads (never throws).
 *   - PURE lifecycle bookkeeping — it NEVER actuates a device and NEVER bypasses
 *     the PAL safety chain. Revocation only makes remote drivers refuse to send.
 *   - Unsigned/local mode still works: identity falls back to a local fingerprint
 *     so lifecycle state is meaningful even without LIKU_DCP_SECRET.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LIKU_HOME } = require('../../shared/liku-home');
const { atomicWriteFileSync } = require('../../shared/atomic-file');
const dcp = require('./dcp-protocol');

const FLAG = 'LIKU_ENABLE_PERIPHERALS';
const STORE_FILE = path.join(LIKU_HOME, 'peripheral-tokens.json');
const SCHEMA_VERSION = '1.0.0';

function enabled() {
  return String(process.env[FLAG] || '').trim() === '1';
}

/** Stable per-device identity fingerprint (works signed OR unsigned/local). */
function identity(deviceId) {
  const secret = process.env.LIKU_DCP_SECRET || 'liku-local-identity';
  return crypto.createHmac('sha256', secret).update(`identity:${deviceId}`).digest('hex').slice(0, 16);
}

function _load() {
  const empty = { schemaVersion: SCHEMA_VERSION, devices: {} };
  if (!enabled()) return empty;
  try {
    if (!fs.existsSync(STORE_FILE)) return empty;
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
    if (!raw || typeof raw !== 'object' || typeof raw.devices !== 'object') return empty;
    return { schemaVersion: raw.schemaVersion || SCHEMA_VERSION, devices: raw.devices || {} };
  } catch (err) {
    console.warn('[TokenStore] load failed (non-fatal):', err.message);
    return empty;
  }
}

function _save(state) {
  if (!enabled()) return false;
  try {
    if (!fs.existsSync(LIKU_HOME)) fs.mkdirSync(LIKU_HOME, { recursive: true, mode: 0o700 });
    atomicWriteFileSync(STORE_FILE, JSON.stringify({
      schemaVersion: SCHEMA_VERSION, updatedAt: new Date().toISOString(), devices: state.devices
    }, null, 2), { mode: 0o600 });
    return true;
  } catch (err) {
    console.warn('[TokenStore] save failed (non-fatal):', err.message);
    return false;
  }
}

function _rec(state, id) {
  if (!state.devices[id]) {
    state.devices[id] = { gen: 0, tokenId: null, issuedAt: null, rotatedAt: null, revoked: false, revokedAt: null, actions: [], identityFp: identity(id) };
  }
  return state.devices[id];
}

function _newTokenId() { return crypto.randomBytes(6).toString('hex'); }

/**
 * Issue a token on pairing. Idempotent while active (returns the existing
 * generation); a first pair or a re-pair after revoke mints a fresh generation.
 * @param {string} deviceId
 * @param {{ actions?:string[] }} [opts]
 */
function onPair(deviceId, opts = {}) {
  if (!enabled()) return null;
  const st = _load();
  const r = _rec(st, deviceId);
  if (r.gen === 0 || r.revoked) {
    r.gen += 1;
    r.revoked = false;
    r.revokedAt = null;
    r.tokenId = _newTokenId();
    r.issuedAt = new Date().toISOString();
    r.rotatedAt = r.issuedAt;
    r.identityFp = identity(deviceId);
    if (Array.isArray(opts.actions)) r.actions = opts.actions.map((a) => String(a).toLowerCase());
    _save(st);
  }
  return { ...r };
}

/** Rotate a device's token generation (invalidates outstanding tokens). */
function rotate(deviceId, opts = {}) {
  if (!enabled()) return null;
  const st = _load();
  const r = _rec(st, deviceId);
  r.gen += 1;
  r.revoked = false;
  r.revokedAt = null;
  r.tokenId = _newTokenId();
  r.rotatedAt = new Date().toISOString();
  if (!r.issuedAt) r.issuedAt = r.rotatedAt;
  if (Array.isArray(opts.actions)) r.actions = opts.actions.map((a) => String(a).toLowerCase());
  _save(st);
  return { ...r };
}

/** Revoke a device's token (unpair or explicit). Bumps generation. */
function revoke(deviceId) {
  if (!enabled()) return null;
  const st = _load();
  const r = _rec(st, deviceId);
  r.revoked = true;
  r.revokedAt = new Date().toISOString();
  r.gen += 1;
  _save(st);
  return { ...r };
}

function isRevoked(deviceId) {
  if (!enabled()) return false;
  const d = _load().devices[deviceId];
  return !!(d && d.revoked);
}

function isActive(deviceId) {
  if (!enabled()) return false;
  const d = _load().devices[deviceId];
  return !!(d && !d.revoked && d.gen > 0);
}

/** Current lifecycle record for a device (or null). */
function status(deviceId) {
  const d = _load().devices[deviceId];
  return d ? { ...d } : null;
}

/** All device lifecycle records. */
function all() {
  const st = _load();
  const out = {};
  for (const [k, v] of Object.entries(st.devices)) out[k] = { ...v };
  return out;
}

/**
 * Mint a DCP capability token for the device's CURRENT generation + identity.
 * A stale token (older gen) will fail `verifyCapabilityToken({ gen })`.
 * @param {string} deviceId
 * @param {{ actions?:string[], ttlSec?:number }} [opts]
 */
function issueToken(deviceId, opts = {}) {
  const st = _load();
  const r = _rec(st, deviceId);
  return dcp.issueCapabilityToken({
    deviceId,
    actions: opts.actions || r.actions,
    ttlSec: opts.ttlSec,
    gen: r.gen > 0 ? r.gen : undefined,
    identity: r.identityFp
  });
}

/** Remove the store (governance/tests). No-op when disabled. */
function clear() {
  if (!enabled()) return false;
  try { if (fs.existsSync(STORE_FILE)) fs.rmSync(STORE_FILE); return true; }
  catch { return false; }
}

module.exports = {
  FLAG, STORE_FILE, SCHEMA_VERSION,
  enabled, identity,
  onPair, rotate, revoke,
  isRevoked, isActive, status, all, issueToken, clear
};
