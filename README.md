# @zakkster/lite-audio

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-audio.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-audio)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Engine-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-audio?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-audio)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-audio?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-audio)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-audio?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-audio)
![Tree-Shakeable](https://img.shields.io/badge/tree--shakeable-yes-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)


Zero-GC reactive Web Audio engine. Signal-driven buses, ABA-safe voice handles,
unlock queue, one `AudioPool` per bus. The SFX layer of a growing audio stack
that eventually deprecates the Howler wrapper it replaces.

- Zero deps of its own; two peers: `@zakkster/lite-signal` and
  `@zakkster/lite-audio-pool`
- ~7.5 KB minified, ~2.7 KB gzipped
- No Howler, no HTML5 Audio fallback, no MP3 decoder shim — just the Web Audio
  API surface the modern web has had since 2018, wired precisely
- Ports the iOS/mobile unlock semantics of `lite-audio-manager` verbatim, plus a
  bounded pre-unlock play queue the manager could not offer from Howler's outside

**Status:** v1.0.0 covers SFX; v1.1.0 added the music streaming layer
(`MediaElementAudioSourceNode`, crossfades, exclusive/unique); v1.2.0 added mix
intelligence — ducking, snapshots, auto-suspend, per-bus meters, dynamic buses;
**v2.0.0 ships the `./compat` drop-in** for `lite-audio-manager` with full parity
certification. Migrate off the Howler overlay by changing one import.

## Install

```bash
npm i @zakkster/lite-audio @zakkster/lite-signal @zakkster/lite-audio-pool
```

## Quick start

```js
import { LiteAudio } from '@zakkster/lite-audio';

const audio = new LiteAudio({ buses: ['sfx', 'ui', 'voice'] });
await audio.init();                       // creates an AudioContext internally

await audio.defineSounds({
    laser: { src: ['/laser.opus', '/laser.mp3'], bus: 'sfx' },
    hit:   { src: ['/hit.wav'],                  bus: 'sfx', pitchVar: 0.15 },
    click: { src: ['/click.mp3'],                bus: 'ui' },
});

// Fires immediately when unlocked; queued (bounded, latest-per-sound) and
// flushed on the first touchstart / mousedown / keydown otherwise. No polling,
// no "waiting for unlock" ceremony in the caller.
const handle = audio.play('laser', 0.8, 0.0, 1.0);
audio.stop(handle);                       // stale handles are silent no-ops
audio.isPlaying(handle);                  // false once stolen, stopped, or played out

// Music: streamed, not decoded. Singletons, addressed by name.
await audio.defineTracks({
    menu: { src: ['/menu.mp3'],  bus: 'music', loop: true },
    boss: { src: ['/boss.mp3'],  bus: 'music', loop: true, loopStart: 8, loopEnd: 96 },
});

audio.playTrack('menu', { fadeIn: 600 });
audio.crossfade('menu', 'boss', 800);     // equal-power, both sides, no power dip
audio.trackPosition('boss');              // ReadSignal<number>, throttled to 10 Hz

// Reactive state - subscribe with lite-signal's effect() for UI hookup.
audio.unlocked();                         // ReadSignal<boolean>
audio.loadState('laser');                 // ReadSignal<'idle'|'loading'|'ready'|'error'>
audio.busVolume('sfx');                   // ReadSignal<number>

audio.setBusVolume('sfx', 0.5);           // schedules setTargetAtTime, click-free
audio.setMuted(true);                     // master mute, persists to localStorage

audio.stopAll();                          // every voice AND every track
audio.destroy();                          // idempotent, disconnects the graph
```

## Handles

`play()` returns a **bus-tagged** handle: `busIndex * 2^32 + poolHandle`. Treat it
as opaque — get it from `play()`, pass it to `stop()` / `isPlaying()`.

The tag is not decoration. A pool handle is a full `uint32` — `[gen:24][channel:8]`,
no spare bits — and every bus runs its own `AudioPool` counting channels and
generations from zero. So the first play on *every* bus hands back the identical
raw handle, `0x00000000`. Without the tag, `stop()` on an `sfx` handle also killed
whatever sat on channel 0 of `ui`, `voice`, and `music`. The generation counter
cannot prevent that: it is a recycle counter, not a namespace. With the tag,
`stop()` resolves the owning pool in O(1) and cannot cross a bus boundary.

Handles stay plain numbers, exact well inside `2^53`, so `-1` still means "no voice"
(unknown sound, not loaded, or context locked). `playUnique()` on a *track* returns
`-2`: tracks are name-addressed singletons with no handle, and `0` was never
available as a "nothing" value — it is a real voice.

### The four encodings

One `number`, four kinds of value. Typed as `VoiceHandle | Skipped | TrackStarted`
in the `.d.ts` — `VoiceHandle` is a *branded* number, so a raw integer or a track
name cannot be handed to `stop()` by mistake.

| Value                      | Meaning                                          | `stop()` acts on it? |
| -------------------------- | ------------------------------------------------ | -------------------- |
| `0`                        | a **real** handle — bus 0, channel 0, generation 0 | yes                |
| `busIndex * 2^32 + pool`   | every other real handle                          | yes                  |
| `-1` (`Skipped`)           | nothing played — unknown/not-ready sound, locked context (queued), or throttled `playUnique()` | no |
| `-2` (`TrackStarted`)      | `playUnique()` started a music **track**         | no                   |

Because `0` is real, "nothing happened" is only ever a **negative**, and negatives
are inert to `stop()` by construction — a `play()` or `playUnique()` result is safe
to pass straight to `stop()` without a guard.

### Layout and limits

- **Bit layout.** Pool handle `[gen:24][channel:8]` (`((gen << 8) | channel) >>> 0`);
  engine handle `busIndex * 2^32 + poolHandle`. Decode with `(h / 2^32) | 0` and
  `h >>> 0`.
- **Bus ceiling: `2^21`.** The low half is a full `uint32`, so a handle is an exact
  integer only while `busIndex ≤ 2^21 - 1` — index `2^21` itself already overflows
  `2^53`. `init()` throws a `RangeError` above `2^21` user buses instead of issuing
  colliding handles (`'master'` is implicit and doesn't count).
- **SMI range.** A handle leaves V8's small-integer range on any bus `≥ 1`, and on
  bus 0 once a channel's generation passes `8,388,608` (~hours of continuous
  stealing on one channel). The boxed-double cost is below the zero-GC gate's
  resolution — measured in [`decisions/0001`](decisions/0001-handle-namespace.md).
  The generation counter **wraps** at `2^24` rather than retiring the channel, a
  deliberate divergence from lite-arena documented in
  [`decisions/0002`](decisions/0002-generation-wrap.md).

## Why not Howler?

Howler.js is a good general-purpose audio library. It handles decoding, HTML5
Audio fallback for browsers that predate reliable Web Audio, format detection
across MP3/OGG/WAV/M4A, streaming, spatial audio, and a lot more. If you are
shipping cross-platform audio to a broad web audience without wanting to think
about any of that, use Howler.

lite-audio deliberately does not do most of those things. It targets the narrow
slice where the ecosystem has moved on:

- **Web Audio is universal.** Every browser we care about (2018+) has decode +
  scheduling. HTML5 Audio fallback is dead weight for a modern game.
- **Signals over events.** Continuous state — bus volumes, mute, load status,
  context state — belongs in a reactive graph, not a bag of event listeners.
  `effect(() => busGain.setTargetAtTime(...))` is one line; the equivalent
  Howler pattern is a handful of `on('volumechange')` handlers plus manual
  ramps.
- **Handles that survive stealing.** Voice-stealing is the norm in games. The
  underlying `AudioPool` returns generation-stamped handles; a `stop(handle)`
  after the channel has been stolen is a silent no-op instead of a wrong-voice
  hit. Howler has no direct equivalent — `Howl.stop(id)` on an id that has
  been reused is a real bug we ran into.
- **Zero-GC hot path.** No per-play closure, no options-object allocation on
  the positional `play(id, vol, pan, pitch)` path. The pool underneath has
  been benchmarked to ~14M plays/sec with ~0 B retained per play.

lite-audio is ~7.5 KB minified against Howler's ~35 KB. That size difference is
real budget you get back for shaders, netcode, or another 100 sounds.

## Architecture in one paragraph

**Signals are the control surface; AudioParams are the sink.** Continuous state
(bus volumes, mute, per-sound load state, ctx state) lives in `lite-signal`
signals. One `effect()` per bus writes the effective target through
`setTargetAtTime(target, ctx.currentTime, 0.01)` — click-free by construction.
One-shot triggers (`play`) stay imperative — a sound firing is an event, not
state. Voices come from a per-bus `AudioPool`, addressed by
bus-tagged handles (`busIndex * 2^32 | (gen << 8) | channel`); a stale
`stop(handle)` after a steal is a silent no-op. Unlock is ported from
`lite-audio-manager` verbatim (silent-buffer pulse + `resume()` + capture-phase
listeners behind an `AbortController`), plus a bounded pre-unlock play queue
so a call fired before the first user gesture does not vanish.

## Music layer

SFX are decoded into memory and fired through a pool; a five-minute track would be
~50 MB of PCM for that privilege. Tracks are streamed instead —
`MediaElementAudioSourceNode` over an `<audio>` element — and routed into the *same*
bus graph, so one master mute and one set of faders govern both.

Each track is a singleton addressed by name, with its own two-gain chain:

```
<audio> -> MediaElementSource -> xfadeGain -> volumeGain -> bus.gain -> master
```

`xfadeGain` carries crossfade curves (0..1); `volumeGain` carries the track's
baseline volume. They are separate on purpose: a crossfade must not clobber the
mix, and changing the mix mid-crossfade must not fight the curve.

| Call | Does |
| --- | --- |
| `playTrack(name, { fadeIn?, position?, restart? })` | Start or restart. Idempotent. No-op while locked — music is scene-scale, so it is *not* queued the way SFX are. |
| `stopTrack(name, { fade? })` | Equal-power fade out, then pause the element so the browser stops decoding. `playing` flips to `false` at once; the tail is an audio detail, not a state a HUD should show. |
| `pauseTrack(name)` / `resumeTrack(name)` | Pause without losing position. `resumeTrack()` also restores a gain that an earlier `stopTrack()` faded away — otherwise it would decode, report itself playing, and be inaudible. |
| `crossfade(from, to, ms)` | Equal-power both sides. Either side may be `null`. A retarget mid-fade starts from where the gain actually is, so there is no discontinuity. |
| `playExclusive(name, { fade? })` | Start `name`, fade every other playing track **on the same bus**. Other buses are untouched. |
| `stopBus(name, { fade? })` / `stopAll({ fade? })` | Stop the pool voices *and* fade the tracks routed there. Once music lives on a bus, "stop the bus" has to mean the bus. |

Loop points: `loop: true` alone uses the native `element.loop`. Add `loopEnd` and the
engine takes over — `timeupdate` seeks back to `loopStart` on crossing it, and the
native loop is switched off (it would jump to `0`, not to `loopStart`). Note that
`timeupdate` fires roughly four times a second, so a custom loop can overshoot by up
to ~250 ms. For a tight musical loop, prefer an asset whose file boundaries *are* the
loop.

## Mix intelligence (v1.2.0)

Four features, one architectural idea: **none of them fight the volume/mute effect
for the bus gain param.** A second gain node is spliced under every bus —

```
pool / track -> gain (volume + mute) -> duckGain (sidechain) -> master
```

— and ducking and snapshot morphs live on `duckGain`, so they *compose* with volume
and mute (the graph multiplies them) instead of two automations clobbering one
`AudioParam`. Meters, the duck follower, and auto-suspend share a single cold
~10 Hz monitor that never touches `play()`/`stop()`. The monitor tick is proven to
hold zero retained allocation with all four features live (`npm run gate`).

### Ducking

```js
audio.duck('music', 0.3, { attack: 0.05, release: 0.4 });  // dip to 30%
audio.stopDuck('music');                                    // recover

// or automatic: while >= 2 SFX voices sound, dip music
audio.duckOn('sfx', 'music', { threshold: 2, level: 0.3 });
```

`setTargetAtTime` is the engine's bus-write primitive and is exactly right here —
an exponential approach with a time constant *is* a compressor release. Attack and
release are **separate** because a symmetric duck sounds wrong: music should get out
of the way fast and return slowly. An explicit `duck()` always wins over the
follower (it latches the bus until `stopDuck()`). See `decisions/0003-ducking.md`.

### Mix snapshots

```js
audio.captureSnapshot('gameplay');
// ... later, on pause ...
audio.applySnapshot('paused', 400);   // morph over 400 ms
```

Capture records every bus's volume and mute (not track volumes — a snapshot is the
*desk*). Apply sets the signals to the target immediately, so every readout is
instantly truthful, and carries the `ms`-long audible transition on the sidechain,
continuous from the **actual current level** — so a snapshot applied mid-morph, or
mid-duck, is click-free. See `decisions/0004-snapshots.md`.

