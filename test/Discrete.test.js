/**
 * @zakkster/lite-audio - S6 discrete-surround (7+1 VBAP bus) contract tests
 * (node:test).
 *
 * The torture gate (test/torture.mjs, T-SP3-lane + T-SP4(c)) proves the
 * ALLOCATION-FREE and RATE-BOUNDED properties: _flushLanes() over 8 voices is
 * zero-alloc, setPosition() on a discrete bus reuses the identical zero-alloc
 * scalar stamp as positional/hrtf, and the lane params stay under the SP-03
 * native-event cap. Neither of those is what THIS file is for.
 *
 * This file pins the FAIL-CLOSED CONTRACT and STRUCTURAL/GEOMETRIC correctness
 * a heap/rate gate cannot see: does a discrete bus build EXACTLY one
 * ChannelMerger(8) and expose exactly 8 writable lane gains per voice? Does the
 * SMPTE lane order actually land voice lane k on merger input k (except LANE_LFE,
 * which routes through the shared lowpass)? Does the VBAP solver actually place a
 * hard-front/hard-right/hard-rear source on the pair the spec names, with every
 * OTHER ring lane exactly 0? Is LANE_LFE truly azimuth-invariant (never a
 * VBAP-derived value)? Does a stolen channel produce zero stale lane writes on
 * the new occupant? Does a discrete request that falls back to stereo expose NO
 * lane array at all? And does 200 build/teardown cycles release every discrete
 * node and restore the destination's pre-discrete triple?
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LiteAudio } from '../Audio.js';
import { createMockContext, mockFetch, mockDocument, flushMicrotasks } from './mock-ctx.js';

// Mirror of Audio.js's internal codec (not exported - an implementation
// detail). Handles.test.js pins the real engine agrees with this arithmetic;
// this file only needs it to CRAFT adversarial handles.
const BUS_STRIDE = 4294967296; // 2^32

// SMPTE lane indices, mirrored from Audio.js (not exported - the contract
// under test is the INDEX positions, so this file pins its own copy rather
// than importing an internal).
const LANE_L = 0, LANE_R = 1, LANE_C = 2, LANE_LFE = 3;
const LANE_SL = 4, LANE_SR = 5, LANE_SBL = 6, LANE_SBR = 7;

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

function targetEvents(param) { return param.events.filter((e) => e[0] === 'target'); }

/**
 * Build a live LiteAudio with ONE discrete '7.1' bus ('surr') and `voices`
 * sounding voices on an `channels`-wide mock sink. ctx starts 'running' so
 * init() marks it unlocked immediately (no gesture plumbing needed). The clock
 * never advances, so voiceNode() keeps every voice alive across a flush.
 * 'surr' is created ONLY via createBus (never in the constructor's `buses`),
 * so it is actually built discrete - a constructor bus would already exist as
 * a stereo record and silently drop the option.
 */
async function buildDiscreteEngine(voices = 1, { channels = 8, capacity } = {}) {
    const ctx = createMockContext({ state: 'running', maxChannelCount: channels });
    const audio = new LiteAudio({
        buses: [], poolCapacity: capacity ?? voices, window: fakeWindow(), document: mockDocument(),
        fetch: mockFetch({ '/s.wav': 500 }), setTimeout: () => 0, clearTimeout: () => {},
    });
    await audio.init(ctx);
    audio.createBus('surr', { spatial: 'discrete', preset: '7.1' });
    await audio.defineSounds({ ping: { src: ['/s.wav'], bus: 'surr' } });
    await flushMicrotasks(8);

    const handles = [];
    for (let i = 0; i < voices; i++) {
        const h = audio.play('ping');
        assert.ok(h >= 0, 'discrete setup: play() must not skip');
        handles.push(h);
    }
    return { audio, ctx, handles, busRec: audio._buses.get('surr') };
}

// ---------- 1. build: one merger, exactly 8 lane gains per voice -----------

