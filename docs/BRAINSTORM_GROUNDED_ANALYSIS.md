# Grounded analysis for advancing Liku

This document synthesizes brainstormed improvement ideas against current repository reality as of April 2026.

It is intentionally grounded in codebase truth rather than aspirational architecture.

## Executive summary

Liku is **not** an empty shell that still needs its first agentic architecture. The repo already contains substantial building blocks for:

- local-first memory
- skill routing
- dynamic tools with sandboxing
- multi-agent orchestration
- provider/model routing
- telemetry and reflection
- Windows observation and UI automation
- domain-specific TradingView safety hardening

The most important gap is not "add agents" in the abstract. It is to **finish wiring the perception-to-action loop end to end** so the existing architecture becomes more reliable and easier to validate.

In practice, the highest-leverage next steps are:

1. finish inspect/target grounding (`targetId`, inspect instructions, execution resolution)
2. strengthen generic verification/proof, not just TradingView-specific checks
3. formalize trace-driven regression workflows from the telemetry/traces already present
4. only then consider optional sync/cloud backends such as Convex

## Existing capabilities

### 1) Multi-agent orchestration

Already present in two layers:

- **Repo-level orchestration contracts** in `docs/AGENT_ORCHESTRATION.md` and `.github/hooks/**`
- **Runtime local agent stack** in `src/main/agents/`

Grounded evidence:

- `src/main/agents/supervisor.js`
- `src/main/agents/builder.js`
- `src/main/agents/researcher.js`
- `src/main/agents/verifier.js`
- `src/main/agents/orchestrator.js`
- `src/main/agents/state-manager.js`
- `src/main/agents/trace-writer.js`

The supervisor implementation already plans, decomposes, delegates, and aggregates. This means the brainstorm recommendation to "adopt agent orchestration" is only partially correct: Liku already has one, but it needs continued hardening and deeper integration.

### 2) Memory systems

Liku already has a concrete local-first persistence model under `~/.liku/`.

Grounded evidence:

- `src/shared/liku-home.js`
- `src/main/memory/memory-store.js`
- `src/main/memory/memory-linker.js`

`liku-home.js` establishes canonical storage for memory, skills, tools, telemetry, and traces, and also migrates legacy state from `~/.liku-cli`.

This is a real memory architecture, even if it is still lightweight and local.

### 3) Skills and retrieval

Skill routing is already implemented.

Grounded evidence:

- `src/main/memory/skill-router.js`
- `src/cli/commands/skills.js`

The repo already supports a local skill library and routing behavior. So the brainstorm idea of a "skill registry" is best understood as a request to expand and formalize an existing system, not invent a new one.

### 4) Dynamic tools, sandboxing, and permissions

This area is more mature than the brainstorm implied.

Grounded evidence:

- `src/main/tools/tool-registry.js`
- `src/main/tools/tool-validator.js`
- `src/main/tools/sandbox.js`
- `src/main/tools/sandbox-worker.js`
- `src/main/tools/hook-runner.js`
- `.github/hooks/**`

Liku already has:

- dynamic tool lifecycle management
- static validation
- isolated execution
- hook-enforced boundaries

This makes "add sandboxing / tool permissions" an **already implemented** category, though it can still be expanded.

### 5) Provider routing and model selection

Provider/model routing is already part of the architecture.

Grounded evidence from docs and tests:

- `ARCHITECTURE.md`
- `src/main/ai-service/providers/registry.js`
- `src/main/ai-service/providers/orchestration.js`
- `src/main/ai-service/providers/copilot/model-registry.js`
- `scripts/test-ai-service-provider-orchestration.js`

This means the brainstorm suggestion around tiered model routing is directionally valid, but should build on the current provider orchestration layer rather than replace it.

### 6) Observability, telemetry, reflection, analytics

This is already present in first-generation form.

Grounded evidence:

- `src/main/telemetry/telemetry-writer.js`
- `src/main/telemetry/reflection-trigger.js`
- `src/main/agents/trace-writer.js`
- `src/cli/commands/analytics.js`

The repo already has:

- structured telemetry
- reflection triggers
- traces
- CLI analytics surface

So the brainstorm recommendation is best reframed as: **upgrade and operationalize observability**, not "start observability from zero."

### 7) TradingView workflow hardening

This is one of the strongest examples of domain-specific hardening in the repo.

Grounded evidence:

- `src/main/tradingview/chart-verification.js`
- `src/main/tradingview/pine-workflows.js`
- `src/main/tradingview/verification.js`
- `src/main/tradingview/dom-workflows.js`
- `src/main/tradingview/paper-workflows.js`
- `scripts/test-tradingview-chart-verification.js`
- `scripts/test-tradingview-pine-data-workflows.js`
- `scripts/test-windows-observation-flow.js`

