const fs = require('fs');
const {
  buildConversationHistoryEntry,
  HISTORY_RETENTION_MS,
  isPersistenceEntryExpired
} = require('../persistence-controls');

function createConversationHistoryStore({ historyFile, likuHome, maxHistory }) {
  let conversationHistory = [];
  const historyMaxAgeMs = HISTORY_RETENTION_MS;

  function normalizeHistoryEntries(entries = []) {
    return (Array.isArray(entries) ? entries : [])
      .map((entry) => buildConversationHistoryEntry(entry, { maxAgeMs: historyMaxAgeMs }))
      .filter((entry) => !isPersistenceEntryExpired(entry))
      .slice(-maxHistory * 2);
  }

  function persistNormalizedHistory(entries) {
    if (!fs.existsSync(likuHome)) {
      fs.mkdirSync(likuHome, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(historyFile, JSON.stringify(entries), { mode: 0o600 });
  }

  function loadConversationHistory() {
    try {
      if (fs.existsSync(historyFile)) {
        const data = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
        if (Array.isArray(data)) {
          const normalizedEntries = normalizeHistoryEntries(data);
          conversationHistory = normalizedEntries;
          const requiresRewrite = normalizedEntries.length !== data.length
            || normalizedEntries.some((entry, index) => !data[index]?.persistence);
          if (requiresRewrite) {
            persistNormalizedHistory(normalizedEntries);
          }
          if (process.env.LIKU_CHAT_TRANSCRIPT_QUIET !== '1') {
            console.log(`[AI] Restored ${conversationHistory.length} history entries from disk`);
          }
        }
      }
    } catch (error) {
      console.warn('[AI] Could not load conversation history:', error.message);
    }
  }

  function saveConversationHistory() {
    try {
      conversationHistory = normalizeHistoryEntries(conversationHistory);
      persistNormalizedHistory(conversationHistory);
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
    conversationHistory.push(buildConversationHistoryEntry(entry, { maxAgeMs: historyMaxAgeMs }));
  }

  function popConversationEntry() {
    return conversationHistory.pop();
  }

  function trimConversationHistory() {
    conversationHistory = normalizeHistoryEntries(conversationHistory);
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
