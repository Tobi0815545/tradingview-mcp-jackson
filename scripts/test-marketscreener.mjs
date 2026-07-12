// Test: MarketScreener Suche + robots.txt Inhalt

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml",
  "Accept-Language": "de-DE,de;q=0.9",
};

// 1. Robots.txt Inhalt
const rb = await fetch("https://de.marketscreener.com/robots.txt", { headers: HEADERS });
console.log("robots.txt:\n", await rb.text());

// 2. Such-Endpunkte
const searches = [
  "https://de.marketscreener.com/suche/?q=morning+meeting",
  "https://de.marketscreener.com/search/?q=morning+meeting",
  "https://de.marketscreener.com/boerse-nachrichten/suche/?q=morning+meeting",
  "https://de.marketscreener.com/?q=morning+meeting&type=news",
];

for (const url of searches) {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8_000) }).catch(() => null);
  if (!r) { console.log(`ERR ${url}`); continue; }
  console.log(`\n${r.status} ${url}`);
  if (r.ok) {
    const html = await r.text();
    const morning = html.toLowerCase().includes("morning meeting");
    const hashLinks = [...new Set([...html.matchAll(/\/boerse-nachrichten\/[a-z0-9][a-z0-9-]*-ce[0-9a-f]{12,16}/g)].map(m => m[0]))].slice(0, 5);
    console.log(`  morning: ${morning}, hash-links: ${hashLinks.length}`);
    if (morning || hashLinks.length) console.log("  Links:", hashLinks);
  }
}

// 3. Französische Version
console.log("\n=== FR Version ===");
const frUrl = "https://www.marketscreener.com/actualites/flash/";
const fr = await fetch(frUrl, { headers: HEADERS, signal: AbortSignal.timeout(8_000) }).catch(() => null);
if (fr?.ok) {
  const html = await fr.text();
  const links = [...new Set([...html.matchAll(/\/actualites\/[a-z0-9-]+-ce[0-9a-f]{12,16}/g)].map(m => m[0]))].slice(0, 5);
  console.log("FR Flash Links:", links);
}
