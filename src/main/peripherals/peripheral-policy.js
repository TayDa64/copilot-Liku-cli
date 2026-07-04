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

  // Power budget skeleton (only for state-changing actions).
  if (!readOnly) {
    const budget = Number.isFinite(Number(ctx.maxTotalPowerW)) ? Number(ctx.maxTotalPowerW) : DEFAULT_MAX_TOTAL_POWER_W;
    const estimate = estimateActionPowerW(device, act);
    if (estimate > policy.maxPowerW) {
      return { ok: false, code: 'power-exceeded', reason: `action power ${estimate}W exceeds device ceiling ${policy.maxPowerW}W`, policy };
    }
    if (estimate > budget) {
      return { ok: false, code: 'power-budget-exceeded', reason: `action power ${estimate}W exceeds budget ${budget}W`, policy };
    }
  }

  return { ok: true, normalized: { action: act, params: normalizedParams }, policy, readOnly };
}

module.exports = {
  VALID_CLASSES,
  CLASS_POLICY,
  READ_ONLY_ACTIONS,
  DEFAULT_MAX_TOTAL_POWER_W,
  normalizeAction,
  getDevicePolicy,
  estimateActionPowerW,
  evaluateCommand
};
