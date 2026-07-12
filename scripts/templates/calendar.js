import { esc, fmtCalNum } from "./helpers.js";

// Auto-extracted aus daily-brief-email.js — Wirtschaftskalender & Earnings-Block

export function formatCalendarHtml(calData) {
  if (!calData) return "";
  const { events = [], earnings = [], week_label = "" } = calData;
  if (!events.length && !earnings.length) {
    return `<p style="color:#9ca3af;font-size:12px;margin:0">Keine wesentlichen Wirtschaftstermine diese Woche.</p>`;
  }

  // Alle Tage der Woche (Mon-Fr) sammeln
  const allDates = [...new Set([
    ...events.map((e) => e.date_str),
    ...earnings.map((e) => e.date_str),
  ])].filter(Boolean).sort();

  // TV scale: 1 = HIGH (red dot), 0 = MED (orange dot)
  const impDot = (imp) => imp >= 1
    ? `<span style="color:#dc2626;font-size:10px;margin-right:2px" title="High Impact">●</span>`
    : `<span style="color:#d97706;font-size:10px;margin-right:2px" title="Medium Impact">●</span>`;

  const today = new Date().toISOString().split("T")[0];

  const dayBlocks = allDates.map((date) => {
    const dayEvents   = events.filter((e)   => e.date_str === date);
    const dayEarnings = earnings.filter((e) => e.date_str === date);
    const isToday     = date === today;
    const weekday     = dayEvents[0]?.weekday || dayEarnings[0]?.weekday || date;

    const dayHeader = `<div style="font-size:11px;font-weight:700;color:${isToday ? "#1d4ed8" : "#374151"};padding:5px 0 3px;border-bottom:1px solid #e5e7eb;margin-bottom:4px">
      ${isToday ? "▸ " : ""}${weekday}${isToday ? " <span style='color:#6b7280;font-weight:400;font-size:10px'>(heute)</span>" : ""}
    </div>`;

    // ── Makro-Events als Badges (analog zu Earnings) ────────────────────────────
    const macroBadges = dayEvents.map((e) => {
      const act = fmtCalNum(e.actual);
      const fct = fmtCalNum(e.forecast);
      if (act && fct) {
        const aNum = parseFloat(String(e.actual).replace(",", "."));
        const fNum = parseFloat(String(e.forecast).replace(",", "."));
        const beat = !isNaN(aNum) && !isNaN(fNum) ? aNum > fNum : null;
        const bg   = beat === null ? "#eff6ff"   : beat ? "#f0fdf4" : "#fef2f2";
        const bc   = beat === null ? "#bfdbfe"   : beat ? "#bbf7d0" : "#fecaca";
        const col  = beat === null ? "#1d4ed8"   : beat ? "#16a34a" : "#dc2626";
        const valTxt = `<strong style="color:${col}">${act}${e.unit}</strong>`
          + ` <span style="color:#9ca3af;font-weight:400">vs. ${fct}${e.unit}</span>`;
        return `<div style="display:inline-flex;align-items:center;gap:5px;background:${bg};border:1px solid ${bc};border-radius:5px;padding:3px 8px;margin:2px;font-size:11px;font-weight:700">
          ${impDot(e.importance)}<span>${e.flag} ${e.time !== "–" ? `<span style="color:#9ca3af;font-weight:400;font-size:10px">${e.time}</span> ` : ""}</span>
          <span style="font-weight:600;color:#374151;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.event)}">${esc(e.event)}</span>
          <span style="white-space:nowrap">${valTxt}</span>
        </div>`;
      } else if (act) {
        return `<div style="display:inline-flex;align-items:center;gap:5px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:5px;padding:3px 8px;margin:2px;font-size:11px;font-weight:700">
          ${impDot(e.importance)}<span>${e.flag}</span>
          <span style="font-weight:600;color:#374151;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.event)}</span>
          <strong style="color:#1d4ed8">${act}${e.unit}</strong>
        </div>`;
      } else {
        // Nur Erwartungswert (noch nicht veröffentlicht)
        const timeStr = e.time !== "–" ? `<span style="color:#9ca3af;font-weight:400">${e.time}</span> ` : "";
        const forecastStr = fct ? ` · <span style="color:#6b7280">${fct}${e.unit} erw.</span>` : "";
        return `<div style="display:inline-flex;align-items:center;gap:5px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:5px;padding:3px 8px;margin:2px;font-size:11px">
          ${impDot(e.importance)}<span>${e.flag} ${timeStr}<span style="color:#374151;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.event)}${forecastStr}</span></span>
        </div>`;
      }
    }).join("");

    // ── Earnings Badges ──────────────────────────────────────────────────────────
    const earningBadges = dayEarnings.map((e) => {
      if (e.released && e.eps_actual != null) {
        const aNum = parseFloat(String(e.eps_actual).replace(",", "."));
        const fNum = e.eps_estimate != null ? parseFloat(String(e.eps_estimate).replace(",", ".")) : NaN;
        const beat = !isNaN(aNum) && !isNaN(fNum) ? aNum >= fNum : null;
        const bg   = beat === null ? "#eff6ff"   : beat ? "#f0fdf4" : "#fef2f2";
        const bc   = beat === null ? "#bfdbfe"   : beat ? "#bbf7d0" : "#fecaca";
        const col  = beat === null ? "#1d4ed8"   : beat ? "#16a34a" : "#dc2626";
        const vsF  = !isNaN(fNum) ? ` <span style="color:#9ca3af;font-weight:400">vs. ${fmtCalNum(e.eps_estimate)}</span>` : "";
        const tLabel = e.time_label && e.time_label !== "–" ? ` <span style="font-weight:400;color:#6b7280">${e.time_label}</span>` : "";
        return `<span style="display:inline-block;background:${bg};color:${col};border:1px solid ${bc};border-radius:4px;padding:2px 7px;font-size:11px;font-weight:700;margin:2px">
          📣 ${esc(e.symbol)}${tLabel} · <strong>${fmtCalNum(e.eps_actual)}</strong>${vsF}
        </span>`;
      }
      const tLabel = e.time_label && e.time_label !== "–" ? `${e.time_label}` : "";
      const estPart = e.eps_estimate ? `${tLabel ? " · " : ""}~${fmtCalNum(e.eps_estimate)}` : "";
      const inner   = tLabel || estPart ? `<span style="font-weight:400;color:#6b7280">${tLabel}${estPart}</span>` : "";
      return `<span style="display:inline-block;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;border-radius:4px;padding:2px 7px;font-size:11px;font-weight:700;margin:2px">
        📣 ${esc(e.symbol)}${inner ? " " + inner : ""}
      </span>`;
    }).join("");

    const macroSection = macroBadges ? `
      <div style="font-size:9px;text-transform:uppercase;color:#6b7280;letter-spacing:.06em;font-weight:700;margin-bottom:3px;margin-top:2px">📊 Makro-Daten</div>
      <div style="line-height:1.8">${macroBadges}</div>` : "";

    const earningsSection = earningBadges ? `
      <div style="font-size:9px;text-transform:uppercase;color:#6b7280;letter-spacing:.06em;font-weight:700;margin-top:${macroBadges ? "6px" : "2px"};margin-bottom:3px">📣 Earnings</div>
      <div>${earningBadges}</div>` : "";

    return `<div style="margin-bottom:10px;padding:8px 10px;border-radius:6px;background:${isToday ? "#f0f9ff" : "#fafafa"};border:1px solid ${isToday ? "#bae6fd" : "#f3f4f6"}">
      ${dayHeader}
      ${macroSection}
      ${earningsSection}
    </div>`;
  });

  return dayBlocks.join("");
}
