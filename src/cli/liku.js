#!/usr/bin/env node
/**
 * liku - Copilot-Liku CLI
 * 
 * A powerful command-line interface for UI automation and the Copilot-Liku agent.
 * 
 * Usage:
 *   liku                    Start the Electron agent (visual mode)
 *   liku start              Same as above
 *   liku click <text>       Click element by text
 *   liku find <text>        Find UI elements matching text
 *   liku type <text>        Type text at cursor
 *   liku keys <combo>       Send key combination (e.g., "ctrl+c")
 *   liku screenshot [path]  Take screenshot
 *   liku window <title>     Focus window by title
 *   liku mouse <x> <y>      Move mouse to coordinates
 *   liku repl               Interactive automation shell
 *   liku --help             Show help
 *   liku --version          Show version
 */

const path = require('path');

// Resolve paths relative to CLI location
const CLI_DIR = __dirname;
const PROJECT_ROOT = path.resolve(CLI_DIR, '../..');

// Import output utilities
const { log, success, error, warn, info, dim, highlight } = require('./util/output');
const { COMMANDS } = require('./command-registry');
const { buildCommandRequest, executeCommandRequest } = require('./command-seam');

// Package info
const pkg = require(path.join(PROJECT_ROOT, 'package.json'));

/**
 * Show help message
 */