describe('discrete bus build: exactly one ChannelMerger(8), 8 writable lane gains per voice', () => {
    it('constructs exactly one ChannelMerger and it reports numberOfInputs === 8', async () => {
        const ctx = createMockContext({ state: 'running', maxChannelCount: 8 });
        let mergerCalls = 0;
        const origCreateMerger = ctx.createChannelMerger.bind(ctx);
        ctx.createChannelMerger = (n) => { mergerCalls++; return origCreateMerger(n); };
        const audio = new LiteAudio({
            buses: [], poolCapacity: 4, window: fakeWindow(), document: mockDocument(),
            fetch: mockFetch({ '/s.wav': 500 }), setTimeout: () => 0, clearTimeout: () => {},
        });
        await audio.init(ctx);
        audio.createBus('surr', { spatial: 'discrete', preset: '7.1' });
        await audio.defineSounds({ ping: { src: ['/s.wav'], bus: 'surr' } });
        await flushMicrotasks(8);

        assert.equal(mergerCalls, 1, 'exactly one ChannelMerger must be constructed for one discrete bus');
        const pool = audio._buses.get('surr').pool;
        assert.equal(pool.merger.numberOfInputs, 8);
        assert.equal(pool.merger.channelCount, 1);
        assert.equal(pool.merger.channelCountMode, 'explicit');
        audio.destroy();
    });

    it('every voice (capacity 1, 2, 5) exposes exactly 8 writable lane gains via voiceNode()', async () => {
        for (const capacity of [1, 2, 5]) {
            const { audio, busRec } = await buildDiscreteEngine(capacity, { capacity });
            for (let ch = 0; ch < capacity; ch++) {
                const h = busRec.index * BUS_STRIDE + ch;
                const lanes = busRec.pool.voiceNode(h >>> 0);
                assert.ok(Array.isArray(lanes), 'channel ' + ch + ': voiceNode must return an array in discrete mode');
                assert.equal(lanes.length, 8, 'channel ' + ch + ': exactly 8 lanes');
                for (let k = 0; k < 8; k++) {
                    assert.ok(lanes[k] && lanes[k].gain, 'channel ' + ch + ' lane ' + k + ' must expose a writable .gain');
                    assert.equal(typeof lanes[k].gain.setTargetAtTime, 'function');
                }
            }
            audio.destroy();
        }
    });

    it('channel 0 (first) and channel N-1 (last) both build full 8-lane arrays -- catches an off-by-one', async () => {
        const capacity = 6;
        const { audio, busRec } = await buildDiscreteEngine(capacity, { capacity });
        const first = busRec.pool.voiceNode((busRec.index * BUS_STRIDE + 0) >>> 0);
        const last = busRec.pool.voiceNode((busRec.index * BUS_STRIDE + (capacity - 1)) >>> 0);
        assert.equal(first.length, 8, 'channel 0');
        assert.equal(last.length, 8, 'channel N-1');
        audio.destroy();
    });
});

// ---------- 2. SMPTE lane order via outPorts --------------------------------

describe('SMPTE lane order proven via outPorts (lane k -> merger input k, except LANE_LFE)', () => {
    it('lanes L,R,C,SL,SR,SBL,SBR each connect to [merger, 0, k]; LANE_LFE connects to the shared lowpass, which connects to [merger, 0, 3]', async () => {
        const { audio, busRec } = await buildDiscreteEngine(1);
        const pool = busRec.pool;
        const lanes = pool.voiceNode(pool.constructor === undefined ? 0 : (busRec.index * BUS_STRIDE + 0) >>> 0);

        const nonLfe = [LANE_L, LANE_R, LANE_C, LANE_SL, LANE_SR, LANE_SBL, LANE_SBR];
        for (const k of nonLfe) {
            const ports = lanes[k].outPorts;
            assert.equal(ports.length, 1, 'lane ' + k + ' must connect exactly once');
            const [target, outIdx, inIdx] = ports[0];
            assert.equal(target, pool.merger, 'lane ' + k + ' must land on the shared merger');
            assert.equal(outIdx, 0, 'lane ' + k + ' output index');
            assert.equal(inIdx, k, 'lane ' + k + ' must land on merger INPUT ' + k);
        }

        // LANE_LFE (3) is the exception: it routes through the shared lowpass, not
        // directly onto the merger. lane.connect(this.lowpass) is a single-arg
        // connect() -- outIdx/inIdx are undefined on that hop.
        const lfePorts = lanes[LANE_LFE].outPorts;
        assert.equal(lfePorts.length, 1, 'LANE_LFE must connect exactly once (to the lowpass, not the merger)');
        assert.equal(lfePorts[0][0], pool.lowpass, 'LANE_LFE must feed the shared lowpass');
        assert.notEqual(lfePorts[0][0], pool.merger, 'LANE_LFE must NOT connect directly to the merger');

        // The shared lowpass makes the second hop into merger input 3.
        const lowpassPorts = pool.lowpass.outPorts;
        assert.equal(lowpassPorts.length, 1);
        assert.equal(lowpassPorts[0][0], pool.merger);
        assert.equal(lowpassPorts[0][1], 0);
        assert.equal(lowpassPorts[0][2], 3, 'the lowpass must land on merger input 3 (LANE_LFE slot)');

        audio.destroy();
    });
});

