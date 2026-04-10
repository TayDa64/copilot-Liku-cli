# Brainstorm 04/08/26 — Code-Grounded Task File for Awareness, Compartmentalization, Provenance, and Proof

> Status: Ready for implementation planning and subagent execution  
> Generated from: direct code inspection + parallel subagent diagnosis on 2026-04-08  
> Primary trigger: Liku drifting into TradingView/Pine behavior while running inside the MUSE repo in VS Code, plus unsafe/ambiguous risky confirmation semantics

---

## 1. Purpose

This file turns the April 8, 2026 diagnosis into an implementation task map.

It is deliberately grounded in **codebase truth**, not aspirational architecture.

The immediate goal is to prevent Liku from:

1. defaulting into the wrong domain (for example TradingView/Pine) while working in an unrelated repo like MUSE,
2. leaking continuity or pending-task state across repo/app boundaries,
3. surfacing vague HIGH-risk confirmations like `Detected risky keyword: clear` without naming the exact object/surface at risk,
4. claiming intent or provenance that was not grounded in the actual action plan,
5. proceeding without strong awareness of the IDE / CLI / project / foreground app / surface it is operating in.

The broader goal is to push Liku toward the “stellar aware AI system” direction already discussed in the repo:

- context-aware,
- compartmentalized,
- provenance-carrying,
- continuity-safe,
- externally provable,
- and reliable under real repo and desktop workflows.

---

## 2. Core diagnosis recap

These tasks are based on concrete findings from the code and reproductions.

### Finding A — `run_command` safety is contaminated by user/session text

**Code path:** `src/main/ai-service.js` → `analyzeActionSafety()`

The current implementation builds `textToCheck` from:

- `targetInfo.text`
- `targetInfo.buttonText`
- `targetInfo.label`
- `action.reason`
- `targetInfo.userMessage`
- `nearbyText`

It then applies `DANGER_PATTERNS`, which include `\bclear\b`.

That means a harmless command such as:

```cmd
cd c:\dev\muse-ai && dir
```

can be upgraded to HIGH risk if the user’s natural-language prompt contains a benign phrase with the word `clear`.

### Finding B — Pine/TradingView rewrite can hijack unrelated shell plans

**Code path:**

- `src/main/ai-service.js` → `preflightActions()`
- `src/main/ai-service.js` → `rewriteActionsForReliability()`
- `src/main/tradingview/pine-workflows.js` → `maybeRewriteTradingViewPineWorkflow()`

Reproduction showed that a single shell action plan containing only `run_command` can have TradingView Pine quick-search/open steps prepended when the effective user intent is contaminated with Pine/TradingView language.

### Finding C — continuity/pending-task state is too global

**Code path:** `src/main/session-intent-state.js`, `src/cli/commands/chat.js`, `src/main/chat-continuity-state.js`

The current state model keeps a single global continuity object and related pending-task semantics under `~/.liku/session-intent-state.json`.

That is not safe for mixed workflows across:

- repo work,
- IDE work,
- browser work,
- TradingView work,
- CLI work.

### Finding D — TradingView/Pine prompt gravity is too global

**Code path:** `src/main/ai-service/system-prompt.js`, `src/main/ai-service/message-builder.js`

The system prompt contains many always-on TradingView/Pine rules. These are helpful in-domain, but they create background bias even when the user is clearly operating inside another repo/application.

### Finding E — confirmations are not object-specific enough

**Code path:** `src/main/ai-service.js`, `src/main/index.js`

Current confirmation messages can tell the user a risky keyword was detected, but often do not name:

- what exact object is being changed,
- what app/surface it belongs to,
- what evidence justified the action,
- what proof is expected after execution.

---

## 3. Desired end state

Before any significant action plan is accepted or executed, Liku should be able to answer these questions explicitly:

1. **Where am I operating?**  
	Repo, workspace, cwd, foreground app, active window, active surface.

2. **What compartment does this turn belong to?**  
	For example: `MUSE repo in VS Code`, `TradingView chart`, `browser research`, `copilot-Liku-cli development repo`.

3. **What domain overlays are actually allowed?**  
	Pine/TradingView rules should not shape a MUSE repo plan unless explicitly targeted.

4. **What exactly is the risky action about?**  
	A confirmation must name the real object and scope.

5. **What prior continuity is applicable?**  
	Only continuity from the same compartment should be reused automatically.

6. **What provenance supports the next step?**  
	Which repo/app context, memory, skill, rewrite, and evidence path authorized this move?

7. **What external proof will confirm success?**  
	Transcript regression, runtime trace proof, or observation checkpoint.

---

## 4. Guiding implementation rules

1. **Awareness before planning**
	- Build context first.
	- Gate prompt overlays, memory, skills, rewrites, and continuity on that context.

2. **Compartmentalize everything that can drift**
	- Continuity
	- pending actions
	- risky confirmations
	- provenance
	- memory/skill relevance

3. **Bind risk to the real object, not a stray keyword**
	- Especially for `run_command`.

4. **Keep `src/main/ai-service.js` as facade compatibility layer**
	- The repo already uses this as the public execution facade.
	- Move logic behind helpers where useful, but do not break downstream expectations.

5. **Proof is part of the feature, not a later add-on**
	- Every major milestone must add or extend regressions.

---

## 5. Proposed implementation streams (subagent lanes)

These are the workstreams we should hand to subagents.

### Stream A — Execution Context / Awareness Envelope
**Primary goal:** Build a canonical context snapshot before planning.

**Key files:**
- `src/shared/project-identity.js`
- `src/main/session-intent-state.js`
- `src/main/capability-policy.js`
- `src/main/ai-service/message-builder.js`
- `src/main/ai-service.js`

### Stream B — Safety / Confirmation Semantics
**Primary goal:** Make risk detection command-grounded and confirmations object-specific.

**Key files:**
- `src/main/ai-service.js`
- `src/main/index.js`
- relevant tests in `scripts/test-bug-fixes.js`, `scripts/test-ai-service-commands.js`

### Stream C — Continuity / Pending Action Compartmentalization
**Primary goal:** Stop cross-repo and cross-app bleed.

