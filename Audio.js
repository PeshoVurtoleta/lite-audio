/** @zakkster/lite-audio - Zero-GC reactive Web Audio engine */

import { signal, effect, batch, dispose } from '@zakkster/lite-signal';
import { AudioPool } from '@zakkster/lite-audio-pool';

/**
 * Persistence key: byte-identical to lite-audio-manager so a game migrating
 * from the manager to lite-audio does not lose the player's saved mute
 * preference. Do not rename without a migration path.
 */
const MUTED_STORAGE_KEY = 'lite_audio_muted';

/**
 * Time constants held under lite-audio's roof. FADE_SECONDS is our default
 * for non-emergency stops - short enough to feel instant, long enough to
 * avoid clicks. RAMP_TC is the setTargetAtTime time constant for bus writes
 * (D1): 10ms means the mixer settles ~63% within 10ms and effectively fully
 * within 30ms, imperceptible to a listener but click-free.
 */
const FADE_SECONDS = 0.02;
const RAMP_TC = 0.01;

/**
 * Handle namespace. A pool handle is a full uint32 - [gen:24][channel:8] - with no
 * spare bits, and every bus runs its own pool counting generations from zero. So the
 * first play on EVERY bus returns the same uint32 (channel 0, generation 0), and a
 * handle alone cannot say which bus issued it. The engine therefore tags the bus
 * above the pool's 32 bits: handle = busIndex * 2^32 + poolHandle.
 *
 * Handles stay plain numbers, exact to 2^53, which leaves room for 2^21 buses. The
 * low half round-trips through ToUint32 for free (h >>> 0), so decoding costs one
 * shift and one divide, and stop() becomes an O(1) lookup instead of a broadcast
 * across every pool hoping the generation check rejects the wrong ones.
 */
const BUS_STRIDE = 4294967296;   // 2^32

/**
 * playUnique() returns a handle for a sound. Tracks have no handle - they are
 * singletons addressed by name - so it needs a way to say "the track started"
 * that is not a number stop() would act on. It cannot be 0: that is a perfectly
 * good handle (bus 0, channel 0, generation 0). Negative values are inert to
 * stop(), and -1 already means "skipped", so a track start reports -2.
 */
const TRACK_STARTED = -2;

/**
 * The unlock queue is bounded to bound worst-case memory: if a spammy loop
 * calls play() a thousand times before the first user gesture, we do not
 * want that to become a thousand-voice burst on unlock. Latest-per-sound
 * so the most recent intent wins.
 */
const DEFAULT_QUEUE_LIMIT = 32;

/**
 * DOM events wired at capture phase to intercept the very first user gesture
 * on iOS/Safari, exact set the manager uses. Do not add 'click' - some pages
 * dispatch synthetic clicks that would falsely resume the context.
 */
const UNLOCK_EVENTS = ['touchstart', 'touchend', 'mousedown', 'keydown'];

/**
 * Storage-safe read (SSR / Workers / sandboxed iframes / Safari private mode).
 * @param {string} key
 * @param {any} fallback
 */
function readStorage(key, fallback) {
    try {
        if (typeof localStorage === 'undefined') return fallback;
        const v = localStorage.getItem(key);
        return v === null ? fallback : v;
    } catch { return fallback; }
}

function writeStorage(key, value) {
    try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(key, String(value));
    } catch { /* Safari private mode / storage disabled */ }
}

/**
 * Equal-power crossfade curves, precomputed once at module load. Both curves
 * are 128 samples over t in [0, 1]. Scaled per crossfade to whatever the
 * outgoing gain's current value is (so a mid-crossfade retarget starts from
 * where the track actually is, not from a hardcoded 1.0). Allocations here
 * are one Float32Array per crossfade side - a scene transition, not a hot
 * path. The pool underneath still does the zero-GC work.
 */
const CROSSFADE_SAMPLES = 128;
const EQ_POWER_IN = new Float32Array(CROSSFADE_SAMPLES);
const EQ_POWER_OUT = new Float32Array(CROSSFADE_SAMPLES);
for (let i = 0; i < CROSSFADE_SAMPLES; i++) {
    const t = i / (CROSSFADE_SAMPLES - 1);
    EQ_POWER_IN[i] = Math.sin(t * Math.PI / 2);
    EQ_POWER_OUT[i] = Math.cos(t * Math.PI / 2);
}

/**
 * Scale an equal-power curve to a desired range [start, start+delta]. Used
 * for both fade-in (start=current, delta=target-current) and fade-out
 * (start=0, delta=current), and correctly handles mid-crossfade retargets
 * where the current xfadeGain value is somewhere between 0 and 1.
 */
function scaleCurve(base, delta, start) {
    const out = new Float32Array(base.length);
    for (let i = 0; i < base.length; i++) out[i] = start + base[i] * delta;
    return out;
}

/** Position signal write throttle: >= 100 ms of ctx time between writes. */
const POSITION_WRITE_INTERVAL = 0.1;

/** Default fade durations in seconds (converted to ms at the API boundary). */
const DEFAULT_TRACK_FADE_MS = 200;

/** Gain restore ramp used by resumeTrack(). Long enough not to click, short
 *  enough that "resume" still feels immediate. */
const RESUME_FADE_MS = 40;

// ---------- Loader ---------------------------------------------------------

/**
 * Format-fallback probe. Given a list of URLs like ['a.webm', 'b.mp3'], picks
 * the first one whose extension the runtime claims to support via a
 * throwaway <audio>.canPlayType('audio/<ext>') check. In Node or environments
 * without <audio>, all URLs are considered supported and the first wins.
 */
function pickSupportedSrc(srcs) {
    if (!Array.isArray(srcs) || srcs.length === 0) return null;
    if (typeof document === 'undefined' || typeof Audio === 'undefined') return srcs[0];
    let probe;
    try { probe = new Audio(); } catch { return srcs[0]; }
    for (const url of srcs) {
        const ext = extensionOf(url);
        const mime = ext ? MIME_BY_EXT[ext] : null;
        if (!mime) continue;
        const verdict = probe.canPlayType(mime);
        if (verdict === 'probably' || verdict === 'maybe') return url;
    }
    return srcs[0];   // fall back to first if nothing matched, best-effort
}

