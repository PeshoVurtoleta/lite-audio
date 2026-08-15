/** @zakkster/lite-audio - reloadTrack(name) boundary suite (PS5 / v2.10.0)
 *
 * Pins the decision table in PS5_PLAN.md / decisions/0014-reload-track.md:
 * fail-closed preconditions (D1/D2), signal-identity reuse (D3/A1), the
 * fresh-element wire-failure recovery (D4/D5/A4), config reuse (D7), and the
 * destroyBus interaction (D6). The full 1e4-cycle retention loop + red
 * control live in test/torture.mjs tier T-TRK1 (A2); this file is the
 * correctness/fail-closed boundary matrix (qa owns both, per PS5_PLAN T8/T9).
 *
 * The wire-failure mock (sourceTrackingCtx) mirrors test/Tracks.test.js
 * :512-531 ("reused <audio> element" describe block); poisonedThenFreshDocument
 * is the reload-specific extension -- the FIRST element handed out is
 * pre-spent (so playTrack's first wire attempt fails closed into 'error'),
 * every element after that is fresh, which is what proves reloadTrack's
 * escape from the one-MediaElementSource-per-element trap (D4).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LiteAudio } from '../Audio.js';
import { effect } from '@zakkster/lite-signal';
import {
    createMockContext, mockFetch, mockDocument, mockScheduler, flushMicrotasks,
    mockAudioElement,
} from './mock-ctx.js';

// ---------------------------------------------------------------------------
// Harness (mirrors test/Tracks.test.js's boot()).
// ---------------------------------------------------------------------------

function fakeWindow() {
    const cbs = [];
    return {
        addEventListener(evt, cb) { cbs.push(cb); },
        removeEventListener() {},
        fire() { for (const cb of [...cbs]) cb({}); },
    };
}

async function boot({ unlock = true, tracks, buses = ['sfx', 'music'] } = {}) {
    const ctx = createMockContext({ state: 'suspended' });
    const win = fakeWindow();
    const doc = mockDocument();
    const clock = mockScheduler();

    const audio = new LiteAudio({
        buses,
        poolCapacity: 4,
        window: win,
        document: doc,
        fetch: mockFetch({ '/laser.wav': 500 }),
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
    });

    await audio.init(ctx);
    await audio.defineTracks(tracks ?? {
        theme: { src: ['/theme.mp3'], bus: 'music', volume: 0.8 },
        boss: { src: ['/boss.mp3'], bus: 'music' },
    });

    if (unlock) {
        win.fire();
        await flushMicrotasks(8);
    }

    const rec = (name) => audio._tracks.get(name);
    return { audio, ctx, doc, clock, win, rec };
}

/** A context that records createMediaElementSource calls and, optionally,
 *  enforces the spec's one-source-per-element rule by throwing on reuse.
 *  Mirrors test/Tracks.test.js:514-531. */
function sourceTrackingCtx({ throwOnReuse = false } = {}) {
    const ctx = createMockContext({ state: 'suspended' });
    const sourced = new Set();
    let calls = 0;
    const orig = ctx.createMediaElementSource;
    ctx.createMediaElementSource = (el) => {
        calls++;
        if (throwOnReuse && sourced.has(el)) {
            const e = new Error('createMediaElementSource: element already connected');
            e.name = 'InvalidStateError';
            throw e;
        }
        sourced.add(el);
        return orig(el);
    };
    ctx._mesCalls = () => calls;
    return ctx;
}

/** A document whose FIRST created <audio> is the caller-supplied (pre-spent)
 *  element; every createElement call after that mints a brand-new one. This
 *  is the reload-specific extension of Tracks.test.js's reusingDocument (which
 *  always hands back the SAME element forever, useful for proving a lazy
 *  re-init trap but not for proving reloadTrack's fresh-element ESCAPE from
 *  it). Modeling a host that handed lite-audio one already-sourced element
 *  once, then mints fresh ones normally. */
