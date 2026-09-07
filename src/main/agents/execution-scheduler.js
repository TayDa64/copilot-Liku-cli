/**
 * Execution Scheduler — declared-independence parallelism (Phase 47).
 *
 * A thin driver ON TOP of the Phase 46 in-process Execution Fabric. When both
 * LIKU_PARALLEL_SCHEDULER and LIKU_EXECUTION_FABRIC are on, it may submit
 * Supervisor-DECLARED independent coding subtasks to the fabric concurrently,
 * bounded by hard caps. It does NOT infer independence from prose — only the
 * dependency list and an optional `serial: true` gate decide eligibility.
 *
 * Out of scope (later phases): transport abstraction, HTTP/2 vs HTTP/3, QUIC,
 * IPC/worker pools, work-stealing, adaptive policy. This is in-process only and
 * changes neither the escalation ladder nor the budget governor: every task's
 * handoff still flows through the SAME `runTask` (Supervisor handoff + Phase 45
 * escalation + shared budget ledger). Cancellation stays pre-dispatch only.
 */

'use strict';

function isEnabledFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function isParallelSchedulerEnabled(env = process.env) {
  return isEnabledFlag(env.LIKU_PARALLEL_SCHEDULER);
}

function toPositiveInt(value, fallback) {
  const n = parseInt(String(value), 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

// Caps default to a conservative posture: unknown-provider work is serialized
// (per-provider 1), at most two tasks in flight, two per role.
function readCaps(env = process.env) {
  return {
    maxTasks: toPositiveInt(env.LIKU_MAX_PARALLEL_TASKS, 2),
    maxPerProvider: toPositiveInt(env.LIKU_MAX_PARALLEL_PER_PROVIDER, 1),
    maxPerRole: toPositiveInt(env.LIKU_MAX_PARALLEL_PER_ROLE, 2)
  };
}

function normalizeRole(task) {
  return String((task && (task.targetAgent || task.role)) || 'unspecified').toLowerCase();
}

function isCancelRequested(task) {
  if (!task) return false;
  return task._cancelRequested === true
    || !!(task.contract && task.contract.cancellation && task.contract.cancellation.requested);
}

/**
 * Build a scheduler bound to a fabric and a per-task runner.
 *  - fabric:  a Phase 46 InProcessExecutionFabric (owns submit/cancel/state).
 *  - runTask: async (task, ctx) => { entry, usedProvider, status, result, signal, rung }
 *             `ctx` carries { completedEntries, providerOf, lastBuilderProvider,
 *             builderSucceeded }. runTask MUST NOT itself submit to the fabric.
 *  - env:     environment for caps + flag reads.
 */
function createExecutionScheduler({ fabric, runTask, env = process.env } = {}) {
  if (!fabric || typeof fabric.submit !== 'function') {
    throw new Error('createExecutionScheduler requires a fabric with submit()');
  }
  if (typeof runTask !== 'function') {
    throw new Error('createExecutionScheduler requires a runTask function');
  }
  const caps = readCaps(env);

  async function schedule(tasks) {
    const nodes = (Array.isArray(tasks) ? tasks : []).map((task, idx) => ({
      task,
      idx,
      role: normalizeRole(task),
      state: 'pending', // pending → running → done | skipped
      entry: null,
      success: false,
      usedProvider: null
    }));
    const byId = new Map(nodes.map((n) => [n.task.id, n]));
    const completedEntries = [];
    const providerByTaskId = new Map();
    let lastBuilderProvider = null;

    let runningCount = 0;
    let serialRunning = false;
    const runningByProvider = new Map();
    const runningByRole = new Map();

    const providerHint = (node) => String(node.task.explicitProvider || node.usedProvider || 'unspecified');

    // A dependency must be terminal-SUCCESS to unblock. Any non-success terminal
    // state (failed/blocked/cancelled/skipped) fails the dependent — mirroring the
    // sequential executePlan "Dependencies not satisfied" skip.
    const evaluateDeps = (node) => {
      const deps = Array.isArray(node.task.dependencies) ? node.task.dependencies : [];
      let ready = true;
      for (const depId of deps) {
        const dep = byId.get(depId);
        if (!dep) return 'failed';
        if (dep.state === 'skipped') return 'failed';
        if (dep.state === 'done') {
          if (!dep.success) return 'failed';
          continue;
        }
        ready = false; // pending or running
      }
      return ready ? 'ready' : 'wait';
    };

    const canLaunch = (node) => {
      if (serialRunning) return false;
      if (node.task.serial === true && runningCount > 0) return false;
      if (runningCount >= caps.maxTasks) return false;
      const provider = providerHint(node);
      if ((runningByProvider.get(provider) || 0) >= caps.maxPerProvider) return false;
      if ((runningByRole.get(node.role) || 0) >= caps.maxPerRole) return false;
      return true;
    };

    return await new Promise((resolve) => {
      const finalize = () => {
        if (nodes.every((n) => n.state === 'done' || n.state === 'skipped')) {
          resolve(nodes.map((n) => n.entry).filter(Boolean));
        }
      };

      const launch = (node) => {
        node.state = 'running';
        runningCount += 1;
        const provider = providerHint(node);
        runningByProvider.set(provider, (runningByProvider.get(provider) || 0) + 1);
        runningByRole.set(node.role, (runningByRole.get(node.role) || 0) + 1);
        if (node.task.serial === true) serialRunning = true;

        let captured = null;
        const { done } = fabric.submit({
          taskId: node.task.id,
          role: node.role,
          contract: node.task.contract || null,
          run: async () => {
            captured = await runTask(node.task, {
              completedEntries,
              providerOf: (id) => providerByTaskId.get(id) || null,
              lastBuilderProvider,
              builderSucceeded: completedEntries.some((e) => e && e.agent === 'builder' && e.success)
            });
            return {
              status: captured.status,
              result: captured.result || null,
              signal: captured.signal || null,
              rung: captured.rung
            };
          }
        });

        done.then(() => {
          runningCount -= 1;
          runningByProvider.set(provider, Math.max(0, (runningByProvider.get(provider) || 1) - 1));
          runningByRole.set(node.role, Math.max(0, (runningByRole.get(node.role) || 1) - 1));
          if (node.task.serial === true) serialRunning = false;
          node.state = 'done';

          if (captured) {
            node.entry = captured.entry;
            node.success = captured.status === 'success';
            node.usedProvider = captured.usedProvider || null;
            completedEntries.push(captured.entry);
            if (captured.usedProvider) providerByTaskId.set(node.task.id, captured.usedProvider);
            if (node.role === 'builder' && node.success && captured.usedProvider) {
              lastBuilderProvider = captured.usedProvider;
            }
          } else {
            // Fabric drained a task that was cancelled before dispatch.
            node.entry = { taskId: node.task.id, agent: node.role, success: false, skipped: true, cancelled: true };
            node.success = false;
          }
          pump();
        });
      };

      const pump = () => {
        let progressed = true;
        while (progressed) {
          progressed = false;
          for (const node of nodes) {
            if (node.state !== 'pending') continue;

            // Pre-dispatch cancel (Phase 44 semantics): a still-queued task whose
            // cancellation was requested never runs.
            if (isCancelRequested(node.task)) {
              node.state = 'skipped';
              node.entry = { taskId: node.task.id, agent: node.role, success: false, skipped: true, cancelled: true };
              progressed = true;
              continue;
            }

            const dep = evaluateDeps(node);
            if (dep === 'failed') {
              node.state = 'skipped';
              node.entry = {
                taskId: node.task.id,
                success: false,
                error: 'Dependencies not satisfied',
                skipped: true,
                reason: 'dependency-failed'
              };
              progressed = true;
              continue;
            }
            if (dep === 'wait') continue;
            if (!canLaunch(node)) continue;

            launch(node);
            progressed = true;
          }
        }
        finalize();
      };

      pump();
    });
  }

  return { schedule, caps };
}

module.exports = {
  isParallelSchedulerEnabled,
  readCaps,
  createExecutionScheduler
};
