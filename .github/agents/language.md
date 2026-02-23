# Model Prompt Language Reference

> Source of truth for how different LLM families parse and prefer system prompt formats.
> Grounded in testing (2026-02-23) and documented model behaviors.
> Update this file as new models are tested or behaviors change.

---

## Agent-Model Assignments (updated 2026-02-23)
Source: Burke Holland "Ultralight Orchestration" + community routing tests + VS Code subagents docs

| Agent | Declared Model(s) | Actual Runtime Model | user-invokable | Role |
|-------|-------------------|---------------------|----------------|------|
| **recursive-builder** | `['GPT-5.2 (copilot)', 'GPT-5.3-codex (copilot)']` | Parent (Claude Opus 4.6)* | `false` | Code implementation |
| **recursive-verifier** | `['GPT-5.2 (copilot)', 'GPT-5.3-codex (copilot)']` | Parent (Claude Opus 4.6)* | `false` | Verification pipeline |
| **recursive-researcher** | `['GPT-5.2 (copilot)', 'Gemini 3.1 Pro (Preview) (copilot)']` | Parent (Claude Opus 4.6)* | `false` | Context gathering (RLC) |
| **recursive-supervisor** | (none — inherits picker) | Parent (Claude Opus 4.6) | `true` | Orchestrator, delegates only |

\* `model:` field is declared for future-proofing but **not honored** by `runSubagent` as of 2026-02-23.
When VS Code ships the `agent` tool, these declarations will take effect.

---

## Model Routing (Copilot Infrastructure)

### Verified Identifiers (2026-02-23)

| Model | Identifier String | Via model picker? | Via `runSubagent`? | Notes |
|-------|-------------------|-------------------|-------------------|-------|
| GPT-5.2 | `GPT-5.2 (copilot)` | Yes | **Ignored** — inherits parent | `gpt-5.2 -> gpt-5.2-2025-12-11` |
| GPT-5.3-Codex | `GPT-5.3-codex (copilot)` | Yes | **Ignored** — inherits parent | 1x premium, lowercase 'c' in identifier |
| Gemini 3.1 Pro (Preview) | `Gemini 3.1 Pro (Preview) (copilot)` | Yes | **Ignored** — inherits parent | Burke Holland uses this |
| Claude Opus 4.6 | `Claude Opus 4.6 (copilot)` | Yes | **Ignored** — inherits parent | Falls to Sonnet/Haiku if set as subagent model |
| Claude Sonnet 4.5 | `Claude Sonnet 4.5 (copilot)` | Yes | **Ignored** — inherits parent | Burke recommends for orchestrator only |

### Routing Rules (Definitive — tested 2026-02-23)

**The fundamental constraint**: `runSubagent` has NO model parameter. It accepts only `agentName` + `prompt`. All subagents inherit the parent's model regardless of `model:` frontmatter.

- `model:` in YAML is a **declared preference**, not an enforced override (via `runSubagent`).
- `model:` DOES work when agent is invoked via the **model picker** (user-initiated).
- `agents:` allowlist in frontmatter is NOT enforced — `runSubagent` accepts any `agentName` string.
- The `agent` tool alias in frontmatter doesn't map to a callable tool yet in VS Code Insiders.
- `handoffs.model` is for interactive UI buttons only, not programmatic dispatch.
- **CRITICAL VS Code Settings**:
  - `chat.customAgentInSubagent.enabled: true` — allows custom agents as subagents
  - `chat.useNestedAgentsMdFiles: true` — loads `.agent.md` files for subagents
  - `chat.agent.maxRequests: 5000` — prevents premature request limits
- `shouldContinue=false, reasons=undefined` in stop hook logs = normal successful completion.
- **CRITICAL**: Single-model configs with an unresolvable identifier fall to `gpt-4o-mini`.
- Use `github.copilot.debug.showChatLogView` to confirm actual model routed.
- What IS loaded: agent instructions, tools restrictions, description, handoff labels.

### Identifiers That Don't Resolve
`Gemini 3 (copilot)`, `gemini-3`, `gemini-2.5-pro` (slug), `o3 (copilot)`, `Claude Opus 4.5 (copilot)`.
`Gemini 2.5 Pro (copilot)` — resolves via agent picker but NOT via `runSubagent` (falls back).

