const fs = require('fs');
const path = require('path');

const { executePowerShellScript } = require('../ui-automation/core/powershell');
const { buildTradingViewLaunchProfilePreconditionMessage } = require('./launch-profile');

const DEFAULT_TRADINGVIEW_PACKAGE_NAME = 'TradingView.Desktop';
const DEFAULT_TRADINGVIEW_DISPLAY_NAME = 'TradingView';
const DEFAULT_LAUNCH_CAPABILITY_TIMEOUT_MS = 6000;

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

function escapeRegExp(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildFallbackDocumentsCandidates() {
  const userProfile = normalizeString(process.env.USERPROFILE);
  const candidates = new Set();
  if (userProfile) {
    candidates.add(path.join(userProfile, 'OneDrive', 'Documents'));
    candidates.add(path.join(userProfile, 'Documents'));
  }
  return Array.from(candidates);
}

function inspectTradingViewDocumentsConfig(documentsPath = '') {
  const candidateRoots = new Set();
  const normalizedDocumentsPath = normalizeString(documentsPath);
  if (normalizedDocumentsPath) {
    candidateRoots.add(normalizedDocumentsPath);
  }
  for (const fallback of buildFallbackDocumentsCandidates()) {
    candidateRoots.add(fallback);
  }

  const candidateConfigDirs = Array.from(candidateRoots)
    .map((rootPath) => path.join(rootPath, 'TradingView', 'configs'))
    .filter(Boolean);
  const primaryConfigDir = candidateConfigDirs[0] || '';
  const configPath = primaryConfigDir ? path.join(primaryConfigDir, 'config.json') : '';
  const navRulesPath = primaryConfigDir ? path.join(primaryConfigDir, 'nav-rules.json') : '';

  return {
    documentsPath: normalizedDocumentsPath || '',
    candidateConfigDirs,
    configDir: primaryConfigDir,
    configPath,
    configExists: Boolean(configPath && fs.existsSync(configPath)),
    navRulesPath,
    navRulesExists: Boolean(navRulesPath && fs.existsSync(navRulesPath))
  };
}

function parseXmlTagAttributes(tagText = '') {
  const attributes = {};
  for (const match of String(tagText || '').matchAll(/\b([A-Za-z_][A-Za-z0-9_.:-]*)="([^"]*)"/g)) {
    attributes[match[1]] = match[2];
  }
  return attributes;
}

function findFirstXmlTagAttributes(xmlText = '', localName = '') {
  const normalizedLocalName = normalizeString(localName);
  if (!normalizedLocalName) return {};
  const regex = new RegExp(`<(?:(?:[A-Za-z_][\\w.-]*):)?${escapeRegExp(normalizedLocalName)}\\b[^>]*>`, 'i');
  const match = regex.exec(String(xmlText || ''));
  return match ? parseXmlTagAttributes(match[0]) : {};
}

function collectXmlTagAttributeValues(xmlText = '', localName = '', attributeName = '') {
  const normalizedLocalName = normalizeString(localName);
  const normalizedAttributeName = normalizeString(attributeName);
  if (!normalizedLocalName || !normalizedAttributeName) return [];

  const values = [];
  const seen = new Set();
  const regex = new RegExp(
    `<(?:(?:[A-Za-z_][\\w.-]*):)?${escapeRegExp(normalizedLocalName)}\\b[^>]*\\b${escapeRegExp(normalizedAttributeName)}="([^"]+)"`,
    'gi'
  );

  for (const match of String(xmlText || '').matchAll(regex)) {
    const value = normalizeString(match?.[1]);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }

  return values;
}

