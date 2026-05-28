const path = require('path');

const { getCommandInfo } = require('./command-registry');
const { readCliFeatureFlags } = require('./feature-flags');
const { validateProjectIdentity } = require('../shared/project-identity');
const { createRuntimeTraceLog } = require('../main/traces/runtime-trace-log');

const COMMAND_REQUEST_SCHEMA_VERSION = 'cli.command-request.v1';
const COMMAND_EXECUTION_SCHEMA_VERSION = 'cli.command-execution.v1';
const COMMANDS_DIR = path.join(__dirname, 'commands');

function cloneOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return {};
  }
  return { ...options };
}

function buildCommandRequest({
  command = null,
  args = [],
  flags = {},
  options = {},
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const featureFlags = readCliFeatureFlags(env);

  return {
    schemaVersion: COMMAND_REQUEST_SCHEMA_VERSION,
    command: String(command || '').trim() || 'start',
    args: Array.isArray(args) ? args.slice() : [],
    flags: {
      help: !!flags.help,
      version: !!flags.version,
      json: !!flags.json,
      quiet: !!flags.quiet,
      debug: !!flags.debug,
    },
    options: cloneOptions(options),
    cwd: String(cwd || process.cwd()),
    featureFlags,
    executionPreferences: {
      approvalMode: featureFlags.approvalMode,
      dryRunDefault: featureFlags.dryRunDefault,
    },
    environment: {
      runtimeTraceDisabled: String(env.LIKU_DISABLE_RUNTIME_TRACE || '').trim() === '1',
    },
  };
}

function buildCommandContextOptions(request) {
  return {
    ...request.flags,
    ...request.options,
    featureFlags: { ...request.featureFlags },
    executionPreferences: { ...request.executionPreferences },
  };
}

function summarizeTraceLog(traceLog) {
  if (!traceLog || typeof traceLog !== 'object') {
    return null;
  }
  return {
    sessionId: String(traceLog.sessionId || '').trim() || null,
    filePath: String(traceLog.filePath || '').trim() || null,
  };
}

function summarizeCommandResult(result) {
  if (result === undefined) {
    return { kind: 'undefined' };
  }
  if (result === null) {
    return { kind: 'null' };
  }
  if (Array.isArray(result)) {
    return { kind: 'array', length: result.length };
  }
  if (typeof result === 'object') {
    return { kind: 'object', keys: Object.keys(result).slice(0, 12) };
  }
  return { kind: typeof result };
}

function appendTraceEvent(traceLog, event, data = {}) {
  if (!traceLog || typeof traceLog.append !== 'function') {
    return;
  }
  try {
    traceLog.append(event, data);
  } catch {}
}

function closeTraceLog(traceLog, summary = {}) {
  if (!traceLog || typeof traceLog.close !== 'function') {
    return;
  }
  try {
    traceLog.close(summary);
  } catch {}
}

function createCliTraceLog(request, deps = {}) {
  if (request.environment?.runtimeTraceDisabled || request.options?.disableRuntimeTrace === true) {
    return null;
  }

  const factory = typeof deps.createTraceLog === 'function'
    ? deps.createTraceLog
    : (options) => createRuntimeTraceLog(options);

  try {
    return factory({
      metadata: {
        surface: 'cli',
        schemaVersion: COMMAND_EXECUTION_SCHEMA_VERSION,
        command: request.command,
        argsCount: request.args.length,
        flags: {
          json: request.flags.json,
          quiet: request.flags.quiet,
          debug: request.flags.debug,
        },
        optionKeys: Object.keys(request.options || {}).sort(),
        projectGuardRequested: !!(request.options?.project || request.options?.repo),
        featureFlags: {
          enableGitHub: request.featureFlags.enableGitHub,
          enableGitHubWrites: request.featureFlags.enableGitHubWrites,
          enableAgents: request.featureFlags.enableAgents,
          enableDynamicTools: request.featureFlags.enableDynamicTools,
        },
        executionPreferences: { ...request.executionPreferences },
      },
    });
  } catch {
    return null;
  }
}

function buildProjectGuardPayload(validation = {}) {
  return {
    success: false,
    error: 'PROJECT_GUARD_MISMATCH',
    expected: validation.expected || {},
    detected: validation.detected || {},
    details: Array.isArray(validation.errors) ? validation.errors.slice() : [],
  };
}

async function executeCommandRequest(request, deps = {}) {
  const traceLog = createCliTraceLog(request, deps);
  const resolveCommandInfo = typeof deps.getCommandInfo === 'function'
    ? deps.getCommandInfo
    : getCommandInfo;
  const validateProject = typeof deps.validateProjectIdentity === 'function'
    ? deps.validateProjectIdentity
    : validateProjectIdentity;
  const loadCommand = typeof deps.loadCommand === 'function'
    ? deps.loadCommand
    : (cmdInfo) => require(path.join(COMMANDS_DIR, `${cmdInfo.file}.js`));

  appendTraceEvent(traceLog, 'cli:command:start', {
    command: request.command,
    argsCount: request.args.length,
  });

  const cmdInfo = resolveCommandInfo(request.command);
  if (!cmdInfo) {
    appendTraceEvent(traceLog, 'cli:command:error', {
      code: 'UNKNOWN_COMMAND',
      message: `Unknown command: ${request.command}`,
    });
    closeTraceLog(traceLog, {
      command: request.command,
      success: false,
      error: 'UNKNOWN_COMMAND',
    });
    return {
      schemaVersion: COMMAND_EXECUTION_SCHEMA_VERSION,
      ok: false,
      exitCode: 1,
      error: {
        code: 'UNKNOWN_COMMAND',
        message: `Unknown command: ${request.command}`,
      },
      traceSummary: summarizeTraceLog(traceLog),
    };
  }

  if (request.options.project || request.options.repo) {
    const validation = validateProject({
      cwd: request.cwd,
      expectedProjectRoot: request.options.project,
      expectedRepo: request.options.repo,
    });

    if (!validation.ok) {
      const payload = buildProjectGuardPayload(validation);
      appendTraceEvent(traceLog, 'cli:command:project-guard-mismatch', {
        details: payload.details,
      });
      closeTraceLog(traceLog, {
        command: request.command,
        success: false,
        error: payload.error,
      });
      return {
        schemaVersion: COMMAND_EXECUTION_SCHEMA_VERSION,
        ok: false,
        exitCode: 1,
        error: {
          code: payload.error,
          message: 'Project guard mismatch',
          payload,
        },
        traceSummary: summarizeTraceLog(traceLog),
      };
    }

    appendTraceEvent(traceLog, 'cli:command:project-guard-ok', {
      repo: validation.detected?.repoName || validation.detected?.normalizedRepoName || null,
    });
  }

  let commandModule;
  try {
    commandModule = loadCommand(cmdInfo, request);
  } catch (error) {
    appendTraceEvent(traceLog, 'cli:command:error', {
      code: 'COMMAND_MODULE_LOAD_FAILED',
      message: error?.message || 'Failed to load command module',
    });
    closeTraceLog(traceLog, {
      command: request.command,
      success: false,
      error: 'COMMAND_MODULE_LOAD_FAILED',
    });
    return {
      schemaVersion: COMMAND_EXECUTION_SCHEMA_VERSION,
      ok: false,
      exitCode: 1,
      error: {
        code: 'COMMAND_MODULE_LOAD_FAILED',
        message: error?.message || 'Failed to load command module',
      },
      cause: error,
      traceSummary: summarizeTraceLog(traceLog),
    };
  }

  if (!commandModule || typeof commandModule.run !== 'function') {
    appendTraceEvent(traceLog, 'cli:command:error', {
      code: 'COMMAND_MODULE_INVALID',
      message: `Command module for ${request.command} does not export run()`,
    });
    closeTraceLog(traceLog, {
      command: request.command,
      success: false,
      error: 'COMMAND_MODULE_INVALID',
    });
    return {
      schemaVersion: COMMAND_EXECUTION_SCHEMA_VERSION,
      ok: false,
      exitCode: 1,
      error: {
        code: 'COMMAND_MODULE_INVALID',
        message: `Command module for ${request.command} does not export run()`,
      },
      traceSummary: summarizeTraceLog(traceLog),
    };
  }

  try {
    const result = await commandModule.run(request.args, buildCommandContextOptions(request));
    const success = !(result && result.success === false);
    const exitCode = success ? 0 : 1;
    appendTraceEvent(traceLog, 'cli:command:result', {
      command: request.command,
      success,
      result: summarizeCommandResult(result),
    });
    closeTraceLog(traceLog, {
      command: request.command,
      success,
      exitCode,
    });
    return {
      schemaVersion: COMMAND_EXECUTION_SCHEMA_VERSION,
      ok: true,
      success,
      exitCode,
      result,
      traceSummary: summarizeTraceLog(traceLog),
    };
  } catch (error) {
    appendTraceEvent(traceLog, 'cli:command:error', {
      code: error?.code || 'COMMAND_EXECUTION_FAILED',
      message: error?.message || String(error),
    });
    closeTraceLog(traceLog, {
      command: request.command,
      success: false,
      error: error?.code || 'COMMAND_EXECUTION_FAILED',
    });
    return {
      schemaVersion: COMMAND_EXECUTION_SCHEMA_VERSION,
      ok: false,
      exitCode: 1,
      error: {
        code: error?.code || 'COMMAND_EXECUTION_FAILED',
        message: error?.message || String(error),
      },
      cause: error,
      traceSummary: summarizeTraceLog(traceLog),
    };
  }
}

module.exports = {
  COMMAND_EXECUTION_SCHEMA_VERSION,
  COMMAND_REQUEST_SCHEMA_VERSION,
  buildCommandContextOptions,
  buildCommandRequest,
  buildProjectGuardPayload,
  createCliTraceLog,
  executeCommandRequest,
  summarizeTraceLog,
};