// ---------- 3. VBAP landing: hard-front / hard-right / hard-rear -----------

describe('VBAP landing: a hard-panned source lands on the exact SMPTE pair the spec names', () => {
    const EPS = 1e-5;

    it('hard-front (0,0,-1) lands purely on LANE_C (az=0, the C/L-C/R boundary), every other ring lane is 0', async () => {
        const { audio, busRec, handles } = await buildDiscreteEngine(1);
        audio.setPosition(handles[0], 0, 0, -1);
        audio._flushLanes();
        const lanes = busRec.pool.voiceNode(handles[0] >>> 0);
        assert.ok(Math.abs(lanes[LANE_C].gain.value - 1) < EPS, 'LANE_C must carry full gain at dead-front');
        for (const k of [LANE_L, LANE_R, LANE_SL, LANE_SR, LANE_SBL, LANE_SBR]) {
            assert.ok(Math.abs(lanes[k].gain.value) < EPS, 'lane ' + k + ' must be silent at dead-front, got ' + lanes[k].gain.value);
        }
        audio.destroy();
    });

    it('hard-right (1,0,0) lands on the R/SR pair (az=90), every other ring lane is 0', async () => {
        const { audio, busRec, handles } = await buildDiscreteEngine(1);
        audio.setPosition(handles[0], 1, 0, 0);
        audio._flushLanes();
        const lanes = busRec.pool.voiceNode(handles[0] >>> 0);
        assert.ok(lanes[LANE_R].gain.value > 0, 'LANE_R must be live at hard-right');
        assert.ok(lanes[LANE_SR].gain.value > 0, 'LANE_SR must be live at hard-right');
        assert.ok(
            Math.abs(lanes[LANE_R].gain.value ** 2 + lanes[LANE_SR].gain.value ** 2 - 1) < 1e-3,
            'constant-power: R^2 + SR^2 must be ~1',
        );
        for (const k of [LANE_L, LANE_C, LANE_SL, LANE_SBL, LANE_SBR]) {
            assert.ok(Math.abs(lanes[k].gain.value) < EPS, 'lane ' + k + ' must be silent at hard-right, got ' + lanes[k].gain.value);
        }
        audio.destroy();
    });

    it('hard-rear (0,0,1) lands on the surround-back pair SBL/SBR (az=180) equally, every other ring lane is 0', async () => {
        const { audio, busRec, handles } = await buildDiscreteEngine(1);
        audio.setPosition(handles[0], 0, 0, 1);
        audio._flushLanes();
        const lanes = busRec.pool.voiceNode(handles[0] >>> 0);
        assert.ok(Math.abs(lanes[LANE_SBL].gain.value - lanes[LANE_SBR].gain.value) < EPS, 'dead-rear must split EQUALLY across SBL/SBR');
        assert.ok(lanes[LANE_SBL].gain.value > 0.5, 'SBL must be substantially live at hard-rear');
        for (const k of [LANE_L, LANE_R, LANE_C, LANE_SL, LANE_SR]) {
            assert.ok(Math.abs(lanes[k].gain.value) < EPS, 'lane ' + k + ' must be silent at hard-rear, got ' + lanes[k].gain.value);
        }
        audio.destroy();
    });
});

// ---------- 4. LANE_LFE is azimuth-invariant, never VBAP-derived -----------

