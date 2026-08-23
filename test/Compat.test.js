/**
 * @zakkster/lite-audio/compat (AU2 / v2.0.0) - parity with lite-audio-manager.
 *
 * These are lite-audio-manager's own ~45 expectations, ported from its Vitest
 * suite to node:test and run against the REAL lite-audio engine through the
 * shim. Each `it` name carries its parity-table id (P-xx) or divergence id
 * (DIV-x); PARITY.md maps the manager's surface to these ids, and every DIV row
 * has a test here proving the shim's deliberate, documented behavior.
 *
 * The manager's suite mocks Howler; we cannot run that file under our
 * node:test-only Law, so this is the honest form of "run the manager's
 * expectations against the shim": the expectation table, re-expressed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AudioManager } from '../Compat.js';
import {
    createMockContext, mockFetch, mockDocument, mockScheduler, flushMicrotasks, paramEvents,
} from './mock-ctx.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function fakeWindow(navigator) {
    const cbs = [];
    return {
        navigator,
        addEventListener(evt, cb) { cbs.push(cb); },
        removeEventListener() {},
        fire() { for (const cb of [...cbs]) cb({}); },
    };
}

// The manager's own test config, verbatim. Under the shim's classification,
// bgm (loop + html5) becomes a streamed TRACK; the other four are pooled SFX.
const CONFIG = () => ({
    hit:  { src: ['/hit.wav'], category: 'sfx' },
    coin: { src: ['/coin.wav'], category: 'sfx', pitchVar: 0.15 },
    bgm:  { src: ['/music.mp3'], category: 'music', loop: true, html5: true },
    win:  { src: ['/win.mp3'], category: 'outcome' },
    lose: { src: ['/lose.mp3'], category: 'outcome' },
});

const SRC_MAP = {
    '/hit.wav': 500, '/coin.wav': 500, '/music.mp3': 500, '/win.wav': 500,
    '/win.mp3': 500, '/lose.mp3': 500,
};

/** CONFIG(), with bgm's config-level track volume set explicitly (default config
 *  never sets one, so `volume ?? 1` bakes in 1 -- P-P10a/P-P10b need a baseline
 *  other than the ?? default to prove an explicit play() volume overrides it and
 *  an omitted one does not reset it back to that default). */
const CONFIG_WITH_TRACK_VOLUME = (vol = 0.3) => {
    const c = CONFIG();
    c.bgm = { ...c.bgm, volume: vol };
    return c;
};

async function boot({ config = CONFIG(), unlock = true, now } = {}) {
    const ctx = createMockContext({ state: 'suspended' });
    const win = fakeWindow();
    const doc = mockDocument();
    const clock = mockScheduler();

    const manager = new AudioManager({
        context: ctx,
        window: win,
        document: doc,
        fetch: mockFetch(SRC_MAP),
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        poolCapacity: 8,
        now,
    });

    manager.init(config);
    await manager.whenReady();

    if (unlock) {
        win.fire();
        await flushMicrotasks(8);
    }
    return { manager, ctx, win, doc, clock };
}

/** Wrap engine.play so a test can read the exact positional args the shim passed. */
function capturePlay(manager) {
    const calls = [];
    const engine = manager.engine;
    const orig = engine.play.bind(engine);
    engine.play = (...args) => { calls.push(args); return orig(...args); };
    return calls;
}

// ---------------------------------------------------------------------------
// Constructor  (P-C)
// ---------------------------------------------------------------------------

describe('constructor', () => {
    it('P-C1 starts unmuted by default', () => {
        const m = new AudioManager({ window: fakeWindow(), document: mockDocument() });
        assert.equal(m.isMuted, false);
    });

    it('P-C2 starts unlocked as false', () => {
        const m = new AudioManager({ window: fakeWindow(), document: mockDocument() });
        assert.equal(m.isUnlocked, false);
    });

    it('P-C3 extends EventTarget', () => {
        const m = new AudioManager({ window: fakeWindow(), document: mockDocument() });
        assert.ok(m instanceof EventTarget);
    });
});

// ---------------------------------------------------------------------------
// init()  (P-I)
// ---------------------------------------------------------------------------

