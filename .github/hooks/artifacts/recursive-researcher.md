## Research Report

### Query
Read-only source-of-truth synthesis of the TradingView workflow implementation in this repo, with special focus on the live bottleneck around opening Pine Editor after quick-search Enter, plus official TradingView workflow/shortcut research and terminal-execution hygiene.

### Section A: concise architecture map with file paths and function names
1. **Top-level TradingView integration**
   - `src/main/tools/tradingview-tool.js` is the facade that re-exports TradingView app-profile, verification, and rewrite helpers into the main executor surface (`src/main/tools/tradingview-tool.js:1-62`).
   - `src/main/tradingview/rewrite-runner.js` centralizes ordered TradingView rewrites in `applyTradingViewReliabilityRewrites()` (`src/main/tradingview/rewrite-runner.js:1-89`).
   - `src/main/tradingview/registry-bootstrap.js` wires those rewrites and TradingView risk assessment into the internal registries via `registerTradingViewRegistryBootstrap()` (`src/main/tradingview/registry-bootstrap.js:1-30`).

2. **App identity, verification hints, and launch**
   - `src/main/tradingview/app-profile.js`
     - `resolveNormalizedAppIdentity()` normalizes names/aliases/processes/titles (`src/main/tradingview/app-profile.js:127-229`).
     - `buildVerifyTargetHintFromAppName()` builds process/title/keyword families for chart, Pine, DOM, and Paper Trading verification (`src/main/tradingview/app-profile.js:248-269`).
     - `buildOpenApplicationActions()` builds the Windows Start-menu launch plan (`src/main/tradingview/app-profile.js:271-281`).
   - `scripts/live-tradingview-smoke.js`
     - `findTradingViewContext()`, `tryLaunchTradingViewDesktop()`, `tryLaunchTradingViewBrowser()`, and `ensureTradingViewContext()` implement discovery + desktop-first/browser-fallback launch (`scripts/live-tradingview-smoke.js:193-325`).

3. **Focus locking and general executor control**
   - `src/main/ai-service.js`
     - `verifyForegroundFocus()` checks/reacquires the expected foreground window (`src/main/ai-service.js:5379-5456`).
     - `ensureFocusLockedBeforeInputAction()` blocks or repairs focus before key/type/click input (`src/main/ai-service.js:5509-5715`).
     - The main execution loop uses that focus lock before all relevant input actions (`src/main/ai-service.js:7445-7505`).

4. **Shortcut registry and route building**
   - `src/main/tradingview/shortcut-profile.js`
     - `buildTradingViewShortcutAction()` turns a single documented shortcut into an executable action (`src/main/tradingview/shortcut-profile.js:494-519`).
     - `buildTradingViewShortcutSequenceRoute()` builds multi-step chord routes (`src/main/tradingview/shortcut-profile.js:521-569`).
     - `buildTradingViewShortcutRoute()` is the key route builder for TradingView surfaces, including `open-pine-editor` (`src/main/tradingview/shortcut-profile.js:571-690`).
   - Important contract: `open-pine-editor` intentionally has **no stable direct key** in the repo’s profile; the test suite locks that in and expects the quick-search route `ctrl+k -> type "Pine Editor" -> enter` when using the generic opener (`scripts/test-tradingview-shortcut-profile.js:131-145`).

5. **Pine intent detection, rewrite, safe authoring, and resume**
   - `src/main/tradingview/pine-workflows.js`
     - `inferTradingViewPineIntent()` detects Pine-related intent (`src/main/tradingview/pine-workflows.js:789-905`).
     - `buildTradingViewPineWorkflowActions()` builds the bounded Pine workflow, including opener route, verification, and safe-authoring inspect step (`src/main/tradingview/pine-workflows.js:906-1076`).
     - `maybeRewriteTradingViewPineWorkflow()` upgrades low-signal plans into the bounded TradingView Pine workflow (`src/main/tradingview/pine-workflows.js:1077-1117`).
     - `buildTradingViewPineResumePrerequisites()` re-establishes the Pine surface before resumed authoring (`src/main/tradingview/pine-workflows.js:1118-1165`).
   - Key nuance: safe-authoring/inspect-first Pine rewrites intentionally avoid static quick-search `ctrl+a/backspace` steps and push stale-query handling into runtime proof/clear logic instead (`src/main/tradingview/pine-workflows.js:935-973`; `scripts/test-windows-observation-flow.js:1848-1942`).

