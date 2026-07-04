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
      if (!id) { error('Usage: liku peripherals status <id>'); return { success: false }; }
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
        log(`  Approve with: ${dim(`liku system-context confirm ${res.confirmKey} --apply`)}`);
        log(`  Then re-run: ${dim(`liku peripherals execute ${id} ${action}`)}`);
      } else {
        error(`Action not performed: ${res.reason || 'unknown'}`);
      }
      return { success: !!res.ok, ...res };
    }

    default:
      error(`Unknown subcommand: ${sub}`);
      log('Usage: liku peripherals [scan|list|status <id>|execute <id> <action>]');
      return { success: false };
  }
}

module.exports = { run };
