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
```

At this point the human sees an advisory. **Nothing has actuated.**

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

## Safety invariants (do not regress)

- **Advisory-only.** Notifications carry `autonomousAction: false` and, for Class A
  (actuation/lock-capable) devices, `requiresHuman: true`. The consumer never
  calls the LLM and never actuates hardware.
- **Best-effort + non-blocking.** Every callback is wrapped; a bad reading or a
  consumer error can never crash the monitor or the orchestrator.
- **Bounded.** The Supervisor inbox is capped so alerts cannot overwhelm the
  workflow.
- **Gated actuation only.** The only path to a physical action is
  `PAL.execute()` → DCP → class gate → pending/confirm. The alert loop is purely
  observational.
- **Cognitive budget unchanged.** `sensor.*`/`hardware.*.alert` facts are
  evidence-excluded from the default fragment; the default prompt stays
  byte-identical.
