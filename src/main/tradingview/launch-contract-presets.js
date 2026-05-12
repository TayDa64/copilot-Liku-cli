const path = require('path');

const {
  DEFAULT_TRADINGVIEW_AUTOMATION_LAUNCH_DISPLAY_NAME
} = require('./launch-contract');
const {
  DEFAULT_TRADINGVIEW_CDP_PORT
} = require('./launch-profile');

function normalizeString(value = '') {
  return String(value || '').trim();
}

function normalizePort(value, fallback = DEFAULT_TRADINGVIEW_CDP_PORT) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const normalized = Math.round(numeric);
  return normalized >= 1 && normalized <= 65535 ? normalized : fallback;
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function clampNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(Math.round(numeric), max));
}

function resolveOptionalPath(value = '', baseDir = process.cwd()) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return '';
  }

  if (/%[^%]+%/.test(normalized)) {
    return normalized;
  }

  if (path.isAbsolute(normalized)) {
    return path.normalize(normalized);
  }

  return path.resolve(baseDir, normalized);
}

function getRepoRoot(options = {}) {
  const providedRepoRoot = normalizeString(options.repoRoot);
  if (providedRepoRoot) {
    return path.resolve(providedRepoRoot);
  }
  return path.resolve(__dirname, '..', '..', '..');
}

function buildTradingViewAutomationWrapperContractPreset(options = {}) {
  const repoRoot = getRepoRoot(options);
  const pathResolutionRoot = normalizeString(options.cwd)
    ? path.resolve(normalizeString(options.cwd))
    : process.cwd();
  const wrapperScriptPath = normalizeString(options.wrapperScriptPath)
    ? path.resolve(repoRoot, normalizeString(options.wrapperScriptPath))
    : path.join(repoRoot, 'scripts', 'launch-tradingview-automation.ps1');
  const executablePath = resolveOptionalPath(options.executablePath, pathResolutionRoot);
  const appUserModelId = normalizeString(options.appUserModelId);
  const cdpPort = normalizePort(options.cdpPort, DEFAULT_TRADINGVIEW_CDP_PORT);
  const allowForceKillExisting = normalizeBoolean(options.allowForceKillExisting, false);
  const closeTimeoutMs = clampNumber(options.closeTimeoutMs, 10000, 1000, 120000);
  const launchSettleMs = clampNumber(options.launchSettleMs, 750, 0, 30000);
  const displayName = normalizeString(options.displayName)
    || `${DEFAULT_TRADINGVIEW_AUTOMATION_LAUNCH_DISPLAY_NAME}${allowForceKillExisting ? ' (force-kill)' : ' (graceful restart)'}`;

  const args = [
    '-CdpPort',
    String(cdpPort),
    '-CloseTimeoutMs',
    String(closeTimeoutMs),
    '-LaunchSettleMs',
    String(launchSettleMs),
    '-ForceRendererAccessibility'
  ];

  if (executablePath) {
    args.push('-ExecutablePath', executablePath);
  }

  if (appUserModelId) {
    args.push('-AppUserModelId', appUserModelId);
  }

  if (allowForceKillExisting) {
    args.push('-AllowForceKillExisting');
  }

  return {
    kind: 'command',
    displayName,
    command: wrapperScriptPath,
    args,
    workdir: repoRoot,
    expected: {
      cdpPort,
      rendererAccessibility: true,
      processNames: ['TradingView', 'TradingView.exe']
    }
  };
}

module.exports = {
  buildTradingViewAutomationWrapperContractPreset
};
