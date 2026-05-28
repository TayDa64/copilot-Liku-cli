#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveGitHubAuthStatus } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'auth-status.js'));
const { inspectGitHubAppInstallation } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'app-installation-inspect.js'));
const { inspectGitHubAppPermissions } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'app-permissions-inspect.js'));
const { inspectGitHubAppStatus } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'app-status.js'));
const { inspectGitHubCodeowners } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'codeowners-inspect.js'));
const { inspectGitHubEnvironment } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'environment-inspect.js'));
const { listGitHubEnvironments } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'environment-list.js'));
const { inspectGitHubRuleset } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'ruleset-inspect.js'));
const { listGitHubRulesets } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'ruleset-list.js'));
const { inspectGitHubSecret } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'secret-inspect.js'));
const { listGitHubSecrets } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'secret-list.js'));
const { inspectGitHubTemplates } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'template-inspect.js'));
const { inspectGitHubVariable } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'variable-inspect.js'));
const { listGitHubVariables } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'variable-list.js'));
const { inspectGitHubWebhook } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'webhook-inspect.js'));
const { listGitHubWebhooks } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'webhook-list.js'));

let pass = 0;

async function test(name, fn) {
  await fn();
  pass += 1;
  console.log(`PASS ${name}`);
}

function buildResponse(body, status = 200, headers = {}) {
  const baseHeaders = {
    'content-type': 'application/json',
    'x-oauth-scopes': 'repo,admin:repo_hook',
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '4999',
    'x-ratelimit-reset': '9999999999',
    ...headers,
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: baseHeaders,
  });
}

function createFetchImpl(routeTable) {
  return async function fetchImpl(url) {
    const href = String(url || '');
    const entry = routeTable.find((candidate) => href.includes(candidate.match));
    if (!entry) {
      return buildResponse({ message: `No mock response for ${href}` }, 500);
    }
    return buildResponse(entry.body, entry.status || 200, entry.headers || {});
  };
}

function createGitHubEnv() {
  return {
    GH_TOKEN: 'ghp_test_token_phase9',
    LIKU_ENABLE_GITHUB: '1',
  };
}

