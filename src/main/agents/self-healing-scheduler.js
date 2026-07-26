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
  let _lastRun = null;

  function _enabled() {
    if (pal && typeof pal.isPeripheralsEnabled === 'function') { try { return !!pal.isPeripheralsEnabled(); } catch { /* fall through */ } }
    return String(process.env.LIKU_ENABLE_PERIPHERALS || '').trim() === '1';
  }

  function tick(when) {
    if (!_enabled()) return { ran: false };
    const at = when instanceof Date ? when.getTime() : (Number.isFinite(when) ? when : now());
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
    // Phase 32: record last-run observability (best-effort, pure observation).
    _lastRun = {
      at: new Date(at).toISOString(), durationMs: result.durationMs, timings,
      counts: { rebalanced: result.rebalanced.length, expiryTasks: result.expiryTasks, deescalations: result.deescalations.length, autoCleared: result.autoCleared.length }
    };
    try { statusStore.record(_lastRun); } catch { /* observability is best-effort */ }
    if (typeof options.onTick === 'function') { try { options.onTick(result); } catch { /* non-fatal */ } }
    return result;
  }

  let timer = null;
  const intervalMs = Number.isFinite(Number(options.intervalMs)) && Number(options.intervalMs) > 0
    ? Number(options.intervalMs)
    : (Number(process.env.LIKU_PERIPHERAL_SELF_HEAL_INTERVAL_MS) || 0);
  if (intervalMs > 0) {
    timer = setInterval(() => { try { tick(); } catch { /* best-effort */ } }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref(); // never keep the process alive
  }

  return {
    tick,
    getLastRun() { return _lastRun; },
    detach() { if (timer) { clearInterval(timer); timer = null; } }
  };
}

module.exports = { attachSelfHealingScheduler };
