/**
 * liku analytics — View telemetry analytics from the cognitive layer
 *
 * Usage:
 *   liku analytics            Summary for today
 *   liku analytics --days 7   Summary for last 7 days
 *   liku analytics --raw      Dump raw telemetry entries
 */

const { log, success, error, dim, highlight, bold } = require('../util/output');

function getTelemetryWriter() {
  return require('../../main/telemetry/telemetry-writer');
}

async function run(args, flags) {
  if (flags.help || args.includes('--help')) {
    showHelp();
    return { success: true };
  }

  const telemetry = getTelemetryWriter();
  const days = Math.max(1, parseInt(flags.days, 10) || 1);
  const raw = !!flags.raw;

  // Collect entries for the requested date range
  const allEntries = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    try {
      const entries = telemetry.readTelemetry(dateStr);
      allEntries.push(...entries);
    } catch {
      // No telemetry for this date
    }
  }

  if (allEntries.length === 0) {
    log(`No telemetry data found for the last ${days} day(s).`);
    return { success: true, count: 0 };
  }

  if (raw) {
    for (const entry of allEntries) {
      log(JSON.stringify(entry));
    }
    return { success: true, count: allEntries.length };
  }

  // Compute analytics
  const outcomes = { success: 0, failure: 0, other: 0 };
  const taskCounts = {};
  const phaseCounts = {};
  const failureReasons = {};

  for (const entry of allEntries) {
    const outcome = (entry.outcome || 'other').toLowerCase();
    if (outcome === 'success') outcomes.success++;
    else if (outcome === 'failure') outcomes.failure++;
    else outcomes.other++;

    const task = entry.task || 'unknown';
    taskCounts[task] = (taskCounts[task] || 0) + 1;

    const phase = entry.phase || 'unknown';
    phaseCounts[phase] = (phaseCounts[phase] || 0) + 1;

    if (outcome === 'failure' && entry.context) {
      const reason = entry.context.error || entry.context.reason || 'unknown';
      const shortened = String(reason).slice(0, 80);
      failureReasons[shortened] = (failureReasons[shortened] || 0) + 1;
    }
  }

  const total = allEntries.length;
  const successRate = total > 0 ? ((outcomes.success / total) * 100).toFixed(1) : '0.0';

  // Display
  console.log(`\n${bold('Liku Analytics')} ${dim(`(${days} day${days > 1 ? 's' : ''}, ${total} events)`)}\n`);

  console.log(`${highlight('Success Rate:')} ${successRate}% (${outcomes.success}/${total})`);
  console.log(`  ${dim('success:')} ${outcomes.success}  ${dim('failure:')} ${outcomes.failure}  ${dim('other:')} ${outcomes.other}\n`);

  // Top tasks
  const topTasks = Object.entries(taskCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (topTasks.length > 0) {
    console.log(`${highlight('Top Tasks:')}`);
    for (const [task, count] of topTasks) {
      console.log(`  ${count.toString().padStart(4)} × ${task}`);
    }
    console.log();
  }

  // Phase breakdown
  const phases = Object.entries(phaseCounts).sort((a, b) => b[1] - a[1]);
  if (phases.length > 0) {
    console.log(`${highlight('Phase Breakdown:')}`);
    for (const [phase, count] of phases) {
      console.log(`  ${count.toString().padStart(4)} × ${phase}`);
    }
    console.log();
  }

  // Common failures
  const topFailures = Object.entries(failureReasons).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (topFailures.length > 0) {
    console.log(`${highlight('Common Failures:')}`);
    for (const [reason, count] of topFailures) {
      console.log(`  ${count.toString().padStart(4)} × ${reason}`);
    }
    console.log();
  }

  return { success: true, count: total, successRate: parseFloat(successRate) };
}

function showHelp() {
  console.log(`
${bold('liku analytics')} — View telemetry analytics

${highlight('USAGE:')}
  liku analytics              Summary for today
  liku analytics --days 7     Summary for last 7 days
  liku analytics --raw        Dump raw telemetry entries
  liku analytics --json       Output as JSON

${highlight('OPTIONS:')}
  --days <n>    Number of days to include (default: 1)
  --raw         Print raw JSONL entries
  --json        Machine-readable JSON output
`);
}

module.exports = { run, showHelp };
