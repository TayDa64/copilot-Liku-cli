/**
 * Window Management Module
 * 
 * @module ui-automation/window
 */

const {
  getActiveWindow,
  findWindows,
  resolveWindowTarget,
  focusWindow,
  bringWindowToFront,
  sendWindowToBack,
  minimizeWindow,
  maximizeWindow,
  restoreWindow,
} = require('./manager');

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
};
