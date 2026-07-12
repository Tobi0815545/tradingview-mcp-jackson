/**
 * favorite-trade.js — Claudias Lieblingstrade
 *
 * Wählt den besten CANSLIM-Kandidaten aus den Scanner-Ergebnissen,
 * verfeinert das Setup mit Pine-Indikatoren (Support/Resistance),
 * zeichnet Entry-Zone, Stop-Loss und Target auf den Chart
 * und liefert Screenshot + Analyse für den Daily Brief.
 *
 * Setup-Hierarchie:
 *   1. Pine-Levels (horizontale Linien aus aktiven Custom-Indikatoren)
 *   2. ATR + Swing-Low als Fallback (wenn Pine-Levels nicht plausibel)
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getState, setSymbol, setTimeframe, setVisibleRange } from "./chart.js";
import { getOhlcv, getPineLines, getPineLabels, getPineBoxes } from "./data.js";
import { drawShape, clearAll } from "./drawing.js";
import { captureScreenshot } from "./capture.js";
import { runVoigtAnalysis, calcVoigtSetup } from "./voigt-analysis.js";
import { fetchWatchlistStage2 } from "./market.js";
import { evaluate, clickAt } from "../connection.js";
import Anthropic from "@anthropic-ai/sdk";

const __dirname_ft = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(dirname(dirname(__dirname_ft)), 'screenshots');

// ── Positionsgrößen-Konfiguration ────────────────────────────────────────────
const ACCOUNT_SIZE = 10_000;   // €10.000 Kontogröße
const RISK_PCT     = 0.01;     // 1% Risiko pro Trade (Voigt-Regel: max. 1R riskieren)

// ── Symbol normalisieren (Scanner-Notation → Chart-Notation) ─────────────────
// "LSIN_DLY:0NUX" → "LSIN:0NUX"   |   "NYSE:PRY" → "NYSE:PRY"

function normalizeSymbol(raw) {
  return raw.includes(":")
    ? raw.replace(/^([^:]+)_DLY:/, "$1:").replace(/^([^:]+)_DELAYED:/, "$1:")
    : raw;
}

// ── Top-N-Kandidaten ranken ───────────────────────────────────────────────────
// Gibt die besten N Kandidaten nach CANSLIM-Sternen + Market Cap zurück.
// Stage-2-Bonus wird in rankWithStage2() ergänzt (braucht async REST-Call).

function topNCandidates(scanData, n = 5) {
  if (!scanData) return [];
  const all = [...(scanData.us_results || []), ...(scanData.europe_results || [])];
  return [...all]
    .sort((a, b) => {
      if ((b.stars ?? 0) !== (a.stars ?? 0)) return (b.stars ?? 0) - (a.stars ?? 0);
      return (b.market_cap_bn ?? 0) - (a.market_cap_bn ?? 0);
    })
    .slice(0, n);
}

// ── ATR berechnen ─────────────────────────────────────────────────────────────

function calcAtr(bars, period = 14) {
  if (!bars || bars.length < period + 1) return null;
  const recent = bars.slice(-(period + 1));
  const trValues = recent.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const prev = recent[i - 1];
    return Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close));
  });
  return trValues.slice(-period).reduce((s, v) => s + v, 0) / period;
}

// ── Pine-Levels aus allen aktiven Indikatoren sammeln ────────────────────────
// Kombiniert Pine-Lines + Pine-Label-Preise zu einer sortierten Level-Liste

async function collectPineLevels() {
  const levels = [];

  // Pine-Lines (line.new Objekte)
  try {
    const linesResult = await getPineLines({});
    for (const study of linesResult.studies ?? []) {
      for (const price of study.horizontal_levels ?? []) {
        if (price > 0) levels.push(price);
      }
    }
  } catch { /* Pine-Lines nicht verfügbar */ }

  // Pine-Labels (label.new Objekte mit Preis)
  try {
    const labelsResult = await getPineLabels({});
    for (const study of labelsResult.studies ?? []) {
      for (const lbl of study.labels ?? []) {
        if (lbl.price > 0) levels.push(lbl.price);
      }
    }
  } catch { /* Pine-Labels nicht verfügbar */ }

  // Pine-Boxes (box.new — z.B. SR Channel) → Top und Bottom als Levels
  try {
    const boxesResult = await getPineBoxes({});
    for (const study of boxesResult.studies ?? []) {
      for (const box of study.boxes ?? []) {
        if (box.top  > 0) levels.push(box.top);
        if (box.bottom > 0) levels.push(box.bottom);
      }
    }
  } catch { /* Pine-Boxes nicht verfügbar */ }

  // Deduplizieren (±0.1% als gleich) und sortieren
  const sorted = [...new Set(levels.map((p) => Math.round(p * 100) / 100))].sort((a, b) => a - b);
  return sorted;
}

// ── Pine-basiertes Setup ──────────────────────────────────────────────────────
// Sucht nächsten Support unter Entry und nächsten Widerstand über Entry.
// Gibt null zurück wenn Levels nicht plausibel (zu eng, zu weit, schlechtes R:R).

function calcSetupFromPine(entry, pineLevels, atr) {
  if (!pineLevels.length || !atr) return null;

  const MIN_STOP_PCT  = 0.015;   // Stop mind. 1.5% unter Entry
  const MAX_STOP_PCT  = 0.12;    // Stop max. 12% unter Entry
  const MIN_RR        = 1.5;     // Mindest-R:R

  // Support: Levels unterhalb Entry — nächstes (= höchstes unter Entry), 0.5% Buffer
  const supports = pineLevels
    .filter((p) => p < entry * (1 - MIN_STOP_PCT * 0.5))  // muss erkennbar unter Entry sein
    .sort((a, b) => b - a);                                // absteigend → nächstes zuerst

  // Resistance: Levels oberhalb Entry — nächstes (= niedrigstes über Entry)
  const resistances = pineLevels
    .filter((p) => p > entry * 1.005)
    .sort((a, b) => a - b);                                // aufsteigend → nächstes zuerst

  if (!supports.length) return null;

  const stopLevel   = supports[0];
  const stopWithBuf = stopLevel * 0.995;               // 0.5% unter Support-Level
  const stopPct     = (entry - stopWithBuf) / entry;

  // Stop-Validierung
  if (stopPct < MIN_STOP_PCT || stopPct > MAX_STOP_PCT) return null;

  const risk = entry - stopWithBuf;

  // Target: Pine-Resistance oder 2:1 ATR-Fallback
  let target = null;
  let targetSource = "2:1";
  if (resistances.length) {
    const rr = (resistances[0] - entry) / risk;
    if (rr >= MIN_RR) {
      target       = resistances[0];
      targetSource = "pine_resistance";
    }
  }
  if (!target) {
    target       = entry + risk * 2;
    targetSource = "2:1";
  }

  return {
    entry,
    stop:          stopWithBuf,
    target,
    risk,
    atr,
    stopLevel,                       // Das Pine-Level auf dem der Stop basiert
    targetSource,
    source:        "pine",
    pineLevelsUsed: { support: supports.slice(0, 3), resistance: resistances.slice(0, 3) },
  };
}

// ── ATR-basiertes Setup (Fallback) ────────────────────────────────────────────

