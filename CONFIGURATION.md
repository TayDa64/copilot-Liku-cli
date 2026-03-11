# Configuration Guide

This guide covers the configurable aspects of Copilot-Liku CLI — the multi-provider AI service, Electron overlay/chat, automation behavior, and preferences system.

## AI Service Configuration

### Provider Selection

Liku supports multiple AI providers. Set the active provider via environment variable or slash command:

```bash
# Environment variable
export COPILOT_PROVIDER=copilot  # copilot | openai | anthropic | ollama

# In liku chat or Electron chat
/provider copilot
```

### Authentication

| Provider | Environment Variable | Notes |
| :--- | :--- | :--- |
| **Copilot** | `GH_TOKEN` or `GITHUB_TOKEN` | GitHub PAT with Copilot permission |
| **OpenAI** | `OPENAI_API_KEY` | Standard OpenAI API key |
| **Anthropic** | `ANTHROPIC_API_KEY` | Anthropic API key |
| **Ollama** | (none) | Runs locally, no key needed |

Or authenticate interactively inside chat:
```
/login
```

### Model Selection

Models are grouped by capability. Use `/model` to see the live inventory:

```
/model              # Show grouped model list
/model claude-4     # Switch to a specific model
```

**Copilot model groups:**
- **Agentic Vision** — models with vision + tool-call support (best for automation)
- **Reasoning / Planning** — strong reasoning models (best for `(plan)` routing)
- **Standard Chat** — general-purpose chat models

Capability reroutes are surfaced visibly when a chosen model cannot handle the current request type.

### Status and Diagnostics

```
/status             # Show provider, model, routing metadata, browser continuity state
/clear              # Reset conversation history and browser session state
```

## Preferences System

### App-Scoped Preferences

Preferences are stored at `~/.liku-cli/preferences.json` and control per-app execution behavior:

```json
{
  "apps": {
    "Microsoft Edge": {
      "executionMode": "autonomous",
      "negativePolicies": ["do not close existing tabs"],
      "actionPolicies": ["always verify URL after navigation"]
    }
  }
}
```

- **negativePolicies** (brakes): constraints the AI must not violate
- **actionPolicies** (rails): positive enforcement rules the AI must follow
- **executionMode**: `"autonomous"` | `"confirm"` | `"manual"`

### Teaching Preferences

In `liku chat`, when prompted to run actions:
- Press `c` to **Teach** — this opens the preference flow for the active app
- Rules are validated with structured output parsing and saved with metrics placeholders

## Electron Overlay Configuration

### Window Behavior

Overlay and chat window settings are defined in `src/main/index.js`:

```javascript
// Overlay: transparent, full-screen, always-on-top, click-through
{
  frame: false,
  transparent: true,
  alwaysOnTop: true,
  focusable: false,
  skipTaskbar: true,
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    preload: 'overlay/preload.js'
  }
}
```

```javascript
// Chat: edge-docked, resizable, hidden by default
{
  frame: true,
  resizable: true,
  alwaysOnTop: false,
  show: false,
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    preload: 'chat/preload.js'
  }
}
```

### Global Shortcuts

Hotkeys are registered in `src/main/index.js`:

| Shortcut | Action |
| :--- | :--- |
| `Ctrl+Alt+Space` | Toggle chat window |
| `Ctrl+Shift+O` | Toggle overlay visibility |
| `Ctrl+Alt+I` | Toggle inspect mode |
| `Ctrl+Alt+F` | Toggle fine grid |
| `Ctrl+Alt+G` | Show all grid levels |
| `Ctrl+Alt+=` / `Ctrl+Alt+-` | Zoom in / out grid |

### Dot Grid Tuning

The overlay uses two grid densities:
- **Coarse grid**: ~100px spacing with alphanumeric labels (e.g., `A1`, `C3`)
- **Fine grid**: ~25px spacing for precise targeting (e.g., `C3.21`)

## Automation Configuration

### Slash Commands

| Command | Description |
| :--- | :--- |
| `/orchestrate <task>` | Start full multi-agent workflow |
| `/research <query>` | Deep workspace/web research |
| `/build <spec>` | Generate implementation from spec |
| `/verify <target>` | Run validation checks |
| `/model` | Show/switch model |
| `/agentic` | Toggle autonomous mode |
| `/recipes [on\|off]` | Toggle popup follow-up recipes |
| `/capture` | Capture screen for visual context |
| `/vision on` | Enable one-shot vision mode |

### Agentic Mode

When `/agentic` is enabled, the AI executes action plans without asking for confirmation. When disabled (default), each plan is shown and requires explicit approval.

### Safety Guardrails

Actions are analyzed for risk level before execution:
- **LOW**: auto-execute in agentic mode
- **MEDIUM**: execute with warning
- **HIGH**: require explicit confirmation even in agentic mode
- **CRITICAL**: always blocked; manual intervention required

Policy enforcement validates action plans against both negative and positive policies before execution. Violations trigger bounded regeneration.

## Platform-Specific Settings

### Windows

- PowerShell v5.1+ required for automation primitives
- .NET 9 SDK recommended for building the UIA host (`npm run build:uia`)
- The postinstall script auto-builds the UIA host if .NET SDK is detected

### macOS

- Accessibility permissions required for UI automation
- App hides from Dock; overlay uses `screen-saver` window level

### Linux

- AT-SPI2 recommended for accessibility integration

## Security Settings

### Electron Security

- `contextIsolation: true` — renderers cannot access Node.js APIs
- `nodeIntegration: false` — no `require()` in renderer code
- CSP headers enforce `default-src 'self'` with limited inline styles
- Preload scripts expose only the minimum required IPC bridges

### API Key Storage

- Keys are read from environment variables only
- Tokens stored locally under `~/.liku-cli/`
- No secrets bundled in the package

## Environment Variables

| Variable | Purpose | Default |
| :--- | :--- | :--- |
| `GH_TOKEN` / `GITHUB_TOKEN` | Copilot authentication | — |
| `OPENAI_API_KEY` | OpenAI provider key | — |
| `ANTHROPIC_API_KEY` | Anthropic provider key | — |
| `COPILOT_PROVIDER` | Active provider | `copilot` |
| `NODE_ENV` | Development/production mode | — |
