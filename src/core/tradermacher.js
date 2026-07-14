/**
 * tradermacher.js — Tradermacher Swingtrading Ideas
 *
 * Holt die neuesten Videos von @TradermacherDe (132K Abonnenten),
 * extrahiert die 3 besten Swingtrading-Ideen mit kurzer Claude-Bewertung.
 */

import { fetchTranscript } from "youtube-transcript/dist/youtube-transcript.esm.js";
import Anthropic from "@anthropic-ai/sdk";
import { fetchVideoList } from "./youtube.js";

const CHANNEL_ID = "UCh2gY-BOw1DBxBoojRiqZjQ"; // @TradermacherDe
const MAX_TRANSCRIPT_CHARS = 14_000;

// ── Haupt-Export ──────────────────────────────────────────────────────────────

export async function runTradermacherIdeas() {
  try {
    const videos = await fetchVideoList(CHANNEL_ID, { limit: 6 });

    // Mehrere Videos kombinieren um genug Content für 3 Ideen zu haben
    let combinedTranscript = "";
    const videosSampled = [];

    for (const v of videos.slice(0, 4)) {
      try {
        const segments = await fetchTranscript(v.videoId, { lang: "de" })
          .catch(() => fetchTranscript(v.videoId));
        if (segments?.length) {
          const text = segments.map((s) => s.text).join(" ");
          combinedTranscript += `\n\n=== VIDEO: "${v.title}" (${v.published?.slice(0, 10)}) ===\n${text}`;
          videosSampled.push({ ...v, url: `https://www.youtube.com/watch?v=${v.videoId}` });
          if (combinedTranscript.length >= MAX_TRANSCRIPT_CHARS) break;
        }
      } catch { /* weiter mit nächstem Video */ }
    }

    if (!combinedTranscript || !videosSampled.length) {
      return { success: false, error: "Keine Transkripte verfügbar" };
    }

    combinedTranscript = combinedTranscript.slice(0, MAX_TRANSCRIPT_CHARS);

    // ── Claude-Analyse ────────────────────────────────────────────────────────
    if (!process.env.ANTHROPIC_API_KEY) return { success: false, error: "ANTHROPIC_API_KEY nicht gesetzt" };
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 900,
      system: "Du bist ein erfahrener CANSLIM-Swingtrading-Analyst. Antworte ausschließlich mit validem JSON, kein Markdown.",
      messages: [{
        role: "user",
        content: `Analysiere die folgenden Transkripte von "Tradermacher" (deutschsprachiger Swingtrading-YouTuber, @TradermacherDe).

Extrahiere die 3 konkreten Swingtrading-Kandidaten/Setups die erwähnt werden. Falls weniger als 3 vorhanden, nimm so viele wie da sind.

Antworte mit einem JSON-Array:
[
  {
    "symbol": "Ticker oder Firmenname",
    "direction": "Long" oder "Short",
    "thesis": "1 Satz: das konkrete Setup/den Grund für den Trade",
    "claudeComment": "Deine kurze CANSLIM-Einschätzung: ist das Setup plausibel, wichtige Risiken oder Stärken? (1-2 Sätze)"
  }
]

Transkripte:
${combinedTranscript}`,
      }],
    });

    let ideas;
    try {
      const raw = (msg?.content?.[0]?.text ?? "").trim();
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      ideas = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
      if (!Array.isArray(ideas)) ideas = [];
    } catch {
      ideas = [];
    }

    return {
      success: true,
      videos: videosSampled,
      ideas: ideas.slice(0, 3),
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