function inspectTradingViewManifestText(manifestText = '') {
  const normalizedText = String(manifestText || '');
  const applicationAttributes = findFirstXmlTagAttributes(normalizedText, 'Application');
  const startupTaskAttributes = findFirstXmlTagAttributes(normalizedText, 'StartupTask');
  const appExecutionAliases = Array.from(new Set([
    ...collectXmlTagAttributeValues(normalizedText, 'ExecutionAlias', 'Alias'),
    ...collectXmlTagAttributeValues(normalizedText, 'AppExecutionAlias', 'Alias')
  ]));
  const appExecutionAliasPresent = appExecutionAliases.length > 0
    || /windows\.appExecutionAlias/i.test(normalizedText)
    || /<(?:(?:[A-Za-z_][\w.-]*):)?ExecutionAlias\b/i.test(normalizedText)
    || /<(?:(?:[A-Za-z_][\w.-]*):)?AppExecutionAlias\b/i.test(normalizedText);

  return {
    applicationId: normalizeString(applicationAttributes.Id),
    executable: normalizeString(applicationAttributes.Executable),
    entryPoint: normalizeString(applicationAttributes.EntryPoint),
    protocols: collectXmlTagAttributeValues(normalizedText, 'Protocol', 'Name'),
    appUriHosts: collectXmlTagAttributeValues(normalizedText, 'Host', 'Name'),
    startupTaskId: normalizeString(startupTaskAttributes.TaskId),
    startupTaskEnabled: /^true$/i.test(normalizeString(startupTaskAttributes.Enabled)),
    startupTaskDisplayName: normalizeString(startupTaskAttributes.DisplayName),
    appExecutionAliasPresent,
    appExecutionAliases
  };
}

function inspectTradingViewManifestFile(manifestPath = '') {
  const normalizedPath = normalizeString(manifestPath);
  const result = {
    exists: false,
    path: normalizedPath,
    applicationId: '',
    executable: '',
    entryPoint: '',
    protocols: [],
    appUriHosts: [],
    startupTaskId: '',
    startupTaskEnabled: false,
    startupTaskDisplayName: '',
    appExecutionAliasPresent: false,
    appExecutionAliases: [],
    error: ''
  };

  if (!normalizedPath || !fs.existsSync(normalizedPath)) {
    return result;
  }

  try {
    const text = fs.readFileSync(normalizedPath, 'utf8');
    return {
      ...result,
      exists: true,
      ...inspectTradingViewManifestText(text)
    };
  } catch (error) {
    return {
      ...result,
      exists: true,
      error: error?.message || String(error || 'Failed to read TradingView manifest')
    };
  }
}

function inspectTradingViewBundleContent(content = '') {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content || ''), 'utf8');
  const text = Buffer.isBuffer(content) ? buffer.toString('utf8') : String(content || '');
  const supportedEnvironmentKeys = Array.from(new Set(
    (text.match(/TVD_[A-Z0-9_]+/g) || [])
      .map((entry) => normalizeString(entry))
      .filter(Boolean)
  )).sort();

  const includesMarker = (marker) => buffer.indexOf(Buffer.from(marker, 'utf8')) >= 0;

  return {
    sizeBytes: buffer.length,
    commandLineAppendSwitchPresent: includesMarker('app.commandLine.appendSwitch'),
    remoteDebuggingStringPresent: includesMarker('remote-debugging-port') || includesMarker('remoteDebugging'),
    rendererAccessibilityStringPresent: includesMarker('force-renderer-accessibility')
      || includesMarker('enable-renderer-accessibility')
      || includesMarker('setAccessibilitySupportEnabled')
      || includesMarker('accessibilitySupportEnabled'),
    configOverrideReadPresent: includesMarker('config.json') && includesMarker('nav-rules.json'),
    supportedEnvironmentKeys
  };
}

function inspectTradingViewBundleFile(bundlePath = '') {
  const normalizedPath = normalizeString(bundlePath);
  const result = {
    exists: false,
    path: normalizedPath,
    sizeBytes: 0,
    commandLineAppendSwitchPresent: false,
    remoteDebuggingStringPresent: false,
    rendererAccessibilityStringPresent: false,
    configOverrideReadPresent: false,
    supportedEnvironmentKeys: [],
    error: ''
  };

  if (!normalizedPath || !fs.existsSync(normalizedPath)) {
    return result;
  }

  try {
    const buffer = fs.readFileSync(normalizedPath);
    return {
      ...result,
      exists: true,
      ...inspectTradingViewBundleContent(buffer)
    };
  } catch (error) {
    return {
      ...result,
      exists: true,
      error: error?.message || String(error || 'Failed to read TradingView app.asar')
    };
  }
}

