/**
 * Unit tests for scoreCandidate() in src/core/scanner.js — pure CANSLIM
 * scoring logic, no network needed (runScan() itself hits the TradingView
 * scanner API live and is intentionally not covered here).
 *
 * Run: node --test tests/scanner-scoring.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scoreCandidate } from '../src/core/scanner.js';

// Neutral baseline: fails every one of the 5 criteria.
function baseCandidate(overrides = {}) {
  return {
    close: 100, ema50: 110, sma150: 120, sma200: 130,   // Stage 2: fails (close < ema50)
    high52w: 200,                                        // 50% under high -> base criterion fails
    perf_3m: 0,                                           // relative strength: fails
    rsi: 50,
    rel_volume: 1, macd_hist: 0,                          // volume pattern: fails
    eps_growth: null, rev_growth: null,                   // fundamentals: N/V
    ...overrides,
  };
}

describe('scoreCandidate — Stage 2 (★1)', () => {
  it('awards the star when price is above all three rising MAs', () => {
    const { stars, criteria } = scoreCandidate(baseCandidate({ close: 150, ema50: 130, sma150: 120, sma200: 110 }));
    assert.equal(stars, 1);
    assert.match(criteria.stage2, /✓ Stage 2/);
  });
});

describe('scoreCandidate — fundamentals (★5, rev_growth regression)', () => {
  it('awards a full star for strong EPS growth alone', () => {
    const { stars, criteria } = scoreCandidate(baseCandidate({ eps_growth: 30 }));
    assert.equal(stars, 1);
    assert.match(criteria.fundamentals, /✓ EPS \+30\.0% YoY/);
  });

  it('awards half a star for moderate EPS growth (15-25%)', () => {
    const { stars, criteria } = scoreCandidate(baseCandidate({ eps_growth: 18 }));
    assert.equal(stars, 0.5);
    assert.match(criteria.fundamentals, /unter 25%/);
  });

  it('REGRESSION: falls back to revenue growth when EPS is weak but revenue is strong', () => {
    // Before the fix, rev_growth was hardcoded to null in scanner.js, so this
    // branch could never be reached even when the underlying data existed.
    const { stars, criteria } = scoreCandidate(baseCandidate({ eps_growth: 5, rev_growth: 35 }));
    assert.equal(stars, 0.5);
    assert.match(criteria.fundamentals, /Umsatz \+35\.0%/);
  });

  it('REGRESSION: credits revenue growth even when EPS data is completely missing', () => {
    // Concrete real-world case found while wiring up total_revenue_yoy_growth_fy:
    // young/unprofitable growth stocks (e.g. ALAB) report null EPS but real revenue growth.
    const { stars, criteria } = scoreCandidate(baseCandidate({ eps_growth: null, rev_growth: 25 }));
    assert.equal(stars, 0.5);
    assert.match(criteria.fundamentals, /Umsatz \+25\.0%.*EPS N\/V/);
  });

  it('scores zero when both EPS and revenue growth are weak', () => {
    const { stars, criteria } = scoreCandidate(baseCandidate({ eps_growth: 5, rev_growth: 5 }));
    assert.equal(stars, 0);
    assert.match(criteria.fundamentals, /✗ EPS/);
  });

  it('scores zero and flags "N/V" when neither EPS nor revenue data exists', () => {
    const { stars, criteria } = scoreCandidate(baseCandidate());
    assert.equal(stars, 0);
    assert.match(criteria.fundamentals, /Fundamentals N\/V/);
  });
});

describe('scoreCandidate — full 5-star setup', () => {
  it('adds up all five criteria for a textbook CANSLIM candidate', () => {
    const candidate = {
      close: 100, ema50: 95, sma150: 90, sma200: 85,      // Stage 2 ✓ (+1)
      high52w: 103,                                        // 2.9% under high -> tight base ✓
      perf_3m: 25,                                          // strong RS ✓ (+1)
      rsi: 60,                                               // within tight-base RSI band
      rel_volume: 1.8, macd_hist: 1.2,                       // breakout volume ✓ (+1)
      eps_growth: 40, rev_growth: 30,                        // fundamentals ✓ (+1)
    };
    const { stars } = scoreCandidate(candidate);
    assert.equal(stars, 5);
  });
});
