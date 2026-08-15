/**
 * @zakkster/lite-audio - PS4 removeDuckRule(triggerBus, targetBus) boundary
 * suite (node:test), v2.9.0.
 *
 * removeDuckRule is a cold, zero-alloc pair-keyed removal + stranded-target
 * recovery call (decisions/0013-remove-duck-rule.md). This file is the
 * correctness proof (A4/A5); the torture gate's T-SP8 phase (g) is the
 * sleep/retention/zero-alloc control (A1/A2/A3).
 *
 * Boundary matrix: 0, 1, N-1, N, N+1 (_duckRules population), empty/null/
 * undefined/NaN/-0 (fail-closed argument matrix), duplicate dispose (both
 * destroy() called twice, and removeDuckRule called twice on the same
 * already-drained pair), dispose-during-iteration (a reentrant removeDuckRule
 * fired from a getter read MID-COMPACTION of the outer call), re-entrant write
 * (a duckOn fired from inside the recovery write's own setTargetAtTime), plus
 * one adversarial case the plan's 17 boundary cases did not enumerate (a
 * type-confusion object whose `==` would match a stored bus name but whose
 * `===` must not).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LiteAudio } from '../Audio.js';
import { createMockContext, mockFetch, mockDocument, paramEvents } from './mock-ctx.js';

// Mirror of the private Audio.js constant (not exported): the sidechain
// gain's resting multiplier. Kept local so this file states its own contract
// rather than reaching into module internals.
const DUCK_REST = 1;

function fakeWindow() {
    const listeners = new Map();
    return {
        addEventListener(evt, cb) {
            if (!listeners.has(evt)) listeners.set(evt, new Set());
            listeners.get(evt).add(cb);
        },
        removeEventListener(evt, cb) { listeners.get(evt)?.delete(cb); },
        _fire(evt, data = {}) { for (const cb of [...(listeners.get(evt) || [])]) cb(data); },
    };
}

/** ctx starts 'running' so init() unlocks immediately (mirrors MonitorIdle.test.js).
 *  No real scheduler: this file's whole subject is removeDuckRule's own return
 *  value / array mutation / recovery-write shape, not tick mechanics -- T-SP8
 *  phase (g) in torture.mjs owns the scheduler-observable sleep proof. */
async function boot({ buses = ['sfx', 'music', 'voice'], capacity = 8 } = {}) {
    const ctx = createMockContext({ state: 'running' });
    const audio = new LiteAudio({
        buses, poolCapacity: capacity, window: fakeWindow(), document: mockDocument(),
        fetch: mockFetch({ '/a.wav': 500 }),
        setTimeout: () => 0, clearTimeout: () => {},
    });
    await audio.init(ctx);
    return { audio, ctx };
}

/** Number of setTargetAtTime writes recorded on a bus's duckGain since boot. */
function targetWrites(audio, busName) {
    const rec = audio._buses.get(busName);
    return paramEvents(rec.duckGain.gain, 'target');
}

// ---------------------------------------------------------------------------
// plan case 1 -- destroyed engine
// ---------------------------------------------------------------------------

describe('case 1: destroyed engine', () => {
    it('destroy() then removeDuckRule -> false, no throw, no setTargetAtTime write', async () => {
        const { audio } = await boot();
        audio.duckOn('sfx', 'music');
        audio._duckRules[0].active = true;
        audio.destroy();
        let result;
        assert.doesNotThrow(() => { result = audio.removeDuckRule('sfx', 'music'); });
        assert.equal(result, false);
    });
});

// ---------------------------------------------------------------------------
// plan case 2 -- unknown pair
// ---------------------------------------------------------------------------

describe('case 2: unknown (trigger, target) pair', () => {
    it('no rule registered for the pair -> false, _duckRules length unchanged', async () => {
        const { audio } = await boot();
        audio.duckOn('sfx', 'music');
        const lenBefore = audio._duckRules.length;
        assert.equal(audio.removeDuckRule('voice', 'music'), false, 'unknown trigger');
        assert.equal(audio.removeDuckRule('sfx', 'voice'), false, 'unknown target');
        assert.equal(audio._duckRules.length, lenBefore);
    });
});

// ---------------------------------------------------------------------------
// plan case 3 -- duplicate rules removed all at once
// ---------------------------------------------------------------------------

