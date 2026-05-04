# Gemini Synthesis — Grounded Assessment & Implementation Staging (2026-04-11)

Purpose: validate `gemini_brainstorm041026.md` against repository truth, separate confirmed bugs from already-mitigated or outdated concerns, and stage the next implementation slices.

## Executive Summary

Gemini’s synthesis is directionally strong, but several items need reclassification:

- **Confirmed, implementation-worthy gaps**
  - **F. Policy enforcement trace blindspot**
  - **G. Low-confidence context is prompt-only, not runtime-enforced**
  - **H. Legacy UIA host zero-coerces invalid bounds**
  - **I. Pine recovery hardcodes `//@version=6`**
  - **B. Unscoped memory fallback has no lexical confidence penalty**
  - **E. Sandbox failures lose useful diagnostics**
- **Partially true / already mitigated / needs narrower framing**
  - **A. Implicit switch amnesia** — real seam, but not a total absence of continuation recovery; current recovery is compartment-scoped and still misses implicit cross-compartment handoff.
  - **C. Terminal truncation** — partially outdated; stdout is already head+tail biased, but stderr handling is still weak and can hide the real failure cause.
  - **D. Background-capture z-order drift** — several mitigations already exist, but coordinate clicks still do not appear to require a freshly verified foreground lock at the exact dispatch point.
- **Strategic roadmap items, not immediate bugs**
  - UIA event-driven watcher
  - trace-to-quarantine automation
  - broader self-search / memory-search affordances

---

## Claim-by-Claim Grounding

### A. Implicit Switch Amnesia — **Partially confirmed**

**What is real in code**
- `src/main/ai-service/execution-context.js` only marks `transition.bridgeEligible` when the shift is **explicit** in the user’s text.
- `src/cli/commands/chat.js` only surfaces the context-switch notice when `bridgeEligible` is true.
- `src/main/session-intent-state.js` resolves continuity **strictly by compartment** when an explicit envelope is present.
- `src/cli/commands/chat.js` already has minimal-turn continuation recovery (`getContinuationDecision(...)`, stale-but-recoverable reobserve flow, pending-task reuse).

**Why Gemini is still basically right**
- A user who manually switches foreground app and types a minimal `continue` can land in a new compartment without triggering explicit bridge logic.
- Current recovery logic is strong for *same-compartment* continuity reuse, but there is no operator-facing “you switched compartments; reuse previous task?” handoff for implicit focus changes.

**Adjusted conclusion**
- This is **not** “no continuation recovery exists.”
- It **is** a real UX seam: implicit app switches are handled much worse than explicit textual transitions.

**Recommended slice**
- Add an *implicit-switch handoff detector* in `chat.js` for short continuation-like prompts when:
  - current envelope compartment differs from prior active compartment,
  - prior compartment continuity is recent and meaningful,
  - current compartment continuity is empty or weak.
- Behavior: ask or auto-inject a bounded handoff message instead of silently starting fresh.

**Priority:** High UX / Medium safety

---

### B. Unscoped Memory “Gravity” — **Confirmed**

**What is real in code**
- In `src/main/memory/memory-store.js`, `analyzeNoteScope(...)` returns `{ score: 0, classification: 'unscoped-fallback' }` for unscoped notes.
- Final ranking is `baseScore + scopeMatch.score`.
- Unscoped notes therefore receive **no penalty at all**; they simply keep their lexical score.
- Filtering is only `.filter(s => s.score > 0)`, so a lexically strong unscoped note can outrank weakly scoped items.

**Why this matters**
- Gemini’s “legacy bias” concern is grounded: old unscoped TradingView notes can still enter unrelated repo contexts if their keywords/tags match strongly enough.

**Recommended slice**
- Add a compartment-aware penalty for `unscoped-fallback` when the current selection context is well-defined.
- Example policy:
  - if `selectionContext.compartmentKey` exists, apply `-1.5` or `-2.0` to unscoped notes,
  - optionally smaller penalty if only repo/app/taskFamily is known.
- Preserve fallback semantics by keeping them eligible, but less competitive.

**Priority:** High

---

### C. Terminal Output Truncation — **Partially outdated, still worth patching**

**What is real in code**
- `src/main/system-automation.js` already uses `truncateOutput(...)` that preserves **head + tail** of stdout.
- During streaming capture, stdout and stderr are already tail-trimmed in memory when oversized.
- But final result still returns:
  - `stdout: truncateOutput(stdout.trim(), 4000)`
  - `stderr: stderr.trim().slice(0, 1000)`
- On failure, the human-facing message prefers `stderr` first.

