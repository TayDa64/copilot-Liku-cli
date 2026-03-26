# Chat Continuity Implementation Plan

## Purpose

Turn the recent `liku chat` fixes into a durable continuity architecture so multi-turn desktop workflows stay grounded in:

1. the user's active goal,
2. the assistant's last committed subgoal,
3. the exact actions executed,
4. the evidence gathered after execution,
5. and the verification status of the claimed result.

This plan is grounded in the current repo structure:

- CLI turn loop in `src/cli/commands/chat.js`
- action execution facade in `src/main/ai-service.js`
- existing session state in `src/main/session-intent-state.js`
- prompt assembly in `src/main/ai-service/message-builder.js`
- UI watcher / visual context seams under `src/main/ai-service/ui-context.js` and `src/main/ai-service/visual-context.js`

## Why this is needed

The current implementation fixed two real bugs:

- valid synthesis/action plans were sometimes withheld as non-action text,
- natural continuation prompts like `lets continue with next steps, maintain continuity` were too narrowly classified.

Those fixes are good and should stay, but they also exposed the next-level weakness: continuity still depends too heavily on conversational phrasing and too weakly on structured execution state.

### Current weak points in the codebase

1. **Continuation is still largely inferred from text**
   - `chat.js` uses regex-based intent detection (`isLikelyApprovalOrContinuationInput`, `shouldExecuteDetectedActions`).
   - This is useful as a guardrail, but not strong enough to carry a multi-step workflow across turns.

2. **Executed actions are not persisted as a first-class continuity object**
   - `ai-service.js` executes actions and can resume after confirmation, but the resulting state is not stored as a structured turn record that future turns can consume directly.

3. **Screenshot trust is not explicit enough**
   - The code now preserves screenshot scope/target intent better, but follow-up reasoning can still treat fallback full-screen capture too similarly to a target-window capture.

4. **Verification is shallow for UI-changing steps**
   - Liku can focus windows and take screenshots, but it does not yet consistently prove that a requested state change actually happened (for example: timeframe changed, indicator added, dialog opened).

5. **Tests cover actionability better than continuity coherence**
   - Existing regressions prove whether actions are executed or withheld.
   - They do not yet fully prove whether the *next turn* is grounded in the *previous turn's actual outputs*.

## Desired end state

For any actionable turn, Liku should be able to answer these questions deterministically before continuing:

- What is the current user goal?
- What subgoal was last committed?
- What actions were actually executed?
- What evidence came back?
- Was the intended effect verified, unverified, or contradicted?
- What is the next safe step?

If those answers are not available, Liku should either:

- ask a clarifying question,
- gather fresh evidence,
- or explicitly say continuity is degraded.

## Architectural direction

### 1. Extend session state instead of creating parallel memory

**Reuse:** `src/main/session-intent-state.js`

This module already persists session-scoped intent and correction data under `~/.liku/`. It is the right place to anchor continuity metadata because it already:

- loads/saves JSON state,
- syncs to the current repo,
- formats prompt context,
- and preserves recent user-level intent corrections.

### Proposed schema extension

Add a new top-level object, for example:

```json
{
  "chatContinuity": {
    "activeGoal": null,
    "currentSubgoal": null,
    "lastTurn": null,
    "continuationReady": false,
    "degradedReason": null
  }
}
```

And a `lastTurn` payload like:

```json
{
  "turnId": "uuid-or-timestamp",
  "recordedAt": "ISO timestamp",
  "userMessage": "lets continue with next steps, maintain continuity",
  "executionIntent": "help me make a confident synthesis of ticker LUNR in tradingview",
  "committedSubgoal": "Inspect the active TradingView chart and gather evidence for synthesis",
  "actionPlan": [
    { "type": "focus_window", "windowTitle": "TradingView" },
    { "type": "wait", "durationMs": 1200 },
    { "type": "screenshot", "scope": "active-window" }
  ],
  "executionResult": {
    "cancelled": false,
    "executedCount": 3,
    "failures": [],
    "targetWindowHandle": 123456,
    "focusVerified": true
  },
  "observationEvidence": {
    "captureMode": "active-window|fullscreen-fallback|region",
    "captureTrusted": true,
    "visualContextId": "...",
    "windowTitle": "TradingView - LUNR",
    "uiWatcherFresh": true
  },
  "verification": {
    "status": "verified|unverified|contradicted|not-applicable",
    "checks": [
      { "name": "target-window-focused", "status": "verified" }
    ]
  },
  "nextRecommendedStep": "Summarize visible chart signals before modifying indicators"
}
```

