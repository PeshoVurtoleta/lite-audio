# 0003 — Ducking on a sidechain node, explicit-wins-over-automatic

- Status: accepted
- Date: 2026-07-29
- Package: `@zakkster/lite-audio`
- Session: AU1 (v1.2.0)
- Related: 0004 (snapshots share the sidechain), D1 (buses as categories)

## Context

Ducking dips one bus while another is active — SFX/voice pushing music down. Two
questions had to be answered on the record: *where* the duck automation lives,
and *how* it is triggered.

### Where: a dedicated sidechain gain, not the volume param

A bus's volume and mute already own `busRec.gain.gain`, written by a signal
effect (`setTargetAtTime`, `RAMP_TC`). If a duck wrote that same `AudioParam`,
the two would fight: the last writer wins, and the next time the volume/mute
effect re-ran it would clobber the duck (or vice versa). One `AudioParam` cannot
carry two independent automations.

So each bus gets a second gain node spliced under the first:

```
pool / track -> gain (volume + mute) -> duckGain (sidechain) -> master
```

Volume/mute stay on `gain`; ducking owns `duckGain`. The two **compose** — they
multiply through the graph — instead of contending for one param. A ducked-and-
muted bus is still silent; a duck survives a volume change; a volume change
survives a duck. This is the standard Web Audio sidechain shape, and it is why
`setTargetAtTime` is the right primitive: an exponential approach with a time
constant *is* a compressor's attack/release.

Keeping the duck off `busRec.gain` also preserved the AU0 hash-parity lock on the
bus write effect at the logic level: the effect body is byte-identical (its SHA
moved in AU1 only because the effect was relocated verbatim into `_buildBus` so
`createBus()` could share it — see the HashParity test header).

### Attack and release are separate time constants

A duck that attacks and releases at the same rate sounds wrong: the ear expects
music to get out of the way *fast* and return *slowly*. `duck()` takes `attack`
and `release` separately (defaults 50 ms / 300 ms), and `duckOn()` uses `attack`
on the rising edge and `release` on the falling one. The asymmetry is the point,
not an accident to be "cleaned up" into one constant.

### How it is triggered: explicit primitive + opt-in follower, explicit wins

- `duck(bus, level, {attack, release})` / `stopDuck(bus, {release})` — the
  manual, always-available primitive.
- `duckOn(triggerBus, targetBus, {threshold, level, attack, release})` — an
  opt-in automatic follower: while `triggerBus` has `>= threshold` voices, dip
  `targetBus`. Evaluated off the hot path by the shared ~10 Hz monitor, and only
  on an **edge** (the trigger crossing its threshold), so steady state writes
  nothing and a held-down trigger does not re-schedule a ramp every tick.

**An explicit `duck()` always wins over the follower.** `duck()` sets a
`duckManual` latch on the bus; while it is set, the follower skips that bus
entirely. `stopDuck()` clears the latch and hands the bus back to the follower.

## Decision

Ducking lives on a per-bus sidechain gain, with separate attack/release time
constants, exposed as both a manual primitive and an opt-in follower, where the
manual primitive latches out the follower.

## Rejected alternatives

- **Duck on the volume param directly.** The two-writer conflict above. Rejected
  outright — it is not implementable correctly on one `AudioParam`.
- **Follower only (no manual override).** An automatic duck a caller cannot
  override is a bug report waiting to be filed: the one time a designer wants a
  sting to punch *through* the music, an unconditional follower fights them.
- **Manual only (no follower).** Leaves every game to re-implement voice-count
  ducking against `activeCount()`. The follower is cheap (edge-only writes on an
  already-running monitor) and is the common case, so it belongs in the library.

## For a future reviewer

The sidechain node is shared with snapshot morphs (0004). A live follower can
reassert a duck over a snapshot morph mid-transition; that is acceptable — a
running duck is current information and a scene morph is not sacred. If ducking
and snapshots ever need to be fully independent, that is the moment to give
snapshots their own node rather than to serialize them on `duckGain`.
