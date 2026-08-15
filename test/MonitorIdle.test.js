/**
 * @zakkster/lite-audio - PS2 monitor idle refcount / sleep-wake boundary suite
 * (node:test).
 *
 * The torture gate (test/torture.mjs, T-SP8) proves the SCHEDULING property:
 * the shared monitor sleeps at zero consumers and wakes on the next one, over
 * a 4096-cycle soak, with a live auto-suspend countdown never sleeping out
 * from under itself. Neither of those is what THIS file is for.
 *
 * This file pins the FAIL-CLOSED CONTRACT a scheduling/GC gate cannot see:
 * the per-consumer-type liveness predicate (_monitorIdle), including the two
 * traps decisions/0011 names explicitly -- the busRec.positional-vs-posDirty
 * trap (D2: a predicate reading the construction-time `positional` flag would
 * treat a destroyBus tombstone as a permanent consumer) and the stopDuck
 * permanence (D5: no public API removes a _duckRules entry) -- plus the
 * tick's sleep/wake mechanics (idempotent re-arm, no double-free on destroy(),
 * the T3 pool-build wake and the T4 auto-suspend wake), a boundary matrix over
 * consumer count, duplicate dispose, dispose/re-entrancy during a tick, and an
 * adversarial undefined-vs-null probe of the fail-closed doctrine (D6: null is
 * not zero).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LiteAudio } from '../Audio.js';
import { createMockContext, mockFetch, mockDocument, mockScheduler, flushMicrotasks } from './mock-ctx.js';

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

/**
 * ctx starts 'running' so init() marks it unlocked immediately (no gesture
 * plumbing needed, mirroring DestroyBus.test.js's boot()). No scheduler: the
 * monitor's timer id is a real one from the (unused) no-op setTimeout, so
 * cases that only care about _monitorIdle()'s VALUE (not the tick mechanics)
 * use this.
 */
async function boot({ buses = ['sfx', 'music'], maxChannelCount, capacity = 8 } = {}) {
    const ctxOpts = { state: 'running' };
    if (maxChannelCount !== undefined) ctxOpts.maxChannelCount = maxChannelCount;
    const ctx = createMockContext(ctxOpts);
    const audio = new LiteAudio({
        buses, poolCapacity: capacity, window: fakeWindow(), document: mockDocument(),
        fetch: mockFetch({ '/a.wav': 500 }),
        setTimeout: () => 0, clearTimeout: () => {},
    });
    await audio.init(ctx);
    return { audio, ctx };
}

/** Same as boot(), but wired to a REAL manual scheduler (mockScheduler) so a
 *  test can drive the shared monitor tick by hand and observe pending()/the
 *  _monitorTimer id -- the sleep/wake mechanics cases need this, plain
 *  liveness-value cases do not. */
async function bootWithClock({ buses = ['sfx', 'music'], maxChannelCount, capacity = 8 } = {}) {
    const ctxOpts = { state: 'running' };
    if (maxChannelCount !== undefined) ctxOpts.maxChannelCount = maxChannelCount;
    const ctx = createMockContext(ctxOpts);
    const clock = mockScheduler();
    const audio = new LiteAudio({
        buses, poolCapacity: capacity, window: fakeWindow(), document: mockDocument(),
        fetch: mockFetch({ '/a.wav': 500 }),
        setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    });
    await audio.init(ctx);
    return { audio, ctx, clock };
}

// ---------------------------------------------------------------------------
// 1 / 2: fresh engine, never armed
// ---------------------------------------------------------------------------

describe('fresh engine, no consumer ever registered', () => {
    it('1: _monitorTimer === null (never armed)', async () => {
        const { audio } = await boot();
        assert.equal(audio._monitorTimer, null);
    });

    it('2: _monitorIdle() === true on a bare engine', async () => {
        const { audio } = await boot();
        assert.equal(audio._monitorIdle(), true);
    });
});

// ---------------------------------------------------------------------------
// 3: metered bus (C1)
// ---------------------------------------------------------------------------

