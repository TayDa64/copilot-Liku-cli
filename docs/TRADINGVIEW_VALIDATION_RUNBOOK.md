# TradingView Validation Runbook

## Purpose

Use this runbook to validate TradingView automation in the smallest safe seam first, then expand outward only after the opener and verification path are proven.

This document is grounded in the current repo source of truth, especially:

- `scripts/live-tradingview-smoke.js`
- `src/main/tradingview/pine-workflows.js`
- `src/main/tradingview/shortcut-profile.js`
- `src/main/tradingview/runtime/recovery.js`
- `src/main/ai-service.js`
- `src/main/ai-service/observation-checkpoints.js`
- `docs/RUNTIME_REGRESSION_WORKFLOW.md`

## Source-of-truth workflow map

### Live harness

`scripts/live-tradingview-smoke.js` is the runtime entrypoint.

It is responsible for:

- detecting an already-open TradingView window
- launching TradingView Desktop first when no window is present
- falling back to browser TradingView only if Desktop is not discoverable
- binding scenarios to the detected TradingView window
- starting the UI watcher
- writing scenario summaries, trace exports, and a run manifest
- stopping the watcher in `finally`

Relevant seams:

- `tryLaunchTradingViewDesktop()`
- `tryLaunchTradingViewBrowser()`
- `ensureTradingViewContext()`
- `buildFocusScenario()`
- `buildPineScenario()`
- `buildPineCreateSaveScenario()`
- `runScenario()`
- `main()`

### Pine workflow planner

`src/main/tradingview/pine-workflows.js` builds the Pine-specific action stream.

Key behavior:

- focuses TradingView first
- uses a routed Pine opener instead of inventing a fake native Pine Editor hotkey
- defaults to safe-authoring inspection before later edit/save work
- appends a bounded `get_text` inspection with `pineEvidenceMode: 'safe-authoring-inspect'`

Key seam:

- `buildTradingViewPineWorkflowActions()`

### Shortcut routing

`src/main/tradingview/shortcut-profile.js` is the source of truth for TradingView shortcut actions and route sequences.

Important rules already encoded in tests:

- `open-pine-editor` does **not** claim a stable native hotkey
- the generic opener route is modeled as `ctrl+k -> type "Pine Editor" -> enter`
- Pine-specific direct routes exist for explicit intents such as new indicator

Key seams:

- `buildTradingViewShortcutAction()`
- `buildTradingViewShortcutSequenceRoute()`
- `buildTradingViewShortcutRoute()`

### Focus lock and observation proof

`src/main/ai-service.js` and `src/main/ai-service/observation-checkpoints.js` own the execution and proof loop.

Key behavior:

- blocks or repairs focus before key/type/click input
- proves post-key surface changes using foreground info, watcher evidence, title keywords, and Pine readback evidence
- hands off to TradingView runtime recovery when the committed action did not immediately prove the intended surface

Key seams:

- `ensureFocusLockedBeforeInputAction()`
- `verifyKeyObservationCheckpoint()`
- `maybeRecoverDeferredTradingViewPineEditorBeforeReadback()`

### TradingView runtime recovery

`src/main/tradingview/runtime/recovery.js` is the source of truth for quick-search proof and Pine open recovery.

Key behavior:

- proves the quick-search input is ready before typing
- proves the expected query before Enter
- repairs a missing quick-search open
- repairs Pine opening after Enter through passive evidence, semantic click, or keyboard recovery

Key seams:

- `ensureTradingViewQuickSearchInputClearBeforeTyping()`
- `verifyTradingViewQuickSearchTypedValue()`
- `waitForTradingViewPineEditorEvidence()`
- `maybeRecoverTradingViewPineEditorOpen()`

## Route selection rules

Use the most specific documented TradingView route that matches the user's intent.

### Use the generic `open-pine-editor` route when the intent is:

- inspect Pine Editor state
- open Pine Editor without creating a fresh script yet
- recover a Pine surface in a safe-authoring workflow
- validate the opener seam itself

Current generic route in the repo:

- `ctrl+k`
- type `Pine Editor`
- `enter`

### Prefer official direct Pine routes when the intent is explicit

Prefer these when the request is specific enough:

- **new indicator** -> `Ctrl+K, Ctrl+I`
- **new strategy** -> `Ctrl+K, Ctrl+S`
- **open existing script** -> `Ctrl+O`
- **save script** -> `Ctrl+S`
- **add or update on chart** -> `Ctrl+Enter`

Practical rule:

- use `pine-editor` scenario to validate the opener
- use direct Pine routes for explicit authoring workflows whenever possible
- keep the generic quick-search route as the fallback/open-discovery path

## Validation ladder

Work through these steps in order. Do not jump to full author/save flows before the opener seam is green.

### 1. Dry-run the scenario plan first

Focus-only dry run:

```powershell
node scripts/live-tradingview-smoke.js --dry-run --scenarios focus
```

Pine opener dry run:

```powershell
node scripts/live-tradingview-smoke.js --dry-run --scenarios pine-editor
```

Create/save dry run:

```powershell
node scripts/live-tradingview-smoke.js --dry-run --scenarios pine-create-save --pine-source-profile industry-standard --pine-script-name "Industry Standard Trend Momentum Suite"
```

Expected outcome:

- the scenario prints the planned action list and exits
- no UI is manipulated
- the planned route matches the intended seam

### 2. Prove focus lock independently

```powershell
$env:LIKU_DEBUG_PINE_INSPECT='1'; node scripts/live-tradingview-smoke.js --scenarios focus
```

