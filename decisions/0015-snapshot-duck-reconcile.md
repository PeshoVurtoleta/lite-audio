# 0015 -- applySnapshot reconciles a live duck rule (ride-through)

- Status: accepted
- Date: 2026-08-15
- Package: `@zakkster/lite-audio`
- Session: PS6 (v2.11.0)
- Related: 0003 (ducking -- the `_evalDuckRules` edge-gate this reconciles
  against), 0004 (snapshots -- the sidechain-morph `applySnapshot` extends),
  0013 (removeDuckRule -- the in-place indexed `_duckRules` scan idiom reused
  here), the hot `_evalDuckRules` loop (`Audio.js` `_evalDuckRules`, byte-frozen),
  SPATIAL_ROADMAP section 7 (post-suite backlog -- the LAST item)

## Context

`applySnapshot(name, ms)` restates the mix: it sets each touched bus's volume/mute
signals to their captured targets, pins the bus gain, rests the bus's sidechain
(`duckGain -> DUCK_REST`), and drops any manual duck latch (`duckManual = false`).
It is the mix-recall counterpart to `captureSnapshot`.

An automatic `duckOn(triggerBus, targetBus)` rule dips its target while the trigger
has `>= threshold` voices. `_evalDuckRules` is EDGE-gated for zero steady-state
cost: `if (shouldDuck === rule.active) continue;` -- it writes a `setTargetAtTime`
only when the trigger CROSSES the threshold. That edge-gate is the bug's cause
here: after `applySnapshot` rests a bus that an active rule was dipping, `rule.active`
is still `true`, so a trigger STILL above threshold produces `shouldDuck === true ===
rule.active` -- no edge, no write. The bus stays un-ducked (rested at the snapshot's
level) until the trigger stops and re-crosses the threshold. A designer who applies
a "combat" snapshot while gunfire is already sounding would hear the music duck
never re-engage until the gunfire lulls -- a stall, not a design.

PS6 reconciles a still-hot rule against the snapshot WITHOUT adding a byte to the
hot loop and WITHOUT stranding the bus.

## Decisions

### D1 -- a still-hot duck RIDES THROUGH the snapshot (no hot-loop byte, no param write)

An ACTIVE `duckOn` rule whose trigger is STILL HOT is left ENGAGED across the
snapshot: `applySnapshot` leaves the sidechain where the live duck holds it
(dipped) and leaves `rule.active === true`. It writes NO AudioParam for that bus --
no `cancelScheduledValues`, no rest, no gain-morph pin. The bus's volume/mute are
still restated by the signals (click-free at `RAMP_TC`), but the sidechain is not
touched: the live duck's own `setTargetAtTime(level, ...)` keeps approaching `level`
naturally, and the EXISTING `_evalDuckRules` edge (`active:true -> shouldDuck:false`)
rests it to `DUCK_REST` when the trigger later drops. So the reconcile adds NO
branch, arg, or param write to `_evalDuckRules`; both `HashParity` goldens stay
frozen (D5).

This is a REVISION of the first PS6 draft, and the revision matters. The first draft
RESET `rule.active = false` for every active rule the snapshot rested and let the
next tick re-edge (and, on the `ms>0` path, SKIPPED the `DUCK_REST` rest-ramp when
the bus was still hot to avoid a ramp-vs-tick fight). That draft STRANDED the bus:
a rule dips `duckGain` to `d < DUCK_REST`; the snapshot resets `active=false` and,
because the bus was hot, wrote `setValueAtTime(d, now)` with NO scheduled move; if
the trigger then went COLD before the next ~10 Hz tick, `_evalDuckRules` saw
`shouldDuck=false === active=false`, `continue`d, wrote nothing, and left `duckGain`
stranded at `d` -- the bus quieter than the mix states, a fail-OPEN regression from
2.10.0 (which always ramped to `DUCK_REST`). The ride-through closes that hole: a
hot duck is never un-latched mid-dip, so there is no window where `active` and the
sidechain disagree.

### D2 -- a STALE active rule (trigger cold) is reset and rested to DUCK_REST

An ACTIVE rule whose trigger has ALREADY gone cold is a STALE duck: the mix should
not stay dipped for it. For a stale rule `applySnapshot` resets `rule.active = false`
and lets the normal rest path run -- `ms=0` snaps the sidechain to `DUCK_REST` at
`now`; `ms>0` pins the bus gain and `linearRampToValueAtTime(DUCK_REST, now+ms/1000)`
from the continuous `curProduct/tgtEff` start. This is strand-free: the sidechain
always lands at (or ramps to) `DUCK_REST`, never at a dipped value with no scheduled
move. A NOT-yet-active rule (never dipped, or already rested) is untouched by the
scan and re-ducks on its next `_evalDuckRules` edge from the safe `DUCK_REST` value.
The `heldHot` decision is per bus: if ANY active rule on the bus is still hot the
bus rides through (the loudest live duck wins the bus); otherwise the bus rests and
every stale rule on it is reset.

### D3 -- reset scoped to RESTED buses only

The rule scan runs INSIDE the `applySnapshot` bus loop, keyed on
`rule.targetBus === snap.names[i]`, and only after the `if (!busRec) continue;`
guard. So a rule is reset only when the snapshot actually RESTED that bus (the bus
exists and the snapshot names it). A bus the snapshot does not name, a
`continue`d non-existent bus, or a rule whose target is untouched: never reset,
`rule.active` preserved. The snapshot restates only the buses it names; a hot rule
on an untouched bus is correctly left dipping (R2).