**Key files:**
- `src/main/session-intent-state.js`
- `src/main/chat-continuity-state.js`
- `src/cli/commands/chat.js`

### Stream D — Domain Overlay Gating (TradingView/Pine and future domains)
**Primary goal:** Convert TradingView/Pine from always-on gravity into a scoped overlay.

**Key files:**
- `src/main/ai-service/system-prompt.js`
- `src/main/ai-service/message-builder.js`
- `src/main/tradingview/pine-workflows.js`
- `src/main/tradingview/chart-verification.js`

### Stream E — Memory / Skill / Provenance Scoping
**Primary goal:** Ensure retrieval and routing respect repo/app/domain compartments.

**Key files:**
- `src/main/memory/skill-router.js`
- `src/main/memory/memory-store.js`
- `src/main/traces/runtime-trace-log.js`
- `src/main/agents/trace-writer.js`

### Stream F — External Proof / Regression Harness
**Primary goal:** Turn this diagnosis into checked-in proof.

**Key files:**
- `scripts/test-session-intent-state.js`
- `scripts/test-ai-service-proof-trace.js`
- `scripts/test-ai-service-commands.js`
- `scripts/fixtures/transcripts/**`
- `docs/RUNTIME_REGRESSION_WORKFLOW.md`

---

## 6. Phase-by-phase task map

## Phase 0 — Freeze the diagnosis into executable regressions

### Objective
Make sure the exact MUSE failure mode is reproducible and protected before larger refactors begin.

### Milestone 0.1 — Add a false-positive `clear` regression for `run_command`

**Tasks**
- [ ] Add a regression showing that a plain `run_command` does **not** become HIGH risk merely because `userMessage` contains a benign `clear` token.
- [ ] Use the exact shape of the observed command: `cd c:\dev\muse-ai && dir`.
- [ ] Include a control case showing destructive commands are still flagged.

**Files**
- `scripts/test-bug-fixes.js`
- optionally `scripts/test-ai-service-commands.js`

**Acceptance criteria**
- `run_command` with benign prose containing `clear` remains MEDIUM or lower unless the command itself is destructive.

---

### Milestone 0.2 — Add a regression for Pine rewrite hijacking shell-only plans

**Tasks**
- [ ] Add a test that a shell-only plan is **not** rewritten into Pine/TradingView actions merely because `userMessage` mentions Pine/TradingView.
- [ ] Preserve a separate positive test proving Pine rewrite still works when the plan is genuinely Pine-targeted.

**Files**
- `scripts/test-tradingview-pine-workflows.js`
- `scripts/test-tradingview-chart-verification.js`
- `src/main/tradingview/pine-workflows.js`

**Acceptance criteria**
- `run_command`-only plans stay shell-only unless the plan and context are both truly Pine-targeted.

---

### Milestone 0.3 — Add a repo/app continuity contamination regression

**Tasks**
- [ ] Create a test where a prior TradingView/Pine continuity state exists.
- [ ] Simulate the next turn being in a different repo/app context (for example MUSE in VS Code).
- [ ] Verify that TradingView/Pine continuity is not auto-reused.

**Files**
- `scripts/test-session-intent-state.js`
- `scripts/test-chat-continuity-state.js` (new if needed)
- `src/main/session-intent-state.js`
- `src/main/chat-continuity-state.js`

**Acceptance criteria**
- Cross-compartment continuity is explicitly degraded or ignored.

---

## Phase 1 — Build the Execution Context Envelope

### Objective
Create one canonical context snapshot that all later decisions depend on.

### Milestone 1.1 — Introduce a dedicated execution-context helper

**Tasks**
- [ ] Add a helper module, likely `src/main/ai-service/execution-context.js`.
- [ ] Define a normalized envelope shape with fields for:
  - repo/project context,
  - cwd,
  - foreground app/window/surface,
  - interaction mode,
  - downstream repo intent,
  - task family,
  - compartment key,
  - confidence / ambiguity flags.
- [ ] Reuse existing seams instead of rebuilding logic:
  - `resolveProjectIdentity()` from `src/shared/project-identity.js`
  - repo state from `src/main/session-intent-state.js`
  - capability/surface classification from `src/main/capability-policy.js`

**Acceptance criteria**
- One helper can answer: “What repo/app/surface/task family does this turn belong to?”

---

### Milestone 1.2 — Inject context envelope into prompt assembly

**Tasks**
- [ ] Add a compact `## Execution Context Envelope` section in `message-builder.js`.
- [ ] Ensure it appears before domain-specific overlays and continuity sections.
- [ ] Include enough detail for routing without overloading the prompt.

**Files**
- `src/main/ai-service/message-builder.js`

**Acceptance criteria**
- The model always receives the current repo/app/surface/compartment context before planning.

---

### Milestone 1.3 — Expose context envelope to runtime traces

**Tasks**
- [ ] Record context envelope or a context summary/hash in runtime trace events.
- [ ] Ensure resumed actions and confirmations also carry the same context identity.

**Files**
- `src/main/traces/runtime-trace-log.js`
- `src/main/agents/trace-writer.js`
- `src/main/ai-service.js`

**Acceptance criteria**
- A proof artifact can later answer: “What context authorized this plan?”

---

## Phase 2 — Gate domain overlays and remove TradingView/Pine default gravity

### Objective
TradingView/Pine should be strong **when relevant**, invisible when irrelevant.

### Milestone 2.1 — Split always-on prompt rules from domain overlays

**Tasks**
- [ ] Audit `system-prompt.js` and separate:
  - universal rules,
  - TradingView/Pine-only rules,
  - future domain overlays.
- [ ] Keep global:
  - honesty,
  - bounded claims,
  - generic action format,
  - general safety.
- [ ] Move TradingView/Pine blocks behind a conditional injection path.

**Files**
- `src/main/ai-service/system-prompt.js`
- `src/main/ai-service/message-builder.js`

**Acceptance criteria**
- A MUSE/VS Code task does not receive Pine/TradingView-specific policy unless explicitly targeted.

---

