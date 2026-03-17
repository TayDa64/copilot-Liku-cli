# v0.0.14 Implementation Plan — Application & Floating Window Awareness

> Generated: 2026-03-17  
> Based on: Deep codebase analysis of system-automation.js, ai-service.js, ui-watcher.js, window/manager.js, system-prompt.js  
> Status: **Ready for implementation**

---

## Executive Summary

Liku's current window handling works well for single-window apps but has systematic blind spots for **multi-window applications** (DAWs, IDEs, Creative tools, productivity suites) and **floating/popup windows** (tool palettes, modeless dialogs, always-on-top panels). This plan addresses **7 gaps** discovered through codebase analysis, prioritized by user impact.

---

## Gap Analysis (Codebase-Grounded Findings)

### Gap 1: Untitled Windows Are Invisible
**Location:** `resolveWindowHandle()` in `system-automation.js` (~line 545), `findWindows()` in `window/manager.js`  
**Problem:** Both EnumWindows loops have `if ([string]::IsNullOrWhiteSpace($t)) { continue }` — tool palettes, floating panels, and some dialogs in apps like Photoshop, Ableton, FL Studio, MPC Beats have **empty window titles** are systematically skipped.  
**Impact:** Liku literally cannot see or interact with floating palettes/tool windows.  
**Evidence:** `findWindows()` has `includeUntitled` param but it defaults to `false` and nothing in the AI layer uses it.

### Gap 2: No Multi-Window Disambiguation
**Location:** `resolveWindowHandle()` in `system-automation.js`  
**Problem:** Returns the **first match** from EnumWindows (arbitrary z-order). When an app has multiple windows (e.g., DAW with main window + mixer + piano roll + plugin windows), there's no scoring to prefer the "main" window vs. a tiny palette.  
**Impact:** `focus_window` or `bring_window_to_front` targeting by process name may surface the wrong window (a small palette instead of the main workspace).

### Gap 3: No Window-Type Awareness (Owner/Tool/Topmost/Modal)
**Location:** Entirely missing from the codebase  
**Problem:** Win32 provides rich window metadata:
- `WS_EX_TOOLWINDOW` — tool palettes  
- `WS_EX_TOPMOST` — always-on-top windows  
- `GetWindow(GW_OWNER)` — owner/child relationships  
- `WindowPattern.IsModal` — retrieved in `getWindowCapabilities()` but never surfaced or used  
**Impact:** Liku can't distinguish a main window from its floating panels, can't detect always-on-top windows that might block clicks, and can't handle modal dialogs specially.

### Gap 4: UI Watcher Doesn't Report Window Type or Z-Order
**Location:** `getContextForAI()` in `ui-watcher.js`  
**Problem:** The Live UI State block sent to the AI only shows window title + handle + element list. No information about:
- Whether the window is a floating panel or main window
- Z-order (which window is on top)
- Whether the window is modal, topmost, or minimized
- Owner/child relationships between windows of the same app  
**Impact:** The AI has no awareness that clicking a coordinate might be blocked by an always-on-top window, and can't reason about window layering.

### Gap 5: `withInferredProcessName()` Has Limited App Vocabulary
**Location:** `system-automation.js` executeAction helper  
**Problem:** Only maps ~15 apps (Edge, Chrome, Firefox, VS Code, Explorer, Notepad, Terminal, Spotify, Slack, Discord, Teams, Outlook). Creative/professional apps — DAWs (Ableton, FL Studio, MPC Beats, Reaper), IDEs (IntelliJ, Rider), Creative tools (Photoshop, Blender, OBS) — are unknown.  
**Impact:** When the AI generates `bring_window_to_front { title: "MPC Beats" }` without `processName`, the title-only matching is less reliable.

### Gap 6: Post-Launch Verification Doesn't Handle Multi-Window Apps
**Location:** `verifyAndSelfHealPostActions()` + `evaluateForegroundAgainstTarget()` in `ai-service.js`  
**Problem:** After launching an app, verification checks if the **foreground** window matches the expected process/title. But multi-window apps often open with a splash screen, project selector, or secondary window initially focused — not the "main" window.  
**Impact:** False verification failures → unnecessary self-heal retries → wasted time and potential double-launches.

