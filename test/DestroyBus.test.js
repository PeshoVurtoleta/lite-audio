/**
 * @zakkster/lite-audio - PS1 destroyBus(name) boundary suite (node:test).
 *
 * The torture gate (test/torture.mjs, T-SP7) proves the RETENTION property:
 * 4096 create/destroyBus cycles across {stereo, positional, hrtf, width,
 * discrete} release everything, at maxMajor:0 / maxPauseMs<=4. Neither of
 * those is what THIS file is for.
 *
 * This file pins the FAIL-CLOSED CONTRACT a heap gate cannot see: the
 * return-value contract (true/false/throw), stale-handle inertness, _busList
 * append-only stability + reindex, the discrete channelCount invariant, and
 * duck-rule / snapshot inertness over a destroyed bus -- plus a boundary
 * matrix over the name argument and the bus-population size, duplicate
 * dispose, dispose-during-iteration, a re-entrant destroyBus-from-inside-
 * destroyBus, and a name-reuse ABA adversarial case.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LiteAudio } from '../Audio.js';
import { createMockContext, mockFetch, mockDocument, mockScheduler, flushMicrotasks } from './mock-ctx.js';

// Mirror of Audio.js's internal codec (not exported - an implementation
// detail). This file only needs it to CRAFT adversarial handles.
const BUS_STRIDE = 4294967296; // 2^32

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
 * plumbing needed, mirroring Discrete.test.js's buildDiscreteEngine) - the
 * clean way to get real play() handles without a window-fire dance.
 */
async function boot({ buses = ['sfx', 'music'], maxChannelCount, capacity = 8 } = {}) {
    const ctxOpts = { state: 'running' };
    if (maxChannelCount !== undefined) ctxOpts.maxChannelCount = maxChannelCount;
    const ctx = createMockContext(ctxOpts);
    const audio = new LiteAudio({
        buses, poolCapacity: capacity, window: fakeWindow(), document: mockDocument(),
        fetch: mockFetch({ '/a.wav': 500, '/b.wav': 500 }),
        setTimeout: () => 0, clearTimeout: () => {},
    });
    await audio.init(ctx);
    return { audio, ctx };
}

/** Same as boot(), but wired to a manual scheduler so a test can drive the
 *  shared monitor tick by hand (duckOn / meter sweep needs this). */
async function bootWithClock({ buses = ['sfx', 'music'] } = {}) {
    const ctx = createMockContext({ state: 'running' });
    const clock = mockScheduler();
    const audio = new LiteAudio({
        buses, poolCapacity: 8, window: fakeWindow(), document: mockDocument(),
        fetch: mockFetch({ '/a.wav': 500, '/b.wav': 500 }),
        setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    });
    await audio.init(ctx);
    return { audio, ctx, tick: () => clock.flush() };
}

// ---------------------------------------------------------------------------
// CONTRACT (A2)
// ---------------------------------------------------------------------------

describe('destroyBus contract (A2)', () => {
    it('live dynamic bus -> true; repeat -> false; unknown -> false; master -> throw; static -> throw', async () => {
        const { audio } = await boot();
        audio.createBus('dyn');

        assert.equal(audio.destroyBus('dyn'), true, 'first destroy of a live dynamic bus');
        assert.equal(audio.destroyBus('dyn'), false, 'second destroy of the same name is a no-op');
        assert.equal(audio.destroyBus('nonexistent'), false, 'unknown name is a no-op');
        assert.throws(() => audio.destroyBus('master'), /reserved/, '"master" is reserved and throws');
        // 'sfx' is a STATIC bus (declared via opts.buses at construction), never
        // dynamic:true, so it must throw and never actually be a bus that CAN
        // be destroyed - confirming the static-throw against a KNOWN static set.
        assert.throws(() => audio.destroyBus('sfx'), /static/, 'a static opts.buses bus refuses');
        assert.ok(audio._buses.has('sfx'), 'the static bus must survive the refused call, untouched');
    });
});

// ---------------------------------------------------------------------------
// STALE HANDLE INERT (A3)
// ---------------------------------------------------------------------------

