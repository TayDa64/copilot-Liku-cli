#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const aiService = require(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'));
const { getUIWatcher } = require(path.join(__dirname, '..', 'src', 'main', 'ui-watcher.js'));
const { shutdownSharedUIAHost } = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
const windowManager = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation', 'window', 'manager.js'));
const { buildVerifyTargetHintFromAppName } = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'app-profile.js'));
const {
  buildTradingViewPineWorkflowActions,
  inferTradingViewPineIntent
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'pine-workflows.js'));
const {
  synthesizePineScriptTitleContract
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'pine-title-synthesis.js'));
const {
  buildTradingViewSymbolWorkflowActions,
  buildTradingViewTimeframeWorkflowActions
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'chart-verification.js'));
const {
  DEFAULT_TRADINGVIEW_CDP_PORT,
  detectTradingViewLaunchProfile,
  summarizeTradingViewLaunchProfile,
  scenarioRequiresTradingViewAutomationReadyLaunch
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'launch-profile.js'));
const {
  detectTradingViewLaunchCapability,
  summarizeTradingViewLaunchCapability
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'launch-capability.js'));
const {
  resolveTradingViewAutomationLaunchContract,
  summarizeTradingViewAutomationLaunchContract,
  buildTradingViewAutomationLaunchPreconditionMessage
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'launch-contract.js'));
const {
  DEFAULT_TRADINGVIEW_AUTOMATION_RELAUNCH_TIMEOUT_MS,
  DEFAULT_TRADINGVIEW_AUTOMATION_RELAUNCH_POLL_INTERVAL_MS,
  attemptTradingViewAutomationRelaunch,
  summarizeTradingViewAutomationRelaunch
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'launch-executor.js'));
const {
  writeFailureArtifactBundle,
  writeFailureArtifactBundleSync
} = require(path.join(__dirname, 'lib', 'failure-artifacts.js'));

const DEFAULT_ARTIFACT_DIR = path.join(__dirname, '..', 'artifacts', 'live-validation');
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_PINE_CREATE_SAVE_NAME = 'Liku Live Save Probe';
const DEFAULT_PINE_CREATE_SAVE_PROMPT = `TradingView is already open. Create a new Pine script called "${DEFAULT_PINE_CREATE_SAVE_NAME}", save the script, and report the visible save status. Do not add it to the chart.`;
const PROFILED_SYSTEM_AUTOMATION_METHODS = Object.freeze([
  'focusWindow',
  'getForegroundWindowInfo',
  'findElementByText',
  'pressKey',
  'typeText',
  'click',
  'doubleClick',
  'drag',
  'scroll',
  'getClipboardText',
  'setClipboardText',
  'getRunningProcessesByNames'
]);

function getArgValue(flagName) {
  const index = process.argv.indexOf(flagName);
  if (index >= 0 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return null;
}

function getEnvValue(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value : null;
}

function hasFlag(flagName) {
  if (process.argv.includes(flagName)) return true;
  const envName = `npm_config_${String(flagName || '').replace(/^--/, '').replace(/-/g, '_')}`;
  return /^(1|true|yes)$/i.test(String(process.env[envName] || ''));
}

function hasTruthyValue(value) {
  return /^(1|true|yes|y|on)$/i.test(String(value || '').trim());
}

function parseBoundedNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(Math.round(numeric), max));
}

function isTradingViewAutomationRelaunchRequested() {
  return hasFlag('--relaunch-tradingview-via-contract')
    || hasTruthyValue(process.env.LIKU_TRADINGVIEW_AUTOMATION_RELAUNCH);
}

function getTradingViewAutomationRelaunchTimeoutMs() {
  return parseBoundedNumber(
    getArgValue('--relaunch-timeout-ms') || getEnvValue('LIKU_TRADINGVIEW_AUTOMATION_RELAUNCH_TIMEOUT_MS'),
    DEFAULT_TRADINGVIEW_AUTOMATION_RELAUNCH_TIMEOUT_MS,
    2000,
    120000
  );
}

function getTradingViewAutomationRelaunchPollIntervalMs() {
  return parseBoundedNumber(
    getArgValue('--relaunch-poll-interval-ms') || getEnvValue('LIKU_TRADINGVIEW_AUTOMATION_RELAUNCH_POLL_INTERVAL_MS'),
    DEFAULT_TRADINGVIEW_AUTOMATION_RELAUNCH_POLL_INTERVAL_MS,
    150,
    5000
  );
}

function buildTradingViewLaunchProfileDetectOptions(launchContract = null, fallbackExpectedPort = DEFAULT_TRADINGVIEW_CDP_PORT) {
  const summarizedLaunchContract = summarizeTradingViewAutomationLaunchContract(launchContract);
  if (summarizedLaunchContract?.status === 'configured') {
    return {
      expectedCdpPort: Number(summarizedLaunchContract.expected?.cdpPort || fallbackExpectedPort) || fallbackExpectedPort,
      processNames: Array.isArray(summarizedLaunchContract.expected?.processNames)
        ? summarizedLaunchContract.expected.processNames.slice()
        : undefined
    };
  }
  return {
    expectedCdpPort: fallbackExpectedPort
  };
}

function buildTradingViewLaunchBlockedMessage(options = {}) {
  const baseMessage = buildTradingViewAutomationLaunchPreconditionMessage({
    scenarioId: options?.scenarioId,
    launchProfile: options?.launchProfile,
    launchCapability: options?.launchCapability,
    launchContract: options?.launchContract
  });
  const summarizedLaunchRelaunch = summarizeTradingViewAutomationRelaunch(options?.launchRelaunch || null);
  if (!summarizedLaunchRelaunch || summarizedLaunchRelaunch.success === true || !summarizedLaunchRelaunch.status) {
    return baseMessage;
  }

  const relaunchDetails = [
    `Relaunch status=${summarizedLaunchRelaunch.status}.`,
    summarizedLaunchRelaunch.message || null,
    summarizedLaunchRelaunch.error ? `Error: ${summarizedLaunchRelaunch.error}` : null
  ].filter(Boolean).join(' ');

  return relaunchDetails ? `${baseMessage} ${relaunchDetails}` : baseMessage;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flushStream(stream) {
  if (!stream || typeof stream.write !== 'function') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    try {
      stream.write('', () => resolve());
    } catch {
      resolve();
    }
  });
}

async function flushProcessOutput() {
  await flushStream(process.stdout);
  await flushStream(process.stderr);
}

function withTimeout(promise, timeoutMs, label = 'operation') {
  const boundedTimeoutMs = Math.max(1, Number(timeoutMs) || 1);
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${boundedTimeoutMs}ms`));
      }, boundedTimeoutMs);
      if (typeof timer?.unref === 'function') {
        timer.unref();
      }
    })
  ]);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function buildTimestampTag() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${String(now.getMilliseconds()).padStart(3, '0')}`;
}

function sanitizeFileSegment(value, fallback = 'scenario') {
  const sanitized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || fallback;
}

function normalizeSmokePreflightProcessEntry(entry = {}) {
  return {
    pid: Number(entry?.pid || 0) || 0,
    processName: String(entry?.processName || entry?.name || '').trim(),
    mainWindowTitle: String(entry?.mainWindowTitle || '').trim(),
    startTime: entry?.startTime || null,
    packagedExecutable: entry?.packagedExecutable === true,
    remoteDebuggingPorts: Array.isArray(entry?.remoteDebuggingPorts) ? entry.remoteDebuggingPorts.slice(0, 4) : [],
    rendererAccessibilityConfigured: entry?.rendererAccessibilityConfigured === true
  };
}

function summarizeAction(action = {}) {
  const type = String(action?.type || 'unknown').trim();
  const detail = [
    action?.key ? `key=${action.key}` : null,
    action?.text ? `text=${String(action.text).slice(0, 24)}` : null,
    action?.title ? `title=${action.title}` : null,
    action?.verify?.kind ? `verify=${action.verify.kind}` : null,
    action?.pineEvidenceMode ? `pine=${action.pineEvidenceMode}` : null
  ].filter(Boolean).join(', ');
  return detail ? `${type} (${detail})` : type;
}

function summarizePineActivationSnapshot(snapshot = null) {
  if (!snapshot || typeof snapshot !== 'object') return null;

  if (snapshot.captured !== true) {
    return {
      captured: false,
      reason: snapshot.reason || null,
      windowHandle: Number(snapshot.windowHandle || 0) || null,
      foreground: snapshot.foreground
        ? {
            hwnd: Number(snapshot.foreground.hwnd || 0) || null,
            processName: snapshot.foreground.processName || null,
            title: snapshot.foreground.title || null,
            windowKind: snapshot.foreground.windowKind || null
          }
        : null
    };
  }

  return {
    captured: true,
    windowHandle: Number(snapshot.windowHandle || 0) || null,
    foreground: snapshot.foreground
      ? {
          hwnd: Number(snapshot.foreground.hwnd || 0) || null,
          processName: snapshot.foreground.processName || null,
          title: snapshot.foreground.title || null,
          windowKind: snapshot.foreground.windowKind || null
        }
      : null,
    pineSurface: snapshot.pineSurface
      ? {
          active: snapshot.pineSurface.active === true,
          anchorText: snapshot.pineSurface.anchorText || null,
          matchedBy: snapshot.pineSurface.matchedBy || null
        }
      : null,
    focusedElement: snapshot.focusedElement
      ? (
        snapshot.focusedElement.Name
        || snapshot.focusedElement.AutomationId
        || snapshot.focusedElement.ClassName
        || snapshot.focusedElement.ControlType
        || null
      )
      : null,
    structureElementCount: Array.isArray(snapshot.structure?.elements) ? snapshot.structure.elements.length : 0,
    watcherElementCount: Number(snapshot.watcher?.elementCount || 0) || 0,
    watcherWaitTimedOut: snapshot.watcher?.waitedForFreshState?.timedOut === true
  };
}

function summarizePineActivationProof(proof = null) {
  if (!proof || typeof proof !== 'object') return null;

  return {
    applicable: proof.applicable === true,
    route: proof.route || null,
    expectedSurface: proof.expectedSurface || null,
    windowHandle: Number(proof.windowHandle || 0) || null,
    proofStrategy: proof.proofStrategy || null,
    actionSucceeded: proof.actionSucceeded === true,
    observedChange: proof.observedChange === true,
    pineSurfaceObserved: proof.pineSurfaceObserved === true,
    disposition: proof.disposition || null,
    likelyMeaning: proof.likelyMeaning || null,
    error: proof.error || null,
    durationMs: Number.isFinite(Number(proof.durationMs)) ? Number(proof.durationMs) : null,
    hostRevalidation: proof.hostRevalidation
      ? {
          attempted: proof.hostRevalidation.attempted === true,
          reason: proof.hostRevalidation.reason || null
        }
      : null,
    signals: Array.isArray(proof.signals)
      ? proof.signals.slice(0, 8).map((signal) => ({
          kind: signal?.kind || null,
          before: signal?.before || null,
          after: signal?.after || null,
          anchorText: signal?.anchorText || null,
          matchedBy: signal?.matchedBy || null,
          updateDelta: Number.isFinite(Number(signal?.updateDelta)) ? Number(signal.updateDelta) : null,
          beforeElementCount: Number.isFinite(Number(signal?.beforeElementCount)) ? Number(signal.beforeElementCount) : null,
          afterElementCount: Number.isFinite(Number(signal?.afterElementCount)) ? Number(signal.afterElementCount) : null,
          added: Array.isArray(signal?.added)
            ? signal.added.slice(0, 6).map((entry) => entry?.label || entry?.automationId || entry?.controlType || null).filter(Boolean)
            : [],
          removed: Array.isArray(signal?.removed)
            ? signal.removed.slice(0, 6).map((entry) => entry?.label || entry?.automationId || entry?.controlType || null).filter(Boolean)
            : []
        }))
      : [],
    before: summarizePineActivationSnapshot(proof.before),
    after: summarizePineActivationSnapshot(proof.after)
  };
}

