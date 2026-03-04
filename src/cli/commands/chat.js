/**
 * chat command - Interactive AI chat in the terminal
 * @module cli/commands/chat
 */

const readline = require('readline');
const { success, error, info, warn, highlight, dim, bold } = require('../util/output');
const systemAutomation = require('../../main/system-automation');
const preferences = require('../../main/preferences');

async function interactiveSelectFromList({ rl, items, title, formatItem }) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return undefined;
  }

  const stdin = process.stdin;
  const stdout = process.stdout;

  const originalRawMode = !!stdin.isRaw;
  const originalListeners = stdin.listeners('keypress');

  // readline must be told to emit keypress events.
  readline.emitKeypressEvents(stdin);

  // Temporarily pause the line editor while we own stdin.
  try { rl.pause(); } catch {}

  let index = Math.max(0, items.findIndex(i => i && i.current));

  let renderedLines = 0;
  const clearRendered = () => {
    if (renderedLines <= 0) return;
    // Move cursor up and clear each line.
    for (let i = 0; i < renderedLines; i++) {
      stdout.write('\x1b[1A');
      stdout.write('\x1b[2K');
    }
    renderedLines = 0;
  };

  const render = () => {
    clearRendered();
    const header = `${bold(title)} ${dim('(↑/↓ to select, Enter to confirm, Esc to cancel)')}`;
    stdout.write(`\n${header}\n`);
    renderedLines += 2;

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const cursor = i === index ? '>' : ' ';
      const line = formatItem(it);
      stdout.write(`${cursor} ${line}\n`);
      renderedLines += 1;
    }
  };

  return new Promise((resolve) => {
    let done = false;

    const cleanup = (result) => {
      if (done) return;
      done = true;

      try {
        stdin.off('keypress', onKeypress);
      } catch {}

      // Restore prior keypress listeners (if any were installed elsewhere)
      try {
        for (const l of originalListeners) stdin.on('keypress', l);
      } catch {}

      try { stdin.setRawMode(originalRawMode); } catch {}
      try { stdout.write('\x1b[?25h'); } catch {}

      // Leave the menu on screen; just ensure we end cleanly.
      stdout.write('\n');

      try { rl.resume(); } catch {}
      resolve(result);
    };

    const onKeypress = (_str, key = {}) => {
      if (!key) return;
      if (key.name === 'up') {
        index = (index - 1 + items.length) % items.length;
        render();
        return;
      }
      if (key.name === 'down') {
        index = (index + 1) % items.length;
        render();
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        cleanup(items[index]);
        return;
      }
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        cleanup(null);
      }
    };

    try {
      // Prevent cursor blinking while selecting.
      stdout.write('\x1b[?25l');
    } catch {}

    try { stdin.setRawMode(true); } catch {}

    // Remove any existing keypress listeners while in picker.
    try {
      for (const l of originalListeners) stdin.off('keypress', l);
    } catch {}

    stdin.on('keypress', onKeypress);
    render();
  });
}

function parseBool(val, defaultValue = false) {
  if (val === undefined || val === null) return defaultValue;
  if (typeof val === 'boolean') return val;
  const s = String(val).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return defaultValue;
}

function askQuestion(rl, prompt) {
  return new Promise(resolve => rl.question(prompt, resolve));
}

function createReadline() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });
}

