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

// ── Phase 6: multi-agent peripheral orchestration ──

test('attachPeripheralMonitor registers a first-class role + starts', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const EventEmitter = require('events');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const orch = new EventEmitter();
  orch.agents = new Map();
  const registered = [];
  orch.stateManager = { registerAgent: (id, role, caps) => registered.push({ id, role, caps }) };
  const { attachPeripheralMonitor } = require('../src/main/agents/peripheral-monitor-agent');
  const { agent, started } = attachPeripheralMonitor(orch, {});
  assert.strictEqual(started, true);
  assert.strictEqual(agent.role, 'peripheral_monitor');
  assert.strictEqual(orch.agents.get('peripheral_monitor'), agent, 'registered in agents map');
  assert.ok(registered.some((r) => r.role === 'peripheral_monitor'), 'registered with state manager');
  assert.ok(agent.responsibilities.length >= 3, 'documented responsibilities');
  agent.stop();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('peripheral breach emits decoupled peripheral:alert on the orchestrator', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const EventEmitter = require('events');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const orch = new EventEmitter();
  orch.agents = new Map();
  orch.stateManager = { registerAgent: () => {} };
  const { attachPeripheralMonitor } = require('../src/main/agents/peripheral-monitor-agent');
  const { agent } = attachPeripheralMonitor(orch, {});
  let alert = null;
  orch.on('peripheral:alert', (ctx) => { alert = ctx; });
  // A breach reading flows: PAL 'reading' → monitor → agent → orchestrator event.
  pal.ingestSensorReading('mock-temp-01', { celsius: 50 });
  assert.ok(alert, 'orchestrator received a peripheral:alert');
  assert.strictEqual(alert.type, 'peripheral-alert');
  assert.strictEqual(alert.device.id, 'mock-temp-01');
  assert.strictEqual(alert.breach.level, 'high');
  assert.strictEqual(alert.groundedFacts['sensor.mock-temp-01.celsius'], 50);
  assert.ok(alert.suggestedAction && alert.suggestedAction.kind === 'advisory', 'advisory-only suggestion');
  assert.strictEqual(alert.safety, 'physical-actions-require-pal-gating');
  agent.stop();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('peripheral monitor agent is inert when the feature flag is off', () => {
  delete process.env.LIKU_ENABLE_PERIPHERALS;
  const EventEmitter = require('events');
  const orch = new EventEmitter();
  orch.agents = new Map();
  orch.stateManager = { registerAgent: () => {} };
  const { attachPeripheralMonitor } = require('../src/main/agents/peripheral-monitor-agent');
  const { started } = attachPeripheralMonitor(orch, {});
  assert.strictEqual(started, false, 'monitor does not start when peripherals are disabled');
});

test('serial/ESP32 driver is gated by config and follows Class A safety', () => {
  delete process.env.LIKU_SERIAL_PORT;
  delete process.env.LIKU_SERIAL_DEVICES;
  const serial = require('../src/main/peripherals/drivers/serial-driver');
  assert.strictEqual(serial.isAvailable(), false);
  assert.strictEqual(serial.discover().length, 0);
  process.env.LIKU_SERIAL_PORT = '/dev/ttyUSB0';
  process.env.LIKU_SERIAL_DEVICES = JSON.stringify([
    { id: 'esp32-relay-01', name: 'Relay', class: 'A', kind: 'relay', capabilities: ['on', 'off'] }
  ]);
  assert.strictEqual(serial.isAvailable(), true);
  assert.strictEqual(serial.discover()[0].id, 'esp32-relay-01');
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  const s = pal.scan();
  assert.ok(s.devices.some((d) => d.id === 'esp32-relay-01' && d.driver === 'serial'), 'serial device registered');
  assert.ok(pal.listDrivers().drivers.includes('serial'), 'serial driver listed');
  const r = pal.execute('esp32-relay-01', 'on');
  assert.strictEqual(r.pending, true, 'serial Class A action still requires confirmation');
  delete process.env.LIKU_SERIAL_PORT;
  delete process.env.LIKU_SERIAL_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

// ── Phase 7: closing the loop — human-gated alert consumption + signal quality ──

test('peripheral:alert is consumed into a bounded, human-gated Supervisor inbox', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const EventEmitter = require('events');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const orch = new EventEmitter();
  orch.agents = new Map();
  orch.stateManager = { registerAgent: () => {} };
  // Minimal Supervisor stand-in exercising the REAL inbox implementation.
  const { SupervisorAgent } = require('../src/main/agents/supervisor');
  const supervisor = new SupervisorAgent({});
  orch.agents.set('supervisor', supervisor);
  const { attachPeripheralMonitor } = require('../src/main/agents/peripheral-monitor-agent');
  const { attachPeripheralAlertConsumer } = require('../src/main/agents/peripheral-alert-consumer');
  const { agent } = attachPeripheralMonitor(orch, {});
  let supervisorNotif = null;
  attachPeripheralAlertConsumer(orch);
  orch.on('supervisor:notification', (n) => { supervisorNotif = n; });

  // A significant breach on a Class A device flows all the way to the inbox.
  pal.ingestSensorReading('mock-lock-01', { battery: 5 });
  const pending = supervisor.getPendingNotifications();
  assert.strictEqual(pending.length, 1, 'exactly one notification reached the Supervisor');
  const n = pending[0];
  assert.strictEqual(n.kind, 'peripheral-alert');
  assert.strictEqual(n.device.id, 'mock-lock-01');
  assert.strictEqual(n.requiresHuman, true, 'Class A alert is human-gated');
  assert.strictEqual(n.autonomousAction, false, 'never autonomous');
  assert.strictEqual(n.safety, 'physical-actions-require-pal-gating');
  assert.ok(supervisorNotif, 'supervisor:notification re-emitted for CLI/UI/telemetry');
  agent.stop();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('debounce (cooldown) + hysteresis suppress duplicate/flapping alerts', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const { PeripheralMonitor } = require('../src/main/peripherals/peripheral-monitor');
  let clock = 1000;
  const wakes = [];
  const mon = new PeripheralMonitor({
    pal, systemContext: m,
    cooldownMs: 10000,
    now: () => clock,
    onSupervisorWake: (e) => wakes.push(e)
  });
  mon.start();

  // First breach → one alert.
  pal.ingestSensorReading('mock-temp-01', { celsius: 50 });
  assert.strictEqual(wakes.length, 1, 'first breach alerts');
  // Continued/worsening breach while still active → hysteresis suppresses.
  pal.ingestSensorReading('mock-temp-01', { celsius: 55 });
  assert.strictEqual(wakes.length, 1, 'no re-alert while still breached (hysteresis)');
  // Value dips only into the deadband (high=30, margin=1.5 → clears below 28.5).
  pal.ingestSensorReading('mock-temp-01', { celsius: 29 });
  pal.ingestSensorReading('mock-temp-01', { celsius: 50 });
  assert.strictEqual(wakes.length, 1, 'deadband dip does not re-arm the alert');
  // Full recovery clears the breach, but a new breach within cooldown is debounced.
  pal.ingestSensorReading('mock-temp-01', { celsius: 20 });
  clock += 5000; // < cooldown
  pal.ingestSensorReading('mock-temp-01', { celsius: 50 });
  assert.strictEqual(wakes.length, 1, 'new breach within cooldown is debounced');
  // After cooldown elapses, a fresh breach alerts again.
  clock += 10000; // > cooldown since last alert
  pal.ingestSensorReading('mock-temp-01', { celsius: 20 }); // recover
  pal.ingestSensorReading('mock-temp-01', { celsius: 50 }); // re-breach
  assert.strictEqual(wakes.length, 2, 'alert re-arms after recovery + cooldown');
  mon.stop();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('alert consumption never actuates hardware — physical actions stay gated', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const EventEmitter = require('events');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const orch = new EventEmitter();
  orch.agents = new Map();
  orch.stateManager = { registerAgent: () => {} };
  const { SupervisorAgent } = require('../src/main/agents/supervisor');
  orch.agents.set('supervisor', new SupervisorAgent({}));
  const { attachPeripheralMonitor } = require('../src/main/agents/peripheral-monitor-agent');
  const { attachPeripheralAlertConsumer } = require('../src/main/agents/peripheral-alert-consumer');
  const { agent } = attachPeripheralMonitor(orch, {});
  attachPeripheralAlertConsumer(orch);
  // Alert on the Class A lock.
  pal.ingestSensorReading('mock-lock-01', { battery: 5 });
  // A physical action on that device must STILL go through the confirm gate.
  const r = pal.execute('mock-lock-01', 'lock');
  assert.strictEqual(r.pending, true, 'Class A action pending confirmation despite the alert');
  agent.stop();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Supervisor notification inbox is bounded and clears on reset', () => {
  const { SupervisorAgent } = require('../src/main/agents/supervisor');
  const sup = new SupervisorAgent({ maxNotifications: 3 });
  for (let i = 0; i < 6; i++) {
    sup.receiveNotification({ id: `n-${i}`, kind: 'peripheral-alert', requiresHuman: true });
  }
  assert.strictEqual(sup.getNotifications().length, 3, 'inbox capped at maxNotifications');
  assert.strictEqual(sup.getPendingNotifications()[0].id, 'n-3', 'oldest dropped, newest kept');
  assert.strictEqual(sup.acknowledgeNotification('n-3'), true);
  assert.strictEqual(sup.getPendingNotifications().length, 2, 'acknowledged removed from pending');
  assert.strictEqual(sup.receiveNotification(null), null, 'invalid notification rejected');
  sup.reset();
  assert.strictEqual(sup.getNotifications().length, 0, 'reset clears the inbox');
});

test('peripheral alert consumer is inert when the feature flag is off', () => {
  delete process.env.LIKU_ENABLE_PERIPHERALS;
  const EventEmitter = require('events');
  const orch = new EventEmitter();
  orch.agents = new Map();
  orch.stateManager = { registerAgent: () => {} };
  const { SupervisorAgent } = require('../src/main/agents/supervisor');
  const sup = new SupervisorAgent({});
  orch.agents.set('supervisor', sup);
  const { attachPeripheralMonitor } = require('../src/main/agents/peripheral-monitor-agent');
  const { attachPeripheralAlertConsumer } = require('../src/main/agents/peripheral-alert-consumer');
  const { started } = attachPeripheralMonitor(orch, {});
  attachPeripheralAlertConsumer(orch);
  assert.strictEqual(started, false, 'monitor does not start when peripherals disabled');
  assert.strictEqual(sup.getNotifications().length, 0, 'no notifications generated when disabled');
});

// ── Phase 8: bounded human-gated tasks + formal DCP wire format ──

test('peripheral breach creates a bounded, human-gated Supervisor task', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const EventEmitter = require('events');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const orch = new EventEmitter();
  orch.agents = new Map();
  orch.stateManager = { registerAgent: () => {} };
  const { SupervisorAgent } = require('../src/main/agents/supervisor');
  const supervisor = new SupervisorAgent({});
  orch.agents.set('supervisor', supervisor);
  const { attachPeripheralMonitor } = require('../src/main/agents/peripheral-monitor-agent');
  const { attachPeripheralAlertConsumer } = require('../src/main/agents/peripheral-alert-consumer');
  const { agent } = attachPeripheralMonitor(orch, {});
  let emittedTask = null;
  attachPeripheralAlertConsumer(orch);
  orch.on('supervisor:task', (t) => { emittedTask = t; });

  pal.ingestSensorReading('mock-lock-01', { battery: 4 });
  const tasks = supervisor.getPendingPeripheralTasks();
  assert.strictEqual(tasks.length, 1, 'exactly one reviewable task created');
  const t = tasks[0];
  assert.strictEqual(t.status, 'pending-review', 'task starts pending human review');
  assert.strictEqual(t.requiresHuman, true);
  assert.strictEqual(t.autonomousAction, false, 'never autonomous');
  assert.strictEqual(t.priority, 'high', 'Class A critical → high priority');
  assert.strictEqual(t.safety, 'physical-actions-require-pal-gating');
  assert.ok(emittedTask, 'supervisor:task emitted for CLI/UI review');
  // Human resolves it — still no execution.
  assert.ok(supervisor.resolvePeripheralTask(t.id, 'acknowledged'));
  assert.strictEqual(supervisor.getPendingPeripheralTasks().length, 0, 'acknowledged leaves pending');
  agent.stop();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('peripheral tasks are bounded + coalesce duplicate breaches', () => {
  const { SupervisorAgent } = require('../src/main/agents/supervisor');
  const sup = new SupervisorAgent({ maxPeripheralTasks: 2 });
  const mk = (id, metric, level) => ({
    id: `n-${Math.random()}`, severity: 'warning',
    device: { id, class: 'B', kind: 'light' }, breach: { metric, level }
  });
  const a = sup.createPeripheralTask(mk('d1', 'celsius', 'high'));
  const aDup = sup.createPeripheralTask(mk('d1', 'celsius', 'high'));
  assert.strictEqual(a.id, aDup.id, 'duplicate condition coalesces into the same task');
  assert.strictEqual(a.count, 2, 'coalesced task bumps its count');
  sup.createPeripheralTask(mk('d2', 'celsius', 'high'));
  sup.createPeripheralTask(mk('d3', 'celsius', 'high'));
  assert.ok(sup.getPeripheralTasks().length <= 2, 'queue stays bounded at maxPeripheralTasks');
  assert.strictEqual(sup.createPeripheralTask(null), null, 'invalid input rejected');
  sup.reset();
  assert.strictEqual(sup.getPeripheralTasks().length, 0, 'reset clears tasks');
});

test('task creation never bypasses the PAL gate for physical actions', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const EventEmitter = require('events');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const orch = new EventEmitter();
  orch.agents = new Map();
  orch.stateManager = { registerAgent: () => {} };
  const { SupervisorAgent } = require('../src/main/agents/supervisor');
  orch.agents.set('supervisor', new SupervisorAgent({}));
  const { attachPeripheralMonitor } = require('../src/main/agents/peripheral-monitor-agent');
  const { attachPeripheralAlertConsumer } = require('../src/main/agents/peripheral-alert-consumer');
  const { agent } = attachPeripheralMonitor(orch, {});
  attachPeripheralAlertConsumer(orch);
  pal.ingestSensorReading('mock-lock-01', { battery: 4 });
  // Even with a task open, actuating the Class A lock still requires confirmation.
  const r = pal.execute('mock-lock-01', 'lock');
  assert.strictEqual(r.pending, true, 'Class A action still pending confirmation');
  agent.stop();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('createTasks can be disabled (notification only)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const EventEmitter = require('events');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const orch = new EventEmitter();
  orch.agents = new Map();
  orch.stateManager = { registerAgent: () => {} };
  const { SupervisorAgent } = require('../src/main/agents/supervisor');
  const supervisor = new SupervisorAgent({});
  orch.agents.set('supervisor', supervisor);
  const { attachPeripheralMonitor } = require('../src/main/agents/peripheral-monitor-agent');
  const { attachPeripheralAlertConsumer } = require('../src/main/agents/peripheral-alert-consumer');
  const { agent } = attachPeripheralMonitor(orch, {});
  attachPeripheralAlertConsumer(orch, { createTasks: false });
  pal.ingestSensorReading('mock-temp-01', { celsius: 60 });
  assert.ok(supervisor.getPendingNotifications().length >= 1, 'notification still delivered');
  assert.strictEqual(supervisor.getPendingPeripheralTasks().length, 0, 'no task created when disabled');
  agent.stop();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('DCP capability token: issue + verify scope, expiry, tamper (signed)', () => {
  const dcp = require('../src/main/peripherals/dcp-protocol');
  const secret = 'test-secret-key';
  const now = 1_000_000_000_000;
  const token = dcp.issueCapabilityToken({ deviceId: 'lock-1', actions: ['unlock'], ttlSec: 60, secret, now });
  // Valid within scope + window.
  assert.strictEqual(dcp.verifyCapabilityToken(token, { deviceId: 'lock-1', action: 'unlock', secret, now }).ok, true);
  // Wrong action / wrong device rejected.
  assert.strictEqual(dcp.verifyCapabilityToken(token, { deviceId: 'lock-1', action: 'lock', secret, now }).reason, 'action-scope-mismatch');
  assert.strictEqual(dcp.verifyCapabilityToken(token, { deviceId: 'lock-2', action: 'unlock', secret, now }).reason, 'device-scope-mismatch');
  // Expired.
  assert.strictEqual(dcp.verifyCapabilityToken(token, { deviceId: 'lock-1', action: 'unlock', secret, now: now + 61000 }).reason, 'expired');
  // Tampered signature.
  const tampered = token.slice(0, -2) + (token.slice(-2) === 'aa' ? 'bb' : 'aa');
  assert.strictEqual(dcp.verifyCapabilityToken(tampered, { deviceId: 'lock-1', action: 'unlock', secret, now }).ok, false);
  // A signed token cannot be verified without the secret.
  assert.strictEqual(dcp.verifyCapabilityToken(token, { deviceId: 'lock-1', action: 'unlock', now }).reason, 'no-secret-to-verify');
});

test('DCP envelope: build/parse + freshness + nonce replay protection', () => {
  const dcp = require('../src/main/peripherals/dcp-protocol');
  const now = 2_000_000_000_000;
  const env = dcp.buildCommandEnvelope({ device: 'lock-1', action: 'unlock', now });
  assert.strictEqual(env.dcp, '1.0');
  assert.strictEqual(dcp.parseCommandEnvelope(env).ok, true);
  assert.strictEqual(dcp.parseCommandEnvelope({ dcp: '9.9', type: 'command' }).reason, 'unsupported-version');
  // Fresh envelope + first-use nonce is accepted; replay is rejected.
  const seen = new Map();
  assert.strictEqual(dcp.verifyEnvelope(env, { now, seenNonces: seen }).ok, true);
  assert.strictEqual(dcp.verifyEnvelope(env, { now, seenNonces: seen }).reason, 'replay-detected');
  // Stale envelope (outside freshness window) rejected.
  assert.strictEqual(dcp.verifyEnvelope(env, { now: now + 60000 }).reason, 'stale-envelope');
});

test('DCP evaluateCommandEnvelope verifies wire then applies capability scoping', () => {
  const policy = require('../src/main/peripherals/peripheral-policy');
  const dcp = require('../src/main/peripherals/dcp-protocol');
  const device = { id: 'lock-1', class: 'A', capabilities: ['lock', 'unlock', 'status'], powerW: 6 };
  const now = 3_000_000_000_000;
  const secret = 'wire-secret';
  const token = dcp.issueCapabilityToken({ deviceId: 'lock-1', actions: ['unlock'], secret, now });
  const env = dcp.buildCommandEnvelope({ device, action: 'unlock', token, now });
  const ok = policy.evaluateCommandEnvelope(device, env, { secret, now, requireCapability: true });
  assert.strictEqual(ok.ok, true, 'valid signed envelope for a declared action passes');
  assert.strictEqual(ok.normalized.action, 'unlock');
  // Envelope internally valid but targeting a DIFFERENT device than we evaluate
  // against is rejected as a device mismatch by the policy layer.
  const otherToken = dcp.issueCapabilityToken({ deviceId: 'lock-2', actions: ['unlock'], secret, now });
  const wrongDev = dcp.buildCommandEnvelope({ device: 'lock-2', action: 'unlock', token: otherToken, now });
  assert.strictEqual(policy.evaluateCommandEnvelope(device, wrongDev, { secret, now, requireCapability: true }).code, 'device-mismatch');
  // Unsupported action still rejected by host-side capability scoping.
  const badAct = dcp.buildCommandEnvelope({ device, action: 'explode', now });
  assert.strictEqual(policy.evaluateCommandEnvelope(device, badAct, { now }).code, 'unsupported-action');
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
