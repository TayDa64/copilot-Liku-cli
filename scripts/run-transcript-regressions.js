#!/usr/bin/env node

const path = require('path');
const {
  evaluateTranscript
} = require(path.join(__dirname, 'run-chat-inline-proof.js'));
const {
  DEFAULT_FIXTURE_DIR,
  loadTranscriptFixtures
} = require(path.join(__dirname, 'transcript-regression-fixtures.js'));

function getArgValue(flagName) {
  const index = process.argv.indexOf(flagName);
  if (index >= 0 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return null;
}

function hasFlag(flagName) {
  return process.argv.includes(flagName);
}

function filterFixtures(fixtures, filters = {}) {
  return fixtures.filter((fixture) => {
    if (filters.fixture && fixture.name !== filters.fixture) return false;
    if (filters.file && path.resolve(fixture.filePath || '') !== path.resolve(filters.file)) return false;
    return true;
  });
}

function findActionByIndex(actions, actionIndex) {
  if (!Array.isArray(actions)) return null;
  return actions.find((action) => Number(action?.index) === Number(actionIndex))
    || actions[Number(actionIndex)]
    || null;
}

function evaluateProofExpectations(fixture) {
  const expectations = Array.isArray(fixture?.suite?.proofExpectations)
    ? fixture.suite.proofExpectations
    : [];
  const actions = Array.isArray(fixture?.actions) ? fixture.actions : [];

  const results = expectations.map((expectation, index) => {
    const actionIndex = Number.isFinite(Number(expectation?.actionIndex))
      ? Number(expectation.actionIndex)
      : index;
    const action = findActionByIndex(actions, actionIndex);
    const proof = action?.proof || null;
    const failures = [];

    if (!action) {
      failures.push(`missing action at index ${actionIndex}`);
    }

    if (!proof) {
      failures.push(`action ${actionIndex} is missing proof`);
    }

    if (proof) {
      const proofLevel = Number.isFinite(Number(proof.level)) ? Number(proof.level) : 0;
      if (Number.isFinite(Number(expectation?.minProofLevel)) && proofLevel < Number(expectation.minProofLevel)) {
        failures.push(`expected proof level >= ${Number(expectation.minProofLevel)}, got ${proofLevel}`);
      }

      if (expectation?.status && String(proof.status || '') !== String(expectation.status)) {
        failures.push(`expected proof status ${expectation.status}, got ${proof.status || 'null'}`);
      }

      if (expectation?.actionType && String(action?.type || proof.actionType || '') !== String(expectation.actionType)) {
        failures.push(`expected action type ${expectation.actionType}, got ${action?.type || proof.actionType || 'null'}`);
      }

      const classification = proof?.observation?.classification
        || action?.observationCheckpoint?.classification
        || null;
      if (expectation?.classification && String(classification || '') !== String(expectation.classification)) {
        failures.push(`expected observation classification ${expectation.classification}, got ${classification || 'null'}`);
      }

      const targetId = action?.targetId || action?.resolvedTarget?.targetId || null;
      if (expectation?.targetId && String(targetId || '') !== String(expectation.targetId)) {
        failures.push(`expected targetId ${expectation.targetId}, got ${targetId || 'null'}`);
      }

      if (expectation?.requiredCheckKind) {
        const matchedCheck = Array.isArray(proof.checks)
          ? proof.checks.find((check) => (
            String(check?.kind || '') === String(expectation.requiredCheckKind)
            && (!expectation.requiredCheckStatus || String(check?.status || '') === String(expectation.requiredCheckStatus))
          ))
          : null;
        if (!matchedCheck) {
          failures.push(
            expectation.requiredCheckStatus
              ? `expected proof check ${expectation.requiredCheckKind} with status ${expectation.requiredCheckStatus}`
              : `expected proof check ${expectation.requiredCheckKind}`
          );
        }
      }
    }

    return {
      name: expectation?.name || `proof expectation ${index + 1}`,
      actionIndex,
      passed: failures.length === 0,
      failures
    };
  });

  return {
    passed: results.every((result) => result.passed),
    results
  };
}

function evaluateFixtureCases(fixtures) {
  return fixtures.map((fixture) => {
    const evaluation = evaluateTranscript(fixture.transcript, fixture.suite);
    const proofEvaluation = evaluateProofExpectations(fixture);
    return {
      fixture,
      evaluation,
      proofEvaluation,
      passed: evaluation.passed && proofEvaluation.passed
    };
  });
}

function printFixtureResults(results) {
  for (const result of results) {
    const location = result.fixture.filePath ? path.relative(process.cwd(), result.fixture.filePath) : 'inline';
    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.fixture.name} (${location})`);
    if (result.passed) continue;
    for (const detail of result.evaluation.results.filter((entry) => !entry.passed)) {
      console.log(`  - ${detail.name}`);
      if (detail.missing.length > 0) {
        console.log(`    Missing: ${detail.missing.map((pattern) => pattern.toString()).join(', ')}`);
      }
      if (detail.forbidden.length > 0) {
        console.log(`    Forbidden: ${detail.forbidden.map((pattern) => pattern.toString()).join(', ')}`);
      }
      if (detail.countFailures.length > 0) {
        console.log(`    Count: ${detail.countFailures.join('; ')}`);
      }
    }
    for (const detail of result.proofEvaluation.results.filter((entry) => !entry.passed)) {
      console.log(`  - ${detail.name}`);
      if (detail.failures.length > 0) {
        console.log(`    Proof: ${detail.failures.join('; ')}`);
      }
    }
  }
}

function main() {
  const fixtureRoot = getArgValue('--root') || DEFAULT_FIXTURE_DIR;
  const fixtures = loadTranscriptFixtures(fixtureRoot);
  const selected = filterFixtures(fixtures, {
    fixture: getArgValue('--fixture') || null,
    file: getArgValue('--file') || null
  });

  if (hasFlag('--list')) {
    for (const fixture of selected) {
      console.log(`${fixture.name}: ${fixture.description}`);
    }
    return;
  }

  if (selected.length === 0) {
    console.error('No transcript fixtures matched the requested filters.');
    process.exit(1);
  }

  const results = evaluateFixtureCases(selected);
  if (hasFlag('--json')) {
    console.log(JSON.stringify(results.map((result) => ({
      name: result.fixture.name,
      filePath: result.fixture.filePath,
      passed: result.passed,
      failures: result.evaluation.results.filter((entry) => !entry.passed).map((entry) => ({
        name: entry.name,
        missing: entry.missing.map((pattern) => pattern.toString()),
        forbidden: entry.forbidden.map((pattern) => pattern.toString()),
        countFailures: entry.countFailures
      })),
      proofFailures: result.proofEvaluation.results.filter((entry) => !entry.passed).map((entry) => ({
        name: entry.name,
        actionIndex: entry.actionIndex,
        failures: entry.failures
      }))
    })), null, 2));
    return;
  }

  printFixtureResults(results);
  const passed = results.filter((result) => result.passed).length;
  console.log(`\nTranscript regressions: ${passed}/${results.length} passed.`);
  if (!results.every((result) => result.passed)) {
    process.exit(1);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  }
}

module.exports = {
  evaluateFixtureCases,
  evaluateProofExpectations,
  filterFixtures,
  printFixtureResults
};