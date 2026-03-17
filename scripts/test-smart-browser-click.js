/**
 * Test: Smart Browser Click Logic
 * Validates URL extraction, link-click detection, and text extraction patterns.
 */
const ai = require('../src/main/ai-service');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`PASS ${label}`);
    passed++;
  } else {
    console.log(`FAIL ${label}`);
    failed++;
  }
}

// ---- URL extraction from combined context ----
const urlRe = /https?:\/\/[^\s"'<>)]+/i;

// Test case 1: AI's actual thought from the test case
const thought1 = "The Google search results are displayed with 'Apple | Official Site' as the top result at https://www.apple.com. I'll click on the heading link.";
const urlMatch1 = thought1.match(urlRe);
assert(urlMatch1 && urlMatch1[0].includes('apple.com'), 'URL extracted from thought containing https://www.apple.com');

// Test case 2: reason without URL
const reason2 = "Click on 'Apple | Official Site' link to open the official Apple website";
const urlMatch2 = reason2.match(urlRe);
assert(!urlMatch2, 'No URL extracted from reason without URL');

// Test case 3: URL with trailing punctuation
const thought3 = "Navigate to https://www.apple.com.";
const urlMatch3 = thought3.match(urlRe);
const cleaned = urlMatch3 ? urlMatch3[0].replace(/[.,;:!?)]+$/, '') : '';
assert(cleaned === 'https://www.apple.com', 'URL trailing punctuation stripped correctly');

// ---- Link-click heuristic ----
const linkRe = /\blink\b|\bnav\b|\bwebsite\b|\bopen\b|\bhref\b|\burl\b/i;
assert(linkRe.test("Click on 'Apple | Official Site' link to open"), 'Link heuristic detects "link" + "open"');
assert(linkRe.test("Navigate to the website"), 'Link heuristic detects "website"');
assert(!linkRe.test("Close the dialog box"), 'Link heuristic does not match non-link actions');
assert(!linkRe.test("Click OK button to confirm"), 'Link heuristic does not match button clicks');

// ---- Text extraction from reason ----
const textRe = /['"]([^'"]{3,80})['"]/;
const textMatch1 = reason2.match(textRe);
assert(textMatch1 && textMatch1[1] === 'Apple | Official Site', 'Link text extracted from quoted reason');

const reason3 = "Click the Submit button";
const textMatch3 = reason3.match(textRe);
assert(!textMatch3, 'No text extracted from unquoted reason');

// ---- Combined context test (thought + reason) ----
const combined = `${thought1} ${reason2}`;
const combinedUrl = combined.match(urlRe);
const combinedLink = linkRe.test(combined);
assert(combinedUrl && combinedLink, 'Combined thought+reason triggers smart browser click (URL + link heuristic)');

// ---- isBrowserProcessName ----
// These are tested indirectly - the functions are internal.
// Verify the exported API surface includes executeActions (which calls trySmartBrowserClick).
assert(typeof ai.executeActions === 'function', 'executeActions is exported from ai-service');
assert(typeof ai.parseActions === 'function', 'parseActions is exported from ai-service');
assert(typeof ai.preflightActions === 'function', 'preflightActions is exported from ai-service');