6. **Post-key observation checkpoints and proof**
   - `src/main/ai-service/observation-checkpoints.js`
     - `inferKeyObservationCheckpoint()` infers post-key checkpoints for TradingView actions (`src/main/ai-service/observation-checkpoints.js:255-303`).
     - `verifyKeyObservationCheckpoint()` verifies quick-search, panel, editor, and chart-state transitions using foreground/title/window-kind/watcher/Pine-text evidence (`src/main/ai-service/observation-checkpoints.js:458-650`).
   - TradingView-specific verification/risk shaping lives in `src/main/tradingview/verification.js`, especially `inferTradingViewObservationSpec()`, `inferTradingViewTradingMode()`, and `detectTradingViewDomainActionRisk()` (`src/main/tradingview/verification.js:17-114,116-258`).
   - `src/main/ai-service.js`
     - `mergeObservationCheckpointIntoProof()` promotes checkpoint results into proof records/runtime proof checks (`src/main/ai-service.js:6508-6555`).

7. **Runtime recovery and short-circuit helpers**
   - `src/main/tradingview/runtime/recovery.js`
     - `ensureTradingViewQuickSearchInputClearBeforeTyping()` proves emptiness or expected-query state before typing (`src/main/tradingview/runtime/recovery.js:584-900`).
     - `verifyTradingViewQuickSearchTypedValue()` proves the exact typed query before Enter (`src/main/tradingview/runtime/recovery.js:902-1036`).
     - `waitForTradingViewPineEditorEvidence()` performs passive evidence polling after the commit (`src/main/tradingview/runtime/recovery.js:1038-1115`).
     - `maybeRecoverTradingViewQuickSearchOpen()` repairs a `ctrl+k` quick-search open via trusted surface probe + semantic input focus (`src/main/tradingview/runtime/recovery.js:1172-1228`).
     - `maybeRecoverTradingViewPineEditorOpen()` is the Pine post-Enter recovery chain: passive probe -> semantic result click -> keyboard selection (`src/main/tradingview/runtime/recovery.js:1230-1338`).
   - `src/main/ai-service.js`
     - `maybeRecoverDeferredTradingViewPineEditorBeforeReadback()` retries Pine recovery immediately before bounded Pine readback if the earlier Enter checkpoint was deferred (`src/main/ai-service.js:6260-6338`).
     - `getTradingViewPineEditorAlreadyOpenSignal()` / `buildSatisfiedTradingViewPineEditorSkipResult()` short-circuit the opener when watcher anchors already prove Pine is open (`src/main/ai-service.js:6397-6507`).

8. **Live harness and regression sources of truth**
   - `scripts/live-tradingview-smoke.js`
     - `buildFocusScenario()`, `buildPineScenario()`, `buildPineCreateSaveScenario()`, `runScenario()`, and `main()` drive the real end-to-end smoke path through `aiService.executeActions()` and export scenario summaries/traces/manifests (`scripts/live-tradingview-smoke.js:401-423,558-732,758-909`).
   - High-signal regression files:
     - `scripts/test-tradingview-shortcut-profile.js`
     - `scripts/test-tradingview-pine-workflows.js`
     - `scripts/test-tradingview-pine-data-workflows.js`
     - `scripts/test-ai-service-pine-open-short-circuit.js`
     - `scripts/test-windows-observation-flow.js`

**Most relevant files/functions to the current live bottleneck around “open Pine Editor after quick-search Enter”**
- `src/main/tradingview/shortcut-profile.js` -> `buildTradingViewShortcutRoute()` emits the generic `open-pine-editor` quick-search commit path (`ctrl+k -> type "Pine Editor" -> enter`) because no stable direct native `open-pine-editor` hotkey is claimed (`src/main/tradingview/shortcut-profile.js:571-690`; `scripts/test-tradingview-shortcut-profile.js:131-145`).
- `src/main/tradingview/pine-workflows.js` -> `buildTradingViewPineWorkflowActions()` chooses the opener route and, in inspect-first/safe-authoring paths, intentionally avoids static clear-first steps, which shifts responsibility to runtime preflight/recovery (`src/main/tradingview/pine-workflows.js:906-1076`; `scripts/test-windows-observation-flow.js:1848-1942`).
- `src/main/ai-service.js` -> `getTradingViewQuickSearchEnterVerificationFailure()` refuses Enter unless the expected query was proven; `shouldAllowTradingViewQuickSearchTypeFallback()` currently hard-returns `false`; `shouldDeferTradingViewPineEditorCheckpointFailure()` only defers when the next meaningful step is Pine `get_text` (`src/main/ai-service.js:6121-6205`).
- `src/main/ai-service/observation-checkpoints.js` -> `verifyKeyObservationCheckpoint()` decides whether Enter actually surfaced Pine using watcher anchors, title/keyword/window-kind evidence, and a bounded Pine text probe (`src/main/ai-service/observation-checkpoints.js:310-650`).
- `src/main/tradingview/runtime/recovery.js` -> `maybeRecoverTradingViewPineEditorOpen()` is the exact post-Enter rescue path when Enter alone does not produce verified Pine activation (`src/main/tradingview/runtime/recovery.js:1230-1338`).
- `scripts/test-tradingview-pine-data-workflows.js:475-482` confirms transcript-style Pine plans are rewritten through the verified quick-search opener plus fresh safe-authoring inspection.
- `scripts/test-windows-observation-flow.js` is the best regression specification for the bottleneck:
  - semantic-click recovery after Enter (`scripts/test-windows-observation-flow.js:1470-1490`)
  - deferred pre-`get_text` recovery before safe-authoring inspect (`scripts/test-windows-observation-flow.js:1492-1649`)
  - fail-closed quick-search empty-state proof (`scripts/test-windows-observation-flow.js:3468-3478,3604-3610`)
