# GitHub Copilot CLI: Liku Edition (Public Preview)

[![npm version](https://img.shields.io/npm/v/copilot-liku-cli.svg)](https://www.npmjs.com/package/copilot-liku-cli)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE.md)
[![Package Size](https://img.shields.io/badge/package-~245KB-blue.svg)](https://www.npmjs.com/package/copilot-liku-cli)

The power of GitHub Copilot, now with visual-spatial awareness and advanced automation.

GitHub Copilot-Liku CLI brings AI-powered coding assistance and UI automation directly to your terminal. This "Liku Edition" extends the standard Copilot experience with an ultra-thin Electron overlay, allowing the agent to "see" and interact with your screen through a coordinated grid system and native UI automation.

See [our official documentation](https://docs.github.com/copilot/concepts/agents/about-copilot-cli) or the [Liku Architecture](ARCHITECTURE.md) for more information.

![Image of the splash screen for the Copilot CLI](https://github.com/user-attachments/assets/51ac25d2-c074-467a-9c88-38a8d76690e3)

## 🚀 Introduction and Overview

We're bringing the power of GitHub Copilot coding agent directly to your terminal, enhanced with Liku's visual awareness. Work locally and synchronously with an AI collaborator that understands your code AND your UI state.

- **Unified Intelligence:** Combines terminal-native development with visual-spatial awareness.
- **Ultra-Thin Overlay:** A transparent Electron layer for high-performance UI element detection and interaction.
- **Multi-Agent Orchestration:** A trigger-based **Supervisor / Researcher / Architect / Builder / Verifier / Diagnostician / Vision Operator** system for complex tasks.
- **Liku CLI Suite:** A comprehensive set of automation tools (`click`, `find`, `type`, `keys`, `screenshot`) available from any shell.
- **Event-Driven UI Watcher:** Real-time UI state tracking via Windows UI Automation events with automatic polling fallback.
- **Defensive AI Architecture:** Engineered for minimal footprint ($<300$MB memory) and zero-intrusion workflows.

## 🛠️ The Liku CLI (`liku`)

The `liku` command is your entry point for visual interaction and automation. It can be used alongside the standard `copilot` command.

### Launching the Agent
```bash
liku start
# or simply
liku
```
This launches the Electron-based visual agent including the chat interface and the transparent overlay.

> **Note:** The visual overlay requires Electron (installed automatically as an optional dependency). All headless CLI commands (`click`, `find`, `type`, `keys`, `screenshot`, etc.) work without Electron.

### Terminal Chat (Headless)
If you want an interactive **terminal-first** workflow (no Electron UI required), use:

```bash
liku chat
```

This runs an AI chat loop that can emit and execute the same JSON actions as the overlay.
It also supports a **Teach** flow that persists app-scoped preferences (execution mode + action/negative policies) under `~/.liku-cli/preferences.json`.

Recent model-routing upgrades in `liku chat` and the Electron chat:
- Copilot models are grouped by capability instead of a single vision flag.
- Chat-facing selectors now separate `Agentic Vision`, `Reasoning / Planning`, and `Standard Chat` models.
- Legacy-unavailable selections like `gpt-5.4` are canonicalized away from the picker and no longer appear as first-class chat choices.
- Capability reroutes are surfaced back to the user instead of silently replacing the chosen model.
- `(plan)` routes to the existing multi-agent supervisor in non-destructive plan-only mode.

Recent reliability upgrades in `liku chat`:
- Multi-block model replies are parsed across all JSON fences and the best executable plan is selected.
- Browser continuity is tracked with explicit session state (`url`, `title`, `goalStatus`, `lastStrategy`) to reduce drift across turns.
- Deterministic browser rewrites now cover no-URL YouTube search requests (for example: "using edge open a new youtube page, then search for ...").
- Non-action acknowledgements/chit-chat are filtered to prevent accidental action execution.

### Automation Commands
| Command | Usage | Description |
| :--- | :--- | :--- |
| `chat` | `liku chat` | Interactive AI chat in the terminal (headless). |
| `click` | `liku click "Submit" --double` | Click UI element by text or coordinates. |
| `find` | `liku find "Save" --type Button` | Locate elements using native UI Automation / OCR. |
| `type` | `liku type "Hello World"` | Input string at the current cursor position. |
| `keys` | `liku keys ctrl+s` | Send complex keyboard combinations. |
| `window` | `liku window "VS Code"` | Focus a specific application window. |
| `screenshot`| `liku screenshot` | Capture the current screen state for analysis. |
| `mouse` | `liku mouse 500 300` | Move the mouse to screen coordinates. |
| `scroll` | `liku scroll down` | Scroll the active window or element. |
| `drag` | `liku drag 100,200 400,500` | Drag from one point to another. |
| `wait` | `liku wait "Loading..." --gone` | Wait for an element to appear or disappear. |
| `repl` | `liku repl` | Launch an interactive automation shell. |
| `agent` | `liku agent "Refactor login"` | Start a multi-agent task. |

### Power User Examples
```bash
# Chained automation
liku window "Notepad" && liku type "Done!" && liku keys ctrl+s

# Coordinate precision
liku click 500,300 --right

# JSON processing
liku find "*" --json | jq '.[0].name'

# Wait for UI state
liku wait "Submit" --timeout 5000 && liku click "Submit"
```

## 👁️ Visual Awareness & Grid System

Liku perceives your workspace through a dual-mode interaction layer.

- **Passive Mode:** Fully click-through, remaining dormant until needed.
- **Dot-Grid Targeting:** When the agent needs to target a specific point, it generates a coordinate grid (Coarse ~100px or Fine ~25px) using alphanumeric labels (e.g., `A1`, `C3.21`).
- **Live UI Inspection:** Uses native accessibility trees (Windows UI Automation) to highlight and "lock onto" buttons, menus, and text fields in real-time.
- **Event-Driven Updates:** The UI watcher uses a 4-state machine (POLLING → EVENT_MODE → FALLBACK) to stream live focus, structure, and property changes with automatic health monitoring.

### Global Shortcuts (Overlay)
- `Ctrl+Alt+Space`: Toggle the Chat Interface.
- `Ctrl+Alt+F`: Toggle **Fine Grid** (Precise targeting).
- `Ctrl+Alt+I`: Toggle **Inspect Mode** (UI Element highlighting).
- `Ctrl+Shift+O`: Toggle Overlay Visibility.

## 🤖 Multi-Agent System

The Liku Edition moves beyond single-turn responses with a trigger-based team of agents:

- **Supervisor**: Routes work by trigger, delegates only, and keeps the overall plan coherent.
- **Researcher**: Gathers codebase or documentation context when the target area is still unclear.
- **Architect**: Checks reuse, design boundaries, and consistency before implementation starts.
- **Builder**: Implements code only after the plan and target files are concrete.
- **Verifier**: Runs independent validation immediately after code changes.
- **Diagnostician**: Isolates root cause when verification fails or behavior is unclear.
- **Vision Operator**: Interprets screenshots, overlay behavior, browser-visible state, and desktop UI evidence.

The hook layer enforces role boundaries at runtime. Read-only roles are prevented from mutating files, and evidence-based stop hooks require structured outputs before subagents can finish. See [docs/AGENT_ORCHESTRATION.md](docs/AGENT_ORCHESTRATION.md) for the full routing and hook contract.

### Chat Slash Commands
- `/orchestrate <task>`: Start full multi-agent workflow.
- `/research <query>`: Execute deep workspace/web research.
- `/build <spec>`: Generate implementation from a spec.
- `/verify <target>`: Run validation checks on a feature or UI.
- `/model`: Show grouped Copilot model inventory or switch to a specific model.
- `/agentic`: Toggle **Autonomous Mode** (Allow AI actions without manual confirmation).
- `/recipes [on|off]`: Toggle bounded popup follow-up recipes for first-launch dialogs.

### Runtime Enforcement

The multi-agent layer is enforced at runtime rather than only described in docs:

- Read-only workers are blocked from mutating arbitrary repo files.
- Worker final reports are mirrored to role-specific artifacts under `.github/hooks/artifacts/`.
- Stop hooks validate required evidence sections from those artifacts when the editor runtime omits inline worker output.

See [docs/AGENT_ORCHESTRATION.md](docs/AGENT_ORCHESTRATION.md) for the full hook and evidence contract.

## 📦 Getting Started

### Prerequisites

- **Node.js** v18 or higher (v22 recommended)
- **npm** v9 or higher

#### Platform-Specific

| Platform | UI Automation | Requirements |
| :--- | :--- | :--- |
| **Windows** | Full (UIA + events) | PowerShell v5.1+; [.NET 9 SDK](https://dotnet.microsoft.com/download) for building the UIA host |
| **macOS** | Partial | Accessibility permissions required |
| **Linux** | Partial | AT-SPI2 recommended |

> **Windows UI Automation:** On `npm install`, a postinstall script automatically builds the .NET 9 UIA host binary if the .NET SDK is detected. If skipped, you can build it manually with `npm run build:uia`.

### Installation

#### Global Install (Recommended)

```bash
npm install -g copilot-liku-cli
```

Verify:
```bash
liku --version
liku --help
```

Update:
```bash
npm update -g copilot-liku-cli
```

#### From Source

```bash
git clone https://github.com/TayDa64/copilot-Liku-cli
cd copilot-Liku-cli
npm install
npm link

# Build the .NET UIA host (Windows only)
npm run build:uia
```

### Authenticate

Set a GitHub personal access token with Copilot permissions:
1. Visit [GitHub PAT Settings](https://github.com/settings/personal-access-tokens/new)
2. Enable "Copilot Requests" permission.
3. Export `GH_TOKEN` or `GITHUB_TOKEN` in your environment.

Or launch the agent and use the `/login` slash command.

> **Tip:** `liku chat` also supports `/login` and `/model`.

## ✅ Quick Verify

```bash
# Full smoke suite (233 assertions)
npm run smoke

# Individual checks
npm run smoke:shortcuts    # Runtime + shortcut diagnostics
npm run smoke:chat-direct  # Chat visibility (no keyboard emulation)
npm run test:ui            # UI automation baseline

# AI-service seam and compatibility checks
node scripts/test-ai-service-contract.js
node scripts/test-ai-service-commands.js
node scripts/test-ai-service-provider-orchestration.js
node scripts/test-ai-service-copilot-chat-response.js
node scripts/test-ai-service-response-heuristics.js

# Hook artifact enforcement proof
node scripts/test-hook-artifacts.js
```

## 🛠️ Technical Architecture

GitHub Copilot-Liku CLI is built on a "Defensive AI" architecture — minimal footprint, secure execution, and zero-intrusion workflows.

### Key Systems

| Layer | Description |
| :--- | :--- |
| **CLI** | 13 headless commands via `src/cli/liku.js` (CJS, no Electron required) |
| **.NET UIA Host** | Persistent JSONL process for Windows UI Automation (9 commands, thread-safe, event streaming) |
| **UI Watcher** | 4-state machine: POLLING ↔ EVENT_MODE ↔ FALLBACK with 10s health check |
| **Overlay** | Transparent Electron window with grid, inspect regions, and click-through passthrough |
| **Agent System** | Supervisor routes to Researcher / Architect / Builder / Verifier / Diagnostician / Vision Operator |

### AI Service Modularization

`src/main/ai-service.js` remains the public compatibility facade, but the internals are now being split into focused modules so the CLI and Electron paths can keep a stable API while responsibilities move behind characterization tests.

Recently extracted seams include:

- `src/main/ai-service/system-prompt.js`
- `src/main/ai-service/message-builder.js`
- `src/main/ai-service/commands.js`
- `src/main/ai-service/providers/orchestration.js`
- `src/main/ai-service/browser-session-state.js`
- `src/main/ai-service/conversation-history.js`
- `src/main/ai-service/ui-context.js`
- `src/main/ai-service/visual-context.js`
- provider/model registry and policy/preference helper modules

This keeps external behavior stable while making the runtime easier to validate and evolve one seam at a time.

### Performance Benchmarks

- **Memory Footprint**: $< 300$MB steady-state (~150MB baseline).
- **CPU Usage**: $< 0.5\%$ idle; $< 2\%$ in selection mode.
- **Startup Latency**: $< 3$ seconds from launch to functional state.
- **Package Size**: ~196 KB (npm tarball).

### Security & Isolation

- **Hardened Electron Environment**: Uses `contextIsolation` and `sandbox` modes to prevent prototype pollution.
- **Content Security Policy (CSP)**: Strict headers to disable unauthorized external resources.
- **Isolated Preload Bridges**: Secure IPC routing where renderers only have access to necessary system APIs.
- **No bundled secrets**: API keys read from environment variables only; tokens stored in `~/.liku-cli/`.

## 📚 Documentation

- **[Installation Guide](INSTALLATION.md)** — Detailed installation instructions for all platforms
- **[Quick Start Guide](QUICKSTART.md)** — Get up and running quickly

<details>
<summary>Developer docs (available in the repo, not shipped with npm)</summary>

- **[Contributing Guide](CONTRIBUTING.md)** — How to contribute to the project
- **[Publishing Guide](PUBLISHING.md)** — How to publish the package to npm
- **[Release Process](RELEASE_PROCESS.md)** — How to create and manage releases
- **[Architecture](ARCHITECTURE.md)** — System design and architecture
- **[Agent Orchestration](docs/AGENT_ORCHESTRATION.md)** — Multi-agent routing, role triggers, and hook enforcement
- **[Configuration](CONFIGURATION.md)** — Configuration options
- **[Testing](TESTING.md)** — Testing guide and practices

</details>

## 📢 Feedback and Participation

We're excited to have you join us early in the Copilot CLI journey.

This is an early-stage preview, and we're building quickly. Expect frequent updates--please keep your client up to date for the latest features and fixes!

Your insights are invaluable! Open issue in this repo, join Discussions, and run `/feedback` from the CLI to submit a confidential feedback survey!
