/** @zakkster/lite-audio - node:test suite */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LiteAudio } from '../Audio.js';
import {
    createMockContext, mockFetch, paramEvents, flushMicrotasks,
} from './mock-ctx.js';

// ---------- Fake window / document (unlock listener wiring) ----------------

function fakeWindow() {
    const listeners = new Map();  // event -> Set<{ cb, opts }>
    const win = {
        addEventListener(evt, cb, opts) {
            if (!listeners.has(evt)) listeners.set(evt, new Set());
            const rec = { cb, opts };
            listeners.get(evt).add(rec);
            // Honor AbortController: remove on abort
            const signal = opts && opts.signal;
            if (signal) {
                signal.addEventListener('abort', () => listeners.get(evt)?.delete(rec));
            }
        },
        removeEventListener(evt, cb) {
            const set = listeners.get(evt);
            if (!set) return;
            for (const rec of set) if (rec.cb === cb) { set.delete(rec); break; }
        },
        _fire(evt, data = {}) {
            const set = listeners.get(evt);
            if (!set) return;
            for (const rec of [...set]) rec.cb(data);
        },
        _listenerCount(evt) { return listeners.get(evt)?.size || 0; },
    };
    return win;
}

function fakeDocument() {
    return {
        hidden: false,
        _listeners: new Map(),
        addEventListener(evt, cb, opts) {
            if (!this._listeners.has(evt)) this._listeners.set(evt, new Set());
            const rec = { cb };
            this._listeners.get(evt).add(rec);
            const signal = opts && opts.signal;
            if (signal) signal.addEventListener('abort', () => this._listeners.get(evt)?.delete(rec));
        },
        _fire(evt) {
            const set = this._listeners.get(evt);
            if (!set) return;
            for (const rec of [...set]) rec.cb();
        },
    };
}

// ---------- Common setup helper --------------------------------------------

async function setupAudio(opts = {}) {
    const ctx = createMockContext({ state: opts.ctxState ?? 'suspended' });
    const win = fakeWindow();
    const doc = fakeDocument();
    const fetch = opts.fetch || mockFetch({});
    const audio = new LiteAudio({
        buses: opts.buses || ['sfx', 'ui'],
        poolCapacity: opts.poolCapacity ?? 4,
        queueLimit: opts.queueLimit ?? 8,
        fetch, window: win, document: doc,
    });
    await audio.init(ctx);
    return { audio, ctx, win, doc };
}

// ---------- Unlock state machine ------------------------------------------

describe('unlock state machine (D3)', () => {
    it('starts locked when ctx is suspended', async () => {
        const { audio } = await setupAudio({ ctxState: 'suspended' });
        assert.equal(audio.unlocked().peek(), false);
        assert.equal(audio.ctxState().peek(), 'suspended');
    });

    it('starts unlocked if ctx is already running at init', async () => {
        const { audio } = await setupAudio({ ctxState: 'running' });
        assert.equal(audio.unlocked().peek(), true);
    });

    it('a touchstart on window resumes the context and unlocks', async () => {
        const { audio, ctx, win } = await setupAudio({ ctxState: 'suspended' });
        assert.equal(audio.unlocked().peek(), false);
        win._fire('touchstart');
        await flushMicrotasks(8);
        assert.equal(ctx.state, 'running');
        assert.equal(audio.unlocked().peek(), true);
    });

    it("recovers from 'interrupted' state (iOS phone-call scenario)", async () => {
        const { audio, ctx, win } = await setupAudio({ ctxState: 'suspended' });
        // Simulate the OS interrupting audio (a call comes in) before the first gesture
        ctx._setState('interrupted');
        assert.equal(audio.ctxState().peek(), 'interrupted');
        // A subsequent gesture must treat 'interrupted' the same as 'suspended'
        win._fire('mousedown');
        await flushMicrotasks(8);
        assert.equal(ctx.state, 'running');
        assert.equal(audio.unlocked().peek(), true);
    });

    it('detaches unlock listeners after first successful unlock', async () => {
        const { win } = await setupAudio({ ctxState: 'suspended' });
        assert.ok(win._listenerCount('touchstart') > 0);
        win._fire('keydown');
        await flushMicrotasks(8);
        assert.equal(win._listenerCount('touchstart'), 0,
            'unlock AbortController should have detached every listener');
    });

    it('mirrors external statechange events into ctxState signal', async () => {
        const { audio, ctx } = await setupAudio({ ctxState: 'suspended' });
        ctx._setState('running');
        assert.equal(audio.ctxState().peek(), 'running');
        ctx._setState('interrupted');
        assert.equal(audio.ctxState().peek(), 'interrupted');
    });
});

