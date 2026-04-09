const { resolveProjectIdentity } = require('../../shared/project-identity');

function normalizeLower(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeCompact(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function parseContinuationReady(chatContinuityContext = '', sessionState = null) {
  const text = String(chatContinuityContext || '');
  const match = text.match(/-\s*continuationReady:\s*(yes|no)\b/i);
  if (match) return match[1].toLowerCase() === 'yes';

  const continuity = sessionState?.chatContinuity || sessionState || null;
  if (typeof continuity?.continuationReady === 'boolean') {
    return continuity.continuationReady;
  }

  return null;
}

function detectTaskFamily(userMessage = '') {
  const text = normalizeLower(userMessage);
  if (!text) return 'general';
  if (/\b(pine|pine editor|pine script|pine logs|pine profiler|version history)\b/.test(text)) return 'tradingview-pine';
  if (/\btradingview|trading view|chart|watchlist|indicator|drawing|paper trading\b/.test(text)) return 'tradingview';
  if (/\b(vs code|workspace|repo|repository|codebase|terminal|shell|npm|node|test|lint|tsc|file)\b/.test(text)) return 'repo-editor';
  if (/\b(browser|tab|url|website|page|search)\b/.test(text)) return 'browser';
  return 'general';
}

function buildCompartmentKey({ repoName, appId, surfaceClass, taskFamily }) {
  return [repoName || 'unknown-repo', appId || 'unknown-app', surfaceClass || 'unknown-surface', taskFamily || 'general']
    .map((value) => normalizeLower(value).replace(/[^a-z0-9]+/g, '-'))
    .filter(Boolean)
    .join('::');
}

function buildAmbiguityFlags({ repoName, appId, surfaceClass, explicitTradingViewPineRequest, foregroundTradingView }) {
  const flags = [];
  if (!repoName) flags.push('repo-unknown');
  if (!appId || appId === 'unknown-app') flags.push('app-unknown');
  if (!surfaceClass || surfaceClass === 'unknown') flags.push('surface-unknown');
  if (explicitTradingViewPineRequest && !foregroundTradingView) flags.push('explicit-cross-app-domain-request');
  return flags;
}

function buildExecutionContextEnvelope(options = {}) {
  const {
    capabilitySnapshot = null,
    chatContinuityContext = '',
    cwd = process.cwd(),
    foreground = null,
    sessionIntentContext = '',
    sessionState = null,
    userMessage = ''
  } = options;

  const projectIdentity = resolveProjectIdentity({ cwd });
  const normalizedForeground = capabilitySnapshot?.foreground || foreground || null;
  const appId = normalizeLower(capabilitySnapshot?.appId || normalizedForeground?.processName || 'unknown-app') || 'unknown-app';
  const processName = normalizeLower(normalizedForeground?.processName || appId);
  const windowTitle = normalizeCompact(normalizedForeground?.title || normalizedForeground?.windowTitle || '');
  const surfaceClass = normalizeLower(capabilitySnapshot?.surfaceClass || capabilitySnapshot?.surface?.mode || 'unknown') || 'unknown';
  const interactionMode = normalizeLower(capabilitySnapshot?.surface?.mode || surfaceClass || 'unknown') || 'unknown';
  const overlays = Array.isArray(capabilitySnapshot?.overlays) ? capabilitySnapshot.overlays.map((value) => normalizeLower(value)).filter(Boolean) : [];

  const repoName = normalizeCompact(sessionState?.currentRepo?.repoName || projectIdentity.repoName || projectIdentity.folderName || '');
  const projectRoot = normalizeCompact(sessionState?.currentRepo?.projectRoot || projectIdentity.projectRoot || cwd);
  const downstreamRepoIntent = normalizeCompact(sessionState?.downstreamRepoIntent?.repoName || '');
  const explicitTradingViewRequest = /\btradingview|trading view\b/i.test(String(userMessage || ''));
  const explicitPineRequest = /\b(pine|pine editor|pine script|pine logs|pine profiler|pine version history|script history|version history)\b/i.test(String(userMessage || ''));
  const explicitTradingViewPineRequest = explicitTradingViewRequest || explicitPineRequest;
  const foregroundTradingView = appId === 'tradingview'
    || processName === 'tradingview'
    || overlays.includes('tradingview')
    || /\btradingview|trading view\b/i.test(windowTitle);
  const taskFamily = detectTaskFamily(userMessage);
  const continuationReady = parseContinuationReady(chatContinuityContext, sessionState);
  const tradingViewPineEligible = explicitTradingViewPineRequest || foregroundTradingView;
  const ambiguityFlags = buildAmbiguityFlags({
    repoName,
    appId,
    surfaceClass,
    explicitTradingViewPineRequest,
    foregroundTradingView
  });

  let confidence = 'high';
  if (ambiguityFlags.length >= 2) confidence = 'low';
  else if (ambiguityFlags.length === 1) confidence = 'medium';

  return {
    version: 1,
    cwd,
    repo: {
      name: repoName || 'unknown-repo',
      projectRoot: projectRoot || cwd,
      downstreamRepoIntent: downstreamRepoIntent || null
    },
    foreground: {
      appId,
      processName: processName || null,
      windowTitle: windowTitle || null,
      surfaceClass,
      interactionMode
    },
    taskFamily,
    continuity: {
      continuationReady
    },
    compartmentKey: buildCompartmentKey({ repoName, appId, surfaceClass, taskFamily }),
    confidence,
    ambiguityFlags,
    signals: {
      explicitTradingViewRequest,
      explicitPineRequest,
      explicitTradingViewPineRequest,
      foregroundTradingView,
      hasSessionIntentContext: !!String(sessionIntentContext || '').trim(),
      hasChatContinuityContext: !!String(chatContinuityContext || '').trim()
    },
    eligibility: {
      tradingViewPine: tradingViewPineEligible,
      tradingViewPineReason: explicitTradingViewPineRequest
        ? 'explicit-user-request'
        : foregroundTradingView
          ? 'tradingview-foreground-surface'
          : 'not-eligible'
    }
  };
}

function formatExecutionContextEnvelope(envelope = {}) {
  if (!envelope || typeof envelope !== 'object') return '';

  const lines = [
    '## Execution Context Envelope',
    `- repo: ${envelope.repo?.name || 'unknown-repo'}`,
    `- cwd: ${envelope.cwd || 'unknown'}`,
    `- projectRoot: ${envelope.repo?.projectRoot || 'unknown'}`,
    `- activeApp: ${envelope.foreground?.appId || 'unknown-app'}`,
    `- activeWindow: ${envelope.foreground?.windowTitle || 'unknown'}`,
    `- surfaceClass: ${envelope.foreground?.surfaceClass || 'unknown'}`,
    `- interactionMode: ${envelope.foreground?.interactionMode || 'unknown'}`,
    `- taskFamily: ${envelope.taskFamily || 'general'}`,
    `- compartmentKey: ${envelope.compartmentKey || 'unknown'}`,
    `- tradingViewPineEligible: ${envelope.eligibility?.tradingViewPine ? 'yes' : 'no'} (${envelope.eligibility?.tradingViewPineReason || 'not-eligible'})`,
    `- confidence: ${envelope.confidence || 'unknown'}`
  ];

  if (envelope.repo?.downstreamRepoIntent) {
    lines.push(`- downstreamRepoIntent: ${envelope.repo.downstreamRepoIntent}`);
  }
  if (typeof envelope.continuity?.continuationReady === 'boolean') {
    lines.push(`- continuationReady: ${envelope.continuity.continuationReady ? 'yes' : 'no'}`);
  }
  if (Array.isArray(envelope.ambiguityFlags) && envelope.ambiguityFlags.length > 0) {
    lines.push(`- ambiguityFlags: ${envelope.ambiguityFlags.join(', ')}`);
  }

  return lines.join('\n');
}

function isTradingViewPineContextEligible(envelope = {}) {
  return !!envelope?.eligibility?.tradingViewPine;
}

module.exports = {
  buildExecutionContextEnvelope,
  formatExecutionContextEnvelope,
  isTradingViewPineContextEligible
};