#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  COMMAND_EXECUTION_SCHEMA_VERSION,
  COMMAND_REQUEST_SCHEMA_VERSION,
  buildCommandRequest,
  executeCommandRequest,
} = require(path.join(__dirname, '..', 'src', 'cli', 'command-seam.js'));

let pass = 0;

async function test(name, fn) {
  await fn();
  pass += 1;
  console.log(`PASS ${name}`);
}

function createFakeTraceLog(events) {
  return {
    sessionId: 'trace-cli-test',
    filePath: 'C:/tmp/trace-cli-test.jsonl',
    append(event, data = {}) {
      events.push({ event, data });
    },
    close(summary = {}) {
      events.push({ event: 'trace:close', data: summary });
    },
  };
}

(async () => {
  await test('buildCommandRequest defaults to start and carries schema metadata', async () => {
    const request = buildCommandRequest({
      flags: { json: true },
      env: {
        LIKU_ENABLE_GITHUB: '1',
        LIKU_ENABLE_GITHUB_WRITES: '1',
        LIKU_APPROVAL_MODE: 'never',
        LIKU_DRY_RUN_DEFAULT: '1',
      },
    });

    assert.strictEqual(request.schemaVersion, COMMAND_REQUEST_SCHEMA_VERSION);
    assert.strictEqual(request.command, 'start');
    assert.strictEqual(request.flags.json, true);
    assert.strictEqual(request.featureFlags.enableGitHub, true);
    assert.strictEqual(request.featureFlags.enableGitHubWrites, true);
    assert.strictEqual(request.executionPreferences.approvalMode, 'never');
    assert.strictEqual(request.executionPreferences.dryRunDefault, true);
  });

  await test('executeCommandRequest normalizes unknown commands', async () => {
    const request = buildCommandRequest({ command: 'missing-command' });
    const execution = await executeCommandRequest(request, {
      createTraceLog() {
        return createFakeTraceLog([]);
      },
      getCommandInfo() {
        return null;
      },
    });

    assert.strictEqual(execution.schemaVersion, COMMAND_EXECUTION_SCHEMA_VERSION);
    assert.strictEqual(execution.ok, false);
    assert.strictEqual(execution.exitCode, 1);
    assert.strictEqual(execution.error.code, 'UNKNOWN_COMMAND');
  });

  await test('executeCommandRequest returns structured project guard mismatches', async () => {
    const request = buildCommandRequest({
      command: 'doctor',
      options: {
        project: 'C:/expected/project',
        repo: 'copilot-liku-cli',
      },
    });

    const execution = await executeCommandRequest(request, {
      createTraceLog() {
        return createFakeTraceLog([]);
      },
      getCommandInfo() {
        return { file: 'doctor' };
      },
      validateProjectIdentity() {
        return {
          ok: false,
          expected: { projectRoot: 'C:/expected/project', repoName: 'copilot-liku-cli' },
          detected: { projectRoot: 'C:/actual/project', repoName: 'unexpected-repo' },
          errors: ['repo name mismatch'],
        };
      },
    });

    assert.strictEqual(execution.ok, false);
    assert.strictEqual(execution.error.code, 'PROJECT_GUARD_MISMATCH');
    assert.strictEqual(execution.error.payload.detected.repoName, 'unexpected-repo');
    assert.deepStrictEqual(execution.error.payload.details, ['repo name mismatch']);
  });

  await test('executeCommandRequest passes seam metadata to command modules and records traces', async () => {
    const events = [];
    const request = buildCommandRequest({
      command: 'doctor',
      args: ['--deep'],
      flags: { json: true },
      env: {
        LIKU_ENABLE_GITHUB: '1',
        LIKU_ENABLE_GITHUB_WRITES: '1',
        LIKU_ENABLE_AGENTS: '1',
        LIKU_ENABLE_DYNAMIC_TOOLS: '1',
        LIKU_APPROVAL_MODE: 'prompt',
      },
    });

    let receivedArgs = null;
    let receivedOptions = null;
    const execution = await executeCommandRequest(request, {
      createTraceLog() {
        return createFakeTraceLog(events);
      },
      getCommandInfo() {
        return { file: 'doctor' };
      },
      loadCommand() {
        return {
          async run(args, options) {
            receivedArgs = args;
            receivedOptions = options;
            return { success: true, ok: true };
          },
        };
      },
    });

    assert.strictEqual(execution.ok, true);
    assert.strictEqual(execution.success, true);
    assert.strictEqual(execution.exitCode, 0);
    assert.deepStrictEqual(receivedArgs, ['--deep']);
    assert.strictEqual(receivedOptions.json, true);
    assert.strictEqual(receivedOptions.featureFlags.enableGitHub, true);
    assert.strictEqual(receivedOptions.featureFlags.enableGitHubWrites, true);
    assert.strictEqual(receivedOptions.executionPreferences.approvalMode, 'prompt');
    assert.ok(events.some((entry) => entry.event === 'cli:command:start'));
    assert.ok(events.some((entry) => entry.event === 'cli:command:result'));
    assert.ok(events.some((entry) => entry.event === 'trace:close'));
    assert.strictEqual(execution.traceSummary.sessionId, 'trace-cli-test');
  });

  await test('executeCommandRequest disables trace creation when runtime trace is disabled', async () => {
    const request = buildCommandRequest({
      command: 'doctor',
      env: {
        LIKU_DISABLE_RUNTIME_TRACE: '1',
      },
    });

    let traceFactoryCalled = false;
    const execution = await executeCommandRequest(request, {
      createTraceLog() {
        traceFactoryCalled = true;
        return createFakeTraceLog([]);
      },
      getCommandInfo() {
        return { file: 'doctor' };
      },
      loadCommand() {
        return {
          async run() {
            return { success: true };
          },
        };
      },
    });

    assert.strictEqual(traceFactoryCalled, false);
    assert.strictEqual(execution.ok, true);
    assert.strictEqual(execution.traceSummary, null);
  });

  await test('executeCommandRequest preserves command-declared failure results without throwing', async () => {
    const request = buildCommandRequest({ command: 'doctor' });
    const execution = await executeCommandRequest(request, {
      getCommandInfo() {
        return { file: 'doctor' };
      },
      loadCommand() {
        return {
          async run() {
            return { success: false, reason: 'expected failure for test' };
          },
        };
      },
    });

    assert.strictEqual(execution.ok, true);
    assert.strictEqual(execution.success, false);
    assert.strictEqual(execution.exitCode, 1);
    assert.strictEqual(execution.result.reason, 'expected failure for test');
  });

  console.log(`PASS cli command seam (${pass} assertions)`);
})().catch((error) => {
  console.error('FAIL cli command seam');
  console.error(error.stack || error.message);
  process.exit(1);
});
