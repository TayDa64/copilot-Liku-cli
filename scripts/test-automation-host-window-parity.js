'use strict';

const assert = require('assert');
const systemAutomation = require('../src/main/system-automation');

function pickComparableWindowFields(value = {}) {
  return {
    success: !!value.success,
    hwnd: Number(value.hwnd || 0),
    pid: Number(value.pid || 0),
    processName: String(value.processName || ''),
    title: String(value.title || ''),
    ownerHwnd: Number(value.ownerHwnd || 0),
    isTopmost: !!value.isTopmost,
    isToolWindow: !!value.isToolWindow,
    isMinimized: !!value.isMinimized,
    isMaximized: !!value.isMaximized,
    windowKind: String(value.windowKind || '')
  };
}

async function main() {
  const previousUseNativeHost = process.env.USE_NATIVE_HOST;
  const previousLikuUseNativeHost = process.env.LIKU_USE_NATIVE_HOST;

  try {
    delete process.env.USE_NATIVE_HOST;
    delete process.env.LIKU_USE_NATIVE_HOST;

    const legacyForeground = await systemAutomation.getForegroundWindowInfo();
    assert(legacyForeground && typeof legacyForeground === 'object', 'Legacy foreground info must return an object');
    assert.strictEqual(legacyForeground.success, true, `Legacy foreground info failed: ${JSON.stringify(legacyForeground)}`);
    assert(Number(legacyForeground.hwnd) > 0, `Legacy foreground hwnd invalid: ${JSON.stringify(legacyForeground)}`);

    const legacyByHandle = await systemAutomation.getWindowInfoByHandle(legacyForeground.hwnd);
    assert.strictEqual(legacyByHandle.success, true, `Legacy window-by-handle failed: ${JSON.stringify(legacyByHandle)}`);

    process.env.USE_NATIVE_HOST = '1';

    const hostForeground = await systemAutomation.getForegroundWindowInfo();
    assert(hostForeground && typeof hostForeground === 'object', 'Native host foreground info must return an object');
    assert.strictEqual(hostForeground.success, true, `Native host foreground info failed: ${JSON.stringify(hostForeground)}`);

    const hostByHandle = await systemAutomation.getWindowInfoByHandle(legacyForeground.hwnd);
    assert.strictEqual(hostByHandle.success, true, `Native host window-by-handle failed: ${JSON.stringify(hostByHandle)}`);

    const legacyComparable = pickComparableWindowFields(legacyByHandle);
    const hostComparable = pickComparableWindowFields(hostByHandle);
    assert.deepStrictEqual(hostComparable, legacyComparable, `Window-by-handle parity mismatch\nlegacy=${JSON.stringify(legacyComparable)}\nhost=${JSON.stringify(hostComparable)}`);

    const hostHandle = await systemAutomation.getForegroundWindowHandle();
    assert(Number(hostHandle) > 0, `Native host foreground handle invalid: ${hostHandle}`);

    const hostTitle = await systemAutomation.getActiveWindowTitle();
    assert.strictEqual(typeof hostTitle, 'string', 'Native host active title should be a string');

    console.log(JSON.stringify({
      ok: true,
      legacyComparable,
      hostComparable,
      hostForeground: pickComparableWindowFields(hostForeground),
      hostHandle,
      hostTitle
    }, null, 2));
  } finally {
    if (typeof previousUseNativeHost === 'undefined') {
      delete process.env.USE_NATIVE_HOST;
    } else {
      process.env.USE_NATIVE_HOST = previousUseNativeHost;
    }

    if (typeof previousLikuUseNativeHost === 'undefined') {
      delete process.env.LIKU_USE_NATIVE_HOST;
    } else {
      process.env.LIKU_USE_NATIVE_HOST = previousLikuUseNativeHost;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});