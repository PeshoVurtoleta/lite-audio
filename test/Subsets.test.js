/**
 * @zakkster/lite-audio - S7 discrete-surround SUBSET (5+1 / 3+1) contract tests
 * (node:test).
 *
 * test/Discrete.test.js pins the S6 8-lane (7.1) discrete bus in full (build
 * shape, SMPTE lane order, VBAP landing, LFE invariance, steal-safety,
 * destroy()). This file is the S7 GENERALIZATION of that same contract onto
 * the two narrower presets the fallback ladder can build: 6-lane 5.1 (drops
 * SBL/SBR) and 4-lane 3.1 (front-only: C, R, L). The torture gate
 * (test/torture.mjs, T-SP3-lane) proves the ALLOCATION-FREE and RATE-BOUNDED
 * properties of the SAME _vbapSolve/_flushLanes machinery at these two widths;
 * that is not what this file is for.
 *
 * This file pins the FAIL-CLOSED CONTRACT and STRUCTURAL/GEOMETRIC correctness
 * at 6 and 4 lanes: does voiceNode() return exactly Array(6)/Array(4) with a
 * writable LANE_LFE at index 3? Does the SAME data-driven VBAP solver used for
 * 7.1 place a hard-panned source at UNIT gain on the exact ring lane its own
 * azimuth names, with every OTHER ring lane at exactly 0 (proving the ring
 * reduction, decisions/0009 D4, carries no leftover 7.1 geometry)? Is
 * LANE_LFE azimuth-invariant at every width? Does a stolen channel at 6/4
 * lanes get zero stale lane writes, mirroring the 8-lane steal-safety
 * contract? And does the 3.1 preset's documented rear-degeneracy (D4: no rear
 * speakers, a dead-rear source folds evenly across the 300-degree R/L gap)
 * actually measure the way decisions/0009 says it does?
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LiteAudio } from '../Audio.js';
import { createMockContext, mockFetch, mockDocument, flushMicrotasks } from './mock-ctx.js';

// Mirror of Audio.js's internal codec (not exported - an implementation
// detail, mirrored the same way Discrete.test.js does).
const BUS_STRIDE = 4294967296; // 2^32

// SMPTE lane indices, mirrored from Audio.js (not exported - the contract
// under test is the INDEX positions, so this file pins its own copy, exactly
// like Discrete.test.js does).
const LANE_L = 0, LANE_R = 1, LANE_C = 2, LANE_LFE = 3;
const LANE_SL = 4, LANE_SR = 5;

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
 * The two S7 preset specs under test, mirroring decisions/0009 D4's ring/az
 * tables exactly. `ring` lists the lane index at each ring position (the
 * SAME low SMPTE indices 7.1 uses - D4: a smaller preset just does not touch
 * the higher lanes). `az` is the azimuth (degrees) at each ring position,
 * trailing 360 the wrap sentinel (not a real speaker) - so the LANDING loop
 * below only walks `az.length - 1` real entries.
 */
const SUBSET_SPECS = [
    {
        preset: '5.1', channels: 6,
        ring: [LANE_C, LANE_R, LANE_SR, LANE_SL, LANE_L],
        az: [0, 30, 110, 250, 330, 360],
        names: ['C', 'R', 'SR', 'SL', 'L'],
    },
    {
        preset: '3.1', channels: 4,
        ring: [LANE_C, LANE_R, LANE_L],
        az: [0, 30, 330, 360],
        names: ['C', 'R', 'L'],
    },
];

/**
 * (x, y, z) that lands _vbapSolve's azimuth at exactly `azDeg` (0..360,
 * exclusive of 360 itself). atan2's principal range is (-180, 180], so an
 * azimuth beyond 180 is built from its negative-theta equivalent and then
 * normalized by the solver's own `if (az < 0) az += 360` -- this helper is
 * the solver's own az = atan2(x, -z) formula inverted, not a re-guess.
 */
