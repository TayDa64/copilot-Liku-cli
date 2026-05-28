const { requestGitHubJson } = require('./client');
const { resolveGitHubRepoContext } = require('./context');
const { inspectGitHubPullRequest } = require('./pr-inspect');
const { inspectGitHubPullRequestStatus } = require('./pr-status');

const GITHUB_PR_FEEDBACK_SCHEMA_VERSION = 'github.pr-feedback.v1';
const DEFAULT_FEEDBACK_LIMIT = 10;
const MAX_FEEDBACK_LIMIT = 20;

function normalizeText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function normalizeLowerText(value) {
  const text = normalizeText(value);
  return text ? text.toLowerCase() : null;
}

function normalizePositiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeFeedbackLimit(value, fallback = DEFAULT_FEEDBACK_LIMIT) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.min(MAX_FEEDBACK_LIMIT, parsed));
}

function appendUniqueWarnings(target, warnings) {
  if (!Array.isArray(target) || !Array.isArray(warnings)) {
    return target;
  }

  warnings.forEach((warning) => {
    const text = String(warning || '').trim();
    if (text && !target.includes(text)) {
      target.push(text);
    }
  });

  return target;
}

function buildUsageMessage() {
  return 'Usage: liku github pr feedback [<number>] [--slug owner/repo] [--branch <name>] [--head <owner:branch>] [--state <open|closed|all>] [--limit <n>] [--api false]';
}

function parseTimestamp(value) {
  const timestamp = Date.parse(String(value || '').trim());
  return Number.isFinite(timestamp) ? timestamp : null;
}

function buildBodyPreviewText(value, maxChars = 220, maxLines = 4) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  const boundedLines = text
    .split(/\r?\n/)
    .slice(0, Math.max(1, maxLines));
  let preview = boundedLines.join('\n');

  if (preview.length > maxChars) {
    preview = `${preview.slice(0, Math.max(1, maxChars - 1))}…`;
  } else if (boundedLines.length < text.split(/\r?\n/).length) {
    preview = `${preview}…`;
  }

  return preview;
}

function summarizeAuthor(user) {
  if (!user || typeof user !== 'object') {
    return null;
  }

  return {
    login: user.login || null,
    type: user.type || null,
    htmlUrl: user.html_url || null,
  };
}

function summarizeConversationComment(comment = {}) {
  const createdAt = comment.created_at || null;
  const updatedAt = comment.updated_at || createdAt;

  return {
    type: 'conversation-comment',
    id: normalizePositiveInteger(comment.id),
    htmlUrl: comment.html_url || null,
    createdAt,
    updatedAt,
    activityAt: updatedAt || createdAt || null,
    bodyPreview: buildBodyPreviewText(comment.body),
    author: summarizeAuthor(comment.user),
    authorAssociation: comment.author_association || null,
  };
}

function summarizeReview(review = {}) {
  const submittedAt = review.submitted_at || review.created_at || null;

  return {
    type: 'review',
    id: normalizePositiveInteger(review.id),
    htmlUrl: review.html_url || null,
    state: normalizeLowerText(review.state),
    submittedAt,
    activityAt: submittedAt || null,
    commitId: review.commit_id || null,
    bodyPreview: buildBodyPreviewText(review.body),
    author: summarizeAuthor(review.user),
    authorAssociation: review.author_association || null,
  };
}

