const COMMANDS = Object.freeze({
  start: { desc: 'Start the Electron agent with overlay', file: 'start' },
  doctor: { desc: 'Diagnostics: version, environment, active window', file: 'doctor' },
  chat: { desc: 'Interactive AI chat in the terminal', file: 'chat' },
  click: { desc: 'Click element by text or coordinates', file: 'click', args: '<text|x,y>' },
  find: { desc: 'Find UI elements matching criteria', file: 'find', args: '<text>' },
  type: { desc: 'Type text at current cursor position', file: 'type', args: '<text>' },
  keys: { desc: 'Send keyboard shortcut', file: 'keys', args: '<combo>' },
  screenshot: { desc: 'Capture screenshot', file: 'screenshot', args: '[path]' },
  'verify-hash': { desc: 'Poll until screenshot hash changes', file: 'verify-hash' },
  'verify-stable': { desc: 'Wait until visual output is stable', file: 'verify-stable' },
  window: { desc: 'Focus or list windows', file: 'window', args: '[title]' },
  mouse: { desc: 'Move mouse to coordinates', file: 'mouse', args: '<x> <y>' },
  drag: { desc: 'Drag from one point to another', file: 'drag', args: '<x1> <y1> <x2> <y2>' },
  scroll: { desc: 'Scroll up or down', file: 'scroll', args: '<up|down> [amount]' },
  wait: { desc: 'Wait for element to appear', file: 'wait', args: '<text> [timeout]' },
  repl: { desc: 'Interactive automation shell', file: 'repl' },
  memory: { desc: 'Manage agent memory notes', file: 'memory', args: '[list|show|search|stats]' },
  skills: { desc: 'Manage the skill library', file: 'skills', args: '[list|search|show]' },
  tools: { desc: 'Manage dynamic tool registry', file: 'tools', args: '[list|show|approve|revoke]' },
  github: { desc: 'GitHub auth, capability, bounded plan, branch-associated PR status, reviewed issue/PR-comment previews, explicit apply, repo, issue, PR, workflow, and release diagnostics', file: 'github', args: '<auth|capabilities|context|plan|apply|repo|issues|pr|workflow|releases> ...' },
  analytics: { desc: 'View telemetry analytics', file: 'analytics', args: '[--days N] [--raw]' },
});

function getCommandRegistry() {
  return { ...COMMANDS };
}

function getCommandInfo(name) {
  return COMMANDS[String(name || '').trim()] || null;
}

function listCommands() {
  return Object.entries(COMMANDS).map(([name, info]) => ({ name, ...info }));
}

module.exports = {
  COMMANDS,
  getCommandRegistry,
  getCommandInfo,
  listCommands,
};
