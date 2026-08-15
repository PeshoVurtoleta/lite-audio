# 0014 -- reloadTrack(name)

- Status: accepted
- Date: 2026-08-15
- Package: `@zakkster/lite-audio`
- Session: PS5 (v2.10.0)
- Related: 0013 (removeDuckRule -- the symmetric teardown-counterpart house
  style this follows), the one-MediaElementSource-per-element constraint
  documented at `Audio.js` `_wireTrackGraph` (why a fresh element is mandatory),
  the `defineTracks` per-track load + `_loadTrack` (the async loader this
  re-enters), the `destroy()` per-track teardown block (the template this
  mirrors, minus signal dispose), SPATIAL_ROADMAP section 7 (post-suite backlog)

## Context

`defineTracks(config)` registers a track once and drives its `_loadTrack`
through `idle -> loading -> ready`/`error`. It is a no-op for an already-defined
name (`if (this._tracks.has(name)) continue;`), so once a track's load settles to
`'error'` -- a bad src, or a spent `<audio>` element after a `createMediaElement
Source` wire failure -- there is no built-in path back. The track's `loadState`
signal is stuck at `'error'` for the life of the engine, and a subscribed HUD has
no recovery affordance short of a full `destroy()` + re-`init()` + re-`defineTracks`
(which also disposes and recreates every signal, breaking every live binding).

`reloadTrack(name) -> boolean` is the scoped recovery: it tears ONE track's graph
+ `<audio>` element down destroy()-style and re-enters `_loadTrack` with a FRESH
element, driving `loadState` back through `loading -> ready`/`error`. It is the
symmetric per-track recovery counterpart to `defineTracks`' per-track load, a
cold call off every hot path. `play`/`stop`/`setPosition`/`_evalDuckRules`/
`_monitorIdle` are byte-unchanged and both `HashParity` goldens stay frozen.

## Decisions

### D1 -- sync `boolean` return, not a `Promise`

`reloadTrack` returns a `boolean` synchronously and fires `_loadTrack` WITHOUT
awaiting it. The track's `loadState` signal -- already watched by the caller via
`trackLoadState(name)` -- IS the async recovery channel; the reload settles on
that signal exactly as the original `defineTracks` load did. A second awaitable
(a returned `Promise`) would duplicate that channel and invite a caller to await
the wrong one. The `boolean` reports only the SYNC decision: `true` iff a
teardown + reload was fired, `false` for every refused no-op. A caller who needs
to observe `ready` subscribes to the signal; the returned graph is deliberately
not settled on return (R2).

### D2 -- reload only from `{error, idle}` and not playing; refuse the rest

Reload fires ONLY when `loadState` is `'error'` or `'idle'` AND the track is not
playing. Every other state returns `false` without touching the rec:

| state | action |
|---|---|
| `'loading'` | refuse -- races the in-flight `_loadTrack`; also refuses a reentrant second `reloadTrack` (no double element build) |
| `playing.peek() === true` | refuse -- live graph mid-playback; tearing a playing element mid-fade is a footgun |
| `'ready'` (not playing) | refuse -- nothing to recover; reload is not restart |
| `'error'` / `'idle'`, not playing | teardown + reload; return `true` |

Reload exists to RECOVER an errored track, not to restart a healthy one --
`playTrack({restart:true})` owns restart. A caller who wants to rebuild a `ready`
track calls `stopTrack` then `reloadTrack`, which then sees a non-playing but
still-`ready` track and refuses: the ONLY reload entry is from `error`/`idle`.
This keeps the method single-purpose and fail-closed. A future force-rebuild of a
ready track is its own decision, not smuggled in here.

### D3 -- signals REUSED, never disposed (the destroy() divergence)