describe('C1 metered bus', () => {
    it('3: one metered bus -> false; after destroyBus -> true', async () => {
        const { audio } = await boot();
        audio.createBus('meterA', { meter: true });
        assert.equal(audio._monitorIdle(), false, 'a live metered bus is a consumer');
        assert.equal(audio.destroyBus('meterA'), true);
        assert.equal(audio._monitorIdle(), true, 'destroying the only metered bus goes idle');
    });
});

// ---------------------------------------------------------------------------
// 4: positional bus WITH POOL BUILT -- locks the busRec.positional trap (D2)
// ---------------------------------------------------------------------------

describe('C5 positional bus (the busRec.positional-vs-posDirty trap, D2)', () => {
    it('4: pool built (createBus + defineSounds) -> false; after destroyBus -> true', async () => {
        const { audio } = await boot({ buses: [] });
        audio.createBus('world', { spatial: 'positional' });
        await audio.defineSounds({ ping: { src: ['/a.wav'], bus: 'world' } });
        await flushMicrotasks(8);

        const busRec = audio._buses.get('world');
        assert.ok(busRec.pool, 'setup: pool actually built');
        assert.equal(audio._monitorIdle(), false, 'a pooled positional bus is a consumer');

        assert.equal(audio.destroyBus('world'), true);
        // TRAP: busRec.positional (:854) is NEVER cleared by destroyBus. A predicate
        // that reads it instead of pool/posDirty would wrongly stay false (awake)
        // here forever -- the exact silent no-op decisions/0011 D2 documents. This
        // assertion is the one that catches that regression.
        assert.equal(busRec.positional, true, 'setup: destroyBus leaves the flag set (the trap bait)');
        assert.equal(busRec.pool, null, 'setup: destroyBus nulls the pool');
        assert.equal(busRec.posDirty, null, 'setup: destroyBus nulls posDirty');
        assert.equal(audio._monitorIdle(), true, 'a destroyBus husk must NOT pin the monitor awake');
    });
});

// ---------------------------------------------------------------------------
// 5: discrete bus (C2 -- flat list, registered cold at createBus)
// ---------------------------------------------------------------------------

describe('C2 discrete bus (8ch mock ctx)', () => {
    it('5: one discrete bus -> false; after destroyBus -> true', async () => {
        const { audio } = await boot({ buses: [], maxChannelCount: 8 });
        audio.createBus('surr', { spatial: 'discrete', preset: '7.1' });
        assert.equal(audio._discreteBuses.length, 1, 'setup: registered in the flat list');
        assert.equal(audio._monitorIdle(), false, 'a live discrete bus is a consumer');
        assert.equal(audio.destroyBus('surr'), true);
        assert.equal(audio._monitorIdle(), true, 'destroying the only discrete bus goes idle');
    });
});

// ---------------------------------------------------------------------------
// 6: width-armed bus (C6)
// ---------------------------------------------------------------------------

describe('C6 width-armed bus', () => {
    it('6: createBus({width:0.5}) + a mono sound -> false; after destroyBus -> true', async () => {
        const { audio } = await boot({ buses: [] });
        audio.createBus('wide', { width: 0.5 });
        // wideIn is armed at createBus time (:784), before any pool build, so this
        // is already a live consumer with no sound loaded yet.
        assert.equal(audio._monitorIdle(), false, 'width armed at createBus is already a consumer');
        // Load a mono sound (the mock decodeAudioData returns numberOfChannels===1),
        // so the widener stays armed through pool build rather than being disarmed
        // by the non-mono-source guard.
        await audio.defineSounds({ ping: { src: ['/a.wav'], bus: 'wide' } });
        await flushMicrotasks(8);
        const busRec = audio._buses.get('wide');
        assert.notEqual(busRec.wideIn, null, 'setup: widener stayed armed (mono source)');
        assert.equal(audio._monitorIdle(), false, 'still a consumer once pooled');

        assert.equal(audio.destroyBus('wide'), true);
        assert.equal(audio._monitorIdle(), true, 'destroying the only width bus goes idle');
    });
});

