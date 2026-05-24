# Copilot-Liku CLI Defensive-First GitHub Automation Source Plan

Date: 2026-05-23  
Source research: `C:\Users\Tay Liku\Downloads\Copilot-Liku-CLI Defensive-First Multi-Agent CI-CD Implementation Plan v2.1.pdf`

## 1. Purpose

This document translates the research PDF into a repo-grounded implementation plan for evolving Copilot-Liku CLI into a defensive-first assistant that can operate GitHub on behalf of the user.

The goal is **not** to replace current functionality. The goal is to add GitHub operating capability through stable seams, policy gates, and testable adapters while preserving the current CLI experience, packaging flow, and existing behavior that already builds and tests green.

## 2. Repo-grounded baseline

Before implementation, treat the active branch as source of truth and re-verify these seams:

- `package.json` already defines a TypeScript/Node CLI build, dev, start, and test flow.
- `src/cli.ts` is the thin CLI entrypoint and must remain thin.
- `src/index.ts` is part of the current runtime path and should remain the main orchestration edge for existing interactive behavior unless deliberately split.
- `src/config.ts` is the natural home for config/env resolution and should stay the primary config seam.
- The repo already has a GitHub Actions CI workflow that runs lint/build/test-style checks; hardening should extend that rather than replace it wholesale.
- Build and test were verified green during this research pass, so the current behavior is worth preserving with explicit regression coverage.

Additional supporting modules may vary by branch iteration, but current source snapshots indicate that local state/session, prompting, cache/history, and type definitions already exist or are in progress. Those should be treated as extension seams, not as reasons to rewrite the app from scratch.

## 3. What “operate GitHub on behalf of the user” means here

Copilot-Liku should eventually be able to help with:

- repository inspection
- issue triage
- pull request review support
- workflow/run inspection
- branch and release assistance
- filing comments, reviews, or draft changes
- preparing but not silently executing higher-risk GitHub actions

It should **not** start as an unrestricted shell-driven agent. The PDF is correct that autonomy must be bounded behind a typed command seam, explicit policies, approvals, and traceability.

## 4. Non-regression contract

The following behaviors must remain stable while we add GitHub capability:

1. Current CLI invocation patterns continue to work.
2. Existing config loading and environment variable precedence continue to work.
3. Existing model/runtime behavior remains available for current users.
4. Existing build and test commands stay green throughout rollout.
5. Existing README usage and current packaging expectations are updated, not broken silently.
6. Existing local state/history/session data formats are preserved or migrated compatibly.
7. New GitHub automation features default to safe, explicit, least-privilege behavior.

## 5. Core synthesis from the PDF

The PDF’s strongest recommendations are correct and should drive implementation order:

- Extract a stable command seam first.
- Treat agent/tool behavior as untrusted until policy-checked.
- Make every GitHub capability an adapter with typed input/output.
- Add memory, telemetry, and trace only after they can be redacted and bounded.
- Keep CI/CD split by concern: validate, test, package, release, policy.
- Use staged rollout, feature flags, dry-run mode, approval mode, and kill switches.
- Prefer reusable workflows, pinned actions, OIDC, provenance, SBOM, and protected environments.

Repo-specific translation: because the current codebase is a small TypeScript CLI, we should add seams incrementally rather than jump directly to a large multi-agent runtime.

## 6. Target architecture for this repo

### 6.1 Stable top-level flow

Keep the current top-level shape:

- `src/cli.ts` remains responsible for argument parsing and user-facing command registration.
- `src/index.ts` remains responsible for interactive runtime entry behavior.
- `src/config.ts` remains responsible for config/env resolution.

New behavior should be introduced under additive seams such as:

- `src/command-seam/`
- `src/github/`
- `src/tools/`
- `src/policy/`
- `src/telemetry/`
- `src/memory/` or `src/state/` (only if needed; otherwise extend existing session/history modules)
- `src/agents/` (only after the non-agent command seam is stable)

### 6.2 Command seam

All meaningful actions should go through one typed execution boundary, for example:

- `chat.send`
- `github.repo.inspect`
- `github.issue.list`
- `github.issue.comment`
- `github.pr.review`
- `github.workflow.inspect`
- `github.release.prepare`

Each command should carry:

- command id
- typed payload
- side-effect class (`read`, `local-write`, `github-write`, `high-risk`)
- dry-run capability if feasible
- approval requirement
- trace metadata

This seam is the foundation for policy, audit, retries, testing, and eventual agent orchestration.

### 6.3 GitHub adapter layer

