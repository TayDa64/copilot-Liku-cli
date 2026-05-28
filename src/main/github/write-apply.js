const { getEnvGitHubToken, requestGitHubJson } = require('./client');
const { summarizeWebhook } = require('./governance-redaction');
const { summarizePullRequest } = require('./pr-inspect');
const { executeGitHubRepoContentPatchPreview } = require('./repo-content-patch-apply');
const {
  appendGitHubWriteEvent,
  readGitHubWriteApplyResultArtifact,
  readGitHubWriteApprovalArtifact,
  readGitHubWritePreviewArtifact,
  summarizeGitHubWriteApprovalArtifactRecord,
  summarizeGitHubWriteEventLog,
  summarizeGitHubWritePreviewArtifactRecord,
  writeGitHubWriteApplyResultArtifact,
  writeGitHubWriteApprovalArtifact,
} = require('./write-artifacts');

const GITHUB_WRITE_APPLY_SCHEMA_VERSION = 'github.write-apply.v1';

function parseBooleanOption(value) {
  if (value === true) return true;
  const normalized = String(value || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function buildUsageMessage() {
  return 'Usage: liku github apply <preview-id> --approve [--apply-token <token> | --approval-file <path>]';
}

function isExpired(timestamp) {
  const expiresAtMs = Date.parse(String(timestamp || '').trim());
  return Number.isFinite(expiresAtMs) && Date.now() >= expiresAtMs;
}

function summarizeIssueComment(comment) {
  if (!comment || typeof comment !== 'object') {
    return null;
  }

  return {
    id: Number.isFinite(Number(comment.id)) ? Number(comment.id) : null,
    nodeId: comment.node_id || null,
    htmlUrl: comment.html_url || null,
    createdAt: comment.created_at || null,
    updatedAt: comment.updated_at || null,
    bodyPreview: typeof comment.body === 'string'
      ? String(comment.body).trim().slice(0, 280)
      : null,
    author: comment.user
      ? {
          login: comment.user.login || null,
          type: comment.user.type || null,
          htmlUrl: comment.user.html_url || null,
        }
      : null,
  };
}

function summarizePullRequestReview(review) {
  if (!review || typeof review !== 'object') {
    return null;
  }

  return {
    id: Number.isFinite(Number(review.id)) ? Number(review.id) : null,
    nodeId: review.node_id || null,
    htmlUrl: review.html_url || null,
    state: typeof review.state === 'string' ? String(review.state).trim().toLowerCase() : null,
    submittedAt: review.submitted_at || null,
    commitId: review.commit_id || null,
    bodyPreview: typeof review.body === 'string'
      ? String(review.body).trim().slice(0, 280)
      : null,
    author: review.user
      ? {
          login: review.user.login || null,
          type: review.user.type || null,
          htmlUrl: review.user.html_url || null,
        }
      : null,
  };
}

function summarizeCreatedPullRequest(pullRequest) {
  return summarizePullRequest(pullRequest);
}

function normalizePositiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeReviewEventToken(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized === 'comment') return 'COMMENT';
  if (normalized === 'approve' || normalized === 'approved') return 'APPROVE';
  if (['request-changes', 'request_changes', 'requestchanges', 'changes-requested', 'request-change'].includes(normalized)) {
    return 'REQUEST_CHANGES';
  }

  return null;
}

function normalizeWebhookContentType(value, fallback = null) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return ['json', 'form'].includes(normalized) ? normalized : fallback;
}

function normalizeWebhookEvents(value) {
  const rawValues = Array.isArray(value)
    ? value
    : String(value || '').split(',');
  const seen = new Set();
  const events = [];

  for (const entry of rawValues) {
    const eventName = String(entry || '').trim().toLowerCase();
    if (!eventName || seen.has(eventName)) {
      continue;
    }
    seen.add(eventName);
    events.push(eventName);
  }

  return events;
}

function resolveWebhookSecretReference(secretRef, env = process.env) {
  const rawRef = String(secretRef || '').trim();
  if (!rawRef) {
    return {
      ok: true,
      secretRef: null,
      envName: null,
      value: null,
    };
  }

  const match = rawRef.match(/^repo:([A-Za-z_][A-Za-z0-9_]*)$/);
  if (!match) {
    return {
      ok: false,
      secretRef: rawRef,
      envName: null,
      error: `Webhook secret reference ${rawRef} is invalid. Expected repo:<ENV_NAME>.`,
    };
  }

  const envName = match[1];
  const value = String((env && env[envName]) || '').trim();
  if (!value) {
    return {
      ok: false,
      secretRef: rawRef,
      envName,
      error: `Webhook secret reference ${rawRef} could not be resolved from local environment variable ${envName}. Set ${envName} before running apply.`,
    };
  }

  return {
    ok: true,
    secretRef: rawRef,
    envName,
    value,
  };
}

function buildWebhookConfig(target = {}, env = process.env, options = {}) {
  const config = {};
  if (options.includeUrl && target.targetUrl) {
    config.url = target.targetUrl;
  }

  const contentType = normalizeWebhookContentType(target.contentType, null);
  if (options.includeContentType && contentType) {
    config.content_type = contentType;
  }

  let secretResolution = {
    ok: true,
    secretRef: null,
    envName: null,
    value: null,
  };
  if (options.includeSecretRef && target.secretRef) {
    secretResolution = resolveWebhookSecretReference(target.secretRef, env);
    if (!secretResolution.ok) {
      return secretResolution;
    }
    config.secret = secretResolution.value;
  }

  return {
    ok: true,
    config,
    secretRef: secretResolution.secretRef || null,
    secretEnvName: secretResolution.envName || target.secretEnvName || null,
  };
}

function buildWebhookCreateRequestBody(target = {}, env = process.env) {
  const events = normalizeWebhookEvents(target.events);
  if (!target.targetUrl || !events.length) {
    return {
      ok: false,
      error: 'GitHub webhook create preview is missing the target URL or events.',
    };
  }

  const configResolution = buildWebhookConfig(target, env, {
    includeUrl: true,
    includeContentType: true,
    includeSecretRef: !!target.secretRef,
  });
  if (!configResolution.ok) {
    return configResolution;
  }

  return {
    ok: true,
    body: {
      name: target.webhookName || 'web',
      active: target.active !== false,
      events,
      config: configResolution.config,
    },
    secretEnvName: configResolution.secretEnvName || null,
  };
}

function buildWebhookUpdateRequestBody(target = {}, env = process.env) {
  const body = {};
  const events = normalizeWebhookEvents(target.events);
  if (events.length > 0) {
    body.events = events;
  }
  if (target.active === true || target.active === false) {
    body.active = target.active;
  }

  const includeConfig = !!target.targetUrl || !!target.contentType || !!target.secretRef;
  let secretEnvName = target.secretEnvName || null;
  if (includeConfig) {
    const configResolution = buildWebhookConfig(target, env, {
      includeUrl: !!target.targetUrl,
      includeContentType: !!target.contentType,
      includeSecretRef: !!target.secretRef,
    });
    if (!configResolution.ok) {
      return configResolution;
    }
    if (Object.keys(configResolution.config).length > 0) {
      body.config = configResolution.config;
    }
    secretEnvName = configResolution.secretEnvName || secretEnvName;
  }

  if (!Object.keys(body).length) {
    return {
      ok: false,
      error: 'GitHub webhook update preview does not include any mutable fields.',
    };
  }

  return {
    ok: true,
    body,
    secretEnvName,
  };
}

function summarizeWebhookApplyResult(type, previewRecord = {}, responseData = null, options = {}) {
  const webhook = summarizeWebhook(responseData);
  return {
    type,
    webhookId: Number.isFinite(Number(webhook?.id))
      ? Number(webhook.id)
      : normalizePositiveInteger(previewRecord?.target?.webhookId),
    targetUrl: previewRecord?.target?.targetUrl || webhook?.config?.url || null,
    eventCount: Array.isArray(previewRecord?.target?.events)
      ? normalizeWebhookEvents(previewRecord.target.events).length
      : (webhook?.eventCount ?? 0),
    accepted: options.accepted === true,
    webhook,
  };
}

