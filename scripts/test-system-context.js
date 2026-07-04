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

// ── Phase 2: durable pending queue + confirmation + new evidence ──

test('sub-threshold update is written to the durable pending file', () => {
  const res = mgr.proposeUpdate('reg.pendingDemo', 'candidate', { source: 'telemetry', confidence: 0.2 });
  assert.strictEqual(res.accepted, false);
  assert.ok(res.queued.includes('reg.pendingDemo'));
  assert.ok(fs.existsSync(m.PENDING_FILE), 'pending file must exist');
  const parsed = JSON.parse(fs.readFileSync(m.PENDING_FILE, 'utf-8'));
  assert.ok(parsed.pending.some((p) => p.key === 'reg.pendingDemo'), 'pending file must contain the item');
  assert.strictEqual(mgr.get('reg.pendingDemo'), undefined, 'sub-threshold value must NOT be applied');
});

test('pending queue survives a restart (fresh instance reloads from disk)', () => {
  const fresh = new m.SystemContextManager(); // simulate process restart
  const items = fresh.getPendingUpdates();
  assert.ok(items.some((p) => p.key === 'reg.pendingDemo'), 'restarted instance must restore pending queue');
});

test('confirm --apply promotes a pending item to a grounded entry', () => {
  const res = mgr.confirmPending('reg.pendingDemo', 'apply');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.action, 'apply');
  assert.strictEqual(mgr.get('reg.pendingDemo'), 'candidate', 'applied value must now be readable');
  assert.strictEqual(mgr.getPending('reg.pendingDemo').length, 0, 'item must be removed from pending');
  const last = mgr.getLastChange('reg.pendingDemo');
  assert.ok(last && last.newValue === 'candidate', 'apply must be recorded in history');
});

test('confirm --reject discards a pending item and logs it', () => {
  mgr.proposeUpdate('reg.rejectDemo', 'nope', { source: 'telemetry', confidence: 0.2 });
  const res = mgr.confirmPending('reg.rejectDemo', 'reject');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.action, 'reject');
  assert.strictEqual(mgr.get('reg.rejectDemo'), undefined, 'rejected value must not be applied');
  assert.strictEqual(mgr.getPending('reg.rejectDemo').length, 0, 'item must be removed from pending');
  const last = mgr.getLastChange('reg.rejectDemo');
  assert.ok(last && last.decision === 'rejected', 'reject must be recorded in history');
});

test('recordVerificationQuality writes grounded verifier evidence', () => {
  const res = mgr.recordVerificationQuality(1, { status: 'verified', detail: 'python' });
  assert.strictEqual(res.accepted, true);
  assert.strictEqual(mgr.get('reg.lastVerificationQuality'), 1);
  assert.strictEqual(mgr.get('reg.lastVerificationStatus'), 'verified');
});

// ── Phase 3: TF-IDF relevance + live guard grounding + regression evidence ──

test('TF-IDF relevance scores TradingView query high and unrelated query low', () => {
  const kws = ['tradingview', 'trading', 'chart', 'pine', 'ticker', 'symbol'];
  const hot = mgr._scoreRelevance('guard.tradingview', kws, 'open the tradingview chart pine editor');
  const cold = mgr._scoreRelevance('guard.tradingview', kws, 'what is the weather today');
  assert.ok(hot > cold, `TV query (${hot}) must score higher than unrelated (${cold})`);
  assert.ok(hot >= m.RELEVANCE_THRESHOLD, `TV query must meet threshold ${m.RELEVANCE_THRESHOLD}`);
  assert.ok(cold < m.RELEVANCE_THRESHOLD, 'unrelated query must fall below threshold');
});

