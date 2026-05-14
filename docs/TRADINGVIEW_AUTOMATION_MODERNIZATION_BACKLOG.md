# TradingView Automation Modernization Backlog

> Repo-specific implementation backlog derived from the May 2026 TradingView workflow optimization PDF and grounded in the current `main` branch.
>
> **Concrete implementation stance:**
> Preserve behavior at the API layer, modernize the execution layer.
>
> **Strategic direction:**
> Steer the project toward an industry-standard automation-driver architecture by evolving the existing Windows UIA host, preserving current facades/contracts, and prioritizing host unification plus watcher/focus parity before broader TradingView batching.

## Goal

Modernize TradingView automation so the runtime behaves like a persistent desktop automation driver instead of a collection of high-latency per-action PowerShell invocations, while preserving:

- existing public automation contracts in `src/main/system-automation.js`
- current AI-service proof/verification flows in `src/main/ai-service.js`
- current watcher state shape consumed by context builders
- existing TradingView safety rails, confirmation boundaries, and recovery behavior

## Current source of truth on `main`

### Existing host / automation seams that already exist
- `src/native/windows-uia-dotnet/Program.cs`
- `src/native/windows-uia-dotnet/WindowsUIA.csproj`
- `src/main/ui-automation/core/uia-host.js`
- `src/main/ui-watcher.js`
- `src/main/system-automation.js`
- `src/main/ai-service.js`
- `src/main/ai-service/observation-checkpoints.js`
- `src/main/tradingview/runtime/recovery.js`
- `src/main/tradingview/pine-workflows.js`

### Important repo-specific interpretation
- Do **not** implement the PDF literally if it points at stale paths such as `src/dotnet/AutomationHost/` or `src/main/automation-host-client.js`.
- Do **not** create a second competing automation daemon if the existing `WindowsUIA.exe` seam can be extended.
- Do **not** bypass `ai-service` verification/recovery logic to chase latency wins.
- Do **not** move to generic screenshot-only computer-use loops when Windows UIA semantics already exist and current TradingView safety logic depends on them.

## Scope

### In scope
- persistent host unification for UIA, window, focus, and clipboard operations
- watcher/event parity and foreground-lock hardening
- TradingView quick-search and Pine Editor read/write reliability
- bounded micro-batching after correctness improves
- rollout flags, parity harnesses, and live proof workflow

### Out of scope
- big-bang replacement of all legacy PowerShell paths
- removal of existing fallbacks before parity proof
- screenshot-only automation as the primary interaction layer
- batching across focus boundaries, confirmation boundaries, or high-risk actions
- weakening TradingView safety rails to make smoke tests pass faster

## Guardrails

1. **Preserve signatures and return shapes.**
   - `src/main/system-automation.js` remains the compatibility facade.
   - `src/main/ui-watcher.js` state shape remains stable for current consumers.

2. **Keep fallback behavior explicit.**
   - New host-backed paths must sit behind feature flags and preserve legacy fallbacks until proven.

3. **Use repo-style feature flags.**
   - Prefer `LIKU_*` environment variables, not generic `USE_*` names.

4. **Treat clipboard as bounded fallback infrastructure, not the primary state channel.**
   - Use semantic UIA / TextPattern / ValuePattern first whenever possible.

5. **Treat stale terminals and VS Code notifications as untrusted foregrounds.**
   - A foreground steal by Code/terminal surfaces should block or refocus; it should not silently continue a TradingView workflow.

6. **Batch only after correctness.**
   - Fast wrong actions are worse than slow safe actions.

7. **Keep generated artifacts out of commits.**
   - Live smoke artifacts, runtime traces, and hook artifacts remain uncommitted.

## Proposed rollout flags

These names are proposed to match existing repo conventions and should default to off until proof is recorded.

- `LIKU_USE_AUTOMATION_HOST=1`
  - routes supported low-level automation calls through the persistent host first
- `LIKU_USE_WATCHER_V2=1`
  - enables the event-first watcher path or adapter path once parity is proven
- `LIKU_USE_ACTION_BATCHING=1`
  - enables narrowly scoped same-surface compound actions
- `LIKU_USE_TRADINGVIEW_ELEMENT_MAP=1`
  - enables a TradingView-specific semantic element registry once it exists

## Backlog overview