function showHelp() {
  console.log(`
${highlight('liku')} - Copilot-Liku CLI v${pkg.version}
${dim('A powerful command-line interface for UI automation')}

${highlight('USAGE:')}
  liku [command] [options]

${highlight('COMMANDS:')}
`);

  // Calculate padding for alignment
  const maxLen = Math.max(...Object.keys(COMMANDS).map(k => k.length + (COMMANDS[k].args?.length || 0)));
  
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    const cmdStr = cmd.args ? `${name} ${cmd.args}` : name;
    const padding = ' '.repeat(maxLen - cmdStr.length + 4);
    console.log(`  ${highlight(cmdStr)}${padding}${dim(cmd.desc)}`);
  }

  console.log(`
${highlight('OPTIONS:')}
  --help, -h       Show this help message
  --version, -v    Show version
  --json           Output results as JSON (for scripting)
  --quiet, -q      Suppress non-essential output
  --project <dir>  Require command to run within the expected project root
  --repo <name>    Require detected repo identity to match the expected name

${highlight('EXAMPLES:')}
  ${dim('# Start the visual agent')}
  liku start

  ${dim('# Start terminal chat (Copilot-CLI-liku)')}
  liku chat

  ${dim('# Click a button by text')}
  liku click "Submit"

  ${dim('# Find all buttons with "Save" in their text')}
  liku find "Save" --type Button

  ${dim('# Type text')}
  liku type "Hello, World!"

  ${dim('# Send keyboard shortcut')}
  liku keys ctrl+shift+s

  ${dim('# Take a screenshot')}
  liku screenshot ./capture.png

    ${dim('# Take an in-memory screenshot (no file)')}
    liku screenshot --memory --hash --json

  ${dim('# Poll until the frame changes (hash)')}
  liku verify-hash --timeout 8000 --interval 250 --json

  ${dim('# Wait until the frame is settled/stable')}
  liku verify-stable --metric dhash --epsilon 4 --stable-ms 800 --timeout 15000 --interval 250 --json

  ${dim('# Focus VS Code window')}
  liku window "Visual Studio Code"

  ${dim('# Interactive mode')}
  liku repl

  ${dim('# Inspect read-only GitHub auth state')}
  liku github auth status

  ${dim('# List the registered GitHub capabilities and policy metadata')}
  liku github capabilities list

  ${dim('# Inspect one registered GitHub capability')}
  liku github capabilities inspect pr.diff

  ${dim('# Build a deterministic execution plan for one GitHub capability')}
  liku github plan build pr diff 7 --limit 30 --api false

  ${dim('# Execute a bounded read-only GitHub plan and persist replay artifacts')}
  liku github plan execute pr diff 7 --limit 30 --api false

  ${dim('# List or inspect locally recorded GitHub plan runs')}
  liku github plan runs --slug owner/repo --limit 10 --state blocked
  liku github plan inspect github-run-123 --slug owner/repo

  ${dim('# Draft a reviewed GitHub issue-comment preview without mutating GitHub yet')}
  liku github issues comment draft 321 --body "Thanks for the detailed report" --slug owner/repo

  ${dim('# Draft a reviewed GitHub pull-request-create preview without mutating GitHub yet')}
  liku github pr create draft --title "Add overlay diagnostics" --base main --head feature/demo --slug owner/repo

  ${dim('# Draft a reviewed GitHub PR-comment preview without mutating GitHub yet')}
  liku github pr comment draft 123 --body "Looks good overall" --slug owner/repo

  ${dim('# Apply one reviewed GitHub write preview from the CLI')}
  liku github apply github-write-preview-123 --approve --approval-file C:\\Users\\you\\.liku\\github\\writes\\github-write-preview-123.approval.json

  ${dim('# Replay a saved GitHub plan artifact')}
  liku github plan execute --plan-file C:\\Users\\you\\.liku\\github\\plans\\github-plan-example.plan.json

  ${dim('# Inspect the current repo via local identity + GitHub metadata')}
  liku github repo inspect --json

  ${dim('# List repository rulesets or inspect templates locally/offline')}
  liku github ruleset list --slug owner/repo --limit 10
  liku github template inspect --api false

  ${dim('# Draft a reviewed CODEOWNERS patch through a dedicated branch + draft PR')}
  liku github codeowners create draft --body-file C:\\Users\\you\\CODEOWNERS --base main --slug owner/repo

  ${dim('# Preview a reviewed repository webhook create flow')}
  liku github webhook create draft --events push,pull_request,workflow_run --target-url https://assistant.example.com/github/webhook --secret-ref repo:LIKU_WEBHOOK_SECRET --content-type json --slug owner/repo

  ${dim('# Inspect the local GitHub event journal for one repository')}
  liku github event list --slug owner/repo --limit 10 --event push

  ${dim('# Summarize GitHub App posture for a repository')}
  liku github app status --slug owner/repo

  ${dim('# List issues for the current or a specified GitHub repo')}
  liku github issues list --state all --limit 10

  ${dim('# Inspect one GitHub issue')}
  liku github issues inspect 321

  ${dim('# List pull requests')}
  liku github pr list --state all --limit 10

  ${dim('# Show the branch-associated pull request status')}
  liku github pr status --branch feature/demo --slug owner/repo

  ${dim('# Summarize pull-request comments and reviews for the current branch or one PR')}
  liku github pr feedback --branch feature/demo --slug owner/repo

  ${dim('# Draft a reviewed GitHub PR review preview without mutating GitHub yet')}
  liku github pr review draft 123 --event approve --body "Looks good overall" --slug owner/repo

  ${dim('# Draft a reviewed GitHub PR close/reopen preview without mutating GitHub yet')}
  liku github pr close draft 123 --slug owner/repo
  liku github pr reopen draft 123 --slug owner/repo

  ${dim('# Inspect one pull request')}
  liku github pr inspect 7

  ${dim('# Summarize the changed files in one pull request')}
  liku github pr diff 7 --limit 30

  ${dim('# List workflow runs')}
  liku github workflow runs --workflow ci.yml --limit 5

  ${dim('# Inspect one workflow run')}
  liku github workflow inspect 9001

  ${dim('# Validate one workflow file locally before opening a PR')}
  liku github workflow validate .github/workflows/ci.yml --body-file C:\\Users\\you\\ci.yml --slug owner/repo

  ${dim('# Draft a reviewed workflow-file change through a dedicated branch + draft PR')}
  liku github workflow create draft .github/workflows/ci.yml --body-file C:\\Users\\you\\ci.yml --base main --slug owner/repo

  ${dim('# Draft a reviewed workflow dispatch preview for a sandbox workflow')}
  liku github workflow dispatch draft ci.yml --ref main --inputs-json '{"target":"staging"}' --slug owner/repo

  ${dim('# Draft a reviewed rerun/cancel preview for one workflow run')}
  liku github workflow rerun draft 9001 --failed-only true --slug owner/repo
  liku github workflow cancel draft 9001 --slug owner/repo

  ${dim('# List releases')}
  liku github releases list --limit 5

  ${dim('# Inspect one release')}
  liku github releases inspect latest

${highlight('ENVIRONMENT:')}
  LIKU_DEBUG=1     Enable debug output
  LIKU_JSON=1      Default to JSON output
  LIKU_DISABLE_RUNTIME_TRACE=1  Disable CLI/runtime trace logging
  LIKU_ENABLE_GITHUB=1          Opt in to future GitHub command surfaces
  LIKU_ENABLE_GITHUB_WRITES=1   Enable reviewed GitHub write preview/apply flows
  LIKU_ENABLE_AGENTS=0|1        Override seam-level agent feature availability
  LIKU_ENABLE_DYNAMIC_TOOLS=0|1 Override seam-level dynamic tool availability
  LIKU_APPROVAL_MODE=prompt|auto|never  Set the default approval preference
  LIKU_DRY_RUN_DEFAULT=1        Mark seam requests as dry-run preferred by default

${dim('Documentation: https://github.com/TayDa64/copilot-Liku-cli')}
`);
}

