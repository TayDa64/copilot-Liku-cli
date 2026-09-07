# Configuration Guide

This guide covers the configurable aspects of Copilot-Liku CLI — the multi-provider AI service, Electron overlay/chat, automation behavior, and preferences system.

## AI Service Configuration

### Provider Selection

Liku supports multiple AI providers. Set the active provider via environment variable or slash command:

```bash
# Environment variable
export COPILOT_PROVIDER=copilot  # copilot | openai | anthropic | ollama

# In liku chat or Electron chat
/provider copilot
```

### Authentication

| Provider | Environment Variable | Notes |
| :--- | :--- | :--- |
| **Copilot** | `GH_TOKEN` or `GITHUB_TOKEN` | GitHub PAT with Copilot permission |
| **OpenAI** | `OPENAI_API_KEY` | Standard OpenAI API key |
| **Anthropic** | `ANTHROPIC_API_KEY` | Anthropic API key |
| **Ollama** | (none) | Runs locally, no key needed |
| **Cerebras** | `CEREBRAS_API_KEY` | OpenAI-compatible; default model `gpt-oss-120b`. Hidden until `CEREBRAS_API_KEY`, `LIKU_ENABLE_CEREBRAS=1`, or `/setkey cerebras ...` is used. |
| **xAI** | `XAI_API_KEY` | OpenAI-compatible at `https://api.x.ai/v1`; default model `grok-4.6`. Hidden until `XAI_API_KEY`, `LIKU_ENABLE_XAI=1`, or `/setkey xai ...` is used. |

Or authenticate interactively inside chat:
```
/login
```

### Model Selection

Models are grouped by capability. Use `/model` to see the live inventory:

```
/model              # Show grouped model list
/model claude-4     # Switch to a specific model
```

**Copilot model groups:**
- **Agentic Vision** — models with vision + tool-call support (best for automation)
- **Reasoning / Planning** — strong reasoning models (best for `(plan)` routing)
- **Standard Chat** — general-purpose chat models

Capability reroutes are surfaced visibly when a chosen model cannot handle the current request type.

### Role Routing Policy (Inference Fabric)

A flag-gated policy can assign a provider/model to agent work **by role** (Supervisor, Builder, etc.) without hardcoding vendors into the agents. It is **off by default**; when off, provider/model behavior is identical to the standard Copilot path.

Enable with:

```bash
export LIKU_INFERENCE_FABRIC=1   # accepts 1 | true | yes | on
```

The flag only *activates* the routing table — it does **not** by itself enable optional providers. Cerebras/xAI still require their Phase 41 visibility (an API key or `LIKU_ENABLE_CEREBRAS` / `LIKU_ENABLE_XAI`). If a role's target provider is not enabled, routing falls back to the current provider (no error).

**Default routing table** (role → provider / model):

| Role | Default provider | Default model |
| :--- | :--- | :--- |
| `supervisor` | xai | catalog default (`grok-4.6`) |
| `architect` | xai | catalog default (`grok-4.6`) |
| `researcher` | cerebras | `gpt-oss-120b` |
| `builder` | cerebras | `gpt-oss-120b` |
| `verifier` | cerebras | `gpt-oss-120b` |
| `diagnostician` | cerebras | `gpt-oss-120b` |
| `producer` | current provider | current model |
| `vision` | current provider | current model |
| unset / unknown | current provider | current model |

**Resolution order:** fabric flag off → current provider/model · explicit `/provider` (or per-call provider) → wins over the table · explicit `/model` for that provider · session `/route` override for the role · default table · if the selected provider is not enabled → current provider. An explicit user `/provider` selection is always honored over the table.

**`/route` command:**

```
/route                          # Show flag state, default table, session overrides, provider enablement
/route builder xai/grok-4.6     # Session override for a role (provider[/model])
/route builder default          # Clear the override for one role
/route reset                    # Clear all overrides
```

Unknown roles, disabled providers, and unknown model ids for a provider are rejected. Routing metadata is recorded on the AI result's `providerMetadata.route`; it never enters the model's system-prompt context.

### Inference Budget Governor & Telemetry

When the inference fabric is on, each inference call passes through a **fail-closed budget governor** and (optionally) appends a durable **telemetry** record. Both are inert when `LIKU_INFERENCE_FABRIC` is off — no spend accounting, no files written.

**Budget caps** (all optional; defaults apply only when the fabric is on):

