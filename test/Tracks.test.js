/** @zakkster/lite-audio - music layer (v1.1.0) */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LiteAudio } from '../Audio.js';
import {
    createMockContext, mockFetch, mockDocument, mockScheduler, flushMicrotasks, paramEvents,
    mockAudioElement,
} from './mock-ctx.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** An equal-power fade-out lands on cos(pi/2) = 6.1e-17, not 0. That is -324 dB:
 *  silent by any measure a listener or a mixer cares about. */
const SILENT = 1e-9;
function assertSilent(param, msg) {
    assert.ok(Math.abs(param.value) < SILENT, msg + ' (value: ' + param.value + ')');
}

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
    await audio.defineSounds({ laser: { src: ['/laser.wav'], bus: 'sfx' } });
    await audio.defineTracks(tracks ?? {
        theme: { src: ['/theme.mp3'], bus: 'music', volume: 0.8 },
        boss: { src: ['/boss.mp3'], bus: 'music' },
    });

    if (unlock) {
        win.fire();
        await flushMicrotasks(8);
    }

    const rec = (name) => audio._tracks.get(name);
    const xfade = (name) => rec(name).xfadeGain;
    const el = (name) => rec(name).element;
    return { audio, ctx, doc, clock, win, rec, xfade, el };
}

// ---------------------------------------------------------------------------

describe('defineTracks', () => {
    it('registers each track and settles it ready', async () => {
        const { audio } = await boot();
        assert.equal(audio.trackLoadState('theme').peek(), 'ready');
        assert.equal(audio.trackLoadState('boss').peek(), 'ready');
        assert.equal(audio.trackLoadState('nope'), undefined);
    });

    it('creates exactly one <audio> element per track', async () => {
        const { doc } = await boot();
        assert.equal(doc.created.length, 2);
    });

    it('throws on an unknown bus rather than playing unrouted', async () => {
        const ctx = createMockContext({ state: 'suspended' });
        const audio = new LiteAudio({ buses: ['sfx'], window: null, document: mockDocument() });
        await audio.init(ctx);
        await assert.rejects(
            () => audio.defineTracks({ theme: { src: ['/t.mp3'], bus: 'nope' } }),
            /unknown bus/,
        );
    });

    it('is idempotent: re-defining a name does not build a second element', async () => {
        const { audio, doc } = await boot();
        await audio.defineTracks({ theme: { src: ['/theme.mp3'], bus: 'music' } });
        assert.equal(doc.created.length, 2, 'no third element');
    });

    it('errors when no source can be resolved', async () => {
        const { audio } = await boot({ tracks: { silent: { src: [], bus: 'music' } } });
        assert.equal(audio.trackLoadState('silent').peek(), 'error');
    });

    it('pushes duration from loadedmetadata, and error from the element', async () => {
        const { audio, el } = await boot();
        assert.equal(audio.trackDuration('theme').peek(), 0, 'unknown until metadata lands');

        el('theme').duration = 212.5;
        el('theme')._fire('loadedmetadata');
        assert.equal(audio.trackDuration('theme').peek(), 212.5);

        el('boss')._fire('error');
        assert.equal(audio.trackLoadState('boss').peek(), 'error');
    });
});