- `scripts/test-ai-service-pine-open-short-circuit.js:141-184` is the complementary proof that if watcher anchors already show Pine is open, the entire opener route should be skipped.

### Section B: TradingView shortcut/workflow research findings
1. **Official TradingView shortcuts most relevant to this repo**
   - Chart:
     - `Ctrl+K` = Quick search
     - `/` = Open indicators
   - Pine Script Editor:
     - `Ctrl+Enter` = Add to chart / Update on chart
     - `Ctrl+K, Ctrl+I` = New indicator
     - `Ctrl+K, Ctrl+S` = New strategy
     - `Ctrl+O` = Open script
     - `Ctrl+S` = Save script
     - `F1` and `Ctrl+Shift+P` = Command Palette
   - Source: official TradingView shortcuts page: https://www.tradingview.com/support/shortcuts/

2. **What the official shortcuts do *not* give you**
   - I did **not** find an official dedicated, stable “Open Pine Editor” hotkey on the official shortcuts page.
   - That makes the repo’s current posture correct in one important respect: it does **not** invent a fake native `open-pine-editor` key; it treats “open Pine Editor” as a routed workflow rather than as a single official shortcut. That matches both the shortcut page and the repo’s own locked tests (`scripts/test-tradingview-shortcut-profile.js:131-145`; https://www.tradingview.com/support/shortcuts/).

3. **Official Pine workflow guidance most relevant to automation**
   - `/` opens the indicators dialog; built-in scripts opened from there are read-only in the Pine Editor until you create a working copy. Source: TradingView Pine docs, “First steps”: https://www.tradingview.com/pine-script-docs/primer/first-steps/
   - The basic authoring flow is: create a new indicator/strategy, edit code, save it, then add/update it on the chart. Source: TradingView Pine docs, “First indicator”: https://www.tradingview.com/pine-script-docs/primer/first-indicator/
   - If a script is not active on the chart, the workflow is to open its source in Pine Editor and select Add to chart. Source: TradingView Pine docs, “Publishing”: https://www.tradingview.com/pine-script-docs/writing/publishing/
   - Pine troubleshooting/quality workflow also explicitly surfaces Pine Logs / Pine Profiler / publishing hygiene, which supports the repo’s decision to model Pine as a verified workflow surface, not just raw typing. Sources: https://www.tradingview.com/pine-script-docs/welcome/ and https://www.tradingview.com/pine-script-docs/writing/publishing/

4. **Automation-relevant workflow implications**
   - The most deterministic official Pine entry surfaces are:
     1. **New indicator** (`Ctrl+K Ctrl+I`)
     2. **New strategy** (`Ctrl+K Ctrl+S`)
     3. **Open existing script** (`Ctrl+O`)
   - `Ctrl+K` quick search is official, but it is a **generic search surface**, not a dedicated Pine surface. That makes it a reasonable fallback/open-discovery route, but a less stable primary route than the Pine-specific documented operations above. Source: https://www.tradingview.com/support/shortcuts/

5. **Desktop vs browser**
   - TradingView maintains a dedicated desktop app; the repo’s live harness sensibly prefers desktop discovery/launch and only then falls back to browser (`scripts/live-tradingview-smoke.js:262-325`). Official desktop product page: https://www.tradingview.com/desktop/
   - For automation, that desktop-first preference is sensible because the repo’s focus lock, window-handle verification, watcher matching, and trusted process checks all work best when a single native TradingView window is discoverable (`src/main/ai-service.js:5379-5715`; `scripts/live-tradingview-smoke.js:193-325`).

### Section C: codebase vs best-practice gaps
- **Aligned:** the repo does **not** claim a fake direct `open-pine-editor` hotkey. That matches the official shortcuts page, which documents Pine-specific operations but not a single dedicated Pine Editor opener (`scripts/test-tradingview-shortcut-profile.js:131-145`; https://www.tradingview.com/support/shortcuts/).
- **Aligned:** the repo already models Pine as a bounded workflow with inspect-first/safe-authoring behavior instead of blindly typing into whatever editor happens to be visible. That is directionally consistent with the official Pine docs’ distinction between opening, creating, saving, and adding scripts to chart (`src/main/tradingview/pine-workflows.js:906-1076`; `scripts/test-windows-observation-flow.js:1848-1942`; https://www.tradingview.com/pine-script-docs/primer/first-indicator/).
- **Gap:** the generic `open-pine-editor` route is necessarily more brittle than the official Pine-specific routes. When the user really means “new indicator,” “new strategy,” or “open existing script,” the most deterministic documented surfaces are `Ctrl+K Ctrl+I`, `Ctrl+K Ctrl+S`, and `Ctrl+O`; the quick-search `Pine Editor` route is a generic search/result-activation flow layered on top of that (`src/main/tradingview/shortcut-profile.js:571-690`; https://www.tradingview.com/support/shortcuts/).
- **Gap:** the executor is intentionally fail-closed at the quick-search layer. `ensureTradingViewQuickSearchInputClearBeforeTyping()` and `verifyTradingViewQuickSearchTypedValue()` insist on proving emptiness/exact query, `getTradingViewQuickSearchEnterVerificationFailure()` blocks Enter if that proof is missing, and `shouldAllowTradingViewQuickSearchTypeFallback()` currently returns `false`. That is good safety, but it increases live brittleness whenever UIA/clipboard/watcher proof is slightly noisy (`src/main/tradingview/runtime/recovery.js:584-1036`; `src/main/ai-service.js:6143-6165`; `scripts/test-windows-observation-flow.js:3604-3610`).
- **Gap:** the exact live bottleneck is the **post-Enter handoff**, not the overall Pine workflow. After query proof succeeds and Enter is sent, the system still needs `verifyKeyObservationCheckpoint()` to see Pine activation; if it does not, recovery must win via passive probe, semantic result click, or keyboard selection before safe-authoring readback continues (`src/main/ai-service/observation-checkpoints.js:458-650`; `src/main/tradingview/runtime/recovery.js:1038-1338`; `scripts/test-windows-observation-flow.js:1492-1649`).
- **Gap:** Pine checkpoint deferral is narrow by design. `shouldDeferTradingViewPineEditorCheckpointFailure()` only defers when the next meaningful action is Pine `get_text`, which means inspect-first flows are favored, but other flows remain less forgiving (`src/main/ai-service.js:6167-6191`).
- **Aligned:** if Pine is already open, the repo has a strong short-circuit path and avoids unnecessary opener churn; this is a genuine reliability strength, not a gap (`src/main/ai-service.js:6397-6507`; `scripts/test-ai-service-pine-open-short-circuit.js:141-184`).
- **Gap:** browser fallback is useful for availability, but it is a worse validation surface for this specific bottleneck than desktop, because it adds more ambiguity in window kind/title/process trust and more opportunities for cross-app search-surface confusion (`scripts/live-tradingview-smoke.js:295-325`; `src/main/tradingview/runtime/recovery.js:1230-1338`).

### Section D: highest-leverage next steps
1. **Debug the opener as its own 4-step seam**: `ctrl+k -> type "Pine Editor" -> enter -> safe-authoring get_text`, on desktop only, before testing any later Pine authoring/edit/save/apply actions (`src/main/ai-service.js:7445-7920`; `scripts/test-windows-observation-flow.js:1492-1649`).
2. **Prefer official direct Pine routes whenever intent is specific**: use `Ctrl+K Ctrl+I`, `Ctrl+K Ctrl+S`, or `Ctrl+O` for “new indicator,” “new strategy,” or “open script” requests; reserve generic quick-search `Pine Editor` for ambiguous inspect/open cases (`https://www.tradingview.com/support/shortcuts/`; `src/main/tradingview/shortcut-profile.js:571-690`).
3. **Add a single regression fixture that mirrors the live symptom exactly**: query proven, Enter sent, Pine result visible, editor not yet active, semantic-click or keyboard-selection recovery required (`scripts/test-windows-observation-flow.js:1470-1649`; `src/main/tradingview/runtime/recovery.js:1230-1338`).
4. **Instrument failure-mode attribution around the opener**: log/count whether failure came from empty-state proof, typed-query mismatch, post-Enter checkpoint miss, already-open short-circuit, or recovery-path failure. The code already has the natural seams for that instrumentation (`src/main/tradingview/runtime/recovery.js:584-1036,1230-1338`; `src/main/ai-service.js:6147-6191,6260-6338`).
5. **Keep inspect-first safe authoring intact**: do not “fix” the opener by reintroducing blind overwrite or unconditional destructive editor-clearing. The current inspect-first design is one of the safer parts of the system (`src/main/tradingview/pine-workflows.js:906-1076`; `scripts/test-windows-observation-flow.js:1848-1942`).
6. **Treat desktop and browser runs as separate validation tracks**: fix and validate the Pine opener on desktop first, then separately evaluate browser fallback behavior (`scripts/live-tradingview-smoke.js:262-325`).

### Section E: terminal/execution hygiene recommendations
- **Use `--dry-run` first.** The live smoke harness already supports a non-executing plan printout; use that to confirm scenario composition before launching/typing into TradingView (`scripts/live-tradingview-smoke.js:816`).
- **Run one live TradingView scenario per terminal at a time.** The harness starts a polling watcher and does clean it up in `finally`, but overlapping smoke runs will still compete for foreground, window handles, and surface evidence (`scripts/live-tradingview-smoke.js:705-725,873,901-903`).
- **Prefer artifacts over scrollback.** Each scenario writes a `.summary.json`, exports a runtime `.jsonl` trace, and the run writes a manifest. For debugging this bottleneck, those files are higher-signal than raw terminal output (`scripts/live-tradingview-smoke.js:758,785,909`).
- **Do not touch keyboard/mouse during focus-sensitive runs.** The executor explicitly verifies foreground lock before key/type/click input and will fail or self-heal based on actual foreground state, so manual interference creates ambiguous evidence (`src/main/ai-service.js:5379-5715,7445-7505`).
- **Keep desktop and browser sessions separate in notes and artifacts.** The harness will fall back to browser if desktop discovery fails, but those are not equivalent automation surfaces for this bug (`scripts/live-tradingview-smoke.js:262-325`).
- **When using an agent/terminal for live validation, stop at bounded inspection first.** For this issue, the first clean success criterion is “Pine Editor surface verified and safe-authoring `get_text` completed,” not “full script authored/applied.” That keeps the run focused on the actual bottleneck (`src/main/ai-service.js:6260-6338,7865-7881`; `scripts/test-windows-observation-flow.js:1492-1649`).

### Sources examined
- `c:\dev\copilot-Liku-cli\src\main\tools\tradingview-tool.js`
- `c:\dev\copilot-Liku-cli\src\main\tradingview\app-profile.js`
- `c:\dev\copilot-Liku-cli\src\main\tradingview\shortcut-profile.js`
- `c:\dev\copilot-Liku-cli\src\main\tradingview\pine-workflows.js`
- `c:\dev\copilot-Liku-cli\src\main\tradingview\verification.js`
- `c:\dev\copilot-Liku-cli\src\main\tradingview\runtime\recovery.js`
- `c:\dev\copilot-Liku-cli\src\main\tradingview\rewrite-runner.js`
- `c:\dev\copilot-Liku-cli\src\main\tradingview\registry-bootstrap.js`
- `c:\dev\copilot-Liku-cli\src\main\ai-service.js`
- `c:\dev\copilot-Liku-cli\src\main\ai-service\observation-checkpoints.js`
- `c:\dev\copilot-Liku-cli\scripts\live-tradingview-smoke.js`
- `c:\dev\copilot-Liku-cli\scripts\test-tradingview-shortcut-profile.js`
- `c:\dev\copilot-Liku-cli\scripts\test-tradingview-pine-workflows.js`
- `c:\dev\copilot-Liku-cli\scripts\test-tradingview-pine-data-workflows.js`
- `c:\dev\copilot-Liku-cli\scripts\test-ai-service-pine-open-short-circuit.js`
- `c:\dev\copilot-Liku-cli\scripts\test-windows-observation-flow.js`
- Official TradingView shortcuts: https://www.tradingview.com/support/shortcuts/
- Official TradingView desktop page: https://www.tradingview.com/desktop/
- Official Pine docs:
  - https://www.tradingview.com/pine-script-docs/primer/first-steps/
  - https://www.tradingview.com/pine-script-docs/primer/first-indicator/
  - https://www.tradingview.com/pine-script-docs/welcome/
  - https://www.tradingview.com/pine-script-docs/writing/publishing/
