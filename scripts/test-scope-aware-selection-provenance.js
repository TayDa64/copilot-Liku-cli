#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-slice5-'));
process.env.LIKU_HOME_OVERRIDE = path.join(tmpRoot, '.liku');
process.env.LIKU_HOME_OLD_OVERRIDE = path.join(tmpRoot, '.liku-cli');

const skillRouter = require(path.join(__dirname, '..', 'src', 'main', 'memory', 'skill-router.js'));
const memoryStore = require(path.join(__dirname, '..', 'src', 'main', 'memory', 'memory-store.js'));
const { buildExecutionContextEnvelope } = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'execution-context.js'));
const { buildChatContinuityTurnRecord } = require(path.join(__dirname, '..', 'src', 'main', 'chat-continuity-state.js'));
const { createSessionIntentStateStore } = require(path.join(__dirname, '..', 'src', 'main', 'session-intent-state.js'));

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

const createdSkillIds = [];
const createdNoteIds = [];

function addSkill(id, data) {
  createdSkillIds.push(id);
  return skillRouter.addSkill(id, data);
}

function addNote(data) {
  const note = memoryStore.addNote(data);
  createdNoteIds.push(note.id);
  return note;
}

function cleanup() {
  createdSkillIds.forEach((id) => {
    try { skillRouter.removeSkill(id); } catch {}
  });
  createdNoteIds.forEach((id) => {
    try { memoryStore.removeNote(id); } catch {}
  });
}

const repoEditorEnvelope = buildExecutionContextEnvelope({
  cwd: 'C:/dev/copilot-Liku-cli',
  foreground: {
    processName: 'Code',
    title: 'brainstorm040826.md - Visual Studio Code'
  },
  sessionState: {
    currentRepo: {
      repoName: 'copilot-Liku-cli',
      projectRoot: 'C:/dev/copilot-Liku-cli'
    }
  },
  userMessage: 'inspect the workspace tests and fix the failing repo command'
});

test('repo/editor routing downranks mismatched TradingView/Pine skills', () => {
  addSkill('slice5-tradingview-mismatch', {
    keywords: ['workspace', 'repo', 'tests', 'fix'],
    tags: ['tradingview', 'pine'],
    scope: {
      appIds: ['tradingview'],
      processNames: ['tradingview'],
      taskFamilies: ['tradingview-pine'],
      compartmentKeys: ['copilot-liku-cli::tradingview::unknown::tradingview-pine']
    },
    content: '# TradingView mismatch\n\nUse Pine Editor workflows.'
  });

  addSkill('slice5-repo-editor-match', {
    keywords: ['workspace', 'repo', 'tests', 'fix'],
    tags: ['repo', 'editor'],
    scope: {
      repoNames: ['copilot-liku-cli'],
      projectRoots: ['C:/dev/copilot-Liku-cli'],
      appIds: ['code'],
      processNames: ['code'],
      taskFamilies: ['repo-editor'],
      compartmentKeys: [repoEditorEnvelope.compartmentKey]
    },
    content: '# Repo editor skill\n\nRun tests and inspect files in the workspace.'
  });

  const selection = skillRouter.getRelevantSkillsSelection('inspect the workspace tests and fix the failing repo command', {
    executionContextEnvelope: repoEditorEnvelope,
    currentProcessName: 'Code',
    currentWindowTitle: 'brainstorm040826.md - Visual Studio Code',
    currentWindowKind: 'editor',
    currentUrlHost: null,
    limit: 2
  });

  assert.strictEqual(selection.ids[0], 'slice5-repo-editor-match');
  assert(!selection.ids.includes('slice5-tradingview-mismatch') || selection.ids.indexOf('slice5-tradingview-mismatch') > selection.ids.indexOf('slice5-repo-editor-match'));
  assert.strictEqual(selection.summary.scopeContext.taskFamily, 'repo-editor');
});

test('scoped memory retrieval falls back to neutral legacy notes instead of going empty', () => {
  addNote({
    type: 'procedural',
    content: 'TradingView Pine diagnostics workflow for chart verification.',
    keywords: ['workspace', 'repo', 'tests', 'fix'],
    tags: ['tradingview', 'pine'],
    scope: {
      appIds: ['tradingview'],
      processNames: ['tradingview'],
      taskFamilies: ['tradingview-pine']
    }
  });

  const fallbackNote = addNote({
    type: 'semantic',
    content: 'Legacy note: when repo tests fail, inspect the workspace command seam and rerun the focused script.',
    keywords: ['workspace', 'repo', 'tests', 'fix'],
    tags: ['repo', 'tests']
  });

  const selection = memoryStore.getRelevantNotesSelection('inspect the workspace tests and fix the failing repo command', {
    executionContextEnvelope: repoEditorEnvelope,
    limit: 3
  });

  assert(selection.text.includes('Legacy note:'), 'fallback note should still be injected');
  assert(selection.ids.includes(fallbackNote.id), 'neutral legacy note should remain eligible as fallback');
  assert(selection.summary.fallbackCount >= 1, 'selection summary should record fallback usage');
  assert(selection.summary.selectedCount >= 1, 'selection should not go empty');
});

