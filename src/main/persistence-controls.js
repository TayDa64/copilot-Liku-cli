/**
 * Phase 5 persistence controls.
 *
 * Centralizes classification, retention, and redaction helpers for task memory,
 * durable knowledge, session state, and export flows.
 */

const PERSISTENCE_ENTRY_SCHEMA_VERSION = 'liku.persistence-entry.v1';
const PERSISTENCE_EXPORT_REVIEW_SCHEMA_VERSION = 'liku.persistence-export-review.v1';

const MEMORY_LANE_DURABLE = 'durable';
const MEMORY_LANE_TASK = 'task';

const HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TASK_MEMORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_STATE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

const FIELD_KIND_RULES = [
  {
    pattern: /^(authorization|access[_-]?token|refresh[_-]?token|session[_-]?token|api[_-]?key|secret|password|passwd|cookie|set-cookie|copilot[_-]?token|github[_-]?token)$/i,
    kind: 'secret'
  },
  {
    pattern: /^(body|issue[_-]?body|comment[_-]?body|discussion[_-]?body)$/i,
    kind: 'issue-body'
  },
  {
    pattern: /^(patch(?:preview|[_-]?preview)?|diff|text[_-]?diff|raw[_-]?diff)$/i,
    kind: 'diff'
  },
  {
    pattern: /^(workflow[_-]?log|job[_-]?log|step[_-]?log|stdout|stderr|logs?)$/i,
    kind: 'workflow-log'
  }
];

function nowIso() {
  return new Date().toISOString();
}

function normalizeIsoTimestamp(value, fallback = nowIso()) {
  const parsed = Date.parse(String(value || '').trim());
  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString()
    : fallback;
}

function addMsToIso(baseIso, durationMs) {
  if (!Number.isFinite(Number(durationMs)) || Number(durationMs) <= 0) return null;
  const baseMs = Date.parse(String(baseIso || '').trim());
  const resolvedBaseMs = Number.isFinite(baseMs) ? baseMs : Date.now();
  return new Date(resolvedBaseMs + Number(durationMs)).toISOString();
}

function countLines(value) {
  const text = String(value || '');
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}

function normalizePath(pathParts = []) {
  return Array.isArray(pathParts) && pathParts.length > 0
    ? pathParts.join('.')
    : null;
}

function buildPlaceholder(kind, value) {
  const length = String(value || '').length;
  const lineCount = countLines(value);
  const label = kind === 'issue-body'
    ? 'issue body'
    : kind === 'workflow-log'
      ? 'workflow log'
      : kind === 'diff'
        ? 'diff'
        : kind === 'token'
          ? 'token'
          : 'secret';
  return `[redacted ${label}; ${length} chars, ${lineCount} lines]`;
}

function buildRedaction(kind, pathParts, value, extra = {}) {
  return {
    kind: String(kind || 'unknown').trim() || 'unknown',
    path: normalizePath(pathParts),
    originalLength: String(value || '').length,
    lineCount: countLines(value),
    ...extra
  };
}

function normalizeRedactions(redactions = []) {
  return (Array.isArray(redactions) ? redactions : [])
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      return {
        kind: String(entry.kind || 'unknown').trim() || 'unknown',
        path: entry.path ? String(entry.path).trim() : null,
        originalLength: Number.isFinite(Number(entry.originalLength)) ? Number(entry.originalLength) : 0,
        lineCount: Number.isFinite(Number(entry.lineCount)) ? Number(entry.lineCount) : 0,
        replacement: entry.replacement ? String(entry.replacement).trim() : null
      };
    })
    .filter(Boolean);
}

function deriveSensitivityLevel(redactions = [], fallback = 'internal') {
  const kinds = new Set(normalizeRedactions(redactions).map((entry) => entry.kind));
  if (kinds.has('secret') || kinds.has('token')) return 'restricted';
  if (kinds.has('issue-body') || kinds.has('diff') || kinds.has('workflow-log')) return 'high';
  return String(fallback || 'internal').trim() || 'internal';
}

function detectFieldKind(key) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return null;
  const match = FIELD_KIND_RULES.find((rule) => rule.pattern.test(normalizedKey));
  return match ? match.kind : null;
}

function looksLikeDiff(text) {
  const normalized = String(text || '');
  if (!normalized) return false;

  let signalCount = 0;
  if (/```diff[\s\S]*```/i.test(normalized)) signalCount += 2;
  if (/^diff --git /m.test(normalized)) signalCount += 2;
  if (/^@@ /m.test(normalized)) signalCount += 1;
  if (/^\+\+\+ /m.test(normalized)) signalCount += 1;
  if (/^--- /m.test(normalized)) signalCount += 1;
  return signalCount >= 2;
}

