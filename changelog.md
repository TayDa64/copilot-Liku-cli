## v0.0.14 — 2026-03-17

### App Launch Robustness & Window Awareness Planning
- **Broadened run_command→Start-menu rewrite guard**: Inverted from allowlisting specific commands (`Start-Process|Invoke-Item`) to blocklisting discovery commands (`Get-ChildItem|Test-Path|if exist`). Now catches `cmd /c start`, `Start-Process`, `& 'path'`, `cmd.exe /c`, and any future AI-invented shell launch patterns — all rewritten to reliable Win→type→Enter Start menu approach.
- **Fixed "Command failed: undefined" message bug**: When `stderr` is empty and `error` is undefined in `system-automation.js`, the error message now falls back to showing the exit code instead of "undefined".
- **New tests**: `cmd /c start` rewrite assertion, discovery command preservation assertion (67 total → 69 assertions, 0 failures).
- **Implementation plan created**: `PLAN-v0.0.14-window-awareness.md` — comprehensive 5-phase plan for multi-window and floating panel awareness covering window metadata enrichment, AI topology awareness, expanded app vocabulary, topmost window detection, and splash screen handling.

## Unreleased - 2026-03-12

### Cognitive Layer — N1-N6 Next-Stage Roadmap (commit `fde64b0`)
- **N3 — E2E Dynamic Tool Smoke Test** (Phase 10): Full pipeline test — `proposeTool()` → quarantine → `approveTool()` → `sandbox.executeDynamicTool()` via `child_process.fork()` → verify Fibonacci(10) = 55 → `recordInvocation()` → `writeTelemetry()` → verify telemetry entry → cleanup. 17 assertions.
- **N1-T2 — TF-IDF Skill Routing** (Phase 11): Pure JS TF-IDF implementation (`tokenize`, `termFrequency`, `inverseDocFrequency`, `tfidfVector`, `cosineSimilarity`). Combined scoring: keyword match + TF-IDF similarity (scaled ×5). Zero new dependencies. 16 assertions.
- **N4 — Session Persistence** (Phase 12): `saveSessionNote()` on chat exit extracts recent user messages, computes top-8 keywords, writes episodic memory note via `memoryStore.addNote()`. Wired into `chat.js` finally block.
- **N6 — Cross-Model Reflection** (Phase 13): `reflectionModelOverride` routes reflection passes to reasoning model (o1/o3-mini) instead of default chat model. New `/rmodel` slash command to set/get/clear. 12 assertions.
- **N5 — Analytics CLI** (Phase 14): `liku analytics [--days N] [--raw] [--json]`. Reads telemetry JSONL, computes success rates, top tasks, phase breakdown, common failures.
- **Contract test update**: Added `saveSessionNote`, `setReflectionModel`, `getReflectionModel` to expected export surface in `test-ai-service-contract.js`.
- **Test totals**: 310 cognitive + 29 regression = **339 assertions**, 0 failures.

### Cognitive Layer — Phase 9: Design-Level Hardening (commit `8aefc19`)
- **BPE Token Counting**: Added `src/shared/token-counter.js` using `js-tiktoken` (cl100k_base encoding). `countTokens(text)` and `truncateToTokenBudget(text, maxTokens)` replace character-based heuristics in memory-store and skill-router.
- **Tool Proposal Flow**: New quarantine pipeline — `proposeTool()` writes to `~/.liku/tools/proposed/`, `promoteTool()` moves to `dynamic/` on approval, `rejectTool()` deletes and logs negative reward. `registerTool()` now delegates to `proposeTool()` for backward compatibility.
- **CLI Proposals/Reject**: `liku tools proposals` lists pending proposals, `liku tools reject <name>` rejects with telemetry.
- **Sandbox Process Isolation**: Replaced in-process `vm.createContext` with `child_process.fork()` to `sandbox-worker.js`. Worker runs in separate Node.js process with stripped env (`NODE_ENV: 'sandbox'`, `PATH` only). 5.5s timeout with `SIGKILL`. Even a VM escape only compromises the short-lived worker.
- **Message Builder Explicit Context**: `buildMessages()` accepts named `skillsContext` and `memoryContext` parameters. Injected as dedicated `## Relevant Skills` and `## Working Memory` system message sections.
- Added 22 Phase 9 tests (256 cognitive assertions total, 0 failures).
- **Dependencies**: Added `js-tiktoken` (^1.0.20).

