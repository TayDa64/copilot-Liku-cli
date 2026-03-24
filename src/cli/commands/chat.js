/**
 * chat command - Interactive AI chat in the terminal
 * @module cli/commands/chat
 */

const readline = require('readline');
const { success, error, info, warn, highlight, dim, bold } = require('../util/output');
const systemAutomation = require('../../main/system-automation');
const preferences = require('../../main/preferences');
const {
  getLogLevel: getUiAutomationLogLevel,
  resetLogSettings: resetUiAutomationLogSettings,
  setLogLevel: setUiAutomationLogLevel
} = require('../../main/ui-automation/core/helpers');

function isInteractiveTranscript() {
  return !!process.stdin.isTTY && !!process.stdout.isTTY;
}

function formatWatcherStatus(watcher) {
  if (!watcher) return 'UI Watcher: unavailable';
  const status = watcher.isPolling ? 'polling' : 'inactive';
  const interval = Number.isFinite(Number(watcher.options?.pollInterval))
    ? ` ${Number(watcher.options.pollInterval)}ms`
    : '';
  return `UI Watcher: ${status}${interval}`;
}

function extractPlanMacro(text) {
  const requested = /\(plan\)/i.test(String(text || ''));
  return {
    requested,
    cleanedText: String(text || '').replace(/\(plan\)/ig, ' ').replace(/\s{2,}/g, ' ').trim()
  };
}

function formatPlanOnlyResult(result) {
  const payload = result?.result || result;
  if (!payload) return 'Plan created, but no details were returned.';
  const lines = [];
  if (payload.plan?.rawPlan) {
    lines.push(payload.plan.rawPlan.trim());
  }
  if (Array.isArray(payload.tasks) && payload.tasks.length > 0) {
    lines.push('');
    lines.push('Tasks:');
    payload.tasks.forEach((task) => {
      lines.push(`- ${task.step}. ${task.description} [${task.targetAgent}]`);
    });
  }
  if (Array.isArray(payload.assumptions) && payload.assumptions.length > 0) {
    lines.push('');
    lines.push('Assumptions:');
    payload.assumptions.forEach((assumption) => lines.push(`- ${assumption}`));
  }
  return lines.join('\n').trim() || 'Plan created successfully.';
}

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

function isLikelyAutomationInput(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;

  // Explicit acknowledgements/chit-chat should never execute actions.
  if (/^(thanks|thank you|awesome|great|nice|outstanding work|good job|perfect|cool|ok|okay|got it|sounds good|that works)[!.\s]*$/i.test(t)) {
    return false;
  }

  // Lightweight intent signals for actual executable tasks.
  return /(open|launch|search|play|click|type|press|scroll|drag|close|minimize|restore|focus|bring|navigate|go to|run|execute|find|select|choose|pick|set|change|switch|adjust|update|create|add|remove|alert|timeframe|indicator|watchlist|tool|draw|place|save|submit|capture|screenshot|screen shot)/i.test(t);
}

function isLikelyApprovalOrContinuationInput(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;

  return /^(yes|y|yeah|yep|sure|ok|okay|go ahead|do it|do that|please do|continue|proceed|next)$/i.test(t);
}

function shouldExecuteDetectedActions(currentLine, executionIntent, actionData) {
  const hasActions = !!(actionData && Array.isArray(actionData.actions) && actionData.actions.length > 0);
  if (!hasActions) return false;
  if (isLikelyAutomationInput(executionIntent)) return true;
  if (isLikelyApprovalOrContinuationInput(currentLine)) return true;
  return false;
}

