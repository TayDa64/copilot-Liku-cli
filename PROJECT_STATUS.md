# Project Status — Living Clock

> **This file is the phase clock.** When any other document disagrees with this
> one about "what is current," this file wins. Older status snapshots are kept
> for history and are banner-marked as historical; they are not the clock.

- **Snapshot date:** 8 September 2026
- **HEAD:** `8e495e4` — `feat(agents): adaptive transport policy table (Phase 51)`
- **Package version:** `0.0.16`
- **Branch of record:** `main`
- **Phase clock:** stopped at **Phase 51**. The next implementation slice is
  human-gated — there is **no Phase 52 by inertia**.

---

## What Liku is (three product pillars)

Liku is a CommonJS Node/Electron CLI runtime — an ambient-intelligence layer for
the desktop. Its product surface is three pillars. These are stable and are **not**
collapsed into the four engineering "fabrics" below.

1. **Cognitive Substrate** — `SystemContextManager`, Agentic Memory (A-MEM), the
   semantic skill router, RLVR telemetry/reflection, and the dynamic-tool
   sandbox. Default context fragment size is **262 BPE** (an invariant — do not
   "improve" it silently).
2. **Multi-Agent Intelligence** — a Supervisor plus worker roles (researcher /
   architect / builder / verifier / diagnostician / vision operator); the
   peripheral monitor → alert → task flow; fairness and self-heal ticks.
3. **Peripheral Abstraction Layer (PAL)** — mock + MQTT + Serial + BLE + Zigbee +
   ROS2 + Matter foundations; pairing; the device-capability profile (DCP);
   power / forecast / anomaly signals; cluster leases. Landed across Phases 25–40.

The overlay / UIA inspect surface is a **coordinate grid** for targeting and
inspection. It is **not** a fourth pillar and **not** a perception runtime.

---

## Four engineering fabrics (conceptual, not four new `src/` trees)

| Fabric | Phases | What it is | What it is **not** |
| --- | --- | --- | --- |
| **Agent** | existing `src/main/agents` | roles, handoff, task contracts, PAL tasks | not relocated |
| **Inference** | 41–45 | OpenAI-compatible providers, `/route`, budget, telemetry, TaskContract, escalation | not a "model OS" |
| **Execution** | 46–47 | in-process fabric + declared-independence scheduler | not a worker pool |
| **Transport** | 48–51 | interface + bench + loopback lab + advisory policy table | not HTTP/3, not production QUIC, not a cutover |

---

## Phase clock (40–51)

| Phase | Commit | What landed |
| --- | --- | --- |
| 40 | `2794d012` | PAL / forecast close-out |
| 41 | PR #29 `5754dfac` + `268e2614` | Cerebras + xAI OpenAI-compatible providers |
| 42 | `e0953e6` | `routing.js`, `/route`, `LIKU_INFERENCE_FABRIC` |
| 43 | `dc713aa` | Budget + `~/.liku/inference/inference.jsonl` + `liku analytics inference` |
| 44 | `0d93c14` | TaskContract + compressed worker reports |
| 45 | `22c5388` | Escalation ladder + independent verifier |
| 46 | `03925b6` | In-process Execution Fabric |
| 47 | `3a48f54` | Parallel scheduler (declared independence only) |
| 48 | `ac9d919` | Transport interface: `inprocess` + `https-provider`; reserved kinds fail closed |
| 49 | PR #30 `7c8bc899` | Transport bench (`LIKU_TRANSPORT_BENCH`). Bench kinds ≠ production kinds |
| 50 | PR #31 `0d871af0` | QUIC lab loopback stand-in (`LIKU_QUIC_WORKER_LAB`) |
| 51 | PR #32 `8e495e4e` | Advisory transport policy table (`LIKU_TRANSPORT_POLICY` / `_APPLY`) |

Earlier PAL phases (25–40) and the March 2026 cognitive-layer work are covered in
the changelog and in banner-marked historical docs.

---

## Invariants (do not weaken in prose or code)

- **Docs ↔ code parity:** commit messages on `main` outrank stale markdown. If a
  doc says `0.0.13` or "the March 2026 cognitive layer is current," the doc is the
  bug, not the code.
- **Default cognitive fragment is 262 BPE.**
- **Proposal → confirm rails stay closed.** High-risk / critical actions and
  dynamic-tool proposals flow through the existing confirmation / policy paths.
  No fabric grants new actuation authority.
- **Transport grants no authority.** A transport handle's `invoke()` only calls
  the injected function; it cannot skip budget, routing, escalation, confirm
  rails, or PAL. **Agents never open transport streams.**
- **Bench kinds ≠ production kinds.** A faster bench row is not a cutover.
- **Lab quic ≠ QUIC.** The QUIC worker lab is a loopback framed-TCP stand-in; it
  is not a QUIC/HTTP-3 stack and never speaks to vendor APIs.
- **Reserved transport kinds fail closed.** `select('http3')` throws
  `unsupported-transport`; `select('quic')` throws unless `LIKU_QUIC_WORKER_LAB=1`.
- **TradingView live/unknown DOM / Depth-of-Market order entry stays fail-closed**
  behind advisory-only rails.
- **PAL peripheral-task store semantics are unchanged.**

---

## Honest residuals (designed, not landed on `main`)

- **Supervisor APPLY pin.** A `_maybeRecommendTransport` hook inside
  `_executePlanViaScheduler` is *designed*, but on current `main` the coding-path
  scheduler still calls `TransportManager.select({ kind: 'inprocess' })` directly.
  `transport-policy.recommendTransport()` is advisory-only and is **not** wired
  into the Supervisor. Treat the pin as optional future work, not as shipped.
- **`select('http3')` still throws** `unsupported-transport`.
- **`select('quic')` still throws** unless `LIKU_QUIC_WORKER_LAB=1`, and even then
  only the loopback lab stand-in is returned.
- **`LIKU_TRANSPORT_POLICY_APPLY=1` without the lab does not enable `quic`.** The
  policy table can only recommend a currently-legal kind under the active flags.
- **`test-bug-fixes.js` TradingView `SendInput` assertion** is a pre-existing
  Windows-only characterization check. It is not "broken" and is not touched here.

---

## Fabric clock stopped after Phase 51

The four fabrics are at a deliberate stopping point. Any next slice is
**human-gated** and named, not numbered by inertia. Candidate slices (not
scheduled here):

- wire the Supervisor APPLY pin,
- open a new plenum for real out-of-process execution or a real QUIC/HTTP-3
  transport,
- resume PAL / overlay / TradingView backlogs.

---

## Historical context

For the March 2026 cognitive-layer build-out (Phases 0–14, v0.0.15 era) and the
earlier Electron-only snapshots, see `changelog.md` and the banner-marked
historical files (`IMPLEMENTATION_SUMMARY.md`, `FINAL_SUMMARY.txt`,
`baseline-app.md`, `PLAN-v0.0.14-window-awareness.md`, and others). That history
is preserved and remains accurate as history — it is **not** the current clock.

## Pointers

- Long-form architecture: `ARCHITECTURE.md`
- Flags and configuration: `CONFIGURATION.md`
- Release history: `changelog.md`
- Agent routing / hook topology: `docs/AGENT_ORCHESTRATION.md`
- Wiki: <https://github.com/TayDa64/copilot-Liku-cli/wiki>
