# Further AI Advancements — v0.0.15+ Implementation Plan

> **Status**: Phases 0–9 COMPLETE, N1-N6 roadmap MOSTLY COMPLETE — 2026-03-12 (commit `fde64b0`)
> **Prior art**: [advancingFeatures.md](advancingFeatures.md) covers vision/overlay/coordinate hardening (Phases 0–4). This document covers the **cognitive layer** that sits above that substrate.
> **Test coverage**: 310 cognitive + 29 regression = 339 assertions, 0 failures across 15+ suites.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Academic Grounding](#academic-grounding)
3. [Codebase Ground Truth — What Exists Today](#codebase-ground-truth)
4. [Phase 0 — Structured Home Directory (`~/.liku/`)](#phase-0--structured-home-directory)
5. [Phase 1 — Agentic Memory (A-MEM Adaptation)](#phase-1--agentic-memory)
6. [Phase 2 — Reinforcement via Verifiable Rewards (RLVR Adaptation)](#phase-2--reinforcement-via-verifiable-rewards)
7. [Phase 3 — Dynamic Tool Generation (AutoAct Adaptation)](#phase-3--dynamic-tool-generation)
8. [Phase 4 — Semantic Skill Router (Context Window Management)](#phase-4--semantic-skill-router)
9. [Phase 5–8 — Integration, Safety, AWM, Audit Fixes](#phase-5-8--integration-safety-awm-audit)
10. [Phase 9 — Design-Level Hardening (Gemini Audit)](#phase-9--design-level-hardening)
11. [Cross-Cutting Concerns](#cross-cutting-concerns)
12. [Dependency Graph](#dependency-graph)
13. [Risk Register](#risk-register)
14. [Acceptance Criteria (per phase)](#acceptance-criteria)
15. [Next-Stage Roadmap](#next-stage-roadmap)

---

## Executive Summary

This plan adapts three research concepts to `copilot-liku-cli`'s existing architecture:

| Concept | Source | Liku Adaptation |
|---------|--------|----------------|
| **A-MEM** (Agentic Memory) | Xu et al., NeurIPS 2025 ([arXiv:2502.12110](https://arxiv.org/abs/2502.12110)) | Structured memory with Zettelkasten-style linking in `~/.liku/memory/` |
| **RLVR** (Reinforcement Learning with Verifiable Rewards) | Lambert et al., Tulu 3 ([arXiv:2411.15124](https://arxiv.org/abs/2411.15124)) | Verifier exit-code → structured telemetry → reflection agent → skill update loop |
| **AutoAct** (Automatic Agent Learning) | Qiao et al., ACL 2024 ([arXiv:2401.05268](https://arxiv.org/abs/2401.05268)) | AI-generated tool scripts executed in VM sandbox with hook enforcement |

Additionally, **Agent Workflow Memory** (Wang et al., [arXiv:2409.07429](https://arxiv.org/abs/2409.07429)) informs the skill/workflow reuse strategy.

**Key constraint**: Every phase must be non-breaking for existing CLI commands, Electron overlay, and multi-provider AI service. The existing hook system (`.github/hooks/copilot-hooks.json`) is the security boundary for all new autonomous behaviors.

---

## Academic Grounding

### A-MEM — Agentic Memory for LLM Agents
- **Core idea**: LLM agents dynamically organize memories using Zettelkasten principles — each memory note has structured attributes (context, keywords, tags), and the system creates/updates links between related memories as new ones are added.
- **Key finding**: Memory evolution — as new memories are integrated, they trigger updates to existing memories' representations, enabling continuous refinement.
- **Liku adaptation**: Replace the current flat `conversation-history.json` with a structured note system that captures procedural knowledge (skills), episodic outcomes (telemetry), and semantic links.

### RLVR — Reinforcement Learning with Verifiable Rewards
- **Core idea**: Instead of human preference labels, use programmatic verifiers (exit codes, test assertions, hash comparisons) as reward signals to reinforce correct agent behavior.
- **Key finding from Tulu 3**: RLVR combined with SFT and DPO produces models that outperform closed models on specific task benchmarks.
- **Liku adaptation**: We already have a Verifier agent (`recursive-verifier`) and hook-enforced quality gates (`SubagentStop`). The adaptation adds structured telemetry on success/failure and uses failures to trigger a Reflection pass that can update skills or preferences.

### AutoAct — Automatic Agent Learning from Scratch
- **Core idea**: Given a tool library, AutoAct synthesizes planning trajectories without human annotation, then uses a division-of-labor strategy to create specialized sub-agents.
- **Key finding**: The trajectory quality from the division-of-labor approach generally outperforms single-model approaches.
- **Liku adaptation**: Allow the AI to propose new tool scripts, but execute them in a sandboxed `vm.createContext` environment with explicit module whitelisting rather than `require()`.

### AWM — Agent Workflow Memory
- **Core idea**: Agents induce reusable workflows from past task completions and selectively provide them to guide future actions.
- **Key finding**: Online AWM (learning workflows on-the-fly during test queries) generalizes robustly across tasks, websites, and domains.
- **Liku adaptation**: Skills written to `~/.liku/skills/*.md` are workflow memories. The Semantic Skill Router loads only relevant skills per task, not all of them.

---

## Codebase Ground Truth

Everything below references actual files/exports as of commit 9b81cad. No proposed changes target files that do not exist.

### Current Filesystem Layout (`~/.liku-cli/`)

```
~/.liku-cli/
├── preferences.json          # App policies, action/negative policies, execution mode
├── conversation-history.json # Flat array of {role, content} pairs
├── copilot-token.json        # OAuth credentials
├── copilot-runtime-state.json
├── model-preference.json     # Last-selected model
└── session/                  # Electron session data (chromium caches)
```

**Problem**: Flat structure with no room for memory, skills, tools, or telemetry.

### Current AI Service Architecture

| Module | File | role |
|--------|------|------|
| Public facade | `src/main/ai-service.js` | Exports ~40 functions, delegates to internals |
| System prompt | `src/main/ai-service/system-prompt.js` | Exports `SYSTEM_PROMPT`, `getPlatformContext()` |
| Provider orchestration | `src/main/ai-service/providers/orchestration.js` | `createProviderOrchestrator()` → `requestWithFallback()`, `resolveEffectiveCopilotModel()` |
| Model registry | `src/main/ai-service/providers/copilot/model-registry.js` | `COPILOT_MODELS` with `capabilities` (chat/tools/vision/reasoning/completion/automation/planning) |
| Tool definitions | `src/main/ai-service/providers/copilot/tools.js` | `LIKU_TOOLS` (13 tool functions), `toolCallsToActions()` |
| Conversation history | `src/main/ai-service/conversation-history.js` | `createConversationHistoryStore()` — in-memory + disk sync |
| Message builder | `src/main/ai-service/message-builder.js` | Builds provider-specific payloads, attaches visual frames for vision models |
| Policy enforcement | `src/main/ai-service/policy-enforcement.js` | `checkActionPolicies()`, `checkNegativePolicies()` |
| Preference parser | `src/main/ai-service/preference-parser.js` | Extracts preference corrections from natural language |
| Response heuristics | `src/main/ai-service/response-heuristics.js` | `detectTruncation()`, `shouldAutoContinueResponse()` |

### Current Preferences System

- File: `src/main/preferences.js`
- Home: `~/.liku-cli/` (constant `LIKU_HOME`)
- Schema: `{ version, updatedAt, appPolicies: { [processName]: { executionMode, stats, actionPolicies[], negativePolicies[] } } }`
- Already supports: auto-run demotion after 2 consecutive failures (`recordAutoRunOutcome()`), per-process action/negative policies, system-context injection into prompts (`getPreferencesSystemContext()`, `getPreferencesSystemContextForApp()`)

### Current Agent System

| Agent | Role | Tools | Model |
|-------|------|-------|-------|
| `recursive-supervisor` | Orchestrator, delegates only | agent, search, web/fetch, read/problems | Inherits picker |
| `recursive-builder` | Implementation | vscode, execute, read, edit, search, todo | GPT-5.2/Codex-5.3 (declared, inherits parent) |
| `recursive-verifier` | Verification pipeline | vscode, execute, read, edit, search, todo | GPT-5.2/Codex-5.3 (declared, inherits parent) |
| `recursive-researcher` | Context gathering | search, read, edit, web/fetch, todo | GPT-5.2/Gemini 3.1 Pro (declared, inherits parent) |
| `recursive-architect` | Pattern validation | read, search, edit, todo | GPT-5.2/Claude Sonnet 4.5 (declared, inherits parent) |
| `recursive-diagnostician` | Root-cause analysis | execute, read, edit, search, todo | GPT-5.2/Codex-5.3 (declared, inherits parent) |
| `recursive-vision-operator` | UI state/visual workflow | execute, read, edit, search, todo | GPT-5.2/Gemini 3.1 Pro (declared, inherits parent) |

### Current Hook System

```json
{
  "SessionStart":  "scripts/session-start.ps1",
  "PreToolUse":    "scripts/security-check.ps1",
  "PostToolUse":   "scripts/audit-log.ps1",
  "SubagentStop":  "scripts/subagent-quality-gate.ps1",
  "Stop":          "scripts/session-end.ps1"
}
```

### Key Constraint: Reasoning Models

Models `o1`, `o1-mini`, `o3-mini` in the registry have `capabilities.reasoning: true` and do **not** support `temperature`, `top_p`, or `top_k` parameters. The Copilot API returns `400 Bad Request` if these are passed. The current `getModelCapabilities()` function in `orchestration.js` already detects reasoning models via the `capabilities` field and a regex fallback (`/^o(1|3)/i`).

**No `PHASE_PARAMS` object exists today.** The brainstorm proposes adding one; implementation must strip generation parameters for reasoning models.

---

## Phase 0 — Structured Home Directory

**Goal**: Migrate from flat `~/.liku-cli/` to structured `~/.liku/` without breaking existing functionality.

### What Changes

```
~/.liku/                          # NEW home directory
├── preferences.json              # Migrated from ~/.liku-cli/
├── conversation-history.json     # Migrated from ~/.liku-cli/
├── copilot-token.json            # Migrated from ~/.liku-cli/
├── copilot-runtime-state.json    # Migrated from ~/.liku-cli/
├── model-preference.json         # Migrated from ~/.liku-cli/
├── session/                      # Electron session data (migrated)
├── memory/                       # NEW — Phase 1
│   ├── index.json                # Note index (keywords, tags, links)
│   └── notes/                    # Individual note files
├── skills/                       # NEW — Phase 1/4
│   ├── index.json                # Skill routing index
│   └── *.md                      # Individual skill markdown files
├── tools/                        # NEW — Phase 3
│   ├── registry.json             # Dynamic tool registration
│   └── dynamic/                  # AI-generated tool scripts (sandboxed)
└── telemetry/                    # NEW — Phase 2
    └── logs/                     # Failure/success telemetry payloads
```

### Implementation Details

**File**: `src/shared/liku-home.js` (NEW)

```javascript
const fs = require('fs');
const path = require('path');
const os = require('os');

const LIKU_HOME_NEW = path.join(os.homedir(), '.liku');
const LIKU_HOME_OLD = path.join(os.homedir(), '.liku-cli');

function ensureLikuStructure() {
  const dirs = ['memory/notes', 'skills', 'tools/dynamic', 'telemetry/logs'];
  dirs.forEach(d => {
    const fullPath = path.join(LIKU_HOME_NEW, d);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true, mode: 0o700 });
    }
  });
}

function migrateIfNeeded() {
  const filesToMigrate = [
    'preferences.json',
    'conversation-history.json',
    'copilot-token.json',
    'copilot-runtime-state.json',
    'model-preference.json'
  ];

  for (const file of filesToMigrate) {
    const oldPath = path.join(LIKU_HOME_OLD, file);
    const newPath = path.join(LIKU_HOME_NEW, file);
    if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
      // COPY, do not move. Safe fallback per Gemini annotation.
      fs.copyFileSync(oldPath, newPath);
      console.log(`[Liku] Migrated ${file} to ~/.liku/`);
    }
  }
}

function getLikuHome() {
  return LIKU_HOME_NEW;
}

module.exports = { ensureLikuStructure, migrateIfNeeded, getLikuHome,
                   LIKU_HOME: LIKU_HOME_NEW, LIKU_HOME_OLD };
```

**Migration strategy**: Copy, never move. Old `~/.liku-cli/` remains as fallback. `preferences.js` updates its `LIKU_HOME` constant to import from `liku-home.js`.

### Files to Modify

| File | Change |
|------|--------|
| `src/shared/liku-home.js` | **NEW** — centralized home directory management |
| `src/main/preferences.js` | Change `LIKU_HOME` from inline `path.join(os.homedir(), '.liku-cli')` to import from `liku-home.js` |
| `src/main/ai-service/conversation-history.js` | Accept `likuHome` from caller (already does via dependency injection) — no source change, just caller passes new path |
| `src/main/ai-service.js` | Call `ensureLikuStructure()` + `migrateIfNeeded()` during initialization |
| `src/cli/liku.js` | Call `ensureLikuStructure()` early in `main()` |

### Non-Breaking Guarantee

- All existing files remain in `~/.liku-cli/` (copy, not move)
- If `~/.liku/` doesn't exist, it's created on first run
- No schema changes to `preferences.json` or any other file
- Electron session directory migration is deferred (too many Chromium lock files) — kept at `~/.liku-cli/session/` initially

---

## Phase 1 — Agentic Memory

**Goal**: Give Liku a structured, evolving memory system inspired by A-MEM's Zettelkasten approach.

### Architecture

```
┌─────────────┐    add()     ┌──────────────────┐
│  AI Service  │ ──────────▶ │  Memory Manager   │
│  (sendMessage)│             │  (memory-store.js)│
└─────────────┘             └──────────────────┘
                                    │
                          ┌─────────┼─────────┐
                          ▼         ▼         ▼
                    index.json   notes/    links
                    (keywords,   (*.json)  (within
                     tags)                  index)
```

### Memory Note Schema

```json
{
  "id": "note-<ulid>",
  "type": "episodic|procedural|semantic",
  "content": "What happened / what was learned",
  "context": "Task context when this was recorded",
  "keywords": ["browser", "edge", "tab-navigation"],
  "tags": ["automation", "windows"],
  "source": { "task": "...", "timestamp": "...", "outcome": "success|failure" },
  "links": ["note-<other-ulid>"],
  "createdAt": "2026-03-11T...",
  "updatedAt": "2026-03-11T..."
}
```

**Types**:
- `episodic`: What happened during a specific task (success/failure outcomes)
- `procedural`: How to do something (reusable workflows → Phase 4 skills)
- `semantic`: Factual knowledge about the user's environment (e.g., "user prefers Edge over Chrome")

### New Files

| File | Purpose |
|------|---------|
| `src/main/memory/memory-store.js` | CRUD for memory notes, index management, link analysis |
| `src/main/memory/memory-linker.js` | Keyword/tag overlap detection, link creation/update |

### Integration Points

| Existing Module | How Memory Connects |
|----------------|---------------------|
| `src/main/ai-service/system-prompt.js` | `getMemoryContext(task)` appends relevant notes to system prompt |
| `src/main/ai-service.js` (`sendMessage`) | After each completed interaction, optionally write an episodic note |
| `src/main/preferences.js` | `getPreferencesSystemContextForApp()` already serves this role for app-scoped policies; memory extends it with cross-app knowledge |
| Hook: `SubagentStop` | Quality gate can trigger memory write on significant outcomes |

### What Does NOT Change

- `conversation-history.js` continues to work exactly as-is (short-term context)
- Memory is **supplementary** — it adds to the system prompt, it does not replace conversation history
- The system prompt string in `system-prompt.js` gains a new optional section appended by the caller, not a hardcoded change

### Token Budget Control

Following the Gemini annotation on the "Context Window Trap":
- Memory notes are **never** bulk-loaded into the system prompt
- The `memory-store.js` exposes `getRelevantNotes(query, limit)` which returns at most `limit` notes (default: 5)
- Relevance is determined by keyword overlap (simple, fast, no embeddings needed initially)
- Total injected memory context is hard-capped at 2000 tokens (configurable)

---

## Phase 2 — Reinforcement via Verifiable Rewards

**Goal**: When the Verifier (or any automated check) produces a pass/fail signal, capture structured telemetry and optionally trigger a Reflection pass to update skills/memory.

### Architecture

```
Action Execution
       │
       ▼
   Verifier (exit code)
       │
  ┌────┴────┐
  │         │
  ▼         ▼
exit=0    exit>0
  │         │
  ▼         ▼
Positive   Negative
Telemetry  Telemetry
  │         │
  ▼         ▼
Memory     Reflection
(episodic  Agent
 note)     (Meta-Analyst)
              │
              ▼
           Skill Update
           or Memory Note
```

### Telemetry Payload Schema

```json
{
  "timestamp": "2026-03-11T...",
  "taskId": "task-<ulid>",
  "task": "Description of what was attempted",
  "phase": "execution|validation|reflection",
  "outcome": "success|failure",
  "actions": [{"type": "click_element", "text": "Submit"}],
  "verifier": {
    "exitCode": 1,
    "stderr": "Element not found: Submit",
    "stdout": ""
  },
  "context": {
    "activeWindow": "Edge - Google",
    "processName": "msedge.exe"
  }
}
```

### New Files

| File | Purpose |
|------|---------|
| `src/main/telemetry/telemetry-writer.js` | Appends telemetry payloads to `~/.liku/telemetry/logs/` as JSONL files |
| `src/main/telemetry/reflection-trigger.js` | Evaluates failure telemetry, decides whether to invoke a Reflection pass |

### Integration Points

| Existing Module | Change |
|----------------|--------|
| `src/main/system-automation.js` → `executeAction()` / `executeActionSequence()` | After action execution, write success/failure telemetry |
| `src/main/preferences.js` → `recordAutoRunOutcome()` | Already tracks auto-run success/failure with demotion logic; extend to also write telemetry |
| Hook: `SubagentStop` (`subagent-quality-gate.ps1`) | Can read latest telemetry to inform quality gate decisions |

### Reasoning Model Constraint (Critical — from Gemini Annotation 2)

The brainstorm proposes `PHASE_PARAMS` with `{ temperature: 0.1, top_p: 0.1 }` for execution phase and higher values for reflection. **This must respect reasoning model constraints:**

```javascript
// src/main/ai-service/providers/phase-params.js (NEW)
const PHASE_PARAMS = {
  execution:  { temperature: 0.1, top_p: 0.1 },
  planning:   { temperature: 0.4, top_p: 0.6 },
  reflection: { temperature: 0.7, top_p: 0.8 }
};

function getPhaseParams(phase, modelCapabilities) {
  const params = { ...(PHASE_PARAMS[phase] || PHASE_PARAMS.execution) };
  
  // STRICT: Reasoning models (o1, o3-mini) reject temperature/top_p/top_k
  if (modelCapabilities && modelCapabilities.reasoning) {
    delete params.temperature;
    delete params.top_p;
    delete params.top_k;
  }
  
  return params;
}

module.exports = { PHASE_PARAMS, getPhaseParams };
```

**Integration**: `orchestration.js` → `requestWithFallback()` uses `getPhaseParams()` when a phase is specified in the routing context.

### Reflection Agent

The Reflection Agent is **not** a new VS Code agent file. It is a **prompt-driven pass** within the existing AI service: when a failure telemetry payload triggers reflection, `sendMessage()` is called with a special system prompt that includes the failure context and asks the model to:
1. Analyze the root cause
2. Propose a skill update or new negative policy
3. Return structured JSON that the caller parses

This keeps the agent system unchanged while adding a cognitive loop.

---

## Phase 3 — Dynamic Tool Generation

**Goal**: Allow the AI to propose new tool scripts that extend Liku's capabilities, executed safely in a VM sandbox.

### Security Model (Critical — from Gemini Annotation 3)

**NEVER use `require()` to execute AI-generated code.** All dynamic tools run in `vm.createContext()` with:

1. **Explicit allowlist** of available APIs (no `fs`, no `child_process`, no `require`)
2. **5-second timeout** (prevents infinite loops)
3. **Result extraction** via a `result` variable in the sandbox context
4. **Hook enforcement** — `PreToolUse` hook fires before any dynamic tool execution

### Architecture

```
AI proposes tool
       │
       ▼
   Tool Validator
   (schema check, no banned patterns)
       │
       ▼
   Write to ~/.liku/tools/dynamic/<name>.js
       │
       ▼
   Register in ~/.liku/tools/registry.json
       │
       ▼
   On invocation:
   PreToolUse hook → Sandbox execution → Result
```

### New Files

| File | Purpose |
|------|---------|
| `src/main/tools/sandbox.js` | `executeDynamicTool(toolPath, args)` — VM sandbox execution |
| `src/main/tools/tool-validator.js` | Static analysis: reject scripts containing `require`, `import`, `process.exit`, `child_process`, `fs.`, `eval(`, `Function(` |
| `src/main/tools/tool-registry.js` | CRUD for `~/.liku/tools/registry.json`, dynamic tool lookup |

### Sandbox Implementation

```javascript
// src/main/tools/sandbox.js
const vm = require('vm');
const fs = require('fs');

const BANNED_PATTERNS = [
  /\brequire\s*\(/,
  /\bimport\s+/,
  /\bprocess\b/,
  /\bchild_process\b/,
  /\b__dirname\b/,
  /\b__filename\b/,
  /\bglobal\b/,
  /\bglobalThis\b/
];

function validateToolSource(code) {
  for (const pattern of BANNED_PATTERNS) {
    if (pattern.test(code)) {
      throw new Error(`Dynamic tool contains banned pattern: ${pattern}`);
    }
  }
}

function executeDynamicTool(toolPath, args) {
  const code = fs.readFileSync(toolPath, 'utf-8');
  validateToolSource(code);
  
  const sandboxContext = {
    args: Object.freeze({ ...args }),
    console: { log: console.log, warn: console.warn, error: console.error },
    JSON: JSON,
    Math: Math,
    Date: Date,
    Array: Array,
    Object: Object,
    String: String,
    Number: Number,
    RegExp: RegExp,
    result: null
  };

  const context = vm.createContext(sandboxContext);
  const script = new vm.Script(code, { filename: toolPath });
  
  script.runInContext(context, { timeout: 5000 });
  return context.result;
}

module.exports = { executeDynamicTool, validateToolSource, BANNED_PATTERNS };
```

### Tool Registration

Dynamic tools are registered in `~/.liku/tools/registry.json`:

```json
{
  "tools": {
    "calculate-shipping": {
      "file": "dynamic/calculate-shipping.js",
      "description": "Calculate shipping cost given weight and destination",
      "parameters": { "weight": "number", "destination": "string" },
      "createdBy": "ai",
      "createdAt": "2026-03-11T...",
      "invocations": 0,
      "lastInvokedAt": null
    }
  }
}
```

### Integration with Existing Tool System

| Existing Module | Change |
|----------------|--------|
| `src/main/ai-service/providers/copilot/tools.js` | `LIKU_TOOLS` remains static. Dynamic tools are appended at runtime when building tool definitions for the API call, read from `tool-registry.js` |
| `src/main/ai-service/providers/copilot/tools.js` → `toolCallsToActions()` | Add a `default` case that checks the dynamic tool registry before returning a raw action |
| Hook: `PreToolUse` (`security-check.ps1`) | Can inspect the tool name; if it starts with `dynamic/`, apply additional scrutiny |

### Phased Rollout

Dynamic tool generation is the **highest-risk** feature. Rollout order:
1. **Phase 3a**: Sandbox execution + static validation only (no AI generation yet)
2. **Phase 3b**: AI can *propose* tools, but they require explicit user approval before registration
3. **Phase 3c**: Auto-registration for tools that pass validation + hook approval (future)

---

## Phase 4 — Semantic Skill Router

**Goal**: Prevent context window bloat by loading only relevant skills into the system prompt.

### Problem Statement (Gemini Annotation 1)

If Liku accumulates 50+ skill files and blindly appends them all to the system prompt:
- Token budget consumed by stale/irrelevant skills
- "Lost in the Middle" phenomenon dilutes model focus
- Latency increases linearly with prompt size

### Solution: Lightweight Index + On-Demand Injection

```
User message arrives
       │
       ▼
  Skill Router
  (keyword match against index.json)
       │
       ▼
  Load only matching skill(s) content
       │
       ▼
  Inject into system prompt
  (hard cap: 3 skills, 1500 tokens total)
       │
       ▼
  Normal AI service flow
```

### New Files

| File | Purpose |
|------|---------|
| `src/main/memory/skill-router.js` | `getRelevantSkillsContext(userMessage, limit)` — keyword-based skill selection |

### Skill Index Schema (`~/.liku/skills/index.json`)

```json
{
  "navigate-edge-tabs": {
    "file": "navigate-edge-tabs.md",
    "keywords": ["edge", "browser", "tab", "navigate", "url"],
    "tags": ["automation", "browser"],
    "lastUsed": "2026-03-11T...",
    "useCount": 5
  }
}
```

### Integration

| Existing Module | Change |
|----------------|--------|
| `src/main/ai-service/system-prompt.js` | No change to `SYSTEM_PROMPT` constant. The caller (message-builder or sendMessage) appends skill context |
| `src/main/ai-service/message-builder.js` | `createMessageBuilder()` gains an optional `skillsContext` parameter that, if provided, appends to the system message |
| `src/main/ai-service.js` → `sendMessage()` | Before building messages, call `getRelevantSkillsContext(userInput)` and pass result to message builder |

### Future Enhancement (Not Phase 4)

Replace keyword matching with embedding-based cosine similarity when/if a local embedding model (Ollama) is available. The interface (`getRelevantSkillsContext(query, limit)`) stays identical.

---

## Cross-Cutting Concerns

### 1. Migration Safety (Gemini Annotation 4)

All file migrations use **copy, not move**. The old `~/.liku-cli/` directory is never deleted programmatically. Users can clean it up manually after confirming `~/.liku/` works.

### 2. Reasoning Model Parameter Stripping (Gemini Annotation 2)

Any code path that sends `temperature`, `top_p`, or `top_k` to the Copilot API must check `modelCapabilities.reasoning` first and strip those parameters. This applies to:
- `PHASE_PARAMS` in the new `phase-params.js`
- Any future reflection/planning calls
- The existing `orchestration.js` does not currently send these params, so no existing code breaks

### 3. Hook Enforcement for New Behaviors

| New Behavior | Hook Gate |
|-------------|-----------|
| Dynamic tool execution | `PreToolUse` — security-check.ps1 can inspect tool name |
| Memory write | No hook needed (local disk, no side effects) |
| Reflection pass | `PostToolUse` — audit-log.ps1 records reflection outcomes |
| Skill creation | `PreToolUse` if triggered by AI; no hook if user-initiated |

### 4. Conversation History Compatibility

The existing `conversation-history.js` is untouched. Memory notes are a **parallel** system:
- Conversation history = short-term context (last N messages)
- Memory notes = long-term knowledge (persists across sessions)
- Skills = reusable procedures (loaded on demand)

### 5. No `fs-extra` Dependency

The brainstorm uses `fs-extra` (`fs.ensureDirSync`, `fs.readJsonSync`, `fs.copySync`). The codebase currently uses only Node.js built-in `fs`. To avoid adding a dependency:
- Use `fs.mkdirSync(path, { recursive: true })` instead of `fs.ensureDirSync`
- Use `JSON.parse(fs.readFileSync(...))` instead of `fs.readJsonSync`
- Use `fs.copyFileSync` instead of `fs.copySync`

---

## Dependency Graph

```
Phase 0: ~/.liku/ Structure ✅
    │
    ├──▶ Phase 1: Agentic Memory ✅
    │        │
    │        ├──▶ Phase 2: RLVR Telemetry + Reflection ✅
    │        │        │
    │        │        ├──▶ Phase 3: Dynamic Tool Generation ✅
    │        │        │        │
    │        │        │        ├──▶ Phase 9: Sandbox hardening (fork), Proposal flow ✅
    │        │        │        │        │
    │        │        │        │        └──▶ Phase 10 (N3): E2E smoke test ✅
    │        │        │        │
    │        │        │        └──▶ (future) N2: Auto-registration Phase 3c
    │        │        │
    │        │        └──▶ Phase 13 (N6): Cross-model reflection ✅
    │        │
    │        ├──▶ Phase 4: Semantic Skill Router ✅
    │        │        │
    │        │        ├──▶ Phase 9: BPE token counting ✅
    │        │        │
    │        │        ├──▶ Phase 11 (N1-T2): TF-IDF scoring ✅
    │        │        │        │
    │        │        │        └──▶ (future) N1-T3: Ollama embeddings
    │        │        │
    │        │        └──▶ Phase 12 (N4): Session persistence ✅
    │        │
    │        └──▶ Phase 14 (N5): Analytics CLI ✅
    │
    ├──▶ Phase 5: Deep Integration (prompts, commands, wiring) ✅
    │
    ├──▶ Phase 6–7: Safety + AWM + Hooks ✅
    │
    ├──▶ Phase 8: Audit fixes ✅
    │
    └──▶ (independent) advancingFeatures.md Phases 0–4
         (vision/overlay/coordinate hardening)
```

All phases are complete. Phases 5–9 were implemented across commits `461ce31` → `bc27d62` → `f1fa1a6` → `8aefc19`.

---

## Risk Register

| # | Risk | Impact | Mitigation | Status |
|---|------|--------|------------|--------|
| R1 | AI-generated tool executes destructive code | CRITICAL | `child_process.fork()` sandbox with no shared memory, minimal env, `SIGKILL` on timeout, `vm.createContext` allowlist in worker, banned pattern static validation, PreToolUse hook gate | ✅ Mitigated (Phase 9) |
| R2 | Context window bloat from memory/skills | HIGH | BPE token counting via `js-tiktoken` (cl100k_base), hard caps (2000 tokens memory, 1500 tokens skills), keyword-based selection, limit=5 notes | ✅ Mitigated (Phase 9) |
| R3 | Reasoning model API errors from temperature params | HIGH | `getPhaseParams()` strips all generation params for reasoning models | ✅ Mitigated (Phase 2) |
| R4 | Migration corrupts user data | MEDIUM | Copy-not-move strategy, old directory preserved | ✅ Mitigated (Phase 0) |
| R5 | Reflection loop doesn't converge | MEDIUM | Max 2 reflection passes per task (`MAX_REFLECTION_ITERATIONS`), session failure decay on success | ✅ Mitigated (Phase 6) |
| R6 | Dynamic tool sandbox bypass via prototype pollution | MEDIUM | Process-level isolation via `child_process.fork()` — VM escape only compromises short-lived worker. `Object.freeze` on args, allowlist of safe globals in worker | ✅ Mitigated (Phase 9) |
| R7 | Skill index grows stale (files deleted but index retained) | LOW | `loadIndex()` prunes stale entries via `fs.existsSync` check on every load | ✅ Mitigated (Phase 8) |
| R8 | Memory JSONL files grow unbounded | LOW | Telemetry logs rotate at 10MB (`MAX_LOG_SIZE`); memory notes pruned by LRU when > 500 (`MAX_NOTES`) | ✅ Mitigated (Phase 6) |
| R9 | Tool proposals bypass validation | LOW | Quarantine directory (`tools/proposed/`), `proposeTool()` runs `validateToolSource()` before writing, `approveTool()` promotes from quarantine to active | ✅ Mitigated (Phase 9) |

---

## Acceptance Criteria

### Phase 0 — Structured Home Directory ✅ COMPLETE
- [x] `~/.liku/` is created on first run with all subdirectories
- [x] Existing `~/.liku-cli/*.json` files are copied (not moved) to `~/.liku/`
- [x] All existing CLI commands (`liku chat`, `liku click`, etc.) work unchanged
- [x] Electron overlay starts normally with preferences loaded from new path
- [x] `~/.liku-cli/` is not deleted or modified

### Phase 1 — Agentic Memory ✅ COMPLETE
- [x] `memory-store.js` can create/read/update/delete notes
- [x] Notes have structured attributes (type, keywords, tags, links)
- [x] `getRelevantNotes(query, 5)` returns notes matching keyword overlap
- [x] Memory context injected into system prompt is ≤ 2000 BPE tokens (via `js-tiktoken`)
- [x] Multiple sessions share the same memory store (persistence verified)

### Phase 2 — RLVR Telemetry ✅ COMPLETE
- [x] Action execution writes structured telemetry to `~/.liku/telemetry/logs/`
- [x] Failure telemetry triggers reflection pass (with max 2 iterations)
- [x] `PHASE_PARAMS` correctly strips `temperature`/`top_p` for reasoning models
- [x] Reflection output can update memory or propose a preference correction
- [x] Existing `recordAutoRunOutcome()` demotion logic continues to work

### Phase 3 — Dynamic Tool Generation ✅ COMPLETE
- [x] Sandbox executes tool scripts in isolated child process (`child_process.fork`)
- [x] Worker has no access to `fs`, `process`, `require`, or parent memory
- [x] Worker env stripped to `{ NODE_ENV: 'sandbox', PATH }` only
- [x] Scripts exceeding 5-second timeout are terminated via `SIGKILL`
- [x] Scripts containing banned patterns are rejected before execution (16 patterns)
- [x] Dynamic tools appear in tool definitions sent to the API
- [x] `PreToolUse` hook fires before dynamic tool execution
- [x] User approval required for new tool registration (Phase 3b — proposal flow)

### Phase 4 — Semantic Skill Router ✅ COMPLETE
- [x] Skills are loaded from `~/.liku/skills/` via index
- [x] Only matching skills (by keyword with word-boundary regex) are injected into system prompt
- [x] Maximum 3 skills / 1500 BPE tokens injected per request (via `js-tiktoken`)
- [x] Skill index updates use count and last-used timestamp
- [x] Missing skill files (deleted externally) are pruned from index on load

### Phase 5 — Deeper Integration ✅ COMPLETE
- [x] System prompt describes Memory, Skills, Tools, and Reflection capabilities
- [x] `/memory`, `/skills`, `/tools` slash commands registered and functional
- [x] Telemetry wiring in `recordAutoRunOutcome()` with proper schema
- [x] Policy wiring in reflection trigger for negative policy enforcement

### Phase 6 — Safety Hardening ✅ COMPLETE
- [x] `hook-runner.js` invokes PreToolUse and PostToolUse hooks
- [x] Reflection loop bounded at 2 iterations (`MAX_REFLECTION_ITERATIONS`)
- [x] Session failure count decays on success
- [x] Phase params forwarded to all providers (OpenAI/Anthropic/Ollama)
- [x] Memory LRU pruning at 500 notes; telemetry log rotation at 10MB

### Phase 7 — Next-Level Enhancements ✅ COMPLETE
- [x] AWM procedural memory extraction from successful multi-step sequences
- [x] Auto-skill registration from AWM (with PreToolUse hook gate)
- [x] PostToolUse hook wired for dynamic tool audit logging
- [x] Unapproved tools filtered from API tool definitions
- [x] CLI subcommands: `liku memory`, `liku skills`, `liku tools`

### Phase 8 — Audit-Driven Fixes ✅ COMPLETE
- [x] `recordAutoRunOutcome` telemetry uses proper schema (task/phase/outcome)
- [x] Skill index staleness pruning via `fs.existsSync`
- [x] Word-boundary regex for keyword matching
- [x] PreToolUse hook gates AWM skill creation
- [x] PostToolUse audit hook after reflection passes

### Phase 9 — Design-Level Hardening ✅ COMPLETE (commit `8aefc19`)
- [x] BPE token counting via `js-tiktoken` replaces character heuristics
- [x] Proposal→approve→register flow with `tools/proposed/` quarantine
- [x] CLI `proposals` and `reject` subcommands in `liku tools`
- [x] `child_process.fork()` sandbox replaces in-process `vm.createContext`
- [x] `message-builder.js` accepts explicit `skillsContext`/`memoryContext` params
- [x] Dedicated `## Relevant Skills` and `## Working Memory` section headers in prompt

### Phase 10 — N3: E2E Dynamic Tool Smoke Test ✅ COMPLETE (commit `fde64b0`)
- [x] Full pipeline test: proposeTool → quarantine → approveTool → sandbox execute → verify result
- [x] Fibonacci(10) = 55 verified through `child_process.fork()` + `vm.Script`
- [x] Telemetry recorded and verified post-execution
- [x] Registry `invocations` counter incremented
- [x] 17 assertions covering every lifecycle stage

### Phase 11 — N1-T2: TF-IDF Skill Routing ✅ COMPLETE (commit `fde64b0`)
- [x] Pure JS TF-IDF: `tokenize()`, `termFrequency()`, `inverseDocFrequency()`, `tfidfVector()`, `cosineSimilarity()`
- [x] Zero dependencies — maintains zero-native-dep constraint
- [x] Combined scoring: `keywordScore + (tfidfSimilarity × 5)`
- [x] Integrated into `getRelevantSkillsContext()` as Tier 2 scoring
- [x] TF-IDF internals exported for unit testing
- [x] 16 assertions testing tokenizer, TF, IDF, cosine, and integrated routing

### Phase 12 — N4: Session Persistence ✅ COMPLETE (commit `fde64b0`)
- [x] `saveSessionNote()` extracts user messages from recent conversation history
- [x] Top-8 keyword extraction via frequency analysis with stop word removal
- [x] Episodic memory note written via `memoryStore.addNote()`
- [x] Wired into `chat.js` `finally` block — fires on exit/quit/SIGINT

### Phase 13 — N6: Cross-Model Reflection ✅ COMPLETE (commit `fde64b0`)
- [x] `reflectionModelOverride` module variable + getter/setter
- [x] `/rmodel` slash command (set/get/clear)
- [x] Reflection pass uses configured reasoning model instead of default
- [x] Updated `/help` text with `/rmodel` documentation
- [x] 12 assertions testing setter/getter/command integration

### Phase 14 — N5: Analytics CLI ✅ COMPLETE (commit `fde64b0`)
- [x] `liku analytics [--days N] [--raw] [--json]` command
- [x] Success rate, top tasks, phase breakdown, common failures
- [x] Registered in CLI command table
- [x] 3 assertions testing run/showHelp exports

---

## Implementation Order (Actual)

1. **Phase 0** — Structured `~/.liku/` home directory (commit `461ce31`)
2. **Phase 1** — Agentic Memory with Zettelkasten linking (commit `461ce31`)
3. **Phase 2** — RLVR Telemetry + Reflection trigger (commit `461ce31`)
4. **Phase 3** — Dynamic Tool Generation with VM sandbox (commit `461ce31`)
5. **Phase 4** — Semantic Skill Router with keyword matching (commit `461ce31`)
6. **Phase 5** — Deeper Integration — prompt, commands, wiring (commit `461ce31`)
7. **Phase 6** — Safety Hardening — hooks, bounds, decay, pruning (commit `bc27d62`)
8. **Phase 7** — AWM, PostToolUse, CLI, telemetry analytics (commit `bc27d62`)
9. **Phase 8** — Audit-driven fixes from deep gap analysis (commit `f1fa1a6`)
10. **Phase 9** — Design-level hardening from Gemini brainstorm (commit `8aefc19`)
11. **Phase 10** — N3: E2E dynamic tool smoke test (commit `fde64b0`)
12. **Phase 11** — N1-T2: TF-IDF skill routing (commit `fde64b0`)
13. **Phase 12** — N4: Session persistence (commit `fde64b0`)
14. **Phase 13** — N6: Cross-model reflection (commit `fde64b0`)
15. **Phase 14** — N5: Analytics CLI command (commit `fde64b0`)

---

## Relationship to advancingFeatures.md

[advancingFeatures.md](advancingFeatures.md) covers the **perception layer** (vision, overlay, coordinates, UIA patterns, event-driven watcher). This document covers the **cognition layer** (memory, learning, tool creation, context management).

They are complementary and can be developed in parallel:

| Layer | Document | Key Deliverables | Status |
|-------|----------|-----------------|--------|
| Perception | advancingFeatures.md | ROI capture, coordinate contract, pattern-first UIA, event watcher | In progress |
| Cognition | **This document** | Memory, RLVR reflection, dynamic tools, skill routing, sandbox, BPE tokens | ✅ Complete |
| Cognition N+ | **This document** (Next-Stage) | TF-IDF routing, session persistence, cross-model reflection, analytics CLI | ✅ Mostly Complete |

---

## Next-Stage Roadmap

With all 10 phases (0–9) complete, the following items represent the next evolution of the cognitive layer. These are ordered by impact and feasibility.

### N1 — Tiered Skill Routing
**Priority**: HIGH | **Complexity**: MEDIUM | **Status**: ✅ Tier 2 COMPLETE (commit `fde64b0`)

Replace keyword-only matching in `skill-router.js` with a tiered scoring approach that progressively adds semantic capability.

- **Tier 1** (existing): Word-boundary keyword matching (+2/keyword, +1/tag, +0.5 recency). Retained as base layer.
- **Tier 2** (✅ implemented): Pure JS TF-IDF with cosine similarity. Zero dependencies. `tokenize()` → `termFrequency()` → `inverseDocFrequency()` → `tfidfVector()` → `cosineSimilarity()`. Combined score = keyword + (TF-IDF × 5 scaling).
- **Tier 3** (future): Optional Ollama embeddings for local semantic search. Same interface — `getRelevantSkillsContext(query, limit)` stays identical.

**Decision log**: `@xenova/transformers` (80MB WASM) rejected — violates zero-native-dependency constraint. TF-IDF provides synonym-adjacent matching (shared terms score higher) without adding any dependency.

### N2 — Auto-Registration for Hook-Approved Tools (Phase 3c)
**Priority**: MEDIUM | **Complexity**: LOW | **Status**: ❌ NOT YET IMPLEMENTED

Currently, tool proposals require manual `liku tools approve <name>`. Add an auto-registration path for tools that pass:
1. Static validation (existing `validateToolSource()`)
2. Sandbox execution test (new: run tool with sample args, verify output)
3. PreToolUse hook approval (existing hook gate)

Auto-registered tools would have a `status: 'auto-approved'` flag and could be revoked at any time.

### N3 — End-to-End Smoke Test for Dynamic Tools
**Priority**: MEDIUM | **Complexity**: LOW | **Status**: ✅ COMPLETE (commit `fde64b0`)

Phase 10 tests exercise the full pipeline with a Fibonacci tool: `proposeTool()` → quarantine verification → `approveTool()` → promotion to `dynamic/` → `sandbox.executeDynamicTool()` via `child_process.fork()` → verify result (Fibonacci(10) = 55) → `recordInvocation()` → `writeTelemetry()` → verify telemetry entry → cleanup. **17 assertions** covering every lifecycle stage.

### N4 — Persistent Conversation Context (Cross-Session Memory)
**Priority**: MEDIUM | **Complexity**: MEDIUM | **Status**: ✅ COMPLETE (commit `fde64b0`)

Implemented as `saveSessionNote()` in `ai-service.js`. On chat exit, extracts the last 20 conversation entries, filters to user messages, extracts top-8 keywords (frequency-based, with stop word removal), and writes an episodic memory note via `memoryStore.addNote({ type: 'episodic', ... })`. On next session, existing `getRelevantNotes()` picks up relevant session context.

**Decision log**: Simpler approach than proposed `conversation-log.jsonl` — reuses existing memory-store infrastructure instead of adding a parallel persistence layer.

### N5 — Telemetry Analytics Dashboard
**Priority**: LOW | **Complexity**: MEDIUM | **Status**: ✅ COMPLETE (commit `fde64b0`)

New CLI command `liku analytics [--days N] [--raw] [--json]` at `src/cli/commands/analytics.js`. Reads JSONL telemetry for the requested date range and displays:
- Success rate (success/total with percentage)
- Top 10 tasks by frequency
- Phase breakdown
- Top 5 common failure reasons

`--raw` dumps entries as JSONL. `--json` provides machine-readable output.

### N6 — Cross-Model Reflection
**Priority**: LOW | **Complexity**: HIGH | **Status**: ✅ COMPLETE (commit `fde64b0`)

Implemented as same-provider, different-model reflection. The original plan called for multi-provider reflection, but Gemini analysis revealed the auth boundary problem: Copilot-authenticated users only have Copilot tokens, so routing reflection to OpenAI/Anthropic would require separate API keys the user may not have.

**Solution**: `reflectionModelOverride` module variable in `ai-service.js`. When set (e.g., to `o3-mini`), the reflection pass in `requestWithFallback()` uses the specified reasoning model instead of the default chat model. Controlled via `/rmodel` slash command:
- `/rmodel` — show current reflection model
- `/rmodel o3-mini` — set reflection to reasoning model
- `/rmodel off` — clear override (use default)

**Decision log**: Cross-provider rejected in favor of cross-model. Reasoning models (o1, o3-mini) are ideal for reflection because they are better at analytical self-correction than chat-optimized models.
