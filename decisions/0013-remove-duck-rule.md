# 0013 -- removeDuckRule(triggerBus, targetBus)

- Status: accepted
- Date: 2026-08-15
- Package: `@zakkster/lite-audio`
- Session: PS4 (v2.9.0)
- Related: 0003 (manual duck / sidechain latch -- why `duckManual` wins over a
  follower), 0011 (PS2 monitor idle-sleep -- the `_monitorIdle()` mechanism this
  completes, whose C3 check reads `_duckRules`), 0010 (bus-tombstone -- why a
  destroyed target bus is absent from `_buses`), SPATIAL_ROADMAP section 7
  (post-suite backlog)

## Context

`duckOn(triggerBus, targetBus, opts)` pushes a follower rule onto `_duckRules`
and arms the shared ~10 Hz monitor. Until PS4 there was no way to REMOVE a rule:
`_duckRules` was emptied only at `destroy()`. That made duck rules the ONE
permanent monitor consumer -- decision 0011's `_monitorIdle()` returns awake
whenever `_duckRules.length !== 0` (check C3), so a `duckOn`-only engine could
never idle-sleep. The v2.7.0 llms.txt bullet itself flagged "a removeDuckRule API
is separate backlog". PS4 closes that loop.

`removeDuckRule(triggerBus, targetBus) -> boolean` removes every `_duckRules`
entry matching the `(trigger, target)` pair, safely recovers any target it was
actively dipping, and -- when it removes the last consumer -- lets the shared
monitor sleep on its next tick via the existing PS2 mechanism. It is the
symmetric teardown counterpart to `duckOn`. It is a cold, zero-alloc call off
every hot path; `play`/`stop`/`setPosition`/`_evalDuckRules`/`_monitorIdle`
bodies are byte-unchanged and both `HashParity` goldens stay frozen.

## Decisions

### D1 -- pair-keyed; opts are not part of the key

A rule is keyed by the `(triggerBus, targetBus)` PAIR, symmetric with
`duckOn(triggerBus, targetBus, opts)`. The `opts` (threshold/level/attack/
release) are NOT part of the key: a caller removes "the follower from trigger to
target", regardless of how it was tuned. Matching on opts too would force a
caller to reconstruct the exact tuning they registered with just to remove a
rule -- a footgun with no use case.

### D2 -- remove ALL duplicate matches

`duckOn` does not dedupe, so a caller can register the same `(trigger, target)`
pair more than once. `removeDuckRule` removes EVERY matching row in one pass, not
the first. "Remove the follower" means the follower is gone; leaving a duplicate
behind would be a silent partial removal. Returns `true` iff `>= 1` row was
removed, else `false` (idempotent).

### D3 -- stranded-target recovery is fail-CLOSED, gated

If a removed rule was `active` (it had dipped its target), the target's
`duckGain` is released back to `DUCK_REST` -- but ONLY when it is safe:

| removed rule.active | target exists | target.duckManual | surviving active rule on target | action |
|---|---|---|---|---|
| false | -- | -- | -- | none (never dipping) |
| true  | no  | -- | -- | none (bus gone; nothing to recover) |
| true  | yes | true  | -- | none (manual duck wins; `stopDuck` owns it) |
| true  | yes | false | yes | none (a surviving active rule legitimately holds it) |
| true  | yes | false | no  | `setTargetAtTime(DUCK_REST, ctx.currentTime, releaseTC)` |

A bus stuck silent forever is the fail-OPEN outcome we refuse to ship, so the
DEFAULT direction is recovery to rest. The three gates each prevent a WRONG
recovery: recovering a bus under a manual duck would fight `stopDuck` (0003);
recovering a bus another active rule holds dipped would un-dip it audibly (and
edge-gating means the survivor would NOT re-dip); recovering an absent bus would
throw. The "surviving active rule on the same target" check is computed over the
rules that REMAIN after compaction, so a target dipped by two rules is recovered
only once BOTH are gone (or the survivor is inactive).

### D4 -- zero-alloc, order-preserving in-place compaction

Removal is a single forward pass with a write index `w`: each non-match is
copied down to `rules[w++]`, each match is dropped. After the pass the vacated
tail `rules[w..len)` is nulled (see D7) and `rules.length = w` truncates. No
`splice` (O(n) shifts plus it can reallocate) and no `filter` (allocates a new
array + closure garbage). Order is preserved, so a caller's rule evaluation order
is stable across removals. The only extra work is a second small scan of
survivors, and only when a removed rule was active (R2) -- O(rules), off the hot
path, zero alloc; rules are few.

### D5 -- first-removed rule's release governs the single recovery ramp

When duplicate rules with differing `.release` TCs are removed together, they
collapse to ONE recovery ramp on the shared target. The FIRST-removed matching
rule's `.release` governs that ramp (captured once, on the first match). A single
correct-direction recovery beats N competing ramps or a stuck bus; duplicates
with differing release are already an edge (R1). The rule's `.release` -- not
`busRec.duckRelease` -- is used, because the RULE's release is what a caller
tuned for THIS follower's recovery; `busRec.duckRelease` is the manual-duck
memory owned by `duck()`/`stopDuck()` (R3). Keeping them distinct avoids a manual
`duck({release})` silently reshaping an automatic removal.

