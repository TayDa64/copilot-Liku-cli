function getEnvGitHubToken(env = process.env) {
  const candidates = [
    ['GH_TOKEN', env.GH_TOKEN],
    ['GITHUB_TOKEN', env.GITHUB_TOKEN],
  ];

  for (const [source, value] of candidates) {
    const token = String(value || '').trim();
    if (token) {
      return { token, source };
    }
  }

  return { token: '', source: null };
}

function maskToken(token) {
  const value = String(token || '').trim();
  if (!value) return null;
  if (value.length <= 8) {
    return `${value.slice(0, 2)}…${value.slice(-2)}`;
  }
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function readHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    return headers.get(name);
  }
  const direct = headers[name] || headers[String(name || '').toLowerCase()];
  if (Array.isArray(direct)) {
    return direct.join(', ');
  }
  return direct || null;
}

function splitCommaHeader(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  return text.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function parseRateLimit(headers) {
  const limit = Number(readHeader(headers, 'x-ratelimit-limit'));
  const remaining = Number(readHeader(headers, 'x-ratelimit-remaining'));
  const reset = Number(readHeader(headers, 'x-ratelimit-reset'));
  const used = Number(readHeader(headers, 'x-ratelimit-used'));
  const resource = readHeader(headers, 'x-ratelimit-resource');

  if (![limit, remaining, reset, used].some((value) => Number.isFinite(value)) && !resource) {
    return null;
  }

  return {
    limit: Number.isFinite(limit) ? limit : null,
    remaining: Number.isFinite(remaining) ? remaining : null,
    resetAt: Number.isFinite(reset) ? new Date(reset * 1000).toISOString() : null,
    used: Number.isFinite(used) ? used : null,
    resource: resource || null,
  };
}

function buildGitHubApiUrl(apiPath, apiBaseUrl = 'https://api.github.com') {
  const input = String(apiPath || '').trim();
  if (!input) {
    return String(apiBaseUrl || 'https://api.github.com');
  }
  if (/^https?:\/\//i.test(input)) {
    return input;
  }
  return new URL(input.startsWith('/') ? input : `/${input}`, apiBaseUrl).toString();
}

async function requestGitHubJson(options = {}) {
  const {
    apiPath = '/',
    apiBaseUrl = 'https://api.github.com',
    token = '',
    method = 'GET',
    headers = {},
    fetchImpl = global.fetch,
    timeoutMs = 8000,
  } = options;

  if (typeof fetchImpl !== 'function') {
    throw new Error('GitHub API fetch is unavailable in this runtime.');
  }

  const requestUrl = buildGitHubApiUrl(apiPath, apiBaseUrl);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutHandle = controller
    ? setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 8000))
    : null;

  try {
    const response = await fetchImpl(requestUrl, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'copilot-liku-cli',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      signal: controller ? controller.signal : undefined,
    });

    const responseText = await response.text();
    let data = null;
    if (responseText) {
      try {
        data = JSON.parse(responseText);
      } catch {
        data = { raw: responseText };
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      data,
      error: null,
      requestUrl: response.url || requestUrl,
      scopes: splitCommaHeader(readHeader(response.headers, 'x-oauth-scopes')),
      rateLimit: parseRateLimit(response.headers),
      headers: {
        requestId: readHeader(response.headers, 'x-github-request-id'),
      },
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: error?.message || String(error),
      requestUrl,
      scopes: [],
      rateLimit: null,
      headers: {
        requestId: null,
      },
    };
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

module.exports = {
  buildGitHubApiUrl,
  getEnvGitHubToken,
  maskToken,
  parseRateLimit,
  requestGitHubJson,
};