describe('playTrack', () => {
    it('wires the graph on first play: source -> xfade -> volume -> bus', async () => {
        const { audio, rec } = await boot();
        audio.playTrack('theme');

        const t = rec('theme');
        assert.equal(t.source.mediaElement, t.element);
        assert.ok(t.source.out.includes(t.xfadeGain));
        assert.ok(t.xfadeGain.out.includes(t.volumeGain));
        assert.ok(t.volumeGain.out.includes(audio.busNode('music')));
        assert.equal(t.volumeGain.gain.value, 0.8, 'track volume, independent of crossfade');
    });

    it('starts the element and reports playing', async () => {
        const { audio, el, xfade } = await boot();
        audio.playTrack('theme');
        assert.equal(el('theme').paused, false);
        assert.equal(audio.trackPlaying('theme').peek(), true);
        assert.equal(xfade('theme').gain.value, 1, 'snaps to full with no fadeIn');
    });

    it('is a no-op while the context is locked', async () => {
        const { audio, el } = await boot({ unlock: false });
        audio.playTrack('theme');
        assert.equal(audio.trackPlaying('theme').peek(), false);
        assert.equal(el('theme').playCalls, 0, 'music is not queued the way SFX are');
    });

    it('is a no-op for a track that never loaded', async () => {
        const { audio, rec } = await boot({ tracks: { silent: { src: [], bus: 'music' } } });
        audio.playTrack('silent');
        assert.equal(audio.trackPlaying('silent').peek(), false);
        assert.equal(rec('silent').element, null, 'no element was ever built');
    });

    it('is idempotent unless restart is asked for', async () => {
        const { audio, el } = await boot();
        audio.playTrack('theme');
        el('theme').currentTime = 40;

        audio.playTrack('theme');
        assert.equal(el('theme').playCalls, 1, 'second play is a no-op');
        assert.equal(el('theme').currentTime, 40, 'and does not rewind');

        audio.playTrack('theme', { restart: true });
        assert.equal(el('theme').currentTime, 0);
    });

    it('seeks when given a position', async () => {
        const { audio, el } = await boot();
        audio.playTrack('theme', { position: 61.5 });
        assert.equal(el('theme').currentTime, 61.5);
    });

    it('fadeIn schedules an equal-power curve over the duration asked for', async () => {
        const { audio, xfade } = await boot();
        audio.playTrack('theme', { fadeIn: 600 });
        const curves = paramEvents(xfade('theme').gain, 'curve');
        assert.equal(curves.length, 1);
        assert.equal(curves[0][3], 0.6, 'seconds, not ms');
        assert.equal(xfade('theme').gain.value, 1, 'ends at full');
    });
});

describe('stopTrack', () => {
    it('flips playing immediately, fades the gain, pauses only after the fade', async () => {
        const { audio, el, xfade, clock } = await boot();
        audio.playTrack('theme');
        audio.stopTrack('theme', { fade: 300 });

        assert.equal(audio.trackPlaying('theme').peek(), false, 'HUDs update at once');
        assertSilent(xfade('theme').gain, 'faded out');
        assert.equal(el('theme').paused, false, 'element still decoding through the fade tail');

        assert.equal(clock.pending(), 1);
        clock.flush();
        assert.equal(el('theme').paused, true, 'and paused once the tail is done');
    });

    it('fade 0 drops the gain in one step', async () => {
        const { audio, xfade } = await boot();
        audio.playTrack('theme');
        audio.stopTrack('theme', { fade: 0 });
        assert.equal(xfade('theme').gain.value, 0);
        assert.equal(paramEvents(xfade('theme').gain, 'curve').length, 0, 'no curve for a hard stop');
    });

    it('does nothing to a track that is not playing', async () => {
        const { audio, clock } = await boot();
        audio.stopTrack('theme');
        assert.equal(clock.pending(), 0, 'no pause armed');
    });
});

describe('pauseTrack / resumeTrack', () => {
    it('pause keeps position and leaves the gain alone', async () => {
        const { audio, el, xfade } = await boot();
        audio.playTrack('theme');
        el('theme').currentTime = 30;

        audio.pauseTrack('theme');
        assert.equal(audio.trackPlaying('theme').peek(), false);
        assert.equal(el('theme').paused, true);
        assert.equal(el('theme').currentTime, 30);
        assert.equal(xfade('theme').gain.value, 1, 'pause is not a fade');

        audio.resumeTrack('theme');
        assert.equal(audio.trackPlaying('theme').peek(), true);
        assert.equal(el('theme').currentTime, 30);
        assert.equal(xfade('theme').gain.value, 1);
    });

    it('resume after stopTrack is audible, not a lying signal', async () => {
        const { audio, el, xfade, clock } = await boot();
        audio.playTrack('theme');
        audio.stopTrack('theme', { fade: 200 });
        assertSilent(xfade('theme').gain, 'stopTrack faded it away');
        clock.flush();
        assert.equal(el('theme').paused, true);

        audio.resumeTrack('theme');

        assert.equal(audio.trackPlaying('theme').peek(), true);
        assert.equal(el('theme').paused, false);
        assert.equal(xfade('theme').gain.value, 1,
            'resume must restore the gain stopTrack faded away, or it plays silence');
    });

    it('resume disarms a pause still queued behind the fade', async () => {
        const { audio, el, clock } = await boot();
        audio.playTrack('theme');
        audio.stopTrack('theme', { fade: 500 });
        assert.equal(clock.pending(), 1, 'pause armed');

        audio.resumeTrack('theme');
        assert.equal(clock.pending(), 0, 'and disarmed');

        clock.flush();
        assert.equal(el('theme').paused, false, 'still playing');
    });

    it('resume refuses while locked, or when the track never loaded', async () => {
        const locked = await boot({ unlock: false });
        locked.audio.resumeTrack('theme');
        assert.equal(locked.audio.trackPlaying('theme').peek(), false);

        const bad = await boot({ tracks: { silent: { src: [], bus: 'music' } } });
        bad.audio.resumeTrack('silent');
        assert.equal(bad.audio.trackPlaying('silent').peek(), false);
    });
});