## Implementation phases

## Phase 1 — Persist structured continuity state

### Goal
Stop relying on chat phrasing as the primary continuity carrier.

### Changes

#### A. Add continuity helpers to `session-intent-state.js`
Add functions such as:

- `updateChatContinuity(partialUpdate, options)`
- `getChatContinuityState(options)`
- `clearChatContinuityState(options)`
- `recordExecutedTurn(turnRecord, options)`
- `markContinuityDegraded(reason, options)`

#### B. Build a small continuity mapper
Create a new internal module, for example:

- `src/main/chat-continuity-state.js`

Responsibilities:

- normalize action plans,
- normalize execution results,
- normalize screenshot evidence,
- produce compact prompt-ready summaries,
- decide whether continuity is safe, degraded, or blocked.

This keeps `ai-service.js` from growing more monolithic.

#### C. Capture committed subgoal before execution
In `chat.js` and/or `ai-service.js`, store:

- the user goal for the turn,
- the subgoal the assistant is about to execute,
- and whether the next turn should continue that subgoal or branch.

### Acceptance criteria

- A completed actionable turn leaves behind a structured continuity record on disk.
- A follow-up `continue` turn can read continuity state even if the phrasing is brief.
- Clearing chat/session state also clears continuity state intentionally.

## Phase 2 — Feed structured execution results back into the next turn

### Goal
Make follow-up reasoning consume actual results instead of reconstructing them from chat text.

### Changes

#### A. Extend `ai-service.js` execution pipeline
After `executeActions(...)` and `resumeAfterConfirmation(...)`, build a continuity result object containing:

- normalized action list,
- per-action success/failure,
- target window metadata,
- screenshot metadata,
- watcher freshness,
- verification stubs.

#### B. Add a continuity summary formatter
Expose a compact formatter that can inject something like this into the next model call:

```text
## Recent Action Continuity
- activeGoal: Produce a confident synthesis of ticker LUNR in TradingView
- committedSubgoal: Inspect the active TradingView chart
- executedActions: focus_window -> wait -> screenshot(active-window)
- result: screenshot captured via fullscreen fallback
- verification: target window focused = verified; chart-specific visual verification = unverified
- nextRecommendedStep: Ask the model to reason only from confirmed evidence and request re-capture if chart-specific evidence is insufficient
```

#### C. Wire continuity into `message-builder.js`
Continuity should be an explicit prompt segment, similar to how the repo already injects:

- relevant skills,
- working memory,
- live UI context,
- visual context.

### Acceptance criteria

- The next turn sees a structured summary of the last executed step.
- Continuation can proceed even if the user only says `continue`.
- The assistant can explicitly distinguish `verified continuation` from `degraded continuation`.

## Phase 3 — Add verification contracts for UI-changing actions

### Goal
Prevent the model from claiming a UI change succeeded unless evidence supports it.

### Changes

#### A. Introduce action-specific verification hints
When actions are parsed or normalized, allow optional verification metadata, for example:

```json
{
  "type": "press_key",
  "key": "/",
  "verify": {
    "kind": "dialog-visible",
    "target": "indicator-search"
  }
}
```

Useful verification kinds:

- `target-window-focused`
- `dialog-visible`
- `menu-open`
- `text-visible`
- `indicator-present`
- `timeframe-updated`
- `watchlist-updated`

#### B. Add verifier utilities
Potential module:

- `src/main/action-verification.js`

Responsibilities:

- consume watcher state,
- inspect current UI context,
- optionally use screenshot-derived cues,
- return `verified`, `unverified`, or `contradicted`.

#### C. Make weak evidence explicit
If capture falls back to full screen, the verification result should reflect that reduced trust.