| Tranche | Outcome | Primary targets | Exit gate |
| --- | --- | --- | --- |
| 0 | Baseline parity inventory and latency proof | `src/main/system-automation.js`, `src/main/ui-watcher.js`, `scripts/live-tradingview-smoke.js` | **Closed**: current costs, process pressure, and helper parity are measurable |
| 1 | Existing host becomes the real execution substrate for low-level ops | `src/native/windows-uia-dotnet/Program.cs`, `src/main/ui-automation/core/uia-host.js`, `src/main/system-automation.js` | **Closed**: host-backed window/focus/clipboard ops are flag-gated with legacy fallbacks |
| 2 | Watcher/focus parity becomes event-first and foreground-safe | `src/main/ui-watcher.js`, `src/main/ai-service.js`, `src/main/ai-service/observation-checkpoints.js` | **Closed**: watcher shape remains compatible and focus steals fail/refocus boundedly |
| 3 | TradingView quick-search and Pine flows become semantic-first and bounded | `src/main/tradingview/runtime/recovery.js`, `src/main/tradingview/pine-workflows.js`, `src/main/system-automation.js` | **Closed**: quick-search/Pine paths prefer semantic proof and bounded fallback |
| 4 | Same-surface sequencing reduces fragile round trips without hiding proof | `src/main/ai-service.js`, `src/main/system-automation.js`, host wrapper | **Closed**: conservative same-surface microflows preserve per-step proof metadata |
| 5 | Gradual rollout and cleanup | docs, flags, telemetry, fallback tracking | Host-backed path runs stably before any legacy removal |

---

## Tranche 0 — Baseline parity inventory and proof harness

### Objective
Build a measurement and parity baseline before changing execution plumbing.

### File-level targets
- `src/main/system-automation.js`
- `src/main/ui-watcher.js`
- `src/main/tradingview/runtime/recovery.js`
- `scripts/live-tradingview-smoke.js`
- new future tests/scripts under `scripts/`

### Tasks
- [x] Inventory every low-level function in `src/main/system-automation.js` that still spawns PowerShell.
- [x] Capture golden input/output pairs for:
  - `focusWindow(...)`
  - foreground window info
  - `pressKey(...)`
  - `typeText(...)`
  - click / double click / drag / scroll
  - any clipboard read/write helpers added during current recovery work
- [x] Add instrumentation for per-action latency and fallback counts.
- [x] Extend live smoke summaries to record:
  - foreground steals
  - clipboard touch count
  - recovery path chosen
  - time spent between visible action steps
- [x] Add a simple “PowerShell process pressure” baseline note to the docs.

### Suggested implementation files
- new: `scripts/test-system-automation-parity.js`
- new: `scripts/profile-tradingview-latency.js`
- update: `scripts/live-tradingview-smoke.js`

### Acceptance criteria
- We can compare legacy and host-backed implementations with the same inputs.
- Live smoke artifacts show where latency is actually being spent.
- The team can name the top 5 slowest automation steps with evidence.

### Current status

Tranche 0 is implemented and closed for the current helper surface.

Completed:
- static PowerShell inventory generation
- deterministic low-level helper parity fixtures
- live-smoke latency/fallback profiling
- structured failure bundles
- baseline documentation

Closure evidence:
- `scripts/test-system-automation-parity.js`
- `scripts/profile-tradingview-latency.js`
- `scripts/live-tradingview-smoke.js`
- `docs/TRANCHE0_POWERSHELL_PROCESS_PRESSURE_BASELINE.md`

### Why first
This prevents speculative optimization and gives us a safe way to prove that host migration preserves behavior.

---

## Tranche 1 — Evolve the existing UIA host into the primary automation driver

### Objective
Use the existing `WindowsUIA.exe` seam as the single long-lived automation driver instead of creating a second competing host.

### File-level targets
- `src/native/windows-uia-dotnet/Program.cs`
- `src/native/windows-uia-dotnet/WindowsUIA.csproj`
- `src/main/ui-automation/core/uia-host.js`
- `src/main/system-automation.js`

### Tasks
- [x] Extend the host with **window operations**:
  - foreground window info
  - window enumeration / resolve helpers
  - reliable focus/bring-to-front behavior
- [x] Extend the host with **clipboard operations**:
  - `getText`
  - `setText`
  - `save`
  - `restore`
  - optional monitor/wait support
- [x] Introduce request correlation IDs and queued request handling in `uia-host.js`.
- [x] Replace fragile single pending-request behavior with correlated queued dispatch in the Node wrapper without weakening error reporting.
- [x] Route selected `system-automation.js` calls through the host under `LIKU_USE_AUTOMATION_HOST=1`.
- [x] Preserve current legacy PowerShell paths in explicit fallback helpers.

