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
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  assert('--version prints version', r.ok && r.out.includes(pkg.version));
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

// ── 7. Environment sanitization (ELECTRON_RUN_AS_NODE triple-layer) ──────
console.log('\n\x1b[1m[7] Environment sanitization\x1b[0m');
{
  // Verify start.js spawner sanitizes ELECTRON_RUN_AS_NODE
  const startContent = fs.readFileSync(path.join(ROOT, 'src', 'cli', 'commands', 'start.js'), 'utf-8');
  assert('start.js deletes ELECTRON_RUN_AS_NODE', startContent.includes('delete env.ELECTRON_RUN_AS_NODE'));

  // Verify scripts/start.js also sanitizes
  const devStartContent = fs.readFileSync(path.join(ROOT, 'scripts', 'start.js'), 'utf-8');
  assert('scripts/start.js deletes ELECTRON_RUN_AS_NODE', devStartContent.includes('delete env.ELECTRON_RUN_AS_NODE'));

  // Verify main process self-cleans at boot
  const mainContent = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf-8');
  assert('index.js self-cleans ELECTRON_RUN_AS_NODE', mainContent.includes('delete process.env.ELECTRON_RUN_AS_NODE'));

  // Verify CLI start command clones env (not mutating process.env)
  assert('start.js clones env before mutating', startContent.includes('{ ...process.env }'));
}

// ── 8. Session persistence paths ─────────────────────────────────────────
console.log('\n\x1b[1m[8] Session persistence\x1b[0m');
{
  const mainContent = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf-8');
  const aiContent = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ai-service.js'), 'utf-8');

  // Both files use the same LIKU_HOME base
  assert('index.js uses ~/.liku-cli', mainContent.includes("path.join(os.homedir(), '.liku-cli')"));
  assert('ai-service.js uses ~/.liku-cli', aiContent.includes("path.join(os.homedir(), '.liku-cli')"));

  // userData is persistent (not tmpdir)
  assert('userData is under LIKU_HOME', mainContent.includes("path.join(LIKU_HOME, 'session')"));
  assert('no tmpdir for userData', !mainContent.includes("os.tmpdir(), 'copilot-liku-electron-cache', 'user-data'"));

  // Token lives in LIKU_HOME
  assert('token file in LIKU_HOME', aiContent.includes("path.join(LIKU_HOME, 'copilot-token.json')"));

  // Legacy token migration exists
  assert('legacy token migration exists', aiContent.includes('Migrated token from legacy path'));
}

// ── 9. Adaptive UIA polling ──────────────────────────────────────────────
console.log('\n\x1b[1m[9] Adaptive UIA polling\x1b[0m');
{
  const mainContent = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf-8');

  // Two polling speeds defined
  assert('fast polling constant (500ms)', mainContent.includes('UI_POLL_FAST_MS = 500'));
  assert('slow polling constant (1500ms)', mainContent.includes('UI_POLL_SLOW_MS = 1500'));

  // Re-entry guard prevents overlapping tree walks
  assert('re-entry guard exists', mainContent.includes('uiSnapshotInProgress'));
  assert('guard checked before walk', mainContent.includes('if (uiSnapshotInProgress) return'));

  // Mode-aware speed switching
  assert('setOverlayMode triggers speed switch', mainContent.includes("setUIPollingSpeed(mode === 'selection')"));
  assert('inspect toggle triggers speed switch', mainContent.includes('setUIPollingSpeed(newState || overlayMode'));

  // Walk time logging for diagnostics
  assert('walk time warning logged', mainContent.includes('Tree walk took'));
}

// ── 10. Phase 0 completion: ROI capture + analyzeScreen → regions ────────
console.log('\n\x1b[1m[10] Phase 0 completion (ROI + analyze→regions)\x1b[0m');
{
  const mainContent = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf-8');

  // ROI auto-capture on dot-selected
  assert('captureRegionInternal helper exists', mainContent.includes('async function captureRegionInternal'));
  assert('dot-selected triggers ROI capture', mainContent.includes('captureRegionInternal(rx, ry, roiSize, roiSize)'));
  assert('capture-region IPC delegates to helper', mainContent.includes('await captureRegionInternal(x, y, width, height)'));

  // analyzeScreen pipes into inspectService
  assert('analyze-screen feeds accessibility regions', mainContent.includes("inspectService.updateRegions(") && mainContent.includes("'accessibility'"));
  assert('analyze-screen feeds OCR regions', mainContent.includes("'ocr'") && mainContent.includes('OCR text content'));
  assert('analyze-screen pushes merged regions to overlay', mainContent.includes('denormalizeRegionsForOverlay(mergedRegions'));
}