| Scope | Env variable | Default |
| :--- | :--- | :--- |
| Session estimated USD | `LIKU_INFERENCE_BUDGET_USD` | `0.50` |
| Session tokens (in + out) | `LIKU_INFERENCE_BUDGET_TOKENS` | `250000` |
| Calls per role (per process) | `LIKU_INFERENCE_MAX_CALLS_PER_ROLE` | `20` |

Over-cap calls are **not dispatched** — the request is blocked before any network I/O and a structured `Budget exceeded: <reason>` error is surfaced (`reason` is one of `usd-cap`, `token-cap`, `iteration-cap`). The ledger is in-process only (caps reset per process); durable spend history lives in telemetry. Missing usage on a response counts one call toward the iteration cap but never invents token numbers.

**Rate table:** cost estimates come from an in-module price table (`providers/rates.js`). The bundled rates are **illustrative — verify against provider pricing before trusting spend**. Override by pointing `LIKU_INFERENCE_RATES_JSON` at a JSON file shaped like `{ "<provider>": { "<model>": { "inputPerMillion": N, "outputPerMillion": N } } }`. An unknown rate yields `estimatedUsd: null` (never `0` pretending free).

**Telemetry:** one JSONL line per completed / failed / blocked call at `~/.liku/inference/inference.jsonl` (file mode `0o600`, dir `0o700`). Records carry only scalar metadata — provider, model, role, route reason, token counts, latency, estimated USD, success/blocked flags — never API keys, prompt text, file contents, or screenshots. Disable file writes while keeping the fabric on with `LIKU_INFERENCE_TELEMETRY=0`.

**Analytics (read-only):**

```
liku analytics inference          # Counts, tokens, estimated cost, latency, breakdown by provider/role
liku analytics inference --json   # Machine-readable summary
liku analytics inference --raw    # Dump raw JSONL records
/status                           # Shows an Inference block when the fabric is on
```

### Agent Task Contracts

On the multi-agent **coding** path, the Supervisor can attach a machine-readable **TaskContract** to each subtask before handing off to Builder / Verifier / Researcher, and workers return a compressed **TaskResult** instead of a raw chat transcript. This keeps the Supervisor's follow-up context small and structured. It is **off by default**; when off, the coding handoff strings and raw result objects are byte-identical to before.

```bash
export LIKU_TASK_CONTRACTS=1          # enable contracts on the coding path
export LIKU_PERSIST_TASK_CONTRACTS=1  # optional: persist contracts to ~/.liku/task-contracts.json
```

- A **TaskContract** is a hard-bounded envelope: `taskId`, `parentTaskId`, `role`, `objective`, `scope`/`forbidden`/`constraints`/`successCriteria`, `verification` (`tests`|`diff-review`|`none`), `risk`, advisory `providerPolicy`/`budgetHint`, and `cancellation: { requested }`. It **never** carries file contents, diffs, or transcripts. Every field is capped and the whole object serializes to ≤ 4 KiB.
- A **TaskResult** is the worker's bounded report: `status`, `findings`, `files`, `evidence` (test names, not logs), `recommendation`, `confidence`.
- Contracts carry independently-schedulable fields, but the runner stays **sequential** in this release. `supervisor.requestCancel(taskId)` marks a not-yet-dispatched subtask skipped before its handoff.
- The peripheral inbox (`~/.liku/supervisor-tasks.json`) is unchanged — coding contracts persist to a **separate** `~/.liku/task-contracts.json` (max 20, flag-gated). This flag only affects the coding path; PAL peripheral-task semantics are untouched.

### Observable-Signal Escalation & Independent Verifier

The Supervisor coding path can retry a failing subtask by climbing a capability **ladder** — but only in response to **observable signals** (test failures, schema errors, provider errors), never model self-confidence. Both features are **off by default** and require the inference fabric to be on; when off, the single-pass Phase 44 behavior is unchanged.

```bash
export LIKU_ESCALATION=1            # retry failing coding subtasks up the ladder
export LIKU_INDEPENDENT_VERIFIER=1  # route Verifier to a different provider than Builder
```

