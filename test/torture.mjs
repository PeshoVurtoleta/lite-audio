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
 * PS2 EXTENSION -- the monitor sleeps at zero consumers, wakes on the next one
 *
 * v2.7.0 adds _monitorIdle(), a cold predicate read at the tick tail that skips
 * the reschedule when NO consumer (metered/discrete/duck/auto-suspend/positional/
 * width/HRIR-prewarm) is live, so a long-lived app that churns dynamic buses down
 * to zero stops paying for a ~10 Hz timer that does nothing. T-SP8 builds an idle
 * engine on a REAL mockScheduler (a no-op timer would make the scheduling subject
 * vacuous) and proves: (a) the tick keeps firing with a live consumer of every
 * removable type; (b) it sleeps -- stops rescheduling -- the instant the last one
 * is destroyed, and stays frozen across further flushes; (c) the next registration
 * wakes it; (d) a 4096-cycle create-consumer/tick/destroy/tick-to-sleep/wake soak
 * releases every witness and ends with zero pending timers; (e) a LIVE auto-suspend
 * countdown is never allowed to sleep out from under itself -- the monitor stays
 * armed on every tick until the countdown matures, sleeps the instant it
 * self-suspends (ruling 3b), and play() (T4) wakes it back up; (f) the predicate
 * itself holds zero retained allocation over 500k calls on a 4-bus engine.
 *
 *     LITEAUDIO_TORTURE_SP8_RED=1  -- a predicate that OMITS the auto-suspend
 *                                     clause, so the monitor sleeps mid-countdown
 *                                     and the context is never suspended
 *
 * PS4 EXTENSION -- removeDuckRule lets a duckOn-only engine idle-sleep
 *
 * v2.9.0 adds removeDuckRule(triggerBus, targetBus), the missing removal
 * counterpart to duckOn (decisions/0013). Until PS4, _duckRules was the ONE
 * permanent monitor consumer -- C3 of _monitorIdle() -- so a duckOn-only engine
 * could never sleep. T-SP8 phase (g) extends the same PS2 mock-scheduler rig
 * with: duckOn as the sole consumer arms the monitor; removeDuckRule empties
 * _duckRules and the very next flush sleeps it (monitorTimer===null, pending
 * 0), frozen across further flushes -- the PS4 win. A retention loop of
 * duckOn/removeDuckRule cycles, each with an active dip (so the stranded-target
 * recovery write runs every cycle too), ends with _duckRules empty, a
 * lite-leak witness of 0, and a flat live-node census delta.
 *
 * Peers are devDependencies, never runtime deps: Audio.js has zero deps.
 *
 * @license MIT
 */

import { measureOps, checkNoGc } from '@zakkster/lite-gc-profiler';
import { createLeakTracker } from '@zakkster/lite-leak';
import { LiteAudio } from '../Audio.js';
import {
    createMockContext, mockFetch, mockDocument, mockScheduler, flushMicrotasks, mockAudioElement,
} from './mock-ctx.js';

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

// T-SP5 (S4): the HRTF spatial bus + HRIR prewarm. (a) every voice panner across
// capacity reports panningModel==='HRTF'; (b) the gain=0 prewarm voice retires on
// the monitor tick -> activeCount()===0 AND the live source-node census returns to
// its pre-prewarm baseline (no leaked live node); (c) a build/teardown soak leaves
// the lite-leak witness at 0 (destroy() nulls hrtfWarmHandle + the positional
// scratch). The census uses a state:'running' context so unlock fires the prewarm
// at pool build WITHOUT the silent iOS unlock pulse (a mock source that never
// stops), keeping the delta an honest measure of the prewarm voice alone.
const SP5_VOICES = 8;             // pool capacity; every channel's panner is checked
const SP5_CYCLES = 200;          // build/teardown a fresh hrtf engine N times

// setPosition() never branches on 'positional' vs 'hrtf' -- both set
// busRec.positional=true and share the exact same posXYZ/posOwner/posDirty
// scratch-stamp code T-SP1 measures on a positional bus. That single code path
// is what makes "same handle semantics" true, but a shared code path is not
// itself proof: this measures setPosition's allocation INDEPENDENTLY against a
// REAL hrtf-bus voice, so the S4 claim carries its own figure instead of being
// inferred from T-SP1. The ceiling is tighter than T-SP1's (0.05 vs 4.0): this
// is the identical zero-alloc scalar stamp, so a looser bound here would hide
// a regression T-SP1 alone would not catch on this bus family.
const SP5_POS_OPS = 500_000;
const SP5_POS_WARMUP = 50_000;
const SP5_POS_MAX_BYTES_PER_OP = 0.05;

// --- S5 stereo-width config (T-SP6) ------------------------------------------

// T-SP6 (d): the SP-03 native-event bound applied to the widener's wet/makeup
// params, counted PER PARAM on the mock. 100 monitor flushes at ~10 Hz, the caller
// updating width at ~60 Hz between flushes (6 setWidth/tick). The throttle collapses
// those to at most one event/param/tick when the value moves; alternating the value
// per tick yields ~100 events. Cap is 200 (a 20 Hz ceiling), per param. The red
// control writes the params directly every frame (60 Hz) -> ~600 events -> blows it.
const SP6_TICKS = 100;
const SP6_FRAMES_PER_TICK = 6;
const SP6_EVENT_CAP = 200;
const SP6_RED_HZ = 60;

// T-SP6 (e): setWidth is a caller-frame method -- a clamp + two field writes + a
// dirty bit, no param write, no box. 500k calls against a real engine (this path
// touches no mock node). The red control boxes {w} into a retained object per call.
const SP6_OPS = 500_000;
const SP6_WARMUP = 50_000;
const SP6_MAX_BYTES_PER_OP = 4.0;
const SP6_CONTROL_MIN_BYTES_PER_OP = 8.0;

// T-SP6 (f): retention witness. An armed widener allocates 7 extra nodes per bus;
// destroy() must disconnect + null all 7. A lite-leak witness across build/teardown
// cycles proves the release, the same way T-SP3 does for the positional scratch.
const SP6_CYCLES = 200;

// --- S6 discrete-surround config (T-SP4, T-SP3-lane) -------------------------

// T-SP4 (a): the fail-closed detection matrix (D1). destination.maxChannelCount -> the
// engine's DETECTED layout, the richest single layout the sink can carry: a concrete
// integer >= 8 earns '7.1', 6 or 7 earns '5.1', 4 or 5 earns '3.1'; every other shape
// (absent property, absent destination, undefined/null/NaN, a non-integer, a string, or
// an integer < 4) fails closed to 'stereo'. Each row is [name, spec, expect]; spec is
// { absent } (destination present but no maxChannelCount key), { destAbsent } (no
// destination at all), or { value } (maxChannelCount pinned to that exact value, key
// present even when the value is undefined -- distinct from absent).
const SP4_MATRIX = [
    ['absent', { absent: true }, 'stereo'],
    ['undefined', { value: undefined }, 'stereo'],
    ['null', { value: null }, 'stereo'],
    ['NaN', { value: NaN }, 'stereo'],
    ['2', { value: 2 }, 'stereo'],
    ['4', { value: 4 }, '3.1'],
    ['5', { value: 5 }, '3.1'],
    ['6', { value: 6 }, '5.1'],
    ['7', { value: 7 }, '5.1'],
    ['7.5', { value: 7.5 }, 'stereo'],
    ["'8'", { value: '8' }, 'stereo'],
    ['8', { value: 8 }, '7.1'],
    ['12', { value: 12 }, '7.1'],
    ['dest-absent', { destAbsent: true }, 'stereo'],
];

// T-SP4 (b): the fallback ladder (D2), the 12 pinned cells of the requested x M matrix.
// A discrete bus requesting preset R on a sink of M channels builds the LARGEST preset
// that fits min(request-need, M), stepping DOWN 7.1 -> 5.1 -> 3.1 -> stereo; it never
// UPGRADES (a '5.1' request on an 8ch sink stays '5.1'). Each row is
// [name, request, maxChannelCount, expectedEffectiveLayout]. M is sampled once per band
// (8 for >=8, 6 for 6|7, 4 for 4|5, 2 for <4). The stereo cells must build a bus that
// ACTUALLY PLAYS (a non-negative handle, activeCount >= 1). 3 cells fall to stereo.
const SP4_LADDER = [
    ['7.1@8', '7.1', 8, '7.1'],
    ['7.1@6', '7.1', 6, '5.1'],
    ['7.1@4', '7.1', 4, '3.1'],
    ['7.1@2', '7.1', 2, 'stereo'],
    ['5.1@8', '5.1', 8, '5.1'],
    ['5.1@6', '5.1', 6, '5.1'],
    ['5.1@4', '5.1', 4, '3.1'],
    ['5.1@2', '5.1', 2, 'stereo'],
    ['3.1@8', '3.1', 8, '3.1'],
    ['3.1@6', '3.1', 6, '3.1'],
    ['3.1@4', '3.1', 4, '3.1'],
    ['3.1@2', '3.1', 2, 'stereo'],
];

// T-SP4 (c): setPosition on a discrete bus reuses the identical zero-alloc scalar
// stamp the positional/hrtf families use -- proven by measuring it against the tight
// SP5_POS ceiling (0.05), not T-SP1's looser 4.0, so a discrete-only second code path
// would fail here even though T-SP1 (a positional bus) would not catch it.
const SP4_POS_OPS = 500_000;
const SP4_POS_WARMUP = 50_000;

// T-SP3-lane (b): _flushLanes over 8 discrete voices, 500k measured ops. Same ceiling
// as the position flush. The recording mock param pushes an event object on every
// write; that mock bookkeeping (absent in production -- native AudioParam writes are
// heap-free) would swamp the figure, so this tier swaps the lane params for
// non-recording stubs ONCE, outside the loop, and the measured allocation is then the
// ENGINE's own per-flush cost (the reused LANE_SCRATCH -> ~0).
const SP3_LANE_VOICES = 8;
const SP3_LANE_OPS = 500_000;
const SP3_LANE_WARMUP = 50_000;
const SP3_LANE_MAX_BYTES_PER_OP = 4.0;
// The red control swaps _vbapSolve for a variant allocating a fresh Float32Array per
// solve; it must land clearly above the reused-scratch ceiling or the tier is not
// measuring allocation and is not falsifiable.
const SP3_LANE_RED_MIN_BYTES_PER_OP = 8.0;

// S7 subset presets (T-SP3-lane, all three widths). The 6-lane (5.1) and 4-lane (3.1)
// reductions ride the SAME zero-alloc _vbapSolve + data-driven _flushLanes as 8-lane, so
// each ships its own write-count, GC-budget and native-event-rate tier. [preset, lanes,
// maxChannelCount] -- the mock sink is pinned to exactly the preset's channel count so
// the ladder resolves the requested preset (no fallback).
const SP3_LANE_PRESETS = [
    ['7.1', 8, 8],
    ['5.1', 6, 6],
    ['3.1', 4, 4],
];
// Retention sub-tier (S7): build/teardown each of the three presets this many cycles.
// destroy() must null the per-bus scratch (posXYZ/posOwner/posDirty) AND the frozen vbap
// record, restore the pristine destination triple VERBATIM, and leave no live source-node
// (census delta 0). A running context is used so no iOS silent-unlock pulse (a mock source
// that never stops) confounds the census.
const SP3_LANE_CYCLES = 200;
const SP3_LANE_RETENTION_VOICES = 4;

// T-SP3-lane (c): the SP-03 native-event bound on the lane params. 8 voices x 100
// ticks, 6 setPosition stamps/tick, one flush/tick -> ~100 target events/lane/voice,
// cap 200. The red control is a 60 Hz DIRECT lane writer (no stamp/throttle) -> ~600.
const SP3_LANE_TICKS = 100;
const SP3_LANE_FRAMES_PER_TICK = 6;
const SP3_LANE_EVENT_CAP = 200;
const SP3_LANE_RATE_RED_HZ = 60;

// --- PS1 destroyBus config (T-SP7) -------------------------------------------

// T-SP7: create/destroyBus retention + node census. destroyBus tombstones ONE
// dynamic bus (hollows the record IN PLACE, keeps the _busList slot) and releases
// its pool, positional/discrete/width scratch, per-bus signals, monitor
// registrations and graph edges -- without disturbing any surviving bus's live
// handles. Three things need proving and the bytesPerOp gate alone cannot do the
// first two: (a) the destroyBus contract + node census -- a destroyed discrete
// bus's pooled voices are STOPPED (live source-node census returns to baseline)
// and the bus is pulled out of _discreteBuses so no husk rides the lane flush;
// (b) a 4096-cycle create/destroyBus soak retains nothing (a lite-leak witness
// settles to 0 -- signals disposed, husk deregistered) with maxMajor:0 and
// maxPauseMs<=4; (c) the tombstone keeps _busList length + every surviving index
// stable so live handles still resolve. The red control (DESTROYBUS_RED) models a
// destroyBus that SKIPS the _discreteBuses swap-pop and leaves the pool live, so
// the husk rides the lane flush and its voices stay live -> census > 0 -> reject.
const SP7_CYCLES = 4096;         // create/destroyBus churn cycles (retention + GC)
const SP7_CENSUS_VOICES = 4;     // voices played per census engine
// The five bus presets destroyBus must tear down. Each createBus builds a distinct
// teardown surface: stereo (bare gain graph), positional/hrtf (PannerNode family +
// posXYZ scratch when pooled), width (7 Haas nodes armed at createBus), discrete
// (lanes != 0 -> pushed to _discreteBuses, vbap record). All ride the same cold
// destroyBus.
const SP7_PRESETS = [
    ['stereo', {}],
    ['positional', { spatial: 'positional' }],
    ['hrtf', { spatial: 'hrtf' }],
    ['width', { width: 0.5 }],
    ['discrete', { spatial: 'discrete', preset: '7.1' }],
];

// --- PS2 monitor-idle config (T-SP8) ------------------------------------------

// T-SP8: the shared monitor sleeps -- stops rescheduling -- at zero live
// consumers and wakes on the next registration. Phase (d) churn presets are
// restricted to consumer types that register LIVE at createBus() itself (meter/
// discrete/width), not 'positional' -- a positional bus needs its pool BUILT
// (defineSounds) before it counts as a consumer (the T3 trap), and building 4096
// pools would only slow the soak without adding coverage: T3's pool-build wake is
// separately locked by MonitorIdle.test.js case 15 and phase (a) below.
const SP8_CYCLES = 4096;         // create-consumer/tick/destroy/tick-to-sleep cycles
const SP8_OPS = 500_000;         // _monitorIdle() allocation-measurement ops
const SP8_MAX_BYTES_PER_OP = 0.05;  // tight ceiling: the predicate does no setTargetAtTime
const SP8_PRESETS = [
    ['meter', { meter: true }],
    ['width', { width: 0.5 }],
    ['discrete', { spatial: 'discrete', preset: '7.1' }],
];

// --- PS5 reloadTrack config (T-TRK1) ------------------------------------------

// T-TRK1: torture.mjs has NEVER exercised defineTracks/reloadTrack before this
// tier (0 hits) -- it builds the first track fixture in this file. reloadTrack
// tears a track's <audio> element + graph down destroy()-style and re-enters
// _loadTrack with a FRESH element (decisions/0014 D4/D5), so the retention
// witness here is per-ELEMENT, not per-bus: each cycle's OLD element must be
// released (removeAttribute('src')+load() witnessed, 0 residual timeupdate/
// ended listeners, its graph nodes disconnected) before the tracker untracks
// it, exactly one fresh element built per cycle (A2). A separate one-off phase
// proves the A4 wire-failure recovery (a track dumped to 'error' by a REAL
// throwing createMediaElementSource reaches 'ready' with a fresh element), and
// signal identity (A1) is checked every cycle of the retention loop, not just
// spot-checked. The red control (LITEAUDIO_TORTURE_TRK1_RED) swaps in a
// reloadTrack that skips the element-release + disconnect + null-out (steps
// 2-4 of the teardown contract) while still firing _loadTrack, so the old
// element/nodes are silently abandoned each cycle -- the tracker witness must
// then grow and the gate must reject.
const TRK1_CYCLES = 10_000;      // ~1e4 force-error -> reloadTrack cycles (A2)
const TRK1_GC_CYCLES = 2_000;    // GC-budget window (a fresh, heavier per-op cost
                                  // than the handle/scratch tiers -- real element +
                                  // gain-node construction -- so a smaller window)
const TRK1_RED = process.env.LITEAUDIO_TORTURE_TRK1_RED === '1';
// PS6 red control. DCK1_RED swaps in the SUPERSEDED first-draft applySnapshot
// (reset every active rule + skip the DUCK_REST rest-ramp while the bus is hot),
// which strands a still-hot bus dipped after a hot->cold race -- the fail-open
// the reviewer caught. The shipped ride-through (decisions/0015) never un-ducks a
// still-hot rule, so it never strands.
const DCK1_RED = process.env.LITEAUDIO_TORTURE_DCK1_RED === '1';
// Mirror of the private Audio.js sidechain rest multiplier (not exported).
const DUCK_REST = 1;

const LEAK = process.env.LITEAUDIO_TORTURE_LEAK === '1';
const SP1_RED = process.env.LITEAUDIO_TORTURE_SP1_RED === '1';
const SP2_RED = process.env.LITEAUDIO_TORTURE_SP2_RED === '1';
// The red control disables the prewarm retire, so the gain=0 voice stays live: the
// census then witnesses a leaked live source node (and activeCount stays 1) and the
// gate must reject. Proves the retire path is load-bearing, not decorative.
const SP5_RED = process.env.LITEAUDIO_TORTURE_SP5_RED === '1';
// The red control suppresses the release-proof untrack, so the witness never
// settles to 0 even though teardown ran -- modelling a destroy() that stopped
// releasing the scratch. The gate must reject.
const SP3_RED = process.env.LITEAUDIO_TORTURE_SP3_RED === '1';
// T-SP6 red controls. SP6_RED is a 60 Hz per-frame DIRECT writer onto the widener
// wet/makeup params (no setWidth/flush throttle) -> the native event list blows the
// cap. SP6_ALLOC_RED boxes {w} into a retained object per setWidth call -> non-zero
// major GC / bytesPerOp over the ceiling. Both must exit non-zero.
const SP6_RED = process.env.LITEAUDIO_TORTURE_SP6_RED === '1';
const SP6_ALLOC_RED = process.env.LITEAUDIO_TORTURE_SP6_ALLOC_RED === '1';
// S6 red controls. SP4_RED swaps in a detector defaulting an unknown maxChannelCount
// to 8, so the undefined/null/NaN detection rows FAIL OPEN to '7.1' and the gate must
// reject. SP3_LANE_RED allocates a fresh Float32Array(8) per lane solve, so the lane
// flush measures over the ceiling. SP3_RATE_RED is a 60 Hz direct lane writer that
// blows the SP-03 native-event cap. All must exit non-zero.
const SP4_RED = process.env.LITEAUDIO_TORTURE_SP4_RED === '1';
const SP3_LANE_RED = process.env.LITEAUDIO_TORTURE_SP3_LANE_RED === '1';
const SP3_RATE_RED = process.env.LITEAUDIO_TORTURE_SP3_RATE_RED === '1';
// PS1 red control. DESTROYBUS_RED models a destroyBus that SKIPS the _discreteBuses
// swap-pop AND leaves the pool live: the tombstoned husk stays wired into the lane
// flush with its voices still sounding, so the live source-node census never
// returns to baseline. The census assertion (delta 0) then catches it FOR THE
// ACTUAL REASON (a leaked live node riding the husk), and the gate must exit 1.
const DESTROYBUS_RED = process.env.LITEAUDIO_TORTURE_DESTROYBUS_RED === '1';
// PS2 red control. SP8_RED swaps in a _monitorIdle() that OMITS the auto-suspend
// clause (`if (this._autoSuspend && !this._selfSuspended) return false;`). With
// auto-suspend armed and counting down and no other consumer, the monitor sleeps
// mid-countdown, _evalAutoSuspend never runs again (it is only reached from the
// tick this predicate would have kept alive), _silentSince never matures, and the
// context is NEVER suspended -- phase (e) then observes isAutoSuspended() stuck at
// false and the gate must exit non-zero.
const SP8_RED = process.env.LITEAUDIO_TORTURE_SP8_RED === '1';

