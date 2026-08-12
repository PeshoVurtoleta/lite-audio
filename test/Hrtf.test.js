/**
 * @zakkster/lite-audio - S4 HRTF spatial contract tests (node:test).
 *
 * The torture gate (test/torture.mjs, T-SP5) proves the ALLOCATION-FREE and
 * RETENTION properties of the hrtf bus + HRIR prewarm: panner census across
 * capacity, the gain=0 prewarm voice's retire-and-release, and a 200-cycle
 * lite-leak soak. Neither of those is a correctness/boundary question, and
 * neither is what this file is for.
 *
 * This file pins the FAIL-CLOSED CONTRACT and BOUNDARY MATRIX a heap/rate/
 * retention gate cannot see: does createBus reject an unknown spatial value
 * with a useful message? Does an hrtf bus really build HRTF panners (not
 * equalpower, not a bare StereoPanner) across every channel, including the
 * first and the last? Does setPosition on an hrtf bus behave EXACTLY like a
 * positional bus (same handle codec, same scratch-stamp-then-flush
 * semantics) and stay inert on a stereo bus? Does the prewarm latch fire
 * exactly once, retry on a skipped play(), and release cleanly under
 * destroy() -- including mid-retire and under re-entrant teardown?
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LiteAudio } from '../Audio.js';
import { createMockContext, mockFetch, mockDocument, flushMicrotasks } from './mock-ctx.js';

// Mirror of Audio.js's internal codec (not exported - an implementation
// detail). Handles.test.js pins the real engine agrees with this arithmetic;
// this file only needs it to CRAFT adversarial handles.
const BUS_STRIDE = 4294967296; // 2^32

// ---------- Fake window (unlock gesture wiring, mirrors Audio.test.js) -----

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
 * One LiteAudio, context already 'running' at init (so init() unlocks
 * immediately and the pool-build call site of _prewarmHrtf fires without a
 * gesture -- the same setup torture.mjs's T-SP5 uses). Builds any of an
 * 'hrtf' bus ('spatial'), a 'positional' bus ('world') and a plain 'stereo'
 * bus ('flat'), all sharing one capacity, each with one routed sound.
 */
async function buildEngine(capacity = 4, { hrtf = true, positional = true, stereo = true, ctxState = 'running' } = {}) {
    const ctx = createMockContext({ state: ctxState });
    const win = fakeWindow();
    const audio = new LiteAudio({
        buses: [],
        poolCapacity: capacity,
        window: win,
        document: mockDocument(),
        fetch: mockFetch({ '/s.wav': 500 }),
        setTimeout: () => 0,
        clearTimeout: () => {},
    });
    await audio.init(ctx);
    const sounds = {};
    if (hrtf) { audio.createBus('spatial', { spatial: 'hrtf' }); sounds.ping = { src: ['/s.wav'], bus: 'spatial' }; }
    if (positional) { audio.createBus('world', { spatial: 'positional' }); sounds.pong = { src: ['/s.wav'], bus: 'world' }; }
    if (stereo) { audio.createBus('flat'); sounds.beep = { src: ['/s.wav'], bus: 'flat' }; }
    await audio.defineSounds(sounds);
    await flushMicrotasks(8);
    return { audio, ctx, win };
}

// ---------- 1. createBus spatial:'hrtf' accepted; bogus value fails closed -

