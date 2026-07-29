# Migrating from lite-audio-manager

`@zakkster/lite-audio/compat` is a drop-in for the unscoped `lite-audio-manager`
(the Howler.js overlay). This guide is the whole migration. The certified,
member-by-member map is in [`PARITY.md`](PARITY.md); the design reasoning is in
[`decisions/0007-compat-shim.md`](decisions/0007-compat-shim.md).

## Step 1 — change one import

```diff
- import { audioManager } from 'lite-audio-manager';
+ import { audioManager } from '@zakkster/lite-audio/compat';
```

Or construct your own:

```diff
- import { AudioManager } from 'lite-audio-manager';
+ import { AudioManager } from '@zakkster/lite-audio/compat';
  const audio = new AudioManager();
```

## Step 2 — swap the dependency

```bash
npm remove lite-audio-manager howler
npm i @zakkster/lite-audio @zakkster/lite-signal @zakkster/lite-audio-pool
```

There is no Howler underneath the shim — it is a pure adapter over lite-audio,
so the migration *removes* a runtime dependency rather than trading one for
another. The two peers are lite-audio's own; both are zero-dependency.

## Step 3 — nothing else

`init` / `play` / `playExclusive` / `playUnique` / `stop` / `stopCategory` /
`stopCategories` / `setMuted` / `destroy`, the `isMuted` / `isUnlocked` flags,
and the `'mutechange'` event all keep their shapes. The mute preference carries
over untouched: both packages persist to the same `lite_audio_muted` key, so a
returning player stays muted (or not) across the swap.

## What you gain for free

- **Your music becomes a real stream.** A sound configured with `loop` or
  `html5` — the manager's long-form audio — is routed to a lite-audio streamed
  track with equal-power fades, instead of a decoded, looped buffer.
- **Pre-unlock plays survive.** A `play()` fired before the first user gesture
  is queued (bounded, latest-per-sound) and flushed on unlock, instead of being
  dropped. The return value is still `null`, so nothing that checked it breaks.
- **The whole engine, when you want it.** The shim instance exposes the
  underlying `LiteAudio` via `audio.engine` — buses, ducking, snapshots, per-bus
  meters, streamed crossfades. Reach for it when you outgrow the manager surface.

## Three behaviors to know about

None of these should require code changes, but they are real differences —
tested, and documented in [`PARITY.md`](PARITY.md) as `DIV-1`..`DIV-4`.

1. **Fades on stop.** `stop(name, { fade })` fades a **track** (real ramp) but
   stops a pooled **SFX** voice instantly — pooled voices carry no per-voice
   envelope on lite-audio's zero-GC hot path. If you relied on a faded one-shot,
   make that sound a track (`loop` or `html5` in its config).
2. **Categories are buses.** Each distinct `category` in your config becomes a
   lite-audio bus. `stopCategory` for a category no sound declared stops nothing
   (a no-op), rather than erroring — the same fail-safe direction a typo hits.
3. **`init` is a synchronous facade over async decode.** The call returns
   immediately, as before; a play fired before the audio has decoded is queued
   (see above). If you need to *await* readiness, the shim adds `whenReady()`.

## If you were reaching into Howler directly

`Howler.ctx`, `Howl` instances, `howl.fade`, sprite ids and the rest are gone —
they were never part of the manager's surface. If your game called them around
the manager, port those call sites to the engine (`audio.engine`) or to
lite-audio's native API; there is no Howler object to reach.
