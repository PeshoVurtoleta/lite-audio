# 0008 -- Detected output layout and the 7+1 discrete-surround bus

- Status: accepted
- Date: 2026-08-12
- Package: `@zakkster/lite-audio`
- Session: S6 (v2.4.0)
- Related: 0006 (createBus, the bus-per-family mechanism), the S3/S4 positional
  and hrtf families (setPosition + the cold ~10 Hz monitor), `@zakkster/lite-audio-pool`
  v1.4.0 (discrete mode), SPATIAL_ROADMAP SP-08 / SP-09

## Context

v2.4.0 closes SP-08 (fail-closed output-layout detection) and SP-09 (the
lite-audio side of discrete surround). It consumes the pool's already-shipped
`panner: 'discrete', channels: 8` mode. The whole family is additive and
default-off: no existing bus record, `play()`, `stop()`, or `setPosition()` byte
moves, and `setPosition()` gains ZERO new branches -- a discrete bus reuses the
identical `posXYZ` / `posOwner` / `posDirty` scratch the positional family
allocates, so the only signal a discrete bus is different is a nonzero
`busRec.lanes`.

The single hard question S6 had to settle before any solver could be written is
the exact shape the pool hands back for a discrete voice, because `_flushLanes`
writes into whatever `voiceNode()` returns. The rest are policy rulings.

## Decisions

### 1. The `voiceNode()` return is an INDEX contract, not array membership (BLOCKING)

Confirmed against the installed pool v1.4.0 (`AudioPool.js`): in discrete mode
`voiceNode(handle)` returns `this.voiceLanes[channel]` -- a flat, pre-allocated
`Array(N)` of lane `GainNode`s indexed by SMPTE lane, generation-checked and
fail-closed to `null` (a stolen / stopped / expired / bogus handle). For
`channels === 8` the order is `0=L 1=R 2=C 3=LFE 4=SL 5=SR 6=SBL 7=SBR`, matching
lite-audio's `LANE_*` constants exactly.

The LFE lane IS index 3 inside that same returned array: it is a writable
`GainNode` whose output the pool routes through its shared lowpass into merger
input 3. So "LFE is outside the VBAP set" is an INDEX contract, NOT an
array-membership exclusion. Concretely: `LANE_LFE = 3` is written every flush like
the other seven lanes -- it receives only the azimuth-invariant distance-only
`LFE_SEND`, never a VBAP-derived gain. Total writes per voice per flush = 8 (seven
ring lanes, two of them carrying the constant-power pair and five carrying 0, plus
the one LFE send). The band-limiting itself is the pool's shared lowpass;
lite-audio never sets the crossover.

The solver is pure: `az = atan2(x, -z)` normalized to `[0, 360)`, a containing
adjacent-pair search over `VBAP_RING_AZ_71` (a trailing `360` wrap sentinel makes
the last interval branchless -- no modulo), then the tangent law
`g1 = cos(f*PI/2)`, `g2 = sin(f*PI/2)` with `g1^2 + g2^2 == 1`. It writes one
reused module `LANE_SCRATCH = Float32Array(8)`, allocates nothing, uses no
`Math.hypot`, no array literal, no closure. Lane gains are written with
`setTargetAtTime(v, now, POS_TC)` -- the same 20 ms constant and the same ~10 Hz
cadence as position, so the SP-03 native-event rate bound is inherited, not
re-derived.

### 2. Detect once, cache; do not re-detect on a device change

`_detectLayout()` runs once from `init()`, right after the context is bound and
BEFORE the master connect. It reads `destination.maxChannelCount` into
`this._maxChannels` and resolves `this._layout`. A mid-session layout change
(headset unplug, device hot-swap) does NOT re-detect: re-detecting would mean
tearing down and rebuilding live pools mid-flight, which is out of scope for S6.
A caller that needs to follow a device change destroys and rebuilds the engine.

### 3. Accept only a concrete integer `>= 8`; everything else is stereo

The guard is ONE predicate, `Number.isInteger(v) && v >= PRESET_CHANNELS_71`, not
a typeof ladder: `Number.isInteger(NaN)` and `Number.isInteger('8')` are already
`false`, so absent, `undefined`, `null`, `NaN`, `2`, `4`, `6`, `7.5`, `'8'`, and
an absent `destination` all resolve to `LAYOUT_STEREO`. `null` is not zero -- an
unknown sink is stereo, never optimistically 7.1. A discrete request under a
stereo layout keeps `lanes = 0` and builds a plain, working stereo bus;
`effectiveLayoutOf()` reports `'stereo'` so the caller sees the fallback. On the
expected client rig (a virtual-surround headset reporting `maxChannelCount 2`)
this fallback IS the shipped behaviour, and it is correct, not a failure.

### 4. `spatial: 'discrete'` composes with neither the widener nor `'hrtf'`

`width > 0` on a discrete bus fails closed with a `RangeError`, identical to the
positional/hrtf case -- the stereo Haas widener is stereo-only and must never sit
on a per-voice-panned image. `'discrete'` and `'hrtf'` are a single `spatial` enum
field, so they cannot combine on one bus by construction (double virtualization is
thereby impossible without any extra guard). `preset` is valid only with
`spatial: 'discrete'`; a preset on any other bus is a `RangeError`.

### 5. Height (`y`) has no 7+1 lane -- pinned as not panned

The 7+1 ring is horizontal. `y` (height) folds into distance only and is
deliberately NOT panned: a source above or below the ring never smears into the
surrounds. This is documented in the README so the omission reads as a decision,
not a bug.

### 6. Mutate `destination.channelCount` only on the first discrete pool, restore on destroy

Setting `channelCount = 8` / `channelCountMode = 'explicit'` /
`channelInterpretation = 'discrete'` is process-global for the context, so it
happens ONLY at the first discrete pool build (never in `_detectLayout()`, never in
`init()`, never on a fallback stereo bus), and the prior triple is saved and
restored on `destroy()`. `this._destChannelSaved === null` is the "never mutated"
latch -- an engine that never builds a discrete pool writes nothing back onto the
destination. A caller mixing a discrete bus with an assumed-stereo external graph
on the same context is documented as unsupported.

### 7. Reject `'5.1'` / `'3.1'` loudly rather than degrade silently

S6 ships one preset, `'7.1'`. `'5.1'` and `'3.1'` are named but throw with a
"lands in a later release" message rather than silently falling back to stereo, so
an S7-anticipating caller is never sold a stereo bus in silence.

## Consequences

- The CI gate proves the three things S6 actually asserts: detection resolves
  fail-closed on every pinned reading (T-SP4), a discrete request on a `< 8` sink
  builds a bus that plays (T-SP4 fallback ladder), and the 8-lane solver plus flush
  is zero-alloc over 500k ops and rate-bounded (T-SP3-lane), with `setPosition` on a
  discrete bus measured against the tight `SP5_POS` ceiling to prove it reuses the
  identical zero-alloc scalar stamp.
- The audible 8-lane render, the LFE spectrum, and whether the client rig reports
  `maxChannelCount >= 8` at all cannot be proven headless. They are conditional
  manual-QA steps recorded as unreachable-on-this-rig (the expected reading is `2`,
  which means the shipped behaviour there is the stereo fallback), NOT open gates.
