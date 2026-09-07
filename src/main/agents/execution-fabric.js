/**
 * Execution Fabric — in-process abstraction (Phase 46).
 *
 * An interface over "run a coding task" whose ONLY backend in this phase is the
 * existing in-process Supervisor coding path (sequential executePlan, Phase 44
 * cancel-before-dispatch, Phase 45 classify/retry). No parallelism, no HTTP/QUIC,
 * no worker processes — those are later phases. Flag-gated (LIKU_EXECUTION_FABRIC,
 * default OFF); when off the Supervisor never constructs a fabric.
 *
 * Events are a bounded, closed set and NEVER carry transcripts, diffs, or file
 * bodies. They are not a side channel around policy/budget/escalation.
 */

'use strict';

const TASK_STATES = Object.freeze(['queued', 'running', 'succeeded', 'failed', 'blocked', 'skipped', 'cancelled']);
const FABRIC_EVENTS = Object.freeze([
  'task.queued', 'task.started', 'task.completed', 'task.failed',
  'task.blocked', 'task.skipped', 'task.cancelled'
]);
const DEFAULT_MAX_LIST = 20;

function isEnabledFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function isExecutionFabricEnabled(env = process.env) {
  return isEnabledFlag(env.LIKU_EXECUTION_FABRIC);
}

function nowIso() {
  return new Date().toISOString();
}

function statusToState(status) {
  switch (String(status || '').toLowerCase()) {
    case 'success': return 'succeeded';
    case 'failure': return 'failed';
    case 'blocked': return 'blocked';
    case 'skipped': return 'skipped';
    default: return 'failed';
  }
}

function stateToEvent(state) {
  switch (state) {
    case 'queued': return 'task.queued';
    case 'running': return 'task.started';
    case 'succeeded': return 'task.completed';
    case 'failed': return 'task.failed';
    case 'blocked': return 'task.blocked';
    case 'skipped': return 'task.skipped';
    case 'cancelled': return 'task.cancelled';
    default: return null;
  }
}