describe('createBus spatial:"hrtf"', () => {
    it('is accepted and recorded as positional-family', async () => {
        const { audio } = await buildEngine(4, { positional: false, stereo: false });
        const busRec = audio._buses.get('spatial');
        assert.equal(busRec.spatial, 'hrtf');
        assert.equal(busRec.positional, true, 'hrtf is positional-family (same distance graph)');
    });

    it('a bogus spatial value throws a RangeError naming all three valid options (fail closed, no silent stereo fallback)', async () => {
        const { audio } = await buildEngine(4, { hrtf: false, positional: false, stereo: false });
        assert.throws(
            () => audio.createBus('oops', { spatial: 'htrf' }),
            (err) => {
                assert.ok(err instanceof RangeError, 'must be a RangeError, not a generic Error');
                assert.match(err.message, /htrf/, 'echoes the bad value back to the caller');
                assert.match(err.message, /stereo/, 'names stereo as a valid option');
                assert.match(err.message, /positional/, 'names positional as a valid option');
                assert.match(err.message, /hrtf/, 'names hrtf as a valid option');
                return true;
            },
        );
        assert.equal(audio._buses.has('oops'), false, 'fail closed: the bus was never created');
    });

    it('adversarial: spatial values that ARE valid substrings of each other do not false-positive (e.g. "Hrtf", "HRTF ", "")', async () => {
        const { audio } = await buildEngine(4, { hrtf: false, positional: false, stereo: false });
        for (const bad of ['Hrtf', 'HRTF', 'hrtf ', ' hrtf', '', 'stereo ']) {
            assert.throws(
                () => audio.createBus('b-' + bad, { spatial: bad }),
                RangeError,
                'case/whitespace-sensitive match required for: ' + JSON.stringify(bad),
            );
        }
    });
});

// ---------- 2. three-way panner distinction across capacity ----------------

describe('three-way panner distinction across capacity (0 exceptions)', () => {
    it('a stereo bus builds StereoPanner voices: 0 (3D) panners, no panningModel anywhere', async () => {
        const { audio } = await buildEngine(4, { hrtf: false, positional: false, stereo: true });
        const pool = audio._buses.get('flat').pool;
        assert.equal(pool.panners.length, 4);
        let threeDCount = 0;
        for (let i = 0; i < pool.panners.length; i++) {
            const p = pool.panners[i];
            assert.equal(p.kind, 'panner', 'channel ' + i + ' is a StereoPanner, not a 3D PannerNode');
            if (p.panningModel !== undefined) threeDCount++;
        }
        assert.equal(threeDCount, 0, 'a stereo bus builds 0 panners exposing panningModel');
    });

    it('a positional bus reports panningModel==="equalpower" on every channel', async () => {
        const { audio } = await buildEngine(5, { hrtf: false, positional: true, stereo: false });
        const pool = audio._buses.get('world').pool;
        assert.equal(pool.panners.length, 5);
        for (let i = 0; i < pool.panners.length; i++) {
            assert.equal(pool.panners[i].panningModel, 'equalpower', 'channel ' + i);
        }
    });

    it('an hrtf bus reports panningModel==="HRTF" on every channel, at capacity 1 (N=1), 2 and 5', async () => {
        for (const capacity of [1, 2, 5]) {
            const { audio } = await buildEngine(capacity, { hrtf: true, positional: false, stereo: false });
            const pool = audio._buses.get('spatial').pool;
            assert.equal(pool.panners.length, capacity);
            let nonHrtf = 0;
            for (let i = 0; i < capacity; i++) {
                if (pool.panners[i].panningModel !== 'HRTF') nonHrtf++;
            }
            assert.equal(nonHrtf, 0, 'capacity=' + capacity + ': ' + nonHrtf + ' of ' + capacity + ' channels are not HRTF');
            audio.destroy();
        }
    });

    it('the first (0) and last (N-1) channels are both HRTF -- catches an off-by-one in the pool build loop', async () => {
        const capacity = 6;
        const { audio } = await buildEngine(capacity, { hrtf: true, positional: false, stereo: false });
        const pool = audio._buses.get('spatial').pool;
        assert.equal(pool.panners[0].panningModel, 'HRTF', 'channel 0');
        assert.equal(pool.panners[capacity - 1].panningModel, 'HRTF', 'channel N-1');
    });
});

// ---------- 3. setPosition parity: hrtf === positional; inert on stereo ----