describe('init()', () => {
    it('P-I1 registers every configured sound (pooled SFX + streamed tracks)', async () => {
        const { manager } = await boot();
        // Four one-shots + one track = five registered.
        assert.equal(manager.engine._sounds.size, 4, 'four pooled SFX');
        assert.equal(manager.engine._tracks.size, 1, 'one streamed track');
    });

    it('P-I2 passes src through to the engine', async () => {
        const { manager } = await boot();
        assert.equal(manager.engine._sounds.get('hit').srcs[0], '/hit.wav');
    });

    it('P-I3 turns category into a bus, not a leaked sound field', async () => {
        const { manager } = await boot();
        // The manager strips `category` before it reaches Howl; the shim
        // consumes it as the routing bus instead.
        assert.equal(manager.engine._sounds.get('hit').busName, 'sfx');
        assert.equal(manager.engine._sounds.get('win').busName, 'outcome');
    });

    it('P-I4 applies persisted mute state on init', async () => {
        const { manager } = await boot();
        assert.equal(manager.engine.muted().peek(), false);
    });

    it('P-I5 does not duplicate sounds on a second init call', async () => {
        const { manager } = await boot();
        manager.init(CONFIG());
        await manager.whenReady();
        assert.equal(manager.engine._sounds.size, 4);
        assert.equal(manager.engine._tracks.size, 1);
    });
});

// ---------------------------------------------------------------------------
// Category -> bus  (P-CAT)  and  classification  (P-CLASS)
// ---------------------------------------------------------------------------

describe('category -> bus / classification', () => {
    it('P-CAT auto-creates one bus per distinct category', async () => {
        const { manager } = await boot();
        assert.ok(manager.engine._buses.has('sfx'));
        assert.ok(manager.engine._buses.has('music'));
        assert.ok(manager.engine._buses.has('outcome'));
    });

    it('P-CLASS routes a loop/html5 sound to a streamed track, not a pooled voice', async () => {
        const { manager } = await boot();
        assert.ok(manager.engine._tracks.has('bgm'), 'bgm is a track');
        assert.ok(!manager.engine._sounds.has('bgm'), 'bgm is not a pooled sound');
    });
});

// ---------------------------------------------------------------------------
// play()  (P-P, DIV)
// ---------------------------------------------------------------------------

describe('play()', () => {
    it('P-P1 returns a numeric play handle', async () => {
        const { manager } = await boot();
        const id = manager.play('hit');
        assert.equal(typeof id, 'number');
        assert.ok(id >= 0);
    });

    it('P-P2 forwards volume to the engine', async () => {
        const { manager } = await boot();
        const calls = capturePlay(manager);
        manager.play('hit', { volume: 0.5 });
        assert.equal(calls[0][1], 0.5, 'volume is the second positional arg');
    });

    it('P-P3 plays a looping sound as a streamed track', async () => {
        const { manager } = await boot();
        const id = manager.play('bgm', { loop: true });
        assert.equal(typeof id, 'number');
        assert.equal(manager.engine.trackPlaying('bgm').peek(), true);
    });

    it('P-P4 applies random pitch variation within range', async () => {
        const { manager } = await boot();
        const calls = capturePlay(manager);
        manager.play('hit', { pitchVar: 0.2 });
        const rate = calls[0][3];
        assert.ok(rate >= 0.8 && rate <= 1.2, `rate ${rate} in [0.8, 1.2]`);
    });

    it('P-P5 explicit pitch overrides pitchVar', async () => {
        const { manager } = await boot();
        const calls = capturePlay(manager);
        manager.play('hit', { pitch: 1.5, pitchVar: 0.2 });
        assert.equal(calls[0][3], 1.5);
    });

    it('P-P6 returns null for an unknown sound', async () => {
        const { manager } = await boot();
        assert.equal(manager.play('nonexistent'), null);
    });

    it('DIV-1 returns null pre-unlock but KEEPS the play, flushing it on unlock', async () => {
        const { manager, win } = await boot({ unlock: false });
        // Manager drops and returns null; the shim also returns null...
        assert.equal(manager.play('hit'), null);
        assert.equal(manager.engine.activeCount('sfx'), 0, 'nothing sounding yet');
        // ...but the play was queued, and the first gesture flushes it.
        win.fire();
        await flushMicrotasks(8);
        assert.ok(manager.engine.activeCount('sfx') >= 1, 'queued play flushed on unlock');
    });

    it('P-P7 returns null after destroy', async () => {
        const { manager } = await boot();
        manager.destroy();
        assert.equal(manager.play('hit'), null);
    });
});

