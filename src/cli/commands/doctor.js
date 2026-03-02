/**
 * doctor command - Minimal diagnostics for targeting reliability
 * @module cli/commands/doctor
 */

const path = require('path');
const { success, error, info, highlight, dim } = require('../util/output');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const UI_MODULE = path.resolve(__dirname, '../../main/ui-automation');

const DOCTOR_SCHEMA_VERSION = 'doctor.v1';

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

async function withConsoleSilenced(enabled, fn) {
  if (!enabled) {
    return fn();
  }

  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };

  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};

  try {
    return await fn();
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
  }
}

function normalizeText(text) {
  return String(text || '').trim();
}

function normalizeForMatch(text) {
  return normalizeText(text).toLowerCase();
}

function normalizeForLooseMatch(text) {
  return normalizeForMatch(text)
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function includesCI(haystack, needle) {
  if (!haystack || !needle) return false;
  // Loose match to tolerate punctuation differences (e.g., "Microsoft? Edge Beta")
  return normalizeForLooseMatch(haystack).includes(normalizeForLooseMatch(needle));
}

function extractQuotedStrings(text) {
  const out = [];
  const str = normalizeText(text);
  const re = /"([^"]+)"|'([^']+)'/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    const val = m[1] || m[2];
    if (val) out.push(val);
  }
  return out;
}

