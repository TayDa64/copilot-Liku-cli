/**
 * DCP Wire Format + Capability Tokens — Device Control Protocol (Pillar 3, Phase 8).
 *
 * Formalizes the DCP-style communication that until now was implicit in the
 * host-side validation of `peripheral-policy.js`. This module is PURE (crypto +
 * structure only) — no I/O, no feature-flag logic, no device state. It defines:
 *
 *   1. A versioned COMMAND ENVELOPE (the wire format) with a correlation id,
 *      timestamp (freshness / replay window) and a per-command nonce.
 *   2. Signed CAPABILITY TOKENS (HMAC-SHA256) that scope a token to a specific
 *      device + action set, with an expiry and a unique id — for networked /
 *      remote devices where the host cannot fully trust the transport.
 *   3. Envelope verification: structure + freshness + nonce replay + capability
 *      scope, all composable and side-effect-free (the caller owns the seen-nonce
 *      store so replay state stays explicit and testable).
 *
 * BACKWARD COMPATIBILITY: signing is OPTIONAL. When no secret is configured
 * (`LIKU_DCP_SECRET` unset and no explicit secret), tokens are emitted in an
 * explicit `unsigned` local-mode form. Local drivers (mock, and serial/MQTT on a
 * trusted link) keep working unchanged; remote deployments can require signing.
 */

'use strict';

const crypto = require('crypto');

const DCP_VERSION = '1.0';
const DEFAULT_FRESHNESS_MS = 30000;   // envelope freshness / replay window
const DEFAULT_TOKEN_TTL_SEC = 300;    // default capability token lifetime
const UNSIGNED_MARKER = 'unsigned';

function _secret(explicit) {
  const s = explicit || process.env.LIKU_DCP_SECRET || '';
  return String(s).length ? String(s) : null;
}

/** True when a signing secret is configured (explicit or LIKU_DCP_SECRET). */
function isSigningConfigured(explicitSecret) {
  return !!_secret(explicitSecret);
}

function _b64url(input) { return Buffer.from(input).toString('base64url'); }
function _fromB64url(s) { return Buffer.from(String(s), 'base64url'); }
function _randId(bytes = 8) { return crypto.randomBytes(bytes).toString('hex'); }

function _sign(payloadStr, secret) {
  return crypto.createHmac('sha256', secret).update(payloadStr).digest('base64url');
}

function _timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch { return false; }
}

/**
 * Issue a signed capability token scoping deviceId + action(s) with an expiry.
 * @param {{ deviceId:string, actions:(string|string[]), ttlSec?:number, secret?:string, now?:number }} opts
 * @returns {string} `<base64url(payload)>.<signature|unsigned>`
 */
function issueCapabilityToken(opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const ttlSec = Number.isFinite(opts.ttlSec) ? Math.max(1, opts.ttlSec) : DEFAULT_TOKEN_TTL_SEC;
  const secret = _secret(opts.secret);
  const payload = {
    v: DCP_VERSION,
    sub: String(opts.deviceId || ''),
    act: (Array.isArray(opts.actions) ? opts.actions : [opts.actions])
      .filter((a) => a != null && a !== '')
      .map((a) => String(a).toLowerCase()),
    jti: _randId(8),
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + ttlSec
  };
  const payloadStr = _b64url(JSON.stringify(payload));
  const sig = secret ? _sign(payloadStr, secret) : UNSIGNED_MARKER;
  return `${payloadStr}.${sig}`;
}

/**
 * Verify a capability token for a specific device + action.
 * @param {string} token
 * @param {{ deviceId?:string, action?:string, secret?:string, now?:number }} opts
 * @returns {{ ok:boolean, reason?:string, payload?:object }}
 */
function verifyCapabilityToken(token, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const secret = _secret(opts.secret);
  if (typeof token !== 'string' || token.indexOf('.') < 0) return { ok: false, reason: 'malformed-token' };
  const dot = token.lastIndexOf('.');
  const payloadStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let payload;
  try { payload = JSON.parse(_fromB64url(payloadStr).toString('utf8')); }
  catch { return { ok: false, reason: 'unparseable-token' }; }

  // Signature policy.
  if (secret) {
    if (sig === UNSIGNED_MARKER) return { ok: false, reason: 'unsigned-token-rejected', payload };
    if (!_timingSafeEqual(sig, _sign(payloadStr, secret))) return { ok: false, reason: 'bad-signature', payload };
  } else if (sig !== UNSIGNED_MARKER) {
    // Token claims a signature but we have no secret to verify it → cannot trust.
    return { ok: false, reason: 'no-secret-to-verify', payload };
  }

  const nowSec = Math.floor(now / 1000);
  if (Number.isFinite(payload.exp) && nowSec > payload.exp) return { ok: false, reason: 'expired', payload };
  if (opts.deviceId != null && payload.sub && payload.sub !== String(opts.deviceId)) {
    return { ok: false, reason: 'device-scope-mismatch', payload };
  }
  if (opts.action != null && Array.isArray(payload.act) && payload.act.length
      && !payload.act.includes(String(opts.action).toLowerCase())) {
    return { ok: false, reason: 'action-scope-mismatch', payload };
  }
  return { ok: true, payload };
}

