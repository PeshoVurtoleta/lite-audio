/**
 * @zakkster/lite-audio/compat - lite-audio-manager drop-in adapter.
 *
 * Presents the lite-audio-manager surface over lite-audio's engine, so a game
 * migrates by changing one import. See PARITY.md for the method-by-method map
 * and decisions/0007-compat-shim.md for the divergences.
 */

import { LiteAudio } from './Audio.js';

/** A sound entry in the init() config. Manager-shaped. */
export interface SoundConfig {
    /** Audio file source(s), in preference order. */
    src: string[];
    /** Category for group stopping; becomes a lite-audio bus. */
    category?: string;
    /** Default random pitch variation range (e.g. 0.1 = +/-10%). SFX only. */
    pitchVar?: number;
    /** Loop by default. A looping sound is classified as a streamed track. */
    loop?: boolean;
    /** Default volume (0..1). */
    volume?: number;
    /** Stream via an <audio> element. Classified as a streamed track. */
    html5?: boolean;
    /** Additional fields are accepted and ignored (Howl-only options). */
    [key: string]: unknown;
}

/** Per-play options. Manager-shaped. */
export interface PlayOptions {
    /** Volume (0..1). Default: 1. Honored for both SFX and tracks: for a track,
     *  it sets the track baseline for this and subsequent plays until changed
     *  (forwarded only when explicitly passed, so it never clobbers a config-set
     *  level). */
    volume?: number;
    /** Loop the sound. Honored for track sounds; inert for pooled SFX. */
    loop?: boolean;
    /** Random pitch variation range. Default: 0 */
    pitchVar?: number;
    /** Explicit rate override; wins over pitchVar. Default: null */
    pitch?: number | null;
    /** Resume a track from its paused position instead of restarting; default
     *  false = restart, matching the manager. Inert for pooled SFX. */
    resume?: boolean;
}

/** Stop options. Manager-shaped. */
export interface StopOptions {
    /** Fade-out in ms. Honored for tracks; inert for pooled SFX. Default: 120 */
    fade?: number;
}

/** Options accepted by the shim's constructor (superset of the manager's none). */
export interface CompatOptions {
    /** Bus names to pre-create. Default: none - buses come from categories. */
    buses?: string[];
    /** Voices per bus pool. Default: 32. */
    poolCapacity?: number;
    /** Bound on the pre-unlock play queue. Default: 32. */
    queueLimit?: number;
    /** localStorage key for mute persistence. Default: 'lite_audio_muted'. */
    mutedStorageKey?: string;
    /** AudioContext for init(); default: engine creates one. Test injectable. */
    context?: unknown;
    /** performance.now-shaped clock for the playUnique throttle. */
    now?: () => number;
    /** DOM/fetch/timer injectables, forwarded to LiteAudio. */
    window?: unknown;
    document?: unknown;
    fetch?: unknown;
    setTimeout?: unknown;
    clearTimeout?: unknown;
}

/** The 'mutechange' event: a CustomEvent carrying the new mute state. */
export interface MuteChangeEvent extends CustomEvent {
    detail: { isMuted: boolean };
}

export class AudioManager extends EventTarget {
    /** Whether the context has been unlocked by a user gesture. */
    readonly isUnlocked: boolean;
    /** Current global mute state. */
    readonly isMuted: boolean;
    /** The underlying engine, for code moving past the manager surface. */
    readonly engine: LiteAudio;

    constructor(opts?: CompatOptions);

    /** Initialize with a sound configuration map. Synchronous facade; the
     *  decode work runs async - await whenReady() to assert on a loaded sound. */
    init(config?: Record<string, SoundConfig>): void;

    /** Resolves when the latest init()'s async setup has settled. */
    whenReady(): Promise<void>;

    /** Play a sound by name. Returns a handle-shaped number, or null if skipped. */
    play(name: string, options?: PlayOptions): number | null;

    /** Play a sound after stopping the 'outcome' category. */
    playExclusive(name: string, options?: PlayOptions): number | null;

    /** Play only if the sound has not played within `threshold` ms. */
    playUnique(name: string, threshold?: number): number | null;

    /** Stop a sound by name. */
    stop(name: string, options?: StopOptions): void;

    /** Stop every sound in a category. */
    stopCategory(categoryName: string, options?: StopOptions): void;

    /** Stop every sound across multiple categories. */
    stopCategories(categories: string[], options?: StopOptions): void;

    /** Set global mute; persists to localStorage and emits 'mutechange'. */
    setMuted(state?: boolean): void;

    /** Stop everything, dispose, and release resources. Idempotent. */
    destroy(): void;

    addEventListener(
        type: 'mutechange',
        listener: (event: MuteChangeEvent) => void,
        options?: boolean | AddEventListenerOptions
    ): void;
    addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
    ): void;
}

/** Default singleton, for the plug-and-play `import { audioManager }` swap. */
export const audioManager: AudioManager;

export default AudioManager;
