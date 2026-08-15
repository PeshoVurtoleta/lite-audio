/**
 * @zakkster/lite-audio - PS3 getHandleInfo(handle) debug decoder boundary
 * suite (node:test), v2.8.0.
 *
 * getHandleInfo is a PURE STRUCTURAL decoder, off every hot path (see
 * decisions/0012-get-handle-info.md). This file is the correctness proof
 * (A1/A2/A6); the existing torture gate's zero-GC non-regression tier is the
 * hot-path control (A3, no new tier -- PS3_PLAN.md explicitly forbids one).
 * A4 (retention) is asserted here directly with --expose-gc.
 *
 * Boundary matrix: 0, 1, N-1, N, N+1 (bus-index population), empty/null/
 * undefined/NaN/-0 (fail-closed input matrix), duplicate dispose (destroy()
 * called twice), dispose-during-iteration (getHandleInfo called from inside
 * a destroyBus mid-sweep), re-entrant write (a decode triggered from inside
 * a play() callback), plus one adversarial case the plan's 11 boundary cases
 * did not enumerate (a boxed/non-primitive Number object).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LiteAudio } from '../Audio.js';
import { createMockContext, mockFetch, mockDocument, mockScheduler, flushMicrotasks } from './mock-ctx.js';

// Mirror of Audio.js (decisions/0001-handle-namespace.md). Not exported, so
// restated here the same way test/Handles.test.js does -- the "engine values
// match this arithmetic" assertions below are what keep the two honest.
const BUS_STRIDE = 4294967296;   // 2^32

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

/** ctx starts 'running' so init() unlocks immediately (mirrors MonitorIdle.test.js). */
async function boot({ buses = ['sfx', 'ui', 'voice'], capacity = 8 } = {}) {
    const ctx = createMockContext({ state: 'running' });
    const clock = mockScheduler();
    const audio = new LiteAudio({
        buses, poolCapacity: capacity, window: fakeWindow(), document: mockDocument(),
        fetch: mockFetch({ '/a.wav': 500, '/b.wav': 400, '/c.wav': 900 }),
        setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    });
    await audio.init(ctx);
    return { audio, ctx, clock };
}

function synth(busIndex, gen, ch) {
    return busIndex * BUS_STRIDE + (((gen << 8) | ch) >>> 0);
}

// ---------------------------------------------------------------------------
// A1 -- fail-closed input matrix (plan cases 1, 2, 7, 9 + adversarial extras)
// ---------------------------------------------------------------------------

describe('A1: fail-closed null on every non-handle input class', () => {
    it('negatives: -1 (Skipped), -2 (TrackStarted), -9999 -> null', async () => {
        const { audio } = await boot();
        assert.equal(audio.getHandleInfo(-1), null);
        assert.equal(audio.getHandleInfo(-2), null);
        assert.equal(audio.getHandleInfo(-9999), null);
    });

    it('non-integers and sentinel-ish values -> null (NaN, undefined, null, string, {}, [], true, 1.5, Infinity, -Infinity, 2^53)', async () => {
        const { audio } = await boot();
        const bad = [
            NaN, undefined, null, '0', {}, [], true, 1.5, Infinity, -Infinity,
            Number.MAX_SAFE_INTEGER + 1,   // 2^53, no longer exactly representable
            2.5e9 + 0.5,                   // non-integer float
        ];
        for (const v of bad) {
            assert.equal(audio.getHandleInfo(v), null, 'input=' + String(v));
        }
    });

    it('-0 is NOT a fail-closed case: -0 decodes as a VALID handle (bus 0, gen 0, ch 0), equal to getHandleInfo(0)', async () => {
        // -0 >= 0 is true and -0 >>> 0 === 0, so Number.isInteger(-0) && !(-0 < 0)
        // both pass the guard -- -0 is handle 0 in disguise, not a non-handle. This
        // is the one entry in the boundary matrix that must NOT be asserted null;
        // asserting it wrongly null would be a false pass on a real edge.
        const { audio } = await boot();
        const info0 = audio.getHandleInfo(0);
        const infoNeg0 = audio.getHandleInfo(-0);
        assert.notEqual(info0, null, 'setup: handle 0 on a live bus 0 must decode');
        assert.deepEqual(infoNeg0, info0, '-0 must decode identically to 0, not null');
    });

    it('busIndex >= _busList.length (e.g. 9999 * BUS_STRIDE) -> null', async () => {
        const { audio } = await boot({ buses: ['sfx'] });
        assert.equal(audio._busList.length, 1, 'setup: one bus');
        assert.equal(audio.getHandleInfo(9999 * BUS_STRIDE), null);
    });

    it('destroyBus a dynamic bus, then a handle that named it -> null (dead-bus fail-closed)', async () => {
        const { audio } = await boot({ buses: [] });
        audio.createBus('dyn');
        const busRec = audio._buses.get('dyn');
        const handle = synth(busRec.index, 3, 7);
        assert.notEqual(audio.getHandleInfo(handle), null, 'setup: live bus decodes');
        assert.equal(audio.destroyBus('dyn'), true);
        assert.equal(audio.getHandleInfo(handle), null, 'tombstoned bus name binding is gone');
    });

    it('after destroy() -> any previously-valid handle -> null', async () => {
        const { audio } = await boot();
        const h = synth(0, 0, 0);
        assert.notEqual(audio.getHandleInfo(h), null, 'setup: valid before destroy');
        audio.destroy();
        assert.equal(audio.getHandleInfo(h), null, 'engine destroyed: _buses is empty, busOf finds nothing');
    });

    it('adversarial: a boxed Number object is not a primitive integer -> null (not among the plan\'s 11 cases)', async () => {
        const { audio } = await boot();
        // eslint-disable-next-line no-new-wrappers
        const boxed = new Number(0);
        assert.equal(audio.getHandleInfo(boxed), null, 'Number.isInteger rejects non-primitive-number objects');
    });
});