---

## VS Code Subagents Architecture (from official docs 2026-02-23)

Source: https://code.visualstudio.com/docs/copilot/agents/subagents

### How it works
- Subagents are **synchronous** — main agent blocks until subagent returns.
- Each subagent runs in its **own context window** (no shared history with parent).
- Subagents receive only the task prompt — they do NOT inherit parent instructions or conversation.
- Only the **final result summary** is returned to the parent (not intermediate tool calls).
- VS Code can spawn **multiple subagents in parallel** for concurrent analysis.

### Canonical coordinator-worker pattern
```yaml
# Coordinator (supervisor):
name: Feature Builder
tools: ['agent', 'edit', 'search', 'read']  # 'agent' enables subagent dispatch
agents: ['Planner', 'Implementer', 'Reviewer']  # allowlist

# Worker (subagent-only):
name: Implementer
user-invokable: false  # hidden from picker
model: ['Claude Haiku 4.5 (copilot)', 'Gemini 3 Flash (Preview) (copilot)']
tools: ['read', 'edit']  # narrower tool access
```

### Key frontmatter properties
| Property | Purpose | Default |
|----------|---------|--------|
| `tools: ['agent']` | Enables subagent dispatch from this agent | not included |
| `agents: ['name1']` | Restricts which subagents can be used | `*` (all) |
| `agents: []` | Prevents any subagent use | — |
| `user-invokable: false` | Hidden from picker, subagent-only | `true` |
| `disable-model-invocation: true` | Prevents auto-invocation as subagent | `false` |
| `model: [list]` | Model preference (fallback list) | inherits parent |

### Override hierarchy
- Explicitly listing an agent in `agents:` array **overrides** `disable-model-invocation: true`.
- Custom agent `model:` / `tools:` / instructions **override** parent defaults when used as subagent.
- Subagents do NOT inherit parent's instructions or conversation history.

### Current limitation (VS Code Insiders 2026-02-23)
The `agent` tool alias in frontmatter does not map to a callable runtime tool.
`runSubagent` is the only dispatch mechanism and it has no `model` parameter.
All declared properties (model, agents allowlist) are **loaded but not enforced**
at the dispatch level. They will take effect when VS Code ships the native `agent` tool.

---

## Prompt Format Preferences by Model Family

### GPT-5.2 (OpenAI) — Flattened JSON instructions

**Preferred format:** Flattened JSON for structured instructions; markdown for prose context.

```json
{
  "role": "Windows automation specialist",
  "constraints": [
    "Never modify files outside src/",
    "Always verify with tests before reporting done"
  ],
  "task": [
    "Read the target module",
    "Implement the change"
  ],
  "output": "Markdown diffs + rationale"
}
```

**Why (experience-grounded):** GPT-5.2 processes flattened JSON with near-zero ambiguity.
Its function-calling and structured outputs are JSON-native. JSON keys map directly to
how GPT internally represents tool definitions and instruction hierarchies.

**Behavior notes:**
- Flattened JSON (no deep nesting) is parsed as first-class instructions, not data.
- `**bold**` and `# Headers` in markdown prose act as attention anchors.
- Numbered lists are treated as sequential instructions with implicit ordering.
- GPT-5.2 self-identifies its model name when asked directly.
- System message vs user message distinction matters: system message has higher priority.
- Handles function/tool schemas natively as JSON — no need to describe tools in prose.

**Anti-patterns:**
- XML tags — GPT treats them as literal text content, not structural boundaries.
- Deeply nested JSON (>3 levels) — attention degrades; keep it flat.
- Overly long unstructured prose without clear headers or JSON keys.

---

### Claude Opus 4.6 (Anthropic) — Flattened hierarchy XML

**Preferred format:** Flattened hierarchy XML tags for structure, markdown for content within tags.

```xml
<instructions>
  <role>Windows automation specialist</role>
  <constraints>
    <item>Never modify files outside src/</item>
    <item>Always verify with tests before reporting done</item>
  </constraints>
  <task>
    <step number="1">Read the target module</step>
    <step number="2">Implement the change</step>
  </task>
  <output>Markdown diffs + rationale</output>
</instructions>
```

