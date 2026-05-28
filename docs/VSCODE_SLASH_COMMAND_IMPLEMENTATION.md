# VS Code / Codespaces Slash Command Implementation

Date: 2026-05-27

## Purpose

GitHub Codespaces and VS Code tunnel workflows are editor-first and often headless. In this repo, the GitHub surface now includes the Phase 2 read-only capability, the Phase 5.1 reviewed context-bundle bridge, the current branch-associated PR status/view slice, the reviewed write path for issue-comment/PR create/comment/review/reversible close-reopen, the Phase 8 workflow tranche (workflow validate/permissions/requirements inspection plus repo-content and run-operation previews with explicit CLI-only apply), and the Phase 9A repo-governance inventory tranche (rulesets, environments, Actions secret/variable metadata, CODEOWNERS/templates, webhooks, and GitHub App installation posture). This document records how slash commands work in the root runtime today and how future VS Code-style `/github ...` commands should be implemented without duplicating logic or bypassing the shared adapter layer.

This is intentionally grounded in the current CommonJS root runtime, not the separate `ultimate-ai-system` workspace.

## Current status

The shared `/github ...` slash-command path is now implemented in the root runtime.

Current implementation seams:

- `src/main/github/slash-command-handler.js` — shared `/github ...` parsing, adapter dispatch, and chat-friendly formatting
- `src/main/github/command-executor.js` — shared GitHub capability executor used by CLI and slash-command surfaces
- `src/main/github/capability-registry.js` — declared GitHub capability metadata (schema, risk, side-effect, sources)
- `src/main/github/capability-policy.js` — shared GitHub policy evaluation before capability execution
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

That matters for GitHub slash commands because the current GitHub surface needs options such as:

- `--slug owner/repo`
- `--state all`
- `--limit 20`
- `--labels bug,triage`
- `--workflow ci.yml`
- `--branch main`
- `--branch feature/demo` for branch-associated PR status lookups
- `--head owner:feature/demo` for explicit PR head matching
- `--status completed`
- `--event push`
- `--api false`

## Current GitHub implementation (Phase 2 read-only + Phase 5.1 bundles + Phase 7 reviewed writes + Phase 8 workflows + Phase 9A governance inventory)

The GitHub capability now lives in dedicated adapters under `src/main/github/`.

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
- `buildGitHubContextBundle()` — `src/main/github/context-bundle.js`
- `writeGitHubContextBundleArtifact()` — `src/main/github/context-bundle-artifacts.js`
- `inspectGitHubRepository()` — `src/main/github/repo-inspect.js`
- `listGitHubRulesets()` — `src/main/github/ruleset-list.js`
- `inspectGitHubRuleset()` — `src/main/github/ruleset-inspect.js`
- `listGitHubEnvironments()` — `src/main/github/environment-list.js`
- `inspectGitHubEnvironment()` — `src/main/github/environment-inspect.js`
- `listGitHubSecrets()` — `src/main/github/secret-list.js`
- `inspectGitHubSecret()` — `src/main/github/secret-inspect.js`
- `listGitHubVariables()` — `src/main/github/variable-list.js`
- `inspectGitHubVariable()` — `src/main/github/variable-inspect.js`
- `inspectGitHubCodeowners()` — `src/main/github/codeowners-inspect.js`
- `inspectGitHubTemplates()` — `src/main/github/template-inspect.js`
- `listGitHubWebhooks()` — `src/main/github/webhook-list.js`
- `inspectGitHubWebhook()` — `src/main/github/webhook-inspect.js`
- `inspectGitHubAppStatus()` — `src/main/github/app-status.js`
- `inspectGitHubAppInstallation()` — `src/main/github/app-installation-inspect.js`
- `inspectGitHubAppPermissions()` — `src/main/github/app-permissions-inspect.js`
- `inspectGitHubIssue()` — `src/main/github/issue-inspect.js`
- `listGitHubIssues()` — `src/main/github/issues-list.js`
- `listGitHubPullRequests()` — `src/main/github/pr-list.js`
- `inspectGitHubPullRequestStatus()` — `src/main/github/pr-status.js`
- `inspectGitHubPullRequestFeedback()` — `src/main/github/pr-feedback.js`
- `inspectGitHubPullRequestDiff()` — `src/main/github/pr-diff-summary.js`
- `inspectGitHubPullRequest()` — `src/main/github/pr-inspect.js`
- `inspectGitHubRelease()` — `src/main/github/release-inspect.js`
- `listGitHubReleases()` — `src/main/github/releases-list.js`
- `inspectGitHubWorkflowRun()` — `src/main/github/workflow-inspect.js`
- `listGitHubWorkflowRuns()` — `src/main/github/workflow-runs.js`

