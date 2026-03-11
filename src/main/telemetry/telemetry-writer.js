/**
 * Telemetry Writer — RLVR structured telemetry
 *
 * Captures success/failure telemetry payloads from action execution
 * and verification results. Writes JSONL to ~/.liku/telemetry/logs/.
 *
 * Each log file spans one day (YYYY-MM-DD.jsonl) for easy rotation.
 *
 * Telemetry payloads power the Reflection Trigger (Phase 2b) which
 * analyzes failures and can update skills or memory.
 */

const fs = require('fs');
const path = require('path');
const { LIKU_HOME } = require('../../shared/liku-home');

const TELEMETRY_DIR = path.join(LIKU_HOME, 'telemetry', 'logs');

// ─── Task ID generation ─────────────────────────────────────

let taskCounter = 0;

function generateTaskId() {
  taskCounter++;
  const ts = Date.now().toString(36);
  const seq = taskCounter.toString(36).padStart(3, '0');
  return `task-${ts}${seq}`;
}

// ─── Core writer ────────────────────────────────────────────

/**
 * Append a telemetry payload to today's JSONL log file.
 *
 * @param {object} payload - Must include at minimum:
 *   - task {string} - description of what was attempted
 *   - phase {'execution'|'validation'|'reflection'} 
 *   - outcome {'success'|'failure'}
 *
 * Optional fields: actions, verifier, context, taskId
 */
function writeTelemetry(payload) {
  try {
    if (!fs.existsSync(TELEMETRY_DIR)) {
      fs.mkdirSync(TELEMETRY_DIR, { recursive: true, mode: 0o700 });
    }

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const logPath = path.join(TELEMETRY_DIR, `${today}.jsonl`);

    const record = {
      timestamp: new Date().toISOString(),
      taskId: payload.taskId || generateTaskId(),
      task: payload.task || 'unknown',
      phase: payload.phase || 'execution',
      outcome: payload.outcome || 'unknown',
      actions: payload.actions || [],
      verifier: payload.verifier || null,
      context: payload.context || null
    };

    fs.appendFileSync(logPath, JSON.stringify(record) + '\n', 'utf-8');
    return record;
  } catch (err) {
    console.warn('[Telemetry] Failed to write:', err.message);
    return null;
  }
}

/**
 * Read telemetry entries for a given date (defaults to today).
 *
 * @param {string} [date] - YYYY-MM-DD format
 * @returns {object[]} Array of parsed telemetry records
 */
function readTelemetry(date) {
  const day = date || new Date().toISOString().slice(0, 10);
  const logPath = path.join(TELEMETRY_DIR, `${day}.jsonl`);

  try {
    if (!fs.existsSync(logPath)) return [];
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    return lines
      .filter(line => line.trim())
      .map(line => {
        try { return JSON.parse(line); }
        catch { return null; }
      })
      .filter(Boolean);
  } catch (err) {
    console.warn('[Telemetry] Failed to read:', err.message);
    return [];
  }
}

/**
 * Get recent failures (last N entries where outcome === 'failure').
 *
 * @param {number} [limit=10]
 * @returns {object[]}
 */
function getRecentFailures(limit) {
  limit = limit || 10;
  const entries = readTelemetry();
  return entries
    .filter(e => e.outcome === 'failure')
    .slice(-limit);
}

/**
 * Get failure count for today.
 */
function getTodayFailureCount() {
  return readTelemetry().filter(e => e.outcome === 'failure').length;
}

/**
 * List available telemetry log dates.
 */
function listTelemetryDates() {
  try {
    if (!fs.existsSync(TELEMETRY_DIR)) return [];
    return fs.readdirSync(TELEMETRY_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace('.jsonl', ''))
      .sort();
  } catch {
    return [];
  }
}

module.exports = {
  writeTelemetry,
  readTelemetry,
  getRecentFailures,
  getTodayFailureCount,
  listTelemetryDates,
  generateTaskId,
  TELEMETRY_DIR
};
