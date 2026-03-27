const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const DEFAULT_MAX_RESULTS = 25;
const DEFAULT_TIMEOUT_MS = 30000;
const HARD_MAX_RESULTS = 200;
const MAX_FILE_SIZE_BYTES = 1024 * 1024;
const MAX_PATTERN_LENGTH = 300;
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

function isWithinRoot(root, candidate) {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  const normalizedRoot = absoluteRoot.endsWith(path.sep) ? absoluteRoot : `${absoluteRoot}${path.sep}`;
  return absoluteCandidate === absoluteRoot || absoluteCandidate.startsWith(normalizedRoot);
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
  if (!isWithinRoot(absoluteRoot, absoluteCandidate)) return null;
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

function normalizeLimits(action = {}) {
  return {
    maxResults: clampInt(action.maxResults, DEFAULT_MAX_RESULTS, 1, HARD_MAX_RESULTS),
    timeoutMs: clampInt(action.timeout, DEFAULT_TIMEOUT_MS, 1000, 120000)
  };
}

function buildRegexPattern(pattern, options = {}) {
  const isLiteral = !!options.literal;
  const caseSensitive = !!options.caseSensitive;
  const normalized = normalizeString(pattern);
  if (!normalized) return { error: 'pattern is required' };
  if (normalized.length > MAX_PATTERN_LENGTH) {
    return { error: `pattern exceeds ${MAX_PATTERN_LENGTH} characters` };
  }
  try {
    return {
      regex: isLiteral
        ? new RegExp(escapeRegex(normalized), caseSensitive ? '' : 'i')
        : new RegExp(normalized, caseSensitive ? '' : 'i')
    };
  } catch (error) {
    return { error: `invalid regex pattern: ${error.message}` };
  }
}

function readFileLinesCached(searchRoot, relativePath, cache) {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  if (cache.has(normalized)) return cache.get(normalized);
  const absolute = path.resolve(searchRoot, normalized);
  if (!isWithinRoot(searchRoot, absolute)) {
    cache.set(normalized, []);
    return [];
  }
  try {
    const content = fs.readFileSync(absolute, 'utf8');
    const lines = splitTextLines(content);
    cache.set(normalized, lines);
    return lines;
  } catch {
    cache.set(normalized, []);
    return [];
  }
}

function attachSnippet(entry, lines, radius = 1) {
  const lineIndex = Math.max(0, Number(entry.line || 1) - 1);
  const start = Math.max(0, lineIndex - radius);
  const end = Math.min(lines.length - 1, lineIndex + radius);
  const snippetLines = [];
  for (let i = start; i <= end; i += 1) {
    snippetLines.push(`${i + 1}| ${String(lines[i] || '').trim()}`);
  }
  return {
    ...entry,
    snippet: {
      startLine: start + 1,
      endLine: end + 1,
      text: snippetLines.join('\n')
    }
  };
}

function enrichMatchesWithSnippets(matches, searchRoot) {
  const cache = new Map();
  return (Array.isArray(matches) ? matches : []).map((entry) => {
    const lines = readFileLinesCached(searchRoot, entry.path, cache);
    if (!lines.length) return entry;
    return attachSnippet(entry, lines, 1);
  });
}

function extractQuerySymbols(query) {
  const tokens = String(query || '')
    .split(/[^A-Za-z0-9_]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const symbols = tokens.filter((token) => token.length >= 4);
  return Array.from(new Set(symbols)).slice(0, 8);
}

function rankSemanticMatches(matches, query, searchRoot) {
  const normalizedQuery = normalizeString(query).toLowerCase();
  const tokens = tokenizeQuery(query);
  const symbols = extractQuerySymbols(query);
  const mtimeMap = new Map();
  let newest = 0;
  let oldest = Number.MAX_SAFE_INTEGER;

  for (const entry of matches) {
    const rel = String(entry.path || '').replace(/\\/g, '/');
    if (mtimeMap.has(rel)) continue;
    const abs = path.resolve(searchRoot, rel);
    let mtime = 0;
    try {
      const stat = fs.statSync(abs);
      mtime = Number(stat.mtimeMs || 0);
    } catch {}
    mtimeMap.set(rel, mtime);
    if (mtime > newest) newest = mtime;
    if (mtime > 0 && mtime < oldest) oldest = mtime;
  }
  if (!Number.isFinite(oldest) || oldest === Number.MAX_SAFE_INTEGER) oldest = 0;
  const range = Math.max(1, newest - oldest);

  return matches
    .map((entry) => {
      const pathText = String(entry.path || '').toLowerCase();
      const lineText = String(entry.text || '').toLowerCase();
      const declarationBias = /(function|class|const|let|var|export)\s+[a-z0-9_]/i.test(String(entry.text || '')) ? 2 : 0;
      let score = 0;

      if (normalizedQuery && lineText.includes(normalizedQuery)) score += 10;
      if (normalizedQuery && pathText.includes(normalizedQuery)) score += 5;

      for (const token of tokens) {
        if (lineText.includes(token)) score += 1;
        if (pathText.includes(token)) score += 2;
      }
      for (const symbol of symbols) {
        const lower = symbol.toLowerCase();
        if (lineText.includes(lower)) score += 4;
        if (pathText.includes(lower)) score += 2;
      }
      score += declarationBias;

      const mtime = Number(mtimeMap.get(String(entry.path || '').replace(/\\/g, '/')) || 0);
      const recency = mtime > 0 ? (mtime - oldest) / range : 0;
      score += recency;

      return {
        ...entry,
        score: Number(score.toFixed(3))
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.path !== right.path) return left.path.localeCompare(right.path);
      return left.line - right.line;
    });
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

  const limits = normalizeLimits(action);
  const maxResults = limits.maxResults;
  const timeoutMs = limits.timeoutMs;
  const caseSensitive = !!action.caseSensitive;
  const literal = !!action.literal;
  const fileGlob = normalizeString(action.fileGlob);
  const searchRoot = getSearchRoot(action.cwd);
  const parsedPattern = buildRegexPattern(pattern, { literal, caseSensitive });
  if (parsedPattern.error) {
    return { success: false, error: parsedPattern.error };
  }

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
    const regex = parsedPattern.regex;
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
  const bounded = enrichMatchesWithSnippets(matches.slice(0, maxResults), searchRoot);

  return {
    success: true,
    action: 'grep_repo',
    backend,
    searchRoot,
    pattern,
    count: bounded.length,
    maxResultsApplied: maxResults,
    results: bounded
  };
}

async function semanticSearchRepo(action = {}) {
  const query = normalizeString(action.query || action.pattern);
  if (!query) {
    return { success: false, error: 'semantic_search_repo requires query' };
  }

  const limits = normalizeLimits(action);
  const maxResults = limits.maxResults;
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

  merged = rankSemanticMatches(merged, query, initial.searchRoot).slice(0, maxResults);

  return {
    success: true,
    action: 'semantic_search_repo',
    backend: initial.backend,
    searchRoot: initial.searchRoot,
    query,
    maxResultsApplied: maxResults,
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

async function enrichWindowsProcessesWithWindowTitles(processes) {
  const result = await runProcess('powershell.exe', [
    '-NoProfile',
    '-Command',
    '$p=Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Select-Object Id,ProcessName,MainWindowTitle; $p | ConvertTo-Json -Compress'
  ], {
    cwd: process.cwd(),
    timeoutMs: 10000
  });
  if (!String(result.stdout || '').trim()) return processes;

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return processes;
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const titleByPid = new Map();
  for (const row of rows) {
    const pid = Number(row?.Id);
    if (!Number.isFinite(pid)) continue;
    titleByPid.set(pid, {
      windowTitle: String(row?.MainWindowTitle || '').trim() || null,
      processName: String(row?.ProcessName || '').trim() || null
    });
  }

  return processes.map((entry) => {
    const pid = Number(entry.pid);
    if (!Number.isFinite(pid) || !titleByPid.has(pid)) {
      return { ...entry, hasWindow: false, windowTitle: null };
    }
    const info = titleByPid.get(pid);
    return {
      ...entry,
      hasWindow: !!info.windowTitle,
      windowTitle: info.windowTitle
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
  const limit = clampInt(action.limit, 20, 1, HARD_MAX_RESULTS);
  let processes = process.platform === 'win32'
    ? await listProcessesWindows()
    : await listProcessesUnix();
  if (process.platform === 'win32') {
    processes = await enrichWindowsProcessesWithWindowTitles(processes);
  }

  const filtered = query
    ? processes.filter((entry) => String(entry.name || '').toLowerCase().includes(query.toLowerCase()))
    : processes;
  const ranked = filtered
    .map((entry) => {
      const name = String(entry.name || '').toLowerCase();
      const queryLower = query.toLowerCase();
      let score = 0;
      if (!queryLower) score = 1;
      else if (name === queryLower) score = 4;
      else if (name.startsWith(queryLower)) score = 3;
      else if (name.includes(queryLower)) score = 2;
      if (entry.hasWindow) score += 0.5;
      return { ...entry, score };
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return String(left.name || '').localeCompare(String(right.name || ''));
    });

  return {
    success: true,
    action: 'pgrep_process',
    query: query || null,
    maxResultsApplied: limit,
    count: Math.min(ranked.length, limit),
    results: ranked.slice(0, limit)
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