### Milestone 2.2 — Gate TradingView/Pine rewrite eligibility on context envelope

**Tasks**
- [ ] Require both message and context eligibility before Pine rewrite can occur.
- [ ] Suppress Pine rewrite when the envelope says the active compartment is repo/editor work in another project.
- [ ] Preserve explicit TradingView requests when the user really wants them.

**Files**
- `src/main/ai-service.js`
- `src/main/tradingview/pine-workflows.js`

**Acceptance criteria**
- Pine rewrite no longer hijacks unrelated repo workflows.

---

### Milestone 2.3 — Tighten synthetic Pine opener logic

**Tasks**
- [ ] Make `syntheticOpener` obey the same conservative gating as `syntheticSurfaceOpen`.
- [ ] Prevent synthetic Pine openers when the original action list contains `run_command` or other clearly non-Pine work.
- [ ] Document the rule inside the code and tests.

**Files**
- `src/main/tradingview/pine-workflows.js`
- `scripts/test-tradingview-pine-workflows.js`

**Acceptance criteria**
- No synthetic Pine opener is created from mixed or shell-only plans.

---

## Phase 3 — Make safety and confirmations object-specific

### Objective
The user should know exactly what they are approving.

### Milestone 3.1 — Refactor `run_command` safety to be command-grounded

**Tasks**
- [ ] In `analyzeActionSafety()`, split risk inputs into:
  - command-grounded evidence,
  - contextual explanation-only evidence.
- [ ] For `run_command`, danger escalation must come primarily from `action.command`.
- [ ] Keep context for explanation, but not for false-positive escalation.

**Files**
- `src/main/ai-service.js`

**Acceptance criteria**
- Benign prose no longer upgrades shell commands to HIGH risk.

---

### Milestone 3.2 — Add object descriptors to safety results

**Tasks**
- [ ] Extend safety results to include fields such as:
  - `objectType`
  - `objectLabel`
  - `surface`
  - `appName`
  - `repoPath`
  - `whyNow`
  - `expectedProof`
- [ ] Thread those through pending-action state and IPC.

**Files**
- `src/main/ai-service.js`
- `src/main/index.js`

**Acceptance criteria**
- Confirmation payloads can describe the exact target object.

---

### Milestone 3.3 — Improve `describeAction()` and confirmation UX text

**Tasks**
- [ ] Replace generic warnings with concrete phrases like:
  - “Clear TradingView quick-search query”
  - “Overwrite Pine Editor buffer”
  - “Run delete command in repo X”
  - “Modify file Y in workspace Z”
- [ ] Ensure the text is compatible with existing UI surfaces.

**Files**
- `src/main/ai-service.js`
- `src/main/index.js`

**Acceptance criteria**
- The user never sees a bare “Detected risky keyword: clear” without the object/surface context.

---

## Phase 4 — Compartmentalize continuity and pending tasks

### Objective
Continuity should be reusable only inside the correct repo/app/task compartment.

### Milestone 4.1 — Add compartment keys to continuity state

**Tasks**
- [ ] Extend session state schema to support continuity by `compartmentKey`.
- [ ] Preserve compatibility with current top-level APIs while backing them with a map.
- [ ] Record `activeGoal`, `currentSubgoal`, `executionIntent`, and evidence under the compartment.

**Files**
- `src/main/session-intent-state.js`
- `src/main/chat-continuity-state.js`

**Acceptance criteria**
- Continuity is no longer single-global.

---

### Milestone 4.2 — Partition pending actions by compartment

**Tasks**
- [ ] Change pending action storage/resume logic so confirmation resumes only inside the same compartment.
- [ ] Refuse to resume when the context envelope no longer matches.

**Files**
- `src/main/ai-service.js`
- `src/main/index.js`
- `src/cli/commands/chat.js`

**Acceptance criteria**
- A pending TradingView action cannot resume in a MUSE/VS Code compartment.

---

### Milestone 4.3 — Make continuation reuse explicit in the CLI

**Tasks**
- [ ] When `chat.js` chooses `executionIntent` from stored continuity instead of the literal current turn, surface that fact clearly.
- [ ] On repo or app switch, degrade or invalidate unrelated continuity.
- [ ] Add an optional `/state` or debug display update if useful.

**Files**
- `src/cli/commands/chat.js`
- `src/main/session-intent-state.js`

**Acceptance criteria**
- The operator can tell when Liku is using resumed intent versus fresh literal input.

---

## Phase 5 — Scope memory, skills, and routing by compartment

### Objective
Make retrieved memories/skills context-relevant instead of globally sticky.

### Milestone 5.1 — Strengthen skill selection scope

**Tasks**
- [ ] Extend skill selection to consider repo/app/task-family scope more strongly.
- [ ] Add downranking/blocking for mismatched domain overlays during actionable planning.

**Files**
- `src/main/memory/skill-router.js`

**Acceptance criteria**
- TradingView skill context does not outrank repo-local/MUSE work when the active compartment is MUSE.

---

### Milestone 5.2 — Add scoped memory filters

**Tasks**
- [ ] Add optional scope fields to memory retrieval logic:
  - repo name
  - project root
  - process name
  - domain
  - task family
- [ ] Avoid hard forgetting; prefer weighted downranking except for action-planning paths.

**Files**
- `src/main/memory/memory-store.js`

**Acceptance criteria**
- Old TradingView wins no longer dominate unrelated repo planning.

---

### Milestone 5.3 — Record selected skills/memories in provenance

**Tasks**
- [ ] Log which skills and memories shaped the turn.
- [ ] Attach those references to normalized continuity turns and/or runtime traces.

**Files**
- `src/main/chat-continuity-state.js`
- `src/main/traces/runtime-trace-log.js`

**Acceptance criteria**
- Later analysis can explain why a plan drifted.

---

## Phase 6 — Strengthen proof, persistence, and auditability

### Objective
Turn context awareness into externally checkable proof.

### Milestone 6.1 — Add context envelope to normalized turn records

**Tasks**
- [ ] Extend normalized turn records with:
  - `compartmentKey`
  - context summary/hash
  - selected skills/memories
  - rewrite sources
  - proof references

