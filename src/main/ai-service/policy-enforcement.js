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

function hasSemanticAction(actions = []) {
  return actions.some((action) => ['click_element', 'find_element', 'get_text', 'set_value', 'scroll_element', 'expand_element', 'collapse_element'].includes(normalizeActionType(action)));
}

function hasWindowKeyboardAction(actions = []) {
  return actions.some((action) => ['key', 'type', 'focus_window', 'bring_window_to_front', 'restore_window', 'wait'].includes(normalizeActionType(action)));
}

function buildPlanHaystack(actionData, options = {}) {
  const actions = Array.isArray(actionData?.actions) ? actionData.actions : [];
  return [
    options.userMessage,
    actionData?.thought,
    actionData?.verification,
    ...actions.map((action) => [action.reason, action.text, action.targetLabel, action.targetText].filter(Boolean).join(' '))
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function checkCapabilityPolicies(actionData, capabilitySnapshot, options = {}) {
  const actions = actionData?.actions;
  if (!Array.isArray(actions) || actions.length === 0 || !capabilitySnapshot || typeof capabilitySnapshot !== 'object') {
    return { ok: true, violations: [] };
  }

  const violations = [];
  const surfaceClass = String(capabilitySnapshot.surfaceClass || capabilitySnapshot.surface?.mode || '').trim().toLowerCase();
  const haystack = buildPlanHaystack(actionData, options);
  const coordinateActions = actions
    .map((action, actionIndex) => ({ action, actionIndex }))
    .filter(({ action }) => isCoordinateInteractionAction(action));
  const semanticActionPresent = hasSemanticAction(actions);
  const windowKeyboardActionPresent = hasWindowKeyboardAction(actions);
  const precisePlacementIntent = /draw|drawing|trend\s*line|trendline|place|position|anchor|fib|fibonacci|rectangle|ellipse|polyline|path|chart object/.test(haystack);
  const semanticSupport = String(capabilitySnapshot.supports?.semanticControl || '').trim().toLowerCase();
  const precisePlacementSupport = String(capabilitySnapshot.supports?.precisePlacement || '').trim().toLowerCase();

  if (surfaceClass === 'visual-first-low-uia'
    && (capabilitySnapshot.enforcement?.avoidPrecisePlacementClaims || precisePlacementSupport === 'unsupported')
    && precisePlacementIntent) {
    for (const { action, actionIndex } of coordinateActions) {
      violations.push({
        action,
        actionIndex,
        reason: 'Capability-policy matrix forbids precise placement claims on visual-first-low-uia surfaces unless a deterministic verified workflow proves the anchors.'
      });
    }
  }

  if ((surfaceClass === 'uia-rich' || surfaceClass === 'browser')
    && (capabilitySnapshot.enforcement?.discourageCoordinateOnlyPlans || semanticSupport === 'supported')
    && coordinateActions.length > 0
    && !semanticActionPresent
    && !windowKeyboardActionPresent) {
    for (const { action, actionIndex } of coordinateActions) {
      violations.push({
        action,
        actionIndex,
        reason: surfaceClass === 'browser'
          ? 'Capability-policy matrix prefers deterministic browser-native or semantic UI actions over coordinate-only plans on browser surfaces.'
          : 'Capability-policy matrix prefers semantic UIA actions over coordinate-only plans on UIA-rich surfaces.'
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

function formatCapabilityPolicyViolationSystemMessage(capabilitySnapshot, violations) {
  const lines = [];
  lines.push('POLICY ENFORCEMENT: The previous action plan is REJECTED by the capability-policy matrix.');
  lines.push(`Surface class: ${capabilitySnapshot?.surfaceClass || capabilitySnapshot?.surface?.mode || 'unknown'}`);
  lines.push(`App: ${capabilitySnapshot?.appId || capabilitySnapshot?.foreground?.processName || 'unknown-app'}`);
  lines.push('Reason(s):');
  for (const violation of violations.slice(0, 6)) {
    const index = typeof violation.actionIndex === 'number' ? violation.actionIndex : -1;
    const actionType = violation.action?.type ? String(violation.action.type) : 'unknown';
    lines.push(`- Action[${index}] type=${actionType}: ${violation.reason}`);
  }
  lines.push('You MUST regenerate a compliant plan.');
  lines.push('Hard requirements:');
  lines.push('- Respect the active surface-class channel rules from the capability-policy matrix.');
  lines.push('- Prefer semantic/browser-native actions where the surface supports them.');
  lines.push('- Do not imply precise placement on low-UIA visual surfaces without deterministic verified evidence.');
  lines.push('- Respond ONLY with a JSON code block (```json ... ```): { thought, actions, verification }.');
  return lines.join('\n');
}

module.exports = {
  checkCapabilityPolicies,
  checkActionPolicies,
  checkNegativePolicies,
  formatActionPolicyViolationSystemMessage,
  formatCapabilityPolicyViolationSystemMessage,
  formatNegativePolicyViolationSystemMessage,
  isClickLikeActionType,
  isCoordinateInteractionAction
};
