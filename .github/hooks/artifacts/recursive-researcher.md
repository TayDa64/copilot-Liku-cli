## Research Report

### Query
Read-only discovery in c:\dev\copilot-Liku-cli for existing proof, evaluator, and history infrastructure related to JSONL proof history, suite runs, model selection, pass or fail recording, and behavioral regression suites. Focus on scripts, src/cli, docs, package.json, and proof artifacts.

### Sources Examined
- [package.json](package.json#L9)
- [scripts/run-chat-inline-proof.js](scripts/run-chat-inline-proof.js#L9)
- [scripts/test-chat-inline-proof-evaluator.js](scripts/test-chat-inline-proof-evaluator.js#L6)
- [scripts/test-v015-cognitive-layer.js](scripts/test-v015-cognitive-layer.js#L260)
- [src/cli/liku.js](src/cli/liku.js#L38)
- [src/cli/commands/chat.js](src/cli/commands/chat.js#L224)
- [src/cli/commands/analytics.js](src/cli/commands/analytics.js#L2)
- [src/main/ai-service.js](src/main/ai-service.js#L152)
- [src/main/ai-service/commands.js](src/main/ai-service/commands.js#L25)
- [src/main/ai-service/providers/registry.js](src/main/ai-service/providers/registry.js#L1)
- [src/main/ai-service/providers/orchestration.js](src/main/ai-service/providers/orchestration.js#L149)
- [src/main/ai-service/providers/copilot/model-registry.js](src/main/ai-service/providers/copilot/model-registry.js#L15)
- [src/main/telemetry/telemetry-writer.js](src/main/telemetry/telemetry-writer.js#L17)
- [src/main/telemetry/reflection-trigger.js](src/main/telemetry/reflection-trigger.js#L24)
- [README.md](README.md#L268)
- [CONFIGURATION.md](CONFIGURATION.md#L33)
- [ARCHITECTURE.md](ARCHITECTURE.md#L58)
- [docs/AGENT_ORCHESTRATION.md](docs/AGENT_ORCHESTRATION.md#L133)
- [.github/hooks/scripts/subagent-quality-gate.ps1](.github/hooks/scripts/subagent-quality-gate.ps1#L31)
- [.github/hooks/scripts/audit-log.ps1](.github/hooks/scripts/audit-log.ps1#L16)
- [.github/hooks/artifacts/recursive-researcher.md](.github/hooks/artifacts/recursive-researcher.md#L1)

### Key Findings
1. There is one dedicated chat proof-history path today, and it is script-level rather than productized. [scripts/run-chat-inline-proof.js](scripts/run-chat-inline-proof.js#L9) writes transcript traces to ~/.liku-cli/traces/chat-inline-proof and appends run summaries to ~/.liku-cli/telemetry/logs/chat-inline-proof-results.jsonl. Its proof cases live in the in-file SUITES table at [scripts/run-chat-inline-proof.js](scripts/run-chat-inline-proof.js#L12), command construction is centralized in [scripts/run-chat-inline-proof.js](scripts/run-chat-inline-proof.js#L248), and JSONL persistence happens in [scripts/run-chat-inline-proof.js](scripts/run-chat-inline-proof.js#L371) through [scripts/run-chat-inline-proof.js](scripts/run-chat-inline-proof.js#L396).
2. The proof runner already supports suite-oriented execution, but only through direct node invocation. The current flags are surfaced in [scripts/run-chat-inline-proof.js](scripts/run-chat-inline-proof.js#L441) through [scripts/run-chat-inline-proof.js](scripts/run-chat-inline-proof.js#L448): list suites, run all, choose one suite, and switch between local and global liku. There is no matching npm script in [package.json](package.json#L9), and the runner is not referenced in README search surfaces, so it is currently discoverable only from the code.
3. The evaluator layer for that proof runner is cleanly separated and already unit tested. [scripts/test-chat-inline-proof-evaluator.js](scripts/test-chat-inline-proof-evaluator.js#L6) imports SUITES plus extractAssistantTurns and evaluateTranscript from the runner, then characterizes direct-navigation, safety-boundaries, recovery, and acknowledgement behaviors at [scripts/test-chat-inline-proof-evaluator.js](scripts/test-chat-inline-proof-evaluator.js#L33), [scripts/test-chat-inline-proof-evaluator.js](scripts/test-chat-inline-proof-evaluator.js#L106), and neighboring assertions.
4. Pass or fail recording for the broader system already exists through the telemetry JSONL pipeline, separate from the proof-runner JSONL file. [src/main/telemetry/telemetry-writer.js](src/main/telemetry/telemetry-writer.js#L17) defines the daily telemetry directory and 10 MB rotation, [src/main/telemetry/telemetry-writer.js](src/main/telemetry/telemetry-writer.js#L91) reads daily logs back, and [src/main/telemetry/telemetry-writer.js](src/main/telemetry/telemetry-writer.js#L154) computes summaries. The CLI surface for this is [src/cli/commands/analytics.js](src/cli/commands/analytics.js#L2), with raw and JSON output options documented at [src/cli/commands/analytics.js](src/cli/commands/analytics.js#L122).
5. Reflection and failure-threshold behavior is also already wired. [src/main/telemetry/reflection-trigger.js](src/main/telemetry/reflection-trigger.js#L24) sets the current thresholds at 2 consecutive failures or 3 session failures, and [src/main/telemetry/reflection-trigger.js](src/main/telemetry/reflection-trigger.js#L38) records outcomes before deciding whether to reflect. The regression harness in [scripts/test-v015-cognitive-layer.js](scripts/test-v015-cognitive-layer.js#L247) verifies telemetry accessors, confirms daily JSONL creation at [scripts/test-v015-cognitive-layer.js](scripts/test-v015-cognitive-layer.js#L260), checks telemetry summary analytics at [scripts/test-v015-cognitive-layer.js](scripts/test-v015-cognitive-layer.js#L704), and covers cross-model reflection plus the /rmodel command at [scripts/test-v015-cognitive-layer.js](scripts/test-v015-cognitive-layer.js#L1051).
6. Model selection is configured in four distinct places. Persistence lives in [src/main/ai-service.js](src/main/ai-service.js#L152) through [src/main/ai-service.js](src/main/ai-service.js#L158), which points at model-preference.json and copilot-runtime-state.json under ~/.liku-cli. Static and dynamically discovered Copilot inventories live in [src/main/ai-service/providers/copilot/model-registry.js](src/main/ai-service/providers/copilot/model-registry.js#L28), aliases such as gpt-5.4 to gpt-4o live in [src/main/ai-service/providers/copilot/model-registry.js](src/main/ai-service/providers/copilot/model-registry.js#L15), persisted runtime fallback state is recorded at [src/main/ai-service/providers/copilot/model-registry.js](src/main/ai-service/providers/copilot/model-registry.js#L552) and [src/main/ai-service/providers/copilot/model-registry.js](src/main/ai-service/providers/copilot/model-registry.js#L569), and live discovery is in [src/main/ai-service/providers/copilot/model-registry.js](src/main/ai-service/providers/copilot/model-registry.js#L461).
7. User-facing model control already has both CLI and runtime seams. Terminal chat accepts a model argument at [src/cli/commands/chat.js](src/cli/commands/chat.js#L344), supports an interactive picker at [src/cli/commands/chat.js](src/cli/commands/chat.js#L224), discovers models on demand at [src/cli/commands/chat.js](src/cli/commands/chat.js#L594), and routes picker confirmation through the same slash-command path at [src/cli/commands/chat.js](src/cli/commands/chat.js#L644). Shared slash-command formatting and aliases live in [src/main/ai-service/commands.js](src/main/ai-service/commands.js#L25), [src/main/ai-service/commands.js](src/main/ai-service/commands.js#L92), and [src/main/ai-service/commands.js](src/main/ai-service/commands.js#L222). The compatibility facade still exposes /model, /rmodel, and /status directly in [src/main/ai-service.js](src/main/ai-service.js#L1575), [src/main/ai-service.js](src/main/ai-service.js#L1697), and [src/main/ai-service.js](src/main/ai-service.js#L1750).
8. Backend routing for model-specific behavior is already capability-aware, which makes it the safest place to rely on for model-targeted runs. Provider defaults are declared in [src/main/ai-service/providers/registry.js](src/main/ai-service/providers/registry.js#L1) through [src/main/ai-service/providers/registry.js](src/main/ai-service/providers/registry.js#L9). Capability reroutes and notices are implemented in [src/main/ai-service/providers/orchestration.js](src/main/ai-service/providers/orchestration.js#L59), [src/main/ai-service/providers/orchestration.js](src/main/ai-service/providers/orchestration.js#L78), [src/main/ai-service/providers/orchestration.js](src/main/ai-service/providers/orchestration.js#L149), and [src/main/ai-service/providers/orchestration.js](src/main/ai-service/providers/orchestration.js#L197). This means configured, requested, and runtime model can already diverge safely and be reported back.
9. The existing behavioral regression surface is broader than the proof runner. Package-level entry points are limited to start, smoke, smoke:chat-direct, smoke:shortcuts, test, and test:ui in [package.json](package.json#L9). CLI command inventory includes chat, analytics, verify-hash, verify-stable, memory, skills, and tools in [src/cli/liku.js](src/cli/liku.js#L38) through [src/cli/liku.js](src/cli/liku.js#L57). Documentation and characterization coverage point at [README.md](README.md#L268), [CONTRIBUTING.md](CONTRIBUTING.md#L60), and [ARCHITECTURE.md](ARCHITECTURE.md#L75), while [changelog.md](changelog.md#L18) records the larger current suite volume as 310 cognitive plus 29 regression assertions.
10. Hook artifacts are a separate proof channel from both telemetry and inline-proof JSONL. [docs/AGENT_ORCHESTRATION.md](docs/AGENT_ORCHESTRATION.md#L133) through [docs/AGENT_ORCHESTRATION.md](docs/AGENT_ORCHESTRATION.md#L167) describe the artifact-backed quality gate. [subagent-quality-gate.ps1](.github/hooks/scripts/subagent-quality-gate.ps1#L31) reads an agent-scoped markdown artifact, validates expected sections including Recommended Next Agent for researchers at [subagent-quality-gate.ps1](.github/hooks/scripts/subagent-quality-gate.ps1#L75), and appends quality entries to subagent-quality.jsonl at [subagent-quality-gate.ps1](.github/hooks/scripts/subagent-quality-gate.ps1#L60). Tool invocations are separately audited to tool-audit.jsonl by [audit-log.ps1](.github/hooks/scripts/audit-log.ps1#L16). Existing proof artifacts already live in [.github/hooks/artifacts](.github/hooks/artifacts).

### Current Commands And Scripts Already Available
- npm run start, npm run smoke, npm run smoke:chat-direct, npm run smoke:shortcuts, npm run test, npm run test:ui from [package.json](package.json#L9).
- liku chat, liku analytics, liku verify-hash, liku verify-stable, liku memory, liku skills, liku tools from [src/cli/liku.js](src/cli/liku.js#L38).
- liku chat supports --model and in-chat /model, /rmodel, and /status via [src/cli/commands/chat.js](src/cli/commands/chat.js#L344), [src/main/ai-service.js](src/main/ai-service.js#L1575), and [src/main/ai-service.js](src/main/ai-service.js#L1697).
- liku analytics supports --days, --raw, and --json via [src/cli/commands/analytics.js](src/cli/commands/analytics.js#L122).
- Direct proof runner: node scripts/run-chat-inline-proof.js --list-suites, --suite name, --all, --global, and --no-save, based on [scripts/run-chat-inline-proof.js](scripts/run-chat-inline-proof.js#L441).
- Direct evaluator test: node scripts/test-chat-inline-proof-evaluator.js from [scripts/test-chat-inline-proof-evaluator.js](scripts/test-chat-inline-proof-evaluator.js#L6).
- Broader regression scripts documented or present include test-ai-service-contract, test-ai-service-commands, test-ai-service-provider-orchestration, test-ai-service-model-registry, test-v015-cognitive-layer, and test-hook-artifacts in [README.md](README.md#L268) through [README.md](README.md#L286).

### Where Model Selection Is Configured
- Persisted user preference: [src/main/ai-service.js](src/main/ai-service.js#L152).
- Persisted runtime validation and fallback state: [src/main/ai-service.js](src/main/ai-service.js#L153) and [src/main/ai-service/providers/copilot/model-registry.js](src/main/ai-service/providers/copilot/model-registry.js#L569).
- Static Copilot inventory and aliases: [src/main/ai-service/providers/copilot/model-registry.js](src/main/ai-service/providers/copilot/model-registry.js#L15) and [src/main/ai-service/providers/copilot/model-registry.js](src/main/ai-service/providers/copilot/model-registry.js#L28).
- Dynamic discovery from Copilot endpoints: [src/main/ai-service/providers/copilot/model-registry.js](src/main/ai-service/providers/copilot/model-registry.js#L461).
- Provider-specific default routing targets such as chatModel, visionModel, reasoningModel, and automationModel: [src/main/ai-service/providers/registry.js](src/main/ai-service/providers/registry.js#L1).
- User-facing grouped display and aliases for /model: [src/main/ai-service/commands.js](src/main/ai-service/commands.js#L25) and [src/main/ai-service/commands.js](src/main/ai-service/commands.js#L222).
- Capability-based rerouting for actual execution: [src/main/ai-service/providers/orchestration.js](src/main/ai-service/providers/orchestration.js#L149).

### Safest Extension Points
1. Summary script: read chat-inline-proof-results.jsonl, not the transcript .log files, because the structured payload already captures suite name, mode, executeMode, pass or fail, exitCode, failures, and tracePath at [scripts/run-chat-inline-proof.js](scripts/run-chat-inline-proof.js#L371). The cleanest pattern is to mirror the read and aggregate approach from [src/cli/commands/analytics.js](src/cli/commands/analytics.js#L34) and [src/main/telemetry/telemetry-writer.js](src/main/telemetry/telemetry-writer.js#L91), but keep proof summaries separate from daily telemetry because the schemas and file naming differ.
2. Model-specific runs: extend [scripts/run-chat-inline-proof.js](scripts/run-chat-inline-proof.js#L248) so buildCommand accepts and forwards a model option into liku chat --model. That is lower risk than trying to bypass the runtime, because [src/cli/commands/chat.js](src/cli/commands/chat.js#L344) already accepts the flag and [src/main/ai-service/providers/orchestration.js](src/main/ai-service/providers/orchestration.js#L149) already handles capability reroutes and status reporting.
3. Tighter regression suites for inline proof behavior: add or refine SUITES entries in [scripts/run-chat-inline-proof.js](scripts/run-chat-inline-proof.js#L12), then add evaluator-only characterization cases in [scripts/test-chat-inline-proof-evaluator.js](scripts/test-chat-inline-proof-evaluator.js#L33). That keeps transcript semantics testable without requiring live chat every time.
4. Tighter regression suites for model routing and pass or fail semantics: add focused assertions next to [scripts/test-ai-service-provider-orchestration.js](scripts/test-ai-service-provider-orchestration.js#L49) and [scripts/test-ai-service-model-registry.js](scripts/test-ai-service-model-registry.js#L34), because those already characterize reroutes, requested versus runtime model divergence, persisted aliases, and inventory behavior.
5. Tighter regression suites for broader behavior recording: lean on [scripts/test-v015-cognitive-layer.js](scripts/test-v015-cognitive-layer.js#L260) for telemetry creation, summaries, reflection thresholds, and /rmodel behavior instead of folding those concerns into the inline-proof runner.
6. Hook-proof summaries: if you need agent-proof summaries rather than chat-proof summaries, the stable seam is artifact generation in [.github/hooks/artifacts](.github/hooks/artifacts) plus validation in [subagent-quality-gate.ps1](.github/hooks/scripts/subagent-quality-gate.ps1#L31), not telemetry or chat proof logs.

### Evidence
- Dedicated inline proof JSONL writer: [scripts/run-chat-inline-proof.js](scripts/run-chat-inline-proof.js#L396)
- Dedicated inline proof trace logs: [scripts/run-chat-inline-proof.js](scripts/run-chat-inline-proof.js#L375)
- Telemetry JSONL directory and rotation: [src/main/telemetry/telemetry-writer.js](src/main/telemetry/telemetry-writer.js#L17)
- Telemetry summary aggregation: [src/main/telemetry/telemetry-writer.js](src/main/telemetry/telemetry-writer.js#L154)
- Analytics CLI over telemetry: [src/cli/commands/analytics.js](src/cli/commands/analytics.js#L34)
- Persisted model preference and runtime files: [src/main/ai-service.js](src/main/ai-service.js#L152)
- Capability-aware routing and reroute notices: [src/main/ai-service/providers/orchestration.js](src/main/ai-service/providers/orchestration.js#L149)
- Current /model grouped UX: [src/main/ai-service/commands.js](src/main/ai-service/commands.js#L92)
- Interactive terminal model picker: [src/cli/commands/chat.js](src/cli/commands/chat.js#L224)
- Hook artifact quality checks and JSONL logging: [subagent-quality-gate.ps1](.github/hooks/scripts/subagent-quality-gate.ps1#L60) and [audit-log.ps1](.github/hooks/scripts/audit-log.ps1#L16)

### Gaps
- There is no existing summary script for chat-inline-proof-results.jsonl.
- The inline proof runner is not exposed through package.json scripts or documented in README-level quick-verify flows.
- The inline proof runner does not currently expose a first-class model flag even though the underlying chat command already supports one.
- The repo has strong telemetry analytics, but no equivalent first-class analytics command for the dedicated inline proof JSONL file.

### Recommended Next Agent
- Architect

### Recommendations
1. If the next task is reporting only, add a small proof-summary reader over chat-inline-proof-results.jsonl and leave telemetry analytics untouched.
2. If the next task is model-by-model proofing, thread a model option through run-chat-inline-proof.js into liku chat --model and let orchestration continue to own fallback behavior.
3. If the next task is regression hardening, add new suite cases in the inline proof runner and keep routing and telemetry assertions in their existing ai-service and cognitive-layer tests instead of collapsing everything into one mega-suite.