const MIME_BY_EXT = {
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    opus: 'audio/ogg; codecs=opus',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    webm: 'audio/webm',
    flac: 'audio/flac',
};

function extensionOf(url) {
    const m = /\.([a-z0-9]{2,5})(\?|#|$)/i.exec(url);
    return m ? m[1].toLowerCase() : null;
}

// ---------- Engine ---------------------------------------------------------

/**
 * lite-audio v1.0.0 engine. SFX layer over @zakkster/lite-audio-pool, one
 * pool per bus. Signals drive continuous state (bus volumes, master mute,
 * context state, load state); one-shots stay imperative through play().
 *
 * The typical lifecycle:
 *   const audio = new LiteAudio({ buses: ['sfx', 'ui'] });
 *   await audio.init(new AudioContext());
 *   await audio.defineSounds({ laser: { src: ['/laser.mp3'], bus: 'sfx' } });
 *   const h = audio.play('laser', 1, 0, 1);
 *   audio.stop(h);
 *   audio.destroy();
 *
 * Everything past init() is safe to call before unlock: play() enqueues,
 * defineSounds() starts fetching, bus volumes accept writes. The unlock
 * gesture flushes the queue and starts the audible clock.
 */
export class LiteAudio {
    /**
     * @param {Object} [opts]
     * @param {string[]} [opts.buses=['sfx','ui','voice']] - Bus names. 'master' is implicit.
     * @param {number} [opts.poolCapacity=32] - Voices per bus pool.
     * @param {number} [opts.queueLimit=32] - Bound on pre-unlock play queue.
     * @param {string} [opts.mutedStorageKey='lite_audio_muted'] - localStorage key.
     * @param {Function} [opts.fetch] - Injectable for tests. Defaults to globalThis.fetch.
     * @param {Object} [opts.window] - Injectable for tests. Defaults to globalThis.window.
     * @param {Object} [opts.document] - Injectable for tests. Defaults to globalThis.document.
     */
    constructor(opts = {}) {
        this._busNames = opts.buses || ['sfx', 'ui', 'voice', 'music'];
        this._poolCapacity = opts.poolCapacity ?? 32;
        this._queueLimit = opts.queueLimit ?? DEFAULT_QUEUE_LIMIT;
        this._mutedKey = opts.mutedStorageKey ?? MUTED_STORAGE_KEY;
        this._fetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
        this._window = opts.window ?? (typeof window !== 'undefined' ? window : null);
        this._document = opts.document ?? (typeof document !== 'undefined' ? document : null);
        // Test-injectable timers. Real setTimeout/clearTimeout in production;
        // a manual scheduler in tests so pause-after-fade is deterministic.
        this._setTimeout = opts.setTimeout || ((cb, ms) => setTimeout(cb, ms));
        this._clearTimeout = opts.clearTimeout || ((id) => clearTimeout(id));

        // Read persisted mute BEFORE constructing the master signal so the
        // very first emitted value already carries the user's preference.
        const initialMuted = readStorage(this._mutedKey, 'false') === 'true';

        // Public signals (readable via getter methods). Callable getters +
        // .set/.peek; effects can depend on these directly.
        this._sMuted = signal(initialMuted);
        this._sUnlocked = signal(false);
        this._sCtxState = signal('suspended');

        // Per-bus state, populated in init(). Each entry:
        //   { index, gain, volume:signal, muted:signal, pool, effectHandle }
        this._buses = new Map();

        // Index -> bus record, so a handle's bus tag resolves in O(1).
        this._busList = [];

        // Per-sound state, populated by defineSounds():
        //   { srcs:[], busName, buffer, spriteId, loadState:signal, volume, pitchVar }
        this._sounds = new Map();

        // Per-track state, populated by defineTracks(). Music tracks are
        // singletons - one instance per registered name. See _makeTrackRecord.
        this._tracks = new Map();

        // Timestamp map for playUnique(). Manager parity: keyed by name, holds
        // performance.now() (or ctx-clock fallback). Applies to sounds AND tracks.
        this._lastPlayed = new Map();

        // Reverse index: bus name -> array of soundIds routed to that bus.
        // Rebuilt after every defineSounds so pools know their sprite map.
        this._soundsByBus = new Map();

        // Pre-unlock play queue. Map key is soundId (latest-per-sound wins).
        // Bounded by _queueLimit.
        this._pendingPlays = new Map();

        // Effect handles kept so destroy() can dispose them cleanly.
        this._effectHandles = [];

        // Unlock/lifecycle AbortControllers - same shape as the manager.
        this._unlockAbort = null;
        this._lifecycleAbort = null;

        this._ctx = null;
        this._master = null;
        this._destroyed = false;
        this._initialized = false;
    }

    // ---------- Lifecycle --------------------------------------------------

    /**
     * Wire the engine to an AudioContext. Idempotent per-instance; a second
     * call with a different context throws (destroy first). If no context is
     * passed, one is created from globalThis.AudioContext.
     *
     * After init() the master and bus GainNodes exist and their bus->volume
     * effects are wired. The unlock listeners are attached only if a window
     * is available (test environments can skip by omitting `window`).
     */
    async init(ctx) {
        if (this._destroyed) throw new Error('LiteAudio: destroyed');
        if (this._initialized) {
            if (ctx && ctx !== this._ctx) throw new Error('LiteAudio: already bound to a different context');
            return;
        }

        this._ctx = ctx || new (globalThis.AudioContext || globalThis.webkitAudioContext)();
        this._sCtxState.set(this._ctx.state);
        if (this._ctx.state === 'running') this._sUnlocked.set(true);

        // Master GainNode is the top of the bus tree; user buses feed into it,
        // and the master's own gain reflects the master mute signal.
        this._master = this._ctx.createGain();
        this._master.connect(this._ctx.destination);

        // Master mute effect: writes to master gain via setTargetAtTime for
        // click-free transitions. Also persists to storage on write.
        const masterEffect = effect(() => {
            const muted = this._sMuted();
            const target = muted ? 0 : 1;
            const t = this._ctx.currentTime;
            this._master.gain.setTargetAtTime(target, t, RAMP_TC);
            writeStorage(this._mutedKey, muted);
        });
        this._effectHandles.push(masterEffect);

        // Build each user bus: GainNode -> master, plus a per-bus volume+muted
        // effect that writes to gain via setTargetAtTime.
        for (const name of this._busNames) {
            if (name === 'master') continue;    // reserved name; use master directly
            const gain = this._ctx.createGain();
            gain.connect(this._master);
            const sVol = signal(1);
            const sMut = signal(false);
            const busEffect = effect(() => {
                const v = sVol();
                const m = sMut();
                const target = m ? 0 : v;
                gain.gain.setTargetAtTime(target, this._ctx.currentTime, RAMP_TC);
            });
            this._effectHandles.push(busEffect);
            const busRec = {
                index: this._busList.length,
                gain, volume: sVol, muted: sMut, effect: busEffect, pool: null,
            };
            this._buses.set(name, busRec);
            this._busList.push(busRec);
        }

        // Ctx state effect: mirror external state changes into our signal so
        // downstream effects (auto-suspend, HUD, etc.) can react.
        if (typeof this._ctx.addEventListener === 'function') {
            const onStatechange = () => this._sCtxState.set(this._ctx.state);
            this._ctx.addEventListener('statechange', onStatechange);
            this._statechangeHandler = onStatechange;
        }

        // Wire unlock and visibility handlers, if we have a DOM.
        if (this._window) this._setupUnlock();
        if (this._document) this._setupVisibilityResume();

        this._initialized = true;
    }

    /**
     * Attach unlock listeners at capture phase (D3, verbatim port from the
     * manager's semantics). The first qualifying gesture fires a silent buffer
     * pulse, calls ctx.resume(), sets the unlocked signal, and flushes any
     * play() calls the caller queued while locked.
     */
    _setupUnlock() {
        this._unlockAbort = new AbortController();

        const unlock = async () => {
            if (this._sUnlocked.peek()) return;
            const ctx = this._ctx;
            if (!ctx) return;

            if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
                // Silent buffer pulse: forces the hardware pipeline open on
                // iOS Safari, which otherwise treats a resume() alone as a
                // no-op the first time.
                try {
                    const buf = ctx.createBuffer(1, 1, 22050);
                    const src = ctx.createBufferSource();
                    src.buffer = buf;
                    src.connect(ctx.destination);
                    src.start(0);
                } catch { /* some mock contexts may not implement createBuffer fully */ }

                try {
                    await ctx.resume();
                } catch { /* resume rejected - keep trying on next gesture */ return; }
            }
            // Post-resume: if we made it here without an error, unlock succeeded.
            batch(() => {
                this._sUnlocked.set(true);
                this._sCtxState.set(ctx.state);
            });
            this._unlockAbort.abort();
            this._flushQueue();
        };

        for (const evt of UNLOCK_EVENTS) {
            this._window.addEventListener(evt, unlock, {
                capture: true,
                signal: this._unlockAbort.signal,
            });
        }
    }

    _setupVisibilityResume() {
        this._lifecycleAbort = new AbortController();
        this._document.addEventListener('visibilitychange', () => {
            if (!this._document.hidden && this._ctx?.state === 'suspended') {
                this._ctx.resume().catch(() => {});
            }
        }, { signal: this._lifecycleAbort.signal });
    }

    // ---------- Loader -----------------------------------------------------

    /**
     * Fetch and decode a set of sounds. Sound configs have shape:
     *   { src: [url, ...], bus?: string, volume?: number, pitchVar?: number }
     *
     * Returns a promise that resolves when every sound has settled (loaded or
     * errored). Load state per sound is tracked in a signal readable via
     * loadState(soundId).
     *
     * Pools are built (or rebuilt) after all sounds in this batch settle, so
     * a bus's sprite map covers everything currently loaded for it.
     */
    async defineSounds(config) {
        if (this._destroyed) throw new Error('LiteAudio: destroyed');
        if (!this._initialized) throw new Error('LiteAudio: init() before defineSounds()');
        if (!config) return;

        const busesTouched = new Set();
        const loadPromises = [];

        for (const [soundId, cfg] of Object.entries(config)) {
            if (this._sounds.has(soundId)) continue;                // idempotent

            const busName = cfg.bus || 'sfx';
            if (!this._buses.has(busName)) {
                throw new Error(`LiteAudio: sound "${soundId}" routed to unknown bus "${busName}"`);
            }

            const sState = signal('idle');
            const record = {
                soundId,
                srcs: cfg.src || [],
                busName,
                volume: cfg.volume ?? 1,
                pitchVar: cfg.pitchVar ?? 0,
                buffer: null,
                loadState: sState,
            };
            this._sounds.set(soundId, record);
            busesTouched.add(busName);

            loadPromises.push(this._loadOne(record));
        }

        await Promise.all(loadPromises);

        // Rebuild sound-by-bus reverse index for the buses we touched.
        for (const busName of busesTouched) {
            const ids = [];
            for (const [id, rec] of this._sounds) {
                if (rec.busName === busName && rec.loadState.peek() === 'ready') ids.push(id);
            }
            this._soundsByBus.set(busName, ids);
        }

        // Build/rebuild the pool for each touched bus. Rebuilding tears down
        // the previous pool cleanly (its destroy() disconnects nodes), which
        // is why the pool's destroy() had to be fixed to actually disconnect
        // - see lite-audio-pool CHANGELOG 1.1.0.
        for (const busName of busesTouched) {
            const busRec = this._buses.get(busName);
            if (busRec.pool) { busRec.pool.destroy(); busRec.pool = null; }

            const ids = this._soundsByBus.get(busName) || [];
            if (ids.length === 0) continue;                          // nothing loaded

            const spriteMap = {};
            for (const id of ids) {
                const rec = this._sounds.get(id);
                spriteMap[id] = { start: 0, duration: rec.buffer.duration };
            }
            // Pool's default buffer is a dummy - every play passes an explicit
            // per-play buffer, which is why we asked the pool to grow that arg
            // in v1.1.0. spriteMap only needs to name what CAN be played.
            const dummyBuffer = ids.length > 0 ? this._sounds.get(ids[0]).buffer : null;
            busRec.pool = new AudioPool(
                this._ctx, dummyBuffer, spriteMap, this._poolCapacity, busRec.gain
            );
        }

        // Flush the queue in case sounds arrived after the user gesture:
        // plays that were queued because the sound was still loading can now
        // fire. flushQueue is a no-op if unlock is not yet in.
        this._flushQueue();
    }

    async _loadOne(record) {
        const url = pickSupportedSrc(record.srcs);
        if (!url) { record.loadState.set('error'); return; }
        if (!this._fetch) { record.loadState.set('error'); return; }

        record.loadState.set('loading');
        try {
            const resp = await this._fetch(url);
            if (!resp || !resp.ok) throw new Error(`fetch failed: ${resp?.status ?? '?'}`);
            const bytes = await resp.arrayBuffer();
            const buf = await this._ctx.decodeAudioData(bytes);
            record.buffer = buf;
            record.loadState.set('ready');
        } catch {
            record.loadState.set('error');
        }
    }

    // ---------- Playback ---------------------------------------------------

    /**
     * Positional hot path (D5). Returns the pool's generation-stamped handle,
     * or -1 on any skip (unknown sound, not-ready sound, context locked).
     * When locked, the call is enqueued (bounded, latest-per-sound) instead
     * of dropped - the queue is flushed on unlock.
     */
    play(soundId, volume = 1, pan = 0, pitch = 1) {
        if (this._destroyed) return -1;
        const rec = this._sounds.get(soundId);
        if (!rec) return -1;

        // If not unlocked yet, queue the intent and return -1. The caller can
        // observe unlocked() and re-decide, but a good game just fires - the
        // queue turns pre-gesture plays into post-gesture plays automatically.
        if (!this._sUnlocked.peek() || rec.loadState.peek() !== 'ready') {
            this._enqueue(soundId, volume, pan, pitch);
            return -1;
        }

        const busRec = this._buses.get(rec.busName);
        if (!busRec || !busRec.pool) return -1;

        // Per-play buffer override (pool v1.1.0): the pool is constructed
        // with a dummy default buffer; we always pass the sound's own buffer.
        const poolHandle = busRec.pool.play(soundId, volume, pan, pitch, rec.buffer);
        if (poolHandle < 0) return -1;
        return busRec.index * BUS_STRIDE + poolHandle;
    }

    /**
     * Sugar over play(): options object + pitchVar resolution. Not the hot
     * path - a frame loop should call the positional play() directly.
     */
    playOpts(soundId, opts = {}) {
        const rec = this._sounds.get(soundId);
        const vol = opts.volume ?? rec?.volume ?? 1;
        const pan = opts.pan ?? 0;
        let pitch = opts.pitch ?? 1;
        const pv = opts.pitchVar ?? rec?.pitchVar ?? 0;
        if (opts.pitch == null && pv > 0) {
            pitch = 1 + (Math.random() * 2 - 1) * pv;
        }
        return this.play(soundId, vol, pan, pitch);
    }

    /**
     * Stop a specific play by its pool handle. Because pool handles are
     * generation-stamped, a stale handle from a stolen voice is a silent
     * no-op - the guarantee we shipped in pool v1.1.0.
     * @param {number} handle
     */
    stop(handle) {
        if (this._destroyed || handle < 0) return;
        const busRec = this._busList[(handle / BUS_STRIDE) | 0];
        if (!busRec || !busRec.pool) return;
        busRec.pool.stop(handle >>> 0);
    }

    /**
     * Is this exact voice still sounding? False once its channel was stolen,
     * stopped, or played out - and false for a handle the named bus never issued.
     * @param {number} handle
     * @returns {boolean}
     */
    isPlaying(handle) {
        if (this._destroyed || handle < 0) return false;
        const busRec = this._busList[(handle / BUS_STRIDE) | 0];
        if (!busRec || !busRec.pool) return false;
        return busRec.pool.isPlaying(handle >>> 0);
    }

    /**
     * Which bus issued this handle, or null.
     * @param {number} handle
     * @returns {string|null}
     */
    busOf(handle) {
        if (handle < 0) return null;
        const index = (handle / BUS_STRIDE) | 0;
        for (const [name, busRec] of this._buses) {
            if (busRec.index === index) return name;
        }
        return null;
    }

    /**
     * SFX voices currently sounding on a bus, or across every bus with no argument.
     * Tracks are not voices and are not counted - ask trackPlaying(name).
     * Allocation-free; safe to call every frame.
     * @param {string} [busName]
     * @returns {number}
     */
    activeCount(busName) {
        if (this._destroyed) return 0;
        if (busName !== undefined) {
            const busRec = this._buses.get(busName);
            return busRec?.pool ? busRec.pool.activeCount() : 0;
        }
        let n = 0;
        for (let i = 0; i < this._busList.length; i++) {
            const pool = this._busList[i].pool;
            if (pool) n += pool.activeCount();
        }
        return n;
    }

    /**
     * Stop every voice on a named bus - SFX voices AND any music track routed there.
     * Before v1.1.0 a bus held nothing but pool voices; now that tracks share the bus
     * graph, "stop the bus" has to mean the bus, or a scene change leaves the theme
     * playing under the next scene.
     * @param {string} busName
     * @param {Object} [opts]
     * @param {number} [opts.fade=200] - fade for tracks on this bus, ms
     */
    stopBus(busName, opts = {}) {
        if (this._destroyed) return;
        const busRec = this._buses.get(busName);
        if (!busRec) return;
        if (busRec.pool) busRec.pool.stopAll();

        const fade = opts.fade ?? DEFAULT_TRACK_FADE_MS;
        for (const [name, rec] of this._tracks) {
            if (rec.busName === busName && rec.playing.peek()) this.stopTrack(name, { fade });
        }
    }

    /**
     * Stop every voice on every bus, and fade out every playing track.
     * @param {Object} [opts]
     * @param {number} [opts.fade=200] - fade for tracks, ms
     */
    stopAll(opts = {}) {
        if (this._destroyed) return;
        for (const [, busRec] of this._buses) {
            if (busRec.pool) busRec.pool.stopAll();
        }
        const fade = opts.fade ?? DEFAULT_TRACK_FADE_MS;
        for (const [name, rec] of this._tracks) {
            if (rec.playing.peek()) this.stopTrack(name, { fade });
        }
    }

    // =========================================================================
    // Music layer (v1.1.0). MediaElementSource-based streaming tracks routed
    // through the same bus graph as SFX. Tracks are singletons - one instance
    // per registered name - and addressed by name for stop/crossfade/position.
    // =========================================================================

    /**
     * Register a set of music tracks. Same shape as defineSounds, plus:
     *   { loop?, loopStart?, loopEnd? }.
     * Tracks are streamed (MediaElementAudioSourceNode) rather than decoded
     * into memory - a 5-minute track becomes ~800 KB of HTTP stream, not
     * 50 MB of PCM.
     *
     * Resolves once every track has settled (ready or error). Load state per
     * track is a signal readable via trackLoadState(name).
     */
    async defineTracks(config) {
        if (this._destroyed) throw new Error('LiteAudio: destroyed');
        if (!this._initialized) throw new Error('LiteAudio: init() before defineTracks()');
        if (!config) return;

        const loadPromises = [];
        for (const [name, cfg] of Object.entries(config)) {
            if (this._tracks.has(name)) continue;

            const busName = cfg.bus || 'music';
            if (!this._buses.has(busName)) {
                throw new Error(`LiteAudio: track "${name}" routed to unknown bus "${busName}"`);
            }

            const rec = this._makeTrackRecord(name, cfg, busName);
            this._tracks.set(name, rec);
            loadPromises.push(this._loadTrack(rec));
        }
        await Promise.all(loadPromises);
    }

    /**
     * Track record shape - kept private so callers cannot reach into the
     * graph directly. Everything a UI needs is exposed via signal accessors.
     */
    _makeTrackRecord(name, cfg, busName) {
        return {
            name,
            srcs: cfg.src || [],
            busName,
            volume: cfg.volume ?? 1,
            loop: !!cfg.loop,
            loopStart: cfg.loopStart ?? null,
            loopEnd: cfg.loopEnd ?? null,

            // Signals (external readouts)
            loadState: signal('idle'),
            playing: signal(false),
            position: signal(0),
            duration: signal(0),

            // Graph nodes, wired on first play so a defined-but-never-played
            // track costs one <audio> element (holding onto the URL) and no
            // audio graph footprint.
            element: null,
            source: null,      // MediaElementAudioSourceNode
            xfadeGain: null,   // GainNode: 0..1 crossfade knob
            volumeGain: null,  // GainNode: track's baseline volume

            // Throttling + handlers, so destroy() can remove them cleanly
            lastPositionWrite: -Infinity,
            timeupdateHandler: null,
            endedHandler: null,

            // Delayed-pause timer id (real setTimeout in production; teardown
            // pauses the <audio> element after the fade completes so the
            // browser stops decoding a track no one hears).
            pauseTimer: null,

            resolvedSrc: null,   // the URL picked by the format probe
        };
    }

    async _loadTrack(rec) {
        const url = pickSupportedSrc(rec.srcs);
        if (!url) { rec.loadState.set('error'); return; }
        rec.loadState.set('loading');
        try {
            rec.resolvedSrc = url;
            // Create the <audio> element eagerly so metadata (duration) can
            // populate before any play(). We do NOT wire the graph yet - that
            // happens on first playTrack, since MediaElementSource is expensive.
            const el = this._createAudioElement(url);
            rec.element = el;

            // 'loadedmetadata' pushes duration into the signal. Some browsers
            // fire this eagerly for cached/short files, others take a beat.
            const onMeta = () => {
                rec.duration.set(Number.isFinite(el.duration) ? el.duration : 0);
            };
            el.addEventListener('loadedmetadata', onMeta);

            // 'error' -> loadState = 'error'. We do not distinguish decode vs
            // network errors here; the granularity is not useful to a game.
            const onError = () => { rec.loadState.set('error'); };
            el.addEventListener('error', onError);

            rec.loadState.set('ready');
        } catch {
            rec.loadState.set('error');
        }
    }

    _createAudioElement(src) {
        if (this._document?.createElement) {
            const el = this._document.createElement('audio');
            el.src = src;
            el.preload = 'auto';
            el.crossOrigin = 'anonymous';
            return el;
        }
        if (typeof Audio !== 'undefined') {
            const el = new Audio(src);
            el.preload = 'auto';
            return el;
        }
        throw new Error('LiteAudio: no <audio> element factory available');
    }

    /**
     * Wire a track's graph on first play. Idempotent - subsequent calls are
     * no-ops. The graph is:
     *   <audio> -> MediaElementSource -> xfadeGain -> volumeGain -> bus.gain
     * xfadeGain carries crossfade curves (0..1). volumeGain carries the
     * track's baseline volume (independent of crossfade).
     */
    _wireTrackGraph(rec) {
        if (rec.source) return;
        const busRec = this._buses.get(rec.busName);
        if (!busRec) return;

        rec.source = this._ctx.createMediaElementSource(rec.element);
        rec.xfadeGain = this._ctx.createGain();
        rec.xfadeGain.gain.value = 0;                // start silent, fade in
        rec.volumeGain = this._ctx.createGain();
        rec.volumeGain.gain.value = rec.volume;

        rec.source.connect(rec.xfadeGain);
        rec.xfadeGain.connect(rec.volumeGain);
        rec.volumeGain.connect(busRec.gain);
    }

    /**
     * Start (or resume) a track. Idempotent - playing a track already playing
     * is a no-op unless `restart: true` is set, in which case the element is
     * seeked to 0 and continues from there.
     *
     * `fadeIn` (ms) drives an equal-power ramp on xfadeGain, from its current
     * value (0 for fresh play, whatever for a retarget) to the track's target
     * xfade level (1.0). Default is 0 - snap to full immediately.
     *
     * Setting `position` (seconds) seeks the element before playback starts.
     */
    playTrack(name, opts = {}) {
        if (this._destroyed) return;
        const rec = this._tracks.get(name);
        if (!rec) return;
        if (rec.loadState.peek() !== 'ready') return;

        // Locked context: playing a track before unlock is not queued the way
        // SFX are. Music is a scene-scale operation - the caller should either
        // wait for the unlocked() signal or set up the track after unlock.
        if (!this._sUnlocked.peek()) return;

        // Idempotency: already playing, and no restart flag -> no-op.
        if (rec.playing.peek() && !opts.restart) return;

        this._wireTrackGraph(rec);

        // Cancel any pending pause from a previous stopTrack - we're back.
        if (rec.pauseTimer != null) {
            this._clearTimeout(rec.pauseTimer);
            rec.pauseTimer = null;
        }

        if (opts.position != null && Number.isFinite(opts.position)) {
            rec.element.currentTime = opts.position;
        } else if (opts.restart) {
            rec.element.currentTime = 0;
        }

        // Attach handlers lazily and only once. Removed on destroy or when
        // the track record is torn down. Loop handling is done inside the
        // handler so custom loopStart/loopEnd work even when element.loop
        // is false (the native property would loop end -> 0, we may want
        // end -> loopStart instead).
        if (!rec.timeupdateHandler) {
            const el = rec.element;
            rec.timeupdateHandler = () => {
                const now = this._ctx.currentTime;

                // Custom loop points: seek back when currentTime crosses loopEnd.
                if (rec.loop && rec.loopEnd != null && el.currentTime >= rec.loopEnd) {
                    el.currentTime = rec.loopStart ?? 0;
                }

                // Position signal, throttled to POSITION_WRITE_INTERVAL of ctx time.
                if (now - rec.lastPositionWrite >= POSITION_WRITE_INTERVAL) {
                    rec.position.set(el.currentTime);
                    rec.lastPositionWrite = now;
                }
            };
            el.addEventListener('timeupdate', rec.timeupdateHandler);
        }
        if (!rec.endedHandler) {
            rec.endedHandler = () => {
                rec.playing.set(false);
                // Do not tear down the graph - the caller may replay this track.
            };
            rec.element.addEventListener('ended', rec.endedHandler);
        }

        // Set native loop when we do NOT have custom loop points. Custom
        // loop points require the timeupdate seek path; leaving element.loop
        // true alongside would double-loop.
        rec.element.loop = rec.loop && rec.loopEnd == null;

        // Kick playback and schedule the fade-in curve. play() returns a
        // promise on modern browsers; we ignore it - the graph is already
        // wired, and any autoplay rejection is caught by ctx-locked check.
        rec.element.play();
        rec.playing.set(true);

        const fadeInMs = opts.fadeIn ?? 0;
        const targetGain = 1;    // xfadeGain lives 0..1
        const now = this._ctx.currentTime;
        if (fadeInMs > 0) {
            const currentValue = rec.xfadeGain.gain.value;
            const curve = scaleCurve(EQ_POWER_IN, targetGain - currentValue, currentValue);
            rec.xfadeGain.gain.cancelScheduledValues(now);
            rec.xfadeGain.gain.setValueAtTime(currentValue, now);
            rec.xfadeGain.gain.setValueCurveAtTime(curve, now, fadeInMs / 1000);
        } else {
            rec.xfadeGain.gain.cancelScheduledValues(now);
            rec.xfadeGain.gain.setValueAtTime(targetGain, now);
        }
    }

    /**
     * Fade a track out over `fade` ms and pause its element once the fade
     * completes. The playing signal flips to false immediately - the fade
     * tail is a graceful audio detail, not a "still playing" state a HUD
     * should show.
     */
    stopTrack(name, opts = {}) {
        if (this._destroyed) return;
        const rec = this._tracks.get(name);
        if (!rec || !rec.playing.peek()) return;

        const fadeMs = opts.fade ?? DEFAULT_TRACK_FADE_MS;
        rec.playing.set(false);

        // Immediately schedule fade-out. Cancel any in-flight fade first so a
        // retarget starts from wherever the automation is right now.
        if (rec.xfadeGain) {
            const now = this._ctx.currentTime;
            const currentValue = rec.xfadeGain.gain.value;
            if (fadeMs > 0) {
                const curve = scaleCurve(EQ_POWER_OUT, currentValue, 0);
                rec.xfadeGain.gain.cancelScheduledValues(now);
                rec.xfadeGain.gain.setValueAtTime(currentValue, now);
                rec.xfadeGain.gain.setValueCurveAtTime(curve, now, fadeMs / 1000);
            } else {
                rec.xfadeGain.gain.cancelScheduledValues(now);
                rec.xfadeGain.gain.setValueAtTime(0, now);
            }
        }

        // Pause the <audio> element after the fade so decoding stops. Use the
        // injected setTimeout so tests can flush deterministically.
        if (rec.pauseTimer != null) this._clearTimeout(rec.pauseTimer);
        const slackMs = fadeMs + 30;
        rec.pauseTimer = this._setTimeout(() => {
            rec.pauseTimer = null;
            if (!rec.playing.peek() && rec.element && !rec.element.paused) {
                rec.element.pause();
            }
        }, slackMs);
    }

    /** Pause without losing position. */
    pauseTrack(name) {
        if (this._destroyed) return;
        const rec = this._tracks.get(name);
        if (!rec || !rec.playing.peek()) return;
        rec.element?.pause();
        rec.playing.set(false);
    }

    /**
     * Resume from paused state. Preserves position (element.currentTime).
     *
     * pauseTrack() leaves xfadeGain alone, but stopTrack() fades it to zero - and
     * nothing stops a caller from pairing stopTrack with resumeTrack. Without
     * restoring the gain, that pair produced a track that was decoding, reporting
     * playing() === true, and completely inaudible. So resume lifts the gain back
     * to full over a short ramp (click-free, and a no-op when it is already there).
     */
    resumeTrack(name) {
        if (this._destroyed) return;
        const rec = this._tracks.get(name);
        if (!rec) return;
        if (rec.loadState.peek() !== 'ready') return;
        if (rec.playing.peek()) return;
        if (!this._sUnlocked.peek()) return;

        // A pause scheduled by an earlier stopTrack must not land on top of us.
        if (rec.pauseTimer != null) {
            this._clearTimeout(rec.pauseTimer);
            rec.pauseTimer = null;
        }

        if (rec.xfadeGain) {
            const now = this._ctx.currentTime;
            const currentValue = rec.xfadeGain.gain.value;
            if (currentValue < 1) {
                const curve = scaleCurve(EQ_POWER_IN, 1 - currentValue, currentValue);
                rec.xfadeGain.gain.cancelScheduledValues(now);
                rec.xfadeGain.gain.setValueAtTime(currentValue, now);
                rec.xfadeGain.gain.setValueCurveAtTime(curve, now, RESUME_FADE_MS / 1000);
            }
        }

        rec.element?.play();
        rec.playing.set(true);
    }

    /**
     * Equal-power crossfade between two tracks. Either side may be null:
     *   crossfade('a', 'b', 400)   - a fades out while b fades in
     *   crossfade('a', null, 400)  - fade a out
     *   crossfade(null, 'b', 400)  - fade b in
     *
     * Case (c) interruption semantics: only tracks named in this call are
     * touched. A track fading out from a previous crossfade keeps its
     * schedule; a track fading in from a previous crossfade will be
     * retargeted only if it appears in this new call. Every side reads its
     * xfadeGain's current value and schedules the equal-power curve scaled
     * to that start point, so there are no discontinuities.
     */
    crossfade(fromName, toName, durationMs) {
        if (this._destroyed) return;
        const dur = (durationMs ?? DEFAULT_TRACK_FADE_MS) / 1000;
        const now = this._ctx.currentTime;

        if (fromName) {
            const rec = this._tracks.get(fromName);
            if (rec && rec.playing.peek()) {
                // Fade out. Same path as stopTrack but scoped to the schedule.
                this.stopTrack(fromName, { fade: durationMs ?? DEFAULT_TRACK_FADE_MS });
            }
        }

        if (toName) {
            const rec = this._tracks.get(toName);
            if (rec && rec.loadState.peek() === 'ready') {
                if (!rec.playing.peek()) {
                    // Start from silence, fade in over dur.
                    this._wireTrackGraph(rec);
                    if (rec.xfadeGain) rec.xfadeGain.gain.value = 0;
                    this.playTrack(toName, { fadeIn: durationMs ?? DEFAULT_TRACK_FADE_MS });
                } else if (rec.xfadeGain) {
                    // Already playing (probably being retargeted mid-fade).
                    // Curve from wherever we are to 1.0.
                    const currentValue = rec.xfadeGain.gain.value;
                    const curve = scaleCurve(EQ_POWER_IN, 1 - currentValue, currentValue);
                    rec.xfadeGain.gain.cancelScheduledValues(now);
                    rec.xfadeGain.gain.setValueAtTime(currentValue, now);
                    rec.xfadeGain.gain.setValueCurveAtTime(curve, now, dur);
                }
            }
        }
    }

    /**
     * Start `name` and fade every OTHER playing track on the same bus. The
     * roadmap's D1 sees buses as the physical version of manager categories:
     * a bus-scoped exclusive on the music bus fades all other music tracks
     * while leaving SFX (or a separate voice bus) untouched.
     */
    playExclusive(name, opts = {}) {
        if (this._destroyed) return;
        const rec = this._tracks.get(name);
        if (!rec) return;
        const bus = rec.busName;
        const fadeMs = opts.fade ?? DEFAULT_TRACK_FADE_MS;
        for (const [otherName, otherRec] of this._tracks) {
            if (otherName === name) continue;
            if (otherRec.busName !== bus) continue;
            if (!otherRec.playing.peek()) continue;
            this.stopTrack(otherName, { fade: fadeMs });
        }
        this.playTrack(name, opts);
    }

    /**
     * Play `name` (sound OR track) only if the last play attempt for the
     * same name was more than `thresholdMs` ago. Ported verbatim from the
     * manager's timestamp map. Uses performance.now() if available,
     * ctx.currentTime * 1000 as fallback so the threshold still means ms.
     *
     * Returns a voice handle when `name` is a sound, TRACK_STARTED (-2) when it is
     * a track, and -1 when the call was throttled or the name is unknown. It cannot
     * return 0 for a track: 0 is a real handle (bus 0, channel 0, generation 0), and
     * a caller passing it to stop() would kill an unrelated SFX voice.
     * @returns {number} handle >= 0, -2 (track started), or -1 (skipped)
     */
    playUnique(name, thresholdMs = 100) {
        if (this._destroyed) return -1;
        const now = (typeof performance !== 'undefined' && performance.now)
            ? performance.now()
            : this._ctx.currentTime * 1000;
        const last = this._lastPlayed.get(name) ?? -Infinity;
        if (now - last <= thresholdMs) return -1;
        this._lastPlayed.set(name, now);
        if (this._sounds.has(name)) return this.play(name);
        if (this._tracks.has(name)) { this.playTrack(name); return TRACK_STARTED; }
        return -1;
    }

    // ---------- Track signal getters ---------------------------------------

    trackLoadState(name) { return this._tracks.get(name)?.loadState; }
    trackPlaying(name)   { return this._tracks.get(name)?.playing; }
    trackPosition(name)  { return this._tracks.get(name)?.position; }
    trackDuration(name)  { return this._tracks.get(name)?.duration; }

    // ---------- Bus controls -----------------------------------------------

    setBusVolume(busName, volume) {
        const busRec = this._buses.get(busName);
        if (busRec) busRec.volume.set(volume);
    }

    setBusMuted(busName, muted) {
        const busRec = this._buses.get(busName);
        if (busRec) busRec.muted.set(!!muted);
    }

    setMuted(state) { this._sMuted.set(!!state); }

    // ---------- Signal getters ---------------------------------------------

    /** Reactive readable: current context state ('suspended'|'running'|...). */
    ctxState() { return this._sCtxState; }

    /** Reactive readable: whether the context has been unlocked. */
    unlocked() { return this._sUnlocked; }

    /** Reactive readable: master mute state. */
    muted() { return this._sMuted; }

    /** Reactive readable: load state for a specific sound. */
    loadState(soundId) { return this._sounds.get(soundId)?.loadState; }

    /** Reactive readable: bus volume signal. */
    busVolume(busName) { return this._buses.get(busName)?.volume; }

    /** Reactive readable: bus mute signal. */
    busMuted(busName) { return this._buses.get(busName)?.muted; }

    /** Direct access to a bus's GainNode for effect insertion (advanced). */
    busNode(busName) { return this._buses.get(busName)?.gain; }

    /** Direct access to the master GainNode (advanced). */
    masterNode() { return this._master; }

    // ---------- Unlock queue -----------------------------------------------

    _enqueue(soundId, volume, pan, pitch) {
        // Latest-per-sound: if the same sound was already queued, overwrite
        // the intent. Bounded: if we would exceed queueLimit with a NEW key,
        // silently drop the newcomer - the game can rebuild it on unlock,
        // and this is a paper-cut fallback, not the happy path.
        if (this._pendingPlays.has(soundId)) {
            this._pendingPlays.set(soundId, [soundId, volume, pan, pitch]);
            return;
        }
        if (this._pendingPlays.size >= this._queueLimit) return;
        this._pendingPlays.set(soundId, [soundId, volume, pan, pitch]);
    }

    _flushQueue() {
        if (!this._sUnlocked.peek()) return;
        if (this._pendingPlays.size === 0) return;

        // Snapshot - play() may re-queue if a sound is still not ready.
        const items = [...this._pendingPlays.values()];
        this._pendingPlays.clear();
        for (const [id, v, p, pi] of items) {
            const rec = this._sounds.get(id);
            if (!rec) continue;
            if (rec.loadState.peek() !== 'ready') {
                // Sound not ready yet: put it back for the next flush.
                this._enqueue(id, v, p, pi);
                continue;
            }
            this.play(id, v, p, pi);
        }
    }

    // ---------- Teardown ---------------------------------------------------

    /**
     * Stop everything, tear down the audio graph, remove listeners, dispose
     * effects, and release references. Idempotent - a second destroy() is
     * safe. The AudioContext itself is not closed (the app owns it).
     */
    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;

        this._unlockAbort?.abort();
        this._lifecycleAbort?.abort();

        if (this._statechangeHandler && this._ctx?.removeEventListener) {
            this._ctx.removeEventListener('statechange', this._statechangeHandler);
        }

        // stopAll first so voice fade-outs schedule against a still-live graph.
        for (const [, busRec] of this._buses) {
            if (busRec.pool) { try { busRec.pool.destroy(); } catch {} busRec.pool = null; }
        }

        // Tear down every track: cancel pending pause, remove element handlers,
        // pause the <audio>, disconnect the MediaElementSource + gains.
        for (const [, rec] of this._tracks) {
            if (rec.pauseTimer != null) { this._clearTimeout(rec.pauseTimer); rec.pauseTimer = null; }
            if (rec.element) {
                if (rec.timeupdateHandler) {
                    try { rec.element.removeEventListener('timeupdate', rec.timeupdateHandler); } catch {}
                }
                if (rec.endedHandler) {
                    try { rec.element.removeEventListener('ended', rec.endedHandler); } catch {}
                }
                try { rec.element.pause(); } catch {}
                // Drop the stream. A paused <audio> that still has a src can keep
                // buffering, and the element is unreachable after _tracks.clear().
                try {
                    rec.element.removeAttribute('src');
                    rec.element.load();
                } catch {}
            }
            try { rec.source?.disconnect(); } catch {}
            try { rec.xfadeGain?.disconnect(); } catch {}
            try { rec.volumeGain?.disconnect(); } catch {}
        }

        for (const h of this._effectHandles) {
            try { dispose(h); } catch {}
        }
        this._effectHandles.length = 0;

        // Disconnect bus and master gains.
        for (const [, busRec] of this._buses) {
            try { busRec.gain.disconnect(); } catch {}
        }
        try { this._master?.disconnect(); } catch {}

        this._buses.clear();
        this._busList.length = 0;
        this._sounds.clear();
        this._soundsByBus.clear();
        this._pendingPlays.clear();
        this._tracks.clear();
        this._lastPlayed.clear();
        this._master = null;
        this._ctx = null;
    }
}

export default LiteAudio;
