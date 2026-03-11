# Architecture Documentation

## Overview

This application implements an Electron-based headless agent system with an ultra-thin overlay architecture. The design prioritizes minimal resource usage, non-intrusive UI, and extensible agent integration.

## Design Principles

1. **Minimal Footprint**: Single main process, lightweight renderers, no heavy frameworks
2. **Non-Intrusive**: Transparent overlay, edge-docked chat, never blocks user workspace
3. **Performance-First**: Click-through by default, minimal background processing
4. **Secure**: Context isolation, no Node integration in renderers, CSP headers
5. **Extensible**: Clean IPC message schema with multi-provider AI service and agent orchestration

## Multi-Agent Orchestration

The repo's custom-agent layer uses a trigger-based coordinator-worker model under [.github/agents](.github/agents).

### Roles

- **Supervisor** owns task routing and delegates only.
- **Researcher** gathers workspace or documentation context when the target area is still unclear.
- **Architect** validates reuse opportunities, design boundaries, and consistency before changes are made.
- **Builder** performs implementation once the plan and files are concrete.
- **Verifier** performs independent validation immediately after changes.
- **Diagnostician** isolates root cause when verification fails or the failure mode is ambiguous.
- **Vision Operator** analyzes screenshots, overlay behavior, accessibility state, and browser-visible results.

### Routing Triggers

- Use **Researcher** when the code location, supporting docs, or high-volume context is unclear.
- Use **Architect** when design reuse, structural consistency, or boundary choices matter.
- Use **Builder** only after the task is specific enough to implement safely.
- Use **Verifier** after every code change.
- Use **Diagnostician** when the verifier finds a regression or the root cause is not yet known.
- Use **Vision Operator** when UI state, screenshots, overlay behavior, or browser-visible results matter.

### Hook Enforcement

The orchestration layer is reinforced by hook policies under [.github/hooks](.github/hooks):

- `PreToolUse` blocks disallowed tool classes by role.
- `SubagentStop` checks each role's final response for required evidence sections before allowing completion.
- `PostToolUse` records an audit trail.

The practical effect is that routing is not just descriptive. Read-only roles are restricted from mutating files, and worker outputs must carry enough evidence to pass stop-hook quality gates.

See [docs/AGENT_ORCHESTRATION.md](docs/AGENT_ORCHESTRATION.md) for the detailed routing and role contract.

## AI Service Architecture

The runtime still exposes a single public entrypoint at `src/main/ai-service.js`, but the implementation is being decomposed into smaller internal modules behind that facade.

### Current Internal Seams

- `system-prompt.js`: platform-aware prompt text and action instructions.
- `message-builder.js`: prompt assembly, history injection, inspect context, live UI context, semantic DOM context, and provider-specific vision formatting.
- `commands.js`: slash-command handling for `/provider`, `/model`, `/status`, `/login`, `/capture`, `/vision`, and `/clear`.
- `providers/registry.js`: provider selection state and API-key storage.
- `providers/copilot/model-registry.js`: Copilot model metadata, preference persistence, and dynamic discovery.
- `providers/orchestration.js`: fallback chain selection and provider dispatch for initial response, continuation, and regeneration flows.
- `browser-session-state.js`, `conversation-history.js`, `visual-context.js`, and `ui-context.js`: runtime state holders previously embedded in the monolith.

### Compatibility Strategy

- `src/main/ai-service.js` remains the only supported public entrypoint during the migration.
- Extracted modules are composed from the facade instead of being consumed directly by app code.
- Source-sensitive regression markers remain in the facade because some tests still inspect literal strings in that file.

### Verification Strategy

The modularization work is gated by focused characterization tests in addition to broader smoke coverage:

- `scripts/test-ai-service-contract.js`
- `scripts/test-ai-service-commands.js`
- `scripts/test-ai-service-provider-orchestration.js`
- existing `scripts/test-v006-features.js` and `scripts/test-bug-fixes.js`

