#!/usr/bin/env node

const assert = require('assert');
const path = require('path');
const Module = require('module');

const originalLoad = Module._load;

Module._load = function(request, parent, isMain) {
  if (request === 'electron') {
    return {
      screen: {
        getPrimaryDisplay: () => ({ scaleFactor: 1 })
      }
    };
  }

  if (request === './visual-awareness' && parent?.filename?.endsWith(path.join('src', 'main', 'inspect-service.js'))) {
    return {
      getActiveWindow: async () => ({
        processName: 'TradingView',
        title: 'BTCUSD - TradingView',
        processId: 321,
        bounds: { X: 10, Y: 20, Width: 1600, Height: 900 }
      }),
      detectUIElements: async () => ({ elements: [] }),
      extractTextFromImage: async () => ({ text: '', error: null })
    };
  }

  return originalLoad.apply(this, arguments);
};

const inspectServicePath = path.join(__dirname, '..', 'src', 'main', 'inspect-service.js');
delete require.cache[require.resolve(inspectServicePath)];
const inspectService = require(inspectServicePath);

async function main() {
  inspectService.setInspectMode(true);
  inspectService.clearRegions();
  await inspectService.updateWindowContext({
    processName: 'TradingView',
    title: 'BTCUSD - TradingView',
    processId: 321,
    bounds: { X: 10, Y: 20, Width: 1600, Height: 900 }
  });

  inspectService.updateRegions([{
    id: 'region-1',
    label: 'Publish',
    role: 'button',
    bounds: { x: 100, y: 200, width: 80, height: 40 },
    clickPoint: { x: 138, y: 224 },
    confidence: 0.96,
    timestamp: Date.now()
  }], 'accessibility');

  const region = inspectService.getRegionById('region-1');
  assert(region, 'getRegionById should return a region');
  assert.strictEqual(region.label, 'Publish');

  const resolution = inspectService.resolveTarget('region-1');
  assert.strictEqual(resolution.success, true, 'resolveTarget should succeed for a fresh region');
  assert.strictEqual(resolution.resolvedTarget.resolutionMethod, 'clickPoint');
  assert.deepStrictEqual(resolution.resolvedTarget.resolvedPoint, { x: 138, y: 224 });
  assert.strictEqual(resolution.resolvedTarget.window.appName, 'TradingView');

  inspectService.clearRegions();
  inspectService.updateRegions([{
    id: 'region-stale',
    label: 'Old Button',
    role: 'button',
    bounds: { x: 10, y: 20, width: 50, height: 20 },
    confidence: 0.8,
    timestamp: Date.now() - 10_000
  }], 'accessibility');

  const stale = inspectService.resolveTarget('region-stale', { maxAgeMs: 1000 });
  assert.strictEqual(stale.success, false, 'stale targets should fail without explicit fallback');
  assert.strictEqual(stale.code, 'TARGET_STALE');

  const fallback = inspectService.resolveTarget('region-stale', {
    maxAgeMs: 1000,
    allowCoordinateFallback: true,
    fallbackX: 400,
    fallbackY: 500
  });
  assert.strictEqual(fallback.success, true, 'stale targets should allow explicit coordinate fallback when requested');
  assert.strictEqual(fallback.resolvedTarget.resolutionMethod, 'explicit-coordinates');
  assert.strictEqual(fallback.resolvedTarget.coordinateFallback, true);
  assert.deepStrictEqual(fallback.resolvedTarget.resolvedPoint, { x: 400, y: 500 });

  console.log('PASS inspect target resolution');
}

main().catch((error) => {
  console.error('FAIL inspect target resolution');
  console.error(error.stack || error.message);
  process.exit(1);
}).finally(() => {
  inspectService.clearRegions();
  inspectService.setInspectMode(false);
  Module._load = originalLoad;
});