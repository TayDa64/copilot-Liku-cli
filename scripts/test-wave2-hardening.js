#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-wave2-'));
process.env.LIKU_HOME_OVERRIDE = path.join(tmpRoot, '.liku');
process.env.LIKU_HOME_OLD_OVERRIDE = path.join(tmpRoot, '.liku-cli');

const memoryStore = require(path.join(__dirname, '..', 'src', 'main', 'memory', 'memory-store.js'));
const sandbox = require(path.join(__dirname, '..', 'src', 'main', 'tools', 'sandbox.js'));
const systemAutomation = require(path.join(__dirname, '..', 'src', 'main', 'system-automation.js'));
const { buildExecutionContextEnvelope } = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'execution-context.js'));

const createdNoteIds = [];
const createdToolPaths = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`PASS ${name}`);
    })
    .catch((error) => {
      console.error(`FAIL ${name}`);
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
}

function addNote(noteData) {
  const note = memoryStore.addNote(noteData);
  createdNoteIds.push(note.id);
  return note;
}

function addTool(fileName, content) {
  const toolDir = path.join(process.env.LIKU_HOME_OVERRIDE, 'tools', 'dynamic');
  fs.mkdirSync(toolDir, { recursive: true });
  const toolPath = path.join(toolDir, fileName);
  fs.writeFileSync(toolPath, content, 'utf8');
  createdToolPaths.push(toolPath);
  return toolPath;
}

function cleanup() {
  createdNoteIds.forEach((id) => {
    try { memoryStore.removeNote(id); } catch {}
  });
  createdToolPaths.forEach((toolPath) => {
    try { fs.unlinkSync(toolPath); } catch {}
  });
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}

async function main() {
  const repoEditorEnvelope = buildExecutionContextEnvelope({
    cwd: 'C:/dev/copilot-Liku-cli',
    foreground: {
      processName: 'Code',
      title: 'memory-store.js - Visual Studio Code'
    },
    sessionState: {
      currentRepo: {
        repoName: 'copilot-liku-cli',
        projectRoot: 'C:/dev/copilot-Liku-cli'
      }
    },
    userMessage: 'inspect the workspace command seam and fix the failing tests'
  });

  await test('scoped memory selection penalizes unscoped fallback inside a strict compartment without going empty', () => {
    const scopedNote = addNote({
      type: 'procedural',
      content: 'Repo-local note: inspect the command seam and rerun focused workspace tests.',
      keywords: ['workspace', 'command', 'tests', 'fix'],
      tags: ['repo', 'editor'],
      scope: {
        repoNames: ['copilot-liku-cli'],
        projectRoots: ['C:/dev/copilot-Liku-cli'],
        appIds: ['code'],
        processNames: ['code'],
        taskFamilies: ['repo-editor'],
        compartmentKeys: [repoEditorEnvelope.compartmentKey]
      }
    });

    const fallbackNote = addNote({
      type: 'semantic',
      content: 'Legacy fallback note: inspect the workspace command seam and rerun focused tests.',
      keywords: ['workspace', 'command', 'tests', 'fix'],
      tags: ['repo', 'tests']
    });

    const selection = memoryStore.getRelevantNotesSelection('inspect the workspace command seam and fix the failing tests', {
      executionContextEnvelope: repoEditorEnvelope,
      limit: 3
    });

    const fallbackMatch = selection.matches.find((entry) => entry.id === fallbackNote.id);
    const scopedMatch = selection.matches.find((entry) => entry.id === scopedNote.id);

    assert(selection.ids.includes(fallbackNote.id), 'unscoped fallback should remain eligible');
    assert(selection.ids.includes(scopedNote.id), 'scoped repo note should remain selected');
    assert(scopedMatch, 'scoped match should be present');
    assert(fallbackMatch, 'fallback match should be present');
    assert(fallbackMatch.scopeMatch.classification === 'unscoped-fallback', 'fallback should retain unscoped classification');
    assert(fallbackMatch.scopeMatch.score < 0, 'strict compartment should apply a penalty to unscoped fallback notes');
    assert(selection.ids.indexOf(scopedNote.id) < selection.ids.indexOf(fallbackNote.id), 'scoped repo note should outrank penalized unscoped fallback note');
    assert(selection.summary.fallbackCount >= 1, 'selection summary should still report fallback usage');
  });

  await test('sandbox execution returns structured diagnostics for worker-thrown errors', async () => {
    const toolPath = addTool('wave2-sandbox-error.js', [
      'console.log("before-run");',
      'console.error("boom-context");',
      'throw new Error("sandbox exploded");'
    ].join('\n'));

    const result = await sandbox.executeDynamicTool(toolPath, {});

    assert.strictEqual(result.success, false, 'sandbox error case should fail');
    assert(String(result.error || '').includes('sandbox exploded'), 'sandbox error should propagate the worker message');
    assert(result.diagnostics, 'sandbox failure should include diagnostics');
    assert.strictEqual(result.diagnostics.phase, 'execute', 'sandbox diagnostics should report the failing phase');
    assert(Array.isArray(result.diagnostics.logs), 'sandbox diagnostics should expose captured logs');
    assert(result.diagnostics.logs.some((entry) => String(entry.message || '').includes('before-run')), 'sandbox diagnostics should capture stdout-style console logs');
    assert(result.diagnostics.logs.some((entry) => String(entry.message || '').includes('boom-context')), 'sandbox diagnostics should capture stderr-style console logs');
    assert.strictEqual(result.diagnostics.error.message, 'sandbox exploded', 'sandbox diagnostics should preserve the worker error payload');
  });

  await test('executeCommand preserves stderr tail details on command failure', async () => {
    const command = "1..220 | ForEach-Object { [Console]::Error.WriteLine(('ERR-LINE-' + $_ + '-' + ('x' * 24))) }; [Console]::Error.WriteLine('FINAL-ROOT-CAUSE'); exit 1";
    const result = await systemAutomation.executeCommand(command, {
      shell: 'powershell',
      cwd: 'C:/dev/copilot-Liku-cli',
      timeout: 15000
    });

    assert.strictEqual(result.success, false, 'failing command should report success=false');
    assert.strictEqual(result.exitCode, 1, 'failing command should preserve exit code');
    assert.strictEqual(result.stderrTruncated, true, 'large stderr should be reported as truncated');
    assert(String(result.stderr || '').includes('FINAL-ROOT-CAUSE'), 'stderr tail truncation should preserve the root-cause footer');
    assert(result.stderrOriginalLength > String(result.stderr || '').length, 'stderr metadata should preserve original length');
  });

  cleanup();
}

main().catch((error) => {
  console.error('FAIL wave2 hardening');
  console.error(error.stack || error.message);
  cleanup();
  process.exit(1);
});
