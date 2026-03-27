function normalizeMode(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeLowerText(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeWindowProfile(profile = {}) {
  if (!profile || typeof profile !== 'object') return null;
  return {
    processName: normalizeLowerText(profile.processName),
    className: normalizeLowerText(profile.className),
    windowKind: normalizeLowerText(profile.windowKind),
    title: String(profile.title || profile.windowTitle || '').trim(),
    isMinimized: profile.isMinimized === true
  };
}

function classifyBackgroundCapability(options = {}) {
  const windowHandle = Number(options.windowHandle || options.targetWindowHandle || 0) || 0;
  if (!windowHandle) {
    return {
      supported: false,
      capability: 'unsupported',
      reason: 'No target window handle was provided for background capture.'
    };
  }

  if (process.platform !== 'win32') {
    return {
      supported: false,
      capability: 'unsupported',
      reason: 'Background window capture is currently implemented for Windows HWND targets only.'
    };
  }

  const profile = normalizeWindowProfile(
    options.windowProfile
    || options.targetWindow
    || options.windowInfo
  );
  if (profile?.isMinimized) {
    return {
      supported: false,
      capability: 'unsupported',
      reason: 'Target window is minimized; non-disruptive background capture cannot provide trustworthy evidence.'
    };
  }

  const processName = profile?.processName || '';
  const className = profile?.className || '';
  const windowKind = profile?.windowKind || '';

  const knownCompositorClass = /^chrome_widgetwin/i.test(className);
  const knownCompositorProcess = [
    'chrome',
    'msedge',
    'code',
    'slack',
    'discord',
    'teams',
    'ms-teams',
    'obs64'
  ].includes(processName);
  const likelyOwnedSurface = windowKind === 'owned' || windowKind === 'palette';
  const likelyUwpSurface = className.includes('applicationframewindow')
    || className.includes('windows.ui.core.corewindow')
    || processName === 'applicationframehost';

  if (likelyUwpSurface || knownCompositorClass || knownCompositorProcess || likelyOwnedSurface) {
    const tags = [];
    if (knownCompositorClass) tags.push(`class=${profile.className}`);
    if (knownCompositorProcess) tags.push(`process=${profile.processName}`);
    if (likelyOwnedSurface) tags.push(`windowKind=${profile.windowKind}`);
    if (likelyUwpSurface) tags.push('uwp-surface');
    return {
      supported: true,
      capability: 'degraded',
      reason: `Background capture is best-effort for this window profile (${tags.join(', ') || 'unknown profile'}); PrintWindow may fail or return stale/blank frames.`
    };
  }

  return {
    supported: true,
    capability: 'supported',
    reason: 'Background capture can attempt trusted PrintWindow for this window profile and degrade only when needed.'
  };
}

function evaluateCaptureTrust({ captureMode, isBackgroundTarget }) {
  const mode = normalizeMode(captureMode);
  if (!mode) {
    return {
      captureTrusted: false,
      captureProvider: 'unknown',
      captureCapability: 'unsupported',
      captureDegradedReason: 'Background capture did not return a capture mode.'
    };
  }

  if (mode.startsWith('window-printwindow')) {
    return {
      captureTrusted: true,
      captureProvider: 'printwindow',
      captureCapability: 'supported',
      captureDegradedReason: null
    };
  }

  if (mode.startsWith('window-copyfromscreen')) {
    if (isBackgroundTarget) {
      return {
        captureTrusted: false,
        captureProvider: 'copyfromscreen',
        captureCapability: 'degraded',
        captureDegradedReason: 'Background capture degraded to CopyFromScreen while target was not foreground; content may be occluded or stale.'
      };
    }
    return {
      captureTrusted: true,
      captureProvider: 'copyfromscreen',
      captureCapability: 'supported',
      captureDegradedReason: null
    };
  }

  return {
    captureTrusted: false,
    captureProvider: mode,
    captureCapability: 'unsupported',
    captureDegradedReason: `Background capture returned unsupported mode: ${mode}.`
  };
}

async function captureBackgroundWindow(options = {}, dependencies = {}) {
  const screenshotFn = dependencies.screenshotFn
    || require('./ui-automation/screenshot').screenshot;
  const getForegroundWindowHandle = dependencies.getForegroundWindowHandle
    || require('./system-automation').getForegroundWindowHandle;
  const getWindowProfileByHandle = dependencies.getWindowProfileByHandle
    || (async (windowHandle) => {
      try {
        const windowManager = require('./ui-automation/window/manager');
        if (typeof windowManager.findWindows !== 'function') return null;
        const windows = await windowManager.findWindows({ includeUntitled: true });
        if (!Array.isArray(windows) || windows.length === 0) return null;
        return windows.find((windowInfo) => Number(windowInfo?.hwnd || 0) === Number(windowHandle || 0)) || null;
      } catch {
        return null;
      }
    });

  const targetWindowHandle = Number(options.windowHandle || options.targetWindowHandle || 0) || 0;
  let resolvedProfile = normalizeWindowProfile(
    options.windowProfile
    || options.targetWindow
    || options.windowInfo
  );
  if (!resolvedProfile && targetWindowHandle > 0) {
    resolvedProfile = normalizeWindowProfile(await getWindowProfileByHandle(targetWindowHandle));
  }
  const classificationOptions = {
    ...options,
    windowHandle: targetWindowHandle,
    targetWindowHandle,
    windowProfile: resolvedProfile
  };

  const capability = classifyBackgroundCapability(classificationOptions);
  if (!capability.supported) {
    return {
      success: false,
      capability: capability.capability,
      degradedReason: capability.reason,
      windowProfile: resolvedProfile
    };
  }

  const captureOptions = {
    memory: true,
    base64: true,
    metric: 'sha256',
    windowHwnd: targetWindowHandle
  };
  const screenshotResult = await screenshotFn(captureOptions);
  if (!screenshotResult?.success || !screenshotResult?.base64) {
    return {
      success: false,
      capability: 'unsupported',
      degradedReason: 'Background capture failed to return image data.'
    };
  }

  let foregroundWindowHandle = null;
  try {
    foregroundWindowHandle = Number(await getForegroundWindowHandle()) || null;
  } catch {
    foregroundWindowHandle = null;
  }
  const isBackgroundTarget = Number.isFinite(Number(foregroundWindowHandle))
    ? Number(foregroundWindowHandle) !== targetWindowHandle
    : true;
  const trust = evaluateCaptureTrust({
    captureMode: screenshotResult.captureMode,
    isBackgroundTarget
  });
  const matrixDegraded = capability.capability === 'degraded';
  const trustDegraded = trust.captureCapability === 'degraded';
  const combinedCapability = matrixDegraded || trustDegraded
    ? 'degraded'
    : trust.captureCapability;
  const combinedReason = matrixDegraded
    ? capability.reason
    : trust.captureDegradedReason;
  const combinedTrusted = trust.captureTrusted && !matrixDegraded;

  return {
    success: true,
    result: screenshotResult,
    targetWindowHandle,
    foregroundWindowHandle,
    isBackgroundTarget,
    captureProvider: trust.captureProvider,
    captureCapability: combinedCapability,
    captureTrusted: combinedTrusted,
    captureDegradedReason: combinedReason,
    windowProfile: resolvedProfile
  };
}

module.exports = {
  captureBackgroundWindow,
  classifyBackgroundCapability
};