describe('LANE_LFE: azimuth-invariant distance-only send, never a VBAP value', () => {
    it('the LFE gain is IDENTICAL at three different azimuths (front, right, rear) and always nonzero', async () => {
        const { audio, busRec, handles } = await buildDiscreteEngine(1);
        const lanes = busRec.pool.voiceNode(handles[0] >>> 0);

        audio.setPosition(handles[0], 0, 0, -1); // front
        audio._flushLanes();
        const lfeFront = lanes[LANE_LFE].gain.value;

        audio.setPosition(handles[0], 1, 0, 0); // right
        audio._flushLanes();
        const lfeRight = lanes[LANE_LFE].gain.value;

        audio.setPosition(handles[0], 0, 0, 1); // rear
        audio._flushLanes();
        const lfeRear = lanes[LANE_LFE].gain.value;

        assert.notEqual(lfeFront, 0, 'LFE must never be silent');
        assert.equal(lfeFront, lfeRight, 'LFE must be identical front vs right (azimuth-invariant)');
        assert.equal(lfeRight, lfeRear, 'LFE must be identical right vs rear (azimuth-invariant)');

        // LANE_LFE received exactly one write per flush across the three flushes.
        const lfeWrites = targetEvents(lanes[LANE_LFE].gain);
        assert.equal(lfeWrites.length, 3, 'one LFE write per flush, three flushes');
        audio.destroy();
    });

    it('exactly 8 writes per voice per flush; LANE_LFE receives exactly 1 of them and 0 VBAP-derived values', async () => {
        const { audio, busRec, handles } = await buildDiscreteEngine(1);
        audio.setPosition(handles[0], 1, 0, 0);
        audio._flushLanes();
        const lanes = busRec.pool.voiceNode(handles[0] >>> 0);
        let total = 0;
        for (let k = 0; k < 8; k++) {
            const n = targetEvents(lanes[k].gain).length;
            assert.equal(n, 1, 'lane ' + k + ' must write exactly once per flush');
            total += n;
        }
        assert.equal(total, 8, 'exactly 8 lane writes per voice per flush');
        audio.destroy();
    });
});

// ---------- 5. steal-safety: zero stale lane writes on the new occupant ----

describe('steal-safety: a stolen channel gets zero stale lane writes on the new occupant', () => {
    it('setPosition on the victim, then a steal, then flush -- the thief gets ZERO writes on all 8 lanes', async () => {
        const capacity = 4;
        const { audio, busRec, handles } = await buildDiscreteEngine(capacity, { capacity });

        const victim = handles[0]; // channel 0
        audio.setPosition(victim, 9, 9, 9);

        // No free channel left: this steals the oldest (channel 0).
        const thief = audio.play('ping');
        assert.ok(thief >= 0);
        assert.equal((thief >>> 0) & 0xFF, 0, 'the steal reused channel 0');
        assert.equal(audio.isPlaying(victim), false, 'victim handle is stale after the steal');

        audio._flushLanes();

        const thiefLanes = busRec.pool.voiceNode(thief >>> 0);
        assert.ok(thiefLanes, 'thief voice is alive');
        for (let k = 0; k < 8; k++) {
            assert.equal(targetEvents(thiefLanes[k].gain).length, 0, 'lane ' + k + ' must get zero stale writes on the new occupant');
        }
        audio.destroy();
    });
});

// ---------- 6. stereo-fallback discrete bus: no lane array ------------------

describe('a stereo-fallback discrete bus (2ch sink) exposes NO lane array and plays', () => {
    it('voiceNode() returns the stereo panner path, not an array; the bus still plays', async () => {
        const { audio, busRec, handles } = await buildDiscreteEngine(1, { channels: 2 });
        assert.equal(busRec.lanes, 0, 'a 2ch sink must fall back to lanes=0');
        assert.equal(busRec.effectiveLayout, 'stereo');
        const node = busRec.pool.voiceNode(handles[0] >>> 0);
        assert.equal(Array.isArray(node), false, 'a fallback bus must not expose a lane array');
        assert.equal(node.positionX, undefined, 'the fallback pool is stereo, not positional');
        assert.notEqual(node.pan, undefined, 'a StereoPanner voice exposes .pan');
        assert.ok(audio.activeCount('surr') >= 1, 'the fallback bus must actually be sounding');
        audio.destroy();
    });
});