### Reviewed write-preview/apply adapters

Current low-risk write-preview/apply entrypoints:

- `draftGitHubIssueComment()` — `src/main/github/issue-comment-draft.js`
- `draftGitHubPullRequestCreate()` — `src/main/github/pr-create-draft.js`
- `draftGitHubPullRequestComment()` — `src/main/github/pr-comment-draft.js`
- `draftGitHubPullRequestReview()` — `src/main/github/pr-review-draft.js`
- `draftGitHubPullRequestClose()` / `draftGitHubPullRequestReopen()` — `src/main/github/pr-state-draft.js`
- `validateGitHubWorkflow()` — `src/main/github/workflow-validate.js`
- `inspectGitHubWorkflowPermissions()` — `src/main/github/workflow-permissions-inspect.js`
- `inspectGitHubWorkflowRequirements()` — `src/main/github/workflow-requirements-inspect.js`
- `draftGitHubWorkflowCreate()` / `draftGitHubWorkflowUpdate()` — `src/main/github/workflow-content-draft.js`
- `draftGitHubWorkflowDispatch()` / `draftGitHubWorkflowRerun()` / `draftGitHubWorkflowCancel()` — `src/main/github/workflow-run-draft.js`
- `applyGitHubWritePreview()` — `src/main/github/write-apply.js` (compatibility re-export remains at `issue-comment-apply.js`)
- `createGitHubWritePreviewArtifacts()` and related readers/writers — `src/main/github/write-artifacts.js`

### Current shipped CLI surface

These adapters are exposed today through `src/cli/commands/github.js` as:

- `liku github auth status`
- `liku github capabilities list`
- `liku github capabilities inspect <capability-key>`
- `liku github context bundle pr <number> [--slug owner/repo] [--api false] [--out-file <path>]`
- `liku github context bundle issue <number> [--slug owner/repo] [--api false] [--out-file <path>]`
- `liku github context bundle repo [--slug owner/repo] [--limit N] [--api false] [--out-file <path>]`
- `liku github issues comment draft <number> (--body <text> | --body-file <path>) [--slug owner/repo]`
- `liku github pr create draft --title <text> [--body <text> | --body-file <path>] [--base branch] [--head branch|owner:branch] [--draft true|false] [--slug owner/repo] [--api false]`
- `liku github pr comment draft <number> (--body <text> | --body-file <path>) [--slug owner/repo]`
- `liku github pr review draft <number> --event <comment|approve|request-changes> [--body <text> | --body-file <path>] [--slug owner/repo]`
- `liku github pr close draft <number> [--slug owner/repo]`
- `liku github pr reopen draft <number> [--slug owner/repo]`
- `liku github apply <preview-id> --approve [--apply-token <token> | --approval-file <path>]`
- `liku github plan build <area> <action> [args...]`
- `liku github plan execute <area> <action> [args...]`
- `liku github plan execute --plan-file <path>`
- `liku github plan resume --guidance-file <path> --resume-token <token> --answers-file <path>`
- `liku github plan resume --guidance-file <path> --resume-token <token> --answers-json '{"field":"value"}'`
- `liku github plan runs [--slug owner/repo] [--limit N] [--state completed|blocked|aborted|all]`
- `liku github plan inspect <run-id> [--slug owner/repo] [--plan-file <path>] [--event-log-file <path>]`
- `liku github repo inspect`
- `liku github ruleset list [--slug owner/repo] [--limit N] [--api false]`
- `liku github ruleset inspect <id> [--slug owner/repo] [--api false]`
- `liku github environment list [--slug owner/repo] [--limit N] [--api false]`
- `liku github environment inspect <name> [--slug owner/repo] [--api false]`
- `liku github secret list [--slug owner/repo] [--limit N] [--api false]`
- `liku github secret inspect <name> [--slug owner/repo] [--api false]`
- `liku github variable list [--slug owner/repo] [--limit N] [--api false]`
- `liku github variable inspect <name> [--slug owner/repo] [--api false]`
- `liku github codeowners inspect [--slug owner/repo] [--api false]`
- `liku github codeowners create draft [--path <path>] [--body <text> | --body-file <path>] [--base branch] [--head branch] [--slug owner/repo] [--api false]`
- `liku github codeowners update draft [--path <path>] [--body <text> | --body-file <path>] [--base branch] [--head branch] [--slug owner/repo] [--api false]`
- `liku github template inspect [--slug owner/repo] [--api false]`
- `liku github webhook list [--slug owner/repo] [--limit N] [--api false]`
- `liku github webhook inspect <id> [--slug owner/repo] [--api false]`
- `liku github webhook create draft --events a,b --target-url <url> --secret-ref repo:<ENV_NAME> [--content-type json|form] [--active true|false] [--slug owner/repo]`
- `liku github webhook update draft <id> [--events a,b] [--target-url <url>] [--secret-ref repo:<ENV_NAME>] [--content-type json|form] [--active true|false] [--slug owner/repo]`
- `liku github webhook ping draft <id> [--slug owner/repo]`
- `liku github event list [--slug owner/repo] [--limit N] [--event <name>]`
- `liku github event inspect <event-id> [--slug owner/repo]`
- `liku github app status [--slug owner/repo] [--probe false] [--api false]`
- `liku github app installation inspect [--slug owner/repo] [--api false]`
- `liku github app permissions inspect [--slug owner/repo] [--api false]`
- `liku github issues list`
- `liku github issues inspect <number>`
- `liku github pr list`
- `liku github pr status [--branch name] [--slug owner/repo]`
- `liku github pr view [--branch name] [--slug owner/repo]`
- `liku github pr feedback [<number>] [--branch name] [--head owner:branch] [--state open|closed|all] [--limit N] [--slug owner/repo]`
- `liku github pr inspect <number>`
- `liku github pr diff <number>`
- `liku github workflow runs`
- `liku github workflow inspect <run-id>`
- `liku github workflow validate <path> [--body <text> | --body-file <path>] [--slug owner/repo]`
- `liku github workflow permissions inspect <path> [--body <text> | --body-file <path>] [--slug owner/repo]`
- `liku github workflow requirements inspect <path> [--body <text> | --body-file <path>] [--slug owner/repo]`
- `liku github workflow create draft <path> [--body <text> | --body-file <path>] [--base branch] [--head branch] [--slug owner/repo] [--api false]`
- `liku github workflow update draft <path> [--body <text> | --body-file <path>] [--base branch] [--head branch] [--slug owner/repo] [--api false]`
- `liku github workflow dispatch draft <workflow-id|file> [--ref branch|tag|sha] [--inputs-json <json> | --inputs-file <path>] [--slug owner/repo]`
- `liku github workflow rerun draft <run-id> [--failed-only true|false] [--slug owner/repo]`
- `liku github workflow cancel draft <run-id> [--slug owner/repo]`
- `liku github releases list`
- `liku github releases inspect <latest|tag|id>`

This CLI command is already the source of truth for user-facing GitHub inspection, the branch-associated PR status/view/feedback slice, and the first bounded reviewed write-preview/apply flow.

## Why VS Code / Codespaces slash commands should reuse this layer

For Codespaces/tunnel usage, GitHub slash commands should be headless-safe and deterministic.

They should therefore:

1. **Call the same typed GitHub adapters** already used by `liku github ...`
2. **Avoid prompt-only GitHub execution** for repo/issue/PR/workflow inspection
3. **Avoid Electron dependencies** such as `chatWindow`, overlay state, or renderer-only APIs
4. **Preserve the current safety posture**: read-only where shipped in Phase 2, preview-only on slash for the first Phase 7 write slice, and CLI-only apply for actual mutation
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
- applies the shared GitHub policy gate in `src/main/github/capability-policy.js`
- invokes the typed GitHub adapter for the capability
- emits structured telemetry for the execution

For the new planning bridge, the same executor now routes `/github plan build ...` into `src/main/github/plan-builder.js`, which emits a deterministic one-step execution plan artifact instead of performing the action immediately.

