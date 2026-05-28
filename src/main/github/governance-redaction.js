const path = require('path');

function normalizeLimit(value, fallback = 10, max = 100) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(max, parsed));
}

function truncateText(value, maxLength = 160) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.length <= maxLength) return text;
  if (maxLength <= 1) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 1)}…`;
}

function normalizeArray(value, maxItems = 12) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, maxItems).map((entry) => {
    if (typeof entry === 'string') {
      return truncateText(entry, 120);
    }
    if (typeof entry === 'number' || typeof entry === 'boolean' || entry === null) {
      return entry;
    }
    if (entry && typeof entry === 'object') {
      return truncateText(JSON.stringify(entry), 120);
    }
    return truncateText(String(entry || ''), 120);
  }).filter((entry) => entry !== null && entry !== undefined && entry !== '');
}

function summarizeUrl(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  try {
    const parsed = new URL(text);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return truncateText(text, 160);
  }
}

function createGovernanceReadReport(options = {}) {
  const context = options.context && typeof options.context === 'object' ? options.context : {};
  return {
    schemaVersion: options.schemaVersion || 'github.governance-read.v1',
    success: true,
    featureFlagEnabled: options.featureFlagEnabled === true,
    repoIdentity: context.projectIdentity || null,
    remote: context.remote || null,
    target: context.target || null,
    targetSource: context.targetSource || null,
    githubApi: {
      ...(context.githubApi || {}),
      ...(options.githubApiExtra && typeof options.githubApiExtra === 'object' ? options.githubApiExtra : {}),
    },
    warnings: Array.isArray(context.warnings) ? context.warnings.slice() : [],
    ...(options.extra && typeof options.extra === 'object' ? options.extra : {}),
  };
}

function ensureGitHubRepositoryTarget(report, context, label, allowApi = true) {
  const normalizedLabel = String(label || 'inspection').trim() || 'inspection';

  if (!context?.target?.raw) {
    report.warnings.push(`No git remote detected; ${normalizedLabel} needs a GitHub repository target.`);
    return false;
  }

  if (!context.target.isGitHub || !context.target.slug) {
    report.warnings.push(`Detected target is not a GitHub repository; ${normalizedLabel} was skipped.`);
    return false;
  }

  if (!allowApi) {
    report.warnings.push(`GitHub ${normalizedLabel} skipped by request.`);
    return false;
  }

  return true;
}

function appendUnauthenticatedWarning(report, context, fallbackMessage) {
  if (!context?.tokenInfo?.token) {
    report.warnings.push(fallbackMessage || 'GH_TOKEN or GITHUB_TOKEN may be required for private repositories, elevated rate limits, or admin inventory endpoints.');
  }
}

function summarizeRulesetConditions(conditions) {
  if (!conditions || typeof conditions !== 'object') {
    return null;
  }

  return {
    refName: conditions.ref_name && typeof conditions.ref_name === 'object'
      ? {
          include: normalizeArray(conditions.ref_name.include, 12),
          exclude: normalizeArray(conditions.ref_name.exclude, 12),
        }
      : null,
    repositoryName: conditions.repository_name && typeof conditions.repository_name === 'object'
      ? {
          include: normalizeArray(conditions.repository_name.include, 12),
          exclude: normalizeArray(conditions.repository_name.exclude, 12),
        }
      : null,
    repositoryId: conditions.repository_id && typeof conditions.repository_id === 'object'
      ? {
          include: normalizeArray(conditions.repository_id.include, 12),
          exclude: normalizeArray(conditions.repository_id.exclude, 12),
        }
      : null,
  };
}

function summarizeRulesetRule(rule) {
  if (!rule || typeof rule !== 'object') {
    return null;
  }

  const parameterKeys = rule.parameters && typeof rule.parameters === 'object'
    ? Object.keys(rule.parameters).slice(0, 12)
    : [];

  return {
    type: rule.type || null,
    parameters: parameterKeys,
  };
}

function summarizeRulesetBypassActor(actor) {
  if (!actor || typeof actor !== 'object') {
    return null;
  }

  return {
    actorId: Number.isFinite(Number(actor.actor_id)) ? Number(actor.actor_id) : null,
    actorType: actor.actor_type || null,
    bypassMode: actor.bypass_mode || null,
  };
}

function summarizeRuleset(ruleset) {
  if (!ruleset || typeof ruleset !== 'object') {
    return null;
  }

  const rules = Array.isArray(ruleset.rules) ? ruleset.rules.map(summarizeRulesetRule).filter(Boolean) : [];
  const bypassActors = Array.isArray(ruleset.bypass_actors)
    ? ruleset.bypass_actors.map(summarizeRulesetBypassActor).filter(Boolean)
    : [];

  return {
    id: Number.isFinite(Number(ruleset.id)) ? Number(ruleset.id) : null,
    name: ruleset.name || null,
    target: ruleset.target || null,
    sourceType: ruleset.source_type || null,
    source: ruleset.source || null,
    enforcement: ruleset.enforcement || null,
    currentUserCanBypass: ruleset.current_user_can_bypass === true,
    nodeId: ruleset.node_id || null,
    createdAt: ruleset.created_at || null,
    updatedAt: ruleset.updated_at || null,
    rulesCount: rules.length,
    ruleTypes: rules.map((entry) => entry.type).filter(Boolean),
    rules,
    bypassActorCount: bypassActors.length,
    bypassActors,
    conditions: summarizeRulesetConditions(ruleset.conditions),
  };
}

function summarizeDeploymentBranchPolicy(policy) {
  if (!policy || typeof policy !== 'object') {
    return null;
  }

  return {
    protectedBranches: policy.protected_branches === true,
    customBranchPolicies: policy.custom_branch_policies === true,
  };
}

function summarizeEnvironmentProtectionRule(rule) {
  if (!rule || typeof rule !== 'object') {
    return null;
  }

  const reviewers = Array.isArray(rule.reviewers) ? rule.reviewers : [];
  return {
    id: Number.isFinite(Number(rule.id)) ? Number(rule.id) : null,
    type: rule.type || null,
    waitTimer: Number.isFinite(Number(rule.wait_timer)) ? Number(rule.wait_timer) : null,
    reviewerCount: reviewers.length,
    reviewers: reviewers.slice(0, 10).map((entry) => ({
      type: entry?.type || null,
      reviewer: entry?.reviewer
        ? {
            login: entry.reviewer.login || null,
            type: entry.reviewer.type || null,
            htmlUrl: entry.reviewer.html_url || null,
          }
        : null,
    })),
    preventSelfReview: rule.prevent_self_review === true,
  };
}

function summarizeEnvironment(environment) {
  if (!environment || typeof environment !== 'object') {
    return null;
  }

  const protectionRules = Array.isArray(environment.protection_rules)
    ? environment.protection_rules.map(summarizeEnvironmentProtectionRule).filter(Boolean)
    : [];

  return {
    id: Number.isFinite(Number(environment.id)) ? Number(environment.id) : null,
    nodeId: environment.node_id || null,
    name: environment.name || null,
    htmlUrl: environment.html_url || null,
    createdAt: environment.created_at || null,
    updatedAt: environment.updated_at || null,
    protectionRuleCount: protectionRules.length,
    protectionRules,
    waitTimer: protectionRules.reduce((maxValue, rule) => Math.max(maxValue, Number(rule.waitTimer) || 0), 0) || null,
    reviewerCount: protectionRules.reduce((count, rule) => count + (Number(rule.reviewerCount) || 0), 0),
    deploymentBranchPolicy: summarizeDeploymentBranchPolicy(environment.deployment_branch_policy || environment.deployment_branch_policy),
    canAdminsBypass: environment.can_admins_bypass === true,
    preventSelfReview: protectionRules.some((rule) => rule.preventSelfReview === true),
  };
}

function sanitizeSecretMetadata(secret) {
  if (!secret || typeof secret !== 'object') {
    return null;
  }

  return {
    name: secret.name || null,
    visibility: secret.visibility || null,
    selectedRepositoriesUrl: summarizeUrl(secret.selected_repositories_url),
    selectedRepositoriesCount: Number.isFinite(Number(secret.selected_repositories_count || secret.num_selected_repos))
      ? Number(secret.selected_repositories_count || secret.num_selected_repos)
      : null,
    createdAt: secret.created_at || null,
    updatedAt: secret.updated_at || null,
    valueExposed: false,
  };
}

function sanitizeVariableMetadata(variable) {
  if (!variable || typeof variable !== 'object') {
    return null;
  }

  return {
    name: variable.name || null,
    visibility: variable.visibility || null,
    selectedRepositoriesUrl: summarizeUrl(variable.selected_repositories_url),
    selectedRepositoriesCount: Number.isFinite(Number(variable.selected_repositories_count || variable.num_selected_repos))
      ? Number(variable.selected_repositories_count || variable.num_selected_repos)
      : null,
    createdAt: variable.created_at || null,
    updatedAt: variable.updated_at || null,
    valueExposed: false,
    valuePresent: Object.prototype.hasOwnProperty.call(variable, 'value'),
  };
}

function sanitizeWebhookConfig(config) {
  if (!config || typeof config !== 'object') {
    return null;
  }

  const result = {};
  Object.entries(config).forEach(([key, value]) => {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) {
      return;
    }

    if (/(secret|token|password|authorization|auth|key)$/i.test(normalizedKey)) {
      result[normalizedKey] = '[redacted]';
      return;
    }

    if (/url/i.test(normalizedKey)) {
      result[normalizedKey] = summarizeUrl(value);
      return;
    }

    if (typeof value === 'string') {
      result[normalizedKey] = truncateText(value, 120);
      return;
    }

    if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      result[normalizedKey] = value;
      return;
    }

    if (Array.isArray(value)) {
      result[normalizedKey] = normalizeArray(value, 8);
      return;
    }

    result[normalizedKey] = '[object]';
  });

  return result;
}

function summarizeWebhookResponse(response) {
  if (!response || typeof response !== 'object') {
    return null;
  }

  return {
    code: Number.isFinite(Number(response.code)) ? Number(response.code) : null,
    status: response.status || null,
    message: truncateText(response.message, 120),
  };
}

function summarizeWebhook(hook) {
  if (!hook || typeof hook !== 'object') {
    return null;
  }

  return {
    id: Number.isFinite(Number(hook.id)) ? Number(hook.id) : null,
    type: hook.type || null,
    name: hook.name || null,
    active: hook.active === true,
    events: normalizeArray(hook.events, 20),
    eventCount: Array.isArray(hook.events) ? hook.events.length : 0,
    config: sanitizeWebhookConfig(hook.config),
    deliveriesUrl: summarizeUrl(hook.deliveries_url),
    pingUrl: summarizeUrl(hook.ping_url),
    testUrl: summarizeUrl(hook.test_url),
    url: summarizeUrl(hook.url),
    createdAt: hook.created_at || null,
    updatedAt: hook.updated_at || null,
    lastResponse: summarizeWebhookResponse(hook.last_response),
  };
}

function summarizeInstallationAccount(account) {
  if (!account || typeof account !== 'object') {
    return null;
  }

  return {
    login: account.login || null,
    id: Number.isFinite(Number(account.id)) ? Number(account.id) : null,
    type: account.type || null,
    htmlUrl: account.html_url || null,
  };
}

function summarizeInstallation(installation, includePermissions = true) {
  if (!installation || typeof installation !== 'object') {
    return null;
  }

  return {
    id: Number.isFinite(Number(installation.id)) ? Number(installation.id) : null,
    appId: Number.isFinite(Number(installation.app_id)) ? Number(installation.app_id) : null,
    appSlug: installation.app_slug || null,
    targetId: Number.isFinite(Number(installation.target_id)) ? Number(installation.target_id) : null,
    targetType: installation.target_type || null,
    account: summarizeInstallationAccount(installation.account),
    repositorySelection: installation.repository_selection || null,
    accessTokensUrl: summarizeUrl(installation.access_tokens_url),
    repositoriesUrl: summarizeUrl(installation.repositories_url),
    htmlUrl: summarizeUrl(installation.html_url),
    createdAt: installation.created_at || null,
    updatedAt: installation.updated_at || null,
    singleFileName: installation.single_file_name || null,
    singleFilePaths: normalizeArray(installation.single_file_paths, 20),
    hasMultipleSingleFiles: Array.isArray(installation.single_file_paths) && installation.single_file_paths.length > 1,
    events: normalizeArray(installation.events, 30),
    permissions: includePermissions && installation.permissions && typeof installation.permissions === 'object'
      ? { ...installation.permissions }
      : null,
    suspendedAt: installation.suspended_at || null,
    suspendedBy: summarizeInstallationAccount(installation.suspended_by),
  };
}

function sanitizeTemplatePreview(text, maxLines = 6) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => truncateText(line, 120))
    .filter(Boolean)
    .slice(0, maxLines);
  return lines;
}

function detectTemplateTitle(text, fallbackFilePath) {
  const value = String(text || '');
  const yamlNameMatch = value.match(/^name:\s*(.+)$/im);
  if (yamlNameMatch) {
    return truncateText(yamlNameMatch[1].replace(/^['"]|['"]$/g, ''), 120);
  }

  const markdownHeadingMatch = value.match(/^#\s+(.+)$/m);
  if (markdownHeadingMatch) {
    return truncateText(markdownHeadingMatch[1], 120);
  }

  return truncateText(path.basename(String(fallbackFilePath || 'template')), 120);
}

function summarizeTemplateFileContent(text, filePath) {
  const normalizedPath = String(filePath || '').trim() || null;
  const extension = normalizedPath ? path.extname(normalizedPath).toLowerCase() : null;
  const previewLines = sanitizeTemplatePreview(text, 6);
  const lineCount = String(text || '').split(/\r?\n/).length;
  const issueTemplate = /issue_template/i.test(normalizedPath || '');
  const pullRequestTemplate = /pull_request_template|pull request template/i.test(normalizedPath || '');

  return {
    path: normalizedPath,
    fileName: normalizedPath ? path.basename(normalizedPath) : null,
    extension,
    kind: issueTemplate ? 'issue-template' : (pullRequestTemplate ? 'pull-request-template' : 'template'),
    title: detectTemplateTitle(text, normalizedPath),
    lineCount,
    previewLines,
    hasContent: String(text || '').trim().length > 0,
  };
}

function parseCodeownersEntries(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line, index) => ({
      raw: String(line || '').trim(),
      lineNumber: index + 1,
    }))
    .filter((entry) => entry.raw && !entry.raw.startsWith('#'))
    .map((entry) => {
      const parts = entry.raw.split(/\s+/).filter(Boolean);
      return {
        lineNumber: entry.lineNumber,
        pattern: parts[0] || null,
        owners: parts.slice(1),
      };
    })
    .filter((entry) => entry.pattern && entry.owners.length > 0);
}

function summarizeCodeownersText(text, filePath) {
  const entries = parseCodeownersEntries(text);
  const owners = [...new Set(entries.flatMap((entry) => entry.owners))].slice(0, 40);
  return {
    path: String(filePath || '').trim() || null,
    lineCount: String(text || '').split(/\r?\n/).length,
    entryCount: entries.length,
    ownerCount: owners.length,
    owners,
    entries: entries.slice(0, 12).map((entry) => ({
      lineNumber: entry.lineNumber,
      pattern: entry.pattern,
      owners: entry.owners.slice(0, 12),
      ownerCount: entry.owners.length,
      preview: truncateText(`${entry.pattern} ${entry.owners.join(' ')}`, 160),
    })),
  };
}

function decodeGitHubContent(content, encoding = 'base64') {
  const text = String(content || '');
  if (!text) return '';
  const normalizedEncoding = String(encoding || 'base64').trim().toLowerCase();
  if (normalizedEncoding !== 'base64') {
    return text;
  }
  return Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('utf8');
}

function isLocalRepoTargetMatch(context) {
  const remoteSlug = String(context?.remote?.slug || '').trim().toLowerCase();
  const targetSlug = String(context?.target?.slug || '').trim().toLowerCase();
  const projectRoot = String(context?.projectIdentity?.projectRoot || '').trim();
  if (!projectRoot) {
    return false;
  }
  if (!targetSlug) {
    return true;
  }
  if (!remoteSlug) {
    return false;
  }
  return remoteSlug === targetSlug;
}

module.exports = {
  appendUnauthenticatedWarning,
  createGovernanceReadReport,
  decodeGitHubContent,
  ensureGitHubRepositoryTarget,
  isLocalRepoTargetMatch,
  normalizeLimit,
  sanitizeSecretMetadata,
  sanitizeTemplatePreview,
  sanitizeVariableMetadata,
  sanitizeWebhookConfig,
  summarizeCodeownersText,
  summarizeDeploymentBranchPolicy,
  summarizeEnvironment,
  summarizeEnvironmentProtectionRule,
  summarizeInstallation,
  summarizeRuleset,
  summarizeTemplateFileContent,
  summarizeUrl,
  summarizeWebhook,
  truncateText,
};
