/**
 * @zakkster/lite-audio - S6 output-layout detection contract tests (node:test).
 *
 * The torture gate (test/torture.mjs, T-SP4) proves the ALLOCATION-FREE and
 * RATE-BOUNDED properties of the discrete family (setPosition on a discrete bus
 * reuses the same zero-alloc scalar stamp as positional/hrtf) plus runs the SAME
 * pinned detection matrix and fallback ladder as a red-controlled GC-gate tier.
 * Neither of those is what THIS file is for.
 *
 * This file pins the FAIL-CLOSED CONTRACT a heap/rate gate cannot see: given a
 * sink's maxChannelCount reading, does _detectLayout() resolve to exactly the
 * pinned layout for every boundary shape (absent, present-but-undefined, null,
 * NaN, non-integer, a string digit, an integer under/at/over the threshold, a
 * missing destination)? Does a discrete createBus() request under an
 * undersized/unknown sink transparently build a bus that actually plays, without
 * ever mutating the destination? Is detection cold-once (no re-detect on a second
 * init(), a cached readout survives destroy())? Every case here is a correctness
 * question, not a budget.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LiteAudio } from '../Audio.js';
import { createMockContext, mockFetch, mockDocument, flushMicrotasks } from './mock-ctx.js';

// ---------- Fake window (unlock gesture wiring, mirrors Spatial.test.js) ----

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
 * Build a bare LiteAudio (no buses, no sounds) against a context whose
 * destination has already been mutated by `configureCtx`, and return the
 * engine's detected layoutOf() plus the engine itself (still initialized, not
 * destroyed, so a caller can probe further before tearing down).
 */
async function layoutFor(configureCtx) {
    const ctx = createMockContext({ state: 'suspended' });
    if (configureCtx) configureCtx(ctx);
    const audio = new LiteAudio({
        buses: [], poolCapacity: 4, window: fakeWindow(), document: mockDocument(),
        fetch: mockFetch({}), setTimeout: () => 0, clearTimeout: () => {},
    });
    await audio.init(ctx);
    return { audio, ctx };
}

/**
 * Build a LiteAudio with ONE discrete '7.1' bus + a routed sound against a
 * context configured by `configureCtx`, unlocked (ctx starts 'running' so
 * init() marks it unlocked immediately - no gesture needed), fully settled.
 */
async function buildLadder(configureCtx) {
    const ctx = createMockContext({ state: 'running' });
    if (configureCtx) configureCtx(ctx);
    const audio = new LiteAudio({
        buses: [], poolCapacity: 4, window: fakeWindow(), document: mockDocument(),
        fetch: mockFetch({ '/s.wav': 500 }), setTimeout: () => 0, clearTimeout: () => {},
    });
    await audio.init(ctx);
    audio.createBus('s', { spatial: 'discrete', preset: '7.1' });
    await audio.defineSounds({ ping: { src: ['/s.wav'], bus: 's' } });
    await flushMicrotasks(8);
    return { audio, ctx };
}

// ---------- 1. the pinned detection matrix (T-SP4 (a), exact) --------------

describe('output-layout detection matrix (pinned, exact)', () => {
    it('absent (key not present on destination) -> stereo', async () => {
        const { audio } = await layoutFor((ctx) => ctx._deleteMaxChannelCount());
        assert.equal(audio.layoutOf(), 'stereo');
    });

    it('present-but-undefined (key present, value undefined) -> stereo -- DISTINCT from absent', async () => {
        const { audio, ctx } = await layoutFor((ctx) => ctx._setMaxChannelCount(undefined));
        assert.ok('maxChannelCount' in ctx.destination, 'the key must still be present (unlike the absent case)');
        assert.equal(audio.layoutOf(), 'stereo');
    });

    it('null -> stereo', async () => {
        const { audio } = await layoutFor((ctx) => ctx._setMaxChannelCount(null));
        assert.equal(audio.layoutOf(), 'stereo');
    });

    it('NaN -> stereo', async () => {
        const { audio } = await layoutFor((ctx) => ctx._setMaxChannelCount(NaN));
        assert.equal(audio.layoutOf(), 'stereo');
    });

    it('2 -> stereo', async () => {
        const { audio } = await layoutFor((ctx) => ctx._setMaxChannelCount(2));
        assert.equal(audio.layoutOf(), 'stereo');
    });

    it('4 -> stereo (no 3.1 until S7)', async () => {
        const { audio } = await layoutFor((ctx) => ctx._setMaxChannelCount(4));
        assert.equal(audio.layoutOf(), 'stereo');
    });

    it('6 -> stereo (no 5.1 until S7)', async () => {
        const { audio } = await layoutFor((ctx) => ctx._setMaxChannelCount(6));
        assert.equal(audio.layoutOf(), 'stereo');
    });

    it('7.5 -> stereo (non-integer)', async () => {
        const { audio } = await layoutFor((ctx) => ctx._setMaxChannelCount(7.5));
        assert.equal(audio.layoutOf(), 'stereo');
    });

    it("'8' (string) -> stereo (typeof guard, not coercion)", async () => {
        const { audio } = await layoutFor((ctx) => ctx._setMaxChannelCount('8'));
        assert.equal(audio.layoutOf(), 'stereo');
    });

    it("8 -> '7.1'", async () => {
        const { audio } = await layoutFor((ctx) => ctx._setMaxChannelCount(8));
        assert.equal(audio.layoutOf(), '7.1');
    });

    it("12 -> '7.1'", async () => {
        const { audio } = await layoutFor((ctx) => ctx._setMaxChannelCount(12));
        assert.equal(audio.layoutOf(), '7.1');
    });

    it('destination itself absent -> stereo', async () => {
        const { audio } = await layoutFor((ctx) => { ctx.destination = undefined; });
        assert.equal(audio.layoutOf(), 'stereo');
    });
});

