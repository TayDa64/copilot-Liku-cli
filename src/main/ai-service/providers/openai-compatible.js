const https = require('https');

function selectModel(config, effectiveModel) {
  const candidate = String(effectiveModel || '').trim();
  if (candidate && candidate === config.model) {
    return candidate;
  }
  return config.model;
}

function normalizeErrorMessage(provider, statusCode, response) {
  const message = response?.error?.message || response?.message || `HTTP ${statusCode}`;
  return `${provider} API error: ${message}`;
}

function callOpenAICompatibleChatCompletion({
  provider,
  config,
  apiKey,
  messages,
  effectiveModel,
  requestOptions,
  request = https.request,
  now = () => Date.now()
}) {
  if (!apiKey) {
    throw new Error(`${provider} API key not set.`);
  }

  return new Promise((resolve, reject) => {
    const startedAt = now();
    const model = selectModel(config, effectiveModel);
    const data = JSON.stringify({
      model,
      messages,
      max_tokens: 2048,
      temperature: (requestOptions && requestOptions.temperature !== undefined) ? requestOptions.temperature : 0.7,
      ...(requestOptions && requestOptions.top_p !== undefined ? { top_p: requestOptions.top_p } : {})
    });

    const req = request({
      hostname: config.baseUrl,
      path: config.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        let response;
        try {
          response = body ? JSON.parse(body) : {};
        } catch (error) {
          reject(error);
          return;
        }

        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(normalizeErrorMessage(provider, res.statusCode, response)));
          return;
        }

        if (response.error) {
          reject(new Error(normalizeErrorMessage(provider, res.statusCode || 500, response)));
          return;
        }

        const choice = Array.isArray(response.choices) ? response.choices[0] : null;
        resolve({
          content: choice?.message?.content || '',
          effectiveModel: response.model || model,
          requestedModel: model,
          endpointHost: config.baseUrl,
          actualModelId: response.model || null,
          usage: response.usage || null,
          latencyMs: Math.max(0, now() - startedAt)
        });
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

module.exports = {
  callOpenAICompatibleChatCompletion
};
