/**
 * PowerShell Execution Layer
 * 
 * Provides reliable PowerShell script execution for UI automation.
 * @module ui-automation/core/powershell
 */

const { exec, execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { CONFIG } = require('../config');

/**
 * Execute a PowerShell script from a temp file
 * More reliable than inline commands for complex scripts
 * 
 * @param {string} script - PowerShell script content
 * @param {number} [timeout] - Execution timeout in ms
 * @returns {Promise<{stdout: string, stderr: string, error?: string}>}
 */
async function executePowerShellScript(script, timeout = CONFIG.DEFAULT_TIMEOUT) {
  const scriptPath = path.join(
    CONFIG.TEMP_DIR, 
    `script_${Date.now()}_${Math.random().toString(36).slice(2)}.ps1`
  );
  
  try {
    fs.writeFileSync(scriptPath, script, 'utf8');

    return new Promise((resolve) => {
      const child = spawn('powershell', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath
      ], {
        windowsHide: true
      });

      let stdout = '';
      let stderr = '';
      let resolved = false;
      let timedOut = false;
      let timer = null;
      const maxBuffer = Number(CONFIG.PS_MAX_BUFFER || 1024 * 1024) || 1024 * 1024;

      const cleanup = () => {
        try { fs.unlinkSync(scriptPath); } catch {}
      };

      const finish = (result) => {
        if (resolved) return;
        resolved = true;
        if (timer) clearTimeout(timer);
        cleanup();
        resolve(result);
      };

      const appendOutput = (target, chunk) => {
        const next = target + String(chunk || '');
        return next.length > maxBuffer ? next.slice(0, maxBuffer) : next;
      };

      const killProcessTree = () => {
        if (!child.pid) return;
        if (process.platform === 'win32') {
          execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
        } else {
          try { child.kill('SIGKILL'); } catch {}
        }
      };

      timer = setTimeout(() => {
        timedOut = true;
        killProcessTree();
      }, Math.max(100, Number(timeout || CONFIG.DEFAULT_TIMEOUT || 10000)));

      child.stdout.on('data', (chunk) => {
        stdout = appendOutput(stdout, chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr = appendOutput(stderr, chunk);
      });
      child.on('error', (error) => {
        finish({ stdout, stderr, error: error.message });
      });
      child.on('close', (code, signal) => {
        if (timedOut) {
          finish({
            stdout,
            stderr,
            error: `PowerShell script timed out after ${Math.max(100, Number(timeout || CONFIG.DEFAULT_TIMEOUT || 10000))}ms`
          });
          return;
        }
        if (code && code !== 0) {
          finish({
            stdout,
            stderr,
            error: `PowerShell exited with code ${code}${signal ? ` (${signal})` : ''}`
          });
          return;
        }
        finish({ stdout, stderr });
      });
    });
  } catch (err) {
    try { fs.unlinkSync(scriptPath); } catch {}
    return { stdout: '', stderr: '', error: err.message };
  }
}

/**
 * Execute a simple PowerShell command inline
 * 
 * @param {string} command - PowerShell command
 * @returns {Promise<string>} Command output
 */
async function executePowerShell(command) {
  return new Promise((resolve, reject) => {
    const psCommand = command.replace(/"/g, '`"');
    
    exec(`powershell -NoProfile -Command "${psCommand}"`, {
      encoding: 'utf8',
      maxBuffer: CONFIG.PS_MAX_BUFFER,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

module.exports = {
  executePowerShellScript,
  executePowerShell,
};