async function interactiveSelectModel(models) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return undefined;
  }

  const stdin = process.stdin;
  const stdout = process.stdout;

  const originalRawMode = !!stdin.isRaw;
  let index = Math.max(0, models.findIndex(m => m && m.current));
  if (!Number.isFinite(index) || index < 0) index = 0;

  let renderedLines = 0;
  const render = () => {
    // Clear previous render block
    if (renderedLines > 0) {
      try {
        readline.moveCursor(stdout, 0, -renderedLines);
        readline.clearScreenDown(stdout);
      } catch {}
      renderedLines = 0;
    }

    stdout.write(`\n${bold('Select Copilot model')} ${dim('(↑/↓ to select, Enter to confirm, Esc to cancel)')}\n`);
    renderedLines += 2;

    for (let i = 0; i < models.length; i++) {
      const m = models[i];
      const cursor = i === index ? '>' : ' ';
      const vision = m.vision ? ' 👁' : '';
      const current = m.current ? dim(' (current)') : '';
      stdout.write(`${cursor} ${m.id} - ${m.name}${vision}${current}\n`);
      renderedLines += 1;
    }
  };

  return new Promise((resolve) => {
    let done = false;
    let buffer = '';

    const cleanup = (result) => {
      if (done) return;
      done = true;
      try { stdin.off('data', onData); } catch {}
      try { stdin.setRawMode(originalRawMode); } catch {}
      try { stdout.write('\n'); } catch {}
      resolve(result);
    };

    const onData = (chunk) => {
      const s = chunk.toString('utf8');
      buffer += s;

      // Handle common keys
      if (buffer.includes('\u0003')) {
        // Ctrl+C
        cleanup(null);
        return;
      }

      // Arrow keys arrive as ESC [ A/B
      if (buffer.includes('\x1b[A')) {
        buffer = '';
        index = (index - 1 + models.length) % models.length;
        render();
        return;
      }
      if (buffer.includes('\x1b[B')) {
        buffer = '';
        index = (index + 1) % models.length;
        render();
        return;
      }

      // Enter
      if (buffer.includes('\r') || buffer.includes('\n')) {
        buffer = '';
        cleanup(models[index]);
        return;
      }

      // Escape alone cancels
      if (buffer === '\x1b') {
        buffer = '';
        cleanup(null);
      }

      // Prevent buffer from growing unbounded
      if (buffer.length > 16) buffer = buffer.slice(-16);
    };

    try {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onData);
      render();
    } catch {
      cleanup(undefined);
    }
  });
}

function showHelp() {
  console.log(`
${bold('Liku Terminal Chat')}
${dim('Interactive AI chat that can execute UI automation actions.')}

${highlight('Usage:')}
  liku chat [--execute prompt|true|false] [--model <copilotModelKey>]

${highlight('In-chat commands:')}
  /help       Show AI-service help
  /status     Show auth/provider/model status
  /login      Authenticate with GitHub Copilot
  /model      Interactive model picker (↑/↓ + Enter) or set directly (e.g. /model gpt-4o)
  /provider   Show/set provider
  /capture    Capture a screenshot into visual context
  /vision on  Include latest capture in NEXT message
  /vision off Clear visual context
  exit        Exit chat

${highlight('Notes:')}
  - This is different from ${highlight('liku repl')}: repl is a command shell, chat is AI-driven.
  - Action execution uses the same safety confirmations as the Electron overlay.
  - When prompted to run actions: ${highlight('a')} enables auto-run for the target app, ${highlight('d')} disables it,
    ${highlight('c')} teaches a new rule (preference) for this app.
`);
}

