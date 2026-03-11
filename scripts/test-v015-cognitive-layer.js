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

// Sandbox execution
assert(typeof sandbox.executeDynamicTool === 'function', 'executeDynamicTool is a function');

// Write a test tool and execute it
const testToolDir = path.join(likuHome.LIKU_HOME, 'tools', 'dynamic');
if (!fs.existsSync(testToolDir)) fs.mkdirSync(testToolDir, { recursive: true });
const testToolPath = path.join(testToolDir, 'test-add.js');
fs.writeFileSync(testToolPath, 'result = args.a + args.b;');

const execResult = sandbox.executeDynamicTool(testToolPath, { a: 3, b: 7 });
assert(execResult.success === true, 'Sandbox executes safe tool successfully');
assert(execResult.result === 10, 'Sandbox returns correct result');

// Test timeout protection
const infiniteToolPath = path.join(testToolDir, 'test-infinite.js');
fs.writeFileSync(infiniteToolPath, 'while(true) {}');
const timeoutResult = sandbox.executeDynamicTool(infiniteToolPath, {});
assert(timeoutResult.success === false, 'Infinite loop tool fails');
assert(timeoutResult.error.includes('timed out') || timeoutResult.error.includes('timeout'),
  'Timeout error message is descriptive');

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

// Clean up test tool files
try { fs.unlinkSync(testToolPath); } catch {}
try { fs.unlinkSync(infiniteToolPath); } catch {}

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
//  Integration — AI Service still loads
// ═══════════════════════════════════════════════════════════
console.log('\n--- Integration: AI Service Module ---\n');

assert(typeof aiService.sendMessage === 'function', 'sendMessage still exported');
assert(typeof aiService.getStatus === 'function', 'getStatus still exported');
assert(typeof aiService.handleCommand === 'function', 'handleCommand still exported');

// ═══════════════════════════════════════════════════════════
//  Summary
// ═══════════════════════════════════════════════════════════
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
