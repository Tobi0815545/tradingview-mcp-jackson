import { esc } from "./helpers.js";

// Auto-extracted aus daily-brief-email.js — Mario Lochner + Tradermacher Sektionen

export function formatLochnerHtml(lochner) {
  if (!lochner?.success || !lochner.video) {
    const errMsg = lochner?.error || "Nicht verfügbar";
    return `<p style="color:#9ca3af;font-size:12px">🎬 Mario Lochner: ${errMsg}</p>`;
  }

  const pubDate = new Date(lochner.video.published).toLocaleDateString("de-DE", {
    weekday: "short", day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  if (!lochner.transcript_available || !lochner.info) {
    return `
    <div style="border-top:1px solid #e5e7eb;margin-top:14px;padding-top:12px">
      <div style="font-size:13px;font-weight:700;margin-bottom:6px">
        🎬 Mario Lochner · <a href="${esc(lochner.video.url)}" style="color:#1d4ed8;text-decoration:none">${esc(lochner.video.title)}</a>
        <span style="font-size:11px;color:#9ca3af;font-weight:400"> · ${pubDate}</span>
      </div>
      <p style="font-size:12px;color:#9ca3af;margin:0">Transkript nicht verfügbar — Video direkt ansehen.</p>
    </div>`;
  }

  const { summary, keyPoints = [], sentiment, sentimentEmoji } = lochner.info;

  const pointsBlock = keyPoints.length
    ? keyPoints.map((pt) => `
        <div style="display:flex;gap:6px;margin-bottom:4px">
          <span style="color:#6b7280;font-size:12px;flex-shrink:0">▸</span>
          <span style="font-size:12px;color:#374151;line-height:1.5">${esc(pt)}</span>
        </div>`).join("")
    : "";

  return `
  <div style="border-top:1px solid #e5e7eb;margin-top:16px;padding-top:14px">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:10px;flex-wrap:wrap">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:800;margin-bottom:2px">🎬 Mario Lochner</div>
        <a href="${esc(lochner.video.url)}" style="font-size:12px;color:#1d4ed8;text-decoration:none;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(lochner.video.title)}">${esc(lochner.video.title)}</a>
        <div style="font-size:11px;color:#9ca3af;margin-top:1px">${pubDate}</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-size:18px">${sentimentEmoji}</div>
        <div style="font-size:11px;font-weight:700;color:#374151">${sentiment}</div>
      </div>
    </div>

    ${summary ? `
    <div style="background:#f9fafb;border-radius:6px;padding:8px 10px;margin-bottom:8px">
      <div style="font-size:10px;text-transform:uppercase;color:#9ca3af;letter-spacing:.05em;font-weight:600;margin-bottom:4px">Zusammenfassung</div>
      <div style="font-size:12px;color:#1f2937;line-height:1.6">${esc(summary)}</div>
    </div>` : ""}

    ${pointsBlock ? `
    <div style="margin-bottom:8px">
      <div style="font-size:10px;text-transform:uppercase;color:#9ca3af;letter-spacing:.05em;margin-bottom:5px;font-weight:600">Key Points</div>
      ${pointsBlock}
    </div>` : ""}

    <div style="margin-top:8px">
      <a href="${esc(lochner.video.url)}" style="font-size:11px;color:#6b7280;text-decoration:none">▶ Vollständiges Video ansehen →</a>
    </div>
  </div>`;
}

// ── Tradermacher Swingtrading Ideas HTML ──────────────────────────────────────

export function formatTradermacherHtml(tm) {
  if (!tm?.success || !tm.ideas?.length) {
    const errMsg = tm?.error || "Keine Ideen verfügbar";
    return `<p style="color:#9ca3af;font-size:12px">📊 Tradermacher: ${errMsg}</p>`;
  }

  const latestVideo = tm.videos?.[0];
  const pubDate = latestVideo?.published
    ? new Date(latestVideo.published).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" })
    : "";

  const ideaRows = tm.ideas.map((idea, i) => {
    const dirColor = idea.direction === "Short" ? "#dc2626" : "#16a34a";
    const dirBg    = idea.direction === "Short" ? "#fef2f2" : "#f0fdf4";
    return `
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;margin-bottom:8px;background:#fff">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="background:#1d4ed8;color:#fff;border-radius:50%;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0">${i + 1}</span>
        <span style="font-weight:800;font-size:14px">${esc(idea.symbol)}</span>
        <span style="background:${dirBg};color:${dirColor};border-radius:4px;padding:1px 7px;font-size:11px;font-weight:700">${idea.direction}</span>
      </div>
      <div style="font-size:12px;color:#374151;line-height:1.5;margin-bottom:6px">
        <span style="font-weight:600;color:#6b7280">Setup: </span>${esc(idea.thesis)}
      </div>
      <div style="font-size:11px;color:#6b7280;background:#f9fafb;border-radius:5px;padding:6px 8px;line-height:1.5;border-left:3px solid #d1d5db">
        <span style="font-weight:600;color:#374151">🤖 Meine Einschätzung: </span>${esc(idea.claudeComment)}
      </div>
    </div>`;
  }).join("");

  const videoLinks = tm.videos?.slice(0, 2).map((v) =>
    `<a href="${v.url}" style="color:#6b7280;font-size:11px;text-decoration:none">▶ ${v.title?.slice(0, 50)}${v.title?.length > 50 ? "…" : ""}</a>`
  ).join("<br>") ?? "";

  return `
  <div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
      <div style="font-size:10px;text-transform:uppercase;color:#9ca3af;letter-spacing:.05em;font-weight:600">
        Top 3 Swing-Ideen · @TradermacherDe ${pubDate ? `· analysiert ${pubDate}` : ""}
      </div>
    </div>
    ${ideaRows}
    ${videoLinks ? `<div style="margin-top:6px">${videoLinks}</div>` : ""}
  </div>`;
}
