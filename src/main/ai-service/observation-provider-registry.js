const registeredObservationProviders = [];

function sortRegisteredObservationProviders() {
  registeredObservationProviders.sort((a, b) => {
    const left = Number.isFinite(Number(a.priority)) ? Number(a.priority) : 0;
    const right = Number.isFinite(Number(b.priority)) ? Number(b.priority) : 0;
    if (left !== right) return left - right;
    return String(a.toolName || '').localeCompare(String(b.toolName || ''));
  });
}

function registerObservationProvider(toolName, provider, priority = 0) {
  const normalizedToolName = String(toolName || '').trim();
  if (!normalizedToolName) {
    throw new Error('registerObservationProvider requires a toolName');
  }
  if (!provider || typeof provider !== 'object') {
    throw new Error(`registerObservationProvider requires a provider object for ${normalizedToolName}`);
  }

  const nextEntry = {
    toolName: normalizedToolName,
    provider,
    priority: Number.isFinite(Number(priority)) ? Number(priority) : 0
  };

  const existingIndex = registeredObservationProviders.findIndex((entry) => entry.toolName === normalizedToolName);
  if (existingIndex >= 0) {
    registeredObservationProviders[existingIndex] = nextEntry;
  } else {
    registeredObservationProviders.push(nextEntry);
  }

  sortRegisteredObservationProviders();
  return nextEntry;
}

function unregisterObservationProvider(toolName) {
  const normalizedToolName = String(toolName || '').trim();
  const existingIndex = registeredObservationProviders.findIndex((entry) => entry.toolName === normalizedToolName);
  if (existingIndex >= 0) {
    registeredObservationProviders.splice(existingIndex, 1);
    return true;
  }
  return false;
}

function getRegisteredObservationProviders() {
  return registeredObservationProviders.map((entry) => ({
    toolName: entry.toolName,
    priority: entry.priority,
    provider: entry.provider
  }));
}

module.exports = {
  getRegisteredObservationProviders,
  registerObservationProvider,
  unregisterObservationProvider
};