test('explicit scope tiers keep global skills reusable while domain and local skills stay context-shaped', () => {
  addSkill('sliceg3-global-repo', {
    keywords: ['workspace', 'repo', 'tests', 'fix'],
    tags: ['git', 'shell'],
    scope: {
      tier: 'global'
    },
    content: '# Global repo skill\n\nUse generic git, shell, and repo-debugging workflows.'
  });

  addSkill('sliceg3-domain-browser', {
    keywords: ['workspace', 'repo', 'tests', 'fix'],
    tags: ['browser', 'research'],
    scope: {
      tier: 'domain',
      appIds: ['chrome'],
      processNames: ['chrome'],
      taskFamilies: ['browser']
    },
    content: '# Domain browser skill\n\nUse browser research workflows when the active context is browser work.'
  });

  addSkill('sliceg3-local-repo', {
    keywords: ['workspace', 'repo', 'tests', 'fix'],
    tags: ['repo', 'editor'],
    scope: {
      tier: 'local',
      repoNames: ['copilot-liku-cli'],
      projectRoots: ['C:/dev/copilot-Liku-cli'],
      appIds: ['code'],
      processNames: ['code'],
      taskFamilies: ['repo-editor'],
      compartmentKeys: [repoEditorEnvelope.compartmentKey]
    },
    content: '# Local repo skill\n\nUse tightly scoped repo workflows for this workspace.'
  });

  const repoSelection = skillRouter.getRelevantSkillsSelection('inspect the workspace tests and fix the failing repo command', {
    executionContextEnvelope: repoEditorEnvelope,
    currentProcessName: 'Code',
    currentWindowTitle: 'brainstorm040826.md - Visual Studio Code',
    currentWindowKind: 'editor',
    limit: 3
  });

  assert.notStrictEqual(repoSelection.ids[0], 'sliceg3-domain-browser', 'domain-tier browser skill should not outrank repo-local skills in the repo/editor compartment');
  assert(repoSelection.ids.includes('sliceg3-global-repo'), 'global tier should remain eligible as reusable fallback');
  assert(repoSelection.ids.includes('sliceg3-local-repo'), 'explicit local-tier skill should remain selected inside the matching repo/editor compartment');
  assert(repoSelection.summary.globalTierCount >= 1, 'selection summary should report global-tier usage');
  assert(repoSelection.summary.localTierCount >= 1, 'selection summary should report local-tier usage');

  const browserEnvelope = buildExecutionContextEnvelope({
    cwd: 'C:/dev/copilot-Liku-cli',
    foreground: { processName: 'chrome', title: 'Issue search - Google Chrome' },
    sessionState: {
      currentRepo: {
        repoName: 'copilot-Liku-cli',
        projectRoot: 'C:/dev/copilot-Liku-cli'
      }
    },
    userMessage: 'research this repo issue in browser'
  });

  const browserSelection = skillRouter.getRelevantSkillsSelection('research this repo issue in browser', {
    executionContextEnvelope: browserEnvelope,
    currentProcessName: 'chrome',
    currentWindowTitle: 'Issue search - Google Chrome',
    currentWindowKind: 'browser',
    limit: 4
  });

  assert.strictEqual(browserSelection.ids[0], 'sliceg3-domain-browser', 'domain tier should boost only in the matching browser context');
  assert(browserSelection.ids.includes('sliceg3-global-repo'), 'global tier should still remain eligible in the browser context');
  assert(browserSelection.summary.domainTierCount >= 1, 'selection summary should report domain-tier usage');
});

