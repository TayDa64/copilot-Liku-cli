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

### Current implementation snapshot (concise)

- **Milestones 1–3:** continuity state persistence, prompt injection, state-first continuation routing, richer turn records, and verification status persistence are implemented and covered by regression tests.
- **Milestone 4:** TradingView domain logic has been modularized into focused workflow modules (indicator, alert, chart, drawing, Pine, Paper Trading, DOM) with direct module regressions.
- **Milestone 5:** multi-turn coherence regressions now cover verified, degraded, contradicted, cancelled, and explicit three-turn continuation paths.
- **Milestone 6:** explicit repo/process grounding actions are implemented (`semantic_search_repo`, `grep_repo`, `pgrep_process`) with bounded output and contract/tooling coverage.
- **Milestone 7:** non-disruptive capture is implemented with profile-aware capability matrixing, approval-pause evidence refresh, continuity-state persistence, and validated proof coverage.

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

**Status:** Completed and committed

**Delivered**
- state-first continuation routing in `src/cli/commands/chat.js`
- continuity-aware recovery messaging for degraded, contradicted, and unverified follow-up turns
- multi-turn continuation coverage in `scripts/test-chat-actionability.js`

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

**Status:** Completed and committed

**Delivered**
- dedicated continuity mapper in `src/main/chat-continuity-state.js`
- richer persisted execution, verification, watcher, and popup follow-up facts in `src/main/session-intent-state.js`
- mapper/state regressions in `scripts/test-chat-continuity-state.js` and `scripts/test-session-intent-state.js`

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

**Status:** Completed and committed

**Delivered**
- reusable `action.verify` checkpoint support in `src/main/ai-service.js`
- explicit contradicted/unverified continuity handling in `src/main/session-intent-state.js` and `src/cli/commands/chat.js`
- reusable TradingView dialog verification coverage in `scripts/test-windows-observation-flow.js`

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

**Status:** Completed and committed

**Delivered**
- trusted vs degraded capture handling in `src/main/session-intent-state.js`
- degraded screenshot recovery prompting in `src/main/ai-service/message-builder.js` and `src/cli/commands/chat.js`
- degraded screenshot prompt regressions in `scripts/test-chat-continuity-prompting.js`

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

**Status:** Completed and committed

**Delivered**
- multi-turn prompting regressions in `scripts/test-chat-continuity-prompting.js`
- two-turn continuation persistence/blocking scenarios in `scripts/test-chat-actionability.js`
- explicit contradicted/cancelled continuity recovery assertions across prompt and state tests

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

1. **Milestone 4 — TradingView domain modules replace one-off workflow logic**
2. **Milestone 6 — Repo-grounded search actions improve implementation assistance**
3. **Milestone 7 — Non-disruptive vision for approval-time continuity**

## Commit strategy

- keep each phase in its own commit
- require passing proof commands before each commit
- prefer adding tests in the same commit as the behavior they validate

## Transcript-grounded findings and future implementation directions

The following findings are grounded in the real `liku chat` transcript captured during a TradingView workflow and cross-checked against the current codebase.

### 1. Prefer modular domain capabilities over one-off named workflows

The transcript used **Bollinger Bands** as the requested example, but the implementation direction should stay at the level of a reusable **indicator workflow** instead of a single indicator-specific feature.

Why this is the correct abstraction:

- the runtime already models TradingView as a domain with reusable keyword families rather than only one-off actions:
  - `src/main/tradingview/app-profile.js`
    - `APP_NAME_PROFILES` contains TradingView-specific:
      - `indicatorKeywords`
      - `dialogKeywords`
      - `chartKeywords`
      - `drawingKeywords`
      - `pineKeywords`
- key observation checkpoints already infer reusable TradingView intent classes:
  - `src/main/ai-service.js`
    - `inferKeyObservationCheckpoint(...)`
    - classes such as `dialog-open`, `panel-open`, `input-surface-open`, `chart-state`
- current tests already prove reusable alert-dialog behavior rather than a single hard-coded alert flow:
  - `scripts/test-windows-observation-flow.js`

Recommended design rule:

- do **not** add `add_bollinger_bands` as a special implementation target
- instead add a modular capability such as:
  - `indicator search/open`
  - `indicator add by name`
  - `indicator verify present`
  - `indicator configure`
  - `indicator remove`

This gives one reusable capability surface for:

- Bollinger Bands
- Anchored VWAP
- Volume Profile
- Strategy Tester add-ons
- future studies / overlays / oscillators

Recommended future module shape:

- `src/main/tradingview/indicator-workflows.js`
- `src/main/tradingview/indicator-verification.js`
- transcript fixtures under `scripts/fixtures/tradingview/`

### 2. Screenshot fallback must become an explicit continuity and verification signal

The transcript demonstrated a real failure mode:

- active-window capture failed
- Liku fell back to full-screen capture
- later reasoning occurred in a mixed desktop context where VS Code, OBS, YouTube Studio, and TradingView were all visible

This is already partially grounded in current code:

- `src/main/ui-automation/screenshot.js`
  - returns `captureMode`
  - distinguishes `window-printwindow`, `window-copyfromscreen`, `screen-copyfromscreen`
- `src/cli/commands/chat.js`
  - already warns and falls back when active-window capture returns no data
- `src/main/session-intent-state.js`
  - already stores `captureMode`, `verificationStatus`, and `degradedReason`

But the transcript shows the remaining gap:

- degraded screenshot evidence is still not treated strongly enough as a continuity gate

Future implementation rule:

- if the intended target is a specific app/window and the resulting evidence is `screen` or `fullscreen-fallback`, continuity should become **degraded** unless:
  - target foreground is re-verified, or
  - the user explicitly approves bounded continuation, or
  - a successful target-window recapture occurs

This should be wired into:

- continuation routing in `src/cli/commands/chat.js`
- prompt context in `src/main/ai-service/message-builder.js`
- continuity persistence in `src/main/session-intent-state.js`

### 3. Verification should promote reusable UI-surface contracts, not app-specific hacks

The transcript showed two concrete TradingView flows that should become reusable verification contracts:

1. **Create Alert**
   - verify that an alert dialog or alert-owned window opened before typing continues
2. **Indicator Search / Add Indicator**
   - verify that the indicator search surface opened before typing
   - do not claim the indicator is present on-chart unless evidence supports it

The codebase already has a strong starting seam for this:

- `src/main/ai-service.js`
  - `inferKeyObservationCheckpoint(...)`
  - `verifyKeyObservationCheckpoint(...)`
- existing grounded tests:
  - `scripts/test-windows-observation-flow.js`
    - alert accelerator fails safely when dialog transition is not observed
    - alert accelerator allows typing after observed dialog transition

Recommended generalization:

- add reusable verification kinds instead of app-specific branches wherever possible:
  - `dialog-visible`
  - `input-surface-open`
  - `panel-open`
  - `target-window-focused`
  - `indicator-present`
  - `chart-state-updated`

This keeps the design modular for TradingView, browser apps, and future low-UIA surfaces.

### 4. Future implementation section: code-search and repo-grounding capabilities

The current runtime already benefits from direct shell execution for discovery-style tasks:

- `src/main/system-automation.js`
  - `RUN_COMMAND`
  - `executeCommand(...)`
- `src/main/ai-service/system-prompt.js`
  - explicitly encourages `run_command` for shell tasks and file listing

However, the transcript and this repository work suggest a stronger future feature area: **repo-grounded search actions**.

Potential future actions:

- `semantic_search_repo`
- `grep_repo`
- `pgrep_process`

Suggested capability boundaries:

- `semantic_search_repo`
  - use when the user asks for concept-level discovery across code
  - example: “find where continuity routing is decided”
- `grep_repo`
  - use when the user asks for exact symbol/string/regex grounding
  - example: “show all uses of `continuationReady`”
- `pgrep_process`
  - use when the user asks to verify whether app/runtime processes are alive
  - example: “is TradingView still running”, “which OBS process/window should I target”

How these would improve Liku:

- stronger self-grounding before suggesting code changes
- lower hallucination risk in repo-editing workflows
- better recovery when the user asks for implementation-aware reasoning from within desktop chat
- better window/process targeting when multiple candidate apps are open

Recommended boundaries:

- keep these as explicit tools/actions, not hidden model behavior
- preserve advisory-safe defaults
- require compact, bounded outputs so prompt size stays controlled

### 5. Background Window Capture (Non-Disruptive Vision) would improve approval-time continuity

This is the most strategically valuable future capability surfaced by the transcript.

Current behavior:

- Liku often needs to focus the target window before capturing trustworthy visual evidence
- when the user is asked for approval, focus may move away from the target app
- continuity can degrade while the user is reading/responding in another surface such as VS Code or the chat terminal

Why background capture would help:

1. **Preserve user workflow during approvals**
   - the user can stay in VS Code or terminal while Liku keeps observing TradingView or OBS without stealing focus

2. **Preserve target-window continuity**
   - Liku can verify that the chart/dialog/panel still exists after an approval pause
   - this reduces stale assumptions between “pending confirmation” and “resume execution”

3. **Reduce focus churn and re-targeting errors**
   - fewer forced `focus_window` hops means fewer accidental context switches and fewer mixed-window screenshots

4. **Improve honesty of follow-up reasoning**
   - if Liku can capture the intended target without foreground disruption, it can distinguish:
     - “the target remained stable while you reviewed the approval”
     - vs “the target may have changed while focus was elsewhere”

5. **Enable background monitors/watchers later**
   - especially useful for chart monitoring, stream health, popups, and long-running UI tasks

Important constraint:

- this should be treated as a **future architecture enhancement**, not as a substitute for continuity/verification improvements already needed now
- the immediate near-term priority remains:
  - state-first continuation routing
  - degraded screenshot trust
  - reusable verification contracts

### 6. Detailed future implementation tracks

Below are the recommended future tracks after the current continuity phases.

#### Track A — TradingView domain modules

Goal:
- formalize TradingView as modular workflows instead of isolated prompt tricks

Recommended modules:
- `src/main/tradingview/app-profile.js`
- `src/main/tradingview/indicator-workflows.js`
- `src/main/tradingview/alert-workflows.js`
- `src/main/tradingview/chart-verification.js`

Initial reusable operations:
- open indicator search
- add indicator by name
- verify indicator search opened
- verify indicator presence on chart when possible
- open alert dialog
- verify alert dialog transition
- apply timeframe changes with verification

#### Track B — Continuity evidence engine

Goal:
- promote capture quality, watcher freshness, and verification into a reusable evidence contract

Recommended modules:
- `src/main/chat-continuity-state.js`
- `src/main/action-verification.js`
- `src/main/evidence-quality.js`

Initial responsibilities:
- normalize capture modes and trust levels
- classify degraded vs trusted evidence
- decide when continuation is safe, degraded, blocked, or recovery-required

#### Track C — Repo-grounded search actions

Goal:
- improve implementation assistance from within Liku itself

Potential actions:
- `semantic_search_repo`
- `grep_repo`
- `pgrep_process`

Initial use cases:
- locate implementation seams before editing
- verify exact symbol usage before proposing a change
- discover the correct process/window candidate before focusing or capturing

#### Track D — Non-disruptive vision

Goal:
- observe target applications without forcing focus changes during approvals or long-running tasks

Potential implementation directions:
- stronger HWND-bound capture path
- best-effort non-foreground capture provider abstraction
- explicit capability detection per target app/window class
- degraded fallback when non-disruptive capture is unsupported

Acceptance principles:
- never silently equate degraded background capture with trusted target capture
- always surface evidence quality in continuity state
- preserve user focus when possible, but never overclaim certainty

## Future milestone roadmap

This roadmap turns the future-direction findings above into a staged implementation sequence that can be used as the handoff point for code work.

### Milestone 1 — Continuity routing becomes state-first

**Objective**
- make follow-up turns rely on persisted continuity state before conversational phrasing heuristics whenever valid continuity exists

**Primary files**
- `src/cli/commands/chat.js`
- `src/main/session-intent-state.js`
- `scripts/test-chat-actionability.js`

**Key deliverables**
- `hasUsableChatContinuity(...)` helper
- minimal continuation routing rules for `continue`, `next`, `keep going`, `carry on`
- recovery response when continuity exists but is degraded or blocked

**Acceptance criteria**
- short continuation prompts execute only when continuity state says continuation is safe
- acknowledgement-only turns remain non-executing
- degraded continuity yields an explicit recovery-oriented reply

**Proof commands**
```powershell
node scripts/test-chat-actionability.js
node scripts/test-session-intent-state.js
```

**Why this milestone comes first**
- it is the smallest behavior change that makes the rest of the continuity work meaningful
- it reduces drift before deeper state enrichment lands

### Milestone 2 — Evidence quality becomes a first-class continuity signal

**Objective**
- distinguish trusted target evidence from degraded fallback evidence and make that distinction visible in both routing and prompting

**Primary files**
- `src/main/session-intent-state.js`
- `src/main/ai-service/message-builder.js`
- `src/cli/commands/chat.js`
- likely new: `src/main/evidence-quality.js`

**Key deliverables**
- normalized evidence-quality model for `window`, `region`, `screen`, and fallback states
- explicit degraded markers in continuity state and prompt context
- recovery policy when `screen` evidence is used after target-window intent

**Acceptance criteria**
- full-screen fallback is not treated as equivalent to a trusted target-window capture
- continuity prompts expose evidence quality clearly
- continuation can branch to retry, bounded continuation, or user confirmation

**Proof commands**
```powershell
node scripts/test-message-builder-session-intent.js
node scripts/test-chat-actionability.js
```

**Dependency notes**
- builds directly on Milestone 1
- should be completed before expanding verification claims further

### Milestone 3 — Reusable verification contracts for low-UIA UI changes

**Objective**
- stop relying on raw action completion as proof of UI success, especially for TradingView-like workflows

**Primary files**
- `src/main/ai-service.js`
- likely new: `src/main/action-verification.js`
- `src/main/session-intent-state.js`
- `scripts/test-windows-observation-flow.js`
- likely new: `scripts/test-action-verification.js`

**Key deliverables**
- reusable verification shapes:
  - `verified`
  - `unverified`
  - `contradicted`
  - `not-applicable`
- reusable verification kinds:
  - `target-window-focused`
  - `dialog-visible`
  - `input-surface-open`
  - `panel-open`
  - `indicator-present`
  - `chart-state-updated`

**Acceptance criteria**
- Liku does not continue typing into an expected dialog unless the dialog transition is observed
- indicator-search and alert-style flows are verified through reusable contracts rather than one-off heuristics
- continuity state records verification outcomes for future turns

**Proof commands**
```powershell
node scripts/test-windows-observation-flow.js
node scripts/test-action-verification.js
node scripts/test-session-intent-state.js
```

**Dependency notes**
- evidence quality from Milestone 2 should feed verification confidence

### Milestone 4 — TradingView domain modules replace one-off workflow logic

**Status:** Completed and committed

**Delivered so far**
- extracted TradingView app identity/profile normalization to `src/main/tradingview/app-profile.js`
- extracted TradingView observation/risk inference to `src/main/tradingview/verification.js`
- extended TradingView observation/risk inference with paper-trading mode detection and refusal guidance
- extracted deterministic TradingView indicator workflow shaping to `src/main/tradingview/indicator-workflows.js`
- extracted deterministic TradingView alert workflow shaping to `src/main/tradingview/alert-workflows.js`
- extracted TradingView chart verification plus timeframe/symbol/watchlist workflow shaping to `src/main/tradingview/chart-verification.js`
- extracted verification-first TradingView drawing/object-tree surface workflow shaping to `src/main/tradingview/drawing-workflows.js`
- extracted verification-first TradingView Pine Editor surface workflow shaping to `src/main/tradingview/pine-workflows.js`
- extracted verification-first TradingView Paper Trading assist workflow shaping to `src/main/tradingview/paper-workflows.js`
- extracted verification-first TradingView Depth of Market surface workflow shaping to `src/main/tradingview/dom-workflows.js`
- extracted reusable post-key observation checkpoint helpers to `src/main/ai-service/observation-checkpoints.js`
- added direct module regressions in `scripts/test-tradingview-app-profile.js` and `scripts/test-tradingview-verification.js`
- added paper-trading detection and refusal-message regression coverage in `scripts/test-tradingview-verification.js`
- added direct indicator-workflow regression coverage in `scripts/test-tradingview-indicator-workflows.js`
- added direct alert-workflow regression coverage in `scripts/test-tradingview-alert-workflows.js`
- added direct chart-verification regression coverage in `scripts/test-tradingview-chart-verification.js`
- added direct drawing-workflow regression coverage in `scripts/test-tradingview-drawing-workflows.js`
- added direct Pine workflow regression coverage in `scripts/test-tradingview-pine-workflows.js`
- added direct Paper Trading workflow regression coverage in `scripts/test-tradingview-paper-workflows.js`
- added direct DOM workflow regression coverage in `scripts/test-tradingview-dom-workflows.js`
- added bounded Paper Trading assist rewrites so `open/connect/show Paper Trading` requests verify the paper surface before continuation while still refusing order execution
- revalidated acceptance with:
  - `node scripts/test-windows-observation-flow.js`
  - `node scripts/test-chat-actionability.js`
  - direct TradingView module regressions for app-profile, verification, indicator, alert, chart, drawing, Pine, Paper Trading, and DOM workflows

**Objective**
- formalize reusable TradingView workflow modules around alerts, indicators, and chart verification

**Primary files**
- likely new: `src/main/tradingview/app-profile.js`
- likely new: `src/main/tradingview/indicator-workflows.js`
- likely new: `src/main/tradingview/alert-workflows.js`
- likely new: `src/main/tradingview/chart-verification.js`
- `src/main/ai-service.js`

**Key deliverables**
- indicator workflows based on name-driven and intent-driven operations
- alert workflows separated from indicator workflows
- chart verification helpers reusable by continuity and prompt building

**Acceptance criteria**
- the implementation target is “indicators” as a modular capability, not “Bollinger Bands” as a special-case feature
- alert and indicator flows share reusable verification and targeting utilities
- app-domain logic shrinks inside `ai-service.js`

**Proof commands**
```powershell
node scripts/test-windows-observation-flow.js
node scripts/test-chat-actionability.js
```

**Dependency notes**
- depends on Milestone 3 so domain modules can consume stable verification contracts

### Milestone 5 — Multi-turn coherence suite proves safe continuation

**Status:** Completed and committed

**Delivered so far**
- added reusable paper-aware TradingView continuity fixtures in `scripts/fixtures/tradingview/paper-aware-continuity.json`
- extended `scripts/test-chat-actionability.js` with verified, degraded, contradicted, cancelled, and explicit three-turn continuation routing regressions
- extended `scripts/test-chat-continuity-state.js` and `scripts/test-chat-continuity-prompting.js` with paper-trading mode continuity persistence and prompt-context coverage
- added cancelled paper-continuity prompt coverage in `scripts/test-chat-continuity-prompting.js`

**Objective**
- move continuity from “seems improved” to “provably grounded under regression”

