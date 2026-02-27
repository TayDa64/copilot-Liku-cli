# Advancing Features (PDF-grounded Implementation Plan)

## Coordinate Contract (Phase 1 — enforced)

All coordinates crossing an IPC boundary follow this contract:

| Direction | Source Space | Conversion | Target Space |
|-----------|-------------|-----------|-------------|
| Overlay → Main (`dot-selected`) | CSS/DIP | `× scaleFactor` | physical screen pixels |
| Main → Overlay (regions) | physical screen pixels | `÷ scaleFactor` | CSS/DIP |
| Main → Click injection | physical screen pixels | (none — native) | physical screen pixels |
| UIA bounds (from .NET host) | physical screen pixels | (none — native) | physical screen pixels |

- `scaleFactor` is `screen.getPrimaryDisplay().scaleFactor` (e.g. 1.25 at 125% DPI).
- `denormalizeRegionsForOverlay(regions, sf)` in `index.js` handles all Main → Overlay conversions.
- `dot-selected` handler in `index.js` adds `physicalX`/`physicalY` to every selection event.
- Region bounds stored in `inspectService` are always in **physical screen pixels**.
- The overlay renderer operates entirely in CSS/DIP; it never needs to know about physical pixels.

## Goal
Deliver a DevTools-like overlay + automation loop where:
- The overlay stays up while you keep interacting with background apps.
- The system can explicitly control window layering (front/back/minimize/restore/maximize) **and** reliably target UI elements for interaction.
- Behavior is grounded in the `System.Windows.Automation` (UI Automation) API surface (WindowsDesktop 11.0) rather than ad-hoc assumptions.

## Sources of truth
- Extracted .NET API reference (from the attached PDF)
  - [docs/pdf/system.windows.automation-windowsdesktop-11.0.txt](docs/pdf/system.windows.automation-windowsdesktop-11.0.txt)
  - [docs/pdf/system.windows.automation-windowsdesktop-11.0.index.txt](docs/pdf/system.windows.automation-windowsdesktop-11.0.index.txt)
  - Extractor: [scripts/extract-pdf-text.py](scripts/extract-pdf-text.py)
- Codebase modules to align
  - Overlay: [src/renderer/overlay/overlay.js](src/renderer/overlay/overlay.js)
  - Main orchestration: [src/main/index.js](src/main/index.js)
  - Inspect pipeline: [src/main/inspect-service.js](src/main/inspect-service.js)
  - Watcher pipeline: [src/main/ui-watcher.js](src/main/ui-watcher.js)
  - System action executor: [src/main/system-automation.js](src/main/system-automation.js)
  - UI automation toolkit: [src/main/ui-automation/index.js](src/main/ui-automation/index.js)
  - Window control: [src/main/ui-automation/window/manager.js](src/main/ui-automation/window/manager.js)
  - UIA .NET host(s):
    - [src/native/windows-uia-dotnet/Program.cs](src/native/windows-uia-dotnet/Program.cs)
    - [src/native/windows-uia/Program.cs](src/native/windows-uia/Program.cs)

## Current state (baseline)
- Overlay is already implemented as a transparent always-on-top window with click-through forwarding; inspect regions are rendered and can be refreshed.
- Explicit window operations already exist across UI layer + system actions + CLI:
  - z-order/state: front/back/minimize/restore/maximize
  - flexible window target resolution (by hwnd/title/process/class)

**Second-pass priority (Vision + Overlay-grounded Actions)**
This repo already contains major building blocks for “AI vision”, but they aren’t yet unified into a tight loop where the AI reliably sees what the user sees **and** can target actions using overlay/region semantics.

What exists today (ground truth):
- Screen/region capture (with “hide overlay before capture” safeguards):
  - [src/main/index.js](src/main/index.js)
  - Chat IPC entrypoints: [src/renderer/chat/preload.js](src/renderer/chat/preload.js)
- Visual context buffering + provider-specific multimodal message formatting:
  - [src/main/ai-service.js](src/main/ai-service.js)
- “Visual awareness” analysis primitives (OCR + UIA element discovery + point hit-testing + diffing):
  - [src/main/visual-awareness.js](src/main/visual-awareness.js)
- Overlay can already render “actionable regions” and hover-test them:
  - [src/renderer/overlay/overlay.js](src/renderer/overlay/overlay.js)
- Inspect data contracts already support `source: accessibility|ocr|heuristic`:
  - [src/shared/inspect-types.js](src/shared/inspect-types.js)

