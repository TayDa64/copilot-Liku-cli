#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { LIKU_HOME } = require(path.join(__dirname, '..', 'src', 'shared', 'liku-home.js'));

const PROOF_RESULT_LOG = path.join(LIKU_HOME, 'telemetry', 'logs', 'chat-inline-proof-results.jsonl');
const PHASE3_POSTFIX_STARTED_AT = '2026-03-21T05:17:35.645Z';
const PHASE3_POSTFIX_STARTED_AT_MS = Date.parse(PHASE3_POSTFIX_STARTED_AT);

function getArgValue(flagName) {
  const index = process.argv.indexOf(flagName);
  if (index >= 0 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return null;
}

function hasFlag(flagName) {
  return process.argv.includes(flagName);
}

function parseProofEntries(filePath = PROOF_RESULT_LOG) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const text = fs.readFileSync(filePath, 'utf8');
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines rather than failing the full report.
    }
  }
  return entries;
}

function resolveEntryModel(entry) {
  return entry?.requestedModel || entry?.observedRequestedModels?.[0] || entry?.observedRuntimeModels?.[0] || 'default';
}

function resolveEntryCohort(entry) {
  const timestamp = Date.parse(entry?.timestamp || '');
  if (!Number.isFinite(timestamp)) return 'unknown';
  return timestamp >= PHASE3_POSTFIX_STARTED_AT_MS ? 'phase3-postfix' : 'pre-phase3-postfix';
}

function passesFilter(entry, filters = {}) {
  if (filters.suite && entry.suite !== filters.suite) return false;
  if (filters.model && resolveEntryModel(entry) !== filters.model) return false;
  if (filters.mode && entry.mode !== filters.mode) return false;
  if (filters.cohort && resolveEntryCohort(entry) !== filters.cohort) return false;
  if (filters.since) {
    const timestamp = Date.parse(entry.timestamp || '');
    if (!Number.isFinite(timestamp) || timestamp < filters.since) return false;
  }
  return true;
}

function buildTrend(entries, limit = 8) {
  return entries
    .slice()
    .sort((left, right) => Date.parse(left.timestamp || 0) - Date.parse(right.timestamp || 0))
    .slice(-limit)
    .map((entry) => (entry.passed ? 'P' : 'F'))
    .join('');
}

function summarizeProofEntries(entries) {
  const normalized = entries.slice().sort((left, right) => Date.parse(right.timestamp || 0) - Date.parse(left.timestamp || 0));
  const totals = {
    runs: normalized.length,
    passed: normalized.filter((entry) => entry.passed).length,
    failed: normalized.filter((entry) => !entry.passed).length
  };
  totals.passRate = totals.runs > 0 ? Number(((totals.passed / totals.runs) * 100).toFixed(1)) : 0;

  const bySuite = new Map();
  const byModel = new Map();
  const bySuiteModel = new Map();
  const byCohort = new Map();

  for (const entry of normalized) {
    const suiteKey = entry.suite || 'unknown';
    const modelKey = resolveEntryModel(entry);
    const cohortKey = resolveEntryCohort(entry);
    const suiteModelKey = `${suiteKey}::${modelKey}`;

    for (const [bucket, key] of [[bySuite, suiteKey], [byModel, modelKey], [bySuiteModel, suiteModelKey], [byCohort, cohortKey]]) {
      if (!bucket.has(key)) bucket.set(key, []);
      bucket.get(key).push(entry);
    }
  }

  const materialize = (bucket, mapper) => [...bucket.entries()]
    .map(([key, bucketEntries]) => mapper(key, bucketEntries))
    .sort((left, right) => right.runs - left.runs || left.key.localeCompare(right.key));

  return {
    totals,
    phase3PostfixStartedAt: PHASE3_POSTFIX_STARTED_AT,
    bySuite: materialize(bySuite, (key, bucketEntries) => {
      const passed = bucketEntries.filter((entry) => entry.passed).length;
      return {
        key,
        runs: bucketEntries.length,
        passed,
        failed: bucketEntries.length - passed,
        passRate: Number(((passed / bucketEntries.length) * 100).toFixed(1)),
        trend: buildTrend(bucketEntries),
        lastRunAt: bucketEntries[0]?.timestamp || null,
        models: [...new Set(bucketEntries.map((entry) => resolveEntryModel(entry)))].sort()
      };
    }),
    byModel: materialize(byModel, (key, bucketEntries) => {
      const passed = bucketEntries.filter((entry) => entry.passed).length;
      return {
        key,
        runs: bucketEntries.length,
        passed,
        failed: bucketEntries.length - passed,
        passRate: Number(((passed / bucketEntries.length) * 100).toFixed(1)),
        trend: buildTrend(bucketEntries),
        lastRunAt: bucketEntries[0]?.timestamp || null,
        runtimeModels: [...new Set(bucketEntries.flatMap((entry) => entry.observedRuntimeModels || []))].sort()
      };
    }),
    byCohort: materialize(byCohort, (key, bucketEntries) => {
      const passed = bucketEntries.filter((entry) => entry.passed).length;
      return {
        key,
        runs: bucketEntries.length,
        passed,
        failed: bucketEntries.length - passed,
        passRate: Number(((passed / bucketEntries.length) * 100).toFixed(1)),
        trend: buildTrend(bucketEntries),
        lastRunAt: bucketEntries[0]?.timestamp || null,
        models: [...new Set(bucketEntries.map((entry) => resolveEntryModel(entry)))].sort()
      };
    }),
    bySuiteModel: materialize(bySuiteModel, (key, bucketEntries) => {
      const [suite, model] = key.split('::');
      const passed = bucketEntries.filter((entry) => entry.passed).length;
      return {
        key,
        suite,
        model,
        runs: bucketEntries.length,
        passed,
        failed: bucketEntries.length - passed,
        passRate: Number(((passed / bucketEntries.length) * 100).toFixed(1)),
        trend: buildTrend(bucketEntries),
        lastRunAt: bucketEntries[0]?.timestamp || null
      };
    })
  };
}

