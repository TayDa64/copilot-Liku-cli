const DEFAULT_PINE_SCRIPT_TITLE = 'Liku Pine Script';

const GENERIC_TITLES = new Set([
  'liku pine script',
  'pine script',
  'script',
  'indicator',
  'strategy',
  'library',
  'my script',
  'untitled script',
  'new indicator',
  'new strategy',
  'new library'
]);

const FEATURE_PATTERNS = Object.freeze([
  { label: 'ATR', pattern: /\batr\b|average true range/i },
  { label: 'VWAP', pattern: /\bvwap\b|volume weighted average price/i },
  { label: 'MACD', pattern: /\bmacd\b|moving average convergence divergence/i },
  { label: 'RSI', pattern: /\brsi\b|relative strength index/i },
  { label: 'EMA', pattern: /\bema\b|exponential moving average/i },
  { label: 'SMA', pattern: /\bsma\b|simple moving average/i },
  { label: 'ADX', pattern: /\badx\b|average directional index/i },
  { label: 'OBV', pattern: /\bobv\b|on balance volume/i },
  { label: 'MFI', pattern: /\bmfi\b|money flow index/i },
  { label: 'ROC', pattern: /\broc\b|rate of change/i },
  { label: 'BB', pattern: /\bbb\b|\bbollinger bands?\b/i },
  { label: 'Stoch RSI', pattern: /\bstoch(?:astic)?\s*rsi\b/i },
  { label: 'Supertrend', pattern: /\bsupertrend\b/i },
  { label: 'Ichimoku', pattern: /\bichimoku\b/i },
  { label: 'Volume', pattern: /\bvolume\b/i },
  { label: 'Momentum', pattern: /\bmomentum\b/i }
]);

const SEMANTIC_PATTERNS = Object.freeze([
  { label: 'Confidence', pattern: /\bconfidence\b|confidence building/i },
  { label: 'Momentum', pattern: /\bmomentum\b/i },
  { label: 'Trend', pattern: /\btrend\b|trend following/i },
  { label: 'Volatility', pattern: /\bvolatility\b/i },
  { label: 'Volume', pattern: /\bvolume\b/i },
  { label: 'Breakout', pattern: /\bbreakout\b/i },
  { label: 'Reversal', pattern: /\breversal\b/i },
  { label: 'Range', pattern: /\brange\b|mean reversion/i }
]);

function sanitizePineScriptName(value = '') {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .trim()
    .slice(0, 120);
}

