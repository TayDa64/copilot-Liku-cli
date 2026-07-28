/**
 * Self-Healing Scheduler — a low-frequency periodic tick that runs the existing
 * OPERATIONAL POLISH actions automatically (Pillar 3, Phase 31).
 *
 * Phases 29–30 added task-inbox rebalancing, schedule-expiry notifications, and
 * recovery de-escalation, but each had to be invoked on demand (CLI / external
 * scheduler). This consumer wires them into ONE bounded, best-effort tick so a
 * running system keeps itself tidy without manual intervention:
 *
 *   tick(now)
 *     → cluster-tasks.rebalance()              (advisory reassign of stale tasks)
 *     → scheduleExpiryNotifier.tick()          (surface lapsing caps as tasks)
 *     → anomaly-action-advisor.proposeDeescalations()  (recovery step-downs)
 *     → anomaly-action-advisor.autoClearRecovered()    (opt-in safe advisory clear)
 *
 * SAFETY CONTRACT (non-negotiable):
 *   - EVERY sub-action is already advisory / human-gated / pure-observation. This
 *     scheduler ONLY invokes them on a cadence — it introduces NO new actuation
 *     path, NEVER calls the LLM, and NEVER confirms a proposal on a human's behalf.
 *   - TIMER-FREE by default: `tick(now)` is called on demand. An optional interval
 *     is available but OFF unless requested, and its timer is unref'd so it never
 *     keeps the process alive.
 *   - Best-effort + non-blocking: each sub-action is wrapped so one failing step
 *     never aborts the others. Strictly feature-flag gated (LIKU_ENABLE_PERIPHERALS).
 *   - Cluster-aware pieces (rebalance) stay inert single-machine; the single-machine
 *     path is byte-compatible.
 *
 * Config:
 *   LIKU_PERIPHERAL_SELF_HEAL_INTERVAL_MS  optional background tick interval (off by default)
 */

'use strict';

const { AgentRole } = require('./base-agent');

const DEFAULT_INTERVAL_MS = 300000; // 5 min production cadence (when the flag is on)

/**
 * Resolve the background tick interval (ms), or 0 for OFF. Precedence: explicit
 * `options.intervalMs` → `LIKU_PERIPHERAL_SELF_HEAL_INTERVAL_MS` → a default
 * production cadence when `LIKU_PERIPHERAL_SELF_HEAL=1` → OFF. Default is OFF
 * (timer-free) so single-machine + tests are unaffected unless opted in. @private
 */
function _resolveIntervalMs(options) {
  if (options && Number.isFinite(Number(options.intervalMs)) && Number(options.intervalMs) > 0) return Number(options.intervalMs);
  const env = Number(process.env.LIKU_PERIPHERAL_SELF_HEAL_INTERVAL_MS);
  if (Number.isFinite(env) && env > 0) return env;
  if (String(process.env.LIKU_PERIPHERAL_SELF_HEAL || '').trim() === '1') return DEFAULT_INTERVAL_MS;
  return 0;
}

/** Stale-gap threshold for the tick-health advisory (ms). @private */
function _staleThresholdMs() {
  const v = Number(process.env.LIKU_PERIPHERAL_SELF_HEAL_STALE_MS);
  return Number.isFinite(v) && v > 0 ? v : 900000; // 15 min
}

/** Whether a stalled tick should ALSO surface a human-gated Supervisor task (default OFF). @private */
function _tickHealthTasksEnabled(options) {
  if (options && options.tickHealthTasks === true) return true;
  return String(process.env.LIKU_PERIPHERAL_SELF_HEAL_TICK_HEALTH_TASKS || '').trim() === '1';
}

/** Whether a recovery (healthy tick after a stall) should auto-clear the tick-health task (default OFF). @private */
function _tickHealthAutoClearEnabled(options) {
  if (options && options.tickHealthAutoClear === true) return true;
  return String(process.env.LIKU_PERIPHERAL_SELF_HEAL_TICK_HEALTH_AUTOCLEAR || '').trim() === '1';
}

