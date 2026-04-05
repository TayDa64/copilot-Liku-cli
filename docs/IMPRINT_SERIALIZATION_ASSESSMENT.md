# Imprint serialization assessment for Liku

Status: proposed research memo  
Scope: future realtime data ingest, serialization, and action-loop efficiency  
Sources:

- `https://github.com/imprint-serde/imprint`
- `https://raw.githubusercontent.com/imprint-serde/imprint/main/README.md`
- `https://raw.githubusercontent.com/imprint-serde/imprint/main/FORMAT.md`
- `https://raw.githubusercontent.com/imprint-serde/imprint/main/Cargo.toml`
- current Liku repo architecture and runtime constraints

## 1. Executive recommendation

Short version:

- **Borrow Imprint’s ideas; do not adopt the archived crate directly.**
- **Do not let serialization work preempt inspect/proof/runtime reliability work.**
- **If Liku later needs a hot realtime data path, the best fit is likely a Liku-native row envelope inspired by Imprint, while keeping JSONL for human-facing traces and memory.**

Imprint is interesting because it optimizes exactly the kinds of operations that matter in streaming control loops:

- projecting a subset of fields
- merging heterogeneous records
- reading individual fields without deserializing an entire payload
- preserving deterministic bytes for hashing and dedupe

Those are real advantages.

But the repo is archived, Rust-only, pre-1.0, with no releases and no published packages. That makes direct adoption a poor fit for Liku’s current Node/Electron local-first architecture.

## 2. What Imprint actually is

Imprint is a binary row serialization format built for stream processing workloads, especially:

- incremental joins
- denormalization
- heterogeneous source merging
- row-level projection without full decode

From the repo docs, the core layout is:

- 15-byte header
- varint field count
- field directory sorted by field ID
- payload bytes

Each directory entry is 7 bytes:

- `u16 field id`
- `u8 type`
- `u32 offset`

Key design properties from the docs:

- field-addressable reads via directory lookup
- deterministic serialization via canonical field-ID sort
- composition/merge by directory math plus payload concatenation
- projection by slicing referenced payload bytes
- self-describing rows with enough metadata for schema-less reads

Repository maturity signals:

- archived by owner on **Jan 26, 2026**
- read-only
- crate version `0.1.0`
- no releases published
- no packages published

That means the format ideas are valuable, but operational adoption risk is real.

## 3. Why Imprint is relevant to Liku

Liku is not currently dominated by binary serialization cost. Right now the highest leverage is still perception/action reliability.

However, Imprint becomes relevant if Liku evolves toward a richer realtime ingest and action loop, for example:

- market data or indicator streams
- local fusion of quote/bar/signal/action context
- replayable decision traces
- faster projection of only the fields needed by a policy or tool
- combining multiple input fragments without expensive decode/re-encode cycles

That matters especially for a future architecture where Liku may ingest:

- price/quote events
- bar updates
- indicator snapshots
- strategy or ranking outputs
- automation targets and proofs
- UI observations tied to decisions

In that world, the data plane starts to matter more.

## 4. The specific efficiencies Imprint is chasing

## 4.1 Field-addressable reads

Imprint allows lookup of a field through a sorted field directory instead of scanning an entire tag stream or decoding a whole object.

Why this helps:

- a consumer that only needs `symbol`, `timestamp`, and `signalScore` does not need to deserialize everything else
- partial evaluation becomes cheaper
- hot-path policy checks can operate on fewer bytes and fewer allocations

## 4.2 Projection without full deserialization

The docs describe projection as copying or referencing just the payload slices for selected fields after parsing the directory.

Why this helps:

- downstream components can receive a smaller record without paying full decode cost
- one process can trim records for a narrower consumer cheaply
- high-frequency pipelines avoid repeated object materialization

## 4.3 Merge/composition without decode + re-encode

Imprint’s merge story is the most distinctive part of the design.

The docs describe combining rows by:

- concatenating payloads
- sort-merging directories
- offset-adjusting trailing fields

Why this helps:

- composing `market event + indicator result + policy hint + action context` becomes cheaper
- a pipeline can enrich records in stages without fully rebuilding them every time
- denormalization-style local joins get cheaper

## 4.4 Deterministic bytes

Because fields are sorted by field ID, identical logical rows serialize identically.

Why this helps:

- dedupe is simpler
- hashing/caching is cheaper
- proof or replay artifacts can key on deterministic blobs
- change detection can avoid expensive semantic comparisons

## 4.5 Self-describing rows

The format includes enough metadata for schema-less or schema-light inspection.

Why this helps:

- debugging is easier than many tightly schema-bound binary formats
- local tools can inspect rows without needing the full original codegen stack

## 5. Where those efficiencies do and do not map to Liku

## 5.1 Good fit areas

### Realtime market/event ingestion

If Liku later consumes fast local data streams, these Imprint-like properties map well:

- project only fields needed by a specific strategy
- merge price, indicator, and decision context efficiently
- keep deterministic byte identity for replay and dedupe

### Decision context fusion

A future decision loop might want to combine:

- latest market event
- current strategy state
- UI/automation state
- proof state from previous actions

This is much closer to Imprint’s target problem than classic request/response RPC.

### Proof and replay assets for hot paths

If action proofs later become high-volume artifacts, deterministic binary rows may help keep hot-path replay compact while still exporting debug-friendly text summaries.

## 5.2 Poor fit areas

### Current human-facing traces and memory

Liku’s current traces, memory, and many diagnostics are valuable precisely because they are readable.

For these, JSONL remains the right default.

### Current main bottleneck

Today the biggest real gap is still:

- inspect grounding
- proof fidelity
- deterministic execution semantics

Not binary row performance.

### General Node/Electron ergonomics

The current runtime is JavaScript-first and local-first. A Rust row format can be used, but it is not a plug-and-play fit.

## 6. Why direct adoption is not recommended

## 6.1 The repo is archived

This is the biggest practical concern.

An archived serialization format can still inspire design, but it is a weak dependency for a critical future data path.

## 6.2 Rust-only ecosystem fit

Imprint is a Rust crate. Liku’s current runtime is Node/Electron.

Direct adoption would likely require one of:

- Rust sidecar process
- native addon / FFI boundary
- maintaining a full JavaScript reimplementation

All three raise complexity significantly.

## 6.3 Pre-1.0 maturity

The crate is `0.1.0`, with no releases and no packages published.

That is not a good signal for direct dependency on a future critical path.

## 6.4 Field-ID governance cost

Imprint-style formats need disciplined field registries and schema evolution rules.

That cost is worth paying only when the performance benefits are real and measured.

## 7. What to borrow conceptually even if we do not adopt it

These are the core ideas worth carrying forward.

## 7.1 Canonical field IDs

Assign stable numeric IDs to frequently used hot-path fields.

Examples for a future market/event envelope:

- event timestamp
- source
- symbol
- timeframe
- bid/ask/last
- OHLCV
- indicator snapshot
- action intent
- action proof level
- session ID

This creates deterministic ordering and efficient lookup.

## 7.2 Split envelope into header, directory, payload

A Liku-native hot-path envelope can copy the same basic pattern:

- small fixed header
- sorted directory of fields
- raw payload body

This is the core idea that enables fast projection and merge.

## 7.3 Projection API over byte slices

The key optimization is not just “binary instead of JSON.”

It is:

- parse a small index
- slice only the fields needed
- avoid materializing whole objects in the hot path

That is the real efficiency to preserve.

## 7.4 Deterministic merge semantics

Define explicit rules such as:

- field precedence on conflict
- source-of-truth ordering
- how merged payload offsets are adjusted

This is critical for combining market, policy, and action context.

## 7.5 Dual-format philosophy

Keep both:

- compact hot-path representation for runtime
- human-readable export path for debugging

That is a much better fit for Liku than “make everything binary.”

## 8. Practical options for Liku

## 8.1 Option A — stay JSON/JSONL only

Best when:

- throughput is modest
- readability matters most
- the hot loop is not actually serialization-bound

Pros:

- simplest
- zero migration cost
- easy debugging

Cons:

- expensive projection and merge
- repeated parsing/object allocation
- weak deterministic byte identity

Verdict:

- Keep this for memory, user-facing traces, and debug artifacts.
- Not ideal for a future high-rate ingest path.

## 8.2 Option B — use MessagePack or CBOR for incremental gains

Best when:

- the team wants an easy binary step-up without a large custom format effort

Pros:

- simple migration path from JSON mental model
- smaller payloads than JSON
- broad ecosystem support

Cons:

- still not optimized for field projection/merge like Imprint
- does not solve the most distinctive hot-path benefits

Verdict:

- good transitional option
- not the closest substitute for Imprint’s actual advantages

## 8.3 Option C — use Protobuf

Best when:

- wire interoperability matters more than local row manipulation

Pros:

- mature ecosystem
- compact and common
- strong schema tooling

Cons:

- field access still implies tag-stream scanning behavior
- merge/projection benefits are weaker for Liku’s potential local denormalization loop
- often pushes decode/re-encode workflows

Verdict:

- good if Liku later becomes service-heavy or remote-first
- not the best fit for local field-addressable row composition

## 8.4 Option D — use FlatBuffers or Cap’n Proto

Best when:

- schemas are stable
- read-heavy zero-copy access matters

Pros:

- very fast reads
- low allocation pressure

Cons:

- less natural for incremental merge/composition workflows
- schema evolution and ergonomics can be less pleasant for mixed local tooling

Verdict:

- strong if the primary need is read-mostly structured data
- weaker if the primary need is frequent row enrichment and projection

