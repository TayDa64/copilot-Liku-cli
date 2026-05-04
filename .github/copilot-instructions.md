# Copilot instructions for copilot-Liku-cli

## Build, run, and test commands

- Install root dependencies with `npm install`. Electron is an optional dependency; headless CLI paths should keep working when the Electron runtime is unavailable.
- Run the app with `npm start`, `npm run liku -- start`, or `npm run liku -- chat`.
- Build native Windows automation hosts with `npm run build:uia` and `npm run build:automation-host`.
- Run the default root test with `npm test` (`node scripts\test-grid.js`).
- Run a single focused test by invoking its script directly, for example `node scripts\test-ai-service-contract.js`.
- Run the high-value AI/runtime regression bundle with `npm run test:ai-focused`.
- Run UI/runtime smoke checks with `npm run smoke:shortcuts`, `npm run smoke:chat-direct`, `npm run test:ui`, or `npm run smoke`.
- For transcript regressions: list fixtures with `npm run regression:transcripts -- --list`; run one fixture with `npm run regression:transcripts -- --fixture <fixture-name>`.
- For inline proof harnesses: list suites with `npm run proof:inline -- --list-suites`; run one suite with `npm run proof:inline -- --suite <suite-name>`.
- For `.github\hooks` or artifact contract changes, run `node scripts\test-hook-artifacts.js` or `powershell -NoProfile -File scripts\test-hook-artifacts.ps1`.
- The `ultimate-ai-system` subtree is a separate pnpm/Turbo TypeScript workspace: from `ultimate-ai-system`, use `pnpm install`, `pnpm run build`, and `pnpm run typecheck`.

## High-level architecture

- The root package is a CommonJS Node/Electron CLI application. `src\cli\liku.js` dispatches top-level commands to `src\cli\commands\*.js`; bare `liku`/`liku start` launches Electron, while `liku chat` runs terminal-first chat.
- `src\main\index.js` owns the Electron main process, tray/hotkeys, overlay/chat windows, and Electron-only orchestration commands. Renderers live under `src\renderer\overlay` and `src\renderer\chat` with preload bridges.
- `src\main\ai-service.js` is the compatibility facade used by the CLI, Electron runtime, and tests. Keep it as the public entrypoint while implementation is split into `src\main\ai-service\*` modules such as message building, slash commands, provider orchestration, policy enforcement, visual/UI context, and Copilot response parsing.
- UI automation flows through `src\main\system-automation.js` and `src\main\ui-automation\`. Prefer semantic UIA/pattern actions when available, then bounded mouse/keyboard fallbacks. Windows is the best-supported platform because of the native/.NET UI Automation hosts under `src\native` and `src\dotnet`.
- Visual awareness combines screenshots, active-window/watcher state, overlay grid math, and inspect metadata. Shared coordinate math lives in `src\shared\grid-math.js`; keep renderer, main-process automation, and AI prompt grounding aligned to it.
- Runtime state is persisted under `~\.liku\` via `src\shared\liku-home.js`: memory notes, skills, dynamic/proposed tools, telemetry logs, traces, preferences, Copilot tokens, and model preference state.
- The cognitive/tooling layer includes memory and skill routing under `src\main\memory`, telemetry/reflection under `src\main\telemetry`, dynamic tool sandboxing under `src\main\tools`, and agent orchestration under `src\main\agents`.
- TradingView support is advisory/observational. TradingView DOM order-entry and position-management actions are intentionally blocked before execution; Pine/chart/alert workflows rely on checkpointed observation and focus validation.
- `.github\agents`, `.github\hooks`, and `docs\AGENT_ORCHESTRATION.md` define a custom coordinator/worker workflow. Hooks enforce read-only roles, audit tool calls, and require artifact-backed evidence under `.github\hooks\artifacts`.
- `ultimate-ai-system` is an independent ESM TypeScript workspace for the newer Liku core/CLI/VS Code extension (`@liku/core`, `@liku/cli`, `ultimate-ai-architect`) and should not be treated as part of the root CommonJS runtime.

## Repo-specific conventions

- Do not regress established CLI, Electron, automation, memory, skill, tracing, and TradingView safety behavior while adding new functionality. Preserve existing exports, command names, persisted state formats, and documented workflows unless the task explicitly calls for a breaking change.
- Build modularly: put new behavior behind the existing seams (`src\main\ai-service\*`, `src\main\tradingview\*`, `src\main\ui-automation\*`, `src\cli\commands\*`) instead of expanding monolithic paths unnecessarily. Keep `src\main\ai-service.js` as the facade that composes modules.
- Ground implementations in the codebase source of truth before editing. Check the active registry/facade/config/test that owns the behavior, such as `src\cli\liku.js` for CLI commands, `src\main\index.js` for Electron shortcuts/orchestration, `src\shared\grid-math.js` for targeting math, `src\main\ai-service.js` for public AI-service contract, and `TESTING.md` for validation strategy.
- CLI command modules usually export `run(args, options)` and are registered in the `COMMANDS` map in `src\cli\liku.js`. Use `src\cli\util\output.js` helpers for human output and preserve `--json`/`--quiet` behavior where commands already support it.
- Tests are custom Node scripts using `assert`, small local `test(name, fn)` helpers, and non-zero exits rather than Jest/Vitest. Add or run the narrowest relevant `scripts\test-*.js` first, then the focused bundle or smoke layer when behavior crosses runtime boundaries.
- When refactoring `src\main\ai-service.js`, preserve facade exports and source-sensitive regression markers; several tests protect exported shapes and still inspect literal strings in the facade.
- For AI-service, provider, model, continuation, visual-context, or slash-command behavior, prefer the focused characterization scripts listed in `TESTING.md` before broader Electron smoke checks.
- TradingView automation changes require live `liku chat` validation in addition to green observation-flow tests. Confirm the actual foreground target, quick-search clearing/replacement, and final chart/panel state; treat unexpected VS Code Accessibility View popups as evidence that keyboard input may have routed to the wrong app.
- Runtime tracing is enabled by default for action execution. Set `LIKU_DISABLE_RUNTIME_TRACE=1` or pass `disableRuntimeTrace: true` only when a test intentionally needs tracing disabled.
- Dynamic tools are fail-closed: proposals are quarantined under `~\.liku\tools\proposed`, promotion moves approved tools to `~\.liku\tools\dynamic`, and sandbox execution runs in a stripped child process with allowlisted globals.
- Keep safety boundaries explicit. High-risk/critical actions should go through existing confirmation/policy flows; do not bypass advisory-only TradingView rails, focus-lock checks, or observation checkpoints to make a test pass.
- Root code uses CommonJS (`require`, `module.exports`), while `ultimate-ai-system` uses ESM TypeScript (`"type": "module"`, NodeNext, strict TS). Match the module system of the area being edited.
