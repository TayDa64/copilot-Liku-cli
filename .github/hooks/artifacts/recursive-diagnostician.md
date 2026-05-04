Root Cause

This failure is adjacent and pre-existing in behavior, not introduced by the Slice 1 synthetic-opener tightening.

Why:

The actual failing boundary is:
  - `ctrl+a` at `:599`
  - `backspace` at `:607`
  before typing `Pine Editor` and pressing Enter.

That conflicts with the safe-new-script contract. In the same workflow builder, `intent.safeAuthoringDefault` at `src/main/tradingview/pine-workflows.js:954` already shifts the authoring phase into inspect-first behavior (`get_text` with `pineEvidenceMode: 'safe-authoring-inspect'`) and, when continuing, prefers the fresh-indicator path rather than destructive buffer clearing. The remaining `ctrl+a` / `backspace` are therefore not coming from the authoring continuation; they are coming from the Pine Editor opener route itself.

Evidence

1. Focused suite reproduction:
  - `FAIL generic pine script creation prefers safe new-script workflow`
  - `AssertionError [ERR_ASSERTION]: safe authoring should avoid select-all by default`
  - location: `scripts/test-tradingview-pine-data-workflows.js:264`

2. Exact failing assertion:
  - `assert(!rewritten.some((action) => String(action?.key || '').toLowerCase() === 'ctrl+a'), 'safe authoring should avoid select-all by default');`

3. Live intent check proves Slice 1 synthetic-opener logic is not on the path:
  - PowerShell + Node snippet calling `inferTradingViewPineIntent(...)` with the exact failing actions and prompt.
  - `{"openerIndex":0,"syntheticOpener":false,"safeAuthoringDefault":true,"explicitOverwriteAuthoring":false,"requiresFreshIndicator":false}`

4. Live rewritten-plan dump for the exact failing scenario shows where `ctrl+a` survives:
  - PowerShell + Node snippet calling `maybeRewriteTradingViewPineWorkflow(...)` with the exact failing actions and prompt.
  - `bring_window_to_front`
  - `key ctrl+k`
  - `key ctrl+a` — reason `Select any existing TradingView quick-search text before replacing it`
  - `key backspace` — reason `Clear the selected TradingView quick-search text before typing Pine Editor`
  - `type "Pine Editor"`
  - `key enter`
  - then later `get_text "Pine Editor"` with `pineEvidenceMode: "safe-authoring-inspect"`

5. Code inspection matches the runtime output:
  - safe-authoring and non-safe-authoring Pine Editor opens both go through `buildTradingViewShortcutRoute('open-pine-editor', ...)`.
  - emits `ctrl+a` for the opener route.
  - emits `backspace` for the opener route.
  - safe authoring then adds inspect-first behavior after the opener, confirming the contradiction is specifically in the opener route, not the continuation builder.

Reproduction

1. Run:
   - `Set-Location 'c:\dev\copilot-Liku-cli'; node scripts/test-tradingview-pine-data-workflows.js`
2. Observe the single failing test:
   - `generic pine script creation prefers safe new-script workflow`
   - `safe authoring should avoid select-all by default`
3. Reproduce the exact rewrite:
   - call `maybeRewriteTradingViewPineWorkflow(...)` with:
     - actions: `ctrl+e`, wait, `ctrl+a`, `backspace`, `type indicator("LUNR Confidence")`, `ctrl+enter`
     - user message: `in tradingview, create a pine script that builds my confidence level when making decisions`
4. Observe that the rewritten workflow still contains opener-route `ctrl+a` and `backspace` before the inspect step.
5. Call `inferTradingViewPineIntent(...)` on the same inputs and observe:
   - `openerIndex: 0`
   - `syntheticOpener: false`
   confirming this is not caused by the Slice 1 synthetic-opener gate.

Smallest Fix

Smallest safe fix: keep Slice 1 as-is and make the Pine Editor opener route conditional for safe-new-script flows.

Concretely:

Why this is the smallest safe boundary:

Blocker Assessment

Do not block the fleet on this before moving to the next non-Pine milestone.

Assessment:

Recommended release discipline:
