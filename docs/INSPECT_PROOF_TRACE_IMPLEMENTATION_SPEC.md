# Inspect, proof, and trace implementation spec

Status: partially implemented (first inspect/proof/trace slice landed 2026-04-05)  
Scope: local runtime reliability and evaluation platformization  
Grounded inputs:

- `docs/BRAINSTORM_GROUNDED_ANALYSIS.md`
- `src/main/inspect-service.js`
- `src/shared/inspect-types.js`
- `src/main/ai-service/message-builder.js`
- `src/main/ai-service/actions/parse.js`
- `src/main/ai-service.js`
- `src/main/system-automation.js`
- `src/main/agents/trace-writer.js`
- `scripts/extract-transcript-regression.js`
- `scripts/run-transcript-regressions.js`
- `scripts/test-inspect-types.js`
- `scripts/test-transcript-regression-pipeline.js`

## Implementation status snapshot (2026-04-05)

The first production slice of this spec is now landed.

Implemented in code:

- inspect instructions are injected as a system message in `message-builder.js`
- inspect snapshots now surface stable region IDs and selected region IDs to the model
- `inspect-service.js` exposes `getRegionById(...)`, `getSnapshot()`, and `resolveTarget(...)`
- `system-automation.js` resolves `targetId` for click-like actions and returns `resolvedTarget` plus bounded proof
- `ai-service.js` upgrades observation checkpoints into canonical `result.proof`
- runtime action/proof JSONL events are emitted via `src/main/traces/runtime-trace-log.js`
- transcript regression fixtures now support `traceMeta`, `actions`, and `proofExpectations`
- `scripts/extract-runtime-trace-regression.js` converts runtime trace JSONL into checked-in fixture bundles

Still pending from the broader roadmap:

- stronger low-confidence runtime guardrails for mutating inspect actions
- broader non-click target grounding beyond the current first slice
- deeper TradingView/domain-verification uplift to `level=3`
- more checked-in runtime-trace-derived regression fixtures from real sessions

## 1. Why this spec exists

Liku already has most of the architectural pieces people usually ask for:

- inspect/overlay region discovery
- coordinate-space contracts
- action parsing and execution
- observation checkpoints
- TradingView-specific verification
- trace and telemetry logging
- transcript regression fixtures

The missing piece is not architecture in the abstract. It is the end-to-end contract between:

1. what the model sees
2. what target the executor actually uses
3. what proof the runtime can produce after acting
4. what artifact can later be replayed as a regression

Today that chain is only partially wired.

### Current codebase truth

The repo already contains the right primitives:

- `src/shared/inspect-types.js` defines `InspectRegion`, `WindowContext`, and `ActionTrace`, including `targetId`, `clickPoint`, and `runtimeId`.
- `src/main/inspect-service.js` tracks regions, selected region, window context, recent actions, and has a `generateAIInstructions()` helper.
- `src/main/ai-service/message-builder.js` now injects `generateAIInstructions()` as a system message and includes inspect region IDs in prompt context.
- `src/main/system-automation.js` now resolves `targetId` for click-like actions, attaches `resolvedTarget`, and returns bounded execution proof.
- `src/main/ai-service.js` merges observation checkpoint output into canonical `result.proof` and emits runtime action/proof traces.
- `src/main/agents/trace-writer.js` still persists orchestrator events; runtime action traces now live beside that path in `src/main/traces/runtime-trace-log.js`.
- `scripts/extract-transcript-regression.js`, `scripts/extract-runtime-trace-regression.js`, and `scripts/run-transcript-regressions.js` now provide both transcript and proof-aware regression plumbing.

## 2. Problem statement

Three important gaps remain.

### Gap A — inspect grounding is descriptive, not authoritative

Inspect mode can tell the model that regions exist, but there is no fully enforced runtime rule that says:

- a model may reference `targetId`
- the executor must resolve that `targetId`
- stale or mismatched targets fail closed
- action results report which target was actually used

### Gap B — proof exists in pockets, not as a platform contract

There is already verification logic, especially in TradingView flows and observation checkpoints. But proof is not yet a universal action result contract.

