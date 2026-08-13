/**
 * @zakkster/lite-audio - construct-time poolCapacity fail-closed guard (S8, B).
 *
 * A pool channel packs into the low 8 bits of a handle (poolHandle & 0xFF,
 * decision 0001), so a pool can address at most 256 channels. A poolCapacity
 * past 256 would wrap channel 256 onto channel 0 and silently overwrite channel
 * 0's scratch; a non-integer or sub-1 capacity is nonsense. The constructor
 * fails closed on all of these (null is not zero: Number.isInteger rejects NaN
 * and non-integers before the range test). This file pins that contract -- it
 * runs entirely at construction time, so no context/init is needed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LiteAudio } from '../Audio.js';
import { mockDocument, mockFetch } from './mock-ctx.js';

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

/** Construct a LiteAudio with the given poolCapacity (undefined -> default). */
function construct(poolCapacity) {
    const opts = {
        buses: [], window: fakeWindow(), document: mockDocument(),
        fetch: mockFetch({}), setTimeout: () => 0, clearTimeout: () => {},
    };
    if (poolCapacity !== undefined) opts.poolCapacity = poolCapacity;
    return new LiteAudio(opts);
}

describe('poolCapacity guard: valid capacities construct', () => {
    it('poolCapacity 256 (the ceiling) constructs', () => {
        const audio = construct(256);
        assert.ok(audio instanceof LiteAudio);
    });

    it('poolCapacity 1 (the floor) constructs', () => {
        const audio = construct(1);
        assert.ok(audio instanceof LiteAudio);
    });

    it('default poolCapacity (undefined -> 32) constructs', () => {
        const audio = construct(undefined);
        assert.ok(audio instanceof LiteAudio);
    });
});

describe('poolCapacity guard: out-of-range capacities throw RangeError naming 256', () => {
    it('poolCapacity 257 (one past the ceiling) throws RangeError naming 256', () => {
        assert.throws(() => construct(257), (err) => {
            assert.ok(err instanceof RangeError, 'expected RangeError');
            assert.ok(err.message.includes('256'), 'message names the 256 ceiling');
            return true;
        });
    });

    it('poolCapacity 0 throws RangeError naming 256', () => {
        assert.throws(() => construct(0), (err) => {
            assert.ok(err instanceof RangeError, 'expected RangeError');
            assert.ok(err.message.includes('256'), 'message names the 256 ceiling');
            return true;
        });
    });

    it('poolCapacity -1 throws RangeError naming 256', () => {
        assert.throws(() => construct(-1), (err) => {
            assert.ok(err instanceof RangeError, 'expected RangeError');
            assert.ok(err.message.includes('256'), 'message names the 256 ceiling');
            return true;
        });
    });

    it('poolCapacity 1.5 (non-integer) throws RangeError naming 256', () => {
        assert.throws(() => construct(1.5), (err) => {
            assert.ok(err instanceof RangeError, 'expected RangeError');
            assert.ok(err.message.includes('256'), 'message names the 256 ceiling');
            return true;
        });
    });

    it('poolCapacity NaN throws RangeError naming 256', () => {
        assert.throws(() => construct(NaN), (err) => {
            assert.ok(err instanceof RangeError, 'expected RangeError');
            assert.ok(err.message.includes('256'), 'message names the 256 ceiling');
            return true;
        });
    });
});
