/**
 * liku peripherals — Peripheral Abstraction Layer surface (Pillar 3, mock-only).
 *
 * Entirely inert unless LIKU_ENABLE_PERIPHERALS=1. Mock drivers only; every
 * physical action is routed through the cognitive substrate's confidence +
 * pending/confirm safety system.
 *
 * Usage:
 *   liku peripherals scan               Discover + register mock devices
 *   liku peripherals list [--class A]   List registered devices
 *   liku peripherals status <id>        Show one device's state
 *   liku peripherals execute <id> <action> [--level N]
 *                                       Perform an action (Class A → confirm flow)
 *   liku peripherals tasks [--escalated|--pending|--severity <p>|--anomaly]
 *                                       Human-gated peripheral tasks (filterable)
 *   liku peripherals notifications [--pending|--severity <s>]
 *   liku peripherals channels           Show escalation notification channels
 *   liku peripherals power [--history|--trend|--anomalies|--forecast [--seasonal] [--exclude-anomalous]]
 *                                       Live budget + rolling power telemetry
 *   liku peripherals anomalies [--attributed]
 *                                       Detected anomalies (per-device attribution)
 *                                       + advisory self-healing actions
 *   liku peripherals anomaly-action [list|confirm <id>|dismiss <id>]
 *                                       Advisory anomaly→action suggestions (human-gated)
 *   liku peripherals schedules          Show per-device time-boxed power budgets
 *   liku peripherals locks [--record]   Lock observability: metrics, per-file, trends
 *   liku peripherals coordination [status|lease <id>|release <id>]
 *                                       Cross-host lease coordination (cluster mode)
 *   liku peripherals cron [--at <ISO>]  Cron device schedules → advisory human-gated tasks
 *   liku peripherals cron [propose <dev> <act> "<cron>"|confirm <id>|dismiss <id>|rules|tick|remove <id>]
 *   liku peripherals pair <id>          Pair / commission a device (real when HIL off)
 *   liku peripherals unpair <id>        Tear down a device's pairing (re-pairable)
 *   liku peripherals token [status|rotate <id>|revoke <id>|rotate-all|action <id> <action>]
 *   liku peripherals suggestions        Advisory schedule proposals (recurring anomalies)
 *   liku peripherals apply-schedule <id> Confirm + activate a proposed schedule
 */

const { log, success, error, dim, highlight } = require('../util/output');

function getPAL() {
  return require('../../main/peripherals/peripheral-abstraction-layer');
}