What’s missing (advancement features to add):
- A first-class **vision grounding loop** that ties together capture → analyze → regions → prompt context → action targeting.
- Multi-monitor/virtual-desktop correctness for *both* capture and overlay (current capture is primary-display oriented).
- Region-targeted actions (e.g., “click region #12”) so the AI can act using the same structures the overlay draws, instead of only raw coordinates.
- ROI (region-of-interest) capture as the default for “what am I looking at?” so the AI gets high-resolution detail where it matters without sending the entire screen every time.

This plan focuses on what the PDF implies we should harden/extend next.

---

## Key PDF-driven findings to incorporate

### 1) Coordinate systems are **physical screen coordinates**
UIA surfaces like `AutomationElement.BoundingRectangle`, `AutomationElement.FromPoint(Point)`, and clickable point APIs specify *physical screen coordinates*. Bounding rectangles can include non-clickable areas; `FromPoint` does not imply clickability.

Implication for this repo:
- Overlay renderer coordinates (CSS/DIP) must be converted to physical screen coordinates before they are used for UIA or input injection.
- Region modeling should treat bounding rectangles as “visual bounds”, and a separate “click point” (if available) as the preferred click target.

Relevant implementation touchpoints:
- Overlay mouse handling: [src/renderer/overlay/overlay.js](src/renderer/overlay/overlay.js)
- Click injection expects real screen coordinates: [src/main/ui-automation/mouse/click.js](src/main/ui-automation/mouse/click.js)
- Existing point-based UIA query in visual awareness: [src/main/visual-awareness.js](src/main/visual-awareness.js)

### 2) Foreground (Win32) vs focus (UIA) are not the same
The PDF explicitly notes `AutomationElement.SetFocus()` does **not** necessarily bring an element/window to the foreground or make it visible.

Implication:
- Keep Win32 foreground/z-order primitives for `front/back`.
- Treat UIA `SetFocus()` as “keyboard focus within the already-visible UI”. Use it as a complement before pattern actions (Value/Invoke/etc.), not as the mechanism for “bring to front”.

Relevant code touchpoints:
- Window primitives: [src/main/ui-automation/window/manager.js](src/main/ui-automation/window/manager.js)
- Agent action executor focus path: [src/main/system-automation.js](src/main/system-automation.js)

### 3) UIA patterns are the reliable interaction API (use mouse as fallback)
The PDF surfaces the standard interaction patterns:
- Invoke, Value, Scroll, ExpandCollapse, Toggle, Selection/SelectionItem, Text, WindowPattern, etc.

Implication:
- Prefer pattern-based interaction (Invoke/Value/Scroll/ExpandCollapse/Toggle/SelectionItem) over “click center of rectangle”.
- When mouse fallback is required, prefer `TryGetClickablePoint` over rect-center whenever possible.

Relevant code touchpoints:
- Element click pipeline: [src/main/ui-automation/interactions/element-click.js](src/main/ui-automation/interactions/element-click.js)
- System action dispatcher: [src/main/system-automation.js](src/main/system-automation.js)

### 4) Event-driven watcher is possible but requires a **persistent managed host**
UIA event APIs (`Automation.AddAutomationFocusChangedEventHandler`, `AddStructureChangedEventHandler`, `AddAutomationPropertyChangedEventHandler`, plus `TextPattern.*` events via `AddAutomationEventHandler`) require long-lived registrations.

Implication:
- The current polling-based PowerShell watcher cannot be “made event-driven” with small tweaks; event subscriptions need to run inside a persistent .NET process.
- The repo already has .NET UIA programs; they are the natural place to add an event-stream mode.

Relevant code touchpoints:
- Polling watcher today: [src/main/ui-watcher.js](src/main/ui-watcher.js)
- Existing .NET hosts: [src/native/windows-uia-dotnet/Program.cs](src/native/windows-uia-dotnet/Program.cs), [src/native/windows-uia/Program.cs](src/native/windows-uia/Program.cs)

### 5) Performance guidance matters
The PDF calls out that `AutomationElement.GetSupportedPatterns()` can be expensive.

Implication:
- Avoid calling `GetSupportedPatterns()` in hot paths (poll loops / frequent updates).
- When snapshots are needed, consider UIA `CacheRequest`/`GetUpdatedCache(...)` patterns in the managed host.

---

## Implementation plan (phased)

### Phase 0 — Give the AI “human vision” (capture → analyze → overlay regions → grounded actions)
**Why (high priority):** This is the shortest path to “AI can see what users see” using existing primitives, and it directly enables safer, more reliable action selection from the overlay.

Work items:
1) Standardize “visual context” as a typed artifact
- Define a shared schema for a visual frame that always includes:
  - `dataURL` (or base64), `width`, `height`, `timestamp`
  - `origin` / offsets (`x`,`y`) when capturing a region
  - `coordinateSpace` (physical screen pixels)
- Ensure the same schema is used for:
  - Full screen captures (`capture-screen`)
  - ROI captures (`capture-region`)
  - Optional window/element captures using the existing UI automation screenshot module: [src/main/ui-automation/screenshot.js](src/main/ui-automation/screenshot.js)

