/**
 * Transport Fabric — interface + in-process / HTTPS-provider adapters (Phase 48).
 *
 * Decouples "run an Execution Fabric worker" from "call a JS function in this
 * process." A TransportManager hands out a bounded handle { kind, invoke, close }.
 * Two adapters exist because they already exist in practice:
 *   - inprocess:      today's runTask / agent handoff (an injected function).
 *   - https-provider: today's OpenAI-compatible request path (an injected function
 *                     that MUST be requestWithFallback — never a second HTTP client).
 *
 * Reserved kinds (http2 | http3 | quic | ipc) fail closed by default:
 * selecting one throws `unsupported-transport`. Phase 50 adds a lab-only
 * loopback stand-in for `quic` when LIKU_QUIC_WORKER_LAB=1. That is not a
 * production QUIC stack and never speaks to vendor APIs.
 *
 * NON-NEGOTIABLE: transport is not a privileged pipe. A handle's invoke() only
 * calls the injected function; it can NOT skip budget, routing, escalation,
 * confirm rails, or PAL, and it never reads an API key from caps to POST around
 * policy. Only Supervisor / ai-service / fabric may hold a manager. Flag-gated
 * (LIKU_TRANSPORT_FABRIC, default OFF); off → no manager is ever constructed.
 */

'use strict';

const IMPLEMENTED_KINDS = Object.freeze(['inprocess', 'https-provider']);
const RESERVED_KINDS = Object.freeze(['http2', 'http3', 'quic', 'ipc']);

function isEnabledFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function isTransportFabricEnabled(env = process.env) {
  return isEnabledFlag(env.LIKU_TRANSPORT_FABRIC);
}

function isQuicWorkerLabEnabled(env = process.env) {
  return isEnabledFlag(env.LIKU_QUIC_WORKER_LAB);
}

// The https-provider adapter only accepts inference-shaped work — it must never
// become a generic "POST anything" escape hatch around routing/budget.
function isInferenceShapedPayload(payload) {
  return !!payload
    && typeof payload === 'object'
    && Array.isArray(payload.messages)
    && (payload.provider !== undefined || payload.model !== undefined);
}

function unsupportedTransportError(kind) {
  const error = new Error('unsupported-transport');
  error.code = 'unsupported-transport';
  error.kind = kind;
  return error;
}

class TransportManager {
  constructor(options = {}) {
    this._env = options.env || process.env;
    this._invokeInProcess = typeof options.invokeInProcess === 'function' ? options.invokeInProcess : null;
    this._invokeHttpsProvider = typeof options.invokeHttpsProvider === 'function' ? options.invokeHttpsProvider : null;
    this._invokeQuicLab = typeof options.invokeQuicLab === 'function' ? options.invokeQuicLab : null;
  }

  isSupported(kind) {
    const requested = String(kind || '').trim().toLowerCase();
    if (IMPLEMENTED_KINDS.includes(requested)) return true;
    return requested === 'quic' && isQuicWorkerLabEnabled(this._env);
  }

  listKinds() {
    const kinds = IMPLEMENTED_KINDS.slice();
    if (isQuicWorkerLabEnabled(this._env)) kinds.push('quic');
    return kinds;
  }

  // caps is advisory only. It is NEVER read for credentials — the injected paths
  // own auth/routing/budget. Reserved/unknown kinds fail closed (no silent fall).
  select({ kind, caps } = {}) {
    const requested = kind == null || kind === '' ? 'inprocess' : String(kind).trim().toLowerCase();

    if (requested === 'quic') {
      if (!isQuicWorkerLabEnabled(this._env)) {
        throw unsupportedTransportError(requested);
      }
      // Lazy load so the lab module stays off the default Supervisor graph.
      const lab = require('./quic-lab');
      return lab.createQuicLabTransport({
        env: this._env,
        caps,
        invokeFrame: this._invokeQuicLab || undefined
      });
    }

    if (!IMPLEMENTED_KINDS.includes(requested)) {
      throw unsupportedTransportError(requested);
    }

    if (requested === 'inprocess') {
      return {
        kind: 'inprocess',
        invoke: async (payload) => {
          if (!this._invokeInProcess) throw new Error('inprocess transport is not wired');
          return this._invokeInProcess(payload);
        },
        close() {}
      };
    }

    return {
      kind: 'https-provider',
      invoke: async (payload) => {
        if (!isInferenceShapedPayload(payload)) {
          const error = new Error('https-provider transport requires an inference-shaped payload');
          error.code = 'invalid-transport-payload';
          throw error;
        }
        if (!this._invokeHttpsProvider) throw new Error('https-provider transport is not wired');
        return this._invokeHttpsProvider(payload);
      },
      close() {}
    };
  }
}

function createTransportManager(options = {}) {
  return new TransportManager(options);
}

module.exports = {
  IMPLEMENTED_KINDS,
  RESERVED_KINDS,
  isTransportFabricEnabled,
  isQuicWorkerLabEnabled,
  isInferenceShapedPayload,
  TransportManager,
  createTransportManager
};
