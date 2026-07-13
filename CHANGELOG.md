# Changelog

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
