/**
 * @zakkster/lite-audio - Zero-GC reactive Web Audio engine.
 * Peers: @zakkster/lite-signal, @zakkster/lite-audio-pool.
 */

/**
 * lite-signal's callable signal shape. A signal is a getter function that
 * doubles as an object with .peek() and (for writable signals) .set().
 * lite-audio exposes read-only signals to consumers; internal writes go
 * through explicit setter methods on the engine.
 */
export interface ReadSignal<T> {
    (): T;
    peek(): T;
}
export interface WriteSignal<T> extends ReadSignal<T> {
    set(value: T): void;
}

export type LoadState = 'idle' | 'loading' | 'ready' | 'error';
export type CtxState = 'suspended' | 'running' | 'interrupted' | 'closed';

declare const __voiceHandle: unique symbol;

/**
 * An opaque, bus-tagged voice handle returned by play(). At runtime it is a
 * plain number - `busIndex * 2^32 + poolHandle`, exact well inside 2^53 - but
 * it is branded so a caller cannot fabricate one, pass a track name where a
 * handle belongs, or feed an arbitrary integer to stop(). Get one from play()
 * (or playOpts / playUnique) and hand it back to stop() / isPlaying() / busOf().
 *
 * The full return space of the playback methods is a handle OR one of two
 * negative sentinels, both inert to stop() by construction:
 *   - `SKIPPED` (-1): the call did nothing - unknown/not-ready sound, locked
 *     context (the play was queued), or a throttled playUnique().
 *   - `TRACK_STARTED` (-2): playUnique() started a music TRACK. Tracks are
 *     singletons addressed by name, so there is no handle to return, and it
 *     cannot report 0 - that is a real handle (bus 0, channel 0, generation 0).
 * Zero is therefore never a "nothing happened" value; only negatives are.
 */
export type VoiceHandle = number & { readonly [__voiceHandle]: 'VoiceHandle' };

/** play()/playOpts() returned this when nothing was played (see VoiceHandle). */
export type Skipped = -1;
/** playUnique() returned this when it started a music track (see VoiceHandle). */
export type TrackStarted = -2;

export interface SoundConfig {
    /** Source URL list, ordered by preference. First supported extension wins. */
    src: string[];
    /** Bus to route this sound to. Defaults to 'sfx'. Must exist in `opts.buses`. */
    bus?: string;
    /** Default volume for this sound (playOpts fallback). */
    volume?: number;
    /** Default pitch variation range for playOpts (e.g. 0.1 = plus/minus 10%). */
    pitchVar?: number;
}

export interface TrackConfig {
    /** Source URL list, ordered by preference. First supported extension wins. */
    src: string[];
    /** Bus to route this track to. Defaults to 'music'. Must exist in `opts.buses`. */
    bus?: string;
    /** Baseline volume for this track (0..1). Independent of the crossfade knob. */
    volume?: number;
    /** Loop this track when it ends (or when loopEnd is reached, if set). */
    loop?: boolean;
    /** Custom loop start (seconds). Requires loopEnd; the native element.loop is disabled. */
    loopStart?: number;
    /** Custom loop end (seconds). When currentTime crosses this, seeks to loopStart. */
    loopEnd?: number;
}

export interface PlayTrackOptions {
    /** Fade-in duration in ms. Default 0 (snap to full). */
    fadeIn?: number;
    /** Seek to this position (seconds) before playback. */
    position?: number;
    /** If the track is already playing, seek to 0 and continue. Default false (no-op). */
    restart?: boolean;
}

export interface StopTrackOptions {
    /** Fade-out duration in ms. Default 200. */
    fade?: number;
}

export interface PlayExclusiveOptions extends PlayTrackOptions {
    /** Fade-out duration for siblings on the same bus, ms. Default 200. */
    fade?: number;
}

export interface DuckOptions {
    /** Dip time constant (seconds). Default 0.05. */
    attack?: number;
    /** Recovery time constant (seconds), remembered for the matching stopDuck. Default 0.3. */
    release?: number;
}

