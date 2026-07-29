# 0005 — Auto-suspend: native-hold wake, bare resume, off on iOS

- Status: accepted
- Date: 2026-07-29
- Package: `@zakkster/lite-audio`
- Session: AU1 (v1.2.0)
- Related: D3 (unlock path), D9 (auto-suspend), 0001 (play() hot path)

## Context

Auto-suspend stops the audio hardware spinning on silence: after N seconds with
no SFX voice and no playing track, suspend the context; a later `play()` resumes
it. Three things needed deciding on the record: how the triggering `play()` is
handled across the async resume, how the wake is issued, and the iOS hazard.

## Decision

### The wake lets the native scheduler hold the voice — no microtask, no await

`ctx.resume()` is asynchronous. The question was what happens to the *specific*
`play()` that triggers the wake, given the hardware takes a moment to spin up.

**Answer: schedule the voice synchronously, as normal, and let the native
scheduler hold it.** A suspended `AudioContext` has a *frozen* `currentTime` — the
clock does not advance and no audio is processed, but scheduling is still legal.
Per spec, a source started "now" (`when <= currentTime`, which is what the pool
does) plays *as soon as possible once the context is running*. On a frozen clock
that "as soon as possible" is pinned to the resume boundary, and the source plays
from its head — nothing is clipped. The only artifact is a lead-in gap equal to
hardware spin-up, which is inherent to a cold pipeline and cannot be scheduled
away.

So `play()`'s wake is one monomorphic `if (this._selfSuspended)` check that fires
a fire-and-forget resume and falls straight through to the pool's normal
scheduling. It does **not** `await` resume and does **not** defer to a microtask.

Deferring would be strictly worse on this package's constraints:

- A microtask defer allocates a closure per triggering `play()` — a zero-GC law
  violation on the one primitive we most protect.
- It *adds* latency (a full async hop) rather than removing the spin-up gap, which
  the frozen clock already handles for free.
- It reorders the woken voice relative to same-tick plays.

The `play()` golden was re-baselined for this one branch (AU1), and the extended
torture gate proves the added check allocates nothing.

### The wake is a bare `resume()`, not the D3 unlock ceremony

D9's note said route the resume through the D3 unlock path. On reflection that is
wrong for *this* transition. The D3 ceremony (silent-buffer pulse + resume) exists
to crack open the **first-ever** unlock on iOS; it allocates nodes. An auto-suspend
wake happens on an already-unlocked context, so the pulse is unnecessary — and
auto-suspend is hard-off on iOS anyway (below), so no live platform needs it. The
wake is therefore a plain `ctx.resume().catch(() => {})`. Do not "fix" this back
to routing through unlock: it would add allocation to the wake for no benefit.

### Off by default, and hard-off on iOS

Auto-suspend is opt-in (`enableAutoSuspend({after})`) and defaults off everywhere.
It is additionally **refused on iOS** — `enableAutoSuspend()` returns `false` and
stays off — because there a `suspend()` -> `resume()` can require a fresh user
gesture, which would silently *un-unlock* a page that was working. The detection
covers iPhone/iPad/iPod plus iPadOS 13+ (which reports as Macintosh, disambiguated
by touch-point count). On iOS the win from suspending on silence is not worth the
risk of a mute page, so we do not take it.

## Rejected alternatives

- **`await ctx.resume()` before scheduling the voice.** Adds latency and makes
  `play()` async on the wake path; the frozen-clock hold already gives the correct,
  lower-latency behaviour.
- **Microtask defer of the triggering play.** Allocates per wake; see above.
- **Keep `play()` byte-identical; resume only on gesture/visibility.** Preserves
  the AU0 hash, but a programmatic `play()` on a silent-suspended context would not
  self-wake — a worse API than one zero-alloc branch buys. Rejected in favour of
  "any play resumes."
- **Auto-suspend on iOS behind the unlock path.** The un-unlock hazard is not worth
  the hardware saving on the platform where it bites hardest.

## For a future reviewer

The `_selfSuspended` latch is the whole contract: set when *we* suspend on silence,
cleared by the wake. It distinguishes our suspend from the app's or the OS's, so we
never resume a context someone else deliberately suspended. `isAutoSuspended()`
exposes it for a HUD. If auto-suspend ever needs to work on iOS, the correct path is
a page-visible "tap to wake" affordance, not a silent `resume()`.
