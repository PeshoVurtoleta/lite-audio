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
 * Peers are devDependencies, never runtime deps: Audio.js has zero deps.
 *
 * @license MIT
 */

import { measureOps, checkNoGc } from '@zakkster/lite-gc-profiler';
import { createLeakTracker } from '@zakkster/lite-leak';
import { LiteAudio } from '../Audio.js';
import { createMockContext, mockFetch, mockDocument, mockScheduler, flushMicrotasks } from './mock-ctx.js';

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
        'cold predicate itself holds zero retained allocation over ' + SP8_OPS + ' calls (T-SP8).\n');
    process.stdout.write('ok\n');
    process.exit(0);
}

main();
