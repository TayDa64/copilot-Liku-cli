# Brainstorm Synthesis & Codebase Ground Truth (04/10/26)

> **Objective:** Synthesize `brainstorm040826.md` against codebase reality to evaluate implementation completeness, identify architectural gaps, surface silent failures, and propose improvements.

## 1. Implementation Ground Truth: What is Actually Real?

Based on a deep cross-reference of the project status, implementation summaries, and the artifact trail, the "Stellar Aware AI System" vision outlined in `brainstorm040826.md` is overwhelmingly implemented. 

*   **Stream A (Execution Context Envelope):** **REAL.** `src/main/ai-service/execution-context.js` builds a deterministic snapshot of repo, cwd, foreground app, and capability mode before planning.
*   **Stream B (Command-Grounded Safety):** **REAL.** `src/main/ai-service.js` now evaluates `run_command` risk based on the actual command string, completely ignoring benign words like "clear" in the user's surrounding prose.
*   **Stream C (Compartmentalized Continuity):** **REAL.** `src/main/session-intent-state.js` successfully isolates `chatContinuity` and pending actions by `compartmentKey`.
*   **Stream D (Domain Overlays):** **REAL.** TradingView and Pine-specific rules have been evicted from the global system prompt and are now conditionally injected.
*   **Stream E (Scoped Retrieval):** **REAL.** `skill-router.js` and `memory-store.js` apply tier-based scope matching (global, domain, local), combining keyword bounds with pure-JS TF-IDF.
*   **Stream F & G (Provenance, Traces & Hygiene):** **REAL.** Runtime JSONL traces emit `plan:rewrite` events, the regression pipeline extracts traces to fixtures, and read-only shell commands (like `dir`, `ls`) are explicitly allowlisted.

## 2. Identified Gaps & Silent Failures

While the compartmentalization architecture is robust, cross-referencing these systems reveals several edge cases that will result in **silent failures** (situations where the system fails closed or acts incorrectly without generating a clear error log for the user).

### A. The "Implicit Switch" Amnesia (Continuity Drop)
*   **The Design:** Stream G.2 implemented "context bridging" for *explicit* cross-domain shifts (e.g., user says "now let's research this in the browser").
*   **The Silent Failure:** If a user is working in VS Code, manually clicks over to a Browser window, and simply types "continue" in the Liku chat, the `compartmentKey` silently changes under the hood. Because the transition was *implicit* (driven by OS focus, not text intent), Liku will see an empty continuity state for the new Browser compartment and respond with a generic "I don't know what to continue" message. The user experiences this as sudden amnesia.
*   **Codebase Parallel:** This is similar to the "stale UI watcher" problem. The solution might be to have `chat.js` detect rapid compartment shifts on short prompts and ask: *"You switched from VS Code to Edge. Do you want to continue the previous task here?"*

### B. Unscoped Memory "Gravity" (Legacy Bias)
*   **The Design:** Stream E and G.3 dictated that legacy, unscoped memories in `~/.liku/memory/notes.json` remain eligible as "fallback" so the system doesn't become totally forgetful.
*   **The Silent Failure:** TF-IDF and keyword matching still apply to these unscoped notes. If an old, unscoped TradingView note happens to have high lexical overlap with a new MUSE repo query, it might silently bypass the compartment downranking (since it lacks a compartment to clash with) and inject stale TradingView context into the MUSE system prompt.
*   **Area for Improvement:** Unscoped memories should have an artificial "confidence penalty" applied to their final TF-IDF score when evaluated inside a strictly defined compartment.

### C. Terminal Output Truncation (Missing the Root Cause)
*   **The Design:** `run_command` in `system-automation.js` captures stdout/stderr but truncates output to 4000 characters to protect the LLM context window.
*   **The Silent Failure:** When running a build command (e.g., `npm run build`), if the command generates 5000 lines of output and the actual fatal error is at the very bottom, Liku will only read the first 4000 characters. The agent will silently assume the command succeeded (or failed for unknown reasons) because the critical stderr stack trace was truncated.
*   **Area for Improvement:** The truncator must be tail-biased for shell commands (e.g., keep the first 500 chars and the last 3500 chars) or explicitly prioritize `stderr` over `stdout` when the exit code is non-zero.