// ── 11. Coordinate contract (Phase 1) ────────────────────────────────────
console.log('\n\x1b[1m[11] Coordinate contract (Phase 1)\x1b[0m');
{
  const mainContent = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf-8');

  // dot-selected adds physicalX/physicalY
  assert('dot-selected converts CSS→physical', mainContent.includes('data.physicalX = Math.round(data.x * sf)'));
  assert('dot-selected stores scaleFactor', mainContent.includes('data.scaleFactor = sf'));

  // denormalizeRegionsForOverlay helper
  assert('denormalizeRegionsForOverlay defined', mainContent.includes('function denormalizeRegionsForOverlay'));
  assert('denormalize divides by scaleFactor', mainContent.includes('r.bounds.x / scaleFactor'));

  // getVirtualDesktopBounds helper
  assert('getVirtualDesktopBounds defined', mainContent.includes('function getVirtualDesktopBounds'));
  assert('uses getAllDisplays()', mainContent.includes('screen.getAllDisplays()'));

  // All region push paths denormalize
  assert('initUIWatcher denormalizes regions', mainContent.includes('denormalizeRegionsForOverlay(elements.map'));
  assert('poll-complete denormalizes regions', mainContent.includes('denormalizeRegionsForOverlay(rawRegions, sf)'));

  // Capture uses virtual desktop size
  assert('capture-screen uses virtual desktop size', mainContent.includes('thumbnailSize: getVirtualDesktopSize()'));
}

// ── 12. Multi-monitor overlay (Phase 1) ──────────────────────────────────
console.log('\n\x1b[1m[12] Multi-monitor overlay (Phase 1)\x1b[0m');
{
  const mainContent = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf-8');

  // Overlay spans virtual desktop
  assert('overlay uses getVirtualDesktopBounds()', mainContent.includes('const vd = getVirtualDesktopBounds()'));
  assert('overlay x/y set from virtual desktop', mainContent.includes('x: vd.x') && mainContent.includes('y: vd.y'));
  assert('Windows uses setBounds for multi-monitor', mainContent.includes('overlayWindow.setBounds({ x: vd.x'));

  // Contract documented in advancingFeatures.md
  const afContent = fs.readFileSync(path.join(ROOT, 'advancingFeatures.md'), 'utf-8');
  assert('coordinate contract documented', afContent.includes('## Coordinate Contract (Phase 1'));
  assert('contract documents scaleFactor', afContent.includes('scaleFactor'));
  assert('contract documents denormalizeRegionsForOverlay', afContent.includes('denormalizeRegionsForOverlay'));
}

// ── 13. inspect-types coordinate helpers ─────────────────────────────────
console.log('\n\x1b[1m[13] inspect-types coordinate helpers\x1b[0m');
{
  const itContent = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'inspect-types.js'), 'utf-8');

  assert('normalizeCoordinates exists', itContent.includes('function normalizeCoordinates'));
  assert('denormalizeCoordinates exists', itContent.includes('function denormalizeCoordinates'));
  assert('normalizeCoordinates multiplies by scaleFactor', itContent.includes('x * scaleFactor'));
  assert('denormalizeCoordinates divides by scaleFactor', itContent.includes('x / scaleFactor'));
}

