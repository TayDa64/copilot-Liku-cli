/**
 * Pattern-Based UIA Interactions (Phase 3)
 *
 * Uses the persistent .NET UIA host to execute pattern actions
 * (ValuePattern, ScrollPattern, ExpandCollapsePattern, TextPattern)
 * directly on elements — no mouse simulation needed.
 *
 * @module ui-automation/interactions/pattern-actions
 */

const { findElement, waitForElement } = require('../elements');
const { getSharedUIAHost } = require('../core/uia-host');
const { log } = require('../core/helpers');
const { moveMouse, scroll: mouseWheelScroll } = require('../mouse');

/**
 * Normalize pattern name to short form.
 * Handles both "Invoke" (from .NET host) and "InvokePatternIdentifiers.Pattern" (from PowerShell finder).
 */
function normalizePatternName(name) {
  return name.replace('PatternIdentifiers.Pattern', '');
}

/**
 * Check whether an element supports a given pattern (handles both naming formats).
 */
function hasPattern(element, patternShortName) {
  if (!element?.patterns) return false;
  return element.patterns.some(p => normalizePatternName(p) === patternShortName);
}

/**
 * Get element center coordinates from bounds.
 */
function getCenter(element) {
  const b = element.bounds || element.Bounds;
  if (!b) return null;
  return {
    x: (b.x ?? b.X ?? 0) + (b.width ?? b.Width ?? 0) / 2,
    y: (b.y ?? b.Y ?? 0) + (b.height ?? b.Height ?? 0) / 2
  };
}

/**
 * Set value on an element using ValuePattern.
 *
 * @param {Object} criteria - Element search criteria ({text, automationId, controlType, ...})
 * @param {string} value - The value to set
 * @param {Object} [options]
 * @param {number} [options.waitTimeout=0] - Wait for element (ms)
 * @returns {Promise<{success: boolean, method?: string, error?: string}>}
 */
async function setElementValue(criteria, value, options = {}) {
  const { waitTimeout = 0 } = options;

  const findResult = waitTimeout > 0
    ? await waitForElement(criteria, { timeout: waitTimeout })
    : await findElement(criteria);

  const element = findResult?.element || findResult;
  if (!element?.bounds && !element?.Bounds) {
    return { success: false, error: 'Element not found' };
  }

  const center = getCenter(element);
  if (!center) return { success: false, error: 'Cannot determine element coordinates' };

  try {
    const host = getSharedUIAHost();
    const resp = await host.setValue(center.x, center.y, value);
    log(`setElementValue: ValuePattern.SetValue succeeded on "${element.name || element.Name || ''}"`);
    return { success: true, method: 'ValuePattern', element: resp.element };
  } catch (err) {
    return { success: false, error: err.message, patternUnsupported: err.message.includes('not supported') };
  }
}

/**
 * Scroll an element using ScrollPattern.
 *
 * @param {Object} criteria - Element search criteria
 * @param {Object} [options]
 * @param {string} [options.direction='down'] - up|down|left|right
 * @param {number} [options.amount=-1] - Scroll percent (0-100) or -1 for small increment
 * @param {number} [options.waitTimeout=0]
 * @returns {Promise<{success: boolean, method?: string, scrollInfo?: Object, error?: string}>}
 */
async function scrollElement(criteria, options = {}) {
  const { direction = 'down', amount = -1, waitTimeout = 0 } = options;

  const findResult = waitTimeout > 0
    ? await waitForElement(criteria, { timeout: waitTimeout })
    : await findElement(criteria);

  const element = findResult?.element || findResult;
  if (!element?.bounds && !element?.Bounds) {
    return { success: false, error: 'Element not found' };
  }

  const center = getCenter(element);
  if (!center) return { success: false, error: 'Cannot determine element coordinates' };

  try {
    const host = getSharedUIAHost();
    const resp = await host.scroll(center.x, center.y, direction, amount);
    log(`scrollElement: ScrollPattern.Scroll ${direction} on "${element.name || element.Name || ''}"`);
    return { success: true, method: 'ScrollPattern', direction, scrollInfo: resp.scrollInfo };
  } catch (err) {
    // Fallback: mouse wheel simulation at element center
    if (err.message.includes('not supported')) {
      try {
        await moveMouse(center.x, center.y);
        const wheelAmount = amount > 0 ? Math.ceil(amount / 33) : 3; // ~3 notches for small increment
        await mouseWheelScroll(direction, wheelAmount);
        log(`scrollElement: ScrollPattern unsupported, fell back to mouse wheel at (${center.x}, ${center.y})`);
        return { success: true, method: 'mouseWheel', direction, fallback: true };
      } catch (fallbackErr) {
        return { success: false, error: fallbackErr.message, patternUnsupported: true };
      }
    }
    return { success: false, error: err.message };
  }
}

