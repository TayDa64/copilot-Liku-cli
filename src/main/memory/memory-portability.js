const fs = require('fs');
const path = require('path');

const memoryStore = require('./memory-store');
const {
  buildExportReview,
  normalizeIsoTimestamp,
  sanitizePersistedValue,
} = require('../persistence-controls');

const DURABLE_MEMORY_EXPORT_SCHEMA_VERSION = 'liku.memory-export.v1';
const DURABLE_MEMORY_IMPORT_RESULT_SCHEMA_VERSION = 'liku.memory-import-result.v1';

function normalizeStringArray(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)));
}

function normalizeMemoryLane(value, fallback = 'durable') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'task' || normalized === 'durable' ? normalized : fallback;
}

function buildDurableMemoryExportId() {
  return `memory-export-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildDefaultExportPath(cwd, exportId, exportedAt) {
  const datePart = String(exportedAt || new Date().toISOString()).slice(0, 10);
  return path.join(cwd, `liku-durable-memory-${datePart}-${exportId}.json`);
}

function resolvePortablePath(filePath, cwd) {
  const requestedPath = String(filePath || '').trim();
  if (!requestedPath) return null;
  return path.isAbsolute(requestedPath)
    ? requestedPath
    : path.resolve(cwd || process.cwd(), requestedPath);
}

function buildExportSummary(notes = []) {
  const typeCounts = {};
  notes.forEach((note) => {
    const type = String(note?.type || 'episodic').trim() || 'episodic';
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  });

  return {
    noteCount: notes.length,
    typeCounts,
  };
}

function getDurableNotes() {
  const notesMap = memoryStore.listNotes();
  return Object.entries(notesMap)
    .filter(([, entry]) => normalizeMemoryLane(entry?.memoryLane || entry?.persistence?.lane) === 'durable')
    .map(([id]) => memoryStore.getNote(id))
    .filter(Boolean);
}

function buildExportNoteRecord(note = {}) {
  return {
    sourceNoteId: note.id || null,
    type: note.type || 'episodic',
    content: note.content || '',
    context: note.context === undefined ? '' : note.context,
    keywords: normalizeStringArray(note.keywords),
    tags: normalizeStringArray(note.tags),
    scope: note.scope || null,
    source: note.source || null,
    createdAt: note.createdAt || null,
    updatedAt: note.updatedAt || null,
    persistence: {
      lane: 'durable',
      sensitivity: note.persistence?.sensitivity || 'internal',
      retention: note.persistence?.retention || null,
    },
  };
}

function exportDurableMemory(options = {}) {
  const cwd = path.resolve(String(options.cwd || process.cwd()));
  const exportedAt = normalizeIsoTimestamp(options.exportedAt, new Date().toISOString());
  const exportId = String(options.exportId || buildDurableMemoryExportId()).trim() || buildDurableMemoryExportId();
  const durableNotes = getDurableNotes();
  const redactions = [];

  const notes = durableNotes.map((note, index) => {
    const sanitized = sanitizePersistedValue(buildExportNoteRecord(note), {
      path: ['durableMemoryExport', 'notes', String(index)],
    });
    redactions.push(...sanitized.redactions);
    return sanitized.value;
  });

  const resolvedPath = resolvePortablePath(options.destinationPath || options.filePath, cwd)
    || buildDefaultExportPath(cwd, exportId, exportedAt);

  const record = {
    schemaVersion: DURABLE_MEMORY_EXPORT_SCHEMA_VERSION,
    exportKind: 'durable-memory',
    exportId,
    exportedAt,
    summary: buildExportSummary(notes),
    notes,
    review: buildExportReview({
      exportKind: 'durable-memory',
      redactions,
      reviewRequired: true,
    }),
    artifact: {
      filePath: resolvedPath,
    },
  };

  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, JSON.stringify(record, null, 2), 'utf8');
  return record;
}

function buildImportKey(exportId, sourceNoteId, fallbackIndex) {
  return `${String(exportId || 'unknown-export').trim() || 'unknown-export'}:${String(sourceNoteId || fallbackIndex).trim() || String(fallbackIndex)}`;
}

function collectExistingImportKeys() {
  const existing = new Set();
  const notesMap = memoryStore.listNotes();
  Object.keys(notesMap).forEach((id) => {
    const note = memoryStore.getNote(id);
    const importKey = note?.source?.memoryImport?.importKey;
    if (importKey) {
      existing.add(String(importKey));
      return;
    }
    const exportId = note?.source?.memoryImport?.exportId;
    const sourceNoteId = note?.source?.memoryImport?.sourceNoteId;
    if (exportId && sourceNoteId) {
      existing.add(buildImportKey(exportId, sourceNoteId, id));
    }
  });
  return existing;
}

function importDurableMemory(options = {}) {
  const cwd = path.resolve(String(options.cwd || process.cwd()));
  const sourcePath = resolvePortablePath(options.sourcePath || options.filePath, cwd);
  if (!sourcePath) {
    throw new Error('A durable memory export file path is required.');
  }
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Durable memory export file not found: ${sourcePath}`);
  }

  const parsed = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  if (parsed?.schemaVersion !== DURABLE_MEMORY_EXPORT_SCHEMA_VERSION || parsed?.exportKind !== 'durable-memory') {
    throw new Error('Unsupported durable memory export schema.');
  }
  if (!parsed.review || parsed.review.exportKind !== 'durable-memory') {
    throw new Error('Durable memory import requires review metadata.');
  }
  if (!Array.isArray(parsed.notes)) {
    throw new Error('Durable memory export notes payload is invalid.');
  }

  const existingImportKeys = collectExistingImportKeys();
  const importedIds = [];
  const skipped = [];
  const importedAt = new Date().toISOString();

  parsed.notes.forEach((entry, index) => {
    const lane = normalizeMemoryLane(entry?.persistence?.lane, 'durable');
    const importKey = buildImportKey(parsed.exportId, entry?.sourceNoteId, index);

    if (lane !== 'durable') {
      skipped.push({ sourceNoteId: entry?.sourceNoteId || null, reason: 'non-durable-lane' });
      return;
    }
    if (existingImportKeys.has(importKey)) {
      skipped.push({ sourceNoteId: entry?.sourceNoteId || null, reason: 'duplicate-import' });
      return;
    }

    const imported = memoryStore.addNote({
      type: entry?.type || 'episodic',
      content: entry?.content || '',
      context: entry?.context === undefined ? '' : entry.context,
      keywords: normalizeStringArray(entry?.keywords),
      tags: normalizeStringArray(entry?.tags),
      scope: entry?.scope || null,
      source: {
        memoryImport: {
          schemaVersion: parsed.schemaVersion,
          exportId: parsed.exportId || null,
          sourceNoteId: entry?.sourceNoteId || null,
          sourcePath,
          importedAt,
          importKey,
        },
        originalSource: entry?.source || null,
      },
      memoryLane: 'durable',
    });

    existingImportKeys.add(importKey);
    importedIds.push(imported.id);
  });

  return {
    schemaVersion: DURABLE_MEMORY_IMPORT_RESULT_SCHEMA_VERSION,
    importKind: 'durable-memory',
    sourcePath,
    exportId: parsed.exportId || null,
    totalNotes: parsed.notes.length,
    importedCount: importedIds.length,
    skippedCount: skipped.length,
    importedIds,
    skipped,
    review: parsed.review,
  };
}

module.exports = {
  DURABLE_MEMORY_EXPORT_SCHEMA_VERSION,
  DURABLE_MEMORY_IMPORT_RESULT_SCHEMA_VERSION,
  exportDurableMemory,
  importDurableMemory,
};