- **Signals** (closed set): `success`, `tests-failed`, `schema-invalid`, `files-missing`, `verifier-disagree`, `repeated-failure`, `timeout`, `budget-exceeded`, `policy-violation`, `provider-error`, `unknown-failure`.
- **Retry ladder:** rung 0 current route → rung 1 same provider retry → rung 2 stronger planner (prefers xAI if enabled) → rung 3 other enabled core provider → rung 4 human (stop). Rungs whose provider is not enabled are skipped.
- **Hard limits:** at most **2** automatic retries per task per process; the same recurring signal escalates to a human sooner (`repeated-failure`). `policy-violation` and `budget-exceeded` **never** auto-retry — they stop immediately and surface a blocked `TaskResult` with recommendation `human review`. Every retry still passes through the budget governor.
- **Independent Verifier:** when enabled and the Builder's used provider is known, the Verifier's request routes to the first other enabled provider (order: xai, cerebras, openai, anthropic, copilot). If none exists, the table route is kept with reason `no-alternate-provider`. The Verifier stays read-only.
- Escalation applies only to the coding path — peripheral tasks are never retried.

### Execution Fabric (In-Process)

The **Execution Fabric** is a thin interface over the Supervisor coding path. Its only implementation in this release is the **in-process adapter**: it wraps the same sequential `executePlan` loop (Phase 44 cancel-before-dispatch, Phase 45 classify/retry) and records a bounded, sanitized snapshot per subtask. It is **off by default**; when off, the coding path is byte-identical to Phase 45 and no fabric object is ever allocated.

```bash
export LIKU_EXECUTION_FABRIC=1     # route coding subtasks through the in-process fabric
```

- **This phase is interfaces + an in-process adapter only.** It does **not** run tasks in parallel, does **not** spawn workers or processes, and does **not** add HTTP/QUIC/HTTP-3 transport. PAL (peripheral) semantics are untouched.
- **Task states** (closed set): `queued`, `running`, `succeeded`, `failed`, `blocked`, `skipped`, `cancelled`. **Events** (closed set): `task.queued`, `task.started`, `task.completed`, `task.failed`, `task.blocked`, `task.skipped`, `task.cancelled`. Fabric events stay local to the fabric object and are not persisted.
- **Cancellation is pre-dispatch only** (same guarantee as Phase 44 `requestCancel`): `cancel(taskId)` succeeds and marks a subtask `cancelled` **only while it is still `queued`**. A task that has already started returns `false` and runs to completion — the fabric cannot abort in-flight provider I/O.
- **Snapshots are bounded and sanitized:** each recorded task keeps only `taskId`, `role`, `state`, its contract, and an allowlisted result (`kind`, `version`, `taskId`, `status`, `recommendation`, `confidence`, and capped `findings`/`files`/`evidence`). Transcripts, diffs, and rationale are **never** stored. `list()` is capped at 20 (oldest evicted).

### Parallel Scheduler (Declared Independence Only)

The **Parallel Scheduler** sits on top of the Execution Fabric and may run **Supervisor-declared independent** coding subtasks concurrently, under hard caps. It requires **both** flags; when either is off the sequential `executePlan` loop is the only runner and behavior is byte-identical to Phase 46.

```bash
export LIKU_EXECUTION_FABRIC=1     # required
export LIKU_PARALLEL_SCHEDULER=1   # route the decomposed plan through the scheduler
```

- **Independence is DECLARED, never inferred.** A step is parallel-eligible only when it explicitly sets `independent: true` (structured field) — prose like "also"/"meanwhile" is never parsed. By default the plan still chains (Verifier waits for its Builder). A step may also set `serial: true` to force it to run alone.
- **Ready rule:** a task launches only when every dependency is in terminal **success**. A dependency that failed/blocked/cancelled/skipped fails the dependent, which is marked `skipped` with reason `dependency-failed` (same as the sequential "Dependencies not satisfied" skip).
- **Caps** (integers ≥ 1; a value below 1 or non-numeric falls back to the default). Exceeding a cap leaves the task queued until a slot frees — no extra provider calls are made past the cap:

| Env var | Default | Meaning |
| --- | --- | --- |
| `LIKU_MAX_PARALLEL_TASKS` | 2 | Maximum coding tasks in flight at once |
| `LIKU_MAX_PARALLEL_PER_PROVIDER` | 1 | Maximum in flight per `explicitProvider` (unknown provider counts against `unspecified`) |
| `LIKU_MAX_PARALLEL_PER_ROLE` | 2 | Maximum in flight per role (builder / verifier / …) |