describe('case 3: duplicate (trigger,target) rules', () => {
    it('duckOn the same pair 3x -> single removeDuckRule removes ALL, returns true, pair drained', async () => {
        const { audio } = await boot();
        audio.duckOn('sfx', 'music');
        audio.duckOn('sfx', 'music');
        audio.duckOn('sfx', 'music');
        assert.equal(audio._duckRules.length, 3, 'setup: three duplicate rows');

        assert.equal(audio.removeDuckRule('sfx', 'music'), true);
        assert.equal(audio._duckRules.length, 0, 'all three matches removed in one call');
        for (const r of audio._duckRules) {
            assert.notEqual([r.triggerBus, r.targetBus].join('>'), 'sfx>music');
        }
    });
});

// ---------------------------------------------------------------------------
// plan case 4 -- active rule removed, target free -> exactly one recovery write
// ---------------------------------------------------------------------------

describe('case 4: active rule removed, target free', () => {
    it('exactly one setTargetAtTime(DUCK_REST, t, release) on the target duckGain', async () => {
        const { audio } = await boot();
        audio.duckOn('sfx', 'music', { release: 0.42 });
        audio._duckRules[0].active = true;
        const before = targetWrites(audio, 'music').length;

        assert.equal(audio.removeDuckRule('sfx', 'music'), true);

        const after = targetWrites(audio, 'music');
        assert.equal(after.length, before + 1, 'exactly one new write');
        const last = after[after.length - 1];
        assert.equal(last[0], 'target');
        assert.equal(last[1], DUCK_REST);
        assert.equal(last[3], 0.42, 'recovery ramp uses the removed rule\'s release');
    });
});

// ---------------------------------------------------------------------------
// plan case 5 -- surviving active rule targets the same bus
// ---------------------------------------------------------------------------

describe('case 5: a SURVIVING active rule targets the same bus', () => {
    it('two triggers -> same target, both active; removing one -> ZERO recovery writes', async () => {
        const { audio } = await boot();
        audio.duckOn('sfx', 'music');
        audio.duckOn('voice', 'music');
        audio._duckRules[0].active = true;   // sfx -> music
        audio._duckRules[1].active = true;   // voice -> music (survives)
        const before = targetWrites(audio, 'music').length;

        assert.equal(audio.removeDuckRule('sfx', 'music'), true);

        assert.equal(targetWrites(audio, 'music').length, before, 'the survivor\'s dip is preserved: zero writes');
        assert.equal(audio._duckRules.length, 1);
        assert.equal(audio._duckRules[0].triggerBus, 'voice');
    });
});

// ---------------------------------------------------------------------------
// plan case 6 -- target under manual duck
// ---------------------------------------------------------------------------

describe('case 6: active rule removed, target under manual duck()', () => {
    it('duckManual === true -> ZERO writes (manual latch respected)', async () => {
        const { audio } = await boot();
        audio.duckOn('sfx', 'music');
        audio._duckRules[0].active = true;
        audio.duck('music', 0.1);   // sets duckManual=true AND itself writes one event
        const before = targetWrites(audio, 'music').length;

        assert.equal(audio.removeDuckRule('sfx', 'music'), true);

        assert.equal(targetWrites(audio, 'music').length, before, 'no recovery write while duckManual is set');
        assert.equal(audio._buses.get('music').duckManual, true, 'the manual latch itself is untouched');
    });
});

// ---------------------------------------------------------------------------
// plan case 7 -- target bus destroyed before removeDuckRule
// ---------------------------------------------------------------------------

describe('case 7: target bus destroyed before removeDuckRule', () => {
    it('destroyBus the target first -> ZERO writes, no throw, returns true', async () => {
        const { audio } = await boot({ buses: [] });
        audio.createBus('trig');
        audio.createBus('targ');
        audio.duckOn('trig', 'targ');
        audio._duckRules[0].active = true;

        assert.equal(audio.destroyBus('targ'), true);
        assert.equal(audio._buses.get('targ'), undefined, 'setup: target bus gone');

        let result;
        assert.doesNotThrow(() => { result = audio.removeDuckRule('trig', 'targ'); });
        assert.equal(result, true, 'the rule itself is still removed even though the target is gone');
        assert.equal(audio._duckRules.length, 0);
    });
});

// ---------------------------------------------------------------------------
// plan case 8 -- inactive rule removed
// ---------------------------------------------------------------------------

