#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const aiService = require(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'));
const tradingViewTool = require(path.join(__dirname, '..', 'src', 'main', 'tools', 'tradingview-tool.js'));
const systemContractRegistry = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'system-contract-registry.js'));
const observationProviderRegistry = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'observation-provider-registry.js'));
const lifecycleHooks = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'lifecycle-hooks.js'));

const REWRITE_ENV = 'LIKU_USE_TOOL_REGISTRY_REWRITES';
const RISK_ENV = 'LIKU_USE_TOOL_REGISTRY_RISKS';

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined || value === null) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function normalizeRewriteResult(actions, userMessage) {
  const rewriteJournal = [];
  const rewritten = aiService.rewriteActionsForReliability(cloneJson(actions), {
    userMessage,
    rewriteJournal,
    cwd: process.cwd()
  });

  return {
    actions: rewritten,
    rewrites: rewriteJournal.map((entry) => ({
      rewriter: entry.rewriter,
      category: entry.category,
      reason: entry.reason,
      changed: entry.changed,
      beforeActionCount: entry.beforeActionCount,
      afterActionCount: entry.afterActionCount,
      beforeActionTypes: entry.beforeActionTypes,
      afterActionTypes: entry.afterActionTypes
    }))
  };
}

function rewriteLegacy(actions, userMessage) {
  return withEnv({ [REWRITE_ENV]: '0' }, () => normalizeRewriteResult(actions, userMessage));
}

function rewriteDefault(actions, userMessage) {
  return withEnv({ [REWRITE_ENV]: undefined }, () => normalizeRewriteResult(actions, userMessage));
}

function rewriteRegistry(actions, userMessage) {
  return withEnv({ [REWRITE_ENV]: '1' }, () => normalizeRewriteResult(actions, userMessage));
}

function normalizeSafetyResult(result) {
  return {
    riskLevel: result.riskLevel,
    warnings: result.warnings,
    requiresConfirmation: result.requiresConfirmation,
    blockExecution: result.blockExecution,
    blockReason: result.blockReason,
    tradingMode: result.tradingMode || null,
    confirmationPrompt: result.confirmationPrompt || null
  };
}

function safetyLegacy(action, targetInfo) {
  return withEnv({ [RISK_ENV]: '0' }, () => normalizeSafetyResult(
    aiService.analyzeActionSafety(cloneJson(action), cloneJson(targetInfo))
  ));
}

function safetyDefault(action, targetInfo) {
  return withEnv({ [RISK_ENV]: undefined }, () => normalizeSafetyResult(
    aiService.analyzeActionSafety(cloneJson(action), cloneJson(targetInfo))
  ));
}

function safetyRegistry(action, targetInfo) {
  return withEnv({ [RISK_ENV]: '1' }, () => normalizeSafetyResult(
    aiService.analyzeActionSafety(cloneJson(action), cloneJson(targetInfo))
  ));
}

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

test('TradingView tool exposes canonical registration surface while preserving compatibility exports', () => {
  assert.strictEqual(tradingViewTool.TRADINGVIEW_TOOL_NAME, 'tradingview');
  assert.strictEqual(tradingViewTool.TRADINGVIEW_TOOL_PRIORITY, -1);
  assert.strictEqual(typeof tradingViewTool.registerTradingViewTool, 'function');
  assert.strictEqual(typeof tradingViewTool.applyTradingViewReliabilityRewrites, 'function');
  assert.strictEqual(typeof tradingViewTool.assessTradingViewRisk, 'function');
  assert.strictEqual(typeof tradingViewTool.maybeRewriteTradingViewPineWorkflow, 'function');
  assert.strictEqual(typeof tradingViewTool.detectTradingViewDomainActionRisk, 'function');

  const calls = [];
  const registration = tradingViewTool.registerTradingViewTool({
    registerToolRewrites: (toolName, handler, priority) => {
      calls.push({ kind: 'rewrite', toolName, handlerType: typeof handler, priority });
      return { toolName, priority, rewriteCount: 1 };
    },
    registerToolRiskAssessor: (toolName, handler, priority) => {
      calls.push({ kind: 'risk', toolName, handlerType: typeof handler, priority });
      return { toolName, priority };
    }
  });

  assert.deepStrictEqual(calls, [
    { kind: 'rewrite', toolName: 'tradingview', handlerType: 'function', priority: -1 },
    { kind: 'risk', toolName: 'tradingview', handlerType: 'function', priority: -1 }
  ]);
  assert.strictEqual(registration.toolName, 'tradingview');
  assert.strictEqual(registration.priority, -1);
  assert.deepStrictEqual(registration.rewriteEntry, { toolName: 'tradingview', priority: -1, rewriteCount: 1 });
  assert.deepStrictEqual(registration.riskEntry, { toolName: 'tradingview', priority: -1 });
});

