let uiWatcher = null;
let semanticDomSnapshot = null;
let semanticDomUpdatedAt = 0;
const SEMANTIC_DOM_MAX_DEPTH = 4;
const SEMANTIC_DOM_MAX_NODES = 120;
const SEMANTIC_DOM_MAX_CHARS = 3500;
const SEMANTIC_DOM_MAX_AGE_MS = 5000;

function setUIWatcher(watcher) {
  uiWatcher = watcher;
  if (process.env.LIKU_CHAT_TRANSCRIPT_QUIET !== '1') {
    console.log('[AI-SERVICE] UI Watcher connected');
  }
}

function getUIWatcher() {
  return uiWatcher;
}

function setSemanticDOMSnapshot(tree) {
  semanticDomSnapshot = tree || null;
  semanticDomUpdatedAt = Date.now();
}

function clearSemanticDOMSnapshot() {
  semanticDomSnapshot = null;
  semanticDomUpdatedAt = 0;
}

function pruneSemanticTree(root) {
  const results = [];

  function walk(node, depth = 0) {
    if (!node || depth > SEMANTIC_DOM_MAX_DEPTH || results.length >= SEMANTIC_DOM_MAX_NODES) {
      return;
    }

    const bounds = node.bounds || {};
    const isInteractive = !!node.isClickable || !!node.isFocusable;
    const hasName = typeof node.name === 'string' && node.name.trim().length > 0;
    const hasValidBounds = [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
      && bounds.width > 0
      && bounds.height > 0;

    if ((isInteractive || hasName) && hasValidBounds) {
      results.push({
        id: node.id || '',
        name: hasName ? node.name.trim().slice(0, 64) : '',
        role: node.role || 'Unknown',
        bounds: {
          x: Math.round(bounds.x),
          y: Math.round(bounds.y),
          width: Math.round(bounds.width),
          height: Math.round(bounds.height)
        },
        isClickable: !!node.isClickable,
        isFocusable: !!node.isFocusable
      });
    }

    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        if (results.length >= SEMANTIC_DOM_MAX_NODES) break;
        walk(child, depth + 1);
      }
    }
  }

  walk(root, 0);
  return results;
}

function getSemanticDOMContextText() {
  if (!semanticDomSnapshot || !semanticDomUpdatedAt) {
    return '';
  }

  if ((Date.now() - semanticDomUpdatedAt) > SEMANTIC_DOM_MAX_AGE_MS) {
    return '';
  }

  const nodes = pruneSemanticTree(semanticDomSnapshot);
  if (!nodes.length) {
    return '';
  }

  const lines = [];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    const namePart = node.name ? ` \"${node.name}\"` : '';
    const idPart = node.id ? ` id=${node.id}` : '';
    const flags = [node.isClickable ? 'clickable' : null, node.isFocusable ? 'focusable' : null]
      .filter(Boolean)
      .join(',');
    const flagPart = flags ? ` [${flags}]` : '';
    lines.push(
      `- [${index + 1}] ${node.role}${namePart}${idPart} at (${node.bounds.x}, ${node.bounds.y}, ${node.bounds.width}, ${node.bounds.height})${flagPart}`
    );
  }

  let text = `\n\n## Semantic DOM (grounded accessibility tree)\n${lines.join('\n')}`;
  if (text.length > SEMANTIC_DOM_MAX_CHARS) {
    text = `${text.slice(0, SEMANTIC_DOM_MAX_CHARS)}\n... (truncated)`;
  }

  return text;
}

module.exports = {
  clearSemanticDOMSnapshot,
  getSemanticDOMContextText,
  getUIWatcher,
  pruneSemanticTree,
  setSemanticDOMSnapshot,
  setUIWatcher
};
