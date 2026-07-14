/**
 * Unit tests for classifyOptions() in src/core/options.js — pure function,
 * no network needed (fetchOptionsIv itself requires live Yahoo Finance access
 * and is intentionally not covered here).
 *
 * Run: node --test tests/options.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOptions } from '../src/core/options.js';

describe('classifyOptions', () => {
  it('returns no setup when IV is missing', () => {
    assert.deepEqual(classifyOptions({ iv_pct: null, stage2: true, rsi: 50 }), { strategy: '–', stars: 0 });
  });

  it('returns no setup when IV is NaN', () => {
    assert.deepEqual(classifyOptions({ iv_pct: NaN, stage2: true, rsi: 50 }), { strategy: '–', stars: 0 });
  });

  it('Iron Condor: range-bound RSI + high IV', () => {
    assert.deepEqual(classifyOptions({ iv_pct: 60, stage2: false, rsi: 50 }), { strategy: 'IC', stars: 3 });
  });

  it('Covered Call: Stage-2 uptrend + moderate IV', () => {
    assert.deepEqual(classifyOptions({ iv_pct: 35, stage2: true, rsi: 65 }), { strategy: 'CC', stars: 2 });
  });

  it('Covered Call gets 3 stars when IV is high', () => {
    assert.deepEqual(classifyOptions({ iv_pct: 60, stage2: true, rsi: 65 }), { strategy: 'CC', stars: 3 });
  });

  it('Cash-Secured Put: consolidation near support + moderate IV', () => {
    assert.deepEqual(classifyOptions({ iv_pct: 35, stage2: false, rsi: 35 }), { strategy: 'CSP', stars: 2 });
  });

  it('Cash-Secured Put gets 3 stars when IV is high', () => {
    assert.deepEqual(classifyOptions({ iv_pct: 60, stage2: false, rsi: 35 }), { strategy: 'CSP', stars: 3 });
  });

  it('Long Call: strong uptrend + low IV', () => {
    assert.deepEqual(classifyOptions({ iv_pct: 20, stage2: true, rsi: 70 }), { strategy: 'Long C', stars: 2 });
  });

  it('falls back to a 1-star Covered Call when only high IV matches', () => {
    assert.deepEqual(classifyOptions({ iv_pct: 55, stage2: false, rsi: 90 }), { strategy: 'CC', stars: 1 });
  });

  it('returns no setup when nothing matches', () => {
    assert.deepEqual(classifyOptions({ iv_pct: 10, stage2: false, rsi: 90 }), { strategy: '–', stars: 0 });
  });
});