function looksLikeWorkflowLog(text) {
  const normalized = String(text || '');
  if (!normalized) return false;

  let signalCount = 0;
  const markers = [
    '##[group]',
    '##[error]',
    '##[warning]',
    '::debug::',
    '::error::',
    'Current runner version:',
    'Runner Image Provisioner',
    'GITHUB_TOKEN'
  ];

  markers.forEach((marker) => {
    if (normalized.includes(marker)) signalCount += 1;
  });

  if ((normalized.match(/^Run .+/gm) || []).length >= 2) signalCount += 1;
  if ((normalized.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/gm) || []).length >= 3) signalCount += 1;

  return signalCount >= 2;
}

function sanitizeTextByKind(text, kind, pathParts) {
  const normalizedText = String(text || '');
  if (!normalizedText) return { value: normalizedText, redactions: [] };

  return {
    value: buildPlaceholder(kind, normalizedText),
    redactions: [buildRedaction(kind, pathParts, normalizedText)]
  };
}

function sanitizePersistedText(value, options = {}) {
  const fieldKind = options.fieldKind || null;
  const pathParts = Array.isArray(options.path) ? options.path : [];
  let text = String(value ?? '');
  const redactions = [];
  const tokenPlaceholder = '__LIKU_REDACTED_TOKEN__';
  const secretPlaceholder = '__LIKU_REDACTED_SECRET__';

  if (!text) {
    return { value: text, redactions };
  }

  if (fieldKind === 'secret') {
    return sanitizeTextByKind(text, 'secret', pathParts);
  }
  if (fieldKind === 'issue-body' || fieldKind === 'diff' || fieldKind === 'workflow-log') {
    return sanitizeTextByKind(text, fieldKind, pathParts);
  }

  const replaceWithLiteral = (regex, replacement, kind) => {
    text = text.replace(regex, (match) => {
      redactions.push(buildRedaction(kind, pathParts, match, { replacement }));
      return replacement;
    });
  };

  replaceWithLiteral(/\bAuthorization\s*:\s*(?:token|Bearer)\s+[^\s]+/gi, `Authorization: ${tokenPlaceholder}`, 'token');
  replaceWithLiteral(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, `Bearer ${tokenPlaceholder}`, 'token');
  replaceWithLiteral(/\bgithub_pat_[A-Za-z0-9_]+\b/g, tokenPlaceholder, 'token');
  replaceWithLiteral(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, tokenPlaceholder, 'token');

  text = text.replace(/\b(api[ _-]?key|access[ _-]?token|refresh[ _-]?token|session[ _-]?token|secret|password)\b\s*([:=])\s*([^\s,;]+)/gi, (match, key, separator, secretValue) => {
    redactions.push(buildRedaction('secret', pathParts, secretValue, { replacement: '[redacted secret]' }));
    return `${key}${separator} ${secretPlaceholder}`;
  });

  text = text.replace(new RegExp(tokenPlaceholder, 'g'), '[redacted token]');
  text = text.replace(new RegExp(secretPlaceholder, 'g'), '[redacted secret]');

  if (looksLikeDiff(text)) {
    return {
      value: buildPlaceholder('diff', text),
      redactions: [...redactions, buildRedaction('diff', pathParts, text)]
    };
  }

  if (looksLikeWorkflowLog(text)) {
    return {
      value: buildPlaceholder('workflow-log', text),
      redactions: [...redactions, buildRedaction('workflow-log', pathParts, text)]
    };
  }

  return { value: text, redactions };
}

