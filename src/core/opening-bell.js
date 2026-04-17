/**
 * Opening Bell — Markus Koch YouTube Summary
 *
 * Holt automatisch das neueste Video vom Markus Koch Wall Street Kanal
 * via YouTube RSS Feed (kein API-Key), lädt das Transkript und extrahiert
 * die wichtigsten Marktinfos für den Morning Brief.
 *
 * Sucht nach: "Opening Bell", "Closing Bell", oder dem neuesten Video des Tages.
 */

import { fetchTranscript } from "youtube-transcript/dist/youtube-transcript.esm.js";
import Anthropic from "@anthropic-ai/sdk";

const CHANNEL_ID  = "UCyCBf6asf89aQJaSXuAuTsg"; // Markus Koch Wall Street
const RSS_URL     = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
const MAX_TRANSCRIPT_CHARS = 14_000;

// ── RSS: Neuestes Video finden ───────────────────────────────────────────────

async function fetchLatestVideo() {
  const res = await fetch(RSS_URL, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
  const xml = await res.text();

  // Alle Einträge parsen
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
    const entry = m[1];
    const videoId   = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    const title     = entry.match(/<title>([^<]+)<\/title>/)?.[1]?.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
    const published = entry.match(/<published>([^<]+)<\/published>/)?.[1];
    const url       = entry.match(/href="(https:\/\/www\.youtube\.com\/watch[^"]+)"/)?.[1];
    return { videoId, title, published, url };
  }).filter((e) => e.videoId && e.title);

  if (!entries.length) throw new Error("Keine Videos im RSS-Feed gefunden");

  // RSS is in reverse chronological order (newest first).
  // Strategy: pick the newest entry that matches a Bell/Wall-Street keyword.
  // If none match in the top 5 entries, fall back to the overall newest video.
  const keywords = ["opening bell", "closing bell", "wall street"];
  const recent   = entries.slice(0, 5);
  const matched  = recent.find((e) =>
    keywords.some((kw) => e.title.toLowerCase().includes(kw))
  );
  return matched || entries[0];
}

// ── Transkript laden ─────────────────────────────────────────────────────────

async function loadTranscript(videoId) {
  // Versuche zuerst Deutsch, dann Englisch, dann auto-generiert
  for (const lang of ["de", "en", undefined]) {
    try {
      const opts = lang ? { lang } : {};
      const segments = await fetchTranscript(videoId, opts);
      if (segments?.length) {
        return segments.map((s) => s.text).join(" ");
      }
    } catch { /* nächste Sprache versuchen */ }
  }
  throw new Error("Kein Transkript verfügbar (deaktiviert oder nicht generiert)");
}

// ── Bekannte Marktbegriffe ────────────────────────────────────────────────────

// Geordnet nach Priorität: Indizes zuerst, dann Assets, dann Makro
const MOVE_TERMS = [
  // US-Indizes
  { key: "sp500",    terms: ["s&p 500", "s&p500", "sp 500", "s & p", "s&p"] },
  { key: "nasdaq",   terms: ["nasdaq 100", "nasdaq100", "nasdaq"] },
  { key: "dow",      terms: ["dow jones", "dow"] },
  { key: "russell",  terms: ["russell 2000", "russell"] },
  // EU/Asien
  { key: "dax",      terms: ["dax"] },
  { key: "eurostoxx",terms: ["euro stoxx", "eurostoxx"] },
  { key: "nikkei",   terms: ["nikkei"] },
  // Rohstoffe / Währungen
  { key: "gold",     terms: ["gold"] },
  { key: "oel",      terms: ["öl", "crude", "rohöl", "wti", "brent"] },
  { key: "bitcoin",  terms: ["bitcoin", "btc", "krypto"] },
  { key: "dollar",   terms: ["dollar", "us-dollar", "greenback"] },
  // Makro-Events (CPI, Fed etc. haben eigene Sektion)
  { key: "cpi",      terms: ["cpi", "inflation", "verbraucherpreise", "kerninflation"] },
  { key: "pce",      terms: ["pce"] },
  { key: "jobs",     terms: ["arbeitsmarkt", "jobs", "non-farm", "beschäftigung"] },
  // Tech-Einzeltitel (häufig bei Markus Koch)
  { key: "nvidia",   terms: ["nvidia", "nvda"] },
  { key: "apple",    terms: ["apple", "aapl"] },
  { key: "microsoft",terms: ["microsoft", "msft"] },
  { key: "meta",     terms: ["meta"] },
  { key: "amazon",   terms: ["amazon", "amzn"] },
  { key: "tesla",    terms: ["tesla", "tsla"] },
];

