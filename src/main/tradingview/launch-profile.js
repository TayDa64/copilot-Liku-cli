const fs = require('fs');
const net = require('net');
const path = require('path');

const { executePowerShellScript } = require('../ui-automation/core/powershell');

const DEFAULT_TRADINGVIEW_CDP_PORT = 9222;
const DEFAULT_TRADINGVIEW_PROCESS_NAMES = Object.freeze(['TradingView', 'TradingView.exe']);
const DEFAULT_LAUNCH_PROFILE_TIMEOUT_MS = 2500;

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

function normalizePort(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const normalized = Math.round(numeric);
  return normalized >= 1 && normalized <= 65535 ? normalized : 0;
}

function normalizeProcessName(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\.exe$/i, '');
}

function parseCommandLineExecutablePath(commandLine = '') {
  const text = String(commandLine || '').trim();
  if (!text) return '';
  if (text.startsWith('"')) {
    const closing = text.indexOf('"', 1);
    return closing > 1 ? text.slice(1, closing) : '';
  }
  const firstToken = text.split(/\s+/, 1)[0];
  return String(firstToken || '').trim();
}

function parseRemoteDebuggingPortsFromCommandLine(commandLine = '') {
  const text = String(commandLine || '');
  const ports = [];
  const seen = new Set();
  for (const match of text.matchAll(/--remote-debugging-port(?:=|\s+)(\d+)/gi)) {
    const port = normalizePort(match?.[1]);
    if (!port || seen.has(port)) continue;
    seen.add(port);
    ports.push(port);
  }
  return ports;
}

function hasRendererAccessibilityFlag(commandLine = '') {
  return /--(?:force|enable)-renderer-accessibility\b/i.test(String(commandLine || ''));
}

function summarizeTradingViewProcess(entry = {}) {
  const commandLine = String(entry?.commandLine || '');
  const executablePath = parseCommandLineExecutablePath(commandLine);
  return {
    pid: Number(entry?.pid || entry?.ProcessId || 0) || 0,
    parentPid: Number(entry?.parentPid || entry?.ParentProcessId || 0) || 0,
    name: String(entry?.name || entry?.Name || ''),
    mainWindowTitle: String(entry?.mainWindowTitle || entry?.MainWindowTitle || ''),
    commandLine,
    executablePath,
    packagedExecutable: /\\windowsapps\\tradingview\.desktop_/i.test(executablePath),
    remoteDebuggingPorts: parseRemoteDebuggingPortsFromCommandLine(commandLine),
    rendererAccessibilityConfigured: hasRendererAccessibilityFlag(commandLine)
  };
}

function summarizeListenerEntry(entry = {}) {
  return {
    pid: Number(entry?.pid || entry?.OwningProcess || 0) || 0,
    port: normalizePort(entry?.port || entry?.LocalPort),
    address: String(entry?.address || entry?.LocalAddress || '').trim()
  };
}

async function probeTcpPortsReachable(ports = [], timeoutMs = 400) {
  const reachable = [];
  await Promise.all(
    ports.map((port) =>
      new Promise((resolve) => {
        const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
          socket.destroy();
          reachable.push(port);
          resolve();
        });
        socket.setTimeout(Math.max(100, timeoutMs));
        socket.on('error', resolve);
        socket.on('timeout', () => {
          socket.destroy();
          resolve();
        });
      })
    )
  );
  return reachable;
}

function buildDefaultDevToolsActivePortPaths() {
  const localAppData = String(process.env.LOCALAPPDATA || '').trim();
  const appData = String(process.env.APPDATA || '').trim();
  return [
    localAppData
      ? path.join(localAppData, 'Packages', 'TradingView.Desktop_n534cwy3pjxzj', 'LocalCache', 'Roaming', 'TradingView', 'DevToolsActivePort')
      : '',
    appData
      ? path.join(appData, 'TradingView', 'DevToolsActivePort')
      : ''
  ].filter(Boolean);
}

