Changed Files
- c:\dev\copilot-Liku-cli\src\main\ai-service.js
- c:\dev\copilot-Liku-cli\src\main\system-automation.js
- c:\dev\copilot-Liku-cli\scripts\test-windows-observation-flow.js
- c:\dev\copilot-Liku-cli\scripts\test-bug-fixes.js

What was implemented
- Added TradingView-specific post-key observation checkpoints in `ai-service.js` for critical key actions, scoped to low-UIA TradingView flows.
- After critical TradingView `alt+...` and `enter` keys, the executor now pauses to observe foreground/window-state changes before continuing.
- Hard-gated follow-up typing after TradingView dialog-opening keys: if the app surface does not visibly change, execution stops before the next `type` action.
- Added verification-friendly execution metadata via `observationCheckpoints` on both `executeActions(...)` and `resumeAfterConfirmation(...)` results.
- Updated checkpoint logic to retarget `lastTargetWindowHandle` to the newly observed dialog window when TradingView opens an owned/palette surface, so later typing goes to the dialog instead of the chart window.
- Expanded TradingView identity grounding in `APP_NAME_PROFILES` with dialog title hints, chart keywords, dialog keywords, and preferred/dialog window kinds.
- Kept the broader architecture intact by reusing existing foreground verification and app-identity seams rather than redesigning orchestration.
- In `system-automation.js`, added a narrowly scoped SendInput path for TradingView-class `Alt` accelerators and `Enter` confirmations, while preserving the prior SendKeys path for unrelated shortcuts.
- Kept the change advisory-safe: no trade execution behavior was added.

Tests run and results
- `node scripts/test-windows-observation-flow.js` ✅
	- Passed: 9
	- Added coverage proving:
		- TradingView alert accelerators block blind follow-up typing when no dialog change is observed.
		- TradingView alert accelerators allow typing only after an observed dialog transition.
		- Resume/confirmation flows return TradingView checkpoint metadata for timeframe confirmation.
- `node scripts/test-bug-fixes.js` ✅
	- Passed: 17
	- Added coverage for TradingView app-profile verification hints and the new TradingView SendInput key-selection seam.
- `npm run test:ai-focused` ✅
	- Passed end-to-end in the current workspace, including the targeted Windows observation tests and shared AI-service suites.

Local Proofs
- `node scripts/test-windows-observation-flow.js` → exit 0, summary reported `Passed: 9`, `Failed: 0`.
- `node scripts/test-bug-fixes.js` → exit 0, summary reported `Passed: 17`, `Failed: 0`.
- `npm run test:ai-focused` → exit 0, included successful runs of:
	- `test-windows-observation-flow`
	- `test-bug-fixes`
	- `test-chat-actionability`
	- `test-ai-service-contract`
	- `test-ai-service-browser-rewrite`
	- `test-ai-service-state`

Remaining limitations for the next slice
- The new checkpoint is intentionally scoped to TradingView-class key flows and only uses foreground/window metadata; it does not yet do screenshot- or OCR-based confirmation of the actual chart interval label.
- For non-typing TradingView `Enter` flows, the checkpoint is a bounded settle/verification step rather than a hard visual-change requirement, because low-UIA metadata does not always expose a distinct chart-state transition.
- The SendInput reliability improvement is intentionally narrow (TradingView-like `Alt` and `Enter` flows only) to minimize regression risk; broader Electron-app tuning can be evaluated in a later slice if needed.

Unresolved Risks
- TradingView surfaces that change internally without any title/window-kind signal can still be only partially observable through foreground metadata alone.
- If a TradingView dialog opens without changing HWND, title, or window kind, the hard gate may still conservatively stop follow-up typing; that is safer than blind continuation, but may need richer visual confirmation in a later phase.