function escapeDoubleQuotes(text) {
  return String(text || '').replace(/"/g, '\\"');
}

function extractUrlCandidate(text) {
  const str = normalizeText(text);

  // Full URL
  const fullUrl = /(https?:\/\/[^\s"']+)/i.exec(str);
  if (fullUrl?.[1]) return fullUrl[1];

  // Common bare domains (keep conservative)
  const bare = /\b([a-z0-9-]+\.)+(com|net|org|io|ai|dev|edu|gov)(\/[^\s"']*)?\b/i.exec(str);
  if (bare?.[0]) return bare[0];

  return null;
}

function extractSearchQuery(text) {
  const str = normalizeText(text);
  const quoted = extractQuotedStrings(str);

  // Prefer quoted strings if user said search ... for "..."
  const searchFor = /\bsearch\b/i.test(str) && /\bfor\b/i.test(str);
  if (searchFor && quoted.length) return quoted[0];

  // Unquoted: search (on/in)? (youtube/google)? for <rest>
  const m = /\bsearch(?:\s+(?:on|in))?(?:\s+(?:youtube|google))?\s+for\s+([^\n\r.;]+)$/i.exec(str);
  if (m?.[1]) return normalizeText(m[1]);

  return null;
}

function toHttpsUrl(urlish) {
  const u = normalizeText(urlish);
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  return `https://${u}`;
}

function buildSearchUrl({ query, preferYouTube = false }) {
  const q = normalizeText(query);
  if (!q) return null;
  if (preferYouTube) {
    return `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

function parseRequestHints(requestText) {
  const text = normalizeText(requestText);
  const lower = normalizeForMatch(text);

  // Extract common patterns
  const tabTitleMatch = /\btab\s+(?:titled|named|called)\s+(?:"([^"]+)"|'([^']+)'|([^,.;\n\r]+))/i.exec(text);
  const tabTitle = tabTitleMatch ? normalizeText(tabTitleMatch[1] || tabTitleMatch[2] || tabTitleMatch[3]) : null;

  const inWindowMatch = /\b(?:in|within)\s+([^\n\r]+?)\s+window\b/i.exec(text);
  const windowHint = inWindowMatch ? normalizeText(inWindowMatch[1]) : null;

  const wantsNewTab = /\bnew\s+tab\b/i.test(text) || /\bopen\s+a\s+new\s+tab\b/i.test(text);
  const urlCandidate = extractUrlCandidate(text);
  const searchQuery = extractSearchQuery(text);

  const wantsIntegratedBrowser = /\b(integrated\s+browser|simple\s+browser|inside\s+vs\s*code|in\s+vs\s*code|vscode\s+insiders|workbench\.browser\.openlocalhostlinks|live\s+preview)\b/i.test(text);

  const browserSignals = Boolean(urlCandidate)
    || Boolean(searchQuery)
    || /\b(go\s+to|navigate|visit|open\s+youtube|youtube\.com|search)\b/i.test(text);

  // Heuristic: infer app family
  const appHints = {
    isBrowser: /\b(edge|chrome|chromium|firefox|brave|opera|vivaldi|browser|msedge)\b/i.test(text) || browserSignals,
    isEditor: /\b(vs\s*code|visual\s*studio\s*code|code\s*-\s*insiders|editor)\b/i.test(text),
    isTerminal: /\b(terminal|powershell|cmd\.exe|command\s+prompt|windows\s+terminal)\b/i.test(text),
    isExplorer: /\b(file\s+explorer|explorer\.exe)\b/i.test(text),
  };

  const requestedBrowser = (() => {
    // Ordered from most-specific to least-specific
    if (/\bedge\s+beta\b/i.test(text)) return { name: 'edge', keywords: ['edge', 'msedge', 'beta'] };
    if (/\bmsedge\b/i.test(text) || /\bmicrosoft\s+edge\b/i.test(text) || /\bedge\b/i.test(text)) return { name: 'edge', keywords: ['edge', 'msedge'] };
    if (/\bgoogle\s+chrome\b/i.test(text) || /\bchrome\b/i.test(text) || /\bchromium\b/i.test(text)) return { name: 'chrome', keywords: ['chrome', 'chromium'] };
    if (/\bmozilla\s+firefox\b/i.test(text) || /\bfirefox\b/i.test(text)) return { name: 'firefox', keywords: ['firefox'] };
    if (/\bbrave\b/i.test(text)) return { name: 'brave', keywords: ['brave'] };
    if (/\bvivaldi\b/i.test(text)) return { name: 'vivaldi', keywords: ['vivaldi'] };
    if (/\bopera\b/i.test(text)) return { name: 'opera', keywords: ['opera'] };
    return null;
  })();

  // Infer intent
  const intent = (() => {
    if (/\bclose\b/.test(lower) && /\btab\b/.test(lower)) return 'close_tab';
    if (/\bclose\b/.test(lower) && /\bwindow\b/.test(lower)) return 'close_window';
    if (appHints.isBrowser && (urlCandidate || searchQuery)) return 'browser_navigate';
    if (appHints.isBrowser && /\b(new\s+tab|open\s+tab|ctrl\+t|ctrl\+l|navigate|go\s+to|visit|open\s+youtube|youtube\.com|search\s+for|search)\b/i.test(text)) return 'browser_navigate';
    if (/\bclick\b/.test(lower)) return 'click';
    if (/\btype\b/.test(lower) || /\benter\b/.test(lower)) return 'type';
    if (/\bscroll\b/.test(lower)) return 'scroll';
    if (/\bdrag\b/.test(lower)) return 'drag';
    if (/\bfind\b/.test(lower) || /\blocate\b/.test(lower)) return 'find';
    if (/\bfocus\b/.test(lower) || /\bactivate\b/.test(lower) || /\bbring\b/.test(lower)) return 'focus';
    return 'unknown';
  })();

  const quoted = extractQuotedStrings(text);

  // Potential element text is often quoted, but avoid using the tab title as element text.
  const elementTextCandidates = quoted.filter(q => q && q !== tabTitle);

  return {
    raw: text,
    intent,
    windowHint,
    tabTitle,
    appHints,
    elementTextCandidates,
    wantsNewTab,
    urlCandidate,
    searchQuery,
    requestedBrowser,
    wantsIntegratedBrowser,
  };
}

function isLikelyBrowserWindow(win) {
  const title = win?.title || '';
  const proc = win?.processName || '';
  return (
    includesCI(proc, 'msedge') || includesCI(title, 'edge') ||
    includesCI(proc, 'chrome') || includesCI(title, 'chrome') ||
    includesCI(proc, 'firefox') || includesCI(title, 'firefox') ||
    includesCI(proc, 'brave') || includesCI(title, 'brave') ||
    includesCI(proc, 'opera') || includesCI(title, 'opera') ||
    includesCI(proc, 'vivaldi') || includesCI(title, 'vivaldi')
  );
}

function isLikelyVSCodeWindow(win) {
  const title = win?.title || '';
  const proc = win?.processName || '';
  return (
    includesCI(proc, 'Code') || includesCI(proc, 'Code - Insiders') ||
    includesCI(title, 'Visual Studio Code')
  );
}

function isLocalhostUrl(urlish) {
  const u = normalizeText(urlish);
  if (!u) return false;
  return /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(u);
}

function scoreWindowCandidate(win, hints) {
  let score = 0;
  const reasons = [];

  const title = win?.title || '';
  const proc = win?.processName || '';

  if (hints.windowHint && includesCI(title, hints.windowHint)) {
    score += 60;
    reasons.push('title matches windowHint');
  }

  const looksLikeBrowser = isLikelyBrowserWindow(win);

  if (hints.appHints?.isBrowser && looksLikeBrowser) {
    score += 35;
    reasons.push('looks like browser');
  }

  if (hints.requestedBrowser?.keywords?.length) {
    const matchesPreferred = hints.requestedBrowser.keywords.some(k => includesCI(proc, k) || includesCI(title, k));
    if (matchesPreferred) {
      score += 25;
      reasons.push(`matches requested browser (${hints.requestedBrowser.name})`);
    }
  }
  if (hints.appHints?.isEditor && (includesCI(title, 'visual studio code') || includesCI(title, 'code - insiders') || includesCI(proc, 'Code') || includesCI(proc, 'Code - Insiders'))) {
    score += 35;
    reasons.push('looks like editor');
  }
  if (hints.appHints?.isTerminal && (includesCI(title, 'terminal') || includesCI(proc, 'WindowsTerminal') || includesCI(proc, 'pwsh') || includesCI(proc, 'cmd'))) {
    score += 30;
    reasons.push('looks like terminal');
  }
  if (hints.appHints?.isExplorer && (includesCI(proc, 'explorer') || includesCI(title, 'file explorer'))) {
    score += 30;
    reasons.push('looks like explorer');
  }

  // Prefer non-empty titled windows
  if (normalizeText(title).length > 0) {
    score += 3;
  }

  return { score, reasons };
}

function buildSuggestedPlan(hints, activeWindow, rankedCandidates) {
  const windowsRanked = Array.isArray(rankedCandidates) ? rankedCandidates.map(c => c.window).filter(Boolean) : [];
  const browserWindowsRanked = windowsRanked.filter(isLikelyBrowserWindow);
  const vsCodeWindowsRanked = windowsRanked.filter(isLikelyVSCodeWindow);

  const target = (() => {
    // If the user explicitly wants the VS Code integrated browser, target VS Code.
    if (hints.wantsIntegratedBrowser) {
      if (vsCodeWindowsRanked[0]) return vsCodeWindowsRanked[0];
      if (activeWindow && isLikelyVSCodeWindow(activeWindow)) return activeWindow;
      return windowsRanked[0] || activeWindow || null;
    }

    // For browser actions, never target an arbitrary non-browser window.
    if (hints.intent === 'browser_navigate' && hints.appHints?.isBrowser) {
      if (hints.requestedBrowser?.keywords?.length) {
        const preferred = browserWindowsRanked.find(w => hints.requestedBrowser.keywords.some(k => includesCI(w?.processName || '', k) || includesCI(w?.title || '', k)));
        if (preferred) return preferred;
      }

      // Fallback to any detected browser window, else the active window if it is a browser.
      if (browserWindowsRanked[0]) return browserWindowsRanked[0];
      if (activeWindow && isLikelyBrowserWindow(activeWindow)) return activeWindow;
      return null;
    }

    // Non-browser intents: use ranking, then active window.
    return windowsRanked[0] || activeWindow || null;
  })();
  const plan = [];

  const targetTitleForFilter = target?.title ? String(target.title) : null;

  const targetSelector = (() => {
    if (!target) return null;
    if (typeof target.hwnd === 'number' && Number.isFinite(target.hwnd)) {
      return { by: 'hwnd', value: target.hwnd };
    }
    if (target.title) {
      return { by: 'title', value: target.title };
    }
    return null;
  })();

  // State machine-ish scaffold. Keep it deterministic and CLI-driven.
  plan.push({
    state: 'VERIFY_ACTIVE_WINDOW',
    goal: 'Confirm which window will receive input',
    command: 'liku window --active',
    verification: 'Active window title/process match the intended target',
  });

  if (targetSelector && hints.intent !== 'unknown') {
    const frontCmd = targetSelector.by === 'hwnd'
      ? `liku window --front --hwnd ${targetSelector.value}`
      : `liku window --front "${String(targetSelector.value).replace(/"/g, '\\"')}"`;

    plan.unshift({
      state: 'FOCUS_TARGET_WINDOW',
      goal: 'Bring the intended target window to the foreground',
      command: frontCmd,
      verification: 'Window is foreground and becomes active',
    });
  }

  // Tab targeting for browsers is always a separate step.
  if (hints.intent === 'close_tab' && hints.tabTitle) {
    const windowFilter = targetTitleForFilter ? ` --window "${targetTitleForFilter.replace(/"/g, '\\"')}"` : '';
    plan.push({
      state: 'ACTIVATE_TARGET_TAB',
      goal: `Make the tab active: "${hints.tabTitle}"`,
      command: `liku click "${String(hints.tabTitle).replace(/"/g, '\\"')}" --type TabItem${windowFilter}`,
      verification: 'The tab becomes active (visually highlighted)',
      notes: 'If UIA cannot see browser tabs, fall back to ctrl+1..9 or ctrl+tab cycling with waits.',
    });
    plan.push({
      state: 'EXECUTE_ACTION',
      goal: 'Close the active tab',
      command: 'liku keys ctrl+w',
      verification: 'Tab disappears; previous tab becomes active',
    });
    return { target, plan };
  }

  if (hints.intent === 'browser_navigate' && hints.appHints?.isBrowser) {
    // If running inside VS Code and the user wants it, prefer using the Integrated Browser.
    if (hints.wantsIntegratedBrowser) {
      const url = toHttpsUrl(hints.urlCandidate) || buildSearchUrl({ query: hints.searchQuery, preferYouTube: false });
      const localhostish = isLocalhostUrl(hints.urlCandidate);

      plan.push({
        state: 'OPEN_INTEGRATED_BROWSER',
        goal: 'Open VS Code Integrated Browser',
        command: 'liku keys ctrl+shift+p',
        verification: 'Command Palette opens',
        notes: 'Run the VS Code command: "Browser: Open Integrated Browser"',
      });
      plan.push({
        state: 'COMMAND_INTEGRATED_BROWSER',
        goal: 'Run the Integrated Browser command',
        command: 'liku type "Browser: Open Integrated Browser"',
        verification: 'The command appears in the palette',
      });
      plan.push({
        state: 'CONFIRM_COMMAND',
        goal: 'Execute the command',
        command: 'liku keys enter',
        verification: 'An Integrated Browser editor tab opens',
        notes: localhostish
          ? 'Tip: enable the VS Code setting workbench.browser.openLocalhostLinks to automatically open localhost links in the integrated browser.'
          : 'Integrated Browser supports http(s) and file URLs.',
      });

      if (localhostish) {
        plan.push({
          state: 'OPEN_SETTINGS',
          goal: 'Open VS Code Settings (optional)',
          command: 'liku keys ctrl+,',
          verification: 'Settings UI opens',
        });
        plan.push({
          state: 'FIND_SETTING',
          goal: 'Locate the localhost-integrated-browser setting',
          command: 'liku type "workbench.browser.openLocalhostLinks"',
          verification: 'The setting appears in search results',
          notes: 'Enable it to route localhost links to the Integrated Browser.',
        });
        plan.push({
          state: 'VERIFY_SETTING',
          goal: 'Capture evidence of the setting state',
          command: 'liku screenshot',
          verification: 'Screenshot shows the setting and whether it is enabled',
        });
      }

      if (url) {
        plan.push({
          state: 'FOCUS_ADDRESS_BAR',
          goal: 'Focus the integrated browser address bar',
          command: 'liku keys ctrl+l',
          verification: 'Address bar is focused (URL text highlighted)',
        });
        plan.push({
          state: 'TYPE_URL',
          goal: 'Type the destination URL',
          command: `liku type "${escapeDoubleQuotes(url)}"`,
          verification: 'The full URL appears correctly in the address bar',
        });
        plan.push({
          state: 'NAVIGATE',
          goal: 'Navigate to the URL in the integrated browser',
          command: 'liku keys enter',
          verification: 'Page begins loading; content changes',
        });
      } else {
        plan.push({
          state: 'MISSING_URL',
          goal: 'No URL could be inferred from the request',
          command: 'liku screenshot',
          verification: 'Use the screenshot to decide the next navigation step',
        });
      }

      plan.push({
        state: 'VERIFY_RESULT',
        goal: 'Capture evidence of the resulting page state',
        command: 'liku screenshot',
        verification: 'Screenshot shows expected page state in the integrated browser',
      });

      return { target, plan };
    }

    if (!target) {
      plan.push({
        state: 'NO_BROWSER_WINDOW',
        goal: 'No browser window was detected; open a browser window first',
        command: 'liku window',
        verification: 'A browser window (Edge/Chrome/Firefox/Brave/etc) appears in the list',
      });
      return { target: null, plan };
    }

    // Prefer deterministic in-window navigation over process launch.
    const preferYouTube = /\byoutube\b/i.test(hints.raw || '') || /youtube\.com/i.test(hints.raw || '');
    const url = (
      toHttpsUrl(hints.urlCandidate) ||
      buildSearchUrl({ query: hints.searchQuery, preferYouTube })
    );

    if (hints.wantsNewTab) {
      plan.push({
        state: 'OPEN_NEW_TAB',
        goal: 'Open a new tab in the focused browser window',
        command: 'liku keys ctrl+t',
        verification: 'A new tab opens (tab count increases or blank tab appears)',
      });
    }

    plan.push({
      state: 'FOCUS_ADDRESS_BAR',
      goal: 'Focus the address bar',
      command: 'liku keys ctrl+l',
      verification: 'Address bar is focused (URL text highlighted)',
      notes: 'If focus is flaky, re-run `liku window --active` and re-focus the browser window before sending keys.',
    });

    if (url) {
      plan.push({
        state: 'TYPE_URL',
        goal: `Type the destination URL${hints.searchQuery ? ' (search encoded into URL for reliability)' : ''}`,
        command: `liku type "${escapeDoubleQuotes(url)}"`,
        verification: 'The full URL appears correctly in the address bar',
        notes: 'If characters drop: ctrl+l → ctrl+a → type URL again → enter (with short pauses).',
      });
      plan.push({
        state: 'NAVIGATE',
        goal: 'Navigate to the URL in the current tab',
        command: 'liku keys enter',
        verification: 'Page begins loading; title/content changes',
      });
    } else {
      plan.push({
        state: 'MISSING_URL',
        goal: 'No URL could be inferred from the request',
        command: 'liku screenshot',
        verification: 'Use the screenshot to decide the next navigation step',
      });
    }

    plan.push({
      state: 'VERIFY_FOCUS',
      goal: 'Verify keyboard focus stayed on the browser window',
      command: 'liku window --active',
      verification: hints.requestedBrowser?.name
        ? `Active window process/title matches the requested browser (${hints.requestedBrowser.name})`
        : 'Active window process/title matches a browser window',
    });

    plan.push({
      state: 'VERIFY_RESULT',
      goal: 'Capture evidence of the resulting page state',
      command: 'liku screenshot',
      verification: 'Screenshot shows expected page (e.g., YouTube results for query)',
    });

    return { target, plan };
  }

  if (hints.intent === 'close_window') {
    plan.push({
      state: 'EXECUTE_ACTION',
      goal: 'Close the active window',
      command: 'liku keys alt+f4',
      verification: 'Window closes and focus changes',
      notes: 'Prefer alt+f4 for closing windows; ctrl+shift+w is app-specific and can close the wrong thing.',
    });
    return { target, plan };
  }

  if (hints.intent === 'click') {
    const elementText = hints.elementTextCandidates?.[0] || null;
    if (elementText) {
      const windowFilter = targetTitleForFilter ? ` --window "${targetTitleForFilter.replace(/"/g, '\\"')}"` : '';
      plan.push({
        state: 'EXECUTE_ACTION',
        goal: `Click element: "${elementText}"`,
        command: `liku click "${String(elementText).replace(/"/g, '\\"')}"${windowFilter}`,
        verification: 'Expected UI response occurs (button press, navigation, etc.)',
      });
    }
    return { target, plan };
  }

  // Generic fallback: ensure focus + suggest next step.
  plan.push({
    state: 'NEXT',
    goal: 'If the target is not correct, refine the window hint and retry',
    command: 'liku window  # list windows',
    verification: 'You can identify the intended window title/process',
  });

  return { target, plan };
}

function mermaidForPlan(plan) {
  if (!Array.isArray(plan) || plan.length === 0) return null;
  const ids = plan.map(p => p.state);
  const edges = [];
  for (let i = 0; i < ids.length - 1; i++) {
    edges.push(`${ids[i]} --> ${ids[i + 1]}`);
  }
  return `stateDiagram-v2\n  ${edges.join('\n  ')}`;
}

function buildChecks({ uiaError, activeWindow, windows, requestText, requestHints, requestAnalysis }) {
  const checks = [];
  const push = (id, status, message, details = null) => {
    checks.push({ id, status, message, details });
  };

  push(
    'uia.available',
    uiaError ? 'fail' : 'pass',
    uiaError ? 'UI Automation unavailable or errored' : 'UI Automation available',
    uiaError ? { error: uiaError } : null
  );

  push(
    'ui.activeWindow.present',
    activeWindow ? 'pass' : 'warn',
    activeWindow ? 'Active window detected' : 'Active window missing',
    activeWindow ? { title: activeWindow.title, processName: activeWindow.processName, hwnd: activeWindow.hwnd } : null
  );

  push(
    'ui.windows.enumerated',
    Array.isArray(windows) && windows.length > 0 ? 'pass' : 'warn',
    Array.isArray(windows) && windows.length > 0 ? `Enumerated ${windows.length} windows` : 'No windows enumerated',
    Array.isArray(windows) ? { count: windows.length } : { count: 0 }
  );

  if (requestText) {
    push(
      'request.parsed',
      requestHints ? 'pass' : 'fail',
      requestHints ? 'Request parsed into hints' : 'Request parsing failed',
      requestHints || null
    );
    push(
      'request.plan.generated',
      requestAnalysis?.plan?.length ? 'pass' : 'warn',
      requestAnalysis?.plan?.length ? `Generated ${requestAnalysis.plan.length} plan steps` : 'No plan steps generated',
      requestAnalysis?.plan?.length ? { steps: requestAnalysis.plan.map(s => s.state) } : null
    );
  }

  return checks;
}

function summarizeChecks(checks) {
  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) {
    if (c.status === 'pass') summary.pass += 1;
    else if (c.status === 'warn') summary.warn += 1;
    else if (c.status === 'fail') summary.fail += 1;
  }
  return summary;
}

async function run(args, options) {
  // Load package metadata from the resolved project root (this is the key signal
  // for "am I running the local install or some other copy?")
  let pkg;
  try {
    pkg = require(path.join(PROJECT_ROOT, 'package.json'));
  } catch (e) {
    if (!options.quiet) {
      error(`Failed to load package.json from ${PROJECT_ROOT}: ${e.message}`);
    }
    return { success: false, error: 'Could not load package metadata', projectRoot: PROJECT_ROOT };
  }

  const generatedAt = new Date().toISOString();

  const envInfo = {
    name: pkg.name,
    version: pkg.version,
    projectRoot: PROJECT_ROOT,
    cwd: process.cwd(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
  };

  const requestText = args.length > 0 ? args.join(' ') : null;
  const requestHints = requestText ? parseRequestHints(requestText) : null;

  // UIA / active window + other state
  let activeWindow = null;
  let windows = [];
  let mouse = null;
  let uiaError = null;
  await withConsoleSilenced(Boolean(options.json), async () => {
    try {
      // Lazy load so doctor still works even if UIA deps are missing
      // (we'll just report that in output)
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const ui = require(UI_MODULE);
      activeWindow = await ui.getActiveWindow();
      mouse = await ui.getMousePosition();

      // Keep window lists bounded by default.
      const maxWindows = options.all ? Number.MAX_SAFE_INTEGER : (options.windows ? parseInt(options.windows, 10) : 15);
      const allWindows = await ui.findWindows({});
      windows = Array.isArray(allWindows) ? allWindows.slice(0, maxWindows) : [];

      if (!activeWindow) {
        uiaError = 'No active window detected';
      }
    } catch (e) {
      uiaError = e.message;
    }
  });

  // Candidate targeting analysis (optional)
  let requestAnalysis = null;
  if (requestHints) {
    const candidates = (Array.isArray(windows) ? windows : []).map(w => {
      const { score, reasons } = scoreWindowCandidate(w, requestHints);
      return { score, reasons, window: w };
    }).sort((a, b) => b.score - a.score);

    const { target, plan } = buildSuggestedPlan(requestHints, activeWindow, candidates);
    requestAnalysis = {
      request: requestHints,
      target,
      candidates: candidates.slice(0, 8).map(c => ({ score: c.score, reasons: c.reasons, window: c.window })),
      plan,
      mermaid: options.flow ? mermaidForPlan(plan) : null,
    };
  }

  const checks = buildChecks({ uiaError, activeWindow, windows, requestText, requestHints, requestAnalysis });
  const checksSummary = summarizeChecks(checks);
  const ok = checksSummary.fail === 0;

  const report = {
    schemaVersion: DOCTOR_SCHEMA_VERSION,
    generatedAt,
    ok,
    checks,
    checksSummary,
    env: envInfo,
    request: requestText ? { text: requestText, hints: requestHints } : null,
    uiState: {
      activeWindow,
      windows,
      mouse,
      uiaError: uiaError || null,
    },
    targeting: requestAnalysis ? {
      selectedWindow: requestAnalysis.target || null,
      candidates: requestAnalysis.candidates || [],
    } : null,
    plan: requestAnalysis ? {
      steps: requestAnalysis.plan || [],
      mermaid: requestAnalysis.mermaid || null,
    } : null,
    next: {
      commands: (
        requestAnalysis?.plan?.length
          ? requestAnalysis.plan.map(s => s.command).filter(Boolean)
          : ['liku window --active', 'liku window']
      ),
    },
  };

  if (options.json) {
    // Caller wants machine-readable output
    return report;
  }

  if (!options.quiet) {
    console.log(`\n${highlight('Liku Diagnostics (doctor)')}\n`);

    console.log(`${highlight('Package:')} ${envInfo.name} v${envInfo.version}`);
    console.log(`${highlight('Resolved root:')} ${envInfo.projectRoot}`);
    console.log(`${highlight('Node:')} ${envInfo.node} (${envInfo.platform}/${envInfo.arch})`);
    console.log(`${highlight('CWD:')} ${envInfo.cwd}`);

    console.log(`${highlight('Schema:')} ${DOCTOR_SCHEMA_VERSION}`);
    console.log(`${highlight('OK:')} ${ok ? 'true' : 'false'} ${dim(`(pass=${checksSummary.pass} warn=${checksSummary.warn} fail=${checksSummary.fail})`)}`);

    console.log(`\n${highlight('Active window:')}`);
    if (activeWindow) {
      const bounds = activeWindow.bounds || { x: '?', y: '?', width: '?', height: '?' };
      console.log(`  Title:    ${activeWindow.title || dim('(unknown)')}`);
      console.log(`  Process:  ${activeWindow.processName || dim('(unknown)')}`);
      console.log(`  Class:    ${activeWindow.className || dim('(unknown)')}`);
      console.log(`  Handle:   ${activeWindow.hwnd ?? dim('(unknown)')}`);
      console.log(`  Bounds:   ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`);
    } else {
      error(`Could not read active window (${uiaError || 'unknown error'})`);
      info('Tip: try running `liku window --active` to confirm UI Automation is working.');
    }

    if (mouse) {
      console.log(`\n${highlight('Mouse:')} ${mouse.x},${mouse.y}`);
    }

    if (Array.isArray(windows) && windows.length > 0) {
      console.log(`\n${highlight(`Top windows (${windows.length}${options.all ? '' : ' shown'}):`)}`);
      windows.slice(0, 10).forEach((w, idx) => {
        const title = w.title || '(untitled)';
        const proc = w.processName || '-';
        const hwnd = w.hwnd ?? '?';
        console.log(`  ${idx + 1}. [${hwnd}] ${title} ${dim('—')} ${proc}`);
      });
      if (windows.length > 10) {
        console.log(dim('  (Use --windows <n> or --all with --json for more)'));
      }
    }

    // Helpful next-step hints for browser operations
    console.log(`\n${highlight('Targeting tips:')}`);
    console.log(`  - Before sending keys, ensure the intended app is active.`);
    console.log(`  - For browsers: activate the correct tab first, then use ${highlight('ctrl+w')} to close the active tab.`);

    if (requestAnalysis?.plan?.length) {
      console.log(`\n${highlight('Suggested plan:')}`);
      requestAnalysis.plan.forEach((step, i) => {
        console.log(`  ${i + 1}. ${highlight(step.state)}: ${step.command}`);
      });
      if (options.flow && requestAnalysis.mermaid) {
        console.log(`\n${highlight('Flow (Mermaid):')}\n${requestAnalysis.mermaid}`);
      }
    }

    // For debugging copy/paste
    if (options.debug) {
      const json = safeJsonStringify(report);
      if (json) {
        console.log(`\n${highlight('Raw JSON:')}\n${json}`);
      }
    }

    if (ok) success('Doctor check OK');
  }

  return report;
}

module.exports = { run };
