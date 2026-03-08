#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const tmpDir = path.join(repoRoot, '.tmp-hook-check');
const artifactPath = path.join(repoRoot, '.github', 'hooks', 'artifacts', 'recursive-architect.md');
const qualityLogPath = path.join(repoRoot, '.github', 'hooks', 'logs', 'subagent-quality.jsonl');
const securityScript = path.join(repoRoot, '.github', 'hooks', 'scripts', 'security-check.ps1');
const qualityScript = path.join(repoRoot, '.github', 'hooks', 'scripts', 'subagent-quality-gate.ps1');

fs.mkdirSync(tmpDir, { recursive: true });

const allowPath = path.join(tmpDir, 'allow.json');
const denyPath = path.join(tmpDir, 'deny.json');
const qualityPath = path.join(tmpDir, 'quality.json');

fs.writeFileSync(allowPath, JSON.stringify({
  toolName: 'edit',
  toolInput: { filePath: artifactPath },
  agent_type: 'recursive-architect'
}));

fs.writeFileSync(denyPath, JSON.stringify({
  toolName: 'edit',
  toolInput: { filePath: path.join(repoRoot, 'src', 'main', 'ai-service.js') },
  agent_type: 'recursive-architect'
}));

fs.writeFileSync(artifactPath, [
  '## Recommended Approach',
  'Use the ai-service extraction seam and keep the compatibility facade stable.',
  '',
  '## Files to Reuse',
  '- src/main/ai-service.js',
  '- src/main/ai-service/visual-context.js',
  '',
  '## Constraints and Risks',
  '- Source-based regression tests inspect ai-service.js text directly.'
].join('\n'));

fs.writeFileSync(qualityPath, JSON.stringify({
  agent_type: 'recursive-architect',
  agent_id: 'sim-architect',
  cwd: path.join(repoRoot, '.github', 'hooks'),
  stop_hook_active: true
}));

function runHook(scriptPath, inputPath) {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      COPILOT_HOOK_INPUT_PATH: inputPath
    },
    encoding: 'utf8'
  }).trim();
}

const allowOutput = runHook(securityScript, allowPath);
const denyOutput = runHook(securityScript, denyPath);
runHook(qualityScript, qualityPath);

const deny = JSON.parse(denyOutput);
const qualityLines = fs.readFileSync(qualityLogPath, 'utf8').trim().split(/\r?\n/);
const quality = JSON.parse(qualityLines[qualityLines.length - 1]);

if (allowOutput !== '') {
  throw new Error('Expected empty allow response for artifact mutation');
}

if (deny.permissionDecision !== 'deny') {
  throw new Error(`Expected deny response for non-artifact edit, got '${deny.permissionDecision}'`);
}

if (quality.status !== 'pass') {
  throw new Error(`Expected quality gate pass from artifact evidence, got '${quality.status}'`);
}

if (!String(quality.evidenceSource || '').includes('artifact')) {
  throw new Error(`Expected artifact-backed evidence source, got '${quality.evidenceSource}'`);
}

console.log('PASS artifact edit allowed for recursive-architect');
console.log('PASS non-artifact edit denied for recursive-architect');
console.log(`PASS quality gate accepted artifact evidence (${quality.evidenceSource})`);