/**
 * Unit tests for the pure risk-management functions in scalper-run.js
 * (computeBuySizeUsdt, shouldStopLoss, circuitBreakerTripped). No network,
 * no BitGet API calls — main() itself is intentionally not covered here.
 *
 * Run: node --test tests/scalper-risk.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeBuySizeUsdt, shouldStopLoss, circuitBreakerTripped } from '../scalper-run.js';

describe('computeBuySizeUsdt', () => {
  it('caps the buy size to 25% of total portfolio value, not 90% of USDT', () => {
    // Total value = 1000 USDT + 0 XRP = 1000 -> cap = 250, well under the 900 the old code used.
    const size = computeBuySizeUsdt({ usdt: 1000, xrp: 0 }, 1, 0.25);
    assert.equal(size, 250);
  });

  it('accounts for existing XRP holdings in the total portfolio value', () => {
    // 500 USDT + 100 XRP @ $2 = $200 -> total $700 -> cap = 25% * 700 = 175, but capped at available USDT (500) -> 175
    const size = computeBuySizeUsdt({ usdt: 500, xrp: 100 }, 2, 0.25);
    assert.equal(size, 175);
  });

  it('never exceeds the available USDT balance', () => {
    // Total value dominated by XRP -> 25% of total would exceed the small USDT balance
    const size = computeBuySizeUsdt({ usdt: 10, xrp: 1000 }, 5, 0.25);
    assert.equal(size, 10); // capped by available USDT, not by the (much larger) 25% of total
  });
});

describe('shouldStopLoss', () => {
  it('triggers once price falls to or below the stop-loss threshold', () => {
    // buyPrice=100, 1% stop -> trigger at <= 99
    assert.equal(shouldStopLoss(99, 100, 0.01), true);
    assert.equal(shouldStopLoss(99.5, 100, 0.01), false);
  });

  it('does not trigger when there is no open position (buyPrice null)', () => {
    assert.equal(shouldStopLoss(50, null, 0.01), false);
  });
});

describe('circuitBreakerTripped', () => {
  it('trips once the cumulative loss reaches the configured percentage of the starting value', () => {
    // starting value 1000, 2% threshold -> trips at -20 or worse
    assert.equal(circuitBreakerTripped(-20, 1000, 0.02), true);
    assert.equal(circuitBreakerTripped(-19.99, 1000, 0.02), false);
  });

  it('does not trip on a profitable or break-even run', () => {
    assert.equal(circuitBreakerTripped(5, 1000, 0.02), false);
    assert.equal(circuitBreakerTripped(0, 1000, 0.02), false);
  });
});