**Primary files**
- `scripts/test-chat-actionability.js`
- likely new: `scripts/test-chat-continuity-state.js`
- likely new: `scripts/test-chat-continuity-prompting.js`
- likely new: `scripts/fixtures/tradingview/`

**Key deliverables**
- two-turn and three-turn fixtures covering:
  - successful continuation
  - degraded screenshot fallback continuation
  - contradicted verification continuation
  - cancelled turn followed by recovery prompt

**Acceptance criteria**
- prompts contain the right continuity facts for each scenario
- unsafe continuation is blocked or redirected
- regressions fail when continuity is stale, absent, contradicted, or degraded beyond safe execution

**Proof commands**
```powershell
node scripts/test-chat-actionability.js
node scripts/test-chat-continuity-state.js
node scripts/test-chat-continuity-prompting.js
node scripts/test-chat-inline-proof-evaluator.js
```

### Milestone 6 — Repo-grounded search actions improve implementation assistance

**Status:** Completed and committed

**Delivered so far**
- added modular repo/process search execution in `src/main/repo-search-actions.js`
- added explicit runtime action support in `src/main/system-automation.js` for:
  - `semantic_search_repo`
  - `grep_repo`
  - `pgrep_process`
- added explicit tool-call definitions and mappings in `src/main/ai-service/providers/copilot/tools.js`
- updated prompting guidance in `src/main/ai-service/system-prompt.js` so the model can pick repo/process grounding actions directly
- updated safety/description handling in `src/main/ai-service.js` for new read-only search actions
- added dedicated regressions in `scripts/test-repo-search-actions.js`
- updated contract/tool regression expectations in:
  - `scripts/test-ai-service-contract.js`
  - `scripts/test-tier2-tier3.js`
- strengthened repo-search quality and safety:
  - semantic ranking now weights symbol-like matches, path relevance, token coverage, and file recency
  - grep/semantic outputs now include bounded line-window snippets for grounded follow-up reasoning
  - centralized hard caps for `maxResults` and timeout limits
  - regex validation and malformed-pattern safety handling
  - root-bound relative path enforcement for result file references
- strengthened `pgrep_process` process grounding:
  - Windows process results now include `hasWindow` / `windowTitle` enrichment when available
  - process matching now uses deterministic ranking (exact > prefix > contains, with window-aware preference)

**Objective**
- let Liku ground coding and recovery assistance through explicit repo/process search actions

**Primary files**
- `src/main/repo-search-actions.js`
- `src/main/system-automation.js`
- `src/main/ai-service/system-prompt.js`
- `src/main/ai-service/providers/copilot/tools.js`

**Key deliverables**
- explicit actions for:
  - `semantic_search_repo`
  - `grep_repo`
  - `pgrep_process`
- bounded outputs and safety constraints for each action

**Acceptance criteria**
- Liku can explicitly ground implementation answers in repo search results
- process targeting can use compact process-discovery results rather than guesswork
- search outputs stay concise enough for prompt use

**Proof commands**
```powershell
node scripts/test-repo-search-actions.js
node scripts/test-run-command.js
node scripts/test-ai-service-contract.js
```

**Dependency notes**
- does not block continuity implementation, but compounds its usefulness for dev-facing tasks

### Milestone 7 — Non-disruptive vision for approval-time continuity

**Status:** Completed and committed

**Delivered so far**
- added modular non-disruptive capture provider abstraction in `src/main/background-capture.js`
  - capability detection for background capture eligibility
  - trust classification for `window-printwindow` vs degraded `window-copyfromscreen`
  - explicit degraded reasons for continuity safety routing
- upgraded background capability detection with a process/class/window-kind matrix:
  - classifies known compositor/UWP/owned-surface profiles as `degraded`
  - marks minimized targets as `unsupported`
  - keeps evidence trust conservative even when `PrintWindow` succeeds on degraded profiles
- wired background-capture path into `src/cli/commands/chat.js` auto-capture flow when target window handles are available
- extended visual frame contract in `src/shared/inspect-types.js` with background-capture metadata:
  - `captureProvider`
  - `captureCapability`
  - `captureDegradedReason`
  - `captureNonDisruptive`
  - `captureBackgroundRequested`
- persisted and surfaced background-capture metadata in continuity state and prompt context through:
  - `src/main/chat-continuity-state.js`
  - `src/main/session-intent-state.js`
- integrated approval-pause recapture hook in `src/main/ai-service.js`:
  - refreshes non-disruptive evidence when execution pauses for high/critical confirmation
  - carries target window profile metadata (`processName`, `className`, `windowKind`, `windowTitle`) into capture requests
  - persists approval-pause capture metadata on pending actions for transparent continuity state
- added dedicated and continuity-level regressions:
  - `scripts/test-background-capture.js`
  - `scripts/test-session-intent-state.js`
  - `scripts/test-windows-observation-flow.js`
  - `scripts/test-chat-continuity-prompting.js`
- revalidated final proof command set together:
  - `node scripts/test-background-capture.js`
  - `node scripts/test-session-intent-state.js`
  - `node scripts/test-chat-continuity-prompting.js`
  - `node scripts/test-windows-observation-flow.js`

**Objective**
- allow Liku to preserve target-app observation during approval pauses without forcing focus changes when the platform/app supports it

**Primary files**
- `src/main/ui-automation/screenshot.js`
- likely new: `src/main/background-capture.js`
- `src/cli/commands/chat.js`
- `src/main/session-intent-state.js`

**Key deliverables**
- provider abstraction for best-effort non-foreground capture
- capability detection per target app/window class
- continuity integration that distinguishes:
  - trusted background capture
  - degraded background capture
  - unsupported background capture

**Acceptance criteria**
- approval pauses no longer automatically imply target-observation loss when supported capture is available
- focus is preserved for the user when possible
- unsupported or degraded background capture is reported honestly

**Proof commands**
```powershell
node scripts/test-background-capture.js
node scripts/test-session-intent-state.js
node scripts/test-chat-continuity-prompting.js
node scripts/test-windows-observation-flow.js
```

**Dependency notes**
- this is intentionally later-stage architecture work
- it should build on Milestones 1–5 rather than replace them

## Recommended handoff into implementation work

Milestones 1–7 in this plan are now implemented in the working tree.

If follow-on work is needed, it is no longer “finish the current plan,” but rather one of these next-step categories:

1. **Closeout hygiene**
  - keep status/acceptance text aligned with the latest passing proof commands
  - preserve commit-level checkpoints for each milestone cluster
2. **Polish and hardening**
  - expand fixture breadth for newly added continuity and non-disruptive capture paths
  - add more platform/app-profile coverage where evidence trust is conservative by design
3. **Next roadmap generation**
  - define new work beyond this plan rather than treating unfinished status text as implementation debt

That means the remaining work after this document is not an open implementation gap inside Milestones 1–7; it is deciding what the next roadmap should be.

## Post-plan hardening checklist (grounded in TradingView runtime findings)

The current continuity plan is implemented, but recent real-world TradingView testing exposed a new class of follow-on work. These are not missing Milestones 1–7 items; they are the next practical hardening tracks after the continuity architecture landed.

The findings below are grounded in current repo seams, especially:

- `src/main/ai-service.js`
  - `extractRequestedAppName(...)`
  - `rewriteActionsForReliability(...)`
- `src/cli/commands/chat.js`
  - screenshot-only loop forcing
  - continuation/forced-answer handling
- `src/main/ai-service/message-builder.js`
  - same-turn visual context injection
- `src/main/tradingview/pine-workflows.js`
  - Pine surface opening + verified typing
- `src/main/tradingview/drawing-workflows.js`
  - drawing surface access vs unsafe placement refusal
- `src/main/system-automation.js`
  - `run_command`, `grep_repo`, `semantic_search_repo`, `pgrep_process`

### Track A — Intent-safe reliability rewrites

**Status:** Completed and committed

**Delivered so far**
- hardened `extractRequestedAppName(...)` in `src/main/ai-service.js` so passive open-state phrasing no longer gets treated as app-launch intent
- added a concrete observation-plan preservation guard in `rewriteActionsForReliability(...)` for existing-window focus/wait/screenshot flows
- added regression coverage in:
  - `scripts/test-windows-observation-flow.js`
  - `scripts/test-bug-fixes.js`
- revalidated with:
  - `node scripts/test-windows-observation-flow.js`
  - `node scripts/test-bug-fixes.js`

**Why this track exists**
- Real runtime testing showed an observation prompt like “I have tradingview open in the background, what do you think?” can still be reinterpreted as a desktop-app launch request.
- The current launch extraction logic in `src/main/ai-service.js` accepts broad `open ...` phrasing and can trigger `buildOpenApplicationActions(...)` even when the model already produced a better observation plan such as `focus_window + screenshot`.

**Goal**
- prevent passive observation/synthesis requests from being rewritten into Start-menu launch flows.

**Primary files**
- `src/main/ai-service.js`
- `src/main/tradingview/app-profile.js`
- `scripts/test-windows-observation-flow.js`
- `scripts/test-chat-actionability.js`
- likely new: `scripts/test-ai-service-reliability-rewrites.js`

**Implementation checklist**
- narrow `extractRequestedAppName(...)` so it ignores passive phrasing such as:
  - `I have TradingView open ...`
  - `TradingView is open ...`
  - `with TradingView open ...`
- add a preservation rule in `rewriteActionsForReliability(...)`:
  - if the plan already contains a concrete `focus_window`, `bring_window_to_front`, or TradingView-targeted verification hint, prefer preserving that observation plan over app-launch rewriting
- add a negative rewrite guard for TradingView synthesis/observation prompts that mention `open` only as a state description, not as an imperative