function summarizeReviewComment(comment = {}) {
  const createdAt = comment.created_at || null;
  const updatedAt = comment.updated_at || createdAt;
  const line = normalizePositiveInteger(comment.line)
    || normalizePositiveInteger(comment.original_line)
    || normalizePositiveInteger(comment.position);
  const startLine = normalizePositiveInteger(comment.start_line)
    || normalizePositiveInteger(comment.original_start_line);

  return {
    type: 'review-comment',
    id: normalizePositiveInteger(comment.id),
    htmlUrl: comment.html_url || null,
    createdAt,
    updatedAt,
    activityAt: updatedAt || createdAt || null,
    bodyPreview: buildBodyPreviewText(comment.body),
    author: summarizeAuthor(comment.user),
    authorAssociation: comment.author_association || null,
    path: comment.path || null,
    line,
    startLine,
    side: normalizeLowerText(comment.side),
    startSide: normalizeLowerText(comment.start_side),
    commitId: comment.commit_id || comment.original_commit_id || null,
    inReplyToId: normalizePositiveInteger(comment.in_reply_to_id),
  };
}

function compareEntriesByActivity(left, right) {
  return (parseTimestamp(right?.activityAt) || 0) - (parseTimestamp(left?.activityAt) || 0);
}

function summarizeFeedbackParticipants(...collections) {
  const seen = new Set();
  const participants = [];

  collections.forEach((entries) => {
    if (!Array.isArray(entries)) {
      return;
    }

    entries.forEach((entry) => {
      const login = normalizeText(entry?.author?.login);
      if (login && !seen.has(login)) {
        seen.add(login);
        participants.push(login);
      }
    });
  });

  return participants.sort((left, right) => left.localeCompare(right));
}

function summarizeLatestActivity(...collections) {
  let latest = null;
  let latestTimestamp = null;

  collections.forEach((entries) => {
    if (!Array.isArray(entries)) {
      return;
    }

    entries.forEach((entry) => {
      const timestamp = parseTimestamp(entry?.activityAt);
      if (timestamp !== null && (latestTimestamp === null || timestamp > latestTimestamp)) {
        latestTimestamp = timestamp;
        latest = entry.activityAt;
      }
    });
  });

  return latest;
}

function buildFeedbackSummary(limit, conversationComments, reviews, reviewComments) {
  const participants = summarizeFeedbackParticipants(conversationComments, reviews, reviewComments);

  return {
    limit,
    surfaceCount: 3,
    conversationCommentCount: Array.isArray(conversationComments) ? conversationComments.length : 0,
    reviewCount: Array.isArray(reviews) ? reviews.length : 0,
    reviewCommentCount: Array.isArray(reviewComments) ? reviewComments.length : 0,
    totalCount: (Array.isArray(conversationComments) ? conversationComments.length : 0)
      + (Array.isArray(reviews) ? reviews.length : 0)
      + (Array.isArray(reviewComments) ? reviewComments.length : 0),
    participants,
    participantCount: participants.length,
    latestActivityAt: summarizeLatestActivity(conversationComments, reviews, reviewComments),
  };
}

function buildSurfaceApiReport(response = {}, resultCount = 0) {
  return {
    attempted: true,
    status: response.status ?? null,
    error: response.ok ? null : (response.error || response.data?.message || `GitHub request failed (${response.status ?? 0})`),
    rateLimit: response.rateLimit || null,
    resultCount,
  };
}