Example:

- `captureTrusted: false`
- `reason: active-window capture unavailable; screenshot includes more than target app`

### Acceptance criteria

- The assistant does not overclaim success on UI mutations.
- Verification status becomes part of continuity state.
- The follow-up reasoning step can branch safely:
  - continue,
  - retry,
  - or ask the user.

## Phase 4 — Strengthen continuity-aware prompting and execution policy

### Goal
Use the structured state to reduce heuristic drift while keeping existing safety gates.

### Changes

#### A. Keep `chat.js` heuristics, but demote them
The existing regex checks remain useful for:

- preventing obvious acknowledgement-only execution,
- quick approval detection,
- fallback behavior when continuity state is empty.

But when valid continuity state exists, state should outrank phrasing heuristics.

#### B. Add continuity routing rules
Examples:

- If `continuationReady === true` and the user says `continue`, resume from `nextRecommendedStep`.
- If `continuityReady === false`, do not infer execution from `continue`; explain why and recover.
- If the last verification is `contradicted`, do not continue blindly.

#### C. Define completion semantics
For agentic desktop workflows, the system prompt and continuation rules should state:

- what counts as `done`,
- what requires explicit verification,
- and when the agent must stop and report uncertainty.

### Acceptance criteria

- `continue` behavior is governed by structured state first.
- The model is less likely to jump to a semantically unrelated next step.
- Safety remains intact for acknowledgement-only turns.

## Phase 5 — Build a continuity regression suite

### Goal
Treat continuity as an evaluated capability, not a subjective impression.

### Test additions

#### A. Extend script coverage
Likely add:

- `scripts/test-chat-continuity-state.js`
- `scripts/test-chat-continuity-prompting.js`
- `scripts/test-action-verification.js`

#### B. Expand existing `scripts/test-chat-actionability.js`
Add multi-turn cases for:

- `continue`
- `continue with next steps`
- `maintain continuity`
- `keep going`
- `carry on`
- continuation after verified execution
- continuation after degraded screenshot fallback
- continuation after contradicted verification

#### C. Add trace-like fixtures
Store synthetic execution-result fixtures covering:

- target window found and focused,
- target window lost,
- screenshot active-window success,
- screenshot fullscreen fallback,
- dialog expected but not observed.

### Acceptance criteria

- Continuity regressions fail if state is lost or contradicted.
- Tests distinguish between executable continuation and unsafe continuation.
- Plan coherence is tested, not just action parsing.

## Suggested file map

### Existing files to extend

- `src/cli/commands/chat.js`
  - use continuity state when classifying continuation turns
  - only fall back to regex heuristics when no continuity record exists

- `src/main/ai-service.js`
  - capture normalized action execution results
  - persist turn records
  - feed continuity summaries into next-turn prompting

- `src/main/session-intent-state.js`
  - add `chatContinuity` schema and helpers

- `src/main/ai-service/message-builder.js`
  - inject continuity summary in a bounded token budget

- `scripts/test-chat-actionability.js`
  - keep current gating regressions
  - add state-aware continuation coverage

### Likely new files

- `src/main/chat-continuity-state.js`
- `src/main/action-verification.js`
- `scripts/test-chat-continuity-state.js`
- `scripts/test-chat-continuity-prompting.js`
- `scripts/test-action-verification.js`

## Rollout order

1. **Persist continuity state**
2. **Inject continuity summary into prompts**
3. **Add verification contracts**
4. **Promote continuity-aware routing in `chat.js`**
5. **Add full regression coverage**

This order keeps risk low because it starts with observability and state capture before changing execution policy.

## Risks and mitigations

### Risk: Prompt bloat
Mitigation:
- keep the continuity summary compact,
- inject only the latest committed turn plus current degraded/verified status,
- avoid replaying full action transcripts.

### Risk: Monolith creep in `ai-service.js`
Mitigation:
- put normalization/verification/state helpers in small internal modules,
- keep `ai-service.js` as the public facade.

### Risk: False confidence from weak visual evidence
Mitigation:
- mark screenshot trust explicitly,
- separate `captured` from `verified`.