### D4 -- reuse removeDuckRule's in-place indexed scan; zero-alloc

The scan is a plain indexed `for (let r = 0; r < rules.length; r++)` over
`this._duckRules`, mirroring `removeDuckRule`'s idiom -- no `Set`/`filter`/`splice`/
closure, no allocation. It reads `rule.targetBus`, reads `trig.pool.activeCount()`
(documented zero-alloc) to decide hot vs cold, and either sets `heldHot` (ride
through) or flips `rule.active = false` (stale reset). `applySnapshot`
is a cold, caller-frame method off every hot path, so it MAY allocate incidentally
-- it does not; the scan is O(names x rules) with zero bytes per op, which the
T-DCK1 torture tier's GC window pins.

### D5 -- HashParity goldens frozen; no hot-path drift

`_evalDuckRules`, `play`, `stop`, `setPosition`, and `_monitorIdle` are
byte-identical to 2.10.0. The only `Audio.js` diff is the `VERSION` const, the
`applySnapshot` body (the ride-through reconcile scan + `heldHot` branch), and its JSDoc.
No hot-path byte changes, so both `HashParity` goldens are unchanged -- ZERO
re-baseline. A moved golden would mean something hot changed and is a STOP.

## Proof

- **Correctness / fail-closed (boundary suite).** `test/MixIntelligence.test.js`
  gains 21 node:test cases across six PS6 `describe` groups (ride-through
  reconcile, rule-population 0/1/N-1/N/N+1 sweep, `applySnapshot(name, ms)`
  argument matrix, duplicate `destroy()`, `effect()` re-entrancy, adversarial
  `valueOf`/`toString` type-confusion on `targetBus`). They pin: hot trigger
  rides through (sidechain stays dipped + `rule.active` true, ZERO new duckGain
  write, verified via `paramEvents`); hot-then-cold-before-tick rests to
  `DUCK_REST` via the edge, never stranded dipped; stale active rule reset +
  rested at ms=0 and ms>0; not-yet-active rule re-ducks from `DUCK_REST` on its
  next edge; two-rules-same-target one-hot-one-cold -> hot rides
  (`active:true`), cold reset (`active:false`); untouched-bus preserved, no-rule
  identity-equal + `_duckRules.length` unchanged, `duckManual` cleared,
  unknown/destroyed no-op, empty `_duckRules`, `destroyBus`-after-capture bus
  `continue`d, prior-apply-ramp-in-flight + re-hot + second apply never
  strands. Gate run: `node --expose-gc --test test/*.test.js` -> **462 tests,
  462 pass, 0 fail, 0 skipped** (baseline before this suite 441/441/0/0; +21).
- **Retention / zero-alloc (torture).** `test/torture.mjs` NEW tier **T-DCK1**,
  built on a real running engine (an `sfx` trigger with a decoded `laser` sound
  + a `music` target, unlocked so `play('laser')` makes `sfx` genuinely hot and
  `stopAll()` drops it cold -- the same hot/cold mechanism the boundary suite's
  `boot()` uses, so `applySnapshot` and `_evalDuckRules` both read a real
  `pool.activeCount()`). Three phases, all green on the run that produced these
  numbers: (a) a hot `duckOn` rule survives `applySnapshot('base', 250)` with
  `music` held dipped and the rule left active; after a hot->cold race one tick
  rests `music` to `DUCK_REST=1` via the existing edge -- never stranded. (b) a
  **20,000**-cycle `play/tick/applySnapshot(250)/stopAll/tick` soak on a
  `createLeakTracker` witness: **0** un-released records, **0** stranded cycles,
  `_duckRules.length` constant at **1**, live-node census delta **0**. (c) the
  reconcile scan over **200,000** hot-rule ride-through `applySnapshot` calls:
  `major=0 minor=0 maxMs=0.00`, **0.0000 B/op** (`maxMajor:0`/`maxPauseMs<=4`
  held). RED control `LITEAUDIO_TORTURE_DCK1_RED=1` swaps in the SUPERSEDED
  first-draft `applySnapshot` (reset `rule.active=false` for every active rule +
  SKIP the `DUCK_REST` rest-ramp while the bus is hot): the (a) witness then sees
  `music` **STRANDED dipped at 0.3000** after the hot->cold race, the gate prints
  `torture: FAIL -- T-DCK1 (a) LITEAUDIO_TORTURE_DCK1_RED: ...` and **exits 1**;
  the normal path exits **0**. Full gate: `node --expose-gc test/torture.mjs` ->
  exit **0**, every tier (including T-DCK1) `major=0`, and none of the
  pre-existing tiers' numbers moved (T-SP1..T-SP8/T-SP3-lane/T-SP7/T-TRK1
  identical to the pre-PS6 baseline).
- **Goldens frozen / no hot-path drift (D5).** All three `HashParity` goldens are
  byte-identical to 2.10.0 (they pass inside the 462-case node:test run);
  `git diff HEAD -- Audio.js` is confined to the `VERSION` line + the
  `applySnapshot` method body + its JSDoc, and the hot bodies
  (`_evalDuckRules`/`play`/`stop`/`setPosition`/`_monitorIdle`) are byte-unchanged
  (grep-confirmed). PS6 adds no hot-path arg or branch, so no re-baseline.