// --- setTrackVolume config (T-TVOL1, AU2 compat-shim fix) ---------------------

// T-TVOL1: v2.12.0's compat-shim fix (A-2, PARITY BRIEF.md) makes setTrackVolume
// a hot, frequently re-entered path for the first time -- Compat.js#play() now
// calls it on every explicit per-play volume, AFTER playTrack so the lazily-wired
// volumeGain exists on the very first play. Its documented contract (Audio.js) is
// "a map lookup and one AudioParam value write, no closures, no new objects."
// Two things need proving: (a) TVOL1_OPS steady-state calls on an already-wired
// track hold ~0 bytes/op and zero major GC, same shape as T-SP1's scalar-stamp
// ceiling; (b) a TVOL1_CYCLES build/wire/setTrackVolume/destroy soak -- each
// cycle exercising the full fail-closed matrix (unknown name, unwired graph,
// non-number, NaN, out-of-range clamp) alongside a valid write -- releases every
// witness cleanly: lite-leak at 0 and every cycle's <audio> element left paused
// (no live element outliving its engine's destroy()).
const TVOL1_OPS = 500_000;
const TVOL1_WARMUP = 50_000;
const TVOL1_MAX_BYTES_PER_OP = 4.0;    // mirrors T-SP1's scalar-write ceiling
const TVOL1_CYCLES = 500;
// The red control: swaps setTrackVolume for a version that boxes the clamped
// value into a fresh, retained wrapper object every call instead of writing the
// scalar straight onto rec.volumeGain.gain.value -- the allocating regression
// the "no closures, no new objects" contract explicitly rules out. Must blow
// both the bytesPerOp ceiling and the major-GC budget in phase (a).
const TVOL1_RED = process.env.LITEAUDIO_TORTURE_TVOL1_RED === '1';

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
    return '  ' + row.label.padEnd(18) +
        ' bytesPerOp=' + (Number.isFinite(row.bytesPerOp) ? row.bytesPerOp.toFixed(4) : 'null').padStart(10) +
        '  major=' + String(row.major).padStart(2) +
        '  maxMs=' + row.maxMs.toFixed(3);
}

/**
 * Best-of-N zero-alloc position measurement. A single scalar-stamp position writer is
 * byte-for-byte zero-alloc, so its steady-state bytesPerOp is 0. But a lone stray ~47 KB
 * JIT/GC bookkeeping allocation -- perturbed run-to-run by unrelated heap pressure -- can
 * land in ONE measurement pass and read as ~0.09 bytes/op over 500k ops, tripping a tight
 * 0.05 ceiling nondeterministically. A real per-op leak, by contrast, allocates on EVERY
 * pass, so the MINIMUM bytesPerOp across N passes still catches it (its floor is high)
 * while a one-off stray is discarded. This is the same class of stabilization T-SP1/T-SP5
 * already use (warmup + stabilize); best-of-N is the deterministic form for the tight
 * 0.05-ceiling position tiers. It does NOT widen the budget -- the ceiling is unchanged;
 * it removes measurement noise a single stray allocation injects.
 */
function measurePositionBestOf(label, writer, ops, warmup, passes) {
    let best = null;
    for (let p = 0; p < passes; p++) {
        let i = 0;
        const r = measureOps(() => writer(i++), { ops, warmup, source: 'gc', stabilize: true });
        const report = checkNoGc(r.summary, RULES);
        const bpo = r.bytesPerOp == null ? NaN : r.bytesPerOp;
        const row = { label, bytesPerOp: bpo, major: r.summary.gc.major, maxMs: r.summary.gc.maxMs, noMajor: report.ok };
        if (best === null || (Number.isFinite(bpo) && (!Number.isFinite(best.bytesPerOp) || bpo < best.bytesPerOp))) {
            best = row;
        }
    }
    return best;
}

// Best-of passes for the tight-ceiling (0.05) position tiers. 3 is enough to discard a
// lone stray allocation while keeping a real per-op leak (present on every pass) above
// the floor.
const POS_BEST_OF = 3;

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

// --- S4 HRTF engine builder --------------------------------------------------

/**
 * Build a live LiteAudio (mock context) with ONE hrtf bus, sound loaded, ready to
 * prewarm. The context starts 'running' so init() marks it unlocked and the pool
 * build fires _prewarmHrtf WITHOUT the iOS silent-buffer unlock pulse -- that pulse
 * is a mock source that never stops, and it would confound the live-node census.
 * `redRetire` swaps _retireHrtfWarm for a no-op BEFORE the prewarm arms, modelling a
 * retire that never runs. Returns the engine, its context, and the pre-prewarm
 * live-node baseline captured after the bus exists but before any voice sounds.
 */
async function buildHrtfEngine(voices, redRetire) {
    const ctx = createMockContext({ state: 'running' });
    const win = {
        navigator: { userAgent: 'node-torture-gate', maxTouchPoints: 0 },
        addEventListener: () => {},
        removeEventListener: () => {},
    };
    const audio = new LiteAudio({
        poolCapacity: voices,
        window: win,
        document: mockDocument(),
        fetch: mockFetch({ '/s.wav': 500 }),
        setTimeout: () => 0,
        clearTimeout: () => {},
    });
    await audio.init(ctx);                    // state 'running' -> unlocked
    audio.createBus('spatial', { spatial: 'hrtf' });
    const baseline = ctx._liveNodes();        // no voice has sounded yet
    if (redRetire) audio._retireHrtfWarm = () => {};   // never retire (red control)
    await audio.defineSounds({ ping: { src: ['/s.wav'], bus: 'spatial' } });
    await flushMicrotasks(8);                 // pool build fires the prewarm
    return { audio, ctx, baseline };
}

// --- S5 stereo-width engine builder ------------------------------------------

/**
 * Build a live LiteAudio (mock context) with ONE stereo bus armed with a widener
 * ({ width: 0 } -- armed but bypassed), a mono sound loaded and one voice sounding,
 * unlocked, monitor driven by hand. The mock's decodeAudioData returns a mono
 * buffer, so the widener stays armed (a non-mono source would disarm it). Returns
 * the engine, its context, and the armed bus record. 'wide' is created ONLY via
 * createBus so it is actually built armed (createBus is idempotent-by-name).
 */
async function buildWidthEngine() {
    const ctx = createMockContext({ state: 'suspended' });
    const gestures = [];
    const win = {
        navigator: { userAgent: 'node-torture-gate', maxTouchPoints: 0 },
        addEventListener: (_evt, cb) => gestures.push(cb),
        removeEventListener: () => {},
    };
    const audio = new LiteAudio({
        poolCapacity: 8,
        window: win,
        document: mockDocument(),
        fetch: mockFetch({ '/s.wav': 500 }),
        setTimeout: () => 0,
        clearTimeout: () => {},
    });
    await audio.init(ctx);
    audio.createBus('wide', { width: 0 });            // armed, start bypassed
    await audio.defineSounds({ ping: { src: ['/s.wav'], bus: 'wide' } });
    for (const cb of gestures) cb({});                // unlock
    await flushMicrotasks(8);

    const busRec = audio._buses.get('wide');
    if (busRec.wideIn === null) {
        die('width setup: bus "wide" was not armed (widener disarmed or width option dropped)');
    }
    const h = audio.play('ping', 1, 0, 1);
    if (h < 0) die('width setup: play returned a skip sentinel (' + h + ')');
    return { audio, ctx, busRec };
}

// --- S6 discrete-surround engine builder + red helpers -----------------------

/**
 * The fail-open detector the SP4_RED control swaps in: it implements the correct D1
 * bands EXCEPT it defaults an unknown/non-integer maxChannelCount to 8 (the richest)
 * instead of 0. So ONLY the fail-closed rows (absent/undefined/null/NaN/non-integer/
 * string/dest-absent) flip -- each to '7.1' -- while the concrete-integer rows stay
 * correct. Bound onto the engine instance BEFORE init(), so init()'s _detectLayout()
 * call takes this instead. Modelling the regression the shipped fail-closed guard exists
 * to prevent -- an unknown sink must NOT be optimistically upgraded off 'stereo'.
 */
function redDetectLayoutUnknownIsEight() {
    const v = this._ctx?.destination?.maxChannelCount;
    const n = Number.isInteger(v) ? v : 8;   // regression: unknown -> 8 (fail OPEN)
    this._maxChannels = n;
    this._layout = n >= 8 ? '7.1' : n >= 6 ? '5.1' : n >= 4 ? '3.1' : 'stereo';
}

/**
 * The allocating solver the SP3_LANE_RED control swaps in for _vbapSolve: a fresh
 * Float32Array per solve instead of the reused module scratch, RETAINED in `keep` (the
 * shared retention buffer every red control in this file uses). Retention, not transient
 * churn, is what this gc-source profiler measures -- a purely transient Float32Array is
 * young-gen garbage below the gate's resolution, the exact finding decisions/0001 records
 * for the boxed-double handle. The red models the regression the reused LANE_SCRATCH
 * exists to prevent: a solver whose per-flush buffer ESCAPES, so the flush now retains an
 * array per voice. The generalized signature is (rec, x, y, z) -- rec is the frozen
 * preset record; the exact gains do not matter to the measurement, only the allocation.
 */
function redVbapSolveAlloc(rec, x, y, z) {
    const s = new Float32Array(8);          // fresh allocation per solve -- the red floor
    let az = Math.atan2(x, -z) * (180 / Math.PI);
    if (az < 0) az += 360;
    s[2] = Math.cos((az / 360) * (Math.PI / 2));
    s[3] = 0.5;
    keep.push(s);                           // retained: what the gc-source gate can see
    return s;
}

/**
 * Detect the engine layout for a single maxChannelCount spec, fully building and
 * tearing down an engine. spec is { absent } (destination present, no maxChannelCount
 * key), { destAbsent } (no destination), or { value } (key present, pinned to value).
 * Under SP4_RED the fail-open detector is bound in before init().
 */
async function detectLayoutFor(spec) {
    const ctxOpts = { state: 'suspended' };
    if (!spec.absent && !spec.destAbsent) ctxOpts.maxChannelCount = spec.value;
    const ctx = createMockContext(ctxOpts);
    if (spec.absent) ctx._deleteMaxChannelCount();
    if (spec.destAbsent) ctx.destination = undefined;
    const audio = new LiteAudio({
        window: { navigator: { userAgent: 'node-torture-gate', maxTouchPoints: 0 },
            addEventListener: () => {}, removeEventListener: () => {} },
        document: mockDocument(),
        fetch: mockFetch({}),
        setTimeout: () => 0,
        clearTimeout: () => {},
    });
    if (SP4_RED) audio._detectLayout = redDetectLayoutUnknownIsEight;
    await audio.init(ctx);
    const layout = audio.layoutOf();
    audio.destroy();
    return layout;
}

/**
 * Build a discrete engine on a sink of `maxChannelCount` channels, arm a discrete bus
 * with the requested `preset`, load a sound, unlock, and report the fallback outcome:
 * the bus's effectiveLayout (the BUILT ladder token), a real play() handle, and the
 * resulting activeCount. Proves a discrete request that steps down the ladder still
 * builds a bus that plays.
 */
async function buildDiscreteFallback(maxChannelCount, preset) {
    const ctx = createMockContext({ state: 'suspended', maxChannelCount });
    const gestures = [];
    const win = {
        navigator: { userAgent: 'node-torture-gate', maxTouchPoints: 0 },
        addEventListener: (_evt, cb) => gestures.push(cb),
        removeEventListener: () => {},
    };
    const audio = new LiteAudio({
        poolCapacity: 4,
        window: win,
        document: mockDocument(),
        fetch: mockFetch({ '/s.wav': 500 }),
        setTimeout: () => 0,
        clearTimeout: () => {},
    });
    await audio.init(ctx);
    audio.createBus('surr', { spatial: 'discrete', preset });
    await audio.defineSounds({ ping: { src: ['/s.wav'], bus: 'surr' } });
    for (const cb of gestures) cb({});
    await flushMicrotasks(8);
    const eff = audio.effectiveLayoutOf('surr');
    const handle = audio.play('ping', 1, 0, 1);
    const active = audio.activeCount('surr');
    audio.destroy();
    return { eff, handle, active };
}

/**
 * Build a live LiteAudio (Nch mock context) with ONE discrete bus of the requested
 * `preset` and `voices` sounding voices, unlocked, monitor driven by hand. Modeled on
 * buildSpatialEngine. Defaults to the 8ch / 7.1 shape the S6 tiers use; `preset`/
 * `maxChannelCount` widen it to the 6-lane (5.1) and 4-lane (3.1) reductions. `running`
 * uses a state:'running' context so init() auto-unlocks WITHOUT the iOS silent-buffer
 * pulse (a mock source that never stops), keeping the live-node census honest for the
 * retention tier. 'surr' is created ONLY via createBus so it is actually built discrete
 * (createBus is idempotent-by-name). The clock never advances, so voiceNode() keeps every
 * voice alive across the flush window. Returns the engine, its context, the live voice
 * handles, the discrete bus record, the built lane count, and the pre-play live-node
 * census baseline.
 */
async function buildDiscreteEngine(voices, preset = '7.1', maxChannelCount = 8, running = false) {
    const laneCount = preset === '7.1' ? 8 : preset === '5.1' ? 6 : 4;
    const ctx = createMockContext({ state: running ? 'running' : 'suspended', maxChannelCount });
    const gestures = [];
    const win = {
        navigator: { userAgent: 'node-torture-gate', maxTouchPoints: 0 },
        addEventListener: (_evt, cb) => gestures.push(cb),
        removeEventListener: () => {},
    };
    const audio = new LiteAudio({
        poolCapacity: voices,
        window: win,
        document: mockDocument(),
        fetch: mockFetch({ '/s.wav': 500 }),
        setTimeout: () => 0,
        clearTimeout: () => {},
    });
    await audio.init(ctx);
    audio.createBus('surr', { spatial: 'discrete', preset });
    await audio.defineSounds({ ping: { src: ['/s.wav'], bus: 'surr' } });
    for (const cb of gestures) cb({});        // unlock (early-returns under a running ctx)
    await flushMicrotasks(8);

    const busRec = audio._buses.get('surr');
    if (busRec.lanes !== laneCount) {
        die('discrete setup: bus "surr" preset "' + preset + '" did not build ' + laneCount +
            ' lanes (lanes=' + busRec.lanes + ', effectiveLayout=' + busRec.effectiveLayout +
            ') on a ' + maxChannelCount + 'ch sink.');
    }
    // Pre-play census baseline: the count of live source nodes before any voice sounds.
    // On a running context this is 0 (no unlock pulse); the retention tier proves teardown
    // returns to it.
    const baseline = ctx._liveNodes();
    const handles = [];
    for (let i = 0; i < voices; i++) {
        const h = audio.play('ping', 1, 0, 1);
        if (h < 0) die('discrete setup: play returned a skip sentinel (' + h + ')');
        handles.push(h);
    }
    // Guard: prove the bus is truly discrete (voiceNode returns an Array(laneCount) of
    // lane GainNodes), so a stereo-by-accident bus fails loud here instead of later.
    const probe = busRec.pool.voiceNode(handles[0] >>> 0);
    if (!Array.isArray(probe) || probe.length !== laneCount || !probe[0] || !probe[0].gain) {
        die('discrete setup: surr bus is not discrete (voiceNode did not return a ' + laneCount +
            '-gain lane array)');
    }
    return { audio, ctx, handles, busRec, laneCount, baseline };
}

/**
 * The broken teardown the DESTROYBUS_RED control uses in place of destroyBus: it
 * drops the name bindings (a tombstone that createBus/play() would treat as gone)
 * but SKIPS the _discreteBuses swap-pop AND leaves the pool live -- so the husk
 * stays registered in the lane flush with its pooled voices still sounding.
 * Modelling the exact regression the swap-pop + pool.destroy() exist to prevent:
 * a destroyBus that forgets to pull the bus out of the monitor lane list leaks
 * every live voice on it. The census (delta 0) is what catches it.
 */
function redDestroyBus(audio, name) {
    const busRec = audio._buses.get(name);
    if (!busRec) return false;
    audio._buses.delete(name);
    audio._soundsByBus.delete(name);
    busRec.dead = true;                  // tombstoned by name, but pool + list untouched
    return true;
}

// --- PS2 idle-monitor engine builder + red predicate --------------------------

/**
 * Build a live LiteAudio wired to a REAL mockScheduler (test/mock-ctx.js) --
 * T-SP8's entire subject is the scheduling, so a no-op `setTimeout: () => 0`
 * (every other builder in this file) would make the tier vacuous. The context
 * starts 'running' so init() marks it unlocked immediately (no gesture plumbing
 * needed), and the sink supports 8 channels so a discrete bus can be built.
 * Returns the engine, its context, and the manual clock (setTimeout/flush/pending).
 */
async function buildIdleEngine({ buses = [], maxChannelCount = 8, capacity = 4 } = {}) {
    const ctx = createMockContext({ state: 'running', maxChannelCount });
    const clock = mockScheduler();
    const win = {
        navigator: { userAgent: 'node-torture-gate', maxTouchPoints: 0 },
        addEventListener: () => {}, removeEventListener: () => {},
    };
    const audio = new LiteAudio({
        buses, poolCapacity: capacity, window: win, document: mockDocument(),
        fetch: mockFetch({ '/s.wav': 500 }),
        setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    });
    await audio.init(ctx);
    return { audio, ctx, clock };
}

/**
 * A running engine with an 'sfx' trigger bus (one decoded sound 'laser') and a
 * 'music' target bus, unlocked so play('laser') makes sfx genuinely hot
 * (pool.activeCount() >= 1) and stopAll() drops it cold -- the exact hot/cold
 * mechanism test/MixIntelligence.test.js's boot() uses, so applySnapshot and
 * _evalDuckRules both read a real activeCount(). One clock.flush() == one monitor
 * tick (_evalDuckRules). Used by T-DCK1 (PS6).
 */
