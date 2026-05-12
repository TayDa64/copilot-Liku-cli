#!/usr/bin/env node

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SYSTEM_AUTOMATION_PATH = path.join(__dirname, '..', 'src', 'main', 'system-automation.js');
const UI_AUTOMATION_PATH = path.join(__dirname, '..', 'src', 'main', 'ui-automation');
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'tranche0', 'system-automation-low-level-parity.json');
const DEFAULT_OUTPUT_DIR = path.join(__dirname, '..', 'artifacts', 'tranche0');
const DEFAULT_INVENTORY_PATH = path.join(DEFAULT_OUTPUT_DIR, 'system-automation-powershell-inventory.json');
const DEFAULT_REPORT_PATH = path.join(DEFAULT_OUTPUT_DIR, 'system-automation-low-level-parity-report.json');

const originalExec = childProcess.exec;
const originalWriteFileSync = fs.writeFileSync;
const originalUnlinkSync = fs.unlinkSync;
const mockScriptFiles = new Map();
const mockState = {
  activeCase: null
};

function buildTimestampTag() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function collectPowerShellInventory(sourceText) {
  const lines = String(sourceText || '').split(/\r?\n/);
  let currentFunction = '<module>';
  const inventory = new Map();

  const ensureEntry = (functionName) => {
    if (!inventory.has(functionName)) {
      inventory.set(functionName, {
        functionName,
        executePowerShellLines: [],
        executePowerShellScriptLines: [],
        hostBridgeLines: []
      });
    }
    return inventory.get(functionName);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const functionMatch = line.match(/^\s*(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/);
    if (functionMatch) {
      currentFunction = functionMatch[1];
    }

    const entry = ensureEntry(currentFunction);
    const lineNumber = index + 1;

    if (/\bexecutePowerShell\s*\(/.test(line)) {
      entry.executePowerShellLines.push(lineNumber);
    }
    if (/\bexecutePowerShellScript\s*\(/.test(line)) {
      entry.executePowerShellScriptLines.push(lineNumber);
    }
    if (/\btryAutomationHostSystemCall\s*\(/.test(line)) {
      entry.hostBridgeLines.push(lineNumber);
    }
  }

  return Array.from(inventory.values())
    .filter((entry) => entry.executePowerShellLines.length > 0 || entry.executePowerShellScriptLines.length > 0)
    .map((entry) => ({
      functionName: entry.functionName,
      executePowerShellLines: entry.executePowerShellLines,
      executePowerShellScriptLines: entry.executePowerShellScriptLines,
      hostBridgeLines: entry.hostBridgeLines,
      totalPowerShellCallSites: entry.executePowerShellLines.length + entry.executePowerShellScriptLines.length,
      hostAware: entry.hostBridgeLines.length > 0
    }))
    .sort((left, right) => {
      if (right.totalPowerShellCallSites !== left.totalPowerShellCallSites) {
        return right.totalPowerShellCallSites - left.totalPowerShellCallSites;
      }
      return left.functionName.localeCompare(right.functionName);
    });
}

function writeInventoryArtifact(inventory) {
  fs.mkdirSync(DEFAULT_OUTPUT_DIR, { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    sourcePath: SYSTEM_AUTOMATION_PATH,
    generatedTag: buildTimestampTag(),
    functions: inventory
  };
  fs.writeFileSync(DEFAULT_INVENTORY_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return DEFAULT_INVENTORY_PATH;
}

function writeParityReport(report) {
  fs.mkdirSync(DEFAULT_OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(DEFAULT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return DEFAULT_REPORT_PATH;
}

function normalizePathKey(filePath) {
  return path.resolve(String(filePath || '')).replace(/\//g, '\\').toLowerCase();
}

function isAutomationTempScriptPath(filePath) {
  const normalized = normalizePathKey(filePath);
  const tempRoot = normalizePathKey(os.tmpdir());
  return normalized.startsWith(tempRoot)
    && normalized.endsWith('.ps1')
    && (
      normalized.includes('\\liku-ps-')
      || normalized.includes('\\liku-automation\\script-')
    );
}

function parseScriptPathFromCommand(command) {
  const text = String(command || '');
  const quotedMatch = text.match(/-File\s+"([^"]+)"/i);
  if (quotedMatch) {
    return quotedMatch[1].replace(/""/g, '"');
  }
  const bareMatch = text.match(/-File\s+([^\s]+)/i);
  return bareMatch ? bareMatch[1].replace(/""/g, '"') : null;
}

function cloneSerializable(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function patchProcessIO() {
  fs.writeFileSync = function patchedWriteFileSync(filePath, data, options) {
    if (isAutomationTempScriptPath(filePath)) {
      mockScriptFiles.set(normalizePathKey(filePath), String(data || ''));
      return;
    }
    return originalWriteFileSync.call(fs, filePath, data, options);
  };

  fs.unlinkSync = function patchedUnlinkSync(filePath) {
    if (isAutomationTempScriptPath(filePath)) {
      mockScriptFiles.delete(normalizePathKey(filePath));
      return;
    }
    return originalUnlinkSync.call(fs, filePath);
  };

  childProcess.exec = function patchedExec(command, options, callback) {
    const normalizedOptions = typeof options === 'function' ? {} : (options || {});
    const normalizedCallback = typeof options === 'function' ? options : callback;
    const activeCase = mockState.activeCase;

    if (!activeCase || !/powershell/i.test(String(command || ''))) {
      return originalExec.call(childProcess, command, normalizedOptions, normalizedCallback);
    }

    const scriptPath = parseScriptPathFromCommand(command);
    const scriptContent = scriptPath
      ? (mockScriptFiles.get(normalizePathKey(scriptPath)) || '')
      : '';
    const call = {
      command: String(command || ''),
      scriptPath,
      scriptContent,
      timeoutMs: Number(normalizedOptions.timeout || 0) || 0
    };
    activeCase.calls.push(call);

    let response = null;
    try {
      response = resolveMockExecResponse(activeCase, call);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error || 'Unexpected exec failure'));
      setImmediate(() => normalizedCallback(failure, '', failure.message));
      return {
        kill() {},
        on() {},
        pid: 0
      };
    }

    const error = response?.error
      ? (response.error instanceof Error ? response.error : new Error(String(response.error)))
      : null;
    const stdout = String(response?.stdout || '');
    const stderr = String(response?.stderr || '');
    setImmediate(() => normalizedCallback(error, stdout, stderr));
    return {
      kill() {},
      on() {},
      pid: 0
    };
  };
}

function restoreProcessIO() {
  childProcess.exec = originalExec;
  fs.writeFileSync = originalWriteFileSync;
  fs.unlinkSync = originalUnlinkSync;
  mockScriptFiles.clear();
}

function resolveMockExecResponse(activeCase, call) {
  const haystack = `${call.command}\n${call.scriptContent}`;
  for (const responder of activeCase.responders) {
    if (responder.used) continue;
    const includesAll = Array.isArray(responder.includesAll) ? responder.includesAll : [];
    const matches = includesAll.every((token) => haystack.includes(String(token)));
    if (!matches) continue;
    responder.used = true;
    return {
      stdout: responder.stdout || '',
      stderr: responder.stderr || '',
      error: responder.error || null
    };
  }

  if (typeof activeCase.defaultResponse === 'function') {
    return activeCase.defaultResponse(call);
  }

  const preview = haystack.slice(0, 320).replace(/\s+/g, ' ');
  throw new Error(`No mocked PowerShell response for ${activeCase.id}. Preview: ${preview}`);
}

patchProcessIO();

const uiAutomation = require(UI_AUTOMATION_PATH);
const systemAutomation = require(SYSTEM_AUTOMATION_PATH);

function buildHostWindowPayload(expected) {
  return {
    hwnd: Number(expected?.hwnd || 0) || 0,
    pid: Number(expected?.pid || expected?.processId || 0) || 0,
    processId: Number(expected?.pid || expected?.processId || 0) || 0,
    processName: String(expected?.processName || ''),
    title: String(expected?.title || ''),
    ownerHwnd: Number(expected?.ownerHwnd || 0) || 0,
    isTopmost: expected?.isTopmost === true,
    isToolWindow: expected?.isToolWindow === true,
    isMinimized: expected?.isMinimized === true,
    isMaximized: expected?.isMaximized === true,
    windowKind: String(expected?.windowKind || 'main'),
    bounds: expected?.bounds || null
  };
}

function buildStructuredWindowPayload(expected) {
  return {
    success: true,
    hwnd: Number(expected?.hwnd || 0) || 0,
    pid: Number(expected?.pid || expected?.processId || 0) || 0,
    processName: String(expected?.processName || ''),
    title: String(expected?.title || ''),
    ownerHwnd: Number(expected?.ownerHwnd || 0) || 0,
    isTopmost: expected?.isTopmost === true,
    isToolWindow: expected?.isToolWindow === true,
    isMinimized: expected?.isMinimized === true,
    isMaximized: expected?.isMaximized === true,
    windowKind: String(expected?.windowKind || 'main'),
    bounds: expected?.bounds || null
  };
}

function createScenarioForFixture(fixture) {
  switch (fixture.mockId) {
    case 'focusWindow.hostExact':
      return {
        host: {
          async focusWindow(hwnd) {
            return {
              requestedWindowHandle: hwnd,
              actualForegroundHandle: hwnd,
              actualForeground: buildHostWindowPayload(fixture.expectedResult?.actualForeground),
              exactMatch: fixture.expectedResult?.exactMatch === true,
              restored: false,
              focusAttempted: true,
              outcome: fixture.expectedResult?.outcome || 'exact'
            };
          }
        }
      };
    case 'focusWindow.powershellExact':
      return {
        responders: [
          {
            includesAll: ['public class WindowFocus', `Focus([IntPtr]::new(${Number(fixture.args[0])}))`],
            stdout: ''
          },
          {
            includesAll: ['public class ForegroundHandle', 'GetForegroundWindow'],
            stdout: String(Number(fixture.args[0]) || 0)
          },
          {
            includesAll: ['public class ForegroundInfo', 'ConvertTo-Json -Compress'],
            stdout: JSON.stringify(buildStructuredWindowPayload(fixture.expectedResult?.actualForeground))
          }
        ]
      };
    case 'getForegroundWindowInfo.host':
      return {
        host: {
          async getForegroundWindowInfo() {
            return buildHostWindowPayload(fixture.expectedResult);
          }
        }
      };
    case 'getForegroundWindowInfo.powershell':
      return {
        responders: [{
          includesAll: ['public class ForegroundInfo', 'ConvertTo-Json -Compress'],
          stdout: JSON.stringify(buildStructuredWindowPayload(fixture.expectedResult))
        }]
      };
    case 'getWindowInfoByHandle.host':
      return {
        host: {
          async getWindowInfoByHandle(hwnd) {
            return buildHostWindowPayload({
              ...fixture.expectedResult,
              hwnd
            });
          }
        }
      };
    case 'getWindowInfoByHandle.powershell':
      return {
        responders: [{
          includesAll: ['public class WindowInfo', `[IntPtr]::new([int64]${Number(fixture.args[0])})`],
          stdout: JSON.stringify(buildStructuredWindowPayload({
            ...fixture.expectedResult,
            hwnd: Number(fixture.args[0]) || 0
          }))
        }]
      };
    case 'getClipboardText.host':
      return {
        host: {
          async getClipboardText() {
            return { text: String(fixture.expectedResult?.text || '') };
          }
        }
      };
    case 'getClipboardText.powershell':
      return {
        responders: [{
          includesAll: ['Get-Clipboard -Raw', 'ConvertTo-Json -Compress'],
          stdout: JSON.stringify({
            success: true,
            text: String(fixture.expectedResult?.text || ''),
            error: null
          })
        }]
      };
    case 'setClipboardText.host':
      return {
        host: {
          async setClipboardText(text) {
            assert.strictEqual(text, String(fixture.args[0] || ''), `${fixture.id} should pass the requested clipboard text to the host`);
            return { ok: true };
          }
        }
      };
    case 'setClipboardText.powershell':
      return {
        responders: [{
          includesAll: ['FromBase64String', 'Set-Clipboard -Value $value'],
          stdout: ''
        }]
      };
    default:
      return {
        responders: [],
        defaultResponse() {
          return { stdout: '', stderr: '', error: null };
        }
      };
  }
}

function normalizeWindowInfoResult(result) {
  if (!result || typeof result !== 'object') {
    return result;
  }

  return {
    success: result.success === true,
    hwnd: Number(result.hwnd || 0) || 0,
    pid: Number(result.pid || result.processId || 0) || 0,
    processName: String(result.processName || ''),
    title: String(result.title || ''),
    ownerHwnd: Number(result.ownerHwnd || 0) || 0,
    isTopmost: result.isTopmost === true,
    isToolWindow: result.isToolWindow === true,
    isMinimized: result.isMinimized === true,
    isMaximized: result.isMaximized === true,
    windowKind: String(result.windowKind || 'main'),
    bounds: result.bounds || null,
    error: result.error || null
  };
}

function normalizeFocusWindowResult(result) {
  if (!result || typeof result !== 'object') {
    return result;
  }

  return {
    success: result.success === true,
    requestedWindowHandle: Number(result.requestedWindowHandle || 0) || 0,
    actualForegroundHandle: Number(result.actualForegroundHandle || 0) || 0,
    actualForeground: result.actualForeground ? normalizeWindowInfoResult(result.actualForeground) : null,
    exactMatch: result.exactMatch === true,
    outcome: String(result.outcome || ''),
    error: result.error || null
  };
}

function normalizeClipboardReadResult(result) {
  if (!result || typeof result !== 'object') {
    return result;
  }

  return {
    success: result.success === true,
    text: String(result.text || ''),
    error: result.error || null
  };
}

function normalizeClipboardWriteResult(result) {
  if (!result || typeof result !== 'object') {
    return result;
  }

  return {
    success: result.success === true,
    error: result.error || null
  };
}

function normalizeForParity(normalizeAs, result) {
  switch (String(normalizeAs || '').trim()) {
    case 'focusWindow':
      return normalizeFocusWindowResult(result);
    case 'windowInfo':
      return normalizeWindowInfoResult(result);
    case 'clipboardRead':
      return normalizeClipboardReadResult(result);
    case 'clipboardWrite':
      return normalizeClipboardWriteResult(result);
    default:
      return cloneSerializable(result);
  }
}

function assertSubset(actual, expected, contextLabel) {
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) {
    assert.deepStrictEqual(actual, expected, contextLabel);
    return;
  }

  assert(actual && typeof actual === 'object', `${contextLabel}: expected an object result`);
  for (const [key, value] of Object.entries(expected)) {
    assertSubset(actual[key], value, `${contextLabel}.${key}`);
  }
}

function buildCallPreview(call) {
  const scriptPreview = String(call?.scriptContent || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  return {
    scriptPath: call?.scriptPath || null,
    timeoutMs: Number(call?.timeoutMs || 0) || 0,
    preview: scriptPreview || null
  };
}

async function withAutomationHost(host, fn) {
  const originalFlag = process.env.LIKU_USE_AUTOMATION_HOST;
  const originalGetter = uiAutomation.getSharedUIAHost;

  process.env.LIKU_USE_AUTOMATION_HOST = '1';
  uiAutomation.getSharedUIAHost = () => host;

  try {
    return await fn();
  } finally {
    if (originalFlag === undefined) {
      delete process.env.LIKU_USE_AUTOMATION_HOST;
    } else {
      process.env.LIKU_USE_AUTOMATION_HOST = originalFlag;
    }
    uiAutomation.getSharedUIAHost = originalGetter;
  }
}

async function withAutomationHostDisabled(fn) {
  const originalFlag = process.env.LIKU_USE_AUTOMATION_HOST;
  delete process.env.LIKU_USE_AUTOMATION_HOST;
  try {
    return await fn();
  } finally {
    if (originalFlag === undefined) {
      delete process.env.LIKU_USE_AUTOMATION_HOST;
    } else {
      process.env.LIKU_USE_AUTOMATION_HOST = originalFlag;
    }
  }
}

async function runFixtureCase(fixture) {
  const scenario = createScenarioForFixture(fixture);
  const controller = {
    id: fixture.id,
    responders: Array.isArray(scenario.responders)
      ? scenario.responders.map((responder) => ({ ...responder, used: false }))
      : [],
    defaultResponse: scenario.defaultResponse || null,
    calls: []
  };

  mockState.activeCase = controller;
  let actualResult;
  try {
    const helper = systemAutomation[fixture.helper];
    assert.strictEqual(typeof helper, 'function', `${fixture.id} references an exported helper`);

    const invoke = () => helper(...(Array.isArray(fixture.args) ? fixture.args : []));
    actualResult = fixture.mode === 'host'
      ? await withAutomationHost(scenario.host || {}, invoke)
      : await withAutomationHostDisabled(invoke);
  } finally {
    mockState.activeCase = null;
  }

  if (Object.prototype.hasOwnProperty.call(fixture, 'expectedResult')) {
    assertSubset(actualResult, fixture.expectedResult, fixture.id);
  }

  const expectedExecCallCount = Number(fixture.expectedExecCallCount || 0) || 0;
  assert.strictEqual(controller.calls.length, expectedExecCallCount, `${fixture.id} should execute the expected number of PowerShell calls`);

  const expectedScriptMarkers = Array.isArray(fixture.expectedScriptMarkers) ? fixture.expectedScriptMarkers : [];
  expectedScriptMarkers.forEach((markers, index) => {
    const call = controller.calls[index];
    assert(call, `${fixture.id} expected PowerShell call ${index + 1}`);
    const haystack = `${call.command}\n${call.scriptContent}`;
    for (const marker of markers) {
      assert(
        haystack.includes(String(marker)),
        `${fixture.id} call ${index + 1} should contain marker "${marker}"`
      );
    }
  });

  const forbidScriptMarkers = Array.isArray(fixture.forbidScriptMarkers) ? fixture.forbidScriptMarkers : [];
  if (forbidScriptMarkers.length > 0) {
    const combined = controller.calls.map((call) => `${call.command}\n${call.scriptContent}`).join('\n---\n');
    for (const marker of forbidScriptMarkers) {
      assert(
        !combined.includes(String(marker)),
        `${fixture.id} should not contain marker "${marker}"`
      );
    }
  }

  for (const responder of controller.responders) {
    assert(responder.used, `${fixture.id} did not consume mocked response markers: ${(responder.includesAll || []).join(', ')}`);
  }

  return {
    id: fixture.id,
    helper: fixture.helper,
    mode: fixture.mode,
    parityGroup: fixture.parityGroup || null,
    normalizedResult: fixture.normalizeAs ? normalizeForParity(fixture.normalizeAs, actualResult) : undefined,
    actualResult: cloneSerializable(actualResult),
    calls: controller.calls.map(buildCallPreview)
  };
}

async function main() {
  const sourceText = fs.readFileSync(SYSTEM_AUTOMATION_PATH, 'utf8');
  const inventory = collectPowerShellInventory(sourceText);
  const inventoryArtifactPath = writeInventoryArtifact(inventory);
  const inventoryNames = inventory.map((entry) => entry.functionName);

  assert(inventory.length > 0, 'PowerShell inventory should discover at least one system-automation helper');
  assert(inventoryNames.includes('findElementByText'), 'PowerShell inventory should include findElementByText');
  assert(inventoryNames.includes('getRunningProcessesByNames'), 'PowerShell inventory should include process enumeration helpers');
  assert(inventoryNames.includes('pressKey'), 'PowerShell inventory should include keyboard helpers');
  assert(inventoryNames.includes('typeText'), 'PowerShell inventory should include typing helpers');

  const fixtureBundle = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const fixtures = Array.isArray(fixtureBundle?.cases) ? fixtureBundle.cases : [];
  assert(fixtures.length > 0, 'Expected at least one system-automation parity fixture');

  if (process.platform !== 'win32') {
    console.log('PASS system-automation PowerShell inventory');
    console.log(`Discovered ${inventory.length} PowerShell-backed functions.`);
    console.log(`Inventory artifact: ${inventoryArtifactPath}`);
    console.log('SKIP deterministic low-level helper parity fixtures (Windows-only helper contract lane)');
    return;
  }

  const caseReports = [];
  for (const fixture of fixtures) {
    const report = await runFixtureCase(fixture);
    caseReports.push(report);
    console.log(`PASS ${fixture.id}`);
  }

  const parityGroups = new Map();
  for (const report of caseReports) {
    if (!report.parityGroup || report.normalizedResult === undefined) continue;
    const entries = parityGroups.get(report.parityGroup) || [];
    entries.push(report);
    parityGroups.set(report.parityGroup, entries);
  }

  const parityAssertions = [];
  for (const [groupId, entries] of parityGroups.entries()) {
    if (entries.length < 2) continue;
    const baseline = entries[0].normalizedResult;
    for (let index = 1; index < entries.length; index += 1) {
      assert.deepStrictEqual(entries[index].normalizedResult, baseline, `${groupId} should preserve normalized helper parity across implementations`);
    }
    parityAssertions.push({
      groupId,
      normalizedResult: baseline,
      variants: entries.map((entry) => ({
        id: entry.id,
        mode: entry.mode
      }))
    });
    console.log(`PASS parity ${groupId}`);
  }

  const reportArtifactPath = writeParityReport({
    generatedAt: new Date().toISOString(),
    fixturePath: FIXTURE_PATH,
    sourcePath: SYSTEM_AUTOMATION_PATH,
    generatedTag: buildTimestampTag(),
    caseCount: caseReports.length,
    parityGroupCount: parityAssertions.length,
    inventoryArtifactPath,
    cases: caseReports,
    parityAssertions
  });

  console.log('PASS system-automation PowerShell inventory');
  console.log(`Discovered ${inventory.length} PowerShell-backed functions.`);
  inventory.slice(0, 10).forEach((entry) => {
    console.log(`- ${entry.functionName}: ${entry.totalPowerShellCallSites} PowerShell call site(s)${entry.hostAware ? ' [host-aware]' : ''}`);
  });
  console.log(`Inventory artifact: ${inventoryArtifactPath}`);
  console.log(`Parity artifact: ${reportArtifactPath}`);
}

(async () => {
  try {
    await main();
  } catch (error) {
    console.error('FAIL system automation parity');
    console.error(error.stack || error.message);
    process.exitCode = 1;
  } finally {
    restoreProcessIO();
  }
})();
