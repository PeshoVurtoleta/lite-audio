# Changelog

## 2.9.0

Added `removeDuckRule(triggerBus, targetBus)` (post-suite backlog PS4): the
duck-rule removal API the v2.7.0/PS2 note flagged as separate backlog. It removes
ALL `_duckRules` entries matching the `(trigger, target)` pair (opts are not part
of the key) and returns `true` iff at least one rule was removed, else `false`
(idempotent, fail-closed on a destroyed engine / unknown pair / null / undefined
/ non-string args -- never throws). This COMPLETES the PS2 idle-sleep story: duck
rules were the one permanent monitor consumer, so a `duckOn`-only engine could
never sleep; removing the last rule now lets the shared monitor idle-sleep on its
next `_monitorIdle()` tick (removeDuckRule never pokes `_monitorTimer` /
`_startMonitor` itself). Stranded-target recovery is fail-closed: a removed active
rule's target is released back to rest only when the bus exists, is not under a
manual duck, and is not still held by a surviving active rule -- else it would
strand the bus silent. Zero-alloc, order-preserving in-place compaction (no
splice/filter). NO hot-path or behavior change to `play()`, `stop()`,
`setPosition()`, `_evalDuckRules()`, or `_monitorIdle()`; both `HashParity`
goldens frozen. See `decisions/0013-remove-duck-rule.md`.

### Added

- `removeDuckRule(triggerBus, targetBus) -> boolean` -- remove every automatic
  duck follower for the `(trigger, target)` pair, with fail-closed
  stranded-target recovery to rest and PS2 idle-sleep for `duckOn`-only engines.
  Cold, zero-alloc; off every hot path.

## 2.8.0

Added `getHandleInfo(handle)` debug decoder (post-suite backlog PS3). A pure
structural decode of a voice handle's opaque `[bus:21][gen:24][ch:8]` packing to
a plain `{ busName, generation, channel }` object, or `null` on any sentinel,
non-integer, negative, or unknown/destroyed-bus handle. It reuses the existing
`busOf` decode for the bus-name half and reports what the bits say, not whether
the voice is still live (that is `isPlaying(handle)`). NO hot-path or behavior
change to `play()`, `stop()`, `setPosition()`, or the monitor tick; both
`HashParity` goldens (`play()`, `stop()`) are frozen. See
`decisions/0012-get-handle-info.md`.

### Added

- `getHandleInfo(handle) -> { busName, generation, channel } | null` -- an
  off-the-hot-path debug/query decoder for the "wrong voice stopped" case. Fails
  closed to `null` and allocates one fresh result object per call (no hot body
  gains any allocation, arg, or branch).

## 2.7.0

Monitor idle refcount / sleep-wake (post-suite backlog PS2). The shared ~10 Hz
monitor now SLEEPS -- it stops rescheduling itself -- when no consumer is live,
and WAKES on the next registration. NO hot-path or behavior change to `play()`,
`stop()`, `setPosition()`, or the tick's flush order; both `HashParity` goldens
(`play()`, `stop()`) are frozen.

### Changed

- The monitor tick reads a new cold, allocation-free `_monitorIdle()` predicate at
  its tail and skips the reschedule when idle. "Idle" means: `_meteredBuses`,
  `_discreteBuses`, and `_duckRules` are empty; auto-suspend is not counting down
  (`!(_autoSuspend && !_selfSuspended)`); and one indexed scan of `_busList` finds
  no live positional (`pool !== null && posDirty !== null`), width (`wideIn !==
  null`), or pending-HRIR-prewarm (`hrtfWarmHandle !== null`) bus. Each `_busList`
  clause is the literal negation of its walker's own skip line, so the predicate
  and the walker can never disagree; `busRec.positional` is deliberately NOT read
  because `destroyBus` never clears it (a tombstone husk would pin the monitor
  awake forever). Fail closed toward AWAKE: any unverified state keeps ticking.
  The sleep needs no unwind -- the tick already nulled `_monitorTimer` at its head,
  so a slept monitor is simply `_monitorTimer === null` with no pending id, and
  `destroy()` / `_startMonitor` both guard on that field (no double-free, no
  double-arm). Every registration site re-arms via the existing
  `if (this._monitorTimer != null) return;` guard.

### Internal wake fixes

- Pool build now calls `_startMonitor()` after allocating the positional/discrete
  scratch. The `createBus`-time arm fires before that scratch exists, so a
  positional/discrete bus created before `defineSounds` would otherwise sleep and
  never flush its positions.
- `_wakeFromAutoSuspend` now calls `_startMonitor()` immediately after clearing
  `_selfSuspended` and BEFORE the context/`resume` guard, so a context lacking
  `resume` still re-arms the monitor (fail-closed ordering; silence tracking cannot
  be left permanently dead).

See decisions/0011. Both `HashParity` goldens frozen; the hot bodies are
byte-unchanged.

## 2.6.0

Dynamic-bus teardown (post-suite backlog PS1). Adds one public cold-path method,
`destroyBus(name)`, so a `createBus()` bus can be torn down individually instead
of only at full `destroy()`. NO hot-path or behavior change to `play()`,
`setPosition()`, `stop()`, `_flushLanes()`, `_flushPositions()`, or the ~10 Hz
monitor tick; both `HashParity` goldens (`play()`, `stop()`) are frozen.

### NEW

- `destroyBus(name) -> boolean`: hollows one dynamic bus in place -- stops its
  voices, destroys its pool, disconnects its graph, disposes its per-bus signals
  (volume, mute, metered level) and write effect, and deregisters it from the
  monitor's metered/discrete lists. Returns `true` when a live dynamic bus was
  destroyed, `false` for an unknown name, an already-destroyed bus, or a
  destroyed engine (idempotent). Throws on `'master'` (reserved) or a STATIC bus
  from `opts.buses` (structural topology, not a per-scene resource).

### TOMBSTONE, NOT SPLICE (decision 0010)

- A voice handle decodes its owning bus by array index
  (`_busList[(handle / 2^32) | 0]`), so `destroyBus` CANNOT splice `_busList`
  without shifting every later bus's index and reassigning live handles to the
  wrong bus. It instead hollows the bus record into an inert husk and KEEPS the
  `_busList` slot (never spliced, never reused). Every hot/monitor path already
  fail-closes on a husk (`stop`/`isPlaying`/`play` on `!busRec.pool`,
  `setPosition`/`_flushPositions` on `posDirty === null`, `_flushLanes` walks
  only the deregistered discrete list), so the hot path gains ZERO new branches.
- Tombstones count against the 2^21 bus ceiling; an app churning > ~2M buses in
  one session hits the `createBus` `RangeError`. Index reclaim (with a
  bus-generation stamp) is a future session.