### Gap C — traces exist, but not as replayable runtime evidence

Liku already stores:

- orchestrator traces
- telemetry
- transcript fixtures

But it does not yet persist a standardized chain of:

`prompt -> parsed actions -> resolved target -> proof -> outcome`

That chain is what turns runtime behavior into regression assets.

## 3. Goals

This spec defines a concrete path to:

1. make inspect-grounded actions first-class and fail-closed
2. attach proof artifacts to all meaningful actions
3. turn runtime traces into reusable regression fixtures
4. preserve backward compatibility with existing coordinate-based action flows
5. build a generic base layer that TradingView-specific verification can extend

## 4. Non-goals

This spec does **not** attempt to:

- redesign the entire AI service
- replace existing TradingView hardening
- require cloud sync or centralized storage
- make `runtimeId` stable across app restarts or machines
- replace transcript regressions with a completely separate system overnight
- solve future binary market-data serialization here

## 5. Proposed runtime contracts

## 5.1 Action request contract

The action schema remains backward compatible. Existing coordinate actions still work.

New rule: actions may optionally carry `targetId`, and when they do, the runtime treats that as authoritative target intent.

```json
{
  "type": "click",
  "reason": "Open Pine Editor",
  "targetId": "region-1712345678901-abc123",
  "x": 1442,
  "y": 911,
  "allowCoordinateFallback": false,
  "verification": {
    "required": "target",
    "expectedEffect": "surface-opened"
  }
}
```

Interpretation rules:

- `targetId` is optional for backward compatibility.
- If `targetId` is present, `x/y` become advisory fallback data, not the source of truth.
- `allowCoordinateFallback` defaults to `false` for mutating actions when `targetId` is present.
- `verification.required` is optional and may be one of:
  - `none`
  - `target`
  - `effect`
  - `domain`

## 5.2 Resolved target contract

The runtime enriches actions with a resolved target record before executing them.

```json
{
  "targetId": "region-1712345678901-abc123",
  "resolutionMethod": "runtimeId",
  "resolvedPoint": { "x": 1444, "y": 913 },
  "resolvedBounds": { "x": 1410, "y": 880, "width": 68, "height": 52 },
  "runtimeId": [42, 7, 13],
  "clickPoint": { "x": 1444, "y": 913 },
  "window": {
    "appName": "TradingView",
    "windowTitle": "BTCUSD - TradingView",
    "pid": 1234
  },
  "regionConfidence": 0.93,
  "observedAt": 1712345678901,
  "freshnessMs": 412,
  "stale": false
}
```

Resolution method enum:

- `runtimeId`
- `clickPoint`
- `bounds-center`
- `explicit-coordinates`
- `semantic-fallback`

## 5.3 Action proof contract

Every executed action should return a proof record, even if the proof is weak.

```json
{
  "proofId": "proof-1712345679999-k9j3m2",
  "actionType": "click",
  "level": 2,
  "levelName": "effect-verified",
  "status": "verified",
  "claim": "Pine Editor was opened",
  "checks": [
    {
      "kind": "foreground-window",
      "status": "pass",
      "expected": "TradingView",
      "observed": "TradingView"
    },
    {
      "kind": "target-resolution",
      "status": "pass",
      "method": "runtimeId",
      "targetId": "region-1712345678901-abc123"
    },
    {
      "kind": "postcondition",
      "status": "pass",
      "observed": "Pine Editor visible"
    }
  ],
  "limitations": [],
  "boundedClaims": [
    "This verifies surface access, not trading correctness."
  ]
}
```

Proof levels:

- `0 executed` — the OS/API call did not throw, but no strong target/effect proof exists
- `1 target-grounded` — the runtime resolved and executed against a specific inspect target or equivalent semantic target
- `2 effect-verified` — a postcondition check succeeded
- `3 domain-verified` — effect plus domain-specific verification succeeded (for example TradingView-specific bounded verification)

## 5.4 Trace event contract

Runtime trace events should be append-only JSONL and cheap to write.

