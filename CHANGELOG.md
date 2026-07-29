# Changelog

## 2.0.0

The Howler retirement. A game built on `lite-audio-manager` (the Howler.js
overlay) now migrates to this engine by changing exactly one import — and drops
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
expectations — ported from its Vitest suite to `node:test` — against the real
engine. A row without a test id is not a parity claim.

### Added

- **`./compat` subpath.** `AudioManager` class + `audioManager` singleton,
  `extends EventTarget`, same `init`/`play`/`playExclusive`/`playUnique`/`stop`/
  `stopCategory`/`stopCategories`/`setMuted`/`destroy` surface, same `isMuted`/
  `isUnlocked` flags, same `'mutechange'` CustomEvent, and the same
  `lite_audio_muted` storage key — so a mute preference written by the manager is
  read here and vice versa. An `engine` getter exposes the underlying `LiteAudio`
  for code ready to move past the manager surface.
- **Reused-`<audio>`-element hardening.** A given element can back exactly one
  `MediaElementAudioSourceNode` for its lifetime; a `destroy()` → re-init cycle on
  a host that pools elements is the path that throws `InvalidStateError`. Track
  wiring now fails that track closed (`loadState: 'error'`) instead of throwing
  into `playTrack()`. Off every hot path (first-play wiring only).

### The impedance match (documented divergences, all tested)

The manager wraps everything in one `Howl`; lite-audio splits pooled one-shot
SFX from streamed music tracks. The shim **classifies**: a `loop`/`html5` sound
becomes a real streamed track (with real fades — the value-add), everything else
a pooled SFX voice. Categories become buses (auto-created per distinct
category; an unknown category stops nothing, never everything). Pre-unlock plays
are **kept**, not dropped — `play()` returns the `null` skip-sentinel but the
play survives to unlock, so the migrant gains lite-audio's unlock queue. Full
reasoning in [`decisions/0007-compat-shim.md`](decisions/0007-compat-shim.md);
each divergence (`DIV-1`..`DIV-4`) has a test.

### Bundle size, stated honestly

Compared minified-and-gzipped, the way a bundler ships it — the shipped files
carry full JSDoc a minifier strips. The compat path: `Audio.js` ~7.4 KB +
`Compat.js` ~1.6 KB ≈ **~9 KB gzipped**. The stack it replaces:
`lite-audio-manager` ~1.5 KB + Howler `~9 KB` (published `howler.core.min.js`,
gzipped) ≈ **~10.5 KB gzipped**. So the compat path is *smaller* than the Howler
stack, drops a runtime dependency, and is a strict superset (a bus graph,
streamed tracks on that graph, equal-power crossfade, ducking, snapshots,
per-bus meters, zero-GC voice handles). The lite-audio figures are measured here
(comments stripped, gzipped, as a proxy for a real minifier); Howler's is its
published minified size, as Howler is not vendored in this repo. The *shipped*
(commented) files are larger — 22.4 KB + 5.7 KB gzipped — because they ship as
readable source; that is what a bundler minifies away.

## 1.2.0

Mix intelligence: ducking, snapshots, auto-suspend, per-bus meters — none of
which Howler has an answer for.

`stop()` stays byte-identical to 1.0.0. `play()` and the per-bus write effect
were re-baselined deliberately (`test/HashParity.test.js` header explains each),
and the extended zero-GC gate proves the one new repeated path — the shared
monitor tick — holds zero retained allocation with all four features live.

### The design in one line

All four features avoid fighting the volume/mute effect for the bus's gain param.
Ducking and snapshot morphs live on a per-bus **sidechain** gain spliced under
volume/mute (`gain → duckGain → master`), so automations compose instead of
clobbering each other; meters, the duck follower and auto-suspend share one cold
~10 Hz monitor that never touches `play()`/`stop()`. See `decisions/0003`–`0006`.

### Added

- **Ducking.** `duck(bus, level, {attack, release})` / `stopDuck(bus, {release})`
  is the manual, always-wins primitive; `duckOn(triggerBus, targetBus, {...})` is
  an opt-in voice-count follower evaluated off the hot path, edge-only. Attack and
  release are separate time constants — a symmetric duck sounds wrong. An explicit
  `duck()` latches the bus out of the follower until `stopDuck()`. See
  `decisions/0003-ducking.md`.
- **Mix snapshots.** `captureSnapshot(name)` records every bus's volume + mute;
  `applySnapshot(name, ms)` morphs back over `ms`. The signals become truthful
  immediately while the audible transition rides the sidechain, continuous from
  the *actual* current level — so an apply mid-morph, or mid-duck, is click-free.
  Bus gains and mutes only, not track volumes. See `decisions/0004-snapshots.md`.