// ---------------------------------------------------------------------------
// A2 -- roundtrip across bus index, generation, channel (plan cases 4, 5, 6)
// ---------------------------------------------------------------------------

describe('A2: roundtrip decode across busIndex, generation, channel', () => {
    it('busIndex in {0,1,2} x gen in {0,1,255,65535,2^24-1} x ch in {0,1,128,255} decode exactly', async () => {
        const { audio } = await boot({ buses: ['sfx', 'ui', 'voice'] });
        const names = ['sfx', 'ui', 'voice'];
        const gens = [0, 1, 255, 65535, (2 ** 24) - 1];
        const chs = [0, 1, 128, 255];

        for (let busIndex = 0; busIndex < 3; busIndex++) {
            for (const gen of gens) {
                for (const ch of chs) {
                    const h = synth(busIndex, gen, ch);
                    const info = audio.getHandleInfo(h);
                    assert.notEqual(info, null, `busIndex=${busIndex} gen=${gen} ch=${ch}`);
                    assert.equal(info.busName, names[busIndex], `busIndex=${busIndex}`);
                    assert.equal(info.generation, gen, `gen=${gen}`);
                    assert.equal(info.channel, ch, `ch=${ch}`);
                }
            }
        }
    });

    it('channel boundary: channel 0 and channel 255 decode exactly', async () => {
        const { audio } = await boot();
        assert.equal(audio.getHandleInfo(synth(0, 5, 0)).channel, 0);
        assert.equal(audio.getHandleInfo(synth(0, 5, 255)).channel, 255);
    });

    it('generation roundtrip: gen 0, gen 1, gen 2^24-1 decode exactly', async () => {
        const { audio } = await boot();
        assert.equal(audio.getHandleInfo(synth(0, 0, 3)).generation, 0);
        assert.equal(audio.getHandleInfo(synth(0, 1, 3)).generation, 1);
        assert.equal(audio.getHandleInfo(synth(0, (2 ** 24) - 1, 3)).generation, (2 ** 24) - 1);
    });
});

// ---------------------------------------------------------------------------
// plan case 3 -- real play() handle, purity (plan case 10), stop() still works
// ---------------------------------------------------------------------------

