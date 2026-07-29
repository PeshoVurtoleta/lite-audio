/**
 * @zakkster/lite-audio/compat - lite-audio-manager drop-in adapter.
 *
 * A game built on `lite-audio-manager` (the Howler.js overlay) migrates to this
 * engine by changing exactly one import:
 *
 *     - import { audioManager } from 'lite-audio-manager';
 *     + import { audioManager } from '@zakkster/lite-audio/compat';
 *
 * The class presents the manager's surface verbatim - `init` / `play` /
 * `playExclusive` / `playUnique` / `stop` / `stopCategory` / `stopCategories` /
 * `setMuted` / `destroy`, the `isMuted` and `isUnlocked` flags, and the
 * `'mutechange'` CustomEvent on an EventTarget - over lite-audio's own engine.
 * There is NO Howler here: the shim is a pure adapter, so migrating drops a
 * runtime dependency rather than trading one for another.
 *
 * The two libraries do not line up one-to-one; every deliberate divergence is a
 * row in PARITY.md and a test in test/Compat.test.js, and the reasoning lives in
 * decisions/0007-compat-shim.md. The three that matter:
 *
 *   1. ONE sound type becomes TWO. The manager wraps everything in a Howl.
 *      lite-audio splits pooled one-shot SFX from streamed music tracks, so the
 *      shim CLASSIFIES: a config sound with `loop` or `html5` set maps to a
 *      lite-audio track (real streaming, real fades); everything else maps to a
 *      pooled SFX voice. This is the value-add - a migrant's background music
 *      stops being a looping decoded buffer and becomes an actual stream.
 *
 *   2. Categories become buses. A manager category is an arbitrary config
 *      string; lite-audio has real buses. `init` auto-creates one bus per
 *      distinct category (via createBus). A stopCategory() for a category that
 *      never appeared in the config is a silent no-op - it stops nothing, never
 *      everything, which is the fail-safe direction for a typo.
 *
 *   3. Pre-unlock plays are KEPT, not dropped. The manager returns null and
 *      drops a play fired before the audio context is running. lite-audio queues
 *      it (bounded, latest-per-sound) and flushes on the first user gesture. The
 *      shim keeps the queue: `play()` still returns the null skip-sentinel
 *      synchronously to honor the manager's type, but the play actually survives
 *      to unlock. The migrant gains a feature; nothing that relied on the null
 *      return breaks.
 */

import { effect, dispose } from '@zakkster/lite-signal';
import { LiteAudio } from './Audio.js';

/** Category name a config sound with no `category` routes to. */
const FALLBACK_BUS = 'sfx';

/** Category playExclusive() clears, byte-identical to the manager's hardcode. */
const EXCLUSIVE_CATEGORY = 'outcome';

/** Manager stop() default fade, in ms. Honored for tracks, inert for SFX. */
const DEFAULT_FADE_MS = 120;

/**
 * Build the mute-change event. `CustomEvent` is a browser global and a Node
 * global from v19; on older Node we fall back to a plain Event carrying the
 * same `.detail`, so a listener reading `e.detail.isMuted` works everywhere and
 * the shim keeps its zero-dependency promise.
 * @param {boolean} isMuted
 */
function muteEvent(isMuted) {
    const detail = { isMuted };
    if (typeof CustomEvent === 'function') {
        return new CustomEvent('mutechange', { detail });
    }
    const e = new Event('mutechange');
    e.detail = detail;
    return e;
}

/**
 * Drop-in replacement for lite-audio-manager's AudioManager, backed by
 * lite-audio. Same surface, same `lite_audio_muted` storage key, same
 * `'mutechange'` event.
 */
export class AudioManager extends EventTarget {
    /** @type {LiteAudio} */
    #audio;

    /** Injected AudioContext for init(), or null to let the engine create one. */
    #context;

    /** performance.now-shaped clock for the playUnique() throttle. */
    #now;

    /** Original init() config, keyed by sound name - drives stopCategory(). */
    #config = {};