function readTradingViewDevToolsActivePort(paths = []) {
  for (const candidatePath of Array.isArray(paths) ? paths : [paths]) {
    const filePath = String(candidatePath || '').trim();
    if (!filePath || !fs.existsSync(filePath)) {
      continue;
    }

    try {
      const stat = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = String(content || '').split(/\r?\n/);
      return {
        exists: true,
        path: filePath,
        port: normalizePort(lines[0]),
        browserEndpoint: String(lines[1] || '').trim(),
        lastModifiedMs: stat.mtimeMs || 0,
        ageMs: stat.mtimeMs ? Math.max(0, Date.now() - stat.mtimeMs) : null
      };
    } catch (error) {
      return {
        exists: true,
        path: filePath,
        port: 0,
        browserEndpoint: '',
        lastModifiedMs: 0,
        ageMs: null,
        error: error?.message || String(error || 'Failed to read DevToolsActivePort')
      };
    }
  }

  return {
    exists: false,
    path: '',
    port: 0,
    browserEndpoint: '',
    lastModifiedMs: 0,
    ageMs: null
  };
}

function buildTradingViewLaunchProfileLikelyMeaning(profile = '') {
  switch (String(profile || '').trim().toLowerCase()) {
    case 'automation-ready':
      return 'TradingView is running with a live remote debugging endpoint, so Chromium/CDP Pine proof is available.';
    case 'cdp-configured-endpoint-missing':
      return 'TradingView command lines expose a remote debugging port, but no live listener was detected on that port.';
    case 'interactive-no-cdp':
      return 'TradingView is running in the normal interactive launch profile. No process command line exposes --remote-debugging-port, so Pine renderer proof is unavailable.';
    case 'not-running':
      return 'TradingView is not running.';
    default:
      return 'TradingView launch profile could not be determined.';
  }
}

function classifyTradingViewLaunchProfile(snapshot = {}) {
  const expectedCdpPort = normalizePort(snapshot?.expectedCdpPort || DEFAULT_TRADINGVIEW_CDP_PORT) || DEFAULT_TRADINGVIEW_CDP_PORT;
  const processes = (Array.isArray(snapshot?.processes) ? snapshot.processes : [])
    .map(summarizeTradingViewProcess)
    .filter((entry) => normalizeProcessName(entry?.name || '') === 'tradingview');
  const listeners = (Array.isArray(snapshot?.listeners) ? snapshot.listeners : [])
    .map(summarizeListenerEntry)
    .filter((entry) => entry.port > 0);
  const listenerPorts = Array.from(new Set(listeners.map((entry) => entry.port).filter((port) => port > 0)));
  const remoteDebuggingPorts = Array.from(new Set(processes.flatMap((entry) => entry.remoteDebuggingPorts).filter((port) => port > 0)));
  const rendererAccessibilityConfigured = processes.some((entry) => entry.rendererAccessibilityConfigured === true);
  const packagedExecutable = processes.some((entry) => entry.packagedExecutable === true);
  const running = processes.length > 0;
  const activeConfiguredPort = remoteDebuggingPorts.find((port) => listenerPorts.includes(port)) || 0;
  const activeExpectedPort = expectedCdpPort && listenerPorts.includes(expectedCdpPort) ? expectedCdpPort : 0;
  const devToolsActivePort = snapshot?.devToolsActivePort && typeof snapshot.devToolsActivePort === 'object'
    ? {
        exists: snapshot.devToolsActivePort.exists === true,
        path: String(snapshot.devToolsActivePort.path || ''),
        port: normalizePort(snapshot.devToolsActivePort.port),
        browserEndpoint: String(snapshot.devToolsActivePort.browserEndpoint || ''),
        lastModifiedMs: Number(snapshot.devToolsActivePort.lastModifiedMs || 0) || 0,
        ageMs: Number.isFinite(Number(snapshot.devToolsActivePort.ageMs)) ? Number(snapshot.devToolsActivePort.ageMs) : null,
        error: String(snapshot.devToolsActivePort.error || '')
      }
    : {
        exists: false,
        path: '',
        port: 0,
        browserEndpoint: '',
        lastModifiedMs: 0,
        ageMs: null,
        error: ''
      };

  let profile = 'not-running';
  let reason = 'not-running';
  let automationReady = false;
  let effectivePort = 0;

  if (running) {
    if (activeConfiguredPort > 0 || activeExpectedPort > 0) {
      profile = 'automation-ready';
      reason = null;
      automationReady = true;
      effectivePort = activeConfiguredPort || activeExpectedPort;
    } else if (remoteDebuggingPorts.length > 0) {
      profile = 'cdp-configured-endpoint-missing';
      reason = 'remote-debugging-endpoint-missing';
      effectivePort = remoteDebuggingPorts[0];
    } else {
      profile = 'interactive-no-cdp';
      reason = 'remote-debugging-port-not-configured';
    }
  }

  const warnings = [];
  if (devToolsActivePort.exists && devToolsActivePort.port > 0 && !listenerPorts.includes(devToolsActivePort.port)) {
    warnings.push(`Stale DevToolsActivePort marker still points at ${devToolsActivePort.port}, but no live listener is active on that port.`);
  }
  if (profile === 'automation-ready' && rendererAccessibilityConfigured !== true) {
    warnings.push('Remote debugging is active, but renderer accessibility was not visible in the current TradingView command lines.');
  }

  return {
    inspectionAvailable: true,
    running,
    profile,
    automationReady,
    reason,
    likelyMeaning: buildTradingViewLaunchProfileLikelyMeaning(profile),
    expectedCdpPort,
    effectivePort,
    processCount: processes.length,
    runningPids: processes.map((entry) => entry.pid).filter((pid) => pid > 0),
    remoteDebuggingConfigured: remoteDebuggingPorts.length > 0,
    remoteDebuggingPorts,
    rendererAccessibilityConfigured,
    listenerActive: listenerPorts.length > 0,
    listenerPorts,
    packagedExecutable,
    devToolsActivePort,
    warnings,
    processes
  };
}

