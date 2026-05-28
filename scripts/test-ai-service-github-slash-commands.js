#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-github-slash-'));
process.env.LIKU_HOME_OVERRIDE = path.join(tempRoot, '.liku');
process.env.LIKU_HOME_OLD_OVERRIDE = path.join(tempRoot, '.liku-cli-old');
process.env.LIKU_ENABLE_GITHUB = '1';
process.env.LIKU_ENABLE_GITHUB_WRITES = '1';

const aiService = require(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'));
const { ingestGitHubWebhookEvent } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'webhook-event-runtime.js'));
const { buildGitHubExecutionPlan } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'plan-builder.js'));
const {
  appendGitHubPlanEvent,
  writeGitHubPlanArtifact,
  writeGitHubPlanGuidanceArtifact,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'plan-artifacts.js'));

let pass = 0;

async function test(name, fn) {
  await fn();
  pass += 1;
  console.log(`PASS ${name}`);
}

(async () => {
  try {
    await test('aiService.handleCommand exposes shared /github help', async () => {
    const result = await aiService.handleCommand('/github help');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.message.includes('Shared GitHub slash commands:'));
    assert.ok(result.message.includes('/github capabilities list'));
    assert.ok(result.message.includes('/github context bundle pr <number>'));
    assert.ok(result.message.includes('/github issues comment draft <number> (--body <text> | --body-file <path>)'));
    assert.ok(result.message.includes('/github pr create draft --title <text> [--body <text> | --body-file <path>] [--base branch] [--head branch|owner:branch] [--draft true|false] [--slug owner/repo] [--api false]'));
    assert.ok(result.message.includes('/github pr comment draft <number> (--body <text> | --body-file <path>)'));
    assert.ok(result.message.includes('/github pr review draft <number> --event <comment|approve|request-changes> [--body <text> | --body-file <path>] [--slug owner/repo]'));
    assert.ok(result.message.includes('/github pr close draft <number> [--slug owner/repo]'));
    assert.ok(result.message.includes('/github pr reopen draft <number> [--slug owner/repo]'));
    assert.ok(result.message.includes('/github workflow validate <path> [--body <text> | --body-file <path>] [--slug owner/repo]'));
    assert.ok(result.message.includes('/github workflow create draft <path> [--body <text> | --body-file <path>] [--base branch] [--head branch] [--slug owner/repo] [--api false]'));
    assert.ok(result.message.includes('/github workflow dispatch draft <workflow-id|file> [--ref branch|tag|sha] [--inputs-json <json> | --inputs-file <path>] [--slug owner/repo]'));
    assert.ok(result.message.includes('/github plan build'));
    assert.ok(result.message.includes('/github plan execute'));
    assert.ok(result.message.includes('/github plan resume --guidance-file <path> --resume-token <token>'));
    assert.ok(result.message.includes('/github plan runs [--slug owner/repo] [--limit N] [--state completed|blocked|aborted|all]'));
    assert.ok(result.message.includes('/github plan inspect <run-id> [--slug owner/repo] [--plan-file <path>] [--event-log-file <path>]'));
    assert.ok(result.message.includes('/github ruleset list [--slug owner/repo] [--limit N] [--api false]'));
    assert.ok(result.message.includes('/github environment inspect <name> [--slug owner/repo] [--api false]'));
    assert.ok(result.message.includes('/github secret list [--slug owner/repo] [--limit N] [--api false]'));
    assert.ok(result.message.includes('/github codeowners inspect [--slug owner/repo] [--api false]'));
    assert.ok(result.message.includes('/github codeowners create draft [--path <path>] [--body <text> | --body-file <path>] [--base branch] [--head branch] [--slug owner/repo] [--api false]'));
    assert.ok(result.message.includes('/github template inspect [--slug owner/repo] [--api false]'));
    assert.ok(result.message.includes('/github webhook inspect <id> [--slug owner/repo] [--api false]'));
    assert.ok(result.message.includes('/github webhook create draft --events <csv> --target-url <url> --secret-ref repo:<ENV_NAME> [--content-type <json|form>] [--active true|false] [--slug owner/repo]'));
    assert.ok(result.message.includes('/github webhook ping draft <id> [--slug owner/repo]'));
    assert.ok(result.message.includes('/github event list [--slug owner/repo] [--limit N] [--event <name>]'));
    assert.ok(result.message.includes('/github event inspect <event-id> [--slug owner/repo]'));
    assert.ok(result.message.includes('/github app permissions inspect [--slug owner/repo] [--api false]'));
    assert.ok(result.message.includes('/github pr status [--slug owner/repo] [--branch name] [--head owner:branch]'));
    assert.ok(result.message.includes('/github pr view [--slug owner/repo] [--branch name] [--head owner:branch]'));
    assert.ok(result.message.includes('/github pr feedback [<number>] [--slug owner/repo] [--branch name] [--head owner:branch] [--state open|closed|all] [--limit N] [--api false]'));
    assert.ok(result.message.includes('/github pr diff <number>'));
    assert.ok(result.message.includes('/github releases inspect <latest|tag|id>'));
    assert.ok(result.message.includes('Governance inventory surfaces are repo-scoped, read-only, and fail soft when tokens or repo-admin scopes are missing.'));
    assert.ok(result.message.includes('/github event list ...` and `/github event inspect ...` read the local GitHub event journal'));
    assert.ok(result.message.includes('/github plan runs ...` and `/github plan inspect ...` read the local GitHub plan ledger'));
    assert.ok(result.message.includes('Actual apply remains intentionally CLI-only in this reviewed GitHub write slice'));
    });

    await test('aiService.handleCommand exposes /github capabilities list through the registry catalog', async () => {
    const result = await aiService.handleCommand('/github capabilities list');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.data);
    assert.strictEqual(result.data.schemaVersion, 'github.capabilities-list.v1');
    assert.strictEqual(result.data.capability.key, 'capabilities.list');
    assert.strictEqual(result.data.policy.allowed, true);
    assert.ok(Array.isArray(result.data.capabilities));
    assert.ok(result.data.capabilities.some((entry) => entry.key === 'pr.diff'));
    assert.ok(result.data.capabilities.some((entry) => entry.key === 'pr.status'));
    assert.ok(result.message.includes('GitHub capabilities list'));
    });

    await test('aiService.handleCommand exposes /github capabilities inspect through the registry catalog', async () => {
    const result = await aiService.handleCommand('/github capabilities inspect pr.diff');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.data);
    assert.strictEqual(result.data.schemaVersion, 'github.capability-inspect.v1');
    assert.strictEqual(result.data.capability.key, 'capabilities.inspect');
    assert.strictEqual(result.data.policy.allowed, true);
    assert.strictEqual(result.data.entry.key, 'pr.diff');
    assert.strictEqual(result.data.entry.policyBySource.slash.allowed, true);
    assert.ok(result.message.includes('GitHub capability inspect'));
    });

    await test('aiService.handleCommand exposes /github context bundle through the reviewed bundle seam', async () => {
    const result = await aiService.handleCommand('/github context bundle repo --api false --limit 3');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.data);
    assert.strictEqual(result.data.schemaVersion, 'github.context-bundle.v1');
    assert.strictEqual(result.data.capability.key, 'context.bundle');
    assert.strictEqual(result.data.policy.allowed, true);
    assert.strictEqual(result.data.target.kind, 'repo');
    assert.strictEqual(result.data.review.exportKind, 'github-context-bundle');
    assert.strictEqual(result.data.review.reviewRequired, true);
    assert.ok(result.data.artifact.filePath);
    assert.ok(fs.existsSync(result.data.artifact.filePath));
    assert.ok(result.message.includes('GitHub context bundle'));
    });

    await test('aiService.handleCommand exposes /github issues comment draft as a reviewed local preview', async () => {
    const result = await aiService.handleCommand('/github issues comment draft 321 --slug owner/repo --body "Authorization: Bearer ghp_secret_token_12345678901234567890 Please retest this."');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.data);
    assert.strictEqual(result.data.schemaVersion, 'github.issue-comment-draft.v1');
    assert.strictEqual(result.data.capability.key, 'issues.comment.draft');
    assert.strictEqual(result.data.policy.allowed, true);
    assert.strictEqual(result.data.policy.state, 'preview-allowed');
    assert.strictEqual(result.data.target.slug, 'owner/repo');
    assert.strictEqual(result.data.issueNumber, 321);
    assert.strictEqual(result.data.review.exportKind, 'github-write-preview');
    assert.strictEqual(result.data.review.reviewRequired, true);
    assert.ok(result.data.previewArtifact.filePath);
    assert.ok(result.data.approvalArtifact.filePath);
    assert.ok(fs.existsSync(result.data.previewArtifact.filePath));
    assert.ok(fs.existsSync(result.data.approvalArtifact.filePath));
    assert.ok(result.message.includes('GitHub issue comment draft'));
    assert.ok(result.message.includes('Apply via CLI: liku github apply'));
    assert.ok(result.message.includes('Slash apply is intentionally unavailable'));
    const previewArtifact = JSON.parse(fs.readFileSync(result.data.previewArtifact.filePath, 'utf8'));
    assert.ok(previewArtifact.input.body.includes('[redacted token]'));
    assert.ok(!previewArtifact.input.body.includes('ghp_secret_token_12345678901234567890'));
    });

    await test('aiService.handleCommand exposes /github pr create draft as a reviewed local preview', async () => {
    const result = await aiService.handleCommand('/github pr create draft --slug owner/repo --api false --title "Authorization: Bearer ghp_secret_token_12345678901234567890 Add overlay diagnostics" --body "Authorization: Bearer ghp_secret_token_12345678901234567890 Implements the next PR slice." --base main --head feature/demo --draft true');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.data);
    assert.strictEqual(result.data.schemaVersion, 'github.pr-create-draft.v1');
    assert.strictEqual(result.data.capability.key, 'pr.create.draft');
    assert.strictEqual(result.data.policy.allowed, true);
    assert.strictEqual(result.data.policy.state, 'preview-allowed');
    assert.strictEqual(result.data.target.slug, 'owner/repo');
    assert.strictEqual(result.data.draft.baseBranch, 'main');
    assert.strictEqual(result.data.draft.head, 'feature/demo');
    assert.strictEqual(result.data.draft.headBranch, 'feature/demo');
    assert.strictEqual(result.data.draft.draft, true);
    assert.strictEqual(result.data.review.exportKind, 'github-write-preview');
    assert.strictEqual(result.data.review.reviewRequired, true);
    assert.ok(result.data.previewArtifact.filePath);
    assert.ok(result.data.approvalArtifact.filePath);
    assert.ok(fs.existsSync(result.data.previewArtifact.filePath));
    assert.ok(fs.existsSync(result.data.approvalArtifact.filePath));
    assert.ok(result.message.includes('GitHub pull request create draft'));
    assert.ok(result.message.includes('Apply via CLI: liku github apply'));
    assert.ok(result.message.includes('Slash apply is intentionally unavailable'));
    const previewArtifact = JSON.parse(fs.readFileSync(result.data.previewArtifact.filePath, 'utf8'));
    assert.strictEqual(previewArtifact.target.baseBranch, 'main');
    assert.strictEqual(previewArtifact.target.head, 'feature/demo');
    assert.strictEqual(previewArtifact.target.draft, true);
    assert.ok(previewArtifact.input.title.includes('[redacted token]'));
    assert.ok(previewArtifact.input.body.includes('[redacted token]'));
    assert.ok(!previewArtifact.input.title.includes('ghp_secret_token_12345678901234567890'));
    assert.ok(!previewArtifact.input.body.includes('ghp_secret_token_12345678901234567890'));
    });

    await test('aiService.handleCommand exposes /github pr comment draft as a reviewed local preview', async () => {
    const result = await aiService.handleCommand('/github pr comment draft 123 --slug owner/repo --body "Authorization: Bearer ghp_secret_token_12345678901234567890 Looks good overall."');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.data);
    assert.strictEqual(result.data.schemaVersion, 'github.pr-comment-draft.v1');
    assert.strictEqual(result.data.capability.key, 'pr.comment.draft');
    assert.strictEqual(result.data.policy.allowed, true);
    assert.strictEqual(result.data.policy.state, 'preview-allowed');
    assert.strictEqual(result.data.target.slug, 'owner/repo');
    assert.strictEqual(result.data.pullRequestNumber, 123);
    assert.strictEqual(result.data.review.exportKind, 'github-write-preview');
    assert.strictEqual(result.data.review.reviewRequired, true);
    assert.ok(result.data.previewArtifact.filePath);
    assert.ok(result.data.approvalArtifact.filePath);
    assert.ok(fs.existsSync(result.data.previewArtifact.filePath));
    assert.ok(fs.existsSync(result.data.approvalArtifact.filePath));
    assert.ok(result.message.includes('GitHub pull request comment draft'));
    assert.ok(result.message.includes('Apply via CLI: liku github apply'));
    assert.ok(result.message.includes('Slash apply is intentionally unavailable'));
    const previewArtifact = JSON.parse(fs.readFileSync(result.data.previewArtifact.filePath, 'utf8'));
    assert.strictEqual(previewArtifact.target.pullRequestNumber, 123);
    assert.ok(previewArtifact.input.body.includes('[redacted token]'));
    assert.ok(!previewArtifact.input.body.includes('ghp_secret_token_12345678901234567890'));
    });

    await test('aiService.handleCommand exposes /github pr review draft as a reviewed local preview', async () => {
    const result = await aiService.handleCommand('/github pr review draft 123 --slug owner/repo --event approve --body "Looks good overall."');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.data);
    assert.strictEqual(result.data.schemaVersion, 'github.pr-review-draft.v1');
    assert.strictEqual(result.data.capability.key, 'pr.review.draft');
    assert.strictEqual(result.data.policy.allowed, true);
    assert.strictEqual(result.data.policy.state, 'preview-allowed');
    assert.strictEqual(result.data.target.slug, 'owner/repo');
    assert.strictEqual(result.data.pullRequestNumber, 123);
    assert.strictEqual(result.data.draft.reviewEvent, 'approve');
    assert.strictEqual(result.data.draft.reviewEventApi, 'APPROVE');
    assert.strictEqual(result.data.review.exportKind, 'github-write-preview');
    assert.strictEqual(result.data.review.reviewRequired, true);
    assert.ok(result.data.previewArtifact.filePath);
    assert.ok(result.data.approvalArtifact.filePath);
    assert.ok(fs.existsSync(result.data.previewArtifact.filePath));
    assert.ok(fs.existsSync(result.data.approvalArtifact.filePath));
    assert.ok(result.message.includes('GitHub pull request review draft'));
    assert.ok(result.message.includes('Apply via CLI: liku github apply'));
    assert.ok(result.message.includes('Slash apply is intentionally unavailable'));
    const previewArtifact = JSON.parse(fs.readFileSync(result.data.previewArtifact.filePath, 'utf8'));
    assert.strictEqual(previewArtifact.target.pullRequestNumber, 123);
    assert.strictEqual(previewArtifact.target.reviewEvent, 'approve');
    assert.strictEqual(previewArtifact.target.reviewEventApi, 'APPROVE');
    });

    await test('aiService.handleCommand exposes /github pr close draft as a reviewed local preview', async () => {
    const result = await aiService.handleCommand('/github pr close draft 123 --slug owner/repo');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.data);
    assert.strictEqual(result.data.schemaVersion, 'github.pr-close-draft.v1');
    assert.strictEqual(result.data.capability.key, 'pr.close.draft');
    assert.strictEqual(result.data.policy.allowed, true);
    assert.strictEqual(result.data.policy.state, 'preview-allowed');
    assert.strictEqual(result.data.target.slug, 'owner/repo');
    assert.strictEqual(result.data.pullRequestNumber, 123);
    assert.strictEqual(result.data.draft.stateAction, 'close');
    assert.strictEqual(result.data.draft.desiredState, 'closed');
    assert.strictEqual(result.data.review.exportKind, 'github-write-preview');
    assert.strictEqual(result.data.review.reviewRequired, true);
    assert.ok(result.data.previewArtifact.filePath);
    assert.ok(result.data.approvalArtifact.filePath);
    assert.ok(fs.existsSync(result.data.previewArtifact.filePath));
    assert.ok(fs.existsSync(result.data.approvalArtifact.filePath));
    assert.ok(result.message.includes('GitHub pull request close draft'));
    assert.ok(result.message.includes('Apply via CLI: liku github apply'));
    assert.ok(result.message.includes('Slash apply is intentionally unavailable'));
    const previewArtifact = JSON.parse(fs.readFileSync(result.data.previewArtifact.filePath, 'utf8'));
    assert.strictEqual(previewArtifact.target.pullRequestNumber, 123);
    assert.strictEqual(previewArtifact.target.desiredState, 'closed');
    });

    await test('aiService.handleCommand exposes /github pr reopen draft as a reviewed local preview', async () => {
    const result = await aiService.handleCommand('/github pr reopen draft 123 --slug owner/repo');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.data);
    assert.strictEqual(result.data.schemaVersion, 'github.pr-reopen-draft.v1');
    assert.strictEqual(result.data.capability.key, 'pr.reopen.draft');
    assert.strictEqual(result.data.policy.allowed, true);
    assert.strictEqual(result.data.policy.state, 'preview-allowed');
    assert.strictEqual(result.data.target.slug, 'owner/repo');
    assert.strictEqual(result.data.pullRequestNumber, 123);
    assert.strictEqual(result.data.draft.stateAction, 'reopen');
    assert.strictEqual(result.data.draft.desiredState, 'open');
    assert.strictEqual(result.data.review.exportKind, 'github-write-preview');
    assert.strictEqual(result.data.review.reviewRequired, true);
    assert.ok(result.data.previewArtifact.filePath);
    assert.ok(result.data.approvalArtifact.filePath);
    assert.ok(fs.existsSync(result.data.previewArtifact.filePath));
    assert.ok(fs.existsSync(result.data.approvalArtifact.filePath));
    assert.ok(result.message.includes('GitHub pull request reopen draft'));
    assert.ok(result.message.includes('Apply via CLI: liku github apply'));
    assert.ok(result.message.includes('Slash apply is intentionally unavailable'));
    const previewArtifact = JSON.parse(fs.readFileSync(result.data.previewArtifact.filePath, 'utf8'));
    assert.strictEqual(previewArtifact.target.pullRequestNumber, 123);
    assert.strictEqual(previewArtifact.target.desiredState, 'open');
    });

    await test('aiService.handleCommand exposes /github workflow validate as a local workflow analyzer', async () => {
    const result = await aiService.handleCommand('/github workflow validate .github/workflows/validate.yml --slug owner/repo --body "name: Validate\non:\n  push:\npermissions: {}\njobs:\n  validate:\n    permissions:\n      contents: read\n    steps:\n      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5\n        with:\n          persist-credentials: false"');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.data);
    assert.strictEqual(result.data.schemaVersion, 'github.workflow-validate.v1');
    assert.strictEqual(result.data.capability.key, 'workflow.validate');
    assert.strictEqual(result.data.policy.allowed, true);
    assert.strictEqual(result.data.workflowPath, '.github/workflows/validate.yml');
    assert.strictEqual(result.data.validation.valid, true);
    assert.ok(result.message.includes('GitHub workflow validate'));
    });

    await test('aiService.handleCommand exposes /github workflow create draft as a reviewed repo-content preview', async () => {
    const result = await aiService.handleCommand('/github workflow create draft .github/workflows/validate.yml --slug owner/repo --base main --head feature/workflow-validate --body "name: Validate\non:\n  push:\npermissions: {}\njobs:\n  validate:\n    permissions:\n      contents: read\n    steps:\n      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5\n        with:\n          persist-credentials: false"');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.data);
    assert.strictEqual(result.data.schemaVersion, 'github.workflow-create-draft.v1');
    assert.strictEqual(result.data.capability.key, 'workflow.create.draft');
    assert.strictEqual(result.data.policy.allowed, true);
    assert.strictEqual(result.data.policy.state, 'preview-allowed');
    assert.strictEqual(result.data.workflowPath, '.github/workflows/validate.yml');
    assert.strictEqual(result.data.draft.baseBranch, 'main');
    assert.strictEqual(result.data.draft.headBranch, 'feature/workflow-validate');
    assert.ok(result.message.includes('GitHub workflow create draft'));
    assert.ok(result.message.includes('Apply via CLI: liku github apply'));
    const previewArtifact = JSON.parse(fs.readFileSync(result.data.previewArtifact.filePath, 'utf8'));
    assert.strictEqual(previewArtifact.previewType, 'repo-content-patch');
    assert.strictEqual(previewArtifact.target.path, '.github/workflows/validate.yml');
    });

    await test('aiService.handleCommand exposes /github codeowners create draft as a reviewed repo-content preview', async () => {
    const result = await aiService.handleCommand('/github codeowners create draft --slug owner/repo --api false --base main --head feature/codeowners --body "* @octocat\n/docs/ @docs-team"');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.data);
    assert.strictEqual(result.data.schemaVersion, 'github.codeowners-create-draft.v1');
    assert.strictEqual(result.data.capability.key, 'codeowners.create.draft');
    assert.strictEqual(result.data.policy.allowed, true);
    assert.strictEqual(result.data.policy.state, 'preview-allowed');
    assert.strictEqual(result.data.codeownersPath, '.github/CODEOWNERS');
    assert.strictEqual(result.data.draft.baseBranch, 'main');
    assert.strictEqual(result.data.draft.headBranch, 'feature/codeowners');
    assert.ok(result.message.includes('GitHub CODEOWNERS create draft'));
    assert.ok(result.message.includes('Apply via CLI: liku github apply'));
    const previewArtifact = JSON.parse(fs.readFileSync(result.data.previewArtifact.filePath, 'utf8'));
    assert.strictEqual(previewArtifact.previewType, 'repo-content-patch');
    assert.strictEqual(previewArtifact.target.resourceFamily, 'codeowners');
    assert.strictEqual(previewArtifact.target.path, '.github/CODEOWNERS');
    });

    await test('aiService.handleCommand exposes /github webhook create draft as a reviewed operational preview', async () => {
    const result = await aiService.handleCommand('/github webhook create draft --slug owner/repo --events push,pull_request --target-url https://assistant.example.com/github/webhook --secret-ref repo:LIKU_WEBHOOK_SECRET --content-type json');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.data);
    assert.strictEqual(result.data.schemaVersion, 'github.webhook-create-draft.v1');
    assert.strictEqual(result.data.capability.key, 'webhook.create.draft');
    assert.strictEqual(result.data.policy.allowed, true);
    assert.strictEqual(result.data.policy.state, 'preview-allowed');
    assert.strictEqual(result.data.policy.riskLevel, 'medium');
    assert.strictEqual(result.data.draft.targetUrl, 'https://assistant.example.com/github/webhook');
    assert.deepStrictEqual(result.data.draft.events, ['push', 'pull_request']);
    assert.strictEqual(result.data.draft.secretRef, 'repo:LIKU_WEBHOOK_SECRET');
    assert.strictEqual(result.data.draft.contentType, 'json');
    assert.ok(result.message.includes('GitHub webhook create draft'));
    assert.ok(result.message.includes('Apply via CLI: liku github apply'));
    const previewArtifact = JSON.parse(fs.readFileSync(result.data.previewArtifact.filePath, 'utf8'));
    assert.strictEqual(previewArtifact.previewType, 'webhook-create');
    assert.strictEqual(previewArtifact.target.secretRef, 'repo:LIKU_WEBHOOK_SECRET');
    });

    await test('aiService.handleCommand exposes /github event list as a local event-journal read path', async () => {
    await ingestGitHubWebhookEvent({
      slug: 'owner/repo',
      eventName: 'push',
      deliveryId: 'slash-event-delivery-1',
      headers: {
        'x-github-event': 'push',
        authorization: 'Bearer ghp_secret_token_12345678901234567890',
      },
      payload: {
        repository: { full_name: 'owner/repo' },
        sender: { login: 'octocat' },
        ref: 'refs/heads/main',
        after: 'abcdef1234567890',
        commits: [{ id: '1' }],
        head_commit: { message: 'Ship it' },
      },
    });

    const result = await aiService.handleCommand('/github event list --slug owner/repo --limit 5 --event push');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.data);
    assert.strictEqual(result.data.schemaVersion, 'github.event-list.v1');
    assert.strictEqual(result.data.capability.key, 'event.list');
    assert.strictEqual(result.data.policy.allowed, true);
    assert.strictEqual(result.data.localOnly, true);
    assert.strictEqual(result.data.target.slug, 'owner/repo');
    assert.ok(Array.isArray(result.data.events));
    assert.strictEqual(result.data.events[0].eventName, 'push');
    assert.strictEqual(result.data.events[0].slug, 'owner/repo');
    assert.ok(result.message.includes('GitHub event list'));
    });

    await test('aiService.handleCommand exposes /github event inspect as a local event-journal read path', async () => {
    const ingested = await ingestGitHubWebhookEvent({
      slug: 'owner/repo',
      eventName: 'issues',
      deliveryId: 'slash-event-delivery-2',
      headers: {
        'x-github-event': 'issues',
        'x-hub-signature-256': 'sha256=abcdef123456',
      },
      payload: {
        action: 'opened',
        repository: { full_name: 'owner/repo' },
        sender: { login: 'octocat' },
        issue: {
          number: 77,
          title: 'Investigate event journal',
          body: 'Authorization: Bearer ghp_secret_token_12345678901234567890',
          state: 'open',
        },
      },
    });

    const result = await aiService.handleCommand(`/github event inspect ${ingested.eventId} --slug owner/repo`);
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.data);
    assert.strictEqual(result.data.schemaVersion, 'github.event-inspect.v1');
    assert.strictEqual(result.data.capability.key, 'event.inspect');
    assert.strictEqual(result.data.policy.allowed, true);
    assert.strictEqual(result.data.event.eventId, ingested.eventId);
    assert.strictEqual(result.data.event.eventName, 'issues');
    assert.strictEqual(result.data.event.headers['x-hub-signature-256'], '[redacted]');
    assert.ok(String(result.data.event.payload.issue.body).startsWith('[redacted issue body;'));
    assert.ok(result.message.includes('GitHub event inspect'));
    });

    await test('aiService.handleCommand exposes /github workflow dispatch draft as a reviewed operational preview', async () => {
    const result = await aiService.handleCommand("/github workflow dispatch draft validate.yml --slug owner/repo --ref main --inputs-json '{\"target\":\"staging\"}'");
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.data);
    assert.strictEqual(result.data.schemaVersion, 'github.workflow-dispatch-draft.v1');
    assert.strictEqual(result.data.capability.key, 'workflow.dispatch.draft');
    assert.strictEqual(result.data.policy.allowed, true);
    assert.strictEqual(result.data.policy.riskLevel, 'low');
    assert.strictEqual(result.data.draft.workflow, 'validate.yml');
    assert.strictEqual(result.data.draft.ref, 'main');
    assert.strictEqual(result.data.draft.inputsCount, 1);
    assert.ok(result.message.includes('GitHub workflow dispatch draft'));
    assert.ok(result.message.includes('Apply via CLI: liku github apply'));
    });

    await test('aiService.handleCommand exposes /github plan build through the registry-backed planner', async () => {
    const result = await aiService.handleCommand('/github plan build pr diff 7 --limit 30 --api false');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.data);
    assert.strictEqual(result.data.schemaVersion, 'github.plan-build.v1');
    assert.strictEqual(result.data.capability.key, 'plan.build');
    assert.strictEqual(result.data.policy.allowed, true);
    assert.strictEqual(result.data.targetCapability.key, 'pr.diff');
    assert.strictEqual(result.data.plan.schemaVersion, 'github.execution-plan.v1');
    assert.strictEqual(result.data.plan.steps[0].capabilityKey, 'pr.diff');
    assert.strictEqual(result.data.plan.steps[0].runtimeInput.api, false);
    assert.ok(result.message.includes('GitHub plan build'));
    });

    await test('aiService.handleCommand exposes /github plan execute through the bounded registry-backed executor', async () => {
      const result = await aiService.handleCommand('/github plan execute pr diff 7 --limit 30 --api false');
      assert.ok(result);
      assert.strictEqual(result.type, 'info');
      assert.ok(result.data);
      assert.strictEqual(result.data.schemaVersion, 'github.plan-execute.v1');
      assert.strictEqual(result.data.capability.key, 'plan.execute');
      assert.strictEqual(result.data.policy.allowed, true);
      assert.strictEqual(result.data.success, true);
      assert.strictEqual(result.data.targetCapability.key, 'pr.diff');
      assert.strictEqual(result.data.execution.stepsExecuted, 1);
      assert.strictEqual(result.data.execution.timedOut, false);
      assert.strictEqual(result.data.execution.terminalEvent, 'execution.completed');
      assert.ok(result.data.run.runId);
      assert.ok(result.data.eventLog.filePath);
      assert.ok(result.data.planArtifact.filePath);
      assert.ok(result.data.resultArtifact.filePath);
      assert.ok(fs.existsSync(result.data.eventLog.filePath));
      assert.ok(fs.existsSync(result.data.planArtifact.filePath));
      assert.ok(fs.existsSync(result.data.resultArtifact.filePath));
      assert.ok(result.message.includes('GitHub plan execute'));
    });

    await test('aiService.handleCommand replays /github plan execute from a saved plan artifact', async () => {
      const initial = await aiService.handleCommand('/github plan execute issues list --api false --limit 5 --state all');
      assert.ok(initial?.data?.planArtifact?.filePath);

      const replay = await aiService.handleCommand(`/github plan execute --plan-file "${initial.data.planArtifact.filePath}"`);
      assert.ok(replay);
      assert.strictEqual(replay.type, 'info');
      assert.ok(replay.data);
      assert.strictEqual(replay.data.schemaVersion, 'github.plan-execute.v1');
      assert.strictEqual(replay.data.success, true);
      assert.strictEqual(replay.data.execution.planSource, 'artifact-replay');
      assert.strictEqual(replay.data.capability.key, 'plan.execute');
      assert.ok(replay.data.run.runId);
      assert.ok(replay.data.eventLog.filePath);
      assert.ok(fs.existsSync(replay.data.eventLog.filePath));
      assert.ok(replay.message.includes('GitHub plan execute'));
    });

    await test('aiService.handleCommand resumes /github plan resume from a saved guidance checkpoint', async () => {
      const resumePlanReport = buildGitHubExecutionPlan({
        source: 'slash',
        positionals: ['plan', 'build', 'issues', 'list'],
        runtimeOptions: { limit: 5, api: false },
      });
      const resumeRunId = 'github-run-slash-resume';
      const resumeToken = 'resume-token-slash';
      const resumePlanArtifact = writeGitHubPlanArtifact({
        source: 'slash',
        metadata: { mode: 'bounded-executor', orchestrationMode: 'bounded-evented', runId: resumeRunId },
        planReport: resumePlanReport,
      });
      appendGitHubPlanEvent({ artifactId: resumePlanArtifact.artifactId, runId: resumeRunId, sequence: 1, eventName: 'execution.started', source: 'slash', status: 'running' });
      appendGitHubPlanEvent({ artifactId: resumePlanArtifact.artifactId, runId: resumeRunId, sequence: 2, eventName: 'step.started', source: 'slash', status: 'running', step: { stepId: 'step-1', capabilityKey: 'issues.list' } });
      appendGitHubPlanEvent({ artifactId: resumePlanArtifact.artifactId, runId: resumeRunId, sequence: 3, eventName: 'guidance.requested', source: 'slash', status: 'blocked', step: { stepId: 'step-1', capabilityKey: 'issues.list' }, guidance: { guidanceId: 'github-guidance-slash', resumeToken } });
      const resumeGuidanceArtifact = writeGitHubPlanGuidanceArtifact({
        artifactId: resumePlanArtifact.artifactId,
        runId: resumeRunId,
        guidanceId: 'github-guidance-slash',
        status: 'requested',
        reason: 'user-clarification',
        resumeToken,
        requestedBy: { stepId: 'step-1', capabilityKey: 'issues.list' },
        questions: [
          {
            id: 'state',
            prompt: 'Which issue state should be used?',
            kind: 'single-select',
            targetType: 'option',
            targetField: 'state',
            allowFreeformInput: false,
            options: [
              { label: 'open', value: 'open' },
              { label: 'all', value: 'all' },
            ],
          },
        ],
        planArtifact: resumePlanArtifact,
        execution: {
          planSource: 'runtime-build',
          status: 'needs-guidance',
          startedAt: new Date().toISOString(),
          finishedAt: null,
          elapsedMs: 0,
          timedOut: false,
          terminal: false,
          stepsExecuted: 0,
        },
        blockedStepIndex: 0,
        stepResults: [],
      });
      const resumeAnswersPath = path.join(tempRoot, 'slash-resume-answers.json');
      fs.writeFileSync(resumeAnswersPath, JSON.stringify({ state: 'all' }, null, 2));

      const result = await aiService.handleCommand(`/github plan resume --guidance-file "${resumeGuidanceArtifact.filePath}" --resume-token ${resumeToken} --answers-file "${resumeAnswersPath}"`);
      assert.ok(result);
      assert.strictEqual(result.type, 'info');
      assert.ok(result.data);
      assert.strictEqual(result.data.schemaVersion, 'github.plan-resume.v1');
      assert.strictEqual(result.data.capability.key, 'plan.resume');
      assert.strictEqual(result.data.policy.allowed, true);
      assert.strictEqual(result.data.success, true);
      assert.strictEqual(result.data.run.runId, resumeRunId);
      assert.strictEqual(result.data.execution.status, 'completed');
      assert.strictEqual(result.data.stepResults[0].result.filters.state, 'all');
      assert.ok(result.data.resultArtifact.filePath);
      assert.ok(result.data.eventLog.filePath);
      assert.ok(fs.existsSync(result.data.resultArtifact.filePath));
      assert.ok(fs.existsSync(result.data.eventLog.filePath));
      assert.ok(result.message.includes('GitHub plan resume'));
    });

    await test('aiService.handleCommand exposes /github plan runs as a local plan-ledger read path', async () => {
      const blockedPlanReport = buildGitHubExecutionPlan({
        source: 'slash',
        positionals: ['plan', 'build', 'issues', 'list'],
        runtimeOptions: { slug: 'owner/repo', limit: 5, api: false },
      });
      const blockedRunId = 'github-run-slash-blocked';
      const blockedResumeToken = 'resume-token-slash-blocked';
      const blockedPlanArtifact = writeGitHubPlanArtifact({
        source: 'slash',
        metadata: { mode: 'bounded-executor', orchestrationMode: 'bounded-evented', runId: blockedRunId },
        planReport: blockedPlanReport,
      });
      appendGitHubPlanEvent({ artifactId: blockedPlanArtifact.artifactId, runId: blockedRunId, sequence: 1, eventName: 'execution.started', source: 'slash', status: 'running' });
      appendGitHubPlanEvent({ artifactId: blockedPlanArtifact.artifactId, runId: blockedRunId, sequence: 2, eventName: 'step.started', source: 'slash', status: 'running', step: { stepId: 'step-1', capabilityKey: 'issues.list' } });
      appendGitHubPlanEvent({ artifactId: blockedPlanArtifact.artifactId, runId: blockedRunId, sequence: 3, eventName: 'guidance.requested', source: 'slash', status: 'blocked', step: { stepId: 'step-1', capabilityKey: 'issues.list' }, guidance: { guidanceId: 'github-guidance-slash-blocked', resumeToken: blockedResumeToken } });
      writeGitHubPlanGuidanceArtifact({
        artifactId: blockedPlanArtifact.artifactId,
        runId: blockedRunId,
        guidanceId: 'github-guidance-slash-blocked',
        status: 'requested',
        reason: 'user-clarification',
        resumeToken: blockedResumeToken,
        requestedBy: { stepId: 'step-1', capabilityKey: 'issues.list' },
        questions: [
          {
            id: 'state',
            prompt: 'Which issue state should be used?',
            kind: 'single-select',
            targetType: 'option',
            targetField: 'state',
            allowFreeformInput: false,
            options: [
              { label: 'open', value: 'open' },
              { label: 'all', value: 'all' },
            ],
          },
        ],
        planArtifact: blockedPlanArtifact,
        execution: {
          planSource: 'runtime-build',
          status: 'needs-guidance',
          startedAt: new Date().toISOString(),
          finishedAt: null,
          elapsedMs: 0,
          timedOut: false,
          terminal: false,
          stepsExecuted: 0,
        },
        blockedStepIndex: 0,
        stepResults: [],
      });

      const result = await aiService.handleCommand('/github plan runs --slug owner/repo --limit 10 --state blocked');
      assert.ok(result);
      assert.strictEqual(result.type, 'info');
      assert.ok(result.data);
      assert.strictEqual(result.data.schemaVersion, 'github.plan-runs.v1');
      assert.strictEqual(result.data.capability.key, 'plan.runs');
      assert.strictEqual(result.data.policy.allowed, true);
      assert.strictEqual(result.data.localOnly, true);
      assert.strictEqual(result.data.target.slug, 'owner/repo');
      assert.strictEqual(result.data.filters.state, 'blocked');
      assert.strictEqual(result.data.runs[0].runId, blockedRunId);
      assert.strictEqual(result.data.runs[0].state, 'blocked');
      assert.ok(result.message.includes('GitHub plan runs'));
    });

    await test('aiService.handleCommand exposes /github plan inspect as a local plan-ledger inspect path', async () => {
      const blockedRunId = 'github-run-slash-blocked';
      const result = await aiService.handleCommand(`/github plan inspect ${blockedRunId} --slug owner/repo`);
      assert.ok(result);
      assert.strictEqual(result.type, 'info');
      assert.ok(result.data);
      assert.strictEqual(result.data.schemaVersion, 'github.plan-inspect.v1');
      assert.strictEqual(result.data.capability.key, 'plan.inspect');
      assert.strictEqual(result.data.policy.allowed, true);
      assert.strictEqual(result.data.run.runId, blockedRunId);
      assert.strictEqual(result.data.run.state, 'blocked');
      assert.strictEqual(result.data.execution.status, 'needs-guidance');
      assert.strictEqual(result.data.guidance.resumeToken, 'resume-token-slash-blocked');
      assert.strictEqual(result.data.eventLog.eventCount, 3);
      assert.ok(result.message.includes('GitHub plan inspect'));
    });

    await test('aiService.handleCommand routes new Phase 9A repo inventory commands through typed adapters', async () => {
    const rulesetResult = await aiService.handleCommand('/github ruleset list --slug owner/repo --limit 5 --api false');
    assert.ok(rulesetResult);
    assert.strictEqual(rulesetResult.type, 'info');
    assert.strictEqual(rulesetResult.data.schemaVersion, 'github.ruleset-list.v1');
    assert.strictEqual(rulesetResult.data.filters.limit, 5);
    assert.strictEqual(rulesetResult.data.githubApi.attempted, false);
    assert.strictEqual(rulesetResult.data.capability.key, 'ruleset.list');
    assert.ok(rulesetResult.message.includes('GitHub ruleset list'));

    const codeownersResult = await aiService.handleCommand('/github codeowners inspect --api false');
    assert.ok(codeownersResult);
    assert.strictEqual(codeownersResult.type, 'info');
    assert.strictEqual(codeownersResult.data.schemaVersion, 'github.codeowners-inspect.v1');
    assert.strictEqual(codeownersResult.data.codeowners, null);
    assert.strictEqual(codeownersResult.data.capability.key, 'codeowners.inspect');
    assert.ok(codeownersResult.message.includes('GitHub CODEOWNERS inspect'));

    const templateResult = await aiService.handleCommand('/github template inspect --api false');
    assert.ok(templateResult);
    assert.strictEqual(templateResult.type, 'info');
    assert.strictEqual(templateResult.data.schemaVersion, 'github.template-inspect.v1');
    assert.strictEqual(templateResult.data.templates.source, 'local-workspace');
    assert.ok(templateResult.data.templates.totalCount >= 1);
    assert.strictEqual(templateResult.data.capability.key, 'template.inspect');
    assert.ok(templateResult.message.includes('GitHub template inspect'));

    const webhookResult = await aiService.handleCommand('/github webhook list --slug owner/repo --limit 5 --api false');
    assert.ok(webhookResult);
    assert.strictEqual(webhookResult.type, 'info');
    assert.strictEqual(webhookResult.data.schemaVersion, 'github.webhook-list.v1');
    assert.strictEqual(webhookResult.data.metadataOnly, true);
    assert.strictEqual(webhookResult.data.githubApi.attempted, false);
    assert.strictEqual(webhookResult.data.capability.key, 'webhook.list');
    assert.ok(webhookResult.message.includes('GitHub webhook list'));

    const appStatusResult = await aiService.handleCommand('/github app status --slug owner/repo --probe false --api false');
    assert.ok(appStatusResult);
    assert.strictEqual(appStatusResult.type, 'info');
    assert.strictEqual(appStatusResult.data.schemaVersion, 'github.app-status.v1');
    assert.strictEqual(appStatusResult.data.summary.tokenPresent, false);
    assert.strictEqual(appStatusResult.data.githubApi.attempted, false);
    assert.strictEqual(appStatusResult.data.capability.key, 'app.status');
    assert.ok(appStatusResult.message.includes('GitHub app status'));

    const appPermissionsResult = await aiService.handleCommand('/github app permissions inspect --slug owner/repo --api false');
    assert.ok(appPermissionsResult);
    assert.strictEqual(appPermissionsResult.type, 'info');
    assert.strictEqual(appPermissionsResult.data.schemaVersion, 'github.app-permissions-inspect.v1');
    assert.strictEqual(appPermissionsResult.data.githubApi.attempted, false);
    assert.strictEqual(appPermissionsResult.data.capability.key, 'app.permissions.inspect');
    assert.ok(appPermissionsResult.message.includes('GitHub app permissions inspect'));
    });

    await test('aiService.handleCommand routes /github issues list through typed adapters', async () => {
    const result = await aiService.handleCommand('/github issues list --api false --state all --limit 5');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.data);
    assert.strictEqual(result.data.schemaVersion, 'github.issues-list.v1');
    assert.strictEqual(result.data.filters.state, 'all');
    assert.strictEqual(result.data.filters.limit, 5);
    assert.strictEqual(result.data.githubApi.attempted, false);
    assert.strictEqual(result.data.capability.key, 'issues.list');
    assert.strictEqual(result.data.policy.allowed, true);
    assert.ok(result.message.includes('GitHub issues list'));
    });

    await test('aiService.handleCommand routes /github pr status through typed branch-associated adapters', async () => {
    const result = await aiService.handleCommand('/github pr status --slug owner/repo --branch feature/demo --api false');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.data);
    assert.strictEqual(result.data.schemaVersion, 'github.pr-status.v1');
    assert.strictEqual(result.data.githubApi.attempted, false);
    assert.strictEqual(result.data.branchContext.currentBranch, 'feature/demo');
    assert.strictEqual(result.data.branchContext.source, 'explicit-branch');
    assert.strictEqual(result.data.filters.head, 'owner:feature/demo');
    assert.strictEqual(result.data.lookup.status, 'unavailable');
    assert.strictEqual(result.data.capability.key, 'pr.status');
    assert.strictEqual(result.data.policy.allowed, true);
    assert.ok(result.message.includes('GitHub pull request status'));
    });

    await test('aiService.handleCommand routes /github pr feedback through typed adapters', async () => {
    const result = await aiService.handleCommand('/github pr feedback --slug owner/repo --branch feature/demo --limit 6 --api false');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.data);
    assert.strictEqual(result.data.schemaVersion, 'github.pr-feedback.v1');
    assert.strictEqual(result.data.githubApi.attempted, false);
    assert.strictEqual(result.data.branchContext.currentBranch, 'feature/demo');
    assert.strictEqual(result.data.lookup.mode, 'branch-associated');
    assert.strictEqual(result.data.lookup.status, 'unavailable');
    assert.strictEqual(result.data.filters.limit, 6);
    assert.strictEqual(result.data.capability.key, 'pr.feedback');
    assert.strictEqual(result.data.policy.allowed, true);
    assert.ok(result.message.includes('GitHub pull request feedback'));
    assert.ok(result.message.includes('Requested limit: 6'));
    });

    await test('aiService.handleCommand maps /github pr view to the shared pr.status capability', async () => {
    const result = await aiService.handleCommand('/github pr view --slug owner/repo --branch feature/demo --api false');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.data);
    assert.strictEqual(result.data.schemaVersion, 'github.pr-status.v1');
    assert.strictEqual(result.data.capability.key, 'pr.status');
    assert.strictEqual(result.data.branchContext.currentBranch, 'feature/demo');
    assert.ok(result.message.includes('GitHub pull request status'));
    });

    await test('aiService.handleCommand routes /github pr diff through typed adapters', async () => {
    const result = await aiService.handleCommand('/github pr diff 7 --api false --limit 30');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.data);
    assert.strictEqual(result.data.schemaVersion, 'github.pr-diff-summary.v1');
    assert.strictEqual(result.data.pullRequestNumber, 7);
    assert.strictEqual(result.data.filters.limit, 30);
    assert.strictEqual(result.data.githubApi.attempted, false);
    assert.strictEqual(result.data.capability.key, 'pr.diff');
    assert.strictEqual(result.data.policy.allowed, true);
    assert.ok(result.message.includes('GitHub pull request diff summary'));
    });

    await test('aiService.handleCommand routes /github releases inspect through typed adapters', async () => {
    const result = await aiService.handleCommand('/github releases inspect latest --api false');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.data);
    assert.strictEqual(result.data.schemaVersion, 'github.release-inspect.v1');
    assert.strictEqual(result.data.selector.kind, 'latest');
    assert.strictEqual(result.data.githubApi.attempted, false);
    assert.strictEqual(result.data.capability.key, 'releases.inspect');
    assert.strictEqual(result.data.policy.allowed, true);
    assert.ok(result.message.includes('GitHub release inspect'));
    });

    await test('aiService.handleCommand keeps github apply CLI-only on the slash surface', async () => {
    const preview = await aiService.handleCommand('/github pr comment draft 322 --slug owner/repo --body "Slash apply should stay disabled."');
    assert.ok(preview?.data?.previewId);

    const result = await aiService.handleCommand(`/github apply ${preview.data.previewId} --approve --approval-file "${preview.data.approvalArtifact.filePath}"`);
    assert.ok(result);
    assert.strictEqual(result.type, 'error');
    assert.ok(result.data);
    assert.strictEqual(result.data.error, 'POLICY_DENIED');
    assert.strictEqual(result.data.capability.key, 'github.apply');
    assert.strictEqual(result.data.policy.reason, 'source-not-allowed');
    assert.ok(result.message.includes('GitHub capability github.apply is denied by policy (source-not-allowed).'));
    });

    await test('aiService.handleCommand reports usage errors for incomplete /github inspect calls', async () => {
    const result = await aiService.handleCommand('/github pr inspect');
    assert.ok(result);
    assert.strictEqual(result.type, 'error');
    assert.ok(result.message.includes('Usage: liku github pr inspect <number>'));
    assert.ok(result.message.includes('Shared GitHub slash commands:'));
    });

    console.log(`PASS ai-service github slash commands (${pass} assertions)`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error('FAIL ai-service github slash commands');
  console.error(error.stack || error.message);
  process.exit(1);
});