// ---------- 2. extra boundary coverage the pinned matrix does not name ------

describe('extra boundary coverage: N-1, N, N+1, 0, -0, negatives, infinities, adversarial', () => {
    it('7 (N-1, just under the threshold) -> stereo', async () => {
        const { audio } = await layoutFor((ctx) => ctx._setMaxChannelCount(7));
        assert.equal(audio.layoutOf(), 'stereo');
    });

    it('9 (N+1, just over the threshold) -> "7.1"', async () => {
        const { audio } = await layoutFor((ctx) => ctx._setMaxChannelCount(9));
        assert.equal(audio.layoutOf(), '7.1');
    });

    it('0 -> stereo', async () => {
        const { audio } = await layoutFor((ctx) => ctx._setMaxChannelCount(0));
        assert.equal(audio.layoutOf(), 'stereo');
    });

    it('-0 -> stereo (Number.isInteger(-0) is true, but -0 >= 8 is false)', async () => {
        const { audio } = await layoutFor((ctx) => ctx._setMaxChannelCount(-0));
        assert.equal(audio.layoutOf(), 'stereo');
    });

    it('negative integer (-8) -> stereo', async () => {
        const { audio } = await layoutFor((ctx) => ctx._setMaxChannelCount(-8));
        assert.equal(audio.layoutOf(), 'stereo');
    });

    it('Infinity -> stereo (Number.isInteger(Infinity) is false)', async () => {
        const { audio } = await layoutFor((ctx) => ctx._setMaxChannelCount(Infinity));
        assert.equal(audio.layoutOf(), 'stereo');
    });

    it('-Infinity -> stereo', async () => {
        const { audio } = await layoutFor((ctx) => ctx._setMaxChannelCount(-Infinity));
        assert.equal(audio.layoutOf(), 'stereo');
    });

    it('a huge safe integer (Number.MAX_SAFE_INTEGER) -> "7.1" (no upper ceiling)', async () => {
        const { audio } = await layoutFor((ctx) => ctx._setMaxChannelCount(Number.MAX_SAFE_INTEGER));
        assert.equal(audio.layoutOf(), '7.1');
    });

    it('adversarial: a boxed Number object (typeof "object", not "number") -> stereo, never coerced', async () => {
        const { audio } = await layoutFor((ctx) => ctx._setMaxChannelCount(new Number(8)));
        assert.equal(audio.layoutOf(), 'stereo', 'a boxed Number must not slip past the typeof/Number.isInteger guard');
    });

    it('adversarial: a getter that throws on read must not crash init() -- fails closed, not fails hard', async () => {
        const ctx = createMockContext({ state: 'suspended' });
        Object.defineProperty(ctx.destination, 'maxChannelCount', {
            get() { throw new Error('sink probe exploded'); },
            configurable: true,
        });
        const audio = new LiteAudio({
            buses: [], poolCapacity: 4, window: fakeWindow(), document: mockDocument(),
            fetch: mockFetch({}), setTimeout: () => 0, clearTimeout: () => {},
        });
        // This documents current behaviour: _detectLayout() does not wrap the
        // read in try/catch (Audio.js:555-559), so a maxChannelCount getter that
        // throws propagates out of init(). If a reviewer wants a try/catch here,
        // that is a coder-side hardening, not a QA-owned rewrite -- pinned as a
        // known edge so a future regression test has a home.
        await assert.rejects(() => audio.init(ctx), /sink probe exploded/);
    });
});

// ---------- 3. cold-once semantics: no re-detect, cached across destroy() --