```json
{
  "ts": "2026-04-05T22:41:10.123Z",
  "session": "session-1712345678-abc123",
  "event": "action:complete",
  "action": {
    "type": "click",
    "reason": "Open Pine Editor",
    "targetId": "region-1712345678901-abc123"
  },
  "resolvedTarget": {
    "resolutionMethod": "runtimeId",
    "targetId": "region-1712345678901-abc123"
  },
  "proof": {
    "level": 2,
    "status": "verified"
  },
  "success": true,
  "durationMs": 812
}
```

## 6. Detailed design

## 6.1 Phase 1 — inspect-grounded targeting

### 6.1.1 Prompt wiring

#### Current truth

- `inspect-service.generateAIInstructions()` exists.
- `message-builder.js` currently calls `inspect.generateAIContext()`.
- inspect data is appended as free-form text into the user message.
- `generateAIInstructions()` is not injected into the prompt.

#### Required change

`src/main/ai-service/message-builder.js` should:

1. call `inspect.generateAIInstructions()` and add the result as a **system** message
2. continue to include a compact inspect snapshot
3. include region IDs explicitly, not just labels and coordinates
4. include selected region ID when present
5. explicitly tell the model to prefer `targetId` over raw coordinates when inspect mode is active

Recommended system block shape:

```text
## Inspect Mode Active
- Prefer targetId-based actions when an inspect region is available.
- If targetId is present, coordinates are advisory only.
- If confidence < 0.70 for a mutating action, ask for confirmation or choose a safer read-first step.
```

Recommended snapshot block shape:

```text
## Inspect Snapshot
1. id=region-... label="Pine Editor" role=tab center=(1444,913) confidence=93%
2. id=region-... label="Publish" role=button center=(1711,911) confidence=88%
selectedRegionId=region-...
activeWindow=TradingView
```

This keeps the model-facing contract simple while remaining grounded in existing code.

### 6.1.2 Target resolution in the runtime

#### Current truth

- `InspectRegion` already includes `id`, `clickPoint`, `runtimeId`, and bounds.
- `system-automation.executeAction(...)` currently dispatches by action type.
- `ai-service.js` already tracks `lastTargetWindowHandle` and performs some focus recovery.

#### Required change

Before executing any action that can target a UI element, the runtime should attempt `targetId` resolution.

Applies to at least:

- `click`
- `double_click`
- `right_click`
- `move_mouse`
- `type`
- `key`
- `set_value`
- `scroll_element`
- `expand_element`
- `collapse_element`
- `get_text`
- element-scoped screenshots

#### Resolution order

If `action.targetId` is present:

1. load the current inspect snapshot
2. find region by ID
3. fail with `TARGET_NOT_FOUND` if missing
4. compute `freshnessMs = now - region.timestamp`
5. if stale beyond a threshold, attempt a refresh or fail with `TARGET_STALE`
6. if `runtimeId` exists, try live re-resolution through UI Automation
7. otherwise use `clickPoint` if available
8. otherwise use the center of the current bounds
9. only use explicit `x/y` if `allowCoordinateFallback === true`
10. attach `resolvedTarget` to the execution result

Recommended default freshness threshold:

- `3000ms` general default
- allow tighter thresholds later for known high-churn surfaces

### 6.1.3 Window and focus validation

If inspect data includes window context, the runtime should verify window compatibility before sending focus-sensitive input.

Minimum checks:

- expected app name matches foreground app, or
- expected PID matches foreground PID, or
- expected title is a strong match

Behavior:

1. if mismatch, attempt focus recovery
2. re-check foreground window
3. if still mismatched, fail with `WINDOW_MISMATCH`
4. downgrade proof if a coordinate fallback was required after mismatch recovery

This builds directly on existing `focusWindow(...)`, foreground info helpers, and `lastTargetWindowHandle` behavior.

### 6.1.4 Confidence guardrails

The current inspect instructions already say low-confidence clicks should be verified with the user.

That should become a runtime rule for mutating actions.

Recommended rule:

- if `region.confidence < 0.70` and the action is state-changing, fail with `TARGET_LOW_CONFIDENCE` unless the plan explicitly marked the step as confirmed or downgraded to a read-first action

