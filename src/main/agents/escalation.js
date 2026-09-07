/**
 * Capability escalation ladder (Phase 45).
 *
 * Escalation moves through routing via a one-shot explicitProvider — it never
 * hardcodes a vendor into an agent and never bypasses budget/policy/confirm.
 * Flag-gated (LIKU_ESCALATION) AND requires the inference fabric to be on; if the
 * fabric is off, escalation is a no-op (Phase 44 behavior).
 *
 * Rungs (capability intent, not fixed vendors):
 *   0  current route (Phase 42 table / /route)
 *   1  same provider, retry once
 *   2  stronger planner if enabled (prefer xai)
 *   3  other enabled core provider (openai / anthropic / copilot)
 *   4  human — stop
 */

'use strict';

const MAX_AUTOMATIC_RETRIES = 2;
// Preference order when picking an alternate/stronger enabled provider.
const ALTERNATE_PROVIDER_ORDER = ['xai', 'cerebras', 'openai', 'anthropic', 'copilot'];

function isEnabledFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

// Escalation requires its own flag AND the fabric flag.
function isEscalationEnabled(env = process.env) {
  return isEnabledFlag(env.LIKU_ESCALATION) && isEnabledFlag(env.LIKU_INFERENCE_FABRIC);
}

function isIndependentVerifierEnabled(env = process.env) {
  return isEnabledFlag(env.LIKU_INDEPENDENT_VERIFIER) && isEnabledFlag(env.LIKU_INFERENCE_FABRIC);
}

// First enabled provider that differs from `usedProvider`. Returns null when the
// only enabled provider is the one already used (→ 'no-alternate-provider').
function pickAlternateProvider(usedProvider, enabledProviders = []) {
  const enabled = new Set(enabledProviders);
  for (const provider of ALTERNATE_PROVIDER_ORDER) {
    if (enabled.has(provider) && provider !== usedProvider) {
      return provider;
    }
  }
  return null;
}

// Decide the next rung for a given signal. Skips rungs whose provider is not
// Phase-41-enabled; policy-violation / budget-exceeded jump straight to human.
function nextRung({ currentRung = 0, signal, enabledProviders = [], usedProvider = null } = {}) {
  const enabled = new Set(enabledProviders);

  if (signal === 'policy-violation' || signal === 'budget-exceeded' || signal === 'repeated-failure') {
    return { rung: 4, explicitProvider: null, explicitModel: null, stop: true, reason: signal };
  }

  if (currentRung <= 0) {
    // Rung 1: retry once on the same provider (no provider change).
    return { rung: 1, explicitProvider: usedProvider || null, explicitModel: null, stop: false, reason: 'retry-same-provider' };
  }

  if (currentRung === 1) {
    // Rung 2: stronger planner (prefer xai) if enabled and different.
    if (enabled.has('xai') && usedProvider !== 'xai') {
      return { rung: 2, explicitProvider: 'xai', explicitModel: null, stop: false, reason: 'stronger-planner' };
    }
    // Otherwise skip to an alternate enabled core provider.
    const alt = pickAlternateProvider(usedProvider, enabledProviders);
    if (alt) {
      return { rung: 3, explicitProvider: alt, explicitModel: null, stop: false, reason: 'alternate-core-provider' };
    }
    return { rung: 4, explicitProvider: null, explicitModel: null, stop: true, reason: 'ladder-exhausted' };
  }

  if (currentRung === 2) {
    const alt = pickAlternateProvider(usedProvider, enabledProviders);
    if (alt) {
      return { rung: 3, explicitProvider: alt, explicitModel: null, stop: false, reason: 'alternate-core-provider' };
    }
    return { rung: 4, explicitProvider: null, explicitModel: null, stop: true, reason: 'ladder-exhausted' };
  }

  // Rung 3+ → human.
  return { rung: 4, explicitProvider: null, explicitModel: null, stop: true, reason: 'human' };
}

module.exports = {
  MAX_AUTOMATIC_RETRIES,
  ALTERNATE_PROVIDER_ORDER,
  isEscalationEnabled,
  isIndependentVerifierEnabled,
  pickAlternateProvider,
  nextRung
};
