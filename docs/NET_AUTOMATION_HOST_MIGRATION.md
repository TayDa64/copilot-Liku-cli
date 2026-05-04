# Epic: TradingView Workflow Optimization & .NET Automation Host Migration

## Motivation
To resolve persistent focus deadlocks, sparse UI automation failures, and clipboard-clobbering regressions, we are undertaking a drastic but safe architectural migration. We will replace the current state of spawning hundreds of `powershell.exe` processes per minute with a single, persistent, high-performance **.NET 8 Native AOT Automation Host** communicating over JSON-RPC (via `stdio`).

**CRITICAL CONSTRAINT:** All migrations must use a "parallel path" approach. Native implementations must execute side-by-side with the legacy PowerShell functions mapped as fallbacks behind feature flags (`USE_NATIVE_HOST` and `USE_WATCHER_V2`). Pre-existing functionalities must not be lost.

---

## Phase 0 — Foundation & Scaffolding (Week 1)
- [x] **Task 0.1: Create .NET Automation Host Project [P0]** - `src/dotnet/AutomationHost/` created with `net8.0`, win-x64, self-contained Native AOT publish settings.
- [x] **Task 0.2: Implement JSON-RPC Server Skeleton [P0]** - `Rpc/RpcServer.cs` + `AutomationRpcService.cs` added with `ping`, `shutdown`, `invoke`, `invokeBatch`, and host lifecycle notifications.
- [x] **Task 0.3: Implement Node.js Host Client [P0]** - `src/main/automation-host-client.js` added with singleton access, stdio JSON-RPC framing, notifications, explicit host-path override, and local artifact resolution.
- [x] **Task 0.4: Create Feature Flag Infrastructure [P0]** - `USE_NATIVE_HOST` / `LIKU_USE_NATIVE_HOST` flag parsing added and surfaced via `system-automation.js` without changing legacy behavior.
- [ ] **Task 0.5: Create Migration Test Harness [P1]** - `src/test/automation-parity-tests.js` to capture input/outputs from old PS scripts and replay against .NET host to assert byte-for-byte parity.

### Phase 0 Validation Snapshot
- ✅ `dotnet build src/dotnet/AutomationHost/AutomationHost.csproj` succeeds.
- ✅ `node scripts/test-automation-host-client.js` succeeds against the managed host build (`dotnet AutomationHost.dll`).
- ✅ `dotnet publish -c Release -r win-x64 --self-contained true -p:PublishAot=true` succeeds after removing the incompatible `PublishSingleFile` setting.
- ✅ `node scripts/test-automation-host-client.js` succeeds against the published Native AOT executable (`bin/automation-host-publish-test/AutomationHost.exe`).
- ✅ The original `StreamJsonRpc` transport was replaced with an AOT-safe manual stdio JSON-RPC implementation; the prior `IL2026` / `IL3050` deployment blocker is removed.
- ✅ Published executable size observed during validation: `AutomationHost.exe` ≈ `3.1 MB`.

## Phase 1 — Persistent .NET Host Core Modules (Weeks 2–3)
- [ ] **Task 1.1: Implement InputModule in .NET Host [P0]** - P/Invoke for `SendInput`, `SetCursorPos`, etc. EXACT key mapping parity with `system-automation.js`.
- [ ] **Task 1.2: Implement WindowModule in .NET Host [P0]** - P/Invoke win32 windowing functions. Return shape for `window.getActive()` MUST match old `getActiveWindow()`.
- [ ] **Task 1.3: Implement UIAModule in .NET Host [P0]** - COM-based UIA. `uia.getSubtree` MUST produce exact shape as `detectElements()` in `ui-watcher.js`.
- [ ] **Task 1.4: Implement ClipboardModule in .NET Host [P0]** - New safety mechanism: OLE clipboard `save()` and `restore()` to prevent clobbering.
- [ ] **Task 1.5: Implement BatchHandler in .NET Host [P1]** - Accept batched actions internally to eliminate IPC round-trips.
- [ ] **Task 1.6: Wire Input Functions to Host Client [P0]** - Update `system-automation.js`. Rename old to `_legacyPowerShell*`. Wrap new calls in try/catch to legacy.
- [ ] **Task 1.7: Wire Window Functions to Host Client [P0]** - Parallel path for window APIs.
- [ ] **Task 1.8: Wire UIA Functions to Host Client [P0]** - Parallel path for UIA element detection.
- [ ] **Task 1.9: Phase 1 Verification Checkpoint [P0]** - Pass parity test suite, zero regressions.