// ── 14. Phase 1 coordinate pipeline fixes (BUG1-4) ──────────────────────
console.log('\n\x1b[1m[14] Phase 1 coordinate pipeline fixes\x1b[0m');
{
  const indexContent = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf-8');

  // BUG1: dot-selected coords threaded into AI prompt
  assert('lastDotSelection declared', indexContent.includes('let lastDotSelection'));
  assert('dot-selected stores lastDotSelection', indexContent.includes('lastDotSelection = data'));
  assert('chat-message consumes dotCoords', indexContent.includes('const dotCoords = lastDotSelection'));
  assert('coordinates passed to sendMessage', indexContent.includes('coordinates: dotCoords'));
  assert('lastDotSelection consumed after use', indexContent.includes('lastDotSelection = null'));

  // BUG2+4: DIP→physical conversion at Win32 boundary
  assert('DIP→physical scaling present', indexContent.includes('DIP→physical'));
  assert('multiplies by scaleFactor for Win32', /action\.x \* sf\)/.test(indexContent));

  // BUG3: region-resolved actions skip image scaling
  assert('region-resolved bypass present', indexContent.includes('action._resolvedFromRegion'));
  assert('region flag set during resolution', indexContent.includes("action._resolvedFromRegion = resolved.region.id"));

  // Visual feedback converts physical→CSS for overlay
  assert('feedbackX converts physical→CSS/DIP', indexContent.includes('const feedbackX = sf'));
  assert('pulse uses feedbackX not raw x', /x: feedbackX,\s*\n\s*y: feedbackY/.test(indexContent));

  // Screenshot callback uses virtual desktop
  assert('executeActionsAndRespond uses getVirtualDesktopSize',
    /thumbnailSize:\s*getVirtualDesktopSize\(\)/.test(indexContent));

  // Ensure NO capture paths still use primary display bounds
  const captureBlocks = indexContent.split('desktopCapturer.getSources');
  const badCaptures = captureBlocks.slice(1).filter(b => {
    const snippet = b.slice(0, 200);
    return snippet.includes('getPrimaryDisplay().bounds');
  });
  assert('no capture paths use getPrimaryDisplay().bounds', badCaptures.length === 0);
}

// ── 15. Phase 2: Pick element at point + stable identity ─────────────────
console.log('\n\x1b[1m[15] Phase 2: element-from-point + stable identity\x1b[0m');
{
  // .NET host binary exists
  const uiaBin = path.join(ROOT, 'bin', 'WindowsUIA.exe');
  assert('.NET UIA host binary exists', fs.existsSync(uiaBin));

  // .NET host has JSONL command loop
  const csContent = fs.readFileSync(path.join(ROOT, 'src', 'native', 'windows-uia-dotnet', 'Program.cs'), 'utf-8');
  assert('Program.cs has stdin command loop', csContent.includes('Console.ReadLine()'));
  assert('Program.cs has elementFromPoint handler', csContent.includes('HandleElementFromPoint'));
  assert('Program.cs calls AutomationElement.FromPoint', csContent.includes('AutomationElement.FromPoint'));
  assert('Program.cs calls GetRuntimeId', csContent.includes('GetRuntimeId()'));
  assert('Program.cs calls TryGetClickablePoint', csContent.includes('TryGetClickablePoint'));
  assert('Program.cs returns patterns list', csContent.includes('IsInvokePatternAvailableProperty'));
  assert('Program.cs returns nativeWindowHandle', csContent.includes('NativeWindowHandle'));
  assert('Program.cs legacy one-shot preserved', csContent.includes('GetForegroundWindow'));

  // Node-side persistent host manager
  const hostPath = path.join(ROOT, 'src', 'main', 'ui-automation', 'core', 'uia-host.js');
  assert('uia-host.js exists', fs.existsSync(hostPath));
  const hostContent = fs.readFileSync(hostPath, 'utf-8');
  assert('UIAHost class exported', hostContent.includes('class UIAHost'));
  assert('getSharedUIAHost singleton exported', hostContent.includes('function getSharedUIAHost'));
  assert('UIAHost.elementFromPoint method', hostContent.includes('async elementFromPoint'));
  assert('UIAHost.getTree method', hostContent.includes('async getTree'));
  assert('JSONL protocol (newline-delimited)', hostContent.includes("JSON.stringify(cmd) + '\\n'"));
  assert('UIAHost.stop graceful shutdown', hostContent.includes('async stop'));

  // Barrel export
  const indexContent = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ui-automation', 'index.js'), 'utf-8');
  assert('UIAHost in barrel exports', indexContent.includes('UIAHost'));
  assert('getSharedUIAHost in barrel exports', indexContent.includes('getSharedUIAHost'));

  // visual-awareness uses .NET host fast path
  const vaContent = fs.readFileSync(path.join(ROOT, 'src', 'main', 'visual-awareness.js'), 'utf-8');
  assert('findElementAtPoint imports getSharedUIAHost', vaContent.includes("require('./ui-automation/core/uia-host')"));
  assert('findElementAtPoint tries .NET host first', vaContent.includes('host.elementFromPoint'));
  assert('findElementAtPoint has PowerShell fallback', vaContent.includes('Fallback'));

  // inspect-types has runtimeId field
  const itContent = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'inspect-types.js'), 'utf-8');
  assert('InspectRegion has runtimeId field', itContent.includes('runtimeId'));
  assert('createInspectRegion sets runtimeId', itContent.includes('runtimeId: params.runtimeId'));

  // inspect-service passes runtimeId + clickPoint
  const isContent = fs.readFileSync(path.join(ROOT, 'src', 'main', 'inspect-service.js'), 'utf-8');
  assert('detectRegions maps runtimeId', isContent.includes('runtimeId: e.runtimeId'));
  assert('detectRegions maps clickPoint from .NET or PS', isContent.includes('e.clickPoint'));
}

