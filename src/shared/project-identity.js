const fs = require('fs');
const path = require('path');

function normalizePath(value) {
  if (!value) return null;
  const resolved = path.resolve(String(value));
  let normalized = resolved;
  try {
    normalized = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch {
    normalized = resolved;
  }
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function normalizeName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
}

function walkUpFor(startPath, predicate) {
  let current = normalizePath(startPath || process.cwd());
  while (current) {
    if (predicate(current)) return current;
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return null;
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function parseGitDirectory(rootPath) {
  const gitPath = path.join(rootPath, '.git');
  if (!fs.existsSync(gitPath)) return null;
  try {
    const stat = fs.statSync(gitPath);
    if (stat.isDirectory()) return gitPath;
    const text = fs.readFileSync(gitPath, 'utf8');
    const match = text.match(/gitdir:\s*(.+)/i);
    if (!match) return null;
    return normalizePath(path.resolve(rootPath, match[1].trim()));
  } catch {
    return null;
  }
}

function readGitConfig(gitDir) {
  if (!gitDir) return null;
  const configPath = path.join(gitDir, 'config');
  if (!fs.existsSync(configPath)) return null;
  try {
    return fs.readFileSync(configPath, 'utf8');
  } catch {
    return null;
  }
}

function extractGitRemote(configText) {
  const text = String(configText || '');
  const originMatch = text.match(/\[remote\s+"origin"\][^[]*?url\s*=\s*(.+)/i);
  if (originMatch?.[1]) return originMatch[1].trim();
  const anyMatch = text.match(/\[remote\s+"[^"]+"\][^[]*?url\s*=\s*(.+)/i);
  return anyMatch?.[1] ? anyMatch[1].trim() : null;
}

function extractRepoNameFromRemote(remote) {
  const trimmed = String(remote || '').trim();
  if (!trimmed) return null;
  const last = trimmed.split(/[/:\\]/).filter(Boolean).pop() || '';
  return last.replace(/\.git$/i, '') || null;
}

function buildAliases(parts) {
  const values = new Set();
  for (const part of parts) {
    if (!part) continue;
    const raw = String(part).trim();
    if (!raw) continue;
    values.add(raw);
    values.add(normalizeName(raw));
  }
  return [...values].filter(Boolean);
}

function detectProjectRoot(startPath = process.cwd()) {
  return walkUpFor(startPath, (candidate) => fs.existsSync(path.join(candidate, 'package.json')))
    || normalizePath(startPath || process.cwd());
}

function resolveProjectIdentity(options = {}) {
  const cwd = normalizePath(options.cwd || process.cwd());
  const projectRoot = detectProjectRoot(cwd);
  const packagePath = path.join(projectRoot, 'package.json');
  const packageJson = safeReadJson(packagePath) || {};
  const gitDir = parseGitDirectory(projectRoot);
  const gitRemote = extractGitRemote(readGitConfig(gitDir));
  const folderName = path.basename(projectRoot);
  const packageName = typeof packageJson.name === 'string' ? packageJson.name.trim() : null;
  const remoteRepoName = extractRepoNameFromRemote(gitRemote);
  const repoName = remoteRepoName || packageName || folderName;
  const aliases = buildAliases([repoName, packageName, folderName]);

  return {
    cwd,
    projectRoot,
    folderName,
    packageName,
    packageVersion: typeof packageJson.version === 'string' ? packageJson.version.trim() : null,
    repoName,
    normalizedRepoName: normalizeName(packageName || repoName || folderName),
    gitRemote,
    aliases
  };
}

function isPathInside(parentPath, childPath) {
  const parent = normalizePath(parentPath);
  const child = normalizePath(childPath);
  if (!parent || !child) return false;
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateProjectIdentity(options = {}) {
  const detected = resolveProjectIdentity({ cwd: options.cwd });
  const expectedProjectRoot = options.expectedProjectRoot ? normalizePath(options.expectedProjectRoot) : null;
  const expectedRepo = options.expectedRepo ? normalizeName(options.expectedRepo) : null;
  const errors = [];

  if (expectedProjectRoot && !isPathInside(expectedProjectRoot, detected.cwd)) {
    errors.push(`cwd ${detected.cwd} is outside expected project ${expectedProjectRoot}`);
  }

  if (expectedProjectRoot && detected.projectRoot !== expectedProjectRoot) {
    errors.push(`detected root ${detected.projectRoot} does not match expected project ${expectedProjectRoot}`);
  }

  if (expectedRepo) {
    const normalizedAliases = new Set(detected.aliases.map((alias) => normalizeName(alias)));
    if (!normalizedAliases.has(expectedRepo)) {
      errors.push(`detected repo ${detected.repoName} does not match expected repo ${options.expectedRepo}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    expected: {
      projectRoot: expectedProjectRoot,
      repo: options.expectedRepo || null
    },
    detected
  };
}

module.exports = {
  detectProjectRoot,
  normalizePath,
  normalizeName,
  resolveProjectIdentity,
  validateProjectIdentity
};