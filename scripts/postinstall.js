#!/usr/bin/env node
/**
 * postinstall — attempt to build the .NET UIA host binary on Windows.
 * Gracefully skips on non-Windows platforms or if .NET SDK is absent.
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const BIN_DIR = path.join(ROOT, 'bin');
const EXE = path.join(BIN_DIR, 'WindowsUIA.exe');
const BUILD_SCRIPT = path.join(ROOT, 'src', 'native', 'windows-uia-dotnet', 'build.ps1');

// Skip on non-Windows
if (process.platform !== 'win32') {
  console.log('[postinstall] Not Windows — skipping UIA host build (headless CLI commands still work).');
  process.exit(0);
}

// Already built?
if (fs.existsSync(EXE)) {
  console.log('[postinstall] WindowsUIA.exe already exists — skipping build.');
  process.exit(0);
}

// Check for .NET SDK
try {
  const ver = execSync('dotnet --version', { encoding: 'utf-8', timeout: 10000 }).trim();
  const major = parseInt(ver.split('.')[0], 10);
  if (major < 9) {
    console.log(`[postinstall] .NET SDK ${ver} found but v9+ required for UIA host. Skipping build.`);
    console.log('  Install .NET 9 SDK from https://dotnet.microsoft.com/download and run: npm run build:uia');
    process.exit(0);
  }
} catch {
  console.log('[postinstall] .NET SDK not found — skipping UIA host build.');
  console.log('  UI-automation features require the .NET 9 host. Install .NET 9 SDK and run: npm run build:uia');
  process.exit(0);
}

// Check for build script
if (!fs.existsSync(BUILD_SCRIPT)) {
  console.log('[postinstall] Build script not found — skipping UIA host build.');
  process.exit(0);
}

// Build
console.log('[postinstall] Building WindowsUIA.exe...');
try {
  execSync(
    `powershell -ExecutionPolicy Bypass -File "${BUILD_SCRIPT}"`,
    { cwd: ROOT, stdio: 'inherit', timeout: 120000 }
  );
  if (fs.existsSync(EXE)) {
    console.log('[postinstall] WindowsUIA.exe built successfully.');
  } else {
    console.warn('[postinstall] Build completed but WindowsUIA.exe not found. Run manually: npm run build:uia');
  }
} catch (err) {
  console.warn('[postinstall] UIA host build failed (non-fatal). Run manually: npm run build:uia');
  console.warn('  ' + (err.message || err));
}
