# Electron Overlay + Chat UI

The optional Electron layer provides a visual overlay and chat interface on top of the headless CLI. It is **not required** for CLI commands or `liku chat`.

## Architecture

The Electron app consists of three runtime components:

### 1. Main Process (`src/main/index.js`)
- Window lifecycle management (overlay, chat, tray)
- IPC router for all inter-window communication
- Global hotkey registration
- Visual context capture (full-screen, region, active-window)
- Action execution pipeline with DPI/coordinate conversion
- Integration with `ai-service.js` for multi-provider AI

### 2. Overlay Renderer (`src/renderer/overlay/`)
- Full-screen, transparent, always-on-top, click-through by default
- Dot grid system (coarse ~100px, fine ~25px) with alphanumeric labels
- Inspect mode: highlights actionable UI elements using accessibility APIs
- Region overlays for AI-targeted interactions
- Pulse feedback animation for executed clicks

### 3. Chat Renderer (`src/renderer/chat/`)
- Edge-docked control surface with message history
- Provider/model selection UI hydrated from live AI status
- Capture buttons, action confirmation (Execute/Cancel), and mode controls
- Supports all slash commands (`/login`, `/model`, `/status`, `/orchestrate`, etc.)

## Launching

```bash
liku start
# or
npm start
```

## Modes

| Mode | Description |
| :--- | :--- |
| **Passive** | Overlay is invisible and click-through. Normal computer use. |
| **Selection** | Overlay shows interactive dot grid. Click to select coordinates. |
| **Inspect** | Accessibility-driven UI element highlighting with bounding boxes and tooltips. |

## Global Hotkeys

| Shortcut | Action |
| :--- | :--- |
| `Ctrl+Alt+Space` | Toggle chat window |
| `Ctrl+Shift+O` | Toggle overlay visibility |
| `Ctrl+Alt+I` | Toggle inspect mode |
| `Ctrl+Alt+F` | Toggle fine grid |
| `Ctrl+Alt+G` | Show all grid levels |
| `Ctrl+Alt+=` / `-` | Zoom in/out grid |

## Coordinate Contract

The overlay operates in CSS/DIP space. Automation uses physical pixels. The main process performs all necessary conversions:

1. **Dot selection**: overlay CSS coords → main converts to DIP → stored
2. **Action execution**: AI image-space coords → DIP → physical screen pixels
3. **Region-resolved actions**: UIA provides physical coords directly, bypass image scaling
4. **Pulse feedback**: physical coords → converted back to CSS/DIP for overlay rendering

This prevents click drift on HiDPI displays where the scale factor ≠ 1.

## Capture Flows

- **Full-screen capture**: hides overlay pre-capture to avoid artifacts
- **Region capture**: captures a specific ROI
- **Active-window capture**: captures the focused application window
- **Streaming mode**: optional continuous active-window capture

## Security

- `contextIsolation: true` in all renderer windows
- `nodeIntegration: false` — renderers have no direct Node.js access
- CSP headers restrict resource loading to `'self'`
- Preload scripts expose only the minimum required IPC bridges

## Tray Menu

Right-click the system tray icon:
- **Open Chat** — show/hide the chat window
- **Toggle Overlay** — show/hide the overlay
- **Quit** — exit the application

## Platform Notes

| Platform | Behavior |
| :--- | :--- |
| **macOS** | `screen-saver` window level, hidden from Dock, accessibility permissions required |
| **Windows** | Standard `alwaysOnTop`, hidden from taskbar, .NET UIA host for native automation |
| **Linux** | Standard `alwaysOnTop`, AT-SPI2 recommended |