/**
 * Expand an element using ExpandCollapsePattern.
 *
 * @param {Object} criteria - Element search criteria
 * @param {Object} [options]
 * @param {number} [options.waitTimeout=0]
 * @returns {Promise<{success: boolean, method?: string, stateBefore?: string, stateAfter?: string, error?: string}>}
 */
async function expandElement(criteria, options = {}) {
  return _expandCollapseAction(criteria, 'expand', options);
}

/**
 * Collapse an element using ExpandCollapsePattern.
 *
 * @param {Object} criteria - Element search criteria
 * @param {Object} [options]
 * @param {number} [options.waitTimeout=0]
 * @returns {Promise<{success: boolean, method?: string, stateBefore?: string, stateAfter?: string, error?: string}>}
 */
async function collapseElement(criteria, options = {}) {
  return _expandCollapseAction(criteria, 'collapse', options);
}

/**
 * Toggle expand/collapse on an element.
 *
 * @param {Object} criteria - Element search criteria
 * @param {Object} [options]
 * @param {number} [options.waitTimeout=0]
 * @returns {Promise<{success: boolean, method?: string, stateBefore?: string, stateAfter?: string, error?: string}>}
 */
async function toggleExpandCollapse(criteria, options = {}) {
  return _expandCollapseAction(criteria, 'toggle', options);
}

async function _expandCollapseAction(criteria, action, options = {}) {
  const { waitTimeout = 0 } = options;

  const findResult = waitTimeout > 0
    ? await waitForElement(criteria, { timeout: waitTimeout })
    : await findElement(criteria);

  const element = findResult?.element || findResult;
  if (!element?.bounds && !element?.Bounds) {
    return { success: false, error: 'Element not found' };
  }

  const center = getCenter(element);
  if (!center) return { success: false, error: 'Cannot determine element coordinates' };

  try {
    const host = getSharedUIAHost();
    const resp = await host.expandCollapse(center.x, center.y, action);
    log(`expandCollapse: ${action} on "${element.name || element.Name || ''}" (${resp.stateBefore} → ${resp.stateAfter})`);
    return {
      success: true,
      method: 'ExpandCollapsePattern',
      action,
      stateBefore: resp.stateBefore,
      stateAfter: resp.stateAfter
    };
  } catch (err) {
    return { success: false, error: err.message, patternUnsupported: err.message.includes('not supported') };
  }
}

/**
 * Get text content from an element using TextPattern (preferred) → ValuePattern → Name fallback.
 *
 * @param {Object} criteria - Element search criteria
 * @param {Object} [options]
 * @param {number} [options.waitTimeout=0]
 * @returns {Promise<{success: boolean, text?: string, method?: string, error?: string}>}
 */
async function getElementText(criteria, options = {}) {
  const { waitTimeout = 0 } = options;

  const findResult = waitTimeout > 0
    ? await waitForElement(criteria, { timeout: waitTimeout })
    : await findElement(criteria);

  const element = findResult?.element || findResult;
  if (!element?.bounds && !element?.Bounds) {
    return { success: false, error: 'Element not found' };
  }

  const center = getCenter(element);
  if (!center) return { success: false, error: 'Cannot determine element coordinates' };

  try {
    const host = getSharedUIAHost();
    const resp = await host.getText(center.x, center.y);
    log(`getElementText: ${resp.method} returned text for "${element.name || element.Name || ''}"`);
    return { success: true, text: resp.text, method: resp.method, element: resp.element };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  // Pattern helpers
  normalizePatternName,
  hasPattern,
  // Pattern actions
  setElementValue,
  scrollElement,
  expandElement,
  collapseElement,
  toggleExpandCollapse,
  getElementText,
};
