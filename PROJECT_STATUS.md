# Project Status

**SoT date:** 8 September 2026
**HEAD on `main`:** `8e495e4` — `feat(agents): adaptive transport policy table (Phase 51)`
**Repo:** https://github.com/TayDa64/copilot-Liku-cli
**Published package version:** `0.0.16` (see `package.json`)

This file is the living clock. Commit messages on `main` are the implementation source of truth when this file and a commit disagree.

---

## Current State

- Status: **fabric clock stopped cleanly after Phase 51**. Next implementation is human-gated (not "Phase 52 by inertia").
- Phase 40 closed the Peripheral Abstraction Layer forecast/self-heal stack.
- Phases 41–51 landed the Inference Fabric v1 + in-process Execution Fabric + Transport *interface* (bench + lab stand-in + advisory policy table).
- Overlay / UIA remains a coordinate grid + inspect seam, **not** a fourth perception runtime.
- Default cognitive fragment invariant: **262 BPE** (byte-identical when cluster/fabric flags are off).
- High-risk paths remain **proposal → explicit human confirmation**. No new autonomous actuation.
- All new fabrics and lab paths are **flag-gated, default OFF**.

### HEAD clock (selected)

| Phase | Commit on `main` | What landed |
| --- | --- | --- |
| 40 | `2794d012` | PAL / forecast close-out |
| 41 | PR #29 `5754dfac` + hook restore `268e2614` | Cerebras + xAI OpenAI-compatible providers |
| 42 | `e0953e6` | `routing.js`, `/route`, `LIKU_INFERENCE_FABRIC`, allowlist |
| 43 | `dc713aa` | Budget + `~/.liku/inference/inference.jsonl` + `liku analytics inference` |
| 44 | `0d93c14` | TaskContract + compressed worker reports |
| 45 | `22c5388` | Escalation signals + ladder + independent verifier |
| 46 | `03925b6` | In-process Execution Fabric |
| 47 | `3a48f54` | Parallel scheduler (declared independence only) |
| 48 | `ac9d919` | Transport fabric interface (`inprocess` + `https-provider`; reserved kinds fail closed) |
| 49 | PR #30 `7c8bc899` | Transport measurement harness (`LIKU_TRANSPORT_BENCH`) |
| 50 | PR #31 `0d871af0` | QUIC worker *lab* loopback stand-in (`LIKU_QUIC_WORKER_LAB`) |
| 51 | PR #32 `8e495e4e` | Adaptive transport policy table (`LIKU_TRANSPORT_POLICY` / `_APPLY`) |

Residual (does **not** block the docs clock):

- Supervisor APPLY pin (`_maybeRecommendTransport` in the scheduler wrap) was designed in Phase 51 but is **not** required for the table to exist. Coding-path `select()` still defaults to `inprocess`.
- `select('http3')` still throws. `select('quic')` throws unless `LIKU_QUIC_WORKER_LAB=1`.
- One pre-existing `test-bug-fixes.js` TradingView `SendInput` assertion is Windows-only and may fail in a Linux container; it is unrelated to Phases 41–51.

---

## Architecture that is actually on `main`

Three original pillars remain the product SoT. Four *conceptual* fabrics were added **without** creating four new `src/` trees.

### Pillars

| Pillar | Current reality |
| --- | --- |
| 1. Cognitive Substrate | `SystemContextManager` + A-MEM + skill router + RLVR telemetry + dynamic tools. Default fragment 262 BPE. |
| 2. Multi-Agent Intelligence | Supervisor / Builder / Verifier / … plus peripheral monitor → alert → task pipeline, fairness, self-heal ticks. |
| 3. Peripheral Abstraction Layer | Mock + MQTT + Serial + BLE + Zigbee + ROS2 + Matter foundations, pairing parity, DCP tokens, power/forecast/anomaly, cluster leases. Phases 25–40. |

Overlay + UIA inspect is a **coordinate grid**, not a fourth pillar and not a perception runtime.

### Fabrics (41–51)

| Fabric | Phases | What it is | What it is not |
| --- | --- | --- | --- |
| Agent | existing `src/main/agents` | Roles, handoff, contracts, PAL tasks | not relocated |
| Inference | 41–45 | OpenAI-compatible providers, `/route`, budget, telemetry, TaskContract, escalation | not a model OS |
| Execution | 46–47 | In-process fabric + declared-independence scheduler | not a worker pool, not work-stealing |
| Transport | 48–51 | `TransportManager` + bench + loopback lab + advisory table | not HTTP/3, not production QUIC, not a cutover |

**Transport neutrality:** orchestration is not coupled to TCP/HTTP/2/HTTP/3/QUIC. Provider APIs stay HTTPS / OpenAI-compatible. Agents never open streams. Transport never grants execution authority.

---

## Non-negotiable invariants

- Proposal → explicit human confirmation on high-risk paths.
- No new autonomous actuation.
- Feature-flagged, default OFF.
- Single-machine behavior is byte-compatible when cluster / fabric flags are unset.
- Default cognitive fragment stays 262 BPE.
- Bench kinds ≠ production kinds.
- Lab `quic` ≠ production QUIC. No vendor base URL on the lab handle.
- A faster bench row is not a cutover. The policy table never calls `select()`.
- Do not invent a second scheduler. Phase 47 is the parallelism seam.

---

## Core runtime areas (current)

- `src/main/ai-service.js` + `src/main/ai-service/` — facade, routing, budget, telemetry, providers (`openai-compatible.js`, Cerebras/xAI optional).
- `src/main/agents/` — Supervisor, fabrics (`execution-fabric.js`, `execution-scheduler.js`, `transport-fabric.js`, `transport-bench.js`, `quic-lab.js`, `transport-policy.js`), task contracts, escalation, PAL coordination.
- `src/main/memory/`, `src/main/telemetry/`, `src/main/tools/` — cognitive layer.
- `src/main/visual-awareness.js`, `visual-context.js`, `background-capture.js`, `python-bridge.js` — existing vision seams (do not reinvent).
- Overlay / UIA — inspect grid only.

---

## Near-term priorities (human-gated)

The fabric clock is stopped. Do **not** start "Phase 52" unless a human names the work.

Recommended next slices, in order of blast radius:

1. **Docs-only SoT refresh (this file + `ARCHITECTURE.md` + `changelog.md` + `CONFIGURATION.md` 50/51 sections).** Lowest risk. This is the current cut.
2. Optional Supervisor APPLY pin (51.1) — consult the table from `_executePlanViaScheduler` only when both policy flags are on and `isSupported(kind)`. Coding path stays `inprocess`.
3. A **new named plenum** if anyone wants real QUIC/HTTP/3 or out-of-process execution. That is not Phase 52 by inertia.
4. PAL / overlay / GitHub / TradingView stay on their own backlogs.

---

## Historical notes (still true, no longer the clock)

The March 2026 cognitive-layer and TradingView sections that used to fill this file remain accurate as *earlier* deliverables. They do **not** describe Phases 25–51. See `changelog.md` for the v0.0.8–v0.0.15 narrative.

Older "implementation complete" snapshots described an Electron-only overlay. The current system is CLI + overlay + agents + PAL + inference/execution/transport fabrics.