async function fetchFeedbackSurface(options = {}) {
  const requestImpl = typeof options.requestGitHubJson === 'function'
    ? options.requestGitHubJson
    : requestGitHubJson;
  const response = await requestImpl({
    apiPath: options.apiPath,
    apiBaseUrl: options.apiBaseUrl,
    token: options.token,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  if (!response.ok || !Array.isArray(response.data)) {
    return {
      entries: [],
      githubApi: buildSurfaceApiReport(response, 0),
    };
  }

  const entries = response.data
    .slice(0, Math.max(1, options.limit || DEFAULT_FEEDBACK_LIMIT))
    .map((entry) => options.summarizeEntry(entry))
    .sort(compareEntriesByActivity);

  return {
    entries,
    githubApi: buildSurfaceApiReport(response, entries.length),
  };
}

function buildBaseReport(options = {}, context = {}) {
  const limit = normalizeFeedbackLimit(options.limit, DEFAULT_FEEDBACK_LIMIT);

  return {
    schemaVersion: GITHUB_PR_FEEDBACK_SCHEMA_VERSION,
    success: true,
    featureFlagEnabled: options.featureFlagEnabled === true,
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: context.target,
    targetSource: context.targetSource,
    pullRequestNumber: null,
    branchContext: null,
    filters: {
      limit,
      state: normalizeText(options.state) || 'open',
      branch: normalizeText(options.branch),
      head: normalizeText(options.head),
    },
    lookup: {
      mode: 'branch-associated',
      status: 'pending',
      headQuery: null,
      matchedCount: 0,
      selectedPullRequestNumber: null,
    },
    pullRequest: null,
    pullRequests: [],
    feedbackSummary: buildFeedbackSummary(limit, [], [], []),
    conversationComments: [],
    reviews: [],
    reviewComments: [],
    githubApi: {
      ...context.githubApi,
      attempted: false,
      status: null,
      error: null,
      rateLimit: null,
      pullRequestLookup: {
        attempted: false,
        status: null,
        error: null,
        rateLimit: null,
      },
      conversationComments: {
        attempted: false,
        status: null,
        error: null,
        rateLimit: null,
        resultCount: 0,
      },
      reviews: {
        attempted: false,
        status: null,
        error: null,
        rateLimit: null,
        resultCount: 0,
      },
      reviewComments: {
        attempted: false,
        status: null,
        error: null,
        rateLimit: null,
        resultCount: 0,
      },
    },
    warnings: Array.isArray(context.warnings) ? context.warnings.slice() : [],
  };
}

async function resolveFeedbackPullRequest(options = {}, context = {}, report = {}) {
  const explicitNumberText = normalizeText(options.number || options.pullRequestNumber || options.pr);
  const explicitNumber = explicitNumberText ? normalizePositiveInteger(explicitNumberText) : null;
  const allowApi = options.api !== false;
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const statusImpl = typeof options.inspectGitHubPullRequestStatus === 'function'
    ? options.inspectGitHubPullRequestStatus
    : inspectGitHubPullRequestStatus;
  const inspectImpl = typeof options.inspectGitHubPullRequest === 'function'
    ? options.inspectGitHubPullRequest
    : inspectGitHubPullRequest;

  if (explicitNumberText && !explicitNumber) {
    return {
      success: false,
      error: 'USAGE',
      message: buildUsageMessage(),
    };
  }

  if (!explicitNumber) {
    const statusReport = await statusImpl({
      ...options,
      cwd,
      env,
      featureFlagEnabled: options.featureFlagEnabled === true,
      api: allowApi,
      slug: context.target.slug,
      branch: options.branch,
      head: options.head,
      state: options.state,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });

    if (statusReport.success === false) {
      return statusReport;
    }

    report.repoIdentity = statusReport.repoIdentity || report.repoIdentity;
    report.remote = statusReport.remote || report.remote;
    report.target = statusReport.target || report.target;
    report.targetSource = statusReport.targetSource || report.targetSource;
    report.branchContext = statusReport.branchContext || null;
    report.pullRequest = statusReport.pullRequest || null;
    report.pullRequests = Array.isArray(statusReport.pullRequests) ? statusReport.pullRequests.slice() : [];
    report.pullRequestNumber = statusReport.pullRequest?.number || statusReport.lookup?.selectedPullRequestNumber || null;
    report.filters = {
      ...report.filters,
      state: statusReport.filters?.state || report.filters.state,
      branch: statusReport.branchContext?.currentBranch || report.filters.branch,
      head: statusReport.lookup?.headQuery || report.filters.head,
    };
    report.lookup = {
      mode: 'branch-associated',
      status: statusReport.lookup?.status || 'unavailable',
      headQuery: statusReport.lookup?.headQuery || null,
      matchedCount: statusReport.lookup?.matchedCount ?? 0,
      selectedPullRequestNumber: statusReport.lookup?.selectedPullRequestNumber || null,
    };
    report.githubApi.attempted = statusReport.githubApi?.attempted === true;
    report.githubApi.status = statusReport.githubApi?.inspectStatus ?? statusReport.githubApi?.status ?? null;
    report.githubApi.error = statusReport.githubApi?.inspectError || statusReport.githubApi?.error || null;
    report.githubApi.rateLimit = statusReport.githubApi?.inspectRateLimit || statusReport.githubApi?.rateLimit || null;
    report.githubApi.pullRequestLookup = {
      attempted: statusReport.githubApi?.attempted === true,
      status: statusReport.githubApi?.inspectStatus ?? statusReport.githubApi?.status ?? null,
      error: statusReport.githubApi?.inspectError || statusReport.githubApi?.error || null,
      rateLimit: statusReport.githubApi?.inspectRateLimit || statusReport.githubApi?.rateLimit || null,
    };
    appendUniqueWarnings(report.warnings, statusReport.warnings);
    return report;
  }

  report.lookup = {
    mode: 'explicit-number',
    status: allowApi ? 'pending' : 'unavailable',
    headQuery: null,
    matchedCount: allowApi ? 1 : 0,
    selectedPullRequestNumber: explicitNumber,
  };
  report.pullRequestNumber = explicitNumber;
  report.filters = {
    ...report.filters,
    state: null,
    branch: null,
    head: null,
  };

  if (!allowApi) {
    report.warnings.push('GitHub pull request feedback lookup skipped by request.');
    return report;
  }

  const inspectReport = await inspectImpl({
    ...options,
    cwd,
    env,
    featureFlagEnabled: options.featureFlagEnabled === true,
    api: true,
    slug: context.target.slug,
    number: explicitNumber,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  if (inspectReport.success === false) {
    return inspectReport;
  }

  report.repoIdentity = inspectReport.repoIdentity || report.repoIdentity;
  report.remote = inspectReport.remote || report.remote;
  report.target = inspectReport.target || report.target;
  report.targetSource = inspectReport.targetSource || report.targetSource;
  report.pullRequest = inspectReport.pullRequest || null;
  report.githubApi.attempted = inspectReport.githubApi?.attempted === true;
  report.githubApi.status = inspectReport.githubApi?.status ?? null;
  report.githubApi.error = inspectReport.githubApi?.error || null;
  report.githubApi.rateLimit = inspectReport.githubApi?.rateLimit || null;
  report.githubApi.pullRequestLookup = {
    attempted: inspectReport.githubApi?.attempted === true,
    status: inspectReport.githubApi?.status ?? null,
    error: inspectReport.githubApi?.error || null,
    rateLimit: inspectReport.githubApi?.rateLimit || null,
  };
  report.lookup = {
    ...report.lookup,
    status: inspectReport.pullRequest
      ? 'matched'
      : (inspectReport.githubApi?.status === 404 ? 'not-found' : (inspectReport.githubApi?.error ? 'api-error' : 'unavailable')),
    matchedCount: inspectReport.pullRequest ? 1 : 0,
  };
  appendUniqueWarnings(report.warnings, inspectReport.warnings);
  return report;
}

async function inspectGitHubPullRequestFeedback(options = {}) {
  const cwd = options.cwd || process.cwd();
  const context = resolveGitHubRepoContext({ ...options, cwd });
  const report = buildBaseReport(options, context);

  if (!context.target.raw) {
    report.lookup.status = 'unavailable';
    report.warnings.push('No git remote detected; pull request feedback needs a GitHub repository target.');
    return report;
  }

  if (!context.target.isGitHub || !context.target.slug) {
    report.lookup.status = 'unavailable';
    report.warnings.push('Detected target is not a GitHub repository; pull request feedback was skipped.');
    return report;
  }

  const resolvedReport = await resolveFeedbackPullRequest({ ...options, cwd }, context, report);
  if (resolvedReport?.success === false) {
    return {
      ...report,
      success: false,
      error: resolvedReport.error,
      message: resolvedReport.message,
      warnings: appendUniqueWarnings(report.warnings.slice(), resolvedReport.warnings),
    };
  }

  const feedbackReport = resolvedReport;
  if (feedbackReport.lookup?.status !== 'matched' || !feedbackReport.pullRequestNumber || options.api === false) {
    feedbackReport.feedbackSummary = buildFeedbackSummary(
      feedbackReport.filters.limit,
      feedbackReport.conversationComments,
      feedbackReport.reviews,
      feedbackReport.reviewComments
    );
    return feedbackReport;
  }

  const requestImpl = typeof options.requestGitHubJson === 'function'
    ? options.requestGitHubJson
    : requestGitHubJson;
  const limit = feedbackReport.filters.limit;
  const apiBaseUrl = feedbackReport.target?.apiBaseUrl || 'https://api.github.com';
  const token = context.tokenInfo?.token || '';
  const owner = feedbackReport.target?.owner || context.target.owner;
  const repo = feedbackReport.target?.repo || context.target.repo;
  const pullRequestNumber = feedbackReport.pullRequest?.number || feedbackReport.pullRequestNumber;

  const [conversationComments, reviews, reviewComments] = await Promise.all([
    fetchFeedbackSurface({
      apiPath: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${pullRequestNumber}/comments?per_page=${limit}`,
      apiBaseUrl,
      token,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      requestGitHubJson: requestImpl,
      summarizeEntry: summarizeConversationComment,
      limit,
    }),
    fetchFeedbackSurface({
      apiPath: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullRequestNumber}/reviews?per_page=${limit}`,
      apiBaseUrl,
      token,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      requestGitHubJson: requestImpl,
      summarizeEntry: summarizeReview,
      limit,
    }),
    fetchFeedbackSurface({
      apiPath: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullRequestNumber}/comments?per_page=${limit}`,
      apiBaseUrl,
      token,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      requestGitHubJson: requestImpl,
      summarizeEntry: summarizeReviewComment,
      limit,
    }),
  ]);

  feedbackReport.conversationComments = conversationComments.entries;
  feedbackReport.reviews = reviews.entries;
  feedbackReport.reviewComments = reviewComments.entries;
  feedbackReport.feedbackSummary = buildFeedbackSummary(limit, conversationComments.entries, reviews.entries, reviewComments.entries);
  feedbackReport.githubApi.attempted = feedbackReport.githubApi.attempted
    || conversationComments.githubApi.attempted
    || reviews.githubApi.attempted
    || reviewComments.githubApi.attempted;
  feedbackReport.githubApi.conversationComments = conversationComments.githubApi;
  feedbackReport.githubApi.reviews = reviews.githubApi;
  feedbackReport.githubApi.reviewComments = reviewComments.githubApi;

  appendUniqueWarnings(feedbackReport.warnings, conversationComments.githubApi.error
    ? [`GitHub pull request conversation comments could not be listed (${conversationComments.githubApi.error}).`]
    : []);
  appendUniqueWarnings(feedbackReport.warnings, reviews.githubApi.error
    ? [`GitHub pull request reviews could not be listed (${reviews.githubApi.error}).`]
    : []);
  appendUniqueWarnings(feedbackReport.warnings, reviewComments.githubApi.error
    ? [`GitHub pull request review comments could not be listed (${reviewComments.githubApi.error}).`]
    : []);

  return feedbackReport;
}

module.exports = {
  DEFAULT_FEEDBACK_LIMIT,
  GITHUB_PR_FEEDBACK_SCHEMA_VERSION,
  MAX_FEEDBACK_LIMIT,
  buildUsageMessage,
  inspectGitHubPullRequestFeedback,
  normalizeFeedbackLimit,
  summarizeConversationComment,
  summarizeReview,
  summarizeReviewComment,
};
