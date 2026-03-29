/**
 * System Automation Module for Agentic AI
 * Provides mouse, keyboard, and system control capabilities
 * 
 * Uses native platform APIs via child_process for zero dependencies
 */

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const gridMath = require('../shared/grid-math');
const { writeTelemetry } = require('./telemetry/telemetry-writer');

// Action types the AI can request
const ACTION_TYPES = {
  CLICK: 'click',           // Click at coordinates
  DOUBLE_CLICK: 'double_click',
  RIGHT_CLICK: 'right_click',
  MOVE_MOUSE: 'move_mouse', // Move mouse without clicking
  TYPE: 'type',             // Type text
  KEY: 'key',               // Press a single key or combo (e.g., "ctrl+c")
  SCROLL: 'scroll',         // Scroll up/down
  WAIT: 'wait',             // Wait for milliseconds
  SCREENSHOT: 'screenshot', // Take a screenshot for verification
  DRAG: 'drag',             // Drag from one point to another
  // Semantic element-based actions (preferred - more reliable)
  CLICK_ELEMENT: 'click_element',   // Click element found by text/name
  FIND_ELEMENT: 'find_element',     // Find element and return its info
  // Pattern-first UIA actions (Phase 3 — no mouse injection needed)
  SET_VALUE: 'set_value',           // Set value via ValuePattern
  SCROLL_ELEMENT: 'scroll_element', // Scroll via ScrollPattern + mouse wheel fallback
  EXPAND_ELEMENT: 'expand_element', // Expand via ExpandCollapsePattern
  COLLAPSE_ELEMENT: 'collapse_element', // Collapse via ExpandCollapsePattern
  GET_TEXT: 'get_text',             // Read text via TextPattern/ValuePattern/Name
  // Direct command execution (most reliable for terminal operations)
  RUN_COMMAND: 'run_command',       // Run shell command directly
  GREP_REPO: 'grep_repo',           // Search repository text with bounded output
  SEMANTIC_SEARCH_REPO: 'semantic_search_repo', // Token-ranked repo search
  PGREP_PROCESS: 'pgrep_process',   // Search running processes by name
  FOCUS_WINDOW: 'focus_window',     // Focus a specific window
  BRING_WINDOW_TO_FRONT: 'bring_window_to_front',
  SEND_WINDOW_TO_BACK: 'send_window_to_back',
  MINIMIZE_WINDOW: 'minimize_window',
  RESTORE_WINDOW: 'restore_window',
};

// Dangerous command patterns that require confirmation
const DANGEROUS_COMMAND_PATTERNS = [
  // Destructive file operations
  /\b(rm|del|erase|rmdir|rd)\s+(-[rf]+|\/[sq]+|\*)/i,
  /Remove-Item.*-Recurse.*-Force/i,
  /\bformat\s+[a-z]:/i,  // Match "format C:" but not "Format-Table"
  // System modification
  /\b(shutdown|restart|reboot)\b/i,
  /\breg\s+(delete|add)\b/i,
  /\bnet\s+(user|localgroup)\b/i,
  // Elevated operations
  /\b(sudo|runas)\b/i,
  /Start-Process.*-Verb\s+RunAs/i,
  /Set-ExecutionPolicy/i,
  /Stop-Process.*-Force/i,
  // Dangerous downloads
  /\b(curl|wget|Invoke-WebRequest|iwr|irm)\b.*\|\s*(bash|sh|iex|Invoke-Expression)/i,
];

// Key mappings for special keys
const SPECIAL_KEYS = {
  'enter': '{ENTER}',
  'return': '{ENTER}',
  'tab': '{TAB}',
  'escape': '{ESC}',
  'esc': '{ESC}',
  'backspace': '{BACKSPACE}',
  'delete': '{DELETE}',
  'del': '{DELETE}',
  'home': '{HOME}',
  'end': '{END}',
  'pageup': '{PGUP}',
  'pagedown': '{PGDN}',
  'up': '{UP}',
  'down': '{DOWN}',
  'left': '{LEFT}',
  'right': '{RIGHT}',
  'f1': '{F1}',
  'f2': '{F2}',
  'f3': '{F3}',
  'f4': '{F4}',
  'f5': '{F5}',
  'f6': '{F6}',
  'f7': '{F7}',
  'f8': '{F8}',
  'f9': '{F9}',
  'f10': '{F10}',
  'f11': '{F11}',
  'f12': '{F12}',
  'space': ' ',
  'ctrl': '^',
  'control': '^',
  'alt': '%',
  'shift': '+',
  'win': '^{ESC}', // Windows key approximation
};

const WINDOWS_KEY_VK_CODES = {
  'a': 0x41, 'b': 0x42, 'c': 0x43, 'd': 0x44, 'e': 0x45, 'f': 0x46, 'g': 0x47, 'h': 0x48,
  'i': 0x49, 'j': 0x4A, 'k': 0x4B, 'l': 0x4C, 'm': 0x4D, 'n': 0x4E, 'o': 0x4F, 'p': 0x50,
  'q': 0x51, 'r': 0x52, 's': 0x53, 't': 0x54, 'u': 0x55, 'v': 0x56, 'w': 0x57, 'x': 0x58,
  'y': 0x59, 'z': 0x5A,
  '0': 0x30, '1': 0x31, '2': 0x32, '3': 0x33, '4': 0x34, '5': 0x35, '6': 0x36, '7': 0x37, '8': 0x38, '9': 0x39,
  'enter': 0x0D, 'return': 0x0D, 'tab': 0x09, 'escape': 0x1B, 'esc': 0x1B,
  'space': 0x20, 'backspace': 0x08, 'delete': 0x2E, 'del': 0x2E,
  'up': 0x26, 'down': 0x28, 'left': 0x25, 'right': 0x27,
  'home': 0x24, 'end': 0x23, 'pageup': 0x21, 'pagedown': 0x22,
  'f1': 0x70, 'f2': 0x71, 'f3': 0x72, 'f4': 0x73, 'f5': 0x74, 'f6': 0x75,
  'f7': 0x76, 'f8': 0x77, 'f9': 0x78, 'f10': 0x79, 'f11': 0x7A, 'f12': 0x7B,
};

function normalizeKeyComboParts(keyCombo) {
  return String(keyCombo || '')
    .toLowerCase()
    .split('+')
    .map(k => k.trim())
    .filter(Boolean);
}

