/**
 * Morning brief core logic.
 * Reads rules.json, scans watchlist symbols, returns structured data
 * for Claude to apply bias criteria and generate a session brief.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as chart from "./chart.js";
import * as data from "./data.js";
import * as watchlistCore from "./watchlist.js";
import { unpinPanel } from "./watchlist.js";
import { runVoigtAnalysis } from "./voigt-analysis.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../../");
const SESSIONS_DIR = join(homedir(), ".tradingview-mcp", "sessions");
const USER_DATA_DIR = resolve(join(homedir(), ".tradingview-mcp"));

function assertSafeRulesPath(p) {
  const resolved = resolve(p);
  const inProject =
    resolved === resolve(join(PROJECT_ROOT, "rules.json")) ||
    resolved.startsWith(resolve(PROJECT_ROOT) + "/");
  const inUserData = resolved.startsWith(USER_DATA_DIR + "/");
  if (!inProject && !inUserData) {
    throw new Error(
      `rules_path must live inside the project (${PROJECT_ROOT}) or ~/.tradingview-mcp/. Got: ${resolved}`,
    );
  }
}

function assertSafeDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(
      `Invalid date: ${dateStr}. Use YYYY-MM-DD (e.g. 2026-05-11).`,
    );
  }
}

function loadRules(rulesPath) {
  if (rulesPath) assertSafeRulesPath(rulesPath);

  const candidates = [
    rulesPath,
    join(PROJECT_ROOT, "rules.json"),
    join(homedir(), ".tradingview-mcp", "rules.json"),
  ].filter(Boolean);

  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return { rules: JSON.parse(readFileSync(p, "utf8")), path: p };
      } catch (e) {
        throw new Error(`Failed to parse rules.json at ${p}: ${e.message}`);
      }
    }
  }

  throw new Error(
    "No rules.json found. Copy rules.example.json to rules.json and fill in your trading rules.\n" +
      "Looked in:\n" +
      candidates
        .filter(Boolean)
        .map((p) => `  - ${p}`)
        .join("\n"),
  );
}

export async function runBrief({ rules_path } = {}) {
  const { rules, path: loadedFrom } = loadRules(rules_path);
  const {
    watchlist_name,
    default_timeframe = "D",
    confirm_timeframe = "60",
  } = rules;
  let watchlist = rules.watchlist || [];
  let watchlistSource = "live";

  // Watchlist-Cache: nach jedem erfolgreichen TV-Load gespeichert
  // Dient als Fallback wenn das TV-Panel nicht erreichbar ist (z.B. Kaltstart)
  const wlCachePath = join(resolve(__dirname, "../.."), "rules-watchlist-cache.json");

  function loadWlCache() {
    try {
      if (existsSync(wlCachePath)) {
        const cached = JSON.parse(readFileSync(wlCachePath, "utf8"));
        if (cached?.watchlist_name === watchlist_name && Array.isArray(cached?.symbols) && cached.symbols.length > 0) {
          return cached.symbols;
        }
      }
    } catch {}
    return null;
  }

  function saveWlCache(symbols) {
    try {
      writeFileSync(wlCachePath, JSON.stringify({
        watchlist_name,
        symbols,
        saved_at: new Date().toISOString(),
      }));
    } catch {}
  }

  // If watchlist_name is set, switch to that TradingView watchlist and read symbols from it
  if (watchlist_name) {
    try {
      await watchlistCore.switchTo({ name: watchlist_name });
      const wlData = await watchlistCore.get();
      await unpinPanel(); // CSS-Pin entfernen nachdem Symbole gelesen wurden
      if (wlData.symbols && wlData.symbols.length > 0) {
        watchlist = wlData.symbols.map((s) => s.symbol);
        saveWlCache(watchlist); // Cache für zukünftige Fallbacks speichern
      } else {
        throw new Error(`Watchlist "${watchlist_name}" appears to be empty or could not be read`);
      }
    } catch (err) {
      await unpinPanel().catch(() => {}); // CSS-Pin auch bei Fehler entfernen
      // Fallback: gecachte Watchlist verwenden wenn TV-Panel nicht erreichbar
      const cached = loadWlCache();
      if (cached) {
        console.warn(`⚠️  TV-Watchlist nicht erreichbar (${err.message}) — verwende gecachte Symbole (${cached.length} Symbole).`);
        watchlist = cached;
        watchlistSource = "cache";
      } else {
        // Kein Cache und kein rules.watchlist → Fehler
        if (!watchlist.length) {
          throw new Error(`Failed to load watchlist "${watchlist_name}" from TradingView: ${err.message}`);
        }
        console.warn(`⚠️  TV-Watchlist nicht erreichbar — verwende rules.json watchlist (${watchlist.length} Symbole).`);
      }
    }
  }

  if (!watchlist.length) {
    throw new Error(
      "No symbols found. Add symbols to your watchlist or set a non-empty watchlist array in rules.json.",
    );
  }

  // Limit to configured max symbols (default 5)
  const maxSymbols = rules.max_symbols ?? 5;
  watchlist = watchlist.slice(0, maxSymbols);

  // Save current chart state so we can restore after scanning
  let originalSymbol, originalTimeframe;
  try {
    const currentState = await chart.getState();
    originalSymbol = currentState.symbol;
    originalTimeframe = currentState.resolution;
  } catch (_) {}

  const results = [];

  // Helper: extrahiert Ticker-Teil aus Symbol (z.B. "NASDAQ:AAPL" → "AAPL", "AAPL" → "AAPL")
  const tickerOf = (s) => (s || "").split(":").pop().toUpperCase();

  for (const symbol of watchlist) {
    try {
      await chart.setSymbol({ symbol });
      // 3s warten: Watchlist mit 20+ Symbolen braucht etwas mehr Ladezeit pro Symbol
      await new Promise((r) => setTimeout(r, 3000));

      // --- Daily timeframe: trend, base, volume pattern ---
      await chart.setTimeframe({ timeframe: default_timeframe });
      await new Promise((r) => setTimeout(r, 2500));

      const [dailyState, dailyIndicators, quote, dailyOhlcvRaw] = await Promise.all([
        chart.getState(),
        data.getStudyValues(),
        data.getQuote({}),
        data.getOhlcv({ count: 60, summary: false }).catch(() => null),
      ]);

      // Individuelle Bars extrahieren (für Voigt-Analyse)
      const dailyBars = dailyOhlcvRaw?.bars ?? [];

      // Summary-Felder aus den Raw-Bars berechnen (rückwärtskompatibel)
      const dailyOhlcv = dailyBars.length > 0 ? {
        last_5_bars: dailyBars.slice(-5),
        change_pct: dailyBars.length >= 2
          ? (Math.round(((dailyBars.at(-1).close - dailyBars[0].open) / dailyBars[0].open) * 10000) / 100) + '%'
          : null,
      } : null;

      // Voigt-Analyse auf Basis der Daily-Bars
      const mansfield = (dailyIndicators?.studies || []).find(s => s.name?.includes('Mansfield'));
      const mansRSRaw = Object.values(mansfield?.values || {})[0];
      const mansRS = typeof mansRSRaw === 'number' ? mansRSRaw : null;
      const macdStudy = (dailyIndicators?.studies || []).find(s => s.name?.includes('Convergence'));
      const macdHRaw  = Object.values(macdStudy?.values || {})[0];
      const macdH  = typeof macdHRaw === 'number' ? macdHRaw : null;
      // stage2 kommt erst später (aus fetchWatchlistStage2) — wird in formatHtml() ergänzt
      const voigt = runVoigtAnalysis({ dailyBars, stage2: false, mansRS, macdH });

      // ── Symbol-Verifikation: Chart muss das richtige Symbol zeigen ──────────
      const actualTicker  = tickerOf(dailyState?.symbol);
      const expectedTicker = tickerOf(symbol);
      if (actualTicker && expectedTicker && actualTicker !== expectedTicker) {
        // Chart zeigt noch altes Symbol — einmal neu versuchen
        console.warn(`[Brief] Symbol-Mismatch für ${symbol}: Chart zeigt ${dailyState?.symbol} — 2. Versuch…`);
        await chart.setSymbol({ symbol });
        await new Promise((r) => setTimeout(r, 5000));
        const [retryState, retryIndicators, retryQuote, retryOhlcvRaw] = await Promise.all([
          chart.getState(),
          data.getStudyValues(),
          data.getQuote({}),
          data.getOhlcv({ count: 60, summary: false }).catch(() => null),
        ]);
        const retryBars = retryOhlcvRaw?.bars ?? [];
        const retryOhlcv = retryBars.length > 0 ? {
          last_5_bars: retryBars.slice(-5),
          change_pct: retryBars.length >= 2
            ? (Math.round(((retryBars.at(-1).close - retryBars[0].open) / retryBars[0].open) * 10000) / 100) + '%'
            : null,
        } : null;
        const retryTicker = tickerOf(retryState?.symbol);
        if (retryTicker !== expectedTicker) {
          console.warn(`[Brief] Symbol-Mismatch nach Retry: ${symbol} → ${retryState?.symbol} — überspringe.`);
          results.push({ symbol, error: `Symbol-Mismatch: Chart zeigt ${retryState?.symbol}` });
          continue;
        }
        const retryMansfield = (retryIndicators?.studies || []).find(s => s.name?.includes('Mansfield'));
        const retryMansRS = typeof Object.values(retryMansfield?.values || {})[0] === 'number'
          ? Object.values(retryMansfield.values)[0] : null;
        const retryMacdStudy = (retryIndicators?.studies || []).find(s => s.name?.includes('Convergence'));
        const retryMacdH = typeof Object.values(retryMacdStudy?.values || {})[0] === 'number'
          ? Object.values(retryMacdStudy.values)[0] : null;
        const retryVoigt = runVoigtAnalysis({ dailyBars: retryBars, stage2: false, mansRS: retryMansRS, macdH: retryMacdH });
        results.push({
          symbol,
          daily: { timeframe: default_timeframe, state: retryState, indicators: retryIndicators, ohlcv_summary: retryOhlcv, ohlcv_bars: retryBars, quote: retryQuote },
          voigt: retryVoigt,
        });
        continue;
      }
      // ── Ende Symbol-Verifikation ─────────────────────────────────────────────

      results.push({
        symbol,
        daily: {
          timeframe: default_timeframe,
          state: dailyState,
          indicators: dailyIndicators,
          ohlcv_summary: dailyOhlcv,
          ohlcv_bars: dailyBars,
          quote,
        },
        voigt,
      });
    } catch (err) {
      results.push({ symbol, error: err.message });
    }
  }

  // Restore original chart state
  if (originalSymbol) {
    try {
      await chart.setSymbol({ symbol: originalSymbol });
      if (originalTimeframe)
        await chart.setTimeframe({ timeframe: originalTimeframe });
    } catch (_) {}
  }

  return {
    success: true,
    generated_at: new Date().toISOString(),
    strategy: "CANSLIM Swing Trading — 5-Sterne-Setup",
    watchlist_name: watchlist_name || "rules.json",
    watchlist_source: watchlistSource,
    rules_loaded_from: loadedFrom,
    rules: {
      five_star_criteria: rules.five_star_criteria || null,
      bias_criteria: rules.bias_criteria || null,
      entry_rules: rules.entry_rules || null,
      exit_rules: rules.exit_rules || null,
      risk_rules: rules.risk_rules || null,
      market_filters: rules.market_filters || null,
      notes: rules.notes || null,
    },
    symbols_scanned: results,
    instruction: [
      "Du bist ein erfahrener CANSLIM Swing Trader nach Minervini/O'Neil.",
      "Bewerte jedes Symbol anhand der 5 Kriterien aus five_star_criteria.",
      "Nutze Daily-Daten für Trend, Basis und Volumen. Nutze Hourly für Entry-Timing.",
      "Ausgabeformat pro Symbol:",
      "⭐ RATING: [1-5 Sterne] | SYMBOL (Name) | Preis: [close]",
      "  Kriterium 1 Stage2: [✓/✗] [Begründung aus Indicators/OHLCV]",
      "  Kriterium 2 Rel.Stärke: [✓/✗] [Mansfield RS Wert wenn vorhanden]",
      "  Kriterium 3 Basis/VCP: [✓/✗] [Tight/Wide, Wochen in Basis]",
      "  Kriterium 4 Volumen: [✓/✗] [Dry-Up/Breakout-Volumen vs MA]",
      "  Kriterium 5 CANSLIM: [~] [Fundamentals nicht in Chart-Daten — manuell prüfen]",
      "  → Empfehlung: [Kaufen bei Pivot X.XX / Weiter beobachten / Kein Setup]",
      "Abschluss: 1 Satz Marktlage + beste Kandidaten des Tages.",
      "Direkt und präzise. Kein Preamble.",
    ].join(" "),
  };
}

export function saveSession({ brief, date } = {}) {
  const dateStr = date || new Date().toISOString().split("T")[0];
  assertSafeDate(dateStr);
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const filePath = join(SESSIONS_DIR, `${dateStr}.json`);

  const existing = existsSync(filePath)
    ? JSON.parse(readFileSync(filePath, "utf8"))
    : {};
  const record = {
    ...existing,
    date: dateStr,
    saved_at: new Date().toISOString(),
    brief,
  };

  writeFileSync(filePath, JSON.stringify(record, null, 2));
  return { success: true, path: filePath, date: dateStr };
}

export function getSession({ date } = {}) {
  const dateStr = date || new Date().toISOString().split("T")[0];
  assertSafeDate(dateStr);
  const filePath = join(SESSIONS_DIR, `${dateStr}.json`);

  if (existsSync(filePath)) {
    return { success: true, ...JSON.parse(readFileSync(filePath, "utf8")) };
  }

  // Fall back to yesterday
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];
  const yesterdayPath = join(SESSIONS_DIR, `${yesterdayStr}.json`);

  if (existsSync(yesterdayPath)) {
    return {
      success: true,
      note: "No session for today — returning yesterday",
      ...JSON.parse(readFileSync(yesterdayPath, "utf8")),
    };
  }

  return {
    success: false,
    error: `No session found for ${dateStr} or ${yesterdayStr}`,
    sessions_dir: SESSIONS_DIR,
  };
}