2) Make `{"type":"screenshot"}` a scoped capture request (not just “some screenshot”)
- The action executor already supports a `screenshot` action as a control signal.
- Extend the action schema to support (without adding new UX):
  - `scope: "screen" | "region" | "window" | "element"`
  - `region: { x, y, width, height }` (physical coordinates)
  - `hwnd` / window criteria (for window capture)
  - Element criteria (for element capture)
- This lets the AI request *exactly* the pixels it needs for reasoning and verification.

3) ROI-first capture for overlay selection + inspect
- When the user selects an inspect region (or hovered region), capture a tight ROI around it and store it as visual context.
- Use ROI capture as the default for “describe this area” / “what is this control?” prompts.

4) Wire “visual awareness” analysis into inspect regions (OCR + UIA + heuristics)
- Run `visualAwareness.analyzeScreen(...)` on the latest visual frame (or ROI) to produce:
  - OCR text blobs
  - UIA element candidates
  - Active window context
- Convert these into `InspectRegion` objects (source `ocr` / `accessibility` / `heuristic`) and push them through the existing region merge logic:
  - [src/main/inspect-service.js](src/main/inspect-service.js)
  - [src/shared/inspect-types.js](src/shared/inspect-types.js)
- Feed the merged regions into the overlay’s existing `update-inspect-regions` path.

5) Add region-grounded action targeting (AI acts like a human pointing)
- Extend the action contract so the AI can target by:
  - `targetRegionId` (stable) or `targetRegionIndex` (as displayed by overlay)
  - Optional `targetClickPoint` if provided by UIA (`TryGetClickablePoint`)
- Resolve those targets in main using inspect-service’s region registry, then execute via existing safe click paths.

6) Make visual context inclusion deterministic (not keyword-heuristic)
- Today, `includeVisualContext` is enabled by keyword heuristics and/or existing visual history.
- For overlay-driven interactions and region-based actions, force `includeVisualContext: true` with the corresponding ROI frame.

7) Ensure multimodal calls always use a vision-capable model
- The AI layer already supports vision-capable models and builds provider-specific image message payloads.
- Keep (and make explicit in the plan) the invariant: if a message contains images, route to a vision-capable model automatically (fallback as needed).

Acceptance criteria:
- After the user captures the screen once, the AI can answer “what’s on screen?” with visual grounding (not just Live UI State).
- When the user selects a region, the AI receives an ROI image of that region and can propose actions referencing it.
- The AI can execute an action like “click region #N” without guessing coordinates.

Primary files:
- Capture + storage: [src/main/index.js](src/main/index.js), [src/main/ai-service.js](src/main/ai-service.js)
- Analysis: [src/main/visual-awareness.js](src/main/visual-awareness.js)
- Region registry: [src/main/inspect-service.js](src/main/inspect-service.js)
- Overlay render + hit-test: [src/renderer/overlay/overlay.js](src/renderer/overlay/overlay.js)

### Phase 1 — Coordinate contract + multi-monitor correctness (highest leverage)
**Why:** UIA + input injection both assume physical screen coordinates; today overlay coordinates are not explicitly converted and the overlay is sized to the primary display.

Work items:
1) Define a single coordinate contract for actions and regions
- Add a clear contract document section (in this file or a short follow-up doc) stating:
  - Region bounds are in physical screen coordinates.
  - Optional `clickPoint` is also in physical screen coordinates.
  - Every region/action includes the coordinate space.

2) Convert overlay pointer coordinates to physical screen coordinates before action execution
- Implement conversion in the overlay→main IPC boundary.
- Ensure “screenX/screenY” is not used for unconverted values.

3) Make overlay cover the **virtual desktop** (union of all displays)
- Replace primary-only sizing with a union-of-displays rectangle.
- Ensure regions on a non-primary monitor render and are clickable.

4) Make capture cover the **virtual desktop** too
- Current capture paths are primary-display sized and positioned (x=0,y=0).
- Update capture to support:
  - Multi-display captures (one per display) with per-display offsets
  - Or a stitched virtual-desktop capture with correct origin
- Ensure ROI cropping uses the same coordinate basis as overlay regions.

Acceptance criteria:
- Clicking a point selected on the overlay lands on the correct pixel on 100% and scaled (125%/150%) displays.
- Regions on monitor 2 can be selected and clicked with no offset.

Primary files:
- [src/main/index.js](src/main/index.js)
- [src/renderer/overlay/overlay.js](src/renderer/overlay/overlay.js)
- [src/main/ui-automation/mouse/click.js](src/main/ui-automation/mouse/click.js)

### Phase 2 — “Pick element at point” + stable element identity
**Why:** DevTools-style interaction depends on reliable hit-testing and re-targeting without fragile “re-find by Name” logic.