The recovery ramp is a bare `setTargetAtTime(DUCK_REST, ...)` with no
`cancelScheduledValues` first -- byte-for-byte the same shape as `stopDuck`
(Audio.js). If an `applySnapshot` `linearRamp` on the same `duckGain` is
mid-flight, the two layer briefly; the interaction is benign (both converge to
`DUCK_REST`) and deliberately consistent with the existing `stopDuck` recovery,
not a special case.

### D6 -- never poke the monitor; sleep is the next-tick `_monitorIdle` (PS2)

`removeDuckRule` NEVER touches `_monitorTimer` or calls `_startMonitor`. When it
empties the last duck consumer, the shared monitor sleeps on its NEXT
`_monitorIdle()` tick -- decision 0011's mechanism: the tick's tail stops
rescheduling once no consumer is live, and `_duckRules.length === 0` is exactly
C3 of that predicate. This IS the PS4 win: a `duckOn`-only engine can finally
idle-sleep, completing PS2. Arming/sleeping the monitor here would duplicate PS2
state (a double-arm/double-free hazard the tick already guards against via
`if (this._monitorTimer != null) return;`) for no gain -- the tick already owns
that transition.

### D7 -- null the vacated tail before truncating (retention)

After compaction, `rules[w..len)` still holds references to the survivor objects
the write index copied DOWN (the compaction leaves stale duplicates in the tail).
The loop `for (let i = w; i < len; i++) rules[i] = null` drops those references
BEFORE `rules.length = w`, so a removed rule object cannot be retained by the
array's backing store past its removal. This is the retention assertion (A3): a
build that omits the null loop would let the backing store pin removed rules, and
the lite-leak witness would catch it.

### D8 -- extend T-SP8, no new torture tier

No new torture tier is added. T-SP8 (the PS2 sleep-wake tier) is the only tier
with the mock-scheduler rig that can observe `_monitorTimer` / pending state
deterministically, and C3 (`_duckRules`) is the consumer check PS4 exercises --
the duck-sleep path belongs beside the meter / positional / width / autoSuspend
sleep paths it sits with. A separate tier would duplicate the rig for no added
coverage. qa extends T-SP8 with a duck phase plus a retention loop.

## Proof

- **Correctness (A4/A5).** `test/DuckRule.test.js` -- a node:test boundary suite
  (qa owns it). It pins: destroyed engine / unknown pair / null / undefined /
  non-string args all return `false` without throwing and leave `_duckRules`
  unchanged; a duplicate `(trigger, target)` removes ALL matches and returns
  `true`; order preservation (A,B,C,D remove B -> A,C,D); the stranded-target
  matrix via a spy on `duckGain.gain.setTargetAtTime` (exactly ONE
  `setTargetAtTime(DUCK_REST, t, removedRelease)` when the target is free; ZERO
  writes when a surviving active rule holds it, when the target is under
  `duckManual`, when the target bus is absent, and when the removed rule was
  inactive); the D5 dup-differing-release pin (the single ramp uses the
  first-removed rule's `.release`); and remove-then-re-add (a `duckOn` after
  `removeDuckRule` re-arms the monitor and dips again on the next edge).
  Verified: 28 `removeDuckRule` cases, all green (`node --expose-gc --test
  test/*.test.js` -> 416 tests / 416 pass / 0 fail, up from the 388 baseline).
- **Sleep / retention / zero-alloc (A1/A2/A3).** `test/torture.mjs` T-SP8 phase
  (g) -- phase (f) is the pre-existing `_monitorIdle` allocation phase, so the
  duck path takes the next letter. Verified: `duckOn` as sole consumer -> monitor
  awake; `removeDuckRule` empties the last rule -> the next flush leaves
  `_monitorTimer === null`, scheduler pending 0, and the tick counter frozen at 1
  across 10 further flushes. The retention loop of 100000 `duckOn`/
  `removeDuckRule` cycles (an active dip each cycle) ends with
  `_duckRules.length === 0`, lite-leak witnessing 0 un-released records, 0
  incomplete removals, and a live-node delta of 0. `node --expose-gc
  test/torture.mjs` exits 0 with every tier `major=0`.
- **Goldens frozen (A5) / no hot-path drift (A6).** Both `HashParity` goldens are
  byte-identical to 2.8.0; the diff is confined to `Audio.js:10` (VERSION) + the
  new `removeDuckRule` method + `Audio.d.ts` + `llms.txt` + `CHANGELOG.md` + this
  decision + `package.json`. The hot bodies (`play`/`stop`/`setPosition`/
  `_evalDuckRules`/`_monitorIdle`) are byte-unchanged and never call
  `removeDuckRule` (grep proof). PS4 adds no hot-path arg or branch, so no
  re-baseline.