**Files**
- `src/main/chat-continuity-state.js`

**Acceptance criteria**
- Every turn record explains not only what happened, but under what context authority.

---

### Milestone 6.2 — Add runtime trace provenance for rewrites

**Tasks**
- [ ] When actions are rewritten for reliability, record:
  - what rewrote them,
  - why,
  - which context envelope allowed it.
- [ ] Make this visible in runtime-proof extraction if feasible.

**Files**
- `src/main/ai-service.js`
- `src/main/traces/runtime-trace-log.js`
- `scripts/extract-runtime-trace-regression.js`

**Acceptance criteria**
- Future incidents can prove whether a Pine rewrite came from explicit user intent or stale contamination.

---

## Phase 7 — Expand the external proof / regression harness

### Objective
Ensure the diagnosed failure modes never silently return.

### Milestone 7.1 — Transcript regression: MUSE repo work does not drift to TradingView

**Tasks**
- [ ] Add a transcript fixture modeling the reported MUSE interaction.
- [ ] Assert that the system asks grounded repo/runtime questions and does not invent Pine intent.

**Files**
- `scripts/fixtures/transcripts/**`
- `scripts/run-transcript-regressions.js`
- `scripts/test-transcript-regression-pipeline.js`

**Acceptance criteria**
- The MUSE transcript no longer routes into TradingView/Pine scaffolding unless explicitly requested.

---

### Milestone 7.2 — Runtime-proof regression: confirmations name the object

**Tasks**
- [ ] Extend proof fixtures to verify confirmation payload specificity.
- [ ] Add a runtime-proof case for “clear” in benign prose versus real destructive action.

**Files**
- `scripts/test-ai-service-proof-trace.js`
- `scripts/fixtures/transcripts/runtime-proof-regressions.json`

**Acceptance criteria**
- Confirmation proof can show what object was at risk.

---

### Milestone 7.3 — Session-state regression: compartment switches degrade continuity

**Tasks**
- [ ] Add tests for:
  - repo switch,
  - app switch,
  - foreground context mismatch,
  - pending action resume refusal after compartment change.

**Files**
- `scripts/test-session-intent-state.js`
- `scripts/test-ai-service-commands.js`

**Acceptance criteria**
- Resumes across incompatible compartments fail safely and explain why.

---

## 7. Low-level task queue by file

This section is the most concrete handoff map for subagents.

### `src/main/ai-service.js`
- [ ] Extract execution-context assembly or call a new helper.
- [ ] Refactor `analyzeActionSafety()` so `run_command` risk escalation is command-grounded.
- [ ] Separate explanation context from risk-escalation context.
- [ ] Add object descriptor fields to safety results.
- [ ] Add provenance/rewrite metadata to action execution results.
- [ ] Make pending actions compartment-aware.

### `src/main/ai-service/message-builder.js`
- [ ] Inject `## Execution Context Envelope`.
- [ ] Conditionally inject TradingView/Pine overlays.
- [ ] Keep continuity/context ordering stable and readable.

### `src/main/ai-service/system-prompt.js`
- [ ] Move Pine/TradingView-specific rules into clearly isolated overlay blocks.
- [ ] Retain only universal rules in the always-on base prompt.

### `src/main/tradingview/pine-workflows.js`
- [ ] Tighten `syntheticOpener` gating.
- [ ] Block Pine synthetic opener generation for shell-only plans.
- [ ] Ensure mixed-context plans do not auto-convert into Pine workflows.

### `src/cli/commands/chat.js`
- [ ] Make reused `executionIntent` visible to the operator and/or trace.
- [ ] Refuse continuity reuse after repo/app compartment switch.
- [ ] Integrate compartment awareness into continuation heuristics.

### `src/main/session-intent-state.js`
- [ ] Extend schema for compartment-keyed continuity.
- [ ] Extend schema for compartment-keyed pending tasks.
- [ ] Add migration logic that preserves compatibility.

### `src/main/chat-continuity-state.js`
- [ ] Add context/provenance fields to normalized turn records.
- [ ] Add compartment-aware continuity summaries.

### `src/main/memory/skill-router.js`
- [ ] Strengthen repo/app/domain scope weighting.

### `src/main/memory/memory-store.js`
- [ ] Add scope-aware retrieval/downranking.

### `src/main/traces/runtime-trace-log.js`
- [ ] Record context/rewrite provenance in trace events.

### `src/main/index.js`
- [ ] Thread enriched confirmation payloads through IPC.

### Test files
- [ ] `scripts/test-bug-fixes.js`
- [ ] `scripts/test-ai-service-commands.js`
- [ ] `scripts/test-ai-service-proof-trace.js`
- [ ] `scripts/test-session-intent-state.js`
- [ ] `scripts/test-tradingview-pine-workflows.js`
- [ ] `scripts/test-transcript-regression-pipeline.js`

---

## 8. Suggested subagent execution order

### Order 1 — Freeze failures first
1. Stream F: regressions for false `clear`, Pine rewrite hijack, compartment bleed

### Order 2 — Stop the biggest live harm
2. Stream B: command-grounded safety / object-specific confirmations
3. Stream D: domain overlay gating and Pine rewrite tightening

### Order 3 — Build lasting context architecture
4. Stream A: execution context envelope
5. Stream C: continuity/pending-task compartmentalization

### Order 4 — Improve quality and auditability
6. Stream E: memory/skill scoping
7. Stream F: deeper provenance/runtime proof expansion

---

## 9. Definition of done

This initiative is done when all of the following are true:

- [ ] In a non-TradingView repo like MUSE, Liku does not default into Pine/TradingView plans unless explicitly targeted.
- [ ] A benign shell command is not escalated to HIGH risk from unrelated prose containing `clear`.
- [ ] Every HIGH-risk confirmation names the real object/surface being affected.
- [ ] Continuity reuse is compartment-aware and safe across repo/app switches.
- [ ] Runtime traces can explain which context/rewrite/memory/skill produced the action plan.
- [ ] Transcript and runtime-proof regressions cover the original reported MUSE failure class.
- [ ] TradingView remains strong and safe in-domain after the awareness refactor.

