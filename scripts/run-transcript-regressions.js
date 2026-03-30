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

function evaluateFixtureCases(fixtures) {
  return fixtures.map((fixture) => {
    const evaluation = evaluateTranscript(fixture.transcript, fixture.suite);
    return {
      fixture,
      evaluation,
      passed: evaluation.passed
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
  filterFixtures,
  printFixtureResults
};