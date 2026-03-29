#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  buildClaimBoundConstraint,
  buildProofCarryingAnswerPrompt,
  buildProofCarryingObservationFallback
} = require(path.join(__dirname, '..', 'src', 'main', 'claim-bounds.js'));

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

test('proof-carrying answer prompt requires explicit claim sections', () => {
  const prompt = buildProofCarryingAnswerPrompt({
    userMessage: 'summarize the current TradingView chart',
    continuity: {
      currentSubgoal: 'TradingView - LUNR'
    }
  });

  assert(prompt.includes('Verified result'));
  assert(prompt.includes('Bounded inference'));
  assert(prompt.includes('Degraded evidence'));
  assert(prompt.includes('Unverified next step'));
  assert(prompt.includes('Respond now in natural language only'));
});

test('proof-carrying observation fallback surfaces degraded evidence separately', () => {
  const fallback = buildProofCarryingObservationFallback({
    userMessage: 'analyze the chart',
    latestVisual: {
      captureMode: 'screen-copyfromscreen',
      captureTrusted: false,
      windowTitle: 'TradingView - LUNR'
    },
    continuity: {
      degradedReason: 'Visual evidence fell back to full-screen capture instead of a trusted target-window capture.',
      lastTurn: {
        nextRecommendedStep: 'Recapture the target window before continuing with chart-specific claims.'
      }
    }
  });

  assert(fallback.includes('proof-carrying-observation-fallback'));
  assert(fallback.includes('Verified result:'));
  assert(fallback.includes('Bounded inference:'));
  assert(fallback.includes('Degraded evidence:'));
  assert(fallback.includes('Unverified next step:'));
  assert(fallback.includes('Visual evidence fell back to full-screen capture instead of a trusted target-window capture.'));
});

test('claim-bound system constraint activates on degraded TradingView evidence', () => {
  const constraint = buildClaimBoundConstraint({
    latestVisual: {
      captureMode: 'screen-copyfromscreen',
      captureTrusted: false
    },
    foreground: {
      processName: 'tradingview',
      title: 'TradingView - LUNR'
    },
    capability: {
      mode: 'visual-first-low-uia'
    },
    userMessage: 'summarize the TradingView chart',
    chatContinuityContext: 'continuationReady: no\ndegradedReason: Visual evidence fell back'
  });

  assert(constraint.includes('## Answer Claim Contract'));
  assert(constraint.includes('Verified result'));
  assert(constraint.includes('Degraded evidence'));
});