- **Same guarantees as the fabric:** cancellation is pre-dispatch only (a queued task whose cancel was requested never runs). Escalation stays **sequential inside** one `taskId` — rungs of the same task are never parallelized, and a `taskId` already running is never re-dispatched.
- **Shared budget governor:** parallel Builder calls both flow through the same process-wide budget ledger; the first can spend the cap and the second receives a budget-exceeded signal and does **not** auto-retry past policy.
- **In-process only.** No transport abstraction, no HTTP/2 vs HTTP/3, no QUIC, no IPC/worker pools, no work-stealing — those are later phases. `policy-violation`/`requiresHuman`/Class A peripheral work stays serial and out of this scheduler (coding path only); PAL semantics are untouched.

### Transport Fabric (Interface + In-Process / HTTPS Adapters)

The **Transport Fabric** lets Execution Fabric workers ask a `TransportManager` for a handle instead of being hard-wired to "call a JS function in this process." It is **off by default**; when off no manager is constructed and call sites are byte-identical to Phase 47.

```bash
export LIKU_TRANSPORT_FABRIC=1     # route the in-process agent handoff through the transport manager
```

- **Two implemented kinds:** `inprocess` (today's agent handoff / `runTask`) and `https-provider` (today's OpenAI-compatible request path — Cerebras/xAI/OpenAI). `select()` with no kind returns `inprocess` for agent work; `https-provider` accepts only inference-shaped payloads (`{ messages, provider, model }`).
- **Reserved kinds are NOT built:** `http2`, `http3`, `quic`, `ipc`. Selecting one fails closed with `unsupported-transport` — there is never a silent fall-through to a reserved kind, no QUIC, no HTTP/3, no IPC socket, no bakeoff.
- **Transport neutrality:** worker semantics are not coupled to TCP/HTTP/2/3/QUIC. Provider APIs remain HTTPS / OpenAI-compatible, and **agents never open streams**.
- **Transport grants no authority.** A handle's `invoke()` only calls the injected function: agent handoffs still flow through Supervisor → fabric → scheduler → escalation, and model calls still flow through `requestWithFallback` (route + budget + telemetry). The manager never reads an API key from `caps` to POST around policy, and only Supervisor / ai-service / fabric may hold it.




### Status and Diagnostics

```
/status             # Show provider, model, routing metadata, browser continuity state
/clear              # Reset conversation history and browser session state
```

## Preferences System

### App-Scoped Preferences

Preferences are stored at `~/.liku-cli/preferences.json` and control per-app execution behavior:

```json
{
  "apps": {
    "Microsoft Edge": {
      "executionMode": "autonomous",
      "negativePolicies": ["do not close existing tabs"],
      "actionPolicies": ["always verify URL after navigation"]
    }
  }
}
```

- **negativePolicies** (brakes): constraints the AI must not violate
- **actionPolicies** (rails): positive enforcement rules the AI must follow
- **executionMode**: `"autonomous"` | `"confirm"` | `"manual"`

### Teaching Preferences

In `liku chat`, when prompted to run actions:
- Press `c` to **Teach** — this opens the preference flow for the active app
- Rules are validated with structured output parsing and saved with metrics placeholders

## Electron Overlay Configuration

### Window Behavior

Overlay and chat window settings are defined in `src/main/index.js`:

```javascript
// Overlay: transparent, full-screen, always-on-top, click-through
{
  frame: false,
  transparent: true,
  alwaysOnTop: true,
  focusable: false,
  skipTaskbar: true,
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    preload: 'overlay/preload.js'
  }
}
```

```javascript
// Chat: edge-docked, resizable, hidden by default
{
  frame: true,
  resizable: true,
  alwaysOnTop: false,
  show: false,
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    preload: 'chat/preload.js'
  }
}
```

### Global Shortcuts

Hotkeys are registered in `src/main/index.js`:

| Shortcut | Action |
| :--- | :--- |
| `Ctrl+Alt+Space` | Toggle chat window |
| `Ctrl+Shift+O` | Toggle overlay visibility |
| `Ctrl+Alt+I` | Toggle inspect mode |
| `Ctrl+Alt+F` | Toggle fine grid |
| `Ctrl+Alt+G` | Show all grid levels |
| `Ctrl+Alt+=` / `Ctrl+Alt+-` | Zoom in / out grid |

### Dot Grid Tuning

The overlay uses two grid densities:
- **Coarse grid**: ~100px spacing with alphanumeric labels (e.g., `A1`, `C3`)
- **Fine grid**: ~25px spacing for precise targeting (e.g., `C3.21`)

## Automation Configuration

### Slash Commands