/** Whether the tick should auto-derive + publish this node's health each cadence (default OFF). @private */
function _nodeHealthAutoEnabled(options) {
  if (options && options.nodeHealthAuto === true) return true;
  return String(process.env.LIKU_PERIPHERAL_NODE_HEALTH_AUTO || '').trim() === '1';
}

/** Whether flapping de-escalation devices should surface a human-gated advisory task (default OFF). @private */
function _flapAlertsEnabled(options) {
  if (options && options.flapAlerts === true) return true;
  return String(process.env.LIKU_PERIPHERAL_DEESC_FLAP_ALERTS || '').trim() === '1';
}

/**
 * Phase 36 — build a bounded, ADVISORY notification for a FLAPPING device (its
 * de-escalation posture is oscillating). Class C synthetic device, `requiresHuman`
 * true (a human should review why it keeps stepping back) but `autonomousAction`
 * false — it NEVER actuates and never changes de-escalation behaviour.
 */
function buildFlappingNotification(deviceId, info = {}) {
  const n = Number(info.recentStepBacks) || 0;
  return {
    id: `deesc-flap-${deviceId}-${Date.now()}`,
    at: new Date().toISOString(),
    source: 'self-heal',
    kind: 'deescalation-flapping',
    device: { id: deviceId, class: 'C', kind: 'health' },
    breach: { metric: 'deescalation-flapping', level: 'flapping', value: n, threshold: Number(info.threshold) || null },
    severity: 'warning',
    advisory: `${deviceId} is flapping: ${n} step-backs in the recent window — review its heal posture`,
    requiresHuman: true,
    autonomousAction: false,
    safety: 'physical-actions-require-pal-gating',
    anomalyType: null,
    dedupeKey: `${deviceId}:deescalation:flapping`
  };
}

/**
 * Phase 34 — build a bounded, ADVISORY notification for a stalled self-heal tick.
 * Shaped like a peripheral alert so it reuses the Supervisor's task machinery
 * (dedupe/coalesce/cooldown) with NO actuation surface. The stall is a health
 * signal, not a device event: `requiresHuman:false`, `autonomousAction:false`, and
 * a synthetic read-only (Class C) device so nothing can ever be actuated from it.
 */