function summarizePineAuthoringStrategyAttempt(attempt = null) {
  if (!attempt || typeof attempt !== 'object') return null;
  return {
    strategy: attempt.strategy || null,
    success: attempt.success === true,
    method: attempt.method || null,
    error: attempt.error || null,
    compactSummary: attempt.compactSummary || null
  };
}

function summarizePineAuthoringWrite(result = null) {
  if (!result || typeof result !== 'object') return null;
  return {
    applicable: result.applicable === true,
    success: result.success === true,
    method: result.method || null,
    reason: result.reason || null,
    error: result.error || null,
    compactSummary: result.compactSummary || null,
    proof: result.proof
      ? {
          exactMatch: result.proof.exactMatch === true,
          lifecycleState: result.proof.lifecycleState || null,
          mismatchReason: result.proof.mismatchReason || null,
          compactSummary: result.proof.compactSummary || null
        }
      : null,
    renderedProof: result.renderedProof
      ? {
          exactMatch: result.renderedProof.exactMatch === true,
          lifecycleState: result.renderedProof.lifecycleState || null,
          mismatchReason: result.renderedProof.mismatchReason || null,
          compactSummary: result.renderedProof.compactSummary || null
        }
      : null,
    strategyAttempts: Array.isArray(result.strategyAttempts)
      ? result.strategyAttempts.map(summarizePineAuthoringStrategyAttempt).filter(Boolean).slice(0, 4)
      : []
  };
}

function summarizeResult(result = {}) {
  return {
    success: result?.success === true,
    action: result?.action || null,
    message: result?.message || null,
    skipped: result?.skipped === true,
    skippedReason: result?.skippedReason || null,
    error: result?.error || null,
    blockedByFocusLock: result?.blockedByFocusLock === true,
    proof: result?.proof
      ? {
          level: result.proof.level ?? null,
          levelName: result.proof.levelName || null,
          status: result.proof.status || null
        }
      : null,
    text: typeof result?.text === 'string' ? result.text.slice(0, 4000) : null,
    pineStructuredSummary: result?.pineStructuredSummary || null,
    focusTarget: result?.focusTarget || null,
    focusVerification: result?.focusVerification || null,
    observationCheckpoint: result?.observationCheckpoint || null,
    quickSearchSemanticWrite: result?.quickSearchSemanticWrite
      ? {
          applicable: result.quickSearchSemanticWrite.applicable === true,
          success: result.quickSearchSemanticWrite.success === true,
          method: result.quickSearchSemanticWrite.method || null,
          error: result.quickSearchSemanticWrite.error || null,
          readback: result.quickSearchSemanticWrite.readback || null
        }
      : null,
    quickSearchPreflight: result?.quickSearchPreflight
      ? {
          applicable: result.quickSearchPreflight.applicable === true,
          ready: result.quickSearchPreflight.ready === true,
          timedOut: result.quickSearchPreflight.timedOut === true,
          emptyConfirmed: result.quickSearchPreflight.emptyConfirmed === true,
          queryAlreadyPresent: result.quickSearchPreflight.queryAlreadyPresent === true,
          fallbackAssumedFocused: result.quickSearchPreflight.fallbackAssumedFocused === true,
          fallbackReason: result.quickSearchPreflight.fallbackReason || null,
          clearedBy: result.quickSearchPreflight.clearedBy || null,
          expectedText: result.quickSearchPreflight.expectedText || null,
          inputFocus: result.quickSearchPreflight.inputFocus
            ? {
                recoveredBy: result.quickSearchPreflight.inputFocus.recoveredBy || null,
                controlType: result.quickSearchPreflight.inputFocus.controlType || null,
                matchedBy: result.quickSearchPreflight.inputFocus.matchedBy || null,
                trustReason: result.quickSearchPreflight.inputFocus.trustReason || null,
                candidateScore: Number.isFinite(Number(result.quickSearchPreflight.inputFocus.candidateScore))
                  ? Number(result.quickSearchPreflight.inputFocus.candidateScore)
                  : null
              }
            : null,
          initialRead: result.quickSearchPreflight.initialRead || null,
          finalRead: result.quickSearchPreflight.finalRead || null,
          error: result.quickSearchPreflight.error || null
        }
      : null,
    quickSearchTypedVerification: result?.quickSearchTypedVerification
      ? {
          applicable: result.quickSearchTypedVerification.applicable === true,
          verified: result.quickSearchTypedVerification.verified === true,
          expectedText: result.quickSearchTypedVerification.expectedText || null,
          actualText: result.quickSearchTypedVerification.actualText || null,
          satisfiedBy: result.quickSearchTypedVerification.satisfiedBy || null,
          error: result.quickSearchTypedVerification.error || null,
          readback: result.quickSearchTypedVerification.readback || null
        }
      : null,
    tradingViewPineActivationProof: summarizePineActivationProof(result?.tradingViewPineActivationProof),
    pineAuthoringCdpWrite: summarizePineAuthoringWrite(result?.pineAuthoringCdpWrite),
    pineAuthoringPasteProof: summarizePineAuthoringWrite(result?.pineAuthoringPasteProof),
    pineAuthoringWriteTelemetry: result?.pineAuthoringWriteTelemetry
      ? {
          selectedMethod: result.pineAuthoringWriteTelemetry.selectedMethod || null,
          primaryMethod: result.pineAuthoringWriteTelemetry.primaryMethod || null,
          primarySucceeded: result.pineAuthoringWriteTelemetry.primarySucceeded === true,
          primaryReason: result.pineAuthoringWriteTelemetry.primaryReason || null,
          primaryStrategy: result.pineAuthoringWriteTelemetry.primaryStrategy || null,
          primaryAttemptSummary: result.pineAuthoringWriteTelemetry.primaryAttemptSummary || null,
          fallbackUsed: result.pineAuthoringWriteTelemetry.fallbackUsed === true,
          fallbackMethod: result.pineAuthoringWriteTelemetry.fallbackMethod || null,
          fallbackRetryAttempted: result.pineAuthoringWriteTelemetry.fallbackRetryAttempted === true,
          proofVerified: result.pineAuthoringWriteTelemetry.proofVerified === true,
          compactSummary: result.pineAuthoringWriteTelemetry.compactSummary || null,
          primaryAttempts: Array.isArray(result.pineAuthoringWriteTelemetry.primaryAttempts)
            ? result.pineAuthoringWriteTelemetry.primaryAttempts.map(summarizePineAuthoringStrategyAttempt).filter(Boolean).slice(0, 4)
            : []
        }
      : null,
    quickSearchRecovery: result?.quickSearchRecovery || null,
    pineEditorRecovery: result?.pineEditorRecovery || null
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function summarizeRuntimeTraceTerminalEvent(entry = null) {
  if (!entry || typeof entry !== 'object') return null;
  const nestedSummary = entry.summary && typeof entry.summary === 'object'
    ? entry.summary
    : null;
  return {
    ts: entry.ts || entry.recordedAt || null,
    sessionId: entry.session || entry.sessionId || null,
    event: entry.event || null,
    mode: entry.mode || nestedSummary?.mode || null,
    success: entry.success === true || nestedSummary?.success === true,
    error: entry.error || nestedSummary?.error || null
  };
}

function readRuntimeTraceTerminalEvent(traceFilePath) {
  const normalizedPath = typeof traceFilePath === 'string' ? traceFilePath.trim() : '';
  if (!normalizedPath) return null;

  try {
    const content = fs.readFileSync(normalizedPath, 'utf8');
    const lines = content.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const rawLine = String(lines[index] || '').trim();
      if (!rawLine) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(rawLine);
      } catch {
        continue;
      }
      if (parsed?.event === 'runtime:session:end') {
        return summarizeRuntimeTraceTerminalEvent(parsed);
      }
    }
  } catch {
    return null;
  }

  return null;
}

function deriveScenarioOutcome(options = {}) {
  const scenarioError = options.scenarioError || null;
  const execResult = options.execResult && typeof options.execResult === 'object' ? options.execResult : null;
  const runtimeTraceSummary = options.runtimeTraceSummary && typeof options.runtimeTraceSummary === 'object'
    ? options.runtimeTraceSummary
    : null;
  const runtimeTraceTerminalEvent = options.runtimeTraceTerminalEvent && typeof options.runtimeTraceTerminalEvent === 'object'
    ? options.runtimeTraceTerminalEvent
    : null;

  const execSuccess = execResult?.success === true;
  const hasExecOutcome = typeof execResult?.success === 'boolean';
  const traceSummarySuccess = runtimeTraceSummary?.success === true;
  const hasTraceSummaryOutcome = typeof runtimeTraceSummary?.success === 'boolean';
  const terminalSuccess = runtimeTraceTerminalEvent?.success === true;
  const hasTerminalOutcome = typeof runtimeTraceTerminalEvent?.success === 'boolean';

  const consistency = {
    execResultSuccess: hasExecOutcome ? execSuccess : null,
    runtimeTraceSummarySuccess: hasTraceSummaryOutcome ? traceSummarySuccess : null,
    runtimeTraceTerminalSuccess: hasTerminalOutcome ? terminalSuccess : null,
    mismatch: false
  };

  if (hasExecOutcome && hasTraceSummaryOutcome && execSuccess !== traceSummarySuccess) {
    consistency.mismatch = true;
  }
  if (hasTerminalOutcome && hasExecOutcome && terminalSuccess !== execSuccess) {
    consistency.mismatch = true;
  }
  if (hasTerminalOutcome && hasTraceSummaryOutcome && terminalSuccess !== traceSummarySuccess) {
    consistency.mismatch = true;
  }

  if (scenarioError) {
    return {
      success: false,
      error: String(scenarioError?.message || scenarioError || 'Scenario execution failed'),
      source: 'scenario-error',
      consistency
    };
  }

  if (hasTerminalOutcome) {
    return {
      success: terminalSuccess,
      error: terminalSuccess ? null : (runtimeTraceTerminalEvent?.error || runtimeTraceSummary?.error || execResult?.error || 'One or more actions failed'),
      source: 'runtime-trace-terminal',
      consistency
    };
  }

  if (hasTraceSummaryOutcome) {
    return {
      success: traceSummarySuccess,
      error: traceSummarySuccess ? null : (runtimeTraceSummary?.error || execResult?.error || 'One or more actions failed'),
      source: 'runtime-trace-summary',
      consistency
    };
  }

  return {
    success: execSuccess,
    error: execSuccess ? null : (execResult?.error || 'One or more actions failed'),
    source: hasExecOutcome ? 'execute-actions' : 'unknown',
    consistency
  };
}

function shouldUseLightweightFailureArtifact(options = {}) {
  const scenarioError = options.scenarioError || null;
  const execResult = options.execResult && typeof options.execResult === 'object'
    ? options.execResult
    : null;
  const launchProfile = options.launchProfile && typeof options.launchProfile === 'object'
    ? options.launchProfile
    : null;
  const actionTimeline = Array.isArray(options.actionTimeline) ? options.actionTimeline : [];
  const errorMessage = String(scenarioError?.message || scenarioError || '').trim();

  if (!scenarioError || execResult || actionTimeline.length > 0) {
    return false;
  }
  if (launchProfile?.inspectionAvailable !== true || launchProfile?.automationReady === true) {
    return false;
  }

  return /requires an automation-ready tradingview launch profile/i.test(errorMessage);
}

