/**
 * news.js — Breaking News für Watchlist-Symbole + Finviz Markt-Headlines
 *
 * Quellen:
 *   - TradingView News Headlines API (Primary — tickergenau, kein API-Key)
 *   - Yahoo Finance Search API (Fallback)
 *   - Finviz news.ashx (allgemeine Markt-Headlines)
 */

const TV_NEWS_URL = "https://news-headlines.tradingview.com/v2/headlines";
const YF_SEARCH   = "https://query2.finance.yahoo.com/v1/finance/search";
const HEADERS_YF  = { "User-Agent": "Mozilla/5.0", "Accept": "application/json" };
const HEADERS_TV  = {
  "User-Agent": "Mozilla/5.0",
  "Accept":     "application/json",
  "Origin":     "https://www.tradingview.com",
  "Referer":    "https://www.tradingview.com/",
};
const HEADERS_FV  = {
  "User-Agent":      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept":          "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer":         "https://finviz.com/",
};

// ── Watchlist-News via TradingView (Primary) ──────────────────────────────────
// TradingView liefert tickergenaue Nachrichten — nur Schlagzeilen die direkt
// zum Symbol gehören. Kein API-Key erforderlich.

async function fetchTVNewsForSymbol(tvSymbol, tickerDisplay, limit = 5) {
  // tvSymbol z.B. "NASDAQ:AAPL", tickerDisplay z.B. "AAPL"
  const url = new URL(TV_NEWS_URL);
  url.searchParams.set("client",    "web");
  url.searchParams.set("lang",      "en");
  url.searchParams.set("category",  "stock");
  url.searchParams.set("symbol",    tvSymbol);
  url.searchParams.set("streaming", "false");

  const res = await fetch(url.toString(), {
    headers: HEADERS_TV,
    signal:  AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const items = Array.isArray(json) ? json : (json.items ?? json.data ?? []);

  return items.slice(0, limit).map((item) => ({
    symbol:    tickerDisplay,
    title:     item.title       ?? item.headline ?? "",
    publisher: item.source      ?? item.provider ?? "",
    time:      item.published   ? new Date(item.published * 1000)
             : item.publishedAt ? new Date(item.publishedAt)
             : null,
    url:       item.link ?? item.url ?? "",
  })).filter((n) => n.title);
}

// ── Watchlist-News via Yahoo Finance (Fallback) ───────────────────────────────
// Zusätzlich: Schlagzeile muss den Ticker-Namen oder das Symbol enthalten,
// um sicherzustellen, dass der Artikel wirklich über dieses Unternehmen ist.

async function fetchYahooNewsForTicker(ticker, limit = 5) {
  const url = `${YF_SEARCH}?q=${encodeURIComponent(ticker)}&quotesCount=0&newsCount=${limit}&enableFuzzyQuery=false&enableCb=false`;
  const res = await fetch(url, { headers: HEADERS_YF, signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const tickerUp = ticker.toUpperCase();
  return (json.news ?? [])
    // Ticker muss in relatedTickers stehen UND im Titel erscheinen (exakt oder als Wortbestandteil)
    .filter((item) => {
      const related = (item.relatedTickers ?? []).map((t) => t.toUpperCase());
      if (!related.includes(tickerUp)) return false;
      // Prüfen ob Ticker oder mindestens einer der relatedTickers im Titel vorkommt
      const title = (item.title ?? "").toUpperCase();
      return related.some((t) => title.includes(t));
    })
    .map((item) => ({
      symbol:    ticker,
      title:     item.title     ?? "",
      publisher: item.publisher ?? "",
      time:      item.providerPublishTime ? new Date(item.providerPublishTime * 1000) : null,
      url:       item.link      ?? "",
    }));
}

/**
 * Aggregiert tickergenaue News für alle Watchlist-Symbole.
 * Primär: TradingView News API (symbolgenaue Artikel)
 * Fallback pro Symbol: Yahoo Finance mit Titelpflicht
 * Dedupliziert nach Titel, neueste zuerst.
 */
export async function fetchWatchlistNews(symbols = [], limit = 12) {
  if (!symbols.length) return [];

  const allNews = [];
  await Promise.allSettled(
    symbols.slice(0, 25).map(async (sym) => {
      const tvSymbol = sym.includes(":") ? sym : `UNKNOWN:${sym}`;
      const ticker   = sym.includes(":") ? sym.split(":").pop() : sym;
      try {
        // Primary: TradingView
        const news = await fetchTVNewsForSymbol(tvSymbol, ticker, 5);
        if (news.length > 0) {
          allNews.push(...news);
        } else {
          // Fallback: Yahoo
          const yfNews = await fetchYahooNewsForTicker(ticker, 5);
          allNews.push(...yfNews);
        }
      } catch {
        // Bei TV-Fehler: Yahoo-Fallback
        try {
          const yfNews = await fetchYahooNewsForTicker(ticker, 5);
          allNews.push(...yfNews);
        } catch { /* silent */ }
      }
    })
  );

  // Deduplizieren nach Titel, neueste zuerst
  const seen = new Set();
  return allNews
    .filter((n) => n.title && !seen.has(n.title) && seen.add(n.title))
    .sort((a, b) => (b.time?.getTime() ?? 0) - (a.time?.getTime() ?? 0))
    .slice(0, limit);
}

// ── Finviz Markt-News ─────────────────────────────────────────────────────────

/**
 * Scrapt die Top-N Schlagzeilen von finviz.com/news.ashx.
 * Fallback: Yahoo Finance allgemeine Marktnews.
 */
export async function fetchFinvizMarketNews(limit = 5) {
  try {
    const res = await fetch("https://finviz.com/news.ashx", {
      headers: HEADERS_FV,
      signal:  AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    const items = [];
    // Finviz news-table: <a href="URL" class="tab-link-news">HEADLINE</a>
    // Attributreihenfolge kann variieren → zwei Muster abdecken
    const patterns = [
      /<a\s+href="([^"]+)"[^>]+class="tab-link-news"[^>]*>([^<]+)<\/a>/g,
      /<a\s+class="tab-link-news"[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/g,
    ];
    for (const regex of patterns) {
      let match;
      while ((match = regex.exec(html)) !== null) {
        const [, url, title] = match;
        const clean = title.trim();
        if (url && clean && !items.some((i) => i.title === clean)) {
          items.push({ url, title: clean });
          if (items.length >= limit) break;
        }
      }
      if (items.length >= limit) break;
    }

    if (!items.length) throw new Error("Keine Items geparst — evtl. JS-rendered");
    return items;

  } catch (err) {
    console.warn("⚠️  Finviz News fehlgeschlagen:", err.message, "→ Yahoo-Fallback");
    return fetchYahooMarketNews(limit);
  }
}

async function fetchYahooMarketNews(limit = 5) {
  try {
    const url = `${YF_SEARCH}?q=stock+market&quotesCount=0&newsCount=${limit}&enableFuzzyQuery=false`;
    const res = await fetch(url, { headers: HEADERS_YF, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.news ?? []).slice(0, limit).map((n) => ({
      url:       n.link      ?? "",
      title:     n.title     ?? "",
      publisher: n.publisher ?? "",
    }));
  } catch {
    return [];
  }
}
