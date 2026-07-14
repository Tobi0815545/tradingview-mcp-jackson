/**
 * Unit tests for src/core/voigt-analysis.js — pure functions, no CDP/network needed.
 *
 * Run: node --test tests/voigt-analysis.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectSwings, isHHHL, analyzeCorrection, calcVoigtSetup } from '../src/core/voigt-analysis.js';

describe('detectSwings', () => {
  it('finds a swing high in a simple peak pattern', () => {
    const bars = [
      { high: 10, low: 8 }, { high: 11, low: 9 }, { high: 12, low: 10 },
      { high: 15, low: 13 }, // peak at idx 3
      { high: 12, low: 10 }, { high: 11, low: 9 }, { high: 10, low: 8 },
    ];
    const { highs } = detectSwings(bars, 3);
    assert.equal(highs.length, 1);
    assert.equal(highs[0].idx, 3);
    assert.equal(highs[0].price, 15);
  });

  it('returns no swings when there are too few bars', () => {
    const bars = [{ high: 10, low: 8 }, { high: 11, low: 9 }];
    const { highs, lows } = detectSwings(bars, 3);
    assert.deepEqual(highs, []);
    assert.deepEqual(lows, []);
  });
});

describe('isHHHL', () => {
  it('true for strictly ascending swing points', () => {
    assert.equal(isHHHL([{ price: 10 }, { price: 12 }], 2), true);
  });
  it('false when the sequence is not ascending', () => {
    assert.equal(isHHHL([{ price: 12 }, { price: 10 }], 2), false);
  });
  it('false when there are fewer points than required', () => {
    assert.equal(isHHHL([{ price: 10 }], 2), false);
  });
});

describe('analyzeCorrection', () => {
  it('flags a correction with rising volume as not ok', () => {
    const bars = [
      {}, {}, {}, // padding before swing high
      { low: 100, volume: 1000 }, { low: 98, volume: 1000 },
      { low: 96, volume: 2000 }, { low: 95, volume: 3000 },
    ];
    const res = analyzeCorrection(bars, 2); // lastSwingHighIdx=2
    assert.equal(res.volDecreasing, false);
    assert.equal(res.ok, false);
  });

  it('flags a healthy correction (duration ok, volume decreasing) as ok', () => {
    const corr = [
      { low: 100, volume: 3000 }, { low: 98, volume: 2800 }, { low: 97, volume: 2600 },
      { low: 96, volume: 1000 }, { low: 95, volume: 900 }, { low: 94, volume: 800 },
    ];
    const bars = [{}, ...corr];
    const res = analyzeCorrection(bars, 0);
    assert.equal(res.duration, 6);
    assert.equal(res.durationStatus, 'ok');
    assert.equal(res.volDecreasing, true);
    assert.equal(res.ok, true);
  });
});

describe('calcVoigtSetup', () => {
  const baseBars = [{ close: 110 }];

  it('returns null when the setup is not active', () => {
    const voigt = { setupActive: false };
    assert.equal(calcVoigtSetup(baseBars, voigt), null);
  });

  it('rejects quality-C setups without computing a target', () => {
    const voigt = { setupActive: true, setupQuality: 'C', correctionLow: 100 };
    const res = calcVoigtSetup(baseBars, voigt);
    assert.equal(res.tradeable, false);
    assert.match(res.note, /Qualität C/);
  });

  it('returns null when there is no correction low', () => {
    const voigt = { setupActive: true, setupQuality: 'B', correctionLow: null };
    assert.equal(calcVoigtSetup(baseBars, voigt), null);
  });

  it('rejects when price already fell back below the correction low', () => {
    const voigt = { setupActive: true, setupQuality: 'B', correctionLow: 120 };
    const res = calcVoigtSetup(baseBars, voigt); // entry=110 <= corrLow=120
    assert.equal(res.tradeable, false);
    assert.match(res.note, /unter Korrekturtief/);
  });

  it('rejects when the structural stop would be wider than 15%', () => {
    const voigt = { setupActive: true, setupQuality: 'B', correctionLow: 90 }; // ~18% below entry
    const res = calcVoigtSetup(baseBars, voigt);
    assert.equal(res.tradeable, false);
    assert.match(res.note, /zu weit/);
  });

  it('uses the measured-move target when it clears the minimum CRV', () => {
    // entry=110, corrLow=100 -> stop=99.5, risk=10.5. minCrv(B)=2 -> min target 121.
    // measuredMove = lastSH(140) - prevSL(100) = 40 -> measuredTarget = 100+40 = 140 > 121.
    const voigt = {
      setupActive: true, setupQuality: 'B', correctionLow: 100,
      lastSwingHighPrice: 140, prevSwingLow: 100,
    };
    const res = calcVoigtSetup(baseBars, voigt);
    assert.equal(res.tradeable, true);
    assert.equal(res.targetSource, 'measured_move');
    assert.equal(res.target, 140);
  });

  it('falls back to the last swing high when measured-move is insufficient', () => {
    // measuredMove = 115 - 100 = 15 -> measuredTarget = 115, not > entry+risk*minCrv(121) -> rejected.
    // swing-high fallback: lastSH=125, rrSH = (125-110)/10.5 ≈ 1.43 < minCrv(2) -> also rejected -> no target.
    // Use a lastSH that clears minCrv via swing-high alone.
    const voigt = {
      setupActive: true, setupQuality: 'B', correctionLow: 100,
      lastSwingHighPrice: 132, prevSwingLow: 100, // measuredTarget=132, threshold=121 -> would win as measured_move
    };
    // To isolate the swing-high path, drop prevSwingLow so measured-move can't be computed.
    const voigtSwingOnly = { ...voigt, prevSwingLow: null };
    const res = calcVoigtSetup(baseBars, voigtSwingOnly);
    assert.equal(res.tradeable, true);
    assert.equal(res.targetSource, 'swing_high');
    assert.equal(res.target, 132);
  });

  it('REGRESSION: marks the setup not tradeable when no target clears the minimum CRV (no synthetic min-CRV target)', () => {
    // entry=110, corrLow=100 -> stop=99.5, risk=10.5, minCrv(B)=2 -> need target > 121.
    // lastSwingHighPrice=115 is below the 121 threshold on every path, so neither
    // measured_move nor swing_high should produce a valid target.
    // Before the fix, calcVoigtSetup silently synthesized target = entry + risk*minCrv,
    // which always satisfies actualCrv >= minCrv and made this branch unreachable.
    const voigt = {
      setupActive: true, setupQuality: 'B', correctionLow: 100,
      lastSwingHighPrice: 115, prevSwingLow: 100,
    };
    const res = calcVoigtSetup(baseBars, voigt);
    assert.equal(res.tradeable, false);
    assert.equal(res.target, undefined);
    assert.match(res.note, /Kein Ziel mit CRV/);
  });
});
