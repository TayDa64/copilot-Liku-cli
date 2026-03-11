#!/usr/bin/env node
/**
 * Test suite for v0.0.15 Cognitive Layer features
 * Validates Phase 0–4 from furtherAIadvancements.md
 */

const fs = require('fs');
const path = require('path');

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
assert(defs.length > 0, 'Dynamic tool definitions are generated');
assert(defs[0].function.name === 'dynamic_test-calculator', 'Tool name has dynamic_ prefix');

// Cleanup
toolRegistry.unregisterTool('test-calculator', true);
assert(toolRegistry.lookupTool('test-calculator') === null, 'Tool was unregistered');

// Clean up test tool files
try { fs.unlinkSync(testToolPath); } catch {}
try { fs.unlinkSync(infiniteToolPath); } catch {}

// ═══════════════════════════════════════════════════════════
//  Integration — AI Service still loads
// ═══════════════════════════════════════════════════════════
console.log('\n--- Integration: AI Service Module ---\n');

const aiService = require('../src/main/ai-service');
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
