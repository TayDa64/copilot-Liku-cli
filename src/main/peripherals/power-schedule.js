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
        // fromHour/toHour may be a number (0..24) OR the tokens 'sunrise'/'sunset',
        // resolved lazily so a moving sunrise/sunset can be provided at query time.
        fromHour: _normHourSpec(s.fromHour, 0),
        toHour: _normHourSpec(s.toHour, 24),
        maxW: Number.isFinite(Number(s.maxW)) ? Math.max(0, Number(s.maxW)) : 0,
        // Optional per-day restriction: array of weekday numbers (0=Sun..6=Sat)
        // or names (sun,mon,...). Absent → the rule applies every day.
        days: _parseDays(s.days),
        // Optional per-rule sunrise/sunset overrides (hours 0..24).
        sunriseHour: Number.isFinite(Number(s.sunriseHour)) ? _clampHour(s.sunriseHour, 6) : undefined,
        sunsetHour: Number.isFinite(Number(s.sunsetHour)) ? _clampHour(s.sunsetHour, 18) : undefined
      }));
  } catch {
    return [];
  }
}

/** Keep a numeric hour clamped, or pass through the sunrise/sunset tokens. @private */
function _normHourSpec(v, dflt) {
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'sunrise' || t === 'sunset') return t;
  }
  return _clampHour(v, dflt);
}

const _DAY_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** Parse a days list (numbers or names) into a Set of weekday numbers, or null. @private */
function _parseDays(days) {
  if (!Array.isArray(days) || !days.length) return null;
  const out = [];
  for (const d of days) {
    if (typeof d === 'number' && Number.isFinite(d)) { const n = ((Math.floor(d) % 7) + 7) % 7; out.push(n); }
    else if (typeof d === 'string') { const n = _DAY_NAMES[d.trim().slice(0, 3).toLowerCase()]; if (n != null) out.push(n); }
  }
  return out.length ? out : null;
}

/** Resolve a from/to hour spec (number or sunrise/sunset token) to a number. @private */
function _resolveHour(spec, rule) {
  if (spec === 'sunrise') {
    return rule && rule.sunriseHour != null
      ? rule.sunriseHour
      : _clampHour(process.env.LIKU_PERIPHERAL_SUNRISE_HOUR, 6);
  }
  if (spec === 'sunset') {
    return rule && rule.sunsetHour != null
      ? rule.sunsetHour
      : _clampHour(process.env.LIKU_PERIPHERAL_SUNSET_HOUR, 18);
  }
  return _clampHour(spec, 0);
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
 * schedule GOVERNS the device right now (→ no additional restriction). When one
 * or more rules govern today: inside a window → the highest maxW; outside every
 * window → 0 (device must be off).
 *
 * Rules restricted to specific `days` only govern on those days; if a device has
 * only day-restricted rules and none match today, the device is UNRESTRICTED
 * today (returns null) rather than forced off — schedules only ever restrict.
 * @param {string} deviceId
 * @param {Date} [now]
 * @returns {number|null}
 */
function deviceScheduleW(deviceId, now = new Date()) {
  if (!enabled()) return null;
  const rules = loadSchedules().filter((s) => s.id === deviceId);
  if (!rules.length) return null;
  const day = now.getDay();
  const applicable = rules.filter((r) => !r.days || r.days.includes(day));
  if (!applicable.length) return null; // no rule governs today → unrestricted
  const hour = now.getHours() + now.getMinutes() / 60;
  let cap = 0; // governed today but outside every window → must be off
  for (const r of applicable) {
    if (_inWindow(hour, _resolveHour(r.fromHour, r), _resolveHour(r.toHour, r))) cap = Math.max(cap, r.maxW);
  }
  return cap;
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
  const hour = now.getHours() + now.getMinutes() / 60;
  const day = now.getDay();
  return rules.map((r) => {
    const from = _resolveHour(r.fromHour, r);
    const to = _resolveHour(r.toHour, r);
    const governsToday = !r.days || r.days.includes(day);
    return {
      id: r.id,
      fromHour: r.fromHour,
      toHour: r.toHour,
      resolvedFrom: from,
      resolvedTo: to,
      maxW: r.maxW,
      days: r.days,
      active: governsToday && _inWindow(hour, from, to)
    };
  });
}

module.exports = { FLAG, enabled, loadSchedules, deviceScheduleW, evaluate, describe };
