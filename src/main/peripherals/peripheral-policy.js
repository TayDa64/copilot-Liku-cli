/**
 * Peripheral Policy — Device Control Protocol (DCP) foundation (Pillar 3).
 *
 * Normalized capability/action schema + per-device policy used by the PAL to
 * perform HOST-SIDE validation ("dry-run evaluation") BEFORE any driver touches
 * hardware. Core DCP concepts implemented here:
 *
 *   - Capability scoping : an action is only valid if the device declares it.
 *   - Dry-run evaluation : evaluateCommand() validates without executing.
 *   - Host-side rejection: malformed / out-of-policy commands are rejected
 *                          before reaching a driver.
 *   - Per-device policy  : risk class, allowed actions, confirmation TTL, power.
 *
 * Pure module: no I/O, no feature-flag logic (the PAL owns the flag). Follows the
 * defensive + sanitization discipline of the cognitive substrate.
 */

'use strict';

const dcp = require('./dcp-protocol');

const VALID_CLASSES = Object.freeze(['A', 'B', 'C']);

/**
 * Class-level policy defaults.
 *   requiresConfirm    : Class A physical actions require human confirmation.
 *   confirmationTtlSec : how long a confirmed Class A authorization stays valid.
 *   maxPowerW          : per-device power ceiling for the class.
 */
const CLASS_POLICY = Object.freeze({
  A: { requiresConfirm: true, confirmationTtlSec: 120, maxPowerW: 3000 },
  B: { requiresConfirm: false, confirmationTtlSec: 0, maxPowerW: 500 },
  C: { requiresConfirm: false, confirmationTtlSec: 0, maxPowerW: 50 }
});

/** Actions that never mutate device state (always safe to evaluate). */
const READ_ONLY_ACTIONS = Object.freeze(new Set(['read', 'status', 'get']));

/** Coarse per-action power estimate (watts) for the budget skeleton. */
const ACTION_POWER_W = Object.freeze({
  lock: 6, unlock: 6, on: 10, off: 1, brightness: 10, read: 1, status: 1, get: 1
});

/** Default global power budget (watts) when guard.peripherals.max_total_power_w is unset. */
const DEFAULT_MAX_TOTAL_POWER_W = 5000;

function normalizeAction(action) {
  return String(action || '').trim().toLowerCase();
}

/**
 * Resolve the effective policy for a device (class defaults + device overrides).
 * @param {object} device
 * @returns {{class:string, requiresConfirm:boolean, confirmationTtlSec:number, maxPowerW:number, allowedActions:string[]}}
 */
function getDevicePolicy(device) {
  const cls = VALID_CLASSES.includes(device && device.class) ? device.class : 'A'; // unknown → strictest
  const base = CLASS_POLICY[cls];
  const allowed = Array.isArray(device && device.capabilities) ? device.capabilities.map(normalizeAction) : [];
  return {
    class: cls,
    requiresConfirm: base.requiresConfirm,
    confirmationTtlSec: Number.isFinite(Number(device && device.confirmationTtlSec))
      ? Number(device.confirmationTtlSec) : base.confirmationTtlSec,
    maxPowerW: Number.isFinite(Number(device && device.maxPowerW)) ? Number(device.maxPowerW) : base.maxPowerW,
    allowedActions: allowed
  };
}

/**
 * Estimate the power draw (watts) of an action on a device.
 * @param {object} device
 * @param {string} action
 * @returns {number}
 */
function estimateActionPowerW(device, action) {
  const act = normalizeAction(action);
  if (Number.isFinite(Number(device && device.powerW))) return Number(device.powerW);
  return ACTION_POWER_W[act] || 0;
}

/** True when a device's state indicates it is currently drawing power. */
function isDeviceActive(device) {
  const s = (device && device.state) || {};
  if (s.power === 'on') return true;
  if (Number.isFinite(Number(s.brightness)) && Number(s.brightness) > 0) return true;
  return false;
}

/**
 * Estimate a device's CURRENT continuous draw (watts) from its last-known state.
 * Sensors (Class C) draw a small always-on standby (their rated powerW);
 * actuators draw their rated power only while active (proportional for dimmables).
 * @param {object} device
 * @returns {number}
 */
function estimateDeviceLoadW(device) {
  const p = Number.isFinite(Number(device && device.powerW)) ? Number(device.powerW) : 0;
  if ((device && device.class) === 'C') return p; // sensors: always-on standby
  if (!isDeviceActive(device)) return 0;
  const s = (device && device.state) || {};
  if (s.power === 'on' && Number.isFinite(Number(s.brightness))) {
    return Math.max(0, Math.min(100, Number(s.brightness))) / 100 * p;
  }
  return p;
}

/**
 * Estimate a device's PROJECTED continuous draw (watts) AFTER an action. Used
 * for cumulative budgeting: 'off'→0, 'on'→rated, 'brightness'→proportional,
 * momentary/read actions leave the current draw unchanged.
 * @param {object} device
 * @param {string} action
 * @param {object} [params]
 * @returns {number}
 */
function projectedDeviceLoadW(device, action, params = {}) {
  const act = normalizeAction(action);
  const p = Number.isFinite(Number(device && device.powerW))
    ? Number(device.powerW) : (ACTION_POWER_W[act] || 0);
  if (act === 'off') return 0;
  if (act === 'on') return p;
  if (act === 'brightness') {
    const level = Number(params && params.level);
    return Number.isFinite(level) ? Math.max(0, Math.min(100, level)) / 100 * p : p;
  }
  return estimateDeviceLoadW(device);
}