### Current status

Tranche 1 is implemented and closed. The source-of-truth host seam now supports foreground/window inspection, focus/restore, process lookup, clipboard text/state operations, request IDs, queued dispatch, and event messages. `src/main/system-automation.js` routes selected calls through the host only when `LIKU_USE_AUTOMATION_HOST=1`, and retains legacy PowerShell fallbacks when the flag is disabled or the host path cannot satisfy the call.

Closure evidence:
- `src/native/windows-uia-dotnet/Program.cs`
- `src/main/ui-automation/core/uia-host.js`
- `src/main/system-automation.js`
- `scripts/test-system-automation-host-bridge.js`
- `scripts/test-uia-host-request-queue.js`
- `scripts/test-host-native-clipboard-state.js`

### Important repo-specific notes
- Keep `src/main/system-automation.js` as the public facade.
- Do **not** rename the current host seam until rollout proves parity.
- Preserve current TradingView-specific input behavior, especially shortcut routing that already distinguishes SendInput vs SendKeys paths.

### Immediate priorities inside this tranche
1. Host-backed clipboard save/restore
2. Host-backed foreground / focus queries
3. Host-backed window focus parity
4. Only then consider host-backed input primitives

### Acceptance criteria
- Host-backed window/focus operations produce the same result shape as legacy calls.
- Clipboard operations can preserve mixed clipboard state across TradingView workflows.
- Recovery code in `src/main/tradingview/runtime/recovery.js` can stop falling back to PowerShell clipboard scripts when the host path is enabled.
- With `LIKU_USE_AUTOMATION_HOST=0`, behavior remains unchanged.

### Validation proof
- `node scripts/test-ai-service-contract.js`
- `node scripts/test-windows-observation-flow.js`
- `node scripts/test-tradingview-runtime-recovery.js`
- `npm run smoke:tradingview-live -- --scenarios focus,pine-editor`

---

## Tranche 2 — Watcher parity and focus-lock hardening

### Objective
Make the watcher and focus verification event-first, faster, and safer against foreground steals.

### File-level targets
- `src/main/ui-watcher.js`
- optional new: `src/main/ui-watcher-adapter.js`
- `src/main/ai-service.js`
- `src/main/ai-service/observation-checkpoints.js`
- `src/native/windows-uia-dotnet/Program.cs`

### Tasks
- [x] Expand host event payloads so they can support current watcher consumers more faithfully.
- [x] Preserve active-window fields used by AI context and verification:
  - `processName`
  - `ownerHwnd`
  - `isTopmost`
  - `isToolWindow`
  - `isMinimized`
  - `isMaximized`
  - `windowKind`
- [x] Shift watcher behavior to **event-first + heartbeat fallback** instead of heavy poll-first logic.
- [x] Add explicit classification for foreground steals caused by:
  - VS Code terminal notifications
  - stale background terminal exits
  - non-TradingView popups
- [x] Tighten focus-lock rules so untrusted foregrounds block TradingView input/readback instead of encouraging loops.
- [x] Keep the watcher in place; no adapter layer was needed for the current parity surface.

### Current status

Tranche 2 is implemented and closed. `src/main/ui-watcher.js` keeps the existing consumer shape while exposing richer active-window topology, event freshness, and heartbeat fallback behavior. `src/main/ai-service.js` and `src/main/ai-service/observation-checkpoints.js` now use watcher freshness and foreground proof to refocus or fail closed before keyboard input/readback can route to VS Code, stale terminals, or non-TradingView foregrounds.

Closure evidence:
- `src/main/ui-watcher.js`
- `src/main/ai-service.js`
- `src/main/ai-service/observation-checkpoints.js`
- `scripts/test-windows-observation-flow.js`
- `scripts/test-observation-checkpoint-host-proof.js`
- `scripts/test-live-tradingview-smoke-window-selection.js`

### Acceptance criteria
- Watcher consumers continue to receive the same shape they expect.
- Event mode reduces blind polling pressure without making state staler.
- TradingView workflows detect VS Code/terminal focus steals quickly and refocus or fail boundedly.
- Verification loops stop burning time on foreground states that are clearly not trusted.

### Validation proof
- `node scripts/test-windows-observation-flow.js`
- `node scripts/test-live-tradingview-smoke-window-selection.js`
- runtime-trace review from live smoke artifacts

---

## Tranche 3 — TradingView semantic-first recovery, readback, and write paths