- `destroyBus` of a discrete bus does NOT shrink `destination.channelCount` (it
  is process-global and monotonic add-only, restored only at full `destroy()`),
  and does NOT stop the shared monitor when it removes the last consumer
  (idle-monitor sleep is a separate backlog item). `_duckRules` and `_snapshots`
  that name a destroyed bus are left untouched -- both already fail closed by
  name resolution.

## 2.5.1

Consolidation release closing the spatial suite (session S8). One line of new
runtime behavior -- a construct-time fail-closed guard on `poolCapacity` -- plus
three doc-only JSDoc clarifications and a docs/version pass. NO hot-path or
behavior change to `play()`, `setPosition()`, `stop()`, `_flushLanes()`, or the
~10 Hz monitor tick; both `HashParity` goldens (`play()`, `stop()`) are frozen.

### FAIL-CLOSED HARDENING

- `new LiteAudio({ poolCapacity })` now throws a `RangeError` at construction on
  a non-integer, `< 1`, or `> 256` capacity. A pool channel packs into the low 8
  bits of a handle (`poolHandle & 0xFF`, decision 0001), so a capacity past 256
  would wrap channel 256 onto channel 0 and silently overwrite channel 0's
  scratch. A caller previously passing `> 256` was ALREADY corrupting channel 0
  via that wrap; the throw surfaces a latent bug rather than flipping otherwise
  correct behavior. `Number.isInteger` rejects `NaN` and non-integers before the
  range test (null is not zero). New `const MAX_POOL_CAPACITY = 256`.

### Docs

- `setPosition()` JSDoc: documents that it works on discrete-surround buses too,
  not only `spatial: 'positional'` voices -- they share the positional scratch.
- `applySnapshot()` JSDoc: documents that applying a snapshot clears the manual
  duck latch and resets the sidechain to rest, and that an active `duckOn` rule
  re-asserts only on the next trigger EDGE (not the next tick) -- the duck
  evaluator is edge-gated, so a trigger still above threshold will not
  immediately re-duck a bus the snapshot just un-ducked.
- `play()` JSDoc: documents that a `play()` racing a `defineSounds()` pool
  rebuild sees `pool === null` and returns `-1` (fail closed -- a brief
  dropped-play window for concurrent loaders).
- README brought onto the LiteSepforge blueprint spine for spatial; all
  pre-existing non-ASCII glyphs across source and docs transliterated to ASCII
  (`->`, `<=`, `x`, "degrees"; only U+00D7 and U+00B5 remain).
- `Audio.d.ts`: `poolCapacity` documents the 1..256 range and the construct-time
  throw.

New `test/Capacity.test.js` (8 cases) pins the guard: 256 / 1 / default
construct; 257 / 0 / -1 / 1.5 / NaN throw a `RangeError` naming 256.

## 2.5.0

The 5+1 (6-channel) and 3+1 (4-channel) reductions of the S6 discrete-surround
bus, plus a cold fallback LADDER so any discrete request builds the largest
layout the sink actually fits and reports it. Session S7 of the spatial roadmap.
This GENERALIZES the S6 8-lane machinery; it does not rewrite it.

`layoutOf()` widens from the binary `'7.1' | 'stereo'` to the richest single
layout the sink supports: `>= 8 -> '7.1'`, `6` or `7 -> '5.1'`, `4` or
`5 -> '3.1'`, else `'stereo'`, still resolved once at `init()` and cached.
`createBus(name, { spatial: 'discrete', preset: '5.1' | '3.1' })` stops rejecting
and builds its pool in the pool's matching `channels: 6 | 4` mode. The per-bus
effective layout is `min(requested, sink-supported)` stepped down the ladder
`7.1 -> 5.1 -> 3.1 -> stereo`; a request never UPGRADES.

Additive and default-off: no non-discrete bus record, `play()`, `stop()`, or
`setPosition()` byte moves, and the hot path gains ZERO new branches. The S6 VBAP
solver is generalized to a cold, data-driven walk of a per-preset frozen ring
record captured at bus construction, so `_flushLanes()` gains no per-tick preset
test. The `HashParity` `stop()` and `play()` goldens do not move.

`destination.channelCount` is set to the MAX lane count across live discrete
buses; the pristine pre-discrete triple is saved once, on the first discrete
build, and restored verbatim on `destroy()`.

### BEHAVIOR CHANGE

- `layoutOf()` on a real 4- or 6-channel sink now returns `'3.1'` / `'5.1'`
  where S6 (which recognized only `>= 8`) returned `'stereo'`. The two S6 tokens
  keep their meaning: a caller testing `=== '7.1'` still gets it only on a
  `>= 8` sink; the change is visible only to a `=== 'stereo'` caller on a real
  4/6-channel sink. On a 2-channel sink (including a virtual-surround headset
  reporting `maxChannelCount 2`) the reading is unchanged -- still `'stereo'`.

### Added

- `createBus(name, { spatial: 'discrete', preset: '5.1' })` and `preset: '3.1'`
  -- the 6-lane (`L R C LFE SL SR`) and 4-lane (`L R C LFE`, front-only)
  reductions of the 7+1 bus. Each builds the largest preset the sink fits via the
  fallback ladder; `effectiveLayoutOf()` reports the built token. `'7.1'` remains
  the default preset. A request never upgrades: a `'5.1'` request on an 8-channel
  sink stays `'5.1'`.
- The discrete fallback ladder: a preset request on a sink of `M` channels builds
  the largest preset whose channel-need `<= min(request-need, M)`, stepping down
  `7.1 -> 5.1 -> 3.1 -> stereo`. When even `3.1` does not fit (`M < 4`) the bus
  fails closed to a WORKING plain-stereo bus (`lanes = 0`) that plays normally.

### Changed

- `layoutOf()` return union widened to `'7.1' | '5.1' | '3.1' | 'stereo'`.
- `effectiveLayoutOf(busName)` return union widened to
  `'7.1' | '5.1' | '3.1' | 'stereo' | null` -- it now reports the built ladder
  token (`'7.1'` request on a 6-channel sink returns `'5.1'`).
- `createBus` `preset` union widened to `'7.1' | '5.1' | '3.1'`. `'5.1'` / `'3.1'`
  no longer throw the S6 "lands in v2.5.0" `RangeError`; they build.

### Notes

- `3.1` is front-only (no rear speakers): a source directly behind the listener
  folds across the 300-degree back gap between `R` (30 degrees) and `L` (330
  degrees). Correct for a front-only rig, a documented limitation, not a bug.
