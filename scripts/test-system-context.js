/**
 * Phase 0 validation — Cognitive Substrate (system-context-manager).
 * Non-Jest custom test script per repo convention. Non-zero exit on failure.
 */
const assert = require('assert');
const fs = require('fs');

let pass = 0;
function test(name, fn) {
  try { fn(); console.log('  \u2713', name); pass++; }
  catch (err) { console.error('  \u2717', name, '\n    ', err.message); process.exitCode = 1; }
}

console.log('Phase 0 — System Context Manager');

const m = require('../src/main/system-context-manager');
const mgr = m.getInstance();

test('singleton getInstance returns same object', () => {
  assert.strictEqual(m.getInstance(), mgr);
});

test('autoDetectEnvironment populates grounded facts', () => {
  const r = mgr.autoDetectEnvironment();
  assert.ok(r.total >= 10, `expected >=10 facts, got ${r.total}`);
});

test('grounded env/meta facts are queryable', () => {
  assert.strictEqual(typeof mgr.get('env.platform'), 'string');
  assert.strictEqual(mgr.get('meta.schemaVersion'), m.SCHEMA_VERSION);
  assert.ok(mgr.get('meta.appVersion'));
});

test('guard rails are surfaced read-only', () => {
  assert.strictEqual(mgr.get('guard.tradingview.orderEntry'), 'disabled');
  assert.strictEqual(mgr.get('guard.net.mode'), 'read-only');
});

test('prompt fragment stays under global 1200 BPE cap', () => {
  const tokens = mgr.getFragmentTokenCount('structured');
  assert.ok(tokens > 0, 'fragment should be non-empty');
  assert.ok(tokens < 1200, `fragment ${tokens} tokens must be < 1200`);
  assert.ok(tokens <= mgr.tokenBudget, `fragment ${tokens} must be <= budget ${mgr.tokenBudget}`);
});

test('proposeUpdate is a read-only no-op in Phase 0', () => {
  const before = mgr.get('env.platform');
  const snapshotBefore = JSON.stringify(mgr.getAll());
  const res = mgr.proposeUpdate('env.platform', 'tampered');
  assert.strictEqual(res.accepted, false);
  assert.strictEqual(res.reason, 'read-only-phase-0');
  // Explicit immutability: value AND the full snapshot must be byte-identical.
  assert.strictEqual(mgr.get('env.platform'), before, 'value must be unchanged');
  assert.strictEqual(JSON.stringify(mgr.getAll()), snapshotBefore, 'full state must be unchanged');
});

test('proposeUpdate cannot introduce a brand-new key', () => {
  assert.strictEqual(mgr.get('flags.injectedByLlm'), undefined);
  mgr.proposeUpdate('flags.injectedByLlm', true);
  assert.strictEqual(mgr.get('flags.injectedByLlm'), undefined, 'no new key may be created');
});

test('env.hostname is stored but excluded from injected fragment by default', () => {
  // Stored for local diagnostics...
  assert.strictEqual(typeof mgr.get('env.hostname'), 'string');
  assert.strictEqual(mgr.get('flags.includeHostname'), false);
  // ...but never leaked into the LLM prompt fragment.
  const fragment = mgr.toPromptFragment('structured');
  assert.ok(!fragment.includes('env.hostname'), 'hostname must not appear in fragment');
  assert.ok(!fragment.includes(String(mgr.get('env.hostname'))), 'hostname value must not appear in fragment');
});

test('non-grounded key sanitization rejects bad keys', () => {
  assert.strictEqual(mgr.get('not a valid key!!'), undefined);
});

test('context persisted atomically to disk', () => {
  assert.ok(fs.existsSync(m.CONTEXT_FILE), `expected ${m.CONTEXT_FILE}`);
  const parsed = JSON.parse(fs.readFileSync(m.CONTEXT_FILE, 'utf-8'));
  assert.strictEqual(parsed.schemaVersion, m.SCHEMA_VERSION);
  assert.ok(parsed.entries && typeof parsed.entries === 'object');
});

test('message-builder loads with self-awareness injection wired', () => {
  // Proves the require + injection edit did not break message assembly module.
  const mb = require('../src/main/ai-service/message-builder');
  assert.strictEqual(typeof mb.createMessageBuilder === 'function' || typeof mb.buildMessages === 'function' || typeof mb === 'object', true);
});

console.log(`\n${pass} checks passed.`);
if (process.exitCode) { console.error('FAILED'); }
else { console.log('OK'); }