function calcSetupFromAtr(bars, entry, atr) {
  if (!atr) return null;
  const recent   = bars.slice(-10);
  const swingLow = Math.min(...recent.map((b) => b.low));
  const stopByAtr   = entry - atr * 1.5;
  const stopBySwing = swingLow * 0.995;
  const stop        = Math.max(stopByAtr, stopBySwing);
  const risk        = entry - stop;
  if (risk <= 0) return null;
  return { entry, stop, target: entry + risk * 2, risk, atr, source: "atr" };
}

// ── Zeitstempel für Drawings ──────────────────────────────────────────────────

function nowTs() { return Math.floor(Date.now() / 1000); }

// ── Claude-Kommentar ──────────────────────────────────────────────────────────

async function generateTradeComment(candidate, setup, ohlcv, voigt) {
  try {
    const client = new Anthropic();
    const rrRatio = ((setup.target - setup.entry) / setup.risk).toFixed(1);
    const stopPct = ((setup.risk / setup.entry) * 100).toFixed(1);
    const gainPct = (((setup.target - setup.entry) / setup.entry) * 100).toFixed(1);
    const setupInfo = setup.source === "voigt"
      ? `Setup nach Voigt-Regeln: Strukturstop unter Swing-Tief der Korrektur (${setup.correctionLow?.toFixed(2)}). ` +
        `Mindest-CRV Qual.${setup.setupQuality}: ${setup.minCrv}:1. ` +
        `Ziel via ${setup.targetSource === "measured_move" ? `Measured Move (letzter Impuls ${setup.measuredMove?.toFixed(2)} Punkte, projiziert ab Korrekturtief)` : setup.targetSource === "swing_high" ? "letztes Swing High (Widerstand)" : `Mindest-CRV ${setup.minCrv}:1`}.`
      : setup.source === "pine"
        ? `Setup basiert auf Pine-Indikatoren: Support ${setup.stopLevel?.toFixed(2)}, Stop-Buffer darunter. Target: ${setup.targetSource === "pine_resistance" ? `nächster Widerstand bei ${setup.target.toFixed(2)}` : `2:1 R:R (${setup.target.toFixed(2)})`}`
        : `Setup ATR-basiert (${setup.atr?.toFixed(2)} ATR): Swing Low + ATR × 1.5 als Stop`;

    // Voigt Markttechnik-Kontext
    let voigtInfo = "";
    if (voigt) {
      const regimeLabel = voigt.weeklyRegime === "GRÜN" ? "✅ GRÜN (Markup-Phase)"
                        : voigt.weeklyRegime === "GELB" ? "⚠️ GELB (Underperformer)"
                        : "🔴 ROT (kein Long)";
      voigtInfo = `
Voigt Markttechnik (Top-Down):
  Weekly Regime: ${regimeLabel}
  Daily Trend: ${voigt.hasTrend ? `HH+HL bestätigt ✓` : "kein HH/HL ✗"}  |  Correction: ${voigt.correction.durationStatus} (${voigt.correction.duration} Bars), Vol. ${voigt.correction.volDecreasing ? "rückläufig ✓" : "erhöht ✗"}
  Setup-Qualität: ${voigt.setupQuality} (Confluence-Score ${voigt.confluenceCount}/5)  |  Setup aktiv: ${voigt.setupActive ? "JA ✓" : "NEIN ✗"}`;
    }

    const msg = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 400,
      system: "Du bist ein erfahrener CANSLIM-Swingtrading-Analyst nach Minervini/Voigt. Antworte auf Deutsch. Maximal 4 Sätze, präzise und persönlich. Bei Voigt-Setup: Erkläre kurz warum der Strukturstop (unter Swing-Tief) hier sinnvoll ist und was das CRV-Ziel bedeutet. Bei ATR/Pine-Setup: Erkläre die wichtigsten Risiken.",
      messages: [{
        role: "user",
        content: `Bewerte diesen Swingtrading-Kandidaten kurz und persönlich:

Symbol: ${candidate.symbol}  |  Name: ${candidate.name ?? "–"}
CANSLIM-Score: ${"⭐".repeat(candidate.stars ?? 0)}
3M-Performance: ${candidate.perf_3m_pct?.toFixed(1) ?? "–"}%  |  MCap: ${candidate.market_cap_bn?.toFixed(1) ?? "–"} Mrd. USD
RS-Rating: ${candidate.rs_rating ?? "–"}  |  Short Float: ${candidate.short_float ?? "–"}%

${setupInfo}
Entry: ${setup.entry.toFixed(2)}  |  Stop: ${setup.stop.toFixed(2)} (−${stopPct}%)  |  Ziel: ${setup.target.toFixed(2)} (+${gainPct}%)  |  R:R = ${rrRatio}:1
${voigtInfo}
OHLCV: ${JSON.stringify(ohlcv?.summary ?? {})}

Warum gefällt dir dieser Trade heute besonders? Was ist das größte Risiko?`,
      }],
    });
    return (msg?.content?.[0]?.text ?? "").trim();
  } catch {
    return `${candidate.symbol} überzeugt mit ${"⭐".repeat(candidate.stars ?? 0)} und +${candidate.perf_3m_pct?.toFixed(1) ?? "–"}% in 3 Monaten. Das Setup (${setup.source === "pine" ? "Pine-Level" : "ATR-basiert"}) bietet ein ${((setup.target - setup.entry) / setup.risk).toFixed(1)}:1 Risk/Reward.`;
  }
}

// ── Visuellen Canvas via Symbol-Suche navigieren ─────────────────────────────
// ERKENNTNISSE (2026-04-30):
//   • setSymbol() + Watchlist-CDP-Klick: aktualisiert nur den API-Datenstrom
//     (_activeChartWidgetWV), NICHT das visuelle Canvas-Rendering
//   • NUR ein Klick auf ein Suchergebnis im Symbol-Suche-Dialog aktualisiert den
//     Canvas sichtbar — aber NUR für ~10–15 Sekunden, dann fällt er auf das
//     Watchlist-gebundene Symbol zurück
//   → Strategie: Symbol-Suche direkt vor dem Screenshot, Screenshot innerhalb
//     von 5 Sekunden nach dem Klick (vor dem Revert)

