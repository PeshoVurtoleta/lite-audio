# 0004 — Mix snapshots: bus-only capture, sidechain morph, interrupt-safe

- Status: accepted
- Date: 2026-07-29
- Package: `@zakkster/lite-audio`
- Session: AU1 (v1.2.0)
- Related: 0003 (ducking owns the same sidechain node)

## Context

Snapshots are the "menu / gameplay / paused" mixes-as-data primitive:
`captureSnapshot(name)` records the current mix, `applySnapshot(name, ms)`
morphs back to it. Three things had to be decided on the record: what a snapshot
captures, how a caller-supplied `ms` transition is honoured without a two-writer
conflict on the bus gain, and whether an apply is interruptible mid-morph.

## Decision

### Capture: bus gains and mutes only — not track volumes

A snapshot captures every bus's `volume` and `muted`, nothing else. Track volumes
are **not** captured. A track is a name-addressed singleton with its own
`volumeGain`; folding it into a snapshot would couple the mix desk to the music
layer and muddy the model ("is this a bus mix or a full transport state?"). A
snapshot is a picture of the *desk*, and the desk is buses.

### Morph: on the sidechain node, signals as truth

The obvious implementation — set the bus volume/mute signals and let them ramp —
cannot honour `ms`: the volume effect ramps at a fixed `RAMP_TC` (~10 ms). Honour-
ing `ms` on the volume param itself would mean a variable ramp duration inside the
hashed bus write effect (rejected — it churns the hottest bus path). So the morph
rides the **sidechain** (`duckGain`, from 0003) instead:

1. Set the volume/mute **signals** to the captured targets immediately, so every
   reactive readout (`busVolume`, `busMuted`) is instantly truthful.
2. Pin the bus gain to its target (`setValueAtTime`), so the fast volume ramp does
   not also move.
3. Carry the whole `ms`-long audible transition as a single linear ramp on
   `duckGain`, from a start multiplier chosen to keep the audible product
   continuous.

The audible level is `busGain x duckGain`. With `busGain` pinned to `tgtEff`, a
`duckGain` ramp from `startMul` to `1` makes the product move `tgtEff*startMul ->
tgtEff`. Choosing `startMul = curProduct / tgtEff` makes the product start at
exactly `curProduct` — no click — and end at `tgtEff`, over `ms`.

### Continuity comes from the actual product, so applies are interrupt-safe

`curProduct` is read from the **live params** (`busGain.value * duckGain.value`)
*before* anything changes, not from the signal. A snapshot applied mid-morph — or
mid-duck — therefore starts from where the sound actually is, not from where a
signal claims it should be. A second `applySnapshot` cancels the in-flight ramp
and re-derives its start from the current product. Interruptible by construction.

### A silent target is left to the signals

If the captured target is silence (muted or zero volume), there is no
`curProduct / tgtEff` (divide by zero), and a `duckGain` ramp to 0 would strand
the sidechain silent — a later unmute would leave the bus inaudible because
`duckGain` is still 0. So a silent target skips the sidechain morph and lets the
volume/mute signals settle it at `RAMP_TC` (already click-free). Fading *to*
silence is fast; morphing *between* audible mixes takes `ms`. Documented, and the
safer of the two failure directions.

### Applying restates the mix

`applySnapshot` clears the `duckManual` latch (0003) on every bus it touches: a
snapshot is a full statement of the mix, so it releases any manual duck rather
than leaving a stale latch that would lock the follower out afterward.

## Rejected alternatives

- **Signals only, `ms` ignored.** Simple and fully reactive, but `applySnapshot(name,
  500)` silently doing a 10 ms transition is a lie in the signature.
- **Variable ramp duration on the bus volume effect.** Honours `ms` on the "right"
  param, but changes the hashed bus write and complicates the hottest bus path for
  a scene-scale feature. The sidechain already exists for exactly this kind of mix
  automation.

## For a future reviewer

The sidechain is shared with ducking. After a morph, `duckGain` rests at `1`, so
the duck system is left in a clean state. If a snapshot morph and a live duck
follower ever visibly fight, the fix is a dedicated snapshot node — not moving the
morph back onto the volume param.