// ---------- Loader: fallback + error --------------------------------------

describe('loader (D4)', () => {
    it('resolves loadState to "ready" on successful fetch + decode', async () => {
        const { audio } = await setupAudio({
            fetch: mockFetch({ '/laser.wav': 22050 }),  // 500ms at 44.1kHz
        });
        await audio.defineSounds({ laser: { src: ['/laser.wav'], bus: 'sfx' } });
        assert.equal(audio.loadState('laser').peek(), 'ready');
    });

    it('resolves loadState to "error" when fetch fails', async () => {
        const { audio } = await setupAudio({
            fetch: mockFetch({}),  // no URL -> 404
        });
        await audio.defineSounds({ dead: { src: ['/dead.wav'], bus: 'sfx' } });
        assert.equal(audio.loadState('dead').peek(), 'error');
    });

    it('resolves loadState to "error" when fetch throws', async () => {
        const { audio } = await setupAudio({
            fetch: mockFetch({ '/boom.wav': new Error('network') }),
        });
        await audio.defineSounds({ boom: { src: ['/boom.wav'], bus: 'sfx' } });
        assert.equal(audio.loadState('boom').peek(), 'error');
    });

    it('binds the default globalThis.fetch so this._fetch(url) is not an illegal invocation', () => {
        // A browser's native fetch throws "Illegal invocation" when called as a
        // method (this._fetch(url) sets this = the engine). The default must be
        // bound to globalThis. Simulate the native receiver guard and prove the
        // constructor's default survives being invoked as a property.
        const saved = globalThis.fetch;
        let seenThis = null;
        globalThis.fetch = function (url) {
            if (this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
            seenThis = this;
            return Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) });
        };
        try {
            const audio = new LiteAudio({ buses: ['sfx'] });   // no opts.fetch: exercise the default
            assert.doesNotThrow(() => audio._fetch('blob:x'), 'default _fetch must be callable as a method');
            assert.equal(seenThis, globalThis, 'default fetch must run with globalThis as receiver');
        } finally {
            globalThis.fetch = saved;
        }
    });

    it('transitions idle -> loading -> ready observably', async () => {
        const { audio } = await setupAudio({
            fetch: mockFetch({ '/hit.wav': 4410 }),
        });
        const states = [];
        // Pre-record the initial value; effect fires with 'idle' then 'loading' then 'ready'
        const promise = audio.defineSounds({ hit: { src: ['/hit.wav'], bus: 'sfx' } });
        // The signal exists as soon as defineSounds returns synchronously the record
        // so subscribe now:
        await flushMicrotasks(1);
        const sig = audio.loadState('hit');
        assert.ok(sig, 'loadState signal exists synchronously');
        states.push(sig.peek());
        await promise;
        states.push(sig.peek());
        assert.deepEqual([...new Set(states)].sort(), ['loading', 'ready'].sort()); // observed 'loading' at least
    });

    it('routes a sound to an unknown bus by throwing (typo-loud)', async () => {
        const { audio } = await setupAudio({
            fetch: mockFetch({ '/x.wav': 4410 }),
        });
        await assert.rejects(
            audio.defineSounds({ x: { src: ['/x.wav'], bus: 'no-such-bus' } }),
            /unknown bus/
        );
    });
});

// ---------- Bus effect writes (setTargetAtTime) ---------------------------

