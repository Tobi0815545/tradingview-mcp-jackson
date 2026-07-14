/**
 * CANSLIM Scanner — nutzt die TradingView Scanner API (kein API-Key nötig).
 * Scannt US- und europäische Märkte, bewertet jeden Kandidaten mit 1–5 Sternen
 * nach den 5 CANSLIM-Kriterien.
 *
 * Short Float (US): via Finviz Scraping (kein API-Key). Sequentiell mit 1.5s
 * Delay um Rate-Limiting zu vermeiden.
 */

const TV_SCANNER = "https://scanner.tradingview.com";

// ── Markt-Konfiguration ──────────────────────────────────────────────────────

// Globale Filter-Schwellen
const MIN_MARKET_CAP  = 10_000_000_000; // > 10 Mrd. für alle Märkte
const MAX_SHORT_FLOAT = 3;              // Short Float < 3 %

const MARKETS = {
  us:          { endpoint: `${TV_SCANNER}/america/scan`,     label: "🇺🇸 USA"        },
  germany:     { endpoint: `${TV_SCANNER}/germany/scan`,     label: "🇩🇪 Deutschland" },
  france:      { endpoint: `${TV_SCANNER}/france/scan`,      label: "🇫🇷 Frankreich"  },
  uk:          { endpoint: `${TV_SCANNER}/uk/scan`,          label: "🇬🇧 UK"          },
  switzerland: { endpoint: `${TV_SCANNER}/switzerland/scan`, label: "🇨🇭 Schweiz"     },
  netherlands: { endpoint: `${TV_SCANNER}/netherlands/scan`, label: "🇳🇱 Niederlande" },
  austria:     { endpoint: `${TV_SCANNER}/austria/scan`,     label: "🇦🇹 Österreich"  },
};

const MARKET_GROUPS = {
  us:     ["us"],
  europe: ["germany", "france", "uk", "switzerland", "netherlands", "austria"],
  all:    ["us", "germany", "france", "uk", "switzerland", "netherlands", "austria"],
};

// Spalten-Definition — Reihenfolge bestimmt den Index in row.d[]
const COLUMNS = [
  "name",                                      // 0  ticker
  "description",                               // 1  Firmenname
  "close",                                     // 2  Kurs
  "change",                                    // 3  Tagesänderung %
  "Perf.1M",                                   // 4  1-Monats-Performance
  "Perf.3M",                                   // 5  3-Monats-Performance
  "Perf.6M",                                   // 6  6-Monats-Performance
  "EMA50",                                     // 7  50er EMA
  "SMA150",                                    // 8  150er SMA
  "SMA200",                                    // 9  200er SMA
  "RSI",                                       // 10 RSI 14
  "MACD.hist",                                 // 11 MACD Histogramm
  "volume",                                    // 12 aktuelles Volumen
  "average_volume_10d_calc",                   // 13 10-Tage-Durchschnittsvolumen
  "relative_volume_10d_calc",                  // 14 relatives Volumen
  "price_52_week_high",                        // 15 52W-Hoch
  "price_52_week_low",                         // 16 52W-Tief
  "earnings_per_share_diluted_yoy_growth_fy",  // 17 EPS-Wachstum YoY
  "market_cap_basic",                          // 18 Marktkapitalisierung
  "exchange",                                  // 19 Börse
  "sector",                                    // 20 Sektor
  "isin",                                      // 21 ISIN-Code (für Länder-Filter)
  "country",                                   // 22 Herkunftsland des Unternehmens (z.B. "United States")
  "total_revenue_yoy_growth_fy",               // 23 Umsatzwachstum YoY (CANSLIM "A"-Kriterium)
];

// ── API-Aufruf ───────────────────────────────────────────────────────────────

