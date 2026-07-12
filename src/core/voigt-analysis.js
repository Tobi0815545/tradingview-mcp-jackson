/**
 * Voigt Swing Analysis — Markttechnik nach Michael Voigt
 * "Das Große Buch der Markttechnik" / "Der Händler" (Band 1–8)
 *
 * Top-Down-Ansatz: Weekly Regime → Daily Setup → Entry Signal
 * Keine Indikator-Entscheidungen — ausschließlich Marktstruktur.
 */

// ── Swing High / Low Detektion (n-Bar-Regel) ──────────────────────────────────
// Ein Swing High ist signifikant, wenn mindestens n Bars links und rechts davon
// tiefere Hochs haben (sichtbar im Timeframe ohne Heranzoomen).

export function detectSwings(bars, n = 3) {
  const highs = [], lows = [];
  for (let i = n; i < bars.length - n; i++) {
    const hi = bars[i].high;
    const lo = bars[i].low;
    if (
      bars.slice(i - n, i).every(b => b.high < hi) &&
      bars.slice(i + 1, i + n + 1).every(b => b.high < hi)
    ) highs.push({ idx: i, price: hi });
    if (
      bars.slice(i - n, i).every(b => b.low > lo) &&
      bars.slice(i + 1, i + n + 1).every(b => b.low > lo)
    ) lows.push({ idx: i, price: lo });
  }
  return { highs, lows };
}

// ── HH / HL Trend-Struktur prüfen ─────────────────────────────────────────────
// Mindestens 2 aufeinanderfolgende Higher Highs / Higher Lows = bestätigter Uptrend

export function isHHHL(swingPoints, count = 2) {
  if (swingPoints.length < count) return false;
  const last = swingPoints.slice(-count);
  return last.every((p, i) => i === 0 || p.price > last[i - 1].price);
}

// ── Korrektur-Analyse (ab letztem Swing High bis heute) ───────────────────────
// Voigt: "gesunde Korrektur" = 3–20 Tage, Volumen rückläufig, 3-Wellen-Struktur

export function analyzeCorrection(bars, lastSwingHighIdx) {
  if (lastSwingHighIdx < 0 || lastSwingHighIdx >= bars.length - 1) {
    return { duration: 0, volDecreasing: null, ok: false, durationStatus: 'unbekannt', correctionLow: null };
  }
  const corrBars = bars.slice(lastSwingHighIdx + 1);
  const duration = corrBars.length;
  if (duration === 0) {
    return { duration: 0, volDecreasing: null, ok: false, durationStatus: 'kein Pullback', correctionLow: null };
  }

  const correctionLow = Math.min(...corrBars.map(b => b.low));

  const vols = corrBars.map(b => b.volume || 0);
  const half = Math.ceil(vols.length / 2);
  const firstHalfAvg  = vols.slice(0, half).reduce((s, v) => s + v, 0) / half || 0;
  const secondHalfAvg = vols.slice(-half).reduce((s, v) => s + v, 0) / half || 0;
  const volDecreasing = firstHalfAvg > 0 && secondHalfAvg < firstHalfAvg * 0.9;

  let durationStatus;
  if (duration < 3)       durationStatus = 'zu frisch';
  else if (duration > 20) durationStatus = 'zu lang';
  else                    durationStatus = 'ok';

  return {
    duration,
    volDecreasing,
    durationStatus,
    ok: durationStatus === 'ok' && volDecreasing,
    correctionLow,
  };
}

// ── Haupt-Analyse ──────────────────────────────────────────────────────────────
/**
 * Führt eine vollständige Voigt Swing Analyse durch.
 *
 * @param {Object}  params
 * @param {Array}   params.dailyBars  - Individuelle Daily-OHLCV-Bars (≥20, empfohlen 60)
 * @param {boolean} params.stage2     - Stage-2-Uptrend (Preis > SMA150 > SMA200)
 * @param {number|null} params.mansRS - Mansfield RS-Wert (>0 = Outperformer)
 * @param {number|null} params.macdH  - MACD-Histogramm-Wert
 *
 * @returns {Object|null}  null wenn nicht genug Daten
 */
