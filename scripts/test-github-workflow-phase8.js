#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-github-workflow-phase8-'));
process.env.LIKU_HOME_OVERRIDE = path.join(tempRoot, '.liku');
process.env.LIKU_HOME_OLD_OVERRIDE = path.join(tempRoot, '.liku-cli-old');

const {
  createGitHubCommandExecutor,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'command-executor.js'));
const {
  readGitHubWriteApplyResultArtifact,
  readGitHubWriteEventLog,
  readGitHubWritePreviewArtifact,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'write-artifacts.js'));

let pass = 0;

async function test(name, fn) {
  await fn();
  pass += 1;
  console.log(`PASS ${name}`);
}

function createHeaders(values = {}) {
  return {
    get(name) {
      return values[String(name || '').toLowerCase()] || values[name] || null;
    },
  };
}

function createJsonResponse(status, payload, headers = {}, url = 'https://api.github.com/') {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: createHeaders(headers),
    async text() {
      return payload === undefined ? '' : JSON.stringify(payload);
    },
  };
}

const workflowYaml = `name: Validate\non:\n  push:\n    branches: [main]\npermissions: {}\njobs:\n  validate:\n    permissions:\n      contents: read\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5\n        with:\n          persist-credentials: false\n      - run: npm test\n`;

(async () => {
  try {
    const executor = createGitHubCommandExecutor({
      env: {
        GH_TOKEN: 'github_pat_phase8_workflow_1234567890',
      },
      cwd: path.join(__dirname, '..'),
    });

    await test('workflow validate and inspect surfaces summarize permissions and requirements', async () => {
      const validate = await executor.execute({
        source: 'cli',
        area: 'workflow',
        action: 'validate',
        positionals: ['workflow', 'validate', '.github/workflows/validate.yml'],
        options: {
          slug: 'example/project',
          body: workflowYaml,
          featureFlags: { enableGitHub: true },
        },
        featureFlagEnabled: true,
      });

      assert.strictEqual(validate.success, true);
      assert.strictEqual(validate.schemaVersion, 'github.workflow-validate.v1');
      assert.strictEqual(validate.capability.key, 'workflow.validate');
      assert.strictEqual(validate.validation.valid, true);
      assert.strictEqual(validate.summary.name, 'Validate');
      assert.deepStrictEqual(validate.summary.triggers, ['push']);
      assert.strictEqual(validate.permissions.hasTopLevelPermissions, true);
      assert.strictEqual(validate.policyCheck.violationCount, 0);

      const permissions = await executor.execute({
        source: 'cli',
        area: 'workflow',
        action: 'permissions',
        positionals: ['workflow', 'permissions', 'inspect', '.github/workflows/validate.yml'],
        options: {
          slug: 'example/project',
          body: workflowYaml,
          featureFlags: { enableGitHub: true },
        },
        featureFlagEnabled: true,
      });

      assert.strictEqual(permissions.success, true);
      assert.strictEqual(permissions.schemaVersion, 'github.workflow-permissions-inspect.v1');
      assert.strictEqual(permissions.capability.key, 'workflow.permissions.inspect');
      assert.deepStrictEqual(permissions.permissions.topLevelPermissions, {});
      assert.strictEqual(permissions.permissions.jobs[0].id, 'validate');
      assert.strictEqual(permissions.permissions.jobs[0].permissions.contents, 'read');

      const requirements = await executor.execute({
        source: 'cli',
        area: 'workflow',
        action: 'requirements',
        positionals: ['workflow', 'requirements', 'inspect', '.github/workflows/validate.yml'],
        options: {
          slug: 'example/project',
          body: workflowYaml,
          featureFlags: { enableGitHub: true },
        },
        featureFlagEnabled: true,
      });

      assert.strictEqual(requirements.success, true);
      assert.strictEqual(requirements.schemaVersion, 'github.workflow-requirements-inspect.v1');
      assert.strictEqual(requirements.capability.key, 'workflow.requirements.inspect');
      assert.ok(requirements.requirements.actionReferences.includes('actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5'));
      assert.deepStrictEqual(requirements.requirements.secrets, []);
    });

    await test('workflow create draft previews a repo-content patch and apply opens a draft pull request', async () => {
      const requestLog = [];
      const preview = await executor.execute({
        source: 'cli',
        area: 'workflow',
        action: 'create',
        positionals: ['workflow', 'create', 'draft', '.github/workflows/validate.yml'],
        options: {
          slug: 'example/project',
          body: workflowYaml,
          base: 'main',
          head: 'liku-workflow-validate-preview',
          featureFlags: { enableGitHub: true, enableGitHubWrites: true },
        },
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        executionPreferences: { approvalMode: 'prompt', dryRunDefault: false },
      });

      assert.strictEqual(preview.success, true);
      assert.strictEqual(preview.schemaVersion, 'github.workflow-create-draft.v1');
      assert.strictEqual(preview.capability.key, 'workflow.create.draft');
      assert.strictEqual(preview.policy.allowed, true);
      assert.strictEqual(preview.policy.state, 'preview-allowed');
      assert.strictEqual(preview.workflowPath, '.github/workflows/validate.yml');
      assert.strictEqual(preview.draft.changeOperation, 'create');
      assert.strictEqual(preview.draft.baseBranch, 'main');
      assert.strictEqual(preview.draft.headBranch, 'liku-workflow-validate-preview');
      assert.ok(preview.instructions.cliApply.includes(`liku github apply ${preview.previewId}`));

      const previewArtifact = readGitHubWritePreviewArtifact({ previewId: preview.previewId });
      assert.strictEqual(previewArtifact.previewType, 'repo-content-patch');
      assert.strictEqual(previewArtifact.target.path, '.github/workflows/validate.yml');
      assert.strictEqual(previewArtifact.target.changeOperation, 'create');
      assert.strictEqual(previewArtifact.target.pullRequestDraft, true);

      const apply = await executor.execute({
        source: 'cli',
        area: 'apply',
        action: preview.previewId,
        positionals: ['apply', preview.previewId],
        options: {
          approve: true,
          approvalFile: preview.approvalArtifact.filePath,
          featureFlags: { enableGitHub: true, enableGitHubWrites: true },
          fetchImpl: async (url, init = {}) => {
            const method = String(init.method || 'GET').toUpperCase();
            const parsed = new URL(url);
            requestLog.push(`${method} ${parsed.pathname}${parsed.search}`);

            if (method === 'GET' && parsed.pathname === '/repos/example/project/git/ref/heads/main') {
              return createJsonResponse(200, { object: { sha: 'base-sha' } }, {}, url);
            }
            if (method === 'GET' && parsed.pathname === '/repos/example/project/git/ref/heads/liku-workflow-validate-preview') {
              return createJsonResponse(404, { message: 'Not Found' }, {}, url);
            }
            if (method === 'POST' && parsed.pathname === '/repos/example/project/git/refs') {
              return createJsonResponse(201, { ref: 'refs/heads/liku-workflow-validate-preview', object: { sha: 'base-sha' } }, {}, url);
            }
            if (method === 'GET' && parsed.pathname === '/repos/example/project/contents/.github/workflows/validate.yml' && parsed.search === '?ref=liku-workflow-validate-preview') {
              return createJsonResponse(404, { message: 'Not Found' }, {}, url);
            }
            if (method === 'PUT' && parsed.pathname === '/repos/example/project/contents/.github/workflows/validate.yml') {
              const body = JSON.parse(String(init.body || '{}'));
              assert.strictEqual(body.branch, 'liku-workflow-validate-preview');
              assert.ok(body.message.includes('workflow'));
              assert.ok(body.content);
              return createJsonResponse(201, {
                content: {
                  path: '.github/workflows/validate.yml',
                  sha: 'content-sha',
                  html_url: 'https://github.com/example/project/blob/liku-workflow-validate-preview/.github/workflows/validate.yml',
                },
              }, {}, url);
            }
            if (method === 'POST' && parsed.pathname === '/repos/example/project/pulls') {
              const body = JSON.parse(String(init.body || '{}'));
              assert.strictEqual(body.head, 'liku-workflow-validate-preview');
              assert.strictEqual(body.base, 'main');
              assert.strictEqual(body.draft, true);
              return createJsonResponse(201, {
                number: 77,
                title: body.title,
                body: body.body,
                draft: true,
                state: 'open',
                merged: false,
                html_url: 'https://github.com/example/project/pull/77',
                user: { login: 'octocat', type: 'User', html_url: 'https://github.com/octocat' },
                head: { ref: 'liku-workflow-validate-preview', sha: 'content-sha' },
                base: { ref: 'main', sha: 'base-sha' },
                comments: 0,
                review_comments: 0,
                commits: 1,
                additions: 1,
                deletions: 0,
                changed_files: 1,
                created_at: '2026-05-27T00:00:00Z',
                updated_at: '2026-05-27T00:00:00Z',
              }, {}, url);
            }

            throw new Error(`Unexpected repo-content patch request: ${method} ${parsed.pathname}${parsed.search}`);
          },
        },
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        executionPreferences: { approvalMode: 'prompt', dryRunDefault: false },
      });

      assert.strictEqual(apply.success, true);
      assert.strictEqual(apply.schemaVersion, 'github.write-apply.v1');
      assert.strictEqual(apply.result.type, 'repo-content-patch');
      assert.strictEqual(apply.result.path, '.github/workflows/validate.yml');
      assert.strictEqual(apply.result.pullRequest.number, 77);
      assert.strictEqual(apply.result.headBranch, 'liku-workflow-validate-preview');
      assert.ok(apply.result.pullRequest.htmlUrl.includes('/pull/77'));
      assert.ok(requestLog.some((entry) => entry.includes('/git/refs')));
      assert.ok(requestLog.some((entry) => entry.includes('/contents/.github/workflows/validate.yml')));
      const resultArtifact = readGitHubWriteApplyResultArtifact({ previewId: preview.previewId });
      const eventLog = readGitHubWriteEventLog({ previewId: preview.previewId });
      assert.strictEqual(resultArtifact.success, true);
      assert.ok(eventLog.events.some((entry) => entry.eventName === 'apply.succeeded'));
    });

    await test('workflow dispatch draft apply succeeds even when GitHub returns an empty body', async () => {
      const preview = await executor.execute({
        source: 'cli',
        area: 'workflow',
        action: 'dispatch',
        positionals: ['workflow', 'dispatch', 'draft', 'validate.yml'],
        options: {
          slug: 'example/project',
          ref: 'main',
          inputsJson: '{"target":"staging"}',
          featureFlags: { enableGitHub: true, enableGitHubWrites: true },
        },
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        executionPreferences: { approvalMode: 'prompt', dryRunDefault: false },
      });

      assert.strictEqual(preview.success, true);
      assert.strictEqual(preview.schemaVersion, 'github.workflow-dispatch-draft.v1');
      assert.strictEqual(preview.policy.riskLevel, 'low');
      assert.strictEqual(preview.draft.workflow, 'validate.yml');
      assert.strictEqual(preview.draft.ref, 'main');
      assert.strictEqual(preview.draft.inputsCount, 1);

      const apply = await executor.execute({
        source: 'cli',
        area: 'apply',
        action: preview.previewId,
        positionals: ['apply', preview.previewId],
        options: {
          approve: true,
          approvalFile: preview.approvalArtifact.filePath,
          featureFlags: { enableGitHub: true, enableGitHubWrites: true },
          fetchImpl: async (url, init = {}) => {
            const parsed = new URL(url);
            const method = String(init.method || 'GET').toUpperCase();
            assert.strictEqual(method, 'POST');
            assert.strictEqual(parsed.pathname, '/repos/example/project/actions/workflows/validate.yml/dispatches');
            const body = JSON.parse(String(init.body || '{}'));
            assert.strictEqual(body.ref, 'main');
            assert.strictEqual(body.inputs.target, 'staging');
            return createJsonResponse(204, undefined, {}, url);
          },
        },
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        executionPreferences: { approvalMode: 'prompt', dryRunDefault: false },
      });

      assert.strictEqual(apply.success, true);
      assert.strictEqual(apply.result.type, 'workflow-dispatch');
      assert.strictEqual(apply.result.workflow, 'validate.yml');
      assert.strictEqual(apply.result.ref, 'main');
      const eventLog = readGitHubWriteEventLog({ previewId: preview.previewId });
      assert.ok(eventLog.events.some((entry) => entry.eventName === 'apply.succeeded'));
    });

    await test('workflow rerun and cancel draft apply flows succeed with empty-body responses', async () => {
      const rerunPreview = await executor.execute({
        source: 'cli',
        area: 'workflow',
        action: 'rerun',
        positionals: ['workflow', 'rerun', 'draft', '9001'],
        options: {
          slug: 'example/project',
          'failed-only': true,
          featureFlags: { enableGitHub: true, enableGitHubWrites: true },
        },
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        executionPreferences: { approvalMode: 'prompt', dryRunDefault: false },
      });

      assert.strictEqual(rerunPreview.success, true);
      assert.strictEqual(rerunPreview.policy.riskLevel, 'low');

      const rerunApply = await executor.execute({
        source: 'cli',
        area: 'apply',
        action: rerunPreview.previewId,
        positionals: ['apply', rerunPreview.previewId],
        options: {
          approve: true,
          approvalFile: rerunPreview.approvalArtifact.filePath,
          featureFlags: { enableGitHub: true, enableGitHubWrites: true },
          fetchImpl: async (url, init = {}) => {
            const parsed = new URL(url);
            assert.strictEqual(String(init.method || 'GET').toUpperCase(), 'POST');
            assert.strictEqual(parsed.pathname, '/repos/example/project/actions/runs/9001/rerun-failed-jobs');
            return createJsonResponse(201, undefined, {}, url);
          },
        },
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        executionPreferences: { approvalMode: 'prompt', dryRunDefault: false },
      });

      assert.strictEqual(rerunApply.success, true);
      assert.strictEqual(rerunApply.result.type, 'workflow-rerun');
      assert.strictEqual(rerunApply.result.runId, 9001);
      assert.strictEqual(rerunApply.result.failedOnly, true);

      const cancelPreview = await executor.execute({
        source: 'cli',
        area: 'workflow',
        action: 'cancel',
        positionals: ['workflow', 'cancel', 'draft', '9002'],
        options: {
          slug: 'example/project',
          featureFlags: { enableGitHub: true, enableGitHubWrites: true },
        },
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        executionPreferences: { approvalMode: 'prompt', dryRunDefault: false },
      });

      assert.strictEqual(cancelPreview.success, true);
      assert.strictEqual(cancelPreview.policy.riskLevel, 'low');

      const cancelApply = await executor.execute({
        source: 'cli',
        area: 'apply',
        action: cancelPreview.previewId,
        positionals: ['apply', cancelPreview.previewId],
        options: {
          approve: true,
          approvalFile: cancelPreview.approvalArtifact.filePath,
          featureFlags: { enableGitHub: true, enableGitHubWrites: true },
          fetchImpl: async (url, init = {}) => {
            const parsed = new URL(url);
            assert.strictEqual(String(init.method || 'GET').toUpperCase(), 'POST');
            assert.strictEqual(parsed.pathname, '/repos/example/project/actions/runs/9002/cancel');
            return createJsonResponse(202, undefined, {}, url);
          },
        },
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        executionPreferences: { approvalMode: 'prompt', dryRunDefault: false },
      });

      assert.strictEqual(cancelApply.success, true);
      assert.strictEqual(cancelApply.result.type, 'workflow-cancel');
      assert.strictEqual(cancelApply.result.runId, 9002);
    });

    console.log(`PASS github workflow phase8 (${pass} assertions)`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error('FAIL github workflow phase8');
  console.error(error.stack || error.message);
  process.exit(1);
});