function normalizePackageIdentity(entry = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const normalized = {
    name: normalizeString(entry.name || entry.Name || DEFAULT_TRADINGVIEW_PACKAGE_NAME),
    packageFullName: normalizeString(entry.packageFullName || entry.PackageFullName),
    packageFamilyName: normalizeString(entry.packageFamilyName || entry.PackageFamilyName),
    installLocation: normalizeString(entry.installLocation || entry.InstallLocation),
    version: normalizeString(entry.version || entry.Version)
  };

  if (!normalized.name && !normalized.packageFullName && !normalized.packageFamilyName && !normalized.installLocation) {
    return null;
  }

  return normalized;
}

function normalizeStartAppEntries(entries = []) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      name: normalizeString(entry?.name || entry?.Name || DEFAULT_TRADINGVIEW_DISPLAY_NAME),
      appId: normalizeString(entry?.appId || entry?.AppID)
    }))
    .filter((entry) => entry.name || entry.appId);
}

function buildTradingViewLaunchCapabilityLikelyMeaning(capabilityProfile = '') {
  switch (normalizeString(capabilityProfile).toLowerCase()) {
    case 'shell-launch-only':
      return 'This TradingView install exposes a packaged shell/AppID identity, but no bounded argument-bearing automation launch surface was detected.';
    case 'flag-capable':
      return 'This TradingView install exposes a packaged AppID launch target that the automation wrapper can use for an automation-ready relaunch with remote debugging and renderer accessibility.';
    case 'identity-incomplete':
      return 'TradingView appears to be installed, but no stable packaged launch identity was detected.';
    case 'not-installed':
      return 'TradingView was not detected in the local packaged-app surfaces.';
    default:
      return 'TradingView launch capability could not be determined.';
  }
}

function buildTradingViewLaunchCapabilityNextStep(capabilityProfile = '') {
  switch (normalizeString(capabilityProfile).toLowerCase()) {
    case 'shell-launch-only':
      return 'Keep Pine/CDP scenarios fail-closed on this install, or move to a TradingView build or launch wrapper that can enable remote debugging and renderer accessibility.';
    case 'flag-capable':
      return 'Relaunch TradingView through the automation wrapper using the packaged AppID launch target or other detected flag-capable surface, then verify the expected remote debugging port and renderer accessibility are live.';
    case 'identity-incomplete':
      return 'Inspect the package registration and packaged launch identity before attempting an automation relaunch.';
    case 'not-installed':
      return 'Install TradingView or verify the packaged app registration before running Pine/CDP workflows.';
    default:
      return '';
  }
}