function isTradingViewLikeWindowContext(options = {}) {
  const targetWindow = options?.targetWindow && typeof options.targetWindow === 'object'
    ? options.targetWindow
    : null;
  const verifyTarget = options?.verifyTarget && typeof options.verifyTarget === 'object'
    ? options.verifyTarget
    : null;

  const haystack = [
    targetWindow?.processName,
    targetWindow?.title,
    verifyTarget?.appName,
    verifyTarget?.requestedAppName,
    verifyTarget?.normalizedAppName,
    ...(Array.isArray(verifyTarget?.processNames) ? verifyTarget.processNames : []),
    ...(Array.isArray(verifyTarget?.titleHints) ? verifyTarget.titleHints : [])
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');

  return /tradingview|trading\s+view/.test(haystack);
}

function shouldUseSendInputForKeyCombo(keyCombo, options = {}) {
  if (process.platform !== 'win32') return false;

  const parts = normalizeKeyComboParts(keyCombo);
  if (!parts.length) return false;

  const hasWinKey = parts.includes('win') || parts.includes('windows') || parts.includes('super');
  if (hasWinKey) return true;

  const hasAlt = parts.includes('alt');
  const isEnterOnly = parts.length === 1 && ['enter', 'return'].includes(parts[0]);

  if (!hasAlt && !isEnterOnly) return false;
  return isTradingViewLikeWindowContext(options);
}

async function pressKeyWithSendInput(keyCombo, options = {}) {
  const parts = normalizeKeyComboParts(keyCombo);
  const includeWinKey = !!options.includeWinKey;
  const otherKeys = parts.filter((p) => !['win', 'windows', 'super'].includes(p));
  const hasCtrl = otherKeys.includes('ctrl') || otherKeys.includes('control');
  const hasAlt = otherKeys.includes('alt');
  const hasShift = otherKeys.includes('shift');
  const mainKey = otherKeys.find(p => !['ctrl', 'control', 'alt', 'shift'].includes(p)) || '';
  const mainKeyCode = mainKey ? (WINDOWS_KEY_VK_CODES[mainKey] || mainKey.toUpperCase().charCodeAt(0)) : 0;

  if (!includeWinKey && !hasCtrl && !hasAlt && !hasShift && !mainKeyCode) {
    throw new Error(`Invalid key combo: ${keyCombo}`);
  }

  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class WinKeyPress {
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx, dy;
        public uint mouseData, dwFlags, time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    public const uint INPUT_KEYBOARD = 1;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const ushort VK_LWIN = 0x5B;
    public const ushort VK_CONTROL = 0x11;
    public const ushort VK_SHIFT = 0x10;
    public const ushort VK_MENU = 0x12;

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    public static void KeyDown(ushort vk) {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].U.ki.wVk = vk;
        inputs[0].U.ki.dwFlags = 0;
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void KeyUp(ushort vk) {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].U.ki.wVk = vk;
        inputs[0].U.ki.dwFlags = KEYEVENTF_KEYUP;
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }
}
"@

# Press modifiers
${includeWinKey ? '[WinKeyPress]::KeyDown([WinKeyPress]::VK_LWIN)' : ''}
${hasCtrl ? '[WinKeyPress]::KeyDown([WinKeyPress]::VK_CONTROL)' : ''}
${hasAlt ? '[WinKeyPress]::KeyDown([WinKeyPress]::VK_MENU)' : ''}
${hasShift ? '[WinKeyPress]::KeyDown([WinKeyPress]::VK_SHIFT)' : ''}

# Press main key if any
${mainKeyCode ? `[WinKeyPress]::KeyDown(${mainKeyCode})
Start-Sleep -Milliseconds 50
[WinKeyPress]::KeyUp(${mainKeyCode})` : 'Start-Sleep -Milliseconds 100'}

# Release modifiers in reverse order
${hasShift ? '[WinKeyPress]::KeyUp([WinKeyPress]::VK_SHIFT)' : ''}
${hasAlt ? '[WinKeyPress]::KeyUp([WinKeyPress]::VK_MENU)' : ''}
${hasCtrl ? '[WinKeyPress]::KeyUp([WinKeyPress]::VK_CONTROL)' : ''}
${includeWinKey ? '[WinKeyPress]::KeyUp([WinKeyPress]::VK_LWIN)' : ''}
`;

  await executePowerShell(script);
}

/**
 * Execute a PowerShell command and return result
 */
function executePowerShell(command) {
  return new Promise((resolve, reject) => {
    // IMPORTANT: Do NOT attempt to escape quotes in-line.
    // Many commands embed C# code via Add-Type using PowerShell here-strings.
    // Naively escaping `"` corrupts the C# source, causing non-terminating
    // compilation errors (stderr) and empty stdout that our callers may parse
    // as 0/falsey values.
    //
    // -EncodedCommand avoids quoting issues, but large scripts (notably Add-Type
    // blocks for Win32 interop) can exceed the Windows command-line limit.
    // Writing to a temporary .ps1 file avoids both issues.
    const prologue = `$ProgressPreference = 'SilentlyContinue'\n$ErrorActionPreference = 'Stop'\n`;
    const fullCommand = `${prologue}${String(command)}`;

    const tmpDir = os.tmpdir();
    const tmpName = `liku-ps-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`;
    const tmpPath = path.join(tmpDir, tmpName);

    try {
      fs.writeFileSync(tmpPath, fullCommand, 'utf8');
    } catch (e) {
      reject(e);
      return;
    }

    const quotedPath = `\"${tmpPath.replace(/"/g, '""')}\"`;
    exec(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${quotedPath}`, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    }, (error, stdout, stderr) => {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // best-effort cleanup
      }

      if (error) {
        const stderrText = String(stderr || '').trim();
        if (stderrText) console.error('[AUTOMATION] PowerShell error:', stderrText);
        reject(new Error(stderrText || error.message || 'PowerShell execution failed'));
        return;
      }

      resolve(String(stdout || '').trim());
    });
  });
}

function normalizeCompactText(value, maxLength = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength) || null;
}

function parseRelativeTimeToMinutes(value) {
  const text = normalizeCompactText(value, 80);
  if (!text) return null;
  const match = text.match(/(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks)\s+ago/i);
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(amount)) return null;

  if (unit.startsWith('s')) return Math.max(1, amount / 60);
  if (unit.startsWith('m')) return amount;
  if (unit.startsWith('h')) return amount * 60;
  if (unit.startsWith('d')) return amount * 60 * 24;
  if (unit.startsWith('w')) return amount * 60 * 24 * 7;
  return null;
}

function inferVisibleRevisionRecencySignal(minutes) {
  if (!Number.isFinite(minutes)) return 'unknown-visible-recency';
  if (minutes <= 60) return 'recent-churn-visible';
  if (minutes <= 1440) return 'same-day-visible';
  if (minutes >= 10080) return 'stable-visible';
  return 'moderate-visible';
}

function buildPineVersionHistoryStructuredSummary(text, summaryFields = []) {
  const rawText = normalizeCompactText(text, 2000);
  if (!rawText) return null;

  const revisionSegments = rawText
    .split(/[;\n]+/)
    .map((segment) => normalizeCompactText(segment, 280))
    .filter(Boolean);

  const visibleRevisions = revisionSegments
    .map((segment) => {
      const match = segment.match(/^(Revision\s+#?\s*\d+)\b(?:.*?\b(?:saved|updated|created)\s+(.+?ago))?$/i);
      if (!match) return null;

      const label = normalizeCompactText(match[1], 80);
      const relativeTime = normalizeCompactText(match[2], 80);
      const revisionNumberMatch = label ? label.match(/(\d+)/) : null;
      const revisionNumber = revisionNumberMatch ? Number(revisionNumberMatch[1]) : null;

      return {
        label,
        revisionNumber: Number.isFinite(revisionNumber) ? revisionNumber : null,
        relativeTime,
        recencyMinutes: parseRelativeTimeToMinutes(relativeTime)
      };
    })
    .filter(Boolean)
    .slice(0, 5);

  const visibleCountMatch = rawText.match(/showing\s+(\d+)\s+visible\s+revisions?/i);
  const visibleRevisionCount = visibleCountMatch
    ? Number(visibleCountMatch[1])
    : visibleRevisions.length;

  const latestVisibleRevision = visibleRevisions[0] || null;
  const compactSummary = [
    latestVisibleRevision?.label ? `latest=${latestVisibleRevision.label}` : null,
    latestVisibleRevision?.relativeTime ? `saved=${latestVisibleRevision.relativeTime}` : null,
    Number.isFinite(visibleRevisionCount) ? `visible=${visibleRevisionCount}` : null,
    latestVisibleRevision ? `signal=${inferVisibleRevisionRecencySignal(latestVisibleRevision.recencyMinutes)}` : null
  ].filter(Boolean).join(' | ');

  const fullSummary = {
    latestVisibleRevisionLabel: latestVisibleRevision?.label || null,
    latestVisibleRevisionNumber: Number.isFinite(latestVisibleRevision?.revisionNumber) ? latestVisibleRevision.revisionNumber : null,
    latestVisibleRelativeTime: latestVisibleRevision?.relativeTime || null,
    visibleRevisionCount: Number.isFinite(visibleRevisionCount) ? visibleRevisionCount : null,
    visibleRecencySignal: latestVisibleRevision ? inferVisibleRevisionRecencySignal(latestVisibleRevision.recencyMinutes) : 'unknown-visible-recency',
    topVisibleRevisions: visibleRevisions.map((entry) => ({
      label: entry.label,
      relativeTime: entry.relativeTime,
      revisionNumber: entry.revisionNumber
    })),
    compactSummary: compactSummary || null
  };

  if (!Array.isArray(summaryFields) || summaryFields.length === 0) {
    return fullSummary;
  }

  const structured = { compactSummary: fullSummary.compactSummary };
  if (summaryFields.includes('latest-revision-label')) structured.latestVisibleRevisionLabel = fullSummary.latestVisibleRevisionLabel;
  if (summaryFields.includes('latest-relative-time')) structured.latestVisibleRelativeTime = fullSummary.latestVisibleRelativeTime;
  if (summaryFields.includes('visible-revision-count')) structured.visibleRevisionCount = fullSummary.visibleRevisionCount;
  if (summaryFields.includes('visible-recency-signal')) structured.visibleRecencySignal = fullSummary.visibleRecencySignal;
  if (summaryFields.includes('top-visible-revisions')) structured.topVisibleRevisions = fullSummary.topVisibleRevisions;
  return structured;
}

function buildPineEditorSafeAuthoringSummary(text) {
  const rawText = String(text || '').replace(/\r/g, '');
  const compactText = normalizeCompactText(rawText, 2400);
  if (!compactText) return null;

  const visibleLines = rawText
    .split('\n')
    .map((line) => String(line || '').trim())
    .filter(Boolean);

  const addSignal = (signals, signal) => {
    if (signal && !signals.includes(signal)) signals.push(signal);
  };

  const visibleSignals = [];
  const declarationMatch = rawText.match(/\b(indicator|strategy|library)\s*\(/i);
  const visibleScriptKind = declarationMatch ? declarationMatch[1].toLowerCase() : 'unknown';
  const declarationNameMatch = rawText.match(/\b(?:indicator|strategy|library)\s*\(\s*["'`](.*?)["'`]/i);
  const declarationName = normalizeCompactText(declarationNameMatch?.[1], 80);
  const meaningfulLines = visibleLines.filter((line) => {
    if (/^\/\/\s*@version\s*=\s*\d+/i.test(line)) return false;
    if (/^(indicator|strategy|library)\s*\(/i.test(line)) return false;
    if (/^\/\//.test(line)) return false;
    return true;
  });

  if (/\/\/\s*@version\s*=\s*\d+/i.test(rawText)) addSignal(visibleSignals, 'pine-version-directive');
  if (visibleScriptKind !== 'unknown') addSignal(visibleSignals, `${visibleScriptKind}-declaration`);
  if (declarationName && /^(my script|my strategy|my library|untitled(?: script)?)$/i.test(declarationName)) {
    addSignal(visibleSignals, 'starter-default-name');
  }
  if (/\bplot\s*\(\s*close\s*\)/i.test(rawText)) addSignal(visibleSignals, 'starter-plot-close');
  if (/\b(input|plot|plotshape|plotchar|hline|bgcolor|fill|alertcondition|strategy\.)\s*\(/i.test(rawText)) {
    addSignal(visibleSignals, 'script-body-visible');
  }
  if (/\b(start writing|write your script|new script|empty editor|untitled script)\b/i.test(compactText)) {
    addSignal(visibleSignals, 'editor-empty-hint');
  }

  const starterLike = (
    visibleScriptKind !== 'unknown'
    && (
      meaningfulLines.length === 0
      || (
        visibleScriptKind === 'indicator'
        && meaningfulLines.length === 1
        && /^plot\s*\(\s*close\s*\)\s*$/i.test(meaningfulLines[0])
      )
    )
    && visibleSignals.includes('starter-default-name')
  );

  let editorVisibleState = 'unknown-visible-state';
  if (visibleSignals.includes('editor-empty-hint') || starterLike) {
    editorVisibleState = 'empty-or-starter';
  } else if (
    visibleScriptKind !== 'unknown'
    && (
      meaningfulLines.length > 0
      || visibleLines.length >= 5
      || visibleSignals.includes('script-body-visible')
    )
  ) {
    editorVisibleState = 'existing-script-visible';
  }

  const visibleLineCountEstimate = visibleLines.length > 0 ? visibleLines.length : null;
  const compactSummary = [
    `state=${editorVisibleState}`,
    visibleScriptKind !== 'unknown' ? `kind=${visibleScriptKind}` : null,
    Number.isFinite(visibleLineCountEstimate) ? `lines=${visibleLineCountEstimate}` : null
  ].filter(Boolean).join(' | ');

  return {
    evidenceMode: 'safe-authoring-inspect',
    editorVisibleState,
    visibleScriptKind,
    visibleLineCountEstimate,
    visibleSignals: visibleSignals.slice(0, 6),
    compactSummary: compactSummary || null
  };
}

function inferPineLineBudgetSignal(lineCountEstimate) {
  if (!Number.isFinite(lineCountEstimate)) return 'unknown-line-budget';
  if (lineCountEstimate > 500) return 'over-budget-visible';
  if (lineCountEstimate >= 500) return 'at-limit-visible';
  if (lineCountEstimate >= 450) return 'near-limit-visible';
  return 'within-budget-visible';
}

function buildPineEditorDiagnosticsStructuredSummary(text, evidenceMode = 'generic-status') {
  const rawText = String(text || '').replace(/\r/g, '');
  const compactText = normalizeCompactText(rawText, 2400);
  if (!compactText) return null;

  const visibleSegments = rawText
    .split(/[\n;]+/)
    .map((segment) => normalizeCompactText(segment, 180))
    .filter(Boolean);

  const addSignal = (signals, signal) => {
    if (signal && !signals.includes(signal)) signals.push(signal);
  };

  const statusSignals = [];
  const noErrorsVisible = /\b(no errors|compiled successfully|compile success|successfully compiled|0 errors)\b/i.test(compactText);
  const errorSegments = visibleSegments.filter((segment) => /\berror\b/i.test(segment) && !/\bno errors\b/i.test(segment));
  const warningSegments = visibleSegments.filter((segment) => /\bwarning\b/i.test(segment));
  const statusSegments = visibleSegments.filter((segment) => /\b(status|compiler|compiled|strategy loaded|indicator loaded|loaded)\b/i.test(segment));
  const lineBudgetContextVisible = /\b(500\s*lines?|line count|line budget|script length|lines used|line limit|maximum lines|max lines|capped)\b/i.test(compactText);

  let visibleLineCountEstimate = null;
  const lineCountMatch = rawText.match(/(?:line count|script length|lines used|used)\s*[:=]?\s*(\d{1,4})(?:\s*\/\s*500|\s+of\s+500)?\s*lines?/i)
    || rawText.match(/\b(\d{1,4})\s*\/\s*500\s*lines?\b/i)
    || rawText.match(/\b(\d{1,4})\s+of\s+500\s*lines?\b/i);
  if (lineCountMatch) {
    const parsed = Number(lineCountMatch[1]);
    visibleLineCountEstimate = Number.isFinite(parsed) ? parsed : null;
  }

  const errorCountEstimate = errorSegments.length;
  const warningCountEstimate = warningSegments.length;
  let compileStatus = 'unknown';
  if (errorCountEstimate > 0) {
    compileStatus = 'errors-visible';
    addSignal(statusSignals, 'compile-errors-visible');
  } else if (noErrorsVisible) {
    compileStatus = 'success';
    addSignal(statusSignals, 'compile-success-visible');
  } else if (statusSegments.length > 0 || evidenceMode === 'generic-status' || evidenceMode === 'line-budget') {
    compileStatus = 'status-only';
  }

  if (warningCountEstimate > 0) addSignal(statusSignals, 'warnings-visible');
  if (statusSegments.length > 0) addSignal(statusSignals, 'status-text-visible');
  if (lineBudgetContextVisible || Number.isFinite(visibleLineCountEstimate)) {
    addSignal(statusSignals, 'line-budget-hint-visible');
  }
  if (evidenceMode === 'diagnostics') addSignal(statusSignals, 'diagnostics-request');
  if (evidenceMode === 'compile-result') addSignal(statusSignals, 'compile-result-request');
  if (evidenceMode === 'line-budget') addSignal(statusSignals, 'line-budget-request');
  if (evidenceMode === 'generic-status') addSignal(statusSignals, 'generic-status-request');

  const lineBudgetSignal = Number.isFinite(visibleLineCountEstimate)
    ? inferPineLineBudgetSignal(visibleLineCountEstimate)
    : 'unknown-line-budget';
  if (lineBudgetSignal !== 'unknown-line-budget') addSignal(statusSignals, lineBudgetSignal);

  const topVisibleDiagnostics = visibleSegments
    .filter((segment) => /\b(error|warning|status|compiler|compiled|line count|line budget|lines used|strategy loaded|indicator loaded|loaded)\b/i.test(segment))
    .slice(0, 4);

  const compactSummary = [
    `status=${compileStatus}`,
    Number.isFinite(errorCountEstimate) ? `errors=${errorCountEstimate}` : null,
    Number.isFinite(warningCountEstimate) ? `warnings=${warningCountEstimate}` : null,
    Number.isFinite(visibleLineCountEstimate) ? `lines=${visibleLineCountEstimate}` : null,
    lineBudgetSignal !== 'unknown-line-budget' ? `budget=${lineBudgetSignal}` : null
  ].filter(Boolean).join(' | ');

  return {
    evidenceMode,
    compileStatus,
    errorCountEstimate,
    warningCountEstimate,
    visibleLineCountEstimate,
    lineBudgetSignal,
    statusSignals: statusSignals.slice(0, 8),
    topVisibleDiagnostics,
    compactSummary: compactSummary || null
  };
}

/**
 * Focus the desktop / unfocus Electron windows before sending keyboard input
 * This is critical for SendKeys/SendInput to reach the correct target
 */
async function focusDesktop() {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FocusHelper {
    [DllImport("user32.dll")]
    public static extern IntPtr GetDesktopWindow();
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern IntPtr GetShellWindow();
}
"@
# Focus shell window (explorer desktop) 
$shell = [FocusHelper]::GetShellWindow()
[FocusHelper]::SetForegroundWindow($shell)
Start-Sleep -Milliseconds 50
`;
  await executePowerShell(script);
  console.log('[AUTOMATION] Focused desktop before input');
}

/**
 * Move mouse to coordinates (Windows)
 */
async function moveMouse(x, y) {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)}, ${Math.round(y)})
`;
  await executePowerShell(script);
  console.log(`[AUTOMATION] Mouse moved to (${x}, ${y})`);
}

/**
 * Click at coordinates (Windows) - FIXED for transparent overlay click-through
 * 
 * Uses SendInput (modern replacement for deprecated mouse_event) and
 * activates the target window before clicking to ensure synthetic clicks
 * reach background applications behind the Electron overlay.
 * 
 * Key fixes:
 * 1. Use SendInput instead of mouse_event (better UIPI handling)
 * 2. Find real window under cursor (skip transparent windows)
 * 3. SetForegroundWindow to activate target before clicking
 */
async function click(x, y, button = 'left') {
  // Move mouse first
  await moveMouse(x, y);
  
  // Small delay for position to register
  await sleep(50);
  
  // Click using SendInput + SetForegroundWindow for reliable click-through
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class ClickThrough {
    // SendInput structures and constants
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public MOUSEINPUT mi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    public const uint INPUT_MOUSE = 0;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    public const uint MOUSEEVENTF_MOVE = 0x0001;

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    public static extern IntPtr WindowFromPoint(int x, int y);

    [DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr lpdwProcessId);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
    
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, IntPtr pvParam, uint fWinIni);

    [DllImport("user32.dll")]
    public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);

    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TRANSPARENT = 0x20;
    public const int WS_EX_LAYERED = 0x80000;
    public const int WS_EX_TOOLWINDOW = 0x80;
    public const uint GA_ROOT = 2;
    public const int SW_RESTORE = 9;
    public const uint SPI_GETFOREGROUNDLOCKTIMEOUT = 0x2000;
    public const uint SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001;
    public const uint SPIF_SENDCHANGE = 0x02;

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    public static void ForceForeground(IntPtr hwnd) {
        if (hwnd == IntPtr.Zero) return;
        
        // Restore if minimized
        if (IsIconic(hwnd)) {
            ShowWindow(hwnd, SW_RESTORE);
            System.Threading.Thread.Sleep(50);
        }
        
        IntPtr foreground = GetForegroundWindow();
        if (foreground == hwnd) return;
        
        // 1. Unlock Focus Stealing
        int originalTimeout = 0;
        IntPtr timeoutPtr = Marshal.AllocHGlobal(4);
        try {
            SystemParametersInfo(SPI_GETFOREGROUNDLOCKTIMEOUT, 0, timeoutPtr, 0);
            originalTimeout = Marshal.ReadInt32(timeoutPtr);
            SystemParametersInfo(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, IntPtr.Zero, SPIF_SENDCHANGE);
        } catch {}

        try {
            uint foregroundThread = GetWindowThreadProcessId(foreground, IntPtr.Zero);
            uint currentThread = GetCurrentThreadId();
            bool success = false;

            // 2. AttachThreadInput + SetForegroundWindow
            if (foregroundThread != currentThread) {
                AttachThreadInput(currentThread, foregroundThread, true);
                success = SetForegroundWindow(hwnd);
                AttachThreadInput(currentThread, foregroundThread, false);
            } else {
                success = SetForegroundWindow(hwnd);
            }
            
            // 3. Last Resort: SwitchToThisWindow
            if (!success) {
                SwitchToThisWindow(hwnd, true);
            }
        } finally {
            try {
                Marshal.WriteInt32(timeoutPtr, originalTimeout);
                SystemParametersInfo(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, timeoutPtr, SPIF_SENDCHANGE);
            } catch {}
            Marshal.FreeHGlobal(timeoutPtr);
        }
    }

    public static IntPtr GetRealWindowFromPoint(int x, int y) {
        IntPtr hwnd = WindowFromPoint(x, y);
        if (hwnd == IntPtr.Zero) return IntPtr.Zero;

        // Walk up to find a non-overlay parent window
        // Skip our Electron overlay (has WS_EX_LAYERED, class "Chrome_WidgetWin_1", and no title)
        int maxIterations = 10;
        while (maxIterations-- > 0) {
            int exStyle = GetWindowLong(hwnd, GWL_EXSTYLE);
            bool isTransparent = (exStyle & WS_EX_TRANSPARENT) != 0;
            bool isLayered = (exStyle & WS_EX_LAYERED) != 0;
            
            // Check class name
            StringBuilder className = new StringBuilder(256);
            GetClassName(hwnd, className, 256);
            string cls = className.ToString();
            
            // Check window title (our overlay has no title, VS Code has a title)
            StringBuilder windowTitle = new StringBuilder(256);
            GetWindowText(hwnd, windowTitle, 256);
            string title = windowTitle.ToString();
            
            // Our overlay: Chrome_WidgetWin_1, WS_EX_LAYERED, empty title
            // VS Code: Chrome_WidgetWin_1, but has a title like "index.js - project - Visual Studio Code"
            bool isOurOverlay = cls.Contains("Chrome_WidgetWin") && isLayered && string.IsNullOrEmpty(title);
            
            // Skip if WS_EX_TRANSPARENT OR if it's our transparent overlay
            if (!isTransparent && !isOurOverlay) {
                return GetAncestor(hwnd, GA_ROOT);
            }
            
            IntPtr parent = GetAncestor(hwnd, 1); // GA_PARENT
            if (parent == IntPtr.Zero || parent == hwnd) break;
            hwnd = parent;
        }
        
        return GetAncestor(hwnd, GA_ROOT);
    }

    public static void ClickAt(int x, int y, bool rightButton) {
        // Find the real window under the cursor (skip transparent overlay)
        IntPtr targetWindow = GetRealWindowFromPoint(x, y);
        
        if (targetWindow != IntPtr.Zero) {
            // Activate the target window so it receives the click
            ForceForeground(targetWindow);
            System.Threading.Thread.Sleep(30);
        }

        // Prepare SendInput for mouse click
        INPUT[] inputs = new INPUT[2];
        
        uint downFlag = rightButton ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN;
        uint upFlag = rightButton ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP;

        // Mouse down
        inputs[0].type = INPUT_MOUSE;
        inputs[0].mi.dwFlags = downFlag;
        inputs[0].mi.dx = 0;
        inputs[0].mi.dy = 0;
        inputs[0].mi.mouseData = 0;
        inputs[0].mi.time = 0;
        inputs[0].mi.dwExtraInfo = IntPtr.Zero;

        // Mouse up
        inputs[1].type = INPUT_MOUSE;
        inputs[1].mi.dwFlags = upFlag;
        inputs[1].mi.dx = 0;
        inputs[1].mi.dy = 0;
        inputs[1].mi.mouseData = 0;
        inputs[1].mi.time = 0;
        inputs[1].mi.dwExtraInfo = IntPtr.Zero;

        // Send the click
        SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
    }
}
"@
[ClickThrough]::ClickAt(${Math.round(x)}, ${Math.round(y)}, ${button === 'right' ? '$true' : '$false'})
`;
  await executePowerShell(script);
  console.log(`[AUTOMATION] ${button} click at (${x}, ${y}) (click-through enabled)`);
}

/**
 * Focus a specific window by its handle
 */
async function focusWindow(hwnd) {
    if (!hwnd) {
      return {
        success: false,
        requestedWindowHandle: 0,
        actualForegroundHandle: 0,
        actualForeground: null,
        exactMatch: false,
        outcome: 'missing-target'
      };
    }
    
    const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class WindowFocus {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr lpdwProcessId);
    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, IntPtr pvParam, uint fWinIni);
    [DllImport("user32.dll")]
    public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
    
    public const int SW_RESTORE = 9;
    public const uint SPI_GETFOREGROUNDLOCKTIMEOUT = 0x2000;
    public const uint SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001;
    public const uint SPIF_SENDCHANGE = 0x02;

    public static void Focus(IntPtr hwnd) {
        if (hwnd == IntPtr.Zero) return;
        
        // Restore if minimized
        if (IsIconic(hwnd)) {
            ShowWindow(hwnd, SW_RESTORE);
            System.Threading.Thread.Sleep(100);
        }

        IntPtr foreground = GetForegroundWindow();
        if (foreground == hwnd) return;
        
        // 1. Try to unlock Focus Stealing capability
        int originalTimeout = 0;
        IntPtr timeoutPtr = Marshal.AllocHGlobal(4);
        try {
            SystemParametersInfo(SPI_GETFOREGROUNDLOCKTIMEOUT, 0, timeoutPtr, 0);
            originalTimeout = Marshal.ReadInt32(timeoutPtr);
            
            // Set timeout to 0 to bypass lock
            SystemParametersInfo(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, IntPtr.Zero, SPIF_SENDCHANGE);
        } catch {}

        try {
            uint foregroundThread = GetWindowThreadProcessId(foreground, IntPtr.Zero);
            uint currentThread = GetCurrentThreadId();
            bool success = false;

            // 2. Try AttachThreadInput + SetForegroundWindow
            if (foregroundThread != currentThread) {
                AttachThreadInput(currentThread, foregroundThread, true);
                success = SetForegroundWindow(hwnd);
                AttachThreadInput(currentThread, foregroundThread, false);
            } else {
                success = SetForegroundWindow(hwnd);
            }
            
            // 3. Last Resort: SwitchToThisWindow
            if (!success) {
                SwitchToThisWindow(hwnd, true);
            }
        } finally {
            // Restore original timeout
            try {
                Marshal.WriteInt32(timeoutPtr, originalTimeout);
                SystemParametersInfo(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, timeoutPtr, SPIF_SENDCHANGE);
            } catch {}
            Marshal.FreeHGlobal(timeoutPtr);
        }
    }
}
"@
[WindowFocus]::Focus([IntPtr]::new(${hwnd}))
`;
    await executePowerShell(script);

    // Poll to verify focus actually stuck (SetForegroundWindow can be racy / blocked)
    let verified = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const fg = await getForegroundWindowHandle();
      if (fg === hwnd) {
        verified = true;
        break;
      }
      await sleep(50);
    }

    let actualForeground = null;
    try {
      actualForeground = await getForegroundWindowInfo();
    } catch {
      actualForeground = null;
    }

    const actualForegroundHandle = Number(actualForeground?.hwnd || 0) || 0;

    if (verified) {
      console.log(`[AUTOMATION] Focused window handle (verified): ${hwnd}`);
    } else {
      const fg = await getForegroundWindowHandle();
      console.warn(`[AUTOMATION] Focus requested for ${hwnd} but foreground is ${fg}`);
    }

    return {
      success: true,
      requestedWindowHandle: hwnd,
      actualForegroundHandle,
      actualForeground: actualForeground?.success ? actualForeground : null,
      exactMatch: verified,
      outcome: verified ? 'exact' : 'mismatch'
    };
}

/**
 * Resolve window handle from action payload (handle, title, process, class)
 */
async function resolveWindowHandle(action = {}) {
  const directHandle = action.hwnd ?? action.windowHandle;
  if (directHandle !== undefined && directHandle !== null && Number.isFinite(Number(directHandle))) {
    return Number(directHandle);
  }

  const escapePsString = (s) => String(s || '').replace(/'/g, "''");
  const rawTitle = String(action.title || '').trim();
  const titleMode = rawTitle.toLowerCase().startsWith('re:') ? 'regex' : 'contains';
  const titleValue = titleMode === 'regex' ? rawTitle.slice(3).trim() : rawTitle;
  const title = escapePsString(titleValue);
  const processName = escapePsString(String(action.processName || '').trim());
  const className = escapePsString(String(action.className || '').trim());

  if (!title && !processName && !className) {
    return null;
  }

  const buildResolverScript = ({ includeTitle = true } = {}) => `
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class WindowResolver {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder name, int count);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    public static List<IntPtr> windows = new List<IntPtr>();
    public static void Find() {
        windows.Clear();
        EnumWindows((h, l) => { if (IsWindowVisible(h)) windows.Add(h); return true; }, IntPtr.Zero);
    }
}
'@

$titleMode = '${titleMode}'
$title = '${includeTitle ? title : ''}'
$proc = '${processName}'.ToLower()
$class = '${className}'.ToLower()

[WindowResolver]::Find()
foreach ($hwnd in [WindowResolver]::windows) {
    $titleSB = New-Object System.Text.StringBuilder 256
    $classSB = New-Object System.Text.StringBuilder 256
    [void][WindowResolver]::GetWindowText($hwnd, $titleSB, 256)
    [void][WindowResolver]::GetClassName($hwnd, $classSB, 256)

    $t = $titleSB.ToString()
    if ([string]::IsNullOrWhiteSpace($t)) { continue }
    $c = $classSB.ToString()

    if ($title) {
        if ($titleMode -eq 'regex') {
            if ($t -notmatch $title) { continue }
        } else {
            if (-not $t.ToLower().Contains($title.ToLower())) { continue }
        }
    }
    if ($class -and -not $c.ToLower().Contains($class)) { continue }

    if ($proc) {
      $procId = 0
      [void][WindowResolver]::GetWindowThreadProcessId($hwnd, [ref]$procId)
      $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if (-not $p) { continue }
        $pn = ($p.ProcessName | ForEach-Object { $_.ToString().ToLower() })
        $procNorm = ($proc -replace '\\s+$','' -replace '\\.exe$','')
        if ($pn -ne $procNorm -and -not $pn.Contains($procNorm)) { continue }
    }

    $hwnd.ToInt64()
    exit
}
`;

  try {
    const tryParseHandle = async (scriptText) => {
      const result = await executePowerShellScript(scriptText, 8000);
      if (!result || result.failed) {
        console.warn(`[AUTOMATION] resolveWindowHandle script failed:`, result?.error || result?.stderr || 'unknown');
        return null;
      }
      const parsed = Number(String(result.stdout || '').trim());
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    };

    // First pass: honor title/class/process filters.
    let hwnd = await tryParseHandle(buildResolverScript({ includeTitle: true }));
    if (hwnd) return hwnd;

    // Fallback pass: if process is known, tolerate title drift/channels and match process-only.
    if (processName) {
      hwnd = await tryParseHandle(buildResolverScript({ includeTitle: false }));
      if (hwnd) return hwnd;
    }

    // Get-Process fallback: avoids Add-Type C# compilation which can fail on some machines
    if (processName || title) {
      const getProcessScript = title
        ? `$ErrorActionPreference='Continue'; $ProgressPreference='SilentlyContinue'
$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle }
$titleSearch = '${title}'.ToLower()
$procSearch = '${processName}'.ToLower() -replace '\\.exe$',''
foreach ($p in $procs) {
  $t = $p.MainWindowTitle.ToLower()
  $n = $p.ProcessName.ToLower()
  if ($titleSearch -and -not $t.Contains($titleSearch)) { continue }
  if ($procSearch -and $n -ne $procSearch) { continue }
  $p.MainWindowHandle.ToInt64(); exit
}
if ($procSearch) {
  foreach ($p in $procs) {
    $n = $p.ProcessName.ToLower()
    if ($n -eq $procSearch) { $p.MainWindowHandle.ToInt64(); exit }
  }
}`
        : `$ErrorActionPreference='Continue'; $ProgressPreference='SilentlyContinue'
$procSearch = '${processName}'.ToLower() -replace '\\.exe$',''
Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName.ToLower() -eq $procSearch } | Select-Object -First 1 | ForEach-Object { $_.MainWindowHandle.ToInt64() }`;
      hwnd = await tryParseHandle(getProcessScript);
      if (hwnd) {
        console.log(`[AUTOMATION] resolveWindowHandle found window via Get-Process fallback: ${hwnd}`);
        return hwnd;
      }
    }

    // Fallback: try the ui-automation window manager if available
    try {
      const windowManager = require('./ui-automation/window/manager');
      if (typeof windowManager.findWindows === 'function') {
        const criteria = {};
        if (title) criteria.title = titleValue;
        if (processName) criteria.processName = String(action.processName || '').trim();
        const windows = await windowManager.findWindows(criteria);
        if (Array.isArray(windows) && windows.length > 0 && windows[0].hwnd) {
          console.log(`[AUTOMATION] resolveWindowHandle fallback found window via ui-automation: ${windows[0].hwnd}`);
          return windows[0].hwnd;
        }
      }
    } catch (fallbackErr) {
      console.warn(`[AUTOMATION] resolveWindowHandle ui-automation fallback failed:`, fallbackErr.message);
    }

    console.warn(`[AUTOMATION] resolveWindowHandle: no window found for title="${title}" process="${processName}" class="${className}"`);
    return null;
  } catch (err) {
    console.warn(`[AUTOMATION] resolveWindowHandle error:`, err.message);
    return null;
  }
}

async function minimizeWindow(hwnd) {
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinMin {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@
[WinMin]::ShowWindow([IntPtr]::new(${hwnd}), 6) | Out-Null
`;
  await executePowerShell(script);
}

async function restoreWindow(hwnd) {
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinRestore {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@
[WinRestore]::ShowWindow([IntPtr]::new(${hwnd}), 9) | Out-Null
`;
  await executePowerShell(script);
}

async function sendWindowToBack(hwnd) {
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinZ {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  public static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOMOVE = 0x0002;
  public const uint SWP_NOACTIVATE = 0x0010;
  public const uint SWP_NOOWNERZORDER = 0x0200;
}
'@
[WinZ]::SetWindowPos([IntPtr]::new(${hwnd}), [WinZ]::HWND_BOTTOM, 0, 0, 0, 0, [WinZ]::SWP_NOSIZE -bor [WinZ]::SWP_NOMOVE -bor [WinZ]::SWP_NOACTIVATE -bor [WinZ]::SWP_NOOWNERZORDER) | Out-Null
`;
  await executePowerShell(script);
}

/**
 * Double click at coordinates - FIXED for transparent overlay click-through
 */
async function doubleClick(x, y) {
  await moveMouse(x, y);
  await sleep(50);
  
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class DblClickThrough {
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public MOUSEINPUT mi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    public const uint INPUT_MOUSE = 0;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    public static extern IntPtr WindowFromPoint(int x, int y);

    [DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr lpdwProcessId);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TRANSPARENT = 0x20;
    public const uint GA_ROOT = 2;

    public static void ForceForeground(IntPtr hwnd) {
        IntPtr foreground = GetForegroundWindow();
        uint foregroundThread = GetWindowThreadProcessId(foreground, IntPtr.Zero);
        uint currentThread = GetCurrentThreadId();
        if (foregroundThread != currentThread) {
            AttachThreadInput(currentThread, foregroundThread, true);
            SetForegroundWindow(hwnd);
            AttachThreadInput(currentThread, foregroundThread, false);
        } else {
            SetForegroundWindow(hwnd);
        }
    }

    public static IntPtr GetRealWindowFromPoint(int x, int y) {
        IntPtr hwnd = WindowFromPoint(x, y);
        if (hwnd == IntPtr.Zero) return IntPtr.Zero;
        int maxIterations = 10;
        while (maxIterations-- > 0) {
            int exStyle = GetWindowLong(hwnd, GWL_EXSTYLE);
            bool isTransparent = (exStyle & WS_EX_TRANSPARENT) != 0;
            if (!isTransparent) return GetAncestor(hwnd, GA_ROOT);
            IntPtr parent = GetAncestor(hwnd, 1);
            if (parent == IntPtr.Zero || parent == hwnd) break;
            hwnd = parent;
        }
        return GetAncestor(hwnd, GA_ROOT);
    }

    public static void DoubleClickAt(int x, int y) {
        IntPtr targetWindow = GetRealWindowFromPoint(x, y);
        if (targetWindow != IntPtr.Zero) {
            ForceForeground(targetWindow);
            System.Threading.Thread.Sleep(30);
        }

        INPUT[] inputs = new INPUT[4];
        
        // First click
        inputs[0].type = INPUT_MOUSE;
        inputs[0].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
        inputs[1].type = INPUT_MOUSE;
        inputs[1].mi.dwFlags = MOUSEEVENTF_LEFTUP;

        SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
        System.Threading.Thread.Sleep(50);

        // Second click
        inputs[2].type = INPUT_MOUSE;
        inputs[2].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
        inputs[3].type = INPUT_MOUSE;
        inputs[3].mi.dwFlags = MOUSEEVENTF_LEFTUP;

        SendInput(2, new INPUT[] { inputs[2], inputs[3] }, Marshal.SizeOf(typeof(INPUT)));
    }
}
"@
[DblClickThrough]::DoubleClickAt(${Math.round(x)}, ${Math.round(y)})
`;
  await executePowerShell(script);
  console.log(`[AUTOMATION] Double click at (${x}, ${y}) (click-through enabled)`);
}

/**
 * Type text using SendKeys
 */
async function typeText(text) {
  // Escape special characters for SendKeys
  const escaped = text
    .replace(/\+/g, '{+}')
    .replace(/\^/g, '{^}')
    .replace(/%/g, '{%}')
    .replace(/~/g, '{~}')
    .replace(/\(/g, '{(}')
    .replace(/\)/g, '{)}')
    .replace(/\[/g, '{[}')
    .replace(/\]/g, '{]}')
    .replace(/\{/g, '{{}')
    .replace(/\}/g, '{}}');
  
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("${escaped.replace(/"/g, '`"')}")
`;
  await executePowerShell(script);
  console.log(`[AUTOMATION] Typed: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
}

/**
 * Press a key or key combination (e.g., "ctrl+c", "enter", "alt+tab", "win+r")
 * Now supports Windows key using SendInput with virtual key codes
 */
async function pressKey(keyCombo, options = {}) {
  const parts = normalizeKeyComboParts(keyCombo);
  
  // Check if Windows key is involved - requires special handling
  const hasWinKey = parts.includes('win') || parts.includes('windows') || parts.includes('super');
  
  if (hasWinKey) {
    await pressKeyWithSendInput(keyCombo, { includeWinKey: true });
    console.log(`[AUTOMATION] Pressed Windows key combo: ${keyCombo} (using SendInput)`);
    return;
  }

  if (shouldUseSendInputForKeyCombo(keyCombo, options)) {
    await pressKeyWithSendInput(keyCombo, { includeWinKey: false });
    console.log(`[AUTOMATION] Pressed key: ${keyCombo} (SendInput TradingView-safe path)`);
    return;
  }
  
  // Non-Windows key combos use SendKeys
  let modifiers = '';
  let mainKey = '';
  
  for (const part of parts) {
    if (part === 'ctrl' || part === 'control') {
      modifiers += '^';
    } else if (part === 'alt') {
      modifiers += '%';
    } else if (part === 'shift') {
      modifiers += '+';
    } else if (SPECIAL_KEYS[part]) {
      mainKey = SPECIAL_KEYS[part];
    } else {
      // Regular character
      mainKey = part;
    }
  }
  
  const sendKeysStr = modifiers + (mainKey ? `(${mainKey})` : '');
  
  if (!sendKeysStr) {
    throw new Error(`Invalid key combo: ${keyCombo}`);
  }
  
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("${sendKeysStr}")
`;
  await executePowerShell(script);
  console.log(`[AUTOMATION] Pressed key: ${keyCombo} (SendKeys: ${sendKeysStr})`);
}

/**
 * Scroll at current position
 */
async function scroll(direction, amount = 3) {
  const scrollAmount = direction === 'up' ? amount * 120 : -amount * 120;
  
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class MouseScroll {
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
    public const uint MOUSEEVENTF_WHEEL = 0x0800;
    public static void Scroll(int amount) {
        mouse_event(MOUSEEVENTF_WHEEL, 0, 0, (uint)amount, 0);
    }
}
"@
[MouseScroll]::Scroll(${scrollAmount})
`;
  await executePowerShell(script);
  console.log(`[AUTOMATION] Scrolled ${direction} by ${amount} units`);
}

/**
 * Drag from one point to another - FIXED for transparent overlay click-through
 */
async function drag(fromX, fromY, toX, toY) {
  await moveMouse(fromX, fromY);
  await sleep(100);
  
  // Mouse down + drag + mouse up using SendInput
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class DragThrough {
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public MOUSEINPUT mi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    public const uint INPUT_MOUSE = 0;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    public static extern IntPtr WindowFromPoint(int x, int y);

    [DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr lpdwProcessId);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TRANSPARENT = 0x20;
    public const uint GA_ROOT = 2;

    public static void ForceForeground(IntPtr hwnd) {
        IntPtr foreground = GetForegroundWindow();
        uint foregroundThread = GetWindowThreadProcessId(foreground, IntPtr.Zero);
        uint currentThread = GetCurrentThreadId();
        if (foregroundThread != currentThread) {
            AttachThreadInput(currentThread, foregroundThread, true);
            SetForegroundWindow(hwnd);
            AttachThreadInput(currentThread, foregroundThread, false);
        } else {
            SetForegroundWindow(hwnd);
        }
    }

    public static IntPtr GetRealWindowFromPoint(int x, int y) {
        IntPtr hwnd = WindowFromPoint(x, y);
        if (hwnd == IntPtr.Zero) return IntPtr.Zero;
        int maxIterations = 10;
        while (maxIterations-- > 0) {
            int exStyle = GetWindowLong(hwnd, GWL_EXSTYLE);
            bool isTransparent = (exStyle & WS_EX_TRANSPARENT) != 0;
            if (!isTransparent) return GetAncestor(hwnd, GA_ROOT);
            IntPtr parent = GetAncestor(hwnd, 1);
            if (parent == IntPtr.Zero || parent == hwnd) break;
            hwnd = parent;
        }
        return GetAncestor(hwnd, GA_ROOT);
    }

    public static void MouseDown() {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_MOUSE;
        inputs[0].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void MouseUp() {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_MOUSE;
        inputs[0].mi.dwFlags = MOUSEEVENTF_LEFTUP;
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }
}
"@

# Activate window at start point
$targetWindow = [DragThrough]::GetRealWindowFromPoint(${Math.round(fromX)}, ${Math.round(fromY)})
if ($targetWindow -ne [IntPtr]::Zero) {
    [DragThrough]::ForceForeground($targetWindow)
    Start-Sleep -Milliseconds 30
}

# Mouse down at start position
[DragThrough]::MouseDown()
`;
  await executePowerShell(script);
  
  // Move to destination
  await sleep(100);
  await moveMouse(toX, toY);
  await sleep(100);
  
  // Mouse up
  const upScript = `
[DragThrough]::MouseUp()
`;
  await executePowerShell(upScript);
  
  console.log(`[AUTOMATION] Dragged from (${fromX}, ${fromY}) to (${toX}, ${toY}) (click-through enabled)`);
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ===== DIRECT COMMAND EXECUTION =====
// Most reliable for terminal operations - runs shell commands directly

/**
 * Truncate output for token efficiency while preserving useful info
 */
function truncateOutput(output, maxLen = 4000) {
  if (!output || output.length <= maxLen) return output;
  
  const headLen = Math.floor(maxLen * 0.4);
  const tailLen = Math.floor(maxLen * 0.4);
  
  return output.slice(0, headLen) + 
    `\n\n... [${output.length - headLen - tailLen} characters truncated] ...\n\n` +
    output.slice(-tailLen);
}

/**
 * Check if a command is dangerous and requires confirmation
 */
function isCommandDangerous(command) {
  return DANGEROUS_COMMAND_PATTERNS.some(pattern => pattern.test(command));
}

/**
 * Execute a shell command directly
 * This is the MOST RELIABLE way to run terminal commands!
 */
async function executeCommand(command, options = {}) {
  const { 
    cwd = os.homedir(), 
    shell = 'powershell', 
    timeout = 30000,
    maxOutput = 50000 
  } = options;
  
  console.log(`[AUTOMATION] Executing command: ${command}`);
  console.log(`[AUTOMATION] Working directory: ${cwd}, Shell: ${shell}`);
  
  return new Promise((resolve) => {
    const startTime = Date.now();
    
    // Determine shell executable
    let shellExe;
    let shellArgs;
    if (shell === 'cmd') {
      shellExe = 'cmd.exe';
      shellArgs = ['/c', command];
    } else if (shell === 'bash') {
      shellExe = 'bash';
      shellArgs = ['-c', command];
    } else {
      // Default: PowerShell
      shellExe = 'powershell.exe';
      shellArgs = ['-NoProfile', '-Command', command];
    }
    
    const { spawn } = require('child_process');
    const child = spawn(shellExe, shellArgs, {
      cwd: cwd || os.homedir(),
      timeout: Math.min(timeout, 120000),
      shell: false,
      windowsHide: true
    });
    
    let stdout = '';
    let stderr = '';
    let killed = false;
    
    // Set timeout
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
    }, Math.min(timeout, 120000));
    
    child.stdout.on('data', (data) => {
      stdout += data.toString();
      // Prevent memory issues
      if (stdout.length > maxOutput * 2) {
        stdout = stdout.slice(-maxOutput);
      }
    });
    
    child.stderr.on('data', (data) => {
      stderr += data.toString();
      if (stderr.length > maxOutput) {
        stderr = stderr.slice(-maxOutput);
      }
    });
    
    child.on('close', (code) => {
      clearTimeout(timer);
      const duration = Date.now() - startTime;
      
      const result = {
        success: code === 0 && !killed,
        stdout: truncateOutput(stdout.trim(), 4000),
        stderr: stderr.trim().slice(0, 1000),
        exitCode: killed ? -1 : (code || 0),
        duration,
        truncated: stdout.length > 4000,
        originalLength: stdout.length,
        timedOut: killed
      };
      
      console.log(`[AUTOMATION] Command completed: exit=${result.exitCode}, duration=${duration}ms, output=${result.stdout.length} chars`);
      resolve(result);
    });
    
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        success: false,
        stdout: '',
        stderr: err.message,
        exitCode: -1,
        duration: Date.now() - startTime,
        error: err.message
      });
    });
  });
}

// ===== SEMANTIC ELEMENT-BASED AUTOMATION =====
// More reliable than coordinate-based - finds elements by their properties

/**
 * Execute PowerShell script from a temp file (better for complex scripts)
 */
function executePowerShellScript(scriptContent, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const tempDir = path.join(os.tmpdir(), 'liku-automation');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const scriptFile = path.join(tempDir, `script-${Date.now()}.ps1`);
    fs.writeFileSync(scriptFile, scriptContent, 'utf8');
    
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptFile}"`, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024
    }, (error, stdout, stderr) => {
      // Clean up
      try { fs.unlinkSync(scriptFile); } catch (e) {}
      
      if (error) {
        console.error(`[AUTOMATION] Script failed: ${error.message}`);
        console.error(`[AUTOMATION] STDERR: ${stderr}`);
        // Return structured error instead of failing promise
        resolve({ error: error.message, stderr, stdout, failed: true });
      } else {
        resolve({ stdout: stdout.trim(), stderr, success: true });
      }
    });
  });
}

