# VS Code / Codespaces Slash Command Implementation

Date: 2026-05-23

## Purpose

GitHub Codespaces and VS Code tunnel workflows are editor-first and often headless. In this repo, the current Phase 2 GitHub capability already exists as safe read-only CLI commands under `liku github ...`. This document records how slash commands work in the root runtime today and how future VS Code-style `/github ...` commands should be implemented without duplicating logic or bypassing the new adapter layer.

This is intentionally grounded in the current CommonJS root runtime, not the separate `ultimate-ai-system` workspace.

## Current status

The shared `/github ...` slash-command path is now implemented in the root runtime.

Current implementation seams:

- `src/main/github/slash-command-handler.js` — shared `/github ...` parsing, adapter dispatch, and chat-friendly formatting
- `src/main/github/command-executor.js` — shared GitHub capability executor used by CLI and slash-command surfaces
- `src/main/github/capability-registry.js` — declared GitHub capability metadata (schema, risk, side-effect, sources)
- `src/main/github/capability-policy.js` — read-only policy evaluation before GitHub capability execution
- `src/main/ai-service/commands.js` — routes `/github ...` through the shared GitHub slash handler
- `src/main/ai-service/slash-command-helpers.js` — now includes reusable long-option parsing for slash commands
- `scripts/test-ai-service-github-slash-commands.js` — proof that `aiService.handleCommand('/github ...')` works through the real facade

## Current source of truth in this repo

### Root runtime

The shipped root runtime is the CommonJS Node/Electron CLI app:

- `src/cli/liku.js` — top-level CLI entrypoint
- `src/cli/command-seam.js` — typed CLI request/execution seam
- `src/main/index.js` — Electron main-process chat IPC and Electron-only slash commands
- `src/main/ai-service.js` — shared AI service facade used by Electron and CLI chat
- `src/main/ai-service/commands.js` — shared slash command handler
- `src/main/ai-service/slash-command-helpers.js` — tokenizer/model-key normalization helpers

### Current slash-command routing

There are already three slash-command ownership zones.

#### 1. Shared slash commands via `aiService.handleCommand()`

`src/main/ai-service.js` creates:

- `slashCommandHelpers` via `createSlashCommandHelpers({ modelRegistry })`
- `commandHandler` via `createCommandHandler({...})`

and delegates `aiService.handleCommand(command)` to `commandHandler.handleCommand(command)`.

Current shared commands are implemented in `src/main/ai-service/commands.js` and include:

- `/help`
- `/login` / `/logout`
- `/model`
- `/provider`
- `/setkey`
- `/status`
- `/state`
- `/clear`
- `/vision`
- `/capture`

These commands already work across both Electron chat and terminal chat because both surfaces eventually call `aiService.handleCommand()`.

#### 2. Electron-only slash commands in `src/main/index.js`

The Electron main process listens for `ipcMain.on('chat-message', ...)` and intercepts a separate set of commands before falling back to `aiService.handleCommand(message)`.

Current Electron-only command handling includes:

- `/agentic` or `/agent`
- `/orchestrate <task>`
- `/research <query>`
- `/build <spec>`
- `/verify <target>`
- `/agents` or `/agent-status`
- `/agent-reset`
- experimental `/produce <prompt>`

These commands are Electron/chat-window specific and should stay separate from headless-safe GitHub slash commands.

#### 3. CLI-chat-only local controls in `src/cli/commands/chat.js`

The terminal chat loop handles a few commands locally before delegating the rest to `ai.handleCommand(line)`:

- `/trace`
- `/sequence`
- `/recipes`
- interactive `/model` picker behavior

That means any future shared `/github ...` slash commands should be implemented in the shared ai-service command layer, not duplicated only in CLI chat.

## Current parser model

`src/main/ai-service/slash-command-helpers.js` currently provides:

- `tokenize(input)` — splits on whitespace while preserving quoted spans
- `normalizeModelKey(raw)` — normalizes model ids / display strings

Important constraint: the helper currently tokenizes arguments, but it does **not** provide a full `--flag value` parser. Existing shared commands in `src/main/ai-service/commands.js` manually interpret their token arrays.

That matters for GitHub slash commands because Phase 2 needs options such as:

- `--slug owner/repo`
- `--state all`
- `--limit 20`
- `--labels bug,triage`
- `--workflow ci.yml`
- `--branch main`
- `--status completed`
- `--event push`
- `--api false`

## Current GitHub Phase 2 implementation

The read-only GitHub capability now lives in dedicated adapters under `src/main/github/`.

### Shared repo/target context

`src/main/github/context.js` centralizes:

- local project identity resolution
- git remote parsing
- explicit `--slug owner/repo` overrides
- token detection from `GH_TOKEN` / `GITHUB_TOKEN`
- shared GitHub API metadata scaffolding

