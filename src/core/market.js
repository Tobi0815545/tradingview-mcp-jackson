/**
 * Market Regime Check
 * Holt Index- und VIX-Daten von der TradingView Scanner API (kein API-Key nötig)
 * und berechnet das aktuelle Marktregime für den Morning Brief.
 */

const TV_SCANNER = "https://scanner.tradingview.com";

// ── Zu überwachende Symbole ──────────────────────────────────────────────────

const WATCH_SYMBOLS = [
  // USA
  { symbol: "TVC:DJI",     label: "Dow Jones",    short: "DJI",    flag: "🇺🇸", type: "index" },
  { symbol: "CBOE:SPX",    label: "S&P 500",      short: "SPX",    flag: "🇺🇸", type: "index" },
  { symbol: "NASDAQ:NDX",  label: "Nasdaq 100",   short: "NDX",    flag: "🇺🇸", type: "index" },
  { symbol: "TVC:RUT",     label: "Russell 2000", short: "RUT",    flag: "🇺🇸", type: "index" },
  // Europa
  { symbol: "XETR:DAX",    label: "DAX",          short: "DAX",    flag: "🇩🇪", type: "index" },
  { symbol: "TVC:SX5E",    label: "Euro Stoxx 50",short: "SX5E",   flag: "🇪🇺", type: "index" },
  // Japan
  { symbol: "TVC:NI225",   label: "Nikkei 225",   short: "NI225",  flag: "🇯🇵", type: "index" },
  // China
  { symbol: "TVC:HSI",     label: "Hang Seng",    short: "HSI",    flag: "🇨🇳", type: "index" },
  // Volatilität
  { symbol: "TVC:VIX",     label: "VIX",          short: "VIX",    flag: "",    type: "vix"   },
];

// Spalten: close, EMA50, SMA150, SMA200, change%, Perf.1M, Perf.3M, RSI
const COLUMNS = [
  "close",       // 0
  "EMA50",       // 1
  "SMA150",      // 2
  "SMA200",      // 3
  "change",      // 4 — Tagesänderung %
  "Perf.1M",     // 5
  "Perf.3M",     // 6
  "RSI",         // 7
];

// ── Daten abrufen ────────────────────────────────────────────────────────────

async function fetchIndexData() {
  const tickers = WATCH_SYMBOLS.map((s) => s.symbol);

  const res = await fetch(`${TV_SCANNER}/global/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      symbols: { tickers },
      columns: COLUMNS,
    }),
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${txt.slice(0, 80)}`);
  }

  const json = await res.json();

  // Ergebnis als Map aufbauen (Symbol → Daten-Array)
  const bySymbol = new Map();
  for (const row of json.data || []) {
    bySymbol.set(row.s, row.d || []);
  }

  return WATCH_SYMBOLS.map(({ symbol, label, short, flag, type }) => {
    const d   = bySymbol.get(symbol) || [];
    const get = (i) => (d[i] !== undefined && d[i] !== null ? d[i] : null);

    return {
      symbol, label, short, flag, type,
      close:   get(0),
      ema50:   get(1),
      sma150:  get(2),
      sma200:  get(3),
      change:  get(4),
      perf1m:  get(5),
      perf3m:  get(6),
      rsi:     get(7),
      // Abgeleitete Felder
      aboveEma50:  get(0) !== null && get(1) !== null ? get(0) > get(1) : null,
      aboveSma150: get(0) !== null && get(2) !== null ? get(0) > get(2) : null,
      aboveSma200: get(0) !== null && get(3) !== null ? get(0) > get(3) : null,
      fullyAligned: get(0) !== null && get(1) !== null && get(2) !== null && get(3) !== null
        ? get(0) > get(1) && get(1) > get(2) && get(2) > get(3)
        : null,
    };
  });
}

// ── Regime-Berechnung ────────────────────────────────────────────────────────

