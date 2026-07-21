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
exhaust). **Every connection-oriented real driver — BLE, Zigbee, ROS2 and
Matter — uses it through the shared `driver-pairing.js` surface**, so pairing is
consistent across the whole fleet (Phase 17):

- **Retry + backoff** — `canAttempt()` gates on an exponential-backoff
  `nextRetryAt`; after `maxAttempts` the device is `failed`. Tunable per driver
  via `LIKU_<DRIVER>_PAIR_MAX_ATTEMPTS` / `LIKU_<DRIVER>_PAIR_BACKOFF_MS`
  (`MATTER` / `BLE` / `ZIGBEE` / `ROS2`).
- **HIL is isolated** — in HIL mode pairing is *virtual* (`{ state:'paired',
  simulated:true }`); no real fabric/adapter/coordinator/graph is touched.
- **Never bypasses safety** — pairing is transport bookkeeping only; a paired
  device still flows through DCP → class gate → pending/confirm for every action.

Each driver exposes `pair(id)` / `unpair(id)` / `pairingStatus()`. The PAL
aggregates them uniformly via `pairDevice(id)`, `unpairDevice(id)` and
`getPairingStatus()` — and reports **connectionless** drivers (mock / MQTT /
serial) as `ready` so the surface is uniform. CLI:
`liku peripherals pair <id>`, `liku peripherals unpair <id>`,
`liku peripherals drivers` (per-device pairing state), and `status`
(paired/failed summary).

### Tier metadata on tasks + differentiated behaviour

Anomaly tasks carry `anomalyType` + `severityTier`. The tier drives **real,
visible differences** (Phase 15–17):

- **Priority / visibility** — over-budget → `critical` → **high** priority /
  `escalate`; spike/sustained → `warning` → medium / `notify`; other → `info` /
  low. `Supervisor.getNotificationsBySeverity()` lets a surface prioritise the
  inbox by tier.
- **Escalation channel routing** — the notification's tier severity gates which
  additive channels (`log`/`file`/`webhook`) it reaches (each channel has a
  min-severity), so critical anomalies fan out further than routine ones.
- **Dedup / cooldown** — over-budget surfaces fastest (15 s), sustained dedups
  longest (90 s).
- **CLI** — `tasks --anomaly` shows a `⚡<tier>` badge; `tasks --anomaly --severity
  <p>` filters by tier priority.

All tier behaviour is strictly advisory + human-gated; no tier ever actuates.

## Token lifecycle + advisory auto-scheduling (Phase 18)

### Capability-token lifecycle bound to pairing

Capability tokens (`dcp-protocol.js`) are stateless HMAC artifacts, so
`token-store.js` adds the lifecycle state that makes revocation possible, bound
to the pairing lifecycle:

- **Issue on pair** — a successful `pair()` mints generation 1 with a stable
  per-device **identity fingerprint** (HMAC over the deviceId; works signed OR
  unsigned/local).
- **Rotate on re-pair** — re-pairing after revoke bumps the generation; a stale
  token's `gen` no longer verifies (`generation-mismatch`).
- **Revoke on unpair** — `unpair()` marks the device revoked + bumps the
  generation, invalidating any outstanding token.
- **Enforcement** — the PAL's `execute()` refuses a command for any **REMOTE**
  driver whose token is revoked (`code:'token-revoked'`, "re-pair to restore").
  HIL is isolated (virtual pairing never revokes); connectionless/local drivers
  are exempt.

DCP additions: `issueCapabilityToken({ gen, identity })` and
`verifyCapabilityToken({ gen, identity })` (both optional + backward compatible).
PAL: `getTokenStatus()`, `rotateToken(id)`, `revokeToken(id)`. CLI:
`liku peripherals token [status|rotate <id>|revoke <id>]`; `drivers` shows
`token:gen<N>`.

### Advisory auto-schedule suggestions

`power-schedule-advisor.js` turns **recurring** anomalies into human-reviewable
proposed schedules — never auto-applied:

- **Detect** — `recordAnomaly()` buckets occurrences by `device:type` within a
  window (`LIKU_PERIPHERAL_ADVISOR_WINDOW_MS`, default 24 h). Once the count
  crosses `LIKU_PERIPHERAL_ADVISOR_MIN_OCCURRENCES` (default 3), `proposeSchedules()`
  emits a proposal (recurring hour → a time-boxed cap).