// ---------------------------------------------------------------------------
// play() on a track, interrupted then replayed  (P-P8, P-P9 -- A-1)
//
// BRIEF.md A-1: play() plays a track via playTrack(name, {}), which is
// documented idempotent and only seeks to 0 under `restart: true` -- so a
// track stopped part-way and played again RESUMES from where it stopped
// instead of restarting, unlike the manager surface being emulated (Howler
// starts a fresh instance at 0 every time). The fix defaults play() to
// `restart: true` for a track and adds `resume: true` as the opt-in escape
// hatch. Pre-fix (playTrack(name, {}), no restart forwarded EVER): P-P8 fails
// because the element is never seeked back to 0 on replay.
// ---------------------------------------------------------------------------

describe('play() on an interrupted track (P-P8, P-P9 -- A-1)', () => {
    it('P-P8 play() with NO options RESTARTS an interrupted track (seeks to 0, xfade back to 1)', async () => {
        const { manager } = await boot();
        manager.play('bgm');
        const track = manager.engine._tracks.get('bgm');

        // Advance well into playback, then interrupt part-way (mirrors the
        // consumer's playExclusive on an outcome track hit mid-fanfare).
        track.element.currentTime = 45;
        manager.stopCategory('music', { fade: 0 });
        assert.equal(manager.engine.trackPlaying('bgm').peek(), false, 'setup: interrupted');
        assert.equal(track.element.currentTime, 45, 'setup: stop does not itself rewind');

        // Replay with NO options -- the manager surface being emulated (Howler)
        // always starts a fresh instance at 0, never resumes.
        manager.play('bgm');

        assert.equal(track.element.currentTime, 0,
            'A-1: play() with no options must RESTART an interrupted track, not resume it from 45s');
        assert.equal(track.xfadeGain.gain.value, 1, 'xfadeGain is restored to full on the replay');
    });

    it('P-P9 play() with { resume: true } opts INTO resuming (contrast with P-P8)', async () => {
        const { manager } = await boot();
        manager.play('bgm');
        const track = manager.engine._tracks.get('bgm');

        track.element.currentTime = 30;
        manager.stopCategory('music', { fade: 0 });
        assert.equal(track.element.currentTime, 30, 'setup: interrupted at a nonzero position');

        manager.play('bgm', { resume: true });

        assert.ok(track.element.currentTime > 0,
            'resume: true must NOT seek to 0 -- it opts out of the restart default');
        assert.equal(track.element.currentTime, 30, 'position is preserved exactly, not merely nonzero');
    });
});

// ---------------------------------------------------------------------------
// play() track volume forwarding  (P-P10a, P-P10b -- A-2)
//
// BRIEF.md A-2: PlayOptions.volume is documented without qualification, but
// play() forwarded it only on the SFX path; the track path called
// playTrack(name, {}) and silently dropped it. The fix forwards an EXPLICIT
// per-play volume via engine.setTrackVolume(name, volume), called AFTER
// playTrack (a track's volumeGain node wires lazily on first play, so a
// pre-play setTrackVolume would find it null and no-op -- dropping the level
// on exactly the play that matters most, the first one). An OMITTED volume
// must never clobber the config-set baseline with a defaulted 1.
// ---------------------------------------------------------------------------

