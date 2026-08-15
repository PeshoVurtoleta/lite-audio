/** @zakkster/lite-audio - Zero-GC reactive Web Audio engine */

import { signal, effect, batch, dispose } from '@zakkster/lite-signal';
import { AudioPool } from '@zakkster/lite-audio-pool';

/**
 * Package version, kept in lockstep with package.json (the /release gate syncs
 * the two). A cold module-level constant -- read at import, never on a hot path.
 */
export const VERSION = '2.11.0';

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
 * Position write time constant (S3). setPosition() only stamps a scratch buffer
 * and a dirty bit; the actual positionX/Y/Z writes happen COLD on the shared
 * ~10 Hz monitor (see _flushPositions), throttled to the monitor cadence. A
 * 20 ms setTargetAtTime smooths the ~100 ms steps between flushes into a glide,
 * so a source moving at frame rate never clicks even though its param is only
 * touched ~10 times a second. Per-frame per-voice param writes are forbidden
 * (SP-03): they grow the native automation-event list unbounded, invisible to
 * the JS-heap gate. The throttle is the SP-03 bound.
 */
const POS_TC = 0.02;

/**
 * Output-layout tokens (S6). `_detectLayout()` resolves the engine's effective
 * output layout to exactly one of these. LAYOUT_STEREO is the fail-closed default:
 * every unverified sink (no destination, no maxChannelCount, a non-integer or a
 * value < 8) resolves here, so a discrete request degrades to a working stereo bus
 * rather than a silent or broken multichannel graph. LAYOUT_71 is reached ONLY when
 * the sink reports a concrete integer >= PRESET_CHANNELS_71.
 */
const LAYOUT_STEREO = 'stereo';
const LAYOUT_71 = '7.1';
const LAYOUT_51 = '5.1';
const LAYOUT_31 = '3.1';

/**
 * Discrete-surround preset channel counts (S6/S7). Each is BOTH the lane count handed
 * to the pool (`channels: N`) AND that preset's detection/ladder threshold: a sink must
 * report at least this many hardware channels to carry the preset. Kept as one constant
 * per preset so the two uses cannot drift. The pool ships channels in {4,6,8}
 * (AudioPool.js), and the SMPTE lane order is shared across all three (see LANE_*):
 * 7.1 -> 8, 5.1 -> 6, 3.1 -> 4.
 */
const PRESET_CHANNELS_71 = 8;
const PRESET_CHANNELS_51 = 6;
const PRESET_CHANNELS_31 = 4;

/**
 * Frozen SMPTE lane indices for the 7+1 bus (S6). These match the pool's discrete
 * lane order for channels=8 exactly (AudioPool voiceLanes index -> merger input):
 * 0=front-left, 1=front-right, 2=center, 3=LFE, 4=side-left, 5=side-right,
 * 6=surround-back-left, 7=surround-back-right. LANE_LFE (3) is special: it is OUTSIDE
 * the VBAP set (it never receives a pan-derived gain), and in the pool its lane gain
 * routes through the shared lowpass into merger input 3. "LFE outside the VBAP set" is
 * an INDEX contract, not an array-membership one -- the pool DOES return lane 3 as a
 * writable GainNode inside the same voiceNode() array; the solver simply never writes
 * a VBAP value there, only the azimuth-invariant LFE_SEND. See decisions/0008.
 */
const LANE_L = 0;
const LANE_R = 1;
const LANE_C = 2;
const LANE_LFE = 3;
const LANE_SL = 4;
const LANE_SR = 5;
const LANE_SBL = 6;
const LANE_SBR = 7;

/**
 * Pairwise-constant-power (VBAP) speaker ring for 7+1 (S6). The VBAP set is the SEVEN
 * NON-LFE lanes placed on a horizontal ring by azimuth. VBAP_RING_71 lists the lane
 * index at each ring position; VBAP_RING_AZ_71 lists that position's azimuth in
 * degrees, with a trailing 360 WRAP SENTINEL so the containing-pair search is a plain
 * ascending scan with no modulo branch: for az in [AZ[i], AZ[i+1]) the active pair is
 * ring[i] and ring[(i+1) that wraps 6->0]. Azimuths: C at 0, R at 30, SR at 110, SBR
 * at 150, SBL at 210, SL at 250, L at 330, wrapping to C at 360. y (height) has NO
 * lane in 7+1 -- it is folded into distance only and is deliberately NOT panned, so a
 * source above/below the ring never smears into the surrounds (documented, not a bug).
 */
const VBAP_RING_71 = new Uint8Array([LANE_C, LANE_R, LANE_SR, LANE_SBR, LANE_SBL, LANE_SL, LANE_L]);
const VBAP_RING_AZ_71 = new Float32Array([0, 30, 110, 150, 210, 250, 330, 360]);

/**
 * Reduced VBAP rings for the 5+1 and 3+1 presets (S7). The lane INDICES are shared with
 * 7+1 (the pool uses the same low SMPTE indices for shared lanes), so a smaller preset
 * simply drops the higher lanes and re-spaces the ring:
 *   5.1 drops SBR/SBL -> ring [C, R, SR, SL, L], az [0, 30, 110, 250, 330, 360]
 *   3.1 drops all surrounds (front-only) -> ring [C, R, L], az [0, 30, 330, 360]
 * Each az array keeps the trailing 360 WRAP SENTINEL so the containing-pair scan stays a
 * plain ascending walk with no modulo (identical to 7+1). 3.1 has no rear speaker: a
 * source directly behind the listener folds across the 300-degree back gap between R (30)
 * and L (330). That is correct for a front-only rig, a documented limitation (see
 * decisions/0009), not a bug. y (height) is never panned in any preset.
 */
const VBAP_RING_51 = new Uint8Array([LANE_C, LANE_R, LANE_SR, LANE_SL, LANE_L]);
const VBAP_RING_AZ_51 = new Float32Array([0, 30, 110, 250, 330, 360]);
const VBAP_RING_31 = new Uint8Array([LANE_C, LANE_R, LANE_L]);
const VBAP_RING_AZ_31 = new Float32Array([0, 30, 330, 360]);

/**
 * LFE lane send (S6). LANE_LFE is fed an azimuth-invariant constant send so the low
 * lane is never dead; the band-limiting itself is the pool's shared lowpass (lite-audio
 * never sets the crossover). This is a bass-management send level (~ -6 dB), not a
 * pan gain -- the solver writes it to LANE_LFE every flush as the last lane write, and
 * it carries 0 VBAP-derived content by construction.
 */
const LFE_SEND = 0.5;

/**
 * Frozen per-preset ring records (S7). Each captures everything the generalized cold
 * solver (_vbapSolve) and the data-driven flush (_flushLanes) need to walk one preset:
 *   layout  the caller-visible effectiveLayout token
 *   lanes   the pool channel count == the exact number of lane gains written per flush
 *   ring    the VBAP speaker ring (lane index at each ring position, non-LFE)
 *   az      that ring's azimuths (degrees, trailing 360 wrap sentinel)
 *   lfe     the LFE lane index (always 3, outside the VBAP set, distance-only send)
 * A discrete bus captures exactly ONE of these on busRec.vbap at construction (cold), so
 * the hot/monitor path never branches on preset -- the ring array length is the selector,
 * resolved once. Frozen so a stray write can never mutate a shared record.
 */
const PRESET_71 = Object.freeze({ layout: LAYOUT_71, lanes: PRESET_CHANNELS_71, ring: VBAP_RING_71, az: VBAP_RING_AZ_71, lfe: LANE_LFE });
const PRESET_51 = Object.freeze({ layout: LAYOUT_51, lanes: PRESET_CHANNELS_51, ring: VBAP_RING_51, az: VBAP_RING_AZ_51, lfe: LANE_LFE });
const PRESET_31 = Object.freeze({ layout: LAYOUT_31, lanes: PRESET_CHANNELS_31, ring: VBAP_RING_31, az: VBAP_RING_AZ_31, lfe: LANE_LFE });

/**
 * The one reused lane-gain scratch (S6). _flushLanes solves a voice's 8 lane gains into
 * this module-level Float32Array and reads it straight into 8 setTargetAtTime writes --
 * one buffer for the whole process, reused every flush, so the 8-lane solve allocates
 * nothing on the cold monitor path (T-SP3). Single-threaded by construction: the flush
 * fills it and drains it within one synchronous voice iteration before touching the next.
 */
const LANE_SCRATCH = new Float32Array(PRESET_CHANNELS_71);

/** Precomputed constants so the solver never recomputes PI/2 or the radian->degree
 *  scale per flush (hot-path law: precompute, do not derive in the loop body). */
const HALF_PI = Math.PI / 2;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * Ducking time constants (D-A3). A duck is a sidechain compressor's key path:
 * activity on one bus dips another. The dip and the recovery are NOT symmetric
 * - a duck that attacks and releases at the same rate sounds like a mistake,
 * because the ear expects music to get out of the way FAST and return SLOWLY.
 * These are setTargetAtTime time constants (seconds), the same exponential
 * primitive the bus writes use, which is exactly a compressor's attack/release.
 * Attack ~50ms is snappy without a click; release ~300ms lets the mix breathe
 * back. Overridable per duck() call.
 */
const DUCK_ATTACK_TC = 0.05;
const DUCK_RELEASE_TC = 0.3;

/** Ducking lives on a dedicated sidechain gain, multiplied under volume/mute.
 *  1 is "not ducked"; a duck dips it toward its target level and stopDuck()
 *  restores it to this. Kept as a named constant so the resting value has one
 *  source of truth across duck(), stopDuck() and snapshot morphs. */
const DUCK_REST = 1;

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
 * Bus ceiling. A handle is busIndex * 2^32 + poolHandle with a FULL uint32 pool
 * handle in the low half, so it stays a safe integer only while
 * busIndex * 2^32 + (2^32 - 1) <= 2^53 - 1, i.e. busIndex <= 2^21 - 1. Bus index
 * 2^21 itself already overflows once its pool issues a maxed-out handle, so the
 * usable index range is [0, 2^21 - 1] and the bus COUNT ceiling is 2^21. Past it,
 * two distinct (bus, poolHandle) pairs would round to the same double and stop()
 * would silently reach the wrong voice. We fail closed at init() instead: an
 * unrepresentable bus is a wiring error, not a runtime surprise. This is a cold
 * check (init only) and does not touch the play()/stop() hot paths.
 */
const MAX_BUSES = 2097152;       // 2^21

/**
 * A pool channel packs into the low 8 bits of a handle (`poolHandle & 0xFF`,
 * decision 0001), so a pool can address at most 256 channels. A poolCapacity of
 * 257 would wrap channel 256 onto channel 0 and silently overwrite channel 0's
 * scratch. We fail closed at construction (see the poolCapacity guard) rather
 * than corrupt the mix. This is a cold check (init only).
 */
const MAX_POOL_CAPACITY = 256;   // low 8 bits of a handle: poolHandle & 0xFF

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

/**
 * Stereo widener constants (S5). A bus built with { width } arms a Haas-pair
 * widener: the dry (mono) signal is duplicated into two short-delayed copies
 * panned hard L/R, summed back with the dry through a makeup gain. The two delays
 * are the classic Haas offsets (12 ms / 19 ms) -- distinct, both under the ~30 ms
 * fusion threshold so the ear hears one wide source, not an echo. WIDTH_WET_MAX is
 * the wet gain at width=1 (0.5 -> the wet pair is half the dry level before
 * makeup); WIDTH_TC is the setTargetAtTime time constant the ~10 Hz monitor uses
 * so a width change glides click-free. WIDTH_SETTLE_TICKS is how many monitor ticks
 * after a width-to-0 request the flush waits before snapping wet to EXACTLY 0 and
 * makeup to EXACTLY 1 with setValueAtTime -- setTargetAtTime is exponential and
 * never reaches its target, so bypass would otherwise leave a hair of wet signal;
 * the exact snap makes width=0 bit-identical to an unarmed bus.
 */
const HAAS_DELAY_L = 0.012;
const HAAS_DELAY_R = 0.019;
const WIDTH_WET_MAX = 0.5;
const WIDTH_TC = 0.05;
const WIDTH_SETTLE_TICKS = 4;

/**
 * Shared monitor tick, ~10 Hz. One low-frequency timer drives meters, the duck
 * follower and auto-suspend - none of them belong on the play()/stop() hot
 * path, and none of them needs sample accuracy. 10 Hz matches the telemetry
 * cadence position() already uses and is fast enough for a follower to track a
 * voice burst. The tick is allocation-free: the callback is created once and
 * reschedules itself by reference.
 */