test('system contract registry dispatches ordered provider messages', () => {
  systemContractRegistry.unregisterSystemContractProvider('test-contract-alpha');
  systemContractRegistry.unregisterSystemContractProvider('test-contract-beta');
  systemContractRegistry.registerSystemContractProvider('test-contract-beta', () => 'beta contract', 10);
  systemContractRegistry.registerSystemContractProvider('test-contract-alpha', () => ['alpha contract'], -10);

  const messages = systemContractRegistry.buildRegisteredSystemContractMessages({
    userMessage: 'irrelevant'
  });

  assert.deepStrictEqual(messages.slice(0, 2), ['alpha contract', 'beta contract']);
  systemContractRegistry.unregisterSystemContractProvider('test-contract-alpha');
  systemContractRegistry.unregisterSystemContractProvider('test-contract-beta');
});

test('TradingView facade registers context-gated Pine system contracts', () => {
  assert.strictEqual(typeof tradingViewTool.createTradingViewSystemContractProvider, 'function');
  assert.strictEqual(typeof tradingViewTool.registerTradingViewSystemContracts, 'function');

  const provider = tradingViewTool.createTradingViewSystemContractProvider({
    buildTradingViewPineAuthoringSystemContract: (message) => (
      String(message || '').includes('create') ? 'TRADINGVIEW PINE AUTHORING CONTRACT: test' : ''
    )
  });

  assert.deepStrictEqual(provider({
    userMessage: 'create a TradingView Pine indicator',
    executionContextEnvelope: { eligibility: { tradingViewPine: true } }
  }), ['TRADINGVIEW PINE AUTHORING CONTRACT: test']);
  assert.deepStrictEqual(provider({
    userMessage: 'create a TradingView Pine indicator',
    executionContextEnvelope: { eligibility: { tradingViewPine: false } }
  }), []);
  assert.deepStrictEqual(provider({
    userMessage: 'read TradingView Pine diagnostics',
    executionContextEnvelope: { eligibility: { tradingViewPine: true } }
  }), []);

  const calls = [];
  const registration = tradingViewTool.registerTradingViewSystemContracts({
    buildTradingViewPineAuthoringSystemContract: () => 'TRADINGVIEW PINE AUTHORING CONTRACT: test',
    registerSystemContractProvider: (toolName, registeredProvider, priority) => {
      calls.push({ toolName, handlerType: typeof registeredProvider, priority });
      return { toolName, priority };
    }
  });

  assert.deepStrictEqual(calls, [
    { toolName: 'tradingview', handlerType: 'function', priority: -1 }
  ]);
  assert.deepStrictEqual(registration, {
    toolName: 'tradingview',
    priority: -1,
    systemContractEntry: { toolName: 'tradingview', priority: -1 }
  });
});

test('TradingView facade registers observation provider surface', () => {
  assert.strictEqual(typeof tradingViewTool.createTradingViewObservationProvider, 'function');
  assert.strictEqual(typeof tradingViewTool.registerTradingViewObservationProvider, 'function');

  const provider = tradingViewTool.createTradingViewObservationProvider();
  assert.strictEqual(provider.toolName, 'tradingview');
  assert.strictEqual(typeof provider.inferObservationSpec, 'function');
  assert.strictEqual(typeof provider.inferTradingMode, 'function');
  assert.strictEqual(typeof provider.isTargetHint, 'function');
  assert(provider.matchesContext({ userMessage: 'open Pine Editor in TradingView' }));
  assert(!provider.matchesContext({ userMessage: 'open VS Code search' }));

  const calls = [];
  const registration = tradingViewTool.registerTradingViewObservationProvider({
    registerObservationProvider: (toolName, registeredProvider, priority) => {
      calls.push({ toolName, providerType: typeof registeredProvider, priority });
      return { toolName, priority };
    }
  });

  assert.deepStrictEqual(calls, [
    { toolName: 'tradingview', providerType: 'object', priority: -1 }
  ]);
  assert.deepStrictEqual(registration, {
    toolName: 'tradingview',
    priority: -1,
    observationProviderEntry: { toolName: 'tradingview', priority: -1 }
  });
});