**Regression additions**
- `scripts/test-windows-observation-flow.js`
  - `observation prompt with existing TradingView focus plan is not rewritten into app launch`
- likely new `scripts/test-ai-service-reliability-rewrites.js`
  - `extractRequestedAppName ignores passive open-state phrasing`
  - `rewriteActionsForReliability preserves focus-window screenshot observation plans`
- `scripts/test-chat-actionability.js`
  - `passive TradingView observation prompt executes observation plan without app-launch rewrite`

**Acceptance criteria**
- observation prompts do not get rewritten into Start-menu launch flows when a valid foreground/focus plan already exists
- app-launch rewrites still work for genuine launch intent

### Track B — Same-turn degraded visual evidence contract

**Status:** Completed and committed

**Delivered so far**
- injected a `## Current Visual Evidence Bounds` system block in `src/main/ai-service/message-builder.js`
- current-turn prompts now distinguish degraded mixed-desktop fallback evidence from trusted target-window capture before the model answers
- added focused same-turn visual-bounds regressions in `scripts/test-visual-analysis-bounds.js`
- revalidated compatibility with `scripts/test-chat-continuity-prompting.js` and `scripts/test-message-builder-session-intent.js`

**Why this track exists**
- The continuity stack already degrades follow-up routing when screenshot trust falls back to full-screen capture.
- Current same-turn visual analysis can still overclaim chart specifics after `screen-copyfromscreen` fallback because `message-builder.js` injects the image but not a strong current-turn evidence-trust contract.

**Goal**
- force bounded, uncertainty-aware analysis when the current screenshot is degraded or mixed-desktop evidence.

**Primary files**
- `src/main/ai-service/message-builder.js`
- `src/main/ai-service.js`
- `src/main/chat-continuity-state.js`
- `src/main/session-intent-state.js`
- `scripts/test-chat-continuity-prompting.js`
- likely new: `scripts/test-visual-analysis-bounds.js`

**Implementation checklist**
- inject a same-turn system constraint whenever the latest visual context is:
  - `screen-copyfromscreen`
  - `fullscreen-fallback`
  - or otherwise `captureTrusted: false`
- distinguish “directly visible in the image” from “interpretive hypothesis” in TradingView analysis prompts
- add an explicit rule for low-UIA chart apps:
  - do not claim precise indicator values unless they are directly legible in the screenshot or surfaced via a stronger evidence path
- preserve the existing continuity-state fields, but also make the current-turn model call see the degraded-evidence warning before it answers

**Regression additions**
- `scripts/test-visual-analysis-bounds.js`
  - `degraded TradingView analysis prompt forbids precise unseen indicator claims`
  - `trusted target-window capture allows stronger direct observation wording`

**Acceptance proof (slice 1)**
```powershell
node scripts/test-visual-analysis-bounds.js
node scripts/test-chat-continuity-prompting.js
node scripts/test-message-builder-session-intent.js
```

**Acceptance criteria**
- degraded same-turn analysis becomes explicitly uncertainty-aware
- mixed-desktop fallback evidence no longer silently looks equivalent to a trusted target-window TradingView capture

### Track C — Forced-observation recovery becomes useful, not just safe

**Status:** Completed and committed

**Delivered so far**
- replaced the screenshot-loop dead-end in `src/cli/commands/chat.js` with a deterministic bounded observation fallback
- bounded fallback answers now summarize evidence quality and explicitly state what cannot be claimed safely
- added behavioral regression coverage in `scripts/test-chat-forced-observation-fallback.js`
- extended `scripts/test-windows-observation-flow.js` to assert the bounded fallback path is wired into the chat loop

**Why this track exists**
- Current loop-prevention in `src/cli/commands/chat.js` correctly blocks screenshot-only loops.
- If the forced natural-language retry still returns JSON actions, the runtime currently stops rather than producing a bounded fallback answer.

**Goal**
- keep screenshot-loop protection, but turn failure-to-comply into a usable bounded response instead of a dead end.

**Primary files**
- `src/cli/commands/chat.js`
- `src/main/ai-service.js`
- `src/main/ai-service/message-builder.js`
- `scripts/test-windows-observation-flow.js`
- likely new: `scripts/test-chat-forced-observation-fallback.js`

**Implementation checklist**
- add a second-stage fallback when `buildForcedObservationAnswerPrompt(...)` still yields actions:
  - either re-prompt once with stronger no-JSON instructions
  - or generate a deterministic bounded answer template from continuity + latest visual metadata
- include explicit fallback sections such as:
  - what is verified
  - what is degraded
  - what cannot be claimed safely
  - next safe options
- keep the existing guard that prevents screenshot-only loops

**Regression additions**
- `scripts/test-windows-observation-flow.js`
  - `chat continuation guard forces direct observation answer after screenshot-only detour`
- `scripts/test-chat-forced-observation-fallback.js`
  - `forced observation fallback does not emit additional screenshot actions`
  - `bounded fallback answer includes degraded evidence explanation`

**Acceptance proof (slice 1)**
```powershell
node scripts/test-chat-forced-observation-fallback.js
node scripts/test-windows-observation-flow.js
```

**Acceptance criteria**
- no screenshot-only loop
- no silent dead-end stop when the model violates the no-JSON retry
- user receives a bounded answer or safe next-step message

### Track E — Recommendation follow-through becomes executable

**Status:** Completed and committed

**Delivered so far**
- added explicit affirmative-follow-through classification in `src/cli/commands/chat.js` so turns like `yes, lets apply the volume profile` preserve the current requested operation as execution intent instead of collapsing back to the prior advisory turn
- prioritized that follow-through classifier inside `shouldExecuteDetectedActions(...)` before generic approval handling so explicit TradingView/Pine follow-up requests execute reliably
- extended `scripts/test-chat-actionability.js` with transcript-grounded regressions for:
  - explicit indicator follow-through
  - explicit Pine follow-through
  - advisory recommendation -> explicit follow-through execution

**Why this track exists**
- Real TradingView testing showed a valid indicator workflow could still be withheld after a natural user reply like `yes, lets apply the volume profile`.
- The deeper issue is not only approval detection; it is preserving recommendation-followthrough turns as explicit operations instead of treating them as generic continuation or acknowledgement text.

**Goal**
- make affirmative + explicit requested TradingView/Pine follow-through execute reliably.

**Primary files**
- `src/cli/commands/chat.js`
- `scripts/test-chat-actionability.js`

**Implementation checklist**
- add a dedicated helper for affirmative + explicit requested operation input
- preserve the current user turn as `executionIntent` for explicit follow-through requests instead of defaulting to the previous advisory turn
- keep pure acknowledgement-only turns non-executable

**Acceptance proof (slice 1)**
```powershell
node scripts/test-chat-actionability.js
```

**Acceptance criteria**
- `yes, lets apply the volume profile` executes instead of being withheld
- `yes, open Pine Logs` executes instead of being treated as generic acknowledgement
- pure acknowledgements like `thanks` remain non-executable

### Track F — Continuity scoping respects advisory pivots

**Status:** Completed and committed

**Delivered so far**
- scoped `formatChatContinuityContext(...)` in `src/main/session-intent-state.js` so broad advisory pivots receive a reduced continuity block instead of full stale chart-execution detail
- updated `src/main/ai-service.js` to pass the current user message into continuity formatting so prompt assembly can distinguish advisory pivots from explicit continuation
- added prompting regression coverage in `scripts/test-chat-continuity-prompting.js` to ensure stale TradingView chart details are not injected into broad advisory questions

**Why this track exists**
- Real TradingView testing showed fresh advisory questions like `what would help me have confidence about investing in LUNR?` could inherit stale chart-analysis claims from a previous branch.
- The continuity system should preserve history, but broad planning/advisory turns should not restate old chart-specific facts as if they were current evidence.

**Goal**
- keep continuity state intact while scoping prompt injection so fresh advisory pivots do not inherit stale chart-specific claims.

**Primary files**
- `src/main/session-intent-state.js`
- `src/main/ai-service.js`
- `src/main/ai-service/message-builder.js`
- `scripts/test-chat-continuity-prompting.js`

**Implementation checklist**
- detect broad advisory pivots separately from explicit continuation or execution follow-through
- inject a reduced continuity block for advisory pivots that preserves only high-level app/domain context and safety guidance
- omit stale last-step chart execution facts and verification details from those advisory-pivot prompts

**Acceptance proof (slice 1)**
```powershell
node scripts/test-chat-continuity-prompting.js
node scripts/test-chat-actionability.js
node scripts/test-message-builder-session-intent.js
```

**Acceptance criteria**
- broad advisory pivots do not restate stale chart-specific observations as current facts
- explicit continuation behavior remains unchanged
- continuity state is preserved without being over-injected into the wrong branch

### Track G — Degraded recovery stays tied to the requested task

**Status:** Completed and committed

**Delivered so far**
- added lightweight `pendingRequestedTask` persistence in `src/main/session-intent-state.js` so a concrete requested TradingView/Pine step can survive a withheld or blocked execution branch
- updated `src/cli/commands/chat.js` to record that pending task when an emitted action plan is intentionally withheld as non-executable text, clear it when a fresh branch or execution starts, and use it during minimal `continue` turns
- made degraded/blocked continuation recovery task-aware so replies reference the actual pending request (for example Volume Profile or Pine Logs) instead of only replaying a generic stale-continuity warning
- extended `scripts/test-chat-actionability.js` and `scripts/test-session-intent-state.js` with regressions for pending-task persistence and task-aware degraded recovery messaging