### Cognitive Layer — Phase 8: Audit-Driven Fixes (commit `f1fa1a6`)
- **Telemetry Schema**: `recordAutoRunOutcome` now calls `writeTelemetry({ task, phase: 'execution', outcome })` with proper structured schema instead of ad-hoc writes.
- **Staleness Pruning**: `loadIndex()` in skill-router validates each skill file exists via `fs.existsSync` and prunes stale entries from the index.
- **Word-Boundary Scoring**: Keyword matching in skill-router uses `new RegExp('\\b' + keyword + '\\b', 'i')` instead of substring `.includes()`, preventing false positives.
- **AWM PreToolUse Gate**: AWM skill creation passes through `hookRunner.runPreToolUse()` before registering (previously bypassed hooks).
- **PostToolUse Audit**: Reflection passes now invoke `runPostToolUse()` hook for audit logging.
- **AI-Service Hook Imports**: Fixed missing `hookRunner` import in `ai-service.js` that caused runtime errors on PostToolUse calls.
- **Trace Writer Fix**: `traceWriter.recordReflection()` accepts `{ pass, trigger, outcome }` instead of flat args.
- Added 16 Phase 8 tests (234 cognitive assertions after Phase 8, 0 failures).

### Cognitive Layer — Phase 7: Next-Level Enhancements
- **AWM Procedural Memory Extraction**: Successful multi-step action sequences (3+ steps) are now extracted as procedural memory notes and auto-registered as skills via `skillRouter.addSkill()`. Implements the Agent Workflow Memory (AWM) concept from the plan.
- **PostToolUse Hook Wiring**: Dynamic tool execution now invokes the `PostToolUse` hook (`audit-log.ps1`) for audit logging after sandbox execution. Updated `audit-log.ps1` to support both `COPILOT_HOOK_INPUT_PATH` (file-based) and stdin input methods.
- **Unapproved Tool Filtering**: `getDynamicToolDefinitions()` now filters out unapproved tools, preventing the model from seeing tools it cannot execute.
- **CLI Subcommands**: Added `liku memory`, `liku skills`, and `liku tools` commands for managing agent memory notes, the skill library, and the dynamic tool registry from the command line.
- **Telemetry Summary Analytics**: Added `getTelemetrySummary(date)` providing success rates, per-action breakdowns, and top failure reasons.
- Added 30 Phase 7 tests (206 cognitive assertions total, 0 failures).

### Cognitive Layer — Phase 6: Safety Hardening
- **PreToolUse Hook Enforcement**: New `hook-runner.js` module invokes `.github/hooks/` security scripts before dynamic tool execution. Fails closed on errors.
- **Bounded Reflection Loop**: Reflection iterations capped at `MAX_REFLECTION_ITERATIONS = 2` to prevent runaway loops.
- **Session Failure Decay**: `sessionFailureCount` now decays by 1 on each success instead of being monotonically increasing.
- **Phase Params for All Providers**: `requestOptions` (temperature/top_p from phase params) forwarded to OpenAI, Anthropic, and Ollama providers, not just Copilot.
- **Execution Phase Signal**: `sendMessage()` now passes `phase: 'execution'` to the provider orchestration layer.
- **Memory LRU Pruning**: `addNote()` prunes oldest notes when count exceeds `MAX_NOTES` (500).
- **Telemetry Log Rotation**: Telemetry JSONL files rotate at 10MB with `.rotated-{timestamp}` naming.
- Added 35 Phase 6 safety tests.

