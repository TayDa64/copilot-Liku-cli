function createTradingViewPineResumeHelpers(deps = {}) {
  const {
    buildTradingViewPineResumePrerequisites
  } = deps;

  if (typeof buildTradingViewPineResumePrerequisites !== 'function') {
    throw new Error('createTradingViewPineResumeHelpers requires buildTradingViewPineResumePrerequisites');
  }

  function buildPendingTradingViewPineConfirmationState({
    safety = {},
    actionData = {},
    actionIndex = -1,
    results = [],
    userMessage = '',
    lastTargetWindowHandle = null,
    lastTargetWindowProfile = null,
    executionContextEnvelope = null,
    selectionProvenance = null,
    approvalPauseCapture = null
  } = {}) {
    const actions = Array.isArray(actionData?.actions) ? actionData.actions : [];
    const resumePrerequisites = buildTradingViewPineResumePrerequisites(actions, actionIndex, {
      lastTargetWindowProfile
    });
    const managedByTradingViewPineResume = resumePrerequisites.length > 0;

    return {
      ...safety,
      actionIndex,
      remainingActions: actions.slice(actionIndex),
      completedResults: Array.isArray(results) ? [...results] : [],
      thought: actionData?.thought,
      verification: actionData?.verification,
      userMessage: userMessage || actionData?.userMessage || '',
      lastTargetWindowHandle,
      lastTargetWindowProfile,
      executionContextEnvelope: executionContextEnvelope || null,
      selectionProvenance,
      resumePrerequisites,
      managedByTradingViewPineResume,
      approvalPauseCapture: approvalPauseCapture || null
    };
  }

  function buildTradingViewPineResumeExecutionPlan(pending = {}) {
    const resumePrerequisites = Array.isArray(pending?.resumePrerequisites)
      ? pending.resumePrerequisites.filter((action) => action && typeof action === 'object')
      : [];
    const remainingActions = Array.isArray(pending?.remainingActions)
      ? pending.remainingActions.filter((action) => action && typeof action === 'object')
      : [];

    return {
      resumePrerequisites,
      remainingActions,
      actionsToResume: resumePrerequisites.concat(remainingActions)
    };
  }

  function isResumeActionUserConfirmed(resumePlan, actionIndex = 0) {
    const resumePrerequisites = Array.isArray(resumePlan?.resumePrerequisites)
      ? resumePlan.resumePrerequisites
      : [];
    return resumePrerequisites.length === 0 && actionIndex === 0;
  }

  function createTradingViewPineLifecycleHooks() {
    return {
      buildPendingConfirmationState: (payload = {}) => buildPendingTradingViewPineConfirmationState(payload),
      buildResumeExecutionPlan: ({ pending } = {}) => buildTradingViewPineResumeExecutionPlan(pending),
      isResumeActionUserConfirmed: ({ resumePlan, actionIndex } = {}) => isResumeActionUserConfirmed(resumePlan, actionIndex)
    };
  }

  return {
    buildPendingTradingViewPineConfirmationState,
    buildTradingViewPineResumeExecutionPlan,
    createTradingViewPineLifecycleHooks,
    isResumeActionUserConfirmed
  };
}

module.exports = {
  createTradingViewPineResumeHelpers
};
