# Model Prompt Language Reference

> Source of truth for how different LLM families parse and prefer system prompt formats.
> Grounded in testing (2026-02-23) and documented model behaviors.
> Update this file as new models are tested or behaviors change.

---

## Agent-Model Assignments (updated 2026-02-23)
Source: Burke Holland "Ultralight Orchestration" + community routing tests

| Agent | Model | Identifier | Rationale |
|-------|-------|------------|-----------|
| **recursive-builder** | GPT-5.3-Codex | `GPT-5.3-Codex (copilot)` | Routes reliably as subagent, 1x premium, best for code implementation |
| **recursive-verifier** | GPT-5.3-Codex | `GPT-5.3-Codex (copilot)` | Routes reliably, thorough verification |
| **recursive-researcher** | GPT-5.2 | `GPT-5.2 (copilot)` | Routes reliably, strong planning/research. Gemini 3 Pro (Preview) as fallback |
| **recursive-supervisor** | (orchestrator) | Parent model (Claude Opus 4.6) | Delegates only, never implements |

---

## Model Routing (Copilot Infrastructure)

### Verified Identifiers (2026-02-23, updated with community findings)

| Model | Identifier String | Routes as subagent? | Notes |
|-------|-------------------|---------------------|-------|
| GPT-5.2 | `GPT-5.2 (copilot)` | **Yes** — `gpt-5.2 -> gpt-5.2-2025-12-11` | Reliable |
| GPT-5.3-Codex | `GPT-5.3-Codex (copilot)` | **Yes** — 1x premium, reliable | Recommended for coder/builder |
| Gemini 3 Pro (Preview) | `Gemini 3 Pro (Preview) (copilot)` | Needs testing | Burke Holland uses this |
| Claude Opus 4.6 | `Claude Opus 4.6 (copilot)` | **No** — falls to Sonnet/Haiku | Only works via model picker |
| Claude Sonnet 4.5 | `Claude Sonnet 4.5 (copilot)` | **No** — same issue as Opus | Burke recommends for orchestrator only |

### Routing Rules
- `model:` is a **fallback list** — first recognized model wins.
- **CRITICAL VS Code Setting**: `chat.customAgentInSubagent.enabled` MUST be `true` for subagent model routing to work.
- User settings model override can force ALL agents to one model — check and remove any.
- GPT-family models (5.2, 5.3-Codex) route reliably as subagents.
- Claude models do NOT route as subagents — always inherit parent or fall to Haiku.
- Gemini models need `Gemini 3 Pro (Preview) (copilot)` identifier (not `Gemini 2.5 Pro`).
- `shouldContinue=false, reasons=undefined` in stop hook logs = normal successful completion.
- **CRITICAL**: Single-model configs with an unresolvable identifier fall to `gpt-4o-mini`.
- Use `github.copilot.debug.showChatLogView` to confirm actual model routed.

### Identifiers That Don't Resolve
`Gemini 3 (copilot)`, `gemini-3`, `gemini-2.5-pro` (slug), `o3 (copilot)`, `Claude Opus 4.5 (copilot)`.
`Gemini 2.5 Pro (copilot)` — resolves via agent picker but NOT via `runSubagent` (falls back).

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

### Gemini 2.5 Pro (Google) — Flattened hierarchy XML

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
- Gemini 2.5 Pro has a 1M+ token context window — can handle very large system prompts.
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
Based on Burke Holland "Ultralight Orchestration" + community routing tests.
Use GPT-family models for subagents (reliable routing). Orchestrator stays as parent model.

| Agent | Model | Prompt Format |
|-------|-------|---------------|
| recursive-builder | GPT-5.3-Codex | Flattened JSON for instructions, markdown for context |
| recursive-verifier | GPT-5.3-Codex | Flattened JSON for instructions |
| recursive-researcher | GPT-5.2 | Flattened JSON for instructions |

### When orchestrating subagents
The supervisor (or parent agent) should format the prompt payload according to the
target agent's model preference before calling `runSubagent`. Example:

**For builder (GPT-5.2):**
```json
{
  "task": "Implement visual frame schema in src/shared/visual-frame.js",
  "constraints": ["Do not modify existing exports", "Add JSDoc types"],
  "files": ["src/shared/visual-frame.js", "src/main/ai-service.js"],
  "output": "Diffs + rationale + local test proof"
}
```

**For verifier (Claude Opus 4.6):**
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

**For researcher (Gemini 2.5 Pro):**
```xml
<query>How does the current visual context buffer work in ai-service.js?</query>
<scope>
  <file>src/main/ai-service.js</file>
  <file>src/main/visual-awareness.js</file>
  <file>src/main/index.js</file>
</scope>
<deliverable>Structured findings with file citations</deliverable>
```

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
1. Create a pinned single-model `.agent.md` with `user-invocable: false`.
2. Invoke via `runSubagent` AND via agent picker separately.
3. Check `Output > GitHub Copilot Chat` for the routing log line:
   - Success: `model-slug -> model-deployment-id`
   - Failure: `model deployment ID: []` (empty = fell back to default)
4. Ask the agent to self-identify (reliable for GPT, unreliable for Claude).
5. Clean up test files after verification.
