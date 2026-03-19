#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const { SUITES, evaluateTranscript, extractAssistantTurns } = require(path.join(__dirname, 'run-chat-inline-proof.js'));

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