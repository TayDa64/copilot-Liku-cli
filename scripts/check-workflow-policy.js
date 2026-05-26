'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');

const pinnedRefPattern = /^[0-9a-f]{40}$/i;
const usesPattern = /^\s*(?:-\s*)?uses:\s*(['"]?)([^'"\n]+)\1\s*$/gm;
const permissionsPattern = /^\s*permissions:\s*(?:\{.*\})?\s*$/m;
const pullRequestTargetPattern = /^\s*pull_request_target:\s*$/m;
const checkoutUsePattern = /^\s*uses:\s*actions\/checkout@[0-9a-f]{40}\s*$/;
const topLevelDenyAllPermissionsPattern = /^permissions:\s*\{\}\s*$/m;

const coreHardenedWorkflows = new Set(['validate.yml', 'test.yml', 'package.yml', 'policy.yml', 'release.yml']);

const requiredWorkflowPatterns = {
  'policy.yml': [
    {
      pattern: /actions\/dependency-review-action@[0-9a-f]{40}/,
      message: 'must run a pinned dependency review action',
    },
    {
      pattern: /gitleaks\/gitleaks-action@[0-9a-f]{40}/,
      message: 'must run a pinned gitleaks secret scan action',
    },
  ],
  'package.yml': [
    {
      pattern: /npm run verify:package/,
      message: 'must verify package contents before packaging artifacts',
    },
    {
      pattern: /npm sbom\b/,
      message: 'must generate an npm SBOM artifact',
    },
    {
      pattern: /sbom\.spdx\.json/,
      message: 'must upload the generated SBOM artifact',
    },
  ],
  'release.yml': [
    {
      pattern: /^\s*environment:\s*npm-release\s*$/m,
      message: 'must require the npm-release protected environment',
    },
    {
      pattern: /^\s*attestations:\s*write\s*$/m,
      message: 'must request attestations: write',
    },
    {
      pattern: /^\s*id-token:\s*write\s*$/m,
      message: 'must request id-token: write for trusted publishing',
    },
    {
      pattern: /npm run verify:workflow-policy/,
      message: 'must verify workflow policy before publishing',
    },
    {
      pattern: /git describe --tags --exact-match HEAD/,
      message: 'must verify the release is built from an exact git tag',
    },
    {
      pattern: /require\(['"]\.\/package\.json['"]\)\.version/,
      message: 'must compare the git tag with package.json version',
    },
    {
      pattern: /fetch-depth:\s*0/,
      message: 'must fetch tag history for release validation',
    },
    {
      pattern: /npm sbom\b/,
      message: 'must generate a release SBOM',
    },
    {
      pattern: /actions\/attest-build-provenance@[0-9a-f]{40}/,
      message: 'must attest release tarball provenance',
    },
    {
      pattern: /actions\/attest-sbom@[0-9a-f]{40}/,
      message: 'must attest the release SBOM',
    },
    {
      pattern: /npm publish .*--provenance/,
      message: 'must publish with npm provenance enabled',
    },
  ],
};

function stripInlineComment(value) {
  return value.replace(/\s+#.*$/, '').trim();
}

function getIndentLength(value) {
  return value.match(/^\s*/)[0].length;
}

function isExternalActionReference(reference) {
  return !reference.startsWith('./') && !reference.startsWith('docker://');
}

function validateActionReference(fileName, reference, violations) {
  const atIndex = reference.lastIndexOf('@');
  if (atIndex === -1) {
    violations.push(`${fileName}: action reference is missing a pinned ref: ${reference}`);
    return false;
  }

  const ref = reference.slice(atIndex + 1);
  if (!pinnedRefPattern.test(ref)) {
    violations.push(`${fileName}: action reference must be pinned to a full commit SHA: ${reference}`);
    return false;
  }

  return true;
}

function readRepoWorkflowContents(targetDir = workflowsDir) {
  const workflowContents = {};
  const fileNames = fs
    .readdirSync(targetDir)
    .filter((entry) => /\.ya?ml$/i.test(entry))
    .sort();

  for (const fileName of fileNames) {
    workflowContents[fileName] = fs.readFileSync(path.join(targetDir, fileName), 'utf8');
  }

  return workflowContents;
}

function stepHasNestedSetting(lines, startIndex, settingPattern) {
  const baseIndent = getIndentLength(lines[startIndex]);

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const stripped = stripInlineComment(line);
    if (!stripped) {
      continue;
    }

    const indent = getIndentLength(line);
    if (/^\s*-\s+/.test(line) && indent <= baseIndent) {
      break;
    }

    if (indent < baseIndent) {
      break;
    }

    if (settingPattern.test(stripped)) {
      return true;
    }
  }

  return false;
}

function collectWorkflowPolicyViolations(workflowContentsByName) {
  const violations = [];
  let checkedActions = 0;

  for (const [fileName, contents] of Object.entries(workflowContentsByName)) {
    const lines = contents.split(/\r?\n/);

    if (!permissionsPattern.test(contents)) {
      violations.push(`${fileName}: missing explicit permissions block`);
    }

    if (coreHardenedWorkflows.has(fileName) && !topLevelDenyAllPermissionsPattern.test(contents)) {
      violations.push(`${fileName}: must default top-level permissions to {}`);
    }

    if (pullRequestTargetPattern.test(contents)) {
      violations.push(`${fileName}: pull_request_target is not allowed; use pull_request or another safer trigger`);
    }

    for (const requirement of requiredWorkflowPatterns[fileName] || []) {
      if (!requirement.pattern.test(contents)) {
        violations.push(`${fileName}: ${requirement.message}`);
      }
    }

    for (let index = 0; index < lines.length; index += 1) {
      const stripped = stripInlineComment(lines[index]);
      if (!checkoutUsePattern.test(stripped)) {
        continue;
      }

      if (!stepHasNestedSetting(lines, index, /^persist-credentials:\s*false\s*$/)) {
        violations.push(`${fileName}: checkout steps must set persist-credentials: false`);
      }
    }

    for (const match of contents.matchAll(usesPattern)) {
      const reference = stripInlineComment(match[2]);
      if (!isExternalActionReference(reference)) {
        continue;
      }

      checkedActions += 1;
      validateActionReference(fileName, reference, violations);
    }
  }

  return {
    violations,
    checkedActions,
    workflowCount: Object.keys(workflowContentsByName).length,
  };
}

function collectRepoWorkflowPolicyViolations(targetDir = workflowsDir) {
  return collectWorkflowPolicyViolations(readRepoWorkflowContents(targetDir));
}

function main() {
  const result = collectRepoWorkflowPolicyViolations();
  const { violations, checkedActions, workflowCount } = result;

  if (violations.length > 0) {
    console.error('FAIL workflow policy verification');
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('PASS workflow policy verification');
  console.log(
    JSON.stringify(
      {
        workflowCount,
        checkedActions,
      },
      null,
      2,
    ),
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  collectRepoWorkflowPolicyViolations,
  collectWorkflowPolicyViolations,
  readRepoWorkflowContents,
  stripInlineComment,
};