GitHub operations should not be implemented by prompt-only behavior. They should be implemented by adapters wrapping GitHub APIs and related repo context access.

Recommended adapter groups:

- `github/auth` — token resolution, scope detection, user identity checks
- `github/client` — REST/GraphQL transport wrapper
- `github/repos` — repo metadata, branches, default branch, protections
- `github/issues` — list/get/create/comment/label
- `github/pulls` — list/get/diff/comment/review/create
- `github/workflows` — list runs, inspect jobs, rerun, dispatch where allowed
- `github/releases` — draft/create/list artifacts and notes
- `github/checks` — status and required checks visibility

Each adapter must expose structured results and structured failures.

### 6.4 Tool registry

GitHub adapters should be registered as tools/capabilities, not called ad hoc from all over the codebase.

Each tool entry should declare:

- tool name
- description
- JSON-schema-like input contract
- output contract
- side-effect level
- required approvals
- timeout budget
- rate-limit expectations
- secrets used
- redaction rules for logs/trace

Default stance: deny by default unless explicitly enabled.

### 6.5 Memory and state

The repo already has local configuration and likely session/history/state seams. Extend those carefully into three layers:

- ephemeral run context — current conversation, current repo, current branch, current user request
- task memory — short-lived plan state, approvals, tool results, temporary summaries
- durable knowledge — explicitly approved memory such as repo preferences or trusted workflow conventions

Do not allow raw GitHub issue/PR text, secrets, or tokens to become uncontrolled long-term memory.

### 6.6 Telemetry and trace

Tracing should be local-first and privacy-aware.

Every command/tool execution should be traceable via:

- session id
- trace id
- command id
- tool name
- approval state
- start/end timestamps
- success/failure status
- error category
- git remote/branch/commit when available
- GitHub repo/issue/PR/workflow identifiers when relevant

Logs should redact:

- tokens
- secrets
- authorization headers
- sensitive issue/PR content beyond configured limits
- large diffs unless explicitly requested and approved

## 7. Capability model for GitHub operation

Implement in this order.

### Tier 1 — Read-only capabilities

Safe first capabilities:

- identify current repo from local git remote
- inspect GitHub auth status and token scopes
- fetch repo metadata
- list/open issues and pull requests
- inspect workflow runs and statuses
- read release history
- summarize changed files and diffs

These should work in dry-run/observation mode and require no mutation approval.

### Tier 2 — Low-risk write capabilities

- draft issue comments
- draft PR comments/reviews
- label suggestions with approval
- prepare workflow dispatch requests
- prepare release notes and draft release payloads

These should support explicit preview before submit.

### Tier 3 — Mutating GitHub actions with approval

- create issues/PRs
- post comments/reviews
- dispatch workflows
- rerun jobs
- manage labels/milestones
- create draft releases

These require approval checkpoints, trace, and idempotency safeguards.

### Tier 4 — High-risk capabilities

- merge PRs
- edit protected branches
- change workflow files
- publish packages/releases
- alter repository settings

These should remain explicitly gated, likely off by default, and may need human-confirmed multi-step approval.

## 8. Phased implementation plan

### Phase 0 — Baseline, inventory, and safety rails

Objective: stabilize what exists before expanding.

Tasks:

- Re-open and document current source-of-truth files before coding each phase.
- Add or tighten regression tests around current CLI invocation, config loading, and interactive flow.
- Introduce feature flags:
  - `LIKU_ENABLE_GITHUB`
  - `LIKU_ENABLE_AGENTS`
  - `LIKU_ENABLE_DYNAMIC_TOOLS`
  - `LIKU_APPROVAL_MODE`
  - `LIKU_DRY_RUN_DEFAULT`
- Add a no-op trace envelope around current commands with no behavior change.
- Document current env vars and config precedence in README.

Exit criteria:

- current build and tests still pass
- current CLI UX unchanged by default
- trace scaffolding exists but is non-invasive

### Phase 1 — Extract the typed command seam

Objective: make all current and future actions route through a stable execution contract.

Tasks:

- Add typed command request/result interfaces.
- Add a central `executeCommand()` orchestration boundary.
- Route current interactive/chat actions through the seam first.
- Keep `src/cli.ts` as a thin adapter from argv to command requests.
- Add tests for command validation, dry-run behavior, and error normalization.

Exit criteria:

- existing user-facing behavior preserved
- command execution is centrally interceptable
- a new capability can be added without editing the interactive runtime directly

Phase 0/1 verification command for this repo slice:

```bash
npm run test:cli-phase01
```

### Phase 2 — Add GitHub auth and read-only adapters