/**
 * Find UI element by text content using Windows UI Automation
 * Searches the entire UI tree for elements containing the specified text
 * 
 * @param {string} searchText - Text to search for (partial match)
 * @param {Object} options - Search options
 * @param {string} options.controlType - Filter by control type (Button, Text, ComboBox, etc.)
 * @param {boolean} options.exact - Require exact text match (default: false)
 * @returns {Object} Element info with bounds, or error
 */
async function findElementByText(searchText, options = {}) {
  const { controlType = '', exact = false } = options;
  
  const psScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
} catch {
    Write-Output '{"error": "Failed to load UIAutomation assemblies"}'
    exit 0
}

function Find-InElement {
    param($Root, $Text, $IsExact, $CtrlType)
    
    $condition = [System.Windows.Automation.Condition]::TrueCondition
    
    # Use TreeWalker for lighter iteration than FindAll if possible, but FindAll is easier to robustly code
    # Optimization: Filter by ControlType if provided to reduce elements
    if ($CtrlType) {
        # Check if known type to map to Condition
        # Skipping for now to keep string matching simple
    }

    try {
        $elements = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
        
        foreach ($el in $elements) {
            try {
                if (-not $el.Current.IsEnabled -or $el.Current.IsOffscreen) { continue }
                
                $name = $el.Current.Name
                if ([string]::IsNullOrEmpty($name)) { continue }
                
                $match = $false
                if ($IsExact) { $match = ($name -eq $Text) }
                else { $match = ($name -like "*$Text*") }
                
                if ($match) {
                     # Optional ControlType check
                     if ($CtrlType -and $el.Current.ControlType.ProgrammaticName -notlike "*$CtrlType*") { continue }
                     
                     return $el
                }
            } catch {}
        }
    } catch {}
    return $null
}

