# Agent Orchestration

## Purpose

This document describes the repo's custom multi-agent workflow outside of the raw `.agent.md` files. It explains which role should run when, what each role is allowed to do, and how the hook layer enforces that contract at runtime.

## Topology

The orchestration system is centered on a single coordinator:

- **Supervisor**: accepts the user task, picks the next worker by trigger, collects results, and decides when to continue, verify, diagnose, or stop.

The supervisor can delegate to six specialist workers:

- **Researcher**: find files, gather docs, and reduce ambiguity.
- **Architect**: validate reuse, patterns, and design boundaries.
- **Builder**: make code changes once the work is concrete.
- **Verifier**: validate changes independently.
- **Diagnostician**: isolate root cause when something fails.
- **Vision Operator**: analyze UI state, screenshots, overlay behavior, or browser-visible outcomes.

## Routing Model

Routing is trigger-based, not a fixed sequence.

### Supervisor

- Delegates only.
- Does not implement code directly.
- Chooses workers based on the current uncertainty or failure mode.

### Researcher

Trigger when:

- the code location is unknown
- supporting documentation is unclear
- a large amount of repo context must be narrowed quickly

Expected output:

- `Sources Examined`
- `Key Findings`
- `Recommended Next Agent`

### Architect

Trigger when:

- reuse opportunities may already exist
- module boundaries or ownership are in question
- consistency with current patterns matters before editing code

Expected output:

- `Recommended Approach`
- `Files to Reuse`
- `Constraints and Risks`

### Builder

Trigger when:

- the plan is concrete
- target files are known
- the change is ready to implement

Expected output:

- `Changed Files`
- `Local Proofs`
- `Unresolved Risks`

### Verifier

Trigger when:

- code has changed
- an independent validation pass is required

Expected output:

- `Verification Report`
- `Verdict`
- `Failing Commands or Evidence`

### Diagnostician

Trigger when:

- verification fails
- behavior regresses
- the root cause is not yet known

Expected output:

- `Root Cause`
- `Evidence`
- `Reproduction`
- `Smallest Fix`

### Vision Operator

Trigger when:

- screenshots must be interpreted
- overlay behavior is involved
- browser-visible outcomes matter
- accessibility or UIA state is central to the problem

Expected output:

- `Observed UI State`
- `Evidence`
- `Blockers`
- `Next Safe Action`

## Hook Enforcement

The hook layer is wired in [.github/hooks/copilot-hooks.json](../.github/hooks/copilot-hooks.json).

### PreToolUse

The security hook in [.github/hooks/scripts/security-check.ps1](../.github/hooks/scripts/security-check.ps1) enforces role boundaries before a tool runs.

Current policy highlights:

- **Researcher** and **Architect** are read-only and cannot execute shell tools.
- **Researcher**, **Architect**, **Verifier**, **Diagnostician**, and **Vision Operator** cannot mutate arbitrary repo files.
- Those same roles are allowed to overwrite only their role-scoped artifact file under `.github/hooks/artifacts/` so the stop hook has deterministic evidence to inspect.
- Dangerous shell patterns are denied regardless of role.

### SubagentStop

The quality gate in [.github/hooks/scripts/subagent-quality-gate.ps1](../.github/hooks/scripts/subagent-quality-gate.ps1) validates the final worker response before the subagent is allowed to stop.

It checks each role for its required evidence sections. If a worker omits those sections, the hook can block completion and require a stronger response.

Current runtime note:

- Some VS Code `SubagentStop` payloads include only metadata and omit the worker response text.
- To keep section-level enforcement meaningful, each worker now mirrors its final report to a role-specific artifact under `.github/hooks/artifacts/`.
- The quality gate reads those artifacts as its primary evidence source when the runtime omits inline response text.

### Artifact-Backed Evidence Flow

The current enforcement path works like this:

1. A worker prepares its final report in the required section format.
2. Before returning, it overwrites its role-specific artifact in `.github/hooks/artifacts/`.
3. `PreToolUse` allows that narrow mutation even for otherwise read-only roles.
4. `SubagentStop` reads the artifact and validates the expected sections.

This design exists because runtime metadata alone is not enough to enforce content quality.

### Local Verification Harnesses

The repo includes direct proof scripts for the hook path:

- `scripts/test-hook-artifacts.js`
- `scripts/test-hook-artifacts.ps1`

These harnesses verify three things end to end:

- artifact-path edits are allowed for read-only workers
- non-artifact edits are denied
- artifact-backed evidence is accepted by the quality gate

## Practical Workflow

The typical healthy flow looks like this:

1. **Supervisor** receives the task.
2. **Researcher** or **Architect** runs first if the target or design is unclear.
3. **Builder** implements once the plan is concrete.
4. **Verifier** validates the change.
5. **Diagnostician** runs only if verification fails or the issue is ambiguous.
6. **Vision Operator** is used whenever the problem depends on what is visibly on screen.

Not every task needs every role. The point of the system is to route only to the workers that match the current problem state.

## Runtime Caveat

The role contract is real, but model routing still has a current platform limitation: declared `model:` preferences in agent frontmatter are not reliably enforced by programmatic subagent dispatch. The role split, tool restrictions, and hook checks are active today; per-agent model preferences remain future-facing until the VS Code runtime honors them for all dispatch paths.