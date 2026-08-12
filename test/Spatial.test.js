/**
 * @zakkster/lite-audio - S3 spatial contract tests (node:test).
 *
 * The torture gate (test/torture.mjs, T-SP1/T-SP2) proves the ALLOCATION and
 * NATIVE-EVENT-RATE budgets: setPosition() stamps scratch with zero bytes/op,
 * and the throttled flush holds the SP-03 native-event bound. Neither of
 * those is a heap-visible property, and neither is what THIS file is for.
 *
 * This file pins the FAIL-CLOSED CONTRACT a heap/rate gate cannot see: given
 * a handle, does setPosition() write to the right voice, the wrong voice, or
 * nothing at all? Every case here is a correctness question, not a budget.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LiteAudio } from '../Audio.js';
import { createMockContext, mockFetch, mockDocument, flushMicrotasks } from './mock-ctx.js';

// Mirror of Audio.js's internal codec (not exported - it's an implementation
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
        removeEventListener(evt, cb) {
            listeners.get(evt)?.delete(cb);
        },
        _fire(evt, data = {}) {
            for (const cb of [...(listeners.get(evt) || [])]) cb(data);
        },
    };
}

// ---------- Shared engine builder ------------------------------------------

/**
 * One LiteAudio with TWO buses: 'world' (positional, via createBus - the
 * constructor never pre-declares it, so createBus is the sole creator) and
 * 'flat' (default stereo). Both get a sound and are unlocked. Returns handles
 * to play voices on demand.
 */
async function buildEngine(capacity = 4) {
    const ctx = createMockContext({ state: 'suspended' });
    const win = fakeWindow();
    const audio = new LiteAudio({
        buses: [],
        poolCapacity: capacity,
        window: win,
        document: mockDocument(),
        fetch: mockFetch({ '/s.wav': 500 }),
        // A positional bus arms the shared monitor timer (_startMonitor). No-op
        // timers keep this a hand-driven mock, same as torture.mjs: real
        // setTimeout would leave a live handle on the event loop after the
        // test ends, since only destroy() (not every test here) clears it.
        setTimeout: () => 0,
        clearTimeout: () => {},
    });
    await audio.init(ctx);
    audio.createBus('world', { spatial: 'positional' });
    audio.createBus('flat'); // default: stereo
    await audio.defineSounds({
        ping: { src: ['/s.wav'], bus: 'world' },
        beep: { src: ['/s.wav'], bus: 'flat' },
    });
    win._fire('touchstart');
    await flushMicrotasks(8);
    return { audio, ctx, win };
}

function targetEvents(param) {
    return param.events.filter((e) => e[0] === 'target');
}

// ---------- 1. positional vs stereo voice shape -----------------------------

describe('createBus spatial mode -> voice node shape', () => {
    it('positional bus builds PannerNode voices (positionX present)', async () => {
        const { audio } = await buildEngine(4);
        const h = audio.play('ping');
        assert.ok(h >= 0, 'ping should play');
        const pool = audio._buses.get('world').pool;
        const node = pool.voiceNode(h >>> 0);
        assert.ok(node, 'live voice node');
        assert.notEqual(node.positionX, undefined, 'positional voice has positionX');
        assert.notEqual(node.positionY, undefined, 'positional voice has positionY');
        assert.notEqual(node.positionZ, undefined, 'positional voice has positionZ');
    });

    it('a plain/stereo bus builds voices with NO positionX', async () => {
        const { audio } = await buildEngine(4);
        const h = audio.play('beep');
        assert.ok(h >= 0, 'beep should play');
        const pool = audio._buses.get('flat').pool;
        const node = pool.voiceNode(h >>> 0);
        assert.ok(node, 'live voice node');
        assert.equal(node.positionX, undefined, 'stereo voice has no positionX');
    });
});

// ---------- 2. unknown spatial fails closed ---------------------------------

describe('createBus unknown spatial value', () => {
    it('throws RangeError instead of silently degrading to stereo', async () => {
        const { audio } = await buildEngine(4);
        assert.throws(
            () => audio.createBus('bogus-bus', { spatial: 'bogus' }),
            RangeError,
        );
        // Fail closed means the bus was never created at all.
        assert.equal(audio._buses.has('bogus-bus'), false);
    });
});

