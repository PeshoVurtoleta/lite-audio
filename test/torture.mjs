/**
 * @zakkster/lite-audio -- torture gate (AU0 / v1.1.1, extended AU1 / v1.2.0).
 *
 * DONE-WHEN, one command:
 *
 *     node --expose-gc test/torture.mjs        -> prints a report + "ok", exit 0
 *
 * WHAT THIS GATES, AND WHY IT IS SHAPED THIS WAY
 *
 * AU-01: the engine handle is `busIndex * 2^32 + poolHandle`. On bus 0 it stays a
 * V8 SMI (31-bit signed) only until a channel's generation passes 8,388,608; on
 * any bus >= 1 it is >= 2^32 and never an SMI. A boxed double is a heap value, so
 * the D8 zero-GC claim ("play/stop allocate nothing") is only honest if the gate
 * exercises the boxed regime -- and the old gate tested bus 0 at low generation,
 * exactly where the handle is an SMI and nothing boxes. This gate closes that
 * blind spot: it measures the handle return on bus >= 1 AND past generation
 * 8,388,608, and reports the per-call figure, not just pass/fail.
 *
 * WHAT NODE CAN AND CANNOT MEASURE HONESTLY HERE
 *
 * The pool's node-level zero-GC property (createBufferSource reuse, scheduled
 * params) needs a real AudioContext; against the test mock every play() allocates
 * a mock node, so measuring engine.play() in Node would measure the mock, not the
 * pool. So this gate measures the property AU-01 is actually about -- the handle
 * RETURN crossing the SMI boundary -- in isolation, exactly as the roadmap did
 * ("returning a handle from a hot function"). The real-engine handle VALUES that
 * these regimes stand in for (bus >= 1 -> >= 2^32; generation 8,388,608 -> 2^31)
 * are pinned against the real engine in test/Handles.test.js.
 *
 * lite-leak IS a witness here, as of S3. AU-01 alone had no retention dimension
 * (the handle is a value; boxed doubles are transient young-gen garbage, nothing
 * is held), so the original gate measured allocation RATE with lite-gc-profiler's
 * bytesPerOp and nothing else. S3 changed that: a positional bus now holds real
 * retention surface -- per-bus posXYZ / posOwner / posDirty typed arrays plus the
 * PannerNode voices -- that destroy() must release. bytesPerOp cannot see it (a
 * backing store that is allocated once per bus and freed at teardown is not a
 * per-op figure), so T-SP3 adds an independent lite-leak witness across
 * build/teardown cycles: a leak that survives destroy() shows up as a nonzero
 * tracker even when every hot path measures 0 bytes/op.
 *
 * THE MEASURED RESULT (and why the tradeoff is closed -- see decisions/0001)
 *
 * Under JIT in a tight loop the boxed-double handle return shows ~0 steady-state
 * bytesPerOp: the boxing is below this gate's resolution, and below the
 * major-GC/pause budget. That is the empirical basis for KEEPING the plain-number
 * handle and NOT narrowing GEN_MASK. The rejected alternative -- a `{bus, handle}`
 * object per play, retained by the caller (the common case: you keep a handle to
 * stop the voice later) -- is the CONTROL below, and it costs ~tens of bytes per
 * call. The gate proves it can see that, so a pass means something.
 *
 * FALSIFY IT:
 *
 *     LITEAUDIO_TORTURE_LEAK=1 node --expose-gc test/torture.mjs
 *
 * routes the gated path through the allocating (object-handle) variant; the gate
 * then rejects and exits non-zero. That is the control -- see CHANGELOG.md.
 *
 * S3 EXTENSION -- positional bus + throttled position (T-SP1, T-SP2, T-SP3)
 *
 * setPosition(h,x,y,z) only stamps a preallocated scratch buffer + a dirty bit;
 * the positionX/Y/Z writes ride the cold ~10 Hz monitor. Three things need
 * proving, and the JS-heap gate alone cannot do the last two: (T-SP1) 500k
 * setPosition calls retain nothing on the caller frame; (T-SP2) 32 voices over
 * 10 s of flushes stay under 200 native param events PER PARAM per voice (~100
 * expected), counted on the mock param -- native automation events live outside
 * V8's heap and outside this profiler's view; and (T-SP3) the per-bus retention
 * surface a positional bus allocates (posXYZ / posOwner / posDirty + panner
 * voices) is fully released by destroy() -- witnessed by lite-leak across
 * build/teardown cycles, since a once-per-bus backing store freed at teardown is
 * invisible to a per-op bytesPerOp figure. Each ships a red control:
 *
 *     LITEAUDIO_TORTURE_SP1_RED=1  -- box {x,y,z} into a retained object per call
 *     LITEAUDIO_TORTURE_SP2_RED=1  -- write params at 60 Hz per frame, no throttle
 *     LITEAUDIO_TORTURE_SP3_RED=1  -- suppress the release-proof untrack (models a
 *                                     destroy() that stopped releasing the scratch)
 *
 * All three are proven to exit non-zero when active. A steal-safety phase also
 * proves a channel stolen after setPosition gets ZERO stale writes onto its new
 * voice.
 *
 * AU1 EXTENSION -- the monitor tick, all four mix features live
 *
 * v1.2.0 adds ducking, snapshots, meters and auto-suspend. Three of those run
 * off a shared ~10 Hz monitor tick (the duck follower, the meter sweep, the
 * auto-suspend silence check); the fourth, auto-suspend's wake, is one boolean
 * branch on play(). The monitor tick is the one NEW repeated path, and unlike
 * play() it allocates no mock node -- it only reads activeCount(), sweeps a
 * pre-allocated analyser buffer, and edge-writes -- so it can be measured
 * HONESTLY against a real engine here, not a synthetic stand-in. This gate
 * therefore builds a live LiteAudio with all four features active (a saturated
 * duck follower, a metered bus, auto-suspend armed, voices sounding) and proves
 * the steady-state tick holds zero retained allocation. That is the AU1
 * assertion "the extended gate stays green with all four features active."
 *
 * Peers are devDependencies, never runtime deps: Audio.js has zero deps.
 *
 * @license MIT
 */