This preserves the current human-safety intent but makes it enforceable.

### 6.1.5 File-level implementation plan for Phase 1

#### `src/main/inspect-service.js`

Add or expose:

- `getRegionById(regionId)`
- `getSnapshot()` returning regions + window context + selected region + timestamp
- `resolveTarget(regionId, options)`
- optional `refreshRegionsIfNeeded(options)`

Keep `recordAction(...)` and `updateActionOutcome(...)`, but extend them later with proof IDs and resolved target summaries.

#### `src/shared/inspect-types.js`

Extend typedefs to include:

- `ResolvedTarget`
- richer `ActionTrace`
- `ActionProof`
- helper methods for:
  - center resolution
  - staleness calculation
  - target summarization for traces/tests

#### `src/main/ai-service/message-builder.js`

- inject `generateAIInstructions()` as system message
- include region IDs and selected region in prompt text
- preserve backward compatibility with existing inspect snapshot text

#### `src/main/system-automation.js`

Add a resolution step ahead of action dispatch:

- `resolveActionTarget(action, runtimeContext)`
- mutate an internal execution copy of the action, not the original raw plan object
- attach `resolvedTarget` to results
- emit specific target-resolution errors

#### `src/main/ai-service.js`

- preserve `targetId` through action parsing/execution
- when an action resolves successfully, allow `lastTargetWindowHandle` to inherit from `resolvedTarget.window`
- use proof results to drive continuation logic instead of only raw success booleans over time

## 6.2 Phase 2 — generic proof-carrying execution

### 6.2.1 Build on observation checkpoints, do not replace them

Current truth:

- `ai-service.js` already imports `createObservationCheckpointRuntime(...)`
- execution flows already create `observationCheckpoint` artifacts in relevant cases
- TradingView logic already performs bounded domain verification

Required change:

Elevate these into a standardized proof layer rather than leaving them as ad hoc result attachments.

### 6.2.2 Generic proof builder

Recommended new helper:

- `src/main/automation/proof-builder.js`

Responsibilities:

- create base proof shells
- attach standard checks
- merge generic checks with domain-specific checks
- determine proof level and status
- normalize limitations/bounded-claim language

Standard check kinds:

- `foreground-window`
- `target-resolution`
- `coordinate-fallback`
- `uia-readback`
- `text-readback`
- `surface-opened`
- `value-changed`
- `domain-verification`

### 6.2.3 Proof status rules

A proof should never silently imply more than the runtime actually observed.

Recommended status values:

- `verified`
- `bounded`
- `failed`
- `skipped`

Examples:

- plain coordinate click with no readback -> `level=0`, `status=bounded`
- click using resolved `targetId` with exact foreground match -> `level=1`, `status=verified`
- click plus postcondition text/UIA confirmation -> `level=2`, `status=verified`
- TradingView action plus domain verifier success -> `level=3`, `status=verified`

### 6.2.4 Result shape changes

`system-automation.executeAction(...)` should return:

```json
{
  "success": true,
  "action": "click",
  "message": "Clicked target",
  "resolvedTarget": { "targetId": "region-..." },
  "proof": {
    "level": 1,
    "status": "verified"
  },
  "duration": 248
}
```

`ai-service.js` can then append or upgrade that proof with:

- observation checkpoints
- TradingView verifiers
- continuation state

### 6.2.5 High-value early proofs

The first proof types to implement should be the most generally reusable:

1. `foreground-window` proof
2. `target-resolution` proof
3. `postcondition text/UIA` proof
4. screenshot/visual proof summaries only when directly available

This avoids over-coupling the generic layer to TradingView while still making it useful immediately.

## 6.3 Phase 3 — trace-driven regression platformization

### 6.3.1 Current truth

The repo already has three nearby pieces:

- orchestrator JSONL traces via `src/main/agents/trace-writer.js`
- execution telemetry via `src/main/telemetry/telemetry-writer.js`
- transcript fixture extraction/replay via `scripts/extract-transcript-regression.js` and `scripts/run-transcript-regressions.js`

The goal is to connect them, not replace them.