function createSystemAutomationProfiler(systemAutomation, expectedWindow = null) {
  const originals = new Map();
  const methodStats = new Map();
  const callLog = [];
  const foregroundSamples = [];
  const expectedWindowHandle = Number(expectedWindow?.hwnd || 0) || 0;
  const expectedProcessName = normalizeText(expectedWindow?.processName || '');

  function getMethodStat(methodName) {
    if (!methodStats.has(methodName)) {
      methodStats.set(methodName, {
        methodName,
        callCount: 0,
        successCount: 0,
        errorCount: 0,
        totalMs: 0,
        maxMs: 0
      });
    }
    return methodStats.get(methodName);
  }

  function appendForegroundSample(methodName, startedAtMs, result = null) {
    if (!result || typeof result !== 'object') {
      return;
    }

    const hwnd = Number(result?.hwnd || 0) || 0;
    const sample = {
      methodName,
      recordedAt: new Date(startedAtMs).toISOString(),
      hwnd,
      title: result?.title || null,
      processName: result?.processName || null,
      windowKind: result?.windowKind || null,
      expectedWindowHandle: expectedWindowHandle || null,
      expectedProcessName: expectedProcessName || null,
      offExpectedWindow: expectedWindowHandle > 0 ? hwnd !== expectedWindowHandle : null,
      offExpectedProcess: expectedProcessName ? normalizeText(result?.processName || '') !== expectedProcessName : null
    };

    const previous = foregroundSamples[foregroundSamples.length - 1] || null;
    if (
      previous
      && previous.hwnd === sample.hwnd
      && previous.title === sample.title
      && previous.processName === sample.processName
      && previous.windowKind === sample.windowKind
    ) {
      return;
    }

    foregroundSamples.push(sample);
  }

  return {
    async run(fn) {
      const targets = PROFILED_SYSTEM_AUTOMATION_METHODS.filter((methodName) => typeof systemAutomation?.[methodName] === 'function');

      for (const methodName of targets) {
        const original = systemAutomation[methodName];
        originals.set(methodName, original);
        systemAutomation[methodName] = async (...args) => {
          const startedAtMs = Date.now();
          const stat = getMethodStat(methodName);
          stat.callCount += 1;
          try {
            const result = await original.apply(systemAutomation, args);
            const durationMs = Math.max(0, Date.now() - startedAtMs);
            stat.successCount += 1;
            stat.totalMs += durationMs;
            stat.maxMs = Math.max(stat.maxMs, durationMs);
            callLog.push({ methodName, durationMs, success: true, recordedAt: new Date(startedAtMs).toISOString() });
            if (methodName === 'getForegroundWindowInfo') {
              appendForegroundSample(methodName, startedAtMs, result);
            }
            return result;
          } catch (error) {
            const durationMs = Math.max(0, Date.now() - startedAtMs);
            stat.errorCount += 1;
            stat.totalMs += durationMs;
            stat.maxMs = Math.max(stat.maxMs, durationMs);
            callLog.push({
              methodName,
              durationMs,
              success: false,
              recordedAt: new Date(startedAtMs).toISOString(),
              error: String(error?.message || error || 'automation call failed')
            });
            throw error;
          }
        };
      }

      try {
        return await fn();
      } finally {
        for (const [methodName, original] of originals.entries()) {
          systemAutomation[methodName] = original;
        }
      }
    },
    summarize() {
      const methods = Array.from(methodStats.values())
        .map((entry) => ({
          ...entry,
          avgMs: entry.callCount > 0 ? Number((entry.totalMs / entry.callCount).toFixed(2)) : 0
        }))
        .sort((left, right) => {
          if (right.totalMs !== left.totalMs) return right.totalMs - left.totalMs;
          return right.maxMs - left.maxMs;
        });

      const distinctForegrounds = Array.from(new Map(
        foregroundSamples.map((sample) => [
          `${sample.hwnd}:${sample.processName || ''}:${sample.title || ''}`,
          {
            hwnd: sample.hwnd,
            processName: sample.processName,
            title: sample.title,
            windowKind: sample.windowKind
          }
        ])
      ).values());

      let offAppTransitions = 0;
      for (let index = 1; index < foregroundSamples.length; index += 1) {
        const previous = foregroundSamples[index - 1];
        const current = foregroundSamples[index];
        if (previous?.offExpectedProcess !== true && current?.offExpectedProcess === true) {
          offAppTransitions += 1;
        }
      }

      return {
        totalCallCount: methods.reduce((sum, entry) => sum + entry.callCount, 0),
        totalDurationMs: methods.reduce((sum, entry) => sum + entry.totalMs, 0),
        methods,
        topSlowCalls: callLog
          .slice()
          .sort((left, right) => right.durationMs - left.durationMs)
          .slice(0, 10),
        foregroundTelemetry: {
          sampleCount: foregroundSamples.length,
          distinctForegroundCount: distinctForegrounds.length,
          distinctForegrounds: distinctForegrounds.slice(0, 12),
          offAppSampleCount: foregroundSamples.filter((sample) => sample.offExpectedProcess === true).length,
          offHandleSampleCount: foregroundSamples.filter((sample) => sample.offExpectedWindow === true).length,
          offAppTransitions,
          recentSamples: foregroundSamples.slice(-12)
        }
      };
    }
  };
}

function incrementCounter(target, key) {
  if (!key) return;
  target[key] = (target[key] || 0) + 1;
}