function Get-ElementData {
    param($el)
    try {
        $rect = $el.Current.BoundingRectangle
        if ($rect.Width -le 0 -or $rect.Height -le 0) { return $null }
        
        # Walk up to find the parent Window handle
        $handle = 0
        try {
            if ($el.Current.NativeWindowHandle -ne 0) {
                $handle = $el.Current.NativeWindowHandle
            } else {
                $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
                $parent = $walker.GetParent($el)
                $maxSteps = 10
                while ($parent -and $maxSteps -gt 0) {
                   if ($parent.Current.NativeWindowHandle -ne 0) {
                       $handle = $parent.Current.NativeWindowHandle
                       break
                   }
                   $parent = $walker.GetParent($parent)
                   $maxSteps--
                }
            }
        } catch {}

        return @{
            Name = $el.Current.Name
            ControlType = $el.Current.ControlType.ProgrammaticName
            AutomationId = $el.Current.AutomationId
            WindowHandle = $handle
            Bounds = @{
                X = [int]$rect.X
                Y = [int]$rect.Y
                Width = [int]$rect.Width
                Height = [int]$rect.Height
                CenterX = [int]($rect.X + $rect.Width / 2)
                CenterY = [int]($rect.Y + $rect.Height / 2)
            }
        }
    } catch { return $null }
}

