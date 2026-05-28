#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  GITHUB_PR_FEEDBACK_SCHEMA_VERSION,
  inspectGitHubPullRequestFeedback,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'pr-feedback.js'));

const repoRoot = path.join(__dirname, '..');

function createHeaders(values = {}) {
  const normalized = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [String(key).toLowerCase(), value])
  );
  return {
    get(name) {
      return normalized[String(name || '').toLowerCase()] || null;
    },
  };
}

function createJsonResponse(status, body, headers = {}) {
  const text = body === undefined || body === null ? '' : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    url: 'https://api.github.com/mock',
    headers: createHeaders(headers),
    async text() {
      return text;
    },
  };
}

function createSharedRepoContext() {
  return {
    repoIdentity: {
      repoName: 'owner/repo',
      normalizedRepoName: 'repo',
      projectRoot: repoRoot,
      gitRemote: 'https://github.com/owner/repo.git',
    },
    remote: {
      url: 'https://github.com/owner/repo.git',
      isGitHub: true,
      owner: 'owner',
      repo: 'repo',
    },
    target: {
      raw: 'https://github.com/owner/repo.git',
      slug: 'owner/repo',
      owner: 'owner',
      repo: 'repo',
      htmlUrl: 'https://github.com/owner/repo',
      apiBaseUrl: 'https://api.github.com',
      isGitHub: true,
    },
    targetSource: 'explicit-slug',
  };
}

function createExplicitPullRequestInspectReport(number) {
  const shared = createSharedRepoContext();
  return {
    success: true,
    schemaVersion: 'github.pr-inspect.v1',
    repoIdentity: shared.repoIdentity,
    remote: shared.remote,
    target: shared.target,
    targetSource: shared.targetSource,
    pullRequestNumber: number,
    pullRequest: {
      number,
      title: 'Improve pull request feedback summaries',
      state: 'open',
      draft: false,
      merged: false,
      author: { login: 'maintainer' },
      head: { ref: 'feature/demo' },
      base: { ref: 'main' },
      updatedAt: '2026-05-03T12:00:00Z',
      htmlUrl: `https://github.com/owner/repo/pull/${number}`,
    },
    githubApi: {
      attempted: true,
      status: 200,
      error: null,
      rateLimit: {
        limit: 5000,
        remaining: 4998,
      },
    },
    warnings: [],
  };
}

let pass = 0;

async function test(name, fn) {
  await fn();
  pass += 1;
  console.log(`PASS ${name}`);
}

