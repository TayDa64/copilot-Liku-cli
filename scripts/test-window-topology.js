#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ui = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));

function checkWindowShape(win, label) {
  assert.strictEqual(typeof win, 'object', `${label} returns object`);
  assert.ok('windowKind' in win, `${label} includes windowKind`);
  assert.ok('isTopmost' in win, `${label} includes isTopmost`);
  assert.ok('isToolWindow' in win, `${label} includes isToolWindow`);
  assert.ok('ownerHwnd' in win, `${label} includes ownerHwnd`);
  assert.ok('isMinimized' in win, `${label} includes isMinimized`);
  assert.ok('isMaximized' in win, `${label} includes isMaximized`);
}

async function main() {
  const watcherSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ui-watcher.js'), 'utf-8');
  assert(watcherSource.includes("kind === 'main'"), 'ui-watcher formats MAIN topology tag');
  assert(watcherSource.includes("kind === 'palette'"), 'ui-watcher formats PALETTE topology tag');
  assert(watcherSource.includes('owner:'), 'ui-watcher includes owner handle in window headers');

  const active = await ui.getActiveWindow();
  if (active) {
    checkWindowShape(active, 'getActiveWindow');
  }

  const windows = await ui.findWindows({ includeUntitled: true });
  if (Array.isArray(windows) && windows.length > 0) {
    checkWindowShape(windows[0], 'findWindows');
  }

  console.log('PASS window topology metadata');
}

main().catch((error) => {
  console.error('FAIL window topology metadata');
  console.error(error.stack || error.message);
  process.exit(1);
});