/**
 * Show version
 */
function showVersion() {
  console.log(`liku v${pkg.version}`);
}

/**
 * Parse command-line arguments
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    command: null,
    args: [],
    flags: {
      help: false,
      version: false,
      json: false,
      quiet: false,
      debug: process.env.LIKU_DEBUG === '1',
    },
    options: {},
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    
    if (arg === '--help' || arg === '-h') {
      result.flags.help = true;
    } else if (arg === '--version' || arg === '-v') {
      result.flags.version = true;
    } else if (arg === '--json') {
      result.flags.json = true;
    } else if (arg === '--quiet' || arg === '-q') {
      result.flags.quiet = true;
    } else if (arg === '--debug') {
      result.flags.debug = true;
    } else if (arg.startsWith('--')) {
      // Named option (--key=value or --key value)
      const [key, val] = arg.slice(2).split('=');
      if (val !== undefined) {
        result.options[key] = val;
      } else if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        result.options[key] = args[++i];
      } else {
        result.options[key] = true;
      }
    } else if (!result.command) {
      result.command = arg;
    } else {
      result.args.push(arg);
    }
    i++;
  }

  // Default JSON from env
  if (process.env.LIKU_JSON === '1') {
    result.flags.json = true;
  }

  return result;
}

/**
 * Render a normalized execution failure
 */
function renderExecutionFailure(execution, flags, commandName) {
  if (!execution || execution.ok !== false) {
    return;
  }

  if (execution.error?.code === 'UNKNOWN_COMMAND') {
    error(`Unknown command: ${commandName}`);
    console.log(`\nRun ${highlight('liku --help')} for available commands.`);
    return;
  }

  if (execution.error?.code === 'PROJECT_GUARD_MISMATCH') {
    const payload = execution.error.payload || {
      success: false,
      error: 'PROJECT_GUARD_MISMATCH',
      expected: {},
      detected: {},
      details: [],
    };
    if (flags.json) {
        console.log(JSON.stringify(payload, null, 2));
    } else {
      error('Project guard mismatch');
      (payload.details || []).forEach((entry) => console.log(`- ${entry}`));
      console.log(`Detected root: ${payload.detected?.projectRoot}`);
      console.log(`Detected repo: ${payload.detected?.repoName}`);
    }
    return;
  }

  if (flags.debug && execution.cause) {
    console.error(execution.cause);
    return;
  }

  error(execution.error?.message || 'Command execution failed');
}

/**
 * Execute a top-level CLI command through the typed command seam
 */
async function dispatchCommand(name, cmdArgs, flags, options) {
  const request = buildCommandRequest({
    command: name,
    args: cmdArgs,
    flags,
    options,
    cwd: process.cwd(),
    env: process.env,
  });

  const execution = await executeCommandRequest(request);
  if (!execution.ok) {
    renderExecutionFailure(execution, flags, name);
    process.exit(execution.exitCode || 1);
  }

  if (flags.json && execution.result !== undefined) {
    console.log(JSON.stringify(execution.result, null, 2));
  }

  if (execution.success === false) {
    process.exit(execution.exitCode || 1);
  }
}

/**
 * Main entry point
 */
async function main() {
  // Bootstrap ~/.liku/ directory structure before any command runs
  const { ensureLikuStructure, migrateIfNeeded } = require('../shared/liku-home');
  ensureLikuStructure();
  migrateIfNeeded();

  const { command, args, flags, options } = parseArgs(process.argv);

  // Handle global flags
  if (flags.version) {
    showVersion();
    return;
  }

  if (flags.help || (!command && args.length === 0)) {
    showHelp();
    return;
  }

  // Default command is 'start' (launch Electron)
  const cmd = command || 'start';

  // Execute the command
  await dispatchCommand(cmd, args, flags, options);
}

if (require.main === module) {
  main().catch(err => {
    error(err.message);
    process.exit(1);
  });
}

module.exports = {
  dispatchCommand,
  main,
  parseArgs,
  renderExecutionFailure,
  showHelp,
  showVersion,
};