function isLikelyObservationInput(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;

  return /(what do you see|what can you see|tell me what you see|describe( what)? you see|describe the (screen|window|app)|what controls|what can you use|what is visible|what's visible|enumerate.*controls|which controls)/i.test(t);
}

function isLikelyToolInventoryInput(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;

  return /(what tools|what controls|tools you can use|controls you can use|what do you have access|what can you use)/i.test(t);
}

function isScreenshotOnlyPlan(actionData) {
  const actions = Array.isArray(actionData?.actions) ? actionData.actions : [];
  if (!actions.length) return false;

  const meaningful = actions.filter((action) => action?.type !== 'wait');
  if (!meaningful.length) return false;
  return meaningful.every((action) => action?.type === 'screenshot');
}

function buildForcedObservationAnswerPrompt(userMessage) {
  const inventoryHint = isLikelyToolInventoryInput(userMessage)
    ? 'For the available-tools portion, organize the answer into exactly three buckets: direct UIA controls, reliable keyboard/window controls, and visible but screenshot-only controls.'
    : 'Answer as a direct observation of the current app/window state.';

  return [
    'You already have fresh visual context for the current target window.',
    'Do NOT request or plan another screenshot unless the latest capture explicitly failed or the screen materially changed.',
    'Respond now in natural language only — no JSON action block.',
    inventoryHint
  ].join(' ');
}

function shouldAutoCaptureObservationAfterActions(userMessage, actions, execResult) {
  if (!isLikelyObservationInput(userMessage)) return false;
  if (!Array.isArray(actions) || actions.length === 0) return false;
  if (execResult?.cancelled || execResult?.screenshotCaptured) return false;
  if (actions.some((action) => action?.type === 'screenshot')) return false;

  const hasWindowActivation = actions.some((action) =>
    action?.type === 'focus_window'
    || action?.type === 'bring_window_to_front'
    || action?.type === 'restore_window'
  );
  const hasLaunchVerification = actions.some((action) => !!action?.verifyTarget);
  return hasWindowActivation || hasLaunchVerification;
}

async function waitForFreshObservationContext(ai, execResult) {
  const focusVerification = execResult?.focusVerification || null;
  if (focusVerification?.applicable && !focusVerification?.verified) {
    warn('Focus drifted away from the target window after execution; skipping automatic observation continuation.');
    return false;
  }

  const watcher = typeof ai?.getUIWatcher === 'function' ? ai.getUIWatcher() : null;
  if (!watcher || !watcher.isPolling || typeof watcher.waitForFreshState !== 'function') {
    return true;
  }

  const expectedWindowHandle = Number(focusVerification?.expectedWindowHandle || 0);
  const timeoutMs = Math.max(1200, Number(watcher.options?.pollInterval || 400) * 4);
  const freshState = await watcher.waitForFreshState({
    targetHwnd: expectedWindowHandle || undefined,
    sinceTs: Date.now(),
    timeoutMs
  });

  if (!freshState?.fresh) {
    warn('UI watcher did not produce a fresh focused-window update before observation; using screenshot context with potentially stale Live UI State.');
  }

  return true;
}

function askQuestion(rl, prompt) {
  return new Promise(resolve => rl.question(prompt, resolve));
}

async function readScriptedInputs() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\r/g, ''));
}

async function promptForInput(session, prompt, options = {}) {
  if (Array.isArray(session.scriptedInputs)) {
    if (prompt) process.stdout.write(prompt);
    const next = session.scriptedInputs.length > 0 ? session.scriptedInputs.shift() : 'exit';
    process.stdout.write(`${next}\n`);
    return next;
  }
  return askQuestion(session.rl, prompt);
}

