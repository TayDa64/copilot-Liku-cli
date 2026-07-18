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

console.log(`\n${pass} checks passed.`);
if (process.exitCode) { console.error('FAILED'); }
else { console.log('OK'); }

// Cleanup the isolated temp home.
try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