| Command | Description |
| :--- | :--- |
| `/orchestrate <task>` | Start full multi-agent workflow |
| `/research <query>` | Deep workspace/web research |
| `/build <spec>` | Generate implementation from spec |
| `/verify <target>` | Run validation checks |
| `/model` | Show/switch model |
| `/agentic` | Toggle autonomous mode |
| `/recipes [on\|off]` | Toggle popup follow-up recipes |
| `/capture` | Capture screen for visual context |
| `/vision on` | Enable one-shot vision mode |

### Agentic Mode

When `/agentic` is enabled, the AI executes action plans without asking for confirmation. When disabled (default), each plan is shown and requires explicit approval.

### Safety Guardrails

Actions are analyzed for risk level before execution:
- **LOW**: auto-execute in agentic mode
- **MEDIUM**: execute with warning
- **HIGH**: require explicit confirmation even in agentic mode
- **CRITICAL**: always blocked; manual intervention required

Policy enforcement validates action plans against both negative and positive policies before execution. Violations trigger bounded regeneration.

## Platform-Specific Settings

### Windows

- PowerShell v5.1+ required for automation primitives
- .NET 9 SDK recommended for building the UIA host (`npm run build:uia`)
- The postinstall script auto-builds the UIA host if .NET SDK is detected

### macOS

- Accessibility permissions required for UI automation
- App hides from Dock; overlay uses `screen-saver` window level

### Linux

- AT-SPI2 recommended for accessibility integration

## Security Settings

### Electron Security

- `contextIsolation: true` — renderers cannot access Node.js APIs
- `nodeIntegration: false` — no `require()` in renderer code
- CSP headers enforce `default-src 'self'` with limited inline styles
- Preload scripts expose only the minimum required IPC bridges

### API Key Storage

- Keys are read from environment variables only
- Tokens stored locally under `~/.liku-cli/`
- No secrets bundled in the package

## Environment Variables

| Variable | Purpose | Default |
| :--- | :--- | :--- |
| `GH_TOKEN` / `GITHUB_TOKEN` | Copilot authentication | — |
| `OPENAI_API_KEY` | OpenAI provider key | — |
| `ANTHROPIC_API_KEY` | Anthropic provider key | — |
| `COPILOT_PROVIDER` | Active provider | `copilot` |
| `CEREBRAS_API_KEY` / `LIKU_ENABLE_CEREBRAS` | Enable/authenticate Cerebras | — |
| `XAI_API_KEY` / `LIKU_ENABLE_XAI` | Enable/authenticate xAI | — |
| `LIKU_INFERENCE_FABRIC` | Enable flag-gated role routing policy (`/route`) | off |
| `LIKU_INFERENCE_TELEMETRY` | Toggle inference telemetry writes while fabric on | on |
| `LIKU_INFERENCE_BUDGET_USD` | Session estimated-USD spend cap | `0.50` |
| `LIKU_INFERENCE_BUDGET_TOKENS` | Session token cap (in + out) | `250000` |
| `LIKU_INFERENCE_MAX_CALLS_PER_ROLE` | Per-role call cap (per process) | `20` |
| `LIKU_INFERENCE_RATES_JSON` | Path to a rate-table override JSON | — |
| `LIKU_TASK_CONTRACTS` | Enable Supervisor coding TaskContracts + compressed worker results | off |
| `LIKU_PERSIST_TASK_CONTRACTS` | Persist coding contracts to `~/.liku/task-contracts.json` | off |
| `LIKU_ESCALATION` | Enable observable-signal escalation on the coding path | off |
| `LIKU_INDEPENDENT_VERIFIER` | Route Verifier to a different provider than Builder | off |
| `LIKU_EXECUTION_FABRIC` | Route coding subtasks through the in-process Execution Fabric | off |
| `LIKU_PARALLEL_SCHEDULER` | Run declared-independent coding subtasks concurrently (requires `LIKU_EXECUTION_FABRIC`) | off |
| `LIKU_MAX_PARALLEL_TASKS` | Scheduler cap: max coding tasks in flight | 2 |
| `LIKU_MAX_PARALLEL_PER_PROVIDER` | Scheduler cap: max in flight per provider | 1 |
| `LIKU_MAX_PARALLEL_PER_ROLE` | Scheduler cap: max in flight per role | 2 |
| `LIKU_TRANSPORT_FABRIC` | Route worker dispatch through the transport manager (inprocess / https-provider adapters) | off |
| `NODE_ENV` | Development/production mode | — |
