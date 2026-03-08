function extractJsonObjectFromText(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const source = text.trim();
  const fence = source.match(/```json\s*([\s\S]*?)\s*```/i);
  const candidate = fence ? fence[1] : source;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = candidate.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

function sanitizePreferencePatch(patch) {
  const safe = {};
  if (!patch || typeof patch !== 'object') return safe;

  const source = patch && patch.newRules !== undefined ? patch.newRules : patch;

  if (Array.isArray(source)) {
    const negativePolicies = [];
    const actionPolicies = [];

    for (const rule of source) {
      if (!rule || typeof rule !== 'object') continue;
      const type = String(rule.type || '').trim().toLowerCase();

      if (type === 'negative') {
        const out = {};
        if (rule.intent) out.intent = String(rule.intent);
        if (rule.forbiddenActionType) out.forbiddenActionTypes = [String(rule.forbiddenActionType)];
        if (Array.isArray(rule.forbiddenActionTypes)) out.forbiddenActionTypes = rule.forbiddenActionTypes.map((value) => String(value));
        if (rule.forbiddenMethod) out.forbiddenMethod = String(rule.forbiddenMethod);
        if (rule.reason) out.reason = String(rule.reason);
        if (Object.keys(out).length) negativePolicies.push(out);
      }

      if (type === 'action') {
        const out = {};
        if (rule.intent) out.intent = String(rule.intent);
        if (rule.preferredMethod) out.preferredMethod = String(rule.preferredMethod);
        if (rule.matchPreference) out.matchPreference = String(rule.matchPreference);
        if (rule.reason) out.reason = String(rule.reason);
        if (Object.keys(out).length) actionPolicies.push(out);
      }
    }

    if (negativePolicies.length) safe.negativePolicies = negativePolicies;
    if (actionPolicies.length) safe.actionPolicies = actionPolicies;
    return safe;
  }

  const unwrapped = source && typeof source === 'object' ? source : patch;

  if (Array.isArray(unwrapped.negativePolicies)) {
    safe.negativePolicies = unwrapped.negativePolicies
      .filter((policy) => policy && typeof policy === 'object')
      .map((policy) => {
        const out = {};
        if (policy.intent) out.intent = String(policy.intent);
        if (policy.forbiddenActionType) out.forbiddenActionTypes = [String(policy.forbiddenActionType)];
        if (Array.isArray(policy.forbiddenActionTypes)) out.forbiddenActionTypes = policy.forbiddenActionTypes.map((value) => String(value));
        if (policy.forbiddenMethod) out.forbiddenMethod = String(policy.forbiddenMethod);
        if (policy.reason) out.reason = String(policy.reason);
        return out;
      })
      .filter((policy) => Object.keys(policy).length > 0);
  }

  if (Array.isArray(unwrapped.actionPolicies)) {
    safe.actionPolicies = unwrapped.actionPolicies
      .filter((policy) => policy && typeof policy === 'object')
      .map((policy) => {
        const out = {};
        if (policy.intent) out.intent = String(policy.intent);
        if (Array.isArray(policy.preferredActionTypes)) out.preferredActionTypes = policy.preferredActionTypes.map((value) => String(value));
        if (policy.preferredMethod) out.preferredMethod = String(policy.preferredMethod);
        if (policy.matchPreference) out.matchPreference = String(policy.matchPreference);
        if (policy.reason) out.reason = String(policy.reason);
        return out;
      })
      .filter((policy) => Object.keys(policy).length > 0);
  }

  return safe;
}

function validatePreferenceParserPayload(payload) {
  if (!payload || typeof payload !== 'object') return 'Output must be an object';
  const rules = payload.newRules;
  if (!Array.isArray(rules) || rules.length === 0) return 'newRules must be a non-empty array';

  let sawAny = false;
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') return 'newRules entries must be objects';
    const type = String(rule.type || '').trim().toLowerCase();
    if (type !== 'negative' && type !== 'action') return 'newRules.type must be "negative" or "action"';
    sawAny = true;

    if (type === 'negative') {
      const hasForbiddenMethod = typeof rule.forbiddenMethod === 'string' && rule.forbiddenMethod.trim();
      const hasForbiddenActionType = typeof rule.forbiddenActionType === 'string' && rule.forbiddenActionType.trim();
      const hasForbiddenActionTypes = Array.isArray(rule.forbiddenActionTypes) && rule.forbiddenActionTypes.length > 0;
      if (!hasForbiddenMethod && !hasForbiddenActionType && !hasForbiddenActionTypes) {
        return 'negative rules must include forbiddenMethod or forbiddenActionType(s)';
      }
    }

    if (type === 'action') {
      const hasIntent = typeof rule.intent === 'string' && rule.intent.trim();
      if (!hasIntent) return 'action rules must include intent';
      const hasPreferredMethod = typeof rule.preferredMethod === 'string' && rule.preferredMethod.trim();
      const hasMatchPreference = typeof rule.matchPreference === 'string' && rule.matchPreference.trim();
      if (!hasPreferredMethod || !hasMatchPreference) {
        return 'action rules must include preferredMethod and matchPreference';
      }
    }
  }

  if (!sawAny) return 'Must include at least one rule';
  return null;
}

