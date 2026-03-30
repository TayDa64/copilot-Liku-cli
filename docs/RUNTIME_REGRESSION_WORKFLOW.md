# Runtime Regression Workflow

## Goal

Turn a real `liku chat` runtime finding into a checked-in, repeatable regression with as little friction as possible.

This first N5 slice intentionally reuses the existing inline-proof transcript evaluator instead of introducing a second transcript engine. The workflow is:

1. capture a runtime transcript or reuse an inline-proof `.log`
2. sanitize it down to the smallest useful snippet
3. generate a transcript fixture skeleton
4. tighten the generated expectations
5. run transcript regressions and the nearest focused behavior test
6. commit the fixture and the behavioral fix together

## Inputs supported in this slice

- plaintext `liku chat` transcripts
- inline-proof logs from `~/.liku/traces/chat-inline-proof/*.log`
- pasted transcript text over stdin

Out of scope for this first slice:

- automatic replay of JSONL telemetry or agent-trace files
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

## Recommended loop

### 1. Capture the failure

Prefer one of these sources:

- a fresh `liku chat` transcript
- an inline-proof log already saved under `~/.liku/traces/chat-inline-proof/`
- a small hand-curated transcript excerpt from a runtime session

Keep only the lines that prove the invariant you care about. Smaller fixtures are easier to review and less brittle.

### 2. Generate a fixture skeleton

Run `regression:extract` against the sanitized transcript.

The helper derives:

- a fixture name
- prompts
- assistant turns
- observed provider/model headers
- placeholder expectations

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