The four external signals (`loadState`/`playing`/`position`/`duration`) are the
track's STABLE external identity: a HUD binds to them via `trackLoadState(name)`
etc. reloadTrack mutates them with `.set()` only -- `playing(false)`,
`position(0)`, `duration(0)`; `loadState` is reset by the re-entered `_loadTrack`
(`'loading'` -> `'ready'`/`'error'`). It NEVER `dispose()`s them. This is the
deliberate divergence from `destroy()`, which DOES dispose all four (they are
pool-backed nodes, and destroy() is tearing the whole engine down). Disposing +
recreating a signal here would silently break every live subscription across the
reload -- the exact failure A1 (signal-identity `===` across 100 reloads) pins.

### D4 -- a fresh element is mandatory, not optional

A given `<audio>` element can back exactly ONE `MediaElementAudioSourceNode` for
its lifetime; a second `createMediaElementSource` on the same element throws
`InvalidStateError` (documented at `_wireTrackGraph`). A wire-failure that dumped
the track to `'error'` has spent that element FOREVER -- reusing it would throw
again on the next play. The only recovery is a new element, so reloadTrack drops
the old one and lets `_loadTrack` build a fresh one via `_createAudioElement`.
This is why reload cannot be a mere `loadState.set('idle')` retry: the element,
not just the state, is what is spent.

### D5 -- teardown fully releases the old element BEFORE the new one is built

The teardown mirrors `destroy()`'s per-track block, in order, all guarded (the
element/nodes may be null or foreign after a failure): cancel `pauseTimer` via
`_clearTimeout`; remove the `timeupdate`/`ended` handlers (try/catch each);
`element.pause()`; `element.removeAttribute('src')` + `element.load()` to drop the
stream so a spent element stops buffering and is GC-eligible; then
`source?.disconnect()` / `xfadeGain?.disconnect()` / `volumeGain?.disconnect()`.
Only AFTER the old element is fully released does `_loadTrack(rec)` build the new
one, so no two elements/sources ever coexist for the track. Combined with the D2
`loading` guard, a reentrant reload is refused, so the ordering is safe against a
double build.

### D6 -- touches ONLY the one rec; identity preserved; off every hot path

The rec stays in `_tracks` + `_trackList` with the SAME object identity -- no
map/list mutation, no re-registration. No other track, no bus, the monitor, and
the duck rules are untouched. reloadTrack is a cold method placed immediately
after `defineTracks` in the cold track region; it adds zero bytes, args, or
branches to any hot body (`play`/`stop`/`setPosition`/`_evalDuckRules`/
`_monitorIdle`), which never call it (A6, grep proof). Because it is off every
hot path it MAY allocate incidentally (it does not), and needs no golden
re-baseline.

### D7 -- null every rebuildable field (retention)

After the node teardown, reloadTrack nulls every rebuildable rec field --
`element`, `source`, `xfadeGain`, `volumeGain`, `timeupdateHandler`,
`endedHandler`, `resolvedSrc` -- and resets `lastPositionWrite = -Infinity`,
`pauseTimer = null`, so a reload-churn loop retains no spent element or graph
node. The config fields (`name`, `srcs`, `busName`, `volume`, `loop`, `loopStart`,
`loopEnd`) are preserved so `_loadTrack` re-uses the original definition. A build
that skipped the null-out would let the rec pin a spent `<audio>` element and its
disconnected gains past their release, and the T-TRK1 lite-leak witness would
catch it (A2: census delta 0 across the churn).

## Proof