export interface DuckOnOptions {
    /** Voices on the trigger bus required to engage the duck. Default 1. */
    threshold?: number;
    /** Ducked multiplier for the target bus (0..1). Default 0.3. */
    level?: number;
    /** Dip time constant (seconds). Default 0.05. */
    attack?: number;
    /** Recovery time constant (seconds). Default 0.3. */
    release?: number;
}

export interface CreateBusOptions {
    /** Tap an AnalyserNode for level() readouts. Default false (no analyser allocated). */
    meter?: boolean;
    /**
     * Per-voice pan mode, decided at bus construction and captured into the
     * pool. Default 'stereo' (a StereoPanner per voice, equalpower, byte-identical
     * to prior releases). 'positional' builds a PannerNode per voice and enables
     * setPosition(). An unknown value fails closed (RangeError).
     */
    spatial?: 'stereo' | 'positional';
}

export interface AutoSuspendOptions {
    /** Silent seconds before the context is suspended. Default 30. */
    after?: number;
}

export interface LiteAudioOptions {
    /**
     * User-facing bus names. Do not include 'master' - it is always the top
     * of the graph and is controlled via setMuted() / muted().
     * Defaults to ['sfx', 'ui', 'voice', 'music'].
     */
    buses?: string[];

    /** Voices per bus pool (SFX). Defaults to 32. */
    poolCapacity?: number;

    /**
     * Maximum number of distinct sounds that can be queued for play before
     * unlock. Same-sound repeats collapse to latest-per-sound; new distinct
     * sounds past the limit are silently dropped.
     */
    queueLimit?: number;

    /** localStorage key for master mute. Defaults to 'lite_audio_muted' (manager parity). */
    mutedStorageKey?: string;

    /** Injectable for tests. Defaults to globalThis.fetch. */
    fetch?: typeof fetch;

    /** Injectable for tests. Defaults to globalThis.window. */
    window?: any;

    /** Injectable for tests. Defaults to globalThis.document. */
    document?: any;

    /** Injectable for tests. Defaults to globalThis.setTimeout / clearTimeout. */
    setTimeout?: (cb: () => void, ms: number) => any;
    clearTimeout?: (id: any) => void;
}

/** Package version, in lockstep with package.json. */
export const VERSION: string;

export class LiteAudio {
    constructor(opts?: LiteAudioOptions);

    /** Wire to an AudioContext. Creates one if none passed. Idempotent per-instance. */
    init(ctx?: AudioContext): Promise<void>;

    /**
     * Fetch, decode, and register sounds. Resolves after every sound has
     * settled (loaded or errored). Pools are built once per touched bus at
     * the end. Safe to call multiple times to add more sounds.
     */
    defineSounds(config: Record<string, SoundConfig>): Promise<void>;

    /**
     * Positional hot path: no options object. Returns a bus-tagged voice handle,
     * or -1 on any skip (unknown sound, not-yet-loaded, or context locked).
     * Locked-context plays are queued and flushed on the first user gesture (D3).
     *
     * The handle is `busIndex * 2^32 + poolHandle`: a plain number, exact well
     * inside 2^53, opaque to callers. Every bus's pool counts channels and
     * generations from zero on its own, so the raw pool handles collide across
     * buses by construction - the bus tag is what makes a handle name one voice.
     */
    play(soundId: string, volume?: number, pan?: number, pitch?: number): VoiceHandle | Skipped;

    /**
     * Sugar layer over play(): options object with pitchVar resolution.
     * Not the hot path - a frame loop should call play() positionally.
     */
    playOpts(soundId: string, opts?: {
        volume?: number;
        pan?: number;
        pitch?: number;
        pitchVar?: number;
    }): VoiceHandle | Skipped;

    /**
     * Stop a specific voice by handle. Stale handles are silent no-ops, and the
     * negative sentinels (Skipped / TrackStarted) are inert by construction, so
     * a play() or playUnique() result can be passed straight through unchecked.
     */
    stop(handle: VoiceHandle | Skipped | TrackStarted): void;