### Gap 7: System Prompt Lacks Multi-Window / Floating Window Guidance
**Location:** `system-prompt.js`  
**Problem:** No instructions for the AI on how to handle:
- Apps with multiple windows (which one to target?)
- Floating palettes that might need to be dismissed or navigated around
- Always-on-top windows blocking interaction with background windows
- Modal dialogs that must be dismissed before the parent window responds  
**Impact:** The AI makes naive assumptions — treats every app as single-window, doesn't anticipate floating panels covering click targets.

---

## Implementation Plan

### Phase 1: Window Metadata Enrichment (Foundation)
**Priority: HIGH — Enables all subsequent phases**

#### 1A. Enrich `findWindows()` with Window Styles & Owner Chain
**File:** `src/main/ui-automation/window/manager.js`  
**Change:** Extend the PowerShell `WindowFinder` class to also retrieve:
- `GetWindowLong(GWL_EXSTYLE)` → detect `WS_EX_TOOLWINDOW`, `WS_EX_TOPMOST`, `WS_EX_NOACTIVATE`
- `GetWindow(GW_OWNER)` → owner HWND (0 = top-level main window, non-zero = owned panel/dialog)
- `IsIconic()` → minimized state
- `IsZoomed()` → maximized state  
**Output schema addition:**
```js
{
  hwnd, title, className, processName, bounds,
  // NEW:
  isToolWindow: boolean,   // WS_EX_TOOLWINDOW flag
  isTopmost: boolean,      // WS_EX_TOPMOST flag  
  ownerHwnd: number,       // 0 = main window, >0 = owned/floating
  isMinimized: boolean,
  isMaximized: boolean
}
```
**Tests:** Add assertions in a new `scripts/test-window-metadata.js`

#### 1B. Propagate Metadata Into `resolveWindowHandle()`
**File:** `src/main/system-automation.js`  
**Change:** When resolving windows, use the enriched metadata to **prefer main windows** (ownerHwnd === 0, not isToolWindow) over floating panels when multiple matches exist. Add a scoring function:
```js
function scoreWindowMatch(win) {
  let score = 0;
  if (win.ownerHwnd === 0) score += 10;      // Main window preferred
  if (!win.isToolWindow) score += 5;          // Not a tool palette
  if (!win.isMinimized) score += 3;           // Visible windows preferred
  if (win.bounds.width * win.bounds.height > 100000) score += 2; // Larger windows preferred
  return score;
}
```
**Backward compat:** Still returns single hwnd; just picks the *best* match instead of *first* match.

---

### Phase 2: AI Awareness — UI Watcher & System Prompt
**Priority: HIGH — Makes the AI "see" window topology**

#### 2A. Enrich `getContextForAI()` with Window Topology
**File:** `src/main/ui-watcher.js`  
**Change:** When rendering the `[WIN]` header blocks in the Live UI State, add metadata tags:
```
[WIN] **Window**: "MPC Beats - Project 1" (Handle: 12345) [MAIN] [TOPMOST]
[WIN] **Window**: "" (Handle: 12346) [PALETTE] [FLOATING] owner:12345
[WIN] **Window**: "Save As" (Handle: 12347) [MODAL] owner:12345
```
**Requires:** `findWindows()` enrichment from Phase 1A, or a lightweight inline metadata query.  
**Scope:** Only enrich the `[WIN]` header lines — element detection unchanged.

#### 2B. Add Multi-Window Policy to System Prompt
**File:** `src/main/ai-service/system-prompt.js`  
**Change:** Add new section after "Application Launch Policy":
```
### Multi-Window Application Awareness (IMPORTANT)
Many professional applications (DAWs, IDEs, creative tools) use **multiple windows**:
- **[MAIN]** — Primary workspace window. Target this for keyboard shortcuts and menu interactions.
- **[PALETTE] / [FLOATING]** — Tool palettes, panels, inspectors. These may overlap the main window. If a click target is obscured, focus the main window first or dismiss/move the floating panel.
- **[MODAL]** — Dialog boxes that block the parent window. These MUST be dismissed (OK/Cancel/Close) before the parent window will respond to input.
- **[TOPMOST]** — Always-on-top windows. These float above everything. If blocking interaction, use `send_window_to_back` or `minimize_window` to clear them.

**Rules:**
1. When targeting a multi-window app, prefer the [MAIN] window for keyboard shortcuts.
2. If a click fails because a floating panel is covering the target, try `send_window_to_back` on the floating panel first.
3. Modal dialogs ([MODAL]) must be dismissed before interacting with the parent — do not try to click through them.
4. When launching apps that show splash screens or project selectors, wait for the main workspace to appear before proceeding with app-specific actions.
```