- **Auto-suspend.** `enableAutoSuspend({after})` suspends the context after N
  silent seconds; a later `play()` wakes it. The wake is one monomorphic branch on
  `play()` that fires a bare `resume()` and lets the native scheduler hold the
  triggering voice against the frozen clock — no await, no microtask, no
  allocation. Off by default and **refused on iOS**, where a suspend→resume can
  demand a fresh gesture and silently un-unlock the page. See
  `decisions/0005-auto-suspend.md`.
- **Per-bus meters.** `createBus(name, { meter: true })` taps an `AnalyserNode`
  post-duck; `level(bus)` is a ~10 Hz RMS signal. The read sweeps one
  pre-allocated `Float32Array` per metered bus — zero allocation per read, proven
  by the gate. Unmetered buses allocate no analyser.
- **Dynamic buses.** `createBus(name, opts)` creates a bus after `init()`. The
  2^21 handle ceiling (1.1.1) is now re-checked at runtime, so a bus created past
  it fails closed with a `RangeError` instead of issuing colliding handles. See
  `decisions/0006-dynamic-bus.md`.
- **`test/MixIntelligence.test.js`** — 21 tests: the duck curve asserted on the
  mock clock (attack ≠ release, edge-only, explicit-wins), snapshot round-trip and
  sidechain-morph continuity, meter RMS and buffer reuse, the auto-suspend cycle
  including the play()-wake and the iOS refusal, and the runtime bus ceiling.

### Changed

- **`play()` golden re-baselined** for the auto-suspend wake check (zero-alloc,
  proven by the gate). **Per-bus write effect golden re-baselined** because the
  effect was relocated verbatim into a shared `_buildBus()` for `createBus()` —
  byte-identical logic, moved lexical home. `stop()` unchanged.
- **`test/torture.mjs` extended**: a second phase builds a live engine with all
  four features active and measures the monitor tick — 0 bytes/op, still
  falsifiable via `LITEAUDIO_TORTURE_LEAK=1`.
- **Mock harness** gained `createAnalyser` (`test/mock-ctx.js`) for the meter path.

## 1.1.1

The handle contract, written down, and a zero-GC gate that can see it.

No behaviour change on any hot path — `play()`, `stop()`, and the per-bus write
effect are byte-identical to 1.1.0, and `test/HashParity.test.js` now fails the
build if that ever silently stops being true. This release documents a design
that lived only in a source comment, gives it a type, and closes a blind spot in
what "zero-GC" was actually being tested against.

### The blind spot

The engine handle is `busIndex * 2^32 + poolHandle`. On bus 0 it is a V8 SMI only
until a channel's generation passes 8,388,608; on any bus ≥ 1 it is ≥ 2^32 and is
a boxed double. The zero-GC intent was tested on bus 0 at low generation — exactly
where the handle is an SMI and nothing boxes — so it could never observe the one
case it was meant to cover. Measured and now closed: the boxed-double return costs
nothing detectable in steady state (well under the major-GC and pause budget), so
the plain-number handle keeps its design and `GEN_MASK` is left at 24 bits. See
`decisions/0001-handle-namespace.md` for the numbers and the rejected
alternatives.

### Added

- **`VoiceHandle` branded type** (`Audio.d.ts`). `play()` / `playOpts()` return
  `VoiceHandle | Skipped`, `playUnique()` returns `VoiceHandle | Skipped |
  TrackStarted`, and `stop()` / `isPlaying()` / `busOf()` accept that union — so a
  raw integer or a track name handed to `stop()` is now a compile error, and the
  `-1` / `-2` sentinels have a documented home in the types.
- **Handle contract** in `llms.txt` and `README.md`: the four encodings as a
  table (0 is a real handle, not a null; only negatives mean "nothing"), both bit
  layouts, the decode, the 2^21 bus ceiling with its exact derivation, and the SMI
  note.
- **`test/torture.mjs`** — zero-GC gate (`npm run gate`). Measures the handle
  return on bus ≥ 1 and past generation 8,388,608, reports `bytesPerOp` per
  regime, and is falsifiable: `LITEAUDIO_TORTURE_LEAK=1` routes the gated path
  through the rejected `{bus,handle}`-object design and the gate exits non-zero.
- **`test/Handles.test.js`** — every encoding pinned by name, including `stop(0)`
  reaching the real bus-0/channel-0/generation-0 voice, `stop(-2)` staying inert
  next to a live handle-0 voice, and the real engine leaving SMI range past
  generation 8,388,608.
- **`test/HashParity.test.js`** — hashes the source of `play()`, `stop()`, and the
  per-bus write effect against their 1.1.0 goldens, so a docs-and-tests release
  cannot touch a hot path unnoticed.
- **Decision records** `decisions/0001-handle-namespace.md` (the
  bus-above-32-bits design, rejected alternatives, the measurement, and why
  `GEN_MASK` is not narrowed) and `decisions/0002-generation-wrap.md` (audio wraps
  where lite-arena retires, and why the divergence is deliberate).

