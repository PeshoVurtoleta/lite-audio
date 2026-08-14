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

> Zero-GC reactive Web Audio engine. Signal-driven buses, ABA-safe voice handles, an unlock queue, one AudioPool per bus, streaming music with equal-power crossfade, mix intelligence (ducking, snapshots, meters), and a full spatial suite -- positional, HRTF, a mono-safe Haas widener, and discrete 7+1 / 5+1 / 3+1 surround with fail-closed output-layout detection. Built for games and long-running interactive tools where a garbage-collector pause is a dropped frame.

## The spatial audio engine the ecosystem was missing

Every browser since 2018 ships the whole Web Audio surface -- PannerNodes, HRTF
convolution, multichannel destinations -- yet the popular wrappers still treat
audio as fire-and-forget events over a decoder shim. lite-audio wires that
platform directly: continuous state (bus volumes, mute, load status, context
state, 3D position) lives in a `lite-signal` reactive graph; one-shot triggers
stay imperative; and every per-frame path -- `play()`, `setPosition()`,
`setWidth()`, `stop()` -- allocates zero bytes, proven by a red-controlled
torture gate. No Howler, no HTML5 Audio fallback, no MP3 shim.

```bash
npm i @zakkster/lite-audio @zakkster/lite-signal @zakkster/lite-audio-pool
```

```js
import { LiteAudio } from '@zakkster/lite-audio';

const audio = new LiteAudio({ buses: ['sfx'] });
await audio.init();

audio.createBus('world', { spatial: 'positional' });  // PannerNode per voice
await audio.defineSounds({ step: { src: ['/step.wav'], bus: 'world' } });

const h = audio.play('step', 1, 0, 1);                // zero-alloc hot path
audio.setPosition(h, 3, 0, -2);                       // caller-frame safe every frame
```

Zero-GC reactive Web Audio engine. Signal-driven buses, ABA-safe voice handles,
unlock queue, one `AudioPool` per bus. The SFX layer of a growing audio stack
that eventually deprecates the Howler wrapper it replaces.

- Zero deps of its own; two peers: `@zakkster/lite-signal` and
  `@zakkster/lite-audio-pool`
- ~7.5 KB minified, ~2.7 KB gzipped
- No Howler, no HTML5 Audio fallback, no MP3 decoder shim -- just the Web Audio
  API surface the modern web has had since 2018, wired precisely
- Ports the iOS/mobile unlock semantics of `lite-audio-manager` verbatim, plus a
  bounded pre-unlock play queue the manager could not offer from Howler's outside

**Status:** v1.0.0 covers SFX; v1.1.0 added the music streaming layer
(`MediaElementAudioSourceNode`, crossfades, exclusive/unique); v1.2.0 added mix
intelligence -- ducking, snapshots, auto-suspend, per-bus meters, dynamic buses;
**v2.0.0 ships the `./compat` drop-in** for `lite-audio-manager` with full parity
certification. Migrate off the Howler overlay by changing one import. The spatial
suite lands across v2.1.0 (positional) -> v2.2.0 (HRTF) -> v2.3.0 (Haas width) ->
v2.4.0 (7+1 discrete + layout detection) -> v2.5.0 (5+1 / 3+1 subsets).

## Table of contents

