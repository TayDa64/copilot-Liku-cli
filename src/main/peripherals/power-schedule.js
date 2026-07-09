/**
 * Per-Device Power Schedules — time-boxed budgets (Phase 12, ADDITIVE + OFF by default).
 *
 * Lets an operator cap a specific device's allowed power draw during certain
 * hours (e.g. "the heater may draw ≤ 500 W between 22:00 and 06:00, and must be
 * off otherwise"). This is an ADDITIONAL, opt-in safety layer enforced by the
 * PAL BEFORE the class gate — it can only ever make actuation MORE restrictive,
 * never less. When no schedules are configured it has NO effect, so all existing
 * behaviour (and tests) are unchanged.
 *
 * Config (JSON in env LIKU_PERIPHERAL_SCHEDULES) — array of:
 *   { id, fromHour, toHour, maxW }
 *     id       device id the rule applies to
 *     fromHour inclusive local hour 0..23 the window opens
 *     toHour   exclusive local hour 0..23 the window closes (wraps past midnight
 *              when fromHour > toHour, e.g. 22→6)
 *     maxW     max allowed continuous watts for the device inside the window
 *              (outside the window the device budget is 0 → must be off)
 *
 * SAFETY: schedules are advisory *restrictions*. They never grant power and
 * never bypass DCP / class gate / pending-confirm.
 */

'use strict';

const FLAG = 'LIKU_ENABLE_PERIPHERALS';

function enabled() {
  return String(process.env[FLAG] || '').trim() === '1';
}

/** Parse declared schedules from env (safe, never throws). */
function loadSchedules() {
  if (!enabled()) return [];
  try {
    const raw = process.env.LIKU_PERIPHERAL_SCHEDULES;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s) => s && typeof s === 'object' && s.id)
      .map((s) => ({
        id: String(s.id),
        fromHour: _clampHour(s.fromHour, 0),
        toHour: _clampHour(s.toHour, 24),
        maxW: Number.isFinite(Number(s.maxW)) ? Math.max(0, Number(s.maxW)) : 0
      }));
  } catch {
    return [];
  }
}

function _clampHour(v, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(0, Math.min(24, Math.floor(n)));
}

/** True when `hour` falls inside [fromHour, toHour), handling midnight wrap. @private */
function _inWindow(hour, fromHour, toHour) {
  if (fromHour === toHour) return true;      // full-day window
  if (fromHour < toHour) return hour >= fromHour && hour < toHour;
  return hour >= fromHour || hour < toHour;  // wraps past midnight
}

/**
 * The scheduled max watts for a device at a given time. Returns null when no
 * schedule applies (→ no additional restriction). Inside the window → maxW;
 * outside → 0 (device must be off).
 * @param {string} deviceId
 * @param {Date} [now]
 * @returns {number|null}
 */
function deviceScheduleW(deviceId, now = new Date()) {
  if (!enabled()) return null;
  const rules = loadSchedules().filter((s) => s.id === deviceId);
  if (!rules.length) return null;
  const hour = now.getHours();
  let cap = 0; // outside every window → must be off
  let matched = false;
  for (const r of rules) {
    matched = true;
    if (_inWindow(hour, r.fromHour, r.toHour)) cap = Math.max(cap, r.maxW);
  }
  return matched ? cap : null;
}

/**
 * Evaluate a projected device load against its schedule. Advisory-restriction
 * only. Returns { ok } when within the scheduled cap, else a structured reason.
 * @param {string} deviceId
 * @param {number} projectedDeviceLoadW
 * @param {Date} [now]
 * @returns {{ ok:boolean, reason?:string, code?:string, scheduleW?:number, projectedW?:number }}
 */
function evaluate(deviceId, projectedDeviceLoadW, now = new Date()) {
  const cap = deviceScheduleW(deviceId, now);
  if (cap == null) return { ok: true }; // no schedule → no restriction
  const projected = Number(projectedDeviceLoadW) || 0;
  if (projected > cap) {
    return {
      ok: false,
      code: 'power-schedule-exceeded',
      reason: cap === 0
        ? `device ${deviceId} is outside its scheduled window (must be off)`
        : `device ${deviceId} projected ${projected}W exceeds scheduled cap ${cap}W`,
      scheduleW: cap,
      projectedW: projected
    };
  }
  return { ok: true, scheduleW: cap, projectedW: projected };
}

/** Describe configured schedules + their current (in-window) status (CLI). */
function describe(now = new Date()) {
  const rules = loadSchedules();
  const hour = now.getHours();
  return rules.map((r) => ({
    ...r,
    active: _inWindow(hour, r.fromHour, r.toHour)
  }));
}

module.exports = { FLAG, enabled, loadSchedules, deviceScheduleW, evaluate, describe };
