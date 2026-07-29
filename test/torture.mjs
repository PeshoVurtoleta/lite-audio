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
 * lite-leak is not a peer here: AU-01 has no retention dimension (the handle is a
 * value, boxed doubles are transient young-gen garbage, nothing is held). The
 * failure mode is allocation rate, which lite-gc-profiler's bytesPerOp measures
 * directly. Adding a leak tracker would be ceremony, not coverage.
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

const LEAK = process.env.LITEAUDIO_TORTURE_LEAK === '1';

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

    process.stderr.write(
        'result: boxed-double handle (bus>=1, gen>8388608) is below the gate resolution; ' +
        'plain-number handle keeps its zero-retain property (decisions/0001). The v1.2.0 ' +
        'monitor tick holds zero retained allocation with all four mix features live.\n');
    process.stdout.write('ok\n');
    process.exit(0);
}

main();