async function runPowerShellJson(script = '', timeoutMs = DEFAULT_LAUNCH_PROFILE_TIMEOUT_MS, deps = {}) {
  const execute = typeof deps.executePowerShellScript === 'function'
    ? deps.executePowerShellScript
    : executePowerShellScript;
  const result = await execute(script, timeoutMs);
  if (result?.error) {
    throw new Error(result.error || result.stderr || 'PowerShell execution failed');
  }
  const text = String(result?.stdout || '').trim();
  if (!text) return null;
  return parseJsonPayload(text);
}

async function detectTradingViewLaunchProfile(options = {}) {
  if (process.platform !== 'win32') {
    return {
      inspectionAvailable: false,
      running: false,
      profile: 'platform-unsupported',
      automationReady: false,
      reason: 'platform-unsupported',
      likelyMeaning: 'TradingView launch profile inspection is only implemented for Windows.',
      expectedCdpPort: normalizePort(options?.expectedCdpPort || DEFAULT_TRADINGVIEW_CDP_PORT) || DEFAULT_TRADINGVIEW_CDP_PORT,
      effectivePort: 0,
      processCount: 0,
      runningPids: [],
      remoteDebuggingConfigured: false,
      remoteDebuggingPorts: [],
      rendererAccessibilityConfigured: false,
      listenerActive: false,
      listenerPorts: [],
      packagedExecutable: false,
      devToolsActivePort: readTradingViewDevToolsActivePort(options?.devToolsActivePortPaths || buildDefaultDevToolsActivePortPaths()),
      warnings: [],
      processes: []
    };
  }

  const expectedCdpPort = normalizePort(options?.expectedCdpPort || process.env.LIKU_TRADINGVIEW_CDP_PORT || DEFAULT_TRADINGVIEW_CDP_PORT) || DEFAULT_TRADINGVIEW_CDP_PORT;
  const timeoutMs = Math.max(400, Math.min(Number(options?.timeoutMs || DEFAULT_LAUNCH_PROFILE_TIMEOUT_MS) || DEFAULT_LAUNCH_PROFILE_TIMEOUT_MS, 10000));
  const processNames = Array.from(new Set(
    (Array.isArray(options?.processNames) ? options.processNames : DEFAULT_TRADINGVIEW_PROCESS_NAMES)
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  ));

  const quotedNames = processNames
    .map((value) => `'${value.replace(/'/g, "''")}'`)
    .join(', ');

  const processScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$targetNames = @(${quotedNames})
$targetBareNames = @($targetNames | ForEach-Object { $_ -replace '\\.exe$', '' })
$result = @()

$matches = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
  $name = [string]$_.Name
  $bare = $name -replace '\\.exe$', ''
  $targetNames -contains $name -or $targetBareNames -contains $bare
})

