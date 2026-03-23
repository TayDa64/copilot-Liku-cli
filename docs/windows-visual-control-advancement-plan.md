# Windows Visual And Control Advancement Plan

> This plan is grounded in recent `liku chat` runtime behavior against TradingView-style Windows apps. It focuses on improving observation continuity, app control routing, and post-action verification without regressing the browser recovery, UIA, and low-risk automation paths already in place.

## Goal
Make Liku more reliable when the user asks it to activate a Windows app, observe what is visible, and explain or use the controls that are actually available.

## Why This Plan Exists
Recent runtime behavior exposed four concrete weaknesses:

- A successful `focus_window` action can end the turn without continuing into observation.
- Chromium/Electron/canvas-heavy apps expose weak UIA data, so Live UI State can under-report available controls.
- Liku already supports richer Windows controls than it explains back to the user.
- Post-launch verification has at least one trust-breaking bug in the running PID reporting path.

## Product Outcomes
- After focusing an app, Liku should continue into observation when the user asked an observational question.
- Liku should distinguish between UIA-visible controls, keyboard/window controls, and screenshot-only visual controls.
- Liku should classify target apps and route between UIA-first, vision-first, and keyboard-first strategies.
- Launch and focus verification should be trustworthy and explain failures clearly.

## Scope
- Focus/follow-up behavior in CLI chat flows.
- Windows app capability classification and response guidance.
- Scoped screenshot and watcher-settle behavior for observation tasks.
- Verification fixes for target process and focus checks.
- Regression coverage for TradingView-like desktop apps.

## Non-Goals
- Full OCR or CV stack replacement.
- Complete automation of every Chromium-rendered control in third-party apps.
- Replacing the existing browser recovery flow.
- Replacing UIA with screenshot-only reasoning everywhere.

## Established Functionality We Must Preserve
- Browser recovery after repeated failed direct navigation.
- Low-risk action batching and safety confirmation behavior.
- Existing UIA-first actions such as `click_element`, `find_element`, `get_text`, `set_value`, `expand_element`, and `collapse_element`.
- Existing launch verification and popup recipe flow for supported apps.
- Existing screenshot-based continuation for browser tasks and other explicit vision flows.

## Current Code Anchors
- `src/cli/commands/chat.js`: screenshot-driven continuation loop and chat execution flow.
- `src/main/ai-service.js`: action execution, post-action verification, browser/session state, cognitive feedback.
- `src/main/system-automation.js`: focus/window actions, process lookup, UIA-backed action execution.
- `src/main/ui-watcher.js`: Live UI State polling and focused-window element enumeration.
- `src/main/ai-service/system-prompt.js`: model instructions for controls, screenshots, and fallbacks.
- `src/main/ai-service/visual-context.js`: bounded visual context store.

## Problem Breakdown
### P1. Post-focus continuity gap
- `focus_window` and `bring_window_to_front` can succeed without automatically continuing into a screenshot-driven observation step.
- Result: the user asks "what do you see?" and the turn stops after focus.

### P2. Weak capability routing for Electron/canvas apps
- Live UI State is derived from focused-window UIA descendants.
- Result: apps like TradingView may show only top-level shell/window metadata even when meaningful controls are visually present.

### P3. Under-explained control surface
- Liku can already do more than the chat answer implies.
- Result: the user gets an incomplete explanation of what Liku can control in a Windows app.

### P4. Verification trust issues
- Running PID output can show invalid values.
- Focus success is locally verified in automation but not always turned into an actionable continuation or recovery path in chat.

### P5. Fragile app-name resolution
- Misspellings like `tradeing view` propagate into verify-target and learned-skill state.
- Result: lower launch reliability and noisy auto-learned candidates.

## Deliverables
1. Observation continuation after window activation.
2. App capability classifier for Windows desktop targets.
3. Clear control-surface explanation model for observation questions.
4. PID verification fix and stronger focus verification reporting.
5. Regression tests for TradingView-like app flows.

## Status
- Completed: Phase 1 through Phase 5 implementation.
- Completed: runtime-style TradingView-like regression coverage via `scripts/test-windows-observation-flow.js`.
- Validation path: `npm run test:ai-focused` plus any seam-specific checks for the module under change.

## Execution Phases
### Phase 1. Fix trust and continuity first
Objective: make the current interaction model behave correctly before adding more heuristics.

- Add a post-focus continuation path when the user intent is observational.
- After successful `focus_window` or `bring_window_to_front`, wait briefly, capture a scoped screenshot, and continue automatically.
- Gate that behavior so it only applies to observation-oriented prompts, not every focus action.
- Fix the running PID formatting bug in process verification.
- Surface focus verification failure as an explicit continuation/retry decision instead of silently ending the turn.

Exit criteria:
- A focus-only action on a target app can continue into "what do you see?" without requiring the user to ask again.
- Running PID output is valid and non-zero when a process is truly found.

### Phase 2. Add app capability classification
Objective: route the right control strategy based on app characteristics.

- Introduce a lightweight classifier that labels the foreground target as one of:
  - UIA-rich native app
  - browser
  - Electron/Chromium shell
  - canvas-heavy or low-UIA app
- Feed that classification into continuation guidance and prompt context.
- For low-UIA apps, prefer screenshot analysis plus keyboard/window actions over pretending UIA coverage exists.

Exit criteria:
- Observation and control responses are strategy-aware instead of generic.
- TradingView-like apps are treated as low-UIA or visual-first targets.

