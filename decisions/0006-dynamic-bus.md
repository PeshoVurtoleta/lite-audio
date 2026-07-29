# 0006 — Dynamic createBus(): runtime bus creation with a runtime ceiling check

- Status: accepted
- Date: 2026-07-29
- Package: `@zakkster/lite-audio`
- Session: AU1 (v1.2.0)
- Related: 0001 (handle namespace / 2^21 ceiling), AU1 meters

## Context

AU1's meters are opt-in per bus. The API shape for marking a bus metered was the
open question. Two candidates:

- a constructor option (extend `opts.buses` to accept objects, or add a parallel
  `meterBuses` list) — static, bus set fixed at `init()`;
- a `createBus(name, { meter: true })` method — dynamic, buses can appear after
  `init()`.

`createBus()` was chosen. It is the more general primitive (metering is one flag
on it), and it matches how a game actually grows a mix — a bus per new subsystem —
rather than forcing the whole bus set to be declared up front. The cost is a
larger surface with one real hazard, handled below.

## Decision

`createBus(name, opts)` builds a bus after `init()` via the same `_buildBus` helper
the static buses use: a gain -> sidechain -> master chain, a volume/mute effect,
and (with `{ meter: true }`) a tapped `AnalyserNode`. It is idempotent (an existing
name returns its record), rejects the reserved name `master`, and a bus created
this way gets its pool the first time a sound is routed to it via `defineSounds()`.

### The runtime ceiling check is the reason this needs care

A voice handle is `busIndex * 2^32 + poolHandle`, exact only while
`busIndex <= 2^21 - 1` (0001). `init()` already fails closed above `MAX_BUSES`
static buses. But a **dynamically** created bus is exactly the path that can walk
off the ceiling *after* init — one `createBus()` in a loop, or a long-running app
that spins up a bus per entity. So the same fail-closed check is repeated in
`createBus()`: at `_busList.length >= MAX_BUSES` it throws a `RangeError` rather
than issue a bus whose handles would silently collide with bus 0's.

This is the whole justification for the extra surface being acceptable: the ceiling
that was a cold, once-at-init guard in v1.1.1 is now reachable at runtime, and it is
guarded at runtime. An unrepresentable bus is a wiring error, caught at the call
that creates it, not a stop() reaching the wrong voice later.

### Meter tap point and allocation

`{ meter: true }` taps the `AnalyserNode` off `duckGain` — post volume, mute *and*
duck — so `level()` reads what actually reaches master. The analyser is a pure
observer (not connected onward). Its read buffer is a `Float32Array` allocated once
at attach, never per read; the ~10 Hz RMS sweep runs on the shared monitor and is
proven zero-alloc by the torture gate. An unmetered bus allocates no `AnalyserNode`
at all, and `level()` returns null for it.

## Rejected alternatives

- **Constructor option only.** Simpler and keeps the bus set static (indices fixed
  at init, no runtime ceiling path), but it cannot express a bus that appears with
  a new subsystem, and it makes metering a special case of bus declaration rather
  than a flag on a general primitive. The dynamic path's one hazard (the runtime
  ceiling) is cheaply closed, so the generality is worth it.

## For a future reviewer

`createBus()` appends to `_busList`, so a bus's index is its creation order and is
stable for the engine's life — handles stay decodable. Do not add bus *removal*
without confronting index reuse: a freed index handed to a new bus would make a
stale handle from the old bus decode to the new one, defeating the ABA guard. If
removal is ever needed, retire the index (leave a hole) rather than reuse it — the
same wrap-vs-retire reasoning as 0002.
