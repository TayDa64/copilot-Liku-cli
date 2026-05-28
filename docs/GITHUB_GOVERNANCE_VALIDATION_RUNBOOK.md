# GitHub governance inventory validation runbook

This runbook keeps GitHub governance inventory validation grounded in the current codebase and the Phase 9A read-only posture that ships in the root CommonJS runtime.

## Current source of truth

The Phase 9A governance slice currently ships these capability families:

- repository governance and admin-posture inspection:
  - `ruleset.list`
  - `ruleset.inspect`
  - `environment.list`
  - `environment.inspect`
  - `webhook.list`
  - `webhook.inspect`
  - `app.status`
  - `app.installation.inspect`
  - `app.permissions.inspect`
- metadata-only Actions inventory:
  - `secret.list`
  - `secret.inspect`
  - `variable.list`
  - `variable.inspect`
- repo-content governance discovery:
  - `codeowners.inspect`
  - `template.inspect`

Implementation seams:

- `src/main/github/governance-redaction.js` — shared repo-target validation, summarization, redaction, and offline-content helpers
- `src/main/github/auth-status.js` — GitHub/Copilot auth status plus governance access hints
- `src/main/github/ruleset-list.js` / `ruleset-inspect.js` — repository ruleset inventory
- `src/main/github/environment-list.js` / `environment-inspect.js` — repository environment inventory
- `src/main/github/secret-list.js` / `secret-inspect.js` — metadata-only Actions secret inventory
- `src/main/github/variable-list.js` / `variable-inspect.js` — metadata-only Actions variable inventory
- `src/main/github/codeowners-inspect.js` — local/remote CODEOWNERS inspection with offline workspace preference
- `src/main/github/template-inspect.js` — local/remote issue and PR template inspection with offline workspace preference
- `src/main/github/webhook-list.js` / `webhook-inspect.js` — metadata-only repository webhook inventory
- `src/main/github/app-status.js` / `app-installation-inspect.js` / `app-permissions-inspect.js` — GitHub App posture and installation visibility
- `src/main/github/command-executor.js` — shared CLI/slash routing and policy metadata attachment
- `src/cli/commands/github.js` — CLI help and human-readable governance formatters
- `src/main/github/slash-command-handler.js` — `/github ...` help and chat-friendly governance formatters

These commands are intentionally read-only. They should summarize posture, permissions, and inventory metadata without mutating GitHub and without exposing secret/variable values or sensitive webhook config.

## Validation layers

Use the narrowest deterministic layer first, then broaden only when the touched behavior crosses a real GitHub runtime boundary.

| Layer | Use for | Commands |
| --- | --- | --- |
| Focused governance bundle | Phase 9A runtime/mock contracts | `npm run test:github-phase9-readonly` |
| Focused governance script | Narrow governance-specific debugging | `node scripts/test-github-phase9-readonly.js` |
| Registry/policy coverage | Capability metadata and executor routing | `node scripts/test-github-capability-policy.js` |
| CLI contract | `liku github ...` help and JSON surface | `node scripts/test-cli-github-command.js` |
| Slash contract | `/github ...` help and formatter parity | `node scripts/test-ai-service-github-slash-commands.js` |
| Workflow bundle | Prove governance work did not regress workflow preview/apply-read surfaces | `npm run test:github-phase8-workflows` |

Recommended deterministic proof command before any live GitHub validation:

```powershell
npm run test:github-phase9-readonly
```

## Safe live-proof prerequisites

Run live governance proofs only when all of the following are true:

1. The target repository is non-production or operationally safe to inspect.
2. You are validating read-only inventory only; do not treat this runbook as permission to mutate rulesets, environments, webhooks, or repository settings.
3. You understand that some admin-facing endpoints may require repo-admin scopes or elevated app permissions.
4. You have authenticated GitHub REST access via `GH_TOKEN` or `GITHUB_TOKEN` when validating private or admin-only metadata.
5. You are prepared for fail-soft outcomes when GitHub denies access. Missing admin scopes should surface as warnings or partial results, not as a reason to weaken redaction or safety checks.
6. For offline CODEOWNERS/template proofs, you are intentionally using the current workspace with `--api false`.

Unlike the reviewed write surfaces, explicit read-only governance commands do not require `LIKU_ENABLE_GITHUB_WRITES=1`, and they should remain usable even when the general feature flag is not explicitly enabled.

## Recommended proof sequence

### 1. Confirm auth posture and governance hints first

```powershell
liku github auth status --probe false --json
liku github app status --slug owner/repo --probe false --api false --json
```

Confirm that the report exposes governance access hints and clearly indicates whether token-backed GitHub REST inspection is available.

### 2. Inspect rulesets and environments

```powershell
liku github ruleset list --slug owner/repo --limit 10 --json
liku github ruleset inspect 12 --slug owner/repo --json
liku github environment list --slug owner/repo --limit 10 --json
liku github environment inspect production --slug owner/repo --json
```

Capture enforcement, bypass, branch targeting, reviewer, and wait-timer summaries without changing repository policy.

### 3. Verify metadata-only secret and variable inventory

```powershell
liku github secret list --slug owner/repo --limit 10 --json
liku github secret inspect GH_TOKEN --slug owner/repo --json
liku github variable list --slug owner/repo --limit 10 --json
liku github variable inspect FEATURE_FLAG --slug owner/repo --json
```

Validate that values are not exposed. Only names, timestamps, scopes, and similar metadata should be present in model-visible output.

### 4. Prefer offline workspace proof for CODEOWNERS and templates when possible

```powershell
liku github codeowners inspect --api false --json
liku github template inspect --api false --json
```

Use `--slug owner/repo` only when you intentionally want remote GitHub contents lookup. For local validation, make sure the current workspace is the intended repo root or explicit `cwd`.

### 5. Inspect webhooks and app installation posture

```powershell
liku github webhook list --slug owner/repo --limit 10 --json
liku github webhook inspect 9001 --slug owner/repo --json
liku github app installation inspect --slug owner/repo --json
liku github app permissions inspect --slug owner/repo --json
```

Confirm that webhook URLs, secrets, tokens, and other sensitive config remain redacted or summarized, and that app installation visibility/permission reports stay descriptive rather than mutating.

## Evidence to capture

When a PR changes GitHub governance inventory capability, capture at least:

- the deterministic proof command(s) you ran
- whether the proof was local/offline (`--api false`) or GitHub REST-backed
- the target repository slug and any inspected ids/names (ruleset id, environment name, webhook id, secret/variable name)
- whether any warnings indicated missing repo-admin scopes or unavailable installation visibility
- sample redacted JSON or formatted output proving metadata-only handling
- for local CODEOWNERS/template proofs, the workspace root used during validation

Do not commit captured artifacts that contain local paths, runtime traces, approval files, or token-derived metadata.

## Safety boundaries

- All Phase 9A commands are read-only. Do not add preview/apply behavior under these names.
- Secret and variable values must remain hidden; webhook config must remain redacted.
- Missing admin scopes are not a bug by themselves. The code should fail soft and explain what was unavailable.
- `codeowners inspect` and `template inspect` may use the current workspace; do not weaken repo-target checks just to make an API-backed test pass.
- If live GitHub behavior disagrees with a deterministic test, treat the live behavior as the source of truth and update tests deliberately.

## Current limitations

- There is not yet a dedicated live smoke harness for governance inventory comparable to the TradingView proof lane.
- Some repository settings endpoints require scopes that are not present in ordinary developer tokens; partial visibility is expected.
- Local workspace proof for `codeowners inspect` and `template inspect` is intentionally limited to standard repo locations and does not attempt arbitrary filesystem discovery.