describe('setPosition parity: hrtf behaves exactly like positional; inert on stereo', () => {
    it('happy path: hrtf setPosition stamps scratch, and the next flush writes the exact value once', async () => {
        const { audio } = await buildEngine(4);
        audio._retireHrtfWarm(); // free the prewarm's channel before playing real voices
        const h = audio.play('ping');
        assert.ok(h >= 0);
        const pool = audio._buses.get('spatial').pool;
        const node = pool.voiceNode(h >>> 0);

        audio.setPosition(h, 3, 5, 7);
        assert.equal(targetEvents(node.positionX).length, 0, 'no write before flush');

        audio._flushPositions();
        const xEvents = targetEvents(node.positionX);
        const yEvents = targetEvents(node.positionY);
        const zEvents = targetEvents(node.positionZ);
        assert.equal(xEvents.length, 1);
        assert.equal(yEvents.length, 1);
        assert.equal(zEvents.length, 1);
        assert.equal(xEvents[0][1], 3);
        assert.equal(yEvents[0][1], 5);
        assert.equal(zEvents[0][1], 7);
    });

    it('re-entrant write: two setPosition calls on the same hrtf handle before a flush coalesce to the LAST write', async () => {
        const { audio } = await buildEngine(4);
        audio._retireHrtfWarm();
        const h = audio.play('ping');
        const node = audio._buses.get('spatial').pool.voiceNode(h >>> 0);

        audio.setPosition(h, 1, 1, 1);
        audio.setPosition(h, 2, 2, 2); // re-entrant write to the same dirty slot
        audio._flushPositions();

        const xEvents = targetEvents(node.positionX);
        assert.equal(xEvents.length, 1, 'only ONE native write reaches the param, not two');
        assert.equal(xEvents[0][1], 2, 'the flushed value is the LAST stamp, not the first');
    });

    it('boundary matrix on an hrtf bus: channel 0, N-1 accept; N, N+1, negative, NaN, null, undefined, non-integer fail closed', async () => {
        const capacity = 4;
        const { audio } = await buildEngine(capacity);
        audio._retireHrtfWarm();

        const handles = [];
        for (let i = 0; i < capacity; i++) handles.push(audio.play('ping'));
        for (const h of handles) assert.ok(h >= 0);
        const spatialIndex = audio._buses.get('spatial').index;
        const pool = audio._buses.get('spatial').pool;

        // Valid boundary: channel 0 (min) and channel N-1 (max) both accept a write.
        assert.doesNotThrow(() => audio.setPosition(handles[0], 1, 2, 3));
        assert.doesNotThrow(() => audio.setPosition(handles[capacity - 1], 4, 5, 6));
        audio._flushPositions();
        assert.equal(targetEvents(pool.voiceNode(handles[0] >>> 0).positionX).length, 1, 'channel 0 got its write');
        assert.equal(targetEvents(pool.voiceNode(handles[capacity - 1] >>> 0).positionX).length, 1, 'channel N-1 got its write');

        const badHandles = [
            ['channel N (== capacity, first invalid)', spatialIndex * BUS_STRIDE + capacity],
            ['channel N+1', spatialIndex * BUS_STRIDE + capacity + 1],
            ['negative (-1)', -1],
            ['NaN', NaN],
            ['null', null],
            ['undefined', undefined],
            ['non-integer (1.5)', 1.5],
        ];
        for (const [label, bad] of badHandles) {
            assert.doesNotThrow(() => audio.setPosition(bad, 9, 9, 9), 'must not throw on: ' + label);
        }
        audio._flushPositions();

        // None of the bad calls re-dirtied (or dirtied a second time) the two live canaries.
        assert.equal(targetEvents(pool.voiceNode(handles[0] >>> 0).positionX).length, 1, 'channel 0 untouched by bad handles');
        assert.equal(targetEvents(pool.voiceNode(handles[capacity - 1] >>> 0).positionX).length, 1, 'channel N-1 untouched by bad handles');
    });

    it('-0 addresses the exact same scratch slot (pool handle 0) as literal handle 0 on an hrtf bus', async () => {
        const { audio } = await buildEngine(4, { hrtf: true, positional: false, stereo: false });
        const busRec = audio._buses.get('spatial');
        assert.doesNotThrow(() => audio.setPosition(-0, 4, 5, 6));
        // Number.isInteger(-0) is true and -0 < 0 is false, so -0 passes the fail-
        // closed guard exactly like a literal 0, and (-0) >>> 0 === 0, so it stamps
        // the SAME owner/xyz slot a literal 0 would -- proven directly against the
        // scratch (not a live voice, so this holds independent of any generation the
        // HRIR prewarm may already have bumped on channel 0).
        assert.equal(busRec.posOwner[0], 0, 'owner slot 0 stamped with pool-handle 0');
        assert.equal(busRec.posXYZ[0], 4);
        assert.equal(busRec.posXYZ[1], 5);
        assert.equal(busRec.posXYZ[2], 6);
    });

    it('empty scratch: an hrtf bus with no pool built yet is a no-op, not a crash on a null array', async () => {
        const ctx = createMockContext({ state: 'suspended' });
        const win = fakeWindow();
        const audio = new LiteAudio({
            buses: [], poolCapacity: 4, window: win, document: mockDocument(),
            fetch: mockFetch({}), setTimeout: () => 0, clearTimeout: () => {},
        });
        await audio.init(ctx);
        audio.createBus('spatial', { spatial: 'hrtf' });
        assert.equal(audio._buses.get('spatial').posDirty, null, 'scratch not built yet (no sound routed/loaded)');
        assert.doesNotThrow(() => audio.setPosition(0, 1, 2, 3));
        assert.doesNotThrow(() => audio._flushPositions());
    });

    it('a stereo-bus handle is inert (no positionX to write, no throw) and does not disturb a live hrtf voice', async () => {
        const capacity = 4;
        const { audio } = await buildEngine(capacity, { hrtf: true, positional: false, stereo: true });
        audio._retireHrtfWarm();

        const hrtfHandle = audio.play('ping');
        assert.ok(hrtfHandle >= 0);
        const hrtfNode = audio._buses.get('spatial').pool.voiceNode(hrtfHandle >>> 0);
        assert.ok(hrtfNode, 'canary hrtf voice is live');

        const beep = audio.play('beep');
        assert.ok(beep >= 0);
        assert.doesNotThrow(() => audio.setPosition(beep, 1, 2, 3), 'stereo-bus handle must not throw');
        const flatNode = audio._buses.get('flat').pool.voiceNode(beep >>> 0);
        assert.equal(flatNode.positionX, undefined, 'stereo voice has no positionX to corrupt');

        audio._flushPositions();
        assert.equal(targetEvents(hrtfNode.positionX).length, 0, 'the unrelated live hrtf voice was not touched');
        assert.equal(targetEvents(hrtfNode.positionY).length, 0);
        assert.equal(targetEvents(hrtfNode.positionZ).length, 0);
    });
});