describe('stale handle inertness after destroyBus (A3)', () => {
    it('stop/setPosition are silent no-ops and isPlaying is false on a real handle from the destroyed bus', async () => {
        const { audio } = await boot();
        audio.createBus('dyn');
        await audio.defineSounds({ ping: { src: ['/a.wav'], bus: 'dyn' } });
        await flushMicrotasks(8);

        const h = audio.play('ping');
        assert.ok(h >= 0, 'setup: a real handle was issued');
        assert.equal(audio.isPlaying(h), true, 'setup: sounding before destroy');

        assert.equal(audio.destroyBus('dyn'), true);

        assert.doesNotThrow(() => audio.stop(h));
        assert.doesNotThrow(() => audio.setPosition(h, 1, 2, 3));
        assert.equal(audio.isPlaying(h), false);
        assert.equal(audio.busOf(h), null, 'busOf resolves null-safe once the bus name is gone');
    });

    it('a fabricated handle whose bus index points at a destroyed husk is inert too', async () => {
        const { audio } = await boot();
        audio.createBus('dyn');
        const index = audio._buses.get('dyn').index;
        assert.equal(audio.destroyBus('dyn'), true);

        const fabricated = index * BUS_STRIDE + 0; // channel 0, generation 0
        assert.doesNotThrow(() => audio.stop(fabricated));
        assert.doesNotThrow(() => audio.setPosition(fabricated, 1, 1, 1));
        assert.equal(audio.isPlaying(fabricated), false);
    });
});

// ---------------------------------------------------------------------------
// BUSLIST STABILITY + APPEND-ONLY (A4)
// ---------------------------------------------------------------------------

describe('_busList stability + append-only reindex after destroyBus (A4)', () => {
    it('length is unchanged, a survivor still resolves its own handles, and the next createBus appends past the husk', async () => {
        const { audio } = await boot();
        audio.createBus('keep');
        await audio.defineSounds({ ping: { src: ['/a.wav'], bus: 'keep' } });
        await flushMicrotasks(8);
        audio.createBus('dyn');

        const beforeLen = audio._busList.length;
        assert.equal(audio.destroyBus('dyn'), true);
        assert.equal(audio._busList.length, beforeLen, '_busList length unchanged by destroyBus');

        // The surviving bus, created BEFORE the destroyed one, still resolves its
        // own handles correctly.
        const h = audio.play('ping');
        assert.ok(h >= 0);
        assert.equal(audio.busOf(h), 'keep');
        assert.equal(audio.isPlaying(h), true);

        // The NEXT createBus appends at the OLD length - no hole-fill onto the
        // tombstoned slot.
        const next = audio.createBus('after');
        assert.equal(next.index, beforeLen, 'append-only: next index === old _busList.length');
    });
});

// ---------------------------------------------------------------------------
// Boundary matrix: 0 / 1 / N-1 / N / N+1 over the bus-population size
// ---------------------------------------------------------------------------

describe('boundary matrix over bus population size (0, 1, N-1, N, N+1)', () => {
    it('0: destroying with no dynamic buses created is a plain unknown-name no-op', async () => {
        const { audio } = await boot();
        assert.equal(audio.destroyBus('never-created'), false);
    });

    it('1: a single dynamic bus destroys cleanly (baseline)', async () => {
        const { audio } = await boot();
        audio.createBus('solo');
        assert.equal(audio.destroyBus('solo'), true);
    });

    it('N-1 / N / N+1: destroying the first, a middle, and the last of N dynamic buses each hollow ONLY that slot', async () => {
        const { audio } = await boot();
        const N = 5;
        const names = [];
        for (let i = 0; i < N; i++) { audio.createBus('b' + i); names.push('b' + i); }
        const idx = names.map((n) => audio._buses.get(n).index);
        const lenBefore = audio._busList.length;

        assert.equal(audio.destroyBus('b0'), true, 'first (position 0)');
        assert.equal(audio.destroyBus('b4'), true, 'last (position N-1)');
        assert.equal(audio.destroyBus('b3'), true, 'a middle one');

        assert.equal(audio._busList.length, lenBefore, '_busList length unchanged across 3 destroys');
        assert.equal(audio._buses.get('b1').index, idx[1], 'survivor b1 keeps its original index');
        assert.equal(audio._buses.get('b2').index, idx[2], 'survivor b2 keeps its original index');
        assert.equal(audio._buses.get('b1').dead, false);
        assert.equal(audio._buses.get('b2').dead, false);

        // N+1: one more create after the churn appends past every husk, never
        // reusing a tombstoned slot even after destroying first/middle/last.
        const next = audio.createBus('b5');
        assert.equal(next.index, lenBefore, 'append-only, no hole-fill after multi-position churn');
    });
});

