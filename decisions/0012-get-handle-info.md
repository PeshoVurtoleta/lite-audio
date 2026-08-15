# 0012 -- getHandleInfo(handle) debug decoder

- Status: accepted
- Date: 2026-08-15
- Package: `@zakkster/lite-audio`
- Session: PS3 (v2.8.0)
- Related: 0001 (handle-namespace -- the `[bus:21][gen:24][ch:8]` packing this
  decodes), 0002 (generation-wrap -- why the decoded generation is the low 24
  bits, not a monotonic age), 0010 (bus-tombstone -- why a `destroyBus`'d handle
  decodes to null via `busOf`), SPATIAL_ROADMAP section 7 (post-suite backlog)

## Context

A voice handle is ONE opaque number carrying `handle = busIndex * BUS_STRIDE +
poolHandle`, where `poolHandle = ((gen << 8) | channel) >>> 0` (decision 0001):
the high half names the bus, the low 24 bits the generation, the low 8 the
channel. When a caller reports the "wrong voice stopped", there was no supported
way to inspect what a handle actually names -- you had to hand-decode the bit
math or read engine internals.

PS3 adds one public method, `getHandleInfo(handle)`, that decodes the packing to
a plain `{ busName, generation, channel }` object, or `null` on a non-handle. It
is a PURE STRUCTURAL decoder: it reports what the bits SAY, reusing the existing
`busOf` decode for the bus-name half. It is a debug/query call, off every hot
path (never called by `play`/`stop`/`isPlaying`/`setPosition`/the monitor), so it
MAY allocate its result object. The hot bodies gain zero bytes, zero args, zero
branches, and both `HashParity` goldens (`play()`, `stop()`) stay frozen.

The type guard is `Number.isInteger(handle) && handle >= 0` FIRST, then `busOf`,
then decode. `busOf` alone is fail-OPEN on `NaN`/`undefined` (`NaN < 0` is false,
`NaN / BUS_STRIDE | 0 === 0` would name bus 0), so `getHandleInfo` guards the
type itself rather than inheriting that hole. Fixing `busOf`'s fail-open is a
separate behavior change to a shipped method and is deliberately OUT OF SCOPE
here; `getHandleInfo` simply does not delegate the check.

## Decisions

### D1 -- null, never a partial object

Any non-handle returns `null`, not `{ busName: null, ... }`. Fail closed; null is
not zero; a caller branches on one `=== null`. The decode runs only after the
`Number.isInteger && >= 0` guard AND after `busOf` returns a non-null name, so a
returned object is always fully populated with the three decoded fields.

### D2 -- a destroyed bus decodes to null, via busOf

`destroyBus` drops the name binding (Audio.js) and sets the bus record's
`dead` flag, so `busOf` already returns `null` for a tombstoned bus. A
never-existed `busIndex` (past `_busList`) likewise finds no name and returns
`null`. `getHandleInfo` reuses that decode rather than reading the husk -- one
source of truth for handle -> bus, no tombstone/husk state leaked through a debug
API. A `destroyBus`'d bus and a never-existed one are therefore indistinguishable
(both null); accepted, because both mean "this handle cannot name a live voice",
which is all a debugger needs.

### D3 -- pure structural decode, no liveness

`getHandleInfo` reports what the bits encode, not whether the voice is currently
sounding. Liveness is `isPlaying(handle)`; an `isLive`/`active`/generation-match
field would duplicate it and couple a debug decoder to the pool's live state.
Rejected for minimalism. Consequently the decoded `generation` is the stored low
24 bits and WRAPS at 2^24 (decision 0002) -- it is a faithful decode of the bits,
not a monotonic play count, and a debugger must not read it as an absolute age.

### D4 -- a fresh object per call is allowed (off the hot path)

The roadmap brief is "allocation-explicit ... off the hot path". `getHandleInfo`
is a debug/query call (never in `play`/`stop`/`setPosition`/the monitor), so
returning a fresh object literal per call is the correct ergonomics; it adds ZERO
allocation to any hot body (they are byte-unchanged) and both goldens stay
frozen. A reused/out-param object would be a premature micro-optimization on a
debug path and a footgun (aliasing across calls: two decodes of different handles
would clobber each other). Two calls on the same handle return deep-equal but not
`===` objects, deliberately.

### D5 -- node:test-only, no torture tier

No new torture tier is added, and none is missing. `getHandleInfo` has NO hot
path to torture -- it is a cold debug/query call, like `busOf`/`activeCount`,
neither of which has a dedicated tier. A red control is not meaningful for a pure
decoder: there is no per-tick invariant to falsify. The correctness proof is the
boundary suite's fail-closed matrix (`test/HandleInfo.test.js`); the
non-regression proof is that the hot bodies did not move, which the EXISTING
zero-GC gate's non-regression tier already controls (see Proof, A3). This is
stated explicitly so a future reader knows a tier was considered and deliberately
omitted, not forgotten.

## Proof

- **Correctness (A1/A2).** `test/HandleInfo.test.js` -- a node:test boundary
  suite. It pins the fail-closed matrix (`-1`, `-2`, any negative, `NaN`,
  `undefined`, `null`, a string, `1.5`, a non-integer near `2.5e9`, a
  `busIndex >= _busList.length` handle, and a `destroyBus`'d-bus handle all
  return EXACTLY `null`), the synthesized roundtrip across buses 0..N with
  generations up to `2^24 - 1` and channels 0..255, the purity guarantee
  (`activeCount()`/`isPlaying(h)` unchanged and the same handle still `stop()`s
  afterward), and the fresh-object-per-call contract (D4). qa owns this file.
- **GC non-regression / control (A3).** The existing `node --expose-gc
  test/torture.mjs` gate is the control: it still exits 0 with the 2.7.0 numbers,
  and the diff is confined to `Audio.js:10` (VERSION) + the new `getHandleInfo`
  method + `Audio.d.ts` + `llms.txt` + `CHANGELOG.md` + this decision +
  `package.json`. The hot bodies (`play`/`stop`/`isPlaying`/`setPosition`/
  `setWidth`/the monitor) are byte-unchanged and never call `getHandleInfo`
  (grep proof). NO new torture tier is added -- see D5 for why (a pure cold
  decoder has no hot path and no per-tick invariant, so a dedicated tier and its
  red control would prove nothing).
- **Goldens frozen (A5).** Both `HashParity` goldens are byte-identical to 2.7.0;
  PS3 adds no hot-path arg or branch, so no re-baseline.
