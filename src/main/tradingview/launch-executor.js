const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const {
  DEFAULT_TRADINGVIEW_CDP_PORT,
  detectTradingViewLaunchProfile,
  summarizeTradingViewLaunchProfile
} = require('./launch-profile');
const {
  summarizeTradingViewAutomationLaunchContract
} = require('./launch-contract');

const DEFAULT_TRADINGVIEW_AUTOMATION_RELAUNCH_TIMEOUT_MS = 30000;
const DEFAULT_TRADINGVIEW_AUTOMATION_RELAUNCH_POLL_INTERVAL_MS = 500;
const DEFAULT_TRADINGVIEW_AUTOMATION_RELAUNCH_STARTUP_DELAY_MS = 1000;
const ENV_TRADINGVIEW_AUTOMATION_WRAPPER_STATUS_FILE = 'LIKU_TRADINGVIEW_AUTOMATION_WRAPPER_STATUS_FILE';

function parseJsonPayload(text = '') {
  const raw = String(text || '').trim();
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    const sanitized = raw.replace(/[\u0000-\u001F]/g, ' ');
    if (sanitized && sanitized !== raw) {
      return JSON.parse(sanitized);
    }
    throw error;
  }
}

function normalizeString(value = '') {
  return String(value || '').trim();
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizePort(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const normalized = Math.round(numeric);
  return normalized >= 1 && normalized <= 65535 ? normalized : fallback;
}

function normalizeStringArray(values = [], options = {}) {
  const input = Array.isArray(values) ? values : [values];
  const seen = new Set();
  const result = [];
  for (const value of input) {
    const normalized = normalizeString(value);
    if (!normalized) continue;
    const key = options.caseInsensitive === true ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function clampNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(Math.round(numeric), max));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function looksLikeFilesystemPath(value = '') {
  const normalized = normalizeString(value);
  if (!normalized) return false;
  return /[\\/]/.test(normalized)
    || /^[A-Za-z]:/.test(normalized)
    || /^\./.test(normalized);
}

function quoteSegment(value = '') {
  const text = String(value || '');
  if (!text) return '""';
  if (!/[\s"]/u.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

function quoteForCmd(value = '') {
  const text = String(value || '');
  if (!text) return '""';
  if (!/[\s"&()<>^|]/u.test(text)) return text;
  return `"${text.replace(/(["^])/g, '^$1')}"`;
}

function buildInvocationPreview(file = '', args = []) {
  return [normalizeString(file), ...(Array.isArray(args) ? args : [])]
    .map((value) => quoteSegment(value))
    .filter(Boolean)
    .join(' ');
}

function buildTradingViewAutomationWrapperStatusFilePath(options = {}) {
  const preferredRoot = normalizeString(options.cwd)
    ? path.join(path.resolve(normalizeString(options.cwd)), 'artifacts', 'tmp')
    : '';
  const baseDir = preferredRoot || os.tmpdir();
  return path.join(
    baseDir,
    `liku-tv-launch-wrapper-status-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
}

function summarizeTradingViewAutomationWrapperStatus(wrapperStatus = null) {
  if (!wrapperStatus || typeof wrapperStatus !== 'object') return null;

  return {
    status: normalizeString(wrapperStatus.status),
    phase: normalizeString(wrapperStatus.phase),
    message: wrapperStatus.message || null,
    error: wrapperStatus.error || null,
    executablePath: normalizeString(wrapperStatus.executablePath),
    launchMode: normalizeString(wrapperStatus.launchMode),
    appUserModelId: normalizeString(wrapperStatus.appUserModelId),
    packageFamilyName: normalizeString(wrapperStatus.packageFamilyName),
    launchedProcessId: Number(wrapperStatus.launchedProcessId || 0) || 0,
    launchedProcessAlive: wrapperStatus.launchedProcessAlive === true,
    activationHResult: normalizeString(wrapperStatus.activationHResult),
    allowForceKillExisting: wrapperStatus.allowForceKillExisting === true,
    existingProcessIds: normalizeStringArray(wrapperStatus.existingProcessIds || []).map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0).slice(0, 16),
    attemptedCloseProcessIds: normalizeStringArray(wrapperStatus.attemptedCloseProcessIds || []).map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0).slice(0, 16),
    closedProcessIds: normalizeStringArray(wrapperStatus.closedProcessIds || []).map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0).slice(0, 16),
    forcedProcessIds: normalizeStringArray(wrapperStatus.forcedProcessIds || []).map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0).slice(0, 16),
    observedProcessIdsAfterLaunch: normalizeStringArray(wrapperStatus.observedProcessIdsAfterLaunch || []).map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0).slice(0, 16),
    remainingProcessIds: normalizeStringArray(wrapperStatus.remainingProcessIds || []).map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0).slice(0, 16),
    removedDevToolsActivePortPaths: normalizeStringArray(wrapperStatus.removedDevToolsActivePortPaths || []).slice(0, 8),
    updatedAt: wrapperStatus.updatedAt || null
  };
}

function readTradingViewAutomationWrapperStatus(statusFilePath = '') {
  const normalizedPath = normalizeString(statusFilePath);
  if (!normalizedPath || !fs.existsSync(normalizedPath)) {
    return null;
  }

  try {
    const text = fs.readFileSync(normalizedPath, 'utf8');
    return summarizeTradingViewAutomationWrapperStatus(parseJsonPayload(text));
  } catch (error) {
    return {
      status: 'read-failed',
      phase: 'wrapper-status-read',
      message: 'Failed to read TradingView automation wrapper status file.',
      error: error?.message || String(error || 'Failed to read wrapper status'),
      executablePath: '',
      launchMode: '',
      appUserModelId: '',
      packageFamilyName: '',
      launchedProcessId: 0,
      launchedProcessAlive: false,
      activationHResult: '',
      allowForceKillExisting: false,
      existingProcessIds: [],
      attemptedCloseProcessIds: [],
      closedProcessIds: [],
      forcedProcessIds: [],
      observedProcessIdsAfterLaunch: [],
      remainingProcessIds: [],
      removedDevToolsActivePortPaths: [],
      updatedAt: null
    };
  }
}

function buildCmdInvocation(command = '', args = []) {
  return [normalizeString(command), ...(Array.isArray(args) ? args : [])]
    .map((value) => quoteForCmd(value))
    .filter(Boolean)
    .join(' ');
}

function buildLaunchExpectation(contractSummary = null) {
  return {
    cdpPort: normalizePort(contractSummary?.expected?.cdpPort, DEFAULT_TRADINGVIEW_CDP_PORT) || DEFAULT_TRADINGVIEW_CDP_PORT,
    rendererAccessibility: normalizeBoolean(contractSummary?.expected?.rendererAccessibility, true),
    processNames: normalizeStringArray(contractSummary?.expected?.processNames || ['TradingView', 'TradingView.exe'], {
      caseInsensitive: true
    })
  };
}

function buildTradingViewAutomationLaunchSpawnSpec(contract = null, options = {}) {
  const contractSummary = summarizeTradingViewAutomationLaunchContract(contract);
  if (!contractSummary || contractSummary.status !== 'configured') {
    throw new Error('TradingView automation launch contract must be configured before a relaunch can be attempted.');
  }

  const resolvedCommand = normalizeString(contractSummary.resolvedCommand || contractSummary.command);
  const args = Array.isArray(contractSummary.args) ? contractSummary.args.slice() : [];
  const env = {
    ...process.env,
    ...(options.env && typeof options.env === 'object' ? options.env : {})
  };
  const expected = buildLaunchExpectation(contractSummary);

  if (!env.LIKU_TRADINGVIEW_CDP_PORT && expected.cdpPort) {
    env.LIKU_TRADINGVIEW_CDP_PORT = String(expected.cdpPort);
  }
  if (!env.LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_CDP_PORT && expected.cdpPort) {
    env.LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_CDP_PORT = String(expected.cdpPort);
  }
  if (!env.LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_RENDERER_ACCESSIBILITY && expected.rendererAccessibility) {
    env.LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_RENDERER_ACCESSIBILITY = '1';
  }

  const explicitWorkdir = normalizeString(contractSummary.resolvedWorkdir || contractSummary.workdir);
  const inferredWorkdir = looksLikeFilesystemPath(resolvedCommand) ? path.dirname(resolvedCommand) : '';
  const cwd = explicitWorkdir || inferredWorkdir || normalizeString(options.cwd) || process.cwd();
  const extension = path.extname(resolvedCommand).toLowerCase();
  const wrapperStatusFile = normalizeString(options.wrapperStatusFile);

  if (extension === '.cmd' || extension === '.bat') {
    const commandString = buildCmdInvocation(resolvedCommand, args);
    const shellFile = env.ComSpec || env.COMSPEC || 'cmd.exe';
    return {
      mode: 'cmd-wrapper',
      file: shellFile,
      args: ['/d', '/s', '/c', commandString],
      cwd,
      env,
      detached: false,
      windowsHide: true,
      stdio: 'ignore',
      invocationPreview: buildInvocationPreview(shellFile, ['/d', '/s', '/c', commandString]),
      requestedInvocationPreview: normalizeString(contractSummary.invocationPreview) || buildInvocationPreview(resolvedCommand, args)
    };
  }

  if (extension === '.ps1') {
    const powershellFile = 'powershell.exe';
    const powershellArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolvedCommand, ...args];
    if (wrapperStatusFile) {
      powershellArgs.push('-StatusFile', wrapperStatusFile);
    }
    return {
      mode: 'powershell-wrapper',
      file: powershellFile,
      args: powershellArgs,
      cwd,
      env,
      detached: false,
      windowsHide: true,
      stdio: 'ignore',
      invocationPreview: buildInvocationPreview(powershellFile, powershellArgs),
      requestedInvocationPreview: normalizeString(contractSummary.invocationPreview) || buildInvocationPreview(resolvedCommand, args)
    };
  }

  return {
    mode: 'direct',
    file: resolvedCommand,
    args,
    cwd,
    env,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    invocationPreview: buildInvocationPreview(resolvedCommand, args),
    requestedInvocationPreview: normalizeString(contractSummary.invocationPreview) || buildInvocationPreview(resolvedCommand, args)
  };
}

function summarizeProfilePoll(profileSummary = null, elapsedMs = 0) {
  return {
    elapsedMs: Math.max(0, Number(elapsedMs || 0) || 0),
    inspectionAvailable: profileSummary?.inspectionAvailable !== false,
    running: profileSummary?.running === true,
    profile: normalizeString(profileSummary?.profile),
    automationReady: profileSummary?.automationReady === true,
    reason: profileSummary?.reason || null,
    effectivePort: normalizePort(profileSummary?.effectivePort, 0),
    listenerPorts: Array.isArray(profileSummary?.listenerPorts) ? profileSummary.listenerPorts.slice(0, 6) : [],
    rendererAccessibilityConfigured: profileSummary?.rendererAccessibilityConfigured === true,
    processCount: Number(profileSummary?.processCount || 0) || 0,
    runningPids: Array.isArray(profileSummary?.runningPids) ? profileSummary.runningPids.slice(0, 12) : []
  };
}

function evaluateLaunchReadiness(profileSummary = null, contractSummary = null, previousRunningPids = []) {
  const expected = buildLaunchExpectation(contractSummary);
  const runningPids = Array.isArray(profileSummary?.runningPids) ? profileSummary.runningPids.filter((pid) => Number(pid) > 0) : [];
  const previous = new Set((Array.isArray(previousRunningPids) ? previousRunningPids : []).map((pid) => Number(pid) || 0).filter((pid) => pid > 0));
  const newRunningPids = runningPids.filter((pid) => !previous.has(pid));
  const expectedPortObserved = expected.cdpPort > 0 && (
    normalizePort(profileSummary?.effectivePort, 0) === expected.cdpPort
    || (Array.isArray(profileSummary?.listenerPorts) && profileSummary.listenerPorts.includes(expected.cdpPort))
    || (Array.isArray(profileSummary?.remoteDebuggingPorts) && profileSummary.remoteDebuggingPorts.includes(expected.cdpPort))
  );
  const rendererAccessibilityObserved = expected.rendererAccessibility !== true
    || profileSummary?.rendererAccessibilityConfigured === true;
  const processObserved = (Number(profileSummary?.processCount || 0) || 0) > 0;
  const automationReady = profileSummary?.automationReady === true;

  let mismatchReason = null;
  if (profileSummary?.inspectionAvailable === false) {
    mismatchReason = 'launch-profile-inspection-unavailable';
  } else if (!automationReady) {
    mismatchReason = normalizeString(profileSummary?.reason) || 'launch-profile-not-automation-ready';
  } else if (!expectedPortObserved) {
    mismatchReason = 'expected-cdp-port-not-observed';
  } else if (!processObserved) {
    mismatchReason = 'expected-process-not-observed';
  } else if (!rendererAccessibilityObserved) {
    mismatchReason = 'renderer-accessibility-not-observed';
  }

  return {
    automationReady,
    expectedPortObserved,
    rendererAccessibilityObserved,
    processObserved,
    newRunningPids,
    success: automationReady && expectedPortObserved && processObserved && rendererAccessibilityObserved,
    mismatchReason
  };
}

function buildResultStatusDetails(status = '') {
  switch (normalizeString(status)) {
    case 'contract-not-configured':
      return {
        message: 'No TradingView automation launch contract is configured, so relaunch was skipped.',
        likelyMeaning: 'The live harness had no explicit wrapper command to relaunch TradingView into the automation-ready profile.',
        recommendedNextStep: 'Configure a TradingView automation launch contract before requesting a relaunch.'
      };
    case 'contract-invalid':
      return {
        message: 'The configured TradingView automation launch contract is invalid, so relaunch was skipped.',
        likelyMeaning: 'The wrapper contract failed validation before any relaunch command could be started.',
        recommendedNextStep: 'Fix the TradingView automation launch contract and rerun the smoke harness.'
      };
    case 'already-automation-ready':
      return {
        message: 'TradingView was already automation-ready, so no relaunch was needed.',
        likelyMeaning: 'A live remote debugging endpoint was already present for the expected TradingView profile.',
        recommendedNextStep: 'Continue with the requested Pine/CDP scenario.'
      };
    case 'launch-failed':
      return {
        message: 'The TradingView wrapper command failed to launch.',
        likelyMeaning: 'The relaunch executor could not start the configured wrapper command.',
        recommendedNextStep: 'Verify the wrapper command, workdir, and execution policy, then rerun the harness.'
      };
    case 'wrapper-failed':
      return {
        message: 'The TradingView automation wrapper reported a bounded close/restart failure before TradingView became automation-ready.',
        likelyMeaning: 'The wrapper contract started, but its own lifecycle step failed before the expected CDP/accessibility profile materialized.',
        recommendedNextStep: 'Inspect the wrapper status details, adjust the restart policy if needed, and rerun the harness.'
      };
    case 'contract-mismatch':
      return {
        message: 'TradingView started changing state, but the relaunched session never matched the configured automation-ready expectations.',
        likelyMeaning: 'The wrapper command launched something, but the expected CDP port or renderer accessibility signal never matched the contract.',
        recommendedNextStep: 'Verify that the wrapper applies the expected CDP port and renderer accessibility flags, then inspect the live launch profile again.'
      };
    case 'timeout':
      return {
        message: 'TradingView did not become automation-ready before the relaunch timeout elapsed.',
        likelyMeaning: 'The wrapper command did not produce a verified automation-ready TradingView session within the bounded wait window.',
        recommendedNextStep: 'Close stale TradingView sessions if needed, inspect the wrapper behavior, and rerun with the launch-capability inspector.'
      };
    case 'automation-ready':
      return {
        message: 'TradingView became automation-ready through the configured wrapper contract.',
        likelyMeaning: 'The relaunch executor observed the expected CDP port and process profile after starting the wrapper command.',
        recommendedNextStep: 'Continue with the requested Pine/CDP scenario.'
      };
    default:
      return {
        message: 'TradingView relaunch result is unavailable.',
        likelyMeaning: null,
        recommendedNextStep: null
      };
  }
}

function summarizeTradingViewAutomationRelaunch(result = null) {
  if (!result || typeof result !== 'object') return null;

  return {
    attempted: result.attempted === true,
    success: result.success === true,
    status: normalizeString(result.status),
    message: result.message || null,
    error: result.error || null,
    likelyMeaning: result.likelyMeaning || null,
    recommendedNextStep: result.recommendedNextStep || null,
    expected: result.expected
      ? {
          cdpPort: normalizePort(result.expected.cdpPort, DEFAULT_TRADINGVIEW_CDP_PORT) || DEFAULT_TRADINGVIEW_CDP_PORT,
          rendererAccessibility: normalizeBoolean(result.expected.rendererAccessibility, true),
          processNames: normalizeStringArray(result.expected.processNames || [], { caseInsensitive: true }).slice(0, 12)
        }
      : null,
    launcher: result.launcher
      ? {
          spawned: result.launcher.spawned === true,
          pid: Number(result.launcher.pid || 0) || 0,
          mode: normalizeString(result.launcher.mode),
          file: normalizeString(result.launcher.file),
          cwd: normalizeString(result.launcher.cwd),
          wrapperStatusFile: normalizeString(result.launcher.wrapperStatusFile),
          requestedInvocationPreview: normalizeString(result.launcher.requestedInvocationPreview),
          invocationPreview: normalizeString(result.launcher.invocationPreview)
        }
      : null,
    readiness: result.readiness
      ? {
          pollCount: Number(result.readiness.pollCount || 0) || 0,
          durationMs: Number(result.readiness.durationMs || 0) || 0,
          previousRunningPids: Array.isArray(result.readiness.previousRunningPids) ? result.readiness.previousRunningPids.slice(0, 12) : [],
          finalRunningPids: Array.isArray(result.readiness.finalRunningPids) ? result.readiness.finalRunningPids.slice(0, 12) : [],
          newRunningPids: Array.isArray(result.readiness.newRunningPids) ? result.readiness.newRunningPids.slice(0, 12) : [],
          mismatchReason: normalizeString(result.readiness.mismatchReason),
          startedAt: result.readiness.startedAt || null,
          completedAt: result.readiness.completedAt || null
        }
      : null,
    wrapperStatus: summarizeTradingViewAutomationWrapperStatus(result.wrapperStatus),
    preLaunchProfile: summarizeTradingViewLaunchProfile(result.preLaunchProfile),
    postLaunchProfile: summarizeTradingViewLaunchProfile(result.postLaunchProfile),
    samples: Array.isArray(result.samples) ? result.samples.slice(0, 12) : [],
    warnings: Array.isArray(result.warnings) ? result.warnings.slice(0, 8) : []
  };
}

async function attemptTradingViewAutomationRelaunch(options = {}) {
  const contractSummary = summarizeTradingViewAutomationLaunchContract(options.launchContract);
  const preLaunchProfile = summarizeTradingViewLaunchProfile(options.launchProfile);
  const timeoutMs = clampNumber(
    options.timeoutMs,
    DEFAULT_TRADINGVIEW_AUTOMATION_RELAUNCH_TIMEOUT_MS,
    2000,
    120000
  );
  const pollIntervalMs = clampNumber(
    options.pollIntervalMs,
    DEFAULT_TRADINGVIEW_AUTOMATION_RELAUNCH_POLL_INTERVAL_MS,
    150,
    5000
  );
  const startupDelayMs = clampNumber(
    options.startupDelayMs,
    DEFAULT_TRADINGVIEW_AUTOMATION_RELAUNCH_STARTUP_DELAY_MS,
    0,
    15000
  );
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const sleepFn = typeof options.sleep === 'function' ? options.sleep : sleep;
  const detectProfile = typeof options.detectTradingViewLaunchProfile === 'function'
    ? options.detectTradingViewLaunchProfile
    : detectTradingViewLaunchProfile;
  const spawnChild = typeof options.spawn === 'function' ? options.spawn : spawn;
  const wrapperStatusFile = normalizeString(options.wrapperStatusFile) || buildTradingViewAutomationWrapperStatusFilePath({
    cwd: options.cwd
  });

  const result = {
    attempted: false,
    success: false,
    status: '',
    message: null,
    error: null,
    likelyMeaning: null,
    recommendedNextStep: null,
    expected: contractSummary ? buildLaunchExpectation(contractSummary) : null,
    launcher: {
      spawned: false,
      pid: 0,
      mode: '',
      file: '',
      cwd: '',
      wrapperStatusFile,
      requestedInvocationPreview: '',
      invocationPreview: ''
    },
    readiness: {
      pollCount: 0,
      durationMs: 0,
      previousRunningPids: Array.isArray(preLaunchProfile?.runningPids) ? preLaunchProfile.runningPids.slice() : [],
      finalRunningPids: Array.isArray(preLaunchProfile?.runningPids) ? preLaunchProfile.runningPids.slice() : [],
      newRunningPids: [],
      mismatchReason: null,
      startedAt: new Date(now()).toISOString(),
      completedAt: null
    },
    preLaunchProfile,
    postLaunchProfile: preLaunchProfile,
    wrapperStatus: null,
    samples: [],
    warnings: []
  };

  if (!contractSummary || contractSummary.status === 'not-configured') {
    result.status = 'contract-not-configured';
    Object.assign(result, buildResultStatusDetails(result.status));
    result.readiness.completedAt = new Date(now()).toISOString();
    return result;
  }

  if (contractSummary.status !== 'configured') {
    result.status = 'contract-invalid';
    result.error = contractSummary?.error || null;
    Object.assign(result, buildResultStatusDetails(result.status));
    result.readiness.completedAt = new Date(now()).toISOString();
    return result;
  }

  if (preLaunchProfile?.automationReady === true) {
    result.status = 'already-automation-ready';
    result.success = true;
    Object.assign(result, buildResultStatusDetails(result.status));
    result.readiness.completedAt = new Date(now()).toISOString();
    return result;
  }

  let spawnSpec = null;
  try {
    spawnSpec = buildTradingViewAutomationLaunchSpawnSpec(contractSummary, {
      cwd: options.cwd,
      wrapperStatusFile,
      env: {
        ...(options.env && typeof options.env === 'object' ? options.env : {}),
        [ENV_TRADINGVIEW_AUTOMATION_WRAPPER_STATUS_FILE]: wrapperStatusFile
      }
    });
  } catch (error) {
    result.status = 'launch-failed';
    result.error = error?.message || String(error || 'TradingView relaunch spawn spec failed');
    Object.assign(result, buildResultStatusDetails(result.status));
    result.readiness.completedAt = new Date(now()).toISOString();
    return result;
  }

  result.attempted = true;
  result.launcher = {
    spawned: false,
    pid: 0,
    mode: spawnSpec.mode,
    file: spawnSpec.file,
    cwd: spawnSpec.cwd,
    wrapperStatusFile,
    requestedInvocationPreview: spawnSpec.requestedInvocationPreview || '',
    invocationPreview: spawnSpec.invocationPreview || ''
  };

  try {
    const child = spawnChild(spawnSpec.file, spawnSpec.args, {
      cwd: spawnSpec.cwd,
      env: spawnSpec.env,
      windowsHide: spawnSpec.windowsHide === true,
      stdio: spawnSpec.stdio || 'ignore',
      detached: spawnSpec.detached === true,
      shell: false
    });
    result.launcher.spawned = true;
    result.launcher.pid = Number(child?.pid || 0) || 0;
    if (spawnSpec.detached === true && child && typeof child.unref === 'function') {
      child.unref();
    }
  } catch (error) {
    result.status = 'launch-failed';
    result.error = error?.message || String(error || 'TradingView wrapper launch failed');
    Object.assign(result, buildResultStatusDetails(result.status));
    result.readiness.completedAt = new Date(now()).toISOString();
    return result;
  }

  if (startupDelayMs > 0) {
    await sleepFn(startupDelayMs);
  }

  const deadlineMs = now() + timeoutMs;
  let lastProfileSummary = preLaunchProfile;
  let sawContractMismatch = false;

  while (now() <= deadlineMs) {
    const currentWrapperStatus = readTradingViewAutomationWrapperStatus(wrapperStatusFile);
    if (currentWrapperStatus) {
      result.wrapperStatus = currentWrapperStatus;
      if (currentWrapperStatus.status === 'failed') {
        result.status = 'wrapper-failed';
        result.error = currentWrapperStatus.error || currentWrapperStatus.message || null;
        Object.assign(result, buildResultStatusDetails(result.status));
        result.readiness.completedAt = new Date(now()).toISOString();
        return result;
      }
    }

    let currentProfileSummary = null;
    try {
      const currentProfile = await detectProfile({
        expectedCdpPort: result.expected?.cdpPort || DEFAULT_TRADINGVIEW_CDP_PORT,
        processNames: result.expected?.processNames || ['TradingView', 'TradingView.exe']
      });
      currentProfileSummary = summarizeTradingViewLaunchProfile(currentProfile);
    } catch (error) {
      const warning = normalizeString(error?.message || error);
      if (warning) {
        result.warnings.push(`TradingView relaunch profile poll failed: ${warning}`);
      }
      currentProfileSummary = {
        inspectionAvailable: false,
        running: false,
        profile: 'inspection-unavailable',
        automationReady: false,
        reason: 'launch-profile-inspection-failed',
        likelyMeaning: 'TradingView launch profile inspection failed during the relaunch wait loop.',
        expectedCdpPort: result.expected?.cdpPort || DEFAULT_TRADINGVIEW_CDP_PORT,
        effectivePort: 0,
        processCount: 0,
        runningPids: [],
        remoteDebuggingConfigured: false,
        remoteDebuggingPorts: [],
        rendererAccessibilityConfigured: false,
        listenerActive: false,
        listenerPorts: [],
        packagedExecutable: false,
        warnings: [],
        processes: []
      };
    }

    const elapsedMs = Math.max(0, timeoutMs - Math.max(0, deadlineMs - now()));
    const readiness = evaluateLaunchReadiness(
      currentProfileSummary,
      contractSummary,
      result.readiness.previousRunningPids
    );

    lastProfileSummary = currentProfileSummary;
    result.postLaunchProfile = currentProfileSummary;
    result.readiness.pollCount += 1;
    result.readiness.durationMs = elapsedMs;
    result.readiness.finalRunningPids = Array.isArray(currentProfileSummary?.runningPids) ? currentProfileSummary.runningPids.slice() : [];
    result.readiness.newRunningPids = readiness.newRunningPids.slice();
    result.readiness.mismatchReason = readiness.mismatchReason;

    if (result.samples.length < 12) {
      result.samples.push(summarizeProfilePoll(currentProfileSummary, elapsedMs));
    }

    if (readiness.success) {
      result.status = 'automation-ready';
      result.success = true;
      Object.assign(result, buildResultStatusDetails(result.status));
      if (readiness.newRunningPids.length === 0 && result.readiness.previousRunningPids.length > 0) {
        result.warnings.push('TradingView became automation-ready, but no new TradingView PID was observed. The wrapper may have reused an existing session.');
      }
      result.readiness.completedAt = new Date(now()).toISOString();
      return result;
    }

    if (currentProfileSummary?.automationReady === true && readiness.mismatchReason) {
      sawContractMismatch = true;
    }

    const remainingMs = deadlineMs - now();
    if (remainingMs <= 0) {
      break;
    }
    await sleepFn(Math.min(pollIntervalMs, remainingMs));
  }

  result.postLaunchProfile = lastProfileSummary;
  result.readiness.finalRunningPids = Array.isArray(lastProfileSummary?.runningPids) ? lastProfileSummary.runningPids.slice() : [];
  const previousRunningPidSet = new Set(result.readiness.previousRunningPids);
  result.readiness.newRunningPids = result.readiness.finalRunningPids.filter((pid) => !previousRunningPidSet.has(pid));
  result.readiness.durationMs = timeoutMs;
  result.readiness.completedAt = new Date(now()).toISOString();
  result.status = sawContractMismatch ? 'contract-mismatch' : 'timeout';
  Object.assign(result, buildResultStatusDetails(result.status));
  result.wrapperStatus = readTradingViewAutomationWrapperStatus(wrapperStatusFile) || result.wrapperStatus;
  return result;
}

module.exports = {
  DEFAULT_TRADINGVIEW_AUTOMATION_RELAUNCH_TIMEOUT_MS,
  DEFAULT_TRADINGVIEW_AUTOMATION_RELAUNCH_POLL_INTERVAL_MS,
  DEFAULT_TRADINGVIEW_AUTOMATION_RELAUNCH_STARTUP_DELAY_MS,
  buildTradingViewAutomationLaunchSpawnSpec,
  attemptTradingViewAutomationRelaunch,
  summarizeTradingViewAutomationRelaunch
};
