# Implementation Summary

## Scope
This summary reflects the current state of `copilot-liku-cli` as of 2026-03-08, including the model capability separation, planning-mode routing, and automation hardening work completed in the latest implementation pass.

## Current Architecture
- CLI-first runtime with optional Electron overlay.
- `liku chat` headless interactive mode with AI planning and action execution.
- Native Windows automation layer (`system-automation.js`) with window/process controls and UI automation integration.
- Reliability pipeline in `ai-service.js`:
  - action normalization
  - deterministic rewrites for known intent patterns
  - bounded post-action verification and self-heal
  - policy rails and safety confirmation handling
- Capability-aware Copilot model routing with explicit runtime metadata and grouped model inventory.
- Shared CLI/Electron model-selection UX backed by the Copilot model registry.

## Session Implementations (2026-03-08)

### 1. Capability-Based Copilot Model Registry
Implemented a richer Copilot model schema in `src/main/ai-service/providers/copilot/model-registry.js`.

Behavior added:
- static and dynamic models now carry a `capabilities` object instead of relying only on `vision`.
- chat-facing models are grouped into `Agentic Vision`, `Reasoning / Planning`, and `Standard Chat` buckets.
- completion-only models are excluded from chat selectors.
- legacy-unavailable model ids such as `gpt-5.4` are canonicalized for backward compatibility but removed from the active picker inventory.

### 2. Explicit Capability Routing and Runtime Transparency
Updated Copilot/provider routing in `src/main/ai-service/providers/orchestration.js` and `src/main/ai-service.js`.

Behavior added:
- visual, automation, and planning requests now route through capability-aware defaults.
- reroutes are surfaced back to the caller as explicit routing notes.
- unsupported chat-endpoint model selections now fail clearly instead of silently falling through as if they were valid.
- runtime selection metadata is persisted and exposed through `/status` and `getStatus()`.

### 3. Shared Model UX Across CLI and Electron
Updated grouped model presentation and selection behavior in:
- `src/main/ai-service/commands.js`
- `src/cli/commands/chat.js`
- `src/renderer/chat/chat.js`
- `src/main/index.js`

Behavior added:
- `/model` now renders grouped model lists.
- terminal picker shows category headers and capability tags.
- Electron chat hydrates its model selector from live AI status instead of stale hard-coded assumptions.
- AI status is now pushed back to the renderer after `/model`, `/provider`, and related status-changing commands so the selector stays aligned with the backend state.

### 4. Plan-Only Multi-Agent Routing
Added non-destructive planning mode on top of the existing agent system.

Behavior added:
- `(plan)` in CLI and Electron routes to the existing supervisor/orchestrator stack.
- `agent-run` supports `mode: 'plan-only'`.
- plan results return step breakdowns, assumptions, and dependency information without executing file mutations.

### 5. UI Automation Prevalidation and Process Query Hardening
Added watcher-backed target verification before coordinate clicks in `src/main/ai-service.js` and hardened Windows process enumeration in `src/main/system-automation.js`.

Behavior added:
- coordinate clicks now fail early if the live UI target does not match the expected element.
- inaccessible process `StartTime` values no longer crash the PowerShell process enumeration path.

### 6. Existing Continuity and Reliability Work Retained
The earlier browser continuity and action parsing improvements remain part of the active runtime. That includes the lightweight in-memory `BrowserSessionState` in `src/main/ai-service.js` with:
- `url`
- `title`
- `goalStatus` (`unknown`, `in_progress`, `achieved`, `needs_attention`)
- `lastStrategy`
- `lastUserIntent`
- `lastUpdated`

Behavior added:
- Injected as explicit system context in `buildMessages(...)` so model planning is grounded by concrete browser continuity state.
- Exposed via `/status` (`getStatus()`).
- Reset by `/clear`.
- Updated from deterministic rewrite selection and post-execution outcomes.

### 7. Multi-Block JSON Parsing Fix
Updated `parseAIActions(...)` in `src/main/system-automation.js`.

Before:
- parser captured only the first fenced JSON block.

After:
- parser scans all fenced JSON blocks.
- normalizes each candidate action list.
- scores candidates and selects the best executable plan.

Result:
- fixes execution failures where the first block is a short focus preface and later blocks contain the actual workflow.

### 8. Deterministic Browser Rewrite Upgrade (No-URL YouTube)
Added intent inference for prompts like:
- "using edge open a new youtube page, then search for stateful file breakdown"

When browser + YouTube + search intent is present and the model output is low-signal/fragmented, the plan is rewritten into a complete deterministic sequence:
- focus browser
- navigate to `https://www.youtube.com`
- run search query

This closes a gap where deterministic rewrite previously depended on explicit URLs.

### 9. Chat Continuity and Execution Guardrails
Documented and retained in current implementation:
- non-action/chit-chat guard in terminal chat to avoid accidental execution on acknowledgements.
- continuity rule in prompt policy to avoid unnecessary screenshot detours when objective appears already achieved.
- optional popup follow-up recipes (`/recipes on|off`) for bounded first-launch dialog handling.

## Validation Performed
- Static diagnostics: no errors reported on changed files.
- Targeted regression passes:
  - `node scripts/test-ai-service-model-registry.js`
  - `node scripts/test-ai-service-provider-orchestration.js`
  - `node scripts/test-ai-service-commands.js`
- Full local regression batch completed successfully in `regression-run.log`.

## Files Updated in Session
- `src/main/ai-service.js`
- `src/main/ai-service/commands.js`
- `src/main/ai-service/providers/copilot/model-registry.js`
- `src/main/ai-service/providers/orchestration.js`
- `src/main/ai-service/providers/registry.js`
- `src/main/system-automation.js`
- `src/main/index.js`
- `src/main/agents/orchestrator.js`
- `src/cli/commands/chat.js`
- `src/renderer/chat/chat.js`
- `src/renderer/chat/preload.js`
- `scripts/test-ai-service-model-registry.js`
- `scripts/test-ai-service-provider-orchestration.js`
- `scripts/test-ai-service-commands.js`

## Outcome
The runtime now treats model capability as a first-class concern, keeps the CLI and Electron selector surfaces aligned with backend state, exposes explicit routing behavior to the user, adds plan-only multi-agent review mode, and blocks stale-target coordinate clicks before low-level automation fires.