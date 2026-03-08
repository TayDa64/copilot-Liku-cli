const systemAutomation = require('../../system-automation');

function parseActions(aiResponse) {
  return systemAutomation.parseAIActions(aiResponse);
}

function hasActions(aiResponse) {
  const parsed = parseActions(aiResponse);
  return parsed && parsed.actions && parsed.actions.length > 0;
}

module.exports = {
  parseActions,
  hasActions
};