- **Deduplicate** — one open proposal per `device:type` until confirmed/dismissed.
- **Confirm (pending/confirm rail)** — a proposal is `status:'proposed'`,
  `autonomousAction:false`, and is **only** activated by an explicit
  `confirm(id)`, which writes it to the confirmed schedule store
  (`peripheral-schedules.json`) that `power-schedule.js` reads *in addition to*
  env. Nothing is enforced before confirmation.

The anomaly consumer feeds the advisor and re-emits new proposals as
`supervisor:schedule-suggestion` events (advisory). PAL:
`getScheduleSuggestions()`, `confirmScheduleSuggestion(id)`,
`dismissScheduleSuggestion(id)`. CLI: `liku peripherals suggestions`,
`liku peripherals apply-schedule <id>`, `liku peripherals dismiss-schedule <id>`.

## Forecasting + attribution + token rotation (Phase 19)

### Power forecasting

`power-forecast.js` turns the rolling history into **per-hour-of-day baselines**
(total + per device) and a **short-horizon forecast**:

- `hourlyBaselines()` / `deviceHourlyBaselines()` — mean / peak / count per hour.
- `forecast({ horizonHours })` — predicted draw for upcoming hours (falls back to
  the overall mean for hours with no history; needs `≥ FORECAST_MIN_SAMPLES`).
- `forecastExceedsBudget({ budgetW })` — **early warning** list of upcoming hours
  whose predicted/peak draw would exceed the budget (predictive, before it
  happens). PAL: `getPowerForecast()`, `getForecastWarnings()`. CLI:
  `liku peripherals power --forecast`.

The advisor uses the device's per-hour baseline **peak** to set a smarter cap
(`basis:'forecast-baseline'`) — letting normal operation continue while capping
the anomalous excess.

### Per-device anomaly attribution

`power-anomaly.detect()` now attributes each anomaly to the **driving device** —
the one whose current draw rose most above its own baseline (falling back to the
biggest current consumer). Anomalies carry `attributedDevice` / `attributedDeltaW`,
and the consumer targets that real device (instead of the aggregate
`power-budget`) in notifications, tasks and schedule suggestions. CLI:
`power --anomalies` shows `→ <device> (Δ<W>)`.

### Scheduled token rotation + grace window

`token-store.js` completes the lifecycle:

- **Scheduled rotation** — `LIKU_DCP_TOKEN_ROTATE_MS` arms a `rotateDueAt` on
  pair; the PAL calls `rotateIfDue()` lazily on use, so tokens rotate on a
  schedule without a background timer.
- **Grace window** — on rotation the immediately-previous generation stays valid
  for `LIKU_DCP_TOKEN_GRACE_MS` (default 60 s) so a command signed just before
  rotation is not abruptly rejected. `isTokenValid(id, gen, now)` encodes this
  (current gen always valid; previous gen valid only within grace; revoked →
  nothing valid). Revocation still overrides everything.

## Confident forecasts + multi-device coordination + anomaly→action (Phase 20)

### Forecast confidence + longer horizons

`power-forecast.js` now attaches a **confidence interval** and a qualitative
**confidence label** to every forecast hour, and supports **day-ahead horizons**:

- Each `hourlyBaselines()` bucket carries a `std` (per-hour standard deviation).
- Each `forecast()` horizon entry adds `lowW` / `highW` (`mean ± 1.28·std`),
  `stdW`, `confidence` (`high`/`medium`/`low` from sample count + coefficient of
  variation, decayed for far-ahead hours) and `stepsAhead`.
- `horizonHours` is clamped to `MAX_HORIZON_HOURS` (24) — the per-hour-of-day
  baselines wrap, so a full day ahead is a natural extension, never a runaway.
- Early warnings (`forecastExceedsBudget`) now include the band + confidence.
  CLI: `power --forecast` prints `~<W> [low–high] <conf> conf`.

### Multi-device coordinated schedule proposals