function sanitizePersistedValue(value, options = {}) {
  const pathParts = Array.isArray(options.path) ? options.path : [];

  if (value === null || value === undefined) {
    return { value, redactions: [] };
  }

  if (typeof value === 'string') {
    return sanitizePersistedText(value, { ...options, path: pathParts });
  }

  if (Array.isArray(value)) {
    const nextValue = [];
    const redactions = [];
    value.forEach((entry, index) => {
      const sanitized = sanitizePersistedValue(entry, {
        ...options,
        fieldKind: null,
        path: pathParts.concat(String(index))
      });
      nextValue.push(sanitized.value);
      redactions.push(...sanitized.redactions);
    });
    return { value: nextValue, redactions };
  }

  if (typeof value === 'object') {
    const nextValue = {};
    const redactions = [];
    for (const [key, entryValue] of Object.entries(value)) {
      if (key === 'persistence' || key === 'review') {
        nextValue[key] = entryValue;
        continue;
      }
      const fieldKind = detectFieldKind(key);
      let sanitized;
      if (fieldKind) {
        if (typeof entryValue === 'string') {
          sanitized = sanitizeTextByKind(entryValue, fieldKind === 'secret' ? 'secret' : fieldKind, pathParts.concat(key));
        } else if (entryValue === null || entryValue === undefined) {
          sanitized = { value: entryValue, redactions: [] };
        } else {
          sanitized = sanitizeTextByKind(JSON.stringify(entryValue, null, 2), fieldKind === 'secret' ? 'secret' : fieldKind, pathParts.concat(key));
        }
      } else {
        sanitized = sanitizePersistedValue(entryValue, {
          ...options,
          fieldKind: null,
          path: pathParts.concat(key)
        });
      }
      nextValue[key] = sanitized.value;
      redactions.push(...sanitized.redactions);
    }
    return { value: nextValue, redactions };
  }

  return { value, redactions: [] };
}

function normalizeMemoryLane(value, fallback = MEMORY_LANE_DURABLE) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === MEMORY_LANE_TASK || normalized === MEMORY_LANE_DURABLE) {
    return normalized;
  }
  return fallback;
}

function buildPersistenceMetadata(options = {}) {
  const recordedAt = normalizeIsoTimestamp(options.recordedAt, nowIso());
  const maxAgeMs = Number.isFinite(Number(options.maxAgeMs)) ? Number(options.maxAgeMs) : null;
  const expiresAt = options.expiresAt
    ? normalizeIsoTimestamp(options.expiresAt, addMsToIso(recordedAt, maxAgeMs) || recordedAt)
    : addMsToIso(recordedAt, maxAgeMs);
  const redactions = normalizeRedactions(options.redactions);

  return {
    schemaVersion: PERSISTENCE_ENTRY_SCHEMA_VERSION,
    store: String(options.store || '').trim() || null,
    lane: String(options.lane || '').trim() || null,
    sensitivity: deriveSensitivityLevel(redactions, options.sensitivity || 'internal'),
    recordedAt,
    retention: {
      kind: String(options.retentionKind || '').trim() || 'manual',
      maxAgeMs,
      expiresAt
    },
    redactionCount: redactions.length,
    redactions: redactions.slice(0, 12)
  };
}

function buildConversationHistoryEntry(entry, options = {}) {
  const baseEntry = entry && typeof entry === 'object'
    ? { ...entry }
    : { role: 'assistant', content: String(entry || '') };

  const recordedAt = normalizeIsoTimestamp(baseEntry.recordedAt || baseEntry.createdAt, nowIso());

  if (baseEntry.persistence?.schemaVersion === PERSISTENCE_ENTRY_SCHEMA_VERSION
    && baseEntry.persistence?.store === 'conversation-history') {
    return {
      ...baseEntry,
      role: String(baseEntry.role || 'assistant').trim() || 'assistant',
      content: String(baseEntry.content || ''),
      recordedAt,
      persistence: buildPersistenceMetadata({
        store: 'conversation-history',
        lane: MEMORY_LANE_TASK,
        sensitivity: baseEntry.persistence?.sensitivity || 'internal',
        recordedAt,
        retentionKind: baseEntry.persistence?.retention?.kind || 'rolling-task-history',
        maxAgeMs: baseEntry.persistence?.retention?.maxAgeMs || options.maxAgeMs || HISTORY_RETENTION_MS,
        redactions: baseEntry.persistence?.redactions || []
      })
    };
  }

  delete baseEntry.persistence;
  baseEntry.role = String(baseEntry.role || 'assistant').trim() || 'assistant';
  baseEntry.content = String(baseEntry.content || '');
  baseEntry.recordedAt = recordedAt;

  const sanitized = sanitizePersistedValue(baseEntry, { path: ['conversationHistory'] });
  return {
    ...sanitized.value,
    recordedAt,
    persistence: buildPersistenceMetadata({
      store: 'conversation-history',
      lane: MEMORY_LANE_TASK,
      sensitivity: 'internal',
      recordedAt,
      retentionKind: 'rolling-task-history',
      maxAgeMs: options.maxAgeMs || HISTORY_RETENTION_MS,
      redactions: sanitized.redactions
    })
  };
}

