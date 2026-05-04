const assert = require('assert');
const aiService = require('../src/main/ai-service.js');
const systemAutomation = require('../src/main/system-automation.js');

async function withPatchedSystemAutomation(overrides, fn) {
  const originals = new Map();
  try {
    for (const [key, value] of Object.entries(overrides || {})) {
      originals.set(key, systemAutomation[key]);
      systemAutomation[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of originals.entries()) {
      systemAutomation[key] = value;
    }
  }
}

async function main() {
  const previousWatcher = aiService.getUIWatcher();
  const executed = [];
  const routeMetadata = {
    id: 'open-pine-editor',
    route: 'quick-search',
    surface: 'pine-editor',
    appName: 'TradingView'
  };

  aiService.setUIWatcher({
    isPolling: true,
    cache: {
      lastUpdate: Date.now(),
      activeWindow: {
        hwnd: 777,
        title: 'TradingView',
        processName: 'tradingview',
        windowKind: 'main'
      },
      elements: [
        { id: 'pine-add', name: 'Add to chart', type: 'Button', windowHandle: 777, automationId: '', className: 'Button' },
        { id: 'pine-publish', name: 'Publish script', type: 'Button', windowHandle: 777, automationId: '', className: 'Button' }
      ]
    },
    waitForFreshState: async () => ({
      fresh: true,
      timedOut: false,
      immediate: false,
      activeWindow: {
        hwnd: 777,
        title: 'TradingView',
        processName: 'tradingview',
        windowKind: 'main'
      },
      lastUpdate: Date.now()
    })
  });

  try {
    await withPatchedSystemAutomation({
      getForegroundWindowHandle: async () => 777,
      getForegroundWindowInfo: async () => ({
        success: true,
        hwnd: 777,
        title: 'TradingView',
        processName: 'tradingview',
        windowKind: 'main'
      })
    }, async () => {
      const result = await aiService.executeActions({
        thought: 'Open Pine Editor only if needed, then inspect it.',
        verification: 'TradingView should show the Pine Editor before inspection.',
        actions: [
          {
            type: 'bring_window_to_front',
            title: 'TradingView',
            processName: 'tradingview',
            reason: 'Focus TradingView before the Pine workflow'
          },
          {
            type: 'key',
            key: 'ctrl+k',
            reason: 'Open TradingView quick search before selecting Pine Editor',
            searchSurfaceContract: routeMetadata,
            tradingViewShortcut: routeMetadata,
            verify: {
              kind: 'dialog-visible',
              appName: 'TradingView',
              target: 'quick-search',
              keywords: ['quick search', 'symbol search', 'search']
            }
          },
          {
            type: 'type',
            text: 'Pine Editor',
            reason: 'Replace the active TradingView quick-search text with Pine Editor',
            searchSurfaceContract: routeMetadata,
            tradingViewShortcut: routeMetadata
          },
          {
            type: 'key',
            key: 'enter',
            reason: 'Select the highlighted Pine Editor result in TradingView quick search',
            searchSurfaceContract: routeMetadata,
            tradingViewShortcut: routeMetadata,
            verify: {
              kind: 'editor-active',
              appName: 'TradingView',
              target: 'pine-editor',
              keywords: ['pine', 'pine editor', 'script'],
              requiresObservedChange: true
            }
          },
          {
            type: 'get_text',
            text: 'Pine Editor',
            reason: 'Inspect the current visible Pine Editor state'
          }
        ]
      }, null, null, {
        userMessage: 'Open the TradingView Pine Editor if it is not already open, then inspect it.',
        actionExecutor: async (action) => {
          executed.push({
            type: action.type,
            key: action.key || null,
            text: action.text || null,
            routeId: action.searchSurfaceContract?.id || null
          });
          if (action.type === 'bring_window_to_front') {
            return {
              success: true,
              action: action.type,
              message: 'Executed bring_window_to_front',
              requestedWindowHandle: 777,
              actualForegroundHandle: 777,
              actualForeground: {
                success: true,
                hwnd: 777,
                title: 'TradingView',
                processName: 'tradingview',
                windowKind: 'main'
              },
              focusTarget: {
                requestedWindowHandle: 777,
                requestedTarget: {
                  title: 'TradingView',
                  processName: 'tradingview',
                  className: null
                },
                actualForegroundHandle: 777,
                actualForeground: {
                  success: true,
                  hwnd: 777,
                  title: 'TradingView',
                  processName: 'tradingview',
                  windowKind: 'main'
                },
                exactMatch: true,
                outcome: 'exact'
              }
            };
          }
          return {
            success: true,
            action: action.type,
            message: `Executed ${action.type}`
          };
        }
      });

      assert.strictEqual(result.success, true, 'Execution should succeed when Pine Editor is already open.');

      const skippedOpenRoute = result.results.filter((entry) => entry?.skipped && entry?.pineEditorAlreadyOpen?.source === 'watcher-anchor');
      assert.strictEqual(skippedOpenRoute.length, 3, 'All Pine opener route actions should be skipped once watcher evidence shows Pine is already open.');
      assert(skippedOpenRoute.every((entry) => entry?.pineEditorAlreadyOpen?.anchor === 'add to chart' || entry?.pineEditorAlreadyOpen?.anchor === 'publish script'), 'Skipped route actions should preserve the Pine watcher anchor that satisfied the surface.');

      const executedRouteActions = executed.filter((entry) => entry.routeId === 'open-pine-editor');
      assert.strictEqual(executedRouteActions.length, 0, 'No open-pine-editor route action should execute once watcher evidence already satisfies Pine.');
      assert.deepStrictEqual(executed.map((entry) => entry.type), ['bring_window_to_front', 'get_text'], 'Only non-opener actions should execute after the runtime short-circuit.');
    });

    console.log('PASS test-ai-service-pine-open-short-circuit');
  } finally {
    aiService.setUIWatcher(previousWatcher);
  }
}

main().catch((error) => {
  console.error(error && (error.stack || error.message) ? (error.stack || error.message) : error);
  process.exit(1);
});
