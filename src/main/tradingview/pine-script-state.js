const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sanitizePineHeaderNoise(value = '') {
  let raw = String(value || '');
  if (!raw) return raw;
  raw = raw.replace(/^\uFEFF/, '');
  raw = raw.replace(/(^|[\r\n])\s*(?:pine\s*editor|ine\s*editor)\s*(?=\/\/\s*@version\b)/ig, '$1');
  const versionMatch = raw.match(/\/\/\s*@version\s*=\s*\d+\b/i);
  if (versionMatch && versionMatch.index > 0) {
    const prefix = raw.slice(0, versionMatch.index);
    if (/\b(?:pine\s*editor|ine\s*editor)\b/i.test(prefix)) {
      raw = raw.slice(versionMatch.index);
    }
  }
  return raw;
}

function normalizePineScriptSource(source = '') {
  let normalized = sanitizePineHeaderNoise(String(source || '').trim());
  if (!normalized) return '';

  if (/\/\/\s*@version\s*=\s*\d+\b/i.test(normalized)) {
    normalized = normalized.replace(/\/\/\s*@version\s*=\s*\d+\b/i, '//@version=6');
  } else {
    normalized = `//@version=6\n${normalized}`;
  }

  return normalized.trim();
}

function inferPineScriptTitle(source = '') {
  const normalized = normalizePineScriptSource(source);
  const titleMatch = normalized.match(/\b(?:indicator|strategy|library)\s*\(\s*["'`](.*?)["'`]/i);
  return String(titleMatch?.[1] || 'Liku Pine Script').trim() || 'Liku Pine Script';
}

function validatePineScriptStateSource(source = '') {
  const normalizedSource = normalizePineScriptSource(source);
  const issues = [];

  if (!normalizedSource) {
    issues.push({
      code: 'empty-source',
      message: 'Pine source is empty after normalization.'
    });
  } else {
    const lines = normalizedSource.split(/\r?\n/);
    const firstLine = String(lines[0] || '').trim();
    if (firstLine !== '//@version=6') {
      issues.push({
        code: 'invalid-version-header',
        message: 'The first Pine line must be exactly //@version=6.'
      });
    }

    if (!/\b(?:indicator|strategy|library)\s*\(/i.test(normalizedSource)) {
      issues.push({
        code: 'missing-declaration',
        message: 'Pine source must include an indicator(), strategy(), or library() declaration.'
      });
    }

    const uiContaminationMatches = normalizedSource.match(/(?:pine\s*editor|ine\s*editor)/ig) || [];
    if (uiContaminationMatches.length > 0) {
      issues.push({
        code: 'ui-contamination',
        message: 'Pine source still contains Pine Editor UI text contamination inside the script body.',
        count: uiContaminationMatches.length
      });
    }

    if (/[A-Za-z](?:pine\s*editor|ine\s*editor)[A-Za-z]/i.test(normalizedSource)) {
      issues.push({
        code: 'identifier-corruption',
        message: 'Pine source contains a corrupted identifier bridged through Pine Editor UI text.'
      });
    }

    const delimiterPairs = [
      ['(', ')', 'paren-balance'],
      ['[', ']', 'bracket-balance'],
      ['{', '}', 'brace-balance']
    ];
    for (const [openChar, closeChar, code] of delimiterPairs) {
      const opens = (normalizedSource.match(new RegExp(`\\${openChar}`, 'g')) || []).length;
      const closes = (normalizedSource.match(new RegExp(`\\${closeChar}`, 'g')) || []).length;
      if (opens !== closes) {
        issues.push({
          code,
          message: `Pine source has unbalanced ${openChar}${closeChar} delimiters.`,
          opens,
          closes
        });
      }
    }
  }

  return {
    valid: issues.length === 0,
    issueCount: issues.length,
    issues
  };
}

function buildPineScriptState({ source = '', intent = '', origin = 'generated', targetApp = 'tradingview' } = {}) {
  const normalizedSource = normalizePineScriptSource(source);
  const sourceHash = crypto.createHash('sha256').update(normalizedSource, 'utf8').digest('hex');
  const scriptTitle = inferPineScriptTitle(normalizedSource);
  const createdAt = new Date().toISOString();
  const validation = validatePineScriptStateSource(normalizedSource);

  return {
    id: `pine-${sourceHash.slice(0, 12)}`,
    createdAt,
    origin,
    targetApp,
    intent: String(intent || '').trim() || null,
    scriptTitle,
    sourceHash,
    normalizedSource,
    validation
  };
}

function persistPineScriptState(state, { cwd = process.cwd() } = {}) {
  if (!state || typeof state !== 'object' || !state.normalizedSource) {
    return null;
  }

  const rootDir = path.join(String(cwd || process.cwd()), '.liku', 'pine-state');
  fs.mkdirSync(rootDir, { recursive: true });

  const baseName = `${state.id}-${state.sourceHash.slice(0, 8)}`;
  const sourcePath = path.join(rootDir, `${baseName}.pine`);
  const metadataPath = path.join(rootDir, `${baseName}.json`);

  fs.writeFileSync(sourcePath, `${state.normalizedSource}\n`, 'utf8');
  fs.writeFileSync(metadataPath, `${JSON.stringify({
    ...state,
    sourcePath
  }, null, 2)}\n`, 'utf8');

  return {
    sourcePath,
    metadataPath
  };
}

function escapePowerShellSingleQuotedString(value = '') {
  return String(value || '').replace(/'/g, "''");
}

function buildPineClipboardPreparationCommandFromCanonicalState(canonicalState = {}) {
  if (canonicalState?.validation?.valid === false) return '';

  const sourcePath = String(canonicalState?.sourcePath || '').trim();
  if (!sourcePath) return '';

  const resolvedPath = path.resolve(sourcePath);
  const escapedPath = escapePowerShellSingleQuotedString(resolvedPath);
  return [
    `$sourcePath = '${escapedPath}'`,
    'if (!(Test-Path -LiteralPath $sourcePath)) {',
    '  throw "Persisted Pine state file not found: $sourcePath"',
    '}',
    'Set-Clipboard -Value (Get-Content -LiteralPath $sourcePath -Raw)'
  ].join('\n');
}

module.exports = {
  normalizePineScriptSource,
  inferPineScriptTitle,
  validatePineScriptStateSource,
  buildPineScriptState,
  persistPineScriptState,
  buildPineClipboardPreparationCommandFromCanonicalState
};