---

### Phase 3: Smarter Window Resolution & Interaction
**Priority: MEDIUM — Quality-of-life improvements**

#### 3A. Expand `withInferredProcessName()` Vocabulary
**File:** `src/main/system-automation.js`  
**Change:** Add mappings for professional/creative apps:
```js
// Creative / Audio
else if (title.includes('ableton')) processName = 'Ableton';
else if (title.includes('fl studio')) processName = 'FL64';
else if (title.includes('mpc')) processName = 'MPC';
else if (title.includes('reaper')) processName = 'reaper';
else if (title.includes('audacity')) processName = 'Audacity';
else if (title.includes('obs')) processName = 'obs64';
// Creative / Visual
else if (title.includes('photoshop')) processName = 'Photoshop';
else if (title.includes('illustrator')) processName = 'Illustrator';
else if (title.includes('blender')) processName = 'blender';
else if (title.includes('gimp')) processName = 'gimp';
else if (title.includes('figma')) processName = 'Figma';
// IDEs
else if (title.includes('intellij') || title.includes('idea')) processName = 'idea64';
else if (title.includes('rider')) processName = 'rider64';
else if (title.includes('webstorm')) processName = 'webstorm64';
else if (title.includes('android studio')) processName = 'studio64';
// Productivity
else if (title.includes('word') && !title.includes('wordpress')) processName = 'WINWORD';
else if (title.includes('excel')) processName = 'EXCEL';
else if (title.includes('powerpoint')) processName = 'POWERPNT';
else if (title.includes('onenote')) processName = 'onenote';
```
**Risk:** LOW. Fallback-only path — no behavior change when `processName` is already supplied.

#### 3B. Expand `buildProcessCandidatesFromAppName()` Known Mappings
**File:** `src/main/ai-service.js`  
**Change:** Add entries to the `known` array:
```js
{ re: /\bableton\b/i, names: ['Ableton'] },
{ re: /\bfl\s*studio\b/i, names: ['FL64', 'FL'] },
{ re: /\breaper\b/i, names: ['reaper'] },
{ re: /\bobs\b/i, names: ['obs64', 'obs'] },
{ re: /\bphotoshop\b/i, names: ['Photoshop'] },
{ re: /\bblender\b/i, names: ['blender'] },
{ re: /\bfigma\b/i, names: ['Figma'] },
{ re: /\bintellij\b/i, names: ['idea64', 'idea'] },
{ re: /\bandroid\s+studio\b/i, names: ['studio64'] },
{ re: /\bword\b/i, names: ['WINWORD'] },
{ re: /\bexcel\b/i, names: ['EXCEL'] },
{ re: /\bpowerpoint\b/i, names: ['POWERPNT'] },
```
**Risk:** LOW. Only used for post-launch verification.

---

### Phase 4: Floating Window Interaction Improvements
**Priority: MEDIUM — Addresses real user pain with complex apps**

#### 4A. Auto-Detect Blocking Topmost Windows Before Click
**File:** `src/main/ai-service.js` (inside the click execution path)  
**Change:** Before executing a coordinate click, check if there's a topmost/floating window overlapping the target coordinates. If so, either:
1. Focus the target window first (already done for elementAtPoint)
2. Send the blocking window to back
3. Warn the AI in the result that a floating panel was blocking  
**Implementation:** Use `findWindows({ processName })` with enriched metadata → check if any topmost/tool window bounds contain the click coordinates → send it to back.

#### 4B. Owned-Window Following for Focus Operations
**File:** `src/main/system-automation.js`  
**Change:** When `focus_window` targets a process and the match is an owned window (|ownerHwnd > 0), also focus the owner (main) window first, then the specific owned window second. This ensures the entire window group comes to the front.

---

