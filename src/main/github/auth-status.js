const fs = require('fs');
const path = require('path');

const { LIKU_HOME } = require('../../shared/liku-home');
const { getEnvGitHubToken, maskToken, requestGitHubJson } = require('./client');

const GITHUB_AUTH_STATUS_SCHEMA_VERSION = 'github.auth-status.v1';
const DEFAULT_COPILOT_TOKEN_FILE = path.join(LIKU_HOME, 'copilot-token.json');

function buildGovernanceAccessHints(options = {}) {
  const tokenPresent = options.tokenPresent === true;
  const authenticated = options.authenticated === true;
  const scopes = Array.isArray(options.scopes) ? options.scopes.slice() : [];
  const normalizedScopes = scopes.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean);
  const warnings = [];

  if (!tokenPresent) {
    warnings.push('Repository governance inventory usually needs GH_TOKEN or GITHUB_TOKEN, and several endpoints also require repository administration access.');
  } else if (authenticated && normalizedScopes.length > 0) {
    const hasRepoGradeScope = normalizedScopes.some((scope) => ['repo', 'public_repo', 'admin:repo_hook', 'read:org'].includes(scope));
    if (!hasRepoGradeScope) {
      warnings.push('Current GitHub scopes do not advertise repo/admin-style access; rulesets, environments, secrets, variables, webhooks, or app-installation inspection may return limited results.');
    }
  }

  return {
    hints: [
      {
        id: 'repo-governance-admin',
        title: 'Repository administration access is commonly required for governance inventory.',
        capabilities: [
          'ruleset.list',
          'ruleset.inspect',
          'environment.list',
          'environment.inspect',
          'secret.list',
          'secret.inspect',
          'variable.list',
          'variable.inspect',
          'webhook.list',
          'webhook.inspect',
          'app.installation.inspect',
          'app.permissions.inspect',
        ],
      },
      {
        id: 'metadata-only-redaction',
        title: 'Sensitive governance surfaces stay metadata-only in model-visible output.',
        capabilities: [
          'secret.list',
          'secret.inspect',
          'variable.list',
          'variable.inspect',
          'webhook.inspect',
        ],
      },
    ],
    warnings,
    scopesObserved: scopes,
  };
}

function readCopilotTokenFileState(options = {}) {
  const fsModule = options.fsModule || fs;
  const tokenFile = options.tokenFile || DEFAULT_COPILOT_TOKEN_FILE;
  const state = {
    exists: false,
    path: tokenFile,
    savedAt: null,
  };

  try {
    if (!fsModule.existsSync(tokenFile)) {
      return state;
    }
    state.exists = true;
    const parsed = JSON.parse(fsModule.readFileSync(tokenFile, 'utf8'));
    if (parsed && typeof parsed.saved_at === 'string') {
      state.savedAt = parsed.saved_at;
    }
  } catch {}

  return state;
}

function summarizeViewer(data) {
  if (!data || typeof data !== 'object') {
    return null;
  }
  return {
    login: data.login || null,
    id: Number.isFinite(Number(data.id)) ? Number(data.id) : null,
    name: data.name || null,
    type: data.type || null,
    htmlUrl: data.html_url || null,
  };
}

async function resolveGitHubAuthStatus(options = {}) {
  const env = options.env || process.env;
  const aiService = options.aiService || require('../ai-service');
  const probe = options.probe !== false;
  const featureFlagEnabled = options.featureFlagEnabled === true;

  if (options.loadCopilotToken !== false && typeof aiService.loadCopilotTokenIfNeeded === 'function') {
    try {
      aiService.loadCopilotTokenIfNeeded();
    } catch {}
  }

  const aiStatus = typeof aiService.getStatus === 'function'
    ? aiService.getStatus()
    : {};
  const githubToken = options.tokenInfo || getEnvGitHubToken(env);
  const copilotTokenFile = readCopilotTokenFileState({
    fsModule: options.fsModule,
    tokenFile: options.copilotTokenFile,
  });

  const githubApi = {
    tokenPresent: !!githubToken.token,
    tokenSource: githubToken.source,
    tokenPreview: maskToken(githubToken.token),
    probeAttempted: false,
    authenticated: false,
    status: null,
    viewer: null,
    scopes: [],
    rateLimit: null,
    error: null,
  };

  if (probe && githubToken.token) {
    const response = await requestGitHubJson({
      apiPath: '/user',
      token: githubToken.token,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });
    githubApi.probeAttempted = true;
    githubApi.status = response.status;
    githubApi.scopes = response.scopes || [];
    githubApi.rateLimit = response.rateLimit || null;

    if (response.ok && response.data) {
      githubApi.authenticated = true;
      githubApi.viewer = summarizeViewer(response.data);
    } else {
      githubApi.error = response.error || response.data?.message || `GitHub API probe failed (${response.status})`;
    }
  }

  const warnings = [];
  if (!githubApi.tokenPresent) {
    warnings.push('Set GH_TOKEN or GITHUB_TOKEN to authenticate GitHub REST reads and inspect private repositories.');
  }
  if (aiStatus.hasCopilotKey && !githubApi.tokenPresent) {
    warnings.push('Copilot authentication may be available for chat/model flows, but GitHub REST inspection prefers GH_TOKEN or GITHUB_TOKEN.');
  }

  const governanceAccess = buildGovernanceAccessHints({
    tokenPresent: githubApi.tokenPresent,
    authenticated: githubApi.authenticated,
    scopes: githubApi.scopes,
  });
  warnings.push(...governanceAccess.warnings);

  return {
    schemaVersion: GITHUB_AUTH_STATUS_SCHEMA_VERSION,
    success: true,
    featureFlagEnabled,
    copilot: {
      authenticated: !!aiStatus.hasCopilotKey,
      provider: aiStatus.provider || null,
      model: aiStatus.model || null,
      modelName: aiStatus.modelName || null,
      tokenFile: copilotTokenFile,
      availableProviders: Array.isArray(aiStatus.availableProviders)
        ? aiStatus.availableProviders.slice()
        : [],
    },
    githubApi,
    governanceAccess,
    warnings,
  };
}

module.exports = {
  DEFAULT_COPILOT_TOKEN_FILE,
  GITHUB_AUTH_STATUS_SCHEMA_VERSION,
  buildGovernanceAccessHints,
  readCopilotTokenFileState,
  resolveGitHubAuthStatus,
};
