const fs = require('fs');
const path = require('path');

const {
  collectWorkflowPolicyViolations,
  stripInlineComment,
} = require('./workflow-policy');

const externalActionPattern = /^\s*(?:-\s*)?uses:\s*(['"]?)([^'"\n]+)\1\s*$/gm;
const secretReferencePattern = /\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/g;
const varReferencePattern = /\$\{\{\s*vars\.([A-Za-z0-9_]+)\s*\}\}/g;
const inputReferencePattern = /\$\{\{\s*inputs\.([A-Za-z0-9_]+)\s*\}\}/g;

function normalizeWorkflowPath(value) {
  const text = String(value || '').trim();
  if (!text) {
    return null;
  }

  return text
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .trim() || null;
}

function isWorkflowFilePath(value) {
  return /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(String(value || '').trim());
}

function getIndentLength(value) {
  return String(value || '').match(/^\s*/)[0].length;
}

function normalizeScalarValue(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1).trim();
  }

  return text;
}

function uniqueSorted(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((entry) => String(entry || '').trim())
    .filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

function parseInlineArray(value) {
  const text = String(value || '').trim();
  if (!text.startsWith('[') || !text.endsWith(']')) {
    return [];
  }

  return uniqueSorted(text
    .slice(1, -1)
    .split(',')
    .map((entry) => normalizeScalarValue(entry))
    .filter(Boolean));
}

function parseInlineObject(value) {
  const text = String(value || '').trim();
  if (!text.startsWith('{') || !text.endsWith('}')) {
    return {};
  }

  const body = text.slice(1, -1).trim();
  if (!body) {
    return {};
  }

  const entries = {};
  body.split(',').forEach((entry) => {
    const separatorIndex = entry.indexOf(':');
    if (separatorIndex < 0) {
      return;
    }

    const key = normalizeScalarValue(entry.slice(0, separatorIndex)).toLowerCase();
    const rawValue = normalizeScalarValue(entry.slice(separatorIndex + 1)).toLowerCase();
    if (!key) {
      return;
    }

    entries[key] = rawValue || null;
  });

  return entries;
}

function readNestedScalar(lines, startIndex, keyName) {
  const baseIndent = getIndentLength(lines[startIndex]);

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const stripped = stripInlineComment(lines[index]);
    if (!stripped) {
      continue;
    }

    const indent = getIndentLength(lines[index]);
    if (indent <= baseIndent) {
      break;
    }

    const match = stripped.match(new RegExp(`^${keyName}:\\s*(.*)$`));
    if (match) {
      return normalizeScalarValue(match[1]);
    }
  }

  return null;
}

function parsePermissionsAt(lines, startIndex) {
  const stripped = stripInlineComment(lines[startIndex]);
  const match = stripped.match(/^permissions:\s*(.*)$/i);
  if (!match) {
    return {
      values: null,
      mode: 'missing',
      raw: null,
    };
  }

  const inlineValue = String(match[1] || '').trim();
  if (inlineValue) {
    const inlineObject = parseInlineObject(inlineValue);
    if (inlineValue === '{}' || Object.keys(inlineObject).length > 0) {
      return {
        values: inlineObject,
        mode: inlineValue === '{}' ? 'deny-all' : 'inline',
        raw: inlineValue,
      };
    }

    return {
      values: { __raw: normalizeScalarValue(inlineValue).toLowerCase() || null },
      mode: 'scalar',
      raw: inlineValue,
    };
  }

  const baseIndent = getIndentLength(lines[startIndex]);
  const values = {};

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const nested = stripInlineComment(lines[index]);
    if (!nested) {
      continue;
    }

    const indent = getIndentLength(lines[index]);
    if (indent <= baseIndent) {
      break;
    }

    const nestedMatch = nested.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!nestedMatch) {
      continue;
    }

    const key = String(nestedMatch[1] || '').trim().toLowerCase();
    const value = normalizeScalarValue(nestedMatch[2]).toLowerCase() || null;
    if (key) {
      values[key] = value;
    }
  }

  return {
    values,
    mode: Object.keys(values).length === 0 ? 'block-empty' : 'block',
    raw: null,
  };
}

function findTopLevelScalar(lines, keyName) {
  for (let index = 0; index < lines.length; index += 1) {
    const stripped = stripInlineComment(lines[index]);
    if (!stripped || getIndentLength(lines[index]) !== 0) {
      continue;
    }

    const match = stripped.match(new RegExp(`^${keyName}:\\s*(.*)$`, 'i'));
    if (match) {
      return normalizeScalarValue(match[1]);
    }
  }

  return null;
}

