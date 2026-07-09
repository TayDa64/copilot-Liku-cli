/**
 * Notification Channels — advanced escalation routing (Pillar 3, Phase 11).
 *
 * The Supervisor's bounded in-memory INBOX is always the primary sink for a
 * peripheral notification. This module adds OPTIONAL, additive delivery
 * channels (log, audit file, webhook) so a human-facing surface, an audit trail
 * or an external system can also be informed — WITHOUT ever actuating hardware
 * or calling the LLM.
 *
 * SAFETY / ISOLATION CONTRACT (non-negotiable):
 *   - Channels are pure SINKS. They only forward an advisory notification; they
 *     never execute a command, never actuate a device, never call the LLM.
 *   - Everything is best-effort + non-blocking: a channel failure (bad webhook,
 *     unwritable file) is swallowed and never breaks the alert pipeline.
 *   - Strictly feature-flag gated. Channels only fire when
 *       LIKU_ENABLE_PERIPHERALS=1  AND  the channel is listed in
 *       LIKU_PERIPHERAL_CHANNELS (comma list). Default = inbox-only, so the
 *       existing behaviour (and default cognitive fragment) is unchanged.
 *   - Per-channel severity threshold prevents low-value noise from paging
 *     external systems (e.g. webhook only for warning+ by default).
 *
 * Config:
 *   LIKU_PERIPHERAL_CHANNELS          e.g. "log,file,webhook" (default: none)
 *   LIKU_PERIPHERAL_LOG_MIN_SEVERITY   default "info"
 *   LIKU_PERIPHERAL_FILE_MIN_SEVERITY  default "info"
 *   LIKU_PERIPHERAL_WEBHOOK_MIN_SEVERITY default "warning"
 *   LIKU_PERIPHERAL_WEBHOOK_URL        http(s) endpoint for the webhook channel
 *   LIKU_PERIPHERAL_WEBHOOK_TIMEOUT_MS default 2000
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { LIKU_HOME } = require('../../shared/liku-home');
const { atomicWriteFileSync } = require('../../shared/atomic-file');

const FLAG = 'LIKU_ENABLE_PERIPHERALS';
const AUDIT_FILE = path.join(LIKU_HOME, 'peripheral-notifications.log');
const AUDIT_MAX_LINES = 500; // bounded audit trail (JSONL)

// Coarse severity ordering shared with the store's retention model.
const SEVERITY_RANK = Object.freeze({ info: 0, low: 0, warning: 1, medium: 1, high: 2, critical: 2 });

function _rank(sev) {
  const k = String(sev || 'info').toLowerCase();
  return SEVERITY_RANK[k] != null ? SEVERITY_RANK[k] : 0;
}

function _enabled() {
  return String(process.env[FLAG] || '').trim() === '1';
}

/** Parse the comma-separated enabled-channel list. @private */
function enabledChannels() {
  if (!_enabled()) return [];
  return String(process.env.LIKU_PERIPHERAL_CHANNELS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Minimum severity for a channel (env override, safe default). @private */
function _minSeverity(channel) {
  const envKey = `LIKU_PERIPHERAL_${channel.toUpperCase()}_MIN_SEVERITY`;
  const dflt = channel === 'webhook' ? 'warning' : 'info';
  return String(process.env[envKey] || dflt).toLowerCase();
}

/** A compact, side-effect-free one-line summary of a notification. @private */
function _summarize(n) {
  const dev = (n && n.device && n.device.id) || '?';
  const br = n && n.breach ? `${n.breach.metric || '?'}:${n.breach.level || '?'}` : '';
  return `[peripheral] ${String(n && n.severity || 'info').toUpperCase()} ${dev} ${br} — ${n && n.advisory || ''}`.trim();
}

// ── Built-in channel sinks (all best-effort, never throw) ─────────────────────

function _deliverLog(n) {
  try { console.log(_summarize(n)); return true; } catch { return false; }
}

/** Append to a bounded JSONL audit trail using the atomic + locked writer. */
function _deliverFile(n) {
  try {
    if (!fs.existsSync(LIKU_HOME)) fs.mkdirSync(LIKU_HOME, { recursive: true, mode: 0o700 });
    let lines = [];
    try {
      if (fs.existsSync(AUDIT_FILE)) {
        lines = fs.readFileSync(AUDIT_FILE, 'utf-8').split('\n').filter(Boolean);
      }
    } catch { lines = []; }
    const record = {
      at: (n && n.receivedAt) || (n && n.at) || new Date().toISOString(),
      severity: n && n.severity,
      device: (n && n.device && n.device.id) || null,
      metric: (n && n.breach && n.breach.metric) || null,
      level: (n && n.breach && n.breach.level) || null,
      advisory: n && n.advisory,
      requiresHuman: !!(n && n.requiresHuman),
      autonomousAction: false
    };
    lines.push(JSON.stringify(record));
    if (lines.length > AUDIT_MAX_LINES) lines = lines.slice(-AUDIT_MAX_LINES);
    atomicWriteFileSync(AUDIT_FILE, lines.join('\n') + '\n', { mode: 0o600 });
    return true;
  } catch { return false; }
}

/**
 * Fire-and-forget webhook POST. Never blocks the caller and never throws.
 * Sends only the advisory notification (no secrets, no executable action).
 */
function _deliverWebhook(n) {
  const url = String(process.env.LIKU_PERIPHERAL_WEBHOOK_URL || '').trim();
  if (!url) return false;
  try {
    const lib = url.startsWith('https:') ? require('https') : require('http');
    const body = JSON.stringify({
      type: 'peripheral-notification',
      severity: n && n.severity,
      device: n && n.device,
      breach: n && n.breach,
      advisory: n && n.advisory,
      requiresHuman: !!(n && n.requiresHuman),
      autonomousAction: false,
      at: (n && n.receivedAt) || (n && n.at) || new Date().toISOString()
    });
    const timeoutMs = Number(process.env.LIKU_PERIPHERAL_WEBHOOK_TIMEOUT_MS) || 2000;
    const req = lib.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => { res.on('data', () => {}); res.on('end', () => {}); });
    req.on('error', () => {}); // swallow — best-effort
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch { /* ignore */ } });
    req.write(body);
    req.end();
    return true;
  } catch { return false; }
}