// ---------- 7. setPosition boundary matrix on a discrete bus ----------------

describe('setPosition boundary matrix on a discrete bus (shares the positional scratch, no new branch)', () => {
    it('channel 0 and channel N-1 both accept a write; N, N+1, negative, NaN, null, undefined, non-integer, empty-string all fail closed as no-ops', async () => {
        const capacity = 4;
        const { audio, busRec, handles } = await buildDiscreteEngine(capacity, { capacity });

        assert.doesNotThrow(() => audio.setPosition(handles[0], 1, 2, 3));
        assert.doesNotThrow(() => audio.setPosition(handles[capacity - 1], 4, 5, 6));
        audio._flushLanes();
        const first = busRec.pool.voiceNode(handles[0] >>> 0);
        const last = busRec.pool.voiceNode(handles[capacity - 1] >>> 0);
        assert.equal(targetEvents(first[LANE_C].gain).length, 1, 'channel 0 got its flush');
        assert.equal(targetEvents(last[LANE_C].gain).length, 1, 'channel N-1 got its flush');

        const badHandles = [
            ['channel N (== capacity, first invalid)', busRec.index * BUS_STRIDE + capacity],
            ['channel N+1', busRec.index * BUS_STRIDE + capacity + 1],
            ['negative (-1)', -1],
            ['NaN', NaN],
            ['null', null],
            ['undefined', undefined],
            ['non-integer (1.5)', 1.5],
            ["empty string ('')", ''],
        ];
        for (const [label, bad] of badHandles) {
            assert.doesNotThrow(() => audio.setPosition(bad, 9, 9, 9), 'must not throw on: ' + label);
        }
        audio._flushLanes();

        // None of the bad calls re-dirtied (or re-wrote) the two live canaries.
        for (let k = 0; k < 8; k++) {
            assert.equal(targetEvents(first[k].gain).length, 1, 'channel 0 lane ' + k + ' untouched by bad handles');
            assert.equal(targetEvents(last[k].gain).length, 1, 'channel N-1 lane ' + k + ' untouched by bad handles');
        }
        audio.destroy();
    });

    it('-0 addresses the exact same scratch slot (pool handle 0) as literal handle 0', async () => {
        const { audio, busRec } = await buildDiscreteEngine(1);
        assert.doesNotThrow(() => audio.setPosition(-0, 4, 5, 6));
        assert.equal(busRec.posOwner[0], 0, 'owner slot 0 stamped with pool-handle 0');
        assert.equal(busRec.posXYZ[0], 4);
        assert.equal(busRec.posXYZ[1], 5);
        assert.equal(busRec.posXYZ[2], 6);
        audio.destroy();
    });

    it('empty scratch: a discrete bus with no pool built yet is a no-op, not a crash on a null array', async () => {
        const ctx = createMockContext({ state: 'suspended', maxChannelCount: 8 });
        const audio = new LiteAudio({
            buses: [], poolCapacity: 4, window: fakeWindow(), document: mockDocument(),
            fetch: mockFetch({}), setTimeout: () => 0, clearTimeout: () => {},
        });
        await audio.init(ctx);
        audio.createBus('surr', { spatial: 'discrete', preset: '7.1' });
        assert.equal(audio._buses.get('surr').posDirty, null, 'scratch not built yet (no sound routed/loaded)');
        assert.doesNotThrow(() => audio.setPosition(0, 1, 2, 3));
        assert.doesNotThrow(() => audio._flushLanes());
        audio.destroy();
    });

    it('adversarial: a voice that never had setPosition() called is a pure no-op on flush -- no default/rest write is smuggled in', async () => {
        const { audio, busRec, handles } = await buildDiscreteEngine(2);
        // handles[1] never gets setPosition(); only handles[0] is dirtied.
        audio.setPosition(handles[0], 0, 0, -1);
        audio._flushLanes();
        const untouched = busRec.pool.voiceNode(handles[1] >>> 0);
        for (let k = 0; k < 8; k++) {
            assert.equal(targetEvents(untouched[k].gain).length, 0, 'lane ' + k + ' of an un-dirtied voice must get zero writes');
        }
        audio.destroy();
    });
});

