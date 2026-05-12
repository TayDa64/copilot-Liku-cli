#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const systemAutomation = require('../src/main/system-automation');
const uiAutomation = require('../src/main/ui-automation');

const PROBE_TIMEOUT_MS = 30000;
const forcedExitTimer = setTimeout(() => {
  console.error(`FAIL probe-tradingview-pine-icon-uia timed out after ${PROBE_TIMEOUT_MS}ms`);
  process.exit(1);
}, PROBE_TIMEOUT_MS);
if (typeof forcedExitTimer.unref === 'function') {
  forcedExitTimer.unref();
}

const PINE_ICON_TEXT_CANDIDATES = Object.freeze([
  'Pine',
  'Pine Editor',
  'Open Pine Editor',
  'Pine Script Editor',
  'Open Pine Script Editor'
]);

function normalize(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function summarizeElement(element = null) {
  if (!element || typeof element !== 'object') return null;
  const bounds = element.Bounds || element.bounds || null;
  return {
    name: element.Name || element.name || '',
    controlType: element.ControlType || element.controlType || element.role || '',
    automationId: element.AutomationId || element.automationId || element.id || '',
    className: element.ClassName || element.className || '',
    windowHandle: Number(element.WindowHandle || element.windowHandle || 0) || 0,
    patterns: element.Patterns || element.patterns || [],
    bounds: bounds
      ? {
          x: Number(bounds.X ?? bounds.x ?? 0),
          y: Number(bounds.Y ?? bounds.y ?? 0),
          width: Number(bounds.Width ?? bounds.width ?? 0),
          height: Number(bounds.Height ?? bounds.height ?? 0),
          centerX: Number(bounds.CenterX ?? bounds.centerX ?? 0),
          centerY: Number(bounds.CenterY ?? bounds.centerY ?? 0)
        }
      : null,
    isClickable: element.isClickable === true || false,
    isFocusable: element.isFocusable === true || false
  };
}

async function resolveTradingViewWindow() {
  let hwnd = 0;
  try {
    hwnd = Number(await systemAutomation.resolveWindowHandle({
      processName: 'tradingview',
      title: 'TradingView'
    }) || 0) || 0;
  } catch {}

  if (hwnd) {
    try {
      const info = await systemAutomation.getWindowInfoByHandle(hwnd);
      return { hwnd, info, source: 'resolveWindowHandle' };
    } catch {
      return { hwnd, info: null, source: 'resolveWindowHandle' };
    }
  }

  try {
    const foreground = await systemAutomation.getForegroundWindowInfo();
    const processName = normalize(foreground?.processName || '');
    const title = normalize(foreground?.title || '');
    if (processName.includes('tradingview') || title.includes('tradingview')) {
      return {
        hwnd: Number(foreground?.hwnd || 0) || 0,
        info: foreground,
        source: 'foreground'
      };
    }
  } catch {}

  return { hwnd: 0, info: null, source: 'none' };
}

async function findNamedCandidates(hwnd) {
  const results = [];
  const seen = new Set();
  const host = uiAutomation.getSharedUIAHost();
  const escaped = PINE_ICON_TEXT_CANDIDATES
    .map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');

  try {
    const found = await host.findElementsByWindow(hwnd, {
      text: `\\b(${escaped})\\b`,
      textMode: 'regex',
      controlType: '',
      maxResults: 1,
      maxDepth: 16,
      maxVisited: 700,
      timeoutMs: 5000
    });
    for (const element of Array.isArray(found?.elements) ? found.elements : []) {
      const summary = summarizeElement(element);
      const key = JSON.stringify([
        summary.name,
        summary.controlType,
        summary.automationId,
        summary.bounds?.x,
        summary.bounds?.y,
        summary.bounds?.width,
        summary.bounds?.height
      ]);
      if (seen.has(key)) continue;
      seen.add(key);
      const matchedText = PINE_ICON_TEXT_CANDIDATES.find((candidate) => {
        const normalizedCandidate = normalize(candidate);
        return normalize(summary.name) === normalizedCandidate
          || normalize(summary.automationId) === normalizedCandidate
          || normalize(summary.name).includes(normalizedCandidate);
      }) || summary.name || 'Pine Editor';
      results.push({
        query: { text: matchedText, controlType: 'any', mode: 'single-regex' },
        element: summary,
        invokable: Array.isArray(summary.patterns)
          ? summary.patterns.some((pattern) => /invoke/i.test(String(pattern || '')))
          : false,
        hostStats: found.stats || null
      });
    }
  } catch (error) {
    results.push({
      query: { text: PINE_ICON_TEXT_CANDIDATES.join(' | '), controlType: 'any', mode: 'single-regex' },
      error: error?.message || String(error || 'findElementsByWindow failed')
    });
  }

  return results;
}

async function scanWindowForPineLikeElements(hwnd) {
  try {
    const host = uiAutomation.getSharedUIAHost();
    const found = await host.findElementsByWindow(hwnd, {
      text: '(pine|editor|script)',
      textMode: 'regex',
      maxResults: 75,
      maxDepth: 18,
      maxVisited: 900,
      timeoutMs: 6500,
      includeOffscreen: false
    });
    const pineNodes = (Array.isArray(found?.elements) ? found.elements : [])
      .map(summarizeElement)
      .slice(0, 50);
    return {
      success: true,
      stats: found.stats || null,
      count: found.count || pineNodes.length,
      pineLikeNodes: pineNodes
    };
  } catch (error) {
    return {
      success: false,
      error: error?.message || String(error || 'findElementsByWindow failed')
    };
  }
}

async function main() {
  const shouldInvoke = process.argv.includes('--invoke');
  const resolved = await resolveTradingViewWindow();
  const report = {
    timestamp: new Date().toISOString(),
    purpose: 'Probe whether the TradingView Pine Editor icon is semantically exposed through Windows UI Automation.',
    mode: shouldInvoke ? 'probe-and-invoke' : 'probe-only',
    tradingViewWindow: resolved,
    namedCandidates: [],
    boundedWindowScan: null,
    conclusion: null
  };

  if (!resolved.hwnd) {
    report.conclusion = {
      semanticIconAvailable: false,
      canInvokeWithoutCoordinates: false,
      reason: 'TradingView window was not resolved or foreground.'
    };
    console.log(JSON.stringify(report, null, 2));
    process.exit(2);
  }

  try {
    await systemAutomation.focusWindow(resolved.hwnd);
  } catch (error) {
    report.focusError = error?.message || String(error || 'focusWindow failed');
  }

  report.namedCandidates = await findNamedCandidates(resolved.hwnd);
  const namedInvokableCandidate = report.namedCandidates.find((candidate) => candidate?.invokable === true);
  report.boundedWindowScan = namedInvokableCandidate
    ? {
        success: true,
        skipped: true,
        reason: 'Skipped broad scan because a named invokable Pine toolbar candidate was already found.'
      }
    : await scanWindowForPineLikeElements(resolved.hwnd);

  const invokableCandidate = report.namedCandidates.find((candidate) =>
    candidate?.element && (
      candidate.invokable
      || String(candidate.element.controlType || '').toLowerCase().includes('button')
    )
  );

  if (!invokableCandidate) {
    report.conclusion = {
      semanticIconAvailable: false,
      canInvokeWithoutCoordinates: false,
      reason: 'No named Pine Editor UIA button/image/text candidate was found in the TradingView window.'
    };
  } else {
    report.conclusion = {
      semanticIconAvailable: true,
      canInvokeWithoutCoordinates: invokableCandidate.invokable === true,
      reason: invokableCandidate.invokable
        ? 'A Pine Editor candidate exposes InvokePattern and can be used without coordinate fallback.'
        : 'A Pine Editor candidate was found, but no InvokePattern was reported; coordinate fallback should remain disabled unless a host invoke path proves reliable.',
      selectedCandidate: invokableCandidate
    };
  }

  if (shouldInvoke && invokableCandidate) {
    const selectedText = invokableCandidate.query?.text || 'Pine Editor';
    const selectedExact = selectedText === 'Pine';
    report.invokeAttempt = await systemAutomation.executeAction({
      type: 'click_element',
      text: selectedText,
      controlType: invokableCandidate.element?.controlType || 'Button',
      exact: selectedExact || selectedText !== 'Pine Editor',
      windowHandle: resolved.hwnd,
      foregroundOnly: true,
      allowCoordinateFallback: false,
      reason: 'Probe invocation of TradingView Pine Editor icon without coordinate fallback'
    });
  }

  const artifactDir = path.join(__dirname, '..', 'artifacts', 'uia-probes');
  fs.mkdirSync(artifactDir, { recursive: true });
  const artifactPath = path.join(
    artifactDir,
    `${new Date().toISOString().replace(/[:.]/g, '-')}--tradingview-pine-icon-uia.json`
  );
  fs.writeFileSync(artifactPath, JSON.stringify(report, null, 2));
  report.artifactPath = artifactPath;

  console.log(JSON.stringify(report, null, 2));
  await uiAutomation.shutdownSharedUIAHost();
  process.exit(report.conclusion?.semanticIconAvailable ? 0 : 3);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  uiAutomation.shutdownSharedUIAHost()
    .catch(() => {})
    .finally(() => process.exit(1));
});
