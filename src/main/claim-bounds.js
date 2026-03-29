function isScreenLikeCaptureMode(captureMode) {
  const normalized = String(captureMode || '').trim().toLowerCase();
  return normalized === 'screen'
    || normalized === 'fullscreen-fallback'
    || normalized.startsWith('screen-')
    || normalized.includes('fullscreen');
}

function deriveClaimBoundContext({ latestVisual, continuity, fallbackTarget, nextRecommendedStep } = {}) {
  const captureMode = String(
    latestVisual?.captureMode
    || latestVisual?.scope
    || continuity?.lastTurn?.captureMode
    || 'unknown'
  ).trim() || 'unknown';
  const captureTrusted = typeof latestVisual?.captureTrusted === 'boolean'
    ? latestVisual.captureTrusted
    : (typeof continuity?.lastTurn?.captureTrusted === 'boolean' ? continuity.lastTurn.captureTrusted : null);
  const targetWindow = String(
    latestVisual?.windowTitle
    || continuity?.lastTurn?.windowTitle
    || fallbackTarget
    || continuity?.currentSubgoal
    || continuity?.activeGoal
    || 'current target window'
  ).trim();
  const degradedReason = String(continuity?.degradedReason || '').trim();
  const recommendedStep = String(
    nextRecommendedStep
    || continuity?.lastTurn?.nextRecommendedStep
    || 'Recapture the target window or perform a narrower verification step before making stronger claims.'
  ).trim();
  const degraded = captureTrusted === false || isScreenLikeCaptureMode(captureMode) || Boolean(degradedReason);
  const evidenceQuality = degraded
    ? `degraded-${captureMode}`
    : `trusted-${captureMode}`;

  return {
    captureMode,
    captureTrusted,
    degraded,
    degradedReason,
    evidenceQuality,
    nextRecommendedStep: recommendedStep,
    targetWindow
  };
}

function buildProofCarryingAnswerPrompt({ userMessage, latestVisual, continuity, inventoryMode = false } = {}) {
  const context = deriveClaimBoundContext({ latestVisual, continuity });
  const inventoryHint = inventoryMode
    ? 'Inside Bounded inference, organize the available-tools portion into exactly three buckets: direct UIA controls, reliable keyboard/window controls, and visible but screenshot-only controls.'
    : 'Answer as a direct observation of the current app/window state.';

  return [
    `You already have fresh visual context for ${context.targetWindow}.`,
    'Do NOT request or plan another screenshot unless the latest capture explicitly failed or the screen materially changed.',
    'Respond now in natural language only — no JSON action block.',
    'Format the answer using exactly these four headings: Verified result, Bounded inference, Degraded evidence, Unverified next step.',
    'Keep directly observed facts separate from interpretation, explicitly name degraded or mixed-desktop evidence, and put retries or recapture guidance only in Unverified next step.',
    inventoryHint,
    userMessage ? `User request: ${String(userMessage).trim()}` : ''
  ].filter(Boolean).join(' ');
}

function buildProofCarryingObservationFallback({ userMessage, latestVisual, continuity, inventoryMode = false } = {}) {
  const context = deriveClaimBoundContext({ latestVisual, continuity });

  const verifiedResultLines = [
    `- I already have fresh visual context for ${context.targetWindow}.`,
    `- Evidence quality: ${context.evidenceQuality}.`
  ];

  let boundedInferenceLines;
  if (inventoryMode) {
    boundedInferenceLines = [
      '- Direct UIA controls: sparse or uncertain from the current low-UIA/visual-first context unless Live UI State explicitly lists them.',
      '- Reliable keyboard/window controls: focus or restore the target window, use known keyboard shortcuts, and capture verified screenshots or panel transitions.',
      context.degraded
        ? `- Visible but screenshot-only controls: the current image is degraded (${context.captureMode}), so visible controls may be mixed with other desktop content and should be treated as uncertain until re-captured.`
        : `- Visible but screenshot-only controls: the current image is a trusted ${context.captureMode} capture, so visible controls can be described, but they still should not be treated as directly targetable unless UIA or verified workflows support them.`
    ];
  } else {
    boundedInferenceLines = [
      '- I can give a high-level, bounded description of what is visible in the current target window and what recent verified actions achieved.',
      '- I should avoid exact numeric, placement, or fine-grained UI claims unless the current evidence makes them directly legible.'
    ];
  }

  const degradedEvidenceLines = context.degraded
    ? [
      `- The current evidence is degraded or mixed-trust (${context.captureMode}).`,
      `- ${context.degradedReason || 'The visible state may include mixed desktop content or stale context, so exact UI or chart claims would overstate what is proven.'}`
    ]
    : [
      '- none',
      '- The current evidence is trusted enough for bounded description, but unsupported detail still remains unverified.'
    ];

  const unverifiedNextStepLines = [
    `- ${context.nextRecommendedStep}`,
    '- Treat exact indicator values, exact drawing placement, hidden dialog state, or unseen controls as unverified until a narrower verification step confirms them.'
  ];

  return [
    'bounded-observation-fallback',
    'proof-carrying-observation-fallback',
    '',
    'Verified result:',
    ...verifiedResultLines,
    '',
    'Bounded inference:',
    ...boundedInferenceLines,
    '',
    'Degraded evidence:',
    ...degradedEvidenceLines,
    '',
    'Unverified next step:',
    ...unverifiedNextStepLines,
    userMessage ? `\nUser request: ${String(userMessage).trim()}` : ''
  ].filter(Boolean).join('\n');
}

function buildClaimBoundConstraint({ latestVisual, capability, foreground, userMessage, chatContinuityContext } = {}) {
  const processName = String(foreground?.processName || '').trim().toLowerCase();
  const mode = String(capability?.mode || '').trim().toLowerCase();
  const contextText = String(chatContinuityContext || '').trim().toLowerCase();
  const captureMode = String(latestVisual?.captureMode || latestVisual?.scope || '').trim();
  const captureTrusted = latestVisual?.captureTrusted;
  const lowTrustEvidence = captureTrusted === false
    || isScreenLikeCaptureMode(captureMode)
    || mode === 'visual-first-low-uia'
    || /degradedreason:|continuationready:\s*no|lastverificationstatus:\s*(?:contradicted|unverified)/.test(contextText)
    || /tradingview/.test(processName)
    || /tradingview|chart|ticker|candlestick|pine/.test(String(userMessage || '').toLowerCase());

  if (!lowTrustEvidence) return '';

  return [
    '## Answer Claim Contract',
    '- If you answer from current visual or recent execution evidence, structure the answer into exactly these headings: Verified result, Bounded inference, Degraded evidence, Unverified next step.',
    '- Rule: Put only directly supported observations or verified execution outcomes in Verified result.',
    '- Rule: Put interpretation, synthesis, or likely-but-not-proven implications in Bounded inference.',
    '- Rule: If evidence is degraded, stale, contradicted, mixed-desktop, or low-UIA, say that explicitly in Degraded evidence instead of blending it into the verified facts.',
    '- Rule: Put recapture, retry, or narrower verification guidance in Unverified next step, and do not present those future checks as completed facts.'
  ].join('\n');
}

module.exports = {
  buildClaimBoundConstraint,
  buildProofCarryingAnswerPrompt,
  buildProofCarryingObservationFallback,
  deriveClaimBoundContext,
  isScreenLikeCaptureMode
};