### Objective
Fix the current user-visible pain points in TradingView without weakening existing safety rails.

### File-level targets
- `src/main/tradingview/runtime/recovery.js`
- `src/main/tradingview/pine-workflows.js`
- `src/main/system-automation.js`
- `src/main/ai-service/observation-checkpoints.js`
- optional new: `src/main/tradingview/element-map.js`

### Tasks
- [x] Convert quick-search handling to a semantic-first path:
  - semantic focus/input if available
  - bounded clipboard fallback only when semantic input is unavailable
- [x] Make Pine readback **TextPattern-first** and clipboard fallback second.
- [x] Make Pine write/update paths explicit and bounded:
  - semantic set/focus when available
  - clipboard save/restore-backed paste fallback when necessary
  - immediate bounded readback/verification after write
- [x] Capture high-value TradingView surfaces in the existing TradingView registries/contracts:
  - quick-search input
  - Pine editor anchors
  - Pine logs/profiler/version history anchors
  - symbol/timeframe surfaces
- [x] Reduce “wait then sample again” loops where semantic event-backed confirmation is possible.
- [x] Prevent stale terminal notifications from being mistaken for valid readback surfaces.

### Current status

Tranche 3 is implemented and closed. Quick-search text replacement now prefers host/UIA `ValuePattern` write plus readback before falling back to keyboard typing. Pine Editor readback and authoring paths are bounded by foreground/surface proof, TextPattern/ValuePattern reads, clipboard save/restore fallbacks, and immediate lifecycle/readback verification. The high-value TradingView surfaces are represented through the existing tool facade, shortcut profile, verification, system contract, and observation-provider registries instead of a new competing element-map file.

Closure evidence:
- `src/main/system-automation.js`
- `src/main/tradingview/runtime/recovery.js`
- `src/main/tradingview/pine-workflows.js`
- `src/main/tools/tradingview-tool.js`
- `scripts/test-system-automation-quick-search.js`
- `scripts/test-tradingview-pine-workflows.js`
- `scripts/test-tradingview-pine-data-workflows.js`
- `scripts/test-tradingview-runtime-recovery.js`

### Pain points this tranche must directly address
- text not landing reliably in the TradingView quick-search input
- Pine Editor paste/write not being atomic or trustworthy enough
- minutes-long delays between visible actions
- TradingView lockup while the runtime loops trying to re-verify state
- stale terminals or notifications stealing focus and poisoning readback

### Acceptance criteria
- Live Pine opener/readback no longer depends on repeated clipboard sentinel loops as the primary path.
- Pine readback succeeds semantically when the editor is visible and only falls back to clipboard when necessary.
- Search-input replace flows are bounded and measurably faster.
- The runtime fails or refocuses quickly when Code/terminal steals foreground, instead of spiraling through long verification loops.

### Validation proof
- `node scripts/test-tradingview-pine-workflows.js`
- `node scripts/test-tradingview-pine-data-workflows.js`
- `node scripts/test-tradingview-runtime-recovery.js`
- `node scripts/test-windows-observation-flow.js`
- `npm run smoke:tradingview-live -- --scenarios focus,pine-editor`

---

## Tranche 4 — Narrow action batching and sequencer support

### Objective
Reduce fragile round trips only after correctness and state trust improve. The landed scope is intentionally conservative: keep sequencing inside the existing action executor and host wrapper, collapse only same-surface microflows where semantic proof is available, and preserve per-step metadata instead of introducing a broad batch daemon.

### File-level targets
- `src/main/ui-automation/core/uia-host.js`
- `src/native/windows-uia-dotnet/Program.cs`
- optional new: `src/main/automation-sequencer.js`
- `src/main/system-automation.js`
- `src/main/tradingview/runtime/recovery.js`

### Tasks
- [x] Add support for narrowly scoped same-surface microflows:
  - focus/readiness preflight through focus-lock and active-input guards
  - quick-search replacement through semantic `setValue` plus `getText` readback
  - Pine readback preparation through bounded TextPattern/ValuePattern and fallback lanes
  - semantic Pine click proof through post-invoke surface verification
- [x] Preserve per-step proof metadata even when a microflow uses a collapsed semantic host path.
- [x] Restrict collapsed behavior to same-surface microflows.
- [x] Do **not** batch across:
  - focus boundary changes
  - confirmation boundaries
  - high-risk actions
  - uncertain foreground states
- [x] Keep legacy and non-batched paths available as fallback.