### Per-bus meters + dynamic buses

```js
audio.createBus('ambient', { meter: true });
const level = audio.level('ambient');   // ReadSignal<number>, RMS at ~10 Hz
```

`createBus()` adds a bus after `init()` (idempotent, rejects `'master'`). The 2^21
handle ceiling is re-checked at runtime, so a bus created past it fails closed with
a `RangeError` rather than issuing colliding handles. `{ meter: true }` taps an
`AnalyserNode` post-duck and reads RMS into **one** pre-allocated `Float32Array` per
bus — zero allocation per read. An unmetered bus allocates no analyser and
`level()` returns `null`. See `decisions/0006-dynamic-bus.md`.

### Auto-suspend

```js
if (audio.enableAutoSuspend({ after: 20 })) { /* armed (false on iOS) */ }
```

After N silent seconds the context is suspended to stop the hardware spinning; the
next `play()` wakes it. The wake is one monomorphic branch that fires a bare
`resume()` and lets the native scheduler hold the triggering voice against the
frozen clock — no await, no microtask, no allocation. **Off by default, and refused
on iOS**, where a suspend→resume can demand a fresh gesture and silently un-unlock a
working page. See `decisions/0005-auto-suspend.md`.

## Signal readouts (the whole reactive surface)

| Signal | Read via | Notes |
| --- | --- | --- |
| Context state | `audio.ctxState()` | `'suspended' \| 'running' \| 'interrupted' \| 'closed'` |
| Unlock status | `audio.unlocked()` | `true` once the first gesture succeeded |
| Master mute | `audio.muted()` | Persisted to `localStorage['lite_audio_muted']` |
| Bus volume | `audio.busVolume(name)` | 0..1 (or higher; not clamped) |
| Bus mute | `audio.busMuted(name)` | Independent of master mute |
| Load state | `audio.loadState(id)` | `'idle' \| 'loading' \| 'ready' \| 'error'` |
| Track load state | `audio.trackLoadState(name)` | Same four states |
| Track playing | `audio.trackPlaying(name)` | Flips `false` the instant a stop is *asked for*, not when the fade ends |
| Track position | `audio.trackPosition(name)` | Seconds, written at most every 100 ms |
| Track duration | `audio.trackDuration(name)` | `0` until `loadedmetadata` lands |

