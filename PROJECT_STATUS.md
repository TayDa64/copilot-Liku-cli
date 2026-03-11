# Project Status

## Current State
- Status: active development on `main`
- Published package version: `0.0.13`
- Latest tagged version: `0.0.14` (2026-03-07)
- Unreleased work: 2026-03-08 (capability separation, plan-only routing, UIA prevalidation)
- Latest local commits:
  - `7fc1698` - fix: choose best action block and rewrite youtube search intents
  - `eaea6c5` - feat: add browser session continuity state

## Delivered Since Last Publish

### Capability-Based Model Routing (Unreleased)
- Replaced the old vision-only model distinction with a richer capability matrix.
- Grouped Copilot models into `Agentic Vision`, `Reasoning / Planning`, and `Standard Chat`.
- Surfaced explicit reroute notices instead of silent model swaps.
- Added `(plan)` routing to the supervisor in non-destructive plan-only mode.
- Added live UI target prevalidation before coordinate clicks.
- Hardened Windows process enumeration (inaccessible `StartTime` no longer crashes).

## Delivered in This Session

### Multi-Agent Enforcement Hardening
- Added deterministic worker artifact persistence under `.github/hooks/artifacts/`.
- Updated hook enforcement so read-only workers can write only to their artifact path, not arbitrary repo files.
- Added local proof harnesses for allow/deny/quality-gate behavior.

### AI Service Facade Refactor
- Extracted system prompt generation, message assembly, slash-command handling, provider registry/model registry helpers, and provider orchestration behind the `src/main/ai-service.js` compatibility facade.
- Preserved compatibility markers in the facade for source-sensitive regression tests while reducing internal coupling.

### Verification Coverage
- Added targeted characterization tests for contract stability, command handling, provider orchestration, registry state, policy enforcement, preference parsing, and runtime state seams.
- Confirmed fresh local passes for provider orchestration, contract, feature, and bug-fix suites.

## Recently Stabilized

### Reliability and Continuity
- Browser continuity state remains integrated into prompt steering and `/status` output.
- `/clear` continues to reset continuity and history state together.

### Deterministic Execution Behavior
- Multi-block action parsing and deterministic browser rewrites remain in place.
- Policy regeneration and non-action guardrails remain active during the modularization work.

## Operational Health
- No static diagnostics errors on modified implementation files after updates.
- Fresh provider-seam verification completed with successful contract and regression checks.

## Core Runtime Areas
- `src/main/ai-service.js`: compatibility facade, orchestration, and remaining execution/safety flows.
- `src/main/ai-service/`: extracted prompt, context, command, registry, and orchestration modules.
- `src/main/system-automation.js`: action parsing/execution and platform automation primitives.
- `src/cli/commands/chat.js`: terminal interaction loop and execution controls.

## Near-Term Priorities
1. Extract concrete provider HTTP clients behind the existing orchestration seam.
2. Continue shrinking `src/main/ai-service.js` while preserving the compatibility facade.
3. Expand characterization coverage around execution and post-verification seams.

## Notes
This file supersedes older "implementation complete" snapshots that described the project as an initial Electron-only deliverable. The current system is a broader CLI + automation runtime with ongoing reliability hardening.