// ---------- 3. setPosition boundary matrix: silent no-ops ------------------

describe('setPosition fail-closed no-ops', () => {
    it('is a silent no-op on every bad-handle shape, and touches nothing', async () => {
        const capacity = 4;
        const { audio } = await buildEngine(capacity);

        // A live positional voice we can use as a "did anything leak onto it"
        // canary - none of the bad calls below name this handle, so if any of
        // them corrupt shared state (wrong bus resolution, wrong channel math)
        // it would show up here.
        const live = audio.play('ping');
        assert.ok(live >= 0);
        const worldPool = audio._buses.get('world').pool;
        const liveNode = worldPool.voiceNode(live >>> 0);
        assert.ok(liveNode, 'canary voice is live');

        const beep = audio.play('beep');
        assert.ok(beep >= 0);

        const worldIndex = audio._buses.get('world').index;

        const badHandles = [
            ['non-integer (1.5)', 1.5],
            ['NaN', NaN],
            ['undefined', undefined],
            ['null', null],
            ['negative (-1)', -1],
            ['bus index does not exist', 999 * BUS_STRIDE],
            ['stereo-bus handle (scratch is null)', beep],
            ['channel >= capacity', worldIndex * BUS_STRIDE + (capacity + 5)],
        ];

        for (const [label, bad] of badHandles) {
            assert.doesNotThrow(
                () => audio.setPosition(bad, 1, 2, 3),
                `setPosition must not throw on: ${label}`,
            );
        }

        audio._flushPositions();

        // None of the bad calls should have dirtied or written the canary
        // voice's params.
        assert.equal(targetEvents(liveNode.positionX).length, 0, 'canary positionX untouched');
        assert.equal(targetEvents(liveNode.positionY).length, 0, 'canary positionY untouched');
        assert.equal(targetEvents(liveNode.positionZ).length, 0, 'canary positionZ untouched');

        // And the stereo voice (which has no positionX at all) proves the
        // stereo-bus no-op never tried to write through a missing param.
        const flatPool = audio._buses.get('flat').pool;
        const flatNode = flatPool.voiceNode(beep >>> 0);
        assert.equal(flatNode.positionX, undefined);
    });

    it('empty scratch: a positional bus with no pool built yet is a no-op', async () => {
        // createBus builds the bus record and its spatial flag; the position
        // scratch (posXYZ/posOwner/posDirty) is allocated later, at pool build
        // time inside defineSounds(). Between those two calls the bus is
        // "empty": positional but with no scratch yet. setPosition must still
        // fail closed here, not throw on a null array.
        const ctx = createMockContext({ state: 'suspended' });
        const win = fakeWindow();
        const audio = new LiteAudio({
            buses: [],
            poolCapacity: 4,
            window: win,
            document: mockDocument(),
            fetch: mockFetch({}),
            setTimeout: () => 0,
            clearTimeout: () => {},
        });
        await audio.init(ctx);
        audio.createBus('world', { spatial: 'positional' });
        assert.equal(audio._buses.get('world').posDirty, null, 'scratch not built yet');
        assert.doesNotThrow(() => audio.setPosition(0, 1, 2, 3));
        assert.doesNotThrow(() => audio._flushPositions());
    });
});

// ---------- 4. happy path: end-to-end wiring --------------------------------

describe('setPosition happy path', () => {
    it('stamps scratch, and the next flush writes the exact value via setTargetAtTime', async () => {
        const { audio } = await buildEngine(4);
        const h = audio.play('ping');
        assert.ok(h >= 0);
        const pool = audio._buses.get('world').pool;
        const node = pool.voiceNode(h >>> 0);

        audio.setPosition(h, 3, 5, 7);
        // No param write yet - it is scratch + a dirty bit until the flush.
        assert.equal(targetEvents(node.positionX).length, 0, 'no write before flush');

        audio._flushPositions();

        const xEvents = targetEvents(node.positionX);
        const yEvents = targetEvents(node.positionY);
        const zEvents = targetEvents(node.positionZ);
        assert.equal(xEvents.length, 1, 'exactly one positionX write');
        assert.equal(yEvents.length, 1, 'exactly one positionY write');
        assert.equal(zEvents.length, 1, 'exactly one positionZ write');
        assert.equal(xEvents[0][1], 3, 'positionX got the stamped x');
        assert.equal(yEvents[0][1], 5, 'positionY got the stamped y');
        assert.equal(zEvents[0][1], 7, 'positionZ got the stamped z');
    });
});

