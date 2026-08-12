/**
 * @zakkster/lite-audio - S5 stereo-width contract tests (node:test).
 *
 * The torture gate (test/torture.mjs, T-SP6) proves the ALLOCATION and
 * NATIVE-EVENT-RATE budgets: setWidth() stamps two fields with zero bytes/op, and
 * the throttled flush holds the SP-03 native-event bound on the wet/makeup params.
 * Neither is heap-visible, and neither is what THIS file is for.
 *
 * This file pins the FAIL-CLOSED CONTRACT and the audio math a budget gate cannot
 * see: does createBus arm the widener only when asked, does it refuse a nonsensical
 * or stereo-incompatible width at construction, does the graph conserve power, and
 * does setWidth fail closed on an unarmed / disarmed / bogus request.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LiteAudio } from '../Audio.js';
import { createMockContext, mockFetch, mockDocument, mockAudioBuffer, flushMicrotasks } from './mock-ctx.js';

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

/**
 * Build an engine with a single 'wide' bus, a mono sound loaded and unlocked. Pass
 * `arm: false` to leave the bus unarmed (no width option at all); otherwise the bus
 * arms with `widthOpt` (default 0). `channels` controls the decoded buffer channel
 * count (>1 exercises the disarm).
 */
async function buildEngine({ arm = true, widthOpt = 0, channels = 1, spatial } = {}) {
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
    if (channels !== 1) {
        // The default mock decodes mono; override so the loaded buffer is non-mono,
        // which the widener must refuse (a Haas widener is a mono-source effect).
        ctx.decodeAudioData = async () => mockAudioBuffer(channels, 22050, 44100);
    }
    const opts = {};
    if (arm) opts.width = widthOpt;
    if (spatial !== undefined) opts.spatial = spatial;
    audio.createBus('wide', opts);
    await audio.defineSounds({ ping: { src: ['/s.wav'], bus: 'wide' } });
    win._fire('touchstart');
    await flushMicrotasks(8);
    return { audio, ctx, win, bus: audio._buses.get('wide') };
}

function targetCount(param) {
    let n = 0;
    for (const e of param.events) if (e[0] === 'target') n++;
    return n;
}

// ---------- 1. arming only when asked ---------------------------------------

describe('createBus width arming', () => {
    it('an unarmed bus builds no widener and routes the pool to gain', async () => {
        const { audio, bus } = await buildEngine({ arm: false });
        assert.equal(bus.wideIn, null, 'wideIn must be null on an unarmed bus');
        assert.equal(bus.wideMakeup, null);
        assert.equal(bus.wideWet, null);
        assert.equal(bus.delayL, null);
        assert.equal(bus.delayR, null);
        assert.equal(bus.panL, null);
        assert.equal(bus.panR, null);
        assert.equal(bus.poolOut, bus.gain, 'an unarmed pool must target the bus gain');
        assert.equal(audio.widthOf('wide'), null, 'widthOf is null on an unarmed bus');
    });

    it('an armed bus builds all 7 widener nodes and routes the pool through wideIn', async () => {
        const { bus } = await buildEngine({ widthOpt: 0 });
        for (const slot of ['wideIn', 'wideMakeup', 'wideWet', 'delayL', 'delayR', 'panL', 'panR']) {
            assert.ok(bus[slot], slot + ' must exist on an armed bus');
        }
        assert.equal(bus.poolOut, bus.wideIn, 'an armed pool must target wideIn');
    });
});

// ---------- 2. exact bypass snap --------------------------------------------

describe('setWidth 1 -> 0 settles to a bit-exact bypass', () => {
    it('after WIDTH_SETTLE_TICKS ticks at width 0, wet===0 and makeup===1 exactly', async () => {
        const { audio, bus } = await buildEngine({ widthOpt: 0 });
        audio.setWidth('wide', 1);
        audio.setWidth('wide', 0);
        for (let i = 0; i < 4; i++) audio._flushWidth();
        assert.equal(bus.wideWet.gain.value, 0, 'wet gain must snap to EXACTLY 0');
        assert.equal(bus.wideMakeup.gain.value, 1, 'makeup gain must snap to EXACTLY 1');
        assert.equal(audio.widthOf('wide'), 0);
    });
});

