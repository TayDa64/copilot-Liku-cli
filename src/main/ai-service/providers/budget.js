// Phase 43: flag-gated inference budget governor.
//
// Fail-closed, in-process spend ceiling attached to each inference call. Only
// active when LIKU_INFERENCE_FABRIC is on; otherwise every call is allowed with
// reason 'fabric-disabled' and no counters move (byte-compatible with Phase 42).
//
// The ledger is in-process only (caps need not survive a restart in Phase 43).
// Durable spend history lives in the separate inference telemetry JSONL.

const { loadRates, estimateUsd } = require('./rates');

const DEFAULT_BUDGET_USD = 0.50;
const DEFAULT_BUDGET_TOKENS = 250000;
const DEFAULT_MAX_CALLS_PER_ROLE = 20;

function isEnabledFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function parsePositiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function createBudgetGovernor(dependencies = {}) {
  const {
    env = process.env,
    fabricFlagEnv = 'LIKU_INFERENCE_FABRIC',
    rates = loadRates(env)
  } = dependencies;

  const caps = {
    usd: parsePositiveNumber(env.LIKU_INFERENCE_BUDGET_USD, DEFAULT_BUDGET_USD),
    tokens: parsePositiveNumber(env.LIKU_INFERENCE_BUDGET_TOKENS, DEFAULT_BUDGET_TOKENS),
    maxCallsPerRole: parsePositiveNumber(env.LIKU_INFERENCE_MAX_CALLS_PER_ROLE, DEFAULT_MAX_CALLS_PER_ROLE)
  };

  const ledger = {
    totalUsd: 0,
    totalTokens: 0,
    callsByRole: {}
  };

  function isFabricEnabled() {
    return isEnabledFlag(env[fabricFlagEnv]);
  }

  function remaining(roleKey) {
    return {
      usd: Math.max(0, caps.usd - ledger.totalUsd),
      tokens: Math.max(0, caps.tokens - ledger.totalTokens),
      callsForRole: Math.max(0, caps.maxCallsPerRole - (ledger.callsByRole[roleKey] || 0))
    };
  }

  // Pure read: does this call fit within the remaining budget?
  function evaluateBudget({ role } = {}) {
    const roleKey = role || 'unknown';
    if (!isFabricEnabled()) {
      return { allowed: true, reason: 'fabric-disabled', remaining: null };
    }
    if (ledger.totalUsd >= caps.usd) {
      return { allowed: false, reason: 'usd-cap', remaining: remaining(roleKey) };
    }
    if (ledger.totalTokens >= caps.tokens) {
      return { allowed: false, reason: 'token-cap', remaining: remaining(roleKey) };
    }
    if ((ledger.callsByRole[roleKey] || 0) >= caps.maxCallsPerRole) {
      return { allowed: false, reason: 'iteration-cap', remaining: remaining(roleKey) };
    }
    return { allowed: true, reason: 'within-budget', remaining: remaining(roleKey) };
  }

  // Reserve one iteration slot for an allowed call (counts the attempt even when
  // usage is later missing). No-op when fabric is off.
  function commitCall({ role } = {}) {
    if (!isFabricEnabled()) return;
    const roleKey = role || 'unknown';
    ledger.callsByRole[roleKey] = (ledger.callsByRole[roleKey] || 0) + 1;
  }

  // Fold a completed call's usage into the ledger. Returns the estimated USD (or
  // null). No-op when fabric is off. Missing usage does not invent token numbers.
  function recordUsage({ provider, model, inputTokens, outputTokens } = {}) {
    if (!isFabricEnabled()) {
      return { estimatedUsd: null };
    }
    const haveInput = Number.isFinite(inputTokens);
    const haveOutput = Number.isFinite(outputTokens);
    if (haveInput || haveOutput) {
      ledger.totalTokens += (haveInput ? inputTokens : 0) + (haveOutput ? outputTokens : 0);
    }
    const usd = estimateUsd(rates, provider, model, inputTokens, outputTokens);
    if (typeof usd === 'number') {
      ledger.totalUsd += usd;
    }
    return { estimatedUsd: typeof usd === 'number' ? usd : null };
  }

  function getLedger() {
    return {
      totalUsd: ledger.totalUsd,
      totalTokens: ledger.totalTokens,
      callsByRole: { ...ledger.callsByRole },
      caps: { ...caps }
    };
  }

  return {
    evaluateBudget,
    commitCall,
    recordUsage,
    getLedger,
    isFabricEnabled
  };
}

module.exports = {
  DEFAULT_BUDGET_USD,
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_MAX_CALLS_PER_ROLE,
  createBudgetGovernor
};