function classifyTradingViewLaunchCapability(snapshot = {}) {
  const packageIdentity = normalizePackageIdentity(snapshot?.package);
  const startApps = normalizeStartAppEntries(snapshot?.startApps);
  const manifest = snapshot?.manifest && typeof snapshot.manifest === 'object'
    ? {
        exists: snapshot.manifest.exists === true,
        path: normalizeString(snapshot.manifest.path),
        applicationId: normalizeString(snapshot.manifest.applicationId),
        executable: normalizeString(snapshot.manifest.executable),
        entryPoint: normalizeString(snapshot.manifest.entryPoint),
        protocols: Array.isArray(snapshot.manifest.protocols) ? snapshot.manifest.protocols.map(normalizeString).filter(Boolean) : [],
        appUriHosts: Array.isArray(snapshot.manifest.appUriHosts) ? snapshot.manifest.appUriHosts.map(normalizeString).filter(Boolean) : [],
        startupTaskId: normalizeString(snapshot.manifest.startupTaskId),
        startupTaskEnabled: snapshot.manifest.startupTaskEnabled === true,
        startupTaskDisplayName: normalizeString(snapshot.manifest.startupTaskDisplayName),
        appExecutionAliasPresent: snapshot.manifest.appExecutionAliasPresent === true,
        appExecutionAliases: Array.isArray(snapshot.manifest.appExecutionAliases) ? snapshot.manifest.appExecutionAliases.map(normalizeString).filter(Boolean) : [],
        error: normalizeString(snapshot.manifest.error)
      }
    : inspectTradingViewManifestFile('');
  const bundle = snapshot?.bundle && typeof snapshot.bundle === 'object'
    ? {
        exists: snapshot.bundle.exists === true,
        path: normalizeString(snapshot.bundle.path),
        sizeBytes: Number(snapshot.bundle.sizeBytes || 0) || 0,
        commandLineAppendSwitchPresent: snapshot.bundle.commandLineAppendSwitchPresent === true,
        remoteDebuggingStringPresent: snapshot.bundle.remoteDebuggingStringPresent === true,
        rendererAccessibilityStringPresent: snapshot.bundle.rendererAccessibilityStringPresent === true,
        configOverrideReadPresent: snapshot.bundle.configOverrideReadPresent === true,
        supportedEnvironmentKeys: Array.isArray(snapshot.bundle.supportedEnvironmentKeys)
          ? snapshot.bundle.supportedEnvironmentKeys.map(normalizeString).filter(Boolean)
          : [],
        error: normalizeString(snapshot.bundle.error)
      }
    : inspectTradingViewBundleFile('');
  const documentsConfig = snapshot?.documentsConfig && typeof snapshot.documentsConfig === 'object'
    ? {
        documentsPath: normalizeString(snapshot.documentsConfig.documentsPath),
        candidateConfigDirs: Array.isArray(snapshot.documentsConfig.candidateConfigDirs)
          ? snapshot.documentsConfig.candidateConfigDirs.map(normalizeString).filter(Boolean)
          : [],
        configDir: normalizeString(snapshot.documentsConfig.configDir),
        configPath: normalizeString(snapshot.documentsConfig.configPath),
        configExists: snapshot.documentsConfig.configExists === true,
        navRulesPath: normalizeString(snapshot.documentsConfig.navRulesPath),
        navRulesExists: snapshot.documentsConfig.navRulesExists === true
      }
    : inspectTradingViewDocumentsConfig();

  const inspectionAvailable = snapshot?.inspectionAvailable !== false;
  const installed = Boolean(
    packageIdentity?.packageFullName
    || packageIdentity?.installLocation
    || startApps.length > 0
    || manifest.applicationId
  );
  const preferredStartApp = startApps.find((entry) => entry.appId) || startApps[0] || null;
  const shellLaunchSupported = Boolean(preferredStartApp?.appId);
  const shellLaunchTarget = preferredStartApp?.appId ? `shell:AppsFolder\\${preferredStartApp.appId}` : '';
  const activationLaunchSupported = shellLaunchSupported;
  const activationLaunchMode = activationLaunchSupported ? 'application-activation-manager' : '';
  const automationLaunchSurfaceDetected = manifest.appExecutionAliasPresent === true
    || bundle.remoteDebuggingStringPresent === true
    || bundle.rendererAccessibilityStringPresent === true
    || activationLaunchSupported;

  let capabilityProfile = 'not-installed';
  let reason = 'not-installed';
  if (installed) {
    if (automationLaunchSurfaceDetected) {
      capabilityProfile = 'flag-capable';
      reason = null;
    } else if (shellLaunchSupported) {
      capabilityProfile = 'shell-launch-only';
      reason = 'flag-launch-surface-not-detected';
    } else {
      capabilityProfile = 'identity-incomplete';
      reason = 'launch-identity-not-detected';
    }
  }

  const warnings = [];
  if (installed && documentsConfig.configPath && !automationLaunchSurfaceDetected) {
    warnings.push('TradingView checks a user Documents config override path, but bundled evidence did not expose remote debugging or renderer accessibility controls.');
  }
  if (installed && bundle.commandLineAppendSwitchPresent && !automationLaunchSurfaceDetected) {
    warnings.push('Bundled Electron startup code appends switches, but no remote debugging or renderer accessibility switch strings were detected.');
  }
  if (installed && packageIdentity?.installLocation && /\\windowsapps\\/i.test(packageIdentity.installLocation) && activationLaunchSupported) {
    warnings.push('This TradingView install is running from a WindowsApps/MSIX path, so the wrapper should use packaged AppID activation instead of unpacked or direct executable relaunches.');
  } else if (installed && packageIdentity?.installLocation && /\\windowsapps\\/i.test(packageIdentity.installLocation) && !automationLaunchSurfaceDetected) {
    warnings.push('This TradingView install is running from a WindowsApps/MSIX path, so normal executable relaunch flags are not a reliable automation path.');
  }
  if (installed && activationLaunchSupported && manifest.appExecutionAliasPresent !== true) {
    warnings.push('No TradingView app execution alias was detected, so automation relaunch should use the packaged AppID launch target rather than expecting a WindowsApps command alias.');
  }
  if (manifest.error) {
    warnings.push(`Manifest inspection warning: ${manifest.error}`);
  }
  if (bundle.error) {
    warnings.push(`Bundle inspection warning: ${bundle.error}`);
  }

  return {
    inspectionAvailable,
    installed,
    capabilityProfile,
    automationLaunchSurfaceDetected,
    reason,
    likelyMeaning: buildTradingViewLaunchCapabilityLikelyMeaning(capabilityProfile),
    recommendedNextStep: buildTradingViewLaunchCapabilityNextStep(capabilityProfile),
    package: packageIdentity,
    startApps,
    launchIdentity: {
      displayName: DEFAULT_TRADINGVIEW_DISPLAY_NAME,
      appId: normalizeString(preferredStartApp?.appId),
      shellLaunchSupported,
      shellLaunchTarget,
      activationLaunchSupported,
      activationLaunchMode,
      applicationId: manifest.applicationId,
      executable: manifest.executable,
      entryPoint: manifest.entryPoint
    },
    manifest,
    bundle,
    documentsConfig,
    warnings
  };
}