function poisonedThenFreshDocument(spentEl) {
    const created = [];
    let first = true;
    return {
        hidden: false,
        created,
        createElement(tag) {
            if (tag !== 'audio') throw new Error('poisonedThenFreshDocument: unexpected <' + tag + '>');
            if (first) { first = false; created.push(spentEl); return spentEl; }
            const el = mockAudioElement();
            created.push(el);
            return el;
        },
        addEventListener() {},
        removeEventListener() {},
    };
}

// ---------------------------------------------------------------------------

describe('reloadTrack: fail-closed preconditions', () => {
    it('1. destroyed engine throws (defineTracks parity)', async () => {
        const { audio } = await boot();
        audio.destroy();
        assert.throws(() => audio.reloadTrack('theme'), /LiteAudio: destroyed/);
    });

    it('2. uninitialized engine throws (defineTracks parity)', () => {
        const audio = new LiteAudio({
            buses: ['music'], window: fakeWindow(), document: mockDocument(), fetch: mockFetch({}),
        });
        assert.throws(() => audio.reloadTrack('theme'), /LiteAudio: init\(\) before reloadTrack\(\)/);
    });
});

describe('reloadTrack: name boundary matrix', () => {
    it('3. unknown name returns false; no rec is created', async () => {
        const { audio } = await boot();
        const before = audio._tracks.size;
        assert.equal(audio.reloadTrack('nope'), false);
        assert.equal(audio._tracks.size, before);
        assert.equal(audio._tracks.has('nope'), false);
    });

    it('empty string name returns false', async () => {
        const { audio } = await boot();
        assert.equal(audio.reloadTrack(''), false);
    });

    it('4. null name returns false', async () => {
        const { audio } = await boot();
        assert.equal(audio.reloadTrack(null), false);
    });

    it('undefined name (and a no-arg call) returns false', async () => {
        const { audio } = await boot();
        assert.equal(audio.reloadTrack(undefined), false);
        assert.equal(audio.reloadTrack(), false);
    });

    it('NaN name returns false', async () => {
        const { audio } = await boot();
        assert.equal(audio.reloadTrack(NaN), false);
    });

    it('-0 name returns false', async () => {
        const { audio } = await boot();
        assert.equal(audio.reloadTrack(-0), false);
    });

    it('5. non-string name (number, plain object, array, boolean) returns false', async () => {
        const { audio } = await boot();
        assert.equal(audio.reloadTrack(42), false);
        assert.equal(audio.reloadTrack({}), false);
        assert.equal(audio.reloadTrack(['theme']), false);
        assert.equal(audio.reloadTrack(true), false);
    });

    it('adversarial: a boxed String object must not slip past the string guard', async () => {
        const { audio, rec } = await boot();
        const boxed = new String('theme');
        assert.equal(typeof boxed, 'object', 'sanity: boxed String is not typeof "string"');
        assert.equal(audio.reloadTrack(boxed), false);
        assert.equal(rec('theme').loadState.peek(), 'ready', 'the real "theme" track is untouched');
    });
});

