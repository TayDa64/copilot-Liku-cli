#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const policy = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'policy-enforcement.js'));

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

test('negative policy catches coordinate clicks', () => {
  const result = policy.checkNegativePolicies(
    { actions: [{ type: 'click', x: 100, y: 200 }] },
    [{ forbiddenMethod: 'coordinate_click', reason: 'Use UIA instead' }]
  );

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.violations.length, 1);
  assert.strictEqual(result.violations[0].reason, 'Use UIA instead');
});

test('negative policy catches simulated typing aliases', () => {
  const result = policy.checkNegativePolicies(
    { actions: [{ type: 'type_text', text: 'hello' }] },
    [{ forbiddenMethod: 'simulated_keystrokes' }]
  );

  assert.strictEqual(result.ok, false);
  assert.ok(result.violations[0].reason.includes('Simulated typing'));
});

test('action policy enforces click_element exact text preference', () => {
  const result = policy.checkActionPolicies(
    { actions: [{ type: 'click_element', text: 'Save' }] },
    [{ intent: 'click_element', matchPreference: 'exact_text' }]
  );

  assert.strictEqual(result.ok, false);
  assert.ok(result.violations[0].reason.includes('exact_text'));
});

test('action policy allows compliant exact click_element action', () => {
  const result = policy.checkActionPolicies(
    { actions: [{ type: 'click_element', text: 'Save', exact: true }] },
    [{ intent: 'click_element', matchPreference: 'exact_text' }]
  );

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.violations, []);
});

test('policy rejection message stays structured', () => {
  const message = policy.formatNegativePolicyViolationSystemMessage('Code.exe', [
    { actionIndex: 0, action: { type: 'click' }, reason: 'Coordinate-based interactions are forbidden by user policy' }
  ]);

  assert.ok(message.includes('POLICY ENFORCEMENT: The previous action plan is REJECTED.'));
  assert.ok(message.includes('Active app: Code.exe'));
  assert.ok(message.includes('Respond ONLY with a JSON code block'));
});

test('capability policy rejects precise placement on visual-first-low-uia surfaces', () => {
  const result = policy.checkCapabilityPolicies(
    {
      thought: 'Draw and place a trend line exactly on the TradingView chart.',
      actions: [{ type: 'drag', fromX: 10, fromY: 10, toX: 100, toY: 100 }]
    },
    {
      surfaceClass: 'visual-first-low-uia',
      appId: 'tradingview',
      enforcement: { avoidPrecisePlacementClaims: true }
    },
    {
      userMessage: 'draw and place a trend line exactly on tradingview'
    }
  );

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.violations.length, 1);
  assert.ok(result.violations[0].reason.includes('precise placement claims'));
});

test('capability policy rejects browser coordinate-only plans when deterministic routes exist', () => {
  const result = policy.checkCapabilityPolicies(
    {
      actions: [{ type: 'click', x: 400, y: 200 }]
    },
    {
      surfaceClass: 'browser',
      appId: 'msedge',
      enforcement: { discourageCoordinateOnlyPlans: true }
    },
    {
      userMessage: 'click the browser button'
    }
  );

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.violations.length, 1);
  assert.ok(result.violations[0].reason.includes('browser-native'));
});

test('capability policy message stays structured', () => {
  const message = policy.formatCapabilityPolicyViolationSystemMessage(
    {
      surfaceClass: 'visual-first-low-uia',
      appId: 'tradingview'
    },
    [
      {
        actionIndex: 0,
        action: { type: 'drag' },
        reason: 'Capability-policy matrix forbids precise placement claims on visual-first-low-uia surfaces unless a deterministic verified workflow proves the anchors.'
      }
    ]
  );

  assert.ok(message.includes('REJECTED by the capability-policy matrix'));
  assert.ok(message.includes('Surface class: visual-first-low-uia'));
  assert.ok(message.includes('App: tradingview'));
  assert.ok(message.includes('Respond ONLY with a JSON code block'));
});