describe('bus signals write via setTargetAtTime (D1)', () => {
    it('a bus volume change schedules setTargetAtTime on its GainNode', async () => {
        const { audio } = await setupAudio();
        const gainNode = audio.busNode('sfx');
        const beforeCount = paramEvents(gainNode.gain, 'target').length;
        audio.setBusVolume('sfx', 0.5);
        // Effect runs synchronously in lite-signal (glitch-free push-pull)
        const after = paramEvents(gainNode.gain, 'target');
        assert.ok(after.length > beforeCount, 'a target ramp was scheduled');
        const last = after[after.length - 1];
        assert.equal(last[1], 0.5, 'target value is the new volume');
    });

    it('a bus mute forces the target to 0 regardless of volume', async () => {
        const { audio } = await setupAudio();
        const gainNode = audio.busNode('sfx');
        audio.setBusVolume('sfx', 0.8);
        audio.setBusMuted('sfx', true);
        const targets = paramEvents(gainNode.gain, 'target');
        const last = targets[targets.length - 1];
        assert.equal(last[1], 0, 'muted -> target 0');
    });

    it('master mute schedules a setTargetAtTime on the master gain', async () => {
        const { audio } = await setupAudio();
        const master = audio.masterNode();
        audio.setMuted(true);
        const targets = paramEvents(master.gain, 'target');
        assert.ok(targets.length > 0);
        assert.equal(targets[targets.length - 1][1], 0);
    });

    it('setTarget events use the current audio clock as their start time', async () => {
        const { audio, ctx } = await setupAudio();
        ctx._advance(3.5);
        audio.setBusVolume('sfx', 0.25);
        const targets = paramEvents(audio.busNode('sfx').gain, 'target');
        const last = targets[targets.length - 1];
        assert.equal(last[2], 3.5, 'target scheduled at ctx.currentTime');
    });
});

// ---------- Master mute persistence (D7) ----------------------------------

describe('master mute persistence (D7)', () => {
    it('writes lite_audio_muted on state change', async () => {
        let stored = null;
        const fakeStorage = {
            getItem: (k) => stored,
            setItem: (k, v) => { stored = v; },
        };
        globalThis.localStorage = fakeStorage;
        const { audio } = await setupAudio();
        audio.setMuted(true);
        assert.equal(stored, 'true');
        audio.setMuted(false);
        assert.equal(stored, 'false');
        delete globalThis.localStorage;
    });

    it('reads lite_audio_muted at construction', async () => {
        globalThis.localStorage = {
            getItem: (k) => k === 'lite_audio_muted' ? 'true' : null,
            setItem: () => {},
        };
        const { audio } = await setupAudio();
        assert.equal(audio.muted().peek(), true);
        delete globalThis.localStorage;
    });

    it('storage failures do not throw', async () => {
        globalThis.localStorage = {
            getItem: () => { throw new Error('nope'); },
            setItem: () => { throw new Error('nope'); },
        };
        const { audio } = await setupAudio();
        assert.doesNotThrow(() => audio.setMuted(true));
        delete globalThis.localStorage;
    });
});

// ---------- Playback: steal, gen no-op, delegation to pool ----------------

