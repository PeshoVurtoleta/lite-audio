# 0009 -- 5+1 / 3+1 discrete subsets and the fallback ladder

- Status: accepted
- Date: 2026-08-12
- Package: `@zakkster/lite-audio`
- Session: S7 (v2.5.0)
- Related: 0008 (detected layout + the 7+1 discrete bus this generalizes),
  `@zakkster/lite-audio-pool` v1.4.0 (`channels: {4,6,8}` discrete mode, shipped
  since pool 1.3.0), SPATIAL_ROADMAP S7

## Context

v2.5.0 adds the 6-channel (5+1) and 4-channel (3+1) reductions of the S6 8-lane
VBAP discrete-surround bus, plus a cold fallback LADDER so any discrete request
builds the largest layout the sink actually fits and reports it. This
GENERALIZES the S6 machinery; it does not rewrite it. The pool already ships
`channels: {4,6,8}` with the same low SMPTE lane indices for shared lanes, so no
pool release is needed and the peer range stays `^1.4.0`.

The whole family stays additive and default-off: no non-discrete bus record,
`play()`, `stop()`, or `setPosition()` byte moves, and the hot path gains ZERO
new branches. Five decisions were settled here.

## Decisions

### D1 -- `layoutOf()` widens to the richest single layout (PUBLIC surface change)

`layoutOf()` returns the single RICHEST layout the sink supports, resolved once
at `init()` and cached (the same one-shot contract as S6 -- a mid-session device
change does NOT re-detect). Fail-closed thresholds on the sanitized integer
reading of `destination.maxChannelCount` (`Number.isInteger` gate; any
non-integer / NaN / null / absent reads as 0):

| `maxChannelCount` (integer)       | `layoutOf()` |
| --------------------------------- | ------------ |
| `>= 8`                            | `'7.1'`      |
| `6` or `7`                        | `'5.1'`      |
| `4` or `5`                        | `'3.1'`      |
| `< 4` / non-integer / NaN / null / absent | `'stereo'` |

`null` is not `6`: any unknown reading is `'stereo'`, never an optimistic
upgrade. The sanitized integer is cached as `this._maxChannels` (integer or 0)
for the ladder. This is a documented BEHAVIOR CHANGE: a 4/6ch sink that returned
`'stereo'` under S6 (which recognized only `>= 8`) now returns `'3.1'`/`'5.1'`.
The two S6 tokens keep their meaning -- a caller testing `=== '7.1'` still gets
it only on a `>= 8` sink; the change is visible only to a `=== 'stereo'` caller
on a real 4/6ch sink. On a 2ch sink (the reference client rig,
`maxChannelCount === 2`) the reading is inert -- still `'stereo'`.

### D2 -- the fallback ladder (COLD, at bus construction)

Channel needs: `'7.1' -> 8`, `'5.1' -> 6`, `'3.1' -> 4`. A discrete bus with
requested preset `R` on a sink of `M = _maxChannels` builds the LARGEST preset
`P` in `{7.1, 5.1, 3.1}` whose channel-need `cP <= min(cR, M)`; if `M < 4` it
builds a plain STEREO bus (`lanes = 0`, `vbap = null`) that plays normally. A
request never UPGRADES; the ladder only steps DOWN to fit. The pinned matrix:

| requested \ M | `>= 8` | `6` or `7` | `4` or `5` | `< 4` / unknown |
| ------------- | ------ | ---------- | ---------- | --------------- |
| `'7.1'`       | 7.1    | 5.1        | 3.1        | stereo          |
| `'5.1'`       | 5.1    | 5.1        | 3.1        | stereo          |
| `'3.1'`       | 3.1    | 3.1        | 3.1        | stereo          |

`effectiveLayoutOf(bus)` returns the BUILT layout token
(`'7.1'|'5.1'|'3.1'|'stereo'`), or `null` on a non-discrete / unknown bus -- how
a caller learns whether, and how far, the fallback stepped. It is deliberately
distinct from `layoutOf()`: `layoutOf()` is the sink CAPABILITY (richest);
`effectiveLayoutOf()` is the per-bus BUILT layout after request + ladder. A
`'5.1'` request on an 8ch sink is effective `'5.1'` though `layoutOf() === '7.1'`.
The ladder is computed ONCE in `_resolvePreset` (cold); neither `play()` nor
`_flushLanes` re-tests it.

