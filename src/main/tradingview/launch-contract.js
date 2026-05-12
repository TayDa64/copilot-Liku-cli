const fs = require('fs');
const path = require('path');

const {
  DEFAULT_TRADINGVIEW_CDP_PORT,
  buildTradingViewLaunchProfilePreconditionMessage
} = require('./launch-profile');

const DEFAULT_TRADINGVIEW_AUTOMATION_LAUNCH_DISPLAY_NAME = 'TradingView automation wrapper';
const DEFAULT_TRADINGVIEW_AUTOMATION_LAUNCH_KIND = 'command';
const DEFAULT_TRADINGVIEW_AUTOMATION_LAUNCH_PROCESS_NAMES = Object.freeze(['TradingView', 'TradingView.exe']);

const ENV_AUTOMATION_LAUNCH_CONTRACT = 'LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_CONTRACT';
const ENV_AUTOMATION_LAUNCH_CONTRACT_FILE = 'LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_CONTRACT_FILE';
const ENV_AUTOMATION_LAUNCH_KIND = 'LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_KIND';
const ENV_AUTOMATION_LAUNCH_DISPLAY_NAME = 'LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_DISPLAY_NAME';
const ENV_AUTOMATION_LAUNCH_COMMAND = 'LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_COMMAND';
const ENV_AUTOMATION_LAUNCH_ARGS = 'LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_ARGS';
const ENV_AUTOMATION_LAUNCH_WORKDIR = 'LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_WORKDIR';
const ENV_AUTOMATION_LAUNCH_PROCESS_NAMES = 'LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_PROCESS_NAMES';
const ENV_AUTOMATION_LAUNCH_RENDERER_ACCESSIBILITY = 'LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_RENDERER_ACCESSIBILITY';
const ENV_AUTOMATION_LAUNCH_CDP_PORT = 'LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_CDP_PORT';

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