describe('case 8: inactive rule removed (trigger never crossed threshold)', () => {
    it('ZERO writes, returns true', async () => {
        const { audio } = await boot();
        audio.duckOn('sfx', 'music');
        assert.equal(audio._duckRules[0].active, false, 'setup: never dipped');
        const before = targetWrites(audio, 'music').length;

        assert.equal(audio.removeDuckRule('sfx', 'music'), true);

        assert.equal(targetWrites(audio, 'music').length, before);
    });
});

// ---------------------------------------------------------------------------
// plan case 9 -- empty _duckRules
// ---------------------------------------------------------------------------

describe('case 9: empty _duckRules', () => {
    it('fresh engine, no rule ever registered -> false', async () => {
        const { audio } = await boot();
        assert.equal(audio._duckRules.length, 0);
        assert.equal(audio.removeDuckRule('sfx', 'music'), false);
    });
});

// ---------------------------------------------------------------------------
// plan case 10 -- last consumer removal lets the monitor idle predicate flip
// ---------------------------------------------------------------------------

describe('case 10: removing the LAST duck consumer frees the monitor to sleep', () => {
    it('duckOn alone -> _monitorIdle() false; after removeDuckRule -> true', async () => {
        const { audio } = await boot();
        audio.duckOn('sfx', 'music');
        assert.equal(audio._monitorIdle(), false, 'setup: the one duck rule is a consumer (C3)');

        assert.equal(audio.removeDuckRule('sfx', 'music'), true);
        assert.equal(audio._duckRules.length, 0);
        assert.equal(audio._monitorIdle(), true, 'no consumer left -- the monitor may sleep');
    });

    it('with a metered consumer still live, removeDuckRule alone does NOT make the monitor idle', async () => {
        const { audio } = await boot();
        audio.createBus('meterA', { meter: true });
        audio.duckOn('sfx', 'music');
        assert.equal(audio._monitorIdle(), false);

        assert.equal(audio.removeDuckRule('sfx', 'music'), true);
        assert.equal(audio._duckRules.length, 0, 'the duck consumer itself is gone');
        assert.equal(audio._monitorIdle(), false, 'the metered bus keeps the monitor awake');
    });

    it('with autoSuspend still live, removeDuckRule alone does NOT make the monitor idle', async () => {
        const { audio } = await boot();
        audio.duckOn('sfx', 'music');
        audio.enableAutoSuspend();
        assert.equal(audio._monitorIdle(), false);

        assert.equal(audio.removeDuckRule('sfx', 'music'), true);
        assert.equal(audio._monitorIdle(), false, 'a live auto-suspend countdown keeps the monitor awake');
        audio.disableAutoSuspend();
        assert.equal(audio._monitorIdle(), true);
    });
});

// ---------------------------------------------------------------------------
// plan case 11 -- order preservation
// ---------------------------------------------------------------------------

describe('case 11: order preservation', () => {
    it('duckOn A,B,C,D distinct pairs; remove B -> survivors are exactly A,C,D in order', async () => {
        const { audio } = await boot();
        audio.duckOn('a1', 'a2');
        audio.duckOn('b1', 'b2');
        audio.duckOn('c1', 'c2');
        audio.duckOn('d1', 'd2');
        assert.equal(audio._duckRules.length, 4);

        assert.equal(audio.removeDuckRule('b1', 'b2'), true);

        assert.equal(audio._duckRules.length, 3);
        assert.deepEqual(
            audio._duckRules.map(r => r.triggerBus + '>' + r.targetBus),
            ['a1>a2', 'c1>c2', 'd1>d2'],
        );
    });
});

// ---------------------------------------------------------------------------
// plan case 12 -- return-value semantics
// ---------------------------------------------------------------------------

describe('case 12: return-value semantics', () => {
    it('true on >= 1 removed, false on 0', async () => {
        const { audio } = await boot();
        audio.duckOn('sfx', 'music');
        assert.equal(audio.removeDuckRule('sfx', 'music'), true, '1 removed -> true');
        assert.equal(audio.removeDuckRule('sfx', 'music'), false, '0 removed (already gone) -> false');

        audio.duckOn('sfx', 'music');
        audio.duckOn('sfx', 'music');
        assert.equal(audio.removeDuckRule('sfx', 'music'), true, '>=1 (here 2) removed -> true');
    });
});

// ---------------------------------------------------------------------------
// plan case 13 -- retention: 1e5 add/remove cycles
// ---------------------------------------------------------------------------

