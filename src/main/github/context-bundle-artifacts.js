const fs = require('fs');
const path = require('path');

const { LIKU_HOME } = require('../../shared/liku-home');

const GITHUB_CONTEXT_BUNDLES_DIR = path.join(LIKU_HOME, 'github', 'context-bundles');
const GITHUB_CONTEXT_BUNDLE_SCHEMA_VERSION = 'github.context-bundle.v1';

function ensureGitHubContextBundlesDir(targetFilePath = null) {
  const targetDir = targetFilePath
    ? path.dirname(path.resolve(targetFilePath))
    : GITHUB_CONTEXT_BUNDLES_DIR;

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  }
}

function buildGitHubContextBundleId() {
  return `github-context-bundle-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildGitHubContextBundlePath(bundleId) {
  return path.join(GITHUB_CONTEXT_BUNDLES_DIR, `${bundleId}.bundle.json`);
}

function summarizeGitHubContextBundleArtifact(record = {}, filePath = null) {
  return {
    bundleId: String(record.bundleId || '').trim() || null,
    schemaVersion: String(record.schemaVersion || '').trim() || null,
    createdAt: String(record.createdAt || '').trim() || null,
    filePath: filePath ? String(filePath) : null,
  };
}

function writeGitHubContextBundleArtifact(options = {}) {
  const payload = options.payload && typeof options.payload === 'object' && !Array.isArray(options.payload)
    ? JSON.parse(JSON.stringify(options.payload))
    : {};
  const bundleId = String(options.bundleId || payload.bundleId || buildGitHubContextBundleId()).trim() || buildGitHubContextBundleId();
  const createdAt = String(payload.createdAt || options.createdAt || new Date().toISOString()).trim() || new Date().toISOString();
  const filePath = String(options.filePath || '').trim()
    ? path.resolve(String(options.filePath || '').trim())
    : buildGitHubContextBundlePath(bundleId);

  ensureGitHubContextBundlesDir(filePath);

  const record = {
    ...payload,
    schemaVersion: String(payload.schemaVersion || GITHUB_CONTEXT_BUNDLE_SCHEMA_VERSION).trim() || GITHUB_CONTEXT_BUNDLE_SCHEMA_VERSION,
    bundleId,
    createdAt,
    artifact: summarizeGitHubContextBundleArtifact({
      bundleId,
      schemaVersion: payload.schemaVersion || GITHUB_CONTEXT_BUNDLE_SCHEMA_VERSION,
      createdAt,
    }, filePath),
  };

  fs.writeFileSync(filePath, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
  return record;
}

function readGitHubContextBundleArtifact(options = {}) {
  const explicitPath = String(options.filePath || '').trim();
  const bundleId = String(options.bundleId || '').trim();
  const filePath = explicitPath
    ? path.resolve(explicitPath)
    : (bundleId ? buildGitHubContextBundlePath(bundleId) : null);

  if (!filePath) {
    throw new Error('A GitHub context bundle file path or bundle id is required.');
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`GitHub context bundle artifact not found: ${filePath}`);
  }

  const text = fs.readFileSync(filePath, 'utf8');
  const record = JSON.parse(text);
  return {
    ...record,
    artifact: summarizeGitHubContextBundleArtifact(record, filePath),
  };
}

module.exports = {
  GITHUB_CONTEXT_BUNDLES_DIR,
  GITHUB_CONTEXT_BUNDLE_SCHEMA_VERSION,
  buildGitHubContextBundleId,
  buildGitHubContextBundlePath,
  ensureGitHubContextBundlesDir,
  readGitHubContextBundleArtifact,
  summarizeGitHubContextBundleArtifact,
  writeGitHubContextBundleArtifact,
};
