const LIKU_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'click_element',
      description: 'Click a UI element by its visible text or name (uses Windows UI Automation). Preferred over coordinate clicks.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The visible text/name of the element to click' },
          reason: { type: 'string', description: 'Why this click is needed' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description: 'Left click at pixel coordinates on screen. Use as fallback when click_element cannot find the target.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X pixel coordinate' },
          y: { type: 'number', description: 'Y pixel coordinate' },
          reason: { type: 'string', description: 'Why clicking here' }
        },
        required: ['x', 'y']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'double_click',
      description: 'Double click at pixel coordinates.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X pixel coordinate' },
          y: { type: 'number', description: 'Y pixel coordinate' }
        },
        required: ['x', 'y']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'right_click',
      description: 'Right click at pixel coordinates to open context menu.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X pixel coordinate' },
          y: { type: 'number', description: 'Y pixel coordinate' }
        },
        required: ['x', 'y']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'type_text',
      description: 'Type text into the currently focused input field.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The text to type' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'press_key',
      description: 'Press a key or keyboard shortcut (e.g., "enter", "ctrl+c", "win+r", "alt+tab").',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key combo string (e.g., "ctrl+s", "enter", "win+d")' },
          reason: { type: 'string', description: 'Why pressing this key' }
        },
        required: ['key']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'scroll',
      description: 'Scroll up or down.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
          amount: { type: 'number', description: 'Scroll amount (default 3)' }
        },
        required: ['direction']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'drag',
      description: 'Drag from one point to another.',
      parameters: {
        type: 'object',
        properties: {
          fromX: { type: 'number' }, fromY: { type: 'number' },
          toX: { type: 'number' }, toY: { type: 'number' }
        },
        required: ['fromX', 'fromY', 'toX', 'toY']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'wait',
      description: 'Wait for a specified number of milliseconds before the next action.',
      parameters: {
        type: 'object',
        properties: {
          ms: { type: 'number', description: 'Milliseconds to wait' }
        },
        required: ['ms']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description: 'Take a screenshot to see the current screen state. Use for verification or when elements are not in the UI tree.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Execute a shell command and return output. Preferred for any file/system operations.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          cwd: { type: 'string', description: 'Working directory (optional)' },
          shell: { type: 'string', enum: ['powershell', 'cmd', 'bash'], description: 'Shell to use (default: powershell on Windows)' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'focus_window',
      description: 'Bring a window to the foreground by its handle or title.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Partial window title to match' },
          windowHandle: { type: 'number', description: 'Window handle (hwnd)' }
        }
      }
    }
  }
];

function toolCallsToActions(toolCalls) {
  // Lazy-load to avoid circular dependencies at module level
  let toolRegistry;
  try { toolRegistry = require('../../../tools/tool-registry'); } catch { toolRegistry = null; }

  return toolCalls.map((tc) => {
    let args;
    try {
      args = JSON.parse(tc.function.arguments);
    } catch {
      args = {};
    }
    const name = tc.function.name;

    switch (name) {
      case 'click_element':
        return { type: 'click_element', ...args };
      case 'click':
        return { type: 'click', ...args };
      case 'double_click':
        return { type: 'double_click', ...args };
      case 'right_click':
        return { type: 'right_click', ...args };
      case 'type_text':
        return { type: 'type', ...args };
      case 'press_key':
        return { type: 'key', key: args.key, reason: args.reason };
      case 'scroll':
        return { type: 'scroll', ...args };
      case 'drag':
        return { type: 'drag', ...args };
      case 'wait':
        return { type: 'wait', ...args };
      case 'screenshot':
        return { type: 'screenshot' };
      case 'run_command':
        return { type: 'run_command', ...args };
      case 'focus_window':
        if (args.title) {
          return { type: 'bring_window_to_front', title: args.title };
        }
        return { type: 'focus_window', windowHandle: args.windowHandle };
      default:
        // Check dynamic tool registry (Phase 3 — AutoAct sandbox tools)
        if (toolRegistry && name.startsWith('dynamic_')) {
          return { type: 'dynamic_tool', toolName: name.replace('dynamic_', ''), args };
        }
        return { type: name, ...args };
    }
  });
}

/**
 * Return tool definitions including any registered dynamic tools.
 * Static LIKU_TOOLS are always included; dynamic tools from the registry
 * are appended at runtime.
 */
function getToolDefinitions() {
  let dynamicDefs = [];
  try {
    const toolRegistry = require('../../../tools/tool-registry');
    dynamicDefs = toolRegistry.getDynamicToolDefinitions();
  } catch { /* tool-registry not available or empty */ }
  if (dynamicDefs.length === 0) return LIKU_TOOLS;
  return [...LIKU_TOOLS, ...dynamicDefs];
}

module.exports = {
  LIKU_TOOLS,
  toolCallsToActions,
  getToolDefinitions
};