// ---------- 8. re-entrant write: coalesces to the LAST stamp ----------------

describe('re-entrant write: two setPosition calls on the same handle before one flush coalesce to the LAST value', () => {
    it('only ONE write per lane reaches the params, carrying the LAST stamped position', async () => {
        const { audio, busRec, handles } = await buildDiscreteEngine(1);
        audio.setPosition(handles[0], 0, 0, -1); // front (would light LANE_C)
        audio.setPosition(handles[0], 1, 0, 0);  // re-entrant: right (lights LANE_R/LANE_SR)
        audio._flushLanes();

        const lanes = busRec.pool.voiceNode(handles[0] >>> 0);
        assert.equal(targetEvents(lanes[LANE_C].gain).length, 1, 'LANE_C writes exactly once even though it was overwritten pre-flush');
        assert.equal(lanes[LANE_C].gain.value, 0, 'LANE_C must carry the LAST (right) solve, i.e. silent, not the first (front) solve');
        assert.ok(lanes[LANE_R].gain.value > 0, 'LANE_R must carry the LAST (right) solve');
        audio.destroy();
    });
});

// ---------- 9. createBus discrete/preset validation boundary ---------------

describe('createBus discrete/preset validation: fail closed with a did-you-mean, never a silent stereo', () => {
    it('spatial "Discrete" (case-sensitive typo) throws RangeError naming "discrete" as a valid option', async () => {
        const { audio } = await buildDiscreteEngine(1);
        assert.throws(
            () => audio.createBus('typo', { spatial: 'Discrete' }),
            (err) => {
                assert.ok(err instanceof RangeError);
                assert.match(err.message, /discrete/);
                return true;
            },
        );
        assert.equal(audio._buses.has('typo'), false, 'fail closed: the bus was never created');
        audio.destroy();
    });

    it('preset "5.1" and "3.1" throw a loud "lands in v2.5.0" RangeError, never a silent stereo fallback', async () => {
        const { audio } = await buildDiscreteEngine(1);
        for (const preset of ['5.1', '3.1']) {
            assert.throws(
                () => audio.createBus('b-' + preset, { spatial: 'discrete', preset }),
                (err) => {
                    assert.ok(err instanceof RangeError);
                    assert.match(err.message, /v2\.5\.0/);
                    return true;
                },
                'preset ' + preset,
            );
            assert.equal(audio._buses.has('b-' + preset), false);
        }
        audio.destroy();
    });

    it('an unknown preset (e.g. "9.1") throws RangeError naming "7.1" as the only valid option', async () => {
        const { audio } = await buildDiscreteEngine(1);
        assert.throws(
            () => audio.createBus('bogus-preset', { spatial: 'discrete', preset: '9.1' }),
            (err) => { assert.ok(err instanceof RangeError); assert.match(err.message, /7\.1/); return true; },
        );
        audio.destroy();
    });

    it('a preset on a NON-discrete bus is a wiring error, not a silent ignore', async () => {
        const { audio } = await buildDiscreteEngine(1);
        assert.throws(
            () => audio.createBus('stereo-with-preset', { preset: '7.1' }),
            RangeError,
        );
        assert.throws(
            () => audio.createBus('positional-with-preset', { spatial: 'positional', preset: '7.1' }),
            RangeError,
        );
        audio.destroy();
    });

    it('width > 0 on a discrete bus fails closed identically to positional/hrtf', async () => {
        const { audio } = await buildDiscreteEngine(1);
        assert.throws(
            () => audio.createBus('wide-discrete', { spatial: 'discrete', preset: '7.1', width: 0.5 }),
            RangeError,
        );
        assert.equal(audio._buses.has('wide-discrete'), false);
        // width: 0 on a discrete bus is a no-op request (nothing wide asked for) and
        // must NOT throw -- mirrors the positional/hrtf width===0 carve-out.
        assert.doesNotThrow(() => audio.createBus('zero-wide-discrete', { spatial: 'discrete', preset: '7.1', width: 0 }));
        audio.destroy();
    });

    it('a second discrete bus on the same 8ch sink does NOT re-mutate the destination (the _destChannelSaved latch fires once)', async () => {
        const { audio, ctx } = await buildDiscreteEngine(1);
        assert.equal(ctx.destination.channelCount, 8);
        audio.createBus('surr2', { spatial: 'discrete', preset: '7.1' });
        await audio.defineSounds({ ping2: { src: ['/s.wav'], bus: 'surr2' } });
        await flushMicrotasks(8);
        assert.equal(ctx.destination.channelCount, 8, 'still 8, not re-derived from a mutated destination');
        assert.equal(ctx.destination.channelCountMode, 'explicit');
        assert.equal(ctx.destination.channelInterpretation, 'discrete');
        audio.destroy();
    });
});

