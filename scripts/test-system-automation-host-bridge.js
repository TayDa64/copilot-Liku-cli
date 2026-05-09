#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const systemAutomation = require(path.join(__dirname, '..', 'src', 'main', 'system-automation.js'));
const chromiumCdp = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation', 'core', 'chromium-cdp.js'));
const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
const uiContext = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'ui-context.js'));
const { shutdownSharedUIAHost } = uiAutomation;
const TEST_TIMEOUT_MS = Math.max(
  30000,
  Number.parseInt(process.env.LIKU_TEST_TIMEOUT_MS || '90000', 10) || 90000
);
const forcedExitTimer = setTimeout(() => {
  console.error(`FAIL system automation host bridge timed out after ${TEST_TIMEOUT_MS}ms`);
  process.exit(1);
}, TEST_TIMEOUT_MS);
if (typeof forcedExitTimer.unref === 'function') {
  forcedExitTimer.unref();
}

async function test(name, fn) {
  if (typeof chromiumCdp.clearChromiumRemoteDebuggingDiscoveryCache === 'function') {
    chromiumCdp.clearChromiumRemoteDebuggingDiscoveryCache();
  }
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  } finally {
    if (typeof chromiumCdp.clearChromiumRemoteDebuggingDiscoveryCache === 'function') {
      chromiumCdp.clearChromiumRemoteDebuggingDiscoveryCache();
    }
  }
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

async function withUIWatcher(watcher, fn) {
  const originalWatcher = uiContext.getUIWatcher();
  uiContext.setUIWatcher(watcher || null);
  try {
    return await fn();
  } finally {
    uiContext.setUIWatcher(originalWatcher || null);
  }
}

function buildWindowInfo(overrides = {}) {
  return {
    hwnd: 777,
    pid: 4242,
    processId: 4242,
    processName: 'tradingview',
    title: 'TradingView - Pine Editor',
    ownerHwnd: 0,
    isTopmost: false,
    isToolWindow: false,
    isMinimized: false,
    isMaximized: true,
    windowKind: 'main',
    bounds: { x: 10, y: 20, width: 1280, height: 900 },
    ...overrides
  };
}

function createJsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    }
  };
}

function createMockWebSocket(handler, options = {}) {
  let openCount = 0;
  return class MockWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this._listeners = new Map();
      const currentOpenCount = openCount + 1;
      openCount = currentOpenCount;
      const openDelayMs = typeof options?.getOpenDelayMs === 'function'
        ? Math.max(0, Number(options.getOpenDelayMs({
            openCount: currentOpenCount,
            url
          }) || 0) || 0)
        : Math.max(0, Number(options?.openDelayMs || 0) || 0);
      const emitOpen = () => {
        if (this.readyState === 3) return;
        this.readyState = 1;
        this._emit('open', {});
      };
      if (openDelayMs > 0) {
        const timer = setTimeout(emitOpen, openDelayMs);
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
      } else {
        queueMicrotask(emitOpen);
      }
    }

    addEventListener(eventName, listener) {
      const key = String(eventName || '').trim().toLowerCase();
      const listeners = this._listeners.get(key) || [];
      listeners.push(listener);
      this._listeners.set(key, listeners);
    }

    send(payload) {
      let message = null;
      try {
        message = JSON.parse(String(payload || '{}'));
      } catch (error) {
        this._emit('error', error);
        return;
      }

      let response = null;
      try {
        response = handler(message, this);
      } catch (error) {
        this._emit('error', error);
        return;
      }

      if (!response) {
        return;
      }

      queueMicrotask(() => {
        this._emit('message', {
          data: JSON.stringify(response)
        });
      });
    }

    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      queueMicrotask(() => {
        this._emit('close', {});
      });
    }

    _emit(eventName, event) {
      const key = String(eventName || '').trim().toLowerCase();
      if (typeof this[`on${key}`] === 'function') {
        this[`on${key}`](event);
      }
      const listeners = this._listeners.get(key) || [];
      for (const listener of listeners) {
        listener(event);
      }
    }
  };
}

