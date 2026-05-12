#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
const { UIWatcher, getUIWatcher } = require(path.join(__dirname, '..', 'src', 'main', 'ui-watcher.js'));
const { UIAHost } = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation', 'core', 'uia-host.js'));

const forcedExitTimer = setTimeout(() => {
  console.error('FAIL test-live-tradingview-shutdown timed out');
  process.exit(1);
}, 45000);
if (typeof forcedExitTimer.unref === 'function') {
  forcedExitTimer.unref();
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
  }
}

async function main() {
  await test('UIWatcher.stop clears polling and fallback timers', async () => {
    const watcher = new UIWatcher({ quiet: true, pollInterval: 50 });
    watcher.isPolling = true;
    watcher.options.enabled = true;
    watcher._mode = 'EVENT_MODE';
    watcher.pollTimer = setInterval(() => {}, 1000);
    watcher._healthCheckTimer = setInterval(() => {}, 1000);
    watcher._fallbackRetryTimer = setTimeout(() => {}, 1000);

    watcher.stop();

    assert.strictEqual(watcher.isPolling, false);
    assert.strictEqual(watcher.options.enabled, false);
    assert.strictEqual(watcher.pollTimer, null);
    assert.strictEqual(watcher._healthCheckTimer, null);
    assert.strictEqual(watcher._fallbackRetryTimer, null);
    assert.strictEqual(watcher.mode, 'POLLING');
  });

  await test('UIWatcher.shutdown awaits event-mode teardown before stopping', async () => {
    const watcher = new UIWatcher({ quiet: true });
    let stopEventModeCalls = 0;
    watcher._mode = 'EVENT_MODE';
    watcher.isPolling = true;
    watcher.stopEventMode = async () => {
      stopEventModeCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      watcher._mode = 'POLLING';
    };

    await watcher.shutdown();

    assert.strictEqual(stopEventModeCalls, 1);
    assert.strictEqual(watcher.isPolling, false);
    assert.strictEqual(watcher.options.enabled, false);
  });

  await test('UIWatcher.dispose clears the shared watcher singleton', async () => {
    const sharedWatcher = getUIWatcher({ quiet: true });
    let stopEventModeCalls = 0;
    sharedWatcher._mode = 'EVENT_MODE';
    sharedWatcher.isPolling = true;
    sharedWatcher.stopEventMode = async () => {
      stopEventModeCalls += 1;
      sharedWatcher._mode = 'POLLING';
    };

    await sharedWatcher.dispose();

    const nextSharedWatcher = getUIWatcher({ quiet: true });
    try {
      assert.strictEqual(stopEventModeCalls, 1);
      assert.notStrictEqual(nextSharedWatcher, sharedWatcher);
    } finally {
      await nextSharedWatcher.dispose().catch(() => {});
    }
  });

  await test('shutdownSharedUIAHost clears the shared UIA host reference', async () => {
    const sharedHost = uiAutomation.getSharedUIAHost();
    let stopCalled = false;
    sharedHost.stop = async () => {
      stopCalled = true;
      sharedHost._alive = false;
      sharedHost._proc = null;
    };

    await uiAutomation.shutdownSharedUIAHost();

    const nextSharedHost = uiAutomation.getSharedUIAHost();
    try {
      assert.strictEqual(stopCalled, true);
      assert.notStrictEqual(nextSharedHost, sharedHost);
    } finally {
      await uiAutomation.shutdownSharedUIAHost().catch(() => {});
    }
  });

  await test('UIAHost.stop tears down child process handles', async () => {
    const host = new UIAHost();
    let stdinEnded = false;
    let stdinDestroyed = false;
    let stdoutDestroyed = false;
    let stderrDestroyed = false;
    let processKilled = false;
    let processUnrefed = false;

    host._alive = true;
    host._proc = {
      killed: false,
      stdin: {
        end() {
          stdinEnded = true;
        },
        destroy() {
          stdinDestroyed = true;
        }
      },
      stdout: {
        destroy() {
          stdoutDestroyed = true;
        }
      },
      stderr: {
        destroy() {
          stderrDestroyed = true;
        }
      },
      kill() {
        this.killed = true;
        processKilled = true;
      },
      unref() {
        processUnrefed = true;
      }
    };
    host.send = async () => ({ ok: true });

    await host.stop();

    assert.strictEqual(host.isAlive, false);
    assert.strictEqual(host._proc, null);
    assert.strictEqual(stdinEnded, true);
    assert.strictEqual(stdinDestroyed, true);
    assert.strictEqual(stdoutDestroyed, true);
    assert.strictEqual(stderrDestroyed, true);
    assert.strictEqual(processKilled, true);
    assert.strictEqual(processUnrefed, true);
    assert.strictEqual(host._buffer, '');
  });

  clearTimeout(forcedExitTimer);
  console.log(`\nLive TradingView shutdown tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  clearTimeout(forcedExitTimer);
  console.error('FAIL live shutdown tests');
  console.error(error.stack || error.message);
  process.exit(1);
});
