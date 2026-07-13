/**
 * Mock Web Audio harness for lite-audio tests.
 *
 * Every AudioParam records its scheduled events into an .events array so tests
 * can assert scheduling shape (setTargetAtTime, setValueAtTime, ramps). The
 * context runs a manual clock (_advance) and a real state machine covering
 * 'suspended', 'running', 'interrupted', 'closed' - the four the unlock code
 * needs to see. decodeAudioData returns a mock AudioBuffer whose duration is
 * encoded into the fake payload the mock fetcher hands out, so a defineSounds
 * flow can tell one sound from another. This is the D8 foundation the whole
 * lite-audio test suite runs against; every later session tests here.
 */

// ---------- AudioParam mock ------------------------------------------------

export function mockParam(defaultValue = 0) {
    const p = {
        value: defaultValue,
        events: [],
        cancelScheduledValues(t) { p.events.push(['cancel', t]); return p; },
        setValueAtTime(v, t) { p.events.push(['set', v, t]); return p; },
        linearRampToValueAtTime(v, t) { p.events.push(['linearRamp', v, t]); return p; },
        exponentialRampToValueAtTime(v, t) { p.events.push(['expRamp', v, t]); return p; },
        setTargetAtTime(v, t, tc) { p.events.push(['target', v, t, tc]); return p; },
    };
    return p;
}

// ---------- Node factories -------------------------------------------------

let _uid = 0;
function baseNode(kind) {
    const n = {
        kind,
        id: _uid++,
        out: [],
        disconnected: 0,
        connect(target) { n.out.push(target); return target; },
        disconnect() { n.disconnected++; n.out.length = 0; },
    };
    return n;
}

export function mockGain() {
    const n = baseNode('gain');
    n.gain = mockParam(1);
    return n;
}

export function mockPanner() {
    const n = baseNode('panner');
    n.pan = mockParam(0);
    return n;
}

export function mockBufferSource() {
    const n = baseNode('source');
    n.buffer = null;
    n.playbackRate = mockParam(1);
    n.onended = null;
    n.started = null;
    n.stopped = null;
    n.start = (when, off, dur) => { n.started = [when, off, dur]; };
    n.stop = (when) => { n.stopped = when; };
    return n;
}

export function mockAudioBuffer(numberOfChannels, length, sampleRate) {
    return {
        numberOfChannels,
        length,
        sampleRate,
        duration: length / sampleRate,
        getChannelData: () => new Float32Array(length),
    };
}

// ---------- AudioContext mock ----------------------------------------------

const VALID_STATES = new Set(['suspended', 'running', 'interrupted', 'closed']);

export function createMockContext({ sampleRate = 44100, state = 'suspended' } = {}) {
    let currentTime = 0;
    let ctxState = state;
    const listeners = new Map();  // event -> Set<listener>

    // Emit statechange to listeners
    function fireStatechange() {
        const cbs = listeners.get('statechange');
        if (!cbs) return;
        // Snapshot: a listener might addEventListener during dispatch
        for (const cb of [...cbs]) {
            try { cb({ target: ctx, type: 'statechange' }); } catch (e) {}
        }
    }

    const ctx = {
        sampleRate,
        get currentTime() { return currentTime; },
        get state() { return ctxState; },
        destination: baseNode('destination'),

        createGain: () => mockGain(),
        createStereoPanner: () => mockPanner(),
        createBufferSource: () => mockBufferSource(),
        createBuffer: (ch, len, sr) => mockAudioBuffer(ch, len, sr),

        async resume() {
            if (ctxState === 'closed') throw new Error('Cannot resume closed context');
            if (ctxState !== 'running') {
                ctxState = 'running';
                fireStatechange();
            }
        },
        async suspend() {
            if (ctxState === 'closed') throw new Error('Cannot suspend closed context');
            if (ctxState !== 'suspended') {
                ctxState = 'suspended';
                fireStatechange();
            }
        },
        async close() {
            if (ctxState !== 'closed') {
                ctxState = 'closed';
                fireStatechange();
            }
        },

        // decodeAudioData: the mock inspects the "magic" 4-byte header of the
        // ArrayBuffer to decide the buffer's length in samples, so different
        // mock URLs can decode to different-sized buffers deterministically.
        // Layout: [uint32 lengthInSamples, ...payload]. Anything without the
        // header falls back to a 500ms buffer.
        async decodeAudioData(arrayBuffer) {
            let lengthSamples = Math.floor(sampleRate * 0.5);
            if (arrayBuffer && arrayBuffer.byteLength >= 4) {
                const view = new DataView(arrayBuffer);
                const header = view.getUint32(0, true);
                if (header > 0 && header < sampleRate * 60) {
                    lengthSamples = header;
                }
            }
            return mockAudioBuffer(1, lengthSamples, sampleRate);
        },

        addEventListener(evt, cb) {
            if (!listeners.has(evt)) listeners.set(evt, new Set());
            listeners.get(evt).add(cb);
        },
        removeEventListener(evt, cb) {
            listeners.get(evt)?.delete(cb);
        },

        // ---- Test helpers (underscore-prefixed) ----

        /** Advance the audio clock by dt seconds. */
        _advance(dt) { currentTime += dt; },

        /** Force a state transition. Fires statechange. */
        _setState(newState) {
            if (!VALID_STATES.has(newState)) throw new Error('Invalid state: ' + newState);
            if (ctxState === newState) return;
            ctxState = newState;
            fireStatechange();
        },

        /** Registered statechange listener count (introspection for tests). */
        _statechangeListenerCount() {
            return listeners.get('statechange')?.size || 0;
        },
    };
    return ctx;
}

// ---------- Fetch mock -----------------------------------------------------

/**
 * Returns a fetch-shaped function that resolves ArrayBuffers keyed by URL.
 * Values can be:
 *   - number: length in samples (encoded into a 4-byte header so decodeAudioData
 *     produces a buffer of that many samples)
 *   - ArrayBuffer: used verbatim
 *   - null | undefined: fetch resolves ok=false
 *   - Error: fetch rejects
 */
export function mockFetch(map) {
    return async (url) => {
        const spec = map[url];
        if (spec instanceof Error) throw spec;
        if (spec == null) return { ok: false, status: 404, statusText: 'Not Found' };
        if (spec instanceof ArrayBuffer) {
            return { ok: true, status: 200, async arrayBuffer() { return spec; } };
        }
        // Encode a length hint into the payload
        const buf = new ArrayBuffer(4);
        new DataView(buf).setUint32(0, spec >>> 0, true);
        return { ok: true, status: 200, async arrayBuffer() { return buf; } };
    };
}

// ---------- Convenience assertions -----------------------------------------

/**
 * Find events of a given op on a param. Returns [] if none.
 * Ops: 'cancel' | 'set' | 'linearRamp' | 'expRamp' | 'target'
 */
export function paramEvents(param, op) {
    if (!param || !param.events) return [];
    if (!op) return param.events.slice();
    return param.events.filter(e => e[0] === op);
}

/** Waits for the microtask queue to drain (unlock queue flush, etc.). */
export async function flushMicrotasks(n = 4) {
    for (let i = 0; i < n; i++) await Promise.resolve();
}
