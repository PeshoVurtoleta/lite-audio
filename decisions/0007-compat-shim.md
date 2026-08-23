# 0007 — The lite-audio-manager compat shim: one sound type becomes two

- Status: accepted
- Date: 2026-07-29
- Package: `@zakkster/lite-audio`
- Session: AU2 (v2.0.0)
- Related: 0006 (createBus, the bus-per-category mechanism), the shipped
  `lite_audio_muted` key (migration continuity), llms.txt handle contract

## Context

v2.0.0 ships `./compat`: a drop-in for `lite-audio-manager`, the Howler.js
overlay a game currently uses. The release criterion is not a feature — it is
that a game deletes `lite-audio-manager` by changing one import. That is a claim
about the manager's entire 347-line surface, true only if the shim maps every
method and the map is tested (see PARITY.md).

The manager and lite-audio do not line up one-to-one. The shim's whole job is
the impedance match, and four mismatches needed a decision rather than a
mechanical translation. There is no Howler in the shim — it is a pure adapter
over lite-audio's own engine, so migrating *drops* a runtime dependency.

## Decisions

### 1. One sound type becomes two (the central call)

The manager wraps everything in a `Howl`. lite-audio deliberately splits two
kinds of sound: pooled, zero-GC one-shot **SFX voices**, and streamed **music
tracks** on `<audio>` elements. A faithful shim cannot collapse them back, so it
**classifies** at `init()`:

- a config sound with `loop` or `html5` set → a lite-audio **track**
  (`defineTracks` / `playTrack` / `stopTrack`);
- everything else → a pooled **SFX voice** (`defineSounds` / `play` / `stop`).

This is where the shim earns its keep rather than merely preserving behavior. A
migrant's background music — `bgm: { loop: true, html5: true }` in the manager, a
decoded-and-looped `Howl` — becomes an actual stream with real crossfade-grade
fades, which the manager's HTML5 path could not give it. The classification is a
config-time heuristic (`loop || html5`), which is exactly the signal Howler
itself uses to mean "this is long-form audio."

Consequence, recorded so it is not mistaken for a bug: `stop(name, { fade })`
honors the fade for a **track** (a real ramp on its crossfade knob) and ignores
it for a pooled **SFX** voice, because lite-audio has no per-voice gain envelope
on its zero-GC hot path — that was 0-alloc by design, not an oversight. A game
that wants a faded one-shot wants a track. See PARITY DIV-2.

### 2. Categories become buses; an unknown category stops nothing

A manager category is an arbitrary config string; lite-audio has real buses.
`init()` auto-creates one bus per distinct `category` via `createBus()` (0006),
and every sound routes to its category's bus. A sound with no category routes to
a fallback `sfx` bus created on demand. `master` is reserved and cannot be a
bus, so a sound that named it as a category routes to the fallback instead.

A `stopCategory(name)` for a category **no sound ever declared** is a silent
no-op — it iterates the config, finds no member, and stops nothing. This is the
fail-safe direction: a typo'd category name stops nothing rather than falling
through to the master bus and cutting all audio. Rejected: routing an unknown
category to master (one bad string silences the game) and throwing (crashes a
migrated game that carried a dead category string the manager tolerated).

### 3. Pre-unlock plays are kept, not dropped

The manager returns `null` and *drops* a `play()` fired before the context is
running. lite-audio *queues* it (bounded, latest-per-sound) and flushes on the
first user gesture. The shim keeps the queue: `play()` returns the `null`
skip-sentinel synchronously to honor the manager's `number | null` type, but the
play actually survives to unlock. The migrant gains a feature and nothing that
branched on the `null` return breaks. See PARITY DIV-1.

### 4. Sentinel normalization and the sync-init facade

