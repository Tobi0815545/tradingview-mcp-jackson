/**
 * youtube.js — Geteilte YouTube-RSS-Logik für lochner.js und tradermacher.js.
 * Kein API-Key nötig (öffentlicher RSS-Feed).
 */

// ── RSS: Video-Liste holen ────────────────────────────────────────────────────

export async function fetchVideoList(channelId, { limit = 5 } = {}) {
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(rssUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; DailyBrief/1.0)" },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
      const xml = await res.text();
      if (!xml.includes("<entry>")) throw new Error("RSS XML enthält keine Einträge");
      const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
        const entry = m[1];
        const videoId   = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
        const title     = entry.match(/<title>([^<]+)<\/title>/)?.[1]
          ?.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
        const published = entry.match(/<published>([^<]+)<\/published>/)?.[1];
        return { videoId, title, published };
      }).filter((e) => e.videoId && e.title);
      if (!entries.length) throw new Error("Keine Videos im RSS-Feed gefunden");
      return entries.slice(0, limit);
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
  throw lastErr;
}
