/**
 * Peripheral Abstraction Layer (PAL) — Pillar 3 (mock-only, feature-flagged).
 *
 * Unified, driver-agnostic interface for peripheral devices:
 *   scan()                      → discover + register devices
 *   get(id)                     → a registered device
 *   execute(id, action, params) → perform an action (SAFETY GATED)
 *   subscribe(cb)               → device event stream (returns unsubscribe)
 *
 * SAFETY MODEL — every physical action is routed through the existing cognitive
 * substrate confidence + pending/confirm system (system-context-manager.js):
 *   Class C (sensor, read-only) : allowed immediately, no gating.
 *   Class B (safe actuator)     : gated proposeUpdate at high confidence → auto
 *                                 approved (logged/reversible, non-guard key).
 *   Class A (high-risk actuator): gated proposeUpdate to a guard.* key at LOW
 *                                 confidence → QUEUES for human confirmation.
 *                                 The action is refused until the user runs
 *                                 `liku system-context confirm <guardKey> --apply`.
 *                                 Class A can NEVER bypass confirmation.
 *
 * FEATURE FLAG — LIKU_ENABLE_PERIPHERALS must equal '1'. The flag is checked on
 * EVERY entry point (not just at startup). When off, every method is inert: it
 * returns an { enabled: false } shape and performs NO disk / registry / driver
 * work whatsoever. This module has zero import side effects.
 */

'use strict';

const FLAG = 'LIKU_ENABLE_PERIPHERALS';

/** Strict flag check — evaluated on every PAL operation. */
function isPeripheralsEnabled() {
  return String(process.env[FLAG] || '').trim() === '1';
}

const EventEmitter = require('events');

// Lazy accessors so nothing (disk/registry/driver) is touched unless the flag is
// on and a method is actually invoked.
function registry() { return require('./peripheral-registry').getInstance(); }
function systemContext() { return require('../system-context-manager'); }
function policy() { return require('./peripheral-policy'); }
function hil() { return require('./hil-simulator'); }
function powerHistory() { return require('./power-history'); }
function powerSchedule() { return require('./power-schedule'); }
function powerAnomaly() { return require('./power-anomaly'); }
function tokenStore() { return require('./token-store'); }
function lockHistory() { return require('./lock-history'); }
function coordination() { return require('./coordination'); }
function deviceSchedule() { return require('./device-schedule'); }

/** True when hardware-in-the-loop simulation mode is enabled. */
function isHilEnabled() {
  return hil().isEnabled();
}

// ── Driver registry ──────────────────────────────────────────
// The mock driver is ALWAYS available (first-class test driver). Real drivers
// (e.g. mqtt) are used only when they report isAvailable() — otherwise the mock
// remains the default. All drivers share the same interface:
//   id, isAvailable(), discover(), perform(device, action, params), start(emit)
const DRIVER_IDS = Object.freeze(['mock', 'mqtt', 'serial', 'ble', 'zigbee', 'ros2', 'matter', 'thread', 'zwave', 'usbhid', 'knx']);
const _driverCache = {};
function _driver(id) {
  if (!(id in _driverCache)) {
    try {
      if (id === 'mock') _driverCache[id] = require('./drivers/mock-driver');
      else if (id === 'mqtt') _driverCache[id] = require('./drivers/mqtt-driver');
      else if (id === 'serial') _driverCache[id] = require('./drivers/serial-driver');
      else if (id === 'ble') _driverCache[id] = require('./drivers/ble-driver');
      else if (id === 'zigbee') _driverCache[id] = require('./drivers/zigbee-driver');
      else if (id === 'ros2') _driverCache[id] = require('./drivers/ros2-driver');
      else if (id === 'matter') _driverCache[id] = require('./drivers/matter-driver');
      else if (id === 'thread') _driverCache[id] = require('./drivers/thread-driver');
      else if (id === 'zwave') _driverCache[id] = require('./drivers/zwave-driver');
      else if (id === 'usbhid') _driverCache[id] = require('./drivers/usbhid-driver');
      else if (id === 'knx') _driverCache[id] = require('./drivers/knx-driver');
      else _driverCache[id] = null;
    } catch { _driverCache[id] = null; }
  }
  return _driverCache[id] || null;
}
function availableDrivers() {
  return DRIVER_IDS.map(_driver).filter((d) => d && (typeof d.isAvailable !== 'function' || d.isAvailable()));
}
function driverFor(device) {
  return _driver(device && device.driver) || _driver('mock');
}

// ── Event bus (event-driven monitoring) ──────────────────────
const _bus = new EventEmitter();
_bus.setMaxListeners(100);
function _emit(event) {
  try {
    _bus.emit('event', event);
    if (event && event.type) _bus.emit(event.type, event);
  } catch { /* listener errors are non-fatal */ }
}

/**
 * Discover devices across all available drivers and register them. The mock
 * driver is always included; real drivers only when configured/available.
 * @returns {{ enabled: boolean, devices: object[] }}
 */
function scan() {
  if (!isPeripheralsEnabled()) return { enabled: false, devices: [] };
  const reg = registry();
  let count = 0;
  for (const d of availableDrivers()) {
    try {
      for (const dev of d.discover()) { reg.register(dev); count++; }
    } catch { /* one bad driver never breaks the scan */ }
  }
  _emit({ type: 'scan', count, at: new Date().toISOString() });
  return { enabled: true, devices: reg.list() };
}

/**
 * Get a registered device by id.
 * @param {string} id
 * @returns {object|null}
 */
function get(id) {
  if (!isPeripheralsEnabled()) return null;
  return registry().get(id);
}

/**
 * List devices (optionally by class).
 * @param {{class?:string}} [filter]
 * @returns {{ enabled: boolean, devices: object[] }}
 */
function list(filter = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, devices: [] };
  return { enabled: true, devices: registry().list(filter) };
}

/** List available driver ids. */
function listDrivers() {
  if (!isPeripheralsEnabled()) return { enabled: false, drivers: [] };
  return { enabled: true, drivers: availableDrivers().map((d) => d.DRIVER_ID) };
}

