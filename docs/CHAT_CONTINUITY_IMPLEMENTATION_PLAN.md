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

**Status:** Completed in working tree

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

**Status:** Completed in working tree

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

**Status:** Completed in working tree

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

**Status:** Completed in working tree

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

**Status:** Completed in working tree

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

**Status:** In progress in working tree

**Delivered so far**
- extracted TradingView app identity/profile normalization to `src/main/tradingview/app-profile.js`
- extracted TradingView observation/risk inference to `src/main/tradingview/verification.js`
- extended TradingView observation/risk inference with paper-trading mode detection and refusal guidance
- extracted deterministic TradingView indicator workflow shaping to `src/main/tradingview/indicator-workflows.js`
- extracted deterministic TradingView alert workflow shaping to `src/main/tradingview/alert-workflows.js`
- extracted TradingView chart verification plus timeframe/symbol/watchlist workflow shaping to `src/main/tradingview/chart-verification.js`
- extracted verification-first TradingView drawing/object-tree surface workflow shaping to `src/main/tradingview/drawing-workflows.js`
- extracted verification-first TradingView Pine Editor surface workflow shaping to `src/main/tradingview/pine-workflows.js`
- extracted verification-first TradingView Depth of Market surface workflow shaping to `src/main/tradingview/dom-workflows.js`
- extracted reusable post-key observation checkpoint helpers to `src/main/ai-service/observation-checkpoints.js`
- added direct module regressions in `scripts/test-tradingview-app-profile.js` and `scripts/test-tradingview-verification.js`
- added paper-trading detection and refusal-message regression coverage in `scripts/test-tradingview-verification.js`
- added direct indicator-workflow regression coverage in `scripts/test-tradingview-indicator-workflows.js`
- added direct alert-workflow regression coverage in `scripts/test-tradingview-alert-workflows.js`
- added direct chart-verification regression coverage in `scripts/test-tradingview-chart-verification.js`
- added direct drawing-workflow regression coverage in `scripts/test-tradingview-drawing-workflows.js`
- added direct Pine workflow regression coverage in `scripts/test-tradingview-pine-workflows.js`
- added direct DOM workflow regression coverage in `scripts/test-tradingview-dom-workflows.js`

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

**Objective**
- let Liku ground coding and recovery assistance through explicit repo/process search actions

**Primary files**
- likely new: `src/main/repo-search-actions.js`
- `src/main/system-automation.js`
- `src/main/ai-service/system-prompt.js`
- `src/cli/liku.js`

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
node scripts/test-run-command.js
node scripts/test-ai-service-contract.js
```

**Dependency notes**
- does not block continuity implementation, but compounds its usefulness for dev-facing tasks

### Milestone 7 — Non-disruptive vision for approval-time continuity

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
node scripts/test-session-intent-state.js
node scripts/test-chat-continuity-prompting.js
```

**Dependency notes**
- this is intentionally later-stage architecture work
- it should build on Milestones 1–5 rather than replace them

## Recommended handoff into implementation work

Once implementation begins, the strongest first coding slice is:

1. **Milestone 1** — state-first continuation routing
2. **Milestone 2** — evidence quality / degraded screenshot trust
3. **Milestone 3** — reusable verification contracts

That sequence gives the best implementation starting point because it directly addresses the transcript-proven failure modes before larger modularization or future platform work.