describe('looping and position', () => {
    it('uses the native loop when there are no custom points', async () => {
        const { audio, el } = await boot({
            tracks: { theme: { src: ['/t.mp3'], bus: 'music', loop: true } },
        });
        audio.playTrack('theme');
        assert.equal(el('theme').loop, true);
    });

    it('custom loopEnd seeks back to loopStart and disables the native loop', async () => {
        const { audio, el } = await boot({
            tracks: {
                theme: { src: ['/t.mp3'], bus: 'music', loop: true, loopStart: 8, loopEnd: 40 },
            },
        });
        audio.playTrack('theme');
        assert.equal(el('theme').loop, false, 'native loop would jump to 0, not to loopStart');

        el('theme').currentTime = 39;
        el('theme')._fire('timeupdate');
        assert.equal(el('theme').currentTime, 39, 'before the loop point, nothing happens');

        el('theme').currentTime = 40.2;
        el('theme')._fire('timeupdate');
        assert.equal(el('theme').currentTime, 8, 'seeks back to loopStart');
    });

    it('throttles the position signal to 100ms of context time', async () => {
        const { audio, ctx, el } = await boot();
        audio.playTrack('theme');

        el('theme').currentTime = 1;
        el('theme')._fire('timeupdate');
        assert.equal(audio.trackPosition('theme').peek(), 1, 'first write lands');

        ctx._advance(0.05);
        el('theme').currentTime = 2;
        el('theme')._fire('timeupdate');
        assert.equal(audio.trackPosition('theme').peek(), 1, 'inside the window, suppressed');

        ctx._advance(0.06);
        el('theme').currentTime = 3;
        el('theme')._fire('timeupdate');
        assert.equal(audio.trackPosition('theme').peek(), 3, 'past the window, written');
    });

    it('ended flips playing without tearing the graph down', async () => {
        const { audio, rec, el } = await boot();
        audio.playTrack('theme');
        const source = rec('theme').source;

        el('theme')._fire('ended');
        assert.equal(audio.trackPlaying('theme').peek(), false);
        assert.equal(rec('theme').source, source, 'graph survives for a replay');
    });
});

