const registeredLifecycleHooks = [];

function sortRegisteredLifecycleHooks() {
  registeredLifecycleHooks.sort((a, b) => {
    const left = Number.isFinite(Number(a.priority)) ? Number(a.priority) : 0;
    const right = Number.isFinite(Number(b.priority)) ? Number(b.priority) : 0;
    if (left !== right) return left - right;
    return String(a.toolName || '').localeCompare(String(b.toolName || ''));
  });
}

function registerLifecycleHooks(toolName, hooks, priority = 0) {
  const normalizedToolName = String(toolName || '').trim();
  if (!normalizedToolName) {
    throw new Error('registerLifecycleHooks requires a toolName');
  }
  if (!hooks || typeof hooks !== 'object') {
    throw new Error(`registerLifecycleHooks requires a hooks object for ${normalizedToolName}`);
  }

  const nextEntry = {
    toolName: normalizedToolName,
    hooks,
    priority: Number.isFinite(Number(priority)) ? Number(priority) : 0
  };

  const existingIndex = registeredLifecycleHooks.findIndex((entry) => entry.toolName === normalizedToolName);
  if (existingIndex >= 0) {
    registeredLifecycleHooks[existingIndex] = nextEntry;
  } else {
    registeredLifecycleHooks.push(nextEntry);
  }

  sortRegisteredLifecycleHooks();
  return nextEntry;
}

function unregisterLifecycleHooks(toolName) {
  const normalizedToolName = String(toolName || '').trim();
  const existingIndex = registeredLifecycleHooks.findIndex((entry) => entry.toolName === normalizedToolName);
  if (existingIndex >= 0) {
    registeredLifecycleHooks.splice(existingIndex, 1);
    return true;
  }
  return false;
}

function getRegisteredLifecycleHooks() {
  return registeredLifecycleHooks.map((entry) => ({
    toolName: entry.toolName,
    priority: entry.priority,
    hookNames: Object.keys(entry.hooks || {}).filter((name) => typeof entry.hooks[name] === 'function')
  }));
}

function runLifecycleHook(hookName, payload = {}, fallback = undefined) {
  const normalizedHookName = String(hookName || '').trim();
  if (!normalizedHookName) {
    throw new Error('runLifecycleHook requires a hookName');
  }

  for (const entry of registeredLifecycleHooks) {
    const hook = entry.hooks?.[normalizedHookName];
    if (typeof hook !== 'function') continue;
    const result = hook(payload);
    if (result !== undefined) {
      return result;
    }
  }

  return typeof fallback === 'function' ? fallback(payload) : fallback;
}

module.exports = {
  getRegisteredLifecycleHooks,
  registerLifecycleHooks,
  runLifecycleHook,
  unregisterLifecycleHooks
};
