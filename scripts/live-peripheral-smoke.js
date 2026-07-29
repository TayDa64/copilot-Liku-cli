#!/usr/bin/env node
/**
 * Live-Hardware Smoke Harness CLI (Phase 40).
 *
 * A dedicated CI/operator entry point that exercises the REAL Thread / Z-Wave /
 * KNX / USB-HID driver paths through the hardened live gate + the full PAL safety
 * chain. It NO-OPS (clean skip, exit 0) unless explicitly opted in, so a CI job
 * without the flag is a safe no-op.
 *
 * ENABLE (simulated live path — no hardware, safe for CI):
 *   LIKU_PERIPHERAL_LIVE_SMOKE=1 node scripts/live-peripheral-smoke.js
 *
 * ENABLE (REAL hardware — operator with devices):
 *   LIKU_PERIPHERAL_LIVE=1 node scripts/live-peripheral-smoke.js --real
 *
 * SAFETY: every action runs through PAL.execute (DCP → class gate → pending/confirm).
 * Class A stays confirm-gated; only safe Class B actions auto-dispatch. HIL isolation
 * is asserted. Runs in an ISOLATED temp home — never pollutes ~/.liku.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate persistence BEFORE loading any peripheral module (no real-home pollution).
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-live-smoke-'));
process.env.LIKU_HOME_OVERRIDE = TMP_HOME;

const smoke = require('../src/main/peripherals/live-smoke');
const real = process.argv.includes('--real');

const res = smoke.runSmoke({ simulated: !real });
if (!res.enabled) {
  console.log(`live-peripheral-smoke: disabled — ${res.reason}. Skipping (exit 0).`);
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(0);
}

console.log(`Live-hardware smoke harness (${real ? 'REAL' : 'simulated'} mode)\n`);
let failed = 0;
for (const r of res.results) {
  console.log(`  ${r.ok ? '\u2713' : '\u2717'} ${r.driver}`);
  for (const c of r.checks) {
    if (!c.ok) failed++;
    console.log(`      ${c.ok ? '\u2713' : '\u2717'} ${c.name}`);
  }
  if (r.checks._error) console.log(`      ! ${r.checks._error}`);
}
console.log(`\n${res.ok ? 'OK' : 'FAILED'} — ${res.results.length} drivers, ${failed} failed checks.`);
try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(res.ok ? 0 : 1);
