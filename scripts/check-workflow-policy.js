'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');

const workflowFileNames = fs
  .readdirSync(workflowsDir)
  .filter((entry) => /\.ya?ml$/i.test(entry))
  .sort();

const pinnedRefPattern = /^[0-9a-f]{40}$/i;
const usesPattern = /^\s*(?:-\s*)?uses:\s*(['"]?)([^'"\n]+)\1\s*$/gm;
const permissionsPattern = /^\s*permissions:\s*(?:\{.*\})?\s*$/m;
const pullRequestTargetPattern = /^\s*pull_request_target:\s*$/m;

function stripInlineComment(value) {
  return value.replace(/\s+#.*$/, '').trim();
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

function main() {
  const violations = [];
  let checkedActions = 0;

  for (const fileName of workflowFileNames) {
    const workflowPath = path.join(workflowsDir, fileName);
    const contents = fs.readFileSync(workflowPath, 'utf8');

    if (!permissionsPattern.test(contents)) {
      violations.push(`${fileName}: missing explicit permissions block`);
    }

    if (pullRequestTargetPattern.test(contents)) {
      violations.push(`${fileName}: pull_request_target is not allowed; use pull_request or another safer trigger`);
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
        workflowCount: workflowFileNames.length,
        checkedActions,
      },
      null,
      2,
    ),
  );
}

main();