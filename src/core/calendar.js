/**
 * calendar.js — Wirtschaftskalender & Earnings für die gesamte aktuelle Woche
 *
 * Quellen:
 *   - Finviz Economic Calendar (Primary, Impact 3 / High only)
 *   - TradingView Economic Calendar API (Fallback, kein API-Key)
 *   - Yahoo Finance calendarEvents (Earnings für Watchlist)
 */

const TV_CALENDAR        = "https://economic-calendar.tradingview.com/events";
const CALENDAR_COUNTRIES = ["US", "EU", "DE", "FR", "GB", "JP", "CN", "CA", "CH"];
// TradingView nutzt Skala -1 (niedrig) / 0 (mittel) / 1 (hoch) — NICHT 1-3!
const MIN_IMPORTANCE_TV  = 1;   // HIGH-Impact (TV-Skala: 1 = hoch)

// MED-Events (imp=0) die trotzdem relevant sind — via Keyword-Whitelist
const MED_WHITELIST = /PMI|Purchasing Manager|Jobless Claims|Unemployment Claims|Consumer Sentiment|Consumer Confidence|Michigan|Lagarde|Powell|Waller|Fed Chair|ECB President|Inflation|CPI|PCE|GDP|Retail Sales|Nonfarm|NFP|Payroll|ISM|Trade Balance|Current Account|Housing Starts|Building Permits|Factory Orders|Industrial Production/i;

// MED-Events die rausgefilter werden sollen (Rauschen)
const MED_NOISE = /auction|EIA Crude|EIA Natural|MBA Mortgage|Redbook|Baker Hughes|Rig Count|Bill |TIPS |Bund |Schatz |OAT |Gilt |BTP |Bonos|Fed Balance Sheet|Money Supply|M2 |M3 |Foreign Exchange Reserve|Reserve Assets/i;

const COUNTRY_FLAGS = {
  US: "🇺🇸", DE: "🇩🇪", FR: "🇫🇷", GB: "🇬🇧", JP: "🇯🇵",
  CN: "🇨🇳", CA: "🇨🇦", CH: "🇨🇭", EU: "🇪🇺", IT: "🇮🇹",
  ES: "🇪🇸", NL: "🇳🇱", AT: "🇦🇹", SE: "🇸🇪", DK: "🇩🇰",
  AU: "🇦🇺", NZ: "🇳🇿", KR: "🇰🇷", IN: "🇮🇳", BR: "🇧🇷",
};

// Country name → ISO code mapping for Finviz flag images
const COUNTRY_NAME_MAP = {
  "united states": "US", "euro zone": "EU", "european union": "EU",
  "germany": "DE", "france": "FR", "united kingdom": "GB",
  "japan": "JP", "china": "CN", "canada": "CA", "switzerland": "CH",
  "italy": "IT", "spain": "ES", "netherlands": "NL", "austria": "AT",
  "sweden": "SE", "denmark": "DK", "australia": "AU", "new zealand": "NZ",
  "south korea": "KR", "india": "IN", "brazil": "BR",
};

const HEADERS_FV = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer":         "https://finviz.com/",
};

// ── Wochendaten berechnen ────────────────────────────────────────────────────

function getWeekRange(today = new Date()) {
  const dow = today.getDay(); // 0=So, 1=Mo...6=Sa
  // Wochenende → nächste Woche, sonst aktuelle Woche
  const toMonday = dow === 0 ? 1 : dow === 6 ? 2 : 1 - dow;
  const monday   = new Date(today);
  monday.setDate(today.getDate() + toMonday);
  monday.setHours(0, 0, 0, 0);
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  friday.setHours(23, 59, 59, 999);
  return { monday, friday };
}

// Lokale Kalendertag-Extraktion (Europe/Berlin, der Prozess-Timezone). toISOString()
// (UTC) würde bei positivem UTC-Offset einen Tag zurückverschieben (Mo 00:00 CEST =
// So 22:00 UTC) — sowohl bei den Wochengrenzen als auch bei früh-morgendlichen Events.
function isoDateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtTime(iso) {
  if (!iso) return "–";
  try {
    return new Date(iso).toLocaleTimeString("de-DE", {
      hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin",
    });
  } catch { return "–"; }
}

function fmtWeekday(date) {
  try {
    return date.toLocaleDateString("de-DE", {
      weekday: "short", day: "2-digit", month: "2-digit", timeZone: "Europe/Berlin",
    });
  } catch { return ""; }
}


// ── Finviz Wirtschaftskalender (Primary) ─────────────────────────────────────
// Finviz liefert Kalenderdaten als JSON im <script id="route-init-data"> Tag.
// Format: { data: { initialDateFrom, entries: [ { date, event, importance, actual, forecast, previous, ticker } ] } }
// importance: 1=niedrig, 2=mittel, 3=hoch