function vecForAz(azDeg) {
    const theta = azDeg > 180 ? azDeg - 360 : azDeg;
    const rad = theta * Math.PI / 180;
    return [Math.sin(rad), 0, -Math.cos(rad)];
}

/**
 * Build a live LiteAudio with ONE discrete bus ('surr') at the given preset on
 * a sink pinned to exactly that preset's channel need (so the ladder resolves
 * the request with no fallback), plus `voices` sounding voices. ctx starts
 * 'running' so init() marks it unlocked immediately, and the clock never
 * advances, so voiceNode() keeps every voice alive across a flush. Mirrors
 * Discrete.test.js's buildDiscreteEngine, parameterized over preset/channels.
 */
async function buildSubsetEngine(preset, channels, voices = 1, { capacity } = {}) {
    const ctx = createMockContext({ state: 'running', maxChannelCount: channels });
    const audio = new LiteAudio({
        buses: [], poolCapacity: capacity ?? voices, window: fakeWindow(), document: mockDocument(),
        fetch: mockFetch({ '/s.wav': 500 }), setTimeout: () => 0, clearTimeout: () => {},
    });
    await audio.init(ctx);
    audio.createBus('surr', { spatial: 'discrete', preset });
    await audio.defineSounds({ ping: { src: ['/s.wav'], bus: 'surr' } });
    await flushMicrotasks(8);

    const handles = [];
    for (let i = 0; i < voices; i++) {
        const h = audio.play('ping');
        assert.ok(h >= 0, 'subset setup: play() must not skip');
        handles.push(h);
    }
    return { audio, ctx, handles, busRec: audio._buses.get('surr') };
}

