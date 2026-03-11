# Gaming With AI (Copilot-Liku) — Implementation Plan

> **Forward-looking brainstorm**: This document explores gaming-oriented AI workflows using Liku's verification primitives.



















































































































































































































If settle never happens (common in games): switch to ROI stability in M1.- `liku verify-stable --metric dhash --epsilon 4 --stable-ms 400 --timeout 4000 --interval 100 --json`3) Settle:- `liku verify-hash --timeout 2000 --interval 100 --json`2) Must-change:- `liku keys e`1) Invoke:## Appendix: Example “Action → Settle” Pattern (CLI-only)---   - what metrics matter? (time-to-complete, failure rate, recovery success)4. Evaluation:   - how do we enforce “assistive teaching” vs “autonomous play” modes?3. Control boundaries:   - do we want OCR first, template matching, or a lightweight state classifier?2. Semantic verification:   - overlay-driven ROI pick? typed coordinates? inspect-mode derived regions?1. ROI selection UX:## Open Questions (for next iteration)   - critical for composing workflows and external orchestration5. **Keep logs machine-readable under `--json`**   - enabled-state is the cleanest “clickable now” indicator4. **Prefer UIA conditions for timers**   - use ROI stability (or semantic state) instead3. **Don’t chase full-frame stability in games**   - derive dynamic N from `stable-ms / interval`2. **Tune by time windows, not fixed poll counts**   - must-change gate vs settle gate1. **Always separate “did it start?” from “did it finish?”**## Best Practices / Lessons Learned (for later drill-down)- Fall back to ROI visual verification for in-game overlays.- Prefer `wait --enabled` and `find` for those flows.Plan:Some launchers or menus may expose UIA even if the main renderer doesn’t.### M4 — UIA/vision hybrid for menus (when games expose UIA)  - common verification prompts  - keybind mappings  - default ROIs (e.g., top-left quest log, center dialogue area)  - window targeting hints- Create per-game profiles:Plan:Goal: encode game-specific heuristics without overfitting.### M3 — “Prompt libraries” per game (lightweight)- Reuse/extend the existing agent trace infrastructure (see `src/main/agents/trace-writer.js` and related agent modules).  - recovery steps  - verification policy (must-change + settle; ROI; UIA conditions)  - action (keys/click/etc.)- Introduce an internal trace schema:Plan:Goal: record “what user did” + “how we know it worked.”### M2 — Teach-by-demonstration traces- The overlay already has concepts of regions/inspect mode; later we can use it to pick ROIs.- `src/main/ui-automation/screenshot.js` already supports region capture.Where this is grounded:- Wire ROI → `ui.screenshot({ region: {x,y,width,height}, memory: true, base64: false, metric: 'dhash' })`.- Add ROI parameters (`--roi x,y,w,h` or similar) to `verify-stable`.Plan:Problem: full-frame stability can fail forever (particle effects, animated HUD).### M1 — ROI-based stability (high leverage for games)- Example playbooks for 1–2 games (manual docs), using only CLI.Deliverables:  - `wait --enabled` (opportunity)  - `verify-stable` (settled)  - `verify-hash` (must-change)- Standardize game workflows around:Goal: prove the loop works without adding new model types.### M0 — Use existing primitives to teach reliably## Implementation Milestones (Concrete and Incremental)- **Tier 3:** learned “state classifier” (menu open, dialogue, combat, etc.)- **Tier 2:** OCR / template matching for known prompts- **Tier 1:** ROI-only stability (reduce false instability from HUD animations)- **Tier 0 (today):** active-window + (d)hash stability gatesStart simple and expand:### Signal fusion strategy   - Retry with a fallback candidate, back out to prior state, or ask user.7. **RECOVER**   - Use the correct wait type (transition vs opportunity vs cooldown).6. **VERIFY**   - Execute action (`keys`, `click`, `drag`, `scroll`).5. **INVOKE**     - prompt text match, expected icon/shape, screen location priors   - Deterministic ranking:4. **SCORE**   - Else: capture frame(s), optionally in an ROI.   - If UIA works: `liku find ...` / `liku wait ...`3. **ENUMERATE**   - Confirm active window is correct (`liku window --active`).2. **ASSERT**   - Ensure the intended game window is foreground (`liku window --front ...`).1. **FOCUS**Use a consistent loop aligned with current `doctor` plan semantics:### Core loop (state-machine)## Proposed Architecture (Grounded in Existing Patterns)- Later, AI can reproduce the workflow (still gated by verification).- User performs actions while AI observes and builds a “lesson” (intent + verification cues).3) **Demonstration Mode (record + replay)**- AI can execute low-risk actions (e.g., open menu, navigate UI) with confirmation.2) **Assist Mode**- Optional: highlights target region (overlay) and proposes action.- AI explains what to do next and why.1) **Coach Mode (default)**The system should support at least three modes:## Teaching-Oriented Interaction Model- For robustness, prefer verifying the “cooldown ended” via UIA enabled-state OR via a HUD indicator.- `sleep`-style waits may be acceptable IF the game is known to enforce exact timers.This is best handled as an explicit “cooldown policy,” not screen stability:### C) Cooldown wait (must wait X seconds before next action)- Then verify with either UIA change or visual change.  - `liku click "Some Button" --type Button`- Then invoke immediately:  - `liku wait "Some Button" 5000 --enabled --type Button --json`- Prefer **UIA-first** detection when possible:This is **not** a stability problem.### B) Opportunity window (timer button / short-lived clickable state)- Settle: `liku verify-stable --metric dhash --epsilon 4 --stable-ms 800 --timeout 15000 --interval 250 --json`- Must-change: `liku verify-hash --timeout 8000 --interval 250 --json`Concrete CLI pattern (today):2) **Settle/stable**: once changing, wait until it stabilizes for a minimum window.1) **Must-change**: verify something changed after your action (prevents false positives).Use a two-phase gate:### A) Transition wait (action → rendering changes)Gaming workflows involve *different kinds of waits*.## Problem Breakdown: “Gaming With AI” Waiting + Verification- Region detection is invoked post-capture (and can update overlay regions).- Inspect mode exists in the Electron app (see `toggle-inspect-mode` IPC and inspect service calls in `src/main/index.js`).### Inspect mode and region detection hooks  - `LIKU_ACTIVE_WINDOW_STREAM_START_DELAY_MS`  - `LIKU_ACTIVE_WINDOW_STREAM_INTERVAL_MS`  - `LIKU_ACTIVE_WINDOW_STREAM=1`- Optional always-on **active-window streaming** exists (env-driven):- A `get-state` IPC handler exists and returns `visualContextCount` (and other flags), enabling “pollable state” in the Electron context.- The Electron main process (`src/main/index.js`) stores visual frames in a bounded history (see `visualContextHistory` / `MAX_VISUAL_CONTEXT_ITEMS`).### Electron agent: bounded visual context + state  - `liku verify-stable` (wait until frame is stable for a dynamic N derived from `--stable-ms` and `--interval`)  - `liku verify-hash` (wait until frame hash changes)- Pollable verification commands:  - **optional base64 suppression** for faster polling loops  - **dHash** (perceptual) for robust stability detection  - **SHA-256 hash** for exact-change detection  - **memory-only** capture: no PNG written- The screenshot system now supports:- UI screenshot capture is implemented in `src/main/ui-automation/screenshot.js`.### Ephemeral visual capture + polling primitives  - Example: `liku wait "Submit" 5000 --type Button --enabled --json`- `liku wait` now supports `--enabled` for timer-window interactions:- UIA element search supports an enabled-state filter (`isEnabled`) in `src/main/ui-automation/elements/finder.js`.- UI Automation implementation lives under `src/main/ui-automation/`.  - `click`, `find`, `type`, `keys`, `window`, `mouse`, `drag`, `scroll`, `wait`, `screenshot`- CLI commands exist under `src/cli/commands/`:### CLI-driven UI automation (Windows)## Codebase Truth: What We Have Today   - Keep a clear boundary: “assistive teaching” vs “autonomous gameplay.”   - Avoid features that resemble automation/cheating in competitive multiplayer.5. **Safety + scope controls**   - Build verification as a reusable capability with multiple signals.   - In games, “success” is often a screen change, HUD change, or a known prompt.4. **Verification is a first-class primitive**   - The system must work in both worlds.   - Many games (and browser-rendered content) won’t expose useful UIA elements.3. **Prefer UIA when available; fall back to vision**   - Prefer **pollable verification gates** over ad-hoc sleeps.   - Use consistent state-machine patterns (focus → enumerate → score → invoke → verify → recover).2. **Deterministic loops over brittle input spam**   - The AI should *recommend*, *explain*, and *verify*, then optionally *execute* with explicit consent.   - “Teaching” implies the user remains the primary actor.1. **User-in-the-loop by default**## Principles- **Purpose later:** iterate and drill down into specifics (ROI selection, game-specific heuristics, evaluation, UX).- **Purpose now:** capture high-level ideas + best practices + concrete next steps that match **what the repo can actually do today**.This document is a **comprehensive, grounded plan** for adding “video game teaching” workflows to Copilot-Liku.
This document is a **comprehensive, grounded plan** for adding “video game teaching” workflows to Copilot-Liku.

