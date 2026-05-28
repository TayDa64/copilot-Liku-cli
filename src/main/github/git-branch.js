const fs = require('fs');
const path = require('path');

const { resolveProjectIdentity } = require('../../shared/project-identity');

function parseGitDirectory(projectRoot, fsModule = fs) {
  const gitPath = path.join(projectRoot, '.git');
  if (!fsModule.existsSync(gitPath)) {
    return null;
  }

  try {
    const stat = fsModule.statSync(gitPath);
    if (stat.isDirectory()) {
      return gitPath;
    }

    const text = String(fsModule.readFileSync(gitPath, 'utf8') || '');
    const match = text.match(/gitdir:\s*(.+)/i);
    if (!match || !match[1]) {
      return null;
    }

    return path.resolve(projectRoot, String(match[1]).trim());
  } catch {
    return null;
  }
}

function resolveCurrentGitBranch(options = {}) {
  const cwd = options.cwd || process.cwd();
  const fsModule = options.fsModule || fs;
  const resolveProjectIdentityImpl = typeof options.resolveProjectIdentity === 'function'
    ? options.resolveProjectIdentity
    : resolveProjectIdentity;

  const projectIdentity = resolveProjectIdentityImpl({ cwd });
  const projectRoot = String(projectIdentity?.projectRoot || cwd);
  const gitDir = parseGitDirectory(projectRoot, fsModule);
  const report = {
    projectRoot,
    gitDir,
    currentBranch: null,
    headRef: null,
    detached: false,
    available: false,
    source: 'git-head',
    warnings: [],
  };

  if (!gitDir) {
    report.source = 'no-git';
    report.warnings.push('No git directory detected; current branch is unavailable.');
    return report;
  }

  const headPath = path.join(gitDir, 'HEAD');
  if (!fsModule.existsSync(headPath)) {
    report.source = 'missing-head';
    report.warnings.push('Git HEAD file not found; current branch is unavailable.');
    return report;
  }

  let headText = '';
  try {
    headText = String(fsModule.readFileSync(headPath, 'utf8') || '').trim();
  } catch {
    report.source = 'unreadable-head';
    report.warnings.push('Git HEAD file could not be read; current branch is unavailable.');
    return report;
  }

  const refMatch = headText.match(/^ref:\s*(.+)$/i);
  if (refMatch && refMatch[1]) {
    report.headRef = String(refMatch[1]).trim();
    const branchMatch = report.headRef.match(/^refs\/heads\/(.+)$/i);
    if (branchMatch && branchMatch[1]) {
      report.currentBranch = String(branchMatch[1]).trim();
      report.available = !!report.currentBranch;
      return report;
    }

    report.source = 'unsupported-head-ref';
    report.warnings.push(`Git HEAD points to an unsupported ref (${report.headRef}); current branch is unavailable.`);
    return report;
  }

  if (/^[0-9a-f]{7,64}$/i.test(headText)) {
    report.detached = true;
    report.source = 'detached-head';
    report.headRef = headText;
    report.warnings.push('Detached HEAD; current-branch pull request status is unavailable.');
    return report;
  }

  report.source = 'unknown-head';
  report.warnings.push('Git HEAD format is unrecognized; current branch is unavailable.');
  return report;
}

module.exports = {
  parseGitDirectory,
  resolveCurrentGitBranch,
};