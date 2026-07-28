# 0002 — Generation wrap: audio wraps where arena retires

- Status: accepted
- Date: 2026-07-29
- Package: `@zakkster/lite-audio-pool` (behaviour), recorded from `@zakkster/lite-audio`
- Session: AU0 (v1.1.1)
- Related: 0001 (handle namespace), lite-arena AR-01 / AR-05

## Context

A pool channel's generation is the ABA guard: every steal and every natural end
bumps it (`(gen + 1) & GEN_MASK`), so a handle held across a steal goes stale and
`stop()` on it is a safe no-op. `GEN_MASK` is 24 bits (`0xFFFFFF`), so the counter
**wraps** at 16,777,216 and re-issues generation 0.

Wrapping means the ABA guard is not absolute: a handle captured at generation `g`,
held while that exact channel is stolen 16,777,216 times, and then passed to
`stop()`, will match a *different* voice that happens to be at generation `g`
again. This is the classic bounded-generation ABA window.

`@zakkster/lite-arena` faced the same bounded-counter question (AR-05) and chose
the opposite policy: **retirement**. When a slot exhausts its generations, arena
takes it out of service permanently rather than re-issue, and `spawn()` fails
closed ("out of memory ... retired") when the live pool is exhausted. Its handle
is also *signed* and goes negative past the sign bit (AR-01), which forced an
`Int32Array` for the sparse set — the mirror of this package, where the `>>> 0`
that keeps handles unsigned is exactly what pushes the engine handle out of SMI
range (0001).

## Decision

**lite-audio-pool wraps. It does not retire.** This is deliberate, and it diverges
from lite-arena on purpose.

Why wrapping is right *here* specifically:

- **Voices are a scarce, fixed resource.** A pool has `capacity` channels (<= 256)
  and they are the hardware-ish budget — the whole point is to reuse them forever.
  Retiring a channel would permanently shrink an already-tiny pool; a long-running
  stream overlay would bleed voices until it had none. Arena's slots are cheap and
  numerous (a retired slot among millions is invisible); a pool's are not.

- **The wrap window is unreachable in practice.** 16,777,216 steals *on one
  channel* is hours of continuous stealing at a game's voice rate (see 0001's
  measurement context). The ABA hazard is theoretical for audio in a way it is not
  for a long-lived ECS.

- **Fail-closed retirement would be worse than the failure it prevents.** A stale
  `stop()` that hits a re-issued voice cuts one sound early — an audible glitch at
  most. A retired channel is gone for the process lifetime. The cure is more
  harmful than the disease for this resource.

## For a future reviewer

The two packages answer the same bounded-counter question with opposite policies,
**and that is correct**. Do not "fix" one to match the other:

- Making the pool retire would starve long-running audio of voices.
- Making arena wrap would resurrect the AR-05 hazard it fixed.

If this ever needs revisiting, the lever is `GEN_MASK` width (a wider counter
pushes the wrap further out), not the wrap-vs-retire policy — and note that
widening it is coupled to the SMI-range tradeoff in 0001, which declined to
*narrow* it. Keep both decisions in view together.
