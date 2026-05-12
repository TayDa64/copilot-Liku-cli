#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  inspectTradingViewManifestText,
  inspectTradingViewBundleContent,
  classifyTradingViewLaunchCapability,
  summarizeTradingViewLaunchCapability,
  buildTradingViewAutomationLaunchPreconditionMessage
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'launch-capability.js'));

const forcedExitTimer = setTimeout(() => {
  console.error('FAIL test-tradingview-launch-capability timed out');
  process.exit(1);
}, 30000);
if (typeof forcedExitTimer.unref === 'function') {
  forcedExitTimer.unref();
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
  }
}

test('inspectTradingViewManifestText extracts packaged launch identity and protocol surfaces', () => {
  const manifest = inspectTradingViewManifestText(`
    <Package>
      <Applications>
        <Application Id="TradingView.Desktop" Executable="TradingView.exe" EntryPoint="Windows.FullTrustApplication">
          <Extensions>
            <uap3:Extension Category="windows.protocol">
              <uap3:Protocol Name="tradingview" />
            </uap3:Extension>
            <uap3:Extension Category="windows.appUriHandler">
              <uap3:AppUriHandler Name="tradingview.com">
                <uap3:Host Name="www.tradingview.com" />
              </uap3:AppUriHandler>
            </uap3:Extension>
            <desktop:Extension Category="windows.startupTask" Executable="TradingView.exe" EntryPoint="Windows.FullTrustApplication">
              <desktop:StartupTask TaskId="TradingView" Enabled="false" DisplayName="TradingView" />
            </desktop:Extension>
          </Extensions>
        </Application>
      </Applications>
    </Package>
  `);

  assert.strictEqual(manifest.applicationId, 'TradingView.Desktop');
  assert.strictEqual(manifest.executable, 'TradingView.exe');
  assert.strictEqual(manifest.entryPoint, 'Windows.FullTrustApplication');
  assert.deepStrictEqual(manifest.protocols, ['tradingview']);
  assert.deepStrictEqual(manifest.appUriHosts, ['www.tradingview.com']);
  assert.strictEqual(manifest.startupTaskId, 'TradingView');
  assert.strictEqual(manifest.appExecutionAliasPresent, false);
});

test('inspectTradingViewBundleContent detects limited TVD environment hooks without automation flags', () => {
  const bundle = inspectTradingViewBundleContent(`
    app.commandLine.appendSwitch("disable-features","CalculateNativeWinOcclusion");
    const r="TVD_HOST",i="TVD_SESSION_COOKIE",o="TVD_DEBUGMODE",s="TVD_LOG_VIEW_ENABLED",c="TVD_SENTRY_FORCE_UPLOAD",l="TVD_SENTRY_DSN";
    const t=f("config.json");
    const n=f("nav-rules.json");
  `);

  assert.strictEqual(bundle.commandLineAppendSwitchPresent, true);
  assert.strictEqual(bundle.remoteDebuggingStringPresent, false);
  assert.strictEqual(bundle.rendererAccessibilityStringPresent, false);
  assert.strictEqual(bundle.configOverrideReadPresent, true);
  assert.deepStrictEqual(bundle.supportedEnvironmentKeys, [
    'TVD_DEBUGMODE',
    'TVD_HOST',
    'TVD_LOG_VIEW_ENABLED',
    'TVD_SENTRY_DSN',
    'TVD_SENTRY_FORCE_UPLOAD',
    'TVD_SESSION_COOKIE'
  ]);
});

