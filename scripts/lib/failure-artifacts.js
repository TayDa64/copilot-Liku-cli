const fs = require('fs');
const path = require('path');
const { readRuntimeTraceEntries } = require(path.join(__dirname, '..', 'extract-runtime-trace-regression.js'));

const DEFAULT_FAILURE_ARTIFACT_DIR = path.join(__dirname, '..', '..', 'artifacts', 'test-failures');
const DEFAULT_TRACE_TAIL_COUNT = 40;
const RELEVANT_ENV_KEYS = Object.freeze([
  'LIKU_USE_AUTOMATION_HOST',
  'LIKU_DISABLE_RUNTIME_TRACE',
  'LIKU_TRADINGVIEW_QUICK_SEARCH_PREFLIGHT_TIMEOUT_MS',
  'LIKU_TRADINGVIEW_QUICK_SEARCH_DISCOVERY_TIMEOUT_MS',
  'LIKU_PINE_READBACK_TIMEOUT_MS',
  'LIKU_USE_TOOL_REGISTRY_REWRITES',
  'LIKU_USE_TOOL_REGISTRY_RISKS'
]);

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function buildTimestampTag() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function sanitizeFileSegment(value, fallback = 'failure') {
  const sanitized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || fallback;
}

function cloneSerializable(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function selectRelevantEnv() {
  const selected = {};
  for (const key of RELEVANT_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim()) {
      selected[key] = value;
    }
  }
  return selected;
}

function summarizeError(error = null) {
  if (!error) {
    return null;
  }

  const cause = error?.cause && typeof error.cause === 'object'
    ? {
        name: String(error.cause.name || '').trim() || null,
        message: String(error.cause.message || '').trim() || null,
        stack: String(error.cause.stack || '').trim() || null
      }
    : null;

  return {
    name: String(error?.name || 'Error').trim() || 'Error',
    message: String(error?.message || error || '').trim() || 'Unknown failure',
    stack: String(error?.stack || '').trim() || null,
    code: error?.code || null,
    timedOut: error?.timedOut === true,
    cause
  };
}

function readTraceTail(filePath, maxEntries = DEFAULT_TRACE_TAIL_COUNT) {
  const resolved = String(filePath || '').trim();
  if (!resolved || !fs.existsSync(resolved)) {
    return [];
  }

  try {
    const entries = readRuntimeTraceEntries(resolved);
    return Array.isArray(entries) ? entries.slice(-Math.max(1, Number(maxEntries) || DEFAULT_TRACE_TAIL_COUNT)) : [];
  } catch {
    return [];
  }
}

function exportRuntimeTrace(aiService, destinationPath = null) {
  if (!aiService || typeof aiService.exportLastRuntimeTrace !== 'function') {
    return null;
  }

  try {
    return aiService.exportLastRuntimeTrace(destinationPath);
  } catch (error) {
    return {
      error: String(error?.message || error || 'Failed to export runtime trace')
    };
  }
}

function getRuntimeTraceSummary(aiService) {
  if (!aiService || typeof aiService.getLastRuntimeTraceSummary !== 'function') {
    return null;
  }
  try {
    return cloneSerializable(aiService.getLastRuntimeTraceSummary(), null);
  } catch {
    return null;
  }
}

function formatRuntimeTraceSummary(aiService, summary = null) {
  if (!aiService || typeof aiService.formatLastRuntimeTraceSummary !== 'function') {
    return null;
  }
  try {
    const formatted = aiService.formatLastRuntimeTraceSummary(summary);
    return String(formatted || '').trim() || null;
  } catch {
    return null;
  }
}

function getWatcherSnapshot(watcher = null) {
  if (!watcher || typeof watcher.getCapabilitySnapshot !== 'function') {
    return null;
  }
  try {
    return cloneSerializable(watcher.getCapabilitySnapshot(), null);
  } catch {
    return null;
  }
}

async function getForegroundSnapshot(systemAutomation = null) {
  if (!systemAutomation || typeof systemAutomation.getForegroundWindowInfo !== 'function') {
    return null;
  }
  try {
    return cloneSerializable(await systemAutomation.getForegroundWindowInfo(), null);
  } catch (error) {
    return {
      success: false,
      error: String(error?.message || error || 'Failed to capture foreground snapshot')
    };
  }
}

function buildBaseBundle(options = {}) {
  const {
    suiteName = 'failure',
    failureName = 'failure',
    phase = null,
    scenarioId = null,
    error = null,
    extra = null,
    runtimeTraceSummary = null,
    runtimeTraceFormatted = null,
    exportedTrace = null,
    traceTail = []
  } = options;

  return {
    capturedAt: new Date().toISOString(),
    suiteName: String(suiteName || 'failure').trim() || 'failure',
    failureName: String(failureName || 'failure').trim() || 'failure',
    phase: String(phase || '').trim() || null,
    scenarioId: String(scenarioId || '').trim() || null,
    cwd: process.cwd(),
    pid: process.pid,
    relevantEnv: selectRelevantEnv(),
    error: summarizeError(error),
    runtimeTraceSummary: cloneSerializable(runtimeTraceSummary, null),
    runtimeTraceFormatted: runtimeTraceFormatted || null,
    exportedTrace: cloneSerializable(exportedTrace, null),
    traceTail: cloneSerializable(traceTail, []),
    extra: cloneSerializable(extra, null)
  };
}