- [Install](#install)
- [Quick start](#quick-start)
- [Why this exists](#why-this-exists)
- [What you get](#what-you-get)
- [Handles](#handles)
- [Why not Howler?](#why-not-howler)
- [Architecture in one paragraph](#architecture-in-one-paragraph)
- [Music layer](#music-layer)
- [Mix intelligence](#mix-intelligence-v120)
- [Spatial buses: positional and HRTF](#spatial-buses-positional-and-hrtf)
- [Stereo width (the Haas widener)](#stereo-width-the-haas-widener)
- [Discrete surround](#discrete-surround-71--51--31-and-output-layout-detection-v240-subsets-v250)
- [Signal readouts](#signal-readouts-the-whole-reactive-surface)
- [Composability](#composability)
- [Options reference](#options-reference)
- [Constants](#constants)
- [Migration from lite-audio-manager](#migration-from-lite-audio-manager)
- [Testing](#testing)
- [Zero-GC design notes](#zero-gc-design-notes)
- [Design decisions worth knowing](#design-decisions-worth-knowing)
- [What this is not](#what-this-is-not)
- [Ecosystem](#ecosystem)
- [License](#license)

## Why this exists

Voice-stealing is the norm in a game, continuous mix state does not belong in an
event bag, and a garbage-collector pause during a firefight is a dropped frame.
lite-audio answers all three: bus-tagged generation-stamped handles make a stale
`stop()` a silent no-op instead of a wrong-voice hit; a `lite-signal` reactive
graph carries every continuous control value; and every per-frame path allocates
zero bytes, held to that budget by a falsifiable torture gate. It is the audio
engine for the slice of the web that has moved on from the decoder-shim era.

## What you get

- **SFX** through one `AudioPool` per bus, fired by a zero-alloc
  `play(id, vol, pan, pitch)` hot path returning a bus-tagged ABA-safe handle.
- **Music** streamed via `MediaElementAudioSourceNode`, name-addressed, with
  equal-power crossfade, exclusive/unique playback, and custom loop points.
- **Mix intelligence** -- ducking (separate attack/release), morphing snapshots,
  per-bus RMS meters, dynamic buses, iOS-safe auto-suspend -- all on a sidechain
  gain so nothing fights the volume/mute automation for one param.
- **Spatial** -- `positional` PannerNodes, `hrtf` binaural convolution, a
  mono-safe `width` Haas widener, and `discrete` 7+1 / 5+1 / 3+1 VBAP surround
  with fail-closed output-layout detection -- all driven by one `setPosition()`.
- **iOS/mobile unlock** ported verbatim from `lite-audio-manager`, plus a bounded
  pre-unlock play queue the Howler-based manager could not offer.
- **A `./compat` drop-in** so a `lite-audio-manager` app migrates by one import.

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
as opaque -- get it from `play()`, pass it to `stop()` / `isPlaying()`.

The tag is not decoration. A pool handle is a full `uint32` -- `[gen:24][channel:8]`,
no spare bits -- and every bus runs its own `AudioPool` counting channels and
generations from zero. So the first play on *every* bus hands back the identical
raw handle, `0x00000000`. Without the tag, `stop()` on an `sfx` handle also killed
whatever sat on channel 0 of `ui`, `voice`, and `music`. The generation counter
cannot prevent that: it is a recycle counter, not a namespace. With the tag,
`stop()` resolves the owning pool in O(1) and cannot cross a bus boundary.

Handles stay plain numbers, exact well inside `2^53`, so `-1` still means "no voice"
(unknown sound, not loaded, or context locked). `playUnique()` on a *track* returns
`-2`: tracks are name-addressed singletons with no handle, and `0` was never
available as a "nothing" value -- it is a real voice.

### The four encodings

One `number`, four kinds of value. Typed as `VoiceHandle | Skipped | TrackStarted`
in the `.d.ts` -- `VoiceHandle` is a *branded* number, so a raw integer or a track
name cannot be handed to `stop()` by mistake.

| Value                      | Meaning                                          | `stop()` acts on it? |
| -------------------------- | ------------------------------------------------ | -------------------- |
| `0`                        | a **real** handle -- bus 0, channel 0, generation 0 | yes                |
| `busIndex * 2^32 + pool`   | every other real handle                          | yes                  |
| `-1` (`Skipped`)           | nothing played -- unknown/not-ready sound, locked context (queued), or throttled `playUnique()` | no |
| `-2` (`TrackStarted`)      | `playUnique()` started a music **track**         | no                   |

Because `0` is real, "nothing happened" is only ever a **negative**, and negatives
are inert to `stop()` by construction -- a `play()` or `playUnique()` result is safe
to pass straight to `stop()` without a guard.

### Layout and limits

- **Bit layout.** Pool handle `[gen:24][channel:8]` (`((gen << 8) | channel) >>> 0`);
  engine handle `busIndex * 2^32 + poolHandle`. Decode with `(h / 2^32) | 0` and
  `h >>> 0`.
- **Bus ceiling: `2^21`.** The low half is a full `uint32`, so a handle is an exact
  integer only while `busIndex <= 2^21 - 1` -- index `2^21` itself already overflows
  `2^53`. `init()` throws a `RangeError` above `2^21` user buses instead of issuing
  colliding handles (`'master'` is implicit and doesn't count).
- **SMI range.** A handle leaves V8's small-integer range on any bus `>= 1`, and on
  bus 0 once a channel's generation passes `8,388,608` (~hours of continuous
  stealing on one channel). The boxed-double cost is below the zero-GC gate's
  resolution -- measured in [`decisions/0001`](decisions/0001-handle-namespace.md).
  The generation counter **wraps** at `2^24` rather than retiring the channel, a
  deliberate divergence from lite-arena documented in
  [`decisions/0002`](decisions/0002-generation-wrap.md).

<details>
<summary>Deep dive: how a voice handle is built and resolved.</summary>

A handle is a single `number` carrying three coordinates -- which bus, which
channel, which generation -- so `stop()` can name exactly one voice with no map
lookup on the caller frame and no chance of a cross-bus hit.

**Packing.** Each bus runs its own `AudioPool`. The pool packs a channel and a
generation counter into a `uint32`:

```
poolHandle = ((gen << 8) | channel) >>> 0     // [gen:24][channel:8]
```

The engine then tags that with the bus index in the high half:

```
handle = busIndex * 2^32 + poolHandle          // [busIndex:*][gen:24][channel:8]
```

**Resolving.** `stop(handle)` / `isPlaying(handle)` decode without allocating:

```
busIndex   = (handle / 2^32) | 0
poolHandle = handle >>> 0
```

`busIndex` selects the pool in O(1); the pool checks the `gen` in the low half
against the channel's live generation.

**Steal-safety.** When a channel is stolen (a new voice reuses it), the pool
bumps that channel's generation. An old handle still names the same channel but
carries the stale `gen`, so the pool's generation check fails and `stop()` on it
is a silent no-op instead of cutting the new voice. The generation counter is a
recycle stamp, not a namespace -- which is exactly why the bus tag is needed: it
is what stops an `sfx` channel-0 handle from reaching `ui`/`voice`/`music`
channel 0, since every pool independently starts at channel 0 / gen 0.

**The two ceilings.** The `channel` field is the low 8 bits, so a pool addresses
at most **256 channels** -- `poolCapacity` is guarded to `1..256` at
construction (a `257` would wrap channel `256` onto channel `0` and overwrite its
scratch). The bus tag lives above `2^32`, and a handle is an exact integer only
while `busIndex <= 2^21 - 1`, so `MAX_BUSES` is `2^21`. Both are fail-closed
throws, never silent wraps. Full rationale in
[`decisions/0001`](decisions/0001-handle-namespace.md) and
[`decisions/0002`](decisions/0002-generation-wrap.md).

</details>

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
- **Signals over events.** Continuous state -- bus volumes, mute, load status,
  context state -- belongs in a reactive graph, not a bag of event listeners.
  `effect(() => busGain.setTargetAtTime(...))` is one line; the equivalent
  Howler pattern is a handful of `on('volumechange')` handlers plus manual
  ramps.
- **Handles that survive stealing.** Voice-stealing is the norm in games. The
  underlying `AudioPool` returns generation-stamped handles; a `stop(handle)`
  after the channel has been stolen is a silent no-op instead of a wrong-voice
  hit. Howler has no direct equivalent -- `Howl.stop(id)` on an id that has
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
`setTargetAtTime(target, ctx.currentTime, 0.01)` -- click-free by construction.
One-shot triggers (`play`) stay imperative -- a sound firing is an event, not
state. Voices come from a per-bus `AudioPool`, addressed by
bus-tagged handles (`busIndex * 2^32 | (gen << 8) | channel`); a stale
`stop(handle)` after a steal is a silent no-op. Unlock is ported from
`lite-audio-manager` verbatim (silent-buffer pulse + `resume()` + capture-phase
listeners behind an `AbortController`), plus a bounded pre-unlock play queue
so a call fired before the first user gesture does not vanish.

## Music layer

SFX are decoded into memory and fired through a pool; a five-minute track would be
~50 MB of PCM for that privilege. Tracks are streamed instead --
`MediaElementAudioSourceNode` over an `<audio>` element -- and routed into the *same*
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
| `playTrack(name, { fadeIn?, position?, restart? })` | Start or restart. Idempotent. No-op while locked -- music is scene-scale, so it is *not* queued the way SFX are. |
| `stopTrack(name, { fade? })` | Equal-power fade out, then pause the element so the browser stops decoding. `playing` flips to `false` at once; the tail is an audio detail, not a state a HUD should show. |
| `pauseTrack(name)` / `resumeTrack(name)` | Pause without losing position. `resumeTrack()` also restores a gain that an earlier `stopTrack()` faded away -- otherwise it would decode, report itself playing, and be inaudible. |
| `crossfade(from, to, ms)` | Equal-power both sides. Either side may be `null`. A retarget mid-fade starts from where the gain actually is, so there is no discontinuity. |
| `playExclusive(name, { fade? })` | Start `name`, fade every other playing track **on the same bus**. Other buses are untouched. |
| `stopBus(name, { fade? })` / `stopAll({ fade? })` | Stop the pool voices *and* fade the tracks routed there. Once music lives on a bus, "stop the bus" has to mean the bus. |

Loop points: `loop: true` alone uses the native `element.loop`. Add `loopEnd` and the
engine takes over -- `timeupdate` seeks back to `loopStart` on crossing it, and the
native loop is switched off (it would jump to `0`, not to `loopStart`). Note that
`timeupdate` fires roughly four times a second, so a custom loop can overshoot by up
to ~250 ms. For a tight musical loop, prefer an asset whose file boundaries *are* the
loop.

## Mix intelligence (v1.2.0)

Four features, one architectural idea: **none of them fight the volume/mute effect
for the bus gain param.** A second gain node is spliced under every bus --

```
pool / track -> gain (volume + mute) -> duckGain (sidechain) -> master
```

-- and ducking and snapshot morphs live on `duckGain`, so they *compose* with volume
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

`setTargetAtTime` is the engine's bus-write primitive and is exactly right here --
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

Capture records every bus's volume and mute (not track volumes -- a snapshot is the
*desk*). Apply sets the signals to the target immediately, so every readout is
instantly truthful, and carries the `ms`-long audible transition on the sidechain,
continuous from the **actual current level** -- so a snapshot applied mid-morph, or
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
bus -- zero allocation per read. An unmetered bus allocates no analyser and
`level()` returns `null`. See `decisions/0006-dynamic-bus.md`.

`destroyBus(name)` tears one dynamic bus down without disturbing any other bus's
live handles -- for apps that churn buses across scenes or routes:

```js
audio.createBus('scene1', { spatial: 'positional' });
// ... scene runs ...
audio.destroyBus('scene1');   // -> true; stops voices, frees pool + graph + signals
audio.destroyBus('scene1');   // -> false (idempotent: already gone)
```

It returns `true` when a live dynamic bus was destroyed, `false` for an unknown or
already-destroyed bus. It throws on `'master'` or a **static** bus (one from
`opts.buses`) -- those are structural topology, not per-scene resources. A handle
from a destroyed bus goes inert (`stop()` / `setPosition()` no-op, `isPlaying()`
false) because the bus record is hollowed into a husk that every hot path already
fail-closes on. The `_busList` slot is kept as a tombstone and never reused (a
voice handle decodes its bus by array index, so the array must never shift), which
counts against the 2^21 ceiling; `destroyBus` of a discrete bus does not shrink
`destination.channelCount`. See `decisions/0010-bus-tombstone.md`.

### Spatial buses: positional and HRTF

```js
audio.createBus('world', { spatial: 'positional' });  // PannerNode per voice
audio.createBus('binaural', { spatial: 'hrtf' });      // + panningModel 'HRTF'
const h = audio.play('footstep');
audio.setPosition(h, x, y, z);   // caller-frame safe; writes ride the ~10 Hz monitor
```

`{ spatial: 'positional' }` builds a `PannerNode` per voice and enables
`setPosition(handle, x, y, z)` -- a caller-frame method that only stamps a
pre-allocated scratch buffer (the actual `positionX/Y/Z` writes ride the cold
`~10 Hz` monitor). `{ spatial: 'hrtf' }` is the same distance graph but the pool
sets `panningModel = 'HRTF'` for per-voice binaural convolution. It is
**headphones-only** -- a stereo speaker layout hears no benefit and still pays the
per-voice HRTF convolution CPU -- and an `'hrtf'` bus fires one silent `gain=0`
**HRIR prewarm** voice post-unlock so the browser loads its impulse-response set
before the first real play does, eating the first-play hitch. lite-audio never
sets `panningModel` itself; the pool owns its spatial nodes (`^1.4.0`). Default
stays `'stereo'` (a `StereoPanner` per voice), byte-identical to prior releases.

> [!CAUTION]
> **HRTF is headphones-only and costs a convolution per live voice.**
> - **A stereo/speaker layout hears no benefit** from `panningModel = 'HRTF'` and
>   still pays the per-voice binaural convolution CPU. Reserve `'hrtf'` buses for a
>   headphone target; a `'positional'` bus is the right default elsewhere.
> - **Budget the voice count.** Each live HRTF voice runs its own HRIR
>   convolution -- a dozen simultaneous HRTF voices is a very different CPU load
>   from a dozen `StereoPanner` voices. The `gain=0` HRIR prewarm eats only the
>   first-play hitch, not the steady-state cost.
> - **Do not double-virtualize.** Stacking an engine-side `'hrtf'` bus on a headset
>   that already virtualizes surround smears the image. `spatial` is one field, so
>   `'hrtf'` and `'discrete'` cannot combine anyway.

### Stereo width (the Haas widener)

```js
audio.createBus('pad', { width: 0 });   // arm the widener, start bypassed
// ... a mono source loaded on 'pad' ...
audio.setWidth('pad', 0.8);             // open it up; writes ride the ~10 Hz monitor
audio.setWidth('pad', 0);               // bit-identical bypass
audio.widthOf('pad');                   // -> 0  (null on an unarmed/disarmed bus)
```

`{ width: 0..1 }` inserts a **mono-safe Haas widener** between the pool output and
the bus gain: the dry (mono) signal plus a delayed, opposite-panned wet pair
(`12 ms` hard-left, `19 ms` hard-right) summed back through an explicit makeup gain
of `1/sqrt(1 + 4*wet^2)`, so opening the width holds total power flat at `0 dB`
(**SP-05**) instead of getting louder as it gets wider. `setWidth(bus, w)` is a
caller-frame method -- like `setPosition()` it does no param write and allocates
nothing; it clamps to `[0, 1]`, stamps a target and a dirty bit, and the actual
`wet`/`makeup` writes ride the cold `~10 Hz` monitor (at most one event per param
per tick, only when the value moves). `width: 0` is a **bit-identical bypass**: a
few ticks after the last move to `0` the flush snaps `wet` to *exactly* `0` and
`makeup` to *exactly* `1` with `setValueAtTime`, because `setTargetAtTime` is
exponential and would otherwise leave a hair of wet signal forever.

There is deliberately **no boolean "on"** -- the only control is the `width: 0..1`
knob (`0` is off), so "wide" is always a value you can automate, never a hidden
mode. Omit `width` entirely and the bus is byte-identical to prior releases (no
widener nodes, no new hot-path branch).

> [!CAUTION]
> **The widener is mono-source only, and it is a comb filter on a mono speaker.**
> - **SP-04 (mono-downmix comb filtering).** A Haas pair is two short-delayed
>   copies of the same signal. On a *single-speaker or mono* playback path they sum
>   back together and the delays become notches -- audible comb filtering. That is
>   lite-audio's core mobile / single-speaker audience, so budget the widener for
>   headphone / true-stereo output and leave it at `width: 0` when you cannot tell.
> - **SP-06 (stereo-image collapse).** The effect *synthesises* a stereo image from
>   a mono source. Feed it a stereo asset and the channels fold and smear, so a
>   non-mono loaded buffer **disarms** the widener at pool build (`widthRefused =
>   'stereo-source'`, `setWidth()` becomes a no-op, warned once). And because the
>   widener is stereo-only, `width > 0` on a `positional` / `hrtf` bus is a
>   construction-time `RangeError` -- it does not compose with per-voice panning.

### Discrete surround (7+1 / 5+1 / 3+1) and output-layout detection (v2.4.0, subsets v2.5.0)

```js
audio.layoutOf();                                          // -> '7.1' | '5.1' | '3.1' | 'stereo'
audio.createBus('surround', { spatial: 'discrete', preset: '7.1' });   // or '5.1' / '3.1'
audio.effectiveLayoutOf('surround');                       // the BUILT layout after the ladder
// same setPosition() as positional/hrtf -- one zero-alloc scalar stamp:
const h = audio.play('explosion', 1, 0, 1);
audio.setPosition(h, x, y, z);                             // lane gains solved on the ~10 Hz monitor
```

At `init()` the engine resolves its output layout **once** from
`destination.maxChannelCount` -- the **richest single layout** the sink can carry,
fail-closed: any non-integer / `NaN` / `null` / absent reading is `'stereo'`,
never an optimistic upgrade.

| `destination.maxChannelCount` | `layoutOf()` | Why |
| ----------------------------- | ------------ | --- |
| `8`, `12`, any integer `>= 8` | `'7.1'`      | a full surround sink |
| `6` or `7`                    | `'5.1'`      | a 6-channel sink |
| `4` or `5`                    | `'3.1'`      | a 4-channel sink |
| `2`, any integer `< 4`        | `'stereo'`   | too few channels |
| `7.5` (non-integer)           | `'stereo'`   | not an integer channel count |
| `'8'` (string)                | `'stereo'`   | not a `number` |
| `undefined` / `null` / `NaN`  | `'stereo'`   | unverified -- fail closed |
| property absent / no `destination` | `'stereo'` | nothing to trust |

> [!NOTE]
> **v2.5.0 behavior change.** A real 4- or 6-channel sink that returned `'stereo'`
> under v2.4.0 now returns `'3.1'` / `'5.1'`. The two v2.4.0 tokens keep their
> meaning: `=== '7.1'` still holds only on a `>= 8` sink; the change is visible
> only to a `=== 'stereo'` caller on a real 4/6-channel sink. A 2-channel sink is
> unchanged (still `'stereo'`).

`{ spatial: 'discrete', preset }` builds a discrete bus on the pool's matching
`channels: 8 | 6 | 4` mode with per-voice **VBAP** panning driven by the same
`setPosition()`. The requested preset resolves down a cold **fallback ladder** to
the largest layout the sink actually fits -- `min(requested, sink)` stepped down
`7.1 -> 5.1 -> 3.1 -> stereo`. A request **never upgrades** (a `'5.1'` request on
an 8-channel sink stays `'5.1'`); it only steps down. `effectiveLayoutOf(name)`
returns the **built** token so you can see where it landed:

| requested \ sink | `>= 8` | `6`/`7` | `4`/`5` | `< 4` |
| ---------------- | ------ | ------- | ------- | ----- |
| `'7.1'`          | `7.1`  | `5.1`   | `3.1`   | `stereo` |
| `'5.1'`          | `5.1`  | `5.1`   | `3.1`   | `stereo` |
| `'3.1'`          | `3.1`  | `3.1`   | `3.1`   | `stereo` |

When even `3.1` does not fit (`< 4` channels, including a 2-channel headset) the
request transparently **falls back to a working stereo bus** (`lanes = 0`) that
plays normally, and `effectiveLayoutOf()` returns `'stereo'`. That fallback is
**correct, not a failure**. Each preset's SMPTE lanes (shared low indices; a
smaller preset drops the higher lanes):

| preset | lanes | ring |
| ------ | ----- | ---- |
| `'7.1'` | 8 | `L R C LFE SL SR SBL SBR` |
| `'5.1'` | 6 | `L R C LFE SL SR` (drop `SBL`/`SBR`) |
| `'3.1'` | 4 | `L R C LFE` (front-only, drop all surrounds) |

The lane gains are solved on the cold `~10 Hz` monitor by one **data-driven**
solver over a per-preset frozen ring record: `az = atan2(x, -z)` picks a
constant-power speaker pair on the ring (`g1 = cos(f*PI/2)`, `g2 = sin(f*PI/2)`),
the LFE lane (**index 3 in every preset**) gets an azimuth-invariant distance-only
send (never a pan gain), and `y` (height) is deliberately **not panned**. The
flush writes exactly `lanes` gains (8/6/4) with **no per-tick preset branch**, at
the same `20 ms` / `~10 Hz` `setTargetAtTime` cadence as position, into one reused
`Float32Array(8)` -- zero allocation.

> [!CAUTION]
> **The multichannel render needs a real `>= 4`/`>= 6`/`>= 8`-channel sink, and the destination mutation is process-global.**
> - **The audible surround is only reachable on a true multichannel sink.** A
>   virtual-surround headset that reports `maxChannelCount 2` (the common case) gets
>   the **stereo fallback** -- that is the shipped, correct behaviour there, not a
>   bug. Do **not** stack an engine-side `'hrtf'` bus on top of a headset that already
>   virtualizes; `'discrete'` and `'hrtf'` are one `spatial` field and cannot combine
>   anyway.
> - **`3.1` is front-only.** With no rear speakers, a source directly behind the
>   listener folds across the 300-degree back gap between `R` (30 degrees) and `L`
>   (330 degrees). Correct for a front-only rig, a documented limitation, not a bug.
> - **`destination.channelCount` is mutated once, process-wide.** It is set to the
>   **max lane count across live discrete buses** (`8`/`6`/`4`, monotonic) with
>   `'explicit'` / `'discrete'`; the pristine triple is saved on the first discrete
>   pool build and restored on `destroy()`. This changes downmix for the whole
>   context, so mixing a discrete bus with an assumed-stereo external graph on the
>   same `AudioContext` is unsupported. An engine with no discrete bus never touches
>   the destination.
> - **`preset` is discrete-only and does not compose with `width`.** A `preset` on a
>   non-discrete bus is a `RangeError`, an unknown preset is a `RangeError`, and
>   `width > 0` on a discrete bus is a `RangeError` (the stereo widener is
>   stereo-only).

### Auto-suspend

```js
if (audio.enableAutoSuspend({ after: 20 })) { /* armed (false on iOS) */ }
```

After N silent seconds the context is suspended to stop the hardware spinning; the
next `play()` wakes it. The wake is one monomorphic branch that fires a bare
`resume()` and lets the native scheduler hold the triggering voice against the
frozen clock -- no await, no microtask, no allocation. **Off by default, and refused
on iOS**, where a suspend->resume can demand a fresh gesture and silently un-unlock a
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

## Composability

The whole engine is one pipeline: construct with a bus list, `init()` the
context, add spatial buses, route sounds to them, then drive voices and the mix.
Every call below is the real signature -- SFX buses, a positional bus, an HRTF
bus, and a discrete-surround bus all coexist, all driven by the same
`play()` / `setPosition()` pair, with ducking and a snapshot morph layered on top.

```js
import { LiteAudio } from '@zakkster/lite-audio';

// 1. construct + unlock the context
const audio = new LiteAudio({ buses: ['sfx', 'music'] });
await audio.init();                                   // creates the AudioContext

// 2. add spatial buses (each returns its bus record; idempotent by name)
audio.createBus('world', { spatial: 'positional' });  // PannerNode per voice
audio.createBus('ears',  { spatial: 'hrtf' });        // + panningModel 'HRTF'
audio.createBus('surround', { spatial: 'discrete', preset: '7.1' }); // VBAP; ladder-fitted

// 3. define + route sounds AFTER their target bus exists
await audio.defineSounds({
    step:      { src: ['/step.wav'],      bus: 'world' },
    whisper:   { src: ['/whisper.opus'],  bus: 'ears' },
    explosion: { src: ['/boom.wav'],      bus: 'surround' },
});

// 4. play (zero-alloc hot path) and position (caller-frame safe every frame)
const h = audio.play('explosion', 1, 0, 1);           // -> bus-tagged handle, or -1
audio.setPosition(h, 8, 0, -3);                        // solved on the ~10 Hz monitor
console.log(audio.effectiveLayoutOf('surround'));      // '7.1' | '5.1' | '3.1' | 'stereo'

// 5. mix intelligence: dip music while SFX sound, then morph to a snapshot
audio.duckOn('sfx', 'music', { threshold: 2, level: 0.3 });
audio.captureSnapshot('combat');
audio.applySnapshot('combat', 400);                    // 400 ms sidechain morph

// 6. tear down: idempotent, disconnects the graph, restores the destination
audio.destroy();
```

## Options reference

```js
new LiteAudio({
    buses:            ['sfx', 'ui', 'voice', 'music'],  // user-facing buses
    poolCapacity:     32,                        // voices per bus pool; integer 1..256
    queueLimit:       32,                        // bound on pre-unlock queue
    mutedStorageKey:  'lite_audio_muted',        // manager parity default
    fetch:            globalThis.fetch,          // injectable for tests
    window:           globalThis.window,         // ditto
    document:         globalThis.document,       // ditto
    setTimeout:       globalThis.setTimeout,     // ditto (deferred track pause)
    clearTimeout:     globalThis.clearTimeout,   // ditto
});
```

Per-bus options are passed to `createBus(name, opts)` (and the constructor builds
its `buses` with the defaults):

```js
audio.createBus('pad', {
    meter:   false,       // tap an AnalyserNode for level() readouts
    spatial: 'stereo',    // 'stereo' | 'positional' | 'hrtf' | 'discrete' (per-voice pan mode)
    preset:  '7.1',       // discrete-only lane preset: '7.1' | '5.1' | '3.1' (ladder picks the fit)
    width:   0,           // 0..1 arms the mono-safe Haas widener; omit to leave mono
});
```

- `width` is **omit-to-disable**: leaving it out builds no widener nodes (byte-identical to prior releases); a number in `[0, 1]` arms it and enables `setWidth()`. A non-finite / boolean / out-of-range value, or `width > 0` on a `positional`/`hrtf`/`discrete` bus, is a construction-time `RangeError`. A non-mono loaded source disarms it (see the Stereo width caution above).
- `spatial: 'discrete'` builds a discrete surround bus in the pool's matching `channels: 8 | 6 | 4` mode; the requested `preset` (`'7.1'` | `'5.1'` | `'3.1'`) resolves down the fallback ladder to the largest layout the sink fits, and on a `< 4`-channel sink it falls back to a working stereo bus with `effectiveLayoutOf(name)` reporting `'stereo'` (correct, not a failure). A request never upgrades. `preset` is valid only with `spatial: 'discrete'` (a `RangeError` elsewhere); an unknown preset is a `RangeError`. See the Discrete surround section above.
- `poolCapacity` is an integer in `1..256`. A pool channel packs into the low 8 bits of a handle (`poolHandle & 0xFF`), so a capacity past `256` would wrap channel `256` onto channel `0`; a non-integer, `< 1`, or `> 256` value is a construction-time `RangeError` (fail closed, `Number.isInteger` rejects `NaN` first). See [`decisions/0001`](decisions/0001-handle-namespace.md).

## Constants

| Constant | Value | Meaning |
| -------- | ----- | ------- |
| `VERSION` | `'2.5.1'` | Package version, in lockstep with `package.json`. |
| `MAX_BUSES` | `2097152` (`2^21`) | Bus-index ceiling: a handle stays exact-integer only while `busIndex <= 2^21 - 1`. `init()` / `createBus()` throw past it. |
| `MAX_POOL_CAPACITY` | `256` | Pool-channel ceiling: a channel packs into the low 8 bits of a handle. The constructor throws past it. |
| Handle codec | `busIndex * 2^32 + ((gen << 8) \| channel)` | Bus tag in the high half, `[gen:24][channel:8]` pool handle in the low half. |
| `Skipped` | `-1` | `play()` / `playUnique()` did nothing; inert to `stop()`. |
| `TrackStarted` | `-2` | `playUnique()` started a name-addressed track; inert to `stop()`. |

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

`./compat` exports an `AudioManager`-shaped adapter over `LiteAudio` -- same
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

325 tests across 97 suites. The unlock state machine (including `'interrupted'`),
loader fallback + error, bus writes as `setTargetAtTime`, pool delegation (steal,
generation no-op on stale handles, bus scope), unlock queue semantics
(latest-per-sound, bounded), destroy idempotency -- plus the whole music layer
(`test/Tracks.test.js`), the bus-handle namespace (`test/BusHandles.test.js`), the
handle contract (`test/Handles.test.js`): every encoding pinned by name, including
`stop(0)` reaching the real bus-0 voice, `stop(-2)` staying inert, the real engine
leaving SMI range past generation 8,388,608, and the `2^21` bus ceiling failing
closed -- and the mix-intelligence suite (`test/MixIntelligence.test.js`): the duck
curve on the mock clock (attack != release, edge-only, explicit-wins), snapshot
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

Measures the handle return on bus `>= 1` and past generation `8,388,608` -- the
cases where it leaves SMI range and where the old bus-0/low-gen gate was blind --
reports `bytesPerOp` per regime, and (v1.2.0) adds a second phase that builds a
**live engine with all four mix features active** and measures the shared monitor
tick -- 0 bytes/op retained. It is **falsifiable**:

```bash
LITEAUDIO_TORTURE_LEAK=1 node --expose-gc test/torture.mjs   # exits non-zero
```

routes the gated path through the rejected `{bus,handle}`-object design so a pass
means the gate can actually see allocation.

The spatial roadmap adds dedicated tiers, each with a **proven red control** that
forces the failure it guards and makes the gate exit non-zero: `T-SP1` (setPosition
is a zero-alloc scratch stamp) / `T-SP2` (the `~10 Hz` position flush holds the
native param-event rate under a `200`/param/voice cap) / `T-SP3` (a lite-leak
witness proves `destroy()` releases the positional scratch across `200`
build/teardown cycles), the S4 `T-SP5` (every voice panner reports
`panningModel === 'HRTF'`; the `gain=0` HRIR prewarm retires with a zero live-node
delta; released clean across `200` cycles), and the S5 `T-SP6` (the width flush
holds the `wet`/`makeup` event rate under the same cap with identical-value writes
collapsing to exactly `1`; `setWidth` is `<= 4 B/op` with no major GC; `destroy()`
disconnects + nulls all `7` widener nodes across `200` cycles). Their red controls
are `LITEAUDIO_TORTURE_SP1_RED` / `SP2_RED` / `SP3_RED` / `SP5_RED`,
`SP6_RED` (a `60 Hz` per-frame direct param writer that blows the event cap), and
`SP6_ALLOC_RED` (a `setWidth` that boxes into a retained object) -- each exits
non-zero.

The mock harness (`test/mock-ctx.js`) records every `AudioParam` scheduled event
into an inspectable `.events` array **and settles `.value` on whatever the
automation is heading for**. That second half matters more than it sounds: a
harness that only records schedules can prove a fade-out was *scheduled* while
saying nothing about whether the gain ended up silent -- and "scheduled a fade-out"
plus "still audible" is exactly the shape of a real bug this suite now catches. It
also runs a real context state machine (all four states), mocks `fetch` +
`decodeAudioData` with length-hint payloads, and hands out `<audio>` elements and
a manual timer scheduler so the deferred pause behind a track fade is an assertion
rather than a race.

Not covered, and honestly so: `pickSupportedSrc()` probes the real `document` /
`Audio` globals rather than the injected ones, so under `node:test` it always takes
the "first URL wins" branch. The `canPlayType` path is unexercised.

## Zero-GC design notes

<details>
<summary>Where the bytes went, and why every hot path is 0 B/op.</summary>

The rule is simple and load-bearing: **no allocation on any path a caller can hit
per frame.** A hot path here means `play()`, `stop()`, `isPlaying()`,
`setPosition()`, `setWidth()`, and the shared `~10 Hz` monitor tick (meters, duck
follower, auto-suspend, position flush, lane flush, width flush). Each is held to
its budget by a torture tier with a proven red control that forces the failure it
guards.

| Path | Allocation | How |
| ---- | ---------- | --- |
| `play(id, vol, pan, pitch)` | 0 B (handle is a plain `number`) | four positional scalars, no options object, no per-play closure; the pool reuses a channel |
| `stop(handle)` / `isPlaying(handle)` | 0 B | decode the handle with `/ 2^32` and `>>> 0`, O(1) pool lookup |
| `setPosition(h, x, y, z)` | 0 B | stamps three floats into a pre-allocated scratch + a dirty bit; the `positionX/Y/Z` writes ride the cold monitor |
| `setWidth(bus, w)` | 0 B (`<= 4 B/op` gate) | clamps to `[0, 1]`, stamps a target + dirty bit; `wet`/`makeup` writes ride the monitor |
| lane solve (`_flushLanes`) | 0 B | data-driven VBAP walk into one reused `Float32Array(8)`, exactly `lanes` writes, no per-tick preset branch |
| monitor tick | 0 B retained | RMS reads into one pre-allocated `Float32Array` per bus; every param write is `setTargetAtTime` |

The handle stays a plain `number` so `play()` never boxes -- it leaves V8's
small-integer range on any bus `>= 1`, but the boxed-double cost is below the
gate's resolution (measured in [`decisions/0001`](decisions/0001-handle-namespace.md)).
Param events are rate-bounded: a caller writing at `60 Hz` still produces at most
`~100` events/param/voice under a `200` cap, because the writes are throttled onto
the `~10 Hz` monitor rather than hitting the `AudioParam` directly.

The gate is falsifiable. Each tier ships a red control (`LITEAUDIO_TORTURE_*_RED`)
that swaps in the allocating or rate-blowing variant and MUST make the gate exit
non-zero, so a green gate proves the gate can still see a regression.

</details>

## Design decisions worth knowing

- **The handle is bus-tagged, not just generation-stamped.** A generation counter
  is a recycle counter, not a namespace -- every bus's pool starts at channel 0 /
  gen 0, so without the tag `stop()` on an `sfx` handle also killed channel 0 of
  every other bus. [`decisions/0001`](decisions/0001-handle-namespace.md),
  [`0002`](decisions/0002-generation-wrap.md).
- **Mix automation lives on a sidechain gain.** Ducking and snapshot morphs write
  `duckGain`, not the volume param, so they compose with volume/mute instead of two
  automations clobbering one `AudioParam`. [`0003`](decisions/0003-ducking.md),
  [`0004`](decisions/0004-snapshots.md).
- **Auto-suspend is off by default and refused on iOS**, where a suspend->resume
  can demand a fresh gesture and silently un-unlock a working page.
  [`0005`](decisions/0005-auto-suspend.md).
- **Fail closed on every unverified reading.** An unknown `maxChannelCount`, a
  non-integer `poolCapacity`, a bus count past `2^21`, a stolen handle: each is an
  error or a silent no-op, never an optimistic guess. `null` is not zero.

## What this is not

- **Not a decoder or format library.** No MP3/OGG shim, no `canPlayType`
  negotiation beyond first-URL-wins under test, no HTML5 Audio fallback. It targets
  the Web Audio surface every browser has shipped since 2018.
- **Not a Howler replacement for a broad-audience site.** If you need legacy
  fallback and format detection across a long tail of browsers, use Howler. This is
  for games and interactive tools that can assume modern Web Audio.
- **Not a room-acoustics or reverb engine.** The spatial suite is panning
  (StereoPanner / PannerNode / HRTF / VBAP) and a Haas widener, not convolution
  reverb, occlusion, or a ray-traced acoustic model.
- **Not a multichannel guarantee.** Discrete surround needs a real `>= 4`-channel
  sink; a virtual-surround headset reporting `maxChannelCount 2` gets the correct
  stereo fallback. The audible multi-lane render is a manual-QA step, not a CI gate.

## Ecosystem

Part of the [LiteLibrariesSuite](https://github.com/sponsors/PeshoVurtoleta) --
zero-GC, single-file ESM micro-libraries under `@zakkster/*`.

- [`@zakkster/lite-signal`](https://www.npmjs.com/package/@zakkster/lite-signal) --
  the reactive graph lite-audio's control surface is built on (peer).
- [`@zakkster/lite-audio-pool`](https://www.npmjs.com/package/@zakkster/lite-audio-pool) --
  the per-bus voice pool: ABA-safe handles, stereo / positional / HRTF / discrete
  channel modes (peer).
- `@zakkster/lite-audio/compat` -- the `AudioManager`-shaped drop-in for migrating
  a `lite-audio-manager` app by one import.

## License

MIT (c) Zahary Shinikchiev &lt;shinikchiev@yahoo.com&gt;.