test('observation provider registry dispatches provider metadata', () => {
  observationProviderRegistry.unregisterObservationProvider('test-observation-provider');
  const entry = observationProviderRegistry.registerObservationProvider('test-observation-provider', {
    toolName: 'test-observation-provider'
  }, 7);

  assert.strictEqual(entry.toolName, 'test-observation-provider');
  const providers = observationProviderRegistry.getRegisteredObservationProviders();
  assert(providers.some((provider) => provider.toolName === 'test-observation-provider' && provider.priority === 7));
  observationProviderRegistry.unregisterObservationProvider('test-observation-provider');
});

test('lifecycle hook registry dispatches first concrete hook result', () => {
  lifecycleHooks.unregisterLifecycleHooks('test-lifecycle-alpha');
  lifecycleHooks.unregisterLifecycleHooks('test-lifecycle-beta');
  lifecycleHooks.registerLifecycleHooks('test-lifecycle-beta', {
    sampleHook: () => 'beta'
  }, 10);
  lifecycleHooks.registerLifecycleHooks('test-lifecycle-alpha', {
    sampleHook: () => 'alpha'
  }, -10);

  assert.strictEqual(lifecycleHooks.runLifecycleHook('sampleHook', {}), 'alpha');
  assert.strictEqual(lifecycleHooks.runLifecycleHook('missingHook', {}, 'fallback'), 'fallback');
  lifecycleHooks.unregisterLifecycleHooks('test-lifecycle-alpha');
  lifecycleHooks.unregisterLifecycleHooks('test-lifecycle-beta');
});

const rewriteCases = [
  {
    name: 'TradingView timeframe workflow',
    userMessage: 'change the timeframe selector from 1m to 5m in tradingview',
    actions: [{ type: 'screenshot' }, { type: 'wait', ms: 250 }]
  },
  {
    name: 'TradingView symbol workflow',
    userMessage: 'change the symbol to NVDA in tradingview',
    actions: [{ type: 'screenshot' }, { type: 'wait', ms: 250 }]
  },
  {
    name: 'TradingView watchlist workflow',
    userMessage: 'select the watchlist symbol NVDA in tradingview',
    actions: [{ type: 'screenshot' }, { type: 'wait', ms: 250 }]
  },
  {
    name: 'TradingView drawing workflow',
    userMessage: 'open object tree in tradingview',
    actions: [{ type: 'key', key: 'ctrl+shift+o' }, { type: 'wait', ms: 250 }]
  },
  {
    name: 'TradingView Pine workflow',
    userMessage: 'open pine editor in tradingview and type plot(close)',
    actions: [{ type: 'key', key: 'ctrl+e' }, { type: 'type', text: 'plot(close)' }]
  },
  {
    name: 'TradingView paper workflow',
    userMessage: 'open paper trading in tradingview',
    actions: [{ type: 'key', key: 'alt+t' }, { type: 'wait', ms: 250 }]
  },
  {
    name: 'TradingView DOM workflow',
    userMessage: 'open depth of market in tradingview',
    actions: [{ type: 'key', key: 'ctrl+d' }, { type: 'wait', ms: 250 }]
  },
  {
    name: 'TradingView indicator workflow',
    userMessage: 'open indicator search in tradingview and add anchored vwap',
    actions: [{ type: 'screenshot' }, { type: 'wait', ms: 300 }]
  },
  {
    name: 'TradingView alert workflow',
    userMessage: 'set an alert for a price target of $20.02 in tradingview',
    actions: [{ type: 'screenshot' }, { type: 'wait', ms: 250 }]
  },
  {
    name: 'non-TradingView browser rewrite',
    userMessage: 'open https://example.com in Microsoft Edge',
    actions: [
      { type: 'key', key: 'ctrl+shift+p' },
      { type: 'type', text: 'Simple Browser: Show' },
      { type: 'key', key: 'enter' }
    ]
  }
];

