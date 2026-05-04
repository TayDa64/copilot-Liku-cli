const registeredSystemContractProviders = [];

function sortRegisteredSystemContractProviders() {
  registeredSystemContractProviders.sort((a, b) => {
    const left = Number.isFinite(Number(a.priority)) ? Number(a.priority) : 0;
    const right = Number.isFinite(Number(b.priority)) ? Number(b.priority) : 0;
    if (left !== right) return left - right;
    return String(a.toolName || '').localeCompare(String(b.toolName || ''));
  });
}

function registerSystemContractProvider(toolName, provider, priority = 0) {
  const normalizedToolName = String(toolName || '').trim();
  if (!normalizedToolName) {
    throw new Error('registerSystemContractProvider requires a toolName');
  }
  if (typeof provider !== 'function') {
    throw new Error(`registerSystemContractProvider requires a function provider for ${normalizedToolName}`);
  }

  const nextEntry = {
    toolName: normalizedToolName,
    provider,
    priority: Number.isFinite(Number(priority)) ? Number(priority) : 0
  };

  const existingIndex = registeredSystemContractProviders.findIndex((entry) => entry.toolName === normalizedToolName);
  if (existingIndex >= 0) {
    registeredSystemContractProviders[existingIndex] = nextEntry;
  } else {
    registeredSystemContractProviders.push(nextEntry);
  }

  sortRegisteredSystemContractProviders();
  return nextEntry;
}

function unregisterSystemContractProvider(toolName) {
  const normalizedToolName = String(toolName || '').trim();
  const existingIndex = registeredSystemContractProviders.findIndex((entry) => entry.toolName === normalizedToolName);
  if (existingIndex >= 0) {
    registeredSystemContractProviders.splice(existingIndex, 1);
    return true;
  }
  return false;
}

function getRegisteredSystemContractProviders() {
  return registeredSystemContractProviders.map((entry) => ({
    toolName: entry.toolName,
    priority: entry.priority
  }));
}

function normalizeProviderResult(toolName, result) {
  if (result === null || result === undefined || result === '') return [];
  if (typeof result === 'string') return [result];
  if (Array.isArray(result)) {
    const invalid = result.find((message) => message !== null && message !== undefined && message !== '' && typeof message !== 'string');
    if (invalid !== undefined) {
      throw new Error(`System contract provider ${toolName} returned a non-string message`);
    }
    return result.filter((message) => typeof message === 'string' && message.trim());
  }
  throw new Error(`System contract provider ${toolName} returned an unsupported result`);
}

function buildRegisteredSystemContractMessages(context = {}) {
  const messages = [];
  for (const entry of registeredSystemContractProviders) {
    const providerResult = entry.provider(context);
    messages.push(...normalizeProviderResult(entry.toolName, providerResult));
  }
  return messages;
}

module.exports = {
  buildRegisteredSystemContractMessages,
  getRegisteredSystemContractProviders,
  registerSystemContractProvider,
  unregisterSystemContractProvider
};
