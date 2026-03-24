/**
 * Screenshot Module
 * 
 * Capture screenshots of screen, windows, or regions.
 * @module ui-automation/screenshot
 */

const { executePowerShellScript } = require('./core/powershell');
const { log } = require('./core/helpers');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/**
 * Take a screenshot
 * 
 * @param {Object} [options] - Screenshot options
 * @param {string} [options.path] - Save path (auto-generated if omitted)
 * @param {boolean} [options.memory=false] - Capture into memory (no file written)
 * @param {boolean} [options.base64=true] - Include base64 output (can be disabled for polling)
 * @param {'sha256'|'dhash'} [options.metric='sha256'] - Additional lightweight fingerprint metric
 * @param {Object} [options.region] - Region to capture {x, y, width, height}
 * @param {number} [options.windowHwnd] - Capture specific window by handle
 * @param {string} [options.format='png'] - Image format (png, jpg, bmp)
 * @returns {Promise<{success: boolean, path: string|null, base64: string|null, hash: string|null}>}
 */
async function screenshot(options = {}) {
  const { 
    path: savePath, 
    memory = false,
    base64: includeBase64 = true,
    metric = 'sha256',
    region, 
    windowHwnd,
    format = 'png',
  } = options;
  
  // Generate path if not provided (only when writing to disk)
  const outputPath = (!memory && savePath) ? savePath : (!memory ? path.join(
    os.tmpdir(),
    `screenshot_${Date.now()}.${format}`
  ) : null);
  
  // Build PowerShell script based on capture type
  let captureScript;
  
  if (windowHwnd) {
    // Capture specific window
    captureScript = `
Add-Type @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public class WindowCapture {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hDC, int flags);
    
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public static Bitmap CapturePrintWindow(IntPtr hwnd) {
        RECT rect;
        GetWindowRect(hwnd, out rect);
        int w = rect.Right - rect.Left;
        int h = rect.Bottom - rect.Top;
        if (w <= 0 || h <= 0) return null;

        var bmp = new Bitmap(w, h);
        using (var g = Graphics.FromImage(bmp)) {
            IntPtr hdc = g.GetHdc();
        bool ok = PrintWindow(hwnd, hdc, 2);
            g.ReleaseHdc(hdc);
        if (!ok) {
          bmp.Dispose();
          return null;
        }
        }
        return bmp;
    }

    public static Bitmap CaptureFromScreen(IntPtr hwnd) {
      RECT rect;
      GetWindowRect(hwnd, out rect);
      int w = rect.Right - rect.Left;
      int h = rect.Bottom - rect.Top;
      if (w <= 0 || h <= 0) return null;

      var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
      using (var g = Graphics.FromImage(bmp)) {
        g.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
      }
      return bmp;
    }
}
'@

Add-Type -AssemblyName System.Drawing
  $captureMode = 'window-printwindow'
  $hwnd = [IntPtr]::new(${windowHwnd})
  $bmp = [WindowCapture]::CapturePrintWindow($hwnd)
  if ($bmp -eq $null) {
    $bmp = [WindowCapture]::CaptureFromScreen($hwnd)
    $captureMode = 'window-copyfromscreen'
  }
`;
  } else if (region) {
    // Capture region
    captureScript = `
Add-Type -AssemblyName System.Drawing
  $captureMode = 'region-copyfromscreen'
$bmp = New-Object System.Drawing.Bitmap(${region.width}, ${region.height})
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${region.x}, ${region.y}, 0, 0, $bmp.Size)
$g.Dispose()
`;
  } else {
    // Capture full screen
    captureScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

  $captureMode = 'screen-copyfromscreen'
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$g.Dispose()
`;
  }
  
  // Add output
  const formatMap = { png: 'Png', jpg: 'Jpeg', bmp: 'Bmp' };
  const imageFormat = formatMap[format.toLowerCase()] || 'Png';
  
  const includeDHash = String(metric).toLowerCase() === 'dhash';

  const psScript = `
${captureScript}
if ($bmp -eq $null) {
    Write-Output "capture_failed"
    exit
}

# Encode to bytes (memory-first)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::${imageFormat})
$bytes = $ms.ToArray()
$ms.Dispose()

${includeDHash ? `
# Compute a small perceptual dHash (9x8 grayscale comparison)
Add-Type -AssemblyName System.Drawing
$small = New-Object System.Drawing.Bitmap 9, 8
$gg = [System.Drawing.Graphics]::FromImage($small)
$gg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
$gg.DrawImage($bmp, 0, 0, 9, 8)
$gg.Dispose()

function Get-Brightness([System.Drawing.Color]$c) { return [int]$c.R + [int]$c.G + [int]$c.B }

$hash = [UInt64]0
$bit = 0
for ($y = 0; $y -lt 8; $y++) {
  for ($x = 0; $x -lt 8; $x++) {
    $b1 = Get-Brightness ($small.GetPixel($x, $y))
    $b2 = Get-Brightness ($small.GetPixel($x + 1, $y))
    if ($b1 -lt $b2) {
      $hash = $hash -bor ([UInt64]1 -shl $bit)
    }
    $bit++
  }
}
$small.Dispose()
$dhashHex = $hash.ToString('X16')
Write-Output "SCREENSHOT_DHASH:$dhashHex"
` : ''}

$bmp.Dispose()

${includeBase64 ? `
$base64 = [System.Convert]::ToBase64String($bytes)
Write-Output "SCREENSHOT_BASE64:$base64"
` : ''}

Write-Output "SCREENSHOT_CAPTURE_MODE:$captureMode"

${memory ? "" : `$path = '${(outputPath || '').replace(/\\/g, '\\\\').replace(/'/g, "''")}'\n[System.IO.File]::WriteAllBytes($path, $bytes)\nWrite-Output \"SCREENSHOT_PATH:$path\"\n`}
`;

  try {
    const result = await executePowerShellScript(psScript);
    
    if (result.stdout.includes('capture_failed')) {
      log('Screenshot capture failed', 'error');
      return { success: false, path: null, base64: null, hash: null, dhash: null };
    }
    
    const base64Match = result.stdout.match(/SCREENSHOT_BASE64:(.+)/);
    const dhashMatch = result.stdout.match(/SCREENSHOT_DHASH:([0-9A-Fa-f]{16})/);
    const captureModeMatch = result.stdout.match(/SCREENSHOT_CAPTURE_MODE:(.+)/);

    const pathMatch = result.stdout.match(/SCREENSHOT_PATH:(.+)/);
    const screenshotPath = pathMatch ? pathMatch[1].trim() : outputPath;
    const base64 = base64Match ? base64Match[1].trim() : null;
    const dhash = dhashMatch ? dhashMatch[1].trim().toLowerCase() : null;
    const captureMode = captureModeMatch ? captureModeMatch[1].trim() : null;

    const hash = base64
      ? crypto.createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex')
      : null;
    
    if (screenshotPath) {
      log(`Screenshot saved to: ${screenshotPath}`);
    }

    return { success: true, path: screenshotPath || null, base64, hash, dhash, captureMode };
  } catch (err) {
    log(`Screenshot error: ${err.message}`, 'error');
    return { success: false, path: null, base64: null, hash: null, dhash: null, captureMode: null };
  }
}

/**
 * Take screenshot of active window
 * 
 * @param {Object} [options] - Screenshot options
 * @returns {Promise<{success: boolean, path: string|null}>}
 */
async function screenshotActiveWindow(options = {}) {
  const { getActiveWindow } = require('./window');
  const activeWindow = await getActiveWindow();
  
  if (!activeWindow) {
    return { success: false, path: null, base64: null, hash: null, dhash: null, captureMode: null };
  }
  
  return screenshot({ ...options, windowHwnd: activeWindow.hwnd });
}

/**
 * Take screenshot of element
 * 
 * @param {Object} criteria - Element search criteria
 * @param {Object} [options] - Screenshot options
 * @returns {Promise<{success: boolean, path: string|null}>}
 */
async function screenshotElement(criteria, options = {}) {
  const { findElement } = require('./elements');
  const element = await findElement(criteria);
  
  if (!element || !element.bounds) {
    return { success: false, path: null, base64: null, hash: null, dhash: null, captureMode: null };
  }
  
  return screenshot({ ...options, region: element.bounds });
}

module.exports = {
  screenshot,
  screenshotActiveWindow,
  screenshotElement,
};
