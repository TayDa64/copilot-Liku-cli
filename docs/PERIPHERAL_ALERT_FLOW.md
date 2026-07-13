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

## Advanced escalation + driver surface (Phase 11)

### Notification channels

Beyond the always-on Supervisor **inbox**, notifications can fan out to additive,
advisory-only SINKS via `src/main/agents/notification-channels.js`:

| Channel | Sink | Default min-severity |
| --- | --- | --- |
| `log` | one-line console summary | `info` |
| `file` | bounded JSONL audit trail (`~/.liku/peripheral-notifications.log`, ≤500 lines, atomic + locked) | `info` |
| `webhook` | fire-and-forget POST to `LIKU_PERIPHERAL_WEBHOOK_URL` (timeout-bounded, never throws) | `warning` |

Enable with `LIKU_PERIPHERAL_CHANNELS="log,file,webhook"` (default: **inbox only**,
so behaviour is unchanged). Each channel has a per-severity threshold
(`LIKU_PERIPHERAL_<CHANNEL>_MIN_SEVERITY`) so low-value noise never pages an
external system. Channels are pure sinks: they forward an advisory notification
and **never** actuate hardware or call the LLM. Delivery is best-effort +
non-blocking and only fires when `LIKU_ENABLE_PERIPHERALS=1`.

### Auto-acknowledge + flapping cooldown

The Supervisor gained two noise-reduction controls (both **default OFF**, both with
a hard safety floor — Class A / `requiresHuman` / critical are **never** affected):

| Control | Config | Behaviour |
| --- | --- | --- |
| Auto-acknowledge | `LIKU_PERIPHERAL_AUTO_ACK_SEVERITIES="info,low"` (or `autoAckSeverities` option) | Routine low-severity notifications/tasks are resolved automatically (`autoAcknowledged: true`) so a human is not paged. |
| Task cooldown | `LIKU_PERIPHERAL_TASK_COOLDOWN_MS=60000` (or `taskCooldownMs` option) | A task for the same `device:metric:level` is **suppressed** if one was active within the window — flapping-sensor spam protection. Cooldown is recorded on create/coalesce/resolve. |

Per-severity routing is unchanged (`escalate`/`notify`/`log` by priority) and now
queryable: `getEscalatedPeripheralTasks()`, `getPeripheralTasksBySeverity(p)`.

### New driver — Zigbee

`zigbee-driver.js` (mesh, `REMOTE=true`, HIL-capable) joins
mock/mqtt/serial/ble in the PAL's `DRIVER_IDS`. Available when devices are
declared (`LIKU_ZIGBEE_DEVICES`) **and** (HIL is on **or** a coordinator is
configured, `LIKU_ZIGBEE_COORDINATOR`); the optional `zigbee-herdsman` lib is
required lazily. It emits the same signed DCP envelope and refuses unsigned
commands when a secret is set — identical safety to BLE/MQTT.

CLI: `liku peripherals tasks [--escalated|--pending|--severity <p>]`,
`liku peripherals notifications [--pending|--severity <s>]`,
`liku peripherals channels` (show configured escalation sinks). `status` now also
lists active channels.

## Real bidirectional transport + power telemetry (Phase 12)

### Real BLE connect / notify / write

`ble-driver.js` now implements a real **bidirectional** transport (in addition to
HIL). A `BleCentral` connection manager scans for declared peripherals, connects,
resolves a **write** characteristic and subscribes to a **notify** characteristic:

- `perform()` (real path) writes the signed **DCP envelope bytes** to the connected
  write characteristic. Until a connection exists it returns
  `{ ok:false, reason:'not-connected' }` and kicks a lazy connect — but the PAL has
  already enforced the class gate, so a Class A action still requires confirmation.
- Inbound notify **value-changes** are parsed (JSON) and forwarded to
  `PAL.ingestSensorReading()`, so wireless sensor updates flow into the normal
  grounding + monitor + escalation pipeline.
- The optional `@abandonware/noble`/`noble` lib is required lazily; a test seam
  (`_setBleLibForTest`) allows the real path to be exercised with a fake adapter.
- Extra device config: `peripheralId` / `address` (match), `serviceUuid`,
  `writeCharUuid`, `notifyCharUuid`. HIL stays fully isolated — the real transport
  is used **only** when HIL is off.