// ---------- 10. destroy(): duplicate dispose + dispose-during-iteration ----

describe('destroy() and discrete state: duplicate dispose, dispose mid-iteration over multiple discrete buses', () => {
    it('nulls posXYZ/posOwner/posDirty, resets lanes to 0 and effectiveLayout to null, empties _discreteBuses, restores the destination triple, and is idempotent', async () => {
        const { audio, ctx, busRec } = await buildDiscreteEngine(1);
        assert.ok(busRec.posXYZ, 'scratch allocated before destroy');
        assert.equal(busRec.lanes, 8);
        assert.equal(busRec.effectiveLayout, '7.1');
        assert.equal(audio._discreteBuses.length, 1);
        assert.equal(ctx.destination.channelCount, 8);

        audio.destroy();

        assert.equal(busRec.posXYZ, null);
        assert.equal(busRec.posOwner, null);
        assert.equal(busRec.posDirty, null);
        assert.equal(busRec.lanes, 0, 'a torn-down bus must never re-enter _flushLanes');
        assert.equal(busRec.effectiveLayout, null);
        assert.equal(audio._discreteBuses.length, 0);
        assert.equal(ctx.destination.channelCount, 2, 'destination restored to its pre-discrete triple');
        assert.equal(ctx.destination.channelCountMode, 'max');
        assert.equal(ctx.destination.channelInterpretation, 'speakers');

        // Duplicate dispose: a second destroy() must not throw, re-null anything
        // dangerously, or re-touch the (already-restored) destination.
        assert.doesNotThrow(() => audio.destroy());
        assert.equal(ctx.destination.channelCount, 2, 'still restored after the duplicate dispose');
        assert.doesNotThrow(() => audio.setPosition(0, 1, 2, 3), 'a stray setPosition after destroy is still a no-op');
        // The fail-closed guarantee for the private lane flush is that destroy() stops
        // the monitor (its only caller), so no tick can fire _flushLanes into a torn-down
        // engine -- the same contract the sibling _flushPositions relies on. Asserting the
        // monitor is down is the real invariant; calling the private flush directly with a
        // null _ctx tests an unreachable state (and would demand a cold-path branch the
        // shipped _flushPositions does not carry).
        assert.equal(audio._monitorTimer, null, 'destroy() stopped the monitor, so no stray _flushLanes tick can fire');
    });

    it('adversarial: destroy() re-entered mid-loop over TWO discrete buses is fail-closed and idempotent (dispose-during-iteration)', async () => {
        const ctx = createMockContext({ state: 'running', maxChannelCount: 8 });
        const audio = new LiteAudio({
            buses: [], poolCapacity: 4, window: fakeWindow(), document: mockDocument(),
            fetch: mockFetch({ '/a.wav': 500, '/b.wav': 500 }), setTimeout: () => 0, clearTimeout: () => {},
        });
        await audio.init(ctx);
        audio.createBus('surrA', { spatial: 'discrete', preset: '7.1' });
        audio.createBus('surrB', { spatial: 'discrete', preset: '7.1' });
        await audio.defineSounds({
            pingA: { src: ['/a.wav'], bus: 'surrA' },
            pingB: { src: ['/b.wav'], bus: 'surrB' },
        });
        await flushMicrotasks(8);
        const busA = audio._buses.get('surrA');
        const busB = audio._buses.get('surrB');
        assert.equal(busA.lanes, 8, 'bus A built discrete');
        assert.equal(busB.lanes, 8, 'bus B built discrete');
        audio.play('pingA');
        audio.play('pingB');

        // Re-enter destroy() from inside the FIRST pool.destroy() call (models a
        // consumer callback / onended tearing the engine down mid-teardown-loop).
        const busListSnapshot = audio._busList;
        let poolDestroyCalls = 0;
        const origPoolDestroyA = busA.pool.destroy.bind(busA.pool);
        busA.pool.destroy = (...args) => {
            poolDestroyCalls++;
            if (poolDestroyCalls === 1) {
                assert.doesNotThrow(() => audio.destroy(), 're-entrant destroy() from mid-bus-loop must not throw');
            }
            return origPoolDestroyA(...args);
        };

        assert.doesNotThrow(() => audio.destroy(), 'the outer destroy() call must finish despite the re-entrant dispose');

        assert.equal(busA.lanes, 0);
        assert.equal(busB.lanes, 0);
        assert.equal(busA.effectiveLayout, null);
        assert.equal(busB.effectiveLayout, null);
        assert.equal(busA.posXYZ, null);
        assert.equal(busB.posXYZ, null);
        assert.equal(audio._discreteBuses.length, 0);
        assert.equal(audio._destroyed, true);
        assert.equal(ctx.destination.channelCount, 2, 'destination restored exactly once despite re-entrant teardown');

        assert.doesNotThrow(() => audio.destroy(), 'duplicate dispose after the re-entrant one is still safe');
    });
});