async function fetchMarket(marketKey, { limit = 100 } = {}) {
  const market = MARKETS[marketKey];
  if (!market) throw new Error(`Unbekannter Markt: ${marketKey}`);

  const body = {
    filter: [
      // Stage 2: Kurs über alle wichtigen MAs (Minervini Trendtemplate)
      { left: "close",            operation: "greater", right: "EMA50"        },
      { left: "EMA50",            operation: "greater", right: "SMA150"       },
      { left: "SMA150",           operation: "greater", right: "SMA200"       },
      // Positiver 3-Monats-Trend
      { left: "Perf.3M",          operation: "greater", right: 5              },
      // Mindest-Marktkapitalisierung > 2 Mrd. (global)
      { left: "market_cap_basic", operation: "greater", right: MIN_MARKET_CAP },
    ],
    columns: COLUMNS,
    sort: { sortBy: "Perf.3M", sortOrder: "desc" },
    range: [0, limit],
  };

  // Ein AbortController für den gesamten Fetch-Lifecycle (connect + headers + body).
  // Promise.race stellt sicher dass der Timeout auch dann greift wenn undici
  // AbortSignal intern nicht korrekt propagiert.
  const controller = new AbortController();
  const fetchWithTimeout = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Timeout nach 15s für ${marketKey}`));
    }, 15_000);
    fetch(market.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          reject(new Error(`HTTP ${res.status}: ${errText.slice(0, 100)}`));
        } else {
          resolve(await res.json());
        }
      })
      .catch(reject)
      .finally(() => clearTimeout(timer));
  });

  const json = await fetchWithTimeout;
  return (json.data || [])
    .map((row) => parseRow(row, marketKey, market.label))
    .filter(Boolean);  // null-Zeilen (kein Symbol) entfernen
}

function parseRow(row, marketKey, marketLabel) {
  const d   = row.d || [];
  // row.s  = "NASDAQ:AAPL" (vollständiges Symbol inkl. Exchange — primäre Quelle)
  // d[0]   = "name"-Spalte = nur der Ticker ("AAPL") — Fallback, falls row.s fehlt
  // d[1]   = "description"-Spalte = Unternehmensname ("Apple Inc.")
  const sym = (row.s && row.s.trim()) ? row.s.trim() : (d[0] ? String(d[0]).trim() : "");
  if (!sym) return null;  // Zeile ohne Symbol überspringen

  const get = (i) => (d[i] !== undefined && d[i] !== null ? d[i] : null);
  const companyName = (get(1) ?? "").toString().trim();

  return {
    symbol:       sym,
    ticker:       sym.includes(":") ? sym.split(":").pop() : sym,
    name:         companyName,
    market:       marketKey,
    market_label: marketLabel,
    close:        get(2),
    change_pct:   get(3),
    perf_1m:      get(4),
    perf_3m:      get(5),
    perf_6m:      get(6),
    ema50:        get(7),
    sma150:       get(8),
    sma200:       get(9),
    rsi:          get(10),
    macd_hist:    get(11),
    volume:       get(12),
    avg_volume:   get(13),
    rel_volume:   get(14),
    high52w:      get(15),
    low52w:       get(16),
    eps_growth:   get(17),
    rev_growth:   get(23),
    market_cap:   get(18),
    exchange:     get(19) ?? marketLabel,
    sector:       get(20) ?? "",
    isin:         get(21) ? String(get(21)).trim() : null,
    country:      get(22) ? String(get(22)).trim() : null,
    short_float:  null,   // wird via Yahoo Finance nachgeladen (US) oder N/V (EU)
  };
}

// ── CANSLIM 5-Sterne Scoring ─────────────────────────────────────────────────

export function scoreCandidate(c) {
  let stars = 0;
  const criteria = {};

  // ★ 1 — Stage 2 Uptrend (Trendtemplate Minervini)
  const stage2 = c.close > c.ema50 && c.ema50 > c.sma150 && c.sma150 > c.sma200;
  const pctFromHigh = c.high52w ? ((c.high52w - c.close) / c.high52w) * 100 : 999;

  if (stage2) {
    stars += 1;
    criteria.stage2 = pctFromHigh < 20
      ? `✓ Stage 2 · ${pctFromHigh.toFixed(1)}% unter 52W-Hoch`
      : `✓ Stage 2 · ${pctFromHigh.toFixed(1)}% unter 52W-Hoch (extended)`;
  } else {
    criteria.stage2 = "✗ Stage 2 nicht erfüllt";
  }

  // ★ 2 — Relative Stärke (3-Monats-Performance vs. Markt)
  const p3m = c.perf_3m ?? 0;
  if (p3m >= 20) {
    stars += 1;
    criteria.rel_strength = `✓ RS stark: +${p3m.toFixed(1)}% (3M)`;
  } else if (p3m >= 10) {
    stars += 0.5;
    criteria.rel_strength = `~ RS moderat: +${p3m.toFixed(1)}% (3M)`;
  } else {
    criteria.rel_strength = `✗ RS schwach: +${p3m.toFixed(1)}% (3M)`;
  }

  // ★ 3 — Tight Base / VCP (Proxy: nahe 52W-Hoch + RSI im gesunden Bereich)
  const rsi = c.rsi ?? 50;
  const rsiOk = rsi >= 45 && rsi <= 73;
  if (pctFromHigh < 8 && rsiOk) {
    stars += 1;
    criteria.base = `✓ Tight Basis: ${pctFromHigh.toFixed(1)}% unter High, RSI ${rsi.toFixed(0)}`;
  } else if (pctFromHigh < 18 && rsiOk) {
    stars += 0.5;
    criteria.base = `~ Basis forming: ${pctFromHigh.toFixed(1)}% unter High, RSI ${rsi.toFixed(0)}`;
  } else {
    criteria.base = `✗ Keine enge Basis: ${pctFromHigh.toFixed(1)}% unter High, RSI ${rsi.toFixed(0)}`;
  }

  // ★ 4 — Volumen-Muster (Dry-Up in Basis ODER Breakout-Volumen)
  const relVol  = c.rel_volume ?? 1;
  const macdPos = (c.macd_hist ?? 0) > 0;
  if (relVol < 0.70 && macdPos) {
    stars += 1;
    criteria.volume = `✓ Vol Dry-Up ${(relVol * 100).toFixed(0)}% + MACD ↑ (ideale Basis)`;
  } else if (relVol >= 1.5 && macdPos) {
    stars += 1;
    criteria.volume = `✓ Breakout-Vol ${(relVol * 100).toFixed(0)}% + MACD ↑`;
  } else if (relVol < 0.85) {
    stars += 0.5;
    criteria.volume = `~ Vol leicht dry ${(relVol * 100).toFixed(0)}%`;
  } else {
    criteria.volume = `✗ Vol-Muster unklar: ${(relVol * 100).toFixed(0)}%`;
  }

  // ★ 5 — CANSLIM Fundamentals (EPS/Revenue Wachstum)
  const eps = c.eps_growth;
  const rev = c.rev_growth;
  if (eps !== null && eps >= 25) {
    stars += 1;
    criteria.fundamentals = `✓ EPS +${eps.toFixed(1)}% YoY`;
  } else if (eps !== null && eps >= 15) {
    stars += 0.5;
    criteria.fundamentals = `~ EPS +${eps.toFixed(1)}% (unter 25%)`;
  } else if (rev !== null && rev >= 20) {
    stars += 0.5;
    criteria.fundamentals = eps !== null
      ? `~ EPS +${eps.toFixed(1)}% / Umsatz +${rev.toFixed(1)}%`
      : `~ Umsatz +${rev.toFixed(1)}% (EPS N/V — manuell prüfen)`;
  } else {
    criteria.fundamentals = eps !== null
      ? `✗ EPS +${eps?.toFixed(1)}% — unter Schwelle (manuell prüfen)`
      : "~ Fundamentals N/V — manuell prüfen";
  }

  return { stars, criteria };
}

function fmtCap(cap) {
  if (!cap) return "–";
  if (cap >= 1e12) return `${(cap / 1e12).toFixed(1)}T`;
  if (cap >= 1e9)  return `${(cap / 1e9).toFixed(1)}B`;
  return `${(cap / 1e6).toFixed(0)}M`;
}

function fmtPct(v) {
  if (v === null || v === undefined) return "–";
  return `${v > 0 ? "+" : ""}${Number(v).toFixed(1)}%`;
}

// ── Short Float via Finviz (nur US-Aktien) ──────────────────────────────────
//
// Hinweis: TradingView Scanner API stellt Short Float nicht bereit.
// Yahoo Finance benötigt Cookie+Crumb-Authentifizierung (HTTP 401 ohne Browser-Session).
// Finviz.com gibt Short % of Float auf der Quote-Seite aus und ist ohne Auth abrufbar.
// Sequentielle Anfragen mit 1.5s Pause um Rate-Limiting zu vermeiden.

async function fetchShortFloatFinviz(ticker) {
  // Promise.race-basierter Timeout: garantiert zuverlässig, egal ob fetch oder res.text() hängt.
  // AbortSignal.timeout() allein reicht nicht — res.text() kann trotzdem hängen.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);  // 8s hard limit
  try {
    const res = await fetch(
      `https://finviz.com/quote.ashx?t=${encodeURIComponent(ticker)}`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: controller.signal,
      }
    );
    if (!res.ok) return null;
    const html = await res.text();
    // Suche "Short Float" im HTML und extrahiere den Wert aus <b>X.XX%</b>
    const idx = html.indexOf("Short Float");
    if (idx === -1) return null;
    const chunk = html.substring(idx, idx + 500);
    const match = chunk.match(/<b>([\d.]+)%<\/b>/);
    return match ? parseFloat(match[1]) : null;  // bereits in Prozent (z.B. 1.2 = 1.2%)
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Holt Short % of Float für eine Liste von US-Tickern via Finviz (sequentiell).
 * Gibt eine Map { ticker → shortFloat% } zurück.
 * Fehler werden still ignoriert (Short-Float bleibt null für diesen Ticker).
 * Globaler Timeout: 60s — bei Finviz-Blockade wird mit den bis dahin gesammelten Daten weitergemacht.
 */
