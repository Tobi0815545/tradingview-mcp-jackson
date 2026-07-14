/**
 * lochner.js — Mario Lochner YouTube Summary
 *
 * Holt das neueste Video von Mario Lochner (@mario.lochner)
 * via YouTube RSS Feed (kein API-Key), lädt das Transkript und extrahiert
 * die wichtigsten Marktinfos für den Daily Brief.
 */

import { fetchTranscript } from "youtube-transcript/dist/youtube-transcript.esm.js";
import Anthropic from "@anthropic-ai/sdk";
import { fetchVideoList } from "./youtube.js";

const CHANNEL_ID = "UCWFnsgnkOAc0D7OweruB3hA"; // Mario Lochner
const MAX_TRANSCRIPT_CHARS = 12_000;

// ── Haupt-Export ──────────────────────────────────────────────────────────────

export async function runLochnerSummary() {
  try {
    const videos = await fetchVideoList(CHANNEL_ID, { limit: 5 });

    // Transkript vom neuesten Video versuchen — Fallback auf ältere
    let transcript = null;
    let selectedVideo = null;

    for (const v of videos) {
      try {
        const segments = await fetchTranscript(v.videoId, { lang: "de" })
          .catch(() => fetchTranscript(v.videoId));
        if (segments?.length) {
          transcript = segments.map((s) => s.text).join(" ").slice(0, MAX_TRANSCRIPT_CHARS);
          selectedVideo = v;
          break;
        }
      } catch { /* weiter mit nächstem Video */ }
    }

    const video = selectedVideo ?? videos[0];
    const videoUrl = `https://www.youtube.com/watch?v=${video.videoId}`;

    if (!transcript) {
      return {
        success: true,
        video: { ...video, url: videoUrl },
        transcript_available: false,
      };
    }

    // ── Claude-Analyse ────────────────────────────────────────────────────────
    if (!process.env.ANTHROPIC_API_KEY) return { success: false, error: "ANTHROPIC_API_KEY nicht gesetzt" };
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 600,
      system: "Du bist ein präziser Finanzanalyst. Antworte ausschließlich mit validem JSON, kein Markdown.",
      messages: [{
        role: "user",
        content: `Fasse das folgende Video-Transkript von Mario Lochner (deutschsprachiger Finanz-YouTuber) kurz für einen Trading-Brief zusammen.

Liefere ein JSON-Objekt mit diesen Feldern:
- "summary": 2–3 Sätze Kernaussage (was ist die Hauptbotschaft/Meinung des Videos?)
- "keyPoints": Array mit max. 4 konkreten Stichpunkten (Markteinschätzungen, Aktien, Sektoren, Strategien)
- "sentiment": "Bullisch" | "Neutral" | "Bärisch"
- "sentimentEmoji": passendes Emoji (🟢 🟡 🔴)

Transkript:
${transcript}`,
      }],
    });

    let info;
    try {
      const raw = msg.content[0].text.trim();
      // JSON aus möglichem Markdown-Block extrahieren
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      info = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch {
      info = {
        summary: msg?.content?.[0]?.text?.slice(0, 300) ?? "",
        keyPoints: [],
        sentiment: "Neutral",
        sentimentEmoji: "🟡",
      };
    }

    return {
      success: true,
      video: { ...video, url: videoUrl },
      transcript_available: true,
      info,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