- Peer range unchanged at `@zakkster/lite-audio-pool ^1.4.0` (the pool has shipped
  `channels: { 4, 6, 8 }` since 1.3.0). No pool release is needed.
- Headless CI has no multichannel sink and the reference client rig reports
  `maxChannelCount 2`, so `5.1` / `3.1` -- like `7.1` -- fall back to stereo on
  that hardware. CI proves detection, the ladder, fallback-to-working-stereo,
  zero-allocation lane writes, rate bounds and retention against a mock N-channel
  context; the audible 6/4-lane traversal is a manual QA step on real hardware.
- See `decisions/0009-preset-ladder.md` for D1-D5.

## 2.4.0

Fail-closed output-layout detection and a 7+1 discrete-surround bus family,
session S6 of the spatial roadmap (closes SP-08, SP-09). The engine now resolves
its output layout once at `init()` and can build a `spatial: 'discrete'` bus that
rides `@zakkster/lite-audio-pool`'s discrete mode (8 SMPTE lanes) with per-voice
VBAP panning driven by the same `setPosition()`.

Additive and default-off: no existing bus record, `play()`, `stop()`, or
`setPosition()` byte moves, and `setPosition()` gains ZERO new branches (a
discrete bus reuses the identical positional scratch). The only new per-tick work
is one `_flushLanes()` over a `this._discreteBuses` array that is empty on every
engine built today, plus one integer compare in `_flushPositions`. The
`HashParity` `stop()` AND `play()` goldens do not move (S6 adds no `play()` arg).

A discrete request on a sink that does not report a concrete integer `>= 8`
channels transparently builds a WORKING stereo bus and reports the effective
layout via `effectiveLayoutOf()`. That is correct, not a failure: on a 2-channel
sink (including a virtual-surround headset that reports `maxChannelCount 2`) the
discrete request falls back to stereo and plays normally.

### Added

- `createBus(name, { spatial: 'discrete', preset: '7.1' })` -- a 7+1
  discrete-surround bus. Under a detected `7.1` layout it builds the pool in
  discrete mode with 8 lanes (`L R C LFE SL SR SBL SBR`) and enables
  `setPosition()` for per-voice VBAP panning; under any smaller layout it fails
  closed to a plain stereo bus (`lanes = 0`) that plays normally. `preset` is
  valid only with `spatial: 'discrete'` (a preset elsewhere is a `RangeError`);
  S6 ships only `'7.1'`, and `'5.1'` / `'3.1'` reject loudly (they land in a later
  release) rather than silently degrade. `spatial: 'discrete'` does not compose
  with a `width` widener (`RangeError`) and, being a single enum field, cannot
  combine with `'hrtf'`.
- `layoutOf()` -- the engine's detected output layout, `'7.1'` or `'stereo'`,
  resolved once at `init()` from `destination.maxChannelCount` and cached. Fail
  closed: only a concrete integer `>= 8` yields `'7.1'`; absent / `undefined` /
  `null` / `NaN` / non-integer / string / `< 8` all yield `'stereo'`. `null` is
  not zero -- an unknown sink is stereo, never optimistically 7.1.
- `effectiveLayoutOf(busName)` -- `'7.1'` when a discrete bus's 8 lanes were
  actually built, `'stereo'` when a discrete request fell back, or `null` on a
  non-discrete or unknown bus. This is how a caller learns whether the fallback
  happened, and that a discrete request on a 2-channel sink returning `'stereo'`
  here is the correct, supported outcome, not an error.
- The 8-lane solver: `az = atan2(x, -z)` normalized to `[0, 360)` picks a
  containing constant-power (VBAP) speaker pair on a seven-lane ring
  (`g1 = cos(f*PI/2)`, `g2 = sin(f*PI/2)`, `g1^2 + g2^2 == 1`); the LFE lane
  (index 3) receives an azimuth-invariant distance-only send, never a VBAP gain;
  `y` (height) has no 7+1 lane and is deliberately not panned. All 8 lane gains
  are written with `setTargetAtTime` at the same `20 ms` / `~10 Hz` cadence as
  position, into one reused module `Float32Array(8)` -- zero allocation,
  rate-bounded to `~10` native events per lane per second.

### Changed

- `defineSounds()` resolves the pool's panner option at cold pool build: a
  discrete bus that earned its 8 lanes builds `{ panner: 'discrete', channels: 8 }`;
  every other bus -- including a discrete request that fell back to stereo -- keeps
  the identity mapping, byte-identical to prior releases.
- `destination.channelCount` / `channelCountMode` / `channelInterpretation` are set
  to `8` / `'explicit'` / `'discrete'` ONLY on the first discrete pool build (this
  is process-global for the context) and the prior triple is restored on
  `destroy()`. An engine with no discrete bus never touches the destination downmix.
  A caller mixing a discrete bus with an assumed-stereo external graph on the same
  context is documented as unsupported (see `decisions/0008-detected-layout.md`).

## 2.3.0

Per-bus stereo width, session S5 of the spatial roadmap (closes SP-04, SP-05,
SP-06). A stereo bus can now be built with a mono-safe Haas widener, and its
width is written on the existing cold `~10 Hz` monitor -- never per frame.

Additive and default-off: a bus built without `width` is byte-for-byte
unchanged (no widener nodes at all). `play()`, `stop()` and the `HashParity`
`stop()` goldens do not move; the hot `play()` path gains zero new branches
(the widener is armed at cold bus construction and the pool simply routes into
it, never re-tested per shot).

### Added

- `createBus(name, { width: 0..1 })` -- arms a mono-safe Haas widener between the
  pool output and the bus gain: the dry (mono) signal plus a delayed,
  opposite-panned wet pair (`12 ms` hard-left, `19 ms` hard-right) summed back
  through an explicit makeup gain of `1/sqrt(1 + 4*wet^2)`, so opening the width
  holds total power flat at `0 dB` (SP-05) instead of getting louder. Omit `width`
  and no widener nodes are built. Fails closed with a did-you-mean on a non-finite
  / boolean / out-of-range value, and on `width > 0` for a `positional`/`hrtf` bus
  (the stereo widener is stereo-only and does not compose with per-voice panning).
- `setWidth(busName, w)` -- a caller-frame method safe to call every frame: it does
  NO param write. It clamps to `[0, 1]`, stamps a target and a dirty bit (zero
  allocation), and the `wet`/`makeup` `AudioParam` writes ride the cold `~10 Hz`
  monitor (`_flushWidth`), at most one event per param per tick and only when the
  value moves. `width: 0` is a bit-identical bypass: a few ticks after the last
  move to `0` the flush snaps `wet` to exactly `0` and `makeup` to exactly `1`
  with `setValueAtTime`, since `setTargetAtTime` never reaches its target. There is
  deliberately no boolean "on" -- the only control is the `0..1` knob.