// ---------------------------------------------------------------------------
// 7: duckOn / stopDuck permanence (C3, R1/D5)
// ---------------------------------------------------------------------------

describe('C3 duck rules are a PERMANENT consumer (R1/D5)', () => {
    it('7: duckOn(...) -> false; STILL false after stopDuck() (stopDuck never removes the rule)', async () => {
        const { audio } = await boot();
        audio.duckOn('sfx', 'music', { threshold: 1 });
        assert.equal(audio._duckRules.length, 1);
        assert.equal(audio._monitorIdle(), false, 'a duck rule is a consumer');

        audio.stopDuck('music');
        // R1: stopDuck() clears only the manual duckManual latch, never the
        // follower rule in _duckRules. No public API empties that array short of
        // destroy(). The predicate must stay honest about this permanence.
        assert.equal(audio._duckRules.length, 1, 'stopDuck must NOT remove the rule');
        assert.equal(audio._monitorIdle(), false, 'duckOn pins the monitor awake for the engine\'s life');
    });
});

// ---------------------------------------------------------------------------
// 8: auto-suspend enable/disable (C4)
// ---------------------------------------------------------------------------

describe('C4 auto-suspend armed/disarmed', () => {
    it('8: enableAutoSuspend() -> false; disableAutoSuspend() -> true', async () => {
        const { audio } = await boot();
        assert.equal(audio.enableAutoSuspend(), true);
        assert.equal(audio._monitorIdle(), false, 'a counting-down auto-suspend is a consumer');
        audio.disableAutoSuspend();
        assert.equal(audio._monitorIdle(), true, 'disarmed auto-suspend is not a consumer');
    });
});

// ---------------------------------------------------------------------------
// 9: self-suspended auto-suspend is NOT a live consumer (ruling 3b)
// ---------------------------------------------------------------------------

describe('C4 self-suspended auto-suspend (ruling 3b)', () => {
    it('9: _autoSuspend=true, _selfSuspended=true -> _monitorIdle() === true', async () => {
        const { audio } = await boot();
        audio._autoSuspend = true;
        audio._selfSuspended = true;
        assert.equal(audio._monitorIdle(), true, 'a self-suspended context is not a live consumer');
    });
});

// ---------------------------------------------------------------------------
// 10: pending HRIR prewarm (C7) -- isolated from C5 by construction
// ---------------------------------------------------------------------------

describe('C7 pending HRIR prewarm retire', () => {
    it('10: hrtfWarmHandle !== null, no other consumer -> false; after retire -> true', async () => {
        // An 'hrtf' bus is ALWAYS positional-family (busRec.positional === true), so
        // once its pool is built it is ALSO a permanent C5 consumer for its whole
        // life -- hrtfWarmHandle retiring would never flip _monitorIdle() to true on
        // a real hrtf bus (C5 stays true forever until destroyBus). To test the C7
        // clause IN ISOLATION (as its own line in the predicate, per R6 "each clause
        // is the literal negation of its walker's own skip"), this stamps the field
        // directly on a PLAIN STEREO bus, which _retireHrtfWarm's own walker treats
        // identically (it scans _busList by VALUE, not by busRec.spatial) -- so this
        // is a faithful, honest test of the shipped clause, not a synthetic detour.
        const { audio } = await boot({ buses: ['sfx'] });
        await audio.defineSounds({ ping: { src: ['/a.wav'], bus: 'sfx' } });
        await flushMicrotasks(8);
        const busRec = audio._buses.get('sfx');
        assert.equal(busRec.posDirty, null, 'setup: a plain stereo bus never gets position scratch (C5 stays false)');
        assert.equal(audio._monitorIdle(), true, 'setup baseline: idle before the fake prewarm');

        busRec.hrtfWarmHandle = 0;   // a fabricated but harmless handle (stop() fails closed on garbage)
        assert.equal(audio._monitorIdle(), false, 'a pending prewarm handle is a consumer');

        audio._retireHrtfWarm();     // the monitor tick's retire step
        assert.equal(busRec.hrtfWarmHandle, null, 'setup: the walker retired it');
        assert.equal(audio._monitorIdle(), true, 'retiring the only prewarm goes idle');
    });
});

