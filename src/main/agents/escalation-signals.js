/**
 * Observable-signal classifier (Phase 45).
 *
 * Maps a coding handoff outcome to ONE signal from a closed set, driven ONLY by
 * observable evidence: TaskResult.status, verifier verdict, worker error strings,
 * providerMetadata.budget, and (optionally) the contract's required files.
 *
 * FORBIDDEN INPUTS: model "confidence", Likert scores, "I am unsure." This module
 * never reads a confidence field even when one is present on the TaskResult.
 */

'use strict';

// Closed set of signals. `cap` bounds automatic retries for that signal.
const SIGNALS = {
  success: { retryable: false, escalate: false, human: false, cap: 0 },
  'tests-failed': { retryable: true, escalate: true, human: false, cap: 2 },
  'schema-invalid': { retryable: true, escalate: true, human: false, cap: 2 },
  'files-missing': { retryable: true, escalate: true, human: false, cap: 2 },
  'verifier-disagree': { retryable: true, escalate: true, human: false, cap: 2 },
  'repeated-failure': { retryable: false, escalate: false, human: true, cap: 0 },
  timeout: { retryable: true, escalate: true, human: false, cap: 2 },
  'budget-exceeded': { retryable: false, escalate: false, human: true, cap: 0 },
  'policy-violation': { retryable: false, escalate: false, human: true, cap: 0 },
  'provider-error': { retryable: true, escalate: true, human: false, cap: 2 },
  'unknown-failure': { retryable: true, escalate: true, human: false, cap: 1 }
};

function make(signal) {
  const spec = SIGNALS[signal] || SIGNALS['unknown-failure'];
  return { signal, retryable: spec.retryable, escalate: spec.escalate, human: spec.human, cap: spec.cap };
}

// Observable text ONLY: worker error + a few bounded TaskResult text fields.
// Never the `confidence` field.
function observableText(error, taskResult) {
  const parts = [];
  if (typeof error === 'string') parts.push(error);
  else if (error && typeof error === 'object') parts.push(String(error.message || ''));
  if (taskResult && typeof taskResult === 'object') {
    if (typeof taskResult.recommendation === 'string') parts.push(taskResult.recommendation);
    if (Array.isArray(taskResult.findings)) parts.push(taskResult.findings.join(' '));
    if (Array.isArray(taskResult.evidence)) parts.push(taskResult.evidence.join(' '));
  }
  return parts.join(' ').toLowerCase();
}

function baseSignal({ taskResult, error, providerMetadata, budget, requiredFiles, builderSucceeded } = {}) {
  const status = taskResult && typeof taskResult === 'object' ? taskResult.status : undefined;
  const errText = observableText(error, taskResult);
  const errCode = error && typeof error === 'object' ? String(error.code || '') : '';

  // Fail closed on budget first.
  if (errCode === 'BUDGET_EXCEEDED'
    || (budget && budget.allowed === false)
    || (providerMetadata && providerMetadata.budget && providerMetadata.budget.allowed === false)
    || /budget exceeded/.test(errText)) {
    return make('budget-exceeded');
  }
  // Policy / safety — never auto-retry.
  if (/\b(deny|denied|pending[- ]?confirm|requires? confirmation|safety hook|policy violation|blocked by policy|not permitted|not authorized)\b/.test(errText)) {
    return make('policy-violation');
  }
  // Claimed success but contract-required files are absent.
  if (status === 'success' && Array.isArray(requiredFiles) && requiredFiles.length) {
    const have = new Set((Array.isArray(taskResult.files) ? taskResult.files : []).map((f) => String(f)));
    if (requiredFiles.some((f) => !have.has(String(f)))) {
      return make('files-missing');
    }
  }
  if (status === 'success') {
    return make('success');
  }
  // Builder succeeded but the independent Verifier failed on the same task.
  if (builderSucceeded === true && (status === 'failure' || status === 'blocked')) {
    return make('verifier-disagree');
  }
  if (/\b(test|tests|unit|integration|e2e)\b/.test(errText) && /\b(fail|failed|failing)\b/.test(errText)) {
    return make('tests-failed');
  }
  if (/\b(schema|json|parse|unexpected token|invalid tool|malformed)\b/.test(errText)) {
    return make('schema-invalid');
  }
  if (/\b(timeout|timed out|deadline exceeded)\b/.test(errText)) {
    return make('timeout');
  }
  if (/\b(429|5\d\d|rate limit|api key not set|service unavailable|bad gateway|gateway timeout|econnreset|network error)\b/.test(errText)) {
    return make('provider-error');
  }
  if (status === 'failure' || status === 'blocked' || status === 'skipped' || error) {
    return make('unknown-failure');
  }
  return make('success');
}

// Public classifier. `priorSignal` (same taskId's previous signal) escalates a
// recurring retryable failure to human via 'repeated-failure'.
function classifySignal(input = {}) {
  const base = baseSignal(input);
  if (base.retryable && input.priorSignal && input.priorSignal === base.signal) {
    return make('repeated-failure');
  }
  return base;
}

module.exports = {
  SIGNALS,
  classifySignal
};
