const registeredRiskAssessors = [];

function sortRegisteredRiskAssessors() {
  registeredRiskAssessors.sort((a, b) => {
    const left = Number.isFinite(Number(a.priority)) ? Number(a.priority) : 0;
    const right = Number.isFinite(Number(b.priority)) ? Number(b.priority) : 0;
    if (left !== right) return left - right;
    return String(a.toolName || '').localeCompare(String(b.toolName || ''));
  });
}

function registerToolRiskAssessor(toolName, assessor, priority = 0) {
  const normalizedToolName = String(toolName || '').trim();
  if (!normalizedToolName) {
    throw new Error('registerToolRiskAssessor requires a toolName');
  }
  if (typeof assessor !== 'function') {
    throw new Error(`registerToolRiskAssessor requires a function assessor for ${normalizedToolName}`);
  }

  const nextEntry = {
    toolName: normalizedToolName,
    assessor,
    priority: Number.isFinite(Number(priority)) ? Number(priority) : 0
  };

  const existingIndex = registeredRiskAssessors.findIndex((entry) => entry.toolName === normalizedToolName);
  if (existingIndex >= 0) {
    registeredRiskAssessors[existingIndex] = nextEntry;
  } else {
    registeredRiskAssessors.push(nextEntry);
  }

  sortRegisteredRiskAssessors();
  return nextEntry;
}

function unregisterToolRiskAssessor(toolName) {
  const normalizedToolName = String(toolName || '').trim();
  const existingIndex = registeredRiskAssessors.findIndex((entry) => entry.toolName === normalizedToolName);
  if (existingIndex >= 0) {
    registeredRiskAssessors.splice(existingIndex, 1);
    return true;
  }
  return false;
}

function getRegisteredToolRiskAssessors() {
  return registeredRiskAssessors.map((entry) => ({
    toolName: entry.toolName,
    priority: entry.priority
  }));
}

function assessRegisteredToolRisk(payload = {}) {
  for (const entry of registeredRiskAssessors) {
    const risk = entry.assessor(payload);
    if (risk) {
      return {
        ...risk,
        toolName: entry.toolName,
        priority: entry.priority
      };
    }
  }

  return null;
}

module.exports = {
  assessRegisteredToolRisk,
  getRegisteredToolRiskAssessors,
  registerToolRiskAssessor,
  unregisterToolRiskAssessor
};