const FED_TERMS = [
  "fed", "federal reserve", "zinsen", "zins", "leitzins", "powell",
  "fomc", "basispunkte", "bp", "rate cut", "zinssenkung", "zinserhöhung",
  "geldpolitik", "pause", "pivot", "dot plot", "minutes",
];

const NUMBER_RE = /\d[\d,.]*\s*(?:%|Prozent|Punkte|Dollar|Euro|Cent|\$|€|Basispunkte|bp|Mrd|Mio|Billionen)/i;

// ── Fensterbasierte Extraktion ────────────────────────────────────────────────
//
// YouTube-Transkripte sind weitgehend lowercase ohne Satzzeichen.
// Deshalb kein Satz-Split, sondern: gleitende Wortfenster über das Transkript.
// Pro erkanntem Marktbegriff wird ein Fenster von ±WINDOW_WORDS Wörtern
// um die Fundstelle als lesbarer Kontext zurückgegeben.

const WINDOW_WORDS = 18; // Wörter links + rechts um den Treffer

function extractWindow(words, matchIdx) {
  const from = Math.max(0, matchIdx - WINDOW_WORDS);
  const to   = Math.min(words.length, matchIdx + WINDOW_WORDS + 1);
  return words.slice(from, to).join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Kapitalisiert den ersten Buchstaben und setzt ggf. ein Ellipsis.
 */
function cleanWindow(s, maxLen = 140) {
  const cleaned = s
    .replace(/^(also|und|aber|denn|doch|ja|nun|mal|nämlich|halt|ähm|äh|mhm|hm)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const capped = cleaned.length > maxLen ? cleaned.slice(0, maxLen - 1) + "…" : cleaned;
  // Ersten Buchstaben groß
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

/**
 * Hauptextraktion: liefert strukturierte Marktinfos mit Kontext-Fenstern.
 * Funktioniert robust auch bei Transkripten ohne Satzzeichen.
 */
function extractKeyInfo(transcript) {
  const text  = transcript.slice(0, MAX_TRANSCRIPT_CHARS);
  const lower = text.toLowerCase();
  const words = text.split(/\s+/);

  // ── Marktbewegungen: für jeden bekannten Begriff das erste ──────────────
  // Kontext-Fenster mit Zahl extrahieren
  const movements = [];
  const seenKeys  = new Set();

  for (const { key, terms } of MOVE_TERMS) {
    if (seenKeys.has(key)) continue;

    for (const term of terms) {
      const pos = lower.indexOf(term);
      if (pos === -1) continue;

      // Position in Wort-Array ermitteln
      let charCount = 0;
      let wordIdx   = 0;
      for (let i = 0; i < words.length; i++) {
        charCount += words[i].length + 1;
        if (charCount >= pos) { wordIdx = i; break; }
      }

      // Fenster um die Fundstelle
      const window = extractWindow(words, wordIdx);
      const windowLower = window.toLowerCase();

      // Fenster muss eine Zahl/Prozent enthalten — sonst überspringen
      if (!NUMBER_RE.test(window) && !/\d/.test(window)) continue;

      // Mindest-Informationsgehalt: muss Zahl UND Bewegungskontext haben
      const hasMove = /[\d,.]+\s*(?:%|Prozent|Punkte)/i.test(window)
        || /(?:steigt?|fällt?|sinkt?|legt|gibt|verliert|gewinnt|notiert|handelt|zulegen|nachgeben).*\d/i.test(window)
        || /\d.*(?:steigt?|fällt?|sinkt?|legt|gibt|verliert|gewinnt|notiert|handelt)/i.test(window);

      if (!hasMove) continue;

      seenKeys.add(key);
      movements.push(cleanWindow(window));
      break; // Nächsten Begriff
    }

    if (movements.length >= 7) break;
  }

  // ── Fed / Makro: Fenster mit Fed-Begriffen + Zahlen ─────────────────────
  const fedResults = [];
  const fedSeen    = new Set();

  for (const kw of FED_TERMS) {
    let searchFrom = 0;
    while (fedResults.length < 3) {
      const pos = lower.indexOf(kw, searchFrom);
      if (pos === -1) break;
      searchFrom = pos + kw.length + 1;

      let charCount = 0, wordIdx = 0;
      for (let i = 0; i < words.length; i++) {
        charCount += words[i].length + 1;
        if (charCount >= pos) { wordIdx = i; break; }
      }
      const window = extractWindow(words, wordIdx);
      if (!NUMBER_RE.test(window) && !/\d/.test(window)) continue;

      // Dedup: nicht den gleichen Kontext zweimal
      const sig = window.slice(0, 40);
      if (fedSeen.has(sig)) continue;
      fedSeen.add(sig);
      fedResults.push(cleanWindow(window, 160));
      break;
    }
    if (fedResults.length >= 3) break;
  }

  // ── Einzelaktien mit expliziter Bewegung ────────────────────────────────
  const stockMatches = [...text.matchAll(/\b([A-Z]{2,5})\b[^.!?\n]{0,80}([\+\-]\d+[,\.]?\d*)\s*(?:%|Prozent)/g)];
  const stocks = [...new Map(stockMatches.map((m) => [m[1], `${m[1]} ${m[2]}%`])).entries()]
    .slice(0, 5).map(([, v]) => v);

  // ── Stimmungs-Score ──────────────────────────────────────────────────────
  const bullish = (text.match(/\b(stark|steigt|Gewinne|bullish|positiv|Rallye|Kaufen|Aufwärtstrend|optimistisch|Erholung|Allzeithoch|breakout|rally|gains?|surges?|soars?|zulegen|zulegte|Aufschlag|zugelegt|gestiegen)\b/gi) || []).length;
  const bearish  = (text.match(/\b(fällt|sinkt|Verluste|bearish|negativ|Absturz|Verkaufen|Abwärtstrend|pessimistisch|Einbruch|crash|sell.off|drops?|falls?|plunges?|fear|panic|Abschlag|nachgeben|nachgab|gefallen|gesunken)\b/gi) || []).length;

  let sentiment, sentimentEmoji;
  const total = bullish + bearish;
  if (total === 0) {
    sentiment = "Neutral"; sentimentEmoji = "⚪";
  } else {
    const ratio = bullish / total;
    if      (ratio >= 0.65) { sentiment = "Optimistisch";        sentimentEmoji = "🟢"; }
    else if (ratio >= 0.50) { sentiment = "Vorsichtig positiv";  sentimentEmoji = "🟡"; }
    else if (ratio >= 0.35) { sentiment = "Vorsichtig negativ";  sentimentEmoji = "🟠"; }
    else                    { sentiment = "Pessimistisch";        sentimentEmoji = "🔴"; }
  }

  return { movements, fedSentences: fedResults, stocks, sentiment, sentimentEmoji };
}

// ── Claude-Zusammenfassung ────────────────────────────────────────────────────

/**
 * Nutzt Claude Haiku, um das Transkript in kompakte deutsche Stichpunkte
 * zu destillieren. Fällt auf raw extraction zurück wenn kein API-Key.
 */
async function summarizeWithClaude(transcript) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null; // kein Key → Fallback auf raw

  try {
    const client = new Anthropic({ apiKey });

    // Ersten 7000 Zeichen — ausreichend für alle relevanten Infos
    const excerpt = transcript.slice(0, 7_000);

    const message = await client.messages.create({
      model:      "claude-haiku-4-5",
      max_tokens: 600,
      messages: [{
        role: "user",
        content: `Du bist ein präziser Finanz-Analyst. Unten steht ein auto-generiertes YouTube-Transkript von Markus Koch (Wall Street Experte). Transkripte sind oft ohne Satzzeichen und Sprachfehler — interpretiere inhaltlich sinngemäss.

Erstelle zwei Abschnitte als kompakte Stichpunkte:

ABSCHNITT 1 — MARKTBEWEGUNGEN (4–5 Punkte):
Wichtige Index- und Asset-Bewegungen mit konkreten Zahlen (%, Punkte, Kurslevel).

ABSCHNITT 2 — FED & MAKRO (2–3 Punkte):
Zinsen, Notenbankpolitik, Wirtschaftsdaten (CPI, PPI, Arbeitsmarkt, GDP) mit konkreten Zahlen.

Format für JEDEN Stichpunkt — EXAKT so:
**Label**: Vollständiger prägnanter Satz mit Zahlen.

Regeln:
- Jeder Punkt auf einer eigenen Zeile
- Label ist IMMER fett mit genau zwei Sternchen: **Label**:
- Keine leeren Zeilen zwischen Punkten innerhalb eines Abschnitts
- Abschnitt 1 beginnt mit der Zeile: ###BEWEGUNGEN
- Abschnitt 2 beginnt mit der Zeile: ###FED_MAKRO
- Keine anderen Überschriften, keine Einleitungen

Transkript:
${excerpt}`,
      }],
    });

    const text = message.content?.[0]?.text?.trim() || "";
    if (!text) return null;

    // Abschnitte trennen
    const movIdx = text.indexOf("###BEWEGUNGEN");
    const fedIdx = text.indexOf("###FED_MAKRO");

    const parseBullets = (block) =>
      (block || "")
        .split("\n")
        .map((l) => l.replace(/^[-•*]\s*/, "").trim())
        .filter((l) => l.length > 10 && !l.startsWith("###"));

    let movements, fedSentences;

    if (movIdx !== -1 && fedIdx !== -1) {
      const movBlock = text.slice(movIdx + 13, fedIdx);
      const fedBlock = text.slice(fedIdx + 12);
      movements    = parseBullets(movBlock);
      fedSentences = parseBullets(fedBlock);
    } else {
      // Fallback: alles als Bewegungen
      movements    = parseBullets(text);
      fedSentences = [];
    }

    if (!movements.length && !fedSentences.length) return null;
    return { movements, fedSentences };

  } catch (err) {
    console.warn("⚠️  Claude-Zusammenfassung fehlgeschlagen:", err.message);
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function runOpeningBell() {
  try {
    const video = await fetchLatestVideo();
    if (!video) throw new Error("Kein Video im RSS gefunden");

    let transcript = null;
    let transcriptError = null;
    try {
      transcript = await loadTranscript(video.videoId);
    } catch (e) {
      transcriptError = e.message;
    }

    // Basis-Extraktion (immer — liefert Sentiment + Stocks als Fallback)
    const rawInfo = transcript ? extractKeyInfo(transcript) : null;

    // Claude-Zusammenfassung (wenn API-Key verfügbar) — überschreibt movements + fedSentences
    let claudeResult = null;
    if (transcript) {
      claudeResult = await summarizeWithClaude(transcript);
    }

    // Info-Objekt: Claude hat Vorrang für movements + fedSentences
    const info = rawInfo ? {
      ...rawInfo,
      movements:    claudeResult?.movements    ?? rawInfo.movements,
      fedSentences: claudeResult?.fedSentences ?? rawInfo.fedSentences,
      usedClaude:   !!claudeResult,
    } : null;

    return {
      success:    true,
      video: {
        id:        video.videoId,
        title:     video.title,
        published: video.published,
        url:       `https://www.youtube.com/watch?v=${video.videoId}`,
      },
      transcript_available: !!transcript,
      transcript_error:     transcriptError,
      info,
    };
  } catch (err) {
    return {
      success: false,
      error:   err.message,
    };
  }
}