**Why this track exists**
- Real TradingView testing showed that after a blocked follow-through turn, repeated `continue` messages could keep replaying generic degraded continuity warnings without reconnecting the user to the task they had actually asked for.
- The recovery path needs to preserve both safety and task specificity: block blind continuation, but keep pointing back to the last requested actionable step.

**Goal**
- make blocked/degraded continuation recovery explicitly reference the pending requested TradingView/Pine task so the user can retry the correct action instead of falling into a vague continuity loop.

**Primary files**
- `src/main/session-intent-state.js`
- `src/cli/commands/chat.js`
- `scripts/test-chat-actionability.js`
- `scripts/test-session-intent-state.js`

**Implementation checklist**
- persist a compact pending-task record when a concrete requested action is withheld or cannot yet continue safely
- clear stale pending-task state when the user starts a new non-continuation branch or the action proceeds into execution
- teach degraded `continue` recovery to mention the pending task directly while preserving existing verification/degraded-safety language

**Acceptance proof (slice 1)**
```powershell
node scripts/test-session-intent-state.js
node scripts/test-chat-actionability.js
node scripts/test-chat-continuity-prompting.js
node scripts/test-message-builder-session-intent.js
```

**Acceptance criteria**
- degraded `continue` replies mention the last requested TradingView/Pine task when one is pending
- `continue` does not blindly execute when continuity is degraded or absent but a pending task exists
- starting a fresh non-continuation branch clears stale pending-task recovery state

### Track H — TradingView UI grounding becomes truthful before Pine authoring

**Status:** Completed and committed

**Why this track exists**
- Recent real TradingView/Pine testing showed Liku can generate plausible Pine authoring plans while still failing at the more basic UI truthfulness layers:
  - requested TradingView window handle vs actual foreground handle drift
  - app focused vs Pine panel visible vs editor actually active
  - destructive editor actions being attempted before the UI state is truly established
- Official TradingView shortcut references also reinforce that many shortcuts are contextual or customizable, so reliable TradingView automation must start from verified UI state rather than assuming one static hotkey layer always applies.

**Goal**
- make TradingView focus, surface activation, and editor readiness explicit and truthful before Liku attempts Pine authoring or chart-editing flows.

**Primary files**
- `src/main/system-automation.js`
- `src/main/ai-service.js`
- `src/main/tradingview/verification.js`
- `src/main/tradingview/pine-workflows.js`
- `scripts/test-windows-observation-flow.js`
- `scripts/test-bug-fixes.js`

**Commit order inside this track**
1. **Track H / Slice 1 — Focus truthfulness and handle drift accounting**
2. **Track H / Slice 2 — TradingView surface activation and editor-active verification**
3. **Track H / Slice 3 — Safe Pine authoring defaults (`new script` / inspect-first) instead of destructive clear-first flows**
4. **Track H / Slice 4 — Resume-after-confirmation re-establishes UI prerequisites**

#### Track H / Slice 1 — Focus truthfulness and handle drift accounting

**Status:** Completed and committed

**Delivered so far**
- added requested-vs-actual focus metadata to `focus_window` / `bring_window_to_front` results in `src/main/system-automation.js`
- updated `src/main/ai-service.js` so `last target window` only advances on exact or explicitly recovered TradingView focus, instead of blindly adopting whatever foreground hwnd happened after a focus attempt
- added runtime regressions in `scripts/test-windows-observation-flow.js` for focus mismatch truthfulness and guarded target-window updates
- added seam coverage in `scripts/test-bug-fixes.js` for structured focus target metadata and guarded focus-result classification

**Goal**
- stop reporting requested TradingView focus success when a different foreground window actually received focus.

**Exact files to change**
- `src/main/system-automation.js`
  - tighten `focus_window` / `bring_window_to_front` result shaping so action results preserve:
    - requested target handle/title/process
    - actual foreground handle/title/process
    - whether focus was exact, recovered, or mismatched
- `src/main/ai-service.js`
  - only bless `last target window` updates when the foreground result is:
    - exact,
    - or an explicitly accepted recovered TradingView target
  - surface focus mismatch metadata in execution results instead of silently treating it as clean success
- `scripts/test-windows-observation-flow.js`
  - add a runtime regression where requested TradingView hwnd differs from the actual foreground hwnd and the result is marked as drift/mismatch rather than a plain success
- `scripts/test-bug-fixes.js`
  - add seam assertions for requested-vs-actual focus metadata and guarded last-target-window updates

**Regression additions**
- `scripts/test-windows-observation-flow.js`
  - `tradingview focus mismatch is not reported as clean success`
  - `last target window only updates on exact or recovered tradingview focus`
- `scripts/test-bug-fixes.js`
  - `focus results preserve requested and actual target metadata`

**Acceptance proof**
```powershell
node scripts/test-windows-observation-flow.js
node scripts/test-bug-fixes.js
```

#### Track H / Slice 2 — TradingView surface activation and editor-active verification

**Status:** Completed and committed

**Delivered so far**
- Pine authoring workflows now request stronger `editor-active` verification when the next meaningful step needs real editor control
- the shared observation checkpoint runtime recognizes `editor-active` / `editor-ready` verification kinds and returns Pine-specific failure messaging when activation cannot be confirmed
- focused regressions prove Pine typing is blocked until active-editor verification succeeds
- seam coverage now protects editor-active/editor-ready checkpoint support from regression

**Goal**
- explicitly distinguish:
  1. TradingView window focused
  2. Pine Editor panel visible
  3. Pine editor control active / ready for typing

**Exact files to change**
- `src/main/tradingview/verification.js`
  - add editor-state verification kinds such as:
    - `editor-visible`
    - `editor-active`
    - `editor-ready-for-typing`
- `src/main/tradingview/pine-workflows.js`
  - require stronger verification before allowing `ctrl+a`, destructive edit keys, or typing into Pine Editor workflows
  - separate `open Pine Editor` from `editor ready for authoring`
- `src/main/ai-service.js`
  - wire the stronger verification kinds into post-key checkpoints and failure reasons
- `scripts/test-windows-observation-flow.js`
  - add execution tests proving `ctrl+e` alone is not enough to unlock typing unless editor-active verification succeeds

**Regression additions**
- `scripts/test-windows-observation-flow.js`
  - `pine editor typing waits for editor-active verification`
  - `pine editor destructive edit is blocked until editor-ready state is observed`
- `scripts/test-bug-fixes.js`
  - seam assertions that TradingView checkpoints recognize editor-active / editor-ready verification kinds

**Acceptance proof**
```powershell
node scripts/test-windows-observation-flow.js
node scripts/test-bug-fixes.js
```

#### Track H / Slice 3 — Safe Pine authoring defaults

**Status:** Completed and committed

**Delivered so far**
- generic TradingView Pine creation requests now rewrite into inspect-first Pine Editor flows instead of defaulting to `ctrl+a` + `backspace` clear-first behavior
- explicit overwrite requests still preserve destructive clear steps when the user clearly asks to replace the current script
- added focused workflow, observation-flow, and seam regressions for safe Pine authoring defaults

**Goal**
- make Pine authoring default to inspect-first and `new script`-style flows instead of `ctrl+a` + `backspace` as the baseline strategy.

**Exact files to change**
- `src/main/tradingview/pine-workflows.js`
  - add safe authoring intent shaping for requests like:
    - `create a pine script`
    - `draft a new pine script`
    - `build a pine script`
  - prefer:
    - open Pine Editor
    - inspect visible state
    - create/open a new script path when available
    - only clear existing content for explicit overwrite intents
- `src/main/ai-service/system-prompt.js`
  - add guidance that Pine authoring should prefer safe new-script flows and bounded edits over destructive clear-first behavior
- `scripts/test-tradingview-pine-data-workflows.js`
  - add workflow-level regressions for safe new-script authoring intent
- `scripts/test-windows-observation-flow.js`
  - add execution-level regression that generic Pine creation requests do not default to destructive clear-first plans

**Regression additions**
- `scripts/test-tradingview-pine-data-workflows.js`
  - `generic pine script creation prefers safe new-script workflow`
  - `destructive clear remains reserved for explicit overwrite intent`
- `scripts/test-windows-observation-flow.js`
  - `pine creation flow avoids clear-first behavior without explicit overwrite request`

**Acceptance proof**
```powershell
node scripts/test-tradingview-pine-data-workflows.js
node scripts/test-windows-observation-flow.js
node scripts/test-bug-fixes.js
```

#### Track H / Slice 4 — Resume-after-confirmation re-establishes prerequisites

**Status:** Completed and committed

**Delivered so far**
- `resumeAfterConfirmation(...)` now re-establishes TradingView focus and Pine editor prerequisites before destructive edit continuation
- Pine resume prerequisite shaping explicitly re-opens or re-activates Pine Editor before assuming `ctrl+a`, destructive edit keys, or typing are still safe
- focused execution regressions now prove confirmation-resume flows do not assume ephemeral editor state or selection survived the pause

**Goal**
- after confirmation pauses, re-verify TradingView focus, Pine surface visibility, and editor-active state instead of assuming ephemeral selection/focus survived.

**Exact files to change**
- `src/main/ai-service.js`
  - make `resumeAfterConfirmation(...)` rehydrate editor prerequisites for TradingView Pine flows before destructive keys or typing
- `src/main/tradingview/pine-workflows.js`
  - add resume-safe prerequisite hints so Pine workflows can re-establish panel/editor readiness after confirmation
- `scripts/test-windows-observation-flow.js`
  - add behavioral coverage for Pine confirmation-resume flows that must re-open/re-activate the editor before continuing

**Regression additions**
- `scripts/test-windows-observation-flow.js`
  - `pine confirmation resume re-establishes editor state before destructive edit`
  - `confirmation pause does not assume ctrl+a selection survived`

**Acceptance proof**
```powershell
node scripts/test-windows-observation-flow.js
node scripts/test-bug-fixes.js
```

### Track I — TradingView shortcuts become app-specific tool knowledge

**Status:** Core slice completed and committed

**Delivered so far**
- added a dedicated TradingView shortcut capability/profile helper in `src/main/tradingview/shortcut-profile.js`
- stable defaults such as `/`, `Alt+A`, `Esc`, and `Ctrl+K` are now modeled as TradingView-specific capability knowledge instead of generic desktop shortcut doctrine
- drawing bindings are explicitly marked customizable / user-confirmed, and Trading Panel / DOM execution shortcuts remain context-dependent and paper-test only
- Pine Editor no longer assumes `ctrl+e` as a stable native TradingView shortcut; Pine workflows now route Pine Editor opening through a verified TradingView quick-search / command-palette path instead of hardcoding an ungrounded opener
- explicit legacy Pine Editor opener plans are now canonicalized into that TradingView quick-search route before execution and continuity persistence, so verified/explicit plans no longer preserve stale `ctrl+e` assumptions
- Pine Editor quick-search selection now validates and clicks the visible `Open Pine Editor` result instead of assuming `Enter` alone will activate the correct TradingView function item
- TradingView Pine workflows, prompt guidance, and shortcut regressions now consult and protect that app-specific shortcut profile

**Why this track exists**
- Official TradingView shortcut documentation and third-party workflow guides show an important distinction:
  - some shortcuts are stable defaults across many layouts (`/`, `Alt+A`, `Esc`, `Ctrl+K`)
  - some shortcuts are context-dependent (Trading Panel / DOM / Pine Editor)
  - some shortcuts are customizable (especially drawing-tool bindings)
- Those shortcuts should not live as generic desktop assumptions because they are specific to TradingView and may behave differently in other apps, browser contexts, layouts, or custom hotkey configurations.

**Goal**
- represent TradingView shortcut knowledge as TradingView-specific capability/profile data, not as a generic keyboard rule set.

**Primary files**
- `src/main/tradingview/shortcut-profile.js`
- `src/main/tradingview/pine-workflows.js`
- `src/main/tradingview/indicator-workflows.js`
- `src/main/tradingview/alert-workflows.js`
- `src/main/ai-service/system-prompt.js`
- `scripts/test-bug-fixes.js`
- `scripts/test-tradingview-shortcut-profile.js`

**Implementation checklist**
- define TradingView shortcut categories in a dedicated app-specific helper:
  - **stable defaults**: `/`, `Alt+A`, `Esc`, `Ctrl+K`, etc.
  - **context-dependent**: Pine Editor, Trading Panel, DOM, panel toggles
  - **customizable**: drawing tool bindings and user-mapped tools
  - **unsafe / paper-test only**: Trading Panel and DOM execution shortcuts
- teach TradingView workflows to consult that shortcut profile instead of embedding broad shortcut assumptions inline
- keep the system prompt honest:
  - stable defaults can be used when the relevant TradingView surface is verified
  - customizable shortcuts should be treated as unknown until user-confirmed
  - Trading/DOM shortcuts remain advisory-safe and paper-test only

**Regression additions**
- `scripts/test-tradingview-shortcut-profile.js`
  - `stable default shortcuts are exposed as tradingview-specific helpers`
  - `drawing shortcuts are marked customizable rather than universal`
  - `trading panel shortcuts are marked context-dependent and unsafe-by-default`
  - `pine editor opener is routed through TradingView quick search instead of a hardcoded native shortcut`
- `scripts/test-bug-fixes.js`
  - seam assertions that system prompt and TradingView workflows use TradingView-specific shortcut guidance instead of generic assumptions

**Acceptance proof**
```powershell
node scripts/test-tradingview-shortcut-profile.js
node scripts/test-tradingview-pine-workflows.js
node scripts/test-tradingview-pine-data-workflows.js
node scripts/test-windows-observation-flow.js
node scripts/test-bug-fixes.js
```

**Acceptance criteria**
- TradingView keyboard shortcut guidance is app-specific, not global desktop doctrine
- Liku can distinguish stable defaults from customizable/contextual shortcuts before proposing automation
- TradingView order/trading shortcuts remain explicitly non-generic and advisory-safe

### Track D — Pine-backed evidence gathering for concrete TradingView insight

**Status:** Core evidence slices completed and committed

**Delivered so far**
- extended `src/main/tradingview/pine-workflows.js` so Pine Logs evidence-gathering requests can stay verification-first while preserving or auto-appending bounded `get_text` readback
- extended `src/main/tradingview/pine-workflows.js` so Pine Profiler evidence-gathering requests can also stay verification-first while preserving or auto-appending bounded `get_text` readback
- extended `src/main/tradingview/pine-workflows.js` so Pine Version History provenance requests can stay verification-first while preserving or auto-appending bounded `get_text` readback
- extended `src/main/tradingview/pine-workflows.js` so Pine Editor visible status/output requests can stay verification-first while preserving or auto-appending bounded `get_text` readback
- added Pine Editor line-budget awareness so `500-line limit` / line-count checks prefer verified Pine Editor readback and prompt guidance now explicitly treats Pine scripts as capped at 500 lines when reading/writing
- refined Pine Editor readback into explicit `compile-result` and `diagnostics` evidence modes so visible compiler status, warnings, and errors can be summarized as bounded text evidence rather than generic status text
- structured Pine Version History provenance summaries now extract compact visible revision metadata instead of only returning raw visible text
- recent Pine continuation hardening keeps explicit Pine Editor opener plans aligned with the verified quick-search route instead of preserving stale hardcoded opener assumptions
- added dedicated Pine data-workflow regressions in `scripts/test-tradingview-pine-data-workflows.js`
- extended `scripts/test-windows-observation-flow.js` with verified Pine Logs, Pine Profiler, Pine Version History, and Pine Editor status/output readback coverage that gathers text without re-entering a screenshot loop
- updated `src/main/ai-service/system-prompt.js` so TradingView Pine output/error/provenance requests prefer verified Pine surfaces plus `get_text`, including Pine Editor visible status/output, over screenshot-only inference

**Why this track exists**
- Current Pine support is surface-oriented:
  - `src/main/tradingview/pine-workflows.js` opens Pine Editor, Pine Logs, Profiler, and Version History with verification
  - existing regressions only prove verified surface opening plus optional typing
- Real analysis quality would improve materially if Liku could use Pine workflows to gather structured data instead of relying only on screenshot interpretation.

**Goal**
- extend Pine support from “open the surface” to “gather bounded, concrete chart evidence that can support a safer synthesis.”

**Primary files**
- `src/main/tradingview/pine-workflows.js`
- `src/main/tradingview/verification.js`
- `src/main/tradingview/app-profile.js`
- `src/main/ai-service.js`
- `src/main/system-automation.js`
- `src/main/ai-service/system-prompt.js`
- `scripts/test-tradingview-pine-workflows.js`
- `scripts/test-windows-observation-flow.js`
- likely new: `scripts/test-tradingview-pine-data-workflows.js`

**Implementation checklist**
- add a bounded Pine data-gathering workflow layer, for example:
  - open Pine Editor or Logs with verification
  - type or paste a user-approved indicator/strategy snippet
  - trigger a non-destructive compile/run step
  - gather resulting output from Pine Logs / Profiler / visible status text
- explicitly separate safe evidence-gathering from unsafe authoring claims:
  - opening/reading Pine surfaces should be automatable
  - inventing or publishing scripts should remain opt-in and explicit
- use existing read-only runtime tools where helpful:
  - `run_command` for local file scaffolding or snippet preparation
  - `grep_repo` / `semantic_search_repo` if Pine snippets/templates become repo-backed assets
- prefer structured result capture when possible:
  - `get_text`
  - verified panel-open checks
  - clipboard-safe copy flows if later implemented
- add prompt guidance that Pine-derived output is stronger evidence than screenshot-only indicator guesses

**Suggested first Pine slice**
- `open pine logs in tradingview`
- verify `pine-logs`
- read visible error/output text
- return a bounded summary instead of speculative chart analysis

**Regression additions**
- `scripts/test-tradingview-pine-workflows.js`
  - `pine workflow recognizes pine logs evidence-gathering requests`
  - `pine workflow does not hijack speculative chart-analysis prompts`
- likely new `scripts/test-tradingview-pine-data-workflows.js`
  - `open pine logs and read output stays verification-first`
  - `pine evidence-gathering workflow preserves trailing get_text/read step`
- `scripts/test-windows-observation-flow.js`
  - `verified pine logs workflow allows bounded evidence gathering without screenshot loop`

**Acceptance criteria**
- Liku can gather concrete TradingView-adjacent evidence through Pine surfaces without pretending to have precise chart-state access it does not really have
- Pine workflows strengthen analysis honesty instead of bypassing it

**Next best slice from here**
- refine Pine Editor status/output readback into more structured visible compile-result / diagnostics summaries without implying chart-state insight

**Concrete next Pine slice — structured diagnostics and provenance summaries**

This is the next Pine-facing implementation slice after the current Logs / Profiler / Version History / Pine Editor readback foundation.

**Grounded status of recent Pine follow-ups**
- broader visible Pine status/output surfaces beyond Logs / Profiler / Version History are now implemented via verified `pine-editor` readback with bounded `get_text`
- script-audit / provenance refinement is now implemented:
  - verified Pine Version History opening plus raw visible text readback is implemented
  - structural extraction of the top visible revision metadata (for example revision label, relative time, author/source hints when visible, and compact summary formatting) is implemented
