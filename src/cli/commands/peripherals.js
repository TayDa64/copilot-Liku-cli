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
 *   liku peripherals tasks [--escalated|--pending|--severity <p>]
 *                                       Human-gated peripheral tasks (filterable)
 *   liku peripherals notifications [--pending|--severity <s>]
 *   liku peripherals channels           Show escalation notification channels
 *   liku peripherals power [--history|--trend|--anomalies]
 *                                       Live budget + rolling power telemetry
 *   liku peripherals schedules          Show per-device time-boxed power budgets
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
        log(`  peak: ${ps.peakW}W  avg: ${ps.avgW}W  (${ps.samples} samples)${ps.anomalies ? `  anomalies: ${ps.anomalies}` : ''}`);
        log(`  locking: ${ps.locking || 'advisory-file-lock'}   HIL: ${ps.hil ? 'ON (simulation)' : 'off'}`);
        try {
          const lm = require('../../shared/atomic-file').getLockMetrics();
          log(`  locks: ${lm.acquired} acquired, ${lm.contended} contended, ${lm.steals} steals, ${lm.fallbacks} fallbacks`);
        } catch { /* observability only */ }
        try {
          const channels = require('../../main/agents/notification-channels').describe();
          const names = channels.channels.map((c) => c.channel);
          log(`  channels: inbox${names.length ? ', ' + names.join(', ') : ' (only)'}`);
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
      if (flags.json) return { success: true, ...res };
      log(highlight(`Available drivers: ${res.drivers.join(', ') || 'none'}`));
      return { success: true, ...res };
    }

    case 'power': {
      const ps = pal.powerStatus();
      // Phase 13: --anomalies surfaces detected power anomalies.
      if (flags.anomalies) {
        const res = pal.getPowerAnomalies();
        if (flags.json) return { success: true, ...res };
        log(highlight(`Power anomalies (${res.anomalies.length}):`));
        if (!res.anomalies.length) log(dim(`  none (baseline ${res.baselineW}W, ${res.samples} samples)`));
        for (const a of res.anomalies) {
          log(`  ${highlight(a.type)}  ${a.valueW}W vs baseline ${a.baselineW}W  ${dim(a.advisory || '')}`);
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
      if (flags.severity) {
        const p = String(flags.severity).toLowerCase();
        view = view.filter((t) => String(t.priority || '').toLowerCase() === p);
      }
      if (flags.json) return { success: true, tasks: view, notifications };
      const filterNote = [
        flags.escalated ? 'escalated' : null,
        flags.pending ? 'pending' : null,
        flags.severity ? `severity=${flags.severity}` : null
      ].filter(Boolean).join(', ');
      log(highlight(`Peripheral tasks (${view.length}${filterNote ? `, ${filterNote}` : ''}):`));
      for (const t of view) {
        const dev = (t.device && t.device.id) || '?';
        const br = t.breach ? `${t.breach.metric}:${t.breach.level}` : '';
        const ack = t.autoAcknowledged ? ' auto-ack' : '';
        log(`  ${highlight(t.id)} [${t.priority}/${t.escalation || 'log'}] ${t.status}${ack} ${dim(`${dev} ${br} x${t.count || 1}`)}`);
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
      log('Usage: liku peripherals [scan|list|status [id]|power [--history|--trend|--anomalies]|schedules|tasks [--escalated|--pending|--severity <p>]|notifications|channels|simulate <id> <k=v>|execute <id> <action>|confirm <id> <action> [--execute]|drivers]');
      return { success: false };
  }
}

module.exports = { run };
