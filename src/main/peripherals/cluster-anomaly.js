/**
 * Cluster Anomaly Aggregation (Pillar 3, Phase 26). BEST-EFFORT + COMPACT.
 *
 * Each node publishes a SMALL summary of its most recent anomalies + current
 * top power contributors to the shared cluster store (reusing coordination's
 * generic shared-record layer under LIKU_CLUSTER_DIR/anomaly-summary/). Any node
 * can then aggregate a FLEET-WIDE picture — recent anomalies across all nodes and
 * per-device draw — so multi-device attribution and coordinated proposals reason
 * about the whole fleet, not just local history.
 *
 * DISCIPLINE:
 *   - PURE observation. It NEVER actuates and never changes a decision on its own;
 *     it only widens the INPUT that human-gated proposals consider.
 *   - COMPACT: only the last N anomalies + top-K devices are published (NO full
 *     history replication). Stale summaries are ignored by max-age / GC.
 *   - FEATURE-FLAG GATED (LIKU_ENABLE_PERIPHERALS=1) + CLUSTER-GATED
 *     (LIKU_CLUSTER_DIR). Single-machine → every call is an inert no-op.
 *
 * Config:
 *   LIKU_PERIPHERAL_CLUSTER_ANOMALY_MAX     default 10  (anomalies per node summary)
 *   LIKU_PERIPHERAL_CLUSTER_ANOMALY_TTL_MS  default 900000 (15 min freshness)
 */

'use strict';

const FLAG = 'LIKU_ENABLE_PERIPHERALS';
const KIND = 'anomaly-summary';

function enabled() {
  return String(process.env[FLAG] || '').trim() === '1';
}

function _coord() { return require('./coordination'); }

function _maxAnomalies() {
  const v = Number(process.env.LIKU_PERIPHERAL_CLUSTER_ANOMALY_MAX);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 10;
}
function _ttlMs() {
  const v = Number(process.env.LIKU_PERIPHERAL_CLUSTER_ANOMALY_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : 900000; // 15 min
}

/**
 * Publish THIS node's compact anomaly summary to the shared cluster store.
 * @param {{ anomalies?:object[], devices?:object[], totalW?:number, budgetW?:number }} summary
 * @returns {boolean}
 */
function publish(summary = {}) {
  if (!enabled()) return false;
  const coord = _coord();
  if (!coord.clusterEnabled()) return false;
  const anomalies = Array.isArray(summary.anomalies) ? summary.anomalies : [];
  const devices = Array.isArray(summary.devices) ? summary.devices : [];
  const compact = {
    anomalies: anomalies.slice(-_maxAnomalies()).map((a) => ({
      device: a.attributedDevice || a.device || null,
      type: a.type || null,
      valueW: a.valueW != null ? a.valueW : null,
      at: a.at || null
    })),
    topDevices: devices
      .slice()
      .sort((x, y) => (Number(y.loadW) || 0) - (Number(x.loadW) || 0))
      .slice(0, 3)
      .map((d) => ({ id: d.id, loadW: Number(d.loadW) || 0 })),
    totalW: Number(summary.totalW) || 0,
    budgetW: summary.budgetW != null ? Number(summary.budgetW) : null
  };
  try { return coord.putShared(KIND, coord.nodeId(), compact); }
  catch { return false; }
}

/**
 * Aggregate a FLEET-WIDE view from all nodes' fresh summaries.
 * @param {{ now?:number, maxAgeMs?:number }} [opts]
 * @returns {{ nodes:number, anomalies:object[], perDeviceW:object, topDevices:object[], totalW:number }}
 */
function aggregate(opts = {}) {
  if (!enabled()) return { nodes: 0, anomalies: [], perDeviceW: {}, topDevices: [], totalW: 0 };
  const coord = _coord();
  if (!coord.clusterEnabled()) return { nodes: 0, anomalies: [], perDeviceW: {}, topDevices: [], totalW: 0 };
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : _ttlMs();
  const summaries = coord.listShared(KIND, { now, maxAgeMs });
  const anomalies = [];
  const perDeviceW = {};
  let totalW = 0;
  for (const s of summaries) {
    for (const a of (s.anomalies || [])) anomalies.push({ ...a, node: s.nodeId });
    for (const d of (s.topDevices || [])) perDeviceW[d.id] = (perDeviceW[d.id] || 0) + (Number(d.loadW) || 0);
    totalW += Number(s.totalW) || 0;
  }
  anomalies.sort((x, y) => (Date.parse(y.at) || 0) - (Date.parse(x.at) || 0));
  const topDevices = Object.entries(perDeviceW)
    .map(([id, loadW]) => ({ id, loadW: Math.round(loadW * 100) / 100 }))
    .sort((a, b) => b.loadW - a.loadW)
    .slice(0, 5);
  return {
    nodes: summaries.length,
    anomalies: anomalies.slice(0, _maxAnomalies() * Math.max(1, summaries.length)),
    perDeviceW,
    topDevices,
    totalW: Math.round(totalW * 100) / 100
  };
}

/** GC stale node summaries (best-effort). */
function sweep(now = Date.now()) {
  if (!enabled()) return { removed: [] };
  const coord = _coord();
  if (!coord.clusterEnabled()) return { removed: [] };
  try { return coord.sweepShared(KIND, _ttlMs(), now); }
  catch { return { removed: [] }; }
}

module.exports = { FLAG, KIND, enabled, publish, aggregate, sweep };