`power-forecast.contributorsAtHour({ hour, budgetW })` ranks the devices by their
per-hour baseline **peak** and reports whether their **combined** typical draw
exceeds the budget. When it does *and* **2+ devices** jointly drive it,
`power-schedule-advisor.proposeMultiDeviceSchedule()` proposes a **coordinated**
set of per-device caps, allocated proportionally to each device's share so the
caps **sum within the budget**. `confirm()` writes **one restrict-only rule per
device** (`source:'advisor-confirmed-multi'`). Strictly advisory + human-gated,
deduped one open proposal per hour. The consumer fires this on over-budget
anomalies and emits `supervisor:schedule-suggestion`.

### Advisory anomaly→action patterns (proactive self-healing)

`anomaly-action-advisor.js` watches for **persistently anomalous devices** and
escalates an advisory action up a fixed ladder (all **non-actuating** and already
human-gated CLI operations):

| Occurrences (window) | Advisory action | Severity | Directive |
| --- | --- | --- | --- |
| 3× | `reduce-schedule` | warning | cap power via a confirmed schedule |
| 6× | `rotate-token` | warning | `liku peripherals token rotate <id>` |
| 10× | `unpair` | critical | `liku peripherals unpair <id>` |

`proposeActions()` surfaces the **highest** rung met (monotonic supersede);
`confirm()` **records the human's approval and returns the exact command to run —
it never executes the action** (no autonomous actuation path). The synthetic
`power-budget` aggregate is skipped (no single device to act on). PAL:
`getAnomalyActions()`, `confirmAnomalyAction()`, `dismissAnomalyAction()`. CLI:
`liku peripherals anomalies [--attributed]` and
`liku peripherals anomaly-action [confirm|dismiss <id>]`. The consumer emits
`supervisor:anomaly-action` for new proposals.

### Phase 20 safety invariants

- **forecast-confidence-only-informs** — confidence intervals / longer horizons /
  contributor analysis are pure observation. They inform smarter (still
  human-confirmed) suggestions and never actuate.
- **multi-device-caps-only-restrict** — a coordinated proposal only ever writes
  restrict-only schedule rules that sum within the budget, and only after an
  explicit `confirm()`. It never turns a device on/off or raises any cap.
- **anomaly-actions-are-advisory** — every anomaly→action suggestion is a
  reviewable proposal; confirmation returns a command for a human to run. No
  suggestion (including `unpair`/`rotate-token`) is auto-executed, and none
  actuates the physical device.

## Lock observability + cross-host coordination + cron scheduling (Phase 21)

### Lock observability over time