// ---------- 4. HRIR prewarm idempotence -------------------------------------

describe('HRIR prewarm idempotence', () => {
    it('fires exactly once per bus: a second arm attempt (mirrors the unlock-transition call site) is a no-op', async () => {
        const { audio } = await buildEngine(4, { positional: false, stereo: false });
        const busRec = audio._buses.get('spatial');
        assert.equal(busRec.hrtfWarmed, true, 'the pool-build call site already armed it (ctx was running at init)');
        const firstHandle = busRec.hrtfWarmHandle;
        assert.ok(firstHandle !== null);
        const activeBefore = audio.activeCount('spatial');

        audio._prewarmHrtf(busRec); // second call site, same bus
        assert.equal(busRec.hrtfWarmHandle, firstHandle, 'the handle was not replaced');
        assert.equal(audio.activeCount('spatial'), activeBefore, 'no second voice was armed');
    });

    it('a prewarm whose play() returns the skip sentinel (<0) does NOT latch hrtfWarmed, and a later attempt retries', async () => {
        // Locked at init: the pool-build call site inside defineSounds must no-op
        // (guarded by !this._sUnlocked.peek()), so the ONLY prewarm attempt is the
        // one driven by the unlock gesture below.
        const ctx = createMockContext({ state: 'suspended' });
        const win = fakeWindow();
        const audio = new LiteAudio({
            buses: [], poolCapacity: 4, window: win, document: mockDocument(),
            fetch: mockFetch({ '/s.wav': 500 }), setTimeout: () => 0, clearTimeout: () => {},
        });
        await audio.init(ctx);
        audio.createBus('spatial', { spatial: 'hrtf' });
        await audio.defineSounds({ ping: { src: ['/s.wav'], bus: 'spatial' } });
        const busRec = audio._buses.get('spatial');
        assert.equal(busRec.hrtfWarmed, false, 'still locked: pool build must not have armed it');

        // Force the FIRST prewarm attempt (fired from the unlock transition) to see
        // the skip sentinel by stubbing play() to return -1 exactly once.
        const origPlay = audio.play.bind(audio);
        let calls = 0;
        audio.play = (...args) => { calls++; return calls === 1 ? -1 : origPlay(...args); };

        win._fire('touchstart');
        await flushMicrotasks(8);

        assert.equal(busRec.hrtfWarmed, false, 'a skipped prewarm play must not latch (null, not zero)');
        assert.equal(busRec.hrtfWarmHandle, null);

        // Retry: a later attempt at the same call site gets a real handle now.
        audio._prewarmHrtf(busRec);
        assert.equal(busRec.hrtfWarmed, true, 'the retried attempt latches');
        assert.ok(busRec.hrtfWarmHandle !== null && busRec.hrtfWarmHandle >= 0);

        audio.play = origPlay;
    });
});

