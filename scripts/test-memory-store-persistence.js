#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-memory-persistence-'));
process.env.LIKU_HOME_OVERRIDE = path.join(tempRoot, '.liku');
process.env.LIKU_HOME_OLD_OVERRIDE = path.join(tempRoot, '.liku-cli');

const memoryStore = require(path.join(__dirname, '..', 'src', 'main', 'memory', 'memory-store.js'));

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

const createdIds = [];

function addNote(noteData) {
  const note = memoryStore.addNote(noteData);
  createdIds.push(note.id);
  return note;
}

function cleanup() {
  createdIds.forEach((id) => {
    try { memoryStore.removeNote(id); } catch {}
  });
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
}

test('memory store separates durable and task lanes with explicit retention', () => {
  const durable = addNote({
    type: 'procedural',
    content: 'Use the repo test seam to inspect and rerun focused scripts.',
    keywords: ['repo', 'tests', 'scripts'],
    tags: ['repo', 'procedure']
  });

  const task = addNote({
    type: 'episodic',
    content: 'Temporary execution note Authorization: Bearer github_pat_abcdefghijklmnopqrstuvwxyz1234567890',
    keywords: ['repo', 'tests', 'scripts'],
    tags: ['execution', 'temporary'],
    memoryLane: 'task'
  });

  assert.strictEqual(durable.persistence.lane, 'durable');
  assert.strictEqual(task.persistence.lane, 'task');
  assert.ok(task.persistence.retention.expiresAt);
  assert.ok(task.content.includes('[redacted token]'));

  const durableSelection = memoryStore.getRelevantNotes('inspect repo tests and rerun focused scripts', { limit: 5 });
  assert.ok(durableSelection.some((note) => note.id === durable.id));
  assert.ok(!durableSelection.some((note) => note.id === task.id));

  const mixedSelection = memoryStore.getRelevantNotes('inspect repo tests and rerun focused scripts', {
    limit: 5,
    includeTaskNotes: true
  });
  assert.ok(mixedSelection.some((note) => note.id === durable.id));
  assert.ok(mixedSelection.some((note) => note.id === task.id));
});

test('memory store prunes expired task-lane notes without touching durable notes', () => {
  const durable = addNote({
    type: 'semantic',
    content: 'Durable repo debugging knowledge should survive task cleanup.',
    keywords: ['repo', 'debugging'],
    tags: ['repo', 'durable']
  });

  const task = addNote({
    type: 'episodic',
    content: 'Short-lived task note for one execution batch.',
    keywords: ['repo', 'debugging'],
    tags: ['task'],
    memoryLane: 'task'
  });

  const expiresAtMs = Date.parse(task.persistence.retention.expiresAt);
  assert.ok(Number.isFinite(expiresAtMs));

  const prunedCount = memoryStore.pruneExpiredNotes(expiresAtMs + 1000);
  assert.ok(prunedCount >= 1);
  assert.strictEqual(memoryStore.getNote(task.id), null);
  assert.ok(memoryStore.getNote(durable.id));
});

process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(1);
});
