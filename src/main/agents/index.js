/**
 * Multi-Agent System for Copilot-Liku CLI
 * 
 * Architecture: Supervisor-Builder-Verifier with Recursive Long-Context support
 * Based on RLM-inspired agent patterns for comprehensive task handling.
 * 
 * Agents:
 * - Supervisor: Orchestrates and decomposes tasks
 * - Builder: Implements code changes with minimal diffs
 * - Verifier: Validates changes with phased verification
 * - Researcher: Gathers context and information (optional)
 */

const { AgentOrchestrator } = require('./orchestrator');
const { SupervisorAgent } = require('./supervisor');
const { BuilderAgent } = require('./builder');
const { VerifierAgent } = require('./verifier');
const { ProducerAgent } = require('./producer');
const { ResearcherAgent } = require('./researcher');
const { PeripheralMonitorAgent, attachPeripheralMonitor } = require('./peripheral-monitor-agent');
const { attachPeripheralAlertConsumer, buildSupervisorNotification } = require('./peripheral-alert-consumer');
const { attachPowerAnomalyConsumer, buildAnomalyNotification } = require('./power-anomaly-consumer');
const { attachCronScheduler } = require('./cron-scheduler');
const { attachScheduleExpiryNotifier, buildExpiryNotification } = require('./schedule-expiry-notifier');
const { attachSelfHealingScheduler, buildTickHealthNotification } = require('./self-healing-scheduler');
const { AgentStateManager } = require('./state-manager');
const { TraceWriter } = require('./trace-writer');

