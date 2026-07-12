import { esc } from "./helpers.js";

// Auto-extracted aus daily-brief-email.js — CANSLIM-Scanner-Tabelle

function formatScannerTable(results, showShortFloat = false) {
  if (!results?.length) {
    return `<tr><td colspan="9" style="padding:12px 6px;color:#9ca3af;font-size:12px;text-align:center">Keine Kandidaten gefunden</td></tr>`;
  }

  return results.map((r) => {
    const epsColor   = r.eps_growth && r.eps_growth !== "N/V" ? "#16a34a" : "#9ca3af";
    const perfColor  = parseFloat(r.perf_3m) >= 0 ? "#16a34a" : "#dc2626";
    const sfVal      = parseFloat(r.short_float);
    const sfColor    = !isNaN(sfVal) && sfVal < 3 ? "#16a34a" : "#9ca3af";
    const sfDisplay  = showShortFloat && r.short_float && r.short_float !== "N/V" ? r.short_float : (showShortFloat ? "–" : "");
    const h52Display = r.from_52w_high ?? "–";
    const mcapColor  = r.market_cap_raw >= 100e9 ? "#15803d" : r.market_cap_raw >= 10e9 ? "#374151" : "#9ca3af";
    const dayRaw     = r.change_day_raw ?? 0;
    const dayColor   = dayRaw >= 0 ? "#16a34a" : "#dc2626";
    const dayArrow   = dayRaw >= 0 ? "▲" : "▼";
    const dayDisplay = r.change_day && r.change_day !== "–" ? `${dayArrow} ${r.change_day}` : "–";

    const [exchange, ticker] = r.symbol.includes(":") ? r.symbol.split(":") : ["", r.symbol];
    const truncTicker = ticker.length > 6 ? ticker.slice(0, 6) : ticker;
    const truncName   = r.name.length > 18 ? r.name.slice(0, 16) + "…" : r.name;
    const nameCell = `<span title="${esc(r.name)}">${esc(truncName)}</span><br><span style="font-size:9px;color:#9ca3af">${esc(r.market)}</span>`;
    const td = (content, extra = "") =>
      `<td style="padding:5px 4px;font-size:11px;overflow:hidden;${extra}">${content}</td>`;

    // Numeric score instead of star emojis (saves column space)
    const scoreNum   = r.stars ?? 0;
    const scoreColor = scoreNum >= 4 ? "#16a34a" : scoreNum >= 3 ? "#d97706" : "#6b7280";
    const scoreDisp  = `<span style="font-weight:800;font-size:13px;color:${scoreColor}">${scoreNum}</span>`;

    return `<tr style="border-bottom:1px solid #f3f4f6">
      ${td(scoreDisp, "text-align:center")}
      ${td(`<span style="font-weight:700;font-size:12px">${esc(truncTicker)}</span>${exchange ? `<br><span style="font-size:9px;color:#9ca3af">${esc(exchange)}</span>` : ""}`)}
      ${td(nameCell, "line-height:1.3")}
      ${td(r.price != null ? Number(r.price).toLocaleString("de-DE", {maximumFractionDigits: 2}) : "–", `text-align:right;font-weight:600;font-size:12px`)}
      ${td(`<span style="color:${dayColor};font-weight:700">${esc(dayDisplay)}</span>`, "text-align:right")}
      ${td(`<span style="color:${perfColor};font-weight:600">${esc(r.perf_3m)}</span>`, "text-align:right")}
      ${td(`<span style="color:${epsColor}">${esc(r.eps_growth)}</span>`, "text-align:right")}
      ${showShortFloat ? td(`<span style="color:${sfColor}">${esc(sfDisplay)}</span>`, "text-align:right") : ""}
      ${td(`<span style="color:${mcapColor};font-weight:600">${esc(r.market_cap)}</span>`, "text-align:right")}
      ${td(esc(h52Display), "text-align:right;color:#6b7280")}
    </tr>`;
  }).join("\n");
}

// Scanner colgroup: US (with Short%) = 55+60+100+52+46+44+50+44+52+44 = 547px  EU = 503px
function scannerColgroup(showShortFloat) {
  return `<colgroup>
    <col style="width:42px">
    <col style="width:56px">
    <col style="width:106px">
    <col style="width:54px">
    <col style="width:48px">
    <col style="width:44px">
    <col style="width:52px">
    ${showShortFloat ? `<col style="width:44px">` : ""}
    <col style="width:54px">
    <col style="width:44px">
  </colgroup>`;
}

function scannerTableHeader(showShortFloat = false) {
  const th = (label, align = "right") =>
    `<th style="text-align:${align};padding:5px 4px;background:#f9fafb;font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:.04em;border-bottom:2px solid #e5e7eb;overflow:hidden">${label}</th>`;
  return `<thead><tr>
    ${th("Score", "center")}
    ${th("Sym.", "left")}
    ${th("Name · Börse", "left")}
    ${th("Kurs")}
    ${th("Tag%")}
    ${th("3M%")}
    ${th("EPS")}
    ${showShortFloat ? th("Short%") : ""}
    ${th("MCap")}
    ${th("52W")}
  </tr></thead>`;
}

export function formatScannerHtml(scanData) {
  if (!scanData || (!scanData.us_results?.length && !scanData.europe_results?.length)) {
    return `<p style="color:#6b7280;font-size:13px">Keine Scanner-Ergebnisse verfügbar.</p>`;
  }

  const usTable = `
    <div style="margin-bottom:16px">
      <div style="font-size:12px;font-weight:700;color:#1e40af;margin-bottom:6px;letter-spacing:.02em">🇺🇸 Top 5 USA</div>
      <table style="width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px">
        ${scannerColgroup(true)}
        ${scannerTableHeader(true)}
        <tbody>${formatScannerTable(scanData.us_results, true)}</tbody>
      </table>
    </div>`;

  const euTable = `
    <div style="margin-bottom:4px">
      <div style="font-size:12px;font-weight:700;color:#166534;margin-bottom:6px;letter-spacing:.02em">🌍 Top 5 Europa</div>
      <table style="width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px">
        ${scannerColgroup(false)}
        ${scannerTableHeader(false)}
        <tbody>${formatScannerTable(scanData.europe_results, false)}</tbody>
      </table>
    </div>`;

  return `
  ${usTable}
  ${euTable}
  <p style="font-size:11px;color:#9ca3af;margin-top:10px;line-height:1.6">
    ${scanData.total_raw} Kandidaten gescannt · MCap &gt;10 Mrd. · Short Float &lt;3% (US) · Sortierung: ⭐ → MCap → 3M%<br>
    <span style="color:#f59e0b">⚠</span> EU: Kreuzlistungen möglich (HAM:, FWB:, LSE: etc.) — Primärbörse vor Trade prüfen.
  </p>`;
}