function buildTickHealthNotification(ev) {
  const e = ev || {};
  const gapMs = Number(e.gapMs) || 0;
  return {
    id: `self-heal-health-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    source: 'self-heal',
    kind: 'tick-health',
    device: { id: 'self-heal', class: 'C', kind: 'health' },
    breach: { metric: 'tick-health', level: 'stale', value: gapMs, threshold: Number(e.staleMs) || null },
    severity: 'warning',
    advisory: e.advisory || `self-heal tick stalled for ${Math.round(gapMs / 1000)}s`,
    requiresHuman: false,
    autonomousAction: false,
    safety: 'physical-actions-require-pal-gating',
    anomalyType: null,
    dedupeKey: 'self-heal:tick-health'
  };
}

/**
 * Attach a self-healing scheduler to an orchestrator. Returns a `tick(now)` you
 * invoke (CLI / external scheduler) to run one operational-polish pass.
 * @param {object} orchestrator EventEmitter with an `agents` map.
 * @param {object} [options]
 * @param {object} [options.pal] Override the PAL module (tests).
 * @param {object} [options.actionAdvisor] Override the anomaly-action-advisor (tests).
 * @param {(now?:number)=>object} [options.scheduleExpiryTick] The expiry notifier's tick fn.
 * @param {() => number} [options.now] Injectable clock (tests).
 * @param {number} [options.intervalMs] OPTIONAL background tick interval (off by default).
 * @returns {{ tick:(now?:Date|number)=>object, detach:()=>void }}
 */
function attachSelfHealingScheduler(orchestrator, options = {}) {
  if (!orchestrator || typeof orchestrator.on !== 'function') {
    return { tick: () => ({ ran: false }), detach: () => {} };
  }
  const pal = options.pal || require('../peripherals/peripheral-abstraction-layer');
  const actionAdvisor = options.actionAdvisor || require('../peripherals/anomaly-action-advisor');
  const scheduleExpiryTick = typeof options.scheduleExpiryTick === 'function' ? options.scheduleExpiryTick : null;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const statusStore = options.statusStore || require('../peripherals/self-heal-status');
  const getSupervisor = typeof options.getSupervisor === 'function'
    ? options.getSupervisor
    : () => (orchestrator.agents && typeof orchestrator.agents.get === 'function'
        ? orchestrator.agents.get(AgentRole.SUPERVISOR)
        : null);
  let _lastRun = null;

  function _enabled() {
    if (pal && typeof pal.isPeripheralsEnabled === 'function') { try { return !!pal.isPeripheralsEnabled(); } catch { /* fall through */ } }
    return String(process.env.LIKU_ENABLE_PERIPHERALS || '').trim() === '1';
  }

  function tick(when) {
    if (!_enabled()) return { ran: false };
    const at = when instanceof Date ? when.getTime() : (Number.isFinite(when) ? when : now());
    // Phase 33: TICK-HEALTH — detect a STALL gap (the interval was late / stopped)
    // by comparing this run to the persisted previous run. Advisory only.
    let prevAt = null;
    let prevStalled = false;
    try { const prev = statusStore.read(); if (prev) { if (prev.lastRun && prev.lastRun.at) prevAt = Date.parse(prev.lastRun.at); prevStalled = !!prev.stalled; } } catch { /* best-effort */ }
    const result = { ran: true, at, rebalanced: [], expiryTasks: 0, deescalations: [], autoCleared: [] };
    // Per-step timings (Phase 32 observability). PURE measurement — reading the
    // clock never changes what a step does. Wall-clock ms per step.
    const timings = { rebalance: 0, expiry: 0, deescalation: 0, autoClear: 0 };
    const started = Date.now();
    // 1) Task inbox rebalancing (advisory; inert single-machine).
    let s = Date.now();
    try { const rb = pal.rebalanceClusterTasks({ now: at }); result.rebalanced = (rb && rb.rebalanced) || []; }
    catch { /* best-effort */ }
    timings.rebalance = Date.now() - s;
    // 2) Schedule-expiry notifications (advisory human-gated tasks; never extends).
    s = Date.now();
    if (scheduleExpiryTick) {
      try { const ex = scheduleExpiryTick(at); result.expiryTasks = (ex && Array.isArray(ex.created)) ? ex.created.length : 0; }
      catch { /* best-effort */ }
    }
    timings.expiry = Date.now() - s;
    // 3) Recovery de-escalation proposals (human-gated step-downs).
    s = Date.now();
    try {
      const de = actionAdvisor.proposeDeescalations({}, at) || [];
      result.deescalations = de;
      for (const d of de) { try { orchestrator.emit('supervisor:deescalation', d); } catch { /* non-fatal */ } }
    } catch { /* best-effort */ }
    timings.deescalation = Date.now() - s;
    // 4) Opt-in SAFE auto-clear of purely-advisory suggestions (never a restriction).
    s = Date.now();
    try { const ac = actionAdvisor.autoClearRecovered({}, at); result.autoCleared = (ac && ac.cleared) || []; }
    catch { /* best-effort */ }
    timings.autoClear = Date.now() - s;
    result.timings = timings;
    result.durationMs = Date.now() - started;
    // Phase 35: determine the stall state of THIS run BEFORE persisting it, so the
    // recovery detector can compare the previous run's stall flag on the next tick.
    const gapMs = prevAt != null ? (at - prevAt) : null;
    const staleMs = _staleThresholdMs();
    const isStalledNow = gapMs != null && gapMs > staleMs;
    // Phase 32: record last-run observability (best-effort, pure observation).
    _lastRun = {
      at: new Date(at).toISOString(), durationMs: result.durationMs, timings,
      counts: { rebalanced: result.rebalanced.length, expiryTasks: result.expiryTasks, deescalations: result.deescalations.length, autoCleared: result.autoCleared.length },
      stalled: isStalledNow
    };
    try { statusStore.record(_lastRun); } catch { /* observability is best-effort */ }
    // Phase 33/34: on a STALL, emit an ADVISORY tick-health signal + (optional)
    // human-gated Supervisor task. Never actuates.
    if (isStalledNow) {
      result.tickHealth = { wasStale: true, gapMs, staleMs };
      const ev = { source: 'self-heal', kind: 'tick-health', advisory: `self-heal tick resumed after ${Math.round(gapMs / 1000)}s stall`, gapMs, staleMs, requiresHuman: false, autonomousAction: false };
      try { orchestrator.emit('self-heal:tick-health', ev); } catch { /* non-fatal */ }
      // Phase 36: mirror this node's STALLED state to the cluster (pure observation).
      try { require('../peripherals/cluster-tasks').publishTickHealth(true, { now: at }); } catch { /* non-fatal */ }
      // Phase 34: OPTIONALLY surface the stall as a bounded, human-gated Supervisor
      // task/notification (default OFF). Reuses the Supervisor's own dedupe/coalesce
      // + cooldown (dedupeKey 'self-heal:tick-health') — no new spam control. Strictly
      // advisory: the notification is a Class C health signal that NEVER actuates.
      if (_tickHealthTasksEnabled(options)) {
        try {
          const notification = buildTickHealthNotification(ev);
          const supervisor = getSupervisor();
          if (supervisor && typeof supervisor.receiveNotification === 'function') { try { supervisor.receiveNotification(notification); } catch { /* non-fatal */ } }
          try { orchestrator.emit('supervisor:notification', notification); } catch { /* non-fatal */ }
          try { require('../peripherals/cluster-tasks').publishNotification(notification); } catch { /* non-fatal */ }
          let task = null;
          if (supervisor && typeof supervisor.createPeripheralTask === 'function') task = supervisor.createPeripheralTask(notification, { source: 'self-heal' });
          if (task) {
            result.tickHealthTask = task;
            try { orchestrator.emit('supervisor:task', task); } catch { /* non-fatal */ }
            try { orchestrator.emit('self-heal:tick-health-task', task); } catch { /* non-fatal */ }
            try { require('../peripherals/cluster-tasks').publishTask(task); } catch { /* non-fatal */ }
          }
        } catch { /* best-effort */ }
      }
    } else if (prevStalled) {
      // Phase 35/36: RECOVERY — a healthy tick ran after a stall. Optionally auto-clear
      // (resolve) the advisory tick-health task AND acknowledge its notification so a
      // stale stall warning does not linger, and mirror the RECOVERED state to the
      // cluster. STRICTLY scoped to the tick-health path (device.id / source 'self-heal')
      // — it never touches any other task/notification type and never actuates.
      result.tickHealthRecovered = true;
      try { orchestrator.emit('self-heal:tick-health-recovered', { source: 'self-heal', kind: 'tick-health', advisory: 'self-heal tick recovered', requiresHuman: false, autonomousAction: false }); } catch { /* non-fatal */ }
      // Phase 36: mirror the RECOVERED state to the cluster (pure observation).
      try { require('../peripherals/cluster-tasks').publishTickHealth(false, { now: at }); } catch { /* non-fatal */ }
      if (_tickHealthAutoClearEnabled(options)) {
        try {
          const supervisor = getSupervisor();
          const resolved = [];
          const acked = [];
          if (supervisor && typeof supervisor.getPeripheralTasks === 'function' && typeof supervisor.resolvePeripheralTask === 'function') {
            for (const t of supervisor.getPeripheralTasks()) {
              if (t && t.device && t.device.id === 'self-heal' && t.status === 'pending-review') {
                supervisor.resolvePeripheralTask(t.id, 'acknowledged');
                resolved.push(t.id);
                try { require('../peripherals/cluster-tasks').updateTaskStatus(t.id, 'acknowledged'); } catch { /* non-fatal */ }
              }
            }
          }
          // Phase 36: also ACKNOWLEDGE the corresponding tick-health notification.
          if (supervisor && typeof supervisor.getNotifications === 'function' && typeof supervisor.acknowledgeNotification === 'function') {
            for (const n of supervisor.getNotifications()) {
              if (n && n.source === 'self-heal' && n.kind === 'tick-health' && !n.acknowledged) {
                supervisor.acknowledgeNotification(n.id);
                acked.push(n.id);
              }
            }
          }
          result.tickHealthCleared = resolved;
          result.tickHealthAcked = acked;
        } catch { /* best-effort */ }
      }
    }
    // Phase 36: OPTIONALLY surface FLAPPING de-escalation devices as bounded,
    // human-gated advisory tasks (default OFF). Pure observation of the de-escalation
    // history → the existing task pipeline. NEVER changes de-escalation behaviour.
    if (_flapAlertsEnabled(options)) {
      try {
        const hist = require('../peripherals/deescalation-history');
        const flap = hist.flapping({ now: at });
        result.flapping = flap.devices || [];
        if ((flap.devices || []).length) {
          const supervisor = getSupervisor();
          const flapTasks = [];
          for (const d of flap.devices) {
            const notification = buildFlappingNotification(d.deviceId, { recentStepBacks: d.recentStepBacks, threshold: flap.threshold });
            if (supervisor && typeof supervisor.receiveNotification === 'function') { try { supervisor.receiveNotification(notification); } catch { /* non-fatal */ } }
            try { orchestrator.emit('supervisor:notification', notification); } catch { /* non-fatal */ }
            try { require('../peripherals/cluster-tasks').publishNotification(notification); } catch { /* non-fatal */ }
            let task = null;
            if (supervisor && typeof supervisor.createPeripheralTask === 'function') task = supervisor.createPeripheralTask(notification, { source: 'self-heal-flapping' });
            if (task) { flapTasks.push(task); try { orchestrator.emit('supervisor:task', task); } catch { /* non-fatal */ } try { orchestrator.emit('self-heal:flapping-task', task); } catch { /* non-fatal */ } }
          }
          if (flapTasks.length) result.flappingTasks = flapTasks;
        }
      } catch { /* best-effort */ }
    }
    // Phase 35: OPTIONALLY auto-derive + publish this node's health each cadence
    // (default OFF) so peers can weight it into fairness rebalancing. Pure
    // observation of local operational metrics → shared store. Best-effort.
    if (_nodeHealthAutoEnabled(options)) {
      try { const r = require('../peripherals/cluster-tasks').publishDerivedNodeHealth({ now: at }); if (r) result.nodeHealth = r.score; } catch { /* best-effort */ }
    }
    if (typeof options.onTick === 'function') { try { options.onTick(result); } catch { /* non-fatal */ } }
    return result;
  }

  let timer = null;
  const intervalMs = _resolveIntervalMs(options);
  if (intervalMs > 0) {
    timer = setInterval(() => { try { tick(); } catch { /* best-effort */ } }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref(); // never keep the process alive
  }

  return {
    tick,
    intervalMs,
    getLastRun() { return _lastRun; },
    getHealth(opts) { try { return statusStore.health(opts); } catch { return { ran: false, stale: false }; } },
    detach() { if (timer) { clearInterval(timer); timer = null; } }
  };
}

module.exports = { attachSelfHealingScheduler, buildTickHealthNotification, buildFlappingNotification };
