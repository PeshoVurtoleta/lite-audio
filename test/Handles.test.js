/**
 * @zakkster/lite-audio - the handle contract (AU0 / v1.1.1).
 *
 * The engine return type is one number carrying four kinds of value:
 *   0                          a real handle - bus 0, channel 0, generation 0
 *   busIndex * 2^32 + pool     every other real handle
 *   -1  (SKIPPED)              nothing was played
 *   -2  (TRACK_STARTED)        playUnique() started a music track
 * These tests pin every encoding by name, including the two that make 0 special:
 * stop(0) must reach the real first-voice-on-bus-0, and stop(-2) must not.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LiteAudio } from '../Audio.js';
import {
    createMockContext, mockFetch, mockDocument, mockScheduler, flushMicrotasks,
} from './mock-ctx.js';

// Mirror of Audio.js: handle = busIndex * BUS_STRIDE + poolHandle. Not exported
// from the module (it is an internal encoding), so it is restated here and the
// "engine values match this arithmetic" tests below are what keep the two honest.
const BUS_STRIDE = 4294967296;   // 2^32
const MAX_BUSES = 2097152;       // 2^21

function fakeWindow() {
    const cbs = [];
    return {
        addEventListener(evt, cb) { cbs.push(cb); },
        removeEventListener() {},
        fire() { for (const cb of [...cbs]) cb({}); },
    };
}

async function boot({ buses = ['sfx', 'ui', 'voice'] } = {}) {
    const ctx = createMockContext({ state: 'suspended' });
    const win = fakeWindow();
    const doc = mockDocument();
    const clock = mockScheduler();
    const audio = new LiteAudio({
        buses,
        poolCapacity: 4,
        window: win,
        document: doc,
        fetch: mockFetch({ '/laser.wav': 500, '/click.wav': 400, '/line.wav': 900 }),
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
    });
    await audio.init(ctx);
    await audio.defineSounds({
        laser: { src: ['/laser.wav'], bus: 'sfx' },   // bus index 0
        click: { src: ['/click.wav'], bus: 'ui' },    // bus index 1
        line: { src: ['/line.wav'], bus: 'voice' },   // bus index 2
    });
    await audio.defineTracks({ theme: { src: ['/theme.mp3'], bus: 'sfx' } });
    win.fire();
    await flushMicrotasks(8);
    return { audio, ctx };
}

describe('handle encoding: 0 is a real handle, not a null sentinel', () => {
    it('the first play on bus 0 returns exactly 0', async () => {
        const { audio } = await boot();
        const h = audio.play('laser');   // bus 0, channel 0, generation 0
        assert.equal(h, 0);
        assert.equal(audio.isPlaying(h), true, '0 names a live voice');
        assert.equal(audio.busOf(h), 'sfx');
    });

    it('stop(0) reaches the real bus-0/channel-0/generation-0 voice', async () => {
        const { audio } = await boot();
        const h = audio.play('laser');
        assert.equal(h, 0);
        assert.equal(audio.activeCount('sfx'), 1);
        audio.stop(0);
        assert.equal(audio.isPlaying(0), false, 'stop(0) stopped the voice');
        assert.equal(audio.activeCount('sfx'), 0);
    });
});

describe('handle encoding: -1 (SKIPPED) is inert', () => {
    it('an unplayable call returns -1 and -1 is a no-op everywhere', async () => {
        const { audio } = await boot();
        assert.equal(audio.play('does-not-exist'), -1);
        assert.equal(audio.isPlaying(-1), false);
        assert.equal(audio.busOf(-1), null);

        // A live voice on bus 0 (handle 0) must survive stop(-1).
        const live = audio.play('laser');
        assert.equal(live, 0);
        audio.stop(-1);
        assert.equal(audio.isPlaying(0), true, 'stop(-1) touched nothing');
    });
});

describe('handle encoding: -2 (TRACK_STARTED) is inert', () => {
    it('playUnique on a track returns -2, and -2 kills no SFX voice', async () => {
        const { audio } = await boot();

        // Occupy the dangerous slot: a live voice whose handle is 0.
        const live = audio.play('laser');
        assert.equal(live, 0);

        const r = audio.playUnique('theme');   // theme is a track
        assert.equal(r, -2, 'a started track reports TRACK_STARTED, never 0');

        audio.stop(-2);
        assert.equal(audio.isPlaying(0), true, 'stop(-2) did not reach the bus-0 voice');
        assert.equal(audio.isPlaying(-2), false);
        assert.equal(audio.busOf(-2), null);
    });
});

describe('handle encoding: busIndex * 2^32 + poolHandle', () => {
    it('a handle decodes to its bus index and its raw pool handle', async () => {
        const { audio } = await boot();
        const onVoice = audio.play('line');            // bus index 2
        assert.ok(Number.isSafeInteger(onVoice));
        assert.equal(Math.floor(onVoice / BUS_STRIDE), 2, 'high half is the bus index');
        assert.equal(onVoice >>> 0, 0, 'low half is the untouched pool handle (gen 0, chan 0)');
        assert.equal(onVoice, 2 * BUS_STRIDE + 0);
    });

    it('every bus off zero produces a handle at or past 2^32 (out of SMI range)', async () => {
        const { audio } = await boot();
        const ui = audio.play('click');                // bus index 1
        const voice = audio.play('line');              // bus index 2
        assert.ok(ui >= BUS_STRIDE, 'bus 1 handle is >= 2^32');
        assert.ok(voice >= 2 * BUS_STRIDE, 'bus 2 handle is >= 2*2^32');
    });

    it('the real engine leaves SMI range on bus 0 past generation 8,388,608', async () => {
        // The torture gate measures a SYNTHETIC handle return at this generation;
        // this pins the real engine to the same value. Drive the bus-0 pool's
        // channel-0 generation to the SMI boundary directly (8.4M real plays would
        // just flood the mock's event log) and confirm the handle the engine hands
        // back is 2^31 -- one past the largest SMI, so genuinely a boxed double.
        const { audio } = await boot();
        const pool = audio._buses.get('sfx').pool;     // bus index 0
        const GEN = 8388608;                            // 2^23; handle becomes 2^31
        pool.generations[0] = GEN;
        // Fill the other channels so the stealer picks channel 0 (oldest/empty).
        // With a fresh pool every channel is free, so the first play takes ch 0.
        const h = audio.play('laser');
        assert.equal(h >>> 0, (GEN * 256) >>> 0, 'low half carries generation 8,388,608');
        assert.equal(h, 2147483648, 'bus 0 handle at gen 8,388,608 is exactly 2^31');
        assert.ok(h > 2147483647, 'past the max SMI (2^31 - 1): a boxed double');
        assert.equal(audio.isPlaying(h), true);
        audio.stop(h);
        assert.equal(audio.isPlaying(h), false, 'a boxed-double handle still round-trips through stop()');
    });
});

describe('bus ceiling (2^21) fails closed instead of colliding', () => {
    it('more than 2^21 buses throws a library error at init()', async () => {
        const ctx = createMockContext({ state: 'suspended' });
        // One string reference, an array of 2^21 + 1 slots pointing at it: the
        // guard checks .length before building a single node, so this is cheap.
        const buses = new Array(MAX_BUSES + 1).fill('b');
        const audio = new LiteAudio({ buses, window: null, document: null });
        await assert.rejects(
            () => audio.init(ctx),
            (err) => err instanceof RangeError && /ceiling/.test(err.message) && /2\^21/.test(err.message),
            'init must reject an unrepresentable bus count with a RangeError naming the ceiling',
        );
    });

    it("'master' is implicit and does not count against the ceiling", async () => {
        // A normal graph plus an explicit 'master' name still initializes: master
        // is skipped, so it cannot push a real graph over the edge.
        const ctx = createMockContext({ state: 'suspended' });
        const audio = new LiteAudio({ buses: ['master', 'sfx', 'ui'], window: null, document: null });
        await audio.init(ctx);   // must not throw
        assert.equal(audio.busOf(-1), null);
        audio.destroy();
    });
});
