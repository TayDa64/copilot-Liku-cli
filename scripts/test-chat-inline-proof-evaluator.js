#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const { SUITES, evaluateTranscript, extractAssistantTurns, extractObservedModelHeaders, buildProofInput, buildRequestedModelLabel } = require(path.join(__dirname, 'run-chat-inline-proof.js'));

test('extractAssistantTurns splits assistant responses', () => {
  const transcript = [
    '> prompt one',
    '[copilot:stub]',
    'First response',
    '> prompt two',
    '[copilot:stub]',
    'Second response'
  ].join('\n');

  const turns = extractAssistantTurns(transcript);
  assert.deepStrictEqual(turns, ['First response', 'Second response']);
});

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

test('evaluator passes direct-navigation transcript', () => {
  const transcript = [
    'Provider: copilot',
    'Copilot: Authenticated',
    '[copilot:stub]',
    'First turn',
    '> prompt two',
    '[copilot:stub]',
    'bring_window_to_front',
    'ctrl+l',
    'https://www.apple.com',
    'Navigate directly to apple.com',
    '> prompt three',
    '[copilot:stub]',
    'Confirmed',
    'No further actions needed'
  ].join('\n');

  const evaluation = evaluateTranscript(transcript, SUITES['direct-navigation']);
  assert.strictEqual(evaluation.passed, true);
});

test('evaluator rejects forbidden search detour', () => {
  const transcript = [
    'Provider: copilot',
    'Copilot: Authenticated',
    '[copilot:stub]',
    'First turn',
    '> prompt two',
    '[copilot:stub]',
    'https://www.apple.com',
    'google.com',
    'search the web',
    '> prompt three',
    '[copilot:stub]',
    'No further actions needed'
  ].join('\n');

  const evaluation = evaluateTranscript(transcript, SUITES['direct-navigation']);
  assert.strictEqual(evaluation.passed, false);
  assert(evaluation.results.some((result) => result.forbidden.length > 0), 'forbidden pattern detected');
});

test('evaluator passes status-basic-chat transcript', () => {
  const transcript = [
    'Provider: copilot',
    'Copilot: Authenticated',
    '[copilot:stub]',
    'Hey there!'
  ].join('\n');

  const evaluation = evaluateTranscript(transcript, SUITES['status-basic-chat']);
  assert.strictEqual(evaluation.passed, true);
});

test('evaluator passes recovery-noop transcript', () => {
  const transcript = [
    'Provider: copilot',
    'Copilot: Authenticated',
    '[copilot:stub]',
    'bring_window_to_front',
    'https://www.apple.com',
    'No actions detected for an automation-like request; retrying once with stricter formatting...',
    '> confirm prompt',
    '[copilot:stub]',
    'Confirmed',
    'No further actions needed'
  ].join('\n');

  const evaluation = evaluateTranscript(transcript, SUITES['recovery-noop']);
  assert.strictEqual(evaluation.passed, true);
});

test('evaluator passes safety-boundaries transcript', () => {
  const transcript = [
    'Provider: copilot',
    'Copilot: Authenticated',
    'Run 1 action(s)? (y/N/a/d/c)',
    'Skipped.',
    'Low-risk sequence (1 step) detected. Running without pre-approval.',
    '[1/1] screenshot: ok'
  ].join('\n');

  const evaluation = evaluateTranscript(transcript, SUITES['safety-boundaries']);
  assert.strictEqual(evaluation.passed, true);
});

test('evaluator fails when a counted regression repeats', () => {
  const transcript = [
    'Provider: copilot',
    'Copilot: Authenticated',
    'No actions detected for an automation-like request; retrying once with stricter formatting...',
    'No actions detected for an automation-like request; retrying once with stricter formatting...',
    '[copilot:stub]',
    'Confirmed — no further actions taken.'
  ].join('\n');

  const evaluation = evaluateTranscript(transcript, SUITES['recovery-quality']);
  assert.strictEqual(evaluation.passed, false);
  assert(evaluation.results.some((result) => result.countFailures.length > 0), 'count-based regression is reported');
});

test('evaluator passes recovery-quality transcript', () => {
  const transcript = [
    'Provider: copilot',
    'Copilot: Authenticated',
    '[copilot:stub]',
    'Initial automation turn',
    'No actions detected for an automation-like request; retrying once with stricter formatting...',
    '> confirm prompt',
    '[copilot:stub]',
    'Confirmed — no further actions taken.'
  ].join('\n');

  const evaluation = evaluateTranscript(transcript, SUITES['recovery-quality']);
  assert.strictEqual(evaluation.passed, true);
});

