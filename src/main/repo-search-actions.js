const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const DEFAULT_MAX_RESULTS = 25;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_FILE_SIZE_BYTES = 1024 * 1024;
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  'out'
]);

function clampInt(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(numeric)));
}

function normalizeString(value) {
  return String(value || '').trim();
}

function escapeRegex(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitTextLines(text) {
  return String(text || '').replace(/\r\n/g, '\n').split('\n');
}

function parseRgLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return null;
  const firstColon = raw.indexOf(':');
  if (firstColon <= 0) return null;
  const secondColon = raw.indexOf(':', firstColon + 1);
  if (secondColon <= firstColon) return null;
  const filePath = raw.slice(0, firstColon).trim();
  const lineNumber = Number(raw.slice(firstColon + 1, secondColon));
  if (!filePath || !Number.isFinite(lineNumber)) return null;
  return {
    path: filePath,
    line: lineNumber,
    text: raw.slice(secondColon + 1).trim()
  };
}

function tokenizeQuery(query) {
  return Array.from(
    new Set(
      String(query || '')
        .toLowerCase()
        .split(/[^a-z0-9_]+/i)
        .map((part) => part.trim())
        .filter((part) => part.length >= 3)
    )
  ).slice(0, 8);
}

function getSearchRoot(cwd) {
  const starting = path.resolve(cwd || process.cwd());
  if (!fs.existsSync(starting)) return process.cwd();

  let current = starting;
  while (true) {
    const gitPath = path.join(current, '.git');
    if (fs.existsSync(gitPath)) return current;
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return starting;
}

function safeRelative(searchRoot, candidate) {
  const absoluteRoot = path.resolve(searchRoot);
  const absoluteCandidate = path.resolve(searchRoot, candidate);
  if (!absoluteCandidate.startsWith(absoluteRoot)) return null;
  return path.relative(absoluteRoot, absoluteCandidate);
}

async function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], { windowsHide: true, stdio: 'ignore', shell: false });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function runProcess(executable, args, options = {}) {
  const cwd = options.cwd || process.cwd();
  const timeoutMs = clampInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 120000);
  const maxCapture = clampInt(options.maxCapture, 200000, 1024, 1000000);

  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      windowsHide: true,
      shell: false
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > maxCapture) stdout = stdout.slice(-maxCapture);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > maxCapture) stderr = stderr.slice(-maxCapture);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        success: false,
        code: -1,
        stdout,
        stderr: error.message,
        timedOut
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        success: code === 0 && !timedOut,
        code: Number(code ?? 0),
        stdout,
        stderr,
        timedOut
      });
    });
  });
}

function shouldSkipDirectory(name) {
  return IGNORED_DIRS.has(String(name || '').toLowerCase());
}

function listCandidateFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(entry.name)) {
          stack.push(absolute);
        }
        continue;
      }
      if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }
  return files;
}

function isLikelyBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 512));
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0) return true;
  }
  return false;
}

function searchFilesFallback(options = {}) {
  const {
    searchRoot,
    matcher,
    maxResults
  } = options;
  const output = [];
  const files = listCandidateFiles(searchRoot);

  for (const absoluteFile of files) {
    if (output.length >= maxResults) break;
    let stat;
    try {
      stat = fs.statSync(absoluteFile);
    } catch {
      continue;
    }
    if (!stat || stat.size > MAX_FILE_SIZE_BYTES) continue;

    let raw;
    try {
      raw = fs.readFileSync(absoluteFile);
    } catch {
      continue;
    }
    if (isLikelyBinary(raw)) continue;

    const content = raw.toString('utf8');
    const lines = splitTextLines(content);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      if (output.length >= maxResults) break;
      const lineText = lines[lineIndex];
      if (!matcher(lineText, absoluteFile)) continue;
      const relative = safeRelative(searchRoot, absoluteFile);
      if (!relative) continue;
      output.push({
        path: relative.replace(/\\/g, '/'),
        line: lineIndex + 1,
        text: lineText.trim()
      });
    }
  }

  return output;
}

async function grepRepo(action = {}) {
  const pattern = normalizeString(action.pattern || action.query);
  if (!pattern) {
    return { success: false, error: 'grep_repo requires pattern' };
  }

  const maxResults = clampInt(action.maxResults, DEFAULT_MAX_RESULTS, 1, 200);
  const timeoutMs = clampInt(action.timeout, DEFAULT_TIMEOUT_MS, 1000, 120000);
  const caseSensitive = !!action.caseSensitive;
  const literal = !!action.literal;
  const fileGlob = normalizeString(action.fileGlob);
  const searchRoot = getSearchRoot(action.cwd);

  const rgAvailable = await commandExists('rg');
  let matches = [];
  let backend = 'fallback';

  if (rgAvailable) {
    const args = ['-n', '--hidden', '--color', 'never', '--glob', '!.git/**', '--glob', '!node_modules/**'];
    if (!caseSensitive) args.push('-i');
    if (literal) args.push('-F');
    if (fileGlob) args.push('--glob', fileGlob);
    if (!literal) args.push('-e');
    args.push(pattern);
    args.push('.');

    const result = await runProcess('rg', args, { cwd: searchRoot, timeoutMs });
    backend = 'rg';
    const lines = splitTextLines(result.stdout);
    matches = lines
      .map(parseRgLine)
      .filter(Boolean)
      .slice(0, maxResults);
  } else {
    const regex = literal
      ? new RegExp(escapeRegex(pattern), caseSensitive ? '' : 'i')
      : new RegExp(pattern, caseSensitive ? '' : 'i');
    matches = searchFilesFallback({
      searchRoot,
      matcher: (lineText, absolutePath) => {
        if (fileGlob) {
          const leaf = path.basename(absolutePath);
          const globMatcher = new RegExp(`^${escapeRegex(fileGlob).replace(/\\\*/g, '.*')}$`, 'i');
          if (!globMatcher.test(leaf)) return false;
        }
        return regex.test(lineText);
      },
      maxResults
    });
  }

  return {
    success: true,
    action: 'grep_repo',
    backend,
    searchRoot,
    pattern,
    count: matches.length,
    results: matches
  };
}

