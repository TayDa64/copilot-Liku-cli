/**
 * Window Management Module
 * 
 * Find, focus, and interact with windows.
 * @module ui-automation/window
 */

const { executePowerShellScript } = require('../core/powershell');
const { log, sleep } = require('../core/helpers');

/**
 * Get the active (foreground) window info
 * 
 * @returns {Promise<{hwnd: number, title: string, processName: string, className: string, bounds: Object} | null>}
 */
async function getActiveWindow() {
  const psScript = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class WinAPI {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder name, int count);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

$hwnd = [WinAPI]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "null"; exit }

$titleSB = New-Object System.Text.StringBuilder 256
$classSB = New-Object System.Text.StringBuilder 256
[void][WinAPI]::GetWindowText($hwnd, $titleSB, 256)
[void][WinAPI]::GetClassName($hwnd, $classSB, 256)

$procId = 0
[void][WinAPI]::GetWindowThreadProcessId($hwnd, [ref]$procId)
$proc = Get-Process -Id $procId -ErrorAction SilentlyContinue

$rect = New-Object WinAPI+RECT
[void][WinAPI]::GetWindowRect($hwnd, [ref]$rect)

@{
    hwnd = $hwnd.ToInt64()
    title = $titleSB.ToString()
    className = $classSB.ToString()
    processName = if ($proc) { $proc.ProcessName } else { "" }
    bounds = @{ x = $rect.Left; y = $rect.Top; width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top }
} | ConvertTo-Json -Compress
`;

  try {
    const result = await executePowerShellScript(psScript);
    if (result.stdout.trim() === 'null') return null;
    const data = JSON.parse(result.stdout.trim());
    log(`Active window: "${data.title}" (${data.processName})`);
    return data;
  } catch (err) {
    log(`getActiveWindow error: ${err.message}`, 'error');
    return null;
  }
}

/**
 * Find windows matching criteria
 * 
 * @param {Object} [criteria] - Search criteria
 * @param {string} [criteria.title] - Window title contains
 * @param {string} [criteria.processName] - Process name equals
 * @param {string} [criteria.className] - Window class contains
 * @returns {Promise<Array<{hwnd: number, title: string, processName: string, className: string, bounds: Object}>>}
 */
async function findWindows(criteria = {}) {
  const { title, processName, className, includeUntitled = false } = criteria;
  
  const psScript = `
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class WindowFinder {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder name, int count);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    
    public static List<IntPtr> windows = new List<IntPtr>();
    
    public static void Find() {
        windows.Clear();
        EnumWindows((h, l) => { if (IsWindowVisible(h)) windows.Add(h); return true; }, IntPtr.Zero);
    }
}
'@

[WindowFinder]::Find()
$results = @()

foreach ($hwnd in [WindowFinder]::windows) {
    $titleSB = New-Object System.Text.StringBuilder 256
    $classSB = New-Object System.Text.StringBuilder 256
    [void][WindowFinder]::GetWindowText($hwnd, $titleSB, 256)
    [void][WindowFinder]::GetClassName($hwnd, $classSB, 256)
    
    $t = $titleSB.ToString()
    $c = $classSB.ToString()
    ${includeUntitled ? '' : 'if ([string]::IsNullOrEmpty($t)) { continue }'}
    
    ${title ? `if (-not $t.ToLower().Contains('${title.toLowerCase().replace(/'/g, "''")}')) { continue }` : ''}
    ${className ? `if (-not $c.ToLower().Contains('${className.toLowerCase().replace(/'/g, "''")}')) { continue }` : ''}
    
    $procId = 0
    [void][WindowFinder]::GetWindowThreadProcessId($hwnd, [ref]$procId)
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    $pn = if ($proc) { $proc.ProcessName } else { "" }
    
    ${processName ? `if ($pn -ne '${processName.replace(/'/g, "''")}') { continue }` : ''}
    
    $rect = New-Object WindowFinder+RECT
    [void][WindowFinder]::GetWindowRect($hwnd, [ref]$rect)
    
    $results += @{
        hwnd = $hwnd.ToInt64()
        title = $t
        className = $c
        processName = $pn
        bounds = @{ x = $rect.Left; y = $rect.Top; width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top }
    }
}

$results | ConvertTo-Json -Compress
`;

  try {
    const result = await executePowerShellScript(psScript);
    const output = result.stdout.trim();
    if (!output || output === 'null') return [];
    const data = JSON.parse(output);
    const windows = Array.isArray(data) ? data : [data];
    log(`Found ${windows.length} windows matching criteria`);
    return windows;
  } catch (err) {
    log(`findWindows error: ${err.message}`, 'error');
    return [];
  }
}

/**
 * Resolve a target into window handle + optional window metadata
 *
 * @param {number|string|Object} target
 * @returns {Promise<{hwnd: number|null, window: Object|null}>}
 */
async function resolveWindowTarget(target) {
  if (typeof target === 'number') {
    return { hwnd: target, window: null };
  }

  if (typeof target === 'string') {
    const windows = await findWindows({ title: target });
    if (windows.length > 0) {
      return { hwnd: windows[0].hwnd, window: windows[0] };
    }
    return { hwnd: null, window: null };
  }

  if (typeof target === 'object' && target) {
    if (target.hwnd) {
      return { hwnd: Number(target.hwnd), window: target };
    }
    const windows = await findWindows(target);
    if (windows.length > 0) {
      return { hwnd: windows[0].hwnd, window: windows[0] };
    }
  }

  return { hwnd: null, window: null };
}

/**
 * Focus a window (bring to foreground)
 * 
 * @param {number|string|Object} target - Window handle, title substring, or criteria object
 * @returns {Promise<{success: boolean, window: Object|null}>}
 */
async function focusWindow(target) {
  const resolved = await resolveWindowTarget(target);
  const hwnd = resolved.hwnd;
  const windowInfo = resolved.window;
  
  if (!hwnd) {
    log(`focusWindow: No window found for target`, 'warn');
    return { success: false, window: null };
  }
  
  const psScript = `
Add-Type @'
using System;
using System.Runtime.InteropServices;

public class FocusHelper {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@

$hwnd = [IntPtr]::new(${hwnd})
[FocusHelper]::ShowWindow($hwnd, 9)  # SW_RESTORE
Start-Sleep -Milliseconds 50
[FocusHelper]::BringWindowToTop($hwnd)
[FocusHelper]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 100

$fg = [FocusHelper]::GetForegroundWindow()
if ($fg -eq $hwnd) { "focused" } else { "failed" }
`;

  const result = await executePowerShellScript(psScript);
  const success = result.stdout.includes('focused');
  log(`focusWindow hwnd=${hwnd} - ${success ? 'success' : 'failed'}`);
  
  return { success, window: windowInfo };
}

/**
 * Bring window to front (foreground + top z-order)
 *
 * @param {number|string|Object} target
 * @returns {Promise<{success: boolean, window: Object|null}>}
 */
async function bringWindowToFront(target) {
  return focusWindow(target);
}

/**
 * Send a window to back of z-order without activating it
 *
 * @param {number|string|Object} target
 * @returns {Promise<{success: boolean, window: Object|null}>}
 */
async function sendWindowToBack(target) {
  const resolved = await resolveWindowTarget(target);
  const hwnd = resolved.hwnd;
  const windowInfo = resolved.window;

  if (!hwnd) {
    log('sendWindowToBack: No window found for target', 'warn');
    return { success: false, window: null };
  }

  const psScript = `
Add-Type @'
using System;
using System.Runtime.InteropServices;

public class ZOrderHelper {
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    public static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_NOOWNERZORDER = 0x0200;
}
'@

$hwnd = [IntPtr]::new(${hwnd})
$ok = [ZOrderHelper]::SetWindowPos(
    $hwnd,
    [ZOrderHelper]::HWND_BOTTOM,
    0, 0, 0, 0,
    [ZOrderHelper]::SWP_NOSIZE -bor [ZOrderHelper]::SWP_NOMOVE -bor [ZOrderHelper]::SWP_NOACTIVATE -bor [ZOrderHelper]::SWP_NOOWNERZORDER
)
if ($ok) { 'backed' } else { 'failed' }
`;

  const result = await executePowerShellScript(psScript);
  const success = result.stdout.includes('backed');
  log(`sendWindowToBack hwnd=${hwnd} - ${success ? 'success' : 'failed'}`);
  return { success, window: windowInfo };
}

/**
 * Minimize a window
 * 
 * @param {number|string|Object} target - Window handle/title/criteria
 * @returns {Promise<{success: boolean}>}
 */
async function minimizeWindow(target) {
  const resolved = await resolveWindowTarget(target);
  const hwnd = resolved.hwnd;
  if (!hwnd) {
    return { success: false };
  }

  // WindowPattern capability check
  const caps = await getWindowCapabilities(hwnd);
  if (caps && !caps.canMinimize) {
    log('minimizeWindow: WindowPattern reports CanMinimize=false', 'warn');
    return { success: false, error: 'Window does not support minimize (WindowPattern.CanMinimize=false)' };
  }

  const psScript = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class MinHelper {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
}
'@
[MinHelper]::ShowWindow([IntPtr]::new(${hwnd}), 6)  # SW_MINIMIZE
'minimized'
`;