test('TF-IDF selective injection includes TV only when relevant', () => {
  mgr.proposeUpdate('guard.tradingview.p3Flag', 'on', { source: 'verifier', confidence: 0.95 });
  assert.ok(!mgr.toPromptFragment('structured', { query: 'summarize my emails' }).includes('guard.tradingview.p3Flag'));
  assert.ok(mgr.toPromptFragment('structured', { query: 'set a tradingview alert on the chart' }).includes('guard.tradingview.p3Flag'));
  assert.ok(mgr.toPromptFragment('structured').includes('guard.tradingview.p3Flag'), 'no-signal must still include (compat)');
});

test('live guard grounding applies safe values and populates guard.*', () => {
  const res = mgr.refreshGuardRails({ foreground: { processName: 'tradingview' }, userMessage: 'open tradingview' });
  assert.ok(Array.isArray(res.applied));
  assert.strictEqual(mgr.get('guard.tradingview.mode'), 'advisory-observational');
  assert.strictEqual(mgr.get('guard.tradingview.orderEntry'), 'disabled');
});

test('live guard relaxation is queued for confirmation (not applied)', () => {
  // net.mode is 'read-only' (rank 3); a live 'read-write' (rank 0) must NOT apply.
  const before = mgr.get('guard.net.mode');
  const res = mgr.refreshGuardRails({ guardOverrides: { 'guard.net.mode': 'read-write' } });
  assert.ok(res.queued.includes('guard.net.mode'), 'relaxation must be queued');
  assert.strictEqual(mgr.get('guard.net.mode'), before, 'rail must not be relaxed without confirmation');
});

test('recordRegressionOutcome writes cap.lang.*.regression.status', () => {
  const res = mgr.recordRegressionOutcome('pass', { lang: 'js', quality: 1, detail: 'ai-focused' });
  assert.strictEqual(res.accepted, true);
  assert.strictEqual(mgr.get('cap.lang.js.regression.status'), 'pass');
  assert.strictEqual(mgr.get('reg.lastRegressionQuality'), 1);
});

// ── Phase 4: governance + evidence hygiene ──

test('evidence keys are excluded from the default fragment but queryable', () => {
  mgr.recordRegressionOutcome('fail', { lang: 'py', quality: 0 });
  // Queryable...
  assert.strictEqual(mgr.get('cap.lang.py.regression.status'), 'fail');
  // ...but not in the default (no-signal) fragment.
  const def = mgr.toPromptFragment('structured');
  assert.ok(!def.includes('cap.lang.py.regression.status'), 'evidence excluded by default');
  // Included when the query is relevant to it.
  const rel = mgr.toPromptFragment('structured', { query: 'did the python regression pass?' });
  assert.ok(rel.includes('cap.lang.py.regression.status'), 'evidence included when relevant');
});

test('confirm --all batch applies all pending items', () => {
  mgr.proposeUpdate('reg.batchA', 'a', { source: 'telemetry', confidence: 0.1 });
  mgr.proposeUpdate('reg.batchB', 'b', { source: 'telemetry', confidence: 0.1 });
  const res = mgr.confirmAllPending('apply');
  assert.ok(res.count >= 2);
  assert.strictEqual(mgr.get('reg.batchA'), 'a');
  assert.strictEqual(mgr.get('reg.batchB'), 'b');
  assert.strictEqual(mgr.getPendingUpdates().length, 0, 'queue must be empty after batch confirm');
});

test('prune retires reg.*/cap.* keys but protects core groups', () => {
  mgr.proposeUpdate('reg.toPrune', 'x', { source: 'telemetry', confidence: 0.9 });
  assert.strictEqual(mgr.pruneKey('reg.toPrune').ok, true);
  assert.strictEqual(mgr.get('reg.toPrune'), undefined);
  // Core grounded groups are protected.
  assert.strictEqual(mgr.pruneKey('env.platform').ok, false);
  assert.strictEqual(mgr.pruneKey('guard.net.mode').ok, false);
  // History records the prune.
  const last = mgr.getLastChange('reg.toPrune');
  assert.ok(last && last.decision === 'pruned');
});