Success criteria:

- TradingView-like window is detected
- selected window is bound to the scenario
- foreground is proven or restored
- scenario summary is written

### 3. Validate the opener seam by itself

Use the smallest Pine validation seam first:

```powershell
$env:LIKU_DEBUG_PINE_INSPECT='1'; node scripts/live-tradingview-smoke.js --scenarios pine-editor
```

This scenario is preferable to full create/save when debugging Pine opening because it stops at bounded Pine inspection.

Success criteria:

- TradingView is detected on Desktop if available
- Pine opener route executes
- `editor-active` proof passes or recovery proves the Pine surface
- bounded safe-authoring `get_text` returns usable Pine surface evidence
- summary and manifest are written

Failure focus for this seam:

- quick-search did not open
- typed query could not be proven
- Enter committed but Pine activation was not proven
- recovery path could not prove Pine surface
- bounded Pine inspection exhausted candidates or returned `Element not found`

### 4. Only after opener is stable, run create/save

```powershell
$env:LIKU_DEBUG_PINE_INSPECT='1'; node scripts/live-tradingview-smoke.js --scenarios pine-create-save --pine-source-profile industry-standard --pine-script-name "Industry Standard Trend Momentum Suite" --pine-prompt "TradingView is already open. Create a new Pine script called \"Industry Standard Trend Momentum Suite\" using an industry-standard EMA 21/50 trend, RSI 14 confirmation, and ATR risk bands, save the script, and report the visible save status. Do not add it to the chart."
```

Success criteria:

- the opener seam remains green
- safe-authoring state is determined without destructive overwrite
- if Pine Editor opens the last worked script, the run treats that as normal TradingView behavior and stops unless a verified fresh-indicator starter, new-copy/save-as title flow, or explicit overwrite request is available
- save-state evidence is observed
- no unintended `Add to chart` action occurs

## Artifact-first debugging

Prefer artifacts over long scrollback.

The harness already writes:

- scenario summary JSON
- runtime trace JSONL when exported
- run manifest JSON

Expected outputs include lines such as:

- `Summary: ...`
- `Trace: ...`
- `Manifest: ...`

When live behavior disagrees with a green test suite:

1. keep the smallest failing live run
2. capture the summary/trace/manifest
3. convert the runtime finding into a focused regression
4. only then generalize the fix

See also:

- `docs/RUNTIME_REGRESSION_WORKFLOW.md`

## Terminal and execution hygiene

These rules are mandatory for live TradingView validation.

### One live scenario per terminal

Do not overlap live TradingView smoke runs across multiple persistent terminals.

Reason:

- focus-sensitive runs compete for foreground
- UI watcher evidence becomes ambiguous
- launcher fallback can mix Desktop and browser expectations

### Always dry-run before live mutation

Use `--dry-run` before any new scenario combination or prompt variant.

Reason:

- confirms route composition without moving the UI
- catches the wrong scenario before a live TradingView run starts

### Kill on no forward progress

Do not leave a persistent live run attached when output is not advancing.

Treat the run as stalled and stop it when:

- repeated polls do not advance the action index
- output repeats the same Pine fallback sweep without reaching a new checkpoint
- no `Summary:` or `Manifest:` line appears after the run has clearly stopped making progress

Practical rule:

- if the terminal is not producing a new action checkpoint, new recovery signal, or final artifact line after multiple polls, kill it and inspect artifacts or targeted seams instead of continuing to burn model attention

### Use sync for bounded validation, async only when necessary

Prefer bounded runs and explicit terminal cleanup.

If an async or timed-out run leaves a persistent terminal behind:

- inspect output once
- decide whether progress is still real
- kill the terminal if the run is stalled

### Separate Desktop and browser conclusions

Desktop-first is the preferred validation surface for Pine opener work.

Reason:

- watcher and window-handle evidence is stronger
- foreground trust is clearer
- browser fallback is still useful, but it is a different reliability surface

Do not mix Desktop and browser findings in the same conclusion unless both were tested intentionally.

### Keep the success criterion narrow

For opener debugging, the first acceptable success criterion is:

- Pine Editor surface verified
- safe-authoring `get_text` completed

Not:

- full script authoring
- full save flow
- chart mutation

This keeps the live run aligned to the actual bottleneck.

## Recommended debugging order for the current Pine opener bottleneck

1. `--dry-run --scenarios pine-editor`
2. live `--scenarios focus`
3. live `--scenarios pine-editor`
4. inspect summary + manifest + trace
5. only then escalate to `pine-create-save`

If the failure occurs after `enter` in quick search:

- inspect `verifyKeyObservationCheckpoint()` behavior
- inspect `maybeRecoverTradingViewPineEditorOpen()` behavior
- confirm whether the run reached recovery or spent time inside bounded Pine text probing

## Related tests and source anchors

High-signal source anchors:

- `scripts/live-tradingview-smoke.js`
- `src/main/tradingview/pine-workflows.js`
- `src/main/tradingview/shortcut-profile.js`
- `src/main/tradingview/runtime/recovery.js`
- `src/main/ai-service/observation-checkpoints.js`
- `src/main/ai-service.js`

High-signal tests:

- `scripts/test-tradingview-shortcut-profile.js`
- `scripts/test-tradingview-pine-workflows.js`
- `scripts/test-tradingview-pine-data-workflows.js`
- `scripts/test-ai-service-pine-open-short-circuit.js`
- `scripts/test-windows-observation-flow.js`
- `scripts/test-observation-checkpoints-pine-text-probe.js`