  const result = await executePowerShellScript(psScript);
  return { success: result.stdout.includes('minimized') };
}

/**
 * Maximize a window
 * 
 * @param {number|string|Object} target - Window handle/title/criteria
 * @returns {Promise<{success: boolean}>}
 */
async function maximizeWindow(target) {
  const resolved = await resolveWindowTarget(target);
  const hwnd = resolved.hwnd;
  if (!hwnd) {
    return { success: false };
  }

  // WindowPattern capability check
  const caps = await getWindowCapabilities(hwnd);
  if (caps && !caps.canMaximize) {
    log('maximizeWindow: WindowPattern reports CanMaximize=false', 'warn');
    return { success: false, error: 'Window does not support maximize (WindowPattern.CanMaximize=false)' };
  }

  const psScript = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class MaxHelper {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
}
'@
[MaxHelper]::ShowWindow([IntPtr]::new(${hwnd}), 3)  # SW_MAXIMIZE
'maximized'
`;

  const result = await executePowerShellScript(psScript);
  return { success: result.stdout.includes('maximized') };
}

/**
 * Restore a window to normal state
 * 
 * @param {number|string|Object} target - Window handle/title/criteria
 * @returns {Promise<{success: boolean}>}
 */
async function restoreWindow(target) {
  const resolved = await resolveWindowTarget(target);
  const hwnd = resolved.hwnd;
  if (!hwnd) {
    return { success: false };
  }

  const psScript = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class RestoreHelper {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
}
'@
[RestoreHelper]::ShowWindow([IntPtr]::new(${hwnd}), 9)  # SW_RESTORE
'restored'
`;

  const result = await executePowerShellScript(psScript);
  return { success: result.stdout.includes('restored') };
}

/**
 * Query WindowPattern capabilities (CanMinimize, CanMaximize) for a window.
 * Returns { canMinimize, canMaximize } or null if WindowPattern unavailable.
 *
 * @param {number} hwnd - Native window handle
 * @returns {Promise<{canMinimize: boolean, canMaximize: boolean} | null>}
 */
async function getWindowCapabilities(hwnd) {
  if (!hwnd) return null;
  const psScript = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
try {
  $el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new(${hwnd}))
  $hasWP = [bool]$el.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::IsWindowPatternAvailableProperty)
  if (-not $hasWP) { Write-Output '{"available":false}'; exit }
  $wp = $el.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
  $info = $wp.Current
  @{
    available = $true
    canMinimize = $info.CanMinimize
    canMaximize = $info.CanMaximize
    isModal = $info.IsModal
    windowState = $info.WindowVisualState.ToString()
  } | ConvertTo-Json -Compress
} catch {
  Write-Output '{"available":false}'
}
`;
  try {
    const result = await executePowerShellScript(psScript);
    const parsed = JSON.parse(result.stdout.trim());
    if (!parsed.available) return null;
    return { canMinimize: parsed.canMinimize, canMaximize: parsed.canMaximize };
  } catch {
    return null;
  }
}

module.exports = {
  getActiveWindow,
  findWindows,
  resolveWindowTarget,
  focusWindow,
  bringWindowToFront,
  sendWindowToBack,
  minimizeWindow,
  maximizeWindow,
  restoreWindow,
  getWindowCapabilities,
};
