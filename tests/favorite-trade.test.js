/**
 * Unit tests for computePositionSizing() in src/core/favorite-trade.js — pure
 * position-sizing math, no CDP/network needed (runFavoriteTrade() itself
 * drives a live TradingView chart and is intentionally not covered here).
 *
 * Run: node --test tests/favorite-trade.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computePositionSizing } from '../src/core/favorite-trade.js';

describe('computePositionSizing', () => {
  it('sizes a normal trade to exactly the 1% risk budget', () => {
    // €10k account, 1% = €100 max risk. risk/share = 2 -> 50 shares -> €100 loss = 1%.
    const res = computePositionSizing(50, 2, 10_000, 0.01);
    assert.equal(res.shares, 50);
    assert.equal(res.maxLoss, 100);
    assert.equal(res.actualRiskPct, 1);
    assert.equal(res.riskExceeded, false);
  });

  it('REGRESSION: flags riskExceeded and reports the real risk % for an expensive stock with a wide stop', () => {
    // Before the fix: Math.max(1, floor(...)) silently forced a 1-share trade
    // whenever risk/share > maxRisk, while riskPct was hardcoded to always
    // display the 1% target regardless of the real (higher) loss.
    // €10k account, 1% = €100 max risk, but a single share already risks €150.
    const res = computePositionSizing(800, 150, 10_000, 0.01);
    assert.equal(res.shares, 1);
    assert.equal(res.maxLoss, 150);
    assert.equal(res.actualRiskPct, 1.5);
    assert.equal(res.riskExceeded, true);
  });

  it('never sizes a position to zero shares, even for a wide stop', () => {
    const res = computePositionSizing(10, 1000, 10_000, 0.01);
    assert.equal(res.shares, 1);
    assert.equal(res.riskExceeded, true);
  });

  it('computes position value and its percentage of the account', () => {
    const res = computePositionSizing(20, 1, 10_000, 0.01); // 100 shares * €20 = €2000 = 20%
    assert.equal(res.shares, 100);
    assert.equal(res.posValue, 2000);
    assert.equal(res.posValuePct, 20);
  });
});
