/**
 * Unit tests for tickerToCountry() in src/core/calendar.js — pure function,
 * no network needed (fetchCalendar() itself hits Finviz/TradingView live and
 * is intentionally not covered here).
 *
 * Run: node --test tests/calendar.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tickerToCountry } from '../src/core/calendar.js';

describe('tickerToCountry', () => {
  it('maps known country-ticker prefixes', () => {
    assert.equal(tickerToCountry('USUnemploymentRate'), 'US');
    assert.equal(tickerToCountry('GermanyIfoBusinessClimate'), 'DE');
    assert.equal(tickerToCountry('JapanCPI'), 'JP');
  });

  it('REGRESSION: does not silently default unmatched prefixes to US', () => {
    // Before the fix, any ticker prefix the mapping table didn't recognize
    // fell through to "US" — misattributing foreign events into the US bucket.
    assert.equal(tickerToCountry('BrazilSelicRate'), 'unknown');
    assert.equal(tickerToCountry(''), 'unknown');
  });
});