### Cognitive Layer — Phases 0–5: Core Implementation
- **Phase 0**: Structured `~/.liku/` home directory with migration from `~/.liku-cli/` (copy, not move).
- **Phase 1**: Agentic Memory (A-MEM) — CRUD for structured notes with Zettelkasten-style linking, keyword relevance, and token-budgeted context injection.
- **Phase 2**: RLVR Telemetry — Structured telemetry writer, reflection trigger with consecutive/session failure thresholds, phase-aware temperature params (stripped for reasoning models).
- **Phase 3**: Dynamic Tool Generation — VM sandbox (no fs/process/require), 16 banned patterns, 5s timeout, approval gate, PreToolUse hook enforcement.
- **Phase 4**: Semantic Skill Router — Keyword-based skill selection, 1500-token budget, max 3 skills, usage tracking.
- **Phase 5**: Deeper Integration — Cognitive awareness in system prompt, `/memory`/`/skills`/`/tools` slash commands, telemetry wiring in preferences, policy wiring in reflection.
- 10 new source modules, 11 modified files. Initial assertion count: 206 cognitive + 29 regression = 235 (now 256 + 29 = 285 after Phases 6–9).

## Unreleased - 2026-03-08

### Copilot Model Capability Separation
- Replaced the old vision-only model distinction with a richer capability matrix in the Copilot model registry.
- Grouped chat-facing Copilot models into `Agentic Vision`, `Reasoning / Planning`, and `Standard Chat` categories.
- Removed legacy-unavailable selections like `gpt-5.4` from the active chat-facing picker inventory while preserving backward-compatible canonicalization for older saved state.

### Routing and Status Transparency
- Added capability-aware model routing defaults for visual, automation, and planning intents.
- Surfaced explicit reroute notices instead of silently swapping models underneath the user.
- Expanded `/status` and `getStatus()` with configured/requested/runtime model metadata and live Copilot model inventory.

### Shared Model UX and Renderer Sync
- Updated `/model` output and the terminal picker to render grouped model inventory with capability hints.
- Hydrated the Electron model selector from live AI status instead of stale static assumptions.
- Fixed a renderer sync gap where successful `/model` changes did not push refreshed AI status back to the chat UI, causing selection drift during real use.

### Plan-Only and Automation Reliability
- Added `(plan)` routing to the existing multi-agent orchestrator in non-destructive `plan-only` mode.
- Added live UI target prevalidation before coordinate clicks.
- Hardened Windows process enumeration so inaccessible `StartTime` values no longer crash the validation path.

### Verification
- Verified targeted passes for `test-ai-service-model-registry`, `test-ai-service-provider-orchestration`, and `test-ai-service-commands`.
- Verified a full local regression batch in `regression-run.log`.

## 0.0.14 - Liku Edition - 2026-03-07

### Multi-Agent Hook Enforcement
- Added deterministic worker artifacts under `.github/hooks/artifacts/` so stop-hook validation can enforce required report sections even when `SubagentStop` payloads include metadata only.
- Tightened security hook behavior so read-only workers may update only their role-scoped artifact path instead of arbitrary repo files.
- Added direct verification harnesses: `scripts/test-hook-artifacts.js` and `scripts/test-hook-artifacts.ps1`.

### AI Service Modularization
- Extracted system prompt generation into `src/main/ai-service/system-prompt.js`.
- Extracted message assembly into `src/main/ai-service/message-builder.js`.
- Extracted slash-command handling into `src/main/ai-service/commands.js`.
- Extracted provider fallback and dispatch orchestration into `src/main/ai-service/providers/orchestration.js`.
- Added extracted state and support modules for browser session state, conversation history, UI context, visual context, provider registry, Copilot model registry, policy enforcement, preference parsing, slash-command helpers, and action parsing.

### Verification
- Added characterization coverage for the compatibility facade and extracted seams.
- Verified fresh local passes for provider orchestration, contract stability, v0.0.6 feature coverage, and bug-fix regression coverage.

## 0.0.13 - Liku Edition - 2026-03-06

### Browser Continuity State (Session Grounding)
- Added lightweight `BrowserSessionState` in `src/main/ai-service.js` with `url`, `title`, `goalStatus`, `lastStrategy`, `lastUserIntent`, and `lastUpdated`.
- Browser session state is now injected into system messages so each new turn is grounded in explicit continuity data, not only conversation memory.
- State is exposed via `/status` and reset by `/clear`.
- State is updated from deterministic rewrite selection and post-execution verification outcomes.