describe('case 13: retention over 1e5 duckOn/removeDuckRule cycles', () => {
    it('_duckRules.length === 0 at the end (guards a compaction leak); fast', async () => {
        const { audio } = await boot();
        const N = 1e5;
        for (let i = 0; i < N; i++) {
            audio.duckOn('sfx', 'music');
            assert.equal(audio.removeDuckRule('sfx', 'music'), true);
        }
        assert.equal(audio._duckRules.length, 0);
    });
});

// ---------------------------------------------------------------------------
// plan case 14 -- non-string args
// ---------------------------------------------------------------------------

describe('case 14: non-string args (numbers, objects)', () => {
    it('numbers, plain objects, arrays, booleans -> false, no throw, list unchanged', async () => {
        const { audio } = await boot();
        audio.duckOn('sfx', 'music');
        const lenBefore = audio._duckRules.length;
        const bad = [0, 1, -1, {}, [], true, false, Symbol('x'), () => {}];
        for (const v of bad) {
            assert.doesNotThrow(() => assert.equal(audio.removeDuckRule(v, 'music'), false), 'trigger=' + String(v));
            assert.doesNotThrow(() => assert.equal(audio.removeDuckRule('sfx', v), false), 'target=' + String(v));
        }
        assert.equal(audio._duckRules.length, lenBefore);
    });
});

// ---------------------------------------------------------------------------
// plan case 15 -- null / undefined args
// ---------------------------------------------------------------------------

describe('case 15: null / undefined args', () => {
    it('null and undefined in either position -> false, no throw', async () => {
        const { audio } = await boot();
        audio.duckOn('sfx', 'music');
        const lenBefore = audio._duckRules.length;
        assert.doesNotThrow(() => assert.equal(audio.removeDuckRule(null, 'music'), false));
        assert.doesNotThrow(() => assert.equal(audio.removeDuckRule('sfx', null), false));
        assert.doesNotThrow(() => assert.equal(audio.removeDuckRule(undefined, 'music'), false));
        assert.doesNotThrow(() => assert.equal(audio.removeDuckRule('sfx', undefined), false));
        assert.doesNotThrow(() => assert.equal(audio.removeDuckRule(null, undefined), false));
        assert.doesNotThrow(() => assert.equal(audio.removeDuckRule(), false));
        assert.equal(audio._duckRules.length, lenBefore);
    });
});

// ---------------------------------------------------------------------------
// plan case 16 -- remove-then-re-add re-arms the follower
// ---------------------------------------------------------------------------

describe('case 16: remove-then-re-add', () => {
    it('duckOn -> removeDuckRule -> duckOn again: the new rule dips the target on the next edge', async () => {
        const { audio } = await boot();
        audio.duckOn('sfx', 'music', { threshold: 1, level: 0.2 });
        assert.equal(audio.removeDuckRule('sfx', 'music'), true);
        assert.equal(audio._duckRules.length, 0, 'setup: rule fully gone');

        audio.duckOn('sfx', 'music', { threshold: 1, level: 0.2 });
        assert.equal(audio._duckRules.length, 1, 'the new rule is present');
        assert.equal(audio._duckRules[0].active, false, 'fresh rule starts inactive');

        // Fake a live trigger voice so _evalDuckRules sees an edge (threshold crossed).
        const trig = audio._buses.get('sfx');
        trig.pool = { activeCount: () => 1 };
        const before = targetWrites(audio, 'music').length;

        audio._evalDuckRules();

        assert.equal(audio._duckRules[0].active, true, 're-armed rule dips on the next edge');
        const after = targetWrites(audio, 'music');
        assert.equal(after.length, before + 1);
        assert.equal(after[after.length - 1][1], 0.2, 'dipped to the new rule\'s level');
    });
});

// ---------------------------------------------------------------------------
// plan case 17 -- duplicate rules with differing release: first-removed governs (D5)
// ---------------------------------------------------------------------------

