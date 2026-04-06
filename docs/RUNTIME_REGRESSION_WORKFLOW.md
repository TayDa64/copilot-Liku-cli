# Runtime Regression Workflow

## Goal

Turn a real `liku chat` runtime finding into a checked-in, repeatable regression with as little friction as possible.

Important: if a live run disagrees with a green synthetic suite, the live run wins. Convert the live behavior into a transcript or runtime-proof fixture instead of assuming the suite is the deeper truth.

This first N5 slice intentionally reuses the existing inline-proof transcript evaluator instead of introducing a second transcript engine. It now also supports proof-aware runtime trace fixtures. The workflow is:

1. capture a runtime transcript or reuse an inline-proof `.log`
2. sanitize it down to the smallest useful snippet or runtime trace
3. generate a transcript or runtime-proof fixture skeleton
4. tighten the generated expectations
5. run transcript regressions and the nearest focused behavior test
6. commit the fixture and the behavioral fix together

## Inputs supported in this slice

- plaintext `liku chat` transcripts
- inline-proof logs from `~/.liku/traces/chat-inline-proof/*.log`
- runtime action/proof JSONL traces from `~/.liku/traces/*.jsonl`
- pasted transcript text over stdin

Out of scope for this first slice:

- automatic replay of arbitrary telemetry or agent-trace files beyond the runtime proof trace shape
- full transcript-to-test generation without manual expectation review
- broad redaction/policy redesign for runtime capture

## Fixture format

Checked-in transcript fixtures live under:

- `scripts/fixtures/transcripts/`

The fixture bundle format is JSON with multiple named cases at the top level. Each case can include:

- `description`
- `source`
  - `capturedAt`
  - `tracePath` when relevant
  - observed provider/model metadata when available
- `transcriptLines`
- optional derived fields such as `prompts`, `assistantTurns`, and `observedHeaders`
- `notes`
- `expectations`

Proof-aware runtime cases may additionally include:

- `traceMeta`
- `actions`
- `proofExpectations`

Proof expectations can assert stable runtime-proof invariants such as:

- `minProofLevel`
- `status`
- `classification`
- `verifyKind`
- `targetId`
- `requiredCheckKind`
- `requiredCheckStatus`

Expectation semantics intentionally mirror the inline-proof harness:

- `scope: transcript` for whole-transcript checks
- `turn` for assistant-turn-specific checks
- `include`
- `exclude`
- `count`

Pattern entries are stored as JSON regex specs:

- `{ "regex": "Provider:\\s+copilot", "flags": "i" }`

## Commands

List transcript fixtures:

- `npm run regression:transcripts -- --list`

Run all transcript fixtures:

- `npm run regression:transcripts`

Run a single transcript fixture:

- `npm run regression:transcripts -- --fixture repo-boundary-clarification-runtime`

Generate a fixture skeleton from a transcript file:

- `npm run regression:extract -- --transcript-file C:\path\to\runtime.log --fixture-name repo-boundary-clarification`

Print a fixture skeleton without writing a file:

- `npm run regression:extract -- --transcript-file C:\path\to\runtime.log --stdout-only`

Generate a runtime-proof fixture from a JSONL runtime trace:

- `node scripts/extract-runtime-trace-regression.js --trace-file %USERPROFILE%\.liku\traces\runtime-123.jsonl --fixture-name runtime-proof-panel-open`

Print a runtime-proof fixture without writing it:

- `node scripts/extract-runtime-trace-regression.js --trace-file %USERPROFILE%\.liku\traces\runtime-123.jsonl --fixture-name runtime-proof-panel-open --print`

Capture the canonical persisted runtime-proof traces and refresh the checked-in runtime fixture bundle:

- `npm run regression:runtime:fixtures`

Capture only one canonical runtime-proof fixture:

- `npm run regression:runtime:fixtures -- --fixture runtime-proof-timeframe-updated`

## Recommended loop

### 1. Capture the failure

Prefer one of these sources:

- a fresh `liku chat` transcript
- an inline-proof log already saved under `~/.liku/traces/chat-inline-proof/`
- a runtime action/proof trace JSONL session under `~/.liku/traces/`
- a small hand-curated transcript excerpt from a runtime session

Keep only the lines that prove the invariant you care about. Smaller fixtures are easier to review and less brittle.

### 2. Generate a fixture skeleton

Run `regression:extract` against the sanitized transcript, or `extract-runtime-trace-regression.js` against a runtime trace JSONL.

The helpers derive:

- a fixture name
- prompts
- assistant turns
- observed provider/model headers
- placeholder expectations
- proof-aware action summaries and `proofExpectations` when the input is a runtime trace, including `verifyKind` and preferred proof checks when present

Treat those expectations as a draft, not finished truth.

### 3. Tighten expectations manually

Before checking in the fixture:

- remove incidental wording matches
- keep only invariants that prove the bug fix or safety behavior
- add `exclude` or `count` checks when they make the regression sharper

Good transcript fixtures assert the behavior that matters, not every line in the transcript.

### 4. Run the transcript regression and the nearest focused seam test

Minimum validation:

- `npm run regression:transcripts`
- `node scripts/test-transcript-regression-pipeline.js`

If the new fixture came from runtime action/proof traces, also run:

- `node scripts/test-ai-service-proof-trace.js`

Then run the nearest behavioral regression for the feature you touched, for example:

- `node scripts/test-windows-observation-flow.js`
- `node scripts/test-chat-actionability.js`
- `node scripts/test-bug-fixes.js`

### 5. Commit the fixture with the fix

The preferred N5 habit is:

- runtime finding
- transcript fixture
- focused code/test fix
- commit

That keeps new hardening work grounded in observed runtime behavior instead of reconstructed memory.

## Practical guidelines

1. Prefer sanitized transcript snippets over full raw dumps.
2. Use one fixture bundle with several named cases when the domain is closely related.
3. Keep transcript fixtures deterministic and stable enough to survive harmless wording drift.
4. If a transcript fixture starts growing broad, add or retain a narrower behavior test alongside it.
5. For runtime-proof fixtures, prefer asserting stable proof invariants such as `minProofLevel`, `status`, `classification`, `targetId`, or required check kinds instead of mirroring every trace field.

## Live-vs-Suite Escalation Rule

Use this escalation rule for TradingView and other focus-sensitive desktop automations:

- **green suite + bad live run** -> investigate the live run first
- **unexpected VS Code UI during chat execution** -> suspect misrouted keyboard input or foreground drift
- **highlighted-but-not-cleared search field** -> treat as a real bug or missing proof, not a cosmetic state

Common examples that should be captured as runtime regressions:

- VS Code Accessibility View opens during a real `liku chat` command
- TradingView quick-search keeps the previous query highlighted and the workflow stops early
- the action stream halts around action 2 even though the target PID exists
- the app process is present but focus-lock cannot prove the correct window/input surface

When these happen:

1. save the transcript or runtime trace
2. write down the real foreground app/window sequence if known
3. add the smallest fixture that proves the failure mode
4. only then generalize the fix into synthetic characterization coverage