function createDefaultBrowserSessionState() {
  return {
    url: null,
    title: null,
    goalStatus: 'unknown',
    lastStrategy: null,
    lastUserIntent: null,
    lastUpdated: null
  };
}

let browserSessionState = createDefaultBrowserSessionState();

function getBrowserSessionState() {
  return { ...browserSessionState };
}

function updateBrowserSessionState(patch = {}) {
  browserSessionState = {
    ...browserSessionState,
    ...patch,
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