export function runVoigtAnalysis({ dailyBars, stage2, mansRS, macdH }) {
  if (!dailyBars || dailyBars.length < 15) return null;

  const { highs, lows } = detectSwings(dailyBars, 3);
  const hh = isHHHL(highs, 2);
  const hl = isHHHL(lows, 2);
  const hasTrend = hh && hl;

  const lastSwingHighIdx   = highs.length > 0 ? highs[highs.length - 1].idx : -1;
  const lastSwingHighPrice = highs.length > 0 ? highs[highs.length - 1].price : null;

  // Swing Low VOR dem letzten Swing High (Basis des letzten Aufwärtsimpulses)
  const prevSwingLowObj  = [...lows].reverse().find(l => l.idx < lastSwingHighIdx);
  const prevSwingLow     = prevSwingLowObj?.price ?? null;

  // Letztes Swing Low (nach dem letzten Swing High = tiefste Stelle der laufenden Korrektur)
  const lastSwingLowObj  = lows.length > 0 ? lows[lows.length - 1] : null;
  const lastSwingLow     = lastSwingLowObj?.price ?? null;

  const correction = analyzeCorrection(dailyBars, lastSwingHighIdx);

  // ── Weekly Regime Proxy ──────────────────────────────────────────────────────
  // Stage-2 (Preis > SMA150 > SMA200) entspricht Voigts "Markup"-Phase auf Weekly.
  // Mansfield RS ≥ 0 = Aktie schlägt den Markt (relative Stärke).
  let weeklyRegime;
  if (stage2 && (mansRS == null || mansRS >= 0)) {
    weeklyRegime = 'GRÜN';
  } else if (stage2) {
    weeklyRegime = 'GELB';   // Stage-2, aber Underperformer
  } else {
    weeklyRegime = 'ROT';    // Kein Stage-2 = kein Long
  }

  // ── Daily Confluence Score ───────────────────────────────────────────────────
  // Elemente nach Voigt-Gewichtung:
  //   HH+HL Struktur (stark)  → +2
  //   Stage-2 / EMA-Support   → +1
  //   Mehrere Swing Highs als Support-Cluster → +1
  //   MACD-Histogramm positiv (Momentum)      → +1
  let confluenceCount = 0;
  if (hasTrend)                              confluenceCount += 2;
  if (stage2)                                confluenceCount += 1;
  if (highs.length >= 3)                     confluenceCount += 1;  // Support-Cluster
  if (macdH != null && Number(macdH) > 0)   confluenceCount += 1;

  // Qualität A (≥4), B (3), C (<3) — unter B nicht handeln
  const setupQuality = confluenceCount >= 4 ? 'A' : confluenceCount === 3 ? 'B' : 'C';

  // ── Setup aktiv? ─────────────────────────────────────────────────────────────
  // Regime GRÜN + Trendstruktur + gesunde Korrektur = Setup aktiv
  const setupActive = weeklyRegime !== 'ROT' && hasTrend && correction.ok;

  return {
    weeklyRegime,         // 'GRÜN' | 'GELB' | 'ROT'
    hasTrend,             // boolean
    hh,                   // Higher Highs bestätigt
    hl,                   // Higher Lows bestätigt
    correction,           // { duration, volDecreasing, durationStatus, ok, correctionLow }
    setupQuality,         // 'A' | 'B' | 'C'
    setupActive,          // boolean — Voigt-Setup aktiv
    confluenceCount,
    // Preisstruktur für Setup-Berechnung
    lastSwingHighIdx,     // Bar-Index des letzten Swing Highs
    lastSwingHighPrice,   // Preis des letzten Swing Highs
    prevSwingLow,         // Swing Low vor dem letzten SH (Basis des letzten Impulses)
    lastSwingLow,         // Letztes Swing Low (= tiefster Punkt der laufenden Korrektur)
    correctionLow:        correction.correctionLow,   // Tief aller Korrektur-Bars
    swingHighs:           highs.slice(-3).map(h => h.price),
    swingLows:            lows.slice(-3).map(l => l.price),
  };
}

// ── Voigt Trade Setup Berechnung ──────────────────────────────────────────────
/**
 * Berechnet das konkrete Trade-Setup nach Voigt-Regeln.
 *
 * Voigt-Prinzipien:
 *   Entry:  Aktueller Kurs (Limit-Entry am Ende der Korrektur)
 *   Stop:   Unter dem Swing-Tief der Korrektur (Strukturstop — KEIN fixer %-Stop)
 *   CRV:    Qualität A = min. 3:1 | Qualität B = min. 2:1 | Qualität C = nicht handeln
 *   Target: 1) Gemessener Schub (Measured Move) → letzter Impuls projiziert ab Korrekturtief
 *           2) Letztes Swing High (Widerstandszone)
 *           3) Mindest-CRV-Ziel (Fallback)
 *
 * @param {Array}  dailyBars  - OHLCV-Bars (dieselben wie für runVoigtAnalysis)
 * @param {Object} voigt      - Rückgabe von runVoigtAnalysis()
 * @returns {Object|null}     null wenn kein handelbares Setup möglich
 */
