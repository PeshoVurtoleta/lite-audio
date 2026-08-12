/**
 * @zakkster/lite-audio - S5 stereo-width QA boundary matrix (node:test).
 *
 * test/Width.test.js pins the CONTRACT (arm/disarm, bit-exact bypass at
 * WIDTH_SETTLE_TICKS, power conservation, fail-closed construction/writes,
 * mono-safe disarm, throttled collapse, teardown). This file closes the
 * boundary-matrix gaps the QA pass identified around those same entry points:
 * the settle counter's N-1/N/N+1 edge, empty/null/undefined/-0 inputs,
 * duplicate dispose, dispose-during-iteration across multiple armed buses,
 * a genuine re-entrant/racing write (two different values before one flush),
 * and one adversarial case (a boxed Number trying to slip past the
 * typeof-number guard).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LiteAudio } from '../Audio.js';
import { createMockContext, mockFetch, mockDocument, flushMicrotasks } from './mock-ctx.js';

function fakeWindow() {
    const listeners = new Map();
    return {
        navigator: { userAgent: 'node-test', maxTouchPoints: 0 },
        addEventListener(evt, cb) {
            if (!listeners.has(evt)) listeners.set(evt, new Set());
            listeners.get(evt).add(cb);
        },
        removeEventListener(evt, cb) { listeners.get(evt)?.delete(cb); },
        _fire(evt, data = {}) { for (const cb of [...(listeners.get(evt) || [])]) cb(data); },
    };
}

async function buildEngine({ arm = true, widthOpt = 0 } = {}) {
    const ctx = createMockContext({ state: 'suspended' });
    const win = fakeWindow();
    const audio = new LiteAudio({
        buses: [],
        poolCapacity: 8,
        window: win,
        document: mockDocument(),
        fetch: mockFetch({ '/s.wav': 500 }),
        setTimeout: () => 0,
        clearTimeout: () => {},
    });
    await audio.init(ctx);
    const opts = {};
    if (arm) opts.width = widthOpt;
    audio.createBus('wide', opts);
    await audio.defineSounds({ ping: { src: ['/s.wav'], bus: 'wide' } });
    win._fire('touchstart');
    await flushMicrotasks(8);
    return { audio, ctx, win, bus: audio._buses.get('wide') };
}

function lastEvent(param) {
    const ev = param.events;
    return ev.length ? ev[ev.length - 1] : null;
}

function targetCount(param) {
    let n = 0;
    for (const e of param.events) if (e[0] === 'target') n++;
    return n;
}

// ---------- N-1 / N / N+1 around WIDTH_SETTLE_TICKS --------------------------

describe('settle-counter boundary (WIDTH_SETTLE_TICKS = N)', () => {
    it('N-1 ticks: the bypass snap has NOT fired yet (still dirty, last event is a target ramp)', async () => {
        const { audio, bus } = await buildEngine({ widthOpt: 0 });
        audio.setWidth('wide', 1);
        audio.setWidth('wide', 0);
        for (let i = 0; i < 3; i++) audio._flushWidth();   // N-1
        assert.equal(bus.widthDirty, 1, 'the settle counter must still be counting down at N-1');
        const wetEv = lastEvent(bus.wideWet.gain);
        assert.ok(wetEv && wetEv[0] === 'target', 'at N-1 the wet gain must not yet have snapped via setValueAtTime');
    });

    it('N ticks: the bypass snap fires exactly once (a "set" event lands, dirty clears)', async () => {
        const { audio, bus } = await buildEngine({ widthOpt: 0 });
        audio.setWidth('wide', 1);
        audio.setWidth('wide', 0);
        for (let i = 0; i < 4; i++) audio._flushWidth();   // N
        assert.equal(bus.widthDirty, 0, 'the settle counter must clear dirty exactly at N');
        const wetEv = lastEvent(bus.wideWet.gain);
        const makeupEv = lastEvent(bus.wideMakeup.gain);
        assert.ok(wetEv && wetEv[0] === 'set' && wetEv[1] === 0, 'at N the wet gain must snap via setValueAtTime(0, ...)');
        assert.ok(makeupEv && makeupEv[0] === 'set' && makeupEv[1] === 1, 'at N the makeup gain must snap via setValueAtTime(1, ...)');
    });

    it('N+1 ticks: the snap is idempotent -- no further param events are appended', async () => {
        const { audio, bus } = await buildEngine({ widthOpt: 0 });
        audio.setWidth('wide', 1);
        audio.setWidth('wide', 0);
        for (let i = 0; i < 4; i++) audio._flushWidth();   // settle at N
        const wetCountAtN = bus.wideWet.gain.events.length;
        const makeupCountAtN = bus.wideMakeup.gain.events.length;
        audio._flushWidth();                                // N+1: must be a pure no-op
        assert.equal(bus.wideWet.gain.events.length, wetCountAtN,
            'a flush after the snap must not append another wet event');
        assert.equal(bus.wideMakeup.gain.events.length, makeupCountAtN,
            'a flush after the snap must not append another makeup event');
        assert.equal(bus.widthDirty, 0);
    });
});

// ---------- empty / null / undefined / NaN / -0 on setWidth ------------------

describe('setWidth input-boundary matrix', () => {
    it('empty-string bus name is inert (unknown bus)', async () => {
        const { audio } = await buildEngine({ widthOpt: 0 });
        assert.doesNotThrow(() => audio.setWidth('', 1));
        assert.equal(audio.widthOf(''), null);
    });

    it('null width is inert (value unchanged)', async () => {
        const { audio } = await buildEngine({ widthOpt: 0 });
        audio.setWidth('wide', 0.4);
        assert.equal(audio.widthOf('wide'), 0.4);
        assert.doesNotThrow(() => audio.setWidth('wide', null));
        assert.equal(audio.widthOf('wide'), 0.4, 'null must not move the width');
    });

    it('undefined width is inert (value unchanged)', async () => {
        const { audio } = await buildEngine({ widthOpt: 0 });
        audio.setWidth('wide', 0.4);
        assert.doesNotThrow(() => audio.setWidth('wide', undefined));
        assert.equal(audio.widthOf('wide'), 0.4, 'undefined must not move the width');
    });

    it('-0 is accepted and behaves exactly like 0 (bypass, no NaN/Infinity downstream)', async () => {
        const { audio, bus } = await buildEngine({ widthOpt: 0.5 });
        audio._flushWidth();
        assert.doesNotThrow(() => audio.setWidth('wide', -0));
        // -0 and 0 are the SAME value under === (only Object.is/SameValue tells them
        // apart), and setWidth stores whatever numeric value it was handed -- so the
        // width-boundary claim under test is arithmetic behavior, not bit identity.
        assert.ok(audio.widthOf('wide') === 0, 'widthOf(-0) must read as 0 under ===');
        for (let i = 0; i < 4; i++) audio._flushWidth();
        assert.ok(bus.wideWet.gain.value === 0);
        assert.ok(bus.wideMakeup.gain.value === 1);
        assert.ok(Number.isFinite(bus.wideWet.gain.value) && Number.isFinite(bus.wideMakeup.gain.value));
    });

    it('createBus width: -0 arms cleanly (treated as 0, not rejected, not NaN)', async () => {
        const ctx = createMockContext({ state: 'suspended' });
        const audio = new LiteAudio({
            buses: [], window: fakeWindow(), document: mockDocument(),
            fetch: mockFetch({ '/s.wav': 500 }), setTimeout: () => 0, clearTimeout: () => {},
        });
        await audio.init(ctx);
        assert.doesNotThrow(() => audio.createBus('nz', { width: -0 }));
        const busRec = audio._buses.get('nz');
        assert.ok(busRec.wideIn, 'width: -0 must arm the widener (it is a valid in-range number)');
        assert.ok(busRec.wideWet.gain.value === 0);
        assert.ok(audio.widthOf('nz') === 0);
    });

    it('createBus width: undefined leaves the bus unarmed, identically to omitting width', async () => {
        const ctx = createMockContext({ state: 'suspended' });
        const audio = new LiteAudio({
            buses: [], window: fakeWindow(), document: mockDocument(),
            fetch: mockFetch({ '/s.wav': 500 }), setTimeout: () => 0, clearTimeout: () => {},
        });
        await audio.init(ctx);
        assert.doesNotThrow(() => audio.createBus('u', { width: undefined }));
        assert.equal(audio._buses.get('u').wideIn, null);
        assert.equal(audio.widthOf('u'), null);
    });
});

// ---------- duplicate dispose / dispose-during-iteration ---------------------

describe('duplicate dispose and multi-bus teardown', () => {
    it('a second destroy() on an armed-widener engine is a safe no-op', async () => {
        const { audio, bus } = await buildEngine({ widthOpt: 1 });
        const nodes = [bus.wideIn, bus.wideMakeup, bus.wideWet, bus.delayL, bus.delayR, bus.panL, bus.panR];
        audio.destroy();
        const disconnectCounts = nodes.map((n) => n.disconnected);
        assert.doesNotThrow(() => audio.destroy(), 'a duplicate destroy() must not throw');
        // Every widener slot is already null after the first destroy(), so the
        // second call's per-bus loop must not touch the (now-detached) nodes again.
        for (let i = 0; i < nodes.length; i++) {
            assert.equal(nodes[i].disconnected, disconnectCounts[i],
                'a duplicate destroy() must not re-disconnect an already-torn-down widener node');
        }
        assert.equal(bus.wideIn, null);
        assert.equal(audio.widthOf('wide'), null);
    });

    it('destroy() tears down EVERY armed bus, not just the first (dispose-during-iteration)', async () => {
        const ctx = createMockContext({ state: 'suspended' });
        const win = fakeWindow();
        const audio = new LiteAudio({
            buses: [], poolCapacity: 8, window: win, document: mockDocument(),
            fetch: mockFetch({ '/s.wav': 500 }), setTimeout: () => 0, clearTimeout: () => {},
        });
        await audio.init(ctx);
        audio.createBus('a', { width: 0.5 });
        audio.createBus('b', { width: 1 });
        audio.createBus('c', { width: 0 });
        await audio.defineSounds({
            pa: { src: ['/s.wav'], bus: 'a' },
            pb: { src: ['/s.wav'], bus: 'b' },
            pc: { src: ['/s.wav'], bus: 'c' },
        });
        win._fire('touchstart');
        await flushMicrotasks(8);

        // Capture the bus records (and their widthOf) BEFORE destroy(): destroy()
        // clears the engine's _buses Map/_busList entirely, so a post-destroy
        // audio._buses.get(name) would return undefined for every bus, not proof
        // of a per-bus release. The records themselves are what destroy() mutates.
        const names = ['a', 'b', 'c'];
        const recs = names.map((n) => audio._buses.get(n));
        for (let i = 0; i < recs.length; i++) assert.ok(recs[i].wideIn, names[i] + ' must be armed before destroy');
        const widthsBefore = names.map((n) => audio.widthOf(n));
        assert.deepEqual(widthsBefore, [0.5, 1, 0], 'sanity: each bus armed with its requested width');

        audio.destroy();

        for (let i = 0; i < recs.length; i++) {
            const r = recs[i];
            const name = names[i];
            assert.equal(r.wideIn, null, name + ': wideIn must be nulled by destroy()');
            assert.equal(r.wideMakeup, null, name + ': wideMakeup must be nulled by destroy()');
            assert.equal(r.wideWet, null, name + ': wideWet must be nulled by destroy()');
            assert.equal(r.delayL, null, name + ': delayL must be nulled by destroy()');
            assert.equal(r.delayR, null, name + ': delayR must be nulled by destroy()');
            assert.equal(r.panL, null, name + ': panL must be nulled by destroy()');
            assert.equal(r.panR, null, name + ': panR must be nulled by destroy()');
        }
        // The Map itself was cleared too: every bus, not just the widener slots, is gone.
        assert.equal(audio._buses.size, 0, 'destroy() must clear every bus record, not just the first');
    });
});

// ---------- re-entrant / racing writes ---------------------------------------

describe('a racing write before a single flush resolves to the LAST value, not the first', () => {
    it('setWidth(0.2) then setWidth(0.9) before one flush collapses to 0.9 with exactly one write', async () => {
        const { audio, bus } = await buildEngine({ widthOpt: 0 });
        audio._flushWidth();                 // settle any initial state first
        audio.setWidth('wide', 0.2);
        audio.setWidth('wide', 0.9);         // a second write races the first, pre-flush
        audio._flushWidth();
        assert.equal(audio.widthOf('wide'), 0.9, 'the later write must win');
        assert.equal(targetCount(bus.wideWet.gain), 1, 'the race must collapse to exactly one param write');
        const wet = bus.wideWet.gain.value;
        assert.ok(Math.abs(wet - 0.5 * 0.9) < 1e-9, 'the single write must reflect the LAST value (0.9), not the first (0.2)');
    });
});

// ---------- adversarial: a boxed Number trying to slip past the guard --------

describe('adversarial: a boxed Number object must not slip past the number guard', () => {
    it('createBus rejects width: new Number(0.5) (typeof is "object", not "number")', async () => {
        const ctx = createMockContext({ state: 'suspended' });
        const audio = new LiteAudio({
            buses: [], window: fakeWindow(), document: mockDocument(),
            fetch: mockFetch({ '/s.wav': 500 }), setTimeout: () => 0, clearTimeout: () => {},
        });
        await audio.init(ctx);
        // eslint-disable-next-line no-new-wrappers
        assert.throws(() => audio.createBus('boxed', { width: new Number(0.5) }), RangeError);
    });

    it('setWidth ignores a boxed Number the same way it ignores a primitive boolean/string', async () => {
        const { audio } = await buildEngine({ widthOpt: 0 });
        audio.setWidth('wide', 0.3);
        // eslint-disable-next-line no-new-wrappers
        assert.doesNotThrow(() => audio.setWidth('wide', new Number(0.7)));
        assert.equal(audio.widthOf('wide'), 0.3, 'a boxed Number must not move the width (typeof guard, not valueOf coercion)');
    });
});