### D3 -- `destination.channelCount` under mixed presets

`destination.channelCount = max lane count across all LIVE discrete buses`.
Mutating it is process-global for the context, so the pristine triple
(`channelCount`, `channelCountMode`, `channelInterpretation`) is saved EXACTLY
ONCE, on the FIRST discrete pool build, and `channelCount` set to that bus's
lanes with `mode = 'explicit'`, `interpretation = 'discrete'`. A LATER discrete
bus with MORE lanes RAISES `channelCount` to the new max WITHOUT re-saving the
triple (the saved copy stays the pristine pre-discrete value). Discrete buses are
add-only within a session, so the max is monotonic. `destroy()` restores the
saved triple verbatim. Per-bus discrete removal is out of scope -- if ever added,
`channelCount` would need recomputation (flagged, not built).

### D4 -- ring reduction (lane indices are shared across presets)

The pool uses the SAME low indices for shared lanes (`L=0, R=1, C=2, LFE=3,
SL=4, SR=5`, then `SBL=6, SBR=7` for 8ch), so the S6 `LANE_*` constants are
reused as-is; a smaller preset simply does not touch the higher lanes. LFE stays
index 3 in ALL presets and always carries the azimuth-invariant distance-only
send, never a VBAP gain. `y` (height) is not panned in any preset. Rings (lane
index at each ring position) and azimuths (degrees, trailing `360` = wrap
sentinel, no modulo):

- 7.1 (S6, unchanged): ring `[C,R,SR,SBR,SBL,SL,L]`, az `[0,30,110,150,210,250,330,360]`
- 5.1 (drop SBR/SBL): ring `[C,R,SR,SL,L]`, az `[0,30,110,250,330,360]`
- 3.1 (front only): ring `[C,R,L]`, az `[0,30,330,360]`

3.1 has no rear speakers: a source directly behind the listener folds across the
300-degree back gap between `R` (30) and `L` (330). This is correct for a
front-only rig, a documented limitation, not a bug.

### D5 -- zero new hot-path branch and zero per-flush preset branch

Each discrete bus captures a FROZEN per-preset record at construction --
`{ layout, lanes, ring: Uint8Array, az: Float32Array, lfe: LANE_LFE }` -- stored
on `busRec.vbap` (or `null` for a fallen-back stereo bus). The S6 `_vbap71` is
generalized to `_vbapSolve(rec, x, y, z)`, a cold, data-driven walk of `rec`: the
ring array LENGTH is the selector, resolved once. `_flushLanes` reads
`busRec.vbap` and writes EXACTLY `busRec.lanes` gains in a data-driven loop --
NO per-tick `if (preset === ...)` test. The single `LANE_SCRATCH =
Float32Array(8)` is reused for every preset; the solver writes and the flush
reads ONLY `busRec.lanes` entries, so a smaller preset never leaks a stale
upper-lane value. `play()` and `setPosition()` are untouched (Law 1): a discrete
bus reuses the identical `posXYZ`/`posOwner`/`posDirty` scratch, so the only
signal it is different is a nonzero `busRec.lanes` and a non-null `busRec.vbap`.

## Consequences

- Public unions widen: `layoutOf(): '7.1'|'5.1'|'3.1'|'stereo'`,
  `effectiveLayoutOf(): '7.1'|'5.1'|'3.1'|'stereo'|null`, createBus
  `preset?: '7.1'|'5.1'|'3.1'`. Pinned in `Audio.d.ts`.
- The S6 "lands in v2.5.0" `RangeError` for `'5.1'`/`'3.1'` is removed; they
  build. The unknown-preset and preset-on-non-discrete throws stay.
- CI proves detection, the ladder, fallback-to-working-stereo, zero-allocation
  lane writes at all three widths, rate bounds and retention against a MOCK
  N-channel context. The audible 6/4-lane traversal on real `>= 4`/`>= 6`
  hardware is a named MANUAL QA step -- unreachable on a 2-channel endpoint.
