# Agentic Skills, Tool Use, and Context Model

This document is the reference map for the current Liku agentic workflow before any flattened XML/JSON/LISP serialization redesign. The goal is to preserve the runtime contracts that make computer-use actions safe: scoped intent, tool authority, window state, UI watcher proof, TradingView overlays, and action-result traces.

## Current Runtime Model

### Skills and Intent

Skills are local instruction bundles loaded from `SKILL.md` files. They are selected by explicit mention or task fit, then applied as bounded workflow guidance. A skill is not an action executor by itself. It shapes planning, tool choice, and safety constraints.

The active user request is converted into an execution context envelope with:

- task family, such as `tradingview`, repository work, browser work, or shell work
- foreground application signals
- explicit and inferred domain intent
- continuity and compartment keys
- eligibility gates for high-risk workflows such as TradingView Pine authoring

This context decides whether a workflow can be rewritten into a safer domain route, whether confirmation is required, and whether prior state can be reused.

### Memory and Continuity

Memory is layered:

- short-lived turn context from the current request
- session intent state for continuity across actions
- episodic history and learned action workflow candidates
- proof traces and transcript regression fixtures
- external IDE or Copilot memory files supplied by the user

Continuity must stay scoped. A Pine Editor action may reuse TradingView foreground and proof state, but it must not inherit unrelated browser, shell, or editor assumptions.

### Tool Sandboxing and Authority

Tools are separated by authority:

- shell and filesystem tools operate in the local workspace
- UIA and watcher paths observe and focus applications
- automation actions perform foreground input
- model/reflection calls summarize or evaluate but must not substitute for UI proof

Synthetic tests disable reflection with `LIKU_DISABLE_REFLECTION=1` and default reflection routing to `gpt-4o` to avoid token-heavy loops. Reflection is telemetry and learning support, not a precondition for action safety.

### Action Execution

The intended computer-use order is:

1. Resolve/open/focus the target application through UIA/window handles.
2. Verify the foreground target and relevant UI surface with watcher/UIA evidence.
3. Execute the bounded action.
4. Verify the post-action state before continuing to dependent actions.

Input actions are focus-locked to the last trusted target window. Stale handles are re-resolved before keyboard input. TradingView main-window focus must not be satisfied by unrelated popups unless the workflow explicitly targets an owned/palette surface.

### Proof Traces

Each action should carry bounded proof:

- execution result
- focus lock status
- observation checkpoint, if applicable
- domain proof eligibility
- watcher/UIA anchors
- foreground window identity
- limitations and failure reason

Failures should surface the specific failed proof, not only a generic action failure. Confirmation resumes must rebuild prerequisites and proof state before destructive continuation.

### UI Watcher State

The watcher provides a cached foreground window and visible element list. It is evidence, not authority by itself. Strong watcher evidence can prove a TradingView Pine surface when anchors such as `Add to chart`, `Publish script`, `Pine Logs`, or `Strategy Tester` are visible in the trusted TradingView window.

Watcher evidence must preserve:

- freshness
- active window handle, process, title, kind
- element names/types/window handles
- matched anchor
- whether the proof came from watcher, UIA text, semantic click, keyboard selection, or foreground title

### TradingView Domain Overlay

TradingView workflows add domain contracts on top of generic automation:

- quick-search opening and clearing
- Pine Editor activation
- safe Pine authoring inspection
- last-worked-script awareness: TradingView normally reopens the most recent Pine script from account cloud storage when Pine Editor is opened
- non-overwrite gates for existing visible scripts unless an explicit overwrite request or a verified fresh-indicator/new-copy path is present
- save and add-to-chart lifecycle verification
- bounded fallback for sparse open-state only when explicitly allowed

Quick-search replacement must prove stale text is empty before typing. If post-type readback does not match, semantic UIA repair may set the exact query only after the input was already proven empty or already matched the expected query. Enter is blocked unless the query or target Pine surface is proven.

For create-new Pine authoring, visible stale code is not proof of corruption by itself. It is an expected TradingView state. The workflow must still stop before replacing that buffer unless it can prove a fresh starter surface, a new-copy/save-as title flow, or an explicit user overwrite intent. In the TradingView desktop Pine Editor, the preferred source-of-truth path is the official Pine command sequence `Ctrl+K`, then `Ctrl+I`, followed by safe-authoring inspection that verifies the default starter (`indicator("My script")` / `plot(close)`) before any generated script paste. A future flattened representation must keep this distinction because `existing-script-visible` means "expected but unsafe to continue automatically", not "Pine Editor failed to open".

## Flattened Hybrid Representation Requirements

A future XML/JSON/LISP hybrid representation may compress the model, but it must preserve these invariants:

- Compactness: repeated app/profile/shortcut metadata can be referenced by id.
- Hierarchy: actions, checkpoints, continuations, and confirmations must remain nested enough to reconstruct execution order.
- Provenance: every inferred action must identify source request, rewrite rule, skill, profile, or recovery path.
- Scope: foreground app, task family, compartment key, and domain eligibility must stay explicit.
- Window state: handles, process names, window kinds, owner relationships, and stale-handle recovery must be representable.
- Proof state: preconditions, postconditions, watcher anchors, UIA reads, focus locks, failures, and limitations must survive serialization.
- Tool/action contracts: each action must retain executor type, risk level, confirmation requirement, allowed fallback, and stop conditions.
- Continuation gates: state-based continuation maps must distinguish safe states from hard-stop states.
- Confirmation resumes: pending actions must carry resume prerequisites and proof obligations, not only the paused command.
- Token budget: verbose observations should be collapsible to stable ids plus short evidence excerpts.

## Suggested Shape

Use a flat event stream with typed records and parent references:

```json
{
  "id": "act:10",
  "parent": "plan:pine-open",
  "type": "action",
  "verb": "key",
  "key": "enter",
  "scope": "tradingview:pine-editor",
  "requires": ["proof:quick-search-query"],
  "produces": ["proof:pine-editor-active"],
  "fallback": ["semantic-click", "keyboard-selection"],
  "stopOnFailure": true
}
```

Use symbolic forms for compact policy expressions:

```lisp
(gate pine-authoring
  (when editor-state empty-or-starter continue save-flow)
  (when editor-state existing-script-visible route requires-fresh-indicator-or-overwrite-proof))
```

Use XML-like boundaries only for long text or mixed provenance:

```xml
<evidence id="proof:pine-editor-active" source="watcher" hwnd="777">
  <anchor>Add to chart</anchor>
  <limit>No screenshot loop required.</limit>
</evidence>
```

The serialized form is acceptable only if it can be expanded back into the current action, proof, watcher, and TradingView safety model without losing these contracts.