async function navigateVisualCanvas(ticker) {
  const esc = ticker.replace(/'/g, "\\'");

  try {
    // 1. Chart-Header-Symbol-Button anklicken → Symbol-Suche öffnet sich
    //    Robuste Suche: data-name-Selektoren, dann positionsbasierter Fallback
    const headerCoords = await evaluate(`
      (function() {
        var sel = ['[data-name="legend-source-item"]', '[data-name="symbol-header-description"]'];
        for (var s = 0; s < sel.length; s++) {
          var el = document.querySelector(sel[s]);
          if (!el) continue;
          var r = el.getBoundingClientRect();
          if (r.width > 0) return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), sel: sel[s] };
        }
        // Fallback: erster sichtbarer BUTTON im Chart-Header-Bereich
        var btns = document.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
          var r = btns[i].getBoundingClientRect();
          if (r.top > 30 && r.top < 80 && r.left > 50 && r.left < 700 && r.width > 50 && r.height > 10) {
            return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), sel: 'button-positional' };
          }
        }
        return null;
      })()
    `);
    if (!headerCoords) { console.warn('⚠️  navigateVisualCanvas: Chart-Header nicht gefunden'); return false; }
    console.log(`ℹ️  Visual-Canvas: Header via ${headerCoords.sel} (${headerCoords.x}, ${headerCoords.y})`);
    await clickAt(headerCoords.x, headerCoords.y);
    await new Promise(r => setTimeout(r, 800));

    // 2. Ticker in das Such-Input eintippen
    const inputSet = await evaluate(`
      (function() {
        var input = document.querySelector('.search-lANubSc2')
                 || document.querySelector('[class*="search-ZXzPWcCf"]');
        if (!input) {
          var inputs = document.querySelectorAll('input[type="text"], input:not([type])');
          for (var i = 0; i < inputs.length; i++) {
            var r = inputs[i].getBoundingClientRect();
            if (r.width > 100 && r.top > 100 && r.top < 600) { input = inputs[i]; break; }
          }
        }
        if (!input) return false;
        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        setter.call(input, '${esc}');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);
    if (!inputSet) { console.warn('⚠️  navigateVisualCanvas: Symbol-Suche Input nicht gefunden'); return false; }
    await new Promise(r => setTimeout(r, 1500)); // Suchergebnisse laden lassen

    // 3. Ersten passenden Treffer finden und per CDP-Klick bestätigen
    const resultCoords = await evaluate(`
      (function() {
        var spans = document.querySelectorAll('[class*="dialog"] span, [class*="Dialog"] span');
        for (var i = 0; i < spans.length; i++) {
          if (spans[i].textContent.trim() !== '${esc}') continue;
          var rect = spans[i].getBoundingClientRect();
          if (rect.top < 200 || rect.top > 950) continue;
          var row = spans[i];
          for (var d = 0; d < 10; d++) {
            row = row.parentElement;
            if (!row) break;
            var r = row.getBoundingClientRect();
            if (r.width > 100 && r.height > 15 && r.height < 60) {
              return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
            }
          }
          break; // Nur ersten Treffer
        }
        return null;
      })()
    `);

    if (resultCoords) {
      // Klick setzt Canvas SOFORT auf das Symbol (für ~10–15s, bis Watchlist zurückspringt).
      // Der aufrufende Code muss den Screenshot INNERHALB dieser 10s aufnehmen!
      await clickAt(resultCoords.x, resultCoords.y);
      console.log(`✅ Visual-Canvas: Symbol-Suche → ${ticker} — Screenshot innerhalb 10s!`);
      await new Promise(r => setTimeout(r, 800)); // Kurz warten bis Canvas gerendert
      return true;
    }

    // Dialog schließen falls kein Ergebnis
    const closeCoords = await evaluate(`
      (function() {
        var el = document.querySelector('[data-dialog-name="symbol-search-dialog"] [data-name="close"]')
               || document.querySelector('[class*="dialog"] [class*="close"]');
        if (!el) return null;
        var r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
      })()
    `);
    if (closeCoords) await clickAt(closeCoords.x, closeCoords.y);
    console.warn(`⚠️  navigateVisualCanvas: Kein Suchergebnis für ${ticker}`);
  } catch (e) {
    console.warn(`⚠️  navigateVisualCanvas: ${e.message}`);
  }

  return false;
}

// ── Custom Chart-Renderer (Browser Canvas API) ───────────────────────────────
// Generiert ein TradingView-ähnliches Candlestick-Chart mit Entry/Stop/Target-Linien
// direkt aus OHLCV-Daten via Browser-Canvas. Zuverlässig, unabhängig von TradingView-
// Visual-Canvas-Bindung (die immer auf das Watchlist-Symbol gebunden ist).

async function renderTradeChart(bars, setup, ticker, voigt, candidate, positionSizing) {
  const barsJson  = JSON.stringify(bars.slice(-55));
  const setupJson = JSON.stringify({
    entry:  setup.entry,
    stop:   setup.stop,
    target: setup.target,
    source: setup.source,
    crv:    +((setup.target - setup.entry) / (setup.entry - setup.stop)).toFixed(1),
    stopPct: +((setup.entry - setup.stop)  / setup.entry * 100).toFixed(1),
    gainPct: +((setup.target - setup.entry) / setup.entry * 100).toFixed(1),
  });
  const voigtJson = voigt ? JSON.stringify({
    regime: voigt.weeklyRegime,
    quality: voigt.setupQuality,
    corrDur: voigt.correction?.duration,
    lastSwingH: voigt.lastSwingHighPrice,
    corrLow:  setup.correctionLow ?? null,
  }) : 'null';
  const metaJson = JSON.stringify({
    ticker,
    name: candidate?.name ?? ticker,
    date: new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }),
  });
  const posJson = positionSizing ? JSON.stringify({
    shares:    positionSizing.shares,
    posValue:  positionSizing.positionValue,
    posPct:    positionSizing.positionPct,
    maxLoss:   positionSizing.maxLoss,
    riskPct:   positionSizing.riskPct,
    account:   positionSizing.accountSize,
  }) : 'null';

  const base64 = await evaluate(`
    (function() {
      var bars    = ${barsJson};
      var s       = ${setupJson};
      var voigt   = ${voigtJson};
      var meta    = ${metaJson};
      var pos     = ${posJson};

      // ── Layout: Kerzen-Pane (oben) + Volumen-Pane (unten) ────────────────────
      var W = 1300, H = 820;
      var L = 72, R = 170, T = 52, B = 20;
      var VOL_H = 90;   // Höhe des Volumen-Panes
      var SEP   = 6;    // Abstand zwischen Kerzen und Volumen
      var cH = H - T - B - VOL_H - SEP;  // Kerzen-Pane-Höhe
      var cW = W - L - R;

      // Y-Koordinaten der Pane-Grenzen
      var CANDLE_TOP = T;
      var CANDLE_BOT = T + cH;
      var VOL_TOP    = CANDLE_BOT + SEP;
      var VOL_BOT    = VOL_TOP + VOL_H;

      var canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      var ctx = canvas.getContext('2d');

      // ── Hintergrund ──────────────────────────────────────────────────────────
      ctx.fillStyle = '#131722'; ctx.fillRect(0, 0, W, H);

      // ── Preisbereich (Kerzen-Pane) ────────────────────────────────────────────
      var prices = [];
      bars.forEach(function(b) { prices.push(b.high, b.low); });
      prices.push(s.entry, s.stop, s.target);
      var minP = Math.min.apply(null, prices) * 0.993;
      var maxP = Math.max.apply(null, prices) * 1.007;
      var pRange = maxP - minP;

      function pxX(i) { return L + (i / bars.length) * cW; }
      function pxY(p)  { return CANDLE_TOP + (1 - (p - minP) / pRange) * cH; }

      // ── Volumen-Bereich ────────────────────────────────────────────────────────
      var vols = bars.map(function(b) { return b.volume || 0; });
      var maxVol = Math.max.apply(null, vols) || 1;
      function pxVol(v) { return VOL_BOT - (v / maxVol) * VOL_H * 0.92; }

      // ── Gitter (Kerzen-Pane) ──────────────────────────────────────────────────
      ctx.strokeStyle = '#1e2433'; ctx.lineWidth = 1;
      for (var g = 0; g <= 6; g++) {
        var gP = minP + (g / 6) * pRange;
        var gY = Math.round(pxY(gP)) + 0.5;
        ctx.beginPath(); ctx.moveTo(L, gY); ctx.lineTo(L + cW, gY); ctx.stroke();
        ctx.fillStyle = '#6b7280'; ctx.font = '11px Arial'; ctx.textAlign = 'right';
        ctx.fillText(gP.toFixed(2), L - 5, gY + 4);
      }
      // Trennlinie Kerzen/Volumen
      ctx.strokeStyle = '#2a2e39'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(L, VOL_TOP - 1); ctx.lineTo(L + cW, VOL_TOP - 1); ctx.stroke();

      // ── Kerzen ────────────────────────────────────────────────────────────────
      var barW = Math.max(3, Math.floor((cW / bars.length) * 0.68));
      for (var i = 0; i < bars.length; i++) {
        var b = bars[i];
        var x = Math.round(pxX(i + 0.5));
        var isUp = b.close >= b.open;
        var col = isUp ? '#26a69a' : '#ef5350';
        ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, pxY(b.high)); ctx.lineTo(x, pxY(b.low)); ctx.stroke();
        var yTop = Math.min(pxY(b.open), pxY(b.close));
        var bodyH = Math.max(1.5, Math.abs(pxY(b.open) - pxY(b.close)));
        ctx.fillRect(x - barW / 2, yTop, barW, bodyH);
      }

      // ── Volumen-Balken ────────────────────────────────────────────────────────
      var avgVol = vols.reduce(function(a, v) { return a + v; }, 0) / vols.length;
      for (var i = 0; i < bars.length; i++) {
        var b = bars[i];
        var x = Math.round(pxX(i + 0.5));
        var isUp = b.close >= b.open;
        var volColor = isUp ? 'rgba(38,166,154,0.65)' : 'rgba(239,83,80,0.65)';
        // Überdurchschnittliches Volumen → satter
        if (b.volume > avgVol * 1.5) volColor = isUp ? 'rgba(38,166,154,0.9)' : 'rgba(239,83,80,0.9)';
        ctx.fillStyle = volColor;
        var vTop = Math.round(pxVol(b.volume || 0));
        ctx.fillRect(x - barW / 2, vTop, barW, VOL_BOT - vTop);
      }
      // Volumen-Achsen-Label (max)
      ctx.fillStyle = '#4b5563'; ctx.font = '10px Arial'; ctx.textAlign = 'right';
      var volLabel = maxVol >= 1e6 ? (maxVol / 1e6).toFixed(1) + 'M' : maxVol >= 1e3 ? (maxVol / 1e3).toFixed(0) + 'K' : maxVol;
      ctx.fillText('Vol ' + volLabel, L - 5, VOL_TOP + 12);
      // Durchschnittslinie
      ctx.strokeStyle = '#4b5563'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      var avgY = Math.round(pxVol(avgVol)) + 0.5;
      ctx.beginPath(); ctx.moveTo(L, avgY); ctx.lineTo(L + cW, avgY); ctx.stroke();
      ctx.setLineDash([]);

      // ── Swing High / SW-Tief (Voigt) ─────────────────────────────────────────
      if (voigt && voigt.lastSwingH) {
        var shY = Math.round(pxY(voigt.lastSwingH)) + 0.5;
        ctx.strokeStyle = '#6b7280'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(L, shY); ctx.lineTo(L + cW, shY); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#6b7280'; ctx.font = '10px Arial'; ctx.textAlign = 'left';
        ctx.fillText('SW-High ' + voigt.lastSwingH.toFixed(2), L + 4, shY - 3);
      }
      if (voigt && voigt.corrLow && voigt.corrLow !== s.stop) {
        var clY = Math.round(pxY(voigt.corrLow)) + 0.5;
        ctx.strokeStyle = '#f97316'; ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
        ctx.beginPath(); ctx.moveTo(L, clY); ctx.lineTo(L + cW, clY); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#f97316'; ctx.font = '10px Arial'; ctx.textAlign = 'left';
        ctx.fillText('SW-Tief ' + voigt.corrLow.toFixed(2), L + 4, clY - 3);
      }

      // ── Setup-Linien ──────────────────────────────────────────────────────────
      function hline(price, color, label, dashed) {
        var y = Math.round(pxY(price)) + 0.5;
        ctx.strokeStyle = color; ctx.lineWidth = 2.5;
        ctx.setLineDash(dashed ? [8, 4] : []);
        ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + cW, y); ctx.stroke();
        ctx.setLineDash([]);
        var boxW = R - 10, boxH = 21;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(L + cW + 5, y - boxH/2, boxW, boxH, 3)
                      : ctx.rect(L + cW + 5, y - boxH/2, boxW, boxH);
        ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = 'bold 11px Arial'; ctx.textAlign = 'left';
        ctx.fillText(label + '  ' + price.toFixed(2), L + cW + 10, y + 4);
      }

      hline(s.target, '#2962ff', 'Ziel   +' + s.gainPct + '%', true);
      hline(s.entry,  '#089981', 'Entry', false);
      hline(s.stop,   '#f23645', 'Stop   -' + s.stopPct + '%', true);

      // ── Titelleiste ───────────────────────────────────────────────────────────
      ctx.fillStyle = '#1a1f2e'; ctx.fillRect(0, 0, W, T);
      ctx.fillStyle = '#d1d4dc'; ctx.font = 'bold 15px Arial'; ctx.textAlign = 'left';
      ctx.fillText(meta.ticker + '  ' + meta.name, L, 33);
      var subtitle = 'Daily  |  CRV ' + s.crv + ':1  |  ' + (s.source === 'voigt' ? 'Voigt-Setup' : s.source === 'pine' ? 'Pine-Level' : 'ATR-Fallback');
      if (voigt) subtitle += '  |  Regime ' + voigt.regime + '  Qual.' + voigt.quality;
      ctx.fillStyle = '#6b7280'; ctx.font = '12px Arial'; ctx.textAlign = 'right';
      ctx.fillText(subtitle, W - 10, 33);

      // ── Positionsgrößen-Box (rechts oben im Chart) ────────────────────────────
      if (pos) {
        var bx = L + cW - 5, by = CANDLE_TOP + 8;
        var bw = 210, bh = 58;
        // Hintergrund (halbtransparent)
        ctx.fillStyle = 'rgba(26,31,46,0.88)';
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(bx - bw, by, bw, bh, 4) : ctx.rect(bx - bw, by, bw, bh);
        ctx.fill();
        ctx.strokeStyle = '#2a2e39'; ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(bx - bw, by, bw, bh, 4) : ctx.rect(bx - bw, by, bw, bh);
        ctx.stroke();
        // Inhalt
        ctx.fillStyle = '#d1d4dc'; ctx.font = 'bold 12px Arial'; ctx.textAlign = 'left';
        ctx.fillText('Positionsgrösse  10k-Konto', bx - bw + 10, by + 17);
        ctx.fillStyle = '#9ca3af'; ctx.font = '11px Arial';
        var sharesStr = pos.shares + ' Aktien x ' + s.entry.toFixed(2) + ' = EUR ' + pos.posValue.toFixed(0) + '  (' + pos.posPct + '%)';
        ctx.fillText(sharesStr, bx - bw + 10, by + 33);
        var riskStr = 'Max. Verlust: EUR ' + pos.maxLoss.toFixed(0) + '  (' + pos.riskPct + '% Risiko)';
        ctx.fillText(riskStr, bx - bw + 10, by + 49);
      }

      // ── Datum-Achse ───────────────────────────────────────────────────────────
      ctx.fillStyle = '#6b7280'; ctx.font = '11px Arial'; ctx.textAlign = 'center';
      var lastMonth = -1;
      for (var j = 0; j < bars.length; j++) {
        var d = new Date(bars[j].time * 1000);
        var m = d.getMonth();
        if (m !== lastMonth) {
          lastMonth = m;
          var xd = Math.round(pxX(j + 0.5));
          var lbl = d.toLocaleDateString('de-DE', { month: 'short', year: '2-digit' });
          ctx.fillText(lbl, xd, VOL_BOT + 14);
          ctx.strokeStyle = '#1e2433'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(xd, CANDLE_TOP); ctx.lineTo(xd, CANDLE_BOT); ctx.stroke();
        }
      }

      return canvas.toDataURL('image/png').split(',')[1];
    })()
  `);

  if (!base64) return null;
  const buf = Buffer.from(base64, 'base64');
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const filePath = join(SCREENSHOT_DIR, `favtrade_${ticker}.png`);
  writeFileSync(filePath, buf);
  return { success: true, file_path: filePath, size_bytes: buf.length };
}

// ── Haupt-Export ──────────────────────────────────────────────────────────────

export async function runFavoriteTrade(scanData) {

  // ── Phase 1: Kandidaten ranken (Stage-2 via REST + CANSLIM-Score) ───────────
  const top5 = topNCandidates(scanData, 5);
  if (!top5.length) return { success: false, error: "Keine Scanner-Ergebnisse" };

  // Stage-2 (Preis > EMA50 > SMA150 > SMA200) für Top-5 via REST — kein Chart-Switch nötig
  const top5Symbols = top5.map(c => normalizeSymbol(c.symbol));
  const s2Map = await fetchWatchlistStage2(top5Symbols).catch(() => new Map());

  // Kombinierter Score: Stage-2 = +3 Punkte (Haupt-Voigt-Kriterium) + CANSLIM-Sterne
  const ranked = top5.map(c => {
    const full = normalizeSymbol(c.symbol);
    const tick = full.includes(":") ? full.split(":").pop() : full;
    const s2   = s2Map.get(full) ?? s2Map.get(tick) ?? s2Map.get(c.symbol) ?? false;
    return { candidate: c, fullSymbol: full, ticker: tick, stage2ok: s2,
             score: (s2 ? 3 : 0) + (c.stars ?? 0) };
  }).sort((a, b) => b.score !== a.score
    ? b.score - a.score
    : (b.candidate.market_cap_bn ?? 0) - (a.candidate.market_cap_bn ?? 0));

  console.log(`ℹ️  Lieblingstrade Ranking: ${ranked.slice(0, 3).map(r =>
    `${r.ticker}(stage2=${r.stage2ok},score=${r.score})`).join("  ")}`);

  // ── Phase 2: Voigt Pre-Screening (Top 2 via Chart) ──────────────────────────
  // Schneller Check ohne Pine-Wait (3s reicht für OHLCV-Daten).
  // Ziel: ersten Kandidaten mit aktivem Voigt-Setup wählen.
  // Fallback: #1 (bester CANSLIM-Kandidat) wenn keiner aktiv ist.
  let originalSymbol = null, originalResolution = null;
  try {
    const st = await getState();
    originalSymbol     = st.symbol     ?? null;
    originalResolution = st.resolution ?? null;
  } catch {}

  try {
    let selected   = ranked[0];   // Fallback = bester CANSLIM-Kandidat
    let lastLoaded = null;        // Zuletzt geladenes Symbol (vermeide unnötigen Doppel-Switch)

    for (const entry of ranked.slice(0, 2)) {
      await setSymbol({ symbol: entry.fullSymbol, waitTimeout: 15000 });
      await setTimeframe({ timeframe: "D" });
      await new Promise(r => setTimeout(r, 3000));   // OHLCV laden, kein Pine-Wait
      lastLoaded = entry.fullSymbol;

      const barsRaw = await getOhlcv({ count: 60, summary: false }).catch(() => null);
      const bars    = barsRaw?.bars ?? [];
      const voigt   = runVoigtAnalysis({ dailyBars: bars, stage2: entry.stage2ok, mansRS: null, macdH: null });

      console.log(`ℹ️  Voigt Pre-Check ${entry.ticker}: Regime=${voigt?.weeklyRegime ?? "n/a"} ` +
        `Qual=${voigt?.setupQuality ?? "n/a"} aktiv=${voigt?.setupActive ?? false} (stage2=${entry.stage2ok})`);

      if (voigt?.setupActive) {
        selected = entry;
        console.log(`✅ Voigt-Setup aktiv → Lieblingstrade: ${entry.ticker}`);
        break;
      }
      // Kein aktives Setup: weiter zum nächsten Kandidaten (schon auf #1 gewartet → Fallback bleibt)
    }

    if (!selected.voigt?.setupActive) {
      console.log(`ℹ️  Kein aktives Voigt-Setup — Fallback: ${selected.ticker} (bester CANSLIM-Kandidat)`);
    }

    // ── Phase 3: Vollbehandlung für den gewählten Kandidaten ────────────────────
    const { candidate, fullSymbol, ticker } = selected;
    const rawSymbol = candidate.symbol;

    // Chart bereits auf Gewinner? (= letztes Symbol im Pre-Screening)
    const alreadyOnWinner = lastLoaded === fullSymbol;
    if (!alreadyOnWinner) {
      await setSymbol({ symbol: fullSymbol, waitTimeout: 20000 });
      await new Promise(r => setTimeout(r, 1500));
    }

    // Symbol-Verifikation (bis zu 3 Formate versuchen)
    const symFmts = [...new Set([fullSymbol, rawSymbol, ticker])];
    let switched  = alreadyOnWinner;
    if (!switched) {
      for (let i = 0; i < symFmts.length; i++) {
        if (i > 0) {
          console.log(`⚠️  Fallback Symbol-Format: "${symFmts[i]}"`);
          await setSymbol({ symbol: symFmts[i], waitTimeout: 20000 });
          await new Promise(r => setTimeout(r, 1500));
        }
        const res = await getState();
        if ((res.symbol ?? "").toUpperCase().includes(ticker.toUpperCase())) {
          switched = true;
          console.log(`✅ Chart-Symbol verifiziert: ${res.symbol}`);
          break;
        }
      }
      if (!switched) {
        console.log(`⚠️  Alle Formate fehlgeschlagen — versuche bare Ticker: "${ticker}"`);
        await setSymbol({ symbol: ticker, waitTimeout: 20000 });
        await new Promise(r => setTimeout(r, 3000));
      }
    } else {
      console.log(`✅ Chart bereits auf Gewinner: ${ticker}`);
    }

    await setTimeframe({ timeframe: "D" });
    await new Promise(r => setTimeout(r, 5000));   // Pine-Indikatoren neu berechnen lassen

    // ── Visueller Stabilitäts-Check ─────────────────────────────────────────────
    // cw.getSymbol() → JS-State (sofort). OHLCV-Daten → visueller/render State.
    // Screenshot erst wenn lastClose innerhalb ±40% des erwarteten Preises liegt.
    {
      const expectedPrice = candidate.price ?? 0;
      let visualOk = false;
      for (let attempt = 0; attempt < 3 && !visualOk; attempt++) {
        if (attempt > 0) {
          console.log(`⚠️  Visual-Check Attempt ${attempt + 1}: nochmals setSymbol…`);
          await setSymbol({ symbol: fullSymbol, waitTimeout: 20000 });
          await setTimeframe({ timeframe: "D" });
          await new Promise(r => setTimeout(r, 5000 + attempt * 2000));
        }
        try {
          const checkOhlcv = await getOhlcv({ count: 3, summary: false });
          const lastClose  = checkOhlcv?.bars?.at(-1)?.close ?? 0;
          if (expectedPrice > 0 && lastClose > 0) {
            const deviation = Math.abs(lastClose - expectedPrice) / expectedPrice;
            if (deviation <= 0.40) {
              visualOk = true;
              console.log(`✅ Visual-Check OK: lastClose=${lastClose.toFixed(2)}, expected≈${expectedPrice.toFixed(2)}, dev=${(deviation*100).toFixed(1)}%`);
            } else {
              console.warn(`⚠️  Visual-Check: dev=${(deviation*100).toFixed(1)}% > 40% — warte nochmals…`);
            }
          } else {
            visualOk = true;
          }
        } catch { visualOk = true; }
      }
      await new Promise(r => setTimeout(r, 1500));
    }

    // ── OHLCV + ATR (frisch nach Pine-Wait) ────────────────────────────────────
    const ohlcvRaw     = await getOhlcv({ count: 60, summary: false });
    const bars         = ohlcvRaw?.bars ?? [];
    const currentPrice = bars[bars.length - 1]?.close ?? candidate.price ?? 0;
    const ohlcvSummary = await getOhlcv({ count: 20, summary: true });
    const atr          = calcAtr(bars);

    // Voigt final (mit korrektem stage2 — stage2Map-Nachpflege via daily-brief-email.js)
    const voigt = runVoigtAnalysis({ dailyBars: bars, stage2: selected.stage2ok, mansRS: null, macdH: null });
    if (voigt) {
      console.log(`ℹ️  Voigt Final ${ticker}: Regime=${voigt.weeklyRegime} Qual=${voigt.setupQuality} ` +
        `Korrektur=${voigt.correction.durationStatus}(${voigt.correction.duration}d) aktiv=${voigt.setupActive}`);
    }

    // 3. Pine-Levels lesen (Support/Resistance aus aktiven Indikatoren)
    const pineLevels = await collectPineLevels();

    // 4. Setup bestimmen — Hierarchie nach Voigt-Regeln:
    //    1) Voigt-Strukturstop (Setup aktiv + Qual A/B + CRV-Regel erfüllt)
    //    2) Pine-Levels (Support/Resistance aus aktiven Indikatoren)
    //    3) ATR-Fallback (Swing Low + ATR × 1.5)
    console.log(`ℹ️  Pine-Levels gefunden: ${pineLevels.length} (${pineLevels.map(p => p.toFixed(2)).join(", ") || "–"})`);

    let setup = null;

    // ── 1) Voigt-Setup: Strukturstop + qualitätsabhängiges Min-CRV ─────────────
    if (voigt) {
      const vs = calcVoigtSetup(bars, voigt);
      if (vs?.tradeable) {
        setup = vs;
        console.log(
          `✅ Voigt-Setup (Qual.${vs.setupQuality} min-CRV ${vs.minCrv}:1): ` +
          `Entry ${vs.entry.toFixed(2)} | Stop ${vs.stop.toFixed(2)} (SW-Tief ${vs.correctionLow.toFixed(2)}, −${vs.stopPct}%) | ` +
          `Ziel ${vs.target.toFixed(2)} [${vs.targetSource}] | CRV ${vs.crv}:1`,
        );
      } else if (vs) {
        console.log(`ℹ️  Voigt-Setup nicht handelbar: ${vs.note ?? `Qual.${vs.setupQuality}`}`);
      }
    }

    // ── 2) Pine-Levels ──────────────────────────────────────────────────────────
    if (!setup && pineLevels.length >= 2) {
      setup = calcSetupFromPine(currentPrice, pineLevels, atr);
      if (setup) console.log(`ℹ️  Setup-Quelle: Pine-Levels (${setup.stopLevel?.toFixed(2)} → ${setup.target.toFixed(2)})`);
    }

    // ── 3) ATR-Fallback ─────────────────────────────────────────────────────────
    if (!setup) {
      setup = calcSetupFromAtr(bars, currentPrice, atr);
      if (setup) console.log(`ℹ️  Setup-Quelle: ATR-Fallback (Stop ${setup.stop.toFixed(2)}, Ziel ${setup.target.toFixed(2)})`);
    }

    if (!setup) return { success: false, error: "Setup-Berechnung fehlgeschlagen (zu wenig Daten)" };

    // ── Positionsgrößen-Berechnung (1% Risiko-Regel) ────────────────────────────
    // Max. Verlust = 1% des Kontos = €100 bei €10k
    // Aktienanzahl = max. Verlust ÷ Risiko-pro-Aktie (Entry − Stop)
    const maxRisk     = ACCOUNT_SIZE * RISK_PCT;                // €100
    // Math.max(1, ...) kann bei teuren Aktien/weiten Stops das Risikobudget sprengen
    // (1 Aktie kostet dann mehr als maxRisk) — daher IMMER den tatsächlichen Risiko-%
    // berechnen statt der Zielquote RISK_PCT und den Fall sichtbar flaggen.
    const shares      = Math.max(1, Math.floor(maxRisk / setup.risk));
    const posValue    = +(shares * setup.entry).toFixed(2);     // Positionswert in €
    const posValuePct = +((posValue / ACCOUNT_SIZE) * 100).toFixed(1); // % des Kontos
    const maxLoss     = +(shares * setup.risk).toFixed(2);      // Max. Verlust in €
    const actualRiskPct  = +((maxLoss / ACCOUNT_SIZE) * 100).toFixed(1); // tatsächliches Risiko in %
    const riskExceeded   = maxLoss > maxRisk;                   // 1-Aktien-Minimum sprengt Budget

    console.log(
      `ℹ️  Positionsgröße: ${shares} Aktien × ${setup.entry.toFixed(2)} = €${posValue} ` +
      `(${posValuePct}% des Kontos) | Max. Verlust: €${maxLoss} (${actualRiskPct}%)` +
      (riskExceeded ? ` ⚠️  ÜBER Risikobudget (Ziel: ${(RISK_PCT * 100).toFixed(1)}%)` : ""),
    );

    const DAY = 86400;

    // Bar-Zeitstempel für Swing-Struktur und Shape-Anker
    const lastBarTime   = bars[bars.length - 1]?.time ?? nowTs();
    const shBarTime     = (voigt?.lastSwingHighIdx != null && bars[voigt.lastSwingHighIdx]?.time)
                          ? bars[voigt.lastSwingHighIdx].time
                          : null;
    // R/R-Rechtecke starten 3 Bars vor dem letzten — sonst landen sie knapp außerhalb
    // des sichtbaren Bereichs (setVisibleRange klemmt den `to`-Wert auf den letzten Bar)
    const rectStartTime = bars[Math.max(0, bars.length - 4)]?.time ?? (lastBarTime - DAY * 3);

    // 5. Drawings löschen (BEVOR neue gezeichnet werden)
    await clearAll();

    // CRV-Labels
    const rrRatioStr = ((setup.target - setup.entry) / setup.risk).toFixed(1);
    const stopPctStr = ((setup.risk / setup.entry) * 100).toFixed(1);
    const gainPctStr = (((setup.target - setup.entry) / setup.entry) * 100).toFixed(1);

    const targetSrcLabel = setup.source === 'voigt'
      ? (setup.targetSource === 'measured_move' ? 'Measured Move'
       : setup.targetSource === 'swing_high'    ? 'SW-High'
       : `min ${setup.minCrv}:1`)
      : (setup.targetSource === 'pine_resistance' ? 'Pine-Widerstand' : '2:1 ATR');

    const stopSourceLabel = setup.source === 'voigt' ? 'Voigt SW-Tief'
                          : setup.source === 'pine'  ? 'Pine-Level'
                          : 'ATR';

    // ── A) Voigt: Korrektur-Phase & Swing-Struktur ──────────────────────────────
    if (setup.source === 'voigt' && voigt) {

      // Korrektur-Zone: violettes Rechteck vom letzten Swing High bis heute
      // → Zeigt den Pullback-Bereich visuell (Voigt: "gesunde Korrektur")
      if (shBarTime && voigt.lastSwingHighPrice && voigt.correctionLow) {
        await drawShape({
          shape:  'rectangle',
          point:  { time: shBarTime,   price: voigt.lastSwingHighPrice * 1.002 },
          point2: { time: lastBarTime, price: voigt.correctionLow * 0.998 },
          overrides: {
            backgroundColor: '#8b5cf6', backgroundTransparency: 85,
            borderColor: '#8b5cf6', borderWidth: 1,
          },
          text: `Korrektur ${voigt.correction.duration}d${voigt.correction.volDecreasing ? ' · Vol↓' : ''}`,
        });
      }

      // Letztes Swing High: graue gestrichelte Linie (Ausbruchslevel / Widerstand)
      if (voigt.lastSwingHighPrice) {
        await drawShape({
          shape: 'horizontal_line',
          point: { time: lastBarTime, price: voigt.lastSwingHighPrice },
          overrides: { linecolor: '#6b7280', linewidth: 1, linestyle: 2 },
          text: `SH ${voigt.lastSwingHighPrice.toFixed(2)} (Ausbruchslevel)`,
        });
      }

      // Impulsbasis (prevSwingLow): hellgraue gepunktete Linie
      // → Basis des letzten Aufwärtsimpulses = Ausgangspunkt für Measured Move
      if (voigt.prevSwingLow) {
        await drawShape({
          shape: 'horizontal_line',
          point: { time: lastBarTime, price: voigt.prevSwingLow },
          overrides: { linecolor: '#9ca3af', linewidth: 1, linestyle: 3 },
          text: `Impulsbasis ${voigt.prevSwingLow.toFixed(2)} (Measured Move)`,
        });
      }

      // SW-Tief der Korrektur: orangefarbene gestrichelte Linie (Strukturstop-Basis)
      if (setup.correctionLow) {
        await drawShape({
          shape: 'horizontal_line',
          point: { time: lastBarTime, price: setup.correctionLow },
          overrides: { linecolor: '#f97316', linewidth: 1, linestyle: 2 },
          text: `SW-Tief ${setup.correctionLow.toFixed(2)} (Strukturstop-Basis)`,
        });
      }

    } else if (setup.source === 'pine' && setup.stopLevel) {
      // Pine-Setup: Support-Level als Basis
      await drawShape({
        shape: 'horizontal_line',
        point: { time: lastBarTime, price: setup.stopLevel },
        overrides: { linecolor: 0xf97316, linewidth: 1, linestyle: 2 },
        text: `Support ${setup.stopLevel.toFixed(2)} (Pine-Level)`,
      });
    }

    // ── B) TradingView Position/Order Lines (native Trading-Overlay) ────────────
    // Wichtig: createPositionLine() / createOrderLine() geben Promises zurück.
    // Wir verwenden .then()-Chaining (NON-BLOCKING) statt async/await, damit ein
    // hängendes Promise nicht die nachfolgenden drawShape-Calls (Section C) blockiert.
    // evaluate() (awaitPromise: false) startet die Kette und kehrt sofort zurück.
    {
      const crvStr     = ((setup.target - setup.entry) / setup.risk).toFixed(1);
      const posQtyStr  = `${shares} Aktien · €${Math.round(posValue)} (${posValuePct}% Konto)`;
      const posTextStr = `CRV ${crvStr}:1 · max. -€${Math.round(maxLoss)}`;

      try {
        await evaluate(`
          (function() {
            var api = window.TradingViewApi._activeChartWidgetWV.value();
            window.__tvTradeLines = [];
            window.__tvPosCreated = false;

            api.createPositionLine()
              .then(function(pos) {
                pos.setPrice(${setup.entry})
                   .setQuantity('${posQtyStr}')
                   .setText('${posTextStr}')
                   .setLineStyle(0).setLineLength(3)
                   .setBodyFont('bold 11px Arial')
                   .setBodyTextColor('#ffffff')
                   .setBodyBackgroundColor('#1d4ed8')
                   .setBodyBorderColor('#1d4ed8')
                   .setLineColor('#1d4ed8');
                window.__tvTradeLines.push(pos);
                return api.createOrderLine();
              })
              .then(function(sl) {
                sl.setPrice(${setup.stop})
                  .setQuantity('🛑 Stop ${shares}')
                  .setText('-${stopPctStr}%')
                  .setLineStyle(2).setLineLength(3)
                  .setBodyFont('bold 11px Arial')
                  .setBodyTextColor('#ffffff')
                  .setBodyBackgroundColor('#dc2626')
                  .setBodyBorderColor('#dc2626')
                  .setLineColor('#dc2626');
                window.__tvTradeLines.push(sl);
                return api.createOrderLine();
              })
              .then(function(tp) {
                tp.setPrice(${setup.target})
                  .setQuantity('🎯 Ziel ${shares}')
                  .setText('+${gainPctStr}%')
                  .setLineStyle(2).setLineLength(3)
                  .setBodyFont('bold 11px Arial')
                  .setBodyTextColor('#ffffff')
                  .setBodyBackgroundColor('#16a34a')
                  .setBodyBorderColor('#16a34a')
                  .setLineColor('#16a34a');
                window.__tvTradeLines.push(tp);
                window.__tvPosCreated = true;
              })
              .catch(function(e) {
                console.warn('Position/Order Lines:', e.message);
              });
            return 'started';
          })()
        `);
      } catch (e) {
        console.warn('Position/Order Lines konnten nicht gestartet werden:', e.message);
      }
    }

    // ── C) Schlüssellinien ──────────────────────────────────────────────────────
    // WICHTIG: lastBarTime als Anker — tNow kann zwischen Bars liegen (tagesende/Wochenende)
    // und wird von TradingView ggf. still verworfen.

    // Stop-Loss: rote Linie (dick + durchgezogen für Sichtbarkeit)
    await drawShape({
      shape: 'horizontal_line',
      point: { time: lastBarTime, price: setup.stop },
      overrides: { linecolor: '#ff2222', linewidth: 4, linestyle: 0 },
      text:  `🛑 Stop ${setup.stop.toFixed(2)} (−${stopPctStr}% | ${stopSourceLabel})`,
    });

    // Entry: grüne Linie (dick + durchgezogen)
    await drawShape({
      shape: 'horizontal_line',
      point: { time: lastBarTime, price: setup.entry },
      overrides: { linecolor: '#00cc44', linewidth: 4, linestyle: 0 },
      text:  `▶ Entry ${setup.entry.toFixed(2)}`,
    });

    // Target: blaue Linie mit CRV (dick + durchgezogen)
    await drawShape({
      shape: 'horizontal_line',
      point: { time: lastBarTime, price: setup.target },
      overrides: { linecolor: '#2266ff', linewidth: 4, linestyle: 0 },
      text:  `🎯 Ziel ${setup.target.toFixed(2)} (+${gainPctStr}% | CRV ${rrRatioStr}:1 | ${targetSrcLabel})`,
    });

    // Drawings verifizieren: alle 3 Linien müssen im Chart liegen
    try {
      const shapeCount = await evaluate(
        `window.TradingViewApi._activeChartWidgetWV.value().getAllShapes().length`
      );
      console.log(`ℹ️  Drawings verifiziert: ${shapeCount} Shapes auf Chart`);
    } catch { /* Nicht kritisch */ }

    // Warte auf Rendering: drawShape-Linien (200ms/Stk.) + Position Lines (.then-Kette ~500-1500ms)
    await new Promise((r) => setTimeout(r, 2000));

    // 6. Chart-Zoom: letzte 60 Bars + 35 Tage nach rechts (NACH den Drawings — kein Re-Render danach)
    // → Setup (Korrektur, Entry, Stop, Ziel) klar sichtbar
    if (bars.length >= 2) {
      const fromTs = bars[Math.max(0, bars.length - 60)].time;
      const toTs   = lastBarTime + DAY * 35;
      try {
        const zoomResult = await setVisibleRange({ from: fromTs, to: toTs, extraBarsRight: 25 });
        const actualFrom = zoomResult?.actual?.from ?? 0;
        const actualTo   = zoomResult?.actual?.to   ?? 0;
        console.log(`ℹ️  Zoom: from=${fromTs} to=${toTs} → actual from=${actualFrom} to=${actualTo}`);
        await new Promise((r) => setTimeout(r, 2000));   // Zoom-Animation vollständig abwarten
      } catch (e) {
        console.warn(`⚠️  Zoom fehlgeschlagen: ${e.message}`);
      }
    }

    // Preisachse aufweiten: Target + 8% Buffer nach oben, Stop − 8% nach unten
    // → Stellt sicher dass alle 3 Linien im sichtbaren Preisbereich liegen
    try {
      const priceBuffer = (setup.target - setup.stop) * 0.1;
      const priceMin    = setup.stop   - priceBuffer;
      const priceMax    = setup.target + priceBuffer;
      await evaluate(`
        (function() {
          var cw = (function(){
            var c = window.TradingViewApi._chartWidgetCollection;
            return c._chartWidgetsDefs[c._activeIndex || 0].chartWidget;
          })();
          var m  = cw.model();
          var ps = m.mainSeries().priceScale();
          if (ps && typeof ps.setVisiblePriceRange === 'function') {
            ps.setVisiblePriceRange({ minValue: ${priceMin}, maxValue: ${priceMax} });
          } else if (ps && typeof ps.applyNewPriceRange === 'function') {
            ps.applyNewPriceRange({ minValue: ${priceMin}, maxValue: ${priceMax} });
          }
        })()
      `);
      await new Promise((r) => setTimeout(r, 500));
    } catch { /* Nicht kritisch */ }

    // 7 + 8. Screenshot: Custom Chart-Renderer (Browser Canvas API)
    // ─────────────────────────────────────────────────────────────────────────────
    // TradingView Desktop: Die visuelle Canvas ist im Electron-Window-Layer an die
    // Watchlist gebunden und lässt sich per JS-API NICHT umprogrammieren.
    // Alle bisherigen Ansätze (setSymbol, collection.setSymbol, gt.setSymbol,
    // Symbol-Suche-Klick) aktualisieren nur den Datenstrom, nicht den Renderer.
    //
    // LÖSUNG: Eigenes Chart-Bild aus den bereits geladenen OHLCV-Daten generieren.
    // renderTradeChart() erzeugt ein sauberes Candlestick-PNG mit Entry/Stop/Target.
    const shot = await renderTradeChart(bars, setup, ticker, voigt, candidate, {
      shares: shares, positionValue: posValue, positionPct: posValuePct,
      maxLoss, riskPct: actualRiskPct, riskExceeded, accountSize: ACCOUNT_SIZE,
    }).catch(e => { console.warn(`⚠️  renderTradeChart: ${e.message}`); return null; });

    if (shot?.success) {
      console.log(`✅ Chart-Bild generiert: ${ticker} (${shot.size_bytes} bytes)`);
    } else {
      console.warn(`⚠️  Chart-Bild fehlgeschlagen — kein Screenshot`);
    }

    let screenshotBase64 = null;
    if (shot?.file_path) {
      try { screenshotBase64 = readFileSync(shot.file_path).toString("base64"); } catch {}
    }

    // 7. Claude-Kommentar (parallel zum Cleanup starten) — Voigt-Daten mitgeben
    const commentPromise = generateTradeComment(candidate, setup, ohlcvSummary, voigt);

    // 8. Position/Order Lines entfernen + Drawings löschen + Chart zurücksetzen
    // .remove() ist synchron → evaluate() reicht (kein awaitPromise nötig)
    try {
      await evaluate(`
        (function() {
          var lines = window.__tvTradeLines || [];
          for (var i = 0; i < lines.length; i++) {
            try { lines[i].remove(); } catch(e) {}
          }
          window.__tvTradeLines = [];
          return 'cleared';
        })()
      `);
    } catch {}
    await clearAll();
    if (originalSymbol) {
      try {
        await setSymbol({ symbol: originalSymbol });
        await new Promise((r) => setTimeout(r, 800));
        if (originalResolution) await setTimeframe({ timeframe: originalResolution });
      } catch {}
    }

    const comment = await commentPromise;

    return {
      success: true,
      candidate,
      setup,
      comment,
      voigt,           // Voigt Swing Analyse
      stage2ok: selected.stage2ok,   // Stage-2 aus Scanner REST — zuverlässiger als Watchlist-Map
      positionSizing: {              // 1% Risiko-Regel auf €10k Konto
        shares,
        positionValue: posValue,
        positionPct: posValuePct,
        maxLoss,
        accountSize: ACCOUNT_SIZE,
        riskPct: actualRiskPct,     // tatsächliches Risiko (kann bei riskExceeded über RISK_PCT liegen)
        riskExceeded,
      },
      ohlcv_bars: bars, // Raw-Bars für externes stage2-Nachpflegen
      pineLevels: setup.source === "pine" ? setup.pineLevelsUsed : null,
      screenshotPath:   shot?.file_path ?? null,
      screenshotBase64,
    };
  } catch (err) {
    try { await clearAll(); } catch {}
    if (originalSymbol) {
      try {
        await setSymbol({ symbol: originalSymbol });
        if (originalResolution) await setTimeframe({ timeframe: originalResolution });
      } catch {}
    }
    return { success: false, error: err.message };
  }
}