- explicit Pine Editor opener canonicalization is now aligned with the verified TradingView quick-search route, including explicit legacy plans and continuity fixtures

**Latest completed objectives**
- turned generic Pine Editor text readback into explicit visible diagnostics summaries
- turned generic Pine Version History text readback into explicit visible revision/provenance summaries
- aligned explicit Pine opener plans with the verified TradingView quick-search route before execution and continuity storage

**Completed priority order**
1. **Slice D-next-1 — Pine Editor compile-result / diagnostics summaries**
2. **Slice D-next-2 — Pine Version History top visible revision metadata summaries**

#### Slice D-next-1 — Pine Editor compile-result / diagnostics summaries

**Status:** Completed and committed

**Delivered so far**
- extended `src/main/tradingview/pine-workflows.js` so Pine Editor readback requests can classify bounded evidence modes:
  - `compile-result`
  - `diagnostics`
  - `line-budget`
  - `generic-status`
- refined Pine Editor `get_text` readback reasons and mode metadata so compile-result and diagnostics requests carry explicit bounded-summary intent instead of generic status wording
- updated `src/main/ai-service/system-prompt.js` with Pine diagnostics guidance that:
  - prefers visible compiler/diagnostic text over screenshot interpretation
  - treats `no errors` / compile success as compiler evidence only
  - mentions Pine execution-model caveats before inferring runtime or strategy behavior
- updated `src/main/ai-service/message-builder.js` to inject `## Pine Evidence Bounds` for Pine diagnostics-oriented requests
- added focused prompt coverage in `scripts/test-pine-diagnostics-bounds.js`
- extended workflow, seam, and execution regressions in:
  - `scripts/test-tradingview-pine-data-workflows.js`
  - `scripts/test-windows-observation-flow.js`
  - `scripts/test-bug-fixes.js`

**Why this slice should go first**
- the current `pine-editor` workflow already opens the correct surface and gathers bounded text evidence
- the remaining gap is interpretation structure, not UI access
- this is the highest-value next step for Pine debugging because compile/result state is more actionable than generic visible text

**Goal**
- summarize visible Pine Editor output into bounded categories such as:
  - compile success / no errors
  - compile errors
  - warnings / status-only output
  - line-budget proximity hints
- do this without claiming chart-state or runtime behavior that is not directly visible in the text evidence

**Primary files**
- `src/main/tradingview/pine-workflows.js`
- `src/main/ai-service/system-prompt.js`
- `src/main/ai-service/message-builder.js`
- `scripts/test-tradingview-pine-data-workflows.js`
- `scripts/test-windows-observation-flow.js`
- `scripts/test-bug-fixes.js`

**Exact changes to map in**
- `src/main/tradingview/pine-workflows.js`
  - extend Pine evidence-read intent shaping so requests such as:
    - `summarize compile result`
    - `read compiler errors`
    - `check diagnostics`
    - `summarize warnings`
    route to `pine-editor` bounded readback with stronger compile/diagnostic wording
  - add a small helper for Pine Editor evidence modes, for example:
    - `diagnostics`
    - `compile-result`
    - `line-budget`
    - `generic-status`
  - preserve existing verification-first open/read behavior and only refine the `get_text.reason` / mode metadata
- `src/main/ai-service/system-prompt.js`
  - add explicit Pine diagnostics guidance:
    - prefer visible compiler/diagnostic text over screenshot interpretation
    - separate visible compile status from inferred runtime/chart conclusions
    - mention Pine execution-model caveats when the user asks for strategy/runtime diagnosis
  - keep Pine 500-line awareness as a practical guardrail, but avoid treating it as the only limit
- `src/main/ai-service/message-builder.js`
  - add a compact Pine evidence guard block when the active app capability is TradingView and the user request is Pine-diagnostic in nature
  - include rules like:
    - summarize only what the visible text proves
    - do not turn `no errors` into market insight
    - do not infer runtime correctness from compile success alone

**Regression additions**
- `scripts/test-tradingview-pine-data-workflows.js`
  - `pine workflow recognizes compile-result requests`
  - `pine workflow recognizes diagnostics requests`
  - `open pine editor and summarize compile result stays verification-first`
  - `open pine editor and summarize diagnostics preserves bounded get_text readback`
- `scripts/test-windows-observation-flow.js`
  - `verified pine editor diagnostics workflow gathers compile text without screenshot loop`
  - `verified pine editor no-errors workflow preserves visible success text for bounded summary`
- `scripts/test-bug-fixes.js`
  - seam assertions that Pine prompt guidance includes compiler/diagnostic wording and that Pine workflows encode the new diagnostics mode hints

**Acceptance criteria**
- Liku can distinguish visible Pine Editor diagnostics from generic status text
- compile success is summarized honestly without implying runtime/market validity
- compile errors/warnings are surfaced as bounded evidence rather than screenshot-only speculation

#### Slice D-next-2 — Pine Version History top visible revision metadata summaries

**Status:** Completed and committed

**Delivered so far**
- extended `src/main/tradingview/pine-workflows.js` with a `provenance-summary` evidence mode for `pine-version-history`
- Version History metadata requests such as `summarize the top visible revision metadata` now preserve or auto-append bounded `get_text` provenance-summary readback
- `get_text` provenance-summary results now attach deterministic visible revision metadata such as latest visible revision label, latest visible relative time, visible revision count, and visible recency signal
- extended prompt/seam/execution coverage in:
  - `src/main/ai-service/message-builder.js`
  - `scripts/test-tradingview-pine-data-workflows.js`
  - `scripts/test-windows-observation-flow.js`
  - `scripts/test-bug-fixes.js`

**Why this is second**
- the UI access path is already implemented, but the current behavior is still just raw visible text gathering
- the next value is structural summarization of the top visible revisions, not merely reopening the panel

**Goal**
- summarize the top visible Pine Version History entries into compact provenance facts such as:
  - latest visible revision label/number
  - relative save time when visible
  - count of visible revisions in the current panel snapshot
  - whether the visible text implies recent churn or a stable revision list

**Primary files**
- `src/main/tradingview/pine-workflows.js`
- `src/main/ai-service/system-prompt.js`
- `src/main/ai-service/message-builder.js`
- `scripts/test-tradingview-pine-data-workflows.js`
- `scripts/test-windows-observation-flow.js`
- `scripts/test-bug-fixes.js`

**Exact changes to map in**
- `src/main/tradingview/pine-workflows.js`
  - extend evidence-read intent shaping so requests such as:
    - `summarize latest revision metadata`
    - `read top visible revisions`
    - `show visible provenance details`
    explicitly mark Version History as a provenance-summary workflow instead of a generic text readback
  - add a `provenance-summary` evidence mode for `pine-version-history`
- `src/main/ai-service/system-prompt.js`
  - add explicit provenance guidance:
    - summarize only visible revision metadata
    - do not infer hidden diffs or full script history from the visible list alone
    - treat Version History as audit/provenance evidence, not runtime/chart evidence
- `src/main/ai-service/message-builder.js`
  - add a compact Pine provenance guard block when the request is revision/history focused
  - reinforce that visible history entries are bounded UI evidence only

**Regression additions**
- `scripts/test-tradingview-pine-data-workflows.js`
  - `pine workflow recognizes visible revision metadata requests`
  - `pine version history provenance-summary workflow stays verification-first`
- `scripts/test-windows-observation-flow.js`
  - `verified pine version history workflow preserves top visible revision metadata text for bounded provenance summary`
- `scripts/test-bug-fixes.js`
  - seam assertions that Version History prompt guidance distinguishes provenance from runtime/chart evidence

**Acceptance criteria**
- Liku can summarize top visible revision metadata without overclaiming hidden history
- Version History output is framed as provenance/audit evidence only

**Recommended commit order from here**
1. `Track D: structure Pine Editor diagnostics summaries`
2. `Track D: structure Pine Version History provenance summaries`

### Track E — Honest drawing capability framing

**Status:** Completed and committed

**Delivered so far**
- strengthened `src/main/tradingview/drawing-workflows.js` so precise TradingView drawing-placement requests can be salvaged into bounded, verified surface-access workflows when a safe opener already exists
- bounded drawing rewrites now preserve only non-placement surface steps (for example opening drawing search and typing the drawing name) while dropping result-selection and chart-placement actions that would overclaim exact placement
- extended `src/main/tradingview/verification.js` and `src/main/ai-service.js` so residual precise TradingView drawing placement click/drag actions fail closed behind an advisory-only safety rail instead of executing as if exact chart-object placement were deterministic
- added focused workflow, seam, and execution regressions in:
  - `scripts/test-tradingview-drawing-workflows.js`
  - `scripts/test-windows-observation-flow.js`
  - `scripts/test-bug-fixes.js`

**Why this track exists**
- `src/main/tradingview/drawing-workflows.js` already refuses unsafe placement prompts such as `draw a trend line on tradingview`.
- Runtime responses can still imply more precise drawing capability than the current workflow actually guarantees.

**Goal**
- make the runtime honest about the difference between opening drawing tools and placing chart objects precisely.

**Primary files**
- `src/main/tradingview/drawing-workflows.js`
- `src/main/ai-service/system-prompt.js`
- `src/main/ai-service/message-builder.js`
- `scripts/test-tradingview-drawing-workflows.js`
- `scripts/test-windows-observation-flow.js`

**Implementation checklist**
- add prompt/routing language that distinguishes:
  - opening drawing tools or drawing search
  - opening object tree
  - precise object placement on the chart
- if the user requests exact trendline placement from screenshot-only evidence, respond with either:
  - a safe tool-surface workflow, or
  - an explicit honesty-bound refusal
- preserve current refusal behavior for unsafe placement hijacks