### Risk: Overfitting continuation phrases
Mitigation:
- retain current phrase support, but move the primary decision path to structured continuity state.

## Definition of done

This plan is complete when Liku can:

1. execute a multi-step desktop turn,
2. persist a structured record of what actually happened,
3. continue from that record on a short follow-up prompt,
4. explicitly report whether continuity is verified or degraded,
5. and pass automated regressions that prove the follow-up reasoning is grounded in actual execution results.

## Recommended first implementation slice

The best next coding slice is:

1. extend `session-intent-state.js` with `chatContinuity`,
2. add `src/main/chat-continuity-state.js`,
3. persist a normalized `lastTurn` after action execution,
4. inject a compact continuity summary into `message-builder.js`,
5. add one end-to-end regression: actionable turn -> execution result saved -> `continue` consumes saved state.

That gives the highest leverage improvement without trying to solve all UI verification in one pass.

## Execution checklist

Use this as the practical implementation tracker for the next passes.

### Phase 1 — Structured continuity baseline

**Status:** Completed in `929c88b`

**Delivered**
- persisted `chatContinuity` in `src/main/session-intent-state.js`
- injected `## Recent Action Continuity` in `src/main/ai-service/message-builder.js`
- wired state clearing/reporting through `src/main/ai-service.js` and `src/main/ai-service/commands.js`
- recorded post-execution continuity facts from `src/cli/commands/chat.js`

**Files touched**
- `src/main/session-intent-state.js`
- `src/main/ai-service/message-builder.js`
- `src/main/ai-service/commands.js`
- `src/main/ai-service.js`
- `src/cli/commands/chat.js`
- `scripts/test-session-intent-state.js`
- `scripts/test-message-builder-session-intent.js`
- `scripts/test-ai-service-commands.js`
- `scripts/test-chat-inline-proof-evaluator.js`

**Acceptance proof**
- continuity state persists across turns
- continuity context is injected into prompts
- `/clear` and `/state` include continuity handling

**Validation commands**
```powershell
node scripts/test-session-intent-state.js
node scripts/test-message-builder-session-intent.js
node scripts/test-ai-service-commands.js
node scripts/test-chat-actionability.js
```

### Phase 2 — Prefer state over phrasing

**Status:** Next priority

**Goal**
- make continuation routing prefer structured continuity state before regex heuristics when continuity exists

**Target files**
- `src/cli/commands/chat.js`
- `src/main/session-intent-state.js`
- `scripts/test-chat-actionability.js`
- likely new: `scripts/test-chat-continuity-prompting.js`

**Implementation tasks**
- add a `hasUsableChatContinuity(...)` helper in `chat.js`
- when user input is short continuation text (`continue`, `next`, `keep going`), consult continuity state first
- allow execution to proceed when `continuationReady === true` even if phrasing is minimal
- block blind continuation when `continuationReady === false` or continuity is degraded beyond safe auto-execution
- keep acknowledgement-only protections intact

**Acceptance criteria**
- continuation works on minimal phrasing because of stored state, not only because of regex breadth
- acknowledgement-only turns still do not execute
- degraded continuity produces a recovery-oriented response instead of silent drift

**Validation commands**
```powershell
node scripts/test-chat-actionability.js
node scripts/test-session-intent-state.js
```

### Phase 3 — Store richer execution facts

**Status:** High priority

**Goal**
- upgrade `chatContinuity.lastTurn` from a compact summary to a fuller execution record usable for grounded follow-up reasoning

**Target files**
- `src/cli/commands/chat.js`
- `src/main/ai-service.js`
- `src/main/session-intent-state.js`
- likely new: `src/main/chat-continuity-state.js`

**Implementation tasks**
- move normalization logic out of `session-intent-state.js` into a dedicated continuity mapper
- persist richer fields:
  - per-action success/failure when available
  - target window title / handle
  - visual evidence identifiers or timestamps
  - watcher freshness / focus verification details
  - popup follow-up / recipe outcomes
- distinguish user goal, committed subgoal, and next recommended step more explicitly