### Action Parsing Reliability (Critical)
- Fixed `parseAIActions` to parse all fenced JSON blocks and select the best executable action plan instead of always taking the first block.
- This resolves multi-block model responses where the first block is a tiny focus-only preface and later blocks contain the real workflow.

### Deterministic Browser Flow Improvements
- Added no-URL YouTube rewrite support for prompts like "using edge open a new youtube page, then search for ...".
- When browser + YouTube + search intent is detected, low-signal or fragmented plans are rewritten into a complete deterministic flow:
  - focus target browser
  - open `https://www.youtube.com`
  - run search query

### Chat Orchestration Guardrails
- Added non-action/chit-chat execution guard in terminal chat so acknowledgements do not trigger action execution.
- Added prompt-level continuity rule to avoid extra screenshot detours when objective appears already achieved.

## 0.0.12 - Liku Edition - 2026-03-04

### Terminal Chat: `liku chat`
- Added an interactive terminal chat mode that can emit and execute JSON actions without requiring the Electron overlay.
- Supports `/login`, `/model`, `/capture`, and one-shot vision via `/vision on`.

### Teach UX + Preferences (Hardened)
- Added a preferences store at `~/.liku-cli/preferences.json` for app-scoped execution mode and policy steering.
- Hardened the Preference Parser to emit a strict typed rules array (`type: "negative" | "action"`) using structured output validation.
- New rules merged into preferences are initialized with metrics placeholders (`metrics: { successes: 0, failures: 0 }`).

### Policy Enforcement (Rails)
- Action plans are now validated against both `negativePolicies` (brakes) and `actionPolicies` (positive enforcement rails) and will be regenerated on violation (bounded retries).

## 0.0.10 - Liku Edition - 2026-03-02

### Diagnostics: `liku doctor` (Stricter Schema)
- `doctor --json` now emits a versioned, deterministic schema (`schemaVersion: doctor.v1`) with explicit `checks`, `uiState`, `targeting`, `plan.steps`, and `next.commands`.
- Improved request hint parsing and window matching for tab operations (e.g., correctly captures `tabTitle: "New tab"` and tolerates punctuation differences in window titles).

## 0.0.9 - Liku Edition - 2026-02-28

### Phase 1: Coordinate Pipeline Fixes (4 Critical Bugs)

#### BUG1 — Dot-selected coordinates now reach AI prompt
- `lastDotSelection` stored on `dot-selected`, consumed on next `chat-message`
- `coordinates` option now passed to `aiService.sendMessage()`, activating the prompt-enhancement code that was previously dead

#### BUG2+4 — DIP→physical conversion at Win32 boundary
- `performSafeAgenticAction` now performs a two-step conversion:
  1. Image pixels → CSS/DIP (via `display.bounds`)
  2. CSS/DIP → physical screen pixels (multiply by `scaleFactor`)
- Previously, DIP coords went directly to `Cursor::Position` / `SendInput` which expect physical pixels — clicks missed on any HiDPI display (sf ≠ 1)

#### BUG3 — Region-resolved actions skip image scaling
- Actions resolved via `resolveRegionTarget()` are already in physical screen pixels (from UIA)
- Now tagged with `_resolvedFromRegion` flag and bypass the image→screen scaling entirely
- Previously, physical coords were double-mangled through the image→DIP scaler

#### Visual feedback fix
- Pulse animation now converts physical coords back to CSS/DIP for the overlay, which operates in CSS space
- Previously, HiDPI pulse targets drifted from actual click location

#### Screenshot callback fix
- `executeActionsAndRespond` screenshot callback now uses `getVirtualDesktopSize()` instead of `screen.getPrimaryDisplay().bounds`

### Testing
- 85 smoke assertions (12 new), 6 bug-fix tests, 16 feature tests — 107 total, 0 failures

## 0.0.8 - Liku Edition - 2026-02-19

### Testing & Reliability Improvements
- Added deterministic runtime smoke commands:
  - `npm run smoke:shortcuts` (two-phase: direct chat visibility + target-gated overlay shortcut)
  - `npm run smoke:chat-direct` (direct in-app chat toggle, no keyboard emulation)
