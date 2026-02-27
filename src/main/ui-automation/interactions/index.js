/**
 * Interactions Module
 * 
 * @module ui-automation/interactions
 */

const { 
  click, 
  clickByText, 
  clickByAutomationId, 
  rightClick, 
  doubleClick,
  clickElement,
  invokeElement,
} = require('./element-click');

const {
  fillField,
  selectDropdownItem,
  waitForWindow,
  clickSequence,
  hover,
  waitAndClick,
  clickAndWaitFor,
  selectFromDropdown,
} = require('./high-level');

const {
  normalizePatternName,
  hasPattern,
  setElementValue,
  scrollElement,
  expandElement,
  collapseElement,
  toggleExpandCollapse,
  getElementText,
} = require('./pattern-actions');

module.exports = {
  // Element clicks
  click,
  clickByText,
  clickByAutomationId,
  rightClick,
  doubleClick,
  clickElement,
  invokeElement,
  
  // High-level interactions
  fillField,
  selectDropdownItem,
  waitForWindow,
  clickSequence,
  hover,
  waitAndClick,
  clickAndWaitFor,
  selectFromDropdown,
  
  // Pattern-based interactions (Phase 3)
  normalizePatternName,
  hasPattern,
  setElementValue,
  scrollElement,
  expandElement,
  collapseElement,
  toggleExpandCollapse,
  getElementText,
};
