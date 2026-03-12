# Project Status

## Current State
- Status: active development on `main`
- Published package version: `0.0.13`
- Latest tagged version: `0.0.14` (2026-03-07)
- Unreleased work: v0.0.15 Cognitive Layer (Phases 0–14, 2026-03-12)
- Latest local commits:
  - `fde64b0` - feat: implement N1-N6 next-stage roadmap
  - `8aefc19` - Phase 9: Design-level hardening (Gemini audit)
  - `f1fa1a6` - Phase 8: audit-driven fixes
  - `bc27d62` - feat: cognitive layer phases 6-7
  - `9c335d4` - chore: ignore .tmp-hook-check test artifacts
  - `461ce31` - feat: cognitive layer phases 0–5

## Delivered Since Last Publish

### v0.0.15 Cognitive Layer (Unreleased — 2026-03-12)

**Phase 9: Design-Level Hardening** (commit `8aefc19`)
- BPE token counting via `js-tiktoken` (cl100k_base) replaces character heuristics.
- Tool proposal→approve→register flow with `tools/proposed/` quarantine directory.
- Process-isolated sandbox via `child_process.fork()` replaces in-process `vm.createContext`.
- `message-builder.js` accepts explicit `skillsContext`/`memoryContext` params.
- CLI `liku tools proposals` and `liku tools reject` subcommands.

**Phase 8: Audit-Driven Fixes** (commit `f1fa1a6`)
- Telemetry schema fix: `recordAutoRunOutcome` uses proper `writeTelemetry({ task, phase, outcome })`.
- Skill index staleness pruning via `fs.existsSync` on load.
- Word-boundary regex for keyword matching (prevents false positives).
- AWM PreToolUse gate + PostToolUse audit hook for reflection passes.
- Hook import fix + trace writer signature fix in ai-service.js.

**Phase 7: Next-Level Enhancements** (commit `bc27d62`)
- AWM procedural memory extraction from successful multi-step sequences → auto-skill registration.
- PostToolUse hook wiring for dynamic tools with audit-log.ps1.
- Unapproved tools filtered from API definitions (model only sees callable tools).
- CLI subcommands: `liku memory`, `liku skills`, `liku tools`.
- Telemetry summary analytics API (`getTelemetrySummary`).

**Phase 6: Safety Hardening** (commit `bc27d62`)
- PreToolUse hook enforcement via `hook-runner.js`.
- Bounded reflection loop (max 2 iterations).
- Session failure count decay on success.
- Phase params forwarded to all providers (OpenAI/Anthropic/Ollama).
- Memory LRU pruning at 500 notes; telemetry log rotation at 10MB.

**Phases 0–5: Core Cognitive Layer** (commit `461ce31`)
- Structured `~/.liku/` home directory with copy-based migration.
- Agentic Memory (A-MEM): CRUD, Zettelkasten linking, keyword relevance, token-budgeted injection.
- RLVR Telemetry: structured logging, reflection trigger, phase-aware temperature params.
- Dynamic Tool Generation: VM sandbox, approval gate, security hooks.
- Semantic Skill Router: keyword matching, usage tracking, budget control.
- Deeper Integration: system prompt awareness, slash commands, policy wiring.

**Test coverage**: 310 cognitive + 29 regression = **339 assertions**, 0 failures, 15+ suites.

### N1-N6 Next-Stage Roadmap (commit `fde64b0`)

- **N3 — E2E Smoke Test** (Phase 10): Full pipeline test for dynamic tools — propose, quarantine, approve, fork-execute, verify result, telemetry audit. 17 assertions.
- **N1-T2 — TF-IDF Skill Routing** (Phase 11): Pure JS cosine similarity scoring alongside keyword matching. Zero new dependencies. 16 assertions.
- **N4 — Session Persistence** (Phase 12): `saveSessionNote()` writes episodic memory note on chat exit, capturing user message keywords for future retrieval.
- **N6 — Cross-Model Reflection** (Phase 13): `/rmodel` command routes reflection passes to a reasoning model (o1/o3-mini) instead of default chat model. 12 assertions.
- **N5 — Analytics CLI** (Phase 14): `liku analytics [--days N] [--raw]` reads telemetry JSONL and displays success rates, top tasks, phase breakdown, common failures.

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
- `src/main/ai-service.js`: compatibility facade, orchestration, cognitive feedback loop (AWM + RLVR).
- `src/main/ai-service/`: extracted prompt, context, command, registry, orchestration, and phase-params modules.
- `src/main/memory/`: agentic memory store, memory linker, semantic skill router.
- `src/main/telemetry/`: telemetry writer (with rotation + summary), reflection trigger.
- `src/main/tools/`: dynamic tool sandbox, validator, registry, hook runner.
- `src/main/system-automation.js`: action parsing/execution with PreToolUse + PostToolUse hooks.
- `src/cli/commands/`: CLI commands including memory, skills, tools subcommands.
- `src/shared/liku-home.js`: centralized `~/.liku/` home directory management.

## Near-Term Priorities
1. Auto-registration for hook-approved tools (Phase 3c — sandbox test + hook gate).
2. Optional Ollama embeddings for skill routing (N1-T3 — replaces TF-IDF when local model available).
3. Continue shrinking `src/main/ai-service.js` while preserving the compatibility facade.

## Notes
This file supersedes older "implementation complete" snapshots that described the project as an initial Electron-only deliverable. The current system is a broader CLI + automation runtime with ongoing reliability hardening.