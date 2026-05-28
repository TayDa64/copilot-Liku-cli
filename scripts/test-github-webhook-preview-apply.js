#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-github-webhook-'));
process.env.LIKU_HOME_OVERRIDE = path.join(tempRoot, '.liku');
process.env.LIKU_HOME_OLD_OVERRIDE = path.join(tempRoot, '.liku-cli-old');

const {
  createGitHubCommandExecutor,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'command-executor.js'));
const {
  readGitHubWriteApplyResultArtifact,
  readGitHubWriteApprovalArtifact,
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

function createJsonResponse(status, payload, headers = {}, url = 'https://api.github.com/repos/example/project/hooks') {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: createHeaders(headers),
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function createExecutor(env = {}) {
  return createGitHubCommandExecutor({
    env: {
      GH_TOKEN: 'github_pat_test_webhook_preview_apply_1234567890',
      ...env,
    },
    cwd: path.join(__dirname, '..'),
  });
}

function buildWebhookResponse(overrides = {}) {
  return {
    id: 9001,
    type: 'Repository',
    name: 'web',
    active: true,
    events: ['push', 'pull_request'],
    config: {
      url: 'https://assistant.example.com/github/webhook',
      content_type: 'json',
      insecure_ssl: '0',
    },
    deliveries_url: 'https://api.github.com/repos/example/project/hooks/9001/deliveries',
    ping_url: 'https://api.github.com/repos/example/project/hooks/9001/pings',
    test_url: 'https://api.github.com/repos/example/project/hooks/9001/tests',
    url: 'https://api.github.com/repos/example/project/hooks/9001',
    created_at: '2026-05-28T00:00:00.000Z',
    updated_at: '2026-05-28T00:00:00.000Z',
    last_response: {
      code: null,
      status: 'unused',
      message: null,
    },
    ...overrides,
  };
}

(async () => {
  try {
    await test('webhook create draft persists reviewed artifacts with a secret ref but without the secret value', async () => {
      const executor = createExecutor({ LIKU_WEBHOOK_SECRET: 'super-secret-webhook-value' });
      const report = await executor.execute({
        source: 'cli',
        area: 'webhook',
        action: 'create',
        positionals: ['webhook', 'create', 'draft'],
        options: {
          slug: 'example/project',
          events: 'push,pull_request,workflow_run',
          'target-url': 'https://assistant.example.com/github/webhook',
          'secret-ref': 'repo:LIKU_WEBHOOK_SECRET',
          'content-type': 'json',
          featureFlags: { enableGitHub: true, enableGitHubWrites: true },
        },
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        executionPreferences: { approvalMode: 'prompt', dryRunDefault: false },
      });

      assert.strictEqual(report.success, true);
      assert.strictEqual(report.schemaVersion, 'github.webhook-create-draft.v1');
      assert.strictEqual(report.capability.key, 'webhook.create.draft');
      assert.strictEqual(report.policy.allowed, true);
      assert.strictEqual(report.policy.state, 'preview-allowed');
      assert.strictEqual(report.policy.riskLevel, 'medium');
      assert.strictEqual(report.draft.targetUrl, 'https://assistant.example.com/github/webhook');
      assert.deepStrictEqual(report.draft.events, ['push', 'pull_request', 'workflow_run']);
      assert.strictEqual(report.draft.contentType, 'json');
      assert.strictEqual(report.draft.secretRef, 'repo:LIKU_WEBHOOK_SECRET');
      assert.strictEqual(report.draft.secretEnvName, 'LIKU_WEBHOOK_SECRET');
      assert.strictEqual(report.draft.active, true);
      assert.ok(report.previewId);
      assert.ok(fs.existsSync(report.previewArtifact.filePath));
      assert.ok(fs.existsSync(report.approvalArtifact.filePath));

      const previewArtifact = readGitHubWritePreviewArtifact({ previewId: report.previewId });
      const approvalArtifact = readGitHubWriteApprovalArtifact({ previewId: report.previewId });
      const eventLog = readGitHubWriteEventLog({ previewId: report.previewId });
      const previewText = JSON.stringify(previewArtifact);

      assert.strictEqual(previewArtifact.target.secretRef, 'repo:LIKU_WEBHOOK_SECRET');
      assert.strictEqual(previewArtifact.target.secretEnvName, 'LIKU_WEBHOOK_SECRET');
      assert.ok(!previewText.includes('super-secret-webhook-value'));
      assert.strictEqual(approvalArtifact.status, 'requested');
      assert.ok(eventLog.events.some((entry) => entry.eventName === 'preview.created'));
      assert.ok(eventLog.events.some((entry) => entry.eventName === 'approval.requested'));
    });

    await test('webhook create apply resolves the secret ref from local env and creates the webhook once', async () => {
      const executor = createExecutor({ LIKU_WEBHOOK_SECRET: 'super-secret-webhook-value' });
      let fetchCalls = 0;
      const preview = await executor.execute({
        source: 'cli',
        area: 'webhook',
        action: 'create',
        positionals: ['webhook', 'create', 'draft'],
        options: {
          slug: 'example/project',
          events: 'push,pull_request',
          'target-url': 'https://assistant.example.com/github/webhook',
          'secret-ref': 'repo:LIKU_WEBHOOK_SECRET',
          'content-type': 'json',
          featureFlags: { enableGitHub: true, enableGitHubWrites: true },
        },
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        executionPreferences: { approvalMode: 'prompt', dryRunDefault: false },
      });

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
            fetchCalls += 1;
            const parsed = new URL(url);
            assert.strictEqual(String(init.method || 'GET').toUpperCase(), 'POST');
            assert.strictEqual(parsed.pathname, '/repos/example/project/hooks');
            const body = JSON.parse(String(init.body || '{}'));
            assert.strictEqual(body.name, 'web');
            assert.strictEqual(body.active, true);
            assert.deepStrictEqual(body.events, ['push', 'pull_request']);
            assert.strictEqual(body.config.url, 'https://assistant.example.com/github/webhook');
            assert.strictEqual(body.config.content_type, 'json');
            assert.strictEqual(body.config.secret, 'super-secret-webhook-value');
            return createJsonResponse(201, buildWebhookResponse({ events: body.events }), {}, url);
          },
        },
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        executionPreferences: { approvalMode: 'prompt', dryRunDefault: false },
      });

      assert.strictEqual(apply.success, true);
      assert.strictEqual(apply.schemaVersion, 'github.write-apply.v1');
      assert.strictEqual(apply.approval.status, 'applied');
      assert.strictEqual(apply.result.type, 'webhook-create');
      assert.strictEqual(apply.result.webhookId, 9001);
      assert.strictEqual(apply.result.webhook.id, 9001);
      assert.strictEqual(apply.result.webhook.config.url, 'https://assistant.example.com/github/webhook');
      assert.strictEqual(fetchCalls, 1);

      const resultArtifact = readGitHubWriteApplyResultArtifact({ previewId: preview.previewId });
      const eventLog = readGitHubWriteEventLog({ previewId: preview.previewId });
      assert.strictEqual(resultArtifact.success, true);
      assert.strictEqual(resultArtifact.result.type, 'webhook-create');
      assert.ok(eventLog.events.some((entry) => entry.eventName === 'apply.succeeded'));
    });

    await test('webhook update and ping apply flows use the direct webhook API', async () => {
      const executor = createExecutor();
      const updatePreview = await executor.execute({
        source: 'cli',
        area: 'webhook',
        action: 'update',
        positionals: ['webhook', 'update', 'draft', '9001'],
        options: {
          slug: 'example/project',
          events: 'workflow_run,pull_request_review',
          'target-url': 'https://assistant.example.com/github/webhook',
          active: 'false',
          featureFlags: { enableGitHub: true, enableGitHubWrites: true },
        },
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        executionPreferences: { approvalMode: 'prompt', dryRunDefault: false },
      });

      assert.strictEqual(updatePreview.success, true);
      assert.strictEqual(updatePreview.schemaVersion, 'github.webhook-update-draft.v1');
      assert.strictEqual(updatePreview.draft.webhookId, 9001);
      assert.ok(updatePreview.draft.updates.includes('events'));
      assert.ok(updatePreview.draft.updates.includes('target-url'));
      assert.ok(updatePreview.draft.updates.includes('active'));

      const updateApply = await executor.execute({
        source: 'cli',
        area: 'apply',
        action: updatePreview.previewId,
        positionals: ['apply', updatePreview.previewId],
        options: {
          approve: true,
          approvalFile: updatePreview.approvalArtifact.filePath,
          featureFlags: { enableGitHub: true, enableGitHubWrites: true },
          fetchImpl: async (url, init = {}) => {
            const parsed = new URL(url);
            assert.strictEqual(String(init.method || 'GET').toUpperCase(), 'PATCH');
            assert.strictEqual(parsed.pathname, '/repos/example/project/hooks/9001');
            const body = JSON.parse(String(init.body || '{}'));
            assert.deepStrictEqual(body.events, ['workflow_run', 'pull_request_review']);
            assert.strictEqual(body.active, false);
            assert.strictEqual(body.config.url, 'https://assistant.example.com/github/webhook');
            assert.ok(!Object.prototype.hasOwnProperty.call(body.config, 'secret'));
            return createJsonResponse(200, buildWebhookResponse({
              active: false,
              events: body.events,
            }), {}, url);
          },
        },
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        executionPreferences: { approvalMode: 'prompt', dryRunDefault: false },
      });

      assert.strictEqual(updateApply.success, true);
      assert.strictEqual(updateApply.result.type, 'webhook-update');
      assert.strictEqual(updateApply.result.webhookId, 9001);
      assert.strictEqual(updateApply.result.webhook.active, false);
      assert.deepStrictEqual(updateApply.result.webhook.events, ['workflow_run', 'pull_request_review']);

      const pingPreview = await executor.execute({
        source: 'cli',
        area: 'webhook',
        action: 'ping',
        positionals: ['webhook', 'ping', 'draft', '9001'],
        options: {
          slug: 'example/project',
          featureFlags: { enableGitHub: true, enableGitHubWrites: true },
        },
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        executionPreferences: { approvalMode: 'prompt', dryRunDefault: false },
      });

      assert.strictEqual(pingPreview.success, true);
      assert.strictEqual(pingPreview.schemaVersion, 'github.webhook-ping-draft.v1');
      assert.strictEqual(pingPreview.draft.webhookId, 9001);

      const pingApply = await executor.execute({
        source: 'cli',
        area: 'apply',
        action: pingPreview.previewId,
        positionals: ['apply', pingPreview.previewId],
        options: {
          approve: true,
          approvalFile: pingPreview.approvalArtifact.filePath,
          featureFlags: { enableGitHub: true, enableGitHubWrites: true },
          fetchImpl: async (url, init = {}) => {
            const parsed = new URL(url);
            assert.strictEqual(String(init.method || 'GET').toUpperCase(), 'POST');
            assert.strictEqual(parsed.pathname, '/repos/example/project/hooks/9001/pings');
            assert.deepStrictEqual(JSON.parse(String(init.body || '{}')), {});
            return createJsonResponse(204, undefined, {}, url);
          },
        },
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        executionPreferences: { approvalMode: 'prompt', dryRunDefault: false },
      });

      assert.strictEqual(pingApply.success, true);
      assert.strictEqual(pingApply.result.type, 'webhook-ping');
      assert.strictEqual(pingApply.result.webhookId, 9001);
      assert.strictEqual(pingApply.result.accepted, true);
    });

    await test('webhook create apply fails before network when the local secret env is missing', async () => {
      const executor = createExecutor();
      let fetchCalls = 0;
      const preview = await executor.execute({
        source: 'cli',
        area: 'webhook',
        action: 'create',
        positionals: ['webhook', 'create', 'draft'],
        options: {
          slug: 'example/project',
          events: 'push',
          'target-url': 'https://assistant.example.com/github/webhook',
          'secret-ref': 'repo:LIKU_WEBHOOK_SECRET',
          featureFlags: { enableGitHub: true, enableGitHubWrites: true },
        },
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        executionPreferences: { approvalMode: 'prompt', dryRunDefault: false },
      });

      const apply = await executor.execute({
        source: 'cli',
        area: 'apply',
        action: preview.previewId,
        positionals: ['apply', preview.previewId],
        options: {
          approve: true,
          approvalFile: preview.approvalArtifact.filePath,
          featureFlags: { enableGitHub: true, enableGitHubWrites: true },
          fetchImpl: async () => {
            fetchCalls += 1;
            throw new Error('fetch should not be called when the secret ref cannot be resolved');
          },
        },
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        executionPreferences: { approvalMode: 'prompt', dryRunDefault: false },
      });

      assert.strictEqual(apply.success, false);
      assert.strictEqual(apply.error, 'GITHUB_API_FAILURE');
      assert.ok(String(apply.message || '').includes('LIKU_WEBHOOK_SECRET'));
      assert.strictEqual(fetchCalls, 0);
      const resultArtifact = readGitHubWriteApplyResultArtifact({ previewId: preview.previewId });
      assert.strictEqual(resultArtifact.success, false);
      assert.strictEqual(resultArtifact.error.code, 'GITHUB_API_FAILURE');
    });

    console.log(`PASS github webhook preview/apply (${pass} assertions)`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error('FAIL github webhook preview/apply');
  console.error(error.stack || error.message);
  process.exit(1);
});