- `widthOf(busName)` -- the current width, or `null` on an unarmed / disarmed /
  unknown bus.

### Changed

- `defineSounds()` disarms a bus's widener at pool build if any loaded buffer is
  non-mono (`numberOfChannels !== 1`): a Haas widener smears a stereo source
  (SP-06), so the widener nodes are torn down, the pool routes straight to
  `gain`, `setWidth()` becomes a no-op, and `widthRefused` records
  `'stereo-source'` (warned once). The comb-filter mono-downmix hazard (SP-04) is
  documented for single-speaker output.
- `destroy()` disconnects and nulls all 7 widener nodes and resets the width state
  (null, not zero: a stray `setWidth()` after teardown is a no-op).
- The shared `~10 Hz` monitor tick now also runs `_flushWidth()` alongside the
  duck follower, meter sweep, position flush and auto-suspend check.

### Testing

- New torture tier `T-SP6`: the width flush holds the `wet`/`makeup` native
  param-event rate under a `200`/param cap (`~100` expected) with identical-value
  writes collapsing to exactly `1`; `setWidth` is a zero-alloc stamp at `<= 4`
  bytes/op with no major GC (the retained-`{w}`-box control lands clearly above);
  and a lite-leak witness proves `destroy()` disconnects + nulls all 7 widener
  nodes across 200 build/teardown cycles. Ships two proven red controls --
  `LITEAUDIO_TORTURE_SP6_RED=1` (a `60 Hz` per-frame direct param writer that blows
  the event cap) and `LITEAUDIO_TORTURE_SP6_ALLOC_RED=1` (a `setWidth` that boxes
  into a retained object) -- each forces the failure and the gate exits non-zero.
- New boundary suite `test/Width.test.js`: arming only when asked, the bit-exact
  bypass snap, power conservation and the distinct Haas delays, fail-closed
  construction (`width: true` / non-finite / out-of-range / `width > 0` on a
  positional/hrtf bus), `setWidth` clamp + no-op on a non-number / unarmed /
  disarmed bus, the non-mono disarm, throttled event collapse, and `destroy()`
  teardown. `test/mock-ctx.js` gains a `DelayNode` mock (`createDelay`).

## 2.2.0

HRTF spatial bus, session S4 of the spatial roadmap (closes SP-07). A bus can
now be built in binaural per-voice mode, and its head-related impulse-response
set is prewarmed with a silent voice so the first real play does not stutter.

Additive and default-off: existing `'stereo'` and `'positional'` buses are
byte-for-byte unchanged. The hot `play()` and `setPosition()` paths gain zero
new branches -- `'hrtf'` is positional-family, so the `'positional' || 'hrtf'`
OR collapses ONCE at cold bus construction into a derived `positional` boolean
that every existing per-frame site reads instead of re-testing the string.
lite-audio never sets `panningModel` itself: the pool owns its spatial nodes and
their teardown (Route-A), and `{ panner: 'hrtf' }` passes straight through.

### Added

- `createBus(name, { spatial: 'hrtf' })` -- positional-family (same `PannerNode`
  distance graph and `setPosition()` as `'positional'`) but the pool sets
  `panningModel = 'HRTF'` for per-voice binaural convolution. Headphones-only (a
  stereo speaker layout hears no benefit and still pays the CPU), and each live
  HRTF voice costs a per-voice HRTF convolution -- budget accordingly. An unknown
  `spatial` value still fails closed with a did-you-mean.
- Silent HRIR prewarm: an `'hrtf'` bus fires one `gain=0` voice through the pool
  post-unlock (or at pool build when the context is already unlocked), so the
  browser loads the HRTF impulse-response set ahead of the first audible play and
  the first shot does not stutter. Latched by handle so it fires exactly once per
  bus; retired on the next `~10 Hz` monitor tick, ahead of the duck follower /
  meter sweep / auto-suspend check, so no user-facing mix logic ever observes it
  as "something playing". `destroy()` nulls the prewarm handle (null, not zero).

### Changed

- `peerDependencies["@zakkster/lite-audio-pool"]` widened `^1.2.0` -> `^1.4.0`
  (v1.4.0 adds the `panner: 'hrtf'` mode this bus routes through).

### Testing

- New torture tier `T-SP5`: every voice panner across capacity reports
  `panningModel === 'HRTF'`; the prewarm voice retires on the monitor tick with
  `activeCount() === 0` and a zero live-source-node census delta; and a lite-leak
  witness proves `destroy()` releases the hrtf bus across 200 build/teardown
  cycles. Ships a proven red control -- `LITEAUDIO_TORTURE_SP5_RED=1` disables the
  retire so the gain=0 voice leaks a live node and the gate exits non-zero.

## 2.1.0

Positional audio, session S3 of the spatial roadmap (closes SP-01, SP-03,
SP-10). A bus can now be built in per-voice 3D mode, and a voice's position is
written on the existing cold monitor -- never per frame per voice.

Additive and default-off: an existing bus stays a StereoPanner equalpower bus,
byte-for-byte. `play()`, `stop()`, `defineSounds()` and the `HashParity`
`stop()` goldens do not move; the hot `play()` path gains zero new branches
(spatial mode is decided at bus construction and captured into the pool's
`panner` option, never re-tested per shot).

### Added

- `createBus(name, { spatial: 'stereo' | 'positional' })` -- `'positional'`
  builds a `PannerNode` per voice (via `@zakkster/lite-audio-pool` positional
  mode) and enables `setPosition()`. Defaults to `'stereo'`. An unknown value
  fails closed with a did-you-mean, never a silent downgrade.
- `setPosition(handle, x, y, z)` -- takes the SAME handle `play()` returned
  (frozen codec: bus tag in the high half, pool handle in the low half). It is
  a caller-frame method safe to call every frame: it does NO param write. It
  only stamps a preallocated per-bus scratch buffer (`Float32Array(cap*3)`) and
  sets a dirty bit; the actual `positionX/Y/Z` writes ride the shared ~10 Hz
  monitor (`_flushPositions`), throttled with a 0.02 s time constant. Zero
  allocation on the caller frame, and the native automation-event rate is held
  to ~10 Hz per param -- the SP-03 bound.
- Steal-safety: `setPosition` stores the full generation+channel handle, so a
  channel stolen after the call resolves to a null voice on flush and the stale
  position is never written onto the new occupant. A stolen, dead, or bogus
  handle is a silent no-op.

### Notes

- A `'positional'` bus does NOT allocate the position scratch unless built in
  that mode, so a default stereo bus allocates nothing new.