function collectTopLevelTriggers(lines) {
  const triggers = [];

  for (let index = 0; index < lines.length; index += 1) {
    const stripped = stripInlineComment(lines[index]);
    if (!stripped || getIndentLength(lines[index]) !== 0) {
      continue;
    }

    const match = stripped.match(/^on:\s*(.*)$/i);
    if (!match) {
      continue;
    }

    const inlineValue = String(match[1] || '').trim();
    if (inlineValue) {
      if (inlineValue.startsWith('[')) {
        triggers.push(...parseInlineArray(inlineValue));
      } else {
        triggers.push(...String(inlineValue)
          .split(',')
          .map((entry) => normalizeScalarValue(entry))
          .filter(Boolean));
      }
      return uniqueSorted(triggers);
    }

    const baseIndent = getIndentLength(lines[index]);
    for (let nestedIndex = index + 1; nestedIndex < lines.length; nestedIndex += 1) {
      const nested = stripInlineComment(lines[nestedIndex]);
      if (!nested) {
        continue;
      }

      const indent = getIndentLength(lines[nestedIndex]);
      if (indent <= baseIndent) {
        break;
      }
      if (indent !== baseIndent + 2) {
        continue;
      }

      const nestedMatch = nested.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (nestedMatch) {
        triggers.push(String(nestedMatch[1] || '').trim());
      }
    }

    return uniqueSorted(triggers);
  }

  return [];
}

function collectJobs(lines) {
  const jobs = [];
  let jobsStartIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const stripped = stripInlineComment(lines[index]);
    if (stripped === 'jobs:' && getIndentLength(lines[index]) === 0) {
      jobsStartIndex = index;
      break;
    }
    if (/^jobs:\s*\{\s*\}\s*$/i.test(stripped) && getIndentLength(lines[index]) === 0) {
      return [];
    }
  }

  if (jobsStartIndex < 0) {
    return [];
  }

  let currentJob = null;

  for (let index = jobsStartIndex + 1; index < lines.length; index += 1) {
    const stripped = stripInlineComment(lines[index]);
    if (!stripped) {
      continue;
    }

    const indent = getIndentLength(lines[index]);
    if (indent <= 0) {
      break;
    }

    if (indent === 2) {
      const match = stripped.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!match) {
        currentJob = null;
        continue;
      }

      currentJob = {
        id: String(match[1] || '').trim(),
        name: null,
        environment: null,
        permissions: null,
      };
      jobs.push(currentJob);
      continue;
    }

    if (!currentJob) {
      continue;
    }

    if (indent === 4 && /^name:\s*/i.test(stripped)) {
      currentJob.name = normalizeScalarValue(stripped.replace(/^name:\s*/i, '')) || null;
      continue;
    }

    if (indent === 4 && /^environment:\s*/i.test(stripped)) {
      const inlineEnvironment = normalizeScalarValue(stripped.replace(/^environment:\s*/i, ''));
      currentJob.environment = inlineEnvironment || readNestedScalar(lines, index, 'name') || null;
      continue;
    }

    if (indent === 4 && /^permissions:\s*/i.test(stripped)) {
      currentJob.permissions = parsePermissionsAt(lines, index).values || {};
    }
  }

  return jobs;
}

function inspectWorkflowPermissions(textOrLines) {
  const lines = Array.isArray(textOrLines)
    ? textOrLines.slice()
    : String(textOrLines || '').split(/\r?\n/);

  let topLevel = null;
  let topLevelMode = 'missing';
  for (let index = 0; index < lines.length; index += 1) {
    const stripped = stripInlineComment(lines[index]);
    if (!stripped || getIndentLength(lines[index]) !== 0) {
      continue;
    }

    if (/^permissions:\s*/i.test(stripped)) {
      const parsed = parsePermissionsAt(lines, index);
      topLevel = parsed.values;
      topLevelMode = parsed.mode;
      break;
    }
  }

  const jobs = collectJobs(lines).map((job) => ({
    id: job.id,
    name: job.name,
    environment: job.environment,
    permissions: job.permissions,
  }));

  const writeScopes = [];
  if (topLevel && typeof topLevel === 'object') {
    Object.entries(topLevel).forEach(([scope, level]) => {
      if (String(level || '').trim().toLowerCase() === 'write') {
        writeScopes.push(`workflow:${scope}`);
      }
    });
  }
  jobs.forEach((job) => {
    if (!job.permissions || typeof job.permissions !== 'object') {
      return;
    }

    Object.entries(job.permissions).forEach(([scope, level]) => {
      if (String(level || '').trim().toLowerCase() === 'write') {
        writeScopes.push(`${job.id}:${scope}`);
      }
    });
  });

  return {
    hasTopLevelPermissions: topLevel !== null,
    topLevelPermissions: topLevel,
    topLevelMode,
    jobs,
    writeScopes: uniqueSorted(writeScopes),
    hasWritePermissions: writeScopes.length > 0,
  };
}

