function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value, maxLength = 240) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (!Number.isFinite(Number(maxLength)) || maxLength <= 0 || text.length <= maxLength) {
    return text;
  }
  if (maxLength <= 1) {
    return text.slice(0, maxLength);
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

function sanitizeDecisionTraceValue(value, depth = 0) {
  if (value === undefined || value === null) return null;
  if (depth > 5) return null;

  const valueType = typeof value;
  if (valueType === 'string') return normalizeText(value, 320);
  if (valueType === 'number') return Number.isFinite(value) ? value : null;
  if (valueType === 'boolean') return value;

  if (Array.isArray(value)) {
    const sanitized = value
      .map((entry) => sanitizeDecisionTraceValue(entry, depth + 1))
      .filter((entry) => entry !== null)
      .slice(0, 16);
    return sanitized.length ? sanitized : null;
  }

  if (!isPlainObject(value)) {
    return normalizeText(String(value), 320);
  }

  const sanitized = {};
  Object.keys(value)
    .slice(0, 32)
    .forEach((key) => {
      const nextValue = sanitizeDecisionTraceValue(value[key], depth + 1);
      if (nextValue !== null) {
        sanitized[key] = nextValue;
      }
    });

  return Object.keys(sanitized).length ? sanitized : null;
}

function mergeDecisionTraceValues(baseValue, extraValue) {
  if (extraValue === null || extraValue === undefined) {
    return baseValue ?? null;
  }
  if (baseValue === null || baseValue === undefined) {
    return extraValue;
  }

  if (Array.isArray(baseValue) && Array.isArray(extraValue)) {
    const seen = new Set();
    const merged = [];
    [...baseValue, ...extraValue].forEach((entry) => {
      const fingerprint = JSON.stringify(entry);
      if (seen.has(fingerprint)) return;
      seen.add(fingerprint);
      merged.push(entry);
    });
    return merged.slice(0, 16);
  }

  if (isPlainObject(baseValue) && isPlainObject(extraValue)) {
    const merged = { ...baseValue };
    Object.keys(extraValue).forEach((key) => {
      merged[key] = mergeDecisionTraceValues(merged[key], extraValue[key]);
    });
    return merged;
  }

  return extraValue;
}

function normalizeTags(tags = []) {
  if (!Array.isArray(tags)) return null;
  const normalized = Array.from(new Set(tags
    .map((entry) => normalizeText(entry, 80))
    .filter(Boolean)));
  return normalized.length ? normalized.slice(0, 12) : null;
}

function inferExpectedSurface(context = {}) {
  const explicitSurface = normalizeText(
    context.expectedSurface
      || context.action?.verify?.target
      || context.checkpointSpec?.verifyTarget
      || context.observationCheckpoint?.verifyTarget
      || context.action?.searchSurfaceContract?.surface
      || context.action?.searchSurfaceContract?.target
      || context.action?.tradingViewShortcut?.surface
      || context.checkpointSpec?.classification
      || '',
    120
  );
  if (explicitSurface) {
    return explicitSurface.toLowerCase();
  }

  const actionType = String(context.action?.type || '').trim().toLowerCase();
  switch (actionType) {
    case 'focus_window':
    case 'bring_window_to_front':
    case 'restore_window':
      return 'application-window';
    case 'type':
      return 'active-input';
    case 'get_text':
      return 'review-surface';
    case 'click':
    case 'click_element':
    case 'double_click':
      return 'interactive-surface';
    default:
      return null;
  }
}

function buildBaseDecisionTraceEntry(stage, payload = {}, context = {}, deps = {}) {
  const summarizeAction = typeof deps.summarizeAction === 'function'
    ? deps.summarizeAction
    : null;

  const actionIndex = Number.isFinite(Number(payload.actionIndex ?? context.actionIndex))
    ? Number(payload.actionIndex ?? context.actionIndex)
    : null;
  const actionSummary = payload.action !== undefined
    ? payload.action
    : (context.action ? (summarizeAction ? summarizeAction(context.action) : context.action) : null);
  const entry = {
    stage: normalizeText(stage, 80),
    actionIndex,
    goal: normalizeText(
      payload.goal
      || context.goal
      || context.action?.reason
      || context.action?.description
      || context.actionData?.thought
      || '',
      280
    ),
    expectedSurface: inferExpectedSurface({
      ...context,
      expectedSurface: payload.expectedSurface
    }),
    action: sanitizeDecisionTraceValue(actionSummary),
    evidence: sanitizeDecisionTraceValue(payload.evidence),
    guardrails: sanitizeDecisionTraceValue(payload.guardrails),
    expectedOutcome: sanitizeDecisionTraceValue(payload.expectedOutcome),
    actualOutcome: sanitizeDecisionTraceValue(payload.actualOutcome),
    recoveryBranch: sanitizeDecisionTraceValue(payload.recoveryBranch),
    domain: normalizeText(payload.domain, 80),
    domainData: sanitizeDecisionTraceValue(payload.domainData),
    tags: normalizeTags(payload.tags)
  };

  const compacted = {};
  Object.keys(entry).forEach((key) => {
    if (entry[key] !== null && entry[key] !== undefined) {
      compacted[key] = entry[key];
    }
  });
  return compacted;
}

function applyDecisionTraceContributors(entry, stage, context = {}, contributors = []) {
  let mergedEntry = entry;
  const activeContributors = Array.isArray(contributors)
    ? contributors
      .map((entryValue) => entryValue?.contributor || entryValue)
      .filter((contributor) => contributor && typeof contributor === 'object')
    : [];

  for (const contributor of activeContributors) {
    try {
      if (typeof contributor.matchesContext === 'function' && contributor.matchesContext(context) !== true) {
        continue;
      }
      if (typeof contributor.enrich !== 'function') {
        continue;
      }

      const contribution = sanitizeDecisionTraceValue(contributor.enrich({
        stage,
        entry: mergedEntry,
        context
      }));
      if (!contribution || !isPlainObject(contribution)) {
        continue;
      }

      mergedEntry = mergeDecisionTraceValues(mergedEntry, contribution);
    } catch {}
  }

  return mergedEntry;
}

function createDecisionTraceEmitter(options = {}) {
  const {
    runtimeTraceLog = null,
    appendTraceEvent = null,
    contributors = [],
    summarizeAction = null
  } = options;

  return {
    emit(stage, payload = {}, context = {}) {
      const baseEntry = buildBaseDecisionTraceEntry(stage, payload, context, {
        summarizeAction
      });
      const entry = applyDecisionTraceContributors(baseEntry, stage, context, contributors);
      if (runtimeTraceLog && typeof appendTraceEvent === 'function') {
        appendTraceEvent(runtimeTraceLog, `decision:${String(stage || '').trim() || 'event'}`, entry);
      }
      return entry;
    }
  };
}

module.exports = {
  createDecisionTraceEmitter,
  inferExpectedSurface,
  sanitizeDecisionTraceValue
};
