/**
 * Utility Helpers
 * 
 * Common utility functions for UI automation.
 * @module ui-automation/core/helpers
 */

const { CONFIG } = require('../config');

const LOG_LEVELS = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4
};

function normalizeLogLevel(level, fallback = 'info') {
  const normalized = String(level || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LOG_LEVELS, normalized) ? normalized : fallback;
}

const DEFAULT_LOG_LEVEL = normalizeLogLevel(process.env.LIKU_UI_AUTO_LOG_LEVEL, 'info');

let automationLogLevel = DEFAULT_LOG_LEVEL;
let automationLogHandler = defaultAutomationLogHandler;

function shouldLog(level) {
  const normalizedLevel = normalizeLogLevel(level, 'info');
  return LOG_LEVELS[normalizedLevel] <= LOG_LEVELS[automationLogLevel];
}

function defaultAutomationLogHandler(entry) {
  const prefix = entry.channel === 'debug' ? '[UI-AUTO DEBUG]' : '[UI-AUTO]';
  if (entry.level === 'error') {
    console.error(prefix, ...entry.args);
    return;
  }
  if (entry.level === 'warn') {
    console.warn(prefix, ...entry.args);
    return;
  }
  console.log(prefix, ...entry.args);
}

function emitAutomationLog(entry) {
  if (!shouldLog(entry.level)) return;
  automationLogHandler(entry);
}

function parseLogArgs(args) {
  const parts = [...args];
  let level = 'info';
  if (parts.length > 1) {
    const trailing = String(parts[parts.length - 1] || '').trim().toLowerCase();
    if (trailing === 'error' || trailing === 'warn' || trailing === 'info') {
      level = trailing;
      parts.pop();
    }
  }
  return { level, parts };
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Log debug messages when DEBUG mode is enabled
 * @param {...any} args - Arguments to log
 */
function debug(...args) {
  if (!CONFIG.DEBUG) return;
  emitAutomationLog({ level: 'debug', channel: 'debug', args });
}

/**
 * Log automation actions
 * @param {...any} args - Arguments to log
 */
function log(...args) {
  const { level, parts } = parseLogArgs(args);
  emitAutomationLog({ level, channel: 'main', args: parts });
}

function setLogLevel(level) {
  automationLogLevel = normalizeLogLevel(level, automationLogLevel);
}

function getLogLevel() {
  return automationLogLevel;
}

function setLogHandler(handler) {
  automationLogHandler = typeof handler === 'function' ? handler : defaultAutomationLogHandler;
}

function resetLogSettings() {
  automationLogLevel = DEFAULT_LOG_LEVEL;
  automationLogHandler = defaultAutomationLogHandler;
}

module.exports = {
  sleep,
  debug,
  log,
  getLogLevel,
  resetLogSettings,
  setLogHandler,
  setLogLevel,
};