function createReadline() {
  const interactiveTerminal = !!process.stdin.isTTY && !!process.stdout.isTTY;
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: interactiveTerminal
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

    let lastCategory = null;
    for (let i = 0; i < models.length; i++) {
      const m = models[i];
      if (m.categoryLabel && m.categoryLabel !== lastCategory) {
        stdout.write(`${dim(m.categoryLabel)}\n`);
        renderedLines += 1;
        lastCategory = m.categoryLabel;
      }
      const cursor = i === index ? '>' : ' ';
      const capabilities = Array.isArray(m.capabilityList) && m.capabilityList.length
        ? dim(` [${m.capabilityList.join(', ')}]`)
        : '';
      const multiplier = m.premiumMultiplier ? dim(` [${m.premiumMultiplier}x]`) : '';
      const recommendations = Array.isArray(m.recommendationTags) && m.recommendationTags.length
        ? dim(` [${m.recommendationTags.join(', ')}]`)
        : '';
      const current = m.current ? dim(' (current)') : '';
      stdout.write(`${cursor} ${m.id} - ${m.name}${capabilities}${multiplier}${recommendations}${current}\n`);
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
  /state      Show or clear session intent constraints
  /login      Authenticate with GitHub Copilot
  /model      Interactive model picker (↑/↓ + Enter) or set directly (e.g. /model gpt-4o)
  /sequence   Toggle guided step-by-step execution (on by default)
  /recipes    Toggle bounded popup follow-up recipes (off by default)
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

function formatResponseHeader(resp) {
  const provider = resp?.provider || 'ai';
  const runtimeModel = resp?.model ? `:${resp.model}` : '';
  const requestedSuffix = resp?.requestedModel && resp.requestedModel !== resp.model
    ? ` via ${resp.requestedModel}`
    : '';
  return `[${provider}${runtimeModel}${requestedSuffix}]`;
}

function printTranscriptBlock(lines = []) {
  console.log(lines.map((line) => String(line ?? '')).join('\n'));
}

function printAssistantMessage(resp) {
  printTranscriptBlock([
    '',
    dim(formatResponseHeader(resp)),
    resp.message || '',
    ''
  ]);
}

function printPlanMessage(result) {
  printTranscriptBlock([
    '',
    dim('[planner]'),
    formatPlanOnlyResult(result),
    ''
  ]);
}

function printActionProgress(result, idx, total) {
  const prefix = dim(`[${idx + 1}/${total}]`);
  if (result.success) {
    console.log(`${prefix} ${result.action || result.type || 'action'}: ${dim(result.message || 'ok')}`);
    if (result.stdout && result.stdout.trim()) {
      const lines = result.stdout.trim().split('\n');
      const display = lines.length > 8 ? lines.slice(0, 8).join('\n') + `\n... (${lines.length - 8} more lines)` : lines.join('\n');
      console.log(dim(display));
    }
    return;
  }

  const failDetail = result.error || result.message || result.stderr || '';
  console.log(`${prefix} ${result.action || result.type || 'action'}: ${dim('failed')} ${failDetail}`);
}

function printCommandResult(cmdResult) {
  if (cmdResult?.type === 'error') {
    error(cmdResult.message);
    return;
  }
  if (cmdResult?.type === 'system') {
    success(cmdResult.message);
    return;
  }
  if (cmdResult?.message) {
    console.log(cmdResult.message);
  }
}

async function autoCapture(ai, options = {}) {
  const captureScope = options.scope === 'active-window' ? 'window' : 'screen';
  try {
    const { screenshot, screenshotActiveWindow } = require('../../main/ui-automation/screenshot');
    const capture = captureScope === 'window' ? screenshotActiveWindow : screenshot;
    const result = await capture({ memory: true, base64: true, metric: 'sha256' });
    if (result && result.success && result.base64) {
      ai.addVisualContext({
        dataURL: `data:image/png;base64,${result.base64}`,
        width: 0, height: 0, scope: captureScope, timestamp: Date.now()
      });
      info(captureScope === 'window'
        ? 'Auto-captured active window for visual context.'
        : 'Auto-captured screenshot for visual context.');
      return true;
    }

    if (captureScope === 'window') {
      warn('Active-window screenshot capture returned no data. Falling back to full-screen capture.');
      const fallback = await screenshot({ memory: true, base64: true, metric: 'sha256' });
      if (fallback && fallback.success && fallback.base64) {
        ai.addVisualContext({
          dataURL: `data:image/png;base64,${fallback.base64}`,
          width: 0, height: 0, scope: 'screen', timestamp: Date.now()
        });
        info('Fallback full-screen screenshot captured for visual context.');
        return true;
      }
    }

    warn(captureScope === 'window'
      ? 'Active-window screenshot capture returned no data.'
      : 'Screenshot capture returned no data.');
  } catch (e) {
    warn(`Auto-screenshot failed: ${e.message}. Use /capture manually.`);
  }
  return false;
}

async function executeActionBatchWithSafeguards(ai, actionData, session, userMessage, options = {}) {
  const enablePopupRecipes = !!options.enablePopupRecipes;
  let pendingSafety = null;
  let screenshotCaptured = false;
  const execResult = await ai.executeActions(
    actionData,
    (result, idx, total) => printActionProgress(result, idx, total),
    async () => {
      const ok = await autoCapture(ai);
      if (ok) screenshotCaptured = true;
    },
    {
      onRequireConfirmation: (safety) => {
        pendingSafety = safety;
      },
      userMessage,
      enablePopupRecipes
    }
  );

  if (!execResult.pendingConfirmation) {
    return { ...execResult, screenshotCaptured };
  }

  const safety = pendingSafety;
  if (safety) {
    warn(`Confirmation required (${safety.riskLevel}): ${safety.description}`);
    if (safety.warnings && safety.warnings.length) {
      safety.warnings.forEach(w => warn(`- ${w}`));
    }
  } else {
    warn('Confirmation required for a pending action.');
  }

  const ans = (await promptForInput(session, highlight('Execute anyway? (y/N) '))).trim().toLowerCase();
  if (ans === 'y' || ans === 'yes') {
    const actionId = execResult.pendingActionId;
    if (actionId) ai.confirmPendingAction(actionId);
    const resumed = await ai.resumeAfterConfirmation(
      (result, idx, total) => printActionProgress(result, idx, total),
      async () => {
        const ok = await autoCapture(ai);
        if (ok) screenshotCaptured = true;
      },
      {
        userMessage,
        enablePopupRecipes
      }
    );
    return { ...resumed, screenshotCaptured };
  }

  if (execResult.pendingActionId) {
    ai.rejectPendingAction(execResult.pendingActionId);
  }
  return { success: false, cancelled: true, error: 'Execution cancelled by user' };
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
  let sequenceMode = false;
  let popupRecipesEnabled = false;

  let lastNonTrivialUserMessage = '';

  const scriptedInputs = Array.isArray(options.scriptedInputs) ? [...options.scriptedInputs] : null;
  let rl = scriptedInputs ? null : createReadline();
  const session = { rl, scriptedInputs };

  console.log(`\n${bold('Liku Chat')} ${dim('(type /help for commands, exit to quit)')}`);
  info(`execute=${executeMode}${model ? `, model=${model}` : ''}`);

  while (true) {
    let line = '';
    try {
      line = (await promptForInput(session, highlight('> '))).trim();
    } catch (e) {
      // If readline gets into a bad state (e.g., raw mode interruption), recover.
      if (!session.scriptedInputs) {
        try { rl.close(); } catch {}
        rl = createReadline();
        session.rl = rl;
      }
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

      if (lower === '/sequence' || lower.startsWith('/sequence ')) {
        const parts = lower.split(/\s+/).filter(Boolean);
        const arg = parts[1] || 'status';
        if (arg === 'on') {
          sequenceMode = true;
          success('Guided sequence mode enabled. Sequence runs continuously; only risky actions require extra confirmation.');
        } else if (arg === 'off') {
          sequenceMode = false;
          warn('Guided sequence mode disabled.');
        } else {
          info(`Guided sequence mode: ${sequenceMode ? 'on' : 'off'}`);
        }
        continue;
      }

      if (lower === '/recipes' || lower.startsWith('/recipes ')) {
        const parts = lower.split(/\s+/).filter(Boolean);
        const arg = parts[1] || 'status';
        if (arg === 'on') {
          popupRecipesEnabled = true;
          success('Popup follow-up recipes enabled (opt-in, bounded).');
        } else if (arg === 'off') {
          popupRecipesEnabled = false;
          warn('Popup follow-up recipes disabled.');
        } else {
          info(`Popup follow-up recipes: ${popupRecipesEnabled ? 'on' : 'off'}`);
        }
        continue;
      }

      // Interactive model picker
      if (lower === '/model') {
        try {
          if (typeof ai.discoverCopilotModels === 'function') {
            await Promise.resolve(ai.discoverCopilotModels());
          }
          const models = (await Promise.resolve(ai.getCopilotModels())).filter((modelItem) => modelItem.selectable !== false);
          if (!Array.isArray(models) || models.length === 0) {
            warn('No models available.');
            continue;
          }

          const canInteractive = !!process.stdin.isTTY && typeof process.stdin.setRawMode === 'function';
          if (!canInteractive) {
            const cmdResult = await Promise.resolve(ai.handleCommand('/model'));
            printCommandResult(cmdResult);
            continue;
          }

          let chosen;
          let pickerError = null;
          try {
            if (rl) {
              try { rl.close(); } catch {}
            }
            chosen = await interactiveSelectModel(models);
          } catch (e) {
            pickerError = e;
          } finally {
            rl = createReadline();
            session.rl = rl;
          }

          if (pickerError) {
            warn(`Interactive picker failed: ${pickerError.message}`);
            // fall back to normal /model output
            const cmdResult = await Promise.resolve(ai.handleCommand('/model'));
            printCommandResult(cmdResult);
            continue;
          }

          // Non-interactive session (piped input): fall back to standard /model output.
          if (chosen === undefined) {
            const cmdResult = await Promise.resolve(ai.handleCommand('/model'));
            printCommandResult(cmdResult);
            continue;
          }

          if (chosen === null) {
            info('Cancelled.');
            continue;
          }

          const cmdResult = await Promise.resolve(ai.handleCommand(`/model ${chosen.id}`));
          printCommandResult(cmdResult);
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
        printCommandResult(cmdResult);
      } catch (e) {
        error(e.message);
      }
      continue;
    }

    const includeVisualUsed = includeVisualNext;
    const planMacro = extractPlanMacro(line);

    if (planMacro.requested) {
      try {
        const { getOrchestrator } = require('./agent');
        info('Planning mode: delegating to multi-agent supervisor.');
        const planResult = await getOrchestrator().plan(planMacro.cleanedText || line, { mode: 'plan-only' });
        if (!planResult.success) {
          error(planResult.error || 'Planning mode failed');
          continue;
        }
        printPlanMessage(planResult.result);
        continue;
      } catch (planError) {
        warn(`Planning mode unavailable, falling back to standard chat: ${planError.message}`);
      }
    }

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
    if (resp.routingNote) {
      info(resp.routingNote);
    }
    printAssistantMessage(resp);

    let actionData = ai.parseActions(resp.message);
    let hasActions = !!(actionData && Array.isArray(actionData.actions) && actionData.actions.length > 0);

    if (!hasActions) continue;

    if (!shouldExecuteDetectedActions(line, executionIntent, actionData)) {
      info('Non-action message detected; skipping action execution.');
      continue;
    }

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
      let hasRiskyAction = false;
      if (typeof ai.analyzeActionSafety === 'function') {
        for (const action of actionData.actions) {
          try {
            const safety = ai.analyzeActionSafety(action, {
              text: action?.reason || '',
              buttonText: action?.targetText || '',
              nearbyText: []
            });
            if (safety?.requiresConfirmation) {
              hasRiskyAction = true;
              break;
            }
          } catch {}
        }
      }

      if (!hasRiskyAction) {
        info(`Low-risk sequence (${actionData.actions.length} step${actionData.actions.length === 1 ? '' : 's'}) detected. Running without pre-approval.`);
        shouldExecute = true;
      }

      if (!shouldExecute) {
      while (true) {
        const ans = (await promptForInput(session, highlight(`Run ${actionData.actions.length} action(s)? (y/N/a/d/c) `)))
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

          const correction = (await promptForInput(session, highlight('What should I learn for this app? ')))
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

          printAssistantMessage(resp);
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
    }

    if (!shouldExecute) {
      continue;
    }

    let execResult = null;
    const effectiveUserMessage = isContinueLike ? lastNonTrivialUserMessage : line;

    if (sequenceMode) {
      info(`Guided sequence: executing ${actionData.actions.length} step(s) continuously.`);
    }
    execResult = await executeActionBatchWithSafeguards(
      ai,
      actionData,
      session,
      effectiveUserMessage,
      { enablePopupRecipes: popupRecipesEnabled }
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

    if (execResult?.cancelled) {
      continue;
    }

    if (execResult?.postVerificationFailed) {
      warn(execResult.error || 'Post-action verification could not confirm target after retries.');
      const fg = execResult?.postVerification?.foreground;
      if (fg && fg.success) {
        info(`Foreground after retries: ${fg.processName || 'unknown'} | ${fg.title || 'untitled'}`);
      }
    }

    if (execResult?.postVerification?.needsFollowUp) {
      const hint = execResult?.postVerification?.popupHint;
      warn(`Detected a likely post-launch dialog${hint ? `: ${hint}` : ''}. I can continue with synthesis/actions to complete startup.`);
    }

    if (execResult?.postVerification?.popupRecipe?.attempted) {
      const details = execResult.postVerification.popupRecipe;
      const recipeLabel = details.recipeId ? ` [${details.recipeId}]` : '';
      info(`Popup recipe${recipeLabel} attempted (${details.steps} step${details.steps === 1 ? '' : 's'})${details.completed ? '' : ' with partial completion'}.`);
    }

    if (Array.isArray(execResult?.postVerification?.runningPids) && execResult.postVerification.runningPids.length) {
      info(`Running target PID(s): ${execResult.postVerification.runningPids.join(', ')}`);
    }

    if (!execResult?.success) {
      error(execResult.error || 'One or more actions failed');
    }

    if (execResult?.success && shouldAutoCaptureObservationAfterActions(effectiveUserMessage, actionData?.actions, execResult)) {
      const readyForObservation = await waitForFreshObservationContext(ai, execResult);
      if (readyForObservation) {
        const captured = await autoCapture(ai, { scope: 'active-window' });
        if (captured) {
          execResult.screenshotCaptured = true;
        }
      }
    }

    // ===== VISION AUTO-CONTINUATION =====
    // If the AI requested a screenshot during its action sequence AND we captured it,
    // automatically send a follow-up message so the AI can analyze the capture and
    // continue (e.g., click on a search result it can now "see").
    const MAX_VISION_CONTINUATIONS = 3;
    if (execResult?.screenshotCaptured && execResult?.success) {
      let visionContinuations = 0;
      let lastClickCoords = null; // Track repeated coordinate clicks
      let lastRecoveryPhase = null;

      while (visionContinuations < MAX_VISION_CONTINUATIONS) {
        visionContinuations++;
        info(`Vision continuation ${visionContinuations}/${MAX_VISION_CONTINUATIONS}: analyzing screenshot...`);

        // Detect stale repeated clicks — if the AI keeps clicking the same spot, the
        // coordinate estimate is likely wrong. Guide it toward keyboard strategies.
        let staleClickHint = '';
        if (lastClickCoords && visionContinuations > 1) {
          staleClickHint = `\n\nIMPORTANT: Your previous click at (${lastClickCoords.x}, ${lastClickCoords.y}) did not navigate the page. The coordinate click likely missed the target. DO NOT click the same coordinates again. Instead, use one of these strategies:\n1. If you can see the target URL (e.g., https://www.apple.com), navigate via the address bar: Ctrl+L → type the URL → Enter\n2. Use Ctrl+F to find the link text on the page, then close find bar and try clicking\n3. Try different coordinates (offset by 10-20 pixels from your previous attempt)`;
        }

        const continuationPrompt = visionContinuations === 1
          ? `I've captured a screenshot of the current screen state after your actions completed. Please analyze it and continue with the next steps to accomplish the original goal. The screenshot is included as visual context.${staleClickHint}`
          : `Here is an updated screenshot. Continue with the next steps.${staleClickHint}`;

        const continuationSystemMessages = [`Original user request: ${effectiveUserMessage}`];
        if (typeof ai.getBrowserRecoverySnapshot === 'function') {
          const recovery = ai.getBrowserRecoverySnapshot(effectiveUserMessage);
          if (recovery?.directive) {
            continuationSystemMessages.push(recovery.directive);
          }
          if (recovery?.phase) {
            lastRecoveryPhase = recovery.phase;
          }
        }

        const contResp = await ai.sendMessage(continuationPrompt, {
          includeVisualContext: true,
          model,
          extraSystemMessages: continuationSystemMessages
        });

        if (!contResp.success) {
          error(contResp.error || 'Vision continuation failed');
          break;
        }

        printAssistantMessage(contResp);

        const contActionData = ai.parseActions(contResp.message);
        const contHasActions = !!(contActionData && Array.isArray(contActionData.actions) && contActionData.actions.length > 0);

        if (!contHasActions) {
          // AI responded with text only — task is likely complete or AI is reporting results.
          break;
        }

        if (isLikelyObservationInput(effectiveUserMessage) && isScreenshotOnlyPlan(contActionData)) {
          warn('Observation continuation requested another screenshot despite fresh visual context; forcing a direct answer instead.');
          const forcedAnswerResp = await ai.sendMessage(buildForcedObservationAnswerPrompt(effectiveUserMessage), {
            includeVisualContext: true,
            model,
            extraSystemMessages: continuationSystemMessages
          });

          if (!forcedAnswerResp.success) {
            error(forcedAnswerResp.error || 'Forced observation answer failed');
            break;
          }

          printAssistantMessage(forcedAnswerResp);
          const forcedActions = ai.parseActions(forcedAnswerResp.message);
          const forcedHasActions = !!(forcedActions && Array.isArray(forcedActions.actions) && forcedActions.actions.length > 0);
          if (forcedHasActions) {
            warn('Forced observation answer still returned actions; stopping to avoid screenshot-only loops.');
          }
          break;
        }

        if (!isLikelyAutomationInput(effectiveUserMessage)) break;

        if (typeof ai.preflightActions === 'function') {
          const rewritten = ai.preflightActions(contActionData, { userMessage: effectiveUserMessage });
          if (rewritten && rewritten !== contActionData) {
            info('Adjusted continuation plan for reliability.');
          }
        }

        info(`Vision continuation: executing ${contActionData.actions.length} step(s).`);

        // Track the first coordinate click in this continuation for stale-click detection
        const clickAction = contActionData.actions.find(a => a.type === 'click' && a.x !== undefined);
        if (clickAction) {
          if (lastClickCoords && clickAction.x === lastClickCoords.x && clickAction.y === lastClickCoords.y) {
            // Same coordinates as last time — the smart browser click interceptor in
            // ai-service should handle this, but log for visibility.
            info(`Repeated click at (${clickAction.x}, ${clickAction.y}) — smart browser click may intercept.`);
          }
          lastClickCoords = { x: clickAction.x, y: clickAction.y };
        }

        const contExecResult = await executeActionBatchWithSafeguards(
          ai,
          contActionData,
          session,
          effectiveUserMessage,
          { enablePopupRecipes: popupRecipesEnabled }
        );

        if (contExecResult?.cancelled) break;

        if (!contExecResult?.success) {
          error(contExecResult?.error || 'Continuation actions failed');
          break;
        }

        // If the continuation itself requested another screenshot, loop again
        if (!contExecResult?.screenshotCaptured) break;
      }

      if (visionContinuations >= MAX_VISION_CONTINUATIONS) {
        info('Reached max vision continuations. Returning to prompt.');
        if (lastRecoveryPhase === 'result-selection') {
          info('Browser recovery stopped in result-selection mode. The next step should be choosing a visible search result, not guessing another URL.');
        } else if (lastRecoveryPhase === 'discovery-search') {
          info('Browser recovery stopped in discovery mode. The next step should be loading and inspecting a search results page.');
        }
      }
    }

  }

  if (rl) rl.close();
}

async function run(args, flags) {
  if (flags.help || args.includes('--help')) {
    showHelp();
    return { success: true };
  }

  const interactiveTranscript = isInteractiveTranscript();
  const previousTranscriptQuiet = process.env.LIKU_CHAT_TRANSCRIPT_QUIET;
  const previousUiAutomationLogLevel = getUiAutomationLogLevel();

  if (interactiveTranscript) {
    process.env.LIKU_CHAT_TRANSCRIPT_QUIET = '1';
    setUiAutomationLogLevel('warn');
  }

  const ai = require('../../main/ai-service');
  const { getUIWatcher } = require('../../main/ui-watcher');
  let watcher = null;
  let watcherStartedByChat = false;

  try {
    watcher = getUIWatcher({
      pollInterval: 400,
      focusedWindowOnly: false,
      enabled: true,
      quiet: interactiveTranscript
    });
    if (!watcher.isPolling) {
      watcher.start();
      watcherStartedByChat = true;
    }
    if (typeof ai.setUIWatcher === 'function') {
      ai.setUIWatcher(watcher);
    }
    if (interactiveTranscript) {
      console.log(dim(formatWatcherStatus(watcher)));
    } else {
      info(`UI Watcher: ${watcher.isPolling ? 'polling' : 'inactive'}`);
    }
  } catch (e) {
    warn(`UI Watcher unavailable: ${e.message}`);
  }

  // Quick hint if user expected command REPL
  if (flags.quiet !== true) {
    console.log(dim('Tip: use /login to authenticate, /status to verify.'));
  }

  try {
    const scriptedInputs = !process.stdin.isTTY ? await readScriptedInputs() : null;
    await runChatLoop(ai, { ...flags, scriptedInputs });
  } finally {
    // N4: Save session summary as episodic memory note on exit
    try {
      if (typeof ai.saveSessionNote === 'function') {
        ai.saveSessionNote();
      }
    } catch {}
    if (watcher && watcherStartedByChat) {
      try { watcher.stop(); } catch {}
    }
    if (interactiveTranscript) {
      if (previousTranscriptQuiet === undefined) {
        delete process.env.LIKU_CHAT_TRANSCRIPT_QUIET;
      } else {
        process.env.LIKU_CHAT_TRANSCRIPT_QUIET = previousTranscriptQuiet;
      }
      setUiAutomationLogLevel(previousUiAutomationLogLevel);
    } else {
      resetUiAutomationLogSettings();
    }
  }

  return { success: true };
}

module.exports = { run, showHelp };