import { measureOps, checkNoGc } from '@zakkster/lite-gc-profiler';
import { createLeakTracker } from '@zakkster/lite-leak';
import { LiteAudio } from '../Audio.js';
import { createMockContext, mockFetch, mockDocument, flushMicrotasks } from './mock-ctx.js';

// --- config ------------------------------------------------------------------

// Mirror of Audio.js. Not exported (it is an internal encoding); Handles.test.js
// asserts the real engine agrees with this arithmetic.
const BUS_STRIDE = 4294967296;   // 2^32

const OPS = 3_000_000;           // hot iterations per measurement
const WARMUP = 50_000;           // JIT warmup, excluded from the figure
const RULES = { maxMajor: 0, maxPauseMs: 4 };

// A handle path must not retain steady-state allocation. Its measured bytesPerOp
// is ~0 with sub-byte JIT noise; 4.0 sits ~40x above that noise and ~18x below
// the object control, so it separates the shipped design from the rejected one
// without being flaky.
const HANDLE_MAX_BYTES_PER_OP = 4.0;
// The control (retained object handle) must land clearly above the handle paths,
// or the harness is not measuring allocation and this gate is theater.
const CONTROL_MIN_BYTES_PER_OP = 8.0;

// Monitor-tick phase (AU1). Fewer ops than the handle phase because each tick
// sweeps a full 2048-wide analyser buffer (the real cost at real 10 Hz); half a
// million ticks is ~14 hours of real monitor time and plenty of signal. The
// steady-state tick retains nothing, so its ceiling matches the handle path.
const MON_OPS = 500_000;
// The combined tick is a fresh, larger call site than the handle arithmetic, so
// it needs more warmup to fully tier before measurement (under-warmed, the
// optimizer's own transient allocation reads as ~16 bytes/op that vanishes once
// steady - measured: every method is ~0 alone and the second combined pass is
// literally 0.0000). stabilize:true GC-baselines so warmup allocation is not
// counted against steady state.
const MON_WARMUP = 200_000;
const MON_MAX_BYTES_PER_OP = 4.0;

// --- S3 spatial config (T-SP1, T-SP2) ----------------------------------------

// T-SP1: setPosition(h,x,y,z) is a caller-frame method (safe every frame). It
// must stamp scratch + a dirty bit and NOTHING else -- no param write, no box.
// 500k calls; same ceiling as the handle path (a scalar write into a typed array
// retains nothing).
const SP1_OPS = 500_000;
const SP1_WARMUP = 50_000;
const SP1_MAX_BYTES_PER_OP = 4.0;
// The red control boxes {x,y,z} into a retained object per call (the rejected
// caller-buffer API). It must land clearly above the scalar path or the harness
// is not measuring allocation.
const SP1_CONTROL_MIN_BYTES_PER_OP = 8.0;