    /** Names classified as streamed tracks (loop/html5), not pooled SFX. */
    #trackNames = new Set();

    /** name -> Set<handle> of live pooled SFX voices, for stop-by-name. */
    #activeIds = new Map();

    /** name -> last play timestamp, for the playUnique() throttle. */
    #lastPlayed = new Map();

    /** Monotonic id handed back from play() for a track (a track has no handle). */
    #trackPlayId = 0;

    /** The signal effect that re-emits 'mutechange'; disposed on destroy. */
    #muteEffect = null;

    /** Resolves when the async init() setup (context, buses, decode) settles. */
    #ready = Promise.resolve();

    #initialized = false;
    #destroyed = false;

    /**
     * @param {Object} [opts] - forwarded to LiteAudio (buses, poolCapacity,
     *   queueLimit, mutedStorageKey, window, document, fetch, setTimeout,
     *   clearTimeout). Two shim-only extras are consumed here and not passed on:
     * @param {Object} [opts.context] - AudioContext for init(); default: engine
     *   creates one from globalThis.AudioContext. Injected in tests.
     * @param {Function} [opts.now] - performance.now-shaped clock for the
     *   playUnique throttle. Default: performance.now.
     */
    constructor(opts = {}) {
        super();

        const { context = null, now, ...audioOpts } = opts;
        this.#context = context;
        this.#now = now || (() => performance.now());

        // Start with NO default buses: the shim creates exactly the buses the
        // config's categories name, so there are no phantom 'ui'/'voice' buses a
        // manager config never asked for. A category-less sound routes to a
        // fallback bus the setup creates on demand.
        if (audioOpts.buses === undefined) audioOpts.buses = [];
        this.#audio = new LiteAudio(audioOpts);

        // Re-emit 'mutechange' on every mute transition, from any source (our
        // setMuted, or a direct engine mute). An effect fires once on creation;
        // that first run only establishes the dependency - skip its dispatch so
        // constructing the shim does not announce a mute change nobody made.
        let first = true;
        this.#muteEffect = effect(() => {
            const m = this.#audio.muted()();          // read + subscribe
            if (first) { first = false; return; }
            this.dispatchEvent(muteEvent(m));
        });
    }

    /** Current global mute state. Reads the engine's mute signal. */
    get isMuted() { return this.#audio.muted().peek(); }

    /** Whether the context has been unlocked by a user gesture. */
    get isUnlocked() { return this.#audio.unlocked().peek(); }

    /**
     * Initialize with a sound configuration map: `{ name: { src, category?,
     * pitchVar?, loop?, html5?, volume? } }`. Same shape the manager takes.
     *
     * SYNCHRONOUS FACADE over async work. The manager's Howls preload
     * fire-and-forget and `init` returns immediately; here, wiring the context
     * and decoding buffers is genuinely async, so `init` kicks that off without
     * blocking and returns. A play() fired before setup settles is queued by the
     * engine and flushed when it is ready (see the pre-unlock note up top).
     * Tests that need to assert on a loaded sound await `whenReady()`.
     *
     * Additive per call, like the manager: a second init() adds only sounds not
     * already registered.
     * @param {Object<string, Object>} [config]
     */
    init(config = {}) {
        if (this.#destroyed) return;
        // Merge into the running config so stopCategory() sees every sound.
        for (const [name, opt] of Object.entries(config)) {
            if (this.#config[name] === undefined) this.#config[name] = opt;
        }
        this.#initialized = true;
        // Chain onto any prior setup so overlapping init() calls serialize.
        this.#ready = this.#ready.then(() => this.#setup(config));
    }

    /** Resolves when the most recent init()'s setup has settled. Shim extension. */
    whenReady() { return this.#ready; }

    /**
     * Wire the engine, create a bus per category, and partition the config into
     * pooled SFX (defineSounds) and streamed tracks (defineTracks). Idempotent:
     * engine init, createBus and defineSounds all skip work already done.
     * @param {Object<string, Object>} config
     */
    async #setup(config) {
        if (this.#destroyed) return;

        await this.#audio.init(this.#context || undefined);

        // One bus per distinct category, plus the fallback if any sound omitted
        // its category. 'master' is reserved and cannot be a bus, so a sound
        // that named it as a category is routed to the fallback instead.
        const categories = new Set();
        let needFallback = false;
        for (const opt of Object.values(config)) {
            const cat = opt && opt.category;
            if (cat && cat !== 'master') categories.add(cat);
            else needFallback = true;
        }
        if (needFallback) categories.add(FALLBACK_BUS);
        for (const cat of categories) this.#audio.createBus(cat);   // idempotent

        const sfxConfig = {};
        const trackConfig = {};
        for (const [name, rawOpt] of Object.entries(config)) {
            const opt = rawOpt || {};
            const cat = opt.category && opt.category !== 'master' ? opt.category : FALLBACK_BUS;

            // Classify: a looping or html5 (streaming) sound is music -> a
            // lite-audio track; a one-shot is a pooled SFX voice.
            if (opt.loop || opt.html5) {
                this.#trackNames.add(name);
                trackConfig[name] = {
                    src: opt.src || [],
                    bus: cat,
                    volume: opt.volume ?? 1,
                    loop: !!opt.loop,
                };
            } else {
                sfxConfig[name] = {
                    src: opt.src || [],
                    bus: cat,
                    volume: opt.volume ?? 1,
                    pitchVar: opt.pitchVar ?? 0,
                };
            }
        }

        if (Object.keys(sfxConfig).length) await this.#audio.defineSounds(sfxConfig);
        if (Object.keys(trackConfig).length) await this.#audio.defineTracks(trackConfig);
    }

    // ---------- Playback ---------------------------------------------------

    /**
     * Play a sound by name.
     * @param {string} name
     * @param {Object} [options]
     * @param {number} [options.volume=1]
     * @param {boolean} [options.loop=false] - honored only for track sounds; a
     *   pooled SFX voice does not loop (route looping audio through config).
     * @param {number} [options.pitchVar=0]
     * @param {number|null} [options.pitch=null] - explicit rate; wins over pitchVar.
     * @returns {number|null} a handle-shaped number, or null if skipped/queued.
     */
    play(name, { volume = 1, loop = false, pitchVar = 0, pitch = null } = {}) {
        if (this.#destroyed) return null;

        if (this.#trackNames.has(name)) {
            // A track is a name-addressed singleton with no per-play handle; hand
            // back a monotonic positive id so the manager's `number|null` return
            // contract holds and the caller can tell "played" from "skipped".
            this.#audio.playTrack(name, {});
            return ++this.#trackPlayId;
        }

        // Resolve rate: explicit pitch overrides random pitchVar, matching the
        // manager's precedence exactly.
        let rate = 1;
        if (pitch !== null) rate = pitch;
        else if (pitchVar > 0) rate = 1 + (Math.random() - 0.5) * 2 * pitchVar;

        // The engine returns -1 on any skip (unknown/not-ready sound, or a
        // pre-unlock play it just queued). Normalize that to the manager's null.
        const handle = this.#audio.play(name, volume, 0, rate);
        if (handle < 0) return null;

        this.#trackActiveId(name, handle);
        return handle;
    }

    /**
     * Play a sound exclusively - stops the 'outcome' category first, then plays.
     * The 'outcome' category name is the manager's hardcode, preserved verbatim.
     * @param {string} name
     * @param {Object} [options]
     * @returns {number|null}
     */
    playExclusive(name, options = {}) {
        this.stopCategory(EXCLUSIVE_CATEGORY);
        return this.play(name, options);
    }

    /**
     * Play a sound only if it has not played within `threshold` ms - the
     * machine-gun guard for rapid-fire SFX.
     * @param {string} name
     * @param {number} [threshold=100]
     * @returns {number|null}
     */
    playUnique(name, threshold = 100) {
        const now = this.#now();
        const last = this.#lastPlayed.get(name) ?? 0;
        if (now - last > threshold) {
            this.#lastPlayed.set(name, now);
            return this.play(name);
        }
        return null;
    }

    // ---------- Stopping ---------------------------------------------------

    /**
     * Stop a sound by name.
     * @param {string} name
     * @param {Object} [options]
     * @param {number} [options.fade=120] - honored for a track (real fade); a
     *   pooled SFX voice stops instantly (the engine has no per-voice envelope
     *   on its zero-GC hot path), so `fade` is inert for SFX. See PARITY DIV-2.
     */
    stop(name, { fade = DEFAULT_FADE_MS } = {}) {
        if (this.#destroyed) return;

        if (this.#trackNames.has(name)) {
            this.#audio.stopTrack(name, { fade });
            return;
        }

        const ids = this.#activeIds.get(name);
        if (!ids || ids.size === 0) return;
        for (const handle of [...ids]) {
            this.#audio.stop(handle);   // no-op if the voice already ended/was stolen
            ids.delete(handle);
        }
        this.#activeIds.delete(name);
    }

    /**
     * Stop every sound in a category. Resolves membership from the init config,
     * exactly like the manager. A category no sound declared stops nothing.
     * @param {string} categoryName
     * @param {Object} [options]
     */
    stopCategory(categoryName, options = {}) {
        for (const [name, settings] of Object.entries(this.#config)) {
            if (settings && settings.category === categoryName) this.stop(name, options);
        }
    }

    /**
     * Stop every sound across multiple categories.
     * @param {string[]} categories
     * @param {Object} [options]
     */
    stopCategories(categories, options = {}) {
        for (const cat of categories) this.stopCategory(cat, options);
    }

    // ---------- Global state -----------------------------------------------

    /**
     * Set the global mute state. Persists to the shared `lite_audio_muted` key
     * (the engine's mute effect writes it) and emits 'mutechange' (the shim's
     * mute effect dispatches it).
     * @param {boolean} [state=true]
     */
    setMuted(state = true) {
        this.#audio.setMuted(!!state);
    }

    // ---------- Teardown ---------------------------------------------------

    /**
     * Stop everything, dispose the mute effect, tear down the engine, and drop
     * references. Idempotent.
     */
    destroy() {
        if (this.#destroyed) return;
        this.#destroyed = true;

        if (this.#muteEffect) { try { dispose(this.#muteEffect); } catch {} this.#muteEffect = null; }
        try { this.#audio.destroy(); } catch {}

        this.#activeIds.clear();
        this.#trackNames.clear();
        this.#lastPlayed.clear();
        this.#config = {};
    }

    // ---------- Escape hatch -----------------------------------------------

    /**
     * The underlying engine, for code ready to move past the manager surface -
     * buses, ducking, snapshots, meters, streamed crossfades. The shim is a
     * migration bridge, not a ceiling.
     * @returns {LiteAudio}
     */
    get engine() { return this.#audio; }

    // ---------- Internals --------------------------------------------------

    /**
     * Record a live SFX handle under its sound name, pruning any handles whose
     * voices have since ended or been stolen. The pool exposes no per-voice
     * 'end' callback (the manager leans on Howl's), so instead of hooking an
     * event we sweep isPlaying() on each play - O(voices-per-name), bounded by
     * the pool capacity, and enough to keep the set from growing across a
     * session. See PARITY DIV-3.
     * @param {string} name
     * @param {number} handle
     */
    #trackActiveId(name, handle) {
        let ids = this.#activeIds.get(name);
        if (!ids) { ids = new Set(); this.#activeIds.set(name, ids); }
        for (const old of [...ids]) {
            if (!this.#audio.isPlaying(old)) ids.delete(old);
        }
        ids.add(handle);
    }
}

/** Default singleton, for the plug-and-play `import { audioManager }` swap. */
export const audioManager = new AudioManager();

export default AudioManager;