All readable via `signal()` (calling), `signal.peek()` (untracked read), or
inside a `computed()` / `effect()`.

## Options reference

```js
new LiteAudio({
    buses:            ['sfx', 'ui', 'voice', 'music'],  // user-facing buses
    poolCapacity:     32,                        // voices per bus pool
    queueLimit:       32,                        // bound on pre-unlock queue
    mutedStorageKey:  'lite_audio_muted',        // manager parity default
    fetch:            globalThis.fetch,          // injectable for tests
    window:           globalThis.window,         // ditto
    document:         globalThis.document,       // ditto
    setTimeout:       globalThis.setTimeout,     // ditto (deferred track pause)
    clearTimeout:     globalThis.clearTimeout,   // ditto
});
```

## Migration from lite-audio-manager

The persistence key (`lite_audio_muted`), unlock event set (`touchstart`,
`touchend`, `mousedown`, `keydown`), capture-phase attachment, and silent-buffer
unlock pulse are byte-identical to the manager. A migration should keep the
player's saved mute preference intact on first launch.

### The one-import swap (v2.0.0)

```diff
- import { audioManager } from 'lite-audio-manager';
+ import { audioManager } from '@zakkster/lite-audio/compat';
```

`./compat` exports an `AudioManager`-shaped adapter over `LiteAudio` — same
`init`/`play`/`playExclusive`/`playUnique`/`stop`/`stopCategory`/`setMuted`/
`destroy` surface, same `isMuted`/`isUnlocked`, same `'mutechange'` event, same
`lite_audio_muted` key. No Howler underneath: the swap *removes* a runtime
dependency. Every manager member is mapped to its lite-audio path and a test id
in [`PARITY.md`](PARITY.md); the deliberate divergences (a migrant's looping/
`html5` sounds become real streamed tracks; categories become buses; pre-unlock
plays are kept and queued rather than dropped) are documented and tested, with
the reasoning in [`decisions/0007-compat-shim.md`](decisions/0007-compat-shim.md).
Full migration guide: [`MIGRATION.md`](MIGRATION.md).