describe('play() track volume forwarding (P-P10a, P-P10b -- A-2)', () => {
    it('P-P10a an explicit volume is honored on the FIRST-EVER play of a track', async () => {
        const { manager } = await boot({ config: CONFIG_WITH_TRACK_VOLUME(0.3) });
        const track = manager.engine._tracks.get('bgm');
        assert.equal(track.volumeGain, null, 'setup: graph (and volumeGain) not yet wired before any play');

        // THE regression: a pre-fix (or wrong-order) forward would call
        // setTrackVolume before playTrack ever wires the graph, finding
        // volumeGain still null and silently no-opping. Assert on the FIRST
        // play, not a second one that would find the graph already wired.
        manager.play('bgm', { volume: 0.5 });

        assert.notEqual(track.volumeGain, null, 'setup: the first play wired the graph');
        assert.equal(track.volumeGain.gain.value, 0.5,
            'A-2: an explicit per-play volume must be honored on the FIRST play, not silently dropped');
    });

    it('P-P10b an omitted volume never clobbers the config-set baseline', async () => {
        const { manager } = await boot({ config: CONFIG_WITH_TRACK_VOLUME(0.3) });
        const track = manager.engine._tracks.get('bgm');

        manager.play('bgm');   // no volume option at all
        assert.equal(track.volumeGain.gain.value, 0.3,
            'an omitted volume must leave the config-baked baseline alone, not default-reset it to 1');

        manager.play('bgm', { volume: 0.7 });
        assert.equal(track.volumeGain.gain.value, 0.7, 'an explicit volume on a later play still applies');

        manager.play('bgm');   // omitted again
        assert.equal(track.volumeGain.gain.value, 0.7,
            'omitted again: stays at the last EXPLICIT baseline (0.7), never resets');
    });
});

// ---------------------------------------------------------------------------
// setMuted() realm capture  (P-M5 -- A-5)
//
// BRIEF.md A-5: muteEvent() built the CustomEvent from globalThis.CustomEvent
// read AT DISPATCH TIME, while the class extends whatever EventTarget was
// bound when Compat.js evaluated. Under a jsdom-in-node harness those are two
// different realms, and node's EventTarget#dispatchEvent brand-checks its
// argument -- so every setMuted() threw ERR_INVALID_ARG_TYPE. The fix
// captures CustomEvent ONCE at module load (see CustomEventCtor in
// Compat.js), binding it to the SAME realm as the EventTarget the class
// extends, immune to whatever globalThis.CustomEvent is doing later.
//
// This suite is node:test-only (no jsdom, no vitest) so a literal jsdom-vs-
// node cross-realm rejection cannot be reproduced here. Instead this
// reproduces the OBSERVABLE failure mode: swap globalThis.CustomEvent, AFTER
// Compat.js has already been imported (and so already captured its module-
// load reference), for a foreign constructor whose instances are NOT
// `instanceof Event` -- structurally identical to what a jsdom CustomEvent
// looks like to node's real EventTarget, and confirmed by hand to make
// node's dispatchEvent throw exactly the same
// "must be an instance of Event" TypeError jsdom-in-node produces for A-5.
// A pre-fix implementation reading globalThis.CustomEvent AT DISPATCH TIME
// would build the mutechange event from this foreign ctor and throw; the
// module-load capture is immune because its reference was taken before the
// swap ever happened.
// ---------------------------------------------------------------------------

describe('setMuted() / mutechange realm capture (P-M5, A-5)', () => {
    it('P-M5 dispatches mutechange via the module-captured CustomEvent, immune to a later global swap', () => {
        const RealCustomEvent = globalThis.CustomEvent;
        class ForeignCustomEvent {                      // deliberately NOT a subclass of Event
            constructor(type, init) { this.type = type; this.detail = init && init.detail; }
        }
        globalThis.CustomEvent = ForeignCustomEvent;
        try {
            const m = new AudioManager({ window: fakeWindow(), document: mockDocument() });
            let calls = 0;
            let detail = null;
            m.addEventListener('mutechange', (e) => { calls++; detail = e.detail; });

            assert.doesNotThrow(() => m.setMuted(true),
                'setMuted must not throw even though globalThis.CustomEvent was swapped after module load ' +
                '(a dispatch-time global read would throw the exact TypeError a jsdom-in-node realm mismatch does)');
            assert.equal(calls, 1);
            assert.deepEqual(detail, { isMuted: true }, 'the listener still receives a well-formed detail');
        } finally {
            globalThis.CustomEvent = RealCustomEvent;
        }
    });
});

