/**
 * Options-Metriken für Watchlist-Symbole.
 *
 * Fetcht ATM Implied Volatility (IV) via Yahoo Finance Options-Chain und
 * klassifiziert die passende Options-Strategie nach dem Options Playbook:
 *   CC     — Covered Call     (Uptrend + moderate/hohe IV)
 *   CSP    — Cash-Secured Put (Konsolidierung/Support + moderate IV)
 *   IC     — Iron Condor      (Seitwärts + hohe IV)
 *   Long C — Long Call        (Starker Uptrend + niedrige IV / günstige Optionen)
 *   –      — Kein klares Setup
 *
 * Yahoo Finance v7 benötigt seit 2024 einen Crumb + A3-Session-Cookie.
 * Lösung: fc.yahoo.com (gibt A3-Cookie auch bei 404) → Crumb-Endpoint → Options-API.
 * Alles über Node.js https-Modul (kein undici-Overflow), Crumb + Cookie gecached.
 */

import https from "node:https";

// Session-State (gecached für die Laufzeit des Prozesses)
let _crumb  = null;
let _cookie = null;
let _crumbTs = 0;
const CRUMB_TTL_MS = 3600_000;

// ── HTTP-Helper (https-Modul, kein undici-Limit) ─────────────────────────────

function httpsGet(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.get({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept":     "*/*",
        ...(opts.headers ?? {}),
      },
      maxHeaderSize: 131_072,   // 128 KB — verhindert HeadersOverflowError
      timeout: 12_000,
    }, (res) => {
      const cookies = res.headers["set-cookie"] ?? [];
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, cookies, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Timeout")));
  });
}

// ── Yahoo Finance Crumb ───────────────────────────────────────────────────────

async function getYahooCrumb() {
  if (_crumb && _cookie && (Date.now() - _crumbTs) < CRUMB_TTL_MS) return { crumb: _crumb, cookie: _cookie };

  // fc.yahoo.com → gibt A3-Auth-Cookie (auch bei HTTP 404)
  // Kein undici-Overflow, da wir das https-Modul direkt nutzen
  const r1 = await httpsGet("https://fc.yahoo.com");
  _cookie   = r1.cookies.find((c) => c.startsWith("A3="))?.split(";")[0] ?? "";
  if (!_cookie) throw new Error("fc.yahoo.com hat keinen A3-Cookie geliefert");

  // Crumb-Token holen (Status 200 erwartet)
  const r2 = await httpsGet("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "Cookie": _cookie },
  });
  _crumb = r2.body.trim();
  if (!_crumb || _crumb.startsWith("{")) {
    throw new Error(`Ungültiger Crumb (Status ${r2.status}): ${_crumb.slice(0, 60)}`);
  }

  _crumbTs = Date.now();
  return { crumb: _crumb, cookie: _cookie };
}

// ── ATM-IV für einen einzelnen Ticker fetchen ────────────────────────────────

async function fetchIvForTicker(ticker, crumb, cookie) {
  try {
    const url  = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(ticker)}?crumb=${encodeURIComponent(crumb)}`;
    const res  = await httpsGet(url, { headers: { "Cookie": cookie } });
    if (res.status !== 200) return null;

    const json   = JSON.parse(res.body);
    const result = json?.optionChain?.result?.[0];
    if (!result) return null;

    const price = result.quote?.regularMarketPrice;
    if (!price || price <= 0) return null;

    // Nächste verfügbare Expiry (Index 0)
    const opts = result.options?.[0];
    if (!opts) return null;

    const calls = (opts.calls ?? []).filter((c) => c.impliedVolatility > 0);
    const puts  = (opts.puts  ?? []).filter((p) => p.impliedVolatility > 0);
    if (!calls.length && !puts.length) return null;

    // ATM: Strike am nächsten zum aktuellen Kurs
    const nearest = (arr) =>
      arr.reduce(
        (best, x) =>
          !best || Math.abs((x.strike ?? 0) - price) < Math.abs((best.strike ?? 0) - price)
            ? x
            : best,
        null
      );

    const atmCall = nearest(calls);
    const atmPut  = nearest(puts);

    // Durchschnittliche ATM-IV — Dezimal (0.35) → Prozent (35%)
    // Sanity-Filter: 1 % – 400 % (schließt Datenfehler & Verfalls-Spikes aus)
    const ivs = [atmCall?.impliedVolatility, atmPut?.impliedVolatility].filter(
      (v) => v != null && v >= 0.01 && v <= 4.0
    );
    if (!ivs.length) return null;

    const iv_pct = (ivs.reduce((a, b) => a + b, 0) / ivs.length) * 100;

    // Verfallsdatum für Tooltip / Anzeige
    const expTs    = opts.expirationDate;
    const exp_date = expTs
      ? new Date(expTs * 1000).toLocaleDateString("de-DE", {
          day: "2-digit",
          month: "2-digit",
        })
      : null;

    return { iv_pct, exp_date };
  } catch {
    return null;
  }
}

// ── Strategie-Klassifikation ─────────────────────────────────────────────────
//
// Inputs:  iv_pct  — IV-Rank (0–100, Percentile) bevorzugt, oder Implied Volatility in % (Fallback)
//          stage2  — Boolean: Kurs in Stage-2-Uptrend (close > EMA50 > SMA150 > SMA200)
//          rsi     — RSI(14) Wert
//
// Output:  { strategy, stars }
//          strategy: "CC" | "CSP" | "IC" | "Long C" | "–"
//          stars:    0–3 (Qualität des Setups für diese Strategie)

export function classifyOptions({ iv_pct, stage2, rsi }) {
  if (iv_pct == null || isNaN(iv_pct)) return { strategy: "–", stars: 0 };

  const highIV = iv_pct >= 50; // IVR ≥ 50: IV überdurchschnittlich hoch → Premium Selling attraktiv
  const modIV  = iv_pct >= 30; // IVR ≥ 30: moderate IV-Umgebung

  // Iron Condor — Seitwärts (RSI 40–60) + hohe IV → Range-Bound Premium Selling
  if (rsi != null && rsi >= 40 && rsi <= 60 && highIV)
    return { strategy: "IC", stars: 3 };

  // Covered Call — Stage-2 Uptrend + moderate/hohe IV → Prämie oben kassieren
  if (stage2 && rsi != null && rsi >= 50 && rsi <= 75 && modIV)
    return { strategy: "CC", stars: highIV ? 3 : 2 };

  // Cash-Secured Put — Konsolidierung bei Support + moderate IV → günstiger Einstieg
  if (rsi != null && rsi >= 28 && rsi <= 52 && modIV)
    return { strategy: "CSP", stars: highIV ? 3 : 2 };

  // Long Call — Starker Uptrend + niedrige IV (günstige Optionen = gutes CRV)
  if (stage2 && rsi != null && rsi >= 62 && !modIV)
    return { strategy: "Long C", stars: 2 };

  // Fallback: Hohe IV vorhanden, kein klares Setup → CC als Standard-Premium-Seller
  if (highIV) return { strategy: "CC", stars: 1 };

  return { strategy: "–", stars: 0 };
}

// ── Alle Symbole parallel fetchen ────────────────────────────────────────────

export async function fetchOptionsIv(symbols = []) {
  if (!symbols.length) return new Map();

  // Crumb + Cookie einmalig holen (session-cached)
  let crumb, cookie;
  try {
    ({ crumb, cookie } = await getYahooCrumb());
  } catch (e) {
    console.error("[Options] Crumb-Fetch fehlgeschlagen:", e?.message);
    return new Map();
  }

  const result = new Map();
  const BATCH  = 6; // Parallel-Requests je Batch

  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);

    await Promise.allSettled(
      batch.map(async (sym) => {
        const ticker = sym.includes(":") ? sym.split(":").pop() : sym;

        // Nicht-US-Symbole (XETR:SAP, BTCUSD etc.) haben keine Yahoo-Options-Chain
        const data = await fetchIvForTicker(ticker, crumb, cookie);
        if (data) {
          result.set(sym, data);    // NASDAQ:ABBV → data
          result.set(ticker, data); // ABBV        → data (Fallback-Lookup)
        }
      })
    );

    // Delay zwischen Batches gegen Rate-Limiting
    if (i + BATCH < symbols.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  return result;
}