    /** Is this exact voice still sounding? False if stolen, stopped, or played out. */
    isPlaying(handle: VoiceHandle | Skipped | TrackStarted): boolean;

    /**
     * Set a positional voice's 3D position (a bus built with { spatial: 'positional' }).
     * Takes the SAME handle play() returned. Caller-frame safe -- call it every frame:
     * it does NO param write, it only stamps a preallocated scratch buffer and a dirty
     * bit (zero allocation). The positionX/Y/Z writes ride the shared ~10 Hz monitor,
     * throttled with a 0.02 s time constant, so per-frame calls collapse to ~10 native
     * param events/second per axis. Fail-closed: a stereo-bus handle, an out-of-range
     * channel, or a stolen/dead/bogus voice (incl. the negative sentinels) is a silent
     * no-op; steal-safety is resolved at flush via a generation-checked voice lookup.
     */
    setPosition(handle: VoiceHandle | Skipped | TrackStarted, x: number, y: number, z: number): void;

    /** Name of the bus that issued this handle, or null (incl. for any sentinel). */
    busOf(handle: VoiceHandle | Skipped | TrackStarted): string | null;

    /**
     * SFX voices sounding on a bus, or across every bus with no argument.
     * Tracks are not voices and are not counted - ask trackPlaying(name).
     */
    activeCount(busName?: string): number;

    /** Stop every voice on a named bus, and fade out any track routed there. */
    stopBus(busName: string, opts?: { fade?: number }): void;

    /** Stop every voice on every bus, and fade out every playing track. */
    stopAll(opts?: { fade?: number }): void;

    // ---------- Music layer (v1.1.0) ---------------------------------------

    /**
     * Register music tracks. Streaming via MediaElementAudioSourceNode.
     * Same async loader shape as defineSounds; per-track loadState signal
     * transitions idle -> loading -> ready | error.
     */
    defineTracks(config: Record<string, TrackConfig>): Promise<void>;

    /**
     * Start (or resume) a track. Idempotent per name unless `restart: true`.
     * Silent no-op if the context is locked or the track is not ready.
     */
    playTrack(name: string, opts?: PlayTrackOptions): void;

    /**
     * Fade a track out. The playing signal flips false immediately; the
     * <audio> element is paused after the fade completes.
     */
    stopTrack(name: string, opts?: StopTrackOptions): void;

    /** Pause without losing position. */
    pauseTrack(name: string): void;

    /** Resume from paused state. Position (element.currentTime) preserved. */
    resumeTrack(name: string): void;

    /**
     * Equal-power crossfade between two tracks. Either side may be null.
     * Case (c) interruption semantics: only tracks named in this call are
     * touched. A track fading out from a previous crossfade keeps its
     * schedule; a track being retargeted reads its current xfadeGain value
     * and scales the equal-power curve from there.
     */
    crossfade(fromName: string | null, toName: string | null, durationMs?: number): void;

    /** Start `name` and fade every other playing track on its bus. */
    playExclusive(name: string, opts?: PlayExclusiveOptions): void;

    /**
     * Play `name` (sound OR track) only if the last play attempt for the
     * same name was more than `thresholdMs` ago. Ported from the manager.
     *
     * Returns a voice handle for a sound, `TrackStarted` (-2) for a track (music is
     * a singleton, addressed by name), and `Skipped` (-1) on threshold rejection or
     * unknown name. It never returns 0 for a track: 0 is a real handle (bus 0,
     * channel 0, generation 0), and passing it to stop() would kill an unrelated
     * SFX voice.
     */
    playUnique(name: string, thresholdMs?: number): VoiceHandle | Skipped | TrackStarted;

    /** Per-track signals. Undefined for unknown track name. */
    trackLoadState(name: string): ReadSignal<LoadState> | undefined;
    trackPlaying(name: string):   ReadSignal<boolean> | undefined;
    trackPosition(name: string):  ReadSignal<number> | undefined;
    trackDuration(name: string):  ReadSignal<number> | undefined;