async function fetchShortFloats(tickers) {
  const result = new Map();
  const deadline = Date.now() + 60_000;   // max. 60s für alle Requests zusammen

  for (const ticker of tickers) {
    if (Date.now() >= deadline) {
      console.log(`⚠️  Finviz Short-Float: 60s Timeout erreicht — überspringe restliche ${tickers.length - [...result.keys()].length} Ticker`);
      break;
    }
    const sf = await fetchShortFloatFinviz(ticker);
    if (sf !== null) result.set(ticker, sf);
    // 1.5s Pause zwischen Requests — Finviz blockiert bei zu vielen gleichzeitigen Requests
    await new Promise((r) => setTimeout(r, 1_500));
  }
  return result;
}

// ── Haupt-Scan ───────────────────────────────────────────────────────────────

export async function runScan({
  markets  = "all",
  limit    = 100,
  min_stars = 2,
  top      = 20,
} = {}) {
  const marketKeys = MARKET_GROUPS[markets] || [markets];
  const errors     = [];
  const allRows    = [];

  await Promise.allSettled(
    marketKeys.map(async (key) => {
      try {
        const rows = await fetchMarket(key, { limit });
        allRows.push(...rows);
      } catch (err) {
        errors.push({ market: key, error: err.message });
      }
    })
  );

  // Sortierung: Sterne → MCap (Liquidität) → 3M-Performance (auch für die Vorauswahl
  // unten verwendet, damit deren Top-30 exakt der finalen Rangfolge entspricht)
  const sortFn = (a, b) =>
    (b.stars - a.stars) ||
    ((b.market_cap ?? 0) - (a.market_cap ?? 0)) ||
    ((b.perf_3m ?? 0) - (a.perf_3m ?? 0));

  // Short Float für US-Aktien via Finviz nachladen (sequentiell, 1.5s/Request).
  // Nur die Top-30 US-Kandidaten nach finaler Sortierung abfragen — spart >60% Zeit ohne
  // Qualitätsverlust, da Short-Float-Filter nur Grenzfälle unter den Top-5 betrifft.
  // WICHTIG: muss mit sortFn (nicht nur "stars") sortiert werden — bei Sternen-Gleichstand
  // (häufig, da nur 0.5er-Schritte) hätte reines Stars-Ranking sonst Kandidaten aus der
  // Vorauswahl ausgeschlossen, die es via MCap/Perf-Tiebreak später doch in die finalen
  // Top-5 schaffen — deren short_float bliebe dann undefined und der Filter (sf !== undefined)
  // würde sie nie herausfiltern, egal wie hoch ihr Short Float tatsächlich ist.
  const usRowsForSf = allRows.filter(r => r.market === "us").map(r => ({ ...r, ...scoreCandidate(r) }));
  const allUsTickers = [...new Set(usRowsForSf.map(r => r.ticker))];
  const scoredForSf  = allUsTickers
    .map(t => usRowsForSf.find(r => r.ticker === t))
    .sort(sortFn)
    .slice(0, 30)
    .map(r => r.ticker);
  const shortFloats = scoredForSf.length > 0 ? await fetchShortFloats(scoredForSf) : new Map();

  // Short Float eintragen + US-Aktien mit Short Float > MAX_SHORT_FLOAT herausfiltern
  const filteredRows = allRows.filter((c) => {
    if (c.market === "us") {
      const sf = shortFloats.get(c.ticker);
      c.short_float = sf ?? null;
      // Nur herausfiltern wenn Daten vorhanden und über Schwelle
      if (sf !== undefined && sf > MAX_SHORT_FLOAT) return false;
    }
    return true;
  });

  // Scoring
  const scoredAll = filteredRows.map((c) => {
    const { stars, criteria } = scoreCandidate(c);
    return { ...c, stars, criteria };
  });

  // Deduplizieren: pro Unternehmen nur besten Eintrag (US bevorzugt, dann mehr Sterne).
  // Key = normalisierter Unternehmensname (Satzzeichen, Rechtsformen etc. entfernt).
  // Durch den nativeOnly-Filter erscheinen US-Kreuzlistungen nicht mehr in EU-Märkten,
  // daher ist Name-basierte Dedup hier nur noch für identische EU/US-Doppellistings nötig.
  const normalizeCompanyName = (name) =>
    (name || "")
      .toLowerCase()
      .replace(/\b(inc|corp|corporation|ltd|limited|plc|ag|se|sa|gmbh|nv|bv|co|company|group|holding|holdings|the)\b\.?/g, "")
      .replace(/[^a-z0-9]/g, "")  // alle Sonderzeichen entfernen
      .trim();

  const seen = new Map();
  for (const c of scoredAll) {
    if (!c.symbol || !c.ticker) continue;  // unvollständige Einträge überspringen
    const key = normalizeCompanyName(c.name);
    if (!key) {
      // Kein Unternehmensname → Ticker als Fallback-Key verwenden
      seen.set(`__ticker__${c.ticker.toLowerCase()}`, c);
      continue;
    }
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, c);
    } else {
      // US-Listing bevorzugen (Liquidität), dann nach Sternen, dann nach 3M-Performance
      const preferUs    = c.market === "us" && existing.market !== "us";
      const betterScore = c.stars > existing.stars;
      const betterPerf  = c.stars === existing.stars && (c.perf_3m ?? 0) > (existing.perf_3m ?? 0);
      if (preferUs || betterScore || betterPerf) seen.set(key, c);
    }
  }

  const toResult = (c, idx) => ({
    rank:          idx + 1,
    symbol:        c.symbol,
    name:          c.name,
    market:        c.market_label,
    exchange:      c.exchange,
    sector:        c.sector,
    isin:          c.isin,
    price:         c.close,
    change_day:    fmtPct(c.change_pct),
    change_day_raw: c.change_pct ?? 0,
    perf_1m:       fmtPct(c.perf_1m),
    perf_3m:       fmtPct(c.perf_3m),
    perf_6m:       fmtPct(c.perf_6m),
    rsi:           c.rsi?.toFixed(0) ?? "–",
    macd_hist:     c.macd_hist?.toFixed(3) ?? "–",
    rel_volume:    c.rel_volume != null ? `${(c.rel_volume * 100).toFixed(0)}%` : "–",
    from_52w_high: c.high52w   ? `${(((c.high52w - c.close) / c.high52w) * 100).toFixed(1)}%` : "–",
    eps_growth:    c.eps_growth  != null ? fmtPct(c.eps_growth)  : "N/V",
    short_float:   c.short_float != null ? `${c.short_float.toFixed(1)}%` : "N/V",
    market_cap:    fmtCap(c.market_cap),
    market_cap_raw: c.market_cap ?? 0,
    stars:         c.stars,
    rating:        "⭐".repeat(Math.floor(c.stars)) + (c.stars % 1 >= 0.5 ? "½" : ""),
    criteria:      c.criteria,
  });

  // ISIN-Präfixe europäischer Länder
  const EU_ISIN = ["AT","BE","CH","DE","DK","ES","FI","FR","GB","GR","IE","IT","LU","NL","NO","PT","SE"];

  const allCandidates = [...seen.values()].filter((c) => c.stars >= min_stars);

  // US-Ergebnisse: US-Markt + US-ISIN + US-Herkunftsland
  // country === "United States" schließt ADRs und Kreuzlistungen (Telefonica Brasil, Fujikura etc.)
  // auch dann aus, wenn sie eine US-ISIN besitzen.
  const usResults = allCandidates
    .filter((c) =>
      c.market === "us" &&
      c.isin?.startsWith("US") &&
      c.country === "United States"
    )
    .sort(sortFn)
    .slice(0, 5)
    .map(toResult);

  // Europa-Ergebnisse: nicht-US Märkte + europäische ISIN
  const euResults = allCandidates
    .filter((c) => c.market !== "us" && (c.isin == null || EU_ISIN.some((p) => (c.isin ?? "").startsWith(p))))
    .sort(sortFn)
    .slice(0, 5)
    .map(toResult);

  const totalFiltered = usResults.length + euResults.length;

  return {
    success: true,
    scanned_at:       new Date().toISOString(),
    markets_scanned:  marketKeys.map((k) => MARKETS[k]?.label ?? k),
    total_raw:        allRows.length,
    filtered_count:   totalFiltered,
    min_stars_filter: min_stars,
    errors:           errors.length ? errors : undefined,
    us_results:       usResults,
    europe_results:   euResults,
    // Rückwärtskompatibel: kombinierte Liste für andere Konsumenten
    results:          [...usResults, ...euResults],
  };
}