- **Sentinels.** lite-audio's `play()` returns `-1` (skipped/queued) and the
  music layer uses `-2` (track-started). The manager's contract is `number |
  null`. The shim normalizes any negative engine return to `null`; a real handle
  — including the perfectly valid `0` (bus 0, channel 0, generation 0) — passes
  through as a number, which is why the normalization tests `< 0`, never `!`.
- **Sync facade.** The manager's `init(config)` is synchronous (Howls preload
  fire-and-forget). lite-audio's context wiring and buffer decode are genuinely
  async. The shim's `init()` stays synchronous-looking — it kicks off the async
  setup and returns — so the call site is unchanged. A `whenReady()` promise is
  added (a shim-only extension) for tests and for callers that want to await
  load; a game that plays before ready simply queues (decision 3).

## 2.12.0 amendment (session AU1 consumer brief)

The AU1 Howler retirement (`BRIEF.md`) shipped over `./compat` and filed five
findings. The fixes and their rationale:

- **A-1 restart, not resume (the emulated surface).** `play()` on a track called
  `playTrack(name, {})`, which is idempotent resume-from-position. But the manager
  surface being emulated is Howler's `sound.play()`, which starts a new instance
  at position 0 every time -- *restart* is the faithful behavior, and it matters
  the moment a track is interrupted (a jackpot fanfare clicked mid-play must not
  resume truncated). `play()` now defaults to `playTrack(name, { restart: true })`;
  a new `PlayOptions.resume` opts back into resume. Restart is the default because
  it is what the surface means, not because resume is wrong.
- **A-2 per-play volume via engine `setTrackVolume` (faithful because a track is a
  singleton).** `PlayOptions.volume` was dropped on the track path -- a track's
  level was baked into `volumeGain` at wire time with no public setter. Added
  `LiteAudio.setTrackVolume(name, v)` and forward it from `play()`, but ONLY when
  volume was explicitly passed (a defaulted `volume: 1` must not clobber a
  config-set level). Setting the singleton track's baseline for this and later
  plays is the faithful mapping: a track *is* one addressed object, so "this
  play's volume" and "the track's volume" are the same knob, unlike a pooled SFX
  where each voice is distinct.
- **A-5 realm capture.** `muteEvent()` read `globalThis.CustomEvent` at dispatch
  while the class extends the `EventTarget` bound at module eval. In one realm
  (a browser) identical; under jsdom-in-node they differ and node's brand-checking
  `dispatchEvent` throws `ERR_INVALID_ARG_TYPE` on every `setMuted()`. Capturing
  `CustomEvent` once at module load, beside the extended `EventTarget`, binds both
  to the same realm. The Node < 19 plain-`Event` fallback is preserved.
- **A-3 / DIV-1 (docs only).** Recorded that looping a short SFX costs it the pool
  (config `loop` classifies it as a streamed track), and that the unlock queue
  covers pooled SFX only -- `playTrack` returns early pre-unlock, so tracks are
  not queued. No code change; the classifier and queue behavior were already
  correct, only under-documented.
- **A-4 (packaging).** `test/mock-ctx.js` is published behind a `"./testing"`
  export so a consumer's adapter tests run against the same harness this package
  uses, rather than a vendored copy that drifts.

Version 2.12.0 is a minor bump: the engine method is additive and the shim
changes are behavior corrections against the emulated surface, not a core break.

## For a future reviewer

- The shim owns a `name -> Set<handle>` map because the manager's `stop()` is
  **by sound name** and lite-audio's `stop()` is **by handle**. The pool exposes
  no per-voice `end` callback (Howl does), so the map is pruned by an
  `isPlaying()` sweep on each `play()` rather than an event hook — bounded by
  pool capacity, no timer. See PARITY DIV-3.
- The manager's `playExclusive` and lite-audio's `playExclusive` are **false
  friends**: the manager stops the hardcoded `outcome` category then plays; the
  engine's same-named method is a track/bus operation. The shim implements the
  *manager's* meaning itself and never delegates to the engine's method.
- `'mutechange'` is re-emitted from a lite-signal `effect` on the mute signal
  (first run skipped, so construction announces nothing), which means the event
  fires for a mute change from any source, not only the shim's `setMuted`.
- The version is a major (2.0.0) as the Howler-retirement milestone, not a
  SemVer break — `./compat` is a purely additive subpath and the core surface is
  unchanged.