**So what is wrong?**
- Gemini’s “first 4000 chars only” claim is outdated for stdout.
- The remaining real weakness is **stderr is head-biased**, not tail-biased.
- Many compilers/test runners emit the decisive stack trace or final summary at the end of stderr.

**Recommended slice**
- Replace `stderr.trim().slice(0, 1000)` with tail-biased truncation.
- On non-zero exit:
  - prefer stderr tail,
  - optionally reduce stdout budget and keep more stderr.
- Include `stdoutTruncated`, `stderrTruncated`, and original lengths separately.

**Priority:** Medium

---

### D. Background Capture vs Foreground Execution — **Partially confirmed / narrower than stated**

**What is real in code**
- Coordinate click flow in `src/main/ai-service.js` already has several protections:
  - `prevalidateActionTarget(action)`
  - attempted auto-focus before coordinate click using watcher-known window handles,
  - `ensureFocusLockedBeforeInputAction(...)` for `key`, `type`, `click_element`,
  - final `verifyForegroundFocus(...)` after sequence,
  - smart browser click fallback that avoids blind coordinate dispatch in many cases.
- `system-automation.js` focus helpers also try to verify actual foreground outcome.

**Remaining gap**
- I did **not** find a clean, explicit invariant that says: 
  > “A physical coordinate click may only dispatch after a just-verified foreground lock for the intended target window.”
- The coordinate click path has mitigation, but not the same obvious hard gate that `key`/`type` receive.

**Adjusted conclusion**
- This is **not** an unguarded click system.
- It **is** still a good hardening target because background capture + coordinate execution is intrinsically risky.

**Recommended slice**
- Before any coordinate `click` / `double_click` / `right_click`, require a fresh foreground verification object scoped to the intended window.
- If verification fails, block with `blockedByFocusLock` rather than dispatching the click.

**Priority:** Medium-High

---

### E. Dynamic Tool Orphaned State — **Confirmed**

**What is real in code**
- `src/main/tools/sandbox.js` returns only `{ success, result, error }`.
- `src/main/tools/sandbox-worker.js` silences console output and returns only `err.message` on failure.
- If the worker crashes or is SIGKILLed on timeout, the parent produces generic errors like:
  - `Tool execution timed out after 5000ms`
  - `Worker exited with code ...`

**Why Gemini is right**
- Useful crash context is lost: no structured phase info, no worker logs, no partial telemetry.

**Recommended slice**
- Upgrade worker/parent protocol to emit:
  - `phase` (validation / init / execute / serialize)
  - captured bounded logs buffer
  - error `name`, `message`, `stack` (bounded)
  - timeout vs crash vs protocol failure classification
- Keep security posture: still no arbitrary host access; only better diagnostics.

**Priority:** High developer leverage

---

### F. Policy Enforcement Trace Blindspot — **Confirmed**

**What is real in code**
- In `src/main/ai-service.js`, the policy regeneration loop runs **before** conversation history write and before action execution trace creation.
- Runtime traces are created later in `executeActions(...)` / `resumePendingAction(...)` via `buildRuntimeTraceLogForExecution(...)`.
- Existing tests assert action/proof/rewrite tracing, but there is no evidence of `policy:violation` or `plan:rejected` events.

**Why Gemini is right**
- Safety interventions currently save the system, but the trace dataset only sees the final compliant plan.
- This hides valuable eval signal.

**Recommended slice**
- Create a lightweight pre-execution planning trace channel or plumb pending trace events into the later runtime trace.
- Emit events such as:
  - `plan:policy-check`
  - `plan:rejected`
  - `policy:violation`
  - `plan:regenerated`
- Include violation families, retry count, app/process, and blocked action summaries.

**Priority:** Highest

---

### G. Low-Confidence Context Pass-Through — **Confirmed**

**What is real in code**
- `execution-context.js` computes `confidence` from ambiguity flags.
- `analyzeActionSafety(action, targetInfo)` does **not** receive the execution-context envelope.
- Risk escalation currently considers action type, target confidence, danger keywords, and domain rules — not envelope confidence.

**Why Gemini is right**
- Low-confidence context is currently advisory in prompt space, not a hard runtime rail.

**Recommended slice**
- Thread `executionContextEnvelope` into action safety analysis.
- If envelope confidence is `low` and action is mutating, escalate to `HIGH` or `CRITICAL`.
- At minimum, enforce for:
  - coordinate clicks,
  - typing/keys that mutate state,
  - `run_command` that is not read-only.

**Priority:** Highest

---

### H. UIA Zero-Bounds Coercion — **Confirmed (legacy host)**

**What is real in code**
- `src/native/windows-uia/Program.cs` uses:
  - `SafeNumber(rectangle.X/Y/Width/Height)`
  - `SafeNumber(double value) => double.IsFinite(value) ? value : 0`
