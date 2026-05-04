Recommended Approach

Implement Milestone G.1 as a very small, transparent cache behind the existing project-identity seam, then let the existing execution-context seam continue composing dynamic foreground state on every call.

Minimal path:

1. Add an in-memory session-local cache inside `src/shared/project-identity.js`.
   - Key it by normalized `cwd` and/or the resolved `projectRoot`.
   - Cache only stable repo identity fields that are already derived there: `projectRoot`, `folderName`, `packageName`, `packageVersion`, `repoName`, `normalizedRepoName`, `gitRemote`, and `aliases`.
   - Keep the exported `resolveProjectIdentity(options)` contract unchanged.

2. Keep `src/main/ai-service/execution-context.js` as the composition seam.
   - Continue calling `resolveProjectIdentity({ cwd })` from `buildExecutionContextEnvelope(...)`.
   - Do not cache `foreground`, `appId`, `processName`, `windowTitle`, `surfaceClass`, `interactionMode`, `taskFamily`, `signals`, `eligibility`, or `compartmentKey` outside the current call.
   - Build the envelope fresh each turn so the foreground-derived compartment remains dynamic.

3. Add a narrow documentation cue at the envelope formatting seam.
   - The brainstorm requirement “the LLM consumes but does not generate the execution context envelope” is best satisfied where the envelope is surfaced to the model today: `formatExecutionContextEnvelope(...)` in `src/main/ai-service/execution-context.js`.
   - Keep this lightweight: one explicit line in the rendered block or one adjacent comment/test-backed message, not a broader prompt refactor.

4. Do not introduce a new cache API unless profiling proves it is needed.
   - The lowest-risk shape is internal memoization that is invisible to callers.
   - If test visibility is needed, expose only a tiny optional test helper such as `__clearProjectIdentityCache()`; avoid changing primary call signatures.

Why this path fits the repo:

- `src/shared/project-identity.js` is already the single place that resolves repo identity.
- `src/main/ai-service/execution-context.js` already separates stable repo identity from dynamic foreground/task signals.
- `src/main/session-intent-state.js`, `src/cli/commands/chat.js`, and other callers already depend on current return shapes, so hidden memoization is safer than a new envelope/cache layer.

Files to Reuse

- `c:\dev\copilot-Liku-cli\src\shared\project-identity.js`
  - `normalizePath`
  - `detectProjectRoot`
  - `resolveProjectIdentity`
  - `validateProjectIdentity`

- `c:\dev\copilot-Liku-cli\src\main\ai-service\execution-context.js`
  - `buildExecutionContextEnvelope`
  - `formatExecutionContextEnvelope`
  - existing split between repo identity and dynamic foreground-derived fields

- `c:\dev\copilot-Liku-cli\scripts\test-project-identity.js`
  - existing direct coverage for `resolveProjectIdentity(...)`

- `c:\dev\copilot-Liku-cli\scripts\test-session-intent-state.js`
  - existing envelope-driven compartment tests that should remain unchanged if G.1 is implemented correctly

- `c:\dev\copilot-Liku-cli\scripts\test-message-builder-session-intent.js`
  - existing coverage that the execution context envelope is injected into model messages

Compatibility Constraints

- Preserve the `resolveProjectIdentity(options)` return shape exactly.
  - It is used by `execution-context.js`, `session-intent-state.js`, `cli/liku.js`, and `cli/commands/doctor.js`.

- Preserve `buildExecutionContextEnvelope(...)` behavior and output shape.
  - Existing compartment logic depends on fresh foreground/app/task-family derivation each turn.

- Keep the cache process-local and memory-only.
  - Milestone G.1 calls for session-local caching, not persisted state.
  - Nothing should be written into the session-intent store for this feature.

- Cache only deterministic repo identity inputs/outputs.
  - Safe to cache: package metadata, detected root, git remote, aliases.
  - Unsafe to cache here: current foreground window, surface mode, task family, continuation readiness, or any other live execution signal.

- Fail safely if repo metadata changes mid-session.
  - Prefer a conservative invalidation check using file mtimes for `package.json` and `.git/config` when practical, or document that cache lifetime is the current process if kept intentionally simple.
  - Do not let stale cached repo identity corrupt cross-repo detection.

What Not to Change

- Do not move execution-context generation out of `src/main/ai-service/execution-context.js`.
- Do not persist project-identity cache entries in `session-intent-state` or any disk-backed store.
- Do not cache or reuse `windowTitle`, `foreground`, `appId`, `surfaceClass`, `interactionMode`, `taskFamily`, `signals`, or `eligibility`.
- Do not change compartment-key construction rules.
- Do not change current scope-aware memory/skill routing behavior.
- Do not broaden G.1 into continuity, prompt-overlay gating, confirmation semantics, or runtime trace changes.
- Do not let the LLM author or mutate the envelope; it should continue to receive a host-generated envelope block only.

Recommended Tests

1. Extend `scripts/test-project-identity.js` with G.1-specific cache coverage.
   - `resolveProjectIdentity returns identical identity across repeated calls for the same cwd`
   - `resolveProjectIdentity reuses cached stable identity for nested cwd values in the same repo` if the implementation normalizes by project root
   - `resolveProjectIdentity distinguishes two temp repos with different package names`
   - If a test-only cache reset helper is added: `cache reset forces recomputation without changing returned shape`

2. Add execution-context regression coverage, preferably in a focused new test or an existing envelope-oriented test.
   - Build two envelopes for the same `cwd` with different foreground windows/apps.
   - Assert repo identity fields stay the same.
   - Assert dynamic foreground fields, task family, and resulting `compartmentKey` still reflect the latest call and are not frozen by cache reuse.

3. Extend `scripts/test-message-builder-session-intent.js` for the documentation requirement.
   - Assert the injected execution-context block clearly states that the envelope is system/host supplied and should be consumed rather than generated by the model.

4. Keep existing compartment/continuity regressions as compatibility proof.
   - `scripts/test-session-intent-state.js`
   - any pending-confirmation mismatch tests already relying on fresh envelope generation

Constraints and Risks

- Main structural risk: caching by raw `cwd` alone can duplicate entries for multiple subdirectories in the same repo.
  - Prefer resolving through normalized `projectRoot`, or use a two-stage cache (`cwd -> root`, `root -> identity`).

- Main correctness risk: stale cache after `package.json` or git remote changes during a long session.
  - Lowest-risk implementation is still in-memory only, but it should either invalidate conservatively or accept process-lifetime staleness explicitly for G.1 and cover it in notes.

- Main compatibility risk: changing exported signatures or return shapes will ripple into CLI guards and doctor diagnostics.
  - Keep caching entirely internal.

- Main semantic risk: accidentally treating dynamic envelope fields as cacheable because they are assembled near repo identity.
  - The safe boundary is: cache only `project-identity.js`; recompute everything in `execution-context.js`.

- Main prompt risk: over-documenting the envelope in a way that changes broader model behavior.
  - Keep the new documentation line narrow and local to the existing execution-context block.



