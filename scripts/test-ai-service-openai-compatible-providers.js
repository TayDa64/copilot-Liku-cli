#!/usr/bin/env node

const assert = require('assert');
const { EventEmitter } = require('events');
const path = require('path');

const {
  callOpenAICompatibleChatCompletion
} = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'providers', 'openai-compatible.js'));

function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`PASS ${name}`);
    })
    .catch((error) => {
      console.error(`FAIL ${name}`);
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
}

function createMockRequest({ statusCode = 200, body }) {
  const calls = [];
  const request = (options, callback) => {
    const req = new EventEmitter();
    req.body = '';
    req.write = (chunk) => {
      req.body += chunk;
    };
    req.end = () => {
      calls.push({ options, body: req.body });
      const res = new EventEmitter();
      res.statusCode = statusCode;
      callback(res);
      res.emit('data', JSON.stringify(body));
      res.emit('end');
    };
    return req;
  };
  return { request, calls };
}

test('Cerebras client posts OpenAI-compatible chat completion and normalizes metadata', async () => {
  const mock = createMockRequest({
    body: {
      model: 'gpt-oss-120b',
      choices: [{ message: { content: 'hello from cerebras' } }],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
    }
  });
  let tick = 1000;
  const result = await callOpenAICompatibleChatCompletion({
    provider: 'Cerebras',
    config: { baseUrl: 'api.cerebras.ai', path: '/v1/chat/completions', model: 'gpt-oss-120b' },
    apiKey: 'cerebras-key',
    messages: [{ role: 'user', content: 'hi' }],
    effectiveModel: 'gpt-4o',
    requestOptions: { temperature: 0.2, top_p: 0.9 },
    request: mock.request,
    now: () => {
      tick += 25;
      return tick;
    }
  });

  assert.strictEqual(mock.calls.length, 1);
  assert.strictEqual(mock.calls[0].options.hostname, 'api.cerebras.ai');
  assert.strictEqual(mock.calls[0].options.path, '/v1/chat/completions');
  assert.strictEqual(mock.calls[0].options.headers.Authorization, 'Bearer cerebras-key');
  const payload = JSON.parse(mock.calls[0].body);
  assert.strictEqual(payload.model, 'gpt-oss-120b');
  assert.strictEqual(payload.temperature, 0.2);
  assert.strictEqual(payload.top_p, 0.9);
  assert.strictEqual(result.content, 'hello from cerebras');
  assert.strictEqual(result.effectiveModel, 'gpt-oss-120b');
  assert.strictEqual(result.endpointHost, 'api.cerebras.ai');
  assert.deepStrictEqual(result.usage, { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 });
  assert.strictEqual(result.latencyMs, 25);
});

test('xAI client uses official OpenAI-compatible base URL and fails closed on auth errors', async () => {
  const mock = createMockRequest({
    statusCode: 401,
    body: { error: { message: 'invalid api key' } }
  });

  await assert.rejects(
    () => callOpenAICompatibleChatCompletion({
      provider: 'xAI',
      config: { baseUrl: 'api.x.ai', path: '/v1/chat/completions', model: 'grok-4.6' },
      apiKey: 'xai-key',
      messages: [{ role: 'user', content: 'hi' }],
      request: mock.request
    }),
    /xAI API error: invalid api key/
  );
  assert.strictEqual(mock.calls[0].options.hostname, 'api.x.ai');
  assert.strictEqual(mock.calls[0].options.path, '/v1/chat/completions');
});

test('OpenAI-compatible client rejects missing API keys before transport dispatch', async () => {
  const mock = createMockRequest({ body: {} });
  assert.throws(
    () => callOpenAICompatibleChatCompletion({
      provider: 'Cerebras',
      config: { baseUrl: 'api.cerebras.ai', path: '/v1/chat/completions', model: 'gpt-oss-120b' },
      apiKey: '',
      messages: [{ role: 'user', content: 'hi' }],
      request: mock.request
    }),
    /Cerebras API key not set/
  );
  assert.strictEqual(mock.calls.length, 0);
});