## Testing

```bash
npm test
```

153 tests across 43 suites. The unlock state machine (including `'interrupted'`),
loader fallback + error, bus writes as `setTargetAtTime`, pool delegation (steal,
generation no-op on stale handles, bus scope), unlock queue semantics
(latest-per-sound, bounded), destroy idempotency — plus the whole music layer
(`test/Tracks.test.js`), the bus-handle namespace (`test/BusHandles.test.js`), the
handle contract (`test/Handles.test.js`): every encoding pinned by name, including
`stop(0)` reaching the real bus-0 voice, `stop(-2)` staying inert, the real engine
leaving SMI range past generation 8,388,608, and the `2^21` bus ceiling failing
closed — and the mix-intelligence suite (`test/MixIntelligence.test.js`): the duck
curve on the mock clock (attack ≠ release, edge-only, explicit-wins), snapshot
round-trip and sidechain-morph continuity, meter RMS and buffer reuse, the
auto-suspend cycle with its play()-wake and iOS refusal, and the runtime bus
ceiling.

Hot paths are locked by `test/HashParity.test.js`, which hashes the source of
`play()`, `stop()`, and the per-bus write effect against goldens: `stop()` is
byte-identical back to 1.0.0, and any change to the other two must be a deliberate,
CHANGELOG-noted re-baseline rather than an accident.