function collectRequirementsFromText(text) {
  const actionReferences = [];
  const secrets = [];
  const vars = [];
  const inputs = [];

  for (const match of String(text || '').matchAll(externalActionPattern)) {
    const reference = normalizeScalarValue(match[2]);
    if (reference) {
      actionReferences.push(reference);
    }
  }

  for (const match of String(text || '').matchAll(secretReferencePattern)) {
    secrets.push(String(match[1] || '').trim());
  }
  for (const match of String(text || '').matchAll(varReferencePattern)) {
    vars.push(String(match[1] || '').trim());
  }
  for (const match of String(text || '').matchAll(inputReferencePattern)) {
    inputs.push(String(match[1] || '').trim());
  }

  const reusableWorkflows = actionReferences.filter((reference) => /\.github\/workflows\/.+@/i.test(reference) || /^\.\/\.github\/workflows\/.+/i.test(reference));

  return {
    actionReferences: uniqueSorted(actionReferences),
    reusableWorkflows: uniqueSorted(reusableWorkflows),
    secrets: uniqueSorted(secrets),
    vars: uniqueSorted(vars),
    inputs: uniqueSorted(inputs),
  };
}

function inspectWorkflowRequirements(textOrLines) {
  const text = Array.isArray(textOrLines)
    ? textOrLines.join('\n')
    : String(textOrLines || '');
  const lines = Array.isArray(textOrLines)
    ? textOrLines.slice()
    : text.split(/\r?\n/);
  const textRequirements = collectRequirementsFromText(text);
  const environments = uniqueSorted(collectJobs(lines)
    .map((job) => job.environment)
    .filter(Boolean));

  return {
    ...textRequirements,
    environments,
  };
}

function analyzeWorkflowDefinition(options = {}) {
  const text = String(options.text || '');
  const lines = text.split(/\r?\n/);
  const workflowPath = normalizeWorkflowPath(options.workflowPath || options.path);
  const fileName = path.basename(workflowPath || options.fileName || 'workflow.yml');
  const name = findTopLevelScalar(lines, 'name');
  const triggers = collectTopLevelTriggers(lines);
  const jobs = collectJobs(lines);
  const permissions = inspectWorkflowPermissions(lines);
  const requirements = inspectWorkflowRequirements(lines);
  const policyCheck = collectWorkflowPolicyViolations({ [fileName]: text });
  const validationErrors = [];
  const warnings = [];

  if (!text.trim()) {
    validationErrors.push('Workflow content is empty.');
  }
  if (!name) {
    validationErrors.push('Workflow is missing a top-level name.');
  }
  if (triggers.length === 0) {
    validationErrors.push('Workflow is missing a top-level on: trigger block.');
  }
  if (jobs.length === 0) {
    validationErrors.push('Workflow is missing a jobs: block with at least one job.');
  }
  if (/\t/.test(text)) {
    warnings.push('Workflow content contains tab characters; GitHub Actions YAML should use spaces for indentation.');
  }
  if (workflowPath && !isWorkflowFilePath(workflowPath)) {
    warnings.push('Workflow path is outside .github/workflows or does not use a .yml/.yaml extension.');
  }
  if (!permissions.hasTopLevelPermissions) {
    warnings.push('Workflow does not declare an explicit top-level permissions block.');
  }

  return {
    workflowPath,
    fileName,
    warnings,
    summary: {
      name,
      triggers,
      jobCount: jobs.length,
      jobs: jobs.map((job) => ({
        id: job.id,
        name: job.name,
        environment: job.environment,
      })),
      actionCount: requirements.actionReferences.length,
      secretCount: requirements.secrets.length,
      variableCount: requirements.vars.length,
      inputCount: requirements.inputs.length,
      environmentCount: requirements.environments.length,
      withinWorkflowsDir: workflowPath ? isWorkflowFilePath(workflowPath) : null,
    },
    validation: {
      valid: validationErrors.length === 0,
      errors: validationErrors,
      warnings: warnings.slice(),
      checks: {
        hasName: !!name,
        hasTriggers: triggers.length > 0,
        hasJobs: jobs.length > 0,
        hasTopLevelPermissions: permissions.hasTopLevelPermissions,
      },
    },
    permissions,
    requirements,
    policy: {
      workflowCount: policyCheck.workflowCount,
      checkedActions: policyCheck.checkedActions,
      violationCount: policyCheck.violations.length,
      violations: policyCheck.violations,
    },
  };
}