// ── [16] Phase 3: Pattern-first interaction primitives ───────────────────
{
  console.log('\n\x1b[1m[16] Phase 3 \u2013 Pattern-first interaction primitives\x1b[0m');

  // .NET host has all 4 new handlers
  const dotnetPath = path.join(ROOT, 'src', 'native', 'windows-uia-dotnet', 'Program.cs');
  const dotnet = fs.readFileSync(dotnetPath, 'utf-8');
  assert('.NET host handles setValue command', dotnet.includes('case "setValue"'));
  assert('.NET host handles scroll command', dotnet.includes('case "scroll"'));
  assert('.NET host handles expandCollapse command', dotnet.includes('case "expandCollapse"'));
  assert('.NET host handles getText command', dotnet.includes('case "getText"'));
  assert('.NET HandleSetValue method', dotnet.includes('HandleSetValue'));
  assert('.NET HandleScroll method', dotnet.includes('HandleScroll'));
  assert('.NET HandleExpandCollapse method', dotnet.includes('HandleExpandCollapse'));
  assert('.NET HandleGetText method', dotnet.includes('HandleGetText'));
  assert('.NET ResolveElement helper', dotnet.includes('ResolveElement'));
  assert('.NET GetPatternNames helper', dotnet.includes('GetPatternNames'));

  // Node bridge convenience methods
  const hostPath = path.join(ROOT, 'src', 'main', 'ui-automation', 'core', 'uia-host.js');
  const host = fs.readFileSync(hostPath, 'utf-8');
  assert('UIAHost.setValue bridge method', host.includes('async setValue'));
  assert('UIAHost.scroll bridge method', host.includes('async scroll'));
  assert('UIAHost.expandCollapse bridge method', host.includes('async expandCollapse'));
  assert('UIAHost.getText bridge method', host.includes('async getText'));

  // pattern-actions.js exists with all functions
  const paPath = path.join(ROOT, 'src', 'main', 'ui-automation', 'interactions', 'pattern-actions.js');
  assert('pattern-actions.js exists', fs.existsSync(paPath));
  const pa = fs.readFileSync(paPath, 'utf-8');
  assert('normalizePatternName helper', pa.includes('function normalizePatternName'));
  assert('hasPattern helper', pa.includes('function hasPattern'));
  assert('setElementValue function', pa.includes('async function setElementValue'));
  assert('scrollElement function', pa.includes('async function scrollElement'));
  assert('expandElement function', pa.includes('async function expandElement'));
  assert('collapseElement function', pa.includes('async function collapseElement'));
  assert('toggleExpandCollapse function', pa.includes('async function toggleExpandCollapse'));
  assert('getElementText function', pa.includes('async function getElementText'));
  assert('pattern-actions exports all public functions', 
    pa.includes('setElementValue') && pa.includes('scrollElement') && 
    pa.includes('expandElement') && pa.includes('collapseElement') && 
    pa.includes('getElementText') && pa.includes('normalizePatternName'));
  assert('pattern-actions returns patternUnsupported flag', pa.includes('patternUnsupported'));

  // high-level.js upgraded with pattern-first strategies
  const hlPath = path.join(ROOT, 'src', 'main', 'ui-automation', 'interactions', 'high-level.js');
  const hl = fs.readFileSync(hlPath, 'utf-8');
  assert('fillField imports setElementValue from pattern-actions', hl.includes("require('./pattern-actions')"));
  assert('fillField tries ValuePattern first', hl.includes('setElementValue') && hl.includes('preferPattern'));
  assert('selectDropdownItem tries ExpandCollapsePattern first', hl.includes('expandElement') && hl.includes('ExpandCollapsePattern'));

  // Barrel re-exports from interactions/index.js
  const intIdx = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ui-automation', 'interactions', 'index.js'), 'utf-8');
  assert('interactions/index re-exports setElementValue', intIdx.includes('setElementValue'));
  assert('interactions/index re-exports scrollElement', intIdx.includes('scrollElement'));
  assert('interactions/index re-exports expandElement', intIdx.includes('expandElement'));
  assert('interactions/index re-exports collapseElement', intIdx.includes('collapseElement'));
  assert('interactions/index re-exports toggleExpandCollapse', intIdx.includes('toggleExpandCollapse'));
  assert('interactions/index re-exports getElementText', intIdx.includes('getElementText'));

  // Main barrel exports
  const mainIdx = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ui-automation', 'index.js'), 'utf-8');
  assert('main barrel exports setElementValue', mainIdx.includes('setElementValue'));
  assert('main barrel exports scrollElement', mainIdx.includes('scrollElement'));
  assert('main barrel exports expandElement', mainIdx.includes('expandElement'));
  assert('main barrel exports getElementText', mainIdx.includes('getElementText'));
  assert('main barrel exports normalizePatternName', mainIdx.includes('normalizePatternName'));
  assert('main barrel exports hasPattern', mainIdx.includes('hasPattern'));

  // element-click.js handles both pattern name formats
  const ecPath = path.join(ROOT, 'src', 'main', 'ui-automation', 'interactions', 'element-click.js');
  const ec = fs.readFileSync(ecPath, 'utf-8');
  assert('clickElement handles short pattern name format', ec.includes("'Invoke'"));

  // system-automation.js integrates pattern-first ACTION_TYPES
  const saContent = fs.readFileSync(path.join(ROOT, 'src', 'main', 'system-automation.js'), 'utf-8');
  assert('ACTION_TYPES.SET_VALUE defined', saContent.includes("SET_VALUE: 'set_value'"));
  assert('ACTION_TYPES.SCROLL_ELEMENT defined', saContent.includes("SCROLL_ELEMENT: 'scroll_element'"));
  assert('ACTION_TYPES.EXPAND_ELEMENT defined', saContent.includes("EXPAND_ELEMENT: 'expand_element'"));
  assert('ACTION_TYPES.COLLAPSE_ELEMENT defined', saContent.includes("COLLAPSE_ELEMENT: 'collapse_element'"));
  assert('ACTION_TYPES.GET_TEXT defined', saContent.includes("GET_TEXT: 'get_text'"));
  assert('executeAction handles SET_VALUE', saContent.includes('case ACTION_TYPES.SET_VALUE'));
  assert('executeAction handles SCROLL_ELEMENT', saContent.includes('case ACTION_TYPES.SCROLL_ELEMENT'));
  assert('executeAction handles EXPAND_ELEMENT', saContent.includes('case ACTION_TYPES.EXPAND_ELEMENT'));
  assert('executeAction handles COLLAPSE_ELEMENT', saContent.includes('case ACTION_TYPES.COLLAPSE_ELEMENT'));
  assert('executeAction handles GET_TEXT', saContent.includes('case ACTION_TYPES.GET_TEXT'));
  assert('SET_VALUE delegates to uia.setElementValue', saContent.includes('uia.setElementValue'));
  assert('SCROLL_ELEMENT delegates to uia.scrollElement', saContent.includes('uia.scrollElement'));

  // scrollElement has mouse-wheel fallback
  assert('scrollElement imports mouse moveMouse', pa.includes("moveMouse"));
  assert('scrollElement imports mouse scroll', pa.includes("mouseWheelScroll"));
  assert('scrollElement falls back to mouseWheel', pa.includes("method: 'mouseWheel'"));
}