// ---------------------------------------------------------------------------
// 11: destroyBus husk alone in _busList -- tombstone is not a consumer
// ---------------------------------------------------------------------------

describe('tombstone husk is not a consumer', () => {
    it('11: a destroyBus husk (dead===true) alone in _busList -> true', async () => {
        const { audio } = await boot();
        audio.createBus('gone');
        assert.equal(audio.destroyBus('gone'), true);
        const busRec = audio._buses.get('gone') ?? null;
        assert.equal(busRec, null, 'setup: name binding is dropped');
        assert.equal(audio._busList.length >= 1, true, 'setup: the tombstoned slot is kept, not spliced');
        assert.equal(audio._monitorIdle(), true, 'a husk is not a consumer');
    });
});

// ---------------------------------------------------------------------------
// 12: tick sleeps + re-arms exactly once; a second _startMonitor() is a no-op
// ---------------------------------------------------------------------------

describe('tick sleep/wake mechanics', () => {
    it('12: flush() after the last consumer leaves sleeps; _startMonitor() re-arms exactly one timer', async () => {
        const { audio, clock } = await bootWithClock();
        audio.createBus('m', { meter: true });
        assert.equal(clock.pending(), 1, 'setup: armed at createBus');

        assert.equal(audio.destroyBus('m'), true);
        clock.flush();
        assert.equal(audio._monitorTimer, null, 'the tick sleeps once the only consumer is gone');
        assert.equal(clock.pending(), 0);

        audio._startMonitor();
        assert.notEqual(audio._monitorTimer, null, 'a wake re-arms the timer');
        assert.equal(clock.pending(), 1, 'exactly one timer armed');

        audio._startMonitor();   // idempotent guard (:2353/:2366)
        assert.equal(clock.pending(), 1, 'a second _startMonitor() while one is pending is a no-op');
    });
});

// ---------------------------------------------------------------------------
// 13: destroy() on a SLEPT monitor -- no throw, idempotent, no double _clearTimeout
// ---------------------------------------------------------------------------

describe('destroy() on a slept monitor (Q4: no state to unwind)', () => {
    it('13: destroy() is a clean no-op on _clearTimeout, and idempotent on a repeat call', async () => {
        const { audio, clock } = await bootWithClock();
        audio.createBus('m', { meter: true });
        assert.equal(audio.destroyBus('m'), true);
        clock.flush();
        assert.equal(audio._monitorTimer, null, 'setup: slept');

        let clearCalls = 0;
        const origClear = clock.clearTimeout;
        clock.clearTimeout = (id) => { clearCalls++; return origClear(id); };
        // destroy() reads this._clearTimeout, which was bound at construction to the
        // ORIGINAL clock.clearTimeout function reference (not looked up dynamically
        // through the object each call), so swap the underlying instance-bound
        // reference the same way Audio.js holds it: overriding audio._clearTimeout
        // directly is the faithful seam here.
        const origInstClear = audio._clearTimeout;
        let instClearCalls = 0;
        audio._clearTimeout = (id) => { instClearCalls++; return origInstClear(id); };

        assert.doesNotThrow(() => audio.destroy());
        assert.equal(instClearCalls, 0, 'a slept monitor has no pending id -- _clearTimeout must not be called');
        assert.equal(audio._monitorTimer, null);

        assert.doesNotThrow(() => audio.destroy(), 'a repeat destroy() on an already-destroyed engine must not throw');
        assert.equal(instClearCalls, 0, 'still never called on the repeat call (idempotent, no double-free)');
    });
});

// ---------------------------------------------------------------------------
// 14: play() from self-suspended+slept wakes the monitor (T4)
// ---------------------------------------------------------------------------