function normalizeTitleForMatch(value = '') {
  return sanitizePineScriptName(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isGenericPineScriptTitle(value = '') {
  const normalized = normalizeTitleForMatch(value);
  if (!normalized) return true;
  return GENERIC_TITLES.has(normalized);
}

function extractPineDeclarationTitle(text = '') {
  const match = String(text || '').match(/\b(?:indicator|strategy|library)\s*\(\s*["'`](.*?)["'`]/i);
  return sanitizePineScriptName(match?.[1] || '');
}

function detectPineScriptKind({ userMessage = '', source = '' } = {}) {
  const combined = `${String(userMessage || '')}\n${String(source || '')}`;
  if (/\blibrary\s*\(/i.test(combined) || /\blibrary\b/i.test(userMessage)) return 'library';
  if (/\bstrategy\s*\(/i.test(combined) || /\bstrategy\b/i.test(userMessage)) return 'strategy';
  return 'indicator';
}

function extractExplicitUserRequestedPineTitle(userMessage = '') {
  const raw = String(userMessage || '').trim();
  if (!raw) return '';

  const patterns = [
    /\b(?:called|named|title(?:d)?|save(?:\s+it)?\s+as)\s+["'`](.*?)["'`]/i,
    /\b(?:called|named|title(?:d)?|save(?:\s+it)?\s+as)\s+([A-Z][A-Za-z0-9 _+\-]{2,80})(?=[,.]|$)/i
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const title = sanitizePineScriptName(match?.[1] || '');
    if (title) {
      return title;
    }
  }

  return '';
}

function collectMatchedLabels(text = '', patterns = []) {
  const source = String(text || '');
  if (!source) return [];

  const labels = [];
  for (const entry of patterns) {
    if (!entry?.label || !entry?.pattern) continue;
    if (entry.pattern.test(source) && !labels.includes(entry.label)) {
      labels.push(entry.label);
    }
  }
  return labels;
}

function buildFeatureSynthesizedTitle({ userMessage = '', source = '', kind = 'indicator' } = {}) {
  const combined = `${String(userMessage || '')}\n${String(source || '')}`;
  const featureLabels = collectMatchedLabels(combined, FEATURE_PATTERNS)
    .filter((label) => label !== 'Volume' && label !== 'Momentum');
  const semanticLabels = collectMatchedLabels(combined, SEMANTIC_PATTERNS);

  const titleTokens = [];
  for (const label of featureLabels.slice(0, 4)) {
    if (!titleTokens.includes(label)) {
      titleTokens.push(label);
    }
  }

  for (const label of semanticLabels) {
    if (label === 'Volume' && featureLabels.includes('Volume')) continue;
    if (label === 'Momentum' && featureLabels.includes('Momentum')) continue;
    if (!titleTokens.includes(label)) {
      titleTokens.push(label);
    }
  }

  if (titleTokens.length === 0) {
    const kindLabel = kind === 'strategy'
      ? 'Strategy'
      : kind === 'library'
        ? 'Library'
        : 'Indicator';
    return {
      title: DEFAULT_PINE_SCRIPT_TITLE,
      featureLabels,
      semanticLabels,
      synthesized: false,
      fallbackKindLabel: kindLabel
    };
  }

  const title = sanitizePineScriptName(titleTokens.join(' '));
  return {
    title: title || DEFAULT_PINE_SCRIPT_TITLE,
    featureLabels,
    semanticLabels,
    synthesized: !!title
  };
}

function preferSynthesizedTitleOverDeclaration(declarationTitle = '', synthesizedTitle = '') {
  const normalizedDeclaration = sanitizePineScriptName(declarationTitle);
  const normalizedSynthesized = sanitizePineScriptName(synthesizedTitle);
  if (!normalizedDeclaration || !normalizedSynthesized) return false;
  if (normalizedDeclaration === normalizedSynthesized) return false;

  const declarationLooksNoisy = /[[\]()]/.test(normalizedDeclaration)
    || normalizedDeclaration.length > 42
    || /\b(?:liku|chart|tradingview)\b/i.test(normalizedDeclaration);
  return declarationLooksNoisy;
}

function synthesizePineScriptTitleContract(options = {}) {
  const userMessage = String(options.userMessage || options.intent || '').trim();
  const source = String(options.source || '').trim();
  const canonicalTitle = sanitizePineScriptName(options.canonicalTitle || '');
  const declarationTitle = extractPineDeclarationTitle(source);
  const explicitUserTitle = extractExplicitUserRequestedPineTitle(userMessage);
  const kind = detectPineScriptKind({ userMessage, source });
  const featureSynthesis = buildFeatureSynthesizedTitle({ userMessage, source, kind });

  let title = '';
  let sourceKind = 'fallback';
  let authoritative = false;

  if (explicitUserTitle) {
    title = explicitUserTitle;
    sourceKind = 'prompt-explicit';
    authoritative = true;
  } else if (canonicalTitle && !isGenericPineScriptTitle(canonicalTitle)) {
    title = canonicalTitle;
    sourceKind = 'canonical-state';
    authoritative = true;
  } else if (
    declarationTitle
    && !isGenericPineScriptTitle(declarationTitle)
    && !preferSynthesizedTitleOverDeclaration(declarationTitle, featureSynthesis.title)
  ) {
    title = declarationTitle;
    sourceKind = 'declaration';
    authoritative = false;
  } else if (featureSynthesis.synthesized) {
    title = featureSynthesis.title;
    sourceKind = 'feature-synthesis';
    authoritative = false;
  } else if (declarationTitle && !isGenericPineScriptTitle(declarationTitle)) {
    title = declarationTitle;
    sourceKind = 'declaration';
    authoritative = false;
  } else {
    title = DEFAULT_PINE_SCRIPT_TITLE;
    sourceKind = 'fallback';
    authoritative = false;
  }

  return {
    title: sanitizePineScriptName(title) || DEFAULT_PINE_SCRIPT_TITLE,
    kind,
    sourceKind,
    authoritative,
    explicitUserTitle: explicitUserTitle || null,
    canonicalTitle: canonicalTitle || null,
    declarationTitle: declarationTitle || null,
    featureLabels: featureSynthesis.featureLabels || [],
    semanticLabels: featureSynthesis.semanticLabels || []
  };
}

function applyPineScriptTitleContract(source = '', titleContract = null) {
  const normalizedSource = String(source || '');
  const expectedTitle = sanitizePineScriptName(titleContract?.title || '');
  if (!normalizedSource || !expectedTitle) {
    return normalizedSource;
  }

  return normalizedSource.replace(
    /\b(indicator|strategy|library)\s*\(\s*(["'`])([\s\S]*?)\2/i,
    (_match, kind, quote) => `${kind}(${quote}${expectedTitle}${quote}`
  );
}

module.exports = {
  DEFAULT_PINE_SCRIPT_TITLE,
  sanitizePineScriptName,
  isGenericPineScriptTitle,
  extractPineDeclarationTitle,
  extractExplicitUserRequestedPineTitle,
  synthesizePineScriptTitleContract,
  applyPineScriptTitleContract
};
