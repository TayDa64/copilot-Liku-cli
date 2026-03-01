const { parseAIActions } = require('../src/main/system-automation');

function test(name, input, expectActions) {
  const result = parseAIActions(input);
  const hasActions = !!(result && result.actions && result.actions.length > 0);
  const pass = hasActions === expectActions;
  console.log(`${pass ? '✓' : '✗'} ${name}${!pass ? ` (expected ${expectActions}, got ${hasActions})` : ''}`);
  if (hasActions) console.log(`  Actions: ${JSON.stringify(result.actions.map(a => a.type))}`);
}

// JSON formats (should still work)
test('JSON code block', '```json\n{"thought":"test","actions":[{"type":"click","x":100,"y":200}]}\n```', true);
test('Raw JSON', '{"thought":"test","actions":[{"type":"key","key":"enter"}]}', true);
test('Inline JSON', 'Here is what I will do: {"thought":"test","actions":[{"type":"type","text":"hello"}]} and verify', true);

// Natural language fallbacks
test('NL click with coords', 'I will click the Submit button at (500, 300) to proceed.', true);
test('NL press Enter', 'After clicking I will press Enter to confirm.', true);
test('NL scroll down', 'I need to scroll down to see more content.', true);
test('NL click element with quotes', 'I will click on the "Save" button', true);

// Should NOT produce actions (observation/plan only)
test('Pure observation', 'I see several windows open including VS Code and Edge.', false);
test('Vague plan', 'Let me proceed with this task and locate the button.', false);
test('Screenshot request only', 'Let me take a screenshot to get a better view.', false);
test('Capability listing', 'My capabilities include clicking, typing, and scrolling.', false);

console.log('\nDone.');