async function run(args, flags) {
  const pal = getPAL();

  // Strict flag gate — inert when disabled.
  if (!pal.isPeripheralsEnabled()) {
    if (flags.json) return { success: true, enabled: false, reason: 'disabled' };
    log(dim('Peripherals are disabled. Set LIKU_ENABLE_PERIPHERALS=1 to enable (mock drivers only).'));
    return { success: true, enabled: false };
  }

  const sub = (args[0] || 'list').toLowerCase();

  switch (sub) {
    case 'scan': {
      const res = pal.scan();
      if (flags.json) return { success: true, ...res };
      success(`Scanned: ${res.devices.length} device(s) registered.`);
      for (const d of res.devices) log(`  ${highlight(d.id)} [${d.class}] ${d.name} ${dim(d.kind)}`);
      return { success: true, count: res.devices.length };
    }

    case 'list': {
      const res = pal.list(flags.class ? { class: flags.class } : {});
      if (flags.json) return { success: true, ...res };
      if (!res.devices.length) { log('No devices. Run: liku peripherals scan'); return { success: true, count: 0 }; }
      log(highlight(`Peripherals (${res.devices.length}):`));
      for (const d of res.devices) {
        log(`  ${highlight(d.id)} [class ${d.class}] ${d.name} ${dim(`caps: ${d.capabilities.join(',')}`)}`);
      }
      return { success: true, count: res.devices.length };
    }

    case 'status': {
      const id = args[1];
      if (!id) {
        // No id → show the live power budget summary + device count.
        const ps = pal.powerStatus();
        if (flags.json) return { success: true, power: ps };
        log(highlight('Peripherals status'));
        log(`  devices: ${ps.devices ? ps.devices.length : 0}`);
        log(`  power: ${ps.currentW}W / ${ps.budgetW}W  (headroom ${ps.headroomW}W)`);
        log(`  peak: ${ps.peakW}W  avg: ${ps.avgW}W  (${ps.samples} samples)${ps.anomalies ? `  anomalies: ${ps.anomalies} [${(ps.anomalyTypes || []).join(',')}]` : ''}`);
        log(`  locking: ${ps.locking || 'advisory-file-lock'}   HIL: ${ps.hil ? 'ON (simulation)' : 'off'}   cluster: ${ps.cluster || 'single-machine'}`);
        try {
          const atomic = require('../../shared/atomic-file');
          const lm = atomic.getLockMetrics();
          log(`  locks: ${lm.acquired} acquired, ${lm.contended} contended, ${lm.steals} steals, ${lm.fallbacks} fallbacks`);
          const perFile = atomic.getPerFileLockMetrics();
          const hot = Object.entries(perFile).sort((a, b) => b[1].contended - a[1].contended || b[1].acquired - a[1].acquired)[0];
          if (hot) log(dim(`  hottest lock: ${hot[0]} (${hot[1].acquired} acq, ${hot[1].contended} cont)`));
        } catch { /* observability only */ }
        try {
          const channels = require('../../main/agents/notification-channels').describe();
          const names = channels.channels.map((c) => c.channel);
          log(`  channels: inbox${names.length ? ', ' + names.join(', ') : ' (only)'}`);
        } catch { /* observability only */ }
        try {
          const pairing = pal.getPairingStatus();
          const states = Object.values(pairing.devices || {});
          if (states.length) {
            const paired = states.filter((s) => s.state === 'paired').length;
            const failed = states.filter((s) => s.state === 'failed').length;
            log(`  pairing: ${paired}/${states.length} paired${failed ? `, ${failed} failed` : ''}`);
          }
        } catch { /* observability only */ }
        if (ps.overBudget) error('  OVER BUDGET');
        return { success: true, power: ps };
      }
      const dev = pal.get(id);
      if (!dev) { error(`Device not found: ${id}`); return { success: false }; }
      if (flags.json) return { success: true, device: dev };
      log(highlight(`${dev.id} — ${dev.name}`));
      log(`  class: ${dev.class}  kind: ${dev.kind}  driver: ${dev.driver}`);
      log(`  capabilities: ${dev.capabilities.join(', ')}`);
      log(`  state: ${JSON.stringify(dev.state)}`);
      log(dim(`  lastSeen: ${dev.lastSeen}`));
      return { success: true, device: dev };
    }

    case 'execute': {
      const id = args[1];
      const action = args[2];
      if (!id || !action) { error('Usage: liku peripherals execute <id> <action> [--level N]'); return { success: false }; }
      const params = flags.level !== undefined ? { level: Number(flags.level) } : {};
      const res = pal.execute(id, action, params);
      if (flags.json) return { success: !!res.ok, ...res };
      if (res.ok) {
        success(`Executed ${action} on ${id} (class ${res.klass}).`);
        if (res.result && res.result.state) log(dim(`  state: ${JSON.stringify(res.result.state)}`));
      } else if (res.pending) {
        log(highlight(`Class ${res.klass} action requires confirmation.`));
        log(`  Shortcut: ${dim(`liku peripherals confirm ${id} ${action} --execute`)}`);
        log(`  Or: ${dim(`liku system-context confirm ${res.confirmKey} --apply`)} then re-run execute`);
      } else if (res.rejected) {
        error(`Rejected by policy (${res.code}): ${res.reason}`);
      } else {
        error(`Action not performed: ${res.reason || 'unknown'}`);
      }
      return { success: !!res.ok, ...res };
    }

    case 'confirm': {
      // Convenience wrapper around the system-context confirm flow for Class A.
      const id = args[1];
      const action = args[2];
      if (!id || !action) { error('Usage: liku peripherals confirm <id> <action> [--execute]'); return { success: false }; }
      const res = pal.authorize(id, action);
      if (!res.ok) {
        if (flags.json) return { success: false, ...res };
        error(`Authorization failed: ${res.reason || res.code || 'unknown'}`);
        return { success: false, ...res };
      }
      let executed = null;
      if (flags.execute) {
        executed = pal.execute(id, action, flags.level !== undefined ? { level: Number(flags.level) } : {});
      }
      if (flags.json) return { success: true, authorize: res, execute: executed };
      if (res.klass === 'A') success(`Authorized ${action} on ${id} (TTL ${res.ttlSec || 'n/a'}s).`);
      else success(`No confirmation required for class ${res.klass} device ${id}.`);
      if (executed) {
        if (executed.ok) { success(`Executed ${action} on ${id}.`); if (executed.result?.state) log(dim(`  state: ${JSON.stringify(executed.result.state)}`)); }
        else error(`Execute after authorize failed: ${executed.reason || 'unknown'}`);
      } else if (res.klass === 'A') {
        log(dim(`  Run: liku peripherals execute ${id} ${action}`));
      }
      return { success: true, ...res };
    }

    case 'drivers': {
      const res = pal.listDrivers();
      const pairing = pal.getPairingStatus();
      const tokens = pal.getTokenStatus();
      if (flags.json) return { success: true, ...res, pairing: pairing.devices, tokens: tokens.devices };
      log(highlight(`Available drivers: ${res.drivers.join(', ') || 'none'}`));
      const entries = Object.entries(pairing.devices || {});
      if (entries.length) {
        log(dim('  pairing:'));
        for (const [id, st] of entries) {
          const sim = st.simulated ? ' (HIL)' : '';
          const err = st.lastError ? dim(` — ${st.lastError}`) : '';
          const tok = (tokens.devices || {})[id];
          const tokStr = tok ? dim(` token:gen${tok.gen}${tok.revoked ? '/revoked' : ''}`) : '';
          log(`    ${highlight(id)} [${st.driver}] ${st.state}${sim}${tokStr}${err}`);
        }
      }
      return { success: true, ...res };
    }

    case 'pair': {
      // Trigger a pairing / commissioning attempt for a device (real only when
      // HIL is off). Never actuates — this is transport bookkeeping.
      const id = args[1];
      if (!id) { error('Usage: liku peripherals pair <id>'); return { success: false }; }
      const res = pal.pairDevice(id);
      if (flags.json) return { success: !!res.ok, ...res };
      if (res.ok) success(`${id} paired${res.simulated ? ' (HIL simulation)' : ''}.`);
      else if (res.state === 'pairing') log(highlight(`${id} pairing in progress…`));
      else if (res.state === 'failed') error(`${id} pairing failed: ${res.lastError || res.reason || 'unknown'}`);
      else log(dim(`${id} state: ${res.state || 'unknown'}${res.reason ? ` (${res.reason})` : ''}${res.lastError ? ` — ${res.lastError}` : ''}`));
      return { success: !!res.ok, ...res };
    }

    case 'unpair': {
      // Tear down a device's pairing / commissioning (re-pairable). Never actuates.
      const id = args[1];
      if (!id) { error('Usage: liku peripherals unpair <id>'); return { success: false }; }
      const res = pal.unpairDevice(id);
      if (flags.json) return { success: !!res.ok, ...res };
      if (res.ok) success(`${id} unpaired${res.simulated ? ' (HIL simulation)' : ''} (state: ${res.state || 'unpaired'}).`);
      else error(`${id} unpair failed: ${res.reason || 'unknown'}`);
      return { success: !!res.ok, ...res };
    }

    case 'token': {
      // Show or manage per-device capability-token lifecycle.
      const op = (args[1] || 'status').toLowerCase();
      if (op === 'rotate' || op === 'revoke') {
        const id = args[2];
        if (!id) { error(`Usage: liku peripherals token ${op} <id>`); return { success: false }; }
        const res = op === 'rotate' ? pal.rotateToken(id) : pal.revokeToken(id);
        if (flags.json) return { success: !!res.ok, ...res };
        if (res.ok) success(`Token ${op}d for ${id} (gen ${res.gen}${res.revoked ? ', revoked' : ''}).`);
        else error(`Token ${op} failed for ${id}: ${res.reason || 'unknown'}`);
        return { success: !!res.ok, ...res };
      }
      if (op === 'rotate-all') {
        // Fleet-wide human-gated token rotation (rotate-all-on-event).
        const res = pal.rotateAllTokens();
        if (flags.json) return { success: !!res.ok, ...res };
        if (res.ok) success(`Rotated ${res.rotated.length} device token(s): ${res.rotated.join(', ') || '(none active)'}.`);
        else error(`Rotate-all failed: ${res.reason || 'unknown'}`);
        return { success: !!res.ok, ...res };
      }
      if (op === 'action') {
        // Mint a PER-ACTION (least-privilege) capability token.
        const id = args[2];
        const action = args[3];
        if (!id || !action) { error('Usage: liku peripherals token action <id> <action>'); return { success: false }; }
        const res = pal.issueActionToken(id, action);
        if (flags.json) return { success: !!res.ok, ...res };
        if (res.ok) { success(`Per-action token for ${id}:${action} (gen ${res.gen}).`); log(dim(`  ${res.token}`)); }
        else error(`Could not issue token for ${id}:${action}: ${res.reason || 'unknown'}`);
        return { success: !!res.ok, ...res };
      }
      const res = pal.getTokenStatus();
      if (flags.json) return { success: true, ...res };
      const entries = Object.entries(res.devices || {});
      log(highlight(`Capability tokens (${entries.length}):`));
      if (!entries.length) log(dim('  none (issued on pair)'));
      for (const [id, t] of entries) {
        const state = t.revoked ? 'REVOKED' : (t.gen > 0 ? 'active' : 'none');
        const grace = (t.prevGen > 0 && t.prevGenUntil > Date.now()) ? dim(` +grace(gen${t.prevGen})`) : '';
        const rot = t.rotateDueAt > 0 ? dim(` rotates:${new Date(t.rotateDueAt).toISOString().slice(11, 19)}`) : '';
        const acts = Array.isArray(t.actions) && t.actions.length ? dim(` [${t.actions.join(',')}]`) : '';
        log(`  ${highlight(id)} gen ${t.gen} ${state}${grace}${rot}${acts} ${dim(`id:${t.identityFp || '?'}`)}`);
      }
      return { success: true, ...res };
    }

    case 'suggestions': {
      // Advisory power-schedule suggestions from recurring anomalies (proposed).
      const res = pal.getScheduleSuggestions();
      if (flags.json) return { success: true, ...res };
      log(highlight(`Proposed schedules (${res.suggestions.length}):`));
      if (!res.suggestions.length) log(dim('  none (recurring anomalies generate proposals)'));
      for (const s of res.suggestions) {
        if (s.type === 'multi-device') {
          const devs = (s.devices || []).map((d) => `${d.deviceId}≤${d.proposedMaxW}W`).join(', ');
          log(`  ${highlight(s.id)} ${dim('multi-device')} ${s.fromHour}:00→${s.toHour}:00 budget ${s.budgetW}W  ${dim(devs)}`);
        } else {
          log(`  ${highlight(s.id)} ${dim(s.deviceId)} ${s.fromHour}:00→${s.toHour}:00 ≤${s.maxW}W  ${dim(`(${s.reason})`)}`);
        }
        log(dim(`     apply: liku peripherals apply-schedule ${s.id}`));
      }
      return { success: true, ...res };
    }

    case 'apply-schedule': {
      // EXPLICIT human confirmation → activates a proposed schedule.
      const id = args[1];
      if (!id) { error('Usage: liku peripherals apply-schedule <suggestion-id>'); return { success: false }; }
      const res = pal.confirmScheduleSuggestion(id);
      if (flags.json) return { success: !!res.ok, ...res };
      if (res.ok) success(`Schedule ${id} confirmed + activated (now enforced by power schedules).`);
      else error(`Could not apply ${id}: ${res.reason || 'unknown'}`);
      return { success: !!res.ok, ...res };
    }

    case 'dismiss-schedule': {
      const id = args[1];
      if (!id) { error('Usage: liku peripherals dismiss-schedule <suggestion-id>'); return { success: false }; }
      const res = pal.dismissScheduleSuggestion(id);
      if (flags.json) return { success: !!res.ok, ...res };
      if (res.ok) success(`Schedule suggestion ${id} dismissed.`);
      else error(`Could not dismiss ${id}: ${res.reason || 'unknown'}`);
      return { success: !!res.ok, ...res };
    }

    case 'anomalies': {
      // Phase 20: detected power anomalies with per-device ATTRIBUTION + the
      // advisory self-healing actions proposed for persistently anomalous devices.
      const res = pal.getPowerAnomalies();
      let tiers = {};
      try { tiers = require('../../main/agents/power-anomaly-consumer').ANOMALY_TIERS || {}; } catch { tiers = {}; }
      const actionsRes = pal.getAnomalyActions();
      if (flags.json) return { success: true, ...res, actions: actionsRes.actions };
      log(highlight(`Power anomalies (${res.anomalies.length}):`));
      if (!res.anomalies.length) log(dim(`  none (baseline ${res.baselineW}W, ${res.samples} samples)`));
      for (const a of res.anomalies) {
        const sev = (tiers[a.type] && tiers[a.type].severity) || 'info';
        const attr = a.attributedDevice ? highlight(` → ${a.attributedDevice}`) + dim(` (Δ${a.attributedDeltaW}W, ${a.attributedLoadW}W)`) : dim(' → unattributed');
        log(`  ${highlight(a.type)} [${sev}]  ${a.valueW}W vs baseline ${a.baselineW}W${attr}`);
      }
      const acts = actionsRes.actions || [];
      log(highlight(`\nAdvisory actions (${acts.length}):`));
      if (!acts.length) log(dim('  none (persistent anomalies escalate reduce-schedule → rotate-token → unpair)'));
      for (const a of acts) {
        log(`  ${highlight(a.id)} ${dim(a.deviceId)} [${a.severity}] ${highlight(a.action)}  ${dim(a.reason)}`);
        log(dim(`     confirm: liku peripherals anomaly-action confirm ${a.id}  →  ${a.directive}`));
      }
      return { success: true, ...res, actions: acts };
    }

    case 'anomaly-action': {
      // Advisory anomaly→action suggestions: list | confirm <id> | dismiss <id> |
      // policy [list|set <device> reduce=N rotate=N unpair=N].
      const op = (args[1] || 'list').toLowerCase();
      if (op === 'policy') {
        const sub = (args[2] || 'list').toLowerCase();
        if (sub === 'set') {
          const deviceId = args[3];
          if (!deviceId) { error('Usage: liku peripherals anomaly-action policy set <device> reduce-schedule=N rotate-token=N unpair=N'); return { success: false }; }
          const thresholds = {};
          const alias = { reduce: 'reduce-schedule', rotate: 'rotate-token', unpair: 'unpair' };
          for (const kv of args.slice(4)) {
            const eq = String(kv).indexOf('=');
            if (eq <= 0) continue;
            let k = kv.slice(0, eq).trim();
            k = alias[k] || k;
            thresholds[k] = Number(kv.slice(eq + 1).trim());
          }
          const r = pal.setAutoHealPolicy(deviceId, thresholds);
          if (flags.json) return { success: !!r.ok, ...r };
          if (r.ok) success(`Auto-heal policy for ${deviceId}: ${JSON.stringify(r.policy)}`);
          else error(`Could not set policy: ${r.reason || 'unknown'}`);
          return { success: !!r.ok, ...r };
        }
        const r = pal.getAutoHealPolicies();
        if (flags.json) return { success: true, ...r };
        const entries = Object.entries(r.policies || {});
        log(highlight(`Auto-heal policies (${entries.length}):`));
        if (!entries.length) log(dim('  none — default ladder: reduce-schedule=3, rotate-token=6, unpair=10'));
        for (const [dev, pol] of entries) log(`  ${highlight(dev)} ${dim(JSON.stringify(pol))}`);
        return { success: true, ...r };
      }
      if (op === 'confirm' || op === 'dismiss') {
        const id = args[2];
        if (!id) { error(`Usage: liku peripherals anomaly-action ${op} <id>`); return { success: false }; }
        const res = op === 'confirm' ? pal.confirmAnomalyAction(id) : pal.dismissAnomalyAction(id);
        if (flags.json) return { success: !!res.ok, ...res };
        if (res.ok && op === 'confirm') {
          if (res.executed && res.executed.ok !== false) {
            // Security / self-heal action was performed on confirmation.
            success(`Action ${res.action}${res.deviceId ? ` for ${res.deviceId}` : ' (fleet)'} confirmed + applied (human-gated).`);
            if (res.action === 'rotate-token') log(dim(`  token rotated → gen ${res.executed.gen}`));
            if (res.action === 'unpair') log(dim('  device unpaired → capability token revoked'));
            if (res.action === 'reduce-schedule' && res.executed.multiDevice) log(dim(`  multi-device coordinated cap: ${(res.executed.devices || []).map((d) => `${d.deviceId}≤${d.proposedMaxW}W`).join(', ')}`));
            else if (res.action === 'reduce-schedule' && res.executed.rule) log(dim(`  schedule capped ${res.executed.rule.fromHour}:00→${res.executed.rule.toHour}:00 ≤${res.executed.rule.maxW}W`));
            if (res.action === 'rotate-all') log(dim(`  fleet rotated ${(res.executed.rotated || []).length} token(s)`));
          } else {
            success(`Action ${res.action}${res.deviceId ? ` for ${res.deviceId}` : ''} confirmed (advisory).`);
            if (res.directive) log(dim(`  Run this to apply: ${res.directive}`));
          }
        } else if (res.ok) {
          success(`Action suggestion ${id} dismissed.`);
        } else {
          error(`Could not ${op} ${id}: ${res.reason || 'unknown'}`);
        }
        return { success: !!res.ok, ...res };
      }
      const res = pal.getAnomalyActions();
      if (flags.json) return { success: true, ...res };
      const acts = res.actions || [];
      log(highlight(`Advisory actions (${acts.length}):`));
      if (!acts.length) log(dim('  none (persistent anomalies escalate reduce-schedule → rotate-token → unpair; fleet → rotate-all)'));
      for (const a of acts) {
        const scope = a.scope === 'fleet' ? highlight(' [FLEET]') : dim(a.deviceId);
        log(`  ${highlight(a.id)} ${scope} [${a.severity}] ${highlight(a.action)}  ${dim(a.reason)}`);
        log(dim(`     confirm: liku peripherals anomaly-action confirm ${a.id}  →  ${a.directive}`));
      }
      return { success: true, ...res };
    }

    case 'power': {
      const ps = pal.powerStatus();
      // Phase 19/23: --forecast shows the short-horizon forecast + warnings.
      // --seasonal uses the day-of-week baselines; --device-warnings names the
      // device likely to drive each upcoming breach.
      if (flags.forecast) {
        const f = flags.seasonal ? pal.getSeasonalForecast({ excludeAnomalous: !!flags['exclude-anomalous'] }) : pal.getPowerForecast();
        const warn = pal.getForecastWarnings();
        const devWarn = pal.getDeviceForecastWarnings({ seasonal: !!flags.seasonal, excludeAnomalous: !!flags['exclude-anomalous'] });
        if (flags.json) return { success: true, forecast: f, warnings: warn.warnings, deviceWarnings: devWarn.warnings };
        log(highlight(`Power forecast${flags.seasonal ? ' (day-of-week seasonal)' : ''}${flags['exclude-anomalous'] ? ' [anomaly-aware]' : ''}`));
        if (!f.ok) log(dim(`  ${f.basis || 'unavailable'} (${f.samples || 0} samples)`));
        for (const h of f.horizon || []) log(`  hour ${h.hour}:00${flags.seasonal && h.dow != null ? ` [${h.dowGroup || 'dow ' + h.dow}]` : ''}  ~${h.predictedW}W [${h.lowW}–${h.highW}W] ${dim(`${h.confidence} conf`)} ${dim(h.basis)}`);
        for (const w of warn.warnings || []) error(`  ⚠ ${w.advisory}`);
        if ((devWarn.warnings || []).length) {
          log(highlight('  device warnings:'));
          for (const w of devWarn.warnings) log(dim(`    ${w.deviceId} → hour ${w.hour}:00 (~${w.devicePeakW}W)`));
        }
        return { success: true, forecast: f, deviceWarnings: devWarn.warnings };
      }
      // Phase 19: --anomalies surfaces detected power anomalies (+ attribution).
      if (flags.anomalies) {
        const res = pal.getPowerAnomalies();
        let tiers = {};
        try { tiers = require('../../main/agents/power-anomaly-consumer').ANOMALY_TIERS || {}; } catch { tiers = {}; }
        if (flags.json) return { success: true, ...res };
        log(highlight(`Power anomalies (${res.anomalies.length}):`));
        if (!res.anomalies.length) log(dim(`  none (baseline ${res.baselineW}W, ${res.samples} samples)`));
        for (const a of res.anomalies) {
          const sev = (tiers[a.type] && tiers[a.type].severity) || 'info';
          const attr = a.attributedDevice ? dim(` → ${a.attributedDevice} (Δ${a.attributedDeltaW}W)`) : '';
          log(`  ${highlight(a.type)} [${sev}]  ${a.valueW}W vs baseline ${a.baselineW}W${attr}  ${dim(a.advisory || '')}`);
        }
        return { success: true, ...res };
      }
      // Phase 12: --history shows recent samples; --trend shows the summary.
      if (flags.history || flags.trend) {
        const trend = pal.getPowerTrend();
        if (flags.history) {
          const limit = flags.limit !== undefined ? Number(flags.limit) : 10;
          const hist = pal.getPowerHistory({ limit });
          if (flags.json) return { success: true, trend, history: hist.samples };
          log(highlight(`Power history (last ${hist.samples.length}):`));
          for (const s of hist.samples) log(`  ${dim(s.at)}  ${s.totalW}W${s.overBudget ? ' (OVER)' : ''}`);
        }
        if (flags.json && !flags.history) return { success: true, trend };
        log(highlight('Power trend'));
        log(`  samples: ${trend.count}  peak: ${trend.peakW}W  avg: ${trend.avgW}W  current: ${trend.currentW}W`);
        const perDev = Object.entries(trend.perDevicePeakW || {});
        for (const [id, w] of perDev) log(`  ${highlight(id)} peak ${w}W`);
        return { success: true, trend };
      }
      if (flags.json) return { success: true, ...ps };
      log(highlight('Power budget'));
      log(`  total:   ${ps.currentW}W / ${ps.budgetW}W`);
      log(`  headroom: ${ps.headroomW}W${ps.overBudget ? '  (OVER BUDGET)' : ''}`);
      log(`  peak: ${ps.peakW}W  avg: ${ps.avgW}W  (${ps.samples} samples)`);
      log(`  locking: ${ps.locking || 'advisory-file-lock'}   HIL: ${ps.hil ? 'ON (simulation)' : 'off'}${ps.schedules ? `   schedules: ${ps.schedules}` : ''}${ps.anomalies ? `   anomalies: ${ps.anomalies}` : ''}`);
      for (const d of ps.devices || []) {
        log(`  ${highlight(d.id)} [${d.class}] ${d.loadW}W ${dim(d.active ? 'active' : 'idle')}`);
      }
      return { success: true, ...ps };
    }

    case 'schedules': {
      // Show configured per-device power schedules (time-boxed budgets).
      const res = pal.getPowerSchedules();
      if (flags.json) return { success: true, ...res };
      log(highlight(`Power schedules (${res.schedules.length}):`));
      if (!res.schedules.length) {
        log(dim('  none (set LIKU_PERIPHERAL_SCHEDULES=[{"id","fromHour","toHour","maxW","days?"}])'));
      }
      for (const s of res.schedules) {
        const win = `${s.fromHour}→${s.toHour}` + (s.fromHour !== s.resolvedFrom || s.toHour !== s.resolvedTo ? ` (${s.resolvedFrom}:00→${s.resolvedTo}:00)` : ':00');
        const days = Array.isArray(s.days) && s.days.length ? ` days:[${s.days.join(',')}]` : '';
        log(`  ${highlight(s.id)} ${win}  ≤${s.maxW}W${days}  ${dim(s.active ? 'IN WINDOW' : 'outside')}`);
      }
      return { success: true, ...res };
    }

    case 'locks': {
      // Phase 21: lock observability — live counters, per-file breakdown, and
      // contention trends over time (from the persisted lock-history log).
      const atomic = require('../../shared/atomic-file');
      const live = atomic.getLockMetrics();
      const perFile = atomic.getPerFileLockMetrics();
      const trends = pal.getLockTrends({ limit: 50 });
      if (flags.record) pal.recordLockSnapshot();
      if (flags.json) return { success: true, live, perFile, trends };
      log(highlight('Lock observability'));
      log(`  live: ${live.acquired} acquired, ${live.contended} contended, ${live.steals} steals, ${live.fallbacks} fallbacks, ${live.retries} retries`);
      const rate = live.acquired > 0 ? Math.round(live.contended / live.acquired * 1000) / 10 : 0;
      log(`  contention rate: ${rate}%`);
      const files = Object.entries(perFile).sort((a, b) => b[1].contended - a[1].contended || b[1].acquired - a[1].acquired).slice(0, 8);
      if (files.length) {
        log(highlight('  per-file:'));
        for (const [f, m] of files) log(`    ${f}  ${m.acquired} acq, ${m.contended} cont, ${m.steals} steal`);
      }
      if (trends && trends.snapshots) {
        log(highlight(`  trend (${trends.snapshots} snapshots):`));
        const d = trends.deltas || {};
        log(`    Δ contended ${d.contended || 0}, Δ steals ${d.steals || 0}, Δ fallbacks ${d.fallbacks || 0}`);
        for (const h of trends.hotFiles || []) log(dim(`    hot: ${h.file} (${h.contended} contended)`));
      } else {
        log(dim('  no history yet (snapshots accrue as stores are written; force one with --record)'));
      }
      // Phase 22: cluster-wide aggregation when a shared cluster dir is configured.
      const cluster = pal.getClusterLockMetrics();
      if (cluster && cluster.mode === 'cluster') {
        log(highlight(`  cluster (${cluster.nodes} node${cluster.nodes === 1 ? '' : 's'}):`));
        const ct = cluster.totals || {};
        log(`    total: ${ct.acquired || 0} acquired, ${ct.contended || 0} contended, ${ct.steals || 0} steals  (rate ${Math.round((cluster.contentionRate || 0) * 1000) / 10}%)`);
        for (const n of cluster.perNode || []) log(dim(`    ${n.nodeId}${n.live ? ' (live)' : ''}: ${n.metrics.acquired} acq, ${n.metrics.contended} cont`));
      }
      return { success: true, live, perFile, trends, cluster };
    }

    case 'coordination':
    case 'cluster': {
      // Phase 21: cross-host coordination status + optional lease management.
      const op = (args[1] || 'status').toLowerCase();
      if (op === 'lease' || op === 'release') {
        const id = args[2];
        if (!id) { error(`Usage: liku peripherals coordination ${op} <device-id>`); return { success: false }; }
        const res = op === 'lease' ? pal.acquireDeviceLease(id) : pal.releaseDeviceLease(id);
        if (flags.json) return { success: true, ...res };
        if (op === 'lease') success(`Lease for ${id}: ${res.granted ? 'GRANTED' : 'denied'}${res.local ? ' (single-machine/local)' : ''}${res.holder && !res.granted ? ` held by ${res.holder.nodeId}` : ''}`);
        else success(`Lease for ${id}: ${res.released ? 'released' : `not released (${res.reason})`}`);
        return { success: true, ...res };
      }
      const res = pal.getCoordinationStatus();
      if (flags.json) return { success: true, ...res };
      log(highlight('Cross-host coordination'));
      log(`  mode: ${res.mode}`);
      log(`  node: ${res.nodeId}`);
      log(`  clusterDir: ${res.clusterDir || dim('(unset — single-machine)')}`);
      if (res.enabled && res.mode === 'cluster') log(`  active leases: ${res.leases}`);
      else log(dim('  set LIKU_CLUSTER_DIR=<shared-path> to enable multi-node coordination'));
      return { success: true, ...res };
    }

    case 'cron': {
      // Phase 21/22: cron-based recurring device schedules. Sub-ops:
      //   (default)                 show rules + due advisory tasks
      //   propose <dev> <act> <cron>  propose a rule (not active until confirmed)
      //   confirm <proposalId>        persist a proposed rule (human gate)
      //   dismiss <proposalId>        decline a proposed rule
      //   rules                       list open proposals
      //   remove <ruleId>             remove a confirmed rule
      //   tick [--at <ISO>]           run the scheduler once → human-gated tasks
      const op = (args[1] || 'show').toLowerCase();
      if (op === 'propose') {
        const [, , deviceId, action, ...cronParts] = args;
        const cron = cronParts.join(' ');
        if (!deviceId || !action || !cron) { error('Usage: liku peripherals cron propose <deviceId> <action> "<cron>"'); return { success: false }; }
        const res = pal.proposeCronRule({ deviceId, action, cron });
        if (flags.json) return { success: !!res.ok, ...res };
        if (res.ok) { success(`Cron rule proposed for ${deviceId}:${action} "${cron}".`); log(dim(`  confirm: liku peripherals cron confirm ${res.proposal.id}`)); }
        else error(`Could not propose: ${res.reason || 'unknown'}`);
        return { success: !!res.ok, ...res };
      }
      if (op === 'confirm' || op === 'dismiss') {
        const id = args[2];
        if (!id) { error(`Usage: liku peripherals cron ${op} <proposal-id>`); return { success: false }; }
        const res = op === 'confirm' ? pal.confirmCronRule(id) : pal.dismissCronRule(id);
        if (flags.json) return { success: !!res.ok, ...res };
        if (res.ok && op === 'confirm') success(`Cron rule ${id} confirmed + persisted (now recurring, human-gated).`);
        else if (res.ok) success(`Cron proposal ${id} dismissed.`);
        else error(`Could not ${op} ${id}: ${res.reason || 'unknown'}`);
        return { success: !!res.ok, ...res };
      }
      if (op === 'remove') {
        const id = args[2];
        if (!id) { error('Usage: liku peripherals cron remove <rule-id>'); return { success: false }; }
        const res = pal.removeCronRule(id);
        if (flags.json) return { success: !!res.ok, ...res };
        if (res.ok) success(`Cron rule ${id} removed.`);
        else error(`Could not remove ${id}: ${res.reason || 'unknown'}`);
        return { success: !!res.ok, ...res };
      }
      if (op === 'rules') {
        const res = pal.getProposedCronRules();
        if (flags.json) return { success: true, ...res };
        log(highlight(`Proposed cron rules (${res.proposals.length}):`));
        if (!res.proposals.length) log(dim('  none (propose with: liku peripherals cron propose <dev> <act> "<cron>")'));
        for (const p of res.proposals) log(`  ${highlight(p.id)} ${dim(p.deviceId)} ${p.action}  ${dim(`"${p.cron}"`)}`);
        return { success: true, ...res };
      }
      if (op === 'tick') {
        // Run the real cron scheduler consumer once against a fresh Supervisor.
        const EventEmitter = require('events');
        const { SupervisorAgent, attachCronScheduler } = require('../../main/agents');
        const orch = new EventEmitter();
        orch.agents = new Map();
        orch.agents.set('supervisor', new SupervisorAgent({}));
        const sched = attachCronScheduler(orch, {});
        const at = flags.at ? new Date(flags.at) : new Date();
        const { created } = sched.tick(at);
        sched.detach();
        if (flags.json) return { success: true, created };
        success(`Cron tick @ ${at.toISOString().slice(0, 16)} → ${created.length} human-gated task(s) created.`);
        for (const t of created) log(`  ${highlight(t.id)} ${dim((t.device && t.device.id) || '?')} ${t.status} ${dim(t.priority)}`);
        return { success: true, created };
      }
      // Default view: configured rules + due advisory tasks.
      const rules = pal.getCronSchedules();
      const at = flags.at ? new Date(flags.at) : new Date();
      const due = pal.getDueCronTasks(at.getTime());
      if (flags.json) return { success: true, rules: rules.rules, dueAt: at.toISOString(), tasks: due.tasks };
      log(highlight(`Cron device schedules (${rules.rules.length}):`));
      if (!rules.rules.length) log(dim('  none (propose: liku peripherals cron propose <dev> <act> "<cron>"; or LIKU_DEVICE_CRON)'));
      for (const r of rules.rules) log(`  ${highlight(r.id)} ${dim(r.deviceId)} ${r.action}  ${dim(`"${r.cron}"`)}${r.valid ? '' : ' INVALID'} ${dim(r.source)}`);
      log(highlight(`\nDue at ${at.toISOString().slice(0, 16)} (${due.tasks.length} advisory task(s)):`));
      if (!due.tasks.length) log(dim('  none due this minute (advisory tasks are human-gated, never auto-run)'));
      for (const t of due.tasks) {
        const gate = t.requiresHuman ? highlight(' [Class A → human-gated]') : '';
        log(`  ${highlight(t.action)} ${t.deviceId}${gate}  ${dim(t.advisory)}`);
        log(dim(`     review then: liku peripherals execute ${t.deviceId} ${t.action}`));
      }
      return { success: true, rules: rules.rules, tasks: due.tasks };
    }

    case 'simulate': {
      // Hardware-in-the-loop helper: inject a simulated sensor reading so the
      // monitor/alert pipeline can be exercised without physical hardware.
      const id = args[1];
      if (!id) { error('Usage: liku peripherals simulate <id> <key=value> [<key=value>...]'); return { success: false }; }
      const metrics = {};
      for (const kv of args.slice(2)) {
        const eq = String(kv).indexOf('=');
        if (eq <= 0) continue;
        const key = kv.slice(0, eq).trim();
        const rawV = kv.slice(eq + 1).trim();
        const num = Number(rawV);
        metrics[key] = Number.isFinite(num) && rawV !== '' ? num : rawV;
      }
      if (!Object.keys(metrics).length) { error('Provide at least one key=value metric.'); return { success: false }; }
      const res = pal.ingestSensorReading(id, metrics);
      if (flags.json) return { success: !!res.ok, hil: pal.isHilEnabled(), ...res };
      if (res.ok) {
        success(`Injected simulated reading for ${id}${pal.isHilEnabled() ? ' (HIL on)' : ''}.`);
        log(dim(`  metrics: ${JSON.stringify(metrics)}`));
      } else {
        error(`Simulate failed: ${res.reason || 'unknown'}`);
      }
      return { success: !!res.ok, ...res };
    }

    case 'tasks': {
      // Human-facing view of durable peripheral tasks + notifications.
      const store = require('../../main/agents/supervisor-task-store');
      const { notifications, tasks } = store.load();
      // Phase 11: severity / escalation / pending filtering to cut through noise.
      let view = tasks.slice();
      if (flags.escalated) view = view.filter((t) => t.escalation === 'escalate');
      if (flags.pending) view = view.filter((t) => t.status === 'pending-review');
      if (flags.anomaly) view = view.filter((t) => t.source === 'power-anomaly' || (t.breach && t.breach.metric === 'power'));
      if (flags.severity) {
        const p = String(flags.severity).toLowerCase();
        view = view.filter((t) => String(t.priority || '').toLowerCase() === p);
      }
      if (flags.json) return { success: true, tasks: view, notifications };
      const filterNote = [
        flags.escalated ? 'escalated' : null,
        flags.pending ? 'pending' : null,
        flags.anomaly ? 'anomaly' : null,
        flags.severity ? `severity=${flags.severity}` : null
      ].filter(Boolean).join(', ');
      log(highlight(`Peripheral tasks (${view.length}${filterNote ? `, ${filterNote}` : ''}):`));
      for (const t of view) {
        const dev = (t.device && t.device.id) || '?';
        const br = t.breach ? `${t.breach.metric}:${t.breach.level}` : '';
        const ack = t.autoAcknowledged ? ' auto-ack' : '';
        const src = t.source === 'power-anomaly' ? ` ⚡${t.severityTier || t.priority}` : '';
        log(`  ${highlight(t.id)} [${t.priority}/${t.escalation || 'log'}] ${t.status}${ack}${src} ${dim(`${dev} ${br} x${t.count || 1}`)}`);
      }
      const pending = notifications.filter((n) => !n.acknowledged).length;
      log(dim(`  notifications: ${notifications.length} (${pending} unacknowledged)`));
      return { success: true, taskCount: view.length, notificationCount: notifications.length };
    }

    case 'notifications': {
      // Durable peripheral notifications, with optional unacknowledged-only view.
      const store = require('../../main/agents/supervisor-task-store');
      const { notifications } = store.load();
      let view = notifications.slice();
      if (flags.pending) view = view.filter((n) => !n.acknowledged);
      if (flags.severity) {
        const s = String(flags.severity).toLowerCase();
        view = view.filter((n) => String(n.severity || '').toLowerCase() === s);
      }
      if (flags.json) return { success: true, notifications: view };
      log(highlight(`Peripheral notifications (${view.length}):`));
      for (const n of view) {
        const dev = (n.device && n.device.id) || '?';
        const br = n.breach ? `${n.breach.metric}:${n.breach.level}` : '';
        const ack = n.autoAcknowledged ? 'auto-ack' : (n.acknowledged ? 'ack' : 'unack');
        const chans = Array.isArray(n.channels) && n.channels.length ? ` →${n.channels.join('+')}` : '';
        log(`  ${highlight(n.severity || 'info')} ${ack} ${dim(`${dev} ${br}${chans}`)}`);
      }
      return { success: true, notificationCount: view.length };
    }

    case 'channels': {
      // Show configured notification-escalation channels (observability).
      const channels = require('../../main/agents/notification-channels');
      const desc = channels.describe();
      if (flags.json) return { success: true, ...desc };
      log(highlight('Notification channels'));
      if (!desc.channels.length) {
        log(dim('  inbox only (set LIKU_PERIPHERAL_CHANNELS=log,file,webhook to add sinks)'));
      } else {
        log('  inbox (always on)');
        for (const c of desc.channels) {
          const warn = c.configured ? '' : dim(' (not configured)');
          log(`  ${highlight(c.channel)} min-severity=${c.minSeverity}${warn}`);
        }
      }
      log(dim(`  audit file: ${desc.auditFile}`));
      return { success: true, ...desc };
    }

    default:
      error(`Unknown subcommand: ${sub}`);
      log('Usage: liku peripherals [scan|list|status [id]|power [--history|--trend|--anomalies|--forecast [--seasonal] [--exclude-anomalous]]|anomalies [--attributed]|anomaly-action [confirm|dismiss <id>|policy [set <device> reduce=N rotate=N unpair=N]]|schedules|locks [--record]|coordination [lease|release <id>]|cron [propose|confirm|dismiss|rules|tick|remove]|suggestions|apply-schedule <id>|pair <id>|unpair <id>|token [rotate|revoke|rotate-all|action <id> <action>]|tasks [--escalated|--pending|--severity <p>|--anomaly]|notifications|channels|simulate <id> <k=v>|execute <id> <action>|confirm <id> <action> [--execute]|drivers]');
      return { success: false };
  }
}

module.exports = { run };
