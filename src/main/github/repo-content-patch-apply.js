const { requestGitHubJson } = require('./client');
const { summarizePullRequest } = require('./pr-inspect');

function encodeContentPath(filePath) {
  return String(filePath || '')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function buildResponseStep(step, response) {
  return {
    step,
    ok: response?.ok === true,
    status: response?.status ?? 0,
    requestUrl: response?.requestUrl || null,
    error: response?.error || response?.data?.message || null,
  };
}

function buildFailureResult(step, response, requests, message) {
  const errorMessage = String(message || response?.error || response?.data?.message || 'GitHub repo-content patch apply failed.').trim();
  return {
    ok: false,
    status: response?.status ?? 0,
    data: response?.data || null,
    error: errorMessage,
    requestUrl: response?.requestUrl || null,
    rateLimit: response?.rateLimit || null,
    githubApi: {
      attempted: requests.length > 0,
      status: response?.status ?? 0,
      rateLimit: response?.rateLimit || null,
      requestUrl: response?.requestUrl || null,
      error: errorMessage,
      requests,
    },
  };
}

async function executeGitHubRepoContentPatchPreview(options = {}) {
  const previewRecord = options.previewRecord && typeof options.previewRecord === 'object'
    ? options.previewRecord
    : {};
  const tokenInfo = options.tokenInfo && typeof options.tokenInfo === 'object'
    ? options.tokenInfo
    : { token: '' };
  const target = previewRecord.target && typeof previewRecord.target === 'object'
    ? previewRecord.target
    : {};
  const owner = String(target.owner || '').trim();
  const repo = String(target.repo || '').trim();
  const filePath = String(target.path || '').trim();
  const baseBranch = String(target.baseBranch || '').trim();
  const headBranch = String(target.headBranch || '').trim();
  const changeOperation = String(target.changeOperation || '').trim().toLowerCase() || 'update';
  const resourceFamily = String(target.resourceFamily || '').trim().toLowerCase();
  const resourceLabel = resourceFamily === 'codeowners'
    ? 'CODEOWNERS file'
    : (resourceFamily === 'workflow' ? 'workflow file' : 'repository file');
  const changeLabel = resourceFamily === 'codeowners'
    ? 'CODEOWNERS change'
    : (resourceFamily === 'workflow' ? 'workflow change' : 'repo-content change');
  const commitMessage = String(previewRecord?.input?.title || target.commitMessage || '').trim();
  const pullRequestTitle = String(target.pullRequestTitle || '').trim();
  const pullRequestBody = String(target.pullRequestBody || '').trim();
  const contentBody = String(previewRecord?.input?.body || '');
  const encodedPath = encodeContentPath(filePath);
  const apiBaseUrl = String(target.apiBaseUrl || 'https://api.github.com').trim() || 'https://api.github.com';
  const requests = [];

  const requestStep = async (step, apiPath, method = 'GET', body) => {
    const response = await requestGitHubJson({
      apiPath,
      apiBaseUrl,
      token: tokenInfo.token,
      method,
      body,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });
    requests.push(buildResponseStep(step, response));
    return response;
  };

  const baseRef = await requestStep(
    'resolve-base-ref',
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
  );
  if (!baseRef.ok || !baseRef.data?.object?.sha) {
    return buildFailureResult('resolve-base-ref', baseRef, requests, baseRef.error || baseRef.data?.message || 'Could not resolve the base branch for the reviewed repo-content patch.');
  }

  const baseSha = String(baseRef.data.object.sha || '').trim();

  const headRef = await requestStep(
    'lookup-head-ref',
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(headBranch)}`,
  );

  if (!headRef.ok && headRef.status !== 404) {
    return buildFailureResult('lookup-head-ref', headRef, requests, headRef.error || headRef.data?.message || 'Could not inspect the target head branch for the reviewed repo-content patch.');
  }

  if (headRef.status === 404) {
    const createHeadRef = await requestStep(
      'create-head-ref',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`,
      'POST',
      {
        ref: `refs/heads/${headBranch}`,
        sha: baseSha,
      },
    );

    if (!createHeadRef.ok) {
      return buildFailureResult('create-head-ref', createHeadRef, requests, createHeadRef.error || createHeadRef.data?.message || 'Could not create the target head branch for the reviewed repo-content patch.');
    }
  }

  const existingContent = await requestStep(
    'lookup-content',
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(headBranch)}`,
  );

  if (changeOperation === 'create' && existingContent.ok) {
    return buildFailureResult('lookup-content', existingContent, requests, `${resourceLabel} already exists on branch ${headBranch}: ${filePath}`);
  }

  if (changeOperation === 'update' && existingContent.status === 404) {
    return buildFailureResult('lookup-content', existingContent, requests, `${resourceLabel} does not exist on branch ${headBranch}: ${filePath}`);
  }

  if (!existingContent.ok && existingContent.status !== 404) {
    return buildFailureResult('lookup-content', existingContent, requests, existingContent.error || existingContent.data?.message || `Could not inspect the current ${resourceLabel} contents before applying the reviewed patch.`);
  }

  const writeContent = await requestStep(
    'write-content',
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`,
    'PUT',
    {
      message: commitMessage,
      content: Buffer.from(contentBody, 'utf8').toString('base64'),
      branch: headBranch,
      ...(existingContent.ok && existingContent.data?.sha ? { sha: existingContent.data.sha } : {}),
    },
  );

  if (!writeContent.ok) {
    return buildFailureResult('write-content', writeContent, requests, writeContent.error || writeContent.data?.message || `Could not write the reviewed ${resourceLabel} to the target branch.`);
  }

  const createPullRequest = await requestStep(
    'create-pull-request',
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
    'POST',
    {
      title: pullRequestTitle,
      body: pullRequestBody,
      head: headBranch,
      base: baseBranch,
      draft: target.pullRequestDraft === true,
    },
  );

  if (!createPullRequest.ok) {
    return buildFailureResult('create-pull-request', createPullRequest, requests, createPullRequest.error || createPullRequest.data?.message || `Could not open the reviewed pull request for the ${changeLabel}.`);
  }

  const pullRequest = summarizePullRequest(createPullRequest.data);
  return {
    ok: true,
    status: createPullRequest.status,
    data: createPullRequest.data,
    result: {
      type: 'repo-content-patch',
      changeOperation,
      path: filePath,
      baseBranch,
      headBranch,
      commitMessage,
      pullRequest,
      content: {
        path: writeContent.data?.content?.path || filePath,
        sha: writeContent.data?.content?.sha || existingContent.data?.sha || null,
        htmlUrl: writeContent.data?.content?.html_url || null,
      },
    },
    githubApi: {
      attempted: true,
      status: createPullRequest.status,
      rateLimit: createPullRequest.rateLimit || writeContent.rateLimit || null,
      requestUrl: createPullRequest.requestUrl || writeContent.requestUrl || null,
      error: null,
      requests,
    },
  };
}

module.exports = {
  executeGitHubRepoContentPatchPreview,
};