/** Build the guard key that authorizes a specific Class A device. @private */
function _authKey(device) {
  return `guard.peripheral.${String(device.id).replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

/** Read the optional global power budget from the substrate. @private */
function _powerBudgetW() {
  try {
    const v = Number(systemContext().getInstance().get('guard.peripherals.max_total_power_w'));
    return Number.isFinite(v) ? v : undefined;
  } catch { return undefined; }
}

/** TTL for the device lease renewed on execute (Phase 26). @private */
function _deviceLeaseTtlMs() {
  const v = Number(process.env.LIKU_PERIPHERAL_DEVICE_LEASE_TTL_MS);
  if (Number.isFinite(v) && v > 0) return v;
  const pv = Number(process.env.LIKU_PERIPHERAL_PAIR_LEASE_TTL_MS);
  return Number.isFinite(pv) && pv > 0 ? pv : 300000; // default 5 min (matches pairing lease)
}

/**
 * Sum the CURRENT continuous draw (watts) of all registered devices except the
 * given id. Used for live cumulative power budgeting. @private
 */
function _currentLoadW(excludeId) {
  try {
    const P = policy();
    let sum = 0;
    for (const d of registry().list()) {
      if (excludeId && d.id === excludeId) continue;
      sum += P.estimateDeviceLoadW(d);
    }
    return Math.round(sum * 100) / 100;
  } catch { return 0; }
}

/**
 * Live power budget status: total budget, current cumulative draw, headroom and
 * a per-device breakdown. Inert when peripherals are disabled.
 * @returns {object}
 */
function powerStatus() {
  if (!isPeripheralsEnabled()) return { enabled: false };
  const P = policy();
  const budgetW = _powerBudgetW();
  const effectiveBudgetW = Number.isFinite(budgetW) ? budgetW : P.DEFAULT_MAX_TOTAL_POWER_W;
  const devices = registry().list().map((d) => ({
    id: d.id, class: d.class, kind: d.kind,
    loadW: P.estimateDeviceLoadW(d), active: P.isDeviceActive(d)
  }));
  const currentW = Math.round(devices.reduce((s, d) => s + d.loadW, 0) * 100) / 100;
  // Phase 12: fold in historical peak/avg (best-effort) + active schedule count.
  let history = null;
  try { history = powerHistory().summary(); } catch { history = null; }
  let schedules = 0;
  try { schedules = powerSchedule().describe().length; } catch { schedules = 0; }
  // Phase 13: surface a live anomaly count (advisory).
  let anomalies = 0;
  let anomalyTypes = [];
  try {
    const a = powerAnomaly().detect();
    if (a && a.anomalies) { anomalies = a.anomalies.length; anomalyTypes = a.anomalies.map((x) => x.type); }
  } catch { anomalies = 0; }
  return {
    enabled: true,
    budgetW: effectiveBudgetW,
    currentW,
    headroomW: Math.round((effectiveBudgetW - currentW) * 100) / 100,
    overBudget: currentW > effectiveBudgetW,
    hil: isHilEnabled(),
    locking: 'advisory-file-lock',
    cluster: (() => { try { return coordination().status().mode; } catch { return 'single-machine'; } })(),
    peakW: history ? history.peakW : 0,
    avgW: history ? history.avgW : 0,
    samples: history ? history.count : 0,
    schedules,
    anomalies,
    anomalyTypes,
    devices
  };
}

/**
 * Capture the current power snapshot into the rolling history log (best-effort,
 * flag-gated, atomic). Returns the recorded sample or null.
 */
function recordPowerSample() {
  if (!isPeripheralsEnabled()) return null;
  try {
    const ps = powerStatus();
    const rec = powerHistory().record({
      at: new Date().toISOString(),
      totalW: ps.currentW,
      budgetW: ps.budgetW,
      overBudget: ps.overBudget,
      devices: ps.devices
    });
    // Phase 13: advisory anomaly detection — surface (never actuate). Emitting a
    // decoupled 'power-anomaly' event lets the CLI / an escalation consumer react.
    try {
      const res = powerAnomaly().detect();
      if (res && res.anomalies && res.anomalies.length) {
        for (const a of res.anomalies) _emit({ type: 'power-anomaly', anomaly: a, baselineW: res.baselineW, at: a.at });
      }
      // Phase 26: publish a COMPACT anomaly summary to the cluster (best-effort)
      // so other nodes can reason about a fleet-wide picture. Cluster off → no-op.
      try {
        clusterAnomaly().publish({
          anomalies: (res && res.anomalies) || [],
          devices: ps.devices, totalW: ps.currentW, budgetW: ps.budgetW
        });
      } catch { /* cluster publish is best-effort */ }
    } catch { /* anomaly detection is advisory + best-effort */ }
    // Phase 21: capture a lock-metrics snapshot so contention is observable over
    // time (best-effort, flag-gated, atomic). Pure observability.
    try { lockHistory().record(); } catch { /* observability only */ }
    return rec;
  } catch { return null; }
}

/** Query recent lock-metrics snapshots (contention over time). */
function getLockHistory(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, snapshots: [] };
  try { return { enabled: true, snapshots: lockHistory().query(opts) }; }
  catch { return { enabled: true, snapshots: [] }; }
}

/** Record a lock-metrics snapshot on demand. */
function recordLockSnapshot() {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try { return { enabled: true, snapshot: lockHistory().record() }; }
  catch { return { enabled: true, snapshot: null }; }
}

/** Lock contention trends + hottest files (observability). */
function getLockTrends(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try { return { enabled: true, ...lockHistory().trends(opts) }; }
  catch { return { enabled: true, snapshots: 0, hotFiles: [] }; }
}

/** Phase 26 — per-file lock trends over the recorded window (observability). */
function getLockFileTrends(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, files: [] };
  try { return { enabled: true, ...lockHistory().fileTrends(opts) }; }
  catch { return { enabled: true, snapshots: 0, files: [] }; }
}

/** Phase 26 — contention alerts for files exceeding acquire / rate thresholds. */
function getLockAlerts(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, alerts: [] };
  try { return { enabled: true, ...lockHistory().alerts(opts) }; }
  catch { return { enabled: true, alerts: [] }; }
}

/** Cross-host coordination status (single-machine vs cluster). */
function getCoordinationStatus() {
  try { return { enabled: isPeripheralsEnabled(), ...coordination().status() }; }
  catch { return { enabled: isPeripheralsEnabled(), mode: 'single-machine' }; }
}

/** Acquire a cross-host device lease (inert/local when cluster mode is off). */
function acquireDeviceLease(id, opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try { return { enabled: true, ...coordination().acquireLease(`device:${id}`, opts) }; }
  catch (err) { return { enabled: true, granted: false, reason: err.message }; }
}

/** Release a cross-host device lease held by this node. */
function releaseDeviceLease(id) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try { return { enabled: true, ...coordination().releaseLease(`device:${id}`) }; }
  catch (err) { return { enabled: true, released: false, reason: err.message }; }
}

/** Describe configured cron device-schedule rules. */
function getCronSchedules() {
  if (!isPeripheralsEnabled()) return { enabled: false, rules: [] };
  try { return { enabled: true, rules: deviceSchedule().describe() }; }
  catch { return { enabled: true, rules: [] }; }
}

/** Advisory cron-proposed tasks due at `now` (human-gated; never executed). */
function getDueCronTasks(now) {
  if (!isPeripheralsEnabled()) return { enabled: false, tasks: [] };
  try { return { enabled: true, tasks: deviceSchedule().proposeCronTasks(now ? new Date(now) : new Date()) }; }
  catch { return { enabled: true, tasks: [] }; }
}

/** Query recent power-history samples. @param {{sinceMs?:number,limit?:number}} [opts] */
function getPowerHistory(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, samples: [] };
  try { return { enabled: true, samples: powerHistory().query(opts) }; }
  catch { return { enabled: true, samples: [] }; }
}

/** Trend summary over the retained power-history window. */
function getPowerTrend(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try { return { enabled: true, ...powerHistory().summary(opts) }; }
  catch { return { enabled: true, count: 0, peakW: 0, avgW: 0, currentW: 0, budgetW: null, perDevicePeakW: {} }; }
}

/** Describe configured per-device power schedules + current window status. */
function getPowerSchedules() {
  if (!isPeripheralsEnabled()) return { enabled: false, schedules: [] };
  try { return { enabled: true, schedules: powerSchedule().describe() }; }
  catch { return { enabled: true, schedules: [] }; }
}

/** Detect advisory power anomalies from the rolling history. */
function getPowerAnomalies(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, anomalies: [] };
  try { return { enabled: true, ...powerAnomaly().detect(opts) }; }
  catch { return { enabled: true, anomalies: [], baselineW: 0, currentW: 0, samples: 0 }; }
}

function powerForecast() { return require('./power-forecast'); }

/** Short-horizon power forecast from per-hour-of-day baselines (advisory). */
function getPowerForecast(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, ok: false, horizon: [] };
  try { return { enabled: true, ...powerForecast().forecast(opts) }; }
  catch { return { enabled: true, ok: false, horizon: [] }; }
}

/** Early-warning: upcoming hours whose forecast draw would exceed the budget. */
function getForecastWarnings(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, warnings: [] };
  try {
    const budgetW = Number.isFinite(opts.budgetW) ? opts.budgetW : _powerBudgetW();
    const warnings = powerForecast().forecastExceedsBudget({ ...opts, budgetW });
    return { enabled: true, warnings };
  } catch { return { enabled: true, warnings: [] }; }
}

/** Tag a driver's pairing state map with the driver id. @private */
function _tagDriver(driverId, states) {
  const out = {};
  for (const [k, v] of Object.entries(states || {})) out[k] = { driver: driverId, ...v };
  return out;
}

/**
 * Trigger a pairing / commissioning attempt for a device via its driver.
 * Real pairing only happens when HIL is off; drivers that don't support pairing
 * report it. Never actuates — pairing is transport bookkeeping only.
 * @param {string} id
 */
function pairDevice(id) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  const device = registry().get(id);
  let drv = device ? driverFor(device) : null;
  // Fall back: locate a driver that DECLARES this device even before a scan, so
  // `liku peripherals pair <id>` works without a prior `scan`.
  if (!drv || typeof drv.pair !== 'function') {
    for (const d of availableDrivers()) {
      if (typeof d.pair !== 'function' || typeof d.discover !== 'function') continue;
      try { if (d.discover().some((dev) => dev.id === id)) { drv = d; break; } } catch { /* ignore */ }
    }
  }
  if (!drv || typeof drv.pair !== 'function') return { enabled: true, ok: false, reason: 'pairing-not-supported' };
  try {
    const rec = drv.pair(id);
    return { enabled: true, ok: !!(rec && rec.state === 'paired'), ...rec };
  } catch (err) { return { enabled: true, ok: false, reason: `pair-failed: ${err.message}` }; }
}

/**
 * Phase 37 — richer commissioning entry point. Routes to a driver's explicit
 * `commission(deviceId, { code })` when it supports one (Matter), otherwise falls
 * back to `pairDevice`. Real commissioning only happens when HIL is off; HIL is a
 * virtual commission. Never actuates — the PAL still gates any physical action.
 * @param {string} id
 * @param {{ code?:string }} [opts]
 */
function commissionDevice(id, opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  const device = registry().get(id);
  let drv = device ? driverFor(device) : null;
  if (!drv || typeof drv.commission !== 'function') {
    for (const d of availableDrivers()) {
      if (typeof d.commission !== 'function' || typeof d.discover !== 'function') continue;
      try { if (d.discover().some((dev) => dev.id === id)) { drv = d; break; } } catch { /* ignore */ }
    }
  }
  if (drv && typeof drv.commission === 'function') {
    try { return { enabled: true, ...drv.commission(id, opts) }; }
    catch (err) { return { enabled: true, ok: false, reason: `commission-failed: ${err.message}` }; }
  }
  // Fall back to the standard pairing path for drivers without explicit commissioning.
  return pairDevice(id);
}

/** Phase 37 — discover commissionable devices across drivers that support it (Matter). */
function getCommissionableDevices() {
  if (!isPeripheralsEnabled()) return { enabled: false, devices: [] };
  const out = [];
  for (const d of availableDrivers()) {
    if (typeof d.discoverCommissionable !== 'function') continue;
    try { for (const n of d.discoverCommissionable()) out.push({ driver: d.DRIVER_ID, ...n }); } catch { /* non-fatal */ }
  }
  return { enabled: true, devices: out };
}

/** Aggregate pairing / commissioning status across all available drivers. */
function getPairingStatus() {
  if (!isPeripheralsEnabled()) return { enabled: false, devices: {} };
  const devices = {};
  for (const d of availableDrivers()) {
    if (typeof d.pairingStatus === 'function') {
      try { Object.assign(devices, _tagDriver(d.DRIVER_ID, d.pairingStatus())); } catch { /* non-fatal */ }
    } else if (typeof d.discover === 'function') {
      // Connectionless drivers (mock / mqtt / serial) have no pairing lifecycle —
      // report their declared devices as 'ready' so the CLI surface is uniform.
      try { for (const dev of d.discover()) devices[dev.id] = { driver: d.DRIVER_ID, state: 'ready', connectionless: true }; }
      catch { /* non-fatal */ }
    }
  }
  return { enabled: true, devices };
}

/**
 * Tear down a device's pairing / commissioning via its driver (re-pairable).
 * Real only when HIL is off; connectionless drivers report it. Never actuates.
 * @param {string} id
 */
function unpairDevice(id) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  const device = registry().get(id);
  let drv = device ? driverFor(device) : null;
  if (!drv || typeof drv.unpair !== 'function') {
    for (const d of availableDrivers()) {
      if (typeof d.unpair !== 'function' || typeof d.discover !== 'function') continue;
      try { if (d.discover().some((dev) => dev.id === id)) { drv = d; break; } } catch { /* ignore */ }
    }
  }
  if (!drv || typeof drv.unpair !== 'function') return { enabled: true, ok: false, reason: 'pairing-not-supported' };
  try {
    const rec = drv.unpair(id);
    return { enabled: true, ok: true, ...rec };
  } catch (err) { return { enabled: true, ok: false, reason: `unpair-failed: ${err.message}` }; }
}

/** Per-device capability-token lifecycle status (gen / revoked / identity). */
function getTokenStatus() {
  if (!isPeripheralsEnabled()) return { enabled: false, devices: {} };
  try { return { enabled: true, devices: tokenStore().all() }; }
  catch { return { enabled: true, devices: {} }; }
}

/** Rotate a device's capability token generation (invalidates stale tokens). */
function rotateToken(id) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try {
    const dev = registry().get(id);
    const rec = tokenStore().rotate(id, dev ? { actions: dev.capabilities } : {});
    return { enabled: true, ok: !!rec, ...(rec || {}) };
  } catch (err) { return { enabled: true, ok: false, reason: err.message }; }
}

/** Explicitly revoke a device's capability token (remote drivers will refuse). */
function revokeToken(id) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try {
    const rec = tokenStore().revoke(id);
    return { enabled: true, ok: !!rec, ...(rec || {}) };
  } catch (err) { return { enabled: true, ok: false, reason: err.message }; }
}

/** Phase 23 — fleet-wide human-gated token rotation (rotate-all-on-event). */
function rotateAllTokens() {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try { return { enabled: true, ...tokenStore().rotateAll() }; }
  catch (err) { return { enabled: true, ok: false, reason: err.message }; }
}

/** Phase 26 — rotate a single action's token generation (targeted revocation). */
function rotateActionToken(id, action) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try { return { enabled: true, ...tokenStore().rotateAction(id, action) }; }
  catch (err) { return { enabled: true, ok: false, reason: err.message }; }
}

/** Phase 26 — rotate a device's identity fingerprint (human-gated hygiene). */
function rotateDeviceIdentity(id) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try { return { enabled: true, ...tokenStore().rotateIdentity(id) }; }
  catch (err) { return { enabled: true, ok: false, reason: err.message }; }
}

/** Phase 23 — day-of-week seasonal forecast (advisory). */
function getSeasonalForecast(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, ok: false, horizon: [] };
  try { return { enabled: true, ...powerForecast().seasonalForecast(opts) }; }
  catch { return { enabled: true, ok: false, horizon: [] }; }
}

/** Phase 23 — per-device forecast warnings (which device likely drives a breach). */
function getDeviceForecastWarnings(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, warnings: [] };
  try {
    const budgetW = Number.isFinite(opts.budgetW) ? opts.budgetW : _powerBudgetW();
    return { enabled: true, warnings: powerForecast().deviceForecastWarnings({ ...opts, budgetW }) };
  } catch { return { enabled: true, warnings: [] }; }
}

/** Phase 39 — weekly / multi-day forecast horizon (pure observation, advisory only). */
function getMultiDayForecast(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, ok: false, days: [] };
  try { return { enabled: true, ...powerForecast().multiDayForecast(opts) }; }
  catch { return { enabled: true, ok: false, days: [] }; }
}

/** Phase 39 — per-day-of-week weekly load profile (pure observation). */
function getWeeklyProfile(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, profile: {} };
  try { return { enabled: true, profile: powerForecast().weeklyProfile(opts) }; }
  catch { return { enabled: true, profile: {} }; }
}

/** Phase 23 — propose a multi-hour coordinated schedule from the forecast bands. */
function getMultiHourProposal(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, proposal: null };
  try {
    const budgetW = Number.isFinite(opts.budgetW) ? opts.budgetW : _powerBudgetW();
    return { enabled: true, proposal: scheduleAdvisor().proposeMultiHourSchedule({ ...opts, budgetW }) };
  } catch { return { enabled: true, proposal: null }; }
}
/** Phase 25 — data-driven special/holiday day detection (advisory). */
function getSpecialDays(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, dates: [] };
  try { return { enabled: true, ...powerForecast().detectSpecialDays(opts) }; }
  catch { return { enabled: true, dates: [] }; }
}

/** Phase 25 — best-effort cluster GC: expire stale token records + prune expired
 * leases. Cluster off → no-op. Drives lazily (no background timer). */
function sweepCluster(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try {
    const tokens = tokenStore().sweepClusterTokens(opts);
    const leases = coordination().pruneExpiredLeases(opts.now);
    // Phase 26: also GC stale shared advisor/action proposals + anomaly summaries.
    let shared = { proposals: [], actions: [], anomalies: [] };
    try {
      const coord = coordination();
      const ttl = Number(process.env.LIKU_PERIPHERAL_CLUSTER_PROPOSAL_TTL_MS) || 24 * 3600 * 1000;
      shared = {
        proposals: coord.sweepShared('proposals', ttl, opts.now).removed,
        actions: coord.sweepShared('anomaly-actions', ttl, opts.now).removed,
        anomalies: clusterAnomaly().sweep(opts.now).removed
      };
      // Phase 27: GC stale shared task/notification summaries + old cluster schedules.
      try {
        const ts2 = clusterTasks().sweep(opts.now);
        const schedTtl = Number(process.env.LIKU_PERIPHERAL_CLUSTER_SCHEDULE_TTL_MS) || 30 * 24 * 3600 * 1000;
        const tombTtl = Number(process.env.LIKU_PERIPHERAL_CLUSTER_TOMBSTONE_TTL_MS) || 7 * 24 * 3600 * 1000;
        shared.tasks = ts2.tasks;
        shared.notifications = ts2.notifications;
        shared.schedules = coord.sweepShared('schedules', schedTtl, opts.now).removed;
        shared.tombstones = coord.sweepShared('schedule-tombstones', tombTtl, opts.now).removed;
        shared.assignments = coord.sweepShared('task-assignments', Number(process.env.LIKU_PERIPHERAL_TASK_ASSIGN_TTL_MS) || 3600000, opts.now).removed;
        // Phase 29: retire any time-boxed confirmed schedules that have expired.
        try { shared.expiredSchedules = scheduleAdvisor().sweepExpiredSchedules({ now: opts.now }).expired; } catch { /* best-effort */ }
      } catch { /* best-effort */ }
    } catch { /* best-effort */ }
    return { enabled: true, tokens, leases, shared };
  } catch (err) { return { enabled: true, ok: false, reason: err.message }; }
}

function clusterAnomaly() { return require('./cluster-anomaly'); }
function clusterTasks() { return require('./cluster-tasks'); }

/** Phase 26 — fleet-wide aggregated anomaly + power view (advisory). */
function getClusterAnomalies(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, nodes: 0, anomalies: [] };
  try { return { enabled: true, ...clusterAnomaly().aggregate(opts) }; }
  catch { return { enabled: true, nodes: 0, anomalies: [] }; }
}

/** Phase 27 — fleet-wide visible Supervisor tasks (compact, advisory). */
function getClusterTasks(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, tasks: [] };
  try { return { enabled: true, tasks: clusterTasks().listTasks(opts) }; }
  catch { return { enabled: true, tasks: [] }; }
}

/** Phase 27 — fleet-wide visible notifications (compact, advisory). */
function getClusterNotifications(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, notifications: [] };
  try { return { enabled: true, notifications: clusterTasks().listNotifications(opts) }; }
  catch { return { enabled: true, notifications: [] }; }
}

/** Phase 27 — mirror a task status change (acknowledged/confirmed/dismissed/resolved). */
function updateClusterTaskStatus(taskId, status) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try { return { enabled: true, ok: clusterTasks().updateTaskStatus(taskId, status) }; }
  catch (err) { return { enabled: true, ok: false, reason: err.message }; }
}

function scheduleAdvisor() { return require('./power-schedule-advisor'); }

/** Advisory power-schedule suggestions from recurring anomalies (proposed only). */
function getScheduleSuggestions() {
  if (!isPeripheralsEnabled()) return { enabled: false, suggestions: [] };
  try { return { enabled: true, suggestions: scheduleAdvisor().listProposed() }; }
  catch { return { enabled: true, suggestions: [] }; }
}

/** EXPLICIT human confirmation of a proposed schedule (activates it). */
function confirmScheduleSuggestion(id) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try { return { enabled: true, ...scheduleAdvisor().confirm(id) }; }
  catch (err) { return { enabled: true, ok: false, reason: err.message }; }
}

/** Dismiss a proposed schedule (human declined). */
function dismissScheduleSuggestion(id) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try { return { enabled: true, ...scheduleAdvisor().dismiss(id) }; }
  catch (err) { return { enabled: true, ok: false, reason: err.message }; }
}

/** Phase 28 — list locally-confirmed schedule rules. */
function getConfirmedSchedules() {
  if (!isPeripheralsEnabled()) return { enabled: false, schedules: [] };
  try { return { enabled: true, schedules: scheduleAdvisor().listConfirmedSchedules() }; }
  catch { return { enabled: true, schedules: [] }; }
}

/** Phase 28 — remove a confirmed schedule + tombstone it fleet-wide (human-gated). */
function removeConfirmedSchedule(deviceId, opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try { return { enabled: true, ...scheduleAdvisor().removeConfirmedSchedule(deviceId, opts) }; }
  catch (err) { return { enabled: true, ok: false, reason: err.message }; }
}

/** Phase 28 — claim ownership of a cluster task (advisory, exactly-one-owner). */
function claimClusterTask(taskId, opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try { return { enabled: true, ...clusterTasks().claimTask(taskId, opts) }; }
  catch (err) { return { enabled: true, claimed: false, reason: err.message }; }
}

/** Phase 28 — release a cluster task claim (resolve / dismiss). */
function releaseClusterTask(taskId) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try { return { enabled: true, ...clusterTasks().releaseTask(taskId) }; }
  catch (err) { return { enabled: true, released: false, reason: err.message }; }
}

/** Phase 28 — current owner of a cluster task (or null). */
function getClusterTaskOwner(taskId) {
  if (!isPeripheralsEnabled()) return { enabled: false, owner: null };
  try { return { enabled: true, owner: clusterTasks().taskOwner(taskId) }; }
  catch { return { enabled: true, owner: null }; }
}

// ── Phase 29: task assignment / handoff / auto-renew + time-boxed schedules ──

/** Phase 29 — assign a task to a specific node (advisory intent). */
function assignClusterTask(taskId, assignee, opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try { return { enabled: true, ...clusterTasks().assignTask(taskId, assignee, opts) }; }
  catch (err) { return { enabled: true, assigned: false, reason: err.message }; }
}

/** Phase 29 — hand a task off to a peer (or release to the open pool with falsy node). */
function handoffClusterTask(taskId, toNodeId, opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try { return { enabled: true, ...clusterTasks().handoffTask(taskId, toNodeId, opts) }; }
  catch (err) { return { enabled: true, handedOff: false, reason: err.message }; }
}

/** Phase 29 — the node a task is currently assigned to (or null). */
function getClusterTaskAssignment(taskId) {
  if (!isPeripheralsEnabled()) return { enabled: false, assignee: null };
  try { return { enabled: true, assignee: clusterTasks().assignmentFor(taskId) }; }
  catch { return { enabled: true, assignee: null }; }
}

/** Phase 29 — this node's assignment inbox (tasks assigned to it). */
function getMyClusterAssignments(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, assignments: [] };
  try { return { enabled: true, assignments: clusterTasks().myAssignments(opts) }; }
  catch { return { enabled: true, assignments: [] }; }
}

/** Phase 29 — renew this node's claim (auto-renew tick; keeps a working claim alive). */
function renewClusterTaskClaim(taskId, opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try { return { enabled: true, ...clusterTasks().renewClaim(taskId, opts) }; }
  catch (err) { return { enabled: true, claimed: false, reason: err.message }; }
}

/** Phase 29 — create a TIME-BOXED human-confirmed restrict-only schedule (expiresAt/ttlMs). */
function createTimeBoxedSchedule(deviceId, opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try { return { enabled: true, ...scheduleAdvisor().createConfirmedSchedule(deviceId, opts) }; }
  catch (err) { return { enabled: true, ok: false, reason: err.message }; }
}

/** Phase 29 — GC pass for expired time-boxed schedules (removes + tombstones them). */
function sweepExpiredSchedules(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, expired: [] };
  try { return { enabled: true, ...scheduleAdvisor().sweepExpiredSchedules(opts) }; }
  catch (err) { return { enabled: true, ok: false, reason: err.message, expired: [] }; }
}

function anomalyActionAdvisor() { return require('./anomaly-action-advisor'); }

/** Advisory proactive-action suggestions for persistently anomalous devices. */
function getAnomalyActions() {
  if (!isPeripheralsEnabled()) return { enabled: false, actions: [] };
  try { return { enabled: true, actions: anomalyActionAdvisor().listProposed() }; }
  catch { return { enabled: true, actions: [] }; }
}

/** EXPLICIT human confirmation of an advisory action. The confirmation IS the
 * human gate: for security actions (rotate-token / unpair) the approved operation
 * is then performed (these are non-actuating lifecycle/security ops). A
 * reduce-schedule action returns a directive to run the schedule confirm flow.
 * Pass { execute:false } to only record approval without performing. */
function confirmAnomalyAction(id, opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try {
    const res = anomalyActionAdvisor().confirm(id);
    if (!res.ok) return { enabled: true, ...res };
    const execute = opts.execute !== false;
    let executed = null;
    if (execute && res.action === 'rotate-token') {
      executed = rotateToken(res.deviceId);
    } else if (execute && res.action === 'unpair') {
      // Unpair tears down pairing AND revokes the device's capability token
      // (via driver-pairing → tokenStore.revoke) — a human-approved auto-revoke.
      executed = unpairDevice(res.deviceId);
    } else if (execute && res.action === 'reduce-schedule') {
      // Phase 24/25: on a reduce-schedule confirm, prefer the STRONGEST coordinated
      // response: a MULTI-HOUR window (contiguous over-budget run) → else a single-
      // hour MULTI-DEVICE cap → else a single-device schedule. All restrict-only,
      // caps sum ≤ budget, human-approved via THIS confirmation. Never actuates.
      const budgetW = _powerBudgetW();
      const hour = new Date().getHours();
      const adv = scheduleAdvisor();
      const multiHour = adv.createConfirmedMultiHourSchedule({ budgetW });
      if (multiHour && multiHour.ok) executed = { enabled: true, ...multiHour };
      else {
        const multi = adv.createConfirmedMultiSchedule({ budgetW, hour });
        if (multi && multi.ok) executed = { enabled: true, ...multi };
        else executed = { enabled: true, ...adv.createConfirmedSchedule(res.deviceId, { budgetW }) };
      }
    } else if (execute && res.action === 'rotate-all') {
      // Fleet-wide human-approved security response — rotate every active token.
      // Phase 28: QUORUM-STYLE CLAIM. When clustered, only the node that claims
      // the `fleet:rotate-all` task actually performs the rotation, so two nodes'
      // confirmations don't both rotate. Still human-gated (this IS the confirm).
      const coord = coordination();
      if (coord.clusterEnabled()) {
        const claim = clusterTasks().claimTask('fleet:rotate-all');
        if (!claim.claimed) {
          executed = { enabled: true, ok: false, reason: 'claimed-by-peer', owner: claim.owner };
        } else {
          executed = rotateAllTokens();
          try { clusterTasks().releaseTask('fleet:rotate-all'); } catch { /* best-effort */ }
        }
      } else {
        executed = rotateAllTokens();
      }
    } else if (execute && res.action === 'clear-schedule') {
      // Phase 30: human-approved DE-ESCALATION — remove the device's temporary
      // reduce-schedule restriction now that it has recovered. Removing a
      // restriction is human-gated; THIS confirmation is the gate. Non-actuating
      // (a device simply regains its normal, unrestricted operation envelope).
      executed = { enabled: true, ...scheduleAdvisor().removeConfirmedSchedule(res.deviceId) };
    } else if (execute && res.action === 'clear-rotate-token') {
      // Phase 31: human-approved DE-ESCALATION of the rotate-token rung on
      // recovery. This is a PURE advisory ladder RESET — it clears the device's
      // recorded anomaly state so the heal ladder starts fresh. It NEVER rotates a
      // token, unpairs, or actuates anything.
      executed = { enabled: true, ...anomalyActionAdvisor().resetDevice(res.deviceId) };
    } else if (execute && (res.action === 'stepback-rotate-token' || res.action === 'stepback-reduce-schedule')) {
      // Phase 32: human-approved PARTIAL step-back (one rung). PURE advisory posture
      // update (records the lower rung) — it NEVER re-pairs, rotates a token, or
      // actuates anything. Any real re-pair is left to the human via the directive.
      const toRung = res.action === 'stepback-rotate-token' ? 'rotate-token' : 'reduce-schedule';
      executed = { enabled: true, ...anomalyActionAdvisor().stepBackDevice(res.deviceId, toRung) };
    }
    // NOTE: a `repair` de-escalation (unpair rung) is deliberately NOT auto-executed
    // — re-pairing is security-sensitive, so the confirm only surfaces the directive
    // (`liku peripherals pair <device>`) for a human to run.
    return { enabled: true, ...res, executed };
  } catch (err) { return { enabled: true, ok: false, reason: err.message }; }
}

/** Dismiss a proposed advisory action (human declined). */
function dismissAnomalyAction(id) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try { return { enabled: true, ...anomalyActionAdvisor().dismiss(id) }; }
  catch (err) { return { enabled: true, ok: false, reason: err.message }; }
}

/** Phase 24 — per-device auto-heal policies (thresholds for each ladder action). */
function getAutoHealPolicies() {
  if (!isPeripheralsEnabled()) return { enabled: false, policies: {} };
  try { return { enabled: true, policies: anomalyActionAdvisor().listPolicies() }; }
  catch { return { enabled: true, policies: {} }; }
}

/** Phase 24 — set a device's auto-heal thresholds (human governance, persisted). */
function setAutoHealPolicy(deviceId, thresholds) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try { return { enabled: true, ...anomalyActionAdvisor().setPolicy(deviceId, thresholds) }; }
  catch (err) { return { enabled: true, ok: false, reason: err.message }; }
}

// ── Phase 30: rebalancing + expiry notifications + de-escalation/recovery ────

/** Phase 30 — rebalance stale / unclaimed open tasks to less-loaded nodes (advisory). */
function rebalanceClusterTasks(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, rebalanced: [] };
  try { return { enabled: true, ...clusterTasks().rebalance(opts) }; }
  catch (err) { return { enabled: true, rebalanced: [], reason: err.message }; }
}

/** Phase 30 — confirmed schedules whose cap is about to lapse or just lapsed (advisory). */
function getExpiringSchedules(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, schedules: [] };
  try { return { enabled: true, schedules: scheduleAdvisor().expiringSchedules(opts) }; }
  catch { return { enabled: true, schedules: [] }; }
}

/** Phase 30 — propose human-gated de-escalations for RECOVERED devices. */
function getDeescalations(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, deescalations: [] };
  try { return { enabled: true, deescalations: anomalyActionAdvisor().proposeDeescalations(opts) }; }
  catch { return { enabled: true, deescalations: [] }; }
}

/** Phase 30 — SAFE auto-clear of purely-advisory OPEN suggestions for recovered devices. */
function autoClearRecovered(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, cleared: [] };
  try { return { enabled: true, ...anomalyActionAdvisor().autoClearRecovered(opts) }; }
  catch { return { enabled: true, cleared: [] }; }
}

/** Phase 32 — last-run metrics + cumulative totals for the periodic self-heal tick (pure observation). */
function getSelfHealStatus() {
  if (!isPeripheralsEnabled()) return { enabled: false, lastRun: null, totals: {} };
  try { return { enabled: true, ...require('./self-heal-status').read() }; }
  catch { return { enabled: true, lastRun: null, totals: {} }; }
}

/** Phase 33 — tick-health: last-run age + whether the self-heal tick is stale (pure observation). */
function getSelfHealHealth(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, ran: false, stale: false };
  try { return { enabled: true, ...require('./self-heal-status').health(opts) }; }
  catch { return { enabled: true, ran: false, stale: false }; }
}

/** Phase 34 — de-escalation / step-back history + metrics (pure observation). */
function getDeescalationHistory() {
  if (!isPeripheralsEnabled()) return { enabled: false, devices: {}, totals: {} };
  try { return { enabled: true, ...require('./deescalation-history').read() }; }
  catch { return { enabled: true, devices: {}, totals: {} }; }
}

/** Phase 34 — per-device step-back state incl. cooldown remaining (pure observation). */
function getDeescalationState(deviceId, opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, known: false };
  try { return { enabled: true, ...require('./deescalation-history').deviceState(deviceId, opts) }; }
  catch { return { enabled: true, known: false }; }
}

/** Phase 34 — publish THIS node's health score (0..1) for fairness-weighted rebalancing (advisory). */
function publishNodeHealth(score, opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, published: false };
  try { return { enabled: true, ...clusterTasks().publishNodeHealth(score, opts) }; }
  catch (err) { return { enabled: true, published: false, reason: err.message }; }
}

/** Phase 35 — auto-derive this node's health (0..1) from real lock-contention metrics (pure observation). */
function deriveNodeHealth(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, score: 1 };
  try { return { enabled: true, ...clusterTasks().deriveNodeHealth(opts) }; }
  catch { return { enabled: true, score: 1 }; }
}

/** Phase 35 — derive + publish this node's health for peers to weight (advisory, cluster-gated). */
function publishDerivedNodeHealth(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, published: false };
  try { return { enabled: true, ...clusterTasks().publishDerivedNodeHealth(opts) }; }
  catch (err) { return { enabled: true, published: false, reason: err.message }; }
}

/** Phase 35 — de-escalation trend/aggregate view (pure observation). */
function getDeescalationTrends(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, devices: [] };
  try { return { enabled: true, ...require('./deescalation-history').trends(opts) }; }
  catch { return { enabled: true, devices: [] }; }
}

/** Phase 35 — cluster-wide de-escalation rollup (pure observation). */
function getDeescalationRollup(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, nodes: 0, totals: {} };
  try { return { enabled: true, ...require('./deescalation-history').clusterRollup(opts) }; }
  catch { return { enabled: true, nodes: 0, totals: {} }; }
}

/** Phase 35 — cluster-wide per-file lock contention trend view (pure observation). */
function getLockClusterTrends(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, files: [] };
  try { return { enabled: true, ...lockHistory().clusterFileTrends(opts) }; }
  catch { return { enabled: true, files: [] }; }
}

/** Phase 36 — de-escalation FLAPPING detection (pure observation). */
function getDeescalationFlapping(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, devices: [] };
  try { return { enabled: true, ...require('./deescalation-history').flapping(opts) }; }
  catch { return { enabled: true, devices: [] }; }
}

/** Phase 36 — cluster-wide per-node tick-health (which nodes are currently stalled). */
function getClusterTickHealth(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, nodes: 0, stalled: 0, perNode: [] };
  try { return { enabled: true, ...clusterTasks().clusterTickHealth(opts) }; }
  catch { return { enabled: true, nodes: 0, stalled: 0, perNode: [] }; }
}

/**
 * Phase 36 — UNIFIED FLEET OBSERVABILITY: one coherent, READ-ONLY aggregate of the
 * major health/trend views (self-heal, node-health, de-escalation trends/flapping,
 * lock cluster trends, and a compact power/anomaly summary). PURE OBSERVATION —
 * composition of existing getters; it never actuates and never mutates state.
 * Useful both single-machine and in cluster mode.
 * @param {{ now?:number }} [opts]
 */
function getFleetObservability(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const out = { enabled: true, mode: coordination().clusterEnabled() ? 'cluster' : 'single-machine', at: new Date(now).toISOString() };
  // Self-heal last-run + tick health.
  try { const st = require('./self-heal-status'); out.selfHeal = { lastRun: st.read().lastRun, health: st.health({ now }) }; } catch { out.selfHeal = null; }
  // Node health: this node's derived score + fleet tick-health + peer scores.
  try {
    const ct = clusterTasks();
    out.nodeHealth = { local: ct.deriveNodeHealth({ now }), tickHealth: ct.clusterTickHealth({ now }) };
    try { out.nodeHealth.peers = coordination().clusterEnabled() ? coordination().listShared('node-health', { now, maxAgeMs: 3600000 }).map((r) => ({ nodeId: r.nodeId, score: r.score })) : []; } catch { out.nodeHealth.peers = []; }
  } catch { out.nodeHealth = null; }
  // De-escalation trends + flapping + cluster rollup.
  try {
    const dh = require('./deescalation-history');
    out.deescalation = { trends: dh.trends({ now }), flapping: dh.flapping({ now }).devices, rollup: dh.clusterRollup({ now }) };
  } catch { out.deescalation = null; }
  // Lock cluster trends.
  try { out.locks = lockHistory().clusterFileTrends({ limit: 5 }); } catch { out.locks = null; }
  // Compact power + anomaly summary (best-effort).
  try { const ps = powerStatus(); out.power = { budgetW: ps.budgetW, currentW: ps.currentW, overBudget: ps.overBudget, anomalies: ps.anomalies }; } catch { out.power = null; }
  try { const ca = getClusterAnomalies({ now }); out.anomalies = { nodes: ca.nodes, count: (ca.anomalies || []).length, topDevice: (ca.topDevices && ca.topDevices[0]) ? ca.topDevices[0].id : null }; } catch { out.anomalies = null; }
  // Phase 38 — OPT-IN best-effort persistence of a compact snapshot so the last
  // fleet posture survives a restart. Double-gated (LIKU_PERIPHERAL_FLEET_SNAPSHOT=1);
  // pure observation — never actuates, never mutates the returned view.
  try { require('./fleet-snapshot').record(out, { now }); } catch { /* non-fatal */ }
  return out;
}

/** Phase 38 — read the last persisted fleet-observability snapshot(s) (pure observation, opt-in store). */
function getFleetSnapshot() {
  if (!isPeripheralsEnabled()) return { enabled: false, latest: null, recent: [] };
  try { return { enabled: true, ...require('./fleet-snapshot').read() }; }
  catch { return { enabled: true, latest: null, recent: [] }; }
}

/** Phase 39 — trend view over recent persisted fleet snapshots (pure observation). */
function getFleetSnapshotTrends(opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, points: 0, series: [] };
  try { return { enabled: true, ...require('./fleet-snapshot').trends(opts) }; }
  catch { return { enabled: true, points: 0, series: [] }; }
}

/** Phase 22 — mint a PER-ACTION (least-privilege) capability token for a device. */
function issueActionToken(id, action, opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try { return { enabled: true, ...tokenStore().issueActionToken(id, action, opts) }; }
  catch (err) { return { enabled: true, ok: false, reason: err.message }; }
}

/** Phase 22 — verify a device+action token against current (cluster-aware) state. */
function verifyDeviceToken(id, action, token, opts = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try { return { enabled: true, ...tokenStore().verifyDeviceToken(id, action, token, opts) }; }
  catch (err) { return { enabled: true, ok: false, reason: err.message }; }
}

/** Phase 22 — cluster-wide lock-metrics aggregation (single-machine → live view). */
function getClusterLockMetrics() {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try { return { enabled: true, ...lockHistory().clusterAggregate() }; }
  catch { return { enabled: true, mode: 'single-machine', nodes: 0, totals: {}, perNode: [], hotFiles: [] }; }
}

/** Phase 22 — propose a cron rule (validated; not active until confirmed). */
function proposeCronRule(rule) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try { return { enabled: true, ...deviceSchedule().proposeRule(rule) }; }
  catch (err) { return { enabled: true, ok: false, reason: err.message }; }
}

/** Phase 22 — list open (proposed) cron rules awaiting confirmation. */
function getProposedCronRules() {
  if (!isPeripheralsEnabled()) return { enabled: false, proposals: [] };
  try { return { enabled: true, proposals: deviceSchedule().listProposedRules() }; }
  catch { return { enabled: true, proposals: [] }; }
}

/** Phase 22 — EXPLICIT human confirmation: persist a proposed cron rule. */
function confirmCronRule(id) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try { return { enabled: true, ...deviceSchedule().confirmRule(id) }; }
  catch (err) { return { enabled: true, ok: false, reason: err.message }; }
}

/** Phase 22 — dismiss a proposed cron rule. */
function dismissCronRule(id) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try { return { enabled: true, ...deviceSchedule().dismissRule(id) }; }
  catch (err) { return { enabled: true, ok: false, reason: err.message }; }
}

/** Phase 22 — remove a confirmed (persisted) cron rule. */
function removeCronRule(id) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  try { return { enabled: true, ...deviceSchedule().removeConfirmedRule(id) }; }
  catch (err) { return { enabled: true, ok: false, reason: err.message }; }
}

/**
 * Decide whether a physical action may proceed. First runs the DCP host-side
 * dry-run (capability scoping + param validation + power budget), then routes
 * through the gated proposeUpdate + pending/confirm system.
 *
 * @param {object} device
 * @param {string} action
 * @param {object} [params]
 * @returns {object} decision
 */
function isPhysicalActionAllowed(device, action, params = {}) {
  const P = policy();
  // DCP host-side rejection of malformed / out-of-scope / over-budget commands.
  const evalRes = P.evaluateCommand(device, action, params, {
    maxTotalPowerW: _powerBudgetW(),
    otherDevicesLoadW: _currentLoadW(device && device.id)
  });
  if (!evalRes.ok) {
    return { allowed: false, rejected: true, code: evalRes.code, reason: evalRes.reason, klass: device.class, power: evalRes.power };
  }
  const act = evalRes.normalized.action;
  const pol = evalRes.policy;
  const klass = pol.class;

  // Class C or read-only → allowed immediately.
  if (evalRes.readOnly || klass === 'C') {
    return { allowed: true, klass, reason: 'read-only', normalized: evalRes.normalized };
  }

  // Phase 12: additive per-device power SCHEDULE (time-boxed budget). Default-off
  // and can only ever RESTRICT actuation further — it never grants power and
  // never bypasses the class gate below. Read-only/Class C already returned above.
  try {
    const projectedDeviceW = policy().projectedDeviceLoadW(device, act, evalRes.normalized.params);
    const sres = powerSchedule().evaluate(device.id, projectedDeviceW);
    if (!sres.ok) {
      return {
        allowed: false, rejected: true, code: sres.code, reason: sres.reason, klass,
        schedule: { scheduleW: sres.scheduleW, projectedW: sres.projectedW }
      };
    }
  } catch { /* schedule is additive + best-effort; never blocks the safety chain */ }

  const sc = systemContext();

  // Class B (safe actuator) → gated proposeUpdate at high confidence → applies.
  if (klass === 'B') {
    sc.proposeUpdate(`cap.peripheral.${device.id}.lastAction`, act, { source: 'hook', confidence: 0.95 });
    return { allowed: true, klass, reason: 'safe-actuator-gated', normalized: evalRes.normalized };
  }

  // Class A (high-risk) → require a CONFIRMED guard authorization for this action.
  const authKey = _authKey(device);
  const authorized = sc.getInstance().get(authKey);
  if (authorized === act) {
    return { allowed: true, klass, reason: 'confirmed', normalized: evalRes.normalized, authKey };
  }
  // Not authorized → propose to a guard.* key at LOW confidence with a TTL so it
  // queues for human confirmation and auto-expires. Never auto-applies.
  const ttl = pol.confirmationTtlSec > 0 ? pol.confirmationTtlSec : undefined;
  sc.proposeUpdate(authKey, act, { source: 'system', confidence: 0.5, ttl });
  _emit({ type: 'pending-confirmation', id: device.id, action: act, confirmKey: authKey, ttlSec: ttl });
  return { allowed: false, pending: true, confirmKey: authKey, klass, reason: 'confirmation-required', normalized: evalRes.normalized };
}

/**
 * Execute an action on a device (DCP-validated + safety gated + driver-dispatched).
 * @param {string} id
 * @param {string} action
 * @param {object} [params]
 * @returns {object}
 */
function execute(id, action, params = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  const device = registry().get(id);
  if (!device) return { enabled: true, ok: false, reason: 'device-not-found' };

  const decision = isPhysicalActionAllowed(device, action, params);
  if (!decision.allowed) {
    _emit({ type: 'blocked', id, action, code: decision.code, confirmKey: decision.confirmKey });
    return {
      enabled: true, ok: false, pending: !!decision.pending, rejected: !!decision.rejected,
      code: decision.code, confirmKey: decision.confirmKey, klass: decision.klass, reason: decision.reason,
      power: decision.power, schedule: decision.schedule
    };
  }

  const drv = driverFor(device);

  // Phase 21: cross-host coordination gate. In CLUSTER mode (LIKU_CLUSTER_DIR
  // set) a REMOTE device may only be driven by the node that holds its lease —
  // this prevents two fleet nodes from actuating the same device concurrently.
  // Single-machine (default) → clusterEnabled() is false → completely inert.
  if (drv && drv.REMOTE && !isHilEnabled()) {
    try {
      const coord = coordination();
      if (coord.clusterEnabled() && !coord.canAct(`device:${id}`)) {
        const holder = coord.whoHolds(`device:${id}`);
        _emit({ type: 'blocked', id, action, code: 'device-leased-elsewhere' });
        return { enabled: true, ok: false, rejected: true, code: 'device-leased-elsewhere', klass: decision.klass, reason: `device leased by another node${holder ? ` (${holder.nodeId})` : ''}` };
      }
    } catch { /* coordination is best-effort + non-fatal */ }
  }

  // Phase 18: token revocation gate. A REMOTE driver must REFUSE to send a
  // command for a device whose capability token has been revoked (via unpair or
  // explicit revocation) — the human must re-pair to restore it. HIL is isolated
  // (virtual pairing never revokes), and connectionless/local drivers are exempt.
  if (drv && drv.REMOTE && !isHilEnabled()) {
    try {
      const ts = tokenStore();
      // Lazy scheduled rotation: rotate the device's token if its interval elapsed
      // (bounded, best-effort). The grace window keeps just-signed commands valid.
      try { ts.rotateIfDue(id); } catch { /* non-fatal */ }
      if (ts.isRevoked(id)) {
        _emit({ type: 'blocked', id, action, code: 'token-revoked' });
        return { enabled: true, ok: false, rejected: true, code: 'token-revoked', klass: decision.klass, reason: 'device token revoked — re-pair to restore' };
      }
    } catch { /* revocation check is best-effort */ }
  }

  const result = drv.perform(device, decision.normalized.action, decision.normalized.params);
  if (result.ok && result.state) registry().updateState(id, result.state);

  // Phase 26: LEASE RENEWAL ON EXECUTE. A successful actuation on a REMOTE device
  // renews (or claims) the `device:<id>` lease so ownership stays alive during
  // active control — a device under continuous use never silently expires to
  // another node. Single-machine / HIL → inert.
  if (result.ok && drv && drv.REMOTE && !isHilEnabled()) {
    try {
      const coord = coordination();
      if (coord.clusterEnabled()) coord.renewLease(`device:${id}`, { ttlMs: _deviceLeaseTtlMs() });
    } catch { /* lease renewal is best-effort + non-fatal */ }
  }

  // Class A one-shot: consume the authorization after a successful use so each
  // confirmation grants exactly one action (TTL is the time-based backstop).
  if (decision.klass === 'A' && result.ok && decision.authKey) {
    try { systemContext().pruneKey(decision.authKey); } catch { /* non-fatal */ }
  }

  // Phase 12: capture a power-history sample whenever an actuation changes state.
  if (result.ok) { try { recordPowerSample(); } catch { /* observation only */ } }

  _emit({ type: 'action', id, action: decision.normalized.action, klass: decision.klass, result });
  return { enabled: true, ok: result.ok, klass: decision.klass, result, reason: result.reason };
}

/**
 * Convenience: grant a Class A authorization (wraps the system-context confirm
 * flow). The human running this command IS the confirmation act. Returns the
 * granted auth + its TTL; the action itself is still performed via execute().
 * @param {string} id
 * @param {string} action
 * @returns {object}
 */
function authorize(id, action) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  const device = registry().get(id);
  if (!device) return { enabled: true, ok: false, reason: 'device-not-found' };

  const P = policy();
  const evalRes = P.evaluateCommand(device, action, {}, {
    maxTotalPowerW: _powerBudgetW(),
    otherDevicesLoadW: _currentLoadW(device && device.id)
  });
  if (!evalRes.ok) return { enabled: true, ok: false, code: evalRes.code, reason: evalRes.reason };

  const act = evalRes.normalized.action;
  if (device.class !== 'A') {
    return { enabled: true, ok: true, granted: true, klass: device.class, reason: 'no-confirmation-required' };
  }
  const sc = systemContext();
  const authKey = _authKey(device);
  const ttl = evalRes.policy.confirmationTtlSec > 0 ? evalRes.policy.confirmationTtlSec : undefined;
  // Queue a fresh authorization for THIS action, then confirm it.
  sc.proposeUpdate(authKey, act, { source: 'system', confidence: 0.5, ttl });
  const res = sc.confirmPending(authKey, 'apply');
  return { enabled: true, ok: !!res.ok, granted: !!res.ok, authKey, action: act, ttlSec: ttl, klass: 'A' };
}

/**
 * Ingest an inbound sensor reading (event-driven). Real drivers call this on
 * incoming messages; it updates last-known state (read-only) and emits a
 * 'reading' event that the PeripheralMonitor consumes.
 * @param {string} id
 * @param {object} metrics
 * @returns {object}
 */
function ingestSensorReading(id, metrics = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  const device = registry().get(id);
  if (!device) return { enabled: true, ok: false, reason: 'device-not-found' };
  const patch = {};
  for (const [k, v] of Object.entries(metrics || {})) {
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') patch[k] = v;
  }
  registry().updateState(id, patch);
  const reading = { type: 'reading', id, klass: device.class, metrics: patch, at: new Date().toISOString() };
  _emit(reading);
  return { enabled: true, ok: true, reading };
}

/**
 * Start real-driver event streams (drivers push readings via ingestSensorReading).
 * Returns a stop() that tears down all streams. No-op when disabled.
 * @returns {() => void}
 */
function startStreaming() {
  if (!isPeripheralsEnabled()) return () => {};
  const stops = [];
  for (const d of availableDrivers()) {
    if (typeof d.start === 'function') {
      try { stops.push(d.start((reading) => ingestSensorReading(reading.id, reading.metrics))); } catch { /* non-fatal */ }
    }
  }
  return () => { for (const s of stops) { try { s(); } catch { /* ignore */ } } };
}

/**
 * Subscribe to ALL device events. Returns an unsubscribe function.
 * @param {(event:object)=>void} cb
 * @returns {() => void}
 */
function subscribe(cb) {
  if (!isPeripheralsEnabled() || typeof cb !== 'function') return () => {};
  _bus.on('event', cb);
  return () => _bus.off('event', cb);
}

/**
 * Subscribe to a specific event type ('reading' | 'action' | 'blocked' |
 * 'pending-confirmation' | 'scan'). Returns an unsubscribe function.
 * @param {string} eventType
 * @param {(event:object)=>void} cb
 * @returns {() => void}
 */
function on(eventType, cb) {
  if (!isPeripheralsEnabled() || typeof cb !== 'function') return () => {};
  _bus.on(eventType, cb);
  return () => _bus.off(eventType, cb);
}

module.exports = {
  FLAG,
  isPeripheralsEnabled,
  scan,
  get,
  list,
  listDrivers,
  execute,
  authorize,
  ingestSensorReading,
  startStreaming,
  subscribe,
  on,
  isPhysicalActionAllowed,
  powerStatus,
  recordPowerSample,
  getPowerHistory,
  getPowerTrend,
  getPowerSchedules,
  getPowerAnomalies,
  getPowerForecast,
  getForecastWarnings,
  pairDevice,
  commissionDevice,
  getCommissionableDevices,
  unpairDevice,
  getPairingStatus,
  getTokenStatus,
  rotateToken,
  revokeToken,
  getScheduleSuggestions,
  confirmScheduleSuggestion,
  dismissScheduleSuggestion,
  getAnomalyActions,
  confirmAnomalyAction,
  dismissAnomalyAction,
  getAutoHealPolicies,
  setAutoHealPolicy,
  rebalanceClusterTasks,
  getExpiringSchedules,
  getDeescalations,
  autoClearRecovered,
  getSelfHealStatus,
  getSelfHealHealth,
  getDeescalationHistory,
  getDeescalationState,
  publishNodeHealth,
  deriveNodeHealth,
  publishDerivedNodeHealth,
  getDeescalationTrends,
  getDeescalationRollup,
  getDeescalationFlapping,
  getClusterTickHealth,
  getFleetObservability,
  getFleetSnapshot,
  getFleetSnapshotTrends,
  getLockClusterTrends,
  issueActionToken,
  verifyDeviceToken,
  rotateAllTokens,
  rotateActionToken,
  rotateDeviceIdentity,
  getSeasonalForecast,
  getDeviceForecastWarnings,
  getMultiDayForecast,
  getWeeklyProfile,
  getMultiHourProposal,
  getSpecialDays,
  sweepCluster,
  getClusterAnomalies,
  getClusterTasks,
  getClusterNotifications,
  updateClusterTaskStatus,
  getConfirmedSchedules,
  removeConfirmedSchedule,
  claimClusterTask,
  releaseClusterTask,
  getClusterTaskOwner,
  assignClusterTask,
  handoffClusterTask,
  getClusterTaskAssignment,
  getMyClusterAssignments,
  renewClusterTaskClaim,
  createTimeBoxedSchedule,
  sweepExpiredSchedules,
  getLockHistory,
  recordLockSnapshot,
  getLockTrends,
  getLockFileTrends,
  getLockAlerts,
  getClusterLockMetrics,
  getCoordinationStatus,
  acquireDeviceLease,
  releaseDeviceLease,
  getCronSchedules,
  getDueCronTasks,
  proposeCronRule,
  getProposedCronRules,
  confirmCronRule,
  dismissCronRule,
  removeCronRule,
  isHilEnabled
};

