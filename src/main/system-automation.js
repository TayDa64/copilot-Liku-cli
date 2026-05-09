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
const {
  discoverChromiumRemoteDebuggingTarget,
  withChromiumCdpSession
} = require('./ui-automation/core/chromium-cdp');

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
  if (options?.tradingViewShortcut || options?.searchSurfaceContract) {
    return true;
  }

  const targetWindow = options?.targetWindow && typeof options.targetWindow === 'object'
    ? options.targetWindow
    : null;
  const verifyTarget = options?.verifyTarget && typeof options.verifyTarget === 'object'
    ? options.verifyTarget
    : null;
  const tradingViewShortcut = options?.tradingViewShortcut && typeof options.tradingViewShortcut === 'object'
    ? options.tradingViewShortcut
    : null;
  const searchSurfaceContract = options?.searchSurfaceContract && typeof options.searchSurfaceContract === 'object'
    ? options.searchSurfaceContract
    : null;

  const haystack = [
    targetWindow?.processName,
    targetWindow?.title,
    verifyTarget?.appName,
    verifyTarget?.requestedAppName,
    verifyTarget?.normalizedAppName,
    ...(Array.isArray(verifyTarget?.processNames) ? verifyTarget.processNames : []),
    ...(Array.isArray(verifyTarget?.titleHints) ? verifyTarget.titleHints : []),
    tradingViewShortcut?.id,
    tradingViewShortcut?.surface,
    searchSurfaceContract?.id,
    searchSurfaceContract?.route,
    searchSurfaceContract?.surface,
    searchSurfaceContract?.appName
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');

  return /tradingview|trading\s+view/.test(haystack);
}

function shouldPreferSendKeysForTradingViewShortcut(keyCombo, options = {}) {
  const normalizedCombo = String(keyCombo || '').trim().toLowerCase();
  const shortcutId = String(
    options?.tradingViewShortcut?.id
    || options?.searchSurfaceContract?.id
    || ''
  ).trim().toLowerCase();

  // Live TradingView validation showed Ctrl+E opening Pine Editor only when
  // delivered through SendKeys; the broader SendInput path was a no-op there.
  return shortcutId === 'open-pine-editor' && normalizedCombo === 'ctrl+e';
}

function shouldUseSendInputForKeyCombo(keyCombo, options = {}) {
  if (process.platform !== 'win32') return false;

  const parts = normalizeKeyComboParts(keyCombo);
  if (!parts.length) return false;

  const hasWinKey = parts.includes('win') || parts.includes('windows') || parts.includes('super');
  if (hasWinKey) return true;

  const hasAlt = parts.includes('alt');
  const hasCtrl = parts.includes('ctrl') || parts.includes('control');
  const hasShift = parts.includes('shift');
  const isEnterOnly = parts.length === 1 && ['enter', 'return'].includes(parts[0]);
  const hasTradingViewShortcutContext = !!(
    options?.tradingViewShortcut
    || options?.searchSurfaceContract
  );

  if (hasTradingViewShortcutContext && shouldPreferSendKeysForTradingViewShortcut(keyCombo, options)) {
    return false;
  }

  if (!hasAlt && !isEnterOnly && !(hasTradingViewShortcutContext && (hasCtrl || hasShift))) {
    return false;
  }
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

function getInspectServiceSafe() {
  try {
    return require('./inspect-service');
  } catch {
    return null;
  }
}

function isClickLikeActionType(type) {
  return type === ACTION_TYPES.CLICK
    || type === ACTION_TYPES.DOUBLE_CLICK
    || type === ACTION_TYPES.RIGHT_CLICK
    || type === ACTION_TYPES.MOVE_MOUSE;
}

function toFinitePoint(x, y) {
  const pointX = Number(x);
  const pointY = Number(y);
  if (!Number.isFinite(pointX) || !Number.isFinite(pointY)) {
    return null;
  }

  return {
    x: Math.round(pointX),
    y: Math.round(pointY)
  };
}

function buildProofId() {
  return `proof-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildExecutionProof({ originalAction, effectiveAction, resolvedTarget, success, errorMessage, errorCode }) {
  const requestedTargetId = originalAction?.targetId || effectiveAction?.targetId || null;
  const targetGrounded = !!resolvedTarget
    && !!resolvedTarget.targetId
    && resolvedTarget.coordinateFallback !== true
    && resolvedTarget.resolutionMethod !== 'explicit-coordinates';

  const checks = [];
  const limitations = [];

  if (requestedTargetId) {
    if (targetGrounded) {
      checks.push({
        kind: 'target-resolution',
        status: 'pass',
        targetId: resolvedTarget.targetId,
        method: resolvedTarget.resolutionMethod
      });
    } else if (resolvedTarget?.coordinateFallback) {
      checks.push({
        kind: 'target-resolution',
        status: success ? 'bounded' : 'fail',
        targetId: requestedTargetId,
        method: resolvedTarget.resolutionMethod || 'explicit-coordinates',
        fallbackReason: resolvedTarget.fallbackReason || null
      });
      limitations.push('Execution used explicit coordinate fallback instead of a verified inspect target.');
    } else {
      checks.push({
        kind: 'target-resolution',
        status: 'fail',
        targetId: requestedTargetId,
        code: errorCode || 'TARGET_RESOLUTION_FAILED'
      });
      limitations.push('Inspect target grounding did not succeed.');
    }
  } else {
    limitations.push('No inspect target grounding was requested for this action.');
  }

  if (resolvedTarget?.stale) {
    limitations.push('The inspect snapshot was stale at execution time.');
  }

  return {
    proofId: buildProofId(),
    actionType: String(effectiveAction?.type || originalAction?.type || 'unknown'),
    level: targetGrounded ? 1 : 0,
    levelName: targetGrounded ? 'target-grounded' : 'executed',
    status: success ? (targetGrounded ? 'verified' : 'bounded') : 'failed',
    checks,
    limitations,
    error: errorMessage || null,
    errorCode: errorCode || null
  };
}

async function resolveActionTarget(action, runtimeOptions = {}) {
  if (!action || typeof action !== 'object') {
    return { success: true, action };
  }

  const type = String(action.type || '').trim().toLowerCase();
  if (!isClickLikeActionType(type) || !action.targetId) {
    return { success: true, action };
  }

  const inspectService = runtimeOptions.inspectService || getInspectServiceSafe();
  const fallbackPoint = toFinitePoint(action.x, action.y);

  if (!inspectService || typeof inspectService.resolveTarget !== 'function') {
    if (action.allowCoordinateFallback === true && fallbackPoint) {
      return {
        success: true,
        action: { ...action, x: fallbackPoint.x, y: fallbackPoint.y },
        resolvedTarget: {
          targetId: action.targetId,
          resolutionMethod: 'explicit-coordinates',
          resolvedPoint: fallbackPoint,
          resolvedBounds: null,
          runtimeId: null,
          clickPoint: null,
          window: null,
          regionConfidence: null,
          observedAt: null,
          freshnessMs: null,
          stale: true,
          coordinateFallback: true,
          fallbackReason: 'TARGET_RESOLUTION_UNAVAILABLE'
        }
      };
    }

    return {
      success: false,
      code: 'TARGET_RESOLUTION_UNAVAILABLE',
      error: `Inspect target resolution is unavailable for targetId "${action.targetId}".`
    };
  }

  const resolution = await Promise.resolve(inspectService.resolveTarget(action.targetId, {
    maxAgeMs: Number.isFinite(Number(action.targetMaxAgeMs)) ? Number(action.targetMaxAgeMs) : 3000,
    allowStale: action.allowStaleTarget === true,
    fallbackX: action.x,
    fallbackY: action.y,
    allowCoordinateFallback: action.allowCoordinateFallback === true
  }));

  if (!resolution || !resolution.success) {
    return {
      success: false,
      code: resolution?.code || 'TARGET_RESOLUTION_FAILED',
      error: resolution?.error || `Failed to resolve inspect target "${action.targetId}".`,
      resolvedTarget: resolution?.resolvedTarget || null
    };
  }

  const resolvedPoint = toFinitePoint(
    resolution?.resolvedTarget?.resolvedPoint?.x,
    resolution?.resolvedTarget?.resolvedPoint?.y
  );

  if (!resolvedPoint) {
    return {
      success: false,
      code: 'TARGET_RESOLUTION_INVALID_POINT',
      error: `Inspect target "${action.targetId}" resolved without a valid point.`,
      resolvedTarget: resolution?.resolvedTarget || null
    };
  }

  return {
    success: true,
    action: {
      ...action,
      x: resolvedPoint.x,
      y: resolvedPoint.y
    },
    resolvedTarget: resolution.resolvedTarget || null
  };
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

function extractPineEditorSafeAuthoringSurfaceState(probe = null) {
  const matchedBy = String(probe?.matchedBy || probe?.rendererProof?.matchedBy || '').trim() || null;
  const rawVisibleAnchorEntries = Array.isArray(probe?.visibleAnchorEntries) && probe.visibleAnchorEntries.length > 0
    ? probe.visibleAnchorEntries
    : (Array.isArray(probe?.rendererProof?.signals) && probe.rendererProof.signals.length > 0
      ? probe.rendererProof.signals
      : synthesizeTradingViewPineVisibleAnchorEntriesFromTexts(
          Array.isArray(probe?.visibleAnchors) ? probe.visibleAnchors : [],
          matchedBy
        ));
  const visibleAnchorEntries = summarizeTradingViewPineVisibleAnchorEntries(
    rawVisibleAnchorEntries,
    matchedBy
  );
  const summary = {
    active: probe?.active === true || probe?.rendererProof?.active === true || visibleAnchorEntries.length > 0,
    matchedBy,
    visibleAnchors: visibleAnchorEntries
      .map((entry) => normalizeCompactText(entry?.text || entry?.observedText || '', 180))
      .filter(Boolean)
      .slice(0, 4),
    starterVisible: false,
    renameSurfaceVisible: false,
    saveTitleVisible: false,
    saveConfirmedVisible: false,
    actionableSurfaceVisible: false,
    saveRequiredVisible: false,
    saveConfirmationVisible: false,
    saveReplaceConfirmationVisible: false
  };
  let saveRequiredAnchorVisible = false;
  let saveRequiredStrongVisible = false;
  let saveRequiredDialogLikeVisible = false;

  for (const entry of visibleAnchorEntries) {
    const entryText = normalizeCompactText(entry?.text || '', 180);
    const observedText = normalizeCompactText(
      [entry?.text || '', entry?.observedText || '', entry?.ariaLabel || ''].filter(Boolean).join('\n'),
      220
    );
    const entryMetadata = normalizeCompactText(
      [entry?.source || '', entry?.className || '', entry?.role || '', entry?.scanId || ''].filter(Boolean).join('\n'),
      220
    );
    const category = normalizeTradingViewPineAnchorText(entry?.category || '');
    const starterLike = /^(untitled(?: script)?|my script|my strategy|my library)$/i.test(entryText)
      || /^(untitled(?: script)?|my script|my strategy|my library)$/i.test(normalizeCompactText(entry?.observedText || '', 180));

    if (!summary.starterVisible && (category === 'starter' || starterLike)) {
      summary.starterVisible = true;
    }

    if (!summary.saveTitleVisible && category === 'save-title') {
      summary.saveTitleVisible = isTradingViewPineSaveTitleProofCandidate({
        name: entry?.text || '',
        value: entry?.observedText || '',
        source: entry?.source || '',
        scanId: entry?.scanId || '',
        controlType: entry?.role || '',
        className: entry?.className || '',
        ariaLabel: entry?.ariaLabel || ''
      });
    }

    if (!summary.renameSurfaceVisible && category === 'rename-surface') {
      summary.renameSurfaceVisible = true;
      saveRequiredAnchorVisible = true;
      saveRequiredStrongVisible = true;
    }

    if (!summary.saveConfirmedVisible && (category === 'save-confirmed' || /\b(all changes saved|saved successfully|save complete)\b/i.test(observedText))) {
      summary.saveConfirmedVisible = true;
    }

    if (
      category === 'save-required'
      || /\b(save script|new script name|script name|save as|rename script|unsaved)\b/i.test(observedText)
    ) {
      saveRequiredAnchorVisible = true;
      if (hasStrongTradingViewPineSaveRequiredText(observedText)) {
        saveRequiredStrongVisible = true;
      }
      if (/\b(dialog|modal)\b/i.test(entryMetadata)) {
        saveRequiredDialogLikeVisible = true;
      }
    }

    if (
      !summary.saveConfirmationVisible
      && (
        /\byou have unsaved changes\b/i.test(observedText)
        || /\bwould you like to save them\b/i.test(observedText)
      )
    ) {
      summary.saveConfirmationVisible = true;
    }

    if (
      !summary.saveReplaceConfirmationVisible
      && (
        /\balready exists\b/i.test(observedText)
        || /\breplace it\b/i.test(observedText)
        || /\breally want to replace it\b/i.test(observedText)
      )
    ) {
      summary.saveReplaceConfirmationVisible = true;
    }

    if (
      !summary.actionableSurfaceVisible
      && category === 'surface'
      && /\b(publish script|add to chart|update on chart)\b/i.test(observedText)
    ) {
      summary.actionableSurfaceVisible = true;
    }
  }

  const aggregateObservedText = normalizeCompactText(
    visibleAnchorEntries
      .map((entry) => [entry?.text || '', entry?.observedText || '', entry?.ariaLabel || ''].filter(Boolean).join('\n'))
      .filter(Boolean)
      .join('\n'),
    2400
  );
  if (!saveRequiredStrongVisible && hasStrongTradingViewPineSaveRequiredText(aggregateObservedText)) {
    saveRequiredStrongVisible = true;
  }
  if (!summary.saveConfirmationVisible && (/\byou have unsaved changes\b/i.test(aggregateObservedText) || /\bwould you like to save them\b/i.test(aggregateObservedText))) {
    summary.saveConfirmationVisible = true;
  }
  if (!summary.saveReplaceConfirmationVisible && (/\balready exists\b/i.test(aggregateObservedText) || /\breplace it\b/i.test(aggregateObservedText) || /\breally want to replace it\b/i.test(aggregateObservedText))) {
    summary.saveReplaceConfirmationVisible = true;
  }
  summary.saveRequiredVisible = saveRequiredStrongVisible
    || (
      saveRequiredAnchorVisible
      && saveRequiredDialogLikeVisible
      && !summary.saveConfirmedVisible
    );

  summary.genericSavedSurfaceVisible = summary.active
    && summary.saveConfirmedVisible
    && summary.actionableSurfaceVisible
    && !summary.starterVisible;

  return summary;
}

function buildPineEditorSafeAuthoringSummary(text, options = {}) {
  const rawText = String(text || '').replace(/\r/g, '');
  const compactText = normalizeCompactText(rawText, 2400);
  if (!compactText) return null;
  const surfaceState = extractPineEditorSafeAuthoringSurfaceState(options?.pineEditorSurfaceProbe || null);

  const visibleLines = rawText
    .split('\n')
    .map((line) => String(line || '').trim())
    .filter(Boolean);
  const defaultStarterLabelVisible = visibleLines.some((line) =>
    /^(untitled(?: script)?|my script|my strategy|my library)$/i.test(String(line || '').trim())
  );

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
  if (defaultStarterLabelVisible) addSignal(visibleSignals, 'starter-default-name');
  if (surfaceState.starterVisible) addSignal(visibleSignals, 'starter-default-name');
  if (declarationName && /^(my script|my strategy|my library|untitled(?: script)?)$/i.test(declarationName)) {
    addSignal(visibleSignals, 'starter-default-name');
  }
  if (/\bplot\s*\(\s*close\s*\)/i.test(rawText)) addSignal(visibleSignals, 'starter-plot-close');
  if (/\b(input|plot|plotshape|plotchar|hline|bgcolor|fill|alertcondition|strategy\.)\s*\(/i.test(rawText)) {
    addSignal(visibleSignals, 'script-body-visible');
  }
  if (
    defaultStarterLabelVisible
    || surfaceState.starterVisible
    || /\b(start writing|write your script|new script|empty editor|untitled script)\b/i.test(compactText)
  ) {
    addSignal(visibleSignals, 'editor-empty-hint');
  }
  const saveConfirmationVisible = surfaceState.saveConfirmationVisible
    || /\byou have unsaved changes\b/i.test(compactText)
    || /\bwould you like to save them\b/i.test(compactText);
  const saveReplaceConfirmationVisible = surfaceState.saveReplaceConfirmationVisible
    || /\balready exists\b/i.test(compactText)
    || /\breplace it\b/i.test(compactText)
    || /\breally want to replace it\b/i.test(compactText);
  const saveRequiredSurfaceVisible = surfaceState.saveRequiredVisible
    || hasStrongTradingViewPineSaveRequiredText(compactText);
  if (saveConfirmationVisible) addSignal(visibleSignals, 'save-confirmation-modal');
  if (saveReplaceConfirmationVisible) addSignal(visibleSignals, 'save-replace-confirmation-modal');
  if (saveRequiredSurfaceVisible) addSignal(visibleSignals, 'save-required-visible');
  if (surfaceState.renameSurfaceVisible) addSignal(visibleSignals, 'save-rename-surface-visible');
  const targetCorruptionVisible = /\bscript could not be translated from\b/i.test(compactText)
    || (/\|[a-z]\|/i.test(rawText) && /\bpine editor\b/i.test(compactText));
  if (targetCorruptionVisible) addSignal(visibleSignals, 'editor-target-corrupt');
  if (surfaceState.saveTitleVisible) addSignal(visibleSignals, 'save-title-surface');
  if (surfaceState.genericSavedSurfaceVisible) addSignal(visibleSignals, 'existing-script-saved-surface');

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
  if (saveReplaceConfirmationVisible) {
    editorVisibleState = 'replace-confirmation-blocking';
  } else if (saveConfirmationVisible) {
    editorVisibleState = 'confirmation-blocking';
  } else if (saveRequiredSurfaceVisible) {
    editorVisibleState = 'save-required-blocking';
  } else if (targetCorruptionVisible) {
    editorVisibleState = 'unknown-visible-state';
  } else if (visibleSignals.includes('editor-empty-hint') || starterLike || surfaceState.starterVisible) {
    editorVisibleState = 'empty-or-starter';
  } else if (
    surfaceState.saveTitleVisible
    || surfaceState.genericSavedSurfaceVisible
    || (
      visibleScriptKind !== 'unknown'
      && (
        meaningfulLines.length > 0
        || visibleLines.length >= 5
        || visibleSignals.includes('script-body-visible')
      )
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
  const lifecycleState = saveReplaceConfirmationVisible
    ? 'save-replace-confirmation-blocking'
    : saveConfirmationVisible
    ? 'save-confirmation-blocking'
    : saveRequiredSurfaceVisible
    ? 'save-required-before-apply'
    : targetCorruptionVisible
    ? 'editor-target-corrupt'
    : editorVisibleState === 'empty-or-starter'
      ? 'new-script-required'
      : null;

  return {
    evidenceMode: 'safe-authoring-inspect',
    editorVisibleState,
    visibleScriptKind,
    visibleLineCountEstimate,
    visibleSignals: visibleSignals.slice(0, 8),
    surfaceMatchedBy: surfaceState.matchedBy,
    surfaceVisibleAnchors: surfaceState.visibleAnchors,
    lifecycleState,
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

function looksLikePineScriptPayloadText(value = '') {
  const compact = normalizeCompactText(value, 400) || '';
  if (!compact) return false;
  return /\/\/\s*@version\s*=\s*\d+\b|\b(?:indicator|strategy|library)\s*\(|\bplot(?:shape|char)?\s*\(|\binput(?:\.[a-z]+)?\s*\(|\balertcondition\s*\(/i.test(compact);
}

function buildPineEditorDiagnosticsStructuredSummary(text, evidenceMode = 'generic-status', options = {}) {
  const rawText = String(text || '').replace(/\r/g, '');
  const compactText = normalizeCompactText(rawText, 2400);
  if (!compactText) return null;
  const surfaceState = extractPineEditorSafeAuthoringSurfaceState(options?.pineEditorSurfaceProbe || null);
  const visibleLines = rawText
    .split('\n')
    .map((line) => normalizeCompactText(line, 220))
    .filter(Boolean);
  const expectedScriptName = normalizeCompactText(
    options?.pineExpectedScriptName || options?.expectedScriptName || options?.scriptName || '',
    180
  );
  const normalizedExpectedScriptName = normalizeTradingViewPineAnchorText(expectedScriptName);
  const expectedScriptNameVisible = expectedScriptName
    ? compactText.toLowerCase().includes(expectedScriptName.toLowerCase())
    : false;
  const expectedScriptNameLineVisible = normalizedExpectedScriptName
    ? visibleLines.some((line) =>
        normalizeTradingViewPineAnchorText(line) === normalizedExpectedScriptName
        && !looksLikePineScriptPayloadText(line)
      )
    : false;
  const expectedScriptNameProbe = extractTradingViewPineExpectedTitleProof(
    options?.pineEditorSurfaceProbe || null,
    expectedScriptName
  );
  const expectedScriptNameProofVisible = expectedScriptNameProbe.visible === true || expectedScriptNameLineVisible;
  const expectedScriptNameEvidence = expectedScriptNameProbe.visible === true
    ? expectedScriptNameProbe.source || 'surface-anchor'
    : (expectedScriptNameLineVisible ? 'line-text' : null);

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
  const targetCorruptionVisible = /\bscript could not be translated from\b/i.test(compactText)
    || (/\|[a-z]\|/i.test(rawText) && /\bpine editor\b/i.test(compactText));
  const saveConfirmationBlockingVisible = surfaceState.saveConfirmationVisible
    || /\byou have unsaved changes\b/i.test(compactText)
    || /\bwould you like to save them\b/i.test(compactText);
  const saveReplaceConfirmationVisible = surfaceState.saveReplaceConfirmationVisible
    || /\balready exists\b/i.test(compactText)
    || /\breally want to replace it\b/i.test(compactText);
  const renameSurfaceVisible = surfaceState.renameSurfaceVisible === true;
  const saveConfirmedVisible = surfaceState.saveConfirmedVisible
    || /\b(saved(?: successfully)?|script saved|all changes saved|saved version|save complete)\b/i.test(compactText);
  const saveActionVisible = surfaceState.saveRequiredVisible
    || renameSurfaceVisible
    || /\bsave script\b/i.test(compactText);
  const saveRequiredVisible = surfaceState.saveRequiredVisible
    || renameSurfaceVisible
    || hasStrongTradingViewPineSaveRequiredText(compactText);
  const strongSavedTitleProofVisible = evidenceMode === 'save-status'
    && saveConfirmedVisible
    && expectedScriptNameProofVisible
    && expectedScriptNameEvidence !== 'window-host-scan';

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
  if (targetCorruptionVisible) {
    compileStatus = 'errors-visible';
    addSignal(statusSignals, 'compile-errors-visible');
    addSignal(statusSignals, 'editor-target-corrupt');
  } else if (errorCountEstimate > 0) {
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
  if (saveConfirmationBlockingVisible) addSignal(statusSignals, 'save-confirmation-modal');
  if (saveReplaceConfirmationVisible) addSignal(statusSignals, 'save-replace-confirmation-modal');
  if (saveConfirmedVisible) addSignal(statusSignals, 'save-confirmed-visible');
  if (saveActionVisible) addSignal(statusSignals, 'save-action-visible');
  if (saveRequiredVisible) addSignal(statusSignals, 'save-required-visible');
  if (renameSurfaceVisible) addSignal(statusSignals, 'save-rename-surface-visible');
  if (expectedScriptName) addSignal(statusSignals, 'save-title-expected');
  if (expectedScriptNameProofVisible) addSignal(statusSignals, 'save-title-visible');
  if (strongSavedTitleProofVisible) addSignal(statusSignals, 'save-title-confirmed-visible');
  if (expectedScriptNameVisible && !expectedScriptNameProofVisible && evidenceMode === 'save-status' && !renameSurfaceVisible) {
    addSignal(statusSignals, 'save-title-text-visible-unverified');
  }
  if (expectedScriptName && !expectedScriptNameProofVisible && evidenceMode === 'save-status' && !renameSurfaceVisible) {
    addSignal(statusSignals, 'save-title-unverified');
  }
  if (evidenceMode === 'diagnostics') addSignal(statusSignals, 'diagnostics-request');
  if (evidenceMode === 'compile-result') addSignal(statusSignals, 'compile-result-request');
  if (evidenceMode === 'line-budget') addSignal(statusSignals, 'line-budget-request');
  if (evidenceMode === 'save-status') addSignal(statusSignals, 'save-status-request');
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
    lineBudgetSignal !== 'unknown-line-budget' ? `budget=${lineBudgetSignal}` : null,
    evidenceMode === 'save-status' && expectedScriptName
      ? `title=${expectedScriptNameProofVisible ? 'verified' : (renameSurfaceVisible ? 'rename-surface' : (expectedScriptNameVisible ? 'text-only' : 'missing'))}`
      : null
  ].filter(Boolean).join(' | ');
  const lifecycleState = targetCorruptionVisible
    ? 'editor-target-corrupt'
    : evidenceMode === 'save-status'
      ? (
        saveConfirmationBlockingVisible
          ? 'save-confirmation-blocking'
          : saveReplaceConfirmationVisible
          ? 'save-replace-confirmation-blocking'
          : strongSavedTitleProofVisible
          ? 'saved-state-verified'
          : saveRequiredVisible
          ? 'save-required-before-apply'
          : expectedScriptName
            ? (
              saveConfirmedVisible && expectedScriptNameProofVisible
                ? 'saved-state-verified'
                : (saveConfirmedVisible ? 'save-title-unverified' : 'unknown-save-state')
            )
            : (saveConfirmedVisible ? 'saved-state-verified' : 'unknown-save-state')
      )
      : (compileStatus === 'success' || compileStatus === 'errors-visible' || compileStatus === 'status-only'
        ? 'apply-result-verified'
        : null);

  return {
    evidenceMode,
    compileStatus,
    errorCountEstimate,
    warningCountEstimate,
    visibleLineCountEstimate,
    lineBudgetSignal,
    expectedScriptName: expectedScriptName || null,
    expectedScriptNameVisible,
    expectedScriptNameLineVisible,
    expectedScriptNameProofVisible,
    expectedScriptNameEvidence,
    renameSurfaceVisible,
    saveConfirmationBlockingVisible,
    saveReplaceConfirmationVisible,
    saveActionVisible,
    saveRequiredVisible,
    saveConfirmedVisible,
    statusSignals: statusSignals.slice(0, 8),
    topVisibleDiagnostics,
    lifecycleState,
    compactSummary: compactSummary || null
  };
}

function buildPineEditorFallbackCandidates(evidenceMode = 'generic-status', options = {}) {
  const normalizedMode = String(evidenceMode || 'generic-status').trim().toLowerCase();
  const baseCandidates = [
    { text: 'Pine Editor', synthetic: false, category: 'probe' }
  ];
  const expectedScriptName = normalizeCompactText(
    options?.pineExpectedScriptName || options?.expectedScriptName || options?.scriptName || '',
    180
  );

  const safeAuthoringCandidates = [
    { text: 'Untitled script', synthetic: true, category: 'starter' },
    { text: 'My Script', synthetic: true, category: 'starter' },
    { text: 'My Strategy', synthetic: true, category: 'starter' },
    { text: 'My Library', synthetic: true, category: 'starter' },
    { text: 'Publish script', synthetic: true, category: 'surface' },
    { text: 'Add to chart', synthetic: true, category: 'surface' },
    { text: 'Update on chart', synthetic: true, category: 'surface' },
    { text: 'Strategy Tester', synthetic: true, category: 'surface' },
    { text: 'Pine Logs', synthetic: true, category: 'surface' }
  ];

  const saveStatusCandidates = [
    ...(expectedScriptName ? [{ text: expectedScriptName, synthetic: true, category: 'save-title' }] : []),
    { text: 'Save script', synthetic: true, category: 'save-required' },
    { text: 'New script name', synthetic: true, category: 'save-required' },
    { text: 'Script name', synthetic: true, category: 'save-required' },
    { text: 'Save as', synthetic: true, category: 'save-required' },
    { text: 'Rename script', synthetic: true, category: 'save-required' },
    { text: 'Unsaved', synthetic: true, category: 'save-required' },
    { text: 'Confirmation', synthetic: true, category: 'confirmation-modal' },
    { text: 'You have unsaved changes', synthetic: true, category: 'confirmation-modal' },
    { text: 'Would you like to save them', synthetic: true, category: 'confirmation-modal' },
    { text: 'already exists', synthetic: true, category: 'confirmation-modal' },
    { text: 'replace it', synthetic: true, category: 'confirmation-modal' },
    { text: 'All changes saved', synthetic: true, category: 'save-confirmed' },
    { text: 'Saved successfully', synthetic: true, category: 'save-confirmed' },
    { text: 'Save complete', synthetic: true, category: 'save-confirmed' }
  ];

  if (normalizedMode === 'safe-authoring-inspect') {
    return [...baseCandidates, ...safeAuthoringCandidates, ...saveStatusCandidates];
  }

  if (normalizedMode === 'save-status') {
    return [...baseCandidates, ...saveStatusCandidates, ...safeAuthoringCandidates];
  }

  return baseCandidates;
}

const TRADINGVIEW_PINE_EDITOR_SURFACE_HOST_ANCHORS = Object.freeze([
  { text: 'Pine Editor', exact: false, priority: 224, category: 'surface' },
  { text: 'Untitled script', exact: false, priority: 220, category: 'starter' },
  { text: 'My Script', exact: false, priority: 210, category: 'starter' },
  { text: 'My Strategy', exact: false, priority: 205, category: 'starter' },
  { text: 'My Library', exact: false, priority: 200, category: 'starter' },
  { text: 'Save script', exact: false, priority: 190, category: 'save-required' },
  { text: 'New script name', exact: false, priority: 189, category: 'save-required' },
  { text: 'Script name', exact: false, priority: 188, category: 'save-required' },
  { text: 'Save as', exact: false, priority: 186, category: 'save-required' },
  { text: 'Rename script', exact: false, priority: 184, category: 'save-required' },
  { text: 'Confirmation', exact: false, priority: 183, category: 'confirmation-modal' },
  { text: 'You have unsaved changes', exact: false, priority: 182, category: 'confirmation-modal' },
  { text: 'Would you like to save them', exact: false, priority: 181, category: 'confirmation-modal' },
  { text: 'already exists', exact: false, priority: 180, category: 'confirmation-modal' },
  { text: 'replace it', exact: false, priority: 179, category: 'confirmation-modal' },
  { text: 'All changes saved', exact: false, priority: 182, category: 'save-confirmed' },
  { text: 'Saved successfully', exact: false, priority: 180, category: 'save-confirmed' },
  { text: 'Save complete', exact: false, priority: 178, category: 'save-confirmed' },
  { text: 'Add to chart', exact: true, priority: 170, category: 'surface' },
  { text: 'Update on chart', exact: true, priority: 168, category: 'surface' },
  { text: 'Publish script', exact: false, priority: 166, category: 'surface' },
  { text: 'Pine Logs', exact: false, priority: 162, category: 'surface' },
  { text: 'Strategy Tester', exact: false, priority: 160, category: 'surface' }
]);

const TRADINGVIEW_PINE_EDITOR_RENDERER_PROOF_ANCHORS = Object.freeze(
  TRADINGVIEW_PINE_EDITOR_SURFACE_HOST_ANCHORS.filter((anchor) =>
    !['Pine Editor', 'Pine Logs', 'Strategy Tester'].includes(anchor?.text)
  )
);

function escapeRegexForUIASearch(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TRADINGVIEW_PINE_EDITOR_SURFACE_HOST_REGEX = buildTradingViewPineSurfaceHostRegex();

const TRADINGVIEW_PINE_EDITOR_DIAGNOSTIC_HOST_REGEX = [
  'pine',
  'editor',
  'script',
  'publish',
  'save',
  'untitled',
  'tester',
  'logs',
  'source'
]
  .map((term) => escapeRegexForUIASearch(term))
  .sort((left, right) => right.length - left.length)
  .join('|');

const DEFAULT_TRADINGVIEW_PINE_ACTIVATION_PROOF_TIMEOUT_MS = 1000;
const MIN_TRADINGVIEW_PINE_ACTIVATION_PROOF_TIMEOUT_MS = 350;
const DEFAULT_TRADINGVIEW_PINE_RENDERER_PROOF_TIMEOUT_MS = 700;
const MIN_TRADINGVIEW_PINE_RENDERER_PROOF_TIMEOUT_MS = 240;
const MIN_TRADINGVIEW_PINE_RENDERER_DISCOVERY_TIMEOUT_MS = 650;
const DEFAULT_TRADINGVIEW_PINE_EDITOR_CDP_TIMEOUT_MS = 1200;
const MIN_TRADINGVIEW_PINE_EDITOR_CDP_TIMEOUT_MS = 300;
const DEFAULT_TRADINGVIEW_PINE_EDITOR_CDP_PREVIEW_LIMIT = 320;

function normalizeBoundsRect(bounds = null) {
  if (!bounds || typeof bounds !== 'object') return null;

  const rawX = bounds.x ?? bounds.X ?? bounds.left ?? bounds.Left;
  const rawY = bounds.y ?? bounds.Y ?? bounds.top ?? bounds.Top;
  const rawWidth = bounds.width ?? bounds.Width;
  const rawHeight = bounds.height ?? bounds.Height;
  const rawRight = bounds.right ?? bounds.Right;
  const rawBottom = bounds.bottom ?? bounds.Bottom;

  const x = Number(rawX);
  const y = Number(rawY);
  let width = Number(rawWidth);
  let height = Number(rawHeight);

  if (!Number.isFinite(width) && Number.isFinite(Number(rawRight)) && Number.isFinite(x)) {
    width = Number(rawRight) - x;
  }
  if (!Number.isFinite(height) && Number.isFinite(Number(rawBottom)) && Number.isFinite(y)) {
    height = Number(rawBottom) - y;
  }

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  if (width <= 0 || height <= 0) return null;

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height)
  };
}

function buildTradingViewPineSurfaceScanBounds(windowInfo = {}) {
  const bounds = normalizeBoundsRect(windowInfo?.bounds || windowInfo?.Bounds || null);
  if (!bounds || bounds.width < 320 || bounds.height < 240) {
    return [];
  }

  const insetX = Math.max(20, Math.round(bounds.width * 0.02));
  const insetBottom = Math.max(12, Math.round(bounds.height * 0.03));
  const buildBounds = (id, topRatio, minTopOffset) => {
    const topOffset = Math.max(Math.round(Number(minTopOffset) || 0), Math.round(bounds.height * topRatio));
    const height = Math.max(120, bounds.height - topOffset - insetBottom);
    return {
      id,
      bounds: {
        x: bounds.x + insetX,
        y: bounds.y + topOffset,
        width: Math.max(120, bounds.width - (insetX * 2)),
        height
      }
    };
  };
  const buildBandBounds = (id, topRatio, minTopOffset, heightRatio, minHeight, maxHeight) => {
    const topOffset = Math.max(Math.round(Number(minTopOffset) || 0), Math.round(bounds.height * topRatio));
    const availableHeight = Math.max(72, bounds.height - topOffset - insetBottom);
    const requestedHeight = Math.max(
      Math.round(Number(minHeight) || 0),
      Math.round(bounds.height * Number(heightRatio || 0))
    );
    const cappedHeight = Number.isFinite(Number(maxHeight)) && Number(maxHeight) > 0
      ? Math.min(requestedHeight, Math.round(Number(maxHeight)))
      : requestedHeight;
    const height = Math.max(72, Math.min(availableHeight, cappedHeight));
    return {
      id,
      bounds: {
        x: bounds.x + insetX,
        y: bounds.y + topOffset,
        width: Math.max(120, bounds.width - (insetX * 2)),
        height
      }
    };
  };

  const candidates = [
    buildBandBounds('panel-header-band', 0.4, 82, 0.16, 96, 180),
    buildBounds('panel-header-and-body', 0.42, 90),
    buildBounds('panel-body', 0.56, 120)
  ];
  const seen = new Set();
  return candidates.filter((entry) => {
    const rect = normalizeBoundsRect(entry?.bounds || null);
    if (!rect) return false;
    const dedupeKey = `${rect.x}|${rect.y}|${rect.width}|${rect.height}`;
    if (seen.has(dedupeKey)) return false;
    seen.add(dedupeKey);
    return true;
  });
}

function buildTradingViewPineSurfaceDiagnosticBounds(windowInfo = {}) {
  const bounds = normalizeBoundsRect(windowInfo?.bounds || windowInfo?.Bounds || null);
  if (!bounds || bounds.width < 320 || bounds.height < 240) {
    return [];
  }

  const insetX = Math.max(16, Math.round(bounds.width * 0.02));
  const insetTop = Math.max(28, Math.round(bounds.height * 0.04));
  const insetBottom = Math.max(12, Math.round(bounds.height * 0.03));
  const candidates = [
    {
      id: 'modal-center',
      bounds: {
        x: bounds.x + Math.max(insetX, Math.round(bounds.width * 0.18)),
        y: bounds.y + Math.max(insetTop, Math.round(bounds.height * 0.18)),
        width: Math.max(180, Math.round(bounds.width * 0.64)),
        height: Math.max(180, Math.round(bounds.height * 0.56))
      }
    },
    {
      id: 'right-workspace',
      bounds: {
        x: bounds.x + Math.max(insetX, Math.round(bounds.width * 0.58)),
        y: bounds.y + Math.max(insetTop, Math.round(bounds.height * 0.12)),
        width: Math.max(140, Math.round(bounds.width * 0.36) - insetX),
        height: Math.max(180, Math.round(bounds.height * 0.76))
      }
    },
    {
      id: 'full-window-content',
      bounds: {
        x: bounds.x + insetX,
        y: bounds.y + insetTop,
        width: Math.max(180, bounds.width - (insetX * 2)),
        height: Math.max(180, bounds.height - insetTop - insetBottom)
      }
    }
  ];

  const seen = new Set();
  return candidates.filter((entry) => {
    const rect = normalizeBoundsRect(entry?.bounds || null);
    if (!rect) return false;
    const dedupeKey = `${rect.x}|${rect.y}|${rect.width}|${rect.height}`;
    if (seen.has(dedupeKey)) return false;
    seen.add(dedupeKey);
    entry.bounds = rect;
    return true;
  });
}

function normalizeTradingViewPineAnchorText(value = '') {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isLikelyTradingViewChartChromeNoise(value = '') {
  const compact = normalizeCompactText(value, 240);
  if (!compact) return true;

  return /^[A-Z0-9.\-]{1,24}\s*[▲▼]/.test(compact)
    || /\s[▲▼]\s*\d+(?:\.\d+)?\b/.test(compact)
    || /\b[+-]?\d+(?:\.\d+)?%\b/.test(compact)
    || /\b(?:open|high|low|close|vol)\s*[:=]?\s*[+-]?\d+(?:\.\d+)?\b/i.test(compact)
    || /\/\s*unnamed\b/i.test(compact)
    || /\bunnamed\b/i.test(compact);
}

function buildTradingViewPineSurfaceHostAnchors(options = {}) {
  const anchors = TRADINGVIEW_PINE_EDITOR_SURFACE_HOST_ANCHORS.map((anchor) => ({ ...anchor }));
  const expectedScriptName = normalizeCompactText(
    options?.pineExpectedScriptName || options?.expectedScriptName || options?.scriptName || '',
    180
  );
  const normalizedExpected = normalizeTradingViewPineAnchorText(expectedScriptName);
  if (normalizedExpected && !anchors.some((anchor) =>
    normalizeTradingViewPineAnchorText(anchor?.text || '') === normalizedExpected
  )) {
    anchors.unshift({
      text: expectedScriptName,
      exact: false,
      priority: 214,
      category: 'save-title'
    });
  }
  return anchors;
}

function buildTradingViewPineSurfaceHostRegex(options = {}) {
  return buildTradingViewPineSurfaceHostAnchors(options)
    .map((anchor) => escapeRegexForUIASearch(anchor.text))
    .sort((left, right) => right.length - left.length)
    .join('|');
}

function isTradingViewPineSaveTitleProofCandidate({
  name = '',
  value = '',
  description = '',
  source = '',
  scanId = '',
  controlType = '',
  className = '',
  ariaLabel = ''
} = {}) {
  return classifyTradingViewPineExpectedTitleSurface({
    name,
    value,
    description,
    source,
    scanId,
    controlType,
    className,
    ariaLabel
  }) === 'save-title';
}

function classifyTradingViewPineExpectedTitleSurface({
  name = '',
  value = '',
  description = '',
  source = '',
  scanId = '',
  controlType = '',
  className = '',
  ariaLabel = ''
} = {}) {
  const candidateText = [name, value, description, ariaLabel].filter(Boolean).join('\n');
  if (looksLikePineScriptPayloadText(candidateText)) {
    return 'reject';
  }

  if (isLikelyTradingViewChartChromeNoise(candidateText)) {
    return 'reject';
  }

  const sourceNorm = normalizeTradingViewPineAnchorText(source);
  if (sourceNorm === 'body-innertext') {
    return 'reject';
  }

  const scanNorm = normalizeTradingViewPineAnchorText(scanId);
  const controlNorm = normalizeTradingViewPineAnchorText(controlType);
  const classNorm = normalizeTradingViewPineAnchorText(className);
  const nameNorm = normalizeTradingViewPineAnchorText(name);
  const valueNorm = normalizeTradingViewPineAnchorText(value);
  const metadataNorm = normalizeTradingViewPineAnchorText([
    source,
    scanId,
    controlType,
    className,
    description,
    ariaLabel
  ].filter(Boolean).join(' '));
  const modalLike = /\b(modal|dialog)\b/.test(metadataNorm)
    || /modal-center/.test(scanNorm)
    || /\b(save script|new script name|script name|save as|rename script)\b/.test(metadataNorm);
  const editLike = /\b(edit|combobox)\b/.test(controlNorm);
  const valueBacked = !!valueNorm && (!nameNorm || nameNorm !== valueNorm);

  if (modalLike && (editLike || valueBacked || scanNorm.includes('modal'))) {
    return 'rename-surface';
  }

  if (editLike || (valueBacked && scanNorm)) {
    return scanNorm.includes('header') ? 'rename-surface' : 'reject';
  }

  if (scanNorm && !/(header|modal)/.test(scanNorm)) {
    return 'reject';
  }

  if (classNorm.includes('chrome_renderwidgethosthwnd') && !scanNorm) {
    return 'reject';
  }

  if (modalLike) {
    return 'rename-surface';
  }

  return 'save-title';
}

function isTradingViewPineRenameSurfaceCandidate({
  name = '',
  value = '',
  description = '',
  source = '',
  scanId = '',
  controlType = '',
  className = '',
  ariaLabel = ''
} = {}) {
  return classifyTradingViewPineExpectedTitleSurface({
    name,
    value,
    description,
    source,
    scanId,
    controlType,
    className,
    ariaLabel
  }) === 'rename-surface';
}

function summarizeTradingViewPineVisibleAnchorEntries(entries = [], fallbackSource = null) {
  const summaries = [];
  const seen = new Set();

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;

    const text = normalizeCompactText(
      entry?.text || entry?.element?.Name || entry?.element?.name || '',
      220
    );
    const observedText = normalizeCompactText(
      entry?.observedText
      || entry?.element?.Name
      || entry?.element?.Value
      || entry?.element?.Description
      || text
      || '',
      220
    );
    if (!text && !observedText) continue;

    const summary = {
      text: text || observedText || null,
      observedText: observedText || text || null,
      category: normalizeCompactText(entry?.category || '', 60) || null,
      source: normalizeCompactText(
        entry?.source
        || entry?.element?.LikuPineProbeSource
        || fallbackSource
        || '',
        80
      ) || null,
      scanId: normalizeCompactText(
        entry?.scanId
        || entry?.element?.LikuPineProbeScanId
        || '',
        80
      ) || null,
      role: normalizeCompactText(
        entry?.role
        || entry?.controlType
        || entry?.element?.ControlType
        || '',
        80
      ) || null,
      className: normalizeCompactText(
        entry?.className
        || entry?.title
        || entry?.element?.ClassName
        || '',
        120
      ) || null,
      ariaLabel: normalizeCompactText(entry?.ariaLabel || '', 180) || null,
      surfaceKind: normalizeCompactText(
        entry?.surfaceKind
        || entry?.expectedTitleSurfaceKind
        || '',
        40
      ) || null,
      priority: Number(entry?.priority || 0) || 0
    };

    const dedupeKey = [
      normalizeTradingViewPineAnchorText(summary.category || ''),
      normalizeTradingViewPineAnchorText(summary.text || ''),
      normalizeTradingViewPineAnchorText(summary.source || ''),
      normalizeTradingViewPineAnchorText(summary.scanId || '')
    ].join('|');
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    summaries.push(summary);
  }

  return summaries
    .sort((left, right) => {
      if ((right.priority || 0) !== (left.priority || 0)) {
        return (right.priority || 0) - (left.priority || 0);
      }
      return String(left.text || '').localeCompare(String(right.text || ''));
    })
    .slice(0, 8);
}

function synthesizeTradingViewPineVisibleAnchorEntriesFromTexts(anchorTexts = [], fallbackSource = null) {
  const inferredEntries = [];
  const knownAnchors = buildTradingViewPineSurfaceHostAnchors();
  const seen = new Set();

  for (const anchorText of Array.isArray(anchorTexts) ? anchorTexts : []) {
    const normalizedText = normalizeCompactText(anchorText, 220);
    const normalizedHaystack = normalizeTradingViewPineAnchorText(normalizedText);
    if (!normalizedHaystack) continue;

    const matchedAnchor = knownAnchors.find((anchor) => {
      const knownText = normalizeTradingViewPineAnchorText(anchor?.text || '');
      if (!knownText) return false;
      return anchor?.exact ? normalizedHaystack === knownText : normalizedHaystack.includes(knownText);
    }) || null;

    const dedupeKey = [
      normalizeTradingViewPineAnchorText(matchedAnchor?.category || ''),
      normalizeTradingViewPineAnchorText(matchedAnchor?.text || normalizedText)
    ].join('|');
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    inferredEntries.push({
      text: matchedAnchor?.text || normalizedText,
      observedText: normalizedText,
      category: matchedAnchor?.category || null,
      source: fallbackSource || 'synthetic-visible-anchor',
      priority: Number(matchedAnchor?.priority || 0) || 0
    });
  }

  return summarizeTradingViewPineVisibleAnchorEntries(inferredEntries, fallbackSource);
}

function hasStrongTradingViewPineSaveRequiredText(value = '') {
  const compactText = normalizeCompactText(value, 2400) || '';
  if (!compactText) return false;

  if (/\b(new script name|script name|save as|rename script|save your script|name your script|unsaved)\b/i.test(compactText)) {
    return true;
  }

  return /\bsave script\b/i.test(compactText) && /\bcancel\b/i.test(compactText);
}

function extractTradingViewPineExpectedTitleProof(probe = null, expectedScriptName = '') {
  const normalizedExpected = normalizeTradingViewPineAnchorText(expectedScriptName);
  if (!normalizedExpected) {
    return {
      visible: false,
      source: null,
      matchedBy: null,
      scanId: null,
      surfaceKind: null,
      text: null
    };
  }

  const entries = summarizeTradingViewPineVisibleAnchorEntries(
    Array.isArray(probe?.visibleAnchorEntries) && probe.visibleAnchorEntries.length > 0
      ? probe.visibleAnchorEntries
      : (Array.isArray(probe?.rendererProof?.signals) ? probe.rendererProof.signals : []),
    probe?.matchedBy || probe?.rendererProof?.matchedBy || null
  );

  for (const entry of entries) {
    if (normalizeTradingViewPineAnchorText(entry?.category || '') !== 'save-title') {
      continue;
    }

    const haystack = normalizeTradingViewPineAnchorText([
      entry?.text || '',
      entry?.observedText || ''
    ].join(' '));
    if (!haystack.includes(normalizedExpected)) {
      continue;
    }

    if (!isTradingViewPineSaveTitleProofCandidate({
      name: entry?.text || '',
      value: entry?.observedText || '',
      source: entry?.source || '',
      scanId: entry?.scanId || '',
      controlType: entry?.role || '',
      className: entry?.className || '',
      ariaLabel: entry?.ariaLabel || ''
    })) {
      continue;
    }

    return {
      visible: true,
      source: entry?.source || null,
      matchedBy: String(probe?.matchedBy || probe?.rendererProof?.matchedBy || '').trim() || null,
      scanId: entry?.scanId || null,
      surfaceKind: entry?.surfaceKind || 'save-title',
      text: entry?.text || entry?.observedText || expectedScriptName
    };
  }

  return {
    visible: false,
    source: null,
    matchedBy: String(probe?.matchedBy || probe?.rendererProof?.matchedBy || '').trim() || null,
    scanId: null,
    surfaceKind: null,
    text: null
  };
}

function collectTradingViewPineEditorHostAnchors(elements = [], options = {}) {
  const anchors = buildTradingViewPineSurfaceHostAnchors(options);
  const matches = [];
  const seen = new Set();

  for (const element of Array.isArray(elements) ? elements : []) {
    if (!element || typeof element !== 'object') continue;

    const name = normalizeCompactText(element?.Name || element?.name || '', 160) || '';
    const value = normalizeCompactText(element?.Value || element?.value || '', 160) || '';
    const description = normalizeCompactText(element?.Description || element?.description || '', 160) || '';
    const defaultAction = normalizeCompactText(element?.DefaultAction || element?.defaultAction || '', 120) || '';
    const legacyRole = normalizeCompactText(element?.LegacyRole || element?.legacyRole || '', 120) || '';
    const automationId = normalizeCompactText(element?.AutomationId || element?.automationId || '', 120) || '';
    const className = normalizeCompactText(element?.ClassName || element?.className || '', 120) || '';
    const controlType = normalizeCompactText(element?.ControlType || element?.controlType || '', 120) || '';
    const probeSource = normalizeCompactText(element?.LikuPineProbeSource || '', 80) || '';
    const probeScanId = normalizeCompactText(element?.LikuPineProbeScanId || '', 80) || '';
    const exactHaystack = normalizeTradingViewPineAnchorText(name || value || description);
    const containsHaystack = normalizeTradingViewPineAnchorText([
      name,
      value,
      description,
      defaultAction,
      legacyRole,
      automationId,
      className,
      controlType
    ].join(' '));
    if (!exactHaystack && !containsHaystack) continue;

    for (const anchor of anchors) {
      const anchorText = normalizeTradingViewPineAnchorText(anchor.text);
      let category = anchor.category;
      let surfaceKind = null;
      const matched = anchor.exact
        ? exactHaystack === anchorText
        : containsHaystack.includes(anchorText);
      if (!matched) continue;

      if (anchor.category === 'save-title') {
        surfaceKind = classifyTradingViewPineExpectedTitleSurface({
          name,
          value,
          description,
          source: probeSource,
          scanId: probeScanId,
          controlType,
          className
        });
        if (surfaceKind === 'reject') {
          continue;
        }
        if (surfaceKind === 'rename-surface') {
          category = 'rename-surface';
        }
      }

      const displayText = name || value || description || anchor.text;
      const dedupeKey = `${category}:${normalizeTradingViewPineAnchorText(displayText)}`;
      if (seen.has(dedupeKey)) break;
      seen.add(dedupeKey);
      matches.push({
        text: displayText,
        element,
        category,
        priority: anchor.priority,
        source: probeSource || null,
        scanId: probeScanId || null,
        surfaceKind: surfaceKind || null
      });
      break;
    }
  }

  return matches.sort((left, right) => {
    if (right.priority !== left.priority) {
      return right.priority - left.priority;
    }
    return String(left.text || '').localeCompare(String(right.text || ''));
  });
}

function isTradingViewPineTitleOnlyAnchorSet(entries = []) {
  const anchors = Array.isArray(entries) ? entries : [];
  if (anchors.length === 0) return false;
  return anchors.every((entry) => {
    const category = normalizeTradingViewPineAnchorText(entry?.category || '');
    return category === 'save-title' || category === 'rename-surface';
  });
}

function mergeTradingViewPineAnchorMatches(...collections) {
  const merged = [];
  const seen = new Set();

  for (const collection of collections) {
    for (const entry of Array.isArray(collection) ? collection : []) {
      if (!entry || typeof entry !== 'object') continue;
      const dedupeKey = [
        normalizeTradingViewPineAnchorText(entry?.category || ''),
        normalizeTradingViewPineAnchorText(entry?.text || ''),
        normalizeTradingViewPineAnchorText(entry?.source || ''),
        normalizeTradingViewPineAnchorText(entry?.scanId || ''),
        normalizeTradingViewPineAnchorText(entry?.surfaceKind || '')
      ].join('|');
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      merged.push(entry);
    }
  }

  return merged.sort((left, right) => {
    if ((right?.priority || 0) !== (left?.priority || 0)) {
      return (right?.priority || 0) - (left?.priority || 0);
    }
    return String(left?.text || '').localeCompare(String(right?.text || ''));
  });
}

function buildTradingViewPineRendererTargetTokens(title = '') {
  const ignoredTokens = new Set([
    'tradingview',
    'unnamed',
    'chart',
    'desktop',
    'beta',
    'stable'
  ]);
  const seen = new Set();
  const tokens = [];

  for (const token of String(title || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((value) => value.trim())
    .filter(Boolean)) {
    if (token.length < 2 || ignoredTokens.has(token) || seen.has(token)) {
      continue;
    }
    seen.add(token);
    tokens.push(token);
    if (tokens.length >= 10) {
      break;
    }
  }

  return tokens;
}

function pickTradingViewPineAnchorSignals(entries = [], anchors = TRADINGVIEW_PINE_EDITOR_RENDERER_PROOF_ANCHORS) {
  const matches = [];
  const seen = new Set();

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;

    const primaryText = normalizeCompactText(entry?.text || entry?.name || entry?.label || '', 200) || '';
    const valueText = normalizeCompactText(entry?.value || '', 180) || '';
    const descriptionText = normalizeCompactText(entry?.description || '', 180) || '';
    const sourceText = normalizeCompactText(entry?.source || '', 80) || '';
    const roleText = normalizeCompactText(entry?.role || '', 80) || '';
    const titleText = normalizeCompactText(entry?.title || '', 160) || '';
    const ariaLabelText = normalizeCompactText(entry?.ariaLabel || '', 160) || '';
    const scanIdText = normalizeCompactText(entry?.scanId || entry?.probeScanId || '', 80) || '';
    const exactHaystack = normalizeTradingViewPineAnchorText(primaryText || valueText || descriptionText);
    const containsHaystack = normalizeTradingViewPineAnchorText([
      primaryText,
      valueText,
      descriptionText,
      sourceText,
      roleText,
      titleText,
      ariaLabelText
    ].join(' '));
    if (!exactHaystack && !containsHaystack) continue;

    for (const anchor of anchors) {
      const anchorText = normalizeTradingViewPineAnchorText(anchor?.text || '');
      let category = anchor.category;
      let surfaceKind = null;
      if (!anchorText) continue;

      const matched = anchor.exact
        ? exactHaystack === anchorText
        : containsHaystack.includes(anchorText);
      if (!matched) continue;

      if (anchor.category === 'save-title') {
        surfaceKind = classifyTradingViewPineExpectedTitleSurface({
          name: primaryText,
          value: valueText,
          description: descriptionText,
          source: sourceText,
          scanId: scanIdText,
          controlType: roleText,
          className: titleText,
          ariaLabel: ariaLabelText
        });
        if (surfaceKind === 'reject') {
          continue;
        }
        if (surfaceKind === 'rename-surface') {
          category = 'rename-surface';
        }
      }

      const signalText = String(anchor.text || '').trim();
      const dedupeKey = `${category}:${anchorText}`;
      if (seen.has(dedupeKey)) {
        break;
      }
      seen.add(dedupeKey);
      matches.push({
        text: signalText,
        observedText: primaryText || valueText || descriptionText || signalText,
        source: sourceText || null,
        role: roleText || null,
        title: titleText || null,
        ariaLabel: ariaLabelText || null,
        category,
        surfaceKind: surfaceKind || null,
        priority: Number(anchor.priority || 0) || 0
      });
      break;
    }
  }

  return matches.sort((left, right) => {
    if (right.priority !== left.priority) {
      return right.priority - left.priority;
    }
    return String(left.text || '').localeCompare(String(right.text || ''));
  });
}

function buildTradingViewPineRendererProofAnchors(options = {}) {
  const anchors = TRADINGVIEW_PINE_EDITOR_RENDERER_PROOF_ANCHORS.map((anchor) => ({ ...anchor }));
  const expectedScriptName = normalizeCompactText(
    options?.pineExpectedScriptName || options?.expectedScriptName || options?.scriptName || '',
    180
  );
  const normalizedExpected = normalizeTradingViewPineAnchorText(expectedScriptName);
  if (normalizedExpected && !anchors.some((anchor) =>
    normalizeTradingViewPineAnchorText(anchor?.text || '') === normalizedExpected
  )) {
    anchors.unshift({
      text: expectedScriptName,
      exact: false,
      priority: 214,
      category: 'save-title'
    });
  }
  return anchors;
}

function buildTradingViewPineRendererDomProbeExpression(anchors = TRADINGVIEW_PINE_EDITOR_RENDERER_PROOF_ANCHORS) {
  return `(() => {
    const anchors = ${JSON.stringify(anchors)};
    const maxNodes = 1600;
    const maxSignals = 24;
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const compact = (value, maxLength = 180) => {
      const text = String(value || '').replace(/\\s+/g, ' ').trim();
      return text ? text.slice(0, maxLength) : '';
    };
    const isVisible = (element) => {
      if (!element || typeof element.getBoundingClientRect !== 'function') return false;
      const rect = element.getBoundingClientRect();
      if (!rect || rect.width <= 2 || rect.height <= 2) return false;
      if (typeof window.getComputedStyle === 'function') {
        const style = window.getComputedStyle(element);
        if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) {
          return false;
        }
      }
      return true;
    };
    const signals = [];
    const seen = new Set();
    const pushSignal = (candidate) => {
      if (!candidate || signals.length >= maxSignals) return;
      const primaryText = compact(candidate.primary || candidate.text || '', 220);
      const valueText = compact(candidate.value || '', 180);
      const descriptionText = compact(candidate.description || '', 180);
      const exactHaystack = normalize(primaryText || valueText || descriptionText);
      const containsHaystack = normalize([
        primaryText,
        valueText,
        descriptionText,
        compact(candidate.source || '', 80),
        compact(candidate.role || '', 80),
        compact(candidate.ariaLabel || '', 180),
        compact(candidate.title || '', 180)
      ].join(' '));
      if (!exactHaystack && !containsHaystack) return;

      for (const anchor of anchors) {
        const anchorText = normalize(anchor && anchor.text ? anchor.text : '');
        if (!anchorText) continue;
        const matched = anchor.exact ? exactHaystack === anchorText : containsHaystack.includes(anchorText);
        if (!matched) continue;
        const dedupeKey = String(anchor.category || 'surface') + ':' + anchorText;
        if (seen.has(dedupeKey)) {
          return;
        }
        seen.add(dedupeKey);
        signals.push({
          text: String(anchor.text || '').trim(),
          observedText: primaryText || valueText || descriptionText || String(anchor.text || '').trim(),
          source: compact(candidate.source || '', 80),
          role: compact(candidate.role || '', 80),
          ariaLabel: compact(candidate.ariaLabel || '', 180),
          title: compact(candidate.title || '', 180),
          priority: Number(anchor.priority || 0) || 0
        });
        return;
      }
    };

    const bodyText = compact(document && document.body && document.body.innerText ? document.body.innerText : '', 6000);
    if (bodyText) {
      pushSignal({
        primary: bodyText,
        source: 'body-innertext'
      });
    }

    const queue = [];
    const seenNodes = new Set();
    if (document && document.body) {
      queue.push(document.body);
      seenNodes.add(document.body);
    }

    let scannedNodes = 0;
    while (queue.length > 0 && scannedNodes < maxNodes && signals.length < maxSignals) {
      const current = queue.shift();
      if (!current) continue;

      const childElements = current.children
        ? Array.from(current.children)
        : Array.from(current.childNodes || []).filter((node) => node && node.nodeType === 1);
      for (const child of childElements) {
        if (!child || seenNodes.has(child)) continue;
        seenNodes.add(child);
        queue.push(child);
        if (child.shadowRoot && !seenNodes.has(child.shadowRoot)) {
          seenNodes.add(child.shadowRoot);
          queue.push(child.shadowRoot);
        }

        scannedNodes += 1;
        if (!isVisible(child)) {
          if (scannedNodes >= maxNodes) break;
          continue;
        }

        pushSignal({
          primary: compact(child.innerText || child.textContent || '', 220),
          value: compact(child.value || (child.getAttribute ? child.getAttribute('value') : '') || '', 180),
          description: compact(
            (child.getAttribute ? child.getAttribute('aria-description') : '')
            || (child.getAttribute ? child.getAttribute('aria-roledescription') : '')
            || '',
            180
          ),
          source: 'dom-node',
          role: compact((child.getAttribute ? child.getAttribute('role') : '') || '', 80),
          ariaLabel: compact((child.getAttribute ? child.getAttribute('aria-label') : '') || '', 180),
          title: compact(
            (child.getAttribute ? child.getAttribute('title') : '')
            || (child.getAttribute ? child.getAttribute('data-name') : '')
            || (child.getAttribute ? child.getAttribute('placeholder') : '')
            || '',
            180
          )
        });

        if (scannedNodes >= maxNodes || signals.length >= maxSignals) {
          break;
        }
      }
    }

    signals.sort((left, right) => {
      if ((right.priority || 0) !== (left.priority || 0)) {
        return (right.priority || 0) - (left.priority || 0);
      }
      return String(left.text || '').localeCompare(String(right.text || ''));
    });

    return {
      matched: signals.length > 0,
      matchedBy: signals.length > 0 ? 'chromium-cdp-dom' : null,
      anchorText: signals.length > 0 ? signals[0].text : null,
      signals: signals.slice(0, 12),
      scannedNodes,
      usedBodyInnerText: !!bodyText
    };
  })()`;
}

function extractTradingViewPineRendererAxSignals(nodes = [], anchors = TRADINGVIEW_PINE_EDITOR_RENDERER_PROOF_ANCHORS) {
  const candidates = [];

  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || typeof node !== 'object') continue;

    candidates.push({
      text: normalizeCompactText(node?.name?.value || '', 200) || '',
      value: normalizeCompactText(node?.value?.value || '', 180) || '',
      description: normalizeCompactText(node?.description?.value || '', 180) || '',
      role: normalizeCompactText(node?.role?.value || node?.chromeRole?.value || '', 120) || '',
      source: 'ax-node'
    });
  }

  return pickTradingViewPineAnchorSignals(candidates, anchors);
}

function normalizeTradingViewRendererMatchText(value = '', maxLength = 240) {
  const compact = normalizeCompactText(value || '', maxLength);
  return compact ? compact.toLowerCase() : '';
}

function collectTradingViewRendererNodeMatchEntries(node = {}) {
  return [
    node?.name?.value,
    node?.value?.value,
    node?.description?.value
  ]
    .map((value) => normalizeTradingViewRendererMatchText(value, 240))
    .filter(Boolean);
}

function matchTradingViewRendererRequiredTexts(nodes = [], normalizedRequiredTexts = []) {
  const requiredTexts = Array.isArray(normalizedRequiredTexts)
    ? normalizedRequiredTexts.filter(Boolean)
    : [];
  if (requiredTexts.length === 0) return [];

  return requiredTexts.filter((requiredText) => (Array.isArray(nodes) ? nodes : []).some((node) =>
    collectTradingViewRendererNodeMatchEntries(node).some((entry) => entry.includes(requiredText))
  ));
}

function findTradingViewRendererButtonNode(nodes = [], normalizedButtonText = '') {
  const targetButtonText = normalizeTradingViewRendererMatchText(normalizedButtonText, 180);
  if (!targetButtonText) return null;

  return (Array.isArray(nodes) ? nodes : []).find((node) => {
    const role = normalizeTradingViewRendererMatchText(node?.role?.value || node?.chromeRole?.value || '', 80);
    const name = normalizeTradingViewRendererMatchText(node?.name?.value || '', 180);
    return node?.ignored !== true
      && /button/.test(role)
      && name === targetButtonText;
  }) || null;
}

function describeTradingViewRendererInvokeSurface(kind = '') {
  switch ((normalizeCompactText(kind || '', 80) || '').toLowerCase()) {
    case 'unsaved-changes-confirmation':
      return 'TradingView unsaved-changes dialog';
    case 'replace-existing-script-confirmation':
      return 'TradingView replace-script dialog';
    case 'pine-first-save-confirmation':
      return 'TradingView Pine save-name dialog';
    default:
      return 'TradingView renderer dialog';
  }
}

function getTradingViewRendererSurfaceRequiredTexts(kind = '') {
  switch ((normalizeCompactText(kind || '', 80) || '').toLowerCase()) {
    case 'unsaved-changes-confirmation':
      return [
        'you have unsaved changes',
        'would you like to save them'
      ];
    case 'replace-existing-script-confirmation':
      return [
        'already exists',
        'replace it'
      ];
    case 'pine-first-save-confirmation':
      return [
        'save script',
        'new script name'
      ];
    default:
      return [];
  }
}

function getTradingViewRendererInvokeTransitionCandidates(kind = '', buttonText = '') {
  const normalizedKind = (normalizeCompactText(kind || '', 80) || '').toLowerCase();
  const normalizedButtonText = normalizeTradingViewRendererMatchText(buttonText, 120);
  if (normalizedKind === 'pine-first-save-confirmation' && normalizedButtonText === 'save') {
    return [
      'replace-existing-script-confirmation',
      'unsaved-changes-confirmation'
    ];
  }
  return [];
}

function detectTradingViewRendererVisibleSurface(nodes = [], kind = '') {
  const normalizedKind = (normalizeCompactText(kind || '', 80) || '').toLowerCase();
  const requiredTexts = getTradingViewRendererSurfaceRequiredTexts(normalizedKind);
  if (requiredTexts.length === 0) {
    return null;
  }

  const matchedRequiredTexts = matchTradingViewRendererRequiredTexts(nodes, requiredTexts);
  if (matchedRequiredTexts.length !== requiredTexts.length) {
    return null;
  }

  return {
    kind: normalizedKind,
    surface: describeTradingViewRendererInvokeSurface(normalizedKind),
    requiredTexts: requiredTexts.slice(0, 6),
    matchedRequiredTexts: matchedRequiredTexts.slice(0, 6)
  };
}

function shouldVerifyTradingViewRendererInvokeEffect(kind = '', normalizedRequiredTexts = []) {
  const normalizedKind = (normalizeCompactText(kind || '', 80) || '').toLowerCase();
  if (!Array.isArray(normalizedRequiredTexts) || normalizedRequiredTexts.filter(Boolean).length === 0) {
    return false;
  }

  return [
    'unsaved-changes-confirmation',
    'replace-existing-script-confirmation',
    'pine-first-save-confirmation'
  ].includes(normalizedKind);
}

async function probeTradingViewPineEditorRendererWithCDPSession(session, options = {}) {
  const rendererProofAnchors = buildTradingViewPineRendererProofAnchors(options);
  const axDepth = Number.isFinite(Number(options?.axDepth))
    ? Math.max(6, Math.min(Math.round(Number(options.axDepth)), 14))
    : 10;
  const domProbeResponse = await session.call('Runtime.evaluate', {
    expression: buildTradingViewPineRendererDomProbeExpression(rendererProofAnchors),
    returnByValue: true,
    awaitPromise: true
  });
  const domPayload = domProbeResponse?.result?.value || {};
  const domSignals = pickTradingViewPineAnchorSignals(domPayload?.signals || [], rendererProofAnchors);
  if (domSignals.length > 0) {
    return {
      available: true,
      active: true,
      matchedBy: 'chromium-cdp-dom',
      anchorText: domSignals[0].text,
      signals: domSignals,
      dom: {
        matched: true,
        scannedNodes: Number(domPayload?.scannedNodes || 0) || 0,
        usedBodyInnerText: domPayload?.usedBodyInnerText === true
      },
      ax: null
    };
  }

  let axSignals = [];
  let axError = null;
  try {
    await session.call('Accessibility.enable');
    const axTree = await session.call('Accessibility.getFullAXTree', {
      depth: axDepth
    });
    axSignals = extractTradingViewPineRendererAxSignals(axTree?.nodes || [], rendererProofAnchors);
  } catch (error) {
    axError = error?.message || String(error || 'Accessibility.getFullAXTree failed');
  }

  if (axSignals.length > 0) {
    return {
      available: true,
      active: true,
      matchedBy: 'chromium-cdp-ax',
      anchorText: axSignals[0].text,
      signals: axSignals,
      dom: {
        matched: false,
        scannedNodes: Number(domPayload?.scannedNodes || 0) || 0,
        usedBodyInnerText: domPayload?.usedBodyInnerText === true
      },
      ax: {
        matched: true,
        error: null
      }
    };
  }

  return {
    available: true,
    active: false,
    matchedBy: null,
    anchorText: null,
    reason: 'no-visible-pine-anchor',
    signals: [],
    dom: {
      matched: false,
      scannedNodes: Number(domPayload?.scannedNodes || 0) || 0,
      usedBodyInnerText: domPayload?.usedBodyInnerText === true
    },
    ax: {
      matched: false,
      error: axError
    }
  };
}

async function verifyTradingViewRendererInvokeEffectWithCDPSession(session, options = {}) {
  const requiredTexts = Array.from(new Set(
    (Array.isArray(options?.requiredTexts) ? options.requiredTexts : [options?.requiredTexts])
      .map((value) => normalizeTradingViewRendererMatchText(value || '', 220))
      .filter(Boolean)
  ));
  const kind = (normalizeCompactText(options?.kind || '', 80) || '').toLowerCase();
  if (!shouldVerifyTradingViewRendererInvokeEffect(kind, requiredTexts)) {
    return null;
  }

  const buttonText = normalizeCompactText(options?.buttonText || '', 120) || null;
  const pineExpectedScriptName = normalizeCompactText(
    options?.pineExpectedScriptName || options?.expectedScriptName || options?.scriptName || '',
    180
  );
  const capturePineSurfaceAfterClear = options?.capturePineSurfaceAfterClear !== false
    && [
      'unsaved-changes-confirmation',
      'replace-existing-script-confirmation',
      'pine-first-save-confirmation'
    ].includes(kind);
  const surface = describeTradingViewRendererInvokeSurface(kind);
  const transitionCandidateKinds = getTradingViewRendererInvokeTransitionCandidates(kind, buttonText);
  const timeoutMs = Number.isFinite(Number(options?.timeoutMs || options?.timeout))
    ? Math.max(180, Math.min(Math.round(Number(options.timeoutMs || options.timeout)), 900))
    : 520;
  const attemptDelaysMs = [60, 140, 220];
  const startedAt = Date.now();
  const attempts = [];
  let lastMatchedRequiredTexts = [];
  let lastNodeCount = 0;
  let lastError = null;
  let successfulReadCount = 0;

  for (let attemptIndex = 0; attemptIndex < attemptDelaysMs.length; attemptIndex += 1) {
    const elapsedBeforeWait = Date.now() - startedAt;
    const remainingBeforeWait = timeoutMs - elapsedBeforeWait;
    if (remainingBeforeWait <= 0 && attemptIndex > 0) {
      break;
    }

    const waitMs = Math.max(
      0,
      Math.min(
        attemptDelaysMs[attemptIndex],
        attemptIndex === 0 ? timeoutMs : remainingBeforeWait
      )
    );
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    try {
      const axTree = await session.call('Accessibility.getFullAXTree', {
        depth: 12
      });
      const nodes = Array.isArray(axTree?.nodes) ? axTree.nodes : [];
      const matchedRequiredTexts = matchTradingViewRendererRequiredTexts(nodes, requiredTexts);
      const matchedButtonNode = findTradingViewRendererButtonNode(nodes, buttonText || '');
      const transitionedSurface = transitionCandidateKinds
        .map((candidateKind) => detectTradingViewRendererVisibleSurface(nodes, candidateKind))
        .find(Boolean) || null;
      successfulReadCount += 1;
      lastNodeCount = nodes.length;
      lastMatchedRequiredTexts = matchedRequiredTexts;
      const exactDialogStillVisible = matchedRequiredTexts.length === requiredTexts.length;

      attempts.push({
        attempt: attemptIndex + 1,
        nodeCount: nodes.length,
        matchedRequiredTexts: matchedRequiredTexts.slice(0, 6),
        exactDialogStillVisible,
        buttonVisible: !!matchedButtonNode,
        transitionKind: transitionedSurface?.kind || null,
        transitionMatchedRequiredTexts: Array.isArray(transitionedSurface?.matchedRequiredTexts)
          ? transitionedSurface.matchedRequiredTexts.slice(0, 6)
          : []
      });

      if (transitionedSurface) {
        return {
          applicable: true,
          success: true,
          cleared: false,
          transitioned: true,
          transitionKind: transitionedSurface.kind,
          transitionSurface: transitionedSurface.surface,
          transitionRequiredTexts: transitionedSurface.requiredTexts.slice(0, 6),
          transitionMatchedRequiredTexts: transitionedSurface.matchedRequiredTexts.slice(0, 6),
          surface,
          kind,
          buttonText,
          requiredTexts: requiredTexts.slice(0, 6),
          remainingMatchedRequiredTexts: matchedRequiredTexts.slice(0, 6),
          attempts,
          lastNodeCount,
          startedAt,
          finishedAt: Date.now(),
          durationMs: Math.max(0, Date.now() - startedAt)
        };
      }

      if (!exactDialogStillVisible) {
        let postClickPineRendererProof = null;
        if (capturePineSurfaceAfterClear) {
          try {
            postClickPineRendererProof = await probeTradingViewPineEditorRendererWithCDPSession(session, {
              pineExpectedScriptName
            });
          } catch (error) {
            postClickPineRendererProof = {
              available: false,
              active: false,
              reason: 'renderer-post-click-surface-readback-failed',
              error: error?.message || String(error || 'TradingView renderer surface readback failed')
            };
          }
        }

        return {
          applicable: true,
          success: true,
          cleared: true,
          transitioned: false,
          surface,
          kind,
          buttonText,
          requiredTexts: requiredTexts.slice(0, 6),
          remainingMatchedRequiredTexts: matchedRequiredTexts.slice(0, 6),
          postClickPineRendererProof,
          attempts,
          lastNodeCount,
          startedAt,
          finishedAt: Date.now(),
          durationMs: Math.max(0, Date.now() - startedAt)
        };
      }
    } catch (error) {
      lastError = error;
      attempts.push({
        attempt: attemptIndex + 1,
        error: error?.message || String(error || 'TradingView renderer post-click AX recheck failed')
      });
    }
  }

  if (successfulReadCount === 0 && lastError) {
    return {
      applicable: true,
      success: false,
      cleared: false,
      surface,
      kind,
      buttonText,
      requiredTexts: requiredTexts.slice(0, 6),
      reason: 'renderer-post-click-readback-failed',
      error: `TradingView could not re-check the ${surface} after clicking ${JSON.stringify(buttonText || 'the target button')}.`,
      attempts,
      lastNodeCount,
      startedAt,
      finishedAt: Date.now(),
      durationMs: Math.max(0, Date.now() - startedAt),
      lastError: lastError?.message || String(lastError || '')
    };
  }

  return {
    applicable: true,
    success: false,
    cleared: false,
    surface,
    kind,
    buttonText,
    requiredTexts: requiredTexts.slice(0, 6),
    remainingMatchedRequiredTexts: lastMatchedRequiredTexts.slice(0, 6),
    reason: 'renderer-modal-still-visible',
    error: `TradingView still exposes the exact ${surface} after clicking ${JSON.stringify(buttonText || 'the target button')}.`,
    attempts,
    lastNodeCount,
    startedAt,
    finishedAt: Date.now(),
    durationMs: Math.max(0, Date.now() - startedAt)
  };
}

function summarizeTradingViewRendererAxNode(node = null) {
  if (!node || typeof node !== 'object') return null;

  return {
    nodeId: String(node?.nodeId || '').trim() || null,
    backendDOMNodeId: Number(node?.backendDOMNodeId || 0) || 0,
    name: normalizeCompactText(node?.name?.value || '', 160) || null,
    value: normalizeCompactText(node?.value?.value || '', 160) || null,
    description: normalizeCompactText(node?.description?.value || '', 180) || null,
    role: normalizeCompactText(node?.role?.value || node?.chromeRole?.value || '', 80) || null,
    ignored: node?.ignored === true
  };
}

function buildTradingViewRendererButtonInvokeFunctionDeclaration() {
  return `function() {
    const compact = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const text = compact(this.innerText || this.textContent || this.value || this.getAttribute?.('aria-label') || this.title || '');
    const ariaLabel = compact(this.getAttribute?.('aria-label') || '');
    const title = compact(this.getAttribute?.('title') || '');
    let rect = null;
    try {
      if (typeof this.getBoundingClientRect === 'function') {
        const rawRect = this.getBoundingClientRect();
        rect = rawRect ? {
          x: Number(rawRect.x || rawRect.left || 0) || 0,
          y: Number(rawRect.y || rawRect.top || 0) || 0,
          width: Number(rawRect.width || 0) || 0,
          height: Number(rawRect.height || 0) || 0
        } : null;
      }
    } catch {}

    try { this.scrollIntoView?.({ block: 'center', inline: 'center' }); } catch {}
    try { this.focus?.(); } catch {}
    try {
      const init = rect ? {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: rect.x + (rect.width / 2),
        clientY: rect.y + (rect.height / 2)
      } : { bubbles: true, cancelable: true, composed: true, view: window };
      this.dispatchEvent?.(new MouseEvent('pointerdown', init));
      this.dispatchEvent?.(new MouseEvent('mousedown', init));
      this.dispatchEvent?.(new MouseEvent('pointerup', init));
      this.dispatchEvent?.(new MouseEvent('mouseup', init));
    } catch {}
    if (typeof this.click === 'function') {
      this.click();
    }

    return {
      clicked: true,
      text,
      ariaLabel,
      title,
      tagName: String(this.tagName || '').trim() || null,
      rect
    };
  }`;
}

function buildTradingViewPineSurfaceProbeFromRendererInvoke(invokeResult = {}, options = {}) {
  const effectProof = invokeResult?.effectProof && typeof invokeResult.effectProof === 'object'
    ? invokeResult.effectProof
    : null;
  const postClickPineRendererProof = effectProof?.postClickPineRendererProof
    && typeof effectProof.postClickPineRendererProof === 'object'
    ? effectProof.postClickPineRendererProof
    : null;
  const transitionKind = (normalizeCompactText(effectProof?.transitionKind || '', 80) || '').toLowerCase();
  const windowHandle = Number(
    options?.windowHandle
    || options?.hwnd
    || invokeResult?.windowHandle
    || invokeResult?.foreground?.hwnd
    || invokeResult?.windowInfo?.hwnd
    || 0
  ) || 0;
  if (effectProof?.success === true && postClickPineRendererProof?.available === true && postClickPineRendererProof?.active === true) {
    const matchedBy = String(postClickPineRendererProof?.matchedBy || 'chromium-cdp-post-click-surface').trim() || 'chromium-cdp-post-click-surface';
    const visibleAnchorEntries = summarizeTradingViewPineVisibleAnchorEntries(
      Array.isArray(postClickPineRendererProof?.signals) ? postClickPineRendererProof.signals : [],
      matchedBy
    );
    const visibleAnchors = visibleAnchorEntries
      .map((entry) => entry.text)
      .filter(Boolean);
    if (visibleAnchors.length > 0) {
      return {
        active: true,
        matched: true,
        matchedBy,
        transitionKind: transitionKind || null,
        anchorText: visibleAnchors[0],
        visibleAnchors,
        visibleAnchorEntries,
        rendererProof: {
          ...postClickPineRendererProof,
          applicable: postClickPineRendererProof?.applicable !== false,
          available: true,
          active: true,
          matchedBy,
          anchorText: postClickPineRendererProof?.anchorText || visibleAnchors[0],
          signals: visibleAnchorEntries.map((entry) => ({ ...entry }))
        },
        element: {
          name: visibleAnchors[0],
          WindowHandle: windowHandle
        },
        windowHandle
      };
    }
  }
  if (!effectProof || effectProof.success !== true || effectProof.transitioned !== true || !transitionKind) {
    return null;
  }

  const matchedBy = 'chromium-cdp-ax-transition';
  const visibleAnchorEntries = [];
  const seen = new Set();
  const addEntry = (text = '', category = 'confirmation-modal', extra = {}) => {
    const normalizedText = normalizeCompactText(text, 180);
    if (!normalizedText) return;
    const dedupeKey = `${category}:${normalizeTradingViewPineAnchorText(normalizedText)}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    visibleAnchorEntries.push({
      text: normalizedText,
      observedText: normalizedText,
      category,
      source: 'renderer-transition',
      role: extra.role || null,
      title: extra.title || null,
      ariaLabel: extra.ariaLabel || null,
      className: extra.className || null,
      priority: Number(extra.priority || 0) || 0
    });
  };

  switch (transitionKind) {
    case 'replace-existing-script-confirmation':
      addEntry('Confirmation', 'confirmation-modal', {
        role: 'dialog',
        title: 'Confirmation',
        priority: 183
      });
      addEntry('already exists', 'confirmation-modal', {
        priority: 180
      });
      addEntry('replace it', 'confirmation-modal', {
        priority: 179
      });
      addEntry('No', 'confirmation-modal', {
        role: 'button',
        priority: 120
      });
      addEntry('Yes', 'confirmation-modal', {
        role: 'button',
        priority: 120
      });
      break;
    case 'unsaved-changes-confirmation':
      addEntry('Confirmation', 'confirmation-modal', {
        role: 'dialog',
        title: 'Confirmation',
        priority: 183
      });
      addEntry('You have unsaved changes', 'confirmation-modal', {
        priority: 182
      });
      addEntry('Would you like to save them', 'confirmation-modal', {
        priority: 181
      });
      addEntry('No', 'confirmation-modal', {
        role: 'button',
        priority: 120
      });
      addEntry('Yes', 'confirmation-modal', {
        role: 'button',
        priority: 120
      });
      break;
    default:
      return null;
  }

  for (const text of Array.isArray(effectProof?.transitionMatchedRequiredTexts)
    ? effectProof.transitionMatchedRequiredTexts
    : []) {
    addEntry(text, 'confirmation-modal', {
      priority: 178
    });
  }

  const visibleAnchors = visibleAnchorEntries
    .map((entry) => entry.text)
    .filter(Boolean);
  if (visibleAnchors.length === 0) {
    return null;
  }

  return {
    active: true,
    matched: true,
    matchedBy,
    transitionKind,
    anchorText: visibleAnchors[0],
    visibleAnchors,
    visibleAnchorEntries,
    rendererProof: {
      applicable: true,
      available: true,
      active: true,
      matchedBy,
      anchorText: visibleAnchors[0],
      signals: visibleAnchorEntries.map((entry) => ({ ...entry }))
    },
    element: {
      name: visibleAnchors[0],
      WindowHandle: windowHandle
    },
    windowHandle
  };
}

function summarizeTradingViewPineRendererProof(proof = null) {
  if (!proof || typeof proof !== 'object') return null;

  return {
    applicable: proof.applicable !== false,
    available: proof.available === true,
    active: proof.active === true,
    reason: normalizeCompactText(proof.reason || proof.error || '', 140),
    anchorText: normalizeCompactText(proof.anchorText || '', 120),
    matchedBy: normalizeCompactText(proof.matchedBy || '', 80),
    port: Number(proof.port || 0) || 0,
    target: proof.target && typeof proof.target === 'object'
      ? {
          id: String(proof.target.id || ''),
          type: normalizeCompactText(proof.target.type || '', 32),
          title: normalizeCompactText(proof.target.title || '', 140),
          url: normalizeCompactText(proof.target.url || '', 180)
        }
      : null,
    signals: Array.isArray(proof.signals)
      ? proof.signals.slice(0, 8).map((signal) => ({
          text: normalizeCompactText(signal?.text || '', 120),
          observedText: normalizeCompactText(signal?.observedText || '', 160),
          source: normalizeCompactText(signal?.source || '', 60),
          role: normalizeCompactText(signal?.role || '', 60)
        }))
      : [],
    endpointAttempts: Array.isArray(proof.endpointAttempts)
      ? proof.endpointAttempts.slice(0, 6).map((attempt) => ({
          port: Number(attempt?.port || 0) || 0,
          source: normalizeCompactText(attempt?.source || '', 40),
          error: normalizeCompactText(attempt?.error || '', 120)
        }))
      : [],
    discovery: proof.discovery && typeof proof.discovery === 'object'
      ? {
          explicitPort: Number(proof.discovery?.explicitPort || 0) || 0,
          cachedCandidateCount: Array.isArray(proof.discovery?.cachedCandidates)
            ? proof.discovery.cachedCandidates.length
            : 0,
          portCandidateCount: Array.isArray(proof.discovery?.portCandidates)
            ? proof.discovery.portCandidates.length
            : 0,
          processInspectionSuccess: proof.discovery?.processInspection?.success !== false,
          processInspectionError: normalizeCompactText(proof.discovery?.processInspection?.error || '', 160),
          processCount: Array.isArray(proof.discovery?.processInspection?.processes)
            ? proof.discovery.processInspection.processes.length
            : 0,
          listenerInspectionSuccess: proof.discovery?.listenerInspection?.success !== false,
          listenerInspectionError: normalizeCompactText(proof.discovery?.listenerInspection?.error || '', 160),
          listenerCount: Array.isArray(proof.discovery?.listenerInspection?.listeners)
            ? proof.discovery.listenerInspection.listeners.length
            : 0
        }
      : null
  };
}

async function probeTradingViewPineEditorRendererWithCDP(options = {}) {
  const explicitWindowHandle = Number(options?.windowHandle || options?.hwnd || 0) || 0;
  const resolveWindowState = options?.resolveWindowState !== false;
  const timeout = Number.isFinite(Number(options?.timeout || options?.timeoutMs))
    ? Math.max(
        MIN_TRADINGVIEW_PINE_RENDERER_PROOF_TIMEOUT_MS,
        Math.min(Math.round(Number(options.timeout || options.timeoutMs)), 2000)
      )
    : DEFAULT_TRADINGVIEW_PINE_RENDERER_PROOF_TIMEOUT_MS;
  const discoveryTimeoutMs = Math.max(
    MIN_TRADINGVIEW_PINE_RENDERER_DISCOVERY_TIMEOUT_MS,
    Math.min(1600, Math.round(timeout * 0.9))
  );
  const httpTimeoutMs = Math.max(
    220,
    Math.min(700, Math.round(discoveryTimeoutMs * 0.36))
  );
  const expectedScriptName = normalizeCompactText(
    options?.pineExpectedScriptName || options?.expectedScriptName || options?.scriptName || '',
    180
  );

  let windowInfo = options?.windowInfo && typeof options.windowInfo === 'object'
    ? options.windowInfo
    : null;
  let foreground = options?.foreground && typeof options.foreground === 'object'
    ? options.foreground
    : null;

  if (windowInfo && typeof windowInfo === 'object' && windowInfo.success === undefined) {
    windowInfo = { success: true, ...windowInfo };
  }
  if (foreground && typeof foreground === 'object' && foreground.success === undefined) {
    foreground = { success: true, ...foreground };
  }

  if (!windowInfo?.success && explicitWindowHandle > 0 && resolveWindowState) {
    try {
      const candidate = await getWindowInfoByHandle(explicitWindowHandle);
      if (candidate?.success) {
        windowInfo = candidate;
      }
    } catch {}
  }

  if (!foreground?.success && resolveWindowState) {
    try {
      foreground = await getForegroundWindowInfo();
    } catch {}
  }

  if (!windowInfo?.success && foreground?.success) {
    windowInfo = foreground;
  }

  if (!windowInfo?.success || !isTradingViewForegroundWindow(windowInfo)) {
    return {
      applicable: false,
      available: false,
      active: false,
      reason: 'window-not-tradingview',
      port: 0,
      target: null,
      signals: []
    };
  }

  const cdpDependencies = options?.cdpDependencies && typeof options.cdpDependencies === 'object'
    ? options.cdpDependencies
    : {};
  const discovery = await discoverChromiumRemoteDebuggingTarget({
    port: options?.cdpPort || 0,
    processIds: [windowInfo?.pid || windowInfo?.processId || 0],
    processNames: [
      windowInfo?.processName || '',
      'tradingview'
    ],
    title: String(windowInfo?.title || ''),
    titleTokens: buildTradingViewPineRendererTargetTokens(windowInfo?.title || ''),
    targetTypes: ['page', 'webview'],
    urlHints: ['tradingview', '/chart/'],
    timeoutMs: discoveryTimeoutMs,
    httpTimeoutMs,
    fetchImpl: cdpDependencies.fetchImpl,
    WebSocketCtor: cdpDependencies.WebSocketCtor,
    processInspector: cdpDependencies.processInspector,
    listeningPortInspector: cdpDependencies.listeningPortInspector,
    executePowerShellScript: cdpDependencies.executePowerShellScript
  });

  if (!discovery?.available) {
    return {
      applicable: discovery?.applicable !== false,
      available: false,
      active: false,
      reason: discovery?.reason || 'remote-debugging-port-not-configured',
      error: discovery?.error || null,
      port: Number(discovery?.port || 0) || 0,
      target: discovery?.target || null,
      targets: Array.isArray(discovery?.targets) ? discovery.targets : [],
      endpointAttempts: Array.isArray(discovery?.endpointAttempts) ? discovery.endpointAttempts : [],
      discovery: discovery?.discovery || null,
      signals: []
    };
  }

  try {
    const cdpResult = await withChromiumCdpSession(
      discovery.target,
      {
        WebSocketCtor: cdpDependencies.WebSocketCtor,
        openTimeoutMs: Math.max(140, Math.min(900, Math.round(timeout * 0.4))),
        callTimeoutMs: Math.max(140, Math.min(900, Math.round(timeout * 0.34)))
      },
      async (session) => probeTradingViewPineEditorRendererWithCDPSession(session, {
        pineExpectedScriptName: expectedScriptName
      })
    );

    return {
      applicable: true,
      available: true,
      active: cdpResult?.active === true,
      matchedBy: cdpResult?.matchedBy || null,
      anchorText: cdpResult?.anchorText || null,
      signals: Array.isArray(cdpResult?.signals) ? cdpResult.signals : [],
      port: Number(discovery?.port || 0) || 0,
      target: discovery?.target || null,
      targets: Array.isArray(discovery?.targets) ? discovery.targets : [],
      endpointAttempts: Array.isArray(discovery?.endpointAttempts) ? discovery.endpointAttempts : [],
      discovery: discovery?.discovery || null,
      dom: cdpResult?.dom || null,
      ax: cdpResult?.ax || null,
      reason: cdpResult?.reason || null
    };
  } catch (error) {
    return {
      applicable: true,
      available: false,
      active: false,
      reason: error?.reason || 'protocol-error',
      error: error?.message || String(error || 'CDP protocol session failed'),
      port: Number(discovery?.port || 0) || 0,
      target: discovery?.target || null,
      targets: Array.isArray(discovery?.targets) ? discovery.targets : [],
      endpointAttempts: Array.isArray(discovery?.endpointAttempts) ? discovery.endpointAttempts : [],
      discovery: discovery?.discovery || null,
      signals: []
    };
  }
}

async function invokeTradingViewRendererButtonWithCDP(options = {}) {
  const buttonText = normalizeCompactText(options?.buttonText || options?.text || '', 120);
  const requiredTexts = Array.from(new Set(
    (Array.isArray(options?.requiredTexts) ? options.requiredTexts : [options?.requiredTexts])
      .map((value) => normalizeCompactText(value || '', 180))
      .filter(Boolean)
  ));
  if (!buttonText) {
    return {
      applicable: false,
      available: false,
      success: false,
      reason: 'button-text-required',
      error: 'Renderer button invoke requires a non-empty buttonText.'
    };
  }

  const explicitWindowHandle = Number(options?.windowHandle || options?.hwnd || 0) || 0;
  const resolveWindowState = options?.resolveWindowState !== false;
  const timeout = Number.isFinite(Number(options?.timeout || options?.timeoutMs))
    ? Math.max(
        MIN_TRADINGVIEW_PINE_RENDERER_PROOF_TIMEOUT_MS,
        Math.min(Math.round(Number(options.timeout || options.timeoutMs)), 2000)
      )
    : DEFAULT_TRADINGVIEW_PINE_RENDERER_PROOF_TIMEOUT_MS;
  const discoveryTimeoutMs = Math.max(
    MIN_TRADINGVIEW_PINE_RENDERER_DISCOVERY_TIMEOUT_MS,
    Math.min(1600, Math.round(timeout * 0.9))
  );
  const httpTimeoutMs = Math.max(
    220,
    Math.min(700, Math.round(discoveryTimeoutMs * 0.36))
  );
  const invokeKind = (normalizeCompactText(options?.kind || '', 80) || '').toLowerCase();
  const pineExpectedScriptName = normalizeCompactText(
    options?.pineExpectedScriptName || options?.expectedScriptName || options?.scriptName || '',
    180
  );
  const effectProofBudgetMs = shouldVerifyTradingViewRendererInvokeEffect(
    invokeKind,
    requiredTexts.map((text) => normalizeTradingViewRendererMatchText(text, 220))
  )
    ? Math.max(220, Math.min(900, Math.round(timeout * 0.8)))
    : 0;

  let windowInfo = options?.windowInfo && typeof options.windowInfo === 'object'
    ? options.windowInfo
    : null;
  let foreground = options?.foreground && typeof options.foreground === 'object'
    ? options.foreground
    : null;

  if (windowInfo && typeof windowInfo === 'object' && windowInfo.success === undefined) {
    windowInfo = { success: true, ...windowInfo };
  }
  if (foreground && typeof foreground === 'object' && foreground.success === undefined) {
    foreground = { success: true, ...foreground };
  }

  if (!windowInfo?.success && explicitWindowHandle > 0 && resolveWindowState) {
    try {
      const candidate = await getWindowInfoByHandle(explicitWindowHandle);
      if (candidate?.success) {
        windowInfo = candidate;
      }
    } catch {}
  }

  if (!foreground?.success && resolveWindowState) {
    try {
      foreground = await getForegroundWindowInfo();
    } catch {}
  }

  if (!windowInfo?.success && foreground?.success) {
    windowInfo = foreground;
  }

  if (!windowInfo?.success || !isTradingViewForegroundWindow(windowInfo)) {
    return {
      applicable: false,
      available: false,
      success: false,
      reason: 'window-not-tradingview',
      error: 'Renderer button invoke is only available for the active TradingView window.'
    };
  }

  const cdpDependencies = options?.cdpDependencies && typeof options.cdpDependencies === 'object'
    ? options.cdpDependencies
    : {};
  const discovery = await discoverChromiumRemoteDebuggingTarget({
    port: options?.cdpPort || 0,
    processIds: [windowInfo?.pid || windowInfo?.processId || 0],
    processNames: [
      windowInfo?.processName || '',
      'tradingview'
    ],
    title: String(windowInfo?.title || ''),
    titleTokens: buildTradingViewPineRendererTargetTokens(windowInfo?.title || ''),
    targetTypes: ['page', 'webview'],
    urlHints: ['tradingview', '/chart/'],
    timeoutMs: discoveryTimeoutMs,
    httpTimeoutMs,
    fetchImpl: cdpDependencies.fetchImpl,
    WebSocketCtor: cdpDependencies.WebSocketCtor,
    processInspector: cdpDependencies.processInspector,
    listeningPortInspector: cdpDependencies.listeningPortInspector,
    executePowerShellScript: cdpDependencies.executePowerShellScript
  });

  if (!discovery?.available) {
    return {
      applicable: discovery?.applicable !== false,
      available: false,
      success: false,
      reason: discovery?.reason || 'remote-debugging-port-not-configured',
      error: discovery?.error || null,
      buttonText,
      requiredTexts,
      port: Number(discovery?.port || 0) || 0,
      target: discovery?.target || null,
      targets: Array.isArray(discovery?.targets) ? discovery.targets : [],
      endpointAttempts: Array.isArray(discovery?.endpointAttempts) ? discovery.endpointAttempts : [],
      discovery: discovery?.discovery || null
    };
  }

  try {
    const cdpResult = await withChromiumCdpSession(
      discovery.target,
      {
        WebSocketCtor: cdpDependencies.WebSocketCtor,
        openTimeoutMs: Math.max(
          180,
          Math.min(1800, Math.round(timeout * 0.45) + effectProofBudgetMs)
        ),
        callTimeoutMs: Math.max(160, Math.min(1000, Math.round(timeout * 0.4)))
      },
      async (session) => {
        await session.call('Accessibility.enable');
        const axTree = await session.call('Accessibility.getFullAXTree', {
          depth: 12
        });
        const nodes = Array.isArray(axTree?.nodes) ? axTree.nodes : [];
        const normalizedButtonText = normalizeTradingViewRendererMatchText(buttonText, 180);
        const normalizedRequiredTexts = requiredTexts.map((text) => normalizeTradingViewRendererMatchText(text, 220));
        const matchedRequiredTexts = matchTradingViewRendererRequiredTexts(nodes, normalizedRequiredTexts);

        if (normalizedRequiredTexts.length > 0 && matchedRequiredTexts.length !== normalizedRequiredTexts.length) {
          return {
            success: false,
            available: true,
            reason: 'renderer-required-text-missing',
            matchedRequiredTexts
          };
        }

        const buttonNode = findTradingViewRendererButtonNode(nodes, normalizedButtonText);

        if (!buttonNode) {
          return {
            success: false,
            available: true,
            reason: 'renderer-button-unavailable',
            matchedRequiredTexts
          };
        }

        const backendDOMNodeId = Number(buttonNode?.backendDOMNodeId || 0) || 0;
        if (!backendDOMNodeId) {
          return {
            success: false,
            available: true,
            reason: 'renderer-button-dom-node-missing',
            matchedRequiredTexts,
            axNode: summarizeTradingViewRendererAxNode(buttonNode)
          };
        }

        const resolvedNode = await session.call('DOM.resolveNode', {
          backendNodeId: backendDOMNodeId
        });
        const objectId = String(resolvedNode?.object?.objectId || '').trim();
        if (!objectId) {
          return {
            success: false,
            available: true,
            reason: 'renderer-button-resolve-failed',
            matchedRequiredTexts,
            axNode: summarizeTradingViewRendererAxNode(buttonNode)
          };
        }

        let clickPayload = null;
        try {
          const clickResponse = await session.call('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: buildTradingViewRendererButtonInvokeFunctionDeclaration(),
            returnByValue: true,
            awaitPromise: true
          });
          clickPayload = clickResponse?.result?.value || null;
        } finally {
          try {
            await session.call('Runtime.releaseObject', {
              objectId
            });
          } catch {}
        }

        const effectProof = clickPayload?.clicked === false
          ? null
          : await verifyTradingViewRendererInvokeEffectWithCDPSession(session, {
              kind: invokeKind,
              buttonText,
              requiredTexts,
              timeoutMs: Math.max(220, Math.min(900, Math.round(timeout * 0.8))),
              pineExpectedScriptName,
              capturePineSurfaceAfterClear: true
            });
        const effectVerified = !effectProof || effectProof.success === true;

        return {
          success: clickPayload?.clicked !== false && effectVerified,
          available: true,
          reason: clickPayload?.clicked === false
            ? 'renderer-button-click-failed'
            : (!effectVerified ? (effectProof?.reason || 'renderer-button-effect-unverified') : null),
          error: clickPayload?.clicked === false
            ? null
            : (!effectVerified ? (effectProof?.error || null) : null),
          matchedRequiredTexts,
          axNode: summarizeTradingViewRendererAxNode(buttonNode),
          clickResult: clickPayload,
          effectProof
        };
      }
    );

    return {
      applicable: true,
      available: true,
      success: cdpResult?.success === true,
      method: cdpResult?.success === true ? 'chromium-cdp-ax-dom-click' : null,
      reason: cdpResult?.reason || null,
      error: cdpResult?.success === true
        ? null
        : (cdpResult?.error || `TradingView renderer could not invoke "${buttonText}" (${cdpResult?.reason || 'unknown-reason'}).`),
      buttonText,
      requiredTexts,
      matchedRequiredTexts: Array.isArray(cdpResult?.matchedRequiredTexts) ? cdpResult.matchedRequiredTexts : [],
      axNode: cdpResult?.axNode || null,
      clickResult: cdpResult?.clickResult || null,
      effectProof: cdpResult?.effectProof || null,
      port: Number(discovery?.port || 0) || 0,
      target: discovery?.target || null,
      targets: Array.isArray(discovery?.targets) ? discovery.targets : [],
      endpointAttempts: Array.isArray(discovery?.endpointAttempts) ? discovery.endpointAttempts : [],
      discovery: discovery?.discovery || null
    };
  } catch (error) {
    return {
      applicable: true,
      available: false,
      success: false,
      reason: error?.reason || 'protocol-error',
      error: error?.message || String(error || 'CDP protocol session failed'),
      buttonText,
      requiredTexts,
      port: Number(discovery?.port || 0) || 0,
      target: discovery?.target || null,
      targets: Array.isArray(discovery?.targets) ? discovery.targets : [],
      endpointAttempts: Array.isArray(discovery?.endpointAttempts) ? discovery.endpointAttempts : [],
      discovery: discovery?.discovery || null
    };
  }
}

async function resolveTradingViewRendererCdpContext(options = {}) {
  const explicitWindowHandle = Number(options?.windowHandle || options?.hwnd || 0) || 0;
  const resolveWindowState = options?.resolveWindowState !== false;
  const timeout = Number.isFinite(Number(options?.timeout || options?.timeoutMs))
    ? Math.max(
        MIN_TRADINGVIEW_PINE_EDITOR_CDP_TIMEOUT_MS,
        Math.min(Math.round(Number(options.timeout || options.timeoutMs)), 2400)
      )
    : DEFAULT_TRADINGVIEW_PINE_EDITOR_CDP_TIMEOUT_MS;
  const discoveryTimeoutMs = Math.max(
    MIN_TRADINGVIEW_PINE_RENDERER_DISCOVERY_TIMEOUT_MS,
    Math.min(1800, Math.round(timeout * 0.82))
  );
  const httpTimeoutMs = Math.max(
    220,
    Math.min(700, Math.round(discoveryTimeoutMs * 0.38))
  );

  let windowInfo = options?.windowInfo && typeof options.windowInfo === 'object'
    ? options.windowInfo
    : null;
  let foreground = options?.foreground && typeof options.foreground === 'object'
    ? options.foreground
    : null;

  if (windowInfo && typeof windowInfo === 'object' && windowInfo.success === undefined) {
    windowInfo = { success: true, ...windowInfo };
  }
  if (foreground && typeof foreground === 'object' && foreground.success === undefined) {
    foreground = { success: true, ...foreground };
  }

  if (!windowInfo?.success && explicitWindowHandle > 0 && resolveWindowState) {
    try {
      const candidate = await getWindowInfoByHandle(explicitWindowHandle);
      if (candidate?.success) {
        windowInfo = candidate;
      }
    } catch {}
  }

  if (!foreground?.success && resolveWindowState) {
    try {
      foreground = await getForegroundWindowInfo();
    } catch {}
  }

  if (!windowInfo?.success && foreground?.success) {
    windowInfo = foreground;
  }

  if (!windowInfo?.success || !isTradingViewForegroundWindow(windowInfo)) {
    return {
      applicable: false,
      available: false,
      timeout,
      windowInfo: windowInfo?.success ? windowInfo : null,
      foreground: foreground?.success ? foreground : null,
      reason: 'window-not-tradingview',
      error: 'TradingView renderer CDP access requires the foreground TradingView window.'
    };
  }

  const cdpDependencies = options?.cdpDependencies && typeof options.cdpDependencies === 'object'
    ? options.cdpDependencies
    : {};
  const discovery = await discoverChromiumRemoteDebuggingTarget({
    port: options?.cdpPort || 0,
    processIds: [windowInfo?.pid || windowInfo?.processId || 0],
    processNames: [
      windowInfo?.processName || '',
      'tradingview'
    ],
    title: String(windowInfo?.title || ''),
    titleTokens: buildTradingViewPineRendererTargetTokens(windowInfo?.title || ''),
    targetTypes: ['page', 'webview'],
    urlHints: ['tradingview', '/chart/'],
    timeoutMs: discoveryTimeoutMs,
    httpTimeoutMs,
    fetchImpl: cdpDependencies.fetchImpl,
    WebSocketCtor: cdpDependencies.WebSocketCtor,
    processInspector: cdpDependencies.processInspector,
    listeningPortInspector: cdpDependencies.listeningPortInspector,
    executePowerShellScript: cdpDependencies.executePowerShellScript
  });

  return {
    applicable: true,
    available: discovery?.available === true,
    timeout,
    windowInfo,
    foreground,
    cdpDependencies,
    port: Number(discovery?.port || 0) || 0,
    target: discovery?.target || null,
    targets: Array.isArray(discovery?.targets) ? discovery.targets : [],
    endpointAttempts: Array.isArray(discovery?.endpointAttempts) ? discovery.endpointAttempts : [],
    discovery: discovery?.discovery || null,
    reason: discovery?.available === true ? null : (discovery?.reason || 'remote-debugging-port-not-configured'),
    error: discovery?.available === true ? null : (discovery?.error || null)
  };
}

function tradingViewPineEditorTextareaOperationInPage(payload = {}) {
  const options = payload && typeof payload === 'object' ? payload : {};
  const operation = String(options.operation || 'read').trim().toLowerCase();
  const replacementText = String(options.text ?? '');
  const previewLimit = Number.isFinite(Number(options.previewLimit))
    ? Math.max(120, Math.min(Math.round(Number(options.previewLimit)), 4000))
    : 320;
  const maxRoots = Number.isFinite(Number(options.maxRoots))
    ? Math.max(4, Math.min(Math.round(Number(options.maxRoots)), 64))
    : 32;
  const maxElements = Number.isFinite(Number(options.maxElements))
    ? Math.max(100, Math.min(Math.round(Number(options.maxElements)), 4000))
    : 1800;
  const compact = (value, maxLength = previewLimit) => {
    const text = String(value || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
    return text.length > maxLength ? text.slice(0, maxLength) : text;
  };
  const rectOf = (element) => {
    try {
      const rect = element?.getBoundingClientRect?.();
      if (!rect) return null;
      return {
        x: Number(rect.x || rect.left || 0) || 0,
        y: Number(rect.y || rect.top || 0) || 0,
        width: Number(rect.width || 0) || 0,
        height: Number(rect.height || 0) || 0
      };
    } catch {
      return null;
    }
  };
  const isVisible = (element) => {
    if (!element) return false;
    const rect = rectOf(element);
    if (!rect) return false;
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }
    try {
      const style = window.getComputedStyle?.(element);
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) {
        return false;
      }
    } catch {}
    return true;
  };
  const elementHasFocus = (element) => {
    if (!element) return false;
    try {
      if (document.activeElement === element) return true;
    } catch {}
    try {
      const root = typeof element.getRootNode === 'function' ? element.getRootNode() : null;
      if (root && root.activeElement === element) return true;
    } catch {}
    return false;
  };
  const collectRoots = () => {
    const queue = [];
    const roots = [];
    const seen = new Set();
    let scannedElements = 0;

    if (typeof document !== 'undefined' && document) {
      queue.push(document);
      seen.add(document);
    }

    while (queue.length > 0 && roots.length < maxRoots && scannedElements < maxElements) {
      const root = queue.shift();
      if (!root) continue;
      roots.push(root);

      let elements = [];
      try {
        elements = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
      } catch {}

      for (const element of elements) {
        if (!element || typeof element !== 'object') continue;
        scannedElements += 1;
        try {
          if (element.shadowRoot && !seen.has(element.shadowRoot)) {
            seen.add(element.shadowRoot);
            queue.push(element.shadowRoot);
          }
        } catch {}
        if (scannedElements >= maxElements) {
          break;
        }
      }
    }

    return {
      roots,
      scannedRoots: roots.length,
      scannedElements
    };
  };
  const rootCollection = collectRoots();
  const buildTextareaCandidate = (element, rootIndex = 0) => {
    if (!element) return null;
    const tagName = String(element.tagName || '').trim().toUpperCase();
    const isContentEditable = element.isContentEditable === true;
    if (tagName !== 'TEXTAREA' && !isContentEditable) {
      return null;
    }

    const ariaLabel = String(element.getAttribute?.('aria-label') || '').trim();
    const className = typeof element.className === 'string'
      ? element.className
      : (element.className?.baseVal || '');
    const value = tagName === 'TEXTAREA' || 'value' in element
      ? String(element.value ?? '')
      : String(element.textContent || '');
    const visible = isVisible(element);
    const focused = elementHasFocus(element);
    let score = 0;

    if (tagName === 'TEXTAREA') score += 220;
    if (isContentEditable) score += 120;
    if (/inputarea/i.test(className)) score += 190;
    if (/monaco/i.test(className)) score += 130;
    if (/mouse-cursor-text/i.test(className)) score += 90;
    if (/editor content/i.test(ariaLabel)) score += 220;
    if (/accessibility options/i.test(ariaLabel)) score += 70;
    if (/\/\/\s*@version\b/i.test(value)) score += 150;
    if (/\b(?:indicator|strategy|library)\s*\(/i.test(value)) score += 120;
    if (visible) score += 60;
    if (focused) score += 140;
    if (value) score += Math.min(80, Math.round(value.length / 24));
    score += Math.max(0, 30 - rootIndex);

    return {
      element,
      value,
      tagName,
      ariaLabel,
      className: String(className || ''),
      visible,
      focused,
      score,
      rect: rectOf(element)
    };
  };
  const textareaCandidates = [];
  for (let index = 0; index < rootCollection.roots.length; index += 1) {
    const root = rootCollection.roots[index];
    let candidates = [];
    try {
      candidates = root.querySelectorAll
        ? Array.from(root.querySelectorAll('textarea, [contenteditable]'))
        : [];
    } catch {}

    for (const candidate of candidates) {
      const built = buildTextareaCandidate(candidate, index);
      if (!built) continue;
      textareaCandidates.push(built);
    }
  }
  textareaCandidates.sort((left, right) => right.score - left.score);
  const bestTextarea = textareaCandidates[0] || null;

  const collectRenderedCandidates = () => {
    const candidates = [];
    const seen = new Set();

    for (let rootIndex = 0; rootIndex < rootCollection.roots.length; rootIndex += 1) {
      const root = rootCollection.roots[rootIndex];
      let containers = [];
      try {
        containers = root.querySelectorAll
          ? Array.from(root.querySelectorAll('.view-lines, .lines-content'))
          : [];
      } catch {}

      for (const container of containers) {
        if (!container) continue;
        const lineNodes = (() => {
          try {
            return Array.from(container.querySelectorAll('.view-line'));
          } catch {
            return [];
          }
        })();
        const lines = lineNodes.length > 0
          ? lineNodes.map((line) => compact(line.innerText || line.textContent || '', 4000)).filter(Boolean)
          : compact(container.innerText || container.textContent || '', 12000)
            .split(/\n+/)
            .map((line) => compact(line, 4000))
            .filter(Boolean);
        const text = lines.join('\n').trim();
        if (!text) continue;

        const source = lineNodes.length > 0 ? 'view-lines' : 'lines-content';
        const dedupeKey = `${source}:${text}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        let score = 0;
        if (/\/\/\s*@version\b/i.test(text)) score += 220;
        if (/\b(?:indicator|strategy|library)\s*\(/i.test(text)) score += 180;
        if (isVisible(container)) score += 80;
        if (lineNodes.length > 0) score += 40;
        score += Math.max(0, 20 - rootIndex);

        candidates.push({
          text,
          lineCount: lines.length,
          source,
          visible: isVisible(container),
          score
        });
      }
    }

    candidates.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return String(right.text || '').length - String(left.text || '').length;
    });
    return candidates;
  };
  const collectDialogCandidates = () => {
    const candidates = [];
    const seen = new Set();
    const dialogSelector = [
      '[role="dialog"]',
      '[aria-modal="true"]',
      'dialog',
      '[class*="dialog"]',
      '[class*="modal"]',
      '[class*="popup"]'
    ].join(', ');
    const collectUniqueText = (values = []) => Array.from(new Set(
      (Array.isArray(values) ? values : [values])
        .map((value) => compact(value, 1200))
        .filter(Boolean)
    ));
    const buildDialogInputCandidate = (input, rootIndex = 0) => {
      if (!input || !isVisible(input)) return null;
      const tagName = String(input.tagName || '').trim().toUpperCase();
      const type = String(input.getAttribute?.('type') || input.type || '').trim().toLowerCase();
      if (!['INPUT', 'TEXTAREA'].includes(tagName)) {
        return null;
      }
      if (tagName === 'INPUT' && ['hidden', 'button', 'submit', 'checkbox', 'radio', 'file', 'color', 'range'].includes(type)) {
        return null;
      }

      const ariaLabel = String(input.getAttribute?.('aria-label') || '').trim();
      const placeholder = String(input.getAttribute?.('placeholder') || '').trim();
      const value = tagName === 'TEXTAREA' || 'value' in input
        ? String(input.value ?? '')
        : String(input.textContent || '');
      let score = 0;
      if (tagName === 'INPUT') score += 200;
      if (tagName === 'TEXTAREA') score += 120;
      if (!type || ['text', 'search'].includes(type)) score += 100;
      if (/script|name|save/i.test([ariaLabel, placeholder].join(' '))) score += 220;
      if (elementHasFocus(input)) score += 140;
      score += Math.max(0, 18 - rootIndex);

      return {
        element: input,
        value,
        ariaLabel,
        placeholder,
        score
      };
    };

    for (let rootIndex = 0; rootIndex < rootCollection.roots.length; rootIndex += 1) {
      const root = rootCollection.roots[rootIndex];
      let containers = [];
      try {
        containers = root.querySelectorAll
          ? Array.from(root.querySelectorAll(dialogSelector))
          : [];
      } catch {}

      for (let containerIndex = 0; containerIndex < containers.length; containerIndex += 1) {
        const container = containers[containerIndex];
        if (!container || !isVisible(container)) continue;
        const dialogInputs = (() => {
          try {
            return Array.from(container.querySelectorAll('input, textarea'))
              .map((input) => buildDialogInputCandidate(input, rootIndex))
              .filter(Boolean)
              .sort((left, right) => right.score - left.score);
          } catch {
            return [];
          }
        })();
        const inputValues = collectUniqueText((() => {
          return dialogInputs.map((input) =>
            String(input?.value || input?.placeholder || input?.ariaLabel || '')
          );
        })());
        const buttonTexts = collectUniqueText((() => {
          try {
            return Array.from(container.querySelectorAll('button, [role="button"]')).map((button) =>
              String(
                button?.innerText
                || button?.textContent
                || button?.getAttribute?.('aria-label')
                || button?.getAttribute?.('title')
                || ''
              )
            );
          } catch {
            return [];
          }
        })());
        const containerText = compact(container.innerText || container.textContent || '', 12000);
        const textParts = collectUniqueText([containerText, ...inputValues, ...buttonTexts]);
        const text = textParts.join('\n').trim();
        if (!text) continue;

        const dedupeKey = text;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const role = String(container.getAttribute?.('role') || '').trim().toLowerCase();
        const className = typeof container.className === 'string'
          ? container.className
          : (container.className?.baseVal || '');
        let zIndex = 0;
        try {
          const style = window.getComputedStyle?.(container);
          const parsedZIndex = Number.parseInt(String(style?.zIndex || ''), 10);
          if (Number.isFinite(parsedZIndex)) {
            zIndex = parsedZIndex;
          }
        } catch {}
        let score = 0;
        if (role === 'dialog' || container.getAttribute?.('aria-modal') === 'true' || container.tagName === 'DIALOG') score += 180;
        if (/dialog|modal|popup/i.test(className)) score += 80;
        if (/\bsave script\b|\bnew script name\b|\bscript name\b|\bsave as\b|\brename script\b/i.test(text)) score += 220;
        if (/\balready exists\b|\breplace it\b|\byou have unsaved changes\b|\bwould you like to save them\b/i.test(text)) score += 340;
        if (/\byes\b|\bno\b/i.test(buttonTexts.join(' '))) score += 110;
        if (/\bsave\b|\bcancel\b/i.test(buttonTexts.join(' '))) score += 60;
        score += Math.max(0, Math.min(200, zIndex));
        score += Math.min(40, containerIndex);
        score += Math.max(0, 16 - rootIndex);

        candidates.push({
          text,
          inputValues,
          buttonTexts,
          inputElement: dialogInputs[0]?.element || null,
          source: role === 'dialog' || container.tagName === 'DIALOG' ? 'dialog-surface' : 'modal-surface',
          visible: true,
          score
        });
      }
    }

    candidates.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return String(right.text || '').length - String(left.text || '').length;
    });
    return candidates;
  };
  const summarizeTextarea = (candidate) => {
    if (!candidate) return null;
    const liveValue = (candidate.tagName === 'TEXTAREA' || 'value' in candidate.element)
      ? String(candidate.element?.value ?? '')
      : String(candidate.element?.textContent || '');
    const valueLength = Number(liveValue.length || 0) || 0;
    let selectionStart = 0;
    let selectionEnd = 0;
    try {
      selectionStart = Number(candidate.element?.selectionStart || 0) || 0;
      selectionEnd = Number(candidate.element?.selectionEnd || 0) || 0;
    } catch {}
    return {
      tagName: candidate.tagName || null,
      className: String(candidate.className || ''),
      ariaLabel: String(candidate.ariaLabel || ''),
      value: liveValue,
      valueLength,
      selectionStart,
      selectionEnd,
      visible: isVisible(candidate.element),
      focused: elementHasFocus(candidate.element),
      selectedAll: valueLength > 0 && selectionStart === 0 && selectionEnd === valueLength,
      rect: rectOf(candidate.element),
      score: Number(candidate.score || 0) || 0
    };
  };
  const summarizeRendered = (candidate) => candidate
    ? {
        text: String(candidate.text || ''),
        lineCount: Number(candidate.lineCount || 0) || 0,
        source: String(candidate.source || ''),
        visible: candidate.visible === true,
        score: Number(candidate.score || 0) || 0
      }
    : null;
  const summarizeDialog = (candidate) => candidate
    ? {
        text: String(candidate.text || ''),
        inputValues: Array.isArray(candidate.inputValues) ? candidate.inputValues.slice(0, 4) : [],
        buttonTexts: Array.isArray(candidate.buttonTexts) ? candidate.buttonTexts.slice(0, 6) : [],
        source: String(candidate.source || ''),
        visible: candidate.visible === true,
        score: Number(candidate.score || 0) || 0
      }
    : null;
  const dispatchInputEvent = (element, type, data = '', inputType = '') => {
    try {
      const event = new InputEvent(type, {
        bubbles: true,
        cancelable: type === 'beforeinput',
        composed: true,
        data,
        inputType: inputType || undefined
      });
      element.dispatchEvent(event);
      return 'InputEvent';
    } catch {
      try {
        const event = new Event(type, {
          bubbles: true,
          cancelable: type === 'beforeinput',
          composed: true
        });
        event.data = data;
        event.inputType = inputType || undefined;
        element.dispatchEvent(event);
        return 'Event';
      } catch {
        return 'failed';
      }
    }
  };
  const forceSetTextLikeElementValue = (element, nextValue, previousValue = '') => {
    if (!element) return;
    try {
      if (typeof element.setRangeText === 'function') {
        element.setRangeText(nextValue, 0, previousValue.length, 'end');
      } else if ('value' in element) {
        const tagName = String(element.tagName || '').trim().toUpperCase();
        const prototype = tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement?.prototype
          : window.HTMLInputElement?.prototype;
        const descriptor = prototype
          ? Object.getOwnPropertyDescriptor(prototype, 'value')
          : null;
        if (descriptor && typeof descriptor.set === 'function') {
          descriptor.set.call(element, nextValue);
        } else {
          element.value = nextValue;
        }
      } else {
        element.textContent = nextValue;
      }
    } catch {}
    try {
      if ('value' in element && String(element.value ?? '') !== nextValue) {
        element.value = nextValue;
      }
    } catch {}
    try {
      if (!('value' in element) && String(element.textContent || '') !== nextValue) {
        element.textContent = nextValue;
      }
    } catch {}
  };
  const focusAndSelectTextarea = (element) => {
    if (!element) return { found: false };
    try {
      element.scrollIntoView?.({ block: 'center', inline: 'nearest' });
    } catch {}
    try {
      element.focus?.({ preventScroll: true });
    } catch {
      try {
        element.focus?.();
      } catch {}
    }

    const value = (element.tagName === 'TEXTAREA' || 'value' in element)
      ? String(element.value ?? '')
      : String(element.textContent || '');
    try {
      if (typeof element.select === 'function') {
        element.select();
      }
    } catch {}
    try {
      if (typeof element.setSelectionRange === 'function') {
        element.setSelectionRange(0, value.length);
      }
    } catch {}

    let selectionStart = 0;
    let selectionEnd = 0;
    try {
      selectionStart = Number(element.selectionStart || 0) || 0;
      selectionEnd = Number(element.selectionEnd || 0) || 0;
    } catch {}

    return {
      found: true,
      valueLength: value.length,
      selectionStart,
      selectionEnd,
      focused: elementHasFocus(element)
    };
  };
  const buildResult = (extra = {}) => {
    const renderedCandidates = collectRenderedCandidates();
    const dialogCandidates = collectDialogCandidates();
    return {
      found: !!bestTextarea,
      operation,
      textarea: summarizeTextarea(bestTextarea),
      rendered: summarizeRendered(renderedCandidates[0] || null),
      dialog: summarizeDialog(dialogCandidates[0] || null),
      scannedRoots: rootCollection.scannedRoots,
      scannedElements: rootCollection.scannedElements,
      activeElementTagName: String(document?.activeElement?.tagName || ''),
      ...extra
    };
  };

  const dialogCandidates = collectDialogCandidates();
  const bestDialog = dialogCandidates[0] || null;

  if (operation === 'dialog-force-set') {
    const dialogInput = bestDialog?.inputElement || null;
    if (!dialogInput) {
      return buildResult({
        dialogFound: !!bestDialog,
        dialogInputApplied: false
      });
    }

    const previousValue = 'value' in dialogInput
      ? String(dialogInput.value ?? '')
      : String(dialogInput.textContent || '');
    const focusResult = focusAndSelectTextarea(dialogInput);
    const dispatchedBeforeInput = dispatchInputEvent(dialogInput, 'beforeinput', replacementText, 'insertText');
    forceSetTextLikeElementValue(dialogInput, replacementText, previousValue);
    try {
      if (typeof dialogInput.setSelectionRange === 'function') {
        const end = String(replacementText || '').length;
        dialogInput.setSelectionRange(end, end);
      }
    } catch {}
    const dispatchedInput = dispatchInputEvent(dialogInput, 'input', replacementText, 'insertText');
    const dispatchedChange = dispatchInputEvent(dialogInput, 'change', replacementText, '');
    const appliedValue = 'value' in dialogInput
      ? String(dialogInput.value ?? '')
      : String(dialogInput.textContent || '');

    return buildResult({
      dialogFound: true,
      dialogInputApplied: appliedValue === replacementText,
      previousValueLength: previousValue.length,
      appliedTextLength: replacementText.length,
      focused: focusResult.focused === true,
      dispatchedBeforeInput,
      dispatchedInput,
      dispatchedChange
    });
  }

  if (!bestTextarea) {
    return buildResult();
  }

  if (operation === 'focus-select-all') {
    const focusResult = focusAndSelectTextarea(bestTextarea.element);
    return buildResult({
      focused: focusResult.focused === true,
      selectedAll: focusResult.valueLength > 0
        && focusResult.selectionStart === 0
        && focusResult.selectionEnd === focusResult.valueLength
    });
  }

  if (operation === 'force-set') {
    const previousValue = (bestTextarea.tagName === 'TEXTAREA' || 'value' in bestTextarea.element)
      ? String(bestTextarea.element.value ?? '')
      : String(bestTextarea.element.textContent || '');
    focusAndSelectTextarea(bestTextarea.element);
    const dispatchedBeforeInput = dispatchInputEvent(bestTextarea.element, 'beforeinput', replacementText, 'insertFromPaste');
    forceSetTextLikeElementValue(bestTextarea.element, replacementText, previousValue);
    try {
      if (typeof bestTextarea.element.setSelectionRange === 'function') {
        const end = String(replacementText || '').length;
        bestTextarea.element.setSelectionRange(end, end);
      }
    } catch {}
    const dispatchedInput = dispatchInputEvent(bestTextarea.element, 'input', replacementText, 'insertFromPaste');
    const dispatchedChange = dispatchInputEvent(bestTextarea.element, 'change', replacementText, '');

    return buildResult({
      previousValueLength: previousValue.length,
      appliedTextLength: replacementText.length,
      dispatchedBeforeInput,
      dispatchedInput,
      dispatchedChange
    });
  }

  return buildResult();
}

function buildTradingViewPineEditorTextareaOperationExpression(options = {}) {
  return `(${tradingViewPineEditorTextareaOperationInPage.toString()})(${JSON.stringify(options || {})})`;
}

function summarizeTradingViewPineEditorCdpTextarea(textarea = null) {
  if (!textarea || typeof textarea !== 'object') return null;
  return {
    tagName: normalizeCompactText(textarea.tagName || '', 24) || null,
    className: normalizeCompactText(textarea.className || '', 160) || null,
    ariaLabel: normalizeCompactText(textarea.ariaLabel || '', 180) || null,
    valueLength: Number(textarea.valueLength || 0) || 0,
    selectionStart: Number(textarea.selectionStart || 0) || 0,
    selectionEnd: Number(textarea.selectionEnd || 0) || 0,
    visible: textarea.visible === true,
    focused: textarea.focused === true,
    selectedAll: textarea.selectedAll === true,
    rect: textarea.rect && typeof textarea.rect === 'object'
      ? {
          x: Number(textarea.rect.x || 0) || 0,
          y: Number(textarea.rect.y || 0) || 0,
          width: Number(textarea.rect.width || 0) || 0,
          height: Number(textarea.rect.height || 0) || 0
        }
      : null,
    valuePreview: normalizeCompactText(textarea.value || '', DEFAULT_TRADINGVIEW_PINE_EDITOR_CDP_PREVIEW_LIMIT) || ''
  };
}

function summarizeTradingViewPineEditorCdpRendered(rendered = null) {
  if (!rendered || typeof rendered !== 'object') return null;
  return {
    textPreview: normalizeCompactText(rendered.text || '', DEFAULT_TRADINGVIEW_PINE_EDITOR_CDP_PREVIEW_LIMIT) || '',
    lineCount: Number(rendered.lineCount || 0) || 0,
    source: normalizeCompactText(rendered.source || '', 40) || null,
    visible: rendered.visible === true
  };
}

function summarizeTradingViewPineEditorCdpDialog(dialog = null) {
  if (!dialog || typeof dialog !== 'object') return null;
  return {
    textPreview: normalizeCompactText(dialog.text || '', DEFAULT_TRADINGVIEW_PINE_EDITOR_CDP_PREVIEW_LIMIT) || '',
    inputValues: Array.isArray(dialog.inputValues)
      ? dialog.inputValues.map((value) => normalizeCompactText(value || '', 120)).filter(Boolean).slice(0, 4)
      : [],
    buttonTexts: Array.isArray(dialog.buttonTexts)
      ? dialog.buttonTexts.map((value) => normalizeCompactText(value || '', 80)).filter(Boolean).slice(0, 6)
      : [],
    source: normalizeCompactText(dialog.source || '', 40) || null,
    visible: dialog.visible === true
  };
}

function summarizeTradingViewPineEditorCdpPayload(payload = null) {
  const textarea = payload?.textarea && typeof payload.textarea === 'object'
    ? payload.textarea
    : null;
  const rendered = payload?.rendered && typeof payload.rendered === 'object'
    ? payload.rendered
    : null;
  const dialog = payload?.dialog && typeof payload.dialog === 'object'
    ? payload.dialog
    : null;
  const text = String(textarea?.value || '');
  const renderedText = String(rendered?.text || '');
  const dialogText = String(dialog?.text || '');

  return {
    found: payload?.found === true,
    dialogFound: payload?.dialogFound === true || dialog?.visible === true,
    dialogInputApplied: payload?.dialogInputApplied === true,
    operation: normalizeCompactText(payload?.operation || '', 40) || null,
    focused: payload?.focused === true || textarea?.focused === true,
    selectedAll: payload?.selectedAll === true || textarea?.selectedAll === true,
    text,
    textLength: Number(textarea?.valueLength || text.length) || 0,
    renderedText,
    renderedTextLength: renderedText.length,
    dialogText,
    dialogTextLength: dialogText.length,
    scannedRoots: Number(payload?.scannedRoots || 0) || 0,
    scannedElements: Number(payload?.scannedElements || 0) || 0,
    activeElementTagName: normalizeCompactText(payload?.activeElementTagName || '', 24) || null,
    textarea: summarizeTradingViewPineEditorCdpTextarea(textarea),
    rendered: summarizeTradingViewPineEditorCdpRendered(rendered),
    dialog: summarizeTradingViewPineEditorCdpDialog(dialog),
    previousValueLength: Number(payload?.previousValueLength || 0) || 0,
    appliedTextLength: Number(payload?.appliedTextLength || 0) || 0,
    dispatchedBeforeInput: normalizeCompactText(payload?.dispatchedBeforeInput || '', 24) || null,
    dispatchedInput: normalizeCompactText(payload?.dispatchedInput || '', 24) || null,
    dispatchedChange: normalizeCompactText(payload?.dispatchedChange || '', 24) || null
  };
}

function buildTradingViewPineEditorCdpWriteVerification(readback = {}, expectedText = '', options = {}) {
  const bufferProof = buildPineEditorPasteProof(readback?.text || '', expectedText, options);
  const renderedText = String(readback?.renderedText || '');
  const renderedProof = renderedText
    ? buildPineEditorPasteProof(renderedText, expectedText, options)
    : null;
  const renderedCorrupt = !!(
    renderedProof
    && (renderedProof.starterDefaultVisible || renderedProof.versionDirectiveCount > 1)
  );
  const renderedSupportsExpected = !!(
    renderedProof
    && (
      renderedProof.exactMatch
      || (options?.pinePreparedScriptName && renderedProof.expectedTitleVisible)
    )
  );
  const requireRenderedProof = options?.requireRenderedProof === true;
  const success = bufferProof.exactMatch
    && !renderedCorrupt
    && (!requireRenderedProof || renderedSupportsExpected);

  return {
    success,
    proof: bufferProof,
    renderedProof,
    compactSummary: [
      bufferProof.compactSummary,
      !renderedProof
        ? 'rendered=unavailable'
        : (renderedProof.exactMatch
          ? 'rendered=verified'
          : (renderedCorrupt
            ? 'rendered=corrupt'
            : (renderedSupportsExpected ? 'rendered=expected-title' : 'rendered=ambiguous')))
    ].filter(Boolean).join(' | ')
  };
}

async function runTradingViewPineEditorTextareaOperationWithCDPSession(session, options = {}) {
  const response = await session.call('Runtime.evaluate', {
    expression: buildTradingViewPineEditorTextareaOperationExpression(options),
    returnByValue: true,
    awaitPromise: true
  });
  return summarizeTradingViewPineEditorCdpPayload(response?.result?.value || {});
}

async function focusTradingViewPineEditorWithCDP(options = {}) {
  const context = await resolveTradingViewRendererCdpContext(options);
  if (!context?.applicable) {
    return {
      applicable: false,
      available: false,
      success: false,
      reason: context?.reason || 'window-not-tradingview',
      error: context?.error || null,
      port: 0,
      target: null,
      targets: [],
      endpointAttempts: [],
      discovery: null
    };
  }

  if (!context.available) {
    return {
      applicable: true,
      available: false,
      success: false,
      reason: context.reason || 'remote-debugging-port-not-configured',
      error: context.error || null,
      port: context.port,
      target: context.target,
      targets: context.targets,
      endpointAttempts: context.endpointAttempts,
      discovery: context.discovery,
      windowInfo: context.windowInfo || null
    };
  }

  try {
    const focusPayload = await withChromiumCdpSession(
      context.target,
      {
        WebSocketCtor: context.cdpDependencies?.WebSocketCtor,
        openTimeoutMs: Math.max(180, Math.min(1200, Math.round(context.timeout * 0.45))),
        callTimeoutMs: Math.max(180, Math.min(1200, Math.round(context.timeout * 0.4)))
      },
      async (session) => {
        try {
          await session.call('Page.bringToFront');
        } catch {}
        return await runTradingViewPineEditorTextareaOperationWithCDPSession(session, {
          operation: 'focus-select-all'
        });
      }
    );

    return {
      applicable: true,
      available: true,
      success: focusPayload?.found === true,
      method: focusPayload?.found === true ? 'ChromiumCDPFocus' : null,
      reason: focusPayload?.found === true ? null : 'editor-textarea-unavailable',
      error: focusPayload?.found === true ? null : 'TradingView Pine editor textarea was not exposed through CDP.',
      port: context.port,
      target: context.target,
      targets: context.targets,
      endpointAttempts: context.endpointAttempts,
      discovery: context.discovery,
      windowInfo: context.windowInfo || null,
      editor: focusPayload?.textarea || null,
      rendered: focusPayload?.rendered || null,
      dialog: focusPayload?.dialog || null,
      text: focusPayload?.text || '',
      renderedText: focusPayload?.renderedText || '',
      dialogText: focusPayload?.dialogText || '',
      focused: focusPayload?.focused === true,
      selectedAll: focusPayload?.selectedAll === true
    };
  } catch (error) {
    return {
      applicable: true,
      available: false,
      success: false,
      reason: error?.reason || 'protocol-error',
      error: error?.message || String(error || 'CDP protocol session failed'),
      port: context.port,
      target: context.target,
      targets: context.targets,
      endpointAttempts: context.endpointAttempts,
      discovery: context.discovery,
      windowInfo: context.windowInfo || null
    };
  }
}

async function readTradingViewPineEditorContentWithCDP(options = {}) {
  const context = await resolveTradingViewRendererCdpContext(options);
  if (!context?.applicable) {
    return {
      applicable: false,
      available: false,
      success: false,
      reason: context?.reason || 'window-not-tradingview',
      error: context?.error || null,
      port: 0,
      target: null,
      targets: [],
      endpointAttempts: [],
      discovery: null
    };
  }

  if (!context.available) {
    return {
      applicable: true,
      available: false,
      success: false,
      reason: context.reason || 'remote-debugging-port-not-configured',
      error: context.error || null,
      port: context.port,
      target: context.target,
      targets: context.targets,
      endpointAttempts: context.endpointAttempts,
      discovery: context.discovery,
      windowInfo: context.windowInfo || null
    };
  }

  try {
    const readback = await withChromiumCdpSession(
      context.target,
      {
        WebSocketCtor: context.cdpDependencies?.WebSocketCtor,
        openTimeoutMs: Math.max(180, Math.min(1200, Math.round(context.timeout * 0.45))),
        callTimeoutMs: Math.max(180, Math.min(1200, Math.round(context.timeout * 0.4)))
      },
      async (session) => {
        try {
          await session.call('Page.bringToFront');
        } catch {}
        return await runTradingViewPineEditorTextareaOperationWithCDPSession(session, {
          operation: 'read'
        });
      }
    );

    return {
      applicable: true,
      available: true,
      success: readback?.found === true,
      method: readback?.found === true ? 'ChromiumCDPRead' : null,
      reason: readback?.found === true ? null : 'editor-textarea-unavailable',
      error: readback?.found === true ? null : 'TradingView Pine editor textarea was not exposed through CDP.',
      port: context.port,
      target: context.target,
      targets: context.targets,
      endpointAttempts: context.endpointAttempts,
      discovery: context.discovery,
      windowInfo: context.windowInfo || null,
      editor: readback?.textarea || null,
      rendered: readback?.rendered || null,
      dialog: readback?.dialog || null,
      text: readback?.text || '',
      textLength: Number(readback?.textLength || 0) || 0,
      renderedText: readback?.renderedText || '',
      renderedTextLength: Number(readback?.renderedTextLength || 0) || 0,
      dialogText: readback?.dialogText || '',
      dialogTextLength: Number(readback?.dialogTextLength || 0) || 0
    };
  } catch (error) {
    return {
      applicable: true,
      available: false,
      success: false,
      reason: error?.reason || 'protocol-error',
      error: error?.message || String(error || 'CDP protocol session failed'),
      port: context.port,
      target: context.target,
      targets: context.targets,
      endpointAttempts: context.endpointAttempts,
      discovery: context.discovery,
      windowInfo: context.windowInfo || null
    };
  }
}

async function setTradingViewPineEditorContentWithCDP(options = {}) {
  const expectedText = normalizePineEditorBufferText(options?.text || options?.pinePreparedScriptText || '');
  const preparedScriptName = normalizeCompactText(options?.pinePreparedScriptName || '', 120);
  if (!expectedText) {
    return {
      applicable: false,
      available: false,
      success: false,
      fallbackRecommended: false,
      reason: 'prepared-script-text-required',
      error: 'TradingView Pine editor CDP write requires a non-empty prepared script.'
    };
  }

  const context = await resolveTradingViewRendererCdpContext(options);
  if (!context?.applicable) {
    return {
      applicable: false,
      available: false,
      success: false,
      fallbackRecommended: true,
      reason: context?.reason || 'window-not-tradingview',
      error: context?.error || null,
      port: 0,
      target: null,
      targets: [],
      endpointAttempts: [],
      discovery: null
    };
  }

  if (!context.available) {
    return {
      applicable: true,
      available: false,
      success: false,
      fallbackRecommended: true,
      reason: context.reason || 'remote-debugging-port-not-configured',
      error: context.error || null,
      port: context.port,
      target: context.target,
      targets: context.targets,
      endpointAttempts: context.endpointAttempts,
      discovery: context.discovery,
      windowInfo: context.windowInfo || null
    };
  }

  try {
    const cdpResult = await withChromiumCdpSession(
      context.target,
      {
        WebSocketCtor: context.cdpDependencies?.WebSocketCtor,
        openTimeoutMs: Math.max(180, Math.min(1200, Math.round(context.timeout * 0.45))),
        callTimeoutMs: Math.max(180, Math.min(1400, Math.round(context.timeout * 0.42)))
      },
      async (session) => {
        try {
          await session.call('Page.bringToFront');
        } catch {}

        const strategyAttempts = [];
        const focusPayload = await runTradingViewPineEditorTextareaOperationWithCDPSession(session, {
          operation: 'focus-select-all'
        });
        if (!focusPayload?.found) {
          return {
            success: false,
            reason: 'editor-textarea-unavailable',
            error: 'TradingView Pine editor textarea was not exposed through CDP.',
            focusPayload,
            strategyAttempts
          };
        }

        let inputReadback = null;
        let inputVerification = null;
        let inputInsertError = null;
        try {
          await session.call('Input.insertText', {
            text: expectedText
          });
        } catch (error) {
          inputInsertError = error?.message || String(error || 'Input.insertText failed');
        }
        await sleep(80);
        inputReadback = await runTradingViewPineEditorTextareaOperationWithCDPSession(session, {
          operation: 'read'
        });
        inputVerification = buildTradingViewPineEditorCdpWriteVerification(inputReadback, expectedText, {
          pinePreparedScriptName: preparedScriptName
        });
        strategyAttempts.push({
          strategy: 'input-insert-text',
          success: inputInsertError ? false : inputVerification.success,
          error: inputInsertError,
          compactSummary: inputVerification.compactSummary,
          editor: inputReadback?.textarea || null,
          rendered: inputReadback?.rendered || null
        });

        if (!inputInsertError && inputVerification.success) {
          return {
            success: true,
            method: 'ChromiumCDPInputInsertText',
            focusPayload,
            readback: inputReadback,
            verification: inputVerification,
            strategyAttempts
          };
        }

        const domSetPayload = await runTradingViewPineEditorTextareaOperationWithCDPSession(session, {
          operation: 'force-set',
          text: expectedText
        });
        await sleep(80);
        const domReadback = await runTradingViewPineEditorTextareaOperationWithCDPSession(session, {
          operation: 'read'
        });
        const domVerification = buildTradingViewPineEditorCdpWriteVerification(domReadback, expectedText, {
          pinePreparedScriptName: preparedScriptName,
          requireRenderedProof: true
        });
        strategyAttempts.push({
          strategy: 'dom-force-set',
          success: domVerification.success,
          error: null,
          compactSummary: domVerification.compactSummary,
          editor: domReadback?.textarea || null,
          rendered: domReadback?.rendered || null,
          forceSet: {
            previousValueLength: Number(domSetPayload?.previousValueLength || 0) || 0,
            appliedTextLength: Number(domSetPayload?.appliedTextLength || 0) || 0,
            dispatchedBeforeInput: domSetPayload?.dispatchedBeforeInput || null,
            dispatchedInput: domSetPayload?.dispatchedInput || null,
            dispatchedChange: domSetPayload?.dispatchedChange || null
          }
        });

        if (domVerification.success) {
          return {
            success: true,
            method: 'ChromiumCDPDOMInputEvent',
            focusPayload,
            readback: domReadback,
            verification: domVerification,
            strategyAttempts
          };
        }

        return {
          success: false,
          reason: 'cdp-editor-write-unverified',
          error: `TradingView Pine editor CDP write did not verify (${domVerification.compactSummary || inputVerification?.compactSummary || 'buffer mismatch'})`,
          focusPayload,
          readback: domReadback,
          verification: domVerification,
          inputVerification,
          strategyAttempts
        };
      }
    );

    return {
      applicable: true,
      available: true,
      success: cdpResult?.success === true,
      fallbackRecommended: cdpResult?.success !== true,
      method: cdpResult?.success === true ? cdpResult.method : null,
      reason: cdpResult?.success === true ? null : (cdpResult?.reason || 'cdp-editor-write-unverified'),
      error: cdpResult?.success === true ? null : (cdpResult?.error || 'TradingView Pine editor CDP write did not verify'),
      port: context.port,
      target: context.target,
      targets: context.targets,
      endpointAttempts: context.endpointAttempts,
      discovery: context.discovery,
      windowInfo: context.windowInfo || null,
      focus: cdpResult?.focusPayload || null,
      editor: cdpResult?.readback?.textarea || null,
      rendered: cdpResult?.readback?.rendered || null,
      dialog: cdpResult?.readback?.dialog || null,
      text: cdpResult?.readback?.text || '',
      renderedText: cdpResult?.readback?.renderedText || '',
      dialogText: cdpResult?.readback?.dialogText || '',
      proof: cdpResult?.verification?.proof || null,
      renderedProof: cdpResult?.verification?.renderedProof || null,
      compactSummary: cdpResult?.verification?.compactSummary || null,
      strategyAttempts: Array.isArray(cdpResult?.strategyAttempts) ? cdpResult.strategyAttempts : []
    };
  } catch (error) {
    return {
      applicable: true,
      available: false,
      success: false,
      fallbackRecommended: true,
      reason: error?.reason || 'protocol-error',
      error: error?.message || String(error || 'CDP protocol session failed'),
      port: context.port,
      target: context.target,
      targets: context.targets,
      endpointAttempts: context.endpointAttempts,
      discovery: context.discovery,
      windowInfo: context.windowInfo || null
    };
  }
}

async function setTradingViewPineSaveDialogNameWithCDP(options = {}) {
  const desiredText = normalizeCompactText(options?.text ?? '', 180);
  if (!desiredText) {
    return {
      applicable: false,
      available: false,
      success: false,
      fallbackRecommended: false,
      reason: 'save-dialog-name-required',
      error: 'TradingView save-name dialog authoring requires a non-empty script name.'
    };
  }

  const context = await resolveTradingViewRendererCdpContext(options);
  if (!context?.applicable) {
    return {
      applicable: false,
      available: false,
      success: false,
      fallbackRecommended: true,
      reason: context?.reason || 'window-not-tradingview',
      error: context?.error || null,
      port: 0,
      target: null,
      targets: [],
      endpointAttempts: [],
      discovery: null
    };
  }

  if (!context.available) {
    return {
      applicable: true,
      available: false,
      success: false,
      fallbackRecommended: true,
      reason: context.reason || 'remote-debugging-port-not-configured',
      error: context.error || null,
      port: context.port,
      target: context.target,
      targets: context.targets,
      endpointAttempts: context.endpointAttempts,
      discovery: context.discovery,
      windowInfo: context.windowInfo || null
    };
  }

  try {
    const cdpResult = await withChromiumCdpSession(
      context.target,
      {
        WebSocketCtor: context.cdpDependencies?.WebSocketCtor,
        openTimeoutMs: Math.max(180, Math.min(1200, Math.round(context.timeout * 0.45))),
        callTimeoutMs: Math.max(180, Math.min(1200, Math.round(context.timeout * 0.4)))
      },
      async (session) => {
        try {
          await session.call('Page.bringToFront');
        } catch {}
        return await runTradingViewPineEditorTextareaOperationWithCDPSession(session, {
          operation: 'dialog-force-set',
          text: desiredText
        });
      }
    );

    const dialogInputValues = Array.isArray(cdpResult?.dialog?.inputValues)
      ? cdpResult.dialog.inputValues
      : [];
    const normalizedDesiredText = desiredText.toLowerCase();
    const verified = dialogInputValues.some((value) =>
      normalizeCompactText(value || '', 180).toLowerCase() === normalizedDesiredText
    );
    const dialogVisible = cdpResult?.dialogFound === true || !!normalizeCompactText(cdpResult?.dialogText || '', 240);

    return {
      applicable: true,
      available: true,
      success: verified,
      fallbackRecommended: false,
      method: verified ? 'ChromiumCDPDialogSetValue' : null,
      reason: verified
        ? null
        : (dialogVisible ? 'dialog-input-readback-mismatch' : 'dialog-input-unavailable'),
      error: verified
        ? null
        : (dialogVisible
          ? `TradingView save dialog read back ${JSON.stringify(dialogInputValues[0] || '')} instead of ${JSON.stringify(desiredText)}`
          : 'TradingView save dialog input was not exposed through CDP.'),
      port: context.port,
      target: context.target,
      targets: context.targets,
      endpointAttempts: context.endpointAttempts,
      discovery: context.discovery,
      windowInfo: context.windowInfo || null,
      dialog: cdpResult?.dialog || null,
      dialogText: cdpResult?.dialogText || '',
      dialogFound: dialogVisible,
      dialogInputApplied: cdpResult?.dialogInputApplied === true,
      dialogInputValues,
      previousValueLength: Number(cdpResult?.previousValueLength || 0) || 0,
      appliedTextLength: Number(cdpResult?.appliedTextLength || 0) || 0,
      dispatchedBeforeInput: cdpResult?.dispatchedBeforeInput || null,
      dispatchedInput: cdpResult?.dispatchedInput || null,
      dispatchedChange: cdpResult?.dispatchedChange || null
    };
  } catch (error) {
    return {
      applicable: true,
      available: false,
      success: false,
      fallbackRecommended: true,
      reason: error?.reason || 'protocol-error',
      error: error?.message || String(error || 'CDP protocol session failed'),
      port: context.port,
      target: context.target,
      targets: context.targets,
      endpointAttempts: context.endpointAttempts,
      discovery: context.discovery,
      windowInfo: context.windowInfo || null
    };
  }
}

function buildTradingViewPineProbeElementDedupKey(element = {}) {
  const bounds = element?.Bounds || element?.bounds || {};
  return [
    normalizeTradingViewPineAnchorText(element?.Name || element?.name || ''),
    normalizeTradingViewPineAnchorText(element?.AutomationId || element?.automationId || ''),
    normalizeTradingViewPineAnchorText(element?.ClassName || element?.className || ''),
    normalizeTradingViewPineAnchorText(element?.ControlType || element?.controlType || ''),
    Number(bounds?.X ?? bounds?.x ?? 0) || 0,
    Number(bounds?.Y ?? bounds?.y ?? 0) || 0,
    Number(bounds?.Width ?? bounds?.width ?? 0) || 0,
    Number(bounds?.Height ?? bounds?.height ?? 0) || 0
  ].join('|');
}

function summarizeTradingViewPineProbeElement(element = null) {
  if (!element || typeof element !== 'object') return null;
  const bounds = normalizeBoundsRect(element?.Bounds || element?.bounds || null);
  return {
    Name: String(element?.Name || element?.name || ''),
    ControlType: String(element?.ControlType || element?.controlType || ''),
    AutomationId: String(element?.AutomationId || element?.automationId || ''),
    ClassName: String(element?.ClassName || element?.className || ''),
    Value: normalizeCompactText(element?.Value || element?.value || '', 180) || '',
    Description: normalizeCompactText(element?.Description || element?.description || '', 180) || '',
    DefaultAction: normalizeCompactText(element?.DefaultAction || element?.defaultAction || '', 120) || '',
    LegacyRole: normalizeCompactText(element?.LegacyRole || element?.legacyRole || '', 120) || '',
    Source: normalizeCompactText(element?.Source || element?.source || '', 80) || '',
    WindowHandle: Number(element?.WindowHandle || element?.windowHandle || 0) || 0,
    NativeWindowHandle: Number(element?.NativeWindowHandle || element?.nativeWindowHandle || 0) || 0,
    Patterns: Array.isArray(element?.Patterns || element?.patterns)
      ? (element.Patterns || element.patterns).slice(0, 8)
      : [],
    IsEnabled: element?.IsEnabled !== undefined ? element.IsEnabled : element?.isEnabled,
    IsOffscreen: element?.IsOffscreen !== undefined ? element.IsOffscreen : element?.isOffscreen,
    HasKeyboardFocus: element?.HasKeyboardFocus !== undefined ? element.HasKeyboardFocus : element?.hasKeyboardFocus,
    IsFocusable: element?.IsFocusable !== undefined ? element.IsFocusable : element?.isFocusable,
    IsClickable: element?.IsClickable !== undefined ? element.IsClickable : element?.isClickable,
    Bounds: bounds
      ? {
          X: bounds.x,
          Y: bounds.y,
          Width: bounds.width,
          Height: bounds.height,
          CenterX: bounds.x + Math.round(bounds.width / 2),
          CenterY: bounds.y + Math.round(bounds.height / 2)
        }
      : null
  };
}

function scoreTradingViewPineDiagnosticElement(element = {}) {
  const haystack = normalizeTradingViewPineAnchorText([
    element?.Name || element?.name || '',
    element?.AutomationId || element?.automationId || '',
    element?.ClassName || element?.className || '',
    element?.Value || element?.value || '',
    element?.Description || element?.description || '',
    element?.DefaultAction || element?.defaultAction || '',
    element?.LegacyRole || element?.legacyRole || '',
    element?.Source || element?.source || '',
    element?.ControlType || element?.controlType || ''
  ].join(' '));
  if (!haystack) return 0;

  let score = 0;
  if (/\bpine\b/.test(haystack)) score += 80;
  if (/\beditor\b/.test(haystack)) score += 44;
  if (/\bscript\b/.test(haystack)) score += 36;
  if (/\bpublish\b/.test(haystack)) score += 32;
  if (/\bsave\b/.test(haystack)) score += 24;
  if (/\buntitled\b/.test(haystack)) score += 22;
  if (/\btester\b/.test(haystack)) score += 20;
  if (/\blogs\b/.test(haystack)) score += 18;
  if (/\bsource\b/.test(haystack)) score += 14;

  const controlType = String(element?.ControlType || element?.controlType || '');
  if (/button/i.test(controlType)) score += 18;
  if (/edit/i.test(controlType)) score += 18;
  if (/tab/i.test(controlType)) score += 14;
  if (/text/i.test(controlType)) score += 8;
  if (/document/i.test(controlType)) score -= 20;
  if (/pane|custom/i.test(controlType)) score -= 10;

  const patterns = Array.isArray(element?.Patterns || element?.patterns)
    ? (element.Patterns || element.patterns)
    : [];
  if (patterns.some((pattern) => /invoke/i.test(String(pattern || '')))) score += 18;
  if (patterns.some((pattern) => /value/i.test(String(pattern || '')))) score += 10;
  if (patterns.some((pattern) => /text/i.test(String(pattern || '')))) score += 10;

  if (element?.HasKeyboardFocus === true || element?.hasKeyboardFocus === true) score += 8;
  if (element?.IsFocusable === true || element?.isFocusable === true) score += 8;
  if (element?.IsClickable === true || element?.isClickable === true) score += 8;
  return score;
}

function collectTradingViewPineEditorDiagnosticSignals(elements = []) {
  const signals = [];
  const seen = new Set();

  for (const element of Array.isArray(elements) ? elements : []) {
    const score = scoreTradingViewPineDiagnosticElement(element);
    if (score < 24) continue;

    const summary = summarizeTradingViewPineProbeElement(element);
    if (!summary) continue;

    const label = normalizeCompactText(
      summary.Name
      || summary.AutomationId
      || summary.ClassName
      || summary.ControlType,
      160
    );
    if (!label) continue;

    const dedupeKey = `${normalizeTradingViewPineAnchorText(label)}|${normalizeTradingViewPineAnchorText(summary.ControlType || '')}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    signals.push({
      text: label,
      score,
      controlType: summary.ControlType,
      automationId: summary.AutomationId,
      className: summary.ClassName,
      patterns: summary.Patterns,
      bounds: summary.Bounds
    });
  }

  return signals
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return String(left.text || '').localeCompare(String(right.text || ''));
    })
    .slice(0, 12);
}

async function collectTradingViewPineEditorDiagnosticHostElements(windowHandle = 0, windowInfo = {}, options = {}) {
  const hwnd = Number(windowHandle || 0) || 0;
  const diagnosticBounds = buildTradingViewPineSurfaceDiagnosticBounds(windowInfo);
  const emptyResult = {
    elements: [],
    elementSummaries: [],
    signals: [],
    attempts: [],
    diagnosticBounds
  };
  if (!hwnd || diagnosticBounds.length === 0) {
    return emptyResult;
  }

  const scanPlans = [];
  for (const diagnosticBound of diagnosticBounds) {
    scanPlans.push({
      id: diagnosticBound.id,
      bounds: diagnosticBound.bounds,
      query: 'diagnostic-regex',
      view: 'raw',
      text: TRADINGVIEW_PINE_EDITOR_DIAGNOSTIC_HOST_REGEX,
      textMode: 'regex',
      maxResults: 28,
      maxDepth: 22,
      maxVisited: 2600
    });

    if (diagnosticBound.id !== 'right-workspace') {
      scanPlans.push({
        id: diagnosticBound.id,
        bounds: diagnosticBound.bounds,
        query: 'diagnostic-sample',
        view: 'control',
        text: '',
        textMode: 'contains',
        maxResults: diagnosticBound.id === 'full-window-content' ? 56 : 36,
        maxDepth: 18,
        maxVisited: 2200,
        skipRootMatch: true
      });
    }
  }

  const totalTimeout = Number.isFinite(Number(options?.timeout || options?.timeoutMs))
    ? Math.max(400, Math.min(Math.round(Number(options.timeout || options.timeoutMs)), 2200))
    : 1000;
  const perAttemptTimeout = Math.max(180, Math.min(420, Math.round(totalTimeout / Math.max(1, scanPlans.length))));
  const seenElements = new Set();
  const collectedElements = [];
  const attempts = [];

  for (const plan of scanPlans) {
    const scanResult = await findElementsByWindowWithHost(plan.text, {
      windowHandle: hwnd,
      timeout: perAttemptTimeout,
      maxResults: plan.maxResults,
      maxDepth: plan.maxDepth,
      maxVisited: plan.maxVisited,
      includeDisabled: true,
      includeOffscreen: false,
      bounds: plan.bounds,
      textMode: plan.textMode,
      view: plan.view,
      skipRootMatch: plan.skipRootMatch === true
    });
    attempts.push({
      id: plan.id,
      bounds: plan.bounds,
      view: plan.view,
      query: plan.query,
      success: scanResult?.success === true,
      count: Number(scanResult?.count || 0) || 0,
      stats: scanResult?.stats || null,
      error: scanResult?.error || null
    });

    if (scanResult?.success && Array.isArray(scanResult.elements)) {
      for (const element of scanResult.elements) {
        const taggedElement = {
          ...element,
          LikuPineProbeScanId: plan.id,
          LikuPineProbeView: plan.view,
          LikuPineProbeSource: 'diagnostic-host-scan'
        };
        const dedupeKey = buildTradingViewPineProbeElementDedupKey(taggedElement);
        if (seenElements.has(dedupeKey)) continue;
        seenElements.add(dedupeKey);
        collectedElements.push(taggedElement);
      }
    }

    if (collectTradingViewPineEditorHostAnchors(collectedElements, options).length > 0) {
      break;
    }
  }

  return {
    elements: collectedElements,
    elementSummaries: collectedElements
      .map((element) => summarizeTradingViewPineProbeElement(element))
      .filter(Boolean)
      .slice(0, 12),
    signals: collectTradingViewPineEditorDiagnosticSignals(collectedElements),
    attempts,
    diagnosticBounds
  };
}

async function collectTradingViewPineEditorDocumentHostElements(windowHandle = 0, scanBounds = [], options = {}) {
  const hwnd = Number(windowHandle || 0) || 0;
  const boundsPlans = Array.isArray(scanBounds)
    ? scanBounds
      .map((entry) => ({
        id: String(entry?.id || 'lower-panel'),
        bounds: normalizeBoundsRect(entry?.bounds || entry || null)
      }))
      .filter((entry) => entry.bounds)
    : [];
  const emptyResult = {
    elements: [],
    elementSummaries: [],
    rootSummaries: [],
    signals: [],
    attempts: []
  };
  if (!hwnd || boundsPlans.length === 0) {
    return emptyResult;
  }

  const totalTimeout = Number.isFinite(Number(options?.timeout || options?.timeoutMs))
    ? Math.max(320, Math.min(Math.round(Number(options.timeout || options.timeoutMs)), 1800))
    : 900;
  const perAttemptTimeout = Math.max(180, Math.min(520, Math.round(totalTimeout / Math.max(1, boundsPlans.length))));
  const seenElements = new Set();
  const seenRoots = new Set();
  const collectedElements = [];
  const collectedRoots = [];
  const attempts = [];

  for (const plan of boundsPlans) {
    const probeResult = await probeWindowAccessibilityWithHost({
      windowHandle: hwnd,
      bounds: plan.bounds,
      timeout: perAttemptTimeout,
      maxResults: 24,
      maxRoots: 3,
      maxDepth: 20,
      maxVisited: 1600,
      includeDisabled: true,
      includeOffscreen: false,
      rootControlType: 'Document',
      rootClassName: 'Chrome_RenderWidgetHostHWND'
    });

    attempts.push({
      id: plan.id,
      bounds: plan.bounds,
      success: probeResult?.success === true,
      count: Number(probeResult?.count || 0) || 0,
      rootCount: Number(probeResult?.rootCount || 0) || 0,
      stats: probeResult?.stats || null,
      error: probeResult?.error || null
    });

    if (!probeResult?.success) {
      continue;
    }

    for (const element of Array.isArray(probeResult?.elements) ? probeResult.elements : []) {
      const taggedElement = {
        ...element,
        LikuPineProbeScanId: plan.id,
        LikuPineProbeView: 'document',
        LikuPineProbeSource: 'document-accessibility-probe'
      };
      const dedupeKey = buildTradingViewPineProbeElementDedupKey(taggedElement);
      if (seenElements.has(dedupeKey)) continue;
      seenElements.add(dedupeKey);
      collectedElements.push(taggedElement);
    }

    for (const root of Array.isArray(probeResult?.roots) ? probeResult.roots : []) {
      const taggedRoot = {
        ...root,
        LikuPineProbeScanId: plan.id,
        LikuPineProbeView: 'document-root',
        LikuPineProbeSource: 'document-accessibility-root'
      };
      const dedupeKey = buildTradingViewPineProbeElementDedupKey(taggedRoot);
      if (seenRoots.has(dedupeKey)) continue;
      seenRoots.add(dedupeKey);
      collectedRoots.push(taggedRoot);
    }

    if (collectTradingViewPineEditorHostAnchors(collectedElements, options).length > 0) {
      break;
    }
  }

  return {
    elements: collectedElements,
    elementSummaries: collectedElements
      .map((element) => summarizeTradingViewPineProbeElement(element))
      .filter(Boolean)
      .slice(0, 16),
    rootSummaries: collectedRoots
      .map((root) => summarizeTradingViewPineProbeElement(root))
      .filter(Boolean)
      .slice(0, 8),
    signals: collectTradingViewPineEditorDiagnosticSignals(collectedElements),
    attempts
  };
}

async function collectTradingViewPineEditorPointProbeElements(windowHandle = 0, scanBounds = [], options = {}) {
  const primaryBounds = normalizeBoundsRect(scanBounds?.[0]?.bounds || scanBounds?.[0] || null);
  const emptyResult = {
    elements: [],
    attempts: [],
    usedWindowScopedHost: false,
    usedGlobalFallback: false
  };
  if (!primaryBounds) {
    return emptyResult;
  }

  try {
    const ui = require('./ui-automation');
    const host = ui.getSharedUIAHost();
    const targetWindowHandle = Number(windowHandle || 0) || 0;
    const canUseWindowScopedHost = targetWindowHandle > 0 && typeof host?.elementFromPointInWindow === 'function';
    const canUseGlobalFallback = typeof host?.elementFromPoint === 'function';
    if (!canUseWindowScopedHost && !canUseGlobalFallback) {
      return emptyResult;
    }

    const sampled = [];
    const seen = new Set();
    const attempts = [];
    const xRatios = [0.18, 0.38, 0.62, 0.82];
    const yRatios = [0.08, 0.28, 0.62];
    const totalTimeout = Number.isFinite(Number(options?.timeout || options?.timeoutMs))
      ? Math.max(250, Math.min(Math.round(Number(options.timeout || options.timeoutMs)), 2500))
      : 1200;
    const sampleCount = Math.max(1, xRatios.length * yRatios.length);
    const perProbeTimeout = Math.max(90, Math.min(260, Math.round(totalTimeout / sampleCount)));

    const summarizePointProbeElement = (element) => {
      if (!element || typeof element !== 'object') return null;
      return {
        Name: String(element?.Name || ''),
        ControlType: String(element?.ControlType || ''),
        WindowHandle: Number(element?.WindowHandle || 0) || 0,
        Bounds: element?.Bounds || null
      };
    };

    const addSampledElement = (element) => {
      if (!element) return;
      const bounds = element?.Bounds || {};
      const dedupeKey = [
        normalizeTradingViewPineAnchorText(element?.Name || ''),
        Number(bounds?.X || 0) || 0,
        Number(bounds?.Y || 0) || 0,
        Number(bounds?.Width || 0) || 0,
        Number(bounds?.Height || 0) || 0
      ].join('|');
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      sampled.push({
        ...element,
        LikuPineProbeScanId: String(scanBounds?.[0]?.id || 'point-sample'),
        LikuPineProbeView: 'raw',
        LikuPineProbeSource: 'point-probe'
      });
    };

    for (const yRatio of yRatios) {
      const y = Math.round(primaryBounds.y + Math.max(12, Math.min(primaryBounds.height - 12, primaryBounds.height * yRatio)));
      for (const xRatio of xRatios) {
        const x = Math.round(primaryBounds.x + Math.max(12, Math.min(primaryBounds.width - 12, primaryBounds.width * xRatio)));
        let shouldUseGlobalFallback = canUseGlobalFallback && !canUseWindowScopedHost;

        if (canUseWindowScopedHost) {
          try {
            const response = await host.elementFromPointInWindow(targetWindowHandle, x, y, {
              view: 'raw',
              maxDepth: 18,
              maxVisited: 1400,
              timeoutMs: perProbeTimeout,
              includeOffscreen: false,
              includeDisabled: true
            });
            const element = normalizeHostElementForFind(response?.element);
            attempts.push({
              x,
              y,
              mode: 'window-scoped',
              windowHandle: targetWindowHandle,
              matchedBy: response?.matchedBy || null,
              directHitWithinWindow: response?.directHitWithinWindow === true,
              stats: response?.stats || null,
              element: summarizePointProbeElement(element),
              error: null
            });
            if (element) {
              addSampledElement(element);
              continue;
            }
            shouldUseGlobalFallback = canUseGlobalFallback;
          } catch (error) {
            const errorMessage = error?.message || String(error || 'window-scoped point probe failed');
            attempts.push({
              x,
              y,
              mode: 'window-scoped',
              windowHandle: targetWindowHandle,
              matchedBy: null,
              directHitWithinWindow: null,
              stats: null,
              element: null,
              error: errorMessage
            });
            shouldUseGlobalFallback = canUseGlobalFallback
              && !/no matching element in target window at point|window handle not found|fromhandle failed/i.test(errorMessage);
          }
        }

        if (!shouldUseGlobalFallback) {
          continue;
        }

        let fallbackElement = null;
        let fallbackError = null;
        try {
          fallbackElement = normalizeHostElementForFind(await host.elementFromPoint(x, y));
        } catch (error) {
          fallbackError = error?.message || String(error || 'global point probe failed');
        }

        attempts.push({
          x,
          y,
          mode: 'global-fallback',
          windowHandle: targetWindowHandle || null,
          matchedBy: null,
          directHitWithinWindow: null,
          stats: null,
          element: summarizePointProbeElement(fallbackElement),
          error: fallbackError
        });
        if (fallbackElement) {
          addSampledElement(fallbackElement);
        }
      }
    }

    return {
      elements: sampled,
      attempts,
      usedWindowScopedHost: canUseWindowScopedHost,
      usedGlobalFallback: attempts.some((attempt) => attempt?.mode === 'global-fallback')
    };
  } catch {
    return emptyResult;
  }
}

async function probeTradingViewPineEditorSurface(options = {}) {
  const explicitWindowHandle = Number(options?.windowHandle || options?.hwnd || 0) || 0;
  const timeout = Number.isFinite(Number(options?.timeout || options?.timeoutMs))
    ? Math.max(250, Math.min(Math.round(Number(options.timeout || options.timeoutMs)), 2500))
    : 1400;
  const allowRendererProof = options?.allowRendererProof !== false;
  const resolveWindowState = options?.resolveWindowState !== false;
  const allowPointProbe = options?.allowPointProbe !== false;
  const allowDiagnosticScan = options?.allowDiagnosticScan !== false;
  const evidenceMode = String(options?.pineEvidenceMode || options?.evidenceMode || '').trim().toLowerCase();
  const requestedScanViews = Array.isArray(options?.scanViews)
    ? options.scanViews
      .map((view) => String(view || '').trim().toLowerCase())
      .filter((view) => ['content', 'control', 'raw'].includes(view))
    : [];
  const scanViews = requestedScanViews.length > 0 ? requestedScanViews : ['content', 'control', 'raw'];
  const minScanAttemptTimeout = Number.isFinite(Number(options?.minScanAttemptTimeout))
    ? Math.max(120, Math.min(450, Math.round(Number(options.minScanAttemptTimeout))))
    : 450;
  const expectedScriptName = normalizeCompactText(
    options?.pineExpectedScriptName || options?.expectedScriptName || options?.scriptName || '',
    180
  );

  let foreground = summarizeTradingViewPineActivationForeground(options?.foreground || null);
  let windowInfo = summarizeTradingViewPineActivationWindowInfo(options?.windowInfo || null);

  if (!windowInfo?.success && explicitWindowHandle > 0 && resolveWindowState) {
    try {
      const candidate = await getWindowInfoByHandle(explicitWindowHandle);
      if (candidate?.success) {
        windowInfo = candidate;
      }
    } catch {}
  }

  if (!foreground?.success && resolveWindowState) {
    try {
      foreground = await getForegroundWindowInfo();
    } catch {}
  }

  if (!windowInfo?.success && foreground?.success) {
    windowInfo = foreground;
  }

  if (!windowInfo?.success || !isTradingViewForegroundWindow(windowInfo)) {
    return {
      active: false,
      foreground: foreground?.success ? foreground : windowInfo?.success ? windowInfo : null,
      reason: 'foreground-not-tradingview',
      rendererProof: null
    };
  }

  const hwnd = Number(windowInfo?.hwnd || explicitWindowHandle || 0) || 0;
  if (!hwnd) {
    return {
      active: false,
      foreground: windowInfo,
      reason: 'missing-window-handle',
      rendererProof: null
    };
  }

  const rendererProof = allowRendererProof
    ? await probeTradingViewPineEditorRendererWithCDP({
        windowHandle: hwnd,
        windowInfo,
        foreground,
        resolveWindowState: false,
        timeout: Math.max(
          MIN_TRADINGVIEW_PINE_RENDERER_PROOF_TIMEOUT_MS,
          Math.min(Math.round(timeout * 0.58), 1200)
        ),
        pineExpectedScriptName: expectedScriptName,
        cdpPort: options?.cdpPort || 0,
        cdpDependencies: options?.cdpDependencies || null
      })
    : null;
  const rendererVisibleAnchorEntries = summarizeTradingViewPineVisibleAnchorEntries(
    rendererProof?.signals || [],
    rendererProof?.matchedBy || null
  );
  const rendererProvidesExpectedTitleProof = expectedScriptName
    ? extractTradingViewPineExpectedTitleProof({
        matchedBy: rendererProof?.matchedBy || null,
        visibleAnchorEntries: rendererVisibleAnchorEntries,
        rendererProof
      }, expectedScriptName).visible === true
    : false;
  if (
    rendererProof?.available === true
    && rendererProof?.active === true
    && (!expectedScriptName || rendererProvidesExpectedTitleProof)
  ) {
    return {
      active: true,
      foreground: windowInfo,
      windowInfo,
      searchBounds: null,
      scanBounds: [],
      scanAttempts: [],
      documentProbeAttempts: [],
      documentProbeSignals: [],
      documentProbeRoots: [],
      documentProbeElements: [],
      pointProbeAttempts: [],
      pointProbeUsedWindowScopedHost: false,
      pointProbeUsedGlobalFallback: false,
      diagnosticBounds: [],
      diagnosticAttempts: [],
      diagnosticSignals: [],
      diagnosticElements: [],
      matchedBy: rendererProof.matchedBy || 'chromium-cdp-dom',
      element: null,
      anchorText: rendererProof.anchorText || null,
      pointProbeElements: [],
      visibleAnchors: Array.isArray(rendererProof?.signals)
        ? rendererProof.signals.map((signal) => signal?.text).filter(Boolean).slice(0, 8)
        : [],
      visibleAnchorEntries: rendererVisibleAnchorEntries,
      rendererProof
    };
  }

  const scanBounds = buildTradingViewPineSurfaceScanBounds(windowInfo);
  if (!Array.isArray(scanBounds) || scanBounds.length === 0) {
    if (rendererProof?.active === true) {
      return {
        active: true,
        foreground: windowInfo,
        windowInfo,
        searchBounds: null,
        scanBounds: [],
        scanAttempts: [],
        documentProbeAttempts: [],
        documentProbeSignals: [],
        documentProbeRoots: [],
        documentProbeElements: [],
        pointProbeAttempts: [],
        pointProbeUsedWindowScopedHost: false,
        pointProbeUsedGlobalFallback: false,
        diagnosticBounds: [],
        diagnosticAttempts: [],
        diagnosticSignals: [],
        diagnosticElements: [],
        matchedBy: rendererProof.matchedBy || 'chromium-cdp-dom',
        element: null,
        anchorText: rendererProof.anchorText || null,
        pointProbeElements: [],
        visibleAnchors: rendererVisibleAnchorEntries.map((entry) => entry?.text).filter(Boolean).slice(0, 8),
        visibleAnchorEntries: rendererVisibleAnchorEntries,
        reason: expectedScriptName ? 'save-title-unverified' : null,
        rendererProof
      };
    }

    return {
      active: false,
      foreground: windowInfo,
      reason: 'missing-lower-panel-bounds',
      rendererProof
    };
  }

  const scanAttempts = [];
  const seenElements = new Set();
  const collectedElements = [];
  const perAttemptTimeout = Math.max(
    minScanAttemptTimeout,
    Math.min(900, Math.round(timeout / Math.max(1, scanBounds.length * scanViews.length)) || minScanAttemptTimeout)
  );
  const hostSurfaceRegex = buildTradingViewPineSurfaceHostRegex({
    pineExpectedScriptName: expectedScriptName
  });
  let matchedScanId = null;

  for (const scanBound of scanBounds) {
    for (const view of scanViews) {
      const scanResult = await findElementsByWindowWithHost(hostSurfaceRegex, {
        windowHandle: hwnd,
        timeout: perAttemptTimeout,
        maxResults: 32,
        maxDepth: 20,
        maxVisited: 2200,
        includeDisabled: true,
        bounds: scanBound.bounds,
        textMode: 'regex',
        view
      });
      scanAttempts.push({
        id: scanBound.id,
        bounds: scanBound.bounds,
        view,
        success: scanResult?.success === true,
        count: Number(scanResult?.count || 0) || 0,
        stats: scanResult?.stats || null,
        error: scanResult?.error || null
      });

      if (!scanResult?.success || !Array.isArray(scanResult.elements)) {
        continue;
      }

      for (const element of scanResult.elements) {
        const taggedElement = {
          ...element,
          LikuPineProbeScanId: scanBound.id,
          LikuPineProbeView: view,
          LikuPineProbeSource: 'window-host-scan'
        };
        const bounds = taggedElement?.Bounds || {};
        const dedupeKey = [
          normalizeTradingViewPineAnchorText(taggedElement?.Name || ''),
          Number(taggedElement?.WindowHandle || 0) || 0,
          Number(bounds?.X || 0) || 0,
          Number(bounds?.Y || 0) || 0,
          Number(bounds?.Width || 0) || 0,
          Number(bounds?.Height || 0) || 0
        ].join('|');
        if (seenElements.has(dedupeKey)) continue;
        seenElements.add(dedupeKey);
        collectedElements.push(taggedElement);
      }

      const collectedAnchors = collectTradingViewPineEditorHostAnchors(collectedElements, {
        pineExpectedScriptName: expectedScriptName
      });
      if (collectedAnchors.length > 0 && !matchedScanId) {
        matchedScanId = scanBound.id;
      }
      if (
        collectedAnchors.length > 0
        && (
          evidenceMode !== 'save-status'
          || !isTradingViewPineTitleOnlyAnchorSet(collectedAnchors)
        )
      ) {
        break;
      }
    }

    if (matchedScanId && evidenceMode !== 'save-status') {
      break;
    }
  }

  const anchors = collectTradingViewPineEditorHostAnchors(collectedElements, {
    pineExpectedScriptName: expectedScriptName
  });
  const matchedAnchorsNeedDiagnostic = evidenceMode === 'save-status' && isTradingViewPineTitleOnlyAnchorSet(anchors);
  const documentProbe = anchors.length === 0
    ? await collectTradingViewPineEditorDocumentHostElements(hwnd, scanBounds, {
        timeout,
        pineExpectedScriptName: expectedScriptName
      })
    : null;
  const documentProbeElements = Array.isArray(documentProbe?.elements)
    ? documentProbe.elements
    : [];
  const documentProbeAttempts = Array.isArray(documentProbe?.attempts)
    ? documentProbe.attempts
    : [];
  const documentProbeSignals = Array.isArray(documentProbe?.signals)
    ? documentProbe.signals
    : [];
  const documentProbeRoots = Array.isArray(documentProbe?.rootSummaries)
    ? documentProbe.rootSummaries
    : [];
  const documentProbeElementSummaries = Array.isArray(documentProbe?.elementSummaries)
    ? documentProbe.elementSummaries
    : [];
  const documentAnchors = anchors.length === 0
    ? collectTradingViewPineEditorHostAnchors(documentProbeElements, {
        pineExpectedScriptName: expectedScriptName
      })
    : [];
  const pointProbe = allowPointProbe && anchors.length === 0 && documentAnchors.length === 0
    ? await collectTradingViewPineEditorPointProbeElements(hwnd, scanBounds, { timeout })
    : null;
  const pointProbeElements = Array.isArray(pointProbe?.elements)
    ? pointProbe.elements
    : [];
  const pointProbeAttempts = Array.isArray(pointProbe?.attempts)
    ? pointProbe.attempts
    : [];
  const pointAnchors = anchors.length === 0 && documentAnchors.length === 0
    ? collectTradingViewPineEditorHostAnchors(pointProbeElements, {
        pineExpectedScriptName: expectedScriptName
      })
    : [];
  const matchedAnchors = anchors.length > 0
    ? anchors
    : documentAnchors.length > 0
      ? documentAnchors
      : pointAnchors;
  const diagnosticHostScan = allowDiagnosticScan && (matchedAnchors.length === 0 || matchedAnchorsNeedDiagnostic)
    ? await collectTradingViewPineEditorDiagnosticHostElements(hwnd, windowInfo, {
        timeout,
        pineExpectedScriptName: expectedScriptName
      })
    : null;
  const diagnosticAnchors = (matchedAnchors.length === 0 || matchedAnchorsNeedDiagnostic)
    ? collectTradingViewPineEditorHostAnchors(diagnosticHostScan?.elements || [], {
        pineExpectedScriptName: expectedScriptName
      })
    : [];
  const diagnosticSignals = Array.isArray(diagnosticHostScan?.signals)
    ? diagnosticHostScan.signals
    : [];
  const diagnosticAttempts = Array.isArray(diagnosticHostScan?.attempts)
    ? diagnosticHostScan.attempts
    : [];
  const diagnosticElements = Array.isArray(diagnosticHostScan?.elementSummaries)
    ? diagnosticHostScan.elementSummaries
    : [];
  const diagnosticBounds = Array.isArray(diagnosticHostScan?.diagnosticBounds)
    ? diagnosticHostScan.diagnosticBounds
    : [];
  const finalAnchors = matchedAnchorsNeedDiagnostic
    ? mergeTradingViewPineAnchorMatches(matchedAnchors, diagnosticAnchors)
    : (matchedAnchors.length > 0 ? matchedAnchors : diagnosticAnchors);
  if (!finalAnchors.length) {
    if (rendererProof?.active === true) {
      return {
        active: true,
        foreground: windowInfo,
        windowInfo,
        searchBounds: scanBounds[0]?.bounds || null,
        scanBounds,
        scanAttempts,
        documentProbeAttempts: documentProbeAttempts.slice(0, 8),
        documentProbeSignals,
        documentProbeRoots,
        documentProbeElements: documentProbeElementSummaries,
        pointProbeAttempts: pointProbeAttempts.slice(0, 12),
        pointProbeUsedWindowScopedHost: pointProbe?.usedWindowScopedHost === true,
        pointProbeUsedGlobalFallback: pointProbe?.usedGlobalFallback === true,
        pointProbeElements: pointProbeElements.slice(0, 8),
        diagnosticBounds,
        diagnosticAttempts: diagnosticAttempts.slice(0, 12),
        diagnosticSignals,
        diagnosticElements,
        matchedBy: rendererProof.matchedBy || 'chromium-cdp-dom',
        element: null,
        anchorText: rendererProof.anchorText || null,
        visibleAnchors: rendererVisibleAnchorEntries.map((entry) => entry?.text).filter(Boolean).slice(0, 8),
        visibleAnchorEntries: rendererVisibleAnchorEntries,
        reason: expectedScriptName ? 'save-title-unverified' : null,
        rendererProof
      };
    }

    return {
      active: false,
      foreground: windowInfo,
      windowInfo,
      searchBounds: scanBounds[0]?.bounds || null,
      scanBounds,
      scanAttempts,
      documentProbeAttempts: documentProbeAttempts.slice(0, 8),
      documentProbeSignals,
      documentProbeRoots,
      documentProbeElements: documentProbeElementSummaries,
      pointProbeAttempts: pointProbeAttempts.slice(0, 12),
      pointProbeUsedWindowScopedHost: pointProbe?.usedWindowScopedHost === true,
      pointProbeUsedGlobalFallback: pointProbe?.usedGlobalFallback === true,
      pointProbeElements: pointProbeElements.slice(0, 8),
      diagnosticBounds,
      diagnosticAttempts: diagnosticAttempts.slice(0, 12),
      diagnosticSignals,
      diagnosticElements,
      visibleAnchors: [],
      visibleAnchorEntries: [],
      reason: rendererProof?.available === false
        ? (rendererProof.reason || 'renderer-proof-unavailable')
        : 'no-visible-pine-anchor',
      rendererProof
    };
  }

  const finalMatchedBy = anchors.length > 0
    ? (/panel-header/i.test(String(matchedScanId || ''))
      ? 'uia-host-pine-surface-header-scan'
      : 'uia-host-pine-surface-scan')
    : (documentAnchors.length > 0
      ? 'uia-host-pine-surface-accessibility-probe'
      : (pointAnchors.length > 0
      ? 'uia-host-pine-surface-point-sample'
      : 'uia-host-pine-surface-diagnostic-scan'));
  const visibleAnchorEntries = summarizeTradingViewPineVisibleAnchorEntries(finalAnchors, finalMatchedBy);

  return {
    active: true,
    foreground: windowInfo,
    windowInfo,
    searchBounds: scanBounds[0]?.bounds || null,
    scanBounds,
    scanAttempts,
    documentProbeAttempts: documentProbeAttempts.slice(0, 8),
    documentProbeSignals,
    documentProbeRoots,
    documentProbeElements: documentProbeElementSummaries,
    pointProbeAttempts: pointProbeAttempts.slice(0, 12),
    pointProbeUsedWindowScopedHost: pointProbe?.usedWindowScopedHost === true,
    pointProbeUsedGlobalFallback: pointProbe?.usedGlobalFallback === true,
    diagnosticBounds,
    diagnosticAttempts: diagnosticAttempts.slice(0, 12),
    diagnosticSignals,
    diagnosticElements,
    matchedBy: finalMatchedBy,
    element: finalAnchors[0].element,
    anchorText: finalAnchors[0].text,
    pointProbeElements: pointProbeElements.slice(0, 8),
    visibleAnchors: finalAnchors.map((entry) => entry.text).slice(0, 8),
    visibleAnchorEntries,
    rendererProof
  };
}

function getTradingViewPineActivationProofTimeoutMs(options = {}) {
  const configuredTimeout = Number(options?.timeoutMs || options?.timeout || process.env.LIKU_TRADINGVIEW_PINE_ACTIVATION_PROOF_TIMEOUT_MS || 0);
  if (Number.isFinite(configuredTimeout) && configuredTimeout >= MIN_TRADINGVIEW_PINE_ACTIVATION_PROOF_TIMEOUT_MS) {
    return Math.round(configuredTimeout);
  }

  return DEFAULT_TRADINGVIEW_PINE_ACTIVATION_PROOF_TIMEOUT_MS;
}

function isTradingViewSemanticPineIconAction(action = {}) {
  const actionType = String(action?.type || '').trim().toLowerCase();
  const routeId = String(action?.searchSurfaceContract?.id || '').trim().toLowerCase();
  const route = String(action?.searchSurfaceContract?.route || '').trim().toLowerCase();
  const shortcutId = String(action?.tradingViewShortcut?.id || '').trim().toLowerCase();
  const verifyTarget = String(action?.verify?.target || '').trim().toLowerCase();

  return actionType === 'click_element'
    && routeId === 'open-pine-editor'
    && route === 'semantic-icon'
    && (shortcutId === 'open-pine-editor' || verifyTarget === 'pine-editor');
}

function summarizeTradingViewPineActivationForeground(foreground = null) {
  if (!foreground || typeof foreground !== 'object') return null;

  return {
    success: foreground.success !== false,
    hwnd: Number(foreground.hwnd || 0) || 0,
    pid: Number(foreground.pid || foreground.processId || 0) || 0,
    processId: Number(foreground.processId || foreground.pid || 0) || 0,
    processName: normalizeCompactText(foreground.processName || '', 80),
    title: normalizeCompactText(foreground.title || '', 220),
    windowKind: normalizeCompactText(foreground.windowKind || '', 40),
    bounds: normalizeBoundsRect(foreground.bounds || foreground.Bounds || null)
  };
}

function summarizeTradingViewPineActivationWindowInfo(windowInfo = null) {
  if (!windowInfo || typeof windowInfo !== 'object') return null;

  return {
    success: windowInfo.success !== false,
    hwnd: Number(windowInfo.hwnd || 0) || 0,
    pid: Number(windowInfo.pid || windowInfo.processId || 0) || 0,
    processId: Number(windowInfo.processId || windowInfo.pid || 0) || 0,
    processName: normalizeCompactText(windowInfo.processName || '', 80),
    title: normalizeCompactText(windowInfo.title || '', 220),
    windowKind: normalizeCompactText(windowInfo.windowKind || '', 40),
    bounds: normalizeBoundsRect(windowInfo.bounds || windowInfo.Bounds || null)
  };
}

function buildTradingViewPineActivationStructureBounds(windowInfo = {}) {
  const candidates = [];
  const lowerPanelBounds = buildTradingViewPineSurfaceScanBounds(windowInfo);
  const fullWindowBounds = buildTradingViewPineSurfaceDiagnosticBounds(windowInfo)
    .find((entry) => entry?.id === 'full-window-content');

  if (lowerPanelBounds[0]?.bounds) {
    candidates.push({
      id: lowerPanelBounds[0].id || 'panel-header-and-body',
      bounds: lowerPanelBounds[0].bounds,
      view: 'control',
      maxResults: 18,
      maxDepth: 18,
      maxVisited: 1600
    });
  }

  if (fullWindowBounds?.bounds) {
    candidates.push({
      id: fullWindowBounds.id || 'full-window-content',
      bounds: fullWindowBounds.bounds,
      view: 'control',
      maxResults: 28,
      maxDepth: 14,
      maxVisited: 1500
    });
  }

  const seen = new Set();
  return candidates.filter((candidate) => {
    const rect = normalizeBoundsRect(candidate?.bounds || null);
    if (!rect) return false;
    const dedupeKey = `${rect.x}|${rect.y}|${rect.width}|${rect.height}`;
    if (seen.has(dedupeKey)) return false;
    seen.add(dedupeKey);
    return true;
  });
}

function summarizeTradingViewPineActivationFocusLabel(summary = null) {
  if (!summary || typeof summary !== 'object') return null;
  return normalizeCompactText(
    summary.Name
    || summary.AutomationId
    || summary.ClassName
    || summary.ControlType
    || '',
    120
  );
}

function buildTradingViewPineActivationStructureElementKey(summary = {}) {
  if (!summary || typeof summary !== 'object') return '';
  const bounds = summary.Bounds || {};
  return [
    normalizeTradingViewPineAnchorText(summary.Name || ''),
    normalizeTradingViewPineAnchorText(summary.AutomationId || ''),
    normalizeTradingViewPineAnchorText(summary.ClassName || ''),
    normalizeTradingViewPineAnchorText(summary.ControlType || ''),
    Math.round((Number(bounds.X || 0) || 0) / 24),
    Math.round((Number(bounds.Y || 0) || 0) / 24),
    Math.round((Number(bounds.Width || 0) || 0) / 24),
    Math.round((Number(bounds.Height || 0) || 0) / 24)
  ].join('|');
}

function isLikelyTradingViewPineActivationStructureNoise(summary = {}) {
  if (!summary || typeof summary !== 'object') return true;

  const label = normalizeCompactText(summary.Name || summary.AutomationId || '', 120) || '';
  const haystack = normalizeTradingViewPineAnchorText([
    summary.Name || '',
    summary.AutomationId || '',
    summary.ClassName || '',
    summary.Value || ''
  ].join(' '));
  const controlType = normalizeTradingViewPineAnchorText(summary.ControlType || '');
  const patterns = Array.isArray(summary.Patterns) ? summary.Patterns : [];
  const hasPatternSignal = patterns.some((pattern) => /invoke|value|text|selection/i.test(String(pattern || '')));

  if (/live stock index futures forex and bitcoin charts on tradingview/.test(haystack)) {
    return true;
  }

  if (/^[+\-]?\d+(?:[.,]\d+)*(?:%|k|m|b)?$/i.test(label)) {
    return true;
  }

  if (/^(?:open|high|low|close|vol|volume)\b/i.test(label)) {
    return true;
  }

  if (/^[a-z0-9._-]{1,16}\s*[▲▼]/i.test(label)) {
    return true;
  }

  if (!label && !hasPatternSignal && !summary.HasKeyboardFocus && !summary.IsFocusable && !summary.IsClickable) {
    return true;
  }

  if (/controltype\.(?:document|pane|custom)$/i.test(controlType) && !label && !summary.HasKeyboardFocus) {
    return true;
  }

  return false;
}

function summarizeTradingViewPineActivationStructureElement(summary = null) {
  if (!summary || typeof summary !== 'object') return null;
  return {
    label: summarizeTradingViewPineActivationFocusLabel(summary),
    controlType: normalizeCompactText(summary.ControlType || '', 60),
    automationId: normalizeCompactText(summary.AutomationId || '', 80),
    className: normalizeCompactText(summary.ClassName || '', 80),
    bounds: normalizeBoundsRect(summary.Bounds || null)
  };
}

async function collectTradingViewPineActivationStructureHostSample(windowHandle = 0, windowInfo = {}, options = {}) {
  const hwnd = Number(windowHandle || 0) || 0;
  const bounds = buildTradingViewPineActivationStructureBounds(windowInfo);
  const emptyResult = {
    bounds,
    attempts: [],
    elements: [],
    elementKeys: [],
    fingerprint: null
  };

  if (!hwnd || bounds.length === 0) {
    return emptyResult;
  }

  const totalTimeout = Number.isFinite(Number(options?.timeout || options?.timeoutMs))
    ? Math.max(200, Math.min(Math.round(Number(options.timeout || options.timeoutMs)), 1200))
    : 520;
  const perAttemptTimeout = Math.max(120, Math.min(360, Math.round(totalTimeout / Math.max(1, bounds.length))));
  const seen = new Set();
  const collected = [];
  const attempts = [];

  for (const plan of bounds) {
    const scanResult = await findElementsByWindowWithHost('', {
      windowHandle: hwnd,
      timeout: perAttemptTimeout,
      maxResults: plan.maxResults,
      maxDepth: plan.maxDepth,
      maxVisited: plan.maxVisited,
      includeDisabled: true,
      includeOffscreen: false,
      bounds: plan.bounds,
      textMode: 'contains',
      view: plan.view,
      skipRootMatch: true
    });

    attempts.push({
      id: plan.id,
      bounds: plan.bounds,
      success: scanResult?.success === true,
      count: Number(scanResult?.count || 0) || 0,
      stats: scanResult?.stats || null,
      error: scanResult?.error || null
    });

    if (!scanResult?.success || !Array.isArray(scanResult.elements)) {
      continue;
    }

    for (const element of scanResult.elements) {
      const summary = summarizeTradingViewPineProbeElement(element);
      if (!summary || isLikelyTradingViewPineActivationStructureNoise(summary)) continue;
      const elementKey = buildTradingViewPineActivationStructureElementKey(summary);
      if (!elementKey || seen.has(elementKey)) continue;
      seen.add(elementKey);
      collected.push(summary);
    }
  }

  const elements = collected
    .sort((left, right) => {
      const leftY = Number(left?.Bounds?.Y || 0) || 0;
      const rightY = Number(right?.Bounds?.Y || 0) || 0;
      if (leftY !== rightY) return leftY - rightY;
      const leftX = Number(left?.Bounds?.X || 0) || 0;
      const rightX = Number(right?.Bounds?.X || 0) || 0;
      if (leftX !== rightX) return leftX - rightX;
      return String(left?.Name || left?.AutomationId || '').localeCompare(String(right?.Name || right?.AutomationId || ''));
    })
    .slice(0, 20)
    .map((summary) => summarizeTradingViewPineActivationStructureElement(summary))
    .filter(Boolean);
  const elementKeys = elements
    .map((summary) => buildTradingViewPineActivationStructureElementKey({
      Name: summary.label || '',
      ControlType: summary.controlType || '',
      AutomationId: summary.automationId || '',
      ClassName: summary.className || '',
      Bounds: summary.bounds || null
    }))
    .filter(Boolean)
    .sort();

  return {
    bounds,
    attempts,
    elements,
    elementKeys,
    fingerprint: elementKeys.length > 0 ? elementKeys.join('||') : null
  };
}

function summarizeTradingViewPineActivationWatcherElement(element = {}) {
  if (!element || typeof element !== 'object') return null;

  return {
    id: normalizeCompactText(element.id || '', 160),
    name: normalizeCompactText(element.name || '', 120),
    type: normalizeCompactText(element.type || '', 60),
    automationId: normalizeCompactText(element.automationId || '', 80),
    className: normalizeCompactText(element.className || '', 80),
    windowHandle: Number(element.windowHandle || 0) || 0,
    bounds: normalizeBoundsRect(element.bounds || element.Bounds || null)
  };
}

function isLikelyTradingViewPineActivationWatcherNoise(summary = {}) {
  if (!summary || typeof summary !== 'object') return true;

  const label = normalizeCompactText(summary.name || summary.automationId || '', 120) || '';
  const haystack = normalizeTradingViewPineAnchorText([
    summary.name || '',
    summary.automationId || '',
    summary.className || '',
    summary.type || ''
  ].join(' '));

  if (/live stock index futures forex and bitcoin charts on tradingview/.test(haystack)) {
    return true;
  }

  if (/^[+\-]?\d+(?:[.,]\d+)*(?:%|k|m|b)?$/i.test(label)) {
    return true;
  }

  if (!label && !/button|edit|text|tabitem|menuitem|listitem|combobox|treeitem/i.test(String(summary.type || ''))) {
    return true;
  }

  return false;
}

function buildTradingViewPineActivationWatcherElementKey(summary = {}) {
  if (!summary || typeof summary !== 'object') return '';
  const bounds = summary.bounds || {};
  return [
    normalizeTradingViewPineAnchorText(summary.id || ''),
    normalizeTradingViewPineAnchorText(summary.name || ''),
    normalizeTradingViewPineAnchorText(summary.automationId || ''),
    normalizeTradingViewPineAnchorText(summary.type || ''),
    Math.round((Number(bounds.x || 0) || 0) / 24),
    Math.round((Number(bounds.y || 0) || 0) / 24),
    Math.round((Number(bounds.width || 0) || 0) / 24),
    Math.round((Number(bounds.height || 0) || 0) / 24)
  ].join('|');
}

function summarizeTradingViewPineActivationWatcherDiffElement(summary = null) {
  if (!summary || typeof summary !== 'object') return null;
  return {
    label: normalizeCompactText(summary.name || summary.automationId || summary.type || '', 120),
    controlType: normalizeCompactText(summary.type || '', 60),
    automationId: normalizeCompactText(summary.automationId || '', 80),
    className: normalizeCompactText(summary.className || '', 80),
    bounds: normalizeBoundsRect(summary.bounds || null)
  };
}

async function collectTradingViewPineActivationWatcherSnapshot(windowHandle = 0, options = {}) {
  let getUIWatcher = null;
  try {
    ({ getUIWatcher } = require('./ai-service/ui-context'));
  } catch {
    return {
      available: false,
      reason: 'watcher-unavailable'
    };
  }

  const watcher = typeof getUIWatcher === 'function' ? getUIWatcher() : null;
  if (!watcher?.cache) {
    return {
      available: false,
      reason: 'watcher-not-running'
    };
  }

  const hwnd = Number(windowHandle || 0) || 0;
  let waitedForFreshState = null;
  if (options.waitForFreshState === true && typeof watcher.waitForFreshState === 'function') {
    try {
      const timeoutMs = Math.max(80, Math.min(420, Math.round(Number(options?.timeoutMs || 0) || 240)));
      const freshState = await watcher.waitForFreshState({
        targetHwnd: hwnd,
        sinceTs: Number(options?.sinceTs || 0) || 0,
        timeoutMs
      });
      waitedForFreshState = {
        fresh: freshState?.fresh === true,
        timedOut: freshState?.timedOut === true,
        immediate: freshState?.immediate === true,
        lastUpdate: Number(freshState?.lastUpdate || 0) || 0
      };
    } catch {}
  }

  const lastUpdate = Number(watcher.cache.lastUpdate || 0) || 0;
  const ageMs = lastUpdate > 0 ? Math.max(0, Date.now() - lastUpdate) : Number.POSITIVE_INFINITY;
  const activeWindow = watcher.cache.activeWindow || null;
  const activeHwnd = Number(activeWindow?.hwnd || 0) || 0;
  const allElements = Array.isArray(watcher.cache.elements) ? watcher.cache.elements : [];
  const scopedElements = hwnd > 0
    ? allElements.filter((element) => Number(element?.windowHandle || 0) === hwnd)
    : allElements.slice();
  const elements = scopedElements
    .map((element) => summarizeTradingViewPineActivationWatcherElement(element))
    .filter((summary) => summary && !isLikelyTradingViewPineActivationWatcherNoise(summary))
    .sort((left, right) => {
      const leftY = Number(left?.bounds?.y || 0) || 0;
      const rightY = Number(right?.bounds?.y || 0) || 0;
      if (leftY !== rightY) return leftY - rightY;
      const leftX = Number(left?.bounds?.x || 0) || 0;
      const rightX = Number(right?.bounds?.x || 0) || 0;
      if (leftX !== rightX) return leftX - rightX;
      return String(left?.name || left?.automationId || '').localeCompare(String(right?.name || right?.automationId || ''));
    })
    .slice(0, 20);
  const elementKeys = elements
    .map((summary) => buildTradingViewPineActivationWatcherElementKey(summary))
    .filter(Boolean)
    .sort();

  return {
    available: true,
    reason: null,
    activeMatchesWindow: hwnd > 0 ? activeHwnd === hwnd : true,
    activeWindow: activeWindow
      ? {
          hwnd: activeHwnd,
          title: normalizeCompactText(activeWindow.title || '', 220),
          processName: normalizeCompactText(activeWindow.processName || '', 80),
          windowKind: normalizeCompactText(activeWindow.windowKind || '', 40),
          bounds: normalizeBoundsRect(activeWindow.bounds || null)
        }
      : null,
    lastUpdate,
    ageMs: Number.isFinite(ageMs) ? ageMs : null,
    updateCount: Number(watcher.cache.updateCount || 0) || 0,
    elementCount: scopedElements.length,
    elements,
    elementKeys,
    fingerprint: elementKeys.length > 0 ? elementKeys.join('||') : null,
    waitedForFreshState
  };
}

function buildTradingViewPineActivationWatcherTransition(beforeWatcher = null, afterWatcher = null) {
  const before = beforeWatcher && typeof beforeWatcher === 'object' ? beforeWatcher : null;
  const after = afterWatcher && typeof afterWatcher === 'object' ? afterWatcher : null;
  const beforeWatcherFingerprint = String(before?.fingerprint || '').trim();
  const afterWatcherFingerprint = String(after?.fingerprint || '').trim();
  const beforeElements = Array.isArray(before?.elements) ? before.elements : [];
  const afterElements = Array.isArray(after?.elements) ? after.elements : [];
  const elementDiff = buildTradingViewPineActivationDiffEntries(
    Array.isArray(before?.elementKeys) ? before.elementKeys : [],
    Array.isArray(after?.elementKeys) ? after.elementKeys : [],
    beforeElements.map((entry) => summarizeTradingViewPineActivationWatcherDiffElement(entry)).filter(Boolean),
    afterElements.map((entry) => summarizeTradingViewPineActivationWatcherDiffElement(entry)).filter(Boolean)
  );
  const beforeActiveWindow = before?.activeWindow || null;
  const afterActiveWindow = after?.activeWindow || null;
  const activeWindowChanged = Number(beforeActiveWindow?.hwnd || 0) !== Number(afterActiveWindow?.hwnd || 0)
    || String(beforeActiveWindow?.title || '') !== String(afterActiveWindow?.title || '')
    || String(beforeActiveWindow?.processName || '') !== String(afterActiveWindow?.processName || '');
  const updateDelta = (Number(after?.updateCount || 0) || 0) - (Number(before?.updateCount || 0) || 0);
  const fingerprintChanged = (!!beforeWatcherFingerprint || !!afterWatcherFingerprint)
    && beforeWatcherFingerprint !== afterWatcherFingerprint;
  const elementChangeObserved = elementDiff.added.length > 0 || elementDiff.removed.length > 0;
  const changed = fingerprintChanged || elementChangeObserved || updateDelta !== 0 || activeWindowChanged;
  const available = before?.available === true || after?.available === true;
  const ambiguous = after?.available !== true
    || after?.activeMatchesWindow === false
    || after?.waitedForFreshState?.timedOut === true;

  return {
    available,
    changed,
    meaningful: after?.available === true && changed,
    ambiguous,
    updateDelta,
    fingerprintChanged,
    activeWindowChanged,
    beforeElementCount: Number(before?.elementCount || 0) || 0,
    afterElementCount: Number(after?.elementCount || 0) || 0,
    added: elementDiff.added,
    removed: elementDiff.removed
  };
}

function shouldRevalidateTradingViewPineActivationHostEvidence(options = {}) {
  const proofStrategy = String(options?.proofStrategy || '').trim().toLowerCase();
  const watcher = options?.watcher && typeof options.watcher === 'object'
    ? options.watcher
    : null;
  const watcherTransition = options?.watcherTransition && typeof options.watcherTransition === 'object'
    ? options.watcherTransition
    : null;
  const phase = String(options?.phase || '').trim().toLowerCase() || 'after';

  if (proofStrategy !== 'watcher-first') {
    return {
      attempted: true,
      reason: 'legacy-host-proof'
    };
  }

  if (watcher?.available !== true) {
    return {
      attempted: true,
      reason: 'watcher-unavailable'
    };
  }

  if (phase === 'before') {
    return {
      attempted: false,
      reason: 'watcher-baseline'
    };
  }

  if (watcherTransition?.changed === true) {
    return {
      attempted: true,
      reason: 'watcher-delta'
    };
  }

  if (watcherTransition?.ambiguous === true) {
    return {
      attempted: true,
      reason: 'watcher-ambiguous'
    };
  }

  return {
    attempted: false,
    reason: 'watcher-stable-no-delta'
  };
}

function summarizeTradingViewPineSurfaceSnapshot(probe = null) {
  if (!probe || typeof probe !== 'object') return null;

  return {
    active: probe.active === true,
    reason: normalizeCompactText(probe.reason || '', 140),
    anchorText: normalizeCompactText(probe.anchorText || '', 120),
    matchedBy: normalizeCompactText(probe.matchedBy || '', 80),
    visibleAnchors: Array.isArray(probe.visibleAnchors) ? probe.visibleAnchors.slice(0, 8) : [],
    diagnosticSignals: Array.isArray(probe.diagnosticSignals) ? probe.diagnosticSignals.slice(0, 8) : [],
    diagnosticElements: Array.isArray(probe.diagnosticElements) ? probe.diagnosticElements.slice(0, 8) : [],
    pointProbeAttempts: Array.isArray(probe.pointProbeAttempts) ? probe.pointProbeAttempts.slice(0, 8) : [],
    diagnosticAttempts: Array.isArray(probe.diagnosticAttempts) ? probe.diagnosticAttempts.slice(0, 8) : [],
    rendererProof: summarizeTradingViewPineRendererProof(probe.rendererProof || null)
  };
}

async function captureTradingViewPineActivationSnapshot(options = {}) {
  const explicitWindowHandle = Number(options?.windowHandle || options?.hwnd || 0) || 0;
  const totalTimeout = getTradingViewPineActivationProofTimeoutMs(options);
  const proofStrategy = String(options?.proofStrategy || '').trim().toLowerCase() || 'legacy';
  const previousSnapshot = options?.previousSnapshot && typeof options.previousSnapshot === 'object'
    ? options.previousSnapshot
    : null;
  const phase = String(options?.phase || '').trim().toLowerCase() || (previousSnapshot ? 'after' : 'before');
  const watcherTimeoutMs = options.waitForWatcherState === true
    ? Math.max(90, Math.min(360, Math.round(totalTimeout * 0.25)))
    : 0;
  const watcher = await collectTradingViewPineActivationWatcherSnapshot(explicitWindowHandle, {
    waitForFreshState: options.waitForWatcherState === true,
    sinceTs: Number(options?.watcherSinceTs || options?.sinceTs || 0) || 0,
    timeoutMs: watcherTimeoutMs
  });
  const watcherTransition = buildTradingViewPineActivationWatcherTransition(previousSnapshot?.watcher, watcher);
  const inheritedWindowInfo = summarizeTradingViewPineActivationWindowInfo(
    options?.windowInfo
    || options?.boundWindowInfo
    || previousSnapshot?.windowInfo
    || null
  );
  const watcherForeground = summarizeTradingViewPineActivationForeground(watcher?.activeWindow || null);
  let foregroundSummary = watcherForeground;
  let windowInfo = watcher?.available === true
    && watcher?.activeMatchesWindow !== false
    && isTradingViewForegroundWindow(watcher?.activeWindow)
    ? summarizeTradingViewPineActivationWindowInfo(watcher.activeWindow)
    : null;

  if (!windowInfo?.success && inheritedWindowInfo?.success) {
    windowInfo = inheritedWindowInfo;
  }

  if (!windowInfo?.success && explicitWindowHandle > 0) {
    try {
      const candidate = await getWindowInfoByHandle(explicitWindowHandle);
      if (candidate?.success) {
        windowInfo = candidate;
      }
    } catch {}
  }

  if (!foregroundSummary?.success && watcher?.available !== true) {
    try {
      foregroundSummary = summarizeTradingViewPineActivationForeground(await getForegroundWindowInfo());
    } catch {}
  }

  if (!windowInfo?.success && foregroundSummary?.success && isTradingViewForegroundWindow(foregroundSummary)) {
    windowInfo = foregroundSummary;
  }

  if (!windowInfo?.success) {
    return {
      captured: false,
      reason: 'window-unresolved',
      windowHandle: explicitWindowHandle || 0,
      foreground: foregroundSummary,
      windowInfo: inheritedWindowInfo || null,
      proofStrategy,
      hostRevalidation: {
        attempted: false,
        reason: 'window-unresolved'
      },
      watcher,
      watcherTransition
    };
  }

  if (!isTradingViewForegroundWindow(windowInfo)) {
    return {
      captured: false,
      reason: 'window-not-tradingview',
      windowHandle: Number(windowInfo?.hwnd || explicitWindowHandle || 0) || 0,
      foreground: foregroundSummary,
      windowInfo: summarizeTradingViewPineActivationWindowInfo(windowInfo),
      proofStrategy,
      hostRevalidation: {
        attempted: false,
        reason: 'window-not-tradingview'
      },
      watcher,
      watcherTransition
    };
  }

  const hwnd = Number(windowInfo?.hwnd || explicitWindowHandle || 0) || 0;
  const hostRevalidation = shouldRevalidateTradingViewPineActivationHostEvidence({
    proofStrategy,
    phase,
    watcher,
    watcherTransition
  });
  let focusedElementProbe = {
    success: false,
    focused: false,
    reason: hostRevalidation.reason
  };
  let structure = {
    bounds: [],
    attempts: [],
    elements: [],
    elementKeys: [],
    fingerprint: null,
    skipped: true,
    skipReason: hostRevalidation.reason
  };
  let pineSurface = {
    active: false,
    reason: hostRevalidation.reason,
    anchorText: null,
    matchedBy: null,
    visibleAnchors: [],
    diagnosticSignals: [],
    diagnosticElements: [],
    pointProbeAttempts: [],
    diagnosticAttempts: []
  };
  let rendererProof = null;

  if (hostRevalidation.attempted) {
    focusedElementProbe = await getFocusedElementInWindowWithHost(hwnd);
    if (proofStrategy !== 'watcher-first' || watcher?.available !== true) {
      structure = await collectTradingViewPineActivationStructureHostSample(hwnd, windowInfo, {
        timeoutMs: Math.max(220, Math.min(640, Math.round(totalTimeout * 0.45)))
      });
    }
    const pineSurfaceProbe = await probeTradingViewPineEditorSurface({
      windowHandle: hwnd,
      windowInfo,
      foreground: foregroundSummary,
      resolveWindowState: false,
      timeout: Math.max(240, Math.min(700, Math.round(totalTimeout * 0.55))),
      scanViews: ['control'],
      minScanAttemptTimeout: 160,
      allowPointProbe: false,
      allowDiagnosticScan: false,
      cdpPort: options?.cdpPort || 0,
      cdpDependencies: options?.cdpDependencies || null
    });
    pineSurface = summarizeTradingViewPineSurfaceSnapshot(pineSurfaceProbe) || pineSurface;
    rendererProof = summarizeTradingViewPineRendererProof(pineSurfaceProbe?.rendererProof || null);
  }

  return {
    captured: true,
    reason: null,
    collectedAt: Date.now(),
    windowHandle: hwnd,
    foreground: foregroundSummary,
    windowInfo: summarizeTradingViewPineActivationWindowInfo(windowInfo),
    proofStrategy,
    hostRevalidation,
    pineSurface,
    rendererProof,
    focusedElementAvailable: focusedElementProbe?.focused === true,
    focusedElementReason: normalizeCompactText(focusedElementProbe?.reason || '', 80),
    focusedElement: summarizeTradingViewPineProbeElement(focusedElementProbe?.element || null),
    focusedElementKey: buildTradingViewPineActivationStructureElementKey(
      summarizeTradingViewPineProbeElement(focusedElementProbe?.element || null) || {}
    ),
    structure,
    watcher,
    watcherTransition
  };
}

function buildTradingViewPineActivationForegroundKey(foreground = null) {
  if (!foreground || typeof foreground !== 'object') return '';
  return [
    Number(foreground.hwnd || 0) || 0,
    normalizeTradingViewPineAnchorText(foreground.processName || ''),
    normalizeTradingViewPineAnchorText(foreground.title || ''),
    normalizeTradingViewPineAnchorText(foreground.windowKind || '')
  ].join('|');
}

function summarizeTradingViewPineActivationForegroundLabel(foreground = null) {
  if (!foreground || typeof foreground !== 'object') return null;
  return normalizeCompactText([
    foreground.processName || '',
    foreground.title || '',
    foreground.windowKind || ''
  ].filter(Boolean).join(' | '), 220);
}

function buildTradingViewPineActivationDiffEntries(beforeKeys = [], afterKeys = [], beforeElements = [], afterElements = []) {
  const normalizedBeforeElements = Array.isArray(beforeElements) ? beforeElements : [];
  const normalizedAfterElements = Array.isArray(afterElements) ? afterElements : [];
  const computedBeforeKeys = normalizedBeforeElements.map((entry) => buildTradingViewPineActivationStructureElementKey({
    Name: entry?.label || '',
    ControlType: entry?.controlType || '',
    AutomationId: entry?.automationId || '',
    ClassName: entry?.className || '',
    Bounds: entry?.bounds || null
  }));
  const computedAfterKeys = normalizedAfterElements.map((entry) => buildTradingViewPineActivationStructureElementKey({
    Name: entry?.label || '',
    ControlType: entry?.controlType || '',
    AutomationId: entry?.automationId || '',
    ClassName: entry?.className || '',
    Bounds: entry?.bounds || null
  }));
  const effectiveBeforeKeys = Array.isArray(beforeKeys) && beforeKeys.length > 0 ? beforeKeys : computedBeforeKeys;
  const effectiveAfterKeys = Array.isArray(afterKeys) && afterKeys.length > 0 ? afterKeys : computedAfterKeys;
  const beforeSet = new Set(effectiveBeforeKeys);
  const afterSet = new Set(effectiveAfterKeys);
  const beforeMap = new Map();
  const afterMap = new Map();

  computedBeforeKeys.forEach((key, index) => {
    if (key) beforeMap.set(key, normalizedBeforeElements[index]);
    const providedKey = String(effectiveBeforeKeys[index] || '').trim();
    if (providedKey) beforeMap.set(providedKey, normalizedBeforeElements[index]);
  });
  computedAfterKeys.forEach((key, index) => {
    if (key) afterMap.set(key, normalizedAfterElements[index]);
    const providedKey = String(effectiveAfterKeys[index] || '').trim();
    if (providedKey) afterMap.set(providedKey, normalizedAfterElements[index]);
  });

  const added = Array.from(afterSet)
    .filter((key) => !beforeSet.has(key))
    .map((key) => afterMap.get(key))
    .filter(Boolean)
    .slice(0, 8);
  const removed = Array.from(beforeSet)
    .filter((key) => !afterSet.has(key))
    .map((key) => beforeMap.get(key))
    .filter(Boolean)
    .slice(0, 8);

  return { added, removed };
}

function buildTradingViewPineActivationTransitionProof(beforeSnapshot = null, afterSnapshot = null, options = {}) {
  const before = beforeSnapshot && typeof beforeSnapshot === 'object' ? beforeSnapshot : null;
  const after = afterSnapshot && typeof afterSnapshot === 'object' ? afterSnapshot : null;
  const signals = [];
  const watcherTransition = buildTradingViewPineActivationWatcherTransition(before?.watcher, after?.watcher);
  const addSignal = (kind, details = {}) => {
    signals.push({ kind, ...details });
  };

  if (after?.pineSurface?.active === true && before?.pineSurface?.active !== true) {
    addSignal('pine-surface-observed', {
      anchorText: after?.pineSurface?.anchorText || null,
      matchedBy: after?.pineSurface?.matchedBy || null
    });
  }

  if (
    after?.rendererProof?.active === true
    && before?.rendererProof?.active !== true
    && !signals.some((signal) => signal?.kind === 'pine-surface-observed')
  ) {
    addSignal('renderer-surface-observed', {
      anchorText: after?.rendererProof?.anchorText || null,
      matchedBy: after?.rendererProof?.matchedBy || null,
      port: Number(after?.rendererProof?.port || 0) || 0
    });
  }

  if (after?.rendererProof?.applicable === true && after?.rendererProof?.available !== true && after?.rendererProof?.reason) {
    addSignal('renderer-proof-unavailable', {
      reason: after.rendererProof.reason,
      port: Number(after?.rendererProof?.port || 0) || 0
    });
  }

  const beforeForegroundKey = buildTradingViewPineActivationForegroundKey(before?.foreground);
  const afterForegroundKey = buildTradingViewPineActivationForegroundKey(after?.foreground);
  if (beforeForegroundKey && afterForegroundKey && beforeForegroundKey !== afterForegroundKey) {
    addSignal('foreground-changed', {
      before: summarizeTradingViewPineActivationForegroundLabel(before?.foreground),
      after: summarizeTradingViewPineActivationForegroundLabel(after?.foreground)
    });
  }

  const beforeFocusKey = String(before?.focusedElementKey || '').trim();
  const afterFocusKey = String(after?.focusedElementKey || '').trim();
  if (beforeFocusKey || afterFocusKey) {
    if (beforeFocusKey !== afterFocusKey) {
      addSignal('focused-element-changed', {
        before: summarizeTradingViewPineActivationFocusLabel(before?.focusedElement),
        after: summarizeTradingViewPineActivationFocusLabel(after?.focusedElement)
      });
    }
  }

  const beforeStructureKeys = Array.isArray(before?.structure?.elementKeys) ? before.structure.elementKeys : [];
  const afterStructureKeys = Array.isArray(after?.structure?.elementKeys) ? after.structure.elementKeys : [];
  const structureDiff = buildTradingViewPineActivationDiffEntries(
    beforeStructureKeys,
    afterStructureKeys,
    before?.structure?.elements || [],
    after?.structure?.elements || []
  );
  if (structureDiff.added.length > 0 || structureDiff.removed.length > 0) {
    addSignal('uia-structure-changed', structureDiff);
  }

  if (watcherTransition.available && watcherTransition.changed) {
    addSignal('watcher-state-changed', {
      activeMatchesWindow: after?.watcher?.activeMatchesWindow !== false,
      updateDelta: watcherTransition.updateDelta,
      beforeElementCount: watcherTransition.beforeElementCount,
      afterElementCount: watcherTransition.afterElementCount,
      added: watcherTransition.added,
      removed: watcherTransition.removed
    });
  }

  const pineSurfaceObserved = after?.pineSurface?.active === true || after?.rendererProof?.active === true;
  const tradingViewForegroundLost = !!after?.foreground?.success && !isTradingViewForegroundWindow(after.foreground);
  const rendererProofUnavailable = after?.rendererProof?.applicable === true
    && after?.rendererProof?.available !== true
    && !!String(after?.rendererProof?.reason || '').trim();
  const structuralChangeObserved = signals.some((signal) =>
    signal.kind === 'uia-structure-changed'
    || signal.kind === 'focused-element-changed'
    || signal.kind === 'watcher-state-changed'
  );
  const observedChange = signals.length > 0;

  let disposition = 'no-window-state-change-observed';
  let likelyMeaning = 'No bounded foreground, focus, watcher, or structure change was observed after the semantic Pine invoke. That suggests the current click path did not activate Pine in this live TradingView state.';
  if (pineSurfaceObserved) {
    disposition = 'pine-surface-observed';
    likelyMeaning = after?.rendererProof?.active === true
      ? 'The semantic Pine invoke produced a renderer-proved Pine surface inside the bound TradingView window.'
      : 'The semantic Pine invoke produced a UIA-visible Pine surface inside the bound TradingView window.';
  } else if (tradingViewForegroundLost) {
    disposition = 'focus-drift-without-pine-surface';
    likelyMeaning = 'Foreground drifted away from TradingView before any Pine surface became visible, so the semantic Pine click did not complete in a stable app state.';
  } else if (rendererProofUnavailable) {
    disposition = 'renderer-proof-unavailable';
    likelyMeaning = `The semantic Pine post-invoke proof could not query Chromium renderer state because ${after?.rendererProof?.reason || 'renderer proof was unavailable'}. Repeated Ctrl+E recovery is not trustworthy until TradingView is launched with remote debugging and renderer accessibility enabled.`;
  } else if (structuralChangeObserved) {
    disposition = 'window-state-changed-without-pine-surface';
    likelyMeaning = 'TradingView state changed after the semantic Pine click, but Pine anchors still did not become UIA-visible. That suggests a non-obvious surface or a surface that Chromium/UIA is not exposing under current conditions.';
  } else if (signals.some((signal) => signal.kind === 'foreground-changed')) {
    disposition = 'foreground-changed-without-pine-surface';
    likelyMeaning = 'Foreground metadata changed after the semantic Pine click, but no TradingView Pine surface or internal UIA structure change was observed.';
  }

  if (
    disposition === 'no-window-state-change-observed'
    && after?.proofStrategy === 'watcher-first'
    && after?.hostRevalidation?.attempted === false
    && watcherTransition.available
    && watcherTransition.changed !== true
  ) {
    likelyMeaning = 'Watcher-first Pine proof observed no fresh watcher delta after the semantic Pine click, so deep host revalidation was skipped to keep the steady-state path bounded.';
  }

  if (!before?.captured && !after?.captured) {
    disposition = 'proof-unavailable';
    likelyMeaning = after?.reason === 'window-not-tradingview'
      ? 'The semantic Pine post-invoke proof could not bind a TradingView window after the click.'
      : 'The semantic Pine post-invoke proof could not resolve a TradingView window in the current app state.';
  }

  return {
    applicable: true,
    route: 'semantic-icon',
    expectedSurface: 'pine-editor',
    windowHandle: Number(after?.windowHandle || before?.windowHandle || options?.windowHandle || 0) || 0,
    proofStrategy: String(after?.proofStrategy || before?.proofStrategy || 'legacy'),
    actionSucceeded: options?.actionSucceeded === true,
    observedChange,
    pineSurfaceObserved,
    disposition,
    likelyMeaning,
    error: options?.error || null,
    hostRevalidation: after?.hostRevalidation || null,
    rendererProof: after?.rendererProof || before?.rendererProof || null,
    signals: signals.slice(0, 8),
    before,
    after
  };
}

async function prepareTradingViewPineActivationProofContext(action = {}) {
  if (!isTradingViewSemanticPineIconAction(action)) {
    return null;
  }

  const timeoutMs = getTradingViewPineActivationProofTimeoutMs();
  const windowHandle = Number(
    action?.windowHandle
    || action?.hwnd
    || action?.criteria?.windowHandle
    || action?.criteria?.hwnd
    || 0
  ) || 0;

  return {
    applicable: true,
    startedAt: Date.now(),
    timeoutMs,
    windowHandle,
    proofStrategy: 'watcher-first',
    before: await captureTradingViewPineActivationSnapshot({
      windowHandle,
      timeoutMs: Math.max(MIN_TRADINGVIEW_PINE_ACTIVATION_PROOF_TIMEOUT_MS, Math.round(timeoutMs * 0.85)),
      phase: 'before',
      proofStrategy: 'watcher-first'
    })
  };
}

async function finalizeTradingViewPineActivationProofContext(context = null, result = {}, action = {}) {
  if (!context?.applicable) {
    return null;
  }

  const postInvokeWindowHandle = Number(
    result?.element?.WindowHandle
    || result?.element?.windowHandle
    || result?.hostResponse?.element?.WindowHandle
    || result?.hostResponse?.element?.windowHandle
    || context?.before?.windowHandle
    || context?.windowHandle
    || action?.windowHandle
    || action?.hwnd
    || 0
  ) || 0;

  await sleep(160);

  const after = await captureTradingViewPineActivationSnapshot({
    windowHandle: postInvokeWindowHandle,
    timeoutMs: context.timeoutMs,
    waitForWatcherState: true,
    watcherSinceTs: Number(context?.before?.watcher?.lastUpdate || context.startedAt || 0) || 0,
    previousSnapshot: context.before || null,
    boundWindowInfo: context?.before?.windowInfo || null,
    phase: 'after',
    proofStrategy: String(context?.proofStrategy || 'watcher-first')
  });
  const proof = buildTradingViewPineActivationTransitionProof(context.before, after, {
    windowHandle: postInvokeWindowHandle,
    actionSucceeded: result?.success === true,
    error: result?.success === true ? null : (result?.error || null)
  });

  return {
    ...proof,
    startedAt: Number(context.startedAt || 0) || 0,
    finishedAt: Date.now(),
    durationMs: Math.max(0, Date.now() - (Number(context.startedAt || 0) || Date.now()))
  };
}

function appendTradingViewPineActivationProofToExecutionProof(proof = null, activationProof = null) {
  if (!proof || typeof proof !== 'object' || !activationProof?.applicable) {
    return proof;
  }

  const status = activationProof.pineSurfaceObserved
    ? 'pass'
    : activationProof.observedChange
      ? 'bounded'
      : 'fail';
  proof.checks = Array.isArray(proof.checks) ? proof.checks : [];
  proof.checks.push({
    kind: 'tradingview-pine-activation',
    status,
    classification: activationProof.disposition || null,
    method: 'semantic-icon-post-invoke-proof',
    matchReason: activationProof.likelyMeaning || null
  });

  proof.boundedClaims = Array.isArray(proof.boundedClaims) ? proof.boundedClaims : [];
  proof.limitations = Array.isArray(proof.limitations) ? proof.limitations : [];

  if (activationProof.pineSurfaceObserved) {
    if (!proof.boundedClaims.includes('A bounded semantic-icon post-invoke proof observed a Pine surface immediately after the click.')) {
      proof.boundedClaims.push('A bounded semantic-icon post-invoke proof observed a Pine surface immediately after the click.');
    }
  } else if (activationProof.disposition === 'renderer-proof-unavailable') {
    if (!proof.limitations.includes('Chromium renderer proof was unavailable after the semantic Pine click, so repeated Ctrl+E recovery was intentionally not trusted.')) {
      proof.limitations.push('Chromium renderer proof was unavailable after the semantic Pine click, so repeated Ctrl+E recovery was intentionally not trusted.');
    }
  } else if (activationProof.observedChange) {
    if (!proof.boundedClaims.includes('A bounded semantic-icon post-invoke proof observed TradingView state change without a Pine surface anchor.')) {
      proof.boundedClaims.push('A bounded semantic-icon post-invoke proof observed TradingView state change without a Pine surface anchor.');
    }
  } else if (!proof.limitations.includes('A bounded semantic-icon post-invoke proof did not observe any TradingView state change after the Pine click.')) {
    proof.limitations.push('A bounded semantic-icon post-invoke proof did not observe any TradingView state change after the Pine click.');
  }

  return proof;
}

function normalizeProcessNameForForeground(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\.exe$/i, '')
    .replace(/[^a-z0-9]+/g, '');
}

function isTradingViewForegroundWindow(foreground = {}) {
  const processNorm = normalizeProcessNameForForeground(foreground?.processName || '');
  return !!(processNorm && processNorm.startsWith('tradingview'));
}

function isPineEditorReadbackAction(action = {}) {
  const targetText = String(action?.text || action?.criteria?.text || '').trim();
  const evidenceMode = String(action?.pineEvidenceMode || '').trim().toLowerCase();
  return !!evidenceMode && /pine editor/i.test(targetText);
}

function isPineEditorCommandText(value = '') {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return /\bpine editor\b/.test(normalized);
}

function isUnsafeForegroundForPineEditorCommandText(foreground = {}) {
  if (!foreground?.success) return false;
  if (isTradingViewForegroundWindow(foreground)) return false;

  const processNorm = normalizeProcessNameForForeground(foreground?.processName || '');
  const titleNorm = String(foreground?.title || '').trim().toLowerCase();
  if (processNorm === 'code') return true;
  if (['powershell', 'pwsh', 'cmd', 'windowsterminal', 'conhost'].includes(processNorm)) return true;
  if (/^(msedge|msedgewebview2|chrome|firefox|brave|opera|vivaldi|arc|browser|webview)/.test(processNorm)) return true;
  return /\bcopilot\b|\bchat\b|\bterminal\b/.test(titleNorm);
}

async function guardPineEditorCommandTextInsertion(action = {}) {
  if (action?.allowOffTargetPineEditorText === true) {
    return { allowed: true, applicable: false };
  }

  if (!isPineEditorCommandText(action?.text || '')) {
    return { allowed: true, applicable: false };
  }

  let foreground = null;
  try {
    foreground = await getForegroundWindowInfo();
  } catch (error) {
    return {
      allowed: false,
      applicable: true,
      error: `Refusing to type Pine Editor because foreground verification failed: ${error?.message || error}`
    };
  }

  if (!isTradingViewForegroundWindow(foreground)) {
    return {
      allowed: false,
      applicable: true,
      foreground,
      error: `Refusing to type Pine Editor while ${formatForegroundWindowSummary(foreground)} is foreground; literal Pine Editor text is only allowed inside verified TradingView command quick-search.`
    };
  }

  return { allowed: true, applicable: true, foreground };
}

function formatForegroundWindowSummary(foreground = {}) {
  const processName = String(foreground?.processName || '').trim() || 'unknown';
  const title = String(foreground?.title || '').trim() || 'untitled';
  return `${processName} | ${title}`;
}

function normalizeQuickSearchInputText(value = '') {
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r/g, '')
    .trim();
}

function normalizePineEditorBufferText(value = '') {
  return String(value || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim();
}

function extractPineEditorDeclarationTitles(value = '') {
  const source = String(value || '');
  const titles = [];
  const regex = /\b(?:indicator|strategy|library)\s*\(\s*["'`](.*?)["'`]/ig;

  let match;
  while ((match = regex.exec(source)) !== null) {
    const title = normalizeCompactText(match[1], 120);
    if (title) {
      titles.push(title);
    }
  }

  return titles;
}

function buildPineEditorPasteProof(actualText = '', expectedText = '', options = {}) {
  const normalizedActual = normalizePineEditorBufferText(actualText);
  const normalizedExpected = normalizePineEditorBufferText(expectedText);
  const preparedScriptName = normalizeCompactText(options?.pinePreparedScriptName || '', 120);
  const declarationTitles = extractPineEditorDeclarationTitles(actualText);
  const starterDefaultVisible = declarationTitles.some((title) => /^(my script|my strategy|my library|untitled(?: script)?)$/i.test(title));
  const expectedTitleVisible = preparedScriptName
    ? declarationTitles.some((title) => title.toLowerCase() === preparedScriptName.toLowerCase())
    : false;
  const versionDirectiveCount = (String(actualText || '').match(/\/\/\s*@version\s*=\s*\d+/ig) || []).length;
  const exactMatch = !!normalizedExpected && normalizedActual === normalizedExpected;

  let lifecycleState = 'prepared-script-mismatch';
  let mismatchReason = 'prepared-script-buffer-diff';
  if (exactMatch) {
    lifecycleState = 'prepared-script-verified';
    mismatchReason = null;
  } else if (!normalizedActual) {
    lifecycleState = 'prepared-script-missing';
    mismatchReason = 'prepared-script-missing';
  } else if (starterDefaultVisible) {
    mismatchReason = 'starter-default-content-still-visible';
  } else if (versionDirectiveCount > 1) {
    mismatchReason = 'multiple-version-directives-visible';
  } else if (preparedScriptName && expectedTitleVisible) {
    mismatchReason = 'expected-title-visible-but-buffer-not-exact';
  }

  return {
    exactMatch,
    lifecycleState,
    mismatchReason,
    preparedScriptName: preparedScriptName || null,
    expectedTitleVisible,
    starterDefaultVisible,
    versionDirectiveCount,
    compactSummary: [
      `buffer=${exactMatch ? 'verified' : (lifecycleState === 'prepared-script-missing' ? 'missing' : 'mismatch')}`,
      preparedScriptName ? `title=${expectedTitleVisible ? 'visible' : 'missing'}` : null,
      starterDefaultVisible ? 'starter=visible' : null,
      versionDirectiveCount > 1 ? `versions=${versionDirectiveCount}` : null
    ].filter(Boolean).join(' | ')
  };
}

function isTradingViewPineEditorAuthoringPasteAction(action = {}) {
  const type = String(action?.type || '').trim().toLowerCase();
  const key = String(action?.key || '').trim().toLowerCase();
  const route = String(action?.inputSurfaceContract?.route || '').trim().toLowerCase();
  const preparedScriptText = normalizePineEditorBufferText(action?.pinePreparedScriptText || '');
  return type === ACTION_TYPES.KEY
    && key === 'ctrl+v'
    && route === 'pine-editor-authoring'
    && !!preparedScriptText;
}

function isTradingViewPineEditorSaveKeyAction(action = {}) {
  const type = String(action?.type || '').trim().toLowerCase();
  const key = String(action?.key || '').trim().toLowerCase();
  if (type !== ACTION_TYPES.KEY || key !== 'ctrl+s') return false;

  const route = String(action?.inputSurfaceContract?.route || '').trim().toLowerCase();
  const shortcutId = String(action?.tradingViewShortcut?.id || action?.shortcutId || '').trim().toLowerCase();
  const surface = String(action?.inputSurfaceContract?.surface || action?.tradingViewShortcut?.surface || '').trim().toLowerCase();
  const contextText = [
    action?.reason || '',
    action?.text || '',
    action?.description || ''
  ].filter(Boolean).join(' ');

  return route === 'pine-editor-authoring'
    || surface === 'pine-editor'
    || shortcutId === 'save-pine-script'
    || /\bpine\b/i.test(contextText)
    || /\bsave\b.{0,24}\bscript\b/i.test(contextText);
}

async function guardTradingViewPineSaveKeyAction(action = {}, pressKeyImpl = pressKey) {
  if (!isTradingViewPineEditorSaveKeyAction(action)) {
    return {
      applicable: false,
      allowed: true,
      success: true
    };
  }

  const expectedScriptText = normalizePineEditorBufferText(action?.pinePreparedScriptText || '');
  if (!expectedScriptText || !looksLikePineScriptPayloadText(expectedScriptText)) {
    return {
      applicable: true,
      allowed: false,
      success: false,
      reason: 'missing-prepared-pine-script',
      error: 'Refusing to save Pine Editor because no verified prepared Pine script payload is attached to this save action.'
    };
  }

  let originalClipboard = null;
  try {
    originalClipboard = await getClipboardText();
  } catch {}

  const restoreOriginalClipboard = async () => {
    if (originalClipboard?.success) {
      try {
        await setClipboardText(originalClipboard.text || '');
      } catch {}
    }
  };

  const readback = await readPineEditorBufferFromClipboard(action, pressKeyImpl);
  await restoreOriginalClipboard();
  if (!readback?.success) {
    return {
      applicable: true,
      allowed: false,
      success: false,
      reason: 'pine-save-buffer-readback-failed',
      error: `Refusing to save Pine Editor because the editor buffer could not be verified: ${readback?.error || 'clipboard readback failed'}`
    };
  }

  const proof = buildPineEditorPasteProof(readback.text, expectedScriptText, {
    pinePreparedScriptName: action?.pinePreparedScriptName || ''
  });
  if (!proof.exactMatch) {
    return {
      applicable: true,
      allowed: false,
      success: false,
      reason: proof.mismatchReason || 'pine-save-buffer-mismatch',
      proof,
      text: readback.text,
      error: `Refusing to save Pine Editor because the visible editor buffer does not exactly match the verified prepared script (${proof.compactSummary || 'buffer mismatch'}).`
    };
  }

  return {
    applicable: true,
    allowed: true,
    success: true,
    method: 'ClipboardRoundTrip',
    proof,
    text: readback.text
  };
}

function isTradingViewPineSaveNameTypeAction(action = {}) {
  const type = String(action?.type || '').trim().toLowerCase();
  const route = String(action?.inputSurfaceContract?.route || '').trim().toLowerCase();
  const desiredText = normalizeCompactText(action?.text ?? '', 180);
  return type === ACTION_TYPES.TYPE
    && route === 'pine-save-name'
    && !!desiredText;
}

async function readPineEditorBufferFromClipboard(action = {}, pressKeyImpl = pressKey) {
  await pressKeyImpl('ctrl+a', action);
  await sleep(120);
  await pressKeyImpl('ctrl+c', action);
  await sleep(160);

  const clipboardRead = await getClipboardText();
  if (!clipboardRead?.success) {
    return {
      success: false,
      error: clipboardRead?.error || 'Clipboard read failed',
      source: clipboardRead?.source || null
    };
  }

  return {
    success: true,
    text: String(clipboardRead?.text || ''),
    source: clipboardRead?.source || null
  };
}

async function verifyTradingViewPineEditorPaste(action = {}, pressKeyImpl = pressKey) {
  if (!isTradingViewPineEditorAuthoringPasteAction(action)) {
    return {
      applicable: false,
      success: true,
      retryAttempted: false,
      proof: null
    };
  }

  const expectedScriptText = normalizePineEditorBufferText(action?.pinePreparedScriptText || '');
  if (!expectedScriptText) {
    return {
      applicable: false,
      success: true,
      retryAttempted: false,
      proof: null
    };
  }

  let originalClipboard = null;
  try {
    originalClipboard = await getClipboardText();
  } catch {}

  const restoreOriginalClipboard = async () => {
    if (originalClipboard?.success) {
      try {
        await setClipboardText(originalClipboard.text || '');
      } catch {}
    }
  };

  try {
    const initialReadback = await readPineEditorBufferFromClipboard(action, pressKeyImpl);
    if (!initialReadback.success) {
      await restoreOriginalClipboard();
      return {
        applicable: true,
        success: false,
        method: 'ClipboardRoundTrip',
        retryAttempted: false,
        proof: null,
        error: `Pine Editor paste proof could not read the editor buffer: ${initialReadback.error || 'clipboard unavailable'}`
      };
    }

    const initialProof = buildPineEditorPasteProof(initialReadback.text, expectedScriptText, {
      pinePreparedScriptName: action?.pinePreparedScriptName || ''
    });
    if (initialProof.exactMatch) {
      await restoreOriginalClipboard();
      return {
        applicable: true,
        success: true,
        method: 'ClipboardRoundTrip',
        retryAttempted: false,
        proof: initialProof,
        text: initialReadback.text
      };
    }

    try {
      await setClipboardText(expectedScriptText);
    } catch {}

    await sleep(80);
    await pressKeyImpl('ctrl+a', action);
    await sleep(120);
    await pressKeyImpl('backspace', { ...action, safePineStarterReset: true });
    await sleep(120);
    await pressKeyImpl('ctrl+v', action);
    await sleep(220);

    const retryReadback = await readPineEditorBufferFromClipboard(action, pressKeyImpl);
    if (!retryReadback.success) {
      await restoreOriginalClipboard();
      return {
        applicable: true,
        success: false,
        method: 'ClipboardRoundTrip',
        retryAttempted: true,
        proof: initialProof,
        error: `Pine Editor paste proof could not read the editor buffer after a single bounded retry: ${retryReadback.error || 'clipboard unavailable'}`
      };
    }

    const retryProof = buildPineEditorPasteProof(retryReadback.text, expectedScriptText, {
      pinePreparedScriptName: action?.pinePreparedScriptName || ''
    });
    await restoreOriginalClipboard();

    if (retryProof.exactMatch) {
      return {
        applicable: true,
        success: true,
        method: 'ClipboardRoundTrip',
        retryAttempted: true,
        proof: retryProof,
        initialProof,
        text: retryReadback.text
      };
    }

    return {
      applicable: true,
      success: false,
      method: 'ClipboardRoundTrip',
      retryAttempted: true,
      proof: retryProof,
      initialProof,
      text: retryReadback.text,
      error: `Pine Editor paste proof failed after a single bounded retry (${retryProof.compactSummary || initialProof.compactSummary || 'buffer mismatch'})`
    };
  } catch (error) {
    await restoreOriginalClipboard();
    return {
      applicable: true,
      success: false,
      method: 'ClipboardRoundTrip',
      retryAttempted: false,
      proof: null,
      error: error?.message || String(error || 'Pine Editor paste proof failed')
    };
  }
}

const DEFAULT_PINE_READBACK_TIMEOUT_MS = 8000;

function getPineReadbackTimeoutMs(action = {}) {
  const actionTimeout = Number(action?.pineReadbackTimeoutMs || 0);
  if (Number.isFinite(actionTimeout) && actionTimeout >= 100) {
    return Math.round(actionTimeout);
  }

  const envTimeout = Number(process.env.LIKU_PINE_READBACK_TIMEOUT_MS || 0);
  if (Number.isFinite(envTimeout) && envTimeout >= 100) {
    return Math.round(envTimeout);
  }

  return DEFAULT_PINE_READBACK_TIMEOUT_MS;
}

async function runWithTimeout(factory, timeoutMs, label = 'Operation') {
  const boundedTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.round(Number(timeoutMs))
    : DEFAULT_PINE_READBACK_TIMEOUT_MS;

  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(() => factory()),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${label} timed out after ${boundedTimeoutMs}ms`);
          error.timedOut = true;
          reject(error);
        }, boundedTimeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function createTimedOutActionResult(error, fallbackMessage = 'Operation timed out') {
  const message = String(error?.message || '').trim() || fallbackMessage;
  return {
    success: false,
    error: message,
    method: 'TimeoutGuard',
    timedOut: true
  };
}

function getQuickSearchSemanticInputBounds(action = {}) {
  const sources = [
    action?.quickSearchPreflight?.inputFocus?.element,
    action?.quickSearchPreflight?.focusRecovery?.element,
    action?.quickSearchPreflight?.focusRecovery?.surfaceProbe?.element,
    action?.quickSearchPreflight?.inputFocus?.surfaceProbe?.element
  ];

  for (const element of sources) {
    const bounds = element?.Bounds || element?.bounds || null;
    if (!bounds) continue;
    const centerX = Number(bounds.CenterX ?? (((bounds.X ?? bounds.x ?? 0) + ((bounds.Width ?? bounds.width ?? 0) / 2)))) || 0;
    const centerY = Number(bounds.CenterY ?? (((bounds.Y ?? bounds.y ?? 0) + ((bounds.Height ?? bounds.height ?? 0) / 2)))) || 0;
    if (centerX > 0 || centerY > 0) {
      return {
        bounds,
        centerX,
        centerY,
        windowHandle: Number(element?.WindowHandle || element?.windowHandle || 0) || 0
      };
    }
  }

  return null;
}

function isTradingViewQuickSearchTypeAction(action = {}) {
  const type = String(action?.type || '').trim().toLowerCase();
  if (type !== 'type') return false;

  const route = String(action?.searchSurfaceContract?.route || '').trim().toLowerCase();
  if (route !== 'quick-search') return false;

  if (action?.quickSearchPreflight?.applicable !== true) return false;

  const appName = String(action?.searchSurfaceContract?.appName || '').trim().toLowerCase();
  const shortcutSurface = String(action?.tradingViewShortcut?.surface || '').trim().toLowerCase();
  const processName = String(action?.processName || '').trim().toLowerCase();
  return /tradingview/.test(appName)
    || /tradingview/.test(processName)
    || shortcutSurface === 'quick-search'
    || shortcutSurface === 'pine-editor';
}

async function attemptTradingViewQuickSearchSemanticWrite(action = {}) {
  if (!isTradingViewQuickSearchTypeAction(action)) {
    return {
      applicable: false,
      success: false,
      fallbackRecommended: true,
      method: null,
      error: null
    };
  }

  const boundsTarget = getQuickSearchSemanticInputBounds(action);
  if (!boundsTarget) {
    return {
      applicable: true,
      success: false,
      fallbackRecommended: true,
      method: null,
      error: 'Trusted TradingView quick-search input bounds were not available for semantic write'
    };
  }

  try {
    const ui = require('./ui-automation');
    const host = ui.getSharedUIAHost();
    const intendedText = String(action?.text || '');
    const setValueResponse = await host.setValue(boundsTarget.centerX, boundsTarget.centerY, intendedText);
    const readbackResponse = await host.getText(boundsTarget.centerX, boundsTarget.centerY);
    const readbackText = String(readbackResponse?.text || '');
    const normalizedReadback = normalizeQuickSearchInputText(readbackText);
    const normalizedIntended = normalizeQuickSearchInputText(intendedText);

    if (normalizedReadback !== normalizedIntended) {
      try {
        await host.setValue(boundsTarget.centerX, boundsTarget.centerY, '');
      } catch {}
      return {
        applicable: true,
        success: false,
        fallbackRecommended: false,
        method: 'ValuePattern',
        boundsTarget,
        setValueResponse,
        readback: {
          text: readbackText,
          normalizedText: normalizedReadback,
          method: readbackResponse?.method || 'UIAHost.getText'
        },
        error: `TradingView quick-search semantic write read back \"${normalizedReadback}\" instead of \"${normalizedIntended}\"`
      };
    }

    return {
      applicable: true,
      success: true,
      fallbackRecommended: false,
      method: 'ValuePattern',
      boundsTarget,
      setValueResponse,
      readback: {
        text: readbackText,
        normalizedText: normalizedReadback,
        method: readbackResponse?.method || 'UIAHost.getText'
      },
      error: null
    };
  } catch (error) {
    return {
      applicable: true,
      success: false,
      fallbackRecommended: true,
      method: null,
      error: error?.message || String(error || 'TradingView quick-search semantic write failed')
    };
  }
}

async function preparePineEditorReadbackAction(action = {}) {
  if (!isPineEditorReadbackAction(action)) {
    return {
      action,
      foreground: null,
      error: null,
      scopedWindowTitle: ''
    };
  }

  let foreground = null;
  try {
    foreground = await getForegroundWindowInfo();
  } catch {}

  const targetWindowHandle = Number(action?.windowHandle || 0) || 0;
  if (foreground?.success && !isTradingViewForegroundWindow(foreground) && targetWindowHandle > 0) {
    try {
      const focusWindowFn = typeof module.exports.focusWindow === 'function'
        ? module.exports.focusWindow
        : focusWindow;
      await focusWindowFn(targetWindowHandle);
      await sleep(150);
      foreground = await getForegroundWindowInfo();
    } catch {}
  }

  const foregroundProcessName = String(foreground?.processName || '').trim();
  if (foreground?.success && foregroundProcessName && !isTradingViewForegroundWindow(foreground)) {
    return {
      action,
      foreground,
      error: `Pine Editor readback requires TradingView to remain foreground; current foreground was ${formatForegroundWindowSummary(foreground)}`,
      scopedWindowTitle: ''
    };
  }

  const existingCriteria = action.criteria && typeof action.criteria === 'object'
    ? action.criteria
    : null;
  const existingWindowTitle = String(existingCriteria?.windowTitle || '').trim();
  const foregroundTitle = String(foreground?.title || '').trim();

  if (foreground?.success && isTradingViewForegroundWindow(foreground) && foregroundTitle && !existingWindowTitle) {
    return {
      action: {
        ...action,
        criteria: {
          text: action.text,
          automationId: action.automationId,
          controlType: action.controlType,
          ...(existingCriteria || {}),
          windowTitle: foregroundTitle
        }
      },
      foreground,
      error: null,
      scopedWindowTitle: foregroundTitle
    };
  }

  return {
    action,
    foreground,
    error: null,
    scopedWindowTitle: existingWindowTitle
  };
}

function collectPineEditorSurfaceProbeSyntheticAnchors(probe = null) {
  if (!probe || typeof probe !== 'object') return [];

  const anchors = [];
  const seen = new Set();
  const addAnchor = (value = '') => {
    const normalized = normalizeCompactText(value, 180);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    anchors.push(normalized);
  };

  for (const anchor of Array.isArray(probe.visibleAnchors) ? probe.visibleAnchors : []) {
    addAnchor(anchor);
  }

  addAnchor(probe?.anchorText || '');
  addAnchor(probe?.rendererProof?.anchorText || '');

  for (const signal of Array.isArray(probe?.rendererProof?.signals) ? probe.rendererProof.signals : []) {
    addAnchor(signal?.observedText || '');
    addAnchor(signal?.text || '');
  }

  return anchors;
}

function buildPineEditorSurfaceProbeSyntheticReadbackResult(probe = null, method = '') {
  if (!probe || typeof probe !== 'object') return null;
  if (probe.active !== true && probe.matched !== true) return null;

  const anchors = collectPineEditorSurfaceProbeSyntheticAnchors(probe);
  if (!anchors.length) return null;

  return {
    success: true,
    text: anchors.join('\n'),
    method: method || `${getPineEditorSurfaceProbeFallbackMethod(probe)} (pine-editor-fallback:surface-probe)`,
    element: probe?.element || {
      name: anchors[0]
    },
    pineEditorSurfaceProbe: probe
  };
}

function getPineEditorCarriedSurfaceProbeHostGraceMs(action = {}) {
  return Math.max(
    120,
    Math.min(
      450,
      Math.round(getPineReadbackTimeoutMs(action) * 0.06) || 180
    )
  );
}

function getPineEditorFreshSaveTitleProofTimeoutMs(action = {}) {
  return Math.max(
    420,
    Math.min(
      1200,
      Math.round(getPineReadbackTimeoutMs(action) * 0.14) || 700
    )
  );
}

function shouldRequireFreshPineSaveTitleProof(action = {}, carriedSurfaceProbe = null) {
  if (!carriedSurfaceProbe || typeof carriedSurfaceProbe !== 'object') return false;

  const evidenceMode = String(action?.pineEvidenceMode || '').trim().toLowerCase();
  if (evidenceMode !== 'save-status') return false;

  const expectedScriptName = normalizeCompactText(
    action?.pineExpectedScriptName || action?.expectedScriptName || action?.scriptName || '',
    180
  );
  if (!expectedScriptName) return false;

  const carriedSurfaceState = extractPineEditorSafeAuthoringSurfaceState(carriedSurfaceProbe);
  if (!carriedSurfaceState?.active || carriedSurfaceState.saveConfirmedVisible !== true) {
    return false;
  }
  if (
    carriedSurfaceState.saveRequiredVisible
    || carriedSurfaceState.saveConfirmationVisible
    || carriedSurfaceState.saveReplaceConfirmationVisible
    || carriedSurfaceState.renameSurfaceVisible
  ) {
    return false;
  }

  return extractTradingViewPineExpectedTitleProof(
    carriedSurfaceProbe,
    expectedScriptName
  ).visible !== true;
}

async function getPineEditorFreshSaveTitleHeaderFallback(action = {}) {
  const expectedScriptName = normalizeCompactText(
    action?.pineExpectedScriptName || action?.expectedScriptName || action?.scriptName || '',
    180
  );
  if (!expectedScriptName) return null;

  const resolvedScope = await resolveTradingViewPineSurfaceProbeWindowScope({
    windowHandle: Number(action?.windowHandle || action?.hwnd || 0) || 0,
    windowInfo: action?.windowInfo || null,
    foreground: action?.foreground || action?.pineEditorSurfaceProbe?.foreground || null
  });
  const targetWindowHandle = Number(resolvedScope?.windowHandle || 0) || 0;
  const scopedWindowInfo = resolvedScope?.windowInfo || resolvedScope?.foreground || null;
  if (targetWindowHandle <= 0 || !scopedWindowInfo?.success) {
    return null;
  }

  const headerScanBound = buildTradingViewPineSurfaceScanBounds(scopedWindowInfo)
    .find((entry) => String(entry?.id || '').trim().toLowerCase() === 'panel-header-band')
    || buildTradingViewPineSurfaceScanBounds(scopedWindowInfo)[0]
    || null;
  if (!headerScanBound?.bounds) {
    return null;
  }

  const scanAttempts = [];
  const collectedElements = [];
  const seenElements = new Set();
  const scanRegex = buildTradingViewPineSurfaceHostRegex({
    pineExpectedScriptName: expectedScriptName
  });
  const scanViews = ['control', 'content'];
  const scanTimeoutMs = getPineEditorFreshSaveTitleProofTimeoutMs(action);
  const buildResultFromAnchors = (anchors = []) => {
    if (!Array.isArray(anchors) || anchors.length === 0) return null;

    const visibleAnchorEntries = summarizeTradingViewPineVisibleAnchorEntries(
      anchors,
      'uia-host-pine-surface-header-scan'
    );
    const probe = {
      active: true,
      foreground: resolvedScope?.foreground || scopedWindowInfo,
      windowInfo: scopedWindowInfo,
      searchBounds: headerScanBound.bounds,
      scanBounds: [headerScanBound],
      scanAttempts,
      documentProbeAttempts: [],
      documentProbeSignals: [],
      documentProbeRoots: [],
      documentProbeElements: [],
      pointProbeAttempts: [],
      pointProbeUsedWindowScopedHost: false,
      pointProbeUsedGlobalFallback: false,
      diagnosticBounds: [],
      diagnosticAttempts: [],
      diagnosticSignals: [],
      diagnosticElements: [],
      matchedBy: 'uia-host-pine-surface-header-scan',
      element: anchors[0]?.element || null,
      anchorText: anchors[0]?.text || null,
      pointProbeElements: [],
      visibleAnchors: visibleAnchorEntries.map((entry) => entry?.text).filter(Boolean).slice(0, 8),
      visibleAnchorEntries,
      rendererProof: null
    };

    return {
      success: true,
      text: probe.visibleAnchors.join('\n'),
      method: 'UIAHostScan (pine-editor-fallback:header-title)',
      element: probe.element,
      pineEditorSurfaceProbe: probe
    };
  };

  for (const view of scanViews) {
    const scanResult = await findElementsByWindowWithHost(scanRegex, {
      windowHandle: targetWindowHandle,
      timeout: scanTimeoutMs,
      maxResults: 24,
      maxDepth: 18,
      maxVisited: 1400,
      includeDisabled: true,
      bounds: headerScanBound.bounds,
      textMode: 'regex',
      view
    });
    scanAttempts.push({
      id: headerScanBound.id || 'panel-header-band',
      bounds: headerScanBound.bounds,
      view,
      success: scanResult?.success === true,
      count: Number(scanResult?.count || 0) || 0,
      stats: scanResult?.stats || null,
      error: scanResult?.error || null
    });
    if (!scanResult?.success || !Array.isArray(scanResult.elements)) {
      continue;
    }

    for (const element of scanResult.elements) {
      const taggedElement = {
        ...element,
        LikuPineProbeScanId: headerScanBound.id || 'panel-header-band',
        LikuPineProbeView: view,
        LikuPineProbeSource: 'window-host-header-title-scan'
      };
      const bounds = taggedElement?.Bounds || {};
      const dedupeKey = [
        normalizeTradingViewPineAnchorText(taggedElement?.Name || ''),
        Number(taggedElement?.WindowHandle || 0) || 0,
        Number(bounds?.X || 0) || 0,
        Number(bounds?.Y || 0) || 0,
        Number(bounds?.Width || 0) || 0,
        Number(bounds?.Height || 0) || 0
      ].join('|');
      if (seenElements.has(dedupeKey)) continue;
      seenElements.add(dedupeKey);
      collectedElements.push(taggedElement);
    }

    const anchors = collectTradingViewPineEditorHostAnchors(collectedElements, {
      pineExpectedScriptName: expectedScriptName
    });
    if (!anchors.length) {
      continue;
    }

    const result = buildResultFromAnchors(anchors);
    const surfaceState = extractPineEditorSafeAuthoringSurfaceState(result?.pineEditorSurfaceProbe || null);
    const expectedTitleProof = extractTradingViewPineExpectedTitleProof(
      result?.pineEditorSurfaceProbe || null,
      expectedScriptName
    );
    if (
      expectedTitleProof.visible === true
      || surfaceState.renameSurfaceVisible
      || surfaceState.saveRequiredVisible
      || surfaceState.saveConfirmationVisible
      || surfaceState.saveReplaceConfirmationVisible
    ) {
      return result;
    }
  }

  return buildResultFromAnchors(collectTradingViewPineEditorHostAnchors(collectedElements, {
    pineExpectedScriptName: expectedScriptName
  }));
}

async function getPineEditorTextFallback(action = {}) {
  const targetText = String(action?.text || action?.criteria?.text || '').trim();
  if (!/pine editor/i.test(targetText)) return null;

  const evidenceMode = String(action?.pineEvidenceMode || 'generic-status').trim().toLowerCase();
  const disableTradingViewPineReadbackCDP = action?.disableTradingViewPineReadbackCDP === true;
  const carriedSurfaceProbe = action?.pineEditorSurfaceProbe && typeof action.pineEditorSurfaceProbe === 'object'
    ? action.pineEditorSurfaceProbe
    : null;
  const evidenceModeSupportsSyntheticAnchors = evidenceMode === 'safe-authoring-inspect' || evidenceMode === 'save-status';
  const carriedSurfaceProbeResult = buildPineEditorSurfaceProbeSyntheticReadbackResult(
    carriedSurfaceProbe,
    carriedSurfaceProbe?.active
      ? `${getPineEditorSurfaceProbeFallbackMethod(carriedSurfaceProbe)} (pine-editor-fallback:carried-probe)`
      : ''
  );
  const requireFreshSaveTitleProof = shouldRequireFreshPineSaveTitleProof(action, carriedSurfaceProbe);
  let hostSurfaceFallback = null;
  if (
    carriedSurfaceProbeResult?.success
    && evidenceModeSupportsSyntheticAnchors
    && action?.preferCarriedPineSurfaceProbeOnSlowHost === true
  ) {
    if (requireFreshSaveTitleProof) {
      hostSurfaceFallback = await Promise.resolve()
        .then(() => getPineEditorFreshSaveTitleHeaderFallback(action))
        .catch(() => null);
    } else {
      const hostSurfaceFallbackPromise = Promise.resolve()
        .then(() => getPineEditorSurfaceProbeFallback(action))
        .catch(() => null);
      const pendingMarker = Symbol('pending-pine-host-surface-fallback');
      const hostSurfaceFallbackCandidate = await Promise.race([
        hostSurfaceFallbackPromise,
        sleep(getPineEditorCarriedSurfaceProbeHostGraceMs(action)).then(() => pendingMarker)
      ]);
      if (hostSurfaceFallbackCandidate !== pendingMarker) {
        hostSurfaceFallback = hostSurfaceFallbackCandidate;
      }
    }
    if (!hostSurfaceFallback?.success) {
      return carriedSurfaceProbeResult;
    }
  } else {
    hostSurfaceFallback = await getPineEditorSurfaceProbeFallback(action);
  }
  const ui = require('./ui-automation');
  const host = ui.getSharedUIAHost();
  const baseCriteria = action.criteria && typeof action.criteria === 'object'
    ? { ...action.criteria }
    : {};
  const fallbackCandidates = buildPineEditorFallbackCandidates(evidenceMode, action);
  const syntheticAnchors = [];
  const seenSyntheticAnchors = new Set();
  const addSyntheticAnchor = (value = '') => {
    const normalized = normalizeCompactText(value, 180);
    if (!normalized || seenSyntheticAnchors.has(normalized)) return;
    seenSyntheticAnchors.add(normalized);
    syntheticAnchors.push(normalized);
  };
  const addSyntheticAnchorsFromProbe = (probe = null) => {
    for (const anchor of collectPineEditorSurfaceProbeSyntheticAnchors(probe)) {
      addSyntheticAnchor(anchor);
    }
  };

  if (carriedSurfaceProbeResult?.success) {
    addSyntheticAnchorsFromProbe(carriedSurfaceProbe);
  }

  const carriedProbeMethod = carriedSurfaceProbeResult?.success
    ? carriedSurfaceProbeResult.method
    : null;
  const buildSyntheticAnchorResult = (methodOverride = '') => ({
    success: true,
    text: syntheticAnchors.join('\n'),
    method: methodOverride || (
      hostSurfaceFallback?.success
        ? `${hostSurfaceFallback.method} + ElementAnchor (pine-editor-fallback)`
        : (carriedProbeMethod || 'ElementAnchor (pine-editor-fallback)')
    ),
    element: carriedSurfaceProbe?.element
      || hostSurfaceFallback?.element
      || {
        name: syntheticAnchors[0]
      },
    pineEditorSurfaceProbe: hostSurfaceFallback?.pineEditorSurfaceProbe || carriedSurfaceProbe || null
  });

  if (
    carriedProbeMethod
    && syntheticAnchors.length > 0
    && !hostSurfaceFallback?.success
    && evidenceModeSupportsSyntheticAnchors
  ) {
    return {
      success: true,
      text: syntheticAnchors.join('\n'),
      method: carriedProbeMethod,
      element: carriedSurfaceProbe?.element || {
        name: syntheticAnchors[0]
      },
      pineEditorSurfaceProbe: carriedSurfaceProbe
    };
  }

  if (hostSurfaceFallback?.success) {
    for (const line of String(hostSurfaceFallback.text || '').split(/\r?\n+/)) {
      addSyntheticAnchor(line);
    }
    addSyntheticAnchorsFromProbe(hostSurfaceFallback?.pineEditorSurfaceProbe || null);
  }

  if (
    hostSurfaceFallback?.success
    && syntheticAnchors.length > 0
    && evidenceModeSupportsSyntheticAnchors
  ) {
    const hostSurfaceProbe = hostSurfaceFallback?.pineEditorSurfaceProbe || null;
    const hostSurfaceState = extractPineEditorSafeAuthoringSurfaceState(hostSurfaceProbe);
    const expectedScriptName = normalizeCompactText(
      action?.pineExpectedScriptName || action?.expectedScriptName || action?.scriptName || '',
      180
    );
    const hostExpectedTitleProofVisible = expectedScriptName
      ? extractTradingViewPineExpectedTitleProof(hostSurfaceProbe, expectedScriptName).visible === true
      : false;
    const hostProofDecisive = evidenceMode === 'save-status'
      ? (
          hostExpectedTitleProofVisible
          || hostSurfaceState.renameSurfaceVisible
          || hostSurfaceState.saveRequiredVisible
          || hostSurfaceState.saveConfirmationVisible
          || hostSurfaceState.saveReplaceConfirmationVisible
        )
      : hostSurfaceState.active === true;
    if (hostProofDecisive) {
      return buildSyntheticAnchorResult();
    }
  }

  if (!disableTradingViewPineReadbackCDP && ['safe-authoring-inspect', 'save-status'].includes(evidenceMode)) {
    let rendererReadbackFallback = null;
    try {
      rendererReadbackFallback = await readTradingViewPineEditorContentWithCDP({
        windowHandle: Number(action?.windowHandle || action?.hwnd || 0) || 0,
        timeout: Math.max(
          220,
          Math.min(1600, Math.round(getPineReadbackTimeoutMs(action) * 0.24))
        ),
        pinePreparedScriptName: action?.pineExpectedScriptName || action?.expectedScriptName || action?.scriptName || '',
        cdpDependencies: action?.cdpDependencies || null
      });
    } catch {}

    const rendererBlocks = [];
    const seenRendererLines = new Set();
    const addRendererBlock = (value = '') => {
      for (const line of String(value || '').replace(/\r/g, '').split(/\n+/)) {
        const normalized = normalizeCompactText(line, 240);
        if (!normalized || seenRendererLines.has(normalized)) continue;
        seenRendererLines.add(normalized);
        rendererBlocks.push(normalized);
      }
    };

    const rendererReadbackVisible = !!rendererReadbackFallback && [
      rendererReadbackFallback.dialogText,
      rendererReadbackFallback.renderedText,
      rendererReadbackFallback.text
    ].some((value) => !!normalizeCompactText(value, 240));

    if (rendererReadbackVisible) {
      addRendererBlock(rendererReadbackFallback.dialogText || '');
      addRendererBlock(rendererReadbackFallback.renderedText || '');
      addRendererBlock(rendererReadbackFallback.text || '');
    }

    if (rendererBlocks.length > 0) {
      return {
        success: true,
        text: rendererBlocks.join('\n'),
        method: 'ChromiumCDPRead (pine-editor-fallback)',
        element: {
          name: rendererBlocks[0]
        },
        pineEditorSurfaceProbe: hostSurfaceFallback?.pineEditorSurfaceProbe || null,
        pineEditorRendererReadback: rendererReadbackFallback
      };
    }
  }

  const candidatesToProbe = hostSurfaceFallback?.success
    ? fallbackCandidates.filter((candidate) => String(candidate?.category || '').trim().toLowerCase() === 'confirmation-modal')
    : fallbackCandidates.filter((candidate) => String(candidate?.category || '').trim().toLowerCase() !== 'save-title');

  for (const candidate of candidatesToProbe) {
    const text = String(candidate?.text || '').trim();
    if (!text) continue;
    let findResult = null;
    try {
      findResult = await ui.findElement({
        ...baseCriteria,
        text,
        exactText: '',
        automationId: baseCriteria.automationId || '',
        controlType: baseCriteria.controlType || ''
      });
    } catch {
      continue;
    }
    const element = findResult?.element || null;
    const bounds = element?.bounds || element?.Bounds || null;
    if (!findResult?.success) continue;

    const syntheticAnchorText = normalizeCompactText(element?.name || text, 120);
    if (candidate?.synthetic && syntheticAnchorText) {
      addSyntheticAnchor(syntheticAnchorText);
    }

    if (!bounds) continue;

    const centerX = Number(bounds.centerX ?? bounds.CenterX ?? (bounds.x ?? bounds.X ?? 0) + ((bounds.width ?? bounds.Width ?? 0) / 2));
    const centerY = Number(bounds.centerY ?? bounds.CenterY ?? (bounds.y ?? bounds.Y ?? 0) + ((bounds.height ?? bounds.Height ?? 0) / 2));
    if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) continue;

    try {
      const resp = await host.getText(centerX, centerY);
      const fallbackText = normalizeCompactText(resp?.text, 2400);
      if (fallbackText) {
        return {
          success: true,
          text: resp.text,
          method: `${resp.method || 'TextPattern'} (pine-editor-fallback:${text})`,
          element: resp.element || element
        };
      }
    } catch {}
  }

  if (syntheticAnchors.length > 0 && evidenceModeSupportsSyntheticAnchors) {
    return buildSyntheticAnchorResult();
  }

  if (hostSurfaceFallback?.success) {
    return hostSurfaceFallback;
  }

  return null;
}

function getPineEditorSurfaceProbeFallbackMethod(probe = null) {
  const matchedBy = String(probe?.matchedBy || '').trim().toLowerCase();
  if (matchedBy.startsWith('chromium-cdp')) {
    return 'ChromiumCDP';
  }
  if (matchedBy.startsWith('uia-host')) {
    return 'UIAHostScan';
  }
  if (matchedBy.startsWith('watcher')) {
    return 'WatcherCache';
  }
  return 'PineSurfaceProbe';
}

async function resolveTradingViewPineSurfaceProbeWindowScope(options = {}) {
  let windowInfo = summarizeTradingViewPineActivationWindowInfo(options?.windowInfo || null);
  if (!(windowInfo?.success && isTradingViewForegroundWindow(windowInfo))) {
    windowInfo = null;
  }

  let foreground = summarizeTradingViewPineActivationForeground(options?.foreground || null);
  if (!(foreground?.success && isTradingViewForegroundWindow(foreground))) {
    foreground = null;
  }

  let windowHandle = Number(
    options?.windowHandle
    || options?.hwnd
    || windowInfo?.hwnd
    || foreground?.hwnd
    || 0
  ) || 0;

  if (windowInfo?.success && windowHandle > 0 && Number(windowInfo?.hwnd || 0) !== windowHandle) {
    windowInfo = null;
  }
  if (foreground?.success && windowHandle > 0 && Number(foreground?.hwnd || 0) !== windowHandle) {
    foreground = null;
  }

  if (windowHandle <= 0) {
    try {
      const foregroundCandidate = await getForegroundWindowInfo();
      if (foregroundCandidate?.success && isTradingViewForegroundWindow(foregroundCandidate)) {
        foreground = foregroundCandidate;
        windowHandle = Number(foregroundCandidate?.hwnd || 0) || 0;
        if (!windowInfo?.success) {
          windowInfo = foregroundCandidate;
        }
      }
    } catch {}
  }

  if (!windowInfo?.success && windowHandle > 0) {
    try {
      const windowCandidate = await getWindowInfoByHandle(windowHandle);
      if (windowCandidate?.success && isTradingViewForegroundWindow(windowCandidate)) {
        windowInfo = windowCandidate;
      }
    } catch {}
  }

  if (!windowInfo?.success && foreground?.success && Number(foreground?.hwnd || 0) === windowHandle) {
    windowInfo = foreground;
  }

  return {
    windowHandle,
    windowInfo: windowInfo?.success ? windowInfo : null,
    foreground: foreground?.success && Number(foreground?.hwnd || 0) === windowHandle
      ? foreground
      : null
  };
}

async function getPineEditorSurfaceProbeFallback(action = {}, options = {}) {
  const targetText = String(action?.text || action?.criteria?.text || '').trim();
  if (!/pine editor/i.test(targetText)) return null;

  const explicitWindowHandle = Number(
    action?.windowHandle
    || options?.windowHandle
    || action?.hwnd
    || options?.hwnd
    || 0
  ) || 0;
  const disableTradingViewPineReadbackCDP = action?.disableTradingViewPineReadbackCDP === true;
  const resolvedScope = await resolveTradingViewPineSurfaceProbeWindowScope({
    windowHandle: explicitWindowHandle,
    windowInfo: action?.windowInfo || options?.windowInfo || null,
    foreground: action?.foreground || options?.foreground || null
  });
  const targetWindowHandle = Number(resolvedScope?.windowHandle || 0) || 0;
  if (targetWindowHandle <= 0) return null;
  const scopedForeground = resolvedScope?.foreground || null;
  const scopedWindowInfo = resolvedScope?.windowInfo || scopedForeground || null;
  const allowRendererProof = !disableTradingViewPineReadbackCDP && (
    explicitWindowHandle > 0
    || (
      scopedForeground?.success
      && Number(scopedForeground?.hwnd || 0) === targetWindowHandle
    )
  );
  const requestedTimeout = Number(options?.timeoutMs || options?.timeout || 0);
  const boundedTimeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.max(220, Math.min(Math.round(requestedTimeout), 1800))
    : Math.min(1800, Math.max(350, Math.round(getPineReadbackTimeoutMs(action) * 0.25)));
  const hostSurfaceProbe = await probeTradingViewPineEditorSurface({
    windowHandle: targetWindowHandle,
    windowInfo: scopedWindowInfo,
    foreground: scopedForeground,
    resolveWindowState: !(scopedWindowInfo || scopedForeground),
    timeout: boundedTimeout,
    allowRendererProof,
    pineEvidenceMode: action?.pineEvidenceMode || options?.pineEvidenceMode || '',
    pineExpectedScriptName: action?.pineExpectedScriptName || action?.expectedScriptName || action?.scriptName || '',
    cdpPort: Number(action?.cdpPort || options?.cdpPort || 0) || 0,
    cdpDependencies: action?.cdpDependencies || options?.cdpDependencies || null
  });
  if (!hostSurfaceProbe?.active || !Array.isArray(hostSurfaceProbe.visibleAnchors) || hostSurfaceProbe.visibleAnchors.length === 0) {
    return null;
  }

  return {
    success: true,
    text: hostSurfaceProbe.visibleAnchors.join('\n'),
    method: `${getPineEditorSurfaceProbeFallbackMethod(hostSurfaceProbe)} (pine-editor-fallback)`,
    element: hostSurfaceProbe.element || null,
    pineEditorSurfaceProbe: hostSurfaceProbe
  };
}

function getPineEditorWatcherFallback(action = {}) {
  const targetText = String(action?.text || action?.criteria?.text || '').trim();
  if (!/pine editor/i.test(targetText)) return null;

  let getUIWatcher = null;
  try {
    ({ getUIWatcher } = require('./ai-service/ui-context'));
  } catch {
    return null;
  }

  const watcher = typeof getUIWatcher === 'function' ? getUIWatcher() : null;
  if (!watcher?.cache || !Array.isArray(watcher.cache.elements) || watcher.cache.elements.length === 0) {
    return null;
  }

  const activeHwnd = Number(watcher.cache.activeWindow?.hwnd || 0) || 0;
  const scopedElements = activeHwnd > 0
    ? watcher.cache.elements.filter((element) => Number(element?.windowHandle || 0) === activeHwnd)
    : watcher.cache.elements.slice();
  if (!scopedElements.length) return null;

  const prioritizedTerms = [
    'untitled script',
    'add to chart',
    'publish script',
    'update on chart',
    'strategy tester',
    'pine logs',
    'save script',
    'script name',
    'save as',
    'rename script'
  ];

  const starterTerms = [
    'untitled script',
    'my script',
    'my strategy',
    'my library'
  ];

  const strongAnchorTerms = prioritizedTerms.filter((term) => !starterTerms.includes(term));

  const normalizeForSearch = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const isLikelyChartChromeNoise = (value = '') => {
    const compact = normalizeCompactText(value, 160);
    if (!compact) return true;
    return /^[A-Z0-9.\-]{1,16}\s*[▲▼]/.test(compact)
      || /\b[+-]?\d+(?:\.\d+)?%\b/.test(compact)
      || /\b(?:open|high|low|close|vol)\b/i.test(compact)
      || /\/\s*unnamed\b/i.test(compact)
      || /\bunnamed\b/i.test(compact);
  };

  const collected = [];
  const seen = new Set();
  let strongAnchorCount = 0;
  let starterSignalCount = 0;

  for (const term of prioritizedTerms) {
    const normalizedTerm = normalizeForSearch(term);
    for (const element of scopedElements) {
      const displayText = normalizeCompactText(element?.name || element?.automationId || element?.className || '', 160);
      const matchText = normalizeCompactText([
        element?.name,
        element?.automationId,
        element?.className,
        element?.type
      ].filter(Boolean).join(' '), 240);
      const normalizedCandidate = normalizeForSearch(matchText);
      if (!displayText || !normalizedCandidate.includes(normalizedTerm) || seen.has(displayText)) {
        continue;
      }
      if (isLikelyChartChromeNoise(displayText)) {
        continue;
      }
      seen.add(displayText);
      collected.push(displayText);
      if (strongAnchorTerms.includes(term)) {
        strongAnchorCount += 1;
      }
      if (starterTerms.includes(term)) {
        starterSignalCount += 1;
      }
    }
  }

  const hasSufficientPineEvidence = strongAnchorCount > 0 || starterSignalCount > 0;
  if (collected.length === 0 || !hasSufficientPineEvidence) {
    return null;
  }

  return {
    success: true,
    text: collected.join('\n'),
    method: 'WatcherCache (pine-editor-fallback)',
    element: {
      name: collected[0]
    }
  };
}

function isTradingViewPineEditorOpenAction(action = {}) {
  if (!action || typeof action !== 'object') return false;
  const type = String(action?.type || '').trim().toLowerCase();
  const key = String(action?.key || '').trim().toLowerCase();
  const shortcutId = String(action?.tradingViewShortcut?.id || '').trim().toLowerCase();
  const routeId = String(
    action?.searchSurfaceContract?.id
    || action?.tradingViewShortcut?.id
    || ''
  ).trim().toLowerCase();
  const route = String(
    action?.searchSurfaceContract?.route
    || action?.tradingViewShortcut?.route
    || ''
  ).trim().toLowerCase();
  return (type === 'key' && key === 'ctrl+e' && shortcutId === 'open-pine-editor')
    || (type === 'click_element' && routeId === 'open-pine-editor' && route === 'semantic-icon');
}

async function maybeBypassTradingViewPineEditorOpenAction(action = {}) {
  if (!isTradingViewPineEditorOpenAction(action)) {
    return {
      bypass: false,
      probe: null
    };
  }

  const probe = await probeTradingViewPineEditorSurface({
    windowHandle: Number(action?.windowHandle || action?.hwnd || 0) || 0,
    timeout: 1200
  });

  if (!probe?.active) {
    return {
      bypass: false,
      probe: probe || null
    };
  }

  return {
    bypass: true,
    probe,
    skippedReason: 'pine-editor-already-active',
    skippedActionType: String(action?.type || '').trim().toLowerCase(),
    message: probe?.anchorText
      ? `Skipped TradingView Pine opener because Pine Editor was already active (${probe.anchorText})`
      : 'Skipped TradingView Pine opener because Pine Editor was already active'
  };
}

function buildPineLogsStructuredSummary(text) {
  const rawText = String(text || '').replace(/\r/g, '');
  const compactText = normalizeCompactText(rawText, 2400);
  if (!compactText) return null;

  const visibleSegments = rawText
    .split(/[\n;]+/)
    .map((segment) => normalizeCompactText(segment, 180))
    .filter(Boolean);

  const topVisibleOutputs = visibleSegments.slice(0, 4);
  const errorSegments = visibleSegments.filter((segment) => /\b(error|exception|failed|failure|runtime error)\b/i.test(segment));
  const warningSegments = visibleSegments.filter((segment) => /\bwarning|warn\b/i.test(segment));
  const emptyVisible = /\b(no logs|no log output|no output|empty log|nothing to show)\b/i.test(compactText);

  let outputSignal = 'output-visible';
  if (errorSegments.length > 0) {
    outputSignal = 'errors-visible';
  } else if (warningSegments.length > 0) {
    outputSignal = 'warnings-visible';
  } else if (emptyVisible || topVisibleOutputs.length === 0) {
    outputSignal = 'empty-visible';
  }

  const compactSummary = [
    `signal=${outputSignal}`,
    `entries=${visibleSegments.length}`,
    errorSegments.length > 0 ? `errors=${errorSegments.length}` : null,
    warningSegments.length > 0 ? `warnings=${warningSegments.length}` : null
  ].filter(Boolean).join(' | ');

  return {
    evidenceMode: 'logs-summary',
    outputSurface: 'pine-logs',
    outputSignal,
    visibleOutputEntryCount: visibleSegments.length,
    topVisibleOutputs,
    compactSummary: compactSummary || null
  };
}

function parseVisibleProfilerMetric(text, patterns = []) {
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (!match) continue;
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function buildPineProfilerStructuredSummary(text) {
  const rawText = String(text || '').replace(/\r/g, '');
  const compactText = normalizeCompactText(rawText, 2400);
  if (!compactText) return null;

  const visibleSegments = rawText
    .split(/[\n;]+/)
    .map((segment) => normalizeCompactText(segment, 180))
    .filter(Boolean);

  const visibleOutputEntryCount = visibleSegments.length;
  const topVisibleOutputs = visibleSegments.slice(0, 4);
  const functionCallCountEstimate = parseVisibleProfilerMetric(compactText, [
    /\b(\d{1,7})\s+calls?\b/i,
    /\bcalls?\s*[:=]?\s*(\d{1,7})\b/i
  ]);
  const avgTimeMs = parseVisibleProfilerMetric(compactText, [
    /\bavg(?:erage)?\s*[:=]?\s*(\d+(?:\.\d+)?)\s*ms\b/i,
    /\b(\d+(?:\.\d+)?)\s*ms\s+avg\b/i
  ]);
  const maxTimeMs = parseVisibleProfilerMetric(compactText, [
    /\bmax(?:imum)?(?:\s+time)?\s*[:=]?\s*(\d+(?:\.\d+)?)\s*ms\b/i,
    /\b(\d+(?:\.\d+)?)\s*ms\s+max\b/i
  ]);
  const emptyVisible = /\b(no profiler data|no data|no metrics|empty profiler|nothing to show)\b/i.test(compactText);
  const metricsVisible = Number.isFinite(functionCallCountEstimate)
    || Number.isFinite(avgTimeMs)
    || Number.isFinite(maxTimeMs)
    || /\b(call|calls|avg|average|max|slow|slowest|hotspot|time|timing|ms)\b/i.test(compactText);

  let outputSignal = 'output-visible';
  if (emptyVisible || topVisibleOutputs.length === 0) {
    outputSignal = 'empty-visible';
  } else if (metricsVisible) {
    outputSignal = 'metrics-visible';
  }

  const compactSummary = [
    `signal=${outputSignal}`,
    Number.isFinite(functionCallCountEstimate) ? `calls=${functionCallCountEstimate}` : null,
    Number.isFinite(avgTimeMs) ? `avgMs=${avgTimeMs}` : null,
    Number.isFinite(maxTimeMs) ? `maxMs=${maxTimeMs}` : null,
    `entries=${visibleOutputEntryCount}`
  ].filter(Boolean).join(' | ');

  return {
    evidenceMode: 'profiler-summary',
    outputSurface: 'pine-profiler',
    outputSignal,
    visibleOutputEntryCount,
    functionCallCountEstimate,
    avgTimeMs,
    maxTimeMs,
    topVisibleOutputs,
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
  const numericHandle = Number(hwnd || 0);
  if (!Number.isFinite(numericHandle) || numericHandle <= 0) {
    return {
      success: false,
      requestedWindowHandle: 0,
      actualForegroundHandle: 0,
      actualForeground: null,
      exactMatch: false,
      outcome: 'missing-target'
    };
  }

  const hostAttempt = await tryAutomationHostSystemCall('focusWindow', (host) => host.focusWindow(numericHandle));
  if (hostAttempt.used) {
    const actualForeground = hostAttempt.result?.actualForeground && typeof hostAttempt.result.actualForeground === 'object'
      ? {
          success: true,
          hwnd: Number(hostAttempt.result.actualForeground.hwnd || 0) || 0,
          pid: Number(hostAttempt.result.actualForeground.pid || hostAttempt.result.actualForeground.processId || 0) || 0,
          processName: String(hostAttempt.result.actualForeground.processName || ''),
          title: String(hostAttempt.result.actualForeground.title || ''),
          ownerHwnd: Number(hostAttempt.result.actualForeground.ownerHwnd || 0) || 0,
          isTopmost: hostAttempt.result.actualForeground.isTopmost === true,
          isToolWindow: hostAttempt.result.actualForeground.isToolWindow === true,
          isMinimized: hostAttempt.result.actualForeground.isMinimized === true,
          isMaximized: hostAttempt.result.actualForeground.isMaximized === true,
          windowKind: String(hostAttempt.result.actualForeground.windowKind || 'main'),
          bounds: hostAttempt.result.actualForeground.bounds || null,
          source: 'uia-host'
        }
      : null;
    return {
      success: true,
      requestedWindowHandle: Number(hostAttempt.result?.requestedWindowHandle || numericHandle) || numericHandle,
      actualForegroundHandle: Number(hostAttempt.result?.actualForegroundHandle || actualForeground?.hwnd || 0) || 0,
      actualForeground,
      exactMatch: hostAttempt.result?.exactMatch === true,
      restored: hostAttempt.result?.restored === true,
      focusAttempted: hostAttempt.result?.focusAttempted !== false,
      outcome: String(hostAttempt.result?.outcome || (hostAttempt.result?.exactMatch ? 'exact' : 'mismatch'))
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
[WindowFocus]::Focus([IntPtr]::new(${numericHandle}))
`;
  await executePowerShell(script);

  // Poll to verify focus actually stuck (SetForegroundWindow can be racy / blocked)
  let verified = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    const fg = await getForegroundWindowHandle();
    if (fg === numericHandle) {
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
    console.log(`[AUTOMATION] Focused window handle (verified): ${numericHandle}`);
  } else {
    const fg = await getForegroundWindowHandle();
    console.warn(`[AUTOMATION] Focus requested for ${numericHandle} but foreground is ${fg}`);
  }

  return {
    success: true,
    requestedWindowHandle: numericHandle,
    actualForegroundHandle,
    actualForeground: actualForeground?.success ? actualForeground : null,
    exactMatch: verified,
    outcome: verified ? 'exact' : 'mismatch',
    hostError: hostAttempt.error || undefined
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

  const hostAttempt = await tryAutomationHostSystemCall('findWindow', (host) => host.findWindow({
    title: titleValue,
    titleMode,
    processName: String(action.processName || '').trim(),
    className: String(action.className || '').trim()
  }));
  if (hostAttempt.used) {
    const hostHandle = Number(hostAttempt.result?.hwnd || 0);
    if (Number.isFinite(hostHandle) && hostHandle > 0) {
      return hostHandle;
    }
  }

  if (processName) {
    const hostProcessFallback = await tryAutomationHostSystemCall('findWindow', (host) => host.findWindow({
      title: '',
      titleMode,
      processName: String(action.processName || '').trim(),
      className: String(action.className || '').trim()
    }));
    if (hostProcessFallback.used) {
      const hostHandle = Number(hostProcessFallback.result?.hwnd || 0);
      if (Number.isFinite(hostHandle) && hostHandle > 0) {
        return hostHandle;
      }
    }
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
  const numericHandle = Number(hwnd || 0);
  if (!Number.isFinite(numericHandle) || numericHandle <= 0) {
    return {
      success: false,
      error: 'Invalid window handle'
    };
  }

  const hostAttempt = await tryAutomationHostSystemCall('restoreWindow', (host) => host.restoreWindow(numericHandle));
  if (hostAttempt.used) {
    return {
      success: true,
      hwnd: Number(hostAttempt.result?.hwnd || numericHandle) || numericHandle,
      restored: hostAttempt.result?.restored === true,
      window: hostAttempt.result?.window
        ? {
            success: true,
            hwnd: Number(hostAttempt.result.window.hwnd || 0) || 0,
            pid: Number(hostAttempt.result.window.pid || hostAttempt.result.window.processId || 0) || 0,
            processName: String(hostAttempt.result.window.processName || ''),
            title: String(hostAttempt.result.window.title || ''),
            ownerHwnd: Number(hostAttempt.result.window.ownerHwnd || 0) || 0,
            isTopmost: hostAttempt.result.window.isTopmost === true,
            isToolWindow: hostAttempt.result.window.isToolWindow === true,
            isMinimized: hostAttempt.result.window.isMinimized === true,
            isMaximized: hostAttempt.result.window.isMaximized === true,
            windowKind: String(hostAttempt.result.window.windowKind || 'main'),
            bounds: hostAttempt.result.window.bounds || null,
            source: 'uia-host'
          }
        : null,
      source: 'uia-host'
    };
  }

  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinRestore {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@
[WinRestore]::ShowWindow([IntPtr]::new(${numericHandle}), 9) | Out-Null
`;
  await executePowerShell(script);
  return {
    success: true,
    hwnd: numericHandle,
    source: hostAttempt.error ? 'powershell-fallback' : 'powershell',
    hostError: hostAttempt.error || undefined
  };
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
 * Search a known window with the persistent UIA host. This is bounded and
 * fail-open to the legacy PowerShell finder when the host is unavailable.
 */
async function findElementsByWindowWithHost(searchText, options = {}) {
  const {
    controlType = '',
    exact = false,
    textMode = '',
    windowHandle = 0,
    foregroundOnly = false,
    timeout = 15000,
    bounds = null,
    view = 'control',
    maxResults = 1,
    maxDepth = 16,
    maxVisited = 1000,
    includeOffscreen = false,
    includeDisabled = true,
    skipRootMatch = false
  } = options;

  let hwnd = Number(windowHandle) || 0;
  try {
    const ui = require('./ui-automation');
    const host = ui.getSharedUIAHost();
    if (!hwnd && foregroundOnly) {
      const foreground = await host.getForegroundWindowInfo();
      hwnd = Number(foreground?.hwnd || 0) || 0;
    }
    if (!hwnd) return null;

    const boundedTimeout = Number.isFinite(Number(timeout)) && Number(timeout) >= 100
      ? Math.min(Math.round(Number(timeout)), 6500)
      : 2500;
    const normalizedTextMode = String(textMode || '').trim().toLowerCase();

    const response = await host.findElementsByWindow(hwnd, {
      text: searchText,
      textMode: normalizedTextMode || (exact ? 'exact' : 'contains'),
      controlType,
      view,
      bounds,
      maxResults,
      maxDepth,
      maxVisited,
      timeoutMs: boundedTimeout,
      includeOffscreen,
      includeDisabled,
      skipRootMatch
    });

    const elements = (Array.isArray(response?.elements) ? response.elements : [])
      .map(normalizeHostElementForFind)
      .filter(Boolean);

    return {
      success: true,
      elements,
      count: elements.length,
      element: elements.length > 0 ? elements[0] : null,
      source: 'uia-host',
      stats: response?.stats || null
    };
  } catch (error) {
    return {
      success: false,
      error: error?.message || String(error || 'UIA host find failed'),
      elements: [],
      source: 'uia-host'
    };
  }
}

async function attemptTradingViewPineSaveNameSemanticWrite(action = {}) {
  if (!isTradingViewPineSaveNameTypeAction(action)) {
    return {
      applicable: false,
      available: false,
      success: false,
      fallbackRecommended: true,
      method: null,
      error: null
    };
  }

  return await setTradingViewPineSaveDialogNameWithCDP(action);
}

async function probeWindowAccessibilityWithHost(options = {}) {
  const {
    windowHandle = 0,
    foregroundOnly = false,
    timeout = 900,
    bounds = null,
    maxResults = 24,
    maxRoots = 4,
    maxDepth = 18,
    maxVisited = 1400,
    includeOffscreen = false,
    includeDisabled = true,
    rootControlType = 'Document',
    rootClassName = 'Chrome_RenderWidgetHostHWND'
  } = options;

  let hwnd = Number(windowHandle) || 0;
  try {
    const ui = require('./ui-automation');
    const host = ui.getSharedUIAHost();
    if (typeof host?.probeWindowAccessibility !== 'function') {
      return {
        success: false,
        error: 'UIA host accessibility probe unavailable',
        elements: [],
        roots: [],
        source: 'uia-host'
      };
    }

    if (!hwnd && foregroundOnly) {
      const foreground = await host.getForegroundWindowInfo();
      hwnd = Number(foreground?.hwnd || 0) || 0;
    }
    if (!hwnd) {
      return null;
    }

    const boundedTimeout = Number.isFinite(Number(timeout)) && Number(timeout) >= 100
      ? Math.min(Math.round(Number(timeout)), 3000)
      : 900;
    const response = await host.probeWindowAccessibility(hwnd, {
      bounds,
      maxResults,
      maxRoots,
      maxDepth,
      maxVisited,
      timeoutMs: boundedTimeout,
      includeOffscreen,
      includeDisabled,
      rootControlType,
      rootClassName
    });

    const elements = (Array.isArray(response?.elements) ? response.elements : [])
      .map(normalizeHostElementForFind)
      .filter(Boolean);
    const roots = (Array.isArray(response?.roots) ? response.roots : [])
      .map(normalizeHostElementForFind)
      .filter(Boolean);

    return {
      success: true,
      elements,
      roots,
      count: elements.length,
      rootCount: roots.length,
      source: 'uia-host',
      stats: response?.stats || null
    };
  } catch (error) {
    return {
      success: false,
      error: error?.message || String(error || 'UIA host accessibility probe failed'),
      elements: [],
      roots: [],
      source: 'uia-host'
    };
  }
}

function normalizeHostElementForFind(element) {
  if (!element || typeof element !== 'object') return null;
  const bounds = element.Bounds || element.bounds || {};
  const x = Number(bounds.X ?? bounds.x ?? 0);
  const y = Number(bounds.Y ?? bounds.y ?? 0);
  const width = Number(bounds.Width ?? bounds.width ?? 0);
  const height = Number(bounds.Height ?? bounds.height ?? 0);
  if (!Number.isFinite(x) || !Number.isFinite(y) || width <= 0 || height <= 0) return null;

  const controlType = String(
    element.ControlType
    || element.controlType
    || element.role
    || ''
  );

  return {
    Name: element.Name || element.name || '',
    ControlType: controlType.startsWith('ControlType.') ? controlType : `ControlType.${controlType || 'Custom'}`,
    AutomationId: element.AutomationId || element.automationId || '',
    ClassName: element.ClassName || element.className || '',
    Value: element.Value || element.value || '',
    Description: element.Description || element.description || '',
    DefaultAction: element.DefaultAction || element.defaultAction || '',
    LegacyRole: element.LegacyRole || element.legacyRole || '',
    Source: element.Source || element.source || '',
    WindowHandle: Number(element.WindowHandle || element.windowHandle || 0) || 0,
    NativeWindowHandle: Number(element.NativeWindowHandle || element.nativeWindowHandle || 0) || 0,
    Patterns: element.Patterns || element.patterns || [],
    IsEnabled: element.IsEnabled !== undefined ? element.IsEnabled : element.isEnabled,
    IsOffscreen: element.IsOffscreen !== undefined ? element.IsOffscreen : element.isOffscreen,
    HasKeyboardFocus: element.HasKeyboardFocus !== undefined ? element.HasKeyboardFocus : element.hasKeyboardFocus,
    IsFocusable: element.IsFocusable !== undefined ? element.IsFocusable : element.isFocusable,
    IsClickable: element.IsClickable !== undefined ? element.IsClickable : element.isClickable,
    Bounds: {
      X: Math.round(x),
      Y: Math.round(y),
      Width: Math.round(width),
      Height: Math.round(height),
      CenterX: Math.round(Number(bounds.CenterX ?? bounds.centerX ?? (x + width / 2))),
      CenterY: Math.round(Number(bounds.CenterY ?? bounds.centerY ?? (y + height / 2)))
    }
  };
}

/**
 * Return the currently focused UIA element when it belongs to a known window.
 * This stays bounded to a single top-level window and fails open when the host
 * is unavailable.
 */
async function getFocusedElementInWindowWithHost(windowHandle = 0) {
  const hwnd = Number(windowHandle) || 0;
  if (!hwnd) {
    return {
      success: false,
      focused: false,
      error: 'Host focused-element probe requires windowHandle',
      source: 'uia-host'
    };
  }

  try {
    const ui = require('./ui-automation');
    const host = ui.getSharedUIAHost();
    const response = await host.getFocusedElementInWindow(hwnd);
    const element = normalizeHostElementForFind(response?.element);

    return {
      success: true,
      focused: response?.focused === true && !!element,
      reason: response?.reason || null,
      element,
      targetWindow: response?.targetWindow || null,
      focusedWindow: response?.focusedWindow || null,
      stats: response?.stats || null,
      source: 'uia-host'
    };
  } catch (error) {
    return {
      success: false,
      focused: false,
      error: error?.message || String(error || 'UIA host focused-element probe failed'),
      source: 'uia-host'
    };
  }
}

async function invokeElementByWindowWithHost(searchText, options = {}) {
  const {
    controlType = '',
    exact = false,
    windowHandle = 0,
    foregroundOnly = false,
    timeout = 15000,
    bounds = null,
    view = 'control',
    maxDepth = 16,
    maxVisited = 1000,
    includeOffscreen = false,
    includeDisabled = false
  } = options;

  let hwnd = Number(windowHandle) || 0;
  try {
    const ui = require('./ui-automation');
    const host = ui.getSharedUIAHost();
    if (!hwnd && foregroundOnly) {
      const foreground = await host.getForegroundWindowInfo();
      hwnd = Number(foreground?.hwnd || 0) || 0;
    }
    if (!hwnd) {
      return {
        success: false,
        error: 'Host semantic invoke requires windowHandle or foregroundOnly',
        method: 'uia-host-invoke',
        source: 'uia-host'
      };
    }

    const boundedTimeout = Number.isFinite(Number(timeout)) && Number(timeout) >= 100
      ? Math.min(Math.round(Number(timeout)), 6500)
      : 3000;

    const response = await host.invokeElementByWindow(hwnd, {
      text: searchText,
      textMode: exact ? 'exact' : 'contains',
      controlType,
      view,
      bounds,
      maxDepth,
      maxVisited,
      timeoutMs: boundedTimeout,
      includeOffscreen,
      includeDisabled
    });

    return {
      success: true,
      method: response?.method || 'Invoke',
      source: 'uia-host',
      message: `Invoked "${searchText}" via UIA host ${response?.method || 'Invoke'} pattern`,
      element: normalizeHostElementForFind(response?.element) || response?.element || null,
      stats: response?.stats || null,
      hostResponse: response
    };
  } catch (error) {
    return {
      success: false,
      error: error?.message || String(error || 'UIA host invoke failed'),
      method: 'uia-host-invoke',
      source: 'uia-host'
    };
  }
}

/**
 * Find UI element by text content using Windows UI Automation
 * Searches the entire UI tree for elements containing the specified text
 * 
 * @param {string} searchText - Text to search for (partial match)
 * @param {Object} options - Search options
 * @param {string} options.controlType - Filter by control type (Button, Text, ComboBox, etc.)
 * @param {boolean} options.exact - Require exact text match (default: false)
 * @param {number} options.windowHandle - Limit search to a specific top-level window handle
 * @param {boolean} options.foregroundOnly - Limit search to the active foreground window
 * @returns {Object} Element info with bounds, or error
 */
async function findElementByText(searchText, options = {}) {
  const {
    controlType = '',
    exact = false,
    windowHandle = 0,
    foregroundOnly = false,
    timeout = 15000
  } = options;

  const hostFindResult = await findElementsByWindowWithHost(searchText, {
    controlType,
    exact,
    windowHandle,
    foregroundOnly,
    timeout
  });
  if (hostFindResult?.success && hostFindResult.elements.length > 0) {
    console.log(`[AUTOMATION] Host found ${hostFindResult.elements.length} elements matching "${searchText}"`);
    return hostFindResult;
  }
  
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
    $windowHandle = [int64]${Number(windowHandle) || 0}
    $foregroundOnly = $${foregroundOnly}

    if ($windowHandle -ne 0) {
        try {
            $targetWindow = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new($windowHandle))
            if ($targetWindow) {
                $found = Find-InElement -Root $targetWindow -Text $searchText -IsExact $exact -CtrlType $controlType
                if ($found) {
                    $data = Get-ElementData -el $found
                    if ($data) {
                        $data | ConvertTo-Json -Compress
                        exit 0
                    }
                }
            }
        } catch {}

        Write-Output '{"error": "Element not found"}'
        exit 0
    }
    
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

    if ($foregroundOnly) {
        Write-Output '{"error": "Element not found"}'
        exit 0
    }

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

  const boundedTimeout = Number.isFinite(Number(timeout)) && Number(timeout) >= 100
    ? Math.round(Number(timeout))
    : 15000;

  const result = await executePowerShellScript(psScript, boundedTimeout);
  
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

  let rendererFallbackAttempted = false;
  let rendererFallbackResult = null;
  const capturePostClickPineSurfaceProbe = async (fallbackWindowHandle = 0) => {
    const rendererInvoke = options?.rendererInvoke && typeof options.rendererInvoke === 'object'
      ? options.rendererInvoke
      : null;
    const invokeKind = (normalizeCompactText(rendererInvoke?.kind || '', 80) || '').toLowerCase();
    if (![
      'unsaved-changes-confirmation',
      'replace-existing-script-confirmation',
      'pine-first-save-confirmation'
    ].includes(invokeKind)) {
      return null;
    }

    const resolvedScope = await resolveTradingViewPineSurfaceProbeWindowScope({
      windowHandle: Number(
        rendererInvoke?.windowHandle
        || options?.windowHandle
        || fallbackWindowHandle
        || 0
      ) || 0,
      hwnd: Number(rendererInvoke?.hwnd || options?.hwnd || 0) || 0,
      windowInfo: rendererInvoke?.windowInfo || options?.windowInfo || null,
      foreground: rendererInvoke?.foreground || options?.foreground || null
    });
    const targetWindowHandle = Number(resolvedScope?.windowHandle || 0) || 0;
    if (!targetWindowHandle) {
      return null;
    }

    const expectedScriptName = rendererInvoke?.pineExpectedScriptName
      || options?.pineExpectedScriptName
      || options?.expectedScriptName
      || options?.scriptName
      || '';
    const scopedWindowInfo = resolvedScope?.windowInfo || null;
    const scopedForeground = resolvedScope?.foreground || null;

    try {
      const probe = await probeTradingViewPineEditorSurface({
        windowHandle: targetWindowHandle,
        windowInfo: scopedWindowInfo,
        foreground: scopedForeground,
        resolveWindowState: !(scopedWindowInfo || scopedForeground),
        timeout: 950,
        minScanAttemptTimeout: 140,
        allowRendererProof: true,
        allowPointProbe: false,
        allowDiagnosticScan: false,
        scanViews: ['content'],
        pineEvidenceMode: expectedScriptName ? 'save-status' : 'safe-authoring-inspect',
        pineExpectedScriptName: expectedScriptName,
        cdpPort: Number(rendererInvoke?.cdpPort || options?.cdpPort || 0) || 0,
        cdpDependencies: rendererInvoke?.cdpDependencies || options?.cdpDependencies || null
      });
      return probe?.active === true ? probe : null;
    } catch {
      return null;
    }
  };
  const tryRendererFallback = async (failureReason = '') => {
    if (rendererFallbackAttempted) {
      return rendererFallbackResult;
    }
    rendererFallbackAttempted = true;

    const rendererInvoke = options?.rendererInvoke && typeof options.rendererInvoke === 'object'
      ? options.rendererInvoke
      : null;
    if (!rendererInvoke) {
      rendererFallbackResult = null;
      return null;
    }

    const invokeResult = await invokeTradingViewRendererButtonWithCDP({
      ...rendererInvoke,
      buttonText: rendererInvoke.buttonText || searchText,
      windowHandle: rendererInvoke.windowHandle || options.windowHandle || 0,
      hwnd: rendererInvoke.hwnd || options.hwnd || 0,
      foreground: rendererInvoke.foreground || options.foreground || null,
      windowInfo: rendererInvoke.windowInfo || options.windowInfo || null,
      cdpPort: Number(rendererInvoke.cdpPort || options.cdpPort || 0) || 0,
      pineExpectedScriptName: rendererInvoke.pineExpectedScriptName
        || options.pineExpectedScriptName
        || options.expectedScriptName
        || options.scriptName
        || '',
      cdpDependencies: rendererInvoke.cdpDependencies || options.cdpDependencies || null
    });

    if (invokeResult?.success) {
      const syntheticPineSurfaceProbe = buildTradingViewPineSurfaceProbeFromRendererInvoke(invokeResult, {
        windowHandle: Number(options.windowHandle || options.hwnd || 0) || 0
      });
      rendererFallbackResult = {
        success: true,
        method: invokeResult.method || 'chromium-cdp-ax-dom-click',
        source: 'chromium-cdp',
        message: `Invoked "${searchText}" via TradingView renderer accessibility`,
        element: {
          Name: searchText,
          ControlType: 'ControlType.Button',
          WindowHandle: Number(options.windowHandle || options.hwnd || 0) || 0,
          BackendDOMNodeId: Number(invokeResult?.axNode?.backendDOMNodeId || 0) || 0
        },
        rendererInvoke: invokeResult,
        pineEditorSurfaceProbe: syntheticPineSurfaceProbe
      };
      return rendererFallbackResult;
    }

    rendererFallbackResult = {
      success: false,
      method: invokeResult?.method || 'chromium-cdp',
      error: invokeResult?.error || failureReason || `No element found containing "${searchText}"`,
      rendererInvoke: invokeResult || null
    };
    return rendererFallbackResult;
  };
  
  const findResult = await findElementByText(searchText, options);
  
  if (findResult.error) {
    const rendererFallback = await tryRendererFallback(findResult.error);
    if (rendererFallback?.success) {
      return rendererFallback;
    }
    return { success: false, error: rendererFallback?.error || findResult.error };
  }
  
  if (!findResult.element) {
    const rendererFallback = await tryRendererFallback(`No element found containing "${searchText}"`);
    if (rendererFallback?.success) {
      return rendererFallback;
    }
    return { 
      success: false, 
      error: rendererFallback?.error || `No element found containing "${searchText}"`,
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
      const postClickPineSurfaceProbe = await capturePostClickPineSurfaceProbe(
        Number(invokeResult?.element?.WindowHandle || el.WindowHandle || 0) || 0
      );
      return postClickPineSurfaceProbe
        ? {
            ...invokeResult,
            pineEditorSurfaceProbe: postClickPineSurfaceProbe
          }
        : invokeResult;
    }
    const rendererFallback = await tryRendererFallback(invokeResult.error || `Invoke failed for "${searchText}"`);
    if (rendererFallback?.success) {
      return rendererFallback;
    }
    if (options.allowCoordinateFallback === false) {
      return {
        success: false,
        error: rendererFallback?.error || invokeResult.error || `Invoke failed for "${searchText}" and coordinate fallback is disabled`,
        element: el,
        method: 'invoke-only',
        rendererInvoke: rendererFallback?.rendererInvoke || null
      };
    }
    console.log(`[AUTOMATION] Invoke failed, falling back to mouse click`);
  }

  if (options.allowCoordinateFallback === false) {
    const rendererFallback = await tryRendererFallback(`Element "${searchText}" was found but is not invokable without coordinate fallback`);
    if (rendererFallback?.success) {
      return rendererFallback;
    }
    return {
      success: false,
      error: rendererFallback?.error || `Element "${searchText}" was found but is not invokable without coordinate fallback`,
      element: el,
      method: 'invoke-only',
      rendererInvoke: rendererFallback?.rendererInvoke || null
    };
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
  const hostInvokeResult = await invokeElementByWindowWithHost(searchText, {
    ...options,
    controlType,
    exact
  });
  if (hostInvokeResult?.success) {
    console.log(`[AUTOMATION] Invoked element using UIA host ${hostInvokeResult.method} pattern`);
    return hostInvokeResult;
  }

  if (options.allowCoordinateFallback === false) {
    return {
      success: false,
      error: hostInvokeResult?.error
        ? `${hostInvokeResult.error}; coordinate fallback is disabled`
        : `Host semantic invoke failed for "${searchText}" and coordinate fallback is disabled`,
      method: 'uia-host-invoke-only',
      hostInvoke: hostInvokeResult || null
    };
  }
  
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
  const hostAttempt = await tryAutomationHostSystemCall('getForegroundWindowInfo', (host) => host.getForegroundWindowInfo());
  if (hostAttempt.used) {
    const hostHandle = Number(hostAttempt.result?.hwnd || 0);
    return Number.isFinite(hostHandle) && hostHandle > 0 ? hostHandle : null;
  }

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

function parseStructuredAutomationJson(text) {
  const raw = String(text || '').trim();
  if (!raw) {
    throw new Error('No output');
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    const sanitized = raw.replace(/[\u0000-\u001F]/g, ' ');
    if (sanitized && sanitized !== raw) {
      return JSON.parse(sanitized);
    }
    throw error;
  }
}

function useAutomationHostForSystemOps() {
  if (process.platform !== 'win32') return false;
  const flag = String(process.env.LIKU_USE_AUTOMATION_HOST || '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on';
}

function getAutomationHostInstance() {
  const ui = require('./ui-automation');
  return ui.getSharedUIAHost();
}

async function tryAutomationHostSystemCall(callName, invoke) {
  if (!useAutomationHostForSystemOps()) {
    return { used: false, result: null, error: null };
  }

  try {
    const host = getAutomationHostInstance();
    const result = await invoke(host);
    return { used: true, result, error: null };
  } catch (error) {
    return {
      used: false,
      result: null,
      error: error?.message || String(error || `${callName} failed`)
    };
  }
}

/**
 * Get current foreground window info (HWND, title, pid, process name).
 * Best-effort: returns { success: false, error } on failure.
 */
async function getForegroundWindowInfo() {
  const hostAttempt = await tryAutomationHostSystemCall('getForegroundWindowInfo', (host) => host.getForegroundWindowInfo());
  if (hostAttempt.used) {
    return {
      success: true,
      hwnd: Number(hostAttempt.result?.hwnd || 0) || 0,
      pid: Number(hostAttempt.result?.pid || hostAttempt.result?.processId || 0) || 0,
      processName: String(hostAttempt.result?.processName || ''),
      title: String(hostAttempt.result?.title || ''),
      ownerHwnd: Number(hostAttempt.result?.ownerHwnd || 0) || 0,
      isTopmost: hostAttempt.result?.isTopmost === true,
      isToolWindow: hostAttempt.result?.isToolWindow === true,
      isMinimized: hostAttempt.result?.isMinimized === true,
      isMaximized: hostAttempt.result?.isMaximized === true,
      windowKind: String(hostAttempt.result?.windowKind || 'main'),
      bounds: hostAttempt.result?.bounds || null,
      source: 'uia-host'
    };
  }

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

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

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

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
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
$rect = New-Object ForegroundInfo+RECT
[void][ForegroundInfo]::GetWindowRect($hwnd, [ref]$rect)

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
  bounds = [PSCustomObject]@{
    x = $rect.Left
    y = $rect.Top
    width = $rect.Right - $rect.Left
    height = $rect.Bottom - $rect.Top
  }
}
$obj | ConvertTo-Json -Compress
`;

  try {
    const result = await executePowerShellScript(script, 8000);
    const text = String(result?.stdout || '').trim();
    if (!text) {
      return { success: false, error: result?.stderr?.trim() || result?.error || 'No output', hostError: hostAttempt.error || undefined };
    }
    const parsed = parseStructuredAutomationJson(text);
    if (hostAttempt.error) {
      parsed.hostError = hostAttempt.error;
      parsed.source = 'powershell-fallback';
    }
    return parsed;
  } catch (e) {
    return { success: false, error: e.message, hostError: hostAttempt.error || undefined };
  }
}

/**
 * Get info for an arbitrary window handle (HWND, title, pid, process name).
 * Best-effort: returns { success: false, error } on failure.
 */
async function getWindowInfoByHandle(hwnd) {
  const numericHandle = Number(hwnd || 0);
  if (!Number.isFinite(numericHandle) || numericHandle <= 0) {
    return { success: false, error: 'Invalid window handle' };
  }

  const hostAttempt = await tryAutomationHostSystemCall('getWindowInfoByHandle', (host) => host.getWindowInfoByHandle(numericHandle));
  if (hostAttempt.used) {
    return {
      success: true,
      hwnd: Number(hostAttempt.result?.hwnd || 0) || 0,
      pid: Number(hostAttempt.result?.pid || hostAttempt.result?.processId || 0) || 0,
      processName: String(hostAttempt.result?.processName || ''),
      title: String(hostAttempt.result?.title || ''),
      ownerHwnd: Number(hostAttempt.result?.ownerHwnd || 0) || 0,
      isTopmost: hostAttempt.result?.isTopmost === true,
      isToolWindow: hostAttempt.result?.isToolWindow === true,
      isMinimized: hostAttempt.result?.isMinimized === true,
      isMaximized: hostAttempt.result?.isMaximized === true,
      windowKind: String(hostAttempt.result?.windowKind || 'main'),
      bounds: hostAttempt.result?.bounds || null,
      source: 'uia-host'
    };
  }

  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WindowInfo {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool IsWindow(IntPtr hWnd);

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

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

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

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$hwnd = [IntPtr]::new([int64]${numericHandle})
if ($hwnd -eq [IntPtr]::Zero -or -not [WindowInfo]::IsWindow($hwnd)) {
  Write-Output '{"success":false,"error":"Window handle not found"}'
  exit 0
}

$targetPid = 0
[void][WindowInfo]::GetWindowThreadProcessId($hwnd, [ref]$targetPid)
$title = [WindowInfo]::GetTitle($hwnd)

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

$exStyle = [int64][WindowInfo]::GetStyle($hwnd, $GWL_EXSTYLE)
$owner = [WindowInfo]::GetWindow($hwnd, $GW_OWNER)
$ownerHwnd = if ($owner -eq [IntPtr]::Zero) { 0 } else { [int64]$owner }
$isTopmost = (($exStyle -band $WS_EX_TOPMOST) -ne 0)
$isToolWindow = (($exStyle -band $WS_EX_TOOLWINDOW) -ne 0)
$isMinimized = [WindowInfo]::IsIconic($hwnd)
$isMaximized = [WindowInfo]::IsZoomed($hwnd)
$windowKind = if ($ownerHwnd -ne 0 -and $isToolWindow) { 'palette' } elseif ($ownerHwnd -ne 0) { 'owned' } else { 'main' }
$rect = New-Object WindowInfo+RECT
[void][WindowInfo]::GetWindowRect($hwnd, [ref]$rect)

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
  bounds = [PSCustomObject]@{
    x = $rect.Left
    y = $rect.Top
    width = $rect.Right - $rect.Left
    height = $rect.Bottom - $rect.Top
  }
}
$obj | ConvertTo-Json -Compress
`;

  try {
    const result = await executePowerShellScript(script, 8000);
    const text = String(result?.stdout || '').trim();
    if (!text) {
      return { success: false, error: result?.stderr?.trim() || result?.error || 'No output', hostError: hostAttempt.error || undefined };
    }
    const parsed = parseStructuredAutomationJson(text);
    if (hostAttempt.error) {
      parsed.hostError = hostAttempt.error;
      parsed.source = 'powershell-fallback';
    }
    return parsed;
  } catch (e) {
    return { success: false, error: e.message, hostError: hostAttempt.error || undefined };
  }
}

/**
 * Get current clipboard text.
 * Uses the persistent automation host when LIKU_USE_AUTOMATION_HOST is enabled,
 * and falls back to PowerShell otherwise.
 */
async function getClipboardText() {
  const hostAttempt = await tryAutomationHostSystemCall('getClipboardText', (host) => host.getClipboardText());
  if (hostAttempt.used) {
    return {
      success: true,
      text: String(hostAttempt.result?.text || ''),
      error: null,
      source: 'uia-host'
    };
  }

  if (process.platform !== 'win32') {
    return {
      success: false,
      text: '',
      error: hostAttempt.error || 'Clipboard text is only supported on Windows',
      source: 'unsupported'
    };
  }

  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  $value = Get-Clipboard -Raw
  if ($null -eq $value) { $value = '' }
  [Console]::Out.Write((@{ success = $true; text = [string]$value; error = $null } | ConvertTo-Json -Compress -Depth 4))
} catch {
  [Console]::Out.Write((@{ success = $false; text = ''; error = $_.Exception.Message } | ConvertTo-Json -Compress -Depth 4))
}
`;

  try {
    const result = await executePowerShellScript(script, 8000);
    const text = String(result?.stdout || '').trim();
    if (!text) {
      return {
        success: false,
        text: '',
        error: result?.stderr?.trim() || result?.error || 'No output',
        hostError: hostAttempt.error || undefined,
        source: 'powershell-fallback'
      };
    }
    const parsed = parseStructuredAutomationJson(text);
    parsed.source = hostAttempt.error ? 'powershell-fallback' : 'powershell';
    if (hostAttempt.error) parsed.hostError = hostAttempt.error;
    return parsed;
  } catch (error) {
    return {
      success: false,
      text: '',
      error: error?.message || String(error || 'Clipboard read failed'),
      hostError: hostAttempt.error || undefined,
      source: 'powershell-fallback'
    };
  }
}

/**
 * Set current clipboard text.
 * Uses the persistent automation host when LIKU_USE_AUTOMATION_HOST is enabled,
 * and falls back to PowerShell otherwise.
 */
async function setClipboardText(text = '') {
  const normalizedText = String(text ?? '');
  const hostAttempt = await tryAutomationHostSystemCall('setClipboardText', (host) => host.setClipboardText(normalizedText));
  if (hostAttempt.used) {
    return {
      success: true,
      error: null,
      source: 'uia-host'
    };
  }

  if (process.platform !== 'win32') {
    return {
      success: false,
      error: hostAttempt.error || 'Clipboard text is only supported on Windows',
      source: 'unsupported'
    };
  }

  const encoded = Buffer.from(normalizedText, 'utf8').toString('base64');
  const script = `
$ErrorActionPreference = 'Stop'
$value = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encoded}'))
Set-Clipboard -Value $value
`;

  try {
    const result = await executePowerShellScript(script, 8000);
    if (result?.failed) {
      return {
        success: false,
        error: result?.stderr || result?.error || 'Clipboard write failed',
        hostError: hostAttempt.error || undefined,
        source: 'powershell-fallback'
      };
    }

    return {
      success: true,
      error: null,
      hostError: hostAttempt.error || undefined,
      source: hostAttempt.error ? 'powershell-fallback' : 'powershell'
    };
  } catch (error) {
    return {
      success: false,
      error: error?.message || String(error || 'Clipboard write failed'),
      hostError: hostAttempt.error || undefined,
      source: 'powershell-fallback'
    };
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
    const parsed = parseStructuredAutomationJson(text);
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
async function executeAction(action, runtimeOptions = {}) {
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
  let effectiveAction = action;
  let resolvedTarget = null;
  let result = { success: true, action: action.type };
  const clickImpl = typeof runtimeOptions.click === 'function' ? runtimeOptions.click : click;
  const doubleClickImpl = typeof runtimeOptions.doubleClick === 'function' ? runtimeOptions.doubleClick : doubleClick;
  const moveMouseImpl = typeof runtimeOptions.moveMouse === 'function' ? runtimeOptions.moveMouse : moveMouse;
  const typeTextImpl = typeof runtimeOptions.typeText === 'function' ? runtimeOptions.typeText : typeText;
  const pressKeyImpl = typeof runtimeOptions.pressKey === 'function' ? runtimeOptions.pressKey : pressKey;

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
    const targetResolution = await resolveActionTarget(action, runtimeOptions);
    if (!targetResolution.success) {
      const error = new Error(targetResolution.error || `Failed to resolve target for ${action.type}`);
      error.code = targetResolution.code || 'TARGET_RESOLUTION_FAILED';
      error.resolvedTarget = targetResolution.resolvedTarget || null;
      throw error;
    }

    effectiveAction = targetResolution.action || action;
    resolvedTarget = targetResolution.resolvedTarget || null;

    switch (effectiveAction.type) {
      case ACTION_TYPES.CLICK:
        await clickImpl(effectiveAction.x, effectiveAction.y, effectiveAction.button || 'left');
        result.message = resolvedTarget
          ? `Clicked target ${resolvedTarget.targetId} at (${effectiveAction.x}, ${effectiveAction.y})`
          : `Clicked at (${effectiveAction.x}, ${effectiveAction.y})`;
        break;
        
      case ACTION_TYPES.DOUBLE_CLICK:
        await doubleClickImpl(effectiveAction.x, effectiveAction.y);
        result.message = resolvedTarget
          ? `Double-clicked target ${resolvedTarget.targetId} at (${effectiveAction.x}, ${effectiveAction.y})`
          : `Double-clicked at (${effectiveAction.x}, ${effectiveAction.y})`;
        break;
        
      case ACTION_TYPES.RIGHT_CLICK:
        await clickImpl(effectiveAction.x, effectiveAction.y, 'right');
        result.message = resolvedTarget
          ? `Right-clicked target ${resolvedTarget.targetId} at (${effectiveAction.x}, ${effectiveAction.y})`
          : `Right-clicked at (${effectiveAction.x}, ${effectiveAction.y})`;
        break;
        
      case ACTION_TYPES.MOVE_MOUSE:
        await moveMouseImpl(effectiveAction.x, effectiveAction.y);
        result.message = resolvedTarget
          ? `Mouse moved to target ${resolvedTarget.targetId} at (${effectiveAction.x}, ${effectiveAction.y})`
          : `Mouse moved to (${effectiveAction.x}, ${effectiveAction.y})`;
        break;
        
      case ACTION_TYPES.TYPE:
        {
          const pineEditorTextGuard = await guardPineEditorCommandTextInsertion(effectiveAction);
          if (!pineEditorTextGuard.allowed) {
            result.success = false;
            result.error = pineEditorTextGuard.error || 'Pine Editor command text insertion blocked by foreground guard';
            result.blockedByActiveInputSurface = true;
            result.activeInputSurfaceGuard = {
              reason: 'unsafe-pine-editor-command-text-foreground',
              foreground: pineEditorTextGuard.foreground || null
            };
            result.message = `Typing failed: ${result.error}`;
            break;
          }

          const pineSaveNameSemanticWrite = await attemptTradingViewPineSaveNameSemanticWrite(effectiveAction);
          if (pineSaveNameSemanticWrite.applicable && pineSaveNameSemanticWrite.success) {
            result.pineSaveNameSemanticWrite = pineSaveNameSemanticWrite;
            result.method = pineSaveNameSemanticWrite.method || 'ChromiumCDPDialogSetValue';
            result.message = `Typed "${effectiveAction.text.substring(0, 30)}${effectiveAction.text.length > 30 ? '...' : ''}" via ${result.method}`;
            break;
          }

          if (pineSaveNameSemanticWrite.applicable && !pineSaveNameSemanticWrite.fallbackRecommended) {
            result.success = false;
            result.error = pineSaveNameSemanticWrite.error || 'TradingView save-name semantic write failed verification';
            result.pineSaveNameSemanticWrite = pineSaveNameSemanticWrite;
            result.message = `Typing failed: ${result.error}`;
            break;
          }

          const quickSearchSemanticWrite = pineSaveNameSemanticWrite.applicable
            ? {
                applicable: false,
                success: false,
                fallbackRecommended: true,
                method: null,
                error: null
              }
            : await attemptTradingViewQuickSearchSemanticWrite(effectiveAction);
          if (quickSearchSemanticWrite.applicable && quickSearchSemanticWrite.success) {
            result.quickSearchSemanticWrite = quickSearchSemanticWrite;
            result.method = quickSearchSemanticWrite.method;
            result.message = `Typed "${effectiveAction.text.substring(0, 30)}${effectiveAction.text.length > 30 ? '...' : ''}" via ${quickSearchSemanticWrite.method}`;
            break;
          }

          if (quickSearchSemanticWrite.applicable && !quickSearchSemanticWrite.fallbackRecommended) {
            result.success = false;
            result.error = quickSearchSemanticWrite.error || 'TradingView quick-search semantic write failed verification';
            result.quickSearchSemanticWrite = quickSearchSemanticWrite;
            result.message = `Typing failed: ${result.error}`;
            break;
          }

          await typeTextImpl(effectiveAction.text);
          if (pineSaveNameSemanticWrite.applicable) {
            result.pineSaveNameSemanticWrite = pineSaveNameSemanticWrite;
            result.fallback = true;
            result.method = 'SendKeys';
            result.message = `Typed "${effectiveAction.text.substring(0, 30)}${effectiveAction.text.length > 30 ? '...' : ''}" via SendKeys fallback after Pine save-name semantic write was unavailable`;
          } else if (quickSearchSemanticWrite.applicable) {
            result.quickSearchSemanticWrite = quickSearchSemanticWrite;
            result.fallback = true;
            result.method = 'SendKeys';
            result.message = `Typed "${effectiveAction.text.substring(0, 30)}${effectiveAction.text.length > 30 ? '...' : ''}" via SendKeys fallback`;
          } else {
            result.message = `Typed "${effectiveAction.text.substring(0, 30)}${effectiveAction.text.length > 30 ? '...' : ''}"`;
          }
        }
        break;
        
      case ACTION_TYPES.KEY:
        {
          const pineEditorOpenBypass = await maybeBypassTradingViewPineEditorOpenAction(effectiveAction);
          if (pineEditorOpenBypass?.bypass) {
            result.skipped = true;
            result.skippedReason = pineEditorOpenBypass.skippedReason || 'pine-editor-already-active';
            result.method = 'UIAHostScan';
            result.pineEditorSurfaceProbe = pineEditorOpenBypass.probe || null;
            result.message = pineEditorOpenBypass.message || `Skipped ${effectiveAction.key}`;
            break;
          }

          const disableTradingViewPineAuthoringCDP = effectiveAction?.disableTradingViewPineAuthoringCDP === true
            || runtimeOptions?.disableTradingViewPineAuthoringCDP === true;
          const pineAuthoringCdpWrite = disableTradingViewPineAuthoringCDP
            || !isTradingViewPineEditorAuthoringPasteAction(effectiveAction)
            ? null
            : await setTradingViewPineEditorContentWithCDP({
                ...effectiveAction,
                cdpDependencies: effectiveAction?.cdpDependencies || runtimeOptions?.cdpDependencies || null
              });

          if (pineAuthoringCdpWrite?.applicable) {
            result.pineAuthoringCdpWrite = pineAuthoringCdpWrite;

            if (pineAuthoringCdpWrite.success) {
              result.pineAuthoringPasteProof = pineAuthoringCdpWrite;
              result.method = pineAuthoringCdpWrite.method || 'ChromiumCDP';
              result.message = `Replaced the Pine buffer via ${result.method} and verified the prepared script`;
              break;
            }

            if (!pineAuthoringCdpWrite.fallbackRecommended) {
              result.success = false;
              result.error = pineAuthoringCdpWrite.error || 'TradingView Pine editor CDP write failed';
              result.message = `Key press failed: ${result.error}`;
              break;
            }
          }

          const pineSaveGuard = await guardTradingViewPineSaveKeyAction(effectiveAction, pressKeyImpl);
          if (pineSaveGuard?.applicable) {
            result.pineSaveGuard = pineSaveGuard;
            if (!pineSaveGuard.allowed) {
              result.success = false;
              result.error = pineSaveGuard.error || 'TradingView Pine save guard blocked this save action';
              result.message = `Key press failed: ${result.error}`;
              break;
            }
          }

          await pressKeyImpl(effectiveAction.key, effectiveAction);
          const pinePasteProof = await verifyTradingViewPineEditorPaste(effectiveAction, pressKeyImpl);
          if (pinePasteProof?.applicable) {
            result.pineAuthoringPasteProof = pinePasteProof;
            result.method = pinePasteProof.method || result.method;

            if (!pinePasteProof.success) {
              result.success = false;
              result.error = pinePasteProof.error || 'Pine Editor paste proof failed';
              if (pineAuthoringCdpWrite?.applicable && pineAuthoringCdpWrite.success !== true) {
                result.error = `${result.error} (after CDP write fallback: ${pineAuthoringCdpWrite.reason || pineAuthoringCdpWrite.error || 'renderer route unavailable'})`;
              }
              result.message = `Key press failed: ${result.error}`;
              break;
            }

            if (pineAuthoringCdpWrite?.applicable && pineAuthoringCdpWrite.success !== true) {
              result.fallback = true;
              result.fallbackReason = pineAuthoringCdpWrite.reason || pineAuthoringCdpWrite.error || 'renderer-route-unavailable';
              result.message = pinePasteProof.retryAttempted
                ? `Pressed ${effectiveAction.key} after CDP fallback and repaired the Pine buffer after a single bounded retry`
                : `Pressed ${effectiveAction.key} after CDP fallback and verified the Pine buffer`;
            } else {
              result.message = pinePasteProof.retryAttempted
                ? `Pressed ${effectiveAction.key} and repaired the Pine buffer after a single bounded retry`
                : `Pressed ${effectiveAction.key} and verified the Pine buffer`;
            }
            break;
          }

          result.message = `Pressed ${effectiveAction.key}`;
        }
        break;
        
      case ACTION_TYPES.SCROLL:
        await scroll(effectiveAction.direction, effectiveAction.amount || 3);
        result.message = `Scrolled ${effectiveAction.direction}`;
        break;
        
      case ACTION_TYPES.WAIT:
        await sleep(effectiveAction.ms || 1000);
        result.message = `Waited ${effectiveAction.ms || 1000}ms`;
        break;
        
      case ACTION_TYPES.DRAG:
        await drag(effectiveAction.fromX, effectiveAction.fromY, effectiveAction.toX, effectiveAction.toY);
        result.message = `Dragged from (${effectiveAction.fromX}, ${effectiveAction.fromY}) to (${effectiveAction.toX}, ${effectiveAction.toY})`;
        break;
        
      case ACTION_TYPES.SCREENSHOT:
        // Scoped screenshot — caller resolves capture based on scope
        result.needsScreenshot = true;
        result.scope = effectiveAction.scope || 'screen';         // screen | region | window | element
        result.region = effectiveAction.region || null;            // {x, y, width, height} for scope=region
        result.hwnd = effectiveAction.hwnd || null;                // window handle for scope=window
        result.elementCriteria = effectiveAction.elementCriteria || null; // {text, controlType} for scope=element
        result.targetRegionId = effectiveAction.targetRegionId || null;
        result.message = `Screenshot requested (scope: ${result.scope})`;
        break;
      
      // Semantic element-based actions (MORE RELIABLE than coordinates)
      case ACTION_TYPES.CLICK_ELEMENT: {
        const pineEditorOpenBypass = await maybeBypassTradingViewPineEditorOpenAction(effectiveAction);
        if (pineEditorOpenBypass?.bypass) {
          result.skipped = true;
          result.skippedReason = pineEditorOpenBypass.skippedReason || 'pine-editor-already-active';
          result.method = 'UIAHostScan';
          result.pineEditorSurfaceProbe = pineEditorOpenBypass.probe || null;
          result.message = pineEditorOpenBypass.message || 'Skipped TradingView Pine opener';
          break;
        }

        let pineActivationProofContext = null;
        if (isTradingViewSemanticPineIconAction(effectiveAction)) {
          try {
            pineActivationProofContext = await prepareTradingViewPineActivationProofContext(effectiveAction);
          } catch (error) {
            pineActivationProofContext = {
              applicable: true,
              startedAt: Date.now(),
              timeoutMs: getTradingViewPineActivationProofTimeoutMs(),
              windowHandle: Number(effectiveAction?.windowHandle || effectiveAction?.hwnd || 0) || 0,
              before: {
                captured: false,
                reason: 'pre-invoke-proof-failed',
                error: error?.message || String(error || 'Pre-invoke Pine proof failed')
              }
            };
          }
        }

        const criteria = effectiveAction.criteria && typeof effectiveAction.criteria === 'object'
          ? effectiveAction.criteria
          : null;
        if (criteria && String(criteria.windowTitle || '').trim()) {
          const ui = require('./ui-automation');
          const clickResult = await ui.click(criteria, {
            focusWindow: true
          });
          result = {
            ...result,
            ...clickResult,
            method: clickResult?.success ? 'uia-click' : (clickResult?.method || 'uia-click')
          };
          result.message = clickResult.success
            ? `Clicked "${clickResult?.element?.name || criteria.text || effectiveAction.text || 'element'}" via window-scoped UI Automation`
            : `Click element failed: ${clickResult.error || 'Element not found'}`;
        } else {
          const clickResult = await clickElementByText(effectiveAction.text, {
            controlType: effectiveAction.controlType || '',
            exact: effectiveAction.exact || false,
            windowHandle: effectiveAction.windowHandle || effectiveAction.hwnd || 0,
            foregroundOnly: !!effectiveAction.foregroundOnly,
            allowCoordinateFallback: effectiveAction.allowCoordinateFallback !== false,
            pineExpectedScriptName: effectiveAction.pineExpectedScriptName || effectiveAction.expectedScriptName || effectiveAction.scriptName || '',
            cdpPort: Number(effectiveAction.cdpPort || 0) || 0,
            rendererInvoke: effectiveAction.tradingViewRendererInvoke || effectiveAction.rendererInvoke || null,
            cdpDependencies: effectiveAction.cdpDependencies || null
          });
          result = { ...result, ...clickResult };
        }

        if (pineActivationProofContext?.applicable) {
          try {
            result.tradingViewPineActivationProof = await finalizeTradingViewPineActivationProofContext(
              pineActivationProofContext,
              result,
              effectiveAction
            );
          } catch (error) {
            result.tradingViewPineActivationProof = {
              applicable: true,
              route: 'semantic-icon',
              expectedSurface: 'pine-editor',
              windowHandle: Number(
                result?.element?.WindowHandle
                || result?.element?.windowHandle
                || pineActivationProofContext?.windowHandle
                || 0
              ) || 0,
              actionSucceeded: result?.success === true,
              observedChange: false,
              pineSurfaceObserved: false,
              disposition: 'proof-error',
              likelyMeaning: 'The semantic Pine post-invoke proof failed before it could compare TradingView state.',
              error: error?.message || String(error || 'Semantic Pine post-invoke proof failed'),
              before: pineActivationProofContext?.before || null,
              after: null,
              startedAt: Number(pineActivationProofContext?.startedAt || 0) || 0,
              finishedAt: Date.now(),
              durationMs: Math.max(0, Date.now() - (Number(pineActivationProofContext?.startedAt || 0) || Date.now())),
              signals: []
            };
          }
        }
        break;
      }

      case ACTION_TYPES.FIND_ELEMENT: {
        const criteria = effectiveAction.criteria && typeof effectiveAction.criteria === 'object'
          ? effectiveAction.criteria
          : null;
        if (criteria && String(criteria.windowTitle || '').trim()) {
          const ui = require('./ui-automation');
          const findResult = await ui.findElement(criteria);
          result = {
            ...result,
            success: !!findResult?.success,
            element: findResult?.element || null,
            elements: findResult?.element ? [findResult.element] : [],
            count: findResult?.element ? 1 : 0,
            error: findResult?.error
          };
          result.message = findResult?.success
            ? `Found "${findResult?.element?.name || criteria.text || effectiveAction.text || 'element'}" via window-scoped UI Automation`
            : `Find element failed: ${findResult?.error || 'Element not found'}`;
        } else {
          const findResult = await findElementByText(effectiveAction.text, {
            controlType: effectiveAction.controlType || '',
            exact: effectiveAction.exact || false,
            windowHandle: effectiveAction.windowHandle || effectiveAction.hwnd || 0,
            foregroundOnly: !!effectiveAction.foregroundOnly
          });
          result = { ...result, ...findResult };
        }
        break;
      }
      
      case ACTION_TYPES.RUN_COMMAND:
        const cmdResult = await executeCommand(effectiveAction.command, {
          cwd: effectiveAction.cwd,
          shell: effectiveAction.shell || 'powershell',
          timeout: effectiveAction.timeout || 30000
        });
        result = { 
          ...result, 
          ...cmdResult,
          command: effectiveAction.command,
          cwd: effectiveAction.cwd || os.homedir()
        };
        result.message = cmdResult.success 
          ? `Command completed (exit ${cmdResult.exitCode})`
          : `Command failed: ${cmdResult.stderr || cmdResult.error || `exit code ${cmdResult.exitCode}`}`;
        break;

      case ACTION_TYPES.GREP_REPO:
      case ACTION_TYPES.SEMANTIC_SEARCH_REPO:
      case ACTION_TYPES.PGREP_PROCESS: {
        const repoSearchActions = require('./repo-search-actions');
        const searchResult = await repoSearchActions.executeRepoSearchAction(effectiveAction);
        result = {
          ...result,
          ...searchResult
        };
        if (searchResult.success) {
          const noun = effectiveAction.type === ACTION_TYPES.PGREP_PROCESS ? 'process match' : 'repo match';
          const count = Number(searchResult.count || 0);
          result.message = `${count} ${noun}${count === 1 ? '' : 'es'} found`;
        } else {
          result.message = searchResult.error || `${effectiveAction.type} failed`;
        }
        break;
      }

      case ACTION_TYPES.FOCUS_WINDOW:
      case ACTION_TYPES.BRING_WINDOW_TO_FRONT: {
        const enriched = withInferredProcessName(effectiveAction);
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
        const hwnd = await resolveWindowHandle(withInferredProcessName(effectiveAction));
        if (!hwnd) {
          throw new Error('Window not found. Provide hwnd/windowHandle or title/processName/className.');
        }
        await sendWindowToBack(hwnd);
        result.message = `Sent window ${hwnd} to back`;
        break;
      }

      case ACTION_TYPES.MINIMIZE_WINDOW: {
        const hwnd = await resolveWindowHandle(withInferredProcessName(effectiveAction));
        if (!hwnd) {
          throw new Error('Window not found. Provide hwnd/windowHandle or title/processName/className.');
        }
        await minimizeWindow(hwnd);
        result.message = `Minimized window ${hwnd}`;
        break;
      }

      case ACTION_TYPES.RESTORE_WINDOW: {
        const hwnd = await resolveWindowHandle(withInferredProcessName(effectiveAction));
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
          effectiveAction.criteria || { text: effectiveAction.text, automationId: effectiveAction.automationId, controlType: effectiveAction.controlType },
          effectiveAction.value
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
          effectiveAction.criteria || { text: effectiveAction.text, automationId: effectiveAction.automationId, controlType: effectiveAction.controlType },
          { direction: effectiveAction.direction || 'down', amount: effectiveAction.amount ?? -1 }
        );
        result = { ...result, ...seResult };
        result.message = seResult.success
          ? `Scrolled ${effectiveAction.direction || 'down'} via ${seResult.method}`
          : `Scroll failed: ${seResult.error}`;
        break;
      }

      case ACTION_TYPES.EXPAND_ELEMENT: {
        const uia = require('./ui-automation');
        const exResult = await uia.expandElement(
          effectiveAction.criteria || { text: effectiveAction.text, automationId: effectiveAction.automationId, controlType: effectiveAction.controlType }
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
          effectiveAction.criteria || { text: effectiveAction.text, automationId: effectiveAction.automationId, controlType: effectiveAction.controlType }
        );
        result = { ...result, ...clResult };
        result.message = clResult.success
          ? `Collapsed element (${clResult.stateBefore} → ${clResult.stateAfter})`
          : `Collapse failed: ${clResult.error}`;
        break;
      }

      case ACTION_TYPES.GET_TEXT: {
        const uia = require('./ui-automation');
        const pineReadbackPreparation = await preparePineEditorReadbackAction(effectiveAction);
        if (pineReadbackPreparation?.error) {
          result = {
            ...result,
            success: false,
            error: pineReadbackPreparation.error,
            message: `Get text failed: ${pineReadbackPreparation.error}`,
            method: 'ForegroundGuard',
            foreground: pineReadbackPreparation.foreground || null
          };
          break;
        }

        const getTextActionBase = pineReadbackPreparation?.action || effectiveAction;
        const disableTradingViewPineReadbackCDP = getTextActionBase?.disableTradingViewPineReadbackCDP === true
          || runtimeOptions?.disableTradingViewPineReadbackCDP === true;
        const getTextAction = disableTradingViewPineReadbackCDP
          ? {
              ...getTextActionBase,
              disableTradingViewPineReadbackCDP: true
            }
          : getTextActionBase;
        const getTextCriteria = getTextAction.criteria || {
          text: getTextAction.text,
          automationId: getTextAction.automationId,
          controlType: getTextAction.controlType
        };
        const pineReadbackAction = isPineEditorReadbackAction(getTextAction);
        const pineReadbackTimeoutMs = pineReadbackAction
          ? getPineReadbackTimeoutMs(getTextAction)
          : 0;
        let gtResult = null;
        const pineSyntheticReadbackPreferred = pineReadbackAction
          && ['safe-authoring-inspect', 'save-status'].includes(
            String(getTextAction?.pineEvidenceMode || '').trim().toLowerCase()
          );
        const pineSyntheticReadbackAction = pineSyntheticReadbackPreferred
          ? {
              ...getTextAction,
              preferCarriedPineSurfaceProbeOnSlowHost: true
            }
          : getTextAction;

        if (pineSyntheticReadbackPreferred) {
          try {
            gtResult = await runWithTimeout(
              () => getPineEditorTextFallback(pineSyntheticReadbackAction),
              Math.max(
                260,
                Math.min(
                  1800,
                  Math.round((pineReadbackTimeoutMs || getPineReadbackTimeoutMs(getTextAction)) * 0.22)
                )
              ),
              'Pine Editor bounded surface readback'
            );
            if (!gtResult?.success) {
              gtResult = null;
            }
          } catch {
            gtResult = null;
          }
        }

        if (!gtResult && pineReadbackAction) {
          try {
            gtResult = await runWithTimeout(
              () => uia.getElementText(getTextCriteria),
              pineReadbackTimeoutMs,
              'Pine Editor primary readback'
            );
          } catch (error) {
            gtResult = createTimedOutActionResult(error, 'Pine Editor primary readback timed out');
          }
        } else if (!gtResult) {
          gtResult = await uia.getElementText(getTextCriteria);
        }

        if (!gtResult?.success) {
          const pineWatcherFallbackResult = getPineEditorWatcherFallback(getTextAction);
          const pineCarriedSurfaceProbeFallbackResult = pineReadbackAction
            ? buildPineEditorSurfaceProbeSyntheticReadbackResult(
                getTextAction?.pineEditorSurfaceProbe || null,
                getTextAction?.pineEditorSurfaceProbe
                  ? `${getPineEditorSurfaceProbeFallbackMethod(getTextAction.pineEditorSurfaceProbe)} (pine-editor-fallback:carried-probe-timeout)`
                  : ''
              )
            : null;

          if (gtResult?.timedOut) {
            let pineSurfaceProbeFallbackResult = null;
            if (pineReadbackAction) {
              try {
                pineSurfaceProbeFallbackResult = await runWithTimeout(
                  () => getPineEditorSurfaceProbeFallback(getTextAction, {
                    timeoutMs: Math.max(
                      220,
                      Math.min(
                        1800,
                        Math.round((pineReadbackTimeoutMs || getPineReadbackTimeoutMs(getTextAction)) * 0.35)
                      )
                    )
                  }),
                  Math.max(
                    260,
                    Math.min(
                      2200,
                      Math.round((pineReadbackTimeoutMs || getPineReadbackTimeoutMs(getTextAction)) * 0.45)
                    )
                  ),
                  'Pine Editor timeout surface probe'
                );
              } catch {}
            }

            if (pineSurfaceProbeFallbackResult?.success) {
              gtResult = pineSurfaceProbeFallbackResult;
            } else if (pineCarriedSurfaceProbeFallbackResult?.success) {
              gtResult = pineCarriedSurfaceProbeFallbackResult;
            } else if (pineWatcherFallbackResult?.success) {
              gtResult = pineWatcherFallbackResult;
            } else {
              gtResult = {
                ...gtResult,
                error: `${gtResult.error}. Pine Editor was not confirmed active and no host-backed or watcher-backed Pine anchors were visible.`
              };
            }
          } else {
            let pineFallbackResult = null;
            if (pineReadbackAction) {
              try {
                pineFallbackResult = await runWithTimeout(
                  () => getPineEditorTextFallback(getTextAction),
                  pineReadbackTimeoutMs,
                  'Pine Editor fallback readback'
                );
              } catch (error) {
                pineFallbackResult = createTimedOutActionResult(error, 'Pine Editor fallback readback timed out');
              }
            } else {
              pineFallbackResult = await getPineEditorTextFallback(getTextAction);
            }

            if (pineFallbackResult?.success) {
              gtResult = pineFallbackResult;
            } else if (pineCarriedSurfaceProbeFallbackResult?.success) {
              gtResult = pineCarriedSurfaceProbeFallbackResult;
            } else if (pineWatcherFallbackResult?.success) {
              gtResult = pineWatcherFallbackResult;
            } else if (pineFallbackResult?.timedOut) {
              gtResult = {
                ...pineFallbackResult,
                error: `${pineFallbackResult.error}. No watcher-backed Pine anchors were visible.`
              };
            }
          }
        }
        result = { ...result, ...gtResult };
        const pineTargetText = String(getTextAction?.text || getTextAction?.criteria?.text || '');
        if (gtResult.success
          && getTextAction?.pineEvidenceMode === 'provenance-summary'
          && /pine version history/i.test(pineTargetText)) {
          result.pineStructuredSummary = buildPineVersionHistoryStructuredSummary(gtResult.text, getTextAction.pineSummaryFields);
        } else if (gtResult.success && /pine logs/i.test(pineTargetText)) {
          result.pineStructuredSummary = buildPineLogsStructuredSummary(gtResult.text);
        } else if (gtResult.success && /pine profiler/i.test(pineTargetText)) {
          result.pineStructuredSummary = buildPineProfilerStructuredSummary(gtResult.text);
        } else if (gtResult.success && /pine editor/i.test(pineTargetText)) {
          if (getTextAction?.pineEvidenceMode === 'safe-authoring-inspect') {
            result.pineStructuredSummary = buildPineEditorSafeAuthoringSummary(
              gtResult.text,
              {
                ...getTextAction,
                pineEditorSurfaceProbe: gtResult?.pineEditorSurfaceProbe || getTextAction?.pineEditorSurfaceProbe || null
              }
            );
          } else if (
            getTextAction?.pineEvidenceMode === 'compile-result'
            || getTextAction?.pineEvidenceMode === 'diagnostics'
            || getTextAction?.pineEvidenceMode === 'line-budget'
            || getTextAction?.pineEvidenceMode === 'save-status'
            || getTextAction?.pineEvidenceMode === 'generic-status'
          ) {
            result.pineStructuredSummary = buildPineEditorDiagnosticsStructuredSummary(
              gtResult.text,
              getTextAction.pineEvidenceMode,
              {
                ...getTextAction,
                pineEditorSurfaceProbe: gtResult?.pineEditorSurfaceProbe || getTextAction?.pineEditorSurfaceProbe || null
              }
            );
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
        const lookup = toolRegistry.lookupTool(effectiveAction.toolName);
        if (!lookup) {
          throw new Error(`Dynamic tool not found: ${effectiveAction.toolName}`);
        }
        if (!lookup.entry.approved) {
          throw new Error(`Dynamic tool '${effectiveAction.toolName}' has not been approved. Use approveTool() to approve it before execution.`);
        }
        // PreToolUse hook gate — security-check.ps1 can deny dynamic tools
        const hookResult = runPreToolUseHook(`dynamic_${effectiveAction.toolName}`, effectiveAction.args || {});
        if (hookResult.denied) {
          throw new Error(`Dynamic tool '${effectiveAction.toolName}' denied by PreToolUse hook: ${hookResult.reason}`);
        }
        console.log(`[AUTOMATION] Executing dynamic tool: ${effectiveAction.toolName}`);
        const execResult = await sandbox.executeDynamicTool(lookup.absolutePath, effectiveAction.args || {});
        toolRegistry.recordInvocation(effectiveAction.toolName);
        // PostToolUse hook — audit-log.ps1 for execution audit trail
        try {
          runPostToolUseHook(`dynamic_${effectiveAction.toolName}`, effectiveAction.args || {}, {
            success: execResult.success,
            result: execResult.result,
            error: execResult.error
          });
        } catch (_) { /* audit logging is non-fatal */ }
        if (!execResult.success) {
          throw new Error(`Dynamic tool failed: ${execResult.error}`);
        }
        result.message = `Dynamic tool '${effectiveAction.toolName}' returned: ${JSON.stringify(execResult.result)}`;
        result.toolResult = execResult.result;
        break;
      }
        
      default:
        throw new Error(`Unknown action type: ${effectiveAction.type}`);
    }
  } catch (error) {
    result.success = false;
    result.error = error.message;
    result.errorCode = error.code || null;
    if (error.resolvedTarget) {
      resolvedTarget = error.resolvedTarget;
    }
    console.error(`[AUTOMATION] Action failed:`, error);
  }

  if (resolvedTarget) {
    result.resolvedTarget = resolvedTarget;
  }

  result.proof = buildExecutionProof({
    originalAction: action,
    effectiveAction,
    resolvedTarget,
    success: result.success,
    errorMessage: result.error || null,
    errorCode: result.errorCode || null
  });
  appendTradingViewPineActivationProofToExecutionProof(result.proof, result.tradingViewPineActivationProof);
  
  result.duration = Date.now() - startTime;

  // Write structured telemetry for RLVR feedback loop
  try {
    writeTelemetry({
      task: result.message || action.type,
      phase: 'execution',
      outcome: result.success ? 'success' : 'failure',
      actions: [{ type: action.type, ...(action.text ? { text: action.text } : {}), ...(action.key ? { key: action.key } : {}), ...(action.targetId ? { targetId: action.targetId } : {}) }],
      context: {
        actionType: action.type,
        duration: result.duration,
        proofLevel: result.proof?.level ?? 0,
        proofStatus: result.proof?.status || null
      }
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
  resolveActionTarget,
  buildExecutionProof,
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
  getWindowInfoByHandle,
  getClipboardText,
  setClipboardText,
  getRunningProcessesByNames,
  resolveWindowHandle,
  minimizeWindow,
  restoreWindow,
  sendWindowToBack,
  // Semantic element-based automation (preferred approach)
  findElementByText,
  findElementsByWindowWithHost,
  probeWindowAccessibilityWithHost,
  getFocusedElementInWindowWithHost,
  invokeElementByWindowWithHost,
  probeTradingViewPineEditorSurface,
  probeTradingViewPineEditorRendererWithCDP,
  invokeTradingViewRendererButtonWithCDP,
  buildTradingViewPineSurfaceProbeFromRendererInvoke,
  focusTradingViewPineEditorWithCDP,
  readTradingViewPineEditorContentWithCDP,
  setTradingViewPineEditorContentWithCDP,
  setTradingViewPineSaveDialogNameWithCDP,
  captureTradingViewPineActivationSnapshot,
  buildTradingViewPineActivationTransitionProof,
  clickElementByText,
  // v0.0.5: Command execution
  DANGEROUS_COMMAND_PATTERNS,
  isCommandDangerous,
  truncateOutput,
  executeCommand,
  buildPineVersionHistoryStructuredSummary,
  extractPineEditorSafeAuthoringSurfaceState,
  buildPineEditorSafeAuthoringSummary,
  buildPineEditorDiagnosticsStructuredSummary,
  buildPineLogsStructuredSummary,
  buildPineProfilerStructuredSummary,
};