try {
    $searchText = "${searchText.replace(/"/g, '`"')}"
    $controlType = "${controlType}"
    $exact = $${exact}
    
    # 1. Search Active Window (Fast Path)
    # Using System.Windows.Forms to get active window handle is unreliable in pure scripts sometimes
    # Use Automation Root -> First child focus? No, FocusElement.
    
    try {
       $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
       if ($focused) {
            # Walk up to get the window
            $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
            $node = $focused
            while ($node -and $node.Current.ControlType.Id -ne [System.Windows.Automation.ControlType]::Window.Id) {
                try { $parent = $walker.GetParent($node); $node = $parent } catch { break }
            }
            if ($node) {
                # Found active window, search it
                $found = Find-InElement -Root $node -Text $searchText -IsExact $exact -CtrlType $controlType
                if ($found) {
                    $data = Get-ElementData -el $found
                    if ($data) {
                        $data | ConvertTo-Json -Compress
                        exit 0
                    }
                }
            }
       }
    } catch {}

    # 2. Iterate Top Level Windows (Robust Path)
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $winCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
    $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winCondition)
    
    foreach ($win in $windows) {
        $found = Find-InElement -Root $win -Text $searchText -IsExact $exact -CtrlType $controlType
        if ($found) {
            $data = Get-ElementData -el $found
            if ($data) {
                $data | ConvertTo-Json -Compress
                exit 0
            }
        }
    }
    
    Write-Output '{"error": "Element not found"}'

} catch {
    Write-Output "{\\"error\\": \\"$($_.Exception.Message.Replace('"', '\\"'))\\"}"
}
`;

  const result = await executePowerShellScript(psScript, 15000);
  
  if (result.error) {
    return { error: result.error, elements: [] };
  }
  
  try {
    let elements = JSON.parse(result.stdout.trim() || '[]');
    
    // Check for error object from PowerShell
    if (!Array.isArray(elements) && elements.error) {
        return { success: false, error: elements.error };
    }

    if (!Array.isArray(elements)) {
      elements = elements ? [elements] : [];
    }
    
    console.log(`[AUTOMATION] Found ${elements.length} elements matching "${searchText}"`);
    
    return {
      success: true,
      elements,
      count: elements.length,
      // Return first match for convenience
      element: elements.length > 0 ? elements[0] : null
    };
  } catch (e) {
    return { error: 'Failed to parse element results', raw: result.stdout, elements: [] };
  }
}

/**
 * Click on a UI element found by its text content
 * This is MORE RELIABLE than coordinate-based clicking
 * 
 * @param {string} searchText - Text to search for
 * @param {Object} options - Search options (same as findElementByText)
 * @returns {Object} Click result
 */
async function clickElementByText(searchText, options = {}) {
  console.log(`[AUTOMATION] Searching for element: "${searchText}"`);
  
  const findResult = await findElementByText(searchText, options);
  
  if (findResult.error) {
    return { success: false, error: findResult.error };
  }
  
  if (!findResult.element) {
    return { 
      success: false, 
      error: `No element found containing "${searchText}"`,
      searched: searchText
    };
  }
  
  const el = findResult.element;
  const { CenterX, CenterY } = el.Bounds;
  
  console.log(`[AUTOMATION] Found "${el.Name}" at center (${CenterX}, ${CenterY})`);
  
  // Ensure the window containing the element is focused (fixes obscured window issues)
  if (el.WindowHandle && el.WindowHandle !== 0) {
    console.log(`[AUTOMATION] Auto-focusing window handle: ${el.WindowHandle}`);
    await focusWindow(el.WindowHandle);
    await sleep(150);
  }
  
  // Use UI Automation Invoke pattern for buttons (more reliable than mouse simulation)
  if (options.useInvoke !== false && el.ControlType && el.ControlType.includes('Button')) {
    console.log(`[AUTOMATION] Using Invoke pattern for button`);
    const invokeResult = await invokeElementByText(searchText, options);
    if (invokeResult.success) {
      return invokeResult;
    }
    console.log(`[AUTOMATION] Invoke failed, falling back to mouse click`);
  }
  
  // Click the center of the element
  await click(CenterX, CenterY, 'left');
  
  return {
    success: true,
    message: `Clicked "${el.Name}" at (${CenterX}, ${CenterY})`,
    element: el,
    coordinates: { x: CenterX, y: CenterY }
  };
}

/**
 * Invoke a UI element using UI Automation's Invoke pattern
 * More reliable than simulating mouse clicks for buttons
 */
async function invokeElementByText(searchText, options = {}) {
  const controlType = options.controlType || '';
  const exact = options.exact === true;
  
  const psScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
} catch {
    Write-Output '{"error": "Failed to load UIAutomation assemblies"}'
    exit 0
}

# Define ClickHelper globally to avoid type re-definition errors and syntax issues
try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class ClickHelper {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public static void Click(int x, int y) {
        SetCursorPos(x, y);
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
    }
}
'@
} catch {}

function Invoke-FoundElement {
    param($element)
    try {
        # Try Invoke pattern first
        if ($element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)) {
            $invokePattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
            $invokePattern.Invoke()
            $name = $element.Current.Name
            $rect = $element.Current.BoundingRectangle
            Write-Output "{\\"success\\": true, \\"method\\": \\"Invoke\\", \\"name\\": \\"$name\\", \\"x\\": $([int]($rect.X + $rect.Width/2)), \\"y\\": $([int]($rect.Y + $rect.Height/2))}"
            return $true
        }
    } catch {}

    try {
        # Try Toggle pattern
        if ($element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)) {
            $togglePattern = $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
            $togglePattern.Toggle()
            $name = $element.Current.Name
            Write-Output "{\\"success\\": true, \\"method\\": \\"Toggle\\", \\"name\\": \\"$name\\"}"
            return $true
        }
    } catch {}
    
    # Try Select (if Item)
    try {
        if ($element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)) {
            $selPattern = $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
            $selPattern.Select()
            $name = $element.Current.Name
            Write-Output "{\\"success\\": true, \\"method\\": \\"Select\\", \\"name\\": \\"$name\\"}"
            return $true
        }
    } catch {}

    # Fallback to Focus + Click
    try {
        $element.SetFocus()
        Start-Sleep -Milliseconds 100
        $rect = $element.Current.BoundingRectangle
        $x = [int]($rect.X + $rect.Width / 2)
        $y = [int]($rect.Y + $rect.Height / 2)
        
        [ClickHelper]::Click($x, $y)
        $name = $element.Current.Name
        Write-Output "{\\"success\\": true, \\"method\\": \\"FocusClick\\", \\"name\\": \\"$name\\", \\"x\\": $x, \\"y\\": $y}"
        return $true
    } catch {
        return $false
    }
}

function Find-And-Invoke {
    param($Root, $Text, $IsExact, $CtrlType)
    
    $condition = [System.Windows.Automation.Condition]::TrueCondition
    try {
        $elements = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
        
        foreach ($el in $elements) {
            try {
                if (-not $el.Current.IsEnabled -or $el.Current.IsOffscreen) { continue }
                
                $name = $el.Current.Name
                if ([string]::IsNullOrEmpty($name)) { continue }
                
                $match = $false
                if ($IsExact) { $match = ($name -eq $Text) }
                else { $match = ($name -like "*$Text*") }
                
                if ($match) {
                     if ($CtrlType -and $el.Current.ControlType.ProgrammaticName -notlike "*$CtrlType*") { continue }
                     
                     if (Invoke-FoundElement -element $el) {
                         exit 0
                     }
                }
            } catch {}
        }
    } catch {}
}

$searchText = "${searchText.replace(/"/g, '`"')}"
$controlType = "${controlType}"
$exact = $${exact}