test('classifyTradingViewLaunchCapability reports flag-capable for packaged installs with an AppID launch target', () => {
  const capability = classifyTradingViewLaunchCapability({
    package: {
      name: 'TradingView.Desktop',
      packageFullName: 'TradingView.Desktop_3.1.0.7818_x64__n534cwy3pjxzj',
      packageFamilyName: 'TradingView.Desktop_n534cwy3pjxzj',
      installLocation: 'C:\\Program Files\\WindowsApps\\TradingView.Desktop_3.1.0.7818_x64__n534cwy3pjxzj',
      version: '3.1.0.7818'
    },
    startApps: [{
      name: 'TradingView',
      appId: 'TradingView.Desktop_n534cwy3pjxzj!TradingView.Desktop'
    }],
    manifest: {
      applicationId: 'TradingView.Desktop',
      executable: 'TradingView.exe',
      entryPoint: 'Windows.FullTrustApplication',
      protocols: ['tradingview'],
      appUriHosts: ['www.tradingview.com'],
      startupTaskId: 'TradingView',
      appExecutionAliasPresent: false
    },
    bundle: {
      path: 'C:\\Program Files\\WindowsApps\\TradingView.Desktop_3.1.0.7818_x64__n534cwy3pjxzj\\resources\\app.asar',
      commandLineAppendSwitchPresent: true,
      remoteDebuggingStringPresent: false,
      rendererAccessibilityStringPresent: false,
      configOverrideReadPresent: true,
      supportedEnvironmentKeys: ['TVD_DEBUGMODE', 'TVD_LOG_VIEW_ENABLED']
    },
    documentsConfig: {
      documentsPath: 'C:\\Users\\Tay Liku\\OneDrive\\Documents',
      configDir: 'C:\\Users\\Tay Liku\\OneDrive\\Documents\\TradingView\\configs',
      configPath: 'C:\\Users\\Tay Liku\\OneDrive\\Documents\\TradingView\\configs\\config.json',
      configExists: false,
      navRulesPath: 'C:\\Users\\Tay Liku\\OneDrive\\Documents\\TradingView\\configs\\nav-rules.json',
      navRulesExists: false
    }
  });

  assert.strictEqual(capability.installed, true);
  assert.strictEqual(capability.capabilityProfile, 'flag-capable');
  assert.strictEqual(capability.automationLaunchSurfaceDetected, true);
  assert.strictEqual(capability.launchIdentity.shellLaunchSupported, true);
  assert.strictEqual(capability.launchIdentity.activationLaunchSupported, true);
  assert.strictEqual(capability.launchIdentity.activationLaunchMode, 'application-activation-manager');
  assert.strictEqual(
    capability.launchIdentity.shellLaunchTarget,
    'shell:AppsFolder\\TradingView.Desktop_n534cwy3pjxzj!TradingView.Desktop'
  );
  assert(capability.warnings.some((warning) => /packaged appid activation/i.test(String(warning || ''))));

  const summary = summarizeTradingViewLaunchCapability(capability);
  assert(summary, 'expected summarized launch capability');
  assert.strictEqual(summary.capabilityProfile, 'flag-capable');
  assert.strictEqual(summary.launchIdentity.appId, 'TradingView.Desktop_n534cwy3pjxzj!TradingView.Desktop');
  assert.strictEqual(summary.launchIdentity.activationLaunchSupported, true);
});

test('classifyTradingViewLaunchCapability reports flag-capable when the install exposes an automation surface', () => {
  const capability = classifyTradingViewLaunchCapability({
    package: {
      name: 'TradingView.Desktop',
      packageFullName: 'TradingView.Desktop_3.1.0.7818_x64__n534cwy3pjxzj',
      packageFamilyName: 'TradingView.Desktop_n534cwy3pjxzj',
      installLocation: 'C:\\TradingView'
    },
    startApps: [{
      name: 'TradingView',
      appId: 'TradingView.Desktop_n534cwy3pjxzj!TradingView.Desktop'
    }],
    manifest: {
      applicationId: 'TradingView.Desktop',
      executable: 'TradingView.exe',
      entryPoint: 'Windows.FullTrustApplication',
      appExecutionAliasPresent: true,
      appExecutionAliases: ['TradingViewAutomation.exe']
    },
    bundle: {
      path: 'C:\\TradingView\\resources\\app.asar',
      commandLineAppendSwitchPresent: true,
      remoteDebuggingStringPresent: true,
      rendererAccessibilityStringPresent: true,
      configOverrideReadPresent: true,
      supportedEnvironmentKeys: ['TVD_DEBUGMODE']
    }
  });

  assert.strictEqual(capability.capabilityProfile, 'flag-capable');
  assert.strictEqual(capability.automationLaunchSurfaceDetected, true);
  assert.strictEqual(capability.reason, null);
});

test('buildTradingViewAutomationLaunchPreconditionMessage appends capability evidence to the launch-profile block', () => {
  const message = buildTradingViewAutomationLaunchPreconditionMessage({
    scenarioId: 'pine-editor',
    launchProfile: {
      likelyMeaning: 'TradingView is running in the normal interactive launch profile. No process command line exposes --remote-debugging-port, so Pine renderer proof is unavailable.'
    },
    launchCapability: {
      likelyMeaning: 'This TradingView install exposes a packaged AppID launch target that the automation wrapper can use for an automation-ready relaunch with remote debugging and renderer accessibility.'
    }
  });

  assert(/pine-editor requires an automation-ready tradingview launch profile/i.test(message));
  assert(/interactive launch profile/i.test(message));
  assert(/packaged appid launch target/i.test(message));
});

clearTimeout(forcedExitTimer);
console.log(`\nTradingView launch-capability tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