This allows internal seams to move without changing the external contract seen by the CLI, Electron runtime, or agent adapters.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          Main Process                            │
│  ┌────────────┐  ┌──────────┐  ┌────────────┐  ┌─────────────┐ │
│  │  Overlay   │  │   Chat   │  │    Tray    │  │   Global    │ │
│  │  Manager   │  │  Manager │  │   Icon     │  │  Hotkeys    │ │
│  └─────┬──────┘  └────┬─────┘  └─────┬──────┘  └──────┬──────┘ │
│        │              │              │                │         │
│  ┌─────┴──────────────┴──────────────┴────────────────┴──────┐  │
│  │                    IPC Router                             │  │
│  └─────┬────────────────────────────────────────────┬────────┘  │
└────────┼────────────────────────────────────────────┼───────────┘
         │                                            │
    ┌────┴────────┐                          ┌───────┴────────┐
    │   Overlay   │                          │      Chat      │
    │  Renderer   │                          │    Renderer    │
    │             │                          │                │
    │ ┌─────────┐ │                          │ ┌────────────┐ │
    │ │  Dots   │ │                          │ │   History  │ │
    │ │  Grid   │ │                          │ │            │ │
    │ └─────────┘ │                          │ └────────────┘ │
    │ ┌─────────┐ │                          │ ┌────────────┐ │
    │ │  Mode   │ │                          │ │   Input    │ │
    │ │Indicator│ │                          │ │            │ │
    │ └─────────┘ │                          │ └────────────┘ │
    └─────────────┘                          │ ┌────────────┐ │
                                             │ │  Controls  │ │
                                             │ └────────────┘ │
                                             └────────────────┘
```

## Component Details

### Main Process (`src/main/index.js`)

**Responsibilities:**
- Window lifecycle management
- IPC message routing
- Global state management
- System integration (tray, hotkeys)

**Key Functions:**
- `createOverlayWindow()`: Creates transparent, always-on-top overlay
- `createChatWindow()`: Creates edge-docked chat interface
- `createTray()`: Sets up system tray icon and menu
- `registerShortcuts()`: Registers global hotkeys
- `setupIPC()`: Configures IPC message handlers
- `setOverlayMode()`: Switches between passive/selection modes
- `toggleChat()`: Shows/hides chat window
- `toggleOverlay()`: Shows/hides overlay

**State:**
```javascript
{
  overlayMode: 'passive' | 'selection',
  isChatVisible: boolean,
  overlayWindow: BrowserWindow,
  chatWindow: BrowserWindow,
  tray: Tray
}
```

### Overlay Renderer (`src/renderer/overlay/`)

**Responsibilities:**
- Render dot grid
- Handle dot interactions
- Display mode indicator
- Communicate selections to main process

**Files:**
- `index.html`: UI structure and styles
- `preload.js`: Secure IPC bridge

**State:**
```javascript
{
  currentMode: 'passive' | 'selection',
  gridType: 'coarse' | 'fine',
  dots: Array<{id, x, y, label}>
}
```

**Key Functions:**
- `generateCoarseGrid()`: Creates ~100px spacing grid
- `generateFineGrid()`: Creates ~25px spacing grid
- `renderDots()`: Renders interactive dots
- `selectDot()`: Handles dot click events
- `updateModeDisplay()`: Updates UI based on mode

### Chat Renderer (`src/renderer/chat/`)

**Responsibilities:**
- Display chat history
- Handle user input
- Show mode controls
- Receive agent responses

**Files:**
- `index.html`: UI structure and styles
- `preload.js`: Secure IPC bridge

**State:**
```javascript
{
  currentMode: 'passive' | 'selection',
  messages: Array<{text, type, timestamp}>
}
```

**Key Functions:**
- `addMessage()`: Adds message to history
- `sendMessage()`: Sends user message to main
- `setMode()`: Changes overlay mode
- `updateModeDisplay()`: Updates mode button states

## IPC Message Schema

### Message Types

#### overlay → main → chat: dot-selected
```javascript
{
  id: string,        // e.g., 'dot-100-200'
  x: number,         // Screen X coordinate
  y: number,         // Screen Y coordinate
  label: string,     // e.g., 'A2'
  timestamp: number  // Unix timestamp in ms
}
```

#### chat → main → overlay: set-mode
```javascript
'passive' | 'selection'
```

#### chat → main: chat-message
```javascript
string  // User message text
```

#### main → chat: agent-response
```javascript
{
  text: string,      // Response text
  timestamp: number  // Unix timestamp in ms
}
```

#### main → overlay: mode-changed
```javascript
'passive' | 'selection'
```

#### renderer → main: get-state (invoke/handle)
```javascript
// Response:
{
  overlayMode: 'passive' | 'selection',
  isChatVisible: boolean
}
```

## Window Configuration

### Overlay Window

```javascript
{
  // Frameless and transparent
  frame: false,
  transparent: true,
  
  // Always on top
  alwaysOnTop: true,
  level: 'screen-saver', // macOS only
  
  // Full screen
  fullscreen: true,
  
  // Non-interactive by default
  focusable: false,
  skipTaskbar: true,
  
  // Security
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    preload: 'overlay/preload.js'
  }
}
```

### Chat Window

```javascript
{
  // Standard window with frame
  frame: true,
  transparent: false,
  
  // Positioned at bottom-right
  x: width - chatWidth - margin,
  y: height - chatHeight - margin,
  
  // Resizable but not always on top
  resizable: true,
  alwaysOnTop: false,
  
  // Hidden by default
  show: false,
  
  // Security
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    preload: 'chat/preload.js'
  }
}
```

## Mode System

### Passive Mode
- **Purpose**: Allow normal application interaction
- **Behavior**: 
  - Overlay fully click-through via `setIgnoreMouseEvents(true)`
  - No dots rendered
  - Mode indicator hidden
  - CPU usage minimal (no event processing)
  
### Selection Mode
- **Purpose**: Enable screen element selection
- **Behavior**:
  - Overlay captures mouse events via `setIgnoreMouseEvents(false)`
  - Dots rendered with CSS `pointer-events: auto`
  - Mode indicator visible
  - Click events captured and routed via IPC
  - Automatically reverts to passive after selection

## Security Architecture

### Context Isolation
All renderer processes use context isolation to prevent prototype pollution attacks.

### Preload Scripts
Secure bridge between main and renderer processes:
```javascript
contextBridge.exposeInMainWorld('electronAPI', {
  // Only expose necessary methods
  selectDot: (data) => ipcRenderer.send('dot-selected', data),
  onModeChanged: (cb) => ipcRenderer.on('mode-changed', cb)
});
```

### Content Security Policy
All HTML files include CSP headers:
```html
<meta http-equiv="Content-Security-Policy" 
      content="default-src 'self'; style-src 'self' 'unsafe-inline';">