try {
    # 1. Search Active Window
    try {
       $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
       if ($focused) {
            $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
            $node = $focused
            while ($node -and $node.Current.ControlType.Id -ne [System.Windows.Automation.ControlType]::Window.Id) {
                try { $parent = $walker.GetParent($node); $node = $parent } catch { break }
            }
            if ($node) {
                Find-And-Invoke -Root $node -Text $searchText -IsExact $exact -CtrlType $controlType
            }
       }
    } catch {}

    # 2. Iterate Top Level Windows
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $winCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
    $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winCondition)
    
    foreach ($win in $windows) {
        Find-And-Invoke -Root $win -Text $searchText -IsExact $exact -CtrlType $controlType
    }
    
    Write-Output '{"success": false, "error": "Element not found or not interactable"}'

} catch {
    Write-Output "{\\"success\\": false, \\"error\\": \\"Script Error: $($_.Exception.Message.Replace('"', '\\"'))\\"}"
}
`;

  const result = await executePowerShellScript(psScript, 15000);
  
  if (result.error) {
    return { success: false, error: result.error };
  }
  
  try {
    const parsed = JSON.parse(result.stdout.trim());
    if (parsed.success) {
      console.log(`[AUTOMATION] Invoked element using ${parsed.method} pattern`);
    }
    return parsed;
  } catch (e) {
    return { success: false, error: 'Failed to parse invoke result', raw: result.stdout };
  }
}

/**
 * Get active window title
 */
async function getActiveWindowTitle() {
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WindowInfo {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    public static string GetActiveWindowTitle() {
        IntPtr handle = GetForegroundWindow();
        StringBuilder sb = new StringBuilder(256);
        GetWindowText(handle, sb, 256);
        return sb.ToString();
    }
}
"@
[WindowInfo]::GetActiveWindowTitle()
`;
  return await executePowerShell(script);
}

/**
 * Get current foreground window handle (HWND)
 */