function quoteSegment(value = '') {
  const text = String(value || '');
  if (!text) return '""';
  if (!/[\s"]/u.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

function buildInvocationPreview(command = '', args = []) {
  const segments = [normalizeString(command), ...(Array.isArray(args) ? args : [])]
    .map((entry) => quoteSegment(entry))
    .filter(Boolean);
  return segments.join(' ');
}

function expandWindowsEnvVars(value = '', env = process.env) {
  return String(value || '').replace(/%([^%]+)%/g, (_, name) => {
    const key = String(name || '').trim();
    return Object.prototype.hasOwnProperty.call(env || {}, key) ? String(env[key] || '') : `%${key}%`;
  });
}

function looksLikeFilesystemPath(value = '') {
  const normalized = normalizeString(value);
  if (!normalized) return false;
  return /[\\/]/.test(normalized)
    || /^[A-Za-z]:/.test(normalized)
    || /^\./.test(normalized);
}

function resolvePathLikeValue(value = '', options = {}) {
  const normalizedValue = normalizeString(expandWindowsEnvVars(value, options.env));
  if (!normalizedValue) return '';
  if (!looksLikeFilesystemPath(normalizedValue)) {
    return normalizedValue;
  }

  const workdir = normalizeString(expandWindowsEnvVars(options.workdir, options.env));
  if (path.isAbsolute(normalizedValue)) {
    return path.normalize(normalizedValue);
  }
  if (workdir) {
    return path.resolve(workdir, normalizedValue);
  }
  return path.resolve(options.cwd || process.cwd(), normalizedValue);
}

function normalizeStringArray(values = [], options = {}) {
  const input = Array.isArray(values) ? values : [values];
  const allowEmpty = options.allowEmpty === true;
  const dedupe = options.dedupe !== false;
  const seen = new Set();
  const result = [];

  for (const value of input) {
    const normalized = normalizeString(value);
    if (!allowEmpty && !normalized) continue;
    const key = options.caseInsensitive === true ? normalized.toLowerCase() : normalized;
    if (dedupe && seen.has(key)) continue;
    if (dedupe) seen.add(key);
    result.push(normalized);
  }

  return result;
}

function parseArgsValue(value) {
  if (Array.isArray(value)) {
    return normalizeStringArray(value);
  }
  const normalized = normalizeString(value);
  if (!normalized) return [];

  let parsed = null;
  try {
    parsed = parseJsonPayload(normalized);
  } catch {
    throw new Error(`${ENV_AUTOMATION_LAUNCH_ARGS} must be a JSON array of strings.`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${ENV_AUTOMATION_LAUNCH_ARGS} must be a JSON array of strings.`);
  }
  return normalizeStringArray(parsed);
}

function parseProcessNamesValue(value) {
  if (Array.isArray(value)) {
    return normalizeStringArray(value);
  }
  const normalized = normalizeString(value);
  if (!normalized) return [];

  if (normalized.startsWith('[')) {
    const parsed = parseJsonPayload(normalized);
    if (!Array.isArray(parsed)) {
      throw new Error(`${ENV_AUTOMATION_LAUNCH_PROCESS_NAMES} must be a JSON array or a comma-separated string.`);
    }
    return normalizeStringArray(parsed);
  }

  return normalizeStringArray(
    normalized
      .split(/[,\r\n;]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

function buildNotConfiguredContract() {
  return {
    inspectionAvailable: true,
    status: 'not-configured',
    configured: false,
    valid: false,
    source: null,
    kind: DEFAULT_TRADINGVIEW_AUTOMATION_LAUNCH_KIND,
    displayName: DEFAULT_TRADINGVIEW_AUTOMATION_LAUNCH_DISPLAY_NAME,
    command: '',
    resolvedCommand: '',
    args: [],
    workdir: '',
    resolvedWorkdir: '',
    invocationPreview: '',
    expected: {
      cdpPort: DEFAULT_TRADINGVIEW_CDP_PORT,
      rendererAccessibility: true,
      processNames: [...DEFAULT_TRADINGVIEW_AUTOMATION_LAUNCH_PROCESS_NAMES]
    },
    likelyMeaning: 'No explicit TradingView automation launcher/wrapper contract is configured.',
    recommendedNextStep: `Set ${ENV_AUTOMATION_LAUNCH_CONTRACT}, ${ENV_AUTOMATION_LAUNCH_CONTRACT_FILE}, or ${ENV_AUTOMATION_LAUNCH_COMMAND} to define an automation-ready TradingView wrapper command.`,
    warnings: [],
    error: null
  };
}

function buildInvalidContract(base = {}, errorMessage = '', warnings = []) {
  const normalizedBase = base && typeof base === 'object' ? base : {};
  const message = normalizeString(errorMessage) || 'TradingView automation launch contract validation failed.';
  const expected = normalizedBase.expected && typeof normalizedBase.expected === 'object'
    ? normalizedBase.expected
    : {
        cdpPort: DEFAULT_TRADINGVIEW_CDP_PORT,
        rendererAccessibility: true,
        processNames: [...DEFAULT_TRADINGVIEW_AUTOMATION_LAUNCH_PROCESS_NAMES]
      };

  return {
    inspectionAvailable: true,
    status: 'invalid',
    configured: false,
    valid: false,
    source: normalizedBase.source || null,
    kind: normalizeString(normalizedBase.kind || DEFAULT_TRADINGVIEW_AUTOMATION_LAUNCH_KIND) || DEFAULT_TRADINGVIEW_AUTOMATION_LAUNCH_KIND,
    displayName: normalizeString(normalizedBase.displayName || DEFAULT_TRADINGVIEW_AUTOMATION_LAUNCH_DISPLAY_NAME) || DEFAULT_TRADINGVIEW_AUTOMATION_LAUNCH_DISPLAY_NAME,
    command: normalizeString(normalizedBase.command),
    resolvedCommand: normalizeString(normalizedBase.resolvedCommand),
    args: Array.isArray(normalizedBase.args) ? normalizedBase.args.slice(0, 24) : [],
    workdir: normalizeString(normalizedBase.workdir),
    resolvedWorkdir: normalizeString(normalizedBase.resolvedWorkdir),
    invocationPreview: normalizeString(normalizedBase.invocationPreview),
    expected: {
      cdpPort: normalizePort(expected.cdpPort, DEFAULT_TRADINGVIEW_CDP_PORT),
      rendererAccessibility: normalizeBoolean(expected.rendererAccessibility, true),
      processNames: normalizeStringArray(expected.processNames || DEFAULT_TRADINGVIEW_AUTOMATION_LAUNCH_PROCESS_NAMES)
    },
    likelyMeaning: 'A TradingView automation launcher/wrapper contract was configured, but it failed validation.',
    recommendedNextStep: 'Fix the TradingView automation launcher/wrapper contract before rerunning Pine/CDP scenarios.',
    warnings: normalizeStringArray(warnings),
    error: message
  };
}

function buildConfiguredContract(base = {}, warnings = []) {
  const expected = base.expected && typeof base.expected === 'object'
    ? base.expected
    : {
        cdpPort: DEFAULT_TRADINGVIEW_CDP_PORT,
        rendererAccessibility: true,
        processNames: [...DEFAULT_TRADINGVIEW_AUTOMATION_LAUNCH_PROCESS_NAMES]
      };

  return {
    inspectionAvailable: true,
    status: 'configured',
    configured: true,
    valid: true,
    source: base.source || null,
    kind: normalizeString(base.kind || DEFAULT_TRADINGVIEW_AUTOMATION_LAUNCH_KIND) || DEFAULT_TRADINGVIEW_AUTOMATION_LAUNCH_KIND,
    displayName: normalizeString(base.displayName || DEFAULT_TRADINGVIEW_AUTOMATION_LAUNCH_DISPLAY_NAME) || DEFAULT_TRADINGVIEW_AUTOMATION_LAUNCH_DISPLAY_NAME,
    command: normalizeString(base.command),
    resolvedCommand: normalizeString(base.resolvedCommand),
    args: Array.isArray(base.args) ? base.args.slice(0, 64) : [],
    workdir: normalizeString(base.workdir),
    resolvedWorkdir: normalizeString(base.resolvedWorkdir),
    invocationPreview: normalizeString(base.invocationPreview),
    expected: {
      cdpPort: normalizePort(expected.cdpPort, DEFAULT_TRADINGVIEW_CDP_PORT),
      rendererAccessibility: normalizeBoolean(expected.rendererAccessibility, true),
      processNames: normalizeStringArray(expected.processNames || DEFAULT_TRADINGVIEW_AUTOMATION_LAUNCH_PROCESS_NAMES)
    },
    likelyMeaning: 'A TradingView automation launcher/wrapper contract is configured and can be used to relaunch TradingView into the automation-ready profile.',
    recommendedNextStep: 'Relaunch TradingView through the configured launcher/wrapper contract, then rerun the Pine/CDP scenario.',
    warnings: normalizeStringArray(warnings),
    error: null
  };
}

function getConfiguredContractSource(options = {}) {
  const env = options.env || process.env;
  if (options.contract && typeof options.contract === 'object') {
    return {
      source: 'provided-object',
      rawContract: options.contract
    };
  }

  const inlineJson = normalizeString(env?.[ENV_AUTOMATION_LAUNCH_CONTRACT]);
  if (inlineJson) {
    return {
      source: 'env-inline-json',
      rawContract: parseJsonPayload(inlineJson)
    };
  }

  const contractFilePath = normalizeString(env?.[ENV_AUTOMATION_LAUNCH_CONTRACT_FILE]);
  if (contractFilePath) {
    const resolvedContractFilePath = resolvePathLikeValue(contractFilePath, {
      env,
      cwd: options.cwd
    });
    if (!resolvedContractFilePath || !fs.existsSync(resolvedContractFilePath)) {
      throw new Error(`TradingView automation launch contract file was not found: ${resolvedContractFilePath || contractFilePath}`);
    }

    const rawText = fs.readFileSync(resolvedContractFilePath, 'utf8');
    return {
      source: 'env-contract-file',
      rawContract: parseJsonPayload(rawText),
      contractFilePath: resolvedContractFilePath
    };
  }

  const hasFieldConfig = [
    ENV_AUTOMATION_LAUNCH_KIND,
    ENV_AUTOMATION_LAUNCH_DISPLAY_NAME,
    ENV_AUTOMATION_LAUNCH_COMMAND,
    ENV_AUTOMATION_LAUNCH_ARGS,
    ENV_AUTOMATION_LAUNCH_WORKDIR,
    ENV_AUTOMATION_LAUNCH_PROCESS_NAMES,
    ENV_AUTOMATION_LAUNCH_RENDERER_ACCESSIBILITY,
    ENV_AUTOMATION_LAUNCH_CDP_PORT
  ].some((key) => normalizeString(env?.[key]));

  if (hasFieldConfig) {
    return {
      source: 'env-fields',
      rawContract: {
        kind: env?.[ENV_AUTOMATION_LAUNCH_KIND],
        displayName: env?.[ENV_AUTOMATION_LAUNCH_DISPLAY_NAME],
        command: env?.[ENV_AUTOMATION_LAUNCH_COMMAND],
        args: env?.[ENV_AUTOMATION_LAUNCH_ARGS],
        workdir: env?.[ENV_AUTOMATION_LAUNCH_WORKDIR],
        expected: {
          processNames: env?.[ENV_AUTOMATION_LAUNCH_PROCESS_NAMES],
          rendererAccessibility: env?.[ENV_AUTOMATION_LAUNCH_RENDERER_ACCESSIBILITY],
          cdpPort: env?.[ENV_AUTOMATION_LAUNCH_CDP_PORT]
        }
      }
    };
  }

  return null;
}

function resolveTradingViewAutomationLaunchContract(options = {}) {
  const env = options.env || process.env;
  let resolved = null;
  try {
    resolved = getConfiguredContractSource({
      env,
      cwd: options.cwd,
      contract: options.contract
    });
  } catch (error) {
    return buildInvalidContract(null, error?.message || String(error || 'TradingView automation launch contract resolution failed.'));
  }

  if (!resolved) {
    return buildNotConfiguredContract();
  }

  const warnings = [];

  try {
    const rawContract = resolved.rawContract;
    if (!rawContract || typeof rawContract !== 'object' || Array.isArray(rawContract)) {
      return buildInvalidContract({
        source: resolved.source
      }, 'TradingView automation launch contract must be a JSON object.');
    }

    const kind = normalizeString(rawContract.kind || DEFAULT_TRADINGVIEW_AUTOMATION_LAUNCH_KIND).toLowerCase() || DEFAULT_TRADINGVIEW_AUTOMATION_LAUNCH_KIND;
    const displayName = normalizeString(rawContract.displayName || DEFAULT_TRADINGVIEW_AUTOMATION_LAUNCH_DISPLAY_NAME) || DEFAULT_TRADINGVIEW_AUTOMATION_LAUNCH_DISPLAY_NAME;
    const workdir = normalizeString(rawContract.workdir);
    const resolvedWorkdir = workdir
      ? resolvePathLikeValue(workdir, {
          env,
          cwd: options.cwd
        })
      : '';

    if (resolvedWorkdir && !fs.existsSync(resolvedWorkdir)) {
      return buildInvalidContract({
        source: resolved.source,
        kind,
        displayName,
        workdir,
        resolvedWorkdir
      }, `TradingView automation launch workdir does not exist: ${resolvedWorkdir}`);
    }

    if (kind !== 'command') {
      return buildInvalidContract({
        source: resolved.source,
        kind,
        displayName,
        workdir,
        resolvedWorkdir
      }, `Unsupported TradingView automation launch contract kind: ${kind}`);
    }

    const command = normalizeString(rawContract.command);
    if (!command) {
      return buildInvalidContract({
        source: resolved.source,
        kind,
        displayName,
        workdir,
        resolvedWorkdir
      }, 'TradingView automation launch contract requires a non-empty command.');
    }

    const args = parseArgsValue(rawContract.args);
    const resolvedCommand = resolvePathLikeValue(command, {
      env,
      cwd: options.cwd,
      workdir: resolvedWorkdir || workdir
    });

    if (looksLikeFilesystemPath(command) && !fs.existsSync(resolvedCommand)) {
      return buildInvalidContract({
        source: resolved.source,
        kind,
        displayName,
        command,
        resolvedCommand,
        args,
        workdir,
        resolvedWorkdir
      }, `TradingView automation launch command was not found: ${resolvedCommand}`);
    }

    const expected = rawContract.expected && typeof rawContract.expected === 'object' && !Array.isArray(rawContract.expected)
      ? rawContract.expected
      : {};
    const expectedProcessNames = parseProcessNamesValue(expected.processNames || '');
    const normalizedExpected = {
      cdpPort: normalizePort(expected.cdpPort || env?.[ENV_AUTOMATION_LAUNCH_CDP_PORT] || env?.LIKU_TRADINGVIEW_CDP_PORT, DEFAULT_TRADINGVIEW_CDP_PORT),
      rendererAccessibility: normalizeBoolean(
        expected.rendererAccessibility ?? env?.[ENV_AUTOMATION_LAUNCH_RENDERER_ACCESSIBILITY],
        true
      ),
      processNames: expectedProcessNames.length > 0
        ? expectedProcessNames
        : [...DEFAULT_TRADINGVIEW_AUTOMATION_LAUNCH_PROCESS_NAMES]
    };

    if (!normalizedExpected.cdpPort) {
      return buildInvalidContract({
        source: resolved.source,
        kind,
        displayName,
        command,
        resolvedCommand,
        args,
        workdir,
        resolvedWorkdir,
        expected: normalizedExpected
      }, 'TradingView automation launch contract requires a valid expected CDP port.');
    }

    const invocationPreview = buildInvocationPreview(command, args);
    if (resolved.source === 'env-contract-file' && resolved.contractFilePath) {
      warnings.push(`TradingView automation launch contract loaded from ${resolved.contractFilePath}`);
    }
    if (!looksLikeFilesystemPath(command)) {
      warnings.push('TradingView automation launch contract uses a PATH-resolved command. Verify the intended wrapper command resolves consistently in the execution environment.');
    }

    return buildConfiguredContract({
      source: resolved.source,
      kind,
      displayName,
      command,
      resolvedCommand,
      args,
      workdir,
      resolvedWorkdir,
      invocationPreview,
      expected: normalizedExpected
    }, warnings);
  } catch (error) {
    return buildInvalidContract({
      source: resolved?.source || null
    }, error?.message || String(error || 'TradingView automation launch contract validation failed.'));
  }
}

function summarizeTradingViewAutomationLaunchContract(contract = null) {
  if (!contract || typeof contract !== 'object') return null;

  return {
    inspectionAvailable: contract.inspectionAvailable !== false,
    status: normalizeString(contract.status),
    configured: contract.configured === true,
    valid: contract.valid === true,
    source: contract.source || null,
    kind: normalizeString(contract.kind),
    displayName: normalizeString(contract.displayName),
    command: normalizeString(contract.command),
    resolvedCommand: normalizeString(contract.resolvedCommand),
    args: Array.isArray(contract.args) ? contract.args.slice(0, 64) : [],
    workdir: normalizeString(contract.workdir),
    resolvedWorkdir: normalizeString(contract.resolvedWorkdir),
    invocationPreview: normalizeString(contract.invocationPreview),
    expected: contract.expected
      ? {
          cdpPort: normalizePort(contract.expected.cdpPort, DEFAULT_TRADINGVIEW_CDP_PORT),
          rendererAccessibility: normalizeBoolean(contract.expected.rendererAccessibility, true),
          processNames: normalizeStringArray(contract.expected.processNames || DEFAULT_TRADINGVIEW_AUTOMATION_LAUNCH_PROCESS_NAMES).slice(0, 12)
        }
      : null,
    likelyMeaning: contract.likelyMeaning || null,
    recommendedNextStep: contract.recommendedNextStep || null,
    warnings: Array.isArray(contract.warnings) ? contract.warnings.slice(0, 8) : [],
    error: contract.error || null
  };
}

function buildTradingViewAutomationLaunchPreconditionMessage(options = {}) {
  const scenarioId = normalizeString(options?.scenarioId) || 'scenario';
  const launchProfileMessage = buildTradingViewLaunchProfilePreconditionMessage(options?.launchProfile || null, scenarioId);
  const launchContract = summarizeTradingViewAutomationLaunchContract(options?.launchContract || null);
  const launchCapability = options?.launchCapability && typeof options.launchCapability === 'object'
    ? options.launchCapability
    : null;

  const parts = [launchProfileMessage];

  if (launchContract?.status === 'configured') {
    const expectedPort = normalizePort(launchContract?.expected?.cdpPort, DEFAULT_TRADINGVIEW_CDP_PORT) || DEFAULT_TRADINGVIEW_CDP_PORT;
    const rendererClause = launchContract?.expected?.rendererAccessibility === true
      ? ' with renderer accessibility'
      : '';
    const descriptor = launchContract?.displayName
      ? `"${launchContract.displayName}"`
      : 'the configured TradingView automation launcher/wrapper contract';
    parts.push(`${descriptor} is configured and expects CDP port ${expectedPort}${rendererClause}, but the current TradingView session is not running through it.`);
    return parts.join(' ');
  }

  if (launchContract?.status === 'invalid') {
    parts.push(`The configured TradingView automation launcher/wrapper contract is invalid${launchContract.error ? `: ${launchContract.error}` : '.'}`);
    return parts.join(' ');
  }

  const capabilityMeaning = normalizeString(launchCapability?.likelyMeaning);
  if (capabilityMeaning) {
    parts.push(capabilityMeaning);
  }
  parts.push('No explicit TradingView automation launcher/wrapper contract is configured.');
  return parts.join(' ');
}

module.exports = {
  DEFAULT_TRADINGVIEW_AUTOMATION_LAUNCH_DISPLAY_NAME,
  DEFAULT_TRADINGVIEW_AUTOMATION_LAUNCH_KIND,
  DEFAULT_TRADINGVIEW_AUTOMATION_LAUNCH_PROCESS_NAMES,
  resolveTradingViewAutomationLaunchContract,
  summarizeTradingViewAutomationLaunchContract,
  buildTradingViewAutomationLaunchPreconditionMessage
};