function buildScenarioMetrics(results = [], actionTimeline = [], automationProfile = null) {
  const recoveryPathCounts = {};
  let quickSearchPreflightCount = 0;
  let quickSearchPreflightTimeoutCount = 0;
  let quickSearchFallbackAssumedCount = 0;
  let quickSearchTypedVerificationCount = 0;
  let quickSearchTypedVerificationFailureCount = 0;

  for (const result of Array.isArray(results) ? results : []) {
    const preflight = result?.quickSearchPreflight || null;
    const typedVerification = result?.quickSearchTypedVerification || null;
    const quickSearchRecovery = result?.quickSearchRecovery || null;
    const pineEditorRecovery = result?.pineEditorRecovery || null;

    if (preflight?.applicable) {
      quickSearchPreflightCount += 1;
      if (preflight.timedOut === true) {
        quickSearchPreflightTimeoutCount += 1;
      }
      if (preflight.fallbackAssumedFocused === true) {
        quickSearchFallbackAssumedCount += 1;
      }
      incrementCounter(recoveryPathCounts, preflight.clearedBy || preflight.fallbackReason || null);
    }

    if (typedVerification?.applicable) {
      quickSearchTypedVerificationCount += 1;
      if (typedVerification.verified !== true) {
        quickSearchTypedVerificationFailureCount += 1;
      }
      incrementCounter(recoveryPathCounts, typedVerification.satisfiedBy || null);
    }

    incrementCounter(recoveryPathCounts, quickSearchRecovery?.recoveredBy || null);
    incrementCounter(recoveryPathCounts, pineEditorRecovery?.recoveredBy || null);
  }

  const clipboardTouchCount = (automationProfile?.methods || [])
    .filter((entry) => entry?.methodName === 'getClipboardText' || entry?.methodName === 'setClipboardText')
    .reduce((sum, entry) => sum + (Number(entry?.callCount || 0) || 0), 0);

  const topActionGaps = (Array.isArray(actionTimeline) ? actionTimeline : [])
    .filter((entry) => Number.isFinite(Number(entry?.sincePreviousMs)) && Number(entry.sincePreviousMs) > 0)
    .slice()
    .sort((left, right) => Number(right.sincePreviousMs) - Number(left.sincePreviousMs))
    .slice(0, 5);

  return {
    clipboardTouchCount,
    quickSearchPreflightCount,
    quickSearchPreflightTimeoutCount,
    quickSearchFallbackAssumedCount,
    quickSearchTypedVerificationCount,
    quickSearchTypedVerificationFailureCount,
    recoveryPathCounts,
    actionTimeline,
    topActionGaps,
    systemAutomationProfile: automationProfile,
    foregroundTelemetry: automationProfile?.foregroundTelemetry || null
  };
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeProcessIds(values = []) {
  const input = Array.isArray(values) ? values : [values];
  const seen = new Set();
  const result = [];
  for (const value of input) {
    const pid = Number(value);
    if (!Number.isFinite(pid)) continue;
    const normalized = Math.round(pid);
    if (normalized <= 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function isBrowserHostedWindowProcess(processName = '') {
  return /^(msedge|chrome|brave|firefox|opera|vivaldi|arc|iexplore|safari)$/i.test(String(processName || '').trim());
}

function titleLooksLikeTradingViewReferencePage(title = '') {
  return /\b(keyboard shortcuts?|shortcut(?: keys?)?|hotkey list|help center|support|docs?|documentation|learn|tutorial|blog|wiki|pricing|about|careers?|jobs?|download)\b/i.test(String(title || ''));
}

function titleLooksLikeTradingViewActiveSurface(title = '') {
  return /\b(supercharts?|chart(?:s|ing)?|watchlist|paper trading|depth of market|pine editor|object tree|trading panel|strategy tester|stock screener|heatmap|alerts?|screener|ideas)\b/i.test(String(title || ''));
}

function windowMatchesPreferredProcess(windowInfo = {}, preferredProcessIds = []) {
  const preferredProcessIdSet = preferredProcessIds instanceof Set
    ? preferredProcessIds
    : new Set(normalizeProcessIds(preferredProcessIds));
  const pid = Number(windowInfo?.pid || windowInfo?.processId || 0) || 0;
  return pid > 0 && preferredProcessIdSet.has(pid);
}

function classifyTradingViewWindow(windowInfo = {}, foreground = null, options = {}) {
  const title = normalizeText(windowInfo?.title);
  const processName = normalizeText(windowInfo?.processName);
  const windowKind = normalizeText(windowInfo?.windowKind);
  const foregroundHwnd = Number(foreground?.hwnd || foreground || 0) || 0;
  const foregroundPid = Number(foreground?.pid || foreground?.processId || 0) || 0;
  const windowPid = Number(windowInfo?.pid || windowInfo?.processId || 0) || 0;
  const isForeground = Number(windowInfo?.hwnd || 0) === foregroundHwnd;
  const isDedicatedTradingViewProcess = processName === 'tradingview';
  const isBrowserHosted = isBrowserHostedWindowProcess(processName);
  const isPreferredProcess = windowMatchesPreferredProcess(windowInfo, options?.preferredProcessIds || []);
  const looksLikeReferencePage = isBrowserHosted
    && titleLooksLikeTradingViewReferencePage(title)
    && !titleLooksLikeTradingViewActiveSurface(title);
  const looksLikeActiveSurface = isDedicatedTradingViewProcess
    || titleLooksLikeTradingViewActiveSurface(title);

  let score = 0;
  if (isPreferredProcess) score += 320;
  if (isDedicatedTradingViewProcess) score += 180;
  if (looksLikeActiveSurface) score += isDedicatedTradingViewProcess ? 40 : 70;
  if (/tradingview|trading\s+view/.test(title)) score += 18;
  if (/tradingview/.test(processName)) score += 12;
  if (!windowInfo?.isMinimized) score += 20;
  if (windowKind === 'main') score += 15;
  if (windowKind === 'owned' || windowKind === 'palette') score += 6;
  if (isForeground) score += isDedicatedTradingViewProcess ? 30 : (looksLikeActiveSurface ? 12 : 4);
  if (foregroundPid > 0 && windowPid === foregroundPid && isPreferredProcess) score += 25;
  if (looksLikeReferencePage) score -= 220;

  return {
    score,
    isForeground,
    isPreferredProcess,
    isDedicatedTradingViewProcess,
    isBrowserHosted,
    looksLikeReferencePage,
    looksLikeActiveSurface
  };
}

function windowLooksLikeTradingView(windowInfo = {}) {
  const title = normalizeText(windowInfo?.title);
  const processName = normalizeText(windowInfo?.processName);
  const className = normalizeText(windowInfo?.className);
  const haystack = [
    windowInfo?.title,
    windowInfo?.processName,
    windowInfo?.className
  ].map((value) => normalizeText(value)).filter(Boolean).join(' ');

  if (processName === 'tradingview') return true;
  if (processName && /winword|acrord32|acrobat|excel|powerpnt|code|code - insiders/.test(processName)) {
    return false;
  }
  if (/\.pdf\b|\bword\b|\blast saved by\b/.test(title) && processName !== 'tradingview') {
    return false;
  }
  if (isBrowserHostedWindowProcess(processName)
    && titleLooksLikeTradingViewReferencePage(title)
    && !titleLooksLikeTradingViewActiveSurface(title)) {
    return false;
  }
  return /tradingview|trading\s+view|pine editor|paper trading|depth of market|object tree|trading panel/.test(haystack);
}

function dedupeWindows(windows = []) {
  const seen = new Set();
  const unique = [];
  for (const win of windows) {
    const hwnd = Number(win?.hwnd || 0) || 0;
    if (!hwnd || seen.has(hwnd)) continue;
    seen.add(hwnd);
    unique.push(win);
  }
  return unique;
}

function pickPreferredTradingViewWindow(windows = [], foreground = null, options = {}) {
  const preferredProcessIds = normalizeProcessIds(options?.preferredProcessIds || []);

  const scored = windows
    .map((win) => {
      const title = normalizeText(win?.title);
      const classification = classifyTradingViewWindow(win, foreground, {
        preferredProcessIds
      });
      let score = classification.score;
      if (/pine editor|paper trading|depth of market|trading panel|object tree/.test(title)) score += 6;
      return {
        win,
        score,
        classification
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.classification.isPreferredProcess !== b.classification.isPreferredProcess) {
        return a.classification.isPreferredProcess ? -1 : 1;
      }
      if (a.classification.isDedicatedTradingViewProcess !== b.classification.isDedicatedTradingViewProcess) {
        return a.classification.isDedicatedTradingViewProcess ? -1 : 1;
      }
      if (a.classification.looksLikeReferencePage !== b.classification.looksLikeReferencePage) {
        return a.classification.looksLikeReferencePage ? 1 : -1;
      }
      if (a.classification.isForeground !== b.classification.isForeground) {
        return a.classification.isForeground ? -1 : 1;
      }
      return 0;
    });

  return scored[0]?.win || null;
}

async function findTradingViewContext() {
  return findTradingViewContextWithOptions();
}

async function collectTradingViewCandidateWindows(options = {}) {
  const preferredProcessIds = normalizeProcessIds(options?.preferredProcessIds || []);
  const knownProcessNames = Array.isArray(options?.knownProcessNames) ? options.knownProcessNames : [];
  const titleSearches = Array.isArray(options?.titleSearches) ? options.titleSearches : [];
  const windowsByHint = [];

  for (const pid of preferredProcessIds) {
    try {
      const found = await windowManager.findWindows({ pid, includeUntitled: true });
      windowsByHint.push(...(Array.isArray(found) ? found : []));
    } catch {}
  }

  for (const processName of knownProcessNames) {
    try {
      const found = await windowManager.findWindows({ processName, includeUntitled: true });
      windowsByHint.push(...(Array.isArray(found) ? found : []));
    } catch {}
  }

  for (const title of titleSearches) {
    try {
      const found = await windowManager.findWindows({ title });
      windowsByHint.push(...(Array.isArray(found) ? found : []));
    } catch {}
  }

  return windowsByHint;
}

async function findTradingViewContextWithOptions(options = {}) {
  const includeProcesses = options?.includeProcesses !== false;
  const fastWindowDiscovery = options?.fastWindowDiscovery === true;
  const preferredProcessIds = normalizeProcessIds(options?.preferredProcessIds || options?.pinnedProcessIds || []);
  const preferredProcessWaitMs = preferredProcessIds.length > 0
    ? Math.max(0, Math.min(Number(options?.preferredProcessWaitMs || 2500) || 2500, 10000))
    : 0;
  const verifyTarget = buildVerifyTargetHintFromAppName('TradingView');
  const foreground = await aiService.systemAutomation.getForegroundWindowInfo();
  const knownProcessNames = Array.from(new Set([
    ...(Array.isArray(verifyTarget?.processNames) ? verifyTarget.processNames : []),
    'tradingview'
  ].map((value) => String(value || '').trim()).filter(Boolean)));

  const titleSearches = fastWindowDiscovery
    ? []
    : Array.from(new Set([
        'TradingView',
        ...(Array.isArray(verifyTarget?.titleHints) ? verifyTarget.titleHints : []),
        ...(Array.isArray(verifyTarget?.dialogTitleHints) ? verifyTarget.dialogTitleHints : [])
      ].map((value) => String(value || '').trim()).filter(Boolean)));

  const preferredProcessIdSet = new Set(preferredProcessIds);
  const preferredWindowDeadline = Date.now() + preferredProcessWaitMs;
  let windows = [];

  while (true) {
    const windowsByHint = await collectTradingViewCandidateWindows({
      preferredProcessIds,
      knownProcessNames,
      titleSearches
    });
    const candidateWindows = foreground && windowLooksLikeTradingView(foreground)
      ? [foreground, ...windowsByHint]
      : windowsByHint;
    windows = dedupeWindows(candidateWindows).filter(windowLooksLikeTradingView);

    if (
      preferredProcessIdSet.size === 0
      || windows.some((win) => windowMatchesPreferredProcess(win, preferredProcessIdSet))
      || Date.now() >= preferredWindowDeadline
    ) {
      break;
    }

    await sleep(Math.min(250, Math.max(0, preferredWindowDeadline - Date.now())));
  }

  const selectedWindow = pickPreferredTradingViewWindow(windows, foreground, {
    preferredProcessIds
  });

  const processNames = Array.from(new Set(windows
    .map((win) => String(win?.processName || '').trim().toLowerCase())
    .filter(Boolean)));

  let processes = [];
  if (includeProcesses && processNames.length > 0) {
    processes = await aiService.systemAutomation.getRunningProcessesByNames(processNames);
  }

  return {
    foreground,
    windows,
    selectedWindow,
    processes,
    processNames
  };
}

function bindScenarioToDetectedWindow(scenario, detectedWindow = null) {
  if (!scenario || !detectedWindow) return scenario;

  const bound = cloneJson(scenario);
  const targetTitle = String(detectedWindow.title || 'TradingView').trim() || 'TradingView';
  const targetProcessName = String(detectedWindow.processName || '').trim();
  const targetWindowHandle = Number(detectedWindow.hwnd || 0) || 0;

  if (!bound?.actionData?.actions || !Array.isArray(bound.actionData.actions)) {
    return bound;
  }

  bound.actionData.actions = bound.actionData.actions.map((action) => {
    if (!action || typeof action !== 'object') return action;
    const type = String(action.type || '').trim().toLowerCase();
    if (action.tradingViewChartFocusClick === true) {
      const bounds = detectedWindow.bounds && typeof detectedWindow.bounds === 'object'
        ? detectedWindow.bounds
        : null;
      const x = Number(bounds?.x || 0);
      const y = Number(bounds?.y || 0);
      const width = Number(bounds?.width || 0);
      const height = Number(bounds?.height || 0);
      if (Number.isFinite(x) && Number.isFinite(y) && width > 0 && height > 0) {
        return {
          ...action,
          x: Math.round(x + width * 0.5),
          y: Math.round(y + height * 0.45),
          windowHandle: targetWindowHandle || action.windowHandle || action.hwnd || undefined,
          hwnd: targetWindowHandle || action.hwnd || action.windowHandle || undefined
        };
      }
    }
    if (type !== 'bring_window_to_front' && type !== 'focus_window') {
      return action;
    }

    return {
      ...action,
      title: targetTitle,
      processName: targetProcessName || action.processName || undefined,
      windowHandle: targetWindowHandle || action.windowHandle || action.hwnd || undefined,
      hwnd: targetWindowHandle || action.hwnd || action.windowHandle || undefined
    };
  });

  return bound;
}

function buildFocusScenario() {
  const verifyTarget = buildVerifyTargetHintFromAppName('TradingView');
  return {
    id: 'focus',
    description: 'Bring the already-open TradingView session to the foreground and prove focus lock.',
    userMessage: 'Focus the existing TradingView window and confirm it is foregrounded.',
    actionData: {
      thought: 'Focus the existing TradingView session',
      verification: 'TradingView should be the active foreground window',
      actions: [
        {
          type: 'bring_window_to_front',
          title: 'TradingView',
          processName: 'tradingview',
          reason: 'Focus the existing TradingView session before live smoke validation',
          verifyTarget
        }
      ]
    }
  };
}

function buildPineScenario() {
  return {
    id: 'pine-editor',
    description: 'Open Pine Editor through the grounded official Pine shortcut route and read visible bounded status text.',
    userMessage: 'Open TradingView Pine Editor through the verified official Pine shortcut route and inspect the visible Pine Editor state.',
    actionData: {
      thought: 'Open TradingView Pine Editor with watcher-backed verification and bounded readback',
      verification: 'TradingView should show an active Pine Editor surface and visible status/output',
      actions: buildTradingViewPineWorkflowActions({
        syntheticOpener: true,
        surfaceTarget: 'pine-editor',
        appName: 'TradingView',
        reason: 'Open TradingView Pine Editor through the official Pine shortcut route',
        verifyKind: 'editor-active',
        requiresEditorActivation: true,
        requiresObservedChange: true,
        safeAuthoringDefault: true,
        wantsEvidenceReadback: true,
        pineEvidenceMode: 'safe-authoring-inspect'
      }, [])
    }
  };
}

function buildClipboardSetCommand(value = '') {
  const normalized = String(value || '').replace(/\r/g, '');
  return `$ErrorActionPreference='Stop'; Set-Clipboard -Value @'\n${normalized}\n'@`;
}

function buildVwapTpoAtrConfidenceSource(scriptName = DEFAULT_PINE_CREATE_SAVE_NAME) {
  const safeName = String(scriptName || DEFAULT_PINE_CREATE_SAVE_NAME).trim() || DEFAULT_PINE_CREATE_SAVE_NAME;
  return [
    '//@version=6',
    `indicator(${JSON.stringify(safeName)}, overlay=true, max_labels_count=50)`,
    '',
    'src = input.source(hlc3, "VWAP Source")',
    'atrLen = input.int(14, "ATR Length", minval=1)',
    'tpoLen = input.int(48, "TPO Lookback", minval=10)',
    'atrMultiplier = input.float(1.5, "ATR Confirmation Multiplier", minval=0.1, step=0.1)',
    'showZones = input.bool(true, "Show TPO Value Zones")',
    'showSignals = input.bool(true, "Show Confidence Signals")',
    '',
    'sessionVwap = ta.vwap(src)',
    'atr = ta.atr(atrLen)',
    'atrMean = ta.sma(atr, atrLen)',
    'atrExpanded = atr > atrMean',
    'upperAtrBand = sessionVwap + atr * atrMultiplier',
    'lowerAtrBand = sessionVwap - atr * atrMultiplier',
    '',
    'profileHigh = ta.highest(high, tpoLen)',
    'profileLow = ta.lowest(low, tpoLen)',
    'profileMid = (profileHigh + profileLow) / 2.0',
    'profileRange = math.max(profileHigh - profileLow, syminfo.mintick)',
    'valueAreaHigh = profileMid + profileRange * 0.2',
    'valueAreaLow = profileMid - profileRange * 0.2',
    '',
    'vwapSlopeUp = sessionVwap > sessionVwap[1]',
    'vwapSlopeDown = sessionVwap < sessionVwap[1]',
    'aboveVwap = close > sessionVwap',
    'belowVwap = close < sessionVwap',
    'aboveValue = close > valueAreaHigh',
    'belowValue = close < valueAreaLow',
    'insideValue = close <= valueAreaHigh and close >= valueAreaLow',
    '',
    'bullScore = (aboveVwap ? 1 : 0) + (vwapSlopeUp ? 1 : 0) + (aboveValue ? 1 : 0) + (atrExpanded ? 1 : 0)',
    'bearScore = (belowVwap ? 1 : 0) + (vwapSlopeDown ? 1 : 0) + (belowValue ? 1 : 0) + (atrExpanded ? 1 : 0)',
    'bias = bullScore > bearScore ? "Bullish" : bearScore > bullScore ? "Bearish" : "Balanced"',
    'confidence = math.max(bullScore, bearScore)',
    '',
    'vwapPlot = plot(sessionVwap, "Session VWAP", color=color.new(color.blue, 0), linewidth=2)',
    'upperPlot = plot(upperAtrBand, "VWAP + ATR Confirmation", color=color.new(color.green, 25))',
    'lowerPlot = plot(lowerAtrBand, "VWAP - ATR Confirmation", color=color.new(color.red, 25))',
    'vahPlot = plot(showZones ? valueAreaHigh : na, "TPO Value Area High", color=color.new(color.orange, 0), style=plot.style_linebr)',
    'valPlot = plot(showZones ? valueAreaLow : na, "TPO Value Area Low", color=color.new(color.orange, 0), style=plot.style_linebr)',
    'midPlot = plot(showZones ? profileMid : na, "TPO Point of Control Proxy", color=color.new(color.yellow, 0), style=plot.style_linebr)',
    'fill(vahPlot, valPlot, color=color.new(color.orange, 88), title="TPO Value Area")',
    '',
    'longConfirm = showSignals and bullScore >= 3 and close > upperAtrBand',
    'shortConfirm = showSignals and bearScore >= 3 and close < lowerAtrBand',
    'plotshape(longConfirm, title="Bullish Confirmation", style=shape.triangleup, location=location.belowbar, color=color.new(color.green, 0), size=size.small, text="CONF")',
    'plotshape(shortConfirm, title="Bearish Confirmation", style=shape.triangledown, location=location.abovebar, color=color.new(color.red, 0), size=size.small, text="CONF")',
    'bgcolor(insideValue ? color.new(color.gray, 92) : na, title="Inside TPO Value Area")',
    '',
    'var table dashboard = table.new(position.top_right, 2, 5, border_width=1)',
    'if barstate.islast',
    '    table.cell(dashboard, 0, 0, "Bias", bgcolor=color.new(color.black, 0), text_color=color.white)',
    '    table.cell(dashboard, 1, 0, bias, text_color=bullScore > bearScore ? color.lime : bearScore > bullScore ? color.red : color.yellow)',
    '    table.cell(dashboard, 0, 1, "Confidence", text_color=color.white)',
    '    table.cell(dashboard, 1, 1, str.tostring(confidence) + "/4", text_color=confidence >= 3 ? color.lime : color.yellow)',
    '    table.cell(dashboard, 0, 2, "VWAP", text_color=color.white)',
    '    table.cell(dashboard, 1, 2, aboveVwap ? "Above" : "Below", text_color=aboveVwap ? color.lime : color.red)',
    '    table.cell(dashboard, 0, 3, "TPO Zone", text_color=color.white)',
    '    table.cell(dashboard, 1, 3, aboveValue ? "Above VAH" : belowValue ? "Below VAL" : "Inside Value", text_color=insideValue ? color.yellow : color.white)',
    '    table.cell(dashboard, 0, 4, "ATR", text_color=color.white)',
    '    table.cell(dashboard, 1, 4, atrExpanded ? "Expanded" : "Normal", text_color=atrExpanded ? color.lime : color.silver)',
    '',
    'alertcondition(longConfirm, "Bullish VWAP/TPO/ATR Confirmation", "Bullish confirmation: price is above VWAP, above value, and ATR confirms expansion.")',
    'alertcondition(shortConfirm, "Bearish VWAP/TPO/ATR Confirmation", "Bearish confirmation: price is below VWAP, below value, and ATR confirms expansion.")'
  ].join('\n');
}

function buildAtrVwapMacdRsiConfidenceSource(scriptName = DEFAULT_PINE_CREATE_SAVE_NAME) {
  const safeName = String(scriptName || DEFAULT_PINE_CREATE_SAVE_NAME).trim() || DEFAULT_PINE_CREATE_SAVE_NAME;
  return [
    '//@version=6',
    `indicator(${JSON.stringify(safeName)}, overlay=false, max_labels_count=100)`,
    '',
    'atrLen = input.int(14, "ATR Length", minval=1)',
    'rsiLen = input.int(14, "RSI Length", minval=1)',
    'macdFast = input.int(12, "MACD Fast", minval=1)',
    'macdSlow = input.int(26, "MACD Slow", minval=1)',
    'macdSignal = input.int(9, "MACD Signal", minval=1)',
    'showSignals = input.bool(true, "Show Confidence Signals")',
    '',
    'sessionVwap = ta.vwap(hlc3)',
    'atr = ta.atr(atrLen)',
    'rsiValue = ta.rsi(close, rsiLen)',
    '[macdLine, signalLine, histLine] = ta.macd(close, macdFast, macdSlow, macdSignal)',
    '',
    'aboveVwap = close > sessionVwap',
    'atrExpanding = atr > ta.sma(atr, atrLen)',
    'rsiBullish = rsiValue >= 55',
    'rsiBearish = rsiValue <= 45',
    'macdBullish = macdLine > signalLine and histLine >= 0',
    'macdBearish = macdLine < signalLine and histLine <= 0',
    '',
    'bullScore = (aboveVwap ? 1 : 0) + (atrExpanding ? 1 : 0) + (rsiBullish ? 1 : 0) + (macdBullish ? 1 : 0)',
    'bearScore = (aboveVwap ? 0 : 1) + (atrExpanding ? 1 : 0) + (rsiBearish ? 1 : 0) + (macdBearish ? 1 : 0)',
    'confidenceScore = math.max(bullScore, bearScore)',
    'confidencePct = confidenceScore / 4.0 * 100.0',
    'bias = bullScore > bearScore ? "Bullish" : bearScore > bullScore ? "Bearish" : "Balanced"',
    '',
    'plot(sessionVwap, "VWAP", color=color.new(color.blue, 0), linewidth=2)',
    'upperAtr = plot(sessionVwap + atr, "VWAP + ATR", color=color.new(color.green, 55))',
    'lowerAtr = plot(sessionVwap - atr, "VWAP - ATR", color=color.new(color.red, 55))',
    'fill(upperAtr, lowerAtr, color=color.new(color.blue, 92), title="ATR Envelope")',
    '',
    'plot(confidencePct, "Confidence %", color=bias == "Bullish" ? color.lime : bias == "Bearish" ? color.red : color.yellow, linewidth=2, display=display.pane)',
    'hline(75, "High Confidence", color=color.new(color.green, 60), linestyle=hline.style_dashed)',
    'hline(50, "Neutral Confidence", color=color.new(color.gray, 70), linestyle=hline.style_dotted)',
    '',
    'plotshape(showSignals and bullScore >= 3, title="Bullish Confidence", style=shape.labelup, location=location.belowbar, color=color.new(color.green, 0), text="CONF+")',
    'plotshape(showSignals and bearScore >= 3, title="Bearish Confidence", style=shape.labeldown, location=location.abovebar, color=color.new(color.red, 0), text="CONF-")',
    '',
    'var table dashboard = table.new(position.top_right, 2, 5, border_width=1)',
    'if barstate.islast',
    '    table.cell(dashboard, 0, 0, "Bias", text_color=color.white, bgcolor=color.new(color.black, 0))',
    '    table.cell(dashboard, 1, 0, bias, text_color=bias == "Bullish" ? color.lime : bias == "Bearish" ? color.red : color.yellow)',
    '    table.cell(dashboard, 0, 1, "Confidence", text_color=color.white)',
    '    table.cell(dashboard, 1, 1, str.tostring(math.round(confidencePct)) + "%", text_color=confidencePct >= 75 ? color.lime : color.yellow)',
    '    table.cell(dashboard, 0, 2, "VWAP", text_color=color.white)',
    '    table.cell(dashboard, 1, 2, aboveVwap ? "Above" : "Below", text_color=aboveVwap ? color.lime : color.red)',
    '    table.cell(dashboard, 0, 3, "RSI", text_color=color.white)',
    '    table.cell(dashboard, 1, 3, str.tostring(math.round(rsiValue, 1)), text_color=rsiBullish ? color.lime : rsiBearish ? color.red : color.yellow)',
    '    table.cell(dashboard, 0, 4, "MACD", text_color=color.white)',
    '    table.cell(dashboard, 1, 4, macdBullish ? "Bullish" : macdBearish ? "Bearish" : "Flat", text_color=macdBullish ? color.lime : macdBearish ? color.red : color.silver)',
    '',
    'alertcondition(bullScore >= 3, "Bullish Confidence", "ATR/VWAP/MACD/RSI confidence has turned bullish.")',
    'alertcondition(bearScore >= 3, "Bearish Confidence", "ATR/VWAP/MACD/RSI confidence has turned bearish.")'
  ].join('\n');
}

function buildLiveSaveProbeSource(scriptName = DEFAULT_PINE_CREATE_SAVE_NAME, prompt = '') {
  const normalizedPrompt = String(prompt || '').toLowerCase();
  if (/\batr\b/.test(normalizedPrompt) && /\bvwap\b/.test(normalizedPrompt) && /\bmacd\b/.test(normalizedPrompt) && /\brsi\b/.test(normalizedPrompt)) {
    return buildAtrVwapMacdRsiConfidenceSource(scriptName);
  }
  if (/\bvwap\b/.test(normalizedPrompt) && /\btpo\b/.test(normalizedPrompt) && /\batr\b/.test(normalizedPrompt)) {
    return buildVwapTpoAtrConfidenceSource(scriptName);
  }
  const safeName = String(scriptName || DEFAULT_PINE_CREATE_SAVE_NAME).trim() || DEFAULT_PINE_CREATE_SAVE_NAME;
  return [
    '//@version=6',
    `indicator(${JSON.stringify(safeName)}, overlay=false)`,
    'plot(close, title="Close")'
  ].join('\n');
}

function buildDefaultPineCreateSavePrompt(scriptName = DEFAULT_PINE_CREATE_SAVE_NAME) {
  const safeName = String(scriptName || DEFAULT_PINE_CREATE_SAVE_NAME).trim() || DEFAULT_PINE_CREATE_SAVE_NAME;
  return `TradingView is already open. Create a new Pine script called "${safeName}", save the script, and report the visible save status. Do not add it to the chart.`;
}

function buildPineCreateSaveScenario(prompt, scriptName) {
  const synthesizedTitle = synthesizePineScriptTitleContract({
    userMessage: prompt || ''
  }).title;
  const effectiveScriptName = String(scriptName || synthesizedTitle || DEFAULT_PINE_CREATE_SAVE_NAME).trim() || DEFAULT_PINE_CREATE_SAVE_NAME;
  const effectivePrompt = String(prompt || buildDefaultPineCreateSavePrompt(effectiveScriptName)).trim()
    || buildDefaultPineCreateSavePrompt(effectiveScriptName);
  const scriptSource = buildLiveSaveProbeSource(effectiveScriptName, effectivePrompt);
  const sourceActions = [
    {
      type: 'run_command',
      shell: 'powershell',
      command: buildClipboardSetCommand(scriptSource),
      pinePreparedScriptName: effectiveScriptName,
      pineExpectedScriptName: effectiveScriptName,
      reason: `Copy the prepared Pine script (${effectiveScriptName}) to the clipboard for live create/save validation`
    }
  ];
  const inferredIntent = inferTradingViewPineIntent(effectivePrompt, sourceActions);
  if (!inferredIntent) {
    throw new Error('Could not infer a TradingView Pine create/save intent from the provided prompt.');
  }
  inferredIntent.requiresFreshIndicator = true;
  inferredIntent.safeAuthoringDefault = true;

  return {
    id: `pine-create-save-${sanitizeFileSegment(effectiveScriptName, 'pine-save')}`,
    description: `Create a fresh Pine script named ${effectiveScriptName}, save it, and verify visible save-state evidence without adding it to the chart.`,
    userMessage: effectivePrompt,
    actionData: {
      thought: `Create and save a fresh TradingView Pine script named ${effectiveScriptName}`,
      verification: 'TradingView should keep Pine Editor active and show save-state evidence for the freshly named script',
      actions: buildTradingViewPineWorkflowActions(inferredIntent, sourceActions)
    }
  };
}

function buildSymbolScenario(symbol) {
  return {
    id: `symbol-${sanitizeFileSegment(symbol, 'symbol')}`,
    description: `Change the TradingView symbol to ${symbol} and require an explicit chart-state proof.`,
    userMessage: `Set the TradingView symbol to ${symbol} and confirm it changed.`,
    actionData: {
      thought: `Apply TradingView symbol ${symbol}`,
      verification: `TradingView should show symbol ${symbol}`,
      actions: buildTradingViewSymbolWorkflowActions({ symbol, appName: 'TradingView' })
    }
  };
}

function buildTimeframeScenario(timeframe) {
  return {
    id: `timeframe-${sanitizeFileSegment(timeframe, 'timeframe')}`,
    description: `Change the TradingView timeframe to ${timeframe} and require an explicit chart-state proof.`,
    userMessage: `Set the TradingView chart timeframe to ${timeframe} and confirm it changed.`,
    actionData: {
      thought: `Apply TradingView timeframe ${timeframe}`,
      verification: `TradingView should show timeframe ${timeframe}`,
      actions: buildTradingViewTimeframeWorkflowActions({ timeframe, appName: 'TradingView' })
    }
  };
}

function buildScenarioPlan(options = {}) {
  const requested = String(options.scenarios || 'focus,pine-editor')
    .split(',')
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);

  const normalized = requested.length > 0 ? requested : ['focus', 'pine-editor'];
  const scenarios = [];

  for (const id of normalized) {
    if (id === 'focus') {
      scenarios.push(buildFocusScenario());
      continue;
    }
    if (id === 'pine' || id === 'pine-editor') {
      scenarios.push(buildPineScenario());
      continue;
    }
    if (id === 'pine-create-save' || id === 'pine-save') {
      scenarios.push(buildPineCreateSaveScenario(options.pinePrompt, options.pineScriptName));
      continue;
    }
    if (id === 'symbol') {
      if (!options.symbol) {
        throw new Error('Scenario "symbol" requires --symbol <TICKER>.');
      }
      if (!options.allowSymbolChange) {
        throw new Error('Scenario "symbol" mutates chart state. Re-run with --allow-symbol-change to make that explicit.');
      }
      scenarios.push(buildSymbolScenario(options.symbol));
      continue;
    }
    if (id === 'timeframe') {
      if (!options.timeframe) {
        throw new Error('Scenario "timeframe" requires --timeframe <VALUE>.');
      }
      if (!options.allowTimeframeChange) {
        throw new Error('Scenario "timeframe" mutates chart state. Re-run with --allow-timeframe-change to make that explicit.');
      }
      scenarios.push(buildTimeframeScenario(options.timeframe));
      continue;
    }
    throw new Error(`Unknown scenario: ${id}`);
  }

  return scenarios;
}

function printUsage() {
  console.log(`TradingView live smoke harness

Usage:
  node scripts/live-tradingview-smoke.js [options]

Default behavior:
  - requires an already-open TradingView session
  - runs non-destructive focus + Pine Editor smoke checks
  - starts a fast UI watcher for watcher-backed surface proof
  - exports runtime traces and a manifest to artifacts/live-validation/
  - does not relaunch TradingView unless you explicitly opt in

Options:
  --scenarios <csv>            Scenarios to run: focus,pine-editor,pine-create-save,symbol,timeframe
  --symbol <ticker>            Symbol for the symbol scenario
  --timeframe <value>          Timeframe for the timeframe scenario
  --pine-prompt <text>         User prompt for the pine-create-save scenario
  --pine-script-name <name>    Script title for the pine-create-save scenario
  --allow-symbol-change        Explicitly allow symbol mutation
  --allow-timeframe-change     Explicitly allow timeframe mutation
  --artifact-dir <path>        Output directory (default: artifacts/live-validation)
  --poll-interval <ms>         UI watcher poll interval (default: ${DEFAULT_POLL_INTERVAL_MS})
  --relaunch-tradingview-via-contract
                               Opt in to relaunch TradingView through the configured automation wrapper contract
  --relaunch-timeout-ms <ms>   Relaunch wait budget (default: ${DEFAULT_TRADINGVIEW_AUTOMATION_RELAUNCH_TIMEOUT_MS})
  --relaunch-poll-interval-ms <ms>
                               Relaunch profile poll interval (default: ${DEFAULT_TRADINGVIEW_AUTOMATION_RELAUNCH_POLL_INTERVAL_MS})
  --dry-run                    Print the planned scenarios and exit
  --help                       Show this help text

Examples:
  node scripts/live-tradingview-smoke.js
  node scripts/live-tradingview-smoke.js --dry-run
  node scripts/live-tradingview-smoke.js --scenarios focus,pine-editor
  node scripts/live-tradingview-smoke.js --scenarios pine-editor --relaunch-tradingview-via-contract
  node scripts/live-tradingview-smoke.js --scenarios pine-create-save
  node scripts/live-tradingview-smoke.js --scenarios symbol --symbol BTCUSD --allow-symbol-change
  node scripts/live-tradingview-smoke.js --scenarios timeframe --timeframe 5m --allow-timeframe-change
`);
}

async function startWatcher(pollInterval) {
  const watcher = getUIWatcher({
    pollInterval,
    focusedWindowOnly: false,
    maxElements: 450,
    quiet: true
  });
  const startedHere = !watcher.isPolling;
  if (startedHere) {
    watcher.start();
  }
  aiService.setUIWatcher(watcher);

  try {
    await watcher.waitForFreshState({
      sinceTs: 0,
      timeoutMs: Math.max(1500, pollInterval * 6)
    });
  } catch {}

  return { watcher, startedHere };
}

async function shutdownWatcherRuntime(watcherRuntime = null) {
  const ownedWatcher = watcherRuntime?.startedHere === true ? watcherRuntime?.watcher || null : null;
  const connectedWatcher = typeof aiService.getUIWatcher === 'function'
    ? aiService.getUIWatcher()
    : null;
  const watcher = ownedWatcher || connectedWatcher || null;

  if (watcher === connectedWatcher && typeof aiService.setUIWatcher === 'function') {
    aiService.setUIWatcher(null);
  }

  if (!ownedWatcher) {
    return;
  }

  if (typeof ownedWatcher.shutdown === 'function') {
    await withTimeout(ownedWatcher.shutdown(), 2000, 'watcher shutdown').catch((error) => {
      console.warn(`[LIVE-SMOKE] ${error.message}`);
    });
    return;
  }

  if (typeof ownedWatcher.destroy === 'function') {
    await withTimeout(Promise.resolve(ownedWatcher.destroy()), 2000, 'watcher destroy').catch((error) => {
      console.warn(`[LIVE-SMOKE] ${error.message}`);
    });
    return;
  }

  if (typeof ownedWatcher.stop === 'function') {
    ownedWatcher.stop();
  }
}

async function gatherPreflight(options = {}) {
  return findTradingViewContextWithOptions(options);
}

function scenarioBlockedByLaunchProfile(scenarioId = '', launchProfile = null) {
  const summarizedLaunchProfile = summarizeTradingViewLaunchProfile(launchProfile);
  return (
    summarizedLaunchProfile?.inspectionAvailable === true
    && scenarioRequiresTradingViewAutomationReadyLaunch(scenarioId)
    && summarizedLaunchProfile.automationReady !== true
  );
}

function everyScenarioBlockedByLaunchProfile(scenarios = [], launchProfile = null) {
  const plannedScenarios = Array.isArray(scenarios) ? scenarios : [];
  if (plannedScenarios.length === 0) {
    return false;
  }

  return plannedScenarios.every((scenario) => scenarioBlockedByLaunchProfile(scenario?.id || scenario, launchProfile));
}

async function runScenario(scenario, context) {
  const { runTag, artifactDir } = context;
  const effectiveScenario = bindScenarioToDetectedWindow(scenario, context.detectedWindow);
  const scenarioTag = `${runTag}-${sanitizeFileSegment(scenario.id)}`;
  const scenarioStartedAtMs = Date.now();
  let lastActionCompletedAtMs = null;
  const actionTimeline = [];
  const automationProfiler = createSystemAutomationProfiler(aiService.systemAutomation, context.detectedWindow);
  const launchProfile = context.launchProfile && typeof context.launchProfile === 'object'
    ? context.launchProfile
    : null;
  const launchContract = context.launchContract && typeof context.launchContract === 'object'
    ? context.launchContract
    : null;
  const launchCapability = context.launchCapability && typeof context.launchCapability === 'object'
    ? context.launchCapability
    : null;
  const launchRelaunch = context.launchRelaunch && typeof context.launchRelaunch === 'object'
    ? context.launchRelaunch
    : null;
  const summarizedLaunchProfile = summarizeTradingViewLaunchProfile(launchProfile);
  const summarizedLaunchContract = summarizeTradingViewAutomationLaunchContract(launchContract);
  const summarizedLaunchCapability = summarizeTradingViewLaunchCapability(launchCapability);
  const summarizedLaunchRelaunch = summarizeTradingViewAutomationRelaunch(launchRelaunch);

  console.log(`\n=== Scenario: ${effectiveScenario.id} ===`);
  console.log(effectiveScenario.description);
  console.log(`Actions: ${(effectiveScenario.actionData.actions || []).map(summarizeAction).join(' -> ')}`);
  if (summarizedLaunchProfile) {
    console.log(`Launch profile: ${JSON.stringify({
      profile: summarizedLaunchProfile.profile || null,
      automationReady: summarizedLaunchProfile.automationReady === true,
      reason: summarizedLaunchProfile.reason || null,
      expectedPort: summarizedLaunchProfile.expectedCdpPort || null,
      effectivePort: summarizedLaunchProfile.effectivePort || null
    })}`);
  }
  if (summarizedLaunchCapability) {
    console.log(`Launch capability: ${JSON.stringify({
      capabilityProfile: summarizedLaunchCapability.capabilityProfile || null,
      automationLaunchSurfaceDetected: summarizedLaunchCapability.automationLaunchSurfaceDetected === true,
      reason: summarizedLaunchCapability.reason || null,
      shellLaunchTarget: summarizedLaunchCapability.launchIdentity?.shellLaunchTarget || null
    })}`);
  }
  if (summarizedLaunchContract) {
    console.log(`Launch contract: ${JSON.stringify({
      status: summarizedLaunchContract.status || null,
      source: summarizedLaunchContract.source || null,
      kind: summarizedLaunchContract.kind || null,
      displayName: summarizedLaunchContract.displayName || null,
      command: summarizedLaunchContract.command || null,
      expectedPort: summarizedLaunchContract.expected?.cdpPort || null,
      rendererAccessibility: summarizedLaunchContract.expected?.rendererAccessibility === true
    })}`);
  }
  if (summarizedLaunchRelaunch) {
    console.log(`Launch relaunch: ${JSON.stringify({
      attempted: summarizedLaunchRelaunch.attempted === true,
      success: summarizedLaunchRelaunch.success === true,
      status: summarizedLaunchRelaunch.status || null,
      message: summarizedLaunchRelaunch.message || null,
      launcherPid: summarizedLaunchRelaunch.launcher?.pid || null,
      newRunningPids: summarizedLaunchRelaunch.readiness?.newRunningPids || []
    })}`);
  }

  let execResult = null;
  let scenarioError = null;

  if (scenarioBlockedByLaunchProfile(effectiveScenario.id, summarizedLaunchProfile)) {
    scenarioError = new Error(buildTradingViewLaunchBlockedMessage({
      scenarioId: effectiveScenario.id,
      launchProfile: summarizedLaunchProfile,
      launchCapability: summarizedLaunchCapability,
      launchContract: summarizedLaunchContract,
      launchRelaunch: summarizedLaunchRelaunch
    }));
    console.log(`[LAUNCH-PROFILE] ${scenarioError.message}`);
  } else {
    try {
      execResult = await automationProfiler.run(() => aiService.executeActions(
        effectiveScenario.actionData,
        (result, index, total) => {
          const completedAtMs = Date.now();
          const label = `${index + 1}/${total}`;
          const summary = result?.success
            ? (result?.message || 'ok')
            : (result?.error || 'failed');
          actionTimeline.push({
            index,
            total,
            action: result?.action || null,
            success: result?.success === true,
            completedAt: new Date(completedAtMs).toISOString(),
            elapsedMs: Math.max(0, completedAtMs - scenarioStartedAtMs),
            sincePreviousMs: lastActionCompletedAtMs === null ? null : Math.max(0, completedAtMs - lastActionCompletedAtMs),
            message: result?.message || null,
            error: result?.error || null,
            quickSearchPreflight: result?.quickSearchPreflight?.applicable
              ? {
                  ready: result.quickSearchPreflight.ready === true,
                  timedOut: result.quickSearchPreflight.timedOut === true,
                  clearedBy: result.quickSearchPreflight.clearedBy || null,
                  fallbackAssumedFocused: result.quickSearchPreflight.fallbackAssumedFocused === true
                }
              : null,
            quickSearchTypedVerification: result?.quickSearchTypedVerification?.applicable
              ? {
                  verified: result.quickSearchTypedVerification.verified === true,
                  satisfiedBy: result.quickSearchTypedVerification.satisfiedBy || null
                }
              : null
          });
          lastActionCompletedAtMs = completedAtMs;

          console.log(`[${label}] ${result?.action || 'action'}: ${summary}`);

          if (result?.quickSearchPreflight?.applicable) {
            const preflight = result.quickSearchPreflight;
            console.log(
              `    quick-search preflight: ready=${preflight.ready === true} clearedBy=${preflight.clearedBy || 'n/a'} fallbackAssumedFocused=${preflight.fallbackAssumedFocused === true} expected=${JSON.stringify(preflight.expectedText || '')}${preflight.error ? ` error=${JSON.stringify(preflight.error)}` : ''}`
            );
          }

          if (result?.quickSearchTypedVerification?.applicable) {
            const typedVerification = result.quickSearchTypedVerification;
            console.log(
              `    quick-search typed-check: verified=${typedVerification.verified === true} via=${typedVerification.satisfiedBy || 'n/a'} expected=${JSON.stringify(typedVerification.expectedText || '')} actual=${JSON.stringify(typedVerification.actualText || '')}${typedVerification.error ? ` error=${JSON.stringify(typedVerification.error)}` : ''}`
            );
          }
        },
        null,
        {
          userMessage: effectiveScenario.userMessage
        }
      ));
    } catch (error) {
      scenarioError = error;
    }
  }

  const automationProfile = automationProfiler.summarize();
  const fallbackRuntimeTraceSummary = typeof aiService.getLastRuntimeTraceSummary === 'function'
    ? aiService.getLastRuntimeTraceSummary()
    : null;

  let exportedTrace = null;
  try {
    exportedTrace = aiService.exportLastRuntimeTrace(path.join(artifactDir, `${scenarioTag}.jsonl`));
  } catch (error) {
    exportedTrace = { error: String(error?.message || error || 'Failed to export runtime trace') };
  }
  const runtimeTraceFilePath = exportedTrace?.filePath || fallbackRuntimeTraceSummary?.filePath || execResult?.runtimeTrace?.filePath || null;
  const runtimeTraceTerminalEvent = readRuntimeTraceTerminalEvent(runtimeTraceFilePath);
  const scenarioOutcome = deriveScenarioOutcome({
    scenarioError,
    execResult,
    runtimeTraceSummary: execResult?.runtimeTraceSummary || fallbackRuntimeTraceSummary || null,
    runtimeTraceTerminalEvent
  });
  const useLightweightFailureArtifact = shouldUseLightweightFailureArtifact({
    scenarioError,
    execResult,
    launchProfile: summarizedLaunchProfile,
    actionTimeline
  });
  const postForeground = useLightweightFailureArtifact
    ? null
    : await aiService.systemAutomation.getForegroundWindowInfo();
  const summarizedResults = Array.isArray(execResult?.results) ? execResult.results.map(summarizeResult) : [];
  const metrics = buildScenarioMetrics(summarizedResults, actionTimeline, automationProfile);
  let failureArtifact = null;

  if (scenarioOutcome.success !== true) {
    const failureArtifactOptions = {
      artifactDir,
      suiteName: 'live-tradingview-smoke',
      failureName: `${effectiveScenario.id}-failure`,
      phase: 'scenario',
      scenarioId: effectiveScenario.id,
      error: scenarioError || new Error(scenarioOutcome.error || execResult?.error || 'One or more actions failed'),
      aiService,
      watcher: typeof aiService.getUIWatcher === 'function' ? aiService.getUIWatcher() : null,
      extra: {
        runTag,
        scenarioTag,
        boundWindow: context.detectedWindow || null,
        launchProfile: summarizedLaunchProfile,
        launchContract: summarizedLaunchContract,
        launchCapability: summarizedLaunchCapability,
        launchRelaunch: summarizedLaunchRelaunch,
        actionSummary: (effectiveScenario.actionData.actions || []).map(summarizeAction),
        actionTimeline,
        metrics,
        postForeground,
        runtimeTraceSummary: execResult?.runtimeTraceSummary || fallbackRuntimeTraceSummary || null,
        results: summarizedResults
      }
    };

    failureArtifact = useLightweightFailureArtifact
      ? writeFailureArtifactBundleSync(failureArtifactOptions)
      : await writeFailureArtifactBundle({
          ...failureArtifactOptions,
          systemAutomation: aiService.systemAutomation,
          captureTargetWindowHandle: context.detectedWindow?.hwnd || null,
          captureForegroundWindow: true,
          tradingViewContextFn: findTradingViewContext
        });
  }

  const summary = {
    id: effectiveScenario.id,
    description: effectiveScenario.description,
    userMessage: effectiveScenario.userMessage,
    thought: effectiveScenario.actionData.thought,
    verification: effectiveScenario.actionData.verification,
    success: scenarioOutcome.success === true,
    error: scenarioOutcome.error || null,
    pendingConfirmation: execResult?.pendingConfirmation === true,
    boundWindow: context.detectedWindow || null,
    launchProfile: summarizedLaunchProfile,
    launchContract: summarizedLaunchContract,
    launchCapability: summarizedLaunchCapability,
    launchRelaunch: summarizedLaunchRelaunch,
    actionSummary: (effectiveScenario.actionData.actions || []).map(summarizeAction),
    observationCheckpointCount: Array.isArray(execResult?.observationCheckpoints)
      ? execResult.observationCheckpoints.length
      : 0,
    runtimeTrace: execResult?.runtimeTrace || (fallbackRuntimeTraceSummary?.sessionId
      ? {
          sessionId: fallbackRuntimeTraceSummary.sessionId,
          filePath: fallbackRuntimeTraceSummary.filePath
        }
      : null),
    runtimeTraceSummary: execResult?.runtimeTraceSummary || fallbackRuntimeTraceSummary || null,
    runtimeTraceTerminalEvent,
    reportingConsistency: {
      outcomeSource: scenarioOutcome.source || 'unknown',
      mismatch: scenarioOutcome.consistency?.mismatch === true,
      execResultSuccess: scenarioOutcome.consistency?.execResultSuccess ?? null,
      runtimeTraceSummarySuccess: scenarioOutcome.consistency?.runtimeTraceSummarySuccess ?? null,
      runtimeTraceTerminalSuccess: scenarioOutcome.consistency?.runtimeTraceTerminalSuccess ?? null
    },
    exportedTrace,
    postForeground,
    actionTimeline,
    metrics,
    failureArtifact,
    results: summarizedResults
  };

  const summaryPath = path.join(artifactDir, `${scenarioTag}.summary.json`);
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`Summary: ${summaryPath}`);
  if (exportedTrace?.filePath) {
    console.log(`Trace:   ${exportedTrace.filePath}`);
  }
  if (failureArtifact?.filePath) {
    console.log(`Failure: ${failureArtifact.filePath}`);
  }

  return summary;
}

async function main() {
  if (hasFlag('--help')) {
    printUsage();
    return;
  }

  const artifactDir = path.resolve(process.cwd(), getArgValue('--artifact-dir') || DEFAULT_ARTIFACT_DIR);
  const pollInterval = Math.max(100, Number(getArgValue('--poll-interval') || DEFAULT_POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS);
  const options = {
    scenarios: getArgValue('--scenarios') || getEnvValue('LIKU_LIVE_TV_SCENARIOS') || 'focus,pine-editor',
    symbol: getArgValue('--symbol') || getEnvValue('LIKU_LIVE_TV_SYMBOL') || '',
    timeframe: getArgValue('--timeframe') || getEnvValue('LIKU_LIVE_TV_TIMEFRAME') || '',
    pinePrompt: getArgValue('--pine-prompt') || getEnvValue('LIKU_LIVE_TV_PINE_PROMPT') || '',
    pineScriptName: getArgValue('--pine-script-name') || getEnvValue('LIKU_LIVE_TV_PINE_SCRIPT_NAME') || '',
    allowSymbolChange: hasFlag('--allow-symbol-change'),
    allowTimeframeChange: hasFlag('--allow-timeframe-change')
  };

  const scenarios = buildScenarioPlan(options);
  const dryRun = hasFlag('--dry-run');

  if (dryRun) {
    console.log(JSON.stringify({
      artifactDir,
      pollInterval,
      scenarios: scenarios.map((scenario) => ({
        id: scenario.id,
        description: scenario.description,
        userMessage: scenario.userMessage,
        actions: (scenario.actionData.actions || []).map(summarizeAction)
      }))
    }, null, 2));
    return;
  }

  ensureDir(artifactDir);
  const runTag = buildTimestampTag();
  const manifest = {
    runTag,
    startedAt: new Date().toISOString(),
    artifactDir,
    pollInterval,
    scenarios: [],
    preflight: null,
    fatalFailureArtifact: null,
    error: null,
    success: false
  };
  let watcherRuntime = { watcher: null, startedHere: false };
  let fatalError = null;
  let selectedWindow = null;
  const requestedTradingViewAutomationRelaunch = isTradingViewAutomationRelaunchRequested();
  const tradingViewAutomationRelaunchTimeoutMs = getTradingViewAutomationRelaunchTimeoutMs();
  const tradingViewAutomationRelaunchPollIntervalMs = getTradingViewAutomationRelaunchPollIntervalMs();
  const configuredTradingViewCdpPort = Number(getEnvValue('LIKU_TRADINGVIEW_CDP_PORT'));
  const defaultExpectedTradingViewCdpPort = Number.isFinite(configuredTradingViewCdpPort) && configuredTradingViewCdpPort > 0
    ? Math.round(configuredTradingViewCdpPort)
    : DEFAULT_TRADINGVIEW_CDP_PORT;

  console.log('========================================');
  console.log(' TradingView Live Smoke Harness');
  console.log('========================================');
  console.log(`Artifact dir: ${artifactDir}`);
  console.log(`Run tag:      ${runTag}`);
  console.log(`Scenarios:    ${scenarios.map((scenario) => scenario.id).join(', ')}`);
  console.log(`Watcher poll: ${pollInterval}ms`);
  console.log(`Wrapper relaunch: ${requestedTradingViewAutomationRelaunch ? 'enabled' : 'disabled'}`);

  try {
    const requiresAutomationReadyLaunchInspection = scenarios.some((scenario) => (
      scenarioRequiresTradingViewAutomationReadyLaunch(scenario?.id || scenario)
    ));
    const launchContract = requiresAutomationReadyLaunchInspection
      ? resolveTradingViewAutomationLaunchContract()
      : null;
    const summarizedLaunchContract = summarizeTradingViewAutomationLaunchContract(launchContract);
    const launchProfileDetectOptions = buildTradingViewLaunchProfileDetectOptions(
      launchContract,
      defaultExpectedTradingViewCdpPort
    );
    let launchProfile = await detectTradingViewLaunchProfile(launchProfileDetectOptions);
    let summarizedLaunchProfile = summarizeTradingViewLaunchProfile(launchProfile);
    const needsAutomationReadyLaunchPrecondition = requiresAutomationReadyLaunchInspection
      && summarizedLaunchProfile?.automationReady !== true;
    const shouldInspectLaunchCapability = needsAutomationReadyLaunchPrecondition
      && summarizedLaunchContract?.status === 'not-configured';
    const launchCapability = shouldInspectLaunchCapability
      ? await detectTradingViewLaunchCapability()
      : null;
    const summarizedLaunchCapability = summarizeTradingViewLaunchCapability(launchCapability);
    let launchRelaunch = null;

    if (needsAutomationReadyLaunchPrecondition && requestedTradingViewAutomationRelaunch) {
      launchRelaunch = await attemptTradingViewAutomationRelaunch({
        launchContract,
        launchProfile,
        cwd: process.cwd(),
        timeoutMs: tradingViewAutomationRelaunchTimeoutMs,
        pollIntervalMs: tradingViewAutomationRelaunchPollIntervalMs
      });
      const summarizedLaunchRelaunch = summarizeTradingViewAutomationRelaunch(launchRelaunch);
      if (summarizedLaunchRelaunch) {
        console.log(`TradingView launch relaunch: ${JSON.stringify({
          attempted: summarizedLaunchRelaunch.attempted === true,
          success: summarizedLaunchRelaunch.success === true,
          status: summarizedLaunchRelaunch.status || null,
          launcherPid: summarizedLaunchRelaunch.launcher?.pid || null,
          requestedInvocationPreview: summarizedLaunchRelaunch.launcher?.requestedInvocationPreview || null,
          durationMs: summarizedLaunchRelaunch.readiness?.durationMs || null,
          newRunningPids: summarizedLaunchRelaunch.readiness?.newRunningPids || []
        })}`);
        for (const warning of Array.isArray(summarizedLaunchRelaunch.warnings) ? summarizedLaunchRelaunch.warnings : []) {
          console.log(`[LAUNCH-RELAUNCH] ${warning}`);
        }
        if (summarizedLaunchRelaunch.message) {
          console.log(`[LAUNCH-RELAUNCH] ${summarizedLaunchRelaunch.message}`);
        }
        if (summarizedLaunchRelaunch.error) {
          console.log(`[LAUNCH-RELAUNCH] ${summarizedLaunchRelaunch.error}`);
        }
      }
      launchProfile = launchRelaunch?.postLaunchProfile || launchProfile;
      summarizedLaunchProfile = summarizeTradingViewLaunchProfile(launchProfile);
    } else if (needsAutomationReadyLaunchPrecondition && summarizedLaunchContract?.status === 'configured') {
      console.log('[LAUNCH-CONTRACT] A TradingView automation wrapper contract is configured, but relaunch is opt-in. Re-run with --relaunch-tradingview-via-contract or set LIKU_TRADINGVIEW_AUTOMATION_RELAUNCH=1 to let the harness relaunch TradingView.');
    }

    const summarizedLaunchRelaunch = summarizeTradingViewAutomationRelaunch(launchRelaunch);
    const preferredTradingViewWindowPids = Array.isArray(summarizedLaunchRelaunch?.readiness?.newRunningPids)
      ? summarizedLaunchRelaunch.readiness.newRunningPids
      : [];
    const allScenariosLaunchBlocked = everyScenarioBlockedByLaunchProfile(scenarios, summarizedLaunchProfile);
    const preflight = await gatherPreflight({
      includeProcesses: !allScenariosLaunchBlocked,
      fastWindowDiscovery: allScenariosLaunchBlocked,
      preferredProcessIds: preferredTradingViewWindowPids,
      preferredProcessWaitMs: preferredTradingViewWindowPids.length > 0 ? 2500 : 0
    });
    const { processes, foreground, windows, selectedWindow: detectedWindow } = preflight;
    selectedWindow = detectedWindow || null;
    const preflightProcessSource = Array.isArray(processes) && processes.length > 0
      ? processes
      : (Array.isArray(summarizedLaunchProfile?.processes) ? summarizedLaunchProfile.processes : []);
    const preflightProcesses = preflightProcessSource.map(normalizeSmokePreflightProcessEntry);
    manifest.preflight = {
      processes: preflightProcesses,
      processNames: Array.isArray(preflight?.processNames) ? preflight.processNames : [],
      windows,
      selectedWindow: detectedWindow,
      foreground,
      launchProfile: summarizedLaunchProfile,
      launchContract: summarizedLaunchContract,
      launchCapability: summarizedLaunchCapability,
      launchRelaunch: summarizedLaunchRelaunch,
      launchRelaunchRequested: requestedTradingViewAutomationRelaunch
    };

    if (!detectedWindow && !allScenariosLaunchBlocked) {
      throw new Error('No TradingView-like window was detected via UIA/window discovery. Make sure an actual TradingView desktop window or browser tab is open and visible, then rerun the live smoke harness.');
    }

    console.log(`TradingView-like windows detected: ${Array.isArray(windows) ? windows.length : 0}`);
    (windows || []).slice(0, 5).forEach((win, index) => {
      console.log(`  [${index}] hwnd=${win.hwnd} process=${win.processName} kind=${win.windowKind} title=${JSON.stringify(win.title || '')}`);
    });
    console.log(`Selected window: ${JSON.stringify({
      hwnd: detectedWindow?.hwnd || null,
      pid: detectedWindow?.pid || detectedWindow?.processId || null,
      title: detectedWindow?.title || null,
      processName: detectedWindow?.processName || null,
      windowKind: detectedWindow?.windowKind || null,
      isMinimized: !!detectedWindow?.isMinimized
    })}`);
    if (Array.isArray(preflightProcesses) && preflightProcesses.length > 0) {
      console.log(`Backing processes detected: ${preflightProcesses.length}`);
      preflightProcesses.slice(0, 5).forEach((proc, index) => {
        console.log(`  [${index}] pid=${proc.pid} process=${proc.processName} title=${JSON.stringify(proc.mainWindowTitle || '')}`);
      });
    }
    console.log(`Initial foreground: ${JSON.stringify({
      title: foreground?.title || null,
      processName: foreground?.processName || null,
      pid: foreground?.pid || foreground?.processId || null,
      hwnd: foreground?.hwnd || null,
      windowKind: foreground?.windowKind || null
    })}`);
    if (summarizedLaunchProfile) {
      console.log(`TradingView launch profile: ${JSON.stringify({
        profile: summarizedLaunchProfile.profile || null,
        automationReady: summarizedLaunchProfile.automationReady === true,
        reason: summarizedLaunchProfile.reason || null,
        expectedPort: summarizedLaunchProfile.expectedCdpPort || null,
        effectivePort: summarizedLaunchProfile.effectivePort || null,
        inspectionAvailable: summarizedLaunchProfile.inspectionAvailable !== false
      })}`);
      for (const warning of Array.isArray(summarizedLaunchProfile.warnings) ? summarizedLaunchProfile.warnings : []) {
        console.log(`[LAUNCH-PROFILE] ${warning}`);
      }
    }
    if (summarizedLaunchCapability) {
      console.log(`TradingView launch capability: ${JSON.stringify({
        capabilityProfile: summarizedLaunchCapability.capabilityProfile || null,
        automationLaunchSurfaceDetected: summarizedLaunchCapability.automationLaunchSurfaceDetected === true,
        reason: summarizedLaunchCapability.reason || null,
        shellLaunchTarget: summarizedLaunchCapability.launchIdentity?.shellLaunchTarget || null,
        inspectionAvailable: summarizedLaunchCapability.inspectionAvailable !== false
      })}`);
      for (const warning of Array.isArray(summarizedLaunchCapability.warnings) ? summarizedLaunchCapability.warnings : []) {
        console.log(`[LAUNCH-CAPABILITY] ${warning}`);
      }
    }
    if (summarizedLaunchContract) {
      console.log(`TradingView launch contract: ${JSON.stringify({
        status: summarizedLaunchContract.status || null,
        source: summarizedLaunchContract.source || null,
        kind: summarizedLaunchContract.kind || null,
        displayName: summarizedLaunchContract.displayName || null,
        command: summarizedLaunchContract.command || null,
        expectedPort: summarizedLaunchContract.expected?.cdpPort || null,
        rendererAccessibility: summarizedLaunchContract.expected?.rendererAccessibility === true
      })}`);
      for (const warning of Array.isArray(summarizedLaunchContract.warnings) ? summarizedLaunchContract.warnings : []) {
        console.log(`[LAUNCH-CONTRACT] ${warning}`);
      }
      if (summarizedLaunchContract.error) {
        console.log(`[LAUNCH-CONTRACT] ${summarizedLaunchContract.error}`);
      }
    }
    if (summarizedLaunchRelaunch) {
      console.log(`TradingView launch relaunch result: ${JSON.stringify({
        attempted: summarizedLaunchRelaunch.attempted === true,
        success: summarizedLaunchRelaunch.success === true,
        status: summarizedLaunchRelaunch.status || null,
        durationMs: summarizedLaunchRelaunch.readiness?.durationMs || null,
        newRunningPids: summarizedLaunchRelaunch.readiness?.newRunningPids || []
      })}`);
      if (
        preferredTradingViewWindowPids.length > 0
        && detectedWindow
        && !preferredTradingViewWindowPids.includes(Number(detectedWindow?.pid || detectedWindow?.processId || 0))
      ) {
        console.log(`[LAUNCH-RELAUNCH] Preferred post-relaunch TradingView PID(s) ${preferredTradingViewWindowPids.join(', ')} were not selected during preflight. Selected hwnd=${detectedWindow.hwnd} pid=${detectedWindow.pid || detectedWindow.processId || 'n/a'}.`);
      }
    }

    if (allScenariosLaunchBlocked) {
      console.log('[LAUNCH-PROFILE] Skipping watcher startup and heavy process revalidation because every requested scenario is blocked before execution.');
    } else {
      watcherRuntime = await startWatcher(pollInterval);
      await sleep(Math.max(300, pollInterval * 2));
    }

    for (const scenario of scenarios) {
      const summary = await runScenario(scenario, {
        runTag,
        artifactDir,
        detectedWindow,
        launchProfile,
        launchContract,
        launchCapability,
        launchRelaunch
      });
      manifest.scenarios.push(summary);
    }
  } catch (error) {
    fatalError = error;
    manifest.error = String(error?.message || error || 'TradingView live smoke failed before completion');
    manifest.fatalFailureArtifact = await writeFailureArtifactBundle({
      artifactDir,
      suiteName: 'live-tradingview-smoke',
      failureName: 'main-failure',
      phase: 'main',
      error,
      aiService,
      systemAutomation: aiService.systemAutomation,
      watcher: watcherRuntime?.watcher || (typeof aiService.getUIWatcher === 'function' ? aiService.getUIWatcher() : null),
      captureTargetWindowHandle: selectedWindow?.hwnd || null,
      captureForegroundWindow: true,
      tradingViewContextFn: findTradingViewContext,
      extra: {
        runTag,
        pollInterval,
        options,
        manifest: cloneJson(manifest)
      }
    });
    console.error(error.stack || error.message);
    if (manifest.fatalFailureArtifact?.filePath) {
      console.error(`Failure artifact: ${manifest.fatalFailureArtifact.filePath}`);
    }
  } finally {
    await shutdownWatcherRuntime(watcherRuntime).catch(() => {});
    await withTimeout(shutdownSharedUIAHost().catch(() => {}), 2000, 'UIA host shutdown').catch((error) => {
      console.warn(`[LIVE-SMOKE] ${error.message}`);
    });
  }

  manifest.finishedAt = new Date().toISOString();
  manifest.success = !fatalError && manifest.scenarios.every((scenario) => scenario.success === true);
  const manifestPath = path.join(artifactDir, `${runTag}-tradingview-live-smoke.manifest.json`);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log('\n========================================');
  console.log(` Result: ${manifest.success ? 'PASS' : 'FAIL'}`);
  console.log('========================================');
  manifest.scenarios.forEach((scenario) => {
    console.log(`- ${scenario.id}: ${scenario.success ? 'PASS' : 'FAIL'}${scenario.error ? ` (${scenario.error})` : ''}`);
  });
  if (manifest.error) {
    console.log(`- fatal: ${manifest.error}`);
  }
  console.log(`Manifest: ${manifestPath}`);

  return manifest.success ? 0 : 1;
}

if (require.main === module) {
  main()
    .then(async (exitCode) => {
      await flushProcessOutput().catch(() => {});
      process.exit(Number.isFinite(Number(exitCode)) ? Number(exitCode) : 0);
    })
    .catch(async (error) => {
      console.error(error.stack || error.message);
      await flushProcessOutput().catch(() => {});
      process.exit(1);
    });
} else {
  module.exports = {
    windowLooksLikeTradingView,
    pickPreferredTradingViewWindow,
    findTradingViewContext,
    findTradingViewContextWithOptions,
    summarizeResult,
    buildScenarioMetrics,
    buildPineCreateSaveScenario,
    buildScenarioPlan,
    readRuntimeTraceTerminalEvent,
    deriveScenarioOutcome,
    scenarioBlockedByLaunchProfile,
    everyScenarioBlockedByLaunchProfile,
    shouldUseLightweightFailureArtifact,
    shutdownWatcherRuntime
  };
}