### Power telemetry history + trending

`power-history.js` persists a **rolling** JSONL log
(`~/.liku/power-history.jsonl`, ≤1000 samples, atomic + locked, flag-gated). The
PAL records a snapshot after every successful actuation (`recordPowerSample()`),
and exposes:

| Accessor | Result |
| --- | --- |
| `getPowerHistory({ sinceMs, limit })` | recent timestamped samples |
| `getPowerTrend({ sinceMs })` | `{ count, peakW, avgW, currentW, perDevicePeakW }` |

`powerStatus()` now folds in `peakW` / `avgW` / `samples`. CLI:
`liku peripherals power --history` and `--trend`.

### Per-device power schedules (time-boxed budgets)

`power-schedule.js` is an **additive, default-OFF** restriction layer. Declare
`LIKU_PERIPHERAL_SCHEDULES=[{ id, fromHour, toHour, maxW }]` and the PAL enforces
it **before** the class gate: inside the window a device may draw up to `maxW`;
outside the window its cap is `0` (must be off). Over the cap → rejected with
`power-schedule-exceeded`. Schedules can only ever make actuation **more**
restrictive — they never grant power and never bypass DCP / class gate /
pending-confirm. No schedules configured → no effect. CLI:
`liku peripherals schedules`.

### Lock contention metrics

`atomic-file.js` now tracks best-effort counters
(`acquired / contended / steals / fallbacks / retries`) via `getLockMetrics()`.
Surfaced in `liku peripherals status`.

## Real Zigbee + smarter power (Phase 13)

### Real bidirectional Zigbee

`zigbee-driver.js` now implements a real **bidirectional** mesh transport (in
addition to HIL). A `ZigbeeCoordinator` wraps a `zigbee-herdsman` Controller:

- `perform()` (real path) resolves the device endpoint
  (`getDeviceByIeeeAddr` → `getEndpoint`) and issues a **ZCL command** mapped from
  the action (`on/off`→`genOnOff`, `lock/unlock`→`closuresDoorLock`,
  `open/close`→`closuresWindowCovering`, `brightness`→`genLevelCtrl`). Until the
  endpoint resolves it returns `{ ok:false, reason:'not-connected' }` — but the
  PAL has already enforced the class gate, so Class A still requires confirmation.
- Inbound **attribute reports** (`message` events) are parsed and forwarded to
  `PAL.ingestSensorReading()`, so mesh sensor updates flow into the normal
  grounding + monitor + escalation pipeline.
- The `zigbee-herdsman` lib is required lazily; a test seam
  (`_setZigbeeLibForTest`) exercises the real path with a fake controller.

### Advanced power schedules

`power-schedule.js` gained:

- **Per-day** rules — `days: [0..6]` or names (`["mon","tue"]`). A rule only
  governs on its days; if a device has only day-restricted rules and none match
  today, it is **unrestricted** today (schedules only ever restrict).
- **Sunrise/sunset** window tokens — `fromHour`/`toHour` may be `"sunrise"` /
  `"sunset"`, resolved from `LIKU_PERIPHERAL_SUNRISE_HOUR` / `_SUNSET_HOUR`
  (defaults 6/18) or per-rule `sunriseHour` / `sunsetHour`.

Still additive + restrictive-only and enforced **before** the class gate.

### Power anomaly detection

`power-anomaly.js` reads the rolling power history and flags advisory anomalies:

| Type | Trigger |
| --- | --- |
| `spike` | latest > `baselineMean × spikeFactor` **and** > `mean + σ·stddev`, with a min absolute delta |
| `sustained` | last N samples all above `baselineMean × sustainedFactor` |
| `over-budget` | latest sample exceeded its recorded budget |

`recordPowerSample()` runs detection after each actuation and emits a decoupled
**`power-anomaly`** event (pure observation — never actuates). Accessor:
`getPowerAnomalies()`; `powerStatus().anomalies` carries the count. CLI:
`liku peripherals power --anomalies`. Tunable via `LIKU_PERIPHERAL_ANOMALY_*`.

## Actionable anomalies + robotics foundation (Phase 14)

### Anomaly → escalation

`power-anomaly-consumer.js` bridges the advisory `power-anomaly` event into the
SAME human-gated escalation pipeline used by sensor alerts:

```
 PAL 'power-anomaly'  →  buildAnomalyNotification()  (advisory, Class C synthetic)
   → SupervisorAgent.receiveNotification()   (bounded inbox + channels)
     → orchestrator.emit('supervisor:notification')
       → SupervisorAgent.createPeripheralTask({ source:'power-anomaly' })
         → orchestrator.emit('supervisor:task')   (reviewable, pending-review)
```

- The consumer applies its OWN **dedup + cooldown** (`LIKU_PERIPHERAL_ANOMALY_COOLDOWN_MS`,
  default 60 s) so a flapping power signal cannot spam the queue, independent of
  the Supervisor's task cooldown.
- Tasks are tagged `source:'power-anomaly'` and stay `pending-review`,
  `requiresHuman:true`, `autonomousAction:false` — **strictly advisory**. The
  anomaly is modelled as a read-only **Class C** synthetic device so it can never
  become an actuation path. `createAgentSystem` auto-attaches the consumer
  (flag-gated). CLI: `liku peripherals tasks --anomaly`.

### ROS2 bridge foundation

`ros2-driver.js` (robotics, `REMOTE=true`, HIL-capable) joins the driver set. A
`Ros2Bridge` wraps a `rclnodejs` node:

- `perform()` (real path) **publishes** the signed DCP envelope to the device's
  command topic; until the node is ready it returns `{ ok:false, reason:'not-connected' }`
  — but the PAL has already enforced the class gate, so Class A still confirms.
- Inbound messages on the state topic are parsed and forwarded to
  `PAL.ingestSensorReading()`.
- Available when devices are declared (`LIKU_ROS2_DEVICES`) **and** (HIL is on
  **or** a domain is configured, `LIKU_ROS2_DOMAIN`); `rclnodejs` is required
  lazily, with a `_setRos2LibForTest` seam for the real path.

## Matter/Thread + anomaly tiers (Phase 15)

### Matter/Thread bridge foundation

`matter-driver.js` (smart-home, `REMOTE=true`, HIL-capable) joins the driver
set. A `MatterController` wraps a matter.js commissioning controller:

- `perform()` (real path) **invokes** a Matter cluster command mapped from the
  action (`on/off`→`OnOff`, `lock/unlock`→`DoorLock`,
  `open/close`→`WindowCovering`, `brightness`→`LevelControl`) on the node
  endpoint (`getNode` → `getEndpoint` → `invoke`). Until the node resolves it
  returns `{ ok:false, reason:'not-connected' }` — but the PAL has already
  enforced the class gate, so Class A still confirms.
- Inbound **attribute reports** are parsed and forwarded to
  `PAL.ingestSensorReading()`.
- Available when devices are declared (`LIKU_MATTER_DEVICES`) **and** (HIL is on
  **or** a fabric is configured, `LIKU_MATTER_FABRIC`); the matter.js lib is
  required lazily, with a `_setMatterLibForTest` seam for the real path.

### Anomaly severity tiers

`power-anomaly-consumer.js` now maps anomaly **type → advisory tier**
(`ANOMALY_TIERS`), driving differentiated task priority, escalation routing and
dedup window — while staying strictly advisory:

| Type | Severity → task | Escalation | Cooldown |
| --- | --- | --- | --- |
| `over-budget` | `critical` → **high** | `escalate` | 15 s (surfaces fastest, never auto-acked) |
| `sustained` | `warning` → medium | `notify` | 90 s (persistent → dedups longer) |
| `spike` | `warning` → medium | `notify` | 60 s |
| _(other)_ | `info` → low | `log` | 120 s |

An explicit `cooldownMs` option / `LIKU_PERIPHERAL_ANOMALY_COOLDOWN_MS` overrides
all tiers. Higher severity only means **more visibility/priority** — every
anomaly task remains `pending-review`, `autonomousAction:false`, and modelled on
a read-only Class C synthetic device (never an actuation path). CLI:
`liku peripherals power --anomalies` shows the tier; `tasks --anomaly` shows the
resulting priority.

## Commissioning / pairing + tier task metadata (Phase 16)

### Pairing / commissioning state machine

`pairing.js` provides a reusable, testable state machine
(`unpaired → pairing → paired`, with backed-off retries → `failed` once attempts
exhaust). The **Matter** (fabric commissioning) and **BLE** (connect) drivers use
it:

- **Retry + backoff** — `canAttempt()` gates on an exponential-backoff
  `nextRetryAt`; after `maxAttempts` the device is `failed`. Tunable via
  `LIKU_MATTER_PAIR_MAX_ATTEMPTS` / `LIKU_MATTER_PAIR_BACKOFF_MS` (and the BLE
  equivalents).
- **HIL is isolated** — in HIL mode pairing is *virtual* (`{ state:'paired',
  simulated:true }`); no real fabric/adapter is touched.
- **Never bypasses safety** — pairing is transport bookkeeping only; a paired
  device still flows through DCP → class gate → pending/confirm for every action.

Drivers expose `pair(deviceId)` + `pairingStatus()`; the PAL aggregates them via
`pairDevice(id)` + `getPairingStatus()`. CLI: `liku peripherals pair <id>`,
`liku peripherals drivers` (per-device pairing state), and `status` (paired/failed
summary).

### Tier metadata on tasks

Anomaly tasks now carry `anomalyType` + `severityTier` so a human-facing surface
can differentiate at a glance. Combined with the tiered priority/escalation and
per-tier cooldown, over-budget anomalies are high-priority / `escalate` / fastest
to surface, while spikes are medium / `notify`. `tasks --anomaly --severity <p>`
filters anomaly tasks by tier priority. All still strictly advisory.

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
- **Escalation never escalates authority.** Channels are advisory SINKS;
  auto-acknowledge and flapping-cooldown NEVER apply to Class A / `requiresHuman`
  / critical items; no escalation control opens an autonomous actuation path.
- **New drivers inherit the full safety chain.** Zigbee (like BLE/MQTT/serial)
  emits signed DCP envelopes and is gated by DCP → class gate → pending/confirm;
  Class A stays confirm-gated even in HIL.
- **Real transport never bypasses the gate.** The real BLE write path only fires
  AFTER `isPhysicalActionAllowed`; a live connection does not weaken Class A —
  the write happens only once a human has confirmed.
- **Power schedules only restrict.** A per-device schedule can lower a device's
  allowed draw (or force it off outside its window) but can NEVER grant power or
  bypass the class gate; with no schedules configured it has zero effect.
- **Power history is pure observation.** Recording a power sample never actuates
  anything; the log is bounded, atomic, flag-gated, and corruption-tolerant.
- **Anomaly detection only observes.** Spike/sustained/over-budget detection
  reads history and emits an advisory `power-anomaly` event; it never actuates,
  never gates, and is flag-gated + additive (quiet with insufficient history).
- **Advanced schedules only restrict.** Per-day + sunrise/sunset rules can only
  lower a device's allowed draw (or force it off outside its window); a device
  with no rule governing "now" is unrestricted, and schedules never actuate.
- **Anomaly-driven tasks stay advisory.** A `power-anomaly` becomes a bounded,
  `pending-review`, `autonomousAction:false` task modelled on a read-only Class C
  synthetic device; it never actuates, and consumer-level dedup/cooldown prevents
  flapping-signal spam.
- **New drivers inherit the safety chain.** The ROS2 bridge (like BLE/Zigbee)
  publishes signed DCP envelopes and is gated by DCP → class gate →
  pending/confirm; Class A stays confirm-gated even in HIL.
- **Matter stays gated.** The Matter bridge invokes cluster commands only after
  `isPhysicalActionAllowed`; a live fabric never weakens Class A (invoke happens
  only post-confirmation), and discover/gating work without the matter.js lib.
- **Anomaly tiers only re-prioritise.** Higher tiers (e.g. over-budget→critical)
  raise visibility/priority and shorten the dedup window but never actuate, never
  bypass the human gate, and keep `autonomousAction:false` on a read-only Class C
  synthetic device.
- **Pairing never actuates.** Commissioning/pairing is transport bookkeeping with
  bounded retry + backoff; a paired device still flows through DCP → class gate →
  pending/confirm, and HIL pairing is virtual (no real fabric/adapter touched).
- **Cognitive budget unchanged.** `sensor.*`/`hardware.*.alert` facts are
  evidence-excluded from the default fragment; the default prompt stays
  byte-identical.