function resolveWorkflowTextInput(options = {}) {
  const cwd = String(options.cwd || process.cwd());
  const usageMessage = String(options.usageMessage || 'Usage: liku github workflow validate <path> [--body <text> | --body-file <path>]').trim();
  const emptyBodyMessage = String(options.emptyBodyMessage || 'GitHub workflow commands require non-empty workflow content.').trim();
  const requirePath = options.requirePath === true;
  const workflowPathRaw = options.path || options.workflowPath || options['workflow-path'] || options.filePath || null;
  const workflowPath = normalizeWorkflowPath(workflowPathRaw);
  const inlineBody = typeof options.body === 'string' ? options.body : null;
  const bodyFileRaw = options.bodyFile || options['body-file'] || null;

  if (inlineBody !== null && bodyFileRaw) {
    return {
      ok: false,
      error: 'USAGE',
      message: 'Specify either --body or --body-file, not both.',
    };
  }

  if (inlineBody !== null) {
    if (!String(inlineBody || '').trim()) {
      return {
        ok: false,
        error: 'EMPTY_WORKFLOW_BODY',
        message: emptyBodyMessage,
      };
    }

    if (requirePath && !workflowPath) {
      return {
        ok: false,
        error: 'USAGE',
        message: usageMessage,
      };
    }

    return {
      ok: true,
      body: inlineBody,
      bodySource: 'inline',
      bodyFilePath: null,
      workflowPath,
      localPath: workflowPathRaw ? path.resolve(cwd, String(workflowPathRaw)) : null,
    };
  }

  if (bodyFileRaw) {
    const bodyFilePath = path.resolve(cwd, String(bodyFileRaw));
    if (!fs.existsSync(bodyFilePath)) {
      return {
        ok: false,
        error: 'BODY_FILE_NOT_FOUND',
        message: `Workflow body file not found: ${bodyFilePath}`,
      };
    }

    const body = fs.readFileSync(bodyFilePath, 'utf8');
    if (!String(body || '').trim()) {
      return {
        ok: false,
        error: 'EMPTY_WORKFLOW_BODY',
        message: emptyBodyMessage,
      };
    }

    const inferredWorkflowPath = workflowPath || normalizeWorkflowPath(path.relative(cwd, bodyFilePath));
    if (requirePath && !inferredWorkflowPath) {
      return {
        ok: false,
        error: 'USAGE',
        message: usageMessage,
      };
    }

    return {
      ok: true,
      body,
      bodySource: 'file',
      bodyFilePath,
      workflowPath: inferredWorkflowPath,
      localPath: bodyFilePath,
    };
  }

  if (workflowPathRaw) {
    const localPath = path.resolve(cwd, String(workflowPathRaw));
    if (!fs.existsSync(localPath)) {
      return {
        ok: false,
        error: 'WORKFLOW_FILE_NOT_FOUND',
        message: `Workflow file not found: ${localPath}`,
      };
    }

    const body = fs.readFileSync(localPath, 'utf8');
    if (!String(body || '').trim()) {
      return {
        ok: false,
        error: 'EMPTY_WORKFLOW_BODY',
        message: emptyBodyMessage,
      };
    }

    return {
      ok: true,
      body,
      bodySource: 'path',
      bodyFilePath: localPath,
      workflowPath,
      localPath,
    };
  }

  return {
    ok: false,
    error: 'USAGE',
    message: usageMessage,
  };
}

module.exports = {
  analyzeWorkflowDefinition,
  inspectWorkflowPermissions,
  inspectWorkflowRequirements,
  isWorkflowFilePath,
  normalizeWorkflowPath,
  resolveWorkflowTextInput,
};
