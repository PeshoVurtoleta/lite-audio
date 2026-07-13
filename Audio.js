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
        this._busNames = opts.buses || ['sfx', 'ui', 'voice'];
        this._poolCapacity = opts.poolCapacity ?? 32;
        this._queueLimit = opts.queueLimit ?? DEFAULT_QUEUE_LIMIT;
        this._mutedKey = opts.mutedStorageKey ?? MUTED_STORAGE_KEY;
        this._fetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
        this._window = opts.window ?? (typeof window !== 'undefined' ? window : null);
        this._document = opts.document ?? (typeof document !== 'undefined' ? document : null);

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
     * Which bus issued this handle, or null. Useful for HUDs and for asserting in
     * tests that a voice landed where its sound was routed.
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
     * Voices currently sounding on a bus, or across every bus when called with no
     * argument. Allocation-free; safe to call every frame.
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

    /** Stop every voice on a named bus. */
    stopBus(busName) {
        if (this._destroyed) return;
        const busRec = this._buses.get(busName);
        if (busRec?.pool) busRec.pool.stopAll();
    }

    /** Stop every voice across every bus. */
    stopAll() {
        if (this._destroyed) return;
        for (const [, busRec] of this._buses) {
            if (busRec.pool) busRec.pool.stopAll();
        }
    }

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
        this._master = null;
        this._ctx = null;
    }
}

export default LiteAudio;