const MONITOR_INTERVAL_MS = 100;

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
        // Fail closed on an out-of-range poolCapacity. A pool channel packs into
        // the low 8 bits of a handle (poolHandle & 0xFF, decision 0001), so a
        // capacity past 256 wraps channel 256 onto channel 0 and silently
        // overwrites channel 0's scratch. Number.isInteger rejects NaN and
        // non-integers (null is not zero) before the range test.
        if (!Number.isInteger(this._poolCapacity) || this._poolCapacity < 1 || this._poolCapacity > MAX_POOL_CAPACITY) {
            throw new RangeError(
                'LiteAudio: poolCapacity ' + this._poolCapacity + ' exceeds the channel ceiling of ' +
                MAX_POOL_CAPACITY + '. A pool channel packs into the low 8 bits of a handle ' +
                '(poolHandle & 0xFF), so a capacity past 256 would wrap channel 256 onto ' +
                'channel 0 and silently overwrite channel 0\'s scratch. poolCapacity must be ' +
                'an integer in the range 1..256.'
            );
        }
        this._queueLimit = opts.queueLimit ?? DEFAULT_QUEUE_LIMIT;
        this._mutedKey = opts.mutedStorageKey ?? MUTED_STORAGE_KEY;
        // Bind the default: the browser's fetch throws "Illegal invocation" if
        // called as a method (this._fetch(url) sets this = the engine), so the
        // documented globalThis.fetch default must be bound to globalThis. An
        // injected opts.fetch is the caller's to bind.
        this._fetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
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

        // Flat list of the same track records, so the monitor can scan for a
        // playing track without allocating a Map iterator every tick.
        this._trackList = [];

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

        // Automatic-duck rules (duckOn). Evaluated off the hot path by the
        // shared monitor; an explicit duck() latches its target out of these.
        this._duckRules = [];

        // Named mix snapshots (captureSnapshot / applySnapshot).
        this._snapshots = new Map();

        // Buses with an AnalyserNode attached (createBus({meter:true})). Held
        // as a flat list so the monitor can sweep meters without a Map walk.
        this._meteredBuses = [];

        // Shared cold monitor: one low-frequency timer that drives meters, the
        // duck follower and auto-suspend. Off until a consumer needs it, and
        // started at most once (idempotent).
        this._monitorTimer = null;
        this._monitorTick = null;   // the reused, allocation-free tick closure

        // Auto-suspend state. Off by default and hard-off on iOS (a suspend ->
        // resume there can demand a fresh user gesture, silently un-unlocking a
        // page that was working). See enableAutoSuspend().
        this._autoSuspend = false;
        this._autoSuspendAfter = 0;      // seconds of silence before suspending
        this._silentSince = -1;          // ctx time silence began, -1 = not silent
        this._selfSuspended = false;     // WE suspended it (vs the app / OS)

        // Unlock/lifecycle AbortControllers - same shape as the manager.
        this._unlockAbort = null;
        this._lifecycleAbort = null;

        // Output-layout detection (S6). Resolved ONCE in init() by _detectLayout, then
        // cached: a mid-session device/headset change does not re-detect (that would mean
        // rebuilding pools mid-flight -- out of scope, see decisions/0008). _maxChannels
        // is the raw sink reading (null until init); _layout is the fail-closed token.
        this._maxChannels = null;
        this._layout = LAYOUT_STEREO;
        // Discrete-surround buses (S6). Empty on every engine built today, so the new
        // _flushLanes monitor step iterates nothing until a discrete bus is armed. A
        // flat list, scanned indexed on the cold ~10 Hz tick, never on play()/stop().
        this._discreteBuses = [];
        // Saved pre-discrete destination channel triple (S6). Mutating the destination's
        // channelCount is process-global for the context, so it happens ONLY at the first
        // discrete pool build and is restored here on destroy(). Null (not a zeroed
        // triple) is the "never mutated" state -- a torn-down engine that never built a
        // discrete pool must not write anything back onto the destination.
        this._destChannelSaved = null;

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

        // Resolve the output layout ONCE, cold, before any node is wired (S6). This
        // only READS the sink; it never mutates the destination (that is deferred to the
        // first discrete pool build, so an engine with no discrete bus never changes the
        // context's downmix). See decisions/0008.
        this._detectLayout();

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

        // Fail closed on an unrepresentable bus count BEFORE building a single
        // node: a handle can only namespace 2^21 buses (see MAX_BUSES). 'master'
        // is implicit and never gets an index, so it does not count against the
        // ceiling.
        let userBusCount = 0;
        for (const name of this._busNames) if (name !== 'master') userBusCount++;
        if (userBusCount > MAX_BUSES) {
            throw new RangeError(
                'LiteAudio: ' + userBusCount + ' buses exceeds the handle ceiling of ' +
                MAX_BUSES + ' (2^21). A voice handle is busIndex * 2^32 + poolHandle and ' +
                'stops being an exact integer past bus index 2^21 - 1, so a larger bus ' +
                'graph would issue colliding handles.'
            );
        }

        // Build each user bus: GainNode -> master, plus a per-bus volume+muted
        // effect that writes to gain via setTargetAtTime.
        for (const name of this._busNames) {
            if (name === 'master') continue;    // reserved name; use master directly
            this._buildBus(name);
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
     * Resolve the output layout from the sink, fail-closed (S6). Reads
     * destination.maxChannelCount into this._maxChannels and sets this._layout to
     * LAYOUT_71 ONLY when that reading is a concrete integer >= PRESET_CHANNELS_71;
     * every other case -- no destination, an absent/undefined/null/NaN
     * maxChannelCount, a non-integer, or any integer < 8 -- resolves to LAYOUT_STEREO.
     *
     * The whole guard is ONE predicate, not a typeof ladder: Number.isInteger(NaN)
     * and Number.isInteger('8') are already false, so the single
     * `Number.isInteger(v) && v >= PRESET_CHANNELS_71` rejects every non-qualifying
     * shape. "null is not zero": an unknown sink is stereo, never optimistically 7.1.
     * Cold: called once from init(), the reading is cached, and a later device change
     * does NOT re-detect (that would mean rebuilding pools mid-flight -- decisions/0008).
     */
    _detectLayout() {
        const v = this._ctx?.destination?.maxChannelCount;
        // Sanitize to an integer channel count (0 for any non-integer / NaN / null /
        // absent reading) so the ladder later reasons over a plain number. "null is not
        // zero" -- but a non-integer reading is UNKNOWN, and an unknown sink is stereo.
        const n = Number.isInteger(v) ? v : 0;
        this._maxChannels = n;
        // Richest single layout the sink can carry (D1): >=8 -> 7.1, >=6 -> 5.1,
        // >=4 -> 3.1, else stereo. A widening of the S6 binary threshold; every
        // non-qualifying shape still fails closed to stereo, never an optimistic upgrade.
        this._layout = n >= PRESET_CHANNELS_71 ? LAYOUT_71
            : n >= PRESET_CHANNELS_51 ? LAYOUT_51
            : n >= PRESET_CHANNELS_31 ? LAYOUT_31
            : LAYOUT_STEREO;
    }

    /**
     * Cold fallback-ladder resolver (S7). Maps a requested preset token and the sink's
     * sanitized channel count to the LARGEST preset record that fits, or null (build a
     * plain stereo bus). A request never UPGRADES: fit = min(request-need, maxChannels),
     * then step DOWN the ladder 7.1 -> 5.1 -> 3.1 -> stereo. Called ONCE per discrete bus
     * at construction; neither play() nor _flushLanes re-tests it. Pure, allocation-free.
     * @param {string} requested - '7.1' | '5.1' | '3.1'
     * @param {number} maxChannels - sanitized integer sink channel count (0 if unknown)
     * @returns {Object|null} PRESET_71 | PRESET_51 | PRESET_31, or null for stereo
     */
    _resolvePreset(requested, maxChannels) {
        const need = requested === LAYOUT_71 ? PRESET_CHANNELS_71
            : requested === LAYOUT_51 ? PRESET_CHANNELS_51
            : PRESET_CHANNELS_31;                 // '3.1'
        const fit = maxChannels < need ? maxChannels : need;   // min(request-need, M)
        if (fit >= PRESET_CHANNELS_71) return PRESET_71;
        if (fit >= PRESET_CHANNELS_51) return PRESET_51;
        if (fit >= PRESET_CHANNELS_31) return PRESET_31;
        return null;
    }

    /**
     * Build one user bus and append it to the bus list. Shared by init() (the
     * static buses from opts.buses) and createBus() (dynamic buses). The graph
     * per bus is:
     *
     *   pool/track -> gain (volume + mute) -> duckGain (sidechain) -> master
     *
     * Volume and mute own gain.gain via a signal effect. Ducking and snapshot
     * morphs own duckGain.gain. Keeping the two automations on SEPARATE params
     * is the whole point: a duck and a volume change compose (they multiply
     * through the graph) instead of fighting for one AudioParam, where the last
     * writer would win and the next effect run would clobber the duck.
     *
     * @param {string} name
     * @param {Object} [opts]
     * @param {boolean} [opts.meter] - tap an AnalyserNode for level() readouts.
     * @param {'stereo'|'positional'|'hrtf'} [opts.spatial] - per-voice pan mode.
     *   Decided here at CONSTRUCTION (cold) and captured into the pool's `panner`
     *   option; play() never re-tests it. Defaults to 'stereo' (byte-identical to
     *   prior releases: a StereoPanner per voice, equalpower). 'positional' builds a
     *   PannerNode per voice and enables setPosition(). 'hrtf' is positional-family
     *   (same distance graph + setPosition()) but the pool sets the PannerNode's
     *   panningModel to 'HRTF' for per-voice binaural convolution -- headphones-only,
     *   higher CPU; an HRIR prewarm eats the first-play hitch. An unknown value is a
     *   wiring error and fails closed with a did-you-mean, never a silent ignore.
     * @param {number} [opts.width] - arm a stereo Haas widener on this bus (S5). A
     *   number in [0, 1] builds 7 extra nodes (a delay/pan wet pair + dry/makeup
     *   sum) between the pool and the bus gain and enables setWidth(). Omitted =>
     *   graph byte-identical to prior releases (no widener nodes). Stereo-only: a
     *   width > 0 on a positional/hrtf bus fails closed (RangeError), and a
     *   non-finite / boolean / out-of-range width is a wiring error, not a silent
     *   ignore. If the loaded source turns out to be non-mono, defineSounds disarms
     *   the widener (a Haas pair only makes sense on a mono source).
     * @returns {Object} the bus record.
     */
    _buildBus(name, opts = {}) {
        // Spatial mode is validated and frozen at bus construction. Fail closed:
        // an unknown value throws with a hint rather than silently degrading to
        // stereo, so a typo surfaces at createBus() and not as silent flat audio.
        const spatial = opts.spatial ?? 'stereo';
        if (spatial !== 'stereo' && spatial !== 'positional' && spatial !== 'hrtf' &&
            spatial !== 'discrete') {
            throw new RangeError(
                'LiteAudio: createBus("' + name + '") got unknown spatial "' + spatial +
                '" -- expected stereo, positional, hrtf or discrete.'
            );
        }

        // Discrete-surround preset (S6/S7). Meaningful ONLY on a spatial:'discrete' bus;
        // a preset on any other bus is a wiring error, not a silent ignore. S7 ships
        // three presets -- '7.1' (8 lanes), '5.1' (6 lanes), '3.1' (4 lanes) -- each of
        // which builds the largest layout the sink actually fits (the fallback ladder,
        // resolved cold below). Any OTHER value fails closed with a did-you-mean. Note:
        // 'discrete' and 'hrtf' are a single `spatial` field, so they cannot compose on
        // one bus by construction (decisions/0008 risk 3).
        let preset = null;
        if (spatial === 'discrete') {
            preset = opts.preset ?? LAYOUT_71;
            if (preset !== LAYOUT_71 && preset !== LAYOUT_51 && preset !== LAYOUT_31) {
                throw new RangeError(
                    'LiteAudio: createBus("' + name + '") got unknown discrete preset "' +
                    preset + '" -- expected "7.1", "5.1" or "3.1".'
                );
            }
        } else if (opts.preset !== undefined) {
            throw new RangeError(
                'LiteAudio: createBus("' + name + '") got preset "' + opts.preset + '" on a "' +
                spatial + '" bus -- preset is only valid with spatial: "discrete".'
            );
        }

        // A discrete request resolves down the fallback ladder (S7): _resolvePreset picks
        // the LARGEST preset record whose channel-need fits min(request, sink), or null
        // when even 3.1 does not fit -- in which case the bus fails closed to a working
        // plain-stereo bus (lanes=0, vbap=null) and REPORTS a stereo effectiveLayout so a
        // caller can see the fallback via effectiveLayoutOf(). On a 2ch sink this is the
        // expected outcome and a PASS, not a failure. `vbap` (the per-preset ring record)
        // and effectiveLayout stay null on a non-discrete bus. The ladder is computed ONCE
        // here, cold; play() and _flushLanes never re-test it.
        const vbap = spatial === 'discrete' ? this._resolvePreset(preset, this._maxChannels) : null;
        const lanes = vbap ? vbap.lanes : 0;
        const effectiveLayout = spatial === 'discrete'
            ? (vbap ? vbap.layout : LAYOUT_STEREO)
            : null;

        // Stereo widener (S5). Validated and armed COLD here; the hot play()/stop()
        // and the ~10 Hz monitor never re-test any of this. Fail closed on a bad
        // value with a did-you-mean, matching the spatial guard above: a widener is
        // opt-in, and a typo must surface at createBus() rather than as a silent flat
        // (or exploded) mix. A non-number, NaN/Infinity, boolean true (a common
        // "just turn it on" typo), or an out-of-range number is rejected.
        const armWidth = opts.width !== undefined;
        if (armWidth) {
            const w = opts.width;
            if (typeof w !== 'number' || w !== w || w === Infinity || w === -Infinity || w < 0 || w > 1) {
                throw new RangeError(
                    'LiteAudio: createBus("' + name + '") got invalid width ' + String(w) +
                    ' -- expected a number in [0, 1] (did you mean width: 1 to open it fully, or ' +
                    'omit width to leave the bus mono?).'
                );
            }
            // Stereo-only: a Haas widener is a stereo effect, so a positional/hrtf bus
            // (which owns per-voice panning) must never compose with one. Refuse at
            // construction so the two spatial models can never fight over the image.
            if (w > 0 && spatial !== 'stereo') {
                throw new RangeError(
                    'LiteAudio: createBus("' + name + '") got width ' + w + ' on a "' + spatial +
                    '" bus -- the stereo widener is stereo-only and does not compose with a ' +
                    'positional/hrtf/discrete bus (did you mean spatial: "stereo", or drop width?).'
                );
            }
        }

        const gain = this._ctx.createGain();
        const duckGain = this._ctx.createGain();
        duckGain.gain.value = DUCK_REST;
        gain.connect(duckGain);
        duckGain.connect(this._master);

        // Widener slots default null (unarmed => graph byte-identical to a plain bus).
        // poolOut is the node the pool's voices connect to: the widener input when
        // armed, the bus gain otherwise. Built here, COLD, only when opts.width given.
        let wideIn = null, wideMakeup = null, wideWet = null;
        let delayL = null, delayR = null, panL = null, panR = null;
        let poolOut = gain;
        // Stereo-only: the widener composes only with a stereo bus. width > 0 on a
        // positional/hrtf bus already threw at the guard above; width === 0 on such a
        // bus is a no-op request (nothing wide asked for), so build NO widener --
        // wideIn stays null and setWidth is inert via its wideIn===null guard, so a
        // Haas widener can never be inserted onto a per-voice-panned image (SP-06).
        if (armWidth && spatial === 'stereo') {
            wideIn = this._ctx.createGain();
            wideMakeup = this._ctx.createGain();
            wideWet = this._ctx.createGain();
            delayL = this._ctx.createDelay(1);
            delayR = this._ctx.createDelay(1);
            panL = this._ctx.createStereoPanner();
            panR = this._ctx.createStereoPanner();
            delayL.delayTime.value = HAAS_DELAY_L;
            delayR.delayTime.value = HAAS_DELAY_R;
            panL.pan.value = -1;
            panR.pan.value = 1;
            wideWet.gain.value = 0;      // start bypassed; the monitor ramps it in
            wideMakeup.gain.value = 1;
            // Dry: pool -> wideIn -> wideMakeup. Wet: wideIn -> delay -> hard pan ->
            // wideWet -> wideMakeup. wideMakeup -> gain sums dry + wet back together.
            wideIn.connect(wideMakeup);
            wideIn.connect(delayL); delayL.connect(panL); panL.connect(wideWet);
            wideIn.connect(delayR); delayR.connect(panR); panR.connect(wideWet);
            wideWet.connect(wideMakeup);
            wideMakeup.connect(gain);
            poolOut = wideIn;
        }

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
            gain, duckGain, volume: sVol, muted: sMut, effect: busEffect, pool: null,
            // Lifecycle bookkeeping (PS1). `dynamic` is false for every bus _buildBus
            // constructs; createBus() stamps it true on the record it built, so only a
            // createBus() bus can be torn down by destroyBus() (a static opts.buses bus
            // stays dynamic:false and destroyBus() refuses it). `dead` latches true once
            // destroyBus() has hollowed this record into an inert tombstone -- a second
            // destroyBus() reads it and no-ops. Both are cold data on a cold-constructed
            // literal; no hot body reads them per shot.
            dynamic: false,
            dead: false,
            // Ducking state. `duckManual` latches when a caller invokes duck()
            // explicitly: while set, the automatic follower leaves this bus
            // alone, so an explicit duck always wins (and stopDuck() clears it).
            // `duckRelease` remembers the release TC across a duck()/stopDuck()
            // pair so the recovery honours the rate the duck was created with.
            duckManual: false,
            duckRelease: DUCK_RELEASE_TC,
            // Metering state, populated by createBus({meter:true}). analyser is
            // null on an unmetered bus and no AnalyserNode is ever allocated.
            analyser: null,
            meterBuffer: null,
            level: null,
            // Spatial mode + position scratch (S3). `spatial` is captured into the
            // pool's `panner` option at build time. The three arrays stay null on a
            // stereo bus (it allocates nothing new -- default stays byte-identical);
            // they are allocated at pool build only when spatial==='positional':
            //   posXYZ   Float32Array(cap*3) - the pending x,y,z per channel
            //   posOwner Uint32Array(cap)    - the full gen+channel handle that
            //                                  stamped each slot (steal-safety key)
            //   posDirty Uint32Array bitset  - which channels need a flush
            spatial,
            // 'hrtf' is positional-FAMILY: the OR collapses ONCE here (cold) into a
            // derived boolean every hot/monitor site reads instead of re-testing the
            // string. The only behavioural difference vs 'positional' is the pool's
            // panningModel, which the pool owns (Route-A) -- lite-audio never sets it.
            positional: spatial === 'positional' || spatial === 'hrtf',
            posXYZ: null,
            posOwner: null,
            posDirty: null,
            // Discrete surround (S6/S7). `lanes` is the built preset's channel count
            // (8/6/4 for 7.1/5.1/3.1), else 0 (a stereo-fallback discrete bus, or any
            // other bus). A NONZERO lanes is what makes this bus reuse the
            // posXYZ/posOwner/posDirty scratch (allocated at pool build) and ride the
            // _flushLanes monitor step instead of _flushPositions -- setPosition gains no
            // new branch, it just sees a non-null posDirty. `vbap` is the frozen
            // per-preset ring record the cold solver walks (null on a fallen-back stereo
            // bus or a non-discrete bus), so _flushLanes never branches on preset.
            // `effectiveLayout` is the caller-visible readout: the built preset token
            // ('7.1'/'5.1'/'3.1') when lanes were built, 'stereo' when a discrete request
            // fell back, null on a non-discrete bus.
            lanes,
            vbap,
            effectiveLayout,
            // HRIR prewarm (SP-07). An 'hrtf' bus fires one gain=0 voice through the
            // pool POST-unlock so the browser loads the HRTF impulse-response set
            // before the first real play (eating the first-play hitch). Latched by
            // handle so it fires exactly once; retired on the next monitor tick.
            // Null (not zero) is the "no live prewarm" state -- a torn-down bus must
            // never carry a stale handle. hrtfWarmPending counts monitor ticks until
            // retire (armed to 1 -> retired on the next tick, no wall-clock read).
            hrtfWarmHandle: null,
            hrtfWarmed: false,
            hrtfWarmPending: 0,
            // Stereo widener state (S5). The 7 nodes stay null on an unarmed bus (no
            // extra graph, byte-identical to prior releases). poolOut is the node the
            // pool connects to: wideIn when armed, gain otherwise. `width` is the
            // current target (0..1); widthLast is the last value the monitor actually
            // wrote (NaN => force the first flush); widthDirty is the setWidth->flush
            // hand-off bit; widthSettle counts monitor ticks to the exact-bypass snap
            // when width reaches 0; widthRefused records a disarm reason (a non-mono
            // source) so setWidth stays a no-op and a caller can introspect why.
            wideIn, wideMakeup, wideWet, delayL, delayR, panL, panR,
            poolOut,
            width: armWidth ? opts.width : 0,
            widthLast: NaN,
            widthDirty: armWidth && opts.width > 0 ? 1 : 0,
            // 0, not WIDTH_SETTLE_TICKS: a bus armed at width 0 starts widthDirty=0,
            // so a nonzero settle would never count down anyway -- and construction
            // already leaves wet=0/makeup=1 (a bit-exact bypass), so no snap is owed.
            widthSettle: 0,
            widthRefused: null,
        };
        this._buses.set(name, busRec);
        this._busList.push(busRec);
        if (opts.meter) this._attachMeter(busRec);
        // A positional bus writes position on the shared monitor tick, so it must
        // ensure the monitor is armed even if no meter/duck/auto-suspend did.
        // _startMonitor() is idempotent-guarded, so this is a no-op if already up.
        // Reads the derived positional flag so 'hrtf' (positional-family) arms it too.
        if (busRec.positional) this._startMonitor();
        // An armed widener writes its wet/makeup params on the same ~10 Hz monitor,
        // so it must ensure the tick is running too (idempotent-guarded).
        if (wideIn !== null) this._startMonitor();
        // A discrete bus writes its 8 lane gains on the same ~10 Hz monitor via
        // _flushLanes, so it joins the flat _discreteBuses list (empty on every
        // non-discrete engine) and arms the tick. lanes===0 (a stereo-fallback
        // discrete bus) never joins -- it is just a plain stereo bus.
        if (lanes !== 0) { this._discreteBuses.push(busRec); this._startMonitor(); }
        return busRec;
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
            // Prewarm every hrtf bus whose pool was already built before the gesture.
            // Fired POST-unlock (the pool voice needs a running context) and BEFORE
            // the queue flush so the silent HRIR load starts ahead of the first real
            // play. The hrtfWarmed latch makes it fire exactly once per bus across
            // this site and the pool-build site.
            for (let i = 0; i < this._busList.length; i++) this._prewarmHrtf(this._busList[i]);
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
            // Stereo widener source check (S5). A Haas widener synthesises a stereo
            // image from a MONO source; feeding it a stereo source would fold the
            // channels and smear the mix. So an armed bus whose loaded buffers are
            // not all mono is DISARMED here (cold, at pool build) -- the widener nodes
            // are torn down, the pool routes straight to gain, and setWidth() becomes
            // a no-op with widthRefused='stereo-source' recording why. Warn once.
            if (busRec.wideIn !== null) {
                let nonMono = false;
                for (const id of ids) {
                    const buf = this._sounds.get(id).buffer;
                    if (buf && buf.numberOfChannels !== 1) { nonMono = true; break; }
                }
                if (nonMono) this._disarmWidth(busRec, 'stereo-source');
            }
            // Destination channel mutation (S6/S7). Setting channelCount on the
            // destination is process-global for the context, so it is driven by the MAX
            // lane count across all live discrete buses (D3). The pristine triple is saved
            // EXACTLY ONCE, at the FIRST discrete pool build (not in init(), not in
            // _detectLayout, and never on a fallback stereo bus); a LATER discrete bus with
            // MORE lanes RAISES channelCount to the new max WITHOUT re-saving (the saved
            // copy stays the pristine pre-discrete value destroy() restores). Discrete
            // buses are add-only within a session, so the max is monotonic. An engine that
            // never builds a discrete pool never touches the downmix. _destChannelSaved===
            // null is the "never mutated" latch.
            if (busRec.lanes !== 0) {
                const dest = this._ctx.destination;
                if (this._destChannelSaved === null) {
                    this._destChannelSaved = {
                        channelCount: dest.channelCount,
                        channelCountMode: dest.channelCountMode,
                        channelInterpretation: dest.channelInterpretation,
                    };
                    dest.channelCount = busRec.lanes;
                    dest.channelCountMode = 'explicit';
                    dest.channelInterpretation = 'discrete';
                } else if (busRec.lanes > dest.channelCount) {
                    dest.channelCount = busRec.lanes;
                }
            }
            // Spatial mode is captured HERE, at pool construction (cold), so the
            // hot play() never re-tests it: a stereo bus builds StereoPanner voices
            // (byte-identical to prior releases), a positional bus builds PannerNode
            // voices, and a discrete bus (lanes !== 0) builds the pool in discrete mode
            // with its 8 lanes. On a rebuild we reuse the existing scratch arrays and
            // zero them; the pool destroy() above already tore down the old voices. An
            // armed widener routes the pool into wideIn (busRec.poolOut); every other
            // bus routes straight to gain, byte-identical to prior releases. A discrete
            // request that FELL BACK to stereo (lanes===0) keeps the identity mapping,
            // so it builds a plain stereo pool exactly like any stereo bus.
            const poolOpts = busRec.lanes !== 0
                ? { panner: 'discrete', channels: busRec.lanes }
                : { panner: busRec.spatial === 'discrete' ? 'stereo' : busRec.spatial };
            busRec.pool = new AudioPool(
                this._ctx, dummyBuffer, spriteMap, this._poolCapacity, busRec.poolOut,
                poolOpts
            );
            if (busRec.positional || busRec.lanes !== 0) {
                const cap = this._poolCapacity;
                if (busRec.posXYZ === null) {
                    busRec.posXYZ = new Float32Array(cap * 3);
                    busRec.posOwner = new Uint32Array(cap);
                    busRec.posDirty = new Uint32Array((cap + 31) >>> 5);
                } else {
                    busRec.posXYZ.fill(0);
                    busRec.posOwner.fill(0);
                    busRec.posDirty.fill(0);
                }
                // The createBus-time arm (:908/:916) fires BEFORE this scratch
                // exists (pool=null, posDirty=null), so a positional/discrete bus
                // created before defineSounds would see no consumer, sleep, and
                // never flush its positions. Re-arm now that the scratch is live.
                this._startMonitor();
            }
            // Prewarm the HRIR set if the context is ALREADY unlocked at pool build
            // (a defineSounds/createBus that arrives after the user gesture). The
            // hrtfWarmed latch makes this idempotent with the unlock-transition site.
            this._prewarmHrtf(busRec);
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
     *
     * A play() racing a defineSounds() pool rebuild sees pool === null and
     * returns -1 (fail closed). This is a brief dropped-play window for
     * concurrent loaders: a drop is safe, a play onto a torn-down pool is not.
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

        // Wake from our own auto-suspend. One monomorphic boolean read on the
        // common (false) branch - no allocation, no await, no microtask. The
        // source we schedule below onto a still-frozen clock is pinned by the
        // spec to the resume boundary and plays from its head, so the native
        // scheduler holds this voice while the hardware spins up. See
        // decisions/0005-auto-suspend.md.
        if (this._selfSuspended) this._wakeFromAutoSuspend();

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
     * Set the 3D position of a positional voice (S3). Takes the SAME handle
     * play() returned (frozen codec: bus tag in the high half, pool handle in
     * the low half). This is a caller-frame method safe to call every frame: it
     * does NO param write. It only stamps a preallocated scratch buffer with the
     * three floats and sets a dirty bit; the actual positionX/Y/Z writes ride
     * the cold ~10 Hz monitor (_flushPositions) throttled at POS_TC. Zero
     * allocation, zero param events on this path -- that is the SP-03 bound.
     *
     * Works on discrete-surround buses too, not only spatial:'positional' voices:
     * a discrete bus shares the same positional scratch, so setPosition() stamps
     * it identically and the discrete lane solver reads the same three floats.
     *
     * Fail closed at every step: a non-integer or negative handle, a handle
     * whose bus is stereo (no scratch), or a channel past capacity is a silent
     * no-op. Steal-safety is resolved LATER, at flush: posOwner stores the full
     * gen+channel handle, so a channel stolen after this call resolves to a null
     * voiceNode on flush and the stale position is never stamped onto the new
     * voice. See decisions and SPATIAL_ROADMAP S3.
     * @param {number} handle - a voice handle from play() on a positional bus
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @returns {void}
     */
    setPosition(handle, x, y, z) {
        if (this._destroyed) return;
        if (!Number.isInteger(handle) || handle < 0) return;
        const busRec = this._busList[(handle / BUS_STRIDE) | 0];
        if (!busRec) return;
        const dirty = busRec.posDirty;
        if (dirty === null) return;                 // stereo bus / no scratch
        const poolHandle = handle >>> 0;
        const ch = poolHandle & 0xFF;               // channel = low 8 bits (cap <= 256)
        const owner = busRec.posOwner;
        if (ch >= owner.length) return;             // bounds-check before touching scratch
        const i3 = ch * 3;
        const xyz = busRec.posXYZ;
        xyz[i3] = x;
        xyz[i3 + 1] = y;
        xyz[i3 + 2] = z;
        owner[ch] = poolHandle;                     // full gen+channel: the steal key
        dirty[ch >>> 5] |= (1 << (ch & 31));
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
     * Decode a voice handle's opaque bit packing for debugging ("wrong voice
     * stopped") into a plain { busName, generation, channel } object, or null.
     *
     * PURE STRUCTURAL DECODE: it reports what the bits SAY, not whether the
     * voice is still live -- that is isPlaying(handle)'s job. The packing is
     * handle = busIndex * BUS_STRIDE + poolHandle, poolHandle = ((gen << 8) |
     * channel) >>> 0 (decisions/0001-handle-namespace.md): high half names the
     * bus, low 24 bits the generation, low 8 the channel. The generation WRAPS
     * at 2^24 (decisions/0002-generation-wrap.md), so it is the stored low bits,
     * not a monotonic age.
     *
     * Fail-closed null on any sentinel (-1 Skipped, -2 TrackStarted), any
     * non-integer (NaN/undefined/null/string/float), any negative, and any
     * handle whose bus is unknown (busIndex past _busList) or destroyBus'd
     * (tombstoned; its name binding is dropped). The Number.isInteger guard runs
     * FIRST because busOf alone is fail-OPEN on NaN (would name bus 0), so this
     * decoder guards the type itself rather than delegating it.
     *
     * Off the hot path (never called by play/stop/isPlaying/setPosition/the
     * monitor), so it MAY allocate: it reuses the busOf decode for the bus-name
     * half and returns one fresh result object per call.
     * See decisions/0012-get-handle-info.md.
     * @param {number} handle
     * @returns {{ busName: string, generation: number, channel: number }|null}
     */
    getHandleInfo(handle) {
        if (!Number.isInteger(handle) || handle < 0) return null;
        const busName = this.busOf(handle);
        if (busName === null) return null;
        const poolHandle = handle >>> 0;
        return {
            busName,
            generation: poolHandle >>> 8,
            channel:    poolHandle & 0xFF,
        };
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
            this._trackList.push(rec);
            loadPromises.push(this._loadTrack(rec));
        }
        await Promise.all(loadPromises);
    }

    /**
     * Recover ONE errored music track without a full defineTracks rebuild.
     *
     * defineTracks is a no-op for an already-defined name (it does
     * `if (this._tracks.has(name)) continue;`), so once a track's load has
     * settled to 'error' there is no built-in path back. reloadTrack is that
     * path: it tears the track's graph + <audio> element down destroy()-style
     * and re-enters _loadTrack with a FRESH element, driving loadState back
     * through idle -> loading -> ready (or 'error' again). It is the symmetric
     * per-track recovery counterpart to defineTracks' per-track load, and it is
     * a cold call off every hot path.
     *
     * A fresh element is mandatory, not a convenience: a given <audio> element
     * can back exactly ONE MediaElementAudioSourceNode for its lifetime (a
     * second createMediaElementSource on the same element throws
     * InvalidStateError - see _wireTrackGraph). A wire-failure that dumped the
     * track to 'error' has spent that element forever; only a new one can
     * recover it, so the teardown fully releases the old element BEFORE
     * _loadTrack builds the new one - no two elements/sources ever coexist.
     * (The old element's own loadedmetadata/error listeners are not tracked on
     * the rec, but after removeAttribute('src')+load() and nulling rec.element
     * they form an unreferenced island - GC-eligible, not a leak.)
     *
     * The four external signals (loadState / playing / position / duration) are
     * REUSED, never disposed: they are the track's stable external identity, so
     * a subscribed HUD keeps its bindings across the reload. This is the
     * deliberate divergence from destroy(), which DOES dispose them.
     *
     * Returns a boolean SYNC. The async recovery channel is the loadState
     * signal the caller already watches via trackLoadState(name); _loadTrack is
     * fired but NOT awaited, so the graph is not yet settled on return.
     *
     * No-op (returns false, rec untouched) on: unknown / null / non-string
     * name, an in-flight load ('loading'), a live-playback track ('playing'),
     * or a healthy 'ready' track (reload RECOVERS an errored track, it does not
     * restart a healthy one - playTrack({restart:true}) owns restart). Reload
     * fires only from {'error','idle'} with the track not playing. Throws on a
     * destroyed / uninitialized engine, matching defineTracks.
     *
     * @param {string} name
     * @returns {boolean} true iff a teardown + reload was fired.
     */
    reloadTrack(name) {
        if (this._destroyed) throw new Error('LiteAudio: destroyed');
        if (!this._initialized) throw new Error('LiteAudio: init() before reloadTrack()');

        if (typeof name !== 'string' || name.length === 0) return false;
        const rec = this._tracks.get(name);
        if (!rec) return false;

        // Fail closed: reload only recovers an errored/idle track that is not
        // live. A loading track races the in-flight _loadTrack (also guards
        // reentrancy - a second reloadTrack mid-load is refused here, so no
        // double element build). A playing track has a live graph mid-playback.
        // A ready track has nothing to recover.
        const state = rec.loadState.peek();
        if (state === 'loading') return false;
        if (rec.playing.peek()) return false;
        if (state !== 'error' && state !== 'idle') return false;

        // Teardown, mirroring destroy()'s per-track block - but WITHOUT disposing
        // the signals. All node ops are guarded: after a wire failure the element
        // and gains may be null or foreign.
        if (rec.pauseTimer != null) { this._clearTimeout(rec.pauseTimer); rec.pauseTimer = null; }
        if (rec.element) {
            if (rec.timeupdateHandler) {
                try { rec.element.removeEventListener('timeupdate', rec.timeupdateHandler); } catch {}
            }
            if (rec.endedHandler) {
                try { rec.element.removeEventListener('ended', rec.endedHandler); } catch {}
            }
            try { rec.element.pause(); } catch {}
            // Drop the stream so a spent element stops buffering and is
            // GC-eligible, and release it fully BEFORE _loadTrack builds the new
            // element - no two elements/sources coexist for this track.
            try {
                rec.element.removeAttribute('src');
                rec.element.load();
            } catch {}
        }
        try { rec.source?.disconnect(); } catch {}
        try { rec.xfadeGain?.disconnect(); } catch {}
        try { rec.volumeGain?.disconnect(); } catch {}

        // Null every rebuildable field so a reload-churn loop retains no spent
        // element/nodes; config fields (name/srcs/busName/volume/loop/loopStart/
        // loopEnd) are preserved so the reload re-uses the original definition.
        rec.element = null;
        rec.source = null;
        rec.xfadeGain = null;
        rec.volumeGain = null;
        rec.timeupdateHandler = null;
        rec.endedHandler = null;
        rec.resolvedSrc = null;
        rec.lastPositionWrite = -Infinity;
        rec.pauseTimer = null;

        // Signals: .set() only, never dispose(). loadState is reset by the
        // re-entered _loadTrack ('loading' -> 'ready'/'error').
        rec.playing.set(false);
        rec.position.set(0);
        rec.duration.set(0);

        // Fire the fresh load - not awaited; loadState is the async channel.
        this._loadTrack(rec);
        return true;
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

        // A given <audio> element can back exactly ONE MediaElementAudioSourceNode
        // for its lifetime; a second createMediaElementSource on the same element
        // throws InvalidStateError. lite-audio creates its own elements and never
        // reuses one, so a single engine is safe (and the rec.source guard above
        // blocks re-wiring a track). But a destroy() -> re-init cycle on a HOST
        // that pools <audio> nodes can hand us a spent element - fail the track
        // closed rather than throw into the caller's playTrack()/crossfade() path.
        // This is off every hot path (first-play wiring only). See PARITY.md.
        let source;
        try {
            source = this._ctx.createMediaElementSource(rec.element);
        } catch {
            rec.loadState.set('error');
            return;
        }
        rec.source = source;
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
        // Wiring can fail closed (a spent/reused <audio> element - see
        // _wireTrackGraph). No graph, nothing to play; the loadState is already
        // 'error'. Bail before touching the null xfade/volume gains.
        if (!rec.source) return;

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

    // ---------- Stereo width (S5) ------------------------------------------

    /**
     * Set the stereo width of a bus armed with { width } (S5). Caller-frame safe:
     * like setPosition(), it does NO param write and allocates nothing -- it only
     * clamps, stamps two fields (the target width and the settle counter) and sets a
     * dirty bit. The wet/makeup AudioParam writes ride the cold ~10 Hz monitor
     * (_flushWidth), so a caller that drives width every frame still produces at most
     * one param event per axis per tick. Fail closed: an unarmed bus, a bus disarmed
     * for a non-mono source (widthRefused set), or a non-number / NaN width is a
     * silent no-op. `w` is clamped to [0, 1]; 0 fully bypasses (bit-exact after the
     * settle), 1 is fully wide.
     * @param {string} busName
     * @param {number} w - target width, clamped to [0, 1]
     * @returns {void}
     */
    setWidth(busName, w) {
        if (this._destroyed) return;
        const busRec = this._buses.get(busName);
        if (busRec === undefined) return;
        if (busRec.wideIn === null) return;          // unarmed bus
        if (busRec.widthRefused !== null) return;    // disarmed (non-mono source)
        if (typeof w !== 'number' || w !== w) return;  // non-number / NaN
        if (w < 0) w = 0; else if (w > 1) w = 1;     // clamp to [0, 1]
        busRec.width = w;
        busRec.widthSettle = w === 0 ? WIDTH_SETTLE_TICKS : 0;
        busRec.widthDirty = 1;
    }

    /**
     * Current stereo width of a bus (S5), or null on an unarmed / disarmed / unknown
     * bus. Reflects the last accepted setWidth() target, not the param's momentary
     * ramp value.
     * @param {string} busName
     * @returns {number|null}
     */
    widthOf(busName) {
        const busRec = this._buses.get(busName);
        if (busRec === undefined) return null;
        if (busRec.wideIn === null || busRec.widthRefused !== null) return null;
        return busRec.width;
    }

    // ---------- Output layout (S6) -----------------------------------------

    /**
     * The engine's DETECTED output layout: the RICHEST single layout the sink can carry,
     * resolved once at init() and cached (S6/S7). LAYOUT_71 ('7.1') on a concrete integer
     * >= 8 channels, LAYOUT_51 ('5.1') on 6 or 7, LAYOUT_31 ('3.1') on 4 or 5, else
     * LAYOUT_STEREO ('stereo') -- the fail-closed default for every unverified sink
     * (< 4, non-integer, NaN, null, absent). A mid-session device change does not
     * re-detect. Cold readout; safe any time after init().
     * @returns {'7.1'|'5.1'|'3.1'|'stereo'}
     */
    layoutOf() { return this._layout; }

    /**
     * A discrete bus's EFFECTIVE layout: the BUILT preset token ('7.1'/'5.1'/'3.1') after
     * the request was stepped down the fallback ladder to fit the sink, 'stereo' when a
     * discrete request fell all the way back (even 3.1 did not fit), or null on a
     * non-discrete bus or an unknown name. This is how a caller learns whether -- and how
     * far -- the fallback stepped: a '7.1' request on a 6ch sink returns '5.1' here, and a
     * discrete request on a 2ch sink returns 'stereo', both correct, not errors. Distinct
     * from layoutOf(), which reports the sink CAPABILITY, not the per-bus built layout.
     * @param {string} busName
     * @returns {'7.1'|'5.1'|'3.1'|'stereo'|null}
     */
    effectiveLayoutOf(busName) {
        return this._buses.get(busName)?.effectiveLayout ?? null;
    }

    /**
     * Tear down a bus's stereo widener (S5). Called COLD when defineSounds discovers
     * a non-mono source (a Haas widener only makes sense on a mono source) and by
     * destroy(). Disconnects and nulls all 7 widener nodes, routes the pool's future
     * output back to the bus gain, and records the disarm reason so setWidth() stays
     * a no-op and a caller can introspect why. Warns once per disarm reason.
     * @param {Object} busRec
     * @param {string|null} reason - e.g. 'stereo-source', or null for a plain teardown
     */
    _disarmWidth(busRec, reason) {
        if (busRec.wideIn === null) { if (reason !== null) busRec.widthRefused = reason; return; }
        if (reason === 'stereo-source' && busRec.widthRefused !== reason &&
            typeof console !== 'undefined' && typeof console.warn === 'function') {
            console.warn('LiteAudio: bus stereo widener disarmed -- a loaded source is not mono; ' +
                'the Haas widener is a mono-source effect, so setWidth() is now a no-op on this bus.');
        }
        try { busRec.wideIn.disconnect(); } catch {}
        try { busRec.wideMakeup.disconnect(); } catch {}
        try { busRec.wideWet.disconnect(); } catch {}
        try { busRec.delayL.disconnect(); } catch {}
        try { busRec.delayR.disconnect(); } catch {}
        try { busRec.panL.disconnect(); } catch {}
        try { busRec.panR.disconnect(); } catch {}
        busRec.wideIn = null;
        busRec.wideMakeup = null;
        busRec.wideWet = null;
        busRec.delayL = null;
        busRec.delayR = null;
        busRec.panL = null;
        busRec.panR = null;
        busRec.poolOut = busRec.gain;
        busRec.widthDirty = 0;
        busRec.widthSettle = 0;
        if (reason !== null) busRec.widthRefused = reason;
    }

    // ---------- Ducking (v1.2.0) -------------------------------------------

    /**
     * Duck a bus: dip its sidechain gain to `level` over an attack time
     * constant. `level` is a 0..1 multiplier applied UNDER the bus's own
     * volume and mute (they live on separate AudioParams and compose), so a
     * ducked-and-muted bus is still silent and a duck survives a volume change.
     *
     * This is the manual, always-wins primitive. It latches the bus out of any
     * automatic follower (duckOn) until stopDuck() releases it - an automatic
     * duck a caller cannot override is a bug report waiting to be filed.
     *
     * `level` 0 approaches silence but, like every bus write, never reaches it
     * (setTargetAtTime is exponential); 1 is no duck. attack/release are time
     * constants in seconds. release is remembered for the matching stopDuck().
     * @param {string} busName
     * @param {number} [level=0] - target sidechain multiplier, 0..1
     * @param {Object} [opts]
     * @param {number} [opts.attack] - dip time constant, seconds
     * @param {number} [opts.release] - recovery time constant, seconds (remembered)
     */
    duck(busName, level = 0, opts = {}) {
        if (this._destroyed) return;
        const busRec = this._buses.get(busName);
        if (!busRec) return;
        const attack = opts.attack ?? DUCK_ATTACK_TC;
        if (opts.release != null) busRec.duckRelease = opts.release;
        busRec.duckManual = true;
        busRec.duckGain.gain.setTargetAtTime(level, this._ctx.currentTime, attack);
    }

    /**
     * Release a manual duck: restore the sidechain gain to its resting value
     * over the release time constant, and clear the manual latch so the
     * automatic follower (if any) drives this bus again.
     * @param {string} busName
     * @param {Object} [opts]
     * @param {number} [opts.release] - recovery time constant, seconds
     */
    stopDuck(busName, opts = {}) {
        if (this._destroyed) return;
        const busRec = this._buses.get(busName);
        if (!busRec) return;
        const release = opts.release ?? busRec.duckRelease ?? DUCK_RELEASE_TC;
        busRec.duckManual = false;
        busRec.duckGain.gain.setTargetAtTime(DUCK_REST, this._ctx.currentTime, release);
    }

    /**
     * Remove the automatic duck follower from `triggerBus` to `targetBus`.
     * Removes ALL rules matching the (trigger, target) pair - `opts`
     * (threshold/level/attack/release) is NOT part of the key, so a caller
     * removes "the follower", not one tuning of it. Returns `true` iff at least
     * one rule was removed, else `false` (idempotent; unknown pair / non-string
     * / null / undefined args never `===`-match a stored string pair, so they
     * return `false` without throwing).
     *
     * Stranded-target recovery (fail-CLOSED): if a removed rule was actively
     * dipping its target, that target's `duckGain` is released back to
     * `DUCK_REST` - but ONLY when it is safe: the bus still exists, is not under
     * a manual duck (stopDuck owns that latch), and is not still held dipped by
     * a SURVIVING active rule on the same target. Skipping any of those would
     * strand the bus silent forever, the fail-OPEN outcome we refuse to ship.
     * When duplicate rules with differing release TCs are removed together, the
     * FIRST-removed rule's `.release` governs the single recovery ramp (D5).
     *
     * Cold path, zero-alloc: an order-preserving in-place write-index
     * compaction (no splice/filter garbage) plus a small survivor scan only when
     * a removed rule was active. It NEVER pokes `_monitorTimer` / `_startMonitor`
     * - when this empties the last duck consumer, the shared monitor idle-sleeps
     * on its next `_monitorIdle()` tick (the PS2 mechanism), completing the
     * duckOn-only idle-sleep story. See decisions/0013.
     * @param {string} triggerBus - bus whose voice count drove the duck
     * @param {string} targetBus - bus that was being dipped
     * @returns {boolean} true if >= 1 rule was removed
     */
    removeDuckRule(triggerBus, targetBus) {
        if (this._destroyed) return false;
        const rules = this._duckRules;
        const len = rules.length;
        let w = 0;
        let hadActive = false;
        let removedRelease = DUCK_RELEASE_TC;   // first-removed rule's release governs (D5)
        let removedAny = false;
        for (let i = 0; i < len; i++) {
            const rule = rules[i];
            if (rule.triggerBus === triggerBus && rule.targetBus === targetBus) {
                if (!removedAny) removedRelease = rule.release;
                removedAny = true;
                if (rule.active) hadActive = true;
                continue;                         // drop (do not copy down)
            }
            rules[w++] = rule;                    // keep survivor, compact in place
        }
        if (!removedAny) return false;            // no match, idempotent
        for (let i = w; i < len; i++) rules[i] = null;   // release dropped refs (retention)
        rules.length = w;
        if (hadActive) {
            let heldBySurvivor = false;
            for (let i = 0; i < w; i++) {
                const r = rules[i];
                if (r.active && r.targetBus === targetBus) { heldBySurvivor = true; break; }
            }
            if (!heldBySurvivor) {
                const t = this._buses.get(targetBus);
                if (t && !t.duckManual) {
                    t.duckGain.gain.setTargetAtTime(DUCK_REST, this._ctx.currentTime, removedRelease);
                }
            }
        }
        return true;
    }

    /**
     * Register an automatic duck: while `triggerBus` has >= `threshold` voices
     * sounding, dip `targetBus` to `level`; when it falls below, recover. The
     * dip uses `attack`, the recovery uses `release` - asymmetric by default,
     * because a symmetric duck sounds wrong. Evaluated off the hot path by the
     * shared monitor. An explicit duck()/stopDuck() on the target wins: the
     * follower never touches a bus whose manual latch is set.
     * @param {string} triggerBus - bus whose voice count drives the duck
     * @param {string} targetBus - bus that gets dipped
     * @param {Object} [opts]
     * @param {number} [opts.threshold=1] - voices on triggerBus to engage
     * @param {number} [opts.level=0.3] - ducked multiplier for targetBus
     * @param {number} [opts.attack] - dip time constant, seconds
     * @param {number} [opts.release] - recovery time constant, seconds
     */
    duckOn(triggerBus, targetBus, opts = {}) {
        if (this._destroyed) return;
        const rule = {
            triggerBus,
            targetBus,
            threshold: opts.threshold ?? 1,
            level: opts.level ?? 0.3,
            attack: opts.attack ?? DUCK_ATTACK_TC,
            release: opts.release ?? DUCK_RELEASE_TC,
            active: false,
        };
        this._duckRules.push(rule);
        this._startMonitor();
    }

    // ---------- Mix snapshots (v1.2.0) -------------------------------------

    /**
     * Capture the current mix - every bus's volume and mute - under `name`.
     * Snapshots are the "menu / gameplay / paused" mixes-as-data primitive.
     * Bus gains and mutes only: track volumes are NOT captured (a track is a
     * name-addressed singleton with its own volumeGain, and folding it in would
     * couple the mix desk to the music layer). Cold path - allocates the record.
     * @param {string} name
     */
    captureSnapshot(name) {
        if (this._destroyed) return;
        const names = [];
        const vols = [];
        const mutes = [];
        for (const [busName, busRec] of this._buses) {
            names.push(busName);
            vols.push(busRec.volume.peek());
            mutes.push(busRec.muted.peek());
        }
        this._snapshots.set(name, { names, vols, mutes });
    }

    /**
     * Apply a captured snapshot, morphing the mix to it over `ms`.
     *
     * The morph rides the SIDECHAIN node, not the volume param: the volume/mute
     * signals are set to their captured targets immediately (so every reactive
     * readout is instantly truthful), the bus gain is pinned to its target, and
     * the whole ms-long audible transition is carried by a linear ramp on the
     * bus's duckGain. Continuity comes from the ACTUAL current product
     * (busGain x duckGain) read before anything changes, so a snapshot applied
     * mid-ramp - or mid-duck - picks up from where the sound actually is, with
     * no click. Applying a snapshot restates the mix, so it clears any manual
     * duck latch on the buses it touches and rests their sidechain -- but it
     * NEVER un-ducks a bus whose duckOn trigger is STILL hot: that active duck
     * RIDES THROUGH the snapshot (the sidechain is left dipped and rule.active
     * stays true, so no write is added to the hot loop and the bus is never
     * stranded un-ducked), and the existing _evalDuckRules edge rests it when
     * the trigger later drops. Only a STALE active rule (its trigger already
     * cold) is reset to inactive and rested to DUCK_REST here; a not-yet-active
     * rule re-ducks on its next edge from that safe rest value.
     *
     * A bus whose target is silence (muted or zero) is left to the volume/mute
     * signals' own click-free settle rather than a sidechain fade, so duckGain
     * is never stranded at zero.
     * @param {string} name
     * @param {number} [ms=0] - morph duration; 0 snaps via the signals.
     */
    applySnapshot(name, ms = 0) {
        if (this._destroyed) return;
        const snap = this._snapshots.get(name);
        if (!snap) return;
        const now = this._ctx.currentTime;
        for (let i = 0; i < snap.names.length; i++) {
            const busRec = this._buses.get(snap.names[i]);
            if (!busRec) continue;
            const tgtVol = snap.vols[i];
            const tgtMuted = snap.mutes[i];
            const tgtEff = tgtMuted ? 0 : tgtVol;

            // Actual audible product BEFORE any change - interrupt-safe.
            const curProduct = busRec.gain.gain.value * busRec.duckGain.gain.value;

            // Signals = truth, applied now.
            busRec.volume.set(tgtVol);
            busRec.muted.set(tgtMuted);

            // A snapshot restates the mix: drop any manual duck latch.
            busRec.duckManual = false;
            const dg = busRec.duckGain.gain;

            // PS6 reconcile (zero-alloc indexed scan, mirrors removeDuckRule):
            // an ACTIVE duckOn rule whose trigger is STILL hot must keep this
            // bus ducked across the snapshot -- resting it would strand it
            // un-ducked until a fresh trigger edge. So:
            //  - active + trigger hot  -> the duck RIDES THROUGH: leave the
            //    sidechain dipped and rule.active TRUE; _evalDuckRules rests it
            //    when the trigger later drops (edge active:true -> shouldDuck:false).
            //  - active + trigger cold -> a STALE duck: reset rule.active=false
            //    and let the rest below settle the sidechain to DUCK_REST.
            let heldHot = false;
            const rules = this._duckRules;
            for (let r = 0; r < rules.length; r++) {
                const rule = rules[r];
                if (rule.targetBus !== snap.names[i]) continue;
                if (!rule.active) continue;
                const trig = this._buses.get(rule.triggerBus);
                const voices = trig && trig.pool ? trig.pool.activeCount() : 0;
                if (voices >= rule.threshold) heldHot = true;
                else rule.active = false;
            }

            if (heldHot) {
                // Duck rides through: bus volume is restated by the signals
                // above (click-free at RAMP_TC); the sidechain stays where the
                // live duck holds it (do NOT cancel/rest it, do NOT pin the gain
                // morph -- there is nothing to morph toward while the trigger is
                // hot). No strand, no pump, no ramp-vs-tick fight. The existing
                // _evalDuckRules edge rests it when the trigger later drops.
                continue;
            }

            dg.cancelScheduledValues(now);
            if (ms > 0 && tgtEff > 0) {
                // Pin the bus gain to target and carry the ms morph on the
                // sidechain, starting from whatever keeps the product continuous.
                busRec.gain.gain.cancelScheduledValues(now);
                busRec.gain.gain.setValueAtTime(tgtEff, now);
                dg.setValueAtTime(curProduct / tgtEff, now);
                dg.linearRampToValueAtTime(DUCK_REST, now + ms / 1000);
            } else {
                // Snap: signals settle the bus at RAMP_TC (already click-free);
                // rest the sidechain.
                dg.setValueAtTime(DUCK_REST, now);
            }
        }
    }

    // ---------- Dynamic buses + meters (v1.2.0) ----------------------------

    /**
     * Create a bus after init(). The static set from opts.buses covers most
     * games, but a bus added at runtime is exactly the path that can walk off
     * the 2^21 handle ceiling, so the fail-closed check that init() does up
     * front is repeated here. Idempotent: an existing name returns its record.
     *
     * `{ meter: true }` taps an AnalyserNode for level() readouts; without it
     * no AnalyserNode is allocated. A bus created here gets its pool the first
     * time a sound is routed to it via defineSounds().
     * @param {string} name
     * @param {Object} [opts]
     * @param {boolean} [opts.meter=false]
     * @returns {Object} the bus record (opaque; use the named accessors).
     */
    createBus(name, opts = {}) {
        if (this._destroyed) throw new Error('LiteAudio: destroyed');
        if (!this._initialized) throw new Error('LiteAudio: init() before createBus()');
        if (name === 'master') throw new Error('LiteAudio: "master" is a reserved bus name');
        if (this._buses.has(name)) return this._buses.get(name);
        if (this._busList.length >= MAX_BUSES) {
            throw new RangeError(
                'LiteAudio: bus "' + name + '" would exceed the handle ceiling of ' +
                MAX_BUSES + ' (2^21). A voice handle is busIndex * 2^32 + poolHandle ' +
                'and stops being an exact integer past bus index 2^21 - 1.'
            );
        }
        const busRec = this._buildBus(name, opts);
        // Stamp the record as dynamically created (PS1). Only createBus() buses carry
        // dynamic:true, so destroyBus() can tear this one down individually; the static
        // opts.buses set (built by the same _buildBus) stays dynamic:false and is refused.
        busRec.dynamic = true;
        return busRec;
    }

    /**
     * Tear down ONE dynamic bus (a bus built by createBus), releasing its pool,
     * positional/discrete/width scratch, per-bus signals, monitor registrations and
     * graph edges -- WITHOUT disturbing any other bus's live voice handles. This is
     * the per-bus counterpart to createBus: a long-lived app that churns dynamic
     * buses (SPA route changes, scene swaps) would otherwise retain every bus's
     * graph, pool and signals for the process life. Cold path only; play(), stop(),
     * setPosition(), the lane/position flushes and the monitor tick gain no branch --
     * they already fail-close on a hollowed bus.
     *
     * TOMBSTONE, not splice. Every voice handle decodes its owning bus by array
     * index (this._busList[(handle / BUS_STRIDE) | 0]); splicing the bus out of
     * _busList would shift every later bus's index and silently reassign live handles
     * to the WRONG bus. So the record is hollowed IN PLACE and its _busList slot is
     * kept as an inert husk (pool:null, lanes:0, posDirty:null) that every hot/monitor
     * path already fail-closes on. The slot is never reused; createBus keeps appending
     * (tombstones count against the 2^21 bus ceiling -- see decisions/0010).
     *
     * Idempotent and fail-closed: returns true when a live dynamic bus was torn down;
     * false for an unknown name, an already-dead bus, or a destroyed engine. Throws on
     * 'master' or a STATIC bus (one from opts.buses) -- those are structural topology,
     * not a per-scene resource.
     *
     * @param {string} name
     * @returns {boolean} true if a live dynamic bus was destroyed, else false.
     */
    destroyBus(name) {
        if (this._destroyed) return false;
        if (name === 'master') {
            throw new Error('LiteAudio: "master" is a reserved bus and cannot be destroyed');
        }
        const busRec = this._buses.get(name);
        if (!busRec) return false;                 // unknown / already deleted -> no-op
        if (busRec.dead) return false;             // double-destroy -> no-op
        if (!busRec.dynamic) {
            throw new Error('LiteAudio: bus "' + name + '" is static (from opts.buses) and ' +
                'cannot be destroyed; only createBus() buses can be torn down individually.');
        }

        // Reuse destroy()'s per-bus teardown for this ONE bus. pool.destroy() first so
        // voice fade-outs schedule against a still-live graph, THEN pool = null: the
        // stop()/isPlaying()/play() fail-closed guards all key off !busRec.pool, so the
        // explicit null is REQUIRED to make a stale handle a no-op.
        if (busRec.pool) { try { busRec.pool.destroy(); } catch {} busRec.pool = null; }
        // Release the positional/discrete scratch (S3/S6). Null, not zero: a torn-down
        // bus has no voices, so a stray setPosition after teardown must no-op.
        busRec.posXYZ = null;
        busRec.posOwner = null;
        busRec.posDirty = null;
        // Drop any live HRIR prewarm handle (SP-07); the pool is gone, so no retire tick
        // may try to stop a handle into a torn-down pool.
        busRec.hrtfWarmHandle = null;
        busRec.hrtfWarmPending = 0;
        // Disconnect + null all 7 stereo widener nodes (S5) and reset width state, so a
        // stray setWidth after teardown no-ops via the wideIn===null guard.
        this._disarmWidth(busRec, null);
        busRec.width = 0;
        busRec.widthLast = NaN;
        busRec.widthRefused = null;
        // Reset discrete-surround state (S6/S7): lanes to 0 so the husk never re-enters
        // _flushLanes, vbap/effectiveLayout to null so no cold solve runs against it and
        // a stray effectiveLayoutOf reads "no discrete bus".
        busRec.lanes = 0;
        busRec.vbap = null;
        busRec.effectiveLayout = null;

        // Disconnect the bus graph and dispose the per-bus signals + write effect,
        // exactly as destroy() does -- idempotent, foreign-safe blanket try/catch.
        try { busRec.gain.disconnect(); } catch {}
        try { busRec.duckGain?.disconnect(); } catch {}
        try { busRec.analyser?.disconnect(); } catch {}
        try { dispose(busRec.volume); } catch {}
        try { dispose(busRec.muted); } catch {}
        if (busRec.level) { try { dispose(busRec.level); } catch {} }
        try { dispose(busRec.effect); } catch {}

        // Swap-pop the bus's write-effect handle out of _effectHandles so a later full
        // destroy() does not walk it a second time. Order is irrelevant here, so a
        // swap-with-last + pop is allocation-free (no splice, no shift).
        const eh = this._effectHandles;
        for (let i = 0; i < eh.length; i++) {
            if (eh[i] === busRec.effect) { eh[i] = eh[eh.length - 1]; eh.pop(); break; }
        }

        // Deregister from the two monitor lists by swap-pop (order irrelevant on both).
        // A husk left in either list would ride the flush; it is pulled out here so the
        // monitor never visits it again. Not-present is a no-op (loop finds nothing).
        const mb = this._meteredBuses;
        for (let i = 0; i < mb.length; i++) {
            if (mb[i] === busRec) { mb[i] = mb[mb.length - 1]; mb.pop(); break; }
        }
        const db = this._discreteBuses;
        for (let i = 0; i < db.length; i++) {
            if (db[i] === busRec) { db[i] = db[db.length - 1]; db.pop(); break; }
        }

        // Drop the name bindings. The _busList[busRec.index] slot is KEPT as a dead
        // husk -- never spliced, never nulled (a null element would break the
        // _flushPositions busRec.lanes read) and never reused. _duckRules and
        // _snapshots are left untouched: both already fail-closed by name resolution
        // (_buses.get returns undefined for a destroyed bus and each guard skips it).
        this._buses.delete(name);
        this._soundsByBus.delete(name);

        // Null the disconnected graph refs + meter buffer LAST (after the swap-pops that
        // read busRec.effect and match on the busRec identity) so the husk retains only
        // its bookkeeping (index/dynamic/dead), not the node graph or the metering
        // scratch. destroy() skips this because it clears _busList wholesale; a destroyBus
        // husk PERSISTS for the engine's life, so shrinking it here is a real retention
        // win for the churn case this method serves. No hot/monitor path reads these on a
        // husk (pool/posDirty/lanes are already null/0 and each walker fail-closes first).
        busRec.gain = null;
        busRec.duckGain = null;
        busRec.analyser = null;
        busRec.meterBuffer = null;
        busRec.volume = null;
        busRec.muted = null;
        busRec.level = null;
        busRec.effect = null;
        busRec.poolOut = null;

        busRec.dead = true;
        return true;
    }

    /**
     * Reactive readable: a metered bus's level (RMS of the time-domain signal,
     * updated ~10 Hz), or null on an unmetered or unknown bus.
     * @param {string} busName
     * @returns {Object|null} ReadSignal<number> or null
     */
    level(busName) {
        return this._buses.get(busName)?.level ?? null;
    }

    // ---------- Auto-suspend (v1.2.0) --------------------------------------

    /**
     * Arm auto-suspend: after `after` seconds with no SFX voice and no playing
     * track, the context is suspended to stop the hardware spinning on silence.
     * A later play() resumes it (see play()).
     *
     * Refused on iOS and returns false: there, a suspend -> resume can demand a
     * fresh user gesture, which would silently un-unlock a page that was
     * working. Off by default everywhere. See decisions/0005-auto-suspend.md.
     * @param {Object} [opts]
     * @param {number} [opts.after=30] - silent seconds before suspending
     * @returns {boolean} whether auto-suspend was armed
     */
    enableAutoSuspend(opts = {}) {
        if (this._destroyed) return false;
        if (this._isIOS()) return false;
        this._autoSuspend = true;
        this._autoSuspendAfter = opts.after ?? 30;
        this._silentSince = -1;
        this._startMonitor();
        return true;
    }

    /** Disarm auto-suspend. Does not resume a context we already suspended - a
     *  play() or the app does that. */
    disableAutoSuspend() {
        this._autoSuspend = false;
        this._silentSince = -1;
    }

    /**
     * True while the context is suspended by OUR auto-suspend (not by the app
     * or the OS). Lets a HUD show a "dormant" state distinct from a manual pause.
     */
    isAutoSuspended() {
        return this._selfSuspended;
    }

    /** iOS/iPadOS detection for the auto-suspend guard. iPadOS 13+ reports as
     *  Macintosh, so the touch-point count disambiguates a real Mac. */
    _isIOS() {
        const nav = this._window && this._window.navigator;
        if (!nav) return false;
        const ua = nav.userAgent || '';
        if (/iP(hone|ad|od)/.test(ua)) return true;
        if (/Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1) return true;
        return false;
    }

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

    // ---------- Shared monitor (meters / duck follower / auto-suspend) -----

    /**
     * Start the shared monitor if it is not already running. Idempotent: every
     * consumer (a duckOn rule, a metered bus, enableAutoSuspend) calls it, and
     * only the first one arms the timer. The tick closure is built once and
     * reschedules itself by reference so no closure is allocated per tick.
     *
     * Sleep-wake: the tick evaluates _monitorIdle() at its tail and SLEEPS -- by
     * not rescheduling -- when no consumer is live. The sleep needs no unwind: the
     * tick already nulled _monitorTimer at its head, so a slept monitor simply has
     * _monitorTimer === null with no pending id. Every registration site
     * (createBus meter/discrete/positional/hrtf, duckOn, enableAutoSuspend, the
     * pool-build wake, _wakeFromAutoSuspend) calls back into _startMonitor, whose
     * `if (this._monitorTimer != null) return;` guard re-arms exactly one timer.
     */
    _startMonitor() {
        if (this._monitorTimer != null) return;
        if (!this._monitorTick) {
            this._monitorTick = () => {
                this._monitorTimer = null;
                if (this._destroyed) return;
                // Retire any HRIR prewarm voice FIRST, before the duck follower, the
                // meter sweep or the auto-suspend check reads activeCount(). The
                // prewarm voice is armed OUTSIDE the tick (at unlock / pool build), so
                // by retiring it at the head of the very next tick no user-facing
                // mix logic ever observes it as "something playing": no duck flicker,
                // no delayed auto-suspend. This is the deliberate resolution of the
                // planner's risk -- the voice is retired fast rather than special-
                // cased out of activeCount, keeping the hot accounting path untouched.
                this._retireHrtfWarm();
                this._evalDuckRules();
                this._sweepMeters();
                this._flushPositions();
                this._flushLanes();
                this._flushWidth();
                this._evalAutoSuspend();
                if (this._monitorIdle()) return;   // sleep: _monitorTimer already null
                this._monitorTimer = this._setTimeout(this._monitorTick, MONITOR_INTERVAL_MS);
            };
        }
        this._monitorTimer = this._setTimeout(this._monitorTick, MONITOR_INTERVAL_MS);
    }

    /**
     * Idle predicate: true when NO monitor consumer is live, read ONCE at the
     * tick tail to guard the reschedule. Cold-tick only -- never a hot-path
     * branch; play()/stop()/setPosition() are byte-unchanged. Allocation-free:
     * scalar/.length reads plus one indexed for over _busList (the same array the
     * tick already walks 3x/tick), locals only. No iterator, no Array method, no
     * closure, no temp object, no ?.-chain.
     *
     * FAIL CLOSED TOWARD AWAKE. Any ambiguity or unverified state returns false
     * (not idle) and keeps ticking: sleeping wrongly is silent breakage (frozen
     * positions, a duck that never fires, silence never detected); staying awake
     * wrongly costs one timer. null is not zero.
     *
     * Each _busList clause is the literal negation of its walker's OWN outer skip,
     * so predicate and walker can never disagree: hrtfWarmHandle mirrors
     * _retireHrtfWarm's skip (:2733), wideIn mirrors _flushWidth's (:2592),
     * pool !== null && posDirty !== null mirrors _flushPositions' (:2449/:2451).
     * busRec.positional / .spatial are deliberately NOT read -- destroyBus never
     * clears them, so a tombstone husk would pin the monitor awake forever.
     *
     * R5 contract: every new monitor consumer MUST add a clause here, mirroring
     * its walker's skip condition.
     */
    _monitorIdle() {
        if (this._meteredBuses.length !== 0)  return false;   // C1
        if (this._discreteBuses.length !== 0) return false;   // C2
        if (this._duckRules.length !== 0)     return false;   // C3 (R1: permanent)
        if (this._autoSuspend && !this._selfSuspended) return false; // C4

        const list = this._busList;
        for (let b = 0; b < list.length; b++) {
            const busRec = list[b];
            if (busRec.dead) continue;                        // tombstone husk
            if (busRec.hrtfWarmHandle !== null) return false; // C7 == _retireHrtfWarm
            if (busRec.wideIn !== null) return false;         // C6 == _flushWidth
            if (busRec.pool !== null && busRec.posDirty !== null) return false; // C5
        }
        return true;                                          // no consumer: may sleep
    }

    /**
     * Evaluate automatic-duck rules. Writes to a target bus only on an EDGE
     * (the trigger crossing its threshold), so steady state is free and a
     * held-down trigger does not re-schedule a ramp every tick. A bus under an
     * explicit duck() (manual latch set) is skipped - manual always wins.
     * Allocation-free: indexed loops, Map.get, pool.activeCount() (documented
     * zero-alloc), and at most one setTargetAtTime on an edge.
     */
    _evalDuckRules() {
        const rules = this._duckRules;
        for (let i = 0; i < rules.length; i++) {
            const rule = rules[i];
            const target = this._buses.get(rule.targetBus);
            if (!target || target.duckManual) continue;
            const trig = this._buses.get(rule.triggerBus);
            const voices = trig && trig.pool ? trig.pool.activeCount() : 0;
            const shouldDuck = voices >= rule.threshold;
            if (shouldDuck === rule.active) continue;   // no edge, no write
            rule.active = shouldDuck;
            const now = this._ctx.currentTime;
            if (shouldDuck) {
                target.duckGain.gain.setTargetAtTime(rule.level, now, rule.attack);
            } else {
                target.duckGain.gain.setTargetAtTime(DUCK_REST, now, rule.release);
            }
        }
    }

    /**
     * Read every metered bus's analyser into its pre-allocated buffer and write
     * the RMS to the bus's level() signal. Allocation-free per read: the buffer
     * is created once in _attachMeter, getFloatTimeDomainData writes in place,
     * and the RMS math uses locals only. Runs at the monitor's ~10 Hz.
     */
    _sweepMeters() {
        const metered = this._meteredBuses;
        for (let i = 0; i < metered.length; i++) {
            const busRec = metered[i];
            const buf = busRec.meterBuffer;
            busRec.analyser.getFloatTimeDomainData(buf);
            let sumSq = 0;
            for (let j = 0; j < buf.length; j++) { const s = buf[j]; sumSq += s * s; }
            busRec.level.set(Math.sqrt(sumSq / buf.length));
        }
    }

    /**
     * Flush pending positions on the cold ~10 Hz monitor (S3). This is the ONLY
     * place positionX/Y/Z are written, throttled to the monitor cadence: a caller
     * that calls setPosition() every frame (60 Hz) still produces at most one
     * write per axis per tick (~10 Hz), which is the SP-03 native-event bound
     * (counted PER PARAM, not summed across axes -- ~100 events/param over 10 s).
     *
     * Steal-safety: posOwner holds the full gen+channel handle that stamped each
     * slot. voiceNode() is generation-checked and fail-closed, so a channel
     * stolen since setPosition() resolves to null here -- the bit is cleared and
     * the stale position is never written onto the new occupant. Allocation-free:
     * indexed word scan, no iterators, no per-voice objects.
     */
    _flushPositions() {
        const list = this._busList;
        const now = this._ctx.currentTime;
        for (let b = 0; b < list.length; b++) {
            const busRec = list[b];
            // Discrete buses (S6) share the posXYZ/posOwner/posDirty scratch but their
            // dirty bits belong to _flushLanes, not here. Skip BEFORE the dirty scan so
            // the bits survive intact for the lane flush (which runs right after this on
            // the same tick); clearing them here would starve the 8-lane solve.
            if (busRec.lanes !== 0) continue;
            const dirty = busRec.posDirty;
            if (dirty === null) continue;           // stereo bus: nothing to flush
            const pool = busRec.pool;
            if (pool === null) continue;
            const xyz = busRec.posXYZ;
            const owner = busRec.posOwner;
            for (let w = 0; w < dirty.length; w++) {
                let bits = dirty[w];
                if (bits === 0) continue;
                const base = w << 5;
                while (bits !== 0) {
                    const low = bits & -bits;                  // lowest set bit
                    const ch = base + (31 - Math.clz32(low));  // its channel index
                    bits ^= low;
                    const node = pool.voiceNode(owner[ch]);
                    if (node === null) continue;               // stolen/dead: skip
                    const i3 = ch * 3;
                    node.positionX.setTargetAtTime(xyz[i3], now, POS_TC);
                    node.positionY.setTargetAtTime(xyz[i3 + 1], now, POS_TC);
                    node.positionZ.setTargetAtTime(xyz[i3 + 2], now, POS_TC);
                }
                dirty[w] = 0;                        // every bit in this word handled
            }
        }
    }

    /**
     * Pure, data-driven VBAP pan solver (S6/S7): (rec, x, y, z) -> the preset's lane gains
     * in LANE_SCRATCH, which it returns. `rec` is the frozen per-preset ring record
     * (PRESET_71/51/31) captured cold on the bus; the SAME code walks every preset with NO
     * per-tick preset branch -- the ring array length IS the selector. Zero allocation
     * (writes the one reused module scratch, width 8, shared across all presets), no
     * Math.hypot, no array literal, no closure. Constant-power pairwise (VBAP) panning over
     * the preset's NON-LFE ring lanes: azimuth az = atan2(x, -z) normalized to [0, 360)
     * picks the containing adjacent speaker pair (the ring's trailing 360 sentinel makes
     * the last wrap interval branchless), and the tangent law g1 = cos(f*PI/2),
     * g2 = sin(f*PI/2) splits the source across that pair with g1^2 + g2^2 === 1 (flat
     * power as it moves). Every OTHER ring lane in the preset is zeroed; rec.lfe (index 3)
     * is OUTSIDE the VBAP set and gets the azimuth-invariant LFE_SEND, the last write, never
     * a pan value. The solver writes ONLY the preset's own lanes, so the shared width-8
     * scratch never leaks a stale upper-lane value to a smaller preset's flush. y (height)
     * has no lane -- it is not panned (decisions/0008, 0009).
     * @param {Object} rec - PRESET_71 | PRESET_51 | PRESET_31 (frozen ring record)
     * @param {number} x
     * @param {number} y - unused for panning (folded to distance only), kept for the
     *   frozen setPosition(x,y,z) shape so the solver reads the same scratch layout.
     * @param {number} z
     * @returns {Float32Array} LANE_SCRATCH, the preset's resolved lane gains (lanes 0..N-1)
     */
    _vbapSolve(rec, x, y, z) {
        const s = LANE_SCRATCH;
        const ring = rec.ring;
        const azRing = rec.az;
        const n = ring.length;
        // Zero every ring lane THIS preset uses (data-driven, no fill closure); LFE below.
        for (let j = 0; j < n; j++) s[ring[j]] = 0;
        // atan2(x, -z): +x is right, -z is forward, so 0 degrees is dead front (center).
        let az = Math.atan2(x, -z) * RAD_TO_DEG;
        if (az < 0) az += 360;                       // normalize to [0, 360), no modulo
        // Ascending containing-pair scan. az is always < 360 (atan2 maxes at 180), and
        // azRing[n] === 360 (the wrap sentinel), so i stops at <= n-1 and never overruns.
        let i = 0;
        while (az >= azRing[i + 1]) i++;
        const span = azRing[i + 1] - azRing[i];
        const f = (az - azRing[i]) / span;
        s[ring[i]] = Math.cos(f * HALF_PI);
        s[i === n - 1 ? ring[0] : ring[i + 1]] = Math.sin(f * HALF_PI);  // last ring wraps to ring[0]
        // LFE: azimuth-invariant distance-only send, always the last lane written.
        s[rec.lfe] = LFE_SEND;
        return s;
    }

    /**
     * Flush pending discrete-surround lane gains on the cold ~10 Hz monitor (S6). The
     * discrete analogue of _flushPositions: setPosition() stamped the same
     * posXYZ/posOwner/posDirty scratch (no new branch), and here -- on the tick, right
     * after _flushPositions skipped these buses -- each dirty voice is solved once by
     * _vbapSolve over the bus's frozen preset record (busRec.vbap) and EXACTLY
     * busRec.lanes lane gains are written with setTargetAtTime(v, now, POS_TC), inheriting
     * the identical ~10 Hz cadence and 20 ms glide the position flush uses (so the SP-03
     * native-event rate bound is inherited, not re-derived). Data-driven over the ring
     * record: the write loop runs busRec.lanes times (8/6/4 for 7.1/5.1/3.1), NO per-tick
     * preset branch, and it reads only lanes 0..N-1 so a smaller preset never touches a
     * stale upper scratch lane. Steal-safe: posOwner holds the full gen+channel handle, so
     * a stolen channel resolves to a null voiceNode and its stale bit is dropped with zero
     * lane writes onto the new occupant. Allocation-free: indexed word scan, the one reused
     * LANE_SCRATCH, locals only. Iterates this._discreteBuses, empty on every non-discrete
     * engine.
     */
    _flushLanes() {
        const list = this._discreteBuses;
        const now = this._ctx.currentTime;
        for (let b = 0; b < list.length; b++) {
            const busRec = list[b];
            const pool = busRec.pool;
            if (pool === null) continue;
            const dirty = busRec.posDirty;
            if (dirty === null) continue;
            const xyz = busRec.posXYZ;
            const owner = busRec.posOwner;
            const rec = busRec.vbap;                    // frozen preset ring record
            const nLanes = busRec.lanes;                // exactly this many gains per voice
            for (let w = 0; w < dirty.length; w++) {
                let bits = dirty[w];
                if (bits === 0) continue;
                const base = w << 5;
                while (bits !== 0) {
                    const low = bits & -bits;                  // lowest set bit
                    const ch = base + (31 - Math.clz32(low));  // its channel index
                    bits ^= low;
                    const lanes = pool.voiceNode(owner[ch]); // discrete: Array(N) of gains
                    if (lanes === null) continue;              // stolen/dead: skip
                    const i3 = ch * 3;
                    const g = this._vbapSolve(rec, xyz[i3], xyz[i3 + 1], xyz[i3 + 2]);
                    for (let k = 0; k < nLanes; k++) {
                        lanes[k].gain.setTargetAtTime(g[k], now, POS_TC);
                    }
                }
                dirty[w] = 0;                        // every bit in this word handled
            }
        }
    }

    /**
     * Flush pending stereo-width changes on the cold ~10 Hz monitor (S5). This is
     * the ONLY place the widener's wet/makeup gains are written. setWidth() only
     * stamps a target + a dirty bit; here, on the tick, a dirty bus writes at most
     * one setTargetAtTime per param -- and only when the target actually MOVED
     * (widthLast !== width) -- so a caller driving width every frame still produces
     * ~10 events/param/second, the same native-event bound the position flush honours.
     *
     * The wet gain is WIDTH_WET_MAX * width; the makeup gain is 1/sqrt(1 + 4*wet^2),
     * which holds total power flat as width opens (the two hard-panned wet copies add
     * 4*wet^2 of power to the dry's 1). setTargetAtTime is exponential and never
     * reaches its target, so a width driven to exactly 0 would leave a hair of wet
     * signal forever; WIDTH_SETTLE_TICKS ticks after the last move to 0 the flush
     * snaps wet to EXACTLY 0 and makeup to EXACTLY 1 with setValueAtTime, making a
     * bypassed widener bit-identical to an unarmed bus. Allocation-free: indexed loop,
     * locals only, no iterators.
     */
    _flushWidth() {
        const list = this._busList;
        for (let b = 0; b < list.length; b++) {
            const busRec = list[b];
            if (busRec.wideIn === null) continue;    // unarmed / disarmed
            if (!busRec.widthDirty) continue;
            const w = busRec.width;
            if (w !== busRec.widthLast) {
                const wet = WIDTH_WET_MAX * w;
                const makeup = 1 / Math.sqrt(1 + 4 * wet * wet);
                const now = this._ctx.currentTime;
                busRec.wideWet.gain.setTargetAtTime(wet, now, WIDTH_TC);
                busRec.wideMakeup.gain.setTargetAtTime(makeup, now, WIDTH_TC);
                busRec.widthLast = w;
            }
            if (w === 0) {
                // Ramp is in flight; count ticks, then snap to an EXACT bypass so no
                // residual wet survives the exponential approach. Stays dirty until
                // the snap so the tick keeps counting.
                if (busRec.widthSettle > 0) {
                    busRec.widthSettle--;
                    if (busRec.widthSettle === 0) {
                        const now = this._ctx.currentTime;
                        busRec.wideWet.gain.setValueAtTime(0, now);
                        busRec.wideMakeup.gain.setValueAtTime(1, now);
                        busRec.widthDirty = 0;
                    }
                } else {
                    busRec.widthDirty = 0;
                }
            } else {
                busRec.widthDirty = 0;
            }
        }
    }

    /**
     * Auto-suspend: when every bus has been silent (no SFX voices, no playing
     * track) for _autoSuspendAfter seconds, suspend the context to stop the
     * audio hardware spinning on silence. A later play() wakes it (see play()).
     * Off unless enableAutoSuspend() armed it, and it never engages on a context
     * we did not observe reach 'running' via unlock. Allocation-free.
     */
    _evalAutoSuspend() {
        if (!this._autoSuspend || this._selfSuspended) return;
        const ctx = this._ctx;
        if (!ctx || ctx.state !== 'running' || !this._sUnlocked.peek()) {
            this._silentSince = -1;
            return;
        }
        const silent = this.activeCount() === 0 && !this._anyTrackPlaying();
        if (!silent) { this._silentSince = -1; return; }
        const now = ctx.currentTime;
        if (this._silentSince < 0) { this._silentSince = now; return; }
        if (now - this._silentSince >= this._autoSuspendAfter) {
            this._silentSince = -1;
            this._selfSuspended = true;
            if (typeof ctx.suspend === 'function') {
                const p = ctx.suspend();
                if (p && typeof p.catch === 'function') p.catch(() => {});
            }
        }
    }

    /** Zero-alloc scan for any playing track (indexed, no Map iterator). */
    _anyTrackPlaying() {
        const list = this._trackList;
        for (let i = 0; i < list.length; i++) {
            if (list[i].playing.peek()) return true;
        }
        return false;
    }

    /**
     * Wake a context WE auto-suspended, from the play() hot path. Deliberately
     * NOT the full D3 unlock ceremony: the context is already unlocked, so the
     * silent-buffer pulse is unnecessary (and allocates), and auto-suspend is
     * hard-off on iOS so a plain resume() is all any live platform needs. We do
     * not await it - a source scheduled now onto a frozen-clock context is
     * pinned by the spec to the resume boundary and plays from its head, so the
     * native scheduler holds the triggering voice for us. No microtask, no
     * allocation. See decisions/0005-auto-suspend.md.
     */
    _wakeFromAutoSuspend() {
        this._selfSuspended = false;
        // Re-arm the monitor BEFORE the ctx/resume guard below: _selfSuspended is
        // now false, so auto-suspend is a live consumer again, but a context that
        // lacks resume must still restart the monitor -- returning first would
        // leave silence-tracking permanently dead (fail-closed ordering).
        this._startMonitor();
        const ctx = this._ctx;
        if (!ctx || typeof ctx.resume !== 'function') return;
        const p = ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
    }

    // ---------- HRTF prewarm (SP-07) ---------------------------------------

    /**
     * Prewarm the HRIR (head-related impulse-response) set for an 'hrtf' bus by
     * playing ONE silent (gain=0) voice through the pool. A browser loads the
     * per-voice HRTF convolution kernels lazily on the first HRTF PannerNode that
     * sounds, so the first REAL play would otherwise stutter while the set loads;
     * this eats that hitch up front. Cold path: called at the unlock transition
     * and at pool build, never on a hot frame.
     *
     * Fires at most ONCE per bus -- the hrtfWarmed latch is the idempotence key
     * across both call sites. Fail closed at every gate: not an hrtf bus, no pool,
     * a still-locked context, or already warmed -> no-op; a play() that returns a
     * skip sentinel (< 0) leaves the latch CLEAR (null, not zero) so the next pool
     * build retries. lite-audio NEVER sets panningModel here -- the pool owns its
     * spatial nodes (Route-A); this only routes a silent voice through it.
     * @param {Object} busRec
     */
    _prewarmHrtf(busRec) {
        if (busRec.spatial !== 'hrtf') return;
        if (busRec.pool === null) return;
        if (!this._sUnlocked.peek()) return;          // needs a running context
        if (busRec.hrtfWarmed) return;                // fire exactly once per bus
        // Find a ready sound routed to THIS bus to name the pool voice. Cold lookup
        // (once per bus over its whole life), so the Map iterator is acceptable here.
        let soundId = null;
        for (const [id, rec] of this._sounds) {
            if (rec.loadState.peek() === 'ready' && this._buses.get(rec.busName) === busRec) {
                soundId = id;
                break;
            }
        }
        if (soundId === null) return;                 // nothing loaded yet: retry next build
        const handle = this.play(soundId, 0, 0, 1);   // gain=0 silent prewarm voice
        if (handle < 0) return;                       // fail closed, no latch: retry next build
        busRec.hrtfWarmHandle = handle;
        busRec.hrtfWarmed = true;
        busRec.hrtfWarmPending = 1;                   // retire on the NEXT monitor tick
        this._startMonitor();                         // ensure a tick fires to retire it
    }

    /**
     * Retire HRIR prewarm voices on the monitor tick. A prewarm voice is armed
     * with hrtfWarmPending = 1 OUTSIDE the tick; the first tick after arming
     * decrements it to 0 and stops the voice, giving the browser up to one full
     * monitor interval (~100 ms) with a live HRTF PannerNode to load its kernels.
     * No wall-clock read -- the pending counter IS the latch. Null (not zero) the
     * handle after stop so a stale handle can never be double-stopped. Allocation-
     * free: indexed loop, and non-hrtf buses fall through on the null-handle guard.
     */
    _retireHrtfWarm() {
        const list = this._busList;
        for (let b = 0; b < list.length; b++) {
            const busRec = list[b];
            if (busRec.hrtfWarmHandle === null) continue;   // no live prewarm on this bus
            if (busRec.hrtfWarmPending > 0) {
                busRec.hrtfWarmPending--;
                if (busRec.hrtfWarmPending > 0) continue;   // still within the load window
            }
            this.stop(busRec.hrtfWarmHandle);
            busRec.hrtfWarmHandle = null;                   // null, not zero
            busRec.hrtfWarmPending = 0;
        }
    }

    /**
     * Attach an AnalyserNode to a bus for level() metering. Taps duckGain (post
     * volume, mute AND duck) so the meter reads what actually reaches master.
     * The analyser is a pure observer - it is not connected onward. The read
     * buffer is allocated ONCE here, never per read.
     */
    _attachMeter(busRec) {
        if (busRec.analyser) return;
        if (typeof this._ctx.createAnalyser !== 'function') return;
        const analyser = this._ctx.createAnalyser();
        busRec.duckGain.connect(analyser);
        busRec.analyser = analyser;
        busRec.meterBuffer = new Float32Array(analyser.fftSize);
        busRec.level = signal(0);
        this._meteredBuses.push(busRec);
        this._startMonitor();
    }

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

        // Stop the shared monitor so no tick fires into a torn-down engine.
        if (this._monitorTimer != null) {
            this._clearTimeout(this._monitorTimer);
            this._monitorTimer = null;
        }

        if (this._statechangeHandler && this._ctx?.removeEventListener) {
            this._ctx.removeEventListener('statechange', this._statechangeHandler);
        }

        // stopAll first so voice fade-outs schedule against a still-live graph.
        for (const [, busRec] of this._buses) {
            if (busRec.pool) { try { busRec.pool.destroy(); } catch {} busRec.pool = null; }
            // Release the positional scratch (S3). Null, not zero: a torn-down bus
            // has no voices, so a stray setPosition after destroy must no-op.
            busRec.posXYZ = null;
            busRec.posOwner = null;
            busRec.posDirty = null;
            // Drop any live HRIR prewarm handle (SP-07). Null, not zero: the pool
            // above was already destroyed, so the retire tick must never try to stop
            // a handle into a torn-down pool.
            busRec.hrtfWarmHandle = null;
            busRec.hrtfWarmPending = 0;
            // Disconnect + null all 7 stereo widener nodes (S5) and reset width state.
            // Null (not zero): a torn-down bus carries no widener, so a stray setWidth
            // after destroy must no-op via the wideIn===null guard.
            this._disarmWidth(busRec, null);
            busRec.width = 0;
            busRec.widthLast = NaN;
            busRec.widthRefused = null;
            // Reset discrete-surround state (S6/S7). lanes back to 0 so a torn-down bus
            // never re-enters _flushLanes; vbap to null (not a stale record) so no cold
            // solve can run against a torn-down bus; effectiveLayout to null (not a token)
            // so a stray effectiveLayoutOf after destroy reads "no discrete bus", not a
            // stale layout. The pool above (discrete merger/lowpass/lanes) was already
            // disconnected by pool.destroy().
            busRec.lanes = 0;
            busRec.vbap = null;
            busRec.effectiveLayout = null;
        }
        // Empty the discrete-bus list and restore the destination channel triple we
        // saved at the first discrete pool build (S6). Null (not a zeroed triple) is
        // the "never mutated" state: an engine that never built a discrete pool leaves
        // _destChannelSaved null and writes nothing back onto the destination.
        this._discreteBuses.length = 0;
        if (this._destChannelSaved !== null && this._ctx && this._ctx.destination) {
            const dest = this._ctx.destination;
            dest.channelCount = this._destChannelSaved.channelCount;
            dest.channelCountMode = this._destChannelSaved.channelCountMode;
            dest.channelInterpretation = this._destChannelSaved.channelInterpretation;
            this._destChannelSaved = null;
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

        // Dispose every SIGNAL too, not just the effects above. Signals are
        // pool-backed nodes in lite-signal exactly like effects; disposing only
        // the effects returned ~a third of the nodes and leaked the rest, so a
        // build/teardown-churned host (SPA route changes, a test suite, hot
        // reload) slowly exhausted the shared node pool. Disposed AFTER the
        // effects, so no live effect can read a signal mid-teardown. dispose() is
        // idempotent and foreign-safe, hence the blanket try/catch.
        try { dispose(this._sMuted); } catch {}
        try { dispose(this._sUnlocked); } catch {}
        try { dispose(this._sCtxState); } catch {}
        for (const [, rec] of this._sounds) {
            try { dispose(rec.loadState); } catch {}
        }
        for (const [, rec] of this._tracks) {
            try { dispose(rec.loadState); } catch {}
            try { dispose(rec.playing); } catch {}
            try { dispose(rec.position); } catch {}
            try { dispose(rec.duration); } catch {}
        }

        // Disconnect bus, sidechain, analyser and master gains -- and dispose the
        // per-bus signals (volume, mute, and the metered level readout) on the
        // same pass.
        for (const [, busRec] of this._buses) {
            try { busRec.gain.disconnect(); } catch {}
            try { busRec.duckGain?.disconnect(); } catch {}
            try { busRec.analyser?.disconnect(); } catch {}
            try { dispose(busRec.volume); } catch {}
            try { dispose(busRec.muted); } catch {}
            if (busRec.level) { try { dispose(busRec.level); } catch {} }
        }
        try { this._master?.disconnect(); } catch {}

        this._buses.clear();
        this._busList.length = 0;
        this._sounds.clear();
        this._soundsByBus.clear();
        this._pendingPlays.clear();
        this._tracks.clear();
        this._trackList.length = 0;
        this._lastPlayed.clear();
        this._duckRules.length = 0;
        this._snapshots.clear();
        this._meteredBuses.length = 0;
        this._monitorTick = null;
        this._master = null;
        this._ctx = null;
    }
}

export default LiteAudio;
