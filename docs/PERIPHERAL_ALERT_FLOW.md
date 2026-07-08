# Peripheral Alert Flow (Pillar 3 × Multi-Agent)

End-to-end, safety-first path from a physical sensor reading to a **human-gated**
Supervisor notification — and, only if a human approves, a gated physical action.

> Feature-flagged: the entire peripheral layer is inert unless
> `LIKU_ENABLE_PERIPHERALS=1`. When off, nothing below runs, no disk is touched,
> and the default cognitive fragment is byte-identical.

## The loop

```
 Driver (mock / mqtt / serial…)               ← real hardware or test ingest
   │  emits a reading
   ▼
 PAL.ingestSensorReading(id, metrics)          src/main/peripherals/peripheral-abstraction-layer.js
   │  emits 'reading' on the PAL event bus
   ▼
 PeripheralMonitor._onReading(ev)              src/main/peripherals/peripheral-monitor.js
   │  1. grounds sensor.<id>.<metric> facts (evidence-excluded, TTL'd)
   │  2. SIGNIFICANCE FILTER: debounce (cooldown) + hysteresis (deadband)
   │     → only a NEW, non-flapping breach survives
   │  3. on a significant breach: grounds hardware.<id>.alert + onSupervisorWake()
   ▼
 PeripheralMonitorAgent._onWake(event)         src/main/agents/peripheral-monitor-agent.js
   │  builds a structured, advisory-only context
   │  emits 'peripheral:alert' on the orchestrator (decoupled — event only)
   ▼
 attachPeripheralAlertConsumer listener        src/main/agents/peripheral-alert-consumer.js
   │  buildSupervisorNotification(context)  → bounded, advisory-only
   ▼
 SupervisorAgent.receiveNotification(n)        src/main/agents/supervisor.js
   │  bounded inbox (cap 20, oldest dropped); emits 'notification'
   ▼
 orchestrator.emit('supervisor:notification', n)   ← CLI / chat UI / telemetry react
   │
   │  (Phase 8, optional — on by default) convert to a reviewable work item
   ▼
 SupervisorAgent.createPeripheralTask(n)       src/main/agents/supervisor.js
   │  bounded task queue (cap 5, dedupe by device+metric+level);
   │  status 'pending-review', requiresHuman=true, autonomousAction=false
   ▼
 orchestrator.emit('supervisor:task', task)    ← CLI / chat UI review + acknowledge
```

At this point the human sees an advisory and (optionally) a reviewable task.
**Nothing has actuated.**

## Bounded Supervisor tasks (Phase 8)

A `supervisor:notification` can be converted into a **reviewable, human-gated
task** so peripheral events become actionable inside the multi-agent workflow —
without ever running themselves.

| Property | Guarantee |
| --- | --- |
| `status` | Starts at `pending-review`; a human moves it to `acknowledged`/`dismissed`. |
| `requiresHuman` | Always `true`. |
| `autonomousAction` | Always `false` — there is no code path that executes a task. |
| `proposedAction` | Advisory only; executing it still requires `PAL.execute()` + confirm. |
| Bounded | Queue capped (`maxPeripheralTasks`, default 5); repeats coalesce via `dedupeKey` + `count`. |
| Priority | Derived from severity: `critical→high`, `warning→medium`, else `low`. |

Task creation is **optional**: disable via `attachPeripheralAlertConsumer(orch,
{ createTasks: false })` or `LIKU_PERIPHERAL_CREATE_TASKS=0`.

## Durable persistence (Phase 9)

Notifications and peripheral tasks survive process restarts. The Supervisor
restores them from `~/.liku/supervisor-tasks.json` (`supervisor-task-store.js`)
on construction and re-persists on every change.

- **Atomic + corruption-tolerant** — tmp-file + rename; a bad/partial file loads
  as empty (never throws).
- **Flag-gated** — the store only touches disk when `LIKU_ENABLE_PERIPHERALS=1`,
  so normal coding flows never write it. Persistence is opt-in per Supervisor
  (`persistTasks`); the production factory enables it by default.
