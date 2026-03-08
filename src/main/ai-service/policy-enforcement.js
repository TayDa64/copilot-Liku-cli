function normalizeActionType(action) {
  const raw = String(action?.type || '').toLowerCase();
  if (raw === 'press_key' || raw === 'presskey') {
    return 'key';
  }
  if (raw === 'type_text' || raw === 'typetext') {
    return 'type';
  }
  return raw;
}

function isCoordinateInteractionAction(action) {
  if (!action || typeof action !== 'object') return false;
  const actionType = normalizeActionType(action);
  const coordinateTypes = new Set(['click', 'double_click', 'right_click', 'drag', 'move_mouse']);
  if (!coordinateTypes.has(actionType)) return false;
  const hasXY = Number.isFinite(Number(action.x)) && Number.isFinite(Number(action.y));
  const hasFromTo = Number.isFinite(Number(action.fromX)) && Number.isFinite(Number(action.fromY))
    && Number.isFinite(Number(action.toX)) && Number.isFinite(Number(action.toY));
  return hasXY || hasFromTo;
}

function checkNegativePolicies(actionData, negativePolicies = []) {
  const actions = actionData?.actions;
  if (!Array.isArray(actions) || !Array.isArray(negativePolicies) || negativePolicies.length === 0) {
    return { ok: true, violations: [] };
  }

  const violations = [];

  for (let index = 0; index < actions.length; index++) {
    const action = actions[index];
    const actionType = normalizeActionType(action);

    for (const policy of negativePolicies) {
      if (!policy || typeof policy !== 'object') continue;

      const intent = policy.intent ? String(policy.intent).trim().toLowerCase() : '';
      if (intent && intent !== actionType) {
        continue;
      }

      const forbiddenTypes = Array.isArray(policy.forbiddenActionTypes)
        ? policy.forbiddenActionTypes.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
        : [];
      if (forbiddenTypes.length && forbiddenTypes.includes(actionType)) {
        violations.push({
          policy,
          actionIndex: index,
          action,
          reason: policy.reason || `Action type "${actionType}" is forbidden by user policy`
        });
        continue;
      }

      const forbiddenMethod = policy.forbiddenMethod ? String(policy.forbiddenMethod).trim().toLowerCase() : '';
      if (!forbiddenMethod) continue;

      if (['click_coordinates', 'coordinate_click', 'coordinates', 'coord_click'].includes(forbiddenMethod)) {
        if (isCoordinateInteractionAction(action)) {
          violations.push({
            policy,
            actionIndex: index,
            action,
            reason: policy.reason || 'Coordinate-based interactions are forbidden by user policy'
          });
        }
      }

      if (['simulated_keystrokes', 'type_simulated_keystrokes'].includes(forbiddenMethod)) {
        if (actionType === 'type') {
          violations.push({
            policy,
            actionIndex: index,
            action,
            reason: policy.reason || 'Simulated typing is forbidden by user policy'
          });
        }
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

function isClickLikeActionType(actionType) {
  const normalized = String(actionType || '').toLowerCase();
  return ['click', 'double_click', 'right_click', 'click_element'].includes(normalized);
}

function checkActionPolicies(actionData, actionPolicies = []) {
  const actions = actionData?.actions;
  if (!Array.isArray(actions) || !Array.isArray(actionPolicies) || actionPolicies.length === 0) {
    return { ok: true, violations: [] };
  }

  const violations = [];

  for (let index = 0; index < actions.length; index++) {
    const action = actions[index];
    const actionType = normalizeActionType(action);

    for (const policy of actionPolicies) {
      if (!policy || typeof policy !== 'object') continue;
      const intent = String(policy.intent || '').trim().toLowerCase();
      if (!intent) continue;

      const applies =
        (intent === 'click_element' && isClickLikeActionType(actionType)) ||
        (intent === 'click' && isClickLikeActionType(actionType)) ||
        (intent === actionType);
      if (!applies) continue;

      const matchPreference = String(policy.matchPreference || '').trim().toLowerCase();
      const preferredMethod = String(policy.preferredMethod || '').trim().toLowerCase();

      if (intent === 'click_element' && isClickLikeActionType(actionType)) {
        if (actionType !== 'click_element') {
          violations.push({
            policy,
            actionIndex: index,
            action,
            reason: policy.reason || 'User prefers click_element for click intents in this app (no coordinate clicks or generic click types)'
          });
          continue;
        }

        if (matchPreference === 'exact_text' || matchPreference === 'exact') {
          const exact = action?.exact === true;
          const text = typeof action?.text === 'string' ? action.text.trim() : '';
          if (!text || !exact) {
            violations.push({
              policy,
              actionIndex: index,
              action,
              reason: policy.reason || 'User prefers exact_text matching for click_element in this app (set exact=true and provide text)'
            });
            continue;
          }
        }

        if (preferredMethod && preferredMethod !== 'click_element') {
          violations.push({
            policy,
            actionIndex: index,
            action,
            reason: policy.reason || `User prefers method=${preferredMethod} for click_element in this app`
          });
        }
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

function formatActionPolicyViolationSystemMessage(processName, violations) {
  const app = processName ? String(processName) : 'unknown-app';
  const lines = [];
  lines.push('POLICY ENFORCEMENT: The previous action plan is REJECTED.');
  lines.push(`Active app: ${app}`);
  lines.push('Reason(s):');
  for (const violation of violations.slice(0, 6)) {
    const index = typeof violation.actionIndex === 'number' ? violation.actionIndex : -1;
    const actionType = violation.action?.type ? String(violation.action.type) : 'unknown';
    lines.push(`- Action[${index}] type=${actionType}: ${violation.reason}`);
  }
  lines.push('You MUST regenerate a compliant plan.');
  lines.push('Hard requirements:');
  lines.push('- If the user prefers exact_text clicks: use click_element with exact=true and a concrete text label.');
  lines.push('- Do not replace click_element with coordinate clicks for this app.');
  lines.push('- Respond ONLY with a JSON code block (```json ... ```): { thought, actions, verification }.');
  return lines.join('\n');
}

function formatNegativePolicyViolationSystemMessage(processName, violations) {
  const app = processName ? String(processName) : 'unknown-app';
  const lines = [];
  lines.push('POLICY ENFORCEMENT: The previous action plan is REJECTED.');
  lines.push(`Active app: ${app}`);
  lines.push('Reason(s):');
  for (const violation of violations.slice(0, 6)) {
    const index = typeof violation.actionIndex === 'number' ? violation.actionIndex : -1;
    const actionType = violation.action?.type ? String(violation.action.type) : 'unknown';
    lines.push(`- Action[${index}] type=${actionType}: ${violation.reason}`);
  }
  lines.push('You MUST regenerate a compliant plan.');
  lines.push('Hard requirements:');
  lines.push('- Do not use forbidden methods for this app.');
  lines.push('- Prefer UIA/semantic actions (e.g., click_element) over coordinate clicks.');
  lines.push('- Respond ONLY with a JSON code block (```json ... ```): { thought, actions, verification }.');
  return lines.join('\n');
}

module.exports = {
  checkActionPolicies,
  checkNegativePolicies,
  formatActionPolicyViolationSystemMessage,
  formatNegativePolicyViolationSystemMessage,
  isClickLikeActionType,
  isCoordinateInteractionAction
};