- Added strict pass/fail semantics for UI automation smoke commands (non-zero exits on target mismatch).
- Added process/title-targeted key dispatch validation to prevent accidental key injection into unrelated focused apps.
- Updated baseline UI automation tests so keyboard injection checks are opt-in (`--allow-keys` or `UI_AUTO_ALLOW_KEYS=1`).

### Debug/Smoke Instrumentation
- Added guarded debug IPC handlers in main process:
  - `debug-toggle-chat`
  - `debug-window-state`
- Added `LIKU_ENABLE_DEBUG_IPC=1` gate for debug IPC access.
- Added optional smoke hook `LIKU_SMOKE_DIRECT_CHAT=1` to trigger deterministic in-app chat toggle during runtime smoke.

### UI Automation Improvements
- Updated window discovery to support `includeUntitled` windows for Electron cases where titles are transient/empty.
- Improved smoke scripts to assert minimum matched window counts and fail fast when expected windows are missing.

### Documentation
- Updated `README.md`, `QUICKSTART.md`, and `TESTING.md` with recommended smoke command order and shortcut source-of-truth notes.

## 0.0.5 - Liku Edition - 2025-02-04

### New Feature: Integrated Terminal (`run_command`)
- **Direct shell command execution** - AI can now run commands without opening terminal windows
- New `run_command` action type: `{"type": "run_command", "command": "dir", "cwd": "C:\\Users"}`
- Supports PowerShell (default), cmd, and bash shells
- 30-second timeout with output truncation at 4000 characters
- Command output returned directly to AI for analysis

### Safety Analysis
- Dangerous command patterns detected and flagged (rm -rf, format, del /s, etc.)
- Risk levels: CRITICAL (destructive), HIGH (delete operations), MEDIUM (normal commands)
- AI receives safety assessment before execution

### Bug Fixes
- Fixed "Press: undefined" in action UI - `action.keys` → `action.key || action.keys`
- Fixed UIWatcher `isRunning` property - added getter returning `isPolling` state

### System Prompt Updates
- Documented `run_command` action type in AI system prompt
- Updated common task patterns to prefer `run_command` for shell operations
- AI now uses direct command execution instead of unreliable Win+R automation

## 0.0.4 - Liku Edition - 2025-02-03

### Focus & Input Fixes
- **Root Cause Fixed**: Keyboard automation (Win+R, typing, etc.) was failing because:
  1. Chat window kept focus after user sent message → input went to chat, not desktop
  2. Overlay at `screen-saver` z-level blocked system dialogs (Run, Start menu)
- Now blur chat/overlay windows before action execution
- Temporarily lower overlay z-index to `pop-up-menu` during automation
- Restore `screen-saver` z-index after actions complete

### Console Logging Fix
- Fixed "undefined" line numbers in overlay console logs
- Now shows proper log levels (verbose/info/warn/error) instead of numeric codes
- Handles undefined line numbers gracefully

### Architecture: Integrated Terminal Design
- Researched node-pty + xterm.js for future `run_command` action type
- Would allow AI to run shell commands directly instead of unreliable Win+R automation
- See docs/INTEGRATED_TERMINAL_ARCHITECTURE.md (coming soon)

## 0.0.3 - Liku Edition - 2025-01-XX

### OS Awareness
- Added platform detection (`PLATFORM`, `OS_NAME`) to AI service
- AI system prompt now includes OS-specific keyboard shortcuts (Windows, macOS, Linux)
- AI correctly uses Windows-specific shortcuts (Win+X, Win+R, etc.) instead of macOS/Linux ones

### Windows Key Fix
- Fixed Windows key support using SendInput with VK_LWIN (0x5B) virtual key code
- `pressKey()` now properly handles `win+`, `windows+`, `super+` key combos
- Replaced broken `^{ESC}` mapping with proper SendInput implementation

### Live UI Mirror Architecture
- New `ui-watcher.js` service for continuous background monitoring of Windows UI tree
- Polls Windows UI Automation every 300-500ms with configurable intervals
- Maintains element cache with bounds, text, roles for AI context
- `getContextForAI()` provides formatted UI state snapshot for AI messages
- Element lookup methods: `findElementByText()`, `getElementAtPoint()`
- Events: 'ui-changed', 'poll-complete', 'started', 'stopped'
- AI now receives live UI context automatically (no manual screenshots needed)
- Overlay integration for real-time UI change notifications

