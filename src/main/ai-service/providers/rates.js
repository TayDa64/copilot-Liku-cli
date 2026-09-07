// Phase 43: inference price table as CONFIG (not control-flow constants).
//
// Rates are ILLUSTRATIVE and MUST be verified at implement/deploy time. They can
// be overridden by pointing LIKU_INFERENCE_RATES_JSON at a JSON file with the
// same { provider: { model: { inputPerMillion, outputPerMillion } } } shape.
//
// A missing rate yields estimatedUsd === null — never 0 pretending "free". Never
// bake "provider X is always cheaper" into routing/control flow; this is data only.

const fs = require('fs');

// USD per 1,000,000 tokens. Verify against provider pricing before trusting spend.
const DEFAULT_RATES = {
  cerebras: {
    'gpt-oss-120b': { inputPerMillion: 0.35, outputPerMillion: 0.75 }
  },
  xai: {
    'grok-4.6': { inputPerMillion: 1.25, outputPerMillion: 2.50 },
    'grok-4.5': { inputPerMillion: 1.25, outputPerMillion: 2.50 },
    'grok-4.3': { inputPerMillion: 1.25, outputPerMillion: 2.50 }
  }
  // copilot / openai / anthropic / ollama intentionally omitted → estimatedUsd null.
};

function loadRates(env = process.env) {
  const jsonPath = env.LIKU_INFERENCE_RATES_JSON;
  if (!jsonPath) {
    return DEFAULT_RATES;
  }
  try {
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch (error) {
    console.warn(`[Inference] Could not load rate table from ${jsonPath}: ${error.message}`);
  }
  return DEFAULT_RATES;
}

function getRate(rates, provider, model) {
  const providerRates = rates && rates[provider];
  if (!providerRates) return null;
  const rate = providerRates[model];
  if (!rate || typeof rate.inputPerMillion !== 'number' || typeof rate.outputPerMillion !== 'number') {
    return null;
  }
  return rate;
}

// Returns estimated USD, or null when the rate is unknown or token counts are absent.
function estimateUsd(rates, provider, model, inputTokens, outputTokens) {
  const rate = getRate(rates, provider, model);
  if (!rate) return null;
  const haveInput = Number.isFinite(inputTokens);
  const haveOutput = Number.isFinite(outputTokens);
  if (!haveInput && !haveOutput) {
    return null;
  }
  const inTok = haveInput ? inputTokens : 0;
  const outTok = haveOutput ? outputTokens : 0;
  return (inTok / 1e6) * rate.inputPerMillion + (outTok / 1e6) * rate.outputPerMillion;
}

module.exports = {
  DEFAULT_RATES,
  loadRates,
  getRate,
  estimateUsd
};