```

### No Remote Content
All resources loaded locally, no CDN or external dependencies.

## Performance Characteristics

### Memory Usage
- **Target**: < 300MB steady-state
- **Baseline**: ~150MB for Electron + Chromium
- **Overlay**: ~20-30MB (minimal DOM, vanilla JS)
- **Chat**: ~30-40MB (simple UI, limited history)

### CPU Usage
- **Idle (passive mode)**: < 0.5%
- **Selection mode**: < 2%
- **During interaction**: < 5%

### Startup Time
- **Target**: < 3 seconds to functional
- **Breakdown**:
  - Electron init: ~1s
  - Window creation: ~1s
  - Renderer load: ~0.5s

## Extensibility Points

### AI Service Providers
New providers can be added by implementing the provider interface in `src/main/ai-service/providers/` and registering in the provider registry. The orchestration layer handles fallback chains and dispatch.

### CLI Commands
New CLI commands are added as modules in `src/cli/commands/` and registered in the `COMMANDS` table in `src/cli/liku.js`.

### Agent Roles
New orchestration roles can be added as agent definition files in `.github/agents/` with corresponding hook policies in `.github/hooks/`.

## Platform Differences

### macOS
- Window level: `'screen-saver'` to float above fullscreen
- Dock: Hidden via `app.dock.hide()`
- Tray: NSStatusBar with popover behavior
- Permissions: Requires accessibility + screen recording

### Windows
- Window level: Standard `alwaysOnTop`
- Taskbar: Overlay hidden via `skipTaskbar`
- Tray: System tray with balloon tooltips
- Permissions: No special permissions required

## Troubleshooting

### Overlay Not Appearing
1. Check window level setting
2. Verify `alwaysOnTop` is true
3. Test with `overlayWindow.show()`
4. Check GPU acceleration settings

### Click-Through Not Working
1. Verify `setIgnoreMouseEvents(true, {forward: true})`
2. Check CSS `pointer-events` on elements
3. Test in different applications
4. Check for conflicting event handlers

### Chat Not Showing
1. Verify `chatWindow.show()` is called
2. Check window position (may be off-screen)
3. Verify not hidden behind other windows
4. Check `skipTaskbar` setting

### IPC Messages Not Received
1. Verify preload script loaded
2. Check `contextBridge` exposure
3. Enable IPC logging in DevTools
4. Verify correct channel names

### AI Service Issues
1. Check provider authentication (`/login` or environment variables)
2. Verify model availability with `/status`
3. Check capability routing with `/model`
4. Review conversation state with `/status`

## Best Practices

### DO
- Use context isolation
- Disable node integration in renderers
- Minimize renderer dependencies
- Implement proper cleanup on window close
- Use debouncing for frequent events
- Test on both platforms

### DON'T
- Enable node integration in production
- Load remote content without validation
- Create/destroy windows repeatedly
- Poll continuously in background
- Ignore security warnings
- Assume platform consistency

## References

- [Electron Documentation](https://electronjs.org/docs)
- [Electron Security Guide](https://electronjs.org/docs/tutorial/security)
- [IPC Communication](https://electronjs.org/docs/api/ipc-main)
- [BrowserWindow API](https://electronjs.org/docs/api/browser-window)