describe('reloadTrack: state-precondition decision table', () => {
    it('6. reload from "error" (bad-src path) returns true and drives loadState onward', async () => {
        const { audio, doc } = await boot({ tracks: { silent: { src: [], bus: 'music' } } });
        assert.equal(audio.trackLoadState('silent').peek(), 'error');

        const before = doc.created.length;
        const reloaded = audio.reloadTrack('silent');
        assert.equal(reloaded, true);
        assert.equal(audio.trackLoadState('silent').peek(), 'error', 'still no source to resolve -- stays error');
        assert.equal(doc.created.length, before, 'no element is ever built for an unresolvable src');
    });

    it('7. reload from "error" caused by a WIRE FAILURE builds a FRESH element and reaches ready (the crux)', async () => {
        const win = fakeWindow();
        const ctx = sourceTrackingCtx({ throwOnReuse: true });
        const spentEl = mockAudioElement();
        ctx.createMediaElementSource(spentEl);   // pre-poison: some earlier session already sourced this element
        const doc = poisonedThenFreshDocument(spentEl);
        const audio = new LiteAudio({ buses: ['music'], window: win, document: doc, fetch: mockFetch({}) });
        await audio.init(ctx);
        await audio.defineTracks({ theme: { src: ['/theme.mp3'], bus: 'music' } });
        win.fire();
        await flushMicrotasks(8);

        assert.equal(audio.trackLoadState('theme').peek(), 'ready', 'load settles ready -- wiring is deferred to play');
        assert.equal(audio._tracks.get('theme').element, spentEl);

        assert.doesNotThrow(() => audio.playTrack('theme'));
        assert.equal(audio.trackLoadState('theme').peek(), 'error', 'wiring the spent element failed closed');
        assert.equal(audio.trackPlaying('theme').peek(), false);
        assert.equal(audio._tracks.get('theme').source, null);

        const loadStateBefore = audio.trackLoadState('theme');
        const playingBefore = audio.trackPlaying('theme');
        const before = doc.created.length;

        const reloaded = audio.reloadTrack('theme');
        assert.equal(reloaded, true);
        assert.equal(doc.created.length, before + 1, 'a fresh element was built');
        const freshEl = audio._tracks.get('theme').element;
        assert.notEqual(freshEl, spentEl, 'the new element is not the spent one');
        assert.equal(audio.trackLoadState('theme').peek(), 'ready', 'the fresh element escapes the trap');
        assert.equal(audio.trackLoadState('theme'), loadStateBefore, 'signal identity preserved (A1)');
        assert.equal(audio.trackPlaying('theme'), playingBefore, 'signal identity preserved (A1)');

        // Prove the fresh element really wires and plays -- the trap is really escaped.
        assert.doesNotThrow(() => audio.playTrack('theme'));
        assert.equal(audio.trackLoadState('theme').peek(), 'ready');
        assert.equal(audio.trackPlaying('theme').peek(), true);
        assert.equal(audio._tracks.get('theme').source.mediaElement, freshEl);
    });

    it('8. reload from "idle" returns true and builds the track', async () => {
        const { audio, doc } = await boot({ tracks: {} });
        // Construct a rec directly (bypassing defineTracks' synchronous _loadTrack)
        // so loadState is genuinely stuck at 'idle', the state the decision table
        // names explicitly.
        const rec = audio._makeTrackRecord('stuck', { src: ['/stuck.mp3'] }, 'music');
        audio._tracks.set('stuck', rec);
        audio._trackList.push(rec);
        assert.equal(rec.loadState.peek(), 'idle');

        const before = doc.created.length;
        const reloaded = audio.reloadTrack('stuck');
        assert.equal(reloaded, true);
        assert.equal(doc.created.length, before + 1);
        assert.equal(audio.trackLoadState('stuck').peek(), 'ready');
    });

    it('9. reload from "ready" (not playing) refuses -- nothing to recover', async () => {
        const { audio, rec } = await boot();
        assert.equal(audio.trackLoadState('theme').peek(), 'ready');
        const t = rec('theme');
        const before = { element: t.element, source: t.source, srcs: t.srcs, busName: t.busName };

        const reloaded = audio.reloadTrack('theme');
        assert.equal(reloaded, false);
        assert.equal(t.element, before.element);
        assert.equal(t.source, before.source);
        assert.equal(t.srcs, before.srcs);
        assert.equal(t.busName, before.busName);
        assert.equal(audio.trackLoadState('theme').peek(), 'ready');
    });

    it('10. reload while "loading" refuses -- races the in-flight load', async () => {
        const { audio, rec, doc } = await boot();
        const t = rec('theme');
        t.loadState.set('loading');

        const before = doc.created.length;
        const reloaded = audio.reloadTrack('theme');
        assert.equal(reloaded, false);
        assert.equal(doc.created.length, before, 'no element touched while a load races');
        assert.equal(t.loadState.peek(), 'loading', 'state untouched by the refused call');
    });

    it('11. reload while playing refuses -- live graph untouched', async () => {
        const { audio, rec } = await boot();
        audio.playTrack('theme');
        const t = rec('theme');
        assert.equal(t.playing.peek(), true);
        const el = t.element, source = t.source, xfade = t.xfadeGain, vol = t.volumeGain;

        const reloaded = audio.reloadTrack('theme');
        assert.equal(reloaded, false);
        assert.equal(t.element, el);
        assert.equal(t.source, source);
        assert.equal(t.xfadeGain, xfade);
        assert.equal(t.volumeGain, vol);
        assert.equal(t.playing.peek(), true);
    });

    it('12. double reloadTrack back-to-back does not double-build the element; final state is consistent', async () => {
        const { audio, doc, rec } = await boot({ tracks: { churn: { src: ['/churn.mp3'], bus: 'music' } } });
        rec('churn').loadState.set('error');

        const before = doc.created.length;
        const first = audio.reloadTrack('churn');
        const second = audio.reloadTrack('churn');   // reentrant: the load already settled synchronously
        assert.equal(first, true);
        assert.equal(second, false, 'a second call right after the first refuses (no double element build)');
        assert.equal(doc.created.length, before + 1, 'exactly one new element built across both calls');
        assert.equal(audio.trackLoadState('churn').peek(), 'ready');
    });
});

