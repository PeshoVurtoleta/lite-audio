/**
 * @zakkster/lite-audio - S6/S7 output-layout detection contract tests (node:test).
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
 * NaN, non-integer, a string digit, an integer under/at/over EVERY threshold --
 * 4, 6, 8 -- a missing destination)? Does a discrete createBus() request under
 * an undersized/unknown sink transparently step down the S7 fallback ladder
 * (D2) to the largest preset that fits, or all the way to a working stereo bus,
 * without ever mutating the destination on the stereo-fallback path? Is
 * detection cold-once (no re-detect on a second init(), a cached readout
 * survives destroy())? Every case here is a correctness question, not a budget.
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
 * Build a LiteAudio with ONE discrete bus (default preset '7.1', overridable for
 * the D2 12-cell matrix) + a routed sound against a context configured by
 * `configureCtx`, unlocked (ctx starts 'running' so init() marks it unlocked
 * immediately - no gesture needed), fully settled.
 */
async function buildLadder(configureCtx, preset = '7.1') {
    const ctx = createMockContext({ state: 'running' });
    if (configureCtx) configureCtx(ctx);
    const audio = new LiteAudio({
        buses: [], poolCapacity: 4, window: fakeWindow(), document: mockDocument(),
        fetch: mockFetch({ '/s.wav': 500 }), setTimeout: () => 0, clearTimeout: () => {},
    });
    await audio.init(ctx);
    audio.createBus('s', { spatial: 'discrete', preset });
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

    it('3 (N-1, just under the 3.1 threshold) -> stereo', async () => {
        const { audio } = await layoutFor((ctx) => ctx._setMaxChannelCount(3));
        assert.equal(audio.layoutOf(), 'stereo');
    });

    it("4 (N, the 3.1 threshold) -> '3.1' (S7: widened from stereo)", async () => {
        const { audio } = await layoutFor((ctx) => ctx._setMaxChannelCount(4));
        assert.equal(audio.layoutOf(), '3.1');
    });

    it("5 (N+1 of the 3.1 threshold, top of the 3.1 band) -> '3.1'", async () => {
        const { audio } = await layoutFor((ctx) => ctx._setMaxChannelCount(5));
        assert.equal(audio.layoutOf(), '3.1');
    });

    it("6 (N, the 5.1 threshold) -> '5.1' (S7: widened from stereo)", async () => {
        const { audio } = await layoutFor((ctx) => ctx._setMaxChannelCount(6));
        assert.equal(audio.layoutOf(), '5.1');
    });

    it("7 (N+1 of the 5.1 threshold, top of the 5.1 band, N-1 of the 7.1 threshold) -> '5.1'", async () => {
        const { audio } = await layoutFor((ctx) => ctx._setMaxChannelCount(7));
        assert.equal(audio.layoutOf(), '5.1');
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
    it('adversarial: 3.9999999 (a non-integer that rounds visually to 4) -> stereo, never coerced/truncated to 4', async () => {
        const { audio } = await layoutFor((ctx) => ctx._setMaxChannelCount(3.9999999));
        assert.equal(audio.layoutOf(), 'stereo', 'Number.isInteger must reject a near-integer float, not Math.floor it');
    });

    it('9 (N+1, just over the 7.1 threshold) -> "7.1"', async () => {
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

// ---------- 4. the fallback ladder (T-SP4 (b)): request "7.1" under every ---
// ----------    reading (S7: 4/5/6/7 now step DOWN to 3.1/5.1 -- they no ----
// ----------    longer fall all the way to stereo) ---------------------------

describe('discrete request fallback ladder: request "7.1" under every sink reading', () => {
    // Below the 3.1 floor (M < 4): a '7.1' request has nowhere to land and
    // falls all the way to a working plain-stereo bus. Destination untouched.
    const STEREO_ROWS = [
        ['absent', (ctx) => ctx._deleteMaxChannelCount()],
        ['undefined', (ctx) => ctx._setMaxChannelCount(undefined)],
        ['null', (ctx) => ctx._setMaxChannelCount(null)],
        ['NaN', (ctx) => ctx._setMaxChannelCount(NaN)],
        ['2', (ctx) => ctx._setMaxChannelCount(2)],
        ['7.5', (ctx) => ctx._setMaxChannelCount(7.5)],
        ["'8'", (ctx) => ctx._setMaxChannelCount('8')],
    ];
    // S7: 4 or 5 -> the request steps down to '3.1' and BUILDS (4-lane pool);
    // the destination IS mutated to 4ch.
    const THREE_ONE_ROWS = [
        ['4', (ctx) => ctx._setMaxChannelCount(4)],
        ['5', (ctx) => ctx._setMaxChannelCount(5)],
    ];
    // S7: 6 or 7 -> the request steps down to '5.1' and BUILDS (6-lane pool);
    // the destination IS mutated to 6ch.
    const FIVE_ONE_ROWS = [
        ['6', (ctx) => ctx._setMaxChannelCount(6)],
        ['7', (ctx) => ctx._setMaxChannelCount(7)],
    ];
    const SEVEN_ONE_ROWS = [
        ['8', (ctx) => ctx._setMaxChannelCount(8)],
        ['12', (ctx) => ctx._setMaxChannelCount(12)],
    ];

    for (const [name, configure] of STEREO_ROWS) {
        it('maxChannelCount ' + name + ' -> effectiveLayoutOf === "stereo", and the fallback bus actually plays', async () => {
            const { audio, ctx } = await buildLadder(configure);
            assert.equal(audio.effectiveLayoutOf('s'), 'stereo');
            // Destination NOT mutated on a stereo-fallback case (Audio.js:1050 guard).
            assert.equal(ctx.destination.channelCount, 2, 'stereo fallback must never touch destination.channelCount');
            assert.equal(ctx.destination.channelCountMode, 'max');
            assert.equal(ctx.destination.channelInterpretation, 'speakers');
            const h = audio.play('ping');
            assert.ok(h >= 0, 'a real play() must return a non-negative handle');
            assert.ok(audio.activeCount('s') >= 1, 'the fallback bus must actually be sounding');
            audio.destroy();
        });
    }

    for (const [name, configure] of THREE_ONE_ROWS) {
        it('maxChannelCount ' + name + ' -> a "7.1" request steps DOWN to effectiveLayoutOf === "3.1" and builds a 4-lane pool', async () => {
            const { audio, ctx } = await buildLadder(configure);
            assert.equal(audio.effectiveLayoutOf('s'), '3.1');
            assert.equal(ctx.destination.channelCount, 4, 'a 4-lane discrete pool mutates the destination to 4ch');
            assert.equal(ctx.destination.channelCountMode, 'explicit');
            assert.equal(ctx.destination.channelInterpretation, 'discrete');
            const h = audio.play('ping');
            assert.ok(h >= 0);
            assert.ok(audio.activeCount('s') >= 1);
            audio.destroy();
        });
    }

    for (const [name, configure] of FIVE_ONE_ROWS) {
        it('maxChannelCount ' + name + ' -> a "7.1" request steps DOWN to effectiveLayoutOf === "5.1" and builds a 6-lane pool', async () => {
            const { audio, ctx } = await buildLadder(configure);
            assert.equal(audio.effectiveLayoutOf('s'), '5.1');
            assert.equal(ctx.destination.channelCount, 6, 'a 6-lane discrete pool mutates the destination to 6ch');
            assert.equal(ctx.destination.channelCountMode, 'explicit');
            assert.equal(ctx.destination.channelInterpretation, 'discrete');
            const h = audio.play('ping');
            assert.ok(h >= 0);
            assert.ok(audio.activeCount('s') >= 1);
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

    it('exactly 7 of 13 ladder cases resolve to stereo, 2 to "3.1", 2 to "5.1", 2 to "7.1" (tally, not per-row)', () => {
        assert.equal(STEREO_ROWS.length, 7);
        assert.equal(THREE_ONE_ROWS.length, 2);
        assert.equal(FIVE_ONE_ROWS.length, 2);
        assert.equal(SEVEN_ONE_ROWS.length, 2);
        assert.equal(STEREO_ROWS.length + THREE_ONE_ROWS.length + FIVE_ONE_ROWS.length + SEVEN_ONE_ROWS.length, 13);
    });
});

// ---------- 4b. the FULL D2 12-cell ladder matrix (requested x M) ----------
// Every cell of the pinned decisions/0009-preset-ladder.md D2 table: a request
// R on a sink of M channels resolves to the LARGEST preset that fits
// min(need(R), M), stepping DOWN 7.1 -> 5.1 -> 3.1 -> stereo, NEVER upgrading
// (a '5.1' request on an 8ch sink stays '5.1'). Mirrors torture.mjs's
// SP4_LADDER exactly (same 12 rows), but as a named, individually-reportable
// node:test case per cell rather than a GC-gate tally.
describe('D2 fallback ladder: the full 12-cell (requested x M) matrix', () => {
    const D2_MATRIX = [
        ['7.1@8', '7.1', 8, '7.1'],
        ['7.1@6', '7.1', 6, '5.1'],
        ['7.1@4', '7.1', 4, '3.1'],
        ['7.1@2', '7.1', 2, 'stereo'],
        ['5.1@8', '5.1', 8, '5.1'],
        ['5.1@6', '5.1', 6, '5.1'],
        ['5.1@4', '5.1', 4, '3.1'],
        ['5.1@2', '5.1', 2, 'stereo'],
        ['3.1@8', '3.1', 8, '3.1'],
        ['3.1@6', '3.1', 6, '3.1'],
        ['3.1@4', '3.1', 4, '3.1'],
        ['3.1@2', '3.1', 2, 'stereo'],
    ];

    for (const [name, request, maxChannelCount, expect] of D2_MATRIX) {
        it('request ' + name + ' -> effectiveLayoutOf === "' + expect + '" (never upgrades, only steps down)', async () => {
            const { audio, ctx } = await buildLadder((ctx) => ctx._setMaxChannelCount(maxChannelCount), request);
            assert.equal(audio.effectiveLayoutOf('s'), expect);
            const h = audio.play('ping');
            assert.ok(h >= 0, 'cell ' + name + ' must build a bus that actually plays');
            assert.ok(audio.activeCount('s') >= 1, 'cell ' + name + ' must actually be sounding');
            if (expect === 'stereo') {
                assert.equal(ctx.destination.channelCount, 2, 'a stereo-fallback cell must never mutate the destination');
            } else {
                const need = expect === '7.1' ? 8 : expect === '5.1' ? 6 : 4;
                assert.equal(ctx.destination.channelCount, need, 'cell ' + name + ' must mutate the destination to the BUILT layout\'s channel count');
            }
            audio.destroy();
        });
    }

    it('all 12 cells pinned: 9 build a discrete pool, 3 fall back to stereo (tally, not per-row)', () => {
        const built = D2_MATRIX.filter(([, , , e]) => e !== 'stereo').length;
        const fell = D2_MATRIX.filter(([, , , e]) => e === 'stereo').length;
        assert.equal(built, 9);
        assert.equal(fell, 3);
        assert.equal(D2_MATRIX.length, 12);
    });

    it('a request never upgrades: "5.1" on an 8ch sink stays "5.1" though the sink could carry "7.1"', async () => {
        const { audio, ctx } = await buildLadder((ctx) => ctx._setMaxChannelCount(8), '5.1');
        assert.equal(audio.effectiveLayoutOf('s'), '5.1', 'a 5.1 request must never be upgraded to 7.1 just because the sink can carry it');
        assert.equal(audio.layoutOf(), '7.1', 'layoutOf() (sink capability) is a DIFFERENT question from effectiveLayoutOf() (per-bus built layout)');
        audio.destroy();
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
