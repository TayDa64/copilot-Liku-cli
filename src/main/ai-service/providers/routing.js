// Phase 42: flag-gated role-based inference routing policy.
// Data-driven table maps agent roles to a preferred provider/model. Vendors are
// never hardcoded inside the agents; agents pass only their role. The policy is
// inert unless LIKU_INFERENCE_FABRIC is enabled AND the target provider is
// visible (Phase 41 key/flag rules). Explicit user /provider selection always wins.

// role -> { provider, model }. A null provider means "use the current provider".
// A null model means "use the target provider's default model".
const DEFAULT_ROUTING_TABLE = {
  supervisor: { provider: 'xai', model: null },
  architect: { provider: 'xai', model: null },
  researcher: { provider: 'cerebras', model: null },
  builder: { provider: 'cerebras', model: null },
  verifier: { provider: 'cerebras', model: null },
  diagnostician: { provider: 'cerebras', model: null },
  producer: { provider: null, model: null },
  vision: { provider: null, model: null }
};

function isEnabledFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function createRoutingPolicy(dependencies = {}) {
  const {
    env = process.env,
    getCurrentProvider,
    getCurrentModel,
    isProviderEnabled,
    isProviderExplicit = () => false,
    getProviderDefaultModel,
    providerModelCatalog = {},
    fabricFlagEnv = 'LIKU_INFERENCE_FABRIC'
  } = dependencies;

  // roleKey -> { provider, model } session overrides set via /route.
  const routeOverrides = {};

  function isFabricEnabled() {
    return isEnabledFlag(env[fabricFlagEnv]);
  }

  function normalizeRoleKey(role) {
    return String(role || '').trim().toLowerCase();
  }

  function resolveRoleKey(role, routingContext) {
    const candidate = normalizeRoleKey(role);
    if (candidate) return candidate;
    if (routingContext && routingContext.includeVisualContext) return 'vision';
    return '';
  }

  function catalogEntries(provider) {
    const entries = providerModelCatalog[provider];
    return Array.isArray(entries) ? entries : [];
  }

  function catalogHasModel(provider, modelId) {
    return catalogEntries(provider).some((entry) => entry.id === modelId);
  }

  function resolveModelForProvider(provider, requestedModel) {
    if (requestedModel && catalogHasModel(provider, requestedModel)) {
      return requestedModel;
    }
    return getProviderDefaultModel(provider);
  }

  function currentDecision(reason, policyApplied) {
    return {
      provider: getCurrentProvider(),
      model: getCurrentModel(),
      reason,
      policyApplied
    };
  }

  function resolveRoute({ role, routingContext, explicitProvider, explicitModel } = {}) {
    // 1. Fabric flag off — current provider/model, no policy.
    if (!isFabricEnabled()) {
      return currentDecision('fabric-disabled', false);
    }

    // 2. Explicit provider (per-call or a session /provider selection) is sacred.
    const sessionExplicit = isProviderExplicit();
    const chosenExplicit = explicitProvider || (sessionExplicit ? getCurrentProvider() : null);
    if (chosenExplicit) {
      if (isProviderEnabled(chosenExplicit)) {
        return {
          provider: chosenExplicit,
          model: resolveModelForProvider(chosenExplicit, explicitModel),
          reason: 'explicit-provider',
          policyApplied: true
        };
      }
      return currentDecision('provider-unavailable', true);
    }

    // 4/5. Session override, then default table.
    const roleKey = resolveRoleKey(role, routingContext);
    const selected = routeOverrides[roleKey] || DEFAULT_ROUTING_TABLE[roleKey] || null;

    // producer / vision / unknown roles stay on the current provider.
    if (!selected || !selected.provider) {
      return currentDecision('current-provider', false);
    }

    const targetProvider = selected.provider;
    // 6. Selected provider not enabled — fall back to current, never throw.
    if (!isProviderEnabled(targetProvider)) {
      return currentDecision('provider-unavailable', true);
    }

    return {
      provider: targetProvider,
      model: resolveModelForProvider(targetProvider, selected.model),
      reason: routeOverrides[roleKey] ? 'route-override' : 'default-table',
      policyApplied: true
    };
  }

  function setRouteOverride(role, provider, model) {
    const roleKey = normalizeRoleKey(role);
    if (!roleKey || !Object.prototype.hasOwnProperty.call(DEFAULT_ROUTING_TABLE, roleKey)) {
      return { ok: false, error: `Unknown role: ${role}` };
    }
    if (!isProviderEnabled(provider)) {
      return { ok: false, error: `Provider not enabled: ${provider}` };
    }
    if (model) {
      const entries = catalogEntries(provider);
      if (entries.length && !entries.some((entry) => entry.id === model)) {
        return { ok: false, error: `Unknown model '${model}' for provider ${provider}` };
      }
    }
    routeOverrides[roleKey] = { provider, model: model || null };
    return {
      ok: true,
      role: roleKey,
      provider,
      model: resolveModelForProvider(provider, model)
    };
  }

  function clearRouteOverride(role) {
    const roleKey = normalizeRoleKey(role);
    if (Object.prototype.hasOwnProperty.call(routeOverrides, roleKey)) {
      delete routeOverrides[roleKey];
      return true;
    }
    return false;
  }

  function resetRouteOverrides() {
    for (const key of Object.keys(routeOverrides)) {
      delete routeOverrides[key];
    }
  }

  function getRouteOverrides() {
    return { ...routeOverrides };
  }

  function getDefaultTable() {
    return JSON.parse(JSON.stringify(DEFAULT_ROUTING_TABLE));
  }

  return {
    resolveRoute,
    setRouteOverride,
    clearRouteOverride,
    resetRouteOverrides,
    getRouteOverrides,
    getDefaultTable,
    isFabricEnabled
  };
}

module.exports = {
  DEFAULT_ROUTING_TABLE,
  createRoutingPolicy
};