---

## 10. Immediate next implementation slice

If we want the highest leverage first, the next slice should be:

### Slice 1
1. Add the false-positive `clear` regression.
2. Fix `run_command` safety classification to be command-grounded.
3. Add the shell-plan Pine-hijack regression.
4. Tighten `syntheticOpener` in `pine-workflows.js`.

### Slice 2
5. Introduce the execution context envelope.
6. Gate TradingView/Pine prompt overlays on the envelope.

### Slice 3
7. Compartmentalize continuity and pending actions.
8. Expand proof/provenance traces and transcript fixtures.

That sequence addresses the concrete harm first while still moving toward the larger aware-system architecture.

---

## 11. Orchestrator charter for the /fleet

This section defines how the supervisor/orchestrator should run the fleet against this file.

The orchestrator's job is **not** to code everything directly. Its job is to:

1. preserve architectural intent,
2. keep changes scoped to the active milestone,
3. prevent regressions to already-working behavior,
4. require proof before advancing phases,
5. ensure subagent outputs remain grounded in codebase truth.

### Orchestrator responsibilities

- Maintain milestone discipline.
- Prevent “helpful” subagent expansion outside the active slice.
- Require file-level grounding before implementation.
- Require regression updates for every behavior change.
- Require explicit unresolved-risk reporting at every handoff.
- Keep the public `ai-service.js` facade stable unless a milestone explicitly authorizes interface change.

### Orchestrator non-goals

- Do not let builders opportunistically refactor unrelated systems.
- Do not let architect/researcher outputs silently become implementation without validation.
- Do not allow a verifier pass to be skipped simply because the change looks small.
- Do not accept “it should be fine” in place of test evidence.

---

## 12. Fleet execution protocol

Each active milestone should follow this sequence unless there is a compelling reason not to.

### Step 1 — Researcher / Diagnostician (read-only)

Use when:
- code location is unclear,
- multiple candidate seams exist,
- the active behavior is under-specified,
- the regression surface is not obvious.

Required outputs:
- exact files/functions,
- current behavior summary,
- likely regression risks,
- smallest safe change boundary.

### Step 2 — Architect (read-only)

Use when:
- multiple implementation paths exist,
- state ownership or module boundaries matter,
- prompt/routing/persistence changes may cross system boundaries.

Required outputs:
- reuse-first implementation path,
- boundaries not to violate,
- compatibility constraints,
- suggested proof strategy.

### Step 3 — Builder (write-enabled)

Use only when:
- milestone is concrete,
- file ownership is known,
- expected tests are named.

Required outputs:
- changed files,
- what behavior changed,
- what behavior was intentionally preserved,
- local proofs executed,
- unresolved risks.

### Step 4 — Verifier (read-only)

Always use after builder work that changes behavior.

Required outputs:
- verification report,
- explicit pass/fail,
- commands/tests run,
- any gap between intended and actual behavior.

### Step 5 — Diagnostician (only if verification fails or behavior diverges)

Required outputs:
- root cause,
- reproduction,
- smallest fix,
- whether prior builder assumptions were invalid.

---

## 13. Precision rules for subagent implementation

These rules exist to stop “nearly correct” implementation drift.

### Rule 13.1 — One milestone at a time

Subagents should implement only the current milestone unless the milestone explicitly bundles adjacent tasks.

Examples:
- A builder fixing `run_command` safety should not also rewrite continuity storage in the same pass unless explicitly asked.
- A builder gating Pine prompt overlays should not redesign memory-store scope filters in the same change.

### Rule 13.2 — Preserve existing valid domain behavior

Every subagent must treat existing validated TradingView hardening as **behavior to preserve**, not collateral damage.

Protected areas include:
- bounded TradingView quick-search semantics,
- Pine safe-authoring flows,
- domain-proof verification,
- observation checkpoints,
- runtime-proof fixture generation.

### Rule 13.3 — Prefer additive seams over broad rewrites

Preferred order:
1. add helper,
2. thread helper into facade,
3. tighten existing conditionals,
4. extend structured payloads,
5. only then consider moving/renaming major modules.

### Rule 13.4 — Every behavior change must name its regression surface

Builders must explicitly state:
- which tests were added/updated,
- which existing tests were used as preservation checks,
- what non-obvious behaviors might have shifted.

### Rule 13.5 — Command safety changes must distinguish

When changing safety logic, always separate:
- command-grounded risk,
- UI-surface-grounded risk,
- context/prose explanation,
- domain-specific bounded exceptions.

This is mandatory for `run_command` work.

### Rule 13.6 — Context changes must preserve ambiguity handling

If a context envelope cannot confidently determine repo/app/surface:
- do not guess,
- prefer degraded continuity,
- ask or reobserve,
- or explicitly block action planning.

---

## 14. Regression preservation matrix

Every active change must be checked against this preservation matrix.

### 14.1 Safety-preserve matrix

When changing `analyzeActionSafety()`:
- [ ] destructive shell commands still escalate,
- [ ] safe shell commands no longer escalate from unrelated prose,
- [ ] bounded TradingView clear flows still remain bounded,
- [ ] close shortcuts remain critical/high as intended,
- [ ] existing Pine safety tests still pass.

### 14.2 TradingView-preserve matrix

When changing Pine/TradingView routing:
- [ ] real Pine requests still open the right bounded flows,
- [ ] Pine safe-authoring still avoids destructive overwrite by default,
- [ ] shell-only plans are not Pine-hijacked,
- [ ] TradingView-specific prompt overlays still appear when explicitly relevant,
- [ ] observation and proof upgrades still function.

### 14.3 Continuity-preserve matrix

When changing continuity state:
- [ ] same-compartment continuation still works,
- [ ] cross-compartment continuation degrades safely,
- [ ] pending confirmations resume only within compartment,
- [ ] explicit user continuation remains ergonomic,
- [ ] repo-switch logic is visible and auditable.

### 14.4 Prompt-preserve matrix

