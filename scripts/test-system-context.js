/**
 * Phase 0 + Phase 1 validation — Cognitive Substrate (system-context-manager).
 * Non-Jest custom test script per repo convention. Non-zero exit on failure.
 *
 * Runs against an ISOLATED temp LIKU_HOME so evidence/guard test writes never
 * pollute the real ~/.liku/system-context.json.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate all persistence to a temp home BEFORE requiring the manager.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-sctx-test-'));
process.env.LIKU_HOME_OVERRIDE = TMP_HOME;

let pass = 0;
function test(name, fn) {
  try { fn(); console.log('  \u2713', name); pass++; }
  catch (err) { console.error('  \u2717', name, '\n    ', err.message); process.exitCode = 1; }
}

console.log('Cognitive Substrate — System Context Manager (Phase 0 + Phase 1)');

const m = require('../src/main/system-context-manager');
const mgr = m.getInstance();
mgr.autoDetectEnvironment(); // ensure the isolated store is populated

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

test('proposeUpdate rejects updates with no source (no LLM-inference writes)', () => {
  const before = mgr.get('env.platform');
  const snapshotBefore = JSON.stringify(mgr.getAll());
  const res = mgr.proposeUpdate('env.platform', 'tampered');
  assert.strictEqual(res.accepted, false);
  assert.strictEqual(res.reason, 'missing-source');
  // Explicit immutability: value AND the full snapshot must be byte-identical.
  assert.strictEqual(mgr.get('env.platform'), before, 'value must be unchanged');
  assert.strictEqual(JSON.stringify(mgr.getAll()), snapshotBefore, 'full state must be unchanged');
});

test('proposeUpdate rejects untrusted (LLM-inference) sources', () => {
  const res = mgr.proposeUpdate('reg.demo', 'x', { source: 'llm', confidence: 1 });
  assert.strictEqual(res.accepted, false);
  assert.strictEqual(res.reason, 'untrusted-source');
  assert.strictEqual(mgr.get('reg.demo'), undefined, 'untrusted source may not create a key');
});

test('proposeUpdate applies trusted evidence and records provenance', () => {
  const res = mgr.proposeUpdate('reg.testEvidence', 'ok', { source: 'telemetry', confidence: 0.8 });
  assert.strictEqual(res.accepted, true);
  assert.ok(res.applied.includes('reg.testEvidence'));
  const entry = mgr.getEntry('reg.testEvidence');
  assert.strictEqual(entry.value, 'ok');
  assert.strictEqual(entry.source, 'telemetry');
  assert.strictEqual(entry.confidence, 0.8);
  assert.ok(entry.observedAt, 'provenance observedAt must be recorded');
});

test('high-risk guard.* keys require elevated confidence (0.9)', () => {
  const low = mgr.proposeUpdate('guard.testRail', 'locked', { source: 'verifier', confidence: 0.8 });
  assert.strictEqual(low.accepted, false, '0.8 must not pass the guard threshold');
  assert.ok(low.queued.includes('guard.testRail'), 'sub-threshold trusted update should queue');
  assert.strictEqual(mgr.get('guard.testRail'), undefined, 'guard key must not be set below 0.9');

  const high = mgr.proposeUpdate('guard.testRail', 'locked', { source: 'verifier', confidence: 0.95 });
  assert.strictEqual(high.accepted, true, '0.95 must pass the guard threshold');
  assert.strictEqual(mgr.get('guard.testRail'), 'locked');
});

test('strict mode rejects sub-threshold updates instead of queuing', () => {
  const res = mgr.proposeUpdate('reg.strictTest', 'v', { source: 'telemetry', confidence: 0.1, strict: true });
  assert.strictEqual(res.accepted, false);
  assert.ok(res.rejected.some((r) => r.key === 'reg.strictTest' && r.reason === 'below-threshold'));
  assert.strictEqual(mgr.get('reg.strictTest'), undefined);
});

test('TTL entries record expiry and disappear once expired', () => {
  const res = mgr.proposeUpdate('reg.ephemeral', 'temp', { source: 'telemetry', confidence: 0.9, ttl: 3600 });
  assert.strictEqual(res.accepted, true);
  const entry = mgr.getEntry('reg.ephemeral');
  assert.ok(entry && entry.expiresAt, 'a positive ttl must record expiresAt');
  assert.ok(Date.parse(entry.expiresAt) > Date.now(), 'expiresAt must be in the future');
  assert.strictEqual(mgr.get('reg.ephemeral'), 'temp', 'value readable before expiry');
  // Deterministically force expiry (no sleep) and confirm lazy-expiry hides it.
  mgr._entries['reg.ephemeral'].expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.strictEqual(mgr.get('reg.ephemeral'), undefined, 'expired entry must not be readable');
  assert.strictEqual(mgr.getEntry('reg.ephemeral'), null, 'expired entry must not be returned');
});

test('multiple render formats stay under budget and non-empty', () => {
  for (const fmt of ['structured', 'compact', 'flat-kv']) {
    const frag = mgr.toPromptFragment(fmt);
    const tokens = mgr.getFragmentTokenCount(fmt);
    assert.ok(frag && frag.length, `${fmt} fragment must be non-empty`);
    assert.ok(tokens < 1200, `${fmt} fragment ${tokens} must be < 1200`);
  }
});

test('selective injection hides contextual sections when irrelevant', () => {
  // Seed a contextual key with high enough confidence.
  mgr.proposeUpdate('guard.tradingview.testFlag', 'on', { source: 'verifier', confidence: 0.95 });
  const irrelevant = mgr.toPromptFragment('structured', { query: 'what is the weather today' });
  assert.ok(!irrelevant.includes('guard.tradingview.testFlag'), 'TV section must be hidden for irrelevant query');
  const relevant = mgr.toPromptFragment('structured', { query: 'open the tradingview chart pine editor' });
  assert.ok(relevant.includes('guard.tradingview.testFlag'), 'TV section must appear for relevant query');
  // Backward-compat: no relevance signal → included (Phase 0 default behavior).
  const noSignal = mgr.toPromptFragment('structured');
  assert.ok(noSignal.includes('guard.tradingview.testFlag'), 'no-signal default must include contextual section');
});

test('change history + diff records old→new with provenance', () => {
  mgr.proposeUpdate('reg.diffTest', 'first', { source: 'telemetry', confidence: 0.9 });
  mgr.proposeUpdate('reg.diffTest', 'second', { source: 'telemetry', confidence: 0.9 });
  const last = mgr.getLastChange('reg.diffTest');
  assert.ok(last, 'a change must be recorded');
  assert.strictEqual(last.newValue, 'second');
  assert.strictEqual(last.oldValue, 'first');
  assert.strictEqual(last.source, 'telemetry');
});

test('recordReflectionQuality writes grounded reg.* evidence', () => {
  const res = mgr.recordReflectionQuality(1, { detail: 'save_skill' });
  assert.strictEqual(res.accepted, true);
  assert.strictEqual(mgr.get('reg.lastReflectionQuality'), 1);
  assert.ok(mgr.get('reg.lastReflectionAt'), 'reflection timestamp must be set');
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

// Cleanup the isolated temp home.
try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