for (const spec of SUBSET_SPECS) {
    const { preset, channels, ring, az, names } = spec;
    const EPS = 1e-5;

    // ---- 1. build: one merger, exactly `channels` writable lane gains -----

    describe(preset + ' (' + channels + '-lane) build: exactly one ChannelMerger(' + channels + '), ' + channels + ' writable lane gains per voice', () => {
        it('constructs exactly one ChannelMerger and it reports numberOfInputs === ' + channels, async () => {
            const ctx = createMockContext({ state: 'running', maxChannelCount: channels });
            let mergerCalls = 0;
            const origCreateMerger = ctx.createChannelMerger.bind(ctx);
            ctx.createChannelMerger = (n) => { mergerCalls++; return origCreateMerger(n); };
            const audio = new LiteAudio({
                buses: [], poolCapacity: 4, window: fakeWindow(), document: mockDocument(),
                fetch: mockFetch({ '/s.wav': 500 }), setTimeout: () => 0, clearTimeout: () => {},
            });
            await audio.init(ctx);
            audio.createBus('surr', { spatial: 'discrete', preset });
            await audio.defineSounds({ ping: { src: ['/s.wav'], bus: 'surr' } });
            await flushMicrotasks(8);

            assert.equal(mergerCalls, 1, 'exactly one ChannelMerger must be constructed for one discrete bus');
            const pool = audio._buses.get('surr').pool;
            assert.equal(pool.merger.numberOfInputs, channels);
            audio.destroy();
        });

        it('every voice exposes exactly ' + channels + ' writable lane gains via voiceNode(), LANE_LFE (index 3) among them', async () => {
            const capacity = 3;
            const { audio, busRec } = await buildSubsetEngine(preset, channels, capacity, { capacity });
            for (let ch = 0; ch < capacity; ch++) {
                const h = busRec.index * BUS_STRIDE + ch;
                const lanes = busRec.pool.voiceNode(h >>> 0);
                assert.ok(Array.isArray(lanes), 'channel ' + ch + ': voiceNode must return an array in discrete mode');
                assert.equal(lanes.length, channels, 'channel ' + ch + ': exactly ' + channels + ' lanes');
                for (let k = 0; k < channels; k++) {
                    assert.ok(lanes[k] && lanes[k].gain, 'channel ' + ch + ' lane ' + k + ' must expose a writable .gain');
                    assert.equal(typeof lanes[k].gain.setTargetAtTime, 'function');
                }
                assert.ok(lanes[LANE_LFE] && lanes[LANE_LFE].gain, 'LANE_LFE (index 3) must be present and writable');
            }
            audio.destroy();
        });

        it('busRec.lanes === ' + channels + ' and busRec.effectiveLayout === "' + preset + '" (no silent downgrade)', async () => {
            const { audio, busRec } = await buildSubsetEngine(preset, channels, 1);
            assert.equal(busRec.lanes, channels);
            assert.equal(busRec.effectiveLayout, preset);
            audio.destroy();
        });
    });

    // ---- 2. VBAP landing: unit gain at each ring lane's OWN azimuth --------

    describe(preset + ' VBAP landing: a source at each ring lane\'s own azimuth lands UNIT gain there, every other ring lane 0', () => {
        for (let i = 0; i < ring.length; i++) {
            const lane = ring[i];
            const laneName = names[i];
            const azDeg = az[i];

            it('az=' + azDeg + ' (' + laneName + ') lands unit gain on LANE_' + laneName + ', every other ring lane is 0', async () => {
                const { audio, busRec, handles } = await buildSubsetEngine(preset, channels, 1);
                const [x, y, z] = vecForAz(azDeg);
                audio.setPosition(handles[0], x, y, z);
                audio._flushLanes();
                const lanes = busRec.pool.voiceNode(handles[0] >>> 0);
                assert.ok(
                    Math.abs(lanes[lane].gain.value - 1) < EPS,
                    'LANE_' + laneName + ' must carry unit gain at its own azimuth, got ' + lanes[lane].gain.value,
                );
                for (let j = 0; j < ring.length; j++) {
                    if (ring[j] === lane) continue;
                    assert.ok(
                        Math.abs(lanes[ring[j]].gain.value) < EPS,
                        'ring lane ' + names[j] + ' (index ' + ring[j] + ') must be silent when the source sits exactly on ' + laneName + ', got ' + lanes[ring[j]].gain.value,
                    );
                }
                audio.destroy();
            });
        }

        it('midpoint between the first two ring lanes (' + names[0] + '/' + names[1] + ') is a constant-power split, every other ring lane 0', async () => {
            const { audio, busRec, handles } = await buildSubsetEngine(preset, channels, 1);
            const mid = (az[0] + az[1]) / 2;
            const [x, y, z] = vecForAz(mid);
            audio.setPosition(handles[0], x, y, z);
            audio._flushLanes();
            const lanes = busRec.pool.voiceNode(handles[0] >>> 0);
            const g0 = lanes[ring[0]].gain.value, g1 = lanes[ring[1]].gain.value;
            assert.ok(g0 > 0 && g1 > 0, 'both lanes of the pair must be live at the midpoint');
            assert.ok(Math.abs(g0 * g0 + g1 * g1 - 1) < 1e-3, 'constant-power: g0^2 + g1^2 must be ~1');
            for (let j = 2; j < ring.length; j++) {
                assert.ok(Math.abs(lanes[ring[j]].gain.value) < EPS, 'lane ' + names[j] + ' must be silent at the ' + names[0] + '/' + names[1] + ' midpoint');
            }
            audio.destroy();
        });
    });

    // ---- 3. LANE_LFE azimuth-invariant, never VBAP-derived -----------------

    describe(preset + ' LANE_LFE: azimuth-invariant distance-only send, never a VBAP value', () => {
        it('the LFE gain is IDENTICAL at three different azimuths (front, first-pair, last-pair) and always nonzero', async () => {
            const { audio, busRec, handles } = await buildSubsetEngine(preset, channels, 1);
            const lanes = busRec.pool.voiceNode(handles[0] >>> 0);

            const [x0, y0, z0] = vecForAz(az[0]);
            audio.setPosition(handles[0], x0, y0, z0);
            audio._flushLanes();
            const lfeA = lanes[LANE_LFE].gain.value;

            const [x1, y1, z1] = vecForAz(az[1]);
            audio.setPosition(handles[0], x1, y1, z1);
            audio._flushLanes();
            const lfeB = lanes[LANE_LFE].gain.value;

            const [x2, y2, z2] = vecForAz(az[ring.length - 1]);
            audio.setPosition(handles[0], x2, y2, z2);
            audio._flushLanes();
            const lfeC = lanes[LANE_LFE].gain.value;

            assert.notEqual(lfeA, 0, 'LFE must never be silent');
            assert.equal(lfeA, lfeB, 'LFE must be identical across azimuths (azimuth-invariant)');
            assert.equal(lfeB, lfeC, 'LFE must be identical across azimuths (azimuth-invariant)');

            const lfeWrites = targetEvents(lanes[LANE_LFE].gain);
            assert.equal(lfeWrites.length, 3, 'one LFE write per flush, three flushes');
            audio.destroy();
        });

        it('exactly ' + channels + ' writes per voice per flush; LANE_LFE receives exactly 1 of them', async () => {
            const { audio, busRec, handles } = await buildSubsetEngine(preset, channels, 1);
            const [x, y, z] = vecForAz(az[1]);
            audio.setPosition(handles[0], x, y, z);
            audio._flushLanes();
            const lanes = busRec.pool.voiceNode(handles[0] >>> 0);
            let total = 0;
            for (let k = 0; k < channels; k++) {
                const n = targetEvents(lanes[k].gain).length;
                assert.equal(n, 1, 'lane ' + k + ' must write exactly once per flush');
                total += n;
            }
            assert.equal(total, channels, 'exactly ' + channels + ' lane writes per voice per flush');
            audio.destroy();
        });
    });

    // ---- 4. steal-safety at this width --------------------------------------

    describe(preset + ' steal-safety: a stolen channel gets zero stale lane writes on the new occupant', () => {
        it('setPosition on the victim, then a steal, then flush -- the thief gets ZERO writes on all ' + channels + ' lanes', async () => {
            const capacity = 4;
            const { audio, busRec, handles } = await buildSubsetEngine(preset, channels, capacity, { capacity });

            const victim = handles[0]; // channel 0
            const [vx, vy, vz] = vecForAz(az[1]);
            audio.setPosition(victim, vx, vy, vz);

            // No free channel left: this steals the oldest (channel 0).
            const thief = audio.play('ping');
            assert.ok(thief >= 0);
            assert.equal((thief >>> 0) & 0xFF, 0, 'the steal reused channel 0');
            assert.equal(audio.isPlaying(victim), false, 'victim handle is stale after the steal');

            audio._flushLanes();

            const thiefLanes = busRec.pool.voiceNode(thief >>> 0);
            assert.ok(thiefLanes, 'thief voice is alive');
            for (let k = 0; k < channels; k++) {
                assert.equal(targetEvents(thiefLanes[k].gain).length, 0, 'lane ' + k + ' must get zero stale writes on the new occupant');
            }
            audio.destroy();
        });
    });
}

// ---------- 5. 3.1's documented rear degeneracy (D4) ------------------------

describe('3.1 rear degeneracy (decisions/0009 D4): no rear speakers, a dead-rear source folds evenly across the 300-degree R/L gap', () => {
    it('hard-rear (0,0,1), az=180, splits EQUALLY across R and L (the only pair spanning the back), LANE_C is silent', async () => {
        const { audio, busRec, handles } = await buildSubsetEngine('3.1', 4, 1);
        audio.setPosition(handles[0], 0, 0, 1);
        audio._flushLanes();
        const lanes = busRec.pool.voiceNode(handles[0] >>> 0);
        assert.ok(Math.abs(lanes[LANE_R].gain.value - lanes[LANE_L].gain.value) < 1e-5, 'dead-rear must split EQUALLY across R/L in a front-only rig');
        assert.ok(lanes[LANE_R].gain.value > 0.5, 'R must be substantially live at hard-rear (constant-power midpoint ~0.7071)');
        assert.ok(Math.abs(lanes[LANE_C].gain.value) < 1e-5, 'LANE_C must be silent at hard-rear');
        audio.destroy();
    });
});
