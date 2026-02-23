# Model Prompt Language Reference

> Source of truth for how different LLM families parse and prefer system prompt formats.
> Grounded in testing (2026-02-23) and documented model behaviors.
> Update this file as new models are tested or behaviors change.

---

## Model Routing (Copilot Infrastructure)

### Verified Identifiers (2026-02-23)

| Model | Identifier String | Works in `model:` field? | Works via `runSubagent`? |
|-------|-------------------|--------------------------|--------------------------|
| GPT-5.2 | `GPT-5.2 (copilot)` | Yes — `gpt-5.2 -> gpt-5.2-2025-12-11` | Yes (distinct routing) |
| Gemini 2.5 Pro | `Gemini 2.5 Pro (copilot)` | Yes (self-identified when pinned) | Inherits parent model |
| Claude Opus 4.6 | `Claude Opus 4.6 (copilot)` | Yes (generic path, empty deployment ID) | Inherits parent model |

### Routing Rules
- `model:` is a **fallback list** — first recognized model wins.
- `runSubagent` inherits the parent conversation's model for most providers.
  GPT-5.2 is the exception: it routes independently even from subagent calls.
- To force a specific model: use the VS Code agent picker (user-invoked), not `runSubagent`.
- `shouldContinue=false, reasons=undefined` in stop hook logs = normal successful completion.

### Identifiers That Don't Resolve
`Gemini 3 (copilot)`, `gemini-3`, `gemini-2.5-pro` (slug), `o3 (copilot)`, `Claude Opus 4.5 (copilot)`.

---

## Prompt Format Preferences by Model Family

### Claude (Anthropic) — XML-first

**Preferred format:** XML tags for structure, markdown for content within tags.

```xml
<instructions>
  <role>You are a Windows automation specialist.</role>
  <constraints>
    <constraint>Never modify files outside src/</constraint>
    <constraint>Always verify with tests before reporting done</constraint>
  </constraints>
  <task>
    <step number="1">Read the target module</step>
    <step number="2">Implement the change</step>
  </task>
</instructions>
```

**Why:** Claude's training heavily weights XML tag boundaries for instruction following.
Nested XML creates clear hierarchical scopes that Claude respects for priority and override.

**Behavior notes:**
- XML tags act as **hard boundaries** — Claude rarely bleeds context across tags.
- `<important>` and `<critical>` tags receive elevated attention.
- Closing tags matter: unclosed tags degrade instruction adherence.
- Markdown headers inside XML work well for sub-structure.
- Claude will NOT self-identify its model name (policy restriction).
- Claude handles very long system prompts well (200K context).

**Anti-patterns:**
- Deeply nested JSON in system prompts — Claude parses it but doesn't weight keys as instructions.
- Bare numbered lists without structural tags — lower adherence for complex multi-step tasks.

---

### GPT (OpenAI) — Markdown-first

**Preferred format:** Markdown with headers, bullet lists, and bold emphasis.

```markdown
# Role
You are a Windows automation specialist.

# Constraints
- **Never** modify files outside `src/`
- **Always** verify with tests before reporting done

# Task
1. Read the target module
2. Implement the change
```

**Why:** GPT models are trained on massive markdown corpora (GitHub, docs, web).
Markdown headers create natural section boundaries that GPT uses for retrieval within the prompt.

**Behavior notes:**
- `**bold**` and `# Headers` act as attention anchors — GPT weights them higher.
- Numbered lists are treated as sequential instructions with implicit ordering.
- GPT-5.2 self-identifies its model name when asked directly.
- JSON in system prompts works well for structured data/schemas (GPT has strong JSON mode).
- System message vs user message distinction matters: instructions in system message have higher priority.
- GPT handles function/tool schemas natively as JSON — no need to describe tools in prose.

**Anti-patterns:**
- XML tags — GPT treats them as literal text rather than structural boundaries.
- Overly long system prompts without clear headers — GPT's attention drifts in unstructured walls of text.

---

### Gemini (Google) — Structured text / hybrid

**Preferred format:** Markdown with clear sections. Also handles JSON schemas well.

```markdown
## Role
You are a Windows automation specialist.

## Rules
* Never modify files outside src/
* Always verify with tests before reporting done

## Steps
1. Read the target module
2. Implement the change
```

**Why:** Gemini is trained on diverse web content and Google's internal structured formats.
It has strong JSON understanding from Vertex AI tool-use training.

**Behavior notes:**
- Markdown headers and bullet points work reliably.
- JSON schemas for tool definitions are handled natively and precisely.
- Gemini has weaker XML boundary parsing than Claude — XML works but doesn't add the same structural benefit.
- Gemini excels at interleaved multimodal (text + image) prompts.
- For code generation, Gemini prefers explicit language tags in fenced code blocks.
- Gemini 2.5 Pro has a 1M+ token context window — can handle very large system prompts.

**Anti-patterns:**
- Relying on XML nesting for priority — Gemini may flatten the hierarchy.
- Very long unstructured prose — same drift issue as GPT but more pronounced.

---

## Cross-Model Compatibility Format

When writing agent instructions that must work across all three families (e.g., in `.agent.md` files
where the model may vary), use this hybrid format:

```markdown
# Section Title                          ← Markdown header (works everywhere)

<constraints>                            ← XML tag (Claude gets structure, others get visual boundary)
- **Constraint one** in markdown         ← Bold emphasis (GPT/Gemini weight it, Claude respects it)
- **Constraint two**
</constraints>

## Steps                                 ← Markdown header for sequencing
1. First step with `code references`     ← Backtick code spans work universally
2. Second step
```

### Priority escalation (cross-model)
```markdown
<critical>
**IMPORTANT**: This rule overrides all other instructions.
</critical>
```
- Claude: XML `<critical>` tag elevates priority.
- GPT: `**IMPORTANT**` bold keyword elevates priority.
- Gemini: Both signals are recognized but work additively.

---

## Practical Implications for Copilot-Liku Agents

### Current agent files use: Markdown
This is acceptable since Copilot subagents currently inherit the parent model (Claude Opus 4.6),
which handles markdown fine. If routing is fixed in the future:

### Recommended migration
1. **Wrap operating contracts in XML tags** — benefits Claude, neutral for others.
2. **Keep workflow steps as numbered markdown** — universal.
3. **Use bold for constraints** — universal attention signal.
4. **Tool schemas stay as JSON** — all models handle this natively.
5. **Use the hybrid format above** for any instruction that must survive model switching.

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
