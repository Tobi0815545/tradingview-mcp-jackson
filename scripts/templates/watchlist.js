import { esc } from "./helpers.js";

// Auto-extracted aus daily-brief-email.js — Wochenrückblick (Freitag) + Watchlist-News

export function formatWochenruckblickHtml(symbols, weeklyPerfMap) {
  if (!weeklyPerfMap?.size) return "";

  // Helper: lookup mit Exchange-Prefix-Fallback (null-safe)
  const getPerfFor = (sym) => {
    if (!sym) return undefined;
    return weeklyPerfMap.get(sym) ?? weeklyPerfMap.get(sym.split(":").pop());
  };

  const rows = symbols
    .filter((s) => getPerfFor(s.symbol) != null)
    .map((s) => {
      const perf   = getPerfFor(s.symbol);
      const col    = perf >= 0 ? "#16a34a" : "#dc2626";
      const arrow  = perf >= 0 ? "▲" : "▼";
      const ticker = s.symbol.split(":").pop();
      return `<tr style="border-bottom:1px solid #f3f4f6">
        <td style="padding:5px 8px;font-weight:700;font-size:12px">${ticker}</td>
        <td style="padding:5px 8px;color:#6b7280;font-size:11px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.daily?.quote?.description ?? "")}</td>
        <td style="padding:5px 8px;text-align:right;font-weight:700;font-size:13px;color:${col}">
          ${arrow} ${Math.abs(perf).toFixed(2)}%
        </td>
        <td style="padding:5px 8px;text-align:center;font-size:16px">${perf >= 5 ? "🚀" : perf >= 2 ? "📈" : perf >= 0 ? "✅" : perf >= -2 ? "⚠️" : "🔴"}</td>
      </tr>`;
    })
    .join("");

  if (!rows) return "";

  const relevantSymbols = symbols.filter((s) => getPerfFor(s.symbol) != null);
  const sorted  = relevantSymbols.map((s) => getPerfFor(s.symbol));
  const avgPerf = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
  const best    = relevantSymbols.reduce((a, s) => {
    const p = getPerfFor(s.symbol) ?? -999;
    return p > (getPerfFor(a?.symbol) ?? -999) ? s : a;
  }, null);
  const worst   = relevantSymbols.reduce((a, s) => {
    const p = getPerfFor(s.symbol) ?? 999;
    return p < (getPerfFor(a?.symbol) ?? 999) ? s : a;
  }, null);

  return `
  <div style="margin-top:8px;padding-top:10px;border-top:1px solid #e5e7eb">
    <div style="font-size:10px;text-transform:uppercase;color:#9ca3af;letter-spacing:.05em;font-weight:600;margin-bottom:6px">
      📅 Wochenrückblick (5 Handelstage)
    </div>
    <div style="display:flex;gap:12px;margin-bottom:10px;flex-wrap:wrap">
      <div style="background:#f0fdf4;border-radius:6px;padding:6px 12px;font-size:12px">
        <span style="color:#9ca3af">Ø WL:</span>
        <strong style="color:${avgPerf >= 0 ? "#16a34a" : "#dc2626"}">${avgPerf >= 0 ? "+" : ""}${avgPerf.toFixed(1)}%</strong>
      </div>
      ${best ? `<div style="background:#f0fdf4;border-radius:6px;padding:6px 12px;font-size:12px">
        🏆 <strong>${best.symbol.split(":").pop()}</strong>
        <span style="color:#16a34a">+${(getPerfFor(best.symbol) ?? 0).toFixed(1)}%</span>
      </div>` : ""}
      ${worst ? `<div style="background:#fef2f2;border-radius:6px;padding:6px 12px;font-size:12px">
        ⚠️ <strong>${worst.symbol.split(":").pop()}</strong>
        <span style="color:#dc2626">${(getPerfFor(worst.symbol) ?? 0).toFixed(1)}%</span>
      </div>` : ""}
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr>
        <th style="text-align:left;padding:5px 8px;background:#f9fafb;font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;border-bottom:2px solid #e5e7eb">Symbol</th>
        <th style="text-align:left;padding:5px 8px;background:#f9fafb;font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;border-bottom:2px solid #e5e7eb">Name</th>
        <th style="text-align:right;padding:5px 8px;background:#f9fafb;font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;border-bottom:2px solid #e5e7eb">Woche %</th>
        <th style="text-align:center;padding:5px 8px;background:#f9fafb;font-size:10px;color:#9ca3af;border-bottom:2px solid #e5e7eb"></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

export function formatWatchlistNewsHtml(news) {
  if (!news?.length) return "";

  const fmtAge = (date) => {
    if (!date) return "";
    const diffMs = Date.now() - date.getTime();
    const h = diffMs / 3_600_000;
    if (h < 1)   return `${Math.round(diffMs / 60_000)} Min.`;
    if (h < 24)  return `${Math.round(h)} Std.`;
    return date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
  };

  // Gruppiere News nach Symbol — alle Meldungen eines Symbols zusammen
  const groups = new Map();
  for (const n of news) {
    if (!groups.has(n.symbol)) groups.set(n.symbol, []);
    groups.get(n.symbol).push(n);
  }

  // Innerhalb jeder Gruppe: neueste zuerst
  for (const items of groups.values()) {
    items.sort((a, b) => (b.time?.getTime() ?? 0) - (a.time?.getTime() ?? 0));
  }

  // Gruppen-Reihenfolge: Symbol mit der aktuellsten Meldung zuerst
  const sortedGroups = [...groups.entries()].sort((a, b) => {
    const aTime = a[1][0]?.time?.getTime() ?? 0;
    const bTime = b[1][0]?.time?.getTime() ?? 0;
    return bTime - aTime;
  });

  return sortedGroups.map(([symbol, items]) => {
    const itemsHtml = items.map((n, i) => `
    <div style="padding:5px 0 5px 8px;border-bottom:1px solid #f9fafb${i === 0 ? ";border-top:1px solid #f3f4f6" : ""}">
      ${n.url
        ? `<a href="${esc(n.url)}" style="color:#1f2937;text-decoration:none;font-size:12px;line-height:1.4;display:block">${esc(n.title)}</a>`
        : `<span style="color:#1f2937;font-size:12px;line-height:1.4;display:block">${esc(n.title)}</span>`}
      <div style="font-size:10px;color:#9ca3af;margin-top:1px">${esc(n.publisher)}${n.time ? ` &nbsp;·&nbsp; ${fmtAge(n.time)}` : ""}</div>
    </div>`).join("");

    return `
    <div style="margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:6px;padding:4px 0">
        <span style="background:#1e40af;color:white;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:700">${symbol}</span>
        <span style="font-size:10px;color:#9ca3af">${items.length} Meldung${items.length > 1 ? "en" : ""}</span>
      </div>
      ${itemsHtml}
    </div>`;
  }).join("");
}