- New torture tiers: **T-SP1** (500k `setPosition` calls, <= 4.0 bytes/op, zero
  major GC), **T-SP2** (32 voices x 10 s of monitor flushes, <= 200 param
  events/param/voice, ~100 expected, counted on the mock param -- not the heap,
  since native events are invisible to the JS-heap gate), and **T-SP3** (a
  `@zakkster/lite-leak` retention witness across 200 build/teardown cycles,
  proving `destroy()` releases the per-bus positional scratch -- a leak the
  bytesPerOp gate cannot see, since the backing store is allocated once per bus,
  not per op). Each ships a proven red control (`LITEAUDIO_TORTURE_SP1_RED=1`
  boxes `{x,y,z}` per call; `LITEAUDIO_TORTURE_SP2_RED=1` writes params at 60 Hz
  per frame; `LITEAUDIO_TORTURE_SP3_RED=1` suppresses the release-proof untrack),
  plus a steal-safety assertion.

### Fixed

- `destroy()` now disposes every lite-signal **signal** it created (per-bus
  `volume`/`mute`, metered `level`, the instance mute/unlock/context-state
  readouts, and every per-sound / per-track signal), not just the effects. Each
  signal is a pool-backed node in `@zakkster/lite-signal` exactly like an effect;
  disposing only the effects returned roughly a third of the nodes and leaked the
  rest, so a host that churns engines (SPA route changes, a test suite, hot
  reload) slowly exhausted the shared node pool -- it crashed at ~72
  build/teardown cycles. It now sustains thousands. Surfaced by the new T-SP3
  witness. No hot path changes; `play()`/`stop()` and the `HashParity` goldens
  are untouched.

### Hardening and hygiene

- `@zakkster/lite-leak` is now a dev peer and an active witness (T-SP3), replacing
  the earlier "no retention dimension" stance the torture header carried -- the
  positional bus S3 added is exactly that dimension.
- `VERSION` is now exported from `Audio.js` (and typed in `Audio.d.ts`), in
  lockstep with `package.json`.
- New `npm run verify` (`test` + `gate`); the `test` script now runs under
  `--expose-gc` for parity with the rest of the suite.
- `CHANGELOG.md` and `llms.txt` are ASCII-only, per the suite convention.

### Peers

- Widened `@zakkster/lite-audio-pool` from `^1.1.0` to `^1.2.0` (positional
  panner mode + the generation-checked `voiceNode()` seam).

## 2.0.0

The Howler retirement. A game built on `lite-audio-manager` (the Howler.js
overlay) now migrates to this engine by changing exactly one import -- and drops
a runtime dependency doing it, because the shim is a pure adapter over
lite-audio, with no Howler underneath.

```diff
- import { audioManager } from 'lite-audio-manager';
+ import { audioManager } from '@zakkster/lite-audio/compat';
```

The major is the milestone, not a break: `./compat` is a purely **additive**
subpath and the core surface is byte-for-byte unchanged. `play()`, `stop()` and
the per-bus write effect keep their `HashParity` locks; the zero-GC gate and all
of 1.2.0's mix features stay green.

### Why it is real and not a claim

Parity is a statement about another package's entire 347-line surface, so it is
only true if it is tested. [`PARITY.md`](PARITY.md) maps every manager member to
the lite-audio path behind it and to the test id that proves it;
[`test/Compat.test.js`](test/Compat.test.js) runs the manager's own ~45
expectations -- ported from its Vitest suite to `node:test` -- against the real
engine. A row without a test id is not a parity claim.

### Added

- **`./compat` subpath.** `AudioManager` class + `audioManager` singleton,
  `extends EventTarget`, same `init`/`play`/`playExclusive`/`playUnique`/`stop`/
  `stopCategory`/`stopCategories`/`setMuted`/`destroy` surface, same `isMuted`/
  `isUnlocked` flags, same `'mutechange'` CustomEvent, and the same
  `lite_audio_muted` storage key -- so a mute preference written by the manager is
  read here and vice versa. An `engine` getter exposes the underlying `LiteAudio`
  for code ready to move past the manager surface.
- **Reused-`<audio>`-element hardening.** A given element can back exactly one
  `MediaElementAudioSourceNode` for its lifetime; a `destroy()` -> re-init cycle on
  a host that pools elements is the path that throws `InvalidStateError`. Track
  wiring now fails that track closed (`loadState: 'error'`) instead of throwing
  into `playTrack()`. Off every hot path (first-play wiring only).

### Fixed

- **Default `fetch` is now bound to `globalThis`.** The constructor documents
  `opts.fetch` as "defaults to `globalThis.fetch`", but it stored the bare
  reference and later called it as `this._fetch(url)` -- which runs `fetch` with
  the engine as receiver, and a browser rejects that with *"Failed to execute
  'fetch' on 'Window': Illegal invocation"*. Any consumer that relied on the
  documented default (rather than injecting `opts.fetch`) got every sound stuck
  in `loadState: 'error'`. The default is now `fetch.bind(globalThis)`. One
  constructor line, off every hot path (`HashParity` unchanged); regression test
  in [`test/Audio.test.js`](test/Audio.test.js) simulates the browser's receiver
  guard. Surfaced by the AU3 demo dogfooding the real default load path.

### The impedance match (documented divergences, all tested)

The manager wraps everything in one `Howl`; lite-audio splits pooled one-shot
SFX from streamed music tracks. The shim **classifies**: a `loop`/`html5` sound
becomes a real streamed track (with real fades -- the value-add), everything else
a pooled SFX voice. Categories become buses (auto-created per distinct
category; an unknown category stops nothing, never everything). Pre-unlock plays
are **kept**, not dropped -- `play()` returns the `null` skip-sentinel but the
play survives to unlock, so the migrant gains lite-audio's unlock queue. Full
reasoning in [`decisions/0007-compat-shim.md`](decisions/0007-compat-shim.md);
each divergence (`DIV-1`..`DIV-4`) has a test.

### Bundle size, stated honestly

Compared minified-and-gzipped, the way a bundler ships it -- the shipped files
carry full JSDoc a minifier strips. The compat path: `Audio.js` ~7.4 KB +
`Compat.js` ~1.6 KB = **~9 KB gzipped**. The stack it replaces:
`lite-audio-manager` ~1.5 KB + Howler `~9 KB` (published `howler.core.min.js`,
gzipped) = **~10.5 KB gzipped**. So the compat path is *smaller* than the Howler
stack, drops a runtime dependency, and is a strict superset (a bus graph,
streamed tracks on that graph, equal-power crossfade, ducking, snapshots,
per-bus meters, zero-GC voice handles). The lite-audio figures are measured here
(comments stripped, gzipped, as a proxy for a real minifier); Howler's is its
published minified size, as Howler is not vendored in this repo. The *shipped*
(commented) files are larger -- 22.4 KB + 5.7 KB gzipped -- because they ship as
readable source; that is what a bundler minifies away.

