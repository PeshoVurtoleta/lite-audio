/** @zakkster/lite-audio - mix intelligence (AU1 / v1.2.0):
 *  ducking, snapshots, meters, auto-suspend, dynamic buses. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LiteAudio } from '../Audio.js';
import {
    createMockContext, mockFetch, mockDocument, mockScheduler, flushMicrotasks, paramEvents,
} from './mock-ctx.js';

// Mirror of the private Audio.js constant (not exported): the sidechain
// gain's resting multiplier. Kept local so this file states its own contract
// rather than reaching into module internals (mirrors DuckRule.test.js).
const DUCK_REST = 1;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function fakeWindow(navigator) {
    const cbs = [];
    return {
        navigator,
        addEventListener(evt, cb) { cbs.push(cb); },
        removeEventListener() {},
        fire() { for (const cb of [...cbs]) cb({}); },
    };
}

async function boot({ unlock = true, buses = ['sfx', 'music', 'voice'], navigator } = {}) {
    const ctx = createMockContext({ state: 'suspended' });
    const win = fakeWindow(navigator);
    const doc = mockDocument();
    const clock = mockScheduler();

    const audio = new LiteAudio({
        buses,
        poolCapacity: 8,
        window: win,
        document: doc,
        fetch: mockFetch({ '/laser.wav': 500, '/boom.wav': 500 }),
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
    });

    await audio.init(ctx);
    await audio.defineSounds({
        laser: { src: ['/laser.wav'], bus: 'sfx' },
        shout: { src: ['/laser.wav'], bus: 'voice' },
    });

    if (unlock) {
        win.fire();
        await flushMicrotasks(8);
    }

    const bus = (name) => audio._buses.get(name);
    const duckParam = (name) => bus(name).duckGain.gain;
    // One monitor tick: the mock scheduler holds exactly the monitor's pending
    // timer (nothing here schedules a track pause), and the tick reschedules
    // the next, so one flush == one tick.
    const tick = () => clock.flush();
    return { audio, ctx, win, clock, bus, duckParam, tick };
}

// ---------------------------------------------------------------------------
// Ducking
// ---------------------------------------------------------------------------

describe('duck / stopDuck (manual)', () => {
    it('dips the sidechain, not the volume gain, so it composes with volume/mute', async () => {
        const { audio, bus, duckParam } = await boot();
        const volEventsBefore = paramEvents(bus('music').gain.gain).length;

        audio.duck('music', 0.2, { attack: 0.03 });

        const dg = paramEvents(duckParam('music'), 'target');
        assert.equal(dg.length, 1, 'one dip scheduled');
        assert.equal(dg[0][1], 0.2, 'to the requested level');
        assert.equal(dg[0][3], 0.03, 'with the requested attack TC');
        // The bus volume gain was NOT touched - duck lives on its own param.
        assert.equal(paramEvents(bus('music').gain.gain).length, volEventsBefore);
    });

    it('attack and release time constants are distinct (asymmetry)', async () => {
        const { audio, duckParam } = await boot();
        audio.duck('music', 0.2, { attack: 0.02, release: 0.6 });
        audio.stopDuck('music');

        const ev = paramEvents(duckParam('music'), 'target');
        assert.equal(ev.length, 2);
        assert.equal(ev[0][3], 0.02, 'attack TC');
        assert.equal(ev[1][1], 1, 'releases to rest');
        assert.equal(ev[1][3], 0.6, 'release TC remembered from the duck() call');
        assert.notEqual(ev[0][3], ev[1][3], 'attack != release');
    });

    it('is inert on an unknown bus and after destroy', async () => {
        const { audio } = await boot();
        assert.doesNotThrow(() => audio.duck('nope', 0.5));
        audio.destroy();
        assert.doesNotThrow(() => audio.duck('music', 0.5));
    });
});

describe('duckOn (automatic follower)', () => {
    it('dips the target on the trigger crossing its threshold, recovers below it', async () => {
        const { audio, duckParam, tick } = await boot();
        audio.duckOn('sfx', 'music', { threshold: 2, level: 0.3, attack: 0.02, release: 0.5 });

        tick();                                   // 0 voices: below, no write
        assert.equal(paramEvents(duckParam('music'), 'target').length, 0);

        audio.play('laser'); audio.play('laser'); // 2 voices on sfx
        tick();
        let ev = paramEvents(duckParam('music'), 'target');
        assert.equal(ev.length, 1, 'engaged on the edge');
        assert.equal(ev[0][1], 0.3);
        assert.equal(ev[0][3], 0.02, 'attack TC');

        tick(); tick();                           // held down: no restack
        assert.equal(paramEvents(duckParam('music'), 'target').length, 1,
            'steady state writes nothing - edge-only');

        audio.stopAll();                          // voices -> 0
        tick();
        ev = paramEvents(duckParam('music'), 'target');
        assert.equal(ev.length, 2, 'released on the falling edge');
        assert.equal(ev[1][1], 1, 'back to rest');
        assert.equal(ev[1][3], 0.5, 'release TC');
    });

    it('an explicit duck() always wins over the follower', async () => {
        const { audio, duckParam, tick } = await boot();
        audio.duckOn('sfx', 'music', { threshold: 1, level: 0.3 });

        audio.duck('music', 0.05, { attack: 0.04 });      // manual latch
        const afterManual = paramEvents(duckParam('music'), 'target').length;

        audio.play('laser');                              // would engage the follower
        tick(); tick();
        assert.equal(paramEvents(duckParam('music'), 'target').length, afterManual,
            'follower left the manually-ducked bus alone');

        audio.stopDuck('music');                          // release + clear the latch
        audio.play('laser');
        tick();
        assert.ok(paramEvents(duckParam('music'), 'target').length > afterManual + 1,
            'follower drives the bus again once the latch is cleared');
    });
});

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

describe('mix snapshots', () => {
    it('round-trips every captured bus volume and mute', async () => {
        const { audio } = await boot();
        audio.setBusVolume('music', 0.8);
        audio.setBusVolume('sfx', 1);
        audio.setBusMuted('voice', false);
        audio.captureSnapshot('game');

        audio.setBusVolume('music', 0.1);
        audio.setBusVolume('sfx', 0.4);
        audio.setBusMuted('voice', true);

        audio.applySnapshot('game');   // ms=0: snap via signals

        assert.equal(audio.busVolume('music').peek(), 0.8);
        assert.equal(audio.busVolume('sfx').peek(), 1);
        assert.equal(audio.busMuted('voice').peek(), false);
    });

    it('morphs over ms on the sidechain, continuous from the actual current product', async () => {
        const { audio, ctx, bus, duckParam } = await boot();
        audio.setBusVolume('music', 0.8);
        audio.captureSnapshot('loud');
        audio.setBusVolume('music', 0.2);      // bus gain value -> 0.2

        ctx._advance(1);
        const now = ctx.currentTime;
        audio.applySnapshot('loud', 500);

        // Signal is instantly truthful.
        assert.equal(audio.busVolume('music').peek(), 0.8);
        // Bus gain pinned to the target so the sidechain carries the whole move.
        assert.equal(bus('music').gain.gain.value, 0.8);
        // Sidechain: start at product/target = 0.2/0.8 = 0.25, linear ramp to 1 over 0.5s.
        const sets = paramEvents(duckParam('music'), 'set');
        assert.equal(sets[sets.length - 1][1], 0.25, 'continuous from current product');
        const ramp = paramEvents(duckParam('music'), 'linearRamp');
        assert.equal(ramp.length, 1);
        assert.equal(ramp[0][1], 1, 'morphs to rest');
        assert.equal(ramp[0][2], now + 0.5, 'over the requested ms');
    });

    it('a target of silence is left to the signals, never stranding the sidechain at zero', async () => {
        const { audio, duckParam } = await boot();
        audio.setBusMuted('music', true);
        audio.captureSnapshot('muted');
        audio.setBusMuted('music', false);

        audio.applySnapshot('muted', 500);
        assert.equal(audio.busMuted('music').peek(), true, 'mute restored via the signal');
        // Sidechain rested at 1, not ramped to 0.
        const ev = paramEvents(duckParam('music'));
        const last = ev[ev.length - 1];
        assert.equal(last[1], 1, 'duckGain rested, not stranded silent');
    });

    it('applying a snapshot clears a manual duck latch on the buses it touches', async () => {
        const { audio, bus } = await boot();
        audio.captureSnapshot('base');
        audio.duck('music', 0.1);
        assert.equal(bus('music').duckManual, true);
        audio.applySnapshot('base', 200);
        assert.equal(bus('music').duckManual, false, 'snapshot restates the mix');
    });

    it('is inert for an unknown snapshot name', async () => {
        const { audio } = await boot();
        assert.doesNotThrow(() => audio.applySnapshot('ghost', 100));
    });
});

// ---------------------------------------------------------------------------
// PS6 (v2.11.0) -- applySnapshot reconciles a live duck rule (ride-through).
// decisions/0015-snapshot-duck-reconcile.md. The mechanism SHIPPED is
// ride-through, NOT the superseded reset+skip-ramp draft: a still-hot active
// rule is left dipped and rule.active TRUE across the snapshot (no write to
// duckGain at all); only a STALE active rule (trigger already cold) is reset
// and rested. Cases below are numbered to match the PS6 boundary brief.
// ---------------------------------------------------------------------------

describe('PS6: applySnapshot reconciles a live duck rule (ride-through)', () => {
    it('1. hot trigger + applySnapshot(name, 250): duckGain NOT rested, ZERO new linearRamp calls, active stays TRUE; cold+tick then rests it (strand guard)', async () => {
        const { audio, duckParam, tick } = await boot();
        audio.duckOn('sfx', 'music', { threshold: 1, level: 0.3, attack: 0.02, release: 0.5 });
        audio.captureSnapshot('base');

        audio.play('laser');
        tick();
        assert.equal(audio._duckRules[0].active, true, 'setup: rule engaged');
        assert.equal(duckParam('music').value, 0.3, 'setup: dipped to level');

        const rampsBefore = paramEvents(duckParam('music'), 'linearRamp').length;
        audio.applySnapshot('base', 250);

        assert.equal(duckParam('music').value, 0.3, 'ride-through: duckGain not rested while still hot');
        assert.equal(paramEvents(duckParam('music'), 'linearRamp').length, rampsBefore,
            'zero new linearRampToValueAtTime calls on the still-hot bus');
        assert.equal(audio._duckRules[0].active, true, 'rule.active stays TRUE');

        audio.stopAll();
        tick();
        assert.equal(duckParam('music').value, DUCK_REST, 'edge on the cold tick rests it -- never stranded dipped');
        assert.equal(audio._duckRules[0].active, false);
    });

    it('2. hot trigger + applySnapshot(name, 0): same ride-through (NOT snapped to DUCK_REST), active stays TRUE; cold+tick rests it', async () => {
        const { audio, duckParam, tick } = await boot();
        audio.duckOn('sfx', 'music', { threshold: 1, level: 0.3 });
        audio.captureSnapshot('base');

        audio.play('laser');
        tick();
        assert.equal(duckParam('music').value, 0.3);

        audio.applySnapshot('base', 0);
        assert.equal(duckParam('music').value, 0.3, 'ms=0 ride-through: NOT snapped to DUCK_REST');
        assert.equal(audio._duckRules[0].active, true);

        audio.stopAll();
        tick();
        assert.equal(duckParam('music').value, DUCK_REST);
    });

    it('3. cold trigger + applySnapshot(name, 250): rule.active RESET to false, duckGain ramps/settles to DUCK_REST (stale duck released)', async () => {
        const { audio, duckParam, tick } = await boot();
        audio.duckOn('sfx', 'music', { threshold: 1, level: 0.3 });
        audio.captureSnapshot('base');

        audio.play('laser');
        tick();
        assert.equal(audio._duckRules[0].active, true);
        audio.stopAll();   // trigger now cold, but no tick yet -- rule still marked active (stale)

        audio.applySnapshot('base', 250);

        assert.equal(audio._duckRules[0].active, false, 'stale active rule reset');
        const ramp = paramEvents(duckParam('music'), 'linearRamp');
        assert.equal(ramp[ramp.length - 1][1], DUCK_REST, 'ramps to rest');
        assert.equal(duckParam('music').value, DUCK_REST);
    });

    it('4. cold trigger + applySnapshot(name, 0): reset false, snaps to DUCK_REST', async () => {
        const { audio, duckParam, tick } = await boot();
        audio.duckOn('sfx', 'music', { threshold: 1, level: 0.3 });
        audio.captureSnapshot('base');

        audio.play('laser');
        tick();
        audio.stopAll();

        audio.applySnapshot('base', 0);

        assert.equal(audio._duckRules[0].active, false);
        assert.equal(duckParam('music').value, DUCK_REST);
        const sets = paramEvents(duckParam('music'), 'set');
        assert.equal(sets[sets.length - 1][1], DUCK_REST);
    });

    it('5. INACTIVE rule + hot trigger + applySnapshot: rests to DUCK_REST; the NEXT tick EDGES and ducks to level (strand-free)', async () => {
        const { audio, duckParam, tick } = await boot();
        audio.duckOn('sfx', 'music', { threshold: 1, level: 0.3 });
        audio.captureSnapshot('base');

        audio.play('laser');   // trigger hot, but no tick has run -- rule still inactive
        assert.equal(audio._duckRules[0].active, false, 'setup: never edged yet');

        audio.applySnapshot('base', 0);
        assert.equal(duckParam('music').value, DUCK_REST, 'rested (an inactive rule is never "held hot")');
        assert.equal(audio._duckRules[0].active, false);

        tick();
        assert.equal(audio._duckRules[0].active, true, 'next tick edges');
        assert.equal(duckParam('music').value, 0.3, 'ducks to level');
    });

    it('6. TWO rules on the SAME target, one hot one cold: hot stays active:true (rides), cold reset to active:false', async () => {
        const { audio, duckParam, tick } = await boot();
        audio.duckOn('sfx', 'music', { threshold: 1, level: 0.3 });
        audio.duckOn('voice', 'music', { threshold: 1, level: 0.2 });
        audio.captureSnapshot('base');

        audio.play('laser');   // sfx -> music (stays hot)
        audio.play('shout');   // voice -> music (about to go cold)
        tick();
        assert.equal(audio._duckRules[0].active, true, 'setup: sfx rule engaged');
        assert.equal(audio._duckRules[1].active, true, 'setup: voice rule engaged');

        audio.stopBus('voice');   // voice trigger drops cold; sfx stays hot
        assert.ok(audio.activeCount('sfx') >= 1, 'setup: sfx still hot');
        assert.equal(audio.activeCount('voice'), 0, 'setup: voice now cold');

        audio.applySnapshot('base', 250);

        assert.equal(audio._duckRules[0].active, true, 'the HOT rule (sfx) rides through, stays active');
        assert.equal(audio._duckRules[1].active, false, 'the COLD rule (voice) is reset');
        assert.notEqual(duckParam('music').value, DUCK_REST, 'the bus stays ducked, not rested -- heldHot suppressed the rest');
    });

    it('7. rule targets a bus NOT in the snapshot -> untouched (active + duckGain unchanged)', async () => {
        const { audio, duckParam, tick } = await boot();
        audio.captureSnapshot('base');   // 'extra' does not exist yet
        audio.createBus('extra');
        audio.duckOn('sfx', 'extra', { threshold: 1, level: 0.3 });

        audio.play('laser');
        tick();
        assert.equal(audio._duckRules[0].active, true, 'setup: engaged');
        const before = duckParam('extra').value;

        audio.applySnapshot('base', 250);

        assert.equal(audio._duckRules[0].active, true, 'untouched: bus not named by the snapshot');
        assert.equal(duckParam('extra').value, before, 'duckGain untouched');
    });

    it('8a. empty _duckRules -> behaves exactly as 2.10.0', async () => {
        const { audio, duckParam } = await boot();
        audio.setBusVolume('music', 0.9);
        audio.captureSnapshot('base');
        audio.setBusVolume('music', 0.2);
        assert.equal(audio._duckRules.length, 0, 'setup: no rules registered');

        audio.applySnapshot('base', 0);

        assert.equal(audio.busVolume('music').peek(), 0.9, 'restated exactly as 2.10.0');
        assert.equal(duckParam('music').value, DUCK_REST, 'rested to DUCK_REST');
        assert.equal(audio._duckRules.length, 0, 'still empty');
    });

    it('8b. a snapshot touching a bus with NO rule leaves EVERY rule object identity-equal, length unchanged', async () => {
        const { audio } = await boot();
        audio.duckOn('sfx', 'voice', { threshold: 1, level: 0.3 });   // targets a DIFFERENT bus than 'music'
        const ruleBefore = audio._duckRules[0];
        audio.captureSnapshot('base');

        audio.applySnapshot('base', 0);   // touches 'music' (among others) -- no rule targets it

        assert.equal(audio._duckRules.length, 1, 'length unchanged');
        assert.equal(audio._duckRules[0], ruleBefore, 'the rule object itself is identity-equal, untouched');
    });

    it('9. duckManual bus in the snapshot -> latch cleared; a still-hot rule rides through', async () => {
        const { audio, duckParam, tick, bus } = await boot();
        audio.duckOn('sfx', 'music', { threshold: 1, level: 0.3 });
        audio.captureSnapshot('base');

        audio.play('laser');
        tick();
        assert.equal(audio._duckRules[0].active, true);

        audio.duck('music', 0.05);   // manual latch on top of the rule's own dip
        assert.equal(bus('music').duckManual, true, 'setup: manual latch set');

        audio.applySnapshot('base', 250);

        assert.equal(bus('music').duckManual, false, 'snapshot restates the mix: latch cleared');
        assert.equal(audio._duckRules[0].active, true, 'the still-hot rule rides through regardless of the latch');
        assert.equal(duckParam('music').value, 0.05, 'ride-through leaves the sidechain exactly where it was (untouched)');
    });

    it('10. unknown snapshot name / destroyed engine -> no-op, no throw, _duckRules untouched', async () => {
        const { audio } = await boot();
        audio.duckOn('sfx', 'music', { threshold: 1, level: 0.3 });
        audio._duckRules[0].active = true;
        const ruleBefore = audio._duckRules[0];

        assert.doesNotThrow(() => audio.applySnapshot('ghost-snapshot', 250));
        assert.equal(audio._duckRules.length, 1);
        assert.equal(audio._duckRules[0], ruleBefore);
        assert.equal(audio._duckRules[0].active, true, 'untouched by the unknown-name no-op');

        audio.captureSnapshot('real');
        audio.destroy();
        assert.doesNotThrow(() => audio.applySnapshot('real', 250));
    });

    it('11. a snapshot-named bus that no longer exists (destroyBus after capture) -> continued, no rule reset for it', async () => {
        const { audio } = await boot();
        audio.createBus('gone');
        audio.duckOn('sfx', 'gone', { threshold: 1, level: 0.3 });
        audio.captureSnapshot('base');   // 'gone' is named in the captured snapshot

        audio._duckRules[0].active = true;   // simulate a stale active rule (trigger cold)
        assert.equal(audio.destroyBus('gone'), true, 'setup: target bus destroyed after capture');
        assert.equal(audio._buses.get('gone'), undefined);

        assert.doesNotThrow(() => audio.applySnapshot('base', 250));

        assert.equal(audio._duckRules[0].active, true, 'the continued (nonexistent-bus) row never reaches the rule scan');
    });

    it('12. prior-apply-ramp-in-flight: a cold rest ramp is scheduled, the trigger re-edges hot, a SECOND applySnapshot rides through (no cancelScheduledValues) -- never stranded/over-rested', async () => {
        const { audio, duckParam, tick } = await boot();
        audio.duckOn('sfx', 'music', { threshold: 1, level: 0.3, attack: 0.02, release: 0.5 });
        audio.captureSnapshot('base');

        audio.play('laser');
        tick();
        assert.equal(audio._duckRules[0].active, true, 'setup: engaged');

        audio.stopAll();   // trigger goes cold, but no tick yet -- rule.active still true (stale)
        audio.applySnapshot('base', 250);   // FIRST apply: stale-active + cold -> reset + rest ramp scheduled
        assert.equal(audio._duckRules[0].active, false, 'setup: first apply reset the stale rule');
        const cancelsBefore = paramEvents(duckParam('music'), 'cancel').length;
        const ramp = paramEvents(duckParam('music'), 'linearRamp');
        assert.equal(ramp[ramp.length - 1][1], DUCK_REST, 'setup: rest ramp scheduled toward DUCK_REST');

        // Trigger goes hot again BEFORE that ramp would have completed; the tick edges and re-ducks.
        audio.play('laser');
        tick();
        assert.equal(audio._duckRules[0].active, true, 'setup: the trigger re-edged hot');
        assert.equal(duckParam('music').value, 0.3, 'setup: re-ducked to level');

        // SECOND applySnapshot fires with the trigger STILL hot: ride-through, no cancelScheduledValues.
        audio.applySnapshot('base', 250);

        assert.equal(paramEvents(duckParam('music'), 'cancel').length, cancelsBefore,
            'ride-through: zero cancelScheduledValues calls on the surviving live duck');
        assert.equal(duckParam('music').value, 0.3, 'not stranded/over-rested -- governed by the live duck');
        assert.equal(audio._duckRules[0].active, true);

        // The eventual cold edge is what finally rests it.
        audio.stopAll();
        tick();
        assert.equal(duckParam('music').value, DUCK_REST, 'the eventual cold edge rests it -- never stranded');
    });
});

// ---------------------------------------------------------------------------
// PS6 boundary matrix: rule population targeting ONE bus -- 0, 1, N-1, N, N+1
// ---------------------------------------------------------------------------

describe('PS6 boundary: rule population targeting one bus -- 0, 1, N-1, N, N+1', () => {
    it('0 rules -> bus rests exactly as 2.10.0', async () => {
        const { audio, duckParam } = await boot();
        audio.setBusVolume('music', 0.7);
        audio.captureSnapshot('base');
        assert.equal(audio._duckRules.length, 0);
        audio.applySnapshot('base', 0);
        assert.equal(duckParam('music').value, DUCK_REST);
    });

    it('1 rule: hot rides through; cold resets+rests (both branches at N=1)', async () => {
        const { audio, duckParam, tick } = await boot();
        audio.duckOn('sfx', 'music', { threshold: 1, level: 0.3 });
        audio.captureSnapshot('base');
        audio.play('laser');
        tick();

        audio.applySnapshot('base', 0);
        assert.equal(duckParam('music').value, 0.3, 'N=1 hot rides through');
        assert.equal(audio._duckRules[0].active, true);

        audio.stopAll();
        audio.applySnapshot('base', 0);
        assert.equal(duckParam('music').value, DUCK_REST, 'N=1 cold rests');
        assert.equal(audio._duckRules[0].active, false);
    });

    it('N-1/N/N+1: 5 rules on one target, exactly one stays hot -- only the hot one survives active; adding a 6th (N+1) hot rule keeps riding', async () => {
        const { audio, duckParam, tick } = await boot();
        const N = 5;
        for (let i = 0; i < N; i++) {
            audio.createBus('trig' + i);
            audio.duckOn('trig' + i, 'music', { threshold: 1, level: 0.2 + i * 0.01 });
        }
        assert.equal(audio._duckRules.length, N);
        audio.captureSnapshot('base');

        for (let i = 0; i < N; i++) audio._buses.get('trig' + i).pool = { activeCount: () => 1 };
        tick();
        for (let i = 0; i < N; i++) assert.equal(audio._duckRules[i].active, true, 'setup: rule ' + i + ' engaged');

        for (let i = 1; i < N; i++) audio._buses.get('trig' + i).pool = { activeCount: () => 0 };   // N-1 go cold

        audio.applySnapshot('base', 0);

        assert.equal(audio._duckRules[0].active, true, 'the one still-hot rule rides, stays active');
        for (let i = 1; i < N; i++) {
            assert.equal(audio._duckRules[i].active, false, 'cold rule ' + i + ' of N-1 reset');
        }
        assert.notEqual(duckParam('music').value, DUCK_REST, 'bus rides through, not rested (heldHot suppressed the rest)');

        // N+1: register one MORE hot rule on the same target after the apply.
        audio.createBus('trigExtra');
        audio.duckOn('trigExtra', 'music', { threshold: 1, level: 0.5 });
        audio._duckRules[N].active = true;
        audio._buses.get('trigExtra').pool = { activeCount: () => 1 };
        assert.equal(audio._duckRules.length, N + 1);

        audio.applySnapshot('base', 0);
        assert.equal(audio._duckRules[0].active, true, 'N+1: original hot rule still rides');
        assert.equal(audio._duckRules[N].active, true, 'N+1: the newly added hot rule also rides');
    });
});

// ---------------------------------------------------------------------------
// PS6 boundary: applySnapshot(name, ms) argument matrix -- empty/null/
// undefined/NaN/-0.
// ---------------------------------------------------------------------------

describe('PS6 boundary: applySnapshot(name, ms) argument matrix', () => {
    it('name: empty string / null / undefined / NaN / -0 / object / array / boolean -> no-op, no throw, _duckRules untouched', async () => {
        const { audio } = await boot();
        audio.duckOn('sfx', 'music', { threshold: 1, level: 0.3 });
        audio._duckRules[0].active = true;
        const before = audio._duckRules[0].active;
        const bad = ['', null, undefined, NaN, -0, {}, [], true, false];
        for (const v of bad) {
            assert.doesNotThrow(() => audio.applySnapshot(v, 250), 'name=' + String(v));
        }
        assert.equal(audio._duckRules.length, 1);
        assert.equal(audio._duckRules[0].active, before, 'untouched by every bad name');
    });

    it('ms: null / undefined / NaN / -0 on a KNOWN snapshot -> fails closed to the ms<=0 snap branch, never schedules a NaN', async () => {
        const { audio, duckParam } = await boot();
        audio.duckOn('sfx', 'music', { threshold: 1, level: 0.3 });
        audio.captureSnapshot('base');
        const rule = audio._duckRules[0];

        const badMs = [null, undefined, NaN, -0];
        for (const ms of badMs) {
            rule.active = true;   // re-arm a stale (cold-trigger) active rule each pass
            assert.doesNotThrow(() => audio.applySnapshot('base', ms), 'ms=' + String(ms));
            assert.equal(duckParam('music').value, DUCK_REST, 'ms=' + String(ms) + ' falls closed to the snap-to-rest branch');
            assert.equal(rule.active, false, 'stale rule reset regardless of the malformed ms');
        }
        const evs = paramEvents(duckParam('music'));
        for (const e of evs) for (const x of e) {
            if (typeof x === 'number') assert.equal(Number.isNaN(x), false, 'no NaN ever recorded in a scheduled event');
        }
    });
});

// ---------------------------------------------------------------------------
// PS6 duplicate dispose
// ---------------------------------------------------------------------------

describe('PS6 duplicate dispose', () => {
    it('destroy() called twice: applySnapshot stays a no-op and neither call throws', async () => {
        const { audio } = await boot();
        audio.duckOn('sfx', 'music', { threshold: 1, level: 0.3 });
        audio.captureSnapshot('base');

        assert.doesNotThrow(() => audio.destroy());
        assert.doesNotThrow(() => audio.applySnapshot('base', 250));

        assert.doesNotThrow(() => audio.destroy(), 'repeat destroy() must not throw');
        assert.doesNotThrow(() => audio.applySnapshot('base', 250), 'still a no-op after the repeat dispose');
    });
});

// ---------------------------------------------------------------------------
// PS6 dispose-during-iteration / re-entrant write: a reentrant duckOn()/
// removeDuckRule() fired from inside applySnapshot's own bus loop (via a
// volume-signal effect() observer) must not corrupt the scan the outer call
// is mid-way through, and the reentrant mutation must land cleanly once the
// outer call returns.
// ---------------------------------------------------------------------------

describe('PS6 re-entrant write: a duckOn()/removeDuckRule() fired from an effect() observing a snapshot-touched bus signal', () => {
    it('the reentrant rule is present and untouched, and the outer scan completes with no partial reset', async () => {
        const { audio, duckParam, tick } = await boot();
        audio.duckOn('sfx', 'music', { threshold: 1, level: 0.3 });
        audio.captureSnapshot('base');

        audio.play('laser');
        tick();
        assert.equal(audio._duckRules[0].active, true, 'setup: engaged');
        audio.stopAll();   // stale active rule (cold trigger) so this apply resets it

        const origSet = audio.busVolume('music').set.bind(audio.busVolume('music'));
        let reentered = false;
        audio.busVolume('music').set = (v) => {
            const r = origSet(v);
            if (!reentered) {
                reentered = true;
                audio.duckOn('voice', 'music', { threshold: 1, level: 0.15 });   // reentrant registration mid-scan
            }
            return r;
        };

        let threw = false;
        try { audio.applySnapshot('base', 250); } catch { threw = true; }

        assert.equal(threw, false, 'the reentrant write does not throw the outer applySnapshot');
        assert.equal(reentered, true, 'setup: the volume signal write actually fired the reentrant hook');
        assert.equal(audio._duckRules.length, 2, 'the reentrant rule is present alongside the original');
        assert.equal(audio._duckRules[0].active, false, 'the original stale rule was still fully reset -- no partial scan');
        assert.equal(audio._duckRules[1].triggerBus, 'voice', 'the reentrant rule landed cleanly');
        assert.equal(duckParam('music').value, DUCK_REST, 'the rest this call scheduled completed normally');
    });
});

// ---------------------------------------------------------------------------
// PS6 adversarial: a type-confusion targetBus (== matches a real bus name,
// === must not) must never be treated as matching that bus's snapshot row --
// the rule scan's `rule.targetBus !== snap.names[i]` compare is STRICT.
// ---------------------------------------------------------------------------

describe('PS6 adversarial: type-confusion targetBus (== matches, === must not)', () => {
    it('a rule whose targetBus is an object with valueOf()/toString() returning "music" never rides through or resets against the real "music" row', async () => {
        const { audio, duckParam, tick } = await boot();
        const confusable = { valueOf() { return 'music'; }, toString() { return 'music'; } };
        assert.equal(confusable == 'music', true, 'setup: loose equality is fooled');
        assert.notEqual(confusable, 'music', 'setup: strict equality is not');

        audio.duckOn('sfx', confusable, { threshold: 1, level: 0.3 });
        audio._duckRules[0].active = true;   // force "active"; trigger is cold (no pool)
        audio.captureSnapshot('base');       // captures the REAL 'music' bus among others

        audio.applySnapshot('base', 0);

        assert.equal(audio._duckRules[0].active, true,
            'the confusable-target rule is never matched by the real "music" row -- untouched, no strict-equality coercion');
        assert.equal(duckParam('music').value, DUCK_REST, 'the real "music" bus rests normally, unaffected by the confusable rule');
    });
});

// ---------------------------------------------------------------------------
// Meters
// ---------------------------------------------------------------------------

describe('per-bus meters', () => {
    it('level() reports the RMS of the analyser signal, updated on the monitor tick', async () => {
        const { audio, bus, tick } = await boot();
        audio.createBus('meterbus', { meter: true });
        assert.equal(audio.level('meterbus').peek(), 0, 'starts silent');

        bus('meterbus').analyser._fill = 0.5;   // constant 0.5 -> RMS 0.5
        tick();
        assert.equal(audio.level('meterbus').peek(), 0.5);
    });

    it('reads into ONE pre-allocated buffer, never reallocating per read', async () => {
        const { audio, bus, tick } = await boot();
        audio.createBus('meterbus', { meter: true });
        const buf = bus('meterbus').meterBuffer;
        assert.ok(buf instanceof Float32Array);
        tick(); tick(); tick();
        assert.equal(bus('meterbus').meterBuffer, buf, 'same buffer reference across reads');
    });

    it('an unmetered bus allocates no analyser and level() is null', async () => {
        const { audio, bus } = await boot();
        audio.createBus('plain');
        assert.equal(bus('plain').analyser, null);
        assert.equal(audio.level('plain'), null);
        assert.equal(audio.level('nope'), null, 'unknown bus');
    });
});

// ---------------------------------------------------------------------------
// Dynamic buses
// ---------------------------------------------------------------------------

describe('createBus', () => {
    it('adds a routable bus with the next index, and stop() decodes back to it', async () => {
        const { audio } = await boot();
        const nextIndex = audio._busList.length;
        audio.createBus('extra');
        assert.equal(audio._buses.get('extra').index, nextIndex);

        await audio.defineSounds({ boom: { src: ['/boom.wav'], bus: 'extra' } });
        const h = audio.play('boom');
        assert.ok(h >= 0, 'played on the dynamic bus');
        assert.equal(audio.busOf(h), 'extra', 'handle decodes to the new bus');
    });

    it('is idempotent and rejects the reserved name', async () => {
        const { audio } = await boot();
        const rec = audio.createBus('extra');
        assert.equal(audio.createBus('extra'), rec, 'same record on re-create');
        assert.throws(() => audio.createBus('master'), /reserved/);
    });

    it('fails closed at the 2^21 handle ceiling at runtime, not just at init', async () => {
        const { audio } = await boot();
        // Sparse-length the bus list to the ceiling (cheap: no elements allocated).
        audio._busList.length = 2097152;
        assert.throws(() => audio.createBus('one-too-many'), /ceiling/);
    });
});

// ---------------------------------------------------------------------------
// Auto-suspend
// ---------------------------------------------------------------------------

describe('auto-suspend', () => {
    it('suspends after N silent seconds and a play() wakes it', async () => {
        const { audio, ctx, tick } = await boot();
        assert.equal(audio.enableAutoSuspend({ after: 2 }), true);

        tick();                          // silence begins (marks _silentSince)
        assert.equal(ctx.state, 'running', 'not yet - under the threshold');

        ctx._advance(2.5);
        tick();                          // silent long enough -> suspend
        assert.equal(ctx.state, 'suspended');
        assert.equal(audio.isAutoSuspended(), true);
        assert.equal(audio.unlocked().peek(), true, 'unlock survives the suspend');

        const h = audio.play('laser');   // the wake path
        assert.equal(ctx.state, 'running', 'play() resumed the context');
        assert.equal(audio.isAutoSuspended(), false);
        assert.ok(h >= 0, 'and the triggering voice still played');
        assert.equal(audio.unlocked().peek(), true, 'unlock survives the resume');
    });

    it('does not suspend while a voice is sounding', async () => {
        const { audio, ctx, tick } = await boot();
        audio.enableAutoSuspend({ after: 1 });
        audio.play('laser');             // an active voice
        ctx._advance(3);
        tick(); tick();
        assert.equal(ctx.state, 'running', 'busy engine stays awake');
    });

    it('refuses to arm on iOS (returns false, stays off)', async () => {
        const { audio } = await boot({ navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' } });
        assert.equal(audio.enableAutoSuspend({ after: 1 }), false);
        assert.equal(audio._autoSuspend, false);
    });

    it('treats iPadOS-reporting-as-Mac (touch points) as iOS', async () => {
        const { audio } = await boot({ navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', maxTouchPoints: 5 } });
        assert.equal(audio.enableAutoSuspend(), false);
    });

    it('arms on a real desktop (Mac without touch)', async () => {
        const { audio } = await boot({ navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', maxTouchPoints: 0 } });
        assert.equal(audio.enableAutoSuspend(), true);
    });
});