/**
 * Dry-run evaluate a command against device capabilities + policy. Performs
 * host-side rejection of malformed / out-of-scope / over-budget commands. Does
 * NOT execute anything and has no side effects.
 *
 * @param {object} device registry device record
 * @param {string} action
 * @param {object} [params]
 * @param {{ maxTotalPowerW?: number }} [ctx] runtime budget context
 * @returns {{ ok: boolean, code?: string, reason?: string, normalized?: object, policy?: object, readOnly?: boolean }}
 */
function evaluateCommand(device, action, params = {}, ctx = {}) {
  if (!device || typeof device !== 'object') {
    return { ok: false, code: 'no-device', reason: 'unknown device' };
  }
  const act = normalizeAction(action);
  if (!act) return { ok: false, code: 'no-action', reason: 'missing action' };

  const policy = getDevicePolicy(device);

  // Capability scoping — action must be declared by the device.
  if (!policy.allowedActions.includes(act)) {
    return { ok: false, code: 'unsupported-action', reason: `action "${act}" not in device capabilities`, policy };
  }

  const readOnly = READ_ONLY_ACTIONS.has(act);

  // Host-side param validation (malformed → rejected).
  const normalizedParams = {};
  if (act === 'brightness') {
    const level = Number(params && params.level);
    if (!Number.isFinite(level) || level < 0 || level > 100) {
      return { ok: false, code: 'invalid-params', reason: 'brightness level must be 0..100', policy };
    }
    normalizedParams.level = Math.round(level);
  }

  // Power budget (only for state-changing actions).
  if (!readOnly) {
    const budget = Number.isFinite(Number(ctx.maxTotalPowerW)) ? Number(ctx.maxTotalPowerW) : DEFAULT_MAX_TOTAL_POWER_W;
    const estimate = estimateActionPowerW(device, act);
    // Per-device ceiling.
    if (estimate > policy.maxPowerW) {
      return { ok: false, code: 'power-exceeded', reason: `action power ${estimate}W exceeds device ceiling ${policy.maxPowerW}W`, policy };
    }
    // LIVE CUMULATIVE budget: sum of OTHER active devices' continuous draw plus
    // this device's PROJECTED continuous draw after the action. Fails safe — an
    // over-budget command is blocked (the PAL surfaces it as a rejection).
    const others = Number.isFinite(Number(ctx.otherDevicesLoadW)) ? Number(ctx.otherDevicesLoadW) : 0;
    const projected = projectedDeviceLoadW(device, act, normalizedParams);
    const projectedTotalW = Math.round((others + projected) * 100) / 100;
    if (projectedTotalW > budget) {
      return {
        ok: false, code: 'power-budget-exceeded',
        reason: `cumulative ${projectedTotalW}W exceeds budget ${budget}W`,
        policy,
        power: { projectedTotalW, budgetW: budget, othersW: others, deviceW: projected }
      };
    }
  }

  return { ok: true, normalized: { action: act, params: normalizedParams }, policy, readOnly };
}

/**
 * DCP-native evaluation: verify a formal command ENVELOPE (structure + freshness
 * + nonce replay + capability token scope) and THEN run the same host-side
 * capability/param/power validation as evaluateCommand(). Used for inbound
 * commands arriving over a wire (networked / remote devices). Backward compatible
 * — local callers keep using evaluateCommand() directly.
 *
 * @param {object} device registry device record
 * @param {object} envelope DCP command envelope (see dcp-protocol.buildCommandEnvelope)
 * @param {object} [ctx] { secret, now, freshnessMs, seenNonces, requireCapability, maxTotalPowerW }
 * @returns {{ ok:boolean, code?:string, reason?:string, normalized?:object, policy?:object, readOnly?:boolean, command?:object }}
 */
function evaluateCommandEnvelope(device, envelope, ctx = {}) {
  // Phase 9: remote / networked drivers MUST present a signed capability token
  // when a DCP secret is configured. Local/trusted drivers may stay unsigned.
  const requireCapability = ctx.requireCapability
    || (ctx.driverRemote && dcp.isSigningConfigured(ctx.secret));
  const v = dcp.verifyEnvelope(envelope, {
    secret: ctx.secret,
    now: ctx.now,
    freshnessMs: ctx.freshnessMs,
    seenNonces: ctx.seenNonces,
    requireCapability
  });
  if (!v.ok) return { ok: false, code: `envelope-${v.reason}`, reason: v.reason };

  // The envelope's target device MUST match the device we are evaluating against.
  if (device && device.id && String(device.id) !== v.command.device) {
    return { ok: false, code: 'device-mismatch', reason: 'envelope device does not match target device' };
  }

  const res = evaluateCommand(device, v.command.action, v.command.params, ctx);
  return res.ok ? { ...res, command: v.command } : res;
}

module.exports = {
  VALID_CLASSES,
  CLASS_POLICY,
  READ_ONLY_ACTIONS,
  DEFAULT_MAX_TOTAL_POWER_W,
  normalizeAction,
  getDevicePolicy,
  estimateActionPowerW,
  isDeviceActive,
  estimateDeviceLoadW,
  projectedDeviceLoadW,
  evaluateCommand,
  evaluateCommandEnvelope,
  dcp
};