## 0.0.341 - 2025-10-14

> **Note**: Entries below this line are from the upstream GitHub Copilot CLI project. They document the base tool this fork extends.

- Added `/terminal-setup` command to set up multi-line input on terminals not implementing the kitty protocol
- Fixed a bug where rejecting an MCP tool call would reject all future tool calls (fixes https://github.com/github/copilot-cli/issues/290)
- Fixed a regression where calling `/model` with an argument did not work properly
- Added each model's premium request multiplier to the `/model` list (currently, all our supported models are 1x)

## 0.0.340 - 2025-10-13

- Removed the "Windows support is experimental" warning -- we've made some big strides in improving Windows support the last two weeks! Please continue to report any issues/feedback
- Improved debugging by including the Copilot API request ID for model calls errors and stack traces for client errors
- Fixed an issue where consecutive orphaned tool calls led to a "Each `tool_use` block must have a corresponding `tool_result` block in the next message" message (fixes https://github.com/github/copilot-cli/issues/102)
- Added a prompt to approve new paths in `-p` mode. Also added `--allow-all-paths` argument that approves access to all paths.
- Changed parsing of environment variables in MCP server configuration to treat the value of the `env` section as literal values (fixes https://github.com/github/copilot-cli/issues/26). 
  Customers who have configured MCP Servers for use with the CLI will need to make a slight modification to their `~/.copilot/mcp-config.json`.  For any servers they have added with an `env` section, they will need to go add a `$` to the start of the "value" pair of the key value pair of each entry in the env-block, so to have the values treated as references to environment variables.

  For example: Before:
    ```json
    {
        "env": {
            "GITHUB_ACCESS_TOKEN": "GITHUB_TOKEN"
         }
    }
    ```

    Before this change, the CLI would read the value of `GITHUB_TOKEN` from the environment of the CLI and set the environment varaible named `GITHUB_ACCESS_TOKEN` in the MCP process to that value.  With this change, `GITHUB_ACCESS_TOKEN` would now be set to the literal value `GITHUB_TOKEN`.  To get the old behavior, change to this:

    ```json
    {
        "env": {
            "GITHUB_ACCESS_TOKEN": "${GITHUB_TOKEN}"
         }
    }
    ```


## 0.0.339 - 2025-10-10

- Improved argument input to MCP servers in `/mcp add` -- previously, users had to use comma-separated syntax to specify arguments. Now, the "Command" field allows users to input the full command to start the server as if they were running it in a shell
- Fixed a bug when using the Kitty protocol that led to text containing `u` to not paste correctly. Kitty protocol support is still behind the `COPILOT_KITTY` environment variable. (Fixes https://github.com/github/copilot-cli/issues/259)
- Fixed a bug when using the Kitty protocol that led to the process hanging in VSCode terminal on Windows. Kitty protocol support is still behind the `COPILOT_KITTY` environment variable. (Fixes https://github.com/github/copilot-cli/issues/257)
- Improved the error handling in the `/model` picker when no models are available (fixes https://github.com/github/copilot-cli/issues/229)

## 0.0.338 - 2025-10-09

- Moved Kitty protocol support behind the `COPILOT_KITTY` environment variable due to observed regressions (https://github.com/github/copilot-cli/issues/257, https://github.com/github/copilot-cli/issues/259)
- Fixed a wrapping issue in multi-line prompts with empty lines

## 0.0.337 - 2025-10-08

- Added validation for MCP server names (fixes https://github.com/github/copilot-cli/issues/110)
- Added support for Ctrl+B and Ctrl+F for moving cursor back and forward (fixes https://github.com/github/copilot-cli/issues/214)
- Added support for multi-line input for terminals that support the [Kitty protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) (partially fixes https://github.com/github/copilot-cli/issues/14 -- broader terminal support coming soon!)
- Updated the OAuth login UI to begin polling as soon as the device code is generated (this will _more solidly_ fix SSH edge-cases as described in https://github.com/github/copilot-cli/issues/89)

## 0.0.336 - 2025-10-07

- Enabled proxy support via HTTPS_PROXY/HTTP_PROXY environment variables regardless of Node version (Fixes https://github.com/github/copilot-cli/issues/41)
- Significantly reduced token consumption, round trips per problem, and time to result. We'll share more specific data in our weekly changelog on Friday!
- Improved file write performances (especially on Windows) by not relying on the shell to fetch the current working directory
- Fixed a bug where `/clear` did not properly reset the context truncation tracking state
- Hid the "Welcome to GitHub Copilot CLI" welcome message on session resumption and `/clear` for a cleaner look
- Improved the alignment of tables where the scrollbar is present
- Improved the output of `--help` by making it more concise
- Added a prompt for users who launch with `--screen-reader` to persistently save this preference
- Potentially improved flickering in some cases; we're still working on this!

## 0.0.335 - 2025-10-06

- Improved visibility into file edits by showing file diffs in the timeline by default, without the need to Ctrl+R
- Improved slash command input by showing argument hints in the input box
- Improved the display of the interface in windows less than 80 columns wide
- Reduced the number of colors and improved the spacing of Markdown rendering
- Added a warning when attempting to use proxy support in an environment where it won't work (Node <24, required environment variables not set) (A more permanent fix for https://github.com/github/copilot-cli/issues/41 is coming ~tomorrow)
- Updated the context truncation message's color from an error color to a warning color
- Fixed a bug where `copilot` logs might not have been properly created on Windows
- Fixed a bug where Powershell users with custom profiles might have had issues running commands (Fixes https://github.com/github/copilot-cli/issues/196)
- Fixed a bug where prompts were truncated after pasting and other edge cases (Fixes https://github.com/github/copilot-cli/issues/208, https://github.com/github/copilot-cli/issues/218)
- Fixed a bug where users would see a login prompt on startup despite being logged in (fixes https://github.com/github/copilot-cli/issues/202)
- Fixed a bug where some SSH users in certain environments were unable to get the OAuth login link and had their processes hang trying to open a browser (fixes https://github.com/github/copilot-cli/issues/89)

## 0.0.334 - 2025-10-03

- Improved the experience of pasting large content: when pasting more than 10 lines, it's displayed as a compact token like `[Paste #1 - 15 lines]` instead of flooding the terminal.
- Added a warning when conversation context approaches ≤20% remaining of the model's limit that truncation will soon occur. At this point, we recommend you begin a new session (improves https://github.com/github/copilot-cli/issues/29)
- Removed the on-exit usage stats from the persisted session history
- Added the current version to startup logs to aid in bug reporting
- Removed cycling through TAB autocomplete items if an argument is present. This prevents running `/cwd /path/to/whatever`, hitting `TAB`, then seeing `/clear` autocomplete

## 0.0.333 - 2025-10-02

- Added image support! `@`-mention files to add them as input to the model. 
- Improved proxy support for users on Node.JS v24+. See [this comment](https://github.com/github/copilot-cli/issues/41#issuecomment-3362444262) for more details (Fixes https://github.com/github/copilot-cli/issues/41)
- Added support for directly executing shell commands and bypassing the model by prepending input with `!` (fixes https://github.com/github/copilot-cli/issues/186, https://github.com/github/copilot-cli/issues/12)
- Added `/usage` slash command to provide stats about Premium request usage, session time, code changes, and per-model token use. This information is also printed at the conclusion of a session (Fixes https://github.com/github/copilot-cli/issues/27, https://github.com/github/copilot-cli/issues/121)
- Improved `--screen-reader` mode by replacing icons in the timeline with informative labels
- Added a `--continue` flag to resume the most recently closed session
- Updated the `/clear` command to properly clear old timeline entries/session information (Fixes https://github.com/github/copilot-cli/issues/170)

## 0.0.332 - 2025-10-01

- Switched to using per-subscription Copilot API endpoints in accordance with [GitHub's docs](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/manage-access/manage-network-access) (fixes https://github.com/github/copilot-cli/issues/76)
- Fixed a bug where `/user [list | show | swtich]` did not include users signed in from all authentication modes (fixes https://github.com/github/copilot-cli/issues/58)
- Fixed a bug where switching to another user with `/user switch` did not take effect in the GitHub MCP server
- Improved the screenreader experience by disabling the scrollbar in the `@` file picker, the `--resume` session picker, and the `/` command picker
- Improved the polish of the scrollbar container (increased the width, reduced the opacity of the gutter)
- Minor visual improvements to the input area (moved the current model indicator to the right so it's not cramped with the CWD, improved the positioning of the file picker's "indexing" indicator, improved hint formatting in completion menus)
- Improved Markdown legibility by excluding `#` prefixes in headings
- Improved how we extract paths from shell commands for permission handling (might fix https://github.com/github/copilot-cli/issues/159, https://github.com/github/copilot-cli/issues/67)

## 0.0.331 - 2025-10-01

- Improved the information density of file read/edit timeline events
- Fixed an inaccuracy in the `--banner` help text; it previously implied that it would persistently change the configuration to always show the startup banner
- Improved the `/model`s list to ensure that a user only sees models they have access to use -- previously, if a user tries to use a model they do not have access to (because of their Copilot plan, their geographic region, etc), they received a `model_not_supported` error. This should prevent that by not even showing such models as options in the list (Fixes https://github.com/github/copilot-cli/issues/112, https://github.com/github/copilot-cli/issues/85, https://github.com/github/copilot-cli/issues/40)
- Fixed a bug where pressing down arrow in a multi-line prompt would wrap around to the first line (This is on the way to implementing https://github.com/github/copilot-cli/issues/14)
- Added a scrollbar to the `@` file mentioning picker and increased the size of the active buffer to 10 items
- Improved the experience of writing prompts while the agent is running -- up/down arrows will now correctly navigate between options in the `@` and `/` menus

## 0.0.330 - 2025-09-29

- Changed the default model back to Sonnet 4 since Sonnet 4.5 hasn't rolled out to all users yet. Sonnet 4.5 is still available from the `/model` slash command

## 0.0.329 - 2025-09-29

- Added support for [Claude Sonnet 4.5](https://github.blog/changelog/2025-09-29-anthropic-claude-sonnet-4-5-is-in-public-preview-for-github-copilot/) and made it the default model
- Added `/model` slash command to easily change the model (fixes https://github.com/github/copilot-cli/issues/10)
    - `/model` will open a picker to change the model
    - `/model <model>` will set the model to the parameter provided
- Added display of currently selected model above the input text box (Addresses feedback in https://github.com/github/copilot-cli/issues/120, https://github.com/github/copilot-cli/issues/108, )
- Improved error messages when users provide incorrect command-line arguments. (Addresses feedback of the discoverability of non-interactive mode from  https://github.com/github/copilot-cli/issues/96)
- Changed the behavior of `Ctrl+r` to expand only recent timeline items. After running `Ctrl+r`, you can use `Ctrl+e` to expand all
- Improved word motion logic to better detect newlines: using word motion keys will now correctly move to the first word on a line
- Improved the handling of multi-line inputs in the input box: the input text box is scrollable, limited to 10 lines. Long prompts won't take up the whole screen anymore! (This is on the way to implementing https://github.com/github/copilot-cli/issues/14)
- Removed the left and right boarders from the input box. This makes it easier to copy text out of it!
- Added glob matching to shell rules. When using `--allow-tool` and `--deny-tool`, you can now specify things like `shell(npm run test:*)` to match any shell commands beginning with `npm run test`
- Improved the `copilot --resume` interface with relative time display, session message count, (Fixes https://github.com/github/copilot-cli/issues/97) 

## 0.0.328 - 2025-09-26

- Improved error message received when Copilot CLI is blocked by organization policy (fixes https://github.com/github/copilot-cli/issues/18 )
- Improved the error message received when using a PAT that is missing the "Copilot Requests" permission (fixes https://github.com/github/copilot-cli/issues/46 )
- Improved the output of `/user list` to make it clearer which is the current user
- Improved PowerShell parsing of `ForEach-Object` and detection of command name expressions (e.g.,`& $someCommand`)