- **Purpose now:** capture high-level ideas + best practices + concrete next steps that match **what the repo can actually do today**.
- **Purpose later:** iterate and drill down into specifics (ROI selection, game-specific heuristics, evaluation, UX).

## Principles

1. **User-in-the-loop by default**
   - “Teaching” implies the user remains the primary actor.
   - The AI should *recommend*, *explain*, and *verify*, then optionally *execute* with explicit consent.

2. **Deterministic loops over brittle input spam**
   - Use consistent state-machine patterns (focus → enumerate → score → invoke → verify → recover).
   - Prefer **pollable verification gates** over ad-hoc sleeps.

3. **Prefer UIA when available; fall back to vision**
   - Many games (and browser-rendered content) won’t expose useful UIA elements.
   - The system must work in both worlds.

4. **Verification is a first-class primitive**
   - In games, “success” is often a screen change, HUD change, or a known prompt.
   - Build verification as a reusable capability with multiple signals.

5. **Safety + scope controls**
   - Avoid features that resemble automation/cheating in competitive multiplayer.
   - Keep a clear boundary: “assistive teaching” vs “autonomous gameplay.”

## Codebase Truth: What We Have Today

### CLI-driven UI automation (Windows)
- CLI commands exist under `src/cli/commands/`:
  - `click`, `find`, `type`, `keys`, `window`, `mouse`, `drag`, `scroll`, `wait`, `screenshot`
