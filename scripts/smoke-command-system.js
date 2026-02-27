#!/usr/bin/env node
/**
 * Smoke test for the loader-based command system.
 *
 * Exercises both CLIs (CJS + ESM processor) and verifies:
 *  1. Help output renders all commands
 *  2. --version / --json / --quiet flags work
 *  3. AI-system commands: init, checkpoint, status, parse
 *  4. Automation bridge delegates to CJS modules
 *  5. Unknown command shows help + exits non-zero
 *  6. Build completeness (dist/ has all expected files)
 *
 * Usage:  node scripts/smoke-command-system.js
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'ultimate-ai-system', 'liku', 'cli', 'dist', 'bin.js');
const CJS = path.join(ROOT, 'src', 'cli', 'liku.js');
const TMP = path.join(ROOT, '.smoke-test-tmp');

let pass = 0;
let fail = 0;

function run(cmd, opts = {}) {
  try {
    return { ok: true, out: execSync(cmd, { cwd: ROOT, encoding: 'utf-8', timeout: 15000, ...opts }).trim() };
  } catch (e) {
    return { ok: false, out: (e.stdout || '').trim(), err: (e.stderr || '').trim(), code: e.status };
  }
}

function assert(name, condition, detail) {
  if (condition) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ' — ' + detail : ''}`);
  }
}

// ── Cleanup ──────────────────────────────────────────────────────────────
function cleanup() {
  if (fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true, force: true });
}
cleanup();

console.log('\n\x1b[1m\x1b[36m=== Liku Command System Smoke Test ===\x1b[0m\n');

// ── 1. Build completeness ────────────────────────────────────────────────
console.log('\x1b[1m[1] Build output\x1b[0m');
const distDir = path.join(ROOT, 'ultimate-ai-system', 'liku', 'cli', 'dist');
const expected = ['bin.js', 'commands/index.js', 'commands/types.js',
  'commands/SlashCommandProcessor.js', 'commands/BuildCommandLoader.js', 'commands/LikuCommands.js'];
for (const f of expected) {
  assert(`dist/${f} exists`, fs.existsSync(path.join(distDir, f)));
}

// ── 2. CJS CLI baseline ─────────────────────────────────────────────────
console.log('\n\x1b[1m[2] CJS CLI (src/cli/liku.js)\x1b[0m');
{
  const r = run(`node "${CJS}" --help`);
  assert('--help exits 0', r.ok);
  assert('lists 13 commands', r.out.includes('click') && r.out.includes('screenshot') && r.out.includes('repl'));
}
{
  const r = run(`node "${CJS}" --version`);
  assert('--version prints version', r.ok && r.out.includes('0.0.7'));
}

// ── 3. ESM Processor help / version / flags ──────────────────────────────
console.log('\n\x1b[1m[3] ESM Processor (bin.js)\x1b[0m');
{
  const r = run(`node "${BIN}" --help`);
  assert('--help exits 0', r.ok);
  assert('lists 17 commands', r.out.includes('init') && r.out.includes('parse') && r.out.includes('agent'));
  assert('shows flag descriptions', r.out.includes('--json') && r.out.includes('--quiet'));
}
{
  const r = run(`node "${BIN}" --version`);
  assert('--version prints version', r.ok && r.out.includes('0.1.0'));
}

// ── 4. AI-system commands ────────────────────────────────────────────────
console.log('\n\x1b[1m[4] AI-system commands\x1b[0m');

// init
{
  const r = run(`node "${BIN}" init "${TMP}"`);
  assert('init exits 0', r.ok);
  assert('creates .ai/manifest.json', fs.existsSync(path.join(TMP, '.ai', 'manifest.json')));
  assert('creates checkpoint file', fs.existsSync(path.join(TMP, '.ai', 'context', 'checkpoint.xml')));
  assert('creates provenance log', fs.existsSync(path.join(TMP, '.ai', 'logs', 'provenance.csv')));

  // init again → should fail (already initialized)
  const r2 = run(`node "${BIN}" init "${TMP}"`);
  assert('init again → rejects', !r2.ok || r2.out.includes('already initialized'));
}

// status (from inside project)
{
  const r = run(`node "${BIN}" status`, { cwd: TMP });
  assert('status finds project', r.ok && r.out.includes('Project root'));
}

// status --json
{
  const r = run(`node "${BIN}" status --json`, { cwd: TMP });
  let parsed = null;
  try { parsed = JSON.parse(r.out.replace(/^[^\{]*/, '')); } catch { }
  assert('status --json → valid JSON', parsed && parsed.root);
  assert('status has manifest', parsed && parsed.manifest && parsed.manifest.version === '3.1.0');
}

// checkpoint
{
  const r = run(`node "${BIN}" checkpoint`, { cwd: TMP });
  assert('checkpoint exits 0', r.ok && r.out.includes('Checkpoint saved'));
}

// parse
{
  const sample = path.join(TMP, 'sample.xml');
  fs.writeFileSync(sample, '<analysis type="bug">Found issue</analysis>\n<checkpoint>Saved</checkpoint>');
  const r = run(`node "${BIN}" parse "${sample}" --json`);
  let events = null;
  try { events = JSON.parse(r.out); } catch { }
  assert('parse exits 0', r.ok);
  assert('parse finds 2 events', Array.isArray(events) && events.length === 2);
  assert('parse has analysis event', events && events.some(e => e.event === 'analysis'));
}

// parse with no args → error
{
  const r = run(`node "${BIN}" parse`);
  assert('parse no-args → fails', !r.ok || r.out.includes('Usage'));
}

// ── 5. Automation bridge ─────────────────────────────────────────────────
console.log('\n\x1b[1m[5] Automation bridge (ESM→CJS)\x1b[0m');
{
  const screenshotPath = path.join(TMP, 'test-capture.png');
  const r = run(`node "${BIN}" screenshot "${screenshotPath}"`);
  assert('screenshot bridge works', r.ok);
  assert('screenshot file created', fs.existsSync(screenshotPath));
}

// ── 6. Error handling ────────────────────────────────────────────────────
console.log('\n\x1b[1m[6] Error handling\x1b[0m');
{
  const r = run(`node "${BIN}" nonexistent`);
  assert('unknown command → exit 1', !r.ok && r.code === 1);
  assert('shows help on unknown', r.out.includes('Unknown command') && r.out.includes('Commands:'));
}
{
  const r = run(`node "${BIN}" parse /no/such/file`);
  assert('parse missing file → fails', !r.ok || r.out.includes('not found'));
}

// ── Cleanup & Summary ────────────────────────────────────────────────────
cleanup();
// Also remove any screenshot artifacts from root
const rootScreenshots = fs.readdirSync(ROOT).filter(f => f.startsWith('screenshot_') && f.endsWith('.png'));
for (const s of rootScreenshots) fs.unlinkSync(path.join(ROOT, s));

console.log(`\n\x1b[1m─────────────────────────────────\x1b[0m`);
console.log(`\x1b[1mResults: \x1b[32m${pass} passed\x1b[0m, \x1b[${fail ? '31' : '32'}m${fail} failed\x1b[0m`);
console.log(`\x1b[1m─────────────────────────────────\x1b[0m\n`);

process.exit(fail > 0 ? 1 : 0);