// T-SP2: the SP-03 native-event bound, counted PER PARAM on the mock, not on the
// heap. 32 voices, 10 s of monitor flushes at ~10 Hz -> ~100 events/param/voice.
// The cap is 200 (a 20 Hz ceiling); NOT summed across the 3 axes.
const SP2_VOICES = 32;
const SP2_TICKS = 100;            // 10 s at the ~10 Hz monitor cadence
const SP2_FRAMES_PER_TICK = 6;    // caller updates at ~60 Hz between flushes
const SP2_EVENT_CAP = 200;
// The red control is a 60 Hz per-frame writer that writes params DIRECTLY every
// frame instead of stamping + throttling: ~600 events/param -> blows the cap.
const SP2_RED_HZ = 60;

// T-SP3: retention witness. A positional bus allocates, at pool build, a
// posXYZ/posOwner/posDirty triple plus the panner voices; destroy() must null the
// triple (Audio.js) and disconnect the voices. Over many build/teardown cycles an
// independent lite-leak tracker witnesses each cycle's bus record and is untracked
// ONLY once destroy() has proven-nulled the scratch -- so a teardown that stops
// releasing leaves the tracker nonzero. This is retention, not rate: the backing
// stores are allocated once per bus, so bytesPerOp (a per-op figure) is blind to
// them by construction.
const SP3_CYCLES = 200;          // build/teardown a fresh positional engine N times
const SP3_VOICES = 8;            // voices played + positioned each cycle

const LEAK = process.env.LITEAUDIO_TORTURE_LEAK === '1';
const SP1_RED = process.env.LITEAUDIO_TORTURE_SP1_RED === '1';
const SP2_RED = process.env.LITEAUDIO_TORTURE_SP2_RED === '1';
// The red control suppresses the release-proof untrack, so the witness never
// settles to 0 even though teardown ran -- modelling a destroy() that stopped
// releasing the scratch. The gate must reject.
const SP3_RED = process.env.LITEAUDIO_TORTURE_SP3_RED === '1';

// --- helpers -----------------------------------------------------------------

function die(msg) {
    process.stderr.write('torture: FAIL -- ' + msg + '\n');
    process.exit(1);
}

// `sink` is read after every measurement so V8 cannot dead-code the handle math.
let sink = 0;
// Unbounded retention for the control: an object per call, kept alive -- the cost
// the plain-number handle exists to avoid. A BOUNDED buffer would let V8 recycle
// the objects and understate the cost (measured: ~3 bytes/op ringed vs ~70 held);
// the realistic model is a caller that keeps every handle for its voice's life.
let keep = null;

// The three handle regimes AU-01 is about. Each computes exactly play()'s return
// expression: busIndex * BUS_STRIDE + poolHandle.
const REGIMES = [
    {
        key: 'bus0-smi',
        note: 'bus 0, generation 1000 -> handle < 2^31 (an SMI; nothing boxes)',
        fn: () => { sink = 0 * BUS_STRIDE + ((1000 << 8) >>> 0); },
    },
    {
        key: 'bus0-pastgen',
        note: 'bus 0, generation 8,388,608 -> handle = 2^31 (boxed double)',
        fn: () => { sink = 0 * BUS_STRIDE + ((8388608 * 256) >>> 0); },
    },
    {
        key: 'busN',
        note: 'bus 3, generation 5 -> handle >= 2^32 (always a boxed double)',
        fn: () => { sink = 3 * BUS_STRIDE + ((5 << 8) >>> 0); },
    },
];

// The rejected alternative, measured: a { bus, handle } object per play, retained
// for the voice's lifetime (unbounded growth over the window -- see `keep`).
function objectHandle() {
    keep.push({ bus: 3, handle: (5 << 8) >>> 0 });
}

function measure(label, fn) {
    let i = 0;
    const r = measureOps(() => fn(i++), { ops: OPS, warmup: WARMUP, source: 'gc' });
    const bpo = r.bytesPerOp == null ? NaN : r.bytesPerOp;
    const report = checkNoGc(r.summary, RULES);
    return { label, bytesPerOp: bpo, major: r.summary.gc.major, maxMs: r.summary.gc.maxMs, noMajor: report.ok };
}

function fmt(row) {
    return '  ' + row.label.padEnd(14) +
        ' bytesPerOp=' + (Number.isFinite(row.bytesPerOp) ? row.bytesPerOp.toFixed(4) : 'null').padStart(10) +
        '  major=' + String(row.major).padStart(2) +
        '  maxMs=' + row.maxMs.toFixed(3);
}