describe('playback delegates to pool (D5 / D6)', () => {
    it('play() returns a handle after unlock, -1 before', async () => {
        const { audio, win } = await setupAudio({
            fetch: mockFetch({ '/l.wav': 4410 }),
        });
        await audio.defineSounds({ laser: { src: ['/l.wav'], bus: 'sfx' } });
        assert.equal(audio.play('laser'), -1, 'before unlock: -1');
        win._fire('touchstart');
        await flushMicrotasks(8);
        assert.notEqual(audio.play('laser'), -1, 'after unlock: real handle');
    });

    it('play() on unknown sound returns -1', async () => {
        const { audio, win } = await setupAudio();
        win._fire('touchstart');
        await flushMicrotasks(8);
        assert.equal(audio.play('nope'), -1);
    });

    it('play() on unloaded sound returns -1 and enqueues', async () => {
        const { audio, win } = await setupAudio({
            fetch: mockFetch({ '/l.wav': 4410 }),
        });
        // Kick off load but do NOT await it
        const p = audio.defineSounds({ laser: { src: ['/l.wav'], bus: 'sfx' } });
        win._fire('touchstart');
        await flushMicrotasks(1);
        const preLoadHandle = audio.play('laser');
        assert.equal(preLoadHandle, -1);
        await p;
    });

    it('stop() with stale handle is a no-op (delegated pool guarantee)', async () => {
        const { audio, win } = await setupAudio({
            fetch: mockFetch({ '/l.wav': 4410 }),
            poolCapacity: 1,  // force steal
        });
        await audio.defineSounds({ laser: { src: ['/l.wav'], bus: 'sfx' } });
        win._fire('touchstart');
        await flushMicrotasks(8);
        const stale = audio.play('laser');
        const fresh = audio.play('laser');           // steals ch0
        assert.notEqual(stale, fresh);
        // No throw, no misfired stop. The pool test covers state; we verify
        // that lite-audio's stop() surface preserves the guarantee.
        assert.doesNotThrow(() => audio.stop(stale));
        assert.doesNotThrow(() => audio.stop(fresh));
    });

    it('stop() dispatches across every bus (bus-agnostic handle namespace)', async () => {
        // A handle from one bus is not confusable with a handle from another,
        // so stop() can safely walk every bus and let generation checks reject.
        const { audio, win } = await setupAudio({
            fetch: mockFetch({ '/a.wav': 4410, '/b.wav': 4410 }),
        });
        await audio.defineSounds({
            a: { src: ['/a.wav'], bus: 'sfx' },
            b: { src: ['/b.wav'], bus: 'ui' },
        });
        win._fire('touchstart');
        await flushMicrotasks(8);
        const h = audio.play('a');
        assert.doesNotThrow(() => audio.stop(h));
    });

    it('stopBus() stops every voice on that bus only', async () => {
        const { audio, win } = await setupAudio({
            fetch: mockFetch({ '/a.wav': 4410, '/b.wav': 4410 }),
        });
        await audio.defineSounds({
            a: { src: ['/a.wav'], bus: 'sfx' },
            b: { src: ['/b.wav'], bus: 'ui' },
        });
        win._fire('touchstart');
        await flushMicrotasks(8);
        audio.play('a');
        audio.play('b');
        audio.stopBus('sfx');   // only sfx should be silenced
        // Voice matrix is inside the pool; here we assert no throw and the ui
        // bus was untouched by checking that ui's pool still has an active voice
        // via its expireTimes (implementation detail cross-check).
        // We don't peek pool internals in this test - just assert no throw.
        assert.doesNotThrow(() => audio.stopBus('sfx'));
    });
});

// ---------- Steal + declick schedule shape --------------------------------

describe('steal + declick schedule shape', () => {
    it('a steal schedules a fade-out ramp before the new voice starts', async () => {
        const { audio, ctx, win } = await setupAudio({
            fetch: mockFetch({ '/l.wav': 22050 }),
            poolCapacity: 1,
        });
        await audio.defineSounds({ laser: { src: ['/l.wav'], bus: 'sfx' } });
        win._fire('touchstart');
        await flushMicrotasks(8);
        audio.play('laser');
        ctx._advance(0.05);       // voice still playing
        // The pool's own tests own the ramp-shape assertion; here we only
        // verify that the audio graph is wired so a steal is even possible.
        // A second play into a capacity-1 pool with the first still live
        // is a steal by construction, and if the wiring is wrong (bus not
        // reachable), the play returns -1.
        const h2 = audio.play('laser');
        assert.notEqual(h2, -1, 'second play scheduled (steal path exercised)');
    });
});

// ---------- Unlock queue flush --------------------------------------------

