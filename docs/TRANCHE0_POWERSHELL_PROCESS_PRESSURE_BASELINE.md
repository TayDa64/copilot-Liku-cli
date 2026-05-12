# Tranche 0 PowerShell Process Pressure Baseline

This note captures the baseline tooling added for **Tranche 0** in the TradingView automation modernization backlog.

## Current status

Implemented in the repo today:
- `scripts/test-system-automation-parity.js` inventories PowerShell-backed `system-automation` helpers, replays deterministic low-level helper fixtures, and writes both `artifacts/tranche0/system-automation-powershell-inventory.json` and `artifacts/tranche0/system-automation-low-level-parity-report.json`.
- `scripts/profile-tradingview-latency.js` summarizes live-smoke manifests into the slowest action gaps, slowest automation methods, clipboard touches, quick-search timeout counts, and off-app foreground transitions.
- `scripts/live-tradingview-smoke.js` records per-scenario latency/fallback telemetry and writes structured `*.summary.json` plus run `*.manifest.json` artifacts.
- failure bundles are emitted through `scripts/lib/failure-artifacts.js` for focused tests and live scenarios.
- deterministic golden parity fixtures now cover `focusWindow(...)`, foreground/window info, clipboard read/write, `pressKey(...)`, `typeText(...)`, click, double click, drag, and scroll helper contracts.

Tranche 0 is now closed for the current low-level helper surface. Future helper additions should extend the same fixture harness instead of reopening ad hoc parity questions.

## Why this exists

Before replacing legacy PowerShell-heavy automation paths, we need evidence for:
- which `system-automation` helpers still spawn PowerShell,
- where latency accumulates during live TradingView runs,
- and what failure context was present when a bounded live run failed.

## New baseline tools

### 1. System automation PowerShell inventory
Lists `src/main/system-automation.js` functions that still call `executePowerShell(...)` or `executePowerShellScript(...)`, then replays deterministic low-level helper fixtures against mocked host/PowerShell paths.

Run:

```bash
node scripts/test-system-automation-parity.js
```

Artifact:
- `artifacts/tranche0/system-automation-powershell-inventory.json`
- `artifacts/tranche0/system-automation-low-level-parity-report.json`

Note:
- `artifacts/tranche0/` is generated evidence and is kept out of commits by `.gitignore`.

### 2. Live TradingView latency profile
Reads a live-smoke manifest and prints the slowest action gaps, slowest automation methods, quick-search timeout counts, clipboard touches, and foreground-transition signals.

Run the latest manifest automatically:

```bash
node scripts/profile-tradingview-latency.js
```

Or target a specific manifest:

```bash
node scripts/profile-tradingview-latency.js --manifest artifacts/live-validation/<runTag>-tradingview-live-smoke.manifest.json
```

## Live smoke artifacts now include

`node scripts/live-tradingview-smoke.js` now records, per scenario:
- action timing gaps between visible steps,
- profiled `systemAutomation` call counts and latency,
- foreground sampling / off-app transition telemetry,
- clipboard touch count,
- quick-search preflight timeout and fallback counts,
- and a structured failure bundle when the scenario fails.

## Failure bundles

Focused TradingView tests and the live smoke harness now write failure bundles under `artifacts/test-failures/` or the live validation artifact directory. These bundles include:
- the thrown error,
- runtime trace summary and exported trace path,
- a tail excerpt of the runtime JSONL,
- watcher capability snapshot when available,
- foreground window snapshot when available,
- and the scenario/test-specific extra context passed by the harness.

## Current pressure hotspots to watch

The inventory and live latency profile should be used to validate these known pressure points:
- process enumeration (`getRunningProcessesByNames(...)`),
- semantic search probes (`findElementByText(...)`),
- foreground / window discovery,
- clipboard reads/writes used by bounded quick-search fallback,
- and SendKeys-based keyboard/text helpers when no semantic path is available.
