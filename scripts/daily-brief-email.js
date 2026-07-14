#!/usr/bin/env node
/**
 * daily-brief-email.js
 * Runs the CANSLIM morning/daily brief and sends it as HTML email via Gmail.
 *
 * Modes (via --mode=<mode>):
 *   closing   — 10:00 Uhr CEST: Vollständiges Briefing + Closing Bell vom Vortag
 *   daily     — 16:00 Uhr CEST: Vollständiges Briefing
 *
 * Struktur: Dieses Skript ist nur noch Bootstrap + Orchestrierung. Die eigentliche
 * Logik lebt in src/core/{process-lock,tv-launcher,translate,mailer}.js und in
 * scripts/templates/*.js (HTML-Templating).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { acquireLock, releaseLock } from "../src/core/process-lock.js";
import { ensureTradingViewRunning } from "../src/core/tv-launcher.js";
import { translateHeadlines } from "../src/core/translate.js";
import { sendEmail } from "../src/core/mailer.js";

import { runBrief } from "../src/core/morning.js";
import { disconnect as disconnectCdp } from "../src/connection.js";
import { runScan } from "../src/core/scanner.js";
import { runMarketCheck, fetchWeeklyPerformance, fetchWatchlistStage2, fetchWatchlistRsi } from "../src/core/market.js";
import { runLochnerSummary } from "../src/core/lochner.js";
import { runTradermacherIdeas } from "../src/core/tradermacher.js";
import { runFavoriteTrade } from "../src/core/favorite-trade.js";
import { runVoigtAnalysis } from "../src/core/voigt-analysis.js";
import { fetchCalendar } from "../src/core/calendar.js";
import { fetchWatchlistNews } from "../src/core/news.js";
import { fetchOptionsIv } from "../src/core/options.js";

import { loadRsHistory, saveRsHistory } from "./templates/helpers.js";
import { formatHtml } from "./templates/index.js";

// ── Modus erkennen ───────────────────────────────────────────────────────────

const modeArg = process.argv.find((a) => a.startsWith("--mode="));
// Modes:
//   daily         — 16:00 CEST: Vollständiges Briefing (Deep Brief)
//   closing       — 10:00 CEST: Closing Bell vom Vortag (Deep Brief)
//   flash         — täglich automatisch: schlanker Tages-Flash (kein Lochner/Tradermacher/Lieblingstrade)
//   flash-closing — Tages-Flash im Closing-Bell-Modus
const MODE = modeArg ? modeArg.split("=")[1] : "daily";

// Slim-Modus: kein YouTube-Transkript (Lochner/Tradermacher), kein Lieblingstrade
// Options-IV wird immer geladen (auch im Flash-Modus)
const IS_SLIM = MODE === "flash" || MODE === "flash-closing";


// ── Prozess-Guard (verhindert parallele Instanzen) ───────────────────────────

// Lock beim Start setzen
acquireLock();

// Lock bei normalem Exit und Fehlern freigeben
process.on("exit",    releaseLock);
process.on("SIGINT",  () => { releaseLock(); process.exit(130); });
process.on("SIGTERM", () => { releaseLock(); process.exit(143); });
process.on("uncaughtException", (err) => { releaseLock(); console.error(err); process.exit(1); });

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// .env manuell laden
const envPath = resolve(ROOT, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      val = val.replace(/\s+#.*$/, "");
    }
    process.env[m[1]] = val;
  }
}

const RECIPIENT = process.env.BRIEF_RECIPIENT || "willems.robert@gmail.com";

if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
  console.error("❌ .env fehlt oder GMAIL_USER/GMAIL_APP_PASSWORD nicht gesetzt.");
  process.exit(1);
}

// ── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`[${new Date().toISOString()}] Brief gestartet (Modus: ${MODE})…`);

  // ── Normaler Ablauf: morning oder daily ──────────────────────────────────
  try {
    // TradingView + Market parallel starten
    // Im Slim-Modus (flash): kein Lochner, kein Tradermacher
    const isFridayRun = new Date().getDay() === 5;
    const parallelTasks = [
      ensureTradingViewRunning(),
      runMarketCheck(),
      ...(IS_SLIM ? [] : [runLochnerSummary(), runTradermacherIdeas()]),
    ];
    const allResults = await Promise.allSettled(parallelTasks);
    // CDP-Singleton zurücksetzen — ensureChartLoaded kann die Seite neu geladen haben
    await disconnectCdp().catch(() => {});
    const tvResult     = allResults[0];
    const marketResult = allResults[1];
    const [lochnerResult, tradermacherResult] = IS_SLIM
      ? [{ status: "fulfilled", value: null }, { status: "fulfilled", value: null }]
      : [allResults[2], allResults[3]];

    if (tvResult.status === "rejected") throw tvResult.reason;

    const marketData = marketResult.status === "fulfilled" ? marketResult.value : null;
    if (marketData?.success) {
      console.log(`✅ Market Check: ${marketData.regime.color} ${marketData.regime.label} · VIX ${marketData.vix?.close?.toFixed(1) ?? "–"}`);
    } else {
      console.warn("⚠️  Market Check fehlgeschlagen:", marketResult.reason?.message || marketData?.error);
    }

    const lochnerData = lochnerResult.status === "fulfilled" ? lochnerResult.value : null;
    if (!IS_SLIM) {
      if (lochnerData?.success && lochnerData?.transcript_available) {
        console.log(`✅ Lochner: "${lochnerData.video?.title?.slice(0, 60)}" · ${lochnerData.info?.sentimentEmoji || ""} ${lochnerData.info?.sentiment || ""}`);
      } else if (lochnerData?.success) {
        console.warn(`⚠️  Lochner kein Transkript: "${lochnerData.video?.title?.slice(0, 50)}"`);
      } else {
        console.warn("⚠️  Lochner nicht verfügbar:", lochnerResult.reason?.message || lochnerData?.error);
      }
    }

    const tradermacherData = tradermacherResult.status === "fulfilled" ? tradermacherResult.value : null;
    if (!IS_SLIM) {
      if (tradermacherData?.success && tradermacherData?.ideas?.length) {
        console.log(`✅ Tradermacher: ${tradermacherData.ideas.length} Swing-Ideen aus ${tradermacherData.videos?.length ?? 0} Videos.`);
      } else {
        console.warn("⚠️  Tradermacher nicht verfügbar:", tradermacherResult.reason?.message || tradermacherData?.error);
      }
    } else {
      console.log("⚡ Slim-Modus: Lochner + Tradermacher übersprungen.");
    }

    // Brief + Scanner parallel
    // Scanner hat einen harten 90s-Timeout — falls scanner.tradingview.com oder Finviz
    // hängen, wird der Brief trotzdem ohne Scanner-Daten fertiggestellt.
    const watchlistSymbols = []; // wird nach runBrief befüllt
    const BRIEF_TIMEOUT_MS = 600_000;
    const SCANNER_TIMEOUT_MS = 90_000;
    const [briefResult, scanResult] = await Promise.allSettled([
      Promise.race([
        runBrief(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Brief Timeout nach ${BRIEF_TIMEOUT_MS / 1000}s`)), BRIEF_TIMEOUT_MS)
        ),
      ]),
      Promise.race([
        runScan({ markets: "all", min_stars: 3, top: 20 }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Scanner Timeout nach ${SCANNER_TIMEOUT_MS / 1000}s`)), SCANNER_TIMEOUT_MS)
        ),
      ]),
    ]);

    const data = briefResult.status === "fulfilled" ? briefResult.value : null;
    if (!data?.success) throw new Error(data?.error || briefResult.reason?.message || "Brief fehlgeschlagen");

    const scanData = scanResult.status === "fulfilled" ? scanResult.value : null;
    if (scanData) {
      console.log(`✅ Scanner: 🇺🇸 ${scanData.us_results?.length ?? 0} US + 🌍 ${scanData.europe_results?.length ?? 0} EU aus ${scanData.total_raw} gescannt.`);
    } else {
      console.warn("⚠️  Scanner fehlgeschlagen:", scanResult.reason?.message);
    }

    const symbols = (data.symbols_scanned || []).map((s) => s.symbol);

    // RS-History laden (für Trend-Vergleich)
    const rsHistory = loadRsHistory();

    // RS-Werte aus Brief extrahieren und speichern
    const currentRsMap = new Map();
    for (const s of data.symbols_scanned || []) {
      const mansf  = (s.daily?.indicators?.studies || []).find((i) => i.name?.includes("Mansfield"));
      const rsVal  = Object.values(mansf?.values || {})[0];
      if (rsVal != null) currentRsMap.set(s.symbol, rsVal);
    }
    // RS-History nur überschreiben wenn letzte Speicherung ≥5 Tage her ist
    const rsAge = rsHistory?.date ? (Date.now() - new Date(rsHistory.date).getTime()) / 86_400_000 : Infinity;
    if (currentRsMap.size > 0 && rsAge >= 5) saveRsHistory(currentRsMap);

    // Kalender, Stage-2, Wochenperf, News, RSI, Options-IV — immer parallel
    // Lieblingstrade nur im Full-Modus (Deep Brief)
    const isFridayMode = new Date().getDay() === 5;
    const baseParallel = [
      fetchCalendar(symbols),
      fetchWatchlistStage2(symbols),
      isFridayMode ? fetchWeeklyPerformance(symbols) : Promise.resolve(new Map()),
      fetchWatchlistNews(symbols, 12),
      fetchWatchlistRsi(symbols),
      fetchOptionsIv(symbols),
      ...(IS_SLIM ? [] : [
        scanData ? runFavoriteTrade(scanData) : Promise.resolve(null),
      ]),
    ];
    const baseResults = await Promise.allSettled(baseParallel);
    const [calResult, stage2Result, weeklyPerfResult, wlNewsResult, rsiResult, ivResult, favTradeResult] = IS_SLIM
      ? [...baseResults, { status: "fulfilled", value: null }]
      : baseResults;

    const calData    = calResult.status === "fulfilled"       ? calResult.value       : null;
    const stage2Map  = stage2Result.status === "fulfilled"    ? stage2Result.value    : new Map();
    const weeklyPerf = weeklyPerfResult.status === "fulfilled"? weeklyPerfResult.value: new Map();
    const wlNews     = wlNewsResult.status === "fulfilled"    ? wlNewsResult.value    : [];
    const rsiMap     = rsiResult.status === "fulfilled"       ? rsiResult.value       : new Map();
    const ivMap      = ivResult.status === "fulfilled"        ? ivResult.value        : new Map();
    const favTradeData   = favTradeResult.status === "fulfilled" ? favTradeResult.value : null;

    // Ein leerer Map/Array ist von einem fehlgeschlagenen Fetch nicht zu unterscheiden,
    // ohne den Rejection-Status separat zu tracken — daher hier explizit festhalten und
    // im Brief sichtbar flaggen (formatHtml/fetchWarning), statt still "0 Ergebnisse" zu zeigen.
    const fetchErrors = {
      calendar:   calResult.status === "rejected",
      stage2:     stage2Result.status === "rejected",
      weeklyPerf: weeklyPerfResult.status === "rejected",
      news:       wlNewsResult.status === "rejected",
      rsi:        rsiResult.status === "rejected",
      iv:         ivResult.status === "rejected",
    };
    for (const [key, failed] of Object.entries(fetchErrors)) {
      if (failed) console.warn(`⚠️  Fetch fehlgeschlagen: ${key}`);
    }

    console.log(`✅ RSI: ${rsiMap?.size ?? 0} Werte via TV Scanner.`);
    console.log(`✅ Options-IV: ${ivMap?.size / 2 ?? 0} Symbole mit IV-Daten.`);
    if (calData) {
      console.log(`✅ Kalender: ${calData.events?.length ?? 0} Ereignisse · ${calData.earnings?.length ?? 0} Earnings (Woche).`);
    }
    const stage2Symbols = [...(stage2Map?.entries() ?? [])].filter(([, v]) => v).map(([k]) => k);
    const stage2Count = stage2Symbols.length;
    console.log(`✅ Stage-2: ${stage2Count}/${stage2Map?.size ?? 0} Watchlist-Aktien im Uptrend: ${stage2Symbols.filter(s => s.includes(':')).join(', ') || '–'}`);
    // Debug: Matching für symbols_scanned
    for (const s of data.symbols_scanned || []) {
      const ticker = s.symbol.split(':').pop();
      const val = stage2Map?.get(s.symbol) ?? stage2Map?.get(ticker);
      if (val) console.log(`  S2 ✅ ${s.symbol} (matched)`);
    }
    console.log(`✅ News: ${wlNews?.length ?? 0} WL-Headlines.`);
    if (isFridayMode && weeklyPerf.size) {
      console.log(`✅ Wochenrückblick: ${weeklyPerf.size} Symbole geladen.`);
    }
    if (!IS_SLIM && favTradeData?.success) {
      const ft = favTradeData;
      const ftTicker = (ft.candidate?.symbol || "").split(":").pop();

      // Voigt: stage2 aus Scanner-REST (ft.stage2ok) ist zuverlässiger als Watchlist-Map
      // (Watchlist-Map kann anderen Key-Format haben → z.B. "NYSE:FIX" vs. "BATS:FIX")
      if (ft.voigt && ft.ohlcv_bars?.length) {
        const stage2ok = ft.stage2ok   // direkt aus runFavoriteTrade (Scanner REST)
                      ?? stage2Map?.get(ft.candidate.symbol)
                      ?? stage2Map?.get(ftTicker)
                      ?? false;
        ft.voigt = runVoigtAnalysis({ dailyBars: ft.ohlcv_bars, stage2: stage2ok, mansRS: null, macdH: null });
        console.log(`ℹ️  Voigt Lieblingstrade (stage2=${stage2ok}): Regime=${ft.voigt?.weeklyRegime} Qual=${ft.voigt?.setupQuality} aktiv=${ft.voigt?.setupActive}`);
      }

      console.log(`✅ Lieblingstrade: ${ftTicker} · Entry ${ft.setup?.entry?.toFixed(2)} · Stop ${ft.setup?.stop?.toFixed(2)} · Ziel ${ft.setup?.target?.toFixed(2)}`);
    } else if (!IS_SLIM) {
      console.warn("⚠️  Lieblingstrade nicht verfügbar:", favTradeResult.reason?.message || favTradeData?.error);
    }

    const count = symbols.length;

    // News ins Deutsche übersetzen
    const wlNewsDE = await translateHeadlines(wlNews);

    console.log(`✅ Brief: ${count} Symbole. Sende Email…`);

    const html = formatHtml(data, scanData, marketData, calData, MODE, rsHistory, stage2Map, weeklyPerf, wlNewsDE, rsiMap, ivMap, lochnerData, tradermacherData, favTradeData, IS_SLIM, fetchErrors);
    await sendEmail(html, count, marketData?.regime, MODE, IS_SLIM ? null : favTradeData);
    console.log(`✅ Email erfolgreich an ${RECIPIENT} gesendet.`);

    releaseLock();
    await disconnectCdp().catch(() => {});
    process.exit(0);

  } catch (err) {
    console.error("❌ Fehler:", err.message);
    releaseLock();
    await disconnectCdp().catch(() => {});
    process.exit(1);
  }
})();
