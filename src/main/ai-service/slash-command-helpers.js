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

function parseLongOptions(parts = []) {
  const positionals = [];
  const options = {};

  for (let index = 0; index < parts.length; index += 1) {
    const token = String(parts[index] || '').trim();
    if (!token) {
      continue;
    }

    if (token === '--') {
      positionals.push(...parts.slice(index + 1).map((entry) => String(entry || '').trim()).filter(Boolean));
      break;
    }

    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    let key = token.slice(2);
    let value = true;
    const equalsIndex = key.indexOf('=');
    if (equalsIndex !== -1) {
      value = key.slice(equalsIndex + 1);
      key = key.slice(0, equalsIndex);
    } else if (index + 1 < parts.length && !String(parts[index + 1] || '').trim().startsWith('--')) {
      value = parts[index + 1];
      index += 1;
    }

    if (key) {
      options[key] = value;
    }
  }

  return {
    positionals,
    options,
  };
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
    parseLongOptions,
    tokenize
  };
}

module.exports = {
  createSlashCommandHelpers,
  parseLongOptions,
  tokenize
};