(async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-github-phase9-'));
  try {
    await test('auth status publishes governance inventory hints even without a live probe', async () => {
      const report = await resolveGitHubAuthStatus({
        env: createGitHubEnv(),
        featureFlagEnabled: true,
        probe: false,
      });

      assert.strictEqual(report.success, true);
      assert.strictEqual(report.schemaVersion, 'github.auth-status.v1');
      assert.strictEqual(report.githubApi.tokenPresent, true);
      assert.strictEqual(report.githubApi.probeAttempted, false);
      assert.ok(Array.isArray(report.governanceAccess.hints));
      assert.ok(report.governanceAccess.hints.some((hint) => hint.id === 'repo-governance-admin'));
    });

    await test('ruleset list and inspect summarize enforcement metadata through the REST adapter', async () => {
      const fetchImpl = createFetchImpl([
        {
          match: '/repos/owner/repo/rulesets?per_page=20',
          body: [
            {
              id: 12,
              name: 'Protect main',
              target: 'branch',
              source_type: 'Repository',
              source: 'owner/repo',
              enforcement: 'active',
              current_user_can_bypass: false,
              rules: [{ type: 'pull_request' }, { type: 'required_status_checks' }],
              bypass_actors: [{ actor_id: 1, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
              conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
              updated_at: '2026-01-02T03:04:05Z',
            },
          ],
        },
        {
          match: '/repos/owner/repo/rulesets/12',
          body: {
            id: 12,
            name: 'Protect main',
            target: 'branch',
            source_type: 'Repository',
            source: 'owner/repo',
            enforcement: 'active',
            current_user_can_bypass: true,
            rules: [{ type: 'pull_request' }, { type: 'required_status_checks' }],
            bypass_actors: [{ actor_id: 1, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
            conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: ['refs/heads/dev'] } },
            updated_at: '2026-01-02T03:04:05Z',
          },
        },
      ]);

      const listReport = await listGitHubRulesets({ cwd: tempRoot, env: createGitHubEnv(), featureFlagEnabled: true, slug: 'owner/repo', fetchImpl });
      assert.strictEqual(listReport.schemaVersion, 'github.ruleset-list.v1');
      assert.strictEqual(listReport.githubApi.attempted, true);
      assert.strictEqual(listReport.rulesets[0].name, 'Protect main');
      assert.deepStrictEqual(listReport.rulesets[0].ruleTypes, ['pull_request', 'required_status_checks']);

      const inspectReport = await inspectGitHubRuleset({ cwd: tempRoot, env: createGitHubEnv(), featureFlagEnabled: true, slug: 'owner/repo', id: 12, fetchImpl });
      assert.strictEqual(inspectReport.schemaVersion, 'github.ruleset-inspect.v1');
      assert.strictEqual(inspectReport.ruleset.id, 12);
      assert.strictEqual(inspectReport.ruleset.currentUserCanBypass, true);
      assert.deepStrictEqual(inspectReport.ruleset.conditions.refName.exclude, ['refs/heads/dev']);
    });

    await test('environment list and inspect summarize protection metadata', async () => {
      const fetchImpl = createFetchImpl([
        {
          match: '/repos/owner/repo/environments?per_page=20',
          body: {
            total_count: 1,
            environments: [
              {
                id: 22,
                name: 'production',
                protection_rules: [
                  { id: 1, type: 'wait_timer', wait_timer: 30 },
                  { id: 2, type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: 'octocat', type: 'User', html_url: 'https://github.com/octocat' } }], prevent_self_review: true },
                ],
                deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
                can_admins_bypass: true,
                updated_at: '2026-01-02T03:04:05Z',
              },
            ],
          },
        },
        {
          match: '/repos/owner/repo/environments/production',
          body: {
            id: 22,
            name: 'production',
            protection_rules: [
              { id: 1, type: 'wait_timer', wait_timer: 30 },
              { id: 2, type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: 'octocat', type: 'User', html_url: 'https://github.com/octocat' } }], prevent_self_review: true },
            ],
            deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
            can_admins_bypass: true,
            updated_at: '2026-01-02T03:04:05Z',
          },
        },
      ]);

      const listReport = await listGitHubEnvironments({ cwd: tempRoot, env: createGitHubEnv(), featureFlagEnabled: true, slug: 'owner/repo', fetchImpl });
      assert.strictEqual(listReport.schemaVersion, 'github.environment-list.v1');
      assert.strictEqual(listReport.environments[0].name, 'production');
      assert.strictEqual(listReport.environments[0].reviewerCount, 1);
      assert.strictEqual(listReport.environments[0].waitTimer, 30);

      const inspectReport = await inspectGitHubEnvironment({ cwd: tempRoot, env: createGitHubEnv(), featureFlagEnabled: true, slug: 'owner/repo', name: 'production', fetchImpl });
      assert.strictEqual(inspectReport.schemaVersion, 'github.environment-inspect.v1');
      assert.strictEqual(inspectReport.environment.canAdminsBypass, true);
      assert.strictEqual(inspectReport.environment.preventSelfReview, true);
    });

    await test('secret and variable inventory stays metadata-only', async () => {
      const fetchImpl = createFetchImpl([
        {
          match: '/repos/owner/repo/actions/secrets?per_page=50',
          body: {
            total_count: 1,
            secrets: [
              {
                name: 'DEPLOY_TOKEN',
                visibility: 'selected',
                num_selected_repos: 2,
                selected_repositories_url: 'https://api.github.com/repos/owner/repo/actions/secrets/DEPLOY_TOKEN/repositories',
                updated_at: '2026-01-02T03:04:05Z',
              },
            ],
          },
        },
        {
          match: '/repos/owner/repo/actions/secrets/DEPLOY_TOKEN',
          body: {
            name: 'DEPLOY_TOKEN',
            visibility: 'selected',
            num_selected_repos: 2,
            selected_repositories_url: 'https://api.github.com/repos/owner/repo/actions/secrets/DEPLOY_TOKEN/repositories',
            updated_at: '2026-01-02T03:04:05Z',
          },
        },
        {
          match: '/repos/owner/repo/actions/variables?per_page=50',
          body: {
            total_count: 1,
            variables: [
              {
                name: 'FEATURE_FLAG',
                visibility: 'all',
                updated_at: '2026-01-02T03:04:05Z',
              },
            ],
          },
        },
        {
          match: '/repos/owner/repo/actions/variables/FEATURE_FLAG',
          body: {
            name: 'FEATURE_FLAG',
            visibility: 'all',
            updated_at: '2026-01-02T03:04:05Z',
            value: 'enabled',
          },
        },
      ]);

      const secretList = await listGitHubSecrets({ cwd: tempRoot, env: createGitHubEnv(), featureFlagEnabled: true, slug: 'owner/repo', fetchImpl });
      assert.strictEqual(secretList.schemaVersion, 'github.secret-list.v1');
      assert.strictEqual(secretList.metadataOnly, true);
      assert.strictEqual(secretList.secrets[0].valueExposed, false);
      assert.strictEqual(secretList.secrets[0].selectedRepositoriesCount, 2);

      const secretInspect = await inspectGitHubSecret({ cwd: tempRoot, env: createGitHubEnv(), featureFlagEnabled: true, slug: 'owner/repo', name: 'DEPLOY_TOKEN', fetchImpl });
      assert.strictEqual(secretInspect.schemaVersion, 'github.secret-inspect.v1');
      assert.strictEqual(secretInspect.secret.valueExposed, false);
      assert.strictEqual(secretInspect.secret.name, 'DEPLOY_TOKEN');

      const variableList = await listGitHubVariables({ cwd: tempRoot, env: createGitHubEnv(), featureFlagEnabled: true, slug: 'owner/repo', fetchImpl });
      assert.strictEqual(variableList.schemaVersion, 'github.variable-list.v1');
      assert.strictEqual(variableList.variables[0].valueExposed, false);

      const variableInspect = await inspectGitHubVariable({ cwd: tempRoot, env: createGitHubEnv(), featureFlagEnabled: true, slug: 'owner/repo', name: 'FEATURE_FLAG', fetchImpl });
      assert.strictEqual(variableInspect.schemaVersion, 'github.variable-inspect.v1');
      assert.strictEqual(variableInspect.variable.valueExposed, false);
      assert.strictEqual(variableInspect.variable.valuePresent, true);
    });

    await test('codeowners inspect prefers current workspace and template inspect summarizes local templates offline', async () => {
      const repoDir = path.join(tempRoot, 'workspace-repo');
      fs.mkdirSync(path.join(repoDir, '.github', 'ISSUE_TEMPLATE'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'CODEOWNERS'), '* @octocat\n/src @team/backend', 'utf8');
      fs.writeFileSync(path.join(repoDir, '.github', 'PULL_REQUEST_TEMPLATE.md'), '# Pull Request\nDescribe your change.', 'utf8');
      fs.writeFileSync(path.join(repoDir, '.github', 'ISSUE_TEMPLATE', 'bug_report.yml'), 'name: Bug report\ndescription: Report a bug', 'utf8');

      const codeownersReport = await inspectGitHubCodeowners({ cwd: repoDir, env: createGitHubEnv(), featureFlagEnabled: true, api: false });
      assert.strictEqual(codeownersReport.schemaVersion, 'github.codeowners-inspect.v1');
      assert.strictEqual(codeownersReport.codeowners.source, 'local-workspace');
      assert.strictEqual(codeownersReport.codeowners.entryCount, 2);
      assert.ok(codeownersReport.codeowners.owners.includes('@octocat'));

      const templateReport = await inspectGitHubTemplates({ cwd: repoDir, env: createGitHubEnv(), featureFlagEnabled: true, api: false });
      assert.strictEqual(templateReport.schemaVersion, 'github.template-inspect.v1');
      assert.strictEqual(templateReport.templates.source, 'local-workspace');
      assert.strictEqual(templateReport.templates.totalCount, 2);
      assert.strictEqual(templateReport.templates.pullRequestTemplates[0].title, 'Pull Request');
      assert.strictEqual(templateReport.templates.issueTemplates[0].title, 'Bug report');
    });

    await test('webhook inventory redacts sensitive config metadata', async () => {
      const fetchImpl = createFetchImpl([
        {
          match: '/repos/owner/repo/hooks?per_page=20',
          body: [
            {
              id: 9001,
              type: 'Repository',
              name: 'web',
              active: true,
              events: ['push', 'pull_request'],
              config: { url: 'https://hooks.example.test/github?secret=ignored', content_type: 'json', secret: 'super-secret' },
              updated_at: '2026-01-02T03:04:05Z',
            },
          ],
        },
        {
          match: '/repos/owner/repo/hooks/9001',
          body: {
            id: 9001,
            type: 'Repository',
            name: 'web',
            active: true,
            events: ['push', 'pull_request'],
            config: { url: 'https://hooks.example.test/github?secret=ignored', content_type: 'json', secret: 'super-secret' },
            last_response: { code: 200, status: 'ok', message: 'delivered' },
            updated_at: '2026-01-02T03:04:05Z',
          },
        },
      ]);

      const listReport = await listGitHubWebhooks({ cwd: tempRoot, env: createGitHubEnv(), featureFlagEnabled: true, slug: 'owner/repo', fetchImpl });
      assert.strictEqual(listReport.schemaVersion, 'github.webhook-list.v1');
      assert.strictEqual(listReport.webhooks[0].config.secret, '[redacted]');
      assert.strictEqual(listReport.webhooks[0].eventCount, 2);
      assert.ok(String(listReport.webhooks[0].config.url).startsWith('https://hooks.example.test/github'));

      const inspectReport = await inspectGitHubWebhook({ cwd: tempRoot, env: createGitHubEnv(), featureFlagEnabled: true, slug: 'owner/repo', id: 9001, fetchImpl });
      assert.strictEqual(inspectReport.schemaVersion, 'github.webhook-inspect.v1');
      assert.strictEqual(inspectReport.webhook.config.secret, '[redacted]');
      assert.strictEqual(inspectReport.webhook.lastResponse.code, 200);
    });

    await test('app installation, permissions, and status summarize installation posture', async () => {
      const installationBody = {
        id: 7001,
        app_id: 321,
        app_slug: 'liku-bot',
        target_id: 99,
        target_type: 'Repository',
        account: { login: 'owner', id: 1, type: 'Organization', html_url: 'https://github.com/owner' },
        repository_selection: 'selected',
        access_tokens_url: 'https://api.github.com/app/installations/7001/access_tokens',
        repositories_url: 'https://api.github.com/installation/repositories',
        permissions: { contents: 'read', pull_requests: 'write' },
        events: ['push', 'pull_request'],
        updated_at: '2026-01-02T03:04:05Z',
      };
      const fetchImpl = createFetchImpl([
        {
          match: '/user',
          body: { login: 'octocat', type: 'User', html_url: 'https://github.com/octocat' },
          headers: { 'x-oauth-scopes': 'repo,admin:repo_hook' },
        },
        {
          match: '/repos/owner/repo/installation',
          body: installationBody,
        },
      ]);

      const installationReport = await inspectGitHubAppInstallation({ cwd: tempRoot, env: createGitHubEnv(), featureFlagEnabled: true, slug: 'owner/repo', fetchImpl });
      assert.strictEqual(installationReport.schemaVersion, 'github.app-installation-inspect.v1');
      assert.strictEqual(installationReport.installation.appSlug, 'liku-bot');
      assert.strictEqual(installationReport.installation.repositorySelection, 'selected');

      const permissionsReport = await inspectGitHubAppPermissions({ cwd: tempRoot, env: createGitHubEnv(), featureFlagEnabled: true, slug: 'owner/repo', fetchImpl });
      assert.strictEqual(permissionsReport.schemaVersion, 'github.app-permissions-inspect.v1');
      assert.strictEqual(permissionsReport.permissionCount, 2);
      assert.deepStrictEqual(permissionsReport.events, ['push', 'pull_request']);

      const statusReport = await inspectGitHubAppStatus({ cwd: tempRoot, env: createGitHubEnv(), featureFlagEnabled: true, slug: 'owner/repo', fetchImpl, probe: true });
      assert.strictEqual(statusReport.schemaVersion, 'github.app-status.v1');
      assert.strictEqual(statusReport.summary.tokenPresent, true);
      assert.strictEqual(statusReport.summary.installationAccessible, true);
      assert.strictEqual(statusReport.installation.appSlug, 'liku-bot');
      assert.ok(Array.isArray(statusReport.authStatus.governanceAccess.hints));
      assert.strictEqual(statusReport.authStatus.githubApi.viewer.login, 'octocat');
    });

    console.log(`\nPassed: ${pass}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
