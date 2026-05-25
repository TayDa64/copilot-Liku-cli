#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-memory-portability-'));
process.env.LIKU_HOME_OVERRIDE = path.join(tempRoot, '.liku');
process.env.LIKU_HOME_OLD_OVERRIDE = path.join(tempRoot, '.liku-cli-old');

const aiService = require(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'));

let pass = 0;

function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

function clearAllNotes() {
  const notesMap = aiService.memoryStore.listNotes();
  Object.keys(notesMap).forEach((id) => aiService.memoryStore.removeNote(id));
}

function listFullNotes() {
  const notesMap = aiService.memoryStore.listNotes();
  return Object.keys(notesMap)
    .map((id) => aiService.memoryStore.getNote(id))
    .filter(Boolean);
}

test('exportDurableMemory exports only durable notes with review metadata', () => {
  clearAllNotes();

  const durable = aiService.memoryStore.addNote({
    type: 'semantic',
    content: 'Persist repo guidance but redact api_key=super-secret if encountered.',
    context: {
      body: 'A durable memory export should not leak raw issue-style body text.',
      authorization: 'Bearer github_pat_abcdefghijklmnopqrstuvwxyz1234567890',
    },
    keywords: ['repo', 'guidance'],
    tags: ['durable'],
    source: { kind: 'manual-test' },
  });
  aiService.memoryStore.addNote({
    type: 'episodic',
    content: 'Task-local scratch note that should not be exported.',
    keywords: ['scratch'],
    tags: ['task'],
    memoryLane: 'task',
    source: { kind: 'manual-test' },
  });

  const exportPath = path.join(tempRoot, 'durable-memory-export.json');
  const exported = aiService.exportDurableMemory(exportPath);
  const exportedText = fs.readFileSync(exportPath, 'utf8');

  assert.strictEqual(exported.schemaVersion, 'liku.memory-export.v1');
  assert.strictEqual(exported.exportKind, 'durable-memory');
  assert.strictEqual(exported.summary.noteCount, 1);
  assert.strictEqual(exported.notes.length, 1);
  assert.strictEqual(exported.notes[0].sourceNoteId, durable.id);
  assert.strictEqual(exported.notes[0].persistence.lane, 'durable');
  assert.strictEqual(exported.review.exportKind, 'durable-memory');
  assert.strictEqual(exported.review.reviewRequired, true);
  assert.strictEqual(exported.artifact.filePath, exportPath);
  assert.ok(!exportedText.includes('super-secret'));
  assert.ok(!exportedText.includes('github_pat_'));
  assert.ok(!exportedText.includes('Task-local scratch note'));
});

test('importDurableMemory imports reviewed durable notes and skips duplicates on re-import', () => {
  clearAllNotes();

  aiService.memoryStore.addNote({
    type: 'procedural',
    content: 'Use reviewed exports for durable portability.',
    keywords: ['reviewed', 'export'],
    tags: ['durable'],
    source: { kind: 'portability-test' },
  });

  const exportPath = path.join(tempRoot, 'durable-import-source.json');
  const exported = aiService.exportDurableMemory(exportPath);

  clearAllNotes();
  const imported = aiService.importDurableMemory(exportPath);
  const importedNotes = listFullNotes();

  assert.strictEqual(imported.schemaVersion, 'liku.memory-import-result.v1');
  assert.strictEqual(imported.importKind, 'durable-memory');
  assert.strictEqual(imported.sourcePath, exportPath);
  assert.strictEqual(imported.exportId, exported.exportId);
  assert.strictEqual(imported.importedCount, 1);
  assert.strictEqual(imported.skippedCount, 0);
  assert.strictEqual(importedNotes.length, 1);
  assert.strictEqual(importedNotes[0].persistence.lane, 'durable');
  assert.strictEqual(importedNotes[0].source.memoryImport.exportId, exported.exportId);
  assert.ok(importedNotes[0].source.memoryImport.importKey);

  const secondImport = aiService.importDurableMemory(exportPath);
  assert.strictEqual(secondImport.importedCount, 0);
  assert.strictEqual(secondImport.skippedCount, 1);
  assert.strictEqual(secondImport.skipped[0].reason, 'duplicate-import');
});

test('handleCommand supports /memory export and /memory import', () => {
  clearAllNotes();

  aiService.memoryStore.addNote({
    type: 'semantic',
    content: 'Portable durable memory note for slash-command flow.',
    keywords: ['portable', 'durable'],
    tags: ['durable'],
    source: { kind: 'command-test' },
  });

  const exportPath = path.join(tempRoot, 'slash-memory-export.json');
  const exportResult = aiService.handleCommand(`/memory export ${exportPath}`);
  assert.ok(exportResult);
  assert.strictEqual(exportResult.type, 'info');
  assert.ok(exportResult.message.includes('Exported durable memory to'));
  assert.ok(exportResult.data);
  assert.strictEqual(exportResult.data.artifact.filePath, exportPath);
  assert.ok(fs.existsSync(exportPath));

  clearAllNotes();
  const importResult = aiService.handleCommand(`/memory import ${exportPath}`);
  assert.ok(importResult);
  assert.strictEqual(importResult.type, 'info');
  assert.ok(importResult.message.includes('Imported durable memory from'));
  assert.ok(importResult.data);
  assert.strictEqual(importResult.data.importedCount, 1);
});

console.log(`PASS memory portability (${pass} assertions)`);

clearAllNotes();
fs.rmSync(tempRoot, { recursive: true, force: true });
