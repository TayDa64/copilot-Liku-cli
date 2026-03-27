function normalizeMode(value) {
  return String(value || '').trim().toLowerCase();
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

  return {
    supported: true,
    capability: 'best-effort',
    reason: 'Background capture can try PrintWindow and degrade to CopyFromScreen when needed.'
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

  const capability = classifyBackgroundCapability(options);
  if (!capability.supported) {
    return {
      success: false,
      capability: capability.capability,
      degradedReason: capability.reason
    };
  }

  const targetWindowHandle = Number(options.windowHandle || options.targetWindowHandle || 0) || 0;
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

  return {
    success: true,
    result: screenshotResult,
    targetWindowHandle,
    foregroundWindowHandle,
    isBackgroundTarget,
    captureProvider: trust.captureProvider,
    captureCapability: trust.captureCapability,
    captureTrusted: trust.captureTrusted,
    captureDegradedReason: trust.captureDegradedReason
  };
}

module.exports = {
  captureBackgroundWindow,
  classifyBackgroundCapability
};
