/** @zakkster/lite-audio - handle namespace across buses */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LiteAudio } from '../Audio.js';
import { createMockContext, mockFetch, flushMicrotasks } from './mock-ctx.js';

function fakeWindow() {
    const cbs = [];
    return {
        addEventListener(evt, cb) { cbs.push(cb); },
        removeEventListener() {},
        _fire() { for (const cb of [...cbs]) cb({}); },
    };
}

async function boot(opts = {}) {
    const ctx = createMockContext({ state: 'suspended' });
    const win = fakeWindow();
    const audio = new LiteAudio({
        buses: ['sfx', 'ui', 'voice'],
        poolCapacity: 4,
        window: win,
        document: null,
        fetch: mockFetch({ '/laser.wav': 500, '/click.wav': 400, '/line.wav': 900 }),
        ...opts,
    });
    await audio.init(ctx);
    await audio.defineSounds({
        laser: { src: ['/laser.wav'], bus: 'sfx' },
        click: { src: ['/click.wav'], bus: 'ui' },
        line: { src: ['/line.wav'], bus: 'voice' },
    });
    win._fire();
    await flushMicrotasks(8);
    return { audio, ctx };
}

describe('handle namespace', () => {
    it('handles from different buses are never equal', async () => {
        const { audio } = await boot();
        const a = audio.play('laser');
        const b = audio.play('click');
        const c = audio.play('line');
        assert.ok(a >= 0 && b >= 0 && c >= 0);
        assert.notEqual(a, b);
        assert.notEqual(b, c);
        assert.notEqual(a, c);
        // Underneath, every pool independently issued channel 0 / generation 0.
        assert.equal(a >>> 0, b >>> 0);
        assert.equal(b >>> 0, c >>> 0);
    });

    it('stop() cannot cross a bus boundary', async () => {
        const { audio } = await boot();
        const sfx = audio.play('laser');
        const ui = audio.play('click');
        const voice = audio.play('line');

        audio.stop(sfx);

        assert.equal(audio.isPlaying(sfx), false, 'named voice stopped');
        assert.equal(audio.isPlaying(ui), true, 'ui bus untouched');
        assert.equal(audio.isPlaying(voice), true, 'voice bus untouched');
    });

    it('busOf() names the bus that issued the handle', async () => {
        const { audio } = await boot();
        assert.equal(audio.busOf(audio.play('laser')), 'sfx');
        assert.equal(audio.busOf(audio.play('click')), 'ui');
        assert.equal(audio.busOf(audio.play('line')), 'voice');
        assert.equal(audio.busOf(-1), null);
    });

    it('a handle survives its own bus being stolen from, and dies with its voice', async () => {
        const { audio, ctx } = await boot();
        const first = audio.play('laser');
        for (let i = 0; i < 3; i++) audio.play('laser');   // fills capacity 4
        assert.equal(audio.isPlaying(first), true);
        assert.equal(audio.activeCount('sfx'), 4);

        audio.play('laser');                               // steals the oldest: `first`
        assert.equal(audio.isPlaying(first), false, 'stolen handle goes stale');
        assert.equal(audio.activeCount('sfx'), 4, 'still four voices, one is new');

        audio.stop(first);                                 // stale stop must not fire
        assert.equal(audio.activeCount('sfx'), 4, 'stale stop is a no-op');
    });

    it('activeCount() reports per-bus and engine-wide', async () => {
        const { audio } = await boot();
        audio.play('laser');
        audio.play('laser');
        audio.play('click');
        assert.equal(audio.activeCount('sfx'), 2);
        assert.equal(audio.activeCount('ui'), 1);
        assert.equal(audio.activeCount('voice'), 0);
        assert.equal(audio.activeCount(), 3);
        assert.equal(audio.activeCount('nope'), 0);

        audio.stopBus('sfx');
        assert.equal(audio.activeCount(), 1);
        audio.stopAll();
        assert.equal(audio.activeCount(), 0);
    });

    it('handles stay exact integers well inside 2^53', async () => {
        const { audio } = await boot();
        const h = audio.play('line');                      // bus index 2
        assert.ok(Number.isSafeInteger(h));
        assert.equal(Math.floor(h / 4294967296), 2);
        assert.equal(h >>> 0, 0, 'low half is the untouched pool handle');
    });
});