When changing prompt assembly:
- [ ] universal safety/honesty constraints remain intact,
- [ ] domain overlays become conditional without disappearing in-domain,
- [ ] context envelope appears early enough to shape planning,
- [ ] message-builder order remains deterministic,
- [ ] prompt additions do not bloat unrelated tasks unnecessarily.

---

## 15. Milestone entry and exit gates

Subagents should not start or finish milestones without satisfying these gates.

### Entry gate for a builder milestone

Before coding, the orchestrator should have:
- [ ] named the active milestone,
- [ ] named exact target files,
- [ ] named required tests/regressions,
- [ ] identified protected behaviors,
- [ ] chosen whether compatibility constraints forbid API changes.

### Exit gate for a builder milestone

A builder is not done unless it can show:
- [ ] changed files list,
- [ ] tests added/updated,
- [ ] preservation tests run,
- [ ] no unrelated file drift in the milestone commit,
- [ ] unresolved risks listed.

### Exit gate for a verifier milestone

The verifier is not done unless it can show:
- [ ] what commands/tests were run,
- [ ] whether the milestone acceptance criteria were met,
- [ ] whether any protected behavior regressed,
- [ ] whether the implementation exceeded scope.

---

## 16. Recommended subagent prompts by stream

These are suggested prompt shapes for precise execution.

### Stream A — Execution Context / Awareness Envelope

Prompt expectations:
- identify reuse-first seams,
- define exact envelope schema,
- show how it plugs into prompt assembly and runtime traces,
- preserve existing capability-policy and session-intent semantics where possible.

Must explicitly protect:
- existing repo identity helpers,
- existing prompt assembly order,
- existing capability-policy behavior outside the new gating.

### Stream B — Safety / Confirmation Semantics

Prompt expectations:
- isolate command-grounded risk rules from prose/context,
- propose object descriptor schema,
- thread confirmation payloads through existing IPC without breaking UI compatibility.

Must explicitly protect:
- dangerous shell escalation,
- bounded Pine/TradingView clear exceptions,
- existing close-shortcut critical protections.

### Stream C — Continuity / Pending Action Compartmentalization

Prompt expectations:
- extend current state schema compatibly,
- define compartment key shape,
- degrade safely on repo/app switch,
- keep same-compartment continuation ergonomic.

Must explicitly protect:
- current session-intent migration behavior,
- existing chat continuity summaries where still valid,
- current pending-action resume flow for same-context cases.

### Stream D — Domain Overlay Gating

Prompt expectations:
- separate global prompt rules from TradingView/Pine overlays,
- gate Pine rewrites on both message and context,
- keep real TradingView workflows fully functional.

Must explicitly protect:
- TradingView quick-search hardening,
- Pine safe-authoring default behavior,
- domain-proof verification hooks.

### Stream E — Memory / Skill / Provenance Scoping

Prompt expectations:
- introduce scope-aware retrieval/downranking,
- log selected skills/memories into turn provenance,
- avoid making the system feel amnesic outside action planning.

Must explicitly protect:
- local-first memory behavior,
- currently useful skill routing for same-domain flows,
- trace/proof output schemas unless intentionally extended.

### Stream F — External Proof / Regression Harness

Prompt expectations:
- translate each diagnosed failure into a stable regression,
- keep fixtures legible and minimally brittle,
- preserve current runtime-proof fixture workflows.

Must explicitly protect:
- existing transcript regression pipeline,
- current runtime-proof extraction/generation scripts,
- observation-flow proof semantics already in place.

---

## 17. Commit and merge discipline for the fleet

To avoid cross-contamination between milestones, commits should follow this pattern:

### Commit pattern
- one milestone or tightly bound milestone slice per commit,
- tests/regressions included in the same commit as behavior changes,
- temporary logs and hook artifacts excluded unless intentionally part of evidence.

### Preferred commit grouping

1. regressions first,
2. minimal code fix,
3. verifier-confirmed follow-up if needed,
4. architectural expansion only after safety-preserving baseline is green.

### Avoid in the same commit
- prompt gating + memory-store redesign + continuity migration all together,
- large refactors without matching proof updates,
- opportunistic cleanup unrelated to the active milestone.

---

## 18. Fleet stop conditions

The orchestrator should pause / reroute the fleet if any of the following happen:

### Stop condition A — regression ambiguity
If a builder changes behavior but cannot show which old behaviors were preserved, stop and send to verifier or diagnostician.

### Stop condition B — prompt and state both changed together without proof
If prompt gating and continuity storage are both modified in one pass without fresh regressions, stop and split the work.

### Stop condition C — same file becomes overloaded
If `src/main/ai-service.js` changes become too broad for one milestone, split into helper extraction first.

### Stop condition D — domain behavior degraded
If explicit TradingView flows regress while fixing MUSE cross-domain drift, stop and diagnose before proceeding.

### Stop condition E — context envelope still ambiguous at runtime
If the system cannot confidently determine context after the envelope work, do not allow silent action planning; route to ask/reobserve/degrade-safe behavior.

---

## 19. Orchestrator acknowledgement of course discipline

The /fleet should treat this file as both:

1. an implementation roadmap,
2. and a behavioral contract.

Success is not merely “new code landed.”

Success means:
- MUSE-like repo tasks stop drifting into TradingView/Pine,
- risky confirmations become precise and honest,
- continuity becomes compartment-aware,
- existing validated TradingView behaviors stay intact,
- and every major claim is backed by regression or runtime proof.

The orchestrator should keep the fleet moving in that order, with proof at every boundary.

---

## 20. Post-Phase-6 external review synthesis (grounded in codebase truth)

This section translates external review feedback into **repo-true** guidance.

It is intentionally additive.

It does **not** invalidate earlier sections, and it must **not** be used as justification to remove already-established functionality that has already been verified in slices 1–6.

### 20.1 What the codebase already validates

The external review is directionally correct on the big picture: Liku's architecture is moving in the right direction because the repo now has real implementations for the three most important anti-state-bleed primitives.

#### A. Deterministic execution context already exists

**Code truth:** `src/main/ai-service/execution-context.js` builds the envelope from deterministic repo/window/session signals:
- `resolveProjectIdentity({ cwd })`
- foreground process/title/capability snapshot
- session state
- user-message task-family detection

