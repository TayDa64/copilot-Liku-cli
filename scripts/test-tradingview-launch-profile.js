#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  DEFAULT_TRADINGVIEW_CDP_PORT,
  classifyTradingViewLaunchProfile,
  detectTradingViewLaunchProfile,
  summarizeTradingViewLaunchProfile,
  scenarioRequiresTradingViewAutomationReadyLaunch,
  buildTradingViewLaunchProfilePreconditionMessage
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'launch-profile.js'));

const forcedExitTimer = setTimeout(() => {
  console.error('FAIL test-tradingview-launch-profile timed out');
  process.exit(1);
}, 30000);
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
  await test('classifyTradingViewLaunchProfile reports interactive-no-cdp for normal packaged launches without a live listener', async () => {
    const profile = classifyTradingViewLaunchProfile({
      expectedCdpPort: DEFAULT_TRADINGVIEW_CDP_PORT,
      processes: [{
        pid: 23288,
        name: 'TradingView.exe',
        commandLine: '"C:\\Program Files\\WindowsApps\\TradingView.Desktop_3.1.0.7818_x64__n534cwy3pjxzj\\TradingView.exe"',
        mainWindowTitle: 'INTC / Unnamed'
      }],
      listeners: [],
      devToolsActivePort: {
        exists: true,
        path: 'C:\\Users\\Tay Liku\\AppData\\Local\\Packages\\TradingView.Desktop_n534cwy3pjxzj\\LocalCache\\Roaming\\TradingView\\DevToolsActivePort',
        port: DEFAULT_TRADINGVIEW_CDP_PORT,
        browserEndpoint: '/devtools/browser/stale',
        lastModifiedMs: Date.now() - (12 * 60 * 1000),
        ageMs: 12 * 60 * 1000
      }
    });

    assert.strictEqual(profile.running, true);
    assert.strictEqual(profile.profile, 'interactive-no-cdp');
    assert.strictEqual(profile.automationReady, false);
    assert.strictEqual(profile.reason, 'remote-debugging-port-not-configured');
    assert.strictEqual(profile.packagedExecutable, true);
    assert.strictEqual(profile.remoteDebuggingConfigured, false);
    assert.strictEqual(
      profile.warnings.some((warning) => /stale devtoolsactiveport/i.test(String(warning || ''))),
      true
    );

    const summary = summarizeTradingViewLaunchProfile(profile);
    assert(summary, 'expected a summarized launch profile');
    assert.strictEqual(summary.profile, 'interactive-no-cdp');
    assert.strictEqual(summary.devToolsActivePort.port, DEFAULT_TRADINGVIEW_CDP_PORT);
    assert.strictEqual(summary.processes[0]?.packagedExecutable, true);
  });

  await test('classifyTradingViewLaunchProfile reports automation-ready when a configured port has a live listener', async () => {
    const profile = classifyTradingViewLaunchProfile({
      expectedCdpPort: 9333,
      processes: [{
        pid: 4242,
        name: 'TradingView.exe',
        commandLine: '"C:\\TradingView\\TradingView.exe" --remote-debugging-port=9333 --force-renderer-accessibility',
        mainWindowTitle: 'MN / Unnamed'
      }],
      listeners: [{
        pid: 4242,
        port: 9333,
        address: '127.0.0.1'
      }]
    });

    assert.strictEqual(profile.running, true);
    assert.strictEqual(profile.profile, 'automation-ready');
    assert.strictEqual(profile.automationReady, true);
    assert.strictEqual(profile.reason, null);
    assert.strictEqual(profile.effectivePort, 9333);
    assert.strictEqual(profile.rendererAccessibilityConfigured, true);
    assert.deepStrictEqual(profile.listenerPorts, [9333]);
  });

  await test('classifyTradingViewLaunchProfile reports configured-endpoint-missing when flags are present without a live listener', async () => {
    const profile = classifyTradingViewLaunchProfile({
      expectedCdpPort: 9444,
      processes: [{
        pid: 4242,
        name: 'TradingView.exe',
        commandLine: '"C:\\TradingView\\TradingView.exe" --remote-debugging-port=9444',
        mainWindowTitle: 'MN / Unnamed'
      }],
      listeners: []
    });

    assert.strictEqual(profile.running, true);
    assert.strictEqual(profile.profile, 'cdp-configured-endpoint-missing');
    assert.strictEqual(profile.automationReady, false);
    assert.strictEqual(profile.reason, 'remote-debugging-endpoint-missing');
    assert.strictEqual(profile.effectivePort, 9444);
    assert.deepStrictEqual(profile.remoteDebuggingPorts, [9444]);
  });

  await test('scenarioRequiresTradingViewAutomationReadyLaunch and precondition messaging only gate Pine/CDP scenarios', async () => {
    assert.strictEqual(scenarioRequiresTradingViewAutomationReadyLaunch('pine-editor'), true);
    assert.strictEqual(scenarioRequiresTradingViewAutomationReadyLaunch('pine-create-save'), true);
    assert.strictEqual(scenarioRequiresTradingViewAutomationReadyLaunch('focus'), false);

    const message = buildTradingViewLaunchProfilePreconditionMessage({
      likelyMeaning: 'TradingView is running in the normal interactive launch profile. No process command line exposes --remote-debugging-port, so Pine renderer proof is unavailable.'
    }, 'pine-editor');

    assert(/pine-editor requires an automation-ready tradingview launch profile/i.test(message));
    assert(/interactive launch profile/i.test(message));
  });

  await test('detectTradingViewLaunchProfile tolerates raw control characters in PowerShell JSON payloads', async () => {
    let callCount = 0;
    const profile = await detectTradingViewLaunchProfile({
      expectedCdpPort: DEFAULT_TRADINGVIEW_CDP_PORT,
      executePowerShellScript: async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            stdout: `[{"pid":23288,"name":"TradingView.exe","commandLine":"TradingView.exe\b","mainWindowTitle":"INTC / Unnamed"}]`
          };
        }
        return {
          stdout: '[]'
        };
      }
    });

    assert.strictEqual(profile.inspectionAvailable, true);
    assert.strictEqual(profile.running, true);
    assert.strictEqual(profile.profile, 'interactive-no-cdp');
    assert.strictEqual(profile.reason, 'remote-debugging-port-not-configured');
  });

  await test('detectTradingViewLaunchProfile reports automation-ready when the listener probe returns the expected port', async () => {
    let callCount = 0;
    const profile = await detectTradingViewLaunchProfile({
      expectedCdpPort: 9333,
      executePowerShellScript: async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            stdout: '[{"pid":4242,"name":"TradingView.exe","commandLine":"\\"C:\\\\TradingView\\\\TradingView.exe\\" --remote-debugging-port=9333 --force-renderer-accessibility","mainWindowTitle":"MN / Unnamed"}]'
          };
        }
        return {
          stdout: '{"pid":4242,"port":9333,"address":"127.0.0.1"}'
        };
      }
    });

    assert.strictEqual(profile.inspectionAvailable, true);
    assert.strictEqual(profile.running, true);
    assert.strictEqual(profile.profile, 'automation-ready');
    assert.strictEqual(profile.automationReady, true);
    assert.strictEqual(profile.effectivePort, 9333);
    assert.strictEqual(profile.listenerActive, true);
    assert.deepStrictEqual(profile.listenerPorts, [9333]);
  });

  clearTimeout(forcedExitTimer);
  console.log(`\nTradingView launch-profile tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  clearTimeout(forcedExitTimer);
  console.error('FAIL tradingview launch-profile tests');
  console.error(error.stack || error.message);
  process.exit(1);
});