function writeBundleToDisk(artifactDir, baseName, bundle) {
  ensureDir(artifactDir);
  const filePath = path.join(artifactDir, `${baseName}.failure.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  return filePath;
}

async function writeFailureArtifactBundle(options = {}) {
  const artifactDir = path.resolve(process.cwd(), options.artifactDir || DEFAULT_FAILURE_ARTIFACT_DIR);
  const suiteName = String(options.suiteName || 'failure-suite').trim() || 'failure-suite';
  const failureName = String(options.failureName || options.phase || 'failure').trim() || 'failure';
  const baseName = `${buildTimestampTag()}-${sanitizeFileSegment(suiteName, 'suite')}-${sanitizeFileSegment(failureName, 'failure')}`;

  const aiService = options.aiService || null;
  const watcher = options.watcher || (aiService && typeof aiService.getUIWatcher === 'function' ? aiService.getUIWatcher() : null);
  const systemAutomation = options.systemAutomation || aiService?.systemAutomation || null;
  const runtimeTraceSummary = getRuntimeTraceSummary(aiService);
  const traceDestination = path.join(artifactDir, `${baseName}.trace.jsonl`);
  const exportedTrace = exportRuntimeTrace(aiService, traceDestination);
  const traceTailSource = exportedTrace?.filePath || runtimeTraceSummary?.filePath || null;
  const traceTail = readTraceTail(traceTailSource, options.traceTailCount);

  let tradingViewContext = null;
  if (typeof options.tradingViewContextFn === 'function') {
    try {
      tradingViewContext = cloneSerializable(await options.tradingViewContextFn(), null);
    } catch (error) {
      tradingViewContext = {
        error: String(error?.message || error || 'Failed to gather TradingView context')
      };
    }
  }

  const bundle = buildBaseBundle({
    suiteName,
    failureName,
    phase: options.phase,
    scenarioId: options.scenarioId,
    error: options.error,
    extra: options.extra,
    runtimeTraceSummary,
    runtimeTraceFormatted: formatRuntimeTraceSummary(aiService, runtimeTraceSummary),
    exportedTrace,
    traceTail
  });

  bundle.foreground = await getForegroundSnapshot(systemAutomation);
  bundle.watcherSnapshot = getWatcherSnapshot(watcher);
  bundle.tradingViewContext = tradingViewContext;

  const filePath = writeBundleToDisk(artifactDir, baseName, bundle);
  return {
    filePath,
    traceFilePath: exportedTrace?.filePath || null,
    bundle
  };
}

function writeFailureArtifactBundleSync(options = {}) {
  const artifactDir = path.resolve(process.cwd(), options.artifactDir || DEFAULT_FAILURE_ARTIFACT_DIR);
  const suiteName = String(options.suiteName || 'failure-suite').trim() || 'failure-suite';
  const failureName = String(options.failureName || options.phase || 'failure').trim() || 'failure';
  const baseName = `${buildTimestampTag()}-${sanitizeFileSegment(suiteName, 'suite')}-${sanitizeFileSegment(failureName, 'failure')}`;

  const aiService = options.aiService || null;
  const watcher = options.watcher || (aiService && typeof aiService.getUIWatcher === 'function' ? aiService.getUIWatcher() : null);
  const runtimeTraceSummary = getRuntimeTraceSummary(aiService);
  const traceDestination = path.join(artifactDir, `${baseName}.trace.jsonl`);
  const exportedTrace = exportRuntimeTrace(aiService, traceDestination);
  const traceTailSource = exportedTrace?.filePath || runtimeTraceSummary?.filePath || null;
  const traceTail = readTraceTail(traceTailSource, options.traceTailCount);

  const bundle = buildBaseBundle({
    suiteName,
    failureName,
    phase: options.phase,
    scenarioId: options.scenarioId,
    error: options.error,
    extra: options.extra,
    runtimeTraceSummary,
    runtimeTraceFormatted: formatRuntimeTraceSummary(aiService, runtimeTraceSummary),
    exportedTrace,
    traceTail
  });

  bundle.watcherSnapshot = getWatcherSnapshot(watcher);

  const filePath = writeBundleToDisk(artifactDir, baseName, bundle);
  return {
    filePath,
    traceFilePath: exportedTrace?.filePath || null,
    bundle
  };
}

module.exports = {
  DEFAULT_FAILURE_ARTIFACT_DIR,
  DEFAULT_TRACE_TAIL_COUNT,
  buildTimestampTag,
  sanitizeFileSegment,
  writeFailureArtifactBundle,
  writeFailureArtifactBundleSync
};
