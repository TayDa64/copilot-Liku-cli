#!/usr/bin/env node

// Phase 49: opt-in transport measurement harness.
// Lab only — does not change TransportManager.select() and never calls vendor APIs.

'use strict';

const bench = require('../src/main/agents/transport-bench');

async function main() {
  if (!bench.isTransportBenchEnabled(process.env)) {
    console.error('LIKU_TRANSPORT_BENCH is off. Export LIKU_TRANSPORT_BENCH=1 to run the harness.');
    console.error('This is a measurement harness only — it does not enable http2/http3/quic production kinds.');
    process.exitCode = 2;
    return;
  }

  const iterations = Math.max(1, Number(process.env.LIKU_TRANSPORT_BENCH_N) || 8);
  const result = await bench.runTransportBench({
    iterations,
    adapters: bench.defaultAdapters(),
    persist: true
  });

  console.log('Transport bench (harness only — not a production switch)');
  console.log(result.table);
  if (result.file) console.log(`\nwrote ${result.file}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