`src/shared/atomic-file.js` now tracks **per-file** contention (not just global
counters): `getPerFileLockMetrics()` maps each store's basename → `{ acquired,
contended, steals, fallbacks, retries }`. `src/main/peripherals/lock-history.js`
**persists** periodic snapshots to `~/.liku/lock-history.jsonl` (rolling, atomic,
flag-gated) and computes **trends** — the delta between the first and last
snapshot, the current contention rate, and the hottest files. Snapshots accrue
naturally (a best-effort `record()` fires after each power sample) or on demand.
PAL: `getLockHistory()`, `recordLockSnapshot()`, `getLockTrends()`. CLI:
`liku peripherals locks [--record]` and an enriched `status` (hottest lock).

### Cross-host coordination foundation

`src/main/peripherals/coordination.js` adds a dependency-free **TTL-lease** layer
for multi-node fleets. A node identity (`LIKU_NODE_ID` or `hostname:pid`) takes a
lease on a resource (`device:<id>`, a task, a token) by atomically creating a
directory under a **shared** `LIKU_CLUSTER_DIR/leases/`. mkdir is atomic across
hosts on a shared filesystem, giving mutual exclusion; an **expired** lease
(crashed holder) is stolen; only the owner can release early.

- **Single-machine is the default** — with `LIKU_CLUSTER_DIR` unset, cluster mode
  is OFF and every lease is granted locally, so the single-machine path is
  completely unchanged (no new files, no new behaviour).
- The PAL `execute()` gate consults `coordination.canAct('device:<id>')` for
  REMOTE drivers only when cluster mode is on: a device leased by another node is
  rejected with `device-leased-elsewhere`. Best-effort + non-fatal.
- Resource ids are strictly allow-list sanitized (`..` collapsed, `/`/`\`
  stripped) — no path traversal, no new attack surface.
- PAL: `getCoordinationStatus()`, `acquireDeviceLease()`, `releaseDeviceLease()`.
  CLI: `liku peripherals coordination [status|lease <id>|release <id>]`.

### Cron-based device scheduling (stretch)

`src/main/peripherals/device-schedule.js` adds optional **5-field cron** rules
(`LIKU_DEVICE_CRON`) for recurring device actions. A due cron rule NEVER
actuates — it produces an **advisory, human-gated proposed task** (`status:
'pending-review'`, `autonomousAction:false`); Class A devices are flagged
`requiresHuman` and remain confirm-gated at `execute` time regardless.

- **Sandboxed parser** — split → bounded numeric ranges only (`*`, `a`, `a-b`,
  `a-b/n`, `*/n`, comma lists). No eval, no dynamic code, no catastrophic-
  backtracking regex; every field is strictly range-checked and malformed rules
  are dropped. Actions are restricted to a conservative allow-list
  (`on/off/toggle/lock/unlock/open/close/check/status`).
- Vixie-cron day-of-month/day-of-week OR semantics when both are restricted.
- Additive + backward-compatible: existing time-boxed power schedules are
  untouched. PAL: `getCronSchedules()`, `getDueCronTasks(now)`. CLI:
  `liku peripherals cron [--at <ISO>]`.

### Phase 21 safety invariants

- **lock-observability-is-pure** — persisting metrics/trends never changes locking
  behaviour or actuates anything; recording is on-demand (no background timer).
- **cross-host-preserves-single-machine** — cluster mode is opt-in; with no
  `LIKU_CLUSTER_DIR` the single-machine path is byte-for-byte unchanged. Leases
  are advisory coordination bookkeeping and never bypass the PAL safety chain.
- **cron-triggers-are-advisory** — a cron match yields a reviewable proposed task,
  never an actuation. Class A stays human-gated, and the parser adds no new
  attack surface.

## Token hardening + cron productionization + cluster lock aggregation (Phase 22)

### Token lifecycle refinements

`token-store.js` gains two security refinements plus cross-host propagation:

- **Per-action (least-privilege) tokens** — `issueActionToken(deviceId, action)`
  mints a capability token scoped to EXACTLY ONE action (refused if the action is
  not in the device's granted capability set). `verifyDeviceToken(deviceId,
  action, token)` validates against the current lifecycle state (revocation,
  effective generation, identity binding, action scope) with grace-window support.
- **Human-gated auto-revoke on persistent anomalies** — when the anomaly→action
  advisor escalates to `rotate-token` / `unpair` and a human CONFIRMS,
  `PAL.confirmAnomalyAction()` PERFORMS the approved security operation
  (`rotateToken` / `unpairDevice`→token revoke). These are non-actuating security
  ops; the confirmation is the human gate. `{ execute:false }` records approval
  without performing.
- **Cross-host propagation** — in cluster mode a device's lifecycle record (gen /
  revoked / identity) is MIRRORED to `LIKU_CLUSTER_DIR/tokens/<id>.json`. The
  effective state merges local + shared (REVOCATION-WINS, generation = max), so a
  revocation or rotation on one node is honoured fleet-wide. Single-machine
  (cluster off) → unchanged.

### Cron productionization

- **Real tick/consumer** — `src/main/agents/cron-scheduler.js` `attachCronScheduler(orch)`
  exposes a `tick(now)` that turns DUE cron rules into bounded, human-gated
  Supervisor tasks (via `createPeripheralTask` → `supervisor:task` +
  `supervisor:cron-task`), with per-`device:action` **dedup + cooldown**
  (`LIKU_PERIPHERAL_CRON_COOLDOWN_MS`, default 5 min). TIMER-FREE by default; an
  optional `intervalMs` timer is off unless requested and is `unref`'d.
- **Confirm flow (persist rules)** — `device-schedule.js` adds
  `proposeRule` → `confirmRule` (writes to `device-cron.json`, read by
  `loadRules`) / `dismissRule` / `removeConfirmedRule`. A proposed rule is NEVER
  active until confirmed. CLI: `liku peripherals cron [propose|confirm|dismiss|rules|tick|remove]`.
- A cron task is still ADVISORY: actuating it requires `PAL.execute` (Class A
  stays confirm-gated); `autonomousAction` is always false.

### Distributed lock/metrics aggregation

`lock-history.js` mirrors each node's latest snapshot to
`LIKU_CLUSTER_DIR/lock-metrics/<nodeId>.json`. `clusterAggregate()` rolls up
fleet totals + per-node breakdown + combined per-file hotspots (folding in this
node's live counters). PAL: `getClusterLockMetrics()`. CLI `locks` shows the
cluster view when a shared cluster dir is configured.

### Phase 22 safety invariants

- **least-privilege-tokens** — per-action tokens narrow (never widen) a device's
  capability; verification honours revocation + generation + identity + scope.
- **auto-revoke-is-human-gated** — a token rotation / unpair only happens after an
  explicit human confirmation of the escalated anomaly→action; it is a security
  operation (no physical actuation) and never bypasses the PAL chain.
- **cron-tasks-stay-advisory** — a productionized cron tick creates reviewable
  `pending-review` tasks only; Class A stays confirm-gated, nothing auto-runs.
- **cluster-propagation-is-additive** — token / lock cluster mirroring only runs
  when `LIKU_CLUSTER_DIR` is set; single-machine behaviour is byte-for-byte
  unchanged.

## Seasonal forecasts + advanced anomaly→action (Phase 23)

### Forecast refinements

`power-forecast.js` sharpens prediction with weekly seasonality + per-device attribution:

- **Day-of-week seasonality** — `dowHourlyBaselines()` buckets by day-of-week ×
  hour-of-day. `seasonalForecast()` prefers the dow×hour baseline for each
  upcoming hour (when it has `≥ LIKU_PERIPHERAL_FORECAST_DOW_MIN` samples),
  falling back to the hour-of-day baseline, then the overall mean. The plain
  `forecast()` is unchanged.
- **Per-device forecast warnings** — `deviceForecastWarnings({ budgetW })` names,
  for each upcoming over-budget hour, the device MOST LIKELY to drive it (highest
  per-hour baseline peak). PAL: `getSeasonalForecast()`,
  `getDeviceForecastWarnings()`. CLI: `power --forecast [--seasonal]`.
- **Multi-hour coordinated scheduling** — `power-schedule-advisor.proposeMultiHourSchedule()`
  scans the forecast for the longest CONTIGUOUS run of hours whose confidence
  upper band exceeds budget and proposes ONE window `[from..to]` with per-device
  caps (allocated by each contributor's share). Confirmation writes a restrict-only
  rule per device across the whole window. PAL: `getMultiHourProposal()`.

### Advanced anomaly→action patterns

- **Auto-create + confirm reduce-schedule** — when a human confirms a
  `reduce-schedule` anomaly→action, `PAL.confirmAnomalyAction()` calls
  `power-schedule-advisor.createConfirmedSchedule()` to write a restrict-only
  schedule for the device (cap derived from its forecast baseline peak, falling
  back to the power budget). The confirmation IS the human gate; nothing actuates.
- **Fleet-wide rotate-all** — `anomaly-action-advisor.proposeFleetAction()`
  proposes a single advisory `rotate-all` when `≥ LIKU_PERIPHERAL_FLEET_MIN_DEVICES`
  distinct devices are persistently anomalous. Confirming it runs
  `token-store.rotateAll()` (rotate every ACTIVE token; skip revoked), mirrored
  across the cluster. Human-gated; reuses the `supervisor:anomaly-action` event.
  CLI: `token rotate-all`, `anomaly-action confirm <id>`.

### Phase 23 safety invariants

- **forecast-refinements-only-observe** — seasonality, per-device warnings, and
  multi-hour analysis are pure prediction; they sharpen (still human-confirmed)
  suggestions and never actuate.
- **auto-heal-is-human-gated** — reduce-schedule / rotate-token / unpair /
  rotate-all all execute ONLY on an explicit human confirmation of the escalated
  anomaly→action, and are non-actuating (restrict / crypto / pairing) operations
  that never bypass the PAL safety chain.
- **fleet-actions-are-advisory** — a fleet rotate-all is a proposal until
  confirmed; it rotates tokens (a security op), never actuates a device.

## Multi-device auto-heal + anomaly-aware forecasts (Phase 24)

### Anomaly→action refinements

- **Multi-device coordinated reduce on confirm** — when a human confirms a
  `reduce-schedule` anomaly→action, `PAL.confirmAnomalyAction()` first tries
  `power-schedule-advisor.createConfirmedMultiSchedule()`: if the current-hour
  breach is jointly driven by 2+ devices, it writes ONE restrict-only rule per
  contributor (caps proportional to peak share, sum ≤ budget). A single
  contributor falls back to the single-device `createConfirmedSchedule()`. The
  confirmation IS the human gate; nothing actuates.
- **Per-device auto-heal policies** — `anomaly-action-advisor` supports
  per-device occurrence thresholds for each ladder action (`reduce-schedule` /
  `rotate-token` / `unpair`). Sources (later overrides earlier): default ladder →
  `LIKU_PERIPHERAL_AUTOHEAL_POLICIES` env (a `*` key sets a fleet default) → the
  persisted store (`setPolicy`). `proposeActions` uses each device's effective
  thresholds. PAL: `getAutoHealPolicies()`, `setAutoHealPolicy()`. CLI:
  `anomaly-action policy [list|set <device> reduce=N rotate=N unpair=N]`.

### Power forecasting refinements

- **Confidence-weighted multi-hour caps** — `proposeMultiHourSchedule` allocates
  per-device caps from a confidence-weighted reference `mean + w·(peak−mean)`,
  where `w` grows as the run's confidence drops (high→mean-leaning, low→peak-
  leaning). Shares still sum to budget, so caps never exceed it (restrict-only).
- **Holiday / anomaly-aware baselines** — `seasonalForecast({ excludeAnomalous:true })`
  drops known-anomalous samples (flagged `overBudget`/`anomalous`, or dates in
  `LIKU_PERIPHERAL_FORECAST_HOLIDAYS`) so a one-off spike or atypical day doesn't
  skew normal-operation predictions. The plain `forecast()` stays byte-identical.
- **Improved day-of-week handling** — a weekend/weekday GROUP baseline sits
  between the dow×hour baseline and the hour-of-day fallback, filling a specific
  weekday's gaps from the broader group. CLI: `power --forecast [--seasonal] [--exclude-anomalous]`.

### Phase 24 safety invariants

- **multi-device-caps-only-restrict** — a coordinated reduce writes only
  restrict-only rules whose caps sum within budget, and only on explicit human
  confirmation. It never turns a device on/off or raises a cap.
- **policies-only-gate-visibility** — auto-heal policies change WHEN a proposal is
  surfaced (per-device thresholds); they never make an action autonomous.
- **forecast-refinements-only-observe** — confidence weighting, anomaly-aware
  exclusion, and group baselines are pure prediction; they sharpen (still
  human-confirmed) suggestions and never actuate.

## Cross-host refinements + deeper self-healing (Phase 25)

### Cross-host coordination refinements

- **Lease-aware pairing** — in cluster mode `driver-pairing.pair()` first acquires
  the device lease (`device:<id>`, the SAME key the PAL execute gate checks); only
  the lease holder may complete pairing (and bind its token). A blocked node
  returns `error:'leased-elsewhere'`. `unpair()` releases the lease. Lease TTL:
  `LIKU_PERIPHERAL_PAIR_LEASE_TTL_MS` (default 300000) — auto-expires so a crashed
  node can't block forever. Single-machine (cluster off) → unchanged.
- **Distributed cron dedup** — `coordination.claimOnce(resourceId, {ttlMs})` claims
  a short-lived lease so exactly ONE fleet node fires a given rule per minute
  bucket. The cron scheduler claims `cron:<device>:<action>:<yyyy-mm-ddThh:mm>`
  before creating a task; a losing node skips (no duplicate Supervisor task).
- **Cluster GC / TTL sweeper** — `token-store.sweepClusterTokens({ttlMs})` removes
  cluster token records not updated within `LIKU_DCP_CLUSTER_TOKEN_TTL_MS`
  (default 7 days; a live revocation keeps mirroring `updatedAt`, so it is never
  GC'd out from under other nodes). `coordination.pruneExpiredLeases()` removes
  expired lease dirs. PAL `sweepCluster()` drives both lazily (no background
  timer). CLI: `coordination sweep`.

### Anomaly→action refinements

- **Auto multi-hour coordinated reduce on confirm** — confirming a
  `reduce-schedule` anomaly→action now prefers the STRONGEST coordinated response:
  a **multi-hour** window (`createConfirmedMultiHourSchedule`, contiguous
  over-budget run, confidence-weighted per-device caps) → else a single-hour
  **multi-device** cap → else a single-device schedule. All restrict-only, caps
  sum ≤ budget, human-approved via the confirm.
- **Per-device auto-heal escalation cooldown** — a device with a lower-rung
  proposal does not escalate to the next rung until
  `LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS` (default 3600000) elapses. It
  NEVER suppresses the first proposal, and NEVER suppresses a CRITICAL rung
  (e.g. `unpair`) — safety paths always surface immediately.

### Forecast refinements

- **Longer seasonal windows** — `LIKU_PERIPHERAL_FORECAST_LOOKBACK_MS` sets the
  default history lookback (e.g. 7–14 days). Unset → all history (byte-identical).
- **Data-driven special-day detection** — `detectSpecialDays()` flags dates whose
  daily-mean draw deviates from the cross-day distribution by `>` 
  `LIKU_PERIPHERAL_FORECAST_SPECIAL_SIGMA` σ (default 2). With
  `LIKU_PERIPHERAL_FORECAST_AUTO_SPECIAL=1`, `seasonalForecast({excludeAnomalous})`
  also excludes those auto-detected days (in addition to the
  `LIKU_PERIPHERAL_FORECAST_HOLIDAYS` override list). PAL: `getSpecialDays()`.
  CLI: `power --forecast --special-days`.

### New environment variables (all default OFF / inert)

| Variable | Default | Purpose |
| --- | --- | --- |
| `LIKU_PERIPHERAL_PAIR_LEASE_TTL_MS` | `300000` | Lease TTL for lease-aware pairing |
| `LIKU_DCP_CLUSTER_TOKEN_TTL_MS` | `604800000` | Cluster token GC age threshold |
| `LIKU_PERIPHERAL_AUTOHEAL_ESCALATION_COOLDOWN_MS` | `3600000` | Auto-heal escalation cooldown (0 = off) |
| `LIKU_PERIPHERAL_FORECAST_LOOKBACK_MS` | unset | Rolling seasonal window |
| `LIKU_PERIPHERAL_FORECAST_AUTO_SPECIAL` | unset | Enable data-driven special-day exclusion |
| `LIKU_PERIPHERAL_FORECAST_SPECIAL_SIGMA` | `2` | Special-day detection sensitivity |

### Phase 25 safety invariants

- **lease-owned-pairing** — in cluster mode pairing/token binding only proceeds
  on the node holding the device lease; single-machine is byte-for-byte unchanged.
- **cron-fires-once-per-fleet** — a cron rule creates at most one Supervisor task
  per minute bucket across the fleet (claim-once); losers skip, never duplicate.
- **token-gc-is-conservative** — only records stale beyond a generous TTL are
  GC'd; an active revocation keeps refreshing `updatedAt` and is never removed.
- **cooldown-never-suppresses-safety** — escalation cooldown holds only non-critical
  rung upgrades; first proposals and critical rungs always surface.
- **coordinated-reduce-only-restricts** — multi-hour/multi-device reduce writes
  only restrict-only rules whose caps sum ≤ budget, and only on human confirm.

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
- **Tokens are lifecycle-bound + revocable.** A capability token is issued on
  pair, rotated on re-pair and revoked on unpair; a REMOTE driver refuses to send
  for a revoked device. Token operations never actuate and HIL stays virtual.
- **Auto-schedules never self-activate.** Recurring anomalies only *propose*
  schedules (`autonomousAction:false`); a proposal is enforced ONLY after an
  explicit human `confirm`, and even then can only ever restrict power.
- **Forecasts + attribution only observe.** Per-hour forecasting and per-device
  attribution read history to sharpen advisory suggestions/warnings; they never
  actuate and never bypass the human gate.
- **Token rotation preserves safety.** Scheduled rotation + grace window keep
  in-flight commands valid without weakening revocation (a revoked device rejects
  every generation); rotation never actuates and HIL stays virtual.
- **Cognitive budget unchanged.** `sensor.*`/`hardware.*.alert` facts are
  evidence-excluded from the default fragment; the default prompt stays
  byte-identical.