function calcRegime(allData) {
  const spy   = allData.find((d) => d.short === "SPX");
  const qqq   = allData.find((d) => d.short === "NDX");
  const iwm   = allData.find((d) => d.short === "RUT");
  const dax   = allData.find((d) => d.short === "DAX");
  const sx5e  = allData.find((d) => d.short === "SX5E");
  const ni225 = allData.find((d) => d.short === "NI225");
  const hsi   = allData.find((d) => d.short === "HSI");
  const vix   = allData.find((d) => d.type  === "vix");

  const vixLevel = vix?.close ?? null;

  // Hilfsfunktion: Status-Badge für einen Index
  const maStatus = (idx) => {
    if (!idx || idx.close === null) return "?";
    if (idx.fullyAligned) return "✅";       // voll ausgerichtet
    if (idx.aboveSma200)  return "🟡";       // über MA200, aber MA50/150 nicht korrekt
    return "🔴";                              // unter MA200
  };

  // ── Regime-Logik ────────────────────────────────────────────────────────────
  let signal, color, label, description, action;

  const spyOk  = spy?.fullyAligned === true;
  const qqqOk  = qqq?.fullyAligned === true;
  const spyAbove200 = spy?.aboveSma200 === true;
  const qqqAbove200 = qqq?.aboveSma200 === true;
  const highVix = vixLevel !== null && vixLevel > 35;
  const elevVix = vixLevel !== null && vixLevel > 25;

  if (highVix) {
    // VIX > 35: Extreme Angst — kein Long-Trading unabhängig von MAs
    signal      = "EXTREME_FEAR";
    color       = "🔴";
    label       = "EXTREME FEAR / CRASH-MODUS";
    description = "VIX > 35 — Markt in Panik. Kein Long-Trading. Bestehende Positionen absichern oder schließen.";
    action      = "KEIN LONG-TRADING · Cash halten · Puts als Hedge prüfen";
  } else if (!spyAbove200 && !qqqAbove200) {
    // Beide Leitindizes unter MA200 → klarer Downtrend
    signal      = "DOWNTREND";
    color       = "🔴";
    label       = "DOWNTREND";
    description = "SPY & QQQ unter MA200. Institutionelle Verkäufer dominieren den Markt.";
    action      = "KEIN LONG-TRADING · Cash ist eine Position · Short-Opportunitäten prüfen";
  } else if (spyOk && qqqOk && !elevVix) {
    // Beide Leitindizes vollständig ausgerichtet, VIX moderat
    signal      = "CONFIRMED_UPTREND";
    color       = "🟢";
    label       = "CONFIRMED UPTREND";
    description = "SPY & QQQ im Stage 2 Uptrend. Optimales Umfeld für CANSLIM-Breakouts.";
    action      = "VOLLE RISIKOBEREITSCHAFT · Alle Setups handelbar · Breakouts aggressiv traden";
  } else if (spyAbove200 && qqqAbove200 && !elevVix) {
    // Über MA200 aber MA50/150 nicht perfekt ausgerichtet
    signal      = "UPTREND_UNDER_PRESSURE";
    color       = "🟡";
    label       = "UPTREND UNDER PRESSURE";
    description = "Indizes über MA200, aber MA50/MA150-Ausrichtung gestört. Verteilung möglich.";
    action      = "NUR 5★-SETUPS · Halbe Positionsgröße · Stop-Loss eng setzen";
  } else if ((spyAbove200 || qqqAbove200) && elevVix) {
    // MA200 noch gehalten aber VIX erhöht → Druck
    signal      = "UPTREND_UNDER_PRESSURE";
    color       = "🟡";
    label       = "UPTREND UNDER PRESSURE";
    description = `VIX ${vixLevel?.toFixed(1)} — erhöhte Volatilität. Indizes kämpfen um MA200.`;
    action      = "NUR 5★-SETUPS · Halbe Positionsgröße · Auf Beruhigung warten";
  } else {
    // Ein Index unter MA200 / Erholungsversuch
    signal      = "RALLY_ATTEMPT";
    color       = "🟠";
    label       = "RALLY ATTEMPT";
    description = "Mindestens ein Leitindex unter MA200. Möglicher Erholungsversuch, noch keine Bestätigung.";
    action      = "ABWARTEN · Follow-Through Day (FTD) abwarten · Keine neuen Positionen";
  }

  return {
    signal, color, label, description, action, vixLevel,
    index_status: {
      spx:   maStatus(spy),
      ndx:   maStatus(qqq),
      rut:   maStatus(iwm),
      dax:   maStatus(dax),
      sx5e:  maStatus(sx5e),
      ni225: maStatus(ni225),
      hsi:   maStatus(hsi),
    },
  };
}

