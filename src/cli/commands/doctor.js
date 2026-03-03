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

  // Localhost URLs are common in dev workflows and are often written without scheme.
  const localhostish = /\b((?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/[^\s"']*)?)/i.exec(str);
  if (localhostish?.[1]) return localhostish[1];

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

  const ALLOWED_PLAN_STATES = new Set([
    'FOCUS',
    'NAVIGATE',
    'ASSERT',
    'ENUMERATE',
    'SCORE',
    'INVOKE',
    'VERIFY',
    'RECOVER',
  ]);

  const addStep = (state, step) => {
    if (!ALLOWED_PLAN_STATES.has(state)) {
      // Keep output stable even if a caller passes a bad state.
      state = 'NAVIGATE';
    }
    plan.push({
      state,
      goal: step.goal,
      command: step.command || null,
      verification: step.verification || null,
      notes: step.notes || null,
      inputs: step.inputs || null,
      outputs: step.outputs || null,
      recovery: step.recovery || null,
    });
  };

  const extractScrollSpec = (raw) => {
    const text = normalizeText(raw);
    const dir = /\bup\b/i.test(text) ? 'up' : (/\bdown\b/i.test(text) ? 'down' : null);
    const m = /\b(\d+)\b/.exec(text);
    const amount = m?.[1] ? parseInt(m[1], 10) : null;
    return { dir, amount };
  };

  const extractDragSpec = (raw) => {
    const text = normalizeText(raw);
    const m = /\bfrom\s+(\d+)\s*,\s*(\d+)\s+to\s+(\d+)\s*,\s*(\d+)\b/i.exec(text);
    if (!m) return null;
    const nums = m.slice(1).map(n => parseInt(n, 10));
    if (nums.some(n => !Number.isFinite(n))) return null;
    return { x1: nums[0], y1: nums[1], x2: nums[2], y2: nums[3] };
  };

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

  // Deterministic scaffold.
  const didInitialFocus = Boolean(targetSelector && hints.intent !== 'unknown');
  if (didInitialFocus) {
    const frontCmd = targetSelector.by === 'hwnd'
      ? `liku window --front --hwnd ${targetSelector.value}`
      : `liku window --front "${String(targetSelector.value).replace(/"/g, '\\"')}"`;

    addStep('FOCUS', {
      goal: 'Bring the intended target window to the foreground',
      command: frontCmd,
      verification: 'The target window becomes the active foreground window',
      notes: 'If focus is flaky, repeat this step before sending keys/clicks.',
    });
  }

  addStep('ASSERT', {
    goal: 'Confirm which window will receive input',
    command: 'liku window --active',
    verification: 'Active window title/process match the intended target',
    notes: 'This is a pollable verification gate; do not proceed if the wrong window is active.',
  });

  // Tab targeting for browsers is always a separate step.
  if (hints.intent === 'close_tab' && hints.tabTitle) {
    const windowFilter = targetTitleForFilter ? ` --window "${targetTitleForFilter.replace(/"/g, '\\"')}"` : '';
    addStep('NAVIGATE', {
      goal: `Make the tab active: "${hints.tabTitle}"`,
      command: `liku click "${String(hints.tabTitle).replace(/"/g, '\\"')}" --type TabItem${windowFilter}`,
      verification: 'The tab becomes active (visually highlighted)',
      notes: 'If UIA cannot see browser tabs, fall back to ctrl+1..9 or ctrl+tab cycling with waits.',
    });
    addStep('INVOKE', {
      goal: 'Close the active tab',
      command: 'liku keys ctrl+w',
      verification: 'Tab closes',
    });
    addStep('VERIFY', {
      goal: 'Verify the tab was closed',
      command: 'liku window --active',
      verification: 'Active browser window remains focused and the target tab is no longer present',
      notes: 'Prefer verification via UI state/title change; avoid file screenshots.',
    });
    return { target, plan };
  }

  if (hints.intent === 'browser_navigate' && hints.appHints?.isBrowser) {
    addStep('NAVIGATE', {
      goal: '(Optional) Enable ephemeral visual verification (bounded buffer)',
      command: 'liku start --background',
      verification: 'The Liku visual agent is running (overlay available)',
      notes: [
        'This replaces “files everywhere” screenshots with ephemeral frames stored in a bounded in-memory buffer.',
        'Enable always-on active-window streaming via env vars before starting:',
        '  LIKU_ACTIVE_WINDOW_STREAM=1',
        '  LIKU_ACTIVE_WINDOW_STREAM_INTERVAL_MS=750   (tune as needed)',
        '  LIKU_ACTIVE_WINDOW_STREAM_START_DELAY_MS=2500',
        'Verification can then rely on: active window polling + frame diff/hash + OCR/vision-derived signals.',
        'If you need a purely CLI pollable frame hash (no file output):',
        '  liku screenshot --memory --hash --json',
        'If you need to wait until the frame changes (polling):',
        '  liku verify-hash --timeout 8000 --interval 250 --json',
        'If you need to wait until rendering settles (stable-for window):',
        '  liku verify-stable --metric dhash --epsilon 4 --stable-ms 800 --timeout 15000 --interval 250 --json',
      ].join('\n'),
    });

    // If running inside VS Code and the user wants it, prefer using the Integrated Browser.
    if (hints.wantsIntegratedBrowser) {
      const url = toHttpsUrl(hints.urlCandidate) || buildSearchUrl({ query: hints.searchQuery, preferYouTube: false });
      const localhostish = isLocalhostUrl(hints.urlCandidate);

      addStep('NAVIGATE', {
        goal: 'Open VS Code command palette',
        command: 'liku keys ctrl+shift+p',
        verification: 'Command Palette opens',
      });
      addStep('NAVIGATE', {
        goal: 'Run the Integrated Browser command',
        command: 'liku type "Browser: Open Integrated Browser"',
        verification: 'The command appears in the palette',
      });
      addStep('INVOKE', {
        goal: 'Execute the command',
        command: 'liku keys enter',
        verification: 'An Integrated Browser editor tab opens',
        notes: localhostish
          ? 'If this is localhost, consider enabling workbench.browser.openLocalhostLinks so localhost links route to the Integrated Browser.'
          : 'Integrated Browser supports http(s) and file URLs.',
      });

      if (localhostish) {
        addStep('NAVIGATE', {
          goal: 'Open VS Code Settings (optional)',
          command: 'liku keys ctrl+,',
          verification: 'Settings UI opens',
        });
        addStep('ASSERT', {
          goal: 'Locate the localhost-integrated-browser setting',
          command: 'liku type "workbench.browser.openLocalhostLinks"',
          verification: 'The setting appears in search results',
          notes: 'Enable it to route localhost links to the Integrated Browser.',
        });
        addStep('VERIFY', {
          goal: 'Verify the setting is enabled',
          command: null,
          verification: 'Setting toggle shows enabled',
          notes: 'Verification should rely on visible UI state (ephemeral frames), not saved screenshots.',
        });
      }

      if (url) {
        addStep('NAVIGATE', {
          goal: 'Focus the integrated browser address bar',
          command: 'liku keys ctrl+l',
          verification: 'Address bar is focused (URL text highlighted)',
        });
        addStep('NAVIGATE', {
          goal: 'Type the destination URL',
          command: `liku type "${escapeDoubleQuotes(url)}"`,
          verification: 'The full URL appears correctly in the address bar',
        });
        addStep('INVOKE', {
          goal: 'Navigate to the URL in the integrated browser',
          command: 'liku keys enter',
          verification: 'Page begins loading; content changes',
        });
      } else {
        addStep('ASSERT', {
          goal: 'No URL could be inferred from the request',
          command: null,
          verification: 'Decide the next navigation step from current UI state',
          notes: 'Prefer using ephemeral active-window frames (bounded buffer) for inspection rather than writing screenshot files.',
        });
      }

      addStep('VERIFY', {
        goal: 'Verify the resulting page state',
        command: 'liku window --active',
        verification: 'VS Code remains active and the Integrated Browser shows expected content',
        notes: 'Verification should be pollable (active window) plus ephemeral frames/vision-derived signals, not saved screenshots.',
      });

      return { target, plan };
    }

    if (!target) {
      addStep('ASSERT', {
        goal: 'No browser window was detected; open a browser window first',
        command: 'liku window',
        verification: 'A browser window appears in the list',
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
      addStep('NAVIGATE', {
        goal: 'Open a new tab in the focused browser window',
        command: 'liku keys ctrl+t',
        verification: 'A new tab opens (blank tab appears)',
      });
    }

    addStep('NAVIGATE', {
      goal: 'Focus the address bar',
      command: 'liku keys ctrl+l',
      verification: 'Address bar is focused (URL text highlighted)',
      notes: 'If focus is flaky: re-run `liku window --active`, re-focus the browser window, then try again.',
    });

    if (url) {
      addStep('NAVIGATE', {
        goal: `Type the destination URL${hints.searchQuery ? ' (search encoded into URL for reliability)' : ''}`,
        command: `liku type "${escapeDoubleQuotes(url)}"`,
        verification: 'The full URL appears correctly in the address bar',
        notes: 'If characters drop: ctrl+l → ctrl+a → type URL again → enter (with short pauses).',
      });
      addStep('INVOKE', {
        goal: 'Navigate to the URL in the current tab',
        command: 'liku keys enter',
        verification: 'Page begins loading; title/content changes',
      });
    } else {
      addStep('ASSERT', {
        goal: 'No URL could be inferred from the request',
        command: null,
        verification: 'Decide the next navigation step from current UI state',
        notes: 'Prefer ephemeral active-window frames (bounded buffer) over saved screenshot files.',
      });
    }

    addStep('VERIFY', {
      goal: 'Verify keyboard focus stayed on the browser window',
      command: 'liku window --active',
      verification: hints.requestedBrowser?.name
        ? `Active window process/title matches the requested browser (${hints.requestedBrowser.name})`
        : 'Active window process/title matches a browser window',
    });

    // Multi-option selection becomes a first-class subroutine when searching/navigating to results pages.
    if (hints.searchQuery || /youtube\.com\/results\?/i.test(url || '')) {
      const query = hints.searchQuery || null;
      const windowFilter = targetTitleForFilter ? ` --window "${targetTitleForFilter.replace(/"/g, '\\"')}"` : '';

      addStep('ENUMERATE', {
        goal: 'Enumerate candidate results/targets on the page',
        command: query
          ? `liku find "${escapeDoubleQuotes(query)}"${windowFilter}`
          : `liku find "*"${windowFilter}`,
        verification: 'A non-empty list of candidate elements is returned (or UIA reports none)',
        notes: 'If UIA cannot see web content (common), switch to vision-based enumeration via the agent’s bounded active-window frame buffer.',
        outputs: { candidates: 'array of UIA elements (name/type/bounds)' },
      });

      addStep('SCORE', {
        goal: 'Score and select the best candidate deterministically',
        command: null,
        verification: 'A single top candidate is selected (and at least one runner-up is retained)',
        notes: [
          'Scoring rules (deterministic, in order):',
          '1) Exact/near-exact text match to the request/search query',
          '2) Prefer results with expected type (Hyperlink/Button) and non-empty bounds',
          '3) Prefer items near the top of the results list',
          'Keep the top 3 as fallbacks for RECOVER.',
        ].join('\n'),
        outputs: { selected: 'best candidate', fallback: 'runner-up candidates' },
      });

      addStep('INVOKE', {
        goal: 'Invoke the selected candidate (click)',
        command: query
          ? `liku click "${escapeDoubleQuotes(query)}"${windowFilter}`
          : null,
        verification: 'The page navigates or the expected UI response occurs',
        notes: query
          ? 'This click uses the query text as the selector. If multiple matches exist, refine enumeration/type/window filters.'
          : 'Invoke by clicking the chosen element from ENUMERATE (requires a concrete selector).',
      });

      addStep('VERIFY', {
        goal: 'Verify the invocation succeeded',
        command: 'liku window --active',
        verification: 'Browser remains active and visible content/title changes as expected',
        notes: 'Verification should be a pollable gate (active window + visible change via ephemeral frames / OCR signals), not saved screenshots.',
      });

      addStep('RECOVER', {
        goal: 'Recover if the chosen candidate was wrong',
        command: 'liku keys alt+left',
        verification: 'Returns to the results/list view',
        recovery: 'Re-run ENUMERATE → SCORE selecting the next runner-up, then INVOKE → VERIFY.',
      });
    }

    return { target, plan };
  }

  if (hints.intent === 'close_window') {
    addStep('INVOKE', {
      goal: 'Close the active window',
      command: 'liku keys alt+f4',
      verification: 'Window closes and focus changes',
      notes: 'Prefer alt+f4 for closing windows; ctrl+shift+w is app-specific and can close the wrong thing.',
    });
    addStep('VERIFY', {
      goal: 'Verify the window closed',
      command: 'liku window --active',
      verification: 'A different window becomes active',
    });
    return { target, plan };
  }

  if (hints.intent === 'focus') {
    if (!didInitialFocus) {
      addStep('FOCUS', {
        goal: 'Bring the intended window to the foreground',
        command: targetSelector
          ? (targetSelector.by === 'hwnd'
            ? `liku window --front --hwnd ${targetSelector.value}`
            : `liku window --front "${String(targetSelector.value).replace(/"/g, '\\"')}"`)
          : 'liku window  # list windows',
        verification: 'The intended window becomes active',
      });
    }
    addStep('VERIFY', {
      goal: 'Verify focus is correct',
      command: 'liku window --active',
      verification: 'Active window title/process match the intended target',
      notes: 'Treat this as a pollable gate before any input.',
    });
    return { target, plan };
  }

  if (hints.intent === 'find') {
    const query = hints.elementTextCandidates?.[0] || hints.searchQuery || null;
    const windowFilter = targetTitleForFilter ? ` --window "${targetTitleForFilter.replace(/"/g, '\\"')}"` : '';
    addStep('ENUMERATE', {
      goal: query ? `Enumerate elements matching: "${query}"` : 'Enumerate candidate elements (missing query)',
      command: query ? `liku find "${escapeDoubleQuotes(query)}"${windowFilter}` : null,
      verification: query ? 'A list of matching elements is returned (or UIA reports none)' : 'Provide a specific query string to enumerate',
      notes: query
        ? 'If UIA cannot see the content (common in browsers), use ephemeral active-window frames + OCR/vision to enumerate.'
        : 'Example: `liku doctor "find \"Save\""`',
      outputs: { candidates: 'array of UIA elements (name/type/bounds)' },
    });
    addStep('SCORE', {
      goal: 'Select the best matching element deterministically',
      command: null,
      verification: 'A single best match is identified (with runner-ups retained)',
      notes: 'Prefer exact text match; then prefer visible/clickable controls with stable bounds.',
    });
    addStep('VERIFY', {
      goal: 'Verify the match is correct',
      command: 'liku window --active',
      verification: 'Target window remains active and the chosen match is plausible in context',
      notes: 'Use pollable state + ephemeral frames/OCR signals rather than screenshot files.',
    });
    return { target, plan };
  }

  if (hints.intent === 'type') {
    const quoted = extractQuotedStrings(hints.raw || '');
    const textToType = quoted[0] || null;
    addStep('ASSERT', {
      goal: 'Confirm the caret/input focus is in the intended field',
      command: 'liku window --active',
      verification: 'Active window is correct and the intended input is focused',
      notes: 'If input focus is wrong, click the field first (use an explicit ENUMERATE→SCORE→INVOKE step for the field).',
    });
    if (textToType) {
      addStep('INVOKE', {
        goal: `Type text: "${textToType}"`,
        command: `liku type "${escapeDoubleQuotes(textToType)}"`,
        verification: 'Text is entered',
      });
      addStep('VERIFY', {
        goal: 'Verify the text appears in the intended field',
        command: null,
        verification: 'Visible field value matches the typed text',
        notes: 'Prefer ephemeral frames/OCR-derived signals + active-window polling; avoid saving screenshot files.',
      });
    } else {
      addStep('ASSERT', {
        goal: 'No quoted text found to type',
        command: null,
        verification: 'Provide the text to type in quotes',
        notes: 'Example: `liku doctor "type \"hello\""`',
      });
    }
    return { target, plan };
  }

  if (hints.intent === 'scroll') {
    const { dir, amount } = extractScrollSpec(hints.raw || '');
    const direction = dir || 'down';
    const amt = Number.isFinite(amount) && amount > 0 ? amount : 5;
    addStep('INVOKE', {
      goal: `Scroll ${direction} by ${amt}`,
      command: `liku scroll ${direction} ${amt}`,
      verification: 'Content moves in the intended direction',
      notes: 'Verify via visible change using ephemeral frames/diff if needed.',
    });
    addStep('VERIFY', {
      goal: 'Verify scroll result',
      command: 'liku window --active',
      verification: 'Target window stays active and content moved',
    });
    return { target, plan };
  }

  if (hints.intent === 'drag') {
    const spec = extractDragSpec(hints.raw || '');
    if (!spec) {
      addStep('ASSERT', {
        goal: 'Drag requested but coordinates were not provided',
        command: null,
        verification: 'Provide coordinates as: from x,y to x,y',
        notes: 'Example: `liku doctor "drag from 100,200 to 400,200"` (then run `liku drag 100 200 400 200`).',
      });
      return { target, plan };
    }
    addStep('INVOKE', {
      goal: `Drag from (${spec.x1},${spec.y1}) to (${spec.x2},${spec.y2})`,
      command: `liku drag ${spec.x1} ${spec.y1} ${spec.x2} ${spec.y2}`,
      verification: 'The intended UI element is moved/selection changes',
    });
    addStep('VERIFY', {
      goal: 'Verify drag result',
      command: 'liku window --active',
      verification: 'Target window remains active and the UI reflects the drag',
      notes: 'If verification is visual-only, use ephemeral frames/diff rather than screenshot files.',
    });
    return { target, plan };
  }

  if (hints.intent === 'click') {
    const elementText = hints.elementTextCandidates?.[0] || null;
    if (elementText) {
      const windowFilter = targetTitleForFilter ? ` --window "${targetTitleForFilter.replace(/"/g, '\\"')}"` : '';
      addStep('ENUMERATE', {
        goal: `Enumerate matches for element text: "${elementText}"`,
        command: `liku find "${String(elementText).replace(/"/g, '\\"')}"${windowFilter}`,
        verification: 'At least one matching element is returned',
      });
      addStep('SCORE', {
        goal: 'Select the best match deterministically',
        command: null,
        verification: 'A single best match is identified',
        notes: 'Prefer exact text match; then prefer elements with a clickable control type (Button/Hyperlink) and visible bounds.',
      });
      addStep('INVOKE', {
        goal: `Click element: "${elementText}"`,
        command: `liku click "${String(elementText).replace(/"/g, '\\"')}"${windowFilter}`,
        verification: 'Expected UI response occurs (button press, navigation, etc.)',
      });
      addStep('VERIFY', {
        goal: 'Verify the click had the intended effect',
        command: 'liku window --active',
        verification: 'Target window remains active and the UI state changes as expected',
        notes: 'If verification is ambiguous, use ephemeral active-window frames/OCR signals rather than saving screenshots.',
      });
    }
    return { target, plan };
  }

  // Generic fallback: ensure focus + suggest next step.
  addStep('RECOVER', {
    goal: 'If the target is not correct, refine the window hint and retry',
    command: 'liku window  # list windows',
    verification: 'You can identify the intended window title/process',
    recovery: 'Repeat FOCUS → ASSERT with a more specific window title/process hint.',
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