## 1.2.0

Mix intelligence: ducking, snapshots, auto-suspend, per-bus meters -- none of
which Howler has an answer for.

`stop()` stays byte-identical to 1.0.0. `play()` and the per-bus write effect
were re-baselined deliberately (`test/HashParity.test.js` header explains each),
and the extended zero-GC gate proves the one new repeated path -- the shared
monitor tick -- holds zero retained allocation with all four features live.

### The design in one line

All four features avoid fighting the volume/mute effect for the bus's gain param.
Ducking and snapshot morphs live on a per-bus **sidechain** gain spliced under
volume/mute (`gain -> duckGain -> master`), so automations compose instead of
clobbering each other; meters, the duck follower and auto-suspend share one cold
~10 Hz monitor that never touches `play()`/`stop()`. See `decisions/0003`-`0006`.

### Added

- **Ducking.** `duck(bus, level, {attack, release})` / `stopDuck(bus, {release})`
  is the manual, always-wins primitive; `duckOn(triggerBus, targetBus, {...})` is
  an opt-in voice-count follower evaluated off the hot path, edge-only. Attack and
  release are separate time constants -- a symmetric duck sounds wrong. An explicit
  `duck()` latches the bus out of the follower until `stopDuck()`. See
  `decisions/0003-ducking.md`.
- **Mix snapshots.** `captureSnapshot(name)` records every bus's volume + mute;
  `applySnapshot(name, ms)` morphs back over `ms`. The signals become truthful
  immediately while the audible transition rides the sidechain, continuous from
  the *actual* current level -- so an apply mid-morph, or mid-duck, is click-free.
  Bus gains and mutes only, not track volumes. See `decisions/0004-snapshots.md`.
- **Auto-suspend.** `enableAutoSuspend({after})` suspends the context after N
  silent seconds; a later `play()` wakes it. The wake is one monomorphic branch on
  `play()` that fires a bare `resume()` and lets the native scheduler hold the
  triggering voice against the frozen clock -- no await, no microtask, no
  allocation. Off by default and **refused on iOS**, where a suspend->resume can
  demand a fresh gesture and silently un-unlock the page. See
  `decisions/0005-auto-suspend.md`.
- **Per-bus meters.** `createBus(name, { meter: true })` taps an `AnalyserNode`
  post-duck; `level(bus)` is a ~10 Hz RMS signal. The read sweeps one
  pre-allocated `Float32Array` per metered bus -- zero allocation per read, proven
  by the gate. Unmetered buses allocate no analyser.
- **Dynamic buses.** `createBus(name, opts)` creates a bus after `init()`. The
  2^21 handle ceiling (1.1.1) is now re-checked at runtime, so a bus created past
  it fails closed with a `RangeError` instead of issuing colliding handles. See
  `decisions/0006-dynamic-bus.md`.
- **`test/MixIntelligence.test.js`** -- 21 tests: the duck curve asserted on the
  mock clock (attack != release, edge-only, explicit-wins), snapshot round-trip and
  sidechain-morph continuity, meter RMS and buffer reuse, the auto-suspend cycle
  including the play()-wake and the iOS refusal, and the runtime bus ceiling.

### Changed

- **`play()` golden re-baselined** for the auto-suspend wake check (zero-alloc,
  proven by the gate). **Per-bus write effect golden re-baselined** because the
  effect was relocated verbatim into a shared `_buildBus()` for `createBus()` --
  byte-identical logic, moved lexical home. `stop()` unchanged.
- **`test/torture.mjs` extended**: a second phase builds a live engine with all
  four features active and measures the monitor tick -- 0 bytes/op, still
  falsifiable via `LITEAUDIO_TORTURE_LEAK=1`.
- **Mock harness** gained `createAnalyser` (`test/mock-ctx.js`) for the meter path.

## 1.1.1

The handle contract, written down, and a zero-GC gate that can see it.

No behaviour change on any hot path -- `play()`, `stop()`, and the per-bus write
effect are byte-identical to 1.1.0, and `test/HashParity.test.js` now fails the
build if that ever silently stops being true. This release documents a design
that lived only in a source comment, gives it a type, and closes a blind spot in
what "zero-GC" was actually being tested against.

### The blind spot

The engine handle is `busIndex * 2^32 + poolHandle`. On bus 0 it is a V8 SMI only
until a channel's generation passes 8,388,608; on any bus >= 1 it is >= 2^32 and is
a boxed double. The zero-GC intent was tested on bus 0 at low generation -- exactly
where the handle is an SMI and nothing boxes -- so it could never observe the one
case it was meant to cover. Measured and now closed: the boxed-double return costs
nothing detectable in steady state (well under the major-GC and pause budget), so
the plain-number handle keeps its design and `GEN_MASK` is left at 24 bits. See
`decisions/0001-handle-namespace.md` for the numbers and the rejected
alternatives.

### Added

- **`VoiceHandle` branded type** (`Audio.d.ts`). `play()` / `playOpts()` return
  `VoiceHandle | Skipped`, `playUnique()` returns `VoiceHandle | Skipped |
  TrackStarted`, and `stop()` / `isPlaying()` / `busOf()` accept that union -- so a
  raw integer or a track name handed to `stop()` is now a compile error, and the
  `-1` / `-2` sentinels have a documented home in the types.
- **Handle contract** in `llms.txt` and `README.md`: the four encodings as a
  table (0 is a real handle, not a null; only negatives mean "nothing"), both bit
  layouts, the decode, the 2^21 bus ceiling with its exact derivation, and the SMI
  note.
- **`test/torture.mjs`** -- zero-GC gate (`npm run gate`). Measures the handle
  return on bus >= 1 and past generation 8,388,608, reports `bytesPerOp` per
  regime, and is falsifiable: `LITEAUDIO_TORTURE_LEAK=1` routes the gated path
  through the rejected `{bus,handle}`-object design and the gate exits non-zero.
- **`test/Handles.test.js`** -- every encoding pinned by name, including `stop(0)`
  reaching the real bus-0/channel-0/generation-0 voice, `stop(-2)` staying inert
  next to a live handle-0 voice, and the real engine leaving SMI range past
  generation 8,388,608.
- **`test/HashParity.test.js`** -- hashes the source of `play()`, `stop()`, and the
  per-bus write effect against their 1.1.0 goldens, so a docs-and-tests release
  cannot touch a hot path unnoticed.