// ---------------------------------------------------------------------------
// playExclusive()  (P-PE)
// ---------------------------------------------------------------------------

describe('playExclusive()', () => {
    it('P-PE1 stops the outcome category, then plays', async () => {
        const { manager } = await boot();
        const hWin = manager.play('win');
        assert.ok(manager.engine.isPlaying(hWin), 'win is sounding');

        manager.playExclusive('lose');

        assert.ok(!manager.engine.isPlaying(hWin), 'the prior outcome voice was stopped');
        assert.ok(manager.engine.activeCount('outcome') >= 1, 'lose is now sounding');
    });
});

// ---------------------------------------------------------------------------
// playUnique()  (P-PU)
// ---------------------------------------------------------------------------

describe('playUnique()', () => {
    it('P-PU1 plays on the first call', async () => {
        let t = 100000;                           // a realistic performance.now
        const { manager } = await boot({ now: () => t });
        const id = manager.playUnique('hit');
        assert.equal(typeof id, 'number');
    });

    it('P-PU2 returns null on a rapid second call', async () => {
        let t = 1000;
        const { manager } = await boot({ now: () => t });
        manager.playUnique('hit', 200);
        t += 50;                                  // within the threshold
        assert.equal(manager.playUnique('hit', 200), null);
    });

    it('P-PU3 plays again once the threshold has passed', async () => {
        let t = 1000;
        const { manager } = await boot({ now: () => t });
        manager.playUnique('hit', 200);
        t += 250;                                 // past the threshold
        assert.equal(typeof manager.playUnique('hit', 200), 'number');
    });
});

// ---------------------------------------------------------------------------
// stop()  (P-S, DIV)
// ---------------------------------------------------------------------------

describe('stop()', () => {
    it('P-S1 stops a playing sound', async () => {
        const { manager } = await boot();
        const h = manager.play('hit');
        manager.stop('hit', { fade: 0 });
        assert.ok(!manager.engine.isPlaying(h));
    });

    it('P-S2 honors fade on a streamed track', async () => {
        const { manager } = await boot();
        manager.play('bgm');
        const track = manager.engine._tracks.get('bgm');
        manager.stop('bgm', { fade: 200 });
        // The track's crossfade knob was scheduled (a real fade), and playing
        // flips false immediately - the manager's fade-then-stop, on a track.
        assert.ok(paramEvents(track.xfadeGain.gain).length > 0, 'fade scheduled');
        assert.equal(manager.engine.trackPlaying('bgm').peek(), false);
    });

    it('DIV-2 stops a pooled SFX voice instantly, ignoring fade', async () => {
        const { manager } = await boot();
        const h = manager.play('hit');
        manager.stop('hit', { fade: 200 });       // fade is inert for pooled SFX
        assert.ok(!manager.engine.isPlaying(h), 'gone immediately, not after 200ms');
    });

    it('P-S3 is a no-op for an unknown sound', async () => {
        const { manager } = await boot();
        assert.doesNotThrow(() => manager.stop('nope'));
    });

    it('P-S4 is a no-op after destroy', async () => {
        const { manager } = await boot();
        manager.play('hit');
        manager.destroy();
        assert.doesNotThrow(() => manager.stop('hit'));
    });
});

// ---------------------------------------------------------------------------
// stopCategory() / stopCategories()  (P-SC, P-SCS)
// ---------------------------------------------------------------------------