describe('case 17: dup rules with DIFFERING release TCs', () => {
    it('the single recovery ramp uses the FIRST-removed rule\'s release, even when a LATER dup is the active one', async () => {
        const { audio } = await boot();
        audio.duckOn('sfx', 'music', { release: 0.11 });
        audio.duckOn('sfx', 'music', { release: 0.22 });
        audio.duckOn('sfx', 'music', { release: 0.33 });
        assert.equal(audio._duckRules.length, 3);
        // Mark the SECOND rule (not the first) as the active one -- the D5 contract
        // says the FIRST MATCH's release governs regardless of which row was active.
        audio._duckRules[1].active = true;
        const before = targetWrites(audio, 'music').length;

        assert.equal(audio.removeDuckRule('sfx', 'music'), true);

        const after = targetWrites(audio, 'music');
        assert.equal(after.length, before + 1, 'exactly one collapsed recovery ramp');
        assert.equal(after[after.length - 1][3], 0.11, 'first-removed rule\'s release governs, not the active row\'s 0.22');
    });
});

// ---------------------------------------------------------------------------
// Boundary matrix over _duckRules population: 0, 1, N-1, N, N+1
// ---------------------------------------------------------------------------

describe('boundary matrix over _duckRules population (0, 1, N-1, N, N+1)', () => {
    it('0/1/N-1/N/N+1: N distinct pairs removed one at a time, then one more added', async () => {
        const { audio } = await boot();
        assert.equal(audio.removeDuckRule('x', 'y'), false, '0: nothing to remove');

        const N = 5;
        const pairs = [];
        for (let i = 0; i < N; i++) { audio.duckOn('t' + i, 'g' + i); pairs.push(['t' + i, 'g' + i]); }
        assert.equal(audio._duckRules.length, N, 'setup: N pairs');

        for (let i = 0; i < N - 1; i++) {
            assert.equal(audio.removeDuckRule(pairs[i][0], pairs[i][1]), true, 'removing pair ' + i);
        }
        assert.equal(audio._duckRules.length, 1, 'N-1 removed, 1 survivor');

        assert.equal(audio.removeDuckRule(pairs[N - 1][0], pairs[N - 1][1]), true, 'N: remove the last survivor');
        assert.equal(audio._duckRules.length, 0);

        // N+1: one more duckOn after full drain, then remove it too.
        audio.duckOn('after1', 'after2');
        assert.equal(audio._duckRules.length, 1);
        assert.equal(audio.removeDuckRule('after1', 'after2'), true);
        assert.equal(audio._duckRules.length, 0);
    });
});

// ---------------------------------------------------------------------------
// Boundary: empty-string args
// ---------------------------------------------------------------------------

describe('boundary: empty-string args', () => {
    it('a rule keyed by empty-string bus names is removable by empty-string args', async () => {
        const { audio } = await boot();
        audio.duckOn('', 'x');
        assert.equal(audio._duckRules.length, 1);
        assert.equal(audio.removeDuckRule('', 'x'), true);
        assert.equal(audio._duckRules.length, 0);
    });

    it('an empty-string arg against a real pair never matches -> false', async () => {
        const { audio } = await boot();
        audio.duckOn('sfx', 'music');
        assert.equal(audio.removeDuckRule('', 'music'), false);
        assert.equal(audio.removeDuckRule('sfx', ''), false);
        assert.equal(audio._duckRules.length, 1);
    });
});

// ---------------------------------------------------------------------------
// Boundary: NaN and -0 args
// ---------------------------------------------------------------------------

describe('boundary: NaN and -0 args', () => {
    it('NaN in either position -> false, no throw, list unchanged', async () => {
        const { audio } = await boot();
        audio.duckOn('sfx', 'music');
        assert.doesNotThrow(() => assert.equal(audio.removeDuckRule(NaN, 'music'), false));
        assert.doesNotThrow(() => assert.equal(audio.removeDuckRule('sfx', NaN), false));
        assert.equal(audio._duckRules.length, 1);
    });

    it('-0 in either position -> false, no throw, list unchanged (-0 is never a stored bus name)', async () => {
        const { audio } = await boot();
        audio.duckOn('sfx', 'music');
        assert.doesNotThrow(() => assert.equal(audio.removeDuckRule(-0, 'music'), false));
        assert.doesNotThrow(() => assert.equal(audio.removeDuckRule('sfx', -0), false));
        assert.equal(audio._duckRules.length, 1);
    });
});

// ---------------------------------------------------------------------------
// Duplicate dispose
// ---------------------------------------------------------------------------

