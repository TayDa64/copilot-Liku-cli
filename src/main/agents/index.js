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

    // Return object with orchestrator, stateManager, and peripheral integration
    return { orchestrator, stateManager, traceWriter, peripheralMonitor, peripheralAlertConsumer, powerAnomalyConsumer, cronScheduler };
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
