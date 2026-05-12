#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  writeFailureArtifactBundle,
  writeFailureArtifactBundleSync
} = require(path.join(__dirname, 'lib', 'failure-artifacts.js'));

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'liku-failure-artifacts-'));
}

function writeTraceFile(dirPath, fileName = 'runtime-trace.jsonl') {
  const tracePath = path.join(dirPath, fileName);
  const entries = [
    { ts: '2026-05-07T07:00:00.000Z', session: 'runtime-test-session', event: 'runtime:session:start' },
    { ts: '2026-05-07T07:00:01.000Z', session: 'runtime-test-session', event: 'action:planned', actionIndex: 0, action: { type: 'type', text: 'Pine Editor' } },
    { ts: '2026-05-07T07:00:02.000Z', session: 'runtime-test-session', event: 'action:error', actionIndex: 0, error: 'TradingView quick-search preflight timed out after 8000ms' }
  ];
  fs.writeFileSync(tracePath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
  return tracePath;
}

function buildFakeAiService(tracePath) {
  return {
    getLastRuntimeTraceSummary() {
      return {
        sessionId: 'runtime-test-session',
        filePath: tracePath,
        mode: 'execute',
        success: false,
        error: 'TradingView quick-search preflight timed out after 8000ms',
        actionCount: 1,
        observationCheckpointCount: 0
      };
    },
    formatLastRuntimeTraceSummary(summary) {
      return `trace=${summary?.sessionId || 'unknown'} error=${summary?.error || 'none'}`;
    },
    exportLastRuntimeTrace(destinationPath) {
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.copyFileSync(tracePath, destinationPath);
      return {
        sessionId: 'runtime-test-session',
        sourcePath: tracePath,
        filePath: destinationPath
      };
    },
    getUIWatcher() {
      return {
        getCapabilitySnapshot() {
          return {
            activeWindow: { hwnd: 777, title: 'TradingView' },
            totalElementCount: 12,
            activeWindowElementCount: 8,
            interactiveElementCount: 5,
            namedInteractiveElementCount: 3,
            ageMs: 42,
            lastUpdate: Date.now(),
            isPolling: true
          };
        }
      };
    }
  };
}

async function main() {
  await test('writeFailureArtifactBundle captures foreground, watcher, and trace-tail data', async () => {
    const tempDir = createTempDir();
    const tracePath = writeTraceFile(tempDir, 'source-runtime.jsonl');
    const aiService = buildFakeAiService(tracePath);
    const systemAutomation = {
      async getForegroundWindowInfo() {
        return {
          success: true,
          hwnd: 460832,
          processName: 'TradingView',
          title: 'LUNR ▲ 26.33 +6.17% / Unnamed',
          windowKind: 'main'
        };
      }
    };

    const artifact = await writeFailureArtifactBundle({
      artifactDir: tempDir,
      suiteName: 'test-failure-artifacts',
      failureName: 'async-bundle',
      phase: 'test',
      error: new Error('boom'),
      aiService,
      systemAutomation,
      watcher: aiService.getUIWatcher(),
      extra: {
        scenarioId: 'pine-editor',
        action: 'type'
      }
    });

    assert(artifact?.filePath && fs.existsSync(artifact.filePath), 'async failure bundle should be written to disk');
    assert(artifact?.traceFilePath && fs.existsSync(artifact.traceFilePath), 'async failure bundle should export the runtime trace');
    assert.strictEqual(artifact.bundle.error.message, 'boom');
    assert.strictEqual(artifact.bundle.foreground.hwnd, 460832);
    assert.strictEqual(artifact.bundle.watcherSnapshot.totalElementCount, 12);
    assert.strictEqual(artifact.bundle.traceTail.length, 3);
  });

  await test('writeFailureArtifactBundle captures target and foreground window screenshots when requested', async () => {
    const tempDir = createTempDir();
    const tracePath = writeTraceFile(tempDir, 'source-runtime-capture.jsonl');
    const aiService = buildFakeAiService(tracePath);
    const screenshotCalls = [];
    const systemAutomation = {
      async getForegroundWindowInfo() {
        return {
          success: true,
          hwnd: 123456,
          processName: 'Code - Insiders',
          title: 'copilot-Liku-cli - Visual Studio Code - Insiders',
          windowKind: 'main'
        };
      }
    };

    const artifact = await writeFailureArtifactBundle({
      artifactDir: tempDir,
      suiteName: 'test-failure-artifacts',
      failureName: 'window-captures',
      phase: 'test',
      error: new Error('capture boom'),
      aiService,
      systemAutomation,
      watcher: aiService.getUIWatcher(),
      captureTargetWindowHandle: 460832,
      captureForegroundWindow: true,
      screenshotFn: async (options = {}) => {
        screenshotCalls.push({ ...options });
        fs.writeFileSync(options.path, 'stub image', 'utf8');
        return {
          success: true,
          path: options.path,
          captureMode: 'window-printwindow'
        };
      }
    });

    assert.strictEqual(screenshotCalls.length, 2, 'should capture both target and foreground windows');
    assert.strictEqual(screenshotCalls[0].windowHwnd, 460832, 'first capture should target the requested window');
    assert.strictEqual(screenshotCalls[1].windowHwnd, 123456, 'second capture should target the differing foreground window');
    assert.strictEqual(artifact.bundle.windowCaptures.targetWindow.requestedWindowHandle, 460832);
    assert.strictEqual(artifact.bundle.windowCaptures.foregroundWindow.requestedWindowHandle, 123456);
    assert.strictEqual(artifact.bundle.windowCaptures.targetWindow.captureMode, 'window-printwindow');
    assert(fs.existsSync(artifact.bundle.windowCaptures.targetWindow.path), 'target window capture should exist on disk');
    assert(fs.existsSync(artifact.bundle.windowCaptures.foregroundWindow.path), 'foreground window capture should exist on disk');
  });

  await test('writeFailureArtifactBundle falls back to region capture using window bounds when hwnd capture returns no data', async () => {
    const tempDir = createTempDir();
    const tracePath = writeTraceFile(tempDir, 'source-runtime-region-fallback.jsonl');
    const aiService = buildFakeAiService(tracePath);
    const screenshotCalls = [];
    const systemAutomation = {
      async getForegroundWindowInfo() {
        return {
          success: true,
          hwnd: 460832,
          processName: 'TradingView',
          title: 'LUNR ▲ 29.19 +21.05% / Unnamed',
          windowKind: 'main'
        };
      },
      async getWindowInfoByHandle(hwnd) {
        assert.strictEqual(hwnd, 460832, 'bounds fallback should request the same window handle');
        return {
          success: true,
          hwnd,
          bounds: { x: 911, y: 8, width: 1016, height: 956 }
        };
      }
    };

    const artifact = await writeFailureArtifactBundle({
      artifactDir: tempDir,
      suiteName: 'test-failure-artifacts',
      failureName: 'region-fallback',
      phase: 'test',
      error: new Error('region fallback boom'),
      aiService,
      systemAutomation,
      watcher: aiService.getUIWatcher(),
      captureTargetWindowHandle: 460832,
      screenshotFn: async (options = {}) => {
        screenshotCalls.push({ ...options });
        if (options.windowHwnd) {
          return { success: false, path: options.path, captureMode: null };
        }
        fs.writeFileSync(options.path, 'region fallback image', 'utf8');
        return {
          success: true,
          path: options.path,
          captureMode: 'region-copyfromscreen'
        };
      }
    });

    assert.strictEqual(screenshotCalls.length, 2, 'should attempt hwnd capture first, then region fallback');
    assert.strictEqual(screenshotCalls[0].windowHwnd, 460832, 'first attempt should use the window handle');
    assert.deepStrictEqual(
      screenshotCalls[1].region,
      { x: 911, y: 8, width: 1016, height: 956 },
      'fallback should capture the requested window bounds as a region'
    );
    assert.strictEqual(artifact.bundle.windowCaptures.targetWindow.captured, true);
    assert.strictEqual(artifact.bundle.windowCaptures.targetWindow.fallback, 'region-by-window-bounds');
    assert.strictEqual(artifact.bundle.windowCaptures.targetWindow.captureMode, 'region-copyfromscreen');
    assert(fs.existsSync(artifact.bundle.windowCaptures.targetWindow.path), 'region fallback capture should exist on disk');
  });

  await test('writeFailureArtifactBundleSync captures trace-tail data without async system context', async () => {
    const tempDir = createTempDir();
    const tracePath = writeTraceFile(tempDir, 'source-runtime-sync.jsonl');
    const aiService = buildFakeAiService(tracePath);

    const artifact = writeFailureArtifactBundleSync({
      artifactDir: tempDir,
      suiteName: 'test-failure-artifacts',
      failureName: 'sync-bundle',
      phase: 'test',
      error: new Error('sync boom'),
      aiService,
      watcher: aiService.getUIWatcher(),
      extra: {
        mode: 'sync'
      }
    });

    assert(artifact?.filePath && fs.existsSync(artifact.filePath), 'sync failure bundle should be written to disk');
    assert(artifact?.traceFilePath && fs.existsSync(artifact.traceFilePath), 'sync failure bundle should export the runtime trace');
    assert.strictEqual(artifact.bundle.error.message, 'sync boom');
    assert.strictEqual(artifact.bundle.watcherSnapshot.totalElementCount, 12);
    assert.strictEqual(artifact.bundle.traceTail.length, 3);
  });
}

main().catch((error) => {
  console.error('FAIL failure artifacts');
  console.error(error.stack || error.message);
  process.exit(1);
});