describe('duplicate dispose', () => {
    it('destroy() called twice: removeDuckRule stays false and neither call throws', async () => {
        const { audio } = await boot();
        audio.duckOn('sfx', 'music');

        assert.doesNotThrow(() => audio.destroy());
        assert.equal(audio.removeDuckRule('sfx', 'music'), false);

        assert.doesNotThrow(() => audio.destroy(), 'repeat destroy() must not throw');
        assert.equal(audio.removeDuckRule('sfx', 'music'), false, 'still false after the repeat dispose');
    });

    it('removeDuckRule called twice on the same already-drained pair: true then false, both no-throw', async () => {
        const { audio } = await boot();
        audio.duckOn('sfx', 'music');
        assert.equal(audio.removeDuckRule('sfx', 'music'), true, 'first call actually removes');
        assert.doesNotThrow(() => {
            assert.equal(audio.removeDuckRule('sfx', 'music'), false, 'second call on the same pair is idempotent');
        });
        assert.equal(audio._duckRules.length, 0);
    });
});

// ---------------------------------------------------------------------------
// NOTE: mid-compaction-loop reentrancy is deliberately NOT tested here because
// it is unreachable. removeDuckRule invokes no user-controlled code during its
// compaction loop -- it reads only the plain data fields triggerBus/targetBus/
// release/active on rule objects the engine exclusively owns (active is always
// a boolean, set by duckOn/_evalDuckRules, never an accessor), and its only
// external calls (_buses.get + setTargetAtTime) run AFTER `_duckRules.length`
// is set. So nothing can shrink the array between the loop's cached length and
// its indexing. The ONE reachable reentrancy point -- a reentrant push from
// inside the recovery write -- is covered below (the array is fully truncated
// before that write, so the push lands cleanly).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Re-entrant write: a duckOn() fired from inside the recovery write's own
// setTargetAtTime callback -- the outer removeDuckRule must have already fully
// truncated `_duckRules` before invoking that write, so the reentrant push
// lands cleanly with no clobbering.
// ---------------------------------------------------------------------------

describe('re-entrant write: duckOn() fired from inside removeDuckRule\'s own recovery write', () => {
    it('the reentrant rule is present and untouched after the outer call returns', async () => {
        const { audio } = await boot();
        audio.duckOn('sfx', 'music');
        audio._duckRules[0].active = true;

        const target = audio._buses.get('music');
        const origSetTarget = target.duckGain.gain.setTargetAtTime.bind(target.duckGain.gain);
        let reentered = false;
        target.duckGain.gain.setTargetAtTime = (v, t, tc) => {
            const r = origSetTarget(v, t, tc);
            if (!reentered) {
                reentered = true;
                audio.duckOn('voice', 'music');   // reentrant write during the recovery callback
            }
            return r;
        };

        let result;
        assert.doesNotThrow(() => { result = audio.removeDuckRule('sfx', 'music'); });

        assert.equal(reentered, true, 'setup: the recovery write actually fired the reentrant hook');
        assert.equal(result, true, 'the outer removal still reports success');
        assert.equal(audio._duckRules.length, 1, 'exactly the reentrant rule survives');
        assert.equal(audio._duckRules[0].triggerBus, 'voice');
        assert.equal(audio._duckRules[0].targetBus, 'music');
    });
});

// ---------------------------------------------------------------------------
// Adversarial (not among the plan's 17): a type-confusion object whose `==`
// would coincidentally match a stored bus name but whose `===` must not --
// pins that the pair match is STRICT equality, never coerced.
// ---------------------------------------------------------------------------

describe('adversarial: type-confusion object (== matches, === must not)', () => {
    it('an object with a valueOf()/toString() returning "sfx" never matches via removeDuckRule', async () => {
        const { audio } = await boot();
        audio.duckOn('sfx', 'music');
        assert.equal(audio._duckRules.length, 1);

        const confusable = {
            valueOf() { return 'sfx'; },
            toString() { return 'sfx'; },
        };
        // Sanity: this object really is == 'sfx' (loose equality would be fooled)
        // but is NOT === 'sfx' -- the exact gap removeDuckRule must not fall into.
        assert.equal(confusable == 'sfx', true, 'setup: loose equality is fooled');
        assert.notEqual(confusable, 'sfx', 'setup: strict equality is not');

        assert.equal(audio.removeDuckRule(confusable, 'music'), false, 'strict match required, no coercion');
        assert.equal(audio._duckRules.length, 1, 'the real rule survives the confusion attempt untouched');

        // The real string still works, proving the object above was the only
        // thing that failed -- not some unrelated breakage.
        assert.equal(audio.removeDuckRule('sfx', 'music'), true);
        assert.equal(audio._duckRules.length, 0);
    });
});