// ---------- 3. power conservation + Haas delays -----------------------------

describe('widener graph at full width', () => {
    it('conserves total power at width 1 (~0 dB, +/-0.5 dB)', async () => {
        const { audio, bus } = await buildEngine({ widthOpt: 0 });
        audio.setWidth('wide', 1);
        audio._flushWidth();
        const wet = bus.wideWet.gain.value;
        const M = bus.wideMakeup.gain.value;
        assert.ok(Math.abs(wet - 0.5) < 1e-9, 'wet at width 1 is WIDTH_WET_MAX (0.5), got ' + wet);
        // dry power = M^2; wet power = two hard-panned copies = 2 * (wet*M)^2 * ... the
        // planner's closed form: 2*M*M*(1+4*wet*wet)/2 must equal 1.
        const power = 2 * M * M * (1 + 4 * wet * wet) / 2;
        const dB = 10 * Math.log10(power);
        assert.ok(Math.abs(dB) <= 0.5, 'width-1 power walk is ' + dB.toFixed(4) + ' dB, expected within 0.5 dB');
    });

    it('uses two distinct Haas delays, both under the fusion threshold', async () => {
        const { bus } = await buildEngine({ widthOpt: 0 });
        const dL = bus.delayL.delayTime.value;
        const dR = bus.delayR.delayTime.value;
        assert.ok(dL >= 0.005 && dL <= 0.030, 'delayL ' + dL + ' out of [0.005, 0.030]');
        assert.ok(dR >= 0.005 && dR <= 0.030, 'delayR ' + dR + ' out of [0.005, 0.030]');
        assert.notEqual(dL, dR, 'the two Haas delays must be distinct');
        assert.equal(bus.panL.pan.value, -1, 'left wet copy panned hard left');
        assert.equal(bus.panR.pan.value, 1, 'right wet copy panned hard right');
    });
});

// ---------- 4. fail-closed construction -------------------------------------

describe('createBus width fails closed', () => {
    async function freshEngine() {
        const ctx = createMockContext({ state: 'suspended' });
        const audio = new LiteAudio({
            buses: [], window: fakeWindow(), document: mockDocument(),
            fetch: mockFetch({ '/s.wav': 500 }), setTimeout: () => 0, clearTimeout: () => {},
        });
        await audio.init(ctx);
        return audio;
    }

    it('rejects width: true (a boolean is not a number)', async () => {
        const audio = await freshEngine();
        assert.throws(() => audio.createBus('x', { width: true }), RangeError);
    });

    it('rejects a non-finite or out-of-range width', async () => {
        const audio = await freshEngine();
        assert.throws(() => audio.createBus('a', { width: NaN }), RangeError);
        assert.throws(() => audio.createBus('b', { width: Infinity }), RangeError);
        assert.throws(() => audio.createBus('c', { width: -0.1 }), RangeError);
        assert.throws(() => audio.createBus('d', { width: 1.5 }), RangeError);
        assert.throws(() => audio.createBus('e', { width: '1' }), RangeError);
    });

    it('accepts an in-range width (0 and 1 both arm)', async () => {
        const audio = await freshEngine();
        assert.doesNotThrow(() => audio.createBus('lo', { width: 0 }));
        assert.doesNotThrow(() => audio.createBus('hi', { width: 1 }));
        assert.ok(audio._buses.get('lo').wideIn);
        assert.ok(audio._buses.get('hi').wideIn);
    });

    it('refuses width > 0 on a positional/hrtf bus (stereo-only)', async () => {
        const audio = await freshEngine();
        assert.throws(() => audio.createBus('p', { spatial: 'positional', width: 0.5 }), RangeError);
        assert.throws(() => audio.createBus('h', { spatial: 'hrtf', width: 1 }), RangeError);
        // width 0 on a positional bus does not compose a widener but is not itself a
        // wiring error (nothing wide is requested), so it must not throw -- AND it must
        // build NO widener (wideIn stays null), so a stereo widener can never be
        // inserted onto a per-voice-panned positional image (SP-06 / Law-1.4).
        assert.doesNotThrow(() => audio.createBus('p0', { spatial: 'positional', width: 0 }));
        assert.equal(audio._buses.get('p0').wideIn, null,
            'width:0 on a positional bus must build no widener');
    });

    it('exposes no enableWidth/widen escape hatch on the prototype', () => {
        assert.equal(typeof LiteAudio.prototype.enableWidth, 'undefined');
        assert.equal(typeof LiteAudio.prototype.widen, 'undefined');
        assert.equal(typeof LiteAudio.prototype.setWidth, 'function');
        assert.equal(typeof LiteAudio.prototype.widthOf, 'function');
    });
});