for (const fixture of rewriteCases) {
  test(`${fixture.name} rewrite registry output matches legacy`, () => {
    const legacy = rewriteLegacy(fixture.actions, fixture.userMessage);
    const defaultRegistry = rewriteDefault(fixture.actions, fixture.userMessage);
    const explicitRegistry = rewriteRegistry(fixture.actions, fixture.userMessage);

    assert.deepStrictEqual(defaultRegistry, explicitRegistry, 'Default rewrite path should use registered rewrites');
    assert.deepStrictEqual(explicitRegistry, legacy, 'Registered rewrite path should preserve legacy rewrite behavior');
  });
}

const riskCases = [
  {
    name: 'paper-mode DOM order entry requires confirmation without registry drift',
    action: {
      type: 'click',
      reason: 'Click buy market order in TradingView Paper Trading DOM',
      targetText: 'Buy Mkt'
    },
    targetInfo: {
      text: 'TradingView Paper Trading DOM buy market order',
      nearbyText: ['Paper Trading', 'Buy Mkt', 'quantity'],
      userMessage: 'place a paper trading buy market order in TradingView'
    }
  },
  {
    name: 'live-mode DOM order entry remains blocked',
    action: {
      type: 'click',
      reason: 'Click buy market order in TradingView live trading DOM',
      targetText: 'Buy Mkt'
    },
    targetInfo: {
      text: 'TradingView live trading DOM buy market order real money',
      nearbyText: ['Live Trading', 'Buy Mkt', 'quantity'],
      userMessage: 'place a live trading buy market order in TradingView'
    }
  },
  {
    name: 'unknown-mode DOM order entry remains fail-closed',
    action: {
      type: 'click',
      reason: 'Click limit order in TradingView DOM',
      targetText: 'Limit Order'
    },
    targetInfo: {
      text: 'TradingView DOM limit order quantity',
      nearbyText: ['Depth of Market', 'Limit Order', 'quantity'],
      userMessage: 'place a limit order in TradingView'
    }
  },
  {
    name: 'TradingView position management remains blocked',
    action: {
      type: 'click',
      reason: 'Click flatten in TradingView DOM',
      targetText: 'Flatten'
    },
    targetInfo: {
      text: 'TradingView DOM flatten position',
      nearbyText: ['Flatten', 'Reverse', 'CXL All'],
      userMessage: 'flatten my TradingView position'
    }
  },
  {
    name: 'TradingView drawing placement remains blocked',
    action: {
      type: 'drag',
      reason: 'Draw a trend line exactly on the TradingView chart'
    },
    targetInfo: {
      text: 'TradingView chart draw trend line placement',
      nearbyText: ['Trend Line', 'Drawing Tools'],
      userMessage: 'draw a trend line exactly on tradingview'
    }
  },
  {
    name: 'non-TradingView safe prompt is unaffected by registry risk',
    action: {
      type: 'type',
      text: 'Budget spreadsheet',
      reason: 'Type a spreadsheet title'
    },
    targetInfo: {
      text: 'Create a budget spreadsheet title',
      userMessage: 'create a budget spreadsheet title'
    }
  }
];

for (const fixture of riskCases) {
  test(`${fixture.name} risk registry output matches legacy`, () => {
    const legacy = safetyLegacy(fixture.action, fixture.targetInfo);
    const defaultRegistry = safetyDefault(fixture.action, fixture.targetInfo);
    const explicitRegistry = safetyRegistry(fixture.action, fixture.targetInfo);

    assert.deepStrictEqual(defaultRegistry, explicitRegistry, 'Default risk path should use registered risk assessors');
    assert.deepStrictEqual(explicitRegistry, legacy, 'Registered risk path should preserve legacy risk behavior for parity fixtures');
  });
}