describe('detection is cold-once: cached at init(), never re-derived', () => {
    it('a second init() call (idempotent no-op) does not re-detect even if maxChannelCount changed underneath', async () => {
        const ctx = createMockContext({ state: 'suspended' });
        ctx._setMaxChannelCount(2);
        const audio = new LiteAudio({
            buses: [], poolCapacity: 4, window: fakeWindow(), document: mockDocument(),
            fetch: mockFetch({}), setTimeout: () => 0, clearTimeout: () => {},
        });
        await audio.init(ctx);
        assert.equal(audio.layoutOf(), 'stereo');

        ctx._setMaxChannelCount(8); // a hot-swapped headset reporting 8ch now
        await audio.init(ctx);      // same ctx: idempotent early-return, no re-detect
        assert.equal(audio.layoutOf(), 'stereo', 'a mid-session device change must NOT flip the cached layout');
    });

    it('layoutOf() keeps returning the cached value after destroy(), and duplicate dispose does not throw', async () => {
        const { audio } = await layoutFor((ctx) => ctx._setMaxChannelCount(8));
        assert.equal(audio.layoutOf(), '7.1');
        assert.doesNotThrow(() => audio.destroy());
        assert.equal(audio.layoutOf(), '7.1', 'a torn-down engine still reports its last-known layout, not a reset token');
        assert.doesNotThrow(() => audio.destroy(), 'second destroy() must not throw');
        assert.equal(audio.layoutOf(), '7.1');
    });
});

// ---------- 4. the fallback ladder (T-SP4 (b)): 9 stereo, 2 seven-one -------

describe('discrete request fallback ladder: request "7.1" under every sub-8 reading', () => {
    const STEREO_ROWS = [
        ['absent', (ctx) => ctx._deleteMaxChannelCount()],
        ['undefined', (ctx) => ctx._setMaxChannelCount(undefined)],
        ['null', (ctx) => ctx._setMaxChannelCount(null)],
        ['NaN', (ctx) => ctx._setMaxChannelCount(NaN)],
        ['2', (ctx) => ctx._setMaxChannelCount(2)],
        ['4', (ctx) => ctx._setMaxChannelCount(4)],
        ['6', (ctx) => ctx._setMaxChannelCount(6)],
        ['7.5', (ctx) => ctx._setMaxChannelCount(7.5)],
        ["'8'", (ctx) => ctx._setMaxChannelCount('8')],
    ];
    const SEVEN_ONE_ROWS = [
        ['8', (ctx) => ctx._setMaxChannelCount(8)],
        ['12', (ctx) => ctx._setMaxChannelCount(12)],
    ];

    for (const [name, configure] of STEREO_ROWS) {
        it('maxChannelCount ' + name + ' -> effectiveLayoutOf === "stereo", and the fallback bus actually plays', async () => {
            const { audio, ctx } = await buildLadder(configure);
            assert.equal(audio.effectiveLayoutOf('s'), 'stereo');
            // Destination NOT mutated on a stereo-fallback case (Audio.js:975 guard).
            assert.equal(ctx.destination.channelCount, 2, 'stereo fallback must never touch destination.channelCount');
            assert.equal(ctx.destination.channelCountMode, 'max');
            assert.equal(ctx.destination.channelInterpretation, 'speakers');
            const h = audio.play('ping');
            assert.ok(h >= 0, 'a real play() must return a non-negative handle');
            assert.ok(audio.activeCount('s') >= 1, 'the fallback bus must actually be sounding');
            audio.destroy();
        });
    }

    for (const [name, configure] of SEVEN_ONE_ROWS) {
        it('maxChannelCount ' + name + ' -> effectiveLayoutOf === "7.1", and the destination IS mutated after the pool builds', async () => {
            const { audio, ctx } = await buildLadder(configure);
            assert.equal(audio.effectiveLayoutOf('s'), '7.1');
            assert.equal(ctx.destination.channelCount, 8, 'a real discrete pool mutates the destination to 8ch');
            assert.equal(ctx.destination.channelCountMode, 'explicit');
            assert.equal(ctx.destination.channelInterpretation, 'discrete');
            const h = audio.play('ping');
            assert.ok(h >= 0);
            assert.ok(audio.activeCount('s') >= 1);
            audio.destroy();
        });
    }

    it('exactly 9 of 11 ladder cases resolve to stereo and exactly 2 resolve to "7.1" (tally, not per-row)', () => {
        assert.equal(STEREO_ROWS.length, 9);
        assert.equal(SEVEN_ONE_ROWS.length, 2);
        assert.equal(STEREO_ROWS.length + SEVEN_ONE_ROWS.length, 11);
    });
});

// ---------- 5. effectiveLayoutOf() on non-discrete / unknown buses ----------

describe('effectiveLayoutOf() boundary: non-discrete and unknown bus names', () => {
    it('a plain stereo bus reports null (never a layout token)', async () => {
        const ctx = createMockContext({ state: 'running', maxChannelCount: 8 });
        const audio = new LiteAudio({
            buses: [], poolCapacity: 4, window: fakeWindow(), document: mockDocument(),
            fetch: mockFetch({}), setTimeout: () => 0, clearTimeout: () => {},
        });
        await audio.init(ctx);
        audio.createBus('flat');
        assert.equal(audio.effectiveLayoutOf('flat'), null);
        audio.destroy();
    });

    it('an unknown bus name (never created) reports null, not a throw', async () => {
        const { audio } = await layoutFor();
        assert.equal(audio.effectiveLayoutOf('never-created'), null);
        assert.equal(audio.effectiveLayoutOf(''), null);
        assert.equal(audio.effectiveLayoutOf(undefined), null);
        assert.equal(audio.effectiveLayoutOf(null), null);
    });
});
