const registeredToolRewrites = [];

function normalizeRewriteHandlers(rewrites) {
  const handlers = Array.isArray(rewrites) ? rewrites : [rewrites];
  return handlers.filter((handler) => typeof handler === 'function');
}

function sortRegisteredToolRewrites() {
  registeredToolRewrites.sort((a, b) => {
    const left = Number.isFinite(Number(a.priority)) ? Number(a.priority) : 0;
    const right = Number.isFinite(Number(b.priority)) ? Number(b.priority) : 0;
    if (left !== right) return left - right;
    return String(a.toolName || '').localeCompare(String(b.toolName || ''));
  });
}

function registerToolRewrites(toolName, rewrites, priority = 0) {
  const normalizedToolName = String(toolName || '').trim();
  if (!normalizedToolName) {
    throw new Error('registerToolRewrites requires a toolName');
  }

  const handlers = normalizeRewriteHandlers(rewrites);
  if (handlers.length === 0) {
    throw new Error(`registerToolRewrites requires at least one handler for ${normalizedToolName}`);
  }

  const existingIndex = registeredToolRewrites.findIndex((entry) => entry.toolName === normalizedToolName);
  const nextEntry = {
    toolName: normalizedToolName,
    rewrites: handlers,
    priority: Number.isFinite(Number(priority)) ? Number(priority) : 0
  };

  if (existingIndex >= 0) {
    registeredToolRewrites[existingIndex] = nextEntry;
  } else {
    registeredToolRewrites.push(nextEntry);
  }

  sortRegisteredToolRewrites();
  return nextEntry;
}

function unregisterToolRewrites(toolName) {
  const normalizedToolName = String(toolName || '').trim();
  const existingIndex = registeredToolRewrites.findIndex((entry) => entry.toolName === normalizedToolName);
  if (existingIndex >= 0) {
    registeredToolRewrites.splice(existingIndex, 1);
    return true;
  }
  return false;
}

function getRegisteredToolRewrites() {
  return registeredToolRewrites.map((entry) => ({
    toolName: entry.toolName,
    priority: entry.priority,
    rewriteCount: entry.rewrites.length
  }));
}

function applyRegisteredToolRewrites(actions, context = {}) {
  for (const entry of registeredToolRewrites) {
    for (const rewrite of entry.rewrites) {
      const rewritten = rewrite(actions, context);
      if (Array.isArray(rewritten) && rewritten !== actions) {
        return {
          actions: rewritten,
          matched: true,
          toolName: entry.toolName,
          priority: entry.priority
        };
      }
    }
  }

  return {
    actions,
    matched: false,
    toolName: null,
    priority: null
  };
}

module.exports = {
  applyRegisteredToolRewrites,
  getRegisteredToolRewrites,
  registerToolRewrites,
  unregisterToolRewrites
};