function tickerToCountry(ticker = "") {
  const t = ticker.toUpperCase();
  if (t.startsWith("UNITEDSTA") || t.startsWith("US"))     return "US";
  if (t.startsWith("EURO") || t.startsWith("EU"))          return "EU";
  if (t.startsWith("GER") || t.startsWith("DEU"))          return "DE";
  if (t.startsWith("FRA") || t.startsWith("FRAN"))         return "FR";
  if (t.startsWith("UK") || t.startsWith("GBR") || t.startsWith("BRIT")) return "GB";
  if (t.startsWith("JAP") || t.startsWith("JPN"))          return "JP";
  if (t.startsWith("CHI") || t.startsWith("CHN"))          return "CN";
  if (t.startsWith("CAN"))                                 return "CA";
  if (t.startsWith("SWI") || t.startsWith("CHE"))          return "CH";
  if (t.startsWith("AUS"))                                 return "AU";
  return "US"; // Finviz is US-focused by default
}

async function fetchFinvizCalendarEvents() {
  const { monday, friday } = getWeekRange();
  const monStr = isoDateLocal(monday);
  const friStr = isoDateLocal(friday);

  const res = await fetch("https://finviz.com/calendar.ashx", {
    headers: HEADERS_FV,
    signal:  AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  // Extract embedded JSON from <script id="route-init-data">
  const scriptMatch = /<script[^>]+id="route-init-data"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!scriptMatch) throw new Error("route-init-data Script nicht gefunden");

  const json = JSON.parse(scriptMatch[1]);
  const entries = json?.data?.entries ?? [];
  if (!entries.length) throw new Error("Keine Kalender-Einträge im JSON");

  const events = entries
    .filter((e) => {
      if ((e.importance ?? 0) < 3) return false;
      const dateStr = isoDateLocal(new Date(e.date));
      return dateStr >= monStr && dateStr <= friStr;
    })
    .map((e) => {
      const dateObj = new Date(e.date);
      const countryCode = tickerToCountry(e.ticker ?? "");
      return {
        time_iso:   dateObj.toISOString(),
        date_str:   isoDateLocal(dateObj),
        time:       fmtTime(dateObj.toISOString()),
        weekday:    fmtWeekday(dateObj),
        country:    countryCode,
        flag:       COUNTRY_FLAGS[countryCode] ?? "🌍",
        event:      e.event ?? e.category ?? "–",
        importance: 3,
        actual:     e.actual   || null,
        forecast:   e.forecast || null,
        previous:   e.previous || null,
        unit:       "",
      };
    })
    .sort((a, b) => a.time_iso.localeCompare(b.time_iso));

  console.log(`[Calendar] Finviz: ${events.length} High-Impact Events (KW ${monStr} – ${friStr}).`);
  return events;
}

// ── TradingView Wirtschaftskalender (Fallback) ────────────────────────────────

async function fetchTVEconomicEvents() {
  try {
    const { monday, friday } = getWeekRange();
    const url = new URL(TV_CALENDAR);
    url.searchParams.set("from",      monday.toISOString());
    url.searchParams.set("to",        friday.toISOString());
    url.searchParams.set("countries", CALENDAR_COUNTRIES.join(","));

    const res = await fetch(url.toString(), {
      headers: {
        "Accept":   "application/json",
        "User-Agent": "Mozilla/5.0",
        "Origin":   "https://www.tradingview.com",
        "Referer":  "https://www.tradingview.com/economic-calendar/",
      },
      signal: AbortSignal.timeout(12_000),
    });

    if (!res.ok) {
      console.warn(`[Calendar] TV API HTTP ${res.status}`);
      return [];
    }

    const data = await res.json();
    return (data.result ?? [])
      .filter((e) => {
        const imp   = e.importance ?? -1;
        const title = e.title ?? "";
        if (imp >= MIN_IMPORTANCE_TV) return true;         // HIGH immer rein
        if (imp === 0) {
          // MED: rein wenn Whitelist-Keyword und kein Noise-Pattern
          return MED_WHITELIST.test(title) && !MED_NOISE.test(title);
        }
        return false;                                       // LOW (imp=-1) raus
      })
      .map((e) => ({
        time_iso:   e.date ?? "",
        date_str:   e.date ? isoDateLocal(new Date(e.date)) : "",
        time:       fmtTime(e.date),
        weekday:    e.date ? fmtWeekday(new Date(e.date)) : "",
        country:    e.country ?? "–",
        flag:       COUNTRY_FLAGS[e.country] ?? "🌍",
        event:      e.title ?? e.indicator ?? "–",
        importance: e.importance ?? 0,
        actual:     e.actual   != null ? String(e.actual)   : null,
        forecast:   e.forecast != null ? String(e.forecast) : null,
        previous:   e.previous != null ? String(e.previous) : null,
        unit:       e.unit ?? "",
      }))
      .sort((a, b) => a.time_iso.localeCompare(b.time_iso));

  } catch (err) {
    console.warn("[Calendar] TV Economic Events Fehler:", err.message);
    return [];
  }
}

// ── Wirtschaftskalender — Finviz Primary, TV Fallback ────────────────────────

export async function fetchEconomicEvents() {
  try {
    const events = await fetchFinvizCalendarEvents();
    if (events.length > 0) return events;
    throw new Error("Keine Events geparst");
  } catch (err) {
    console.warn("[Calendar] Finviz Kalender:", err.message, "→ TradingView Fallback");
    return fetchTVEconomicEvents();
  }
}

// ── Earnings für die gesamte Woche ───────────────────────────────────────────
// Uses TradingView Scanner API (no API key, no rate limiting, single batch).
// earnings_release_next_date gives the expected earnings date.

export async function fetchEarningsForWeek(symbols = []) {
  if (!symbols.length) return [];
  const { monday, friday } = getWeekRange();
  const monStr = isoDateLocal(monday);
  const friStr = isoDateLocal(friday);

  // Only equity symbols (must have exchange prefix EXCH:SYMBOL). Crypto/FX/futures excluded.
  const tickers = symbols
    .slice(0, 60)
    .filter((s) => s.includes(":"))
    .filter((s) => !/^(BINANCE|COINBASE|BITSTAMP|BITFINEX|CRYPTOCAP|FX|FOREXCOM|OANDA|FX_IDC|CBOT|CME|NYMEX|COMEX|ICEUS|TVC)/.test(s));

  if (!tickers.length) return [];

  try {
    const res = await fetch("https://scanner.tradingview.com/global/scan", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent":   "Mozilla/5.0",
      },
      body: JSON.stringify({
        symbols: { tickers },
        columns: [
          "name",
          "earnings_release_next_date",
          "earnings_publication_type_next_fq",
          "earnings_per_share_forecast_next_fq",
          "earnings_release_date",
          "earnings_per_share_fq",
          "earnings_per_share_forecast_fq",
        ],
      }),
      signal: AbortSignal.timeout(12_000),
    });

    if (!res.ok) {
      console.warn(`[Earnings] TV Scanner HTTP ${res.status}`);
      return [];
    }

    const json = await res.json();
    const rows = json?.data ?? [];

    const results = [];
    for (const row of rows) {
      const [name, tsNext, pubType, epsEstNext, tsPast, epsActual, epsEstPast] = row.d ?? [];
      const symbol = name || row.s?.split(":").pop() || "";

      // Prüfe zukünftiges Earnings-Datum
      if (tsNext) {
        const dateObj = new Date(tsNext * 1000);
        const dStr    = isoDateLocal(dateObj);
        if (dStr >= monStr && dStr <= friStr) {
          const timeLabel = pubType === 1 ? "BMO" : pubType === 2 ? "AMC" : "–";
          results.push({
            symbol,
            date_str:     dStr,
            weekday:      fmtWeekday(dateObj),
            time_label:   timeLabel,
            eps_estimate: epsEstNext != null ? String(epsEstNext) : null,
            eps_actual:   null,
            released:     false,
          });
        }
      }

      // Prüfe letztes veröffentlichtes Earnings-Datum (für Act-vs-Exp nach Release)
      if (tsPast) {
        const dateObj = new Date(tsPast * 1000);
        const dStr    = isoDateLocal(dateObj);
        if (dStr >= monStr && dStr <= friStr) {
          // Duplikate vermeiden: wenn beide Termine identisch sind, nur aktualisieren
          const existing = results.find((r) => r.symbol === symbol && r.date_str === dStr);
          if (existing) {
            existing.eps_actual   = epsActual != null ? String(epsActual) : null;
            existing.eps_estimate = existing.eps_estimate ?? (epsEstPast != null ? String(epsEstPast) : null);
            existing.released     = true;
          } else {
            results.push({
              symbol,
              date_str:     dStr,
              weekday:      fmtWeekday(dateObj),
              time_label:   "–",
              eps_estimate: epsEstPast != null ? String(epsEstPast) : null,
              eps_actual:   epsActual != null ? String(epsActual) : null,
              released:     true,
            });
          }
        }
      }
    }

    console.log(`[Earnings] TV Scanner: ${results.length} Earnings diese Woche (aus ${tickers.length} Tickers).`);
    return results.sort((a, b) => a.date_str.localeCompare(b.date_str));
  } catch (err) {
    console.warn("[Earnings] TV Scanner Fehler:", err.message);
    return [];
  }
}

// ── Kombinierter Wochenabruf ──────────────────────────────────────────────────

export async function fetchCalendar(watchlistSymbols = []) {
  const [events, earnings] = await Promise.all([
    fetchEconomicEvents(),
    fetchEarningsForWeek(watchlistSymbols),
  ]);
  const { monday } = getWeekRange();
  return {
    events,
    earnings,
    week_label: monday.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }),
  };
}
