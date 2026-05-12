const { executePowerShellScript } = require('./powershell');

const DEFAULT_DISCOVERY_TIMEOUT_MS = 1400;
const DEFAULT_HTTP_TIMEOUT_MS = 600;
const DEFAULT_SESSION_TIMEOUT_MS = 1200;
const DEFAULT_DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 10000;
const chromiumDiscoveryPortCache = new Map();

function clampTimeout(value, fallback, min = MIN_TIMEOUT_MS, max = MAX_TIMEOUT_MS) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < min) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function createTimer(callback, timeoutMs) {
  const timer = setTimeout(callback, timeoutMs);
  if (typeof timer?.unref === 'function') {
    timer.unref();
  }
  return timer;
}

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

function normalizeProcessIds(values = []) {
  const input = Array.isArray(values) ? values : [values];
  const seen = new Set();
  const result = [];

  for (const value of input) {
    const pid = Number(value);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const normalized = Math.round(pid);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function normalizeProcessNames(values = []) {
  const input = Array.isArray(values) ? values : [values];
  const seen = new Set();
  const result = [];

  for (const value of input) {
    const normalized = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/\.exe$/i, '');
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function normalizePort(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const normalized = Math.round(numeric);
  return normalized >= 1 && normalized <= 65535 ? normalized : 0;
}

function buildChromiumDiscoveryCacheKey(kind = '', value = '') {
  const normalizedKind = String(kind || '').trim().toLowerCase();
  const normalizedValue = String(value || '').trim().toLowerCase();
  if (!normalizedKind || !normalizedValue) return '';
  return `${normalizedKind}:${normalizedValue}`;
}

function pruneChromiumDiscoveryPortCache(now = Date.now()) {
  const currentTs = Number(now || Date.now()) || Date.now();
  for (const [key, entry] of chromiumDiscoveryPortCache.entries()) {
    const expiresAt = Number(entry?.expiresAt || 0) || 0;
    if (expiresAt <= 0 || expiresAt <= currentTs) {
      chromiumDiscoveryPortCache.delete(key);
    }
  }
}

function buildChromiumDiscoveryCacheKeys(options = {}) {
  const keys = [];
  const seen = new Set();

  for (const pid of normalizeProcessIds(options.processIds)) {
    const key = buildChromiumDiscoveryCacheKey('pid', pid);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }

  for (const name of normalizeProcessNames(options.processNames)) {
    const key = buildChromiumDiscoveryCacheKey('name', name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }

  return keys;
}

function getCachedChromiumDiscoveryPortCandidates(options = {}) {
  pruneChromiumDiscoveryPortCache();

  const candidates = [];
  const seenPorts = new Set();
  for (const key of buildChromiumDiscoveryCacheKeys(options)) {
    const entry = chromiumDiscoveryPortCache.get(key);
    const port = normalizePort(entry?.port);
    if (!port || seenPorts.has(port)) continue;
    seenPorts.add(port);
    candidates.push({
      port,
      source: 'cached-discovery',
      recordedAt: Number(entry?.recordedAt || 0) || 0
    });
  }

  return candidates;
}

function rememberChromiumDiscoveryPort(options = {}) {
  const port = normalizePort(options.port);
  if (!port) return;

  const now = Date.now();
  const ttlMs = clampTimeout(
    options.ttlMs,
    DEFAULT_DISCOVERY_CACHE_TTL_MS,
    1000,
    24 * 60 * 60 * 1000
  );
  const entry = {
    port,
    recordedAt: now,
    expiresAt: now + ttlMs
  };

  for (const key of buildChromiumDiscoveryCacheKeys(options)) {
    chromiumDiscoveryPortCache.set(key, entry);
  }
}

function clearChromiumRemoteDebuggingDiscoveryCache() {
  chromiumDiscoveryPortCache.clear();
}

function summarizeChromiumTarget(target = null) {
  if (!target || typeof target !== 'object') return null;

  return {
    id: String(target.id || ''),
    type: String(target.type || ''),
    title: String(target.title || ''),
    url: String(target.url || ''),
    attached: target.attached === true,
    webSocketDebuggerUrl: String(target.webSocketDebuggerUrl || '')
  };
}

function escapePowerShellString(value = '') {
  return String(value || '').replace(/'/g, "''");
}

async function runPowerShellJson(script = '', timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS, deps = {}) {
  const execute = typeof deps.executePowerShellScript === 'function'
    ? deps.executePowerShellScript
    : executePowerShellScript;
  const result = await execute(script, clampTimeout(timeoutMs, DEFAULT_DISCOVERY_TIMEOUT_MS));
  if (result?.error) {
    throw new Error(result.error || result.stderr || 'PowerShell execution failed');
  }
  return parseJsonPayload(result?.stdout || '');
}

async function inspectWindowsProcesses(options = {}, deps = {}) {
  const processIds = normalizeProcessIds(options.processIds);
  const processNames = normalizeProcessNames(options.processNames);
  if (!processIds.length && !processNames.length) {
    return {
      success: true,
      processes: []
    };
  }

  const processIdLiteral = processIds.length > 0 ? processIds.join(', ') : '';
  const processExeNameLiteral = processNames.length > 0
    ? processNames
      .map((name) => `'${escapePowerShellString(name.endsWith('.exe') ? name : `${name}.exe`)}'`)
      .join(', ')
    : '';
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$targetIds = @(${processIdLiteral})
$targetExeNames = @(${processExeNameLiteral})
$filtered = @()
$seen = @{}

foreach ($targetId in $targetIds) {
  try {
    $matches = @(Get-CimInstance Win32_Process -Filter ("ProcessId = $targetId") -ErrorAction Stop)
    foreach ($proc in $matches) {
      $pidKey = [string]([int]$proc.ProcessId)
      if (-not $seen.ContainsKey($pidKey)) {
        $seen[$pidKey] = $true
        $filtered += $proc
      }
    }
  } catch {}
}

foreach ($targetExeName in $targetExeNames) {
  if ([string]::IsNullOrWhiteSpace($targetExeName)) { continue }
  try {
    $escapedName = $targetExeName.Replace("'", "''")
    $matches = @(Get-CimInstance Win32_Process -Filter ("Name = '$escapedName'") -ErrorAction Stop)
    foreach ($proc in $matches) {
      $pidKey = [string]([int]$proc.ProcessId)
      if (-not $seen.ContainsKey($pidKey)) {
        $seen[$pidKey] = $true
        $filtered += $proc
      }
    }
  } catch {}
}

$result = @()
foreach ($proc in $filtered) {
  $commandLine = [string]$proc.CommandLine
  $ports = @()
  foreach ($match in [regex]::Matches($commandLine, '--remote-debugging-port(?:=|\\s+)(\\d+)', 'IgnoreCase')) {
    $port = 0
    if ([int]::TryParse($match.Groups[1].Value, [ref]$port) -and $port -gt 0 -and $ports -notcontains $port) {
      $ports += $port
    }
  }

  $result += [PSCustomObject]@{
    pid = [int]$proc.ProcessId
    name = [string]$proc.Name
    commandLine = $commandLine
    ports = @($ports)
  }
}

$result | ConvertTo-Json -Compress -Depth 5
`;

  try {
    const payload = await runPowerShellJson(script, options.timeoutMs, deps);
    const processes = Array.isArray(payload)
      ? payload
      : (payload ? [payload] : []);
    return {
      success: true,
      processes: processes.map((entry) => ({
        pid: Number(entry?.pid || 0) || 0,
        name: String(entry?.name || ''),
        commandLine: String(entry?.commandLine || ''),
        ports: (Array.isArray(entry?.ports) ? entry.ports : [])
          .map((port) => normalizePort(port))
          .filter((port) => port > 0)
      }))
    };
  } catch (error) {
    return {
      success: false,
      error: error?.message || String(error || 'Windows process inspection failed'),
      processes: []
    };
  }
}

async function inspectWindowsListeningPorts(options = {}, deps = {}) {
  const processIds = normalizeProcessIds(options.processIds);
  if (!processIds.length) {
    return {
      success: true,
      listeners: []
    };
  }

  const processIdLiteral = processIds.join(', ');
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$targetIds = @(${processIdLiteral})
$result = @()

foreach ($targetId in $targetIds) {
  try {
    $connections = @(Get-NetTCPConnection -State Listen -OwningProcess $targetId -ErrorAction Stop)
  } catch {
    $connections = @()
  }

  foreach ($connection in $connections) {
    $port = [int]$connection.LocalPort
    if ($port -le 0) { continue }
    $result += [PSCustomObject]@{
      pid = [int]$connection.OwningProcess
      port = $port
      address = [string]$connection.LocalAddress
    }
  }
}

$result | ConvertTo-Json -Compress -Depth 4
`;

  try {
    const payload = await runPowerShellJson(script, options.timeoutMs, deps);
    const listeners = Array.isArray(payload)
      ? payload
      : (payload ? [payload] : []);
    return {
      success: true,
      listeners: listeners.map((entry) => ({
        pid: Number(entry?.pid || 0) || 0,
        port: normalizePort(entry?.port),
        address: String(entry?.address || '')
      }))
    };
  } catch (error) {
    return {
      success: false,
      error: error?.message || String(error || 'Windows listening-port inspection failed'),
      listeners: []
    };
  }
}

async function fetchJson(url, options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function'
    ? options.fetchImpl
    : globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    const error = new Error('Global fetch is unavailable');
    error.code = 'fetch-unavailable';
    throw error;
  }

  const timeoutMs = clampTimeout(options.timeoutMs, DEFAULT_HTTP_TIMEOUT_MS);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller
    ? createTimer(() => controller.abort(), timeoutMs)
    : null;

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        accept: 'application/json'
      },
      signal: controller?.signal
    });

    if (!response || response.ok !== true) {
      const error = new Error(`HTTP ${Number(response?.status || 0) || 'error'} for ${url}`);
      error.code = 'http-error';
      throw error;
    }

    if (typeof response.json === 'function') {
      return await response.json();
    }

    const text = typeof response.text === 'function' ? await response.text() : '';
    return parseJsonPayload(text);
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error(`Request timed out after ${timeoutMs}ms`);
      timeoutError.code = 'timeout';
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function buildPortCandidates(discovery = {}) {
  const seen = new Set();
  const candidates = [];

  const pushPort = (port, source, details = {}) => {
    const normalized = normalizePort(port);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push({
      port: normalized,
      source: String(source || 'unknown'),
      ...details
    });
  };

  const explicitPort = normalizePort(discovery.explicitPort);
  if (explicitPort) {
    pushPort(explicitPort, discovery.explicitSource || 'explicit-port');
  }

  for (const cachedCandidate of Array.isArray(discovery.cachedCandidates) ? discovery.cachedCandidates : []) {
    pushPort(cachedCandidate?.port, cachedCandidate?.source || 'cached-discovery', {
      recordedAt: Number(cachedCandidate?.recordedAt || 0) || 0
    });
  }

  for (const processInfo of Array.isArray(discovery.processes) ? discovery.processes : []) {
    for (const port of Array.isArray(processInfo?.ports) ? processInfo.ports : []) {
      pushPort(port, 'process-command-line', {
        pid: Number(processInfo?.pid || 0) || 0,
        processName: String(processInfo?.name || '')
      });
    }
  }

  for (const listener of Array.isArray(discovery.listeners) ? discovery.listeners : []) {
    const address = String(listener?.address || '').trim().toLowerCase();
    if (
      address
      && !['127.0.0.1', '::1', '0.0.0.0', '::', 'localhost'].includes(address)
    ) {
      continue;
    }
    pushPort(listener?.port, 'process-listening-port', {
      pid: Number(listener?.pid || 0) || 0,
      address
    });
  }

  for (const fallbackCandidate of Array.isArray(discovery.fallbackCandidates) ? discovery.fallbackCandidates : []) {
    pushPort(fallbackCandidate?.port, fallbackCandidate?.source || 'fallback-port', {
      label: String(fallbackCandidate?.label || '')
    });
  }

  return candidates;
}

function deriveChromiumDiscoveryUnavailableReason(discovery = {}) {
  if (discovery?.processInspection?.success === false) {
    return 'remote-debugging-port-discovery-failed';
  }
  if (discovery?.listenerInspection?.success === false) {
    return 'remote-debugging-port-discovery-failed';
  }
  return 'remote-debugging-port-not-configured';
}

function shouldTreatEndpointUnreachableAsPortNotConfigured(discovery = {}) {
  if (normalizePort(discovery?.explicitPort)) {
    return false;
  }

  if (Array.isArray(discovery?.cachedCandidates) && discovery.cachedCandidates.length > 0) {
    return false;
  }

  const portCandidates = Array.isArray(discovery?.portCandidates) ? discovery.portCandidates : [];
  if (!portCandidates.length) {
    return false;
  }
  if (!portCandidates.every((candidate) => String(candidate?.source || '').trim().toLowerCase() === 'fallback-port')) {
    return false;
  }

  if (discovery?.processInspection?.success === false || discovery?.listenerInspection?.success === false) {
    return false;
  }

  const processPortsPresent = Array.isArray(discovery?.processInspection?.processes)
    && discovery.processInspection.processes.some((entry) =>
      Array.isArray(entry?.ports) && entry.ports.some((port) => normalizePort(port) > 0)
    );
  if (processPortsPresent) {
    return false;
  }

  const listenersPresent = Array.isArray(discovery?.listenerInspection?.listeners)
    && discovery.listenerInspection.listeners.some((entry) => normalizePort(entry?.port) > 0);
  if (listenersPresent) {
    return false;
  }

  return true;
}

async function probeRemoteDebuggingEndpointCandidates(portCandidates = [], options = {}) {
  const timeoutMs = clampTimeout(options.timeoutMs, DEFAULT_HTTP_TIMEOUT_MS);
  const attempts = [];

  for (const candidate of Array.isArray(portCandidates) ? portCandidates : []) {
    const port = normalizePort(candidate?.port);
    if (!port) continue;

    try {
      const version = await fetchJson(`http://127.0.0.1:${port}/json/version`, {
        timeoutMs,
        fetchImpl: options.fetchImpl
      });
      const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, {
        timeoutMs,
        fetchImpl: options.fetchImpl
      });

      return {
        success: true,
        port,
        source: candidate?.source || 'unknown',
        version,
        targets: Array.isArray(targets) ? targets : [],
        attempts
      };
    } catch (error) {
      attempts.push({
        port,
        source: candidate?.source || 'unknown',
        error: error?.message || String(error || 'endpoint unreachable')
      });
    }
  }

  return {
    success: false,
    attempts
  };
}

function normalizeTargetText(value = '') {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function scoreChromiumTarget(target = {}, options = {}) {
  const type = normalizeTargetText(target?.type || '');
  const title = normalizeTargetText(target?.title || '');
  const url = normalizeTargetText(target?.url || '');
  const titleHint = normalizeTargetText(options.title || '');
  const titleTokens = Array.isArray(options.titleTokens) ? options.titleTokens : [];
  const urlHints = Array.isArray(options.urlHints) ? options.urlHints : [];
  let relevanceScore = 0;
  let typeScore = 0;

  if (type === 'page') typeScore += 40;
  if (type === 'webview') typeScore += 35;
  if (type === 'iframe') typeScore += 10;

  if (/tradingview/.test(url)) relevanceScore += 120;
  if (/tradingview/.test(title)) relevanceScore += 60;

  if (titleHint) {
    if (title === titleHint) {
      relevanceScore += 80;
    } else if (title.includes(titleHint) || titleHint.includes(title)) {
      relevanceScore += 45;
    }
  }

  for (const token of titleTokens) {
    if (!token || token.length < 2) continue;
    if (title.includes(token)) {
      relevanceScore += 8;
    }
  }

  for (const hint of urlHints) {
    const normalizedHint = normalizeTargetText(hint);
    if (!normalizedHint) continue;
    if (url.includes(normalizedHint)) {
      relevanceScore += 18;
    }
  }

  if (String(target?.webSocketDebuggerUrl || '').trim()) {
    typeScore += 5;
  } else {
    typeScore -= 1000;
  }

  return {
    qualifies: relevanceScore > 0,
    score: relevanceScore + typeScore
  };
}

function selectChromiumTarget(targets = [], options = {}) {
  const allowedTypes = new Set(
    (Array.isArray(options.targetTypes) ? options.targetTypes : ['page', 'webview'])
      .map((value) => normalizeTargetText(value))
      .filter(Boolean)
  );

  const candidates = [];
  for (const target of Array.isArray(targets) ? targets : []) {
    if (!target || typeof target !== 'object') continue;
    const targetType = normalizeTargetText(target?.type || '');
    if (allowedTypes.size > 0 && !allowedTypes.has(targetType)) {
      continue;
    }

    const scored = scoreChromiumTarget(target, options);
    if (!scored.qualifies) continue;
    candidates.push({
      target,
      score: scored.score
    });
  }

  candidates.sort((left, right) => right.score - left.score);
  return candidates[0]?.target || null;
}

async function discoverChromiumRemoteDebuggingTarget(options = {}) {
  const processIds = normalizeProcessIds(options.processIds);
  const processNames = normalizeProcessNames(options.processNames);
  const discoveryTimeoutMs = clampTimeout(
    options.timeoutMs,
    DEFAULT_DISCOVERY_TIMEOUT_MS,
    200,
    6000
  );
  const httpTimeoutMs = clampTimeout(
    options.httpTimeoutMs,
    Math.min(800, Math.max(250, Math.round(discoveryTimeoutMs * 0.45))),
    120,
    3000
  );

  let explicitPort = normalizePort(options.port);
  let explicitSource = explicitPort ? 'explicit-port' : '';
  if (!explicitPort) {
    const envPort = normalizePort(
      process.env.LIKU_TRADINGVIEW_CDP_PORT
      || process.env.LIKU_CHROMIUM_CDP_PORT
      || 0
    );
    if (envPort) {
      explicitPort = envPort;
      explicitSource = 'environment';
    }
  }

  if (!explicitPort && process.platform !== 'win32') {
    return {
      applicable: false,
      available: false,
      reason: 'platform-unsupported',
      port: 0,
      target: null,
      targets: [],
      endpointAttempts: []
    };
  }

  const cachedCandidates = explicitPort
    ? []
    : getCachedChromiumDiscoveryPortCandidates({
        processIds,
        processNames
      });
  const fallbackCandidates = explicitPort
    ? []
    : (Array.isArray(options.fallbackPorts) ? options.fallbackPorts : [options.fallbackPorts])
      .map((port) => normalizePort(port))
      .filter((port) => port > 0)
      .map((port) => ({
        port,
        source: 'fallback-port',
        label: String(options.fallbackPortLabel || '').trim()
      }));

  let processInspection = { success: true, processes: [] };
  if (!explicitPort) {
    if (typeof options.processInspector === 'function') {
      const inspected = await options.processInspector({
        processIds,
        processNames,
        timeoutMs: Math.max(220, Math.min(1200, discoveryTimeoutMs))
      });
      processInspection = Array.isArray(inspected)
        ? { success: true, processes: inspected }
        : {
            success: inspected?.success !== false,
            processes: Array.isArray(inspected?.processes) ? inspected.processes : [],
            error: inspected?.error || null
          };
    } else {
      processInspection = await inspectWindowsProcesses({
        processIds,
        processNames,
        timeoutMs: Math.max(220, Math.min(1200, discoveryTimeoutMs))
      }, {
        executePowerShellScript: options.executePowerShellScript
      });
    }
  }

  let listenerInspection = { success: true, listeners: [] };
  if (!explicitPort && processInspection?.processes?.length > 0) {
    const inspectedProcessIds = normalizeProcessIds(
      processInspection.processes.map((entry) => entry?.pid)
    );
    if (typeof options.listeningPortInspector === 'function') {
      const inspected = await options.listeningPortInspector({
        processIds: inspectedProcessIds,
        timeoutMs: Math.max(200, Math.min(1200, Math.round(discoveryTimeoutMs * 0.5)))
      });
      listenerInspection = Array.isArray(inspected)
        ? { success: true, listeners: inspected }
        : {
            success: inspected?.success !== false,
            listeners: Array.isArray(inspected?.listeners) ? inspected.listeners : [],
            error: inspected?.error || null
          };
    } else {
      listenerInspection = await inspectWindowsListeningPorts({
        processIds: inspectedProcessIds,
        timeoutMs: Math.max(200, Math.min(1200, Math.round(discoveryTimeoutMs * 0.5)))
      }, {
        executePowerShellScript: options.executePowerShellScript
      });
    }
  }

  const portCandidates = buildPortCandidates({
    explicitPort,
    explicitSource,
    cachedCandidates,
    fallbackCandidates,
    processes: processInspection?.processes || [],
    listeners: listenerInspection?.listeners || []
  });

  if (!portCandidates.length) {
    const reason = deriveChromiumDiscoveryUnavailableReason({
      explicitPort,
      processInspection,
      listenerInspection
    });
    return {
      applicable: true,
      available: false,
      reason,
      port: 0,
      target: null,
      targets: [],
      endpointAttempts: [],
      discovery: {
        explicitPort,
        cachedCandidates,
        fallbackCandidates,
        processInspection,
        listenerInspection,
        portCandidates
      }
    };
  }

  if (typeof (options.WebSocketCtor || globalThis.WebSocket) !== 'function') {
    return {
      applicable: true,
      available: false,
      reason: 'websocket-unavailable',
      port: Number(portCandidates[0]?.port || 0) || 0,
      target: null,
      targets: [],
      endpointAttempts: [],
      discovery: {
        explicitPort,
        cachedCandidates,
        fallbackCandidates,
        processInspection,
        listenerInspection,
        portCandidates
      }
    };
  }

  const endpointProbe = await probeRemoteDebuggingEndpointCandidates(portCandidates, {
    timeoutMs: httpTimeoutMs,
    fetchImpl: options.fetchImpl
  });
  if (!endpointProbe?.success) {
    const endpointFailureReason = shouldTreatEndpointUnreachableAsPortNotConfigured({
      explicitPort,
      cachedCandidates,
      processInspection,
      listenerInspection,
      portCandidates
    })
      ? 'remote-debugging-port-not-configured'
      : 'endpoint-unreachable';
    return {
      applicable: true,
      available: false,
      reason: endpointFailureReason,
      port: Number(portCandidates[0]?.port || 0) || 0,
      target: null,
      targets: [],
      endpointAttempts: Array.isArray(endpointProbe?.attempts) ? endpointProbe.attempts : [],
      discovery: {
        explicitPort,
        cachedCandidates,
        fallbackCandidates,
        processInspection,
        listenerInspection,
        portCandidates
      }
    };
  }

  const selectedTarget = selectChromiumTarget(endpointProbe.targets, {
    targetTypes: options.targetTypes,
    title: options.title || '',
    titleTokens: Array.isArray(options.titleTokens) ? options.titleTokens : [],
    urlHints: Array.isArray(options.urlHints) ? options.urlHints : []
  });
  const summarizedTargets = (Array.isArray(endpointProbe.targets) ? endpointProbe.targets : [])
    .map(summarizeChromiumTarget)
    .filter(Boolean)
    .slice(0, 12);

  if (!selectedTarget) {
    return {
      applicable: true,
      available: false,
      reason: 'target-not-found',
      port: Number(endpointProbe.port || 0) || 0,
      target: null,
      targets: summarizedTargets,
      endpointAttempts: Array.isArray(endpointProbe.attempts) ? endpointProbe.attempts : [],
      discovery: {
        explicitPort,
        cachedCandidates,
        fallbackCandidates,
        processInspection,
        listenerInspection,
        portCandidates
      }
    };
  }

  rememberChromiumDiscoveryPort({
    port: endpointProbe.port,
    processIds: [
      ...processIds,
      ...normalizeProcessIds((processInspection?.processes || []).map((entry) => entry?.pid))
    ],
    processNames: [
      ...processNames,
      ...normalizeProcessNames((processInspection?.processes || []).map((entry) => entry?.name))
    ]
  });

  return {
    applicable: true,
    available: true,
    reason: null,
    port: Number(endpointProbe.port || 0) || 0,
    target: summarizeChromiumTarget(selectedTarget),
    targets: summarizedTargets,
    version: endpointProbe.version || null,
    endpointAttempts: Array.isArray(endpointProbe.attempts) ? endpointProbe.attempts : [],
    discovery: {
      explicitPort,
      cachedCandidates,
      fallbackCandidates,
      processInspection,
      listenerInspection,
      portCandidates
    }
  };
}

function bindSocketHandler(socket, eventName, handler) {
  if (typeof socket?.addEventListener === 'function') {
    socket.addEventListener(eventName, handler);
    return;
  }
  socket[`on${eventName}`] = handler;
}

function extractMessageData(event = null) {
  if (event === null || event === undefined) return '';
  if (typeof event === 'string') return event;
  if (typeof event?.data === 'string') return event.data;
  if (Buffer.isBuffer(event?.data)) return event.data.toString('utf8');
  if (Buffer.isBuffer(event)) return event.toString('utf8');
  return String(event?.data || event || '');
}

async function withChromiumCdpSession(target = {}, options = {}, fn) {
  const WebSocketCtor = options.WebSocketCtor || globalThis.WebSocket;
  if (typeof WebSocketCtor !== 'function') {
    const error = new Error('Global WebSocket is unavailable');
    error.reason = 'websocket-unavailable';
    throw error;
  }

  const webSocketUrl = String(target?.webSocketDebuggerUrl || '').trim();
  if (!webSocketUrl) {
    const error = new Error('Target does not expose a webSocketDebuggerUrl');
    error.reason = 'target-not-found';
    throw error;
  }

  const openTimeoutMs = clampTimeout(options.openTimeoutMs, DEFAULT_SESSION_TIMEOUT_MS, 120, 4000);
  const callTimeoutMs = clampTimeout(options.callTimeoutMs, Math.min(900, openTimeoutMs), 120, 5000);

  return await new Promise((resolve, reject) => {
    let settled = false;
    let closed = false;
    let nextMessageId = 0;
    const socket = new WebSocketCtor(webSocketUrl);
    const pending = new Map();

    const clearPending = (error) => {
      for (const entry of pending.values()) {
        if (entry?.timer) {
          clearTimeout(entry.timer);
        }
        entry?.reject(error);
      }
      pending.clear();
    };

    const finish = (factory, value) => {
      if (settled) return;
      settled = true;
      if (openTimer) {
        clearTimeout(openTimer);
      }
      clearPending(value instanceof Error ? value : new Error('CDP session closed'));
      try {
        if (!closed && typeof socket?.close === 'function') {
          closed = true;
          socket.close();
        }
      } catch {}
      factory(value);
    };

    const openTimer = createTimer(() => {
      const error = new Error(`CDP WebSocket open timed out after ${openTimeoutMs}ms`);
      error.reason = 'protocol-error';
      finish(reject, error);
    }, openTimeoutMs);

    bindSocketHandler(socket, 'open', async () => {
      try {
        const session = {
          async call(method, params = {}, callOptions = {}) {
            if (settled) {
              throw new Error('CDP session is already closed');
            }

            const id = ++nextMessageId;
            const effectiveTimeoutMs = clampTimeout(
              callOptions.timeoutMs,
              callTimeoutMs,
              120,
              8000
            );

            const response = await new Promise((resolveCall, rejectCall) => {
              const timer = createTimer(() => {
                pending.delete(id);
                const timeoutError = new Error(`CDP ${method} timed out after ${effectiveTimeoutMs}ms`);
                timeoutError.reason = 'protocol-error';
                rejectCall(timeoutError);
              }, effectiveTimeoutMs);

              pending.set(id, {
                resolve: resolveCall,
                reject: rejectCall,
                timer
              });

              socket.send(JSON.stringify({
                id,
                method,
                params
              }));
            });

            if (response?.error) {
              const protocolError = new Error(response.error?.message || `${method} failed`);
              protocolError.reason = 'protocol-error';
              throw protocolError;
            }

            return response?.result || null;
          }
        };

        const value = await fn(session);
        finish(resolve, value);
      } catch (error) {
        if (!error?.reason) {
          error.reason = 'protocol-error';
        }
        finish(reject, error);
      }
    });

    bindSocketHandler(socket, 'message', (event) => {
      const raw = extractMessageData(event);
      if (!raw) return;

      let message = null;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }

      if (!Number.isFinite(Number(message?.id))) {
        return;
      }

      const pendingEntry = pending.get(Number(message.id));
      if (!pendingEntry) return;
      pending.delete(Number(message.id));
      if (pendingEntry.timer) {
        clearTimeout(pendingEntry.timer);
      }
      pendingEntry.resolve(message);
    });

    bindSocketHandler(socket, 'error', () => {
      const error = new Error('CDP WebSocket transport error');
      error.reason = 'protocol-error';
      finish(reject, error);
    });

    bindSocketHandler(socket, 'close', () => {
      closed = true;
      if (!settled) {
        const error = new Error('CDP WebSocket closed before the session completed');
        error.reason = 'protocol-error';
        finish(reject, error);
      }
    });
  });
}

module.exports = {
  clearChromiumRemoteDebuggingDiscoveryCache,
  discoverChromiumRemoteDebuggingTarget,
  withChromiumCdpSession
};