## Phase 2 — Action Batching & Compound Actions (Week 4)
- [ ] **Task 2.1: Implement Compound Actions in .NET Host [P1]** - Bake sequential steps (`clickElement`, `typeIntoElement`, atomic `getWindowState`) down into C# to skip IPC overhead.
- [ ] **Task 2.2: Integrate Batch Calls into Workflows [P1]** - Update `pine-workflows.js`, `navigation.js` to use `invokeBatch()`.
- [ ] **Task 2.3: Add Batch-Aware Action Sequencer [P2]** - `src/main/action-sequencer.js` for fluent generation of optimal batch groupings.

## Phase 3 — Watcher Architecture Overhaul (Week 5)
- [ ] **Task 3.1: Implement UIA Event Subscriptions in .NET Host [P0]** - Hook `SetWinEventHook` (focus/structure changes) pushes via JSON-RPC.
- [ ] **Task 3.2: Create WatcherV2 Module [P0]** - `src/main/ui-watcher-v2.js`. Primary mode: event-driven via .NET. Secondary: heartbeat polling via atomic `getWindowState()`.
- [ ] **Task 3.3: Create Watcher Adapter Layer [P1]** - `src/main/ui-watcher-adapter.js` routes identically shaped output to either v1 or v2 depending on config.
- [ ] **Task 3.4: Migrate Consumers to Adapter [P1]** - Zero logic changes to consumers, just import from adapter.
- [ ] **Task 3.5: Phase 3 Verification Checkpoint [P0]** - Test TradingView workflows with event-driven WatcherV2. Expect 90% CPU overhead reduction.

## Phase 4 — TradingView-Specific Optimizations (Weeks 6–7)
- [ ] **Task 4.1: Implement TradingView Element Map [P1]** - `element-map.js` static UIA ID registry. 
- [ ] **Task 4.2: Optimize Pine Editor Text Extraction [P1]** - Use UIA `TextPattern` inside .NET; fallback to safe `clipboard.save() -> copy -> restore()`.
- [ ] **Task 4.3: Optimize Pine Editor Summary Builders [P1]** - Ensure single `getWindowState()` batches entire summaries under 100ms.
- [ ] **Task 4.4: Implement Event-Driven Action Verification [P1]** - `action-verifier.js` subscribes to UIA events to confirm action success instead of sleeping/polling.
- [ ] **Task 4.5–4.7: Optimize Specific Workflows [P2]** - Refactor navigation, alerts, indicators, and drawings to use compound actions.

## Phase 5 — Cleanup & Hardening (Week 8)
- [ ] **Task 5.1: Retire PowerShell Code Paths [P1]** - Remove `_legacyPowerShell*` functions after extended production verification.
- [ ] **Task 5.2: Performance Benchmarking Suite [P1]** - Automated tests ensuring <10ms single action latency and <20ms poll cycle checks.
- [ ] **Task 5.3: Error Recovery Hardening [P0]** - robust reconnects, crash recovery, graceful unhandled exceptions.
- [ ] **Task 5.4: Documentation Update [P2]** - Update `ARCHITECTURE.md` and add `MIGRATION-GUIDE.md`.

---
**Implementation Strategy for Cloud Agent:**
- Strictly execute tasks sequentially.
- DO NOT break legacy integration. All `USE_NATIVE_HOST` usages must gracefully fallback to pre-existing code.
- Begin with **`Task 0.1`** (Scaffolding the Extracted AutomationHost project).