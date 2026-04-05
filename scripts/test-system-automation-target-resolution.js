#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const systemAutomation = require(path.join(__dirname, '..', 'src', 'main', 'system-automation.js'));

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
  await test('executeAction resolves targetId into click coordinates and verified proof', async () => {
    let clicked = null;
    const result = await systemAutomation.executeAction({
      type: 'click',
      targetId: 'region-1',
      reason: 'Open Pine Editor'
    }, {
      inspectService: {
        resolveTarget: () => ({
          success: true,
          resolvedTarget: {
            targetId: 'region-1',
            resolutionMethod: 'clickPoint',
            resolvedPoint: { x: 42, y: 84 },
            resolvedBounds: { x: 40, y: 80, width: 20, height: 10 },
            runtimeId: [1, 2, 3],
            clickPoint: { x: 42, y: 84 },
            window: { appName: 'TradingView', windowTitle: 'BTCUSD - TradingView', pid: 123 },
            regionConfidence: 0.95,
            observedAt: Date.now(),
            freshnessMs: 100,
            stale: false,
            coordinateFallback: false,
            fallbackReason: null
          }
        })
      },
      click: async (x, y, button) => {
        clicked = { x, y, button };
      }
    });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(clicked, { x: 42, y: 84, button: 'left' });
    assert.strictEqual(result.resolvedTarget.targetId, 'region-1');
    assert.strictEqual(result.proof.level, 1);
    assert.strictEqual(result.proof.status, 'verified');
    assert(result.proof.checks.some((check) => check.kind === 'target-resolution' && check.status === 'pass'));
  });

  await test('executeAction marks coordinate fallback as bounded proof', async () => {
    const result = await systemAutomation.executeAction({
      type: 'click',
      targetId: 'region-stale',
      allowCoordinateFallback: true,
      x: 10,
      y: 20
    }, {
      inspectService: {
        resolveTarget: () => ({
          success: true,
          resolvedTarget: {
            targetId: 'region-stale',
            resolutionMethod: 'explicit-coordinates',
            resolvedPoint: { x: 10, y: 20 },
            resolvedBounds: null,
            runtimeId: null,
            clickPoint: null,
            window: null,
            regionConfidence: null,
            observedAt: null,
            freshnessMs: null,
            stale: true,
            coordinateFallback: true,
            fallbackReason: 'TARGET_STALE'
          }
        })
      },
      click: async () => {}
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.proof.level, 0);
    assert.strictEqual(result.proof.status, 'bounded');
    assert(result.proof.limitations.some((entry) => entry.includes('coordinate fallback')));
  });

  await test('executeAction fails closed when target resolution fails', async () => {
    let clicked = false;
    const result = await systemAutomation.executeAction({
      type: 'click',
      targetId: 'missing-target'
    }, {
      inspectService: {
        resolveTarget: () => ({
          success: false,
          code: 'TARGET_NOT_FOUND',
          error: 'missing target'
        })
      },
      click: async () => {
        clicked = true;
      }
    });

    assert.strictEqual(clicked, false, 'click should not run when target resolution fails');
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorCode, 'TARGET_NOT_FOUND');
    assert.strictEqual(result.proof.status, 'failed');
  });
}

main().catch((error) => {
  console.error('FAIL system automation target resolution');
  console.error(error.stack || error.message);
  process.exit(1);
});