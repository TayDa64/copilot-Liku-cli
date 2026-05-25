#!/usr/bin/env node

const assert = require('assert');
const path = require('path');
const { execSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const packageJson = require(path.join(repoRoot, 'package.json'));

const REQUIRED_PATHS = [
  'package.json',
  'README.md',
  'LICENSE.md',
  'QUICKSTART.md',
  'INSTALLATION.md',
  'scripts/start.js',
  'scripts/postinstall.js',
  'src/cli/liku.js',
  'src/main/ai-service.js',
  'src/shared/liku-home.js',
  'src/native/windows-uia-dotnet/Program.cs',
  'src/native/windows-uia-dotnet/WindowsUIA.csproj',
  'src/native/windows-uia-dotnet/build.ps1',
];

const FORBIDDEN_PREFIXES = [
  '.github/',
  'docs/',
  'memories/',
];

const FORBIDDEN_PATTERNS = [
  /^scripts\/test-/i,
  /\.log$/i,
  /^artifacts\//i,
];

function runPackDryRun() {
  const stdout = execSync('npm pack --dry-run --json', {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

function main() {
  const result = runPackDryRun();
  assert.ok(Array.isArray(result) && result.length > 0, 'npm pack --dry-run --json should return a manifest array');

  const manifest = result[0];
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const filePaths = new Set(files.map((entry) => String(entry.path || '').replace(/\\/g, '/')).filter(Boolean));

  const missing = REQUIRED_PATHS.filter((requiredPath) => !filePaths.has(requiredPath));
  const forbidden = [...filePaths].filter((filePath) => (
    FORBIDDEN_PREFIXES.some((prefix) => filePath.startsWith(prefix))
    || FORBIDDEN_PATTERNS.some((pattern) => pattern.test(filePath))
  ));

  const binEntries = packageJson.bin && typeof packageJson.bin === 'object'
    ? Object.values(packageJson.bin).map((entry) => String(entry || '').replace(/\\/g, '/'))
    : [];
  const missingBinTargets = binEntries.filter((entry) => !filePaths.has(entry));

  assert.strictEqual(missing.length, 0, `Missing required package file(s): ${missing.join(', ')}`);
  assert.strictEqual(missingBinTargets.length, 0, `Pack output is missing bin target(s): ${missingBinTargets.join(', ')}`);
  assert.strictEqual(forbidden.length, 0, `Forbidden package file(s) detected: ${forbidden.join(', ')}`);

  const summary = {
    package: `${manifest.name}@${manifest.version}`,
    fileCount: files.length,
    size: manifest.size,
    unpackedSize: manifest.unpackedSize,
    filename: manifest.filename,
  };

  console.log('PASS package dry-run verification');
  console.log(JSON.stringify(summary, null, 2));
}

try {
  main();
} catch (error) {
  console.error('FAIL package dry-run verification');
  console.error(error.stack || error.message);
  process.exit(1);
}