### 6.3.2 Proposed trace architecture

Recommended new low-level utility:

- `src/main/traces/trace-log.js`

Responsibilities:

- append JSONL events for any runtime component
- own file-path/session-path logic
- let `TraceWriter` become a higher-level subscriber rather than the only writer

Then:

- `src/main/agents/trace-writer.js` continues to subscribe to orchestrator events
- `src/main/ai-service.js` can append `action:planned` and `action:checkpoint`
- `src/main/system-automation.js` can append `action:start`, `action:complete`, and `action:proof`

### 6.3.3 Proposed runtime event set

Minimum new events:

- `action:planned`
- `action:start`
- `action:target-resolved`
- `action:complete`
- `action:proof`
- `action:error`

This makes runtime sessions reconstructable in the same way transcript fixtures already make model outputs replayable.

### 6.3.4 Regression fixture evolution

Do **not** create a disconnected regression universe.

Preferred direction:

Extend the current transcript fixture bundle shape to optionally include:

```json
{
  "traceMeta": {
    "sessionId": "session-...",
    "source": "runtime-trace"
  },
  "actions": [
    {
      "type": "click",
      "targetId": "region-..."
    }
  ],
  "proofExpectations": [
    {
      "actionIndex": 0,
      "minProofLevel": 1,
      "status": "verified"
    }
  ]
}
```

That lets transcript and runtime assertions coexist in a single bundle format.

### 6.3.5 New extraction flow

Recommended script:

- `scripts/extract-runtime-trace-regression.js`

Responsibilities:

- read a JSONL session trace
- extract prompt, parsed actions, target resolution summaries, proof summaries
- write or upsert fixture bundles compatible with the existing transcript loader model

### 6.3.6 Runner evolution

Preferred path:

- extend `scripts/run-transcript-regressions.js` rather than replacing it immediately
- add support for optional action/proof assertions
- keep text-turn assertions first-class

This matches current repo momentum and minimizes migration cost.

## 7. Recommended file changes

## 7.1 Existing files to update

- `src/main/inspect-service.js`
- `src/shared/inspect-types.js`
- `src/main/ai-service/message-builder.js`
- `src/main/ai-service/actions/parse.js` or underlying action normalizer in `system-automation.js`
- `src/main/ai-service.js`
- `src/main/system-automation.js`
- `src/main/agents/trace-writer.js`
- `scripts/test-inspect-types.js`
- `scripts/test-transcript-regression-pipeline.js`
- `scripts/run-transcript-regressions.js`
- `scripts/extract-transcript-regression.js` or a sibling extractor

## 7.2 Recommended new files

- `src/main/automation/target-resolver.js`
- `src/main/automation/proof-builder.js`
- `src/main/traces/trace-log.js`
- `scripts/extract-runtime-trace-regression.js`
- `scripts/test-inspect-target-resolution.js`
- `scripts/test-generic-action-proof.js`

These helpers keep `system-automation.js` and `ai-service.js` from absorbing even more mixed responsibilities.

## 8. Acceptance criteria

Status legend:

- ✅ implemented in the first slice
- ⏳ partially implemented / follow-on hardening still useful
- ☐ not yet implemented

This work is complete when all of the following are true.

### Inspect grounding

- ✅ inspect prompts include both instructions and region IDs
- ✅ action execution accepts `targetId` without breaking legacy plans
- ✅ stale or missing targets fail with explicit structured errors
- ✅ mutating click-like actions do not silently downgrade from `targetId` to raw coordinates unless explicitly allowed
- ✅ execution results report `resolvedTarget`
- ⏳ broader low-confidence and non-click guardrails still need follow-on work

### Proof

- ✅ every executed action returns a proof object
- ✅ proof never claims more than the runtime observed
- ✅ existing observation checkpoints are surfaced through the proof model rather than parallel ad hoc structures
- ⏳ TradingView verification can already compose with the generic layer indirectly, but a fuller `level=3` domain-proof uplift remains follow-on work

### Tracing and regression