### Zero-GC gate

```bash
node --expose-gc test/torture.mjs
```

Measures the handle return on bus `≥ 1` and past generation `8,388,608` — the
cases where it leaves SMI range and where the old bus-0/low-gen gate was blind —
reports `bytesPerOp` per regime, and (v1.2.0) adds a second phase that builds a
**live engine with all four mix features active** and measures the shared monitor
tick — 0 bytes/op retained. It is **falsifiable**:

```bash
LITEAUDIO_TORTURE_LEAK=1 node --expose-gc test/torture.mjs   # exits non-zero
```

routes the gated path through the rejected `{bus,handle}`-object design so a pass
means the gate can actually see allocation.

The mock harness (`test/mock-ctx.js`) records every `AudioParam` scheduled event
into an inspectable `.events` array **and settles `.value` on whatever the
automation is heading for**. That second half matters more than it sounds: a
harness that only records schedules can prove a fade-out was *scheduled* while
saying nothing about whether the gain ended up silent — and "scheduled a fade-out"
plus "still audible" is exactly the shape of a real bug this suite now catches. It
also runs a real context state machine (all four states), mocks `fetch` +
`decodeAudioData` with length-hint payloads, and hands out `<audio>` elements and
a manual timer scheduler so the deferred pause behind a track fade is an assertion
rather than a race.

Not covered, and honestly so: `pickSupportedSrc()` probes the real `document` /
`Audio` globals rather than the injected ones, so under `node:test` it always takes
the "first URL wins" branch. The `canPlayType` path is unexercised.

## License

MIT. Copyright Zahary Shinikchiev.