/**
 * Build a versioned command envelope (the DCP wire format).
 * @param {{ device:(string|object), action:string, params?:object, token?:string, now?:number }} opts
 * @returns {object}
 */
function buildCommandEnvelope(opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const deviceId = opts.device && typeof opts.device === 'object' ? opts.device.id : opts.device;
  const env = {
    dcp: DCP_VERSION,
    type: 'command',
    id: _randId(8),
    ts: now,
    nonce: _randId(8),
    device: String(deviceId || ''),
    action: String(opts.action || '').toLowerCase(),
    params: opts.params && typeof opts.params === 'object' ? opts.params : {}
  };
  if (opts.token) env.capability = opts.token;
  return env;
}

/**
 * Structurally validate an envelope (no crypto). Rejects malformed / wrong
 * version / wrong type.
 * @param {object} env
 * @returns {{ ok:boolean, reason?:string, command?:object }}
 */
function parseCommandEnvelope(env) {
  if (!env || typeof env !== 'object') return { ok: false, reason: 'no-envelope' };
  if (env.dcp !== DCP_VERSION) return { ok: false, reason: 'unsupported-version' };
  if (env.type !== 'command') return { ok: false, reason: 'unsupported-type' };
  if (!env.device) return { ok: false, reason: 'missing-device' };
  if (!env.action) return { ok: false, reason: 'missing-action' };
  if (!env.id || !env.nonce) return { ok: false, reason: 'missing-id-or-nonce' };
  if (!Number.isFinite(Number(env.ts))) return { ok: false, reason: 'missing-ts' };
  return {
    ok: true,
    command: {
      device: String(env.device),
      action: String(env.action).toLowerCase(),
      params: (env.params && typeof env.params === 'object') ? env.params : {},
      id: env.id,
      nonce: env.nonce,
      ts: Number(env.ts),
      capability: env.capability || null
    }
  };
}

/**
 * Fully verify an inbound envelope: structure + freshness (replay window) +
 * nonce replay + capability token scope. Side-effect-free except for the caller-
 * owned `seenNonces` Map (nonce → expiry ms) used for replay protection.
 *
 * @param {object} env
 * @param {{ secret?:string, now?:number, freshnessMs?:number, seenNonces?:Map, requireCapability?:boolean }} [opts]
 * @returns {{ ok:boolean, reason?:string, command?:object }}
 */
function verifyEnvelope(env, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const freshnessMs = Number.isFinite(opts.freshnessMs) ? opts.freshnessMs : DEFAULT_FRESHNESS_MS;
  const parsed = parseCommandEnvelope(env);
  if (!parsed.ok) return parsed;
  const cmd = parsed.command;

  // Freshness / replay window.
  if (Math.abs(now - cmd.ts) > freshnessMs) return { ok: false, reason: 'stale-envelope', command: cmd };

  // Nonce replay protection (caller-owned store).
  if (opts.seenNonces instanceof Map) {
    for (const [k, exp] of opts.seenNonces) { if (exp <= now) opts.seenNonces.delete(k); }
    if (opts.seenNonces.has(cmd.nonce)) return { ok: false, reason: 'replay-detected', command: cmd };
    opts.seenNonces.set(cmd.nonce, now + freshnessMs);
  }

  // Capability scope (required for remote, or whenever a token is present).
  if (opts.requireCapability || cmd.capability) {
    if (!cmd.capability) return { ok: false, reason: 'missing-capability', command: cmd };
    const v = verifyCapabilityToken(cmd.capability, {
      deviceId: cmd.device, action: cmd.action, secret: opts.secret, now
    });
    if (!v.ok) return { ok: false, reason: `capability-${v.reason}`, command: cmd };
  }

  return { ok: true, command: cmd };
}

module.exports = {
  DCP_VERSION,
  DEFAULT_FRESHNESS_MS,
  DEFAULT_TOKEN_TTL_SEC,
  UNSIGNED_MARKER,
  isSigningConfigured,
  issueCapabilityToken,
  verifyCapabilityToken,
  buildCommandEnvelope,
  parseCommandEnvelope,
  verifyEnvelope
};
