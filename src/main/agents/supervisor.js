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
    
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      tasks.push({
        id: `subtask-${i + 1}`,
        step: i + 1,
        description: step.description,
        targetAgent: step.agent,
        status: 'pending',
        dependencies: i > 0 ? [`subtask-${i}`] : []
      });
    }
    
    return tasks;
  }

  async executePlan(tasks, context) {
    const results = [];
    
    for (const task of tasks) {
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
        const result = await this.handoffToBuilder(
          { ...context, taskId: task.id },
          `Implement: ${task.description}`
        );
        results.push({
          taskId: task.id,
          agent: AgentRole.BUILDER,
          ...result
        });
      } else if (task.targetAgent === AgentRole.VERIFIER) {
        const result = await this.handoffToVerifier(
          { ...context, taskId: task.id },
          `Verify: ${task.description}`
        );
        results.push({
          taskId: task.id,
          agent: AgentRole.VERIFIER,
          ...result
        });
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
    this.notifications.push(entry);
    if (this.notifications.length > this.maxNotifications) {
      this.notifications.splice(0, this.notifications.length - this.maxNotifications);
    }
    try { this.emit('notification', entry); } catch { /* non-fatal */ }
    return entry;
  }

  /** Notifications a human has not yet acknowledged. */
  getPendingNotifications() {
    return this.notifications.filter((n) => !n.acknowledged);
  }

  /** All notifications (acknowledged + pending), newest last. */
  getNotifications() {
    return this.notifications.slice();
  }

  /** Acknowledge a notification by id (human-in-the-loop). */
  acknowledgeNotification(id) {
    const n = this.notifications.find((x) => x.id === id);
    if (n) { n.acknowledged = true; return true; }
    return false;
  }

  /** Clear the notification inbox. */
  clearNotifications() {
    this.notifications = [];
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
      try { this.emit('peripheral-task', open); } catch { /* non-fatal */ }
      return open;
    }

    const severity = notification.severity || 'info';
    const priority = severity === 'critical' ? 'high' : (severity === 'warning' ? 'medium' : 'low');
    const task = {
      id: `periph-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'peripheral-response',
      source: 'peripheral-alert',
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      status: 'pending-review', // human must review; a task NEVER auto-runs
      priority,
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
      count: 1
    };
    this.peripheralTasks.push(task);

    // Bounded: prefer evicting an already-resolved task, else the oldest.
    if (this.peripheralTasks.length > this.maxPeripheralTasks) {
      const resolvedIdx = this.peripheralTasks.findIndex((t) => t.status !== 'pending-review');
      if (resolvedIdx >= 0) this.peripheralTasks.splice(resolvedIdx, 1);
      else this.peripheralTasks.splice(0, this.peripheralTasks.length - this.maxPeripheralTasks);
    }
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
    return t;
  }

  /** Clear the peripheral task queue. */
  clearPeripheralTasks() {
    this.peripheralTasks = [];
  }

  reset() {
    super.reset();
    this.currentPlan = null;
    this.decomposedTasks = [];
    this.assumptions = [];
    this.notifications = [];
    this.peripheralTasks = [];
  }
}

module.exports = { SupervisorAgent };