## 8.5 Option E — use Arrow IPC / Parquet for analytics, not the hot control loop

Best when:

- offline analysis, batch replay, or analytics matter

Pros:

- strong columnar analytics story
- efficient vectorized workloads
- good for exports and batch comparison

Cons:

- poor fit for small row-by-row control-loop mutation
- too heavy for the narrow realtime local action loop Imprint is targeting

Verdict:

- excellent export/analytics format
- not the primary answer for Liku’s future hot runtime loop

## 8.6 Option F — build a Liku-native row envelope inspired by Imprint

Best when:

- Liku actually needs hot-path local projection/merge performance
- the team wants the benefits without depending on an archived crate

Pros:

- tailored to Liku’s exact event types
- can preserve deterministic bytes, field addressing, and fast projection
- no dependency on archived upstream
- can be implemented first in Node using `Buffer`

Cons:

- custom format maintenance burden
- requires schema registry discipline
- must be benchmarked and documented carefully

Verdict:

- the best conceptual fit if Liku truly needs Imprint-like behavior later

## 8.7 Option G — Rust sidecar implementing Imprint-like ideas

Best when:

- performance becomes important enough to justify an extra runtime boundary

Pros:

- strongest path to high-performance local data plane
- keeps Node/Electron UI runtime simpler
- allows more serious benchmarking and future evolution

Cons:

- IPC and deployment complexity
- cross-language build/test burden
- bigger operational surface area

Verdict:

- a second-stage optimization, not the first move

## 9. Recommended path for Liku

## 9.1 Near-term recommendation

Do **not** adopt Imprint directly.

Do **not** start by replacing JSONL traces or current memory storage.

Instead:

1. finish inspect/proof/runtime grounding first
2. define the future hot-path data model separately
3. prototype only if benchmarks justify it

## 9.2 Medium-term recommendation

If realtime ingest becomes important, implement a small experimental format under a neutral internal abstraction.

Suggested abstraction:

- `encodeEvent(record)`
- `decodeField(buffer, fieldId)`
- `projectFields(buffer, fieldIds)`
- `mergeEvents(bufferA, bufferB, options)`
- `toDebugJson(buffer)`

That lets Liku compare:

- JSON
- CBOR/MessagePack
- Protobuf/FlatBuffers
- Liku-native row envelope

without hardwiring the entire system to the first experiment.

## 9.3 Long-term recommendation

If the hot-path benchmark results are compelling:

- keep JSONL for human-facing artifacts
- use a row envelope only for the realtime ingest/decision bus
- optionally export hot-path artifacts to Arrow/Parquet for offline analysis

That hybrid strategy fits Liku much better than one universal format.

## 10. A concrete Liku-native design direction

If Liku decides to pursue the Imprint-inspired path, the first version should stay intentionally narrow.

## 10.1 Suggested use scope

Use it only for high-rate local event types such as:

- `market.quote`
- `market.bar`
- `indicator.snapshot`
- `strategy.signal`
- `automation.proof-summary`
- `decision.context`

Do **not** use it first for:

- memory store
- user prompt history
- freeform traces
- markdown/report generation

## 10.2 Suggested envelope shape

A first Liku envelope could look like:

- magic/version
- flags
- schema ID
- event timestamp
- field count
- directory entries sorted by field ID
- payload bytes

This deliberately mirrors the important part of Imprint’s design without tying Liku to the archived implementation.

## 10.3 Suggested design constraints

- deterministic field ordering
- stable numeric field IDs
- explicit merge precedence rules
- cheap field projection
- always-available debug JSON export
- benchmark before rollout

## 11. Benchmark plan before any adoption decision

Before choosing a format, benchmark the operations Liku actually cares about.

Minimum benchmark set:

### Encode/decode

- small event encode latency
- partial field decode latency
- allocation count if measurable

### Projection

- extract 3 fields from a 20-field event
- extract 6 fields from a 40-field event

### Merge/composition

- merge `quote + indicator`
- merge `bar + decision.context + proof.summary`

### Replay and storage

- sustained write throughput
- storage size on disk
- debug export cost

### Control-loop relevance

- p50/p95/p99 latency for event fusion in a synthetic local decision loop

If the gains are not meaningful in those benchmarks, the extra complexity is not justified.

## 12. Final recommendation

Imprint is worth studying because it highlights the right class of optimization for a future local realtime data plane:

- field-addressable rows
- cheap projection
- cheap composition
- deterministic bytes

But Liku should treat Imprint as a design reference, not an implementation dependency.

The most practical path is:

1. keep JSONL where readability matters
2. finish inspect/proof/runtime correctness first
3. if a realtime ingest loop emerges, prototype a small Liku-native row envelope inspired by Imprint
4. benchmark it against simpler alternatives before committing

That captures most of the upside with far less long-term risk than adopting an archived Rust crate directly.