Objective: enable safe observation before mutation.

Tasks:

- Resolve GitHub token sources in `src/config.ts` or a dedicated auth module.
- Add a GitHub client wrapper with typed errors and rate-limit awareness.
- Implement read-only commands first:
  - repo inspect
  - issue list/get
  - PR list/get/diff summary
  - workflow run list/get
  - release list/get
- Add output formatters for concise terminal summaries plus structured JSON output.
- Add snapshot/contract tests using mocked GitHub responses.

Exit criteria:

- GitHub read-only flows work without affecting existing chat flows
- failures are structured and non-destructive
- traces redact credentials

Phase 2 verification command for this repo slice:

```bash
npm run test:github-phase2
```

### Phase 3 — Tool registry and policy engine

Objective: formalize capabilities before agent autonomy.

Current incremental implementation target for this repo slice:

- register the shipped read-only GitHub capabilities with declared schema, risk, side-effect, and source metadata
- route both `liku github ...` and shared `/github ...` execution through a common registry-aware executor
- apply a read-only capability policy gate before adapter execution
- emit structured telemetry records for each registered GitHub capability run
- expose read-only capability catalog commands so humans and future bounded agents can inspect the approved GitHub surface directly

Tasks:

- Create a tool registry for all GitHub and local tools.
- Add policy evaluation before tool execution.
- Introduce side-effect classes and approval requirements.
- Add per-tool dry-run support where feasible.
- Add structured audit records for every tool invocation.

Exit criteria:

- no mutating tool runs without passing registry + policy checks
- every tool has a schema and declared risk level
- logs/trace are usable for replay and diagnosis

Phase 3 verification command for this repo slice:

```bash
npm run test:github-phase3
```

### Phase 4 — Introduce bounded agent orchestration

Objective: let Copilot-Liku plan and execute GitHub work safely.

Current incremental implementation target for this repo slice:

- add a deterministic `github plan build ...` bridge that emits a typed one-step execution plan from the registered GitHub capability catalog
- keep the planning artifact read-only and registry-backed instead of allowing free-form shell execution
- reuse the same registry + policy metadata that the CLI and shared `/github ...` executor already enforce
- add a bounded `github plan execute ...` path that enforces explicit step/time budgets and writes replayable plan/result artifacts while remaining limited to registered read-only capabilities

Recommended initial roles:

- planner — converts user goal into typed steps
- executor — calls approved commands/tools only
- reviewer — checks plan/output against policy and user intent

Rules:

- no free-form shell execution
- no recursive autonomy without explicit caps
- maximum step count and timeout budgets
- deterministic handoff artifacts (JSON or typed objects)
- mutation steps require approval unless explicitly allowed by policy

Exit criteria:

- agent flow produces auditable plans and tool traces
- bounded execution is enforced technically, not just by prompt text

Phase 4 bridge verification command for this repo slice:

```bash
npm run test:github-phase4-bridge
```

Phase 4 bounded executor verification command for this repo slice:

```bash
npm run test:github-phase4-executor
```

### Phase 5 — Memory, context, and audit controls

Objective: improve continuity without uncontrolled persistence.

Tasks:

- Classify memory entries by sensitivity and retention.
- Keep task memory separate from durable knowledge.
- Add redaction filters for issue bodies, diffs, secrets, tokens, and workflow logs.
- Add explicit export/import review if durable memory is introduced.
- Reuse or extend current session/history/state modules instead of replacing them abruptly.

Exit criteria:

- no secret leakage into memory stores
- memory retention and deletion behavior is explicit
- tests cover redaction and retention boundaries

### Phase 6 — CI/CD hardening and release controls

Objective: make the implementation safe to ship.

Tasks:

- Split CI into narrower workflows:
  - `validate.yml`
  - `test.yml`
  - `package.yml`
  - `policy.yml`
  - `release.yml`
- Pin GitHub Actions by SHA where practical.
- Add dependency review and secret scanning.
- Add `npm pack --dry-run` verification.
- Generate SBOM.
- Add provenance/attestation for releases.
- Use protected environments and OIDC for publishing when applicable.
- Add release rollback/checklist documentation.

Exit criteria:

- publishing is isolated from PR credentials
- package contents are verified before release
- supply-chain controls are visible and enforced

## 9. Concrete repo changes to prefer

Prefer additive modules over deep rewrites.

Likely safe additions:

- `src/command-seam/types.ts`
- `src/command-seam/execute.ts`
- `src/command-seam/policy.ts`
- `src/github/client.ts`
- `src/github/auth.ts`
- `src/github/issues.ts`
- `src/github/pulls.ts`
- `src/github/workflows.ts`
- `src/github/releases.ts`
- `src/tools/registry.ts`
- `src/tools/types.ts`
- `src/telemetry/trace.ts`
- `src/telemetry/audit.ts`
- `src/agents/planner.ts`
- `src/agents/executor.ts`
- `src/agents/reviewer.ts`

Keep these thin and stable:

- `src/cli.ts`
- `src/index.ts`
- `src/config.ts`

If the active branch already uses different directories, keep the same architecture but adapt to the established layout instead of forcing these exact paths.

## 10. CLI surface recommendation

Do not overload the existing default behavior abruptly.

Recommended expansion:

- `liku` — current default interactive experience
- `liku github auth status`
- `liku github repo inspect`
- `liku github issues list`
- `liku github pr inspect <number>`
- `liku github workflow runs`
- `liku github plan "triage my open issues"`
- `liku github apply <plan-id> --approve`

Key idea: observation and planning come before mutation.

## 11. Testing strategy

### Unit tests

- command schema validation
- policy decisions
- GitHub adapter request shaping
- trace redaction
- config precedence
- approval state transitions

### Contract tests

- CLI help and command wiring
- current default interactive command path
- structured result shapes for GitHub adapters
- error contracts

### Integration tests

- mocked GitHub API interactions
- repo context discovery from local git config
- plan -> tool execution -> audit trace chain
- dry-run approval previews

### Adversarial tests

- prompt injection in issue/PR content
- malformed tool input
- token leakage attempts
- attempts to request shell/file/network operations outside policy
- oversized diffs/log payloads

### CI proof requirements

Every phase should end with external proof:

- build passes
- tests pass
- relevant new tests added
- workflow validation passes
- dry-run GitHub command examples behave as documented

## 12. Workflow plan

Minimum workflow split after hardening:

### `validate.yml`

- install dependencies
- lint
- typecheck
- schema validation
- workflow lint if added

### `test.yml`

- unit + contract tests
- integration tests against mocked GitHub APIs

### `policy.yml`

- dependency review
- secret scanning
- action pinning/policy checks

### `package.yml`

- build
- `npm pack --dry-run`
- verify package contents
- generate SBOM

### `release.yml`

- manual or tag-triggered
- protected environment
- provenance/attestation
- changelog/release notes
- post-release verification

## 13. Governance and approval model

Each new GitHub capability should declare an owner and a review path.

Minimum governance rules:

- no new mutating tool without a test, schema, and approval model
- no new workflow without pinning and explicit permissions review
- no new memory sink without retention/redaction rules
- no release automation without rollback notes

## 14. Risks and mitigations

### Risk: prompt-driven tool misuse

Mitigation: typed tool registry, policy engine, dry-run, approval checkpoints.

### Risk: breaking current CLI behavior

Mitigation: keep entrypoints thin, add contract tests before refactors, preserve README and existing flags.

### Risk: token leakage

Mitigation: central auth handling, redacted trace, memory classification, test cases for secret handling.

### Risk: CI hardening causes delivery friction

Mitigation: stage workflows, start in report-only mode where feasible, promote to required checks after stability.

### Risk: autonomous behavior becomes opaque

Mitigation: structured plans, trace ids, approval logs, bounded roles, explicit step caps.

## 15. Success metrics

- percentage of GitHub operations routed through the typed command seam
- percentage of mutating actions requiring explicit approval
- percentage of tool calls with complete trace coverage
- zero known secret leaks in logs/memory
- build/test green throughout phased rollout
- successful read-only GitHub workflows before enabling write paths
- reduced time to inspect repo/issue/PR/workflow state from the CLI

## 16. Recommended first implementation slice

Start here, not with multi-agent autonomy:

1. Freeze current behavior with tests around `src/cli.ts`, `src/index.ts`, and `src/config.ts`.
2. Add a minimal typed `executeCommand()` seam.
3. Add `github auth status` and `github repo inspect` as read-only commands.
4. Add local trace/audit scaffolding for those commands.
5. Add mocked integration tests for GitHub responses.
6. Only then add `issues list`, `pr inspect`, and workflow inspection.

This gets Copilot-Liku onto a safe path toward operating GitHub for the user while keeping the current product usable and stable.

## 17. Working rule for future implementation sessions

Before editing code in any phase, always reopen:

- `package.json`
- `src/cli.ts`
- `src/index.ts`
- `src/config.ts`
- current tests
- `README.md`
- `.github/workflows/*.yml`

This prevents implementation drift when the repo evolves between sessions.