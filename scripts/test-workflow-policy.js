#!/usr/bin/env node

'use strict';

const assert = require('assert');
const path = require('path');

const {
  collectRepoWorkflowPolicyViolations,
  collectWorkflowPolicyViolations,
} = require(path.join(__dirname, 'check-workflow-policy.js'));

const CHECKOUT_PIN = '34e114876b0b11c390a56381ad16ebd13914f8d5';
const SETUP_NODE_PIN = '49933ea5288caeca8642d1e84afbd3f7d6820020';
const UPLOAD_ARTIFACT_PIN = 'ea165f8d65b6e75b540449e92b4886f43607fa02';
const DEPENDENCY_REVIEW_PIN = '2031cfc080254a8a887f58cffee85186f0e49e48';
const GITLEAKS_PIN = 'dcedce43c6f43de0b836d1fe38946645c9c638dc';
const ATTEST_PROVENANCE_PIN = 'a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32';
const ATTEST_SBOM_PIN = 'c604332985a26aa8cf1bdc465b92731239ec6b9e';

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

function buildValidWorkflowFixtures() {
  return {
    'validate.yml': `name: Validate
permissions: {}
jobs:
  validate:
    permissions:
      contents: read
    steps:
      - name: Checkout code
        uses: actions/checkout@${CHECKOUT_PIN}
        with:
          persist-credentials: false
      - name: Setup Node.js
        uses: actions/setup-node@${SETUP_NODE_PIN}
`,
    'test.yml': `name: Test
permissions: {}
jobs:
  regression:
    permissions:
      contents: read
    steps:
      - name: Checkout code
        uses: actions/checkout@${CHECKOUT_PIN}
        with:
          persist-credentials: false
      - name: Setup Node.js
        uses: actions/setup-node@${SETUP_NODE_PIN}
`,
    'package.yml': `name: Package Verification
permissions: {}
jobs:
  package:
    permissions:
      contents: read
    steps:
      - name: Checkout code
        uses: actions/checkout@${CHECKOUT_PIN}
        with:
          persist-credentials: false
      - name: Setup Node.js
        uses: actions/setup-node@${SETUP_NODE_PIN}
      - name: Verify npm package dry-run contents
        run: npm run verify:package
      - name: Generate package SBOM
        run: npm sbom --omit=dev --sbom-format spdx --sbom-type application > sbom.spdx.json
      - name: Upload npm pack manifest
        uses: actions/upload-artifact@${UPLOAD_ARTIFACT_PIN}
        with:
          path: |
            pack-dry-run.json
            sbom.spdx.json
`,
    'policy.yml': `name: Policy
permissions: {}
jobs:
  dependency-review:
    permissions:
      contents: read
      pull-requests: read
    steps:
      - name: Dependency review
        uses: actions/dependency-review-action@${DEPENDENCY_REVIEW_PIN}
  secret-scan:
    permissions:
      contents: read
    steps:
      - name: Checkout code
        uses: actions/checkout@${CHECKOUT_PIN}
        with:
          fetch-depth: 0
          persist-credentials: false
      - name: Run gitleaks secret scan
        uses: gitleaks/gitleaks-action@${GITLEAKS_PIN}
  workflow-policy:
    permissions:
      contents: read
    steps:
      - name: Checkout code
        uses: actions/checkout@${CHECKOUT_PIN}
        with:
          persist-credentials: false
      - name: Setup Node.js
        uses: actions/setup-node@${SETUP_NODE_PIN}
      - name: Verify workflow policy
        run: npm run verify:workflow-policy
`,
    'release.yml': `name: Release
permissions: {}
jobs:
  release:
    environment: npm-release
    permissions:
      contents: read
      attestations: write
      id-token: write
    steps:
      - name: Checkout code
        uses: actions/checkout@${CHECKOUT_PIN}
        with:
          fetch-depth: 0
          persist-credentials: false
      - name: Setup Node.js
        uses: actions/setup-node@${SETUP_NODE_PIN}
      - name: Verify release tag matches package version
        run: |
          TARGET_TAG=$(git describe --tags --exact-match HEAD)
          PACKAGE_VERSION=$(node -p "require('./package.json').version")
      - name: Verify workflow policy
        run: npm run verify:workflow-policy
      - name: Generate release SBOM
        run: npm sbom --omit=dev --sbom-format spdx --sbom-type application > sbom.spdx.json
      - name: Attest npm tarball provenance
        uses: actions/attest-build-provenance@${ATTEST_PROVENANCE_PIN}
        with:
          subject-path: artifact.tgz
      - name: Attest npm tarball SBOM
        uses: actions/attest-sbom@${ATTEST_SBOM_PIN}
        with:
          subject-path: artifact.tgz
          sbom-path: sbom.spdx.json
      - name: Publish to npm
        run: npm publish artifact.tgz --provenance --access public
`,
  };
}

test('accepts hardened workflow fixtures', () => {
  const { violations } = collectWorkflowPolicyViolations(buildValidWorkflowFixtures());
  assert.deepStrictEqual(violations, []);
});

test('flags unpinned external actions', () => {
  const { violations } = collectWorkflowPolicyViolations({
    'validate.yml': `name: Validate
permissions: {}
jobs:
  validate:
    permissions:
      contents: read
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          persist-credentials: false
`,
  });

  assert(violations.some((violation) => violation.includes('must be pinned to a full commit SHA')));
});

test('flags checkout steps that persist credentials', () => {
  const { violations } = collectWorkflowPolicyViolations({
    'validate.yml': `name: Validate
permissions: {}
jobs:
  validate:
    permissions:
      contents: read
    steps:
      - name: Checkout code
        uses: actions/checkout@${CHECKOUT_PIN}
`,
  });

  assert(violations.some((violation) => violation.includes('persist-credentials: false')));
});

test('flags release workflows that omit tag and provenance guards', () => {
  const { violations } = collectWorkflowPolicyViolations({
    'release.yml': `name: Release
permissions: {}
jobs:
  release:
    environment: npm-release
    permissions:
      contents: read
      attestations: write
      id-token: write
    steps:
      - name: Checkout code
        uses: actions/checkout@${CHECKOUT_PIN}
        with:
          fetch-depth: 0
          persist-credentials: false
`,
  });

  assert(violations.some((violation) => violation.includes('exact git tag')));
  assert(violations.some((violation) => violation.includes('npm provenance')));
});

test('repository workflows satisfy the enforced policy', () => {
  const { violations } = collectRepoWorkflowPolicyViolations();
  assert.deepStrictEqual(violations, []);
});