**Regression additions**
- `scripts/test-tradingview-drawing-workflows.js`
  - `drawing workflow keeps refusing unsafe placement prompts`
  - likely add `drawing capability wording distinguishes tool access from placement`
- `scripts/test-windows-observation-flow.js`
  - `drawing assessment request does not claim precise placement from screenshot-only evidence`

**Acceptance criteria**
- Liku does not imply that a chart object was placed precisely unless it has a deterministic verified workflow for that placement

## Recommended commit order for the next roadmap

Use this order to maximize safety and minimize cross-branch churn:

1. **Commit 1 — Launch rewrite hardening**
  - Track A only
  - lowest-risk behavioral fix with immediate user impact

2. **Commit 2 — Same-turn degraded-visual contract**
  - Track B only
  - keeps model honesty aligned with the already-strong continuity state

3. **Commit 3 — Forced observation fallback recovery**
  - Track C only
  - improves UX after Commit 2 makes bounded answers more important

4. **Commit 4 — Pine evidence-gathering foundation**
  - first slice of Track D
  - start with `pine-logs` / `pine-editor` evidence gathering, not full strategy authoring

5. **Commit 5 — Drawing capability framing hardening**
  - Track E only
  - mostly honesty/prompting/routing polish with targeted regressions

6. **Commit 6+ — Broader Pine-derived analysis workflows**
  - additional Track D slices after the foundation is stable
  - examples: compile-result reading, profiler/log summarization, bounded indicator-script assistance

## Practical recommendation

If only one slice is started next, the best first implementation is:

1. **Track A** — stop passive TradingView observation prompts from being rewritten into app launches
2. **Track B** — prevent degraded same-turn screenshots from producing overconfident chart claims
3. **Track D (first slice)** — use Pine Logs / Pine Editor as an evidence-gathering tool rather than screenshot-only inference

That sequence directly addresses the most important issues surfaced by real TradingView testing while opening a credible path toward more concrete chart insight.

## Proposed next roadmap generation (beyond the current continuity plan)

The continuity roadmap and its immediate TradingView hardening tracks are now implemented. The next roadmap should stop treating continuity as the primary problem and instead treat it as infrastructure that enables higher-integrity automation.

The most credible next roadmap is:

### Roadmap N1 — Response claim binding and proof-carrying answers

**Status (2026-03-29)**
- initial slice implemented
- landed via:
  - `src/main/claim-bounds.js`
  - `src/cli/commands/chat.js`
  - `src/main/ai-service/message-builder.js`
  - `scripts/test-claim-bounds.js`
  - `scripts/test-chat-forced-observation-fallback.js`
- current scope:
  - forced-observation prompts now require explicit `Verified result`, `Bounded inference`, `Degraded evidence`, and `Unverified next step` sections
  - bounded-fallback answers now emit that proof-carrying structure explicitly
  - low-trust / degraded response paths now receive an `Answer Claim Contract` prompt scaffold

**Why this should be next**
- The execution and continuity layers now collect more truthful verification data than the final natural-language answers always surface.
- The next quality gap is not just whether Liku executed safely, but whether its answer clearly separates:
  - verified result,
  - bounded inference,
  - degraded evidence,
  - and unverified next step.

**Goal**
- make final responses carry explicit claim provenance so Liku cannot silently overstate what execution or evidence actually proved.

**Primary files**
- `src/cli/commands/chat.js`
- `src/main/ai-service.js`
- `src/main/ai-service/message-builder.js`
- likely new: `src/main/claim-bounds.js`
- likely new: `scripts/test-claim-bounds.js`

**Initial implementation slices**
1. add a compact execution/evidence claim model (`verified`, `bounded`, `degraded`, `unverified`)
2. require forced-observation and bounded-fallback answers to emit that model explicitly
3. inject a proof-carrying answer scaffold into high-risk or low-trust response paths

**Acceptance criteria**
- answers no longer collapse verified UI state and speculative interpretation into one voice
- degraded evidence is visible in the final answer, not only in internal state or logs

### Roadmap N2 — Generalized searchable-surface selection contracts

**Status (2026-03-29)**
- first reusable slice implemented
- landed via:
  - `src/main/search-surface-contracts.js`
  - `src/main/tradingview/shortcut-profile.js`
  - `src/main/tradingview/indicator-workflows.js`
  - `scripts/test-search-surface-contracts.js`
  - `scripts/test-tradingview-indicator-workflows.js`
  - `scripts/test-windows-observation-flow.js`
- current scope:
  - Pine quick-search routing now shares a reusable searchable-surface contract instead of bespoke route assembly
  - TradingView indicator add flows now use `query -> visible result selection -> verification` instead of blind `Enter`
  - execution regressions now prove semantic result selection in the broader Windows observation flow

**Why this should be next**
- Pine quick-search selection was only one instance of a broader pattern.
- The same class of failure can recur anywhere Liku currently assumes `type + Enter` is equivalent to selecting the correct visible result.

**Goal**
- generalize the `search -> validate visible result -> select verified item` pattern across TradingView and other searchable surfaces.

**Primary files**
- `src/main/ai-service.js`
- `src/main/system-automation.js`
- `src/main/tradingview/shortcut-profile.js`
- `src/main/tradingview/indicator-workflows.js`
- `src/main/tradingview/alert-workflows.js`
- `src/main/tradingview/drawing-workflows.js`
- likely new: `src/main/search-surface-contracts.js`

**Initial implementation slices**
1. define a reusable contract for searchable surfaces (`query`, `expectedResultText`, `selectionAction`, `verification`)
2. migrate TradingView indicator search, alert search, object-tree search, and remaining command-palette style flows onto that contract
3. add execution regressions proving that visible-result validation outranks blind `Enter`

**Acceptance criteria**
- search-style workflows stop relying on implicit selection behavior
- visible result validation becomes reusable instead of Pine-only logic

### Roadmap N3 — Continuity freshness expiry and re-observation policy

**Why this should be next**
- Continuity is now persisted and routed well, but freshness is still mostly implicit.
- The next real failure class is stale-but-plausible continuity: old verified state surviving longer than it should.

**Goal**
- make continuity age, freshness loss, and re-observation requirements first-class routing signals.

**Primary files**
- `src/main/session-intent-state.js`
- `src/main/chat-continuity-state.js`
- `src/cli/commands/chat.js`
- `src/main/ai-service/ui-context.js`
- `src/main/ai-service/visual-context.js`
- likely new: `scripts/test-chat-continuity-freshness.js`

**Initial implementation slices**
1. add freshness budgets / expiry metadata to verified continuity facts
2. distinguish `still fresh`, `stale but recoverable`, and `expired — must re-observe`
3. make short `continue` turns auto-recover via re-observation when safe instead of either blindly continuing or only refusing

**Acceptance criteria**
- stale continuity does not masquerade as fresh proof
- continuation recovery becomes deterministic when freshness expires

### Roadmap N4 — Capability-policy matrix by app and surface class

**Why this should be next**
- Several current safety and honesty wins are still encoded as targeted TradingView or low-UIA heuristics.
- The next architectural step is to formalize those rules into a reusable capability-policy layer.

**Goal**
- move from app-specific patches toward a shared capability matrix that expresses what each app/surface supports safely:
  - semantic control,
  - keyboard control,
  - trustworthy background capture,
  - precise placement,
  - bounded text extraction,
  - and approval-time recovery.

**Primary files**
- `src/main/tradingview/app-profile.js`
- `src/main/ai-service/message-builder.js`
- `src/main/background-capture.js`
- `src/main/system-automation.js`
- likely new: `src/main/capability-policy.js`
- likely new: `scripts/test-capability-policy.js`

**Initial implementation slices**
1. define a normalized capability-policy schema
2. migrate TradingView-specific trust rules onto it first
3. extend coverage to browser, VS Code, and generic Electron surfaces

**Acceptance criteria**
- honesty and safety rules become explainable from policy data instead of scattered heuristics
- app onboarding gets easier because trust behavior is declared, not rediscovered ad hoc

### Roadmap N5 — Runtime transcript to regression pipeline

**Why this should be next**
- The strongest recent improvements all came from real runtime transcripts, then hand-converted into tests.
- That workflow works, but it is still too manual and easy to delay.

**Goal**
- turn real `liku chat` runtime failures into a fast, repeatable regression-ingestion workflow.

**Primary files**
- `scripts/`
- `scripts/fixtures/`
- `scripts/test-windows-observation-flow.js`
- likely new: `scripts/extract-transcript-regression.js`
- likely new: `docs/RUNTIME_REGRESSION_WORKFLOW.md`

**Initial implementation slices**
1. define a transcript fixture format for action plans, observations, and failure claims
2. add a helper that turns sanitized transcript snippets into regression skeletons
3. document the `runtime finding -> fixture -> focused test -> commit` workflow

**Acceptance criteria**
- future runtime failures are cheaper to capture and less likely to be lost between sessions
- hardening work stays grounded in observed behavior rather than imagined gaps

## Recommended order for the next roadmap

If the goal is maximum practical value with minimal churn, the next roadmap should be executed in this order:

1. **N1 — Response claim binding and proof-carrying answers**
2. **N2 — Generalized searchable-surface selection contracts**
3. **N3 — Continuity freshness expiry and re-observation policy**
4. **N5 — Runtime transcript to regression pipeline**
5. **N4 — Capability-policy matrix by app and surface class**

## Practical recommendation

If only one new roadmap is started immediately, the best next roadmap is:

1. **N1** if the priority is answer honesty and user trust
2. **N2** if the priority is preventing more Pine-like UI selection failures
3. **N3** if the priority is making short `continue` turns age-aware and safer over long pauses