// --- live-engine monitor phase (AU1) -----------------------------------------

/**
 * Build a real LiteAudio (mock context) with ALL FOUR mix features live and
 * return a function that runs exactly one monitor tick's work -- the duck
 * follower, the meter sweep, the auto-suspend check -- with no scheduling. The
 * measured tick is the steady state: the follower is already engaged (edge
 * done), voices are sounding (so auto-suspend stays in its not-silent path),
 * and the meter reads a constant into its pre-allocated buffer. Nothing here
 * allocates a mock node, so the figure is the engine's own per-tick cost.
 */
async function buildMonitorTick() {
    const ctx = createMockContext({ state: 'suspended' });
    const gestures = [];
    const win = {
        navigator: { userAgent: 'node-torture-gate', maxTouchPoints: 0 },
        addEventListener: (_evt, cb) => gestures.push(cb),
        removeEventListener: () => {},
    };
    const audio = new LiteAudio({
        buses: ['sfx', 'music', 'voice'],
        poolCapacity: 8,
        window: win,
        document: mockDocument(),
        fetch: mockFetch({ '/s.wav': 500 }),
        // No-op timers: the monitor auto-starts but we drive its tick by hand,
        // so nothing real is scheduled and nothing leaks past the measurement.
        setTimeout: () => 0,
        clearTimeout: () => {},
    });
    await audio.init(ctx);
    await audio.defineSounds({ laser: { src: ['/s.wav'], bus: 'sfx' } });
    for (const cb of gestures) cb({});        // unlock
    await flushMicrotasks(8);

    // All four features live.
    audio.duckOn('sfx', 'music', { threshold: 1, level: 0.3 });
    audio.createBus('meter', { meter: true });
    audio._buses.get('meter').analyser._fill = 0.25;   // a constant, nonzero RMS
    audio.enableAutoSuspend({ after: 1e9 });           // armed; voices keep it awake

    audio.play('laser');
    audio.play('laser');                               // saturate the follower's trigger
    audio._evalDuckRules();                            // consume the rising edge now

    if (audio.activeCount('sfx') < 1) die('monitor setup: no active voices to duck on');

    return () => {
        audio._evalDuckRules();
        audio._sweepMeters();
        audio._evalAutoSuspend();
    };
}

// --- S3 spatial engine builder -----------------------------------------------

/**
 * Build a live LiteAudio (mock context) with ONE positional bus and `voices`
 * sounding SFX voices, unlocked, monitor driven by hand. Returns the engine plus
 * the array of live voice handles. The clock is never advanced, so voiceNode()
 * keeps every voice alive across the flush window.
 */
async function buildSpatialEngine(voices) {
    const ctx = createMockContext({ state: 'suspended' });
    const gestures = [];
    const win = {
        navigator: { userAgent: 'node-torture-gate', maxTouchPoints: 0 },
        addEventListener: (_evt, cb) => gestures.push(cb),
        removeEventListener: () => {},
    };
    // 'world' is created ONLY via createBus below, so it is actually built
    // positional. createBus is idempotent-by-name (Audio.js): if 'world' were in
    // the constructor's `buses` it would already exist as a default STEREO bus and
    // the createBus({spatial:'positional'}) call would return that stereo record,
    // silently dropping the option -- and setPosition would then be a fail-closed
    // no-op measuring ~0 B/op for the wrong reason. Keep it out of the constructor.
    const audio = new LiteAudio({
        poolCapacity: voices,
        window: win,
        document: mockDocument(),
        fetch: mockFetch({ '/s.wav': 500 }),
        setTimeout: () => 0,
        clearTimeout: () => {},
    });
    await audio.init(ctx);
    audio.createBus('world', { spatial: 'positional' });
    await audio.defineSounds({ ping: { src: ['/s.wav'], bus: 'world' } });
    for (const cb of gestures) cb({});        // unlock
    await flushMicrotasks(8);

    const handles = [];
    for (let i = 0; i < voices; i++) {
        const h = audio.play('ping', 1, 0, 1);
        if (h < 0) die('spatial setup: play returned a skip sentinel (' + h + ')');
        handles.push(h);
    }
    // Guard: prove the bus is truly positional, so a stereo-by-accident bus (the
    // idempotent-createBus trap above) fails loud here instead of crashing later.
    const probe = audio._buses.get('world').pool.voiceNode(handles[0] >>> 0);
    if (!probe || !probe.positionX) {
        die('spatial setup: world bus is not positional (voiceNode lacks positionX)');
    }
    return { audio, ctx, handles };
}

