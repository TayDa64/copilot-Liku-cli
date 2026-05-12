#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const DEFAULT_ARTIFACT_DIR = path.join(__dirname, '..', 'artifacts', 'live-validation');

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

function findLatestManifest(artifactDir) {
  const candidates = fs.readdirSync(artifactDir)
    .filter((name) => /-tradingview-live-smoke\.manifest\.json$/i.test(name))
    .sort();
  if (!candidates.length) {
    throw new Error(`No TradingView live smoke manifest was found in ${artifactDir}`);
  }
  return path.join(artifactDir, candidates[candidates.length - 1]);
}

function normalizeNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function buildLatencySummary(manifest = {}) {
  const scenarios = Array.isArray(manifest?.scenarios) ? manifest.scenarios : [];
  const slowActionGaps = [];
  const slowMethods = [];
  const quickSearchSummary = [];

  for (const scenario of scenarios) {
    const metrics = scenario?.metrics || {};
    for (const entry of Array.isArray(metrics?.actionTimeline) ? metrics.actionTimeline : []) {
      if (normalizeNumber(entry?.sincePreviousMs) <= 0) continue;
      slowActionGaps.push({
        scenarioId: scenario.id || null,
        index: entry.index,
        action: entry.action || null,
        sincePreviousMs: normalizeNumber(entry.sincePreviousMs),
        elapsedMs: normalizeNumber(entry.elapsedMs),
        success: entry.success === true,
        error: entry.error || null
      });
    }

    for (const method of Array.isArray(metrics?.systemAutomationProfile?.methods) ? metrics.systemAutomationProfile.methods : []) {
      slowMethods.push({
        scenarioId: scenario.id || null,
        methodName: method.methodName || null,
        callCount: normalizeNumber(method.callCount),
        totalMs: normalizeNumber(method.totalMs),
        avgMs: normalizeNumber(method.avgMs),
        maxMs: normalizeNumber(method.maxMs),
        errorCount: normalizeNumber(method.errorCount)
      });
    }

    quickSearchSummary.push({
      scenarioId: scenario.id || null,
      clipboardTouchCount: normalizeNumber(metrics?.clipboardTouchCount),
      quickSearchPreflightCount: normalizeNumber(metrics?.quickSearchPreflightCount),
      quickSearchPreflightTimeoutCount: normalizeNumber(metrics?.quickSearchPreflightTimeoutCount),
      quickSearchFallbackAssumedCount: normalizeNumber(metrics?.quickSearchFallbackAssumedCount),
      quickSearchTypedVerificationFailureCount: normalizeNumber(metrics?.quickSearchTypedVerificationFailureCount),
      foregroundOffAppTransitions: normalizeNumber(metrics?.foregroundTelemetry?.offAppTransitions)
    });
  }

  return {
    runTag: manifest.runTag || null,
    manifestPath: manifest.__manifestPath || null,
    startedAt: manifest.startedAt || null,
    finishedAt: manifest.finishedAt || null,
    success: manifest.success === true,
    scenarioCount: scenarios.length,
    topActionGaps: slowActionGaps.sort((left, right) => right.sincePreviousMs - left.sincePreviousMs).slice(0, 5),
    topMethodsByTotal: slowMethods.sort((left, right) => right.totalMs - left.totalMs).slice(0, 5),
    topMethodsByMax: slowMethods.slice().sort((left, right) => right.maxMs - left.maxMs).slice(0, 5),
    quickSearchSummary
  };
}

function printHumanSummary(summary) {
  console.log('TradingView live latency summary');
  console.log(`- runTag: ${summary.runTag || 'unknown'}`);
  console.log(`- manifest: ${summary.manifestPath || 'unknown'}`);
  console.log(`- success: ${summary.success}`);
  console.log(`- scenarios: ${summary.scenarioCount}`);

  console.log('\nTop action gaps');
  if (!summary.topActionGaps.length) {
    console.log('- none recorded');
  } else {
    summary.topActionGaps.forEach((entry) => {
      console.log(`- ${entry.scenarioId} action[${entry.index}] ${entry.action || 'action'}: ${entry.sincePreviousMs}ms since previous (${entry.success ? 'ok' : entry.error || 'failed'})`);
    });
  }

  console.log('\nTop automation methods by total latency');
  if (!summary.topMethodsByTotal.length) {
    console.log('- none recorded');
  } else {
    summary.topMethodsByTotal.forEach((entry) => {
      console.log(`- ${entry.scenarioId} ${entry.methodName}: total=${entry.totalMs}ms avg=${entry.avgMs}ms max=${entry.maxMs}ms calls=${entry.callCount}`);
    });
  }

  console.log('\nQuick-search / foreground summary');
  if (!summary.quickSearchSummary.length) {
    console.log('- none recorded');
  } else {
    summary.quickSearchSummary.forEach((entry) => {
      console.log(`- ${entry.scenarioId}: clipboardTouches=${entry.clipboardTouchCount} preflights=${entry.quickSearchPreflightCount} timeouts=${entry.quickSearchPreflightTimeoutCount} fallbackAssumed=${entry.quickSearchFallbackAssumedCount} typedVerifyFailures=${entry.quickSearchTypedVerificationFailureCount} offAppTransitions=${entry.foregroundOffAppTransitions}`);
    });
  }
}

function main() {
  const artifactDir = path.resolve(process.cwd(), getArgValue('--artifact-dir') || DEFAULT_ARTIFACT_DIR);
  const manifestPath = path.resolve(process.cwd(), getArgValue('--manifest') || findLatestManifest(artifactDir));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.__manifestPath = manifestPath;

  const summary = buildLatencySummary(manifest);
  if (hasFlag('--json')) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  printHumanSummary(summary);
}

try {
  main();
} catch (error) {
  console.error('FAIL tradingview latency profile');
  console.error(error.stack || error.message);
  process.exit(1);
}
