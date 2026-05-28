#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

async function runNode(args, cwd, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  const repoRoot = path.join(__dirname, '..');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-github-cli-'));
  try {
    const sharedEnv = {
      LIKU_ENABLE_GITHUB: '1',
      LIKU_ENABLE_GITHUB_WRITES: '1',
      LIKU_DISABLE_RUNTIME_TRACE: '1',
      LIKU_CHAT_TRANSCRIPT_QUIET: '1',
      LIKU_HOME_OVERRIDE: path.join(tempRoot, '.liku'),
      LIKU_HOME_OLD_OVERRIDE: path.join(tempRoot, '.liku-cli-old'),
    };

    process.env.LIKU_HOME_OVERRIDE = sharedEnv.LIKU_HOME_OVERRIDE;
    process.env.LIKU_HOME_OLD_OVERRIDE = sharedEnv.LIKU_HOME_OLD_OVERRIDE;

    const { buildGitHubExecutionPlan } = require(path.join(repoRoot, 'src', 'main', 'github', 'plan-builder.js'));
    const {
      appendGitHubPlanEvent,
      writeGitHubPlanArtifact,
      writeGitHubPlanGuidanceArtifact,
    } = require(path.join(repoRoot, 'src', 'main', 'github', 'plan-artifacts.js'));
    const { ingestGitHubWebhookEvent } = require(path.join(repoRoot, 'src', 'main', 'github', 'webhook-event-runtime.js'));

    const help = await runNode(['src/cli/liku.js', '--help'], repoRoot, sharedEnv);
    assert.strictEqual(help.code, 0, 'top-level help exits 0');
    assert(help.stdout.includes('github'), 'top-level help lists the github command');
    assert(help.stdout.includes('liku github releases list --limit 5'), 'top-level help shows release listing example');
    assert(help.stdout.includes('liku github pr status --branch feature/demo --slug owner/repo'), 'top-level help shows pr status example');
    assert(help.stdout.includes('liku github pr feedback --branch feature/demo --slug owner/repo'), 'top-level help shows pr feedback example');
    assert(help.stdout.includes('liku github pr review draft 123 --event approve --body "Looks good overall" --slug owner/repo'), 'top-level help shows pr review draft example');
    assert(help.stdout.includes('liku github pr close draft 123 --slug owner/repo'), 'top-level help shows pr close draft example');
    assert(help.stdout.includes('liku github pr reopen draft 123 --slug owner/repo'), 'top-level help shows pr reopen draft example');
    assert(help.stdout.includes('liku github pr create draft --title "Add overlay diagnostics" --base main --head feature/demo --slug owner/repo'), 'top-level help shows pr create draft example');
      assert(help.stdout.includes('liku github ruleset list --slug owner/repo --limit 10'), 'top-level help shows ruleset list example');
      assert(help.stdout.includes('liku github template inspect --api false'), 'top-level help shows template inspect example');
      assert(help.stdout.includes('liku github app status --slug owner/repo'), 'top-level help shows app status example');
    assert(help.stdout.includes('liku github workflow validate .github/workflows/ci.yml --body-file C:\\Users\\you\\ci.yml --slug owner/repo'), 'top-level help shows workflow validate example');
    assert(help.stdout.includes('liku github codeowners create draft --body-file C:\\Users\\you\\CODEOWNERS --base main --slug owner/repo'), 'top-level help shows codeowners create draft example');
    assert(help.stdout.includes('liku github webhook create draft --events push,pull_request,workflow_run --target-url https://assistant.example.com/github/webhook --secret-ref repo:LIKU_WEBHOOK_SECRET --content-type json --slug owner/repo'), 'top-level help shows webhook create draft example');
    assert(help.stdout.includes('liku github event list --slug owner/repo --limit 10 --event push'), 'top-level help shows event list example');
    assert(help.stdout.includes('liku github plan runs --slug owner/repo --limit 10 --state blocked'), 'top-level help shows plan runs example');
    assert(help.stdout.includes('liku github plan inspect github-run-123 --slug owner/repo'), 'top-level help shows plan inspect example');
    assert(help.stdout.includes('liku github workflow create draft .github/workflows/ci.yml --body-file C:\\Users\\you\\ci.yml --base main --slug owner/repo'), 'top-level help shows workflow create draft example');
    assert(help.stdout.includes('liku github workflow dispatch draft ci.yml --ref main --inputs-json \'{"target":"staging"}\' --slug owner/repo'), 'top-level help shows workflow dispatch draft example');

    const githubHelp = await runNode(['src/cli/liku.js', 'github', 'help'], repoRoot, sharedEnv);
    assert.strictEqual(githubHelp.code, 0, 'github help exits 0');
    assert(githubHelp.stdout.includes('liku github capabilities list'), 'github help lists capability listing');
    assert(githubHelp.stdout.includes('liku github capabilities inspect pr.diff'), 'github help lists capability inspect');
    assert(githubHelp.stdout.includes('liku github context bundle pr 123 --slug owner/repo'), 'github help lists context bundle pr');
    assert(githubHelp.stdout.includes('liku github context bundle repo --limit 5 --out-file'), 'github help lists context bundle repo');
    assert(githubHelp.stdout.includes('liku github plan build pr diff 123 --limit 50'), 'github help lists plan build');
    assert(githubHelp.stdout.includes('liku github plan execute pr diff 123 --limit 50'), 'github help lists plan execute');
    assert(githubHelp.stdout.includes('liku github plan resume --guidance-file'), 'github help lists plan resume');
    assert(githubHelp.stdout.includes('liku github plan runs --slug owner/repo --limit 10 --state blocked'), 'github help lists plan runs');
    assert(githubHelp.stdout.includes('liku github plan inspect github-run-123 --slug owner/repo'), 'github help lists plan inspect');
    assert(githubHelp.stdout.includes('liku github ruleset list --slug owner/repo --limit 10'), 'github help lists ruleset list');
    assert(githubHelp.stdout.includes('liku github environment inspect production --slug owner/repo'), 'github help lists environment inspect');
    assert(githubHelp.stdout.includes('liku github secret list --slug owner/repo --api false --json'), 'github help lists secret list');
    assert(githubHelp.stdout.includes('liku github codeowners inspect --api false'), 'github help lists codeowners inspect');
    assert(githubHelp.stdout.includes('liku github codeowners create draft --body-file C:\\Users\\you\\CODEOWNERS --base main --slug owner/repo'), 'github help lists codeowners create draft');
    assert(githubHelp.stdout.includes('liku github template inspect --api false'), 'github help lists template inspect');
    assert(githubHelp.stdout.includes('liku github webhook inspect 9001 --slug owner/repo'), 'github help lists webhook inspect');
    assert(githubHelp.stdout.includes('liku github webhook create draft --events push,pull_request,workflow_run --target-url https://assistant.example.com/github/webhook --secret-ref repo:LIKU_WEBHOOK_SECRET --content-type json --slug owner/repo'), 'github help lists webhook create draft');
    assert(githubHelp.stdout.includes('liku github webhook ping draft 9001 --slug owner/repo'), 'github help lists webhook ping draft');
    assert(githubHelp.stdout.includes('liku github event list --slug owner/repo --limit 10 --event push'), 'github help lists event list');
    assert(githubHelp.stdout.includes('liku github event inspect github-event-123 --slug owner/repo'), 'github help lists event inspect');
    assert(githubHelp.stdout.includes('liku github app permissions inspect --slug owner/repo'), 'github help lists app permissions inspect');
    assert(githubHelp.stdout.includes('liku github issues comment draft 321 --body "Thanks for the report" --slug owner/repo'), 'github help lists issue comment draft');
    assert(githubHelp.stdout.includes('liku github pr create draft --title "Add overlay diagnostics" --body "Implements the next PR slice" --base main --slug owner/repo'), 'github help lists pr create draft');
    assert(githubHelp.stdout.includes('liku github pr comment draft 123 --body "Looks good overall" --slug owner/repo'), 'github help lists pr comment draft');
    assert(githubHelp.stdout.includes('liku github apply github-write-preview-123 --approve --approval-file'), 'github help lists github apply');
    assert(githubHelp.stdout.includes('liku github issues inspect <number>'), 'github help lists issue inspect');
    assert(githubHelp.stdout.includes('liku github pr list'), 'github help lists pr list');
    assert(githubHelp.stdout.includes('liku github pr status --branch feature/demo --slug owner/repo'), 'github help lists pr status');
    assert(githubHelp.stdout.includes('liku github pr view --branch feature/demo --slug owner/repo'), 'github help lists pr view alias');
    assert(githubHelp.stdout.includes('liku github pr feedback --branch feature/demo --slug owner/repo'), 'github help lists pr feedback');
    assert(githubHelp.stdout.includes('liku github pr review draft 123 --event approve --body "Looks good overall" --slug owner/repo'), 'github help lists pr review draft');
    assert(githubHelp.stdout.includes('liku github pr close draft 123 --slug owner/repo'), 'github help lists pr close draft');
    assert(githubHelp.stdout.includes('liku github pr reopen draft 123 --slug owner/repo'), 'github help lists pr reopen draft');
    assert(githubHelp.stdout.includes('pr feedback    Summarize pull-request conversation comments, reviews, and review comments'), 'github help lists pr feedback command');
    assert(githubHelp.stdout.includes('pr review draft Create a reviewed local preview for one pull-request review submission without mutating GitHub yet'), 'github help lists pr review draft command');
    assert(githubHelp.stdout.includes('pr close draft Create a reviewed local preview for closing one pull request without mutating GitHub yet'), 'github help lists pr close draft command');
    assert(githubHelp.stdout.includes('pr reopen draft Create a reviewed local preview for reopening one pull request without mutating GitHub yet'), 'github help lists pr reopen draft command');
    assert(githubHelp.stdout.includes('pr create draft Create a reviewed local preview for one pull request creation without mutating GitHub yet'), 'github help lists pr create draft command');
    assert(githubHelp.stdout.includes('ruleset list   List repository rulesets and summarize enforcement metadata'), 'github help lists ruleset list command');
    assert(githubHelp.stdout.includes('codeowners create draft Create a reviewed local preview for adding a CODEOWNERS file through a dedicated branch and draft pull request'), 'github help lists codeowners create draft command');
    assert(githubHelp.stdout.includes('template inspect Inspect issue and pull request templates from the current workspace or GitHub contents'), 'github help lists template inspect command');
    assert(githubHelp.stdout.includes('webhook create draft Create a reviewed local preview for creating one repository webhook without mutating GitHub yet'), 'github help lists webhook create draft command');
    assert(githubHelp.stdout.includes('webhook ping draft Create a reviewed local preview for pinging one repository webhook without mutating GitHub yet'), 'github help lists webhook ping draft command');
    assert(githubHelp.stdout.includes('event list     List locally recorded GitHub webhook events from the durable event journal'), 'github help lists event list command');
    assert(githubHelp.stdout.includes('event inspect  Inspect one locally recorded GitHub webhook event from the durable event journal'), 'github help lists event inspect command');
    assert(githubHelp.stdout.includes('plan runs      List locally recorded GitHub plan runs from the durable plan ledger'), 'github help lists plan runs command');
    assert(githubHelp.stdout.includes('plan inspect   Inspect one locally recorded GitHub plan run from the durable plan ledger'), 'github help lists plan inspect command');
    assert(githubHelp.stdout.includes('app status     Summarize GitHub auth posture and App installation visibility for the target repository'), 'github help lists app status command');
    assert(githubHelp.stdout.includes("'event list' and 'event inspect' read the local GitHub event journal under the Liku home directory"), 'github help lists event journal note');
    assert(githubHelp.stdout.includes("'plan runs' and 'plan inspect' read the local GitHub plan ledger under the Liku home directory"), 'github help lists plan ledger note');
    assert(githubHelp.stdout.includes('--title <text> Title text for \'pr create draft\''), 'github help lists pr create title option');
    assert(githubHelp.stdout.includes('--event-log-file <path> Attach an explicit saved GitHub plan event log during plan inspect'), 'github help lists plan inspect event-log option');
    assert(githubHelp.stdout.includes('liku github pr diff <number>'), 'github help lists pr diff');
    assert(githubHelp.stdout.includes('liku github workflow inspect <run-id>'), 'github help lists workflow inspect');
    assert(githubHelp.stdout.includes('liku github workflow validate .github/workflows/ci.yml'), 'github help lists workflow validate');
    assert(githubHelp.stdout.includes('liku github workflow permissions inspect .github/workflows/ci.yml'), 'github help lists workflow permissions inspect');
    assert(githubHelp.stdout.includes('liku github workflow requirements inspect .github/workflows/ci.yml'), 'github help lists workflow requirements inspect');
    assert(githubHelp.stdout.includes('workflow create draft Create a reviewed local preview for adding one workflow file through a dedicated branch and draft pull request'), 'github help lists workflow create draft command');
    assert(githubHelp.stdout.includes('workflow dispatch draft Create a reviewed local preview for dispatching one workflow run without mutating GitHub yet'), 'github help lists workflow dispatch draft command');
    assert(githubHelp.stdout.includes('liku github releases list'), 'github help lists release listing');
    assert(githubHelp.stdout.includes('liku github releases inspect <latest|tag|id>'), 'github help lists release inspect');

    const ingestedEvent = await ingestGitHubWebhookEvent({
      slug: 'owner/repo',
      eventName: 'push',
      deliveryId: 'cli-event-delivery-1',
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

    const eventList = await runNode([
      'src/cli/liku.js',
      'github',
      'event',
      'list',
      '--json',
      '--slug',
      'owner/repo',
      '--limit',
      '5',
      '--event',
      'push',
    ], repoRoot, sharedEnv);
    assert.strictEqual(eventList.code, 0, 'github event list exits 0');
    const eventListPayload = JSON.parse(eventList.stdout);
    assert.strictEqual(eventListPayload.schemaVersion, 'github.event-list.v1');
    assert.strictEqual(eventListPayload.capability.key, 'event.list');
    assert.strictEqual(eventListPayload.policy.allowed, true);
    assert.strictEqual(eventListPayload.localOnly, true);
    assert.strictEqual(eventListPayload.target.slug, 'owner/repo');
    assert.ok(Array.isArray(eventListPayload.events));
    assert.strictEqual(eventListPayload.events[0].eventName, 'push');
    assert.strictEqual(eventListPayload.events[0].slug, 'owner/repo');

    const eventInspect = await runNode([
      'src/cli/liku.js',
      'github',
      'event',
      'inspect',
      ingestedEvent.eventId,
      '--json',
      '--slug',
      'owner/repo',
    ], repoRoot, sharedEnv);
    assert.strictEqual(eventInspect.code, 0, 'github event inspect exits 0');
    const eventInspectPayload = JSON.parse(eventInspect.stdout);
    assert.strictEqual(eventInspectPayload.schemaVersion, 'github.event-inspect.v1');
    assert.strictEqual(eventInspectPayload.capability.key, 'event.inspect');
    assert.strictEqual(eventInspectPayload.policy.allowed, true);
    assert.strictEqual(eventInspectPayload.event.eventId, ingestedEvent.eventId);
    assert.strictEqual(eventInspectPayload.event.eventName, 'push');
    assert.strictEqual(eventInspectPayload.event.headers.authorization, '[redacted]');

    const authStatus = await runNode([
      'src/cli/liku.js',
      'github',
      'auth',
      'status',
      '--json',
      '--probe',
      'false',
    ], repoRoot, sharedEnv);
    assert.strictEqual(authStatus.code, 0, 'github auth status exits 0');
    const authPayload = JSON.parse(authStatus.stdout);
    assert.strictEqual(authPayload.schemaVersion, 'github.auth-status.v1');
    assert.strictEqual(authPayload.featureFlagEnabled, true);
    assert.strictEqual(authPayload.githubApi.probeAttempted, false);
    assert.strictEqual(authPayload.capability.key, 'auth.status');
    assert.strictEqual(authPayload.policy.allowed, true);

    const capabilitiesList = await runNode([
      'src/cli/liku.js',
      'github',
      'capabilities',
      'list',
      '--json',
    ], repoRoot, sharedEnv);
    assert.strictEqual(capabilitiesList.code, 0, 'github capabilities list exits 0');
    const capabilitiesListPayload = JSON.parse(capabilitiesList.stdout);
    assert.strictEqual(capabilitiesListPayload.schemaVersion, 'github.capabilities-list.v1');
    assert.strictEqual(capabilitiesListPayload.capability.key, 'capabilities.list');
    assert.strictEqual(capabilitiesListPayload.policy.allowed, true);
    assert.ok(Array.isArray(capabilitiesListPayload.capabilities));
    assert.ok(capabilitiesListPayload.capabilities.some((entry) => entry.key === 'pr.diff'));

    const capabilityInspect = await runNode([
      'src/cli/liku.js',
      'github',
      'capabilities',
      'inspect',
      'pr.diff',
      '--json',
    ], repoRoot, sharedEnv);
    assert.strictEqual(capabilityInspect.code, 0, 'github capabilities inspect exits 0');
    const capabilityInspectPayload = JSON.parse(capabilityInspect.stdout);
    assert.strictEqual(capabilityInspectPayload.schemaVersion, 'github.capability-inspect.v1');
    assert.strictEqual(capabilityInspectPayload.capability.key, 'capabilities.inspect');
    assert.strictEqual(capabilityInspectPayload.policy.allowed, true);
    assert.strictEqual(capabilityInspectPayload.entry.key, 'pr.diff');
    assert.strictEqual(capabilityInspectPayload.entry.policyBySource.cli.allowed, true);

    const contextBundle = await runNode([
      'src/cli/liku.js',
      'github',
      'context',
      'bundle',
      'pr',
      '7',
      '--json',
      '--api',
      'false',
    ], repoRoot, sharedEnv);
    assert.strictEqual(contextBundle.code, 0, 'github context bundle exits 0');
    const contextBundlePayload = JSON.parse(contextBundle.stdout);
    assert.strictEqual(contextBundlePayload.schemaVersion, 'github.context-bundle.v1');
    assert.strictEqual(contextBundlePayload.capability.key, 'context.bundle');
    assert.strictEqual(contextBundlePayload.policy.allowed, true);
    assert.strictEqual(contextBundlePayload.target.kind, 'pr');
    assert.strictEqual(contextBundlePayload.target.selector, '7');
    assert.strictEqual(contextBundlePayload.review.exportKind, 'github-context-bundle');
    assert.strictEqual(contextBundlePayload.review.reviewRequired, true);
    assert.ok(contextBundlePayload.artifact.filePath);
    assert.ok(fs.existsSync(contextBundlePayload.artifact.filePath));

    const draftBodyFile = path.join(tempRoot, 'issue-comment.md');
    fs.writeFileSync(draftBodyFile, 'Authorization: Bearer ghp_secret_token_12345678901234567890\nPlease retest this on 0.0.16.', 'utf8');
    const issueCommentDraft = await runNode([
      'src/cli/liku.js',
      'github',
      'issues',
      'comment',
      'draft',
      '321',
      '--json',
      '--slug',
      'owner/repo',
      '--body-file',
      draftBodyFile,
    ], repoRoot, sharedEnv);
    assert.strictEqual(issueCommentDraft.code, 0, 'github issues comment draft exits 0');
    const issueCommentDraftPayload = JSON.parse(issueCommentDraft.stdout);
    assert.strictEqual(issueCommentDraftPayload.schemaVersion, 'github.issue-comment-draft.v1');
    assert.strictEqual(issueCommentDraftPayload.capability.key, 'issues.comment.draft');
    assert.strictEqual(issueCommentDraftPayload.policy.allowed, true);
    assert.strictEqual(issueCommentDraftPayload.policy.state, 'preview-allowed');
    assert.strictEqual(issueCommentDraftPayload.issueNumber, 321);
    assert.strictEqual(issueCommentDraftPayload.target.slug, 'owner/repo');
    assert.strictEqual(issueCommentDraftPayload.draft.bodySource, 'file');
    assert.strictEqual(issueCommentDraftPayload.review.exportKind, 'github-write-preview');
    assert.strictEqual(issueCommentDraftPayload.review.reviewRequired, true);
    assert.ok(issueCommentDraftPayload.previewId);
    assert.ok(issueCommentDraftPayload.approval.applyToken);
    assert.ok(issueCommentDraftPayload.previewArtifact.filePath);
    assert.ok(issueCommentDraftPayload.approvalArtifact.filePath);
    assert.ok(fs.existsSync(issueCommentDraftPayload.previewArtifact.filePath));
    assert.ok(fs.existsSync(issueCommentDraftPayload.approvalArtifact.filePath));
    assert.ok(issueCommentDraftPayload.instructions.cliApply.includes(`liku github apply ${issueCommentDraftPayload.previewId}`));
    const issueCommentDraftArtifact = JSON.parse(fs.readFileSync(issueCommentDraftPayload.previewArtifact.filePath, 'utf8'));
    assert.strictEqual(issueCommentDraftArtifact.review.exportKind, 'github-write-preview');
    assert.ok(issueCommentDraftArtifact.input.body.includes('[redacted token]'));
    assert.ok(!issueCommentDraftArtifact.input.body.includes('ghp_secret_token_12345678901234567890'));

    const prCommentDraft = await runNode([
      'src/cli/liku.js',
      'github',
      'pr',
      'comment',
      'draft',
      '123',
      '--json',
      '--slug',
      'owner/repo',
      '--body',
      'Authorization: Bearer ghp_secret_token_12345678901234567890 Looks good overall.',
    ], repoRoot, sharedEnv);
    assert.strictEqual(prCommentDraft.code, 0, 'github pr comment draft exits 0');
    const prCommentDraftPayload = JSON.parse(prCommentDraft.stdout);
    assert.strictEqual(prCommentDraftPayload.schemaVersion, 'github.pr-comment-draft.v1');
    assert.strictEqual(prCommentDraftPayload.capability.key, 'pr.comment.draft');
    assert.strictEqual(prCommentDraftPayload.policy.allowed, true);
    assert.strictEqual(prCommentDraftPayload.policy.state, 'preview-allowed');
    assert.strictEqual(prCommentDraftPayload.pullRequestNumber, 123);
    assert.strictEqual(prCommentDraftPayload.target.slug, 'owner/repo');
    assert.strictEqual(prCommentDraftPayload.draft.bodySource, 'inline');
    assert.strictEqual(prCommentDraftPayload.review.exportKind, 'github-write-preview');
    assert.strictEqual(prCommentDraftPayload.review.reviewRequired, true);
    assert.ok(prCommentDraftPayload.previewId);
    assert.ok(prCommentDraftPayload.approval.applyToken);
    assert.ok(prCommentDraftPayload.previewArtifact.filePath);
    assert.ok(prCommentDraftPayload.approvalArtifact.filePath);
    assert.ok(fs.existsSync(prCommentDraftPayload.previewArtifact.filePath));
    assert.ok(fs.existsSync(prCommentDraftPayload.approvalArtifact.filePath));
    assert.ok(prCommentDraftPayload.instructions.cliApply.includes(`liku github apply ${prCommentDraftPayload.previewId}`));
    const prCommentDraftArtifact = JSON.parse(fs.readFileSync(prCommentDraftPayload.previewArtifact.filePath, 'utf8'));
    assert.strictEqual(prCommentDraftArtifact.review.exportKind, 'github-write-preview');
    assert.strictEqual(prCommentDraftArtifact.target.pullRequestNumber, 123);
    assert.ok(prCommentDraftArtifact.input.body.includes('[redacted token]'));
    assert.ok(!prCommentDraftArtifact.input.body.includes('ghp_secret_token_12345678901234567890'));

    const prCreateDraft = await runNode([
      'src/cli/liku.js',
      'github',
      'pr',
      'create',
      'draft',
      '--json',
      '--slug',
      'owner/repo',
      '--api',
      'false',
      '--title',
      'Authorization: Bearer ghp_secret_token_12345678901234567890 Add overlay diagnostics',
      '--body',
      'Authorization: Bearer ghp_secret_token_12345678901234567890 Implements the next PR slice.',
      '--base',
      'main',
      '--head',
      'feature/demo',
      '--draft',
      'true',
    ], repoRoot, sharedEnv);
    assert.strictEqual(prCreateDraft.code, 0, 'github pr create draft exits 0');
    const prCreateDraftPayload = JSON.parse(prCreateDraft.stdout);
    assert.strictEqual(prCreateDraftPayload.schemaVersion, 'github.pr-create-draft.v1');
    assert.strictEqual(prCreateDraftPayload.capability.key, 'pr.create.draft');
    assert.strictEqual(prCreateDraftPayload.policy.allowed, true);
    assert.strictEqual(prCreateDraftPayload.policy.state, 'preview-allowed');
    assert.strictEqual(prCreateDraftPayload.target.slug, 'owner/repo');
    assert.strictEqual(prCreateDraftPayload.draft.baseBranch, 'main');
    assert.strictEqual(prCreateDraftPayload.draft.head, 'feature/demo');
    assert.strictEqual(prCreateDraftPayload.draft.headBranch, 'feature/demo');
    assert.strictEqual(prCreateDraftPayload.draft.draft, true);
    assert.strictEqual(prCreateDraftPayload.draft.bodySource, 'inline');
    assert.strictEqual(prCreateDraftPayload.review.exportKind, 'github-write-preview');
    assert.strictEqual(prCreateDraftPayload.review.reviewRequired, true);
    assert.ok(prCreateDraftPayload.previewId);
    assert.ok(prCreateDraftPayload.approval.applyToken);
    assert.ok(prCreateDraftPayload.previewArtifact.filePath);
    assert.ok(prCreateDraftPayload.approvalArtifact.filePath);
    assert.ok(fs.existsSync(prCreateDraftPayload.previewArtifact.filePath));
    assert.ok(fs.existsSync(prCreateDraftPayload.approvalArtifact.filePath));
    assert.ok(prCreateDraftPayload.instructions.cliApply.includes(`liku github apply ${prCreateDraftPayload.previewId}`));
    const prCreateDraftArtifact = JSON.parse(fs.readFileSync(prCreateDraftPayload.previewArtifact.filePath, 'utf8'));
    assert.strictEqual(prCreateDraftArtifact.review.exportKind, 'github-write-preview');
    assert.strictEqual(prCreateDraftArtifact.target.baseBranch, 'main');
    assert.strictEqual(prCreateDraftArtifact.target.head, 'feature/demo');
    assert.strictEqual(prCreateDraftArtifact.target.draft, true);
    assert.ok(prCreateDraftArtifact.input.title.includes('[redacted token]'));
    assert.ok(prCreateDraftArtifact.input.body.includes('[redacted token]'));
    assert.ok(!prCreateDraftArtifact.input.title.includes('ghp_secret_token_12345678901234567890'));
    assert.ok(!prCreateDraftArtifact.input.body.includes('ghp_secret_token_12345678901234567890'));

    const applyUsage = await runNode([
      'src/cli/liku.js',
      'github',
      'apply',
      '--json',
    ], repoRoot, sharedEnv);
    assert.strictEqual(applyUsage.code, 1, 'github apply usage exits 1');
    const applyUsagePayload = JSON.parse(applyUsage.stdout);
    assert.strictEqual(applyUsagePayload.error, 'USAGE');
    assert.ok(applyUsagePayload.message.includes('Usage: liku github apply <preview-id> --approve'));

    const applyPolicyDenied = await runNode([
      'src/cli/liku.js',
      'github',
      'apply',
      issueCommentDraftPayload.previewId,
      '--json',
      '--approve',
      '--approval-file',
      issueCommentDraftPayload.approvalArtifact.filePath,
    ], repoRoot, {
      ...sharedEnv,
      LIKU_ENABLE_GITHUB_WRITES: '0',
    });
    assert.strictEqual(applyPolicyDenied.code, 1, 'github apply denied exits 1');
    const applyPolicyDeniedPayload = JSON.parse(applyPolicyDenied.stdout);
    assert.strictEqual(applyPolicyDeniedPayload.error, 'POLICY_DENIED');
    assert.strictEqual(applyPolicyDeniedPayload.capability.key, 'github.apply');
    assert.strictEqual(applyPolicyDeniedPayload.policy.reason, 'github-write-capability-disabled');

    const planBuild = await runNode([
      'src/cli/liku.js',
      'github',
      'plan',
      'build',
      'pr',
      'diff',
      '7',
      '--json',
      '--limit',
      '30',
      '--api',
      'false',
    ], repoRoot, sharedEnv);
    assert.strictEqual(planBuild.code, 0, 'github plan build exits 0');
    const planBuildPayload = JSON.parse(planBuild.stdout);
    assert.strictEqual(planBuildPayload.schemaVersion, 'github.plan-build.v1');
    assert.strictEqual(planBuildPayload.capability.key, 'plan.build');
    assert.strictEqual(planBuildPayload.policy.allowed, true);
    assert.strictEqual(planBuildPayload.targetCapability.key, 'pr.diff');
    assert.strictEqual(planBuildPayload.plan.schemaVersion, 'github.execution-plan.v1');
    assert.strictEqual(planBuildPayload.plan.steps[0].capabilityKey, 'pr.diff');
    assert.strictEqual(planBuildPayload.plan.steps[0].runtimeInput.number, '7');
    assert.strictEqual(planBuildPayload.plan.steps[0].runtimeInput.api, false);

    const planExecute = await runNode([
      'src/cli/liku.js',
      'github',
      'plan',
      'execute',
      'pr',
      'diff',
      '7',
      '--json',
      '--limit',
      '30',
      '--api',
      'false',
    ], repoRoot, sharedEnv);
    assert.strictEqual(planExecute.code, 0, 'github plan execute exits 0');
    const planExecutePayload = JSON.parse(planExecute.stdout);
    assert.strictEqual(planExecutePayload.schemaVersion, 'github.plan-execute.v1');
    assert.strictEqual(planExecutePayload.capability.key, 'plan.execute');
    assert.strictEqual(planExecutePayload.policy.allowed, true);
    assert.strictEqual(planExecutePayload.success, true);
    assert.strictEqual(planExecutePayload.targetCapability.key, 'pr.diff');
    assert.strictEqual(planExecutePayload.execution.stepsExecuted, 1);
    assert.strictEqual(planExecutePayload.execution.timedOut, false);
    assert.strictEqual(planExecutePayload.execution.terminalEvent, 'execution.completed');
    assert.ok(planExecutePayload.run.runId);
    assert.ok(planExecutePayload.eventLog.filePath);
    assert.ok(planExecutePayload.planArtifact.filePath);
    assert.ok(planExecutePayload.resultArtifact.filePath);
    assert.ok(fs.existsSync(planExecutePayload.eventLog.filePath));
    assert.ok(fs.existsSync(planExecutePayload.planArtifact.filePath));
    assert.ok(fs.existsSync(planExecutePayload.resultArtifact.filePath));

    const planReplay = await runNode([
      'src/cli/liku.js',
      'github',
      'plan',
      'execute',
      '--json',
      '--plan-file',
      planExecutePayload.planArtifact.filePath,
    ], repoRoot, sharedEnv);
    assert.strictEqual(planReplay.code, 0, 'github plan execute replay exits 0');
    const planReplayPayload = JSON.parse(planReplay.stdout);
    assert.strictEqual(planReplayPayload.schemaVersion, 'github.plan-execute.v1');
    assert.strictEqual(planReplayPayload.success, true);
    assert.strictEqual(planReplayPayload.execution.planSource, 'artifact-replay');
    assert.strictEqual(planReplayPayload.capability.key, 'plan.execute');
    assert.ok(planReplayPayload.run.runId);
    assert.ok(planReplayPayload.eventLog.filePath);
    assert.ok(fs.existsSync(planReplayPayload.eventLog.filePath));

    const resumePlanReport = buildGitHubExecutionPlan({
      source: 'cli',
      positionals: ['plan', 'build', 'issues', 'list'],
      runtimeOptions: { limit: 5, api: false },
    });
    const resumeRunId = 'github-run-cli-resume';
    const resumeToken = 'resume-token-cli';
    const resumePlanArtifact = writeGitHubPlanArtifact({
      source: 'cli',
      metadata: { mode: 'bounded-executor', orchestrationMode: 'bounded-evented', runId: resumeRunId },
      planReport: resumePlanReport,
    });
    appendGitHubPlanEvent({ artifactId: resumePlanArtifact.artifactId, runId: resumeRunId, sequence: 1, eventName: 'execution.started', source: 'cli', status: 'running' });
    appendGitHubPlanEvent({ artifactId: resumePlanArtifact.artifactId, runId: resumeRunId, sequence: 2, eventName: 'step.started', source: 'cli', status: 'running', step: { stepId: 'step-1', capabilityKey: 'issues.list' } });
    appendGitHubPlanEvent({ artifactId: resumePlanArtifact.artifactId, runId: resumeRunId, sequence: 3, eventName: 'guidance.requested', source: 'cli', status: 'blocked', step: { stepId: 'step-1', capabilityKey: 'issues.list' }, guidance: { guidanceId: 'github-guidance-cli', resumeToken } });
    const resumeGuidanceArtifact = writeGitHubPlanGuidanceArtifact({
      artifactId: resumePlanArtifact.artifactId,
      runId: resumeRunId,
      guidanceId: 'github-guidance-cli',
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
    const resumeAnswersPath = path.join(tempRoot, 'resume-answers.json');
    fs.writeFileSync(resumeAnswersPath, JSON.stringify({ state: 'all' }, null, 2));

    const planResume = await runNode([
      'src/cli/liku.js',
      'github',
      'plan',
      'resume',
      '--json',
      '--guidance-file',
      resumeGuidanceArtifact.filePath,
      '--resume-token',
      resumeToken,
      '--answers-file',
      resumeAnswersPath,
    ], repoRoot, sharedEnv);
    assert.strictEqual(planResume.code, 0, 'github plan resume exits 0');
    const planResumePayload = JSON.parse(planResume.stdout);
    assert.strictEqual(planResumePayload.schemaVersion, 'github.plan-resume.v1');
    assert.strictEqual(planResumePayload.capability.key, 'plan.resume');
    assert.strictEqual(planResumePayload.policy.allowed, true);
    assert.strictEqual(planResumePayload.success, true);
    assert.strictEqual(planResumePayload.run.runId, resumeRunId);
    assert.strictEqual(planResumePayload.execution.status, 'completed');
    assert.strictEqual(planResumePayload.stepResults[0].result.filters.state, 'all');
    assert.ok(planResumePayload.resultArtifact.filePath);
    assert.ok(fs.existsSync(planResumePayload.resultArtifact.filePath));
    assert.ok(planResumePayload.eventLog.filePath);
    assert.ok(fs.existsSync(planResumePayload.eventLog.filePath));

    const blockedPlanReport = buildGitHubExecutionPlan({
      source: 'cli',
      positionals: ['plan', 'build', 'issues', 'list'],
      runtimeOptions: { slug: 'owner/repo', limit: 5, api: false },
    });
    const blockedRunId = 'github-run-cli-blocked';
    const blockedResumeToken = 'resume-token-cli-blocked';
    const blockedPlanArtifact = writeGitHubPlanArtifact({
      source: 'cli',
      metadata: { mode: 'bounded-executor', orchestrationMode: 'bounded-evented', runId: blockedRunId },
      planReport: blockedPlanReport,
    });
    appendGitHubPlanEvent({ artifactId: blockedPlanArtifact.artifactId, runId: blockedRunId, sequence: 1, eventName: 'execution.started', source: 'cli', status: 'running' });
    appendGitHubPlanEvent({ artifactId: blockedPlanArtifact.artifactId, runId: blockedRunId, sequence: 2, eventName: 'step.started', source: 'cli', status: 'running', step: { stepId: 'step-1', capabilityKey: 'issues.list' } });
    appendGitHubPlanEvent({ artifactId: blockedPlanArtifact.artifactId, runId: blockedRunId, sequence: 3, eventName: 'guidance.requested', source: 'cli', status: 'blocked', step: { stepId: 'step-1', capabilityKey: 'issues.list' }, guidance: { guidanceId: 'github-guidance-cli-blocked', resumeToken: blockedResumeToken } });
    writeGitHubPlanGuidanceArtifact({
      artifactId: blockedPlanArtifact.artifactId,
      runId: blockedRunId,
      guidanceId: 'github-guidance-cli-blocked',
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

    const planRuns = await runNode([
      'src/cli/liku.js',
      'github',
      'plan',
      'runs',
      '--json',
      '--slug',
      'owner/repo',
      '--limit',
      '10',
      '--state',
      'blocked',
    ], repoRoot, sharedEnv);
    assert.strictEqual(planRuns.code, 0, 'github plan runs exits 0');
    const planRunsPayload = JSON.parse(planRuns.stdout);
    assert.strictEqual(planRunsPayload.schemaVersion, 'github.plan-runs.v1');
    assert.strictEqual(planRunsPayload.capability.key, 'plan.runs');
    assert.strictEqual(planRunsPayload.policy.allowed, true);
    assert.strictEqual(planRunsPayload.localOnly, true);
    assert.strictEqual(planRunsPayload.target.slug, 'owner/repo');
    assert.strictEqual(planRunsPayload.filters.state, 'blocked');
    assert.strictEqual(planRunsPayload.totalCount, 1);
    assert.strictEqual(planRunsPayload.runs[0].runId, blockedRunId);
    assert.strictEqual(planRunsPayload.runs[0].state, 'blocked');

    const planInspect = await runNode([
      'src/cli/liku.js',
      'github',
      'plan',
      'inspect',
      blockedRunId,
      '--json',
      '--slug',
      'owner/repo',
    ], repoRoot, sharedEnv);
    assert.strictEqual(planInspect.code, 0, 'github plan inspect exits 0');
    const planInspectPayload = JSON.parse(planInspect.stdout);
    assert.strictEqual(planInspectPayload.schemaVersion, 'github.plan-inspect.v1');
    assert.strictEqual(planInspectPayload.capability.key, 'plan.inspect');
    assert.strictEqual(planInspectPayload.policy.allowed, true);
    assert.strictEqual(planInspectPayload.run.runId, blockedRunId);
    assert.strictEqual(planInspectPayload.run.state, 'blocked');
    assert.strictEqual(planInspectPayload.guidance.resumeToken, blockedResumeToken);
    assert.strictEqual(planInspectPayload.execution.status, 'needs-guidance');
    assert.strictEqual(planInspectPayload.eventLog.eventCount, 3);
    assert.ok(planInspectPayload.planArtifact.filePath);
    assert.ok(fs.existsSync(planInspectPayload.planArtifact.filePath));

    const repoInspect = await runNode([
      'src/cli/liku.js',
      'github',
      'repo',
      'inspect',
      '--json',
      '--api',
      'false',
    ], repoRoot, sharedEnv);
    assert.strictEqual(repoInspect.code, 0, 'github repo inspect exits 0');
    const repoPayload = JSON.parse(repoInspect.stdout);
    assert.strictEqual(repoPayload.schemaVersion, 'github.repo-inspect.v1');
    assert.strictEqual(repoPayload.success, true);
    assert.strictEqual(repoPayload.featureFlagEnabled, true);
    assert.strictEqual(repoPayload.githubApi.attempted, false);
    assert.strictEqual(repoPayload.repoIdentity.normalizedRepoName, 'copilot-liku-cli');
    assert.strictEqual(repoPayload.remote.isGitHub, true);

    const rulesetList = await runNode([
      'src/cli/liku.js',
      'github',
      'ruleset',
      'list',
      '--json',
      '--api',
      'false',
      '--slug',
      'owner/repo',
      '--limit',
      '5',
    ], repoRoot, sharedEnv);
    assert.strictEqual(rulesetList.code, 0, 'github ruleset list exits 0');
    const rulesetListPayload = JSON.parse(rulesetList.stdout);
    assert.strictEqual(rulesetListPayload.schemaVersion, 'github.ruleset-list.v1');
    assert.strictEqual(rulesetListPayload.githubApi.attempted, false);
    assert.strictEqual(rulesetListPayload.filters.limit, 5);
    assert.strictEqual(rulesetListPayload.capability.key, 'ruleset.list');

    const environmentInspect = await runNode([
      'src/cli/liku.js',
      'github',
      'environment',
      'inspect',
      'production',
      '--json',
      '--api',
      'false',
      '--slug',
      'owner/repo',
    ], repoRoot, sharedEnv);
    assert.strictEqual(environmentInspect.code, 0, 'github environment inspect exits 0');
    const environmentInspectPayload = JSON.parse(environmentInspect.stdout);
    assert.strictEqual(environmentInspectPayload.schemaVersion, 'github.environment-inspect.v1');
    assert.strictEqual(environmentInspectPayload.environmentName, 'production');
    assert.strictEqual(environmentInspectPayload.githubApi.attempted, false);
    assert.strictEqual(environmentInspectPayload.capability.key, 'environment.inspect');

    const secretList = await runNode([
      'src/cli/liku.js',
      'github',
      'secret',
      'list',
      '--json',
      '--api',
      'false',
      '--slug',
      'owner/repo',
      '--limit',
      '5',
    ], repoRoot, sharedEnv);
    assert.strictEqual(secretList.code, 0, 'github secret list exits 0');
    const secretListPayload = JSON.parse(secretList.stdout);
    assert.strictEqual(secretListPayload.schemaVersion, 'github.secret-list.v1');
    assert.strictEqual(secretListPayload.metadataOnly, true);
    assert.strictEqual(secretListPayload.githubApi.attempted, false);
    assert.strictEqual(secretListPayload.capability.key, 'secret.list');

    const variableInspect = await runNode([
      'src/cli/liku.js',
      'github',
      'variable',
      'inspect',
      'FEATURE_FLAG',
      '--json',
      '--api',
      'false',
      '--slug',
      'owner/repo',
    ], repoRoot, sharedEnv);
    assert.strictEqual(variableInspect.code, 0, 'github variable inspect exits 0');
    const variableInspectPayload = JSON.parse(variableInspect.stdout);
    assert.strictEqual(variableInspectPayload.schemaVersion, 'github.variable-inspect.v1');
    assert.strictEqual(variableInspectPayload.variableName, 'FEATURE_FLAG');
    assert.strictEqual(variableInspectPayload.metadataOnly, true);
    assert.strictEqual(variableInspectPayload.githubApi.attempted, false);
    assert.strictEqual(variableInspectPayload.capability.key, 'variable.inspect');

    const codeownersInspect = await runNode([
      'src/cli/liku.js',
      'github',
      'codeowners',
      'inspect',
      '--json',
      '--api',
      'false',
    ], repoRoot, sharedEnv);
    assert.strictEqual(codeownersInspect.code, 0, 'github codeowners inspect exits 0');
    const codeownersInspectPayload = JSON.parse(codeownersInspect.stdout);
    assert.strictEqual(codeownersInspectPayload.schemaVersion, 'github.codeowners-inspect.v1');
    assert.strictEqual(codeownersInspectPayload.codeowners, null);
    assert.strictEqual(codeownersInspectPayload.capability.key, 'codeowners.inspect');

    const templateInspect = await runNode([
      'src/cli/liku.js',
      'github',
      'template',
      'inspect',
      '--json',
      '--api',
      'false',
    ], repoRoot, sharedEnv);
    assert.strictEqual(templateInspect.code, 0, 'github template inspect exits 0');
    const templateInspectPayload = JSON.parse(templateInspect.stdout);
    assert.strictEqual(templateInspectPayload.schemaVersion, 'github.template-inspect.v1');
    assert.strictEqual(templateInspectPayload.templates.source, 'local-workspace');
    assert.ok(templateInspectPayload.templates.totalCount >= 1);
    assert.strictEqual(templateInspectPayload.capability.key, 'template.inspect');

    const webhookList = await runNode([
      'src/cli/liku.js',
      'github',
      'webhook',
      'list',
      '--json',
      '--api',
      'false',
      '--slug',
      'owner/repo',
      '--limit',
      '5',
    ], repoRoot, sharedEnv);
    assert.strictEqual(webhookList.code, 0, 'github webhook list exits 0');
    const webhookListPayload = JSON.parse(webhookList.stdout);
    assert.strictEqual(webhookListPayload.schemaVersion, 'github.webhook-list.v1');
    assert.strictEqual(webhookListPayload.metadataOnly, true);
    assert.strictEqual(webhookListPayload.githubApi.attempted, false);
    assert.strictEqual(webhookListPayload.capability.key, 'webhook.list');

    const appStatus = await runNode([
      'src/cli/liku.js',
      'github',
      'app',
      'status',
      '--json',
      '--probe',
      'false',
      '--api',
      'false',
      '--slug',
      'owner/repo',
    ], repoRoot, sharedEnv);
    assert.strictEqual(appStatus.code, 0, 'github app status exits 0');
    const appStatusPayload = JSON.parse(appStatus.stdout);
    assert.strictEqual(appStatusPayload.schemaVersion, 'github.app-status.v1');
    assert.strictEqual(appStatusPayload.summary.tokenPresent, false);
    assert.strictEqual(appStatusPayload.githubApi.attempted, false);
    assert.strictEqual(appStatusPayload.capability.key, 'app.status');

    const appPermissionsInspect = await runNode([
      'src/cli/liku.js',
      'github',
      'app',
      'permissions',
      'inspect',
      '--json',
      '--api',
      'false',
      '--slug',
      'owner/repo',
    ], repoRoot, sharedEnv);
    assert.strictEqual(appPermissionsInspect.code, 0, 'github app permissions inspect exits 0');
    const appPermissionsPayload = JSON.parse(appPermissionsInspect.stdout);
    assert.strictEqual(appPermissionsPayload.schemaVersion, 'github.app-permissions-inspect.v1');
    assert.strictEqual(appPermissionsPayload.githubApi.attempted, false);
    assert.strictEqual(appPermissionsPayload.capability.key, 'app.permissions.inspect');

    const issuesList = await runNode([
      'src/cli/liku.js',
      'github',
      'issues',
      'list',
      '--json',
      '--api',
      'false',
      '--state',
      'all',
      '--limit',
      '5',
    ], repoRoot, sharedEnv);
    assert.strictEqual(issuesList.code, 0, 'github issues list exits 0');
    const issuesPayload = JSON.parse(issuesList.stdout);
    assert.strictEqual(issuesPayload.schemaVersion, 'github.issues-list.v1');
    assert.strictEqual(issuesPayload.githubApi.attempted, false);
    assert.strictEqual(issuesPayload.filters.state, 'all');
    assert.strictEqual(issuesPayload.filters.limit, 5);
    assert.strictEqual(issuesPayload.capability.key, 'issues.list');
    assert.strictEqual(issuesPayload.policy.allowed, true);

    const issueInspect = await runNode([
      'src/cli/liku.js',
      'github',
      'issues',
      'inspect',
      '7',
      '--json',
      '--api',
      'false',
    ], repoRoot, sharedEnv);
    assert.strictEqual(issueInspect.code, 0, 'github issues inspect exits 0');
    const issuePayload = JSON.parse(issueInspect.stdout);
    assert.strictEqual(issuePayload.schemaVersion, 'github.issue-inspect.v1');
    assert.strictEqual(issuePayload.issueNumber, 7);
    assert.strictEqual(issuePayload.githubApi.attempted, false);

    const prList = await runNode([
      'src/cli/liku.js',
      'github',
      'pr',
      'list',
      '--json',
      '--api',
      'false',
      '--state',
      'all',
      '--limit',
      '4',
    ], repoRoot, sharedEnv);
    assert.strictEqual(prList.code, 0, 'github pr list exits 0');
    const prListPayload = JSON.parse(prList.stdout);
    assert.strictEqual(prListPayload.schemaVersion, 'github.pr-list.v1');
    assert.strictEqual(prListPayload.githubApi.attempted, false);
    assert.strictEqual(prListPayload.filters.state, 'all');
    assert.strictEqual(prListPayload.filters.limit, 4);

    const prStatus = await runNode([
      'src/cli/liku.js',
      'github',
      'pr',
      'status',
      '--json',
      '--api',
      'false',
      '--slug',
      'owner/repo',
      '--branch',
      'feature/demo',
    ], repoRoot, sharedEnv);
    assert.strictEqual(prStatus.code, 0, 'github pr status exits 0');
    const prStatusPayload = JSON.parse(prStatus.stdout);
    assert.strictEqual(prStatusPayload.schemaVersion, 'github.pr-status.v1');
    assert.strictEqual(prStatusPayload.githubApi.attempted, false);
    assert.strictEqual(prStatusPayload.branchContext.currentBranch, 'feature/demo');
    assert.strictEqual(prStatusPayload.branchContext.source, 'explicit-branch');
    assert.strictEqual(prStatusPayload.filters.head, 'owner:feature/demo');
    assert.strictEqual(prStatusPayload.lookup.status, 'unavailable');
    assert.strictEqual(prStatusPayload.capability.key, 'pr.status');
    assert.strictEqual(prStatusPayload.policy.allowed, true);

    const prView = await runNode([
      'src/cli/liku.js',
      'github',
      'pr',
      'view',
      '--json',
      '--api',
      'false',
      '--slug',
      'owner/repo',
      '--branch',
      'feature/demo',
    ], repoRoot, sharedEnv);
    assert.strictEqual(prView.code, 0, 'github pr view exits 0');
    const prViewPayload = JSON.parse(prView.stdout);
    assert.strictEqual(prViewPayload.schemaVersion, 'github.pr-status.v1');
    assert.strictEqual(prViewPayload.capability.key, 'pr.status');
    assert.strictEqual(prViewPayload.branchContext.currentBranch, 'feature/demo');

    const prFeedback = await runNode([
      'src/cli/liku.js',
      'github',
      'pr',
      'feedback',
      '--json',
      '--api',
      'false',
      '--slug',
      'owner/repo',
      '--branch',
      'feature/demo',
      '--limit',
      '6',
    ], repoRoot, sharedEnv);
    assert.strictEqual(prFeedback.code, 0, 'github pr feedback exits 0');
    const prFeedbackPayload = JSON.parse(prFeedback.stdout);
    assert.strictEqual(prFeedbackPayload.schemaVersion, 'github.pr-feedback.v1');
    assert.strictEqual(prFeedbackPayload.githubApi.attempted, false);
    assert.strictEqual(prFeedbackPayload.branchContext.currentBranch, 'feature/demo');
    assert.strictEqual(prFeedbackPayload.lookup.mode, 'branch-associated');
    assert.strictEqual(prFeedbackPayload.lookup.status, 'unavailable');
    assert.strictEqual(prFeedbackPayload.filters.limit, 6);
    assert.strictEqual(prFeedbackPayload.capability.key, 'pr.feedback');
    assert.strictEqual(prFeedbackPayload.policy.allowed, true);

    const prReviewDraft = await runNode([
      'src/cli/liku.js',
      'github',
      'pr',
      'review',
      'draft',
      '123',
      '--json',
      '--slug',
      'owner/repo',
      '--event',
      'approve',
      '--body',
      'Looks good overall.',
    ], repoRoot, sharedEnv);
    assert.strictEqual(prReviewDraft.code, 0, 'github pr review draft exits 0');
    const prReviewDraftPayload = JSON.parse(prReviewDraft.stdout);
    assert.strictEqual(prReviewDraftPayload.schemaVersion, 'github.pr-review-draft.v1');
    assert.strictEqual(prReviewDraftPayload.pullRequestNumber, 123);
    assert.strictEqual(prReviewDraftPayload.draft.reviewEvent, 'approve');
    assert.strictEqual(prReviewDraftPayload.draft.reviewEventApi, 'APPROVE');
    assert.strictEqual(prReviewDraftPayload.capability.key, 'pr.review.draft');
    assert.strictEqual(prReviewDraftPayload.policy.allowed, true);
    assert.strictEqual(prReviewDraftPayload.policy.state, 'preview-allowed');

    const prCloseDraft = await runNode([
      'src/cli/liku.js',
      'github',
      'pr',
      'close',
      'draft',
      '123',
      '--json',
      '--slug',
      'owner/repo',
    ], repoRoot, sharedEnv);
    assert.strictEqual(prCloseDraft.code, 0, 'github pr close draft exits 0');
    const prCloseDraftPayload = JSON.parse(prCloseDraft.stdout);
    assert.strictEqual(prCloseDraftPayload.schemaVersion, 'github.pr-close-draft.v1');
    assert.strictEqual(prCloseDraftPayload.pullRequestNumber, 123);
    assert.strictEqual(prCloseDraftPayload.draft.stateAction, 'close');
    assert.strictEqual(prCloseDraftPayload.draft.desiredState, 'closed');
    assert.strictEqual(prCloseDraftPayload.capability.key, 'pr.close.draft');
    assert.strictEqual(prCloseDraftPayload.policy.allowed, true);
    assert.strictEqual(prCloseDraftPayload.policy.state, 'preview-allowed');

    const prReopenDraft = await runNode([
      'src/cli/liku.js',
      'github',
      'pr',
      'reopen',
      'draft',
      '123',
      '--json',
      '--slug',
      'owner/repo',
    ], repoRoot, sharedEnv);
    assert.strictEqual(prReopenDraft.code, 0, 'github pr reopen draft exits 0');
    const prReopenDraftPayload = JSON.parse(prReopenDraft.stdout);
    assert.strictEqual(prReopenDraftPayload.schemaVersion, 'github.pr-reopen-draft.v1');
    assert.strictEqual(prReopenDraftPayload.pullRequestNumber, 123);
    assert.strictEqual(prReopenDraftPayload.draft.stateAction, 'reopen');
    assert.strictEqual(prReopenDraftPayload.draft.desiredState, 'open');
    assert.strictEqual(prReopenDraftPayload.capability.key, 'pr.reopen.draft');
    assert.strictEqual(prReopenDraftPayload.policy.allowed, true);
    assert.strictEqual(prReopenDraftPayload.policy.state, 'preview-allowed');

    const prDiff = await runNode([
      'src/cli/liku.js',
      'github',
      'pr',
      'diff',
      '7',
      '--json',
      '--api',
      'false',
      '--limit',
      '30',
    ], repoRoot, sharedEnv);
    assert.strictEqual(prDiff.code, 0, 'github pr diff exits 0');
    const prDiffPayload = JSON.parse(prDiff.stdout);
    assert.strictEqual(prDiffPayload.schemaVersion, 'github.pr-diff-summary.v1');
    assert.strictEqual(prDiffPayload.pullRequestNumber, 7);
    assert.strictEqual(prDiffPayload.githubApi.attempted, false);
    assert.strictEqual(prDiffPayload.filters.limit, 30);
    assert.strictEqual(prDiffPayload.capability.key, 'pr.diff');
    assert.strictEqual(prDiffPayload.policy.allowed, true);

    const prInspect = await runNode([
      'src/cli/liku.js',
      'github',
      'pr',
      'inspect',
      '7',
      '--json',
      '--api',
      'false',
    ], repoRoot, sharedEnv);
    assert.strictEqual(prInspect.code, 0, 'github pr inspect exits 0');
    const prPayload = JSON.parse(prInspect.stdout);
    assert.strictEqual(prPayload.schemaVersion, 'github.pr-inspect.v1');
    assert.strictEqual(prPayload.pullRequestNumber, 7);
    assert.strictEqual(prPayload.githubApi.attempted, false);

    const workflowBodyFile = path.join(tempRoot, 'validate.yml');
    fs.writeFileSync(workflowBodyFile, 'name: Validate\non:\n  push:\npermissions: {}\njobs:\n  validate:\n    permissions:\n      contents: read\n    steps:\n      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5\n        with:\n          persist-credentials: false\n', 'utf8');
    const codeownersBodyFile = path.join(tempRoot, 'CODEOWNERS');
    fs.writeFileSync(codeownersBodyFile, '* @octocat\n/docs/ @docs-team\n', 'utf8');

    const workflowValidate = await runNode([
      'src/cli/liku.js',
      'github',
      'workflow',
      'validate',
      '.github/workflows/validate.yml',
      '--json',
      '--slug',
      'owner/repo',
      '--body-file',
      workflowBodyFile,
    ], repoRoot, sharedEnv);
    assert.strictEqual(workflowValidate.code, 0, 'github workflow validate exits 0');
    const workflowValidatePayload = JSON.parse(workflowValidate.stdout);
    assert.strictEqual(workflowValidatePayload.schemaVersion, 'github.workflow-validate.v1');
    assert.strictEqual(workflowValidatePayload.capability.key, 'workflow.validate');
    assert.strictEqual(workflowValidatePayload.workflowPath, '.github/workflows/validate.yml');
    assert.strictEqual(workflowValidatePayload.validation.valid, true);

    const workflowPermissionsInspect = await runNode([
      'src/cli/liku.js',
      'github',
      'workflow',
      'permissions',
      'inspect',
      '.github/workflows/validate.yml',
      '--json',
      '--slug',
      'owner/repo',
      '--body-file',
      workflowBodyFile,
    ], repoRoot, sharedEnv);
    assert.strictEqual(workflowPermissionsInspect.code, 0, 'github workflow permissions inspect exits 0');
    const workflowPermissionsPayload = JSON.parse(workflowPermissionsInspect.stdout);
    assert.strictEqual(workflowPermissionsPayload.schemaVersion, 'github.workflow-permissions-inspect.v1');
    assert.strictEqual(workflowPermissionsPayload.capability.key, 'workflow.permissions.inspect');
    assert.strictEqual(workflowPermissionsPayload.permissions.hasTopLevelPermissions, true);

    const workflowRequirementsInspect = await runNode([
      'src/cli/liku.js',
      'github',
      'workflow',
      'requirements',
      'inspect',
      '.github/workflows/validate.yml',
      '--json',
      '--slug',
      'owner/repo',
      '--body-file',
      workflowBodyFile,
    ], repoRoot, sharedEnv);
    assert.strictEqual(workflowRequirementsInspect.code, 0, 'github workflow requirements inspect exits 0');
    const workflowRequirementsPayload = JSON.parse(workflowRequirementsInspect.stdout);
    assert.strictEqual(workflowRequirementsPayload.schemaVersion, 'github.workflow-requirements-inspect.v1');
    assert.strictEqual(workflowRequirementsPayload.capability.key, 'workflow.requirements.inspect');
    assert.ok(workflowRequirementsPayload.requirements.actionReferences.some((entry) => entry.includes('actions/checkout@')));

    const codeownersCreateDraft = await runNode([
      'src/cli/liku.js',
      'github',
      'codeowners',
      'create',
      'draft',
      '--json',
      '--slug',
      'owner/repo',
      '--api',
      'false',
      '--body-file',
      codeownersBodyFile,
      '--base',
      'main',
      '--head',
      'feature/codeowners-preview',
    ], repoRoot, sharedEnv);
    assert.strictEqual(codeownersCreateDraft.code, 0, 'github codeowners create draft exits 0');
    const codeownersCreateDraftPayload = JSON.parse(codeownersCreateDraft.stdout);
    assert.strictEqual(codeownersCreateDraftPayload.schemaVersion, 'github.codeowners-create-draft.v1');
    assert.strictEqual(codeownersCreateDraftPayload.capability.key, 'codeowners.create.draft');
    assert.strictEqual(codeownersCreateDraftPayload.codeownersPath, '.github/CODEOWNERS');
    assert.strictEqual(codeownersCreateDraftPayload.draft.baseBranch, 'main');
    assert.strictEqual(codeownersCreateDraftPayload.draft.headBranch, 'feature/codeowners-preview');

    const webhookCreateDraft = await runNode([
      'src/cli/liku.js',
      'github',
      'webhook',
      'create',
      'draft',
      '--json',
      '--slug',
      'owner/repo',
      '--events',
      'push,pull_request,workflow_run',
      '--target-url',
      'https://assistant.example.com/github/webhook',
      '--secret-ref',
      'repo:LIKU_WEBHOOK_SECRET',
      '--content-type',
      'json',
    ], repoRoot, sharedEnv);
    assert.strictEqual(webhookCreateDraft.code, 0, 'github webhook create draft exits 0');
    const webhookCreateDraftPayload = JSON.parse(webhookCreateDraft.stdout);
    assert.strictEqual(webhookCreateDraftPayload.schemaVersion, 'github.webhook-create-draft.v1');
    assert.strictEqual(webhookCreateDraftPayload.capability.key, 'webhook.create.draft');
    assert.strictEqual(webhookCreateDraftPayload.draft.targetUrl, 'https://assistant.example.com/github/webhook');
    assert.deepStrictEqual(webhookCreateDraftPayload.draft.events, ['push', 'pull_request', 'workflow_run']);
    assert.strictEqual(webhookCreateDraftPayload.draft.secretRef, 'repo:LIKU_WEBHOOK_SECRET');
    assert.strictEqual(webhookCreateDraftPayload.draft.contentType, 'json');

    const workflowCreateDraft = await runNode([
      'src/cli/liku.js',
      'github',
      'workflow',
      'create',
      'draft',
      '.github/workflows/validate.yml',
      '--json',
      '--slug',
      'owner/repo',
      '--body-file',
      workflowBodyFile,
      '--base',
      'main',
      '--head',
      'feature/workflow-validate',
    ], repoRoot, sharedEnv);
    assert.strictEqual(workflowCreateDraft.code, 0, 'github workflow create draft exits 0');
    const workflowCreateDraftPayload = JSON.parse(workflowCreateDraft.stdout);
    assert.strictEqual(workflowCreateDraftPayload.schemaVersion, 'github.workflow-create-draft.v1');
    assert.strictEqual(workflowCreateDraftPayload.capability.key, 'workflow.create.draft');
    assert.strictEqual(workflowCreateDraftPayload.workflowPath, '.github/workflows/validate.yml');
    assert.strictEqual(workflowCreateDraftPayload.draft.baseBranch, 'main');
    assert.strictEqual(workflowCreateDraftPayload.draft.headBranch, 'feature/workflow-validate');

    const workflowDispatchDraft = await runNode([
      'src/cli/liku.js',
      'github',
      'workflow',
      'dispatch',
      'draft',
      'validate.yml',
      '--json',
      '--slug',
      'owner/repo',
      '--ref',
      'main',
      '--inputs-json',
      '{"target":"staging"}',
    ], repoRoot, sharedEnv);
    assert.strictEqual(workflowDispatchDraft.code, 0, 'github workflow dispatch draft exits 0');
    const workflowDispatchDraftPayload = JSON.parse(workflowDispatchDraft.stdout);
    assert.strictEqual(workflowDispatchDraftPayload.schemaVersion, 'github.workflow-dispatch-draft.v1');
    assert.strictEqual(workflowDispatchDraftPayload.capability.key, 'workflow.dispatch.draft');
    assert.strictEqual(workflowDispatchDraftPayload.draft.workflow, 'validate.yml');
    assert.strictEqual(workflowDispatchDraftPayload.draft.ref, 'main');

    const workflowRerunDraft = await runNode([
      'src/cli/liku.js',
      'github',
      'workflow',
      'rerun',
      'draft',
      '9001',
      '--json',
      '--slug',
      'owner/repo',
      '--failed-only',
      'true',
    ], repoRoot, sharedEnv);
    assert.strictEqual(workflowRerunDraft.code, 0, 'github workflow rerun draft exits 0');
    const workflowRerunDraftPayload = JSON.parse(workflowRerunDraft.stdout);
    assert.strictEqual(workflowRerunDraftPayload.schemaVersion, 'github.workflow-rerun-draft.v1');
    assert.strictEqual(workflowRerunDraftPayload.draft.runId, 9001);
    assert.strictEqual(workflowRerunDraftPayload.draft.failedOnly, true);

    const workflowCancelDraft = await runNode([
      'src/cli/liku.js',
      'github',
      'workflow',
      'cancel',
      'draft',
      '9002',
      '--json',
      '--slug',
      'owner/repo',
    ], repoRoot, sharedEnv);
    assert.strictEqual(workflowCancelDraft.code, 0, 'github workflow cancel draft exits 0');
    const workflowCancelDraftPayload = JSON.parse(workflowCancelDraft.stdout);
    assert.strictEqual(workflowCancelDraftPayload.schemaVersion, 'github.workflow-cancel-draft.v1');
    assert.strictEqual(workflowCancelDraftPayload.draft.runId, 9002);

    const workflowRuns = await runNode([
      'src/cli/liku.js',
      'github',
      'workflow',
      'runs',
      '--json',
      '--api',
      'false',
      '--workflow',
      'ci.yml',
      '--limit',
      '3',
    ], repoRoot, sharedEnv);
    assert.strictEqual(workflowRuns.code, 0, 'github workflow runs exits 0');
    const workflowPayload = JSON.parse(workflowRuns.stdout);
    assert.strictEqual(workflowPayload.schemaVersion, 'github.workflow-runs.v1');
    assert.strictEqual(workflowPayload.githubApi.attempted, false);
    assert.strictEqual(workflowPayload.filters.workflow, 'ci.yml');
    assert.strictEqual(workflowPayload.filters.limit, 3);

    const workflowInspect = await runNode([
      'src/cli/liku.js',
      'github',
      'workflow',
      'inspect',
      '9001',
      '--json',
      '--api',
      'false',
    ], repoRoot, sharedEnv);
    assert.strictEqual(workflowInspect.code, 0, 'github workflow inspect exits 0');
    const workflowInspectPayload = JSON.parse(workflowInspect.stdout);
    assert.strictEqual(workflowInspectPayload.schemaVersion, 'github.workflow-inspect.v1');
    assert.strictEqual(workflowInspectPayload.runId, 9001);
    assert.strictEqual(workflowInspectPayload.githubApi.attempted, false);

    const releasesList = await runNode([
      'src/cli/liku.js',
      'github',
      'releases',
      'list',
      '--json',
      '--api',
      'false',
      '--limit',
      '5',
    ], repoRoot, sharedEnv);
    assert.strictEqual(releasesList.code, 0, 'github releases list exits 0');
    const releasesPayload = JSON.parse(releasesList.stdout);
    assert.strictEqual(releasesPayload.schemaVersion, 'github.releases-list.v1');
    assert.strictEqual(releasesPayload.githubApi.attempted, false);
    assert.strictEqual(releasesPayload.filters.limit, 5);

    const releaseInspect = await runNode([
      'src/cli/liku.js',
      'github',
      'releases',
      'inspect',
      'latest',
      '--json',
      '--api',
      'false',
    ], repoRoot, sharedEnv);
    assert.strictEqual(releaseInspect.code, 0, 'github releases inspect exits 0');
    const releaseInspectPayload = JSON.parse(releaseInspect.stdout);
    assert.strictEqual(releaseInspectPayload.schemaVersion, 'github.release-inspect.v1');
    assert.strictEqual(releaseInspectPayload.selector.kind, 'latest');
    assert.strictEqual(releaseInspectPayload.githubApi.attempted, false);

    console.log('PASS cli github command');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('FAIL cli github command');
  console.error(error.stack || error.message);
  process.exit(1);
});