### D. Z-Order Drift in Background Capture vs. Foreground Execution
*   **The Design:** Milestone 7 (Background Window Capture) allows non-disruptive vision (`window-printwindow`) to capture background windows so the user isn't interrupted during approval pauses.
*   **The Silent Failure:** If the AI receives a background screenshot, identifies a button at `(x=500, y=500)`, and executes a physical coordinate `click`, Windows will click whatever is *currently* at `(500,500)` on the screen. If the target app wasn't brought to the foreground first, Liku will silently click the user's active window (e.g., clicking inside their IDE instead of the background app).
*   **Codebase Parallel:** `system-automation.js` currently attempts a `SetForegroundWindow` before clicking, but if `Focus Truthfulness` (Track H / Slice 1) detects a mismatch and fails to bring the window up, the click might still dispatch. Physical coordinate actions must absolutely require a confirmed foreground lock.

### E. Dynamic Tool "Orphaned State" (Sandbox Isolation)
*   **The Design:** Phase 9 moved dynamic tool execution out of `vm.createContext` and into `child_process.fork()` for security.
*   **The Silent Failure:** If a dynamic tool crashes the child process (e.g., out of memory, infinite loop hit the 5.5s `SIGKILL`), the `sandbox-worker.js` dies. While the parent catches the exit code, any partial state, intermediate logs, or specific failure reasons inside the sandbox are vaporized. The AI receives a generic "Tool execution failed/timed out" and cannot diagnose *why* its proposed tool failed.

## 3. Areas for Improvement (Next-Level Hardening)

To move beyond fixing edge cases and toward the next evolution of the architecture, the following areas represent high-ROI improvements:

### 1. UIA Event-Driven Watcher (The "Holy Grail" of Desktop Awareness)
*   **Current State:** `ui-watcher.js` relies on a PowerShell polling loop (300-500ms). This burns CPU, misses transient states (like quick tooltips or fast dialogs), and relies on heavy COM-interop polling.
*   **The Gap:** As noted in `windows-visual-control-advancement-plan.md` and the PDF extraction of `System.Windows.Automation`, polling is an anti-pattern for UI Automation. 
*   **The Improvement:** Implement Phase 4 of the Visual Control plan: Use the existing `.NET UIA host` (`src/native/windows-uia/Program.cs`) to subscribe to `AutomationFocusChangedEventHandler` and `StructureChangedEventHandler`. Have the C# process stream JSON deltas over `stdout` to Node. This would drop idle CPU to near 0% and make Liku instantly reactive to UI changes.

### 2. Automated "Trace-to-Quarantine" Loop
*   **Current State:** The `regression:extract` pipeline requires a human to manually point the script at a `.jsonl` trace to generate a regression fixture.
*   **The Improvement:** Integrate the Telemetry/Reflection loop (from the Cognitive Layer) directly with the Regression pipeline. If the `recursive-diagnostician` agent is triggered by a hard failure, it should automatically extract the failing `turn` from the `runtime-trace-log.jsonl`, generate a fixture skeleton, and save it to a `scripts/fixtures/quarantine/` directory. This turns silent user frustration into ready-to-merge test cases for developers.

### 3. Native "Semantic Search" Expansion
*   **Current State:** Slices for `semantic_search_repo` and `grep_repo` were added (Milestone 6).
*   **The Improvement:** The agent frequently struggles to map UI visuals to code implementations. If Liku can parse its own `~/.liku/skills/` directory using the TF-IDF engine, we should expose a `find_skill` or `search_memory` tool directly to the `Researcher` agent. This allows the agent to intentionally query its own long-term memory mid-task, rather than relying strictly on the 1500-token pre-injected context window.

## 4. Conclusion