function normalizeSubmitTask(input) {
  const source = input && typeof input === 'object' ? input : {};
  const isContract = source.kind === 'task-contract';
  const contract = isContract
    ? source
    : (source.contract && typeof source.contract === 'object' ? source.contract : null);
  const taskId = String(
    source.taskId
    || (contract && contract.taskId)
    || source.id
    || `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  const role = source.role || (contract && contract.role) || source.targetAgent || null;
  return { taskId, role, contract, raw: source };
}

// Result snapshots keep only bounded, known fields — never .text/.rationale/.diffs.
function sanitizeResult(result) {
  if (!result || typeof result !== 'object') return null;
  const out = {};
  for (const key of ['kind', 'version', 'taskId', 'status', 'recommendation']) {
    if (result[key] !== undefined) out[key] = result[key];
  }
  if (typeof result.confidence === 'number') out.confidence = result.confidence;
  for (const key of ['findings', 'files', 'evidence']) {
    if (Array.isArray(result[key])) {
      out[key] = result[key].slice(0, 16).map((v) => String(v).slice(0, 240));
    }
  }
  return out;
}

// When a caller submits a task carrying its own `run` closure, that is the work.
function defaultRunner(task) {
  const run = task && task.raw && typeof task.raw.run === 'function' ? task.raw.run : null;
  return run ? run() : { status: 'failure' };
}

function extractResultAndStatus(outcome) {
  if (!outcome || typeof outcome !== 'object') {
    return { result: null, status: 'failure' };
  }
  // Accept { status, result } or a TaskResult-shaped object directly.
  const nested = outcome.result && typeof outcome.result === 'object' ? outcome.result : null;
  const result = nested || (outcome.kind === 'task-result' ? outcome : null);
  const status = outcome.status || (result && result.status) || 'failure';
  return { result, status };
}

class InProcessExecutionFabric {
  constructor(options = {}) {
    this._runTask = typeof options.runTask === 'function' ? options.runTask : null;
    this._supervisor = options.supervisor || null;
    this._handlers = new Map();
    this._tasks = new Map();
    this._order = [];
    this._maxList = Number.isFinite(options.maxList) && options.maxList > 0 ? options.maxList : DEFAULT_MAX_LIST;
    this.backend = 'in-process';
  }

  on(event, handler) {
    if (!FABRIC_EVENTS.includes(event) || typeof handler !== 'function') return this;
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(handler);
    return this;
  }

  off(event, handler) {
    const set = this._handlers.get(event);
    if (set) set.delete(handler);
    return this;
  }

  _emit(event, payload) {
    const set = this._handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      try { handler(payload); } catch { /* listeners are best-effort */ }
    }
  }

  _snapshot(taskId) {
    const task = this._tasks.get(taskId);
    if (!task) return null;
    return {
      taskId: task.taskId,
      role: task.role || null,
      state: task.state,
      contract: task.contract || null,
      result: task.result || null
    };
  }

  get(taskId) {
    return this._snapshot(taskId);
  }

  list() {
    return this._order.map((id) => this._snapshot(id)).filter(Boolean);
  }

  _put(record) {
    this._tasks.set(record.taskId, record);
    this._order.push(record.taskId);
    while (this._order.length > this._maxList) {
      const evicted = this._order.shift();
      this._tasks.delete(evicted);
    }
  }

  submit(contractOrTask) {
    const task = normalizeSubmitTask(contractOrTask);
    const record = {
      taskId: task.taskId,
      role: task.role,
      state: 'queued',
      contract: task.contract || null,
      result: null,
      _task: task
    };
    this._put(record);
    this._emit('task.queued', { taskId: record.taskId, role: record.role || null, state: 'queued', at: nowIso() });
    // Defer the run so a caller can cancel a still-queued task before dispatch.
    const done = Promise.resolve().then(() => this._drainTask(record.taskId));
    record._done = done;
    return { taskId: record.taskId, state: 'queued', done };
  }

  async _drainTask(taskId) {
    const record = this._tasks.get(taskId);
    if (!record) return null;
    if (record.state === 'cancelled') {
      return this._snapshot(taskId); // cancelled before dispatch → never runs
    }

    record.state = 'running';
    this._emit('task.started', { taskId, role: record.role || null, state: 'running', at: nowIso() });

    let outcome = null;
    try {
      const runner = this._runTask || defaultRunner;
      outcome = await runner(record._task, record);
    } catch (error) {
      record.state = 'failed';
      record.result = { status: 'failure' };
      this._emit('task.failed', {
        taskId, role: record.role || null, state: 'failed', at: nowIso(),
        error: String((error && error.message) || error || '').slice(0, 240)
      });
      return this._snapshot(taskId);
    }

    const { result, status } = extractResultAndStatus(outcome);
    const state = statusToState(status);
    record.state = state;
    record.result = sanitizeResult(result || outcome);

    const payload = { taskId, role: record.role || null, state, at: nowIso() };
    if (outcome && outcome.signal) payload.signal = String(outcome.signal);
    if (outcome && Number.isFinite(Number(outcome.rung))) payload.rung = Number(outcome.rung);
    this._emit(stateToEvent(state), payload);
    return this._snapshot(taskId);
  }

  // Pre-dispatch cancel only. Returns true if the task was still queued; a running
  // or terminal task is left alone (no in-flight HTTPS abort — Phase 44 semantics).
  cancel(taskId) {
    const record = this._tasks.get(taskId);
    if (!record) return false;
    if (record.state !== 'queued') return false;

    record.state = 'cancelled';
    if (record.contract && record.contract.cancellation) {
      record.contract.cancellation.requested = true;
    }
    if (this._supervisor && typeof this._supervisor.requestCancel === 'function') {
      try { this._supervisor.requestCancel(taskId); } catch { /* best-effort */ }
    }
    this._emit('task.cancelled', { taskId, role: record.role || null, state: 'cancelled', at: nowIso() });
    return true;
  }
}

function createInProcessExecutionFabric(options = {}) {
  return new InProcessExecutionFabric(options);
}

module.exports = {
  TASK_STATES,
  FABRIC_EVENTS,
  isExecutionFabricEnabled,
  statusToState,
  InProcessExecutionFabric,
  createInProcessExecutionFabric
};