Use `resolveGitHubRepoContext()` instead of re-implementing remote/token parsing per command.

### Read-only adapters

Current adapter entrypoints:

- `resolveGitHubAuthStatus()` — `src/main/github/auth-status.js`
- `inspectGitHubRepository()` — `src/main/github/repo-inspect.js`
- `inspectGitHubIssue()` — `src/main/github/issue-inspect.js`
- `listGitHubIssues()` — `src/main/github/issues-list.js`
- `listGitHubPullRequests()` — `src/main/github/pr-list.js`
- `inspectGitHubPullRequestDiff()` — `src/main/github/pr-diff-summary.js`
- `inspectGitHubPullRequest()` — `src/main/github/pr-inspect.js`
- `inspectGitHubRelease()` — `src/main/github/release-inspect.js`
- `listGitHubReleases()` — `src/main/github/releases-list.js`
- `inspectGitHubWorkflowRun()` — `src/main/github/workflow-inspect.js`
- `listGitHubWorkflowRuns()` — `src/main/github/workflow-runs.js`

### Current shipped CLI surface

These adapters are exposed today through `src/cli/commands/github.js` as:

- `liku github auth status`
- `liku github capabilities list`
- `liku github capabilities inspect <capability-key>`
- `liku github plan build <area> <action> [args...]`
- `liku github plan execute <area> <action> [args...]`
- `liku github plan execute --plan-file <path>`
- `liku github repo inspect`
- `liku github issues list`
- `liku github issues inspect <number>`
- `liku github pr list`
- `liku github pr inspect <number>`
- `liku github pr diff <number>`
- `liku github workflow runs`
- `liku github workflow inspect <run-id>`
- `liku github releases list`
- `liku github releases inspect <latest|tag|id>`

This CLI command is already the source of truth for Phase 2 user-facing GitHub inspection.

## Why VS Code / Codespaces slash commands should reuse this layer

For Codespaces/tunnel usage, GitHub slash commands should be headless-safe and deterministic.

They should therefore:

1. **Call the same read-only adapters** already used by `liku github ...`
2. **Avoid prompt-only GitHub execution** for repo/issue/PR/workflow inspection
3. **Avoid Electron dependencies** such as `chatWindow`, overlay state, or renderer-only APIs
4. **Preserve read-only safety posture** for the Phase 2 milestone
5. **Keep JSON-shaped reports** available for later trace, tests, and policy integration

A slash command should not become a second GitHub client implementation.

## Recommended implementation shape

### Implemented shared `/github` router in ai-service

`src/main/ai-service/commands.js` now routes `/github ...` into `src/main/github/slash-command-handler.js`, so Electron chat and terminal chat reuse the same typed GitHub adapter layer instead of inventing a second GitHub execution path.

### Implemented parsing model: minimal and deterministic

Use the existing `tokenize()` helper first, then add a small option parser for long flags.

The parser only needs to support the GitHub Phase 2 surface:

- positional subcommands: `auth status`, `repo inspect`, `issues list`, `pr inspect`, `workflow runs`
- one required positional for PR number
- simple `--key value` or `--key=value` options
- quoted values through the existing tokenizer

Do **not** rely on freeform prompt interpretation for flags.

### Implemented dispatch: call the shared executor, not by shelling out

The slash handler now routes parsed `/github ...` input into `src/main/github/command-executor.js`, which:

- resolves the registered GitHub capability from `src/main/github/capability-registry.js`
- applies the read-only policy gate in `src/main/github/capability-policy.js`
- invokes the typed GitHub adapter for the capability
- emits structured telemetry for the execution

For the new planning bridge, the same executor now routes `/github plan build ...` into `src/main/github/plan-builder.js`, which emits a deterministic one-step execution plan artifact instead of performing the action immediately.

For bounded execution, `/github plan execute ...` now routes into `src/main/github/plan-executor.js`, which validates the typed plan, enforces max-step and timeout budgets, limits execution to registered read-only GitHub capabilities, and writes replayable plan/result artifacts under the Liku home directory.

Avoid spawning `liku github ...` as a subprocess from inside slash-command handling. That would create a second parsing/execution hop and make trace/policy alignment harder.

### Implemented formatting split: keep formatting separate from adapter output

The CLI formatter in `src/cli/commands/github.js` is terminal-oriented and uses CLI output helpers such as tables and ANSI styling. VS Code / chat slash commands should use chat-friendly formatting instead.

Recommended split:

- adapters stay in `src/main/github/*`
- CLI formatting stays in `src/cli/commands/github.js`
- chat/slash formatting lives in a shared chat-facing formatter module if needed

