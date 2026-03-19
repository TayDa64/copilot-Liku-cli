#!/usr/bin/env node

const { spawn, spawnSync } = require('child_process');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');

const SUITES = {
  'status-basic-chat': {
    description: 'Verifies inline status handling and a normal non-action assistant reply through the real chat path.',
    prompts: [
      '/status',
      'Say hello in one short sentence.',
      'exit'
    ],
    expectations: [
      {
        name: 'status reports provider',
        scope: 'transcript',
        include: [/Provider:\s+copilot/i, /Copilot:\s+Authenticated/i]
      },
      {
        name: 'assistant returns a plain chat reply',
        turn: 1,
        include: [/(hello|hey|hi)\b/i],
        exclude: [/"actions"\s*:/i, /```json/i]
      }
    ]
  },
  'direct-navigation': {
    description: 'Proves direct URL planning, repeated grounding, and no-op confirmation when state is already satisfied.',
    prompts: [
      '/status',
      'Open https://www.apple.com in Edge without using search or intermediate pages. Use the most direct grounded method.',
      'Open https://www.apple.com in Edge without using search or intermediate pages. Use the most direct grounded method.',
      'The Apple page should already be open. Confirm briefly and do not propose any new actions.',
      'exit'
    ],
    expectations: [
      {
        name: 'status reports provider',
        scope: 'transcript',
        include: [/Provider:\s+copilot/i, /Copilot:\s+Authenticated/i]
      },
      {
        name: 'assistant uses direct URL plan',
        turn: 2,
        include: [/https:\/\/www\.apple\.com/i, /bring_window_to_front/i],
        exclude: [/google\.com/i, /bing\.com/i, /search the web/i]
      },
      {
        name: 'repeated request stays direct',
        turn: 2,
        include: [/Navigate( directly)? to apple\.com/i],
        exclude: [/search engine/i, /intermediate page/i]
      },
      {
        name: 'final turn confirms no further actions',
        turn: 3,
        include: [/Confirmed/i, /(No further actions (needed|taken)|No actions proposed)/i],
        exclude: [/"actions"\s*:/i]
      }
    ]
  },
  'recovery-noop': {
    description: 'Verifies the no-action retry path and final no-op confirmation for an automation-like request.',
    prompts: [
      '/status',
      'Open https://www.apple.com in Edge without using search or intermediate pages. Use the most direct grounded method.',
      'The Apple page should already be open. Confirm briefly and do not propose any new actions.',
      'exit'
    ],
    expectations: [
      {
        name: 'status reports provider',
        scope: 'transcript',
        include: [/Provider:\s+copilot/i, /Copilot:\s+Authenticated/i]
      },
      {
        name: 'first automation turn stays direct',
        turn: 1,
        include: [/(apple\.com|Apple\.com is already open|https:\/\/www\.apple\.com)/i, /(bring_window_to_front|ctrl\+l|alt\+d)/i],
        exclude: [/google\.com/i, /bing\.com/i]
      },
      {
        name: 'no-action retry path is exercised',
        scope: 'transcript',
        include: [/No actions detected for an automation-like request; retrying once with stricter formatting/i]
      },
      {
        name: 'final turn confirms without new actions',
        turn: 2,
        include: [/Confirmed/i, /(No further actions (needed|taken)|No actions proposed)/i],
        exclude: [/"actions"\s*:/i, /```json/i]
      }
    ]
  }
};

