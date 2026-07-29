/**
 * @zakkster/lite-audio - hot-path parity.
 *
 * This test extracts the source text of play(), stop() and the per-bus write
 * effect straight out of Audio.js and hashes each. If a future edit touches one
 * of these bodies, the SHA moves and this test fails loudly, forcing the edit
 * to be a deliberate, reviewed change rather than an accident.
 *
 * History of the goldens:
 *   - AU0 / v1.1.1 (docs-and-tests) froze all three from the v1.1.0 source.
 *   - AU1 / v1.2.0 (mix intelligence) deliberately re-baselined TWO of them:
 *       * play(): one monomorphic `if (this._selfSuspended)` wake check for
 *         auto-suspend - zero-alloc, proven by the extended torture gate.
 *       * per-bus write effect: relocated verbatim into _buildBus() so
 *         createBus() can share it. The closure body is byte-IDENTICAL logic;
 *         only its lexical home moved, which is enough to move the SHA.
 *     stop() stayed frozen across both - the true innermost hot path is
 *     untouched, and this test still proves it.
 *
 * Update a golden ONLY when a change to that body is intended, and say so in
 * the CHANGELOG when you do.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'Audio.js'), 'utf8');

/** Slice a balanced-brace block starting at the first '{' at or after `anchor`. */
function block(anchor) {
    const i = SRC.indexOf(anchor);
    assert.ok(i >= 0, 'anchor not found (did a signature change?): ' + anchor);
    // Guard against an anchor that accidentally matches twice.
    assert.equal(SRC.indexOf(anchor, i + 1), -1, 'anchor is not unique: ' + anchor);
    let depth = 0;
    for (let k = SRC.indexOf('{', i); k < SRC.length; k++) {
        const c = SRC[k];
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return SRC.slice(i, k + 1);
    }
    throw new Error('unbalanced braces from anchor: ' + anchor);
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

// See file header for the golden history. stop() is the v1.1.0 original;
// play() and the bus effect were re-baselined in AU1 / v1.2.0.
const GOLDENS = [
    {
        name: 'play()',
        anchor: 'play(soundId, volume = 1, pan = 0, pitch = 1)',
        sha: '7acc22ba9fba6e77a20d87c75bccd010f599a581adac96c9723a07778e8596e5',
    },
    {
        name: 'stop()',
        anchor: 'stop(handle) {',
        sha: 'e00ae8408fd9f1fbe22097f5f6ef98e4ef685af7ad2d323fc9707bcd4c0aaff8',
    },
    {
        name: 'per-bus write effect',
        anchor: 'const busEffect = effect(() =>',
        sha: '8014426e778ee42020c390de347a6a96e865a9767242d4192cc2d73aaaaacdfc',
    },
];

describe('hot-path parity (docs-and-tests release changes no hot path)', () => {
    for (const g of GOLDENS) {
        it(g.name + ' is byte-identical to its v1.1.0 golden', () => {
            assert.equal(sha(block(g.anchor)), g.sha,
                g.name + ' hot path changed - if intentional, update the golden and the CHANGELOG');
        });
    }
});