describe('T4: play() wakes a self-suspended, slept monitor', () => {
    it('14: play() from self-suspended+slept -> _monitorTimer !== null', async () => {
        const { audio, ctx, clock } = await bootWithClock({ buses: ['sfx'] });
        await audio.defineSounds({ ping: { src: ['/a.wav'], bus: 'sfx' } });
        await flushMicrotasks(8);

        audio.enableAutoSuspend({ after: 0.1 });
        for (let i = 0; i < 40 && !audio.isAutoSuspended(); i++) {
            ctx._advance(0.05);
            clock.flush();
        }
        assert.equal(audio.isAutoSuspended(), true, 'setup: self-suspended');
        // Self-suspend and the sleep decision are evaluated inside the SAME tick
        // (_evalAutoSuspend sets _selfSuspended synchronously, then _monitorIdle()
        // reads it in its tail check on that identical pass), so the monitor is
        // already slept the instant it self-suspends -- no extra flush needed.
        assert.equal(audio._monitorTimer, null, 'setup: slept the instant it self-suspended');

        const h = audio.play('ping');
        assert.ok(h >= 0, 'setup: a real handle was issued');
        assert.equal(audio._selfSuspended, false, 'play() woke the context');
        assert.notEqual(audio._monitorTimer, null, 'T4: play() must re-arm the monitor');
    });
});

// ---------------------------------------------------------------------------
// 15: positional pool-build wake (T3 lock)
// ---------------------------------------------------------------------------

describe('T3: pool-build wake for a positional bus created before defineSounds', () => {
    it('15: createBus -> sleeps (no scratch yet) -> defineSounds -> _monitorTimer !== null', async () => {
        const { audio, clock } = await bootWithClock({ buses: [] });
        audio.createBus('world', { spatial: 'positional' });
        assert.notEqual(audio._monitorTimer, null, 'setup: armed at createBus (:908), before the scratch exists');

        for (let i = 0; i < 5; i++) clock.flush();
        // No pool yet (posDirty === null), so _monitorIdle() sees no C5 consumer and
        // NOTHING else is live -- the tick sleeps. Without T3 this state is
        // permanent: setPosition never gets a wake, positions never flush.
        assert.equal(audio._monitorTimer, null, 'the monitor sleeps before the pool is built');

        await audio.defineSounds({ ping: { src: ['/a.wav'], bus: 'world' } });
        await flushMicrotasks(8);
        assert.notEqual(audio._monitorTimer, null, 'T3: pool build must re-arm the monitor');
    });
});

// ---------------------------------------------------------------------------
// 16: mixed consumers -- OR, not a latch
// ---------------------------------------------------------------------------

describe('mixed consumers: liveness is an OR over every clause, not a latch', () => {
    it('16: two consumers, remove one -> still false; remove the second -> true', async () => {
        const { audio } = await boot();
        audio.createBus('m1', { meter: true });
        audio.createBus('m2', { meter: true });
        assert.equal(audio._monitorIdle(), false);

        assert.equal(audio.destroyBus('m1'), true);
        assert.equal(audio._monitorIdle(), false, 'm2 alone keeps it awake');

        assert.equal(audio.destroyBus('m2'), true);
        assert.equal(audio._monitorIdle(), true, 'both gone -> idle');
    });
});

// ---------------------------------------------------------------------------
// Boundary matrix over consumer COUNT: 0 / 1 / N-1 / N / N+1
// ---------------------------------------------------------------------------

describe('boundary matrix over consumer population size (0, 1, N-1, N, N+1)', () => {
    it('0/1/N-1/N/N+1: N metered buses destroyed one at a time, then one more created', async () => {
        const { audio } = await boot();
        assert.equal(audio._monitorIdle(), true, '0: no consumer');

        const N = 5;
        const names = [];
        for (let i = 0; i < N; i++) { audio.createBus('c' + i, { meter: true }); names.push('c' + i); }
        assert.equal(audio._monitorIdle(), false, 'N: all N live');

        for (let i = 0; i < N - 1; i++) assert.equal(audio.destroyBus(names[i]), true);
        assert.equal(audio._monitorIdle(), false, 'N-1 destroyed, 1 (the last) survivor keeps it awake');

        assert.equal(audio.destroyBus(names[N - 1]), true);
        assert.equal(audio._monitorIdle(), true, 'N: all destroyed -> idle');

        // N+1: one more create after the churn wakes it again.
        audio.createBus('after', { meter: true });
        assert.equal(audio._monitorIdle(), false, 'N+1: a fresh consumer after full churn');
    });
});