For bounded execution, `/github plan execute ...` now routes into `src/main/github/plan-executor.js`, which validates the typed plan, enforces max-step and timeout budgets, limits execution to registered read-only GitHub capabilities, and writes replayable plan/result artifacts under the Liku home directory.

For explicit continuation, `/github plan resume ...` now routes through that same bounded executor so a caller can resume a blocked run from a saved guidance checkpoint using `--guidance-file`, a single-use `--resume-token`, and either `--answers-file` or `--answers-json`, without replaying already completed steps.

For durable local inspection, `/github plan runs ...` and `/github plan inspect ...` now route into `src/main/github/plan-run-list.js`, `src/main/github/plan-run-inspect.js`, and `src/main/github/plan-run-ledger.js`, which scan the local plan artifacts under the Liku home directory, join plan/result/guidance/event-log records by run id, and expose a read-only ledger without introducing a new orchestration or apply path.

For reviewed writes, `/github issues comment draft ...`, `/github pr create draft ...`, `/github pr comment draft ...`, `/github pr review draft ...`, `/github pr close draft ...`, `/github pr reopen draft ...`, `/github workflow create draft ...`, `/github workflow update draft ...`, `/github codeowners create draft ...`, `/github codeowners update draft ...`, `/github webhook create draft ...`, `/github webhook update draft ...`, `/github webhook ping draft ...`, `/github workflow dispatch draft ...`, `/github workflow rerun draft ...`, and `/github workflow cancel draft ...` now route into the dedicated write-preview/apply path rather than the bounded plan executor. That path writes reviewed preview and approval artifacts under the Liku home directory, keeps slash responses non-mutating, and requires the user to switch to the CLI for actual apply. Workflow create/update and CODEOWNERS create/update applies use a repo-content patch lane that creates a dedicated branch, commits the target repo content there, and opens a draft pull request instead of mutating the default branch directly. Webhook create/update/ping applies stay direct operational writes, but preview artifacts persist only `repo:<ENV_NAME>` secret refs; the actual secret is resolved from the local environment only at CLI apply time so the raw webhook secret never lands in the stored preview.

For isolated proofing and test harnesses, use `LIKU_HOME_OVERRIDE=<path>` so write artifacts land in a dedicated temp home. The root runtime resolves the active Liku home from that override.

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

For Codespaces / VS Code style usage, the shipped slash set should stay aligned with the CLI capability while preserving the current CLI-only apply boundary:

```text
/github auth status
/github capabilities list
/github capabilities inspect <capability-key>
/github context bundle pr <number> [--slug owner/repo] [--api false] [--out-file <path>]
/github context bundle issue <number> [--slug owner/repo] [--api false] [--out-file <path>]
/github context bundle repo [--slug owner/repo] [--limit N] [--api false] [--out-file <path>]
/github issues comment draft <number> (--body <text> | --body-file <path>) [--slug owner/repo]
/github pr create draft --title <text> [--body <text> | --body-file <path>] [--base branch] [--head branch|owner:branch] [--draft true|false] [--slug owner/repo] [--api false]
/github pr comment draft <number> (--body <text> | --body-file <path>) [--slug owner/repo]
/github pr review draft <number> --event <comment|approve|request-changes> [--body <text> | --body-file <path>] [--slug owner/repo]
/github pr close draft <number> [--slug owner/repo]
/github pr reopen draft <number> [--slug owner/repo]
/github plan build <area> <action> [args...]
/github plan execute <area> <action> [args...]
/github plan execute --plan-file <path>
/github plan resume --guidance-file <path> --resume-token <token> [--answers-file <path> | --answers-json <json>]
/github plan runs [--slug owner/repo] [--limit N] [--state completed|blocked|aborted|all]
/github plan inspect <run-id> [--slug owner/repo] [--plan-file <path>] [--event-log-file <path>]
/github repo inspect [--slug owner/repo] [--api false]
/github ruleset list [--slug owner/repo] [--limit N] [--api false]
/github ruleset inspect <id> [--slug owner/repo] [--api false]
/github environment list [--slug owner/repo] [--limit N] [--api false]
/github environment inspect <name> [--slug owner/repo] [--api false]
/github secret list [--slug owner/repo] [--limit N] [--api false]
/github secret inspect <name> [--slug owner/repo] [--api false]
/github variable list [--slug owner/repo] [--limit N] [--api false]
/github variable inspect <name> [--slug owner/repo] [--api false]
/github codeowners inspect [--slug owner/repo] [--api false]
/github codeowners create draft [--path <path>] [--body <text> | --body-file <path>] [--base branch] [--head branch] [--slug owner/repo] [--api false]
/github codeowners update draft [--path <path>] [--body <text> | --body-file <path>] [--base branch] [--head branch] [--slug owner/repo] [--api false]
/github template inspect [--slug owner/repo] [--api false]
/github webhook list [--slug owner/repo] [--limit N] [--api false]
/github webhook inspect <id> [--slug owner/repo] [--api false]
/github webhook create draft --events a,b --target-url <url> --secret-ref repo:<ENV_NAME> [--content-type json|form] [--active true|false] [--slug owner/repo]
/github webhook update draft <id> [--events a,b] [--target-url <url>] [--secret-ref repo:<ENV_NAME>] [--content-type json|form] [--active true|false] [--slug owner/repo]
/github webhook ping draft <id> [--slug owner/repo]
/github event list [--slug owner/repo] [--limit N] [--event <name>]
/github event inspect <event-id> [--slug owner/repo]
/github app status [--slug owner/repo] [--probe false] [--api false]
/github app installation inspect [--slug owner/repo] [--api false]
/github app permissions inspect [--slug owner/repo] [--api false]
/github issues list [--slug owner/repo] [--state open|closed|all] [--limit N] [--labels a,b]
/github issues inspect <number> [--slug owner/repo] [--api false]
/github pr list [--slug owner/repo] [--state open|closed|all] [--limit N] [--base branch] [--head branch]
/github pr status [--slug owner/repo] [--branch name] [--head owner:branch] [--state open|closed|all] [--api false]
/github pr view [--slug owner/repo] [--branch name] [--head owner:branch] [--state open|closed|all] [--api false]
/github pr feedback [<number>] [--slug owner/repo] [--branch name] [--head owner:branch] [--state open|closed|all] [--limit N] [--api false]
/github pr inspect <number> [--slug owner/repo] [--api false]
/github pr diff <number> [--slug owner/repo] [--limit N] [--api false]
/github workflow runs [--slug owner/repo] [--workflow id|file] [--branch name] [--status value] [--event name] [--limit N] [--api false]
/github workflow inspect <run-id> [--slug owner/repo] [--api false]
/github workflow validate <path> [--body <text> | --body-file <path>] [--slug owner/repo]
/github workflow permissions inspect <path> [--body <text> | --body-file <path>] [--slug owner/repo]
/github workflow requirements inspect <path> [--body <text> | --body-file <path>] [--slug owner/repo]
/github workflow create draft <path> [--body <text> | --body-file <path>] [--base branch] [--head branch] [--slug owner/repo] [--api false]
/github workflow update draft <path> [--body <text> | --body-file <path>] [--base branch] [--head branch] [--slug owner/repo] [--api false]
/github workflow dispatch draft <workflow-id|file> [--ref branch|tag|sha] [--inputs-json <json> | --inputs-file <path>] [--slug owner/repo]
/github workflow rerun draft <run-id> [--failed-only true|false] [--slug owner/repo]
/github workflow cancel draft <run-id> [--slug owner/repo]
/github releases list [--slug owner/repo] [--limit N] [--api false]
/github releases inspect <latest|tag|id> [--slug owner/repo] [--api false]
```

The reviewed bundle surface is the current Phase 5.1 bridge toward local Copilot-like GitHub orchestration: it composes typed read-only GitHub adapters, sanitizes sensitive fields, writes an explicit local artifact, and returns review metadata before any later prompt or agent consumes the bundle.

The reviewed issue-comment, PR-create, PR-comment, PR-review, and reversible PR close/reopen draft surfaces are the current Phase 7 bridge toward safe local GitHub writes: they persist sanitized preview and approval artifacts, return review metadata, and explicitly tell the user to run `liku github apply ...` from the CLI for the actual mutation.

The Phase 9A governance inventory surfaces stay read-only and repo-scoped: rulesets, environments, webhooks, and app posture summarize admin-facing metadata; Actions secrets and variables stay metadata-only; and `codeowners inspect` plus `template inspect` can prefer the current workspace and run offline with `--api false`.

