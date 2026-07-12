import Anthropic from "@anthropic-ai/sdk";

// ── News-Übersetzung (Englisch → Deutsch via Claude) ─────────────────────────

export async function translateHeadlines(newsList) {
  if (!newsList?.length) return newsList;
  try {
    const client = new Anthropic({ timeout: 15_000 });
    const titles = newsList.map((n) => n.title);
    const prompt = `Übersetze die folgenden englischen Nachrichtenüberschriften ins Deutsche. Antworte NUR mit einem JSON-Array der übersetzten Texte, in der gleichen Reihenfolge. Keine Erklärungen.\n\n${JSON.stringify(titles)}`;
    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });
    const raw = response.content[0]?.text?.trim() ?? "";
    const translated = JSON.parse(raw.replace(/^```json\n?/, "").replace(/\n?```$/, ""));
    if (Array.isArray(translated) && translated.length === titles.length) {
      return newsList.map((n, i) => ({ ...n, title: translated[i] }));
    }
  } catch (e) {
    console.warn("⚠️  News-Übersetzung fehlgeschlagen, verwende Original:", e.message);
  }
  return newsList;
}