async function buildDuckSnapshotEngine() {
    const ctx = createMockContext({ state: 'suspended' });
    const clock = mockScheduler();
    const fired = [];
    const win = {
        navigator: { userAgent: 'node-torture-gate', maxTouchPoints: 0 },
        addEventListener: (evt, cb) => { fired.push(cb); },
        removeEventListener: () => {},
        fire: () => { for (const cb of [...fired]) cb({}); },
    };
    const audio = new LiteAudio({
        buses: ['sfx', 'music'], poolCapacity: 8, window: win,
        document: mockDocument(), fetch: mockFetch({ '/laser.wav': 500 }),
        setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    });
    await audio.init(ctx);
    await audio.defineSounds({ laser: { src: ['/laser.wav'], bus: 'sfx' } });
    win.fire();
    await flushMicrotasks(8);
    return { audio, ctx, clock };
}

/**
 * The fail-open predicate the SP8_RED control swaps in for _monitorIdle: every
 * clause of the shipped predicate EXCEPT the C4 auto-suspend line
 * (`if (this._autoSuspend && !this._selfSuspended) return false;`). Modelling the
 * regression decisions/0011 names as the bug most likely to actually ship: auto-
 * suspend is the one consumer with no flat list and no per-bus field, exactly what
 * an implementer forgets while writing the _busList scan. With auto-suspend armed
 * and counting down and no other consumer, this predicate reports idle immediately,
 * the tick stops rescheduling, `_evalAutoSuspend` (only ever reached FROM a running
 * tick) never runs again, and the context is never suspended.
 */
function redMonitorIdleNoAutoSuspend() {
    if (this._meteredBuses.length !== 0) return false;
    if (this._discreteBuses.length !== 0) return false;
    if (this._duckRules.length !== 0) return false;
    // C4 (the omitted clause) intentionally absent here.
    const list = this._busList;
    for (let b = 0; b < list.length; b++) {
        const busRec = list[b];
        if (busRec.dead) continue;
        if (busRec.hrtfWarmHandle !== null) return false;
        if (busRec.wideIn !== null) return false;
        if (busRec.pool !== null && busRec.posDirty !== null) return false;
    }
    return true;
}

// --- PS5 reloadTrack fixture + red control (T-TRK1) ---------------------------

/**
 * A context that records createMediaElementSource calls and, when
 * `throwOnReuse` is set, enforces the spec's one-source-per-element rule by
 * throwing InvalidStateError on a re-used element -- mirrors
 * test/Tracks.test.js's sourceTrackingCtx (the wire-failure mock T9 was told
 * to reuse) and test/ReloadTrack.test.js's copy of the same pattern.
 */
function trkSourceTrackingCtx({ throwOnReuse = false } = {}) {
    const ctx = createMockContext({ state: 'running' });
    const sourced = new Set();
    const orig = ctx.createMediaElementSource;
    ctx.createMediaElementSource = (el) => {
        if (throwOnReuse && sourced.has(el)) {
            const e = new Error('createMediaElementSource: element already connected');
            e.name = 'InvalidStateError';
            throw e;
        }
        sourced.add(el);
        return orig(el);
    };
    return ctx;
}

/**
 * A document whose FIRST created <audio> is the caller-supplied (pre-spent)
 * element; every createElement call after that mints a brand-new one via the
 * ordinary mockAudioElement factory (which itself is the "records created +
 * released elements" fixture T9 asked for: el.srcReleased/el.loadCalls/
 * el._listenerCount are the release witness read below). Models a host that
 * handed lite-audio one already-sourced element once (the A4 wire-failure
 * seed), then mints fresh ones normally -- exactly what proves reloadTrack's
 * escape from the one-MediaElementSource-per-element trap (D4).
 */
function trkPoisonedThenFreshDocument(spentEl) {
    const created = [];
    let first = true;
    return {
        hidden: false,
        created,
        createElement(tag) {
            if (tag !== 'audio') throw new Error('trkPoisonedThenFreshDocument: unexpected <' + tag + '>');
            if (first) { first = false; created.push(spentEl); return spentEl; }
            const el = mockAudioElement();
            created.push(el);
            return el;
        },
        addEventListener() {},
        removeEventListener() {},
    };
}

/**
 * The T-TRK1 red control: a reloadTrack that keeps the exact same fail-closed
 * precondition guards (D1/D2) but SKIPS steps 2-4 of the teardown contract --
 * the element release (no removeAttribute('src')/load(), no timeupdate/ended
 * listener removal), the graph disconnect, and the null-out of the rebuildable
 * rec fields -- while still firing _loadTrack so the state machine keeps
 * advancing (loading -> ready/error) exactly as the real method does. The old
 * element/nodes are silently abandoned each cycle: this is the actual
 * regression the guarded release in decisions/0014 D5/D7 exists to prevent.
 * Bound onto the instance (`this`) in place of the real method before the
 * retention loop runs.
 */
function redReloadTrack(name) {
    if (this._destroyed) throw new Error('LiteAudio: destroyed');
    if (!this._initialized) throw new Error('LiteAudio: init() before reloadTrack()');
    if (typeof name !== 'string' || name.length === 0) return false;
    const rec = this._tracks.get(name);
    if (!rec) return false;
    const state = rec.loadState.peek();
    if (state === 'loading') return false;
    if (rec.playing.peek()) return false;
    if (state !== 'error' && state !== 'idle') return false;

    // RED: no element.pause()/removeAttribute('src')/load(), no listener
    // removal, no source/xfadeGain/volumeGain.disconnect(), no null-out --
    // the spent element and its graph nodes are simply dropped, still wired,
    // still holding their src and listeners, while rec.element is overwritten
    // by the fresh one _loadTrack builds.
    rec.playing.set(false);
    rec.position.set(0);
    rec.duration.set(0);
    this._loadTrack(rec);
    return true;
}

/**
 * The superseded first-draft applySnapshot the DCK1_RED control swaps in: it
 * resets rule.active=false for EVERY active rule targeting a rested bus AND skips
 * the DUCK_REST rest-ramp when the bus is still hot (busHot). That leaves a
 * still-hot bus's duckGain sitting at the dipped curProduct/tgtEff with no
 * scheduled move; when the trigger then goes cold before the next tick,
 * _evalDuckRules sees shouldDuck:false === rule.active:false -> no edge -> the bus
 * is STRANDED dipped (the fail-open the reviewer caught). The shipped ride-through
 * (decisions/0015) leaves a still-hot rule engaged instead, so it never strands.
 * Bound to the engine; structurally identical to the shipped method minus the
 * ride-through.
 */
function redApplySnapshotStrand(name, ms = 0) {
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
        const curProduct = busRec.gain.gain.value * busRec.duckGain.gain.value;
        busRec.volume.set(tgtVol);
        busRec.muted.set(tgtMuted);
        busRec.duckManual = false;
        const dg = busRec.duckGain.gain;
        dg.cancelScheduledValues(now);
        let busHot = false;
        const rules = this._duckRules;
        for (let r = 0; r < rules.length; r++) {
            const rule = rules[r];
            if (rule.targetBus !== snap.names[i]) continue;
            if (rule.active) rule.active = false;
            const trig = this._buses.get(rule.triggerBus);
            const voices = trig && trig.pool ? trig.pool.activeCount() : 0;
            if (voices >= rule.threshold) busHot = true;
        }
        if (ms > 0 && tgtEff > 0) {
            busRec.gain.gain.cancelScheduledValues(now);
            busRec.gain.gain.setValueAtTime(tgtEff, now);
            dg.setValueAtTime(curProduct / tgtEff, now);
            if (!busHot) dg.linearRampToValueAtTime(DUCK_REST, now + ms / 1000);
        } else {
            dg.setValueAtTime(DUCK_REST, now);
        }
    }
}

// --- setTrackVolume fixture + red control (T-TVOL1) ----------------------------

/**
 * Build a running (auto-unlocked) single-track engine and wire its graph via a
 * first playTrack -- mirrors test/Tracks.test.js's boot() and T-TRK1's fixture
 * above. volumeGain must exist (rec.volumeGain !== null) before setTrackVolume
 * can act on it; playTrack is what wires it.
 */
async function buildTvolEngine() {
    const win = {
        navigator: { userAgent: 'node-torture-gate', maxTouchPoints: 0 },
        addEventListener: () => {}, removeEventListener: () => {},
    };
    const ctx = createMockContext({ state: 'running' });
    const doc = mockDocument();
    const audio = new LiteAudio({
        buses: ['music'], poolCapacity: 4, window: win, document: doc,
        fetch: mockFetch({ '/tvol.mp3': 500 }),
        setTimeout: () => 0, clearTimeout: () => {},
    });
    await audio.init(ctx);
    await audio.defineTracks({ tvol: { src: ['/tvol.mp3'], bus: 'music', volume: 0.6 } });
    audio.playTrack('tvol');   // wires the graph: volumeGain must exist for the setter to act
    return { audio, ctx, doc, win };
}

/**
 * The T-TVOL1 red control: keeps setTrackVolume's exact fail-closed guards
 * (destroyed / unknown name / unwired graph / non-number / NaN all still
 * reject, same clamp to [0, 1]) but writes the clamped value through a fresh
 * BOXED wrapper object every call, instead of straight onto
 * rec.volumeGain.gain.value -- the allocating regression the docstring's "no
 * closures, no new objects" contract rules out. The wrapper is also pushed
 * onto the module `keep` buffer (the same unbounded-retention buffer AU-01's
 * object-handle control uses) so the control separates clearly on both
 * bytesPerOp and retained heap, not just JIT noise. Bound onto the instance in
 * place of the real method before the T-TVOL1 (a) measurement loop runs.
 */