// ---------- 5. destroy() with a still-armed prewarm -------------------------

describe('destroy() and the HRIR prewarm', () => {
    it('nulls hrtfWarmHandle/hrtfWarmPending on a STILL-ARMED prewarm (retire never ran), does not double-stop, and the live-node census returns to baseline', async () => {
        // A running ctx arms the prewarm automatically at pool build (inside
        // defineSounds) - the census baseline must be captured BEFORE that call,
        // exactly as torture.mjs's T-SP5 builder does, so the delta below is an
        // honest measure of the prewarm voice alone.
        const ctx = createMockContext({ state: 'running' });
        const win = fakeWindow();
        const audio = new LiteAudio({
            buses: [], poolCapacity: 4, window: win, document: mockDocument(),
            fetch: mockFetch({ '/s.wav': 500 }), setTimeout: () => 0, clearTimeout: () => {},
        });
        await audio.init(ctx);
        audio.createBus('spatial', { spatial: 'hrtf' });
        const baseline = ctx._liveNodes(); // no voice has sounded yet
        await audio.defineSounds({ ping: { src: ['/s.wav'], bus: 'spatial' } });
        await flushMicrotasks(8);

        const busRec = audio._buses.get('spatial');
        assert.ok(busRec.hrtfWarmHandle !== null, 'prewarm armed at pool build (ctx already running)');
        assert.equal(busRec.hrtfWarmPending, 1, 'still-armed: the retire tick has not run yet');
        assert.ok(audio.activeCount('spatial') >= 1);
        assert.ok(ctx._liveNodes() > baseline, 'the silent prewarm voice is live');

        assert.doesNotThrow(() => audio.destroy(), 'destroy() on a still-armed prewarm must not throw');
        assert.equal(busRec.hrtfWarmHandle, null, 'handle nulled, not left dangling');
        assert.equal(busRec.hrtfWarmPending, 0);
        assert.equal(ctx._liveNodes(), baseline, 'the census returns to baseline: destroy() stopped the still-live prewarm voice');

        // Duplicate dispose: a second destroy() must not throw or double-stop.
        assert.doesNotThrow(() => audio.destroy());
        assert.equal(ctx._liveNodes(), baseline, 'still at baseline after the duplicate dispose');
    });

    it('adversarial: destroy() re-entered from inside _retireHrtfWarm mid-loop over MULTIPLE hrtf buses is fail-closed and idempotent', async () => {
        // Two hrtf buses, both armed. Stub stop() so the FIRST call re-enters
        // destroy() synchronously (models an onended/consumer callback tearing the
        // engine down WHILE _retireHrtfWarm is still mid-iteration), then verify
        // the retire loop finishes without throwing and every bus record ends up
        // in the same nulled, non-dangling state destroy() guarantees.
        const ctx = createMockContext({ state: 'running' });
        const win = fakeWindow();
        const audio = new LiteAudio({
            buses: [], poolCapacity: 4, window: win, document: mockDocument(),
            fetch: mockFetch({ '/a.wav': 500, '/b.wav': 500 }), setTimeout: () => 0, clearTimeout: () => {},
        });
        await audio.init(ctx);
        audio.createBus('spatialA', { spatial: 'hrtf' });
        audio.createBus('spatialB', { spatial: 'hrtf' });
        await audio.defineSounds({
            pingA: { src: ['/a.wav'], bus: 'spatialA' },
            pingB: { src: ['/b.wav'], bus: 'spatialB' },
        });
        const busA = audio._buses.get('spatialA');
        const busB = audio._buses.get('spatialB');
        assert.ok(busA.hrtfWarmHandle !== null, 'bus A armed');
        assert.ok(busB.hrtfWarmHandle !== null, 'bus B armed');

        const origStop = audio.stop.bind(audio);
        let stopCalls = 0;
        audio.stop = (handle) => {
            stopCalls++;
            if (stopCalls === 1) {
                assert.doesNotThrow(() => audio.destroy(), 're-entrant destroy() from mid-retire must not throw');
            }
            return origStop(handle);
        };

        assert.doesNotThrow(() => audio._retireHrtfWarm(), 'the retire loop must finish despite the re-entrant dispose');

        // After the re-entrant destroy() ran (nulling both bus records) AND the
        // retire loop's own tail assignments ran on top of that, both records must
        // still be in the fail-closed nulled state - never a dangling handle.
        assert.equal(busA.hrtfWarmHandle, null);
        assert.equal(busB.hrtfWarmHandle, null);
        assert.equal(busA.hrtfWarmPending, 0);
        assert.equal(busB.hrtfWarmPending, 0);
        assert.equal(audio._destroyed, true);

        // Duplicate dispose after the re-entrant one: still safe.
        assert.doesNotThrow(() => audio.destroy());
    });
});

// ---------- 6. activeCount() semantics during the prewarm window -----------

describe('activeCount() during the prewarm arm-to-retire window', () => {
    it('pins the current, documented behaviour: the silent gain=0 prewarm voice IS counted by activeCount() until the next monitor tick retires it', async () => {
        // This is a deliberate documentation test, not an endorsement to change
        // hot-path accounting: activeCount() is a single indexed scan over
        // pool.activeCount() (expireTimes[i] > now) with no branch for "is this a
        // prewarm voice" - adding one would cost every call, forever, to shave one
        // frame off a value that is cosmetic (a HUD counter, not a scheduling
        // decision). If this is ever judged wrong, the fix belongs in a review
        // finding, not a silent hot-path branch here.
        const { audio } = await buildEngine(4, { positional: false, stereo: false });
        const busRec = audio._buses.get('spatial');
        assert.equal(busRec.hrtfWarmed, true, 'armed at pool build (ctx already running)');
        assert.equal(audio.activeCount('spatial'), 1, 'the prewarm voice IS visible in activeCount before the first retire tick');

        audio._retireHrtfWarm();
        assert.equal(audio.activeCount('spatial'), 0, 'and drops back to 0 the tick after retire, with no voice ever having played');
    });
});