    // ---------- Bus + master controls --------------------------------------
    setBusVolume(busName: string, volume: number): void;
    setBusMuted(busName: string, muted: boolean): void;
    setMuted(state: boolean): void;

    // ---------- Mix intelligence (v1.2.0) ----------------------------------

    /**
     * Dip a bus to `level` (a 0..1 multiplier applied under its volume/mute) over
     * an attack time constant. The manual, always-wins duck: it latches the bus
     * out of any duckOn follower until stopDuck() releases it. See decisions/0003.
     */
    duck(busName: string, level?: number, opts?: DuckOptions): void;

    /** Release a manual duck to rest over the release TC, clearing the manual latch. */
    stopDuck(busName: string, opts?: { release?: number }): void;

    /**
     * Automatic follower: while `triggerBus` has >= threshold voices sounding, dip
     * `targetBus`. Evaluated off the hot path (~10 Hz), edge-only. An explicit
     * duck()/stopDuck() on the target always wins.
     */
    duckOn(triggerBus: string, targetBus: string, opts?: DuckOnOptions): void;

    /** Capture the current mix (every bus's volume + mute) under `name`. Track
     *  volumes are not captured. See decisions/0004. */
    captureSnapshot(name: string): void;

    /**
     * Morph the mix to a captured snapshot over `ms`. Signals become truthful
     * immediately; the audible transition rides the sidechain and is continuous
     * from the actual current level, so a mid-morph apply is click-free. `ms` of 0
     * snaps via the signals. Inert for an unknown name.
     */
    applySnapshot(name: string, ms?: number): void;

    /**
     * Create a bus after init(). Idempotent; rejects the reserved name 'master';
     * fails closed (RangeError) at the 2^21 handle ceiling. `{ meter: true }` taps
     * an AnalyserNode for level(). `{ spatial: 'positional' }` builds a PannerNode
     * per voice and enables setPosition() (default 'stereo'). A bus gets its pool
     * when a sound is first routed to it via defineSounds(). See decisions/0006.
     */
    createBus(name: string, opts?: CreateBusOptions): unknown;

    /** A metered bus's level signal (RMS, ~10 Hz), or null on an unmetered/unknown bus. */
    level(busName: string): ReadSignal<number> | null;

    /**
     * Arm auto-suspend: after `after` silent seconds the context is suspended; a
     * later play() resumes it. Off by default, and refused on iOS (returns false).
     * See decisions/0005.
     */
    enableAutoSuspend(opts?: AutoSuspendOptions): boolean;

    /** Disarm auto-suspend. Does not resume a context already suspended. */
    disableAutoSuspend(): void;

    /** True while the context is suspended by our auto-suspend (not the app/OS). */
    isAutoSuspended(): boolean;

    // ---------- Reactive readables -----------------------------------------
    /** Current AudioContext state signal. */
    ctxState(): ReadSignal<CtxState>;
    /** Whether the context has been unlocked by a user gesture. */
    unlocked(): ReadSignal<boolean>;
    /** Master mute signal (persisted to localStorage). */
    muted(): ReadSignal<boolean>;
    /** Per-sound load state signal. Undefined if the sound is not registered. */
    loadState(soundId: string): ReadSignal<LoadState> | undefined;
    /** Per-bus volume signal. Undefined for unknown bus name. */
    busVolume(busName: string): ReadSignal<number> | undefined;
    /** Per-bus mute signal. Undefined for unknown bus name. */
    busMuted(busName: string): ReadSignal<boolean> | undefined;
    /** Direct access to a bus's GainNode for advanced effect insertion. */
    busNode(busName: string): GainNode | undefined;
    /** Direct access to the master GainNode. */
    masterNode(): GainNode | null;

    /**
     * Stop every voice, tear down pools and buses, dispose signal effects,
     * detach DOM listeners, release references. Idempotent. Does not close
     * the AudioContext - the app owns that.
     */
    destroy(): void;
}

export default LiteAudio;