**Acceptance criteria**
- follow-up prompts can cite concrete execution facts instead of only action types
- continuity state can represent successful, degraded, failed, and cancelled turns cleanly
- the mapper stays reusable and keeps `ai-service.js` from growing further

**Validation commands**
```powershell
node scripts/test-session-intent-state.js
node scripts/test-ai-service-commands.js
node scripts/test-chat-actionability.js
```

### Phase 4 — Verification contracts for UI changes

**Status:** High priority

**Goal**
- prevent Liku from overclaiming that a requested UI change succeeded when evidence is weak or missing

**Target files**
- likely new: `src/main/action-verification.js`
- `src/cli/commands/chat.js`
- `src/main/ai-service.js`
- `src/main/session-intent-state.js`
- likely new: `scripts/test-action-verification.js`

**Implementation tasks**
- support optional `verify` metadata on actions or normalized steps
- create verification result shapes such as:
  - `verified`
  - `unverified`
  - `contradicted`
  - `not-applicable`
- add verification helpers for first useful checks:
  - target window focused
  - expected dialog visible
  - expected popup follow-up remains unresolved
  - screenshot evidence too weak for claim
- store verification details in continuity state

**Acceptance criteria**
- follow-up reasoning clearly distinguishes evidence from assumption
- contradictory UI evidence blocks blind continuation
- verification status becomes a first-class part of continuity routing

**Validation commands**
```powershell
node scripts/test-action-verification.js
node scripts/test-session-intent-state.js
```

### Phase 5 — Explicit screenshot trust and degraded continuity handling

**Status:** High priority

**Goal**
- make screenshot trust a first-class continuity signal and provide recovery behavior when evidence quality degrades

**Target files**
- `src/cli/commands/chat.js`
- `src/main/session-intent-state.js`
- `src/main/ai-service/message-builder.js`
- likely new: `scripts/test-chat-continuity-prompting.js`

**Implementation tasks**
- distinguish `window`, `region`, and `screen` captures in prompt context more explicitly
- mark full-screen fallback as degraded evidence when target-window capture was expected
- add recovery rules such as:
  - retry target-window capture
  - ask user for confirmation
  - continue only with bounded claims

**Acceptance criteria**
- the model can see when the latest screenshot is trusted vs degraded
- degraded screenshot evidence does not silently look equivalent to target-window evidence
- continuation can branch into retry/recover/report modes

**Validation commands**
```powershell
node scripts/test-message-builder-session-intent.js
node scripts/test-chat-actionability.js
```

### Phase 6 — Multi-turn continuity coherence suite

**Status:** Required before calling the continuity work mature

**Goal**
- prove that follow-up turns are grounded in actual execution results rather than reconstructed loosely from conversation text

**Target files**
- `scripts/test-chat-actionability.js`
- likely new: `scripts/test-chat-continuity-state.js`
- likely new: `scripts/test-chat-continuity-prompting.js`
- likely new: fixture files for execution-result snapshots

**Implementation tasks**
- add two-turn and three-turn scenarios:
  - successful continuation
  - degraded screenshot fallback continuation
  - contradicted verification continuation
  - cancelled turn followed by recovery prompt
- assert that the prompt contains the right continuity facts
- assert that unsafe continuation is blocked or redirected appropriately

**Acceptance criteria**
- tests cover plan coherence, not just action execution
- continuity regressions fail when state is absent, stale, or contradicted
- the suite proves that Liku can continue safely and honestly

**Validation commands**
```powershell
node scripts/test-chat-actionability.js
node scripts/test-chat-continuity-state.js
node scripts/test-chat-continuity-prompting.js
node scripts/test-chat-inline-proof-evaluator.js
```

## Recommended implementation order from here

1. **Phase 2 — Prefer state over phrasing**
2. **Phase 3 — Store richer execution facts**
3. **Phase 4 — Verification contracts for UI changes**
4. **Phase 5 — Explicit screenshot trust and degraded recovery**
5. **Phase 6 — Multi-turn continuity coherence suite**

## Commit strategy

- keep each phase in its own commit
- require passing proof commands before each commit
- prefer adding tests in the same commit as the behavior they validate