describe('crossfade', () => {
    it('schedules both sides over the same duration, from the same instant', async () => {
        const { audio, xfade } = await boot();
        audio.playTrack('theme');
        audio.crossfade('theme', 'boss', 400);

        assert.equal(audio.trackPlaying('theme').peek(), false);
        assert.equal(audio.trackPlaying('boss').peek(), true);
        assertSilent(xfade('theme').gain, 'outgoing faded out');
        assert.equal(xfade('boss').gain.value, 1, 'incoming at full');

        const out = paramEvents(xfade('theme').gain, 'curve');
        const into = paramEvents(xfade('boss').gain, 'curve');
        assert.equal(out[0][3], 0.4);
        assert.equal(into[0][3], 0.4);
        assert.equal(out[0][2], into[0][2], 'both start at the same instant');
    });

    it('holds power constant across the fade, which is the point of equal power', async () => {
        const { audio, xfade } = await boot();
        audio.playTrack('theme');
        audio.crossfade('theme', 'boss', 400);

        const out = paramEvents(xfade('theme').gain, 'curve')[0][1];
        const into = paramEvents(xfade('boss').gain, 'curve')[0][1];
        assert.equal(out.length, into.length);
        for (let i = 0; i < out.length; i++) {
            const power = Math.sqrt(out[i] * out[i] + into[i] * into[i]);
            assert.ok(Math.abs(power - 1) < 1e-5,
                'sample ' + i + ': combined power ' + power + ', a linear fade would dip to 0.71');
        }
    });

    it('fades in only when the from side is null', async () => {
        const { audio, xfade } = await boot();
        audio.crossfade(null, 'boss', 250);
        assert.equal(audio.trackPlaying('boss').peek(), true);
        assert.equal(paramEvents(xfade('boss').gain, 'curve')[0][3], 0.25);
    });

    it('fades out only when the to side is null', async () => {
        const { audio, xfade } = await boot();
        audio.playTrack('theme');
        audio.crossfade('theme', null, 250);
        assert.equal(audio.trackPlaying('theme').peek(), false);
        assertSilent(xfade('theme').gain, 'faded out');
    });

    it('retargets a track already fading in from wherever its gain actually is', async () => {
        const { audio, xfade } = await boot();
        audio.playTrack('boss', { fadeIn: 1000 });
        // The mock settles automation immediately, so pin the gain by hand to stand
        // in for "we are 40 percent up the ramp when the next crossfade arrives".
        xfade('boss').gain.value = 0.4;

        audio.crossfade('theme', 'boss', 300);

        const curves = paramEvents(xfade('boss').gain, 'curve');
        const last = curves[curves.length - 1][1];
        assert.ok(Math.abs(last[0] - 0.4) < 1e-6, 'curve starts at the current value, no jump');
        assert.ok(Math.abs(last[last.length - 1] - 1) < 1e-6, 'and still arrives at full');
    });
});

describe('playExclusive / playUnique', () => {
    it('exclusive fades other tracks on the same bus only', async () => {
        const { audio } = await boot({
            buses: ['sfx', 'music', 'ambience'],
            tracks: {
                theme: { src: ['/t.mp3'], bus: 'music' },
                boss: { src: ['/b.mp3'], bus: 'music' },
                rain: { src: ['/r.mp3'], bus: 'ambience' },
            },
        });
        audio.playTrack('theme');
        audio.playTrack('rain');

        audio.playExclusive('boss');

        assert.equal(audio.trackPlaying('boss').peek(), true);
        assert.equal(audio.trackPlaying('theme').peek(), false, 'same bus: faded');
        assert.equal(audio.trackPlaying('rain').peek(), true, 'other bus: untouched');
    });

    it('playUnique never hands back 0 for a track', async () => {
        const { audio } = await boot();

        const sfx = audio.play('laser');
        assert.equal(sfx, 0, 'the handle a track start used to impersonate');
        assert.equal(audio.isPlaying(sfx), true);

        const result = audio.playUnique('theme');
        assert.equal(result, -2, 'TRACK_STARTED, not a handle');
        assert.equal(audio.trackPlaying('theme').peek(), true);

        audio.stop(result);
        assert.equal(audio.isPlaying(sfx), true, 'the SFX voice is untouched');
    });

    it('playUnique gates repeats and reports a handle for sounds', async () => {
        const { audio } = await boot();
        const first = audio.playUnique('laser');
        assert.ok(first >= 0);
        assert.equal(audio.playUnique('laser'), -1, 'inside the threshold');
        assert.equal(audio.playUnique('nope'), -1, 'unknown name');
    });
});

describe('bus-wide stops reach the music', () => {
    it('stopAll() stops voices and fades every track', async () => {
        const { audio } = await boot();
        audio.play('laser');
        audio.play('laser');
        audio.playTrack('theme');
        assert.equal(audio.activeCount(), 2);

        audio.stopAll();

        assert.equal(audio.activeCount(), 0);
        assert.equal(audio.trackPlaying('theme').peek(), false,
            'a scene change that leaves the old theme playing is not "stop all"');
    });

    it('stopBus() is scoped to the bus it names', async () => {
        const { audio } = await boot();
        audio.play('laser');
        audio.playTrack('theme');

        audio.stopBus('sfx');
        assert.equal(audio.activeCount('sfx'), 0);
        assert.equal(audio.trackPlaying('theme').peek(), true, 'music bus untouched');

        audio.stopBus('music');
        assert.equal(audio.trackPlaying('theme').peek(), false);
    });
});