// ---- Redundant search elimination via preflightActions ----
// Simulates the exact anti-pattern: Google search URL followed by direct URL navigation.
const redundantPlan = [
  { type: 'bring_window_to_front', title: 'Edge', processName: 'msedge' },
  { type: 'wait', ms: 800 },
  { type: 'key', key: 'ctrl+t' },
  { type: 'wait', ms: 800 },
  { type: 'type', text: 'https://www.google.com/search?q=apple.com' },
  { type: 'wait', ms: 300 },
  { type: 'key', key: 'enter' },
  { type: 'wait', ms: 3000 },
  { type: 'key', key: 'ctrl+l' },
  { type: 'wait', ms: 300 },
  { type: 'type', text: 'https://www.apple.com' },
  { type: 'wait', ms: 300 },
  { type: 'key', key: 'enter' },
  { type: 'wait', ms: 3000 },
  { type: 'screenshot' }
];
const optimized = ai.preflightActions({ thought: 'test', actions: redundantPlan }, { userMessage: 'open apple site in edge' });
const optActions = optimized?.actions || optimized;
// The Google search steps (type google URL + enter + wait) should be stripped
const hasGoogleType = (Array.isArray(optActions) ? optActions : []).some(
  a => a?.type === 'type' && /google\.com\/search/i.test(String(a?.text || ''))
);
const hasAppleType = (Array.isArray(optActions) ? optActions : []).some(
  a => a?.type === 'type' && /apple\.com/i.test(String(a?.text || ''))
);
assert(!hasGoogleType, 'Redundant Google search step eliminated from action plan');
assert(hasAppleType, 'Direct URL navigation preserved after redundant search elimination');
assert(
  (Array.isArray(optActions) ? optActions : []).length < redundantPlan.length,
  'Optimized plan has fewer steps than redundant plan'
);

// ---- App-launch rewrite: run_command → Start menu ----
// When user says "open the MPC software" and AI generates Start-Process, rewrite to Start menu.
const mpcRunCommandPlan = [
  { type: 'run_command', command: "Start-Process -FilePath 'C:\\dev\\MPC Beats\\#mpc beats.exe'", shell: 'powershell' }
];
const mpcRewritten = ai.preflightActions(
  { thought: 'launch MPC', actions: mpcRunCommandPlan },
  { userMessage: 'open the MPC 3 software' }
);
const mpcActions = mpcRewritten?.actions || mpcRewritten;
const hasWinKey = (Array.isArray(mpcActions) ? mpcActions : []).some(
  a => a?.type === 'key' && /^win$/i.test(String(a?.key || ''))
);
const hasRunCommand = (Array.isArray(mpcActions) ? mpcActions : []).some(
  a => a?.type === 'run_command'
);
assert(hasWinKey, 'App launch rewrite produces Start menu Win key press');
assert(!hasRunCommand, 'App launch rewrite removes run_command Start-Process');

// cmd /c start should also be rewritten — this is the exact pattern that failed in testing
const cmdStartPlan = [
  { type: 'run_command', command: 'cmd /c start "" "C:\\dev\\MPC Beats\\#mpc beats.exe"', shell: 'cmd' }
];
const cmdStartRewritten = ai.preflightActions(
  { thought: 'launch MPC via CMD', actions: cmdStartPlan },
  { userMessage: 'open the MPC 3 software' }
);
const cmdStartActions = cmdStartRewritten?.actions || cmdStartRewritten;
const cmdStartHasWin = (Array.isArray(cmdStartActions) ? cmdStartActions : []).some(
  a => a?.type === 'key' && /^win$/i.test(String(a?.key || ''))
);
const cmdStartHasRunCommand = (Array.isArray(cmdStartActions) ? cmdStartActions : []).some(
  a => a?.type === 'run_command'
);
assert(cmdStartHasWin, 'cmd /c start rewritten to Start menu Win key');
assert(!cmdStartHasRunCommand, 'cmd /c start run_command removed');

// Discovery commands (Get-ChildItem) should NOT be rewritten to Start menu
const nonBrowserCmd = [
  { type: 'run_command', command: "Get-ChildItem 'C:\\dev' -Filter '*.exe'", shell: 'powershell' }
];
const nonBrowserRewritten = ai.preflightActions(
  { thought: 'list files', actions: nonBrowserCmd },
  { userMessage: 'open the MPC application' }
);
const nonBrowserActions = nonBrowserRewritten?.actions || nonBrowserRewritten;
const discoveryPreserved = (Array.isArray(nonBrowserActions) ? nonBrowserActions : []).some(
  a => a?.type === 'run_command'
);
assert(discoveryPreserved, 'Discovery run_command (Get-ChildItem) preserved, not rewritten to Start menu');

console.log(`\n========================================`);
console.log(`  Smart Browser Click Test Summary`);
console.log(`========================================`);
console.log(`  Total:  ${passed + failed}`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`========================================\n`);

if (failed > 0) process.exit(1);