describe('stopCategory() / stopCategories()', () => {
    it('P-SC1 stops every sound in a category', async () => {
        const { manager } = await boot();
        const a = manager.play('hit');
        const b = manager.play('coin');
        manager.stopCategory('sfx', { fade: 0 });
        assert.ok(!manager.engine.isPlaying(a));
        assert.ok(!manager.engine.isPlaying(b));
    });

    it('P-SC2 does not stop sounds outside the category', async () => {
        const { manager } = await boot();
        manager.play('bgm');                       // music
        const h = manager.play('hit');             // sfx
        manager.stopCategory('sfx', { fade: 0 });
        assert.equal(manager.engine.trackPlaying('bgm').peek(), true, 'music untouched');
        assert.ok(!manager.engine.isPlaying(h));
    });

    it('P-SC3 is a silent no-op for a category no sound declared', async () => {
        const { manager } = await boot();
        const h = manager.play('hit');
        assert.doesNotThrow(() => manager.stopCategory('ghost'));
        assert.ok(manager.engine.isPlaying(h), 'an unknown category stops nothing');
    });

    it('P-SCS1 stops multiple categories', async () => {
        const { manager } = await boot();
        const a = manager.play('hit');             // sfx
        const b = manager.play('win');             // outcome
        manager.stopCategories(['sfx', 'outcome'], { fade: 0 });
        assert.ok(!manager.engine.isPlaying(a));
        assert.ok(!manager.engine.isPlaying(b));
    });
});

// ---------------------------------------------------------------------------
// setMuted()  (P-M)
// ---------------------------------------------------------------------------

describe('setMuted()', () => {
    it('P-M1 updates the isMuted flag', async () => {
        const { manager } = await boot();
        manager.setMuted(true);
        assert.equal(manager.isMuted, true);
    });

    it('P-M2 drives the engine mute signal', async () => {
        const { manager } = await boot();
        manager.setMuted(true);
        assert.equal(manager.engine.muted().peek(), true);
    });

    it('P-M3 dispatches a mutechange event with the new state', async () => {
        const { manager } = await boot();
        let calls = 0;
        let detail = null;
        manager.addEventListener('mutechange', (e) => { calls++; detail = e.detail; });
        manager.setMuted(true);
        assert.equal(calls, 1);
        assert.deepEqual(detail, { isMuted: true });
    });

    it('P-M4 toggles back to unmuted', async () => {
        const { manager } = await boot();
        manager.setMuted(true);
        manager.setMuted(false);
        assert.equal(manager.isMuted, false);
        assert.equal(manager.engine.muted().peek(), false);
    });
});

// ---------------------------------------------------------------------------
// Active id tracking  (P-AT, DIV)
// ---------------------------------------------------------------------------

describe('active id tracking', () => {
    it('P-AT1 tracks concurrent plays of one sound and stops them all', async () => {
        const { manager } = await boot();
        const id1 = manager.play('hit');
        const id2 = manager.play('hit');
        assert.notEqual(id1, id2, 'each play is a distinct voice');
        manager.stop('hit', { fade: 0 });
        assert.equal(manager.engine.activeCount('sfx'), 0);
    });

    it('DIV-3 prunes ended voices via an isPlaying sweep (no per-voice end hook)', async () => {
        const { manager } = await boot();
        const h1 = manager.play('hit');
        assert.ok(manager.engine.isPlaying(h1));

        // Simulate the voice ending out-of-band (the pool exposes no 'end'
        // callback the way Howl does).
        manager.engine.stop(h1);
        assert.ok(!manager.engine.isPlaying(h1));

        // The next play sweeps the dead handle out of the name's set...
        const h2 = manager.play('hit');
        // ...and stop-by-name cleanly stops only the live voice.
        manager.stop('hit', { fade: 0 });
        assert.ok(!manager.engine.isPlaying(h2));
        assert.equal(manager.engine.activeCount('sfx'), 0);
    });
});

// ---------------------------------------------------------------------------
// destroy()  (P-D)
// ---------------------------------------------------------------------------

describe('destroy()', () => {
    it('P-D1 tears down the engine', async () => {
        const { manager } = await boot();
        manager.destroy();
        assert.equal(manager.engine._destroyed, true);
    });

    it('P-D2 is idempotent', async () => {
        const { manager } = await boot();
        manager.destroy();
        assert.doesNotThrow(() => manager.destroy());
    });

    it('P-D3 prevents play after destroy', async () => {
        const { manager } = await boot();
        manager.destroy();
        assert.equal(manager.play('hit'), null);
    });

    it('P-D4 prevents stop after destroy', async () => {
        const { manager } = await boot();
        manager.play('hit');
        manager.destroy();
        assert.doesNotThrow(() => manager.stop('hit'));
    });
});