describe('reloadTrack: signal identity + config reuse (A1/D3/D7)', () => {
    it('13. signal identity: trackLoadState/Playing/Position/Duration return the SAME object across reloads', async () => {
        const { audio, rec } = await boot({ tracks: { churn: { src: ['/c.mp3'], bus: 'music' } } });
        const t = rec('churn');
        const sigs = {
            loadState: audio.trackLoadState('churn'),
            playing: audio.trackPlaying('churn'),
            position: audio.trackPosition('churn'),
            duration: audio.trackDuration('churn'),
        };
        for (let i = 0; i < 2; i++) {
            t.loadState.set('error');
            assert.equal(audio.reloadTrack('churn'), true, 'cycle ' + i);
            assert.strictEqual(audio.trackLoadState('churn'), sigs.loadState, 'cycle ' + i);
            assert.strictEqual(audio.trackPlaying('churn'), sigs.playing, 'cycle ' + i);
            assert.strictEqual(audio.trackPosition('churn'), sigs.position, 'cycle ' + i);
            assert.strictEqual(audio.trackDuration('churn'), sigs.duration, 'cycle ' + i);
        }
    });

    it('14. config reuse: reloaded track keeps its original src/bus/volume/loop', async () => {
        const { audio, rec } = await boot({
            tracks: {
                churn: {
                    src: ['/c1.mp3', '/c2.mp3'], bus: 'music',
                    volume: 0.33, loop: true, loopStart: 1, loopEnd: 9,
                },
            },
        });
        const t = rec('churn');
        const before = {
            srcs: t.srcs, busName: t.busName, volume: t.volume,
            loop: t.loop, loopStart: t.loopStart, loopEnd: t.loopEnd,
        };

        t.loadState.set('error');
        assert.equal(audio.reloadTrack('churn'), true);
        assert.deepEqual(t.srcs, before.srcs);
        assert.equal(t.busName, before.busName);
        assert.equal(t.volume, before.volume);
        assert.equal(t.loop, before.loop);
        assert.equal(t.loopStart, before.loopStart);
        assert.equal(t.loopEnd, before.loopEnd);
    });

    it('N-cycle boundary sweep (1 / N-1 / N / N+1 reload calls): identity + config hold every cycle', async () => {
        const { audio, rec } = await boot({
            tracks: { churn: { src: ['/churn.mp3'], bus: 'music', volume: 0.42, loop: true } },
        });
        const t = rec('churn');
        const loadStateSig = audio.trackLoadState('churn');
        const playingSig = audio.trackPlaying('churn');
        const positionSig = audio.trackPosition('churn');
        const durationSig = audio.trackDuration('churn');

        const N = 4;   // exercises 1, N-1(=3), N(=4) as a monotone sweep
        for (let i = 1; i <= N; i++) {
            t.loadState.set('error');
            const reloaded = audio.reloadTrack('churn');
            assert.equal(reloaded, true, 'cycle ' + i);
            assert.strictEqual(audio.trackLoadState('churn'), loadStateSig, 'identity holds at cycle ' + i);
            assert.strictEqual(audio.trackPlaying('churn'), playingSig, 'identity holds at cycle ' + i);
            assert.strictEqual(audio.trackPosition('churn'), positionSig, 'identity holds at cycle ' + i);
            assert.strictEqual(audio.trackDuration('churn'), durationSig, 'identity holds at cycle ' + i);
            assert.equal(t.srcs[0], '/churn.mp3', 'src reused at cycle ' + i);
            assert.equal(t.busName, 'music', 'bus reused at cycle ' + i);
            assert.equal(t.volume, 0.42, 'volume reused at cycle ' + i);
            assert.equal(t.loop, true, 'loop reused at cycle ' + i);
            assert.equal(audio.trackLoadState('churn').peek(), 'ready', 'settles ready each cycle');
        }
        // N+1: the track is 'ready' now (never forced back to error) -- refuses.
        assert.equal(audio.reloadTrack('churn'), false, 'N+1: a ready track refuses reload');
    });
});

