/**
 * TaskContract + TaskResult (Phase 44).
 *
 * A machine-readable, hard-bounded envelope the Supervisor attaches to CODING
 * subtasks before handoff, and a compressed report workers return in place of
 * raw chat transcripts. Flag-gated (LIKU_TASK_CONTRACTS, default OFF): when off,
 * the Supervisor coding path is byte-compatible with Phase 43.
 *
 * Invariants:
 *  - NEVER carries file contents, diffs, or chat transcripts.
 *  - Every field is capped in the factory (not by hope). Serialized <= 4 KiB.
 *  - Contracts are independently schedulable (fields exist) but the runner stays
 *    sequential in this phase.
 */

'use strict';

const FLAG = 'LIKU_TASK_CONTRACTS';
const PERSIST_FLAG = 'LIKU_PERSIST_TASK_CONTRACTS';

// Hard bounds.
const CAP_TEXT = 400;          // objective / recommendation
const CAP_LIST = 8;            // items per short list
const CAP_LIST_ITEM = 240;    // chars per list item
const CAP_PATHS = 16;         // files / scope paths
const CAP_PATH = 240;         // chars per path
const CAP_BYTES = 4096;       // serialized contract / result ceiling

const VALID_VERIFICATION = new Set(['tests', 'diff-review', 'none']);
const VALID_RISK = new Set(['low', 'medium', 'high']);
const VALID_STATUS = new Set(['success', 'failure', 'blocked', 'skipped']);

function isEnabledFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function isEnabled(env = process.env) {
  return isEnabledFlag(env[FLAG]);
}

function isPersistEnabled(env = process.env) {
  return isEnabledFlag(env[PERSIST_FLAG]);
}

function truncStr(value, cap) {
  const s = String(value == null ? '' : value);
  return s.length > cap ? s.slice(0, cap) : s;
}

function boundList(arr, maxItems, itemCap) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => truncStr(x, itemCap).trim())
    .filter((s) => s.length > 0)
    .slice(0, maxItems);
}

function normalizeProviderPolicy(policy) {
  if (!policy || typeof policy !== 'object') return null;
  const provider = policy.provider ? truncStr(policy.provider, 40) : null;
  const model = policy.model ? truncStr(policy.model, 80) : null;
  if (!provider && !model) return null;
  return { provider: provider || null, model: model || null };
}

function normalizeBudgetHint(hint) {
  if (!hint || typeof hint !== 'object') return null;
  const maxCalls = Number(hint.maxCalls);
  if (!Number.isFinite(maxCalls) || maxCalls <= 0) return null;
  return { maxCalls: Math.floor(maxCalls) };
}

function normalizeConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

// Deterministically trim a bounded object until it serializes under `cap` bytes.
// Pops from the longest capped list first, then shortens scalar text fields.
function enforceSerializedCap(obj, cap) {
  const listFields = ['findings', 'files', 'scope', 'evidence', 'constraints', 'successCriteria', 'forbidden'];
  const textFields = ['objective', 'recommendation'];
  const clone = JSON.parse(JSON.stringify(obj));
  const size = () => Buffer.byteLength(JSON.stringify(clone), 'utf8');
  let guard = 0;
  while (size() > cap && guard < 2000) {
    guard++;
    let target = null;
    let best = 0;
    for (const f of listFields) {
      if (Array.isArray(clone[f]) && clone[f].length > best) {
        best = clone[f].length;
        target = f;
      }
    }
    if (target) {
      clone[target].pop();
      clone.truncated = true;
      continue;
    }
    let shortened = false;
    for (const f of textFields) {
      if (typeof clone[f] === 'string' && clone[f].length > 40) {
        clone[f] = clone[f].slice(0, Math.floor(clone[f].length * 0.8));
        clone.truncated = true;
        shortened = true;
      }
    }
    if (!shortened) break;
  }
  return clone;
}

function createTaskContract(input = {}) {
  const contract = {
    kind: 'task-contract',
    version: '1.0.0',
    taskId: truncStr(input.taskId || '', 120),
    parentTaskId: input.parentTaskId ? truncStr(input.parentTaskId, 120) : null,
    role: truncStr(input.role || '', 40),
    objective: truncStr(input.objective || '', CAP_TEXT),
    scope: boundList(input.scope, CAP_PATHS, CAP_PATH),
    forbidden: boundList(input.forbidden, CAP_LIST, CAP_LIST_ITEM),
    constraints: boundList(input.constraints, CAP_LIST, CAP_LIST_ITEM),
    successCriteria: boundList(input.successCriteria, CAP_LIST, CAP_LIST_ITEM),
    verification: VALID_VERIFICATION.has(input.verification) ? input.verification : 'none',
    risk: VALID_RISK.has(input.risk) ? input.risk : 'low',
    providerPolicy: normalizeProviderPolicy(input.providerPolicy),
    budgetHint: normalizeBudgetHint(input.budgetHint),
    cancellation: { requested: false },
    createdAt: new Date().toISOString()
  };
  return enforceSerializedCap(contract, CAP_BYTES);
}