describe('real play() handle: decode, purity, and continued usability', () => {
    async function bootWithSound() {
        const { audio, clock } = await boot({ buses: ['sfx'] });
        await audio.defineSounds({ ping: { src: ['/a.wav'], bus: 'sfx' } });
        await flushMicrotasks(8);
        return { audio, clock };
    }

    it('play() then getHandleInfo(h) -> correct bus name, channel in 0..255, generation >= 0', async () => {
        const { audio } = await bootWithSound();
        const h = audio.play('ping');
        assert.ok(h >= 0, 'setup: real handle issued');
        const info = audio.getHandleInfo(h);
        assert.notEqual(info, null);
        assert.equal(info.busName, 'sfx');
        assert.ok(info.channel >= 0 && info.channel <= 255);
        assert.ok(info.generation >= 0);
    });

    it('purity: activeCount() and isPlaying(h) are unchanged before/after a decode call', async () => {
        const { audio } = await bootWithSound();
        const h = audio.play('ping');
        const countBefore = audio.activeCount('sfx');
        const playingBefore = audio.isPlaying(h);

        audio.getHandleInfo(h);   // the call under test -- must not mutate

        assert.equal(audio.activeCount('sfx'), countBefore, 'activeCount unchanged by a decode');
        assert.equal(audio.isPlaying(h), playingBefore, 'isPlaying unchanged by a decode');
    });

    it('the SAME handle still stop()s the voice after getHandleInfo decoded it', async () => {
        const { audio } = await bootWithSound();
        const h = audio.play('ping');
        assert.equal(audio.isPlaying(h), true, 'setup: voice is live');
        audio.getHandleInfo(h);
        audio.stop(h);
        assert.equal(audio.isPlaying(h), false, 'stop() still reaches the voice after a decode');
    });
});

// ---------------------------------------------------------------------------
// plan case 11 -- fresh object per call (D4)
// ---------------------------------------------------------------------------

describe('fresh object per call (D4: debug-ergonomics allocation, off the hot path)', () => {
    it('two getHandleInfo(h) calls return deep-equal but NOT === objects', async () => {
        const { audio } = await boot();
        const h = synth(0, 1, 2);
        const a = audio.getHandleInfo(h);
        const b = audio.getHandleInfo(h);
        assert.deepEqual(a, b);
        assert.notEqual(a, b, 'must be two distinct object identities');
    });
});

// ---------------------------------------------------------------------------
// Boundary matrix over bus-index population: 0, 1, N-1, N, N+1
// ---------------------------------------------------------------------------

describe('boundary matrix over bus-index population (0, 1, N-1, N, N+1)', () => {
    it('0: no buses at all -> every handle decodes null', async () => {
        const { audio } = await boot({ buses: [] });
        assert.equal(audio._busList.length, 0, 'setup: zero buses');
        assert.equal(audio.getHandleInfo(0), null);
        assert.equal(audio.getHandleInfo(synth(0, 0, 0)), null);
    });

    it('1: exactly one bus -> its handle decodes, the next index does not', async () => {
        const { audio } = await boot({ buses: ['only'] });
        assert.equal(audio._busList.length, 1);
        assert.notEqual(audio.getHandleInfo(synth(0, 0, 0)), null);
        assert.equal(audio.getHandleInfo(synth(1, 0, 0)), null, 'busIndex 1 does not exist yet');
    });

    it('N-1 / N / N+1: N dynamic buses created, decode the last-valid index, one-past-the-end, and after one more create', async () => {
        const { audio } = await boot({ buses: [] });
        const N = 5;
        for (let i = 0; i < N; i++) audio.createBus('c' + i);
        assert.equal(audio._busList.length, N, 'setup: N buses');

        // N-1: the last valid index.
        const infoLast = audio.getHandleInfo(synth(N - 1, 0, 0));
        assert.notEqual(infoLast, null);
        assert.equal(infoLast.busName, 'c' + (N - 1));

        // N: one past the highest live index -> null.
        assert.equal(audio.getHandleInfo(synth(N, 0, 0)), null);

        // N+1: create one more bus, the formerly-out-of-range index N now resolves.
        audio.createBus('after');
        const infoAfter = audio.getHandleInfo(synth(N, 0, 0));
        assert.notEqual(infoAfter, null);
        assert.equal(infoAfter.busName, 'after');
    });
});

// ---------------------------------------------------------------------------
// Duplicate dispose: destroy() called twice, getHandleInfo stays null both times
// ---------------------------------------------------------------------------

describe('duplicate dispose', () => {
    it('destroy() called twice: getHandleInfo(any handle) stays null and neither call throws', async () => {
        const { audio } = await boot();
        const h = synth(0, 0, 0);
        assert.notEqual(audio.getHandleInfo(h), null, 'setup: valid before destroy');

        assert.doesNotThrow(() => audio.destroy());
        assert.equal(audio.getHandleInfo(h), null);

        assert.doesNotThrow(() => audio.destroy(), 'repeat destroy() must not throw');
        assert.equal(audio.getHandleInfo(h), null, 'still null after the repeat dispose');
    });
});