- UI Automation implementation lives under `src/main/ui-automation/`.
- UIA element search supports an enabled-state filter (`isEnabled`) in `src/main/ui-automation/elements/finder.js`.
- `liku wait` now supports `--enabled` for timer-window interactions:
  - Example: `liku wait "Submit" 5000 --type Button --enabled --json`

### Ephemeral visual capture + polling primitives
- UI screenshot capture is implemented in `src/main/ui-automation/screenshot.js`.
- The screenshot system now supports:
  - **memory-only** capture: no PNG written
  - **SHA-256 hash** for exact-change detection
  - **dHash** (perceptual) for robust stability detection
  - **optional base64 suppression** for faster polling loops
- Pollable verification commands:
  - `liku verify-hash` (wait until frame hash changes)
  - `liku verify-stable` (wait until frame is stable for a dynamic N derived from `--stable-ms` and `--interval`)

### Electron agent: bounded visual context + state
- The Electron main process (`src/main/index.js`) stores visual frames in a bounded history (see `visualContextHistory` / `MAX_VISUAL_CONTEXT_ITEMS`).
- A `get-state` IPC handler exists and returns `visualContextCount` (and other flags), enabling “pollable state” in the Electron context.
- Optional always-on **active-window streaming** exists (env-driven):
  - `LIKU_ACTIVE_WINDOW_STREAM=1`
  - `LIKU_ACTIVE_WINDOW_STREAM_INTERVAL_MS`
  - `LIKU_ACTIVE_WINDOW_STREAM_START_DELAY_MS`

### Inspect mode and region detection hooks
- Inspect mode exists in the Electron app (see `toggle-inspect-mode` IPC and inspect service calls in `src/main/index.js`).
- Region detection is invoked post-capture (and can update overlay regions).

## Problem Breakdown: “Gaming With AI” Waiting + Verification

Gaming workflows involve *different kinds of waits*.

### A) Transition wait (action → rendering changes)
Use a two-phase gate:
1) **Must-change**: verify something changed after your action (prevents false positives).
2) **Settle/stable**: once changing, wait until it stabilizes for a minimum window.

Concrete CLI pattern (today):
- Must-change: `liku verify-hash --timeout 8000 --interval 250 --json`
- Settle: `liku verify-stable --metric dhash --epsilon 4 --stable-ms 800 --timeout 15000 --interval 250 --json`

### B) Opportunity window (timer button / short-lived clickable state)
This is **not** a stability problem.
- Prefer **UIA-first** detection when possible:
  - `liku wait "Some Button" 5000 --enabled --type Button --json`
- Then invoke immediately:
  - `liku click "Some Button" --type Button`
- Then verify with either UIA change or visual change.

### C) Cooldown wait (must wait X seconds before next action)
This is best handled as an explicit “cooldown policy,” not screen stability:
- `sleep`-style waits may be acceptable IF the game is known to enforce exact timers.
- For robustness, prefer verifying the “cooldown ended” via UIA enabled-state OR via a HUD indicator.

## Teaching-Oriented Interaction Model

The system should support at least three modes:

1) **Coach Mode (default)**
- AI explains what to do next and why.
- Optional: highlights target region (overlay) and proposes action.

2) **Assist Mode**
- AI can execute low-risk actions (e.g., open menu, navigate UI) with confirmation.