- ✅ runtime action events are written as JSONL
- ✅ a session trace can be converted into a regression fixture bundle
- ✅ the regression runner can assert proof expectations in addition to transcript text expectations
- ⏳ the next natural step is to accumulate more checked-in runtime-trace-derived fixtures from real sessions

## 9. Testing plan

## 9.1 Unit tests

Extend or add tests for:

- region staleness calculation
- `getRegionById(...)`
- target resolution precedence (`runtimeId` > `clickPoint` > center > explicit fallback)
- low-confidence mutating action rejection
- proof level/status derivation

Recommended files:

- extend `scripts/test-inspect-types.js`
- add `scripts/test-inspect-target-resolution.js`
- add `scripts/test-generic-action-proof.js`

## 9.2 Integration tests

Add integration coverage for:

- inspect-mode prompt assembly using `message-builder.js`
- action execution carrying `targetId`
- proof enrichment from observation checkpoints
- runtime trace extraction into fixture bundles

Recommended additions:

- extend `scripts/test-transcript-regression-pipeline.js`
- add a focused runtime trace extraction test

## 9.3 High-risk domain tests

Once the generic layer is in place, re-run or extend the existing TradingView-focused suites because they are the best current proof that the generalized layer did not regress specialized safety behavior.

## 10. Rollout order

Recommended implementation sequence:

### Milestone 1 — prompt and contract wiring

Status: ✅ landed in first slice

- inject inspect system instructions
- include region IDs in prompt text
- accept `targetId` in action plans and preserve it through parsing

### Milestone 2 — runtime target resolution

Status: ✅ landed for click-like actions in first slice

- implement `getRegionById(...)`
- implement `resolveActionTarget(...)`
- enforce staleness/window/low-confidence guardrails

### Milestone 3 — base proof contract

Status: ✅ landed in first slice

- attach proof to every action result
- normalize observation checkpoint output into proof checks

### Milestone 4 — trace platformization

Status: ✅ landed in first slice

- write runtime action/proof events to JSONL
- extract traces into fixtures
- extend the regression runner

### Milestone 5 — TradingView uplift

Status: ⏳ next follow-on hardening area

- upgrade TradingView verifiers to emit domain-proof checks that compose with the generic layer

## 11. Risks and open questions

### 11.1 `runtimeId` stability

UIA `runtimeId` is best treated as session-scoped, not a durable persisted identity.

Implication: traces may store it for diagnostics, but replay logic should not assume it survives across runs.

### 11.2 Region freshness vs latency

If the freshness threshold is too strict, actions will fail too often. If too loose, target grounding becomes misleading.

Recommendation: start with `3000ms`, measure, then tune.

### 11.3 Coordinate-space drift

The repo already documents the CSS/DIP vs physical-pixel distinction in `src/main/index.js`. Any new target resolution helper must preserve that contract and never mix overlay coordinates with execution coordinates silently.

### 11.4 Backward compatibility

Some flows will continue to produce coordinates only. That is acceptable.

The requirement is not “all actions must use `targetId` immediately.” It is “when `targetId` is present, the runtime must honor it deterministically.”

## 12. First slice landed / next natural step

The originally recommended first slice is now implemented:

1. `message-builder.js` calls `generateAIInstructions()`
2. inspect snapshot text includes region IDs
3. `inspect-service.js` adds `getRegionById(...)` and `resolveTarget(...)`
4. `system-automation.executeAction(...)` resolves `targetId` for click-like actions
5. execution results return `resolvedTarget` + bounded proof
6. `ai-service.js` upgrades observation checkpoints into canonical proof
7. runtime action/proof traces are emitted and can be converted into regression fixtures

The next natural step is:

1. check in proof-aware regression fixtures derived from runtime traces
2. expand target grounding and guardrails beyond the current click-like slice
3. lift TradingView-specific verifiers into explicit `level=3` domain-proof checks

## 13. Bottom line

The repo already has the raw materials for inspect grounding, verification, and regression.

This spec turns those materials into one enforceable runtime chain:

`inspect target -> resolved execution target -> bounded proof -> replayable trace`

That is the shortest path to making Liku more reliable without rewriting what is already working.