function getArgValue(flagName) {
  const index = process.argv.indexOf(flagName);
  if (index >= 0 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return null;
}

function hasFlag(flagName) {
  return process.argv.includes(flagName);
}

function listSuites() {
  console.log('Available suites:');
  for (const [name, suite] of Object.entries(SUITES)) {
    console.log(`- ${name}: ${suite.description}`);
  }
}

function resolveGlobalWindowsShim() {
  const lookup = spawnSync('where.exe', ['liku.cmd'], {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  });

  if (lookup.status !== 0) {
    throw new Error('Could not resolve global liku.cmd with where.exe');
  }

  const candidates = String(lookup.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.toLowerCase().startsWith(REPO_ROOT.toLowerCase()));

  if (candidates.length === 0) {
    throw new Error('No installed global liku.cmd found outside the repo root');
  }

  return candidates[0];
}

function buildCommand({ useGlobal }) {
  if (useGlobal) {
    if (process.platform === 'win32') {
      const globalShim = resolveGlobalWindowsShim();
      const escapedShim = globalShim.replace(/'/g, "''");
      return {
        file: 'powershell',
        args: ['-NoProfile', '-Command', `& '${escapedShim}' chat --execute false`]
      };
    }

    return {
      file: 'sh',
      args: ['-lc', 'liku chat --execute false']
    };
  }

  const cliPath = path.join(REPO_ROOT, 'src', 'cli', 'liku.js');
  return {
    file: process.execPath,
    args: [cliPath, 'chat', '--execute', 'false']
  };
}

function renderSuiteHeader(name, suite, useGlobal) {
  console.log('========================================');
  console.log(` Inline Chat Proof: ${name}`);
  console.log('========================================');
  console.log(`Mode: ${useGlobal ? 'global liku command' : 'local workspace CLI'}`);
  console.log(`Goal: ${suite.description}`);
  console.log('');
}

function extractAssistantTurns(transcript) {
  const lines = String(transcript || '').split(/\r?\n/);
  const turns = [];
  let current = [];
  let collecting = false;

  for (const line of lines) {
    if (/^\[copilot:/i.test(line.trim())) {
      if (collecting && current.length > 0) {
        turns.push(current.join('\n').trim());
      }
      collecting = true;
      current = [];
      continue;
    }

    if (!collecting) continue;

    if (/^>\s/.test(line) || /^\[UI-WATCHER\]/.test(line) || /^PS\s/.test(line)) {
      if (current.length > 0) {
        turns.push(current.join('\n').trim());
      }
      collecting = false;
      current = [];
      continue;
    }

    current.push(line);
  }

  if (collecting && current.length > 0) {
    turns.push(current.join('\n').trim());
  }

  return turns.filter(Boolean);
}

function evaluateTranscript(transcript, suite) {
  const assistantTurns = extractAssistantTurns(transcript);
  const results = [];

  for (const expectation of suite.expectations) {
    const targetText = expectation.scope === 'transcript'
      ? transcript
      : assistantTurns[Math.max(0, Number(expectation.turn || 1) - 1)] || '';
    const includePatterns = Array.isArray(expectation.include) ? expectation.include : [];
    const excludePatterns = Array.isArray(expectation.exclude) ? expectation.exclude : [];

    const missing = includePatterns.filter((pattern) => !pattern.test(targetText));
    const forbidden = excludePatterns.filter((pattern) => pattern.test(targetText));
    const passed = missing.length === 0 && forbidden.length === 0;

    results.push({
      name: expectation.name,
      passed,
      missing,
      forbidden,
      turn: expectation.turn || null
    });
  }

  return {
    passed: results.every((result) => result.passed),
    results
  };
}

function printEvaluation(evaluation) {
  console.log('');
  console.log('Evaluation:');
  for (const result of evaluation.results) {
    if (result.passed) {
      console.log(`PASS ${result.name}`);
      continue;
    }

    console.log(`FAIL ${result.name}`);
    if (result.missing.length > 0) {
      console.log(`  Missing: ${result.missing.map((pattern) => pattern.toString()).join(', ')}`);
    }
    if (result.forbidden.length > 0) {
      console.log(`  Forbidden: ${result.forbidden.map((pattern) => pattern.toString()).join(', ')}`);
    }
  }
}

async function runSuite(name, suite, useGlobal) {
  const command = buildCommand({ useGlobal });
  renderSuiteHeader(name, suite, useGlobal);

  const child = spawn(command.file, command.args, {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env
  });

  let transcript = '';
  child.stdout.on('data', (data) => {
    const text = data.toString();
    transcript += text;
    process.stdout.write(text);
  });
  child.stderr.on('data', (data) => {
    const text = data.toString();
    transcript += text;
    process.stdout.write(text);
  });

  const payload = `${suite.prompts.join('\n')}\n`;
  child.stdin.write(payload);
  child.stdin.end();

  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  const evaluation = evaluateTranscript(transcript, suite);
  printEvaluation(evaluation);

  if (exitCode !== 0) {
    console.error(`\nChat process exited with code ${exitCode}`);
  }

  return exitCode === 0 && evaluation.passed;
}

async function main() {
  if (hasFlag('--list-suites')) {
    listSuites();
    return;
  }

  const runAll = hasFlag('--all');
  const suiteName = getArgValue('--suite') || 'direct-navigation';
  const useGlobal = hasFlag('--global');

  const suiteEntries = runAll
    ? Object.entries(SUITES)
    : [[suiteName, SUITES[suiteName]]];

  if (suiteEntries.some(([, suite]) => !suite)) {
    console.error(`Unknown suite: ${suiteName}`);
    console.error(`Available suites: ${Object.keys(SUITES).join(', ')}`);
    process.exit(1);
  }

  let allPassed = true;
  for (const [name, suite] of suiteEntries) {
    const passed = await runSuite(name, suite, useGlobal);
    allPassed = allPassed && passed;
  }

  if (!allPassed) {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = {
  SUITES,
  evaluateTranscript,
  extractAssistantTurns
};