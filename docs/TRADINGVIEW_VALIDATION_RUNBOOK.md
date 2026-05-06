# TradingView validation runbook

This runbook keeps delegated TradingView work grounded in the current codebase instead of stale branch state or blueprint assumptions.

## Current source of truth

The TradingView modularization slices represented by planning issues #10-#16 are complete and merged through implementation PRs #19-#25. Those issues are closed; future changes should use implementation PRs directly unless a separate planning issue is explicitly needed.

The canonical TradingView facade is `src\main\tools\tradingview-tool.js`. It owns registration for:

- rewrite handlers through `src\main\ai-service\rewrite-registry.js`
- risk assessors through `src\main\ai-service\risk-registry.js`
- Pine authoring system contracts through `src\main\ai-service\system-contract-registry.js`
- observation/checkpoint providers through `src\main\ai-service\observation-provider-registry.js`
- Pine resume lifecycle hooks through `src\main\ai-service\lifecycle-hooks.js`

Tool rewrite/risk registries are default-on. Use `LIKU_USE_TOOL_REGISTRY_REWRITES=0` or `LIKU_USE_TOOL_REGISTRY_RISKS=0` only as temporary legacy-path escape hatches during compatibility checks.

## Source-of-truth workflow

1. Start from the GitHub branch or PR named by the task.
2. Cite the current owning files/functions before editing.
3. Check whether related implementation already exists on another branch, especially PR #7 / `feature/automation-host-migration`, before copying assumptions into `main`.
4. Keep generated outputs and local artifacts out of commits.
5. Implement locally, run focused validation first, commit/push passing changes, open the implementation PR, and merge/close it promptly once validated.

For GPT-5.2 coding/cloud-agent work, choose GPT-5.2 for the parent/session model. Do not rely only on subagent `model:` frontmatter. For Pine create/save live validation or operator-guidance runs that explicitly consult model guidance, prefer `gpt-4o` only for that validation lane instead of changing broader repo defaults.

## Validation layers

Use the narrowest deterministic test first, then broaden only when the touched behavior crosses runtime boundaries.

| Layer | Use for | Examples |
| --- | --- | --- |
| Focused Node tests | Module contracts, rewrite parity, safety rules | `node scripts\test-ai-service-contract.js`, `node scripts\test-tradingview-paper-workflows.js` |
| AI/runtime bundle | Cross-module AI-service behavior | `npm run test:ai-focused` |
| Windows observation flow | Focus lock, watcher/checkpoint semantics, bounded TradingView workflows | `npm run test:windows-observation-flow` |
| Live `liku chat` | Real foreground/input routing and final app state | Manual command through `npm run liku -- chat` |
| Browser/Playwright proof | Browser-visible TradingView state after Liku actions | Optional, artifact-oriented, not a direct DOM trading executor |

## TradingView live checks

Use the opt-in live smoke harness when a PR changes TradingView foreground routing, Pine Editor workflows, chart state workflows, observation checkpoints, or safety/resume behavior:

```powershell
npm run smoke:tradingview-live -- --dry-run
npm run smoke:tradingview-live -- --scenarios focus,pine-editor
```

The harness requires an already-open TradingView session and intentionally runs one scenario sequence at a time to avoid foreground/window contention. It is not part of `npm test`; run it only when live Windows UIA evidence is relevant.

By default, live output is written to `artifacts\live-validation\` and includes per-scenario `*.summary.json` files plus a run `*.manifest.json`. When runtime tracing is available, summaries also link the exported trace artifact for the scenario.

When a PR changes TradingView runtime behavior, include evidence for:

1. TradingView is the actual foreground target before input begins.
2. Quick-search text is empty or authoritatively replaced before typing.
3. Input does not route to VS Code or another foreground app.
4. Final chart, panel, Pine Editor, or alert state matches the requested workflow.
5. Runtime trace or summary artifacts are attached if behavior diverges from deterministic tests.

Unexpected VS Code Accessibility View popups are evidence that keyboard input may have routed to VS Code instead of TradingView. Treat any result after that as suspicious until reproduced with correct focus.

## Browser/Playwright proof

Playwright evidence is optional and secondary. Use it only to inspect browser-visible TradingView state after Liku has performed the workflow; do not use Playwright to directly mutate TradingView DOM state, place orders, bypass confirmations, or replace the Windows UIA/native execution path.

If browser proof is attached, include the Liku live smoke manifest or summary alongside the Playwright artifact so reviewers can confirm the browser state was produced by Liku-controlled actions.

## Safety boundaries

- Live TradingView order-entry and unknown trading mode remain fail-closed.
- High-confidence Paper Trading DOM order-entry requires explicit confirmation and resumes only through the Liku confirmation flow.
- TradingView position-management controls such as flatten, reverse, cancel all, and close position remain blocked.
- Pine Editor opening uses `Ctrl+E` only when TradingView chart focus is established; otherwise use the verified quick-search fallback.
- Playwright may validate browser-visible outcomes, but it must not replace Liku's execution path for order-entry or position-management actions.