function buildMemoryNotePersistence(options = {}) {
  const lane = normalizeMemoryLane(options.lane, MEMORY_LANE_DURABLE);
  const maxAgeMs = lane === MEMORY_LANE_TASK
    ? (Number.isFinite(Number(options.maxAgeMs)) ? Number(options.maxAgeMs) : TASK_MEMORY_RETENTION_MS)
    : null;

  return buildPersistenceMetadata({
    store: 'memory-note',
    lane,
    sensitivity: lane === MEMORY_LANE_TASK ? 'internal' : 'internal',
    recordedAt: options.recordedAt,
    retentionKind: lane === MEMORY_LANE_TASK ? 'task-ttl' : 'durable-knowledge',
    maxAgeMs,
    redactions: options.redactions
  });
}

function buildSessionStatePersistence(options = {}) {
  return buildPersistenceMetadata({
    store: 'session-intent-state',
    lane: MEMORY_LANE_TASK,
    sensitivity: 'internal',
    recordedAt: options.recordedAt,
    retentionKind: 'active-session-state',
    maxAgeMs: Number.isFinite(Number(options.maxAgeMs)) ? Number(options.maxAgeMs) : SESSION_STATE_RETENTION_MS,
    redactions: options.redactions
  });
}

function isPersistenceEntryExpired(entry, referenceTime = Date.now()) {
  const expiresAt = entry?.persistence?.retention?.expiresAt || entry?.expiresAt || null;
  const expiresAtMs = Date.parse(String(expiresAt || '').trim());
  return Number.isFinite(expiresAtMs) && referenceTime >= expiresAtMs;
}

function buildExportReview(options = {}) {
  const redactions = normalizeRedactions(options.redactions);
  const sensitivity = deriveSensitivityLevel(redactions, options.sensitivity || 'internal');
  const reasons = [];

  if (redactions.length > 0) {
    reasons.push(`Applied ${redactions.length} persistence redaction(s).`);
  }
  if (sensitivity === 'restricted') {
    reasons.push('Restricted material was sanitized before export.');
  } else if (sensitivity === 'high') {
    reasons.push('High-sensitivity content was minimized before export.');
  }
  if (options.reviewRequired === true) {
    reasons.push('Explicit review is required before sharing this export.');
  }

  return {
    schemaVersion: PERSISTENCE_EXPORT_REVIEW_SCHEMA_VERSION,
    exportKind: String(options.exportKind || '').trim() || 'generic-export',
    sensitivity,
    redactionCount: redactions.length,
    reviewRequired: options.reviewRequired === true,
    reviewRecommended: redactions.length > 0 || sensitivity === 'restricted' || sensitivity === 'high',
    reasons,
    redactions: redactions.slice(0, 12)
  };
}

function sanitizeJsonLinesForExport(text, options = {}) {
  const sourceText = String(text || '');
  const trailingNewline = /\r?\n$/.test(sourceText);
  const inputLines = sourceText.split(/\r?\n/);
  const outputLines = [];
  const redactions = [];

  inputLines.forEach((line, index) => {
    if (!line) {
      outputLines.push(line);
      return;
    }

    try {
      const parsed = JSON.parse(line);
      const sanitized = sanitizePersistedValue(parsed, {
        path: [String(options.exportKind || 'export'), String(index)]
      });
      outputLines.push(JSON.stringify(sanitized.value));
      redactions.push(...sanitized.redactions);
    } catch {
      const sanitized = sanitizePersistedText(line, {
        path: [String(options.exportKind || 'export'), String(index)]
      });
      outputLines.push(sanitized.value);
      redactions.push(...sanitized.redactions);
    }
  });

  let outputText = outputLines.join('\n');
  if (trailingNewline && !outputText.endsWith('\n')) {
    outputText += '\n';
  }

  return {
    text: outputText,
    redactions: normalizeRedactions(redactions),
    review: buildExportReview({
      exportKind: options.exportKind || 'generic-export',
      redactions
    })
  };
}

module.exports = {
  PERSISTENCE_ENTRY_SCHEMA_VERSION,
  PERSISTENCE_EXPORT_REVIEW_SCHEMA_VERSION,
  MEMORY_LANE_DURABLE,
  MEMORY_LANE_TASK,
  HISTORY_RETENTION_MS,
  TASK_MEMORY_RETENTION_MS,
  SESSION_STATE_RETENTION_MS,
  addMsToIso,
  buildConversationHistoryEntry,
  buildExportReview,
  buildMemoryNotePersistence,
  buildPersistenceMetadata,
  buildSessionStatePersistence,
  deriveSensitivityLevel,
  isPersistenceEntryExpired,
  normalizeIsoTimestamp,
  normalizeMemoryLane,
  sanitizeJsonLinesForExport,
  sanitizePersistedText,
  sanitizePersistedValue
};
