function createDefaultBrowserSessionState() {
  return {
    url: null,
    title: null,
    goalStatus: 'unknown',
    lastStrategy: null,
    lastUserIntent: null,
    lastAttemptedUrl: null,
    attemptedUrls: [],
    navigationAttemptCount: 0,
    recoveryMode: 'direct',
    recoveryQuery: null,
    lastUpdated: null
  };
}

let browserSessionState = createDefaultBrowserSessionState();

function getBrowserSessionState() {
  return { ...browserSessionState };
}

function updateBrowserSessionState(patch = {}) {
  const normalizedAttemptedUrls = Array.isArray(patch.attemptedUrls)
    ? patch.attemptedUrls.map((value) => String(value || '').trim()).filter(Boolean).slice(-6)
    : undefined;
  browserSessionState = {
    ...browserSessionState,
    ...patch,
    ...(normalizedAttemptedUrls ? { attemptedUrls: normalizedAttemptedUrls } : {}),
    lastUpdated: new Date().toISOString()
  };
}

function resetBrowserSessionState() {
  browserSessionState = {
    ...createDefaultBrowserSessionState(),
    lastUpdated: new Date().toISOString()
  };
}

module.exports = {
  getBrowserSessionState,
  resetBrowserSessionState,
  updateBrowserSessionState
};
