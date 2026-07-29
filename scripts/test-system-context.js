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

// ── Phase 9: durable persistence + live cumulative power budgeting ──

test('peripheral tasks + notifications persist across a restart', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const { SupervisorAgent } = require('../src/main/agents/supervisor');
  const store = require('../src/main/agents/supervisor-task-store');
  store.clear();
  const s1 = new SupervisorAgent({ persistTasks: true });
  s1.receiveNotification({ id: 'n1', severity: 'critical', device: { id: 'lock-1', class: 'A' }, breach: { metric: 'battery', level: 'low' } });
  s1.createPeripheralTask({ id: 'n1', severity: 'critical', device: { id: 'lock-1', class: 'A', kind: 'lock' }, breach: { metric: 'battery', level: 'low' } });
  // "Restart": a fresh instance reloads durable state from disk.
  const s2 = new SupervisorAgent({ persistTasks: true });
  assert.strictEqual(s2.getNotifications().length, 1, 'notification survived restart');
  assert.strictEqual(s2.getPendingPeripheralTasks().length, 1, 'task survived restart');
  assert.strictEqual(s2.getPeripheralTasks()[0].escalation, 'escalate', 'critical → escalate routing');
  // Resolution persists too.
  const tid = s2.getPeripheralTasks()[0].id;
  s2.resolvePeripheralTask(tid, 'acknowledged');
  const s3 = new SupervisorAgent({ persistTasks: true });
  assert.strictEqual(s3.getPendingPeripheralTasks().length, 0, 'resolution survived restart');
  store.clear();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('supervisor task store is flag-gated (no disk when disabled)', () => {
  delete process.env.LIKU_ENABLE_PERIPHERALS;
  const store = require('../src/main/agents/supervisor-task-store');
  assert.strictEqual(store.enabled(), false);
  assert.deepStrictEqual(store.load(), { notifications: [], tasks: [] });
  assert.strictEqual(store.save({ tasks: [{ id: 'x' }] }), false, 'save is a no-op when disabled');
});

test('resolved tasks expire on load (retention/cleanup)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const store = require('../src/main/agents/supervisor-task-store');
  store.clear();
  const old = Date.now() - 7 * 3600 * 1000; // 7h ago (> 6h resolved retention)
  const payload = {
    schemaVersion: '1.0.0', updatedAt: new Date().toISOString(), notifications: [],
    tasks: [
      { id: 'old', status: 'acknowledged', priority: 'low', createdAt: new Date(old).toISOString(), resolvedAt: new Date(old).toISOString() },
      { id: 'fresh', status: 'pending-review', priority: 'high', createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() }
    ]
  };
  fs.writeFileSync(store.STORE_FILE, JSON.stringify(payload));
  const { tasks } = store.load();
  assert.ok(!tasks.find((t) => t.id === 'old'), 'stale resolved task pruned on load');
  assert.ok(tasks.find((t) => t.id === 'fresh'), 'fresh open task retained');
  store.clear();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('cumulative power budget logic blocks over-budget actions (policy unit)', () => {
  const policy = require('../src/main/peripherals/peripheral-policy');
  const light = { id: 'l1', class: 'B', capabilities: ['on', 'off', 'brightness'], powerW: 10, state: { power: 'off' } };
  // Others already drawing near the ceiling → turning on 10W pushes over budget.
  const over = policy.evaluateCommand(light, 'on', {}, { maxTotalPowerW: 5000, otherDevicesLoadW: 4995 });
  assert.strictEqual(over.ok, false);
  assert.strictEqual(over.code, 'power-budget-exceeded');
  assert.ok(over.power && over.power.projectedTotalW > over.power.budgetW);
  // Under budget passes.
  assert.strictEqual(policy.evaluateCommand(light, 'on', {}, { maxTotalPowerW: 5000, otherDevicesLoadW: 100 }).ok, true);
  // 'off' projects 0W → allowed even at high load (fail-safe direction).
  assert.strictEqual(policy.evaluateCommand(light, 'off', {}, { maxTotalPowerW: 5000, otherDevicesLoadW: 4999 }).ok, true);
  // Device-load estimation model.
  assert.strictEqual(policy.estimateDeviceLoadW({ class: 'C', powerW: 1, state: {} }), 1, 'sensor standby draw');
  assert.strictEqual(policy.estimateDeviceLoadW({ class: 'B', powerW: 10, state: { power: 'off' } }), 0, 'idle actuator = 0W');
  assert.strictEqual(policy.estimateDeviceLoadW({ class: 'B', powerW: 10, state: { power: 'on' } }), 10, 'active actuator = rated');
});

test('PAL powerStatus reports cumulative usage, budget and headroom', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const ps = pal.powerStatus();
  assert.strictEqual(ps.enabled, true);
  assert.ok(Number.isFinite(ps.currentW) && Number.isFinite(ps.budgetW));
  assert.strictEqual(ps.headroomW, Math.round((ps.budgetW - ps.currentW) * 100) / 100);
  assert.ok(Array.isArray(ps.devices) && ps.devices.length >= 3, 'per-device breakdown');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('PAL enforces the cumulative power budget end-to-end and restores', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  // Force a tiny budget (guard.* needs >=0.9 + a trusted source).
  m.getInstance().proposeUpdate('guard.peripherals.max_total_power_w', 5, { source: 'telemetry', confidence: 0.95 });
  const r = pal.execute('mock-light-01', 'on'); // 10W projected > 5W budget → blocked
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'power-budget-exceeded');
  assert.ok(r.power && r.power.projectedTotalW > r.power.budgetW, 'reports projected vs budget');
  // Restore a sane budget so later assertions see default headroom.
  m.getInstance().proposeUpdate('guard.peripherals.max_total_power_w', 5000, { source: 'telemetry', confidence: 0.95 });
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('remote drivers require signed capability tokens when a secret is configured', () => {
  const policy = require('../src/main/peripherals/peripheral-policy');
  const dcp = require('../src/main/peripherals/dcp-protocol');
  const device = { id: 'r1', class: 'B', capabilities: ['on', 'off'], powerW: 10, state: { power: 'off' } };
  const now = 4_000_000_000_000;
  const secret = 'remote-secret';
  const ctx = { secret, now, otherDevicesLoadW: 0, maxTotalPowerW: 5000 };
  // Remote + secret + NO capability → rejected (signed token mandatory).
  const noTok = dcp.buildCommandEnvelope({ device, action: 'on', now });
  assert.strictEqual(policy.evaluateCommandEnvelope(device, noTok, { ...ctx, driverRemote: true }).code, 'envelope-missing-capability');
  // Remote + secret + signed token → passes.
  const tok = dcp.issueCapabilityToken({ deviceId: 'r1', actions: ['on'], secret, now });
  const signed = dcp.buildCommandEnvelope({ device, action: 'on', token: tok, now });
  assert.strictEqual(policy.evaluateCommandEnvelope(device, signed, { ...ctx, driverRemote: true }).ok, true);
  // Local driver + secret + no token → allowed (unsigned convenience).
  assert.strictEqual(policy.evaluateCommandEnvelope(device, dcp.buildCommandEnvelope({ device, action: 'on', now }), { ...ctx, driverRemote: false }).ok, true);
  // Driver remoteness flags + signing helper.
  assert.strictEqual(require('../src/main/peripherals/drivers/mqtt-driver').REMOTE, true);
  assert.strictEqual(require('../src/main/peripherals/drivers/serial-driver').REMOTE, false);
  assert.strictEqual(dcp.isSigningConfigured('x'), true);
  assert.strictEqual(dcp.isSigningConfigured(), false);
});

// ── Phase 10: multi-process locking + new driver + HIL simulation ──

test('advisory lock provides mutual exclusion + stale steal', () => {
  const lockmod = require('../src/shared/atomic-file');
  const target = path.join(TMP_HOME, 'lock-test.json');
  const l1 = lockmod.acquireLockSync(target, { retries: 0 });
  assert.strictEqual(l1.locked, true);
  const l2 = lockmod.acquireLockSync(target, { retries: 1, retryDelayMs: 5 });
  assert.strictEqual(l2.locked, false, 'second acquire blocked while held');
  l1.release();
  const l3 = lockmod.acquireLockSync(target, { retries: 0 });
  assert.strictEqual(l3.locked, true, 're-acquire after release');
  l3.release();
  // Stale lock (crashed holder) is stolen.
  const lockPath = `${target}.lock`;
  fs.mkdirSync(lockPath);
  const past = Date.now() / 1000 - 60; // 60s ago
  fs.utimesSync(lockPath, past, past);
  const l4 = lockmod.acquireLockSync(target, { retries: 1, staleMs: 1000 });
  assert.strictEqual(l4.locked, true, 'stale lock stolen');
  l4.release();
});

test('atomicWriteFileSync writes valid JSON and leaves no lock/tmp residue', () => {
  const { atomicWriteFileSync } = require('../src/shared/atomic-file');
  const target = path.join(TMP_HOME, 'atomic-test.json');
  for (let i = 0; i < 5; i++) atomicWriteFileSync(target, JSON.stringify({ i, big: 'x'.repeat(200) }));
  JSON.parse(fs.readFileSync(target, 'utf8')); // valid
  const residue = fs.readdirSync(TMP_HOME).filter((f) => f.startsWith('atomic-test.json.') && (f.endsWith('.tmp') || f.endsWith('.lock')));
  assert.strictEqual(residue.length, 0, 'no leftover .tmp/.lock');
});

test('concurrent processes write the store without corruption', () => {
  const { execFileSync } = require('child_process');
  const target = path.join(TMP_HOME, 'concurrency-test.json');
  const mod = path.resolve(__dirname, '../src/shared/atomic-file.js');
  const workerSrc = `
    const { parentPort, workerData } = require('worker_threads');
    const { atomicWriteFileSync } = require(workerData.mod);
    for (let i = 0; i < 40; i++) {
      atomicWriteFileSync(workerData.target, JSON.stringify({ w: workerData.id, i, big: 'y'.repeat(400) }));
    }
    parentPort.postMessage('done');
  `;
  const main = `
    const { Worker } = require('worker_threads');
    const fs = require('fs'); const path = require('path');
    const workerSrc = ${JSON.stringify(workerSrc)};
    const target = ${JSON.stringify(target)};
    const mod = ${JSON.stringify(mod)};
    let done = 0; const N = 4;
    function finish() {
      try { JSON.parse(fs.readFileSync(target, 'utf8')); } catch (e) { console.error('CORRUPT', e.message); process.exit(1); }
      const dir = path.dirname(target);
      const leftovers = fs.readdirSync(dir).filter((f) => f.indexOf('concurrency-test.json.') === 0 && (f.endsWith('.tmp') || f.endsWith('.lock')));
      if (leftovers.length) { console.error('LEFTOVERS', leftovers); process.exit(3); }
      process.exit(0);
    }
    for (let id = 0; id < N; id++) {
      const w = new Worker(workerSrc, { eval: true, workerData: { id, target, mod } });
      w.on('message', () => { if (++done === N) finish(); });
      w.on('error', (e) => { console.error(e); process.exit(2); });
    }
  `;
  // Throws if the child exits non-zero (corruption / residue / worker error).
  execFileSync(process.execPath, ['-e', main], { stdio: 'pipe' });
  JSON.parse(fs.readFileSync(target, 'utf8')); // still valid in this process
});

test('serial driver runs against the HIL simulator without hardware', () => {
  process.env.LIKU_PERIPHERAL_HIL = '1';
  delete process.env.LIKU_SERIAL_PORT; // no real port
  process.env.LIKU_SERIAL_DEVICES = JSON.stringify([
    { id: 'esp-led', name: 'LED', class: 'B', kind: 'light', capabilities: ['on', 'off'], powerW: 5 }
  ]);
  const serial = require('../src/main/peripherals/drivers/serial-driver');
  assert.strictEqual(serial.isAvailable(), true, 'available in HIL without a port');
  const r = serial.perform({ id: 'esp-led' }, 'on');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.simulated, true, 'routed to simulator');
  assert.strictEqual(r.state.power, 'on');
  assert.ok(r.envelope && r.envelope.dcp === '1.0', 'DCP envelope still built in HIL');
  delete process.env.LIKU_PERIPHERAL_HIL;
  delete process.env.LIKU_SERIAL_DEVICES;
});

test('BLE driver works through the full DCP + class gate + confirm path (HIL)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_HIL = '1';
  process.env.LIKU_BLE_DEVICES = JSON.stringify([
    { id: 'ble-lock-01', name: 'BLE Lock', class: 'A', kind: 'lock', capabilities: ['lock', 'unlock', 'status'], powerW: 4 },
    { id: 'ble-light-01', name: 'BLE Light', class: 'B', kind: 'light', capabilities: ['on', 'off'], powerW: 6 }
  ]);
  const ble = require('../src/main/peripherals/drivers/ble-driver');
  assert.strictEqual(ble.isAvailable(), true, 'available in HIL (no adapter)');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  const s = pal.scan();
  assert.ok(s.devices.some((d) => d.id === 'ble-lock-01' && d.driver === 'ble'), 'BLE device registered');
  assert.ok(pal.listDrivers().drivers.includes('ble'), 'ble driver listed');
  // Class B → gated + auto-approved → simulated.
  const rB = pal.execute('ble-light-01', 'on');
  assert.strictEqual(rB.ok, true);
  assert.strictEqual(rB.result.simulated, true, 'HIL executed the Class B action');
  // Class A → still requires confirmation even in HIL.
  const rA = pal.execute('ble-lock-01', 'unlock');
  assert.strictEqual(rA.pending, true, 'Class A still gated in HIL');
  // Authorize (human) then execute → simulated unlock.
  pal.authorize('ble-lock-01', 'unlock');
  const rA2 = pal.execute('ble-lock-01', 'unlock');
  assert.strictEqual(rA2.ok, true);
  assert.strictEqual(rA2.result.state.locked, false, 'simulator applied the unlock');
  delete process.env.LIKU_PERIPHERAL_HIL;
  delete process.env.LIKU_BLE_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('HIL is off by default and does not make real drivers available', () => {
  delete process.env.LIKU_PERIPHERAL_HIL;
  const hilmod = require('../src/main/peripherals/hil-simulator');
  assert.strictEqual(hilmod.isEnabled(), false);
  delete process.env.LIKU_SERIAL_PORT;
  process.env.LIKU_SERIAL_DEVICES = JSON.stringify([{ id: 'x', class: 'B', capabilities: ['on'] }]);
  const serial = require('../src/main/peripherals/drivers/serial-driver');
  assert.strictEqual(serial.isAvailable(), false, 'no HIL + no port → unavailable (isolated)');
  delete process.env.LIKU_SERIAL_DEVICES;
});

test('powerStatus surfaces HIL mode and locking strategy', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  let ps = pal.powerStatus();
  assert.strictEqual(ps.locking, 'advisory-file-lock');
  assert.strictEqual(ps.hil, false);
  process.env.LIKU_PERIPHERAL_HIL = '1';
  ps = pal.powerStatus();
  assert.strictEqual(ps.hil, true, 'HIL surfaced when enabled');
  delete process.env.LIKU_PERIPHERAL_HIL;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
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

// ── Phase 11: advanced escalation + driver surface expansion ──

test('notification channels are inert unless enabled + listed (default inbox-only)', () => {
  delete process.env.LIKU_ENABLE_PERIPHERALS;
  delete process.env.LIKU_PERIPHERAL_CHANNELS;
  const channels = require('../src/main/agents/notification-channels');
  assert.deepStrictEqual(channels.enabledChannels(), [], 'no channels when flag off');
  const r = channels.dispatch({ severity: 'critical', advisory: 'x' });
  assert.deepStrictEqual(r.delivered, [], 'nothing delivered when disabled');
});

test('file channel writes a bounded audit trail via the atomic writer', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_CHANNELS = 'file';
  const channels = require('../src/main/agents/notification-channels');
  const n = {
    severity: 'warning', advisory: 'temp high', requiresHuman: false,
    device: { id: 'z-temp-01' }, breach: { metric: 'celsius', level: 'high' }
  };
  const r = channels.dispatch(n);
  assert.ok(r.delivered.includes('file'), 'file channel delivered');
  assert.ok(fs.existsSync(channels.AUDIT_FILE), 'audit file created in isolated home');
  const lines = fs.readFileSync(channels.AUDIT_FILE, 'utf-8').split('\n').filter(Boolean);
  assert.ok(lines.length >= 1, 'audit line written');
  const rec = JSON.parse(lines[lines.length - 1]);
  assert.strictEqual(rec.autonomousAction, false, 'audit record is advisory-only');
  // No lock/tmp residue from the atomic write.
  const residue = fs.readdirSync(TMP_HOME).filter((f) => f.startsWith('peripheral-notifications.log.') && (f.endsWith('.tmp') || f.endsWith('.lock')));
  assert.strictEqual(residue.length, 0, 'no leftover .tmp/.lock');
  delete process.env.LIKU_PERIPHERAL_CHANNELS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('channel severity threshold suppresses below-threshold notifications', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_CHANNELS = 'webhook';
  // webhook default min-severity = warning → an info notification must NOT route.
  const channels = require('../src/main/agents/notification-channels');
  const info = channels.dispatch({ severity: 'info', advisory: 'noise', device: { id: 'x' } });
  assert.ok(!info.delivered.includes('webhook'), 'info below webhook threshold');
  delete process.env.LIKU_PERIPHERAL_CHANNELS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('auto-acknowledge resolves low severity but NEVER critical / Class A', () => {
  const { SupervisorAgent } = require('../src/main/agents/supervisor');
  const sup = new SupervisorAgent({ autoAckSeverities: 'info' });
  const info = sup.receiveNotification({ id: 'a1', severity: 'info', device: { id: 'c', class: 'C' } });
  assert.strictEqual(info.autoAcknowledged, true, 'info auto-acknowledged');
  assert.strictEqual(info.acknowledged, true);
  // Critical is never auto-acked even if severity list somehow includes it.
  const sup2 = new SupervisorAgent({ autoAckSeverities: 'info,critical' });
  const crit = sup2.receiveNotification({ id: 'a2', severity: 'critical', requiresHuman: true, device: { id: 'l', class: 'A' } });
  assert.ok(!crit.autoAcknowledged, 'critical never auto-acknowledged');
  assert.strictEqual(crit.acknowledged, false);
  assert.strictEqual(sup2.getPendingNotifications().length, 1, 'critical stays pending for human');
});

test('task cooldown suppresses flapping but never suppresses critical', () => {
  const { SupervisorAgent } = require('../src/main/agents/supervisor');
  let clock = 1_000_000;
  const sup = new SupervisorAgent({ taskCooldownMs: 60000, now: () => clock });
  const warnNotif = {
    id: 'n1', severity: 'warning', advisory: 'flapping',
    device: { id: 'z-temp-01', class: 'C', kind: 'sensor' }, breach: { metric: 'celsius', level: 'high' }
  };
  const t1 = sup.createPeripheralTask(warnNotif);
  assert.ok(t1 && t1.id, 'first task created');
  sup.resolvePeripheralTask(t1.id, 'acknowledged');
  // Same condition bounces back immediately → suppressed by cooldown.
  clock += 1000;
  const t2 = sup.createPeripheralTask({ ...warnNotif, id: 'n2' });
  assert.strictEqual(t2, null, 'flapping task suppressed within cooldown');
  // After the cooldown window → allowed again.
  clock += 61000;
  const t3 = sup.createPeripheralTask({ ...warnNotif, id: 'n3' });
  assert.ok(t3 && t3.id, 'task allowed after cooldown window');
  // Critical / Class A is NEVER suppressed, regardless of cooldown.
  const critNotif = {
    id: 'c1', severity: 'critical', requiresHuman: true,
    device: { id: 'z-lock-01', class: 'A', kind: 'lock' }, breach: { metric: 'tamper', level: 'high' }
  };
  const c1 = sup.createPeripheralTask(critNotif);
  sup.resolvePeripheralTask(c1.id, 'acknowledged');
  clock += 100;
  const c2 = sup.createPeripheralTask({ ...critNotif, id: 'c2' });
  assert.ok(c2 && c2.id, 'critical task never suppressed by cooldown');
  assert.notStrictEqual(c2.id, c1.id, 'a fresh critical task is created');
});

test('escalation query helpers surface escalated + by-severity tasks', () => {
  const { SupervisorAgent } = require('../src/main/agents/supervisor');
  const sup = new SupervisorAgent({});
  sup.createPeripheralTask({ id: 'n-lo', severity: 'info', device: { id: 'c1', class: 'C' }, breach: { metric: 'x', level: 'low' } });
  const hi = sup.createPeripheralTask({ id: 'n-hi', severity: 'critical', requiresHuman: true, device: { id: 'a1', class: 'A' }, breach: { metric: 'y', level: 'high' } });
  const esc = sup.getEscalatedPeripheralTasks();
  assert.strictEqual(esc.length, 1, 'exactly one escalated task');
  assert.strictEqual(esc[0].id, hi.id);
  assert.strictEqual(sup.getPeripheralTasksBySeverity('low').length, 1, 'one low-priority task');
});

test('zigbee driver works through the full DCP + class gate + confirm path (HIL)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_HIL = '1';
  delete process.env.LIKU_ZIGBEE_COORDINATOR; // no real coordinator
  process.env.LIKU_ZIGBEE_DEVICES = JSON.stringify([
    { id: 'zb-lock-01', name: 'Zigbee Lock', class: 'A', kind: 'lock', capabilities: ['lock', 'unlock', 'status'], powerW: 3 },
    { id: 'zb-plug-01', name: 'Zigbee Plug', class: 'B', kind: 'switch', capabilities: ['on', 'off'], powerW: 8 }
  ]);
  const zb = require('../src/main/peripherals/drivers/zigbee-driver');
  assert.strictEqual(zb.isAvailable(), true, 'available in HIL (no coordinator)');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  const s = pal.scan();
  assert.ok(s.devices.some((d) => d.id === 'zb-plug-01' && d.driver === 'zigbee'), 'zigbee device registered');
  assert.ok(pal.listDrivers().drivers.includes('zigbee'), 'zigbee driver listed');
  // Class B → gated + auto-approved → simulated.
  const rB = pal.execute('zb-plug-01', 'on');
  assert.strictEqual(rB.ok, true);
  assert.strictEqual(rB.result.simulated, true, 'HIL executed the Class B action');
  // Class A → still requires confirmation even in HIL.
  const rA = pal.execute('zb-lock-01', 'unlock');
  assert.strictEqual(rA.pending, true, 'Class A still gated in HIL');
  pal.authorize('zb-lock-01', 'unlock');
  const rA2 = pal.execute('zb-lock-01', 'unlock');
  assert.strictEqual(rA2.ok, true);
  assert.strictEqual(rA2.result.state.locked, false, 'simulator applied the unlock');
  delete process.env.LIKU_PERIPHERAL_HIL;
  delete process.env.LIKU_ZIGBEE_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('zigbee driver is unavailable without HIL and without a coordinator (isolated)', () => {
  delete process.env.LIKU_PERIPHERAL_HIL;
  delete process.env.LIKU_ZIGBEE_COORDINATOR;
  process.env.LIKU_ZIGBEE_DEVICES = JSON.stringify([{ id: 'zb-x', class: 'B', capabilities: ['on'] }]);
  const zb = require('../src/main/peripherals/drivers/zigbee-driver');
  assert.strictEqual(zb.isAvailable(), false, 'no HIL + no coordinator → unavailable');
  delete process.env.LIKU_ZIGBEE_DEVICES;
});

// ── Phase 12: real bidirectional BLE + power telemetry/history ──

/** Build a synchronous fake noble adapter for testing the real BLE path. */
function makeFakeNoble(specs) {
  const EventEmitter = require('events');
  const lib = new EventEmitter();
  lib.state = 'poweredOn';
  const peripherals = {};
  for (const spec of specs) {
    const writeChar = { uuid: spec.writeUuid, _lastWrite: null, write(buf, _wor, cb) { this._lastWrite = buf; if (cb) cb(); } };
    const notifyChar = new EventEmitter();
    notifyChar.uuid = spec.notifyUuid;
    notifyChar.subscribe = (cb) => { if (cb) cb(); };
    notifyChar.push = (obj) => notifyChar.emit('data', Buffer.from(JSON.stringify(obj)));
    const peripheral = {
      id: spec.peripheralId,
      address: spec.peripheralId,
      advertisement: { localName: spec.name || spec.peripheralId },
      connect(cb) { if (cb) cb(null); },
      discoverSomeServicesAndCharacteristics(_svc, _chs, cb) { cb(null, [{}], [writeChar, notifyChar]); },
      disconnect(cb) { if (cb) cb(); }
    };
    peripherals[spec.peripheralId] = { peripheral, writeChar, notifyChar };
  }
  lib.startScanning = () => { for (const k of Object.keys(peripherals)) lib.emit('discover', peripherals[k].peripheral); };
  lib.stopScanning = () => {};
  return { lib, peripherals };
}

test('BLE real transport connects, writes DCP envelope, and ingests notifications (fake adapter)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;        // REAL path, not HIL
  process.env.LIKU_BLE_ADAPTER = 'hci0-fake';    // makes the driver "available"
  process.env.LIKU_BLE_DEVICES = JSON.stringify([
    { id: 'ble-plug-01', name: 'BLE Plug', class: 'B', kind: 'switch', capabilities: ['on', 'off'], powerW: 10,
      peripheralId: 'p-plug', serviceUuid: 'ffe0', writeCharUuid: 'ffe1', notifyCharUuid: 'ffe2' }
  ]);
  const ble = require('../src/main/peripherals/drivers/ble-driver');
  const fake = makeFakeNoble([{ peripheralId: 'p-plug', writeUuid: 'ffe1', notifyUuid: 'ffe2' }]);
  ble._setBleLibForTest(fake.lib);

  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  assert.ok(pal.listDrivers().drivers.includes('ble'), 'ble available via fake adapter');

  // Capture inbound readings that flow through ingestSensorReading.
  const readings = [];
  const off = pal.on('reading', (r) => { if (r.id === 'ble-plug-01') readings.push(r); });

  // start streaming → central connects + subscribes synchronously via the fake.
  const stop = pal.startStreaming();

  // Class B actuation → real write of the DCP envelope to the write characteristic.
  const rB = pal.execute('ble-plug-01', 'on');
  assert.strictEqual(rB.ok, true, 'Class B real write succeeded');
  const written = fake.peripherals['p-plug'].writeChar._lastWrite;
  assert.ok(Buffer.isBuffer(written), 'a buffer was written to the characteristic');
  const env = JSON.parse(written.toString());
  assert.strictEqual(env.dcp, '1.0', 'DCP envelope written on the wire');
  assert.strictEqual(env.action, 'on');

  // Inbound notification → parsed → ingested → 'reading' event.
  fake.peripherals['p-plug'].notifyChar.push({ celsius: 30, humidity: 44 });
  assert.strictEqual(readings.length, 1, 'inbound notification ingested as a reading');
  assert.strictEqual(readings[0].metrics.celsius, 30);
  // The reading also updated last-known device state (read-only grounding).
  assert.strictEqual(pal.get('ble-plug-01').state.celsius, 30);

  stop(); off();
  ble._setBleLibForTest(null);
  delete process.env.LIKU_BLE_ADAPTER;
  delete process.env.LIKU_BLE_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('BLE real path still confirm-gates Class A even when connected', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;
  process.env.LIKU_BLE_ADAPTER = 'hci0-fake';
  process.env.LIKU_BLE_DEVICES = JSON.stringify([
    { id: 'ble-lock-02', name: 'BLE Lock', class: 'A', kind: 'lock', capabilities: ['lock', 'unlock'], powerW: 4,
      peripheralId: 'p-lock', writeCharUuid: 'aa01' }
  ]);
  const ble = require('../src/main/peripherals/drivers/ble-driver');
  const fake = makeFakeNoble([{ peripheralId: 'p-lock', writeUuid: 'aa01', notifyUuid: 'aa02' }]);
  ble._setBleLibForTest(fake.lib);
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const stop = pal.startStreaming(); // connection established
  // Even with a live connection, Class A must route through pending/confirm.
  const rA = pal.execute('ble-lock-02', 'unlock');
  assert.strictEqual(rA.pending, true, 'Class A gated despite being connected');
  assert.ok(!fake.peripherals['p-lock'].writeChar._lastWrite, 'no write happened before confirmation');
  pal.authorize('ble-lock-02', 'unlock');
  const rA2 = pal.execute('ble-lock-02', 'unlock');
  assert.strictEqual(rA2.ok, true, 'confirmed Class A action writes');
  assert.ok(fake.peripherals['p-lock'].writeChar._lastWrite, 'write happened after confirmation');
  stop();
  ble._setBleLibForTest(null);
  delete process.env.LIKU_BLE_ADAPTER;
  delete process.env.LIKU_BLE_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('power history records, queries, and summarizes (bounded, no residue)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const ph = require('../src/main/peripherals/power-history');
  ph.clear();
  ph.record({ totalW: 10, budgetW: 100, devices: [{ id: 'd1', loadW: 10, active: true }] });
  ph.record({ totalW: 42, budgetW: 100, devices: [{ id: 'd1', loadW: 42, active: true }] });
  ph.record({ totalW: 5, budgetW: 100, devices: [{ id: 'd1', loadW: 5, active: false }] });
  const all = ph.query();
  assert.strictEqual(all.length, 3, 'three samples persisted');
  const sum = ph.summary();
  assert.strictEqual(sum.count, 3);
  assert.strictEqual(sum.peakW, 42, 'peak captured');
  assert.strictEqual(sum.currentW, 5, 'latest is current');
  assert.strictEqual(sum.perDevicePeakW.d1, 42, 'per-device peak captured');
  // No lock/tmp residue from the atomic writer.
  const residue = fs.readdirSync(TMP_HOME).filter((f) => f.startsWith('power-history.jsonl.') && (f.endsWith('.tmp') || f.endsWith('.lock')));
  assert.strictEqual(residue.length, 0, 'no leftover .tmp/.lock');
  ph.clear();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('power history is flag-gated (no disk when disabled)', () => {
  delete process.env.LIKU_ENABLE_PERIPHERALS;
  const ph = require('../src/main/peripherals/power-history');
  assert.strictEqual(ph.record({ totalW: 99 }), null, 'record is a no-op when disabled');
  assert.deepStrictEqual(ph.query(), [], 'query empty when disabled');
  assert.ok(!fs.existsSync(ph.HISTORY_FILE), 'no history file written when disabled');
});

test('power schedule is inert with no config (default off)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_SCHEDULES;
  const sched = require('../src/main/peripherals/power-schedule');
  assert.strictEqual(sched.deviceScheduleW('anything'), null, 'no schedule → no restriction');
  assert.strictEqual(sched.evaluate('anything', 500).ok, true, 'no schedule → allowed');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('power schedule restricts outside its window but never grants power', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const sched = require('../src/main/peripherals/power-schedule');
  // In-window: allowed up to the cap; over the cap: blocked.
  const noon = new Date(2026, 6, 8, 12, 0, 0);
  process.env.LIKU_PERIPHERAL_SCHEDULES = JSON.stringify([{ id: 'heater', fromHour: 10, toHour: 14, maxW: 500 }]);
  assert.strictEqual(sched.evaluate('heater', 400, noon).ok, true, 'within window + under cap → ok');
  assert.strictEqual(sched.evaluate('heater', 600, noon).ok, false, 'within window but over cap → blocked');
  // Outside the window → must be off (cap 0).
  const midnight = new Date(2026, 6, 8, 0, 0, 0);
  const out = sched.evaluate('heater', 100, midnight);
  assert.strictEqual(out.ok, false, 'outside window → blocked');
  assert.strictEqual(out.code, 'power-schedule-exceeded');
  // A device with NO schedule is never affected.
  assert.strictEqual(sched.evaluate('other', 9999, midnight).ok, true, 'unscheduled device unaffected');
  delete process.env.LIKU_PERIPHERAL_SCHEDULES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('PAL enforces a power schedule end-to-end (blocks on outside its window)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_HIL = '1';
  // Build a 1-hour window that EXCLUDES the current hour so the test is deterministic.
  const h = new Date().getHours();
  const from = (h + 1) % 24;
  const to = (h + 2) % 24;
  process.env.LIKU_BLE_DEVICES = JSON.stringify([
    { id: 'sch-fan-01', name: 'Fan', class: 'B', kind: 'fan', capabilities: ['on', 'off'], powerW: 25 }
  ]);
  process.env.LIKU_PERIPHERAL_SCHEDULES = JSON.stringify([{ id: 'sch-fan-01', fromHour: from, toHour: to, maxW: 100 }]);
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const r = pal.execute('sch-fan-01', 'on');
  assert.strictEqual(r.ok, false, 'blocked outside scheduled window');
  assert.strictEqual(r.code, 'power-schedule-exceeded');
  assert.ok(r.schedule && r.schedule.scheduleW === 0, 'schedule cap is 0 outside window');
  delete process.env.LIKU_PERIPHERAL_SCHEDULES;
  delete process.env.LIKU_PERIPHERAL_HIL;
  delete process.env.LIKU_BLE_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('lock metrics count acquisitions and steals', () => {
  const af = require('../src/shared/atomic-file');
  af.resetLockMetrics();
  const target = path.join(TMP_HOME, 'lockmetrics.json');
  af.atomicWriteFileSync(target, JSON.stringify({ a: 1 }));
  let m = af.getLockMetrics();
  assert.ok(m.acquired >= 1, 'acquisition counted');
  // Force a stale steal.
  const lockPath = `${target}.lock`;
  fs.mkdirSync(lockPath);
  const past = Date.now() / 1000 - 60;
  fs.utimesSync(lockPath, past, past);
  const l = af.acquireLockSync(target, { retries: 1, staleMs: 1000 });
  assert.strictEqual(l.locked, true, 'stale lock stolen');
  l.release();
  m = af.getLockMetrics();
  assert.ok(m.steals >= 1, 'steal counted');
});

test('powerStatus surfaces historical peak/avg + schedule count', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const ph = require('../src/main/peripherals/power-history');
  ph.clear();
  ph.record({ totalW: 30, budgetW: 100, devices: [] });
  ph.record({ totalW: 70, budgetW: 100, devices: [] });
  process.env.LIKU_PERIPHERAL_SCHEDULES = JSON.stringify([{ id: 'x', fromHour: 0, toHour: 24, maxW: 10 }]);
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  const ps = pal.powerStatus();
  assert.strictEqual(ps.peakW, 70, 'peak surfaced from history');
  assert.ok(ps.samples >= 2, 'sample count surfaced');
  assert.strictEqual(ps.schedules, 1, 'schedule count surfaced');
  ph.clear();
  delete process.env.LIKU_PERIPHERAL_SCHEDULES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

// ── Phase 13: real bidirectional Zigbee + advanced scheduling + anomaly detection ──

/** Build a synchronous fake zigbee-herdsman for testing the real Zigbee path. */
function makeFakeHerdsman(devs) {
  const EventEmitter = require('events');
  const endpoints = {};
  const devices = {};
  for (const d of devs) {
    const ep = { _last: null, command(cluster, command, payload) { this._last = { cluster, command, payload }; return Promise.resolve(); } };
    endpoints[d.ieeeAddr] = ep;
    devices[d.ieeeAddr] = { getEndpoint: () => ep };
  }
  const created = [];
  class Controller extends EventEmitter {
    constructor() { super(); created.push(this); }
    start() { return Promise.resolve(); }
    getDeviceByIeeeAddr(addr) { return devices[addr] || null; }
    stop() {}
  }
  return {
    lib: { Controller },
    endpoints,
    push: (ieeeAddr, data) => { for (const c of created) c.emit('message', { device: { ieeeAddr }, data }); }
  };
}

test('Zigbee real transport connects, writes ZCL command, and ingests attribute reports (fake)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;              // REAL path, not HIL
  process.env.LIKU_ZIGBEE_COORDINATOR = '/dev/fake-zigbee';
  process.env.LIKU_ZIGBEE_DEVICES = JSON.stringify([
    { id: 'zb-plug-r1', name: 'Plug', class: 'B', kind: 'switch', capabilities: ['on', 'off'], powerW: 12, ieeeAddr: '0x00aa', endpoint: 1 }
  ]);
  const zb = require('../src/main/peripherals/drivers/zigbee-driver');
  const fake = makeFakeHerdsman([{ ieeeAddr: '0x00aa' }]);
  zb._setZigbeeLibForTest(fake.lib);

  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  assert.ok(pal.listDrivers().drivers.includes('zigbee'), 'zigbee available via coordinator');

  const readings = [];
  const off = pal.on('reading', (r) => { if (r.id === 'zb-plug-r1') readings.push(r); });
  const stop = pal.startStreaming(); // starts coordinator + report routing

  // Class B actuation → real ZCL command dispatched to the endpoint.
  const rB = pal.execute('zb-plug-r1', 'on');
  assert.strictEqual(rB.ok, true, 'Class B real command succeeded');
  assert.strictEqual(fake.endpoints['0x00aa']._last.cluster, 'genOnOff', 'ZCL cluster dispatched');
  assert.strictEqual(fake.endpoints['0x00aa']._last.command, 'on', 'ZCL command dispatched');

  // Inbound attribute report → parsed → ingested → 'reading' event.
  fake.push('0x00aa', { temperature: 24, humidity: 51 });
  assert.strictEqual(readings.length, 1, 'inbound attribute report ingested as a reading');
  assert.strictEqual(readings[0].metrics.temperature, 24);
  assert.strictEqual(pal.get('zb-plug-r1').state.temperature, 24, 'reading updated device state');

  stop(); off();
  zb._setZigbeeLibForTest(null);
  delete process.env.LIKU_ZIGBEE_COORDINATOR;
  delete process.env.LIKU_ZIGBEE_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Zigbee real path still confirm-gates Class A even when connected', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;
  process.env.LIKU_ZIGBEE_COORDINATOR = '/dev/fake-zigbee';
  process.env.LIKU_ZIGBEE_DEVICES = JSON.stringify([
    { id: 'zb-lock-r1', name: 'Lock', class: 'A', kind: 'lock', capabilities: ['lock', 'unlock'], powerW: 3, ieeeAddr: '0x00bb', endpoint: 1 }
  ]);
  const zb = require('../src/main/peripherals/drivers/zigbee-driver');
  const fake = makeFakeHerdsman([{ ieeeAddr: '0x00bb' }]);
  zb._setZigbeeLibForTest(fake.lib);
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const stop = pal.startStreaming();
  const rA = pal.execute('zb-lock-r1', 'unlock');
  assert.strictEqual(rA.pending, true, 'Class A gated despite being connected');
  assert.ok(!fake.endpoints['0x00bb']._last, 'no command dispatched before confirmation');
  pal.authorize('zb-lock-r1', 'unlock');
  const rA2 = pal.execute('zb-lock-r1', 'unlock');
  assert.strictEqual(rA2.ok, true, 'confirmed Class A action dispatches');
  assert.strictEqual(fake.endpoints['0x00bb']._last.command, 'unlockDoor', 'ZCL unlock dispatched after confirm');
  stop();
  zb._setZigbeeLibForTest(null);
  delete process.env.LIKU_ZIGBEE_COORDINATOR;
  delete process.env.LIKU_ZIGBEE_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('advanced schedule: per-day rule only governs its days (other days unrestricted)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const sched = require('../src/main/peripherals/power-schedule');
  const day = new Date(2026, 6, 8, 12, 0, 0); // a Wednesday
  const wd = day.getDay();
  const otherDay = (wd + 1) % 7;
  // Rule only for a DIFFERENT weekday → today is unrestricted (null).
  process.env.LIKU_PERIPHERAL_SCHEDULES = JSON.stringify([{ id: 'heater', fromHour: 0, toHour: 24, maxW: 100, days: [otherDay] }]);
  assert.strictEqual(sched.deviceScheduleW('heater', day), null, 'rule for another day does not govern today');
  // Rule for TODAY → governs (full-day window → cap 100).
  process.env.LIKU_PERIPHERAL_SCHEDULES = JSON.stringify([{ id: 'heater', fromHour: 0, toHour: 24, maxW: 100, days: [wd] }]);
  assert.strictEqual(sched.deviceScheduleW('heater', day), 100, "today's rule governs");
  assert.strictEqual(sched.evaluate('heater', 150, day).ok, false, 'over cap blocked on governed day');
  delete process.env.LIKU_PERIPHERAL_SCHEDULES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('advanced schedule: sunrise/sunset window tokens resolve', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_SUNRISE_HOUR = '6';
  process.env.LIKU_PERIPHERAL_SUNSET_HOUR = '18';
  const sched = require('../src/main/peripherals/power-schedule');
  // "off between sunrise and sunset" → daytime cap 0, night cap 500.
  process.env.LIKU_PERIPHERAL_SCHEDULES = JSON.stringify([{ id: 'lamp', fromHour: 'sunset', toHour: 'sunrise', maxW: 500 }]);
  const noon = new Date(2026, 6, 8, 12, 0, 0);
  const night = new Date(2026, 6, 8, 22, 0, 0);
  assert.strictEqual(sched.deviceScheduleW('lamp', noon), 0, 'daytime (outside sunset→sunrise) → off');
  assert.strictEqual(sched.deviceScheduleW('lamp', night), 500, 'night (inside sunset→sunrise) → cap 500');
  const d = sched.describe(night).find((r) => r.id === 'lamp');
  assert.strictEqual(d.resolvedFrom, 18, 'sunset resolved to 18');
  assert.strictEqual(d.resolvedTo, 6, 'sunrise resolved to 6');
  assert.strictEqual(d.active, true, 'active at night');
  delete process.env.LIKU_PERIPHERAL_SCHEDULES;
  delete process.env.LIKU_PERIPHERAL_SUNRISE_HOUR;
  delete process.env.LIKU_PERIPHERAL_SUNSET_HOUR;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('anomaly detection flags a power spike from history', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const anomaly = require('../src/main/peripherals/power-anomaly');
  const samples = [10, 11, 9, 10, 12, 10].map((w) => ({ totalW: w, at: new Date().toISOString() }));
  samples.push({ totalW: 200, at: new Date().toISOString() }); // clear spike
  const res = anomaly.detect({ samples });
  assert.ok(res.anomalies.some((a) => a.type === 'spike'), 'spike detected');
  assert.ok(res.baselineW < 20, 'baseline computed from history');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('anomaly detection is quiet on stable power + respects min samples', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const anomaly = require('../src/main/peripherals/power-anomaly');
  const stable = [50, 51, 49, 50, 52, 50, 51].map((w) => ({ totalW: w, at: new Date().toISOString() }));
  assert.strictEqual(anomaly.detect({ samples: stable }).anomalies.length, 0, 'no anomaly on stable power');
  // Too few samples → cannot judge.
  const few = [10, 200].map((w) => ({ totalW: w, at: new Date().toISOString() }));
  assert.strictEqual(anomaly.detect({ samples: few }).anomalies.length, 0, 'min-samples guard holds');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('anomaly detection is flag-gated', () => {
  delete process.env.LIKU_ENABLE_PERIPHERALS;
  const anomaly = require('../src/main/peripherals/power-anomaly');
  const samples = [10, 10, 10, 10, 10, 200].map((w) => ({ totalW: w, at: new Date().toISOString() }));
  assert.strictEqual(anomaly.detect({ samples }).anomalies.length, 0, 'no detection when disabled');
});

test('anomaly detection flags sustained deviation + over-budget', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const anomaly = require('../src/main/peripherals/power-anomaly');
  // Prior baseline ~20W, then last 3 samples sustained ~80W.
  const sustained = [20, 21, 19, 20, 22, 80, 82, 81].map((w) => ({ totalW: w, at: new Date().toISOString() }));
  const r1 = anomaly.detect({ samples: sustained });
  assert.ok(r1.anomalies.some((a) => a.type === 'sustained'), 'sustained deviation detected');
  // Over-budget on the latest sample.
  const ob = [10, 11, 10, 12, 10, 10].map((w) => ({ totalW: w, budgetW: 100, at: new Date().toISOString() }));
  ob.push({ totalW: 30, budgetW: 25, overBudget: true, at: new Date().toISOString() });
  const r2 = anomaly.detect({ samples: ob });
  assert.ok(r2.anomalies.some((a) => a.type === 'over-budget'), 'over-budget anomaly detected');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('PAL emits power-anomaly and surfaces anomalies via accessor + status (HIL)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_HIL = '1';
  const ph = require('../src/main/peripherals/power-history');
  ph.clear();
  // Seed a low, stable baseline.
  for (const w of [5, 6, 5, 5, 6, 5]) ph.record({ totalW: w, budgetW: 5000, devices: [] });
  process.env.LIKU_BLE_DEVICES = JSON.stringify([
    { id: 'anom-heater', name: 'Heater', class: 'B', kind: 'heater', capabilities: ['on', 'off'], powerW: 400 }
  ]);
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const events = [];
  const off = pal.on('power-anomaly', (e) => events.push(e));
  // Turning on a 400W device makes the freshly-recorded sample a spike vs baseline.
  const r = pal.execute('anom-heater', 'on');
  assert.strictEqual(r.ok, true, 'HIL actuation succeeded');
  assert.ok(events.length >= 1, 'power-anomaly event emitted on spike');
  assert.strictEqual(events[0].anomaly.type, 'spike');
  const acc = pal.getPowerAnomalies();
  assert.ok(acc.anomalies.length >= 1, 'accessor surfaces the anomaly');
  assert.ok(pal.powerStatus().anomalies >= 1, 'powerStatus surfaces anomaly count');
  off(); ph.clear();
  delete process.env.LIKU_BLE_DEVICES;
  delete process.env.LIKU_PERIPHERAL_HIL;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

// ── Phase 14: anomaly → escalation + ROS2 bridge foundation ──

test('buildAnomalyNotification produces an advisory, non-actuating notification', () => {
  const { buildAnomalyNotification } = require('../src/main/agents/power-anomaly-consumer');
  const n = buildAnomalyNotification({ anomaly: { type: 'over-budget', valueW: 300, budgetW: 250, advisory: 'over' }, baselineW: 100 });
  assert.strictEqual(n.kind, 'power-anomaly');
  assert.strictEqual(n.source, 'power-anomaly');
  assert.strictEqual(n.device.class, 'C', 'synthetic device is read-only');
  assert.strictEqual(n.autonomousAction, false);
  assert.strictEqual(n.breach.metric, 'power');
  assert.strictEqual(n.breach.level, 'over-budget');
  // Phase 15: over-budget is the highest advisory tier (critical severity → high
  // priority/escalate) but remains strictly advisory (autonomousAction:false).
  assert.strictEqual(n.severity, 'critical', 'over-budget maps to the critical advisory tier');
});

test('power anomaly consumer creates a bounded, human-gated, deduped task', () => {
  const EventEmitter = require('events');
  const { SupervisorAgent } = require('../src/main/agents/supervisor');
  const { attachPowerAnomalyConsumer } = require('../src/main/agents/power-anomaly-consumer');
  const orch = new EventEmitter();
  orch.agents = new Map();
  const sup = new SupervisorAgent({});
  orch.agents.set('supervisor', sup);
  const tasks = [];
  orch.on('supervisor:task', (t) => tasks.push(t));
  let captured = null;
  const fakePal = { on: (type, cb) => { if (type === 'power-anomaly') captured = cb; return () => {}; } };
  let clock = 1_000_000;
  attachPowerAnomalyConsumer(orch, { pal: fakePal, cooldownMs: 60000, now: () => clock });
  assert.strictEqual(typeof captured, 'function', 'consumer subscribed to power-anomaly');

  // First anomaly → a reviewable, human-gated task.
  captured({ anomaly: { type: 'spike', valueW: 200, at: new Date().toISOString(), advisory: 'spike' }, baselineW: 10 });
  assert.strictEqual(tasks.length, 1, 'task created from anomaly');
  assert.strictEqual(tasks[0].source, 'power-anomaly');
  assert.strictEqual(tasks[0].requiresHuman, true);
  assert.strictEqual(tasks[0].autonomousAction, false);
  assert.strictEqual(tasks[0].status, 'pending-review');

  // Flapping within the consumer cooldown → suppressed entirely.
  clock += 1000;
  captured({ anomaly: { type: 'spike', valueW: 210, at: new Date().toISOString() }, baselineW: 10 });
  assert.strictEqual(sup.getPeripheralTasks().length, 1, 'flapping anomaly suppressed by consumer cooldown');

  // After the cooldown window → coalesces into the same open task (count++).
  clock += 61000;
  captured({ anomaly: { type: 'spike', valueW: 220, at: new Date().toISOString() }, baselineW: 10 });
  assert.strictEqual(sup.getPeripheralTasks().length, 1, 'same condition coalesces into one task');
  assert.strictEqual(sup.getPeripheralTasks()[0].count, 2, 'coalesce bumped the counter');
});

test('power anomaly → supervisor task end-to-end via the PAL bus (HIL)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_HIL = '1';
  const ph = require('../src/main/peripherals/power-history');
  ph.clear();
  for (const w of [5, 6, 5, 5, 6, 5]) ph.record({ totalW: w, budgetW: 5000, devices: [] });
  process.env.LIKU_BLE_DEVICES = JSON.stringify([
    { id: 'anom-heater2', name: 'Heater2', class: 'B', kind: 'heater', capabilities: ['on', 'off'], powerW: 400 }
  ]);
  const EventEmitter = require('events');
  const { SupervisorAgent } = require('../src/main/agents/supervisor');
  const { attachPowerAnomalyConsumer } = require('../src/main/agents/power-anomaly-consumer');
  const orch = new EventEmitter();
  orch.agents = new Map();
  orch.agents.set('supervisor', new SupervisorAgent({}));
  const tasks = [];
  orch.on('supervisor:task', (t) => tasks.push(t));
  const { detach } = attachPowerAnomalyConsumer(orch, {});
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const r = pal.execute('anom-heater2', 'on'); // → recordPowerSample → power-anomaly → consumer → task
  assert.strictEqual(r.ok, true, 'HIL actuation succeeded');
  const t = tasks.find((x) => x.source === 'power-anomaly');
  assert.ok(t, 'anomaly produced a supervisor task via the PAL bus');
  assert.strictEqual(t.requiresHuman, true);
  assert.strictEqual(t.autonomousAction, false);
  assert.strictEqual(t.status, 'pending-review');
  detach(); ph.clear();
  delete process.env.LIKU_BLE_DEVICES;
  delete process.env.LIKU_PERIPHERAL_HIL;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

/** Build a synchronous fake rclnodejs for testing the real ROS2 path. */
function makeFakeRos2() {
  const subs = {};
  const pubs = {};
  const node = {
    createPublisher(_type, topic) { const p = { _last: null, publish(m) { this._last = m; } }; pubs[topic] = p; return p; },
    createSubscription(_type, topic, cb) { subs[topic] = cb; return {}; },
    destroy() {}
  };
  const lib = {
    init: () => undefined,               // synchronous → node ready immediately
    Node: function () { return node; },  // constructor returns the shared node
    spin: () => {}
  };
  return { lib, node, pubs, subs, push: (topic, obj) => { if (subs[topic]) subs[topic]({ data: JSON.stringify(obj) }); } };
}

test('ROS2 bridge connects, publishes command envelope, and ingests inbound messages (fake)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;               // REAL path, not HIL
  process.env.LIKU_ROS2_DOMAIN = '0';
  process.env.LIKU_ROS2_DEVICES = JSON.stringify([
    { id: 'ros-arm-01', name: 'Arm', class: 'B', kind: 'actuator', capabilities: ['on', 'off'], powerW: 30, cmdTopic: '/liku/arm/cmd', stateTopic: '/liku/arm/state' }
  ]);
  const ros2 = require('../src/main/peripherals/drivers/ros2-driver');
  const fake = makeFakeRos2();
  ros2._setRos2LibForTest(fake.lib);

  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  assert.ok(pal.listDrivers().drivers.includes('ros2'), 'ros2 available via domain');

  const readings = [];
  const off = pal.on('reading', (r) => { if (r.id === 'ros-arm-01') readings.push(r); });
  const stop = pal.startStreaming();

  // Class B actuation → real publish of the DCP envelope to the command topic.
  const rB = pal.execute('ros-arm-01', 'on');
  assert.strictEqual(rB.ok, true, 'Class B real publish succeeded');
  const pub = fake.pubs['/liku/arm/cmd'];
  assert.ok(pub && pub._last && pub._last.data, 'a message was published to the command topic');
  const env = JSON.parse(pub._last.data);
  assert.strictEqual(env.dcp, '1.0', 'DCP envelope published');
  assert.strictEqual(env.action, 'on');

  // Inbound state message → parsed → ingested → 'reading' event.
  fake.push('/liku/arm/state', { torque: 12, temperature: 35 });
  assert.strictEqual(readings.length, 1, 'inbound ROS2 message ingested as a reading');
  assert.strictEqual(readings[0].metrics.torque, 12);
  assert.strictEqual(pal.get('ros-arm-01').state.temperature, 35, 'reading updated device state');

  stop(); off();
  ros2._setRos2LibForTest(null);
  delete process.env.LIKU_ROS2_DOMAIN;
  delete process.env.LIKU_ROS2_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('ROS2 real path still confirm-gates Class A even when connected', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;
  process.env.LIKU_ROS2_DOMAIN = '0';
  process.env.LIKU_ROS2_DEVICES = JSON.stringify([
    { id: 'ros-gripper-01', name: 'Gripper', class: 'A', kind: 'gripper', capabilities: ['open', 'close'], powerW: 20, cmdTopic: '/liku/grip/cmd', stateTopic: '/liku/grip/state' }
  ]);
  const ros2 = require('../src/main/peripherals/drivers/ros2-driver');
  const fake = makeFakeRos2();
  ros2._setRos2LibForTest(fake.lib);
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const stop = pal.startStreaming();
  const rA = pal.execute('ros-gripper-01', 'open');
  assert.strictEqual(rA.pending, true, 'Class A gated despite being connected');
  assert.ok(!fake.pubs['/liku/grip/cmd'], 'no publish before confirmation');
  pal.authorize('ros-gripper-01', 'open');
  const rA2 = pal.execute('ros-gripper-01', 'open');
  assert.strictEqual(rA2.ok, true, 'confirmed Class A action publishes');
  assert.ok(fake.pubs['/liku/grip/cmd'] && fake.pubs['/liku/grip/cmd']._last, 'publish happened after confirmation');
  stop();
  ros2._setRos2LibForTest(null);
  delete process.env.LIKU_ROS2_DOMAIN;
  delete process.env.LIKU_ROS2_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('ROS2 driver works through the full DCP + class gate + confirm path (HIL)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_HIL = '1';
  delete process.env.LIKU_ROS2_DOMAIN; // no real domain — HIL provides availability
  process.env.LIKU_ROS2_DEVICES = JSON.stringify([
    { id: 'ros-lock-01', name: 'Lock', class: 'A', kind: 'lock', capabilities: ['lock', 'unlock'], powerW: 5 },
    { id: 'ros-led-01', name: 'LED', class: 'B', kind: 'light', capabilities: ['on', 'off'], powerW: 3 }
  ]);
  const ros2 = require('../src/main/peripherals/drivers/ros2-driver');
  assert.strictEqual(ros2.isAvailable(), true, 'available in HIL (no domain)');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  assert.ok(pal.listDrivers().drivers.includes('ros2'), 'ros2 driver listed');
  const rB = pal.execute('ros-led-01', 'on');
  assert.strictEqual(rB.ok, true);
  assert.strictEqual(rB.result.simulated, true, 'HIL executed the Class B action');
  const rA = pal.execute('ros-lock-01', 'unlock');
  assert.strictEqual(rA.pending, true, 'Class A still gated in HIL');
  pal.authorize('ros-lock-01', 'unlock');
  const rA2 = pal.execute('ros-lock-01', 'unlock');
  assert.strictEqual(rA2.ok, true);
  assert.strictEqual(rA2.result.state.locked, false, 'simulator applied the unlock');
  delete process.env.LIKU_PERIPHERAL_HIL;
  delete process.env.LIKU_ROS2_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('ROS2 driver is unavailable without HIL and without a domain (isolated)', () => {
  delete process.env.LIKU_PERIPHERAL_HIL;
  delete process.env.LIKU_ROS2_DOMAIN;
  process.env.LIKU_ROS2_DEVICES = JSON.stringify([{ id: 'ros-x', class: 'B', capabilities: ['on'] }]);
  const ros2 = require('../src/main/peripherals/drivers/ros2-driver');
  assert.strictEqual(ros2.isAvailable(), false, 'no HIL + no domain → unavailable');
  delete process.env.LIKU_ROS2_DEVICES;
});

// ── Phase 15: Matter/Thread foundation + anomaly severity tiers ──

/** Build a synchronous fake matter.js for testing the real Matter path. */
function makeFakeMatter(nodes) {
  const EventEmitter = require('events');
  const endpoints = {};
  const nodeObjs = {};
  for (const n of nodes) {
    const ep = { _last: null, invoke(cluster, command, payload) { this._last = { cluster, command, payload }; return Promise.resolve(); } };
    endpoints[String(n.nodeId)] = ep;
    nodeObjs[String(n.nodeId)] = { getEndpoint: () => ep };
  }
  const created = [];
  class CommissioningController extends EventEmitter {
    constructor() { super(); created.push(this); }
    start() { return undefined; }   // synchronous → started immediately
    getNode(id) { return nodeObjs[String(id)] || null; }
    stop() {}
  }
  return {
    lib: { CommissioningController },
    endpoints,
    push: (nodeId, data) => { for (const c of created) c.emit('attributeReport', { nodeId, data }); }
  };
}

test('Matter bridge connects, invokes a cluster command, and ingests attribute reports (fake)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;             // REAL path, not HIL
  process.env.LIKU_MATTER_FABRIC = 'fabric-1';
  process.env.LIKU_MATTER_DEVICES = JSON.stringify([
    { id: 'mt-plug-01', name: 'Plug', class: 'B', kind: 'switch', capabilities: ['on', 'off'], powerW: 15, nodeId: '1001', endpoint: 1 }
  ]);
  const matter = require('../src/main/peripherals/drivers/matter-driver');
  const fake = makeFakeMatter([{ nodeId: '1001' }]);
  matter._setMatterLibForTest(fake.lib);

  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  assert.ok(pal.listDrivers().drivers.includes('matter'), 'matter available via fabric');

  const readings = [];
  const off = pal.on('reading', (r) => { if (r.id === 'mt-plug-01') readings.push(r); });
  const stop = pal.startStreaming();

  // Class B actuation → real Matter cluster command invoked.
  const rB = pal.execute('mt-plug-01', 'on');
  assert.strictEqual(rB.ok, true, 'Class B real invoke succeeded');
  assert.strictEqual(fake.endpoints['1001']._last.cluster, 'OnOff', 'Matter cluster invoked');
  assert.strictEqual(fake.endpoints['1001']._last.command, 'on', 'Matter command invoked');

  // Inbound attribute report → parsed → ingested → 'reading' event.
  fake.push('1001', { temperature: 21, humidity: 47 });
  assert.strictEqual(readings.length, 1, 'inbound attribute report ingested as a reading');
  assert.strictEqual(readings[0].metrics.temperature, 21);
  assert.strictEqual(pal.get('mt-plug-01').state.temperature, 21, 'reading updated device state');

  stop(); off();
  matter._setMatterLibForTest(null);
  delete process.env.LIKU_MATTER_FABRIC;
  delete process.env.LIKU_MATTER_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Matter real path still confirm-gates Class A even when connected', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;
  process.env.LIKU_MATTER_FABRIC = 'fabric-1';
  process.env.LIKU_MATTER_DEVICES = JSON.stringify([
    { id: 'mt-lock-01', name: 'Lock', class: 'A', kind: 'lock', capabilities: ['lock', 'unlock'], powerW: 4, nodeId: '2002', endpoint: 1 }
  ]);
  const matter = require('../src/main/peripherals/drivers/matter-driver');
  const fake = makeFakeMatter([{ nodeId: '2002' }]);
  matter._setMatterLibForTest(fake.lib);
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const stop = pal.startStreaming();
  const rA = pal.execute('mt-lock-01', 'unlock');
  assert.strictEqual(rA.pending, true, 'Class A gated despite being connected');
  assert.ok(!fake.endpoints['2002']._last, 'no command invoked before confirmation');
  pal.authorize('mt-lock-01', 'unlock');
  const rA2 = pal.execute('mt-lock-01', 'unlock');
  assert.strictEqual(rA2.ok, true, 'confirmed Class A action invokes');
  assert.strictEqual(fake.endpoints['2002']._last.command, 'unlockDoor', 'Matter unlock invoked after confirm');
  stop();
  matter._setMatterLibForTest(null);
  delete process.env.LIKU_MATTER_FABRIC;
  delete process.env.LIKU_MATTER_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Matter driver works through the full DCP + class gate + confirm path (HIL)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_HIL = '1';
  delete process.env.LIKU_MATTER_FABRIC; // no real fabric — HIL provides availability
  process.env.LIKU_MATTER_DEVICES = JSON.stringify([
    { id: 'mt-lock-hil', name: 'Lock', class: 'A', kind: 'lock', capabilities: ['lock', 'unlock'], powerW: 5 },
    { id: 'mt-led-hil', name: 'LED', class: 'B', kind: 'light', capabilities: ['on', 'off'], powerW: 4 }
  ]);
  const matter = require('../src/main/peripherals/drivers/matter-driver');
  assert.strictEqual(matter.isAvailable(), true, 'available in HIL (no fabric)');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  assert.ok(pal.listDrivers().drivers.includes('matter'), 'matter driver listed');
  const rB = pal.execute('mt-led-hil', 'on');
  assert.strictEqual(rB.ok, true);
  assert.strictEqual(rB.result.simulated, true, 'HIL executed the Class B action');
  const rA = pal.execute('mt-lock-hil', 'unlock');
  assert.strictEqual(rA.pending, true, 'Class A still gated in HIL');
  pal.authorize('mt-lock-hil', 'unlock');
  const rA2 = pal.execute('mt-lock-hil', 'unlock');
  assert.strictEqual(rA2.ok, true);
  assert.strictEqual(rA2.result.state.locked, false, 'simulator applied the unlock');
  delete process.env.LIKU_PERIPHERAL_HIL;
  delete process.env.LIKU_MATTER_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Matter driver is unavailable without HIL and without a fabric (isolated)', () => {
  delete process.env.LIKU_PERIPHERAL_HIL;
  delete process.env.LIKU_MATTER_FABRIC;
  process.env.LIKU_MATTER_DEVICES = JSON.stringify([{ id: 'mt-x', class: 'B', capabilities: ['on'] }]);
  const matter = require('../src/main/peripherals/drivers/matter-driver');
  assert.strictEqual(matter.isAvailable(), false, 'no HIL + no fabric → unavailable');
  delete process.env.LIKU_MATTER_DEVICES;
});

test('anomaly severity tiers map type → severity + cooldown', () => {
  const { buildAnomalyNotification, ANOMALY_TIERS } = require('../src/main/agents/power-anomaly-consumer');
  assert.strictEqual(buildAnomalyNotification({ anomaly: { type: 'over-budget', valueW: 300, budgetW: 250 } }).severity, 'critical');
  assert.strictEqual(buildAnomalyNotification({ anomaly: { type: 'spike', valueW: 200 } }).severity, 'warning');
  assert.strictEqual(buildAnomalyNotification({ anomaly: { type: 'sustained', valueW: 150 } }).severity, 'warning');
  assert.strictEqual(buildAnomalyNotification({ anomaly: { type: 'mystery', valueW: 1 } }).severity, 'info');
  // over-budget surfaces faster (shorter cooldown) than a routine spike.
  assert.ok(ANOMALY_TIERS['over-budget'].cooldownMs < ANOMALY_TIERS['spike'].cooldownMs, 'over-budget has the shortest window');
  assert.ok(ANOMALY_TIERS['sustained'].cooldownMs >= ANOMALY_TIERS['spike'].cooldownMs, 'sustained dedups longer');
});

test('anomaly tiers drive differentiated task priority + escalation (advisory)', () => {
  const EventEmitter = require('events');
  const { SupervisorAgent } = require('../src/main/agents/supervisor');
  const { attachPowerAnomalyConsumer } = require('../src/main/agents/power-anomaly-consumer');
  const orch = new EventEmitter();
  orch.agents = new Map();
  // Auto-ack info+warning to PROVE over-budget (critical) is never auto-acked.
  const sup = new SupervisorAgent({ autoAckSeverities: 'info,warning' });
  orch.agents.set('supervisor', sup);
  let captured = null;
  const fakePal = { on: (type, cb) => { if (type === 'power-anomaly') captured = cb; return () => {}; } };
  attachPowerAnomalyConsumer(orch, { pal: fakePal, now: () => 1_000_000 });

  // over-budget → critical → high priority + escalate + NEVER auto-acknowledged.
  captured({ anomaly: { type: 'over-budget', valueW: 300, budgetW: 250, at: new Date().toISOString(), advisory: 'ob' }, baselineW: 100 });
  const ob = sup.getPeripheralTasks().find((t) => t.breach.level === 'over-budget');
  assert.ok(ob, 'over-budget task created');
  assert.strictEqual(ob.priority, 'high', 'over-budget → high priority');
  assert.strictEqual(ob.escalation, 'escalate', 'over-budget → escalate routing');
  assert.strictEqual(ob.status, 'pending-review', 'over-budget never auto-acknowledged');
  assert.strictEqual(ob.autonomousAction, false, 'still advisory');

  // spike → warning → medium priority + notify routing (different tier).
  captured({ anomaly: { type: 'spike', valueW: 500, at: new Date().toISOString(), advisory: 'sp' }, baselineW: 100 });
  const sp = sup.getPeripheralTasks().find((t) => t.breach.level === 'spike');
  assert.ok(sp, 'spike task created');
  assert.strictEqual(sp.priority, 'medium', 'spike → medium priority');
  assert.strictEqual(sp.escalation, 'notify', 'spike → notify routing');
  assert.strictEqual(sp.autonomousAction, false, 'still advisory');
});

test('anomaly tier cooldowns differ by type (over-budget surfaces faster than spike)', () => {
  const EventEmitter = require('events');
  const { SupervisorAgent } = require('../src/main/agents/supervisor');
  const { attachPowerAnomalyConsumer } = require('../src/main/agents/power-anomaly-consumer');
  const orch = new EventEmitter();
  orch.agents = new Map();
  orch.agents.set('supervisor', new SupervisorAgent({}));
  const tasks = [];
  orch.on('supervisor:task', (t) => tasks.push(t));
  let captured = null;
  const fakePal = { on: (type, cb) => { if (type === 'power-anomaly') captured = cb; return () => {}; } };
  let clock = 1_000_000;
  attachPowerAnomalyConsumer(orch, { pal: fakePal, now: () => clock });

  // over-budget cooldown = 15s: at +20s the second over-budget is allowed again.
  captured({ anomaly: { type: 'over-budget', valueW: 300, budgetW: 250, at: new Date().toISOString() }, baselineW: 100 });
  clock += 20000;
  captured({ anomaly: { type: 'over-budget', valueW: 310, budgetW: 250, at: new Date().toISOString() }, baselineW: 100 });
  const obTask = tasks.filter((t) => t.breach.level === 'over-budget');
  assert.ok(obTask.length >= 1 && obTask[0].count >= 2, 'over-budget re-fired after its short cooldown (coalesced)');

  // spike cooldown = 60s: at +20s from first the second spike is STILL suppressed.
  clock = 2_000_000;
  captured({ anomaly: { type: 'spike', valueW: 500, at: new Date().toISOString() }, baselineW: 100 });
  clock += 20000;
  captured({ anomaly: { type: 'spike', valueW: 520, at: new Date().toISOString() }, baselineW: 100 });
  const spTask = tasks.filter((t) => t.breach.level === 'spike');
  assert.strictEqual(spTask.length, 1, 'spike suppressed within its longer cooldown (single emit)');
});

// ── Phase 16: commissioning/pairing state machine + tier task metadata ──

test('pairing state machine: retry with backoff then FAILED after max attempts', () => {
  const { createPairingState, PAIR_STATES } = require('../src/main/peripherals/pairing');
  let clock = 1000;
  const p = createPairingState({ maxAttempts: 2, baseBackoffMs: 100, now: () => clock });
  assert.strictEqual(p.state('d1'), PAIR_STATES.UNPAIRED);
  assert.ok(p.canAttempt('d1'), 'initially attemptable');
  p.begin('d1');                 // attempt 1
  assert.strictEqual(p.state('d1'), PAIR_STATES.PAIRING);
  p.fail('d1', 'boom');          // attempts 1 < 2 → retryable after backoff
  assert.strictEqual(p.state('d1'), PAIR_STATES.UNPAIRED);
  assert.ok(!p.canAttempt('d1'), 'within backoff → cannot attempt');
  clock += 100;                  // backoff elapses
  assert.ok(p.canAttempt('d1'), 'after backoff → can attempt');
  p.begin('d1');                 // attempt 2
  p.fail('d1', 'boom2');         // attempts 2 >= 2 → FAILED
  assert.strictEqual(p.state('d1'), PAIR_STATES.FAILED);
  assert.ok(!p.canAttempt('d1'), 'FAILED → no more attempts');
  p.requeue('d1');               // manual re-pair resets
  assert.ok(p.canAttempt('d1'), 'requeue re-enables attempts');
});

test('pairing state machine: success reports paired + clears backoff', () => {
  const { createPairingState } = require('../src/main/peripherals/pairing');
  const p = createPairingState({ maxAttempts: 3 });
  p.begin('d2'); p.succeed('d2');
  assert.strictEqual(p.isPaired('d2'), true);
  assert.ok(p.get('d2').pairedAt, 'records pairedAt');
  assert.strictEqual(p.get('d2').lastError, null);
});

test('Matter commissioning pairs a device via the state machine (fake)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;
  process.env.LIKU_MATTER_FABRIC = 'fab-p';
  process.env.LIKU_MATTER_DEVICES = JSON.stringify([
    { id: 'mt-pair-01', class: 'B', kind: 'switch', capabilities: ['on', 'off'], nodeId: '55', endpoint: 1 }
  ]);
  const matter = require('../src/main/peripherals/drivers/matter-driver');
  const fake = makeFakeMatter([{ nodeId: '55' }]);
  matter._setMatterLibForTest(fake.lib);
  const rec = matter.pair('mt-pair-01');
  assert.strictEqual(rec.state, 'paired', 'commissioning succeeds when the node resolves');
  assert.strictEqual(matter.pairingStatus()['mt-pair-01'].state, 'paired');
  matter._setMatterLibForTest(null);
  delete process.env.LIKU_MATTER_FABRIC;
  delete process.env.LIKU_MATTER_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Matter commissioning retries then FAILS when the node never resolves', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;
  process.env.LIKU_MATTER_FABRIC = 'fab-f';
  process.env.LIKU_MATTER_PAIR_MAX_ATTEMPTS = '2';
  process.env.LIKU_MATTER_PAIR_BACKOFF_MS = '0';
  process.env.LIKU_MATTER_DEVICES = JSON.stringify([
    { id: 'mt-fail-01', class: 'B', kind: 'switch', capabilities: ['on', 'off'], nodeId: '999', endpoint: 1 }
  ]);
  const matter = require('../src/main/peripherals/drivers/matter-driver');
  const fake = makeFakeMatter([]); // no nodes → getNode() returns null
  matter._setMatterLibForTest(fake.lib);
  const r1 = matter.pair('mt-fail-01'); // attempt 1 → fail → retryable (backoff 0)
  assert.strictEqual(r1.state, 'unpaired');
  assert.ok(r1.lastError, 'records the failure reason');
  const r2 = matter.pair('mt-fail-01'); // attempt 2 → attempts exhausted → FAILED
  assert.strictEqual(r2.state, 'failed', 'transitions to FAILED after max attempts');
  matter._setMatterLibForTest(null);
  delete process.env.LIKU_MATTER_PAIR_MAX_ATTEMPTS;
  delete process.env.LIKU_MATTER_PAIR_BACKOFF_MS;
  delete process.env.LIKU_MATTER_FABRIC;
  delete process.env.LIKU_MATTER_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('BLE pairing pairs a device via the connect state machine (fake)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;
  process.env.LIKU_BLE_ADAPTER = 'hci0-fake';
  process.env.LIKU_BLE_DEVICES = JSON.stringify([
    { id: 'ble-pair-01', class: 'B', kind: 'switch', capabilities: ['on', 'off'], peripheralId: 'pp1', writeCharUuid: 'ff01', notifyCharUuid: 'ff02' }
  ]);
  const ble = require('../src/main/peripherals/drivers/ble-driver');
  const fake = makeFakeNoble([{ peripheralId: 'pp1', writeUuid: 'ff01', notifyUuid: 'ff02' }]);
  ble._setBleLibForTest(fake.lib);
  const rec = ble.pair('ble-pair-01');
  assert.strictEqual(rec.state, 'paired', 'BLE connect completes pairing');
  assert.strictEqual(ble.pairingStatus()['ble-pair-01'].state, 'paired');
  ble._setBleLibForTest(null);
  delete process.env.LIKU_BLE_ADAPTER;
  delete process.env.LIKU_BLE_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('pairing is virtual (no real transport) in HIL mode', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_HIL = '1';
  process.env.LIKU_MATTER_DEVICES = JSON.stringify([
    { id: 'mt-hil-p', class: 'B', kind: 'switch', capabilities: ['on', 'off'] }
  ]);
  const matter = require('../src/main/peripherals/drivers/matter-driver');
  const rec = matter.pair('mt-hil-p');
  assert.strictEqual(rec.state, 'paired');
  assert.strictEqual(rec.simulated, true, 'HIL pairing is virtual');
  assert.strictEqual(matter.pairingStatus()['mt-hil-p'].simulated, true);
  delete process.env.LIKU_PERIPHERAL_HIL;
  delete process.env.LIKU_MATTER_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('PAL exposes pairing status + triggers pairing via the driver (HIL)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_HIL = '1';
  process.env.LIKU_MATTER_DEVICES = JSON.stringify([
    { id: 'mt-pal-p', class: 'B', kind: 'switch', capabilities: ['on', 'off'], powerW: 5 }
  ]);
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const r = pal.pairDevice('mt-pal-p');
  assert.strictEqual(r.ok, true, 'pairDevice succeeds in HIL');
  assert.strictEqual(r.simulated, true);
  const st = pal.getPairingStatus();
  assert.ok(st.devices['mt-pal-p'], 'pairing status surfaced');
  assert.strictEqual(st.devices['mt-pal-p'].state, 'paired');
  assert.strictEqual(st.devices['mt-pal-p'].driver, 'matter');
  delete process.env.LIKU_PERIPHERAL_HIL;
  delete process.env.LIKU_MATTER_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('anomaly tasks carry anomalyType + severityTier for differentiated visibility', () => {
  const EventEmitter = require('events');
  const { SupervisorAgent } = require('../src/main/agents/supervisor');
  const { attachPowerAnomalyConsumer } = require('../src/main/agents/power-anomaly-consumer');
  const orch = new EventEmitter();
  orch.agents = new Map();
  orch.agents.set('supervisor', new SupervisorAgent({}));
  let captured = null;
  const fakePal = { on: (type, cb) => { if (type === 'power-anomaly') captured = cb; return () => {}; } };
  attachPowerAnomalyConsumer(orch, { pal: fakePal, now: () => 5_000_000 });

  captured({ anomaly: { type: 'over-budget', valueW: 300, budgetW: 250, at: new Date().toISOString() }, baselineW: 100 });
  const ob = orch.agents.get('supervisor').getPeripheralTasks().find((t) => t.breach.level === 'over-budget');
  assert.strictEqual(ob.anomalyType, 'over-budget', 'task carries the anomaly type');
  assert.strictEqual(ob.severityTier, 'critical', 'task carries the critical tier');
  assert.strictEqual(ob.priority, 'high');
  assert.strictEqual(ob.escalation, 'escalate');
  assert.strictEqual(ob.autonomousAction, false, 'still strictly advisory');
});

// ── Phase 17: pairing parity (Zigbee + ROS2) + complete tier differentiation ──

test('Zigbee pairing (mesh join) parity: pair success + unpair + status (fake)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;
  process.env.LIKU_ZIGBEE_COORDINATOR = '/dev/fake-zb';
  process.env.LIKU_ZIGBEE_DEVICES = JSON.stringify([
    { id: 'zb-pair-01', class: 'B', kind: 'switch', capabilities: ['on', 'off'], ieeeAddr: '0xAA01', endpoint: 1 }
  ]);
  const zb = require('../src/main/peripherals/drivers/zigbee-driver');
  const fake = makeFakeHerdsman([{ ieeeAddr: '0xAA01' }]);
  zb._setZigbeeLibForTest(fake.lib);
  const rec = zb.pair('zb-pair-01');
  assert.strictEqual(rec.state, 'paired', 'zigbee mesh join succeeds when the device resolves');
  assert.strictEqual(zb.pairingStatus()['zb-pair-01'].state, 'paired');
  const un = zb.unpair('zb-pair-01');
  assert.strictEqual(un.state, 'unpaired', 'unpair requeues the device');
  assert.ok(zb.pairingStatus()['zb-pair-01'].state !== 'paired', 'no longer paired after unpair');
  zb._setZigbeeLibForTest(null);
  delete process.env.LIKU_ZIGBEE_COORDINATOR;
  delete process.env.LIKU_ZIGBEE_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Zigbee pairing retries then FAILS when the device never resolves', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;
  process.env.LIKU_ZIGBEE_COORDINATOR = '/dev/fake-zb';
  process.env.LIKU_ZIGBEE_PAIR_MAX_ATTEMPTS = '2';
  process.env.LIKU_ZIGBEE_PAIR_BACKOFF_MS = '0';
  process.env.LIKU_ZIGBEE_DEVICES = JSON.stringify([
    { id: 'zb-fail-01', class: 'B', kind: 'switch', capabilities: ['on', 'off'], ieeeAddr: '0xZZZZ', endpoint: 1 }
  ]);
  const zb = require('../src/main/peripherals/drivers/zigbee-driver');
  const fake = makeFakeHerdsman([]); // getDeviceByIeeeAddr → undefined
  zb._setZigbeeLibForTest(fake.lib);
  assert.strictEqual(zb.pair('zb-fail-01').state, 'unpaired', 'attempt 1 retryable');
  assert.strictEqual(zb.pair('zb-fail-01').state, 'failed', 'FAILED after max attempts');
  zb._setZigbeeLibForTest(null);
  delete process.env.LIKU_ZIGBEE_PAIR_MAX_ATTEMPTS;
  delete process.env.LIKU_ZIGBEE_PAIR_BACKOFF_MS;
  delete process.env.LIKU_ZIGBEE_COORDINATOR;
  delete process.env.LIKU_ZIGBEE_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('ROS2 pairing parity: pair success (node+publisher) + unpair + status (fake)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;
  process.env.LIKU_ROS2_DOMAIN = '0';
  process.env.LIKU_ROS2_DEVICES = JSON.stringify([
    { id: 'ros-pair-01', class: 'B', kind: 'actuator', capabilities: ['on', 'off'], cmdTopic: '/liku/p/cmd', stateTopic: '/liku/p/state' }
  ]);
  const ros2 = require('../src/main/peripherals/drivers/ros2-driver');
  const fake = makeFakeRos2();
  ros2._setRos2LibForTest(fake.lib);
  const rec = ros2.pair('ros-pair-01');
  assert.strictEqual(rec.state, 'paired', 'ros2 pairing succeeds when node + publisher exist');
  assert.strictEqual(ros2.pairingStatus()['ros-pair-01'].state, 'paired');
  const un = ros2.unpair('ros-pair-01');
  assert.strictEqual(un.state, 'unpaired', 'unpair requeues the device');
  ros2._setRos2LibForTest(null);
  delete process.env.LIKU_ROS2_DOMAIN;
  delete process.env.LIKU_ROS2_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('all real drivers expose a consistent pair/unpair/pairingStatus surface', () => {
  const drivers = ['ble', 'zigbee', 'ros2', 'matter'].map((d) => require(`../src/main/peripherals/drivers/${d}-driver`));
  for (const drv of drivers) {
    assert.strictEqual(typeof drv.pair, 'function', `${drv.DRIVER_ID} has pair()`);
    assert.strictEqual(typeof drv.unpair, 'function', `${drv.DRIVER_ID} has unpair()`);
    assert.strictEqual(typeof drv.pairingStatus, 'function', `${drv.DRIVER_ID} has pairingStatus()`);
  }
});

test('PAL pairing surface is uniform across drivers incl. connectionless (HIL)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_HIL = '1';
  process.env.LIKU_ZIGBEE_DEVICES = JSON.stringify([{ id: 'zb-pal-1', class: 'B', kind: 'switch', capabilities: ['on', 'off'], powerW: 5 }]);
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  // Real driver (zigbee) reports virtual paired in HIL.
  const pr = pal.pairDevice('zb-pal-1');
  assert.strictEqual(pr.ok, true);
  assert.strictEqual(pr.simulated, true, 'HIL pairing is virtual');
  const st = pal.getPairingStatus();
  assert.strictEqual(st.devices['zb-pal-1'].state, 'paired');
  assert.strictEqual(st.devices['zb-pal-1'].driver, 'zigbee');
  // Connectionless driver (mock) devices surface as 'ready'.
  const mockReady = Object.values(st.devices).find((d) => d.driver === 'mock');
  assert.ok(mockReady && mockReady.state === 'ready', 'connectionless mock devices reported as ready');
  // Unpair via the PAL.
  const un = pal.unpairDevice('zb-pal-1');
  assert.strictEqual(un.ok, true);
  delete process.env.LIKU_PERIPHERAL_HIL;
  delete process.env.LIKU_ZIGBEE_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('anomaly tiers drive differentiated escalation CHANNEL routing (advisory)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_CHANNELS = 'file'; // file channel, default min-severity 'info'
  process.env.LIKU_PERIPHERAL_WEBHOOK_MIN_SEVERITY = 'warning';
  const channels = require('../src/main/agents/notification-channels');
  const { buildAnomalyNotification } = require('../src/main/agents/power-anomaly-consumer');
  // over-budget (critical) reaches a warning-threshold channel; low-tier 'info' does not.
  process.env.LIKU_PERIPHERAL_CHANNELS = 'webhook';
  process.env.LIKU_PERIPHERAL_WEBHOOK_URL = ''; // unconfigured → delivery is a no-op but routing decision still testable
  const crit = buildAnomalyNotification({ anomaly: { type: 'over-budget', valueW: 300, budgetW: 250 }, baselineW: 100 });
  const info = buildAnomalyNotification({ anomaly: { type: 'mystery', valueW: 5 }, baselineW: 4 });
  assert.strictEqual(crit.severity, 'critical', 'over-budget is critical tier');
  assert.strictEqual(info.severity, 'info', 'unknown type is info tier');
  // The channel routing decision is severity-driven: critical >= warning threshold, info < warning.
  const rankOf = (n) => channels.SEVERITY_RANK[n.severity];
  assert.ok(rankOf(crit) >= channels.SEVERITY_RANK.warning, 'critical routes to warning-threshold channels');
  assert.ok(rankOf(info) < channels.SEVERITY_RANK.warning, 'info stays below the warning threshold');
  delete process.env.LIKU_PERIPHERAL_WEBHOOK_URL;
  delete process.env.LIKU_PERIPHERAL_WEBHOOK_MIN_SEVERITY;
  delete process.env.LIKU_PERIPHERAL_CHANNELS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Supervisor exposes notifications by severity for inbox prioritisation', () => {
  const { SupervisorAgent } = require('../src/main/agents/supervisor');
  const sup = new SupervisorAgent({});
  sup.receiveNotification({ id: 'c1', severity: 'critical', device: { id: 'p', class: 'C' } });
  sup.receiveNotification({ id: 'w1', severity: 'warning', device: { id: 'p', class: 'C' } });
  sup.receiveNotification({ id: 'w2', severity: 'warning', device: { id: 'p', class: 'C' } });
  assert.strictEqual(sup.getNotificationsBySeverity('critical').length, 1);
  assert.strictEqual(sup.getNotificationsBySeverity('warning').length, 2);
  assert.strictEqual(sup.getNotificationsBySeverity('info').length, 0);
});

// ── Phase 18: token lifecycle + advisory auto-schedule suggestions ──

test('DCP token generation + identity binding reject stale / wrong-identity tokens', () => {
  const dcp = require('../src/main/peripherals/dcp-protocol');
  const tok = dcp.issueCapabilityToken({ deviceId: 'd1', actions: ['on'], gen: 2, identity: 'abc123' });
  // Correct gen + identity → ok.
  assert.strictEqual(dcp.verifyCapabilityToken(tok, { deviceId: 'd1', action: 'on', gen: 2, identity: 'abc123' }).ok, true);
  // Stale generation (device rotated) → rejected.
  assert.strictEqual(dcp.verifyCapabilityToken(tok, { deviceId: 'd1', action: 'on', gen: 3 }).reason, 'generation-mismatch');
  // Wrong identity → rejected.
  assert.strictEqual(dcp.verifyCapabilityToken(tok, { deviceId: 'd1', action: 'on', identity: 'zzz' }).reason, 'identity-mismatch');
  // Backward compat: a token without gen/identity still verifies when none requested.
  const plain = dcp.issueCapabilityToken({ deviceId: 'd1', actions: ['on'] });
  assert.strictEqual(dcp.verifyCapabilityToken(plain, { deviceId: 'd1', action: 'on' }).ok, true);
});

test('token store: issue on pair, rotate on re-pair, revoke on unpair (flag-gated)', () => {
  const ts = require('../src/main/peripherals/token-store');
  // Clear any file left by earlier pairing tests, then prove disabled = no write.
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  ts.clear();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
  assert.strictEqual(ts.onPair('t-dev'), null, 'no-op when disabled');
  assert.ok(!fs.existsSync(ts.STORE_FILE), 'no disk when disabled');

  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  ts.clear();
  const p1 = ts.onPair('t-dev', { actions: ['on', 'off'] });
  assert.strictEqual(p1.gen, 1, 'first pair issues generation 1');
  assert.strictEqual(p1.revoked, false);
  assert.ok(p1.identityFp, 'per-device identity fingerprint bound');
  // Idempotent while active — pairing again keeps the same generation.
  assert.strictEqual(ts.onPair('t-dev').gen, 1, 'idempotent while active');
  // Revoke on unpair bumps generation + marks revoked.
  const r = ts.revoke('t-dev');
  assert.strictEqual(r.revoked, true);
  assert.ok(ts.isRevoked('t-dev'));
  assert.ok(!ts.isActive('t-dev'));
  // Re-pair after revoke rotates to a fresh generation.
  const p2 = ts.onPair('t-dev', { actions: ['on'] });
  assert.ok(p2.gen > p1.gen, 're-pair rotates the generation');
  assert.strictEqual(p2.revoked, false);
  ts.clear();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('token lifecycle is bound to pairing: pair issues, unpair revokes (BLE fake)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;
  process.env.LIKU_BLE_ADAPTER = 'hci0-fake';
  process.env.LIKU_BLE_DEVICES = JSON.stringify([
    { id: 'ble-tok-01', class: 'B', kind: 'switch', capabilities: ['on', 'off'], peripheralId: 'ptok', writeCharUuid: 'ff01', notifyCharUuid: 'ff02' }
  ]);
  const ts = require('../src/main/peripherals/token-store');
  ts.clear();
  const ble = require('../src/main/peripherals/drivers/ble-driver');
  const fake = makeFakeNoble([{ peripheralId: 'ptok', writeUuid: 'ff01', notifyUuid: 'ff02' }]);
  ble._setBleLibForTest(fake.lib);
  const pr = ble.pair('ble-tok-01');
  assert.strictEqual(pr.state, 'paired');
  assert.ok(ts.isActive('ble-tok-01'), 'token issued on pair');
  const un = ble.unpair('ble-tok-01');
  assert.ok(ts.isRevoked('ble-tok-01'), 'token revoked on unpair');
  ble._setBleLibForTest(null);
  ts.clear();
  delete process.env.LIKU_BLE_ADAPTER;
  delete process.env.LIKU_BLE_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('PAL blocks a REMOTE command when the device token is revoked (re-pair to restore)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;
  process.env.LIKU_ZIGBEE_COORDINATOR = '/dev/fake-zb';
  process.env.LIKU_ZIGBEE_DEVICES = JSON.stringify([
    { id: 'zb-rev-01', class: 'B', kind: 'switch', capabilities: ['on', 'off'], ieeeAddr: '0xREV1', endpoint: 1, powerW: 5 }
  ]);
  const ts = require('../src/main/peripherals/token-store');
  ts.clear();
  const zb = require('../src/main/peripherals/drivers/zigbee-driver');
  const fake = makeFakeHerdsman([{ ieeeAddr: '0xREV1' }]);
  zb._setZigbeeLibForTest(fake.lib);
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  // Paired → command allowed.
  zb.pair('zb-rev-01');
  const ok = pal.execute('zb-rev-01', 'on');
  assert.strictEqual(ok.ok, true, 'command allowed while token active');
  // Revoke (unpair) → REMOTE command refused.
  pal.revokeToken('zb-rev-01');
  const blocked = pal.execute('zb-rev-01', 'on');
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.code, 'token-revoked', 'remote driver refuses on revoked token');
  // Re-pair rotates a fresh token → command allowed again.
  zb.pair('zb-rev-01');
  assert.strictEqual(pal.execute('zb-rev-01', 'on').ok, true, 're-pair restores the command path');
  zb._setZigbeeLibForTest(null);
  ts.clear();
  delete process.env.LIKU_ZIGBEE_COORDINATOR;
  delete process.env.LIKU_ZIGBEE_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('token lifecycle stays virtual + isolated in HIL (no revocation blocking)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_HIL = '1';
  process.env.LIKU_ZIGBEE_DEVICES = JSON.stringify([
    { id: 'zb-hil-tok', class: 'B', kind: 'switch', capabilities: ['on', 'off'], powerW: 5 }
  ]);
  const ts = require('../src/main/peripherals/token-store');
  ts.clear();
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  pal.pairDevice('zb-hil-tok');   // HIL → virtual, no token store write
  pal.unpairDevice('zb-hil-tok'); // HIL → virtual, no revocation
  assert.strictEqual(ts.isRevoked('zb-hil-tok'), false, 'HIL never revokes');
  assert.strictEqual(pal.execute('zb-hil-tok', 'on').ok, true, 'HIL command always allowed');
  delete process.env.LIKU_PERIPHERAL_HIL;
  delete process.env.LIKU_ZIGBEE_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('schedule advisor: recurring anomaly → deduped proposal → confirm activates it', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_ADVISOR_MIN_OCCURRENCES = '3';
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  const schedule = require('../src/main/peripherals/power-schedule');
  advisor.clear();
  // Below threshold → no proposal.
  advisor.recordAnomaly({ device: 'heater-1', type: 'over-budget', valueW: 400, budgetW: 300 });
  advisor.recordAnomaly({ device: 'heater-1', type: 'over-budget', valueW: 410, budgetW: 300 });
  assert.strictEqual(advisor.proposeSchedules().length, 0, 'no proposal below threshold');
  // Third occurrence crosses the threshold → one proposal.
  advisor.recordAnomaly({ device: 'heater-1', type: 'over-budget', valueW: 420, budgetW: 300 });
  const proposals = advisor.proposeSchedules();
  assert.strictEqual(proposals.length, 1, 'recurring anomaly proposes a schedule');
  const sug = proposals[0];
  assert.strictEqual(sug.status, 'proposed');
  assert.strictEqual(sug.autonomousAction, false, 'proposal is strictly advisory');
  assert.strictEqual(sug.deviceId, 'heater-1');
  // Dedup: proposing again does not create a second proposal.
  assert.strictEqual(advisor.proposeSchedules().length, 1, 'deduped — same recurring anomaly = one proposal');
  // NOT active until confirmed.
  assert.strictEqual(schedule.deviceScheduleW('heater-1', new Date(2026, 6, 16, sug.fromHour, 0, 0)), null, 'proposal not enforced pre-confirmation');
  // Explicit human confirmation activates it.
  const c = advisor.confirm(sug.id);
  assert.strictEqual(c.ok, true);
  const cap = schedule.deviceScheduleW('heater-1', new Date(2026, 6, 16, sug.fromHour, 0, 0));
  assert.strictEqual(cap, sug.maxW, 'confirmed schedule is now enforced by power-schedule');
  advisor.clear();
  // Clean up the confirmed schedule store.
  try { fs.rmSync(require('../src/main/peripherals/power-schedule').CONFIRMED_FILE); } catch { /* ignore */ }
  delete process.env.LIKU_PERIPHERAL_ADVISOR_MIN_OCCURRENCES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('anomaly consumer surfaces a proposed schedule after recurring anomalies (advisory)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_ADVISOR_MIN_OCCURRENCES = '2';
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  advisor.clear();
  const EventEmitter = require('events');
  const { SupervisorAgent } = require('../src/main/agents/supervisor');
  const { attachPowerAnomalyConsumer } = require('../src/main/agents/power-anomaly-consumer');
  const orch = new EventEmitter();
  orch.agents = new Map();
  orch.agents.set('supervisor', new SupervisorAgent({}));
  const suggestions = [];
  orch.on('supervisor:schedule-suggestion', (s) => suggestions.push(s));
  let captured = null;
  const fakePal = { on: (type, cb) => { if (type === 'power-anomaly') captured = cb; return () => {}; } };
  let clock = 9_000_000;
  attachPowerAnomalyConsumer(orch, { pal: fakePal, now: () => clock });
  // Two recurring over-budget anomalies (min-occurrences 2) → one proposal surfaced.
  captured({ anomaly: { type: 'over-budget', device: 'fan-9', valueW: 300, budgetW: 250, at: new Date().toISOString() }, baselineW: 100 });
  clock += 100000;
  captured({ anomaly: { type: 'over-budget', device: 'fan-9', valueW: 305, budgetW: 250, at: new Date().toISOString() }, baselineW: 100 });
  assert.ok(suggestions.length >= 1, 'a proposed schedule was surfaced');
  assert.strictEqual(suggestions[0].status, 'proposed');
  assert.strictEqual(suggestions[0].autonomousAction, false, 'suggestion is advisory');
  advisor.clear();
  delete process.env.LIKU_PERIPHERAL_ADVISOR_MIN_OCCURRENCES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

// ── Phase 19: power forecasting + per-device attribution + token rotation/grace ──

test('power forecast builds per-hour baselines + short-horizon prediction', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const forecast = require('../src/main/peripherals/power-forecast');
  // Two samples at hour 10 (~100W), two at hour 22 (~500W).
  const mk = (h, w) => ({ at: new Date(2026, 6, 17, h, 0, 0).toISOString(), totalW: w, devices: [{ id: 'd1', loadW: w, active: true }] });
  const samples = [mk(10, 100), mk(10, 110), mk(22, 500), mk(22, 520), mk(10, 90), mk(22, 480)];
  const baselines = forecast.hourlyBaselines({ samples });
  assert.ok(baselines[10] && baselines[22], 'per-hour baselines computed');
  assert.ok(baselines[22].mean > baselines[10].mean, 'hour 22 baseline higher than hour 10');
  // Forecast from just before hour 22 predicts the high hour-22 draw.
  const f = forecast.forecast({ samples, horizonHours: 1, now: new Date(2026, 6, 17, 21, 30, 0).getTime() });
  assert.strictEqual(f.ok, true);
  assert.strictEqual(f.horizon[0].hour, 22);
  assert.ok(f.horizon[0].predictedW >= 480, 'forecast reflects the hour-22 baseline');
  // Early warning when the forecast exceeds a budget.
  const warns = forecast.forecastExceedsBudget({ samples, budgetW: 300, horizonHours: 1, now: new Date(2026, 6, 17, 21, 30, 0).getTime() });
  assert.ok(warns.length >= 1 && warns[0].hour === 22, 'forecast raises an early over-budget warning');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('power forecast needs sufficient history (advisory, not premature)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const forecast = require('../src/main/peripherals/power-forecast');
  const few = [{ at: new Date().toISOString(), totalW: 100, devices: [] }];
  assert.strictEqual(forecast.forecast({ samples: few }).ok, false, 'no forecast without enough history');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('anomaly detection attributes the spike to the driving device', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const anomaly = require('../src/main/peripherals/power-anomaly');
  const at = () => new Date().toISOString();
  // Baseline: fridge steady ~30W, heater off. Latest: heater jumps to 400W.
  const samples = [
    { at: at(), totalW: 32, devices: [{ id: 'fridge', loadW: 30 }, { id: 'heater', loadW: 2 }] },
    { at: at(), totalW: 31, devices: [{ id: 'fridge', loadW: 30 }, { id: 'heater', loadW: 1 }] },
    { at: at(), totalW: 33, devices: [{ id: 'fridge', loadW: 31 }, { id: 'heater', loadW: 2 }] },
    { at: at(), totalW: 30, devices: [{ id: 'fridge', loadW: 29 }, { id: 'heater', loadW: 1 }] },
    { at: at(), totalW: 32, devices: [{ id: 'fridge', loadW: 30 }, { id: 'heater', loadW: 2 }] },
    { at: at(), totalW: 430, devices: [{ id: 'fridge', loadW: 30 }, { id: 'heater', loadW: 400 }] }
  ];
  const res = anomaly.detect({ samples });
  const spike = res.anomalies.find((a) => a.type === 'spike');
  assert.ok(spike, 'spike detected');
  assert.strictEqual(spike.attributedDevice, 'heater', 'attributed to the heater (largest increase)');
  assert.strictEqual(res.attributedDevice, 'heater');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('attributed anomaly targets the real device in notifications + tasks', () => {
  const { buildAnomalyNotification } = require('../src/main/agents/power-anomaly-consumer');
  const n = buildAnomalyNotification({ anomaly: { type: 'spike', device: 'power-budget', attributedDevice: 'heater', valueW: 430, at: new Date().toISOString() }, baselineW: 32 });
  assert.strictEqual(n.device.id, 'heater', 'notification targets the attributed device, not the aggregate');
});

test('token scheduled rotation keeps the previous generation valid during the grace window', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_DCP_TOKEN_GRACE_MS = '1000';
  const ts = require('../src/main/peripherals/token-store');
  ts.clear();
  const p = ts.onPair('rot-dev', { actions: ['on'] });
  assert.strictEqual(p.gen, 1);
  const now = 5_000_000;
  const r = ts.rotate('rot-dev', { now });
  assert.strictEqual(r.gen, 2, 'rotation bumps the generation');
  assert.strictEqual(r.prevGen, 1, 'previous generation retained for grace');
  // New generation valid; previous generation valid DURING grace; invalid after.
  assert.strictEqual(ts.isTokenValid('rot-dev', 2, now + 100), true, 'current gen valid');
  assert.strictEqual(ts.isTokenValid('rot-dev', 1, now + 100), true, 'prev gen valid within grace');
  assert.strictEqual(ts.isTokenValid('rot-dev', 1, now + 2000), false, 'prev gen invalid after grace');
  // Revoked → nothing is valid.
  ts.revoke('rot-dev');
  assert.strictEqual(ts.isTokenValid('rot-dev', 3, now + 100), false, 'revoked device rejects all');
  ts.clear();
  delete process.env.LIKU_DCP_TOKEN_GRACE_MS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('scheduled rotation triggers when due (rotateIfDue) + respects pairing', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_DCP_TOKEN_ROTATE_MS = '1000';
  const ts = require('../src/main/peripherals/token-store');
  ts.clear();
  ts.onPair('sched-dev', { actions: ['on'] }); // sets rotateDueAt = now + 1000
  const before = ts.status('sched-dev');
  assert.strictEqual(before.gen, 1);
  assert.ok(before.rotateDueAt > 0, 'scheduled rotation armed on pair');
  // Not yet due → no rotation.
  ts.rotateIfDue('sched-dev', Date.now());
  assert.strictEqual(ts.status('sched-dev').gen, 1, 'not rotated before the interval');
  // Past due → rotates.
  ts.rotateIfDue('sched-dev', before.rotateDueAt + 1);
  assert.strictEqual(ts.status('sched-dev').gen, 2, 'rotated once due');
  ts.clear();
  delete process.env.LIKU_DCP_TOKEN_ROTATE_MS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

// ── Phase 20: forecast confidence + longer horizons + multi-device proposals +
//    advisory anomaly→action patterns ──

test('power forecast reports confidence intervals + supports longer horizons', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const forecast = require('../src/main/peripherals/power-forecast');
  // Six stable samples at hour 14 (~200W) → tight band, high confidence.
  const mk = (h, w) => ({ at: new Date(2026, 6, 17, h, 0, 0).toISOString(), totalW: w, devices: [{ id: 'd1', loadW: w, active: true }] });
  const samples = [mk(14, 198), mk(14, 200), mk(14, 202), mk(14, 199), mk(14, 201), mk(14, 200)];
  const now = new Date(2026, 6, 17, 13, 30, 0).getTime();
  const f = forecast.forecast({ samples, horizonHours: 6, now });
  assert.strictEqual(f.ok, true);
  assert.strictEqual(f.horizon.length, 6, 'longer horizon (6h) supported');
  const h14 = f.horizon[0];
  assert.strictEqual(h14.hour, 14);
  assert.ok('lowW' in h14 && 'highW' in h14 && 'confidence' in h14, 'confidence interval fields present');
  assert.ok(h14.lowW <= h14.predictedW && h14.predictedW <= h14.highW, 'band brackets the prediction');
  assert.strictEqual(h14.confidence, 'high', 'stable, well-sampled hour → high confidence');
  // Horizon is clamped to a day-ahead ceiling (no runaway).
  const long = forecast.forecast({ samples, horizonHours: 999, now });
  assert.strictEqual(long.horizon.length, forecast.MAX_HORIZON_HOURS, 'horizon clamped to day-ahead ceiling');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('multi-device contributor analysis flags joint budget breaches', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const forecast = require('../src/main/peripherals/power-forecast');
  const at = new Date(2026, 6, 17, 20, 0, 0).toISOString();
  const samples = [
    { at, totalW: 550, devices: [{ id: 'heater', loadW: 300 }, { id: 'oven', loadW: 250 }] },
    { at, totalW: 540, devices: [{ id: 'heater', loadW: 295 }, { id: 'oven', loadW: 245 }] }
  ];
  const c = forecast.contributorsAtHour({ hour: 20, budgetW: 400, samples });
  assert.strictEqual(c.exceeds, true, 'combined draw exceeds budget');
  assert.strictEqual(c.contributors.length, 2, 'two contributing devices');
  assert.strictEqual(c.contributors[0].deviceId, 'heater', 'sorted by peak (heater first)');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('multi-device coordinated proposal caps several devices under budget (human-gated)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  const schedule = require('../src/main/peripherals/power-schedule');
  advisor.clear();
  const at = new Date(2026, 6, 17, 20, 0, 0).toISOString();
  const samples = [
    { at, totalW: 550, devices: [{ id: 'heater', loadW: 300 }, { id: 'oven', loadW: 250 }] },
    { at, totalW: 540, devices: [{ id: 'heater', loadW: 295 }, { id: 'oven', loadW: 245 }] }
  ];
  const sug = advisor.proposeMultiDeviceSchedule({ budgetW: 400, hour: 20, samples });
  assert.ok(sug && sug.type === 'multi-device', 'multi-device proposal created');
  assert.strictEqual(sug.devices.length, 2, 'coordinates both contributors');
  assert.strictEqual(sug.autonomousAction, false, 'proposal is strictly advisory');
  const sumCaps = sug.devices.reduce((s, d) => s + d.proposedMaxW, 0);
  assert.ok(sumCaps <= sug.budgetW, 'coordinated caps sum within budget');
  // Not enforced until confirmed.
  assert.strictEqual(schedule.deviceScheduleW('heater', new Date(2026, 6, 17, 20, 0, 0)), null, 'not enforced pre-confirmation');
  const c = advisor.confirm(sug.id);
  assert.strictEqual(c.ok, true);
  // Confirmation activates a per-device rule for BOTH contributors.
  const heaterCap = sug.devices.find((d) => d.deviceId === 'heater').proposedMaxW;
  const ovenCap = sug.devices.find((d) => d.deviceId === 'oven').proposedMaxW;
  assert.strictEqual(schedule.deviceScheduleW('heater', new Date(2026, 6, 17, 20, 0, 0)), heaterCap, 'heater rule enforced');
  assert.strictEqual(schedule.deviceScheduleW('oven', new Date(2026, 6, 17, 20, 0, 0)), ovenCap, 'oven rule enforced');
  advisor.clear();
  try { fs.rmSync(require('../src/main/peripherals/power-schedule').CONFIRMED_FILE); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('anomaly→action advisor escalates reduce-schedule → rotate-token → unpair', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS = '0'; // test raw escalation (cooldown covered separately)
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  actions.clear();
  const rec = (n) => { for (let i = 0; i < n; i++) actions.recordAnomaly({ device: 'dev-x', type: 'spike' }); };
  rec(3);
  let p = actions.proposeActions();
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].action, 'reduce-schedule', '3 occurrences → reduce-schedule');
  rec(3); // 6 total
  p = actions.proposeActions();
  assert.strictEqual(p.find((a) => a.deviceId === 'dev-x').action, 'rotate-token', '6 occurrences → rotate-token');
  rec(4); // 10 total
  p = actions.proposeActions();
  assert.strictEqual(p.find((a) => a.deviceId === 'dev-x').action, 'unpair', '10 occurrences → unpair');
  actions.clear();
  delete process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('anomaly→action confirmation is advisory (returns a command, never executes)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  actions.clear();
  for (let i = 0; i < 3; i++) actions.recordAnomaly({ device: 'lamp-2', type: 'sustained' });
  const [sug] = actions.proposeActions();
  assert.ok(sug && sug.requiresHuman === true, 'proposal requires human review');
  const c = actions.confirm(sug.id);
  assert.strictEqual(c.ok, true);
  assert.strictEqual(c.action, 'reduce-schedule');
  assert.strictEqual(typeof c.directive, 'string', 'confirmation returns a command for a human to run');
  assert.ok(/liku peripherals/.test(c.directive), 'directive is an explicit CLI command');
  // Confirmed → no longer an open proposal (recorded, not executed).
  assert.strictEqual(actions.listProposed().length, 0, 'confirmed proposal is closed');
  actions.clear();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('anomaly→action advisor ignores the synthetic power-budget aggregate + is flag-gated', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  actions.clear();
  for (let i = 0; i < 5; i++) actions.recordAnomaly({ device: 'power-budget', type: 'over-budget' });
  assert.strictEqual(actions.proposeActions().length, 0, 'no action suggestion for the aggregate');
  actions.clear();
  // Flag OFF → no disk touched, no proposals.
  delete process.env.LIKU_ENABLE_PERIPHERALS;
  actions.recordAnomaly({ device: 'dev-y', type: 'spike' });
  assert.strictEqual(actions.proposeActions().length, 0, 'inert when disabled');
  assert.strictEqual(fs.existsSync(actions.STORE_FILE), false, 'no anomaly-actions.json when disabled');
});

test('multi-device proposal requires 2+ contributors + is deduped per hour', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  advisor.clear();
  const at = new Date(2026, 6, 17, 20, 0, 0).toISOString();
  // Single contributor over budget → NOT a multi-device proposal.
  const solo = [{ at, totalW: 600, devices: [{ id: 'heater', loadW: 600 }] }];
  assert.strictEqual(advisor.proposeMultiDeviceSchedule({ budgetW: 400, hour: 20, samples: solo }), null, 'single contributor → no multi-device proposal');
  // Two contributors → a proposal; a second call returns the SAME open proposal.
  const both = [{ at, totalW: 550, devices: [{ id: 'heater', loadW: 300 }, { id: 'oven', loadW: 250 }] }];
  const first = advisor.proposeMultiDeviceSchedule({ budgetW: 400, hour: 20, samples: both });
  assert.ok(first && first.type === 'multi-device');
  const second = advisor.proposeMultiDeviceSchedule({ budgetW: 400, hour: 20, samples: both });
  assert.strictEqual(second.id, first.id, 'deduped — one open multi-device proposal per hour');
  advisor.clear();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('consumer surfaces an advisory anomaly→action for a persistently anomalous device', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  actions.clear();
  advisor.clear();
  const EventEmitter = require('events');
  const { SupervisorAgent } = require('../src/main/agents/supervisor');
  const { attachPowerAnomalyConsumer } = require('../src/main/agents/power-anomaly-consumer');
  const orch = new EventEmitter();
  orch.agents = new Map();
  orch.agents.set('supervisor', new SupervisorAgent({}));
  const actionEvents = [];
  orch.on('supervisor:anomaly-action', (a) => actionEvents.push(a));
  let captured = null;
  const fakePal = { on: (type, cb) => { if (type === 'power-anomaly') captured = cb; return () => {}; } };
  let clock = 12_000_000;
  attachPowerAnomalyConsumer(orch, { pal: fakePal, now: () => clock });
  // Three over-budget anomalies for a REAL device (past the 15s tier cooldown).
  for (let i = 0; i < 3; i++) {
    captured({ anomaly: { type: 'over-budget', device: 'pump-3', valueW: 900, budgetW: 500, at: new Date().toISOString() }, baselineW: 200 });
    clock += 20000;
  }
  assert.ok(actionEvents.length >= 1, 'an advisory action was surfaced');
  assert.strictEqual(actionEvents[0].deviceId, 'pump-3', 'action targets the real device');
  assert.strictEqual(actionEvents[0].autonomousAction, false, 'action is strictly advisory');
  actions.clear();
  advisor.clear();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

// ── Phase 21: lock observability + cross-host coordination + cron scheduling ──

test('per-file lock metrics attribute contention to the right store', () => {
  const atomic = require('../src/shared/atomic-file');
  atomic.resetLockMetrics();
  const a = require('path').join(TMP_HOME, 'lock-metric-a.json');
  const b = require('path').join(TMP_HOME, 'lock-metric-b.json');
  atomic.atomicWriteFileSync(a, '{"x":1}');
  atomic.atomicWriteFileSync(a, '{"x":2}');
  atomic.atomicWriteFileSync(b, '{"y":1}');
  const perFile = atomic.getPerFileLockMetrics();
  assert.ok(perFile['lock-metric-a.json'] && perFile['lock-metric-a.json'].acquired >= 2, 'file a tracked twice');
  assert.ok(perFile['lock-metric-b.json'] && perFile['lock-metric-b.json'].acquired >= 1, 'file b tracked');
  assert.ok(atomic.getLockMetrics().acquired >= 3, 'global counters still aggregate');
  atomic.resetLockMetrics();
  try { fs.rmSync(a); fs.rmSync(b); } catch { /* ignore */ }
});

test('lock history persists snapshots + trends (flag-gated, no disk when off)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const lh = require('../src/main/peripherals/lock-history');
  lh.clear();
  const atomic = require('../src/shared/atomic-file');
  atomic.atomicWriteFileSync(require('path').join(TMP_HOME, 'lh-seed.json'), '{"a":1}');
  lh.record();
  lh.record();
  const snaps = lh.query({ limit: 10 });
  assert.ok(snaps.length >= 2, 'snapshots recorded');
  assert.ok('metrics' in snaps[0] && 'perFile' in snaps[0], 'snapshot carries metrics + per-file');
  const t = lh.trends({ limit: 10 });
  assert.ok(t.snapshots >= 2, 'trends computed');
  assert.ok('contentionRate' in t && Array.isArray(t.hotFiles), 'trend exposes contention rate + hot files');
  lh.clear();
  // Flag OFF → inert, no disk.
  delete process.env.LIKU_ENABLE_PERIPHERALS;
  assert.strictEqual(lh.record(), null, 'no snapshot when disabled');
  assert.strictEqual(fs.existsSync(lh.HISTORY_FILE), false, 'no lock-history.jsonl when disabled');
  try { fs.rmSync(require('path').join(TMP_HOME, 'lh-seed.json')); } catch { /* ignore */ }
});

test('coordination is single-machine by default (backward compatible)', () => {
  delete process.env.LIKU_CLUSTER_DIR;
  const coord = require('../src/main/peripherals/coordination');
  assert.strictEqual(coord.clusterEnabled(), false, 'cluster off without LIKU_CLUSTER_DIR');
  const g = coord.acquireLease('device:x');
  assert.strictEqual(g.granted, true, 'lease granted locally');
  assert.strictEqual(g.local, true, 'granted in single-machine mode');
  assert.strictEqual(coord.canAct('device:x'), true, 'always may act on a single machine');
  assert.strictEqual(coord.status().mode, 'single-machine');
});

test('cross-host leases mutually exclude nodes + steal on expiry (cluster mode)', () => {
  const clusterDir = require('path').join(TMP_HOME, 'cluster');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const coord = require('../src/main/peripherals/coordination');
  assert.strictEqual(coord.clusterEnabled(), true, 'cluster mode on');
  const t0 = 1_000_000;
  process.env.LIKU_NODE_ID = 'nodeA';
  const a = coord.acquireLease('device:shared', { ttlMs: 1000, now: t0 });
  assert.strictEqual(a.granted, true, 'nodeA acquires');
  // nodeB is denied while nodeA's lease is live.
  process.env.LIKU_NODE_ID = 'nodeB';
  const b = coord.acquireLease('device:shared', { ttlMs: 1000, now: t0 + 100 });
  assert.strictEqual(b.granted, false, 'nodeB denied while held');
  assert.strictEqual(b.holder.nodeId, 'nodeA');
  assert.strictEqual(coord.canAct('device:shared', t0 + 100), false, 'nodeB may not act');
  // nodeB cannot release nodeA's lease.
  assert.strictEqual(coord.releaseLease('device:shared').released, false, 'non-owner cannot release');
  // After expiry, nodeB steals it.
  const b2 = coord.acquireLease('device:shared', { ttlMs: 1000, now: t0 + 2000 });
  assert.strictEqual(b2.granted, true, 'expired lease stolen by nodeB');
  coord.releaseLease('device:shared');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('coordination sanitizes resource ids (no path traversal)', () => {
  const clusterDir = require('path').join(TMP_HOME, 'cluster2');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const coord = require('../src/main/peripherals/coordination');
  // A traversal attempt is sanitized to a safe filename inside the leases dir.
  const g = coord.acquireLease('device:../../etc/passwd', { ttlMs: 1000, now: 5000 });
  assert.strictEqual(g.granted, true, 'sanitized id still leases safely');
  const leasesDir = require('path').join(clusterDir, 'leases');
  const entries = fs.existsSync(leasesDir) ? fs.readdirSync(leasesDir) : [];
  assert.ok(entries.every((n) => !n.includes('..') && !n.includes('/') && !n.includes('\\')), 'no traversal in lease filenames');
  coord.releaseLease('device:../../etc/passwd');
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('PAL execute blocks a device leased by another node (cluster mode); single-machine unaffected', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const coord = require('../src/main/peripherals/coordination');
  // Single-machine: the gate is inert.
  delete process.env.LIKU_CLUSTER_DIR;
  assert.strictEqual(coord.canAct('device:pump-42'), true, 'single-machine may always act');
  // Cluster mode: a foreign node holds the device lease → canAct false (the exact
  // predicate the PAL execute gate uses to reject with device-leased-elsewhere).
  const clusterDir = require('path').join(TMP_HOME, 'cluster3');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  process.env.LIKU_NODE_ID = 'other-node';
  coord.acquireLease('device:pump-42', { ttlMs: 5000, now: 9000 });
  process.env.LIKU_NODE_ID = 'this-node';
  assert.strictEqual(coord.canAct('device:pump-42', 9500), false, 'held by other node → execute gate would block');
  const holder = coord.whoHolds('device:pump-42', 9500);
  assert.strictEqual(holder.nodeId, 'other-node');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('cron parser validates + rejects malformed expressions (sandboxed)', () => {
  const cron = require('../src/main/peripherals/device-schedule');
  assert.strictEqual(cron.validate('*/15 * * * *'), true, 'step syntax valid');
  assert.strictEqual(cron.validate('0 9-17 * * 1-5'), true, 'range + list valid');
  assert.strictEqual(cron.validate('0 0 1 1 0'), true, 'all-numeric valid');
  assert.strictEqual(cron.validate('60 * * * *'), false, 'minute out of range rejected');
  assert.strictEqual(cron.validate('* * * *'), false, 'wrong field count rejected');
  assert.strictEqual(cron.validate('*/0 * * * *'), false, 'zero step rejected');
  assert.strictEqual(cron.validate('a b c d e'), false, 'non-numeric rejected');
  assert.strictEqual(cron.validate('* * * * * ; rm -rf /'), false, 'injection-style input rejected');
});

test('cron matcher fires on the right minute (Vixie dom/dow semantics)', () => {
  const cron = require('../src/main/peripherals/device-schedule');
  const d = new Date(2026, 6, 20, 9, 30, 0); // Mon 2026-07-20 09:30 (getDay()=1)
  assert.strictEqual(cron.matches('30 9 * * *', d), true, 'exact minute/hour match');
  assert.strictEqual(cron.matches('31 9 * * *', d), false, 'off-by-one minute no match');
  assert.strictEqual(cron.matches('30 9 * * 1', d), true, 'weekday match');
  // dom + dow both restricted → OR semantics (matches if EITHER matches).
  assert.strictEqual(cron.matches('30 9 1 * 1', d), true, 'dom mismatch but dow matches → fires (OR)');
});

test('cron produces advisory, human-gated proposed tasks (Class A gated, never executed)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const registry = require('../src/main/peripherals/peripheral-registry').getInstance();
  registry.register({ id: 'cron-lock', class: 'A', kind: 'lock', name: 'Cron Lock', capabilities: ['lock', 'unlock'], driver: 'mock' });
  const now = new Date(2026, 6, 20, 7, 0, 0);
  process.env.LIKU_DEVICE_CRON = JSON.stringify([
    { id: 'r1', deviceId: 'cron-lock', action: 'lock', cron: `${now.getMinutes()} ${now.getHours()} * * *` },
    { id: 'bad', deviceId: 'cron-lock', action: 'DROP TABLE', cron: '* * * * *' } // disallowed action → dropped
  ]);
  const cron = require('../src/main/peripherals/device-schedule');
  const rules = cron.loadRules();
  assert.strictEqual(rules.length, 1, 'disallowed-action rule rejected by the allow-list');
  const tasks = cron.proposeCronTasks(now);
  assert.strictEqual(tasks.length, 1, 'one cron task due');
  const t = tasks[0];
  assert.strictEqual(t.deviceId, 'cron-lock');
  assert.strictEqual(t.status, 'pending-review', 'advisory proposed task');
  assert.strictEqual(t.autonomousAction, false, 'never autonomous');
  assert.strictEqual(t.requiresHuman, true, 'Class A device → human-gated');
  registry.clear();
  delete process.env.LIKU_DEVICE_CRON;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('cron scheduling is flag-gated + additive (existing power schedules untouched)', () => {
  const cron = require('../src/main/peripherals/device-schedule');
  // Flag OFF → no rules regardless of env.
  delete process.env.LIKU_ENABLE_PERIPHERALS;
  process.env.LIKU_DEVICE_CRON = JSON.stringify([{ deviceId: 'x', action: 'on', cron: '* * * * *' }]);
  assert.strictEqual(cron.loadRules().length, 0, 'inert when disabled');
  assert.strictEqual(cron.proposeCronTasks(new Date()).length, 0, 'no tasks when disabled');
  // Existing power-schedule module still behaves independently (no cron coupling).
  const schedule = require('../src/main/peripherals/power-schedule');
  assert.strictEqual(schedule.deviceScheduleW('x', new Date()), null, 'power schedules unaffected by cron');
  delete process.env.LIKU_DEVICE_CRON;
});

test('PAL surfaces lock/coordination/cron observability accessors', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  // Coordination status defaults to single-machine + device-lease is local.
  const cs = pal.getCoordinationStatus();
  assert.strictEqual(cs.mode, 'single-machine');
  const lease = pal.acquireDeviceLease('pal-dev');
  assert.strictEqual(lease.granted, true, 'single-machine device lease granted locally');
  assert.strictEqual(pal.releaseDeviceLease('pal-dev').released, true);
  // Lock trends accessor is safe even with little/no history.
  const trends = pal.getLockTrends({ limit: 5 });
  assert.strictEqual(trends.enabled, true);
  assert.ok(Array.isArray(trends.hotFiles), 'trends expose hot files array');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('PAL cron accessors return advisory schedules + due tasks (flag-gated)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const now = new Date(2026, 6, 21, 8, 15, 0);
  process.env.LIKU_DEVICE_CRON = JSON.stringify([{ id: 'pc', deviceId: 'lamp', action: 'on', cron: `${now.getMinutes()} ${now.getHours()} * * *` }]);
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  const rules = pal.getCronSchedules();
  assert.strictEqual(rules.rules.length, 1, 'cron rule surfaced');
  assert.strictEqual(rules.rules[0].valid, true);
  const due = pal.getDueCronTasks(now.getTime());
  assert.strictEqual(due.tasks.length, 1, 'due task produced');
  assert.strictEqual(due.tasks[0].autonomousAction, false, 'advisory only');
  // Flag OFF → inert.
  delete process.env.LIKU_ENABLE_PERIPHERALS;
  assert.strictEqual(pal.getCronSchedules().enabled, false, 'inert when disabled');
  delete process.env.LIKU_DEVICE_CRON;
});

// ── Phase 22: token refinements + cron productionization + cluster lock aggregation ──

test('per-action token mints least-privilege scope + verifies correctly', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const ts = require('../src/main/peripherals/token-store');
  ts.clear();
  ts.onPair('pa-dev', { actions: ['on', 'off'] });
  const res = ts.issueActionToken('pa-dev', 'on');
  assert.strictEqual(res.ok, true, 'per-action token issued');
  assert.strictEqual(ts.verifyDeviceToken('pa-dev', 'on', res.token).ok, true, 'valid for its action');
  assert.strictEqual(ts.verifyDeviceToken('pa-dev', 'off', res.token).ok, false, 'rejected for a different action');
  // Cannot mint a token for an action the device was not granted.
  assert.strictEqual(ts.issueActionToken('pa-dev', 'explode').ok, false, 'ungranted action refused');
  ts.clear();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('token verification honours revocation + generation via the store', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const ts = require('../src/main/peripherals/token-store');
  ts.clear();
  ts.onPair('rv-dev', { actions: ['unlock'] });
  const tok = ts.issueActionToken('rv-dev', 'unlock').token;
  assert.strictEqual(ts.verifyDeviceToken('rv-dev', 'unlock', tok).ok, true, 'valid before revoke');
  ts.revoke('rv-dev');
  assert.strictEqual(ts.verifyDeviceToken('rv-dev', 'unlock', tok).ok, false, 'rejected after revoke');
  assert.strictEqual(ts.verifyDeviceToken('rv-dev', 'unlock', tok).reason, 'revoked');
  ts.clear();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('token revocation + rotation propagate across hosts (cluster mirror)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'tcluster');
  const ts = require('../src/main/peripherals/token-store');
  ts.clear();
  // Local device paired at gen 1 (cluster off so no mirror yet).
  delete process.env.LIKU_CLUSTER_DIR;
  ts.onPair('xh-dev', { actions: ['on'] });
  assert.strictEqual(ts.status('xh-dev').gen, 1);
  // Turn on cluster mode; simulate another node having ROTATED to gen 3.
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const tdir = require('path').join(clusterDir, 'tokens');
  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(require('path').join(tdir, 'xh-dev.json'), JSON.stringify({ deviceId: 'xh-dev', gen: 3, revoked: false, identityFp: ts.identity('xh-dev') }));
  assert.strictEqual(ts.status('xh-dev').gen, 3, 'effective gen is the fleet max (rotation propagated)');
  assert.strictEqual(ts.isTokenValid('xh-dev', 3, Date.now()), true, 'gen-3 token minted elsewhere validates here');
  // Another node REVOKES → propagates as revoked everywhere.
  fs.writeFileSync(require('path').join(tdir, 'xh-dev.json'), JSON.stringify({ deviceId: 'xh-dev', gen: 4, revoked: true, identityFp: ts.identity('xh-dev') }));
  assert.strictEqual(ts.isRevoked('xh-dev'), true, 'revocation propagated across hosts');
  ts.clear();
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('confirming an anomaly→action auto-rotates the token (human-gated, executed)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const ts = require('../src/main/peripherals/token-store');
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  ts.clear();
  actions.clear();
  ts.onPair('sec-dev', { actions: ['on'] });
  assert.strictEqual(ts.status('sec-dev').gen, 1);
  // 6 anomalies → the advisor escalates to a rotate-token suggestion.
  for (let i = 0; i < 6; i++) actions.recordAnomaly({ device: 'sec-dev', type: 'spike' });
  const proposal = actions.proposeActions().find((a) => a.deviceId === 'sec-dev');
  assert.strictEqual(proposal.action, 'rotate-token');
  // Human confirmation performs the approved security op (auto-rotate).
  const res = pal.confirmAnomalyAction(proposal.id);
  assert.strictEqual(res.ok, true);
  assert.ok(res.executed && res.executed.ok, 'security op executed on confirmation');
  assert.strictEqual(ts.status('sec-dev').gen, 2, 'token rotated (gen bumped) after human confirm');
  ts.clear();
  actions.clear();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('cron confirm flow persists a proposed rule (not active until confirmed)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const cron = require('../src/main/peripherals/device-schedule');
  cron.clearProposals();
  try { fs.rmSync(cron.CRON_FILE); } catch { /* ignore */ }
  const p = cron.proposeRule({ deviceId: 'cr-dev', action: 'on', cron: '0 8 * * *' });
  assert.strictEqual(p.ok, true, 'rule proposed');
  assert.strictEqual(cron.loadRules().length, 0, 'proposed rule is NOT active');
  assert.strictEqual(cron.listProposedRules().length, 1, 'one open proposal');
  const c = cron.confirmRule(p.proposal.id);
  assert.strictEqual(c.ok, true, 'confirmed');
  const active = cron.loadRules().filter((r) => r.deviceId === 'cr-dev');
  assert.strictEqual(active.length, 1, 'confirmed rule now active + persisted');
  assert.strictEqual(active[0].source, 'confirmed');
  // Remove it again.
  assert.strictEqual(cron.removeConfirmedRule(p.proposal.id).ok, true, 'confirmed rule removable');
  assert.strictEqual(cron.loadRules().filter((r) => r.deviceId === 'cr-dev').length, 0, 'removed');
  cron.clearProposals();
  try { fs.rmSync(cron.CRON_FILE); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('cron scheduler tick creates human-gated Supervisor tasks (dedup + cooldown)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const registry = require('../src/main/peripherals/peripheral-registry').getInstance();
  registry.register({ id: 'cron-lockx', class: 'A', kind: 'lock', name: 'Cron Lock X', capabilities: ['lock'], driver: 'mock' });
  const now = new Date(2026, 6, 22, 6, 30, 0);
  process.env.LIKU_DEVICE_CRON = JSON.stringify([{ id: 'ct1', deviceId: 'cron-lockx', action: 'lock', cron: `${now.getMinutes()} ${now.getHours()} * * *` }]);
  const EventEmitter = require('events');
  const { SupervisorAgent, attachCronScheduler } = require('../src/main/agents');
  const orch = new EventEmitter();
  orch.agents = new Map();
  orch.agents.set('supervisor', new SupervisorAgent({}));
  const emitted = [];
  orch.on('supervisor:cron-task', (t) => emitted.push(t));
  let clock = now.getTime();
  const sched = attachCronScheduler(orch, { now: () => clock, cooldownMs: 300000 });
  const first = sched.tick(now);
  assert.strictEqual(first.created.length, 1, 'a cron task was created');
  const task = first.created[0];
  assert.strictEqual(task.status, 'pending-review', 'human-gated task');
  assert.strictEqual(task.requiresHuman, true, 'Class A → requires human');
  assert.strictEqual(task.autonomousAction, false, 'never autonomous');
  assert.ok(emitted.length >= 1, 'supervisor:cron-task emitted');
  // Second tick within the cooldown → no duplicate.
  clock += 1000;
  assert.strictEqual(sched.tick(now).created.length, 0, 'deduped within cooldown');
  sched.detach();
  registry.clear();
  delete process.env.LIKU_DEVICE_CRON;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('cluster lock metrics aggregate across nodes', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'lmcluster');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  process.env.LIKU_NODE_ID = 'nodeC';
  const mdir = require('path').join(clusterDir, 'lock-metrics');
  fs.mkdirSync(mdir, { recursive: true });
  fs.writeFileSync(require('path').join(mdir, 'nodeA.json'), JSON.stringify({ nodeId: 'nodeA', at: new Date().toISOString(), metrics: { acquired: 10, contended: 2, steals: 0, fallbacks: 0, retries: 1 }, perFile: { 'a.json': { acquired: 10, contended: 2, steals: 0 } } }));
  fs.writeFileSync(require('path').join(mdir, 'nodeB.json'), JSON.stringify({ nodeId: 'nodeB', at: new Date().toISOString(), metrics: { acquired: 15, contended: 5, steals: 1, fallbacks: 0, retries: 3 }, perFile: { 'a.json': { acquired: 15, contended: 5, steals: 1 } } }));
  const agg = require('../src/main/peripherals/lock-history').clusterAggregate();
  assert.strictEqual(agg.mode, 'cluster');
  assert.ok(agg.nodes >= 2, 'aggregates multiple nodes');
  assert.ok(agg.totals.acquired >= 25, 'sums acquired across nodes');
  assert.ok(agg.hotFiles.length >= 1 && agg.hotFiles[0].file === 'a.json', 'combined per-file hotspot');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Phase 22 stores are flag-gated (no disk when disabled)', () => {
  delete process.env.LIKU_ENABLE_PERIPHERALS;
  const cron = require('../src/main/peripherals/device-schedule');
  const ts = require('../src/main/peripherals/token-store');
  assert.strictEqual(cron.proposeRule({ deviceId: 'x', action: 'on', cron: '* * * * *' }).ok, false, 'cron propose inert when disabled');
  assert.strictEqual(cron.listProposedRules().length, 0, 'no proposals when disabled');
  assert.strictEqual(ts.issueActionToken('x', 'on').ok, false, 'per-action token inert when disabled');
  assert.strictEqual(fs.existsSync(cron.PROPOSALS_FILE), false, 'no device-cron-proposals.json when disabled');
});

test('PAL exposes per-action token + verification accessors', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const ts = require('../src/main/peripherals/token-store');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  ts.clear();
  ts.onPair('pal-tok', { actions: ['on', 'off'] });
  const minted = pal.issueActionToken('pal-tok', 'on');
  assert.strictEqual(minted.ok, true, 'PAL mints a per-action token');
  assert.strictEqual(pal.verifyDeviceToken('pal-tok', 'on', minted.token).ok, true, 'PAL verifies the scoped token');
  assert.strictEqual(pal.verifyDeviceToken('pal-tok', 'off', minted.token).ok, false, 'PAL rejects a different action');
  ts.clear();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('PAL cron confirm-flow accessors propose + persist + dismiss', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const cron = require('../src/main/peripherals/device-schedule');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  cron.clearProposals();
  try { fs.rmSync(cron.CRON_FILE); } catch { /* ignore */ }
  const p = pal.proposeCronRule({ deviceId: 'pal-cr', action: 'off', cron: '30 22 * * *' });
  assert.strictEqual(p.ok, true, 'PAL proposes a cron rule');
  assert.strictEqual(pal.getProposedCronRules().proposals.length, 1, 'PAL lists proposals');
  const c = pal.confirmCronRule(p.proposal.id);
  assert.strictEqual(c.ok, true, 'PAL confirms + persists');
  assert.strictEqual(cron.loadRules().filter((r) => r.deviceId === 'pal-cr').length, 1, 'rule now active');
  cron.clearProposals();
  try { fs.rmSync(cron.CRON_FILE); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

// ── Phase 23: forecast refinements + advanced anomaly→action ──

test('seasonal forecast prefers the day-of-week baseline', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const forecast = require('../src/main/peripherals/power-forecast');
  const dayA = new Date(2026, 6, 20, 18, 0, 0); // same hour, two different weekdays
  const dayB = new Date(2026, 6, 21, 18, 0, 0);
  const mk = (d, w) => ({ at: d.toISOString(), totalW: w, devices: [{ id: 'd1', loadW: w }] });
  const samples = [mk(dayA, 200), mk(dayA, 210), mk(dayA, 190), mk(dayB, 600), mk(dayB, 610), mk(dayB, 590)];
  const fA = forecast.seasonalForecast({ samples, horizonHours: 1, now: new Date(2026, 6, 20, 17, 30, 0).getTime() });
  assert.strictEqual(fA.horizon[0].basis, 'dow-hour-baseline', 'uses the dow baseline');
  assert.ok(fA.horizon[0].predictedW >= 180 && fA.horizon[0].predictedW <= 220, 'weekday-A prediction ~200W');
  const fB = forecast.seasonalForecast({ samples, horizonHours: 1, now: new Date(2026, 6, 21, 17, 30, 0).getTime() });
  assert.ok(fB.horizon[0].predictedW >= 560 && fB.horizon[0].predictedW <= 620, 'weekday-B prediction ~600W (seasonality)');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('seasonal forecast falls back through the weekday group, then hour-of-day', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const forecast = require('../src/main/peripherals/power-forecast');
  const dayA = new Date(2026, 6, 20, 18, 0, 0); // Monday (weekday)
  const mk = (w) => ({ at: dayA.toISOString(), totalW: w, devices: [{ id: 'd1', loadW: w }] });
  const samples = [mk(200), mk(210), mk(190), mk(205), mk(195), mk(200)];
  // A DIFFERENT weekday with no dow baseline → weekend/weekday GROUP fallback.
  const f = forecast.seasonalForecast({ samples, horizonHours: 1, now: new Date(2026, 6, 22, 17, 30, 0).getTime() });
  assert.strictEqual(f.horizon[0].basis, 'dow-group-baseline', 'weekday group fallback (improved dow handling)');
  assert.ok(f.horizon[0].predictedW >= 180 && f.horizon[0].predictedW <= 220);
  // A WEEKEND day (no weekend samples at all) → falls through to hour-of-day.
  const fWknd = forecast.seasonalForecast({ samples, horizonHours: 1, now: new Date(2026, 6, 25, 17, 30, 0).getTime() });
  assert.strictEqual(fWknd.horizon[0].basis, 'hourly-baseline', 'no group match → hour-of-day fallback');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('per-device forecast warnings name the driving device', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const forecast = require('../src/main/peripherals/power-forecast');
  const at = (h) => new Date(2026, 6, 20, h, 0, 0).toISOString();
  const mk = (h, oven, fridge) => ({ at: at(h), totalW: oven + fridge, devices: [{ id: 'oven', loadW: oven }, { id: 'fridge', loadW: fridge }] });
  const samples = [mk(20, 500, 30), mk(20, 510, 30), mk(20, 490, 30), mk(20, 505, 30), mk(20, 495, 30), mk(20, 500, 30)];
  const warns = forecast.deviceForecastWarnings({ budgetW: 400, samples, horizonHours: 1, now: new Date(2026, 6, 20, 19, 30, 0).getTime() });
  assert.ok(warns.length >= 1, 'a device warning is raised');
  assert.strictEqual(warns[0].deviceId, 'oven', 'names the biggest contributor');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('multi-hour proposal spans a contiguous over-budget run + confirm caps the window', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  const schedule = require('../src/main/peripherals/power-schedule');
  advisor.clear();
  const at = (h) => new Date(2026, 6, 20, h, 0, 0).toISOString();
  const mk = (h, w) => ({ at: at(h), totalW: w, devices: [{ id: 'oven', loadW: w }] });
  // Hours 20 and 21 both ~600W → a 2-hour over-budget run vs budget 400.
  const samples = [mk(20, 600), mk(20, 610), mk(20, 590), mk(21, 600), mk(21, 610), mk(21, 590)];
  const sug = advisor.proposeMultiHourSchedule({ budgetW: 400, samples, horizonHours: 2, now: new Date(2026, 6, 20, 19, 30, 0).getTime() });
  assert.ok(sug && sug.type === 'multi-hour', 'multi-hour proposal created');
  assert.strictEqual(sug.autonomousAction, false, 'advisory only');
  assert.ok(sug.hours.length >= 2, 'spans a multi-hour run');
  const c = advisor.confirm(sug.id);
  assert.strictEqual(c.ok, true);
  const cap = sug.devices.find((d) => d.deviceId === 'oven').proposedMaxW;
  assert.strictEqual(schedule.deviceScheduleW('oven', new Date(2026, 6, 20, 20, 0, 0)), cap, 'hour 20 capped');
  assert.strictEqual(schedule.deviceScheduleW('oven', new Date(2026, 6, 20, 21, 0, 0)), cap, 'hour 21 capped (multi-hour window)');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('confirming a reduce-schedule anomaly→action auto-creates + confirms a schedule', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  const history = require('../src/main/peripherals/power-history');
  const schedule = require('../src/main/peripherals/power-schedule');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  actions.clear();
  history.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  // Seed a device forecast baseline for the current hour so a cap can be derived.
  const nowHour = new Date().getHours();
  history.record({ at: new Date().toISOString(), totalW: 120, budgetW: 200, overBudget: false, devices: [{ id: 'rdev', loadW: 120, active: true }] });
  for (let i = 0; i < 3; i++) actions.recordAnomaly({ device: 'rdev', type: 'spike' });
  const proposal = actions.proposeActions().find((a) => a.deviceId === 'rdev');
  assert.strictEqual(proposal.action, 'reduce-schedule');
  const res = pal.confirmAnomalyAction(proposal.id);
  assert.strictEqual(res.ok, true);
  assert.ok(res.executed && res.executed.ok, 'schedule auto-created on confirm');
  assert.strictEqual(schedule.deviceScheduleW('rdev', new Date(2026, 6, 20, nowHour, 0, 0)) != null, true, 'a confirmed schedule now governs the device');
  actions.clear();
  history.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('fleet-wide rotate-all is proposed when several devices are persistently anomalous', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  actions.clear();
  for (const dev of ['fa', 'fb', 'fc']) for (let i = 0; i < 3; i++) actions.recordAnomaly({ device: dev, type: 'spike' });
  const fleet = actions.proposeFleetAction();
  assert.ok(fleet, 'fleet action proposed');
  assert.strictEqual(fleet.action, 'rotate-all');
  assert.strictEqual(fleet.scope, 'fleet');
  assert.strictEqual(fleet.autonomousAction, false, 'advisory');
  assert.ok(fleet.devices.length >= 3, 'names the anomalous devices');
  actions.clear();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('token rotateAll rotates active devices + skips revoked (human-gated fleet response)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const ts = require('../src/main/peripherals/token-store');
  ts.clear();
  ts.onPair('ra-a', { actions: ['on'] });
  ts.onPair('ra-b', { actions: ['on'] });
  ts.revoke('ra-b');
  const res = ts.rotateAll();
  assert.strictEqual(res.ok, true);
  assert.ok(res.rotated.includes('ra-a'), 'active device rotated');
  assert.ok(!res.rotated.includes('ra-b'), 'revoked device skipped');
  assert.strictEqual(ts.status('ra-a').gen, 2, 'active device gen bumped');
  ts.clear();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('confirming a fleet anomaly→action rotates all tokens (human-gated)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const ts = require('../src/main/peripherals/token-store');
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  ts.clear();
  actions.clear();
  ts.onPair('flt-a', { actions: ['on'] });
  ts.onPair('flt-b', { actions: ['on'] });
  for (const dev of ['flt-a', 'flt-b', 'flt-c'] ) for (let i = 0; i < 3; i++) actions.recordAnomaly({ device: dev, type: 'spike' });
  const fleet = actions.proposeFleetAction();
  const res = pal.confirmAnomalyAction(fleet.id);
  assert.strictEqual(res.ok, true);
  assert.ok(res.executed && res.executed.ok, 'rotate-all executed on confirm');
  assert.strictEqual(ts.status('flt-a').gen, 2, 'flt-a rotated');
  assert.strictEqual(ts.status('flt-b').gen, 2, 'flt-b rotated');
  ts.clear();
  actions.clear();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('createConfirmedSchedule writes a restrict-only rule directly (human-approved)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  const schedule = require('../src/main/peripherals/power-schedule');
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  const r = advisor.createConfirmedSchedule('direct-dev', { maxW: 150, fromHour: 10, toHour: 12 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(schedule.deviceScheduleW('direct-dev', new Date(2026, 6, 20, 10, 30, 0)), 150, 'rule enforced in window');
  assert.strictEqual(schedule.deviceScheduleW('direct-dev', new Date(2026, 6, 20, 13, 0, 0)), 0, 'outside window → off');
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('PAL exposes seasonal forecast + device-warning + multi-hour accessors', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  const s = pal.getSeasonalForecast();
  assert.strictEqual(s.enabled, true, 'seasonal forecast accessor enabled');
  const w = pal.getDeviceForecastWarnings({ budgetW: 100 });
  assert.ok(Array.isArray(w.warnings), 'device warnings accessor returns an array');
  const m = pal.getMultiHourProposal({ budgetW: 100 });
  assert.strictEqual(m.enabled, true, 'multi-hour accessor enabled');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

// ── Phase 24: multi-device auto-heal + policies + forecast refinements ──

test('anomaly-aware baselines exclude flagged spikes from the forecast', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_FORECAST_MIN_SAMPLES = '3';
  const forecast = require('../src/main/peripherals/power-forecast');
  const at = (h) => new Date(2026, 6, 20, h, 0, 0).toISOString();
  // Hour 18 is normally ~200W, but one sample is a flagged 900W anomaly.
  const samples = [
    { at: at(18), totalW: 200, devices: [{ id: 'd', loadW: 200 }] },
    { at: at(18), totalW: 210, devices: [{ id: 'd', loadW: 210 }] },
    { at: at(18), totalW: 190, devices: [{ id: 'd', loadW: 190 }] },
    { at: at(18), totalW: 205, devices: [{ id: 'd', loadW: 205 }] },
    { at: at(18), totalW: 195, devices: [{ id: 'd', loadW: 195 }] },
    { at: at(18), totalW: 900, overBudget: true, devices: [{ id: 'd', loadW: 900 }] }
  ];
  const now = new Date(2026, 6, 20, 17, 30, 0).getTime();
  const withAll = forecast.seasonalForecast({ samples, horizonHours: 1, now });
  const excluded = forecast.seasonalForecast({ samples, horizonHours: 1, now, excludeAnomalous: true });
  assert.ok(withAll.horizon[0].predictedW > excluded.horizon[0].predictedW, 'excluding the spike lowers the prediction');
  assert.ok(excluded.horizon[0].predictedW <= 220, 'anomaly-aware prediction reflects normal operation');
  assert.strictEqual(excluded.excludedAnomalous, true);
  delete process.env.LIKU_PERIPHERAL_FORECAST_MIN_SAMPLES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('holiday dates are excluded from anomaly-aware baselines', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_FORECAST_MIN_SAMPLES = '3';
  process.env.LIKU_PERIPHERAL_FORECAST_HOLIDAYS = '2026-07-19';
  const forecast = require('../src/main/peripherals/power-forecast');
  const norm = (h) => new Date(2026, 6, 20, h, 0, 0).toISOString(); // Monday
  const holiday = (h) => new Date(2026, 6, 19, h, 0, 0).toISOString(); // flagged holiday
  const samples = [
    { at: norm(18), totalW: 200, devices: [{ id: 'd', loadW: 200 }] },
    { at: norm(18), totalW: 210, devices: [{ id: 'd', loadW: 210 }] },
    { at: norm(18), totalW: 190, devices: [{ id: 'd', loadW: 190 }] },
    { at: holiday(18), totalW: 800, devices: [{ id: 'd', loadW: 800 }] },
    { at: holiday(18), totalW: 820, devices: [{ id: 'd', loadW: 820 }] },
    { at: holiday(18), totalW: 810, devices: [{ id: 'd', loadW: 810 }] }
  ];
  const now = new Date(2026, 6, 20, 17, 30, 0).getTime();
  const excluded = forecast.seasonalForecast({ samples, horizonHours: 1, now, excludeAnomalous: true });
  assert.ok(excluded.horizon[0].predictedW <= 220, 'holiday samples excluded from the baseline');
  delete process.env.LIKU_PERIPHERAL_FORECAST_MIN_SAMPLES;
  delete process.env.LIKU_PERIPHERAL_FORECAST_HOLIDAYS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('multi-hour caps are confidence-weighted (peak-leaning when low confidence)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  advisor.clear();
  const at = (h) => new Date(2026, 6, 20, h, 0, 0).toISOString();
  // Two devices at hours 20-21: 'steady' (high mean, low variance) and 'spiky'
  // (low mean, occasional high peaks) → low overall confidence for spiky.
  const mk = (h, steady, spiky) => ({ at: at(h), totalW: steady + spiky, devices: [{ id: 'steady', loadW: steady }, { id: 'spiky', loadW: spiky }] });
  const samples = [
    mk(20, 300, 50), mk(20, 300, 400), mk(20, 300, 60),
    mk(21, 300, 55), mk(21, 300, 380), mk(21, 300, 65)
  ];
  const sug = advisor.proposeMultiHourSchedule({ budgetW: 400, samples, horizonHours: 2, now: new Date(2026, 6, 20, 19, 30, 0).getTime() });
  assert.ok(sug && sug.type === 'multi-hour', 'multi-hour proposal created');
  assert.ok('confidence' in sug, 'proposal records confidence');
  const sumCaps = sug.devices.reduce((s, d) => s + d.proposedMaxW, 0);
  assert.ok(sumCaps <= sug.budgetW, 'confidence-weighted caps still sum within budget');
  advisor.clear();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('per-device auto-heal policy overrides the default ladder thresholds', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  actions.clear();
  actions.clearPolicies();
  // Tighten this device: reduce-schedule after just 1 occurrence.
  const set = actions.setPolicy('sensitive-dev', { 'reduce-schedule': 1 });
  assert.strictEqual(set.ok, true);
  assert.strictEqual(actions.getPolicy('sensitive-dev')['reduce-schedule'], 1, 'policy applied');
  actions.recordAnomaly({ device: 'sensitive-dev', type: 'spike' });
  const p = actions.proposeActions().find((a) => a.deviceId === 'sensitive-dev');
  assert.ok(p, 'a single anomaly proposes an action under the tightened policy');
  assert.strictEqual(p.action, 'reduce-schedule');
  // A different device still uses the default threshold (3) → no proposal at 1.
  actions.recordAnomaly({ device: 'normal-dev', type: 'spike' });
  assert.ok(!actions.proposeActions().find((a) => a.deviceId === 'normal-dev'), 'default device unaffected');
  actions.clear();
  actions.clearPolicies();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('confirming a reduce-schedule with multiple contributors creates a coordinated multi-device cap', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  const schedule = require('../src/main/peripherals/power-schedule');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  const hour = 20;
  const at = new Date(2026, 6, 20, hour, 0, 0).toISOString();
  const samples = [
    { at, totalW: 550, devices: [{ id: 'heater', loadW: 300 }, { id: 'oven', loadW: 250 }] },
    { at, totalW: 560, devices: [{ id: 'heater', loadW: 305 }, { id: 'oven', loadW: 255 }] }
  ];
  const res = advisor.createConfirmedMultiSchedule({ budgetW: 400, hour, samples });
  assert.strictEqual(res.ok, true, 'multi-device schedule created');
  assert.strictEqual(res.multiDevice, true);
  assert.strictEqual(res.devices.length, 2, 'both contributors capped');
  const sum = res.devices.reduce((s, d) => s + d.proposedMaxW, 0);
  assert.ok(sum <= 400, 'coordinated caps sum within budget');
  const heaterCap = res.devices.find((d) => d.deviceId === 'heater').proposedMaxW;
  assert.strictEqual(schedule.deviceScheduleW('heater', new Date(2026, 6, 20, hour, 0, 0)), heaterCap, 'heater rule enforced');
  // Single-contributor case → not multi-device.
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  const solo = advisor.createConfirmedMultiSchedule({ budgetW: 400, hour, samples: [{ at, totalW: 600, devices: [{ id: 'heater', loadW: 600 }] }] });
  assert.strictEqual(solo.ok, false, 'single contributor is not multi-device');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('PAL confirmAnomalyAction reduce-schedule prefers a multi-device coordinated cap', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  const history = require('../src/main/peripherals/power-history');
  const schedule = require('../src/main/peripherals/power-schedule');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  actions.clear();
  actions.clearPolicies();
  history.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  const nowHour = new Date().getHours();
  // Two contributors at the current hour jointly exceed a small budget.
  const seed = (h, a, b) => history.record({ at: new Date().toISOString(), totalW: a + b, budgetW: 100, overBudget: true, devices: [{ id: 'ha', loadW: a, active: true }, { id: 'hb', loadW: b, active: true }] });
  seed(nowHour, 120, 90);
  seed(nowHour, 125, 95);
  // Set a tiny budget so the joint draw exceeds it.
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  for (let i = 0; i < 3; i++) actions.recordAnomaly({ device: 'ha', type: 'over-budget' });
  const proposal = actions.proposeActions().find((a) => a.deviceId === 'ha');
  assert.strictEqual(proposal.action, 'reduce-schedule');
  const res = pal.confirmAnomalyAction(proposal.id);
  assert.strictEqual(res.ok, true);
  assert.ok(res.executed && res.executed.ok, 'a schedule was created on confirm');
  // Either a coordinated multi-device cap (preferred) or a single-device fallback.
  assert.ok(res.executed.multiDevice === true || (res.executed.rule && res.executed.rule.id), 'reduce-schedule applied');
  actions.clear();
  history.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('PAL exposes auto-heal policy accessors', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  actions.clearPolicies();
  const set = pal.setAutoHealPolicy('pal-pol-dev', { 'rotate-token': 4 });
  assert.strictEqual(set.ok, true, 'PAL sets a policy');
  const list = pal.getAutoHealPolicies();
  assert.ok(list.policies['pal-pol-dev'] && list.policies['pal-pol-dev']['rotate-token'] === 4, 'PAL lists the policy');
  actions.clearPolicies();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Phase 24 stores are flag-gated (no disk when disabled)', () => {
  delete process.env.LIKU_ENABLE_PERIPHERALS;
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  assert.strictEqual(actions.setPolicy('x', { 'reduce-schedule': 1 }).ok, false, 'policy set inert when disabled');
  assert.strictEqual(fs.existsSync(actions.POLICIES_FILE), false, 'no autoheal-policies.json when disabled');
});

test('env auto-heal policy sets a fleet-wide default via the * key', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_AUTOHEAL_POLICIES = JSON.stringify({ '*': { 'reduce-schedule': 2 } });
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  actions.clear();
  actions.clearPolicies();
  assert.strictEqual(actions.getPolicy('any-dev')['reduce-schedule'], 2, 'fleet default applied to all devices');
  actions.recordAnomaly({ device: 'edev', type: 'spike' });
  assert.ok(!actions.proposeActions().find((a) => a.deviceId === 'edev'), 'no proposal at 1 occurrence');
  actions.recordAnomaly({ device: 'edev', type: 'spike' });
  assert.ok(actions.proposeActions().find((a) => a.deviceId === 'edev'), 'proposal at 2 occurrences (env default)');
  actions.clear();
  actions.clearPolicies();
  delete process.env.LIKU_PERIPHERAL_AUTOHEAL_POLICIES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

// ── Phase 25: cross-host refinements + auto multi-hour + escalation cooldown + special-days ──

test('lease-aware pairing: only the lease holder may complete pairing (cluster)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p25pair');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const coordination = require('../src/main/peripherals/coordination');
  const { createDriverPairing } = require('../src/main/peripherals/driver-pairing');
  // Another node already holds the device lease.
  process.env.LIKU_NODE_ID = 'nodeOther';
  coordination.acquireLease('device:pd1', { ttlMs: 60000 }); // live now (real clock)
  // This node tries to pair the same device → refused (leased elsewhere).
  process.env.LIKU_NODE_ID = 'nodeMe';
  let commissioned = false;
  const pairing = createDriverPairing({
    loadDeviceConfig: () => [{ id: 'pd1', capabilities: ['on'] }],
    ensureManager: () => ({ pairing: { get: () => ({ state: 'paired' }) } }),
    getManager: () => ({ pairing: { get: () => ({ state: 'paired' }) } }),
    commission: () => { commissioned = true; }
  });
  const res = pairing.pair('pd1');
  assert.strictEqual(res.error, 'leased-elsewhere', 'pairing refused when lease held elsewhere');
  assert.strictEqual(commissioned, false, 'commission never ran');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('lease-aware pairing is unchanged on a single machine', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const { createDriverPairing } = require('../src/main/peripherals/driver-pairing');
  let commissioned = false;
  const pairing = createDriverPairing({
    loadDeviceConfig: () => [{ id: 'sm1', capabilities: ['on'] }],
    ensureManager: () => ({ pairing: { get: () => ({ state: 'paired' }) } }),
    getManager: () => ({ pairing: { get: () => ({ state: 'paired' }) } }),
    commission: () => { commissioned = true; }
  });
  const res = pairing.pair('sm1');
  assert.strictEqual(res.state, 'paired', 'single-machine pairing completes');
  assert.strictEqual(commissioned, true, 'commission ran');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('distributed cron dedup: claimOnce lets exactly one node fire a bucket', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p25cron');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const coordination = require('../src/main/peripherals/coordination');
  process.env.LIKU_NODE_ID = 'nodeA';
  const a = coordination.claimOnce('cron:lamp:on:2026-07-20T06:30', { ttlMs: 60000, now: 1000 });
  assert.strictEqual(a.claimed, true, 'first node claims the bucket');
  // A second (different) node cannot claim the same bucket.
  process.env.LIKU_NODE_ID = 'nodeB';
  const b = coordination.claimOnce('cron:lamp:on:2026-07-20T06:30', { ttlMs: 60000, now: 1100 });
  assert.strictEqual(b.claimed, false, 'second node is deduped');
  // The same node re-claiming (renewal) also does not double-fire.
  process.env.LIKU_NODE_ID = 'nodeA';
  const a2 = coordination.claimOnce('cron:lamp:on:2026-07-20T06:30', { ttlMs: 60000, now: 1200 });
  assert.strictEqual(a2.claimed, false, 'owner re-claim does not double-fire');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('cluster token GC expires stale records but keeps fresh ones', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p25gc');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const ts = require('../src/main/peripherals/token-store');
  const tdir = require('path').join(clusterDir, 'tokens');
  fs.mkdirSync(tdir, { recursive: true });
  const now = 10_000_000_000;
  fs.writeFileSync(require('path').join(tdir, 'stale.json'), JSON.stringify({ deviceId: 'stale', gen: 1, updatedAt: new Date(now - 8 * 24 * 3600 * 1000).toISOString() }));
  fs.writeFileSync(require('path').join(tdir, 'fresh.json'), JSON.stringify({ deviceId: 'fresh', gen: 1, updatedAt: new Date(now - 1 * 3600 * 1000).toISOString() }));
  const res = ts.sweepClusterTokens({ now });
  assert.ok(res.removed.includes('stale.json'), 'stale record GC-ed');
  assert.ok(!res.removed.includes('fresh.json'), 'fresh record kept');
  assert.strictEqual(fs.existsSync(require('path').join(tdir, 'fresh.json')), true);
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('pruneExpiredLeases removes only expired leases', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p25lease');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  process.env.LIKU_NODE_ID = 'nx';
  const coordination = require('../src/main/peripherals/coordination');
  coordination.acquireLease('device:live', { ttlMs: 100000, now: 5000 });
  coordination.acquireLease('device:dead', { ttlMs: 1000, now: 5000 });
  const res = coordination.pruneExpiredLeases(5000 + 2000); // dead expired, live alive
  assert.ok(res.removed.some((n) => n.includes('dead')), 'expired lease pruned');
  assert.ok(!res.removed.some((n) => n.includes('live')), 'live lease kept');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('auto-heal escalation cooldown holds a lower rung but never suppresses critical', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS = '100000';
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  actions.clear();
  const at = 20_000_000;
  const rec = (n, ts) => { for (let i = 0; i < n; i++) actions.recordAnomaly({ device: 'cd', type: 'spike' }, ts); };
  rec(3, at);
  let p = actions.proposeActions({}, at).find((a) => a.deviceId === 'cd');
  assert.strictEqual(p.action, 'reduce-schedule', 'first rung proposed immediately');
  // Enough occurrences to escalate to rotate-token, but within the cooldown → held.
  rec(3, at + 1000);
  p = actions.proposeActions({}, at + 1000).find((a) => a.deviceId === 'cd');
  assert.strictEqual(p.action, 'reduce-schedule', 'escalation held during cooldown');
  // After the cooldown elapses → escalates.
  p = actions.proposeActions({}, at + 200000).find((a) => a.deviceId === 'cd');
  assert.strictEqual(p.action, 'rotate-token', 'escalates after cooldown');
  // Critical rung (unpair) is NEVER suppressed by the cooldown.
  rec(4, at + 200500); // 10 total
  p = actions.proposeActions({}, at + 200600).find((a) => a.deviceId === 'cd');
  assert.strictEqual(p.action, 'unpair', 'critical rung surfaces immediately (cooldown never suppresses safety)');
  actions.clear();
  delete process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('auto multi-hour coordinated reduce-schedule caps a contiguous run (human-confirmed)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  const schedule = require('../src/main/peripherals/power-schedule');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  const at = (h) => new Date(2026, 6, 20, h, 0, 0).toISOString();
  const mk = (h, heater, oven) => ({ at: at(h), totalW: heater + oven, devices: [{ id: 'heater', loadW: heater }, { id: 'oven', loadW: oven }] });
  // Hours 20 + 21 both over budget, two contributors.
  const samples = [mk(20, 300, 250), mk(20, 305, 255), mk(20, 295, 245), mk(21, 300, 250), mk(21, 305, 255), mk(21, 295, 245)];
  const res = advisor.createConfirmedMultiHourSchedule({ budgetW: 400, samples, horizonHours: 2, now: new Date(2026, 6, 20, 19, 30, 0).getTime() });
  assert.strictEqual(res.ok, true, 'multi-hour reduce created');
  assert.strictEqual(res.multiHour, true);
  assert.ok(res.hours.length >= 2, 'covers a contiguous run');
  const sum = res.devices.reduce((s, d) => s + d.proposedMaxW, 0);
  assert.ok(sum <= 400, 'coordinated caps sum within budget');
  const heaterCap = res.devices.find((d) => d.deviceId === 'heater').proposedMaxW;
  assert.strictEqual(schedule.deviceScheduleW('heater', new Date(2026, 6, 20, 20, 0, 0)), heaterCap, 'hour 20 capped');
  assert.strictEqual(schedule.deviceScheduleW('heater', new Date(2026, 6, 20, 21, 0, 0)), heaterCap, 'hour 21 capped (whole window)');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('data-driven special-day detection flags an unusually low/high day', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const forecast = require('../src/main/peripherals/power-forecast');
  const day = (d, w) => ({ at: new Date(2026, 6, d, 12, 0, 0).toISOString(), totalW: w, devices: [{ id: 'd', loadW: w }] });
  // Five normal days ~500W, one very low day ~50W.
  const samples = [day(10, 500), day(11, 510), day(12, 490), day(13, 505), day(14, 495), day(15, 50)];
  const res = forecast.detectSpecialDays({ samples, sigma: 1.5 });
  assert.ok(res.dates.length >= 1, 'a special day detected');
  assert.strictEqual(res.dates[0].kind, 'low', 'the low-power day is flagged');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('PAL sweepCluster + getSpecialDays accessors are safe (single-machine)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  const sweep = pal.sweepCluster();
  assert.strictEqual(sweep.enabled, true);
  assert.ok(sweep.leases && Array.isArray(sweep.leases.removed), 'lease prune returns a result');
  const sd = pal.getSpecialDays({ samples: [] });
  assert.strictEqual(sd.enabled, true);
  assert.ok(Array.isArray(sd.dates), 'special-days accessor returns an array');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Phase 25 cluster features are inert on a single machine (backward compatible)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const coordination = require('../src/main/peripherals/coordination');
  const ts = require('../src/main/peripherals/token-store');
  assert.strictEqual(coordination.claimOnce('anything').claimed, true, 'claimOnce always true single-machine');
  assert.deepStrictEqual(coordination.pruneExpiredLeases().removed, [], 'no leases to prune single-machine');
  assert.deepStrictEqual(ts.sweepClusterTokens().removed, [], 'no cluster tokens single-machine');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

// ── Phase 26: cross-host maturation + lock observability + token improvements ──

test('lease renewal on execute keeps device ownership alive (cluster)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p26renew');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  process.env.LIKU_NODE_ID = 'renewNode';
  const coordination = require('../src/main/peripherals/coordination');
  // Acquire a short lease, then renew it via the same primitive execute() uses.
  const a = coordination.acquireLease('device:rn1', { ttlMs: 1000, now: 5000 });
  assert.strictEqual(a.granted, true);
  // Just before expiry, a renewal (execute path) extends the TTL.
  const r = coordination.renewLease('device:rn1', { ttlMs: 10000, now: 5900 });
  assert.strictEqual(r.granted, true, 'owner renews its lease');
  // After the ORIGINAL expiry, the device is still owned (renewal extended it).
  assert.strictEqual(coordination.canAct('device:rn1', 6500), true, 'still owned after original TTL');
  const holder = coordination.whoHolds('device:rn1', 6500);
  assert.ok(holder && holder.nodeId === 'renewNode', 'ownership retained during active use');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('coordination shared-state records are visible + swept across the cluster', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p26shared');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  process.env.LIKU_NODE_ID = 'shareNode';
  const coordination = require('../src/main/peripherals/coordination');
  assert.strictEqual(coordination.putShared('proposals', 'multi:20', { id: 'x', status: 'proposed' }), true);
  const rec = coordination.getShared('proposals', 'multi:20');
  assert.ok(rec && rec.status === 'proposed' && rec.nodeId === 'shareNode', 'shared record written + stamped');
  assert.strictEqual(coordination.listShared('proposals').length, 1, 'listed');
  // Sweep by TTL removes stale entries.
  const removed = coordination.sweepShared('proposals', -1).removed; // ttl -1 → everything stale
  assert.ok(removed.length >= 1, 'stale shared record swept');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('distributed proposal dedup: a node skips a proposal another node already opened', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p26dedup');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const coordination = require('../src/main/peripherals/coordination');
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  advisor.clear();
  // Another node has already published an open multi-device proposal for hour 20.
  process.env.LIKU_NODE_ID = 'nodeOther';
  coordination.putShared('proposals', 'multi:20', { id: 'other-1', type: 'multi-device', status: 'proposed', deviceId: null });
  // This node evaluates the same breach → must NOT create a duplicate.
  process.env.LIKU_NODE_ID = 'nodeMe';
  const at = new Date(2026, 6, 20, 20, 0, 0).toISOString();
  const samples = [
    { at, totalW: 550, devices: [{ id: 'heater', loadW: 300 }, { id: 'oven', loadW: 250 }] },
    { at, totalW: 560, devices: [{ id: 'heater', loadW: 305 }, { id: 'oven', loadW: 255 }] }
  ];
  const res = advisor.proposeMultiDeviceSchedule({ budgetW: 400, hour: 20, samples });
  assert.strictEqual(res, null, 'no duplicate proposal (deduped against the peer node)');
  advisor.clear();
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('cluster anomaly aggregation merges compact summaries from multiple nodes', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p26agg');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const coordination = require('../src/main/peripherals/coordination');
  const clusterAnomaly = require('../src/main/peripherals/cluster-anomaly');
  // nodeA and nodeB each publish a compact summary.
  process.env.LIKU_NODE_ID = 'nodeA';
  clusterAnomaly.publish({ anomalies: [{ type: 'spike', attributedDevice: 'heater', valueW: 900, at: new Date().toISOString() }], devices: [{ id: 'heater', loadW: 900 }], totalW: 900, budgetW: 500 });
  process.env.LIKU_NODE_ID = 'nodeB';
  clusterAnomaly.publish({ anomalies: [{ type: 'over-budget', attributedDevice: 'oven', valueW: 700, at: new Date().toISOString() }], devices: [{ id: 'oven', loadW: 700 }], totalW: 700, budgetW: 500 });
  const agg = clusterAnomaly.aggregate();
  assert.strictEqual(agg.nodes, 2, 'aggregates both nodes');
  assert.ok(agg.anomalies.length >= 2, 'fleet-wide anomalies merged');
  assert.ok(agg.perDeviceW.heater === 900 && agg.perDeviceW.oven === 700, 'per-device draw summed across nodes');
  assert.ok(agg.topDevices[0].id === 'heater', 'top device is the biggest fleet-wide draw');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('cluster anomaly aggregation drops stale summaries (no inconsistent decisions)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p26stale');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const coordination = require('../src/main/peripherals/coordination');
  const clusterAnomaly = require('../src/main/peripherals/cluster-anomaly');
  // Write a summary with an old updatedAt directly.
  const dir = require('path').join(clusterDir, 'anomaly-summary');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(require('path').join(dir, 'oldnode.json'), JSON.stringify({ nodeId: 'oldnode', updatedAt: new Date(Date.now() - 3600000).toISOString(), anomalies: [], topDevices: [], totalW: 10 }));
  const agg = clusterAnomaly.aggregate({ maxAgeMs: 60000 }); // 1 min freshness
  assert.strictEqual(agg.nodes, 0, 'stale summary excluded');
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('lock file trends + contention alerts flag a hot file (pure observation)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const atomic = require('../src/shared/atomic-file');
  const lh = require('../src/main/peripherals/lock-history');
  lh.clear();
  atomic.resetLockMetrics();
  // Generate acquires on one file, snapshot, then check trends + alerts.
  const hot = require('path').join(TMP_HOME, 'hot-lock.json');
  for (let i = 0; i < 5; i++) atomic.atomicWriteFileSync(hot, `{"i":${i}}`);
  lh.record();
  const ft = lh.fileTrends({ limit: 10 });
  assert.ok(ft.files.some((f) => f.file === 'hot-lock.json'), 'per-file trend present');
  const al = lh.alerts({ acquireThreshold: 3, rateThreshold: 1 });
  assert.ok(al.alerts.some((a) => a.file === 'hot-lock.json'), 'hot file exceeds acquire threshold → alert');
  lh.clear();
  atomic.resetLockMetrics();
  try { fs.rmSync(hot); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('per-action token generation invalidates only that action', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const ts = require('../src/main/peripherals/token-store');
  ts.clear();
  ts.onPair('pa-gen', { actions: ['on', 'off'] });
  const onTok = ts.issueActionToken('pa-gen', 'on').token;
  const offTok = ts.issueActionToken('pa-gen', 'off').token;
  assert.strictEqual(ts.verifyDeviceToken('pa-gen', 'on', onTok).ok, true);
  assert.strictEqual(ts.verifyDeviceToken('pa-gen', 'off', offTok).ok, true);
  // Rotate ONLY the 'on' action's generation.
  const r = ts.rotateAction('pa-gen', 'on');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(ts.verifyDeviceToken('pa-gen', 'on', onTok).ok, false, 'old on-token invalidated');
  assert.strictEqual(ts.verifyDeviceToken('pa-gen', 'off', offTok).ok, true, 'off-token still valid (untouched)');
  // A fresh on-token (new action gen) verifies again.
  const onTok2 = ts.issueActionToken('pa-gen', 'on').token;
  assert.strictEqual(ts.verifyDeviceToken('pa-gen', 'on', onTok2).ok, true, 're-issued on-token valid');
  ts.clear();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('identity rotation invalidates outstanding tokens (human-gated hygiene)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const ts = require('../src/main/peripherals/token-store');
  ts.clear();
  ts.onPair('id-rot', { actions: ['unlock'] });
  const tok = ts.issueActionToken('id-rot', 'unlock').token;
  assert.strictEqual(ts.verifyDeviceToken('id-rot', 'unlock', tok).ok, true);
  const before = ts.status('id-rot').identityFp;
  const r = ts.rotateIdentity('id-rot');
  assert.strictEqual(r.ok, true);
  assert.notStrictEqual(r.identityFp, before, 'identity fingerprint changed');
  assert.strictEqual(ts.verifyDeviceToken('id-rot', 'unlock', tok).ok, false, 'old token invalidated by identity rotation');
  ts.clear();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Phase 26 cluster features are inert on a single machine (backward compatible)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const coordination = require('../src/main/peripherals/coordination');
  const clusterAnomaly = require('../src/main/peripherals/cluster-anomaly');
  assert.strictEqual(coordination.putShared('proposals', 'k', { status: 'proposed' }), false, 'putShared inert single-machine');
  assert.deepStrictEqual(coordination.listShared('proposals'), [], 'listShared empty single-machine');
  assert.strictEqual(clusterAnomaly.publish({ anomalies: [] }), false, 'cluster anomaly publish inert');
  assert.strictEqual(clusterAnomaly.aggregate().nodes, 0, 'aggregate empty single-machine');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('PAL exposes cluster-anomaly + lock-alert + per-action token accessors', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  const ts = require('../src/main/peripherals/token-store');
  ts.clear();
  const ca = pal.getClusterAnomalies();
  assert.strictEqual(ca.enabled, true);
  assert.strictEqual(ca.nodes, 0, 'single-machine → no cluster anomalies');
  const la = pal.getLockAlerts({ acquireThreshold: 1, rateThreshold: 0 });
  assert.strictEqual(la.enabled, true);
  assert.ok(Array.isArray(la.alerts), 'lock alerts accessor returns an array');
  ts.onPair('pal-ag', { actions: ['on'] });
  const r = pal.rotateActionToken('pal-ag', 'on');
  assert.strictEqual(r.ok, true, 'PAL rotates a per-action generation');
  assert.strictEqual(r.actionGen, 2, 'action generation bumped');
  ts.clear();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('PAL sweepCluster GCs shared proposal/action/anomaly state (cluster)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p26sweepall');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  process.env.LIKU_NODE_ID = 'sweepNode';
  const coordination = require('../src/main/peripherals/coordination');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  coordination.putShared('proposals', 'old:1', { status: 'confirmed' });
  coordination.putShared('anomaly-actions', 'old:2', { status: 'confirmed' });
  const res = pal.sweepCluster({ now: Date.now() + 2 * 24 * 3600 * 1000 }); // 2 days ahead → both stale
  assert.strictEqual(res.enabled, true);
  assert.ok(res.shared && res.shared.proposals.length >= 1, 'stale shared proposal GC-ed');
  assert.ok(res.shared.actions.length >= 1, 'stale shared action GC-ed');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

// ── Phase 27: distributed confirmed schedules + task visibility + lock persistence ──

test('confirmed schedules are visible + respected across the cluster', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p27sched');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const coordination = require('../src/main/peripherals/coordination');
  const schedule = require('../src/main/peripherals/power-schedule');
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  // Node A confirms a restrict-only schedule for heater 20:00→21:00 ≤ 150W.
  process.env.LIKU_NODE_ID = 'nodeA';
  const r = advisor.createConfirmedSchedule('heater', { maxW: 150, fromHour: 20, toHour: 21 });
  assert.strictEqual(r.ok, true);
  assert.ok(coordination.getShared('schedules', 'heater:20:21'), 'confirmed rule mirrored to the cluster');
  // Node B (no local confirmed file) must RESPECT the peer-confirmed schedule.
  process.env.LIKU_NODE_ID = 'nodeB';
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ } // node B has no local rule
  assert.strictEqual(schedule.deviceScheduleW('heater', new Date(2026, 6, 20, 20, 30, 0)), 150, 'peer-confirmed schedule respected fleet-wide');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('a node does not re-propose a schedule a peer already confirmed', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p27nodup');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const coordination = require('../src/main/peripherals/coordination');
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  advisor.clear();
  // A peer already CONFIRMED the multi-device proposal for hour 20.
  process.env.LIKU_NODE_ID = 'peer';
  coordination.putShared('proposals', 'multi:20', { id: 'peer-1', type: 'multi-device', status: 'confirmed' });
  // This node evaluates the same breach → must NOT re-propose.
  process.env.LIKU_NODE_ID = 'me';
  const at = new Date(2026, 6, 20, 20, 0, 0).toISOString();
  const samples = [
    { at, totalW: 550, devices: [{ id: 'heater', loadW: 300 }, { id: 'oven', loadW: 250 }] },
    { at, totalW: 560, devices: [{ id: 'heater', loadW: 305 }, { id: 'oven', loadW: 255 }] }
  ];
  assert.strictEqual(advisor.proposeMultiDeviceSchedule({ budgetW: 400, hour: 20, samples }), null, 'no re-proposal after peer confirmation');
  advisor.clear();
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('confirmed schedules stay single-machine when cluster is off (backward compatible)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const schedule = require('../src/main/peripherals/power-schedule');
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  const r = advisor.createConfirmedSchedule('lamp', { maxW: 100, fromHour: 10, toHour: 12 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(schedule.deviceScheduleW('lamp', new Date(2026, 6, 20, 10, 30, 0)), 100, 'local schedule works with no cluster');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('cluster task visibility: a peer task is visible + status mirrorable (advisory)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p27tasks');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const clusterTasks = require('../src/main/peripherals/cluster-tasks');
  // A peer publishes a task.
  process.env.LIKU_NODE_ID = 'peerNode';
  clusterTasks.publishTask({ id: 'task-1', dedupeKey: 'heater:power:spike', type: 'peripheral-response', device: { id: 'heater' }, priority: 'medium', status: 'pending-review', source: 'power-anomaly' });
  // This node can SEE it + detect a peer is already handling the condition.
  process.env.LIKU_NODE_ID = 'meNode';
  assert.strictEqual(clusterTasks.listTasks().length, 1, 'peer task visible');
  const peer = clusterTasks.peerHasOpenTaskFor('heater:power:spike');
  assert.ok(peer && peer.id === 'task-1', 'peer detected as already handling the condition');
  // Status change is mirrorable.
  assert.strictEqual(clusterTasks.updateTaskStatus('task-1', 'resolved'), true);
  assert.strictEqual(clusterTasks.listTasks()[0].status, 'resolved', 'status change mirrored');
  // After resolve, the peer no longer counts as "open" for the condition.
  assert.strictEqual(clusterTasks.peerHasOpenTaskFor('heater:power:spike'), null, 'resolved task no longer blocks');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('cluster task visibility is inert on a single machine + is not an actuation path', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const clusterTasks = require('../src/main/peripherals/cluster-tasks');
  assert.strictEqual(clusterTasks.publishTask({ id: 'x' }), false, 'publish inert single-machine');
  assert.deepStrictEqual(clusterTasks.listTasks(), [], 'list empty single-machine');
  assert.strictEqual(clusterTasks.peerHasOpenTaskFor('k'), null, 'no peer single-machine');
  // The module exposes NO execute/actuate surface — only publish/list/status.
  assert.strictEqual(typeof clusterTasks.execute, 'undefined', 'no execute path exists');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('lock history survives a process restart + still yields trends + alerts', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const atomic = require('../src/shared/atomic-file');
  const lh = require('../src/main/peripherals/lock-history');
  lh.clear();
  atomic.resetLockMetrics();
  // Generate activity on a file, then persist two snapshots to lock-history.jsonl.
  const hot = require('path').join(TMP_HOME, 'restart-lock.json');
  for (let i = 0; i < 6; i++) atomic.atomicWriteFileSync(hot, `{"i":${i}}`);
  lh.record();
  for (let i = 0; i < 4; i++) atomic.atomicWriteFileSync(hot, `{"j":${i}}`);
  lh.record();
  // Simulate a RESTART: in-memory counters reset, but the jsonl persists on disk.
  atomic.resetLockMetrics();
  const snaps = lh.query({ limit: 50 });
  assert.ok(snaps.length >= 2, 'snapshots persisted across the (simulated) restart');
  const ft = lh.fileTrends({ limit: 50 });
  assert.ok(ft.files.some((f) => f.file === 'restart-lock.json'), 'per-file trend recovered after restart');
  const al = lh.alerts({ acquireThreshold: 5, rateThreshold: 1 });
  assert.ok(al.alerts.some((a) => a.file === 'restart-lock.json'), 'contention alert recovered after restart');
  lh.clear();
  atomic.resetLockMetrics();
  try { fs.rmSync(hot); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('PAL exposes cluster task/notification accessors + status update', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p27pal');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  process.env.LIKU_NODE_ID = 'palNode';
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  const clusterTasks = require('../src/main/peripherals/cluster-tasks');
  clusterTasks.publishTask({ id: 'pt-1', dedupeKey: 'oven:power:over-budget', device: { id: 'oven' }, priority: 'high', status: 'pending-review' });
  const ct = pal.getClusterTasks();
  assert.strictEqual(ct.enabled, true);
  assert.ok(ct.tasks.length >= 1, 'PAL lists cluster tasks');
  const upd = pal.updateClusterTaskStatus('pt-1', 'acknowledged');
  assert.strictEqual(upd.ok, true, 'PAL mirrors a status change');
  assert.strictEqual(pal.getClusterTasks().tasks.find((t) => t.id === 'pt-1').status, 'acknowledged');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('PAL sweepCluster GCs stale shared schedules + tasks + notifications', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p27sweep');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  process.env.LIKU_NODE_ID = 'swNode';
  const coordination = require('../src/main/peripherals/coordination');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  coordination.putShared('schedules', 'heater:20:21', { id: 'heater', fromHour: 20, toHour: 21, maxW: 150 });
  coordination.putShared('tasks', 'tk-1', { id: 'tk-1', status: 'resolved' });
  coordination.putShared('notifications', 'nt-1', { id: 'nt-1', status: 'acknowledged' });
  const res = pal.sweepCluster({ now: Date.now() + 40 * 24 * 3600 * 1000 }); // 40 days ahead → all stale
  assert.ok(res.shared.schedules.length >= 1, 'stale cluster schedule GC-ed');
  assert.ok(res.shared.tasks.length >= 1, 'stale cluster task GC-ed');
  assert.ok(res.shared.notifications.length >= 1, 'stale cluster notification GC-ed');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

// ── Phase 28: confirmed-schedule tombstones + distributed task ownership ──

test('confirmed-schedule removal tombstones it fleet-wide (peers stop respecting it)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p28tomb');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const coordination = require('../src/main/peripherals/coordination');
  const schedule = require('../src/main/peripherals/power-schedule');
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  // Node A confirms a schedule → mirrored + respected.
  process.env.LIKU_NODE_ID = 'nodeA';
  advisor.createConfirmedSchedule('heater', { maxW: 150, fromHour: 20, toHour: 21 });
  assert.strictEqual(schedule.deviceScheduleW('heater', new Date(2026, 6, 20, 20, 30, 0)), 150, 'schedule active before removal');
  // Node A removes it → tombstone written, active mirror deleted.
  const rem = advisor.removeConfirmedSchedule('heater', { fromHour: 20, toHour: 21 });
  assert.strictEqual(rem.ok, true);
  assert.ok(rem.removed.includes('heater:20:21'), 'the rule key was tombstoned');
  assert.ok(coordination.getShared('schedule-tombstones', 'heater:20:21'), 'tombstone visible fleet-wide');
  assert.strictEqual(coordination.getShared('schedules', 'heater:20:21'), null, 'active mirror deleted');
  // Node A no longer applies it.
  assert.strictEqual(schedule.deviceScheduleW('heater', new Date(2026, 6, 20, 20, 30, 0)), null, 'removed schedule no longer applied on nodeA');
  // Node B (which would only see the shared store) also stops respecting it.
  process.env.LIKU_NODE_ID = 'nodeB';
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  assert.strictEqual(schedule.deviceScheduleW('heater', new Date(2026, 6, 20, 20, 30, 0)), null, 'peer respects the tombstone');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('a node can tombstone a peer-confirmed schedule it never held locally', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p28peertomb');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const coordination = require('../src/main/peripherals/coordination');
  const schedule = require('../src/main/peripherals/power-schedule');
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  // A peer confirmed a schedule (only the shared mirror exists here).
  coordination.putShared('schedules', 'oven:18:19', { id: 'oven', fromHour: 18, toHour: 19, maxW: 200 });
  assert.strictEqual(schedule.deviceScheduleW('oven', new Date(2026, 6, 20, 18, 30, 0)), 200, 'peer schedule respected');
  // This node removes by deviceId (no local copy) → tombstones the cluster rule.
  process.env.LIKU_NODE_ID = 'remover';
  const rem = advisor.removeConfirmedSchedule('oven');
  assert.ok(rem.ok && rem.removed.includes('oven:18:19'), 'peer rule tombstoned by deviceId');
  assert.strictEqual(schedule.deviceScheduleW('oven', new Date(2026, 6, 20, 18, 30, 0)), null, 'peer rule no longer applied');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('schedule removal is local-only + byte-compatible when cluster is off', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const schedule = require('../src/main/peripherals/power-schedule');
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  advisor.createConfirmedSchedule('lamp', { maxW: 100, fromHour: 10, toHour: 12 });
  assert.strictEqual(schedule.deviceScheduleW('lamp', new Date(2026, 6, 20, 10, 30, 0)), 100);
  const rem = advisor.removeConfirmedSchedule('lamp', { fromHour: 10, toHour: 12 });
  assert.strictEqual(rem.ok, true);
  assert.strictEqual(schedule.deviceScheduleW('lamp', new Date(2026, 6, 20, 10, 30, 0)), null, 'removed locally with no cluster');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('tombstones are GC-able (sweepShared removes stale tombstones)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p28tombgc');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  process.env.LIKU_NODE_ID = 'gcNode';
  const coordination = require('../src/main/peripherals/coordination');
  coordination.putShared('schedule-tombstones', 'heater:20:21', { id: 'heater', fromHour: 20, toHour: 21, tombstonedAt: new Date().toISOString() });
  const removed = coordination.sweepShared('schedule-tombstones', -1).removed; // ttl -1 → stale
  assert.ok(removed.includes('heater_20_21.json') || removed.length >= 1, 'stale tombstone GC-ed');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('distributed task claim: exactly one node owns a task; peers see it owned', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p28claim');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const clusterTasks = require('../src/main/peripherals/cluster-tasks');
  // Node A publishes + claims a task.
  process.env.LIKU_NODE_ID = 'nodeA';
  clusterTasks.publishTask({ id: 'ct-claim', dedupeKey: 'heater:power:spike', device: { id: 'heater' }, priority: 'high', status: 'pending-review' });
  const a = clusterTasks.claimTask('ct-claim', { ttlMs: 60000 });
  assert.strictEqual(a.claimed, true, 'nodeA claims the task');
  assert.strictEqual(clusterTasks.taskOwner('ct-claim'), 'nodeA', 'owner recorded');
  // Node B cannot claim it + sees it owned by a peer.
  process.env.LIKU_NODE_ID = 'nodeB';
  const b = clusterTasks.claimTask('ct-claim', { ttlMs: 60000 });
  assert.strictEqual(b.claimed, false, 'nodeB cannot double-claim');
  assert.strictEqual(b.owner, 'nodeA', 'nodeB sees the peer owner');
  assert.strictEqual(clusterTasks.isOwnedByPeer('ct-claim'), true, 'peer ownership visible');
  // Node A releases → now claimable again.
  process.env.LIKU_NODE_ID = 'nodeA';
  assert.strictEqual(clusterTasks.releaseTask('ct-claim').released, true, 'owner releases cleanly');
  process.env.LIKU_NODE_ID = 'nodeB';
  assert.strictEqual(clusterTasks.claimTask('ct-claim', { ttlMs: 60000 }).claimed, true, 'released task is re-claimable');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('task claim is inert single-machine + never an actuation path', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const clusterTasks = require('../src/main/peripherals/cluster-tasks');
  assert.strictEqual(clusterTasks.claimTask('x').claimed, true, 'single-machine always claims locally');
  assert.strictEqual(clusterTasks.taskOwner('x'), null, 'no cluster owner single-machine');
  assert.strictEqual(clusterTasks.isOwnedByPeer('x'), false, 'no peer single-machine');
  // No execute/actuate surface exists on the claim layer.
  assert.strictEqual(typeof clusterTasks.execute, 'undefined');
  assert.strictEqual(typeof clusterTasks.perform, 'undefined');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('fleet rotate-all uses a quorum claim so only one node rotates (human-gated)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p28quorum');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const coordination = require('../src/main/peripherals/coordination');
  const ts = require('../src/main/peripherals/token-store');
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  ts.clear();
  actions.clear();
  ts.onPair('q-a', { actions: ['on'] });
  ts.onPair('q-b', { actions: ['on'] });
  // A PEER already claimed the fleet rotate-all lease.
  process.env.LIKU_NODE_ID = 'peerHolder';
  coordination.acquireLease('task:fleet:rotate-all', { ttlMs: 60000 });
  // This node confirms rotate-all → claim denied → does NOT rotate.
  process.env.LIKU_NODE_ID = 'meNode';
  for (const dev of ['q-a', 'q-b', 'q-c']) for (let i = 0; i < 3; i++) actions.recordAnomaly({ device: dev, type: 'spike' });
  const fleet = actions.proposeFleetAction();
  const res = pal.confirmAnomalyAction(fleet.id);
  assert.strictEqual(res.ok, true, 'confirmation recorded (human gate honored)');
  assert.strictEqual(res.executed.ok, false, 'rotation NOT performed (peer holds the claim)');
  assert.strictEqual(res.executed.reason, 'claimed-by-peer');
  assert.strictEqual(ts.status('q-a').gen, 1, 'tokens NOT rotated by this node');
  ts.clear();
  actions.clear();
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('PAL exposes schedule-remove + task-claim accessors', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p28pal');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  process.env.LIKU_NODE_ID = 'palN';
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  const schedule = require('../src/main/peripherals/power-schedule');
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  advisor.createConfirmedSchedule('fan', { maxW: 80, fromHour: 14, toHour: 16 });
  assert.ok(pal.getConfirmedSchedules().schedules.length >= 1, 'PAL lists confirmed schedules');
  const rm = pal.removeConfirmedSchedule('fan', { fromHour: 14, toHour: 16 });
  assert.strictEqual(rm.ok, true, 'PAL removes + tombstones');
  assert.strictEqual(schedule.deviceScheduleW('fan', new Date(2026, 6, 20, 14, 30, 0)), null, 'removed schedule not applied');
  const cl = pal.claimClusterTask('pal-task');
  assert.strictEqual(cl.claimed, true);
  assert.strictEqual(pal.getClusterTaskOwner('pal-task').owner, 'palN');
  assert.strictEqual(pal.releaseClusterTask('pal-task').released, true);
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('a fresh (non-stale) tombstone still hides the rule; TTL-expired tombstone is ignored', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_CLUSTER_TOMBSTONE_TTL_MS = '1000'; // 1s freshness
  const clusterDir = require('path').join(TMP_HOME, 'p28tombttl');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  process.env.LIKU_NODE_ID = 'ttlNode';
  const coordination = require('../src/main/peripherals/coordination');
  const schedule = require('../src/main/peripherals/power-schedule');
  // Active rule + a FRESH tombstone → rule hidden.
  coordination.putShared('schedules', 'heater:20:21', { id: 'heater', fromHour: 20, toHour: 21, maxW: 150 });
  coordination.putShared('schedule-tombstones', 'heater:20:21', { id: 'heater', fromHour: 20, toHour: 21, tombstonedAt: new Date().toISOString() });
  assert.strictEqual(schedule.deviceScheduleW('heater', new Date(2026, 6, 20, 20, 30, 0)), null, 'fresh tombstone hides the rule');
  // Age the tombstone file beyond the 1s TTL → tombstone ignored → rule respected again
  // (represents a re-confirm scenario where the active rule outlives an old tombstone).
  const tPath = require('path').join(clusterDir, 'schedule-tombstones', 'heater_20_21.json');
  const old = new Date(Date.now() - 5000);
  try { fs.utimesSync(tPath, old, old); } catch { /* platform best-effort */ }
  // Also stamp updatedAt in the past so the maxAge filter drops it.
  try { const rec = JSON.parse(fs.readFileSync(tPath, 'utf-8')); rec.updatedAt = old.toISOString(); fs.writeFileSync(tPath, JSON.stringify(rec)); } catch { /* ignore */ }
  assert.strictEqual(schedule.deviceScheduleW('heater', new Date(2026, 6, 20, 20, 30, 0)), 150, 'TTL-expired tombstone ignored → active rule respected');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  delete process.env.LIKU_PERIPHERAL_CLUSTER_TOMBSTONE_TTL_MS;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('task claim renewal extends ownership past the original TTL', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p28renew');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  process.env.LIKU_NODE_ID = 'owner';
  const coordination = require('../src/main/peripherals/coordination');
  const clusterTasks = require('../src/main/peripherals/cluster-tasks');
  const a = clusterTasks.claimTask('rtask', { ttlMs: 1000, now: 5000 });
  assert.strictEqual(a.claimed, true);
  // Renew before expiry extends the TTL.
  const r = clusterTasks.renewClaim('rtask', { ttlMs: 10000, now: 5900 });
  assert.strictEqual(r.claimed, true, 'owner renews the claim');
  // After the ORIGINAL TTL, still owned (renewal extended it).
  assert.strictEqual(coordination.whoHolds('task:rtask', 6500).nodeId, 'owner', 'ownership retained after original TTL');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

// ── Phase 29: distributed task assignment/handoff + auto-renew + schedule expiry ──

test('task assignment records intent + the target node sees it in its inbox', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p29assign');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const clusterTasks = require('../src/main/peripherals/cluster-tasks');
  process.env.LIKU_NODE_ID = 'nodeA';
  clusterTasks.publishTask({ id: 'ct-asg', dedupeKey: 'heater:power:spike', device: { id: 'heater' }, priority: 'high', status: 'pending-review' });
  const a = clusterTasks.assignTask('ct-asg', 'nodeB');
  assert.strictEqual(a.assigned, true, 'assignment recorded');
  assert.strictEqual(clusterTasks.assignmentFor('ct-asg'), 'nodeB', 'assignee readable');
  // nodeB sees the assignment in its inbox; nodeA does not.
  process.env.LIKU_NODE_ID = 'nodeB';
  assert.ok(clusterTasks.myAssignments().some((r) => r.taskId === 'ct-asg'), 'target node inbox includes the task');
  process.env.LIKU_NODE_ID = 'nodeA';
  assert.ok(!clusterTasks.myAssignments().some((r) => r.taskId === 'ct-asg'), 'assigner inbox excludes it');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('task handoff transfers ownership cleanly (owner releases, target claims)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p29handoff');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const clusterTasks = require('../src/main/peripherals/cluster-tasks');
  process.env.LIKU_NODE_ID = 'nodeA';
  clusterTasks.publishTask({ id: 'ct-ho', dedupeKey: 'oven:power:sustained', device: { id: 'oven' }, priority: 'high', status: 'pending-review' });
  assert.strictEqual(clusterTasks.claimTask('ct-ho', { ttlMs: 60000 }).claimed, true, 'nodeA owns it');
  const h = clusterTasks.handoffTask('ct-ho', 'nodeB');
  assert.strictEqual(h.handedOff, true, 'handoff succeeds');
  assert.strictEqual(h.released, true, 'owner lease released on handoff');
  assert.strictEqual(clusterTasks.assignmentFor('ct-ho'), 'nodeB', 'reassigned to nodeB');
  assert.strictEqual(clusterTasks.taskOwner('ct-ho'), null, 'no owner until re-claimed');
  // nodeB now claims it cleanly (no double ownership).
  process.env.LIKU_NODE_ID = 'nodeB';
  assert.strictEqual(clusterTasks.claimTask('ct-ho', { ttlMs: 60000 }).claimed, true, 'target claims the handed-off task');
  assert.strictEqual(clusterTasks.taskOwner('ct-ho'), 'nodeB', 'ownership transferred');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('task handoff is owner-only (a non-owner cannot hand off)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p29owneronly');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const clusterTasks = require('../src/main/peripherals/cluster-tasks');
  process.env.LIKU_NODE_ID = 'nodeA';
  clusterTasks.publishTask({ id: 'ct-own', device: { id: 'fan' }, status: 'pending-review' });
  assert.strictEqual(clusterTasks.claimTask('ct-own', { ttlMs: 60000 }).claimed, true);
  // nodeB tries to hand off a task it does NOT own → refused.
  process.env.LIKU_NODE_ID = 'nodeB';
  const h = clusterTasks.handoffTask('ct-own', 'nodeC');
  assert.strictEqual(h.handedOff, false, 'non-owner cannot hand off');
  assert.strictEqual(h.reason, 'not-owner');
  assert.strictEqual(h.owner, 'nodeA', 'true owner reported');
  assert.strictEqual(clusterTasks.taskOwner('ct-own'), 'nodeA', 'ownership unchanged');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('task handoff to the open pool releases the claim + clears assignment (re-claimable)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p29pool');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const clusterTasks = require('../src/main/peripherals/cluster-tasks');
  process.env.LIKU_NODE_ID = 'nodeA';
  clusterTasks.publishTask({ id: 'ct-pool', device: { id: 'pump' }, status: 'pending-review' });
  clusterTasks.assignTask('ct-pool', 'nodeA');
  assert.strictEqual(clusterTasks.claimTask('ct-pool', { ttlMs: 60000 }).claimed, true);
  const h = clusterTasks.handoffTask('ct-pool', null); // release to open pool
  assert.strictEqual(h.handedOff, true);
  assert.strictEqual(h.to, null, 'no specific assignee');
  assert.strictEqual(clusterTasks.assignmentFor('ct-pool'), null, 'assignment cleared');
  assert.strictEqual(clusterTasks.taskOwner('ct-pool'), null, 'no owner (open pool)');
  process.env.LIKU_NODE_ID = 'nodeB';
  assert.strictEqual(clusterTasks.claimTask('ct-pool', { ttlMs: 60000 }).claimed, true, 'any node may claim a pooled task');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('auto-renew keeps a legitimate claim alive past the original TTL', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p29autorenew');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  process.env.LIKU_NODE_ID = 'worker';
  const coordination = require('../src/main/peripherals/coordination');
  const clusterTasks = require('../src/main/peripherals/cluster-tasks');
  assert.strictEqual(clusterTasks.claimTask('long-task', { ttlMs: 1000, now: 5000 }).claimed, true);
  // A working loop calls renewNow() before the TTL elapses.
  const handle = clusterTasks.startAutoRenew('long-task', { ttlMs: 10000 });
  assert.strictEqual(handle.renewNow(5900).claimed, true, 'renewNow extends the claim');
  handle.stop();
  // Past the ORIGINAL 1000ms TTL (expired at 6000), still owned thanks to renewal.
  assert.strictEqual(coordination.whoHolds('task:long-task', 6500).nodeId, 'worker', 'claim alive past original TTL');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('a crashed owner stops renewing → the claim TTL expires → a peer steals it (no orphan)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p29crash');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const coordination = require('../src/main/peripherals/coordination');
  const clusterTasks = require('../src/main/peripherals/cluster-tasks');
  process.env.LIKU_NODE_ID = 'crashy';
  assert.strictEqual(clusterTasks.claimTask('orphan-task', { ttlMs: 1000, now: 5000 }).claimed, true);
  // "crashy" dies (no more renewNow). After its TTL, the lease is free.
  assert.strictEqual(coordination.whoHolds('task:orphan-task', 7000), null, 'expired claim is free (no permanent orphan)');
  process.env.LIKU_NODE_ID = 'rescuer';
  assert.strictEqual(clusterTasks.claimTask('orphan-task', { ttlMs: 1000, now: 7000 }).claimed, true, 'a peer steals the expired claim');
  assert.strictEqual(coordination.whoHolds('task:orphan-task', 7500).nodeId, 'rescuer', 'peer now owns it');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('assignment / handoff are inert single-machine + never an actuation path', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const clusterTasks = require('../src/main/peripherals/cluster-tasks');
  assert.strictEqual(clusterTasks.assignTask('t', 'n').local, true, 'assign is a local ack single-machine');
  assert.strictEqual(clusterTasks.assignmentFor('t'), null, 'no cluster assignment single-machine');
  assert.deepStrictEqual(clusterTasks.myAssignments(), [], 'empty inbox single-machine');
  assert.strictEqual(clusterTasks.handoffTask('t', 'n').local, true, 'handoff is a local ack single-machine');
  // No execute / actuate surface exists on the assignment layer.
  assert.strictEqual(typeof clusterTasks.execute, 'undefined');
  assert.strictEqual(typeof clusterTasks.perform, 'undefined');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('a time-boxed confirmed schedule stops being applied after expiry (single-machine)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const schedule = require('../src/main/peripherals/power-schedule');
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  const base = new Date(2026, 6, 26, 12, 0, 0).getTime();
  advisor.createConfirmedSchedule('boxdev', { maxW: 150, fromHour: 0, toHour: 24, expiresAt: new Date(base + 10000).toISOString() });
  assert.strictEqual(schedule.deviceScheduleW('boxdev', new Date(base)), 150, 'applied before expiry');
  assert.strictEqual(schedule.deviceScheduleW('boxdev', new Date(base + 20000)), null, 'retired after expiry');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('a ttlMs-relative time-boxed schedule expires', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const schedule = require('../src/main/peripherals/power-schedule');
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  const base = new Date(2026, 6, 26, 9, 0, 0).getTime();
  advisor.createConfirmedSchedule('ttldev', { maxW: 100, fromHour: 0, toHour: 24, ttlMs: 10000, now: base });
  assert.strictEqual(schedule.deviceScheduleW('ttldev', new Date(base + 5000)), 100, 'applied within ttl');
  assert.strictEqual(schedule.deviceScheduleW('ttldev', new Date(base + 15000)), null, 'retired after ttl');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('schedule expiry propagates fleet-wide (a peer stops applying the mirrored expired rule)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p29fleetexp');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const schedule = require('../src/main/peripherals/power-schedule');
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  const base = new Date(2026, 6, 26, 15, 0, 0).getTime();
  process.env.LIKU_NODE_ID = 'nodeA';
  advisor.createConfirmedSchedule('fleetbox', { maxW: 200, fromHour: 0, toHour: 24, expiresAt: new Date(base + 10000).toISOString() });
  // Simulate a peer that only sees the shared mirror (no local confirmed file).
  process.env.LIKU_NODE_ID = 'nodeB';
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  assert.strictEqual(schedule.deviceScheduleW('fleetbox', new Date(base)), 200, 'peer applies mirrored rule before expiry');
  assert.strictEqual(schedule.deviceScheduleW('fleetbox', new Date(base + 20000)), null, 'peer stops applying it after expiry (self-describing, no tombstone needed)');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('sweepExpiredSchedules retires + tombstones expired rules (GC-able)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p29sweepexp');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  process.env.LIKU_NODE_ID = 'sweeper';
  const coordination = require('../src/main/peripherals/coordination');
  const schedule = require('../src/main/peripherals/power-schedule');
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  const base = new Date(2026, 6, 26, 8, 0, 0).getTime();
  advisor.createConfirmedSchedule('sweepbox', { maxW: 120, fromHour: 0, toHour: 24, expiresAt: new Date(base + 10000).toISOString() });
  const sw = advisor.sweepExpiredSchedules({ now: base + 20000 });
  assert.strictEqual(sw.ok, true);
  assert.ok(sw.expired.includes('sweepbox:0:24'), 'expired rule reported');
  assert.ok(!advisor.listConfirmedSchedules().some((r) => r.id === 'sweepbox'), 'local rule GC-ed');
  assert.ok(coordination.getShared('schedule-tombstones', 'sweepbox:0:24'), 'tombstone written fleet-wide');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('PAL exposes Phase 29 assignment / handoff / renew / time-box / sweep accessors', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p29pal');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  process.env.LIKU_NODE_ID = 'palN';
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  const schedule = require('../src/main/peripherals/power-schedule');
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  const base = new Date(2026, 6, 26, 10, 0, 0).getTime();
  // Time-boxed schedule via PAL.
  assert.strictEqual(pal.createTimeBoxedSchedule('palbox', { maxW: 90, fromHour: 0, toHour: 24, ttlMs: 10000, now: base }).ok, true);
  // Assignment + inbox.
  assert.strictEqual(pal.assignClusterTask('palt', 'peerX').assigned, true);
  assert.strictEqual(pal.getClusterTaskAssignment('palt').assignee, 'peerX');
  // Claim + auto-renew tick.
  assert.strictEqual(pal.claimClusterTask('palt2').claimed, true);
  assert.strictEqual(pal.renewClusterTaskClaim('palt2').claimed, true, 'auto-renew tick keeps the claim');
  // Handoff of an owned task to the pool.
  assert.strictEqual(pal.handoffClusterTask('palt2', null).handedOff, true);
  // GC the expired time-boxed schedule.
  const sw = pal.sweepExpiredSchedules({ now: base + 20000 });
  assert.strictEqual(sw.ok, true);
  assert.ok(sw.expired.includes('palbox:0:24'), 'PAL sweep retires the expired rule');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

// ── Phase 30: task rebalancing + schedule-expiry notifications + de-escalation ──

test('rebalance reassigns a stale unclaimed task to a less-loaded node', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p30rebal');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  process.env.LIKU_NODE_ID = 'nodeA';
  const clusterTasks = require('../src/main/peripherals/cluster-tasks');
  const t0 = Date.now();
  clusterTasks.publishTask({ id: 'rb1', device: { id: 'heater' }, status: 'pending-review' });
  clusterTasks.assignTask('rb1', 'nodeB'); // assigned but never claimed
  const res = clusterTasks.rebalance({ now: t0 + 100000, staleMs: 1000 });
  assert.strictEqual(res.rebalanced.length, 1, 'the stale task is rebalanced');
  assert.strictEqual(res.rebalanced[0].from, 'nodeB');
  assert.strictEqual(res.rebalanced[0].to, 'nodeA', 'moved to the less-loaded node');
  assert.strictEqual(clusterTasks.assignmentFor('rb1'), 'nodeA', 'assignment updated');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('rebalance never touches an actively-owned task (no double ownership)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p30rebalown');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  process.env.LIKU_NODE_ID = 'nodeA';
  const clusterTasks = require('../src/main/peripherals/cluster-tasks');
  const t0 = Date.now();
  clusterTasks.publishTask({ id: 'rb2', device: { id: 'oven' }, status: 'pending-review' });
  clusterTasks.assignTask('rb2', 'nodeB');
  clusterTasks.claimTask('rb2', { ttlMs: 300000, now: t0 }); // nodeA owns it
  const res = clusterTasks.rebalance({ now: t0 + 1000, staleMs: 500 });
  assert.strictEqual(res.rebalanced.length, 0, 'owned task is left alone');
  assert.strictEqual(clusterTasks.taskOwner('rb2', t0 + 1000), 'nodeA', 'ownership unchanged');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('rebalance is inert single-machine + exposes no actuation surface', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const clusterTasks = require('../src/main/peripherals/cluster-tasks');
  const res = clusterTasks.rebalance();
  assert.deepStrictEqual(res.rebalanced, [], 'no rebalancing single-machine');
  assert.strictEqual(res.local, true);
  assert.strictEqual(typeof clusterTasks.execute, 'undefined');
  assert.strictEqual(typeof clusterTasks.perform, 'undefined');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('expiringSchedules lists upcoming + just-expired confirmed caps (advisory)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const schedule = require('../src/main/peripherals/power-schedule');
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  const base = new Date(2026, 6, 26, 12, 0, 0).getTime();
  advisor.createConfirmedSchedule('soon', { maxW: 150, fromHour: 0, toHour: 24, expiresAt: new Date(base + 30 * 60000).toISOString() });
  advisor.createConfirmedSchedule('lapsed', { maxW: 120, fromHour: 0, toHour: 24, expiresAt: new Date(base - 10 * 60000).toISOString() });
  advisor.createConfirmedSchedule('faraway', { maxW: 90, fromHour: 0, toHour: 24, expiresAt: new Date(base + 10 * 3600000).toISOString() });
  const list = advisor.expiringSchedules({ now: base });
  const byId = Object.fromEntries(list.map((s) => [s.id, s]));
  assert.strictEqual(byId.soon && byId.soon.state, 'upcoming', 'soon is upcoming');
  assert.strictEqual(byId.lapsed && byId.lapsed.state, 'expired', 'lapsed is just-expired');
  assert.ok(!byId.faraway, 'far-future expiry not surfaced yet');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('buildExpiryNotification is advisory-only (never autonomous)', () => {
  const { buildExpiryNotification } = require('../src/main/agents/schedule-expiry-notifier');
  const expired = buildExpiryNotification({ id: 'd', fromHour: 0, toHour: 24, maxW: 100, expiresAt: new Date().toISOString(), expiresInMs: -1000, state: 'expired' });
  assert.strictEqual(expired.autonomousAction, false);
  assert.strictEqual(expired.requiresHuman, false);
  assert.strictEqual(expired.severity, 'warning', 'a lapsed cap is a warning');
  assert.strictEqual(expired.source, 'schedule-expiry');
  assert.ok(expired.dedupeKey.startsWith('schedule-expiry:d:'), 'dedupe key present');
  const upcoming = buildExpiryNotification({ id: 'd', fromHour: 0, toHour: 24, maxW: 100, expiresAt: new Date().toISOString(), expiresInMs: 1000, state: 'upcoming' });
  assert.strictEqual(upcoming.severity, 'info', 'an upcoming expiry is info');
});

test('schedule-expiry notifier creates a human-gated task + NEVER auto-extends the schedule', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const schedule = require('../src/main/peripherals/power-schedule');
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  const { attachScheduleExpiryNotifier } = require('../src/main/agents/schedule-expiry-notifier');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  const base = new Date(2026, 6, 26, 12, 0, 0).getTime();
  const expiresAt = new Date(base + 30 * 60000).toISOString();
  advisor.createConfirmedSchedule('boxN', { maxW: 150, fromHour: 0, toHour: 24, expiresAt });
  const created = [];
  const supervisor = {
    receiveNotification() {},
    createPeripheralTask(n) { return { id: n.id, source: 'schedule-expiry', status: 'pending-review', requiresHuman: false, autonomousAction: false, notification: n }; }
  };
  const orch = new (require('events').EventEmitter)();
  const notifier = attachScheduleExpiryNotifier(orch, { getSupervisor: () => supervisor, now: () => base });
  const r = notifier.tick(base);
  assert.strictEqual(r.created.length, 1, 'one advisory expiry task created');
  assert.strictEqual(r.created[0].autonomousAction, false, 'task is not autonomous');
  // The schedule was NOT auto-extended — its expiry is unchanged.
  const rule = advisor.listConfirmedSchedules().find((x) => x.id === 'boxN');
  assert.strictEqual(rule.expiresAt, expiresAt, 'notifier never mutates the schedule');
  advisor.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('auto-heal policies are cluster-shared (a peer sees the threshold without a local store)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p30policy');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  process.env.LIKU_NODE_ID = 'nodeA';
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  actions.clear();
  actions.clearPolicies();
  actions.setPolicy('devP', { 'reduce-schedule': 1 }); // writes local + mirrors to cluster
  // Drop the LOCAL policy store; the cluster mirror must still supply the threshold.
  actions.clearPolicies();
  assert.strictEqual(actions.getPolicy('devP')['reduce-schedule'], 1, 'cluster-shared policy visible after local store cleared');
  actions.clearPolicies();
  actions.clear();
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('recovery de-escalation proposes clearing a temporary restriction (human-gated confirm)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const schedule = require('../src/main/peripherals/power-schedule');
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  advisor.clear(); actions.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  const base = new Date(2026, 6, 26, 12, 0, 0).getTime();
  // Device was anomalous once, then a temporary reduce-schedule was confirmed.
  actions.recordAnomaly({ device: 'devR', type: 'spike' }, base);
  advisor.createConfirmedSchedule('devR', { maxW: 100, fromHour: 0, toHour: 24 }); // source anomaly-action-confirmed
  assert.strictEqual(schedule.deviceScheduleW('devR', new Date(base)), 100, 'restriction active');
  // Recovered (no anomaly for the recovery window) → propose clear-schedule.
  const de = actions.proposeDeescalations({ recoveryMs: 1000 }, base + 5000);
  assert.strictEqual(de.length, 1, 'one de-escalation proposed');
  assert.strictEqual(de[0].action, 'clear-schedule');
  assert.strictEqual(de[0].requiresHuman, true, 'still human-gated');
  // Human confirms → PAL removes the restriction (confirm IS the gate).
  const conf = pal.confirmAnomalyAction(de[0].id);
  assert.strictEqual(conf.ok, true);
  assert.strictEqual(conf.executed.ok, true, 'restriction removed on confirm');
  assert.strictEqual(schedule.deviceScheduleW('devR', new Date(base)), null, 'device unrestricted after recovery clear');
  advisor.clear(); actions.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('de-escalation only triggers on genuine recovery (recent anomaly → no proposal)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const schedule = require('../src/main/peripherals/power-schedule');
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  advisor.clear(); actions.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  const base = new Date(2026, 6, 26, 12, 0, 0).getTime();
  actions.recordAnomaly({ device: 'devRecent', type: 'spike' }, base);
  advisor.createConfirmedSchedule('devRecent', { maxW: 100, fromHour: 0, toHour: 24 });
  // Only 2s since last anomaly but recovery window is large → NOT recovered.
  const de = actions.proposeDeescalations({ recoveryMs: 100000 }, base + 2000);
  assert.strictEqual(de.length, 0, 'no de-escalation while still recently anomalous');
  advisor.clear(); actions.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('auto-clear is OFF by default + only clears advisory OPEN suggestions when enabled', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  actions.clear();
  const base = new Date(2026, 6, 26, 12, 0, 0).getTime();
  for (let i = 0; i < 3; i++) actions.recordAnomaly({ device: 'devAC', type: 'spike' }, base);
  const props = actions.proposeActions({}, base);
  assert.ok(props.length >= 1, 'an open advisory action exists');
  // Default OFF → no auto-clear even when recovered.
  delete process.env.LIKU_PERIPHERAL_AUTOHEAL_AUTOCLEAR;
  assert.deepStrictEqual(actions.autoClearRecovered({ recoveryMs: 1000 }, base + 5000).cleared, [], 'no auto-clear by default');
  assert.ok(actions.listProposed().some((p) => p.deviceId === 'devAC'), 'proposal still open');
  // Enabled → safely clears the OPEN advisory suggestion (never a confirmed restriction).
  process.env.LIKU_PERIPHERAL_AUTOHEAL_AUTOCLEAR = '1';
  const cleared = actions.autoClearRecovered({ recoveryMs: 1000 }, base + 5000).cleared;
  assert.strictEqual(cleared.length, 1, 'recovered open suggestion auto-cleared');
  assert.ok(!actions.listProposed().some((p) => p.deviceId === 'devAC'), 'suggestion no longer open');
  delete process.env.LIKU_PERIPHERAL_AUTOHEAL_AUTOCLEAR;
  actions.clear();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('PAL exposes Phase 30 rebalance / expiry / de-escalation accessors', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p30pal');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  process.env.LIKU_NODE_ID = 'palN';
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  const rb = pal.rebalanceClusterTasks();
  assert.strictEqual(rb.enabled, true);
  assert.ok(Array.isArray(rb.rebalanced));
  const ex = pal.getExpiringSchedules();
  assert.strictEqual(ex.enabled, true);
  assert.ok(Array.isArray(ex.schedules));
  const de = pal.getDeescalations();
  assert.strictEqual(de.enabled, true);
  assert.ok(Array.isArray(de.deescalations));
  const ac = pal.autoClearRecovered();
  assert.strictEqual(ac.enabled, true);
  assert.ok(Array.isArray(ac.cleared));
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

// ── Phase 31: periodic self-healing tick + ladder de-escalation on recovery ──

test('self-healing tick runs rebalance + expiry + de-escalation when enabled', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_AUTOHEAL_RECOVERY_MS = '1000';
  delete process.env.LIKU_CLUSTER_DIR;
  const schedule = require('../src/main/peripherals/power-schedule');
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  const { attachScheduleExpiryNotifier } = require('../src/main/agents/schedule-expiry-notifier');
  const { attachSelfHealingScheduler } = require('../src/main/agents/self-healing-scheduler');
  advisor.clear(); actions.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  const base = new Date(2026, 6, 26, 12, 0, 0).getTime();
  advisor.createConfirmedSchedule('exp', { maxW: 150, fromHour: 0, toHour: 24, expiresAt: new Date(base + 30 * 60000).toISOString() });
  actions.recordAnomaly({ device: 'rec', type: 'spike' }, base);
  advisor.createConfirmedSchedule('rec', { maxW: 100, fromHour: 0, toHour: 24 });
  const supervisor = { receiveNotification() {}, createPeripheralTask(n) { return { id: n.id, status: 'pending-review', autonomousAction: false }; } };
  const orch = new (require('events').EventEmitter)();
  orch.agents = new Map([['supervisor', supervisor]]);
  const expiry = attachScheduleExpiryNotifier(orch, { getSupervisor: () => supervisor, now: () => base });
  const sh = attachSelfHealingScheduler(orch, { scheduleExpiryTick: expiry.tick, now: () => base });
  const res = sh.tick(base + 5000);
  sh.detach(); expiry.detach();
  assert.strictEqual(res.ran, true, 'tick ran');
  assert.ok(res.expiryTasks >= 1, 'expiry notifier surfaced the lapsing cap');
  assert.ok(res.deescalations.some((d) => d.deviceId === 'rec' && d.action === 'clear-schedule'), 'recovery de-escalation proposed');
  advisor.clear(); actions.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  delete process.env.LIKU_PERIPHERAL_AUTOHEAL_RECOVERY_MS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('self-healing tick is inert when peripherals are disabled', () => {
  delete process.env.LIKU_ENABLE_PERIPHERALS;
  const { attachSelfHealingScheduler } = require('../src/main/agents/self-healing-scheduler');
  const orch = new (require('events').EventEmitter)();
  const sh = attachSelfHealingScheduler(orch, {});
  assert.strictEqual(sh.tick().ran, false, 'tick is a no-op when disabled');
  sh.detach();
});

test('self-healing tick is best-effort (a failing sub-action never aborts the others)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const { attachSelfHealingScheduler } = require('../src/main/agents/self-healing-scheduler');
  const orch = new (require('events').EventEmitter)();
  const failingPal = { isPeripheralsEnabled: () => true, rebalanceClusterTasks() { throw new Error('boom'); } };
  const failingAdvisor = { proposeDeescalations() { throw new Error('boom'); }, autoClearRecovered() { return { cleared: [] }; } };
  const sh = attachSelfHealingScheduler(orch, {
    pal: failingPal, actionAdvisor: failingAdvisor,
    scheduleExpiryTick: () => { throw new Error('boom'); }, now: () => 1000
  });
  const res = sh.tick(1000);
  assert.strictEqual(res.ran, true, 'tick still completes despite failures');
  assert.deepStrictEqual(res.rebalanced, []);
  assert.strictEqual(res.expiryTasks, 0);
  assert.deepStrictEqual(res.deescalations, []);
  sh.detach();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('self-healing scheduler exposes no actuation / confirm surface', () => {
  const { attachSelfHealingScheduler } = require('../src/main/agents/self-healing-scheduler');
  const orch = new (require('events').EventEmitter)();
  const sh = attachSelfHealingScheduler(orch, {});
  assert.strictEqual(typeof sh.tick, 'function');
  assert.strictEqual(typeof sh.detach, 'function');
  assert.strictEqual(typeof sh.execute, 'undefined');
  assert.strictEqual(typeof sh.perform, 'undefined');
  assert.strictEqual(typeof sh.confirm, 'undefined');
  sh.detach();
});

test('rotate-token rung de-escalates to clear-rotate-token; confirm resets the ladder (advisory)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS = '0';
  delete process.env.LIKU_CLUSTER_DIR;
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  actions.clear();
  const base = new Date(2026, 6, 26, 12, 0, 0).getTime();
  for (let i = 0; i < 6; i++) actions.recordAnomaly({ device: 'devT', type: 'spike' }, base);
  const props = actions.proposeActions({}, base);
  const rt = props.find((p) => p.deviceId === 'devT');
  assert.strictEqual(rt.action, 'rotate-token', 'device reached the rotate-token rung');
  actions.confirm(rt.id); // human confirmed the elevated action
  const de = actions.proposeDeescalations({ recoveryMs: 1000 }, base + 5000);
  const d = de.find((x) => x.deviceId === 'devT');
  assert.strictEqual(d.action, 'clear-rotate-token');
  assert.strictEqual(d.fromAction, 'rotate-token');
  assert.strictEqual(d.requiresHuman, true);
  // Confirm the de-escalation → PAL performs a PURE advisory ladder reset.
  const conf = pal.confirmAnomalyAction(d.id);
  assert.strictEqual(conf.ok, true);
  assert.strictEqual(conf.executed.reset, true, 'ladder reset on confirm (no actuation)');
  actions.clear();
  delete process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('unpair rung de-escalates to repair; confirm does NOT auto-execute (advisory directive only)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS = '0';
  delete process.env.LIKU_CLUSTER_DIR;
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  actions.clear();
  const base = new Date(2026, 6, 26, 12, 0, 0).getTime();
  for (let i = 0; i < 10; i++) actions.recordAnomaly({ device: 'devU', type: 'spike' }, base);
  const props = actions.proposeActions({}, base);
  const up = props.find((p) => p.deviceId === 'devU');
  assert.strictEqual(up.action, 'unpair', 'device reached the unpair rung');
  actions.confirm(up.id);
  const de = actions.proposeDeescalations({ recoveryMs: 1000 }, base + 5000);
  const d = de.find((x) => x.deviceId === 'devU');
  assert.strictEqual(d.action, 'repair');
  assert.strictEqual(d.fromAction, 'unpair');
  assert.ok(d.directive.includes('pair devU'), 're-pair directive surfaced for the human');
  // Confirm → repair is NOT auto-executed (security-sensitive); directive-only.
  const conf = pal.confirmAnomalyAction(d.id);
  assert.strictEqual(conf.ok, true);
  assert.strictEqual(conf.executed, null, 're-pair never auto-executes');
  actions.clear();
  delete process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('higher-rung de-escalation only triggers on genuine recovery', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS = '0';
  delete process.env.LIKU_CLUSTER_DIR;
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  actions.clear();
  const base = new Date(2026, 6, 26, 12, 0, 0).getTime();
  for (let i = 0; i < 6; i++) actions.recordAnomaly({ device: 'devG', type: 'spike' }, base);
  actions.confirm(actions.proposeActions({}, base).find((p) => p.deviceId === 'devG').id);
  // Only 2s since last anomaly but recovery window is large → NOT recovered.
  const de = actions.proposeDeescalations({ recoveryMs: 100000 }, base + 2000);
  assert.ok(!de.some((x) => x.deviceId === 'devG'), 'no de-escalation while still recently anomalous');
  actions.clear();
  delete process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('resetDevice is a pure advisory ladder reset (clears recorded anomaly state)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS = '0';
  delete process.env.LIKU_CLUSTER_DIR;
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  actions.clear();
  const base = new Date(2026, 6, 26, 12, 0, 0).getTime();
  for (let i = 0; i < 6; i++) actions.recordAnomaly({ device: 'devZ', type: 'spike' }, base);
  actions.confirm(actions.proposeActions({}, base).find((p) => p.deviceId === 'devZ').id);
  const r = actions.resetDevice('devZ');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reset, true);
  // Occurrences cleared → the device no longer escalates or de-escalates.
  assert.deepStrictEqual(actions.proposeActions({}, base), []);
  assert.deepStrictEqual(actions.proposeDeescalations({ recoveryMs: 1 }, base + 10000), []);
  actions.clear();
  delete process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('reduce-schedule de-escalation carries its fromAction (regression + provenance)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const schedule = require('../src/main/peripherals/power-schedule');
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  advisor.clear(); actions.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  const base = new Date(2026, 6, 26, 12, 0, 0).getTime();
  actions.recordAnomaly({ device: 'devS', type: 'spike' }, base);
  advisor.createConfirmedSchedule('devS', { maxW: 100, fromHour: 0, toHour: 24 });
  const de = actions.proposeDeescalations({ recoveryMs: 1000 }, base + 5000);
  const d = de.find((x) => x.deviceId === 'devS');
  assert.strictEqual(d.action, 'clear-schedule');
  assert.strictEqual(d.fromAction, 'reduce-schedule');
  advisor.clear(); actions.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

// ── Phase 32: self-heal observability + fairness rebalance + step-back-one-rung ──

test('self-heal tick records last-run metrics + per-step timings (observability)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_AUTOHEAL_RECOVERY_MS = '1000';
  delete process.env.LIKU_CLUSTER_DIR;
  const schedule = require('../src/main/peripherals/power-schedule');
  const advisor = require('../src/main/peripherals/power-schedule-advisor');
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  const status = require('../src/main/peripherals/self-heal-status');
  const { attachScheduleExpiryNotifier } = require('../src/main/agents/schedule-expiry-notifier');
  const { attachSelfHealingScheduler } = require('../src/main/agents/self-healing-scheduler');
  advisor.clear(); actions.clear(); status.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  const base = new Date(2026, 6, 26, 12, 0, 0).getTime();
  actions.recordAnomaly({ device: 'rec', type: 'spike' }, base);
  advisor.createConfirmedSchedule('rec', { maxW: 100, fromHour: 0, toHour: 24 });
  const sup = { receiveNotification() {}, createPeripheralTask(n) { return { id: n.id, status: 'pending-review', autonomousAction: false }; } };
  const orch = new (require('events').EventEmitter)();
  orch.agents = new Map([['supervisor', sup]]);
  const ex = attachScheduleExpiryNotifier(orch, { getSupervisor: () => sup, now: () => base });
  const sh = attachSelfHealingScheduler(orch, { scheduleExpiryTick: ex.tick, now: () => base });
  const res = sh.tick(base + 5000);
  sh.detach(); ex.detach();
  assert.strictEqual(typeof res.durationMs, 'number', 'tick reports a duration');
  assert.ok(res.timings && typeof res.timings.rebalance === 'number' && typeof res.timings.deescalation === 'number', 'per-step timings present');
  const lr = sh.getLastRun();
  assert.ok(lr && lr.counts && lr.counts.deescalations >= 1 && lr.timings, 'in-memory last-run captured');
  const st = status.read();
  assert.ok(st.lastRun && st.totals.runs >= 1 && st.totals.deescalations >= 1, 'persisted status recorded');
  advisor.clear(); actions.clear(); status.clear();
  try { fs.rmSync(schedule.CONFIRMED_FILE); } catch { /* ignore */ }
  delete process.env.LIKU_PERIPHERAL_AUTOHEAL_RECOVERY_MS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('PAL getSelfHealStatus reads persisted totals (accumulates across runs)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const status = require('../src/main/peripherals/self-heal-status');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  status.clear();
  status.record({ at: new Date().toISOString(), durationMs: 5, timings: { rebalance: 1 }, counts: { rebalanced: 2, expiryTasks: 1, deescalations: 0, autoCleared: 0 } });
  let st = pal.getSelfHealStatus();
  assert.strictEqual(st.enabled, true);
  assert.strictEqual(st.totals.runs, 1);
  assert.strictEqual(st.totals.rebalanced, 2);
  assert.strictEqual(st.lastRun.durationMs, 5);
  status.record({ at: new Date().toISOString(), durationMs: 3, timings: {}, counts: { rebalanced: 3, expiryTasks: 0, deescalations: 1, autoCleared: 0 } });
  st = pal.getSelfHealStatus();
  assert.strictEqual(st.totals.runs, 2, 'runs accumulate');
  assert.strictEqual(st.totals.rebalanced, 5, 'counts fold cumulatively');
  status.clear();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('self-heal status recording is pure observation (a failing store never breaks the tick)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const { attachSelfHealingScheduler } = require('../src/main/agents/self-healing-scheduler');
  const orch = new (require('events').EventEmitter)();
  const fakePal = { isPeripheralsEnabled: () => true, rebalanceClusterTasks: () => ({ rebalanced: [] }) };
  const fakeAdvisor = { proposeDeescalations: () => [], autoClearRecovered: () => ({ cleared: [] }) };
  const badStatus = { record() { throw new Error('disk full'); } };
  const sh = attachSelfHealingScheduler(orch, { pal: fakePal, actionAdvisor: fakeAdvisor, statusStore: badStatus, now: () => 1000 });
  const res = sh.tick(1000);
  assert.strictEqual(res.ran, true, 'tick still completes when status recording throws');
  assert.ok(res.timings, 'timings still produced');
  sh.detach();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('fairness rebalance places the highest-severity task first, onto the less-loaded node', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p32fair');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const ct = require('../src/main/peripherals/cluster-tasks');
  const t0 = Date.now();
  process.env.LIKU_NODE_ID = 'nodeB';
  ct.publishTask({ id: 'heavy', device: { id: 'd' }, priority: 'high', status: 'pending-review' });
  ct.claimTask('heavy', { ttlMs: 300000, now: t0 }); // nodeB carries a heavy (weight 3) task
  process.env.LIKU_NODE_ID = 'nodeA';
  ct.publishTask({ id: 'crit', device: { id: 'd' }, priority: 'high', status: 'pending-review' });
  ct.publishTask({ id: 'infoX', device: { id: 'd' }, priority: 'low', status: 'pending-review' });
  const res = ct.rebalance({ now: t0 + 1000, staleMs: 500 });
  assert.strictEqual(res.rebalanced[0].taskId, 'crit', 'highest-severity task rebalanced first');
  assert.strictEqual(res.rebalanced[0].weight, 3, 'critical weight');
  assert.strictEqual(res.rebalanced[0].to, 'nodeA', 'placed on the less-loaded node (not the heavy nodeB)');
  assert.strictEqual(res.rebalanced[1].weight, 1, 'lower-severity task follows');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('fairness rebalance respects node CAPACITY (a high-capacity node absorbs more)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p32cap');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  process.env.LIKU_PERIPHERAL_NODE_CAPACITY = JSON.stringify({ bignode: 10 });
  const ct = require('../src/main/peripherals/cluster-tasks');
  const t0 = Date.now();
  process.env.LIKU_NODE_ID = 'nodeA';
  ct.publishTask({ id: 'aload', device: { id: 'd' }, priority: 'low', status: 'pending-review' });
  ct.claimTask('aload', { ttlMs: 300000, now: t0 }); // nodeA load 1
  process.env.LIKU_NODE_ID = 'bignode';
  ct.publishTask({ id: 'bload', device: { id: 'd' }, priority: 'high', status: 'pending-review' });
  ct.claimTask('bload', { ttlMs: 300000, now: t0 }); // bignode load 3 but capacity 10
  process.env.LIKU_NODE_ID = 'nodeA';
  ct.publishTask({ id: 'newt', device: { id: 'd' }, priority: 'high', status: 'pending-review' });
  const res = ct.rebalance({ now: t0 + 1000, staleMs: 500 });
  const mv = res.rebalanced.find((r) => r.taskId === 'newt');
  assert.strictEqual(mv.to, 'bignode', 'higher-capacity node preferred despite higher raw load (0.3 < 1.0 score)');
  delete process.env.LIKU_PERIPHERAL_NODE_CAPACITY;
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('fairness rebalance stays advisory (assignment only, no double ownership)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p32adv');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const ct = require('../src/main/peripherals/cluster-tasks');
  const t0 = Date.now();
  process.env.LIKU_NODE_ID = 'nodeB';
  ct.publishTask({ id: 'heavy2', device: { id: 'd' }, priority: 'high', status: 'pending-review' });
  ct.claimTask('heavy2', { ttlMs: 300000, now: t0 });
  process.env.LIKU_NODE_ID = 'nodeA';
  ct.publishTask({ id: 'crit2', device: { id: 'd' }, priority: 'high', status: 'pending-review' });
  ct.rebalance({ now: t0 + 1000, staleMs: 500 });
  assert.strictEqual(ct.taskOwner('heavy2', t0 + 1000), 'nodeB', 'owned task ownership unchanged');
  assert.strictEqual(ct.taskOwner('crit2', t0 + 1000), null, 'rebalanced task is only ASSIGNED, never owned by rebalancer');
  assert.strictEqual(ct.assignmentFor('crit2'), 'nodeA', 'assignment intent rewritten');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('step-back-one-rung: unpair → stepback-rotate-token; confirm is a pure advisory posture update', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_AUTOHEAL_STEPBACK = '1';
  process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS = '0';
  delete process.env.LIKU_CLUSTER_DIR;
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  actions.clear();
  const base = new Date(2026, 6, 26, 12, 0, 0).getTime();
  for (let i = 0; i < 10; i++) actions.recordAnomaly({ device: 'devU', type: 'spike' }, base);
  actions.confirm(actions.proposeActions({}, base).find((p) => p.deviceId === 'devU').id);
  const de = actions.proposeDeescalations({ recoveryMs: 1000 }, base + 5000).find((x) => x.deviceId === 'devU');
  assert.strictEqual(de.action, 'stepback-rotate-token');
  assert.strictEqual(de.fromAction, 'unpair');
  assert.strictEqual(de.toRung, 'rotate-token');
  assert.strictEqual(de.mode, 'step-back');
  assert.strictEqual(de.requiresHuman, true);
  const conf = pal.confirmAnomalyAction(de.id);
  assert.strictEqual(conf.ok, true);
  assert.strictEqual(conf.executed.steppedBackTo, 'rotate-token', 'advisory posture update; nothing actuated');
  actions.clear();
  delete process.env.LIKU_PERIPHERAL_AUTOHEAL_STEPBACK;
  delete process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('step-back chains ONE rung per recovery cycle (unpair → rotate-token → reduce-schedule → clear)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_AUTOHEAL_STEPBACK = '1';
  process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS = '0';
  delete process.env.LIKU_CLUSTER_DIR;
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  actions.clear();
  const base = new Date(2026, 6, 26, 12, 0, 0).getTime();
  for (let i = 0; i < 10; i++) actions.recordAnomaly({ device: 'devC', type: 'spike' }, base);
  actions.confirm(actions.proposeActions({}, base).find((p) => p.deviceId === 'devC').id);
  let de = actions.proposeDeescalations({ recoveryMs: 1000 }, base + 5000).find((x) => x.deviceId === 'devC');
  assert.strictEqual(de.action, 'stepback-rotate-token', 'rung 1: unpair → rotate-token');
  pal.confirmAnomalyAction(de.id);
  de = actions.proposeDeescalations({ recoveryMs: 1000 }, base + 6000).find((x) => x.deviceId === 'devC');
  assert.strictEqual(de.action, 'stepback-reduce-schedule', 'rung 2: rotate-token → reduce-schedule');
  pal.confirmAnomalyAction(de.id);
  de = actions.proposeDeescalations({ recoveryMs: 1000 }, base + 7000).find((x) => x.deviceId === 'devC');
  assert.strictEqual(de.action, 'clear-schedule', 'rung 3: reduce-schedule → clear');
  actions.clear();
  delete process.env.LIKU_PERIPHERAL_AUTOHEAL_STEPBACK;
  delete process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('step-back is OFF by default → single-jump clear-current behaviour is preserved', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS = '0';
  delete process.env.LIKU_PERIPHERAL_AUTOHEAL_STEPBACK;
  delete process.env.LIKU_CLUSTER_DIR;
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  actions.clear();
  const base = new Date(2026, 6, 26, 12, 0, 0).getTime();
  for (let i = 0; i < 10; i++) actions.recordAnomaly({ device: 'devR2', type: 'spike' }, base);
  actions.confirm(actions.proposeActions({}, base).find((p) => p.deviceId === 'devR2').id);
  const de = actions.proposeDeescalations({ recoveryMs: 1000 }, base + 5000).find((x) => x.deviceId === 'devR2');
  assert.strictEqual(de.action, 'repair', 'default clears the current rung in one jump (Phase 31)');
  assert.strictEqual(de.mode, 'clear');
  actions.clear();
  delete process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('stepBackDevice is a pure advisory rung lowering (inert when disabled)', () => {
  delete process.env.LIKU_ENABLE_PERIPHERALS;
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  assert.strictEqual(actions.stepBackDevice('x', 'rotate-token').ok, false, 'inert when disabled');
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS = '0';
  delete process.env.LIKU_CLUSTER_DIR;
  actions.clear();
  const base = new Date(2026, 6, 26, 12, 0, 0).getTime();
  for (let i = 0; i < 10; i++) actions.recordAnomaly({ device: 'devQ', type: 'spike' }, base);
  actions.confirm(actions.proposeActions({}, base).find((p) => p.deviceId === 'devQ').id);
  const r = actions.stepBackDevice('devQ', 'rotate-token');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.steppedBackTo, 'rotate-token');
  // Recorded rung is now rotate-token → step-back proposes the next rung down.
  process.env.LIKU_PERIPHERAL_AUTOHEAL_STEPBACK = '1';
  const de = actions.proposeDeescalations({ recoveryMs: 1 }, base + 100000).find((x) => x.deviceId === 'devQ');
  assert.strictEqual(de.action, 'stepback-reduce-schedule', 'posture lowered → next rung proposed');
  actions.clear();
  delete process.env.LIKU_PERIPHERAL_AUTOHEAL_STEPBACK;
  delete process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

// ── Phase 33: self-heal production wiring + tick-health + anti-flap + step-back cooldown ──

test('self-heal interval auto-resolves (production flag → default cadence; option > env > flag)', () => {
  const { attachSelfHealingScheduler } = require('../src/main/agents/self-healing-scheduler');
  const orch = new (require('events').EventEmitter)();
  delete process.env.LIKU_PERIPHERAL_SELF_HEAL;
  delete process.env.LIKU_PERIPHERAL_SELF_HEAL_INTERVAL_MS;
  let sh = attachSelfHealingScheduler(orch, {});
  assert.strictEqual(sh.intervalMs, 0, 'timer-free by default'); sh.detach();
  process.env.LIKU_PERIPHERAL_SELF_HEAL = '1';
  sh = attachSelfHealingScheduler(orch, {});
  assert.strictEqual(sh.intervalMs, 300000, 'production flag → 5 min cadence'); sh.detach();
  process.env.LIKU_PERIPHERAL_SELF_HEAL_INTERVAL_MS = '60000';
  sh = attachSelfHealingScheduler(orch, {});
  assert.strictEqual(sh.intervalMs, 60000, 'env interval overrides the flag default'); sh.detach();
  sh = attachSelfHealingScheduler(orch, { intervalMs: 12345 });
  assert.strictEqual(sh.intervalMs, 12345, 'explicit option wins'); sh.detach();
  delete process.env.LIKU_PERIPHERAL_SELF_HEAL;
  delete process.env.LIKU_PERIPHERAL_SELF_HEAL_INTERVAL_MS;
});

test('tick-health reports last-run age + staleness (pure observation)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_SELF_HEAL_STALE_MS = '1000';
  const status = require('../src/main/peripherals/self-heal-status');
  status.clear();
  let h = status.health();
  assert.strictEqual(h.ran, false, 'never-run tick is not "stale"');
  assert.strictEqual(h.stale, false);
  const base = Date.now();
  status.record({ at: new Date(base).toISOString(), durationMs: 1, timings: {}, counts: { rebalanced: 0, expiryTasks: 0, deescalations: 0, autoCleared: 0 } });
  h = status.health({ now: base + 500 });
  assert.strictEqual(h.stale, false, 'fresh run is healthy');
  assert.strictEqual(h.lastRunAgeMs, 500);
  h = status.health({ now: base + 2000 });
  assert.strictEqual(h.stale, true, 'stale once past the threshold');
  status.clear();
  delete process.env.LIKU_PERIPHERAL_SELF_HEAL_STALE_MS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('tick emits an ADVISORY tick-health signal after a stall gap', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_SELF_HEAL_STALE_MS = '1000';
  const status = require('../src/main/peripherals/self-heal-status');
  const { attachSelfHealingScheduler } = require('../src/main/agents/self-healing-scheduler');
  status.clear();
  const orch = new (require('events').EventEmitter)();
  let ev = null;
  orch.on('self-heal:tick-health', (e) => { ev = e; });
  const fakePal = { isPeripheralsEnabled: () => true, rebalanceClusterTasks: () => ({ rebalanced: [] }) };
  const fakeAdvisor = { proposeDeescalations: () => [], autoClearRecovered: () => ({ cleared: [] }) };
  const sh = attachSelfHealingScheduler(orch, { pal: fakePal, actionAdvisor: fakeAdvisor });
  const base = 1000000;
  status.record({ at: new Date(base).toISOString(), durationMs: 1, timings: {}, counts: {} });
  const res = sh.tick(base + 5000); // gap 5000 > stale 1000
  assert.ok(res.tickHealth && res.tickHealth.wasStale === true, 'stall detected on the result');
  assert.ok(ev && ev.kind === 'tick-health' && ev.requiresHuman === false && ev.autonomousAction === false, 'advisory-only tick-health event');
  status.clear(); sh.detach();
  delete process.env.LIKU_PERIPHERAL_SELF_HEAL_STALE_MS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('PAL getSelfHealHealth surfaces staleness', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_SELF_HEAL_STALE_MS = '1000';
  const status = require('../src/main/peripherals/self-heal-status');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  status.clear();
  status.record({ at: new Date(Date.now() - 5000).toISOString(), durationMs: 1, timings: {}, counts: {} });
  const h = pal.getSelfHealHealth();
  assert.strictEqual(h.enabled, true);
  assert.strictEqual(h.stale, true, 'a 5s-old run is stale vs a 1s threshold');
  status.clear();
  delete process.env.LIKU_PERIPHERAL_SELF_HEAL_STALE_MS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('rebalance HYSTERESIS holds an assigned task when the improvement is too small', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p33hys');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const ct = require('../src/main/peripherals/cluster-tasks');
  const t0 = Date.now();
  process.env.LIKU_NODE_ID = 'nodeA';
  ct.publishTask({ id: 'h1', device: { id: 'd' }, priority: 'low', status: 'pending-review' });
  ct.assignTask('h1', 'nodeC'); // assigned to nodeC (load 1); nodeA is 0 → only 1 better
  const res = ct.rebalance({ now: t0 + 100000, staleMs: 1000, hysteresis: 5 });
  assert.strictEqual(res.rebalanced.length, 0, 'improvement (1) < margin (5) → task held (no flap)');
  assert.strictEqual(ct.assignmentFor('h1'), 'nodeC', 'assignment unchanged');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('rebalance HYSTERESIS still moves an assigned task when the improvement clears the margin', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p33hys2');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const ct = require('../src/main/peripherals/cluster-tasks');
  const t0 = Date.now();
  process.env.LIKU_NODE_ID = 'nodeC';
  ct.publishTask({ id: 'heavyC', device: { id: 'd' }, priority: 'high', status: 'pending-review' });
  ct.claimTask('heavyC', { ttlMs: 300000, now: t0 }); // nodeC carries weight 3
  process.env.LIKU_NODE_ID = 'nodeA';
  ct.publishTask({ id: 'h2', device: { id: 'd' }, priority: 'low', status: 'pending-review' });
  ct.assignTask('h2', 'nodeC'); // nodeC load = 3 (owned) + 1 (assigned) = 4; nodeA = 0
  const res = ct.rebalance({ now: t0 + 100000, staleMs: 1000, hysteresis: 2 });
  assert.strictEqual(res.rebalanced.length, 1, 'improvement (4) >= margin (2) → moved');
  assert.strictEqual(res.rebalanced[0].taskId, 'h2');
  assert.strictEqual(res.rebalanced[0].to, 'nodeA');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('rebalance MIN-RESIDENCY leaves a freshly-placed task to settle', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p33res');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const ct = require('../src/main/peripherals/cluster-tasks');
  const t0 = Date.now();
  process.env.LIKU_NODE_ID = 'nodeA';
  ct.publishTask({ id: 'r1', device: { id: 'd' }, priority: 'high', status: 'pending-review' });
  ct.assignTask('r1', 'nodeC'); // assignedAt ≈ t0 (young)
  // Stale by staleMs (age 2000 ≥ 1000) but YOUNG by residency (age 2000 < 10000) → hold.
  const res = ct.rebalance({ now: t0 + 2000, staleMs: 1000, minResidencyMs: 10000 });
  assert.strictEqual(res.rebalanced.length, 0, 'recently-placed task not moved again yet');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('rebalance hysteresis never strands an UNASSIGNED task (always placed)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p33unassigned');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const ct = require('../src/main/peripherals/cluster-tasks');
  const t0 = Date.now();
  process.env.LIKU_NODE_ID = 'nodeA';
  ct.publishTask({ id: 'u1', device: { id: 'd' }, priority: 'low', status: 'pending-review' });
  const res = ct.rebalance({ now: t0 + 1000, staleMs: 500, hysteresis: 100, minResidencyMs: 100000 });
  assert.strictEqual(res.rebalanced.length, 1, 'unassigned tasks bypass hysteresis/residency (no current node → no flap)');
  assert.strictEqual(res.rebalanced[0].to, 'nodeA');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('step-back COOLDOWN paces successive rungs but never blocks clear-schedule', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS = '0';
  delete process.env.LIKU_CLUSTER_DIR;
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  actions.clear();
  const base = new Date(2026, 6, 26, 12, 0, 0).getTime();
  for (let i = 0; i < 10; i++) actions.recordAnomaly({ device: 'devX', type: 'spike' }, base);
  actions.confirm(actions.proposeActions({}, base).find((p) => p.deviceId === 'devX').id);
  // Recorded step-back to rotate-token at `base` (controlled clock).
  actions.stepBackDevice('devX', 'rotate-token', base);
  // Within cooldown → the next intermediate rung is held.
  let de = actions.proposeDeescalations({ recoveryMs: 1, stepBack: true, stepBackCooldownMs: 100000 }, base + 50).find((x) => x.deviceId === 'devX');
  assert.strictEqual(de, undefined, 'successive step-back paced by cooldown');
  // After cooldown → the next rung is proposed.
  de = actions.proposeDeescalations({ recoveryMs: 1, stepBack: true, stepBackCooldownMs: 100000 }, base + 200000).find((x) => x.deviceId === 'devX');
  assert.strictEqual(de.action, 'stepback-reduce-schedule', 'next rung proposed once cooldown elapses');
  // Step down to reduce-schedule with a FRESH stamp; clear-schedule is NOT paced.
  actions.stepBackDevice('devX', 'reduce-schedule', base + 200000);
  de = actions.proposeDeescalations({ recoveryMs: 1, stepBack: true, stepBackCooldownMs: 100000 }, base + 200050).find((x) => x.deviceId === 'devX');
  assert.strictEqual(de.action, 'clear-schedule', 'clearing a restriction is never blocked by the cooldown');
  actions.clear();
  delete process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

// ── Phase 34: tick-health tasks + de-escalation observability + node-health fairness ──

test('buildTickHealthNotification is advisory-only (Class C health signal, never actuates)', () => {
  const { buildTickHealthNotification } = require('../src/main/agents/self-healing-scheduler');
  const n = buildTickHealthNotification({ gapMs: 5000, staleMs: 1000, advisory: 'stalled' });
  assert.strictEqual(n.autonomousAction, false);
  assert.strictEqual(n.requiresHuman, false);
  assert.strictEqual(n.device.class, 'C', 'read-only synthetic device');
  assert.strictEqual(n.source, 'self-heal');
  assert.strictEqual(n.dedupeKey, 'self-heal:tick-health');
  assert.strictEqual(n.severity, 'warning');
});

test('stalled tick optionally surfaces a human-gated Supervisor task (flag ON)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_SELF_HEAL_STALE_MS = '1000';
  process.env.LIKU_PERIPHERAL_SELF_HEAL_TICK_HEALTH_TASKS = '1';
  const status = require('../src/main/peripherals/self-heal-status');
  const { attachSelfHealingScheduler } = require('../src/main/agents/self-healing-scheduler');
  status.clear();
  const orch = new (require('events').EventEmitter)();
  const created = [];
  let notif = null;
  const supervisor = { receiveNotification(n) { notif = n; }, createPeripheralTask(n) { const t = { id: n.id, source: 'self-heal', status: 'pending-review', autonomousAction: false, dedupeKey: n.dedupeKey }; created.push(t); return t; } };
  let taskEv = null;
  orch.on('self-heal:tick-health-task', (t) => { taskEv = t; });
  const fakePal = { isPeripheralsEnabled: () => true, rebalanceClusterTasks: () => ({ rebalanced: [] }) };
  const fakeAdvisor = { proposeDeescalations: () => [], autoClearRecovered: () => ({ cleared: [] }) };
  const sh = attachSelfHealingScheduler(orch, { pal: fakePal, actionAdvisor: fakeAdvisor, getSupervisor: () => supervisor });
  const base = 1000000;
  status.record({ at: new Date(base).toISOString(), durationMs: 1, timings: {}, counts: {} });
  const res = sh.tick(base + 5000);
  assert.strictEqual(res.tickHealth.wasStale, true);
  assert.ok(res.tickHealthTask && res.tickHealthTask.source === 'self-heal', 'a tick-health task was created');
  assert.strictEqual(created.length, 1);
  assert.ok(notif && notif.autonomousAction === false && notif.requiresHuman === false, 'notification is advisory');
  assert.ok(taskEv, 'supervisor:task-health event emitted');
  sh.detach(); status.clear();
  delete process.env.LIKU_PERIPHERAL_SELF_HEAL_TICK_HEALTH_TASKS;
  delete process.env.LIKU_PERIPHERAL_SELF_HEAL_STALE_MS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('stalled tick does NOT create a task by default (flag OFF)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_SELF_HEAL_STALE_MS = '1000';
  delete process.env.LIKU_PERIPHERAL_SELF_HEAL_TICK_HEALTH_TASKS;
  const status = require('../src/main/peripherals/self-heal-status');
  const { attachSelfHealingScheduler } = require('../src/main/agents/self-healing-scheduler');
  status.clear();
  const orch = new (require('events').EventEmitter)();
  const created = [];
  const supervisor = { receiveNotification() {}, createPeripheralTask(n) { const t = { id: n.id }; created.push(t); return t; } };
  const fakePal = { isPeripheralsEnabled: () => true, rebalanceClusterTasks: () => ({ rebalanced: [] }) };
  const fakeAdvisor = { proposeDeescalations: () => [], autoClearRecovered: () => ({ cleared: [] }) };
  const sh = attachSelfHealingScheduler(orch, { pal: fakePal, actionAdvisor: fakeAdvisor, getSupervisor: () => supervisor });
  const base = 2000000;
  status.record({ at: new Date(base).toISOString(), durationMs: 1, timings: {}, counts: {} });
  const res = sh.tick(base + 5000);
  assert.strictEqual(res.tickHealth.wasStale, true, 'stall still detected (advisory event)');
  assert.strictEqual(res.tickHealthTask, undefined, 'but no task by default');
  assert.strictEqual(created.length, 0);
  sh.detach(); status.clear();
  delete process.env.LIKU_PERIPHERAL_SELF_HEAL_STALE_MS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('tick-health tasks reuse the Supervisor dedupe (coalesce by dedupeKey)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const { SupervisorAgent } = require('../src/main/agents');
  const { buildTickHealthNotification } = require('../src/main/agents/self-healing-scheduler');
  const sup = new SupervisorAgent({});
  sup.createPeripheralTask(buildTickHealthNotification({ gapMs: 5000, staleMs: 1000 }), { source: 'self-heal' });
  sup.createPeripheralTask(buildTickHealthNotification({ gapMs: 9000, staleMs: 1000 }), { source: 'self-heal' });
  const health = sup.getPeripheralTasks().filter((t) => t.device && t.device.id === 'self-heal');
  assert.strictEqual(health.length, 1, 'two stalls coalesce into ONE task (existing dedupe)');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('de-escalation history records step-back transitions (pure observation)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS = '0';
  delete process.env.LIKU_CLUSTER_DIR;
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  const hist = require('../src/main/peripherals/deescalation-history');
  actions.clear(); hist.clear();
  const base = new Date(2026, 6, 26, 12, 0, 0).getTime();
  for (let i = 0; i < 10; i++) actions.recordAnomaly({ device: 'devH', type: 'spike' }, base);
  actions.confirm(actions.proposeActions({}, base).find((p) => p.deviceId === 'devH').id);
  const r = actions.stepBackDevice('devH', 'rotate-token', base);
  assert.strictEqual(r.ok, true, 'step-back succeeds regardless of history');
  const h = hist.read();
  assert.strictEqual(h.devices.devH.stepBackCount, 1);
  assert.strictEqual(h.devices.devH.lastTo, 'rotate-token');
  assert.strictEqual(h.totals.stepBacks, 1);
  const state = hist.deviceState('devH', { now: base + 500, cooldownMs: 100000 });
  assert.strictEqual(state.known, true);
  assert.ok(state.cooldownRemainingMs > 0 && state.cooldownRemainingMs <= 100000, 'cooldown remaining computed');
  hist.clear(); actions.clear();
  delete process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('de-escalation history logs multiple transitions + a clear (does not alter behaviour)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS = '0';
  delete process.env.LIKU_CLUSTER_DIR;
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  const hist = require('../src/main/peripherals/deescalation-history');
  actions.clear(); hist.clear();
  const base = new Date(2026, 6, 26, 12, 0, 0).getTime();
  for (let i = 0; i < 10; i++) actions.recordAnomaly({ device: 'devH2', type: 'spike' }, base);
  actions.confirm(actions.proposeActions({}, base).find((p) => p.deviceId === 'devH2').id);
  actions.stepBackDevice('devH2', 'rotate-token', base);
  actions.stepBackDevice('devH2', 'reduce-schedule', base + 1000);
  assert.strictEqual(hist.read().devices.devH2.stepBackCount, 2, 'two step-backs logged');
  // A ladder reset (clear) is also recorded.
  for (let i = 0; i < 6; i++) actions.recordAnomaly({ device: 'devH3', type: 'spike' }, base);
  actions.confirm(actions.proposeActions({}, base).find((p) => p.deviceId === 'devH3').id);
  actions.resetDevice('devH3');
  const h = hist.read();
  assert.strictEqual(h.devices.devH3.clearCount, 1, 'clear recorded');
  assert.ok(h.totals.clears >= 1);
  hist.clear(); actions.clear();
  delete process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('PAL exposes de-escalation history + per-device state accessors', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const hist = require('../src/main/peripherals/deescalation-history');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  hist.clear();
  const base = new Date(2026, 6, 26, 12, 0, 0).getTime();
  hist.record({ deviceId: 'dP', from: 'unpair', to: 'rotate-token', kind: 'step-back', at: base });
  const H = pal.getDeescalationHistory();
  assert.strictEqual(H.enabled, true);
  assert.strictEqual(H.devices.dP.stepBackCount, 1);
  const S = pal.getDeescalationState('dP', { now: base + 100, cooldownMs: 100000 });
  assert.strictEqual(S.enabled, true);
  assert.strictEqual(S.known, true);
  assert.ok(S.cooldownRemainingMs > 0);
  hist.clear();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('node-health signal steers fairness AWAY from an unhealthy node (when enabled)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p34health');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const ct = require('../src/main/peripherals/cluster-tasks');
  const t0 = Date.now();
  process.env.LIKU_NODE_ID = 'nodeA';
  ct.publishTask({ id: 'ta', device: { id: 'd' }, priority: 'high', status: 'pending-review' });
  ct.claimTask('ta', { ttlMs: 300000, now: t0 }); // nodeA load 3
  ct.publishNodeHealth(0.5); // nodeA is only half-healthy
  process.env.LIKU_NODE_ID = 'nodeB';
  ct.publishTask({ id: 'tb', device: { id: 'd' }, priority: 'high', status: 'pending-review' });
  ct.claimTask('tb', { ttlMs: 300000, now: t0 }); // nodeB load 3 (healthy, no record)
  process.env.LIKU_NODE_ID = 'nodeA';
  ct.publishTask({ id: 'newt', device: { id: 'd' }, priority: 'high', status: 'pending-review' });
  const res = ct.rebalance({ now: t0 + 1000, staleMs: 500, useHealth: true });
  const mv = res.rebalanced.find((r) => r.taskId === 'newt');
  assert.strictEqual(mv.to, 'nodeB', 'equal load but healthier node wins (nodeA 3/0.5=6 > nodeB 3/1=3)');
  // Advisory: only assignment changed, ownership untouched (no double ownership).
  assert.strictEqual(ct.taskOwner('ta', t0 + 1000), 'nodeA');
  assert.strictEqual(ct.taskOwner('newt', t0 + 1000), null);
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('node-health is inert by default (OFF → Phase-33 scoring unchanged)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p34healthoff');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const ct = require('../src/main/peripherals/cluster-tasks');
  const t0 = Date.now();
  process.env.LIKU_NODE_ID = 'nodeA';
  ct.publishTask({ id: 'ta2', device: { id: 'd' }, priority: 'high', status: 'pending-review' });
  ct.claimTask('ta2', { ttlMs: 300000, now: t0 });
  ct.publishNodeHealth(0.5); // published, but health weighting is OFF
  process.env.LIKU_NODE_ID = 'nodeB';
  ct.publishTask({ id: 'tb2', device: { id: 'd' }, priority: 'high', status: 'pending-review' });
  ct.claimTask('tb2', { ttlMs: 300000, now: t0 });
  process.env.LIKU_NODE_ID = 'nodeA';
  ct.publishTask({ id: 'newt2', device: { id: 'd' }, priority: 'high', status: 'pending-review' });
  const res = ct.rebalance({ now: t0 + 1000, staleMs: 500 }); // useHealth NOT set
  const mv = res.rebalanced.find((r) => r.taskId === 'newt2');
  assert.strictEqual(mv.to, 'nodeA', 'health ignored → deterministic tiebreak by nodeId (nodeA)');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('publishNodeHealth is inert single-machine + clamps the score', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const ct = require('../src/main/peripherals/cluster-tasks');
  const res = ct.publishNodeHealth(0.7);
  assert.strictEqual(res.published, false, 'no publish single-machine');
  assert.strictEqual(res.local, true);
  const clusterDir = require('path').join(TMP_HOME, 'p34clamp');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  process.env.LIKU_NODE_ID = 'clampNode';
  const coordination = require('../src/main/peripherals/coordination');
  ct.publishNodeHealth(2); // clamps to 1
  assert.strictEqual(coordination.getShared('node-health', 'clampNode').score, 1, 'score clamped to 1');
  ct.publishNodeHealth(-3); // clamps to 0
  assert.strictEqual(coordination.getShared('node-health', 'clampNode').score, 0, 'score clamped to 0');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

// ── Phase 35: auto-health + tick-health recovery auto-clear + trends/rollups ──

test('deriveNodeHealth is deterministic + bounded (health = 1 − contentionRate)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const ct = require('../src/main/peripherals/cluster-tasks');
  assert.strictEqual(ct.deriveNodeHealth({ metrics: { acquired: 0, contended: 0 } }).score, 1, 'no contention → fully healthy');
  assert.strictEqual(ct.deriveNodeHealth({ metrics: { acquired: 100, contended: 50 } }).score, 0.5, 'half contended → 0.5');
  const heavy = ct.deriveNodeHealth({ metrics: { acquired: 10, contended: 40 } });
  assert.ok(heavy.score >= 0 && heavy.score <= 1, 'score is bounded 0..1');
  assert.strictEqual(heavy.score, 0, 'over-contended clamps to 0');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('auto-derived node-health influences fairness (unhealthy node avoided)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p35autohealth');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const ct = require('../src/main/peripherals/cluster-tasks');
  const t0 = Date.now();
  process.env.LIKU_NODE_ID = 'nodeA';
  ct.publishTask({ id: 'ha', device: { id: 'd' }, priority: 'high', status: 'pending-review' });
  ct.claimTask('ha', { ttlMs: 300000, now: t0 });
  ct.publishDerivedNodeHealth({ metrics: { acquired: 100, contended: 80 } }); // nodeA derived score 0.2
  process.env.LIKU_NODE_ID = 'nodeB';
  ct.publishTask({ id: 'hb', device: { id: 'd' }, priority: 'high', status: 'pending-review' });
  ct.claimTask('hb', { ttlMs: 300000, now: t0 });
  process.env.LIKU_NODE_ID = 'nodeA';
  ct.publishTask({ id: 'newt', device: { id: 'd' }, priority: 'high', status: 'pending-review' });
  const res = ct.rebalance({ now: t0 + 1000, staleMs: 500, useHealth: true });
  assert.strictEqual(res.rebalanced.find((r) => r.taskId === 'newt').to, 'nodeB', 'derived-unhealthy nodeA avoided');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('tick-health task is auto-cleared after a recovery tick (flag ON)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_SELF_HEAL_STALE_MS = '1000';
  process.env.LIKU_PERIPHERAL_SELF_HEAL_TICK_HEALTH_TASKS = '1';
  process.env.LIKU_PERIPHERAL_SELF_HEAL_TICK_HEALTH_AUTOCLEAR = '1';
  const status = require('../src/main/peripherals/self-heal-status');
  const { SupervisorAgent } = require('../src/main/agents');
  const { attachSelfHealingScheduler } = require('../src/main/agents/self-healing-scheduler');
  status.clear();
  const sup = new SupervisorAgent({});
  const orch = new (require('events').EventEmitter)();
  const fakePal = { isPeripheralsEnabled: () => true, rebalanceClusterTasks: () => ({ rebalanced: [] }) };
  const fakeAdvisor = { proposeDeescalations: () => [], autoClearRecovered: () => ({ cleared: [] }) };
  const sh = attachSelfHealingScheduler(orch, { pal: fakePal, actionAdvisor: fakeAdvisor, getSupervisor: () => sup });
  const base = 3000000;
  status.record({ at: new Date(base).toISOString(), durationMs: 1, timings: {}, counts: {}, stalled: false });
  // Stall tick → creates the tick-health task.
  const r1 = sh.tick(base + 5000);
  assert.strictEqual(r1.tickHealth.wasStale, true);
  assert.strictEqual(sup.getPendingPeripheralTasks().filter((t) => t.device.id === 'self-heal').length, 1, 'tick-health task created');
  // Recovery tick (healthy gap) → auto-clears it.
  const r2 = sh.tick(base + 5100);
  assert.strictEqual(r2.tickHealthRecovered, true, 'recovery detected');
  assert.ok((r2.tickHealthCleared || []).length >= 1, 'a tick-health task was cleared');
  assert.strictEqual(sup.getPendingPeripheralTasks().filter((t) => t.device.id === 'self-heal').length, 0, 'no lingering tick-health task');
  sh.detach(); status.clear();
  delete process.env.LIKU_PERIPHERAL_SELF_HEAL_TICK_HEALTH_AUTOCLEAR;
  delete process.env.LIKU_PERIPHERAL_SELF_HEAL_TICK_HEALTH_TASKS;
  delete process.env.LIKU_PERIPHERAL_SELF_HEAL_STALE_MS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('tick-health auto-clear ONLY touches the tick-health task (other tasks untouched)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_SELF_HEAL_STALE_MS = '1000';
  process.env.LIKU_PERIPHERAL_SELF_HEAL_TICK_HEALTH_TASKS = '1';
  process.env.LIKU_PERIPHERAL_SELF_HEAL_TICK_HEALTH_AUTOCLEAR = '1';
  const status = require('../src/main/peripherals/self-heal-status');
  const { SupervisorAgent } = require('../src/main/agents');
  const { attachSelfHealingScheduler } = require('../src/main/agents/self-healing-scheduler');
  status.clear();
  const sup = new SupervisorAgent({});
  // A normal (non-tick-health) task the human must still review.
  sup.createPeripheralTask({ id: 'n1', device: { id: 'heater', class: 'A' }, breach: { metric: 'power', level: 'over-budget' }, severity: 'critical', requiresHuman: true, autonomousAction: false }, { source: 'power-anomaly' });
  const orch = new (require('events').EventEmitter)();
  const fakePal = { isPeripheralsEnabled: () => true, rebalanceClusterTasks: () => ({ rebalanced: [] }) };
  const fakeAdvisor = { proposeDeescalations: () => [], autoClearRecovered: () => ({ cleared: [] }) };
  const sh = attachSelfHealingScheduler(orch, { pal: fakePal, actionAdvisor: fakeAdvisor, getSupervisor: () => sup });
  const base = 4000000;
  status.record({ at: new Date(base).toISOString(), durationMs: 1, timings: {}, counts: {}, stalled: false });
  sh.tick(base + 5000); // stall → tick-health task
  sh.tick(base + 5100); // recovery → auto-clear tick-health only
  const heater = sup.getPeripheralTasks().find((t) => t.device.id === 'heater');
  assert.strictEqual(heater.status, 'pending-review', 'the heater task is NOT auto-cleared');
  assert.strictEqual(sup.getPendingPeripheralTasks().filter((t) => t.device.id === 'self-heal').length, 0, 'tick-health task cleared');
  sh.detach(); status.clear();
  delete process.env.LIKU_PERIPHERAL_SELF_HEAL_TICK_HEALTH_AUTOCLEAR;
  delete process.env.LIKU_PERIPHERAL_SELF_HEAL_TICK_HEALTH_TASKS;
  delete process.env.LIKU_PERIPHERAL_SELF_HEAL_STALE_MS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('tick-health auto-clear is OFF by default (task lingers)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_SELF_HEAL_STALE_MS = '1000';
  process.env.LIKU_PERIPHERAL_SELF_HEAL_TICK_HEALTH_TASKS = '1';
  delete process.env.LIKU_PERIPHERAL_SELF_HEAL_TICK_HEALTH_AUTOCLEAR;
  const status = require('../src/main/peripherals/self-heal-status');
  const { SupervisorAgent } = require('../src/main/agents');
  const { attachSelfHealingScheduler } = require('../src/main/agents/self-healing-scheduler');
  status.clear();
  const sup = new SupervisorAgent({});
  const orch = new (require('events').EventEmitter)();
  const fakePal = { isPeripheralsEnabled: () => true, rebalanceClusterTasks: () => ({ rebalanced: [] }) };
  const fakeAdvisor = { proposeDeescalations: () => [], autoClearRecovered: () => ({ cleared: [] }) };
  const sh = attachSelfHealingScheduler(orch, { pal: fakePal, actionAdvisor: fakeAdvisor, getSupervisor: () => sup });
  const base = 5000000;
  status.record({ at: new Date(base).toISOString(), durationMs: 1, timings: {}, counts: {}, stalled: false });
  sh.tick(base + 5000);
  const r2 = sh.tick(base + 5100);
  assert.strictEqual(r2.tickHealthRecovered, true, 'recovery still detected');
  assert.strictEqual(r2.tickHealthCleared, undefined, 'but nothing auto-cleared by default');
  assert.strictEqual(sup.getPendingPeripheralTasks().filter((t) => t.device.id === 'self-heal').length, 1, 'task lingers');
  sh.detach(); status.clear();
  delete process.env.LIKU_PERIPHERAL_SELF_HEAL_TICK_HEALTH_TASKS;
  delete process.env.LIKU_PERIPHERAL_SELF_HEAL_STALE_MS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('de-escalation trends report windowed counts + rates + cooldown (pure observation)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const hist = require('../src/main/peripherals/deescalation-history');
  hist.clear();
  const base = new Date(2026, 6, 26, 12, 0, 0).getTime();
  hist.record({ deviceId: 'dT', from: 'unpair', to: 'rotate-token', kind: 'step-back', at: base });
  hist.record({ deviceId: 'dT', from: 'rotate-token', to: 'reduce-schedule', kind: 'step-back', at: base + 1000 });
  hist.record({ deviceId: 'dT', from: null, to: null, kind: 'clear', at: base + 2000 });
  const before = hist.read().devices.dT.stepBackCount;
  const tr = hist.trends({ now: base + 3000, windowMs: 3600000, cooldownMs: 100000 });
  assert.strictEqual(tr.deviceCount, 1);
  const d = tr.devices.find((x) => x.deviceId === 'dT');
  assert.strictEqual(d.recentStepBacks, 2);
  assert.strictEqual(d.recentClears, 1);
  assert.ok(d.ratePerHour > 0 && d.cooldownRemainingMs > 0, 'rate + cooldown computed');
  assert.strictEqual(tr.recent.stepBacks, 2);
  // Pure observation: reading trends did not change the store.
  assert.strictEqual(hist.read().devices.dT.stepBackCount, before);
  hist.clear();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('de-escalation cluster rollup merges peer summaries', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p35deescrollup');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const coordination = require('../src/main/peripherals/coordination');
  const hist = require('../src/main/peripherals/deescalation-history');
  process.env.LIKU_NODE_ID = 'nodeA';
  coordination.putShared('deescalation-summary', 'nodeA', { totals: { stepBacks: 3, clears: 1 }, deviceCount: 2 });
  process.env.LIKU_NODE_ID = 'nodeB';
  coordination.putShared('deescalation-summary', 'nodeB', { totals: { stepBacks: 5, clears: 2 }, deviceCount: 3 });
  const roll = hist.clusterRollup({});
  assert.strictEqual(roll.mode, 'cluster');
  assert.strictEqual(roll.nodes, 2);
  assert.strictEqual(roll.totals.stepBacks, 8, 'step-backs summed across nodes');
  assert.strictEqual(roll.totals.clears, 3);
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('lock cluster file-trends aggregate per-file contention across nodes (durable/pure)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p35locktrend');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  process.env.LIKU_NODE_ID = 'nA';
  const p = require('path');
  const mdir = p.join(clusterDir, 'lock-metrics');
  fs.mkdirSync(mdir, { recursive: true });
  fs.writeFileSync(p.join(mdir, 'nA.json'), JSON.stringify({ nodeId: 'nA', at: new Date().toISOString(), metrics: { acquired: 10, contended: 2 }, perFile: { 'store.json': { acquired: 10, contended: 2, steals: 0 } } }));
  fs.writeFileSync(p.join(mdir, 'nB.json'), JSON.stringify({ nodeId: 'nB', at: new Date().toISOString(), metrics: { acquired: 20, contended: 10 }, perFile: { 'store.json': { acquired: 20, contended: 10, steals: 1 } } }));
  const lockHistory = require('../src/main/peripherals/lock-history');
  const ct = lockHistory.clusterFileTrends();
  assert.strictEqual(ct.mode, 'cluster');
  assert.ok(ct.nodes >= 2);
  const sf = ct.files.find((f) => f.file === 'store.json');
  assert.strictEqual(sf.acquired, 30, 'per-file acquired summed across nodes');
  assert.strictEqual(sf.contended, 12, 'per-file contended summed across nodes');
  assert.ok(Math.abs(sf.contentionRate - 12 / 30) < 0.01, 'cluster contention rate');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('lock cluster file-trends fall back to this node single-machine (pure observation)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const lockHistory = require('../src/main/peripherals/lock-history');
  const ct = lockHistory.clusterFileTrends();
  assert.strictEqual(ct.mode, 'single-machine', 'single-machine view when no cluster dir');
  assert.ok(Array.isArray(ct.files));
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('PAL exposes Phase 35 trend / rollup / derived-health accessors', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  assert.strictEqual(pal.deriveNodeHealth({ metrics: { acquired: 100, contended: 50 } }).score, 0.5);
  assert.ok(Array.isArray(pal.getDeescalationTrends().devices));
  assert.ok(typeof pal.getDeescalationRollup().totals === 'object');
  assert.ok(Array.isArray(pal.getLockClusterTrends().files));
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

// ── Phase 36: multi-signal health + recovery ack/mirror + flapping + fleet view ──

test('deriveNodeHealth is single-signal by default + multi-signal when enabled', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_NODE_HEALTH_MULTI;
  const ct = require('../src/main/peripherals/cluster-tasks');
  // Default (single) → lock-only, byte-compatible with Phase 35.
  assert.strictEqual(ct.deriveNodeHealth({ metrics: { acquired: 100, contended: 50 } }).score, 0.5);
  // Multi-signal folds a stalled tick: penalty = 0.6*0.5 + 0.4*1 = 0.7 → 0.3.
  const stalled = ct.deriveNodeHealth({ metrics: { acquired: 100, contended: 50 }, multi: true, tick: { stalled: true } });
  assert.strictEqual(stalled.score, 0.3);
  assert.strictEqual(stalled.tickPenalty, 1);
  // A slow (non-stalled) tick: contention 0, tick 5000/5000=1 → penalty 0.4 → 0.6.
  const slow = ct.deriveNodeHealth({ metrics: { acquired: 0, contended: 0 }, multi: true, tick: { durationMs: 5000 } });
  assert.strictEqual(slow.score, 0.6);
  // Bounded 0..1.
  const worst = ct.deriveNodeHealth({ metrics: { acquired: 10, contended: 40 }, multi: true, tick: { stalled: true } });
  assert.ok(worst.score >= 0 && worst.score <= 1);
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('multi-signal health reads the self-heal tick signal via the env flag', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_NODE_HEALTH_MULTI = '1';
  const status = require('../src/main/peripherals/self-heal-status');
  const ct = require('../src/main/peripherals/cluster-tasks');
  status.clear();
  // Record a STALLED tick → multi-signal folds the tick penalty (0.4) even with no contention.
  status.record({ at: new Date().toISOString(), durationMs: 1, timings: {}, counts: {}, stalled: true });
  const d = ct.deriveNodeHealth({ metrics: { acquired: 0, contended: 0 } });
  assert.strictEqual(d.score, 0.6, 'stalled tick → 0.4 penalty → 0.6 health');
  status.clear();
  delete process.env.LIKU_PERIPHERAL_NODE_HEALTH_MULTI;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('multi-signal derived health influences fairness (struggling node avoided)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p36multi');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const ct = require('../src/main/peripherals/cluster-tasks');
  const t0 = Date.now();
  process.env.LIKU_NODE_ID = 'nodeA';
  ct.publishTask({ id: 'ma', device: { id: 'd' }, priority: 'high', status: 'pending-review' });
  ct.claimTask('ma', { ttlMs: 300000, now: t0 });
  ct.publishDerivedNodeHealth({ multi: true, tick: { stalled: true }, metrics: { acquired: 0, contended: 0 } }); // nodeA → 0.6
  process.env.LIKU_NODE_ID = 'nodeB';
  ct.publishTask({ id: 'mb', device: { id: 'd' }, priority: 'high', status: 'pending-review' });
  ct.claimTask('mb', { ttlMs: 300000, now: t0 });
  process.env.LIKU_NODE_ID = 'nodeA';
  ct.publishTask({ id: 'newt', device: { id: 'd' }, priority: 'high', status: 'pending-review' });
  const res = ct.rebalance({ now: t0 + 1000, staleMs: 500, useHealth: true });
  assert.strictEqual(res.rebalanced.find((r) => r.taskId === 'newt').to, 'nodeB', 'struggling nodeA (0.6) avoided vs healthy nodeB');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('tick-health recovery acknowledges the notification + mirrors recovered cluster state', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_SELF_HEAL_STALE_MS = '1000';
  process.env.LIKU_PERIPHERAL_SELF_HEAL_TICK_HEALTH_TASKS = '1';
  process.env.LIKU_PERIPHERAL_SELF_HEAL_TICK_HEALTH_AUTOCLEAR = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p36recovery');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  process.env.LIKU_NODE_ID = 'nodeA';
  const coordination = require('../src/main/peripherals/coordination');
  const status = require('../src/main/peripherals/self-heal-status');
  const { SupervisorAgent } = require('../src/main/agents');
  const { attachSelfHealingScheduler } = require('../src/main/agents/self-healing-scheduler');
  status.clear();
  const sup = new SupervisorAgent({});
  const orch = new (require('events').EventEmitter)();
  const fakePal = { isPeripheralsEnabled: () => true, rebalanceClusterTasks: () => ({ rebalanced: [] }) };
  const fakeAdvisor = { proposeDeescalations: () => [], autoClearRecovered: () => ({ cleared: [] }) };
  const sh = attachSelfHealingScheduler(orch, { pal: fakePal, actionAdvisor: fakeAdvisor, getSupervisor: () => sup });
  const base = 6000000;
  status.record({ at: new Date(base).toISOString(), durationMs: 1, timings: {}, counts: {}, stalled: false });
  sh.tick(base + 5000); // stall → task + notification + cluster mirror stalled:true
  assert.ok(sup.getPendingNotifications().some((n) => n.source === 'self-heal' && n.kind === 'tick-health'), 'notification created');
  assert.strictEqual(coordination.getShared('tick-health', 'nodeA').stalled, true, 'stalled mirrored to cluster');
  const r2 = sh.tick(base + 5100); // recovery
  assert.strictEqual(r2.tickHealthRecovered, true);
  assert.ok((r2.tickHealthAcked || []).length >= 1, 'notification acknowledged on recovery');
  assert.ok(!sup.getPendingNotifications().some((n) => n.source === 'self-heal'), 'no lingering tick-health notification');
  assert.strictEqual(coordination.getShared('tick-health', 'nodeA').stalled, false, 'recovered mirrored to cluster');
  sh.detach(); status.clear();
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_PERIPHERAL_SELF_HEAL_TICK_HEALTH_AUTOCLEAR;
  delete process.env.LIKU_PERIPHERAL_SELF_HEAL_TICK_HEALTH_TASKS;
  delete process.env.LIKU_PERIPHERAL_SELF_HEAL_STALE_MS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('clusterTickHealth reports which nodes are currently stalled', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p36tickcluster');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  const ct = require('../src/main/peripherals/cluster-tasks');
  process.env.LIKU_NODE_ID = 'nA';
  ct.publishTickHealth(true);
  process.env.LIKU_NODE_ID = 'nB';
  ct.publishTickHealth(false);
  const cth = ct.clusterTickHealth();
  assert.strictEqual(cth.mode, 'cluster');
  assert.strictEqual(cth.nodes, 2);
  assert.strictEqual(cth.stalled, 1, 'exactly one node stalled');
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('de-escalation flapping detection flags a device over the threshold (pure observation)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const hist = require('../src/main/peripherals/deescalation-history');
  hist.clear();
  const base = new Date(2026, 6, 26, 12, 0, 0).getTime();
  for (let i = 0; i < 3; i++) hist.record({ deviceId: 'flapDev', from: 'unpair', to: 'rotate-token', kind: 'step-back', at: base + i * 1000 });
  hist.record({ deviceId: 'calmDev', from: 'unpair', to: 'rotate-token', kind: 'step-back', at: base });
  const before = hist.read().devices.flapDev.stepBackCount;
  const fl = hist.flapping({ now: base + 5000, windowMs: 3600000, threshold: 3 });
  assert.ok(fl.devices.some((d) => d.deviceId === 'flapDev'), 'flapping device flagged (3 ≥ 3)');
  assert.ok(!fl.devices.some((d) => d.deviceId === 'calmDev'), 'calm device not flagged (1 < 3)');
  // Pure observation: detection did not change the store.
  assert.strictEqual(hist.read().devices.flapDev.stepBackCount, before);
  hist.clear();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('flapping alert is surfaced as an advisory task when enabled', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_DEESC_FLAP_ALERTS = '1';
  process.env.LIKU_PERIPHERAL_DEESC_FLAP_THRESHOLD = '3';
  delete process.env.LIKU_CLUSTER_DIR;
  const hist = require('../src/main/peripherals/deescalation-history');
  const { attachSelfHealingScheduler } = require('../src/main/agents/self-healing-scheduler');
  hist.clear();
  const base = Date.now();
  for (let i = 0; i < 3; i++) hist.record({ deviceId: 'flapDev', from: 'unpair', to: 'rotate-token', kind: 'step-back', at: base + i });
  const created = [];
  const sup = { receiveNotification() {}, createPeripheralTask(n) { const t = { id: n.id, device: n.device, source: 'self-heal-flapping' }; created.push(t); return t; } };
  const orch = new (require('events').EventEmitter)();
  const fakePal = { isPeripheralsEnabled: () => true, rebalanceClusterTasks: () => ({ rebalanced: [] }) };
  const fakeAdvisor = { proposeDeescalations: () => [], autoClearRecovered: () => ({ cleared: [] }) };
  const sh = attachSelfHealingScheduler(orch, { pal: fakePal, actionAdvisor: fakeAdvisor, getSupervisor: () => sup });
  const res = sh.tick(base + 100);
  assert.ok((res.flapping || []).some((d) => d.deviceId === 'flapDev'), 'flapping device detected on the tick');
  assert.ok((res.flappingTasks || []).length >= 1, 'advisory flapping task created');
  assert.strictEqual(created[0].device.id, 'flapDev');
  sh.detach(); hist.clear();
  delete process.env.LIKU_PERIPHERAL_DEESC_FLAP_THRESHOLD;
  delete process.env.LIKU_PERIPHERAL_DEESC_FLAP_ALERTS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('flapping alert is OFF by default (no task; de-escalation behaviour unchanged)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_DEESC_FLAP_ALERTS;
  delete process.env.LIKU_CLUSTER_DIR;
  const hist = require('../src/main/peripherals/deescalation-history');
  const { attachSelfHealingScheduler } = require('../src/main/agents/self-healing-scheduler');
  hist.clear();
  const base = Date.now();
  for (let i = 0; i < 3; i++) hist.record({ deviceId: 'flapDev', from: 'unpair', to: 'rotate-token', kind: 'step-back', at: base + i });
  const before = JSON.stringify(hist.read());
  const created = [];
  const sup = { receiveNotification() {}, createPeripheralTask(n) { created.push(n); return { id: n.id }; } };
  const orch = new (require('events').EventEmitter)();
  const fakePal = { isPeripheralsEnabled: () => true, rebalanceClusterTasks: () => ({ rebalanced: [] }) };
  const fakeAdvisor = { proposeDeescalations: () => [], autoClearRecovered: () => ({ cleared: [] }) };
  const sh = attachSelfHealingScheduler(orch, { pal: fakePal, actionAdvisor: fakeAdvisor, getSupervisor: () => sup });
  const res = sh.tick(base + 100);
  assert.strictEqual(res.flapping, undefined, 'no flapping surfaced by default');
  assert.strictEqual(created.length, 0, 'no flapping task by default');
  assert.strictEqual(JSON.stringify(hist.read()), before, 'history unchanged (pure observation)');
  sh.detach(); hist.clear();
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('getFleetObservability returns a coherent read-only aggregate (cluster)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const clusterDir = require('path').join(TMP_HOME, 'p36fleet');
  process.env.LIKU_CLUSTER_DIR = clusterDir;
  process.env.LIKU_NODE_ID = 'nodeA';
  const status = require('../src/main/peripherals/self-heal-status');
  const hist = require('../src/main/peripherals/deescalation-history');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  status.clear(); hist.clear();
  status.record({ at: new Date().toISOString(), durationMs: 2, timings: {}, counts: {}, stalled: false });
  hist.record({ deviceId: 'd', from: 'unpair', to: 'rotate-token', kind: 'step-back' });
  const f = pal.getFleetObservability();
  assert.strictEqual(f.enabled, true);
  assert.strictEqual(f.mode, 'cluster');
  assert.ok(f.selfHeal && f.selfHeal.lastRun, 'self-heal last-run present');
  assert.ok(f.nodeHealth && typeof f.nodeHealth.local.score === 'number', 'node-health present');
  assert.ok(f.deescalation && Array.isArray(f.deescalation.flapping), 'de-escalation present');
  assert.ok(f.locks && f.locks.mode === 'cluster', 'lock cluster trends present');
  status.clear(); hist.clear();
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(clusterDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('getFleetObservability works single-machine + PAL Phase 36 accessors are read-only', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR;
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  const f = pal.getFleetObservability();
  assert.strictEqual(f.enabled, true);
  assert.strictEqual(f.mode, 'single-machine', 'single-machine aggregate');
  assert.ok(Array.isArray(pal.getDeescalationFlapping().devices));
  const cth = pal.getClusterTickHealth();
  assert.strictEqual(cth.mode, 'single-machine');
  // Calling the aggregate twice is stable (read-only, no mutation).
  const f2 = pal.getFleetObservability();
  assert.strictEqual(f2.mode, 'single-machine');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

// ---------------------------------------------------------------------------
// Phase 37 — device-surface expansion: Matter commissioning + Thread / Z-Wave /
// USB-HID / KNX drivers. Each new driver inherits the DCP → class gate →
// pending/confirm safety chain from the PAL and is HIL-isolated.
// ---------------------------------------------------------------------------

test('Matter commissioning: HIL virtual commission marks device paired (no real fabric)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_HIL = '1';
  delete process.env.LIKU_MATTER_FABRIC;
  process.env.LIKU_MATTER_DEVICES = JSON.stringify([
    { id: 'mt-comm-hil', name: 'Plug', class: 'B', kind: 'switch', capabilities: ['on', 'off'], powerW: 6, setupCode: '20202021' }
  ]);
  const matter = require('../src/main/peripherals/drivers/matter-driver');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const disc = pal.getCommissionableDevices();
  assert.strictEqual(disc.enabled, true, 'commissionable discovery enabled');
  assert.ok(disc.devices.some((d) => d.driver === 'matter'), 'matter contributes commissionable devices in HIL');
  const res = pal.commissionDevice('mt-comm-hil', { code: '20202021' });
  assert.strictEqual(res.enabled, true);
  assert.strictEqual(res.ok, true, 'HIL commission succeeded');
  assert.strictEqual(res.simulated, true, 'HIL commission is virtual');
  delete process.env.LIKU_PERIPHERAL_HIL;
  delete process.env.LIKU_MATTER_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Matter commissioning: real fake-lib path invokes commissionNode + resolves endpoint', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;
  process.env.LIKU_MATTER_FABRIC = 'fabric-1';
  process.env.LIKU_MATTER_DEVICES = JSON.stringify([
    { id: 'mt-comm-r1', name: 'Plug', class: 'B', kind: 'switch', capabilities: ['on', 'off'], powerW: 8, nodeId: '3003', endpoint: 1, setupCode: 'MT:CODE' }
  ]);
  const matter = require('../src/main/peripherals/drivers/matter-driver');
  const fake = makeFakeMatter([{ nodeId: '3003' }]);
  const commissioned = [];
  fake.lib.CommissioningController.prototype.commissionNode = function (code, opts) { commissioned.push({ code, opts }); return Promise.resolve({ nodeId: (opts && opts.nodeId) || '3003' }); };
  matter._setMatterLibForTest(fake.lib);
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const res = pal.commissionDevice('mt-comm-r1', { code: 'MT:CODE' });
  assert.strictEqual(res.ok, true, 'real commission succeeded');
  assert.ok(commissioned.length >= 1, 'commissionNode invoked on the controller');
  assert.strictEqual(commissioned[0].code, 'MT:CODE', 'setup code forwarded');
  matter._setMatterLibForTest(null);
  delete process.env.LIKU_MATTER_FABRIC;
  delete process.env.LIKU_MATTER_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

/** Generic fake mesh transport lib: emits inbound + records outbound sends. */
function makeFakeMesh(spec) {
  const EventEmitter = require('events');
  const created = [];
  const sent = [];
  const Ctor = spec.ctorName || 'Controller';
  const cls = class extends EventEmitter {
    constructor() { super(); created.push(this); }
    start() { return Promise.resolve(); }
    stop() {}
  };
  // Attach resolve/send hooks used by the driver transport.
  cls.prototype.getDeviceByAddr = function (addr) { return { getEndpoint: () => ({ send: (a, p) => { sent.push({ addr, act: a, params: p }); return Promise.resolve(); } }) }; };
  cls.prototype.getNode = function (id) { return { command: (a, p) => { sent.push({ id, act: a, params: p }); return Promise.resolve(); }, setValue: (a, p) => { sent.push({ id, act: a, params: p }); return Promise.resolve(); } }; };
  cls.prototype.write = function (ga, value) { sent.push({ ga, value }); };
  const lib = { [Ctor]: cls };
  return { lib, created, sent, push: (event, msg) => { for (const c of created) c.emit(event, msg); } };
}

test('Thread driver: Class B real fake-lib actuation dispatches through mesh send', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;
  process.env.LIKU_THREAD_BORDER_ROUTER = '/dev/fake-thread';
  process.env.LIKU_THREAD_DEVICES = JSON.stringify([
    { id: 'th-plug-r1', name: 'Plug', class: 'B', kind: 'switch', capabilities: ['on', 'off'], powerW: 9, address: 'fd00::1', endpoint: 1 }
  ]);
  const th = require('../src/main/peripherals/drivers/thread-driver');
  const fake = makeFakeMesh({ ctorName: 'BorderRouter' });
  th._setThreadLibForTest(fake.lib);
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  assert.ok(pal.listDrivers().drivers.includes('thread'), 'thread available via border router');
  const stop = pal.startStreaming();
  const rB = pal.execute('th-plug-r1', 'on');
  assert.strictEqual(rB.ok, true, 'Class B real thread command succeeded');
  assert.ok(fake.sent.some((s) => s.act === 'on'), 'mesh send dispatched');
  stop();
  th._setThreadLibForTest(null);
  delete process.env.LIKU_THREAD_BORDER_ROUTER;
  delete process.env.LIKU_THREAD_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Thread driver: Class A confirm-gated even when connected (safety chain inherited)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;
  process.env.LIKU_THREAD_BORDER_ROUTER = '/dev/fake-thread';
  process.env.LIKU_THREAD_DEVICES = JSON.stringify([
    { id: 'th-lock-r1', name: 'Lock', class: 'A', kind: 'lock', capabilities: ['lock', 'unlock'], powerW: 3, address: 'fd00::2', endpoint: 1 }
  ]);
  const th = require('../src/main/peripherals/drivers/thread-driver');
  const fake = makeFakeMesh({ ctorName: 'BorderRouter' });
  th._setThreadLibForTest(fake.lib);
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const stop = pal.startStreaming();
  const rA = pal.execute('th-lock-r1', 'unlock');
  assert.strictEqual(rA.pending, true, 'Class A gated despite connection');
  assert.ok(!fake.sent.some((s) => s.act === 'unlock'), 'no send before confirm');
  pal.authorize('th-lock-r1', 'unlock');
  const rA2 = pal.execute('th-lock-r1', 'unlock');
  assert.strictEqual(rA2.ok, true, 'confirmed Class A dispatches');
  assert.ok(fake.sent.some((s) => s.act === 'unlock'), 'send after confirm');
  stop();
  th._setThreadLibForTest(null);
  delete process.env.LIKU_THREAD_BORDER_ROUTER;
  delete process.env.LIKU_THREAD_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Thread driver: HIL path is isolated (no real lib touched) and safety-gated', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_HIL = '1';
  delete process.env.LIKU_THREAD_BORDER_ROUTER;
  process.env.LIKU_THREAD_DEVICES = JSON.stringify([
    { id: 'th-led-hil', name: 'LED', class: 'B', kind: 'light', capabilities: ['on', 'off'], powerW: 4 },
    { id: 'th-lock-hil', name: 'Lock', class: 'A', kind: 'lock', capabilities: ['lock', 'unlock'], powerW: 5 }
  ]);
  const th = require('../src/main/peripherals/drivers/thread-driver');
  const fake = makeFakeMesh({ ctorName: 'BorderRouter' });
  th._setThreadLibForTest(fake.lib);
  assert.strictEqual(th.isAvailable(), true, 'available in HIL without a border router');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const rB = pal.execute('th-led-hil', 'on');
  assert.strictEqual(rB.ok, true);
  assert.strictEqual(rB.result.simulated, true, 'HIL executed Class B');
  const rA = pal.execute('th-lock-hil', 'unlock');
  assert.strictEqual(rA.pending, true, 'Class A gated in HIL');
  assert.strictEqual(fake.created.length, 0, 'no real controller constructed in HIL');
  assert.strictEqual(fake.sent.length, 0, 'no real send in HIL');
  th._setThreadLibForTest(null);
  delete process.env.LIKU_PERIPHERAL_HIL;
  delete process.env.LIKU_THREAD_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Z-Wave driver: Class B real fake-lib actuation dispatches; Class A confirm-gated', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;
  process.env.LIKU_ZWAVE_CONTROLLER = '/dev/fake-zwave';
  process.env.LIKU_ZWAVE_DEVICES = JSON.stringify([
    { id: 'zw-plug-r1', name: 'Plug', class: 'B', kind: 'switch', capabilities: ['on', 'off'], powerW: 10, nodeId: 5 },
    { id: 'zw-lock-r1', name: 'Lock', class: 'A', kind: 'lock', capabilities: ['lock', 'unlock'], powerW: 3, nodeId: 6 }
  ]);
  const zw = require('../src/main/peripherals/drivers/zwave-driver');
  const fake = makeFakeMesh({ ctorName: 'Driver' });
  zw._setZwaveLibForTest(fake.lib);
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  assert.ok(pal.listDrivers().drivers.includes('zwave'), 'zwave available via controller');
  const stop = pal.startStreaming();
  assert.strictEqual(pal.execute('zw-plug-r1', 'on').ok, true, 'Class B dispatched');
  // Phase 38: real command-class semantics — 'on' → Binary Switch (CC 37) setValue(targetValue,true).
  assert.ok(fake.sent.some((s) => s.act && s.act.commandClass === 37 && s.params === true), 'zwave Binary Switch setValue dispatched');
  const rA = pal.execute('zw-lock-r1', 'unlock');
  assert.strictEqual(rA.pending, true, 'Class A gated');
  pal.authorize('zw-lock-r1', 'unlock');
  assert.strictEqual(pal.execute('zw-lock-r1', 'unlock').ok, true, 'confirmed dispatches');
  // 'unlock' → Door Lock (CC 98) setValue(targetMode, 0).
  assert.ok(fake.sent.some((s) => s.act && s.act.commandClass === 98 && s.params === 0), 'zwave Door Lock unlock dispatched after confirm');
  stop();
  zw._setZwaveLibForTest(null);
  delete process.env.LIKU_ZWAVE_CONTROLLER;
  delete process.env.LIKU_ZWAVE_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Z-Wave driver: HIL isolated (no real Driver constructed) and gated', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_HIL = '1';
  delete process.env.LIKU_ZWAVE_CONTROLLER;
  process.env.LIKU_ZWAVE_DEVICES = JSON.stringify([
    { id: 'zw-lock-hil', name: 'Lock', class: 'A', kind: 'lock', capabilities: ['lock', 'unlock'], powerW: 5 }
  ]);
  const zw = require('../src/main/peripherals/drivers/zwave-driver');
  const fake = makeFakeMesh({ ctorName: 'Driver' });
  zw._setZwaveLibForTest(fake.lib);
  assert.strictEqual(zw.isAvailable(), true, 'available in HIL');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  assert.strictEqual(pal.execute('zw-lock-hil', 'unlock').pending, true, 'Class A gated in HIL');
  assert.strictEqual(fake.created.length, 0, 'no real Driver in HIL');
  zw._setZwaveLibForTest(null);
  delete process.env.LIKU_PERIPHERAL_HIL;
  delete process.env.LIKU_ZWAVE_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('USB-HID driver: LOCAL (REMOTE=false) — real fake node-hid write dispatched', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;
  process.env.LIKU_USBHID_ENABLE = '1';
  process.env.LIKU_USBHID_DEVICES = JSON.stringify([
    { id: 'hid-relay-01', name: 'Relay', class: 'B', kind: 'switch', capabilities: ['on', 'off'], powerW: 2, path: 'usb:001' }
  ]);
  const usb = require('../src/main/peripherals/drivers/usbhid-driver');
  assert.strictEqual(usb.REMOTE, false, 'USB-HID is a LOCAL bus (no signed token required)');
  const writes = [];
  const fakeLib = { HID: function () { return { write: (r) => writes.push(r), close: () => {} }; } };
  usb._setUsbHidLibForTest(fakeLib);
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  assert.ok(pal.listDrivers().drivers.includes('usbhid'), 'usbhid available when enabled');
  const stop = pal.startStreaming();
  assert.strictEqual(pal.execute('hid-relay-01', 'on').ok, true, 'Class B HID write dispatched');
  assert.ok(writes.length >= 1, 'HID report written to the device');
  stop();
  usb._setUsbHidLibForTest(null);
  delete process.env.LIKU_USBHID_ENABLE;
  delete process.env.LIKU_USBHID_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('USB-HID driver: HIL isolated (no real HID handle opened) and gated', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_HIL = '1';
  delete process.env.LIKU_USBHID_ENABLE;
  process.env.LIKU_USBHID_DEVICES = JSON.stringify([
    { id: 'hid-lock-hil', name: 'Lock', class: 'A', kind: 'lock', capabilities: ['lock', 'unlock'], powerW: 4 }
  ]);
  const usb = require('../src/main/peripherals/drivers/usbhid-driver');
  let opened = 0;
  usb._setUsbHidLibForTest({ HID: function () { opened++; return { write() {}, close() {} }; } });
  assert.strictEqual(usb.isAvailable(), true, 'available in HIL');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  assert.strictEqual(pal.execute('hid-lock-hil', 'unlock').pending, true, 'Class A gated in HIL');
  assert.strictEqual(opened, 0, 'no real HID handle opened in HIL');
  usb._setUsbHidLibForTest(null);
  delete process.env.LIKU_PERIPHERAL_HIL;
  delete process.env.LIKU_USBHID_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('KNX driver: real fake-lib group-write dispatched; Class A confirm-gated', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;
  process.env.LIKU_KNX_GATEWAY = '10.0.0.9';
  process.env.LIKU_KNX_DEVICES = JSON.stringify([
    { id: 'knx-light-r1', name: 'Light', class: 'B', kind: 'light', capabilities: ['on', 'off'], powerW: 7, groupAddress: '1/0/1' },
    { id: 'knx-lock-r1', name: 'Lock', class: 'A', kind: 'lock', capabilities: ['lock', 'unlock'], powerW: 3, groupAddress: '1/0/2' }
  ]);
  const knx = require('../src/main/peripherals/drivers/knx-driver');
  // KNX createController calls `lib.Connection(opts)` WITHOUT `new`, so provide a
  // factory that returns a connection object with a `write(ga, value)` method.
  const EventEmitter = require('events');
  const knxSent = [];
  const conn = new EventEmitter();
  conn.write = (ga, value) => { knxSent.push({ ga, value }); };
  const fakeLib = { Connection: () => conn };
  knx._setKnxLibForTest(fakeLib);
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  assert.ok(pal.listDrivers().drivers.includes('knx'), 'knx available via gateway');
  const stop = pal.startStreaming();
  assert.strictEqual(pal.execute('knx-light-r1', 'on').ok, true, 'Class B group-write dispatched');
  assert.ok(knxSent.some((s) => s.ga === '1/0/1'), 'KNX group write to the light GA');
  assert.strictEqual(pal.execute('knx-lock-r1', 'unlock').pending, true, 'Class A gated');
  pal.authorize('knx-lock-r1', 'unlock');
  assert.strictEqual(pal.execute('knx-lock-r1', 'unlock').ok, true, 'confirmed dispatches');
  stop();
  knx._setKnxLibForTest(null);
  delete process.env.LIKU_KNX_GATEWAY;
  delete process.env.LIKU_KNX_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('New Phase 37 drivers participate in aggregate pairing status', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_HIL = '1';
  process.env.LIKU_THREAD_DEVICES = JSON.stringify([{ id: 'th-pair-01', name: 'P', class: 'B', kind: 'switch', capabilities: ['on', 'off'], powerW: 3 }]);
  require('../src/main/peripherals/drivers/thread-driver');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const pr = pal.pairDevice('th-pair-01');
  assert.strictEqual(pr.enabled, true, 'pairing routed to thread driver');
  const status = pal.getPairingStatus();
  assert.strictEqual(status.enabled, true);
  assert.ok(Object.prototype.hasOwnProperty.call(status.devices || status.byDevice || {}, 'th-pair-01') || JSON.stringify(status).includes('th-pair-01'), 'thread device appears in pairing status');
  delete process.env.LIKU_PERIPHERAL_HIL;
  delete process.env.LIKU_THREAD_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

// ---------------------------------------------------------------------------
// Phase 38 — deeper real protocol wiring for the new drivers (Thread commissioning,
// Z-Wave interview + command classes, KNX DPT codec, USB-HID input reports) + ops
// polish (lease-aware node health, flapping→step-back suppression, fleet snapshot).
// ---------------------------------------------------------------------------

/** Fake OpenThread border router: records network form + joiner commissioning. */
function makeFakeThread() {
  const EventEmitter = require('events');
  const created = [];
  const calls = { setActiveDataset: [], formNetwork: [], joiners: [] };
  const sent = [];
  class BorderRouter extends EventEmitter {
    constructor() { super(); created.push(this); }
    start() { return Promise.resolve(); }
    setActiveDataset(ds) { calls.setActiveDataset.push(ds); }
    formNetwork(o) { calls.formNetwork.push(o); }
    commissionJoiner(eui, pskd) { calls.joiners.push({ eui, pskd }); return true; }
    getDeviceByAddr(addr) { return { getEndpoint: () => ({ send: (a, p) => { sent.push({ addr, act: a, params: p }); return Promise.resolve(); } }) }; }
    stop() {}
  }
  return { lib: { BorderRouter }, created, calls, sent };
}

test('Thread commissioning: real path forms the network once + commissions a joiner, then dispatches', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;
  process.env.LIKU_THREAD_BORDER_ROUTER = '/dev/fake-thread';
  process.env.LIKU_THREAD_DATASET = '0e080000000000010000';
  process.env.LIKU_THREAD_DEVICES = JSON.stringify([
    { id: 'th-c1', name: 'Plug', class: 'B', kind: 'switch', capabilities: ['on', 'off'], powerW: 5, address: 'fd00::9', joinerEui64: 'AABBCCDD', pskd: 'J01NME' }
  ]);
  const th = require('../src/main/peripherals/drivers/thread-driver');
  const fake = makeFakeThread();
  th._setThreadLibForTest(fake.lib);
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const stop = pal.startStreaming();
  assert.strictEqual(pal.execute('th-c1', 'on').ok, true, 'Class B dispatched over Thread');
  assert.strictEqual(fake.calls.formNetwork.length, 1, 'network formed once during commissioning');
  assert.ok(fake.calls.joiners.some((j) => j.eui === 'AABBCCDD'), 'joiner commissioned with EUI-64');
  assert.ok(fake.sent.some((s) => s.act === 'on'), 'command dispatched to the endpoint');
  // Commissioning is idempotent — a second command does NOT re-form the network.
  pal.execute('th-c1', 'off');
  assert.strictEqual(fake.calls.formNetwork.length, 1, 'network not re-formed on the next command');
  stop();
  th._setThreadLibForTest(null);
  delete process.env.LIKU_THREAD_BORDER_ROUTER;
  delete process.env.LIKU_THREAD_DATASET;
  delete process.env.LIKU_THREAD_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Thread commissioning: Class A stays confirm-gated — no commissioning/send until confirm', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;
  process.env.LIKU_THREAD_BORDER_ROUTER = '/dev/fake-thread';
  process.env.LIKU_THREAD_DATASET = '0e080000000000010000';
  process.env.LIKU_THREAD_DEVICES = JSON.stringify([
    { id: 'th-lock-c1', name: 'Lock', class: 'A', kind: 'lock', capabilities: ['lock', 'unlock'], powerW: 3, address: 'fd00::a', joinerEui64: 'DEADBEEF' }
  ]);
  const th = require('../src/main/peripherals/drivers/thread-driver');
  const fake = makeFakeThread();
  th._setThreadLibForTest(fake.lib);
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const stop = pal.startStreaming();
  const rA = pal.execute('th-lock-c1', 'unlock');
  assert.strictEqual(rA.pending, true, 'Class A gated before any transport touch');
  assert.strictEqual(fake.calls.formNetwork.length, 0, 'no commissioning until confirmation');
  assert.ok(!fake.sent.some((s) => s.act === 'unlock'), 'no send before confirm');
  pal.authorize('th-lock-c1', 'unlock');
  assert.strictEqual(pal.execute('th-lock-c1', 'unlock').ok, true, 'confirmed Class A dispatches');
  assert.strictEqual(fake.calls.formNetwork.length, 1, 'commissioning ran only after confirm');
  assert.ok(fake.sent.some((s) => s.act === 'unlock'), 'send after confirm');
  stop();
  th._setThreadLibForTest(null);
  delete process.env.LIKU_THREAD_BORDER_ROUTER;
  delete process.env.LIKU_THREAD_DATASET;
  delete process.env.LIKU_THREAD_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Thread commissioning: HIL isolated — no network form / joiner / controller touched', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_HIL = '1';
  delete process.env.LIKU_THREAD_BORDER_ROUTER;
  process.env.LIKU_THREAD_DEVICES = JSON.stringify([
    { id: 'th-hil-1', name: 'LED', class: 'B', kind: 'light', capabilities: ['on', 'off'], powerW: 4, address: 'fd00::b', joinerEui64: 'CAFE' }
  ]);
  const th = require('../src/main/peripherals/drivers/thread-driver');
  const fake = makeFakeThread();
  th._setThreadLibForTest(fake.lib);
  assert.strictEqual(th.isAvailable(), true, 'available in HIL without a border router');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  assert.strictEqual(pal.execute('th-hil-1', 'on').result.simulated, true, 'HIL simulated the action');
  assert.strictEqual(fake.created.length, 0, 'no real controller constructed in HIL');
  assert.strictEqual(fake.calls.formNetwork.length, 0, 'no network form in HIL');
  assert.strictEqual(fake.calls.joiners.length, 0, 'no joiner commissioned in HIL');
  th._setThreadLibForTest(null);
  delete process.env.LIKU_PERIPHERAL_HIL;
  delete process.env.LIKU_THREAD_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

/** Fake zwave-js driver: records node interviews + command-class setValue calls. */
function makeFakeZwave() {
  const EventEmitter = require('events');
  const created = [];
  const interviews = [];
  const sent = [];
  class Driver extends EventEmitter {
    constructor() { super(); created.push(this); }
    start() { return Promise.resolve(); }
    getNode(id) {
      return {
        interview: () => { interviews.push(String(id)); return Promise.resolve(); },
        setValue: (valueId, value) => { sent.push({ id: String(id), valueId, value }); return Promise.resolve(true); }
      };
    }
    stop() {}
  }
  return { lib: { Driver }, created, interviews, sent };
}

test('Z-Wave: node interview runs on commission; command classes map on/brightness/lock correctly', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;
  process.env.LIKU_ZWAVE_CONTROLLER = '/dev/fake-zwave';
  process.env.LIKU_ZWAVE_DEVICES = JSON.stringify([
    { id: 'zw-sw', name: 'Plug', class: 'B', kind: 'switch', capabilities: ['on', 'off'], powerW: 10, nodeId: 7 },
    { id: 'zw-dim', name: 'Dimmer', class: 'B', kind: 'light', capabilities: ['brightness', 'on', 'off'], powerW: 8, nodeId: 8 }
  ]);
  const zw = require('../src/main/peripherals/drivers/zwave-driver');
  const fake = makeFakeZwave();
  zw._setZwaveLibForTest(fake.lib);
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const stop = pal.startStreaming();
  assert.strictEqual(pal.execute('zw-sw', 'on').ok, true, 'binary switch dispatched');
  assert.ok(fake.interviews.includes('7'), 'node 7 interviewed during commissioning');
  assert.ok(fake.sent.some((s) => s.valueId.commandClass === 37 && s.value === true), 'Binary Switch (CC37) targetValue=true');
  assert.strictEqual(pal.execute('zw-dim', 'brightness', { level: 50 }).ok, true, 'multilevel dispatched');
  assert.ok(fake.interviews.includes('8'), 'node 8 interviewed');
  assert.ok(fake.sent.some((s) => s.valueId.commandClass === 38 && s.value === 50), 'Multilevel Switch (CC38) level=50');
  stop();
  zw._setZwaveLibForTest(null);
  delete process.env.LIKU_ZWAVE_CONTROLLER;
  delete process.env.LIKU_ZWAVE_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Z-Wave: HIL isolated — no interview / no real Driver constructed', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_HIL = '1';
  delete process.env.LIKU_ZWAVE_CONTROLLER;
  process.env.LIKU_ZWAVE_DEVICES = JSON.stringify([
    { id: 'zw-hil', name: 'Lock', class: 'A', kind: 'lock', capabilities: ['lock', 'unlock'], powerW: 5, nodeId: 9 }
  ]);
  const zw = require('../src/main/peripherals/drivers/zwave-driver');
  const fake = makeFakeZwave();
  zw._setZwaveLibForTest(fake.lib);
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  assert.strictEqual(pal.execute('zw-hil', 'unlock').pending, true, 'Class A gated in HIL');
  assert.strictEqual(fake.created.length, 0, 'no real Driver in HIL');
  assert.strictEqual(fake.interviews.length, 0, 'no interview in HIL');
  zw._setZwaveLibForTest(null);
  delete process.env.LIKU_PERIPHERAL_HIL;
  delete process.env.LIKU_ZWAVE_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Z-Wave command-class mapping is a pure translation (unit)', () => {
  const zw = require('../src/main/peripherals/drivers/zwave-driver');
  assert.deepStrictEqual(zw._zwaveValueId('on'), { valueId: { commandClass: 37, property: 'targetValue' }, value: true });
  assert.deepStrictEqual(zw._zwaveValueId('off'), { valueId: { commandClass: 37, property: 'targetValue' }, value: false });
  assert.deepStrictEqual(zw._zwaveValueId('lock'), { valueId: { commandClass: 98, property: 'targetMode' }, value: 255 });
  assert.deepStrictEqual(zw._zwaveValueId('unlock'), { valueId: { commandClass: 98, property: 'targetMode' }, value: 0 });
  assert.deepStrictEqual(zw._zwaveValueId('brightness', { level: 30 }), { valueId: { commandClass: 38, property: 'targetValue' }, value: 30 });
  assert.strictEqual(zw._zwaveValueId('spin'), null, 'unknown action → no mapping (falls back to raw command)');
});

test('KNX DPT codec encodes/decodes boolean + scaling + float (unit)', () => {
  const knx = require('../src/main/peripherals/drivers/knx-driver');
  assert.strictEqual(knx._encodeDpt('1.001', true), 1, 'DPT 1.001 true → 1');
  assert.strictEqual(knx._encodeDpt('1.001', false), 0, 'DPT 1.001 false → 0');
  assert.strictEqual(knx._encodeDpt('5.001', 100), 255, 'DPT 5.001 100% → 255');
  assert.strictEqual(knx._encodeDpt('5.001', 0), 0, 'DPT 5.001 0% → 0');
  assert.strictEqual(knx._decodeDpt('5.001', 255), 100, 'DPT 5.001 255 → 100%');
  assert.strictEqual(knx._decodeDpt('1.001', 1), 1, 'DPT 1.001 decode');
  assert.strictEqual(typeof knx._encodeDpt('9.001', 21.5), 'number', 'DPT 9.x float encodes to a number');
});

test('KNX: real send encodes a brightness value via DPT 5.001 (0..255)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;
  process.env.LIKU_KNX_GATEWAY = '10.0.0.9';
  process.env.LIKU_KNX_DEVICES = JSON.stringify([
    { id: 'knx-dim', name: 'Dimmer', class: 'B', kind: 'light', capabilities: ['brightness', 'on', 'off'], powerW: 6, groupAddress: '2/0/1', dpt: '5.001' }
  ]);
  const knx = require('../src/main/peripherals/drivers/knx-driver');
  const EventEmitter = require('events');
  const knxSent = [];
  const conn = new EventEmitter();
  conn.write = (ga, value) => { knxSent.push({ ga, value }); };
  knx._setKnxLibForTest({ Connection: () => conn });
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const stop = pal.startStreaming();
  assert.strictEqual(pal.execute('knx-dim', 'brightness', { level: 100 }).ok, true, 'brightness dispatched');
  assert.ok(knxSent.some((s) => s.ga === '2/0/1' && s.value === 255), 'DPT 5.001 encoded 100% → 255 on the wire');
  stop();
  knx._setKnxLibForTest(null);
  delete process.env.LIKU_KNX_GATEWAY;
  delete process.env.LIKU_KNX_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

/** Fake node-hid: HID() returns an EventEmitter device with write/close. */
function makeFakeHid() {
  const EventEmitter = require('events');
  const opened = [];
  function HID() { const dev = new EventEmitter(); dev.write = () => {}; dev.close = () => {}; opened.push(dev); return dev; }
  return { lib: { HID }, opened };
}

test('USB-HID: input-report subscription parses bytes into a reading (real fake)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;
  process.env.LIKU_USBHID_ENABLE = '1';
  process.env.LIKU_USBHID_DEVICES = JSON.stringify([
    { id: 'hid-in', name: 'Panel', class: 'C', kind: 'sensor', capabilities: ['read'], powerW: 1, path: 'usb:in', reportMap: { 0: 'buttons', 1: 'x' } }
  ]);
  const usb = require('../src/main/peripherals/drivers/usbhid-driver');
  const fake = makeFakeHid();
  usb._setUsbHidLibForTest(fake.lib);
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const readings = [];
  const off = pal.on('reading', (r) => { if (r.id === 'hid-in') readings.push(r); });
  const stop = pal.startStreaming(); // eagerly opens + subscribes (subscribe transport)
  assert.ok(fake.opened.length >= 1, 'device handle opened for the input subscription');
  fake.opened[0].emit('data', [0x03, 0x2a]);
  assert.strictEqual(readings.length, 1, 'input report ingested as a reading');
  assert.strictEqual(readings[0].metrics.buttons, 3, 'reportMap byte0 → buttons');
  assert.strictEqual(readings[0].metrics.x, 42, 'reportMap byte1 → x');
  stop(); off();
  usb._setUsbHidLibForTest(null);
  delete process.env.LIKU_USBHID_ENABLE;
  delete process.env.LIKU_USBHID_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('USB-HID: HIL isolated — no device handle opened, no subscription', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_HIL = '1';
  delete process.env.LIKU_USBHID_ENABLE;
  process.env.LIKU_USBHID_DEVICES = JSON.stringify([
    { id: 'hid-hil', name: 'Panel', class: 'C', kind: 'sensor', capabilities: ['read'], powerW: 1, path: 'usb:hil' }
  ]);
  const usb = require('../src/main/peripherals/drivers/usbhid-driver');
  const fake = makeFakeHid();
  usb._setUsbHidLibForTest(fake.lib);
  assert.strictEqual(usb.isAvailable(), true, 'available in HIL');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const stop = pal.startStreaming();
  assert.strictEqual(fake.opened.length, 0, 'no device opened in HIL');
  stop();
  usb._setUsbHidLibForTest(null);
  delete process.env.LIKU_PERIPHERAL_HIL;
  delete process.env.LIKU_USBHID_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Ops: node-health folds an OPT-IN lease-contention signal (default path unchanged)', () => {
  const ct = require('../src/main/peripherals/cluster-tasks');
  // Single-signal (Phase 35) path is byte-compatible: health = 1 − contentionRate.
  const single = ct.deriveNodeHealth({ metrics: { acquired: 10, contended: 2 } });
  assert.strictEqual(single.score, 0.8, 'single-signal unchanged');
  assert.strictEqual(single.signals.lease, undefined, 'no lease signal by default');
  // Multi-signal WITHOUT lease-aware → no lease folding.
  const multi = ct.deriveNodeHealth({ multi: true, metrics: { acquired: 10, contended: 0 }, tick: { durationMs: 0, stalled: false } });
  assert.strictEqual(multi.signals.lease, undefined, 'lease not folded unless opted in');
  assert.strictEqual(multi.score, 1, 'clean node scores 1');
  // Multi-signal WITH lease-aware → a denied-lease rate lowers the score.
  const lease = ct.deriveNodeHealth({ multi: true, leaseAware: true, metrics: { acquired: 10, contended: 0 }, tick: { durationMs: 0, stalled: false }, lease: { granted: 6, denied: 4 } });
  assert.strictEqual(lease.signals.lease, 0.4, 'lease contention rate = denied/(granted+denied)');
  assert.strictEqual(lease.leaseRate, 0.4);
  assert.strictEqual(lease.score, 0.92, 'penalty = 0.2·0.4 = 0.08 → score 0.92');
});

test('Ops: flapping→step-back suppression is OFF by default (intermediate rung still proposed)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS = '0';
  delete process.env.LIKU_CLUSTER_DIR;
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  const hist = require('../src/main/peripherals/deescalation-history');
  actions.clear(); hist.clear();
  const base = new Date(2026, 6, 27, 12, 0, 0).getTime();
  for (let i = 0; i < 10; i++) actions.recordAnomaly({ device: 'devFlapA', type: 'spike' }, base);
  actions.confirm(actions.proposeActions({}, base).find((p) => p.deviceId === 'devFlapA').id);
  for (let i = 0; i < 3; i++) hist.record({ deviceId: 'devFlapA', kind: 'step-back', at: base + i * 1000 });
  // Default: even though the device is flapping, the intermediate step-back is still proposed.
  const de = actions.proposeDeescalations({ recoveryMs: 1000, stepBack: true }, base + 5000).find((x) => x.deviceId === 'devFlapA');
  assert.ok(de && de.action === 'stepback-rotate-token', 'intermediate rung proposed when suppression OFF');
  actions.clear(); hist.clear();
  delete process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Ops: flapping→step-back suppression (opt-in) holds intermediate rungs but NEVER clear-schedule', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS = '0';
  delete process.env.LIKU_CLUSTER_DIR;
  const actions = require('../src/main/peripherals/anomaly-action-advisor');
  const hist = require('../src/main/peripherals/deescalation-history');
  actions.clear(); hist.clear();
  const base = new Date(2026, 6, 27, 13, 0, 0).getTime();
  // Flapping device elevated to unpair → its step-back is an INTERMEDIATE rung.
  for (let i = 0; i < 10; i++) actions.recordAnomaly({ device: 'devFlapB', type: 'spike' }, base);
  actions.confirm(actions.proposeActions({}, base).find((p) => p.deviceId === 'devFlapB').id);
  for (let i = 0; i < 3; i++) hist.record({ deviceId: 'devFlapB', kind: 'step-back', at: base + i * 1000 });
  // Non-flapping device also elevated to unpair (control).
  for (let i = 0; i < 10; i++) actions.recordAnomaly({ device: 'devOkB', type: 'spike' }, base);
  actions.confirm(actions.proposeActions({}, base).find((p) => p.deviceId === 'devOkB').id);
  // Flapping device at the BOTTOM rung (reduce-schedule) → step-back = clear-schedule.
  for (let i = 0; i < 3; i++) actions.recordAnomaly({ device: 'devFlapClear', type: 'spike' }, base);
  actions.confirm(actions.proposeActions({}, base).find((p) => p.deviceId === 'devFlapClear').id);
  for (let i = 0; i < 3; i++) hist.record({ deviceId: 'devFlapClear', kind: 'step-back', at: base + i * 1000 });
  const props = actions.proposeDeescalations({ recoveryMs: 1000, stepBack: true, suppressFlapping: true }, base + 5000);
  assert.ok(!props.some((x) => x.deviceId === 'devFlapB'), 'flapping device intermediate rung SUPPRESSED');
  assert.ok(props.some((x) => x.deviceId === 'devOkB' && x.action === 'stepback-rotate-token'), 'non-flapping device still proposed');
  assert.ok(props.some((x) => x.deviceId === 'devFlapClear' && x.action === 'clear-schedule'), 'clear-schedule NEVER suppressed even when flapping');
  actions.clear(); hist.clear();
  delete process.env.LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Ops: fleet-observability snapshot persistence is opt-in (default OFF writes nothing)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_FLEET_SNAPSHOT;
  const snap = require('../src/main/peripherals/fleet-snapshot');
  snap.clear();
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  pal.getFleetObservability(); // default OFF → no snapshot persisted
  assert.strictEqual(snap.enabled(), false, 'snapshot store off by default');
  assert.strictEqual(pal.getFleetSnapshot().latest, null, 'nothing persisted by default');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Ops: fleet-observability snapshot persists a compact snapshot when opted in (pure observation)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_FLEET_SNAPSHOT = '1';
  const snap = require('../src/main/peripherals/fleet-snapshot');
  snap.clear();
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const obs = pal.getFleetObservability(); // opt-in → records a compact snapshot
  assert.strictEqual(obs.enabled, true, 'observability view still returned unchanged');
  const got = pal.getFleetSnapshot();
  assert.strictEqual(got.enabled, true);
  assert.ok(got.latest && typeof got.latest === 'object', 'a snapshot was persisted');
  assert.ok(typeof got.latest.mode === 'string' && typeof got.latest.power === 'object', 'snapshot is the compact shape');
  assert.ok(got.totals.snapshots >= 1, 'snapshot counter advanced');
  snap.clear();
  delete process.env.LIKU_PERIPHERAL_FLEET_SNAPSHOT;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

// ---------------------------------------------------------------------------
// Phase 39 — weekly/multi-day forecast + special-day awareness, opt-in live-hardware
// gate for the new drivers, fleet-aware fairness enrichment, and snapshot trends.
// ---------------------------------------------------------------------------

/** Build synthetic per-hour power samples across N days for forecast tests. */
function makeForecastSamples(days, startMs, perHourW) {
  const out = [];
  for (let d = 0; d < days; d++) {
    for (let h = 0; h < 24; h++) {
      const at = new Date(startMs + d * 86400000 + h * 3600000).toISOString();
      out.push({ at, totalW: perHourW(d, h), overBudget: false });
    }
  }
  return out;
}

test('Forecast: multi-day horizon is pure observation + honours the day cap; short-horizon APIs unchanged', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const pf = require('../src/main/peripherals/power-forecast');
  const start = new Date(2026, 0, 5, 0, 0, 0).getTime(); // a Monday
  const samples = makeForecastSamples(14, start, (d, h) => (h >= 8 && h <= 18 ? 800 : 200));
  const now = start + 14 * 86400000;
  // Short-horizon forecast + seasonal still work and are byte-identical in shape.
  const short = pf.forecast({ samples, now, horizonHours: 3 });
  assert.strictEqual(short.ok, true);
  assert.strictEqual(short.horizon.length, 3, 'short horizon unchanged');
  const seasonal = pf.seasonalForecast({ samples, now, horizonHours: 3 });
  assert.strictEqual(seasonal.ok, true);
  // Multi-day horizon.
  const md = pf.multiDayForecast({ samples, now, horizonDays: 7 });
  assert.strictEqual(md.ok, true);
  assert.strictEqual(md.days.length, 7, '7-day horizon');
  assert.ok(md.days.every((x) => x.predictedMeanW > 0 && x.predictedPeakW >= x.predictedMeanW), 'per-day mean/peak sane');
  // Cap at MAX_HORIZON_DAYS.
  const capped = pf.multiDayForecast({ samples, now, horizonDays: 99 });
  assert.strictEqual(capped.days.length, pf.MAX_HORIZON_DAYS, 'horizon capped at MAX_HORIZON_DAYS');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Forecast: weekly profile + special-day tagging (holiday override excluded from baseline)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const pf = require('../src/main/peripherals/power-forecast');
  const start = new Date(2026, 0, 5, 0, 0, 0).getTime();
  const samples = makeForecastSamples(14, start, (d, h) => (h >= 8 && h <= 18 ? 700 : 150));
  const now = start + 14 * 86400000;
  const wp = pf.weeklyProfile({ samples });
  assert.ok(Object.keys(wp).length >= 5, 'weekly profile has per-dow entries');
  assert.ok(Object.values(wp).every((e) => e.meanW > 0 && e.peakW >= e.meanW), 'profile mean/peak sane');
  // Tag a specific upcoming date as a holiday via the override list.
  const future = new Date(now + 86400000);
  const key = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`;
  process.env.LIKU_PERIPHERAL_FORECAST_HOLIDAYS = key;
  assert.strictEqual(pf.isSpecialDay(key), true, 'override date is special');
  const md = pf.multiDayForecast({ samples, now, horizonDays: 3 });
  assert.ok(md.days.some((x) => x.date === key && x.special === true), 'multi-day tags the holiday date special');
  delete process.env.LIKU_PERIPHERAL_FORECAST_HOLIDAYS;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Forecast: multi-day requires sufficient history (advisory, not premature); PAL accessors advisory', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  const pf = require('../src/main/peripherals/power-forecast');
  const thin = pf.multiDayForecast({ samples: [{ at: new Date().toISOString(), totalW: 100 }], horizonDays: 7 });
  assert.strictEqual(thin.ok, false);
  assert.strictEqual(thin.basis, 'insufficient-history');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  const acc = pal.getMultiDayForecast({ samples: [], horizonDays: 3 });
  assert.strictEqual(acc.enabled, true, 'PAL multi-day accessor returns advisory-only shape');
  const wp = pal.getWeeklyProfile({ samples: [] });
  assert.strictEqual(wp.enabled, true);
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Live gate: Thread real transport is OPT-IN (default OFF does not touch the real lib)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;
  delete process.env.LIKU_PERIPHERAL_LIVE;
  delete process.env.LIKU_THREAD_LIVE;
  process.env.LIKU_THREAD_BORDER_ROUTER = '/dev/fake-thread';
  process.env.LIKU_THREAD_DATASET = '0e08';
  process.env.LIKU_THREAD_DEVICES = JSON.stringify([
    { id: 'th-live', name: 'Plug', class: 'B', kind: 'switch', capabilities: ['on', 'off'], powerW: 5, address: 'fd00::1', joinerEui64: 'AA' }
  ]);
  const th = require('../src/main/peripherals/drivers/thread-driver');
  const fake = makeFakeThread();
  th._setThreadLiveLibForTest(fake.lib); // simulate a REAL installed lib (gated)
  assert.strictEqual(th.isLiveEnabled(), false, 'live disabled by default');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const stop = pal.startStreaming();
  const r = pal.execute('th-live', 'on');
  assert.strictEqual(r.ok, false, 'no real controller when live is OFF');
  assert.strictEqual(r.reason, 'not-connected');
  assert.strictEqual(fake.created.length, 0, 'real lib never touched when live OFF');
  // Opt in → the live path now dispatches.
  process.env.LIKU_THREAD_LIVE = '1';
  assert.strictEqual(th.isLiveEnabled(), true, 'per-driver live flag enables it');
  const r2 = pal.execute('th-live', 'on');
  assert.strictEqual(r2.ok, true, 'live path dispatches once opted in');
  assert.strictEqual(fake.created.length, 1, 'real controller constructed only after opt-in');
  assert.ok(fake.sent.some((s) => s.act === 'on'));
  stop();
  th._setThreadLiveLibForTest(null); th._setThreadLibForTest(null);
  delete process.env.LIKU_THREAD_LIVE;
  delete process.env.LIKU_THREAD_BORDER_ROUTER;
  delete process.env.LIKU_THREAD_DATASET;
  delete process.env.LIKU_THREAD_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Live gate: global LIKU_PERIPHERAL_LIVE enables Z-Wave live path; Class A stays confirm-gated', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;
  process.env.LIKU_PERIPHERAL_LIVE = '1';
  process.env.LIKU_ZWAVE_CONTROLLER = '/dev/fake-zwave';
  process.env.LIKU_ZWAVE_DEVICES = JSON.stringify([
    { id: 'zw-live-lock', name: 'Lock', class: 'A', kind: 'lock', capabilities: ['lock', 'unlock'], powerW: 3, nodeId: 4 }
  ]);
  const zw = require('../src/main/peripherals/drivers/zwave-driver');
  const fake = makeFakeZwave();
  zw._setZwaveLiveLibForTest(fake.lib);
  assert.strictEqual(zw.isLiveEnabled(), true, 'global live flag enables it');
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const stop = pal.startStreaming();
  const rA = pal.execute('zw-live-lock', 'unlock');
  assert.strictEqual(rA.pending, true, 'Class A gated even on the live path');
  assert.ok(!fake.sent.some((s) => s.valueId && s.valueId.commandClass === 98), 'no unlock dispatched before confirm');
  pal.authorize('zw-live-lock', 'unlock');
  assert.strictEqual(pal.execute('zw-live-lock', 'unlock').ok, true, 'confirmed Class A dispatches on live path');
  assert.ok(fake.sent.some((s) => s.valueId.commandClass === 98 && s.value === 0), 'live Door Lock unlock after confirm');
  stop();
  zw._setZwaveLiveLibForTest(null); zw._setZwaveLibForTest(null);
  delete process.env.LIKU_PERIPHERAL_LIVE;
  delete process.env.LIKU_ZWAVE_CONTROLLER;
  delete process.env.LIKU_ZWAVE_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Live gate: HIL takes precedence over live (no real lib touched when HIL on)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_HIL = '1';
  process.env.LIKU_KNX_LIVE = '1'; // live opted in, but HIL must win
  process.env.LIKU_KNX_DEVICES = JSON.stringify([
    { id: 'knx-live-hil', name: 'Light', class: 'B', kind: 'light', capabilities: ['on', 'off'], powerW: 6, groupAddress: '3/0/1' }
  ]);
  const knx = require('../src/main/peripherals/drivers/knx-driver');
  const EventEmitter = require('events');
  const writes = [];
  const conn = new EventEmitter(); conn.write = (ga, v) => writes.push({ ga, v });
  knx._setKnxLiveLibForTest({ Connection: () => conn });
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const r = pal.execute('knx-live-hil', 'on');
  assert.strictEqual(r.result.simulated, true, 'HIL simulated the action');
  assert.strictEqual(writes.length, 0, 'no live write when HIL on (HIL precedence)');
  knx._setKnxLiveLibForTest(null); knx._setKnxLibForTest(null);
  delete process.env.LIKU_PERIPHERAL_HIL;
  delete process.env.LIKU_KNX_LIVE;
  delete process.env.LIKU_KNX_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Live gate: USB-HID live path is opt-in (LOCAL bus, still class-gated)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;
  delete process.env.LIKU_PERIPHERAL_LIVE;
  process.env.LIKU_USBHID_ENABLE = '1';
  process.env.LIKU_USBHID_DEVICES = JSON.stringify([
    { id: 'hid-live', name: 'Relay', class: 'B', kind: 'switch', capabilities: ['on', 'off'], powerW: 2, path: 'usb:live' }
  ]);
  const usb = require('../src/main/peripherals/drivers/usbhid-driver');
  const writes = [];
  const fakeLive = { HID: function () { return { write: (r) => writes.push(r), on: () => {}, close: () => {} }; } };
  usb._setUsbHidLiveLibForTest(fakeLive);
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  let stop = pal.startStreaming();
  assert.strictEqual(pal.execute('hid-live', 'on').ok, false, 'no live HID handle when live OFF');
  assert.strictEqual(writes.length, 0, 'real HID not touched when live OFF');
  stop();
  process.env.LIKU_USBHID_LIVE = '1';
  assert.strictEqual(usb.isLiveEnabled(), true);
  stop = pal.startStreaming();
  assert.strictEqual(pal.execute('hid-live', 'on').ok, true, 'live HID write once opted in');
  assert.ok(writes.length >= 1, 'HID report written on the live path');
  stop();
  usb._setUsbHidLiveLibForTest(null); usb._setUsbHidLibForTest(null);
  delete process.env.LIKU_USBHID_LIVE;
  delete process.env.LIKU_USBHID_ENABLE;
  delete process.env.LIKU_USBHID_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Fairness: opt-in lease-aware weighting steers away from a high-contention peer (advisory)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  // Control scenario (health-only): equal health → deterministic tie to nodeA.
  const dirCtrl = require('path').join(TMP_HOME, 'p39fairctrl');
  process.env.LIKU_CLUSTER_DIR = dirCtrl;
  const ct = require('../src/main/peripherals/cluster-tasks');
  let t0 = Date.now();
  process.env.LIKU_NODE_ID = 'nodeA';
  ct.publishTask({ id: 'ca', device: { id: 'd' }, priority: 'high', status: 'pending-review' });
  ct.claimTask('ca', { ttlMs: 300000, now: t0 });
  ct.publishNodeHealth(0.9, { signals: { contention: 0, tick: 0, lease: 0.8 } });
  process.env.LIKU_NODE_ID = 'nodeB';
  ct.publishTask({ id: 'cb', device: { id: 'd' }, priority: 'high', status: 'pending-review' });
  ct.claimTask('cb', { ttlMs: 300000, now: t0 });
  ct.publishNodeHealth(0.9, { signals: { contention: 0, tick: 0, lease: 0 } });
  process.env.LIKU_NODE_ID = 'nodeA';
  ct.publishTask({ id: 'cnew', device: { id: 'd' }, priority: 'high', status: 'pending-review' });
  const ctrl = ct.rebalance({ now: t0 + 1000, staleMs: 500, useHealth: true });
  assert.strictEqual(ctrl.rebalanced.find((r) => r.taskId === 'cnew').to, 'nodeA', 'health-only → equal score → tie → nodeA');
  try { fs.rmSync(dirCtrl, { recursive: true, force: true }); } catch { /* ignore */ }
  // Lease-aware scenario (fresh cluster): the contended nodeA is a worse target.
  const dirLease = require('path').join(TMP_HOME, 'p39fairlease');
  process.env.LIKU_CLUSTER_DIR = dirLease;
  t0 = Date.now();
  process.env.LIKU_NODE_ID = 'nodeA';
  ct.publishTask({ id: 'la', device: { id: 'd' }, priority: 'high', status: 'pending-review' });
  ct.claimTask('la', { ttlMs: 300000, now: t0 });
  ct.publishNodeHealth(0.9, { signals: { contention: 0, tick: 0, lease: 0.8 } });
  process.env.LIKU_NODE_ID = 'nodeB';
  ct.publishTask({ id: 'lb', device: { id: 'd' }, priority: 'high', status: 'pending-review' });
  ct.claimTask('lb', { ttlMs: 300000, now: t0 });
  ct.publishNodeHealth(0.9, { signals: { contention: 0, tick: 0, lease: 0 } });
  process.env.LIKU_NODE_ID = 'nodeA';
  ct.publishTask({ id: 'lnew', device: { id: 'd' }, priority: 'high', status: 'pending-review' });
  const lease = ct.rebalance({ now: t0 + 1000, staleMs: 500, useHealth: true, leaseAware: true });
  assert.strictEqual(lease.rebalanced.find((r) => r.taskId === 'lnew').to, 'nodeB', 'lease-aware → avoid contended nodeA');
  // Ownership untouched (advisory only — no double ownership).
  assert.strictEqual(ct.taskOwner('la', t0 + 1000), 'nodeA');
  assert.strictEqual(ct.taskOwner('lnew', t0 + 1000), null);
  delete process.env.LIKU_NODE_ID;
  delete process.env.LIKU_CLUSTER_DIR;
  try { fs.rmSync(dirLease, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Fairness: lease-aware weighting is inert single-machine + default OFF (byte-compatible)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_CLUSTER_DIR; // single-machine
  const ct = require('../src/main/peripherals/cluster-tasks');
  // Single-machine rebalance is inert regardless of the new flag.
  const res = ct.rebalance({ useHealth: true, leaseAware: true });
  assert.ok(res.local === true || (res.rebalanced && res.rebalanced.length === 0), 'single-machine rebalance inert');
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Snapshot trends: <2 snapshots → null trend; ≥2 → deltas + series (pure observation)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_FLEET_SNAPSHOT = '1';
  const snap = require('../src/main/peripherals/fleet-snapshot');
  snap.clear();
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  pal.getFleetObservability({ now: Date.now() });
  const t1 = pal.getFleetSnapshotTrends();
  assert.strictEqual(t1.enabled, true);
  assert.strictEqual(t1.trend, null, 'a single snapshot yields no trend yet');
  // A second snapshot → deltas become available.
  pal.getFleetObservability({ now: Date.now() + 60000 });
  const t2 = pal.getFleetSnapshotTrends();
  assert.ok(t2.points >= 2, 'two snapshots recorded');
  assert.ok(t2.nodeHealthScore && 'delta' in t2.nodeHealthScore, 'node-health delta present');
  assert.ok(Array.isArray(t2.series) && t2.series.length >= 2, 'time series returned');
  snap.clear();
  delete process.env.LIKU_PERIPHERAL_FLEET_SNAPSHOT;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Snapshot trends: pure observation — trends never persist or mutate the ring', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_FLEET_SNAPSHOT = '1';
  const snap = require('../src/main/peripherals/fleet-snapshot');
  snap.clear();
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  pal.getFleetObservability();
  pal.getFleetObservability();
  const before = snap.read().totals.snapshots;
  snap.trends(); snap.trends(); // reading trends must not write
  const after = snap.read().totals.snapshots;
  assert.strictEqual(before, after, 'trends() is read-only (snapshot count unchanged)');
  snap.clear();
  delete process.env.LIKU_PERIPHERAL_FLEET_SNAPSHOT;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Live gate: KNX live path opt-in dispatches an encoded group write (real fake)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  delete process.env.LIKU_PERIPHERAL_HIL;
  delete process.env.LIKU_PERIPHERAL_LIVE;
  delete process.env.LIKU_KNX_LIVE;
  process.env.LIKU_KNX_GATEWAY = '10.0.0.5';
  process.env.LIKU_KNX_DEVICES = JSON.stringify([
    { id: 'knx-live', name: 'Light', class: 'B', kind: 'light', capabilities: ['on', 'off'], powerW: 6, groupAddress: '4/0/1', dpt: '1.001' }
  ]);
  const knx = require('../src/main/peripherals/drivers/knx-driver');
  const EventEmitter = require('events');
  const writes = [];
  const conn = new EventEmitter(); conn.write = (ga, v) => writes.push({ ga, v });
  knx._setKnxLiveLibForTest({ Connection: () => conn });
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  pal.scan();
  const stop = pal.startStreaming();
  assert.strictEqual(pal.execute('knx-live', 'on').ok, false, 'no live write when KNX live OFF');
  assert.strictEqual(writes.length, 0, 'real gateway untouched when live OFF');
  process.env.LIKU_KNX_LIVE = '1';
  assert.strictEqual(knx.isLiveEnabled(), true);
  assert.strictEqual(pal.execute('knx-live', 'on').ok, true, 'live path dispatches once opted in');
  assert.ok(writes.some((w) => w.ga === '4/0/1' && w.v === 1), 'DPT 1.001 encoded on the live wire');
  stop();
  knx._setKnxLiveLibForTest(null); knx._setKnxLibForTest(null);
  delete process.env.LIKU_KNX_LIVE;
  delete process.env.LIKU_KNX_GATEWAY;
  delete process.env.LIKU_KNX_DEVICES;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Forecast: multi-day excludes auto-detected special days from the baseline (opt-in)', () => {
  process.env.LIKU_ENABLE_PERIPHERALS = '1';
  process.env.LIKU_PERIPHERAL_FORECAST_AUTO_SPECIAL = '1';
  const pf = require('../src/main/peripherals/power-forecast');
  const start = new Date(2026, 0, 5, 0, 0, 0).getTime();
  // 13 normal days + 1 wildly atypical (very high) day → detectSpecialDays flags it.
  const samples = makeForecastSamples(13, start, (d, h) => (h >= 8 && h <= 18 ? 500 : 150));
  const specialDayStart = start + 13 * 86400000;
  for (let h = 0; h < 24; h++) samples.push({ at: new Date(specialDayStart + h * 3600000).toISOString(), totalW: 5000, overBudget: false });
  const detected = pf.detectSpecialDays({ samples });
  assert.ok(detected.dates.length >= 1, 'atypical day detected as special');
  const specialKey = detected.dates[0].date;
  assert.strictEqual(pf.isSpecialDay(specialKey, { samples, autoSpecial: true }), true, 'auto-special detection flags the date');
  // With excludeAnomalous, the special day is dropped so the baseline stays normal.
  const md = pf.multiDayForecast({ samples, now: specialDayStart + 86400000, horizonDays: 3, excludeAnomalous: true });
  assert.strictEqual(md.ok, true);
  assert.ok(md.days.every((x) => x.predictedPeakW < 3000), 'special-day spike excluded from the multi-day baseline');
  delete process.env.LIKU_PERIPHERAL_FORECAST_AUTO_SPECIAL;
  delete process.env.LIKU_ENABLE_PERIPHERALS;
});

test('Phase 39 PAL accessors are flag-gated (disabled → inert advisory shapes)', () => {
  delete process.env.LIKU_ENABLE_PERIPHERALS;
  const pal = require('../src/main/peripherals/peripheral-abstraction-layer');
  assert.strictEqual(pal.getMultiDayForecast().enabled, false, 'multi-day accessor gated');
  assert.strictEqual(pal.getWeeklyProfile().enabled, false, 'weekly profile accessor gated');
  assert.strictEqual(pal.getFleetSnapshotTrends().enabled, false, 'snapshot-trends accessor gated');
});

console.log(`\n${pass} checks passed.`);
if (process.exitCode) { console.error('FAILED'); }
else { console.log('OK'); }

// Cleanup the isolated temp home.
try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
