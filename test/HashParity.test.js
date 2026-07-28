/**
 * @zakkster/lite-audio - hot-path parity (AU0 / v1.1.1).
 *
 * v1.1.1 is a docs-and-tests release: it adds a handle contract, a branded type,
 * a decision record and a zero-GC gate, plus one cold fail-closed guard in init().
 * It changes NO hot path. This test proves that mechanically - it extracts the
 * source text of play(), stop() and the per-bus write effect straight out of
 * Audio.js and hashes each. If a future edit touches one of these three bodies,
 * the SHA moves and this test fails loudly, forcing the edit to be a deliberate,
 * reviewed change to a hot path rather than an accident under a "docs" banner.
 *
 * Update a golden ONLY when a hot-path change is intended, and say so in the
 * CHANGELOG when you do.
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

// Goldens captured from the v1.1.0 source before any AU0 edit. See file header.
const GOLDENS = [
    {
        name: 'play()',
        anchor: 'play(soundId, volume = 1, pan = 0, pitch = 1)',
        sha: 'a0f17c4bb6af3519680eb662e092debbcf0ea396ef4bc2905ffa885f4f25b37a',
    },
    {
        name: 'stop()',
        anchor: 'stop(handle) {',
        sha: 'e00ae8408fd9f1fbe22097f5f6ef98e4ef685af7ad2d323fc9707bcd4c0aaff8',
    },
    {
        name: 'per-bus write effect',
        anchor: 'const busEffect = effect(() =>',
        sha: '33b5f51fd67cb6f8c41c4071a4d756654b86cbdd4e3de962b78cb1bc786d7dbb',
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