function createTaskResult(input = {}) {
  const result = {
    kind: 'task-result',
    version: '1.0.0',
    taskId: truncStr(input.taskId || '', 120),
    status: VALID_STATUS.has(input.status) ? input.status : 'failure',
    findings: boundList(input.findings, CAP_LIST, CAP_LIST_ITEM),
    files: boundList(input.files, CAP_PATHS, CAP_PATH),
    evidence: boundList(input.evidence, CAP_LIST, CAP_LIST_ITEM),
    recommendation: truncStr(input.recommendation || '', CAP_TEXT),
    confidence: normalizeConfidence(input.confidence),
    createdAt: new Date().toISOString()
  };
  return enforceSerializedCap(result, CAP_BYTES);
}

function isTaskResult(value) {
  return !!value && typeof value === 'object' && value.kind === 'task-result';
}

// Local, no-LLM extraction of short findings from a worker's prose field.
function extractProseFindings(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const bullets = lines
    .filter((l) => /^(-|\*|•|\d+[.)])\s+/.test(l))
    .map((l) => l.replace(/^(-|\*|•|\d+[.)])\s+/, '').trim())
    .filter(Boolean);
  const chosen = bullets.length ? bullets : lines;
  return chosen.slice(0, CAP_LIST).map((s) => truncStr(s, CAP_LIST_ITEM));
}

// Normalize any worker return object into a bounded TaskResult without keeping
// raw transcripts. Prefers structured fields; falls back to a local prose parse.
function taskResultFromWorkerReturn(taskId, role, ret = {}) {
  if (!ret || typeof ret !== 'object') {
    return createTaskResult({ taskId, status: 'failure', recommendation: 'No worker output' });
  }
  if (isTaskResult(ret.result)) {
    return ret.result;
  }

  const status = ret.skipped
    ? 'skipped'
    : ret.success
      ? 'success'
      : (ret.blocker || ret.blocked || ret.reportedBlocker)
        ? 'blocked'
        : 'failure';

  let files = [];
  if (Array.isArray(ret.filesModified)) files = ret.filesModified;
  else if (Array.isArray(ret.files)) files = ret.files;
  else if (Array.isArray(ret.changedFiles)) files = ret.changedFiles;

  const evidence = [];
  if (Array.isArray(ret.proofs)) {
    for (const p of ret.proofs) {
      const name = p && (p.name || p.check || p.test || p.id);
      if (name) evidence.push(p.passed !== undefined ? `${name}:${p.passed ? 'pass' : 'fail'}` : String(name));
    }
  }
  if (Array.isArray(ret.results)) {
    for (const r of ret.results) {
      const name = r && (r.name || r.phase);
      if (name) evidence.push(String(name));
    }
  }
  if (ret.verdict && Array.isArray(ret.verdict.checks)) {
    for (const c of ret.verdict.checks) {
      const name = c && (c.name || c.phase);
      if (name) evidence.push(String(name));
    }
  }

  const proseSources = [ret.rationale, ret.findings, ret.context, ret.analysis, ret.summary, ret.error]
    .filter((v) => typeof v === 'string' && v.trim());
  let findings = [];
  for (const p of proseSources) {
    findings = findings.concat(extractProseFindings(p));
    if (findings.length >= CAP_LIST) break;
  }
  if (findings.length === 0 && typeof ret.error === 'string') {
    findings = [ret.error];
  }

  let recommendation = '';
  if (ret.suggestedNext) recommendation = `next:${ret.suggestedNext}`;
  else if (Array.isArray(ret.suggestions) && ret.suggestions[0]) recommendation = String(ret.suggestions[0]);
  else if (Array.isArray(ret.recommendations) && ret.recommendations[0]) recommendation = String(ret.recommendations[0]);

  return createTaskResult({
    taskId,
    status,
    findings,
    files,
    evidence,
    recommendation,
    confidence: typeof ret.confidence === 'number' ? ret.confidence : undefined
  });
}

module.exports = {
  FLAG,
  PERSIST_FLAG,
  CAPS: { CAP_TEXT, CAP_LIST, CAP_LIST_ITEM, CAP_PATHS, CAP_PATH, CAP_BYTES },
  isEnabled,
  isPersistEnabled,
  createTaskContract,
  createTaskResult,
  isTaskResult,
  taskResultFromWorkerReturn,
  extractProseFindings
};