// ---------- 5. setWidth fail-closed + clamp ---------------------------------

describe('setWidth fail-closed and clamp', () => {
    it('clamps to [0, 1]', async () => {
        const { audio } = await buildEngine({ widthOpt: 0 });
        audio.setWidth('wide', 2);
        assert.equal(audio.widthOf('wide'), 1);
        audio.setWidth('wide', -3);
        assert.equal(audio.widthOf('wide'), 0);
    });

    it('is a no-op for a non-number / NaN width (value unchanged)', async () => {
        const { audio } = await buildEngine({ widthOpt: 0 });
        audio.setWidth('wide', 0.5);
        assert.equal(audio.widthOf('wide'), 0.5);
        audio.setWidth('wide', true);
        assert.equal(audio.widthOf('wide'), 0.5, 'a boolean must not move the width');
        audio.setWidth('wide', NaN);
        assert.equal(audio.widthOf('wide'), 0.5, 'NaN must not move the width');
        audio.setWidth('wide', 'x');
        assert.equal(audio.widthOf('wide'), 0.5, 'a string must not move the width');
    });

    it('is a no-op on an unarmed / unknown bus', async () => {
        const { audio } = await buildEngine({ arm: false });
        assert.doesNotThrow(() => audio.setWidth('wide', 1));   // unarmed -> no-op
        assert.equal(audio.widthOf('wide'), null);
        assert.doesNotThrow(() => audio.setWidth('nope', 1));   // unknown -> no-op
        assert.equal(audio.widthOf('nope'), null);
    });
});

// ---------- 6. non-mono source disarms --------------------------------------

describe('a non-mono source disarms the widener', () => {
    it('disarms, records widthRefused, and routes the pool to gain', async () => {
        const { audio, bus } = await buildEngine({ widthOpt: 1, channels: 2 });
        assert.equal(bus.wideIn, null, 'a stereo source must disarm the widener');
        assert.equal(bus.widthRefused, 'stereo-source');
        assert.equal(bus.poolOut, bus.gain, 'a disarmed pool must target the bus gain');
        assert.equal(audio.widthOf('wide'), null, 'widthOf is null on a disarmed bus');
        // setWidth stays a no-op after the disarm.
        assert.doesNotThrow(() => audio.setWidth('wide', 1));
        assert.equal(audio.widthOf('wide'), null);
    });
});

// ---------- 7. throttled event rate -----------------------------------------

describe('setWidth writes ride the ~10 Hz flush', () => {
    it('collapses many same-value setWidth into a single param write per param', async () => {
        const { audio, bus } = await buildEngine({ widthOpt: 0 });
        for (let t = 0; t < 8; t++) {
            for (let f = 0; f < 6; f++) audio.setWidth('wide', 0.6);
            audio._flushWidth();
        }
        assert.equal(targetCount(bus.wideWet.gain), 1, 'identical value -> exactly one wet write');
        assert.equal(targetCount(bus.wideMakeup.gain), 1, 'identical value -> exactly one makeup write');
    });
});

// ---------- 8. destroy tears the widener down -------------------------------

describe('destroy releases the widener', () => {
    it('disconnects and nulls all 7 widener nodes', async () => {
        const { audio, bus } = await buildEngine({ widthOpt: 1 });
        const nodes = [bus.wideIn, bus.wideMakeup, bus.wideWet, bus.delayL, bus.delayR, bus.panL, bus.panR];
        audio.destroy();
        for (const n of nodes) assert.ok(n.disconnected >= 1, 'each widener node must be disconnected');
        assert.equal(bus.wideIn, null);
        assert.equal(bus.wideMakeup, null);
        assert.equal(bus.wideWet, null);
        assert.equal(bus.delayL, null);
        assert.equal(bus.delayR, null);
        assert.equal(bus.panL, null);
        assert.equal(bus.panR, null);
    });
});