test('explicit scope tiers keep global memories reusable while domain and local notes remain scoped', () => {
  const globalNote = addNote({
    type: 'semantic',
    content: 'Global memory: generic git and shell inspection steps remain useful across projects.',
    keywords: ['workspace', 'repo', 'tests', 'fix', 'browser', 'research'],
    tags: ['git', 'shell'],
    scope: {
      tier: 'global'
    }
  });

  const browserDomainNote = addNote({
    type: 'procedural',
    content: 'Domain memory: browser research workflow for investigating repo issues.',
    keywords: ['repo', 'issue', 'browser', 'research'],
    tags: ['browser', 'research'],
    scope: {
      tier: 'domain',
      appIds: ['chrome'],
      processNames: ['chrome'],
      taskFamilies: ['browser']
    }
  });

  const localRepoNote = addNote({
    type: 'procedural',
    content: 'Local memory: inspect copilot-liku-cli workspace tests before making repo changes.',
    keywords: ['workspace', 'repo', 'tests', 'fix'],
    tags: ['repo', 'tests'],
    scope: {
      tier: 'local',
      repoNames: ['copilot-liku-cli'],
      projectRoots: ['C:/dev/copilot-Liku-cli'],
      appIds: ['code'],
      processNames: ['code'],
      taskFamilies: ['repo-editor'],
      compartmentKeys: [repoEditorEnvelope.compartmentKey]
    }
  });

  const repoSelection = memoryStore.getRelevantNotesSelection('inspect the workspace tests and fix the failing repo command', {
    executionContextEnvelope: repoEditorEnvelope,
    limit: 3
  });

  assert(repoSelection.ids.includes(globalNote.id), 'global memory should remain eligible in repo context');
  assert(repoSelection.ids.includes(localRepoNote.id), 'local memory should remain selected in the matching repo/editor context');
  assert(repoSelection.summary.globalTierCount >= 1, 'memory summary should report global-tier usage');
  assert(repoSelection.summary.localTierCount >= 1, 'memory summary should report local-tier usage');

  const browserEnvelope = buildExecutionContextEnvelope({
    cwd: 'C:/dev/copilot-Liku-cli',
    foreground: { processName: 'chrome', title: 'Issue search - Google Chrome' },
    sessionState: {
      currentRepo: {
        repoName: 'copilot-Liku-cli',
        projectRoot: 'C:/dev/copilot-Liku-cli'
      }
    },
    userMessage: 'research this repo issue in browser'
  });

  const browserSelection = memoryStore.getRelevantNotesSelection('research this repo issue in browser', {
    executionContextEnvelope: browserEnvelope,
    limit: 3
  });

  assert(browserSelection.ids.includes(globalNote.id), 'global memory should remain eligible in browser context');
  assert.strictEqual(browserSelection.ids[0], browserDomainNote.id, 'domain memory should boost only in the matching browser context');
  assert(browserSelection.summary.domainTierCount >= 1, 'memory summary should report domain-tier usage');
});

test('selected skills and memories persist into continuity turn records', () => {
  const stateFile = path.join(tmpRoot, 'session-intent-state.json');
  const store = createSessionIntentStateStore({ stateFile });

  const selectionProvenance = {
    skills: {
      ids: ['slice5-repo-editor-match'],
      summary: {
        selectedCount: 1,
        scopedMatchCount: 1,
        fallbackCount: 0,
        mismatchCount: 0,
        scopeContext: {
          repoName: 'copilot-liku-cli',
          projectRoot: 'C:/dev/copilot-Liku-cli',
          appId: 'code',
          processName: 'code',
          taskFamily: 'repo-editor',
          compartmentKey: repoEditorEnvelope.compartmentKey
        }
      }
    },
    memories: {
      ids: ['note-slice5-memory'],
      summary: {
        selectedCount: 1,
        scopedMatchCount: 0,
        fallbackCount: 1,
        mismatchCount: 0,
        scopeContext: {
          repoName: 'copilot-liku-cli',
          projectRoot: 'C:/dev/copilot-Liku-cli',
          appId: 'code',
          processName: 'code',
          taskFamily: 'repo-editor',
          compartmentKey: repoEditorEnvelope.compartmentKey
        }
      }
    },
    executionContext: repoEditorEnvelope
  };

  const turnRecord = buildChatContinuityTurnRecord({
    actionData: {
      thought: 'Inspect the failing repo command',
      actions: [
        { type: 'run_command', command: 'node scripts/test-ai-service-contract.js', reason: 'Verify the command seam in the repo' }
      ]
    },
    execResult: {
      success: true,
      results: [
        { success: true, action: 'run_command', message: 'ok' }
      ],
      selectionProvenance
    },
    details: {
      userMessage: 'inspect the workspace tests and fix the failing repo command',
      executionIntent: 'Inspect the failing repo command',
      executionContextEnvelope: repoEditorEnvelope,
      selectionProvenance
    }
  });

  store.recordExecutedTurn(turnRecord, {
    cwd: 'C:/dev/copilot-Liku-cli',
    executionContextEnvelope: repoEditorEnvelope
  });

  const persisted = store.getChatContinuity({
    cwd: 'C:/dev/copilot-Liku-cli',
    executionContextEnvelope: repoEditorEnvelope
  });

  assert.deepStrictEqual(persisted.lastTurn.selectedSkillIds, ['slice5-repo-editor-match']);
  assert.deepStrictEqual(persisted.lastTurn.selectedMemoryIds, ['note-slice5-memory']);
  assert.strictEqual(persisted.lastTurn.retrievalSummary.skills.scopedMatchCount, 1);
  assert.strictEqual(persisted.lastTurn.retrievalSummary.memories.fallbackCount, 1);
});

process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