The next governance write slice keeps that same safety posture: `codeowners create draft` and `codeowners update draft` are preview-only from slash, require later CLI apply, and use the repo-content patch lane so the actual mutation happens through a dedicated branch and draft PR instead of the default branch. The webhook create/update/ping draft slice follows the same reviewed-preview rule, but applies through direct operational GitHub webhook APIs after explicit CLI approval; when a secret is required, the preview stores only `repo:<ENV_NAME>` and the apply step resolves that environment variable locally.

The first event-runtime slice keeps the same defensive posture: `/github event list ...` and `/github event inspect ...` are local-only read paths over a sanitized durable event journal under the Liku home directory. The current Phase 10B implementation proves the storage and inspection contract first; it does **not** introduce a live inbound webhook server yet.

The Phase 10C ledger slice keeps that same local-first posture: `/github plan runs ...` and `/github plan inspect ...` are local-only read paths over the durable bounded-execution artifacts under the Liku home directory. The current implementation focuses on inspection, replay context, and bounded-run debugging only; it does **not** add a new autonomous planner or mutation path.

The `/github help` alias is implemented so chat users do not need to remember the CLI syntax.

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
- `/github context bundle pr <number> [--slug owner/repo] [--api false] [--out-file <path>]`
- `/github context bundle issue <number> [--slug owner/repo] [--api false] [--out-file <path>]`
- `/github context bundle repo [--slug owner/repo] [--limit N] [--api false] [--out-file <path>]`
- `/github issues comment draft <number> (--body <text> | --body-file <path>) [--slug owner/repo]`
- `/github pr create draft --title <text> [--body <text> | --body-file <path>] [--base branch] [--head branch|owner:branch] [--draft true|false] [--slug owner/repo] [--api false]`
- `/github pr comment draft <number> (--body <text> | --body-file <path>) [--slug owner/repo]`
- `/github pr review draft <number> --event <comment|approve|request-changes> [--body <text> | --body-file <path>] [--slug owner/repo]`
- `/github pr close draft <number> [--slug owner/repo]`
- `/github pr reopen draft <number> [--slug owner/repo]`
- `/github plan build <area> <action> [args...]`
- `/github plan execute <area> <action> [args...]`
- `/github plan execute --plan-file <path>`
- `/github plan resume --guidance-file <path> --resume-token <token> [--answers-file <path> | --answers-json <json>]`
- `/github plan runs [--slug owner/repo] [--limit N] [--state completed|blocked|aborted|all]`
- `/github plan inspect <run-id> [--slug owner/repo] [--plan-file <path>] [--event-log-file <path>]`
- `/github repo inspect`
- `/github ruleset list [--slug owner/repo] [--limit N] [--api false]`
- `/github ruleset inspect <id> [--slug owner/repo] [--api false]`
- `/github environment list [--slug owner/repo] [--limit N] [--api false]`
- `/github environment inspect <name> [--slug owner/repo] [--api false]`
- `/github secret list [--slug owner/repo] [--limit N] [--api false]`
- `/github secret inspect <name> [--slug owner/repo] [--api false]`
- `/github variable list [--slug owner/repo] [--limit N] [--api false]`
- `/github variable inspect <name> [--slug owner/repo] [--api false]`
- `/github codeowners inspect [--slug owner/repo] [--api false]`
- `/github codeowners create draft [--path <path>] [--body <text> | --body-file <path>] [--base branch] [--head branch] [--slug owner/repo] [--api false]`
- `/github codeowners update draft [--path <path>] [--body <text> | --body-file <path>] [--base branch] [--head branch] [--slug owner/repo] [--api false]`
- `/github template inspect [--slug owner/repo] [--api false]`
- `/github webhook list [--slug owner/repo] [--limit N] [--api false]`
- `/github webhook inspect <id> [--slug owner/repo] [--api false]`
- `/github webhook create draft --events a,b --target-url <url> --secret-ref repo:<ENV_NAME> [--content-type json|form] [--active true|false] [--slug owner/repo]`
- `/github webhook update draft <id> [--events a,b] [--target-url <url>] [--secret-ref repo:<ENV_NAME>] [--content-type json|form] [--active true|false] [--slug owner/repo]`
- `/github webhook ping draft <id> [--slug owner/repo]`
- `/github event list [--slug owner/repo] [--limit N] [--event <name>]`
- `/github event inspect <event-id> [--slug owner/repo]`
- `/github app status [--slug owner/repo] [--probe false] [--api false]`
- `/github app installation inspect [--slug owner/repo] [--api false]`
- `/github app permissions inspect [--slug owner/repo] [--api false]`
- `/github issues list`
- `/github issues inspect <number>`
- `/github pr list`
- `/github pr status`
- `/github pr view`
- `/github pr feedback [<number>]`
- `/github pr inspect <number>`
- `/github pr diff <number>`
- `/github workflow runs`
- `/github workflow inspect <run-id>`
- `/github workflow validate <path> [--body <text> | --body-file <path>] [--slug owner/repo]`
- `/github workflow permissions inspect <path> [--body <text> | --body-file <path>] [--slug owner/repo]`
- `/github workflow requirements inspect <path> [--body <text> | --body-file <path>] [--slug owner/repo]`
- `/github workflow create draft <path> [--body <text> | --body-file <path>] [--base branch] [--head branch] [--slug owner/repo] [--api false]`
- `/github workflow update draft <path> [--body <text> | --body-file <path>] [--base branch] [--head branch] [--slug owner/repo] [--api false]`
- `/github workflow dispatch draft <workflow-id|file> [--ref branch|tag|sha] [--inputs-json <json> | --inputs-file <path>] [--slug owner/repo]`
- `/github workflow rerun draft <run-id> [--failed-only true|false] [--slug owner/repo]`
- `/github workflow cancel draft <run-id> [--slug owner/repo]`
- `/github releases list`
- `/github releases inspect <latest|tag|id>`