(async () => {
  await test('explicit pull request feedback summarizes conversation comments, reviews, and review comments', async () => {
    const fetchCalls = [];
    const report = await inspectGitHubPullRequestFeedback({
      cwd: repoRoot,
      env: {},
      featureFlagEnabled: true,
      api: true,
      slug: 'owner/repo',
      number: '7',
      limit: '2',
      inspectGitHubPullRequest: async () => createExplicitPullRequestInspectReport(7),
      fetchImpl: async (url) => {
        fetchCalls.push(url);
        if (url.includes('/issues/7/comments?per_page=2')) {
          return createJsonResponse(200, [
            {
              id: 101,
              html_url: 'https://github.com/owner/repo/pull/7#issuecomment-101',
              body: 'Please add one more assertion before merging.',
              created_at: '2026-05-03T10:00:00Z',
              updated_at: '2026-05-03T10:05:00Z',
              author_association: 'MEMBER',
              user: { login: 'reviewer-one', type: 'User', html_url: 'https://github.com/reviewer-one' },
            },
            {
              id: 102,
              html_url: 'https://github.com/owner/repo/pull/7#issuecomment-102',
              body: 'Looks good after the latest change.',
              created_at: '2026-05-03T11:00:00Z',
              updated_at: '2026-05-03T11:10:00Z',
              author_association: 'MEMBER',
              user: { login: 'reviewer-two', type: 'User', html_url: 'https://github.com/reviewer-two' },
            },
          ]);
        }
        if (url.includes('/pulls/7/reviews?per_page=2')) {
          return createJsonResponse(200, [
            {
              id: 201,
              html_url: 'https://github.com/owner/repo/pull/7#pullrequestreview-201',
              state: 'COMMENTED',
              body: 'I left one comment inline.',
              submitted_at: '2026-05-03T09:30:00Z',
              commit_id: 'abc123',
              author_association: 'MEMBER',
              user: { login: 'reviewer-one', type: 'User', html_url: 'https://github.com/reviewer-one' },
            },
            {
              id: 202,
              html_url: 'https://github.com/owner/repo/pull/7#pullrequestreview-202',
              state: 'APPROVED',
              body: 'Approved after the follow-up.',
              submitted_at: '2026-05-03T11:15:00Z',
              commit_id: 'def456',
              author_association: 'MEMBER',
              user: { login: 'reviewer-two', type: 'User', html_url: 'https://github.com/reviewer-two' },
            },
          ]);
        }
        if (url.includes('/pulls/7/comments?per_page=2')) {
          return createJsonResponse(200, [
            {
              id: 301,
              html_url: 'https://github.com/owner/repo/pull/7#discussion_r301',
              body: 'Could you tighten this conditional?',
              path: 'src/main/github/pr-feedback.js',
              line: 55,
              side: 'RIGHT',
              created_at: '2026-05-03T09:45:00Z',
              updated_at: '2026-05-03T09:50:00Z',
              author_association: 'MEMBER',
              commit_id: 'abc123',
              user: { login: 'reviewer-one', type: 'User', html_url: 'https://github.com/reviewer-one' },
            },
            {
              id: 302,
              html_url: 'https://github.com/owner/repo/pull/7#discussion_r302',
              body: 'Thanks, this reads much more clearly now.',
              path: 'src/cli/commands/github.js',
              line: 420,
              side: 'RIGHT',
              created_at: '2026-05-03T11:12:00Z',
              updated_at: '2026-05-03T11:16:00Z',
              author_association: 'MEMBER',
              commit_id: 'def456',
              user: { login: 'reviewer-two', type: 'User', html_url: 'https://github.com/reviewer-two' },
            },
          ]);
        }
        throw new Error(`Unexpected GitHub URL: ${url}`);
      },
    });

    assert.strictEqual(report.schemaVersion, GITHUB_PR_FEEDBACK_SCHEMA_VERSION);
    assert.strictEqual(report.success, true);
    assert.strictEqual(report.lookup.mode, 'explicit-number');
    assert.strictEqual(report.lookup.status, 'matched');
    assert.strictEqual(report.pullRequestNumber, 7);
    assert.strictEqual(report.feedbackSummary.limit, 2);
    assert.strictEqual(report.feedbackSummary.conversationCommentCount, 2);
    assert.strictEqual(report.feedbackSummary.reviewCount, 2);
    assert.strictEqual(report.feedbackSummary.reviewCommentCount, 2);
    assert.strictEqual(report.feedbackSummary.totalCount, 6);
    assert.deepStrictEqual(report.feedbackSummary.participants, ['reviewer-one', 'reviewer-two']);
    assert.strictEqual(report.feedbackSummary.participantCount, 2);
    assert.strictEqual(report.feedbackSummary.latestActivityAt, '2026-05-03T11:16:00Z');
    assert.strictEqual(report.conversationComments[0].author.login, 'reviewer-two');
    assert.strictEqual(report.reviews[0].state, 'approved');
    assert.strictEqual(report.reviewComments[0].path, 'src/cli/commands/github.js');
    assert.strictEqual(report.reviewComments[0].line, 420);
    assert.strictEqual(report.githubApi.conversationComments.resultCount, 2);
    assert.strictEqual(report.githubApi.reviews.resultCount, 2);
    assert.strictEqual(report.githubApi.reviewComments.resultCount, 2);
    assert.strictEqual(fetchCalls.length, 3);
  });

  await test('branch-associated feedback reuses the pr status lookup seam', async () => {
    let statusInput = null;
    const fetchCalls = [];
    const shared = createSharedRepoContext();
    const report = await inspectGitHubPullRequestFeedback({
      cwd: repoRoot,
      env: {},
      featureFlagEnabled: true,
      api: true,
      slug: 'owner/repo',
      branch: 'feature/demo',
      limit: '3',
      inspectGitHubPullRequestStatus: async (input) => {
        statusInput = input;
        return {
          success: true,
          schemaVersion: 'github.pr-status.v1',
          repoIdentity: shared.repoIdentity,
          remote: shared.remote,
          target: shared.target,
          targetSource: shared.targetSource,
          branchContext: {
            currentBranch: 'feature/demo',
            source: 'explicit-branch',
            detached: false,
          },
          filters: {
            state: 'open',
            branch: 'feature/demo',
            head: 'owner:feature/demo',
          },
          lookup: {
            status: 'matched',
            headQuery: 'owner:feature/demo',
            matchedCount: 1,
            selectedPullRequestNumber: 12,
          },
          pullRequest: {
            number: 12,
            title: 'Feature demo follow-up',
            state: 'open',
            draft: false,
            merged: false,
            author: { login: 'maintainer' },
            head: { ref: 'feature/demo' },
            base: { ref: 'main' },
            updatedAt: '2026-05-04T08:00:00Z',
          },
          githubApi: {
            attempted: true,
            status: 200,
            error: null,
            rateLimit: null,
            inspectStatus: 200,
            inspectError: null,
            inspectRateLimit: null,
          },
          warnings: [],
        };
      },
      fetchImpl: async (url) => {
        fetchCalls.push(url);
        return createJsonResponse(200, []);
      },
    });

    assert.ok(statusInput);
    assert.strictEqual(statusInput.branch, 'feature/demo');
    assert.strictEqual(statusInput.api, true);
    assert.strictEqual(report.lookup.mode, 'branch-associated');
    assert.strictEqual(report.lookup.status, 'matched');
    assert.strictEqual(report.branchContext.currentBranch, 'feature/demo');
    assert.strictEqual(report.pullRequestNumber, 12);
    assert.strictEqual(report.feedbackSummary.limit, 3);
    assert.strictEqual(report.feedbackSummary.totalCount, 0);
    assert.strictEqual(fetchCalls.length, 3);
    assert.ok(fetchCalls.every((url) => url.includes('/12/')));
  });

  await test('branch-associated not-found lookup returns a stable empty feedback report', async () => {
    let fetchCalled = false;
    const shared = createSharedRepoContext();
    const report = await inspectGitHubPullRequestFeedback({
      cwd: repoRoot,
      env: {},
      featureFlagEnabled: true,
      api: true,
      slug: 'owner/repo',
      branch: 'feature/missing',
      inspectGitHubPullRequestStatus: async () => ({
        success: true,
        schemaVersion: 'github.pr-status.v1',
        repoIdentity: shared.repoIdentity,
        remote: shared.remote,
        target: shared.target,
        targetSource: shared.targetSource,
        branchContext: {
          currentBranch: 'feature/missing',
          source: 'explicit-branch',
          detached: false,
        },
        filters: {
          state: 'open',
          branch: 'feature/missing',
          head: 'owner:feature/missing',
        },
        lookup: {
          status: 'not-found',
          headQuery: 'owner:feature/missing',
          matchedCount: 0,
          selectedPullRequestNumber: null,
        },
        pullRequest: null,
        pullRequests: [],
        githubApi: {
          attempted: true,
          status: 200,
          error: null,
          rateLimit: null,
        },
        warnings: [],
      }),
      fetchImpl: async () => {
        fetchCalled = true;
        throw new Error('Feedback fetch should not be attempted for not-found lookups.');
      },
    });

    assert.strictEqual(report.success, true);
    assert.strictEqual(report.lookup.mode, 'branch-associated');
    assert.strictEqual(report.lookup.status, 'not-found');
    assert.strictEqual(report.pullRequest, null);
    assert.strictEqual(report.feedbackSummary.totalCount, 0);
    assert.strictEqual(fetchCalled, false);
  });

  await test('explicit-number feedback honors --api false without invoking inspect or fetch', async () => {
    let inspectCalled = false;
    let fetchCalled = false;
    const report = await inspectGitHubPullRequestFeedback({
      cwd: repoRoot,
      env: {},
      featureFlagEnabled: true,
      api: false,
      slug: 'owner/repo',
      number: '9',
      inspectGitHubPullRequest: async () => {
        inspectCalled = true;
        return createExplicitPullRequestInspectReport(9);
      },
      fetchImpl: async () => {
        fetchCalled = true;
        return createJsonResponse(200, []);
      },
    });

    assert.strictEqual(report.success, true);
    assert.strictEqual(report.lookup.mode, 'explicit-number');
    assert.strictEqual(report.lookup.status, 'unavailable');
    assert.strictEqual(report.pullRequestNumber, 9);
    assert.strictEqual(report.githubApi.attempted, false);
    assert.strictEqual(report.feedbackSummary.totalCount, 0);
    assert.ok(report.warnings.includes('GitHub pull request feedback lookup skipped by request.'));
    assert.strictEqual(inspectCalled, false);
    assert.strictEqual(fetchCalled, false);
  });

  console.log(`PASS github pr feedback (${pass} assertions)`);
})().catch((error) => {
  console.error('FAIL github pr feedback');
  console.error(error.stack || error.message);
  process.exit(1);
});