// ---------------------------------------------------------------------------
// destroyBus name-argument boundary: empty / null / undefined / NaN / -0
// ---------------------------------------------------------------------------

describe('destroyBus name argument boundary does not disturb monitor liveness', () => {
    it('empty/null/undefined/NaN/-0 are all no-ops; a live consumer stays live throughout', async () => {
        const { audio } = await boot();
        audio.createBus('keep', { meter: true });
        assert.equal(audio._monitorIdle(), false);
        for (const bad of ['', null, undefined, NaN, -0]) {
            assert.equal(audio.destroyBus(bad), false, 'name=' + String(bad));
            assert.equal(audio._monitorIdle(), false, 'a bogus destroyBus name must not disturb the real consumer');
        }
    });
});

// ---------------------------------------------------------------------------
// Duplicate dispose (deeper than case 13): destroy() called three more times
// ---------------------------------------------------------------------------

describe('duplicate dispose of destroy() is idempotent all the way down', () => {
    it('three more destroy() calls after the first stay silent and _monitorTimer stays null', async () => {
        const { audio, clock } = await bootWithClock();
        audio.createBus('m', { meter: true });
        assert.notEqual(audio._monitorTimer, null);

        assert.doesNotThrow(() => audio.destroy());
        assert.equal(audio._monitorTimer, null);
        assert.doesNotThrow(() => audio.destroy());
        assert.doesNotThrow(() => audio.destroy());
        assert.doesNotThrow(() => audio.destroy());
        assert.equal(audio._monitorTimer, null, 'still null after repeat dispose');
        assert.equal(clock.pending(), 0, 'no orphaned timer after repeat dispose');
    });
});

// ---------------------------------------------------------------------------
// Dispose-during-iteration: destroyBus called from INSIDE the monitor's own
// meter sweep, on a DIFFERENT (later) bus than the one mid-read -- the exact
// idiom DestroyBus.test.js already proves safe -- extended here to check the
// monitor's sleep decision on subsequent ticks (not just "does not throw").
// ---------------------------------------------------------------------------

describe('dispose-during-iteration: destroyBus invoked mid-tick from the meter sweep', () => {
    it('destroying a LATER bus from inside an EARLIER bus\'s read does not throw; the survivor keeps the monitor awake, and it sleeps only once the survivor is gone too', async () => {
        const { audio, clock } = await bootWithClock();
        audio.createBus('meterA', { meter: true });
        audio.createBus('meterB', { meter: true });
        const recA = audio._buses.get('meterA');
        const recB = audio._buses.get('meterB');

        let firedOnce = false;
        const origRead = recA.analyser.getFloatTimeDomainData;
        recA.analyser.getFloatTimeDomainData = (arr) => {
            if (!firedOnce) { firedOnce = true; audio.destroyBus('meterB'); }
            return origRead(arr);
        };

        assert.doesNotThrow(() => clock.flush(), 'destroying meterB mid-sweep of meterA must not throw');
        // meterA (the one mid-read when the destroy fired) survives, so the SAME
        // tick's _monitorIdle() check still sees a live consumer and reschedules.
        assert.notEqual(audio._monitorTimer, null, 'the surviving bus keeps the monitor awake after the mid-tick destroy');
        assert.equal(audio._meteredBuses.includes(recB), false, 'the torn-down bus is out of the meter list');
        assert.equal(audio._meteredBuses.includes(recA), true, 'the surviving bus is still registered');

        assert.equal(audio.destroyBus('meterA'), true);
        clock.flush();
        assert.equal(audio._monitorTimer, null, 'once the survivor is gone too, the next tick sleeps');
    });
});

