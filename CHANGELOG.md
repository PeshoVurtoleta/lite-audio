# Changelog

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
  behind an `AbortController` — same event set and same attach shape as the
  manager. Handles `'interrupted'` state (iOS phone-call scenario) as
  equivalent to `'suspended'`. Added: `ctxState()` and `unlocked()` as signals
  the rest of the app can subscribe to.
- **Bounded pre-unlock play queue (D3 extension).** `play()` before unlock
  returns `-1` and enqueues the intent. Same-sound repeats collapse to
  latest-per-sound; new distinct sounds past `queueLimit` are silently dropped.
  Flushed on unlock. The manager's silent-drop behavior was the #1 mobile-game
  paper cut Howler could not fix from the outside; lite-audio fixes it from
  the inside.
- **Reactive loader (D4).** `defineSounds(config)` fetches + decodes each
  sound; a `loadState(id)` signal per sound transitions
  `'idle' -> 'loading' -> 'ready' | 'error'` observably. Format fallback via
  `canPlayType` probe over the `src` array. Fetch is injectable for tests.
- **Positional hot path (D5).** `play(soundId, volume, pan, pitch)` — no
  options object per call. `playOpts(id, {...})` sugar layer above handles
  `pitchVar` random-pitch resolution.
- **Bus-tagged voice handles (D5/D6).** `play()` returns
  `busIndex * 2^32 + poolHandle`. The tag is not decoration: every bus runs its
  own `AudioPool`, and every pool counts channels and generations from zero, so
  the first play on *each* bus returns the identical raw handle
  (`0x00000000` - channel 0, generation 0). A handle alone cannot say which bus
  issued it, and the pool's generation check cannot help, because it is a
  recycle counter, not a namespace. With the tag, `stop()` resolves the owning
  pool in O(1) and cannot reach across a bus boundary. Handles stay plain
  numbers, exact well inside 2^53, opaque to callers.
- **Fades delegated to pool (D6).** `stop(handle)` routes to the handle's own
  bus; the generation check inside that pool means a stale handle after a steal
  is a silent no-op, never a wrong-voice hit.
- **`isPlaying(handle)`, `busOf(handle)`, `activeCount(busName?)`.** Liveness of
  one voice, the bus that issued a handle, and the live voice count per bus or
  engine-wide. Allocation-free; `activeCount()` is safe to call every frame.
- **Master mute persistence (D7).** localStorage key `'lite_audio_muted'` -
  byte-identical to `lite-audio-manager` so a game migrating between the two
  keeps the player's saved preference intact.
- **Mock-ctx test harness (D8).** `test/mock-ctx.js` records every
  `AudioParam` scheduled event into an `.events` array, runs a real state
  machine covering all four `AudioContextState` values, and mocks
  `decodeAudioData` + `fetch` with length-hint payloads so different mock
  URLs decode to different-sized buffers deterministically. Foundation for
  every later lite-audio session.

### Deliberately deferred (roadmap D10)

- **Music streaming layer.** `MediaElementAudioSourceNode`, crossfades,
  reactive `position()` / `duration()`, `playExclusive` / `playUnique` -
  ships in **v1.1.0** (roadmap session A2).
- **Ducking, mix snapshots, per-bus meters, auto-suspend.** Ships in
  **v1.2.0** (roadmap session A3).
- **`./compat` shim.** `AudioManager`-shaped adapter over `LiteAudio` for
  drop-in migration, plus full parity certification. Ships in **v2.0.0**
  (roadmap session A4).
- **3D spatial (PannerNode/HRTF), AudioWorklet custom DSP, convolution
  reverb.** Post-2.0.

### Demo

- New `demo/index.html`: single-file, four scenes, no asset folder - every sound
  is synthesized in an `OfflineAudioContext`, encoded to WAV, and served to the
  engine as a `blob:` URL, so the real fetch + decode path runs.
  **unlock** - the context lifecycle as an SVG state machine driven by
  `ctxState()`, plus the pre-unlock queue: fire plays while locked and watch
  latest-per-sound collapse and the `queueLimit` drop, then dispatch the gesture
  and hear the flush. The engine takes a *fake window* through `opts.window`, so
  the demo owns the gesture instead of racing it - the one-shot feature becomes
  replayable. **loader** - `loadState()` per sound, with one asset behind 2.6s of
  injected fetch latency and one pointed at a 404, so `loading` and `error` are
  states you can actually watch. **mixer** - bus faders and mutes as signals,
  with a gain scope plotting the real `GainNode.value` against the signal target:
  the 10ms `setTargetAtTime` bend is the click you do not hear. **voices** - the
  per-bus pools, and the twin-handle trap: two buses hand back the same raw
  handle, and only the bus tag keeps `stop()` from killing both.

### Test coverage

38 tests across 10 suites, all green. Gate items from the roadmap:

- Unlock state machine including `'interrupted'` — 6 tests
- Loader fallback + error - 5 tests
- Bus effect writes as `setTargetAtTime` on the mock ctx - 4 tests
- Steal + declick schedule shape (delegated) - 1 test
- Generation no-op on stale handles (delegated) - covered in 2 playback tests
- Unlock queue flush (latest-per-sound, bounded) - 3 tests
- Zero-GC hot path shape - 1 test
- Master mute persistence — 3 tests
- Playback delegation to pool — 6 tests
- destroy() idempotency + listener detachment - 3 tests

- Handle namespace across buses - 6 tests (`test/BusHandles.test.js`)

### Peer dependency pins

- `@zakkster/lite-signal` `^1.3.0`
- `@zakkster/lite-audio-pool` `^1.1.0`
