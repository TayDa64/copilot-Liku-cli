# GitHub workflow validation runbook

This runbook keeps GitHub workflow validation grounded in the current codebase and the reviewed preview/apply model that ships in the root CommonJS runtime.

## Current source of truth

The Phase 8 workflow slice currently ships these capability families:

- read-only workflow analysis:
  - `workflow.validate`
  - `workflow.permissions.inspect`
  - `workflow.requirements.inspect`
- reviewed repo-content workflow file changes:
  - `workflow.create.draft`
  - `workflow.update.draft`
- reviewed workflow operational controls:
  - `workflow.dispatch.draft`
  - `workflow.rerun.draft`
  - `workflow.cancel.draft`

Implementation seams:

- `src/main/github/workflow-analyzer.js` — local workflow parsing and summary logic
- `src/main/github/workflow-policy.js` — workflow hardening checks reused by validation
- `src/main/github/workflow-content-draft.js` — reviewed repo-content workflow create/update previews
- `src/main/github/workflow-run-draft.js` — reviewed workflow dispatch/rerun/cancel previews
- `src/main/github/write-apply.js` — generic reviewed apply seam
- `src/main/github/repo-content-patch-apply.js` — branch/commit/draft-PR apply lane for workflow file writes

Apply remains intentionally CLI-only through `liku github apply <preview-id> --approve --approval-file <path>`.

## Validation layers

Use the narrowest deterministic layer first, then broaden only when the touched behavior crosses a real GitHub runtime boundary.

| Layer | Use for | Commands |
| --- | --- | --- |
| Focused workflow bundle | Phase 8 workflow read/preview/apply contracts | `npm run test:github-phase8-workflows` |
| Focused workflow script | Narrow workflow-specific debugging | `node scripts/test-github-workflow-phase8.js` |
| Registry/policy coverage | Capability metadata and preview/apply policy | `node scripts/test-github-capability-policy.js` |
| CLI contract | `liku github ...` help and JSON surface | `node scripts/test-cli-github-command.js` |
| Slash contract | `/github ...` preview/read surface parity | `node scripts/test-ai-service-github-slash-commands.js` |
| Workflow policy rules | Hardening-policy regression checks | `node scripts/test-workflow-policy.js` |
| Existing write bundle | Prove workflow work did not regress prior reviewed writes | `npm run test:github-phase7-writes` |

Recommended deterministic proof command before any live GitHub validation:

```powershell
npm run test:github-phase8-workflows
```

## Safe live-proof prerequisites

Run live workflow proofs only when all of the following are true:

1. The target repository and workflow are non-production or disposable.
2. The workflow is reversible or operationally safe to dispatch/rerun/cancel.
3. You are not targeting deploy, release, or privileged environment mutation workflows.
4. You have authenticated GitHub REST access via `GH_TOKEN` or `GITHUB_TOKEN`.
5. GitHub feature flags are enabled:
   - `LIKU_ENABLE_GITHUB=1`
   - `LIKU_ENABLE_GITHUB_WRITES=1`
6. You are applying from the CLI, not from slash commands.

Never use these live proofs against a production deployment workflow just because the API call is available.

## Recommended live proof sequence

### 1. Validate the workflow definition locally first

```powershell
liku github workflow validate .github/workflows/validate.yml --body-file C:\path\to\validate.yml --slug owner/repo
liku github workflow permissions inspect .github/workflows/validate.yml --slug owner/repo
liku github workflow requirements inspect .github/workflows/validate.yml --slug owner/repo
```

### 2. Dispatch a sandbox workflow through the reviewed preview/apply path

Create the reviewed preview:

```powershell
liku github workflow dispatch draft validate.yml --ref main --inputs-json '{"target":"staging"}' --slug owner/repo --json
```

Then apply it from the CLI using the emitted preview id and approval artifact:

```powershell
liku github apply <preview-id> --approve --approval-file C:\Users\you\.liku\github\writes\<preview-id>.approval.json --json
```

Observe the resulting run through the read-only surfaces:

```powershell
liku github workflow runs --workflow validate.yml --branch main --limit 5 --slug owner/repo --json
liku github workflow inspect <run-id> --slug owner/repo --json
```

Record the resulting `run-id` before moving on.

### 3. Cancel only the sandbox run you just created or explicitly selected

Create the reviewed cancel preview:

```powershell
liku github workflow cancel draft <run-id> --slug owner/repo --json
```

Apply it:

```powershell
liku github apply <preview-id> --approve --approval-file C:\Users\you\.liku\github\writes\<preview-id>.approval.json --json
```

Re-check the run state with `workflow inspect`.

### 4. Rerun only a safe sandbox run

For a normal rerun:

```powershell
liku github workflow rerun draft <run-id> --slug owner/repo --json
```

For failed jobs only, use this only when the selected run actually has failed jobs:

```powershell
liku github workflow rerun draft <run-id> --failed-only true --slug owner/repo --json
```

Apply through the same CLI-only reviewed apply path:

```powershell
liku github apply <preview-id> --approve --approval-file C:\Users\you\.liku\github\writes\<preview-id>.approval.json --json
```

Then confirm the follow-on run or rerun state via `workflow runs` / `workflow inspect`.

## Workflow file change proofs

For `workflow.create.draft` and `workflow.update.draft`, live proof should remain PR-oriented:

1. create the reviewed preview
2. apply it through the repo-content patch lane
3. confirm that apply created or reused the dedicated branch
4. confirm that a draft PR was opened
5. review the generated diff before merging

Do **not** treat workflow file write proof as permission to mutate the default branch directly.

## Evidence to capture

When a PR changes GitHub workflow capabilities, capture at least:

- the deterministic proof command you ran
- the preview id(s) used for any live apply
- the approval artifact path(s)
- the target repository slug, workflow file/id, ref, and run id(s)
- whether the live run was dispatch, cancel, rerun, or repo-content patch
- any follow-up `workflow inspect` or `workflow runs` confirmation output

Preview/apply artifacts live under the Liku home directory and should remain uncommitted.

## Safety boundaries

- Slash commands may create previews, but apply remains CLI-only.
- Use sandbox repos or non-production workflows only.
- Do not use live proof to dispatch deploy/release workflows on shared repos.
- Do not weaken workflow hardening checks just to make a proof pass.
- If live GitHub behavior disagrees with a deterministic test, treat the live behavior as the source of truth and update tests deliberately.

## Current limitation

There is not yet a dedicated GitHub live smoke harness comparable to the TradingView live harness. For now, use the exact CLI preview/apply/read commands above, keep the scope reversible, and attach the resulting artifact ids and run ids to PR notes when live validation is relevant.