module.exports = {
  AgentOrchestrator,
  SupervisorAgent,
  BuilderAgent,
  VerifierAgent,
  ProducerAgent,
  ResearcherAgent,
  PeripheralMonitorAgent,
  attachPeripheralMonitor,
  attachPeripheralAlertConsumer,
  buildSupervisorNotification,
  attachPowerAnomalyConsumer,
  buildAnomalyNotification,
  attachCronScheduler,
  attachScheduleExpiryNotifier,
  buildExpiryNotification,
  attachSelfHealingScheduler,
  buildTickHealthNotification,
  AgentStateManager,
  TraceWriter,
  
  // Factory function for creating configured orchestrator
  createAgentSystem: (aiService, options = {}) => {
    const stateManager = new AgentStateManager(options.statePath);
    
    const modelMetadata = aiService?.getModelMetadata?.() || null;
    
    if (modelMetadata) {
      stateManager.setModelMetadata(modelMetadata);
    }
    
    const orchestrator = new AgentOrchestrator({
      stateManager,
      aiService: aiService,
      maxRecursionDepth: options.maxRecursionDepth || 3,
      maxSubCalls: options.maxSubCalls || 10,
      enableLongContext: options.enableLongContext !== false,
      // Phase 9: persist peripheral tasks/notifications by default (durable across
      // restarts). Flag-gated at the store level, so inert unless peripherals on.
      persistPeripheralTasks: options.persistPeripheralTasks !== false,
      // Phase 11: advanced escalation (advisory + human-gated). Default to
      // env-based config; explicit options override.
      autoAckSeverities: options.autoAckSeverities,
      taskCooldownMs: options.taskCooldownMs,
      modelMetadata
    });
    
    // Attach persistent flight recorder
    const traceWriter = new TraceWriter(orchestrator);

    // Pillar 3 (Phase 6): make the peripheral layer a first-class participant.
    // Best-effort + strictly feature-flag gated (attach → start() no-ops when
    // LIKU_ENABLE_PERIPHERALS is off). Fully decoupled: it only emits
    // 'peripheral:alert' events on the orchestrator; it never actuates hardware.
    let peripheralMonitor = null;
    let peripheralAlertConsumer = null;
    try {
      const attached = attachPeripheralMonitor(orchestrator, {
        thresholds: options.peripheralThresholds,
        cooldownMs: options.peripheralAlertCooldownMs,
        hysteresisFraction: options.peripheralHysteresisFraction
      });
      peripheralMonitor = attached.agent;

      // Pillar 3 (Phase 7): CLOSE THE LOOP. Consume 'peripheral:alert' events and
      // inject a bounded, human-gated notification into the Supervisor workflow.
      // Advisory-only: nothing is auto-actuated; any physical response a human
      // approves still flows through the PAL (DCP → class gate → pending/confirm).
      peripheralAlertConsumer = attachPeripheralAlertConsumer(orchestrator, {
        onNotification: options.onPeripheralNotification,
        createTasks: options.createPeripheralTasks
      });
    } catch { /* peripheral integration is best-effort */ }

    // Pillar 3 (Phase 14): bridge advisory `power-anomaly` events (spike /
    // sustained / over-budget from the rolling power history) into the SAME
    // human-gated escalation pipeline, with consumer-level dedup + cooldown.
    // Strictly advisory — never actuates; any physical response still flows
    // through the PAL. Inert unless peripherals are enabled.
    let powerAnomalyConsumer = null;
    try {
      powerAnomalyConsumer = attachPowerAnomalyConsumer(orchestrator, {
        onAnomaly: options.onPowerAnomaly,
        createTasks: options.createPowerAnomalyTasks,
        cooldownMs: options.powerAnomalyCooldownMs
      });
    } catch { /* power-anomaly integration is best-effort */ }

    // Pillar 3 (Phase 22): cron scheduler consumer. Turns DUE cron device rules
    // into bounded, human-gated Supervisor tasks (dedupe + per-device cooldown).
    // TIMER-FREE by default — a caller invokes cronScheduler.tick(now). Strictly
    // advisory: a cron task never actuates; Class A stays confirm-gated.
    let cronScheduler = null;
    try {
      cronScheduler = attachCronScheduler(orchestrator, {
        cooldownMs: options.cronCooldownMs,
        intervalMs: options.cronIntervalMs // OFF unless explicitly provided
      });
    } catch { /* cron integration is best-effort */ }

    // Pillar 3 (Phase 30): schedule-expiry notifier. Surfaces UPCOMING or
    // JUST-EXPIRED time-boxed confirmed schedules as bounded, human-gated tasks
    // so an operator can re-confirm a lapsing restrict-only cap. TIMER-FREE by
    // default — a caller invokes scheduleExpiryNotifier.tick(now). Strictly
    // advisory: it NEVER re-creates or extends a schedule.
    let scheduleExpiryNotifier = null;
    try {
      scheduleExpiryNotifier = attachScheduleExpiryNotifier(orchestrator, {
        cooldownMs: options.scheduleExpiryCooldownMs,
        withinMs: options.scheduleExpiryWarnMs,
        graceMs: options.scheduleExpiryGraceMs,
        intervalMs: options.scheduleExpiryIntervalMs // OFF unless explicitly provided
      });
    } catch { /* schedule-expiry integration is best-effort */ }

    // Pillar 3 (Phase 31): self-healing scheduler. A single low-frequency tick that
    // runs the operational-polish actions (rebalance + schedule-expiry notify +
    // recovery de-escalation + opt-in safe auto-clear). TIMER-FREE by default — a
    // caller invokes selfHealingScheduler.tick(now). Strictly advisory: it only
    // invokes already-human-gated actions on a cadence; NO new actuation path.
    // Phase 33: PRODUCTION AUTO-START — when LIKU_PERIPHERAL_SELF_HEAL=1 (or an
    // explicit interval), the scheduler starts its own unref'd interval here so the
    // tick runs automatically with normal system startup (still best-effort, flag-gated).
    let selfHealingScheduler = null;
    try {
      selfHealingScheduler = attachSelfHealingScheduler(orchestrator, {
        scheduleExpiryTick: scheduleExpiryNotifier ? scheduleExpiryNotifier.tick : null,
        intervalMs: options.selfHealIntervalMs // else env LIKU_PERIPHERAL_SELF_HEAL_INTERVAL_MS / LIKU_PERIPHERAL_SELF_HEAL=1
      });
    } catch { /* self-healing integration is best-effort */ }

    // Return object with orchestrator, stateManager, and peripheral integration
    return { orchestrator, stateManager, traceWriter, peripheralMonitor, peripheralAlertConsumer, powerAnomalyConsumer, cronScheduler, scheduleExpiryNotifier, selfHealingScheduler };
  },
  
  // Recovery function for checkpoint restoration
  recoverFromCheckpoint: (checkpointId, options = {}) => {
    const stateManager = new AgentStateManager(options.statePath);
    const checkpoint = stateManager.getCheckpoint(checkpointId);
    
    if (!checkpoint) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }
    
    return checkpoint;
  }
};