Work items:
1) Add a point-based element resolver using `AutomationElement.FromPoint(Point)`
- Input: physical screen coordinates.
- Output: element payload with bounding rectangle and key identity fields.

2) Add runtimeId to element payloads
- Include `AutomationElement.GetRuntimeId()` in element results where feasible.
- Use runtimeId as a session-scoped stable identity (better than AutomationId-only).

3) Add clickable point support
- Prefer `TryGetClickablePoint(out Point)` and store `clickPoint` when available.

Acceptance criteria:
- Given a screen point, the system returns an element with bounding rectangle + (when available) clickable point + runtimeId.
- The element can be “re-resolved” later in the same session without relying on Name-only matching.

Primary files:
- [src/main/system-automation.js](src/main/system-automation.js)
- [src/main/visual-awareness.js](src/main/visual-awareness.js)
- [src/native/windows-uia-dotnet/Program.cs](src/native/windows-uia-dotnet/Program.cs)

### Phase 3 — Pattern-first interaction primitives (DevTools-like “actions”)
**Why:** Bounding rectangles are not guaranteed clickable; patterns are the intended automation surface.

Work items:
1) Add ValuePattern-based set value
- New high-level operation: set value on a target element.
- Prefer `ValuePattern.SetValue(string)`.
- Fallback: focus + typing only when ValuePattern is not supported.

2) Add ScrollPattern-based scrolling
- New operation: scroll a specific element/container.
- Prefer `ScrollPattern.Scroll(...)` or `SetScrollPercent(...)`.
- Fallback: mouse wheel simulation.

3) Add ExpandCollapsePattern operations
- Expand/collapse tree/menu items without coordinate clicking.

4) Add TextPattern read support (inspection)
- New inspection feature: read text content via `TextPattern.DocumentRange` where supported.

Acceptance criteria:
- For a control that supports a pattern, actions succeed without mouse injection.
- For a control that does not, the system returns a structured “pattern unsupported” result and falls back only when safe/appropriate.

Primary files:
- [src/main/system-automation.js](src/main/system-automation.js)
- [src/main/ui-automation/interactions/element-click.js](src/main/ui-automation/interactions/element-click.js)

### Phase 4 — Event-driven watcher (optional, but aligns strongly with UIA)
**Why:** Polling is coarse and expensive; UIA events can provide fast deltas, but only with a persistent host.

Work items:
1) Extend the .NET UIA host to support an “event stream” mode
- Register focus changed handler (system-wide) only when inspect mode is enabled.
- On focus changes, attach structure/property-changed handlers to the focused window subtree.
- Emit JSON deltas over stdout.

2) Update Node watcher to support “event backend”
- Spawn the managed host; translate deltas into the existing overlay region update format.
- Keep polling as a fallback/recovery mechanism.

Acceptance criteria:
- With inspect mode enabled, regions update within <250ms after UI changes without full rescans.
- The pipeline recovers gracefully when elements disappear (no crashes; falls back to re-snapshot).

Primary files:
- [src/main/ui-watcher.js](src/main/ui-watcher.js)
- [src/main/index.js](src/main/index.js)
- [src/native/windows-uia/Program.cs](src/native/windows-uia/Program.cs)

---

## Window operations alignment (follow-up hardening)
Window z-order/state primitives exist, but the PDF suggests we should treat UIA window semantics as first-class for validation and state constraints.

Work items:
- Unify “bring to front” implementation across CLI and agent actions so they behave consistently under foreground-lock constraints.
- Optionally consult `WindowPattern` for capability checks (`CanMinimize/CanMaximize`) and state confirmation, while still using Win32 for actual foreground/z-order.

Primary files:
- [src/main/system-automation.js](src/main/system-automation.js)
- [src/main/ui-automation/window/manager.js](src/main/ui-automation/window/manager.js)
- [src/cli/commands/window.js](src/cli/commands/window.js)

---

## Proposed deliverables
- This plan file (you are reading it).
- A small set of targeted PRs, ideally one per phase:
  - Phase 1: coordinate contract + virtual desktop overlay
  - Phase 2: point picking + runtimeId + clickable points
  - Phase 3: pattern-first actions (value/scroll/expand/text)
  - Phase 4: optional event-host + event backend

## Suggested validation (repo-local)
- Extend existing script-based tests under [scripts/](scripts/) where feasible.
- Add manual smoke steps:
  - Multi-monitor: verify overlay regions render on all displays and clicks land correctly.
  - DPI: verify click offsets at 125%/150% scale.
  - Pattern actions: verify ValuePattern/ScrollPattern/ExpandCollapse behave without mouse.
  - Watcher: verify inspect-mode gating of system-wide focus event subscriptions.