async function getForegroundWindowHandle() {
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class ForegroundHandle {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  public static long GetHandle() {
    return GetForegroundWindow().ToInt64();
  }
}
"@
[ForegroundHandle]::GetHandle()
`;
  const out = await executePowerShell(script);
  const num = Number(String(out).trim());
  return Number.isFinite(num) ? num : null;
}

/**
 * Get current foreground window info (HWND, title, pid, process name).
 * Best-effort: returns { success: false, error } on failure.
 */
async function getForegroundWindowInfo() {
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class ForegroundInfo {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr", SetLastError = true)]
  public static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);

  [DllImport("user32.dll", EntryPoint = "GetWindowLong", SetLastError = true)]
  public static extern IntPtr GetWindowLongPtr32(IntPtr hWnd, int nIndex);

  [DllImport("user32.dll")]
  public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool IsZoomed(IntPtr hWnd);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

  public static string GetTitle(IntPtr handle) {
    StringBuilder sb = new StringBuilder(512);
    GetWindowText(handle, sb, sb.Capacity);
    return sb.ToString();
  }

  public static IntPtr GetStyle(IntPtr handle, int index) {
    return IntPtr.Size == 8 ? GetWindowLongPtr64(handle, index) : GetWindowLongPtr32(handle, index);
  }
}
"@

$hwnd = [ForegroundInfo]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) {
  Write-Output '{"success":false,"error":"No foreground window"}'
  exit 0
}

$targetPid = 0
[void][ForegroundInfo]::GetWindowThreadProcessId($hwnd, [ref]$targetPid)
$title = [ForegroundInfo]::GetTitle($hwnd)

$procName = ''
try {
  $p = Get-Process -Id $targetPid -ErrorAction Stop
  $procName = $p.ProcessName
} catch {
  $procName = ''
}

$GWL_EXSTYLE = -20
$GW_OWNER = 4
$WS_EX_TOPMOST = 0x00000008
$WS_EX_TOOLWINDOW = 0x00000080

$exStyle = [int64][ForegroundInfo]::GetStyle($hwnd, $GWL_EXSTYLE)
$owner = [ForegroundInfo]::GetWindow($hwnd, $GW_OWNER)
$ownerHwnd = if ($owner -eq [IntPtr]::Zero) { 0 } else { [int64]$owner }
$isTopmost = (($exStyle -band $WS_EX_TOPMOST) -ne 0)
$isToolWindow = (($exStyle -band $WS_EX_TOOLWINDOW) -ne 0)
$isMinimized = [ForegroundInfo]::IsIconic($hwnd)
$isMaximized = [ForegroundInfo]::IsZoomed($hwnd)
$windowKind = if ($ownerHwnd -ne 0 -and $isToolWindow) { 'palette' } elseif ($ownerHwnd -ne 0) { 'owned' } else { 'main' }

$obj = [PSCustomObject]@{
  success = $true
  hwnd = $hwnd.ToInt64()
  pid = [int]$targetPid
  processName = $procName
  title = $title
  ownerHwnd = $ownerHwnd
  isTopmost = $isTopmost
  isToolWindow = $isToolWindow
  isMinimized = $isMinimized
  isMaximized = $isMaximized
  windowKind = $windowKind
}
$obj | ConvertTo-Json -Compress
`;

  try {
    const result = await executePowerShellScript(script, 8000);
    const text = String(result?.stdout || '').trim();
    if (!text) {
      return { success: false, error: result?.stderr?.trim() || result?.error || 'No output' };
    }
    return JSON.parse(text);
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Get running processes filtered by candidate names.
 * Returns lightweight awareness data for launch verification.
 *
 * @param {string[]} processNames
 * @returns {Promise<Array<{pid:number, processName:string, mainWindowTitle:string, startTime:string}>>}
 */
async function getRunningProcessesByNames(processNames = []) {
  const normalized = Array.from(
    new Set(
      (Array.isArray(processNames) ? processNames : [])
        .map((n) => String(n || '').trim().toLowerCase())
        .filter(Boolean)
    )
  );

  if (!normalized.length) {
    return [];
  }

  const jsonNames = JSON.stringify(normalized);
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$targets = '${jsonNames}' | ConvertFrom-Json

$procs = Get-Process -ErrorAction SilentlyContinue |
  Where-Object {
    $name = ($_.ProcessName | Out-String).Trim().ToLowerInvariant()
    foreach ($t in $targets) {
      if ($name -eq $t -or $name -like ("*$t*")) {
        return $true
      }
    }
    return $false
  } |
  Select-Object @{
      Name='pid'; Expression={ [int]$_.Id }
    }, @{
      Name='processName'; Expression={ [string]$_.ProcessName }
    }, @{
      Name='mainWindowTitle'; Expression={ [string]$_.MainWindowTitle }
    }, @{
      Name='startTime'; Expression={ try { $_.StartTime.ToString('o') } catch { '' } }
    }, @{
      Name='sortKey'; Expression={ try { $_.StartTime.Ticks } catch { 0 } }
    } |
  Sort-Object sortKey -Descending |
    Select-Object -First 15 -Property pid, processName, mainWindowTitle, startTime

if (-not $procs) {
  '[]'
} else {
  $procs | ConvertTo-Json -Compress
}
`;

  try {
    const result = await executePowerShellScript(script, 10000);
    const text = String(result?.stdout || '').trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/**
 * Execute an action from AI
 * @param {Object} action - Action object from AI
 * @returns {Object} Result of the action
 */
async function executeAction(action) {
  // Normalize common schema variants from different models.
  // This keeps execution resilient when the model uses alternate action names.
  const normalizeAction = (a) => {
    if (!a || typeof a !== 'object') return a;
    const rawType = (a.type ?? a.action ?? '').toString().trim();
    const t = rawType.toLowerCase();
    const out = { ...a };

    if (!out.type && out.action) out.type = out.action;

    if (t === 'press_key' || t === 'presskey' || t === 'key_press' || t === 'keypress' || t === 'send_key') {
      out.type = ACTION_TYPES.KEY;
    } else if (t === 'type_text' || t === 'typetext' || t === 'enter_text' || t === 'input_text') {
      out.type = ACTION_TYPES.TYPE;
    } else if (t === 'type_text' || t === 'type') {
      out.type = ACTION_TYPES.TYPE;
    } else if (t === 'take_screenshot' || t === 'screencap') {
      out.type = ACTION_TYPES.SCREENSHOT;
    } else if (t === 'sleep' || t === 'delay' || t === 'wait_ms') {
      out.type = ACTION_TYPES.WAIT;
    } else if (t === 'grep' || t === 'search_repo' || t === 'repo_search') {
      out.type = ACTION_TYPES.GREP_REPO;
    } else if (t === 'semantic_search' || t === 'semantic_repo_search') {
      out.type = ACTION_TYPES.SEMANTIC_SEARCH_REPO;
    } else if (t === 'pgrep' || t === 'process_search') {
      out.type = ACTION_TYPES.PGREP_PROCESS;
    }

    // Normalize common property names
    if (out.type === ACTION_TYPES.TYPE && (out.text === undefined || out.text === null)) {
      if (typeof out.value === 'string') out.text = out.value;
      else if (typeof out.input === 'string') out.text = out.input;
    }
    if (out.type === ACTION_TYPES.KEY && (out.key === undefined || out.key === null)) {
      if (typeof out.combo === 'string') out.key = out.combo;
      else if (typeof out.keys === 'string') out.key = out.keys;
    }
    if (out.type === ACTION_TYPES.WAIT && (out.ms === undefined || out.ms === null)) {
      const ms = out.milliseconds ?? out.duration_ms ?? out.durationMs;
      if (Number.isFinite(Number(ms))) out.ms = Number(ms);
    }

    return out;
  };

  action = normalizeAction(action);
  console.log(`[AUTOMATION] Executing action:`, JSON.stringify(action));
  
  const startTime = Date.now();
  let result = { success: true, action: action.type };

  const withInferredProcessName = (a) => {
    if (!a || typeof a !== 'object') return a;
    if (typeof a.processName === 'string' && a.processName.trim()) return a;
    const title = typeof a.title === 'string' ? a.title.toLowerCase() : '';
    if (!title) return a;

    let processName = null;
    if (title.includes('edge')) processName = 'msedge';
    else if (title.includes('visual studio code') || title.includes('vs code') || title.includes('vscode')) processName = 'code';
    else if (title.includes('chrome')) processName = 'chrome';
    else if (title.includes('firefox')) processName = 'firefox';
    else if (title.includes('explorer') || title.includes('file manager')) processName = 'explorer';
    else if (title.includes('notepad++')) processName = 'notepad++';
    else if (title.includes('notepad')) processName = 'notepad';
    else if (title.includes('terminal') || title.includes('powershell')) processName = 'WindowsTerminal';
    else if (title.includes('cmd') || title.includes('command prompt')) processName = 'cmd';
    else if (title.includes('spotify')) processName = 'Spotify';
    else if (title.includes('slack')) processName = 'slack';
    else if (title.includes('discord')) processName = 'Discord';
    else if (title.includes('teams')) processName = 'ms-teams';
    else if (title.includes('outlook')) processName = 'olk';

    if (!processName) return a;
    return { ...a, processName };
  };
  
  try {
    switch (action.type) {
      case ACTION_TYPES.CLICK:
        await click(action.x, action.y, action.button || 'left');
        result.message = `Clicked at (${action.x}, ${action.y})`;
        break;
        
      case ACTION_TYPES.DOUBLE_CLICK:
        await doubleClick(action.x, action.y);
        result.message = `Double-clicked at (${action.x}, ${action.y})`;
        break;
        
      case ACTION_TYPES.RIGHT_CLICK:
        await click(action.x, action.y, 'right');
        result.message = `Right-clicked at (${action.x}, ${action.y})`;
        break;
        
      case ACTION_TYPES.MOVE_MOUSE:
        await moveMouse(action.x, action.y);
        result.message = `Mouse moved to (${action.x}, ${action.y})`;
        break;
        
      case ACTION_TYPES.TYPE:
        await typeText(action.text);
        result.message = `Typed "${action.text.substring(0, 30)}${action.text.length > 30 ? '...' : ''}"`;
        break;
        
      case ACTION_TYPES.KEY:
        await pressKey(action.key, action);
        result.message = `Pressed ${action.key}`;
        break;
        
      case ACTION_TYPES.SCROLL:
        await scroll(action.direction, action.amount || 3);
        result.message = `Scrolled ${action.direction}`;
        break;
        
      case ACTION_TYPES.WAIT:
        await sleep(action.ms || 1000);
        result.message = `Waited ${action.ms || 1000}ms`;
        break;
        
      case ACTION_TYPES.DRAG:
        await drag(action.fromX, action.fromY, action.toX, action.toY);
        result.message = `Dragged from (${action.fromX}, ${action.fromY}) to (${action.toX}, ${action.toY})`;
        break;
        
      case ACTION_TYPES.SCREENSHOT:
        // Scoped screenshot — caller resolves capture based on scope
        result.needsScreenshot = true;
        result.scope = action.scope || 'screen';         // screen | region | window | element
        result.region = action.region || null;            // {x, y, width, height} for scope=region
        result.hwnd = action.hwnd || null;                // window handle for scope=window
        result.elementCriteria = action.elementCriteria || null; // {text, controlType} for scope=element
        result.targetRegionId = action.targetRegionId || null;
        result.message = `Screenshot requested (scope: ${result.scope})`;
        break;
      
      // Semantic element-based actions (MORE RELIABLE than coordinates)
      case ACTION_TYPES.CLICK_ELEMENT:
        const clickResult = await clickElementByText(action.text, {
          controlType: action.controlType || '',
          exact: action.exact || false
        });
        result = { ...result, ...clickResult };
        break;
        
      case ACTION_TYPES.FIND_ELEMENT:
        const findResult = await findElementByText(action.text, {
          controlType: action.controlType || '',
          exact: action.exact || false
        });
        result = { ...result, ...findResult };
        break;
      
      case ACTION_TYPES.RUN_COMMAND:
        const cmdResult = await executeCommand(action.command, {
          cwd: action.cwd,
          shell: action.shell || 'powershell',
          timeout: action.timeout || 30000
        });
        result = { 
          ...result, 
          ...cmdResult,
          command: action.command,
          cwd: action.cwd || os.homedir()
        };
        result.message = cmdResult.success 
          ? `Command completed (exit ${cmdResult.exitCode})`
          : `Command failed: ${cmdResult.stderr || cmdResult.error || `exit code ${cmdResult.exitCode}`}`;
        break;

      case ACTION_TYPES.GREP_REPO:
      case ACTION_TYPES.SEMANTIC_SEARCH_REPO:
      case ACTION_TYPES.PGREP_PROCESS: {
        const repoSearchActions = require('./repo-search-actions');
        const searchResult = await repoSearchActions.executeRepoSearchAction(action);
        result = {
          ...result,
          ...searchResult
        };
        if (searchResult.success) {
          const noun = action.type === ACTION_TYPES.PGREP_PROCESS ? 'process match' : 'repo match';
          const count = Number(searchResult.count || 0);
          result.message = `${count} ${noun}${count === 1 ? '' : 'es'} found`;
        } else {
          result.message = searchResult.error || `${action.type} failed`;
        }
        break;
      }

      case ACTION_TYPES.FOCUS_WINDOW:
      case ACTION_TYPES.BRING_WINDOW_TO_FRONT: {
        const enriched = withInferredProcessName(action);
        const hwnd = await resolveWindowHandle(enriched);
        if (!hwnd) {
          const hint = enriched.title || enriched.processName || 'unknown';
          throw new Error(`Window "${hint}" not found. Make sure the application is running and visible.`);
        }
        const focusResult = await focusWindow(hwnd);
        result = {
          ...result,
          requestedWindowHandle: hwnd,
          actualForegroundHandle: Number(focusResult?.actualForegroundHandle || 0) || 0,
          actualForeground: focusResult?.actualForeground || null,
          focusTarget: {
            requestedWindowHandle: hwnd,
            requestedTarget: {
              title: enriched.title || null,
              processName: enriched.processName || null,
              className: enriched.className || null
            },
            actualForegroundHandle: Number(focusResult?.actualForegroundHandle || 0) || 0,
            actualForeground: focusResult?.actualForeground || null,
            exactMatch: !!focusResult?.exactMatch,
            outcome: focusResult?.exactMatch ? 'exact' : 'mismatch'
          }
        };
        if (focusResult?.exactMatch) {
          result.message = `Brought window ${hwnd} to front`;
        } else {
          result.message = `Focus requested for ${hwnd} but foreground is ${result.actualForegroundHandle || 'unknown'}`;
        }
        break;
      }

      case ACTION_TYPES.SEND_WINDOW_TO_BACK: {
        const hwnd = await resolveWindowHandle(withInferredProcessName(action));
        if (!hwnd) {
          throw new Error('Window not found. Provide hwnd/windowHandle or title/processName/className.');
        }
        await sendWindowToBack(hwnd);
        result.message = `Sent window ${hwnd} to back`;
        break;
      }

      case ACTION_TYPES.MINIMIZE_WINDOW: {
        const hwnd = await resolveWindowHandle(withInferredProcessName(action));
        if (!hwnd) {
          throw new Error('Window not found. Provide hwnd/windowHandle or title/processName/className.');
        }
        await minimizeWindow(hwnd);
        result.message = `Minimized window ${hwnd}`;
        break;
      }

      case ACTION_TYPES.RESTORE_WINDOW: {
        const hwnd = await resolveWindowHandle(withInferredProcessName(action));
        if (!hwnd) {
          throw new Error('Window not found. Provide hwnd/windowHandle or title/processName/className.');
        }
        await restoreWindow(hwnd);
        result.message = `Restored window ${hwnd}`;
        break;
      }

      // ── Phase 3: Pattern-first UIA actions ──────────────────
      case ACTION_TYPES.SET_VALUE: {
        const uia = require('./ui-automation');
        const svResult = await uia.setElementValue(
          action.criteria || { text: action.text, automationId: action.automationId, controlType: action.controlType },
          action.value
        );
        result = { ...result, ...svResult };
        result.message = svResult.success
          ? `Set value via ${svResult.method} on element`
          : `Set value failed: ${svResult.error}`;
        break;
      }

      case ACTION_TYPES.SCROLL_ELEMENT: {
        const uia = require('./ui-automation');
        const seResult = await uia.scrollElement(
          action.criteria || { text: action.text, automationId: action.automationId, controlType: action.controlType },
          { direction: action.direction || 'down', amount: action.amount ?? -1 }
        );
        result = { ...result, ...seResult };
        result.message = seResult.success
          ? `Scrolled ${action.direction || 'down'} via ${seResult.method}`
          : `Scroll failed: ${seResult.error}`;
        break;
      }

      case ACTION_TYPES.EXPAND_ELEMENT: {
        const uia = require('./ui-automation');
        const exResult = await uia.expandElement(
          action.criteria || { text: action.text, automationId: action.automationId, controlType: action.controlType }
        );
        result = { ...result, ...exResult };
        result.message = exResult.success
          ? `Expanded element (${exResult.stateBefore} → ${exResult.stateAfter})`
          : `Expand failed: ${exResult.error}`;
        break;
      }

      case ACTION_TYPES.COLLAPSE_ELEMENT: {
        const uia = require('./ui-automation');
        const clResult = await uia.collapseElement(
          action.criteria || { text: action.text, automationId: action.automationId, controlType: action.controlType }
        );
        result = { ...result, ...clResult };
        result.message = clResult.success
          ? `Collapsed element (${clResult.stateBefore} → ${clResult.stateAfter})`
          : `Collapse failed: ${clResult.error}`;
        break;
      }

      case ACTION_TYPES.GET_TEXT: {
        const uia = require('./ui-automation');
        const gtResult = await uia.getElementText(
          action.criteria || { text: action.text, automationId: action.automationId, controlType: action.controlType }
        );
        result = { ...result, ...gtResult };
        const pineTargetText = String(action?.text || action?.criteria?.text || '');
        if (gtResult.success
          && action?.pineEvidenceMode === 'provenance-summary'
          && /pine version history/i.test(pineTargetText)) {
          result.pineStructuredSummary = buildPineVersionHistoryStructuredSummary(gtResult.text, action.pineSummaryFields);
        } else if (gtResult.success && /pine editor/i.test(pineTargetText)) {
          if (action?.pineEvidenceMode === 'safe-authoring-inspect') {
            result.pineStructuredSummary = buildPineEditorSafeAuthoringSummary(gtResult.text);
          } else if (
            action?.pineEvidenceMode === 'compile-result'
            || action?.pineEvidenceMode === 'diagnostics'
            || action?.pineEvidenceMode === 'line-budget'
            || action?.pineEvidenceMode === 'generic-status'
          ) {
            result.pineStructuredSummary = buildPineEditorDiagnosticsStructuredSummary(gtResult.text, action.pineEvidenceMode);
          }
        }
        result.message = gtResult.success
          ? `Got text via ${gtResult.method}: "${(gtResult.text || '').slice(0, 50)}"${result.pineStructuredSummary?.compactSummary ? ` [${result.pineStructuredSummary.compactSummary}]` : ''}`
          : `Get text failed: ${gtResult.error}`;
        break;
      }
        
      case 'dynamic_tool': {
        const toolRegistry = require('./tools/tool-registry');
        const sandbox = require('./tools/sandbox');
        const { runPreToolUseHook, runPostToolUseHook } = require('./tools/hook-runner');
        const lookup = toolRegistry.lookupTool(action.toolName);
        if (!lookup) {
          throw new Error(`Dynamic tool not found: ${action.toolName}`);
        }
        if (!lookup.entry.approved) {
          throw new Error(`Dynamic tool '${action.toolName}' has not been approved. Use approveTool() to approve it before execution.`);
        }
        // PreToolUse hook gate — security-check.ps1 can deny dynamic tools
        const hookResult = runPreToolUseHook(`dynamic_${action.toolName}`, action.args || {});
        if (hookResult.denied) {
          throw new Error(`Dynamic tool '${action.toolName}' denied by PreToolUse hook: ${hookResult.reason}`);
        }
        console.log(`[AUTOMATION] Executing dynamic tool: ${action.toolName}`);
        const execResult = await sandbox.executeDynamicTool(lookup.absolutePath, action.args || {});
        toolRegistry.recordInvocation(action.toolName);
        // PostToolUse hook — audit-log.ps1 for execution audit trail
        try {
          runPostToolUseHook(`dynamic_${action.toolName}`, action.args || {}, {
            success: execResult.success,
            result: execResult.result,
            error: execResult.error
          });
        } catch (_) { /* audit logging is non-fatal */ }
        if (!execResult.success) {
          throw new Error(`Dynamic tool failed: ${execResult.error}`);
        }
        result.message = `Dynamic tool '${action.toolName}' returned: ${JSON.stringify(execResult.result)}`;
        result.toolResult = execResult.result;
        break;
      }
        
      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }
  } catch (error) {
    result.success = false;
    result.error = error.message;
    console.error(`[AUTOMATION] Action failed:`, error);
  }
  
  result.duration = Date.now() - startTime;

  // Write structured telemetry for RLVR feedback loop
  try {
    writeTelemetry({
      task: result.message || action.type,
      phase: 'execution',
      outcome: result.success ? 'success' : 'failure',
      actions: [{ type: action.type, ...(action.text ? { text: action.text } : {}), ...(action.key ? { key: action.key } : {}) }],
      context: { actionType: action.type, duration: result.duration }
    });
  } catch (_) { /* telemetry is non-fatal */ }

  return result;
}

/**
 * Execute a sequence of actions
 * @param {Array} actions - Array of action objects
 * @param {Function} onAction - Callback after each action (for UI updates)
 * @returns {Array} Results of all actions
 */
async function executeActionSequence(actions, onAction = null) {
  const results = [];
  
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    
    // Execute action
    const result = await executeAction(action);
    result.index = i;
    results.push(result);
    
    // Callback for UI updates
    if (onAction) {
      onAction(result, i, actions.length);
    }
    
    // Stop on failure unless action specifies continue_on_error
    if (!result.success && !action.continue_on_error) {
      console.log(`[AUTOMATION] Sequence stopped at action ${i} due to error`);
      break;
    }
    
    // Default delay between actions
    if (i < actions.length - 1 && action.type !== ACTION_TYPES.WAIT) {
      await sleep(action.delay || 100);
    }
  }
  
  return results;
}

/**
 * Parse AI response to extract actions
 * AI should return JSON with actions array
 */
function parseAIActions(aiResponse) {
  // Try to find JSON in the response
  const jsonBlocks = Array.from(String(aiResponse || '').matchAll(/```json\s*([\s\S]*?)\s*```/gi));
  const normalizeActionBlock = (parsed) => {
    if (!parsed || typeof parsed !== 'object') return parsed;
    if (!Array.isArray(parsed.actions)) return parsed;

    const normalizeType = (type) => {
      const raw = (type ?? '').toString().trim();
      const t = raw.toLowerCase();
      if (!t) return raw;
      if (t === 'press_key' || t === 'presskey' || t === 'key_press' || t === 'keypress' || t === 'send_key') return ACTION_TYPES.KEY;
      if (t === 'type_text' || t === 'typetext' || t === 'enter_text' || t === 'input_text') return ACTION_TYPES.TYPE;
      if (t === 'take_screenshot' || t === 'screencap') return ACTION_TYPES.SCREENSHOT;
      if (t === 'sleep' || t === 'delay' || t === 'wait_ms') return ACTION_TYPES.WAIT;
      return raw;
    };

    const normalizedActions = parsed.actions.map((a) => {
      if (!a || typeof a !== 'object') return a;
      const out = { ...a };
      if (!out.type && out.action) out.type = out.action;
      out.type = normalizeType(out.type);

      if (out.type === ACTION_TYPES.TYPE && (out.text === undefined || out.text === null)) {
        if (typeof out.value === 'string') out.text = out.value;
        else if (typeof out.input === 'string') out.text = out.input;
      }
      if (out.type === ACTION_TYPES.KEY && (out.key === undefined || out.key === null)) {
        if (typeof out.combo === 'string') out.key = out.combo;
        else if (typeof out.keys === 'string') out.key = out.keys;
      }
      if (out.type === ACTION_TYPES.WAIT && (out.ms === undefined || out.ms === null)) {
        const ms = out.milliseconds ?? out.duration_ms ?? out.durationMs;
        if (Number.isFinite(Number(ms))) out.ms = Number(ms);
      }
      return out;
    });

    return { ...parsed, actions: normalizedActions };
  };

  const scoreActionBlock = (parsed) => {
    if (!parsed || !Array.isArray(parsed.actions) || parsed.actions.length === 0) return Number.NEGATIVE_INFINITY;
    let score = 0;
    for (const a of parsed.actions) {
      const t = String(a?.type || '').toLowerCase();
      if (!t) continue;
      // Reward concrete execution steps.
      if (
        t === ACTION_TYPES.KEY
        || t === ACTION_TYPES.TYPE
        || t === ACTION_TYPES.CLICK
        || t === ACTION_TYPES.CLICK_ELEMENT
        || t === ACTION_TYPES.RUN_COMMAND
        || t === ACTION_TYPES.GREP_REPO
        || t === ACTION_TYPES.SEMANTIC_SEARCH_REPO
        || t === ACTION_TYPES.PGREP_PROCESS
      ) {
        score += 3;
      } else if (t === ACTION_TYPES.BRING_WINDOW_TO_FRONT || t === ACTION_TYPES.FOCUS_WINDOW || t === ACTION_TYPES.WAIT) {
        score += 1;
      } else if (t === ACTION_TYPES.SCREENSHOT) {
        score -= 2;
      } else {
        score += 1;
      }
    }

    // Penalize trivial focus-only plans.
    const nonTrivial = parsed.actions.some((a) => {
      const t = String(a?.type || '').toLowerCase();
      return t !== ACTION_TYPES.WAIT && t !== ACTION_TYPES.FOCUS_WINDOW && t !== ACTION_TYPES.BRING_WINDOW_TO_FRONT;
    });
    if (!nonTrivial) score -= 6;

    // Slightly reward longer coherent plans.
    score += Math.min(parsed.actions.length, 8);
    return score;
  };

  const pickBestParsedBlock = (blocks) => {
    let best = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const block of blocks) {
      if (!block) continue;
      const score = scoreActionBlock(block);
      if (score >= bestScore) {
        best = block;
        bestScore = score;
      }
    }
    return best;
  };

  if (jsonBlocks.length > 0) {
    const parsedBlocks = [];
    for (const m of jsonBlocks) {
      try {
        parsedBlocks.push(normalizeActionBlock(JSON.parse(m[1])));
      } catch (e) {
        console.error('[AUTOMATION] Failed to parse JSON from code block:', e);
      }
    }
    const best = pickBestParsedBlock(parsedBlocks);
    if (best) {
      return best;
    }
  }
  
  // Try parsing the whole response as JSON
  try {
    return normalizeActionBlock(JSON.parse(aiResponse));
  } catch (e) {
    // Not JSON - continue
  }
  
  // Try to find inline JSON object with actions array
  const responseStr = typeof aiResponse === 'string' ? aiResponse : String(aiResponse || '');
  const inlineMatch = responseStr.match(/\{[\s\S]*"actions"[\s\S]*\}/);
  if (inlineMatch) {
    try {
      return normalizeActionBlock(JSON.parse(inlineMatch[0]));
    } catch (e) {
      console.error('[AUTOMATION] Failed to parse inline JSON:', e);
    }
  }
  
  // Fallback: extract actions from natural language descriptions
  // This handles cases where AI says "I'll click X at (500, 300)" without JSON
  const nlActions = parseNaturalLanguageActions(responseStr);
  if (nlActions && nlActions.actions.length > 0) {
    console.log('[AUTOMATION] Extracted', nlActions.actions.length, 'action(s) from natural language');
    return normalizeActionBlock(nlActions);
  }
  
  return null;
}

/**
 * Parse actions from natural language AI responses as a fallback.
 * Handles patterns like "click at (500, 300)" or "type 'hello'" in prose.
 */
function parseNaturalLanguageActions(text) {
  const actions = [];
  const lines = text.split('\n');
  
  for (const line of lines) {
    const lower = line.toLowerCase();
    
    // Match "click at (x, y)" or "click (x, y)" or "click at coordinates (x, y)"
    const clickMatch = lower.match(/\b(?:click|tap|press)\b.*?\(\s*(\d+)\s*,\s*(\d+)\s*\)/);
    if (clickMatch) {
      actions.push({ type: 'click', x: parseInt(clickMatch[1]), y: parseInt(clickMatch[2]), reason: line.trim() });
      continue;
    }
    
    // Match "double-click at (x, y)"
    const dblClickMatch = lower.match(/\bdouble[- ]?click\b.*?\(\s*(\d+)\s*,\s*(\d+)\s*\)/);
    if (dblClickMatch) {
      actions.push({ type: 'double_click', x: parseInt(dblClickMatch[1]), y: parseInt(dblClickMatch[2]), reason: line.trim() });
      continue;
    }
    
    // Match "right-click at (x, y)"
    const rightClickMatch = lower.match(/\bright[- ]?click\b.*?\(\s*(\d+)\s*,\s*(\d+)\s*\)/);
    if (rightClickMatch) {
      actions.push({ type: 'right_click', x: parseInt(rightClickMatch[1]), y: parseInt(rightClickMatch[2]), reason: line.trim() });
      continue;
    }
    
    // Match 'type "text"' or "type 'text'" 
    const typeMatch = line.match(/\btype\b.*?["']([^"']+)["']/i);
    if (typeMatch && !lower.includes('action type')) {
      actions.push({ type: 'type', text: typeMatch[1], reason: line.trim() });
      continue;
    }
    
    // Match "press Enter" or "press Ctrl+C"
    const keyMatch = lower.match(/\bpress\b\s+([\w+]+(?:\+[\w+]+)*)/);
    if (keyMatch && !clickMatch) {
      const key = keyMatch[1].toLowerCase();
      // Only match plausible key combos
      if (/^(enter|escape|tab|space|backspace|delete|home|end|up|down|left|right|f\d+|ctrl|alt|shift|win|cmd|super)/.test(key)) {
        actions.push({ type: 'key', key: key, reason: line.trim() });
        continue;
      }
    }
    
    // Match "scroll down" or "scroll up 5 lines"
    const scrollMatch = lower.match(/\bscroll\s+(up|down)(?:\s+(\d+))?\b/);
    if (scrollMatch) {
      actions.push({ type: 'scroll', direction: scrollMatch[1], amount: parseInt(scrollMatch[2]) || 3, reason: line.trim() });
      continue;
    }

    // Match "click_element" / "click on the X button" pattern
    const clickElementMatch = line.match(/\bclick\s+(?:on\s+)?(?:the\s+)?["']([^"']+)["']\s*button/i) ||
                               line.match(/\bclick\s+(?:on\s+)?(?:the\s+)?["']([^"']+)["']/i);
    if (clickElementMatch && !clickMatch) {
      actions.push({ type: 'click_element', text: clickElementMatch[1], reason: line.trim() });
      continue;
    }
  }
  
  if (actions.length === 0) return null;
  
  return {
    thought: 'Actions extracted from AI natural language response',
    actions,
    verification: 'Check that the intended actions completed successfully'
  };
}

/**
 * Convert grid coordinate (like "C3") to screen pixels
 * @param {string} coord - Grid coordinate like "C3", "AB12"
 * @param {Object} screenSize - {width, height} of the screen
 * @param {number} coarseSpacing - Spacing of coarse grid (default 100)
 */
function gridToPixels(coord) {
  const coords = gridMath.labelToScreenCoordinates(coord);
  if (!coords) {
    throw new Error(`Invalid coordinate format: ${coord}`);
  }

  const labelInfo = coords.isFine
    ? `fineCol=${coords.fineCol}, fineRow=${coords.fineRow}`
    : `col=${coords.colIndex}, row=${coords.rowIndex}`;
  console.log(`[AUTOMATION] gridToPixels: ${coord} -> ${labelInfo} -> (${coords.x}, ${coords.y})`);

  return coords;
}

module.exports = {
  ACTION_TYPES,
  executeAction,
  executeActionSequence,
  parseAIActions,
  gridToPixels,
  moveMouse,
  click,
  doubleClick,
  typeText,
  focusWindow,
  pressKey,
  shouldUseSendInputForKeyCombo,
  scroll,
  drag,
  sleep,
  getActiveWindowTitle,
  getForegroundWindowHandle,
  getForegroundWindowInfo,
  getRunningProcessesByNames,
  resolveWindowHandle,
  minimizeWindow,
  restoreWindow,
  sendWindowToBack,
  // Semantic element-based automation (preferred approach)
  findElementByText,
  clickElementByText,
  // v0.0.5: Command execution
  DANGEROUS_COMMAND_PATTERNS,
  isCommandDangerous,
  truncateOutput,
  executeCommand,
  buildPineVersionHistoryStructuredSummary,
  buildPineEditorSafeAuthoringSummary,
  buildPineEditorDiagnosticsStructuredSummary,
};