// --- gate --------------------------------------------------------------------

async function main() {
    if (typeof globalThis.gc !== 'function') {
        die('run with --expose-gc:  node --expose-gc test/torture.mjs');
    }

    process.stderr.write('lite-audio handle gate (OPS=' + OPS + ', rules=' + JSON.stringify(RULES) + ')\n');

    // Retention buffer for the control / leaky mode: a growable array the object
    // variant pushes into, so every allocated handle survives the whole window.
    keep = [];

    // The gated path. Normally the three real handle regimes; under LEAK it is the
    // allocating object-handle variant, so the whole gate must reject.
    let gatedRows;
    if (LEAK) {
        gatedRows = [measure('LEAK:object', objectHandle)];
    } else {
        gatedRows = REGIMES.map((rg) => measure(rg.key, rg.fn));
    }

    // The control ALWAYS runs (skipped under LEAK, where the gated path already IS
    // the object variant): it proves the harness can see real allocation. It is
    // also the decisions/0001 measurement for the rejected { bus, handle } design.
    const control = LEAK ? gatedRows[0] : measure('control:object', objectHandle);

    if (!Number.isFinite(sink)) die('handle math produced a non-finite sink (' + sink + ')');

    process.stderr.write('handle regimes:\n');
    for (const row of gatedRows) process.stderr.write(fmt(row) + '\n');
    process.stderr.write('rejected alternative ({bus,handle} object per play, retained):\n');
    process.stderr.write(fmt(control) + '\n');

    // 1) The harness must actually see allocation, or nothing below means anything.
    if (!(control.bytesPerOp >= CONTROL_MIN_BYTES_PER_OP)) {
        die('control (retained object handle) measured ' + control.bytesPerOp.toFixed(4) +
            ' bytes/op, below the ' + CONTROL_MIN_BYTES_PER_OP + ' floor -- the gate cannot ' +
            'see allocation and is not falsifiable.');
    }

    // 2) LEAK mode: the gated path IS the allocating variant, so we must reject.
    if (LEAK) {
        die('LEAK mode: gated path is the object-handle variant (' +
            control.bytesPerOp.toFixed(4) + ' bytes/op) -- rejecting as designed. ' +
            'This is the falsification control; a clean run does not take this branch.');
    }

    // 3) Every real handle regime: no major GC, no long pause, and no retained
    //    steady-state allocation -- INCLUDING bus >= 1 and past generation 8.4M,
    //    the cases the old gate never reached.
    for (const row of gatedRows) {
        if (!row.noMajor) {
            die(row.label + ': ' + row.major + ' major GC / maxMs ' + row.maxMs.toFixed(3) +
                ' violates ' + JSON.stringify(RULES));
        }
        if (!(row.bytesPerOp <= HANDLE_MAX_BYTES_PER_OP)) {
            die(row.label + ': handle return measured ' + row.bytesPerOp.toFixed(4) +
                ' bytes/op, over the ' + HANDLE_MAX_BYTES_PER_OP + ' ceiling -- the handle ' +
                'path is retaining allocation it should not.');
        }
    }

    // 4) AU1: the shared monitor tick, with the duck follower engaged, a bus
    //    metered and auto-suspend armed, must hold zero retained allocation --
    //    measured against a REAL engine, since the tick allocates no mock node.
    const tickFn = await buildMonitorTick();
    const mon = (() => {
        const r = measureOps(tickFn, { ops: MON_OPS, warmup: MON_WARMUP, source: 'gc', stabilize: true });
        const report = checkNoGc(r.summary, RULES);
        return {
            label: 'monitor-tick', bytesPerOp: r.bytesPerOp == null ? NaN : r.bytesPerOp,
            major: r.summary.gc.major, maxMs: r.summary.gc.maxMs, noMajor: report.ok,
        };
    })();

    process.stderr.write('monitor tick (duck follower + meter sweep + auto-suspend check, all live):\n');
    process.stderr.write(fmt(mon) + '\n');

    if (!mon.noMajor) {
        die('monitor-tick: ' + mon.major + ' major GC / maxMs ' + mon.maxMs.toFixed(3) +
            ' violates ' + JSON.stringify(RULES));
    }
    if (!(mon.bytesPerOp <= MON_MAX_BYTES_PER_OP)) {
        die('monitor-tick measured ' + mon.bytesPerOp.toFixed(4) + ' bytes/op, over the ' +
            MON_MAX_BYTES_PER_OP + ' ceiling -- a mix feature is allocating on the monitor path.');
    }

    // 5) T-SP1 (S3): setPosition(h,x,y,z) stamps scratch + a dirty bit and does
    //    NOTHING else -- no param write, no box. 500k calls against a real engine
    //    (this path touches no mock node). The red control boxes {x,y,z} into a
    //    retained object per call (the rejected caller-buffer API).
    const sp1 = await buildSpatialEngine(1);
    const sp1h = sp1.handles[0];
    const scalarWriter = (i) => { sp1.audio.setPosition(sp1h, i, i + 1, i - 1); };
    const boxedWriter = (i) => { keep.push({ x: i, y: i + 1, z: i - 1 }); sp1.audio.setPosition(sp1h, i, i + 1, i - 1); };

    const sp1Gated = SP1_RED ? boxedWriter : scalarWriter;
    const sp1Row = (() => {
        let i = 0;
        const r = measureOps(() => sp1Gated(i++), { ops: SP1_OPS, warmup: SP1_WARMUP, source: 'gc', stabilize: true });
        const report = checkNoGc(r.summary, RULES);
        return {
            label: SP1_RED ? 'T-SP1:RED' : 'T-SP1', bytesPerOp: r.bytesPerOp == null ? NaN : r.bytesPerOp,
            major: r.summary.gc.major, maxMs: r.summary.gc.maxMs, noMajor: report.ok,
        };
    })();
    // The control always runs (unless it already IS the gated path under SP1_RED):
    // it proves the harness can see the caller-buffer allocation this design avoids.
    const sp1Control = SP1_RED ? sp1Row : (() => {
        let i = 0;
        const r = measureOps(() => boxedWriter(i++), { ops: SP1_OPS, warmup: SP1_WARMUP, source: 'gc', stabilize: true });
        return {
            label: 'T-SP1:control', bytesPerOp: r.bytesPerOp == null ? NaN : r.bytesPerOp,
            major: r.summary.gc.major, maxMs: r.summary.gc.maxMs,
        };
    })();

    process.stderr.write('T-SP1 setPosition (500k scalar stamps vs retained {x,y,z} box per call):\n');
    process.stderr.write(fmt(sp1Row) + '\n');
    process.stderr.write(fmt(sp1Control) + '\n');

    if (!(sp1Control.bytesPerOp >= SP1_CONTROL_MIN_BYTES_PER_OP)) {
        die('T-SP1 control (retained {x,y,z} box) measured ' + sp1Control.bytesPerOp.toFixed(4) +
            ' bytes/op, below the ' + SP1_CONTROL_MIN_BYTES_PER_OP + ' floor -- the gate cannot ' +
            'see allocation and is not falsifiable.');
    }
    if (SP1_RED) {
        die('SP1_RED: gated setPosition path is the retained-box variant (' +
            sp1Row.bytesPerOp.toFixed(4) + ' bytes/op) -- rejecting as designed. This is the ' +
            'red control; a clean run does not take this branch.');
    }
    if (!sp1Row.noMajor) {
        die('T-SP1: ' + sp1Row.major + ' major GC / maxMs ' + sp1Row.maxMs.toFixed(3) +
            ' violates ' + JSON.stringify(RULES));
    }
    if (!(sp1Row.bytesPerOp <= SP1_MAX_BYTES_PER_OP)) {
        die('T-SP1: setPosition measured ' + sp1Row.bytesPerOp.toFixed(4) + ' bytes/op, over the ' +
            SP1_MAX_BYTES_PER_OP + ' ceiling -- the position path is allocating on the caller frame.');
    }
    sp1.audio.destroy();

    // 6) T-SP2 (S3): the SP-03 native-event bound, counted PER PARAM on the mock,
    //    NOT on the heap. 32 voices, 10 s of monitor flushes at ~10 Hz; the caller
    //    updates position at ~60 Hz between flushes. The throttle collapses those
    //    to ~100 events/param/voice; cap is 200 (a 20 Hz ceiling), per param, not
    //    summed across axes. The red control writes params directly every frame
    //    (60 Hz) -- exactly what SP-03 forbids -- so ~600 events/param blow the cap.
    const sp2 = await buildSpatialEngine(SP2_VOICES);
    const sp2Pool = sp2.audio._buses.get('world').pool;

    if (SP2_RED) {
        const framesPerTick = (SP2_RED_HZ / 10) | 0;    // 6 frames per ~10 Hz tick
        for (let t = 0; t < SP2_TICKS; t++) {
            const now = sp2.ctx.currentTime;
            for (let f = 0; f < framesPerTick; f++) {
                for (let v = 0; v < SP2_VOICES; v++) {
                    const node = sp2Pool.voiceNode(sp2.handles[v] >>> 0);
                    if (node === null) continue;
                    node.positionX.setTargetAtTime(v, now, 0.02);
                    node.positionY.setTargetAtTime(v, now, 0.02);
                    node.positionZ.setTargetAtTime(v, now, 0.02);
                }
            }
        }
    } else {
        for (let t = 0; t < SP2_TICKS; t++) {
            for (let f = 0; f < SP2_FRAMES_PER_TICK; f++) {
                for (let v = 0; v < SP2_VOICES; v++) {
                    sp2.audio.setPosition(sp2.handles[v], v + f, v - f, f);
                }
            }
            sp2.audio._flushPositions();            // the ~10 Hz monitor flush
        }
    }

    let sp2Max = 0;
    for (let v = 0; v < SP2_VOICES; v++) {
        const node = sp2Pool.voiceNode(sp2.handles[v] >>> 0);
        if (node === null) die('T-SP2: voice ' + v + ' went stale before counting');
        let n = 0;
        const ev = node.positionX.events;
        for (let k = 0; k < ev.length; k++) if (ev[k][0] === 'target') n++;
        if (n > sp2Max) sp2Max = n;
    }
    process.stderr.write('T-SP2 ' + (SP2_RED ? '(RED: 60 Hz per-frame writer)' : '(10 Hz throttled flush)') +
        ': max positionX target events/voice = ' + sp2Max + ' (cap ' + SP2_EVENT_CAP +
        ', expected ~' + SP2_TICKS + ')\n');
    if (!(sp2Max <= SP2_EVENT_CAP)) {
        die('T-SP2: ' + sp2Max + ' positionX events/voice exceeds the ' + SP2_EVENT_CAP +
            ' cap -- a per-frame param writer is growing the native event list (SP-03).');
    }
    sp2.audio.destroy();

    // 7) Steal-safety (pins the S3 ruling): setPosition on a handle whose channel
    //    is then stolen must NOT stamp the stale position onto the NEW voice. The
    //    stale bit resolves to a null voiceNode at flush and is dropped.
    const steal = await buildSpatialEngine(4);        // capacity 4, all channels full
    const victim = steal.handles[0];                  // channel 0, generation 0
    steal.audio.setPosition(victim, 9, 9, 9);         // stamp the (soon stale) slot
    const thief = steal.audio.play('ping', 1, 0, 1);  // no free channel -> steals ch 0
    if (((thief >>> 0) & 0xFF) !== 0) {
        die('steal test: expected the steal to reuse channel 0, got channel ' + ((thief >>> 0) & 0xFF));
    }
    if (steal.audio.isPlaying(victim)) {
        die('steal test: victim handle is still live after the steal -- generation did not bump');
    }
    steal.audio._flushPositions();
    const thiefNode = steal.audio._buses.get('world').pool.voiceNode(thief >>> 0);
    if (thiefNode === null) die('steal test: the new (thief) voice is not alive after the steal');
    let thiefTargets = 0;
    const tev = thiefNode.positionX.events;
    for (let k = 0; k < tev.length; k++) if (tev[k][0] === 'target') thiefTargets++;
    process.stderr.write('steal-safety: new voice on the stolen channel got ' + thiefTargets +
        ' position writes (expected 0)\n');
    if (thiefTargets !== 0) {
        die('steal test: the stolen channel got ' + thiefTargets + ' position writes onto the ' +
            'NEW voice -- steal-safety broken (a stale dirty bit wrote the old position).');
    }
    steal.audio.destroy();

    // 8) T-SP3 (S3): retention witness (lite-leak). Build and tear down a
    //    positional engine SP3_CYCLES times. Each cycle a positional bus allocates
    //    its posXYZ/posOwner/posDirty triple + panner voices; destroy() must
    //    release them (Audio.js nulls the triple, the pool disconnects the nodes).
    //    An independent lite-leak tracker witnesses each cycle's bus record and is
    //    untracked ONLY once destroy() has proven-nulled the scratch -- so a
    //    teardown that stops releasing leaves the ledger nonzero. This is
    //    retention, not rate: the backing stores are allocated once per bus, so
    //    the bytesPerOp gate is blind to a teardown leak by construction. Strong
    //    refs pin the witnessed records so size() is a deterministic ledger, never
    //    at the mercy of GC / FinalizationRegistry timing. The red control skips
    //    destroy() entirely, so the witness must stay > 0.
    const tracker = createLeakTracker({ name: 'lite-audio-spatial-soak' });
    const NOOP = () => {};
    const sp3Kept = [];
    for (let c = 0; c < SP3_CYCLES; c++) {
        // A signal-disposal regression (destroy() not releasing its lite-signal
        // nodes) exhausts the shared node pool well before SP3_CYCLES, so a throw
        // here IS a teardown-leak signal -- surface it cleanly, not as a raw stack.
        let cyc;
        try {
            cyc = await buildSpatialEngine(SP3_VOICES);
        } catch (err) {
            die('T-SP3: build cycle ' + c + ' threw (' + (err && err.message || err) + ') -- a ' +
                'teardown that stops releasing its lite-signal nodes exhausts the shared pool. ' +
                'destroy() must dispose every signal + effect it creates.');
        }
        for (let v = 0; v < SP3_VOICES; v++) {
            cyc.audio.setPosition(cyc.handles[v], v, v + 1, v - 1);
        }
        cyc.audio._flushPositions();                 // real param writes onto the voices
        const busRec = cyc.audio._buses.get('world');
        // The witness target is a lightweight per-cycle SENTINEL, never the heavy
        // busRec: pinning busRec would transitively retain each bus's lite-signal
        // nodes and defeat the very release the tier is checking. We keep the
        // sentinels (tiny) so size() is a deterministic ledger, and gate the
        // untrack on the REAL teardown proof.
        const sentinel = { cycle: c };
        sp3Kept.push(sentinel);
        const witness = tracker.track(sentinel, NOOP, c);
        cyc.audio.destroy();
        // Untrack ONLY on proof that destroy() released the retention surface, and
        // only when NOT in the red control. If a future teardown stops nulling the
        // triple, the guard is false, the untrack is skipped, and the witness
        // survives -- exactly the leak this tier exists to catch. SP3_RED suppresses
        // the untrack unconditionally to prove that path rejects.
        if (!SP3_RED && busRec.posXYZ === null && busRec.posOwner === null && busRec.posDirty === null) {
            tracker.untrack(witness);
        }
    }
    if (sp3Kept.length !== SP3_CYCLES) die('T-SP3: internal -- pinned ' + sp3Kept.length + ' of ' + SP3_CYCLES);
    const sp3Leaked = tracker.size();
    process.stderr.write('T-SP3 ' + (SP3_RED ? '(RED: release-proof untrack suppressed)' : '(build/teardown soak)') +
        ': lite-leak witnessed ' + sp3Leaked + ' un-released bus record(s) after ' + SP3_CYCLES +
        ' build/teardown cycles (expected 0)\n');
    if (SP3_RED) {
        die('SP3_RED: the release-proof untrack was suppressed, so the witness still holds ' +
            sp3Leaked + ' cycle(s) -- modelling a destroy() that stopped releasing the scratch. ' +
            'The retention witness is nonzero, rejecting as designed. This is the red control; a ' +
            'clean run does not take this branch.');
    }
    if (sp3Leaked !== 0) {
        die('T-SP3: lite-leak witnessed ' + sp3Leaked + ' positional bus record(s) still holding ' +
            'posXYZ/posOwner/posDirty scratch after destroy() -- a teardown leak the bytesPerOp ' +
            'gate cannot see.');
    }

    process.stderr.write(
        'result: boxed-double handle (bus>=1, gen>8388608) is below the gate resolution; ' +
        'plain-number handle keeps its zero-retain property (decisions/0001). The v1.2.0 ' +
        'monitor tick holds zero retained allocation with all four mix features live. ' +
        'S3: setPosition is a zero-alloc scratch stamp (T-SP1) and the ~10 Hz flush holds ' +
        'the SP-03 native-event rate to ~100/param/voice under a 200 cap (T-SP2), with ' +
        'steal-safety proven (a stolen channel gets zero stale writes). A lite-leak witness ' +
        'proves destroy() releases the per-bus positional scratch across ' + SP3_CYCLES +
        ' build/teardown cycles (T-SP3).\n');
    process.stdout.write('ok\n');
    process.exit(0);
}

main();