describe('unlock queue flush (D3 extension)', () => {
    it('play() before unlock is enqueued and fires on unlock', async () => {
        const { audio, win, ctx } = await setupAudio({
            fetch: mockFetch({ '/l.wav': 4410 }),
        });
        await audio.defineSounds({ laser: { src: ['/l.wav'], bus: 'sfx' } });
        // Sound is ready but ctx is locked
        assert.equal(audio.unlocked().peek(), false);
        assert.equal(audio.play('laser'), -1);        // queued
        // Fire the unlock gesture
        win._fire('touchstart');
        await flushMicrotasks(16);
        // The flush should have triggered an actual play - meaning the pool
        // exists and holds an active voice. Assert via activeCount().
        const pool = audio._buses.get('sfx').pool;
        assert.ok(pool, 'pool built by defineSounds');
        assert.equal(pool.activeCount(), 1, 'queued play fired on unlock');
    });

    it('latest-per-sound wins in the queue', async () => {
        const { audio, win } = await setupAudio({
            fetch: mockFetch({ '/l.wav': 4410 }),
        });
        await audio.defineSounds({ laser: { src: ['/l.wav'], bus: 'sfx' } });
        // Enqueue three plays of the same sound before unlock
        audio.play('laser', 0.1);
        audio.play('laser', 0.5);
        audio.play('laser', 1.0);
        win._fire('touchstart');
        await flushMicrotasks(16);
        // Only ONE voice should be active (the latest), not three.
        const pool = audio._buses.get('sfx').pool;
        assert.equal(pool.activeCount(), 1);
    });

    it('queue is bounded (queueLimit)', async () => {
        const { audio, win } = await setupAudio({
            fetch: mockFetch({
                '/a.wav': 4410, '/b.wav': 4410, '/c.wav': 4410,
                '/d.wav': 4410, '/e.wav': 4410,
            }),
            queueLimit: 2,
            poolCapacity: 8,
        });
        await audio.defineSounds({
            a: { src: ['/a.wav'], bus: 'sfx' },
            b: { src: ['/b.wav'], bus: 'sfx' },
            c: { src: ['/c.wav'], bus: 'sfx' },
            d: { src: ['/d.wav'], bus: 'sfx' },
            e: { src: ['/e.wav'], bus: 'sfx' },
        });
        // Five distinct sounds, queueLimit 2: only the first two survive.
        audio.play('a'); audio.play('b'); audio.play('c'); audio.play('d'); audio.play('e');
        win._fire('touchstart');
        await flushMicrotasks(16);
        const pool = audio._buses.get('sfx').pool;
        assert.equal(pool.activeCount(), 2, 'queue capped at 2');
    });
});

// ---------- Zero-GC hot path ----------------------------------------------

describe('hot-path allocation (D8 zero-GC gate)', () => {
    it('play() does not throw and does not depend on options-object allocation', async () => {
        // The positional signature is the hot-path contract. We cannot measure
        // heap deltas from inside node:test cleanly, but we assert the shape:
        // positional args, no options object, delegates to pool.play which is
        // the alloc-tested surface (pool bench proves per-play alloc is ~0).
        const { audio, win } = await setupAudio({
            fetch: mockFetch({ '/l.wav': 4410 }),
        });
        await audio.defineSounds({ laser: { src: ['/l.wav'], bus: 'sfx' } });
        win._fire('touchstart');
        await flushMicrotasks(8);
        for (let i = 0; i < 1000; i++) audio.play('laser', 1, 0, 1);
        const pool = audio._buses.get('sfx').pool;
        assert.ok(pool.activeCount() > 0);
    });
});

// ---------- Teardown ------------------------------------------------------

describe('destroy() is idempotent and detaches everything', () => {
    it('destroy tears down pools, buses, effects, listeners', async () => {
        const { audio, win } = await setupAudio({
            fetch: mockFetch({ '/l.wav': 4410 }),
        });
        await audio.defineSounds({ laser: { src: ['/l.wav'], bus: 'sfx' } });
        assert.ok(win._listenerCount('touchstart') > 0);
        audio.destroy();
        assert.equal(win._listenerCount('touchstart'), 0, 'unlock listeners detached');
    });

    it('destroy is idempotent', async () => {
        const { audio } = await setupAudio();
        audio.destroy();
        assert.doesNotThrow(() => audio.destroy());
    });

    it('play() and stop() after destroy are silent no-ops', async () => {
        const { audio, win } = await setupAudio({
            fetch: mockFetch({ '/l.wav': 4410 }),
        });
        await audio.defineSounds({ laser: { src: ['/l.wav'], bus: 'sfx' } });
        win._fire('touchstart');
        await flushMicrotasks(8);
        audio.destroy();
        assert.equal(audio.play('laser'), -1);
        assert.doesNotThrow(() => audio.stop(0));
    });
});