async function semanticSearchRepo(action = {}) {
  const query = normalizeString(action.query || action.pattern);
  if (!query) {
    return { success: false, error: 'semantic_search_repo requires query' };
  }

  const maxResults = clampInt(action.maxResults, DEFAULT_MAX_RESULTS, 1, 200);
  const initial = await grepRepo({
    pattern: query,
    literal: true,
    caseSensitive: false,
    cwd: action.cwd,
    maxResults: Math.max(maxResults, 60),
    timeout: action.timeout
  });

  if (!initial.success) return initial;
  const tokens = tokenizeQuery(query);
  let merged = Array.isArray(initial.results) ? [...initial.results] : [];

  if (tokens.length > 1 && merged.length < maxResults) {
    const tokenPattern = tokens.map(escapeRegex).join('|');
    const tokenSearch = await grepRepo({
      pattern: tokenPattern,
      literal: false,
      caseSensitive: false,
      cwd: action.cwd,
      maxResults: Math.max(maxResults, 80),
      timeout: action.timeout
    });
    if (tokenSearch.success && Array.isArray(tokenSearch.results)) {
      const seen = new Set(merged.map((entry) => `${entry.path}:${entry.line}`));
      for (const candidate of tokenSearch.results) {
        const key = `${candidate.path}:${candidate.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(candidate);
      }
    }
  }

  const loweredTokens = tokens.length > 0 ? tokens : [query.toLowerCase()];
  merged = merged
    .map((entry) => {
      const haystack = `${entry.path} ${entry.text}`.toLowerCase();
      let score = 0;
      for (const token of loweredTokens) {
        if (haystack.includes(token)) score += 1;
      }
      if (String(entry.text || '').toLowerCase().includes(query.toLowerCase())) score += 3;
      return { ...entry, score };
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.path !== right.path) return left.path.localeCompare(right.path);
      return left.line - right.line;
    })
    .slice(0, maxResults);

  return {
    success: true,
    action: 'semantic_search_repo',
    backend: initial.backend,
    searchRoot: initial.searchRoot,
    query,
    count: merged.length,
    results: merged
  };
}

function parseTasklistCsvLine(line) {
  const out = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ',' && !inQuotes) {
      out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  out.push(current);
  return out.map((entry) => entry.trim());
}

async function listProcessesWindows() {
  const result = await runProcess('tasklist', ['/fo', 'csv', '/nh'], {
    cwd: process.cwd(),
    timeoutMs: DEFAULT_TIMEOUT_MS
  });
  if (!result.success && !String(result.stdout || '').trim()) {
    return [];
  }
  return splitTextLines(result.stdout)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseTasklistCsvLine)
    .filter((columns) => columns.length >= 2)
    .map((columns) => {
      const pid = Number(String(columns[1] || '').replace(/[^0-9]/g, ''));
      return {
        name: columns[0] || '',
        pid: Number.isFinite(pid) ? pid : null,
        memory: columns[4] || ''
      };
    });
}

async function listProcessesUnix() {
  const result = await runProcess('ps', ['-eo', 'pid,comm'], {
    cwd: process.cwd(),
    timeoutMs: DEFAULT_TIMEOUT_MS
  });
  if (!result.success && !String(result.stdout || '').trim()) {
    return [];
  }
  return splitTextLines(result.stdout)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      if (parts.length < 2) return null;
      const pid = Number(parts.shift());
      return {
        name: parts.join(' '),
        pid: Number.isFinite(pid) ? pid : null
      };
    })
    .filter(Boolean);
}

async function pgrepProcess(action = {}) {
  const query = normalizeString(action.query || action.name || action.pattern);
  const limit = clampInt(action.limit, 20, 1, 200);
  const processes = process.platform === 'win32'
    ? await listProcessesWindows()
    : await listProcessesUnix();

  const filtered = query
    ? processes.filter((entry) => String(entry.name || '').toLowerCase().includes(query.toLowerCase()))
    : processes;

  return {
    success: true,
    action: 'pgrep_process',
    query: query || null,
    count: Math.min(filtered.length, limit),
    results: filtered.slice(0, limit)
  };
}

async function executeRepoSearchAction(action = {}) {
  const type = normalizeString(action.type).toLowerCase();
  if (type === 'grep_repo') return grepRepo(action);
  if (type === 'semantic_search_repo') return semanticSearchRepo(action);
  if (type === 'pgrep_process') return pgrepProcess(action);
  return { success: false, error: `Unsupported repo-search action: ${type}` };
}

module.exports = {
  executeRepoSearchAction,
  grepRepo,
  semanticSearchRepo,
  pgrepProcess,
  tokenizeQuery
};