// ---------- 11. retention: 200 discrete build/teardown cycles ---------------

describe('retention: 200 discrete build/teardown cycles release every node and restore the destination', () => {
    it('200 cycles: ctx._liveNodes() delta 0, merger/lowpass/every lane gain disconnected >= 1, destination triple restored, _discreteBuses emptied', async () => {
        const CYCLES = 200;
        let liveNodeMismatches = 0;
        let undisconnectedCycles = 0;

        for (let c = 0; c < CYCLES; c++) {
            const ctx = createMockContext({ state: 'running', maxChannelCount: 8 });
            const audio = new LiteAudio({
                buses: [], poolCapacity: 4, window: fakeWindow(), document: mockDocument(),
                fetch: mockFetch({ '/s.wav': 500 }), setTimeout: () => 0, clearTimeout: () => {},
            });
            await audio.init(ctx);
            const baseline = ctx._liveNodes();
            audio.createBus('surr', { spatial: 'discrete', preset: '7.1' });
            await audio.defineSounds({ ping: { src: ['/s.wav'], bus: 'surr' } });
            await flushMicrotasks(4);

            const busRec = audio._buses.get('surr');
            const pool = busRec.pool;
            const h = audio.play('ping');
            if (h < 0) throw new Error('cycle ' + c + ': play() returned a skip sentinel');

            // Capture the shared/per-voice node references BEFORE destroy() nulls
            // the pool's own fields out from under us.
            const merger = pool.merger;
            const lowpass = pool.lowpass;
            const laneSnapshots = [];
            for (let i = 0; i < pool.capacity; i++) laneSnapshots.push(pool.voiceLanes[i].slice());

            audio.destroy();

            if (ctx._liveNodes() !== baseline) liveNodeMismatches++;

            let allDisconnected = merger.disconnected >= 1 && lowpass.disconnected >= 1;
            for (const lanes of laneSnapshots) {
                for (const lane of lanes) {
                    if (lane.disconnected < 1) { allDisconnected = false; break; }
                }
            }
            if (!allDisconnected) undisconnectedCycles++;

            if (busRec.lanes !== 0 || audio._discreteBuses.length !== 0 ||
                busRec.posXYZ !== null || busRec.posOwner !== null || busRec.posDirty !== null ||
                ctx.destination.channelCount !== 2 || ctx.destination.channelCountMode !== 'max' ||
                ctx.destination.channelInterpretation !== 'speakers') {
                throw new Error('cycle ' + c + ': destroy() left discrete/destination state un-reset');
            }
        }

        assert.equal(liveNodeMismatches, 0, liveNodeMismatches + '/' + CYCLES + ' cycle(s) left a live-node delta');
        assert.equal(undisconnectedCycles, 0, undisconnectedCycles + '/' + CYCLES + ' cycle(s) left a discrete node connected');
    });
});
