function tokenize(input) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  let quoteChar = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if ((ch === '"' || ch === "'") && (!inQuotes || ch === quoteChar)) {
      if (!inQuotes) {
        inQuotes = true;
        quoteChar = ch;
      } else {
        inQuotes = false;
        quoteChar = null;
      }
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function createSlashCommandHelpers(dependencies) {
  const { modelRegistry } = dependencies;

  function normalizeModelKey(raw) {
    if (!raw) return '';
    let value = String(raw).trim();
    const dashIdx = value.indexOf(' - ');
    if (dashIdx > 0) value = value.slice(0, dashIdx);
    value = value.replace(/^→\s*/, '').trim();
    const lowered = value.toLowerCase();
    const models = modelRegistry();
    if (models[lowered]) {
      return lowered;
    }
    for (const [key, def] of Object.entries(models)) {
      if (String(def && def.id ? def.id : '').toLowerCase() === lowered) {
        return key;
      }
    }
    return lowered;
  }

  return {
    normalizeModelKey,
    tokenize
  };
}

module.exports = {
  createSlashCommandHelpers,
  tokenize
};
