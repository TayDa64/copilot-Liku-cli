/**
 * Supervisor Agent
 * 
 * Orchestrates and decomposes tasks, manages handoffs to Builder/Verifier.
 * Does NOT edit files directly - delegates all implementation to Builder.
 * 
 * Operating Rules:
 * - Start with a short plan (2-5 steps)
 * - Decompose work into concrete file/symbol-level subtasks
 * - Delegate implementation to Builder, validation to Verifier
 * - Preserve existing behavior
 * - Never execute terminal commands or edit files
 */

const { BaseAgent, AgentRole, AgentCapabilities } = require('./base-agent');
const taskContracts = require('./task-contract');
const escalation = require('./escalation');
const { classifySignal } = require('./escalation-signals');
const executionFabric = require('./execution-fabric');
const executionScheduler = require('./execution-scheduler');

/**
 * Parse a comma-separated severity allow-list into a normalized Set. Used to
 * decide which severities may be auto-acknowledged. Empty by default.
 * @private
 */
function _parseSeverityList(raw) {
  if (Array.isArray(raw)) return new Set(raw.map((s) => String(s).trim().toLowerCase()).filter(Boolean));
  return new Set(
    String(raw || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * A notification/task is "critical" (never auto-acknowledged, never suppressed)
 * when it targets a Class A device, explicitly requires a human, or is tagged
 * critical/high. This is the hard safety floor for all escalation shortcuts.
 * @private
 */
function _isCritical(item) {
  if (!item) return false;
  if (item.requiresHuman === true) return true;
  if (item.device && item.device.class === 'A') return true;
  const sev = String(item.severity || item.priority || '').toLowerCase();
  return sev === 'critical' || sev === 'high';
}

class SupervisorAgent extends BaseAgent {
  constructor(options = {}) {
    super({
      ...options,
      role: AgentRole.SUPERVISOR,
      name: options.name || 'supervisor',
      description: 'Orchestrates tasks, decomposes plans, manages agent handoffs',
      capabilities: [
        AgentCapabilities.SEARCH,
        AgentCapabilities.READ,
        AgentCapabilities.WEB_FETCH,
        AgentCapabilities.TODO,
        AgentCapabilities.HANDOFF
      ]
    });
    
    // Supervisor-specific state
    this.currentPlan = null;
    this.decomposedTasks = [];
    this.assumptions = [];

    // Phase 7: bounded, human-gated inbox for peripheral (and other) alerts.
    // The Supervisor is NOTIFIED, never auto-driven — nothing here calls the LLM
    // or actuates hardware. Bounded to avoid overwhelming the workflow.
    this.notifications = [];
    this.maxNotifications = options.maxNotifications || 20;

    // Phase 8: bounded, human-gated TASKS derived from peripheral alerts. A task
    // is a reviewable work item (status 'pending-review') — it NEVER runs itself
    // and NEVER actuates hardware. Any action a human approves still flows
    // through PAL.execute() → DCP → class gate → pending/confirm.
    this.peripheralTasks = [];
    this.maxPeripheralTasks = options.maxPeripheralTasks || 5;

    // Phase 9: durable persistence (flag-gated). Restore any tasks/notifications
    // that survived a restart. The store is a no-op unless LIKU_ENABLE_PERIPHERALS
    // is set, so normal coding flows never touch disk and behaviour is unchanged.
    this._store = options.taskStore || require('./supervisor-task-store');
    this._persistEnabled = options.persistTasks === true;

    // Phase 11: advanced escalation — ALL advisory + human-gated, default OFF so
    // behaviour and the default cognitive fragment are unchanged.
    //  - notification channels: additive sinks (log/file/webhook) beyond the inbox.
    //  - auto-acknowledge: automatically resolve LOW-severity notifications/tasks so
    //    a human is not paged by routine, non-critical signals. Critical / Class A
    //    are NEVER auto-acknowledged.
    //  - task cooldown: suppress recreating a task for the same condition within a
    //    window after it was last active — flapping-sensor spam protection.
    this._channels = options.channels || require('./notification-channels');
    this._now = typeof options.now === 'function' ? options.now : () => Date.now();
    this._autoAckSeverities = _parseSeverityList(
      options.autoAckSeverities != null
        ? options.autoAckSeverities
        : process.env.LIKU_PERIPHERAL_AUTO_ACK_SEVERITIES
    );
    this._taskCooldownMs = Number.isFinite(Number(options.taskCooldownMs))
      ? Number(options.taskCooldownMs)
      : (Number(process.env.LIKU_PERIPHERAL_TASK_COOLDOWN_MS) || 0);
    this._taskCooldowns = new Map(); // dedupeKey → last-activity ms (flapping guard)
    try {
      if (this._persistEnabled && this._store.enabled && this._store.enabled()) {
        const restored = this._store.load();
        if (restored && Array.isArray(restored.notifications)) {
          this.notifications = restored.notifications.slice(-this.maxNotifications);
        }
        if (restored && Array.isArray(restored.tasks)) {
          this.peripheralTasks = restored.tasks.slice(-this.maxPeripheralTasks);
        }
      }
    } catch { /* restore is best-effort */ }
  }

  /** Persist notifications + tasks (flag-gated no-op otherwise). @private */
  _persistPeripheralState() {
    if (!this._persistEnabled || !this._store || !this._store.save) return;
    try { this._store.save({ notifications: this.notifications, tasks: this.peripheralTasks }); }
    catch { /* persistence is best-effort + non-fatal */ }
  }

  getSystemPrompt() {
    return `You are the SUPERVISOR agent in a multi-agent coding system.

# OPERATING CONTRACT (NON-NEGOTIABLE)
- **No guessing**: Probe or ground with tools (search, read).
- **Preserve functionalities**: Never disable core features.
- **Modularity**: Decompose into sub-modules.
- **Least privilege**: READ-ONLY access. Use Builder for any writes.
- **Recursion limits**: Depth ≤3; avoid >10 sub-calls without progress.
- **Security**: Audit all changes before approval.

# YOUR RESPONSIBILITIES
1. Analyze user requests and create 2-5 step plans
2. Decompose work into concrete file/symbol-level subtasks
3. Delegate implementation to Builder agent
4. Delegate validation to Verifier agent
5. Aggregate results and provide final summary

# WORKFLOW
1. Read state from agent_state.json before planning
2. Create plan with explicit assumptions
3. For each subtask:
   - If implementation needed: Handoff to Builder
   - If validation needed: Handoff to Verifier
4. Aggregate results and verify completeness
5. Update state with completed/failed tasks

# HANDOFF FORMAT
When handing off to Builder:
"Implement: [specific task]. Files: [file paths]. Constraints: [any limits]"

When handing off to Verifier:
"Verify: [what to check]. Changes: [summary of changes]. Tests: [required tests]"

# OUTPUT FORMAT
Always structure your response as:
1. Analysis: (what you understand about the task)
2. Plan: (numbered steps)
3. Assumptions: (what you're assuming)
4. Next Action: (handoff or completion)`;
  }

  async process(task, context = {}) {
    this.log('info', 'Supervisor processing task', { task: task.description || task });
    
    // Check recursion limits
    const limits = this.checkRecursionLimits();
    if (!limits.allowed) {
      return {
        success: false,
        error: limits.reason,
        suggestedAction: 'handoff_to_human'
      };
    }

    try {
      // Step 1: Analyze the task
      const analysis = await this.analyzeTask(task, context);
      
      // Step 2: Create plan
      const plan = await this.createPlan(analysis);
      this.currentPlan = plan;
      
      // Step 3: Decompose into subtasks
      this.decomposedTasks = await this.decomposeTasks(plan);
      
      // Step 4: Execute plan (handoffs to Builder/Verifier)
      const results = await this.executePlan(this.decomposedTasks, context);
      
      // Phase 44: optionally persist coding contracts to a SEPARATE store.
      this._maybePersistContracts();

      // Step 5: Aggregate and return
      return this.aggregateResults(results, context);
      
    } catch (error) {
      this.log('error', 'Supervisor processing failed', { error: error.message });
      return {
        success: false,
        error: error.message,
        state: this.getState()
      };
    }
  }

  async analyzeTask(task, context) {
    const prompt = `Analyze this task and identify:
1. What files/modules are involved?
2. What changes are needed?
3. What validation is required?

Task: ${typeof task === 'string' ? task : JSON.stringify(task)}
Context: ${JSON.stringify(context)}`;

    const response = await this.chat(prompt);
    
    return {
      description: task,
      analysis: response.text,
      timestamp: new Date().toISOString()
    };
  }

  async createPlan(analysis) {
    const prompt = `Based on this analysis, create a 2-5 step execution plan.
Each step should be concrete and actionable.
Specify whether each step needs Builder (implementation) or Verifier (validation).

Analysis: ${analysis.analysis}

Current Model: ${this.modelMetadata?.modelId || 'unknown'}
Model Capabilities: ${this.modelMetadata?.capabilities?.join(', ') || 'standard'}`;

    const response = await this.chat(prompt);
    
    return {
      steps: this.parseSteps(response.text),
      rawPlan: response.text,
      assumptions: this.extractAssumptions(response.text),
      modelContext: {
        modelId: this.modelMetadata?.modelId,
        provider: this.modelMetadata?.provider,
        createdAt: new Date().toISOString()
      },
      planId: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    };
  }

  parseSteps(planText) {
    const steps = [];
    const lines = planText.split('\n');
    
    for (const line of lines) {
      const match = line.match(/^\d+\.\s*(.+)/);
      if (match) {
        const stepText = match[1];
        const isBuilder = /implement|create|edit|add|modify|fix/i.test(stepText);
        const isVerifier = /verify|test|validate|check|ensure/i.test(stepText);
        
        steps.push({
          description: stepText,
          agent: isBuilder ? AgentRole.BUILDER : (isVerifier ? AgentRole.VERIFIER : AgentRole.SUPERVISOR),
          status: 'pending'
        });
      }
    }
    
    return steps;
  }

  extractAssumptions(text) {
    const assumptions = [];
    const lines = text.split('\n');
    
    let inAssumptions = false;
    for (const line of lines) {
      if (/assumption|assuming/i.test(line)) {
        inAssumptions = true;
      }
      if (inAssumptions && line.trim().startsWith('-')) {
        assumptions.push(line.trim().substring(1).trim());
      }
    }
    
    this.assumptions = assumptions;
    return assumptions;
  }

  async decomposeTasks(plan) {
    const tasks = [];
    const contractsOn = taskContracts.isEnabled();
    // Phase 47: independence is DECLARED, never inferred. Even with the scheduler on
    // we default-chain (verifier after its builder); a step only becomes parallel-
    // eligible when it explicitly sets `independent: true`. Prose is never parsed.
    const schedulerOn = executionScheduler.isParallelSchedulerEnabled() && executionFabric.isExecutionFabricEnabled();

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const declaredIndependent = schedulerOn && step.independent === true;
      const task = {
        id: `subtask-${i + 1}`,
        step: i + 1,
        description: step.description,
        targetAgent: step.agent,
        status: 'pending',
        dependencies: declaredIndependent ? [] : (i > 0 ? [`subtask-${i}`] : [])
      };
      if (step.serial === true) {
        task.serial = true;
      }
      // Phase 44: attach a machine-readable contract on the coding path (flag on).
      if (contractsOn) {
        task.contract = taskContracts.createTaskContract({
          taskId: task.id,
          parentTaskId: plan.planId || null,
          role: task.targetAgent,
          objective: step.description,
          constraints: Array.isArray(this.assumptions) ? this.assumptions.slice(0, 4) : [],
          verification: task.targetAgent === AgentRole.VERIFIER
            ? 'tests'
            : (task.targetAgent === AgentRole.BUILDER ? 'diff-review' : 'none'),
          risk: 'low',
          providerPolicy: this.modelMetadata
            ? { provider: this.modelMetadata.provider, model: this.modelMetadata.modelId }
            : null
        });
      }
      tasks.push(task);
    }

    return tasks;
  }

  /**
   * Phase 44: request cancellation of a not-yet-dispatched coding subtask. Flips
   * the in-memory contract flag; executePlan marks it skipped before the next
   * handoff. No transport cancel, no in-flight HTTPS abort in this phase.
   */
  requestCancel(taskId) {
    const task = (this.decomposedTasks || []).find((t) => t.id === taskId);
    if (!task) return false;
    if (task.contract && task.contract.cancellation) {
      task.contract.cancellation.requested = true;
    }
    task._cancelRequested = true;
    return true;
  }

  /**
   * Phase 44: best-effort persistence of coding contracts to a SEPARATE store
   * (~/.liku/task-contracts.json), never the peripheral inbox. Flag-gated
   * (LIKU_PERSIST_TASK_CONTRACTS) and fully non-fatal.
   * @private
   */
  _maybePersistContracts() {
    try {
      if (!taskContracts.isPersistEnabled()) return;
      const store = this._contractStore || require('./task-contract-store');
      const tasks = (this.decomposedTasks || [])
        .filter((t) => t && t.contract)
        .map((t) => ({ taskId: t.id, status: t.status, contract: t.contract }));
      if (tasks.length) store.save(tasks);
    } catch { /* persistence is best-effort */ }
  }

  async executePlan(tasks, context) {
    const results = [];
    const contractsOn = taskContracts.isEnabled();
    const escalationOn = escalation.isEscalationEnabled();
    const independentVerifierOn = escalation.isIndependentVerifierEnabled();
    const enabledProviders = this._getEnabledProviders();
    let lastBuilderProvider = null;

    // Phase 47: when the parallel scheduler AND the execution fabric are both on,
    // hand the whole decomposed list to the scheduler (declared-independence only)
    // instead of the sequential loop. Exactly one runner dispatches — never both.
    if (executionScheduler.isParallelSchedulerEnabled() && executionFabric.isExecutionFabricEnabled()) {
      return this._executePlanViaScheduler(tasks, context, {
        contractsOn,
        escalationOn,
        independentVerifierOn,
        enabledProviders
      });
    }

    for (const task of tasks) {
      // Phase 44: honor a cancellation request before the next handoff (flag on).
      if (contractsOn && (task._cancelRequested || task.contract?.cancellation?.requested)) {
        task.status = 'skipped';
        results.push({
          taskId: task.id,
          agent: task.targetAgent,
          success: false,
          skipped: true,
          cancelled: true
        });
        continue;
      }

      // Check if dependencies are satisfied
      const depsComplete = task.dependencies.every(depId => {
        const dep = results.find(r => r.taskId === depId);
        return dep && dep.success;
      });
      
      if (!depsComplete) {
        results.push({
          taskId: task.id,
          success: false,
          error: 'Dependencies not satisfied',
          skipped: true
        });
        continue;
      }
      
      task.status = 'in-progress';
      
      if (task.targetAgent === AgentRole.BUILDER) {
        const baseContext = { ...context, taskId: task.id, ...(contractsOn ? { contract: task.contract } : {}) };
        const outcome = await this._runCoding(task, AgentRole.BUILDER, `Implement: ${task.description}`, baseContext, {
          escalationOn,
          contractsOn,
          enabledProviders,
          builderSucceeded: false
        });
        lastBuilderProvider = outcome.usedProvider || lastBuilderProvider;
        results.push(outcome.entry);
      } else if (task.targetAgent === AgentRole.VERIFIER) {
        const baseContext = { ...context, taskId: task.id, ...(contractsOn ? { contract: task.contract } : {}) };
        // Phase 45: optional independent verifier — route Verifier to a different
        // enabled provider than the Builder used (read-only, no PAL).
        if (independentVerifierOn && lastBuilderProvider) {
          const alternate = escalation.pickAlternateProvider(lastBuilderProvider, enabledProviders);
          if (alternate) {
            baseContext.explicitProvider = alternate;
            task.verifierProviderPick = { explicitProvider: alternate, reason: 'independent-verifier' };
          } else {
            task.verifierProviderPick = { explicitProvider: null, reason: 'no-alternate-provider' };
          }
        }
        // A prior Builder subtask succeeding is required to classify verifier-disagree.
        const builderSucceeded = results.some((r) => r.agent === AgentRole.BUILDER && r.success);
        const outcome = await this._runCoding(task, AgentRole.VERIFIER, `Verify: ${task.description}`, baseContext, {
          escalationOn,
          contractsOn,
          enabledProviders,
          builderSucceeded
        });
        if (task.verifierProviderPick && task.verifierProviderPick.reason && outcome.entry.taskResult) {
          outcome.entry.verifierProviderReason = task.verifierProviderPick.reason;
        }
        results.push(outcome.entry);
      } else {
        // Handle internally
        results.push({
          taskId: task.id,
          agent: AgentRole.SUPERVISOR,
          success: true,
          note: 'Handled by supervisor'
        });
      }
      
      task.status = results[results.length - 1].success ? 'completed' : 'failed';
    }
    
    return results;
  }

  /**
   * Phase 47: run the decomposed plan through the parallel scheduler. The scheduler
   * owns fabric.submit + caps + dependency gating; each task's actual handoff still
   * flows through _runCodingHandoff (Phase 45 escalation, shared budget governor).
   * Returns the same aggregated results[] shape the sequential loop produces.
   * @private
   */
  async _executePlanViaScheduler(tasks, context, options = {}) {
    const fabric = this.getExecutionFabric();
    const runTask = this._buildSchedulerRunTask(context, options);
    const scheduler = executionScheduler.createExecutionScheduler({ fabric, runTask });
    const results = await scheduler.schedule(tasks);
    for (const task of tasks) {
      const entry = results.find((r) => r && r.taskId === task.id);
      if (!entry) continue;
      task.status = entry.skipped ? 'skipped' : (entry.success ? 'completed' : 'failed');
    }
    return results;
  }

  /**
   * Phase 47: build the per-task runner the scheduler wraps in fabric.submit. It
   * reproduces the Builder/Verifier branch of the sequential loop (baseContext,
   * optional independent-verifier provider pick) and delegates to _runCodingHandoff.
   * It does NOT submit to the fabric itself — the scheduler owns dispatch.
   * @private
   */
  _buildSchedulerRunTask(context, options = {}) {
    const { contractsOn, escalationOn, independentVerifierOn, enabledProviders } = options;
    return async (task, ctx = {}) => {
      const agent = task.targetAgent;

      if (agent !== AgentRole.BUILDER && agent !== AgentRole.VERIFIER) {
        return {
          entry: { taskId: task.id, agent: AgentRole.SUPERVISOR, success: true, note: 'Handled by supervisor' },
          usedProvider: null,
          status: 'success',
          result: null,
          signal: null,
          rung: null
        };
      }

      const baseContext = { ...context, taskId: task.id, ...(contractsOn ? { contract: task.contract } : {}) };
      let verifierProviderReason = null;
      if (agent === AgentRole.VERIFIER && independentVerifierOn && ctx.lastBuilderProvider) {
        const alternate = escalation.pickAlternateProvider(ctx.lastBuilderProvider, enabledProviders);
        if (alternate) {
          baseContext.explicitProvider = alternate;
          verifierProviderReason = 'independent-verifier';
        } else {
          verifierProviderReason = 'no-alternate-provider';
        }
      }

      const message = agent === AgentRole.BUILDER ? `Implement: ${task.description}` : `Verify: ${task.description}`;
      const outcome = await this._runCodingHandoff(task, agent, message, baseContext, {
        escalationOn,
        contractsOn,
        enabledProviders,
        builderSucceeded: agent === AgentRole.VERIFIER ? ctx.builderSucceeded === true : false
      });
      if (verifierProviderReason && outcome.entry.taskResult) {
        outcome.entry.verifierProviderReason = verifierProviderReason;
      }

      const taskResult = outcome.entry.taskResult || null;
      const lastEscalation = Array.isArray(task.escalation) && task.escalation.length
        ? task.escalation[task.escalation.length - 1]
        : null;
      return {
        entry: outcome.entry,
        usedProvider: outcome.usedProvider || null,
        status: taskResult ? taskResult.status : (outcome.entry.success ? 'success' : 'failure'),
        result: taskResult,
        signal: lastEscalation ? lastEscalation.signal : null,
        rung: lastEscalation ? lastEscalation.rung : null
      };
    };
  }

  /**
   * Phase 46: lazily create the in-process Execution Fabric ONLY when the flag is
   * on. Off → no fabric object is ever allocated on the coding path.
   */
  getExecutionFabric() {
    if (!executionFabric.isExecutionFabricEnabled()) return null;
    if (!this._executionFabric) {
      this._executionFabric = executionFabric.createInProcessExecutionFabric({ supervisor: this });
    }
    return this._executionFabric;
  }

  /**
   * Phase 46: run a coding subtask. When the fabric flag is on, dispatch through
   * the fabric (which wraps the SAME sequential handoff/escalation loop and records
   * a bounded snapshot); otherwise call the loop directly (Phase 45 byte-compatible).
   * @private
   */
  async _runCoding(task, agent, message, baseContext, options = {}) {
    const fabric = this.getExecutionFabric();
    if (!fabric) {
      return this._runCodingHandoff(task, agent, message, baseContext, options);
    }

    let capturedOutcome = null;
    const { done } = fabric.submit({
      taskId: task.id,
      role: agent,
      contract: task.contract || null,
      run: async () => {
        capturedOutcome = await this._runCodingHandoff(task, agent, message, baseContext, options);
        const taskResult = capturedOutcome.entry.taskResult || null;
        const lastEscalation = Array.isArray(task.escalation) && task.escalation.length
          ? task.escalation[task.escalation.length - 1]
          : null;
        return {
          status: taskResult ? taskResult.status : (capturedOutcome.entry.success ? 'success' : 'failure'),
          result: taskResult,
          signal: lastEscalation ? lastEscalation.signal : null,
          rung: lastEscalation ? lastEscalation.rung : null
        };
      }
    });
    await done;
    if (!capturedOutcome) {
      return { entry: { taskId: task.id, agent, success: false, skipped: true, cancelled: true }, usedProvider: null };
    }
    return capturedOutcome;
  }

  /**
   * Phase 45: run one coding handoff, then (flag on) classify the observable
   * outcome and retry the SAME subtask at the next ladder rung until success,
   * a stop signal (policy/budget/human), or the 2-retry cap. Sequential only.
   * @private
   */
  async _runCodingHandoff(task, agent, message, baseContext, options = {}) {
    const { escalationOn, contractsOn, enabledProviders, builderSucceeded } = options;
    const handoff = (ctx) => (agent === AgentRole.BUILDER
      ? this.handoffToBuilder(ctx, message)
      : this.handoffToVerifier(ctx, message));

    let handoffContext = { ...baseContext };
    let workerReturn = await handoff(handoffContext);
    let entry = this._buildResultEntry(task, agent, workerReturn, contractsOn);
    let usedProvider = this._resolveUsedProvider(workerReturn, agent);

    if (!escalationOn) {
      return { entry, usedProvider };
    }

    const requiredFiles = Array.isArray(task.contract?.scope) ? task.contract.scope : [];
    const taskResultFor = (e) => e.taskResult || taskContracts.taskResultFromWorkerReturn(task.id, agent, workerReturn);
    let classification = classifySignal({
      taskResult: taskResultFor(entry),
      error: workerReturn && workerReturn.error,
      providerMetadata: workerReturn && workerReturn.providerMetadata,
      budget: workerReturn && workerReturn.budget,
      requiredFiles,
      builderSucceeded
    });
    this._recordEscalationAttempt(task, 0, classification.signal, usedProvider);

    let rung = 0;
    let retries = 0;
    let priorSignal = classification.signal;
    let stopReason = null;
    while (
      classification.escalate
      && classification.retryable
      && retries < Math.min(escalation.MAX_AUTOMATIC_RETRIES, classification.cap)
    ) {
      const step = escalation.nextRung({ currentRung: rung, signal: classification.signal, enabledProviders, usedProvider });
      if (step.stop) { stopReason = step.reason; break; }
      rung = step.rung;
      retries += 1;
      handoffContext = {
        ...handoffContext,
        ...(step.explicitProvider ? { explicitProvider: step.explicitProvider } : {}),
        ...(step.explicitModel ? { explicitModel: step.explicitModel } : {}),
        escalationRung: rung,
        escalationSignal: classification.signal
      };
      workerReturn = await handoff(handoffContext);
      entry = this._buildResultEntry(task, agent, workerReturn, contractsOn);
      usedProvider = this._resolveUsedProvider(workerReturn, agent) || step.explicitProvider || usedProvider;
      classification = classifySignal({
        taskResult: taskResultFor(entry),
        error: workerReturn && workerReturn.error,
        providerMetadata: workerReturn && workerReturn.providerMetadata,
        budget: workerReturn && workerReturn.budget,
        requiredFiles,
        builderSucceeded,
        priorSignal
      });
      this._recordEscalationAttempt(task, rung, classification.signal, step.explicitProvider || usedProvider);
      priorSignal = classification.signal;
    }

    // Any unresolved terminal state on the coding path is surfaced for a human;
    // we never keep spending past the ladder / cap / policy / budget stop.
    if (classification.signal !== 'success') {
      const taskResult = entry.taskResult || taskContracts.taskResultFromWorkerReturn(task.id, agent, workerReturn);
      taskResult.status = 'blocked';
      taskResult.recommendation = 'human review';
      entry.taskResult = taskResult;
      entry.success = false;
      entry.escalationStopped = classification.human ? classification.signal : (stopReason || 'unresolved');
    }

    return { entry, usedProvider };
  }

  /** Record one escalation attempt on the task (bounded). @private */
  _recordEscalationAttempt(task, rung, signal, provider) {
    if (!Array.isArray(task.escalation)) task.escalation = [];
    if (task.escalation.length >= 8) return;
    task.escalation.push({ rung, signal, provider: provider || null, at: new Date().toISOString() });
  }

  /** Resolve the provider a worker actually used for its handoff. @private */
  _resolveUsedProvider(workerReturn, agentRole) {
    if (workerReturn && (workerReturn.usedProvider || workerReturn.provider)) {
      return workerReturn.usedProvider || workerReturn.provider;
    }
    const pm = workerReturn && workerReturn.providerMetadata;
    if (pm && pm.route && pm.route.provider) return pm.route.provider;
    try {
      const agent = this.orchestrator && this.orchestrator.getAgent ? this.orchestrator.getAgent(agentRole) : null;
      if (agent && agent.lastUsedProvider) return agent.lastUsedProvider;
    } catch { /* best-effort */ }
    return null;
  }

  /** Providers currently enabled/visible (Phase 41 rules) via the AI facade. @private */
  _getEnabledProviders() {
    try {
      const status = this.aiService && typeof this.aiService.getStatus === 'function'
        ? this.aiService.getStatus()
        : null;
      if (status && Array.isArray(status.availableProviders)) return status.availableProviders;
    } catch { /* best-effort */ }
    return [];
  }

  /**
   * Phase 44: build a Supervisor result entry. Flag on → compress the worker
   * return into a bounded TaskResult (no raw transcripts/diffs on the aggregate).
   * Flag off → preserve the Phase 43 raw spread for byte-compatibility.
   * @private
   */
  _buildResultEntry(task, agent, workerReturn, contractsOn) {
    if (!contractsOn) {
      return { taskId: task.id, agent, ...workerReturn };
    }
    const taskResult = taskContracts.taskResultFromWorkerReturn(task.id, agent, workerReturn);
    return {
      taskId: task.id,
      agent,
      success: !!(workerReturn && workerReturn.success),
      taskResult
    };
  }

  aggregateResults(results, context) {
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success && !r.skipped);
    const skipped = results.filter(r => r.skipped);
    
    const dependencyGraph = this.buildDependencyGraph(this.decomposedTasks);
    
    return {
      success: failed.length === 0,
      summary: {
        total: results.length,
        successful: successful.length,
        failed: failed.length,
        skipped: skipped.length
      },
      plan: this.currentPlan,
      results,
      assumptions: this.assumptions,
      dependencyGraph,
      timestamp: new Date().toISOString()
    };
  }

  buildDependencyGraph(tasks) {
    const graph = {
      nodes: tasks.map(t => ({
        id: t.id,
        description: t.description,
        agent: t.targetAgent,
        status: t.status
      })),
      edges: []
    };
    
    for (const task of tasks) {
      for (const depId of task.dependencies || []) {
        graph.edges.push({
          from: depId,
          to: task.id,
          type: 'depends-on'
        });
      }
    }
    
    return graph;
  }

  // ===== Supervisor-specific Methods =====

  async interpretPrompt(userPrompt) {
    const prompt = `Parse this user request and extract:
1. Primary goal
2. Scope (files, modules, features)
3. Constraints (time, compatibility, etc.)
4. Success criteria

User request: "${userPrompt}"`;

    const response = await this.chat(prompt);
    return {
      originalPrompt: userPrompt,
      interpretation: response.text,
      timestamp: new Date().toISOString()
    };
  }

  async researchContext(topic, files = []) {
    const readResults = await Promise.all(
      files.map(f => this.read(f))
    );
    
    const prompt = `Based on these files, what context is relevant for: ${topic}

Files content:
${readResults.map(r => `--- ${r.filePath} ---\n${r.content?.slice(0, 2000)}`).join('\n\n')}`;

    const response = await this.chat(prompt);
    return {
      topic,
      context: response.text,
      filesRead: files
    };
  }

  // ===== Peripheral Alert Intake (Phase 7) =====
  //
  // These methods are DELIBERATELY passive: they record advisory notifications
  // (e.g. from the PeripheralMonitorAgent) into a bounded inbox for a human to
  // review. They never call the LLM and never actuate hardware. Any physical
  // response a human later approves still flows through the PAL safety chain
  // (DCP evaluateCommand → class gate → pending/confirm).

  /**
   * Record an advisory notification into the bounded, human-gated inbox.
   * Oldest entries are dropped when the cap is exceeded so the Supervisor is
   * never overwhelmed. Returns the stored entry (or null if invalid).
   */
  receiveNotification(notification) {
    if (!notification || typeof notification !== 'object') return null;
    const entry = {
      ...notification,
      receivedAt: notification.receivedAt || new Date().toISOString(),
      acknowledged: false,
      // Hard safety invariant regardless of caller input.
      autonomousAction: false
    };

    // Phase 11: auto-acknowledge routine, low-severity notifications so a human
    // is not paged by noise. Critical / Class A / requiresHuman are NEVER
    // auto-acknowledged (hard safety floor).
    const sev = String(entry.severity || 'info').toLowerCase();
    if (!_isCritical(entry) && this._autoAckSeverities.has(sev)) {
      entry.acknowledged = true;
      entry.autoAcknowledged = true;
      entry.acknowledgedAt = new Date().toISOString();
    }

    this.notifications.push(entry);
    if (this.notifications.length > this.maxNotifications) {
      this.notifications.splice(0, this.notifications.length - this.maxNotifications);
    }
    this._persistPeripheralState();

    // Phase 11: fan out to additive delivery channels (log/file/webhook). This is
    // a pure advisory SINK — best-effort, non-blocking, never actuates hardware.
    try {
      if (this._channels && typeof this._channels.dispatch === 'function') {
        const routed = this._channels.dispatch(entry);
        if (routed && Array.isArray(routed.delivered) && routed.delivered.length) {
          entry.channels = routed.delivered;
        }
      }
    } catch { /* channel delivery is best-effort */ }

    try { this.emit('notification', entry); } catch { /* non-fatal */ }
    return entry;
  }

  /** Notifications a human has not yet acknowledged. */
  getPendingNotifications() {
    return this.notifications.filter((n) => !n.acknowledged);
  }

  /**
   * Notifications filtered by severity (e.g. 'critical' | 'warning' | 'info'),
   * newest last. Lets a human-facing surface prioritise the inbox by tier.
   */
  getNotificationsBySeverity(severity) {
    const s = String(severity || '').toLowerCase();
    return this.notifications.filter((n) => String(n.severity || '').toLowerCase() === s);
  }

  /** All notifications (acknowledged + pending), newest last. */
  getNotifications() {
    return this.notifications.slice();
  }

  /** Acknowledge a notification by id (human-in-the-loop). */
  acknowledgeNotification(id) {
    const n = this.notifications.find((x) => x.id === id);
    if (n) { n.acknowledged = true; this._persistPeripheralState(); return true; }
    return false;
  }

  /** Clear the notification inbox. */
  clearNotifications() {
    this.notifications = [];
    this._persistPeripheralState();
  }

  // ===== Bounded Peripheral Tasks (Phase 8) =====
  //
  // Turn an advisory notification into a REVIEWABLE work item. These tasks are
  // human-gated by construction: status starts at 'pending-review', requiresHuman
  // is always true, autonomousAction is always false, and there is NO code path
  // that executes a task or actuates hardware. A human decides; any physical
  // response still travels the full PAL safety chain.

  /**
   * Create (or coalesce) a bounded peripheral task from a notification.
   * Deduplicates by device+metric+level while an open task exists so a repeating
   * breach bumps a counter instead of flooding the queue. Returns the task.
   */
  createPeripheralTask(notification, options = {}) {
    if (!notification || typeof notification !== 'object') return null;
    const device = notification.device || {};
    const breach = notification.breach || {};
    const dedupeKey = `${device.id || '?'}:${breach.metric || '?'}:${breach.level || '?'}`;

    // Coalesce into an existing open task for the same condition.
    const open = this.peripheralTasks.find((t) => t.dedupeKey === dedupeKey && t.status === 'pending-review');
    if (open) {
      open.count += 1;
      open.lastSeenAt = new Date().toISOString();
      this._taskCooldowns.set(dedupeKey, this._now());
      this._persistPeripheralState();
      try { this.emit('peripheral-task', open); } catch { /* non-fatal */ }
      return open;
    }

    const severity = notification.severity || 'info';
    const priority = severity === 'critical' ? 'high' : (severity === 'warning' ? 'medium' : 'low');

    // Phase 11: flapping guard. If a task for the SAME condition was active within
    // the cooldown window, suppress recreating it so a bouncing sensor cannot spam
    // the queue. Critical / Class A conditions are NEVER suppressed.
    if (this._taskCooldownMs > 0 && !_isCritical({ ...notification, priority })) {
      const last = this._taskCooldowns.get(dedupeKey);
      if (last != null && (this._now() - last) < this._taskCooldownMs) {
        this._taskCooldowns.set(dedupeKey, this._now());
        return null; // suppressed — the consumer treats null as "no new task"
      }
    }

    // Per-severity routing: how a human-facing surface should treat this task.
    const escalation = priority === 'high' ? 'escalate' : (priority === 'medium' ? 'notify' : 'log');
    const task = {
      id: `periph-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'peripheral-response',
      // Phase 14: tag the originating source so human-facing surfaces can filter
      // (e.g. power anomalies vs. sensor threshold alerts). Advisory metadata only.
      source: options.source || notification.source || 'peripheral-alert',
      kind: notification.kind || 'peripheral-alert',
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      status: 'pending-review', // human must review; a task NEVER auto-runs
      priority,
      escalation,
      dedupeKey,
      device: { id: device.id, class: device.class, kind: device.kind, name: device.name },
      breach: { metric: breach.metric, level: breach.level, value: breach.value, threshold: breach.threshold },
      advisory: notification.advisory,
      // ADVISORY suggestion only — executing it still requires PAL.execute + confirm.
      proposedAction: options.proposedAction || null,
      requiresHuman: true, // peripheral tasks are ALWAYS human-gated
      autonomousAction: false,
      safety: 'physical-actions-require-pal-gating',
      notificationId: notification.id,
      // Phase 16: carry the anomaly type + tier so human-facing surfaces can
      // differentiate (advisory metadata only — never an actuation input).
      anomalyType: notification.anomalyType || null,
      severityTier: severity,
      count: 1
    };

    // Phase 11: auto-acknowledge routine LOW-severity tasks so they never sit in
    // the human review queue. Critical / Class A tasks are NEVER auto-acknowledged.
    if (!_isCritical(task) && this._autoAckSeverities.has(String(severity).toLowerCase())) {
      task.status = 'auto-acknowledged';
      task.resolvedAt = new Date().toISOString();
      task.autoAcknowledged = true;
    }

    this.peripheralTasks.push(task);
    this._taskCooldowns.set(dedupeKey, this._now());

    // Bounded: prefer evicting an already-resolved task, else the oldest.
    if (this.peripheralTasks.length > this.maxPeripheralTasks) {
      const resolvedIdx = this.peripheralTasks.findIndex((t) => t.status !== 'pending-review');
      if (resolvedIdx >= 0) this.peripheralTasks.splice(resolvedIdx, 1);
      else this.peripheralTasks.splice(0, this.peripheralTasks.length - this.maxPeripheralTasks);
    }
    this._persistPeripheralState();
    try { this.emit('peripheral-task', task); } catch { /* non-fatal */ }
    return task;
  }

  /** All peripheral tasks (any status), newest last. */
  getPeripheralTasks() {
    return this.peripheralTasks.slice();
  }

  /** Peripheral tasks still awaiting human review. */
  getPendingPeripheralTasks() {
    return this.peripheralTasks.filter((t) => t.status === 'pending-review');
  }

  /**
   * Tasks flagged for active escalation (per-severity routing == 'escalate',
   * i.e. high-priority / critical) that a human has not yet resolved.
   */
  getEscalatedPeripheralTasks() {
    return this.peripheralTasks.filter((t) => t.escalation === 'escalate' && t.status === 'pending-review');
  }

  /** Peripheral tasks filtered by priority (high|medium|low). */
  getPeripheralTasksBySeverity(priority) {
    const p = String(priority || '').toLowerCase();
    return this.peripheralTasks.filter((t) => String(t.priority || '').toLowerCase() === p);
  }

  /**
   * Resolve a peripheral task (human-in-the-loop). Does NOT execute anything —
   * it only records the human's decision.
   * @param {string} id
   * @param {'acknowledged'|'dismissed'} [resolution]
   */
  resolvePeripheralTask(id, resolution = 'acknowledged') {
    const t = this.peripheralTasks.find((x) => x.id === id);
    if (!t) return null;
    t.status = resolution === 'dismissed' ? 'dismissed' : 'acknowledged';
    t.resolvedAt = new Date().toISOString();
    // Record activity so the flapping cooldown also covers the window right after
    // a human resolves a task (prevents an immediate re-open on the next bounce).
    if (t.dedupeKey) this._taskCooldowns.set(t.dedupeKey, this._now());
    this._persistPeripheralState();
    return t;
  }

  /** Clear the peripheral task queue. */
  clearPeripheralTasks() {
    this.peripheralTasks = [];
    this._persistPeripheralState();
  }

  reset() {
    super.reset();
    this.currentPlan = null;
    this.decomposedTasks = [];
    this.assumptions = [];
    // Peripheral notifications/tasks are DURABLE. On reset we reload them from
    // the persistent store rather than wiping them, so a coding-session reset
    // never discards outstanding peripheral work. When persistence is disabled
    // (flag off) the store returns empty — preserving clear-on-reset semantics.
    let restored = { notifications: [], tasks: [] };
    try {
      if (this._persistEnabled && this._store && this._store.enabled && this._store.enabled()) {
        restored = this._store.load();
      }
    } catch { /* best-effort */ }
    this.notifications = Array.isArray(restored.notifications) ? restored.notifications : [];
    this.peripheralTasks = Array.isArray(restored.tasks) ? restored.tasks : [];
    if (this._taskCooldowns && typeof this._taskCooldowns.clear === 'function') this._taskCooldowns.clear();
  }
}

module.exports = { SupervisorAgent };