3) **Demonstration Mode (record + replay)**
- User performs actions while AI observes and builds a “lesson” (intent + verification cues).
- Later, AI can reproduce the workflow (still gated by verification).

## Proposed Architecture (Grounded in Existing Patterns)

### Core loop (state-machine)
Use a consistent loop aligned with current `doctor` plan semantics:

1. **FOCUS**
   - Ensure the intended game window is foreground (`liku window --front ...`).
2. **ASSERT**
   - Confirm active window is correct (`liku window --active`).
3. **ENUMERATE**
   - If UIA works: `liku find ...` / `liku wait ...`
   - Else: capture frame(s), optionally in an ROI.
4. **SCORE**
   - Deterministic ranking:
     - prompt text match, expected icon/shape, screen location priors
5. **INVOKE**
   - Execute action (`keys`, `click`, `drag`, `scroll`).
6. **VERIFY**
   - Use the correct wait type (transition vs opportunity vs cooldown).
7. **RECOVER**
   - Retry with a fallback candidate, back out to prior state, or ask user.

### Signal fusion strategy
Start simple and expand:

- **Tier 0 (today):** active-window + (d)hash stability gates
- **Tier 1:** ROI-only stability (reduce false instability from HUD animations)
- **Tier 2:** OCR / template matching for known prompts
- **Tier 3:** learned “state classifier” (menu open, dialogue, combat, etc.)

## Implementation Milestones (Concrete and Incremental)

### M0 — Use existing primitives to teach reliably
Goal: prove the loop works without adding new model types.
- Standardize game workflows around:
  - `verify-hash` (must-change)
  - `verify-stable` (settled)
  - `wait --enabled` (opportunity)

Deliverables:
- Example playbooks for 1–2 games (manual docs), using only CLI.

### M1 — ROI-based stability (high leverage for games)
Problem: full-frame stability can fail forever (particle effects, animated HUD).

Plan:
- Add ROI parameters (`--roi x,y,w,h` or similar) to `verify-stable`.
- Wire ROI → `ui.screenshot({ region: {x,y,width,height}, memory: true, base64: false, metric: 'dhash' })`.

Where this is grounded:
- `src/main/ui-automation/screenshot.js` already supports region capture.
- The overlay already has concepts of regions/inspect mode; later we can use it to pick ROIs.

### M2 — Teach-by-demonstration traces
Goal: record “what user did” + “how we know it worked.”

Plan:
- Introduce an internal trace schema:
  - action (keys/click/etc.)
  - verification policy (must-change + settle; ROI; UIA conditions)
  - recovery steps
- Reuse/extend the existing agent trace infrastructure (see `src/main/agents/trace-writer.js` and related agent modules).

### M3 — “Prompt libraries” per game (lightweight)
Goal: encode game-specific heuristics without overfitting.

Plan:
- Create per-game profiles:
  - window targeting hints
  - default ROIs (e.g., top-left quest log, center dialogue area)
  - keybind mappings
  - common verification prompts

### M4 — UIA/vision hybrid for menus (when games expose UIA)
Some launchers or menus may expose UIA even if the main renderer doesn’t.

Plan:
- Prefer `wait --enabled` and `find` for those flows.
- Fall back to ROI visual verification for in-game overlays.

## Best Practices / Lessons Learned (for later drill-down)

1. **Always separate “did it start?” from “did it finish?”**
   - must-change gate vs settle gate

2. **Tune by time windows, not fixed poll counts**
   - derive dynamic N from `stable-ms / interval`

3. **Don’t chase full-frame stability in games**
   - use ROI stability (or semantic state) instead

4. **Prefer UIA conditions for timers**
   - enabled-state is the cleanest “clickable now” indicator

5. **Keep logs machine-readable under `--json`**
   - critical for composing workflows and external orchestration

## Open Questions (for next iteration)

1. ROI selection UX:
   - overlay-driven ROI pick? typed coordinates? inspect-mode derived regions?

2. Semantic verification:
   - do we want OCR first, template matching, or a lightweight state classifier?

3. Control boundaries:
   - how do we enforce “assistive teaching” vs “autonomous play” modes?

4. Evaluation:
   - what metrics matter? (time-to-complete, failure rate, recovery success)

---

## Appendix: Example “Action → Settle” Pattern (CLI-only)

1) Invoke:
- `liku keys e`

2) Must-change:
- `liku verify-hash --timeout 2000 --interval 100 --json`

3) Settle:
- `liku verify-stable --metric dhash --epsilon 4 --stable-ms 400 --timeout 4000 --interval 100 --json`

If settle never happens (common in games): switch to ROI stability in M1.
