# 0001 — The voice-handle namespace

- Status: accepted
- Date: 2026-07-29
- Package: `@zakkster/lite-audio` (engine) over `@zakkster/lite-audio-pool`
- Session: AU0 (v1.1.1)
- Finding: AU-01
- Supersedes the roadmap's D5 handle description (which documents the pool's
  handle, not the engine's — see ROADMAP.md §2.1)

## Context

The engine runs **one `AudioPool` per bus**. A pool handle is a full uint32,
`[gen:24][channel:8]`, with no spare bits, and every pool counts channels and
generations from zero independently. So the first play on *every* bus returns
the same uint32 (channel 0, generation 0), and a bare pool handle cannot say
which bus issued it. `stop()` needs to reach exactly one voice; a value that is
ambiguous across buses cannot do that.

## Decision

Tag the bus **above** the pool's 32 bits:

```
handle = busIndex * 2^32 + poolHandle
```

- Decoding is `busIndex = (h / 2^32) | 0` and `poolHandle = h >>> 0` — one
  divide, one ToUint32, both cheap and allocation-free.
- `stop(handle)` resolves the owning pool in O(1) (`_busList[busIndex]`) and
  hands the low 32 bits to that pool, which runs its own generation check.
  A handle can never cross a bus boundary.
- Handles stay **plain numbers**, exact to 2^53.
- `0` is a valid handle (bus 0, channel 0, generation 0), so it can never be a
  null sentinel. "Nothing happened" is signalled by negatives, which are inert
  to `stop()`: `-1` (skipped) and `-2` (a track started; tracks are singletons
  addressed by name and have no handle).

## The bus ceiling is 2^21, and index 2^21 itself is already unsafe

For a handle to remain an exact integer:

```
busIndex * 2^32 + (2^32 - 1) <= 2^53 - 1
=> busIndex <= 2^21 - 1
```

The `(2^32 - 1)` term matters: the low half is a *full* uint32, so the largest
poolHandle a bus can issue consumes it entirely. That makes bus index `2^21`
already unsafe (its maxed-out handle is `2^53 + 2^32 - 1`, not representable),
even though `2^21 * 2^32 = 2^53` looks like it "just fits". The usable index
range is therefore `[0, 2^21 - 1]` and the **bus count** ceiling is `2^21`.

`init()` fails closed above it (`MAX_BUSES`, a `RangeError`) rather than issuing
silently-colliding handles. `'master'` is implicit, never indexed, and does not
count against the ceiling. See `test/Handles.test.js`.

## Rejected alternatives

1. **Broadcast `stop()` across every pool.** Keep bare pool handles; on `stop()`,
   offer the handle to every pool and rely on each pool's generation check to
   reject the ones that did not issue it. This makes `stop()` O(buses) instead of
   O(1) and, worse, is not even correct: two buses can hold the same
   `(channel, generation)` live simultaneously, so the "wrong" pool can accept a
   handle meant for another and stop an unrelated voice. Rejected on correctness,
   not just cost.

2. **Steal bits from the 24-bit generation for the bus.** Pack bus into the high
   bits of the existing uint32. Keeps handles as SMIs, but every stolen bit halves
   the ABA window: the generation counter is what makes a stale handle a safe
   no-op, and shrinking it makes stale handles alias sooner. Trading the ABA
   guarantee — the whole point of the pool — for SMI-ness is the wrong trade.

3. **A `{ bus, handle }` object per play.** Structurally unambiguous and never
   leaves SMI range, but allocates on the hot path. Measured below.

## Measurement (why the plain-number tradeoff is closed)

`test/torture.mjs` measures the handle return across the three regimes and
against alternative 3, under `node --expose-gc` with `lite-gc-profiler`
(`maxMajor: 0, maxPauseMs: 4`, 3,000,000 ops):

| Path                                   | bytesPerOp | major GC | maxMs |
| -------------------------------------- | ---------- | -------- | ----- |
| bus 0, gen 1000 (SMI handle)           | ~0.01      | 0        | 0.000 |
| bus 0, gen 8,388,608 (2^31, boxed)     | ~0.01      | 0        | 0.000 |
| bus 3, gen 5 (>= 2^32, boxed)          | ~0.00      | 0        | 0.000 |
| `{bus,handle}` object per play, held   | ~60        | 0        | 0.000 |

The boxed-double handle costs **nothing measurable** in steady state: under JIT
in a tight loop the box is scalar-elided or collected as young-gen garbage, well
below the major-GC and pause budget. The `{bus,handle}` object, retained for a
voice's lifetime (the realistic case — you keep a handle to stop it later), costs
~60 bytes per play, ~6000x more. That is the alternative the plain-number handle
exists to avoid, and the gate proves it can *see* that cost (it is the gate's
falsification control; `LITEAUDIO_TORTURE_LEAK=1` routes the gated path through
it and the gate exits non-zero).

**The tradeoff is closed.** The plain-number handle leaves SMI range on bus >= 1
and past generation 8,388,608 on bus 0, but the cost of doing so is below the
gate's resolution and below any voice-rate a game reaches. The exact numbers are
noisy near zero and machine-dependent; the *ordering* — handle paths negligible,
retained object ~60 bytes/op — is stable and is the decision.

## Consequence: `GEN_MASK` is NOT narrowed (see also 0002)

The optional AU0 task — narrow the pool's `GEN_MASK` to 23 bits so bus-0 handles
never leave SMI range — is **declined**. Its only benefit is keeping bus-0
handles as SMIs, and the measurement shows the boxed-double cost it would buy back
is negligible. It is also a change to a *peer package* (`AudioPool.js`) that would
halve every consumer's ABA window for a benefit this gate cannot detect. If a
future profile on real hardware ever shows the boxing mattering at a realistic
voice rate, revisit under AU1 with that number in hand — not here.
