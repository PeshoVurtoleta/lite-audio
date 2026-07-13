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

export interface LiteAudioOptions {
    /**
     * User-facing bus names. Do not include 'master' - it is always the top
     * of the graph and is controlled via setMuted() / muted().
     */
    buses?: string[];

    /** Voices per bus pool. Defaults to 32. */
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
}

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
     * inside 2^53, opaque to callers. The bus tag is what makes a handle name one
     * voice engine-wide - every bus's pool counts generations from zero on its own,
     * so the raw pool handles collide across buses by construction.
     */
    play(soundId: string, volume?: number, pan?: number, pitch?: number): number;

    /**
     * Sugar layer over play(): options object with pitchVar resolution.
     * Not the hot path - a frame loop should call play() positionally.
     */
    playOpts(soundId: string, opts?: {
        volume?: number;
        pan?: number;
        pitch?: number;
        pitchVar?: number;
    }): number;

    /** Stop a specific voice by handle. Stale handles are silent no-ops. */
    stop(handle: number): void;

    /** Is this exact voice still sounding? False if stolen, stopped, or played out. */
    isPlaying(handle: number): boolean;

    /** Name of the bus that issued this handle, or null. */
    busOf(handle: number): string | null;

    /** Voices sounding on a bus, or across every bus when called with no argument. */
    activeCount(busName?: string): number;

    /** Stop every voice on a named bus. */
    stopBus(busName: string): void;

    /** Stop every voice across every bus. */
    stopAll(): void;

    // ---------- Bus + master controls --------------------------------------
    setBusVolume(busName: string, volume: number): void;
    setBusMuted(busName: string, muted: boolean): void;
    setMuted(state: boolean): void;

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