The architecture described in `brainstorm040826.md` is sound and its execution in the repository is remarkably thorough. The next phase of reliability will not come from building *new* subsystems, but from tightening the seams between the ones that were just built:
1. Syncing implicit OS focus changes with the `execution-context` envelope.
2. Ensuring visual background-capture coordinates are strictly gated by foreground locks before physical input injection.
3. Tail-biasing shell output buffers so the AI doesn't go blind to stack traces.

## 5. Round 2 Deep Scan: Edge Cases & Architectural Blindspots

A secondary, fine-toothed inspection of the actual execution loops (`ai-service.js`) and native bridges (`Program.cs`) reveals a few more subtle but critical blindspots.

### F. The Policy Enforcement Trace Blindspot (Lost Flight Data)
*   **The Design:** Phase 8 added strict policy enforcement ("Brakes before gas"). If the LLM returns an action plan violating an app's `negativePolicies`, `ai-service.js` silently intercepts it, feeds the violation back to the LLM, and regenerates the response (up to 2 times).
*   **The Silent Failure:** This regeneration loop happens *before* `buildRuntimeTraceLogForExecution()` is called. As a result, the `runtime-trace-log.jsonl` only ever records the final, compliant action plan. If the model hallucinates a dangerous action and the policy catches it, **that intervention is never traced**. Regression extractors and telemetry analytics are completely blind to how often policies are saving the system from bad LLM outputs.
*   **Area for Improvement:** The policy regeneration loop must emit a `policy:violation` or `plan:rejected` event into the trace log *during* the while-loop so the safety interventions become visible in evaluation datasets.

### G. Context Ambiguity Pass-Through (Trusting the LLM too much)
*   **The Design:** `execution-context.js` calculates `ambiguityFlags` and assigns a `confidence` level (`high`, `medium`, `low`) to the context envelope.
*   **The Silent Failure:** `ai-service.js` injects this `confidence` into the prompt, but it does **not** enforce it in the runtime. If `confidence` is `low` (e.g., Liku cannot determine the active repo or window), the system relies entirely on the LLM to read "confidence: low" and decide not to emit actions. If the LLM ignores the prompt and emits a destructive action anyway, the runtime will happily execute it. 
*   **Area for Improvement:** `analyzeActionSafety()` should include a hard-coded rail: if `executionContext.confidence === 'low'` and the action is state-mutating, the risk level should automatically escalate to `HIGH` (Requires Confirmation) or `CRITICAL`, regardless of the specific command.

### H. UIA Zero-Bounds Coercion (Rogue Top-Left Clicks)
*   **The Design:** The .NET UIA Host (`src/native/windows-uia/Program.cs`) recursively walks the UI Automation tree and extracts bounding rectangles.
*   **The Silent Failure:** The C# code uses a `SafeNumber(double value)` helper that returns `0` if `double.IsFinite(value)` is false. In WPF, Electron, and Chromium virtualized UI trees, off-screen or unmeasured elements often return `Infinity` or `NaN` for bounds. Coercing these to `0` means virtualized UI elements will silently report their position as `(x=0, y=0, w=0, h=0)`. If the AI targets one of these elements, Liku will perform a real physical click at `0,0`—typically hitting the Windows Start Menu or Apple Menu instead of safely failing with an "element off-screen" error.
*   **Area for Improvement:** `SafeNumber` should be removed for coordinates. Infinite/NaN bounds should be serialized as `null` or excluded entirely so the Node layer knows the element lacks a physical screen presence.

### I. Hardcoded Domain Artifacts (The Pine Version 6 Trap)
*   **The Design:** If the AI outputs an incomplete TradingView script generation plan, Liku triggers a recovery loop (`buildTradingViewPineCodeGenerationPrompt`).
*   **The Silent Failure:** The prompt generation and text normalization helpers (`normalizeGeneratedPineScript`) hardcode the injection of `//@version=6`. If a user explicitly asks Liku to "update my version 4 script" or "write a v5 strategy", the recovery loop will silently force `//@version=6` onto the clipboard. The user pastes the code, and their script breaks due to version incompatibilities.
*   **Area for Improvement:** The version injection should be regex-extracted from the user's surrounding context or existing script buffer, defaulting to `6` only if no prior version is detected.