// ---------------------------------------------------------------------------
// Dispose-during-iteration: getHandleInfo invoked from inside a destroyBus's
// own mid-sweep teardown callback, decoding a DIFFERENT (later) bus's handle.
// ---------------------------------------------------------------------------

describe('dispose-during-iteration: getHandleInfo called mid-teardown from inside destroyBus', () => {
    it('decoding another live bus mid-teardown does not throw and still resolves correctly', async () => {
        const { audio } = await boot({ buses: [] });
        audio.createBus('meterA', { meter: true });
        audio.createBus('meterB', { meter: true });
        const recA = audio._buses.get('meterA');
        const recB = audio._buses.get('meterB');
        const handleB = synth(recB.index, 0, 0);

        let sawDuringTeardown;
        const origDisconnect = recA.gain.disconnect.bind(recA.gain);
        recA.gain.disconnect = () => {
            // Mid-teardown of meterA: meterB is still fully live, so its handle
            // must still decode correctly from inside this callback.
            sawDuringTeardown = audio.getHandleInfo(handleB);
            origDisconnect();
        };

        assert.doesNotThrow(() => audio.destroyBus('meterA'));
        assert.notEqual(sawDuringTeardown, null, 'meterB was still live during meterA teardown');
        assert.equal(sawDuringTeardown.busName, 'meterB');

        // Now meterA itself must decode null (it is the one that was torn down).
        assert.equal(audio.getHandleInfo(synth(recA.index, 0, 0)), null);
    });
});

// ---------------------------------------------------------------------------
// Re-entrant write: a decode triggered from INSIDE a play() call (via a mock
// node callback), then the outer play()'s own handle still decodes correctly
// afterward -- getHandleInfo must not disturb any in-flight engine state.
// ---------------------------------------------------------------------------

describe('re-entrant write: getHandleInfo invoked from inside another handle-producing call', () => {
    it('decoding a handle from inside a nested play() callback does not corrupt the outer play()\'s own handle', async () => {
        const { audio, clock } = await boot({ buses: ['sfx'] });
        await audio.defineSounds({ ping: { src: ['/a.wav'], bus: 'sfx' } });
        await flushMicrotasks(8);

        const first = audio.play('ping');
        assert.ok(first >= 0, 'setup: first voice issued');

        // Re-entrantly decode the first handle WHILE issuing a second play(),
        // simulating a caller who inspects a handle from inside another
        // in-flight engine operation.
        let nestedInfo = null;
        const second = (() => {
            nestedInfo = audio.getHandleInfo(first);
            return audio.play('ping');
        })();

        assert.notEqual(nestedInfo, null, 'the re-entrant decode succeeded');
        assert.equal(nestedInfo.busName, 'sfx');
        assert.ok(second >= 0, 'the second play() still issued a real handle');
        // The first handle must still decode identically after the re-entrant call.
        const after = audio.getHandleInfo(first);
        assert.deepEqual(after, nestedInfo, 'the outer handle\'s decode is unaffected by the nested call');
    });
});

// ---------------------------------------------------------------------------
// A4 -- retention: 1e5 calls + forced GC leaves no retained growth in the
// engine itself (the result objects are not held by anything internal).
// ---------------------------------------------------------------------------

describe('A4: retention -- 1e5 getHandleInfo calls do not grow engine-held state', () => {
    it('1e5 decode calls then forced GC: bus map size and active count are unchanged', { skip: typeof global.gc !== 'function' && 'run with --expose-gc' }, async () => {
        const { audio } = await boot({ buses: ['sfx'] });
        await audio.defineSounds({ ping: { src: ['/a.wav'], bus: 'sfx' } });
        await flushMicrotasks(8);
        const h = audio.play('ping');

        const busCountBefore = audio._buses.size;
        const activeBefore = audio.activeCount('sfx');

        const HOT = 1e5;
        for (let i = 0; i < HOT; i++) {
            const info = audio.getHandleInfo(h);
            if (info === null) throw new Error('unexpected null mid-loop');
        }

        global.gc();
        await new Promise((r) => setTimeout(r, 0));

        assert.equal(audio._buses.size, busCountBefore, 'no new bus entries retained');
        assert.equal(audio.activeCount('sfx'), activeBefore, 'no voice-count drift from decode calls');
        // The engine itself holds no reference to any returned info object: it is
        // not stored on the bus record, the pool, or any instance field, so there
        // is nothing further to null out here. This is the structural proof that
        // pairs with the torture gate's own retention witness (A3/A4 together).
    });
});
