import { esc, trend, parseVolume, calcMacdFromBars, formatVol, rsTrend, calcStage2Info } from "./helpers.js";
import { formatWochenruckblickHtml, formatWatchlistNewsHtml } from "./watchlist.js";
import { formatMarketHtml } from "./market-overview.js";
import { formatLochnerHtml, formatTradermacherHtml } from "./creators.js";
import { formatCalendarHtml } from "./calendar.js";
import { formatScannerHtml } from "./scanner.js";
import { formatFavoriteTradeHtml } from "./favorite-trade.js";
import { classifyOptions } from "../../src/core/options.js";
import { runVoigtAnalysis } from "../../src/core/voigt-analysis.js";

// Auto-extracted aus daily-brief-email.js — Top-Level HTML-Composer für den gesamten Brief

export function formatHtml(data, scanData, marketData, calData, mode = "daily", rsHistory = null, stage2Map = null, weeklyPerfMap = null, wlNews = null, rsiMap = null, ivMap = null, lochnerData = null, tradermacherData = null, favoriteTradeData = null, isSlim = false, fetchErrors = {}) {
  const date = new Date(data.generated_at).toLocaleDateString("de-DE", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  const time = new Date(data.generated_at).toLocaleTimeString("de-DE");
  const isFriday = new Date().getDay() === 5;
  const stage2Info = calcStage2Info(data.symbols_scanned || [], stage2Map);

  // Sichtbarer Hinweis wenn ein Datenabruf fehlgeschlagen ist (nicht von "echt leer"
  // unterscheidbar, wenn wir hier nicht explizit warnen — siehe fetchErrors in daily-brief-email.js)
  const fetchWarning = (label) => ` &nbsp;·&nbsp; <span style="color:#d97706;font-weight:700">⚠️ ${label} nicht abrufbar</span>`;

  // Wochenrückblick (Freitag) vorbereiten
  const weeklyPerfHtml = isFriday && weeklyPerfMap?.size
    ? formatWochenruckblickHtml(data.symbols_scanned || [], weeklyPerfMap)
    : "";

  const rows = (data.symbols_scanned || []).map((s) => {
    if (s.error) {
      return `<tr><td style="font-weight:bold">${s.symbol}</td>
        <td colspan="6" style="color:#dc2626;font-size:12px">${s.error}</td></tr>`;
    }

    const d     = s.daily || {};
    const q     = d.quote || {};
    const inds  = (d.indicators || {}).studies || [];
    const ohlcv = d.ohlcv_summary || {};

    const macd   = inds.find((i) => i.name.includes("Convergence"))?.values || {};
    const vol    = inds.find((i) => i.name === "Volume")?.values || {};
    const mansf  = inds.find((i) => i.name.includes("Mansfield"))?.values || {};
    const rsi14  = inds.find((i) => i.name.includes("Relative Strength Index") || i.name === "RSI")?.values || {};
    const vwma   = inds.find((i) => i.name.includes("Weighted"))?.values || {};
    const ivRankStudy = inds.find((i) => /IV.?Rank/i.test(i.name))?.values || {};
    const ivRankVal = parseFloat(String(ivRankStudy["IV Rank"] ?? "").replace(",", "."));
    const ivRankNum = !isNaN(ivRankVal) ? Math.round(ivRankVal) : null;

    const isBtc     = /BTC/i.test(s.symbol);
    const price     = q.close != null ? (isBtc ? Math.round(q.close) : q.close) : "–";

    // Tagesveränderung: aus last_5_bars berechnen (vorletzter Close → letzter Close)
    // getQuote() liefert kein change_pct — muss aus OHLCV errechnet werden
    const lastBars  = ohlcv.last_5_bars || [];
    const barToday  = lastBars[lastBars.length - 1];
    const barPrev   = lastBars[lastBars.length - 2];
    const dailyCh   = (barToday?.close != null && barPrev?.close != null && barPrev.close !== 0)
      ? ((barToday.close - barPrev.close) / barPrev.close * 100)
      : null;

    const perfCh    = ohlcv.change_pct ?? "–";

    // MACD: aus TV-Indikator lesen — Fallback: aus OHLCV-Bars berechnen
    // (Sub-Pane-Indikatoren liefert data_get_study_values nicht zuverlässig)
    const macdHRaw  = Object.values(macd)[0];
    const macdHNum  = macdHRaw != null
      ? Number(String(macdHRaw).replace(/\u2212/g, "-").replace(",", "."))
      : NaN;
    const bars          = s.daily?.ohlcv_bars ?? [];
    const macdFromBars  = !isNaN(macdHNum) ? null : calcMacdFromBars(bars);
    const macdHFinal    = !isNaN(macdHNum) ? macdHNum : macdFromBars;
    const macdH         = macdHFinal != null ? macdHFinal.toFixed(2) : "–";

    // Volume: aus TV-Indikator lesen — Fallback: aus OHLCV-Bars berechnen
    const volFromInd   = Object.values(vol)[0];
    const volMaFromInd = Object.values(vol)[1];
    const lastBar      = bars.at(-1);
    const volRawNum    = (volFromInd == null || volFromInd === "–")
      ? (lastBar?.volume ?? null) : null;
    const volMaRawNum  = (volMaFromInd == null || volMaFromInd === "–") && bars.length >= 20
      ? bars.slice(-20).reduce((sum, b) => sum + (b.volume || 0), 0) / 20
      : null;
    const volNow = volRawNum  != null ? (formatVol(volRawNum)   ?? "–") : (volFromInd  ?? "–");
    const volMa  = volMaRawNum != null ? (formatVol(volMaRawNum) ?? "–") : (volMaFromInd ?? "–");
    const rsVal       = Object.values(mansf)[0];
    const rsiChartVal = Object.values(rsi14)[0];
    // Fallback-Kette: Mansfield (Chart) → RSI (Chart) → RSI via TV Scanner
    const rsiScanVal  = rsiMap ? (rsiMap.get(s.symbol) ?? rsiMap.get(s.symbol.split(":").pop())) : null;
    const rsiVal      = (rsiChartVal != null && !isNaN(rsiChartVal)) ? rsiChartVal : rsiScanVal;
    const useRsi      = rsVal == null || isNaN(rsVal);
    const rsDisplay   = useRsi
      ? ((rsiVal != null && !isNaN(rsiVal))
          ? `${Number(rsiVal).toFixed(1)}<span style="font-size:9px;color:#9ca3af"> RSI</span>`
          : "–")
      : Number(rsVal).toFixed(2);

    const macdColor = String(macdH).startsWith("−") || String(macdH).startsWith("-")
      ? "#dc2626" : "#16a34a";

    // Volume-Alert: Highlight bei Volumen > 150% des Durchschnitts
    // parseVolume() konvertiert K/M/B korrekt (z.B. "776K" und "1.46M" werden beide zu absoluten Zahlen)
    const volNum   = parseVolume(volNow);
    const volMaNum = parseVolume(volMa);
    const volAlert = volMaNum > 0 && volNum > volMaNum * 1.5;
    const volStyle = volAlert
      ? "font-size:11px;color:#d97706;padding:5px 4px;white-space:nowrap;font-weight:700;text-align:right;overflow:hidden"
      : "font-size:11px;color:#6b7280;padding:5px 4px;white-space:nowrap;text-align:right;overflow:hidden";
    const volLabel = volAlert ? `🔥 ${volNow}<br><span style="color:#9ca3af;font-weight:400">MA ${volMa}</span>` : `${volNow}<br><span style="color:#9ca3af">MA ${volMa}</span>`;

    // RS-Trend vs. letzte Woche
    const rsTrendHtml = rsTrend(rsVal, rsHistory, s.symbol);

    const displayTicker = s.symbol.split(":").pop() || s.symbol;
    const displayName   = q.description || "";

    // ── CANSLIM Swing-Score (1–5 Punkte) ────────────────────────────────────
    const stage2ok   = stage2Map?.get(s.symbol) ?? stage2Map?.get(displayTicker) ?? false;
    const rsiNum     = (rsiVal != null && !isNaN(rsiVal)) ? Number(rsiVal) : null;
    const macdPos    = macdH !== "–" && !String(macdH).startsWith("-") && !String(macdH).startsWith("−");

    let swingScore = 0;
    if (stage2ok)                                    swingScore += 2;  // Stage-2: Kernkriterium
    if (rsiNum != null && rsiNum >= 50 && rsiNum < 75) swingScore += 1;  // RSI bullish, nicht überkauft
    if (macdPos)                                     swingScore += 1;  // MACD-Histogramm positiv
    if (volAlert)                                    swingScore += 1;  // Volumen-Surge = Interesse

    const swingStars = "★".repeat(swingScore) + "☆".repeat(5 - swingScore);
    const swingColor = swingScore >= 4 ? "#16a34a"
      : swingScore >= 3 ? "#d97706"
      : swingScore >= 2 ? "#6b7280"
      : "#dc2626";

    // ── Voigt Swing-Analyse ──────────────────────────────────────────────────
    // stage2 wurde in morning.js noch auf false gesetzt (kommt aus fetchWatchlistStage2).
    // Hier ergänzen wir den korrekten stage2-Wert und berechnen neu (oder nutzen voigt direkt).
    let voigtResult = s.voigt ?? null;
    if (voigtResult && voigtResult.weeklyRegime === 'ROT' && stage2ok) {
      // Neu berechnen mit korrektem stage2
      const macdHNum = macdPos ? Math.abs(parseFloat(macdH)) : (macdPos === false ? -1 : null);
      const mansRS = (() => {
        const mansfield = (s.daily?.indicators?.studies || []).find(i => i.name?.includes('Mansfield'));
        const v = Object.values(mansfield?.values || {})[0];
        return typeof v === 'number' ? v : null;
      })();
      voigtResult = runVoigtAnalysis({ dailyBars: s.daily?.ohlcv_bars ?? [], stage2: stage2ok, mansRS, macdH: macdHNum });
    } else if (!voigtResult && (s.daily?.ohlcv_bars?.length ?? 0) >= 15) {
      // Fallback: frisch berechnen
      const mansRS = (() => {
        const mansfield = (s.daily?.indicators?.studies || []).find(i => i.name?.includes('Mansfield'));
        const v = Object.values(mansfield?.values || {})[0];
        return typeof v === 'number' ? v : null;
      })();
      voigtResult = runVoigtAnalysis({ dailyBars: s.daily.ohlcv_bars, stage2: stage2ok, mansRS, macdH: macdPos ? 1 : -1 });
    }

    // Voigt-Badge HTML
    const voigtBadgeHtml = (() => {
      if (!voigtResult) return '';
      const { weeklyRegime, setupActive, setupQuality, correction } = voigtResult;
      const regimeColor  = weeklyRegime === 'GRÜN' ? '#16a34a' : weeklyRegime === 'GELB' ? '#d97706' : '#dc2626';
      const regimeEmoji  = weeklyRegime === 'GRÜN' ? '🟢' : weeklyRegime === 'GELB' ? '🟡' : '🔴';
      if (!setupActive) {
        return `<div style="font-size:8px;color:#9ca3af;margin-top:2px;line-height:1.2" title="Voigt: Kein aktives Setup">${regimeEmoji} kein Setup</div>`;
      }
      const qualColor = setupQuality === 'A' ? '#16a34a' : setupQuality === 'B' ? '#d97706' : '#6b7280';
      return `<div style="margin-top:2px;display:flex;align-items:center;gap:2px">
        <span style="background:${regimeColor}22;color:${regimeColor};border-radius:3px;padding:1px 4px;font-size:9px;font-weight:800">${regimeEmoji} Voigt</span>
        <span style="background:${qualColor}22;color:${qualColor};border-radius:3px;padding:1px 4px;font-size:9px;font-weight:800">Qual.${setupQuality}</span>
      </div>
      <div style="font-size:8px;color:#6b7280;margin-top:1px">${correction?.duration ?? '?'}d Pullback</div>`;
    })();

    // ── Options-Setup ────────────────────────────────────────────────────────
    // IVRank (aus TradingView Chart) bevorzugen, Yahoo-IV als Fallback
    const ivData  = ivMap?.get(s.symbol) ?? ivMap?.get(displayTicker) ?? null;
    const ivDisplay = ivRankNum ?? (ivData ? Math.round(ivData.iv_pct) : null);
    const ivLabel   = ivRankNum != null ? "IVR" : "IV";
    const ivForClassify = ivDisplay ?? null;
    const opts    = ivForClassify != null ? classifyOptions({ iv_pct: ivForClassify, stage2: stage2ok, rsi: rsiNum }) : null;

    const ivEmoji = ivDisplay == null ? ""
      : ivDisplay >= 50 ? "🔥" : ivDisplay >= 30 ? "📈" : "";
    const stratColor = { CC: ["#dbeafe","#1d4ed8"], CSP: ["#d1fae5","#065f46"], IC: ["#ede9fe","#6d28d9"], "Long C": ["#fef3c7","#92400e"] };
    const [sBg, sTxt] = stratColor[opts?.strategy] ?? ["#f3f4f6","#9ca3af"];

    const optsHtml = (opts && opts.strategy !== "–" && ivDisplay != null)
      ? `<div style="display:flex;align-items:center;justify-content:center;gap:2px;margin-top:2px">
           <span style="background:${sBg};color:${sTxt};border-radius:3px;padding:1px 4px;font-size:9px;font-weight:800;white-space:nowrap">${opts.strategy}</span>
           <span style="font-size:9px;color:#374151;white-space:nowrap">${ivEmoji}${ivLabel} ${ivDisplay}%</span>
         </div>
         <div style="font-size:8px;color:#9ca3af;line-height:1.2">${"★".repeat(opts.stars)}${"☆".repeat(3 - opts.stars)}</div>`
      : ivDisplay != null
        ? `<div style="font-size:9px;color:#9ca3af;margin-top:2px">${ivEmoji}${ivLabel} ${ivDisplay}%</div>`
        : `<div style="font-size:9px;color:#e5e7eb;margin-top:2px">–</div>`;

    // Zeilen-Hintergrund: orangegelb bei Volume-Alert
    const rowBg = volAlert ? "background:#fffbeb" : "";

    const truncName = displayName.length > 22 ? displayName.slice(0, 20) + "…" : displayName;
    return `<tr style="border-bottom:1px solid #f3f4f6;${rowBg}">
      <td style="font-weight:700;padding:5px 4px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${displayTicker}</td>
      <td style="color:#6b7280;font-size:11px;padding:5px 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(displayName)}">${esc(truncName)}</td>
      <td style="text-align:right;font-weight:600;padding:5px 4px;font-size:12px;overflow:hidden">${price}</td>
      <td style="text-align:right;padding:5px 4px;font-size:12px;overflow:hidden">${dailyCh !== null ? trend(dailyCh) : "–"}</td>
      <td style="text-align:right;padding:5px 4px;font-size:11px;color:#6b7280;overflow:hidden">${trend(perfCh)}</td>
      <td style="text-align:right;color:${macdColor};padding:5px 4px;font-size:11px;overflow:hidden">${macdH}</td>
      <td style="${volStyle}">${volLabel}</td>
      <td style="text-align:right;font-size:11px;padding:5px 4px;overflow:hidden;white-space:nowrap">${rsDisplay}&nbsp;${rsTrendHtml}</td>
      <td style="text-align:center;padding:5px 4px;white-space:nowrap">
        <div style="color:${swingColor};font-size:10px;letter-spacing:-0.5px;line-height:1.2" title="Swing-Score: Stage-2 +Volumen +RSI +MACD">${swingStars}</div>
        ${voigtBadgeHtml}
        ${optsHtml}
      </td>
      <td style="text-align:center;padding:5px 2px">${stage2ok ? `<span style="background:#16a34a;color:#fff;border-radius:3px;padding:1px 4px;font-size:8px;font-weight:800">S2</span>` : `<span style="color:#e5e7eb;font-size:8px">–</span>`}</td>
    </tr>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;background:#f3f4f6;margin:0;padding:16px}
  .wrap{max-width:680px;margin:0 auto}
  .card{background:#fff;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.08);padding:20px 18px;margin-bottom:14px;overflow:hidden}
  h1{margin:0 0 4px;font-size:20px;font-weight:700}
  h2{margin:0 0 4px;font-size:17px;font-weight:700}
  .sub{color:#6b7280;font-size:12px;margin:0 0 14px;line-height:1.5}
  table{width:100%;border-collapse:collapse;font-size:12px}
  .brief-table{table-layout:fixed;width:100%}
  .brief-table th{background:#f9fafb;text-align:left;padding:5px 4px;font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:.04em;border-bottom:2px solid #e5e7eb;white-space:nowrap;overflow:hidden}
  .brief-table td{padding:5px 4px;border-bottom:1px solid #f3f4f6;vertical-align:middle;overflow:hidden}
  .brief-table tr:last-child td{border-bottom:none}
  .brief-table tr:hover td{background:#fafafa}
  .footer{text-align:center;font-size:11px;color:#9ca3af;margin-top:10px;padding-bottom:8px}
</style>
</head>
<body><div class="wrap">

  <div class="card">
    <h1>🌍 Markt-Regime</h1>
    <p class="sub">${new Date(data.generated_at).toLocaleDateString("de-DE", { weekday:"long", day:"2-digit", month:"long", year:"numeric" })} &nbsp;·&nbsp; ${new Date(data.generated_at).toLocaleTimeString("de-DE")} &nbsp;·&nbsp; ${(mode === "closing" || mode === "flash-closing") ? "🌙 Closing Bell vom Vortag" : isSlim ? "⚡ Tages-Flash" : "📈 Deep Brief"}</p>
    ${formatMarketHtml(marketData)}
    ${!isSlim ? formatLochnerHtml(lochnerData) : ""}
  </div>

  <div class="card">
    <h2>📅 Wochenkalender</h2>
    <p class="sub" style="margin-bottom:10px">KW ab ${calData?.week_label ?? ""} · Wichtige Makro-Ereignisse &amp; Watchlist-Earnings${fetchErrors.calendar ? fetchWarning("Kalender") : ""}</p>
    ${formatCalendarHtml(calData)}
  </div>

  <div class="card">
    <h1>📈 Daily Briefing – Watchlist (CANSLIM)</h1>
    <p class="sub">Watchlist: <strong>${data.watchlist_name || "–"}</strong> &nbsp;·&nbsp; ${(data.symbols_scanned || []).length} Symbole
    ${stage2Info ? ` &nbsp;·&nbsp; <span style="font-weight:700;color:${stage2Info.pct >= 70 ? "#16a34a" : stage2Info.pct >= 40 ? "#d97706" : "#dc2626"}">Stage-2-Health: ${stage2Info.count}/${stage2Info.total} (${stage2Info.pct}%)</span>` : ""}
    ${data.watchlist_source === "cache" ? ` &nbsp;·&nbsp; <span style="color:#d97706;font-weight:700">⚠️ Cache-Daten (TradingView nicht erreichbar)</span>` : ""}
    ${fetchErrors.stage2 ? fetchWarning("Stage-2-Daten") : ""}
    ${fetchErrors.rsi ? fetchWarning("RSI-Daten") : ""}
    ${fetchErrors.iv ? fetchWarning("Options-IV-Daten") : ""}
    ${isFriday && fetchErrors.weeklyPerf ? fetchWarning("Wochenrückblick") : ""}
    </p>

    <table class="brief-table">
      <colgroup>
        <col style="width:48px">
        <col style="width:95px">
        <col style="width:60px">
        <col style="width:52px">
        <col style="width:48px">
        <col style="width:52px">
        <col style="width:85px">
        <col style="width:62px">
        <col style="width:105px">
        <col style="width:28px">
      </colgroup>
      <thead><tr>
        <th>Symbol</th>
        <th>Name</th>
        <th style="text-align:right">Kurs</th>
        <th style="text-align:right">Tag %</th>
        <th style="text-align:right">60T %</th>
        <th style="text-align:right">MACD-H</th>
        <th style="text-align:right">Volumen</th>
        <th style="text-align:right">RSI (14)</th>
        <th style="text-align:center;font-size:9px;line-height:1.3">⚡ Swing<br>🎯 Optionen</th>
        <th style="text-align:center;font-size:9px">S2</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${isFriday && weeklyPerfHtml ? weeklyPerfHtml : ""}
  </div>

  ${(wlNews?.length || fetchErrors.news) ? `
  <div class="card">
    <h2>📰 Breaking News – Watchlist</h2>
    <p class="sub" style="margin-bottom:8px">Aktuellste Meldungen zu deinen Watchlist-Werten${fetchErrors.news ? fetchWarning("News") : ""}</p>
    ${formatWatchlistNewsHtml(wlNews)}
  </div>` : ""}

  <div class="card">
    <h2>🔍 CANSLIM Scanner · Top 5 USA + Top 5 Europa</h2>
    <p class="sub">Beste neue Kandidaten aus US + Europa · Sortiert nach ⭐ → MCap → 3M%</p>
    ${formatScannerHtml(scanData)}
  </div>

  ${!isSlim && tradermacherData?.success && tradermacherData?.ideas?.length ? `
  <div class="card">
    <h2>📊 Swingtrading-Ideen · Tradermacher</h2>
    <p class="sub">Top 3 aktuelle Trade-Setups aus @TradermacherDe · inkl. CANSLIM-Kommentar</p>
    ${formatTradermacherHtml(tradermacherData)}
  </div>` : ""}

  ${!isSlim && favoriteTradeData?.success ? `
  <div class="card" style="border:2px solid #1d4ed8;padding:0;overflow:hidden">
    ${formatFavoriteTradeHtml(favoriteTradeData)}
  </div>` : ""}

  <div class="footer">
    CANSLIM Swing Trading · TradingView MCP · Keine Anlageberatung<br>
    <a href="https://tradingview.com" style="color:#9ca3af">TradingView öffnen</a>
  </div>
</div></body></html>`;
}