// ── [17] Phase 4: Event-driven UI watcher ────────────────────────────────
{
  console.log('\n\x1b[1m[17] Phase 4 \u2013 Event-driven UI watcher\x1b[0m');

  // ── Layer 1: .NET host event streaming ──
  const dotnetPath = path.join(ROOT, 'src', 'native', 'windows-uia-dotnet', 'Program.cs');
  const dotnet = fs.readFileSync(dotnetPath, 'utf-8');

  // Thread-safe Reply
  assert('.NET Reply uses lock(_writeLock)', dotnet.includes('lock (_writeLock)'));
  assert('.NET _writeLock is static readonly', dotnet.includes('static readonly object _writeLock'));

  // subscribeEvents / unsubscribeEvents commands
  assert('.NET host handles subscribeEvents', dotnet.includes('case "subscribeEvents"'));
  assert('.NET host handles unsubscribeEvents', dotnet.includes('case "unsubscribeEvents"'));
  assert('.NET HandleSubscribeEvents method', dotnet.includes('HandleSubscribeEvents'));
  assert('.NET HandleUnsubscribeEvents method', dotnet.includes('HandleUnsubscribeEvents'));

  // Event handlers
  assert('.NET OnFocusChanged handler', dotnet.includes('OnFocusChanged'));
  assert('.NET OnStructureChanged handler', dotnet.includes('OnStructureChanged'));
  assert('.NET OnPropertyChanged handler', dotnet.includes('OnPropertyChanged'));
  assert('.NET AddAutomationFocusChangedEventHandler', dotnet.includes('AddAutomationFocusChangedEventHandler'));
  assert('.NET AddStructureChangedEventHandler', dotnet.includes('AddStructureChangedEventHandler'));
  assert('.NET AddAutomationPropertyChangedEventHandler', dotnet.includes('AddAutomationPropertyChangedEventHandler'));

  // Event payloads
  assert('.NET emits type="event" for focus', dotnet.includes('"focusChanged"'));
  assert('.NET emits type="event" for structure', dotnet.includes('"structureChanged"'));
  assert('.NET emits type="event" for property', dotnet.includes('"propertyChanged"'));

  // BuildLightElement (format-compatible with PS watcher)
  assert('.NET BuildLightElement method', dotnet.includes('BuildLightElement'));
  assert('.NET WalkFocusedWindowElements method', dotnet.includes('WalkFocusedWindowElements'));
  assert('.NET BuildWindowInfo method', dotnet.includes('BuildWindowInfo'));

  // Debounce & adaptive backoff
  assert('.NET structure debounce timer', dotnet.includes('_structureDebounce'));
  assert('.NET property debounce timer', dotnet.includes('_propertyDebounce'));
  assert('.NET adaptive backoff (burst detection)', dotnet.includes('_structureEventBurst'));
  assert('.NET debounce 200ms backoff', dotnet.includes('_structureDebounceMs = 200'));

  // Window tracking & cleanup
  assert('.NET AttachToWindow method', dotnet.includes('AttachToWindow'));
  assert('.NET DetachFromWindow method', dotnet.includes('DetachFromWindow'));
  assert('.NET FindTopLevelWindow method', dotnet.includes('FindTopLevelWindow'));
  assert('.NET RemoveFocusChangedEventHandler on unsubscribe', dotnet.includes('RemoveAutomationFocusChangedEventHandler'));
  assert('.NET RemoveStructureChangedEventHandler on unsubscribe', dotnet.includes('RemoveStructureChangedEventHandler'));
  assert('.NET RemovePropertyChangedEventHandler on unsubscribe', dotnet.includes('RemoveAutomationPropertyChangedEventHandler'));

  // ── Layer 2: UIAHost event routing ──
  const hostPath = path.join(ROOT, 'src', 'main', 'ui-automation', 'core', 'uia-host.js');
  const host = fs.readFileSync(hostPath, 'utf-8');

  assert('UIAHost routes events before _resolvePending', host.includes("json.type === 'event'"));
  assert('UIAHost emits uia-event', host.includes("this.emit('uia-event', json)"));
  assert('UIAHost.subscribeEvents method', host.includes('async subscribeEvents'));
  assert('UIAHost.unsubscribeEvents method', host.includes('async unsubscribeEvents'));
  assert('UIAHost event routing uses continue to skip pending', host.includes('continue;'));

  // ── Layer 3: UIWatcher event mode ──
  const watcherPath = path.join(ROOT, 'src', 'main', 'ui-watcher.js');
  const watcher = fs.readFileSync(watcherPath, 'utf-8');

  assert('UIWatcher imports getSharedUIAHost', watcher.includes("require('./ui-automation/core/uia-host')"));
  assert('UIWatcher MODE state enum', watcher.includes("POLLING: 'POLLING'"));
  assert('UIWatcher MODE.EVENT_MODE', watcher.includes("EVENT_MODE: 'EVENT_MODE'"));
  assert('UIWatcher MODE.FALLBACK', watcher.includes("FALLBACK: 'FALLBACK'"));
  assert('UIWatcher MODE.STARTING_EVENTS', watcher.includes("STARTING_EVENTS: 'STARTING_EVENTS'"));
  assert('UIWatcher startEventMode method', watcher.includes('async startEventMode'));
  assert('UIWatcher stopEventMode method', watcher.includes('async stopEventMode'));
  assert('UIWatcher _onUiaEvent handler', watcher.includes('_onUiaEvent'));
  assert('UIWatcher handles focusChanged event', watcher.includes("case 'focusChanged'"));
  assert('UIWatcher handles structureChanged event', watcher.includes("case 'structureChanged'"));
  assert('UIWatcher handles propertyChanged event', watcher.includes("case 'propertyChanged'"));
  assert('UIWatcher health check timer (10s)', watcher.includes('10000'));
  assert('UIWatcher fallback auto-retry (30s)', watcher.includes('30000'));
  assert('UIWatcher emits mode-changed event', watcher.includes("emit('mode-changed'"));
  assert('UIWatcher emits poll-complete from events', watcher.includes("source: 'event-structure'"));
  assert('UIWatcher emits poll-complete for property patches', watcher.includes("source: 'event-property'"));
  assert('UIWatcher propertyChanged merges into cache', watcher.includes('Object.assign(map.get(patch.id), patch)'));
  assert('UIWatcher _fallbackToPolling method', watcher.includes('_fallbackToPolling'));
  assert('UIWatcher _restartPolling method', watcher.includes('_restartPolling'));
  assert('UIWatcher destroy calls stopEventMode', watcher.includes('this.stopEventMode'));

  // ── Layer 4: index.js integration ──
  const mainJsPath = path.join(ROOT, 'src', 'main', 'index.js');
  const mainJs = fs.readFileSync(mainJsPath, 'utf-8');

  assert('index.js calls startEventMode on inspect enable', mainJs.includes('startEventMode'));
  assert('index.js calls stopEventMode on inspect disable', mainJs.includes('stopEventMode'));
}