foreach ($proc in $matches) {
  $mainWindowTitle = ''
  try {
    $gp = Get-Process -Id ([int]$proc.ProcessId) -ErrorAction Stop
    $mainWindowTitle = [string]$gp.MainWindowTitle
  } catch {}

  $result += [PSCustomObject]@{
    pid = [int]$proc.ProcessId
    parentPid = [int]$proc.ParentProcessId
    name = [string]$proc.Name
    commandLine = [string]$proc.CommandLine
    mainWindowTitle = $mainWindowTitle
  }
}

$result | ConvertTo-Json -Compress -Depth 5
`;

  try {
    const processPayload = await runPowerShellJson(processScript, timeoutMs, {
      executePowerShellScript: options.executePowerShellScript
    });
    const processes = Array.isArray(processPayload)
      ? processPayload
      : (processPayload ? [processPayload] : []);
    const processIds = processes.map((entry) => Number(entry?.pid || 0) || 0).filter((pid) => pid > 0);
    const configuredPorts = Array.from(new Set(
      processes
        .flatMap((entry) => parseRemoteDebuggingPortsFromCommandLine(entry?.commandLine || ''))
        .filter((port) => port > 0)
    ));

    let listeners = [];
    const devToolsActivePort = readTradingViewDevToolsActivePort(options?.devToolsActivePortPaths || buildDefaultDevToolsActivePortPaths());
    if (processIds.length > 0 || configuredPorts.length > 0 || expectedCdpPort > 0) {
      const processIdLiteral = processIds.join(', ');
      const candidatePorts = Array.from(new Set(
        [expectedCdpPort, ...configuredPorts, normalizePort(devToolsActivePort?.port)]
          .map((value) => normalizePort(value))
          .filter((value) => value > 0)
      ));
      const portLiteral = candidatePorts.join(', ');
      const listenerScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$targetIds = @(${processIdLiteral})
$targetPorts = @(${portLiteral})
$rawConnections = @()
$output = @()

if ($targetPorts.Count -gt 0) {
  foreach ($targetPort in $targetPorts) {
    $rawConnections += @(Get-NetTCPConnection -LocalPort $targetPort -ErrorAction SilentlyContinue | Where-Object {
      ([string]$_.State -eq 'Listen' -or [int]$_.State -eq 2) -and ($targetIds.Count -eq 0 -or $targetIds -contains [int]$_.OwningProcess)
    })
  }
} elseif ($targetIds.Count -gt 0) {
  foreach ($targetId in $targetIds) {
    $rawConnections += @(Get-NetTCPConnection -OwningProcess $targetId -ErrorAction SilentlyContinue | Where-Object {
      [string]$_.State -eq 'Listen' -or [int]$_.State -eq 2
    })
  }
}

foreach ($connection in @($rawConnections | Group-Object OwningProcess, LocalPort, LocalAddress | ForEach-Object { $_.Group | Select-Object -First 1 })) {
  $output += [PSCustomObject]@{
    pid = [int]$connection.OwningProcess
    port = [int]$connection.LocalPort
    address = [string]$connection.LocalAddress
  }
}

$output | ConvertTo-Json -Compress -Depth 4
`;
      let psListenerFailed = false;
      const listenerPayload = await runPowerShellJson(listenerScript, timeoutMs, {
        executePowerShellScript: options.executePowerShellScript
      }).catch(() => { psListenerFailed = true; return null; });
      listeners = Array.isArray(listenerPayload)
        ? listenerPayload
        : (listenerPayload ? [listenerPayload] : []);

      // If the PS listener scan failed (e.g. timed out on Windows PS 5.x), fall back to a
      // direct TCP probe. If the port accepts a connection it is listening; we record
      // pid=0 because the PID is unknown from the probe alone. Do NOT probe when PS
      // returned an empty result cleanly — that means no listener was found.
      if (psListenerFailed && listeners.length === 0 && candidatePorts.length > 0) {
        const reachable = await probeTcpPortsReachable(candidatePorts, Math.min(600, timeoutMs));
        if (reachable.length > 0) {
          listeners = reachable.map((port) => ({ pid: 0, port, address: '127.0.0.1' }));
        }
      }
    }

    return classifyTradingViewLaunchProfile({
      expectedCdpPort,
      processes,
      listeners,
      devToolsActivePort
    });
  } catch (error) {
    return {
      inspectionAvailable: false,
      running: false,
      profile: 'inspection-unavailable',
      automationReady: false,
      reason: 'launch-profile-inspection-failed',
      likelyMeaning: 'TradingView launch profile inspection failed before the Pine/CDP preflight could determine whether remote debugging is available.',
      expectedCdpPort,
      effectivePort: 0,
      processCount: 0,
      runningPids: [],
      remoteDebuggingConfigured: false,
      remoteDebuggingPorts: [],
      rendererAccessibilityConfigured: false,
      listenerActive: false,
      listenerPorts: [],
      packagedExecutable: false,
      devToolsActivePort: readTradingViewDevToolsActivePort(options?.devToolsActivePortPaths || buildDefaultDevToolsActivePortPaths()),
      warnings: [],
      processes: [],
      error: error?.message || String(error || 'TradingView launch profile inspection failed')
    };
  }
}

