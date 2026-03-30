#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildFixtureSkeleton,
  loadTranscriptFixtures,
  patternSpecToRegex,
  sanitizeFixtureName,
  upsertFixtureBundleEntry
} = require(path.join(__dirname, 'transcript-regression-fixtures.js'));
const {
  evaluateFixtureCases,
  filterFixtures
} = require(path.join(__dirname, 'run-transcript-regressions.js'));

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

test('sanitizeFixtureName normalizes runtime transcript names', () => {
  assert.strictEqual(sanitizeFixtureName(' Repo Boundary Recovery '), 'repo-boundary-recovery');
});

test('patternSpecToRegex supports object and literal forms', () => {
  assert(patternSpecToRegex({ regex: 'Provider:\\s+copilot', flags: 'i' }).test('Provider: copilot'));
  assert(patternSpecToRegex('/hello/i').test('Hello'));
  assert(patternSpecToRegex('TradingView').test('tradingview'));
});

test('buildFixtureSkeleton derives prompts turns and placeholder expectations', () => {
  const transcript = [
    'Provider: copilot',
    'Copilot: Authenticated',
    '> MUSE is a different repo, this is copilot-liku-cli.',
    '[copilot:stub]',
    'Understood. MUSE is a different repo and this session is in copilot-liku-cli.'
  ].join('\n');

  const skeleton = buildFixtureSkeleton({
    fixtureName: 'Repo Boundary Clarification',
    transcript,
    sourceTracePath: 'C:/tmp/repo-boundary.log'
  });

  assert.strictEqual(skeleton.fixtureName, 'repo-boundary-clarification');
  assert.deepStrictEqual(skeleton.entry.prompts, ['MUSE is a different repo, this is copilot-liku-cli.']);
  assert.strictEqual(skeleton.entry.assistantTurns.length, 1);
  assert(skeleton.entry.expectations.length >= 1, 'skeleton should include at least one suggested expectation');
});

test('fixture bundle loader materializes JSON fixture entries', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-transcript-fixtures-'));
  try {
    const filePath = path.join(tempDir, 'bundle.json');
    const skeleton = buildFixtureSkeleton({
      fixtureName: 'forgone-feature',
      transcript: [
        'Forgone features: terminal-liku ui',
        '> Should terminal-liku ui be part of the plan right now? Reply briefly.',
        '[copilot:stub]',
        'No. It is a forgone feature and should stay out of scope until you explicitly re-enable it.'
      ].join('\n')
    });
    skeleton.entry.expectations = [{
      name: 'forgone feature remains out of scope',
      turn: 1,
      include: [{ regex: 'forgone feature', flags: 'i' }],
      exclude: [{ regex: 'top priority', flags: 'i' }]
    }];

    upsertFixtureBundleEntry(filePath, skeleton.fixtureName, skeleton.entry);
    const fixtures = loadTranscriptFixtures(tempDir);
    assert.strictEqual(fixtures.length, 1);
    assert.strictEqual(fixtures[0].name, 'forgone-feature');
    assert.strictEqual(fixtures[0].suite.expectations.length, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fixture runner evaluates checked-in transcript fixtures', () => {
  const fixtures = loadTranscriptFixtures(path.join(__dirname, 'fixtures', 'transcripts'));
  const selected = filterFixtures(fixtures, { fixture: 'repo-boundary-clarification-runtime' });
  assert.strictEqual(selected.length, 1, 'expected checked-in repo-boundary transcript fixture');
  const results = evaluateFixtureCases(selected);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].passed, true);
});