describe('reloadTrack: retention smoke (A2 spot check; the full 1e4-cycle soak is torture T-TRK1)', () => {
    it('15. N reload cycles release the spent element and build exactly one new one each time', async () => {
        const { audio, doc, rec } = await boot({ tracks: { churn: { src: ['/churn.mp3'], bus: 'music' } } });
        const N = 5;
        for (let i = 0; i < N; i++) {
            assert.equal(audio.trackLoadState('churn').peek(), 'ready', 'cycle ' + i);
            audio.playTrack('churn');
            const el = rec('churn').element;
            assert.ok(el._listenerCount('timeupdate') > 0, 'cycle ' + i + ': listeners attached');
            audio.stopTrack('churn', { fade: 0 });

            rec('churn').loadState.set('error');   // simulate an externally-detected error
            const before = doc.created.length;
            const reloaded = audio.reloadTrack('churn');
            assert.equal(reloaded, true, 'cycle ' + i);
            assert.equal(doc.created.length, before + 1, 'cycle ' + i + ': exactly one new element created');
            assert.equal(el.srcReleased, true, 'cycle ' + i + ': old element released its src');
            assert.ok(el.loadCalls > 0, 'cycle ' + i + ': old element load() called to drop the stream');
            assert.equal(el._listenerCount('timeupdate'), 0, 'cycle ' + i + ': no residual timeupdate listener');
            assert.equal(el._listenerCount('ended'), 0, 'cycle ' + i + ': no residual ended listener');
            assert.notEqual(rec('churn').element, el, 'cycle ' + i + ': a fresh element was built');
            assert.equal(audio.trackLoadState('churn').peek(), 'ready', 'cycle ' + i + ': settles ready again');
        }
    });
});