describe('destroy() with tracks', () => {
    it('releases the elements, not just their handlers', async () => {
        const { audio, rec } = await boot();
        audio.playTrack('theme');
        const t = rec('theme');
        const element = t.element;
        assert.ok(element._listenerCount('timeupdate') > 0);

        audio.destroy();

        assert.equal(element.paused, true);
        assert.equal(element._listenerCount('timeupdate'), 0);
        assert.equal(element._listenerCount('ended'), 0);
        assert.equal(element.srcReleased, true, 'a paused element with a src can keep buffering');
        assert.ok(element.loadCalls > 0, 'load() after src removal is what drops the stream');
        assert.equal(t.source.disconnected, 1);
        assert.equal(t.xfadeGain.disconnected, 1);
        assert.equal(t.volumeGain.disconnected, 1);
    });

    it('is idempotent and inert afterwards', async () => {
        const { audio } = await boot();
        audio.playTrack('theme');
        audio.destroy();

        assert.doesNotThrow(() => audio.destroy());
        assert.doesNotThrow(() => audio.playTrack('theme'));
        assert.doesNotThrow(() => audio.stopAll());
        assert.equal(audio.playUnique('theme'), -1);
        assert.equal(audio.activeCount(), 0);
    });

    it('clears the pending pause so a timer cannot fire into a dead engine', async () => {
        const { audio, clock } = await boot();
        audio.playTrack('theme');
        audio.stopTrack('theme', { fade: 400 });
        assert.equal(clock.pending(), 1);

        audio.destroy();
        assert.equal(clock.pending(), 0);
    });
});

// ---------------------------------------------------------------------------
// AU2 edge: the one <audio> element -> one MediaElementAudioSourceNode rule.
// A given element can back exactly ONE source node for its lifetime; a second
// createMediaElementSource on it throws InvalidStateError. lite-audio creates
// its own elements and never reuses one, but a destroy() -> re-init cycle on a
// HOST that pools elements is the path that hits this. See PARITY.md.
// ---------------------------------------------------------------------------

/** A context that records createMediaElementSource calls and, optionally,
 *  enforces the spec's one-source-per-element rule by throwing on reuse. */
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

/** A document that hands back the SAME <audio> element every time, standing in
 *  for a host that pools/reuses media elements across engine lifetimes. */
function reusingDocument() {
    const el = mockAudioElement();
    return {
        hidden: false,
        created: [],
        createElement(tag) {
            if (tag !== 'audio') throw new Error('reusingDocument: unexpected <' + tag + '>');
            this.created.push(el);
            return el;
        },
        addEventListener() {},
        removeEventListener() {},
    };
}