### Changed

- **`init()` fails closed above 2^21 buses.** A voice handle stops being an exact
  integer past bus index 2^21 − 1, so a larger bus graph would issue colliding
  handles; `init()` now throws a `RangeError` instead. `'master'` is implicit and
  does not count against the ceiling. This is a cold guard — the `play()` / `stop()`
  hot paths are untouched (proven by `HashParity.test.js`).

## 1.1.0

The music layer. Streaming tracks via `MediaElementAudioSourceNode` share the
same bus graph as SFX; the crossfade is the mixer, the buses are the routing,
the pool is untouched.

Not purely additive after all. Putting tracks on the buses turned three
existing behaviours into bugs — `stopAll()` that leaves the music playing,
`playUnique()` that hands back a live SFX handle to say "the track started",
`resumeTrack()` that plays silence — and surfaced one that predates the music
layer entirely: SFX handles did not carry their bus. See **Fixed**.

### Added

- **`defineTracks(config)`** — fetch + attach `<audio>` elements + register
  per-track signals (loadState, playing, position, duration). Same async
  shape as `defineSounds`. Config accepts `loop`, `loopStart`, `loopEnd`
  alongside `src`, `bus`, `volume`. Format fallback via `canPlayType` over
  the src array, same probe as SFX.
- **`playTrack(name, opts?)`** — starts or resumes a track. Idempotent per
  name; playing an already-playing track is a no-op unless `restart: true`
  is set. `fadeIn` (ms) schedules an equal-power ramp; `position` (seconds)
  seeks before play. Silent no-op if the context is still locked or the
  track is not `ready`.
- **`stopTrack(name, { fade? })`** — schedules a fade-out on the track's
  xfadeGain. The `playing` signal flips false immediately (HUDs update); the
  `<audio>` element is paused after the fade so decoding stops. Default
  fade 200 ms.
- **`pauseTrack(name)` / `resumeTrack(name)`** — pause without losing
  position; resume picks up where paused. Distinct from stop/play in that
  no fade is scheduled and the graph stays live.
- **`crossfade(from, to, durationMs)`** — equal-power ramp on both sides.
  Either side may be `null` for fade-out-only or fade-in-only. Curves are
  scaled from the outgoing/incoming track's current xfadeGain value, so a
  mid-flight retarget starts from where the automation actually is and has
  no discontinuity.
  - **Interruption semantics (case c).** A track fading out from a previous
    crossfade keeps its scheduled fade. Only tracks named in the new call
    are touched. A track that was fading IN and is now the OUTGOING of the
    new call reads its current gain, cancels its schedule, and starts an
    equal-power fade-out from that value.
- **`playExclusive(name, opts?)`** — starts `name`, fades every other
  playing track on `name`'s bus. Bus-scoped, not category-scoped: buses are
  the physical version of the manager's categories, so an exclusive on the
  music bus leaves SFX and voice untouched.
- **`playUnique(name, thresholdMs = 100)`** — manager parity. Timestamp
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
  returned the identical handle — `0x00000000` — and `stop()` broadcast that raw
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
- **`playUnique()` returned `0` for a track.** `0` is not a null handle — it is
  channel 0, generation 0, bus 0: a perfectly good voice. A caller doing
  `const h = playUnique('theme'); ... stop(h)` killed an unrelated SFX voice.
  Tracks are singletons addressed by name and have no handle, so a track start
  now reports `-2`, which is inert to `stop()` and distinguishable from the `-1`
  that already meant "skipped".
- **`resumeTrack()` after `stopTrack()` played silence.** `stopTrack()` fades
  `xfadeGain` to zero; `resumeTrack()` restarted the element and set
  `playing` to `true` without ever restoring the gain. The result was a track
  that was decoding, reporting itself as playing, and completely inaudible — a
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
  curve executes. Off the hot path — scene transitions, not frame loops.
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
  saying nothing about where the gain ended up — and "scheduled a fade-out"
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
- `mockDocument()` — hands out `<audio>` elements and records them in order, so
  "one element per track" is an assertion rather than a hope.
- `mockScheduler()` — manual `setTimeout` / `clearTimeout` for
  `opts.setTimeout` / `opts.clearTimeout`. `stopTrack` defers the element pause
  until after the fade; with a real timer that is a race, and with this it is an
  assertion.

Every v1.0.0 test consumes the harness unchanged.

### Test coverage (v1.1.0)

**75 tests across 18 suites, all green.** 32 carried from v1.0.0 unchanged, plus:

`test/Tracks.test.js` — 37 tests:

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

`test/BusHandles.test.js` — 6 tests: handles from different buses are never
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
  — click-free by construction, no manual ramp code in userland.
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
