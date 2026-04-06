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
  evaluateProofExpectations,
  filterFixtures
} = require(path.join(__dirname, 'run-transcript-regressions.js'));
const {
  buildRuntimeTraceFixtureEntry
} = require(path.join(__dirname, 'extract-runtime-trace-regression.js'));

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

test('runtime trace fixtures preserve domain proof expectations and pass the combined runner', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-runtime-proof-fixtures-'));
  try {
    const entries = [
      {
        ts: '2026-04-05T22:41:10.000Z',
        session: 'runtime-proof-session',
        event: 'runtime:session:start',
        metadata: { mode: 'execute' }
      },
      {
        ts: '2026-04-05T22:41:10.050Z',
        session: 'runtime-proof-session',
        event: 'action:planned',
        actionIndex: 0,
        action: { type: 'key', key: 'enter', reason: 'Confirm the 5m timeframe in TradingView' }
      },
      {
        ts: '2026-04-05T22:41:10.100Z',
        session: 'runtime-proof-session',
        event: 'action:complete',
        actionIndex: 0,
        action: { type: 'key', key: 'enter', reason: 'Confirm the 5m timeframe in TradingView' },
        success: true
      },
      {
        ts: '2026-04-05T22:41:10.120Z',
        session: 'runtime-proof-session',
        event: 'action:proof',
        actionIndex: 0,
        action: { type: 'key', key: 'enter', reason: 'Confirm the 5m timeframe in TradingView' },
        proof: {
          proofId: 'proof-1',
          actionType: 'key',
          level: 3,
          levelName: 'domain-verified',
          status: 'verified',
          checks: [
            { kind: 'observation-checkpoint', status: 'pass', classification: 'chart-state' },
            { kind: 'domain-verification', status: 'pass', classification: 'chart-state', verificationKind: 'timeframe-updated' }
          ],
          observation: {
            classification: 'chart-state',
            verifyKind: 'timeframe-updated',
            verified: true,
            reason: 'TradingView shows the 5m timeframe'
          }
        },
        observationCheckpoint: {
          classification: 'chart-state',
          verifyKind: 'timeframe-updated',
          verified: true,
          reason: 'TradingView shows the 5m timeframe'
        }
      }
    ];

    const entry = buildRuntimeTraceFixtureEntry(entries, {
      fixtureName: 'runtime-proof-timeframe-updated',
      tracePath: 'C:/tmp/runtime-proof-session.jsonl'
    });

    assert.strictEqual(entry.traceMeta.sessionId, 'runtime-proof-session');
    assert.strictEqual(entry.actions.length, 1);
    assert.strictEqual(entry.proofExpectations.length, 1);
    assert.strictEqual(entry.proofExpectations[0].minProofLevel, 3);
    assert.strictEqual(entry.proofExpectations[0].verifyKind, 'timeframe-updated');
    assert.strictEqual(entry.proofExpectations[0].requiredCheckKind, 'domain-verification');
    assert.strictEqual(entry.proofExpectations[0].requiredCheckStatus, 'pass');

    const filePath = path.join(tempDir, 'bundle.json');
    upsertFixtureBundleEntry(filePath, 'runtime-proof-timeframe-updated', entry);

    const fixtures = loadTranscriptFixtures(tempDir);
    assert.strictEqual(fixtures.length, 1);
    assert.strictEqual(fixtures[0].suite.proofExpectations.length, 1);

    const proofEvaluation = evaluateProofExpectations(fixtures[0]);
    assert.strictEqual(proofEvaluation.passed, true);

    const results = evaluateFixtureCases(fixtures);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].passed, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runtime trace fixtures fall back to observation-checkpoint expectations when no domain proof exists', () => {
  const entries = [
    {
      ts: '2026-04-05T22:41:10.000Z',
      session: 'runtime-proof-panel-session',
      event: 'runtime:session:start',
      metadata: { mode: 'execute' }
    },
    {
      ts: '2026-04-05T22:41:10.050Z',
      session: 'runtime-proof-panel-session',
      event: 'action:planned',
      actionIndex: 0,
      action: { type: 'click', targetId: 'region-1', reason: 'Open Pine Editor' }
    },
    {
      ts: '2026-04-05T22:41:10.100Z',
      session: 'runtime-proof-panel-session',
      event: 'action:complete',
      actionIndex: 0,
      action: { type: 'click', targetId: 'region-1', reason: 'Open Pine Editor' },
      success: true,
      resolvedTarget: { targetId: 'region-1', resolutionMethod: 'clickPoint' }
    },
    {
      ts: '2026-04-05T22:41:10.120Z',
      session: 'runtime-proof-panel-session',
      event: 'action:proof',
      actionIndex: 0,
      action: { type: 'click', targetId: 'region-1', reason: 'Open Pine Editor' },
      proof: {
        proofId: 'proof-panel',
        actionType: 'click',
        level: 2,
        levelName: 'effect-verified',
        status: 'verified',
        checks: [
          { kind: 'target-resolution', status: 'pass', targetId: 'region-1', method: 'clickPoint' },
          { kind: 'observation-checkpoint', status: 'pass', classification: 'panel-open' }
        ],
        observation: {
          classification: 'panel-open',
          verifyKind: 'panel-open',
          verified: true,
          reason: 'Pine Editor visible'
        }
      },
      observationCheckpoint: {
        classification: 'panel-open',
        verifyKind: 'panel-open',
        verified: true,
        reason: 'Pine Editor visible'
      }
    }
  ];

  const entry = buildRuntimeTraceFixtureEntry(entries, {
    fixtureName: 'runtime-proof-panel-open',
    tracePath: 'C:/tmp/runtime-proof-panel-session.jsonl'
  });

  assert.strictEqual(entry.proofExpectations.length, 1);
  assert.strictEqual(entry.proofExpectations[0].verifyKind, 'panel-open');
  assert.strictEqual(entry.proofExpectations[0].requiredCheckKind, 'observation-checkpoint');
  assert.strictEqual(entry.proofExpectations[0].requiredCheckStatus, 'pass');
});