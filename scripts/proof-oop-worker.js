#!/usr/bin/env node

/**
 * External proof for the out-of-process lab.
 * Reads /proc for the child. Does not trust the child's own report alone.
 * Real QUIC is reported as not attempted.
 */

const fs = require('fs');
const path = require('path');

const oop = require(path.join(__dirname, '..', 'src', 'main', 'agents', 'oop-worker.js'));
const { createTransportManager } = require(path.join(__dirname, '..', 'src', 'main', 'agents', 'transport-fabric.js'));

const SENTINEL = 'proof-sentinel-not-a-secret';
const checks = [];

function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (!ok) process.exitCode = 1;
}

function childStatus(pid) {
  return fs.readFileSync(`/proc/${pid}/status`, 'utf8');
}

async function main() {
  delete process.env.LIKU_QUIC_WORKER_LAB;
  delete process.env.LIKU_OOP_WORKER;

  let http3 = null;
  try {
    createTransportManager().select({ kind: 'http3' });
    http3 = 'selected';
  } catch (error) {
    http3 = error.code || error.message;
  }
  record('select-http3-throws', http3 === 'unsupported-transport', http3);

  let quic = null;
  try {
    createTransportManager().select({ kind: 'quic' });
    quic = 'selected';
  } catch (error) {
    quic = error.code || error.message;
  }
  record('select-quic-throws-without-lab', quic === 'unsupported-transport', quic);

  let disabled = null;
  try {
    await oop.runIsolated({ op: 'identity', taskId: 'disabled' });
    disabled = 'ran';
  } catch (error) {
    disabled = error.code || error.message;
  }
  record('flag-off-no-dispatch', disabled === 'oop-worker-disabled', disabled);

  if (process.platform !== 'linux') {
    record('proc-proof', false, 'skipped-not-linux');
  } else {
    process.env.LIKU_OOP_WORKER = '1';
    process.env.LIKU_PROOF_SENTINEL = SENTINEL;
    process.env.OPENAI_API_KEY = 'sk-proof-should-not-cross';
    const handle = await oop.spawnWorker();
    try {
      const status = childStatus(handle.pid);
      const ppid = Number((status.match(/^PPid:\s+(\d+)/m) || [])[1]);
      const environ = fs.readFileSync(`/proc/${handle.pid}/environ`);
      record('child-pid-differs', handle.pid !== process.pid, String(handle.pid));
      record('child-ppid-is-parent', ppid === process.pid, String(ppid));
      record('sentinel-absent', !environ.includes(Buffer.from(SENTINEL)), 'environ');
      record('openai-key-absent', !environ.includes(Buffer.from('sk-proof-should-not-cross')), 'environ');
      record('openai-name-absent', !environ.includes(Buffer.from('OPENAI_API_KEY')), 'environ');
      const result = await handle.invoke({ op: 'identity', taskId: 'proof-id' });
      record('ipc-pid-matches-proc', result.pid === handle.pid && result.ppid === process.pid, `${result.pid}`);
    } finally {
      await handle.close();
      delete process.env.LIKU_PROOF_SENTINEL;
      delete process.env.OPENAI_API_KEY;
    }

    const before = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name));
    let vendor = null;
    try {
      await oop.runIsolated({ op: 'ping', taskId: 'vendor', payload: { url: 'https://api.x.ai/v1' } });
      vendor = 'ran';
    } catch (error) {
      vendor = error.code || error.message;
    }
    record('vendor-rejected', vendor === 'oop-vendor-forbidden', vendor);
    const after = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name));
    const extra = after.filter((pid) => !before.includes(pid));
    const stillOurs = extra.filter((pid) => {
      try {
        const status = childStatus(pid);
        return status.includes(`PPid:\t${process.pid}`);
      } catch {
        return false;
      }
    });
    record('vendor-rejection-spawned-nothing', stillOurs.length === 0, String(stillOurs.length));
  }

  const report = {
    slice: 'oop-worker-lab',
    realQuic: 'not-attempted',
    reason: 'Node has no node:quic here and no native QUIC dependency was added',
    node: process.version,
    parentPid: process.pid,
    checks
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