- **Decision records** `decisions/0001-handle-namespace.md` (the
  bus-above-32-bits design, rejected alternatives, the measurement, and why
  `GEN_MASK` is not narrowed) and `decisions/0002-generation-wrap.md` (audio wraps
  where lite-arena retires, and why the divergence is deliberate).

### Changed

- **`init()` fails closed above 2^21 buses.** A voice handle stops being an exact
  integer past bus index 2^21 - 1, so a larger bus graph would issue colliding
  handles; `init()` now throws a `RangeError` instead. `'master'` is implicit and
  does not count against the ceiling. This is a cold guard -- the `play()` / `stop()`
  hot paths are untouched (proven by `HashParity.test.js`).

## 1.1.0

The music layer. Streaming tracks via `MediaElementAudioSourceNode` share the
same bus graph as SFX; the crossfade is the mixer, the buses are the routing,
the pool is untouched.

Not purely additive after all. Putting tracks on the buses turned three
existing behaviours into bugs -- `stopAll()` that leaves the music playing,
`playUnique()` that hands back a live SFX handle to say "the track started",
`resumeTrack()` that plays silence -- and surfaced one that predates the music
layer entirely: SFX handles did not carry their bus. See **Fixed**.

### Added

- **`defineTracks(config)`** -- fetch + attach `<audio>` elements + register
  per-track signals (loadState, playing, position, duration). Same async
  shape as `defineSounds`. Config accepts `loop`, `loopStart`, `loopEnd`
  alongside `src`, `bus`, `volume`. Format fallback via `canPlayType` over
  the src array, same probe as SFX.
- **`playTrack(name, opts?)`** -- starts or resumes a track. Idempotent per
  name; playing an already-playing track is a no-op unless `restart: true`
  is set. `fadeIn` (ms) schedules an equal-power ramp; `position` (seconds)
  seeks before play. Silent no-op if the context is still locked or the
  track is not `ready`.
- **`stopTrack(name, { fade? })`** -- schedules a fade-out on the track's
  xfadeGain. The `playing` signal flips false immediately (HUDs update); the
  `<audio>` element is paused after the fade so decoding stops. Default
  fade 200 ms.
- **`pauseTrack(name)` / `resumeTrack(name)`** -- pause without losing
  position; resume picks up where paused. Distinct from stop/play in that
  no fade is scheduled and the graph stays live.
- **`crossfade(from, to, durationMs)`** -- equal-power ramp on both sides.
  Either side may be `null` for fade-out-only or fade-in-only. Curves are
  scaled from the outgoing/incoming track's current xfadeGain value, so a
  mid-flight retarget starts from where the automation actually is and has
  no discontinuity.
  - **Interruption semantics (case c).** A track fading out from a previous
    crossfade keeps its scheduled fade. Only tracks named in the new call
    are touched. A track that was fading IN and is now the OUTGOING of the
    new call reads its current gain, cancels its schedule, and starts an
    equal-power fade-out from that value.
- **`playExclusive(name, opts?)`** -- starts `name`, fades every other
  playing track on `name`'s bus. Bus-scoped, not category-scoped: buses are
  the physical version of the manager's categories, so an exclusive on the
  music bus leaves SFX and voice untouched.
- **`playUnique(name, thresholdMs = 100)`** -- manager parity. Timestamp
  gate keyed by name via `Map<string, timestamp>`. Works on both registered
  sounds (dispatches to `play`) and tracks (dispatches to `playTrack`).
  Returns `-1` on threshold rejection or unknown name.
- **New reactive readouts.** `trackLoadState(name)`, `trackPlaying(name)`,
  `trackPosition(name)`, `trackDuration(name)`.

### Changed

- **Default bus set.** `LiteAudioOptions.buses` now defaults to
  `['sfx', 'ui', 'voice', 'music']` so `defineTracks` works with its default
  routing out of the box. Explicit `buses` config still overrides.

### Fixed

- **SFX handles did not name a bus.** A pool handle is a full uint32
  (`[gen:24][channel:8]`) with no spare bits, and every bus runs its own pool
  counting channels and generations from zero. So the first play on *every* bus
  returned the identical handle -- `0x00000000` -- and `stop()` broadcast that raw
  value to every pool, where each generation check happily passed. Stopping an
  `sfx` voice also killed whatever sat on channel 0 of `ui`, `voice`, and
  `music`. The generation counter cannot prevent this: it is a recycle counter,
  not a namespace. `play()` now returns `busIndex * 2^32 + poolHandle`; `stop()`
  resolves the owning pool in O(1) and cannot cross a bus boundary. Handles stay
  plain opaque numbers, exact well inside 2^53.
- **`stopAll()` and `stopBus()` ignored music.** Both stopped pool voices only,
  so a scene change that called `stopAll()` left the old theme playing under the
  new scene. Both now also fade out the tracks routed to the buses they name
  (`opts.fade`, default 200 ms). "Stop every voice on every bus" has to mean the
  bus, now that tracks live on it.
- **`playUnique()` returned `0` for a track.** `0` is not a null handle -- it is
  channel 0, generation 0, bus 0: a perfectly good voice. A caller doing
  `const h = playUnique('theme'); ... stop(h)` killed an unrelated SFX voice.
  Tracks are singletons addressed by name and have no handle, so a track start
  now reports `-2`, which is inert to `stop()` and distinguishable from the `-1`
  that already meant "skipped".
- **`resumeTrack()` after `stopTrack()` played silence.** `stopTrack()` fades
  `xfadeGain` to zero; `resumeTrack()` restarted the element and set
  `playing` to `true` without ever restoring the gain. The result was a track
  that was decoding, reporting itself as playing, and completely inaudible -- a
  signal that lied. `resumeTrack()` now lifts the gain back to full over a 40 ms
  equal-power ramp (a no-op when it is already there) and disarms any pause left
  queued behind the earlier fade.
- **`destroy()` left the `<audio>` elements holding their streams.** Handlers
  were removed and the element paused, but a paused element that still has a
  `src` can keep buffering, and after `_tracks.clear()` nothing could reach it to
  stop. Teardown now releases the source (`removeAttribute('src')` + `load()`).

### Internal

- **Equal-power curves precomputed at module load.** Two 128-sample
  `Float32Array`s (`EQ_POWER_IN`, `EQ_POWER_OUT`). Per-crossfade allocation
  is one scaled `Float32Array` per side (512 bytes each), GC'd after the
  curve executes. Off the hot path -- scene transitions, not frame loops.
- **Position writes are throttled at the source.** A per-track
  `lastPositionWrite` timestamp on the ctx clock; a `timeupdate` listener
  writes to the position signal only if 100 ms of ctx time have passed
  since the last write. No `setInterval`, no rAF loop, no allocation.