async function runPowerShellJson(script = '', timeoutMs = DEFAULT_LAUNCH_CAPABILITY_TIMEOUT_MS, deps = {}) {
  const execute = typeof deps.executePowerShellScript === 'function'
    ? deps.executePowerShellScript
    : executePowerShellScript;
  const result = await execute(script, timeoutMs);
  if (result?.error) {
    throw new Error(result.error || result.stderr || 'PowerShell execution failed');
  }
  const text = normalizeString(result?.stdout);
  if (!text) return null;
  return parseJsonPayload(text);
}

async function detectTradingViewLaunchCapability(options = {}) {
  if (process.platform !== 'win32') {
    return {
      inspectionAvailable: false,
      installed: false,
      capabilityProfile: 'platform-unsupported',
      automationLaunchSurfaceDetected: false,
      reason: 'platform-unsupported',
      likelyMeaning: 'TradingView launch capability inspection is only implemented for Windows.',
      recommendedNextStep: '',
      package: null,
      startApps: [],
      launchIdentity: {
        displayName: DEFAULT_TRADINGVIEW_DISPLAY_NAME,
        appId: '',
        shellLaunchSupported: false,
        shellLaunchTarget: '',
        activationLaunchSupported: false,
        activationLaunchMode: '',
        applicationId: '',
        executable: '',
        entryPoint: ''
      },
      manifest: inspectTradingViewManifestFile(''),
      bundle: inspectTradingViewBundleFile(''),
      documentsConfig: inspectTradingViewDocumentsConfig(),
      warnings: []
    };
  }

  const timeoutMs = Math.max(
    500,
    Math.min(Number(options?.timeoutMs || DEFAULT_LAUNCH_CAPABILITY_TIMEOUT_MS) || DEFAULT_LAUNCH_CAPABILITY_TIMEOUT_MS, 10000)
  );
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$documentsPath = [Environment]::GetFolderPath('MyDocuments')
$packages = @(Get-AppxPackage *TradingView* -ErrorAction SilentlyContinue | Sort-Object Version -Descending)
$package = $packages | Select-Object -First 1
$startApps = @()

if ($package) {
  $packageFamilyName = [string]$package.PackageFamilyName
  $startApps = @(Get-StartApps -ErrorAction SilentlyContinue | Where-Object {
    $appId = [string]$_.AppID
    $name = [string]$_.Name
    ($packageFamilyName -and $appId.StartsWith($packageFamilyName + '!')) -or $name -like '*TradingView*'
  })
} else {
  $startApps = @(Get-StartApps -ErrorAction SilentlyContinue | Where-Object {
    ([string]$_.Name -like '*TradingView*') -or ([string]$_.AppID -like 'TradingView*')
  })
}

$result = [PSCustomObject]@{
  documentsPath = [string]$documentsPath
  package = if ($package) {
    [PSCustomObject]@{
      name = [string]$package.Name
      packageFullName = [string]$package.PackageFullName
      packageFamilyName = [string]$package.PackageFamilyName
      installLocation = [string]$package.InstallLocation
      version = [string]$package.Version
    }
  } else {
    $null
  }
  startApps = @($startApps | ForEach-Object {
    [PSCustomObject]@{
      name = [string]$_.Name
      appId = [string]$_.AppID
    }
  })
}

$result | ConvertTo-Json -Compress -Depth 6
`;

  try {
    const payload = await runPowerShellJson(script, timeoutMs, {
      executePowerShellScript: options.executePowerShellScript
    });
    const packageIdentity = normalizePackageIdentity(payload?.package);
    const installLocation = normalizeString(packageIdentity?.installLocation);
    const manifestPath = installLocation ? path.join(installLocation, 'AppxManifest.xml') : '';
    const bundlePath = installLocation ? path.join(installLocation, 'resources', 'app.asar') : '';

    return classifyTradingViewLaunchCapability({
      inspectionAvailable: true,
      package: packageIdentity,
      startApps: payload?.startApps || [],
      manifest: inspectTradingViewManifestFile(manifestPath),
      bundle: inspectTradingViewBundleFile(bundlePath),
      documentsConfig: inspectTradingViewDocumentsConfig(payload?.documentsPath)
    });
  } catch (error) {
    return {
      inspectionAvailable: false,
      installed: false,
      capabilityProfile: 'inspection-unavailable',
      automationLaunchSurfaceDetected: false,
      reason: 'launch-capability-inspection-failed',
      likelyMeaning: 'TradingView launch capability inspection failed before the install could be classified.',
      recommendedNextStep: '',
      package: null,
      startApps: [],
      launchIdentity: {
        displayName: DEFAULT_TRADINGVIEW_DISPLAY_NAME,
        appId: '',
        shellLaunchSupported: false,
        shellLaunchTarget: '',
        activationLaunchSupported: false,
        activationLaunchMode: '',
        applicationId: '',
        executable: '',
        entryPoint: ''
      },
      manifest: inspectTradingViewManifestFile(''),
      bundle: inspectTradingViewBundleFile(''),
      documentsConfig: inspectTradingViewDocumentsConfig(),
      warnings: [],
      error: error?.message || String(error || 'TradingView launch capability inspection failed')
    };
  }
}

function summarizeTradingViewLaunchCapability(capability = null) {
  if (!capability || typeof capability !== 'object') return null;

  return {
    inspectionAvailable: capability.inspectionAvailable !== false,
    installed: capability.installed === true,
    capabilityProfile: normalizeString(capability.capabilityProfile),
    automationLaunchSurfaceDetected: capability.automationLaunchSurfaceDetected === true,
    reason: capability.reason || null,
    likelyMeaning: capability.likelyMeaning || null,
    recommendedNextStep: capability.recommendedNextStep || null,
    package: capability.package
      ? {
          name: normalizeString(capability.package.name),
          packageFullName: normalizeString(capability.package.packageFullName),
          packageFamilyName: normalizeString(capability.package.packageFamilyName),
          version: normalizeString(capability.package.version)
        }
      : null,
    launchIdentity: capability.launchIdentity
      ? {
          appId: normalizeString(capability.launchIdentity.appId),
          shellLaunchSupported: capability.launchIdentity.shellLaunchSupported === true,
          shellLaunchTarget: normalizeString(capability.launchIdentity.shellLaunchTarget),
          activationLaunchSupported: capability.launchIdentity.activationLaunchSupported === true,
          activationLaunchMode: normalizeString(capability.launchIdentity.activationLaunchMode),
          applicationId: normalizeString(capability.launchIdentity.applicationId),
          executable: normalizeString(capability.launchIdentity.executable),
          entryPoint: normalizeString(capability.launchIdentity.entryPoint)
        }
      : null,
    documentsConfig: capability.documentsConfig
      ? {
          documentsPath: normalizeString(capability.documentsConfig.documentsPath),
          configPath: normalizeString(capability.documentsConfig.configPath),
          configExists: capability.documentsConfig.configExists === true,
          navRulesPath: normalizeString(capability.documentsConfig.navRulesPath),
          navRulesExists: capability.documentsConfig.navRulesExists === true
        }
      : null,
    manifest: capability.manifest
      ? {
          applicationId: normalizeString(capability.manifest.applicationId),
          executable: normalizeString(capability.manifest.executable),
          entryPoint: normalizeString(capability.manifest.entryPoint),
          protocols: Array.isArray(capability.manifest.protocols) ? capability.manifest.protocols.slice(0, 8) : [],
          appUriHosts: Array.isArray(capability.manifest.appUriHosts) ? capability.manifest.appUriHosts.slice(0, 8) : [],
          startupTaskId: normalizeString(capability.manifest.startupTaskId),
          appExecutionAliasPresent: capability.manifest.appExecutionAliasPresent === true,
          appExecutionAliases: Array.isArray(capability.manifest.appExecutionAliases) ? capability.manifest.appExecutionAliases.slice(0, 8) : []
        }
      : null,
    bundle: capability.bundle
      ? {
          path: normalizeString(capability.bundle.path),
          remoteDebuggingStringPresent: capability.bundle.remoteDebuggingStringPresent === true,
          rendererAccessibilityStringPresent: capability.bundle.rendererAccessibilityStringPresent === true,
          commandLineAppendSwitchPresent: capability.bundle.commandLineAppendSwitchPresent === true,
          supportedEnvironmentKeys: Array.isArray(capability.bundle.supportedEnvironmentKeys)
            ? capability.bundle.supportedEnvironmentKeys.slice(0, 16)
            : []
        }
      : null,
    warnings: Array.isArray(capability.warnings) ? capability.warnings.slice(0, 8) : [],
    error: capability.error || null
  };
}

function buildTradingViewAutomationLaunchPreconditionMessage(options = {}) {
  const scenarioId = normalizeString(options?.scenarioId) || 'scenario';
  const launchProfileMessage = buildTradingViewLaunchProfilePreconditionMessage(options?.launchProfile || null, scenarioId);
  const capabilityMeaning = normalizeString(options?.launchCapability?.likelyMeaning);
  if (!capabilityMeaning) {
    return launchProfileMessage;
  }
  return `${launchProfileMessage} ${capabilityMeaning}`;
}

module.exports = {
  DEFAULT_TRADINGVIEW_PACKAGE_NAME,
  DEFAULT_TRADINGVIEW_DISPLAY_NAME,
  inspectTradingViewManifestText,
  inspectTradingViewBundleContent,
  inspectTradingViewDocumentsConfig,
  classifyTradingViewLaunchCapability,
  detectTradingViewLaunchCapability,
  summarizeTradingViewLaunchCapability,
  buildTradingViewAutomationLaunchPreconditionMessage
};
