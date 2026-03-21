## Recommended State Model
Use a thin HUD session store owned by the CLI chat command, not by ai-service and not by the UI watcher. The CLI should remain the composition root because it already owns readline lifecycle, prompt timing, slash-command handling, action execution callbacks, and the interactive transcript quieting behavior.

Split state into four boundaries:

1. Session config state: largely static across a session unless changed by a command. This includes execute mode, sequence mode, popup recipes mode, include-visual-next flag, current provider, configured model, requested model, runtime model, auth status, and whether the watcher was started by chat.
2. Live activity state: short-lived mutable status for the current turn. This includes phase (`idle`, `input`, `sending`, `responding`, `actions-running`, `awaiting-confirmation`, `continuation`, `error`), current prompt text length, last routing note, turn start time, spinner frame, and whether typing or model selection is active.
3. Transcript state: append-only message/event records that are rendered in the scrollback area and never mutated after commit. This includes user messages, assistant messages, system notices, command results, action progress rows, confirmation prompts, and failure summaries. HUD repaint must never rewrite committed transcript rows.
4. Snapshot state: derived, replaceable status data pulled from existing seams. This includes `ai.getStatus()` output, watcher metrics/cache summary, recent history count, visual-context count, pending confirmation metadata, and the last action batch summary. This state can refresh in place without altering transcript rows.

Keep the HUD renderer dumb: it should consume one normalized `HudViewModel` produced by the CLI command. Do not let the renderer read ai-service internals or watcher caches directly. A practical shape is:

`session`: provider/model/auth/flags
`activity`: phase, busy label, elapsed ms, input mode, confirmation state
`context`: active window title/process, watcher mode, poll interval, cache size, visual count
`transcript`: committed rows only
`composer`: current input buffer, cursor position, hint text

That boundary matches the repo’s current pattern: ai-service already exposes stable status snapshots, conversation history is already isolated behind a store, and the watcher already exposes coarse status plus event payloads. The HUD layer should normalize those into terminal-facing state instead of adding another long-lived global singleton.

## UI Regions
Use a fixed three-band layout with a transcript viewport in the middle. Keep the header and footer fixed-height and redraw only those regions during normal updates.

Header, line 1: product/session strip.
Data: `Liku Chat`, provider, runtime model, requested-model fallback indicator when different, auth badge, execute mode, and current phase badge.

Header, line 2: live context strip.
Data: watcher status (`live UI on/off`, polling vs event/fallback mode), poll interval, active window process/title truncated for width, visual-context count, history count, and a compact privacy/redaction badge when the focused app is sensitive.

Body: transcript viewport.
Data: committed chat transcript and system events only. Render assistant responses, slash-command output, action progress entries, confirmation prompts, and continuation summaries as stable rows. Never redraw historical content in place except on full terminal resize.

Footer, line 1: transient status rail.
Data: current busy state such as `Sending`, `Thinking`, `Running 2/5`, `Awaiting confirmation`, `Capturing screen`, `Model picker`, or `Ready`, plus elapsed time or spinner.

Footer, line 2: composer row.
Data: prompt marker, editable input buffer, cursor, and one short hint area on the right for context-sensitive controls such as `/help`, `Enter send`, `Esc cancel`, `Y/N confirm`, or `↑/↓ select`.

Optional phase-1 region: a one-line ephemeral overlay above the footer for destructive-action confirmations. This should be reserved but only shown when needed so risky prompts do not scroll the transcript unexpectedly.

Do not put verbose diagnostics into the header. The header should carry status pills and counts, mirroring the renderer language already used elsewhere in the repo. Detailed `/status` output should remain transcript content.

## Renderer Recommendation
Phase 1 should be a custom ANSI renderer, not Ink.

Why custom ANSI fits this repo better now:

1. The current CLI already uses readline plus targeted ANSI cursor control for interactive pickers, so a HUD can extend an existing pattern instead of replacing the input stack outright.
2. The repo explicitly favors minimal footprint and currently has no terminal UI framework dependency. Ink adds React, scheduler behavior, and a different ownership model for input and layout that would be a larger architectural jump than the feature requires.
3. Transcript stability is easier to guarantee with a purpose-built split between fixed HUD regions and append-only body rows than with a full reactive tree diffing approach on top of readline migration.
4. Existing risk points are mostly integration and lifecycle, not widget richness. A small renderer with `save cursor`, `restore cursor`, region clears, and width-aware truncation is enough for the stated HUD goal.

Tradeoffs:

- Custom ANSI has higher manual complexity around wrapping, resize, cursor restoration, and Windows terminal quirks.
- Ink would eventually make richer layouts and keyboard-state handling easier, especially if the CLI grows into a full TUI with panels, inspectors, and richer selection widgets.

Codebase-sensitive recommendation: build a custom ANSI renderer behind an interface that keeps an Ink migration possible later. Concretely, define a small driver boundary such as `createHudRenderer({ stdout, stdin })` with methods like `mount`, `update(viewModel)`, `appendTranscript(rows)`, `suspend`, `resume`, and `dispose`. That preserves an escape hatch without paying the dependency and migration cost up front.

## Integration Risks
The minimal viable event/update model should be snapshot-plus-events:

1. Initial snapshot on chat start: provider/model/auth/history/visual counts from ai-service plus watcher metrics and flags from the CLI session.
2. Input events: buffer changed, cursor moved, input submitted, mode switched, command entered.
3. Request lifecycle events: turn started, response received, routing note received, turn failed.
4. Action lifecycle events: batch detected, action step completed, screenshot captured, pending confirmation raised, confirmation resolved, continuation started/completed.
5. Context refresh events: watcher `poll-complete` or `ui-changed`, provider/model/auth changed, visual-context count changed.
6. Terminal lifecycle events: resize, raw-mode takeover for model picker, suspend/resume, shutdown.

The riskiest integration points are:

1. Readline ownership and raw-mode contention. The current chat flow temporarily closes or pauses readline for model selection and confirmation-adjacent flows. A HUD that redraws while stdin ownership changes can corrupt the prompt or lose cursor state.
2. Transcript quieting versus HUD diagnostics. Interactive chat currently suppresses noisy background logs through `LIKU_CHAT_TRANSCRIPT_QUIET=1`. Any HUD implementation must keep background subsystems from writing directly to stdout, or the fixed regions will tear.
3. Multi-source asynchronous updates. Watcher updates, AI request completion, action callbacks, and user typing can all race. Without a single CLI-owned reducer and render scheduler, the header/footer will flicker or overwrite the composer.
4. Width and resize behavior on Windows terminals. ANSI region math is fragile when lines wrap. Every header/footer line must be width-truncated or padded deliberately; otherwise transcript stability collapses during resize.
5. Pending confirmation flows for high-risk actions. Those flows already interrupt normal execution semantics. If confirmation is rendered as ordinary transcript text instead of a reserved footer/overlay state, the user can lose the actionable prompt in scrollback.
6. Watcher freshness and privacy state. The watcher can be unavailable, stale, or redacted for sensitive processes. The HUD should show stale/off/redacted explicitly and never imply live grounding when the snapshot is old or suppressed.

## Rollout Plan
Phase 1: Introduce a CLI-owned HUD state reducer and a custom ANSI renderer with fixed header/footer, but keep the transcript body append-only and keep existing chat semantics intact. Surface only provider/model/auth, watcher state, current phase, and composer status. Reuse existing ai-service status snapshots and watcher metrics; do not add new ai-service responsibilities yet.

Phase 2: Convert current action execution callbacks and confirmation flow into structured HUD events. Add footer progress for action batches, explicit awaiting-confirmation state, and stable rendering for continuations. This is the point where transcript stability should be validated under resize, model picker use, and watcher churn.

Phase 3: Add watcher-driven live context polish and resilience. Promote active-window summary, stale/redacted indicators, and visual-context counts into the header, throttle watcher-driven repaints, and harden suspend/resume behavior. Only after this phase should the team consider richer widgets or an Ink-backed renderer if the CLI is expanding beyond a HUD into a full terminal UI.