Relevant truth:

- TradingView workflows are already rewritten into safer bounded verification-first plans.
- DOM order-entry and flatten/reverse operations are explicitly treated as high or critical risk.
- Pine Editor workflows already use guarded continuation and visible-state validation patterns.

This is not hypothetical architecture; it is already a meaningful safety specialization.

### 8) Security boundaries

Security boundaries already exist at multiple levels:

- Electron renderer isolation and CSP (`ARCHITECTURE.md`)
- sandboxed dynamic tools
- hook-gated execution paths
- TradingView advisory rails for unsafe flows

This does **not** mean security is finished, but it does mean the repo is not starting from a naive trust model.

### 9) UI/overlay/Windows observation

Liku already has meaningful Windows observation and overlay architecture.

Grounded evidence:

- `src/main/index.js`
- `src/main/visual-awareness.js`
- `src/main/system-automation.js`
- `src/main/ui-automation/window/manager.js`
- `src/shared/inspect-types.js`
- `src/main/inspect-service.js`
- `src/renderer/overlay/overlay.js`

The real gap here is **integration completeness**, not total absence.

## Brainstorm truth table

## Already implemented

These brainstorm themes are already present in real code:

- multi-agent orchestration
- local-first memory
- skill routing
- dynamic tool registry
- sandboxed tool execution
- hook-based permission boundaries
- provider/model orchestration
- telemetry / reflection / traces
- domain-specific TradingView workflow hardening
- Electron security defaults

## Partially implemented / present in early form

These exist, but not yet as fully generalized platform features:

### Inspect-grounded targeting

Grounded evidence:

- `src/shared/inspect-types.js` defines `targetId`
- overlay/main-process flow passes inspect-related data
- `src/main/inspect-service.js` defines `generateAIInstructions()`

But the key missing seam is that `generateAIInstructions()` appears scaffolded rather than fully wired through prompt assembly/execution, and `targetId` does not yet appear to resolve end-to-end into concrete execution semantics.

This is a major near-term opportunity.

### Generic proof-carrying verification

Liku has strong TradingView-specific verification, but not yet a generalized verification layer with consistent before/after evidence summaries across all automation domains.

### Window-awareness enrichment

`src/main/ui-automation/window/manager.js` already enriches metadata such as owned/tool/palette style window categories, but not all of the higher-order context imagined in the brainstorm is fully available or consumed.

### Regression/eval platformization

The repo has many targeted scripts and trace/telemetry infrastructure, but this has not yet become a unified evaluation platform.

## Absent but good future directions

These are mostly not present, but are potentially worthwhile later:

- cross-device synchronized memory
- centralized skill/version performance dashboards
- formal plugin marketplace / signed extension model
- distributed tracing via OpenTelemetry
- generalized RAG/web retrieval layer for repo + external grounding
- automated benchmark suites with outcome + trajectory scoring
- cloud-backed shared eval artifacts

## Misaligned or lower priority than they sound

### "Add multi-agent orchestration"

Misleading framing. The repo already has orchestration. The higher-value question is how to:

- tighten routing
- preserve evidence
- improve validation
- reduce execution ambiguity

### "Add self-improvement"

Partially misframed. Reflection and telemetry already exist. The next step is not unconstrained recursive self-modification; it is safer, bounded, evidence-backed improvement loops.

### "Adopt a backend now"

Lower priority than it sounds. A cloud backend may be useful eventually, but the codebase is intentionally local-first today. Reliability, grounding, and verification are higher leverage than backend centralization right now.

## Convex assessment

## Short answer

Convex could be useful **later**, but it is **not** the most natural immediate next move for this codebase.

## Why it is not the default fit today

Liku is architected around a local-first runtime:

- CLI-first and optional Electron overlay
- local filesystem state under `~/.liku/`
- Windows desktop/UI automation emphasis
- local JSON/JSONL-style persistence and traces

That means the current architecture optimizes for:

- offline use
- local privacy
- low operational complexity
- direct desktop automation

Convex would introduce new architectural questions:

- authentication and account model
- sync/conflict semantics
- privacy boundaries for screenshots, traces, and memory
- upload policy for potentially sensitive workspace/runtime data

## Where Convex could help later

Convex makes more sense as an **optional sync/eval backend** than as the core system of record.

Good later uses:

- shared regression fixtures
- team telemetry dashboards
- skill usage/performance dashboards
- opt-in memory or skill sync
- background evaluation jobs over exported traces

## Recommended stance

Keep `~/.liku` as the canonical source of truth.

If Convex is added later, start with:

1. export/import of sanitized traces and skill metadata
2. dashboards and shared evaluation workflows
3. only then optional sync for selected user artifacts

That approach fits the current architecture much better than replacing local persistence with a cloud-first dependency.

## Prioritized roadmap

## Near-term high leverage (1-3 iterations)

### 1. Finish inspect-to-execution grounding

Why:

- The repo already has inspect schemas and service scaffolding.
- This closes a key reliability gap between what the model references and what the executor can safely act on.

Likely touchpoints:

- `src/main/inspect-service.js`
- `src/main/ai-service.js`
- `src/main/ai-service/message-builder.js`
- `src/shared/inspect-types.js`
- `src/main/index.js`

### 2. Add generic verification summaries

Why:

- Liku already does this well for TradingView.
- Generalizing the pattern would raise safety and debuggability across the system.

Likely touchpoints:

- `src/main/visual-awareness.js`
- `src/main/system-automation.js`
- `src/main/ai-service.js`
- telemetry/trace writers

### 3. Turn traces into first-class regression assets

Why:

- The repo already contains traces, telemetry, and many focused regression scripts.
- Formalizing replay/eval inputs would increase confidence without speculative architecture churn.

Likely touchpoints:

- `src/main/agents/trace-writer.js`
- `src/main/telemetry/telemetry-writer.js`
- `scripts/run-transcript-regressions.js`
- `scripts/extract-transcript-regression.js`

### 4. Harden dynamic-title and focus-precondition verification

Why:

- Current test evidence shows one remaining failure in `scripts/test-windows-observation-flow.js`.
- The failure mode is about bounded Pine readback under dynamic titles / missing stable focus attachment.

Likely touchpoints:

- `src/main/ai-service.js`
- `src/main/system-automation.js`
- `src/main/tradingview/pine-workflows.js`
- `src/main/tradingview/chart-verification.js`

## Medium-term platform upgrades

### 5. Formalize capability-aware model/provider routing

Why:

- The provider orchestration layer already exists.
- The next win is more explicit routing by task class, cost, and proof requirements.

Likely touchpoints:

- `src/main/ai-service/providers/orchestration.js`
- `src/main/ai-service/providers/registry.js`
- model registry modules

### 6. Build a stricter evaluation harness

Why:

- The repo already has many targeted tests.
- It lacks a more unified scorecard for task success, verification quality, and failure modes.

Likely touchpoints:

- `scripts/test-*.js`
- `TESTING.md`
- telemetry analytics surface

### 7. Expand skill lifecycle management

Why:

- Skills already exist locally.
- Higher leverage now is ranking/versioning/retirement based on usage and outcomes.

Likely touchpoints:

- `src/main/memory/skill-router.js`
- `src/cli/commands/skills.js`
- telemetry integration

## Longer-term bets

### 8. Optional external retrieval / grounded web context

Good longer-term platform bet if it remains bounded and citation-oriented.

### 9. Optional cloud sync / Convex-backed dashboards

Only after local-first reliability remains intact.

### 10. Formal plugin ecosystem

Potentially valuable, but only once the current local tool/plugin boundaries are more mature.

## Key file evidence

- `ARCHITECTURE.md`
- `docs/AGENT_ORCHESTRATION.md`
- `src/shared/liku-home.js`
- `src/main/memory/memory-store.js`
- `src/main/memory/memory-linker.js`
- `src/main/memory/skill-router.js`
- `src/main/tools/tool-registry.js`
- `src/main/tools/tool-validator.js`
- `src/main/tools/sandbox.js`
- `src/main/tools/sandbox-worker.js`
- `src/main/tools/hook-runner.js`
- `src/main/agents/supervisor.js`
- `src/main/agents/orchestrator.js`
- `src/main/agents/trace-writer.js`
- `src/main/ui-automation/window/manager.js`
- `src/main/inspect-service.js`
- `src/shared/inspect-types.js`
- `src/main/tradingview/chart-verification.js`
- `src/main/tradingview/pine-workflows.js`
- `src/main/tradingview/dom-workflows.js`
- `src/main/tradingview/paper-workflows.js`
- `scripts/test-tradingview-chart-verification.js`
- `scripts/test-tradingview-pine-data-workflows.js`
- `scripts/test-windows-observation-flow.js`

## Bottom line

The strongest interpretation of the brainstorm is:

- **do not restart the architecture from scratch**
- **finish the seams that are already present**
- **lean into proof, verification, and local-first strengths**
- **treat cloud sync and broader self-improvement as later multipliers, not first moves**

That path is the best match for current codebase truth.