'use strict';

const path = require('path');

const {
  collectRepoWorkflowPolicyViolations,
  collectWorkflowPolicyViolations,
  readRepoWorkflowContents,
  stripInlineComment,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'workflow-policy.js'));

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