This means the execution context is **not currently LLM-guessed**.

That is correct and should remain the rule.

**Implementation guardrail:**
- the LLM may consume the envelope,
- but the orchestrator/runtime must continue to **produce** the envelope from deterministic host signals first.

#### B. Command-grounded safety already exists

**Code truth:** in `src/main/ai-service.js`, `buildActionSafetyKeywordContext()` already routes `run_command` risk evaluation to `action.command` instead of user prose.

That means the system has already crossed the most important safety threshold:
- user prose can still inform explanation,
- but shell-command escalation is now primarily grounded in the actual command payload.

This must remain protected.

#### C. Compartment continuity is already real

**Code truth:** `src/main/session-intent-state.js` already stores continuity and pending-requested tasks by compartment, with `activeCompartmentKey`, `chatContinuityByCompartment`, and `pendingRequestedTaskByCompartment`.

This means the system no longer has a purely single-global continuity model.

That must remain the default safety posture.

#### D. Scoped retrieval already exists, but as weighted matching rather than inheritance

**Code truth:**
- `src/main/memory/skill-router.js` scores by repo/project/app/task-family/compartment/domain
- `src/main/memory/memory-store.js` scores notes by analogous scope metadata while preserving unscoped fallback behavior

This means the codebase already avoids the worst form of memory starvation by design, because unscoped/global-like notes and skills are still eligible as fallback.

However, the current system does **not yet** expose an explicit `global/domain/local` hierarchy.

That is a valid next improvement area.

#### E. Provenance and traceability are already partially implemented

**Code truth:** slices 5 and 6 already added:
- selection provenance,
- context authority,
- rewrite sources,
- proof refs,
- runtime trace `plan:rewrite` events,
- runtime-trace fixture extraction support.

This means the repo already has the beginnings of the “flight data recorder” concept the external review praised.

That path should continue.

---

### 20.2 Where the external review is useful, but must be reframed to fit this codebase

The following recommendations are valuable, but they must be integrated in a way that matches the current architecture.

#### A. “Bridge compartment” should be implemented as **context bridging**, not as a second parallel state model

The review correctly identifies a real risk:
- strict compartments can make cross-app workflows clumsy,
- especially transitions like VS Code → browser research,
- or editor → TradingView.

However, the repo should **not** rush into a brand-new “bridge compartment” persistence subsystem unless the simpler mechanism fails.

**Codebase-truth recommendation:**
- Keep compartment state strict by default.
- Add a lightweight **transition/bridge hint** to the execution context when the user explicitly invokes a cross-domain shift.
- Inject the previous compartment's active goal/current subgoal as **read-only inherited context** into prompt assembly for that turn only.
- Do **not** merge the two compartments' writable continuity state by default.

This preserves contamination safety while enabling baton-passing across domains.

#### B. “Skill hierarchy” should be implemented as an explicit scope tier over the current weighted router, not as a replacement

The external review is right that the current scoped router can over-constrain if future learned skills become too repo-local.

But codebase truth matters:
- the current system already deliberately supports unscoped fallback,
- so it is not yet a pure starvation architecture.

**Codebase-truth recommendation:**
- Preserve the current weighted scoring model in `skill-router.js` and `memory-store.js`.
- Add an explicit tier concept on top of current scope metadata:
  - `global`
  - `domain`
  - `local`
- `global` should remain eligible everywhere.
- `domain` should be boosted only when the execution context matches.
- `local` should remain the most tightly compartmented.
- Unscoped legacy entries should continue to behave as fallback-eligible rather than disappearing.

This is an additive evolution of the current router, not a redesign.

#### C. Continuity GC / stale-state cleanup is valid, but should be framed as lifecycle hygiene rather than a correctness prerequisite

The review correctly identifies that compartment state can grow over time.

**Code truth:**
- the repo already has freshness logic for continuity,
- but it does **not** yet implement LRU eviction for compartment entries.

That makes this a good next-step improvement, but not evidence that the current architecture is invalid.

**Codebase-truth recommendation:**
- add compartment-level `lastAccessedAt` or equivalent access metadata,
- run lightweight cleanup on CLI startup,
- clear stale pending actions first,
- compress very old continuity to a lighter episodic summary before deleting active state.

This should be implemented carefully so it does not erase still-useful recent workflows.

#### D. Read-only command allowlist is a valid hardening layer on top of command-grounded safety

The review is right that command-grounded safety alone is not the same as an explicit low-risk read-only allowlist.

**Code truth:**
- the current code already distinguishes many destructive patterns and already avoids prose-driven escalation for `run_command`,
- but it does not yet appear to formalize a strong first-class read-only shell allowlist in the roadmap.

**Codebase-truth recommendation:**
- add a bounded allowlist for commands like `git status`, `dir`, `ls`, `pwd`, `Get-ChildItem`, `Test-Path`, `cat`/`type`, `echo`, and similar read-only inspection commands,
- ensure they stay `LOW` or lower unless combined with clearly mutating flags or shells that imply mutation,
- keep destructive-pattern detection intact.

This should be treated as a safety hardening layer, not as a weakening of the existing confirmation model.

#### E. Execution-context performance/caching is a legitimate improvement area

The review is correct that repeatedly rebuilding repo identity can become unnecessary overhead.

**Code truth:**
- `src/shared/project-identity.js` is deterministic and file-system based,
- but it does not currently appear to expose a session cache for stable repo metadata.

**Codebase-truth recommendation:**
- cache repo-root / package / git-remote identity for the active session when `cwd` remains under the same project root,
- continue to retrieve foreground/window state dynamically,
- do not cache dynamic app/window state that could become stale mid-turn.

---

### 20.3 Additive improvement stream spawned from the synthesis

This review should become a **new additive stream**, not a rewrite of slices 1–6.

## Stream G — Post-Phase-6 hardening for fluidity without contamination

**Primary goal:** preserve strict anti-state-bleed guarantees while improving cross-compartment fluidity, scoped reuse, lifecycle hygiene, and operator transparency.