function buildWebhookGithubApi(response = {}, errorOverride = null, attempted = true) {
  return {
    attempted,
    status: response?.status ?? null,
    rateLimit: response?.rateLimit || null,
    requestUrl: response?.requestUrl || null,
    error: errorOverride || response?.error || response?.data?.message || null,
  };
}

async function executeWebhookCreatePreview(options = {}) {
  const previewRecord = options.previewRecord || {};
  const target = previewRecord.target || {};
  const requestBody = buildWebhookCreateRequestBody(target, options.env || process.env);
  if (!requestBody.ok) {
    return {
      ok: false,
      status: 400,
      error: requestBody.error,
      githubApi: buildWebhookGithubApi({}, requestBody.error, false),
    };
  }

  const response = await options.requestGitHubJson({
    apiPath: `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/hooks`,
    apiBaseUrl: target.apiBaseUrl || 'https://api.github.com',
    token: options.tokenInfo?.token,
    method: 'POST',
    body: requestBody.body,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  return {
    ok: response.ok,
    status: response.status,
    data: response.data || null,
    error: response.error || response.data?.message || null,
    requestUrl: response.requestUrl || null,
    rateLimit: response.rateLimit || null,
    githubApi: buildWebhookGithubApi(response),
    result: response.ok ? summarizeWebhookApplyResult('webhook-create', previewRecord, response.data) : null,
  };
}

async function executeWebhookUpdatePreview(options = {}) {
  const previewRecord = options.previewRecord || {};
  const target = previewRecord.target || {};
  const webhookId = normalizePositiveInteger(target.webhookId);
  if (!target.owner || !target.repo || !webhookId) {
    return {
      ok: false,
      status: 400,
      error: 'GitHub webhook update preview is missing the target webhook id.',
      githubApi: buildWebhookGithubApi({}, 'GitHub webhook update preview is missing the target webhook id.', false),
    };
  }

  const requestBody = buildWebhookUpdateRequestBody(target, options.env || process.env);
  if (!requestBody.ok) {
    return {
      ok: false,
      status: 400,
      error: requestBody.error,
      githubApi: buildWebhookGithubApi({}, requestBody.error, false),
    };
  }

  const response = await options.requestGitHubJson({
    apiPath: `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/hooks/${webhookId}`,
    apiBaseUrl: target.apiBaseUrl || 'https://api.github.com',
    token: options.tokenInfo?.token,
    method: 'PATCH',
    body: requestBody.body,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  return {
    ok: response.ok,
    status: response.status,
    data: response.data || null,
    error: response.error || response.data?.message || null,
    requestUrl: response.requestUrl || null,
    rateLimit: response.rateLimit || null,
    githubApi: buildWebhookGithubApi(response),
    result: response.ok ? summarizeWebhookApplyResult('webhook-update', previewRecord, response.data) : null,
  };
}

async function executeWebhookPingPreview(options = {}) {
  const previewRecord = options.previewRecord || {};
  const target = previewRecord.target || {};
  const webhookId = normalizePositiveInteger(target.webhookId);
  if (!target.owner || !target.repo || !webhookId) {
    return {
      ok: false,
      status: 400,
      error: 'GitHub webhook ping preview is missing the target webhook id.',
      githubApi: buildWebhookGithubApi({}, 'GitHub webhook ping preview is missing the target webhook id.', false),
    };
  }

  const response = await options.requestGitHubJson({
    apiPath: `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/hooks/${webhookId}/pings`,
    apiBaseUrl: target.apiBaseUrl || 'https://api.github.com',
    token: options.tokenInfo?.token,
    method: 'POST',
    body: {},
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  return {
    ok: response.ok,
    status: response.status,
    data: response.data || null,
    error: response.error || response.data?.message || null,
    requestUrl: response.requestUrl || null,
    rateLimit: response.rateLimit || null,
    githubApi: buildWebhookGithubApi(response),
    result: response.ok
      ? {
          type: 'webhook-ping',
          webhookId,
          accepted: true,
        }
      : null,
  };
}

function normalizeRiskLevel(value, fallback = 'low') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || fallback;
}

function resolvePreviewRiskLevel(preview = {}) {
  return normalizeRiskLevel(preview?.metadata?.riskLevel || preview?.metadata?.capabilityRiskLevel || 'low');
}

function resolveWritePreviewSpec(preview = {}) {
  const previewType = String(preview.previewType || '').trim().toLowerCase();
  const capabilityKey = String(preview.capabilityKey || '').trim().toLowerCase();

  if (previewType === 'issue-comment' && capabilityKey === 'issues.comment.draft') {
    return {
      capabilityKey,
      previewType,
      subjectLabel: 'GitHub issue comment',
      successMessage: 'GitHub issue comment applied successfully.',
      validatePreview(previewRecord = {}) {
        const targetNumber = resolveTargetNumber(previewRecord, { targetNumberKey: 'issueNumber' });
        const endpointIssueNumber = resolveEndpointIssueNumber(previewRecord, { targetNumberKey: 'issueNumber', endpointNumberKey: 'issueNumber' });
        if (!previewRecord.target?.owner || !previewRecord.target?.repo || !endpointIssueNumber || !previewRecord.input?.body) {
          return 'GitHub write preview is missing required target or body data.';
        }
        return null;
      },
      buildStartedDetails(previewRecord = {}) {
        const targetNumber = resolveTargetNumber(previewRecord, { targetNumberKey: 'issueNumber' });
        const endpointIssueNumber = resolveEndpointIssueNumber(previewRecord, { targetNumberKey: 'issueNumber', endpointNumberKey: 'issueNumber' });
        return buildApplyStartedDetails(previewRecord, { targetNumberKey: 'issueNumber', endpointNumberKey: 'issueNumber' }, targetNumber, endpointIssueNumber);
      },
      buildRequest(previewRecord = {}) {
        const endpointIssueNumber = resolveEndpointIssueNumber(previewRecord, { targetNumberKey: 'issueNumber', endpointNumberKey: 'issueNumber' });
        return {
          apiPath: `/repos/${encodeURIComponent(previewRecord.target.owner)}/${encodeURIComponent(previewRecord.target.repo)}/issues/${endpointIssueNumber}/comments`,
          method: 'POST',
          body: {
            body: previewRecord.input.body,
          },
        };
      },
      buildSuccessResult(previewRecord = {}, responseData = null) {
        const targetNumber = resolveTargetNumber(previewRecord, { targetNumberKey: 'issueNumber' });
        const endpointIssueNumber = resolveEndpointIssueNumber(previewRecord, { targetNumberKey: 'issueNumber', endpointNumberKey: 'issueNumber' });
        const comment = summarizeIssueComment(responseData);
        return buildApplyResult({ resultType: 'issue-comment', targetNumberKey: 'issueNumber', endpointNumberKey: 'issueNumber' }, targetNumber, endpointIssueNumber, previewRecord.input.bodyPreview || null, comment);
      },
      buildSucceededDetails(previewRecord = {}, result = {}) {
        const targetNumber = resolveTargetNumber(previewRecord, { targetNumberKey: 'issueNumber' });
        const endpointIssueNumber = resolveEndpointIssueNumber(previewRecord, { targetNumberKey: 'issueNumber', endpointNumberKey: 'issueNumber' });
        return buildApplySucceededDetails({ targetNumberKey: 'issueNumber', endpointNumberKey: 'issueNumber' }, targetNumber, endpointIssueNumber, result.comment);
      },
      buildFailedDetails(previewRecord = {}, response = {}) {
        const targetNumber = resolveTargetNumber(previewRecord, { targetNumberKey: 'issueNumber' });
        const endpointIssueNumber = resolveEndpointIssueNumber(previewRecord, { targetNumberKey: 'issueNumber', endpointNumberKey: 'issueNumber' });
        return buildApplyFailedDetails({ targetNumberKey: 'issueNumber', endpointNumberKey: 'issueNumber' }, targetNumber, endpointIssueNumber, response);
      },
      buildFailureMessage(_previewRecord = {}, response = {}) {
        return response.error
          || response.data?.message
          || 'GitHub issue comment apply failed.';
      },
    };
  }

  if (previewType === 'pr-comment' && capabilityKey === 'pr.comment.draft') {
    return {
      capabilityKey,
      previewType,
      subjectLabel: 'GitHub pull request comment',
      successMessage: 'GitHub pull request comment applied successfully.',
      validatePreview(previewRecord = {}) {
        const targetNumber = resolveTargetNumber(previewRecord, { targetNumberKey: 'pullRequestNumber' });
        const endpointIssueNumber = resolveEndpointIssueNumber(previewRecord, { targetNumberKey: 'pullRequestNumber', endpointNumberKey: 'issueNumber' });
        if (!previewRecord.target?.owner || !previewRecord.target?.repo || !endpointIssueNumber || !previewRecord.input?.body) {
          return 'GitHub write preview is missing required target or body data.';
        }
        return null;
      },
      buildStartedDetails(previewRecord = {}) {
        const targetNumber = resolveTargetNumber(previewRecord, { targetNumberKey: 'pullRequestNumber' });
        const endpointIssueNumber = resolveEndpointIssueNumber(previewRecord, { targetNumberKey: 'pullRequestNumber', endpointNumberKey: 'issueNumber' });
        return buildApplyStartedDetails(previewRecord, { targetNumberKey: 'pullRequestNumber', endpointNumberKey: 'issueNumber' }, targetNumber, endpointIssueNumber);
      },
      buildRequest(previewRecord = {}) {
        const endpointIssueNumber = resolveEndpointIssueNumber(previewRecord, { targetNumberKey: 'pullRequestNumber', endpointNumberKey: 'issueNumber' });
        return {
          apiPath: `/repos/${encodeURIComponent(previewRecord.target.owner)}/${encodeURIComponent(previewRecord.target.repo)}/issues/${endpointIssueNumber}/comments`,
          method: 'POST',
          body: {
            body: previewRecord.input.body,
          },
        };
      },
      buildSuccessResult(previewRecord = {}, responseData = null) {
        const targetNumber = resolveTargetNumber(previewRecord, { targetNumberKey: 'pullRequestNumber' });
        const endpointIssueNumber = resolveEndpointIssueNumber(previewRecord, { targetNumberKey: 'pullRequestNumber', endpointNumberKey: 'issueNumber' });
        const comment = summarizeIssueComment(responseData);
        return buildApplyResult({ resultType: 'pr-comment', targetNumberKey: 'pullRequestNumber', endpointNumberKey: 'issueNumber' }, targetNumber, endpointIssueNumber, previewRecord.input.bodyPreview || null, comment);
      },
      buildSucceededDetails(previewRecord = {}, result = {}) {
        const targetNumber = resolveTargetNumber(previewRecord, { targetNumberKey: 'pullRequestNumber' });
        const endpointIssueNumber = resolveEndpointIssueNumber(previewRecord, { targetNumberKey: 'pullRequestNumber', endpointNumberKey: 'issueNumber' });
        return buildApplySucceededDetails({ targetNumberKey: 'pullRequestNumber', endpointNumberKey: 'issueNumber' }, targetNumber, endpointIssueNumber, result.comment);
      },
      buildFailedDetails(previewRecord = {}, response = {}) {
        const targetNumber = resolveTargetNumber(previewRecord, { targetNumberKey: 'pullRequestNumber' });
        const endpointIssueNumber = resolveEndpointIssueNumber(previewRecord, { targetNumberKey: 'pullRequestNumber', endpointNumberKey: 'issueNumber' });
        return buildApplyFailedDetails({ targetNumberKey: 'pullRequestNumber', endpointNumberKey: 'issueNumber' }, targetNumber, endpointIssueNumber, response);
      },
      buildFailureMessage(_previewRecord = {}, response = {}) {
        return response.error
          || response.data?.message
          || 'GitHub pull request comment apply failed.';
      },
    };
  }

  if (previewType === 'pr-review' && capabilityKey === 'pr.review.draft') {
    return {
      capabilityKey,
      previewType,
      subjectLabel: 'GitHub pull request review',
      successMessage: 'GitHub pull request review applied successfully.',
      validatePreview(previewRecord = {}) {
        const targetNumber = resolveTargetNumber(previewRecord, { targetNumberKey: 'pullRequestNumber' });
        const reviewEvent = normalizeReviewEventToken(previewRecord?.target?.reviewEventApi || previewRecord?.target?.reviewEvent || previewRecord?.input?.metadata?.reviewEventApi || previewRecord?.input?.metadata?.reviewEvent);
        if (!previewRecord.target?.owner || !previewRecord.target?.repo || !targetNumber || !reviewEvent) {
          return 'GitHub pull request review preview is missing required target or review-event data.';
        }
        return null;
      },
      buildStartedDetails(previewRecord = {}) {
        const targetNumber = resolveTargetNumber(previewRecord, { targetNumberKey: 'pullRequestNumber' });
        return {
          target: previewRecord?.target?.slug || null,
          pullRequestNumber: targetNumber,
          reviewEvent: previewRecord?.target?.reviewEvent || previewRecord?.input?.metadata?.reviewEvent || null,
        };
      },
      buildRequest(previewRecord = {}) {
        const targetNumber = resolveTargetNumber(previewRecord, { targetNumberKey: 'pullRequestNumber' });
        const reviewEvent = normalizeReviewEventToken(previewRecord?.target?.reviewEventApi || previewRecord?.target?.reviewEvent || previewRecord?.input?.metadata?.reviewEventApi || previewRecord?.input?.metadata?.reviewEvent);
        const body = {
          event: reviewEvent,
        };
        if (String(previewRecord?.input?.body || '').trim()) {
          body.body = previewRecord.input.body;
        }
        return {
          apiPath: `/repos/${encodeURIComponent(previewRecord.target.owner)}/${encodeURIComponent(previewRecord.target.repo)}/pulls/${targetNumber}/reviews`,
          method: 'POST',
          body,
        };
      },
      buildSuccessResult(previewRecord = {}, responseData = null) {
        const targetNumber = resolveTargetNumber(previewRecord, { targetNumberKey: 'pullRequestNumber' });
        const review = summarizePullRequestReview(responseData);
        return {
          type: 'pr-review',
          pullRequestNumber: targetNumber,
          reviewEvent: previewRecord?.target?.reviewEvent || previewRecord?.input?.metadata?.reviewEvent || null,
          bodyPreview: previewRecord?.input?.bodyPreview || null,
          review,
        };
      },
      buildSucceededDetails(previewRecord = {}, result = {}) {
        return {
          pullRequestNumber: result.pullRequestNumber || resolveTargetNumber(previewRecord, { targetNumberKey: 'pullRequestNumber' }) || null,
          reviewEvent: result.reviewEvent || previewRecord?.target?.reviewEvent || previewRecord?.input?.metadata?.reviewEvent || null,
          reviewId: result.review?.id || null,
          reviewUrl: result.review?.htmlUrl || null,
          reviewState: result.review?.state || null,
        };
      },
      buildFailedDetails(previewRecord = {}, response = {}) {
        return {
          pullRequestNumber: resolveTargetNumber(previewRecord, { targetNumberKey: 'pullRequestNumber' }),
          reviewEvent: previewRecord?.target?.reviewEvent || previewRecord?.input?.metadata?.reviewEvent || null,
          status: response.status,
          error: response.error || response.data?.message || null,
        };
      },
      buildFailureMessage(_previewRecord = {}, response = {}) {
        return response.error
          || response.data?.message
          || 'GitHub pull request review apply failed.';
      },
    };
  }

  if (previewType === 'pr-close' && capabilityKey === 'pr.close.draft') {
    return {
      capabilityKey,
      previewType,
      subjectLabel: 'GitHub pull request close',
      successMessage: 'GitHub pull request closed successfully.',
      validatePreview(previewRecord = {}) {
        const targetNumber = resolveTargetNumber(previewRecord, { targetNumberKey: 'pullRequestNumber' });
        const desiredState = String(previewRecord?.target?.desiredState || '').trim().toLowerCase();
        if (!previewRecord.target?.owner || !previewRecord.target?.repo || !targetNumber || desiredState !== 'closed') {
          return 'GitHub pull request close preview is missing required target or desired-state data.';
        }
        return null;
      },
      buildStartedDetails(previewRecord = {}) {
        return {
          target: previewRecord?.target?.slug || null,
          pullRequestNumber: resolveTargetNumber(previewRecord, { targetNumberKey: 'pullRequestNumber' }),
          desiredState: previewRecord?.target?.desiredState || null,
        };
      },
      buildRequest(previewRecord = {}) {
        const targetNumber = resolveTargetNumber(previewRecord, { targetNumberKey: 'pullRequestNumber' });
        return {
          apiPath: `/repos/${encodeURIComponent(previewRecord.target.owner)}/${encodeURIComponent(previewRecord.target.repo)}/pulls/${targetNumber}`,
          method: 'PATCH',
          body: {
            state: 'closed',
          },
        };
      },
      buildSuccessResult(previewRecord = {}, responseData = null) {
        const pullRequest = summarizeCreatedPullRequest(responseData);
        return {
          type: 'pr-close',
          pullRequestNumber: pullRequest?.number || resolveTargetNumber(previewRecord, { targetNumberKey: 'pullRequestNumber' }) || null,
          desiredState: 'closed',
          pullRequest,
        };
      },
      buildSucceededDetails(_previewRecord = {}, result = {}) {
        return {
          pullRequestNumber: result.pullRequestNumber || null,
          desiredState: result.desiredState || 'closed',
          pullRequestUrl: result.pullRequest?.htmlUrl || null,
          state: result.pullRequest?.state || null,
          closedAt: result.pullRequest?.closedAt || null,
        };
      },
      buildFailedDetails(previewRecord = {}, response = {}) {
        return {
          pullRequestNumber: resolveTargetNumber(previewRecord, { targetNumberKey: 'pullRequestNumber' }),
          desiredState: 'closed',
          status: response.status,
          error: response.error || response.data?.message || null,
        };
      },
      buildFailureMessage(_previewRecord = {}, response = {}) {
        return response.error
          || response.data?.message
          || 'GitHub pull request close apply failed.';
      },
    };
  }

  if (previewType === 'pr-reopen' && capabilityKey === 'pr.reopen.draft') {
    return {
      capabilityKey,
      previewType,
      subjectLabel: 'GitHub pull request reopen',
      successMessage: 'GitHub pull request reopened successfully.',
      validatePreview(previewRecord = {}) {
        const targetNumber = resolveTargetNumber(previewRecord, { targetNumberKey: 'pullRequestNumber' });
        const desiredState = String(previewRecord?.target?.desiredState || '').trim().toLowerCase();
        if (!previewRecord.target?.owner || !previewRecord.target?.repo || !targetNumber || desiredState !== 'open') {
          return 'GitHub pull request reopen preview is missing required target or desired-state data.';
        }
        return null;
      },
      buildStartedDetails(previewRecord = {}) {
        return {
          target: previewRecord?.target?.slug || null,
          pullRequestNumber: resolveTargetNumber(previewRecord, { targetNumberKey: 'pullRequestNumber' }),
          desiredState: previewRecord?.target?.desiredState || null,
        };
      },
      buildRequest(previewRecord = {}) {
        const targetNumber = resolveTargetNumber(previewRecord, { targetNumberKey: 'pullRequestNumber' });
        return {
          apiPath: `/repos/${encodeURIComponent(previewRecord.target.owner)}/${encodeURIComponent(previewRecord.target.repo)}/pulls/${targetNumber}`,
          method: 'PATCH',
          body: {
            state: 'open',
          },
        };
      },
      buildSuccessResult(previewRecord = {}, responseData = null) {
        const pullRequest = summarizeCreatedPullRequest(responseData);
        return {
          type: 'pr-reopen',
          pullRequestNumber: pullRequest?.number || resolveTargetNumber(previewRecord, { targetNumberKey: 'pullRequestNumber' }) || null,
          desiredState: 'open',
          pullRequest,
        };
      },
      buildSucceededDetails(_previewRecord = {}, result = {}) {
        return {
          pullRequestNumber: result.pullRequestNumber || null,
          desiredState: result.desiredState || 'open',
          pullRequestUrl: result.pullRequest?.htmlUrl || null,
          state: result.pullRequest?.state || null,
          closedAt: result.pullRequest?.closedAt || null,
        };
      },
      buildFailedDetails(previewRecord = {}, response = {}) {
        return {
          pullRequestNumber: resolveTargetNumber(previewRecord, { targetNumberKey: 'pullRequestNumber' }),
          desiredState: 'open',
          status: response.status,
          error: response.error || response.data?.message || null,
        };
      },
      buildFailureMessage(_previewRecord = {}, response = {}) {
        return response.error
          || response.data?.message
          || 'GitHub pull request reopen apply failed.';
      },
    };
  }

  if (previewType === 'pr-create' && capabilityKey === 'pr.create.draft') {
    return {
      capabilityKey,
      previewType,
      subjectLabel: 'GitHub pull request',
      successMessage: 'GitHub pull request created successfully.',
      validatePreview(previewRecord = {}) {
        if (!previewRecord.target?.owner
          || !previewRecord.target?.repo
          || !previewRecord.target?.baseBranch
          || !previewRecord.target?.head
          || !previewRecord.input?.title) {
          return 'GitHub pull request create preview is missing required title or branch target data.';
        }
        return null;
      },
      buildStartedDetails(previewRecord = {}) {
        return {
          target: previewRecord?.target?.slug || null,
          titlePreview: previewRecord?.input?.titlePreview || null,
          baseBranch: previewRecord?.target?.baseBranch || null,
          head: previewRecord?.target?.head || null,
          headBranch: previewRecord?.target?.headBranch || null,
          draft: previewRecord?.target?.draft === true,
        };
      },
      buildRequest(previewRecord = {}) {
        return {
          apiPath: `/repos/${encodeURIComponent(previewRecord.target.owner)}/${encodeURIComponent(previewRecord.target.repo)}/pulls`,
          method: 'POST',
          body: {
            title: previewRecord.input.title,
            head: previewRecord.target.head,
            base: previewRecord.target.baseBranch,
            body: previewRecord.input.body || '',
            draft: previewRecord.target.draft === true,
          },
        };
      },
      buildSuccessResult(previewRecord = {}, responseData = null) {
        const pullRequest = summarizeCreatedPullRequest(responseData);
        return {
          type: 'pr-create',
          pullRequestNumber: pullRequest?.number || null,
          titlePreview: previewRecord?.input?.titlePreview || null,
          bodyPreview: previewRecord?.input?.bodyPreview || null,
          baseBranch: previewRecord?.target?.baseBranch || null,
          head: previewRecord?.target?.head || null,
          headBranch: previewRecord?.target?.headBranch || null,
          draft: previewRecord?.target?.draft === true,
          pullRequest,
        };
      },
      buildSucceededDetails(_previewRecord = {}, result = {}) {
        return {
          pullRequestNumber: result.pullRequestNumber || null,
          pullRequestUrl: result.pullRequest?.htmlUrl || null,
          baseBranch: result.baseBranch || null,
          head: result.head || null,
          headBranch: result.headBranch || null,
          draft: result.draft === true,
        };
      },
      buildFailedDetails(previewRecord = {}, response = {}) {
        return {
          status: response.status,
          error: response.error || response.data?.message || null,
          baseBranch: previewRecord?.target?.baseBranch || null,
          head: previewRecord?.target?.head || null,
          headBranch: previewRecord?.target?.headBranch || null,
          draft: previewRecord?.target?.draft === true,
        };
      },
      buildFailureMessage(_previewRecord = {}, response = {}) {
        return response.error
          || response.data?.message
          || 'GitHub pull request create apply failed.';
      },
    };
  }

  if (previewType === 'repo-content-patch'
    && ['workflow.create.draft', 'workflow.update.draft', 'codeowners.create.draft', 'codeowners.update.draft'].includes(capabilityKey)) {
    const resourceFamily = String(preview?.target?.resourceFamily || '').trim().toLowerCase();
    const resourceLabel = resourceFamily === 'codeowners' ? 'GitHub CODEOWNERS patch' : 'GitHub workflow patch';
    const resourceNoun = resourceFamily === 'codeowners' ? 'CODEOWNERS' : 'workflow';
    return {
      capabilityKey,
      previewType,
      subjectLabel: resourceLabel,
      successMessage: `${resourceLabel} applied successfully.`,
      validatePreview(previewRecord = {}) {
        if (!previewRecord.target?.owner
          || !previewRecord.target?.repo
          || !previewRecord.target?.path
          || !previewRecord.target?.baseBranch
          || !previewRecord.target?.headBranch
          || !previewRecord.input?.body
          || !previewRecord.input?.title
          || !previewRecord.target?.pullRequestTitle) {
          return 'GitHub workflow patch preview is missing required repo-content patch data.';
        }
        return null;
      },
      buildStartedDetails(previewRecord = {}) {
        return {
          target: previewRecord?.target?.slug || null,
          path: previewRecord?.target?.path || null,
          changeOperation: previewRecord?.target?.changeOperation || null,
          baseBranch: previewRecord?.target?.baseBranch || null,
          headBranch: previewRecord?.target?.headBranch || null,
        };
      },
      execute(executionOptions = {}) {
        return executeGitHubRepoContentPatchPreview(executionOptions);
      },
      buildSucceededDetails(_previewRecord = {}, result = {}) {
        return {
          path: result.path || null,
          changeOperation: result.changeOperation || null,
          baseBranch: result.baseBranch || null,
          headBranch: result.headBranch || null,
          pullRequestNumber: result.pullRequest?.number || null,
          pullRequestUrl: result.pullRequest?.htmlUrl || null,
        };
      },
      buildFailedDetails(previewRecord = {}, response = {}) {
        return {
          status: response.status,
          error: response.error || response.data?.message || null,
          path: previewRecord?.target?.path || null,
          changeOperation: previewRecord?.target?.changeOperation || null,
          baseBranch: previewRecord?.target?.baseBranch || null,
          headBranch: previewRecord?.target?.headBranch || null,
        };
      },
      buildFailureMessage(previewRecord = {}, response = {}) {
        const actionLabel = previewRecord?.target?.changeOperation === 'create' ? 'create' : 'update';
        return response.error
          || response.data?.message
          || `GitHub ${resourceNoun} ${actionLabel} apply failed.`;
      },
    };
  }

  if (previewType === 'webhook-create' && capabilityKey === 'webhook.create.draft') {
    return {
      capabilityKey,
      previewType,
      subjectLabel: 'GitHub webhook create',
      successMessage: 'GitHub webhook create applied successfully.',
      validatePreview(previewRecord = {}) {
        if (!previewRecord.target?.owner
          || !previewRecord.target?.repo
          || !previewRecord.target?.targetUrl
          || normalizeWebhookEvents(previewRecord.target.events).length === 0) {
          return 'GitHub webhook create preview is missing the target URL or events.';
        }
        return null;
      },
      buildStartedDetails(previewRecord = {}) {
        return {
          target: previewRecord?.target?.slug || null,
          webhookName: previewRecord?.target?.webhookName || 'web',
          targetUrl: previewRecord?.target?.targetUrl || null,
          eventCount: normalizeWebhookEvents(previewRecord?.target?.events).length,
        };
      },
      execute: executeWebhookCreatePreview,
      buildSucceededDetails(_previewRecord = {}, result = {}) {
        return {
          webhookId: result.webhookId || null,
          targetUrl: result.targetUrl || null,
          eventCount: result.eventCount ?? 0,
        };
      },
      buildFailedDetails(previewRecord = {}, response = {}) {
        return {
          status: response.status,
          error: response.error || response.data?.message || null,
          targetUrl: previewRecord?.target?.targetUrl || null,
          eventCount: normalizeWebhookEvents(previewRecord?.target?.events).length,
        };
      },
      buildFailureMessage(_previewRecord = {}, response = {}) {
        return response.error
          || response.data?.message
          || 'GitHub webhook create apply failed.';
      },
    };
  }

  if (previewType === 'webhook-update' && capabilityKey === 'webhook.update.draft') {
    return {
      capabilityKey,
      previewType,
      subjectLabel: 'GitHub webhook update',
      successMessage: 'GitHub webhook update applied successfully.',
      validatePreview(previewRecord = {}) {
        const webhookId = normalizePositiveInteger(previewRecord?.target?.webhookId);
        const hasEvents = normalizeWebhookEvents(previewRecord?.target?.events).length > 0;
        const hasActive = previewRecord?.target?.active === true || previewRecord?.target?.active === false;
        if (!previewRecord.target?.owner || !previewRecord.target?.repo || !webhookId) {
          return 'GitHub webhook update preview is missing the target webhook id.';
        }
        if (!previewRecord.target?.targetUrl && !previewRecord.target?.contentType && !previewRecord.target?.secretRef && !hasEvents && !hasActive) {
          return 'GitHub webhook update preview does not include any mutable fields.';
        }
        return null;
      },
      buildStartedDetails(previewRecord = {}) {
        return {
          target: previewRecord?.target?.slug || null,
          webhookId: normalizePositiveInteger(previewRecord?.target?.webhookId),
          eventCount: normalizeWebhookEvents(previewRecord?.target?.events).length,
          targetUrl: previewRecord?.target?.targetUrl || null,
        };
      },
      execute: executeWebhookUpdatePreview,
      buildSucceededDetails(_previewRecord = {}, result = {}) {
        return {
          webhookId: result.webhookId || null,
          targetUrl: result.targetUrl || null,
          eventCount: result.eventCount ?? 0,
        };
      },
      buildFailedDetails(previewRecord = {}, response = {}) {
        return {
          status: response.status,
          error: response.error || response.data?.message || null,
          webhookId: normalizePositiveInteger(previewRecord?.target?.webhookId),
          targetUrl: previewRecord?.target?.targetUrl || null,
        };
      },
      buildFailureMessage(_previewRecord = {}, response = {}) {
        return response.error
          || response.data?.message
          || 'GitHub webhook update apply failed.';
      },
    };
  }

  if (previewType === 'webhook-ping' && capabilityKey === 'webhook.ping.draft') {
    return {
      capabilityKey,
      previewType,
      subjectLabel: 'GitHub webhook ping',
      successMessage: 'GitHub webhook ping applied successfully.',
      validatePreview(previewRecord = {}) {
        if (!previewRecord.target?.owner
          || !previewRecord.target?.repo
          || !normalizePositiveInteger(previewRecord.target.webhookId)) {
          return 'GitHub webhook ping preview is missing the target webhook id.';
        }
        return null;
      },
      buildStartedDetails(previewRecord = {}) {
        return {
          target: previewRecord?.target?.slug || null,
          webhookId: normalizePositiveInteger(previewRecord?.target?.webhookId),
        };
      },
      execute: executeWebhookPingPreview,
      buildSucceededDetails(_previewRecord = {}, result = {}) {
        return {
          webhookId: result.webhookId || null,
          accepted: result.accepted === true,
        };
      },
      buildFailedDetails(previewRecord = {}, response = {}) {
        return {
          status: response.status,
          error: response.error || response.data?.message || null,
          webhookId: normalizePositiveInteger(previewRecord?.target?.webhookId),
        };
      },
      buildFailureMessage(_previewRecord = {}, response = {}) {
        return response.error
          || response.data?.message
          || 'GitHub webhook ping apply failed.';
      },
    };
  }

  if (previewType === 'workflow-dispatch' && capabilityKey === 'workflow.dispatch.draft') {
    return {
      capabilityKey,
      previewType,
      subjectLabel: 'GitHub workflow dispatch',
      successMessage: 'GitHub workflow dispatch applied successfully.',
      validatePreview(previewRecord = {}) {
        if (!previewRecord.target?.owner
          || !previewRecord.target?.repo
          || !previewRecord.target?.workflow
          || !previewRecord.target?.ref) {
          return 'GitHub workflow dispatch preview is missing the target workflow or ref.';
        }
        return null;
      },
      buildStartedDetails(previewRecord = {}) {
        return {
          target: previewRecord?.target?.slug || null,
          workflow: previewRecord?.target?.workflow || null,
          ref: previewRecord?.target?.ref || null,
          inputCount: Object.keys(previewRecord?.target?.inputs || {}).length,
        };
      },
      buildRequest(previewRecord = {}) {
        return {
          apiPath: `/repos/${encodeURIComponent(previewRecord.target.owner)}/${encodeURIComponent(previewRecord.target.repo)}/actions/workflows/${encodeURIComponent(previewRecord.target.workflow)}/dispatches`,
          method: 'POST',
          body: {
            ref: previewRecord.target.ref,
            inputs: previewRecord.target.inputs || {},
          },
        };
      },
      buildSuccessResult(previewRecord = {}) {
        return {
          type: 'workflow-dispatch',
          workflow: previewRecord?.target?.workflow || null,
          ref: previewRecord?.target?.ref || null,
          inputs: previewRecord?.target?.inputs || {},
          accepted: true,
        };
      },
      buildSucceededDetails(_previewRecord = {}, result = {}) {
        return {
          workflow: result.workflow || null,
          ref: result.ref || null,
          inputCount: Object.keys(result.inputs || {}).length,
        };
      },
      buildFailedDetails(previewRecord = {}, response = {}) {
        return {
          status: response.status,
          error: response.error || response.data?.message || null,
          workflow: previewRecord?.target?.workflow || null,
          ref: previewRecord?.target?.ref || null,
        };
      },
      buildFailureMessage(_previewRecord = {}, response = {}) {
        return response.error
          || response.data?.message
          || 'GitHub workflow dispatch apply failed.';
      },
    };
  }

  if (previewType === 'workflow-rerun' && capabilityKey === 'workflow.rerun.draft') {
    return {
      capabilityKey,
      previewType,
      subjectLabel: 'GitHub workflow rerun',
      successMessage: 'GitHub workflow rerun applied successfully.',
      validatePreview(previewRecord = {}) {
        if (!previewRecord.target?.owner
          || !previewRecord.target?.repo
          || !normalizePositiveInteger(previewRecord.target.runId)) {
          return 'GitHub workflow rerun preview is missing the target run id.';
        }
        return null;
      },
      buildStartedDetails(previewRecord = {}) {
        return {
          target: previewRecord?.target?.slug || null,
          runId: normalizePositiveInteger(previewRecord?.target?.runId),
          failedOnly: previewRecord?.target?.failedOnly === true,
        };
      },
      buildRequest(previewRecord = {}) {
        const runId = normalizePositiveInteger(previewRecord.target.runId);
        const suffix = previewRecord.target.failedOnly === true ? 'rerun-failed-jobs' : 'rerun';
        return {
          apiPath: `/repos/${encodeURIComponent(previewRecord.target.owner)}/${encodeURIComponent(previewRecord.target.repo)}/actions/runs/${runId}/${suffix}`,
          method: 'POST',
          body: {},
        };
      },
      buildSuccessResult(previewRecord = {}) {
        return {
          type: 'workflow-rerun',
          runId: normalizePositiveInteger(previewRecord?.target?.runId),
          failedOnly: previewRecord?.target?.failedOnly === true,
          accepted: true,
        };
      },
      buildSucceededDetails(_previewRecord = {}, result = {}) {
        return {
          runId: result.runId || null,
          failedOnly: result.failedOnly === true,
        };
      },
      buildFailedDetails(previewRecord = {}, response = {}) {
        return {
          status: response.status,
          error: response.error || response.data?.message || null,
          runId: normalizePositiveInteger(previewRecord?.target?.runId),
          failedOnly: previewRecord?.target?.failedOnly === true,
        };
      },
      buildFailureMessage(_previewRecord = {}, response = {}) {
        return response.error
          || response.data?.message
          || 'GitHub workflow rerun apply failed.';
      },
    };
  }

  if (previewType === 'workflow-cancel' && capabilityKey === 'workflow.cancel.draft') {
    return {
      capabilityKey,
      previewType,
      subjectLabel: 'GitHub workflow cancel',
      successMessage: 'GitHub workflow cancel applied successfully.',
      validatePreview(previewRecord = {}) {
        if (!previewRecord.target?.owner
          || !previewRecord.target?.repo
          || !normalizePositiveInteger(previewRecord.target.runId)) {
          return 'GitHub workflow cancel preview is missing the target run id.';
        }
        return null;
      },
      buildStartedDetails(previewRecord = {}) {
        return {
          target: previewRecord?.target?.slug || null,
          runId: normalizePositiveInteger(previewRecord?.target?.runId),
        };
      },
      buildRequest(previewRecord = {}) {
        const runId = normalizePositiveInteger(previewRecord.target.runId);
        return {
          apiPath: `/repos/${encodeURIComponent(previewRecord.target.owner)}/${encodeURIComponent(previewRecord.target.repo)}/actions/runs/${runId}/cancel`,
          method: 'POST',
          body: {},
        };
      },
      buildSuccessResult(previewRecord = {}) {
        return {
          type: 'workflow-cancel',
          runId: normalizePositiveInteger(previewRecord?.target?.runId),
          accepted: true,
        };
      },
      buildSucceededDetails(_previewRecord = {}, result = {}) {
        return {
          runId: result.runId || null,
        };
      },
      buildFailedDetails(previewRecord = {}, response = {}) {
        return {
          status: response.status,
          error: response.error || response.data?.message || null,
          runId: normalizePositiveInteger(previewRecord?.target?.runId),
        };
      },
      buildFailureMessage(_previewRecord = {}, response = {}) {
        return response.error
          || response.data?.message
          || 'GitHub workflow cancel apply failed.';
      },
    };
  }

  return null;
}

function resolveTargetNumber(preview = {}, spec = {}) {
  return normalizePositiveInteger(preview?.target?.[spec.targetNumberKey]);
}

function resolveEndpointIssueNumber(preview = {}, spec = {}) {
  return normalizePositiveInteger(preview?.target?.[spec.endpointNumberKey])
    || resolveTargetNumber(preview, spec);
}

function buildApplyStartedDetails(preview = {}, spec = {}, targetNumber = null, endpointIssueNumber = null) {
  const details = {
    target: preview?.target?.slug || null,
  };

  if (targetNumber) {
    details[spec.targetNumberKey] = targetNumber;
  }
  if (spec.endpointNumberKey !== spec.targetNumberKey && endpointIssueNumber) {
    details.issueNumber = endpointIssueNumber;
  }

  return details;
}

function buildApplyResult(spec = {}, targetNumber = null, endpointIssueNumber = null, bodyPreview = null, comment = null) {
  const result = {
    type: spec.resultType,
    bodyPreview: bodyPreview || null,
    comment,
  };

  if (targetNumber) {
    result[spec.targetNumberKey] = targetNumber;
  }
  if (spec.endpointNumberKey !== spec.targetNumberKey && endpointIssueNumber) {
    result.issueNumber = endpointIssueNumber;
  }

  return result;
}

function buildApplySucceededDetails(spec = {}, targetNumber = null, endpointIssueNumber = null, comment = null) {
  const details = {
    commentId: comment?.id || null,
    commentUrl: comment?.htmlUrl || null,
  };

  if (targetNumber) {
    details[spec.targetNumberKey] = targetNumber;
  }
  if (spec.endpointNumberKey !== spec.targetNumberKey && endpointIssueNumber) {
    details.issueNumber = endpointIssueNumber;
  }

  return details;
}

function buildApplyFailedDetails(spec = {}, targetNumber = null, endpointIssueNumber = null, response = {}) {
  const details = {
    status: response.status,
    error: response.error || response.data?.message || null,
  };

  if (targetNumber) {
    details[spec.targetNumberKey] = targetNumber;
  }
  if (spec.endpointNumberKey !== spec.targetNumberKey && endpointIssueNumber) {
    details.issueNumber = endpointIssueNumber;
  }

  return details;
}

function buildBaseReport(options = {}, previewId = null) {
  return {
    schemaVersion: GITHUB_WRITE_APPLY_SCHEMA_VERSION,
    success: true,
    featureFlagEnabled: options.featureFlagEnabled === true,
    writeFeatureFlagEnabled: options.writeFeatureFlagEnabled === true,
    previewId,
    previewArtifact: null,
    approvalArtifact: null,
    resultArtifact: null,
    eventLog: previewId ? summarizeGitHubWriteEventLog({ previewId }) : null,
    approval: null,
    execution: null,
    target: null,
    repoIdentity: null,
    result: null,
    githubApi: {
      tokenPresent: false,
      tokenSource: null,
      attempted: false,
      status: null,
      rateLimit: null,
      error: null,
      requestUrl: null,
    },
    warnings: [],
  };
}

function buildErrorReport(report, error, message) {
  return {
    ...report,
    success: false,
    error,
    message,
  };
}

function readArtifacts(previewId, approvalFilePath) {
  const preview = readGitHubWritePreviewArtifact({ previewId });
  const approval = readGitHubWriteApprovalArtifact({ previewId, filePath: approvalFilePath });
  return { preview, approval };
}

async function applyGitHubWritePreview(options = {}) {
  const previewId = String(options.previewId || options.id || '').trim();
  const approvalFilePath = String(options.approvalFile || options['approval-file'] || '').trim() || null;
  const explicitApplyToken = String(options.applyToken || options['apply-token'] || '').trim() || null;
  const approve = parseBooleanOption(options.approve);
  const source = String(options.source || 'unknown').trim() || 'unknown';
  const report = buildBaseReport(options, previewId || null);

  if (!previewId) {
    return buildErrorReport(report, 'USAGE', buildUsageMessage());
  }

  if (!approve) {
    return buildErrorReport(report, 'APPROVAL_REQUIRED', 'GitHub apply requires --approve.');
  }

  if (!approvalFilePath && !explicitApplyToken) {
    return buildErrorReport(report, 'USAGE', buildUsageMessage());
  }

  let preview;
  let approval;
  try {
    ({ preview, approval } = readArtifacts(previewId, approvalFilePath));
  } catch (error) {
    if (/preview artifact/i.test(error.message || '')) {
      return buildErrorReport(report, 'PREVIEW_ARTIFACT_MISSING', error.message || 'GitHub write preview artifact is missing.');
    }
    if (/approval artifact/i.test(error.message || '')) {
      return buildErrorReport(report, 'APPROVAL_ARTIFACT_MISSING', error.message || 'GitHub write approval artifact is missing.');
    }
    return buildErrorReport(report, 'ARTIFACT_READ_FAILED', error.message || 'GitHub write artifacts could not be loaded.');
  }

  report.previewArtifact = summarizeGitHubWritePreviewArtifactRecord(preview, preview.filePath);
  report.approvalArtifact = summarizeGitHubWriteApprovalArtifactRecord(approval, approval.filePath);
  report.repoIdentity = preview.repoIdentity || null;
  report.target = preview.target || null;
  report.approval = {
    status: approval.status || null,
    approvalRequirement: approval.approvalRequirement || null,
    approvalMode: approval.approvalMode || null,
    expiresAt: approval.expiresAt || null,
    applyTokenHint: report.approvalArtifact.applyTokenHint,
  };

  if (preview.schemaVersion !== 'github.write-preview-artifact.v1'
    || approval.schemaVersion !== 'github.write-approval.v1'
    || !preview.review
    || preview.previewId !== approval.previewId) {
    return buildErrorReport(report, 'INVALID_PREVIEW_SCHEMA', 'GitHub write preview artifacts are invalid or mismatched.');
  }

  const resolvedApplyToken = explicitApplyToken || (approvalFilePath ? String(approval.applyToken || '').trim() : null);
  if (!resolvedApplyToken || resolvedApplyToken !== String(approval.applyToken || '').trim()) {
    return buildErrorReport(report, 'INVALID_APPLY_TOKEN', 'The supplied GitHub apply token is invalid for this preview.');
  }

  if (isExpired(preview.expiresAt) || isExpired(approval.expiresAt)) {
    const expiredAt = new Date().toISOString();
    writeGitHubWriteApprovalArtifact({
      ...approval,
      previewId,
      updatedAt: expiredAt,
      status: 'expired',
      expiredAt,
      reason: 'preview-expired',
      filePath: approval.filePath,
    });
    appendGitHubWriteEvent({
      previewId,
      source,
      capabilityKey: preview.capabilityKey,
      status: 'expired',
      eventName: 'preview.expired',
      details: {
        expiresAt: approval.expiresAt || preview.expiresAt || null,
      },
    });
    return buildErrorReport(report, 'EXPIRED_PREVIEW', 'This GitHub write preview has expired and cannot be applied.');
  }

  if (approval.status === 'applied' || approval.status === 'failed') {
    try {
      const existingResult = readGitHubWriteApplyResultArtifact({ previewId, filePath: approval.resultArtifact?.filePath });
      report.resultArtifact = {
        previewId: existingResult.previewId,
        schemaVersion: existingResult.schemaVersion,
        createdAt: existingResult.createdAt,
        status: existingResult.status,
        success: existingResult.success !== false,
        filePath: existingResult.filePath,
      };
      report.result = existingResult.result || null;
      report.githubApi = {
        ...report.githubApi,
        ...(existingResult.githubApi || {}),
      };
      report.execution = {
        status: 'replayed-terminal-result',
        terminal: true,
        alreadyApplied: approval.status === 'applied',
        resultStatus: existingResult.status || approval.status,
      };
      report.success = existingResult.success !== false;
      report.message = approval.status === 'applied'
        ? 'GitHub write preview was already applied; returning the existing terminal result.'
        : 'GitHub write preview previously failed; returning the existing terminal result.';
      return report;
    } catch (error) {
      return buildErrorReport(report, 'APPLY_RESULT_MISSING', error.message || 'GitHub write result artifact is missing.');
    }
  }

  if (approval.status && approval.status !== 'requested' && approval.status !== 'approved') {
    return buildErrorReport(report, 'APPROVAL_STATE_INVALID', `GitHub write preview is not in an appliable state (${approval.status}).`);
  }

  const previewSpec = resolveWritePreviewSpec(preview);
  if (!previewSpec) {
    return buildErrorReport(report, 'UNSUPPORTED_WRITE_PREVIEW', `Unsupported GitHub write preview type: ${preview.previewType || preview.capabilityKey || 'unknown'}.`);
  }

  const previewValidationError = typeof previewSpec.validatePreview === 'function'
    ? previewSpec.validatePreview(preview)
    : null;
  if (previewValidationError) {
    return buildErrorReport(report, 'INVALID_PREVIEW_SCHEMA', previewValidationError);
  }

  const previewRiskLevel = resolvePreviewRiskLevel(preview);
  if (['high', 'critical'].includes(previewRiskLevel)) {
    return buildErrorReport(report, 'RISK_LEVEL_NOT_SUPPORTED', `GitHub apply is not enabled for ${previewRiskLevel}-risk reviewed previews.`);
  }

  const approvedAt = new Date().toISOString();
  const approvedApproval = {
    ...approval,
    previewId,
    filePath: approval.filePath,
    status: 'approved',
    approvedAt,
    updatedAt: approvedAt,
    reason: null,
  };
  writeGitHubWriteApprovalArtifact(approvedApproval);
  appendGitHubWriteEvent({
    previewId,
    source,
    capabilityKey: preview.capabilityKey,
    status: 'approved',
    eventName: 'approval.approved',
    details: {
      approvedAt,
    },
  });
  appendGitHubWriteEvent({
    previewId,
    source,
    capabilityKey: preview.capabilityKey,
    status: 'running',
    eventName: 'apply.started',
    details: typeof previewSpec.buildStartedDetails === 'function'
      ? previewSpec.buildStartedDetails(preview)
      : { target: preview?.target?.slug || null },
  });

  const tokenInfo = getEnvGitHubToken(options.env || process.env);
  report.githubApi.tokenPresent = !!tokenInfo.token;
  report.githubApi.tokenSource = tokenInfo.source || null;

  let response;
  let result = null;
  let customGithubApi = null;

  if (typeof previewSpec.execute === 'function') {
    const executionResult = await previewSpec.execute({
      previewRecord: preview,
      previewId,
      approvalRecord: approvedApproval,
      tokenInfo,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      env: options.env || process.env,
      requestGitHubJson,
    });

    response = {
      ok: executionResult?.ok === true,
      status: executionResult?.status ?? 0,
      data: executionResult?.data ?? null,
      error: executionResult?.error || null,
      requestUrl: executionResult?.requestUrl || executionResult?.githubApi?.requestUrl || null,
      rateLimit: executionResult?.rateLimit || executionResult?.githubApi?.rateLimit || null,
    };
    customGithubApi = executionResult?.githubApi || null;
    result = executionResult && Object.prototype.hasOwnProperty.call(executionResult, 'result')
      ? executionResult.result
      : (response.ok && typeof previewSpec.buildSuccessResult === 'function'
        ? previewSpec.buildSuccessResult(preview, response.data, executionResult)
        : null);
  } else {
    const apiRequest = typeof previewSpec.buildRequest === 'function'
      ? previewSpec.buildRequest(preview)
      : null;
    if (!apiRequest?.apiPath) {
      return buildErrorReport(report, 'INVALID_PREVIEW_SCHEMA', 'GitHub write preview could not be translated into an API request.');
    }

    response = await requestGitHubJson({
      apiPath: apiRequest.apiPath,
      apiBaseUrl: preview.target.apiBaseUrl || 'https://api.github.com',
      token: tokenInfo.token,
      method: apiRequest.method || 'POST',
      body: apiRequest.body,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });

    if (response.ok) {
      result = typeof previewSpec.buildSuccessResult === 'function'
        ? previewSpec.buildSuccessResult(preview, response.data)
        : null;
    }
  }

  report.githubApi = {
    ...report.githubApi,
    ...(customGithubApi || {}),
    attempted: customGithubApi?.attempted === true || true,
    status: response.status,
    rateLimit: customGithubApi?.rateLimit || response.rateLimit || null,
    error: response.error || response.data?.message || null,
    requestUrl: customGithubApi?.requestUrl || response.requestUrl || null,
  };

  if (response.ok) {
    const appliedAt = new Date().toISOString();
    const approvalSummary = summarizeGitHubWriteApprovalArtifactRecord({
      ...approvedApproval,
      status: 'applied',
      appliedAt,
      updatedAt: appliedAt,
    }, approval.filePath);
    const resultArtifact = writeGitHubWriteApplyResultArtifact({
      previewId,
      source,
      capabilityKey: preview.capabilityKey,
      status: 'applied',
      success: true,
      previewArtifact: report.previewArtifact,
      approvalArtifact: approvalSummary,
      target: preview.target,
      repoIdentity: preview.repoIdentity,
      execution: {
        status: 'applied',
        terminal: true,
        approvedAt,
        appliedAt,
      },
      githubApi: {
        attempted: true,
        status: response.status,
        rateLimit: response.rateLimit || null,
        requestUrl: response.requestUrl || null,
        error: null,
      },
      result,
    });

    const appliedApproval = writeGitHubWriteApprovalArtifact({
      ...approvedApproval,
      previewId,
      filePath: approval.filePath,
      status: 'applied',
      appliedAt,
      updatedAt: appliedAt,
      resultArtifact,
    });

    appendGitHubWriteEvent({
      previewId,
      source,
      capabilityKey: preview.capabilityKey,
      status: 'applied',
      eventName: 'apply.succeeded',
      details: typeof previewSpec.buildSucceededDetails === 'function'
        ? previewSpec.buildSucceededDetails(preview, result)
        : {},
    });

    report.approvalArtifact = appliedApproval;
    report.resultArtifact = resultArtifact;
    report.approval = {
      status: 'applied',
      approvalRequirement: approval.approvalRequirement || null,
      approvalMode: approval.approvalMode || null,
      expiresAt: approval.expiresAt || null,
      applyTokenHint: appliedApproval.applyTokenHint,
    };
    report.execution = {
      status: 'applied',
      terminal: true,
      approvedAt,
      appliedAt,
      alreadyApplied: false,
    };
    report.result = result;
    report.message = previewSpec.successMessage;
    return report;
  }

  const failureMessage = typeof previewSpec.buildFailureMessage === 'function'
    ? previewSpec.buildFailureMessage(preview, response)
    : (response.error || response.data?.message || `${previewSpec.subjectLabel || 'GitHub write preview'} apply failed (${response.status})`);
  const failedAt = new Date().toISOString();
  const failedApprovalSummary = summarizeGitHubWriteApprovalArtifactRecord({
    ...approvedApproval,
    status: 'failed',
    failedAt,
    updatedAt: failedAt,
  }, approval.filePath);
  const resultArtifact = writeGitHubWriteApplyResultArtifact({
    previewId,
    source,
    capabilityKey: preview.capabilityKey,
    status: 'failed',
    success: false,
    previewArtifact: report.previewArtifact,
    approvalArtifact: failedApprovalSummary,
    target: preview.target,
    repoIdentity: preview.repoIdentity,
    execution: {
      status: 'failed',
      terminal: true,
      approvedAt,
      failedAt,
    },
    githubApi: {
      attempted: true,
      status: response.status,
      rateLimit: response.rateLimit || null,
      requestUrl: response.requestUrl || null,
      error: failureMessage,
    },
    error: {
      code: 'GITHUB_API_FAILURE',
      message: failureMessage,
    },
  });

  const failedApproval = writeGitHubWriteApprovalArtifact({
    ...approvedApproval,
    previewId,
    filePath: approval.filePath,
    status: 'failed',
    failedAt,
    updatedAt: failedAt,
    resultArtifact,
    error: {
      code: 'GITHUB_API_FAILURE',
      message: failureMessage,
    },
  });

  appendGitHubWriteEvent({
    previewId,
    source,
    capabilityKey: preview.capabilityKey,
    status: 'failed',
    eventName: 'apply.failed',
    details: typeof previewSpec.buildFailedDetails === 'function'
      ? previewSpec.buildFailedDetails(preview, response)
      : {
          status: response.status,
          error: response.error || response.data?.message || null,
        },
  });

  report.success = false;
  report.error = 'GITHUB_API_FAILURE';
  report.message = failureMessage;
  report.approvalArtifact = failedApproval;
  report.resultArtifact = resultArtifact;
  report.approval = {
    status: 'failed',
    approvalRequirement: approval.approvalRequirement || null,
    approvalMode: approval.approvalMode || null,
    expiresAt: approval.expiresAt || null,
    applyTokenHint: failedApproval.applyTokenHint,
  };
  report.execution = {
    status: 'failed',
    terminal: true,
    approvedAt,
    failedAt,
    alreadyApplied: false,
  };
  return report;
}

module.exports = {
  GITHUB_WRITE_APPLY_SCHEMA_VERSION,
  applyGitHubWritePreview,
  buildUsageMessage,
};
