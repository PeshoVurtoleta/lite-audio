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
        // Every scheduling call records its shape AND settles `.value` on the value
        // the automation is heading for. Recording alone is not enough: it lets a
        // test prove a fade was scheduled while saying nothing about where the gain
        // ended up, and "scheduled a fade-out" plus "still audible" is exactly the
        // shape of the resumeTrack bug. Tests that care about the ramp itself read
        // .events; tests that care about the outcome read .value.
        setValueAtTime(v, t) { p.events.push(['set', v, t]); p.value = v; return p; },
        linearRampToValueAtTime(v, t) { p.events.push(['linearRamp', v, t]); p.value = v; return p; },
        exponentialRampToValueAtTime(v, t) { p.events.push(['expRamp', v, t]); p.value = v; return p; },
        setTargetAtTime(v, t, tc) { p.events.push(['target', v, t, tc]); p.value = v; return p; },
        setValueCurveAtTime(curve, t, dur) {
            p.events.push(['curve', curve, t, dur]);
            p.value = curve[curve.length - 1];
            return p;
        },
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

/**
 * DelayNode stand-in for the S5 stereo widener. The widener builds two DelayNodes
 * (a Haas pair) per armed bus and writes delayTime at construction, so delayTime is
 * an AudioParam mock whose .events array the torture tiers count exactly like every
 * other param. connect/disconnect ride the same baseNode tracker as the rest of the
 * graph, so a build/teardown soak proves the delays are disconnected on destroy.
 */
export function mockDelay(maxDelayTime = 1) {
    const n = baseNode('delay');
    n.delayTime = mockParam(0);
    n.maxDelayTime = maxDelayTime;
    return n;
}

/**
 * PannerNode stand-in for positional mode (S3). The pool builds one per voice in
 * 'positional' mode and writes panningModel/distanceModel/refDistance/maxDistance/
 * rolloffFactor at construction, so those are plain writable properties here. The
 * position is three AudioParams -- positionX/Y/Z -- each a mockParam whose .events
 * array records every setTargetAtTime, so the torture harness can count param
 * events PER AXIS (the SP-03 native-automation bound is invisible to the heap gate,
 * so it is proven against this counter instead). The pool fails closed if
 * positionX is undefined, so these must be present as real params.
 */
export function mockPanner3D() {
    const n = baseNode('panner3d');
    n.panningModel = 'equalpower';
    n.distanceModel = 'inverse';
    n.refDistance = 1;
    n.maxDistance = 10000;
    n.rolloffFactor = 1;
    n.positionX = mockParam(0);
    n.positionY = mockParam(0);
    n.positionZ = mockParam(0);
    return n;
}

/**
 * AnalyserNode stand-in for the meter path. getFloatTimeDomainData fills the
 * caller's array with a constant `_fill` (default 0 = silence), so a test can
 * drive a known RMS: the RMS of a constant c is |c|, so `_fill = 0.5` yields a
 * level() of 0.5. `_fill` is settable per node; the same array is written in
 * place every call, which is how the zero-alloc-per-read claim is testable.
 */
export function mockAnalyser(fftSize = 2048) {
    const n = baseNode('analyser');
    n.fftSize = fftSize;
    n.frequencyBinCount = fftSize >> 1;
    n._fill = 0;
    n.getFloatTimeDomainData = (arr) => {
        for (let i = 0; i < arr.length; i++) arr[i] = n._fill;
        return arr;
    };
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

/**
 * MediaElementAudioSourceNode stand-in. Holds the element it was created from so a
 * test can assert the graph was wired to the right track.
 */
export function mockMediaElementSource(element) {
    const n = baseNode('mediaElementSource');
    n.mediaElement = element;
    return n;
}

/**
 * <audio> element stand-in. Records play/pause/load calls and its listeners so a
 * test can fire 'timeupdate' / 'ended' / 'loadedmetadata' by hand, and can prove
 * teardown actually released the stream rather than merely pausing it.
 */
export function mockAudioElement(src = '') {
    const listeners = new Map();
    const el = {
        src,
        preload: '',
        crossOrigin: '',
        loop: false,
        paused: true,
        currentTime: 0,
        duration: 128,
        playCalls: 0,
        pauseCalls: 0,
        loadCalls: 0,
        srcReleased: false,

        addEventListener(type, cb) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(cb);
        },
        removeEventListener(type, cb) { listeners.get(type)?.delete(cb); },
        play() { el.paused = false; el.playCalls++; return Promise.resolve(); },
        pause() { el.paused = true; el.pauseCalls++; },
        removeAttribute(name) { if (name === 'src') { el.src = ''; el.srcReleased = true; } },
        load() { el.loadCalls++; },

        _fire(type) { for (const cb of [...(listeners.get(type) || [])]) cb({ target: el }); },
        _listenerCount(type) { return listeners.get(type)?.size || 0; },
    };
    return el;
}

/**
 * Document stand-in for the track loader. Every created <audio> lands in
 * `.created` in order, so a test can assert one element per track.
 */
export function mockDocument() {
    const doc = {
        hidden: false,
        created: [],
        createElement(tag) {
            if (tag !== 'audio') throw new Error('mockDocument: unexpected <' + tag + '>');
            const el = mockAudioElement();
            doc.created.push(el);
            return el;
        },
        addEventListener() {},
        removeEventListener() {},
    };
    return doc;
}

/**
 * Manual timer scheduler for opts.setTimeout / opts.clearTimeout. stopTrack defers
 * the <audio> pause until after the fade; with a real timer that is a race, and with
 * this it is an assertion.
 */
export function mockScheduler() {
    const timers = new Map();
    let next = 1;
    return {
        setTimeout(cb) { const id = next++; timers.set(id, cb); return id; },
        clearTimeout(id) { timers.delete(id); },
        pending() { return timers.size; },
        flush() { for (const [id, cb] of [...timers]) { timers.delete(id); cb(); } },
    };
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
    // Every BufferSource this context hands out, in creation order. A source is
    // "live" once start() stamped it and stop() has not: the census hook below
    // counts those, which is how the HRTF prewarm tier proves the silent voice was
    // actually retired (no leaked live node) rather than merely un-referenced.
    const sources = [];

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
        createDelay: (maxDelayTime) => mockDelay(maxDelayTime),
        createPanner: () => mockPanner3D(),
        createBufferSource: () => { const n = mockBufferSource(); sources.push(n); return n; },
        createBuffer: (ch, len, sr) => mockAudioBuffer(ch, len, sr),
        createMediaElementSource: (el) => mockMediaElementSource(el),
        createAnalyser: () => mockAnalyser(),

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

        /**
         * Count of BufferSource nodes that were start()ed but not yet stop()ped --
         * the live source-node census. Zero-alloc scan over the creation log.
         */
        _liveNodes() {
            let n = 0;
            for (let i = 0; i < sources.length; i++) {
                const s = sources[i];
                if (s.started !== null && s.stopped === null) n++;
            }
            return n;
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
