# GitHub Copilot CLI: Liku Edition

[![npm version](https://img.shields.io/npm/v/copilot-liku-cli.svg)](https://www.npmjs.com/package/copilot-liku-cli)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE.md)

GitHub Copilot CLI: Liku Edition is a terminal-first AI assistant with optional Electron-based visual awareness, Windows UI automation, live UI observation, memory, skill routing, and multi-agent orchestration.

It can run in two main modes:

- **Headless terminal mode** via `liku chat`
- **Visual Electron mode** via `liku start` or bare `liku`

The visual overlay depends on Electron, which is installed as an optional dependency. The headless CLI surface remains usable even when the Electron visual runtime is unavailable.

This repo currently emphasizes:

- reliable desktop/browser automation
- bounded safety checks before execution
- strong Windows support through native UI Automation
- persistent memory/skills under the Liku home directory
- advisory-safe TradingView support, including fail-closed live/unknown trading mode, explicit Paper Trading confirmation, and blocked position-management actions

See also:

- [ARCHITECTURE.md](ARCHITECTURE.md)
- [QUICKSTART.md](QUICKSTART.md)
- [INSTALLATION.md](INSTALLATION.md)
- [docs/AGENT_ORCHESTRATION.md](docs/AGENT_ORCHESTRATION.md)

---

## What Liku adds

Compared with a plain chat CLI, Liku adds:

- **Headless command surface** for automation and diagnostics
- **Optional visual overlay** for grid targeting and inspect workflows
- **UI watcher** for active-window and accessibility-grounded context
- **Visual context capture** from screenshots
- **Memory + skills** persisted under `~/.liku/`
- **Dynamic tool registry** with sandboxing and approval flow
- **Reflection + telemetry** for failure-aware improvement loops
- **Multi-agent orchestration** with supervisor / researcher / architect / builder / verifier / diagnostician / vision operator roles

---

## Current status

### Stable core surfaces

- `liku` command dispatcher in `src/cli/liku.js`
- terminal chat via `liku chat`
- Electron app entry via `liku start`
- Windows UI Automation integration
- screenshot capture and visual verification helpers
- focused AI-service regression suites

### Current safety posture

Liku is designed to fail closed when confidence or safety is insufficient.

Examples already enforced in code:

- high-risk and critical actions trigger confirmation flows
- fragile TradingView key flows require post-key observation checkpoints
- screenshot-only continuation loops are prevented in terminal chat
- TradingView **live/unknown DOM / Depth of Market** order-entry and all position-management actions are **blocked by advisory-only rails** rather than executed
- high-confidence TradingView **Paper Trading** DOM order-entry requires explicit confirmation before execution can resume

---

## Installation

### Requirements

- Node.js **18+**
- npm **9+**
- Windows, macOS, or Linux

### Platform support

| Platform | Support level | Notes |
| --- | --- | --- |
| Windows | Best supported | Native UI Automation, event-driven watcher, .NET UIA host |
| macOS | Partial | Accessibility permissions required |
| Linux | Partial | AT-SPI2 recommended |

### Global install

```bash
npm install -g copilot-liku-cli
```

Verify:

```bash
liku --version
liku --help
```

If you only need terminal-first chat and headless automation, this is enough to get started.

### From source

```bash
git clone https://github.com/TayDa64/copilot-Liku-cli
cd copilot-Liku-cli
npm install
npm link
```

Start:

```bash
liku start
# or
npm start
```

### Windows UIA host

On Windows, `npm install` runs a postinstall step that attempts to build the .NET UIA host if the **.NET 9+ SDK** is available.

You can also build it manually:

```bash
npm run build:uia
```

If .NET 9 is not available, install still succeeds, but the richer Windows UI-automation path is not built automatically.

---

## Quick start

### Headless terminal chat

```bash
liku chat
```

This is the most practical day-to-day workflow if you want terminal-first AI interaction without opening the Electron UI.

Useful invocation options:

- `liku chat --model <copilotModelKey>`
- `liku chat --execute prompt|true|false`

Useful chat commands:

- `/help`
- `/login`
- `/model`
- `/provider`
- `/status`
- `/capture`
- `/vision on|off`
- `/memory`
- `/skills`
- `/tools`
- `/rmodel`
- `/state`
- `/clear`

Terminal-chat-specific controls:

- `/sequence on|off`
- `/recipes on|off`
- `(plan) ...` for plan-only orchestration routing

### Visual Electron mode

```bash
liku start
```

or simply:

```bash
liku
```

This launches the Electron runtime with overlay support.

### First validation steps

```bash
liku doctor
npm run smoke:shortcuts
npm run smoke:chat-direct
npm run test:ui
```

If you want the most relevant current regression bundle for AI/service behavior:

```bash
npm run test:ai-focused
```

---

## CLI commands

The top-level CLI currently exposes these commands through `src/cli/liku.js`.

| Command | Description |
| --- | --- |
| `start` | Start the Electron agent with overlay |
| `doctor` | Diagnostics: version, environment, active window |
| `chat` | Interactive AI chat in the terminal |
| `click` | Click element by text or coordinates |
| `find` | Find UI elements matching criteria |
| `type` | Type text at the current cursor position |
| `keys` | Send keyboard shortcut combinations |
| `screenshot` | Capture a screenshot |
| `verify-hash` | Poll until screenshot hash changes |
| `verify-stable` | Wait until visual output is stable |
| `window` | Focus or list windows |
| `mouse` | Move mouse to coordinates |
| `drag` | Drag between points |
| `scroll` | Scroll up or down |
| `wait` | Wait for element appearance/disappearance |
| `repl` | Interactive automation shell |
| `memory` | Inspect/manage memory notes |
| `skills` | Inspect/manage skill library |
| `tools` | Inspect/manage dynamic tool registry |
| `analytics` | View telemetry analytics |

Examples:

```bash
liku doctor --json
liku chat --model gpt-4.1
liku click "Submit"
liku find "Save" --type Button
liku keys ctrl+shift+s
liku screenshot --memory --hash --json
liku verify-stable --metric dhash --stable-ms 800 --timeout 15000 --interval 250 --json
liku window "Visual Studio Code"
```

---

## Visual awareness and automation model

Liku uses multiple observation/control surfaces depending on what is available:

- **Windows UI Automation** when semantic controls are discoverable
- **active-window and watcher context** when semantic controls are limited
- **screenshot capture** when visual grounding is needed
- **grid/overlay workflows** in Electron mode

### Overlay shortcuts

Source of truth for these mappings is the current Electron main-process registration in `src/main/index.js`.

| Shortcut | Action |
| --- | --- |
| `Ctrl+Alt+Space` | Toggle chat window |
| `Ctrl+Shift+O` | Toggle overlay visibility |
| `Ctrl+Alt+I` | Toggle inspect mode |
| `Ctrl+Alt+F` | Toggle fine grid |
| `Ctrl+Alt+G` | Show all grid levels |
| `Ctrl+Alt+=` | Zoom in |
| `Ctrl+Alt+-` | Zoom out |
| `Ctrl+Alt+X` | Cancel current selection |

---

## TradingView support

TradingView support is a **professional advisory / observation** workflow, not a broker-execution workflow. The current implementation is modularized behind tool registries and provider hooks so TradingView-specific behavior does not live directly in generic execution loops.

### Current grounded surfaces

The runtime now carries TradingView-specific grounding for:

- chart/timeframe surfaces
- alert dialogs
- drawing tools
- indicators / studies
- Pine Editor
- DOM / Depth of Market metadata

### Current modular surfaces

`src/main/tools/tradingview-tool.js` is the canonical TradingView facade. It registers:

- ordered TradingView rewrite handlers through the tool rewrite registry
- TradingView risk assessment through the tool risk registry
- Pine authoring system contracts through the system-contract provider registry
- TradingView observation/checkpoint helpers through the observation-provider registry
- Pine resume lifecycle decisions through the lifecycle-hook registry

Tool rewrite/risk registries are default-on. Temporary compatibility escape hatches remain available with `LIKU_USE_TOOL_REGISTRY_REWRITES=0` and `LIKU_USE_TOOL_REGISTRY_RISKS=0`.

### Current safety boundary

Liku can reason about TradingView UI state, but it must remain advisory-safe.

Specifically:

- TradingView live or unknown-mode DOM order-entry actions are blocked fail-closed
- high-confidence Paper Trading DOM order-entry is high-risk, requires explicit confirmation, and resumes only through the confirmation flow
- TradingView DOM flatten / reverse / cancel-all style controls are classified as critical
- TradingView position-management actions are **blocked before execution** by advisory-only safety rails

This means Liku can help observe, explain, and guide. It must not place live/unknown-mode orders or manage positions, and Paper Trading order-entry remains gated by explicit confirmation.

### Pine Editor grounding

When a TradingView chart has established focus, `Ctrl+E` is treated as the grounded shortcut for opening Pine Script Editor. When chart focus is not established, Liku falls back to the verified quick-search route instead of assuming the shortcut will land in TradingView.

---

## Chat and agent architecture

### Shared slash commands

Handled through `ai-service.handleCommand()`:

- `/help`
- `/login` / `/logout`
- `/model [key]`
- `/provider [name]`
- `/setkey <provider> <key>`
- `/status`
- `/state [clear]`
- `/clear`
- `/vision [on|off]`
- `/capture`
- `/memory [search <query>|clear]`
- `/skills`
- `/tools [approve|revoke <name>]`
- `/rmodel [model|off]`

### Electron-only orchestration commands

Handled in `src/main/index.js`:

- `/agentic` or `/agent`
- `/orchestrate <task>`
- `/research <query>`
- `/build <spec>`
- `/verify <target>`
- `/agents` or `/agent-status`
- `/agent-reset`
- experimental `/produce <prompt>` path

### Multi-agent roles

- Supervisor
- Researcher
- Architect
- Builder
- Verifier
- Diagnostician
- Vision Operator

Hook-based enforcement lives under `.github/hooks/` and is used to enforce role boundaries, audit tool calls, and validate subagent outputs.

---

## Cognitive layer

The cognitive layer persists state under **`~/.liku/`**.

Primary directories:

```text
~/.liku/
├── memory/
├── skills/
├── tools/
├── telemetry/
└── preferences.json
```

Important note:

- the project still contains migration support from legacy `~/.liku-cli/`
- Electron session data still uses `~/.liku-cli/session/` to avoid Chromium lock issues

### Included subsystems

- **memory store** for structured notes
- **skill router** with TF-IDF + scope-aware matching
- **dynamic tools** with proposal/approval flow and sandbox execution
- **telemetry + reflection** for bounded self-correction loops
- **AWM** (Agent Workflow Memory) extraction from successful multi-step procedures

---

## Safety model

Liku follows a fail-closed execution model.

Examples of current safeguards:

- destructive shortcuts such as close-window combos require explicit confirmation
- low-confidence target interactions are elevated in risk
- focus verification runs after action sequences
- post-action verification checks foreground/process alignment after bounded retries
- TradingView key workflows use observation checkpoints before follow-up typing
- DOM trade-entry and order-management actions are blocked by policy

This safety posture is intentional: if the system cannot establish enough evidence, it should stop rather than guess.

---

## Validation and testing

### Most useful day-to-day suites

```bash
npm run test:ai-focused
npm run test:windows-observation-flow
npm run test:chat-actionability
npm run test:ui
```

### Other useful scripts

```bash
npm run smoke
npm run smoke:shortcuts
npm run smoke:chat-direct
npm run smoke:tradingview-live -- --dry-run
npm run test:skills:inline
npm run proof:inline -- --list-suites
```

The current focused AI bundle runs:

- `scripts/test-windows-observation-flow.js`
- `scripts/test-bug-fixes.js`
- `scripts/test-chat-actionability.js`
- `scripts/test-ai-service-contract.js`
- `scripts/test-ai-service-browser-rewrite.js`
- `scripts/test-ai-service-state.js`
- `scripts/test-tradingview-registry-parity.js`

TradingView runtime behavior changes should also use `docs/TRADINGVIEW_VALIDATION_RUNBOOK.md`. The live smoke lane is opt-in and writes artifacts under `artifacts\live-validation\`; Playwright/browser evidence is secondary and must only validate browser-visible state after Liku actions.

---

## Project structure

```text
src/
├── cli/                    # CLI entrypoint and command modules
├── main/                   # Electron main process + AI service
├── renderer/               # Electron renderer processes
├── native/                 # Native integrations, including Windows UIA hosts
├── shared/                 # Shared utilities
└── assets/                 # Static assets

scripts/                    # Regression tests, smoke tests, proof harnesses
docs/                       # Architecture and orchestration docs
.github/hooks/              # Hook-based enforcement and artifacts
```

---

## Documentation

- [QUICKSTART.md](QUICKSTART.md)
- [INSTALLATION.md](INSTALLATION.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)
- [CONFIGURATION.md](CONFIGURATION.md)
- [TESTING.md](TESTING.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [RELEASE_PROCESS.md](RELEASE_PROCESS.md)
- [docs/AGENT_ORCHESTRATION.md](docs/AGENT_ORCHESTRATION.md)
- [docs/INTEGRATED_TERMINAL_ARCHITECTURE.md](docs/INTEGRATED_TERMINAL_ARCHITECTURE.md)

---

## Contributing and feedback

If you hit a problem, include as much of the following as possible in an issue:

- platform
- Node version
- command used
- active model/provider
- whether you were using Electron mode or `liku chat`
- reproduction steps
- expected vs actual behavior
- any relevant `doctor --json` output

Liku is evolving quickly, and the most useful bug reports are the ones tied to real runtime behavior and clear reproduction steps.