async function runChatLoop(ai, options) {
  let executeMode = 'prompt';
  const executeModeExplicit = options.execute !== undefined;
  if (options.execute !== undefined) {
    const raw = String(options.execute).trim().toLowerCase();
    if (raw === 'prompt') executeMode = 'prompt';
    else executeMode = parseBool(options.execute, true) ? 'auto' : 'off';
  }
  const model = typeof options.model === 'string' ? options.model : null;
  let includeVisualNext = false;

  let lastNonTrivialUserMessage = '';

  let rl = createReadline();

  console.log(`\n${bold('Liku Chat')} ${dim('(type /help for commands, exit to quit)')}`);
  info(`execute=${executeMode}${model ? `, model=${model}` : ''}`);

  while (true) {
    let line = '';
    try {
      line = (await askQuestion(rl, highlight('> '))).trim();
    } catch (e) {
      // If readline gets into a bad state (e.g., raw mode interruption), recover.
      try { rl.close(); } catch {}
      rl = createReadline();
      warn(`Input error; recovered prompt (${e.message})`);
      continue;
    }
    if (!line) continue;

    const lowerLine = line.toLowerCase();
    const isContinueLike = ['continue', 'proceed', 'go ahead', 'next'].includes(lowerLine);
    if (!line.startsWith('/') && !isContinueLike) {
      lastNonTrivialUserMessage = line;
    }

    const executionIntent = isContinueLike ? lastNonTrivialUserMessage : line;

    if (['exit', 'quit', 'q'].includes(line.toLowerCase())) {
      break;
    }

    // Slash commands are handled by ai-service
    if (line.startsWith('/')) {
      const lower = line.trim().toLowerCase();
      if (lower === '/vision on') includeVisualNext = true;
      if (lower === '/vision off') includeVisualNext = false;

      // Interactive model picker
      if (lower === '/model') {
        try {
          const models = await Promise.resolve(ai.getCopilotModels());
          if (!Array.isArray(models) || models.length === 0) {
            warn('No models available.');
            continue;
          }

          const canInteractive = !!process.stdin.isTTY && typeof process.stdin.setRawMode === 'function';
          if (!canInteractive) {
            const cmdResult = await Promise.resolve(ai.handleCommand('/model'));
            if (cmdResult?.type === 'error') error(cmdResult.message);
            else if (cmdResult?.type === 'system') success(cmdResult.message);
            else if (cmdResult?.message) console.log(cmdResult.message);
            continue;
          }

          // Stop readline while we take over raw-mode input.
          try { rl.close(); } catch {}

          let chosen;
          let pickerError = null;
          try {
            chosen = await interactiveSelectModel(models);
          } catch (e) {
            pickerError = e;
          } finally {
            // ALWAYS restore chat prompt; otherwise the chat loop can terminate.
            rl = createReadline();
          }

          if (pickerError) {
            warn(`Interactive picker failed: ${pickerError.message}`);
            // fall back to normal /model output
            const cmdResult = await Promise.resolve(ai.handleCommand('/model'));
            if (cmdResult?.type === 'error') error(cmdResult.message);
            else if (cmdResult?.type === 'system') success(cmdResult.message);
            else if (cmdResult?.message) console.log(cmdResult.message);
            continue;
          }

          // Non-interactive session (piped input): fall back to standard /model output.
          if (chosen === undefined) {
            const cmdResult = await Promise.resolve(ai.handleCommand('/model'));
            if (cmdResult?.type === 'error') error(cmdResult.message);
            else if (cmdResult?.type === 'system') success(cmdResult.message);
            else if (cmdResult?.message) console.log(cmdResult.message);
            continue;
          }

          if (chosen === null) {
            info('Cancelled.');
            continue;
          }

          const cmdResult = await Promise.resolve(ai.handleCommand(`/model ${chosen.id}`));
          if (cmdResult?.type === 'error') error(cmdResult.message);
          else if (cmdResult?.type === 'system') success(cmdResult.message);
          else if (cmdResult?.message) console.log(cmdResult.message);
          continue;
        } catch (e) {
          warn(`Interactive picker failed: ${e.message}`);
          // fall through to normal /model output
        }
      }

      try {
        const cmdResult = await Promise.resolve(ai.handleCommand(line));
        if (!cmdResult) {
          warn('Unknown command. Try /help');
          continue;
        }
        if (cmdResult.type === 'error') {
          error(cmdResult.message);
        } else if (cmdResult.type === 'system') {
          success(cmdResult.message);
        } else {
          console.log(cmdResult.message);
        }
      } catch (e) {
        error(e.message);
      }
      continue;
    }

    const includeVisualUsed = includeVisualNext;

    // Send message
    let resp = await ai.sendMessage(line, {
      includeVisualContext: includeVisualUsed,
      model
    });

    // One-shot visual: include in next message only.
    if (includeVisualNext) includeVisualNext = false;

    if (!resp.success) {
      error(resp.error || 'AI call failed');
      continue;
    }

    // Print assistant response
    console.log(`\n${dim(`[${resp.provider}${resp.model ? ':' + resp.model : ''}]`)}\n${resp.message}\n`);

    let actionData = ai.parseActions(resp.message);
    let hasActions = !!(actionData && Array.isArray(actionData.actions) && actionData.actions.length > 0);

    if (!hasActions) continue;

    if (typeof ai.preflightActions === 'function') {
      const rewritten = ai.preflightActions(actionData, { userMessage: executionIntent });
      if (rewritten && rewritten !== actionData) {
        actionData = rewritten;
        hasActions = !!(actionData && Array.isArray(actionData.actions) && actionData.actions.length > 0);
        info('Adjusted action plan for reliability.');
      }
    }

    // Determine which app these actions likely target so we can apply preferences.
    let targetProcessName = null;
    try {
      targetProcessName = preferences.resolveTargetProcessNameFromActions(actionData);
      if (!targetProcessName) {
        const fg = await systemAutomation.getForegroundWindowInfo();
        if (fg && fg.success && fg.processName) {
          targetProcessName = fg.processName;
        }
      }
    } catch {}

    let effectiveExecuteMode = executeMode;
    if (!executeModeExplicit && targetProcessName) {
      const policy = preferences.getAppPolicy(targetProcessName);
      if (policy?.executionMode === preferences.EXECUTION_MODE.AUTO) {
        effectiveExecuteMode = 'auto';
      }
    }

    if (effectiveExecuteMode === 'off') {
      info('Actions detected (execution disabled).');
      continue;
    }

    let shouldExecute = effectiveExecuteMode === 'auto';

    if (effectiveExecuteMode === 'prompt') {
      while (true) {
        const ans = (await askQuestion(rl, highlight(`Run ${actionData.actions.length} action(s)? (y/N/a/d/c) `)))
          .trim()
          .toLowerCase();

        if (ans === 'a') {
          if (targetProcessName) {
            const set = preferences.setAppExecutionMode(targetProcessName, preferences.EXECUTION_MODE.AUTO);
            if (set.success) {
              success(`Saved: auto-run enabled for app "${set.key}"`);
              effectiveExecuteMode = 'auto';
              shouldExecute = true;
              break;
            } else {
              warn(`Could not save preference: ${set.error || 'unknown error'}`);
            }
          } else {
            warn('Could not identify target app to save preference.');
          }
          continue;
        }

        if (ans === 'd') {
          if (targetProcessName) {
            const set = preferences.setAppExecutionMode(targetProcessName, preferences.EXECUTION_MODE.PROMPT);
            if (set.success) {
              success(`Saved: auto-run disabled for app "${set.key}"`);
            } else {
              warn(`Could not save preference: ${set.error || 'unknown error'}`);
            }
          } else {
            warn('Could not identify target app to save preference.');
          }
          info('Skipped.');
          shouldExecute = false;
          break;
        }

        if (ans === 'c') {
          if (!targetProcessName) {
            warn('Could not identify target app to teach a preference.');
            continue;
          }

          const correction = (await askQuestion(rl, highlight('What should I learn for this app? ')))
            .trim();
          if (!correction) {
            info('Cancelled.');
            continue;
          }

          let fgTitle = '';
          try {
            const fg = await systemAutomation.getForegroundWindowInfo();
            if (fg && fg.success && typeof fg.title === 'string') fgTitle = fg.title;
          } catch {}

          info('Learning preference (LLM parser)...');
          const parsed = await ai.parsePreferenceCorrection(correction, {
            processName: targetProcessName,
            title: fgTitle
          });

          if (!parsed.success) {
            warn(`Could not learn preference: ${parsed.error || 'unknown error'}`);
            continue;
          }

          const merged = preferences.mergeAppPolicy(targetProcessName, parsed.patch, { title: fgTitle });
          if (!merged.success) {
            warn(`Could not save preference: ${merged.error || 'unknown error'}`);
            continue;
          }

          success(`Learned for app "${merged.key}"`);
          info('Retrying with new rule applied...');

          resp = await ai.sendMessage(line, {
            includeVisualContext: includeVisualUsed,
            model,
            extraSystemMessages: [`User correction for this app: ${correction}`]
          });

          if (!resp.success) {
            error(resp.error || 'AI call failed');
            shouldExecute = false;
            break;
          }

          console.log(`\n${dim(`[${resp.provider}${resp.model ? ':' + resp.model : ''}]`)}\n${resp.message}\n`);
          actionData = ai.parseActions(resp.message);
          hasActions = !!(actionData && Array.isArray(actionData.actions) && actionData.actions.length > 0);
          if (!hasActions) {
            info('No actions detected after teaching.');
            shouldExecute = false;
            break;
          }
          // Re-prompt with updated action count.
          continue;
        }

        if (!(ans === 'y' || ans === 'yes')) {
          info('Skipped.');
          shouldExecute = false;
          break;
        }

        // Yes -> proceed to execute
        shouldExecute = true;
        break;
      }
    }

    if (!shouldExecute) {
      continue;
    }

    // Execute actions with safety confirmations
    let pendingSafety = null;
    const execResult = await ai.executeActions(
      actionData,
      (result, idx, total) => {
        const prefix = dim(`[${idx + 1}/${total}]`);
        if (result.success) {
          console.log(`${prefix} ${result.action || result.type || 'action'}: ${dim(result.message || 'ok')}`);
        } else {
          console.log(`${prefix} ${result.action || result.type || 'action'}: ${dim('failed')} ${result.error || ''}`);
        }
      },
      async () => {
        // Screenshot hook (best-effort): prompt user to /capture if they want visual context.
        warn('AI requested a screenshot. Use /capture to add visual context, then ask again.');
      },
      {
        onRequireConfirmation: (safety) => {
          pendingSafety = safety;
        },
        userMessage: isContinueLike ? lastNonTrivialUserMessage : line
      }
    );

    // Record auto-run outcomes and demote on repeated failures (UI drift).
    try {
      if (!executeModeExplicit && targetProcessName && effectiveExecuteMode === 'auto') {
        const outcome = preferences.recordAutoRunOutcome(targetProcessName, !!execResult.success);
        if (outcome?.demoted) {
          warn(`Auto-run demoted to prompt for app "${outcome.key}" (2 consecutive failures).`);
        }
      }
    } catch {}

    if (execResult.pendingConfirmation) {
      const safety = pendingSafety;
      if (safety) {
        warn(`Confirmation required (${safety.riskLevel}): ${safety.description}`);
        if (safety.warnings && safety.warnings.length) {
          safety.warnings.forEach(w => warn(`- ${w}`));
        }
      } else {
        warn('Confirmation required for a pending action.');
      }

      const ans = (await askQuestion(rl, highlight('Execute anyway? (y/N) '))).trim().toLowerCase();
      if (ans === 'y' || ans === 'yes') {
        const actionId = execResult.pendingActionId;
        if (actionId) ai.confirmPendingAction(actionId);
        const resumed = await ai.resumeAfterConfirmation(
          (result, idx, total) => {
            const prefix = dim(`[${idx + 1}/${total}]`);
            if (result.success) {
              console.log(`${prefix} ${result.action || result.type || 'action'}: ${dim(result.message || 'ok')}`);
            } else {
              console.log(`${prefix} ${result.action || result.type || 'action'}: ${dim('failed')} ${result.error || ''}`);
            }
          },
          async () => {
            warn('AI requested a screenshot. Use /capture to add visual context, then ask again.');
          },
          { userMessage: isContinueLike ? lastNonTrivialUserMessage : line }
        );
        if (!resumed.success) {
          error(resumed.error || 'Action execution failed');
        }

        // Also record the resumed outcome for auto-run drift handling.
        try {
          if (!executeModeExplicit && targetProcessName && effectiveExecuteMode === 'auto') {
            const outcome = preferences.recordAutoRunOutcome(targetProcessName, !!resumed.success);
            if (outcome?.demoted) {
              warn(`Auto-run demoted to prompt for app "${outcome.key}" (2 consecutive failures).`);
            }
          }
        } catch {}
      } else {
        if (execResult.pendingActionId) ai.rejectPendingAction(execResult.pendingActionId);
        info('Cancelled.');
      }
      continue;
    }

    if (!execResult.success) {
      error(execResult.error || 'One or more actions failed');
    }
  }

  rl.close();
}

async function run(args, flags) {
  if (flags.help || args.includes('--help')) {
    showHelp();
    return { success: true };
  }

  const ai = require('../../main/ai-service');

  // Quick hint if user expected command REPL
  if (flags.quiet !== true) {
    console.log(dim('Tip: use /login to authenticate, /status to verify.'));
  }

  await runChatLoop(ai, flags);
  return { success: true };
}

module.exports = { run, showHelp };