### Implemented convergence on the shared execution seam

The root runtime already has a typed CLI seam in `src/cli/command-seam.js` with:

- `cli.command-request.v1`
- `cli.command-execution.v1`

That convergence is now started for GitHub read-only work through the shared GitHub executor used by both:

- top-level CLI: `liku github ...`
- shared slash commands: `/github ...`

That keeps policy, trace, and future approval rules aligned.

## Recommended slash command set

For Codespaces / VS Code style usage, the Phase 2 read-only set should map one-to-one with the shipped CLI capability:

```text
/github auth status
/github capabilities list
/github capabilities inspect <capability-key>
/github plan build <area> <action> [args...]
/github plan execute <area> <action> [args...]
/github plan execute --plan-file <path>
/github repo inspect [--slug owner/repo] [--api false]
/github issues list [--slug owner/repo] [--state open|closed|all] [--limit N] [--labels a,b]
/github issues inspect <number> [--slug owner/repo] [--api false]
/github pr list [--slug owner/repo] [--state open|closed|all] [--limit N] [--base branch] [--head branch]
/github pr inspect <number> [--slug owner/repo] [--api false]
/github pr diff <number> [--slug owner/repo] [--limit N] [--api false]
/github workflow runs [--slug owner/repo] [--workflow id|file] [--branch name] [--status value] [--event name] [--limit N] [--api false]
/github workflow inspect <run-id> [--slug owner/repo] [--api false]
/github releases list [--slug owner/repo] [--limit N] [--api false]
/github releases inspect <latest|tag|id> [--slug owner/repo] [--api false]
```

A `/github help` alias is also worth adding so chat users do not need to remember the CLI syntax.

## Recommended response shape for chat surfaces

The current shared command handler returns simple objects such as:

- `{ type: 'system', message: '...' }`
- `{ type: 'info', message: '...' }`
- `{ type: 'error', message: '...' }`

For a non-breaking rollout, `/github ...` should keep that shape for user-visible chat output.

If later consumers need richer machine-readable data, an additive `data` property can be attached without breaking current renderer/CLI behavior.

## Implemented command set

The shared slash-command surface now maps one-to-one to the shipped read-only CLI capability:

- `/github auth status`
- `/github capabilities list`
- `/github capabilities inspect <capability-key>`
- `/github plan build <area> <action> [args...]`
- `/github plan execute <area> <action> [args...]`
- `/github plan execute --plan-file <path>`
- `/github repo inspect`
- `/github issues list`
- `/github issues inspect <number>`
- `/github pr list`
- `/github pr inspect <number>`
- `/github pr diff <number>`
- `/github workflow runs`
- `/github workflow inspect <run-id>`
- `/github releases list`
- `/github releases inspect <latest|tag|id>`

## Testing and verification

Current Phase 2 proof points already exist:

- `scripts/test-github-readonly.js` — adapter-level contracts with mocked GitHub responses
- `scripts/test-cli-github-command.js` — real CLI JSON-dispatch coverage
- `npm run test:github-phase2` — milestone verification command

When `/github ...` slash commands are added, add a focused test at the ai-service layer rather than relying only on interactive chat testing. The best target is the shared command handler entrypoint in `src/main/ai-service/commands.js`.

Recommended additive test coverage:

- `/github help`
- `/github auth status --probe false`
- `/github repo inspect --api false`
- `/github issues list --state all --limit 5`
- `/github issues inspect 321`
- `/github pr list --state all --limit 5`
- `/github pr inspect 123`
- `/github pr diff 123 --limit 30`
- `/github workflow inspect 9001`
- `/github pr inspect` usage failure
- `/github workflow runs --workflow ci.yml --limit 3`
- `/github releases list --limit 5`
- `/github releases inspect latest`

## Reference architecture from `ultimate-ai-system`

`ultimate-ai-system/liku/cli/src/commands/SlashCommandProcessor.ts` is a good design reference for future slash-command expansion because it already models:

- loader-based command discovery
- conflict handling
- parsed `args`, `flags`, `options`, and `rawArgv`
- central command dispatch

However, that workspace is a separate ESM TypeScript system. The root runtime here is CommonJS and should not directly depend on it.

Use it as an architectural reference only:

- port ideas, not imports
- keep the root implementation CommonJS
- only adopt loader-style command discovery if the root runtime actually needs user/project/extension slash-command loading

## Non-goals for this milestone

This document is only for the Phase 2 read-only GitHub surface.

It does **not** propose shipping slash commands for:

- issue or PR mutation
- workflow dispatch / rerun
- release inspection/mutation beyond read-only listing
- release publishing
- branch protection changes
- autonomous write actions

Those belong in later policy-gated phases after the read-only path is stable.