**Why (experience-grounded):** Claude's training heavily weights XML tag boundaries for
instruction following. Flattened XML (shallow nesting, explicit tags) creates clear
hierarchical scopes that Claude respects for priority and override.

**Behavior notes:**
- XML tags act as **hard boundaries** — Claude rarely bleeds context across tags.
- `<important>` and `<critical>` tags receive elevated attention.
- Closing tags matter: unclosed tags degrade instruction adherence.
- "Flattened hierarchy" means: keep nesting ≤2-3 levels, use descriptive tag names.
- Claude handles very long system prompts well (200K context).
- Claude will NOT self-identify its model name (policy restriction).

**Anti-patterns:**
- Deeply nested JSON in system prompts — Claude parses it but doesn't weight keys as instructions.
- Bare numbered lists without structural tags — lower adherence for complex multi-step tasks.

---

### Gemini 3.1 Pro (Google) — Flattened hierarchy XML

**Preferred format:** Flattened hierarchy XML for agent instructions; markdown for conversational content.

```xml
<instructions>
  <role>Windows automation specialist</role>
  <rules>
    <rule>Never modify files outside src/</rule>
    <rule>Always verify with tests before reporting done</rule>
  </rules>
  <steps>
    <step>Read the target module</step>
    <step>Implement the change</step>
  </steps>
</instructions>
```

**Why (experience-grounded):** Despite Google's documentation leaning markdown, practical
experience shows Gemini handles flattened XML well for *agent-style instructions* —
likely because its training data includes heavy XML/HTML web content. XML gives Gemini
clearer instruction boundaries than bare markdown headers for structured multi-step tasks.

**Behavior notes:**
- Flattened XML provides clearer boundaries than markdown for agent instructions.
- JSON schemas for tool definitions are also handled natively and precisely.
- Gemini excels at interleaved multimodal (text + image) prompts.
- For code generation, prefers explicit language tags in fenced code blocks.
- Gemini 3.1 Pro has a 1M+ token context window — can handle very large system prompts.
- Keep XML nesting shallow (≤2 levels) — Gemini may flatten deeper hierarchies.

**Anti-patterns:**
- Relying on deep XML nesting for priority — Gemini flattens it internally.
- Very long unstructured prose — attention drift is more pronounced than other models.

---

## Cross-Model Compatibility Format

When the agent's model assignment may change, or when writing shared prompt templates,
use this format that works across all three:

```xml
<instructions>
  <role>Your role description</role>
  <constraints>
    <item>**Constraint one** in bold for GPT attention</item>
    <item>**Constraint two**</item>
  </constraints>
</instructions>

## Steps
1. First step with `code references`
2. Second step
```

**Why this works for all three:**
- GPT-5.2: Reads `<instructions>` as visual boundary, `**bold**` as attention anchor, numbered steps as sequence.
- Claude: Reads `<instructions>` as hard structural boundary with priority scoping.
- Gemini: Reads `<instructions>` as XML boundary (trained on web HTML/XML), numbered steps as sequence.

### Priority escalation (cross-model)
```xml
<critical>
  <item>**IMPORTANT**: This rule overrides all other instructions.</item>
</critical>
```
- Claude: `<critical>` tag elevates priority.
- GPT: `**IMPORTANT**` bold keyword elevates priority.
- Gemini: Both signals are recognized and work additively.

---

## Practical Implications for Copilot-Liku Agents

### Current assignment strategy (updated 2026-02-23)
All subagents currently run on the **parent model** (Claude Opus 4.6) due to `runSubagent` limitations.
`model:` is declared in `.agent.md` files for future-proofing when VS Code ships native `agent` tool dispatch.

| Agent | Declared Model | Runtime Model | Prompt Format |
|-------|---------------|---------------|---------------|
| recursive-supervisor | (parent) | Claude Opus 4.6 | XML (Claude-native) |
| recursive-builder | GPT-5.2 → GPT-5.3-codex | Claude Opus 4.6* | XML (Claude-native)* |
| recursive-verifier | GPT-5.2 → GPT-5.3-codex | Claude Opus 4.6* | XML (Claude-native)* |
| recursive-researcher | GPT-5.2 → Gemini 3.1 Pro | Claude Opus 4.6* | XML (Claude-native)* |