function buildTradingViewCdpDependencies(options = {}) {
  const port = Number(options?.port || 9333) || 9333;
  const onMessage = typeof options?.onMessage === 'function' ? options.onMessage : null;
  const targets = Array.isArray(options?.targets) && options.targets.length > 0
    ? options.targets
    : [{
        id: 'tv-page-1',
        type: 'page',
        title: 'MN / Unnamed',
        url: 'https://www.tradingview.com/chart/abc123/',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/tv-page-1`
      }];
  const domPayload = options?.domPayload || {
    matched: true,
    anchorText: 'Add to chart',
    signals: [{
      text: 'Add to chart',
      observedText: 'Add to chart',
      source: 'dom-node'
    }],
    scannedNodes: 18,
    usedBodyInnerText: false
  };
  const domResolveResult = options?.domResolveResult || {
    object: {
      objectId: 'mock-node-1'
    }
  };
  const callFunctionOnValue = options?.callFunctionOnValue || {
    clicked: true,
    text: 'Yes',
    tagName: 'BUTTON'
  };
  const state = {
    axNodes: Array.isArray(options?.axNodes) ? options.axNodes.slice() : []
  };

  return {
    processInspector: async () => ({
      success: true,
      processes: [{
        pid: 4242,
        name: 'TradingView.exe',
        commandLine: `TradingView.exe --remote-debugging-port=${port}`,
        ports: [port]
      }]
    }),
    fetchImpl: async (url) => {
      if (/\/json\/version$/i.test(String(url || ''))) {
        return createJsonResponse({
          Browser: 'TradingView/1.0',
          'Protocol-Version': '1.3'
        });
      }
      if (/\/json\/list$/i.test(String(url || ''))) {
        return createJsonResponse(targets);
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    },
    WebSocketCtor: createMockWebSocket((message) => {
      onMessage?.(message);
      switch (String(message?.method || '')) {
        case 'Runtime.evaluate':
          return {
            id: message.id,
            result: {
              result: {
                type: 'object',
                value: domPayload
              }
            }
          };
        case 'Accessibility.enable':
          return {
            id: message.id,
            result: {}
          };
        case 'Accessibility.getFullAXTree':
          if (typeof options?.onGetFullAXTree === 'function') {
            const hookResult = options.onGetFullAXTree({
              message,
              state: {
                axNodes: Array.isArray(state.axNodes) ? state.axNodes.slice() : []
              }
            });
            if (hookResult && typeof hookResult === 'object' && Array.isArray(hookResult.axNodes)) {
              state.axNodes = hookResult.axNodes.slice();
            }
          }
          return {
            id: message.id,
            result: {
              nodes: Array.isArray(state.axNodes) ? state.axNodes.slice() : []
            }
          };
        case 'DOM.resolveNode':
          return {
            id: message.id,
            result: domResolveResult
          };
        case 'Runtime.callFunctionOn':
          let callFunctionOnPayload = callFunctionOnValue;
          if (typeof options?.onCallFunctionOn === 'function') {
            const hookResult = options.onCallFunctionOn({
              message,
              state: {
                axNodes: Array.isArray(state.axNodes) ? state.axNodes.slice() : []
              }
            });
            if (hookResult && typeof hookResult === 'object') {
              if (Array.isArray(hookResult.axNodes)) {
                state.axNodes = hookResult.axNodes.slice();
              }
              if (hookResult.callFunctionOnValue && typeof hookResult.callFunctionOnValue === 'object') {
                callFunctionOnPayload = hookResult.callFunctionOnValue;
              }
            }
          }
          return {
            id: message.id,
            result: {
              result: {
                type: 'object',
                value: callFunctionOnPayload
              }
            }
          };
        case 'Runtime.releaseObject':
          return {
            id: message.id,
            result: {}
          };
        default:
          return {
            id: message.id,
            result: {}
          };
      }
    }, options?.webSocketOptions || {})
  };
}

function buildUnavailableTradingViewCdpDependencies() {
  return {
    processInspector: async () => ({
      success: true,
      processes: [{
        pid: 4242,
        name: 'TradingView.exe',
        commandLine: 'TradingView.exe',
        ports: []
      }]
    }, options?.webSocketOptions || {})
  };
}

function extractRuntimeEvaluatePayload(expression = '') {
  const source = String(expression || '').trim();
  const markerIndex = source.lastIndexOf(')({');
  if (markerIndex < 0 || !source.endsWith(')')) {
    return null;
  }

  const jsonText = source.slice(markerIndex + 2, -1);
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

function buildTradingViewPineEditorCdpMock(options = {}) {
  const port = Number(options?.port || 9666) || 9666;
  const onMessage = typeof options?.onMessage === 'function' ? options.onMessage : null;
  const targets = Array.isArray(options?.targets) && options.targets.length > 0
    ? options.targets
    : [{
        id: 'tv-page-pine-editor',
        type: 'page',
        title: 'MN / Unnamed',
        url: 'https://www.tradingview.com/chart/abc123/',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/tv-page-pine-editor`
      }];
  const state = {
    editorText: String(options?.initialText || ''),
    renderedText: String(options?.initialRenderedText ?? options?.initialText ?? ''),
    dialogText: String(options?.initialDialogText || ''),
    dialogInputValues: Array.isArray(options?.initialDialogInputValues)
      ? options.initialDialogInputValues.map((value) => String(value ?? ''))
      : [],
    dialogButtonTexts: Array.isArray(options?.initialDialogButtonTexts) && options.initialDialogButtonTexts.length > 0
      ? options.initialDialogButtonTexts.map((value) => String(value ?? ''))
      : ['Cancel', 'Save'],
    focusCalls: 0,
    readCalls: 0,
    inputInsertCalls: 0,
    forceSetCalls: 0,
    monacoWriteCalls: 0
  };
  const countLines = (text = '') => {
    const normalized = String(text || '').replace(/\r/g, '');
    return normalized ? normalized.split('\n').length : 0;
  };
  const applyMutationResult = (mutation = null) => {
    if (!mutation || typeof mutation !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(mutation, 'editorText')) {
      state.editorText = String(mutation.editorText ?? '');
    }
    if (Object.prototype.hasOwnProperty.call(mutation, 'renderedText')) {
      state.renderedText = String(mutation.renderedText ?? '');
    }
    if (Object.prototype.hasOwnProperty.call(mutation, 'dialogText')) {
      state.dialogText = String(mutation.dialogText ?? '');
    }
    if (Object.prototype.hasOwnProperty.call(mutation, 'dialogInputValues')) {
      state.dialogInputValues = Array.isArray(mutation.dialogInputValues)
        ? mutation.dialogInputValues.map((value) => String(value ?? ''))
        : [];
    }
    if (Object.prototype.hasOwnProperty.call(mutation, 'dialogButtonTexts')) {
      state.dialogButtonTexts = Array.isArray(mutation.dialogButtonTexts)
        ? mutation.dialogButtonTexts.map((value) => String(value ?? ''))
        : [];
    }
  };
  const buildRuntimePayload = (operation = 'read', overrides = {}) => ({
    found: true,
    operation,
    textarea: {
      tagName: 'TEXTAREA',
      className: 'inputarea monaco-mouse-cursor-text',
      ariaLabel: 'Editor content;Press Alt+F1 for Accessibility Options.',
      value: state.editorText,
      valueLength: state.editorText.length,
      selectionStart: 0,
      selectionEnd: state.editorText.length,
      visible: true,
      focused: true,
      selectedAll: state.editorText.length > 0,
      rect: { x: 1100, y: 490, width: 780, height: 320 },
      score: 999
    },
    rendered: {
      text: state.renderedText,
      lineCount: countLines(state.renderedText),
      source: 'view-lines',
      visible: true,
      score: 820
    },
    dialog: (state.dialogText || state.dialogInputValues.length > 0)
      ? {
          text: state.dialogText,
          inputValues: state.dialogInputValues.slice(0, 4),
          buttonTexts: state.dialogButtonTexts.slice(0, 6),
          source: 'dialog-surface',
          visible: true,
          score: 920
        }
      : null,
    scannedRoots: 3,
    scannedElements: 48,
    activeElementTagName: 'TEXTAREA',
    ...overrides
  });

  const deps = {
    processInspector: async () => ({
      success: true,
      processes: [{
        pid: 4242,
        name: 'TradingView.exe',
        commandLine: `TradingView.exe --remote-debugging-port=${port}`,
        ports: [port]
      }]
    }),
    fetchImpl: async (url) => {
      if (/\/json\/version$/i.test(String(url || ''))) {
        return createJsonResponse({
          Browser: 'TradingView/1.0',
          'Protocol-Version': '1.3'
        });
      }
      if (/\/json\/list$/i.test(String(url || ''))) {
        return createJsonResponse(targets);
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    },
    WebSocketCtor: createMockWebSocket((message) => {
      onMessage?.(message);
      const method = String(message?.method || '');
      switch (method) {
        case 'Page.bringToFront':
          return {
            id: message.id,
            result: {}
          };
        case 'Runtime.evaluate': {
          const payload = extractRuntimeEvaluatePayload(message?.params?.expression || '');
          if (String(payload?.surface || '').trim().toLowerCase() === 'monaco-model') {
            const monacoOperation = String(payload?.operation || 'inspect').trim().toLowerCase();
            if (options?.monacoEditorAvailable !== true) {
              return {
                id: message.id,
                result: {
                  result: {
                    type: 'object',
                    value: {
                      surface: 'monaco-model',
                      found: false,
                      operation: monacoOperation,
                      success: false,
                      inspected: 24,
                      candidateCount: 0,
                      candidates: [],
                      editor: null,
                      model: null,
                      text: '',
                      textLength: 0,
                      previousValueLength: 0,
                      appliedTextLength: 0,
                      method: null,
                      error: 'TradingView Pine Monaco editor handle was not discoverable.'
                    }
                  }
                }
              };
            }

            if (monacoOperation === 'write') {
              state.monacoWriteCalls += 1;
              const desiredText = String(payload?.text || '');
              const previousValueLength = state.editorText.length;
              let monacoMutation = null;
              let monacoMethod = 'editor-executeEdits';
              if (typeof options?.onMonacoWrite === 'function') {
                const hookResult = options.onMonacoWrite({
                  desiredText,
                  payload,
                  state: { ...state }
                });
                if (hookResult && typeof hookResult === 'object') {
                  monacoMutation = hookResult.mutation || hookResult;
                  if (hookResult.method) {
                    monacoMethod = String(hookResult.method);
                  }
                }
              } else {
                monacoMutation = {
                  editorText: desiredText,
                  renderedText: desiredText
                };
              }
              applyMutationResult(monacoMutation);
              return {
                id: message.id,
                result: {
                  result: {
                    type: 'object',
                    value: {
                      surface: 'monaco-model',
                      found: true,
                      operation: monacoOperation,
                      success: String(state.editorText || '') === desiredText,
                      inspected: 64,
                      candidateCount: 2,
                      candidates: [
                        {
                          kind: 'editor',
                          path: 'root[2].__reactContainer$mock.child.memoizedState.memoizedState.current._editor',
                          score: 980,
                          ctor: 'MockMonacoEditor',
                          methods: ['getModel', 'getValue', 'executeEdits', 'focus'],
                          ownKeys: ['_editor', '_monaco']
                        },
                        {
                          kind: 'model',
                          path: 'root[2].__reactContainer$mock.child.memoizedState.memoizedState.current._editor.model',
                          score: 760,
                          ctor: 'MockMonacoModel',
                          methods: ['getValue', 'setValue', 'getFullModelRange'],
                          ownKeys: ['uri']
                        }
                      ],
                      editor: {
                        path: 'root[2].__reactContainer$mock.child.memoizedState.memoizedState.current._editor',
                        ctor: 'MockMonacoEditor',
                        methods: ['getModel', 'getValue', 'executeEdits', 'focus'],
                        hasModel: true,
                        selectionCount: 1
                      },
                      model: {
                        path: 'root[2].__reactContainer$mock.child.memoizedState.memoizedState.current._editor.model',
                        ctor: 'MockMonacoModel',
                        methods: ['getValue', 'setValue', 'getFullModelRange'],
                        lineCount: countLines(state.editorText)
                      },
                      text: state.editorText,
                      textLength: state.editorText.length,
                      previousValueLength,
                      appliedTextLength: desiredText.length,
                      method: monacoMethod,
                      error: null
                    }
                  }
                }
              };
            }

            return {
              id: message.id,
              result: {
                result: {
                  type: 'object',
                  value: {
                    surface: 'monaco-model',
                    found: true,
                    operation: monacoOperation,
                    success: true,
                    inspected: 64,
                    candidateCount: 2,
                    candidates: [],
                    editor: {
                      path: 'root[2].__reactContainer$mock.child.memoizedState.memoizedState.current._editor',
                      ctor: 'MockMonacoEditor',
                      methods: ['getModel', 'getValue', 'executeEdits', 'focus'],
                      hasModel: true,
                      selectionCount: 1
                    },
                    model: {
                      path: 'root[2].__reactContainer$mock.child.memoizedState.memoizedState.current._editor.model',
                      ctor: 'MockMonacoModel',
                      methods: ['getValue', 'setValue', 'getFullModelRange'],
                      lineCount: countLines(state.editorText)
                    },
                    text: state.editorText,
                    textLength: state.editorText.length,
                    previousValueLength: state.editorText.length,
                    appliedTextLength: 0,
                    method: null,
                    error: null
                  }
                }
              }
            };
          }
          const operation = String(payload?.operation || 'read').trim().toLowerCase();

          if (operation === 'focus-select-all') {
            state.focusCalls += 1;
            if (typeof options?.onFocus === 'function') {
              applyMutationResult(options.onFocus({
                payload,
                state: { ...state }
              }));
            }
            return {
              id: message.id,
              result: {
                result: {
                  type: 'object',
                  value: buildRuntimePayload('focus-select-all', {
                    focused: true,
                    selectedAll: state.editorText.length > 0
                  })
                }
              }
            };
          }

          if (operation === 'force-set') {
            state.forceSetCalls += 1;
            const desiredText = String(payload?.text || '');
            const previousValueLength = state.editorText.length;
            if (typeof options?.onForceSet === 'function') {
              applyMutationResult(options.onForceSet({
                desiredText,
                payload,
                state: { ...state }
              }));
            } else {
              state.editorText = desiredText;
              if (options?.forceSetKeepsRenderedStale !== true) {
                state.renderedText = desiredText;
              }
            }
            return {
              id: message.id,
              result: {
                result: {
                  type: 'object',
                  value: buildRuntimePayload('force-set', {
                    previousValueLength,
                    appliedTextLength: desiredText.length,
                    dispatchedBeforeInput: 'InputEvent',
                    dispatchedInput: 'InputEvent',
                    dispatchedChange: 'Event'
                  })
                }
              }
            };
          }

          if (operation === 'dialog-force-set') {
            const desiredText = String(payload?.text || '');
            const previousValue = Array.isArray(state.dialogInputValues) && state.dialogInputValues.length > 0
              ? String(state.dialogInputValues[0] || '')
              : '';
            if (typeof options?.onDialogForceSet === 'function') {
              const dialogForceSetResult = options.onDialogForceSet({
                desiredText,
                payload,
                state: { ...state }
              });
              if (dialogForceSetResult && typeof dialogForceSetResult === 'object') {
                applyMutationResult(dialogForceSetResult.mutation || dialogForceSetResult);
              }
            } else {
              state.dialogInputValues = desiredText ? [desiredText] : [];
            }
            return {
              id: message.id,
              result: {
                result: {
                  type: 'object',
                  value: buildRuntimePayload('dialog-force-set', {
                    dialogFound: true,
                    dialogInputApplied: String(state.dialogInputValues[0] || '') === desiredText,
                    previousValueLength: previousValue.length,
                    appliedTextLength: desiredText.length,
                    dispatchedBeforeInput: 'InputEvent',
                    dispatchedInput: 'InputEvent',
                    dispatchedChange: 'Event'
                  })
                }
              }
            };
          }

          state.readCalls += 1;
          let readPayloadOverrides = null;
          if (typeof options?.onRead === 'function') {
            const readHookResult = options.onRead({
              payload,
              state: { ...state }
            });
            if (readHookResult && typeof readHookResult === 'object') {
              applyMutationResult(readHookResult.mutation || readHookResult);
              if (readHookResult.payloadOverrides && typeof readHookResult.payloadOverrides === 'object') {
                readPayloadOverrides = readHookResult.payloadOverrides;
              }
            }
          }
          return {
            id: message.id,
            result: {
              result: {
                type: 'object',
                value: buildRuntimePayload('read', readPayloadOverrides || {})
              }
            }
          };
        }
        case 'Input.insertText': {
          state.inputInsertCalls += 1;
          const text = String(message?.params?.text || '');
          if (typeof options?.onInputInsertText === 'function') {
            applyMutationResult(options.onInputInsertText({
              text,
              state: { ...state }
            }));
          } else {
            state.editorText = text;
            if (options?.inputInsertKeepsRenderedStale !== true) {
              state.renderedText = text;
            }
          }
          return {
            id: message.id,
            result: {}
          };
        }
        default:
          return {
            id: message.id,
            result: {}
          };
      }
    })
  };

  return {
    state,
    deps
  };
}

function buildWatcherElement(overrides = {}) {
  return {
    id: 'Button|Pine|pine-toolbar-button|1500|680',
    name: 'Pine',
    type: 'Button',
    automationId: 'pine-toolbar-button',
    className: 'Button',
    windowHandle: 460832,
    bounds: { x: 1500, y: 680, width: 88, height: 28 },
    ...overrides
  };
}

function normalizeWatcherKeyText(value = '') {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function summarizeWatcherElementForActivation(element = {}) {
  return {
    id: String(element.id || ''),
    name: String(element.name || ''),
    type: String(element.type || ''),
    automationId: String(element.automationId || ''),
    className: String(element.className || ''),
    windowHandle: Number(element.windowHandle || 0) || 0,
    bounds: element.bounds || null
  };
}

function buildWatcherElementKeyForActivation(summary = {}) {
  const bounds = summary.bounds || {};
  return [
    normalizeWatcherKeyText(summary.id || ''),
    normalizeWatcherKeyText(summary.name || ''),
    normalizeWatcherKeyText(summary.automationId || ''),
    normalizeWatcherKeyText(summary.type || ''),
    Math.round((Number(bounds.x || 0) || 0) / 24),
    Math.round((Number(bounds.y || 0) || 0) / 24),
    Math.round((Number(bounds.width || 0) || 0) / 24),
    Math.round((Number(bounds.height || 0) || 0) / 24)
  ].join('|');
}

async function main() {
  await test('getForegroundWindowHandle uses automation host when enabled', async () => {
    let callCount = 0;

    await withAutomationHost({
      getForegroundWindowInfo: async () => {
        callCount += 1;
        return buildWindowInfo({ hwnd: 9988 });
      }
    }, async () => {
      const result = await systemAutomation.getForegroundWindowHandle();
      assert.strictEqual(result, 9988);
      assert.strictEqual(callCount, 1);
    });
  });

  await test('getForegroundWindowInfo preserves structured foreground shape from automation host', async () => {
    let callCount = 0;

    await withAutomationHost({
      getForegroundWindowInfo: async () => {
        callCount += 1;
        return buildWindowInfo({ ownerHwnd: 444, isToolWindow: true, windowKind: 'palette' });
      }
    }, async () => {
      const result = await systemAutomation.getForegroundWindowInfo();
      assert.strictEqual(callCount, 1);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.hwnd, 777);
      assert.strictEqual(result.pid, 4242);
      assert.strictEqual(result.processName, 'tradingview');
      assert.strictEqual(result.ownerHwnd, 444);
      assert.strictEqual(result.isToolWindow, true);
      assert.strictEqual(result.windowKind, 'palette');
      assert.deepStrictEqual(result.bounds, { x: 10, y: 20, width: 1280, height: 900 });
      assert.strictEqual(result.source, 'uia-host');
    });
  });

  await test('getWindowInfoByHandle routes through automation host when enabled', async () => {
    const lookedUpHandles = [];

    await withAutomationHost({
      getWindowInfoByHandle: async (hwnd) => {
        lookedUpHandles.push(hwnd);
        return buildWindowInfo({ hwnd, title: `Window ${hwnd}` });
      }
    }, async () => {
      const result = await systemAutomation.getWindowInfoByHandle(321);
      assert.deepStrictEqual(lookedUpHandles, [321]);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.hwnd, 321);
      assert.strictEqual(result.title, 'Window 321');
      assert.strictEqual(result.processName, 'tradingview');
      assert.strictEqual(result.source, 'uia-host');
    });
  });

  await test('getClipboardText and setClipboardText route through automation host when enabled', async () => {
    const writes = [];

    await withAutomationHost({
      getClipboardText: async () => ({ text: 'host clipboard payload' }),
      setClipboardText: async (text) => {
        writes.push(text);
        return { ok: true };
      }
    }, async () => {
      const readResult = await systemAutomation.getClipboardText();
      assert.deepStrictEqual(readResult, {
        success: true,
        text: 'host clipboard payload',
        error: null,
        source: 'uia-host'
      });

      const writeResult = await systemAutomation.setClipboardText('pine script payload');
      assert.deepStrictEqual(writes, ['pine script payload']);
      assert.deepStrictEqual(writeResult, {
        success: true,
        error: null,
        source: 'uia-host'
      });
    });
  });

  await test('getWindowInfoByHandle rejects invalid handles before host lookup', async () => {
    let hostCalled = false;

    await withAutomationHost({
      getWindowInfoByHandle: async () => {
        hostCalled = true;
        return buildWindowInfo();
      }
    }, async () => {
      const result = await systemAutomation.getWindowInfoByHandle(0);
      assert.strictEqual(hostCalled, false);
      assert.deepStrictEqual(result, { success: false, error: 'Invalid window handle' });
    });
  });

  await test('focusWindow routes through automation host when enabled', async () => {
    const calls = [];

    await withAutomationHost({
      focusWindow: async (hwnd) => {
        calls.push(hwnd);
        return {
          requestedWindowHandle: hwnd,
          actualForegroundHandle: hwnd,
          actualForeground: buildWindowInfo({ hwnd, title: `Focused ${hwnd}` }),
          exactMatch: true,
          restored: false,
          focusAttempted: true,
          outcome: 'exact'
        };
      }
    }, async () => {
      const result = await systemAutomation.focusWindow(456);
      assert.deepStrictEqual(calls, [456]);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.requestedWindowHandle, 456);
      assert.strictEqual(result.actualForegroundHandle, 456);
      assert.strictEqual(result.actualForeground?.title, 'Focused 456');
      assert.strictEqual(result.actualForeground?.source, 'uia-host');
      assert.strictEqual(result.exactMatch, true);
    });
  });

  await test('restoreWindow routes through automation host when enabled', async () => {
    const calls = [];

    await withAutomationHost({
      restoreWindow: async (hwnd) => {
        calls.push(hwnd);
        return {
          hwnd,
          restored: true,
          window: buildWindowInfo({ hwnd, isMinimized: false })
        };
      }
    }, async () => {
      const result = await systemAutomation.restoreWindow(654);
      assert.deepStrictEqual(calls, [654]);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.hwnd, 654);
      assert.strictEqual(result.restored, true);
      assert.strictEqual(result.window?.source, 'uia-host');
      assert.strictEqual(result.source, 'uia-host');
    });
  });

  await test('resolveWindowHandle prefers automation host findWindow when enabled', async () => {
    const lookups = [];

    await withAutomationHost({
      findWindow: async (criteria) => {
        lookups.push(criteria);
        return buildWindowInfo({ hwnd: 909, title: 'TradingView - Watchlist' });
      }
    }, async () => {
      const hwnd = await systemAutomation.resolveWindowHandle({
        title: 'TradingView',
        processName: 'tradingview'
      });
      assert.strictEqual(hwnd, 909);
      assert.strictEqual(lookups.length, 1);
      assert.deepStrictEqual(lookups[0], {
        title: 'TradingView',
        titleMode: 'contains',
        processName: 'tradingview',
        className: ''
      });
    });
  });

  await test('getFocusedElementInWindowWithHost preserves focused descendant metadata from automation host', async () => {
    const calls = [];

    await withAutomationHost({
      getFocusedElementInWindow: async (hwnd) => {
        calls.push(hwnd);
        return {
          focused: true,
          reason: 'focused-descendant',
          element: {
            Name: 'Search tool or function',
            ControlType: 'ControlType.Edit',
            AutomationId: 'command-search',
            WindowHandle: hwnd,
            NativeWindowHandle: hwnd,
            Patterns: ['Value', 'Text'],
            HasKeyboardFocus: true,
            IsFocusable: true,
            Bounds: { X: 120, Y: 80, Width: 320, Height: 32, CenterX: 280, CenterY: 96 }
          },
          targetWindow: buildWindowInfo({ hwnd, title: 'TradingView' }),
          focusedWindow: buildWindowInfo({ hwnd, title: 'TradingView' }),
          stats: { depth: 3, elapsedMs: 12 }
        };
      }
    }, async () => {
      const result = await systemAutomation.getFocusedElementInWindowWithHost(707);
      assert.deepStrictEqual(calls, [707]);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.focused, true);
      assert.strictEqual(result.reason, 'focused-descendant');
      assert.strictEqual(result.element?.Name, 'Search tool or function');
      assert.strictEqual(result.element?.ControlType, 'ControlType.Edit');
      assert.strictEqual(result.element?.HasKeyboardFocus, true);
      assert.strictEqual(result.targetWindow?.hwnd, 707);
      assert.strictEqual(result.focusedWindow?.hwnd, 707);
      assert.strictEqual(result.source, 'uia-host');
    });
  });

  await test('clickElementByText uses host invoke and preserves no-coordinate fallback policy', async () => {
    const calls = [];

    await withAutomationHost({
      findElementsByWindow: async (hwnd, options) => {
        calls.push({ cmd: 'findElementsByWindow', hwnd, options });
        return {
          elements: [{
            Name: 'Pine',
            ControlType: 'ControlType.Button',
            AutomationId: '',
            WindowHandle: hwnd,
            Patterns: ['Invoke'],
            Bounds: { X: 10, Y: 20, Width: 40, Height: 30, CenterX: 30, CenterY: 35 }
          }],
          count: 1,
          stats: { visited: 5, timedOut: false }
        };
      },
      focusWindow: async (hwnd) => {
        calls.push({ cmd: 'focusWindow', hwnd });
        return {
          requestedWindowHandle: hwnd,
          actualForegroundHandle: hwnd,
          actualForeground: buildWindowInfo({ hwnd }),
          exactMatch: true,
          outcome: 'exact'
        };
      },
      invokeElementByWindow: async (hwnd, options) => {
        calls.push({ cmd: 'invokeElementByWindow', hwnd, options });
        return {
          method: 'Invoke',
          element: {
            Name: 'Pine',
            ControlType: 'ControlType.Button',
            WindowHandle: hwnd,
            Patterns: ['Invoke'],
            Bounds: { X: 10, Y: 20, Width: 40, Height: 30, CenterX: 30, CenterY: 35 }
          },
          stats: { visited: 5, timedOut: false }
        };
      }
    }, async () => {
      const result = await systemAutomation.clickElementByText('Pine', {
        windowHandle: 123,
        controlType: 'Button',
        exact: true,
        allowCoordinateFallback: false
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.source, 'uia-host');
      assert.strictEqual(result.method, 'Invoke');
      assert.deepStrictEqual(calls.map((call) => call.cmd), [
        'findElementsByWindow',
        'focusWindow',
        'invokeElementByWindow'
      ]);
      assert.strictEqual(calls[2].options.text, 'Pine');
      assert.strictEqual(calls[2].options.textMode, 'exact');
    });
  });

  await test('clickElementByText attaches a bounded post-click Pine surface probe after a host-confirmed TradingView save modal click', async () => {
    await withAutomationHost({
      findElementsByWindow: async (hwnd) => ({
        elements: [{
          Name: 'Yes',
          ControlType: 'ControlType.Button',
          AutomationId: '',
          WindowHandle: hwnd,
          Patterns: ['Invoke'],
          Bounds: { X: 10, Y: 20, Width: 40, Height: 30, CenterX: 30, CenterY: 35 }
        }],
        count: 1,
        stats: { visited: 5, timedOut: false }
      }),
      focusWindow: async (hwnd) => ({
        requestedWindowHandle: hwnd,
        actualForegroundHandle: hwnd,
        actualForeground: buildWindowInfo({ hwnd }),
        exactMatch: true,
        outcome: 'exact'
      }),
      invokeElementByWindow: async (hwnd) => ({
        method: 'Invoke',
        element: {
          Name: 'Yes',
          ControlType: 'ControlType.Button',
          WindowHandle: hwnd,
          Patterns: ['Invoke'],
          Bounds: { X: 10, Y: 20, Width: 40, Height: 30, CenterX: 30, CenterY: 35 }
        },
        stats: { visited: 5, timedOut: false }
      }),
      getWindowInfoByHandle: async (hwnd) => buildWindowInfo({
        hwnd,
        title: 'MN / Unnamed'
      })
    }, async () => {
      const result = await systemAutomation.clickElementByText('Yes', {
        windowHandle: 123,
        controlType: 'Button',
        exact: true,
        allowCoordinateFallback: false,
        rendererInvoke: {
          kind: 'replace-existing-script-confirmation',
          buttonText: 'Yes',
          pineExpectedScriptName: 'Liku Live Save Probe',
          requiredTexts: [
            "Script 'Liku Live Save Probe' already exists",
            'replace it'
          ]
        },
        cdpDependencies: buildTradingViewCdpDependencies({
          port: 9562,
          domPayload: {
            matched: true,
            anchorText: 'Liku Live Save Probe',
            signals: [
              {
                text: 'Liku Live Save Probe',
                observedText: 'Liku Live Save Probe',
                source: 'dom-node',
                category: 'save-title'
              },
              {
                text: 'Add to chart',
                observedText: 'Add to chart',
                source: 'dom-node',
                category: 'surface'
              }
            ],
            scannedNodes: 24,
            usedBodyInnerText: false
          }
        })
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.source, 'uia-host');
      assert.strictEqual(result.method, 'Invoke');
      assert.strictEqual(result.pineEditorSurfaceProbe?.active, true);
      assert(result.pineEditorSurfaceProbe.visibleAnchors.includes('Liku Live Save Probe'));
      assert(result.pineEditorSurfaceProbe.visibleAnchors.includes('Add to chart'));
    });
  });

  await test('clickElementByText recovers the TradingView foreground hwnd for post-click Pine surface proof when host invoke returns no usable handle', async () => {
    let foregroundCalls = 0;

    await withAutomationHost({
      getForegroundWindowInfo: async () => {
        foregroundCalls += 1;
        return buildWindowInfo({
          hwnd: 460832,
          title: 'MN / Unnamed'
        });
      },
      findElementsByWindow: async (hwnd) => {
        assert.strictEqual(hwnd, 460832);
        return {
          elements: [{
            Name: 'Yes',
            ControlType: 'ControlType.Button',
            AutomationId: '',
            WindowHandle: 0,
            Patterns: ['Invoke'],
            Bounds: { X: 10, Y: 20, Width: 40, Height: 30, CenterX: 30, CenterY: 35 }
          }],
          count: 1,
          stats: { visited: 5, timedOut: false }
        };
      },
      invokeElementByWindow: async (hwnd) => {
        assert.strictEqual(hwnd, 460832);
        return {
          method: 'Invoke',
          element: {
            Name: 'Yes',
            ControlType: 'ControlType.Button',
            WindowHandle: 0,
            Patterns: ['Invoke'],
            Bounds: { X: 10, Y: 20, Width: 40, Height: 30, CenterX: 30, CenterY: 35 }
          },
          stats: { visited: 5, timedOut: false }
        };
      }
    }, async () => {
      const result = await systemAutomation.clickElementByText('Yes', {
        controlType: 'Button',
        exact: true,
        foregroundOnly: true,
        allowCoordinateFallback: false,
        rendererInvoke: {
          kind: 'replace-existing-script-confirmation',
          buttonText: 'Yes',
          pineExpectedScriptName: 'Liku Live Save Probe',
          requiredTexts: [
            "Script 'Liku Live Save Probe' already exists",
            'replace it'
          ]
        },
        cdpDependencies: buildTradingViewCdpDependencies({
          port: 9567,
          domPayload: {
            matched: true,
            anchorText: 'Liku Live Save Probe',
            signals: [
              {
                text: 'Liku Live Save Probe',
                observedText: 'Liku Live Save Probe',
                source: 'dom-node',
                category: 'save-title'
              },
              {
                text: 'All changes saved',
                observedText: 'All changes saved',
                source: 'dom-node',
                category: 'save-confirmed'
              },
              {
                text: 'Add to chart',
                observedText: 'Add to chart',
                source: 'dom-node',
                category: 'surface'
              }
            ],
            scannedNodes: 24,
            usedBodyInnerText: false
          }
        })
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.source, 'uia-host');
      assert.strictEqual(result.method, 'Invoke');
      assert.strictEqual(result.pineEditorSurfaceProbe?.active, true);
      assert(result.pineEditorSurfaceProbe.visibleAnchors.includes('Liku Live Save Probe'));
      assert(result.pineEditorSurfaceProbe.visibleAnchors.includes('All changes saved'));
      assert.strictEqual(foregroundCalls >= 2, true);
    });
  });

  await test('clickElementByText fails closed when host invoke fails and coordinate fallback is disabled', async () => {
    await withAutomationHost({
      findElementsByWindow: async (hwnd) => ({
        elements: [{
          Name: 'Pine',
          ControlType: 'ControlType.Button',
          WindowHandle: hwnd,
          Patterns: ['Invoke'],
          Bounds: { X: 10, Y: 20, Width: 40, Height: 30, CenterX: 30, CenterY: 35 }
        }],
        count: 1
      }),
      focusWindow: async (hwnd) => ({
        requestedWindowHandle: hwnd,
        actualForegroundHandle: hwnd,
        actualForeground: buildWindowInfo({ hwnd }),
        exactMatch: true,
        outcome: 'exact'
      }),
      invokeElementByWindow: async () => {
        throw new Error('InvokePattern failed');
      }
    }, async () => {
      const result = await systemAutomation.clickElementByText('Pine', {
        windowHandle: 123,
        controlType: 'Button',
        exact: true,
        allowCoordinateFallback: false
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.method, 'invoke-only');
      assert(/coordinate fallback is disabled/i.test(result.error));
    });
  });

  await test('probeTradingViewPineEditorRendererWithCDP reports an explicit unavailable reason when TradingView is not exposing a remote debugging port', async () => {
    const rendererProbe = await systemAutomation.probeTradingViewPineEditorRendererWithCDP({
      windowInfo: buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed'
      }),
      resolveWindowState: false,
      cdpDependencies: {
        processInspector: async () => ({
          success: true,
          processes: [{
            pid: 4242,
            name: 'TradingView.exe',
            commandLine: 'TradingView.exe',
            ports: []
          }]
        }),
        listeningPortInspector: async () => ({
          success: true,
          listeners: []
        })
      }
    });

    assert.strictEqual(rendererProbe?.applicable, true);
    assert.strictEqual(rendererProbe?.available, false);
    assert.strictEqual(rendererProbe?.active, false);
    assert.strictEqual(rendererProbe?.reason, 'remote-debugging-port-not-configured');
    assert.strictEqual(rendererProbe?.port, 0);
  });

  await test('probeTradingViewPineEditorRendererWithCDP classifies CDP port discovery failures explicitly when process inspection is unavailable', async () => {
    const rendererProbe = await systemAutomation.probeTradingViewPineEditorRendererWithCDP({
      windowInfo: buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed'
      }),
      resolveWindowState: false,
      cdpDependencies: {
        processInspector: async () => ({
          success: false,
          error: 'PowerShell script timed out after 1200ms',
          processes: []
        })
      }
    });

    assert.strictEqual(rendererProbe?.applicable, true);
    assert.strictEqual(rendererProbe?.available, false);
    assert.strictEqual(rendererProbe?.active, false);
    assert.strictEqual(rendererProbe?.reason, 'remote-debugging-port-discovery-failed');
    assert.strictEqual(rendererProbe?.discovery?.processInspection?.success, false);
  });

  await test('probeTradingViewPineEditorRendererWithCDP can reuse a cached CDP port when process inspection is temporarily unavailable', async () => {
    const seededDeps = buildTradingViewCdpDependencies({ port: 9444 });
    const cachedWindowInfo = buildWindowInfo({
      hwnd: 460832,
      pid: 5252,
      processId: 5252,
      processName: 'TradingViewCache',
      title: 'MN / Unnamed'
    });

    const seededProbe = await systemAutomation.probeTradingViewPineEditorRendererWithCDP({
      windowInfo: cachedWindowInfo,
      resolveWindowState: false,
      cdpDependencies: seededDeps
    });
    assert.strictEqual(seededProbe?.available, true);
    assert.strictEqual(seededProbe?.port, 9444);

    const recoveredProbe = await systemAutomation.probeTradingViewPineEditorRendererWithCDP({
      windowInfo: cachedWindowInfo,
      resolveWindowState: false,
      cdpDependencies: {
        processInspector: async () => ({
          success: false,
          error: 'PowerShell script timed out after 1200ms',
          processes: []
        }),
        fetchImpl: seededDeps.fetchImpl,
        WebSocketCtor: seededDeps.WebSocketCtor
      }
    });

    assert.strictEqual(recoveredProbe?.available, true);
    assert.strictEqual(recoveredProbe?.port, 9444);
    assert.strictEqual(recoveredProbe?.matchedBy, 'chromium-cdp-dom');
  });

  await test('invokeTradingViewRendererButtonWithCDP uses AX-backed DOM resolution for exact TradingView confirmation buttons', async () => {
    const cdpCalls = [];
    const invokeResult = await systemAutomation.invokeTradingViewRendererButtonWithCDP({
      windowInfo: buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed'
      }),
      resolveWindowState: false,
      buttonText: 'Yes',
      requiredTexts: [
        'You have unsaved changes',
        'Would you like to save them'
      ],
      cdpDependencies: buildTradingViewCdpDependencies({
        port: 9555,
        onMessage: (message) => {
          cdpCalls.push({
            method: message?.method,
            params: message?.params || null
          });
        },
        axNodes: [
          {
            nodeId: '100',
            ignored: false,
            role: { value: 'generic' },
            name: { value: 'Confirmation You have unsaved changes in your current script. Would you like to save them? Yes No close' }
          },
          {
            nodeId: '11043',
            ignored: false,
            role: { value: 'button' },
            name: { value: 'Yes' },
            backendDOMNodeId: 11043
          }
        ],
        domResolveResult: {
          object: {
            objectId: 'mock-node-yes'
          }
        },
        callFunctionOnValue: {
          clicked: true,
          text: 'Yes',
          tagName: 'BUTTON'
        }
      })
    });

    assert.strictEqual(invokeResult?.success, true);
    assert.strictEqual(invokeResult?.available, true);
    assert.strictEqual(invokeResult?.method, 'chromium-cdp-ax-dom-click');
    assert.strictEqual(invokeResult?.port, 9555);
    assert.strictEqual(invokeResult?.axNode?.name, 'Yes');
    assert.strictEqual(invokeResult?.axNode?.role, 'button');
    assert(cdpCalls.some((call) => call?.method === 'DOM.resolveNode' && Number(call?.params?.backendNodeId || 0) === 11043));
    assert(cdpCalls.some((call) => call?.method === 'Runtime.callFunctionOn' && String(call?.params?.objectId || '') === 'mock-node-yes'));
  });

  await test('invokeTradingViewRendererButtonWithCDP fails closed when the required confirmation text is missing', async () => {
    const invokeResult = await systemAutomation.invokeTradingViewRendererButtonWithCDP({
      windowInfo: buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed'
      }),
      resolveWindowState: false,
      buttonText: 'Yes',
      requiredTexts: [
        'You have unsaved changes',
        'Would you like to save them'
      ],
      cdpDependencies: buildTradingViewCdpDependencies({
        port: 9556,
        axNodes: [
          {
            nodeId: '22001',
            ignored: false,
            role: { value: 'button' },
            name: { value: 'Yes' },
            backendDOMNodeId: 22001
          }
        ]
      })
    });

    assert.strictEqual(invokeResult?.success, false);
    assert.strictEqual(invokeResult?.available, true);
    assert.strictEqual(invokeResult?.reason, 'renderer-required-text-missing');
  });

  await test('invokeTradingViewRendererButtonWithCDP can open the current Pine script menu and choose Create new without Ctrl+I', async () => {
    let callFunctionOnCount = 0;
    const initialAxNodes = [
      {
        nodeId: '51000',
        ignored: false,
        role: { value: 'generic' },
        name: { value: 'Pine Editor My Script Add to chart Publish script More' }
      },
      {
        nodeId: '51001',
        ignored: false,
        role: { value: 'button' },
        name: { value: 'My Script' },
        backendDOMNodeId: 51001
      },
      {
        nodeId: '51002',
        ignored: false,
        role: { value: 'button' },
        name: { value: 'Add to chart' },
        backendDOMNodeId: 51002
      },
      {
        nodeId: '51003',
        ignored: false,
        role: { value: 'button' },
        name: { value: 'Publish script' },
        backendDOMNodeId: 51003
      },
      {
        nodeId: '51004',
        ignored: false,
        role: { value: 'button' },
        name: { value: 'More' },
        backendDOMNodeId: 51004
      }
    ];
    const menuAxNodes = [
      ...initialAxNodes,
      {
        nodeId: '52001',
        ignored: false,
        role: { value: 'menuitem' },
        name: { value: 'Save script' },
        backendDOMNodeId: 52001
      },
      {
        nodeId: '52002',
        ignored: false,
        role: { value: 'menuitem' },
        name: { value: 'Make a copy…' },
        backendDOMNodeId: 52002
      },
      {
        nodeId: '52003',
        ignored: false,
        role: { value: 'menuitem' },
        name: { value: 'Rename…' },
        backendDOMNodeId: 52003
      },
      {
        nodeId: '52004',
        ignored: false,
        role: { value: 'menuitem' },
        name: { value: 'Create new' },
        backendDOMNodeId: 52004
      }
    ];

    const invokeResult = await systemAutomation.invokeTradingViewRendererButtonWithCDP({
      windowInfo: buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed'
      }),
      resolveWindowState: false,
      kind: 'pine-current-script-menu-item',
      buttonText: 'Create new',
      menuItemText: 'Create new',
      requiredTexts: [
        'Add to chart',
        'Publish script'
      ],
      cdpDependencies: buildTradingViewCdpDependencies({
        port: 9565,
        axNodes: initialAxNodes,
        onCallFunctionOn: () => {
          callFunctionOnCount += 1;
          if (callFunctionOnCount === 1) {
            return {
              callFunctionOnValue: {
                text: 'Add to chart',
                title: 'Add to chart',
                tagName: 'BUTTON',
                rect: { x: 348, y: 62, width: 145, height: 34 }
              }
            };
          }
          if (callFunctionOnCount === 2) {
            return {
              callFunctionOnValue: {
                text: 'My Script',
                tagName: 'DIV',
                role: 'button',
                rect: { x: 75, y: 62, width: 220, height: 34 }
              }
            };
          }
          if (callFunctionOnCount === 3) {
            return {
              axNodes: menuAxNodes,
              callFunctionOnValue: {
                clicked: true,
                text: 'My Script',
                tagName: 'DIV',
                rect: { x: 75, y: 62, width: 220, height: 34 }
              }
            };
          }
          return {
            callFunctionOnValue: {
              clicked: true,
              text: 'Create new',
              tagName: 'DIV',
              rect: { x: 102, y: 204, width: 160, height: 32 }
            }
          };
        }
      })
    });

    assert.strictEqual(invokeResult?.success, true);
    assert.strictEqual(invokeResult?.available, true);
    assert.strictEqual(invokeResult?.method, 'chromium-cdp-ax-dom-click');
    assert.strictEqual(invokeResult?.titleButton?.name, 'My Script');
    assert.strictEqual(invokeResult?.axNode?.name, 'Create new');
    assert.strictEqual(invokeResult?.clickResult?.text, 'Create new');
    assert.strictEqual(invokeResult?.effectProof?.postClickPineRendererProof?.active, true);
  });

  await test('invokeTradingViewRendererButtonWithCDP can expand Create new and choose Indicator from the Pine submenu', async () => {
    let titleClicked = false;
    let createNewHovered = false;
    const initialAxNodes = [
      {
        nodeId: '71000',
        ignored: false,
        role: { value: 'generic' },
        name: { value: 'Pine Editor Liku Live Save Probe Add to chart Publish script More' }
      },
      {
        nodeId: '71001',
        ignored: false,
        role: { value: 'button' },
        name: { value: 'Liku Live Save Probe' },
        backendDOMNodeId: 71001
      },
      {
        nodeId: '71002',
        ignored: false,
        role: { value: 'button' },
        name: { value: 'Add to chart' },
        backendDOMNodeId: 71002
      },
      {
        nodeId: '71003',
        ignored: false,
        role: { value: 'button' },
        name: { value: 'Publish script' },
        backendDOMNodeId: 71003
      }
    ];
    const menuAxNodes = [
      ...initialAxNodes,
      {
        nodeId: '72001',
        ignored: false,
        role: { value: 'menuitem' },
        name: { value: 'Save script' },
        backendDOMNodeId: 72001
      },
      {
        nodeId: '72002',
        ignored: false,
        role: { value: 'menuitem' },
        name: { value: 'Create new' },
        backendDOMNodeId: 72002
      },
      {
        nodeId: '72003',
        ignored: false,
        role: { value: 'menuitem' },
        name: { value: 'Open script' },
        backendDOMNodeId: 72003
      }
    ];
    const submenuAxNodes = [
      ...menuAxNodes,
      {
        nodeId: '73001',
        ignored: false,
        role: { value: 'menuitem' },
        name: { value: 'Indicator' },
        backendDOMNodeId: 73001
      },
      {
        nodeId: '73002',
        ignored: false,
        role: { value: 'menuitem' },
        name: { value: 'Strategy' },
        backendDOMNodeId: 73002
      },
      {
        nodeId: '73003',
        ignored: false,
        role: { value: 'menuitem' },
        name: { value: 'Library' },
        backendDOMNodeId: 73003
      },
      {
        nodeId: '73004',
        ignored: false,
        role: { value: 'menuitem' },
        name: { value: 'Built-in...' },
        backendDOMNodeId: 73004
      }
    ];

    const invokeResult = await systemAutomation.invokeTradingViewRendererButtonWithCDP({
      windowInfo: buildWindowInfo({
        hwnd: 460837,
        title: 'MN / Liku Live Save Probe'
      }),
      resolveWindowState: false,
      kind: 'pine-current-script-menu-item',
      buttonText: 'Create new',
      menuItemText: 'Create new',
      submenuItemText: 'Indicator',
      requiredTexts: [
        'Add to chart',
        'Publish script'
      ],
      cdpDependencies: buildTradingViewCdpDependencies({
        port: 9573,
        axNodes: initialAxNodes,
        onGetFullAXTree: () => ({
          axNodes: titleClicked
            ? (createNewHovered ? submenuAxNodes : menuAxNodes)
            : initialAxNodes
        }),
        onCallFunctionOn: ({ message }) => {
          const fnDecl = String(message?.params?.functionDeclaration || '');
          if (fnDecl.includes('pointerover') || fnDecl.includes('mouseover')) {
            createNewHovered = true;
            return {
              callFunctionOnValue: {
                hovered: true,
                text: 'Create new',
                tagName: 'DIV',
                rect: { x: 102, y: 296, width: 156, height: 30 }
              }
            };
          }

          if (fnDecl.includes('this.click')) {
            if (!titleClicked) {
              titleClicked = true;
              return {
                callFunctionOnValue: {
                  clicked: true,
                  text: 'Liku Live Save Probe',
                  tagName: 'DIV',
                  rect: { x: 67, y: 102, width: 266, height: 32 }
                }
              };
            }
            return {
              callFunctionOnValue: {
                clicked: true,
                text: createNewHovered ? 'Indicator' : 'Create new',
                tagName: 'DIV',
                rect: createNewHovered
                  ? { x: 443, y: 296, width: 188, height: 32 }
                  : { x: 102, y: 296, width: 156, height: 30 }
              }
            };
          }

          return {
            callFunctionOnValue: {
              text: titleClicked ? 'Create new' : 'Liku Live Save Probe',
              tagName: 'DIV',
              role: 'button',
              rect: { x: 67, y: 102, width: 266, height: 32 }
            }
          };
        }
      })
    });

    assert.strictEqual(invokeResult?.success, true);
    assert.strictEqual(invokeResult?.available, true);
    assert.strictEqual(invokeResult?.method, 'chromium-cdp-ax-dom-click');
    assert.strictEqual(invokeResult?.titleButton?.name, 'Liku Live Save Probe');
    assert.strictEqual(invokeResult?.parentMenuItem?.name, 'Create new');
    assert.strictEqual(invokeResult?.axNode?.name, 'Indicator');
    assert.strictEqual(invokeResult?.clickResult?.text, 'Indicator');
    assert(Array.isArray(invokeResult?.submenuDiscovery?.attempts));
    assert(invokeResult.submenuDiscovery.attempts.some((attempt) => attempt?.hoveredParentMenuItem === true));
    assert(invokeResult.submenuDiscovery.attempts.some((attempt) => attempt?.foundExactSubmenuItem === true));
  });

  await test('invokeTradingViewRendererButtonWithCDP tolerates delayed Pine menu exposure after clicking the current script title', async () => {
    let callFunctionOnCount = 0;
    let titleClicked = false;
    let axReadsAfterTitleClick = 0;
    const initialAxNodes = [
      {
        nodeId: '61001',
        ignored: false,
        role: { value: 'button' },
        name: { value: 'Unnamed' },
        backendDOMNodeId: 61001
      },
      {
        nodeId: '61002',
        ignored: false,
        role: { value: 'button' },
        name: { value: 'Add to chart' },
        backendDOMNodeId: 61002
      },
      {
        nodeId: '61003',
        ignored: false,
        role: { value: 'button' },
        name: { value: 'Publish script' },
        backendDOMNodeId: 61003
      }
    ];
    const delayedMenuAxNodes = [
      ...initialAxNodes,
      {
        nodeId: '62001',
        ignored: false,
        role: { value: 'menuitem' },
        name: { value: 'Save script' },
        backendDOMNodeId: 62001
      },
      {
        nodeId: '62002',
        ignored: false,
        role: { value: 'menuitem' },
        name: { value: 'Create new' },
        backendDOMNodeId: 62002
      }
    ];

    const invokeResult = await systemAutomation.invokeTradingViewRendererButtonWithCDP({
      windowInfo: buildWindowInfo({
        hwnd: 460833,
        title: 'MN / Unnamed'
      }),
      resolveWindowState: false,
      kind: 'pine-current-script-menu-item',
      buttonText: 'Create new',
      menuItemText: 'Create new',
      requiredTexts: [
        'Add to chart',
        'Publish script'
      ],
      cdpDependencies: buildTradingViewCdpDependencies({
        port: 9566,
        axNodes: initialAxNodes,
        onGetFullAXTree: () => {
          if (!titleClicked) {
            return {
              axNodes: initialAxNodes
            };
          }
          axReadsAfterTitleClick += 1;
          return {
            axNodes: axReadsAfterTitleClick >= 2 ? delayedMenuAxNodes : initialAxNodes
          };
        },
        onCallFunctionOn: () => {
          callFunctionOnCount += 1;
          if (callFunctionOnCount === 1) {
            return {
              callFunctionOnValue: {
                text: 'Add to chart',
                tagName: 'BUTTON',
                rect: { x: 348, y: 62, width: 145, height: 34 }
              }
            };
          }
          if (callFunctionOnCount === 2) {
            return {
              callFunctionOnValue: {
                text: 'Unnamed',
                tagName: 'DIV',
                role: 'button',
                rect: { x: 75, y: 62, width: 220, height: 34 }
              }
            };
          }
          if (callFunctionOnCount === 3) {
            titleClicked = true;
            return {
              callFunctionOnValue: {
                clicked: true,
                text: 'Unnamed',
                tagName: 'DIV',
                rect: { x: 75, y: 62, width: 220, height: 34 }
              }
            };
          }
          return {
            callFunctionOnValue: {
              clicked: true,
              text: 'Create new',
              tagName: 'DIV',
              rect: { x: 102, y: 204, width: 160, height: 32 }
            }
          };
        }
      })
    });

    assert.strictEqual(invokeResult?.success, true);
    assert.strictEqual(invokeResult?.currentTitleHint, 'unnamed');
    assert(Array.isArray(invokeResult?.menuDiscovery?.attempts));
    assert(invokeResult.menuDiscovery.attempts.some((attempt) => attempt?.foundExactMenuItem === false));
    assert(invokeResult.menuDiscovery.attempts.some((attempt) => attempt?.foundExactMenuItem === true));
  });

  await test('invokeTradingViewRendererButtonWithCDP retries Pine title-menu attach after an initial CDP open timeout', async () => {
    let callFunctionOnCount = 0;
    const initialAxNodes = [
      {
        nodeId: '81001',
        ignored: false,
        role: { value: 'button' },
        name: { value: 'Unnamed' },
        backendDOMNodeId: 81001
      },
      {
        nodeId: '81002',
        ignored: false,
        role: { value: 'button' },
        name: { value: 'Add to chart' },
        backendDOMNodeId: 81002
      },
      {
        nodeId: '81003',
        ignored: false,
        role: { value: 'button' },
        name: { value: 'Publish script' },
        backendDOMNodeId: 81003
      }
    ];
    const menuAxNodes = [
      ...initialAxNodes,
      {
        nodeId: '82001',
        ignored: false,
        role: { value: 'menuitem' },
        name: { value: 'Create new' },
        backendDOMNodeId: 82001
      }
    ];

    const invokeResult = await systemAutomation.invokeTradingViewRendererButtonWithCDP({
      windowInfo: buildWindowInfo({
        hwnd: 460835,
        title: 'MN / Unnamed'
      }),
      resolveWindowState: false,
      kind: 'pine-current-script-menu-item',
      buttonText: 'Create new',
      menuItemText: 'Create new',
      requiredTexts: [
        'Add to chart',
        'Publish script'
      ],
      cdpDependencies: buildTradingViewCdpDependencies({
        port: 9568,
        axNodes: initialAxNodes,
        webSocketOptions: {
          getOpenDelayMs: ({ openCount }) => openCount === 1 ? 900 : 0
        },
        onCallFunctionOn: () => {
          callFunctionOnCount += 1;
          if (callFunctionOnCount === 1) {
            return {
              callFunctionOnValue: {
                text: 'Add to chart',
                title: 'Add to chart',
                tagName: 'BUTTON',
                rect: { x: 348, y: 62, width: 145, height: 34 }
              }
            };
          }
          if (callFunctionOnCount === 2) {
            return {
              callFunctionOnValue: {
                text: 'Unnamed',
                tagName: 'DIV',
                role: 'button',
                rect: { x: 75, y: 62, width: 220, height: 34 }
              }
            };
          }
          if (callFunctionOnCount === 3) {
            return {
              axNodes: menuAxNodes,
              callFunctionOnValue: {
                clicked: true,
                text: 'Unnamed',
                tagName: 'DIV',
                rect: { x: 75, y: 62, width: 220, height: 34 }
              }
            };
          }
          return {
            callFunctionOnValue: {
              clicked: true,
              text: 'Create new',
              tagName: 'DIV',
              rect: { x: 102, y: 204, width: 160, height: 32 }
            }
          };
        }
      })
    });

    assert.strictEqual(invokeResult?.success, true);
    assert(Array.isArray(invokeResult?.cdpAttachAttempts), 'attach diagnostics should be returned');
    assert.strictEqual(invokeResult.cdpAttachAttempts.length, 2);
    assert.strictEqual(invokeResult.cdpAttachAttempts[0]?.success, false);
    assert.strictEqual(invokeResult.cdpAttachAttempts[1]?.success, true);
    assert(/timed out/i.test(String(invokeResult.cdpAttachAttempts[0]?.error || '')));
  });

  await test('invokeTradingViewRendererButtonWithCDP can succeed on a third Pine title-menu attach after two transient CDP open timeouts', async () => {
    let callFunctionOnCount = 0;
    const initialAxNodes = [
      {
        nodeId: '91001',
        ignored: false,
        role: { value: 'button' },
        name: { value: 'Unnamed' },
        backendDOMNodeId: 91001
      },
      {
        nodeId: '91002',
        ignored: false,
        role: { value: 'button' },
        name: { value: 'Add to chart' },
        backendDOMNodeId: 91002
      },
      {
        nodeId: '91003',
        ignored: false,
        role: { value: 'button' },
        name: { value: 'Publish script' },
        backendDOMNodeId: 91003
      }
    ];
    const menuAxNodes = [
      ...initialAxNodes,
      {
        nodeId: '92001',
        ignored: false,
        role: { value: 'menuitem' },
        name: { value: 'Create new' },
        backendDOMNodeId: 92001
      }
    ];

    const invokeResult = await systemAutomation.invokeTradingViewRendererButtonWithCDP({
      windowInfo: buildWindowInfo({
        hwnd: 460836,
        title: 'MN / Unnamed'
      }),
      resolveWindowState: false,
      kind: 'pine-current-script-menu-item',
      buttonText: 'Create new',
      menuItemText: 'Create new',
      requiredTexts: [
        'Add to chart',
        'Publish script'
      ],
      cdpDependencies: buildTradingViewCdpDependencies({
        port: 9572,
        axNodes: initialAxNodes,
        webSocketOptions: {
          getOpenDelayMs: ({ openCount }) => {
            if (openCount === 1) return 900;
            if (openCount === 2) return 1400;
            return 0;
          }
        },
        onCallFunctionOn: () => {
          callFunctionOnCount += 1;
          if (callFunctionOnCount === 1) {
            return {
              callFunctionOnValue: {
                text: 'Add to chart',
                title: 'Add to chart',
                tagName: 'BUTTON',
                rect: { x: 348, y: 62, width: 145, height: 34 }
              }
            };
          }
          if (callFunctionOnCount === 2) {
            return {
              callFunctionOnValue: {
                text: 'Unnamed',
                tagName: 'DIV',
                role: 'button',
                rect: { x: 75, y: 62, width: 220, height: 34 }
              }
            };
          }
          if (callFunctionOnCount === 3) {
            return {
              axNodes: menuAxNodes,
              callFunctionOnValue: {
                clicked: true,
                text: 'Unnamed',
                tagName: 'DIV',
                rect: { x: 75, y: 62, width: 220, height: 34 }
              }
            };
          }
          return {
            callFunctionOnValue: {
              clicked: true,
              text: 'Create new',
              tagName: 'DIV',
              rect: { x: 102, y: 204, width: 160, height: 32 }
            }
          };
        }
      })
    });

    assert.strictEqual(invokeResult?.success, true);
    assert(Array.isArray(invokeResult?.cdpAttachAttempts), 'attach diagnostics should be returned');
    assert.strictEqual(invokeResult.cdpAttachAttempts.length, 3);
    assert.strictEqual(invokeResult.cdpAttachAttempts[0]?.success, false);
    assert.strictEqual(invokeResult.cdpAttachAttempts[1]?.success, false);
    assert.strictEqual(invokeResult.cdpAttachAttempts[2]?.success, true);
    assert(/timed out/i.test(String(invokeResult.cdpAttachAttempts[1]?.error || '')));
  });

  await test('invokeTradingViewRendererButtonWithCDP verifies that the first-save Cancel path actually clears the dialog', async () => {
    let axReadCount = 0;
    const initialAxNodes = [
      {
        nodeId: '31000',
        ignored: false,
        role: { value: 'generic' },
        name: { value: 'Save script New script name Liku Live Save Probe 1 Cancel Save' }
      },
      {
        nodeId: '31010',
        ignored: false,
        role: { value: 'button' },
        name: { value: 'Cancel' },
        backendDOMNodeId: 31010
      },
      {
        nodeId: '31011',
        ignored: false,
        role: { value: 'button' },
        name: { value: 'Save' },
        backendDOMNodeId: 31011
      }
    ];
    const afterClickAxNodes = [
      {
        nodeId: '32000',
        ignored: false,
        role: { value: 'generic' },
        name: { value: 'Pine Editor Add to chart Publish script' }
      }
    ];

    const invokeResult = await systemAutomation.invokeTradingViewRendererButtonWithCDP({
      windowInfo: buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed'
      }),
      resolveWindowState: false,
      kind: 'pine-first-save-confirmation',
      buttonText: 'Cancel',
      requiredTexts: [
        'Save script',
        'New script name'
      ],
      cdpDependencies: buildTradingViewCdpDependencies({
        port: 9557,
        axNodes: initialAxNodes,
        domResolveResult: {
          object: {
            objectId: 'mock-node-cancel'
          }
        },
        onGetFullAXTree: () => {
          axReadCount += 1;
          return null;
        },
        onCallFunctionOn: ({ message }) => {
          assert.strictEqual(String(message?.params?.objectId || ''), 'mock-node-cancel');
          return {
            axNodes: afterClickAxNodes,
            callFunctionOnValue: {
              clicked: true,
              text: 'Cancel',
              tagName: 'BUTTON'
            }
          };
        }
      })
    });

    assert.strictEqual(invokeResult?.success, true);
    assert.strictEqual(invokeResult?.available, true);
    assert.strictEqual(invokeResult?.reason, null);
    assert.strictEqual(invokeResult?.clickResult?.clicked, true);
    assert.strictEqual(invokeResult?.effectProof?.success, true);
    assert.strictEqual(invokeResult?.effectProof?.cleared, true);
    assert(axReadCount >= 2, 'AX tree should be read before and after the click');
  });

  await test('invokeTradingViewRendererButtonWithCDP fails closed when Cancel leaves the first-save dialog visible', async () => {
    const persistentDialogAxNodes = [
      {
        nodeId: '33000',
        ignored: false,
        role: { value: 'generic' },
        name: { value: 'Save script New script name Liku Live Save Probe 1 Cancel Save' }
      },
      {
        nodeId: '33010',
        ignored: false,
        role: { value: 'button' },
        name: { value: 'Cancel' },
        backendDOMNodeId: 33010
      }
    ];

    const invokeResult = await systemAutomation.invokeTradingViewRendererButtonWithCDP({
      windowInfo: buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed'
      }),
      resolveWindowState: false,
      kind: 'pine-first-save-confirmation',
      buttonText: 'Cancel',
      requiredTexts: [
        'Save script',
        'New script name'
      ],
      cdpDependencies: buildTradingViewCdpDependencies({
        port: 9558,
        axNodes: persistentDialogAxNodes,
        domResolveResult: {
          object: {
            objectId: 'mock-node-cancel-stale'
          }
        },
        onCallFunctionOn: ({ message }) => {
          assert.strictEqual(String(message?.params?.objectId || ''), 'mock-node-cancel-stale');
          return {
            axNodes: persistentDialogAxNodes,
            callFunctionOnValue: {
              clicked: true,
              text: 'Cancel',
              tagName: 'BUTTON'
            }
          };
        }
      })
    });

    assert.strictEqual(invokeResult?.success, false);
    assert.strictEqual(invokeResult?.available, true);
    assert.strictEqual(invokeResult?.reason, 'renderer-modal-still-visible');
    assert.strictEqual(invokeResult?.clickResult?.clicked, true);
    assert.strictEqual(invokeResult?.effectProof?.success, false);
    assert.strictEqual(invokeResult?.effectProof?.cleared, false);
    assert.deepStrictEqual(invokeResult?.effectProof?.remainingMatchedRequiredTexts, ['save script', 'new script name']);
    assert(/save-name dialog/i.test(String(invokeResult?.error || '')));
  });

  await test('invokeTradingViewRendererButtonWithCDP treats replace confirmation after first-save Save as a valid transition', async () => {
    let axReadCount = 0;
    const initialAxNodes = [
      {
        nodeId: '34000',
        ignored: false,
        role: { value: 'generic' },
        name: { value: 'Save script New script name Liku Live Save Probe Cancel Save' }
      },
      {
        nodeId: '34010',
        ignored: false,
        role: { value: 'button' },
        name: { value: 'Cancel' },
        backendDOMNodeId: 34010
      },
      {
        nodeId: '34011',
        ignored: false,
        role: { value: 'button' },
        name: { value: 'Save' },
        backendDOMNodeId: 34011
      }
    ];
    const afterClickAxNodes = [
      ...initialAxNodes,
      {
        nodeId: '34100',
        ignored: false,
        role: { value: 'generic' },
        name: { value: "Confirmation Script 'Liku Live Save Probe' already exists. Do you really want to replace it? No Yes close" }
      },
      {
        nodeId: '34110',
        ignored: false,
        role: { value: 'button' },
        name: { value: 'No' },
        backendDOMNodeId: 34110
      },
      {
        nodeId: '34111',
        ignored: false,
        role: { value: 'button' },
        name: { value: 'Yes' },
        backendDOMNodeId: 34111
      }
    ];

    const invokeResult = await systemAutomation.invokeTradingViewRendererButtonWithCDP({
      windowInfo: buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed'
      }),
      resolveWindowState: false,
      kind: 'pine-first-save-confirmation',
      buttonText: 'Save',
      requiredTexts: [
        'Save script',
        'New script name'
      ],
      cdpDependencies: buildTradingViewCdpDependencies({
        port: 9559,
        axNodes: initialAxNodes,
        domResolveResult: {
          object: {
            objectId: 'mock-node-save-first'
          }
        },
        onGetFullAXTree: () => {
          axReadCount += 1;
          return null;
        },
        onCallFunctionOn: ({ message }) => {
          assert.strictEqual(String(message?.params?.objectId || ''), 'mock-node-save-first');
          return {
            axNodes: afterClickAxNodes,
            callFunctionOnValue: {
              clicked: true,
              text: 'Save',
              tagName: 'BUTTON'
            }
          };
        }
      })
    });

    assert.strictEqual(invokeResult?.success, true);
    assert.strictEqual(invokeResult?.available, true);
    assert.strictEqual(invokeResult?.reason, null);
    assert.strictEqual(invokeResult?.clickResult?.clicked, true);
    assert.strictEqual(invokeResult?.effectProof?.success, true);
    assert.strictEqual(invokeResult?.effectProof?.cleared, false);
    assert.strictEqual(invokeResult?.effectProof?.transitioned, true);
    assert.strictEqual(invokeResult?.effectProof?.transitionKind, 'replace-existing-script-confirmation');
    assert.deepStrictEqual(invokeResult?.effectProof?.transitionMatchedRequiredTexts, ['already exists', 'replace it']);
    assert(axReadCount >= 2, 'AX tree should be read before and after the click');
  });

  await test('invokeTradingViewRendererButtonWithCDP can click first-save Save even when companion dialog text is no longer exposed', async () => {
    let axReadCount = 0;
    const initialAxNodes = [
      {
        nodeId: '34500',
        ignored: false,
        role: { value: 'generic' },
        name: { value: 'Untitled script Save' }
      },
      {
        nodeId: '34510',
        ignored: false,
        role: { value: 'button' },
        name: { value: 'Save' },
        backendDOMNodeId: 34510
      }
    ];
    const afterClickAxNodes = [
      {
        nodeId: '34600',
        ignored: false,
        role: { value: 'generic' },
        name: { value: 'Pine Editor Add to chart Publish script' }
      }
    ];

    const invokeResult = await systemAutomation.invokeTradingViewRendererButtonWithCDP({
      windowInfo: buildWindowInfo({
        hwnd: 460833,
        title: 'MN / Untitled'
      }),
      resolveWindowState: false,
      kind: 'pine-first-save-confirmation',
      buttonText: 'Save',
      requiredTexts: [
        'Save script',
        'New script name'
      ],
      cdpDependencies: buildTradingViewCdpDependencies({
        port: 9560,
        axNodes: initialAxNodes,
        domResolveResult: {
          object: {
            objectId: 'mock-node-save-only'
          }
        },
        onGetFullAXTree: () => {
          axReadCount += 1;
          return null;
        },
        onCallFunctionOn: ({ message }) => {
          assert.strictEqual(String(message?.params?.objectId || ''), 'mock-node-save-only');
          return {
            axNodes: afterClickAxNodes,
            callFunctionOnValue: {
              clicked: true,
              text: 'Save',
              tagName: 'BUTTON'
            }
          };
        }
      })
    });

    assert.strictEqual(invokeResult?.success, true);
    assert.strictEqual(invokeResult?.available, true);
    assert.strictEqual(invokeResult?.reason, null);
    assert.strictEqual(invokeResult?.clickResult?.clicked, true);
    assert.deepStrictEqual(invokeResult?.matchedRequiredTexts, []);
    assert.strictEqual(invokeResult?.effectProof?.success, true);
    assert.strictEqual(invokeResult?.effectProof?.cleared, true);
    assert(axReadCount >= 2, 'AX tree should be read before and after the click');
  });

  await test('invokeTradingViewRendererButtonWithCDP captures a post-click Pine surface proof after replace confirmation clears', async () => {
    const initialAxNodes = [
      {
        nodeId: '34200',
        ignored: false,
        role: { value: 'generic' },
        name: { value: "Confirmation Script 'Liku Live Save Probe' already exists. Do you really want to replace it? No Yes close" }
      },
      {
        nodeId: '34210',
        ignored: false,
        role: { value: 'button' },
        name: { value: 'Yes' },
        backendDOMNodeId: 34210
      }
    ];
    const afterClickAxNodes = [
      {
        nodeId: '34300',
        ignored: false,
        role: { value: 'generic' },
        name: { value: 'Pine Editor Liku Live Save Probe Add to chart Publish script' }
      }
    ];

    const invokeResult = await systemAutomation.invokeTradingViewRendererButtonWithCDP({
      windowInfo: buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed'
      }),
      resolveWindowState: false,
      kind: 'replace-existing-script-confirmation',
      buttonText: 'Yes',
      pineExpectedScriptName: 'Liku Live Save Probe',
      requiredTexts: [
        "Script 'Liku Live Save Probe' already exists",
        'replace it'
      ],
      cdpDependencies: buildTradingViewCdpDependencies({
        port: 9561,
        axNodes: initialAxNodes,
        domPayload: {
          matched: true,
          anchorText: 'Liku Live Save Probe',
          signals: [
            {
              text: 'Liku Live Save Probe',
              observedText: 'Liku Live Save Probe',
              source: 'dom-node',
              category: 'save-title'
            },
            {
              text: 'Add to chart',
              observedText: 'Add to chart',
              source: 'dom-node',
              category: 'surface'
            },
            {
              text: 'Publish script',
              observedText: 'Publish script',
              source: 'dom-node',
              category: 'surface'
            }
          ],
          scannedNodes: 24,
          usedBodyInnerText: false
        },
        domResolveResult: {
          object: {
            objectId: 'mock-node-replace-yes'
          }
        },
        onCallFunctionOn: ({ message }) => {
          assert.strictEqual(String(message?.params?.objectId || ''), 'mock-node-replace-yes');
          return {
            axNodes: afterClickAxNodes,
            callFunctionOnValue: {
              clicked: true,
              text: 'Yes',
              tagName: 'BUTTON'
            }
          };
        }
      })
    });

    assert.strictEqual(invokeResult?.success, true);
    assert.strictEqual(invokeResult?.effectProof?.success, true);
    assert.strictEqual(invokeResult?.effectProof?.cleared, true);
    assert.strictEqual(invokeResult?.effectProof?.transitioned, false);
    assert.strictEqual(invokeResult?.effectProof?.postClickPineRendererProof?.active, true);
    assert.strictEqual(invokeResult?.effectProof?.postClickPineRendererProof?.anchorText, 'Liku Live Save Probe');

    const probe = systemAutomation.buildTradingViewPineSurfaceProbeFromRendererInvoke(invokeResult, {
      windowHandle: 460832
    });
    assert.strictEqual(probe?.active, true);
    assert.strictEqual(probe?.matchedBy, 'chromium-cdp-dom');
    assert(probe.visibleAnchors.includes('Liku Live Save Probe'));
    assert(probe.visibleAnchors.includes('Add to chart'));
  });

  await test('buildTradingViewPineSurfaceProbeFromRendererInvoke synthesizes a replace-confirmation Pine probe from a successful renderer transition', async () => {
    const probe = systemAutomation.buildTradingViewPineSurfaceProbeFromRendererInvoke({
      success: true,
      effectProof: {
        success: true,
        transitioned: true,
        transitionKind: 'replace-existing-script-confirmation',
        transitionMatchedRequiredTexts: ['already exists', 'replace it']
      }
    }, {
      windowHandle: 460832
    });

    assert.strictEqual(probe?.active, true);
    assert.strictEqual(probe?.matched, true);
    assert.strictEqual(probe?.matchedBy, 'chromium-cdp-ax-transition');
    assert.strictEqual(probe?.transitionKind, 'replace-existing-script-confirmation');
    assert(Array.isArray(probe?.visibleAnchors));
    assert(probe.visibleAnchors.includes('Confirmation'));
    assert(probe.visibleAnchors.includes('already exists'));
    assert(probe.visibleAnchors.includes('replace it'));
    assert.strictEqual(Number(probe?.windowHandle || 0), 460832);

    const surfaceState = systemAutomation.extractPineEditorSafeAuthoringSurfaceState(probe);
    assert.strictEqual(surfaceState?.saveReplaceConfirmationVisible, true);
  });

  await test('readTradingViewPineEditorContentWithCDP reads the exposed Monaco textarea and rendered lines', async () => {
    const expectedScript = [
      '//@version=6',
      'indicator("Liku Live Save Probe", overlay=false)',
      'plot(close, title="Close")'
    ].join('\n');
    const { deps, state } = buildTradingViewPineEditorCdpMock({
      initialText: expectedScript
    });

    const readback = await systemAutomation.readTradingViewPineEditorContentWithCDP({
      windowInfo: buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed'
      }),
      resolveWindowState: false,
      cdpDependencies: deps
    });

    assert.strictEqual(readback?.success, true);
    assert.strictEqual(readback?.method, 'ChromiumCDPRead');
    assert.strictEqual(String(readback?.text || '').replace(/\r/g, ''), expectedScript);
    assert.strictEqual(String(readback?.renderedText || '').replace(/\r/g, ''), expectedScript);
    assert.strictEqual(state.readCalls >= 1, true);
  });

  await test('setTradingViewPineEditorContentWithCDP prefers the Monaco model-aware route when the editor handle is discoverable', async () => {
    const starterScript = [
      '//@version=6',
      'indicator("My script")',
      'plot(close)'
    ].join('\n');
    const expectedScript = [
      '//@version=6',
      'indicator("Liku Live Save Probe", overlay=false)',
      'plot(close, title="Close")'
    ].join('\n');
    const { deps, state } = buildTradingViewPineEditorCdpMock({
      initialText: starterScript,
      monacoEditorAvailable: true
    });

    const result = await systemAutomation.setTradingViewPineEditorContentWithCDP({
      windowInfo: buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed'
      }),
      resolveWindowState: false,
      text: expectedScript,
      pinePreparedScriptName: 'Liku Live Save Probe',
      cdpDependencies: deps
    });

    assert.strictEqual(result?.success, true);
    assert.strictEqual(result?.method, 'ChromiumCDPMonacoExecuteEdits');
    assert.strictEqual(state.monacoWriteCalls, 1);
    assert.strictEqual(state.inputInsertCalls, 0);
    assert.strictEqual(state.forceSetCalls, 0);
    assert.strictEqual(result?.proof?.exactMatch, true);
    assert.strictEqual(result?.renderedProof?.exactMatch, true);
    assert.strictEqual(String(state.editorText || '').replace(/\r/g, ''), expectedScript);
  });

  await test('setTradingViewPineEditorContentWithCDP verifies Monaco writes from model readback even when the textarea shim stays truncated', async () => {
    const starterScript = [
      '//@version=6',
      'indicator("My script")',
      'plot(close)'
    ].join('\n');
    const expectedScript = [
      '//@version=6',
      'indicator("ATR VWAP MACD RSI Confidence", overlay=false, max_labels_count=100)',
      '',
      'atrLen = input.int(14, "ATR Length", minval=1)',
      'rsiLen = input.int(14, "RSI Length", minval=1)',
      'macdFast = input.int(12, "MACD Fast", minval=1)',
      'macdSlow = input.int(26, "MACD Slow", minval=1)',
      'macdSignal = input.int(9, "MACD Signal", minval=1)',
      'showSignals = input.bool(true, "Show Confidence Signals")',
      'plot(close)'
    ].join('\n');
    const truncatedTextarea = expectedScript.slice(0, 180);
    const { deps, state } = buildTradingViewPineEditorCdpMock({
      initialText: starterScript,
      monacoEditorAvailable: true,
      onRead: () => ({
        payloadOverrides: {
          textarea: {
            tagName: 'TEXTAREA',
            className: 'inputarea monaco-mouse-cursor-text',
            ariaLabel: 'Editor content;Press Alt+F1 for Accessibility Options.',
            value: truncatedTextarea,
            valueLength: truncatedTextarea.length,
            selectionStart: 0,
            selectionEnd: truncatedTextarea.length,
            visible: true,
            focused: true,
            selectedAll: false,
            rect: { x: 1100, y: 490, width: 780, height: 320 },
            score: 999
          },
          rendered: {
            text: 'ATR VWAP MACD RSI Confidence',
            lineCount: 1,
            source: 'view-lines',
            visible: true,
            score: 820
          }
        }
      })
    });

    const result = await systemAutomation.setTradingViewPineEditorContentWithCDP({
      windowInfo: buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed'
      }),
      resolveWindowState: false,
      text: expectedScript,
      pinePreparedScriptName: 'ATR VWAP MACD RSI Confidence',
      cdpDependencies: deps
    });

    assert.strictEqual(result?.success, true);
    assert.strictEqual(result?.method, 'ChromiumCDPMonacoExecuteEdits');
    assert.strictEqual(state.monacoWriteCalls, 1);
    assert.strictEqual(state.inputInsertCalls, 0);
    assert.strictEqual(result?.proof?.exactMatch, true);
    assert.strictEqual(result?.renderedProof?.expectedTitleVisible, true);
    assert.strictEqual(String(result?.text || '').replace(/\r/g, ''), expectedScript);
    assert.strictEqual(String(state.editorText || '').replace(/\r/g, ''), expectedScript);
  });

  await test('setTradingViewPineEditorContentWithCDP prefers Input.insertText when renderer verification succeeds', async () => {
    const starterScript = [
      '//@version=6',
      'indicator("My script")',
      'plot(close)'
    ].join('\n');
    const expectedScript = [
      '//@version=6',
      'indicator("Liku Live Save Probe", overlay=false)',
      'plot(close, title="Close")'
    ].join('\n');
    const { deps, state } = buildTradingViewPineEditorCdpMock({
      initialText: starterScript
    });

    const result = await systemAutomation.setTradingViewPineEditorContentWithCDP({
      windowInfo: buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed'
      }),
      resolveWindowState: false,
      text: expectedScript,
      pinePreparedScriptName: 'Liku Live Save Probe',
      cdpDependencies: deps
    });

    assert.strictEqual(result?.success, true);
    assert.strictEqual(result?.method, 'ChromiumCDPInputInsertText');
    assert.strictEqual(state.inputInsertCalls, 1);
    assert.strictEqual(state.forceSetCalls, 0);
    assert.strictEqual(result?.proof?.exactMatch, true);
    assert.strictEqual(result?.renderedProof?.exactMatch, true);
    assert.strictEqual(String(state.editorText || '').replace(/\r/g, ''), expectedScript);
  });

  await test('setTradingViewPineEditorContentWithCDP falls back to DOM force-set when Input.insertText does not verify', async () => {
    const starterScript = [
      '//@version=6',
      'indicator("My script")',
      'plot(close)'
    ].join('\n');
    const expectedScript = [
      '//@version=6',
      'indicator("Liku Live Save Probe", overlay=false)',
      'plot(close, title="Close")'
    ].join('\n');
    const { deps, state } = buildTradingViewPineEditorCdpMock({
      initialText: starterScript,
      onInputInsertText: () => null,
      onForceSet: ({ desiredText }) => ({
        editorText: desiredText,
        renderedText: desiredText
      })
    });

    const result = await systemAutomation.setTradingViewPineEditorContentWithCDP({
      windowInfo: buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed'
      }),
      resolveWindowState: false,
      text: expectedScript,
      pinePreparedScriptName: 'Liku Live Save Probe',
      cdpDependencies: deps
    });

    assert.strictEqual(result?.success, true);
    assert.strictEqual(result?.method, 'ChromiumCDPDOMInputEvent');
    assert.strictEqual(state.inputInsertCalls, 1);
    assert.strictEqual(state.forceSetCalls, 1);
    assert.strictEqual(result?.proof?.exactMatch, true);
    assert.strictEqual(String(state.editorText || '').replace(/\r/g, ''), expectedScript);
  });

  await test('setTradingViewPineEditorContentWithCDP retries CDP attach after an initial open timeout', async () => {
    const starterScript = [
      '//@version=6',
      'indicator("My script")',
      'plot(close)'
    ].join('\n');
    const expectedScript = [
      '//@version=6',
      'indicator("Liku Live Save Probe", overlay=false)',
      'plot(close, title="Close")'
    ].join('\n');
    const { deps, state } = buildTradingViewPineEditorCdpMock({
      initialText: starterScript,
      webSocketOptions: {
        getOpenDelayMs: ({ openCount }) => openCount === 1 ? 1600 : 0
      }
    });

    const result = await systemAutomation.setTradingViewPineEditorContentWithCDP({
      windowInfo: buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed'
      }),
      resolveWindowState: false,
      text: expectedScript,
      pinePreparedScriptName: 'Liku Live Save Probe',
      cdpDependencies: deps
    });

    assert.strictEqual(result?.success, true);
    assert.strictEqual(result?.method, 'ChromiumCDPInputInsertText');
    assert.strictEqual(state.inputInsertCalls, 1);
    assert(Array.isArray(result?.cdpAttachAttempts), 'attach diagnostics should be returned');
    assert.strictEqual(result.cdpAttachAttempts.length, 2);
    assert.strictEqual(result.cdpAttachAttempts[0]?.success, false);
    assert.strictEqual(result.cdpAttachAttempts[1]?.success, true);
    assert(/timed out/i.test(String(result.cdpAttachAttempts[0]?.error || '')));
  });

  await test('setTradingViewPineEditorContentWithCDP uses Monaco chunked input when a one-shot insert truncates a large script', async () => {
    const starterScript = [
      '//@version=6',
      'indicator("My script")',
      'plot(close)'
    ].join('\n');
    const expectedScript = [
      '//@version=6',
      'indicator("ATR VWAP MACD RSI Confidence", overlay=false, max_labels_count=100)',
      '',
      'atrLen = input.int(14, "ATR Length", minval=1)',
      'rsiLen = input.int(14, "RSI Length", minval=1)',
      'macdFast = input.int(12, "MACD Fast", minval=1)',
      'macdSlow = input.int(26, "MACD Slow", minval=1)',
      'macdSignal = input.int(9, "MACD Signal", minval=1)',
      'showSignals = input.bool(true, "Show Confidence Signals")',
      '',
      'sessionVwap = ta.vwap(hlc3)',
      'atr = ta.atr(atrLen)',
      'rsiValue = ta.rsi(close, rsiLen)',
      '[macdLine, signalLine, histLine] = ta.macd(close, macdFast, macdSlow, macdSignal)',
      'plot(close)'
    ].join('\n');
    let selectionAll = false;
    const { deps, state } = buildTradingViewPineEditorCdpMock({
      initialText: starterScript,
      onFocus: () => {
        selectionAll = true;
        return null;
      },
      onInputInsertText: ({ text, state: currentState }) => {
        if (text.length > 400) {
          selectionAll = false;
          return {
            editorText: String(currentState.editorText || '').slice(-200),
            renderedText: String(currentState.renderedText || '').slice(-200)
          };
        }

        const nextValue = selectionAll
          ? text
          : `${String(currentState.editorText || '')}${text}`;
        selectionAll = false;
        return {
          editorText: nextValue,
          renderedText: nextValue
        };
      },
      onForceSet: ({ state: currentState }) => ({
        editorText: String(currentState.editorText || ''),
        renderedText: String(currentState.renderedText || '')
      })
    });

    const result = await systemAutomation.setTradingViewPineEditorContentWithCDP({
      windowInfo: buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed'
      }),
      resolveWindowState: false,
      text: expectedScript,
      pinePreparedScriptName: 'ATR VWAP MACD RSI Confidence',
      cdpDependencies: deps
    });

    assert.strictEqual(result?.success, true);
    assert.strictEqual(result?.method, 'ChromiumCDPInputInsertTextChunks');
    assert.strictEqual(state.inputInsertCalls > 1, true, 'chunked strategy should issue multiple Input.insertText calls');
    const chunkAttempt = Array.isArray(result?.strategyAttempts)
      ? result.strategyAttempts.find((attempt) => attempt?.strategy === 'monaco-input-chunks')
      : null;
    assert(chunkAttempt, 'chunked Monaco input diagnostics should be recorded');
    assert.strictEqual(chunkAttempt?.success, true);
    assert.strictEqual(result?.proof?.exactMatch, true);
    assert.strictEqual(String(state.editorText || '').replace(/\r/g, ''), expectedScript);
  });

  await test('executeAction prefers the Pine authoring CDP route before keyboard paste fallback', async () => {
    const starterScript = [
      '//@version=6',
      'indicator("My script")',
      'plot(close)'
    ].join('\n');
    const expectedScript = [
      '//@version=6',
      'indicator("Liku Live Save Probe", overlay=false)',
      'plot(close, title="Close")'
    ].join('\n');
    const pressCalls = [];
    const { deps } = buildTradingViewPineEditorCdpMock({
      initialText: starterScript
    });

    await withAutomationHost({
      getForegroundWindowInfo: async () => buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed'
      })
    }, async () => {
      const result = await systemAutomation.executeAction({
        type: 'key',
        key: 'ctrl+v',
        inputSurfaceContract: {
          appName: 'TradingView',
          route: 'pine-editor-authoring',
          surface: 'pine-editor',
          requiresPineEditorSurface: true,
          requiresCommandSurfaceClosed: true
        },
        pinePreparedScriptText: expectedScript,
        pinePreparedScriptName: 'Liku Live Save Probe',
        cdpDependencies: deps
      }, {
        pressKey: async (key) => {
          pressCalls.push(String(key || '').trim().toLowerCase());
        }
      });

      assert.strictEqual(result?.success, true);
      assert.deepStrictEqual(pressCalls, []);
      assert.strictEqual(result?.method, 'ChromiumCDPInputInsertText');
      assert.strictEqual(result?.pineAuthoringCdpWrite?.success, true);
      assert.strictEqual(result?.pineAuthoringPasteProof?.proof?.exactMatch, true);
      assert.strictEqual(result?.pineAuthoringWriteTelemetry?.primarySucceeded, true);
      assert.strictEqual(result?.pineAuthoringWriteTelemetry?.fallbackUsed, false);
      assert.strictEqual(result?.pineAuthoringWriteTelemetry?.selectedMethod, 'ChromiumCDPInputInsertText');
      assert.strictEqual(result?.pineAuthoringWriteTelemetry?.primaryStrategy, 'input-insert-text');
      assert.strictEqual(result?.pineAuthoringWriteTelemetry?.primaryAttemptSummary, 'input-insert-text:ok');
      assert(Array.isArray(result?.pineAuthoringWriteTelemetry?.primaryAttempts));
      assert(result.pineAuthoringWriteTelemetry.primaryAttempts.some((attempt) => attempt?.strategy === 'monaco-editor-model'));
      assert(/ChromiumCDPInputInsertText/.test(String(result?.message || '')));
    });
  });

  await test('executeAction TYPE prefers the Pine save-name CDP route before generic typing fallback', async () => {
    const typedTexts = [];
    const { deps, state } = buildTradingViewPineEditorCdpMock({
      initialText: [
        '//@version=6',
        'indicator("Liku Live Save Probe", overlay=false)',
        'plot(close, title="Close")'
      ].join('\n'),
      initialDialogText: [
        'Save script',
        'New script name',
        'Cancel',
        'Save'
      ].join('\n'),
      initialDialogInputValues: []
    });

    await withAutomationHost({
      getForegroundWindowInfo: async () => buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed'
      })
    }, async () => {
      const result = await systemAutomation.executeAction({
        type: 'type',
        text: 'Liku Live Save Probe',
        inputSurfaceContract: {
          appName: 'TradingView',
          route: 'pine-save-name',
          surface: 'pine-save-dialog',
          requiresSaveDialogSurface: true
        },
        cdpDependencies: deps
      }, {
        typeText: async (text) => {
          typedTexts.push(String(text || ''));
        }
      });

      assert.strictEqual(result?.success, true);
      assert.deepStrictEqual(typedTexts, []);
      assert.strictEqual(result?.method, 'ChromiumCDPDialogSetValue');
      assert.strictEqual(result?.pineSaveNameSemanticWrite?.success, true);
      assert.deepStrictEqual(state.dialogInputValues, ['Liku Live Save Probe']);
      assert(/ChromiumCDPDialogSetValue/.test(String(result?.message || '')));
    });
  });

  await test('executeAction GET_TEXT classifies the first-save Pine modal from CDP dialog fallback', async () => {
    const originalGetElementText = uiAutomation.getElementText;
    const originalFindElement = uiAutomation.findElement;
    const expectedScript = [
      '//@version=6',
      'indicator("Liku Live Save Probe", overlay=false)',
      'plot(close, title="Close")'
    ].join('\n');
    const { deps } = buildTradingViewPineEditorCdpMock({
      initialText: expectedScript,
      initialDialogText: [
        'Save script',
        'New script name',
        'Liku Live Save Probe 1',
        'Cancel',
        'Save'
      ].join('\n')
    });

    uiAutomation.getElementText = async () => ({
      success: false,
      error: 'Element not found'
    });
    uiAutomation.findElement = async () => ({
      success: false,
      error: 'Element not found'
    });

    try {
      await withAutomationHost({
        getForegroundWindowInfo: async () => buildWindowInfo({
          hwnd: 460832,
          title: 'MN / Unnamed'
        }),
        getText: async () => {
          throw new Error('TextPattern failed');
        }
      }, async () => {
        const result = await systemAutomation.executeAction({
          type: 'get_text',
          text: 'Pine Editor',
          pineEvidenceMode: 'save-status',
          pineExpectedScriptName: 'Liku Live Save Probe',
          criteria: {
            text: 'Pine Editor'
          },
          windowHandle: 460832,
          cdpDependencies: deps
        });

        assert.strictEqual(result?.success, true);
        assert.strictEqual(result?.pineStructuredSummary?.evidenceMode, 'save-status');
        assert.strictEqual(result?.pineStructuredSummary?.lifecycleState, 'save-required-before-apply');
        assert(/ChromiumCDPRead \(pine-editor-fallback\)/i.test(String(result?.method || '')));
        assert(/Save script/i.test(String(result?.text || '')));
        assert(/Liku Live Save Probe 1/i.test(String(result?.text || '')));
      });
    } finally {
      uiAutomation.getElementText = originalGetElementText;
      uiAutomation.findElement = originalFindElement;
    }
  });

  await test('executeAction GET_TEXT still classifies the first-save Pine modal when CDP exposes dialog text but not the editor textarea', async () => {
    const originalGetElementText = uiAutomation.getElementText;
    const originalFindElement = uiAutomation.findElement;
    const expectedScript = [
      '//@version=6',
      'indicator("Liku Live Save Probe", overlay=false)',
      'plot(close, title="Close")'
    ].join('\n');
    const { deps } = buildTradingViewPineEditorCdpMock({
      initialText: expectedScript,
      initialDialogText: [
        'Save script',
        'New script name',
        'Cancel',
        'Save'
      ].join('\n'),
      onRead: () => ({
        payloadOverrides: {
          found: false,
          textarea: null,
          rendered: null,
          activeElementTagName: 'DIV'
        }
      })
    });

    uiAutomation.getElementText = async () => ({
      success: false,
      error: 'Element not found'
    });
    uiAutomation.findElement = async () => ({
      success: false,
      error: 'Element not found'
    });

    try {
      await withAutomationHost({
        getForegroundWindowInfo: async () => buildWindowInfo({
          hwnd: 460832,
          title: 'MN / Unnamed'
        }),
        getText: async () => {
          throw new Error('TextPattern failed');
        }
      }, async () => {
        const result = await systemAutomation.executeAction({
          type: 'get_text',
          text: 'Pine Editor',
          pineEvidenceMode: 'save-status',
          pineExpectedScriptName: 'Liku Live Save Probe',
          criteria: {
            text: 'Pine Editor'
          },
          windowHandle: 460832,
          cdpDependencies: deps
        });

        assert.strictEqual(result?.success, true);
        assert.strictEqual(result?.pineStructuredSummary?.evidenceMode, 'save-status');
        assert.strictEqual(result?.pineStructuredSummary?.lifecycleState, 'save-required-before-apply');
        assert(/ChromiumCDPRead \(pine-editor-fallback\)/i.test(String(result?.method || '')));
        assert(/Save script/i.test(String(result?.text || '')));
        assert(/New script name/i.test(String(result?.text || '')));
      });
    } finally {
      uiAutomation.getElementText = originalGetElementText;
      uiAutomation.findElement = originalFindElement;
    }
  });

  await test('executeAction GET_TEXT can use renderer proof for save-status when the TradingView foreground window is known but no explicit hwnd was attached', async () => {
    const originalGetElementText = uiAutomation.getElementText;
    const originalFindElement = uiAutomation.findElement;

    uiAutomation.getElementText = async () => ({
      success: false,
      error: 'Element not found'
    });
    uiAutomation.findElement = async () => ({
      success: false,
      error: 'Element not found'
    });

    try {
      await withAutomationHost({
        getForegroundWindowInfo: async () => buildWindowInfo({
          hwnd: 460832,
          title: 'MN / Unnamed'
        }),
        findElementsByWindow: async () => ({
          elements: [],
          count: 0,
          stats: { visited: 8, timedOut: false }
        })
      }, async () => {
        const result = await systemAutomation.executeAction({
          type: 'get_text',
          text: 'Pine Editor',
          pineEvidenceMode: 'save-status',
          pineExpectedScriptName: 'Liku Live Save Probe',
          cdpDependencies: buildTradingViewCdpDependencies({
            port: 9560,
            domPayload: {
              matched: true,
              anchorText: 'Liku Live Save Probe',
              signals: [
                {
                  text: 'Liku Live Save Probe',
                  observedText: 'Liku Live Save Probe',
                  source: 'dom-node',
                  category: 'save-title'
                },
                {
                  text: 'All changes saved',
                  observedText: 'All changes saved',
                  source: 'dom-node',
                  ariaLabel: 'All changes saved',
                  category: 'save-confirmed'
                },
                {
                  text: 'Publish script',
                  observedText: 'Publish script',
                  source: 'dom-node',
                  category: 'surface'
                }
              ],
              scannedNodes: 24,
              usedBodyInnerText: false
            }
          })
        });

        assert.strictEqual(result?.success, true);
        assert(/ChromiumCDP/i.test(String(result?.method || '')));
        assert.strictEqual(result?.pineStructuredSummary?.lifecycleState, 'saved-state-verified');
        assert.strictEqual(result?.pineStructuredSummary?.expectedScriptNameProofVisible, true);
      });
    } finally {
      uiAutomation.getElementText = originalGetElementText;
      uiAutomation.findElement = originalFindElement;
    }
  });

  await test('executeAction GET_TEXT save-status accepts the Pine header title button as saved-title proof', async () => {
    const originalGetElementText = uiAutomation.getElementText;
    const originalFindElement = uiAutomation.findElement;
    let callFunctionOnCount = 0;

    uiAutomation.getElementText = async () => ({
      success: false,
      error: 'Element not found'
    });
    uiAutomation.findElement = async () => ({
      success: false,
      error: 'Element not found'
    });

    try {
      await withAutomationHost({
        getForegroundWindowInfo: async () => buildWindowInfo({
          hwnd: 460832,
          title: 'MN / Unnamed'
        }),
        findElementsByWindow: async () => ({
          elements: [],
          count: 0,
          stats: { visited: 8, timedOut: false }
        })
      }, async () => {
        const result = await systemAutomation.executeAction({
          type: 'get_text',
          text: 'Pine Editor',
          pineEvidenceMode: 'save-status',
          pineExpectedScriptName: 'Liku Live Save Probe',
          windowHandle: 460832,
          cdpDependencies: buildTradingViewCdpDependencies({
            port: 9569,
            domPayload: {
              matched: true,
              anchorText: 'All changes saved',
              signals: [
                {
                  text: 'All changes saved',
                  observedText: 'All changes saved',
                  source: 'dom-node',
                  ariaLabel: 'All changes saved',
                  category: 'save-confirmed'
                },
                {
                  text: 'Add to chart',
                  observedText: 'Add to chart',
                  source: 'dom-node',
                  category: 'surface'
                },
                {
                  text: 'Publish script',
                  observedText: 'Publish script',
                  source: 'dom-node',
                  category: 'surface'
                }
              ],
              scannedNodes: 24,
              usedBodyInnerText: false
            },
            axNodes: [
              {
                nodeId: '53001',
                ignored: false,
                role: { value: 'button' },
                name: { value: 'Liku Live Save Probe' },
                backendDOMNodeId: 53001
              },
              {
                nodeId: '53002',
                ignored: false,
                role: { value: 'button' },
                name: { value: 'Add to chart' },
                backendDOMNodeId: 53002
              },
              {
                nodeId: '53003',
                ignored: false,
                role: { value: 'button' },
                name: { value: 'Publish script' },
                backendDOMNodeId: 53003
              }
            ],
            onCallFunctionOn: () => {
              callFunctionOnCount += 1;
              if (callFunctionOnCount === 1) {
                return {
                  callFunctionOnValue: {
                    text: 'Add to chart',
                    title: 'Add to chart',
                    tagName: 'BUTTON',
                    rect: { x: 348, y: 62, width: 145, height: 34 }
                  }
                };
              }
              return {
                callFunctionOnValue: {
                  text: 'Liku Live Save Probe',
                  tagName: 'DIV',
                  role: 'button',
                  rect: { x: 75, y: 62, width: 220, height: 34 }
                }
              };
            }
          })
        });

        assert.strictEqual(result?.success, true);
        assert.strictEqual(result?.pineStructuredSummary?.expectedScriptNameProofVisible, true);
        assert.strictEqual(result?.pineStructuredSummary?.lifecycleState, 'saved-state-verified');
      });
    } finally {
      uiAutomation.getElementText = originalGetElementText;
      uiAutomation.findElement = originalFindElement;
    }
  });

  await test('executeAction GET_TEXT treats generic saved Pine chrome as starter-safe only when the verified Create new inspection explicitly allows it', async () => {
    const originalGetElementText = uiAutomation.getElementText;
    const originalFindElement = uiAutomation.findElement;

    uiAutomation.getElementText = async () => ({
      success: false,
      error: 'Element not found'
    });
    uiAutomation.findElement = async () => ({
      success: false,
      error: 'Element not found'
    });

    try {
      await withAutomationHost({
        getForegroundWindowInfo: async () => buildWindowInfo({
          hwnd: 460832,
          title: 'MN / Unnamed'
        }),
        findElementsByWindow: async () => ({
          elements: [],
          count: 0,
          stats: { visited: 8, timedOut: false }
        })
      }, async () => {
        const result = await systemAutomation.executeAction({
          type: 'get_text',
          text: 'Pine Editor',
          pineEvidenceMode: 'safe-authoring-inspect',
          acceptGenericSavedSurfaceAsStarter: true,
          cdpDependencies: buildTradingViewCdpDependencies({
            port: 9568,
            domPayload: {
              matched: true,
              anchorText: 'All changes saved',
              signals: [
                {
                  text: 'All changes saved',
                  observedText: 'All changes saved',
                  source: 'dom-node',
                  ariaLabel: 'All changes saved',
                  category: 'save-confirmed'
                },
                {
                  text: 'Add to chart',
                  observedText: 'Add to chart',
                  source: 'dom-node',
                  category: 'surface'
                },
                {
                  text: 'Publish script',
                  observedText: 'Publish script',
                  source: 'dom-node',
                  category: 'surface'
                }
              ],
              scannedNodes: 24,
              usedBodyInnerText: false
            }
          })
        });

        assert.strictEqual(result?.success, true);
        assert(/ChromiumCDP/i.test(String(result?.method || '')));
        assert.strictEqual(result?.pineStructuredSummary?.evidenceMode, 'safe-authoring-inspect');
        assert.strictEqual(result?.pineStructuredSummary?.editorVisibleState, 'empty-or-starter');
        assert(result?.pineStructuredSummary?.visibleSignals?.includes('fresh-create-generic-surface'));
      });
    } finally {
      uiAutomation.getElementText = originalGetElementText;
      uiAutomation.findElement = originalFindElement;
    }
  });

  await test('executeAction GET_TEXT rejects generic saved Pine chrome as starter-safe when the header title button still exposes an existing script title', async () => {
    const originalGetElementText = uiAutomation.getElementText;
    const originalFindElement = uiAutomation.findElement;
    let callFunctionOnCount = 0;

    uiAutomation.getElementText = async () => ({
      success: false,
      error: 'Element not found'
    });
    uiAutomation.findElement = async () => ({
      success: false,
      error: 'Element not found'
    });

    try {
      await withAutomationHost({
        getForegroundWindowInfo: async () => buildWindowInfo({
          hwnd: 460832,
          title: 'MN / Unnamed'
        }),
        findElementsByWindow: async () => ({
          elements: [],
          count: 0,
          stats: { visited: 8, timedOut: false }
        })
      }, async () => {
        const result = await systemAutomation.executeAction({
          type: 'get_text',
          text: 'Pine Editor',
          pineEvidenceMode: 'safe-authoring-inspect',
          acceptGenericSavedSurfaceAsStarter: true,
          windowHandle: 460832,
          cdpDependencies: buildTradingViewCdpDependencies({
            port: 9570,
            domPayload: {
              matched: true,
              anchorText: 'All changes saved',
              signals: [
                {
                  text: 'All changes saved',
                  observedText: 'All changes saved',
                  source: 'dom-node',
                  ariaLabel: 'All changes saved',
                  category: 'save-confirmed'
                },
                {
                  text: 'Add to chart',
                  observedText: 'Add to chart',
                  source: 'dom-node',
                  category: 'surface'
                },
                {
                  text: 'Publish script',
                  observedText: 'Publish script',
                  source: 'dom-node',
                  category: 'surface'
                }
              ],
              scannedNodes: 24,
              usedBodyInnerText: false
            },
            axNodes: [
              {
                nodeId: '54001',
                ignored: false,
                role: { value: 'button' },
                name: { value: 'Add to chart' },
                backendDOMNodeId: 54001
              },
              {
                nodeId: '54002',
                ignored: false,
                role: { value: 'button' },
                name: { value: 'Liku Live Save Probe' },
                backendDOMNodeId: 54002
              }
            ],
            onCallFunctionOn: () => {
              callFunctionOnCount += 1;
              if (callFunctionOnCount === 1) {
                return {
                  callFunctionOnValue: {
                    text: 'Add to chart',
                    title: 'Add to chart',
                    tagName: 'BUTTON',
                    rect: { x: 348, y: 62, width: 145, height: 34 }
                  }
                };
              }
              return {
                callFunctionOnValue: {
                  text: 'Liku Live Save Probe',
                  tagName: 'DIV',
                  role: 'button',
                  rect: { x: 75, y: 62, width: 220, height: 34 }
                }
              };
            }
          })
        });

        assert.strictEqual(result?.success, true);
        assert(/ChromiumCDP/i.test(String(result?.method || '')));
        assert.strictEqual(result?.pineStructuredSummary?.evidenceMode, 'safe-authoring-inspect');
        assert.strictEqual(result?.pineStructuredSummary?.editorVisibleState, 'existing-script-visible');
        assert.strictEqual(
          result?.pineStructuredSummary?.visibleSignals?.includes('fresh-create-generic-surface'),
          false,
          'a visible stale script title must block starter-safe generic surface acceptance'
        );
      });
    } finally {
      uiAutomation.getElementText = originalGetElementText;
      uiAutomation.findElement = originalFindElement;
    }
  });

  await test('executeAction GET_TEXT escalates ambiguous Pine chrome to renderer editor readback before classifying safe-authoring state', async () => {
    const originalGetElementText = uiAutomation.getElementText;
    const originalFindElement = uiAutomation.findElement;
    const ambiguousProbe = {
      active: true,
      matchedBy: 'chromium-cdp-dom',
      anchorText: 'Add to chart',
      visibleAnchors: ['Add to chart', 'Publish script'],
      visibleAnchorEntries: [
        {
          text: 'Add to chart',
          observedText: 'Add to chart',
          category: 'surface',
          source: 'dom-node'
        },
        {
          text: 'Publish script',
          observedText: 'Publish script',
          category: 'surface',
          source: 'dom-node'
        }
      ],
      rendererProof: {
        available: true,
        active: true,
        matchedBy: 'chromium-cdp-dom',
        anchorText: 'Add to chart',
        signals: [
          {
            text: 'Add to chart',
            observedText: 'Add to chart',
            category: 'surface',
            source: 'dom-node'
          },
          {
            text: 'Publish script',
            observedText: 'Publish script',
            category: 'surface',
            source: 'dom-node'
          }
        ]
      }
    };

    uiAutomation.getElementText = async () => ({
      success: false,
      error: 'Element not found'
    });
    uiAutomation.findElement = async () => ({
      success: false,
      error: 'Element not found'
    });

    try {
      const pineEditorCdp = buildTradingViewPineEditorCdpMock({
        port: 9571,
        initialText: '//@version=6\nindicator("Liku Existing Script", overlay=false)\nplot(close, title="Close")',
        initialRenderedText: '//@version=6\nindicator("Liku Existing Script", overlay=false)\nplot(close, title="Close")'
      });

      await withAutomationHost({
        getForegroundWindowInfo: async () => buildWindowInfo({
          hwnd: 460832,
          title: 'MN / Unnamed'
        }),
        findElementsByWindow: async () => ({
          elements: [],
          count: 0,
          stats: { visited: 8, timedOut: false }
        })
      }, async () => {
        const result = await systemAutomation.executeAction({
          type: 'get_text',
          text: 'Pine Editor',
          pineEvidenceMode: 'safe-authoring-inspect',
          acceptGenericSavedSurfaceAsStarter: true,
          pineEditorSurfaceProbe: ambiguousProbe,
          windowHandle: 460832,
          cdpDependencies: pineEditorCdp.deps
        });

        assert.strictEqual(result?.success, true);
        assert(/ChromiumCDP/i.test(String(result?.method || '')));
        assert(String(result?.text || '').includes('indicator("Liku Existing Script"'), 'renderer editor readback should surface the actual Pine buffer');
        assert.strictEqual(result?.pineStructuredSummary?.editorVisibleState, 'existing-script-visible');
      });
    } finally {
      uiAutomation.getElementText = originalGetElementText;
      uiAutomation.findElement = originalFindElement;
    }
  });

  await test('executeAction CLICK_ELEMENT reuses runtime-level CDP context for TradingView Pine opener bypass proof', async () => {
    await withAutomationHost({
      getForegroundWindowInfo: async () => buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed'
      }),
      getWindowInfoByHandle: async (handle) => buildWindowInfo({
        hwnd: Number(handle || 460832) || 460832,
        title: 'MN / Unnamed'
      }),
      findElementsByWindow: async () => ({
        elements: [],
        count: 0,
        stats: { visited: 8, timedOut: false }
      })
    }, async () => {
      const result = await systemAutomation.executeAction({
        type: 'click_element',
        text: 'Pine',
        controlType: 'Button',
        exact: true,
        foregroundOnly: true,
        allowCoordinateFallback: false,
        windowHandle: 460832,
        tradingViewShortcut: {
          id: 'open-pine-editor',
          route: 'semantic-icon'
        },
        searchSurfaceContract: {
          id: 'open-pine-editor',
          route: 'semantic-icon'
        },
        verify: {
          kind: 'editor-active',
          target: 'pine-editor'
        }
      }, {
        cdpDependencies: buildTradingViewCdpDependencies({
          port: 9572,
          domPayload: {
            matched: true,
            anchorText: 'Add to chart',
            signals: [
              {
                text: 'Add to chart',
                observedText: 'Add to chart',
                source: 'dom-node',
                category: 'surface'
              },
              {
                text: 'Publish script',
                observedText: 'Publish script',
                source: 'dom-node',
                category: 'surface'
              }
            ],
            scannedNodes: 24,
            usedBodyInnerText: false
          }
        })
      });

      assert.strictEqual(result?.success, true);
      assert.strictEqual(result?.skipped, true);
      assert.strictEqual(result?.skippedReason, 'pine-editor-already-active');
      assert.strictEqual(result?.pineEditorSurfaceProbe?.active, true);
      assert.strictEqual(result?.pineEditorSurfaceProbe?.matchedBy, 'chromium-cdp-dom');
      assert(/already active/i.test(String(result?.message || '')));
    });
  });

  await test('probeTradingViewPineEditorSurface promotes a bounded CDP DOM proof before running slower UIA scans', async () => {
    const probe = await systemAutomation.probeTradingViewPineEditorSurface({
      windowHandle: 460832,
      windowInfo: buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed',
        bounds: { x: 911, y: 8, width: 1016, height: 956 }
      }),
      foreground: buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed',
        bounds: { x: 911, y: 8, width: 1016, height: 956 }
      }),
      resolveWindowState: false,
      timeout: 1200,
      cdpDependencies: buildTradingViewCdpDependencies()
    });

    assert.strictEqual(probe?.active, true);
    assert.strictEqual(probe?.matchedBy, 'chromium-cdp-dom');
    assert.strictEqual(probe?.anchorText, 'Add to chart');
    assert.deepStrictEqual(probe?.visibleAnchors, ['Add to chart']);
    assert.strictEqual(probe?.rendererProof?.available, true);
    assert.strictEqual(probe?.rendererProof?.matchedBy, 'chromium-cdp-dom');
    assert.deepStrictEqual(probe?.scanAttempts, []);
  });

  await test('probeTradingViewPineEditorSurface rejects save-confirmed-only CDP proof so chart chrome does not impersonate Pine', async () => {
    await withAutomationHost({
      getWindowInfoByHandle: async (hwnd) => buildWindowInfo({
        hwnd,
        title: 'INTC / Unnamed',
        bounds: { x: 911, y: 8, width: 1016, height: 956 }
      }),
      getForegroundWindowInfo: async () => buildWindowInfo({
        hwnd: 460832,
        title: 'INTC / Unnamed',
        bounds: { x: 911, y: 8, width: 1016, height: 956 }
      }),
      findElementsByWindow: async () => ({
        elements: [],
        count: 0,
        stats: { visited: 12, timedOut: false }
      })
    }, async () => {
      const probe = await systemAutomation.probeTradingViewPineEditorSurface({
        windowHandle: 460832,
        timeout: 1200,
        cdpDependencies: buildTradingViewCdpDependencies({
          domPayload: {
            matched: true,
            anchorText: 'All changes saved',
            signals: [{
              text: 'All changes saved',
              observedText: 'All changes saved',
              source: 'dom-node',
              category: 'save-confirmed'
            }],
            scannedNodes: 36,
            usedBodyInnerText: false
          }
        })
      });

      assert.strictEqual(probe?.active, false, 'generic chart save chrome must not prove Pine by itself');
      assert.strictEqual(probe?.reason, 'no-visible-pine-anchor');
      assert.strictEqual(probe?.rendererProof?.available, true);
      assert.strictEqual(probe?.rendererProof?.active, false);
      assert.strictEqual(probe?.rendererProof?.reason, 'save-confirmed-only-insufficient');
      assert.deepStrictEqual(
        probe?.rendererProof?.signals?.map((entry) => entry?.text),
        ['All changes saved']
      );
    });
  });

  await test('probeTradingViewPineEditorSurface keeps scanning for the expected saved title when CDP only proves a generic Pine surface anchor', async () => {
    const calls = [];

    await withAutomationHost({
      getWindowInfoByHandle: async (hwnd) => buildWindowInfo({
        hwnd,
        title: 'MN / Unnamed',
        bounds: { x: 911, y: 8, width: 1016, height: 956 }
      }),
      getForegroundWindowInfo: async () => buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed',
        bounds: { x: 911, y: 8, width: 1016, height: 956 }
      }),
      findElementsByWindow: async (hwnd, options = {}) => {
        calls.push({ hwnd, options });
        if (
          String(options?.textMode || '') === 'regex'
          && String(options?.view || '') === 'control'
          && Number(options?.bounds?.y || 0) <= 430
        ) {
          return {
            elements: [
              {
                Name: 'Liku Live Save Probe',
                ControlType: 'ControlType.Text',
                WindowHandle: hwnd,
                Bounds: { X: 1190, Y: 434, Width: 190, Height: 26, CenterX: 1285, CenterY: 447 }
              },
              {
                Name: 'Publish script',
                ControlType: 'ControlType.Button',
                WindowHandle: hwnd,
                Bounds: { X: 1450, Y: 434, Width: 120, Height: 30, CenterX: 1510, CenterY: 449 }
              }
            ],
            count: 2,
            stats: { visited: 16, timedOut: false }
          };
        }
        return {
          elements: [],
          count: 0,
          stats: { visited: 12, timedOut: false }
        };
      }
    }, async () => {
      const probe = await systemAutomation.probeTradingViewPineEditorSurface({
        windowHandle: 460832,
        timeout: 1200,
        pineExpectedScriptName: 'Liku Live Save Probe',
        cdpDependencies: buildTradingViewCdpDependencies({
          domPayload: {
            matched: true,
            anchorText: 'Publish script',
            signals: [{
              text: 'Publish script',
              observedText: 'Publish script',
              source: 'dom-node'
            }],
            scannedNodes: 32,
            usedBodyInnerText: false
          }
        })
      });

      assert.strictEqual(probe?.active, true);
      assert.strictEqual(probe?.matchedBy, 'uia-host-pine-surface-header-scan');
      assert.strictEqual(probe?.anchorText, 'Liku Live Save Probe');
      assert.strictEqual(probe?.rendererProof?.available, true);
      assert.strictEqual(probe?.rendererProof?.anchorText, 'Publish script');
      assert.strictEqual(Array.isArray(probe?.visibleAnchorEntries), true);
      assert.strictEqual(
        probe.visibleAnchorEntries.some((entry) => entry?.category === 'save-title' && entry?.text === 'Liku Live Save Probe'),
        true
      );
      assert.strictEqual(calls.length >= 1, true);
      assert(/Liku Live Save Probe/i.test(String(calls[0]?.options?.text || '')), 'host regex scan should include the expected saved title');
      assert(Number(calls[0].options?.bounds?.y || 0) <= 430, 'save-title recovery should still start from the bounded header band');
    });
  });

  await test('probeTradingViewPineEditorSurface keeps scanning save-status bounds when the first expected-title hit is only a rename surface', async () => {
    const calls = [];

    await withAutomationHost({
      getWindowInfoByHandle: async (hwnd) => buildWindowInfo({
        hwnd,
        title: 'MN / Unnamed',
        bounds: { x: 911, y: 8, width: 1016, height: 956 }
      }),
      getForegroundWindowInfo: async () => buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed',
        bounds: { x: 911, y: 8, width: 1016, height: 956 }
      }),
      findElementsByWindow: async (hwnd, options = {}) => {
        calls.push({ hwnd, options });
        if (String(options?.textMode || '') !== 'regex') {
          return {
            elements: [],
            count: 0,
            stats: { visited: 10, timedOut: false }
          };
        }
        if (Number(options?.bounds?.height || 0) <= 200) {
          return {
            elements: [{
              Name: '',
              Value: 'Liku Live Save Probe 1',
              ControlType: 'ControlType.Edit',
              WindowHandle: hwnd,
              Bounds: { X: 1192, Y: 486, Width: 240, Height: 28, CenterX: 1312, CenterY: 500 }
            }],
            count: 1,
            stats: { visited: 14, timedOut: false }
          };
        }
        return {
          elements: [
            {
              Name: 'Save script',
              ControlType: 'ControlType.Text',
              WindowHandle: hwnd,
              Bounds: { X: 1180, Y: 428, Width: 120, Height: 24, CenterX: 1240, CenterY: 440 }
            },
            {
              Name: 'New script name',
              ControlType: 'ControlType.Text',
              WindowHandle: hwnd,
              Bounds: { X: 1180, Y: 462, Width: 160, Height: 22, CenterX: 1260, CenterY: 473 }
            }
          ],
          count: 2,
          stats: { visited: 18, timedOut: false }
        };
      }
    }, async () => {
      const probe = await systemAutomation.probeTradingViewPineEditorSurface({
        windowHandle: 460832,
        timeout: 1200,
        pineEvidenceMode: 'save-status',
        pineExpectedScriptName: 'Liku Live Save Probe',
        cdpDependencies: buildUnavailableTradingViewCdpDependencies()
      });

      assert.strictEqual(probe?.active, true);
      assert.strictEqual(probe?.matchedBy, 'uia-host-pine-surface-header-scan');
      assert.strictEqual(
        probe?.visibleAnchorEntries?.some((entry) => entry?.category === 'rename-surface' && /Liku Live Save Probe 1/i.test(String(entry?.text || entry?.observedText || ''))),
        true,
        'prefilled save-name inputs should be surfaced as rename-surface evidence instead of saved-title proof'
      );
      assert.strictEqual(
        probe?.visibleAnchorEntries?.some((entry) => entry?.category === 'save-required' && /Save script/i.test(String(entry?.text || ''))),
        true,
        'save-status scans should continue gathering modal context after a title-only hit'
      );
      assert.strictEqual(
        calls.some((call) => Number(call?.options?.bounds?.height || 0) > 200),
        true,
        'save-status scan should continue beyond the narrow header band after a rename-surface hit'
      );
    });
  });

  await test('probeTradingViewPineEditorSurface scans the panel header band with a bounded host regex search', async () => {
    const calls = [];

    await withAutomationHost({
      getWindowInfoByHandle: async (hwnd) => buildWindowInfo({
        hwnd,
        title: 'MN / Unnamed',
        bounds: { x: 911, y: 8, width: 1016, height: 956 }
      }),
      getForegroundWindowInfo: async () => buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed',
        bounds: { x: 911, y: 8, width: 1016, height: 956 }
      }),
      findElementsByWindow: async (hwnd, options = {}) => {
        calls.push({ hwnd, options });
        if (
          String(options?.textMode || '') === 'regex'
          && String(options?.view || '') === 'control'
          && Number(options?.bounds?.y || 0) <= 430
        ) {
          return {
            elements: [{
              Name: 'Add to chart',
              ControlType: 'ControlType.Button',
              WindowHandle: hwnd,
              Patterns: ['Invoke'],
              Bounds: { X: 1540, Y: 438, Width: 120, Height: 32, CenterX: 1600, CenterY: 454 }
            }],
            count: 1,
            stats: { visited: 14, timedOut: false }
          };
        }
        return {
          elements: [],
          count: 0,
          stats: { visited: 12, timedOut: false }
        };
      }
    }, async () => {
      const probe = await systemAutomation.probeTradingViewPineEditorSurface({
        windowHandle: 460832,
        timeout: 1200,
        cdpDependencies: buildUnavailableTradingViewCdpDependencies()
      });

      assert.strictEqual(probe?.active, true);
      assert.strictEqual(probe?.anchorText, 'Add to chart');
      assert.strictEqual(probe?.matchedBy, 'uia-host-pine-surface-header-scan');
      assert.strictEqual(Array.isArray(probe?.visibleAnchors), true);
      assert.strictEqual(probe.visibleAnchors.includes('Add to chart'), true);
      assert.strictEqual(calls.length >= 1, true);
      assert.strictEqual(calls[0].options.textMode, 'regex');
      assert(/Add to chart/i.test(String(calls[0].options.text || '')), 'host regex scan should include Pine anchor text');
      assert(Number(calls[0].options?.bounds?.y || 0) <= 430, 'header-aware Pine scan should start above the old lower-panel cutoff');
    });
  });

  await test('probeTradingViewPineEditorSurface can promote the bounded accessibility probe when the host tree scan stops at the Chromium document root', async () => {
    const accessibilityCalls = [];

    await withAutomationHost({
      getWindowInfoByHandle: async (hwnd) => buildWindowInfo({
        hwnd,
        title: 'MN / Unnamed',
        bounds: { x: 911, y: 8, width: 1016, height: 956 }
      }),
      getForegroundWindowInfo: async () => buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed',
        bounds: { x: 911, y: 8, width: 1016, height: 956 }
      }),
      findElementsByWindow: async (hwnd) => ({
        elements: [{
          Name: 'Live stock, index, futures, Forex and Bitcoin charts on TradingView',
          ControlType: 'ControlType.Document',
          ClassName: 'Chrome_RenderWidgetHostHWND',
          WindowHandle: hwnd,
          Bounds: { X: 911, Y: 46, Width: 1016, Height: 918, CenterX: 1419, CenterY: 505 }
        }],
        count: 1,
        stats: { visited: 12, timedOut: false }
      }),
      probeWindowAccessibility: async (hwnd, options = {}) => {
        accessibilityCalls.push({ hwnd, options });
        return {
          roots: [{
            Name: 'Live stock, index, futures, Forex and Bitcoin charts on TradingView',
            ControlType: 'ControlType.Document',
            ClassName: 'Chrome_RenderWidgetHostHWND',
            WindowHandle: hwnd,
            Bounds: { X: 911, Y: 46, Width: 1016, Height: 918, CenterX: 1419, CenterY: 505 }
          }],
          elements: [{
            Name: 'Add to chart',
            Description: 'Pine Editor toolbar',
            LegacyRole: 'push button',
            Source: 'msaa',
            ControlType: 'ControlType.Button',
            ClassName: 'Chrome_RenderWidgetHostHWND',
            WindowHandle: hwnd,
            NativeWindowHandle: 9911,
            Patterns: ['LegacyIAccessible'],
            IsClickable: true,
            IsFocusable: true,
            Bounds: { X: 1540, Y: 438, Width: 120, Height: 32, CenterX: 1600, CenterY: 454 }
          }],
          count: 1,
          stats: {
            rootCount: 1,
            rawVisited: 0,
            msaaVisited: 8,
            documentBarrierDetected: false,
            timedOut: false
          }
        };
      },
      elementFromPointInWindow: async () => {
        throw new Error('point probe should not run when the accessibility probe already proved Pine');
      }
    }, async () => {
      const probe = await systemAutomation.probeTradingViewPineEditorSurface({
        windowHandle: 460832,
        timeout: 1200,
        cdpDependencies: buildUnavailableTradingViewCdpDependencies()
      });

      assert.strictEqual(probe?.active, true);
      assert.strictEqual(probe?.anchorText, 'Add to chart');
      assert.strictEqual(probe?.matchedBy, 'uia-host-pine-surface-accessibility-probe');
      assert.strictEqual(Array.isArray(probe?.documentProbeAttempts), true);
      assert.strictEqual(probe.documentProbeAttempts.length > 0, true);
      assert.strictEqual(Array.isArray(probe?.documentProbeRoots), true);
      assert.strictEqual(
        probe.documentProbeRoots.some((entry) => entry?.ClassName === 'Chrome_RenderWidgetHostHWND'),
        true
      );
      assert.strictEqual(Array.isArray(probe?.documentProbeSignals), true);
      assert.strictEqual(
        probe.documentProbeSignals.some((signal) => signal?.text === 'Add to chart'),
        true
      );
      assert.strictEqual(accessibilityCalls.length > 0, true);
      assert.strictEqual(accessibilityCalls[0]?.hwnd, 460832);
      assert.strictEqual(accessibilityCalls[0]?.options?.rootClassName, 'Chrome_RenderWidgetHostHWND');
    });
  });

  await test('probeTradingViewPineEditorSurface can fall back to bounded window-scoped point sampling when the host tree scan misses', async () => {
    const pointCalls = [];

    await withAutomationHost({
      getWindowInfoByHandle: async (hwnd) => buildWindowInfo({
        hwnd,
        title: 'MN / Unnamed',
        bounds: { x: 911, y: 8, width: 1016, height: 956 }
      }),
      getForegroundWindowInfo: async () => buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed',
        bounds: { x: 911, y: 8, width: 1016, height: 956 }
      }),
      findElementsByWindow: async () => ({
        elements: [],
        count: 0,
        stats: { visited: 14, timedOut: true }
      }),
      elementFromPointInWindow: async (hwnd, x, y, options = {}) => {
        pointCalls.push({ hwnd, x, y, options });
        if (Number(y) >= 430 && Number(y) <= 490 && Number(x) >= 1536 && Number(x) <= 1755) {
          return {
            matchedBy: 'window-descendant-refine',
            directHitWithinWindow: false,
            stats: { visited: 36, candidateCount: 3, timedOut: false },
            element: {
              Name: 'Add to chart',
              ControlType: 'ControlType.Button',
              WindowHandle: 460832,
              Bounds: { X: 1540, Y: 438, Width: 120, Height: 32, CenterX: 1600, CenterY: 454 }
            }
          };
        }
        return {
          matchedBy: 'direct-hit',
          directHitWithinWindow: true,
          stats: { visited: 0, candidateCount: 0, timedOut: false },
          element: {
            Name: 'Chart',
            ControlType: 'ControlType.Pane',
            WindowHandle: 460832,
            Bounds: { X: x - 5, Y: y - 5, Width: 10, Height: 10, CenterX: x, CenterY: y }
          }
        };
      },
      elementFromPoint: async () => {
        throw new Error('global fallback should not be used when window-scoped probe is available');
      }
    }, async () => {
      const probe = await systemAutomation.probeTradingViewPineEditorSurface({
        windowHandle: 460832,
        timeout: 1200,
        cdpDependencies: buildUnavailableTradingViewCdpDependencies()
      });

      assert.strictEqual(probe?.active, true);
      assert.strictEqual(probe?.anchorText, 'Add to chart');
      assert.strictEqual(probe?.matchedBy, 'uia-host-pine-surface-point-sample');
      assert.strictEqual(pointCalls.length > 0, true);
      assert.strictEqual(pointCalls[0]?.hwnd, 460832);
      assert.strictEqual(pointCalls[0]?.options?.view, 'raw');
      assert.strictEqual(probe?.pointProbeUsedWindowScopedHost, true);
      assert.strictEqual(probe?.pointProbeUsedGlobalFallback, false);
      assert.strictEqual(Array.isArray(probe?.pointProbeAttempts), true);
      assert.strictEqual(
        probe.pointProbeAttempts.some((attempt) => attempt?.mode === 'window-scoped' && attempt?.matchedBy === 'window-descendant-refine'),
        true
      );
    });
  });

  await test('probeTradingViewPineEditorSurface can fall back to global point sampling when the window-scoped probe is unavailable', async () => {
    const pointCalls = [];

    await withAutomationHost({
      getWindowInfoByHandle: async (hwnd) => buildWindowInfo({
        hwnd,
        title: 'MN / Unnamed',
        bounds: { x: 911, y: 8, width: 1016, height: 956 }
      }),
      getForegroundWindowInfo: async () => buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed',
        bounds: { x: 911, y: 8, width: 1016, height: 956 }
      }),
      findElementsByWindow: async () => ({
        elements: [],
        count: 0,
        stats: { visited: 14, timedOut: true }
      }),
      elementFromPoint: async (x, y) => {
        pointCalls.push({ x, y });
        if (Number(y) >= 430 && Number(y) <= 490 && Number(x) >= 1536 && Number(x) <= 1755) {
          return {
            Name: 'Add to chart',
            ControlType: 'ControlType.Button',
            WindowHandle: 460832,
            Bounds: { X: 1540, Y: 438, Width: 120, Height: 32, CenterX: 1600, CenterY: 454 }
          };
        }
        return {
          Name: 'Chart',
          ControlType: 'ControlType.Pane',
          WindowHandle: 460832,
          Bounds: { X: x - 5, Y: y - 5, Width: 10, Height: 10, CenterX: x, CenterY: y }
        };
      }
    }, async () => {
      const probe = await systemAutomation.probeTradingViewPineEditorSurface({
        windowHandle: 460832,
        timeout: 1200,
        cdpDependencies: buildUnavailableTradingViewCdpDependencies()
      });

      assert.strictEqual(probe?.active, true);
      assert.strictEqual(probe?.anchorText, 'Add to chart');
      assert.strictEqual(probe?.matchedBy, 'uia-host-pine-surface-point-sample');
      assert.strictEqual(pointCalls.length > 0, true);
      assert.strictEqual(probe?.pointProbeUsedWindowScopedHost, false);
      assert.strictEqual(probe?.pointProbeUsedGlobalFallback, true);
      assert.strictEqual(
        probe.pointProbeAttempts.some((attempt) => attempt?.mode === 'global-fallback'),
        true
      );
    });
  });

  await test('probeTradingViewPineEditorSurface can promote a bounded diagnostic host scan when the fast lower-panel proof misses', async () => {
    const calls = [];

    await withAutomationHost({
      getWindowInfoByHandle: async (hwnd) => buildWindowInfo({
        hwnd,
        title: 'MN / Unnamed',
        bounds: { x: 911, y: 8, width: 1016, height: 956 }
      }),
      getForegroundWindowInfo: async () => buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed',
        bounds: { x: 911, y: 8, width: 1016, height: 956 }
      }),
      findElementsByWindow: async (hwnd, options = {}) => {
        calls.push({ hwnd, options });
        const queryText = String(options?.text || '');
        if (/Add to chart/i.test(queryText)) {
          return {
            elements: [],
            count: 0,
            stats: { visited: 14, timedOut: false }
          };
        }
        if (
          /pine/i.test(queryText)
          && /publish/i.test(queryText)
          && Number(options?.bounds?.y || 0) <= 60
        ) {
          return {
            elements: [{
              Name: 'Publish script',
              ControlType: 'ControlType.Button',
              WindowHandle: hwnd,
              Patterns: ['Invoke'],
              Bounds: { X: 1510, Y: 132, Width: 118, Height: 30, CenterX: 1569, CenterY: 147 }
            }],
            count: 1,
            stats: { visited: 32, timedOut: false }
          };
        }
        return {
          elements: [],
          count: 0,
          stats: { visited: 18, timedOut: false }
        };
      }
    }, async () => {
      const probe = await systemAutomation.probeTradingViewPineEditorSurface({
        windowHandle: 460832,
        timeout: 1200,
        cdpDependencies: buildUnavailableTradingViewCdpDependencies()
      });

      assert.strictEqual(probe?.active, true);
      assert.strictEqual(probe?.anchorText, 'Publish script');
      assert.strictEqual(probe?.matchedBy, 'uia-host-pine-surface-diagnostic-scan');
      assert.strictEqual(Array.isArray(probe?.diagnosticAttempts), true);
      assert.strictEqual(
        probe.diagnosticAttempts.some((attempt) => attempt?.query === 'diagnostic-regex'),
        true,
        'diagnostic fallback should record the broader regex probe'
      );
      assert.strictEqual(
        probe.diagnosticSignals.some((signal) => signal?.text === 'Publish script'),
        true,
        'diagnostic fallback should preserve the promoted Pine anchor as a signal'
      );
      assert.strictEqual(
        calls.some((call) => /pine/i.test(String(call?.options?.text || '')) && /publish/i.test(String(call?.options?.text || '')) && Number(call?.options?.bounds?.y || 0) <= 60),
        true,
        'diagnostic fallback should probe a broader top-of-window band after the lower panel proof misses'
      );
    });
  });

  await test('probeTradingViewPineEditorSurface returns bounded diagnostic signals when Pine stays unproven', async () => {
    await withAutomationHost({
      getWindowInfoByHandle: async (hwnd) => buildWindowInfo({
        hwnd,
        title: 'MN / Unnamed',
        bounds: { x: 911, y: 8, width: 1016, height: 956 }
      }),
      getForegroundWindowInfo: async () => buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed',
        bounds: { x: 911, y: 8, width: 1016, height: 956 }
      }),
      findElementsByWindow: async (hwnd, options = {}) => {
        if (String(options?.text || '').trim()) {
          return {
            elements: [],
            count: 0,
            stats: { visited: 16, timedOut: false }
          };
        }
        if (Number(options?.bounds?.y || 0) <= 60) {
          return {
            elements: [{
              Name: 'Open source editor',
              ControlType: 'ControlType.Button',
              WindowHandle: hwnd,
              Patterns: ['Invoke'],
              Bounds: { X: 1450, Y: 104, Width: 126, Height: 30, CenterX: 1513, CenterY: 119 }
            }],
            count: 1,
            stats: { visited: 24, timedOut: false }
          };
        }
        return {
          elements: [{
            Name: 'Live stock, index, futures, Forex and Bitcoin charts on TradingView',
            ControlType: 'ControlType.Document',
            WindowHandle: hwnd,
            Bounds: { X: 911, Y: 46, Width: 1016, Height: 918, CenterX: 1419, CenterY: 505 }
          }],
          count: 1,
          stats: { visited: 8, timedOut: false }
        };
      }
    }, async () => {
      const probe = await systemAutomation.probeTradingViewPineEditorSurface({
        windowHandle: 460832,
        timeout: 1200,
        cdpDependencies: buildUnavailableTradingViewCdpDependencies()
      });

      assert.strictEqual(probe?.active, false);
      assert.strictEqual(Array.isArray(probe?.diagnosticAttempts), true);
      assert.strictEqual(
        probe.diagnosticAttempts.some((attempt) => attempt?.query === 'diagnostic-sample'),
        true,
        'inactive proof should still preserve bounded diagnostic sampling attempts'
      );
      assert.strictEqual(Array.isArray(probe?.diagnosticSignals), true);
      assert.strictEqual(
        probe.diagnosticSignals.some((signal) => signal?.text === 'Open source editor'),
        true,
        'inactive proof should surface high-signal diagnostic elements for follow-up'
      );
      assert.strictEqual(Array.isArray(probe?.visibleAnchors), true);
      assert.strictEqual(probe.visibleAnchors.length, 0);
    });
  });

  await test('captureTradingViewPineActivationSnapshot records bounded Pine surface and structure evidence for the bound TradingView window', async () => {
    const calls = [];

    await withAutomationHost({
      getWindowInfoByHandle: async (hwnd) => buildWindowInfo({
        hwnd,
        title: 'MN / Unnamed',
        bounds: { x: 911, y: 8, width: 1016, height: 956 }
      }),
      getForegroundWindowInfo: async () => buildWindowInfo({
        hwnd: 460832,
        title: 'MN / Unnamed',
        bounds: { x: 911, y: 8, width: 1016, height: 956 }
      }),
      getFocusedElementInWindow: async (hwnd) => ({
        focused: true,
        reason: 'focused-descendant',
        element: {
          Name: 'Untitled script',
          ControlType: 'ControlType.Edit',
          AutomationId: 'pine-editor-input',
          WindowHandle: hwnd,
          Patterns: ['Value', 'Text'],
          HasKeyboardFocus: true,
          IsFocusable: true,
          Bounds: { X: 1260, Y: 620, Width: 420, Height: 44, CenterX: 1470, CenterY: 642 }
        },
        stats: { visited: 8, elapsedMs: 14 }
      }),
      findElementsByWindow: async (hwnd, options = {}) => {
        calls.push({ hwnd, options });
        const queryText = String(options?.text || '');
        if (/Add to chart/i.test(queryText)) {
          return {
            elements: [{
              Name: 'Add to chart',
              ControlType: 'ControlType.Button',
              WindowHandle: hwnd,
              Patterns: ['Invoke'],
              Bounds: { X: 1540, Y: 438, Width: 120, Height: 32, CenterX: 1600, CenterY: 454 }
            }],
            count: 1,
            stats: { visited: 12, timedOut: false }
          };
        }
        if (!queryText) {
          return {
            elements: [
              {
                Name: 'Publish script',
                ControlType: 'ControlType.Button',
                WindowHandle: hwnd,
                Patterns: ['Invoke'],
                Bounds: { X: 1510, Y: 132, Width: 118, Height: 30, CenterX: 1569, CenterY: 147 }
              },
              {
                Name: 'Untitled script',
                ControlType: 'ControlType.Edit',
                AutomationId: 'pine-editor-input',
                WindowHandle: hwnd,
                Patterns: ['Value', 'Text'],
                Bounds: { X: 1260, Y: 620, Width: 420, Height: 44, CenterX: 1470, CenterY: 642 }
              }
            ],
            count: 2,
            stats: { visited: 20, timedOut: false }
          };
        }
        return {
          elements: [],
          count: 0,
          stats: { visited: 10, timedOut: false }
        };
      }
    }, async () => {
      const snapshot = await systemAutomation.captureTradingViewPineActivationSnapshot({
        windowHandle: 460832,
        timeoutMs: 900,
        cdpDependencies: buildUnavailableTradingViewCdpDependencies()
      });

      assert.strictEqual(snapshot?.captured, true);
      assert.strictEqual(snapshot?.windowHandle, 460832);
      assert.strictEqual(snapshot?.windowInfo?.pid, 4242);
      assert.strictEqual(snapshot?.pineSurface?.active, true);
      assert.strictEqual(snapshot?.pineSurface?.anchorText, 'Add to chart');
      assert.strictEqual(snapshot?.focusedElement?.Name, 'Untitled script');
      assert.strictEqual(Array.isArray(snapshot?.structure?.attempts), true);
      assert.strictEqual(
        snapshot.structure.elements.some((element) => element?.label === 'Publish script'),
        true,
        'bounded structure sample should preserve high-signal Pine chrome'
      );
      assert.strictEqual(
        calls.some((call) => String(call?.options?.text || '') === ''),
        true,
        'activation snapshot should collect a bounded host structure sample'
      );
    });
  });

  await test('captureTradingViewPineActivationSnapshot skips deep host revalidation when watcher-first proof sees no delta', async () => {
    const stableWatcher = {
      cache: {
        lastUpdate: 2500,
        updateCount: 41,
        activeWindow: buildWindowInfo({
          hwnd: 460832,
          title: 'MN / Unnamed',
          bounds: { x: 911, y: 8, width: 1016, height: 956 }
        }),
        elements: [
          buildWatcherElement(),
          buildWatcherElement({
            id: 'Button|Indicators|indicators-toolbar-button|1600|680',
            name: 'Indicators',
            automationId: 'indicators-toolbar-button',
            bounds: { x: 1600, y: 680, width: 104, height: 28 }
          })
        ]
      },
      async waitForFreshState() {
        return {
          fresh: true,
          timedOut: false,
          immediate: true,
          activeWindow: this.cache.activeWindow,
          lastUpdate: this.cache.lastUpdate
        };
      }
    };

    await withUIWatcher(stableWatcher, async () => {
      await withAutomationHost({
        getFocusedElementInWindow: async () => {
          throw new Error('focused element host probe should be skipped when watcher is stable');
        },
        findElementsByWindow: async () => {
          throw new Error('findElementsByWindow host probe should be skipped when watcher is stable');
        }
      }, async () => {
        const previousSnapshot = {
          captured: true,
          windowHandle: 460832,
          windowInfo: buildWindowInfo({
            hwnd: 460832,
            title: 'MN / Unnamed',
            bounds: { x: 911, y: 8, width: 1016, height: 956 }
          }),
          watcher: {
            available: true,
            activeMatchesWindow: true,
            activeWindow: buildWindowInfo({
              hwnd: 460832,
              title: 'MN / Unnamed',
              bounds: { x: 911, y: 8, width: 1016, height: 956 }
            }),
            lastUpdate: 2500,
            updateCount: 41,
            elementCount: 2,
            elements: stableWatcher.cache.elements.map((entry) => summarizeWatcherElementForActivation(entry)),
            elementKeys: stableWatcher.cache.elements.map((entry) => buildWatcherElementKeyForActivation(
              summarizeWatcherElementForActivation(entry)
            )),
            fingerprint: stableWatcher.cache.elements.map((entry) => buildWatcherElementKeyForActivation(
              summarizeWatcherElementForActivation(entry)
            )).sort().join('||')
          }
        };

        const snapshot = await systemAutomation.captureTradingViewPineActivationSnapshot({
          windowHandle: 460832,
          proofStrategy: 'watcher-first',
          phase: 'after',
          waitForWatcherState: true,
          watcherSinceTs: 2000,
          previousSnapshot,
          cdpDependencies: buildUnavailableTradingViewCdpDependencies()
        });

        assert.strictEqual(snapshot?.captured, true);
        assert.strictEqual(snapshot?.proofStrategy, 'watcher-first');
        assert.strictEqual(snapshot?.hostRevalidation?.attempted, false);
        assert.strictEqual(snapshot?.hostRevalidation?.reason, 'watcher-stable-no-delta');
        assert.strictEqual(snapshot?.pineSurface?.active, false);
        assert.strictEqual(snapshot?.focusedElement, null);
        assert.strictEqual(snapshot?.structure?.skipped, true);
      });
    });
  });

  await test('captureTradingViewPineActivationSnapshot revalidates Pine surface on watcher delta without full structure sampling', async () => {
    const watcherElements = [
      buildWatcherElement(),
      buildWatcherElement({
        id: 'Button|Add to chart|pine-add-to-chart|1540|438',
        name: 'Add to chart',
        automationId: 'pine-add-to-chart',
        bounds: { x: 1540, y: 438, width: 120, height: 32 }
      })
    ];
    const watcher = {
      cache: {
        lastUpdate: 4200,
        updateCount: 45,
        activeWindow: buildWindowInfo({
          hwnd: 460832,
          title: 'MN / Unnamed',
          bounds: { x: 911, y: 8, width: 1016, height: 956 }
        }),
        elements: watcherElements
      },
      async waitForFreshState() {
        return {
          fresh: true,
          timedOut: false,
          immediate: false,
          activeWindow: this.cache.activeWindow,
          lastUpdate: this.cache.lastUpdate
        };
      }
    };
    const calls = [];

    await withUIWatcher(watcher, async () => {
      await withAutomationHost({
        getFocusedElementInWindow: async (hwnd) => {
          calls.push(`focus:${hwnd}`);
          return {
            focused: true,
            reason: 'focused-descendant',
            element: {
              Name: 'Untitled script',
              ControlType: 'ControlType.Edit',
              AutomationId: 'pine-editor-input',
              WindowHandle: hwnd,
              Bounds: { X: 1260, Y: 620, Width: 420, Height: 44, CenterX: 1470, CenterY: 642 }
            }
          };
        },
        findElementsByWindow: async (hwnd, options = {}) => {
          calls.push(`find:${hwnd}:${String(options?.text || '')}:${String(options?.view || '')}`);
          if (/Add to chart/i.test(String(options?.text || ''))) {
            return {
              elements: [{
                Name: 'Add to chart',
                ControlType: 'ControlType.Button',
                WindowHandle: hwnd,
                Patterns: ['Invoke'],
                Bounds: { X: 1540, Y: 438, Width: 120, Height: 32, CenterX: 1600, CenterY: 454 }
              }],
              count: 1,
              stats: { visited: 10, timedOut: false }
            };
          }
          return {
            elements: [],
            count: 0,
            stats: { visited: 8, timedOut: false }
          };
        }
      }, async () => {
        const previousElements = [buildWatcherElement()];
        const previousSnapshot = {
          captured: true,
          windowHandle: 460832,
          windowInfo: buildWindowInfo({
            hwnd: 460832,
            title: 'MN / Unnamed',
            bounds: { x: 911, y: 8, width: 1016, height: 956 }
          }),
          watcher: {
            available: true,
            activeMatchesWindow: true,
            activeWindow: buildWindowInfo({
              hwnd: 460832,
              title: 'MN / Unnamed',
              bounds: { x: 911, y: 8, width: 1016, height: 956 }
            }),
            lastUpdate: 3900,
            updateCount: 42,
            elementCount: 1,
            elements: previousElements.map((entry) => summarizeWatcherElementForActivation(entry)),
            elementKeys: previousElements.map((entry) => buildWatcherElementKeyForActivation(
              summarizeWatcherElementForActivation(entry)
            )),
            fingerprint: previousElements.map((entry) => buildWatcherElementKeyForActivation(
              summarizeWatcherElementForActivation(entry)
            )).sort().join('||')
          }
        };

        const snapshot = await systemAutomation.captureTradingViewPineActivationSnapshot({
          windowHandle: 460832,
          proofStrategy: 'watcher-first',
          phase: 'after',
          waitForWatcherState: true,
          watcherSinceTs: 3900,
          previousSnapshot,
          cdpDependencies: buildUnavailableTradingViewCdpDependencies()
        });

        assert.strictEqual(snapshot?.captured, true);
        assert.strictEqual(snapshot?.hostRevalidation?.attempted, true);
        assert.strictEqual(snapshot?.hostRevalidation?.reason, 'watcher-delta');
        assert.strictEqual(snapshot?.pineSurface?.active, true);
        assert.strictEqual(snapshot?.pineSurface?.anchorText, 'Add to chart');
        assert.strictEqual(snapshot?.structure?.skipped, true);
        assert.strictEqual(snapshot?.focusedElement?.Name, 'Untitled script');
        assert.strictEqual(calls.includes('focus:460832'), true);
        assert.strictEqual(
          calls.some((entry) => entry.startsWith('find:460832') && entry.includes('Add to chart')),
          true,
          'watcher delta should trigger bounded host Pine-surface revalidation'
        );
      });
    });
  });

  await test('buildTradingViewPineActivationTransitionProof classifies TradingView state change without Pine anchors', async () => {
    const before = {
      captured: true,
      windowHandle: 777,
      foreground: {
        success: true,
        hwnd: 777,
        processName: 'tradingview',
        title: 'MN / Unnamed',
        windowKind: 'main'
      },
      pineSurface: {
        active: false,
        anchorText: null
      },
      focusedElement: {
        Name: 'Live stock, index, futures, Forex and Bitcoin charts on TradingView',
        ControlType: 'ControlType.Document'
      },
      focusedElementKey: 'chart-document',
      structure: {
        elements: [{
          label: 'Pine',
          controlType: 'ControlType.Button',
          automationId: 'pine-toolbar-button',
          className: 'Button',
          bounds: { x: 1500, y: 680, width: 88, height: 28 }
        }],
        elementKeys: ['pine-toolbar-button']
      },
      watcher: {
        fingerprint: 'before-fingerprint',
        updateCount: 41,
        elementCount: 6,
        activeMatchesWindow: true
      }
    };
    const after = {
      captured: true,
      windowHandle: 777,
      foreground: {
        success: true,
        hwnd: 777,
        processName: 'tradingview',
        title: 'MN / Unnamed',
        windowKind: 'main'
      },
      pineSurface: {
        active: false,
        anchorText: null
      },
      focusedElement: {
        Name: 'Source editor',
        ControlType: 'ControlType.Edit'
      },
      focusedElementKey: 'source-editor',
      structure: {
        elements: [{
          label: 'Source editor',
          controlType: 'ControlType.Edit',
          automationId: 'pine-editor-input',
          className: 'Edit',
          bounds: { x: 1260, y: 620, width: 420, height: 44 }
        }],
        elementKeys: ['pine-editor-input']
      },
      watcher: {
        fingerprint: 'after-fingerprint',
        updateCount: 42,
        elementCount: 7,
        activeMatchesWindow: true
      }
    };

    const proof = systemAutomation.buildTradingViewPineActivationTransitionProof(before, after, {
      actionSucceeded: true,
      windowHandle: 777
    });

    assert.strictEqual(proof?.applicable, true);
    assert.strictEqual(proof?.observedChange, true);
    assert.strictEqual(proof?.pineSurfaceObserved, false);
    assert.strictEqual(proof?.disposition, 'window-state-changed-without-pine-surface');
    assert.strictEqual(
      proof.signals.some((signal) => signal?.kind === 'focused-element-changed'),
      true,
      'focused-element diffs should contribute to the activation proof'
    );
    assert.strictEqual(
      proof.signals.some((signal) => signal?.kind === 'uia-structure-changed'),
      true,
      'structure diffs should contribute to the activation proof'
    );
  });

  await test('buildTradingViewPineActivationTransitionProof classifies renderer-proof-unavailable when Chromium renderer proof is unavailable after semantic Pine activation', async () => {
    const before = {
      captured: true,
      windowHandle: 777,
      foreground: {
        success: true,
        hwnd: 777,
        processName: 'tradingview',
        title: 'MN / Unnamed',
        windowKind: 'main'
      },
      pineSurface: {
        active: false,
        anchorText: null
      },
      rendererProof: {
        applicable: true,
        available: false,
        active: false,
        reason: 'remote-debugging-port-not-configured',
        port: 0
      },
      focusedElement: {
        Name: 'Live stock, index, futures, Forex and Bitcoin charts on TradingView',
        ControlType: 'ControlType.Document'
      },
      focusedElementKey: 'chart-document',
      structure: {
        elements: [],
        elementKeys: []
      },
      watcher: {
        fingerprint: 'before-fingerprint',
        updateCount: 41,
        elementCount: 6,
        activeMatchesWindow: true
      }
    };
    const after = {
      captured: true,
      windowHandle: 777,
      foreground: {
        success: true,
        hwnd: 777,
        processName: 'tradingview',
        title: 'MN / Unnamed',
        windowKind: 'main'
      },
      pineSurface: {
        active: false,
        anchorText: null
      },
      rendererProof: {
        applicable: true,
        available: false,
        active: false,
        reason: 'remote-debugging-port-not-configured',
        port: 0
      },
      focusedElement: {
        Name: 'Source editor',
        ControlType: 'ControlType.Edit'
      },
      focusedElementKey: 'source-editor',
      structure: {
        elements: [{
          label: 'Source editor',
          controlType: 'ControlType.Edit',
          automationId: 'pine-editor-input',
          className: 'Edit',
          bounds: { x: 1260, y: 620, width: 420, height: 44 }
        }],
        elementKeys: ['pine-editor-input']
      },
      watcher: {
        fingerprint: 'after-fingerprint',
        updateCount: 42,
        elementCount: 7,
        activeMatchesWindow: true
      }
    };

    const proof = systemAutomation.buildTradingViewPineActivationTransitionProof(before, after, {
      actionSucceeded: true,
      windowHandle: 777
    });

    assert.strictEqual(proof?.applicable, true);
    assert.strictEqual(proof?.pineSurfaceObserved, false);
    assert.strictEqual(proof?.disposition, 'renderer-proof-unavailable');
    assert.strictEqual(proof?.rendererProof?.available, false);
    assert.strictEqual(
      proof.signals.some((signal) => signal?.kind === 'renderer-proof-unavailable'),
      true,
      'renderer-proof-unavailable should become an explicit activation proof signal'
    );
  });
}

main().catch((error) => {
  console.error('FAIL system automation host bridge');
  console.error(error.stack || error.message);
  process.exit(1);
}).finally(async () => {
  clearTimeout(forcedExitTimer);
  await shutdownSharedUIAHost().catch(() => {});
});