**Key files:**
- `src/main/ai-service/execution-context.js`
- `src/main/ai-service/message-builder.js`
- `src/main/session-intent-state.js`
- `src/main/memory/skill-router.js`
- `src/main/memory/memory-store.js`
- `src/shared/project-identity.js`
- `src/cli/commands/chat.js`
- `src/main/ai-service.js`
- relevant tests in `scripts/test-session-intent-state.js`, `scripts/test-chat-actionability.js`, `scripts/test-ai-service-proof-trace.js`, and transcript/runtime-proof fixtures.

---

### 20.4 Stream G milestone map

### Milestone G.1 — Deterministic envelope hardening and performance cache

**Objective**
Keep the execution context deterministic while reducing unnecessary repeated repo-identity work.

**Tasks**
- [x] Add session-local caching for stable project identity signals derived from `cwd` / repo root.
- [x] Keep foreground/window/app state dynamic.
- [x] Explicitly document that the LLM consumes but does not generate the execution context envelope.

**Files**
- `src/shared/project-identity.js`
- `src/main/ai-service/execution-context.js`

**Acceptance criteria**
- Execution context remains deterministic.
- Static repo identity does not require full repeated recomputation on every turn when unchanged.

---

### Milestone G.2 — Context bridging for explicit cross-compartment workflows

**Objective**
Allow explicit cross-domain baton-passing without reopening global state bleed.

**Tasks**
- [x] Detect explicit domain-transition intent in the execution context envelope.
- [x] Add a temporary read-only inherited-context block for the immediately previous compartment when the user explicitly invokes a cross-domain shift.
- [x] Keep writable continuity state compartmentalized; do not silently merge compartments.

**Files**
- `src/main/ai-service/execution-context.js`
- `src/main/ai-service/message-builder.js`
- `src/cli/commands/chat.js`
- `src/main/session-intent-state.js`

**Acceptance criteria**
- VS Code → browser / browser → TradingView handoffs can carry the baton intentionally.
- Same-compartment safety rules and contamination guards remain intact.

---

### Milestone G.3 — Explicit scope inheritance for skills and memory

**Objective**
Prevent future memory starvation without weakening scoped routing.

**Tasks**
- [x] Add explicit scope-tier metadata (`global`, `domain`, `local`) on top of current scope objects.
- [x] Keep unscoped entries fallback-eligible.
- [x] Update scoring so global skills always remain eligible, domain skills boost only in-matching contexts, and local skills remain tightly compartmented.

**Files**
- `src/main/memory/skill-router.js`
- `src/main/memory/memory-store.js`

**Acceptance criteria**
- Generic Git / shell / repo-debugging knowledge remains reusable across projects.
- TradingView and repo-local behavior remain strongly scoped.

---

### Milestone G.4 — Compartment lifecycle cleanup and stale-state hygiene

**Objective**
Prevent long-term state-file bloat without weakening current continuity semantics.

**Tasks**
- [x] Record access timestamps for compartment entries.
- [x] Add startup cleanup for stale pending actions and long-unused compartment state.
- [x] Prefer compressing stale continuity into episodic memory before full deletion where appropriate.

**Files**
- `src/main/session-intent-state.js`
- possibly `src/main/memory/memory-store.js`

**Acceptance criteria**
- Compartment state does not grow without bound over long-lived usage.
- Recent workflows remain intact.

---

### Milestone G.5 — Read-only command allowlist hardening

**Objective**
Reduce confirmation fatigue while preserving command-grounded safety.

**Tasks**
- [x] Add a first-class read-only shell allowlist for common inspection commands.
- [x] Keep destructive and privilege-elevating detection unchanged.
- [x] Prove that benign inspection commands remain low-risk even when the surrounding prose contains dangerous verbs.

**Files**
- `src/main/ai-service.js`
- `scripts/test-bug-fixes.js`
- `scripts/test-ai-service-commands.js`

**Acceptance criteria**
- Common inspection commands avoid unnecessary confirmations.
- Destructive commands still escalate correctly.

---

### Milestone G.6 — Operator-visible context switching and trace surfacing

**Objective**
Make context isolation visible as a feature rather than a perceived memory bug.

**Tasks**
- [x] Surface lightweight context-switch notices in the CLI when Liku parks old continuity and starts fresh in a new compartment.
- [x] Add a small operator-facing runtime trace summary/export path for the last execution.
- [x] Keep the UX lightweight and non-spammy.

**Files**
- `src/cli/commands/chat.js`
- `src/main/ai-service.js`
- any CLI command surface added for trace export

**Acceptance criteria**
- Users can tell when Liku intentionally switched compartments.
- The last runtime trace can be inspected without digging through hidden files.

---

### 20.5 Updated protected-behavior note

All Stream G work must preserve the following already-established functionality:

- command-grounded `run_command` safety,
- additive object-specific confirmation payloads,
- execution-context envelope generation from deterministic host signals,
- compartment-safe continuity and mismatch refusal,
- current scope-aware skill/memory retrieval with fallback,
- Slice 6 provenance fields and `plan:rewrite` runtime traces,
- established TradingView/Pine bounded workflows and observation/proof semantics.

No Stream G work should remove or silently weaken those behaviors.

---

### 20.6 Orchestrator summary of the synthesis

The external review is architecturally supportive, but the repo should follow this grounded interpretation:

1. **Validated and already true in code**
  - deterministic execution context,
  - command-grounded safety,
  - compartment continuity,
  - scoped retrieval,
  - growing provenance/trace infrastructure.

2. **Valid next improvements to adopt additively**
  - skill/memory inheritance tiers,
  - context bridging for explicit domain shifts,
  - compartment lifecycle cleanup,
  - explicit read-only command allowlist,
  - lightweight context-switch UX and trace export.

3. **Not approved as an immediate rewrite direction**
  - replacing deterministic envelope generation with LLM inference,
  - abandoning strict compartments,
  - replacing current weighted scope logic with hard filtering only,
  - removing already-verified bounded TradingView/Pine behavior in pursuit of generality.

This document remains the source of truth for implementation planning.