// ---------------------------------------------------------------------------
// Boundary matrix on the `name` argument itself
// ---------------------------------------------------------------------------

describe('boundary matrix on the name argument: empty, null, undefined, NaN, -0', () => {
    it('are all unknown-name no-ops (false, never a throw)', async () => {
        const { audio } = await boot();
        for (const bad of ['', null, undefined, NaN, -0]) {
            assert.equal(audio.destroyBus(bad), false, 'name=' + String(bad));
        }
        assert.doesNotThrow(() => audio.destroyBus());
    });
});

// ---------------------------------------------------------------------------
// Duplicate dispose (deeper than the A2 contract check: repeat calls must
// never re-touch the husk)
// ---------------------------------------------------------------------------

describe('duplicate dispose is idempotent all the way down', () => {
    it('three more calls after the first keep returning false and never mutate the husk again', async () => {
        const { audio } = await boot();
        audio.createBus('dup');
        const rec = audio._buses.get('dup');
        const idx = rec.index;

        assert.equal(audio.destroyBus('dup'), true);
        assert.equal(rec.dead, true);
        assert.equal(audio.destroyBus('dup'), false);
        assert.equal(audio.destroyBus('dup'), false);
        assert.equal(audio.destroyBus('dup'), false);

        assert.equal(audio._busList[idx], rec, 'the husk slot still points at the SAME record object');
        assert.equal(rec.dead, true, 'still dead, not re-mutated by repeat calls');
    });
});

// ---------------------------------------------------------------------------
// DISCRETE channelCount (A5)
// ---------------------------------------------------------------------------

describe('discrete channelCount is not shrunk by destroyBus (A5)', () => {
    it('destroyBus leaves ctx.destination.channelCount unchanged; a later full destroy() still restores the saved triple', async () => {
        const ctx = createMockContext({ state: 'running', maxChannelCount: 8 });
        const pristine = {
            channelCount: ctx.destination.channelCount,
            channelCountMode: ctx.destination.channelCountMode,
            channelInterpretation: ctx.destination.channelInterpretation,
        };
        const audio = new LiteAudio({
            buses: [], poolCapacity: 4, window: fakeWindow(), document: mockDocument(),
            fetch: mockFetch({ '/a.wav': 500 }), setTimeout: () => 0, clearTimeout: () => {},
        });
        await audio.init(ctx);
        audio.createBus('surr', { spatial: 'discrete', preset: '7.1' });
        await audio.defineSounds({ ping: { src: ['/a.wav'], bus: 'surr' } });
        await flushMicrotasks(8);
        assert.equal(ctx.destination.channelCount, 8, 'setup: discrete build raised channelCount to 8');

        assert.equal(audio.destroyBus('surr'), true);
        assert.equal(ctx.destination.channelCount, 8, 'destroyBus does NOT shrink channelCount');
        assert.equal(ctx.destination.channelCountMode, 'explicit', 'mode also untouched by destroyBus');
        assert.equal(ctx.destination.channelInterpretation, 'discrete', 'interpretation also untouched');

        audio.destroy();
        assert.equal(ctx.destination.channelCount, pristine.channelCount, 'full destroy() still restores the saved triple');
        assert.equal(ctx.destination.channelCountMode, pristine.channelCountMode);
        assert.equal(ctx.destination.channelInterpretation, pristine.channelInterpretation);
    });
});