// ── VIX Terminstruktur ───────────────────────────────────────────────────────

// CBOE VIX-Subindizes via Yahoo Finance (keine Browser-Session nötig für Indizes)
const VIX_YAHOO_SYMBOLS = [
  { ticker: "%5EVIX9D", label: "9D"  },   // ^VIX9D  — 9-Tage VIX
  { ticker: "%5EVIX",   label: "30D" },   // ^VIX    — 30-Tage VIX (Standard)
  { ticker: "%5EVIX3M", label: "3M"  },   // ^VIX3M  — 3-Monats VIX
  { ticker: "%5EVIX6M", label: "6M"  },   // ^VIX6M  — 6-Monats VIX
  { ticker: "%5EVIX1Y", label: "1Y"  },   // ^VIX1Y  — 1-Jahres VIX
];

// Zentrale Yahoo Finance Chart-Funktion (ersetzt fetchYahooQuote + doppelte fetch-Logik)
async function fetchYahooChart(encodedTicker, range = "1d", interval = "1d") {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodedTicker}?interval=${interval}&range=${range}`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          "Accept":     "application/json",
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function fetchVixTermStructure() {
  try {
    // Alle VIX-Subindizes parallel abrufen
    const results = await Promise.allSettled(
      VIX_YAHOO_SYMBOLS.map(async ({ ticker, label }) => {
        const json  = await fetchYahooChart(ticker, "1d", "1d");
        const value = json?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
        return { label, value };
      })
    );

    const points = results
      .map((r) => r.status === "fulfilled" ? r.value : null)
      .filter((p) => p !== null && p.value !== null);

    if (points.length < 2) return null;

    // Struktur: 9D < 30D = normal (Contango), 9D > 30D = Stress (Backwardation)
    const short = points.find((p) => p.label === "9D")?.value;
    const long30 = points.find((p) => p.label === "30D")?.value;
    const structure = short && long30
      ? (short < long30 ? "contango" : "backwardation")
      : "unknown";

    return { points, structure, fetched_at: new Date().toISOString() };
  } catch (err) {
    console.warn("⚠️  VIX Terminstruktur fehlgeschlagen:", err.message);
    return null;
  }
}

// ── Fear & Greed Index (CNN) ─────────────────────────────────────────────────

async function fetchFearGreed() {
  try {
    const res = await fetch(
      "https://production.dataviz.cnn.io/index/fearandgreed/graphdata/",
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
          "Referer":    "https://edition.cnn.com/markets/fear-and-greed",
          "Accept":     "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();

    const fg = json.fear_and_greed;
    if (!fg) throw new Error("Kein fear_and_greed Feld");

    const score = Math.round(fg.score ?? 0);

    // Rating auf Deutsch
    const ratingDe = (r) => {
      const map = {
        "extreme fear": "Extreme Angst",
        "fear":         "Angst",
        "neutral":      "Neutral",
        "greed":        "Gier",
        "extreme greed":"Extreme Gier",
      };
      return map[(r || "").toLowerCase()] || r;
    };

    return {
      score,
      rating:           ratingDe(fg.rating),
      rating_en:        fg.rating,
      prev_close:       Math.round(fg.previous_close ?? score),
      prev_1week:       Math.round(fg.previous_1_week ?? score),
      prev_1month:      Math.round(fg.previous_1_month ?? score),
      fetched_at:       new Date().toISOString(),
    };
  } catch (err) {
    console.warn("⚠️  Fear & Greed fehlgeschlagen:", err.message);
    return null;
  }
}

// ── Pre-Market Futures & Commodities ────────────────────────────────────────

const FUTURES_SYMBOLS = [
  { ticker: "ES=F",     label: "S&P 500 Fut.",  flag: "🇺🇸", group: "index"     },
  { ticker: "NQ=F",     label: "Nasdaq Fut.",   flag: "💻",  group: "index"     },
  { ticker: "YM=F",     label: "Dow Fut.",      flag: "🏭",  group: "index"     },
  { ticker: "RTY=F",    label: "Russell Fut.",  flag: "📊",  group: "index"     },
  { ticker: "GC=F",     label: "Gold",          flag: "🥇",  group: "commodity" },
  { ticker: "CL=F",     label: "Öl (WTI)",      flag: "🛢",  group: "commodity" },
  { ticker: "EURUSD=X", label: "EUR/USD",       flag: "💱",  group: "fx"        },
  { ticker: "DX=F",     label: "US-Dollar Idx", flag: "💵",  group: "fx"        },
  { ticker: "^TNX",     label: "US 10Y Rendite", flag: "🏦", group: "rates"     },
];

export async function fetchPreMarketData() {
  try {
    const results = await Promise.allSettled(
      FUTURES_SYMBOLS.map(async (sym) => {
        // Ticker URL-encodieren (DX=F → DX%3DF etc.) — fetchYahooChart nimmt bereits encoded
        const json   = await fetchYahooChart(encodeURIComponent(sym.ticker), "1d", "1m");
        const meta   = json?.chart?.result?.[0]?.meta ?? {};
        const price  = meta.regularMarketPrice ?? null;
        const prev   = meta.previousClose ?? meta.chartPreviousClose ?? null;
        const chgPct = price && prev ? ((price - prev) / prev) * 100 : null;
        return { ...sym, price, prev_close: prev, change_pct: chgPct };
      })
    );
    return results
      .map((r, i) => r.status === "fulfilled"
        ? r.value
        : { ...FUTURES_SYMBOLS[i], price: null, prev_close: null, change_pct: null })
      .filter((r) => r.price !== null);
  } catch (err) {
    console.warn("⚠️  Pre-Market Daten fehlgeschlagen:", err.message);
    return [];
  }
}

// ── Sektor-Performance (S&P-Sektoren via Yahoo Finance) ──────────────────────

const SECTOR_ETFS = [
  { ticker: "XLK",  label: "Technologie",  icon: "💻" },
  { ticker: "XLF",  label: "Finanzen",     icon: "🏦" },
  { ticker: "XLE",  label: "Energie",      icon: "⚡" },
  { ticker: "XLV",  label: "Gesundheit",   icon: "🏥" },
  { ticker: "XLC",  label: "Kommunik.",    icon: "📡" },
  { ticker: "XLI",  label: "Industrie",    icon: "🏭" },
  { ticker: "XLY",  label: "Konsum Zyk.",  icon: "🛍" },
  { ticker: "XLP",  label: "Konsum Def.",  icon: "🥫" },
  { ticker: "XLRE", label: "Immobilien",   icon: "🏠" },
  { ticker: "XLU",  label: "Versorger",    icon: "💡" },
  { ticker: "XLB",  label: "Rohstoffe",    icon: "⛏" },
];

// Berechnet Wochen- und Tagesperformance aus einem Yahoo-Chart-JSON (5d Range → exakt 5 Handelstage)
//
// WICHTIG zu chartPreviousClose vs. closes[]:
//   chartPreviousClose = Close VOR dem gesamten Chart-Fenster (z.B. bei 5d = Close von vor 6 Handelstagen).
//   Das ist NICHT "gestern" — für Tagesperformance daher closes[-2] verwenden!
//
//   closes[-1] = letzter Bar = heute (intraday) oder letzter vollständiger Close
//   closes[-2] = gestiger Close (vorletzter Bar) → korrekte Basis für perf_day
//   closes[0]  = ältester Bar der Periode → Basis für perf_week (= 5-Handelstage-Rolling)
function weekPerfFromJson(json) {
  const meta   = json?.chart?.result?.[0]?.meta ?? {};
  const closes = (json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? []).filter((c) => c != null);

  // Wochenperformance: ältester Close der 5d-Periode → aktueller Preis (= 5-Handelstage-Rolling)
  const price = meta.regularMarketPrice ?? closes[closes.length - 1] ?? null;
  const perfW = closes.length >= 2
    ? ((price - closes[0]) / closes[0]) * 100
    : null;

  // Tagesperformance: aktueller Preis vs. gestiger Close (= vorletzter Bar)
  // closes[-2] = gestern, schlägt chartPreviousClose (= Close vor der gesamten Periode, NICHT gestern!)
  const prevClose = closes.length >= 2
    ? closes[closes.length - 2]
    : null;
  const perfD = price != null && prevClose != null && prevClose !== 0
    ? ((price - prevClose) / prevClose) * 100
    : null;

  return { price, perf_week: perfW, perf_day: perfD };
}

export async function fetchSectorPerformance() {
  try {
    const results = await Promise.allSettled(
      SECTOR_ETFS.map(async (s) => {
        // "5d" statt "7d": liefert exakt 5 Handelstage → saubere 1-Woche-Rolling-Performance
        const json = await fetchYahooChart(encodeURIComponent(s.ticker), "5d", "1d");
        return { ...s, ...weekPerfFromJson(json) };
      })
    );
    return results
      .map((r, i) => r.status === "fulfilled"
        ? r.value
        : { ...SECTOR_ETFS[i], price: null, perf_week: null, perf_day: null })
      .filter((r) => r.perf_week !== null)
      .sort((a, b) => (b.perf_week ?? -99) - (a.perf_week ?? -99));  // sortiert hier, nicht im Formatter
  } catch (err) {
    console.warn("⚠️  Sektor-Performance fehlgeschlagen:", err.message);
    return [];
  }
}

// ── Wochen-Performance für beliebige Symbole ─────────────────────────────────

export async function fetchWeeklyPerformance(symbols = []) {
  if (!symbols.length) return new Map();
  const result = new Map();
  await Promise.allSettled(
    symbols.map(async (sym) => {
      const ticker = sym.includes(":") ? sym.split(":").pop() : sym;
      try {
        const json = await fetchYahooChart(encodeURIComponent(ticker), "5d", "1d");
        const { perf_week } = weekPerfFromJson(json);
        if (perf_week != null) {
          result.set(sym, perf_week);
          result.set(ticker, perf_week);   // auch Ticker-only für Fallback-Lookup
        }
      } catch { /* silent */ }
    })
  );
  return result;
}

// ── Stage-2-Status für Watchlist-Symbole ─────────────────────────────────────

export async function fetchWatchlistStage2(symbols = []) {
  if (!symbols.length) return new Map();
  try {
    const res = await fetch("https://scanner.tradingview.com/global/scan", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbols: { tickers: symbols },
        columns: ["close", "EMA50", "SMA150", "SMA200"],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const result = new Map();
    for (const row of json.data ?? []) {
      const d = row.d ?? [];
      const [close, ema50, sma150, sma200] = d;
      if (close != null && ema50 != null && sma150 != null && sma200 != null) {
        const isStage2 = close > ema50 && ema50 > sma150 && sma150 > sma200;
        result.set(row.s, isStage2);                           // z.B. "NASDAQ:AAPL"
        result.set(row.s.split(":").pop(), isStage2);         // Fallback: "AAPL"
      }
    }
    return result;
  } catch (err) {
    console.warn("⚠️  Stage-2-Check fehlgeschlagen:", err.message);
    return new Map();
  }
}

// ── RSI(14) für Watchlist-Symbole via TV Scanner ─────────────────────────────
// Zuverlässige Alternative zum Chart-Indikator (Mansfield RS) — liefert immer Werte.

export async function fetchWatchlistRsi(symbols = []) {
  if (!symbols.length) return new Map();
  try {
    const res = await fetch("https://scanner.tradingview.com/global/scan", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbols: { tickers: symbols },
        columns: ["RSI"],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const result = new Map();
    for (const row of json.data ?? []) {
      const rsi = row.d?.[0];
      if (rsi != null && !isNaN(rsi)) {
        result.set(row.s, rsi);
        result.set(row.s.split(":").pop(), rsi);
      }
    }
    return result;
  } catch (err) {
    console.warn("⚠️  RSI-Fetch fehlgeschlagen:", err.message);
    return new Map();
  }
}

// ── Buffett-Indikator (Total Market Cap / BIP) ───────────────────────────────
// Datenquelle: FRED öffentliche CSV-Endpoints (kein API-Key erforderlich)
//   WILL5000INDFC = Wilshire 5000 Full Cap, in Mrd. USD (monatlich)
//   GDP           = US-Nominal-BIP, in Mrd. USD, SAAR (quartalsweise)

async function fetchBuffettIndicator() {
  const parseFredAll = (csv) => {
    const entries = [];
    for (const line of csv.trim().split("\n").slice(1)) {
      const parts = line.split(",");
      const date  = (parts[0] ?? "").trim();
      const n     = parseFloat((parts[1] ?? "").trim());
      if (date && !isNaN(n) && n > 0) entries.push({ date, value: n });
    }
    return entries;
  };

  const fredFetch = async (id) => {
    const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`FRED ${id} HTTP ${res.status}`);
    return parseFredAll(await res.text());
  };

  const fredCsv = async (id) => {
    const all = await fredFetch(id);
    return all.length > 0 ? all[all.length - 1] : null;
  };

  // Marktkapitalisierung: W5000 Index (Yahoo, täglich) × Kalibrierungsfaktor (Fed Z.1, quartalsweise)
  // Fed NCBEILQ027S = echte US-Aktienmarktkapitalisierung in Mio USD
  // Faktor = Fed-Marktkapitalisierung / W5000-Index AM FED-STICHTAG (nicht heute!) → auf den
  // heutigen W5000-Stand projiziert. Ohne historischen W5000-Wert am Stichtag würde sich der
  // Faktor exakt herauskürzen (w5000Now × (fedMcap/w5000Now) = fedMcap) und der Indikator nie
  // täglich aktualisieren, sondern immer nur den alten Fed-Quartalswert zurückgeben.
  const fetchMcapCalibrated = async () => {
    const fedMcap = await fredCsv("NCBEILQ027S");
    if (!fedMcap?.value) throw new Error("Fed Z.1 Marktkapitalisierung nicht verfügbar");
    const fedMcapBn = fedMcap.value / 1000;

    // W5000-Historie holen (liefert sowohl "heute" als auch den Stand am Fed-Stichtag).
    // WICHTIG: meta.regularMarketPrice ist für ^W5000 bei Yahoo unzuverlässig — liefert teils
    // einen veralteten Snapshot (regularMarketTime kann Jahre zurückliegen), während
    // chartPreviousClose/die Historie aktuell sind. Daher NICHT meta.regularMarketPrice nutzen,
    // sondern den letzten Schlusskurs aus der Zeitreihe.
    const w5000HistRes = await fetchYahooChart("%5EW5000", "1y", "1d");
    const hist = w5000HistRes?.chart?.result?.[0];
    const timestamps = hist?.timestamp ?? [];
    const closes = hist?.indicators?.quote?.[0]?.close ?? [];
    if (!timestamps.length) throw new Error("Keine W5000-Historie verfügbar");

    let lastIdx = -1;
    for (let i = timestamps.length - 1; i >= 0; i--) {
      if (closes[i] != null) { lastIdx = i; break; }
    }
    if (lastIdx === -1) throw new Error("Kein gültiger W5000-Preis in der Historie");
    const w5000Now = closes[lastIdx];
    const today = new Date().toISOString().split("T")[0];

    const fedDateMs = new Date(fedMcap.date).getTime();
    let w5000AtFedDate = null, bestDiff = Infinity;
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] == null) continue;
      const diff = Math.abs(timestamps[i] * 1000 - fedDateMs);
      if (diff < bestDiff) { bestDiff = diff; w5000AtFedDate = closes[i]; }
    }
    // Nur akzeptieren, wenn der gefundene Handelstag höchstens 10 Tage vom Fed-Stichtag abweicht
    if (w5000AtFedDate == null || bestDiff > 10 * 86400000) {
      throw new Error("Kein W5000-Kurs am Fed-Stichtag gefunden — Kalibrierung nicht möglich");
    }

    const factor = fedMcapBn / w5000AtFedDate;
    const mcapBn = w5000Now * factor;
    return { date: today, value: mcapBn, source: `W5000 × ${factor.toFixed(3)} (Fed Z.1 ${fedMcap.date})` };
  };

  try {
    const [mcap, gdp, gdpNow] = await Promise.all([
      fetchMcapCalibrated(),
      fredCsv("GDP"),
      fredCsv("GDPNOW").catch(() => null),
    ]);

    if (!mcap || !gdp) throw new Error("Keine gültigen Werte");

    let gdpEstimate = gdp.value;
    let gdpDate = gdp.date;
    if (gdpNow?.value != null) {
      const quartersSinceGdp = Math.max(0, Math.round((Date.now() - new Date(gdp.date).getTime()) / (90 * 86400000)));
      if (quartersSinceGdp > 0) {
        gdpEstimate = gdp.value * (1 + (gdpNow.value / 100) / 4 * quartersSinceGdp);
        gdpDate = `${gdp.date} + GDPNow ${gdpNow.value.toFixed(1)}%`;
      }
    }

    const ratio = (mcap.value / gdpEstimate) * 100;

    // Dynamische Trendlinie: exponentielle Regression auf historische MCap/GDP-Ratios
    // SD auf absoluten Residuen (Prozentpunkte), konsistent mit currentmarketvaluation.com
    let trend = null, sdAbs = null, sdFromTrend = null;
    try {
      const [mcapHist, gdpHist] = await Promise.all([
        fredFetch("NCBEILQ027S"),
        fredFetch("GDP"),
      ]);
      const gdpByDate = new Map(gdpHist.map(e => [e.date, e.value]));
      const T0 = new Date("1950-01-01").getTime();
      const MS_PER_YEAR = 365.25 * 86400000;
      const histRatios = [];
      for (const e of mcapHist) {
        const g = gdpByDate.get(e.date);
        if (!g) continue;
        const r = (e.value / 1000) / g * 100;
        histRatios.push({ t: (new Date(e.date).getTime() - T0) / MS_PER_YEAR, ratio: r, lnR: Math.log(r) });
      }
      if (histRatios.length > 20) {
        const n = histRatios.length;
        const sumT = histRatios.reduce((s, r) => s + r.t, 0);
        const sumLn = histRatios.reduce((s, r) => s + r.lnR, 0);
        const sumTLn = histRatios.reduce((s, r) => s + r.t * r.lnR, 0);
        const sumT2 = histRatios.reduce((s, r) => s + r.t * r.t, 0);
        const b = (n * sumTLn - sumT * sumLn) / (n * sumT2 - sumT * sumT);
        const a = (sumLn - b * sumT) / n;
        const tNow = (Date.now() - T0) / MS_PER_YEAR;
        trend = Math.exp(a + b * tNow);
        const absResiduals = histRatios.map(r => r.ratio - Math.exp(a + b * r.t));
        sdAbs = Math.sqrt(absResiduals.reduce((s, v) => s + v * v, 0) / (n - 2));
        sdFromTrend = (ratio - trend) / sdAbs;
      }
    } catch {}

    return {
      ratio,
      mcap_bn:   mcap.value,
      gdp_bn:    gdpEstimate,
      mcap_date: mcap.date,
      mcap_source: mcap.source,
      gdp_date:  gdpDate,
      trend:     trend ? +trend.toFixed(1) : null,
      sd_abs:    sdAbs ? +sdAbs.toFixed(1) : null,
      sd_from_trend: sdFromTrend ? +sdFromTrend.toFixed(2) : null,
    };
  } catch (err) {
    console.warn("⚠️  Buffett-Indikator fehlgeschlagen:", err.message);
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function runMarketCheck() {
  try {
    const [allData, vixTs, fearGreed, premarket, sectors, buffett] = await Promise.all([
      fetchIndexData(),
      fetchVixTermStructure(),
      fetchFearGreed(),
      fetchPreMarketData(),
      fetchSectorPerformance(),
      fetchBuffettIndicator(),
    ]);

    const indices = allData.filter((d) => d.type === "index");
    const vix     = allData.find((d)  => d.type === "vix");
    const regime  = calcRegime(allData);

    return {
      success:    true,
      checked_at: new Date().toISOString(),
      indices,
      vix,
      regime,
      vix_term_structure: vixTs,
      fear_greed:         fearGreed,
      premarket,
      sectors:            { items: sectors, fetched_at: new Date().toISOString() },
      buffett,
    };
  } catch (err) {
    return {
      success: false,
      error:   err.message,
      regime: {
        signal:      "UNKNOWN",
        color:       "⚪",
        label:       "DATEN NICHT VERFÜGBAR",
        description: `Marktdaten konnten nicht abgerufen werden: ${err.message}`,
        action:      "Manuelle Marktprüfung erforderlich",
        vixLevel:    null,
        index_status: { spx: "?", ndx: "?", rut: "?", dax: "?", sx5e: "?", ni225: "?", hsi: "?" },
      },
    };
  }
}