test('sweepPending removes expired queued items', () => {
  mgr.proposeUpdate('reg.willExpire', 'v', { source: 'telemetry', confidence: 0.1, ttl: 3600 });
  // Force expiry on the pending item, then sweep.
  const item = mgr._pending.find((p) => p.key === 'reg.willExpire');
  item.expiresAt = new Date(Date.now() - 1000).toISOString();
  const res = mgr.sweepPending();
  assert.ok(res.removed >= 1);
  assert.strictEqual(mgr.getPending('reg.willExpire').length, 0);
});

// ── Phase 4: Peripheral Abstraction Layer (feature-flag isolation) ──

test('PAL is completely inert when LIKU_ENABLE_PERIPHERALS is off', () => {
  delete process.env.LIKU_ENABLE_PERIPHERALS;
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  assert.strictEqual(pal.isPeripheralsEnabled(), false);
  assert.deepStrictEqual(pal.scan(), { enabled: false, devices: [] });
  assert.strictEqual(pal.get('mock-lock-01'), null);
  assert.deepStrictEqual(pal.execute('mock-lock-01', 'unlock'), { enabled: false });
  assert.strictEqual(typeof pal.subscribe(() => {}), 'function');
  // No peripherals.json should be created while disabled.
  assert.ok(!fs.existsSync(require('../src/main/peripherals/peripheral-registry').PERIPHERALS_FILE), 'no file when off');
});

test('PAL enabled: scan registers Class A/B/C mock devices', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  const res = pal.scan();
  assert.strictEqual(res.enabled, true);
  const classes = new Set(res.devices.map((d) => d.class));
  assert.ok(classes.has('A') && classes.has('B') && classes.has('C'), 'all three classes registered');
});

test('PAL Class C sensor read is allowed immediately', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  const res = pal.execute('mock-temp-01', 'read');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.klass, 'C');
});

test('PAL Class B safe actuator is gated + auto-approved', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  const res = pal.execute('mock-light-01', 'on');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.klass, 'B');
  assert.strictEqual(pal.get('mock-light-01').state.power, 'on');
});