### Current status

Tranche 4 is implemented and closed for the safe current scope. The repo does **not** add a second automation sequencer daemon or a broad host-side action batcher. Instead, `src/main/ai-service.js` preserves intelligible action/checkpoint proof, `src/main/system-automation.js` collapses trusted same-surface semantic operations where safe, and risky/focus-changing/high-uncertainty paths remain explicit non-batched steps with fallback behavior.

### Acceptance criteria
- Same-surface microflows require fewer fragile keyboard/process round trips where semantic host proof exists.
- Error reporting still identifies which sub-step failed.
- Existing AI-service proof and checkpoint metadata remain intelligible.

### Validation proof
- `scripts/test-system-automation-quick-search.js`
- `scripts/test-windows-observation-flow.js`
- `scripts/test-observation-checkpoint-host-proof.js`
- `scripts/test-decision-trace.js`
- live smoke timing comparisons from `scripts/live-tradingview-smoke.js` manifests

---

## Tranche 5 — Controlled rollout, telemetry, and cleanup

### Objective
Enable the modernized path gradually and remove legacy only after stable proof.

### File-level targets
- docs and runbooks in `docs/`
- feature flag handling in runtime/config seams
- telemetry and runtime trace summaries

### Tasks
- [ ] Record fallback-trigger counts for every host-backed action family.
- [ ] Roll out by capability, not by subsystem all at once.
- [ ] Keep legacy paths until the host-backed path has stable live evidence.
- [ ] Update validation docs and smoke runbooks as each tranche lands.
- [ ] Archive old seams only after sustained success, not after first green run.

### Acceptance criteria
- Flags can be toggled independently.
- Live smoke and focused regressions stay green across both legacy and host-backed modes.
- Fallbacks become rare enough to justify pruning only after extended proof.

---

## Suggested first three implementation slices

These implementation slices have landed as part of Tranches 1-3; Tranche 5 owns controlled rollout and cleanup.

### Slice A — Host-backed clipboard safety and foreground APIs
**Files:**
- `src/native/windows-uia-dotnet/Program.cs`
- `src/main/ui-automation/core/uia-host.js`
- `src/main/system-automation.js`
- `src/main/tradingview/runtime/recovery.js`

**Outcome:**
- clipboard save/restore and foreground/focus queries move off PowerShell first

### Slice B — Foreground-steal classification and watcher parity hardening
**Files:**
- `src/main/ui-watcher.js`
- `src/main/ai-service.js`
- `src/main/ai-service/observation-checkpoints.js`

**Outcome:**
- Code/terminal notifications stop poisoning TradingView loops and readbacks

### Slice C — Pine semantic readback/write modernization
**Files:**
- `src/main/system-automation.js`
- `src/main/tradingview/runtime/recovery.js`
- `src/main/tradingview/pine-workflows.js`

**Outcome:**
- Pine and quick-search flows become semantic-first and bounded, with clipboard fallback preserved safely

## Do-not-regress checklist

Before enabling any tranche by default, re-verify:

- [ ] `system-automation.js` exports and return shapes remain compatible
- [ ] watcher state shape stays compatible with current AI context consumers
- [ ] TradingView focus/safety boundaries remain explicit
- [ ] clipboard contents are restored after any fallback path
- [ ] stale terminals and VS Code notifications are rejected as trusted TradingView foregrounds
- [ ] runtime trace artifacts still explain why a workflow passed, recovered, or failed
- [ ] live smoke artifacts under `artifacts/live-validation/` still tell the story of the scenario clearly

Current closure note: Tranches 0-4 are complete, but they remain intentionally guarded. Tranche 5 is where fallback-trigger trending, default-on rollout decisions, and any legacy pruning should happen.

## Suggested validation cadence per slice

1. Focused deterministic tests first
   - `node scripts/test-tradingview-runtime-recovery.js`
   - `node scripts/test-windows-observation-flow.js`
2. Related focused module tests
   - `node scripts/test-tradingview-pine-workflows.js`
   - `node scripts/test-tradingview-pine-data-workflows.js`
   - `node scripts/test-live-tradingview-smoke-window-selection.js`
3. Then live proof only when runtime behavior changes
   - `npm run smoke:tradingview-live -- --scenarios focus,pine-editor`

## Recommendation in one sentence

Modernize this repo by converging its existing host, watcher, and TradingView verification seams into a persistent automation-driver architecture, not by replacing them with a generic computer-use loop or by weakening the current safety/proof model.