describe('reloadTrack: destroyBus interaction (D6) and end-to-end recovery', () => {
    it('16. reload of a track whose bus was destroyed does not throw; the next playTrack fails closed', async () => {
        const { audio } = await boot({ tracks: {}, buses: ['sfx'] });
        audio.createBus('dynmusic');
        await audio.defineTracks({ dtrack: { src: ['/d.mp3'], bus: 'dynmusic' } });
        const t = audio._tracks.get('dtrack');
        assert.equal(t.loadState.peek(), 'ready');

        assert.equal(audio.destroyBus('dynmusic'), true);
        t.loadState.set('error');   // simulate an externally-detected error post-teardown

        let reloaded;
        assert.doesNotThrow(() => { reloaded = audio.reloadTrack('dtrack'); });
        assert.equal(reloaded, true, 'reloadTrack never touches the bus, so it still fires');
        assert.equal(audio.trackLoadState('dtrack').peek(), 'ready', '_loadTrack does not need the bus to settle');

        assert.doesNotThrow(() => audio.playTrack('dtrack'));
        assert.equal(audio.trackPlaying('dtrack').peek(), false, '_wireTrackGraph fails closed: busRec is gone');
        assert.equal(t.source, null);
    });

    it('17. after a successful reload, playTrack plays normally end-to-end', async () => {
        const { audio, rec } = await boot({ tracks: { churn: { src: ['/c.mp3'], bus: 'music' } } });
        const t = rec('churn');
        t.loadState.set('error');
        assert.equal(audio.reloadTrack('churn'), true);
        assert.equal(audio.trackLoadState('churn').peek(), 'ready');

        audio.playTrack('churn');
        assert.equal(audio.trackPlaying('churn').peek(), true);
        assert.equal(t.element.paused, false);
        assert.ok(t.source, 'graph wired');
    });
});

describe('reloadTrack: adversarial boundary cases', () => {
    it('dispose-during-iteration + duplicate dispose: destroy() mid-batch makes every subsequent call throw, not corrupt', async () => {
        const { audio, rec } = await boot({
            tracks: {
                a: { src: ['/a.mp3'], bus: 'music' },
                b: { src: ['/b.mp3'], bus: 'music' },
                c: { src: ['/c.mp3'], bus: 'music' },
            },
        });
        for (const n of ['a', 'b', 'c']) rec(n).loadState.set('error');

        const names = ['a', 'b', 'c'];
        const results = [];
        for (let i = 0; i < names.length; i++) {
            if (i === 1) audio.destroy();   // destroy mid-loop, after 'a' has already reloaded
            try {
                results.push(audio.reloadTrack(names[i]));
            } catch (err) {
                results.push(err);
            }
        }
        assert.equal(results[0], true, 'a reloaded before destroy');
        assert.ok(results[1] instanceof Error && /destroyed/.test(results[1].message), 'b throws post-destroy');
        assert.ok(results[2] instanceof Error && /destroyed/.test(results[2].message), 'c throws post-destroy');

        // Duplicate dispose: a second destroy() is a documented no-op elsewhere in
        // the engine; reloadTrack must keep throwing afterwards, not resurrect.
        assert.doesNotThrow(() => audio.destroy());
        assert.throws(() => audio.reloadTrack('a'), /LiteAudio: destroyed/);
    });

    it('re-entrant write: an effect that calls reloadTrack synchronously during the reload it observes is refused', async () => {
        const { audio, doc, rec } = await boot({ tracks: { churn: { src: ['/churn.mp3'], bus: 'music' } } });
        rec('churn').loadState.set('error');

        const before = doc.created.length;
        let seenLoading = false;
        let reentrantResult = 'not-called';
        const stop = effect(() => {
            const state = audio.trackLoadState('churn')();
            if (state === 'loading' && reentrantResult === 'not-called') {
                seenLoading = true;
                // Reentrant call, mid-teardown/reload of the SAME track, fired
                // synchronously from inside the loadState.set('loading') that the
                // original reloadTrack call triggers via _loadTrack.
                reentrantResult = audio.reloadTrack('churn');
            }
        });

        const result = audio.reloadTrack('churn');
        stop();

        assert.equal(seenLoading, true, 'the effect observed the loading transition synchronously');
        assert.equal(reentrantResult, false, 'a reentrant reloadTrack mid-flight is refused (loading guard)');
        assert.equal(result, true, 'the original call still fired');
        assert.equal(doc.created.length, before + 1, 'exactly one element was built despite the reentrant attempt');
        assert.equal(audio.trackLoadState('churn').peek(), 'ready');
    });
});