\* Until model routing works, format prompts for the **actual runtime model** (Claude), not the declared model.

### When orchestrating subagents
Since all subagents currently inherit the parent model (Claude Opus 4.6), format ALL
prompts using **Claude-optimized XML**. When model routing ships, switch to per-model formats.

**For builder** (runtime: Claude Opus 4.6):
```xml
<task>Implement visual frame schema in src/shared/visual-frame.js</task>
<constraints>
  <item>Do not modify existing exports</item>
  <item>Add JSDoc types</item>
</constraints>
<scope>
  <file>src/shared/visual-frame.js</file>
  <file>src/main/ai-service.js</file>
</scope>
<output>Diffs + rationale + local test proof</output>
```

**For verifier** (runtime: Claude Opus 4.6):
```xml
<task>Verify the visual frame schema implementation</task>
<scope>
  <file>src/shared/visual-frame.js</file>
  <file>src/main/ai-service.js</file>
</scope>
<checks>
  <check>Schema matches advancingFeatures.md Phase 0 item 1</check>
  <check>No existing exports broken</check>
  <check>Types are consistent</check>
</checks>
```

**For researcher** (runtime: Claude Opus 4.6):
```xml
<task>How does the current visual context buffer work in ai-service.js?</task>
<scope>
  <file>src/main/ai-service.js</file>
  <file>src/main/visual-awareness.js</file>
  <file>src/main/index.js</file>
</scope>
<deliverable>Structured findings with file citations</deliverable>
```

**Future: when model routing ships**, switch builder/verifier prompts to JSON (GPT-native)
and researcher to XML or JSON depending on which model wins the fallback list.

### For multimodal prompts (advancingFeatures Phase 0)
- All three models support interleaved text + base64 images.
- Message format differs per provider (already handled in `ai-service.js`):
  - **OpenAI**: `{ type: "image_url", image_url: { url, detail } }`
  - **Anthropic**: `{ type: "image", source: { type: "base64", media_type, data } }`
  - **Gemini**: `{ inlineData: { mimeType, data } }` (via Vertex) or `images: [base64]` (via Ollama)
- Image placement in message array matters: place images **before** the text query for best results
  across all models.

---

## Testing Methodology

To verify model routing for new identifiers:
1. Create a pinned single-model `.agent.md` with `user-invokable: false`.
2. Invoke via `runSubagent` AND via agent picker separately.
3. Check `Output > GitHub Copilot Chat` for the routing log line:
   - Success: `model-slug -> model-deployment-id`
   - Failure: `model deployment ID: []` (empty = fell back to default)
4. Ask the agent to self-identify (reliable for GPT, unreliable for Claude).
5. Clean up test files after verification.

### What to verify when testing subagent configuration
| What | How to verify | Tool |
|------|--------------|------|
| Agent instructions loaded | Ask agent to describe its role | `runSubagent` |
| Tools restrictions applied | Ask agent to use a tool not in its list | `runSubagent` |
| `agents:` allowlist enforced | Try dispatching unlisted agent | Manual test |
| `model:` override working | Ask agent to self-identify model | `runSubagent` |
| `user-invokable: false` | Check agent does not appear in picker | VS Code UI |
| Handoff buttons rendered | Check chat UI for handoff labels | VS Code UI |
| Parallel subagents | Prompt for simultaneous analysis | Natural language |

### Known test results (2026-02-23)
- `model:` → **NOT enforced** via `runSubagent` (all agents report Claude Opus 4.6)
- Agent instructions → **Loaded and followed** (agents describe their roles correctly)
- `agents:` allowlist → **NOT enforced** (`runSubagent` accepts any agentName string)
- `agent` tool → **NOT available** as callable tool in VS Code Insiders runtime
- `user-invokable: false` → **Works** (agents hidden from picker)
- Handoff buttons → **Rendered** in VS Code chat UI