### Phase 5: Resilience & Edge Cases  
**Priority: LOW — Hardens v0.0.14 for complex real-world scenarios**

#### 5A. Handle Splash Screens in Post-Launch Verification
**File:** `src/main/ai-service.js` (`verifyAndSelfHealPostActions`)  
**Change:** When verification detects a foreground window with a popup keyword like "splash", "loading", "welcome", "project", give it **additional wait time** (up to 8s) for the main window to appear before declaring failure or running popup recipes.

#### 5B. Include Untitled Windows in App-Context Scans
**File:** `src/main/ui-watcher.js`  
**Change:** When `getContextForAI()` renders elements, call `findWindows` with `includeUntitled: true` for the specific process currently focused. This surfaces palette/panel windows that the AI can then reference by handle or position.

#### 5C. Add `list_windows` Action Type
**File:** `src/main/system-automation.js` + `src/main/ai-service/system-prompt.js`  
**Change:** New action type that returns all windows for a process (including floating/untitled):
```json
{"type": "list_windows", "processName": "MPC"}
```
Returns array of window info (title, handle, bounds, type flags). The AI can use this to reason about which window to target.

---

## Testing Strategy

### New Test Scripts
1. **`scripts/test-window-metadata.js`** — Tests enriched `findWindows()` output schema (isToolWindow, isTopmost, ownerHwnd fields present)
2. **`scripts/test-window-scoring.js`** — Tests `scoreWindowMatch()` prefers main windows over palettes
3. **`scripts/test-expanded-process-names.js`** — Tests `withInferredProcessName()` and `buildProcessCandidatesFromAppName()` for new app mappings

### Existing Test Suite Regression
All 67 existing tests must continue passing. Run the full suite after each phase:
```
node scripts/test-ai-service-provider-orchestration.js
node scripts/test-ai-service-contract.js
node scripts/test-ai-service-model-registry.js
node scripts/test-v006-features.js
node scripts/test-bug-fixes.js
node scripts/test-smart-browser-click.js
node scripts/test-ai-service-state.js
node scripts/test-ai-service-response-heuristics.js
```

---

## Implementation Order & Dependencies

```
Phase 1A (findWindows enrichment)
    ↓
Phase 1B (resolveWindowHandle scoring) ← depends on 1A
    ↓
Phase 2A (UI Watcher getContextForAI enrichment) ← depends on 1A
Phase 2B (system prompt multi-window policy) ← independent, can parallel with 2A
    ↓
Phase 3A (withInferredProcessName expansion) ← independent
Phase 3B (buildProcessCandidatesFromAppName expansion) ← independent
    ↓
Phase 4A (auto-detect blocking topmost) ← depends on 1A
Phase 4B (owned-window following) ← depends on 1A
    ↓
Phase 5A-5C (resilience) ← depends on all above
```

---

## Risk Assessment

| Change | Risk | Mitigation |
|--------|------|------------|
| Enriched findWindows() | LOW — additive schema | Existing consumers ignore new fields |
| Window scoring in resolveWindowHandle() | MEDIUM — changes which window is selected | Score-based selection only for multi-match; single-match unchanged |
| UI Watcher enrichment | LOW — additive text in Live UI State | Tags are informational; AI behavior change is via prompt |
| System prompt additions | LOW — additive instructions | No existing behavior removed |
| withInferredProcessName expansion | LOW — fallback path only | Only fires when processName is missing |
| Topmost detection before click | MEDIUM — adds latency | Skip check when no topmost windows exist (fast path) |

---

## Version Bump

After implementation, bump version to **0.0.14** in `package.json` with changelog entry:
```
## v0.0.14 — Multi-Window & Floating Panel Awareness
- Enriched window metadata (tool windows, topmost, owner chain, modal detection)
- Smart window scoring: prefers main windows over floating palettes for multi-match
- AI sees window topology in Live UI State ([MAIN], [PALETTE], [MODAL], [TOPMOST] tags)
- Multi-Window Application Awareness policy in system prompt
- Expanded app vocabulary: 20+ professional/creative apps for process inference
- Auto-detection of blocking topmost windows before coordinate clicks
- Splash screen tolerance in post-launch verification
- Untitled window inclusion for focused process in AI context
```