- **Retention / escalation** — per-severity retention windows prune stale
  entries on load + save: critical/high kept 7d, warning/medium 1d, low 6h;
  resolved/acknowledged entries expire after 6h. Tasks carry an `escalation`
  route derived from priority (`high→escalate`, `medium→notify`, `low→log`).
- **Bounded** — capped at 50 notifications / 20 tasks.

CLI: `liku peripherals tasks` lists durable tasks + notification counts.

## Live cumulative power budgeting (Phase 9)

The DCP evaluation now enforces a **cumulative** power budget, not just a
per-action ceiling. Before any state-changing action:

```
 projected_total = Σ estimateDeviceLoadW(other registered devices)
                 + projectedDeviceLoadW(target device, action)
 if projected_total > guard.peripherals.max_total_power_w  →  BLOCK (power-budget-exceeded)
```

- `estimateDeviceLoadW` — a device's current continuous draw from its state
  (sensors draw standby; actuators draw rated power only while active,
  proportional for dimmables).
- `projectedDeviceLoadW` — the draw *after* the action (`off→0`, `on→rated`,
  `brightness→proportional`; momentary/read actions leave draw unchanged).
- **Fails safe** — an over-budget command is blocked (surfaced as a rejection),
  never allowed through. Budget defaults to 5000 W, overridable via the
  `guard.peripherals.max_total_power_w` substrate key.

CLI: `liku peripherals power` (and `liku peripherals status`) show current draw,
budget, headroom and a per-device breakdown.

## Remote signed-token policy (Phase 9)

Drivers declare `REMOTE`. When a DCP secret is configured (`LIKU_DCP_SECRET`),
`evaluateCommandEnvelope` requires a **signed** capability token for remote
drivers (MQTT); local/trusted drivers (mock, serial) may stay unsigned for
convenience.

## Multi-process safety + HIL simulation (Phase 10)

### Advisory file locking

Every `~/.liku/*.json` write (`system-context.json`, `system-context.pending.json`,
`peripherals.json`, `supervisor-tasks.json`, history snapshots/changelog) now
goes through `src/shared/atomic-file.js` → `atomicWriteFileSync`, which holds an
**advisory lock** (`<file>.lock` directory, atomic `mkdir`) around the tmp-file +
rename. This lets concurrent CLI + Electron (or multiple CLIs) share `~/.liku/`
safely.

- **Best-effort + non-fatal** — bounded retries with a real (non-spinning) sleep;
  stale locks from crashed holders are stolen; if the lock still can't be taken
  it warns once and proceeds (last-writer-wins). Locking never blocks operation.

### Hardware-in-the-loop (HIL)

`LIKU_PERIPHERAL_HIL=1` enables a timer-free in-memory simulator
(`hil-simulator.js`). Real drivers (serial, BLE) route `perform()` to the
simulator instead of hardware, so the full DCP + class-gate + pending/confirm
path is exercisable in CI/tests with **no physical devices** — and HIL-simulated
state feeds back into cumulative power accounting. HIL is **off by default** and
never touches real hardware.

### New driver

`ble-driver.js` (wireless, `REMOTE=true`, HIL-capable) joins mock/mqtt/serial in
the PAL's `DRIVER_IDS`. The serial driver gained HIL support + bounded-buffer
framing. The mock driver remains the always-available fallback.

CLI: `liku peripherals status`/`power` show `locking` + `HIL` state;
`liku peripherals simulate <id> <k=v>...` injects a simulated reading.

## If a human decides to act

Any physical response still travels the full PAL safety chain — the alert path
never shortcuts it:

```
 PAL.execute(deviceId, action, params)
   → DCP evaluateCommand()      (capability scoping, param validation, power budget)
   → class gate                 (C: free · B: auto-gated 0.95 · A: guard.peripheral.* 0.5 → QUEUES)
   → pending/confirm            (`liku system-context confirm guard.peripheral.<id> --apply`)
   → one-shot auth consumed after success
```

## Signal-quality controls (Phase 7)

`PeripheralMonitor` filters noise before an alert is ever raised:

| Control | Default | Override | Behavior |
| --- | --- | --- | --- |
| Cooldown (debounce) | `60000` ms | `cooldownMs` option / `LIKU_PERIPHERAL_ALERT_COOLDOWN_MS` | Min gap between alerts for the same `device:metric`. |
| Hysteresis (deadband) | `0.05` (5% of threshold) | `hysteresisFraction` option / `LIKU_PERIPHERAL_HYSTERESIS_FRACTION`, or per-metric absolute `{ hysteresis }` | Once breached, no re-alert until the value returns safely past the margin. |

Together these implement a per-`device:metric` state machine: a breach fires
once, is held while the value hovers, and only re-arms after recovery + cooldown.

## DCP wire format + capability tokens (Phase 8)

`src/main/peripherals/dcp-protocol.js` formalizes the Device Control Protocol
that was previously implicit in `peripheral-policy.js`. It is a **pure** module
(crypto + structure only).

### Command envelope (wire format)

```json
{
  "dcp": "1.0",
  "type": "command",
  "id": "<correlation id>",
  "ts": 1751700000000,
  "nonce": "<per-command nonce>",
  "device": "<deviceId>",
  "action": "unlock",
  "params": {},
  "capability": "<base64url(payload)>.<signature|unsigned>"
}
```

- `ts` + `nonce` provide a **freshness/replay window** (default 30 s) and
  **replay protection** (caller-owned `seenNonces` map).
- `capability` is an optional **signed capability token** (HMAC-SHA256) scoping
  the token to `device` + `action(s)` with an `exp`. Set `LIKU_DCP_SECRET` to
  sign/verify; without a secret, tokens are an explicit `unsigned` local-mode
  marker (backward compatible for the mock + trusted local links).

### API

| Function | Purpose |
| --- | --- |
| `issueCapabilityToken({ deviceId, actions, ttlSec })` | Mint a scoped, expiring token. |
| `verifyCapabilityToken(token, { deviceId, action })` | Check signature, expiry, device + action scope. |
| `buildCommandEnvelope({ device, action, params, token })` | Construct a versioned envelope. |
| `parseCommandEnvelope(env)` | Structural validation (version/type/fields). |
| `verifyEnvelope(env, { secret, seenNonces, requireCapability })` | Full verify: structure + freshness + replay + capability. |

`peripheral-policy.js` exposes `evaluateCommandEnvelope(device, envelope, ctx)`
which verifies the envelope **then** runs the same host-side capability/param/
power validation as `evaluateCommand()` — so inbound wire commands get the full
safety treatment. Local callers keep using `evaluateCommand()` unchanged.

The **serial** and **MQTT** drivers now emit DCP envelopes (with a scoped
capability token) on `perform()`, replacing their ad-hoc payloads. The mock
driver stays local/in-process and needs no wire format.

## Safety invariants (do not regress)

- **Advisory-only.** Notifications carry `autonomousAction: false` and, for Class A
  (actuation/lock-capable) devices, `requiresHuman: true`. The consumer never
  calls the LLM and never actuates hardware.
- **Tasks are reviewable, not executable.** Peripheral tasks start at
  `pending-review`, are always `requiresHuman: true` / `autonomousAction: false`,
  and have no execution path. Approving one still goes through `PAL.execute()`.
- **Best-effort + non-blocking.** Every callback is wrapped; a bad reading or a
  consumer error can never crash the monitor or the orchestrator.
- **Bounded.** The Supervisor inbox is capped so alerts cannot overwhelm the
  workflow.
- **Gated actuation only.** The only path to a physical action is
  `PAL.execute()` → DCP → class gate → pending/confirm. The alert loop is purely
  observational.
- **Power fails safe.** Over-budget actions are blocked, never allowed through.
- **Persistence is corruption-tolerant + flag-gated.** A bad store file loads as
  empty; no disk is touched unless peripherals are enabled.
- **Concurrency-safe.** All `~/.liku/*.json` writes are atomic (tmp + rename)
  under a best-effort advisory lock; locking never blocks operation.
- **HIL is isolated.** Simulation is off by default and never touches real
  hardware; the safety chain is identical in HIL and real modes.
- **Cognitive budget unchanged.** `sensor.*`/`hardware.*.alert` facts are
  evidence-excluded from the default fragment; the default prompt stays
  byte-identical.
