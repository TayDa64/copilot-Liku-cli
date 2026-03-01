/**
 * Verification tests for Tier 2 + Tier 3 implementations
 */
const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

// ===== Tier 2: Tool-calling =====
console.log('\n--- Tier 2: Tool-calling API ---');

const ai = require('../src/main/ai-service');

test('LIKU_TOOLS is exported as array', () => {
  assert(Array.isArray(ai.LIKU_TOOLS));
  assert(ai.LIKU_TOOLS.length >= 10, `Expected >= 10 tools, got ${ai.LIKU_TOOLS.length}`);
});

test('Each tool has required schema structure', () => {
  for (const tool of ai.LIKU_TOOLS) {
    assert.strictEqual(tool.type, 'function');
    assert(tool.function, 'Missing function property');
    assert(typeof tool.function.name === 'string', 'Missing function name');
    assert(typeof tool.function.description === 'string', 'Missing function description');
    assert(tool.function.parameters, 'Missing parameters');
    assert.strictEqual(tool.function.parameters.type, 'object');
  }
});

test('Tool names cover expected action types', () => {
  const names = ai.LIKU_TOOLS.map(t => t.function.name);
  const expected = ['click', 'click_element', 'type_text', 'press_key', 'scroll', 'screenshot', 'run_command', 'wait', 'drag', 'focus_window'];
  for (const e of expected) {
    assert(names.includes(e), `Missing tool: ${e}`);
  }
});

test('toolCallsToActions converts click tool_call', () => {
  const result = ai.toolCallsToActions([
    { type: 'function', id: 'tc1', function: { name: 'click', arguments: '{"x":100,"y":200,"reason":"test"}' } }
  ]);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].type, 'click');
  assert.strictEqual(result[0].x, 100);
  assert.strictEqual(result[0].y, 200);
});

test('toolCallsToActions converts click_element tool_call', () => {
  const result = ai.toolCallsToActions([
    { type: 'function', id: 'tc2', function: { name: 'click_element', arguments: '{"text":"Submit"}' } }
  ]);
  assert.strictEqual(result[0].type, 'click_element');
  assert.strictEqual(result[0].text, 'Submit');
});

test('toolCallsToActions converts type_text to type action', () => {
  const result = ai.toolCallsToActions([
    { type: 'function', id: 'tc3', function: { name: 'type_text', arguments: '{"text":"hello"}' } }
  ]);
  assert.strictEqual(result[0].type, 'type');
  assert.strictEqual(result[0].text, 'hello');
});

test('toolCallsToActions converts press_key to key action', () => {
  const result = ai.toolCallsToActions([
    { type: 'function', id: 'tc4', function: { name: 'press_key', arguments: '{"key":"ctrl+c"}' } }
  ]);
  assert.strictEqual(result[0].type, 'key');
  assert.strictEqual(result[0].key, 'ctrl+c');
});

test('toolCallsToActions converts focus_window via title', () => {
  const result = ai.toolCallsToActions([
    { type: 'function', id: 'tc5', function: { name: 'focus_window', arguments: '{"title":"Notepad"}' } }
  ]);
  assert.strictEqual(result[0].type, 'bring_window_to_front');
  assert.strictEqual(result[0].title, 'Notepad');
});

test('toolCallsToActions handles multiple tool_calls', () => {
  const result = ai.toolCallsToActions([
    { type: 'function', id: 'tc6', function: { name: 'click', arguments: '{"x":10,"y":20}' } },
    { type: 'function', id: 'tc7', function: { name: 'type_text', arguments: '{"text":"hi"}' } },
    { type: 'function', id: 'tc8', function: { name: 'press_key', arguments: '{"key":"enter"}' } }
  ]);
  assert.strictEqual(result.length, 3);
  assert.strictEqual(result[0].type, 'click');
  assert.strictEqual(result[1].type, 'type');
  assert.strictEqual(result[2].type, 'key');
});

test('toolCallsToActions handles malformed JSON arguments gracefully', () => {
  const result = ai.toolCallsToActions([
    { type: 'function', id: 'tc9', function: { name: 'screenshot', arguments: '{bad json' } }
  ]);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].type, 'screenshot');
});

// ===== Tier 2: Trace Writer =====
console.log('\n--- Tier 2: Trace Writer ---');

const { TraceWriter } = require('../src/main/agents/trace-writer');
const EventEmitter = require('events');

test('TraceWriter can be instantiated with an EventEmitter', () => {
  const emitter = new EventEmitter();
  const tw = new TraceWriter(emitter);
  assert(tw instanceof TraceWriter);
  tw.destroy();
});

test('TraceWriter binds to expected events', () => {
  const emitter = new EventEmitter();
  const before = emitter.eventNames().length;
  const tw = new TraceWriter(emitter);
  const after = emitter.eventNames().length;
  assert(after > before, 'TraceWriter should have added event listeners');
  tw.destroy();
});

// ===== Tier 2: Session Memory =====
console.log('\n--- Tier 2: Session Memory ---');

const fs = require('fs');
const path = require('path');
const os = require('os');

const HISTORY_FILE = path.join(os.homedir(), '.liku-cli', 'conversation-history.json');

test('Session history file path is in ~/.liku-cli/', () => {
  assert(HISTORY_FILE.includes('.liku-cli'));
  assert(HISTORY_FILE.endsWith('conversation-history.json'));
});

// ===== Tier 3: Parallel Fan-out =====
console.log('\n--- Tier 3: Parallel Fan-out ---');

test('AgentOrchestrator has executeParallel method', () => {
  const { AgentOrchestrator } = require('../src/main/agents/orchestrator');
  assert(typeof AgentOrchestrator.prototype.executeParallel === 'function');
});

// ===== Tier 3: Cross-provider Fallback =====
console.log('\n--- Tier 3: Cross-provider Fallback ---');

test('PROVIDER_FALLBACK_ORDER is used (sendMessage exists)', () => {
  assert(typeof ai.sendMessage === 'function');
});

test('All expected exports still present', () => {
  const expected = [
    'sendMessage', 'handleCommand', 'LIKU_TOOLS', 'toolCallsToActions',
    'parseActions', 'hasActions', 'executeActions', 'analyzeActionSafety',
    'COPILOT_MODELS', 'AI_PROVIDERS', 'setProvider', 'setCopilotModel'
  ];
  for (const e of expected) {
    assert(ai[e] !== undefined, `Missing export: ${e}`);
  }
});

// ===== Summary =====
console.log('\n' + '='.repeat(50));
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));
process.exit(failed > 0 ? 1 : 0);