// ---------------------------------------------------------------------------
// Re-entrant write: destroyBus invoked from INSIDE another destroyBus's own
// teardown (via a pool.destroy() that recurses back into the engine) -- the
// exact idiom DestroyBus.test.js already proves tears both buses down
// cleanly -- extended here to check the monitor liveness transition it drives.
// ---------------------------------------------------------------------------

describe('re-entrant write: destroyBus invoked from inside a pool.destroy() during another destroyBus', () => {
    it('bus A\'s pool.destroy() re-entrantly destroys bus B; both are gone and the monitor is idle, with no double-arm', async () => {
        const { audio, clock } = await bootWithClock({ buses: [] });
        audio.createBus('reA', { meter: true });
        audio.createBus('reB', { meter: true });
        assert.equal(audio._monitorIdle(), false);

        const recA = audio._buses.get('reA');
        const recB = audio._buses.get('reB');
        // Neither bus has a pool (no defineSounds here), so simulate the
        // re-entrant trigger the same way the DestroyBus.test.js precedent does:
        // wrap the FIRST bus's teardown-adjacent call so it recurses into a
        // second destroyBus before returning. gain.disconnect() is called early
        // in destroyBus's own teardown, so it is the re-entrant hook here.
        const origDisconnect = recA.gain.disconnect.bind(recA.gain);
        let reentered = false;
        recA.gain.disconnect = () => {
            origDisconnect();
            if (!reentered) { reentered = true; audio.destroyBus('reB'); }
        };

        assert.doesNotThrow(() => audio.destroyBus('reA'));
        assert.equal(reentered, true, 'the re-entrant call actually fired');
        assert.equal(recA.dead, true);
        assert.equal(recB.dead, true, 'the re-entrantly destroyed bus was torn down too');
        assert.equal(audio._monitorIdle(), true, 'both consumers gone -> idle');

        clock.flush();
        assert.equal(audio._monitorTimer, null);
        assert.equal(clock.pending(), 0, 'no orphaned second timer from the re-entrant registration path');
    });
});

// ---------------------------------------------------------------------------
// Adversarial (not among the 16): undefined vs null on a busRec field probes
// the D6 fail-closed doctrine directly -- "null is not zero" extends to
// "undefined is not null" too. An `undefined` where the predicate expects
// `null` is an UNVERIFIED state and must fail closed toward AWAKE, never
// silently read as "cleared".
// ---------------------------------------------------------------------------

describe('adversarial: undefined (not null) on a busRec liveness field fails closed toward AWAKE (D6)', () => {
    it('wideIn undefined -> not idle; only an explicit null clears it', async () => {
        const { audio } = await boot();
        const busRec = audio._buses.get('sfx');
        assert.equal(audio._monitorIdle(), true, 'setup baseline: idle');

        busRec.wideIn = undefined;
        assert.equal(audio._monitorIdle(), false, 'undefined !== null -- the C6 clause fails closed');

        busRec.wideIn = null;
        assert.equal(audio._monitorIdle(), true, 'an explicit null is the only value that clears it');
    });

    it('hrtfWarmHandle undefined -> not idle (C7 fails closed the same way)', async () => {
        const { audio } = await boot();
        const busRec = audio._buses.get('sfx');
        busRec.hrtfWarmHandle = undefined;
        assert.equal(audio._monitorIdle(), false, 'undefined !== null -- the C7 clause fails closed');
        busRec.hrtfWarmHandle = null;
        assert.equal(audio._monitorIdle(), true);
    });

    it('pool undefined with posDirty set still reads as a live C5 consumer (undefined !== null on either side)', async () => {
        const { audio } = await boot();
        const busRec = audio._buses.get('sfx');
        busRec.pool = undefined;
        busRec.posDirty = new Uint32Array(1);
        assert.equal(audio._monitorIdle(), false, 'an ambiguous (undefined) pool alongside real scratch fails closed');
    });
});