function createPreferenceParser(dependencies) {
  const {
    callAnthropic,
    callCopilot,
    callOllama,
    callOpenAI,
    getCurrentProvider,
    loadCopilotToken,
    apiKeys
  } = dependencies;

  async function parsePreferenceCorrection(naturalLanguage, context = {}) {
    const correction = String(naturalLanguage || '').trim();
    if (!correction) return { success: false, error: 'Missing correction text' };

    const processName = context.processName ? String(context.processName) : '';
    const title = context.title ? String(context.title) : '';

    const parserSystem = [
      'You are Preference Parser for a UI automation agent.',
      'Convert the user\'s natural-language correction into a JSON patch for the app-specific preferences store.',
      '',
      'Return STRICT JSON only (no markdown, no commentary).',
      'You MUST return an object with a top-level key "newRules" that is an ARRAY of rule objects.',
      'Each rule MUST include: type = "negative" OR "action".',
      '',
      'For type="negative" rules:',
      '- forbiddenMethod: string (e.g., click_coordinates, simulated_keystrokes)',
      '- forbiddenActionType: string (single) OR forbiddenActionTypes: string[] (e.g., ["click","drag","type"])',
      '- intent: optional string to scope by action type',
      '- reason: string',
      '',
      'For type="action" rules:',
      '- intent: REQUIRED string (e.g., "click_element", "type")',
      '- preferredMethod: REQUIRED string (e.g., "click_element")',
      '- matchPreference: REQUIRED string (e.g., "exact_text")',
      '- reason: string',
      '',
      'If the correction is about forbidding coordinate clicks, emit a type="negative" rule with forbiddenMethod="click_coordinates".',
      'If the correction is about avoiding simulated typing, emit a type="negative" rule with forbiddenMethod="simulated_keystrokes" and/or forbiddenActionTypes including "type".',
      'If the correction is about exact element matching for clicks, emit a type="action" rule with intent="click_element", preferredMethod="click_element", matchPreference="exact_text".'
    ].join('\n');

    const user = [
      `app.processName=${processName || 'unknown'}`,
      title ? `app.title=${title}` : null,
      `correction=${correction}`
    ].filter(Boolean).join('\n');

    const messages = [
      { role: 'system', content: parserSystem },
      { role: 'user', content: user }
    ];

    const structuredResponseFormat = {
      type: 'json_schema',
      json_schema: {
        name: 'preference_parser_patch',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['newRules'],
          properties: {
            newRules: {
              type: 'array',
              minItems: 1,
              items: {
                oneOf: [
                  {
                    type: 'object',
                    additionalProperties: false,
                    required: ['type'],
                    properties: {
                      type: { const: 'negative' },
                      intent: { type: 'string' },
                      forbiddenMethod: { type: 'string' },
                      forbiddenActionType: { type: 'string' },
                      forbiddenActionTypes: { type: 'array', items: { type: 'string' }, minItems: 1 },
                      reason: { type: 'string' }
                    },
                    anyOf: [
                      { required: ['forbiddenMethod'] },
                      { required: ['forbiddenActionType'] },
                      { required: ['forbiddenActionTypes'] }
                    ]
                  },
                  {
                    type: 'object',
                    additionalProperties: false,
                    required: ['type', 'intent', 'preferredMethod', 'matchPreference'],
                    properties: {
                      type: { const: 'action' },
                      intent: { type: 'string' },
                      preferredMethod: { type: 'string' },
                      matchPreference: { type: 'string' },
                      reason: { type: 'string' }
                    }
                  }
                ]
              }
            }
          }
        }
      }
    };

    let raw;
    let parsed = null;
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        switch (getCurrentProvider()) {
          case 'copilot':
            if (!apiKeys.copilot) {
              if (!loadCopilotToken()) throw new Error('Not authenticated with GitHub Copilot.');
            }
            raw = await callCopilot(messages, 'gpt-4o-mini', {
              enableTools: false,
              response_format: structuredResponseFormat,
              temperature: 0.2,
              max_tokens: 1200
            });
            break;
          case 'openai':
            if (!apiKeys.openai) throw new Error('OpenAI API key not set.');
            raw = await callOpenAI(messages);
            break;
          case 'anthropic':
            if (!apiKeys.anthropic) throw new Error('Anthropic API key not set.');
            raw = await callAnthropic(messages);
            break;
          case 'ollama':
          default:
            raw = await callOllama(messages);
            break;
        }
      } catch (error) {
        lastError = error.message;
        if (getCurrentProvider() === 'copilot' && attempt === 1 && /API_ERROR_400|Invalid|unknown|response_format/i.test(lastError || '')) {
          try {
            raw = await callCopilot(messages, 'gpt-4o-mini', { enableTools: false, temperature: 0.2, max_tokens: 1200 });
          } catch (retryError) {
            lastError = retryError.message;
            continue;
          }
        } else {
          continue;
        }
      }

      parsed = extractJsonObjectFromText(raw);
      if (!parsed) {
        lastError = 'Preference Parser returned non-JSON output';
        messages[0] = { role: 'system', content: `${parserSystem}\n\nYour last output was invalid: ${lastError}. Return valid JSON ONLY.` };
        continue;
      }

      const schemaError = validatePreferenceParserPayload(parsed);
      if (schemaError) {
        lastError = schemaError;
        messages[0] = { role: 'system', content: `${parserSystem}\n\nYour last output failed validation: ${schemaError}. Return valid JSON ONLY.` };
        continue;
      }

      break;
    }

    if (!parsed) {
      return { success: false, error: lastError || 'Preference Parser failed', raw: raw || null };
    }

    const patch = sanitizePreferencePatch(parsed);
    const hasNegative = Array.isArray(patch.negativePolicies) && patch.negativePolicies.length > 0;
    const hasAction = Array.isArray(patch.actionPolicies) && patch.actionPolicies.length > 0;
    if (!hasNegative && !hasAction) {
      return { success: false, error: 'Preference Parser produced no usable policies', raw, parsed };
    }

    return { success: true, patch, raw, parsed };
  }

  return {
    extractJsonObjectFromText,
    parsePreferenceCorrection,
    sanitizePreferencePatch,
    validatePreferenceParserPayload
  };
}

module.exports = {
  createPreferenceParser,
  extractJsonObjectFromText,
  sanitizePreferencePatch,
  validatePreferenceParserPayload
};