export function calcVoigtSetup(dailyBars, voigt) {
  if (!voigt || !dailyBars?.length) return null;

  // Nur wenn Voigt-Setup aktiv (GRÜN/GELB + HH/HL + gesunde Korrektur)
  if (!voigt.setupActive) return null;

  // Qualität C → nicht handeln (Confluenz zu niedrig)
  if (voigt.setupQuality === 'C') {
    return {
      tradeable: false,
      setupQuality: 'C',
      note: 'Qualität C — Confluenz zu niedrig, Setup nicht handelbar nach Voigt',
    };
  }

  const last  = dailyBars[dailyBars.length - 1];
  const entry = last.close;

  // ── Strukturstop: unter Swing-Tief der Korrektur ────────────────────────────
  // Voigt: Stop liegt IMMER unter dem letzten signifikanten Swing Low,
  // nie ein fixer % — der Markt gibt den Stop vor.
  const corrLow = voigt.correctionLow;
  if (!corrLow || corrLow <= 0) return null;

  // Falls Kurs bereits unter dem Korrekturtief → Setup gescheitert
  if (entry <= corrLow) {
    return {
      tradeable: false,
      setupQuality: voigt.setupQuality,
      note: `Kurs ${entry.toFixed(2)} unter Korrekturtief ${corrLow.toFixed(2)} — Setup ungültig`,
    };
  }

  const STOP_BUFFER = 0.005;   // 0.5% Puffer unter Swing-Tief
  const stop        = corrLow * (1 - STOP_BUFFER);
  const risk        = entry - stop;

  // Plausibilitätsprüfung: Stop muss zwischen 0.5% und 15% unter Entry liegen
  const stopPct = risk / entry;
  if (stopPct < 0.005) {
    return {
      tradeable: false,
      setupQuality: voigt.setupQuality,
      note: `Stop zu eng (${(stopPct * 100).toFixed(1)}%) — Kurs zu nahe am Korrekturtief`,
    };
  }
  if (stopPct > 0.15) {
    return {
      tradeable: false,
      setupQuality: voigt.setupQuality,
      note: `Stop zu weit (${(stopPct * 100).toFixed(1)}%) — Korrektur zu tief (>15%)`,
    };
  }

  // ── Mindest-CRV nach Qualität ────────────────────────────────────────────────
  // Voigt: A = 3:1, B = 2:1. Darunter kein Trade.
  const minCrv = voigt.setupQuality === 'A' ? 3.0 : 2.0;

  // ── Target: Gemessener Schub (Measured Move) ─────────────────────────────────
  // Letzter Impuls = letztes Swing High − Swing Low davor (Basis des Impulses)
  // Projiziert ab Korrekturtief = realistisches Kursziel in Trendfortsetzung
  let target       = null;
  let targetSource = 'min_crv';
  let measuredMove = null;

  const lastSH = voigt.lastSwingHighPrice;
  const prevSL = voigt.prevSwingLow;

  if (lastSH && prevSL && lastSH > prevSL) {
    measuredMove         = lastSH - prevSL;
    const measuredTarget = corrLow + measuredMove;
    if (measuredTarget > entry + risk * minCrv) {
      target       = measuredTarget;
      targetSource = 'measured_move';
    }
  }

  // Fallback: letztes Swing High als Widerstandsziel
  if (!target && lastSH && lastSH > entry) {
    const rrSH = (lastSH - entry) / risk;
    if (rrSH >= minCrv) {
      target       = lastSH;
      targetSource = 'swing_high';
    }
  }

  // Kein technisch begründetes Ziel gefunden (weder Measured Move noch Swing-High
  // erreichen die Mindest-CRV) → nicht handelbar. Vorher wurde hier künstlich
  // target = entry + risk*minCrv gesetzt, wodurch actualCrv >= minCrv IMMER erfüllt
  // war und dieses Tradeable-Gate faktisch nie greifen konnte.
  if (!target) {
    return {
      tradeable: false,
      setupQuality: voigt.setupQuality,
      correctionLow: corrLow,
      entry, stop, risk,
      minCrv,
      stopPct: +(stopPct * 100).toFixed(1),
      note: `Kein Ziel mit CRV ≥ ${minCrv}:1 gefunden (weder Measured Move noch Swing-High) — kein Trade`,
    };
  }

  const actualCrv = (target - entry) / risk;
  const tradeable = actualCrv >= minCrv;

  return {
    // Setup-Preise
    entry,
    stop,
    target,
    risk,

    // CRV-Analyse
    crv:     +actualCrv.toFixed(2),
    minCrv,
    tradeable,

    // Quellen & Kontext
    source:         'voigt',
    stopSource:     'voigt_swing_low',
    targetSource,               // 'measured_move' | 'swing_high'
    correctionLow:  corrLow,    // Swing-Tief der Korrektur (Basis des Strukturstops)
    measuredMove,               // Höhe des letzten Impulses (für Kommentar)
    setupQuality:   voigt.setupQuality,
    weeklyRegime:   voigt.weeklyRegime,

    // Zusatzinfos für Drawing-Labels
    stopPct:        +(stopPct * 100).toFixed(1),
    gainPct:        +(((target - entry) / entry) * 100).toFixed(1),

    // tradeable ist hier immer true — beide Pfade, die `target` setzen, prüfen die
    // Mindest-CRV bereits selbst. Ein "CRV zu niedrig"-Fall wird stattdessen oben
    // über den `!target`-Zweig abgefangen.
    note: null,
  };
}
