/**
 * Phase Parameters — generation parameter presets by execution phase.
 *
 * Execution phases use deterministic params (low temperature), while
 * reflection/planning phases use exploratory params (higher temperature).
 *
 * CRITICAL: Reasoning models (o1, o1-mini, o3-mini) reject temperature,
 * top_p, and top_k. getPhaseParams() strips these automatically.
 */

const PHASE_PARAMS = {
  execution:  { temperature: 0.1, top_p: 0.1 },
  planning:   { temperature: 0.4, top_p: 0.6 },
  reflection: { temperature: 0.7, top_p: 0.8 }
};

/**
 * Get generation parameters for a given phase, respecting model constraints.
 *
 * @param {'execution'|'planning'|'reflection'} phase
 * @param {object} [modelCapabilities] - From getModelCapabilities()
 * @returns {object} Parameter object safe to spread into API requests
 */
function getPhaseParams(phase, modelCapabilities) {
  const params = { ...(PHASE_PARAMS[phase] || PHASE_PARAMS.execution) };

  // Reasoning models reject temperature/top_p/top_k with 400 Bad Request
  if (modelCapabilities && modelCapabilities.reasoning) {
    delete params.temperature;
    delete params.top_p;
    delete params.top_k;
  }

  return params;
}

module.exports = { PHASE_PARAMS, getPhaseParams };