Actual apply remains intentionally CLI-only in this slice:

- `liku github apply <preview-id> --approve [--apply-token <token> | --approval-file <path>]`

## Testing and verification

Current Phase 2 proof points already exist:

- `scripts/test-github-readonly.js` — adapter-level contracts with mocked GitHub responses
- `scripts/test-github-pr-feedback.js` — focused PR feedback contracts with mocked GitHub responses
- `scripts/test-cli-github-command.js` — real CLI JSON-dispatch coverage
- `npm run test:github-phase2` — milestone verification command

Current Phase 7 proof points now also exist:

- `scripts/test-github-write-preview-apply.js` — focused draft/apply lifecycle proof with mocked GitHub responses
- `scripts/test-github-pr-comment-preview-apply.js` — focused PR-comment draft/apply lifecycle proof with mocked GitHub responses
- `scripts/test-github-pr-review-preview-apply.js` — focused PR-review draft/apply lifecycle proof with mocked GitHub responses
- `scripts/test-github-pr-state-preview-apply.js` — focused reversible PR close/reopen draft/apply lifecycle proof with mocked GitHub responses
- `scripts/test-ai-service-github-slash-commands.js` — slash-preview coverage plus CLI-only apply guard
- `npm run test:github-phase7-writes` — layered regression bundle for the reviewed write-preview/apply seam

Current Phase 8 proof points now also exist:

- `scripts/test-github-workflow-phase8.js` — focused workflow validation plus draft/apply-read separation proof with mocked GitHub responses
- `docs/GITHUB_WORKFLOW_VALIDATION_RUNBOOK.md` — source-grounded workflow validation and live-proof guidance
- `npm run test:github-phase8-workflows` — layered regression bundle for workflow validate/create/update/dispatch/rerun/cancel coverage

Current Phase 9A proof points now also exist:

- `scripts/test-github-phase9-readonly.js` — focused governance inventory contracts with mocked GitHub responses and temp-workspace offline proof for CODEOWNERS/templates
- `scripts/test-github-capability-policy.js` — registry/policy coverage for governance capability metadata and executor routing
- `scripts/test-cli-github-command.js` — CLI help/JSON coverage for governance commands
- `scripts/test-ai-service-github-slash-commands.js` — slash help/formatter coverage for governance commands
- `docs/GITHUB_GOVERNANCE_VALIDATION_RUNBOOK.md` — source-grounded read-only governance validation guidance
- `npm run test:github-phase9-readonly` — layered regression bundle for the Phase 9A governance inventory seam

Current Phase 10A proof points now also exist:

- `scripts/test-github-webhook-preview-apply.js` — focused webhook create/update/ping reviewed preview/apply proof with mocked GitHub responses
- `scripts/test-github-capability-policy.js` — registry/policy coverage for webhook draft capability metadata and executor routing
- `scripts/test-cli-github-command.js` — CLI help/JSON coverage for webhook draft commands
- `scripts/test-ai-service-github-slash-commands.js` — slash help/formatter coverage for webhook draft commands
- `npm run test:github-phase10a-webhooks` — layered regression bundle for the Phase 10A webhook reviewed-write seam

Current Phase 10B proof points now also exist:

- `scripts/test-github-event-runtime.js` — focused local GitHub event journal ingestion/list/inspect proof with sanitized durable artifacts
- `scripts/test-github-capability-policy.js` — registry/policy coverage for event list/inspect capability metadata and executor routing
- `scripts/test-cli-github-command.js` — CLI help/JSON coverage for event list/inspect commands
- `scripts/test-ai-service-github-slash-commands.js` — slash help/formatter coverage for event list/inspect commands
- `npm run test:github-phase10b-event-runtime` — layered regression bundle for the Phase 10B event-runtime foundation seam

Current Phase 10C proof points now also exist:

- `scripts/test-github-plan-ledger.js` — focused local GitHub plan-ledger list/inspect proof with durable artifact joins and explicit file attachment coverage
- `scripts/test-github-plan-builder.js` — planner guardrails proving plan ledger commands remain non-plannable targets
- `scripts/test-github-capability-policy.js` — registry/policy coverage for plan runs/inspect capability metadata and executor routing
- `scripts/test-cli-github-command.js` — CLI help/JSON coverage for plan runs/inspect commands
- `scripts/test-ai-service-github-slash-commands.js` — slash help/formatter coverage for plan runs/inspect commands
- `npm run test:github-phase10c-run-ledger` — layered regression bundle for the Phase 10C durable plan-ledger seam

When `/github ...` slash commands are added, add a focused test at the ai-service layer rather than relying only on interactive chat testing. The best target is the shared command handler entrypoint in `src/main/ai-service/commands.js`.

Recommended additive test coverage:

- `/github help`
- `/github auth status --probe false`
- `/github repo inspect --api false`
- `/github issues list --state all --limit 5`
- `/github issues inspect 321`
- `/github pr list --state all --limit 5`
- `/github pr status --branch feature/demo --api false`
- `/github pr feedback --branch feature/demo --limit 5 --api false`
- `/github pr inspect 123`
- `/github pr diff 123 --limit 30`
- `/github workflow inspect 9001`
- `/github pr inspect` usage failure
- `/github workflow runs --workflow ci.yml --limit 3`
- `/github releases list --limit 5`
- `/github releases inspect latest`
- `/github ruleset list --limit 5 --api false`
- `/github environment inspect production --api false`
- `/github secret inspect GH_TOKEN --api false`
- `/github variable list --limit 5 --api false`
- `/github codeowners inspect --api false`
- `/github codeowners create draft --body-file <path> --base main --slug owner/repo`
- `/github webhook create draft --events push,pull_request --target-url https://assistant.example.com/github/webhook --secret-ref repo:LIKU_WEBHOOK_SECRET --content-type json --slug owner/repo`
- `/github event list --slug owner/repo --limit 10 --event push`
- `/github plan runs --slug owner/repo --limit 10 --state blocked`
- `/github plan inspect <run-id> --slug owner/repo`
- `/github template inspect --api false`
- `/github webhook inspect 9001 --slug owner/repo --api false`
- `/github app status --probe false --api false`
- `/github app permissions inspect --slug owner/repo --api false`

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

This document covers the current Phase 2 read-only GitHub surface, the Phase 5.1 reviewed context-bundle bridge, the current Phase 7 low-risk reviewed write slice, the Phase 8 workflow preview/apply-read separation, and the Phase 9A repo-governance inventory surface.

It does **not** propose shipping slash commands for:

- slash-based apply of GitHub writes
- additional GitHub write mutations beyond the current reviewed preview/apply surfaces
- release publishing or release mutation beyond read-only listing
- branch protection changes
- autonomous write actions

Those belong in later policy-gated phases after the first reviewed issue-comment flow is stable.
