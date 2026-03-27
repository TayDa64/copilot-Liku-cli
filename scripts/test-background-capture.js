#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  captureBackgroundWindow,
  classifyBackgroundCapability
} = require(path.join(__dirname, '..', 'src', 'main', 'background-capture.js'));

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

async function main() {
  await test('classifyBackgroundCapability rejects missing target handle', async () => {
    const capability = classifyBackgroundCapability({});
    assert.strictEqual(capability.supported, false);
    assert.strictEqual(capability.capability, 'unsupported');
  });

  await test('background capture trusts PrintWindow mode', async () => {
    const result = await captureBackgroundWindow(
      {
        windowHandle: 101
      },
      {
        screenshotFn: async () => ({
          success: true,
          base64: 'Zm9v',
          captureMode: 'window-printwindow'
        }),
        getForegroundWindowHandle: async () => 202
      }
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.captureProvider, 'printwindow');
    assert.strictEqual(result.captureCapability, 'supported');
    assert.strictEqual(result.captureTrusted, true);
    assert.strictEqual(result.isBackgroundTarget, true);
  });

  await test('background capture degrades non-foreground CopyFromScreen mode', async () => {
    const result = await captureBackgroundWindow(
      {
        targetWindowHandle: 101
      },
      {
        screenshotFn: async () => ({
          success: true,
          base64: 'YmFy',
          captureMode: 'window-copyfromscreen'
        }),
        getForegroundWindowHandle: async () => 202
      }
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.captureProvider, 'copyfromscreen');
    assert.strictEqual(result.captureCapability, 'degraded');
    assert.strictEqual(result.captureTrusted, false);
    assert(/degraded/i.test(String(result.captureDegradedReason || '')));
  });
}

main().catch((error) => {
  console.error('FAIL background capture');
  console.error(error.stack || error.message);
  process.exit(1);
});
