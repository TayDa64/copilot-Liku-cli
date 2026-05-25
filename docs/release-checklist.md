# Release Checklist

This checklist is the Phase 6 shipping guardrail for `copilot-liku-cli`.

## Preflight

- Confirm the branch is synced with `origin/main`.
- Confirm the working tree is clean.
- Confirm the version in `package.json` is the intended release version.
- Review the most recent release notes / changelog text.
- Confirm no generated artifacts, local traces, secrets, or scratch files are staged.

## Validation

Run the narrow release-facing checks locally before publishing:

```bash
npm run test:cli-phase01
npm run test:persistence-controls
npm run test:github-phase5-bundles
npm run verify:package
```

## Package Review

- Inspect the `npm pack --dry-run` summary.
- Confirm the published bin target (`src/cli/liku.js`) is present.
- Confirm required docs (`README.md`, `LICENSE.md`, `QUICKSTART.md`, `INSTALLATION.md`) are present.
- Confirm test scripts, workflow files, traces, and other non-shipping artifacts are absent.

## GitHub Actions Workflows

- `validate.yml` — fast CLI seam and ai-service contract validation
- `test.yml` — persistence + GitHub regression suites
- `package.yml` — npm pack dry-run verification and manifest artifact upload
- `publish-npm.yml` — release-time publish workflow

## Publish

- Trigger the npm publish workflow only from the reviewed release path.
- Ensure package verification passes before `npm publish` runs.
- Verify the target version is not already published.
- After publish, confirm the package is installable from npm.

## Rollback / Recovery

npm versions cannot be overwritten. If a bad version is published:

1. Deprecate the bad version on npm.
2. Prepare and publish a fixed follow-up version.
3. Update release notes to call out the bad version and replacement.
4. If the published artifact exposed sensitive data, rotate affected secrets immediately and document the incident.
