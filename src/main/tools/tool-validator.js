/**
 * Tool Validator — static analysis for AI-generated tool scripts
 *
 * Rejects scripts that contain dangerous patterns before they can be
 * registered or executed. This is the FIRST line of defense.
 * The sandbox (sandbox.js) is the SECOND.
 *
 * Security principle: defense in depth. Even if validation passes,
 * the sandbox restricts available APIs to a safe allowlist.
 */

const BANNED_PATTERNS = [
  { pattern: /\brequire\s*\(/, label: 'require()' },
  { pattern: /\bimport\s+/, label: 'import statement' },
  { pattern: /\bimport\s*\(/, label: 'dynamic import()' },
  { pattern: /\bprocess\b/, label: 'process object' },
  { pattern: /\bchild_process\b/, label: 'child_process' },
  { pattern: /\b__dirname\b/, label: '__dirname' },
  { pattern: /\b__filename\b/, label: '__filename' },
  { pattern: /\bglobal\b/, label: 'global object' },
  { pattern: /\bglobalThis\b/, label: 'globalThis' },
  { pattern: /\beval\s*\(/, label: 'eval()' },
  { pattern: /\bFunction\s*\(/, label: 'Function constructor' },
  { pattern: /\bfs\s*\./, label: 'fs module access' },
  { pattern: /\bhttp\b/, label: 'http/https module' },
  { pattern: /\bnet\b\./, label: 'net module' },
  { pattern: /\bdgram\b/, label: 'dgram module' },
  { pattern: /\bBuffer\s*\./, label: 'Buffer access' }
];

/**
 * Validate tool source code against banned patterns.
 *
 * @param {string} code - The tool source code
 * @returns {{ valid: boolean, violations: string[] }}
 */
function validateToolSource(code) {
  const violations = [];

  for (const { pattern, label } of BANNED_PATTERNS) {
    if (pattern.test(code)) {
      violations.push(label);
    }
  }

  // Check for excessive code length (max 10KB)
  if (code.length > 10240) {
    violations.push(`Code too large: ${code.length} bytes (max 10240)`);
  }

  return {
    valid: violations.length === 0,
    violations
  };
}

module.exports = { validateToolSource, BANNED_PATTERNS };