function summarizeTradingViewLaunchProfile(profile = null) {
  if (!profile || typeof profile !== 'object') return null;
  return {
    inspectionAvailable: profile.inspectionAvailable !== false,
    running: profile.running === true,
    profile: String(profile.profile || ''),
    automationReady: profile.automationReady === true,
    reason: profile.reason || null,
    likelyMeaning: profile.likelyMeaning || null,
    expectedCdpPort: normalizePort(profile.expectedCdpPort),
    effectivePort: normalizePort(profile.effectivePort),
    processCount: Number(profile.processCount || 0) || 0,
    runningPids: Array.isArray(profile.runningPids) ? profile.runningPids.slice(0, 12) : [],
    remoteDebuggingConfigured: profile.remoteDebuggingConfigured === true,
    remoteDebuggingPorts: Array.isArray(profile.remoteDebuggingPorts) ? profile.remoteDebuggingPorts.slice(0, 6) : [],
    rendererAccessibilityConfigured: profile.rendererAccessibilityConfigured === true,
    listenerActive: profile.listenerActive === true,
    listenerPorts: Array.isArray(profile.listenerPorts) ? profile.listenerPorts.slice(0, 6) : [],
    packagedExecutable: profile.packagedExecutable === true,
    devToolsActivePort: profile.devToolsActivePort
      ? {
          exists: profile.devToolsActivePort.exists === true,
          path: String(profile.devToolsActivePort.path || ''),
          port: normalizePort(profile.devToolsActivePort.port),
          ageMs: Number.isFinite(Number(profile.devToolsActivePort.ageMs)) ? Number(profile.devToolsActivePort.ageMs) : null
        }
      : null,
    warnings: Array.isArray(profile.warnings) ? profile.warnings.slice(0, 6) : [],
    processes: Array.isArray(profile.processes)
      ? profile.processes.slice(0, 8).map((entry) => ({
          pid: Number(entry?.pid || 0) || 0,
          name: String(entry?.name || ''),
          mainWindowTitle: String(entry?.mainWindowTitle || ''),
          packagedExecutable: entry?.packagedExecutable === true,
          remoteDebuggingPorts: Array.isArray(entry?.remoteDebuggingPorts) ? entry.remoteDebuggingPorts.slice(0, 4) : [],
          rendererAccessibilityConfigured: entry?.rendererAccessibilityConfigured === true
        }))
      : []
  };
}

function scenarioRequiresTradingViewAutomationReadyLaunch(scenarioId = '') {
  const normalized = String(scenarioId || '').trim().toLowerCase();
  return normalized === 'pine-editor' || normalized === 'pine-create-save';
}

function buildTradingViewLaunchProfilePreconditionMessage(profile = null, scenarioId = '') {
  const normalizedScenarioId = String(scenarioId || '').trim() || 'scenario';
  const likelyMeaning = String(profile?.likelyMeaning || '').trim();
  if (likelyMeaning) {
    return `${normalizedScenarioId} requires an automation-ready TradingView launch profile. ${likelyMeaning}`;
  }
  return `${normalizedScenarioId} requires an automation-ready TradingView launch profile.`;
}

module.exports = {
  DEFAULT_TRADINGVIEW_CDP_PORT,
  parseRemoteDebuggingPortsFromCommandLine,
  hasRendererAccessibilityFlag,
  classifyTradingViewLaunchProfile,
  detectTradingViewLaunchProfile,
  summarizeTradingViewLaunchProfile,
  scenarioRequiresTradingViewAutomationReadyLaunch,
  buildTradingViewLaunchProfilePreconditionMessage
};
