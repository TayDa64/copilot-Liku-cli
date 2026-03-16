# GitHub Copilot CLI: Liku Edition (Public Preview)

[![npm version](https://img.shields.io/npm/v/copilot-liku-cli.svg)](https://www.npmjs.com/package/copilot-liku-cli)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE.md)
[![Package Size](https://img.shields.io/badge/package-~196KB-blue.svg)](https://www.npmjs.com/package/copilot-liku-cli)

The power of GitHub Copilot, now with visual-spatial awareness, cognitive memory, and advanced automation.

GitHub Copilot-Liku CLI brings AI-powered coding assistance and UI automation directly to your terminal. This "Liku Edition" extends the standard Copilot experience with an ultra-thin Electron overlay, allowing the agent to "see" and interact with your screen through a coordinated grid system and native UI automation — plus a cognitive layer that gives the agent persistent memory, learnable skills, and reflective self-improvement.

See the [Liku Architecture](ARCHITECTURE.md) for the full system design.

![Image of the splash screen for the Copilot CLI](https://github.com/user-attachments/assets/51ac25d2-c074-467a-9c88-38a8d76690e3)

## 🚀 Introduction and Overview

We're bringing the power of GitHub Copilot coding agent directly to your terminal, enhanced with Liku's visual awareness. Work locally and synchronously with an AI collaborator that understands your code AND your UI state.

- **Unified Intelligence:** Combines terminal-native development with visual-spatial awareness.
- **Ultra-Thin Overlay:** A transparent Electron layer for high-performance UI element detection and interaction.
- **Multi-Agent Orchestration:** A trigger-based **Supervisor / Researcher / Architect / Builder / Verifier / Diagnostician / Vision Operator** system for complex tasks.
- **21 CLI Commands:** A comprehensive set of automation, diagnostics, and cognitive tools available from any shell — no Electron required.
- **Cognitive Layer:** Agentic memory (A-MEM), semantic skill routing, dynamic tool generation, RLVR telemetry, and reflective self-improvement.
- **Event-Driven UI Watcher:** Real-time UI state tracking via Windows UI Automation events with automatic polling fallback.
- **Defensive AI Architecture:** Engineered for minimal footprint ($< 300$MB memory) and zero-intrusion workflows.

## 🛠️ The Liku CLI (`liku`)

The `liku` command is your entry point for visual interaction, automation, and cognitive agent features.

### Launching the Agent
```bash
liku start
# or simply
liku
```
This launches the Electron-based visual agent including the chat interface and the transparent overlay.

> **Note:** The visual overlay requires Electron (installed automatically as an optional dependency). All headless CLI commands work without Electron.

### Terminal Chat (Headless)
For an interactive **terminal-first** workflow (no Electron UI required):

```bash
liku chat
```

This runs an AI chat loop that can emit and execute the same JSON actions as the overlay.
It also supports a **Teach** flow that persists app-scoped preferences (execution mode + action/negative policies) under `~/.liku/preferences.json`.

Key capabilities:
- Copilot models grouped by capability: `Agentic Vision`, `Reasoning / Planning`, and `Standard Chat`.
- Capability reroutes are surfaced back to the user instead of silently replacing the chosen model.
- `(plan)` routes to the multi-agent supervisor in non-destructive plan-only mode.
- Multi-block model replies are parsed across all JSON fences; the best executable plan is selected.
- Browser continuity tracked with explicit session state (`url`, `title`, `goalStatus`, `lastStrategy`).
- Non-action acknowledgements/chit-chat filtered to prevent accidental action execution.

### CLI Commands

| Command | Usage | Description |
| :--- | :--- | :--- |
| `start` | `liku start` | Launch the Electron agent with overlay. |
| `doctor` | `liku doctor` | Diagnostics: version, environment, active window, targeting hints. |
| `chat` | `liku chat [--model <key>]` | Interactive AI chat in the terminal (headless). |
| `click` | `liku click "Submit" --double` | Click UI element by text or coordinates. |
| `find` | `liku find "Save" --type Button` | Locate elements using native UI Automation. |
| `type` | `liku type "Hello World"` | Input string at the current cursor position. |
| `keys` | `liku keys ctrl+s` | Send keyboard shortcut combinations. |
| `screenshot` | `liku screenshot [path]` | Capture the current screen state. |
| `verify-hash` | `liku verify-hash --timeout 5000` | Poll until screenshot hash changes. |
| `verify-stable` | `liku verify-stable --metric dhash` | Wait until visual output is stable. |
| `window` | `liku window "VS Code"` | Focus or list application windows. |
| `mouse` | `liku mouse 500 300` | Move the mouse to screen coordinates. |
| `scroll` | `liku scroll down 3` | Scroll the active window or element. |
| `drag` | `liku drag 100 200 400 500` | Drag from one point to another. |
| `wait` | `liku wait "Loading..." --gone` | Wait for an element to appear or disappear. |
| `repl` | `liku repl` | Launch an interactive automation shell. |
| `memory` | `liku memory list\|show\|search\|stats` | Manage agent memory notes. |
| `skills` | `liku skills list\|search\|show` | Manage the semantic skill library. |
| `tools` | `liku tools list\|approve\|revoke` | Manage dynamic tool registry and proposals. |
| `analytics` | `liku analytics [--days N] [--raw]` | View telemetry analytics and success rates. |

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

# Diagnostics with targeting hints
liku doctor --json --flow

# Visual stability verification
liku screenshot --hash && liku verify-stable --stable-ms 2000

# Cognitive layer
liku memory search "login flow"
liku skills list
liku tools proposals
liku analytics --days 7
```

## 👁️ Visual Awareness & Grid System

Liku perceives your workspace through a dual-mode interaction layer.

- **Passive Mode:** Fully click-through, remaining dormant until needed.
- **Dot-Grid Targeting:** When the agent needs to target a specific point, it generates a coordinate grid (Coarse ~100px or Fine ~25px) using alphanumeric labels (e.g., `A1`, `C3.21`).
- **Live UI Inspection:** Uses native accessibility trees (Windows UI Automation) to highlight and "lock onto" buttons, menus, and text fields in real-time.
- **Event-Driven Updates:** The UI watcher uses a 4-state machine (POLLING → EVENT_MODE → FALLBACK) to stream live focus, structure, and property changes with automatic health monitoring.

### Global Shortcuts (Overlay)

| Shortcut | Action |
| :--- | :--- |
| `Ctrl+Alt+Space` | Toggle the Chat Interface |
| `Ctrl+Shift+O` | Toggle Overlay Visibility |
| `Ctrl+Alt+F` | Toggle **Fine Grid** (precise targeting) |
| `Ctrl+Alt+G` | Show all grids |
| `Ctrl+Alt+I` | Toggle **Inspect Mode** (UI element highlighting) |
| `Ctrl+Alt+=` / `Ctrl+Alt+-` | Zoom in / Zoom out |
| `Ctrl+Alt+X` | Cancel current selection |

## 🧠 Cognitive Layer

The Liku agent includes a full cognitive stack that gives it persistent memory, learnable skills, and reflective self-improvement. All state is stored under `~/.liku/`.

### Agentic Memory (A-MEM)
Structured notes with Zettelkasten-style linking, keyword relevance scoring, and token-budgeted context injection. Memory is automatically injected into the system prompt and pruned via LRU when the note count exceeds 500.

### Semantic Skill Router
Keyword + TF-IDF based skill selection with cosine similarity scoring. Up to 3 skills injected per turn within a 1500-token budget. Skills can be manually managed (`liku skills`) or auto-generated from successful multi-step action sequences (AWM procedural memory extraction).

### Dynamic Tool Generation
Users or the agent can propose new tools at runtime. Proposed tools go through a quarantine pipeline (`proposeTool()` → review → `approveTool()`) before becoming available. Approved tools execute in a sandboxed `child_process.fork()` worker with a stripped environment, 5.5s timeout, and 16 banned code patterns.

### RLVR Telemetry & Reflection
Structured telemetry tracks task outcomes, phase breakdowns, and failure reasons. Consecutive or session failure thresholds trigger a reflection pass that can be routed to a reasoning model (o1/o3-mini) via `/rmodel`. Telemetry JSONL files rotate at 10MB.

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

| Command | Description |
| :--- | :--- |
| `/orchestrate <task>` | Start full multi-agent workflow. |
| `/research <query>` | Execute deep workspace/web research. |
| `/build <spec>` | Generate implementation from a spec. |
| `/verify <target>` | Run validation checks on a feature or UI. |
| `/model [key]` | Show grouped Copilot model inventory or switch models. |
| `/provider` | Show or switch AI provider (Copilot/OpenAI/Anthropic/Ollama). |
| `/rmodel [key]` | Set/get/clear the reflection model override (reasoning models). |
| `/agentic` | Toggle **Autonomous Mode** (AI actions without confirmation). |
| `/recipes [on\|off]` | Toggle bounded popup follow-up recipes. |
| `/login` | Authenticate with GitHub. |
| `/status` | Show configured/requested/runtime model metadata and live inventory. |
| `/capture` | Capture current screen state. |
| `/vision [on\|off]` | Toggle visual context injection. |
| `/sequence` | Start a multi-step action sequence. |
| `/memory` | Manage agent memory from chat. |
| `/skills` | Browse the skill library from chat. |
| `/tools` | Manage dynamic tools from chat. |

### Runtime Enforcement

The multi-agent layer is enforced at runtime via `.github/hooks/`:

- **PreToolUse security gate** blocks file mutations for read-only roles and rejects dangerous shell patterns.
- **PostToolUse audit log** appends structured JSONL entries for every tool invocation.
- **SubagentStop quality gate** validates required evidence sections from role-specific artifacts under `.github/hooks/artifacts/` before allowing subagents to finish.
- **Session start/end logging** records session boundaries.

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
# Full smoke suite
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
node scripts/test-ai-service-model-registry.js
node scripts/test-ai-service-policy.js
node scripts/test-ai-service-preference-parser.js
node scripts/test-ai-service-provider-registry.js
node scripts/test-ai-service-slash-command-helpers.js
node scripts/test-ai-service-state.js
node scripts/test-ai-service-ui-context.js
node scripts/test-ai-service-visual-context.js

# Cognitive layer tests
node scripts/test-v015-cognitive-layer.js

# Hook artifact enforcement proof
node scripts/test-hook-artifacts.js
```

## 🛠️ Technical Architecture

GitHub Copilot-Liku CLI is built on a "Defensive AI" architecture — minimal footprint, secure execution, and zero-intrusion workflows.

### Key Systems

| Layer | Description |
| :--- | :--- |
| **CLI** | 21 headless commands via `src/cli/liku.js` (CJS, no Electron required) |
| **.NET UIA Host** | Persistent JSONL process for Windows UI Automation (thread-safe, event streaming) |
| **UI Watcher** | 4-state machine: POLLING ↔ EVENT_MODE ↔ FALLBACK with health checks |
| **Overlay** | Transparent Electron window with grid, inspect regions, and click-through passthrough |
| **Agent System** | Supervisor routes to Researcher / Architect / Builder / Verifier / Diagnostician / Vision Operator |
| **Cognitive Layer** | Memory (A-MEM), skill router (TF-IDF), dynamic tools (sandboxed), RLVR telemetry, reflection |
| **Hook Enforcement** | PreToolUse security gate, PostToolUse audit log, SubagentStop quality gate |

### AI Service Modularization

`src/main/ai-service.js` remains the public compatibility facade, but the internals are split into focused modules so the CLI and Electron paths can keep a stable API while responsibilities move behind characterization tests.

Extracted seams under `src/main/ai-service/`:

| Module | Purpose |
| :--- | :--- |
| `system-prompt.js` | System prompt construction with cognitive context injection |
| `message-builder.js` | Message assembly with explicit `skillsContext` and `memoryContext` |
| `commands.js` | Slash command dispatch |
| `providers/orchestration.js` | Multi-provider routing (Copilot, OpenAI, Anthropic, Ollama) |
| `providers/copilot/` | Copilot-specific model registry and capability matrix |
| `browser-session-state.js` | Browser continuity tracking across turns |
| `conversation-history.js` | Conversation history management |
| `ui-context.js` | UI state injection |
| `visual-context.js` | Visual/screenshot context handling |
| `actions/parse.js` | Action plan extraction from model responses |
| `policy.js` | Policy and safety enforcement |
| `preference-parser.js` | User preference parsing |
| `response-heuristics.js` | Response quality scoring |
| `slash-command-helpers.js` | Slash command utilities |

### Performance Benchmarks

- **Memory Footprint**: $< 300$MB steady-state (~150MB baseline).
- **CPU Usage**: $< 0.5\%$ idle; $< 2\%$ in selection mode.
- **Startup Latency**: $< 3$ seconds from launch to functional state.
- **Package Size**: ~196 KB (npm tarball).

### Security & Isolation

- **Hardened Electron Environment**: Uses `contextIsolation` and `sandbox` modes to prevent prototype pollution.
- **Content Security Policy (CSP)**: Strict headers to disable unauthorized external resources.
- **Isolated Preload Bridges**: Secure IPC routing where renderers only have access to necessary system APIs.
- **Sandboxed Dynamic Tools**: Dynamic tools execute in isolated `child_process.fork()` workers with stripped environment and kill timeout.
- **PreToolUse Hook Enforcement**: Security gate blocks dangerous patterns and enforces role-based file access.
- **No bundled secrets**: API keys read from environment variables only; tokens stored in `~/.liku/`.

### Project Structure

```
src/
├── cli/                    # CLI entrypoint and 21 command modules
│   ├── liku.js             # Main CLI dispatcher with COMMANDS registry
│   ├── commands/           # Individual command implementations
│   └── util/               # CLI utilities
├── main/                   # Electron main process + AI service
│   ├── index.js            # Electron app: overlay, chat window, IPC, shortcuts
│   ├── ai-service.js       # Public AI compatibility facade
│   └── ai-service/         # Extracted seams (providers, memory, skills, tools, etc.)
├── renderer/               # Electron renderer processes
│   ├── chat/               # Chat window UI (HTML + JS + preload)
│   └── overlay/            # Transparent overlay UI (HTML + JS + preload)
├── native/                 # Native integrations
│   ├── windows-uia/        # C# Windows UI Automation host (legacy)
│   └── windows-uia-dotnet/ # .NET 9 Windows UIA host (active)
├── shared/                 # Shared utilities
│   ├── liku-home.js        # ~/.liku/ home directory management
│   ├── token-counter.js    # BPE token counting (js-tiktoken)
│   ├── grid-math.js        # Grid coordinate calculations
│   └── inspect-types.js    # UI inspection type definitions
└── assets/                 # Static assets (tray icon, etc.)
scripts/                    # Test suites, smoke tests, and utilities
.github/hooks/              # Runtime hook enforcement (security, audit, quality)
bin/                        # Built .NET UIA host binary (WindowsUIA.exe)
```

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
- **[Integrated Terminal Architecture](docs/INTEGRATED_TERMINAL_ARCHITECTURE.md)** — Terminal integration design
- **[Configuration](CONFIGURATION.md)** — Configuration options
- **[Testing](TESTING.md)** — Testing guide and practices
- **[Changelog](changelog.md)** — Full version history and cognitive layer evolution

</details>

## 📢 Feedback and Participation

We're excited to have you join us early in the Copilot CLI journey.

This is an early-stage preview, and we're building quickly. Expect frequent updates — please keep your client up to date for the latest features and fixes!

Your insights are invaluable! Open an issue in this repo, join Discussions, and run `/feedback` from the CLI to submit a confidential feedback survey!