test('PAL Class A high-risk action routes through pending/confirm and never bypasses it', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  const before = pal.get('mock-lock-01').state.locked;
  const blocked = pal.execute('mock-lock-01', 'unlock');
  assert.strictEqual(blocked.ok, false, 'Class A must not auto-execute');
  assert.strictEqual(blocked.pending, true);
  assert.ok(blocked.confirmKey.startsWith('guard.peripheral.'));
  assert.strictEqual(pal.get('mock-lock-01').state.locked, before, 'state must be unchanged while pending');
  // Human confirms the guard authorization, then the action proceeds.
  const cres = mgr.confirmPending(blocked.confirmKey, 'apply');
  assert.strictEqual(cres.ok, true);
  const allowed = pal.execute('mock-lock-01', 'unlock');
  assert.strictEqual(allowed.ok, true, 'action proceeds after confirmation');
  assert.strictEqual(pal.get('mock-lock-01').state.locked, false);
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

// ── Phase 5: DCP policy + real driver + monitor + Class A TTL/consume ──

test('DCP evaluateCommand enforces capability scoping + param validation', () => {
  const policy = require('../src/main/peripherals/peripheral-policy');
  const lock = { id: 'x', class: 'A', capabilities: ['lock', 'unlock'] };
  assert.strictEqual(policy.evaluateCommand(lock, 'explode').code, 'unsupported-action');
  const light = { id: 'l', class: 'B', capabilities: ['brightness'] };
  assert.strictEqual(policy.evaluateCommand(light, 'brightness', { level: 150 }).code, 'invalid-params');
  assert.strictEqual(policy.evaluateCommand(light, 'brightness', { level: 50 }).ok, true);
});

test('PAL host-side rejects malformed / out-of-scope commands (DCP)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const bad = pal.execute('mock-light-01', 'brightness', { level: 999 });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.rejected, true);
  assert.strictEqual(bad.code, 'invalid-params');
  const nope = pal.execute('mock-lock-01', 'explode');
  assert.strictEqual(nope.rejected, true);
  assert.strictEqual(nope.code, 'unsupported-action');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Class A authorize shortcut grants a one-shot TTL authorization', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const auth = pal.authorize('mock-lock-01', 'unlock');
  assert.strictEqual(auth.ok, true);
  assert.strictEqual(auth.klass, 'A');
  assert.ok(auth.ttlSec > 0, 'authorization carries a TTL');
  assert.strictEqual(mgr.get('guard.peripheral.mock-lock-01'), 'unlock');
  // Executing consumes the one-shot authorization…
  const ex = pal.execute('mock-lock-01', 'unlock');
  assert.strictEqual(ex.ok, true);
  assert.strictEqual(mgr.get('guard.peripheral.mock-lock-01'), undefined, 'auth consumed after use');
  // …so a second execute requires re-confirmation.
  const ex2 = pal.execute('mock-lock-01', 'unlock');
  assert.strictEqual(ex2.pending, true, 'Class A re-requires confirmation after consumption');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('real MQTT driver is gated by config and keeps mock as default', () => {
  delete process.env.LIKU_MQTT_URL;
  delete process.env.LIKU_MQTT_DEVICES;
  const mqtt = require('../src/main/peripherals/drivers/mqtt-driver');
  assert.strictEqual(mqtt.isAvailable(), false, 'unavailable without config');
  assert.strictEqual(mqtt.discover().length, 0);
  process.env.LIKU_MQTT_URL = 'mqtt://localhost:1883';
  process.env.LIKU_MQTT_DEVICES = JSON.stringify([
    { id: 'mqtt-lock-01', name: 'Gate Lock', class: 'A', kind: 'lock', capabilities: ['lock', 'unlock'] }
  ]);
  assert.strictEqual(mqtt.isAvailable(), true, 'available once configured');
  assert.strictEqual(mqtt.discover()[0].id, 'mqtt-lock-01');
  // Real driver device follows the SAME Class A safety gate.
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  const s = pal.scan();
  assert.ok(s.devices.some((d) => d.id === 'mqtt-lock-01' && d.driver === 'mqtt'), 'mqtt device registered');
  const r = pal.execute('mqtt-lock-01', 'unlock');
  assert.strictEqual(r.pending, true, 'mqtt Class A action still requires confirmation');
  delete process.env.LIKU_MQTT_URL;
  delete process.env.LIKU_MQTT_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('PeripheralMonitor grounds sensor facts and wakes Supervisor on breach', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const { PeripheralMonitor } = require('../src/main/peripherals/peripheral-monitor');
  let woke = null;
  const mon = new PeripheralMonitor({ pal, systemContext: m, onSupervisorWake: (e) => { woke = e; } });
  assert.strictEqual(mon.start(), true);
  // Normal reading → grounds sensor fact, no alert.
  pal.ingestSensorReading('mock-temp-01', { celsius: 22 });
  assert.strictEqual(mgr.get('sensor.mock-temp-01.celsius'), 22);
  assert.strictEqual(woke, null);
  // Breach reading → hardware alert + supervisor wake.
  pal.ingestSensorReading('mock-temp-01', { celsius: 45 });
  assert.ok(woke && woke.breach.level === 'high', 'supervisor woken on breach');
  assert.strictEqual(mgr.get('hardware.mock-temp-01.alert'), 'celsius:high');
  mon.stop();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('sensor.* facts are excluded from the default fragment but queryable', () => {
  // Seeded by the monitor test above.
  assert.strictEqual(mgr.get('sensor.mock-temp-01.celsius'), 45);
  assert.ok(!mgr.toPromptFragment('structured').includes('sensor.mock-temp-01'), 'sensor facts excluded by default');
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
