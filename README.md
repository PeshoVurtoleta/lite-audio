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

**Status:** v1.0.0 covers SFX. The music streaming layer
(`MediaElementAudioSourceNode`, crossfades, exclusive/unique) is the v1.1.0
milestone; ducking, snapshots, and auto-suspend are v1.2.0; a Howler-shim
compat subpath and full parity certification against `lite-audio-manager` are
v2.0.0.

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
audio.stop(handle);

// Reactive state - subscribe with lite-signal's effect() for UI hookup.
audio.unlocked();                         // ReadSignal<boolean>
audio.loadState('laser');                 // ReadSignal<'idle'|'loading'|'ready'|'error'>
audio.busVolume('sfx');                   // ReadSignal<number>

audio.setBusVolume('sfx', 0.5);           // schedules setTargetAtTime, click-free
audio.setMuted(true);                     // master mute, persists to localStorage

audio.destroy();                          // idempotent, disconnects the graph
```

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

## Signal readouts (the whole reactive surface)

| Signal | Read via | Notes |
| --- | --- | --- |
| Context state | `audio.ctxState()` | `'suspended' \| 'running' \| 'interrupted' \| 'closed'` |
| Unlock status | `audio.unlocked()` | `true` once the first gesture succeeded |
| Master mute | `audio.muted()` | Persisted to `localStorage['lite_audio_muted']` |
| Bus volume | `audio.busVolume(name)` | 0..1 (or higher; not clamped) |
| Bus mute | `audio.busMuted(name)` | Independent of master mute |
| Load state | `audio.loadState(id)` | `'idle' \| 'loading' \| 'ready' \| 'error'` |

All readable via `signal()` (calling), `signal.peek()` (untracked read), or
inside a `computed()` / `effect()`.

## Options reference

```js
new LiteAudio({
    buses:            ['sfx', 'ui', 'voice'],   // user-facing buses
    poolCapacity:     32,                        // voices per bus pool
    queueLimit:       32,                        // bound on pre-unlock queue
    mutedStorageKey:  'lite_audio_muted',        // manager parity default
    fetch:            globalThis.fetch,          // injectable for tests
    window:           globalThis.window,         // ditto
    document:         globalThis.document,       // ditto
});
```

## Migration from lite-audio-manager

The persistence key (`lite_audio_muted`), unlock event set (`touchstart`,
`touchend`, `mousedown`, `keydown`), capture-phase attachment, and silent-buffer
unlock pulse are byte-identical to the manager. A migration should keep the
player's saved mute preference intact on first launch.

A `./compat` subpath re-exporting an `AudioManager`-shaped adapter over
`LiteAudio` is planned for **v2.0.0**; the migration guide will be the release
notes for that.

## Testing

```bash
npm test
```

32 tests across 9 suites, covering unlock state machine (including
`'interrupted'`), loader fallback + error, bus signal writes as
`setTargetAtTime` on a mock AudioContext, pool delegation (steal, generation
no-op on stale handles, stopBus scope), unlock queue flush semantics
(latest-per-sound, bounded), and destroy idempotency + listener detachment.

The mock harness (`test/mock-ctx.js`) records every `AudioParam` scheduled
event into an inspectable `.events` array, runs a real context state machine
(all four states — `suspended`, `running`, `interrupted`, `closed`), and
mocks `fetch` + `decodeAudioData` with length-hint payloads so tests can
distinguish sounds deterministically. This harness is the D8 foundation the
next roadmap sessions will reuse for the music layer, ducking, and parity
certification.

## License

MIT. Copyright Zahary Shinikchiev.
