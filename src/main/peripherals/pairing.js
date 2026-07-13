/**
 * Commissioning / Pairing State Machine — reusable, testable (Pillar 3, Phase 16).
 *
 * Drivers with a real connection lifecycle (Matter fabric commissioning, BLE/
 * Zigbee pairing) share this small state machine to track per-device pairing
 * state with bounded retries + exponential backoff, so a flaky link degrades
 * cleanly to a FAILED state instead of hammering the transport.
 *
 * States:  unpaired → pairing → paired
 *                   ↘ (retry w/ backoff) ↗
 *                   ↘ (attempts exhausted) → failed
 *
 * SAFETY: pairing state is TRANSPORT bookkeeping only. It NEVER actuates a
 * device and NEVER bypasses the PAL safety chain — a paired device still goes
 * through DCP → class gate → pending/confirm for every action. HIL mode does not
 * use this at all (the simulator is always "virtually paired").
 */

'use strict';

const PAIR_STATES = Object.freeze({
  UNPAIRED: 'unpaired',
  PAIRING: 'pairing',
  PAIRED: 'paired',
  FAILED: 'failed'
});

/**
 * Create a per-driver pairing state tracker.
 * @param {{ maxAttempts?:number, baseBackoffMs?:number, maxBackoffMs?:number, now?:()=>number }} [options]
 */
function createPairingState(options = {}) {
  const maxAttempts = Number.isFinite(Number(options.maxAttempts)) ? Math.max(1, Number(options.maxAttempts)) : 3;
  const baseBackoffMs = Number.isFinite(Number(options.baseBackoffMs)) ? Math.max(0, Number(options.baseBackoffMs)) : 500;
  const maxBackoffMs = Number.isFinite(Number(options.maxBackoffMs)) ? Math.max(0, Number(options.maxBackoffMs)) : 30000;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const devices = new Map(); // id → record

  function _rec(id) {
    if (!devices.has(id)) {
      devices.set(id, { state: PAIR_STATES.UNPAIRED, attempts: 0, lastError: null, nextRetryAt: 0, pairedAt: null });
    }
    return devices.get(id);
  }

  /** Exponential backoff (capped) for the Nth attempt (1-based). */
  function backoffMs(attempts) {
    return Math.min(maxBackoffMs, baseBackoffMs * Math.pow(2, Math.max(0, attempts - 1)));
  }

  return {
    PAIR_STATES,
    maxAttempts,
    baseBackoffMs,
    maxBackoffMs,
    backoffMs,

    /** True when a (re)pair attempt is permitted right now. */
    canAttempt(id) {
      const r = _rec(id);
      return r.state === PAIR_STATES.UNPAIRED && r.attempts < maxAttempts && now() >= r.nextRetryAt;
    },

    /** Mark the start of a pairing attempt (increments the attempt counter). */
    begin(id) {
      const r = _rec(id);
      r.state = PAIR_STATES.PAIRING;
      r.attempts += 1;
      r.startedAt = new Date().toISOString();
      return r;
    },

    /** Mark a successful pairing (clears error/backoff). */
    succeed(id) {
      const r = _rec(id);
      r.state = PAIR_STATES.PAIRED;
      r.pairedAt = new Date().toISOString();
      r.lastError = null;
      r.nextRetryAt = 0;
      return r;
    },

    /**
     * Mark a failed attempt. Schedules a backed-off retry until attempts are
     * exhausted, after which the device transitions to FAILED.
     */
    fail(id, reason) {
      const r = _rec(id);
      r.lastError = String(reason || 'pair-failed');
      if (r.attempts >= maxAttempts) {
        r.state = PAIR_STATES.FAILED;
        r.nextRetryAt = 0;
      } else {
        r.state = PAIR_STATES.UNPAIRED;
        r.nextRetryAt = now() + backoffMs(r.attempts);
      }
      return r;
    },

    /** Force a device back to a retryable UNPAIRED state (manual re-pair). */
    requeue(id) {
      const r = _rec(id);
      r.state = PAIR_STATES.UNPAIRED;
      r.attempts = 0;
      r.nextRetryAt = 0;
      r.lastError = null;
      return r;
    },

    isPaired(id) { return _rec(id).state === PAIR_STATES.PAIRED; },
    state(id) { return _rec(id).state; },
    get(id) { return { ..._rec(id) }; },
    all() { const out = {}; for (const [k, v] of devices) out[k] = { ...v }; return out; },
    reset(id) { if (id) devices.delete(id); else devices.clear(); }
  };
}

module.exports = { createPairingState, PAIR_STATES };
