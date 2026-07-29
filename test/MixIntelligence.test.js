/** @zakkster/lite-audio - mix intelligence (AU1 / v1.2.0):
 *  ducking, snapshots, meters, auto-suspend, dynamic buses. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LiteAudio } from '../Audio.js';
import {
    createMockContext, mockFetch, mockDocument, mockScheduler, flushMicrotasks, paramEvents,
} from './mock-ctx.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function fakeWindow(navigator) {
    const cbs = [];
    return {
        navigator,
        addEventListener(evt, cb) { cbs.push(cb); },
        removeEventListener() {},
        fire() { for (const cb of [...cbs]) cb({}); },
    };
}

async function boot({ unlock = true, buses = ['sfx', 'music', 'voice'], navigator } = {}) {
    const ctx = createMockContext({ state: 'suspended' });
    const win = fakeWindow(navigator);
    const doc = mockDocument();
    const clock = mockScheduler();

    const audio = new LiteAudio({
        buses,
        poolCapacity: 8,
        window: win,
        document: doc,
        fetch: mockFetch({ '/laser.wav': 500, '/boom.wav': 500 }),
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
    });

    await audio.init(ctx);
    await audio.defineSounds({
        laser: { src: ['/laser.wav'], bus: 'sfx' },
        shout: { src: ['/laser.wav'], bus: 'voice' },
    });

    if (unlock) {
        win.fire();
        await flushMicrotasks(8);
    }

    const bus = (name) => audio._buses.get(name);
    const duckParam = (name) => bus(name).duckGain.gain;
    // One monitor tick: the mock scheduler holds exactly the monitor's pending
    // timer (nothing here schedules a track pause), and the tick reschedules
    // the next, so one flush == one tick.
    const tick = () => clock.flush();
    return { audio, ctx, win, clock, bus, duckParam, tick };
}

// ---------------------------------------------------------------------------
// Ducking
// ---------------------------------------------------------------------------

describe('duck / stopDuck (manual)', () => {
    it('dips the sidechain, not the volume gain, so it composes with volume/mute', async () => {
        const { audio, bus, duckParam } = await boot();
        const volEventsBefore = paramEvents(bus('music').gain.gain).length;

        audio.duck('music', 0.2, { attack: 0.03 });

        const dg = paramEvents(duckParam('music'), 'target');
        assert.equal(dg.length, 1, 'one dip scheduled');
        assert.equal(dg[0][1], 0.2, 'to the requested level');
        assert.equal(dg[0][3], 0.03, 'with the requested attack TC');
        // The bus volume gain was NOT touched - duck lives on its own param.
        assert.equal(paramEvents(bus('music').gain.gain).length, volEventsBefore);
    });

    it('attack and release time constants are distinct (asymmetry)', async () => {
        const { audio, duckParam } = await boot();
        audio.duck('music', 0.2, { attack: 0.02, release: 0.6 });
        audio.stopDuck('music');

        const ev = paramEvents(duckParam('music'), 'target');
        assert.equal(ev.length, 2);
        assert.equal(ev[0][3], 0.02, 'attack TC');
        assert.equal(ev[1][1], 1, 'releases to rest');
        assert.equal(ev[1][3], 0.6, 'release TC remembered from the duck() call');
        assert.notEqual(ev[0][3], ev[1][3], 'attack != release');
    });

    it('is inert on an unknown bus and after destroy', async () => {
        const { audio } = await boot();
        assert.doesNotThrow(() => audio.duck('nope', 0.5));
        audio.destroy();
        assert.doesNotThrow(() => audio.duck('music', 0.5));
    });
});

describe('duckOn (automatic follower)', () => {
    it('dips the target on the trigger crossing its threshold, recovers below it', async () => {
        const { audio, duckParam, tick } = await boot();
        audio.duckOn('sfx', 'music', { threshold: 2, level: 0.3, attack: 0.02, release: 0.5 });

        tick();                                   // 0 voices: below, no write
        assert.equal(paramEvents(duckParam('music'), 'target').length, 0);

        audio.play('laser'); audio.play('laser'); // 2 voices on sfx
        tick();
        let ev = paramEvents(duckParam('music'), 'target');
        assert.equal(ev.length, 1, 'engaged on the edge');
        assert.equal(ev[0][1], 0.3);
        assert.equal(ev[0][3], 0.02, 'attack TC');

        tick(); tick();                           // held down: no restack
        assert.equal(paramEvents(duckParam('music'), 'target').length, 1,
            'steady state writes nothing - edge-only');

        audio.stopAll();                          // voices -> 0
        tick();
        ev = paramEvents(duckParam('music'), 'target');
        assert.equal(ev.length, 2, 'released on the falling edge');
        assert.equal(ev[1][1], 1, 'back to rest');
        assert.equal(ev[1][3], 0.5, 'release TC');
    });

    it('an explicit duck() always wins over the follower', async () => {
        const { audio, duckParam, tick } = await boot();
        audio.duckOn('sfx', 'music', { threshold: 1, level: 0.3 });

        audio.duck('music', 0.05, { attack: 0.04 });      // manual latch
        const afterManual = paramEvents(duckParam('music'), 'target').length;

        audio.play('laser');                              // would engage the follower
        tick(); tick();
        assert.equal(paramEvents(duckParam('music'), 'target').length, afterManual,
            'follower left the manually-ducked bus alone');

        audio.stopDuck('music');                          // release + clear the latch
        audio.play('laser');
        tick();
        assert.ok(paramEvents(duckParam('music'), 'target').length > afterManual + 1,
            'follower drives the bus again once the latch is cleared');
    });
});

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

describe('mix snapshots', () => {
    it('round-trips every captured bus volume and mute', async () => {
        const { audio } = await boot();
        audio.setBusVolume('music', 0.8);
        audio.setBusVolume('sfx', 1);
        audio.setBusMuted('voice', false);
        audio.captureSnapshot('game');

        audio.setBusVolume('music', 0.1);
        audio.setBusVolume('sfx', 0.4);
        audio.setBusMuted('voice', true);

        audio.applySnapshot('game');   // ms=0: snap via signals

        assert.equal(audio.busVolume('music').peek(), 0.8);
        assert.equal(audio.busVolume('sfx').peek(), 1);
        assert.equal(audio.busMuted('voice').peek(), false);
    });

    it('morphs over ms on the sidechain, continuous from the actual current product', async () => {
        const { audio, ctx, bus, duckParam } = await boot();
        audio.setBusVolume('music', 0.8);
        audio.captureSnapshot('loud');
        audio.setBusVolume('music', 0.2);      // bus gain value -> 0.2

        ctx._advance(1);
        const now = ctx.currentTime;
        audio.applySnapshot('loud', 500);

        // Signal is instantly truthful.
        assert.equal(audio.busVolume('music').peek(), 0.8);
        // Bus gain pinned to the target so the sidechain carries the whole move.
        assert.equal(bus('music').gain.gain.value, 0.8);
        // Sidechain: start at product/target = 0.2/0.8 = 0.25, linear ramp to 1 over 0.5s.
        const sets = paramEvents(duckParam('music'), 'set');
        assert.equal(sets[sets.length - 1][1], 0.25, 'continuous from current product');
        const ramp = paramEvents(duckParam('music'), 'linearRamp');
        assert.equal(ramp.length, 1);
        assert.equal(ramp[0][1], 1, 'morphs to rest');
        assert.equal(ramp[0][2], now + 0.5, 'over the requested ms');
    });

    it('a target of silence is left to the signals, never stranding the sidechain at zero', async () => {
        const { audio, duckParam } = await boot();
        audio.setBusMuted('music', true);
        audio.captureSnapshot('muted');
        audio.setBusMuted('music', false);

        audio.applySnapshot('muted', 500);
        assert.equal(audio.busMuted('music').peek(), true, 'mute restored via the signal');
        // Sidechain rested at 1, not ramped to 0.
        const ev = paramEvents(duckParam('music'));
        const last = ev[ev.length - 1];
        assert.equal(last[1], 1, 'duckGain rested, not stranded silent');
    });

    it('applying a snapshot clears a manual duck latch on the buses it touches', async () => {
        const { audio, bus } = await boot();
        audio.captureSnapshot('base');
        audio.duck('music', 0.1);
        assert.equal(bus('music').duckManual, true);
        audio.applySnapshot('base', 200);
        assert.equal(bus('music').duckManual, false, 'snapshot restates the mix');
    });

    it('is inert for an unknown snapshot name', async () => {
        const { audio } = await boot();
        assert.doesNotThrow(() => audio.applySnapshot('ghost', 100));
    });
});

// ---------------------------------------------------------------------------
// Meters
// ---------------------------------------------------------------------------

describe('per-bus meters', () => {
    it('level() reports the RMS of the analyser signal, updated on the monitor tick', async () => {
        const { audio, bus, tick } = await boot();
        audio.createBus('meterbus', { meter: true });
        assert.equal(audio.level('meterbus').peek(), 0, 'starts silent');

        bus('meterbus').analyser._fill = 0.5;   // constant 0.5 -> RMS 0.5
        tick();
        assert.equal(audio.level('meterbus').peek(), 0.5);
    });

    it('reads into ONE pre-allocated buffer, never reallocating per read', async () => {
        const { audio, bus, tick } = await boot();
        audio.createBus('meterbus', { meter: true });
        const buf = bus('meterbus').meterBuffer;
        assert.ok(buf instanceof Float32Array);
        tick(); tick(); tick();
        assert.equal(bus('meterbus').meterBuffer, buf, 'same buffer reference across reads');
    });

    it('an unmetered bus allocates no analyser and level() is null', async () => {
        const { audio, bus } = await boot();
        audio.createBus('plain');
        assert.equal(bus('plain').analyser, null);
        assert.equal(audio.level('plain'), null);
        assert.equal(audio.level('nope'), null, 'unknown bus');
    });
});

// ---------------------------------------------------------------------------
// Dynamic buses
// ---------------------------------------------------------------------------

describe('createBus', () => {
    it('adds a routable bus with the next index, and stop() decodes back to it', async () => {
        const { audio } = await boot();
        const nextIndex = audio._busList.length;
        audio.createBus('extra');
        assert.equal(audio._buses.get('extra').index, nextIndex);

        await audio.defineSounds({ boom: { src: ['/boom.wav'], bus: 'extra' } });
        const h = audio.play('boom');
        assert.ok(h >= 0, 'played on the dynamic bus');
        assert.equal(audio.busOf(h), 'extra', 'handle decodes to the new bus');
    });

    it('is idempotent and rejects the reserved name', async () => {
        const { audio } = await boot();
        const rec = audio.createBus('extra');
        assert.equal(audio.createBus('extra'), rec, 'same record on re-create');
        assert.throws(() => audio.createBus('master'), /reserved/);
    });

    it('fails closed at the 2^21 handle ceiling at runtime, not just at init', async () => {
        const { audio } = await boot();
        // Sparse-length the bus list to the ceiling (cheap: no elements allocated).
        audio._busList.length = 2097152;
        assert.throws(() => audio.createBus('one-too-many'), /ceiling/);
    });
});

// ---------------------------------------------------------------------------
// Auto-suspend
// ---------------------------------------------------------------------------

describe('auto-suspend', () => {
    it('suspends after N silent seconds and a play() wakes it', async () => {
        const { audio, ctx, tick } = await boot();
        assert.equal(audio.enableAutoSuspend({ after: 2 }), true);

        tick();                          // silence begins (marks _silentSince)
        assert.equal(ctx.state, 'running', 'not yet - under the threshold');

        ctx._advance(2.5);
        tick();                          // silent long enough -> suspend
        assert.equal(ctx.state, 'suspended');
        assert.equal(audio.isAutoSuspended(), true);
        assert.equal(audio.unlocked().peek(), true, 'unlock survives the suspend');

        const h = audio.play('laser');   // the wake path
        assert.equal(ctx.state, 'running', 'play() resumed the context');
        assert.equal(audio.isAutoSuspended(), false);
        assert.ok(h >= 0, 'and the triggering voice still played');
        assert.equal(audio.unlocked().peek(), true, 'unlock survives the resume');
    });

    it('does not suspend while a voice is sounding', async () => {
        const { audio, ctx, tick } = await boot();
        audio.enableAutoSuspend({ after: 1 });
        audio.play('laser');             // an active voice
        ctx._advance(3);
        tick(); tick();
        assert.equal(ctx.state, 'running', 'busy engine stays awake');
    });

    it('refuses to arm on iOS (returns false, stays off)', async () => {
        const { audio } = await boot({ navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' } });
        assert.equal(audio.enableAutoSuspend({ after: 1 }), false);
        assert.equal(audio._autoSuspend, false);
    });

    it('treats iPadOS-reporting-as-Mac (touch points) as iOS', async () => {
        const { audio } = await boot({ navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', maxTouchPoints: 5 } });
        assert.equal(audio.enableAutoSuspend(), false);
    });

    it('arms on a real desktop (Mac without touch)', async () => {
        const { audio } = await boot({ navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', maxTouchPoints: 0 } });
        assert.equal(audio.enableAutoSuspend(), true);
    });
});