// ---------------------------------------------------------------------------
// A6: duckOn rules over a destroyed bus (reviewer-mandated)
// ---------------------------------------------------------------------------

describe('duckOn rules over a destroyed bus are silent no-ops across a full monitor tick (A6)', () => {
    it('destroying the DUCK TARGET leaves the rule inert (no throw)', async () => {
        const { audio, tick } = await bootWithClock();
        audio.createBus('dynTarget');
        audio.duckOn('sfx', 'dynTarget', { threshold: 1 });
        assert.equal(audio.destroyBus('dynTarget'), true);

        assert.doesNotThrow(() => tick());
        assert.doesNotThrow(() => tick());
    });

    it('destroying the DUCK TRIGGER leaves the rule inert (no throw)', async () => {
        const { audio, tick } = await bootWithClock();
        audio.createBus('dynTrigger');
        audio.duckOn('dynTrigger', 'music', { threshold: 1 });
        assert.equal(audio.destroyBus('dynTrigger'), true);

        assert.doesNotThrow(() => tick());
        assert.doesNotThrow(() => tick());
    });

    it('both trigger and target destroyed together still ticks clean', async () => {
        const { audio, tick } = await bootWithClock();
        audio.createBus('t');
        audio.createBus('m');
        audio.duckOn('t', 'm', { threshold: 1 });
        assert.equal(audio.destroyBus('t'), true);
        assert.equal(audio.destroyBus('m'), true);
        assert.doesNotThrow(() => tick());
    });
});

// ---------------------------------------------------------------------------
// A7: applySnapshot skips a destroyed bus, survivors still morph
// ---------------------------------------------------------------------------

describe('applySnapshot skips a destroyed bus and still morphs the survivors (A7)', () => {
    it('captures while the bus is alive, destroys it, then applies with no throw and the survivor set', async () => {
        const { audio } = await boot();
        audio.createBus('dyn');
        audio.setBusVolume('music', 0.5);
        audio.setBusVolume('dyn', 0.7);
        audio.captureSnapshot('snap');

        assert.equal(audio.destroyBus('dyn'), true);

        audio.setBusVolume('music', 0.1);
        assert.doesNotThrow(() => audio.applySnapshot('snap'));
        assert.equal(audio.busVolume('music').peek(), 0.5, 'surviving bus is still restated by the snapshot');
        assert.equal(audio.busVolume('dyn'), undefined, 'the destroyed bus name no longer resolves to a signal');
    });

    it('a morph (ms > 0) over a snapshot with a destroyed bus in it is equally inert for that bus', async () => {
        const { audio } = await boot();
        audio.createBus('dyn');
        audio.setBusVolume('music', 0.9);
        audio.captureSnapshot('snap2');
        assert.equal(audio.destroyBus('dyn'), true);
        audio.setBusVolume('music', 0.2);
        assert.doesNotThrow(() => audio.applySnapshot('snap2', 250));
        assert.equal(audio.busVolume('music').peek(), 0.9);
    });
});

// ---------------------------------------------------------------------------
// Dispose-during-iteration
// ---------------------------------------------------------------------------

describe('dispose-during-iteration: destroyBus called from inside the monitor meter sweep', () => {
    it('destroying a bus while an EARLIER bus in _meteredBuses is mid-read does not throw, and the survivor keeps updating', async () => {
        const { audio, tick } = await bootWithClock();
        audio.createBus('meterA', { meter: true });
        audio.createBus('meterB', { meter: true });
        const recA = audio._buses.get('meterA');
        const recB = audio._buses.get('meterB');
        recB.analyser._fill = 0.5;

        let firedOnce = false;
        const origRead = recA.analyser.getFloatTimeDomainData;
        recA.analyser.getFloatTimeDomainData = (arr) => {
            if (!firedOnce) { firedOnce = true; audio.destroyBus('meterB'); }
            return origRead(arr);
        };

        assert.doesNotThrow(() => tick(), 'destroying meterB mid-sweep must not throw');
        assert.equal(audio._buses.has('meterB'), false, 'meterB was actually torn down');

        // A later tick must still be well-formed: meterA keeps reporting, and no
        // stale meterB entry re-appears in the monitor's list.
        assert.doesNotThrow(() => tick());
        assert.equal(audio._meteredBuses.includes(recB), false, 'the torn-down husk never re-enters the meter list');
    });
});