- **Correctness / fail-closed (boundary suite).** `test/ReloadTrack.test.js` --
  a node:test boundary suite (25 `it()` cases, 7 `describe()` groups). It pins
  the D2 decision table (destroyed / uninitialized throw with the
  `defineTracks`-parity messages; unknown / empty / `null` / `undefined` /
  `NaN` / `-0` / non-string (number, plain object, array, boolean, boxed
  `String`) name and a `loading` / `playing` / `ready` track return `false`
  without touching the rec), the D1 sync-`boolean` contract, D3 signal identity
  (`===` across reloads -- A1, both a dedicated case and a 1/N-1/N/N+1 sweep),
  D4/D5 fresh-element recovery of a spent element (the `test/Tracks.test.js`
  wire-failure mock pattern, reused verbatim -- A4, the crux case), D7 config
  reuse (src/bus/volume/loop/loopStart/loopEnd), a 5-cycle retention smoke
  (A2 spot check), the `destroyBus` interaction (D6 -- reload never throws;
  the next `playTrack` fails closed), end-to-end `playTrack` after a
  successful reload, and two adversarial boundary cases: `destroy()` mid-loop
  over a reload batch (dispose-during-iteration + duplicate dispose), and a
  synchronous re-entrant `reloadTrack` call fired from an `effect()` observing
  the `loading` transition (refused by the same `loading` guard that blocks a
  racing in-flight load). Gate run: `node --expose-gc --test test/*.test.js`
  -> **441 tests, 441 pass, 0 fail, 0 skipped** (baseline before this file was
  416/416; this file adds exactly the 25 new cases, no other file changed).
- **Retention / zero-alloc (torture).** `test/torture.mjs` NEW tier **T-TRK1**
  builds the first track fixture the torture rig has ever exercised (0 hits
  before this session): a `sourceTrackingCtx`-style wrapper whose
  `createMediaElementSource` throws `InvalidStateError` on a re-used element
  (mirrors `test/Tracks.test.js`'s wire-failure mock), and a
  `trkPoisonedThenFreshDocument` that hands back one pre-spent element then
  mints fresh ones via `mock-ctx.js`'s existing `mockAudioElement` (which
  already records `srcReleased`/`loadCalls`/listener counts -- the release
  witness). Three phases, all green on the run that produced these numbers:
  (a) **A4** -- a track wire-failed to `'error'` by a real throwing
  `createMediaElementSource` reaches `'ready'` after `reloadTrack` behind a
  FRESH element (`doc.created` 1 -> 2), signal identity held, and the fresh
  element plays end-to-end. (b) **A2/A1** -- a **10,000**-cycle
  force-error/`reloadTrack` soak on a `createLeakTracker` witness: **0**
  un-released elements, **0** incomplete releases, **0** signal-identity
  breaks across every cycle (not a spot check), `doc.created` = 10,001
  (1 initial + 1/cycle, exactly one fresh element per cycle), exactly 1 live
  element left at the end. (c) a 2,000-cycle GC-budget window over the same
  churn: `major=0 minor=0 maxMs=0.00` (`maxMajor:0`/`maxPauseMs<=4` held;
  `bytesPerOp` is reported, not gated -- a fresh element+graph per cycle is
  allocation by design, D4). **RED control**
  (`LITEAUDIO_TORTURE_TRK1_RED=1`) swaps in a `reloadTrack` that keeps the
  same D1/D2 preconditions but skips the element release + graph disconnect +
  null-out (steps 2-4 of the teardown contract): measured result, the same
  10,000-cycle soak witnesses **10,000/10,000 un-released elements**, the gate
  prints `torture: FAIL -- LITEAUDIO_TORTURE_TRK1_RED: ...` and **exits 1**;
  the normal path in the same run (no env var) exits **0**. Full gate run:
  `node --expose-gc test/torture.mjs` -> exit **0**, every tier (including
  T-TRK1) reports `major=0`, and none of the pre-existing tiers' numbers moved
  (T-SP1..T-SP8 figures identical to the pre-PS5 baseline run).
- **Goldens frozen / no hot-path drift (A5/A6).** Both `HashParity` goldens are
  byte-identical to 2.9.0; the diff is confined to `Audio.js:10` (VERSION) + the
  new `reloadTrack` method in the cold track region + `Audio.d.ts` + `llms.txt` +
  `CHANGELOG.md` + this decision + `package.json`. The hot bodies
  (`play`/`stop`/`setPosition`/`_evalDuckRules`/`_monitorIdle`) are byte-unchanged
  and never call `reloadTrack` (grep proof). PS5 adds no hot-path arg or branch,
  so no re-baseline.
