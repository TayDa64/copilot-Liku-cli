#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  buildConversationHistoryEntry,
  sanitizeJsonLinesForExport,
  sanitizePersistedText,
  sanitizePersistedValue
} = require(path.join(__dirname, '..', 'src', 'main', 'persistence-controls.js'));

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

test('sanitizePersistedValue redacts issue bodies, diffs, workflow logs, and secrets', () => {
  const input = {
    body: 'This is a very detailed GitHub issue body that should not persist verbatim.',
    diff: 'diff --git a/src/app.js b/src/app.js\n@@ -1,2 +1,2 @@\n-console.log("old")\n+console.log("new")',
    patchPreview: '@@ -1 +1 @@\n-old\n+new',
    workflowLog: '##[group]Run npm test\nCurrent runner version: 2.319.1\n##[error] boom',
    authorization: 'Bearer github_pat_abcdefghijklmnopqrstuvwxyz1234567890'
  };

  const sanitized = sanitizePersistedValue(input, { path: ['root'] });
  assert.ok(sanitized.value.body.includes('[redacted issue body'));
  assert.ok(sanitized.value.diff.includes('[redacted diff'));
  assert.ok(sanitized.value.patchPreview.includes('[redacted diff'));
  assert.ok(sanitized.value.workflowLog.includes('[redacted workflow log'));
  assert.ok(sanitized.value.authorization.includes('[redacted secret'));
  const kinds = new Set(sanitized.redactions.map((entry) => entry.kind));
  assert.ok(kinds.has('issue-body'));
  assert.ok(kinds.has('diff'));
  assert.ok(kinds.has('workflow-log'));
  assert.ok(kinds.has('secret'));
});

test('sanitizePersistedText redacts inline tokens and diff-like blocks', () => {
  const tokenText = sanitizePersistedText('Authorization: Bearer ghp_1234567890abcdefghijklmnop');
  assert.ok(tokenText.value.includes('[redacted token]'));

  const diffText = sanitizePersistedText('```diff\n--- a/file.js\n+++ b/file.js\n@@ -1 +1 @@\n-old\n+new\n```');
  assert.ok(diffText.value.includes('[redacted diff'));
});

test('sanitizeJsonLinesForExport preserves JSONL while redacting sensitive payloads', () => {
  const raw = [
    JSON.stringify({
      event: 'workflow',
      body: 'A private issue body',
      stdout: '##[group]Run npm test\n##[error] fail',
      token: 'github_pat_abcdefghijklmnopqrstuvwxyz1234567890'
    }),
    'Authorization: Bearer ghp_1234567890abcdefghijklmnop'
  ].join('\n');

  const exported = sanitizeJsonLinesForExport(raw, { exportKind: 'runtime-trace' });
  const lines = exported.text.trim().split(/\r?\n/);
  assert.strictEqual(lines.length, 2);
  const firstLine = JSON.parse(lines[0]);
  assert.ok(firstLine.body.includes('[redacted issue body'));
  assert.ok(firstLine.stdout.includes('[redacted workflow log'));
  assert.ok(firstLine.token.includes('[redacted token]'));
  assert.ok(lines[1].includes('[redacted token]'));
  assert.strictEqual(exported.review.exportKind, 'runtime-trace');
  assert.ok(exported.review.reviewRecommended);
  assert.ok(exported.review.redactionCount >= 3);
});

test('buildConversationHistoryEntry adds task retention metadata', () => {
  const entry = buildConversationHistoryEntry({
    role: 'user',
    content: 'Remember api_key=super-secret but do not persist the secret value.'
  });

  assert.strictEqual(entry.persistence.store, 'conversation-history');
  assert.strictEqual(entry.persistence.lane, 'task');
  assert.ok(entry.persistence.retention.expiresAt);
  assert.ok(entry.content.includes('[redacted secret]'));
});
