/**
 * screenshot command - Capture screenshot
 * @module cli/commands/screenshot
 */

const path = require('path');
const fs = require('fs');
const { success, error, info } = require('../util/output');

const UI_MODULE = path.resolve(__dirname, '../../main/ui-automation');
let ui;

function loadUI() {
  if (!ui) {
    ui = require(UI_MODULE);
  }
  return ui;
}

/**
 * Run the screenshot command
 * 
 * Usage:
 *   liku screenshot                    # Save to temp with timestamp
 *   liku screenshot ./capture.png      # Save to specific path
 *   liku screenshot --memory --json    # Capture in-memory only (no file), returns base64
 *   liku screenshot --memory --hash --json  # In-memory + SHA-256 hash
 *   liku screenshot --clipboard        # Copy to clipboard (TODO)
 */
async function run(args, options) {
  loadUI();

  const memoryOnly = options.memory === true || options.memory === 'true';
  const includeHash = options.hash === true || options.hash === 'true';
  
  // Determine output path
  let outputPath = args[0];

  if (!memoryOnly) {
    if (!outputPath) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      outputPath = path.join(process.cwd(), `screenshot_${timestamp}.png`);
    } else {
      // Resolve relative paths
      if (!path.isAbsolute(outputPath)) {
        outputPath = path.resolve(process.cwd(), outputPath);
      }
    }

    // Ensure directory exists
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  
  if (!options.quiet) {
    if (!options.json) {
      info(memoryOnly ? 'Capturing screenshot (memory-only)...' : 'Capturing screenshot...');
    }
  }
  
  const result = await ui.screenshot(memoryOnly ? { memory: true } : { path: outputPath });
  
  if (result.success) {
    if (!options.quiet) {
      if (!options.json) {
        if (memoryOnly) {
          success('Screenshot captured (memory-only)');
        } else {
          success(`Screenshot saved: ${result.path}`);
        }
      }
    }
    return { 
      success: true, 
      path: result.path,
      // Include base64/hash only when JSON output requested
      ...(options.json && result.base64 ? { base64: result.base64 } : {}),
      ...(options.json && includeHash && result.hash ? { hash: result.hash } : {}),
    };
  } else {
    error(`Screenshot failed: ${result.error || 'Unknown error'}`);
    return { success: false, error: result.error };
  }
}

module.exports = { run };