test('evaluator passes continuity-acknowledgement transcript', () => {
  const transcript = [
    'Provider: copilot',
    'Copilot: Authenticated',
    '[copilot:stub]',
    'Initial automation turn',
    '> confirm prompt',
    '[copilot:stub]',
    'Confirmed — no further actions needed.',
    '> thanks prompt',
    '[copilot:stub]',
    'You are welcome. Happy to help.'
  ].join('\n');

  const evaluation = evaluateTranscript(transcript, SUITES['continuity-acknowledgement']);
  assert.strictEqual(evaluation.passed, true);
});

test('evaluator passes repo-boundary clarification transcript', () => {
  const transcript = [
    'Conversation, visual context, browser session state, session intent state, and chat continuity state cleared.',
    '> MUSE is a different repo, this is copilot-liku-cli.',
    '[copilot:stub]',
    'Understood. MUSE is a different repo and this session is in copilot-liku-cli.',
    'Current repo: copilot-liku-cli',
    'Downstream repo intent: MUSE',
    '> What is the safest next step if I want to work on MUSE without mixing repos or windows? Reply briefly.',
    '[copilot:stub]',
    'Safest next step: explicitly switch to the MUSE repo or window first, then continue there.'
  ].join('\n');

  const evaluation = evaluateTranscript(transcript, SUITES['repo-boundary-clarification']);
  assert.strictEqual(evaluation.passed, true);
});

test('evaluator fails repo-boundary clarification when it skips the switch step', () => {
  const transcript = [
    'Current repo: copilot-liku-cli',
    'Downstream repo intent: MUSE',
    '> MUSE is a different repo, this is copilot-liku-cli.',
    '[copilot:stub]',
    'Got it. copilot-liku-cli is the current repo.',
    '> What is the safest next step if I want to work on MUSE without mixing repos or windows? Reply briefly.',
    '[copilot:stub]',
    'Next step is to edit the MUSE code directly from here.'
  ].join('\n');

  const evaluation = evaluateTranscript(transcript, SUITES['repo-boundary-clarification']);
  assert.strictEqual(evaluation.passed, false);
});

test('evaluator passes forgone-feature suppression transcript', () => {
  const transcript = [
    'Conversation, visual context, browser session state, session intent state, and chat continuity state cleared.',
    '> I have forgone the implementation of: terminal-liku ui.',
    '[copilot:stub]',
    'Understood.',
    'Forgone features: terminal-liku ui',
    '> Should terminal-liku ui be part of the plan right now? Reply briefly.',
    '[copilot:stub]',
    'No. It is a forgone feature and should stay out of scope until you explicitly re-enable it.'
  ].join('\n');

  const evaluation = evaluateTranscript(transcript, SUITES['forgone-feature-suppression']);
  assert.strictEqual(evaluation.passed, true);
});

test('evaluator fails forgone-feature suppression when it proposes reviving the feature', () => {
  const transcript = [
    'Forgone features: terminal-liku ui',
    '> I have forgone the implementation of: terminal-liku ui.',
    '[copilot:stub]',
    'Understood.',
    '> Should terminal-liku ui be part of the plan right now? Reply briefly.',
    '[copilot:stub]',
    'Next step is to implement terminal-liku ui as the top priority.'
  ].join('\n');

  const evaluation = evaluateTranscript(transcript, SUITES['forgone-feature-suppression']);
  assert.strictEqual(evaluation.passed, false);
});

test('buildProofInput prepends model switch when requested', () => {
  const payload = buildProofInput(SUITES['status-basic-chat'], 'latest-gpt');
  assert(payload.startsWith('/model latest-gpt\n/status\n'), 'requested model runs prepend the model switch command');
});

test('buildRequestedModelLabel defaults to default bucket', () => {
  assert.strictEqual(buildRequestedModelLabel(null), 'default');
  assert.strictEqual(buildRequestedModelLabel('cheap'), 'cheap');
});

test('extractObservedModelHeaders reads runtime and requested model headers', () => {
  const transcript = [
    '[copilot:gpt-4o via gpt-5.4]',
    'hello',
    '[copilot:gpt-4o-mini]'
  ].join('\n');

  const observed = extractObservedModelHeaders(transcript);
  assert.deepStrictEqual(observed.providers, ['copilot']);
  assert.deepStrictEqual(observed.runtimeModels, ['gpt-4o', 'gpt-4o-mini']);
  assert.deepStrictEqual(observed.requestedModels, ['gpt-5.4', 'gpt-4o-mini']);
});