- That means invalid bounds become `(0,0,0,0)`.

**Important nuance**
- There is also a newer host at `src/native/windows-uia-dotnet/Program.cs` with a persistent command loop.
- So the right implementation target may be the newer `.NET` UIA host, not the older one Gemini cited.

**Why this still matters**
- If any active path consumes the legacy host output, zero-bounds coercion can fabricate a clickable origin.

**Recommended slice**
- Replace invalid coordinates with `null` or omit bounds entirely.
- Ensure downstream click paths reject non-physical bounds.
- Audit which host is live in watcher/inspection paths and patch the active one first.

**Priority:** High

---

### I. Pine Version 6 Trap — **Confirmed**

**What is real in code**
- `src/main/ai-service.js`:
  - `normalizeGeneratedPineScript(...)` rewrites any version to `//@version=6`
  - code-generation prompts require first line exactly `//@version=6`
- `src/main/tradingview/pine-script-state.js` also normalizes to version 6 and validates against it.

**Why Gemini is right**
- Recovery and normalization can silently override user intent for v4/v5 maintenance tasks.

**Recommended slice**
- Introduce `detectRequestedPineVersion(...)` from:
  1. explicit user text,
  2. visible/editor script buffer if available,
  3. fallback default `6` only when no signal exists.
- Thread detected version into:
  - prompt builders,
  - normalization,
  - clipboard preparation,
  - validation.

**Priority:** Highest

---

## Strategic Items from Section 3

### UIA event-driven watcher
- Good roadmap item, but this is a **platform evolution project**, not the next bugfix slice.
- Ground truth note: there are both legacy and newer UIA hosts in-tree; event-stream work should target the active persistent host, not duplicate the old one.

### Trace-to-quarantine automation
- Strong idea and aligns naturally with the runtime trace pipeline.
- Best staged after policy-trace visibility lands, otherwise quarantines will miss a class of saved-by-policy failures.

### Native semantic self-search
- Good leverage idea, but lower urgency than runtime safety and provenance fixes.

---

## Recommended Implementation Order

### Wave 1 — Safety + provenance rails
1. **F. Trace policy rejections**
2. **G. Enforce low-confidence runtime escalation**
3. **I. Preserve Pine version intent**
4. **H. Remove zero-bounds coercion in active UIA host**

### Wave 2 — Retrieval + diagnostics quality
5. **B. Penalize unscoped memory fallback**
6. **E. Upgrade sandbox diagnostics**
7. **C. Improve stderr/failure truncation policy**

### Wave 3 — UX seam hardening
8. **A. Implicit compartment-switch handoff for minimal continuation turns**
9. **D. Require verified foreground lock before coordinate dispatch**

---

## Suggested Slice Definitions

### Slice 1: Policy + confidence provenance
- Files:
  - `src/main/ai-service.js`
  - `src/main/traces/runtime-trace-log.js`
  - `scripts/test-ai-service-proof-trace.js`
  - new targeted tests for policy retry events and low-confidence escalation
- Outcome:
  - runtime traces show rejected plans / policy saves
  - low-confidence envelopes cannot silently permit mutating actions

### Slice 2: Pine version intent preservation
- Files:
  - `src/main/ai-service.js`
  - `src/main/tradingview/pine-script-state.js`
  - relevant TradingView/Pine tests
- Outcome:
  - v4/v5 maintenance requests stop being silently rewritten to v6

### Slice 3: Scoped memory hardening + sandbox diagnostics
- Files:
  - `src/main/memory/memory-store.js`
  - `src/main/tools/sandbox.js`
  - `src/main/tools/sandbox-worker.js`
  - tests for unscoped fallback ranking and worker crash reporting
- Outcome:
  - less stale context bleed
  - better tool-failure diagnosis

### Slice 4: Foreground/compartment seam hardening
- Files:
  - `src/cli/commands/chat.js`
  - `src/main/ai-service.js`
  - active UIA host / click-path code
  - observation-flow and chat-actionability tests
- Outcome:
  - short `continue` turns survive implicit app switches more gracefully
  - coordinate clicks are blocked if foreground truth cannot be verified

---

## Bottom Line

Gemini surfaced several genuinely important seams. The strongest code-grounded bugs are:
- **policy saves are invisible in traces**,
- **low-confidence context lacks runtime enforcement**,
- **Pine recovery forcibly rewrites version intent**,
- **legacy UIA bounds coercion can fabricate `(0,0)` coordinates**,
- **unscoped memory fallback is too lexically competitive**.

The next best move is **not** a broad rewrite. It is a set of tight, test-backed hardening slices focused on safety provenance, ambiguity enforcement, Pine version intent, and scoped fallback behavior.
