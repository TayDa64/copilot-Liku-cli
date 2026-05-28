#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-github-event-runtime-'));
process.env.LIKU_HOME_OVERRIDE = path.join(tempRoot, '.liku');
process.env.LIKU_HOME_OLD_OVERRIDE = path.join(tempRoot, '.liku-cli-old');
process.env.LIKU_ENABLE_GITHUB = '1';

const { inspectGitHubEvent } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'event-inspect.js'));
const { listGitHubEvents } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'event-list.js'));
const { ingestGitHubWebhookEvent } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'webhook-event-runtime.js'));

let pass = 0;

async function test(name, fn) {
  await fn();
  pass += 1;
  console.log(`PASS ${name}`);
}

function createGitHubEnv() {
  return {
    LIKU_ENABLE_GITHUB: '1',
    LIKU_HOME_OVERRIDE: process.env.LIKU_HOME_OVERRIDE,
    LIKU_HOME_OLD_OVERRIDE: process.env.LIKU_HOME_OLD_OVERRIDE,
  };
}

(async () => {
  try {
    await test('event runtime ingestion persists a sanitized artifact and journal entry', async () => {
      const report = await ingestGitHubWebhookEvent({
        slug: 'owner/repo',
        eventName: 'pull_request',
        deliveryId: 'delivery-artifact-1',
        webhookId: 9001,
        headers: {
          'x-github-event': 'pull_request',
          authorization: 'Bearer ghp_secret_token_12345678901234567890',
          'x-hub-signature-256': 'sha256=abcdef123456',
        },
        payload: {
          action: 'opened',
          repository: { full_name: 'owner/repo' },
          sender: { login: 'octocat' },
          installation: { id: 7001 },
          number: 123,
          pull_request: {
            title: 'Add event journal foundation',
            body: 'Authorization: Bearer ghp_secret_token_12345678901234567890',
            state: 'open',
            merged: false,
          },
        },
      });

      assert.strictEqual(report.schemaVersion, 'github.event-runtime.v1');
      assert.strictEqual(report.success, true);
      assert.strictEqual(report.summary.eventName, 'pull_request');
      assert.strictEqual(report.summary.slug, 'owner/repo');
      assert.ok(report.artifact.filePath);
      assert.ok(fs.existsSync(report.artifact.filePath));

      const artifact = JSON.parse(fs.readFileSync(report.artifact.filePath, 'utf8'));
      assert.strictEqual(artifact.delivery.eventName, 'pull_request');
      assert.strictEqual(artifact.target.slug, 'owner/repo');
      assert.strictEqual(artifact.headers.authorization, '[redacted]');
      assert.strictEqual(artifact.headers['x-hub-signature-256'], '[redacted]');
      assert.ok(String(artifact.payload.pull_request.body).startsWith('[redacted issue body;'));
      assert.ok(!String(artifact.payload.pull_request.body).includes('ghp_secret_token_12345678901234567890'));
      assert.ok((artifact.review?.redactionCount || 0) >= 2);
    });

    await test('event list filters by repo and event name from the local journal', async () => {
      await ingestGitHubWebhookEvent({
        slug: 'owner/repo',
        eventName: 'push',
        deliveryId: 'delivery-list-1',
        headers: { 'x-github-event': 'push' },
        payload: {
          repository: { full_name: 'owner/repo' },
          sender: { login: 'octocat' },
          ref: 'refs/heads/main',
          after: 'abcdef1234567890',
          commits: [{ id: '1' }, { id: '2' }],
          head_commit: { message: 'Ship it' },
        },
      });

      await ingestGitHubWebhookEvent({
        slug: 'other/repo',
        eventName: 'workflow_run',
        deliveryId: 'delivery-list-2',
        headers: { 'x-github-event': 'workflow_run' },
        payload: {
          action: 'completed',
          repository: { full_name: 'other/repo' },
          workflow_run: { id: 44, name: 'CI', status: 'completed', conclusion: 'success', event: 'push' },
        },
      });

      const report = await listGitHubEvents({
        cwd: tempRoot,
        env: createGitHubEnv(),
        featureFlagEnabled: true,
        slug: 'owner/repo',
        limit: 10,
        event: 'push',
      });

      assert.strictEqual(report.schemaVersion, 'github.event-list.v1');
      assert.strictEqual(report.localOnly, true);
      assert.strictEqual(report.target.slug, 'owner/repo');
      assert.strictEqual(report.totalCount, 1);
      assert.strictEqual(report.events.length, 1);
      assert.strictEqual(report.events[0].eventName, 'push');
      assert.strictEqual(report.events[0].slug, 'owner/repo');
      assert.strictEqual(report.events[0].payloadPreview.commitCount, 2);
      assert.ok(report.eventLog.filePath.endsWith('github-events.jsonl'));
    });

    await test('event inspect returns the sanitized payload and review metadata', async () => {
      const ingested = await ingestGitHubWebhookEvent({
        slug: 'owner/repo',
        eventName: 'issues',
        deliveryId: 'delivery-inspect-1',
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

      const report = await inspectGitHubEvent({
        cwd: tempRoot,
        env: createGitHubEnv(),
        featureFlagEnabled: true,
        id: ingested.eventId,
        slug: 'owner/repo',
      });

      assert.strictEqual(report.schemaVersion, 'github.event-inspect.v1');
      assert.strictEqual(report.event.eventName, 'issues');
      assert.strictEqual(report.event.slug, 'owner/repo');
      assert.strictEqual(report.event.senderLogin, 'octocat');
      assert.ok(Array.isArray(report.event.payloadKeys));
      assert.strictEqual(report.event.headers['x-hub-signature-256'], '[redacted]');
      assert.ok(String(report.event.payload.issue.body).startsWith('[redacted issue body;'));
      assert.ok(!String(report.event.payload.issue.body).includes('ghp_secret_token_12345678901234567890'));
      assert.strictEqual(report.artifact.eventId, ingested.eventId);
      assert.ok(report.artifact.filePath);
      assert.ok(fs.existsSync(report.artifact.filePath));
    });

    console.log(`PASS github event runtime (${pass} assertions)`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