// ---------- 5. steal-safety --------------------------------------------------

describe('steal-safety', () => {
    it('a channel stolen after setPosition gets zero stale writes on the new voice', async () => {
        const capacity = 4;
        const { audio } = await buildEngine(capacity);
        const pool = audio._buses.get('world').pool;

        // Fill every channel.
        const handles = [];
        for (let i = 0; i < capacity; i++) {
            const h = audio.play('ping');
            assert.ok(h >= 0);
            handles.push(h);
        }

        const victim = handles[0]; // channel 0
        audio.setPosition(victim, 9, 9, 9);

        // No free channel left: this steals the oldest (channel 0).
        const thief = audio.play('ping');
        assert.ok(thief >= 0);
        assert.equal((thief >>> 0) & 0xFF, 0, 'the steal reused channel 0');
        assert.equal(audio.isPlaying(victim), false, 'victim handle is stale after the steal');

        audio._flushPositions();

        const thiefNode = pool.voiceNode(thief >>> 0);
        assert.ok(thiefNode, 'thief voice is alive');
        assert.equal(
            targetEvents(thiefNode.positionX).length, 0,
            'the new voice on the stolen channel got zero position writes',
        );
        assert.equal(targetEvents(thiefNode.positionY).length, 0);
        assert.equal(targetEvents(thiefNode.positionZ).length, 0);
    });
});

// ---------- 6. destroy() teardown -------------------------------------------

describe('destroy() and positional scratch', () => {
    it('nulls posXYZ/posOwner/posDirty and is idempotent', async () => {
        const { audio } = await buildEngine(4);
        const busRec = audio._buses.get('world');
        assert.ok(busRec.posXYZ, 'scratch allocated before destroy');
        assert.ok(busRec.posOwner, 'scratch allocated before destroy');
        assert.ok(busRec.posDirty, 'scratch allocated before destroy');

        audio.destroy();
        assert.equal(busRec.posXYZ, null);
        assert.equal(busRec.posOwner, null);
        assert.equal(busRec.posDirty, null);

        assert.doesNotThrow(() => audio.destroy(), 'second destroy() must not throw');
        // A stray setPosition after destroy is still a no-op, not a crash.
        assert.doesNotThrow(() => audio.setPosition(0, 1, 2, 3));
    });
});

// ---------- extra: boundary values the numbered list above did not name ----

describe('extra boundary coverage', () => {
    it('re-entrant setPosition on the same handle before a flush coalesces to the LAST write', async () => {
        const { audio } = await buildEngine(4);
        const h = audio.play('ping');
        const node = audio._buses.get('world').pool.voiceNode(h >>> 0);

        audio.setPosition(h, 1, 1, 1);
        audio.setPosition(h, 2, 2, 2); // re-entrant write to the same dirty slot
        audio._flushPositions();

        const xEvents = targetEvents(node.positionX);
        assert.equal(xEvents.length, 1, 'only ONE native write reaches the param, not two');
        assert.equal(xEvents[0][1], 2, 'the flushed value is the LAST stamp, not the first');
    });

    it('-0 is accepted as handle 0 (Number.isInteger(-0) is true, -0 < 0 is false)', async () => {
        // Not a foot-gun in practice (bus 0's first voice IS generation 0,
        // channel 0), but the fail-closed guard is `!Number.isInteger(h) ||
        // h < 0`, and -0 satisfies neither, so it must behave exactly like a
        // literal 0 rather than throwing or silently misrouting.
        const { audio } = await buildEngine(4);
        const h = audio.play('ping');
        assert.equal(h, 0, 'first voice on the first bus is handle 0');
        const node = audio._buses.get('world').pool.voiceNode(h >>> 0);

        assert.doesNotThrow(() => audio.setPosition(-0, 4, 5, 6));
        audio._flushPositions();
        const xEvents = targetEvents(node.positionX);
        assert.equal(xEvents.length, 1, '-0 stamped the same slot as handle 0');
        assert.equal(xEvents[0][1], 4);
    });
});