const CHANNEL_SINKS = Object.freeze({
  log: _deliverLog,
  file: _deliverFile,
  webhook: _deliverWebhook
});

/**
 * Dispatch a notification to all enabled channels whose severity threshold is
 * met. Returns the list of channels actually delivered to (for observability).
 * Best-effort + non-blocking; inbox delivery is handled by the Supervisor and
 * is NOT part of this list.
 *
 * @param {object} notification
 * @returns {{ delivered: string[], considered: string[] }}
 */
function dispatch(notification) {
  const considered = enabledChannels();
  const delivered = [];
  if (!considered.length || !notification) return { delivered, considered };
  const sevRank = _rank(notification.severity);
  for (const ch of considered) {
    const sink = CHANNEL_SINKS[ch];
    if (typeof sink !== 'function') continue;
    if (sevRank < _rank(_minSeverity(ch))) continue; // below channel threshold
    try { if (sink(notification)) delivered.push(ch); } catch { /* best-effort */ }
  }
  return { delivered, considered };
}

/** Describe the currently configured channels (CLI/observability). */
function describe() {
  const channels = enabledChannels();
  return {
    enabled: _enabled(),
    channels: channels.map((ch) => ({
      channel: ch,
      minSeverity: _minSeverity(ch),
      configured: ch !== 'webhook' || !!String(process.env.LIKU_PERIPHERAL_WEBHOOK_URL || '').trim()
    })),
    auditFile: AUDIT_FILE
  };
}

module.exports = {
  FLAG,
  AUDIT_FILE,
  AUDIT_MAX_LINES,
  SEVERITY_RANK,
  enabledChannels,
  dispatch,
  describe
};
