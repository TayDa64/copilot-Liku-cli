#!/usr/bin/env node
/**
 * Test suite for v0.0.15 Cognitive Layer features
 * Validates Phase 0–4 from furtherAIadvancements.md
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`✅ PASS: ${label}`);
    passed++;
  } else {
    console.log(`❌ FAIL: ${label}`);
    failed++;
  }
}

// ═══════════════════════════════════════════════════════════
//  Phase 0 — Structured Home Directory
// ═══════════════════════════════════════════════════════════
console.log('\n--- Phase 0: Structured Home Directory ---\n');

const likuHome = require('../src/shared/liku-home');

assert(typeof likuHome.LIKU_HOME === 'string', 'LIKU_HOME is a string');
assert(likuHome.LIKU_HOME.endsWith('.liku'), 'LIKU_HOME points to ~/.liku');
assert(typeof likuHome.LIKU_HOME_OLD === 'string', 'LIKU_HOME_OLD is exported');
assert(likuHome.LIKU_HOME_OLD.endsWith('.liku-cli'), 'LIKU_HOME_OLD points to ~/.liku-cli');
assert(typeof likuHome.ensureLikuStructure === 'function', 'ensureLikuStructure is a function');
assert(typeof likuHome.migrateIfNeeded === 'function', 'migrateIfNeeded is a function');
assert(typeof likuHome.getLikuHome === 'function', 'getLikuHome is a function');
assert(likuHome.getLikuHome() === likuHome.LIKU_HOME, 'getLikuHome() returns LIKU_HOME');

// Verify directory structure was created
likuHome.ensureLikuStructure();
assert(fs.existsSync(likuHome.LIKU_HOME), '~/.liku/ directory exists');
assert(fs.existsSync(path.join(likuHome.LIKU_HOME, 'memory', 'notes')), 'memory/notes/ directory exists');
assert(fs.existsSync(path.join(likuHome.LIKU_HOME, 'skills')), 'skills/ directory exists');
assert(fs.existsSync(path.join(likuHome.LIKU_HOME, 'tools', 'dynamic')), 'tools/dynamic/ directory exists');
assert(fs.existsSync(path.join(likuHome.LIKU_HOME, 'telemetry', 'logs')), 'telemetry/logs/ directory exists');
assert(fs.existsSync(path.join(likuHome.LIKU_HOME, 'traces')), 'traces/ directory exists');

// ═══════════════════════════════════════════════════════════
//  Phase 0 — Preferences uses centralized LIKU_HOME
// ═══════════════════════════════════════════════════════════
console.log('\n--- Phase 0: Preferences Integration ---\n');

const prefsSrc = fs.readFileSync(path.join(__dirname, '../src/main/preferences.js'), 'utf-8');
assert(prefsSrc.includes("require('../shared/liku-home')"), 'preferences.js imports liku-home');
assert(!prefsSrc.includes("'.liku-cli'"), 'preferences.js no longer hardcodes .liku-cli');

// ═══════════════════════════════════════════════════════════
//  Phase 4 — Semantic Skill Router
// ═══════════════════════════════════════════════════════════
console.log('\n--- Phase 4: Semantic Skill Router ---\n');

const skillRouter = require('../src/main/memory/skill-router');

assert(typeof skillRouter.getRelevantSkillsContext === 'function', 'getRelevantSkillsContext is a function');
assert(typeof skillRouter.addSkill === 'function', 'addSkill is a function');
assert(typeof skillRouter.removeSkill === 'function', 'removeSkill is a function');
assert(typeof skillRouter.listSkills === 'function', 'listSkills is a function');

// Test empty state
assert(skillRouter.getRelevantSkillsContext('hello') === '', 'Empty skills returns empty string');

// Add a test skill
const testSkillContent = '# Navigate Browser Tabs\nUse ctrl+tab to switch tabs in Edge.';
skillRouter.addSkill('test-nav-tabs', {
  keywords: ['edge', 'browser', 'tab', 'navigate'],
  tags: ['automation', 'browser'],
  content: testSkillContent
});

const skills = skillRouter.listSkills();
assert(skills['test-nav-tabs'] !== undefined, 'Skill was registered in index');
assert(skills['test-nav-tabs'].keywords.includes('edge'), 'Skill keywords are stored');

// Test retrieval
const context = skillRouter.getRelevantSkillsContext('open a new tab in edge browser');
assert(context.includes('Navigate Browser Tabs'), 'Relevant skill is retrieved');
assert(context.includes('--- Relevant Skills ---'), 'Skills context has proper framing');

// Test non-matching query
const noMatch = skillRouter.getRelevantSkillsContext('what is the weather today');
assert(noMatch === '', 'Non-matching query returns empty string');

// Cleanup
skillRouter.removeSkill('test-nav-tabs');
const afterRemove = skillRouter.listSkills();
assert(afterRemove['test-nav-tabs'] === undefined, 'Skill was removed from index');

// ═══════════════════════════════════════════════════════════
//  Phase 1 — Agentic Memory (Memory Store + Linker)
// ═══════════════════════════════════════════════════════════
console.log('\n--- Phase 1: Agentic Memory ---\n');

const memoryStore = require('../src/main/memory/memory-store');
const memoryLinker = require('../src/main/memory/memory-linker');

assert(typeof memoryStore.addNote === 'function', 'addNote is a function');
assert(typeof memoryStore.updateNote === 'function', 'updateNote is a function');
assert(typeof memoryStore.removeNote === 'function', 'removeNote is a function');
assert(typeof memoryStore.getNote === 'function', 'getNote is a function');
assert(typeof memoryStore.getRelevantNotes === 'function', 'getRelevantNotes is a function');
assert(typeof memoryStore.getMemoryContext === 'function', 'getMemoryContext is a function');
assert(typeof memoryStore.listNotes === 'function', 'listNotes is a function');

// Add a test note
const note1 = memoryStore.addNote({
  type: 'episodic',
  content: 'Successfully clicked submit button in Edge browser',
  keywords: ['edge', 'browser', 'submit', 'click'],
  tags: ['automation', 'success'],
  source: { task: 'test', timestamp: new Date().toISOString(), outcome: 'success' }
});

assert(note1.id.startsWith('note-'), 'Note ID has correct prefix');
assert(note1.type === 'episodic', 'Note type is set correctly');
assert(note1.content.includes('submit button'), 'Note content is stored');
assert(Array.isArray(note1.links), 'Note has links array');

// Add a related note (should get linked)
const note2 = memoryStore.addNote({
  type: 'procedural',
  content: 'To submit forms in Edge, click the submit button or press Enter',
  keywords: ['edge', 'browser', 'submit', 'form'],
  tags: ['automation', 'procedure'],
});

assert(note2.links.includes(note1.id) || note1.links && note1.links.includes(note2.id),
  'Related notes are automatically linked');

// Test retrieval
const relevant = memoryStore.getRelevantNotes('click submit in edge browser');
assert(relevant.length > 0, 'Relevant notes are retrieved');
assert(relevant[0].content.includes('submit'), 'Most relevant note matches query');

// Test memory context formatting
const memCtx = memoryStore.getMemoryContext('edge browser submit');
assert(memCtx.includes('--- Memory Context ---'), 'Memory context has proper framing');
assert(memCtx.includes('--- End Memory ---'), 'Memory context has end marker');

// Test update (memory evolution)
const updated = memoryStore.updateNote(note1.id, {
  content: 'Successfully clicked submit button in Edge — works reliably'
});
assert(updated.content.includes('reliably'), 'Note content was updated');
assert(updated.updatedAt > note1.updatedAt, 'updatedAt was refreshed');

// Cleanup
memoryStore.removeNote(note1.id);
memoryStore.removeNote(note2.id);
const afterClean = memoryStore.listNotes();
assert(afterClean[note1.id] === undefined, 'Note 1 was removed');
assert(afterClean[note2.id] === undefined, 'Note 2 was removed');

// Test linker directly
assert(typeof memoryLinker.linkNote === 'function', 'linkNote is a function');
assert(typeof memoryLinker.overlapScore === 'function', 'overlapScore is a function');

const score = memoryLinker.overlapScore(
  { keywords: ['edge', 'browser'], tags: ['automation'] },
  { keywords: ['edge', 'tab'], tags: ['automation'] }
);
assert(score >= 3, 'overlapScore detects keyword+tag overlap');

// ═══════════════════════════════════════════════════════════
//  Phase 2 — RLVR Telemetry + Reflection
// ═══════════════════════════════════════════════════════════
console.log('\n--- Phase 2: Telemetry + Reflection ---\n');

const telemetry = require('../src/main/telemetry/telemetry-writer');
const reflection = require('../src/main/telemetry/reflection-trigger');
const phaseParams = require('../src/main/ai-service/providers/phase-params');

// Telemetry writer
assert(typeof telemetry.writeTelemetry === 'function', 'writeTelemetry is a function');
assert(typeof telemetry.readTelemetry === 'function', 'readTelemetry is a function');
assert(typeof telemetry.getRecentFailures === 'function', 'getRecentFailures is a function');

const record = telemetry.writeTelemetry({
  task: 'Test task',
  phase: 'execution',
  outcome: 'success',
  actions: [{ type: 'click', text: 'Submit' }]
});
assert(record !== null, 'Telemetry write returns record');
assert(record.taskId.startsWith('task-'), 'Record has task ID');
assert(record.outcome === 'success', 'Record outcome is correct');

// Verify today's log file exists
const todayLog = path.join(telemetry.TELEMETRY_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
assert(fs.existsSync(todayLog), 'Today JSONL log file was created');

const entries = telemetry.readTelemetry();
assert(entries.length > 0, 'Telemetry entries can be read back');

// Phase params
assert(typeof phaseParams.getPhaseParams === 'function', 'getPhaseParams is a function');
assert(typeof phaseParams.PHASE_PARAMS === 'object', 'PHASE_PARAMS is exported');

const execParams = phaseParams.getPhaseParams('execution');
assert(execParams.temperature === 0.1, 'Execution phase has low temperature');

const reflectParams = phaseParams.getPhaseParams('reflection');
assert(reflectParams.temperature === 0.7, 'Reflection phase has higher temperature');

// Reasoning model stripping
const reasoningParams = phaseParams.getPhaseParams('execution', { reasoning: true });
assert(reasoningParams.temperature === undefined, 'Reasoning model strips temperature');
assert(reasoningParams.top_p === undefined, 'Reasoning model strips top_p');

// Reflection trigger
assert(typeof reflection.evaluateOutcome === 'function', 'evaluateOutcome is a function');
assert(typeof reflection.buildReflectionPrompt === 'function', 'buildReflectionPrompt is a function');
assert(typeof reflection.applyReflectionResult === 'function', 'applyReflectionResult is a function');

reflection.resetSession();
const eval1 = reflection.evaluateOutcome({
  task: 'click button', phase: 'execution', outcome: 'failure'
});
assert(eval1.shouldReflect === false, 'First failure does not trigger reflection');

const eval2 = reflection.evaluateOutcome({
  task: 'click button', phase: 'execution', outcome: 'failure'
});
assert(eval2.shouldReflect === true, 'Second consecutive failure triggers reflection');
assert(eval2.reason.includes('consecutive'), 'Reason mentions consecutive failures');

// Test reflection prompt building
const prompt = reflection.buildReflectionPrompt(eval2.failures);
assert(prompt.includes('Reflection Agent'), 'Reflection prompt mentions agent role');
assert(prompt.includes('rootCause'), 'Reflection prompt requests rootCause');

// Test reflection result application
const reflResult = reflection.applyReflectionResult(JSON.stringify({
  rootCause: 'Button was not visible',
  recommendation: 'memory_note',
  details: {
    noteContent: 'Submit button sometimes loads late — add wait step',
    keywords: ['submit', 'button', 'wait']
  }
}));
assert(reflResult.applied === true, 'Reflection result was applied');
assert(reflResult.action === 'memory_note', 'Reflection created a memory note');

// Cleanup the reflection-created note
const allNotes = memoryStore.listNotes();
for (const id of Object.keys(allNotes)) {
  memoryStore.removeNote(id);
}

// ═══════════════════════════════════════════════════════════
//  Phase 3 — Dynamic Tool System
// ═══════════════════════════════════════════════════════════
console.log('\n--- Phase 3: Dynamic Tool System ---\n');

const sandbox = require('../src/main/tools/sandbox');
const toolValidator = require('../src/main/tools/tool-validator');
const toolRegistry = require('../src/main/tools/tool-registry');

// Tool validator
assert(typeof toolValidator.validateToolSource === 'function', 'validateToolSource is a function');
assert(toolValidator.BANNED_PATTERNS.length > 10, 'Has comprehensive banned patterns');

const safeCode = 'result = args.a + args.b;';
const safeResult = toolValidator.validateToolSource(safeCode);
assert(safeResult.valid === true, 'Safe code passes validation');

const unsafeCode = 'const fs = require("fs"); result = fs.readFileSync("/etc/passwd");';
const unsafeResult = toolValidator.validateToolSource(unsafeCode);
assert(unsafeResult.valid === false, 'Unsafe code fails validation');
assert(unsafeResult.violations.includes('require()'), 'Detects require() pattern');

const evalCode = 'eval("alert(1)")';
const evalResult = toolValidator.validateToolSource(evalCode);
assert(evalResult.valid === false, 'eval() code fails validation');

// Sandbox execution (async — child_process.fork returns a Promise)
assert(typeof sandbox.executeDynamicTool === 'function', 'executeDynamicTool is a function');

// Write a test tool and execute it
const testToolDir = path.join(likuHome.LIKU_HOME, 'tools', 'dynamic');
if (!fs.existsSync(testToolDir)) fs.mkdirSync(testToolDir, { recursive: true });
const testToolPath = path.join(testToolDir, 'test-add.js');
fs.writeFileSync(testToolPath, 'result = args.a + args.b;');

// Async sandbox tests — run after sync tests complete
async function runAsyncSandboxTests() {
  const execResult = await sandbox.executeDynamicTool(testToolPath, { a: 3, b: 7 });
  assert(execResult.success === true, 'Sandbox executes safe tool successfully');
  assert(execResult.result === 10, 'Sandbox returns correct result');

  // Test timeout protection
  const infiniteToolPath = path.join(testToolDir, 'test-infinite.js');
  fs.writeFileSync(infiniteToolPath, 'while(true) {}');
  const timeoutResult = await sandbox.executeDynamicTool(infiniteToolPath, {});
  assert(timeoutResult.success === false, 'Infinite loop tool fails');
  assert(timeoutResult.error && (timeoutResult.error.includes('timed out') || timeoutResult.error.includes('timeout') || timeoutResult.error.includes('Timeout')),
    'Timeout error message is descriptive');

  // Cleanup test tool files
  try { fs.unlinkSync(testToolPath); } catch {}
  try { fs.unlinkSync(infiniteToolPath); } catch {}
}

// Tool registry
assert(typeof toolRegistry.registerTool === 'function', 'registerTool is a function');
assert(typeof toolRegistry.lookupTool === 'function', 'lookupTool is a function');
assert(typeof toolRegistry.getDynamicToolDefinitions === 'function', 'getDynamicToolDefinitions is a function');

const regResult = toolRegistry.registerTool('test-calculator', {
  code: 'result = args.a * args.b;',
  description: 'Multiply two numbers',
  parameters: { a: 'number', b: 'number' }
});
assert(regResult.success === true, 'Tool registration succeeds');

const lookup = toolRegistry.lookupTool('test-calculator');
assert(lookup !== null, 'Registered tool can be looked up');
assert(lookup.entry.description === 'Multiply two numbers', 'Tool description is stored');

const defs = toolRegistry.getDynamicToolDefinitions();
assert(defs.length === 0, 'Unapproved tool excluded from definitions');

// Test approval gate (Phase 3b)
assert(lookup.entry.approved === false, 'Newly registered tool is unapproved by default');
const approveResult = toolRegistry.approveTool('test-calculator');
assert(approveResult.success === true, 'approveTool returns success');

// After approval, definitions should include the tool
const defsAfterApprove = toolRegistry.getDynamicToolDefinitions();
assert(defsAfterApprove.length > 0, 'Approved tool appears in definitions');
assert(defsAfterApprove[0].function.name === 'dynamic_test-calculator', 'Tool name has dynamic_ prefix');

const approvedLookup = toolRegistry.lookupTool('test-calculator');
assert(approvedLookup.entry.approved === true, 'Tool is approved after approveTool()');
assert(typeof approvedLookup.entry.approvedAt === 'string', 'approvedAt timestamp is set');
const revokeResult = toolRegistry.revokeTool('test-calculator');
assert(revokeResult.success === true, 'revokeTool returns success');
assert(toolRegistry.lookupTool('test-calculator').entry.approved === false, 'Tool is unapproved after revokeTool()');

// Cleanup
toolRegistry.unregisterTool('test-calculator', true);
assert(toolRegistry.lookupTool('test-calculator') === null, 'Tool was unregistered');

// NOTE: test tool file cleanup happens in runAsyncSandboxTests() to avoid race

// ═══════════════════════════════════════════════════════════
//  Phase 2b: Reflection Loop Wiring
// ═══════════════════════════════════════════════════════════
console.log('\n--- Phase 2b: Reflection Loop Wiring ---\n');

const reflectionTrigger = require('../src/main/telemetry/reflection-trigger');

assert(typeof reflectionTrigger.evaluateOutcome === 'function', 'evaluateOutcome is available for wiring');
assert(typeof reflectionTrigger.buildReflectionPrompt === 'function', 'buildReflectionPrompt is available for wiring');
assert(typeof reflectionTrigger.applyReflectionResult === 'function', 'applyReflectionResult is available for wiring');
assert(typeof reflectionTrigger.resetSession === 'function', 'resetSession is available');

// Verify reflection trigger is wired into ai-service (imported)
const aiServiceSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'), 'utf-8');
assert(aiServiceSource.includes("require('./telemetry/reflection-trigger')"), 'ai-service.js imports reflection-trigger');
assert(aiServiceSource.includes('reflectionTrigger.evaluateOutcome'), 'ai-service.js calls evaluateOutcome');
assert(aiServiceSource.includes('reflectionTrigger.buildReflectionPrompt'), 'ai-service.js calls buildReflectionPrompt');
assert(aiServiceSource.includes('reflectionTrigger.applyReflectionResult'), 'ai-service.js calls applyReflectionResult');
assert(aiServiceSource.includes('reflectionApplied'), 'executeActions returns reflectionApplied field');

// Verify episodic memory write is wired into executeActions
assert(aiServiceSource.includes("memoryStore.addNote") && aiServiceSource.includes("type: 'episodic'"), 'executeActions writes episodic memory notes');
assert(aiServiceSource.includes("tags: ['execution'"), 'Episodic notes are tagged with execution');

// Verify extractKeywords utility
assert(aiServiceSource.includes('function extractKeywords'), 'extractKeywords helper exists');

// ═══════════════════════════════════════════════════════════
//  Phase 3b: Dynamic Tool Approval Gate
// ═══════════════════════════════════════════════════════════
console.log('\n--- Phase 3b: Dynamic Tool Approval Gate ---\n');

const sysAutoSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'system-automation.js'), 'utf-8');
assert(sysAutoSource.includes('lookup.entry.approved'), 'system-automation checks approval before sandbox execution');
assert(sysAutoSource.includes('lookup.absolutePath'), 'system-automation uses correct absolutePath property');
assert(typeof toolRegistry.approveTool === 'function', 'approveTool is exported from tool-registry');
assert(typeof toolRegistry.revokeTool === 'function', 'revokeTool is exported from tool-registry');

// ═══════════════════════════════════════════════════════════
//  Phase 5 — Deeper Integration (Reasoning Model + Slash Commands + Telemetry)
// ═══════════════════════════════════════════════════════════
console.log('\n--- Phase 5: Deeper Integration ---\n');

const aiService = require('../src/main/ai-service');

// 5a. Reasoning model temperature stripping in makeRequestBody
{
  const aiSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'), 'utf8');
  assert(aiSrc.includes("supportsCopilotCapability(activeModelKey, 'reasoning')"), 'makeRequestBody checks for reasoning model capability');
  assert(aiSrc.includes('if (!isReasoningModel)'), 'Temperature is conditionally omitted for reasoning models');
}

// 5b. System prompt cognitive awareness
{
  const systemPromptSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'system-prompt.js'), 'utf8');
  assert(systemPromptSrc.includes('Long-Term Memory'), 'System prompt mentions Long-Term Memory');
  assert(systemPromptSrc.includes('Skills Library'), 'System prompt mentions Skills Library');
  assert(systemPromptSrc.includes('Dynamic Tools'), 'System prompt mentions Dynamic Tools');
  assert(systemPromptSrc.includes('Cognitive Awareness'), 'System prompt has Cognitive Awareness section');
  assert(systemPromptSrc.includes('Memory Context'), 'System prompt describes Memory Context injection');
  assert(systemPromptSrc.includes('Relevant Skills'), 'System prompt describes Relevant Skills injection');
  assert(systemPromptSrc.includes('Reflection'), 'System prompt describes Reflection mechanism');
}

// 5c. Slash commands exist
{
  assert(typeof aiService.handleCommand === 'function', 'handleCommand is available');

  const memoryResult = aiService.handleCommand('/memory');
  assert(memoryResult !== null && memoryResult.type === 'info', '/memory command returns info response');

  const skillsResult = aiService.handleCommand('/skills');
  assert(skillsResult !== null && skillsResult.type === 'info', '/skills command returns info response');

  const toolsResult = aiService.handleCommand('/tools');
  assert(toolsResult !== null && toolsResult.type === 'info', '/tools command returns info response');

  const helpResult = aiService.handleCommand('/help');
  assert(helpResult.message.includes('/memory'), '/help lists /memory command');
  assert(helpResult.message.includes('/skills'), '/help lists /skills command');
  assert(helpResult.message.includes('/tools'), '/help lists /tools command');
}

// 5d. recordAutoRunOutcome writes telemetry
{
  const prefSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preferences.js'), 'utf8');
  assert(prefSrc.includes("require('./telemetry/telemetry-writer')"), 'preferences.js imports telemetry-writer');
  assert(prefSrc.includes("event: 'auto_run_outcome'"), 'recordAutoRunOutcome writes auto_run_outcome telemetry');
}

// 5e. Reflection negative_policy writes to preferences
{
  const reflSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'telemetry', 'reflection-trigger.js'), 'utf8');
  assert(reflSrc.includes("require('../preferences')"), 'reflection-trigger imports preferences');
  assert(reflSrc.includes('mergeAppPolicy'), 'negative_policy calls mergeAppPolicy');
  assert(reflSrc.includes("action: 'negative_policy_applied'"), 'negative_policy returns applied status');
  assert(reflSrc.includes("source: 'reflection'"), 'Policy records reflection as source');
}

// ═══════════════════════════════════════════════════════════
//  Phase 6 — Safety Hardening (PreToolUse Hook, Reflection Cap, Failure Decay,
//            Phase Execution, LRU Pruning, Log Rotation, Provider Phase Params)
// ═══════════════════════════════════════════════════════════
console.log('\n--- Phase 6: Safety Hardening ---\n');

// 6a. PreToolUse hook runner module
{
  const hookRunner = require('../src/main/tools/hook-runner');
  assert(typeof hookRunner.runPreToolUseHook === 'function', 'runPreToolUseHook is exported');
  assert(typeof hookRunner.loadHooksConfig === 'function', 'loadHooksConfig is exported');

  // Loading config should succeed
  const config = hookRunner.loadHooksConfig();
  assert(config !== null, 'hooks config loads successfully');
  assert(config.hooks && config.hooks.PreToolUse, 'PreToolUse hook is defined in config');
  assert(Array.isArray(config.hooks.PreToolUse), 'PreToolUse is an array');
}

// 6b. PreToolUse hook wiring in system-automation
{
  const sysSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'system-automation.js'), 'utf8');
  assert(sysSrc.includes("require('./tools/hook-runner')"), 'system-automation imports hook-runner');
  assert(sysSrc.includes('runPreToolUseHook'), 'system-automation calls runPreToolUseHook');
  assert(sysSrc.includes('hookResult.denied'), 'system-automation checks hook denial');
  assert(sysSrc.includes("denied by PreToolUse hook"), 'system-automation throws on hook denial');
}

// 6c. Bounded reflection loop (max 2 iterations)
{
  const aiSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'), 'utf8');
  assert(aiSrc.includes('MAX_REFLECTION_ITERATIONS = 2'), 'MAX_REFLECTION_ITERATIONS is 2');
  assert(aiSrc.includes('reflectionIteration < MAX_REFLECTION_ITERATIONS'), 'Reflection loop is bounded');
  assert(aiSrc.includes('reflectionIteration++'), 'Reflection tracks iteration count');
  assert(aiSrc.includes('Reflection exhausted after'), 'Exhaustion warning is logged');
}

// 6d. Session failure count decay on success
{
  const reflSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'telemetry', 'reflection-trigger.js'), 'utf8');
  assert(reflSrc.includes('consecutiveFailCount = 0'), 'consecutiveFailCount resets on success');
  assert(reflSrc.includes('sessionFailureCount - 1'), 'sessionFailureCount decays on success');
  assert(reflSrc.includes('Math.max(0,'), 'Session failure count never goes negative');
}

// 6e. Phase execution in sendMessage
{
  const aiSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'), 'utf8');
  assert(aiSrc.includes("phase: 'execution'"), 'sendMessage passes phase:execution to provider');
}

// 6f. Memory LRU pruning
{
  const memStore = require('../src/main/memory/memory-store');
  assert(typeof memStore.pruneOldNotes === 'function', 'pruneOldNotes is exported');
  assert(memStore.MAX_NOTES === 500, 'MAX_NOTES is 500');

  const memSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'memory', 'memory-store.js'), 'utf8');
  assert(memSrc.includes('pruneOldNotes()'), 'addNote calls pruneOldNotes');
  assert(memSrc.includes('noteIds.length <= MAX_NOTES'), 'pruneOldNotes checks against MAX_NOTES');
}

// 6g. Telemetry log rotation
{
  const telemetry = require('../src/main/telemetry/telemetry-writer');
  assert(telemetry.MAX_LOG_SIZE === 10 * 1024 * 1024, 'MAX_LOG_SIZE is 10MB');

  const telSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'telemetry', 'telemetry-writer.js'), 'utf8');
  assert(telSrc.includes('MAX_LOG_SIZE'), 'telemetry-writer defines MAX_LOG_SIZE');
  assert(telSrc.includes('.rotated-'), 'Log rotation renames to .rotated-');
  assert(telSrc.includes('stats.size >= MAX_LOG_SIZE'), 'Size check triggers rotation');
}

// 6h. Phase params for all providers
{
  const orchSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'providers', 'orchestration.js'), 'utf8');
  assert(orchSrc.includes('callOpenAI(messages, requestOptions)'), 'callProvider passes requestOptions to OpenAI');
  assert(orchSrc.includes('callAnthropic(messages, requestOptions)'), 'callProvider passes requestOptions to Anthropic');
  assert(orchSrc.includes('callOllama(messages, requestOptions)'), 'callProvider passes requestOptions to Ollama');

  const aiSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'), 'utf8');
  assert(aiSrc.includes('function callOpenAI(messages, requestOptions)'), 'callOpenAI accepts requestOptions');
  assert(aiSrc.includes('function callAnthropic(messages, requestOptions)'), 'callAnthropic accepts requestOptions');
  assert(aiSrc.includes('function callOllama(messages, requestOptions)'), 'callOllama accepts requestOptions');
  assert(aiSrc.includes('requestOptions.temperature'), 'Provider functions use requestOptions.temperature');
}

// 6i. Reflection trigger functional test — success decays sessionFailureCount
{
  const reflectionTrigger = require('../src/main/telemetry/reflection-trigger');
  reflectionTrigger.resetSession();

  // Pump 2 failures to set sessionFailureCount = 2
  reflectionTrigger.evaluateOutcome({ task: 'test-decay', phase: 'execution', outcome: 'failure' });
  reflectionTrigger.evaluateOutcome({ task: 'test-decay-2', phase: 'execution', outcome: 'failure' });

  // Success should decay sessionFailureCount
  const successResult = reflectionTrigger.evaluateOutcome({ task: 'test-decay-3', phase: 'execution', outcome: 'success' });
  assert(successResult.shouldReflect === false, 'Success returns shouldReflect=false');
  assert(successResult.reason === 'success', 'Success reason is "success"');

  // Another success should further decay
  reflectionTrigger.evaluateOutcome({ task: 'test-decay-4', phase: 'execution', outcome: 'success' });

  // Now only 0 session failures — 3 more failures needed to trigger session threshold
  const f1 = reflectionTrigger.evaluateOutcome({ task: 'new-task', phase: 'execution', outcome: 'failure' });
  assert(f1.shouldReflect === false, 'First failure after decay does not trigger reflection');

  reflectionTrigger.resetSession();
}

// ═══════════════════════════════════════════════════════════
//  Phase 7: Next-Level Enhancements
// ═══════════════════════════════════════════════════════════
console.log('\n--- Phase 7: Next-Level Enhancements ---\n');

// == AWM procedural memory extraction ==
// Verify ai-service.js has AWM extraction in the success path
const aiServiceSourceP7 = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'), 'utf-8');
assert(aiServiceSourceP7.includes('MIN_STEPS_FOR_PROCEDURE'), 'AWM: MIN_STEPS_FOR_PROCEDURE constant defined');
assert(aiServiceSourceP7.includes("type: 'procedural'"), 'AWM: procedural memory note written on success');
assert(aiServiceSourceP7.includes("tags: ['procedure', 'awm', 'success']"), 'AWM: procedure notes tagged with awm');
assert(aiServiceSourceP7.includes('skillRouter.addSkill(skillId'), 'AWM: auto-registers as skill');
assert(aiServiceSourceP7.includes("awm-extraction"), 'AWM: source type is awm-extraction');

// == PostToolUse hook ==
const hookRunnerP7 = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'tools', 'hook-runner.js'), 'utf-8');
assert(hookRunnerP7.includes('runPostToolUseHook'), 'PostToolUse: function defined in hook-runner');
assert(hookRunnerP7.includes('PostToolUse'), 'PostToolUse: reads PostToolUse from config');
assert(hookRunnerP7.includes('resultType'), 'PostToolUse: passes resultType in hook input');
assert(hookRunnerP7.includes('COPILOT_HOOK_INPUT_PATH'), 'PostToolUse: sets env var');

// Verify hook-runner exports runPostToolUseHook
const hookRunner = require('../src/main/tools/hook-runner');
assert(typeof hookRunner.runPostToolUseHook === 'function', 'PostToolUse: runPostToolUseHook exported');
assert(typeof hookRunner.runPreToolUseHook === 'function', 'PostToolUse: runPreToolUseHook still exported');
assert(typeof hookRunner.loadHooksConfig === 'function', 'PostToolUse: loadHooksConfig still exported');

// Verify PostToolUse wired into system-automation dynamic_tool case
const sysAutoP7 = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'system-automation.js'), 'utf-8');
assert(sysAutoP7.includes('runPostToolUseHook'), 'PostToolUse: wired into system-automation');
assert(sysAutoP7.includes('runPostToolUseHook(`dynamic_'), 'PostToolUse: called with dynamic_ prefix');

// Verify audit-log.ps1 supports COPILOT_HOOK_INPUT_PATH
const auditLogPs1 = fs.readFileSync(path.join(__dirname, '..', '.github', 'hooks', 'scripts', 'audit-log.ps1'), 'utf-8');
assert(auditLogPs1.includes('COPILOT_HOOK_INPUT_PATH'), 'PostToolUse: audit-log.ps1 supports file-based input');
assert(auditLogPs1.includes('[Console]::In.ReadToEnd()'), 'PostToolUse: audit-log.ps1 still supports stdin');

// == Filter unapproved dynamic tools ==
const toolRegistrySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'tools', 'tool-registry.js'), 'utf-8');
assert(toolRegistrySource.includes('entry.approved'), 'ToolRegistry: getDynamicToolDefinitions filters by approved');
// Functional test: register unapproved tool, verify it's excluded from definitions
const toolRegistryP7 = require('../src/main/tools/tool-registry');

// == CLI subcommands ==
const cliSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli', 'liku.js'), 'utf-8');
assert(cliSource.includes("memory:"), 'CLI: memory command registered');
assert(cliSource.includes("skills:"), 'CLI: skills command registered');
assert(cliSource.includes("tools:"), 'CLI: tools command registered');

// Verify CLI command modules exist and export run()
const cliMemory = require('../src/cli/commands/memory');
assert(typeof cliMemory.run === 'function', 'CLI: memory command exports run()');
const cliSkills = require('../src/cli/commands/skills');
assert(typeof cliSkills.run === 'function', 'CLI: skills command exports run()');
const cliTools = require('../src/cli/commands/tools');
assert(typeof cliTools.run === 'function', 'CLI: tools command exports run()');

// == Telemetry summary analytics ==
const telemetryWriter = require('../src/main/telemetry/telemetry-writer');
assert(typeof telemetryWriter.getTelemetrySummary === 'function', 'Telemetry: getTelemetrySummary exported');

// Functional test: call with no data, verify structure
const emptySummary = telemetryWriter.getTelemetrySummary('1970-01-01');
assert(emptySummary.total === 0, 'Telemetry summary: empty date returns total=0');
assert(emptySummary.successes === 0, 'Telemetry summary: empty date returns successes=0');
assert(emptySummary.successRate === 0, 'Telemetry summary: empty date returns successRate=0');
assert(typeof emptySummary.byAction === 'object', 'Telemetry summary: byAction is object');
assert(Array.isArray(emptySummary.topFailures), 'Telemetry summary: topFailures is array');

// ═══════════════════════════════════════════════════════════
//  Phase 8: Audit-Driven Fixes (Telemetry Schema, Staleness,
//           Hook Wiring, Word-Boundary Scoring, Comment Fix)
// ═══════════════════════════════════════════════════════════
console.log('\n--- Phase 8: Audit-Driven Fixes ---\n');

// 8a. recordAutoRunOutcome telemetry schema fix
{
  const prefSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preferences.js'), 'utf8');
  assert(prefSrc.includes("task: `auto_run:"), 'recordAutoRunOutcome uses task: field');
  assert(prefSrc.includes("phase: 'execution'"), 'recordAutoRunOutcome uses phase: field');
  assert(prefSrc.includes("outcome: success ? 'success' : 'failure'"), 'recordAutoRunOutcome maps to outcome: field');
  assert(prefSrc.includes('context: {'), 'recordAutoRunOutcome puts extras in context: field');
}

// 8b. Skill index staleness pruning
{
  const routerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'memory', 'skill-router.js'), 'utf8');
  assert(routerSrc.includes('Pruned stale skill'), 'loadIndex prunes stale skill entries');
  assert(routerSrc.includes('!fs.existsSync(skillPath)'), 'Staleness check uses fs.existsSync');
}

// 8c. Skill scoring uses word-boundary regex
{
  const routerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'memory', 'skill-router.js'), 'utf8');
  assert(routerSrc.includes('new RegExp(`\\\\b${escaped}\\\\b`)'), 'Keyword scoring uses word-boundary regex');
  // Functional test: substring should NOT match when not a whole word
  const skillRouter = require('../src/main/memory/skill-router');
  const testSkillId = `test-wordboundary-${Date.now()}`;
  skillRouter.addSkill(testSkillId, {
    keywords: ['click'],
    tags: ['test'],
    content: '# Test word boundary matching'
  });
  // "click" should match "click the button" but not "clicker game"
  const matchResult = skillRouter.getRelevantSkillsContext('click the button');
  assert(matchResult.includes(testSkillId) || matchResult.includes('word boundary'), 'Whole word "click" matches in relevant context');
  const noMatchResult = skillRouter.getRelevantSkillsContext('autoclicker game');
  assert(!noMatchResult.includes(testSkillId), 'Substring "click" in "autoclicker" does NOT match');
  skillRouter.removeSkill(testSkillId);
}

// 8d. PreToolUse hook wired for AWM skill creation
{
  const aiSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'), 'utf8');
  assert(aiSrc.includes("runPreToolUseHook('awm_create_skill'"), 'PreToolUse gate before AWM skill creation');
  assert(aiSrc.includes('hookGate.denied'), 'AWM checks if hook denies skill creation');
}

// 8e. PostToolUse hook wired for reflection passes
{
  const aiSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'), 'utf8');
  assert(aiSrc.includes("runPostToolUseHook('reflection_pass'"), 'PostToolUse after reflection pass');
  assert(aiSrc.includes('iteration: reflectionIteration'), 'Reflection PostToolUse includes iteration info');
}

// 8f. hook-runner imported in ai-service
{
  const aiSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'), 'utf8');
  assert(aiSrc.includes("require('./tools/hook-runner')"), 'ai-service imports hook-runner');
}

// 8g. Trace-writer comment references ~/.liku/ (not ~/.liku-cli/)
{
  const twSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'agents', 'trace-writer.js'), 'utf8');
  assert(twSrc.includes('~/.liku/traces/'), 'trace-writer comment references ~/.liku/ path');
  assert(!twSrc.includes('~/.liku-cli/traces/'), 'trace-writer does NOT reference stale ~/.liku-cli/ path');
}

// ═══════════════════════════════════════════════════════════
//  Phase 9 — Design-Level Hardening (Gemini brainstorm items)
// ═══════════════════════════════════════════════════════════
console.log('\n--- Phase 9: Design-Level Hardening ---\n');

// 9a. Token counter module — BPE tokenization
{
  const tc = require(path.join(__dirname, '..', 'src', 'shared', 'token-counter'));
  assert(typeof tc.countTokens === 'function', 'token-counter exports countTokens()');
  assert(typeof tc.truncateToTokenBudget === 'function', 'token-counter exports truncateToTokenBudget()');
  assert(tc.countTokens('hello world') > 0, 'countTokens returns positive number');
  assert(tc.countTokens('hello world') === 2, 'countTokens("hello world") = 2 BPE tokens');
  const longText = 'word '.repeat(100);
  const truncated = tc.truncateToTokenBudget(longText, 10);
  assert(tc.countTokens(truncated) <= 10, 'truncateToTokenBudget respects budget');
}

// 9b. memory-store uses token counting (not character heuristics)
{
  const msSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'memory', 'memory-store.js'), 'utf8');
  assert(msSrc.includes("require('../../shared/token-counter')"), 'memory-store imports token-counter');
  assert(msSrc.includes('countTokens('), 'memory-store calls countTokens()');
}

// 9c. skill-router uses token counting (not character heuristics)
{
  const srSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'memory', 'skill-router.js'), 'utf8');
  assert(srSrc.includes("require('../../shared/token-counter')"), 'skill-router imports token-counter');
  assert(srSrc.includes('truncateToTokenBudget('), 'skill-router calls truncateToTokenBudget()');
}

// 9d. Proposal flow — proposeTool / promoteTool / rejectTool / listProposals
{
  const reg = require(path.join(__dirname, '..', 'src', 'main', 'tools', 'tool-registry'));
  assert(typeof reg.proposeTool === 'function', 'tool-registry exports proposeTool()');
  assert(typeof reg.promoteTool === 'function', 'tool-registry exports promoteTool()');
  assert(typeof reg.rejectTool === 'function', 'tool-registry exports rejectTool()');
  assert(typeof reg.listProposals === 'function', 'tool-registry exports listProposals()');
  assert(typeof reg.PROPOSED_DIR === 'string', 'tool-registry exports PROPOSED_DIR path');
  assert(reg.PROPOSED_DIR.endsWith('proposed'), 'PROPOSED_DIR ends with "proposed"');
}

// 9e. liku-home includes tools/proposed directory
{
  const lhSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'liku-home.js'), 'utf8');
  assert(lhSrc.includes("'tools/proposed'"), 'liku-home creates tools/proposed dir');
}

// 9f. Sandbox uses child_process.fork (process-level isolation)
{
  const sbSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'tools', 'sandbox.js'), 'utf8');
  assert(sbSrc.includes("require('child_process')"), 'sandbox imports child_process');
  assert(sbSrc.includes('fork('), 'sandbox uses fork() for isolation');
  assert(!sbSrc.includes('vm.createContext'), 'sandbox does NOT use in-process vm.createContext');
}

// 9g. sandbox-worker.js exists and uses IPC
{
  const workerPath = path.join(__dirname, '..', 'src', 'main', 'tools', 'sandbox-worker.js');
  assert(fs.existsSync(workerPath), 'sandbox-worker.js exists');
  const wSrc = fs.readFileSync(workerPath, 'utf8');
  assert(wSrc.includes("process.on('message'"), 'worker listens on IPC message');
  assert(wSrc.includes("process.send("), 'worker sends result via IPC');
}

// 9h. message-builder accepts skillsContext/memoryContext params
{
  const mbSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'message-builder.js'), 'utf8');
  assert(mbSrc.includes('skillsContext'), 'message-builder has skillsContext param');
  assert(mbSrc.includes('memoryContext'), 'message-builder has memoryContext param');
  assert(mbSrc.includes('## Relevant Skills'), 'message-builder uses dedicated skills header');
  assert(mbSrc.includes('## Working Memory'), 'message-builder uses dedicated memory header');
}

// 9i. ai-service passes skills/memory as named params
{
  const aiSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'), 'utf8');
  assert(aiSrc.includes('skillsContext: skillsContextText'), 'ai-service passes skillsContext explicitly');
  assert(aiSrc.includes('memoryContext: memoryContextText'), 'ai-service passes memoryContext explicitly');
}

// 9j. CLI tools command supports proposals/reject subcommands
{
  const toolsCLI = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli', 'commands', 'tools.js'), 'utf8');
  assert(toolsCLI.includes("case 'proposals':"), 'tools CLI has proposals subcommand');
  assert(toolsCLI.includes("case 'reject':"), 'tools CLI has reject subcommand');
  assert(toolsCLI.includes('listProposals'), 'tools CLI calls listProposals');
  assert(toolsCLI.includes('rejectTool'), 'tools CLI calls rejectTool');
}

// 9k. sandbox executeDynamicTool is now awaited (async)
{
  const saSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'system-automation.js'), 'utf8');
  assert(saSrc.includes('await sandbox.executeDynamicTool'), 'system-automation awaits sandbox.executeDynamicTool');
}

// 9l. sandbox drops env vars for security
{
  const sbSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'tools', 'sandbox.js'), 'utf8');
  assert(sbSrc.includes("NODE_ENV: 'sandbox'"), 'sandbox worker runs with minimal env');
}

// ═══════════════════════════════════════════════════════════
//  Phase 10 — N3: End-to-End Dynamic Tool Smoke Test
// ═══════════════════════════════════════════════════════════
console.log('\n--- Phase 10: E2E Dynamic Tool Pipeline (N3) ---\n');

// 10a-10h run as async tests because sandbox uses child_process.fork
async function runE2ESmokeTests() {
  const toolRegistry = require('../src/main/tools/tool-registry');
  const sandbox = require('../src/main/tools/sandbox');
  const telemetryWriter = require('../src/main/telemetry/telemetry-writer');

  // 10a. Clean up any leftover test tool from previous runs
  try { toolRegistry.unregisterTool('e2e-fibonacci', true); } catch {}

  // 10b. Propose a Fibonacci tool (quarantine)
  const fibCode = `
    function fib(n) { return n <= 1 ? n : fib(n - 1) + fib(n - 2); }
    result = fib(args.n || 10);
  `;
  const proposal = toolRegistry.proposeTool('e2e-fibonacci', {
    code: fibCode,
    description: 'Calculate Fibonacci number',
    parameters: { n: 'number' }
  });
  assert(proposal.success === true, '10a. proposeTool succeeds');
  assert(proposal.proposalPath && proposal.proposalPath.includes('proposed'), '10b. tool is in proposed/ quarantine');

  // 10c. Tool is visible in proposals
  const proposals = toolRegistry.listProposals();
  assert(proposals['e2e-fibonacci'] !== undefined, '10c. tool appears in listProposals');
  assert(proposals['e2e-fibonacci'].status === 'proposed', '10c. tool status is proposed');

  // 10d. Tool lookup resolves but is NOT approved
  const beforeApproval = toolRegistry.lookupTool('e2e-fibonacci');
  assert(beforeApproval !== null, '10d. lookupTool finds proposed tool');
  assert(beforeApproval.entry.approved === false, '10d. tool is not yet approved');

  // 10e. Approve (promote from proposed/ to dynamic/)
  const approveResult = toolRegistry.approveTool('e2e-fibonacci');
  assert(approveResult.success === true, '10e. approveTool succeeds');

  // 10f. After approval, tool is in dynamic/ and approved
  const afterApproval = toolRegistry.lookupTool('e2e-fibonacci');
  assert(afterApproval.entry.approved === true, '10f. tool is approved after promotion');
  assert(afterApproval.entry.status === 'active', '10f. tool status is active');
  assert(afterApproval.absolutePath.includes('dynamic'), '10f. tool file is in dynamic/ directory');
  assert(fs.existsSync(afterApproval.absolutePath), '10f. tool file exists on disk');

  // 10g. Execute in sandbox (child_process.fork → vm.Script → IPC result)
  const execResult = await sandbox.executeDynamicTool(afterApproval.absolutePath, { n: 10 });
  assert(execResult.success === true, '10g. sandbox execution succeeds');
  assert(execResult.result === 55, '10g. Fibonacci(10) = 55 (correct result)');

  // 10h. Record invocation + write telemetry, verify telemetry exists
  toolRegistry.recordInvocation('e2e-fibonacci');
  const afterExec = toolRegistry.lookupTool('e2e-fibonacci');
  assert(afterExec.entry.invocations >= 1, '10h. invocation count incremented');

  telemetryWriter.writeTelemetry({
    task: 'e2e-fibonacci-test',
    phase: 'execution',
    outcome: 'success',
    context: { event: 'e2e_smoke_test', result: 55 }
  });
  const todayEntries = telemetryWriter.readTelemetry();
  const fibEntry = todayEntries.find(e => e.task === 'e2e-fibonacci-test');
  assert(fibEntry !== undefined, '10h. telemetry entry written for E2E test');
  assert(fibEntry.outcome === 'success', '10h. telemetry outcome is success');

  // 10i. Clean up
  toolRegistry.unregisterTool('e2e-fibonacci', true);
  assert(toolRegistry.lookupTool('e2e-fibonacci') === null, '10i. tool cleaned up after E2E test');
}

// ═══════════════════════════════════════════════════════════
//  Phase 11 — N1-T2: TF-IDF Skill Routing
// ═══════════════════════════════════════════════════════════
console.log('\n--- Phase 11: TF-IDF Skill Routing (N1-T2) ---\n');

// 11a. tokenize
const tfidfTokenize = skillRouter.tokenize;
assert(typeof tfidfTokenize === 'function', '11a. tokenize exported');
const tokens = tfidfTokenize('Hello, world! How are you today?');
assert(Array.isArray(tokens), '11a. tokenize returns array');
assert(tokens.includes('hello'), '11a. tokenize lowercases');
assert(tokens.includes('world'), '11a. tokenize strips punctuation');
assert(!tokens.includes(''), '11a. no empty tokens');

// 11b. termFrequency
const tf = skillRouter.termFrequency(['cat', 'dog', 'cat']);
assert(typeof tf === 'object', '11b. termFrequency returns object');
assert(Math.abs(tf.cat - 2/3) < 0.001, '11b. tf(cat) ≈ 0.667');
assert(Math.abs(tf.dog - 1/3) < 0.001, '11b. tf(dog) ≈ 0.333');

// 11c. inverseDocFrequency
const idf = skillRouter.inverseDocFrequency([
  { cat: 0.5, dog: 0.5 },
  { cat: 0.5, fish: 0.5 }
]);
assert(idf.cat === 0, '11c. idf(cat) = 0 (appears in all docs)');
assert(idf.dog > 0, '11c. idf(dog) > 0 (appears in 1 doc)');
assert(idf.fish > 0, '11c. idf(fish) > 0 (appears in 1 doc)');

// 11d. cosineSimilarity
const sim1 = skillRouter.cosineSimilarity({ a: 1, b: 0 }, { a: 1, b: 0 });
assert(Math.abs(sim1 - 1) < 0.001, '11d. identical vectors → similarity 1');
const sim2 = skillRouter.cosineSimilarity({ a: 1 }, { b: 1 });
assert(sim2 === 0, '11d. orthogonal vectors → similarity 0');

// 11e. tfidfScores with real skill index
const testIndex = {
  'deploy-aws': { keywords: ['deploy', 'aws', 'lambda', 'cloud'], tags: ['devops'] },
  'react-hooks': { keywords: ['react', 'hooks', 'useState', 'useEffect'], tags: ['frontend'] },
  'database-sql': { keywords: ['database', 'sql', 'query', 'postgres'], tags: ['backend'] }
};
const deployScores = skillRouter.tfidfScores(testIndex, 'how do I deploy to AWS lambda?');
assert(deployScores instanceof Map, '11e. tfidfScores returns Map');
assert(deployScores.has('deploy-aws'), '11e. deploy-aws matched');
// deploy-aws should score highest because "deploy", "aws", "lambda" all match
const awsScore = deployScores.get('deploy-aws') || 0;
const reactScore = deployScores.get('react-hooks') || 0;
assert(awsScore > reactScore, '11e. deploy-aws scores higher than react-hooks for deploy query');

// 11f. TF-IDF integration with getRelevantSkillsContext
// Add test skills, query, verify TF-IDF boosting works
const tfidfSkillContent = '# AWS Deployment\nDeploy serverless functions to AWS Lambda using SAM.';
skillRouter.addSkill('tfidf-test-aws', {
  keywords: ['deploy', 'aws', 'lambda'],
  tags: ['devops'],
  content: tfidfSkillContent
});
skillRouter.addSkill('tfidf-test-react', {
  keywords: ['react', 'component'],
  tags: ['frontend'],
  content: '# React Guide\nBuild React components with hooks.'
});

const ctx = skillRouter.getRelevantSkillsContext('deploy to aws lambda');
assert(typeof ctx === 'string', '11f. getRelevantSkillsContext returns string');
assert(ctx.includes('tfidf-test-aws'), '11f. TF-IDF boosted AWS skill is returned');

// Clean up
skillRouter.removeSkill('tfidf-test-aws');
skillRouter.removeSkill('tfidf-test-react');

// ═══════════════════════════════════════════════════════════
//  Phase 12 — N4: Session Persistence
// ═══════════════════════════════════════════════════════════
console.log('\n--- Phase 12: Session Persistence (N4) ---\n');

// 12a. saveSessionNote is exported
assert(typeof aiService.saveSessionNote === 'function', '12a. saveSessionNote exported from ai-service');

// 12b. saveSessionNote with no history returns null (nothing to save)
// Note: In a fresh test context, history may be empty
const sessionResult = aiService.saveSessionNote();
// It's ok if it's null (empty history) or a note object (if there's previous history)
assert(sessionResult === null || (sessionResult && sessionResult.id), '12b. saveSessionNote returns null or note');

// ═══════════════════════════════════════════════════════════
//  Phase 13 — N6: Cross-Model Reflection
// ═══════════════════════════════════════════════════════════
console.log('\n--- Phase 13: Cross-Model Reflection (N6) ---\n');

// 13a. setReflectionModel / getReflectionModel exported
assert(typeof aiService.setReflectionModel === 'function', '13a. setReflectionModel exported');
assert(typeof aiService.getReflectionModel === 'function', '13a. getReflectionModel exported');

// 13b. Default is null
assert(aiService.getReflectionModel() === null, '13b. default reflection model is null');

// 13c. Set and get
aiService.setReflectionModel('o3-mini');
assert(aiService.getReflectionModel() === 'o3-mini', '13c. reflection model set to o3-mini');

// 13d. Clear
aiService.setReflectionModel(null);
assert(aiService.getReflectionModel() === null, '13d. reflection model cleared');

// 13e. /rmodel command
const rmodelResult = aiService.handleCommand('/rmodel');
assert(rmodelResult !== null, '13e. /rmodel command recognized');
assert(rmodelResult.type === 'info', '13e. /rmodel shows info');
assert(rmodelResult.message.includes('default'), '13e. /rmodel message shows default state');

const rmodelSetResult = aiService.handleCommand('/rmodel o1');
assert(rmodelSetResult.type === 'system', '13e. /rmodel o1 sets model');
assert(aiService.getReflectionModel() === 'o1', '13e. reflection model now o1');

const rmodelOffResult = aiService.handleCommand('/rmodel off');
assert(rmodelOffResult.type === 'system', '13e. /rmodel off clears');
assert(aiService.getReflectionModel() === null, '13e. reflection model back to null');

// ═══════════════════════════════════════════════════════════
//  Phase 14 — N5: Analytics CLI Command
// ═══════════════════════════════════════════════════════════
console.log('\n--- Phase 14: Analytics CLI Command (N5) ---\n');

// 14a. Analytics module loads
const analyticsCmd = require('../src/cli/commands/analytics');
assert(typeof analyticsCmd.run === 'function', '14a. analytics command has run function');
assert(typeof analyticsCmd.showHelp === 'function', '14a. analytics command has showHelp function');

// 14b. Analytics can run (produces result for today — we wrote telemetry in Phase 10)
async function runAnalyticsTests() {
  const result = await analyticsCmd.run([], { days: 1 });
  assert(result.success === true, '14b. analytics returns success');
  assert(typeof result.count === 'number', '14b. analytics returns count');
  // We wrote at least one telemetry entry in Phase 10
  assert(result.count >= 1, '14b. analytics finds at least 1 entry');
}

// ═══════════════════════════════════════════════════════════
//  Integration — AI Service still loads
// ═══════════════════════════════════════════════════════════
console.log('\n--- Integration: AI Service Module ---\n');

assert(typeof aiService.sendMessage === 'function', 'sendMessage still exported');
assert(typeof aiService.getStatus === 'function', 'getStatus still exported');
assert(typeof aiService.handleCommand === 'function', 'handleCommand still exported');

// ═══════════════════════════════════════════════════════════
//  Summary (after async sandbox tests complete)
// ═══════════════════════════════════════════════════════════
runAsyncSandboxTests().then(() => {
  return runE2ESmokeTests();
}).then(() => {
  return runAnalyticsTests();
}).then(() => {
  console.log(`\n========================================`);
  console.log(`  v0.0.15 Cognitive Layer Test Summary`);
  console.log(`========================================`);
  console.log(`  Total:  ${passed + failed}`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`========================================\n`);

  if (failed > 0) {
    console.log('❌ Some tests failed!\n');
    process.exit(1);
  } else {
    console.log('✅ All tests passed!\n');
  }
}).catch((err) => {
  console.error('Async test error:', err);
  process.exit(1);
});
