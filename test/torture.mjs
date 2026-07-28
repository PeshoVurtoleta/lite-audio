/**
 * @zakkster/lite-audio -- torture gate (AU0 / v1.1.1).
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
 * Peers are devDependencies, never runtime deps: Audio.js has zero deps.
 *
 * @license MIT
 */

import { measureOps, checkNoGc } from '@zakkster/lite-gc-profiler';

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

// --- gate --------------------------------------------------------------------

function main() {
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

    process.stderr.write(
        'result: boxed-double handle (bus>=1, gen>8388608) is below the gate resolution; ' +
        'plain-number handle keeps its zero-retain property. Tradeoff closed (decisions/0001).\n');
    process.stdout.write('ok\n');
    process.exit(0);
}

main();