function formatPercent(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function printGroup(title, rows, formatter) {
  if (!rows.length) return;
  console.log(`\n${title}`);
  for (const row of rows) {
    console.log(formatter(row));
  }
}

function main() {
  const suite = getArgValue('--suite') || null;
  const model = getArgValue('--model') || null;
  const mode = getArgValue('--mode') || null;
  const rawSince = getArgValue('--since');
  const cohort = hasFlag('--phase3-postfix') ? 'phase3-postfix' : (getArgValue('--cohort') || null);
  const limit = Math.max(1, parseInt(getArgValue('--limit'), 10) || 10);
  const days = Math.max(0, parseInt(getArgValue('--days'), 10) || 0);
  const since = rawSince ? Date.parse(rawSince) : null;
  const filters = {
    suite,
    model,
    mode,
    cohort,
    since: Number.isFinite(since)
      ? since
      : (days > 0 ? Date.now() - (days * 24 * 60 * 60 * 1000) : null)
  };

  const entries = parseProofEntries().filter((entry) => passesFilter(entry, filters));
  if (entries.length === 0) {
    console.log('No inline proof runs matched the requested filters.');
    return;
  }

  if (hasFlag('--raw')) {
    for (const entry of entries) {
      console.log(JSON.stringify(entry));
    }
    return;
  }

  const summary = summarizeProofEntries(entries);
  if (hasFlag('--json')) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log('Inline Chat Proof Summary');
  console.log(`Runs: ${summary.totals.runs} | Passed: ${summary.totals.passed} | Failed: ${summary.totals.failed} | Pass rate: ${formatPercent(summary.totals.passRate)}`);
  if (!filters.cohort) {
    console.log(`Phase 3 post-fix cohort starts at: ${summary.phase3PostfixStartedAt}`);
  }

  printGroup('By Cohort', summary.byCohort.slice(0, limit), (row) => {
    const models = row.models.length ? ` | models=${row.models.join(',')}` : '';
    return `- ${row.key}: ${row.passed}/${row.runs} passed (${formatPercent(row.passRate)}) | trend=${row.trend || '-'}${models}`;
  });

  printGroup('By Suite', summary.bySuite.slice(0, limit), (row) => {
    const models = row.models.length ? ` | models=${row.models.join(',')}` : '';
    return `- ${row.key}: ${row.passed}/${row.runs} passed (${formatPercent(row.passRate)}) | trend=${row.trend || '-'}${models}`;
  });

  printGroup('By Model', summary.byModel.slice(0, limit), (row) => {
    const runtimes = row.runtimeModels.length ? ` | runtime=${row.runtimeModels.join(',')}` : '';
    return `- ${row.key}: ${row.passed}/${row.runs} passed (${formatPercent(row.passRate)}) | trend=${row.trend || '-'}${runtimes}`;
  });

  printGroup('Suite x Model', summary.bySuiteModel.slice(0, limit), (row) => (
    `- ${row.suite} @ ${row.model}: ${row.passed}/${row.runs} passed (${formatPercent(row.passRate)}) | trend=${row.trend || '-'}`
  ));
}

if (require.main === module) {
  main();
}

module.exports = {
  PHASE3_POSTFIX_STARTED_AT,
  PROOF_RESULT_LOG,
  parseProofEntries,
  resolveEntryCohort,
  resolveEntryModel,
  summarizeProofEntries,
  buildTrend,
  passesFilter
};