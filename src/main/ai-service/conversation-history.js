const fs = require('fs');

function createConversationHistoryStore({ historyFile, likuHome, maxHistory }) {
  let conversationHistory = [];

  function loadConversationHistory() {
    try {
      if (fs.existsSync(historyFile)) {
        const data = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
        if (Array.isArray(data)) {
          conversationHistory = data.slice(-maxHistory * 2);
          console.log(`[AI] Restored ${conversationHistory.length} history entries from disk`);
        }
      }
    } catch (error) {
      console.warn('[AI] Could not load conversation history:', error.message);
    }
  }

  function saveConversationHistory() {
    try {
      if (!fs.existsSync(likuHome)) {
        fs.mkdirSync(likuHome, { recursive: true, mode: 0o700 });
      }
      fs.writeFileSync(historyFile, JSON.stringify(conversationHistory.slice(-maxHistory * 2)), { mode: 0o600 });
    } catch (error) {
      console.warn('[AI] Could not save conversation history:', error.message);
    }
  }

  function getConversationHistory() {
    return conversationHistory;
  }

  function getRecentConversationHistory(limit = maxHistory) {
    return conversationHistory.slice(-limit);
  }

  function pushConversationEntry(entry) {
    conversationHistory.push(entry);
  }

  function popConversationEntry() {
    return conversationHistory.pop();
  }

  function trimConversationHistory() {
    while (conversationHistory.length > maxHistory * 2) {
      conversationHistory.shift();
    }
  }

  function clearConversationHistory() {
    conversationHistory = [];
  }

  function getHistoryLength() {
    return conversationHistory.length;
  }

  return {
    clearConversationHistory,
    getConversationHistory,
    getHistoryLength,
    getRecentConversationHistory,
    loadConversationHistory,
    popConversationEntry,
    pushConversationEntry,
    saveConversationHistory,
    trimConversationHistory
  };
}

module.exports = {
  createConversationHistoryStore
};
