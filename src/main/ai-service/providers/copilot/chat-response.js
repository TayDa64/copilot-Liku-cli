function mergeToolCallChunk(toolCallMap, chunk) {
  if (!chunk) return;

  const index = Number.isInteger(chunk.index) ? chunk.index : toolCallMap.size;
  const existing = toolCallMap.get(index) || {
    id: chunk.id || `tool-${index}`,
    type: chunk.type || 'function',
    function: {
      name: '',
      arguments: ''
    }
  };

  if (chunk.id) existing.id = chunk.id;
  if (chunk.type) existing.type = chunk.type;
  if (chunk.function?.name) {
    existing.function.name = chunk.function.name;
  }
  if (typeof chunk.function?.arguments === 'string') {
    existing.function.arguments += chunk.function.arguments;
  }

  toolCallMap.set(index, existing);
}

function parseStreamingPayload(body) {
  const contentParts = [];
  const toolCallMap = new Map();
  const events = String(body || '').split(/\r?\n\r?\n/);

  for (const eventBlock of events) {
    if (!eventBlock.trim()) continue;

    const dataLines = eventBlock
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());

    if (!dataLines.length) continue;

    const payloadText = dataLines.join('\n');
    if (!payloadText || payloadText === '[DONE]') continue;

    const payload = JSON.parse(payloadText);
    if (payload?.error) {
      throw new Error(payload.error.message || 'Copilot API error');
    }

    const choices = Array.isArray(payload?.choices) ? payload.choices : [];
    for (const choice of choices) {
      const delta = choice?.delta || choice?.message || {};
      if (typeof delta.content === 'string') {
        contentParts.push(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        delta.tool_calls.forEach((toolCall) => mergeToolCallChunk(toolCallMap, toolCall));
      }
      if (Array.isArray(choice?.message?.tool_calls)) {
        choice.message.tool_calls.forEach((toolCall) => mergeToolCallChunk(toolCallMap, toolCall));
      }
    }
  }

  return {
    content: contentParts.join(''),
    toolCalls: Array.from(toolCallMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, value]) => value)
  };
}

function parseJsonPayload(body) {
  const payload = JSON.parse(body || '{}');
  if (payload?.error) {
    throw new Error(payload.error.message || 'Copilot API error');
  }

  const choice = payload?.choices?.[0];
  if (!choice) {
    throw new Error('Invalid response format');
  }

  const message = choice.message || {};
  return {
    content: typeof message.content === 'string' ? message.content : '',
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : []
  };
}

function parseCopilotChatResponse(body, headers = {}) {
  const contentType = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
  const text = String(body || '');
  const isStreaming = contentType.includes('text/event-stream') || /(^|\n)data:\s*/.test(text);

  return isStreaming ? parseStreamingPayload(text) : parseJsonPayload(text);
}

module.exports = {
  parseCopilotChatResponse
};