- **Delayed pause after stopTrack.** `<audio>.pause()` is deferred until
  `fade + 30 ms` via injectable `setTimeout`, so the fade tail is audible.
  Tests inject a manual scheduler and call `flush()` to make teardown
  deterministic.

### Mock harness (test/mock-ctx.js) extensions

- **`mockParam` params now follow their automation.** Every scheduling call
  still records its shape into `.events`, and now also settles `.value` on the
  value it is heading for (including a new `setValueCurveAtTime`). Recording
  alone was not enough: it let a test prove a fade-out was *scheduled* while
  saying nothing about where the gain ended up -- and "scheduled a fade-out"
  plus "still audible" is precisely the shape of the `resumeTrack` bug fixed
  above. A harness that cannot express the bug cannot catch it. Tests that care
  about the ramp read `.events`; tests that care about the outcome read `.value`.
- `mockMediaElementSource(element)` factory, and `ctx.createMediaElementSource(el)`
  on the mock context. The node keeps a reference to the element it was built
  from, so a test can assert the graph was wired to the right track.
- `mockAudioElement(src?)` factory: `play` / `pause` / `load` /
  `removeAttribute`, settable `currentTime`, `duration`, `loop`, `paused`,
  `playCalls` / `pauseCalls` / `loadCalls` / `srcReleased` counters, and
  `_fire(type)` / `_listenerCount(type)` so tests can dispatch `timeupdate`,
  `ended`, and `loadedmetadata` by hand.
- `mockDocument()` -- hands out `<audio>` elements and records them in order, so
  "one element per track" is an assertion rather than a hope.
- `mockScheduler()` -- manual `setTimeout` / `clearTimeout` for
  `opts.setTimeout` / `opts.clearTimeout`. `stopTrack` defers the element pause
  until after the fade; with a real timer that is a race, and with this it is an
  assertion.

Every v1.0.0 test consumes the harness unchanged.

### Test coverage (v1.1.0)

**75 tests across 18 suites, all green.** 32 carried from v1.0.0 unchanged, plus:

`test/Tracks.test.js` -- 37 tests:

- **defineTracks** (6): ready state, one `<audio>` element per track,
  unknown-bus throw, idempotent re-definition, error when no source resolves,
  duration from `loadedmetadata` and error from the element.
- **playTrack** (7): graph wired `source -> xfade -> volume -> bus` with the
  track's volume on `volumeGain`, element starts and `playing` flips, no-op
  while locked, no-op when never loaded, idempotent unless `restart`, seeks to
  `position`, `fadeIn` schedules an equal-power curve of the right duration.
- **stopTrack** (3): `playing` flips at once while the element keeps decoding
  through the fade tail, the pause lands only on scheduler flush, `fade: 0`
  drops the gain in one step with no curve, stopping an idle track arms nothing.
- **pauseTrack / resumeTrack** (4): pause preserves position and does not touch
  the gain; **resume after `stopTrack` restores the gain instead of playing
  silence**; resume disarms the pause queued behind the fade; resume refuses
  while locked or unloaded.
- **Looping and position** (4): native `element.loop` when there are no custom
  points and disabled when there are, `timeupdate` seek back to `loopStart` on
  crossing `loopEnd`, position signal throttled to 100 ms of context time,
  `ended` flips `playing` without tearing the graph down.
- **Crossfade** (5): both sides scheduled from the same instant over the same
  duration; **combined power holds at 1.0 across every sample** (a linear fade
  would dip to 0.71); one-sided fades in each direction; a mid-flight retarget
  starts from the gain's current value with no jump.
- **playExclusive / playUnique** (3): exclusive fades bus siblings and leaves
  other buses alone; **`playUnique` returns `-2` for a track and cannot be
  mistaken for handle `0`**; threshold gating and unknown names.
- **Bus-wide stops** (2): `stopAll()` reaches the music; `stopBus()` stays
  scoped to the bus it names.
- **Teardown** (3): `destroy()` releases the elements (`removeAttribute('src')`
  + `load()`), removes handlers, disconnects the track nodes, clears the pending
  pause timer, and is idempotent and inert afterwards.

`test/BusHandles.test.js` -- 6 tests: handles from different buses are never
equal while their raw pool handles are identical, `stop()` cannot cross a bus
boundary, `busOf()`, stolen-handle staleness, `activeCount()` per-bus and
engine-wide, and handles staying exact integers well inside 2^53.

Not covered, and honestly so: **format fallback**. `pickSupportedSrc()` probes
the real `document` / `Audio` globals rather than the injected ones, so under
`node:test` it always takes the "no `<audio>` available, first URL wins" branch.
Testing it would mean either injecting the probe or polluting globals; the
branch it actually runs is covered, the `canPlayType` path is not.

### Deliberately deferred to A3 (v1.2.0)

- Ducking (sfx/voice activity dips the music bus via a follower ramp)
- Mix snapshots (`captureSnapshot()` / `applySnapshot(name, ms)`)
- Auto-suspend (D9)
- Per-bus `AnalyserNode` meter signals (opt-in)

## 1.0.0

Initial release. Ships the SFX layer of the lite-audio stack: signal-driven
buses over one `AudioPool` per bus, iOS/mobile unlock ported verbatim from
`lite-audio-manager`, plus a bounded pre-unlock play queue.

### Included (roadmap D1 / D3 / D4 / D5 / D6 / D7 / D8)

- **Signal-driven control surface (D1).** Bus volumes, mutes, master mute,
  context state, per-sound load state are all `lite-signal` signals. Each bus
  gets one `effect()` that writes the effective target
  (`muted ? 0 : volume`) through `setTargetAtTime(target, currentTime, 0.01)`
  -- click-free by construction, no manual ramp code in userland.
- **Unlock ported verbatim (D3).** Silent-buffer pulse + `ctx.resume()` on the
  first `touchstart` / `touchend` / `mousedown` / `keydown`, capture-phase,
  behind an `AbortController`. Handles `'interrupted'` state (iOS phone-call
  scenario) as equivalent to `'suspended'`.
- **Bounded pre-unlock play queue (D3 extension).** `play()` before unlock
  returns `-1` and enqueues the intent (latest-per-sound, bounded).
- **Reactive loader (D4).** `defineSounds(config)` with per-sound
  `loadState()` signal transitions and format fallback.
- **Positional hot path (D5) and pool-delegated stops (D6).**
- **Master mute persistence (D7).** localStorage key `'lite_audio_muted'`.
- **Mock-ctx test harness (D8).**

### Peer dependency pins

- `@zakkster/lite-signal` `^1.3.0`
- `@zakkster/lite-audio-pool` `^1.1.0`
