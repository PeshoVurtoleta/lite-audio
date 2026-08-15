# 0011 -- monitor idle refcount / sleep-wake

- Status: accepted
- Date: 2026-08-15
- Package: `@zakkster/lite-audio`
- Session: PS2 (v2.7.0)
- Related: 0010 (destroyBus -- D5 explicitly parked this and named the
  requirement: "must count meters + duck + auto-suspend + positional consumers
  together"), 0005 (auto-suspend -- the `_selfSuspended` latch this wakes from),
  SPATIAL_ROADMAP section 7 (post-suite backlog)

## Context

The shared ~10 Hz monitor (`_startMonitor`) reschedules itself UNCONDITIONALLY
from the first consumer registration until `destroy()`. With zero live consumers
it still burns a timer every `MONITOR_INTERVAL_MS = 100` doing seven empty-list
early-returns. Before 0010 the zero-consumer state was barely reachable at
runtime (consumers were added, never removed); now `destroyBus` can remove the
last metered/discrete/positional/width consumer and `disableAutoSuspend` the
auto-suspend one, so a live app can reach zero consumers and keep paying for a
monitor that does nothing.

PS2 makes the tick evaluate a cold, allocation-free idle predicate at its END and
simply SKIP the reschedule when no consumer is live. The already-ubiquitous
`_startMonitor()` calls are the wake path, and `_startMonitor`'s
`if (this._monitorTimer != null) return;` guard makes a slept monitor (timer
null) restart correctly on the next registration. Zero hot-path bytes: `play()`,
`stop()`, `setPosition()` are byte-unchanged; both `HashParity` goldens frozen.

## Decisions

### D1 -- SLEEP by not rescheduling; do NOT clear a timer

The tick already nulls `_monitorTimer` at its head, so skipping the reschedule at
the tail is a complete sleep with no state to unwind: the field is already null,
there is no pending timer id to release (the callback has fired), and no other
state records the monitor as running. `destroy()` and `_startMonitor` both guard
on that same field, so a slept monitor makes `destroy()` a no-op (no double-free,
`_clearTimeout` is never called on a spent id) and a wake arms exactly one timer.

### D2 -- liveness is derived from each walker's OWN skip, never a construction flag

`busRec.positional` is assigned once at construction and is NEVER cleared by
`destroyBus` (it tombstones the record but leaves `positional` set). A predicate
reading `busRec.positional` would treat every tombstone husk as a permanent live
consumer -> the monitor would never sleep after `destroyBus`, making the feature
a silent no-op in its headline scenario. So C5 liveness is
`pool !== null && posDirty !== null` -- the literal negation of `_flushPositions`'
own skip conditions, and likewise `wideIn !== null` for width (`_flushWidth`'s
skip) and `hrtfWarmHandle !== null` for the HRIR prewarm (`_retireHrtfWarm`'s
skip). Predicate and walker can never disagree because each clause is the walker's
skip line negated. `if (busRec.dead) continue;` drops a husk in one branch.

### D3 -- a consumer counts for its whole lifetime, not per pending work item

A positional/discrete/metered/width bus counts as a consumer for its whole life,
so `setPosition()` / `setWidth()` never need to wake anything and the hot bodies
stay byte-identical. Pending-work liveness (wake only when there is a dirty bit to
flush) would need a `_startMonitor()` call from `setPosition` / `setWidth` -- a
hot-path branch. Rejected under the Law. Both `HashParity` goldens stay frozen.

### D4 -- auto-suspend counts only while `_autoSuspend && !_selfSuspended`, and the wake precedes the ctx guard

`_evalAutoSuspend` early-returns forever once `_selfSuspended` is set, so sleeping
in that window computes nothing today's ticking monitor would. The sole
`_selfSuspended = false` writer is `_wakeFromAutoSuspend` (called from `play()`),
so it becomes the wake: `_startMonitor()` is placed IMMEDIATELY after
`_selfSuspended = false` and BEFORE the `if (!ctx || typeof ctx.resume !==
'function') return;` guard, so a context lacking `resume` still re-arms the
monitor -- fail-closed ordering; returning first would leave silence-tracking
permanently dead. The alternative ("consumer always while enabled") would mean any
app calling `enableAutoSuspend()` -- the single most common reason the monitor runs
-- never sleeps, gutting the feature. The `statechange` listener only mirrors state
into a signal and is not, and cannot be, a wake path. ACCEPTED pre-existing gap
(R4, not a regression): if the app resumes the context itself without ever calling
`play()`, `_selfSuspended` stays true forever and `_evalAutoSuspend` early-returns
forever; auto-suspend is already dead in that state today, PS2 additionally lets
the monitor sleep in it -- no behavior lost, only a wasted timer. A
statechange-driven un-latch is out of scope.

### D5 -- duck rules are a PERMANENT consumer, by omission not by design

No public API removes a `_duckRules` entry (`stopDuck` clears only the manual duck
latch, not the follower rule); the array is emptied only at `destroy()`. A
`duckOn` engine therefore never sleeps. The predicate's `_duckRules.length !== 0`
is honest about this. Accepted and documented; a `removeDuckRule` API is a
separate backlog item, so T-SP8 exercises meters / positional / discrete / width /
`disableAutoSuspend` as the removable consumers, NOT `stopDuck`.

### D6 -- the predicate FAILS CLOSED toward AWAKE

Any unreadable or ambiguous state returns `false` (not idle) and keeps ticking. A
wrongly-slept monitor is silent breakage (frozen positions, a duck that never
fires, silence never detected); a wrongly-awake monitor costs one timer. null is
not zero. R5 (a future consumer added without a predicate clause sleeps silently)
is mitigated structurally: the `_monitorIdle` JSDoc carries the contract line
"every new monitor consumer MUST add a clause here, mirroring its walker's skip
condition."

## Proof

Torture tier **T-SP8** (`test/torture.mjs`): builds an idle engine on a REAL
mock scheduler (no-op timers would make the scheduling subject vacuous) and
asserts (a) awake with a live consumer -> the tick fires and `pending() === 1`;
(b) sleeps at zero -> after removing every dynamic consumer and
`disableAutoSuspend`, one more flush leaves `_monitorTimer === null` and the tick
counter frozen across further flushes; (c) wakes -> a new metered bus re-arms
`_monitorTimer` and ticks resume; (d) census/retention over `SP8_CYCLES = 4096`
sleep/wake cycles -> `tracker.size() === 0`, live-node delta 0, `pending() === 0`;
(e) auto-suspend integrity -> counts down without sleeping, then sleeps once
self-suspended, then `play()` wakes it (the T4 lock); (f) allocation -> 500,000
`_monitorIdle()` calls on a 4-bus engine at `maxMajor: 0`, `maxPauseMs <= 4`,
`<= 0.05 B/op`. Red control **`LITEAUDIO_TORTURE_SP8_RED=1`** models a predicate
that OMITS the auto-suspend clause: with auto-suspend armed and counting down and
no other consumer, the monitor sleeps, `_evalAutoSuspend` never runs again,
`_silentSince` never matures, the context is never suspended, phase (e) sees
`isAutoSuspended() === false`, and the gate exits non-zero. Boundary suite
`test/MonitorIdle.test.js` pins the predicate per consumer (including the
positional-vs-`posDirty` trap, the tombstone-husk non-consumer, the `stopDuck`
permanence, and the 3b `_selfSuspended` ruling), the sleep/wake tick observable,
the `destroy()`-on-slept no-double-free, and the T3/T4 wake fixes. Both
`HashParity` goldens are frozen; the hot bodies are byte-unchanged.
