const registeredDecisionTraceContributors = [];

function sortRegisteredDecisionTraceContributors() {
  registeredDecisionTraceContributors.sort((a, b) => {
    const left = Number.isFinite(Number(a.priority)) ? Number(a.priority) : 0;
    const right = Number.isFinite(Number(b.priority)) ? Number(b.priority) : 0;
    if (left !== right) return left - right;
    return String(a.toolName || '').localeCompare(String(b.toolName || ''));
  });
}

function registerDecisionTraceContributor(toolName, contributor, priority = 0) {
  const normalizedToolName = String(toolName || '').trim();
  if (!normalizedToolName) {
    throw new Error('registerDecisionTraceContributor requires a toolName');
  }
  if (!contributor || typeof contributor !== 'object') {
    throw new Error(`registerDecisionTraceContributor requires a contributor object for ${normalizedToolName}`);
  }

  const nextEntry = {
    toolName: normalizedToolName,
    contributor,
    priority: Number.isFinite(Number(priority)) ? Number(priority) : 0
  };

  const existingIndex = registeredDecisionTraceContributors.findIndex((entry) => entry.toolName === normalizedToolName);
  if (existingIndex >= 0) {
    registeredDecisionTraceContributors[existingIndex] = nextEntry;
  } else {
    registeredDecisionTraceContributors.push(nextEntry);
  }

  sortRegisteredDecisionTraceContributors();
  return nextEntry;
}

function unregisterDecisionTraceContributor(toolName) {
  const normalizedToolName = String(toolName || '').trim();
  const existingIndex = registeredDecisionTraceContributors.findIndex((entry) => entry.toolName === normalizedToolName);
  if (existingIndex >= 0) {
    registeredDecisionTraceContributors.splice(existingIndex, 1);
    return true;
  }
  return false;
}

function getRegisteredDecisionTraceContributors() {
  return registeredDecisionTraceContributors.map((entry) => ({
    toolName: entry.toolName,
    priority: entry.priority,
    contributor: entry.contributor
  }));
}

module.exports = {
  getRegisteredDecisionTraceContributors,
  registerDecisionTraceContributor,
  unregisterDecisionTraceContributor
};
