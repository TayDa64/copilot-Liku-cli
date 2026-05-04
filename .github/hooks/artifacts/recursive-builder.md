Changed Files
- `src/main/tools/tradingview-tool.js` — new stable additive facade that re-exports the TradingView helpers currently consumed by `src/main/ai-service.js`.

ai-service.js Import Decision
- Deferred `ai-service.js` import changes.
- Reason: a compatibility phase is required right now because `scripts/test-bug-fixes.js` contains direct source-string assertions that `ai-service.js` still includes:
  - `require('./tradingview/app-profile')`
  - `require('./tradingview/indicator-workflows')`
  - `require('./tradingview/alert-workflows')`
  - `require('./tradingview/chart-verification')`
  - `require('./tradingview/drawing-workflows')`
  - `require('./tradingview/pine-workflows')`
  - `require('./tradingview/paper-workflows')`
  - `require('./tradingview/dom-workflows')`
- Switching `ai-service.js` fully to the facade in this step would fail those source-sensitive tests despite unchanged runtime behavior.
- Result: facade added now, `ai-service.js` left untouched for safe compatibility.

First Failing Assertions Encountered
- None in the actual verification run.
- Note: an initial execution wrapper attempt returned no usable output, but it did not surface any assertion failure text. I reran the checks directly in the terminal and all requested regressions passed.

Local Proofs
- `node -e "const m=require('./src/main/tools/tradingview-tool'); ..."`
  PASS — `Facade exports OK: 26`
- `node scripts/test-ai-service-contract.js`
  PASS
- `node scripts/test-ai-service-proof-trace.js`
  PASS
- `node scripts/test-ai-service-policy.js`
  PASS
- `node scripts/test-bug-fixes.js`
  PASS — 35 passed, 0 failed

Verification Details
- The new facade successfully re-exports the TradingView helper functions currently consumed by `ai-service.js`:
  - app profile helpers
  - TradingView verification helpers
  - indicator/alert/chart/drawing rewrite helpers
  - Pine workflow helpers
  - Pine script state helpers
  - paper and DOM rewrite helpers
- Runtime behavior was preserved by making the change additive only and not rerouting `ai-service.js` yet.

Concise Recommendation for Next Local Step
- Next safe step: update the source-sensitive assertions in `scripts/test-bug-fixes.js` to accept the facade import path (or dual-path compatibility), then switch `ai-service.js` TradingView imports to `./tools/tradingview-tool` in one focused follow-up change.

Unresolved Risks
- The facade is not yet exercised by `ai-service.js` at runtime because preserving current source-sensitive test expectations required deferring that import swap.
- Repository working tree contains unrelated pre-existing changes; my implementation scope for Issue 1 was limited to the new facade file.