function redSetTrackVolume(name, v) {
    if (this._destroyed) return;
    const rec = this._tracks.get(name);
    if (!rec) return;
    if (!rec.volumeGain) return;
    if (typeof v !== 'number' || v !== v) return;
    const boxed = { v: v < 0 ? 0 : v > 1 ? 1 : v };
    rec.volumeGain.gain.value = boxed.v;
    keep.push(boxed);
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

    // 9) T-SP5 (S4): HRTF spatial bus + HRIR prewarm.
    //    (a) every voice panner across capacity is an HRTF PannerNode (0 exceptions);
    //    (b) the gain=0 prewarm voice retires on the monitor tick -> activeCount 0
    //        and the live source-node census returns to its pre-prewarm baseline;
    //    (c) SP5_CYCLES build/teardown cycles leave the lite-leak witness at 0.
    //    The red control (SP5_RED) disables the retire so the voice stays live and
    //    the census rejects.
    const hrtf = await buildHrtfEngine(SP5_VOICES, SP5_RED);
    const hpool = hrtf.audio._buses.get('spatial').pool;

    // (a) Panner model census -- read the pool's per-channel panners directly, so a
    //     single stereo-by-accident voice among the capacity fails loud.
    let nonHrtf = 0;
    for (let i = 0; i < SP5_VOICES; i++) {
        const p = hpool.panners[i];
        if (!p || p.panningModel !== 'HRTF') nonHrtf++;
    }
    process.stderr.write('T-SP5 (a) panner census: ' + (SP5_VOICES - nonHrtf) + '/' + SP5_VOICES +
        ' voice panners report panningModel===HRTF\n');
    if (nonHrtf !== 0) {
        die('T-SP5: ' + nonHrtf + ' of ' + SP5_VOICES + ' hrtf-bus voice panners are NOT HRTF -- ' +
            'the pool did not receive panner:"hrtf", or lite-audio collapsed the mode wrong.');
    }

    // (b) Prewarm arm -> retire census. The prewarm fired at pool build (running
    //     ctx, no unlock pulse), so a gain=0 voice is live now.
    const armedActive = hrtf.audio.activeCount('spatial');
    const armedLive = hrtf.ctx._liveNodes();
    if (armedActive < 1) {
        die('T-SP5: the HRIR prewarm never armed -- activeCount("spatial") is ' + armedActive +
            ' after pool build on an unlocked context (expected the gain=0 voice).');
    }
    hrtf.audio._retireHrtfWarm();                  // the monitor tick's retire step
    const afterActive = hrtf.audio.activeCount('spatial');
    const afterLive = hrtf.ctx._liveNodes();
    const liveDelta = afterLive - hrtf.baseline;
    process.stderr.write('T-SP5 (b) prewarm ' + (SP5_RED ? '(RED: retire disabled)' : '(retire on tick)') +
        ': armed active=' + armedActive + ' live=' + armedLive +
        ' -> after active=' + afterActive + ' live=' + afterLive +
        ' (baseline ' + hrtf.baseline + ', delta ' + liveDelta + ')\n');
    // The RED control (retire disabled) is gated on the MEASURED census below, not
    // on the env flag itself: SP5_RED arms the prewarm and then skips the retire,
    // so afterActive stays at the armed value and liveDelta stays >= 1 -- the same
    // two assertions the green path relies on now catch the red path FOR THE
    // ACTUAL REASON (a leaked live node), not because a flag was read. A red
    // control that dies on its own flag can never prove the assertion it claims to
    // guard; gating on the measurement means a future regression that silently
    // fixes the "disabled retire" case (so it stops leaking) would flip this red
    // run to green too -- which is the correct, falsifiable behaviour.
    if (afterActive !== 0) {
        die('T-SP5: after retire activeCount("spatial") is ' + afterActive + ' (expected 0) -- ' +
            'the prewarm voice was not stopped' + (SP5_RED ? ' (SP5_RED: retire disabled, as designed)' : '') + '.');
    }
    if (liveDelta !== 0) {
        die('T-SP5: after retire the live source-node census is ' + afterLive + ' vs baseline ' +
            hrtf.baseline + ' (delta ' + liveDelta + ') -- the prewarm leaked a live node' +
            (SP5_RED ? ' (SP5_RED: retire disabled, as designed)' : '') + '.');
    }
    // If SP5_RED was requested but the measured census came back clean anyway, the
    // control itself is broken (it is no longer exercising the leak it claims to
    // model) -- that is a FAIL in its own right, not a silent pass-through.
    if (SP5_RED) {
        die('SP5_RED: retire was disabled but the measured census still came back clean ' +
            '(activeCount ' + afterActive + ', live-node delta ' + liveDelta + ') -- the red ' +
            'control is no longer modelling a leak and cannot prove this gate is falsifiable.');
    }
    // (b.5) setPosition allocation on this same hrtf bus, measured independently
    //     of T-SP1 (which only ever exercises a 'positional' bus). The prewarm
    //     channel is free now (retired above), so this plays one real voice and
    //     stamps its position SP5_POS_OPS times.
    const hrtfPosHandle = hrtf.audio.play('ping', 1, 0, 1);
    if (hrtfPosHandle < 0) die('T-SP5: setPosition-allocation setup: play returned a skip sentinel');
    const hrtfPosRow = (() => {
        let i = 0;
        const writer = (n) => { hrtf.audio.setPosition(hrtfPosHandle, n, n + 1, n - 1); };
        const r = measureOps(() => writer(i++), { ops: SP5_POS_OPS, warmup: SP5_POS_WARMUP, source: 'gc', stabilize: true });
        const report = checkNoGc(r.summary, RULES);
        return {
            label: 'T-SP5:setPosition', bytesPerOp: r.bytesPerOp == null ? NaN : r.bytesPerOp,
            major: r.summary.gc.major, maxMs: r.summary.gc.maxMs, noMajor: report.ok,
        };
    })();
    process.stderr.write('T-SP5 (b.5) setPosition on an hrtf bus (' + SP5_POS_OPS + ' scalar stamps):\n');
    process.stderr.write(fmt(hrtfPosRow) + '\n');
    if (!hrtfPosRow.noMajor) {
        die('T-SP5: setPosition (hrtf bus) ' + hrtfPosRow.major + ' major GC / maxMs ' +
            hrtfPosRow.maxMs.toFixed(3) + ' violates ' + JSON.stringify(RULES));
    }
    if (!(hrtfPosRow.bytesPerOp <= SP5_POS_MAX_BYTES_PER_OP)) {
        die('T-SP5: setPosition on an hrtf bus measured ' + hrtfPosRow.bytesPerOp.toFixed(4) +
            ' bytes/op, over the ' + SP5_POS_MAX_BYTES_PER_OP + ' ceiling -- the hrtf-bus position ' +
            'path is allocating on the caller frame.');
    }
    hrtf.audio.destroy();

    // (c) Build/teardown soak: a fresh hrtf engine each cycle prewarms + retires,
    //     then destroy() must null hrtfWarmHandle AND the positional scratch. A
    //     lite-leak witness is untracked ONLY on that proof, so a teardown that
    //     stops releasing leaves the ledger nonzero.
    const sp5Tracker = createLeakTracker({ name: 'lite-audio-hrtf-soak' });
    const SP5_NOOP = () => {};
    const sp5Kept = [];
    for (let c = 0; c < SP5_CYCLES; c++) {
        let cyc;
        try {
            cyc = await buildHrtfEngine(SP5_VOICES, false);
        } catch (err) {
            die('T-SP5: build cycle ' + c + ' threw (' + (err && err.message || err) + ') -- a ' +
                'teardown that stops releasing its lite-signal nodes exhausts the shared pool.');
        }
        cyc.audio._retireHrtfWarm();                 // retire the prewarm before teardown
        const busRec = cyc.audio._buses.get('spatial');
        const sentinel = { cycle: c };
        sp5Kept.push(sentinel);
        const witness = sp5Tracker.track(sentinel, SP5_NOOP, c);
        cyc.audio.destroy();
        if (busRec.hrtfWarmHandle === null && busRec.posXYZ === null &&
            busRec.posOwner === null && busRec.posDirty === null) {
            sp5Tracker.untrack(witness);
        }
    }
    if (sp5Kept.length !== SP5_CYCLES) die('T-SP5: internal -- pinned ' + sp5Kept.length + ' of ' + SP5_CYCLES);
    const sp5Leaked = sp5Tracker.size();
    process.stderr.write('T-SP5 (c) build/teardown soak: lite-leak witnessed ' + sp5Leaked +
        ' un-released hrtf bus record(s) after ' + SP5_CYCLES + ' cycles (expected 0)\n');
    if (sp5Leaked !== 0) {
        die('T-SP5: lite-leak witnessed ' + sp5Leaked + ' hrtf bus record(s) still holding a ' +
            'prewarm handle or positional scratch after destroy() -- a teardown leak.');
    }

    // 10) T-SP6 (S5): the stereo widener.
    //    (d) the SP-03 native-event bound applied to the wet/makeup params: 100 flushes
    //        at ~10 Hz, the caller updating width at ~60 Hz between flushes, stays under
    //        a 200 events/param cap (~100 expected); identical-value writes collapse to
    //        exactly 1. The red control writes the params directly at 60 Hz -> ~600.
    //    (e) setWidth is a zero-alloc clamp + field stamp: 500k calls under a 4.0 B/op
    //        ceiling, no major GC; the boxed control lands clearly above.
    //    (f) destroy() disconnects + nulls all 7 widener nodes, witnessed by lite-leak
    //        across SP6_CYCLES build/teardown cycles.

    // (d) native-event bound.
    const sp6 = await buildWidthEngine();
    const wbus = sp6.busRec;
    if (SP6_RED) {
        const framesPerTick = (SP6_RED_HZ / 10) | 0;   // 6 frames per ~10 Hz tick
        for (let t = 0; t < SP6_TICKS; t++) {
            const now = sp6.ctx.currentTime;
            for (let f = 0; f < framesPerTick; f++) {
                // Direct per-frame param writes -- exactly what setWidth/_flushWidth
                // exist to prevent -- so the native event list grows unbounded.
                const val = ((t + f) & 1) ? 0.5 : 0.25;
                wbus.wideWet.gain.setTargetAtTime(val, now, 0.05);
                wbus.wideMakeup.gain.setTargetAtTime(1, now, 0.05);
            }
        }
    } else {
        for (let t = 0; t < SP6_TICKS; t++) {
            // 6 identical setWidth/tick (the value only alternates BETWEEN ticks), so
            // the flush proves both properties at once: 6 stamps collapse to <=1 write,
            // and 100 alternating ticks yield ~100 events/param.
            const w = (t & 1) ? 1 : 0.5;
            for (let f = 0; f < SP6_FRAMES_PER_TICK; f++) sp6.audio.setWidth('wide', w);
            sp6.audio._flushWidth();
        }
    }
    let sp6Max = 0;
    {
        let n = 0;
        const ev = wbus.wideWet.gain.events;
        for (let k = 0; k < ev.length; k++) if (ev[k][0] === 'target') n++;
        if (n > sp6Max) sp6Max = n;
        let m = 0;
        const ev2 = wbus.wideMakeup.gain.events;
        for (let k = 0; k < ev2.length; k++) if (ev2[k][0] === 'target') m++;
        if (m > sp6Max) sp6Max = m;
    }
    process.stderr.write('T-SP6 (d) ' + (SP6_RED ? '(RED: 60 Hz per-frame direct writer)' : '(10 Hz throttled flush)') +
        ': max wet/makeup target events/param = ' + sp6Max + ' (cap ' + SP6_EVENT_CAP +
        ', expected ~' + SP6_TICKS + ')\n');
    if (!(sp6Max <= SP6_EVENT_CAP)) {
        die('T-SP6: ' + sp6Max + ' widener target events/param exceeds the ' + SP6_EVENT_CAP +
            ' cap -- a per-frame param writer is growing the native event list (SP-03).');
    }
    // Identical-value collapse: a fresh armed bus, same width every tick -> exactly 1
    // write per param across many flushes.
    {
        const idBus = sp6.audio.createBus('wide2', { width: 0 });
        // 'wide2' has no pool, but _flushWidth only touches the widener params.
        for (let t = 0; t < 10; t++) { sp6.audio.setWidth('wide2', 0.7); sp6.audio._flushWidth(); }
        let idN = 0;
        const idEv = idBus.wideWet.gain.events;
        for (let k = 0; k < idEv.length; k++) if (idEv[k][0] === 'target') idN++;
        process.stderr.write('T-SP6 (d) identical-value collapse: ' + idN + ' target event(s) over 10 ticks (expected 1)\n');
        if (idN !== 1) {
            die('T-SP6: identical-value setWidth produced ' + idN + ' writes over 10 ticks (expected 1) -- ' +
                'the flush is not gating on widthLast !== width.');
        }
    }
    sp6.audio.destroy();

    // (e) setWidth allocation. Scalar stamp vs retained {w} box per call.
    const sp6a = await buildWidthEngine();
    const scalarWidth = (i) => { sp6a.audio.setWidth('wide', (i & 1023) / 1023); };
    const boxedWidth = (i) => { keep.push({ w: i }); sp6a.audio.setWidth('wide', (i & 1023) / 1023); };
    const sp6Gated = SP6_ALLOC_RED ? boxedWidth : scalarWidth;
    const sp6Row = (() => {
        let i = 0;
        const r = measureOps(() => sp6Gated(i++), { ops: SP6_OPS, warmup: SP6_WARMUP, source: 'gc', stabilize: true });
        const report = checkNoGc(r.summary, RULES);
        return {
            label: SP6_ALLOC_RED ? 'T-SP6:ALLOC_RED' : 'T-SP6', bytesPerOp: r.bytesPerOp == null ? NaN : r.bytesPerOp,
            major: r.summary.gc.major, maxMs: r.summary.gc.maxMs, noMajor: report.ok,
        };
    })();
    const sp6Control = SP6_ALLOC_RED ? sp6Row : (() => {
        let i = 0;
        const r = measureOps(() => boxedWidth(i++), { ops: SP6_OPS, warmup: SP6_WARMUP, source: 'gc', stabilize: true });
        return {
            label: 'T-SP6:control', bytesPerOp: r.bytesPerOp == null ? NaN : r.bytesPerOp,
            major: r.summary.gc.major, maxMs: r.summary.gc.maxMs,
        };
    })();
    process.stderr.write('T-SP6 (e) setWidth (500k scalar stamps vs retained {w} box per call):\n');
    process.stderr.write(fmt(sp6Row) + '\n');
    process.stderr.write(fmt(sp6Control) + '\n');
    if (!(sp6Control.bytesPerOp >= SP6_CONTROL_MIN_BYTES_PER_OP)) {
        die('T-SP6 control (retained {w} box) measured ' + sp6Control.bytesPerOp.toFixed(4) +
            ' bytes/op, below the ' + SP6_CONTROL_MIN_BYTES_PER_OP + ' floor -- the gate cannot ' +
            'see allocation and is not falsifiable.');
    }
    if (SP6_ALLOC_RED) {
        die('SP6_ALLOC_RED: gated setWidth path is the retained-box variant (' +
            sp6Row.bytesPerOp.toFixed(4) + ' bytes/op) -- rejecting as designed. This is the red ' +
            'control; a clean run does not take this branch.');
    }
    if (!sp6Row.noMajor) {
        die('T-SP6: ' + sp6Row.major + ' major GC / maxMs ' + sp6Row.maxMs.toFixed(3) +
            ' violates ' + JSON.stringify(RULES));
    }
    if (!(sp6Row.bytesPerOp <= SP6_MAX_BYTES_PER_OP)) {
        die('T-SP6: setWidth measured ' + sp6Row.bytesPerOp.toFixed(4) + ' bytes/op, over the ' +
            SP6_MAX_BYTES_PER_OP + ' ceiling -- the width path is allocating on the caller frame.');
    }
    sp6a.audio.destroy();

    // (f) build/teardown soak: destroy() must disconnect + null all 7 widener nodes.
    const sp6Tracker = createLeakTracker({ name: 'lite-audio-width-soak' });
    const SP6_NOOP = () => {};
    const sp6Kept = [];
    let sp6UndisconnectedCycles = 0;
    for (let c = 0; c < SP6_CYCLES; c++) {
        let cyc;
        try {
            cyc = await buildWidthEngine();
        } catch (err) {
            die('T-SP6: build cycle ' + c + ' threw (' + (err && err.message || err) + ') -- a ' +
                'teardown that stops releasing its lite-signal nodes exhausts the shared pool.');
        }
        cyc.audio.setWidth('wide', 1);
        cyc.audio._flushWidth();
        const b = cyc.busRec;
        // Capture the 7 nodes BEFORE destroy nulls the slots, so we can assert each was
        // disconnected at least once.
        const nodes = [b.wideIn, b.wideMakeup, b.wideWet, b.delayL, b.delayR, b.panL, b.panR];
        const sentinel = { cycle: c };
        sp6Kept.push(sentinel);
        const witness = sp6Tracker.track(sentinel, SP6_NOOP, c);
        cyc.audio.destroy();
        let allDisconnected = true;
        for (let k = 0; k < nodes.length; k++) {
            if (!nodes[k] || nodes[k].disconnected < 1) { allDisconnected = false; break; }
        }
        if (!allDisconnected) sp6UndisconnectedCycles++;
        // Untrack only on proof that destroy() nulled every widener slot.
        if (b.wideIn === null && b.wideMakeup === null && b.wideWet === null &&
            b.delayL === null && b.delayR === null && b.panL === null && b.panR === null) {
            sp6Tracker.untrack(witness);
        }
    }
    if (sp6Kept.length !== SP6_CYCLES) die('T-SP6: internal -- pinned ' + sp6Kept.length + ' of ' + SP6_CYCLES);
    const sp6Leaked = sp6Tracker.size();
    process.stderr.write('T-SP6 (f) build/teardown soak: lite-leak witnessed ' + sp6Leaked +
        ' un-released widener bus record(s), ' + sp6UndisconnectedCycles +
        ' cycle(s) left a widener node connected, over ' + SP6_CYCLES + ' cycles (expected 0/0)\n');
    if (sp6UndisconnectedCycles !== 0) {
        die('T-SP6: ' + sp6UndisconnectedCycles + ' teardown cycle(s) left a widener node connected -- ' +
            'destroy() must disconnect all 7 widener nodes.');
    }
    if (sp6Leaked !== 0) {
        die('T-SP6: lite-leak witnessed ' + sp6Leaked + ' widener bus record(s) still holding widener ' +
            'nodes after destroy() -- a teardown leak.');
    }

    // 11) T-SP4 (S6/S7): fail-closed output-layout detection + the discrete fallback ladder.
    //     (a) the pinned detection matrix (D1) -- every maxChannelCount shape resolves to
    //         its richest fail-closed layout (>=8 -> 7.1, 6|7 -> 5.1, 4|5 -> 3.1, else
    //         stereo). The red control swaps in a detector defaulting unknown -> 8, so the
    //         fail-closed rows (absent/undefined/null/NaN/non-integer/string) flip to
    //         '7.1' and the gate rejects.
    const sp4Mismatches = [];
    for (let r = 0; r < SP4_MATRIX.length; r++) {
        const name = SP4_MATRIX[r][0], spec = SP4_MATRIX[r][1], expect = SP4_MATRIX[r][2];
        const got = await detectLayoutFor(spec);
        if (got !== expect) sp4Mismatches.push(name + ' expected ' + expect + ' got ' + got);
    }
    process.stderr.write('T-SP4 (a) detection matrix ' + (SP4_RED ? '(RED: unknown->8 detector) ' : '') +
        ': ' + (SP4_MATRIX.length - sp4Mismatches.length) + '/' + SP4_MATRIX.length +
        ' rows resolved to their pinned fail-closed layout\n');
    if (SP4_RED) {
        if (sp4Mismatches.length === 0) {
            die('SP4_RED: the unknown->8 detector produced no matrix mismatch -- the red control ' +
                'is not modelling the fail-open regression it claims and cannot prove this gate is falsifiable.');
        }
        die('SP4_RED: the unknown->8 detector flipped ' + sp4Mismatches.length + ' row(s) off their ' +
            'fail-closed layout (' + sp4Mismatches.join('; ') + ') -- rejecting as designed. This is the ' +
            'red control; a clean run does not take this branch.');
    }
    if (sp4Mismatches.length !== 0) {
        die('T-SP4: detection resolved ' + sp4Mismatches.length + ' row(s) wrong (' +
            sp4Mismatches.join('; ') + ') -- the fail-closed layout guard regressed.');
    }

    //     (b) the fallback ladder (D2): the 12 pinned cells of requested x M. Each cell
    //         must report the built ladder token; the 3 stereo cells must build a bus
    //         that actually PLAYS. A request never upgrades and only steps down to fit.
    let ladderBuilt = 0, ladderStereoPlayed = 0;
    for (let r = 0; r < SP4_LADDER.length; r++) {
        const name = SP4_LADDER[r][0], req = SP4_LADDER[r][1], max = SP4_LADDER[r][2], expect = SP4_LADDER[r][3];
        const res = await buildDiscreteFallback(max, req);
        if (res.eff !== expect) {
            die('T-SP4: discrete request ' + name + ' reported effectiveLayout ' +
                res.eff + ' (expected ' + expect + ').');
        }
        if (expect === 'stereo') {
            if (!(res.handle >= 0 && res.active >= 1)) {
                die('T-SP4: discrete fallback ' + name + ' did not build a bus that plays (handle=' +
                    res.handle + ', active=' + res.active + ') -- a fallback bus must be a WORKING stereo bus.');
            }
            ladderStereoPlayed++;
        } else {
            ladderBuilt++;
        }
    }
    process.stderr.write('T-SP4 (b) fallback ladder: all ' + SP4_LADDER.length + ' cells pinned; ' +
        ladderBuilt + ' discrete-built, ' + ladderStereoPlayed +
        ' stereo-fallback bus(es) all played (expected 9 built / 3 played)\n');
    if (ladderBuilt !== 9 || ladderStereoPlayed !== 3) {
        die('T-SP4: expected 9 discrete-built + 3 stereo-played ladder cells, got ' +
            ladderBuilt + ' + ' + ladderStereoPlayed + '.');
    }

    //     (c) setPosition on a discrete bus reuses the identical zero-alloc scalar stamp:
    //         500k stamps under the tight SP5_POS ceiling, no major GC. Best-of-N so a lone
    //         stray JIT/GC bookkeeping allocation cannot nondeterministically trip the tight
    //         0.05 ceiling (the ceiling is unchanged; a real second code path allocates on
    //         every pass and its minimum still fails).
    const dpos = await buildDiscreteEngine(1);
    const dposH = dpos.handles[0];
    const dposRow = measurePositionBestOf(
        'T-SP4:setPosition',
        (n) => { dpos.audio.setPosition(dposH, n, n + 1, n - 1); },
        SP4_POS_OPS, SP4_POS_WARMUP, POS_BEST_OF,
    );
    process.stderr.write('T-SP4 (c) setPosition on a discrete bus (' + SP4_POS_OPS + ' scalar stamps, best of ' + POS_BEST_OF + '):\n');
    process.stderr.write(fmt(dposRow) + '\n');
    if (!dposRow.noMajor) {
        die('T-SP4: setPosition (discrete bus) ' + dposRow.major + ' major GC / maxMs ' +
            dposRow.maxMs.toFixed(3) + ' violates ' + JSON.stringify(RULES));
    }
    if (!(dposRow.bytesPerOp <= SP5_POS_MAX_BYTES_PER_OP)) {
        die('T-SP4: setPosition on a discrete bus measured ' + dposRow.bytesPerOp.toFixed(4) +
            ' bytes/op, over the ' + SP5_POS_MAX_BYTES_PER_OP + ' ceiling -- the discrete family did ' +
            'NOT reuse the zero-alloc scalar stamp (a second position code path).');
    }
    dpos.audio.destroy();

    // 12) T-SP3-lane (S6/S7): the VBAP solver + data-driven flush at ALL THREE widths
    //     (8/6/4 lanes for 7.1/5.1/3.1). The 6- and 4-lane reductions ride the SAME
    //     _vbapSolve + _flushLanes as 8-lane, so each ships (a) a write-count + LFE-
    //     invariance check, (b) a 500k-op zero-alloc GC-budget tier, and (c) an SP-03
    //     native-event-rate tier, plus a shared retention sub-tier (d).

    //     (a) exactly `lanes` writes/voice/flush; LANE_LFE (index 3) receives exactly 1,
    //         azimuth-invariant (0 VBAP-derived values); the ring lanes carry azimuth-
    //         dependent VBAP gains. Counted on the recording mock lane params, at each width.
    for (let p = 0; p < SP3_LANE_PRESETS.length; p++) {
        const preset = SP3_LANE_PRESETS[p][0], laneCount = SP3_LANE_PRESETS[p][1], maxCh = SP3_LANE_PRESETS[p][2];
        const lw = await buildDiscreteEngine(1, preset, maxCh);
        const lwH = lw.handles[0];
        lw.audio.setPosition(lwH, 0, 0, -1);              // hard front (az 0 -> center)
        lw.audio._flushLanes();
        const lwLanes = lw.busRec.pool.voiceNode(lwH >>> 0);
        if (lwLanes === null) die('T-SP3-lane[' + preset + ']: voice went stale before the write-count check');
        let laneBad = 0;
        for (let k = 0; k < laneCount; k++) {
            let n = 0;
            const ev = lwLanes[k].gain.events;
            for (let j = 0; j < ev.length; j++) if (ev[j][0] === 'target') n++;
            if (n !== 1) laneBad++;
        }
        const lfeFront = lwLanes[3].gain.value;          // LANE_LFE after the front flush
        lw.audio.setPosition(lwH, 1, 0, 0);              // hard right (az 90)
        lw.audio._flushLanes();
        const lfeRight = lwLanes[3].gain.value;          // LANE_LFE after a DIFFERENT azimuth
        const ringMoved = lwLanes[1].gain.value !== 0;   // R lane now live at any preset
        process.stderr.write('T-SP3-lane (a) [' + preset + ' / ' + laneCount + ' lanes] write-count: ' +
            (laneCount - laneBad) + '/' + laneCount + ' lanes wrote exactly once/flush; ' +
            'LFE(idx3)=' + lfeFront.toFixed(4) + ' front / ' + lfeRight.toFixed(4) + ' right (azimuth-invariant)\n');
        if (laneBad !== 0) {
            die('T-SP3-lane[' + preset + ']: ' + laneBad + ' lane(s) did not receive exactly one write per flush -- ' +
                'the ' + laneCount + '-write-per-voice-per-flush contract broke.');
        }
        if (!(lfeFront !== 0 && lfeFront === lfeRight)) {
            die('T-SP3-lane[' + preset + ']: LANE_LFE is not an azimuth-invariant distance-only send (front=' +
                lfeFront + ', right=' + lfeRight + ') -- LFE must carry exactly one distance-only send.');
        }
        if (!ringMoved) {
            die('T-SP3-lane[' + preset + ']: the ring lanes did not change with azimuth -- the VBAP solve is not azimuth-dependent.');
        }
        lw.audio.destroy();
    }

    //     (b) GC budget: _flushLanes over SP3_LANE_VOICES voices, 500k measured ops, no
    //         major GC, under the 4.0 B/op ceiling -- AT EACH WIDTH. The recording mock
    //         param would swamp the figure (an event object per write, absent in
    //         production), so the lane params are swapped for non-recording stubs ONCE,
    //         outside the loop -- the measured allocation is then the engine's own (reused
    //         LANE_SCRATCH -> ~0). The red control swaps _vbapSolve for a fresh-Float32Array-
    //         per-solve variant; it is applied on the FIRST width (8-lane), which runs first.
    for (let p = 0; p < SP3_LANE_PRESETS.length; p++) {
        const preset = SP3_LANE_PRESETS[p][0], laneCount = SP3_LANE_PRESETS[p][1], maxCh = SP3_LANE_PRESETS[p][2];
        const applyRed = SP3_LANE_RED && p === 0;
        const lane = await buildDiscreteEngine(SP3_LANE_VOICES, preset, maxCh);
        for (let v = 0; v < SP3_LANE_VOICES; v++) lane.audio.setPosition(lane.handles[v], v, 0, -1);
        for (let v = 0; v < SP3_LANE_VOICES; v++) {
            const lanes = lane.busRec.pool.voiceNode(lane.handles[v] >>> 0);
            if (lanes === null) die('T-SP3-lane[' + preset + ']: voice ' + v + ' went stale before the GC measurement');
            for (let k = 0; k < laneCount; k++) {
                const g = { value: 0 };
                g.setTargetAtTime = (val) => { g.value = val; return g; };   // non-recording stub
                lanes[k].gain = g;
            }
        }
        if (applyRed) lane.audio._vbapSolve = redVbapSolveAlloc;
        const laneFlush = (i) => {
            for (let v = 0; v < SP3_LANE_VOICES; v++) lane.audio.setPosition(lane.handles[v], i + v, 0, -(v + 1));
            lane.audio._flushLanes();
        };
        const laneRow = (() => {
            let i = 0;
            const r = measureOps(() => laneFlush(i++), { ops: SP3_LANE_OPS, warmup: SP3_LANE_WARMUP, source: 'gc', stabilize: true });
            const report = checkNoGc(r.summary, RULES);
            return {
                label: (applyRed ? 'T-SP3-lane:RED[' : 'T-SP3-lane[') + preset + ']',
                bytesPerOp: r.bytesPerOp == null ? NaN : r.bytesPerOp,
                major: r.summary.gc.major, maxMs: r.summary.gc.maxMs, noMajor: report.ok,
            };
        })();
        process.stderr.write('T-SP3-lane (b) [' + preset + ' / ' + laneCount + ' lanes] _flushLanes over ' +
            SP3_LANE_VOICES + ' voices (' + SP3_LANE_OPS + ' ops):\n');
        process.stderr.write(fmt(laneRow) + '\n');
        if (applyRed) {
            if (!(laneRow.bytesPerOp >= SP3_LANE_RED_MIN_BYTES_PER_OP)) {
                die('SP3_LANE_RED: the fresh-Float32Array-per-solve control measured ' +
                    laneRow.bytesPerOp.toFixed(4) + ' bytes/op, below the ' + SP3_LANE_RED_MIN_BYTES_PER_OP +
                    ' floor -- the red control is not modelling the allocation it claims and cannot prove ' +
                    'this gate is falsifiable.');
            }
            die('SP3_LANE_RED: gated _flushLanes allocates a fresh Float32Array per solve (' +
                laneRow.bytesPerOp.toFixed(4) + ' bytes/op) -- rejecting as designed. This is the red ' +
                'control; a clean run does not take this branch.');
        }
        if (!laneRow.noMajor) {
            die('T-SP3-lane[' + preset + ']: ' + laneRow.major + ' major GC / maxMs ' + laneRow.maxMs.toFixed(3) +
                ' violates ' + JSON.stringify(RULES));
        }
        if (!(laneRow.bytesPerOp <= SP3_LANE_MAX_BYTES_PER_OP)) {
            die('T-SP3-lane[' + preset + ']: _flushLanes measured ' + laneRow.bytesPerOp.toFixed(4) + ' bytes/op, over the ' +
                SP3_LANE_MAX_BYTES_PER_OP + ' ceiling -- the ' + laneCount + '-lane solve/flush is allocating on the monitor path.');
        }
        lane.audio.destroy();
    }

    //     (c) SP-03 native-event bound on the lane params: SP3_LANE_VOICES voices x 100
    //         ticks, 6 stamps/tick + one flush/tick -> ~100 target events/lane/voice, cap
    //         200 -- AT EACH WIDTH. The red control (SP3_RATE_RED) writes the lanes directly
    //         at 60 Hz -> ~600; it is applied on the FIRST width (8-lane), which runs first.
    for (let p = 0; p < SP3_LANE_PRESETS.length; p++) {
        const preset = SP3_LANE_PRESETS[p][0], laneCount = SP3_LANE_PRESETS[p][1], maxCh = SP3_LANE_PRESETS[p][2];
        const applyRed = SP3_RATE_RED && p === 0;
        const rate = await buildDiscreteEngine(SP3_LANE_VOICES, preset, maxCh);
        const ratePool = rate.busRec.pool;
        if (applyRed) {
            const fpt = (SP3_LANE_RATE_RED_HZ / 10) | 0;    // 6 frames per ~10 Hz tick
            for (let t = 0; t < SP3_LANE_TICKS; t++) {
                const now = rate.ctx.currentTime;
                for (let f = 0; f < fpt; f++) {
                    for (let v = 0; v < SP3_LANE_VOICES; v++) {
                        const lanes = ratePool.voiceNode(rate.handles[v] >>> 0);
                        if (lanes === null) continue;
                        for (let k = 0; k < laneCount; k++) lanes[k].gain.setTargetAtTime(v, now, 0.02);
                    }
                }
            }
        } else {
            for (let t = 0; t < SP3_LANE_TICKS; t++) {
                for (let f = 0; f < SP3_LANE_FRAMES_PER_TICK; f++) {
                    for (let v = 0; v < SP3_LANE_VOICES; v++) rate.audio.setPosition(rate.handles[v], v + f, 0, -(f + 1));
                }
                rate.audio._flushLanes();                   // the ~10 Hz monitor flush
            }
        }
        let rateMax = 0;
        for (let v = 0; v < SP3_LANE_VOICES; v++) {
            const lanes = ratePool.voiceNode(rate.handles[v] >>> 0);
            if (lanes === null) die('T-SP3-lane[' + preset + '] rate: voice ' + v + ' went stale before counting');
            for (let k = 0; k < laneCount; k++) {
                let n = 0;
                const ev = lanes[k].gain.events;
                for (let j = 0; j < ev.length; j++) if (ev[j][0] === 'target') n++;
                if (n > rateMax) rateMax = n;
            }
        }
        process.stderr.write('T-SP3-lane (c) [' + preset + ' / ' + laneCount + ' lanes] ' +
            (applyRed ? '(RED: 60 Hz direct lane writer)' : '(10 Hz throttled flush)') +
            ': max lane target events/param = ' + rateMax + ' (cap ' + SP3_LANE_EVENT_CAP + ', expected ~' + SP3_LANE_TICKS + ')\n');
        if (!(rateMax <= SP3_LANE_EVENT_CAP)) {
            die('T-SP3-lane[' + preset + ']: ' + rateMax + ' lane target events/param exceeds the ' + SP3_LANE_EVENT_CAP +
                ' cap -- a per-frame lane writer is growing the native event list (SP-03).');
        }
        rate.audio.destroy();
    }

    //     (d) retention (S7): build/teardown each preset SP3_LANE_CYCLES times on a running
    //         context (no unlock pulse). destroy() must null the per-bus scratch AND the
    //         frozen vbap record, restore the pristine destination triple VERBATIM, and
    //         leave no live source node (census delta 0). A lite-leak witness is untracked
    //         ONLY on that full proof, so a teardown that stops releasing any of them leaves
    //         the ledger nonzero. Sentinels are pinned so size() is a deterministic ledger.
    const laneTracker = createLeakTracker({ name: 'lite-audio-discrete-soak' });
    const LANE_NOOP = () => {};
    const laneKept = [];
    let laneTripleBad = 0, laneCensusBad = 0;
    const totalLaneCycles = SP3_LANE_CYCLES * SP3_LANE_PRESETS.length;
    for (let c = 0; c < SP3_LANE_CYCLES; c++) {
        for (let p = 0; p < SP3_LANE_PRESETS.length; p++) {
            const preset = SP3_LANE_PRESETS[p][0], maxCh = SP3_LANE_PRESETS[p][2];
            let cyc;
            try {
                cyc = await buildDiscreteEngine(SP3_LANE_RETENTION_VOICES, preset, maxCh, true);
            } catch (err) {
                die('T-SP3-lane retention: build cycle ' + c + '/' + preset + ' threw (' +
                    (err && err.message || err) + ') -- a teardown that stops releasing its lite-signal ' +
                    'nodes exhausts the shared pool.');
            }
            for (let v = 0; v < SP3_LANE_RETENTION_VOICES; v++) cyc.audio.setPosition(cyc.handles[v], v, 0, -(v + 1));
            cyc.audio._flushLanes();                     // real lane writes onto the voices
            const busRec = cyc.busRec;
            const dest = cyc.ctx.destination;
            const sentinel = { cycle: c, preset };
            laneKept.push(sentinel);
            const witness = laneTracker.track(sentinel, LANE_NOOP, preset + c);
            cyc.audio.destroy();
            // Triple restored VERBATIM to the pristine pre-discrete mock defaults (2 / max /
            // speakers), NOT a zeroed triple and NOT the discrete override.
            const tripleOk = dest.channelCount === 2 && dest.channelCountMode === 'max' &&
                dest.channelInterpretation === 'speakers';
            if (!tripleOk) laneTripleBad++;
            // Census: every pooled voice stopped by pool.destroy(), so the live source-node
            // count returns to the pre-play baseline (0 on a running context).
            if (cyc.ctx._liveNodes() !== cyc.baseline) laneCensusBad++;
            if (busRec.lanes === 0 && busRec.vbap === null && busRec.posXYZ === null &&
                busRec.posOwner === null && busRec.posDirty === null && tripleOk) {
                laneTracker.untrack(witness);
            }
        }
    }
    if (laneKept.length !== totalLaneCycles) die('T-SP3-lane retention: internal -- pinned ' + laneKept.length + ' of ' + totalLaneCycles);
    const laneLeaked = laneTracker.size();
    process.stderr.write('T-SP3-lane (d) retention: ' + totalLaneCycles + ' build/teardown cycles x {7.1,5.1,3.1}; ' +
        'lite-leak witnessed ' + laneLeaked + ' un-released bus record(s), ' + laneTripleBad +
        ' triple-restore miss(es), ' + laneCensusBad + ' census delta(s) (expected 0/0/0)\n');
    if (laneTripleBad !== 0) {
        die('T-SP3-lane retention: ' + laneTripleBad + ' teardown(s) did NOT restore the pristine destination ' +
            'triple -- destroy() must write back the saved pre-discrete channelCount/mode/interpretation verbatim.');
    }
    if (laneCensusBad !== 0) {
        die('T-SP3-lane retention: ' + laneCensusBad + ' teardown(s) left a live source node (census delta != 0) -- ' +
            'pool.destroy() must stop every voice.');
    }
    if (laneLeaked !== 0) {
        die('T-SP3-lane retention: lite-leak witnessed ' + laneLeaked + ' discrete bus record(s) still holding ' +
            'posXYZ/posOwner/posDirty scratch or the vbap record after destroy() -- a teardown leak.');
    }

    // 13) T-SP7 (PS1): destroyBus -- individual dynamic-bus teardown.
    //     (a) contract + node census on a discrete bus (the richest teardown: a
    //         live pool, posXYZ scratch, a _discreteBuses registration and a vbap
    //         record). destroyBus returns true; a second call returns false; the
    //         pooled voices are STOPPED (live source-node census returns to the
    //         pre-play baseline); the husk is pulled out of _discreteBuses; the
    //         _busList slot is KEPT (length unchanged) as an inert husk that
    //         _flushLanes/_flushPositions skip; the NEXT createBus appends (index
    //         == old length). The red control leaves the pool live + the husk in
    //         the lane flush, so the census stays > baseline and the gate rejects.
    const sp7 = await buildDiscreteEngine(SP7_CENSUS_VOICES, '7.1', 8, true);
    const sp7Busrec = sp7.busRec;
    const sp7ListLen = sp7.audio._busList.length;
    const sp7ArmedLive = sp7.ctx._liveNodes();
    if (sp7ArmedLive < 1) die('T-SP7: no live voices before destroyBus -- census would be vacuous');

    let sp7Ret;
    if (DESTROYBUS_RED) {
        sp7Ret = redDestroyBus(sp7.audio, 'surr');
        // Drive the lane flush the husk was NOT pulled from: the retained pool's
        // voices keep being written and stay live -- exactly the leak the swap-pop
        // exists to prevent.
        sp7.audio._flushLanes();
        sp7.audio._flushLanes();
    } else {
        sp7Ret = sp7.audio.destroyBus('surr');
    }
    const sp7AfterLive = sp7.ctx._liveNodes();
    const sp7CensusDelta = sp7AfterLive - sp7.baseline;
    const sp7Second = sp7.audio.destroyBus('surr');            // idempotent -> false
    // The tombstone is inert on the monitor: neither flush may throw over the husk.
    sp7.audio._flushLanes();
    sp7.audio._flushPositions();
    const sp7ListStable = sp7.audio._busList.length === sp7ListLen;
    const sp7Reindex = sp7.audio.createBus('surr2', {}).index === sp7ListLen;
    const sp7InDiscrete = sp7.audio._discreteBuses.indexOf(sp7Busrec) !== -1;

    process.stderr.write('T-SP7 (a) destroyBus contract + census ' +
        (DESTROYBUS_RED ? '(RED: swap-pop skipped, pool left live)' : '') +
        ': returned=' + sp7Ret + ' second=' + sp7Second +
        ' armed-live=' + sp7ArmedLive + ' -> after-live=' + sp7AfterLive +
        ' (baseline ' + sp7.baseline + ', delta ' + sp7CensusDelta + ')' +
        ' _busList stable=' + sp7ListStable + ' reindex=' + sp7Reindex +
        ' husk-in-discrete=' + sp7InDiscrete + '\n');

    if (DESTROYBUS_RED) {
        if (sp7CensusDelta === 0) {
            die('DESTROYBUS_RED: the swap-pop-skipping teardown left the census clean (delta 0) -- ' +
                'the red control is no longer modelling the leak it claims and cannot prove this gate ' +
                'is falsifiable.');
        }
        die('DESTROYBUS_RED: destroyBus skipped the _discreteBuses swap-pop and left the pool live, ' +
            'so ' + sp7CensusDelta + ' voice(s) still sound on the tombstoned husk (census ' + sp7AfterLive +
            ' vs baseline ' + sp7.baseline + ') -- rejecting as designed. This is the red control; a ' +
            'clean run does not take this branch.');
    }
    if (sp7Ret !== true) die('T-SP7: destroyBus on a live dynamic discrete bus returned ' + sp7Ret + ' (expected true).');
    if (sp7Second !== false) die('T-SP7: a second destroyBus returned ' + sp7Second + ' (expected false, idempotent).');
    if (sp7CensusDelta !== 0) {
        die('T-SP7: after destroyBus the live source-node census is ' + sp7AfterLive + ' vs baseline ' +
            sp7.baseline + ' (delta ' + sp7CensusDelta + ') -- pool.destroy() must stop every voice on the bus.');
    }
    if (!sp7ListStable) die('T-SP7: destroyBus changed _busList.length (tombstone must keep the slot -- never splice).');
    if (!sp7Reindex) die('T-SP7: the next createBus did not append at index == old _busList.length (a hole was filled).');
    if (sp7InDiscrete) die('T-SP7: the destroyed bus is still registered in _discreteBuses -- the swap-pop did not run.');
    if (!sp7Busrec.dead || sp7Busrec.pool !== null) {
        die('T-SP7: the tombstone is not fully hollowed (dead=' + sp7Busrec.dead + ', pool=' + sp7Busrec.pool + ').');
    }
    sp7.audio.destroy();

    //     (b) 4096-cycle create/destroyBus soak: retention + GC budget. A persistent
    //         engine churns the five presets create/destroyBus; destroyBus disposes
    //         each bus's per-bus signals + write effect (so the shared lite-signal
    //         node pool is NOT exhausted over the soak), disarms the widener, and
    //         deregisters the discrete husk. A lite-leak witness is untracked ONLY on
    //         proof the record is a hollowed tombstone (dead + pool null + scratch
    //         null), so a teardown that stops releasing leaves the ledger nonzero.
    //         The same churn runs under a GcProfiler: maxMajor 0, maxPauseMs <= 4.
    const sp7Ctx = createMockContext({ state: 'running', maxChannelCount: 8 });
    const sp7Win = {
        navigator: { userAgent: 'node-torture-gate', maxTouchPoints: 0 },
        addEventListener: () => {}, removeEventListener: () => {},
    };
    const sp7Audio = new LiteAudio({
        poolCapacity: 4, window: sp7Win, document: mockDocument(), fetch: mockFetch({}),
        setTimeout: () => 0, clearTimeout: () => {},
    });
    await sp7Audio.init(sp7Ctx);

    const sp7Tracker = createLeakTracker({ name: 'lite-audio-destroybus-soak' });
    const SP7_NOOP = () => {};
    const sp7Kept = [];
    let sp7Undead = 0;
    const sp7BaseList = sp7Audio._busList.length;
    for (let c = 0; c < SP7_CYCLES; c++) {
        const preset = SP7_PRESETS[c % SP7_PRESETS.length];
        const bn = 'churn' + c;                             // unique name -> a fresh husk each cycle
        const rec = sp7Audio.createBus(bn, preset[1]);
        const sentinel = { cycle: c };
        sp7Kept.push(sentinel);
        const witness = sp7Tracker.track(sentinel, SP7_NOOP, c);
        const ok = sp7Audio.destroyBus(bn);
        // Untrack ONLY on the full teardown proof: destroyBus returned true, the
        // record is a hollowed tombstone, and it is gone from _buses/_discreteBuses.
        if (ok && rec.dead && rec.pool === null && rec.posXYZ === null &&
            rec.vbap === null && rec.wideIn === null &&
            !sp7Audio._buses.has(bn) && sp7Audio._discreteBuses.indexOf(rec) === -1) {
            sp7Tracker.untrack(witness);
        } else {
            sp7Undead++;
        }
    }
    if (sp7Kept.length !== SP7_CYCLES) die('T-SP7: internal -- pinned ' + sp7Kept.length + ' of ' + SP7_CYCLES);
    const sp7Leaked = sp7Tracker.size();
    // The husks tombstone in place: _busList grew by exactly SP7_CYCLES, every slot kept.
    const sp7Grew = sp7Audio._busList.length - sp7BaseList;

    // GC budget over a fresh churn window on a FRESH engine (isolated from the
    // retention loop's retained tombstones + tracking allocation, so the measured
    // GC behaviour is the create/destroyBus pair's alone). stabilize:true anchors a
    // forced-GC live-set baseline before the steady window -- the same discipline
    // every measured tier in this file uses -- so warmup churn is not counted; the
    // steady phase must fire NO major GC and hold pauses under maxPauseMs. bytesPerOp
    // is NOT gated: the tombstone legitimately retains one husk per cycle by design
    // (R2), which is exactly the per-op retained growth this figure reports.
    const sp7GcCtx = createMockContext({ state: 'running', maxChannelCount: 8 });
    const sp7GcAudio = new LiteAudio({
        poolCapacity: 4, window: sp7Win, document: mockDocument(), fetch: mockFetch({}),
        setTimeout: () => 0, clearTimeout: () => {},
    });
    await sp7GcAudio.init(sp7GcCtx);
    const sp7GcBase = sp7GcAudio._busList.length;
    const sp7GcRow = (() => {
        const r = measureOps((n) => {
            const preset = SP7_PRESETS[n % SP7_PRESETS.length];
            const bn = 'gc' + n;
            sp7GcAudio.createBus(bn, preset[1]);
            sp7GcAudio.destroyBus(bn);
        }, { ops: SP7_CYCLES, warmup: 256, source: 'gc', stabilize: true });
        return { summary: r.summary, noMajor: checkNoGc(r.summary, RULES).ok, bpo: r.bytesPerOp };
    })();
    const sp7Summary = sp7GcRow.summary;
    const sp7GcReport = { ok: sp7GcRow.noMajor };
    const sp7GcGrew = sp7GcAudio._busList.length - sp7GcBase;

    process.stderr.write('T-SP7 (b) create/destroyBus soak (' + SP7_CYCLES + ' cycles x {stereo,positional,' +
        'hrtf,width,discrete}): lite-leak witnessed ' + sp7Leaked + ' un-released bus record(s), ' +
        sp7Undead + ' incomplete teardown(s); _busList tombstoned +' + sp7Grew + ' husk(s) (all slots kept) | ' +
        'gc major=' + sp7Summary.gc.major + ' minor=' + sp7Summary.gc.minor +
        ' maxMs=' + sp7Summary.gc.maxMs.toFixed(2) + ' (+' + sp7GcGrew + ' husks, ' +
        (Number.isFinite(sp7GcRow.bpo) ? sp7GcRow.bpo.toFixed(0) : 'null') + ' B/op tombstone)\n');

    if (sp7Undead !== 0) {
        die('T-SP7: ' + sp7Undead + ' create/destroyBus cycle(s) did not leave a hollowed tombstone -- ' +
            'destroyBus must null the pool + scratch, disarm the widener and deregister the husk.');
    }
    if (sp7Leaked !== 0) {
        die('T-SP7: lite-leak witnessed ' + sp7Leaked + ' bus record(s) still un-released after ' +
            SP7_CYCLES + ' create/destroyBus cycles -- a teardown leak the bytesPerOp gate cannot see.');
    }
    if (sp7Grew !== SP7_CYCLES) {
        die('T-SP7: _busList grew by ' + sp7Grew + ' over ' + SP7_CYCLES + ' cycles (expected ' + SP7_CYCLES +
            ') -- destroyBus must TOMBSTONE the slot in place, never splice and never reuse it.');
    }
    if (!sp7GcReport.ok) {
        die('T-SP7: the create/destroyBus soak violated ' + JSON.stringify(RULES) + ' (major=' +
            sp7Summary.gc.major + ', maxMs=' + sp7Summary.gc.maxMs.toFixed(2) + ') -- destroyBus is ' +
            'allocating or forcing a major GC on the churn path.');
    }
    sp7Audio.destroy();
    sp7GcAudio.destroy();

    // 14) T-SP8 (PS2): monitor idle refcount / sleep-wake. The tick evaluates a
    //     cold _monitorIdle() predicate at its tail and skips the reschedule when
    //     no consumer is live. This tier is the only one in the file wired to a
    //     REAL mockScheduler (buildIdleEngine) -- the whole subject here IS the
    //     scheduling, so a no-op setTimeout would make it vacuous.

    //     (a) awake with a live consumer of every removable type -- metered,
    //         positional (pool built), discrete, width -- flush() x10: the tick
    //         keeps firing and never double-arms (pending() stays exactly 1).
    const sp8 = await buildIdleEngine();
    sp8.audio.createBus('idleMeter', { meter: true });
    sp8.audio.createBus('idlePos', { spatial: 'positional' });
    sp8.audio.createBus('idleDisc', { spatial: 'discrete', preset: '7.1' });
    sp8.audio.createBus('idleWidth', { width: 0.5 });
    await sp8.audio.defineSounds({
        idlePosSnd: { src: ['/s.wav'], bus: 'idlePos' },
        idleDiscSnd: { src: ['/s.wav'], bus: 'idleDisc' },
        idleWidthSnd: { src: ['/s.wav'], bus: 'idleWidth' },
    });
    await flushMicrotasks(8);

    if (sp8.audio._monitorIdle()) {
        die('T-SP8 (a): setup -- the engine reports idle with 4 live consumer types armed.');
    }
    // Tick counter: _retireHrtfWarm runs FIRST, unconditionally, in every tick
    // (Audio.js :2381), so wrapping it counts ticks precisely without perturbing
    // the scheduling it is wrapping.
    const sp8OrigRetire = sp8.audio._retireHrtfWarm.bind(sp8.audio);
    let sp8TickCount = 0;
    sp8.audio._retireHrtfWarm = () => { sp8TickCount++; sp8OrigRetire(); };

    for (let i = 0; i < 10; i++) {
        sp8.clock.flush();
        if (sp8.audio._monitorTimer === null) die('T-SP8 (a): the monitor slept at flush ' + i + ' with 4 live consumers.');
        if (sp8.clock.pending() !== 1) {
            die('T-SP8 (a): pending()=' + sp8.clock.pending() + ' at flush ' + i + ' (expected exactly 1 -- R3 double-arm guard).');
        }
    }
    if (sp8TickCount !== 10) die('T-SP8 (a): tick counter=' + sp8TickCount + ' after 10 flushes (expected 10).');
    process.stderr.write('T-SP8 (a) awake with metered+positional+discrete+width live: ' +
        sp8TickCount + '/10 ticks fired, pending()==1 every flush\n');

    //     (b) sleeps at zero: destroyBus every dynamic consumer + disableAutoSuspend();
    //         one more flush() -> monitorTimer===null, pending()===0; flush() x10 more
    //         -> tick counter FROZEN (A3/A4: a slept monitor cannot resurrect itself).
    sp8.audio.destroyBus('idleMeter');
    sp8.audio.destroyBus('idlePos');
    sp8.audio.destroyBus('idleDisc');
    sp8.audio.destroyBus('idleWidth');
    sp8.audio.disableAutoSuspend();

    sp8.clock.flush();
    if (sp8.audio._monitorTimer !== null) die('T-SP8 (b): monitorTimer is not null after the sleep flush.');
    if (sp8.clock.pending() !== 0) die('T-SP8 (b): pending()=' + sp8.clock.pending() + ' after the sleep flush (expected 0).');
    const sp8TickAtSleep = sp8TickCount;
    for (let i = 0; i < 10; i++) sp8.clock.flush();
    if (sp8TickCount !== sp8TickAtSleep) {
        die('T-SP8 (b): tick counter moved (' + sp8TickAtSleep + ' -> ' + sp8TickCount + ') across 10 flushes on a ' +
            'slept monitor -- a slept monitor must not resurrect itself.');
    }
    if (sp8.audio._monitorTimer !== null) die('T-SP8 (b): monitorTimer is not null after the frozen flushes.');
    process.stderr.write('T-SP8 (b) sleeps at zero: monitorTimer=null, pending=0, tick counter frozen at ' +
        sp8TickCount + ' across 10 further flushes\n');

    //     (c) wakes: createBus('m',{meter:true}) -> monitorTimer!==null immediately,
    //         ticks resume (A5).
    sp8.audio.createBus('m', { meter: true });
    if (sp8.audio._monitorTimer === null) die('T-SP8 (c): monitorTimer is null immediately after createBus (expected an immediate wake).');
    if (sp8.clock.pending() !== 1) die('T-SP8 (c): pending()=' + sp8.clock.pending() + ' immediately after the wake (expected 1).');
    const sp8TickAtWake = sp8TickCount;
    for (let i = 0; i < 3; i++) {
        sp8.clock.flush();
        if (sp8.clock.pending() !== 1) die('T-SP8 (c): pending()=' + sp8.clock.pending() + ' at flush ' + i + ' after waking (expected 1).');
    }
    if (sp8TickCount - sp8TickAtWake !== 3) {
        die('T-SP8 (c): tick counter advanced by ' + (sp8TickCount - sp8TickAtWake) + ' over 3 flushes after waking (expected 3).');
    }
    process.stderr.write('T-SP8 (c) wakes: createBus re-armed the monitor immediately, ' +
        (sp8TickCount - sp8TickAtWake) + '/3 ticks resumed\n');
    sp8.audio.destroy();

    //     (d) census/retention: SP8_CYCLES = 4096 create-consumer -> tick ->
    //         destroy-consumer -> tick-to-sleep -> wake (next cycle's createBus)
    //         cycles -> tracker.size()===0, live-node census delta 0, pending()
    //         ends 0 (A11, mirrors T-SP7's SP7_CYCLES = 4096).
    const sp8D = await buildIdleEngine();
    const sp8Tracker = createLeakTracker({ name: 'lite-audio-idle-soak' });
    const SP8_NOOP = () => {};
    const sp8Kept = [];
    let sp8Undead = 0;
    const sp8Baseline = sp8D.ctx._liveNodes();
    if (sp8D.audio._monitorTimer !== null) die('T-SP8 (d): setup -- a fresh engine must never be armed.');

    for (let c = 0; c < SP8_CYCLES; c++) {
        const preset = SP8_PRESETS[c % SP8_PRESETS.length];
        const bn = 'sp8census' + c;
        if (sp8D.audio._monitorTimer !== null) {
            die('T-SP8 (d): cycle ' + c + ' -- monitor was already armed BEFORE createBus (a prior cycle left it awake).');
        }
        // create-consumer: the WAKE step for this cycle.
        const rec = sp8D.audio.createBus(bn, preset[1]);
        if (sp8D.audio._monitorTimer === null) die('T-SP8 (d): cycle ' + c + ' -- createBus did not wake the monitor.');
        // tick: the cycle's own consumer is still live, so the monitor must stay armed.
        sp8D.clock.flush();
        if (sp8D.audio._monitorTimer === null) {
            die('T-SP8 (d): cycle ' + c + ' -- the monitor slept while the cycle\'s own consumer was still live.');
        }
        const sentinel = { cycle: c };
        sp8Kept.push(sentinel);
        const witness = sp8Tracker.track(sentinel, SP8_NOOP, c);
        // destroy-consumer.
        const ok = sp8D.audio.destroyBus(bn);
        if (ok && rec.dead) { sp8Tracker.untrack(witness); } else { sp8Undead++; }
        // tick-to-sleep: no other consumer survives this cycle, so the very next
        // tick sleeps -- proving A3/A4's exact-sleep observable on every cycle.
        sp8D.clock.flush();
        if (sp8D.audio._monitorTimer !== null) {
            die('T-SP8 (d): cycle ' + c + ' -- the monitor did not sleep after its only consumer was destroyed.');
        }
        if (sp8D.clock.pending() !== 0) die('T-SP8 (d): cycle ' + c + ' -- pending()=' + sp8D.clock.pending() + ' after sleeping (expected 0).');
    }
    if (sp8Kept.length !== SP8_CYCLES) die('T-SP8: internal -- pinned ' + sp8Kept.length + ' of ' + SP8_CYCLES);
    const sp8Leaked = sp8Tracker.size();
    const sp8AfterLive = sp8D.ctx._liveNodes();
    const sp8LiveDelta = sp8AfterLive - sp8Baseline;
    process.stderr.write('T-SP8 (d) census/retention: ' + SP8_CYCLES + ' create/tick/destroy/tick-to-sleep/wake ' +
        'cycles -- lite-leak witnessed ' + sp8Leaked + ' un-released record(s), ' + sp8Undead + ' incomplete ' +
        'teardown(s), live-node delta ' + sp8LiveDelta + ', pending()=' + sp8D.clock.pending() + ' (all expected 0)\n');
    if (sp8Undead !== 0) die('T-SP8: ' + sp8Undead + ' cycle(s) did not leave a hollowed tombstone.');
    if (sp8Leaked !== 0) die('T-SP8: lite-leak witnessed ' + sp8Leaked + ' un-released record(s) after ' + SP8_CYCLES + ' cycles.');
    if (sp8LiveDelta !== 0) die('T-SP8: live-node census delta ' + sp8LiveDelta + ' after ' + SP8_CYCLES + ' cycles (expected 0).');
    if (sp8D.clock.pending() !== 0) die('T-SP8: pending()=' + sp8D.clock.pending() + ' at the end of the census soak (expected 0).');
    sp8D.audio.destroy();

    //     (e) auto-suspend integrity (A8/A9, the Q5/ruling-3b sharp edge). Auto-
    //         suspend as the ONLY consumer must stay armed on EVERY tick until the
    //         countdown matures; it sleeps the instant it self-suspends (D4: sleep
    //         and self-suspend are decided inside the SAME tick, since
    //         _evalAutoSuspend sets _selfSuspended synchronously before this same
    //         tick's own _monitorIdle() check reads it); play() (T4) wakes it again.
    //         SP8_RED swaps in a predicate that omits the auto-suspend clause: the
    //         monitor sleeps on the FIRST tick (before the countdown can mature),
    //         _evalAutoSuspend is never reached again, and isAutoSuspended() never
    //         becomes true -- the gate must reject.
    const sp8E = await buildIdleEngine({ buses: ['sfx'] });
    await sp8E.audio.defineSounds({ ping: { src: ['/s.wav'], bus: 'sfx' } });
    await flushMicrotasks(8);
    if (sp8E.audio._monitorTimer !== null) die('T-SP8 (e): setup -- a plain stereo bus must not arm the monitor.');

    if (SP8_RED) sp8E.audio._monitorIdle = redMonitorIdleNoAutoSuspend;

    sp8E.audio.enableAutoSuspend({ after: 0.5 });
    if (sp8E.audio._monitorTimer === null) die('T-SP8 (e): enableAutoSuspend did not arm the monitor.');

    let sp8Matured = false;
    for (let i = 0; i < 40 && !sp8Matured; i++) {
        sp8E.ctx._advance(0.05);
        sp8E.clock.flush();
        if (sp8E.audio.isAutoSuspended()) { sp8Matured = true; break; }
        if (sp8E.audio._monitorTimer === null) {
            die('T-SP8 (e): the monitor slept at tick ' + i + ' while the auto-suspend countdown was still live ' +
                '(A8/Q5 -- a live countdown must never sleep out from under itself).' +
                (SP8_RED ? ' SP8_RED: the auto-suspend clause is missing from _monitorIdle.' : ''));
        }
    }
    if (!sp8Matured) {
        die('T-SP8 (e): auto-suspend never matured within 40 ticks -- isAutoSuspended() stuck at false' +
            (SP8_RED ? ' (SP8_RED: the monitor slept mid-countdown, so _evalAutoSuspend never ran again to ' +
                'mature it -- the context was never suspended).' : '.'));
    }
    if (sp8E.audio._monitorTimer !== null) die('T-SP8 (e): the monitor did not sleep on the very tick it self-suspended (ruling 3b).');
    process.stderr.write('T-SP8 (e) auto-suspend integrity' + (SP8_RED ? ' (RED: auto-suspend clause omitted)' : '') +
        ': stayed armed through the whole countdown, isAutoSuspended()=' + sp8E.audio.isAutoSuspended() +
        ', slept the instant it self-suspended\n');

    const sp8Handle = sp8E.audio.play('ping');
    if (sp8Handle < 0) die('T-SP8 (e): T4 wake setup -- play() returned a skip sentinel.');
    if (sp8E.audio._selfSuspended !== false) die('T-SP8 (e): play() did not clear _selfSuspended (T4).');
    if (sp8E.audio._monitorTimer === null) die('T-SP8 (e): play() did not re-arm the monitor from a self-suspended+slept state (T4).');
    process.stderr.write('T-SP8 (e) T4 wake: play() from self-suspended+slept -> _selfSuspended=false, monitorTimer!=null\n');
    sp8E.audio.destroy();

    //     (f) allocation: _monitorIdle() over SP8_OPS=500,000 calls on a 4-bus
    //         engine (1 metered + 1 positional + 1 width + 1 tombstone husk), no
    //         major GC, <= SP8_MAX_BYTES_PER_OP=0.05 B/op (the tight positional
    //         ceiling -- the predicate does no setTargetAtTime, so anything above
    //         noise is an allocation) (A10).
    const sp8F = await buildIdleEngine();
    sp8F.audio.createBus('sp8fMeter', { meter: true });
    sp8F.audio.createBus('sp8fPos', { spatial: 'positional' });
    sp8F.audio.createBus('sp8fWidth', { width: 0.5 });
    await sp8F.audio.defineSounds({
        sp8fPosSnd: { src: ['/s.wav'], bus: 'sp8fPos' },
        sp8fWidthSnd: { src: ['/s.wav'], bus: 'sp8fWidth' },
    });
    await flushMicrotasks(8);
    sp8F.audio.createBus('sp8fHusk');
    sp8F.audio.destroyBus('sp8fHusk');
    if (sp8F.audio._monitorIdle()) die('T-SP8 (f): setup -- the 4-bus measurement engine reports idle.');

    const sp8FRow = (() => {
        const r = measureOps(() => { sink = sp8F.audio._monitorIdle() ? 1 : 0; },
            { ops: SP8_OPS, warmup: 50_000, source: 'gc', stabilize: true });
        const report = checkNoGc(r.summary, RULES);
        return {
            label: 'T-SP8:_monitorIdle', bytesPerOp: r.bytesPerOp == null ? NaN : r.bytesPerOp,
            major: r.summary.gc.major, maxMs: r.summary.gc.maxMs, noMajor: report.ok,
        };
    })();
    process.stderr.write('T-SP8 (f) _monitorIdle() allocation (' + SP8_OPS +
        ' calls, 4-bus engine: 1 metered+1 positional+1 width+1 husk):\n');
    process.stderr.write(fmt(sp8FRow) + '\n');
    if (!sp8FRow.noMajor) {
        die('T-SP8: _monitorIdle() ' + sp8FRow.major + ' major GC / maxMs ' + sp8FRow.maxMs.toFixed(3) +
            ' violates ' + JSON.stringify(RULES));
    }
    if (!(sp8FRow.bytesPerOp <= SP8_MAX_BYTES_PER_OP)) {
        die('T-SP8: _monitorIdle() measured ' + sp8FRow.bytesPerOp.toFixed(4) + ' bytes/op, over the ' +
            SP8_MAX_BYTES_PER_OP + ' ceiling -- the cold predicate is allocating.');
    }
    sp8F.audio.destroy();

    //     (g) PS4 duck-sleep (decisions/0013): duckOn as the SOLE consumer arms
    //         the monitor; removeDuckRule empties _duckRules and the NEXT flush
    //         sleeps it -- monitorTimer===null, pending 0, tick counter frozen
    //         across >=10 further flushes (A1, the PS4 win: a duckOn-only engine
    //         can finally idle-sleep). Then a retention loop of duckOn/
    //         removeDuckRule cycles, each with an ACTIVE dip so the
    //         stranded-target recovery write fires every cycle too, ends with
    //         _duckRules empty, a lite-leak witness of 0, and a flat live-node
    //         census delta (A2/A3).
    const sp8G = await buildIdleEngine({ buses: ['gTrig', 'gTarg'] });
    if (sp8G.audio._monitorTimer !== null) die('T-SP8 (g): setup -- a fresh engine must never be armed.');

    sp8G.audio.duckOn('gTrig', 'gTarg');
    if (sp8G.audio._monitorTimer === null) die('T-SP8 (g): duckOn as the sole consumer did not arm the monitor.');
    if (sp8G.audio._duckRules.length !== 1) die('T-SP8 (g): setup -- expected exactly one duck rule.');

    const sp8GOrigRetire = sp8G.audio._retireHrtfWarm.bind(sp8G.audio);
    let sp8GTickCount = 0;
    sp8G.audio._retireHrtfWarm = () => { sp8GTickCount++; sp8GOrigRetire(); };

    if (sp8G.audio.removeDuckRule('gTrig', 'gTarg') !== true) die('T-SP8 (g): removeDuckRule did not report success.');
    if (sp8G.audio._duckRules.length !== 0) die('T-SP8 (g): removeDuckRule did not empty _duckRules.');

    sp8G.clock.flush();
    if (sp8G.audio._monitorTimer !== null) die('T-SP8 (g): the next flush after removeDuckRule did not sleep the monitor.');
    if (sp8G.clock.pending() !== 0) die('T-SP8 (g): pending()=' + sp8G.clock.pending() + ' after the sleep flush (expected 0).');
    const sp8GTickAtSleep = sp8GTickCount;
    for (let i = 0; i < 10; i++) sp8G.clock.flush();
    if (sp8GTickCount !== sp8GTickAtSleep) {
        die('T-SP8 (g): tick counter moved (' + sp8GTickAtSleep + ' -> ' + sp8GTickCount + ') across 10 further ' +
            'flushes on a slept monitor -- a slept monitor must not resurrect itself.');
    }
    if (sp8G.clock.pending() !== 0) {
        die('T-SP8 (g): pending()=' + sp8G.clock.pending() + ' after 10 further flushes on a slept monitor (expected 0).');
    }
    process.stderr.write('T-SP8 (g) duck-sleep: duckOn as sole consumer armed the monitor; removeDuckRule emptied ' +
        '_duckRules and the next flush slept it -- monitorTimer=null, pending=0, tick counter frozen at ' +
        sp8GTickCount + ' across 10 further flushes\n');
    sp8G.audio.destroy();

    const SP8G_CYCLES = 100_000;
    const sp8GD = await buildIdleEngine({ buses: ['rTrig', 'rTarg'] });
    const sp8GTracker = createLeakTracker({ name: 'lite-audio-duck-sleep-retention' });
    const SP8G_NOOP = () => {};
    let sp8GUndead = 0;
    const sp8GBaseline = sp8GD.ctx._liveNodes();

    for (let c = 0; c < SP8G_CYCLES; c++) {
        sp8GD.audio.duckOn('rTrig', 'rTarg');
        const rule = sp8GD.audio._duckRules[sp8GD.audio._duckRules.length - 1];
        rule.active = true;   // simulate an active dip every cycle -- exercises the recovery write path too
        const sentinel = { cycle: c };
        const witness = sp8GTracker.track(sentinel, SP8G_NOOP, c);
        const ok = sp8GD.audio.removeDuckRule('rTrig', 'rTarg');
        if (ok && sp8GD.audio._duckRules.length === 0) { sp8GTracker.untrack(witness); } else { sp8GUndead++; }
    }
    if (sp8GD.audio._duckRules.length !== 0) {
        die('T-SP8 (g): retention -- _duckRules not empty after ' + SP8G_CYCLES + ' cycles.');
    }
    const sp8GLeaked = sp8GTracker.size();
    const sp8GAfterLive = sp8GD.ctx._liveNodes();
    const sp8GLiveDelta = sp8GAfterLive - sp8GBaseline;
    process.stderr.write('T-SP8 (g) retention: ' + SP8G_CYCLES + ' duckOn/removeDuckRule cycles (active dip each ' +
        'cycle) -- lite-leak witnessed ' + sp8GLeaked + ' un-released record(s), ' + sp8GUndead + ' incomplete ' +
        'removal(s), live-node delta ' + sp8GLiveDelta + ', _duckRules.length=' + sp8GD.audio._duckRules.length +
        ' (all expected 0)\n');
    if (sp8GUndead !== 0) die('T-SP8 (g): ' + sp8GUndead + ' cycle(s) did not fully remove their rule.');
    if (sp8GLeaked !== 0) die('T-SP8 (g): lite-leak witnessed ' + sp8GLeaked + ' un-released record(s) after ' + SP8G_CYCLES + ' cycles.');
    if (sp8GLiveDelta !== 0) die('T-SP8 (g): live-node census delta ' + sp8GLiveDelta + ' after ' + SP8G_CYCLES + ' cycles (expected 0).');
    sp8GD.audio.destroy();

    // 15) T-TRK1 (PS5): reloadTrack(name) -- error-state recovery for ONE music
    //     track, without a full defineTracks rebuild (decisions/0014). This is the
    //     FIRST torture tier to exercise defineTracks/reloadTrack at all (0 hits
    //     before this). Three things need proving: (a) A4 -- a track dumped to
    //     'error' by a REAL wire failure (a spent <audio> element re-sourced via a
    //     throwing createMediaElementSource) reaches 'ready' after reloadTrack via
    //     a FRESH element, escaping the one-MediaElementSource-per-element trap;
    //     (b) A2/A1 -- a TRK1_CYCLES-cycle force-error/reloadTrack retention loop
    //     ends with the lite-leak witness at 0 (each cycle's spent element fully
    //     released -- src dropped, load() called, 0 residual timeupdate/ended
    //     listeners, its graph nodes disconnected -- before the tracker untracks
    //     it), exactly one new element per cycle, and the four external signal
    //     objects holding IDENTITY (===) across EVERY cycle, not just a spot
    //     check; (c) a GC-budget window over the same churn holds maxMajor:0/
    //     maxPauseMs<=4 (bytesPerOp is NOT gated -- a fresh element+graph per
    //     cycle is allocation BY DESIGN, D4). The red control (TRK1_RED) swaps in
    //     a reloadTrack that skips the release/disconnect/null-out, so the
    //     tracker witness must grow and the gate must reject.

    //     (a) A4: wire-failure recovery.
    const trkWin = {
        navigator: { userAgent: 'node-torture-gate', maxTouchPoints: 0 },
        addEventListener: () => {}, removeEventListener: () => {},
    };
    const trkACtx = trkSourceTrackingCtx({ throwOnReuse: true });
    const trkASpentEl = mockAudioElement();
    trkACtx.createMediaElementSource(trkASpentEl);   // pre-poison: an earlier session already sourced this element
    const trkADoc = trkPoisonedThenFreshDocument(trkASpentEl);
    const trkAAudio = new LiteAudio({
        buses: ['music'], poolCapacity: 4, window: trkWin, document: trkADoc, fetch: mockFetch({}),
        setTimeout: () => 0, clearTimeout: () => {},
    });
    await trkAAudio.init(trkACtx);
    await trkAAudio.defineTracks({ theme: { src: ['/theme.mp3'], bus: 'music' } });
    if (trkAAudio.trackLoadState('theme').peek() !== 'ready') {
        die('T-TRK1 (a): setup -- load did not settle ready before the wire-failure play.');
    }
    if (trkAAudio._tracks.get('theme').element !== trkASpentEl) {
        die('T-TRK1 (a): setup -- the poisoned document did not hand back the pre-spent element first.');
    }
    trkAAudio.playTrack('theme');   // first wire attempt: throws inside _wireTrackGraph -> caught -> 'error'
    if (trkAAudio.trackLoadState('theme').peek() !== 'error') {
        die('T-TRK1 (a): setup -- the wire failure did not fail the track closed to \'error\'.');
    }
    const trkALoadStateBefore = trkAAudio.trackLoadState('theme');
    const trkAReloaded = trkAAudio.reloadTrack('theme');
    if (trkAReloaded !== true) die('T-TRK1 (a): reloadTrack on the wire-failed track returned ' + trkAReloaded + ' (expected true).');
    const trkAFreshEl = trkAAudio._tracks.get('theme').element;
    if (trkAFreshEl === trkASpentEl) die('T-TRK1 (a): reloadTrack reused the spent element instead of building a fresh one.');
    if (trkAAudio.trackLoadState('theme').peek() !== 'ready') {
        die('T-TRK1 (a): the fresh element did not reach \'ready\' (still trapped by the spent element).');
    }
    if (trkAAudio.trackLoadState('theme') !== trkALoadStateBefore) {
        die('T-TRK1 (a): loadState signal identity changed across reload (A1).');
    }
    trkAAudio.playTrack('theme');   // prove the fresh element really wires and plays
    if (trkAAudio.trackLoadState('theme').peek() !== 'ready' || trkAAudio.trackPlaying('theme').peek() !== true) {
        die('T-TRK1 (a): the fresh element did not wire and play after reload.');
    }
    process.stderr.write('T-TRK1 (a) wire-failure recovery: a spent element failed the track closed to \'error\', ' +
        'reloadTrack built a fresh element (doc.created=' + trkADoc.created.length + '), reached \'ready\', signal ' +
        'identity held, and the fresh element played (A4)\n');
    trkAAudio.destroy();

    //     (b) A2/A1: TRK1_CYCLES-cycle force-error/reloadTrack retention loop.
    const trkCtx = createMockContext({ state: 'running' });
    const trkDoc = mockDocument();
    const trkAudio = new LiteAudio({
        buses: ['music'], poolCapacity: 4, window: trkWin, document: trkDoc,
        fetch: mockFetch({ '/churn.mp3': 500 }),
        setTimeout: () => 0, clearTimeout: () => {},
    });
    await trkAudio.init(trkCtx);
    await trkAudio.defineTracks({ churn: { src: ['/churn.mp3'], bus: 'music' } });
    if (trkAudio.trackLoadState('churn').peek() !== 'ready') die('T-TRK1 (b): setup -- churn track did not load ready.');
    if (TRK1_RED) trkAudio.reloadTrack = redReloadTrack.bind(trkAudio);

    const trkTracker = createLeakTracker({ name: 'lite-audio-reloadtrack-soak' });
    const TRK1_NOOP = () => {};
    const trkKept = [];
    let trkUndead = 0;
    const trkSigs = {
        loadState: trkAudio.trackLoadState('churn'),
        playing: trkAudio.trackPlaying('churn'),
        position: trkAudio.trackPosition('churn'),
        duration: trkAudio.trackDuration('churn'),
    };
    let trkIdentityBroken = 0;

    for (let c = 0; c < TRK1_CYCLES; c++) {
        trkAudio.playTrack('churn');
        const t = trkAudio._tracks.get('churn');
        const prevEl = t.element, prevSource = t.source, prevXfade = t.xfadeGain, prevVol = t.volumeGain;
        trkAudio.stopTrack('churn', { fade: 0 });
        t.loadState.set('error');

        const sentinel = { cycle: c };
        trkKept.push(sentinel);
        const witness = trkTracker.track(sentinel, TRK1_NOOP, c);

        const before = trkDoc.created.length;
        const reloaded = trkAudio.reloadTrack('churn');
        if (reloaded !== true) die('T-TRK1 (b): cycle ' + c + ' -- reloadTrack returned ' + reloaded + ' (expected true).');
        if (trkDoc.created.length !== before + 1) {
            die('T-TRK1 (b): cycle ' + c + ' -- created ' + (trkDoc.created.length - before) +
                ' element(s), expected exactly 1.');
        }

        const released = prevEl.srcReleased && prevEl.loadCalls > 0 &&
            prevEl._listenerCount('timeupdate') === 0 && prevEl._listenerCount('ended') === 0 &&
            (!prevSource || prevSource.disconnected >= 1) &&
            (!prevXfade || prevXfade.disconnected >= 1) &&
            (!prevVol || prevVol.disconnected >= 1);
        if (released) { trkTracker.untrack(witness); } else { trkUndead++; }

        if (trkAudio.trackLoadState('churn') !== trkSigs.loadState ||
            trkAudio.trackPlaying('churn') !== trkSigs.playing ||
            trkAudio.trackPosition('churn') !== trkSigs.position ||
            trkAudio.trackDuration('churn') !== trkSigs.duration) {
            trkIdentityBroken++;
        }
        if (trkAudio.trackLoadState('churn').peek() !== 'ready') {
            die('T-TRK1 (b): cycle ' + c + ' -- did not settle \'ready\' after reload.');
        }
    }
    if (trkKept.length !== TRK1_CYCLES) die('T-TRK1: internal -- pinned ' + trkKept.length + ' of ' + TRK1_CYCLES);
    const trkLeaked = trkTracker.size();
    const trkLiveElements = trkDoc.created.length - (TRK1_CYCLES - trkUndead);

    process.stderr.write('T-TRK1 (b) retention: ' + TRK1_CYCLES + ' force-error/reloadTrack cycles' +
        (TRK1_RED ? ' (RED: release/disconnect/null-out skipped)' : '') + ' -- lite-leak witnessed ' + trkLeaked +
        ' un-released element(s), ' + trkUndead + ' incomplete release(s), ' + trkIdentityBroken +
        ' signal-identity break(s), doc.created=' + trkDoc.created.length + ' (expected ' + (TRK1_CYCLES + 1) +
        ': one initial + one per cycle) (all expected 0 except doc.created)\n');

    if (TRK1_RED) {
        if (trkLeaked === 0 && trkUndead === 0) {
            die('LITEAUDIO_TORTURE_TRK1_RED: the release-skipping reloadTrack left the witness clean -- the red ' +
                'control is no longer modelling the leak it claims and cannot prove this gate is falsifiable.');
        }
        die('LITEAUDIO_TORTURE_TRK1_RED: reloadTrack skipped the element release + graph disconnect + null-out, ' +
            'so ' + trkUndead + '/' + TRK1_CYCLES + ' spent element(s)/node(s) were never released (lite-leak ' +
            'witnessed ' + trkLeaked + ') -- rejecting as designed. This is the red control; a clean run does not ' +
            'take this branch.');
    }
    if (trkUndead !== 0) {
        die('T-TRK1: ' + trkUndead + ' cycle(s) left their spent element/graph nodes un-released -- reloadTrack ' +
            'must removeAttribute(\'src\')+load() the old element, remove its timeupdate/ended listeners, and ' +
            'disconnect source/xfadeGain/volumeGain before the next cycle\'s fresh element is built.');
    }
    if (trkLeaked !== 0) {
        die('T-TRK1: lite-leak witnessed ' + trkLeaked + ' un-released element(s)/node(s) after ' + TRK1_CYCLES +
            ' cycles -- a teardown leak the bytesPerOp gate cannot see.');
    }
    if (trkIdentityBroken !== 0) {
        die('T-TRK1: loadState/playing/position/duration signal identity changed on ' + trkIdentityBroken +
            ' of ' + TRK1_CYCLES + ' cycles (A1) -- reloadTrack must reuse the four signals, never dispose+recreate.');
    }
    if (trkLiveElements !== 1) {
        die('T-TRK1: ' + trkLiveElements + ' live element(s) at the end of the soak (expected exactly 1, the ' +
            'current one) -- created/released bookkeeping does not balance.');
    }
    trkAudio.destroy();

    //     (c) GC budget over a fresh, smaller churn window (real element + gain-node
    //         construction is heavier than the scratch/handle tiers, so a smaller
    //         window than TRK1_CYCLES). bytesPerOp is NOT gated -- reloadTrack is a
    //         cold, intentionally-allocating recovery path (a fresh element + graph
    //         every cycle by design, D4) -- only maxMajor:0/maxPauseMs<=4 are.
    const trkGcCtx = createMockContext({ state: 'running' });
    const trkGcAudio = new LiteAudio({
        buses: ['music'], poolCapacity: 4, window: trkWin, document: mockDocument(),
        fetch: mockFetch({ '/g.mp3': 500 }),
        setTimeout: () => 0, clearTimeout: () => {},
    });
    await trkGcAudio.init(trkGcCtx);
    await trkGcAudio.defineTracks({ gchurn: { src: ['/g.mp3'], bus: 'music' } });
    const trkGcRec = trkGcAudio._tracks.get('gchurn');
    const trkGcRow = (() => {
        const r = measureOps(() => {
            trkGcAudio.playTrack('gchurn');
            trkGcAudio.stopTrack('gchurn', { fade: 0 });
            trkGcRec.loadState.set('error');
            trkGcAudio.reloadTrack('gchurn');
        }, { ops: TRK1_GC_CYCLES, warmup: 200, source: 'gc', stabilize: true });
        return { summary: r.summary, noMajor: checkNoGc(r.summary, RULES).ok, bpo: r.bytesPerOp };
    })();
    process.stderr.write('T-TRK1 (c) GC budget (' + TRK1_GC_CYCLES + ' play/stop/error/reload cycles): ' +
        'gc major=' + trkGcRow.summary.gc.major + ' minor=' + trkGcRow.summary.gc.minor +
        ' maxMs=' + trkGcRow.summary.gc.maxMs.toFixed(2) + ' (' +
        (Number.isFinite(trkGcRow.bpo) ? trkGcRow.bpo.toFixed(0) : 'null') + ' B/op, not gated -- a fresh ' +
        'element+graph per cycle is allocation BY DESIGN)\n');
    if (!trkGcRow.noMajor) {
        die('T-TRK1: the reloadTrack churn violated ' + JSON.stringify(RULES) + ' (major=' +
            trkGcRow.summary.gc.major + ', maxMs=' + trkGcRow.summary.gc.maxMs.toFixed(2) + ').');
    }
    trkGcAudio.destroy();

    // 16) T-DCK1 (PS6): applySnapshot reconciles a live duck rule via RIDE-THROUGH
    //     (decisions/0015). A duckOn rule dips 'music' while 'sfx' is hot;
    //     applySnapshot must NOT un-duck a still-hot bus (that would strand it
    //     dipped until a fresh trigger edge -- the fail-open the reviewer caught in
    //     the first skip-ramp draft). (a) contract: hot -> ride-through (music held
    //     dipped, rule.active stays true), then a hot->cold race + one tick rests
    //     music to DUCK_REST via the existing edge -- never stranded. (b) a
    //     DCK1_CYCLES play/tick/applySnapshot/stopAll/tick soak: music rests every
    //     cycle, _duckRules.length constant, lite-leak sentinels released. (c) the
    //     reconcile scan is zero-alloc over a measured window. The red control
    //     (DCK1_RED) swaps in the superseded reset+skip-ramp draft, whose hot->cold
    //     race leaves music STRANDED dipped -> die -> exit 1.
    const dckA = await buildDuckSnapshotEngine();
    if (DCK1_RED) dckA.audio.applySnapshot = redApplySnapshotStrand;
    dckA.audio.duckOn('sfx', 'music', { threshold: 1, level: 0.3, attack: 0.02, release: 0.5 });
    dckA.audio.captureSnapshot('base');
    const dckMusicA = () => dckA.audio._buses.get('music').duckGain.gain.value;

    dckA.audio.play('laser');            // sfx hot
    dckA.clock.flush();                  // tick: duck engages, music dips to level
    if (Math.abs(dckMusicA() - 0.3) > 1e-6) die('T-DCK1 (a): setup -- music did not dip to level (got ' + dckMusicA() + ').');
    const dckRuleA = dckA.audio._duckRules[0];

    dckA.audio.applySnapshot('base', 250);   // still hot: SHIPPED rides through; RED resets+skips
    dckA.audio.stopAll();                // sfx cold (no tick yet)
    dckA.clock.flush();                  // tick: SHIPPED edges music to rest; RED sees no edge
    const dckRestedA = dckMusicA();
    if (dckRestedA < DUCK_REST - 1e-6) {
        die('T-DCK1 (a)' + (DCK1_RED ? ' LITEAUDIO_TORTURE_DCK1_RED' : '') + ': music bus STRANDED dipped at ' +
            dckRestedA.toFixed(4) + ' after a hot->cold race across applySnapshot (expected DUCK_REST=' + DUCK_REST +
            (DCK1_RED ? '; the reset+skip-ramp draft leaves it un-rested -- rejecting as designed).' : ').'));
    }
    process.stderr.write('T-DCK1 (a) ride-through: a hot duckOn rule survives applySnapshot with music held dipped ' +
        'and rule.active=' + dckRuleA.active + '; after a hot->cold race one tick rests music to DUCK_REST=' +
        dckRestedA + ' via the existing edge -- never stranded (A2/A3)\n');
    dckA.audio.destroy();

    // (b) retention + no-strand soak.
    const DCK1_CYCLES = 20_000;
    const dckB = await buildDuckSnapshotEngine();
    if (DCK1_RED) dckB.audio.applySnapshot = redApplySnapshotStrand;
    dckB.audio.duckOn('sfx', 'music', { threshold: 1, level: 0.3 });
    dckB.audio.captureSnapshot('base');
    const dckTracker = createLeakTracker({ name: 'lite-audio-snapshot-duck-reconcile' });
    const DCK1_NOOP = () => {};
    const dckMusicB = () => dckB.audio._buses.get('music').duckGain.gain.value;
    let dckStranded = 0;
    const dckBaseLive = dckB.ctx._liveNodes();
    for (let c = 0; c < DCK1_CYCLES; c++) {
        dckB.audio.play('laser'); dckB.clock.flush();     // hot: duck engaged
        dckB.audio.applySnapshot('base', 250);            // ride-through (or RED strand)
        dckB.audio.stopAll(); dckB.clock.flush();         // cold: rest edge
        const sentinel = { cycle: c };
        const witness = dckTracker.track(sentinel, DCK1_NOOP, c);
        if (dckMusicB() >= DUCK_REST - 1e-6 && dckB.audio._duckRules.length === 1) dckTracker.untrack(witness);
        else dckStranded++;
    }
    if (dckB.audio._duckRules.length !== 1) die('T-DCK1 (b): _duckRules.length=' + dckB.audio._duckRules.length + ' after ' + DCK1_CYCLES + ' cycles (expected 1).');
    const dckLeaked = dckTracker.size();
    const dckLiveDelta = dckB.ctx._liveNodes() - dckBaseLive;
    process.stderr.write('T-DCK1 (b) retention: ' + DCK1_CYCLES + ' play/tick/applySnapshot/stopAll/tick cycles -- ' +
        'lite-leak witnessed ' + dckLeaked + ' un-released record(s), ' + dckStranded + ' stranded cycle(s), ' +
        '_duckRules.length=' + dckB.audio._duckRules.length + ', live-node delta ' + dckLiveDelta +
        ' (leaked/stranded expected 0, length 1)\n');
    if (dckStranded !== 0) die('T-DCK1 (b)' + (DCK1_RED ? ' LITEAUDIO_TORTURE_DCK1_RED' : '') + ': ' + dckStranded + ' cycle(s) left music stranded dipped after the cold edge.');
    if (dckLeaked !== 0) die('T-DCK1 (b): lite-leak witnessed ' + dckLeaked + ' un-released record(s) after ' + DCK1_CYCLES + ' cycles.');
    dckB.audio.destroy();

    // (c) the applySnapshot reconcile scan is zero-alloc. Measure applySnapshot in
    //     steady state on a music-ONLY snapshot with the rule hot: the ride-through
    //     path runs the scan and `continue`s writing no param, so the window
    //     measures the scan alone (no mock event-array growth from a rested bus).
    const DCK1_GC_OPS = 200_000;
    const DCK1_GC_WARMUP = 50_000;
    const DCK1_MAX_BYTES_PER_OP = 1.0;
    const dckC = await buildDuckSnapshotEngine();
    dckC.audio.duckOn('sfx', 'music', { threshold: 1, level: 0.3 });
    const dckMusVol = dckC.audio._buses.get('music').volume.peek();
    dckC.audio._snapshots.set('musonly', { names: ['music'], vols: [dckMusVol], mutes: [false] });
    dckC.audio.play('laser'); dckC.clock.flush();     // sfx hot, music dipped, rule active
    const dckGc = measureOps(() => { dckC.audio.applySnapshot('musonly', 0); },
        { ops: DCK1_GC_OPS, warmup: DCK1_GC_WARMUP, source: 'gc', stabilize: true });
    const dckReport = checkNoGc(dckGc.summary, RULES);
    process.stderr.write('T-DCK1 (c) reconcile-scan allocation (' + DCK1_GC_OPS + ' hot-rule ride-through calls): ' +
        'gc major=' + dckGc.summary.gc.major + ' minor=' + dckGc.summary.gc.minor + ' maxMs=' +
        dckGc.summary.gc.maxMs.toFixed(2) + ' (' + (dckGc.bytesPerOp == null ? 'null' : dckGc.bytesPerOp.toFixed(4)) + ' B/op)\n');
    if (!dckReport.ok) die('T-DCK1 (c): applySnapshot scan violated ' + JSON.stringify(RULES) + ' (major=' + dckGc.summary.gc.major + ').');
    if (!(dckGc.bytesPerOp != null && dckGc.bytesPerOp <= DCK1_MAX_BYTES_PER_OP)) {
        die('T-DCK1 (c): applySnapshot reconcile measured ' + (dckGc.bytesPerOp == null ? 'null' : dckGc.bytesPerOp.toFixed(4)) +
            ' B/op, over the ' + DCK1_MAX_BYTES_PER_OP + ' ceiling -- the scan is allocating.');
    }
    dckC.audio.destroy();

    // 17) T-TVOL1 (AU2 compat-shim fix): setTrackVolume(name, v) -- the public
    //     baseline-gain setter Compat.js's A-2 fix now calls on every explicit
    //     per-play volume (forwarded AFTER playTrack so the lazily-wired
    //     volumeGain exists on the very first play). Two things need proving:
    //     (a) TVOL1_OPS steady-state calls on an already-wired track hold ~0
    //     bytes/op and zero major GC -- the "map lookup + one AudioParam write,
    //     no closures, no new objects" contract in Audio.js; (b) a TVOL1_CYCLES
    //     build/wire/setTrackVolume/destroy soak (a fresh track engine every
    //     cycle, exercising the fail-closed matrix -- unknown name, non-number,
    //     NaN, out-of-range clamp -- alongside a valid write) releases every
    //     witness cleanly: lite-leak at 0 and every cycle's <audio> element left
    //     paused, none still live after its engine's destroy(). The red control
    //     (TVOL1_RED) swaps in a setTrackVolume that boxes the clamped value
    //     into a retained object every call, so phase (a) must blow both the
    //     bytesPerOp ceiling and the major-GC budget.

    //     (a) allocation + GC budget on an already-wired track.
    const tvolA = await buildTvolEngine();
    if (TVOL1_RED) tvolA.audio.setTrackVolume = redSetTrackVolume.bind(tvolA.audio);
    let tvolToggle = 0;
    const tvolRow = (() => {
        const r = measureOps(() => {
            tvolToggle ^= 1;
            tvolA.audio.setTrackVolume('tvol', tvolToggle ? 0.3 : 0.7);
        }, { ops: TVOL1_OPS, warmup: TVOL1_WARMUP, source: 'gc', stabilize: true });
        return { summary: r.summary, bpo: r.bytesPerOp, noMajor: checkNoGc(r.summary, RULES).ok };
    })();
    process.stderr.write('T-TVOL1 (a) ' + (TVOL1_RED ? '(RED: boxed retained write)' : 'setTrackVolume') +
        ' allocation (' + TVOL1_OPS + ' calls on a wired track): gc major=' + tvolRow.summary.gc.major +
        ' minor=' + tvolRow.summary.gc.minor + ' maxMs=' + tvolRow.summary.gc.maxMs.toFixed(2) + ' (' +
        (tvolRow.bpo == null ? 'null' : tvolRow.bpo.toFixed(4)) + ' B/op, ceiling ' + TVOL1_MAX_BYTES_PER_OP + ')\n');
    if (TVOL1_RED) {
        const stillClean = tvolRow.noMajor && tvolRow.bpo != null && tvolRow.bpo <= TVOL1_MAX_BYTES_PER_OP;
        if (stillClean) {
            die('LITEAUDIO_TORTURE_TVOL1_RED: the boxed-write control measured clean (major=' +
                tvolRow.summary.gc.major + ', ' + (tvolRow.bpo == null ? 'null' : tvolRow.bpo.toFixed(4)) +
                ' B/op) -- the red control is no longer modelling the allocating regression it claims and ' +
                'cannot prove this gate is falsifiable.');
        }
        die('LITEAUDIO_TORTURE_TVOL1_RED: the boxed-write setTrackVolume measured major=' +
            tvolRow.summary.gc.major + ', ' + (tvolRow.bpo == null ? 'null' : tvolRow.bpo.toFixed(4)) +
            ' B/op (ceiling ' + TVOL1_MAX_BYTES_PER_OP + ') -- rejecting as designed. This is the red ' +
            'control; a clean run does not take this branch.');
    }
    if (!tvolRow.noMajor) {
        die('T-TVOL1: setTrackVolume violated ' + JSON.stringify(RULES) + ' (major=' + tvolRow.summary.gc.major +
            ', maxMs=' + tvolRow.summary.gc.maxMs.toFixed(2) + ').');
    }
    if (!(tvolRow.bpo != null && tvolRow.bpo <= TVOL1_MAX_BYTES_PER_OP)) {
        die('T-TVOL1: setTrackVolume measured ' + (tvolRow.bpo == null ? 'null' : tvolRow.bpo.toFixed(4)) +
            ' B/op, over the ' + TVOL1_MAX_BYTES_PER_OP + ' ceiling -- it is allocating on a hot path that ' +
            'must not.');
    }
    tvolA.audio.destroy();

    //     (b) build/wire/setTrackVolume(fail-closed matrix)/destroy retention soak.
    const tvolTracker = createLeakTracker({ name: 'lite-audio-settrackvolume-soak' });
    const TVOL1_NOOP = () => {};
    let tvolUndead = 0;
    const tvolElements = [];   // every cycle's element, across the whole soak

    for (let c = 0; c < TVOL1_CYCLES; c++) {
        const t = await buildTvolEngine();
        const rec = t.audio._tracks.get('tvol');
        const volumeGain = rec.volumeGain;
        const source = rec.source;
        const xfadeGain = rec.xfadeGain;
        const element = rec.element;
        tvolElements.push(element);

        // The fail-closed matrix (P-TV1), exercised at scale alongside a valid
        // write: unknown name, non-number, NaN, and out-of-range all must leave
        // the wired gain exactly where the last VALID write left it.
        t.audio.setTrackVolume('nope', 0.9);          // unknown name: no-op
        t.audio.setTrackVolume('tvol', 0.4);           // valid
        t.audio.setTrackVolume('tvol', null);          // non-number: unchanged
        t.audio.setTrackVolume('tvol', NaN);            // NaN: unchanged
        t.audio.setTrackVolume('tvol', undefined);      // non-number: unchanged
        t.audio.setTrackVolume('tvol', '0.9');          // string: unchanged
        t.audio.setTrackVolume('tvol', -1);             // clamps to 0
        t.audio.setTrackVolume('tvol', 2);              // clamps to 1
        t.audio.setTrackVolume('tvol', 0.55);           // valid, final

        if (Math.abs(volumeGain.gain.value - 0.55) > 1e-9) {
            die('T-TVOL1 (b): cycle ' + c + ' -- volumeGain settled at ' + volumeGain.gain.value +
                ', expected 0.55 (a rejected write must leave the prior valid value untouched).');
        }

        const sentinel = { cycle: c };
        const witness = tvolTracker.track(sentinel, TVOL1_NOOP, c);

        t.audio.destroy();

        const released = volumeGain.disconnected >= 1 && source.disconnected >= 1 &&
            xfadeGain.disconnected >= 1 && element.paused === true && element.srcReleased === true;
        if (released) { tvolTracker.untrack(witness); } else { tvolUndead++; }
    }

    let tvolLiveElements = 0;
    for (let i = 0; i < tvolElements.length; i++) if (!tvolElements[i].paused) tvolLiveElements++;
    const tvolLeaked = tvolTracker.size();

    process.stderr.write('T-TVOL1 (b) retention: ' + TVOL1_CYCLES + ' build/wire/setTrackVolume(fail-closed ' +
        'matrix)/destroy cycles -- lite-leak witnessed ' + tvolLeaked + ' un-released record(s), ' + tvolUndead +
        ' incomplete release(s), ' + tvolLiveElements + ' still-live element(s) of ' + tvolElements.length +
        ' built (all expected 0)\n');
    if (tvolUndead !== 0) {
        die('T-TVOL1: ' + tvolUndead + ' cycle(s) left their volumeGain/source/xfadeGain node or <audio> element ' +
            'un-released after destroy() -- setTrackVolume must not add retention surface destroy() fails to ' +
            'release.');
    }
    if (tvolLeaked !== 0) {
        die('T-TVOL1: lite-leak witnessed ' + tvolLeaked + ' un-released record(s) after ' + TVOL1_CYCLES + ' cycles.');
    }
    if (tvolLiveElements !== 0) {
        die('T-TVOL1: ' + tvolLiveElements + ' of ' + tvolElements.length + ' elements are still un-paused after ' +
            'their engine\'s destroy() (expected 0).');
    }

    process.stderr.write(
        'result: boxed-double handle (bus>=1, gen>8388608) is below the gate resolution; ' +
        'plain-number handle keeps its zero-retain property (decisions/0001). The v1.2.0 ' +
        'monitor tick holds zero retained allocation with all four mix features live. ' +
        'S3: setPosition is a zero-alloc scratch stamp (T-SP1) and the ~10 Hz flush holds ' +
        'the SP-03 native-event rate to ~100/param/voice under a 200 cap (T-SP2), with ' +
        'steal-safety proven (a stolen channel gets zero stale writes). A lite-leak witness ' +
        'proves destroy() releases the per-bus positional scratch across ' + SP3_CYCLES +
        ' build/teardown cycles (T-SP3). S4: the hrtf bus builds HRTF panners across ' +
        'capacity and the gain=0 HRIR prewarm retires on the monitor tick with no leaked ' +
        'live node, released clean across ' + SP5_CYCLES + ' cycles (T-SP5). S6/S7: output-' +
        'layout detection resolves fail-closed on every pinned reading (>=8 -> 7.1, 6|7 -> 5.1, ' +
        '4|5 -> 3.1, else stereo) and the 12-cell requested x M fallback ladder builds the ' +
        'largest fitting preset -- a request never upgrades -- falling back to a working stereo ' +
        'bus when even 3.1 does not fit (T-SP4). The generalized data-driven VBAP solve + ' +
        '_flushLanes is zero-alloc over 500k ops at ALL THREE widths (exactly 8/6/4 lane ' +
        'writes/voice/flush for 7.1/5.1/3.1, LFE at index 3 an azimuth-invariant send) and ' +
        'rate-bounded to ~100 events/lane under a 200 cap, with destroy() releasing the per-bus ' +
        'scratch + vbap record and restoring the pristine destination triple across ' +
        (SP3_LANE_CYCLES * 3) + ' build/teardown cycles (T-SP3-lane). PS1: destroyBus ' +
        'tombstones ONE dynamic bus in place -- pooled voices stopped (census delta 0), the ' +
        'husk pulled out of the lane flush, _busList length + every surviving index kept stable, ' +
        'released clean across ' + SP7_CYCLES + ' create/destroyBus cycles under maxMajor:0/maxPauseMs<=4 (T-SP7). ' +
        'PS2: the shared monitor sleeps -- skips its own reschedule -- at zero live consumers and wakes on the ' +
        'next registration (metered/discrete/duck/auto-suspend/positional/width/HRIR-prewarm), never double-arms, ' +
        'a live auto-suspend countdown is never slept out from under itself and play() (T4) wakes a self-suspended ' +
        'monitor, released clean across ' + SP8_CYCLES + ' create/tick/destroy/tick-to-sleep/wake cycles, and the ' +
        'cold predicate itself holds zero retained allocation over ' + SP8_OPS + ' calls (T-SP8). ' +
        'PS4: removeDuckRule empties the last duck consumer and the very next tick sleeps the monitor ' +
        '(monitorTimer=null, pending=0, tick counter frozen), released clean with a flat live-node delta across ' +
        SP8G_CYCLES + ' duckOn/removeDuckRule cycles, each exercising the stranded-target recovery write (T-SP8g). ' +
        'PS5: reloadTrack(name) recovers ONE errored/idle music track without a full defineTracks rebuild -- a ' +
        'wire-failed spent element reaches \'ready\' behind a fresh element (A4), and a ' + TRK1_CYCLES +
        '-cycle force-error/reloadTrack soak releases every spent element/graph node (lite-leak witness 0, exactly ' +
        'one fresh element per cycle) while the four external signals hold object identity across every cycle, ' +
        'not just a spot check (A1/A2), under maxMajor:0/maxPauseMs<=4 (T-TRK1). ' +
        'PS6: applySnapshot reconciles a live duck rule by RIDE-THROUGH -- a still-hot duckOn rule survives ' +
        'a snapshot with its target held dipped and rule.active true (never un-ducked/stranded), and the ' +
        'existing edge rests it when the trigger drops; the reconcile scan is zero-alloc and a ' + DCK1_CYCLES +
        '-cycle play/tick/applySnapshot/stopAll/tick soak leaves 0 stranded and 0 leaked, _duckRules.length ' +
        'constant, released clean, while the red control (DCK1_RED) reproduces the superseded draft\'s ' +
        'hot->cold strand and is rejected (T-DCK1). ' +
        'AU2: setTrackVolume(name, v) -- the compat-shim\'s A-2 per-play-volume setter -- is a zero-alloc scalar ' +
        'write over ' + TVOL1_OPS + ' calls on an already-wired track, and a ' + TVOL1_CYCLES + '-cycle build/' +
        'wire/setTrackVolume(fail-closed matrix)/destroy soak releases every witness cleanly (lite-leak 0, every ' +
        'element left paused), while the red control (TVOL1_RED) reproduces a boxed-retained-write regression ' +
        'and is rejected (T-TVOL1).\n');
    process.stdout.write('ok\n');
    process.exit(0);
}

main();