describe('reused <audio> element (destroy -> re-init)', () => {
    it('wires the element source exactly once per track within a session', async () => {
        const ctx = sourceTrackingCtx();
        const win = fakeWindow();
        const audio = new LiteAudio({
            buses: ['music'], window: win, document: mockDocument(),
            fetch: mockFetch({}),
        });
        await audio.init(ctx);
        await audio.defineTracks({ theme: { src: ['/theme.mp3'], bus: 'music' } });
        win.fire();
        await flushMicrotasks(8);

        audio.playTrack('theme');
        audio.stopTrack('theme', { fade: 0 });
        audio.playTrack('theme');           // replay must NOT re-source the element
        assert.equal(ctx._mesCalls(), 1, 'the rec.source guard blocks a second wiring');
        audio.destroy();
    });

    it('fails a track closed when handed a spent/reused element, without throwing', async () => {
        const win = fakeWindow();
        const ctx = sourceTrackingCtx({ throwOnReuse: true });
        const doc = reusingDocument();      // one element, shared across both engines
        const mk = () => new LiteAudio({
            buses: ['music'], window: win, document: doc, fetch: mockFetch({}),
        });

        // Engine A wires the shared element once and tears down.
        const a = mk();
        await a.init(ctx);
        await a.defineTracks({ theme: { src: ['/theme.mp3'], bus: 'music' } });
        win.fire();
        await flushMicrotasks(8);
        a.playTrack('theme');
        assert.ok(a._tracks.get('theme').source, 'first engine wired the element');
        a.destroy();

        // Engine B, same context, gets the SAME element back. A real browser
        // throws InvalidStateError on the second createMediaElementSource; the
        // engine must catch it and fail the track closed rather than throw into
        // the caller's playTrack().
        const b = mk();
        await b.init(ctx);
        await b.defineTracks({ theme: { src: ['/theme.mp3'], bus: 'music' } });
        win.fire();
        await flushMicrotasks(8);

        assert.doesNotThrow(() => b.playTrack('theme'));
        assert.equal(b._tracks.get('theme').loadState.peek(), 'error', 'track failed closed');
        assert.equal(b._tracks.get('theme').playing.peek(), false, 'nothing started');
        b.destroy();
    });

    it('a fresh element (the normal re-init) plays cleanly after destroy', async () => {
        const win = fakeWindow();
        const ctx = sourceTrackingCtx({ throwOnReuse: true });
        const mk = () => new LiteAudio({
            buses: ['music'], window: win, document: mockDocument(),   // fresh elements
            fetch: mockFetch({}),
        });

        const a = mk();
        await a.init(ctx);
        await a.defineTracks({ theme: { src: ['/theme.mp3'], bus: 'music' } });
        win.fire();
        await flushMicrotasks(8);
        a.playTrack('theme');
        a.destroy();

        // A new engine with its own document creates a new element - no reuse,
        // no collision. This is the scene-reload path, and it must just work.
        const b = mk();
        await b.init(ctx);
        await b.defineTracks({ theme: { src: ['/theme.mp3'], bus: 'music' } });
        win.fire();
        await flushMicrotasks(8);
        b.playTrack('theme');
        assert.ok(b._tracks.get('theme').source, 'fresh element wired');
        assert.equal(b._tracks.get('theme').playing.peek(), true);
        b.destroy();
    });
});

// ---------------------------------------------------------------------------
// P-TV1: setTrackVolume -- the public track-baseline setter (2.12.0, brief A-2).
// Fail-closed on every unverified input, clamped to [0, 1], mirroring setWidth.
// ---------------------------------------------------------------------------

describe('setTrackVolume (P-TV1)', () => {
    it('sets the baseline gain on a wired track', async () => {
        const { audio, rec } = await boot();
        audio.playTrack('theme');                      // wires the graph
        audio.setTrackVolume('theme', 0.4);
        assert.equal(rec('theme').volumeGain.gain.value, 0.4);
    });

    it('clamps out-of-range to [0, 1], matching setWidth', async () => {
        const { audio, rec } = await boot();
        audio.playTrack('theme');
        audio.setTrackVolume('theme', -1);
        assert.equal(rec('theme').volumeGain.gain.value, 0, 'negative clamps to 0');
        audio.setTrackVolume('theme', 2);
        assert.equal(rec('theme').volumeGain.gain.value, 1, 'above 1 clamps to 1');
    });

    it('rejects a non-number without coercion (null is not zero)', async () => {
        const { audio, rec } = await boot();
        audio.playTrack('theme');
        audio.setTrackVolume('theme', 0.5);            // known-good baseline
        for (const bad of [null, undefined, NaN, '0.5', {}, true]) {
            audio.setTrackVolume('theme', bad);
            assert.equal(rec('theme').volumeGain.gain.value, 0.5,
                'baseline unchanged by ' + String(bad));
        }
    });

    it('is a silent no-op for an unknown track name', async () => {
        const { audio } = await boot();
        assert.doesNotThrow(() => audio.setTrackVolume('nope', 0.5));
    });

    it('is a silent no-op before the graph is wired (volumeGain still null)', async () => {
        const { audio, rec } = await boot();
        assert.equal(rec('theme').volumeGain, null, 'unwired until first play');
        assert.doesNotThrow(() => audio.setTrackVolume('theme', 0.5));
        assert.equal(rec('theme').volumeGain, null, 'still unwired, no phantom node');
    });

    it('is a silent no-op after destroy', async () => {
        const { audio, rec } = await boot();
        audio.playTrack('theme');
        const node = rec('theme').volumeGain;
        node.gain.value = 0.6;
        audio.destroy();
        assert.doesNotThrow(() => audio.setTrackVolume('theme', 0.1));
    });
});