### Phase 3. Improve control-surface explanations
Objective: answer user questions about controls honestly and usefully.

- Split responses into:
  - controls directly targetable through UIA
  - reliable window/keyboard controls
  - visible but screenshot-only controls
- Add prompt instructions so the model does not over-claim what it can inspect.
- Prefer `find_element` or `get_text` before saying no controls are available when UIA data exists.

Exit criteria:
- When asked "what controls can you use?", Liku explains real capability boundaries instead of giving a flat yes/no answer.

### Phase 4. Harden launch/focus verification
Objective: make app activation state more trustworthy.

- Strengthen focus verification after activation with bounded retries.
- Prefer processName-based window targeting over bare handle when sufficient metadata exists.
- If focus fails, attempt `restore_window` plus re-focus before giving up.
- Wait for one fresh watcher cycle before answering observational questions after focus changes.

Exit criteria:
- Focus drift back to VS Code or the terminal is detected and explained.
- Observation responses use fresh watcher data or a fresh screenshot, not stale state.

### Phase 5. Improve app-name normalization
Objective: reduce failures from user misspellings and noisy skill learning.

- Normalize user-provided app names against running processes, known aliases, and start-menu-friendly labels.
- Use the normalized name for `verifyTarget`, process matching, and AWM skill extraction.
- Keep the original user phrase for transcript transparency, but do not let it poison execution state.

Exit criteria:
- `tradeing view` resolves to TradingView-equivalent verification hints.
- Learned skills are scoped to normalized app identity, not user typos.

## Detailed Task List
### Milestone A. Post-focus observation continuity
- A1: detect observation-oriented prompts in chat execution flow.
- A2: after successful focus action, enqueue a short settle wait plus scoped screenshot.
- A3: route into the existing continuation loop using focused-window visual context.
- A4: add stop guidance for non-browser observation continuations similar to the browser recovery hints.

### Milestone B. Verification fixes
- B1: fix `getRunningProcessesByNames` projection bug so `pid` survives sorting and final selection.
- B2: add regression test for valid non-zero PIDs in post-launch verification state.
- B3: promote failed focus verification into a structured follow-up signal.

### Milestone C. Capability classifier
- C1: classify target app using process name, window class/title, UIA density, and watcher evidence.
- C2: include capability mode in system/context messages.
- C3: add classifier coverage tests for browser, native UIA app, and Chromium/Electron shell patterns.

### Milestone D. Control explanation model
- D1: add prompt guidance for answering control-surface questions.
- D2: prefer semantic reads before falling back to screenshot-only explanations.
- D3: add regression test for response shaping on observation prompts.

### Milestone E. App-name normalization
- E1: build a normalization helper for app launch and verification targets.
- E2: use it in launch-plan rewrite and verification inference.
- E3: prevent typo-fragment process names from seeding learned skill scope.

## Regression Guardrails
### Invariants
- Browser recovery behavior remains unchanged unless the task is clearly a non-browser desktop-app observation flow.
- Existing UIA actions remain preferred when a target element is actually present in Live UI State.
- Screenshot continuation remains bounded.
- Popup recipe flows remain opt-in and post-launch only.
- Low-risk launch flows stay low-friction; no extra confirmation prompts should appear for simple app launch/focus actions.

### Required Test Coverage
- Focus-only observation flow continues automatically into screenshot analysis.
- Browser recovery tests remain green.
- Launch verification produces valid running PIDs.
- Observation answers on low-UIA apps do not falsely claim named controls from absent UIA data.
- Normal launch/open-app flows still pass existing contract/state tests.

## Suggested Tests
- Unit: app capability classifier for representative process/title pairs.
- Unit: app-name normalization from misspelled user input.
- Unit: PID projection from running process enumeration.
- Integration: focus target app, auto-capture scoped screenshot, continue with observation response.
- Integration: TradingView-like app classified as visual-first or low-UIA.
- Regression: browser recovery and skill inline smoothness still pass.

Current coverage note:
- The integrated Windows observation-flow regression now exercises typo-normalized launch targeting, bounded focus recovery, watcher freshness waiting, and stale-state warning behavior without requiring a real TradingView install.

## Risks
- Over-eager screenshot continuation could make simple focus tasks feel noisy.
- Capability classification based only on process/title heuristics may be too brittle without watcher density signals.
- App-name normalization could mis-resolve similarly named apps if not bounded carefully.

## Decision Rules For Iteration
- Prefer orchestration improvements before adding new action types.
- Fix trust-breaking bugs before broadening capability claims.
- If a behavior depends on weak UIA coverage, explicitly route to screenshot reasoning instead of pretending semantic control exists.
- Any new continuation logic must be bounded and tested against existing browser flows.

## Acceptance Criteria
- User can say "bring TradingView to the front and tell me what you see" and Liku completes the observation flow in one turn.
- Liku explains the difference between what it can directly control and what it can only describe visually.
- Launch/focus verification no longer reports bogus PID values.
- Existing browser recovery, UIA actions, and low-risk automation behavior remain intact.

## Working Notes
- Start with Phase 1 and Phase 2. They deliver the most user-visible improvement with the lowest architecture risk.
- Do not expand into OCR-heavy or external CV work unless the current screenshot continuation path proves insufficient.
- Reuse existing continuation and verification seams rather than inventing a parallel observation pipeline.