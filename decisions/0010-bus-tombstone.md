# 0010 -- destroyBus(name): tombstone-in-place, no index reclaim

- Status: accepted
- Date: 2026-08-15
- Package: `@zakkster/lite-audio`
- Session: PS1 (v2.6.0)
- Related: 0001 (handle namespace -- the `busIndex * 2^32 + poolHandle` codec
  this must not disturb), 0006 (dynamic bus -- `createBus`, which this completes),
  SPATIAL_ROADMAP section 7 (post-suite backlog)

## Context

`createBus()` (0006) had no matching dispose: a dynamic bus lived until the whole
engine `destroy()`. A long-lived app that churns dynamic buses (SPA route
changes, scene swaps) retained every bus's graph, pool, and signals for the
process life. `destroyBus(name)` tears ONE dynamic bus down.

The design is dominated by ONE constraint: a voice handle decodes its owning bus
by ARRAY INDEX. `busRec.index` is assigned `_busList.length` at construction
(`Audio.js:818`), the bus is appended (`:893`), and every handle site --
`stop()` (`:1214`), `isPlaying()` (`:1227`), `setPosition()` (`:1260`), the
`_flushPositions` walk (`:2300-2303`) -- reads `_busList[(handle / 2^32) | 0]`.
Anything that changes the array positions changes what live handles resolve to.

## Decisions

### D1 -- TOMBSTONE in place, never splice `_busList`

`destroyBus` hollows the bus record into an inert husk and KEEPS its `_busList`
slot. It never splices the array (splicing shifts every later bus's index and
silently reassigns live handles to the wrong bus) and never nulls the array
element (a null element would throw in `_flushPositions`, which reads
`busRec.lanes` before the null-guarded scratch). The husk carries `pool: null`,
`posDirty: null`, `lanes: 0`, `vbap: null`, so every hot/monitor path already
fail-closes on it with NO new branch:

- `stop()`/`isPlaying()`/`play()` guard `!busRec.pool` -> no-op / `-1`.
- `setPosition()`/`_flushPositions()` guard `posDirty === null` -> no-op / skip.
- `_flushLanes()` walks only `_discreteBuses`, from which the husk is swap-popped.
- `_evalDuckRules()`/`applySnapshot()` resolve buses by name via
  `_buses.get()` -> `undefined` for a deleted bus -> each existing guard skips it.

Because the husk is inert by construction, `destroyBus` does exactly the per-bus
teardown that `destroy()` already does (`Audio.js:2683-2709`, `:2777-2782`) --
`pool.destroy()` then `pool = null`, null the positional/HRIR/width/discrete
state, disconnect the graph, dispose the per-bus signals and the one write
effect -- plus three swap-pops (`_effectHandles`, `_meteredBuses`,
`_discreteBuses`) and two Map deletes (`_buses`, `_soundsByBus`).

### D2 -- the tombstoned index is NEVER reused

`createBus` keeps appending (`:2109` guards `_busList.length >= MAX_BUSES`,
`:893` pushes -- it never fills holes). A reused index would let a stale handle
from the destroyed bus alias a NEW voice on a recreated bus at the same index --
a bus-level ABA hazard. Not reusing the index defeats it outright with no
generation stamp. The cost: tombstones count against the 2^21 bus ceiling, so an
app that creates + destroys more than ~2M buses in ONE session eventually hits
the `createBus` `RangeError`. Realistic churn (route changes, scenes) is orders
of magnitude below that. Index reclaim WITH a per-index bus-generation stamp is a
future session if the ceiling is ever a real limit; it is out of scope here.

### D3 -- return `boolean`; throw only on structural misuse

`destroyBus` returns `true` when a live dynamic bus was destroyed, `false` for an
unknown name, an already-destroyed bus, or a destroyed engine. `false` (not a
throw) on those keeps the method idempotent and safe inside a defensive teardown
loop -- a double-destroy or a typo does not crash a shutdown path. It THROWS on
two cases that are programmer errors about the engine's TOPOLOGY, not runtime
state: `'master'` (reserved, mirrors `createBus`'s master rejection) and a STATIC
bus (one from `opts.buses`). A static bus is declared engine topology that
sounds, tracks, and duck rules assume exists for the engine's life; tearing one
down is a structural mistake worth surfacing loudly. Only `createBus()` buses
(marked `dynamic: true`) may be destroyed.

### D4 -- discrete `channelCount` is NOT shrunk

`destination.channelCount` is process-global for the context and monotonic
add-only across live discrete buses, with the pristine triple saved once at the
first discrete pool build and restored ONLY at full `destroy()`
(`Audio.js:2716-2722`). `destroyBus` of a discrete bus leaves it untouched.
Shrinking it mid-session on a shared context is the explicitly-unsupported case
(a caller mixing an external graph on the same context would see the channel
count change under it). Leaving it high is harmless -- an over-wide destination
downmixes cleanly.

### D5 -- `destroyBus` does NOT stop the monitor

When `destroyBus` removes the last positional/metered consumer, it deregisters
but leaves the ~10 Hz monitor running (its flushes early-return on empty lists,
which is cheap). Sleeping the idle monitor is a real lifecycle-behavior change
that must count meters + duck + auto-suspend + positional consumers together --
that is the separate "monitor idle refcount / sleep-wake" backlog item. Doing
half of it here would double-implement it wrong.

## Proof

Torture tier **T-SP7** (`test/torture.mjs`): (a) the contract + node census --
4 live voices on a discrete bus go to 0 after `destroyBus` (census delta 0),
`_busList` length and every surviving index stay stable, the husk is pulled out
of the lane flush; (b) a 4096-cycle create/destroyBus soak across
{stereo, positional, hrtf, width, discrete} retains nothing (lite-leak witness:
0 un-released records, 0 incomplete teardowns) at `maxMajor: 0`,
`maxPauseMs <= 4`. Red control `LITEAUDIO_TORTURE_DESTROYBUS_RED=1` models a
`destroyBus` that skips the `_discreteBuses` swap-pop and leaves the pool live;
the tombstoned husk keeps sounding (census 4 vs baseline 0) and the gate exits
non-zero. Boundary suite `test/DestroyBus.test.js` pins the contract,
stale-handle inertness, `_busList` stability + append-only reindex, the discrete
`channelCount` invariant, and the duck-rule / snapshot inertness. Both
`HashParity` goldens are frozen; the hot bodies are byte-unchanged.