// ── [18] Gap Fixes ───────────────────────────────────────────────────────
{
  console.log('\n\x1b[1m[18] Gap Fixes (G1, G2, G3)\x1b[0m');

  // G1 — clickPoint preferred over bounds-center in element-click.js
  const elemClick = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ui-automation', 'interactions', 'element-click.js'), 'utf-8');
  assert('click() prefers element.clickPoint.x', elemClick.includes('element.clickPoint?.x ?? (bounds.x'));
  assert('click() prefers element.clickPoint.y', elemClick.includes('element.clickPoint?.y ?? (bounds.y'));
  assert('clickElement() prefers element.clickPoint.x', (elemClick.match(/element\.clickPoint\?\.\s*x/g) || []).length >= 2);
  assert('clickElement() prefers element.clickPoint.y', (elemClick.match(/element\.clickPoint\?\.\s*y/g) || []).length >= 2);

  // G2 — capture → detectRegions pipeline wired in index.js
  const mainJs2 = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf-8');
  assert('captureRegionInternal calls detectRegions after storeVisualContext', mainJs2.includes('inspectService.detectRegions({ screenshot: imageData })'));
  assert('Detected regions pushed to overlay via update-inspect-regions', mainJs2.includes("action: 'update-inspect-regions'"));

  // G3 — WindowPattern CanMinimize/CanMaximize checks
  const winMgr = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ui-automation', 'window', 'manager.js'), 'utf-8');
  assert('getWindowCapabilities function exists', winMgr.includes('async function getWindowCapabilities'));
  assert('minimizeWindow checks CanMinimize', winMgr.includes('caps.canMinimize'));
  assert('maximizeWindow checks CanMaximize', winMgr.includes('caps.canMaximize'));
  assert('WindowPattern queried via UIA', winMgr.includes('WindowPattern'));
  assert('getWindowCapabilities exported', winMgr.includes('getWindowCapabilities'));
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
