# lite-audio-manager parity, certified

`@zakkster/lite-audio/compat` is a drop-in for the unscoped `lite-audio-manager`
(the Howler.js overlay). This table maps the manager's entire surface to the
lite-audio path behind it and to the test that proves the mapping. A row without
a test id is an intention, not a parity claim.

Tests live in [`test/Compat.test.js`](test/Compat.test.js) and run the manager's
own expectations — ported from its Vitest suite to `node:test` — against the real
engine. Migrate by changing one import:

```diff
- import { audioManager } from 'lite-audio-manager';
+ import { audioManager } from '@zakkster/lite-audio/compat';
```

There is **no Howler** in the shim: it is a pure adapter over lite-audio, so the
migration removes a runtime dependency instead of trading one for another.
Design rationale for every divergence is in
[`decisions/0007-compat-shim.md`](decisions/0007-compat-shim.md).

## Surface map

| Manager member | lite-audio path behind the shim | Test id |
| --- | --- | --- |
| `new AudioManager()` (extends EventTarget) | `new AudioManager(opts?)` wrapping a `LiteAudio`; `opts` adds injectables, none required | P-C1, P-C2, P-C3 |
| `isMuted` | getter over the engine mute signal (`muted().peek()`) | P-C1, P-M1 |
| `isUnlocked` | getter over the engine unlock signal (`unlocked().peek()`) | P-C2 |
| `init(config)` | sync facade → `init()` + `createBus` per category + `defineSounds`/`defineTracks` | P-I1..P-I5 |
| `play(name, opts)` | `play()` (SFX) or `playTrack()` (track); `-1`/`-2` → `null` | P-P1..P-P7 |
| `playExclusive(name, opts)` | `stopCategory('outcome')` then `play(name)` — shim owns this, does **not** call the engine's same-named method | P-PE1 |
| `playUnique(name, threshold)` | timestamp gate → `play(name)` | P-PU1..P-PU3 |
| `stop(name, opts)` | per-name `stop(handle)` sweep (SFX) or `stopTrack(name, {fade})` (track) | P-S1..P-S4 |
| `stopCategory(cat, opts)` | iterate config members, `stop(name)` each | P-SC1..P-SC3 |
| `stopCategories(cats, opts)` | `stopCategory` per entry | P-SCS1 |
| `setMuted(state)` | `setMuted()` (persists via engine effect) + `'mutechange'` re-emit | P-M1..P-M4 |
| `destroy()` | dispose mute effect + engine `destroy()`; idempotent | P-D1..P-D4 |
| `addEventListener('mutechange', …)` | native EventTarget; event dispatched from a signal effect on mute | P-M3 |
| active-id bookkeeping (`#activeIds`) | shim-owned `name → Set<handle>`, pruned by `isPlaying()` sweep | P-AT1, DIV-3 |

## Deliberate divergences

Each is a documented, tested difference — parity by decision, not by accident.

| Id | Manager behavior | Shim behavior | Why | Test |
| --- | --- | --- | --- | --- |
| DIV-1 | pre-unlock `play()` is dropped, returns `null` | returns `null` **but queues** the play; flushes on first gesture | the migrant gains lite-audio's unlock queue; the `null` return is preserved so nothing branching on it breaks | DIV-1 |
| DIV-2 | `stop(name, {fade})` fades every sound | fades **tracks** (real ramp); **SFX** stop instantly, `fade` inert | pooled voices carry no per-voice envelope on the zero-GC hot path; faded one-shots belong on a track | DIV-2, P-S2 |
| DIV-3 | active ids auto-cleaned on Howl's `'end'` event | pruned by an `isPlaying()` sweep on each `play()` | the pool exposes no per-voice end callback; the sweep is bounded by pool capacity and needs no timer | DIV-3 |
| DIV-4 | one `Howl` type for every sound | `loop`/`html5` sounds → streamed **tracks**; others → pooled **SFX** | lite-audio splits streamed music from one-shot SFX; a migrant's music becomes a real stream | P-CLASS, P-P3 |

Two clauses on the rows above:

- **DIV-1 covers pooled SFX only.** The unlock queue holds *pooled SFX* plays;
  `playTrack` returns early while the context is locked, so a track fired
  pre-unlock is **not** queued and does not survive to first gesture. A caller
  should start a track after unlock (watch `unlocked()`), not before.
- **DIV-4 costs the pool to loop.** Declaring a sound `loop` classifies it as a
  streamed track, so looping a short interaction SFX moves it from a decoded
  buffer in the pool to an `<audio>` stream. The pool has no `loop`; a looping
  one-shot has no pooled option (A-3).

## Semantic maps (no behavior change, different mechanism)

- **`category` → bus.** The manager stops by category by scanning its config;
  the shim auto-creates a bus per category and routes there. A `stopCategory`
  for a category no sound declared is a silent no-op (P-SC3, decision 0007 §2).
- **`isMuted`/`isUnlocked`** are getters over signals, not mutable fields — read
  identically, and stay live without a manual write.
- **Persistence** uses the same `lite_audio_muted` key the engine already ships,
  so a mute preference written by the manager is read by lite-audio and vice
  versa — the actual migration case.

## Not shimmed (engine superset)

lite-audio's buses, ducking, snapshots, per-bus meters, and equal-power
streamed crossfades have no manager equivalent. They are reachable from a shim
instance via the `engine` getter for code ready to move past the manager
surface. The shim is a migration bridge, not a ceiling.

## Coverage

41 ported expectations, all green (`node --test test/Compat.test.js`). Every
manager `it` maps to a row above; every divergence has a test asserting the
shim's actual behavior, not merely that it differs.