// ---------------------------------------------------------------------------
// Re-entrant write: destroyBus called from INSIDE another destroyBus's own
// teardown (via a pool.destroy() that recurses back into the engine).
// ---------------------------------------------------------------------------

describe('re-entrant write: destroyBus invoked from inside a pool.destroy() during another destroyBus', () => {
    it('destroying bus A, whose pool.destroy() re-entrantly destroys bus B, tears both down cleanly with no throw', async () => {
        const { audio } = await boot();
        audio.createBus('reA');
        audio.createBus('reB');
        await audio.defineSounds({
            pingA: { src: ['/a.wav'], bus: 'reA' },
            pingB: { src: ['/b.wav'], bus: 'reB' },
        });
        await flushMicrotasks(8);

        const recA = audio._buses.get('reA');
        const recB = audio._buses.get('reB');
        const origDestroy = recA.pool.destroy.bind(recA.pool);
        let reentered = false;
        recA.pool.destroy = () => {
            origDestroy();
            if (!reentered) { reentered = true; audio.destroyBus('reB'); }
        };

        assert.doesNotThrow(() => audio.destroyBus('reA'));
        assert.equal(reentered, true, 'the re-entrant call actually fired');
        assert.equal(recA.dead, true);
        assert.equal(recB.dead, true, 'the re-entrantly destroyed bus was torn down too');
        assert.equal(audio.destroyBus('reA'), false, 'outer bus is idempotently dead afterward');
        assert.equal(audio.destroyBus('reB'), false, 'inner (re-entrant) bus is idempotently dead afterward');
    });
});

// ---------------------------------------------------------------------------
// Adversarial: bus-NAME reuse after destroyBus never aliases a stale handle
// (index-based resolution, not name-based) - the planner's A2-A7 do not
// exercise createBus() being called AGAIN with the destroyed bus's own name.
// ---------------------------------------------------------------------------

describe('adversarial: reusing a destroyed bus\'s NAME never aliases a stale handle onto the new bus', () => {
    it('destroy "x", create a fresh "x" at a NEW index, and a handle from the OLD "x" stays inert forever', async () => {
        const { audio } = await boot();
        audio.createBus('x');
        await audio.defineSounds({ ping: { src: ['/a.wav'], bus: 'x' } });
        await flushMicrotasks(8);

        const oldIndex = audio._buses.get('x').index;
        const h = audio.play('ping');
        assert.ok(h >= 0, 'setup: a real handle was issued on the original "x"');
        assert.equal(audio.isPlaying(h), true);

        assert.equal(audio.destroyBus('x'), true);
        const fresh = audio.createBus('x'); // same NAME, brand-new record + index
        assert.notEqual(fresh.index, oldIndex, 'a reused name gets a NEW index, never the tombstoned one');

        // The stale handle must stay inert: it must never resolve onto the fresh
        // same-named bus, and must never report a stray voice on it.
        assert.equal(audio.isPlaying(h), false, 'stale handle from the OLD "x" stays dead');
        assert.doesNotThrow(() => audio.stop(h));
        assert.doesNotThrow(() => audio.setPosition(h, 1, 1, 1));
        assert.equal(audio.busOf(h), null, 'stale handle never resolves to the reused name');

        // The FRESH bus is fully usable on its own, independent of the husk.
        await audio.defineSounds({ ping2: { src: ['/b.wav'], bus: 'x' } });
        await flushMicrotasks(8);
        const h2 = audio.play('ping2');
        assert.ok(h2 >= 0, 'fresh same-name bus plays normally');
        assert.equal(audio.busOf(h2), 'x');
        assert.notEqual(h2, h, 'the fresh handle is not equal to the stale one');
    });
});
