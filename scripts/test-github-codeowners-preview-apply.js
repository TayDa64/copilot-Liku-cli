#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-github-codeowners-preview-'));
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

const createCodeownersBody = `* @octocat
/docs/ @docs-team
`;
const updateCodeownersBody = `* @octocat @copilot
/docs/ @docs-team
/src/ @engineering
`;

(async () => {
  try {
    const executor = createGitHubCommandExecutor({
      env: {
        GH_TOKEN: 'github_pat_codeowners_preview_1234567890',
      },
      cwd: path.join(__dirname, '..'),
    });

    await test('codeowners create draft previews a repo-content patch and apply opens a draft pull request', async () => {
      const requestLog = [];
      const preview = await executor.execute({
        source: 'cli',
        area: 'codeowners',
        action: 'create',
        positionals: ['codeowners', 'create', 'draft'],
        options: {
          slug: 'example/project',
          body: createCodeownersBody,
          base: 'main',
          head: 'liku-codeowners-preview',
          featureFlags: { enableGitHub: true, enableGitHubWrites: true },
        },
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        executionPreferences: { approvalMode: 'prompt', dryRunDefault: false },
      });

      assert.strictEqual(preview.success, true);
      assert.strictEqual(preview.schemaVersion, 'github.codeowners-create-draft.v1');
      assert.strictEqual(preview.capability.key, 'codeowners.create.draft');
      assert.strictEqual(preview.policy.allowed, true);
      assert.strictEqual(preview.policy.state, 'preview-allowed');
      assert.strictEqual(preview.codeownersPath, '.github/CODEOWNERS');
      assert.strictEqual(preview.draft.changeOperation, 'create');
      assert.strictEqual(preview.draft.baseBranch, 'main');
      assert.strictEqual(preview.draft.headBranch, 'liku-codeowners-preview');
      assert.ok(preview.instructions.cliApply.includes(`liku github apply ${preview.previewId}`));

      const previewArtifact = readGitHubWritePreviewArtifact({ previewId: preview.previewId });
      assert.strictEqual(previewArtifact.previewType, 'repo-content-patch');
      assert.strictEqual(previewArtifact.target.resourceFamily, 'codeowners');
      assert.strictEqual(previewArtifact.target.path, '.github/CODEOWNERS');
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
            if (method === 'GET' && parsed.pathname === '/repos/example/project/git/ref/heads/liku-codeowners-preview') {
              return createJsonResponse(404, { message: 'Not Found' }, {}, url);
            }
            if (method === 'POST' && parsed.pathname === '/repos/example/project/git/refs') {
              return createJsonResponse(201, { ref: 'refs/heads/liku-codeowners-preview', object: { sha: 'base-sha' } }, {}, url);
            }
            if (method === 'GET' && parsed.pathname === '/repos/example/project/contents/.github/CODEOWNERS' && parsed.search === '?ref=liku-codeowners-preview') {
              return createJsonResponse(404, { message: 'Not Found' }, {}, url);
            }
            if (method === 'PUT' && parsed.pathname === '/repos/example/project/contents/.github/CODEOWNERS') {
              const body = JSON.parse(String(init.body || '{}'));
              assert.strictEqual(body.branch, 'liku-codeowners-preview');
              assert.ok(body.message.includes('CODEOWNERS'));
              assert.ok(body.content);
              return createJsonResponse(201, {
                content: {
                  path: '.github/CODEOWNERS',
                  sha: 'content-sha',
                  html_url: 'https://github.com/example/project/blob/liku-codeowners-preview/.github/CODEOWNERS',
                },
              }, {}, url);
            }
            if (method === 'POST' && parsed.pathname === '/repos/example/project/pulls') {
              const body = JSON.parse(String(init.body || '{}'));
              assert.strictEqual(body.head, 'liku-codeowners-preview');
              assert.strictEqual(body.base, 'main');
              assert.strictEqual(body.draft, true);
              return createJsonResponse(201, {
                number: 88,
                title: body.title,
                body: body.body,
                draft: true,
                state: 'open',
                merged: false,
                html_url: 'https://github.com/example/project/pull/88',
                user: { login: 'octocat', type: 'User', html_url: 'https://github.com/octocat' },
                head: { ref: 'liku-codeowners-preview', sha: 'content-sha' },
                base: { ref: 'main', sha: 'base-sha' },
                comments: 0,
                review_comments: 0,
                commits: 1,
                additions: 2,
                deletions: 0,
                changed_files: 1,
                created_at: '2026-05-28T00:00:00Z',
                updated_at: '2026-05-28T00:00:00Z',
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
      assert.strictEqual(apply.result.path, '.github/CODEOWNERS');
      assert.strictEqual(apply.result.pullRequest.number, 88);
      assert.strictEqual(apply.result.headBranch, 'liku-codeowners-preview');
      assert.ok(apply.result.pullRequest.htmlUrl.includes('/pull/88'));
      assert.ok(requestLog.some((entry) => entry.includes('/git/refs')));
      assert.ok(requestLog.some((entry) => entry.includes('/contents/.github/CODEOWNERS')));
      const resultArtifact = readGitHubWriteApplyResultArtifact({ previewId: preview.previewId });
      const eventLog = readGitHubWriteEventLog({ previewId: preview.previewId });
      assert.strictEqual(resultArtifact.success, true);
      assert.ok(eventLog.events.some((entry) => entry.eventName === 'apply.succeeded'));
    });

    await test('codeowners update draft detects the local workspace file when api is disabled', async () => {
      const localRepoRoot = path.join(tempRoot, 'local-codeowners-workspace');
      const localGitHubDir = path.join(localRepoRoot, '.github');
      const localGitDir = path.join(localRepoRoot, '.git');
      fs.mkdirSync(localGitHubDir, { recursive: true });
      fs.mkdirSync(localGitDir, { recursive: true });
      fs.writeFileSync(path.join(localRepoRoot, 'package.json'), JSON.stringify({ name: 'local-codeowners-workspace', version: '1.0.0' }, null, 2));
      fs.writeFileSync(path.join(localGitDir, 'config'), '[core]\n  repositoryformatversion = 0\n[remote "origin"]\n  url = https://github.com/example/project.git\n', 'utf8');
      fs.writeFileSync(path.join(localGitHubDir, 'CODEOWNERS'), createCodeownersBody, 'utf8');

      const localExecutor = createGitHubCommandExecutor({
        env: {
          GH_TOKEN: 'github_pat_codeowners_preview_1234567890',
        },
        cwd: localRepoRoot,
      });

      const preview = await localExecutor.execute({
        source: 'cli',
        area: 'codeowners',
        action: 'update',
        positionals: ['codeowners', 'update', 'draft'],
        options: {
          slug: 'example/project',
          api: false,
          body: updateCodeownersBody,
          base: 'main',
          head: 'liku-codeowners-update',
          featureFlags: { enableGitHub: true, enableGitHubWrites: true },
        },
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        executionPreferences: { approvalMode: 'prompt', dryRunDefault: false },
      });

      assert.strictEqual(preview.success, true);
      assert.strictEqual(preview.schemaVersion, 'github.codeowners-update-draft.v1');
      assert.strictEqual(preview.capability.key, 'codeowners.update.draft');
      assert.strictEqual(preview.codeownersPath, '.github/CODEOWNERS');
      assert.strictEqual(preview.draft.changeOperation, 'update');
      assert.strictEqual(preview.draft.baseBranch, 'main');
      assert.strictEqual(preview.draft.headBranch, 'liku-codeowners-update');
      assert.strictEqual(preview.draft.entryCount, 3);
      assert.strictEqual(preview.draft.ownerCount, 4);
      assert.ok(Array.isArray(preview.draft.owners));
      assert.ok(preview.draft.owners.includes('@octocat'));
      assert.ok(preview.draft.owners.includes('@copilot'));
      assert.ok(preview.draft.owners.includes('@docs-team'));
      assert.ok(preview.instructions.cliApply.includes(`liku github apply ${preview.previewId}`));
    });

    console.log(`PASS github codeowners preview/apply (${pass} assertions)`);
  } catch (error) {
    console.error('FAIL github codeowners preview/apply');
    console.error(error);
    process.exitCode = 1;
  }
})();
