// Auto-extracted aus daily-brief-email.js — Markt-Regime, Pre-Market, VIX, Fear&Greed, Buffett, Sektor-Heatmap

function formatPreMarketHtml(premarket) {
  if (!premarket?.length) return "";

  // Fixed display order: 4 indices on row 1, then commodities + FX + rates on row 2
  const order = ["index", "commodity", "fx", "rates"];
  const sorted = [...premarket].sort(
    (a, b) => order.indexOf(a.group) - order.indexOf(b.group)
  );

  const cell = (r) => {
    const chg    = r.change_pct;
    const col    = chg == null ? "#6b7280" : chg >= 0 ? "#16a34a" : "#dc2626";
    const arrow  = chg == null ? "" : chg >= 0 ? "▲" : "▼";
    // 10Y-Rendite: change in basis points (bp = 0.01%-point), not relative %
    const chgStr = chg != null
      ? (r.group === "rates" && r.price != null && r.prev_close != null
          ? `${arrow} ${Math.abs((r.price - r.prev_close) * 100).toFixed(1)}bp`
          : `${arrow} ${Math.abs(chg).toFixed(2)}%`)
      : "–";
    // Price formatting: FX 4 decimals, rates 3 decimals + %, else 2 decimals
    const maxFrac  = r.group === "fx" ? 4 : r.group === "rates" ? 3 : 2;
    const priceRaw = r.price != null
      ? r.price.toLocaleString("de-DE", { maximumFractionDigits: maxFrac })
      : "–";
    const priceStr = r.group === "rates" && r.price != null ? `${priceRaw}%` : priceRaw;
    return `<td style="padding:6px 6px;text-align:center;white-space:nowrap;width:20%">
      <div style="font-size:11px;color:#6b7280">${r.flag} ${r.label}</div>
      <div style="font-weight:700;font-size:13px">${priceStr}</div>
      <div style="font-size:12px;color:${col};font-weight:600">${chgStr}</div>
    </td>`;
  };

  // Split into 2 rows (max 5 per row)
  const half = Math.ceil(sorted.length / 2);
  const row1 = sorted.slice(0, half).map(cell).join("");
  const row2 = sorted.slice(half).map(cell).join("");

  return `
  <div style="margin-top:16px;padding-top:14px;border-top:1px solid #e5e7eb">
    <div style="font-size:10px;text-transform:uppercase;color:#9ca3af;letter-spacing:.05em;font-weight:600;margin-bottom:8px">🌅 Pre-Market &amp; Futures</div>
    <table style="width:100%;border-collapse:collapse;table-layout:fixed">
      <tr>${row1}</tr>
      ${row2 ? `<tr>${row2}</tr>` : ""}
    </table>
  </div>`;
}

// ── Sektor-Heatmap HTML ───────────────────────────────────────────────────────

function formatSectorHeatmapHtml(sectorsData) {
  const sectors = sectorsData?.items ?? sectorsData;
  if (!sectors?.length) return "";
  const sectorTimestamp = sectorsData?.fetched_at ? new Date(sectorsData.fetched_at).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

  const sorted = sectors;

  // Farb-Mapping für Heatmap-Zellen — 5 Stufen (nutzerdefiniert)
  const heatColor = (pct) => {
    if (pct == null) return { bg: "#f9fafb", text: "#6b7280" };
    if (pct >=  4)   return { bg: "#15803d", text: "#fff"    }; // dunkelgrün   >4%
    if (pct >=  1)   return { bg: "#16a34a", text: "#fff"    }; // hellgrün     1–4%
    if (pct >= -1)   return { bg: "#f3f4f6", text: "#374151" }; // grau         ±1%
    if (pct >= -4)   return { bg: "#fecaca", text: "#7f1d1d" }; // leicht rot   -1–-4%
    return                   { bg: "#dc2626", text: "#fff"    }; // dunkelrot    <-4%
  };

  // 2 Reihen: max 6 Sektoren pro Zeile — kein horizontaler Überlauf
  const row1 = sorted.slice(0, 6);
  const row2 = sorted.slice(6);

  const renderRow = (items) => items.map((s) => {
    const wStr = s.perf_week != null ? `${s.perf_week >= 0 ? "+" : ""}${s.perf_week.toFixed(1)}%` : "–";
    const dStr = s.perf_day  != null ? `${s.perf_day  >= 0 ? "+" : ""}${s.perf_day.toFixed(1)}%`  : null;
    const { bg, text } = heatColor(s.perf_week);
    // Tages-Farbe für kleinen Badge — immer grün/rot/grau, "inherit" bei dunklem Zellhintergrund
    // Dunkle Hintergründe: Tag-Badge weiß (inherit); helle Hintergründe: eigene Farbe
    const darkBg   = bg === "#15803d" || bg === "#16a34a" || bg === "#dc2626";
    const dayColor = darkBg ? "inherit"
      : s.perf_day == null ? "#9ca3af"
      : s.perf_day >= 0.3  ? "#16a34a"
      : s.perf_day <= -0.3 ? "#dc2626"
      : "#6b7280";
    return `<td style="padding:3px 2px;text-align:center;width:${(100/6).toFixed(2)}%">
      <div style="background:${bg};color:${text};border-radius:5px;padding:5px 2px 4px">
        <div style="font-size:12px">${s.icon}</div>
        <div style="font-size:7.5px;margin-bottom:2px;white-space:nowrap;opacity:.85;font-weight:600">${s.label}</div>
        <div style="font-size:11px;font-weight:800;line-height:1.2">${wStr}</div>
        ${dStr != null
          ? `<div style="font-size:9px;font-weight:600;color:${dayColor};opacity:.8;line-height:1.3">${dStr}</div>`
          : `<div style="font-size:8px;opacity:.4;line-height:1.3">Tag –</div>`}
      </div>
    </td>`;
  }).join("");

  return `
  <div style="margin-top:16px;padding-top:14px;border-top:1px solid #e5e7eb">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:7px">
      <div style="font-size:10px;text-transform:uppercase;color:#9ca3af;letter-spacing:.05em;font-weight:600">
        🗺 Sektor-Performance (S&amp;P 500)${sectorTimestamp ? ` &nbsp;·&nbsp; <span style="text-transform:none;font-weight:400">${sectorTimestamp}</span>` : ""}
      </div>
      <div style="display:flex;gap:5px;font-size:9px;align-items:center">
        <span style="background:#15803d;color:#fff;border-radius:3px;padding:1px 5px;font-weight:700">&gt;4%</span>
        <span style="background:#16a34a;color:#fff;border-radius:3px;padding:1px 5px;font-weight:700">1–4%</span>
        <span style="background:#ffffff;color:#374151;border-radius:3px;padding:1px 5px;font-weight:700;border:1px solid #d1d5db">±1%</span>
        <span style="background:#fecaca;color:#7f1d1d;border-radius:3px;padding:1px 5px;font-weight:700">-1–-4%</span>
        <span style="background:#dc2626;color:#fff;border-radius:3px;padding:1px 5px;font-weight:700">&lt;-4%</span>
      </div>
    </div>
    <div style="font-size:9px;color:#9ca3af;margin-bottom:5px">Groß = Woche &nbsp;·&nbsp; Klein = Heute</div>
    <table style="width:100%;border-collapse:separate;border-spacing:2px 3px">
      <tr>${renderRow(row1)}</tr>
      ${row2.length ? `<tr>${renderRow(row2)}</tr>` : ""}
    </table>
  </div>`;
}

// ── VIX Terminstruktur — Full-Bleed Chart ────────────────────────────────────

function formatVixTermStructure(vts) {
  if (!vts?.points?.length) return "";

  // Vollbreite, minimale Innenränder — Kurve bis an den Rand
  const W = 580, H = 130;
  const PL = 30, PR = 6, PT = 18, PB = 28;   // Links etwas für Y-Achse, rest minimal
  const plotW = W - PL - PR;
  const plotH = H - PT - PB;
  const n     = vts.points.length;

  const values = vts.points.map((p) => p.value);
  const minV   = Math.min(...values);
  const maxV   = Math.max(...values);
  // Nur 5% Luft oben und unten — Kurve füllt fast den gesamten Raum
  const pad    = (maxV - minV) * 0.08 || 0.5;
  const yMin   = minV - pad;
  const yMax   = maxV + pad;

  const isBack    = vts.structure === "backwardation";
  const lineColor = isBack ? "#dc2626" : "#1d4ed8";
  const areaTop   = isBack ? "#fca5a5" : "#93c5fd";
  const areaBot   = isBack ? "#fee2e200" : "#dbeafe00";

  const xOf = (i) => PL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yOf = (v)  => PT + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // Y-Gitter: 3 horizontale Linien mit Werten
  const gridVals = [minV + pad, (minV + maxV) / 2, maxV - pad];
  const grid = gridVals.map((v) => {
    const y = yOf(v);
    return `
      <line x1="${PL}" y1="${y.toFixed(1)}" x2="${W - PR}" y2="${y.toFixed(1)}" stroke="#e5e7eb" stroke-width="0.7" stroke-dasharray="4,3"/>
      <text x="${PL - 4}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="8.5" fill="#9ca3af">${v.toFixed(1)}</text>`;
  }).join("");

  // Fläche unter Kurve (Polygon)
  const pts     = vts.points.map((p, i) => `${xOf(i).toFixed(1)},${yOf(p.value).toFixed(1)}`);
  const areaPts = `${xOf(0).toFixed(1)},${(PT + plotH).toFixed(1)} ${pts.join(" ")} ${xOf(n-1).toFixed(1)},${(PT + plotH).toFixed(1)}`;
  const areaId  = isBack ? "vtsBack" : "vtsCont";

  const defs = `<defs>
    <linearGradient id="${areaId}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${lineColor}" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="${lineColor}" stop-opacity="0.03"/>
    </linearGradient>
  </defs>`;

  const area     = `<polygon points="${areaPts}" fill="url(#${areaId})"/>`;
  const line     = `<polyline points="${pts.join(" ")}" fill="none" stroke="${lineColor}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;

  // Datenpunkte: Wert oben, Label unten, Kreis auf der Linie
  const dots = vts.points.map((p, i) => {
    const x = xOf(i), y = yOf(p.value);
    return `
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" fill="${lineColor}" stroke="white" stroke-width="2"/>
      <text x="${x.toFixed(1)}" y="${(y - 10).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="800" fill="${lineColor}">${p.value.toFixed(2)}</text>
      <text x="${x.toFixed(1)}" y="${(H - 4).toFixed(1)}" text-anchor="middle" font-size="9" font-weight="700" fill="#6b7280">${p.label}</text>`;
  }).join("");

  const structureBadge = isBack
    ? `<span style="background:#fee2e2;color:#dc2626;padding:2px 7px;border-radius:4px;font-weight:700;font-size:11px">▼ Backwardation (Stress)</span>`
    : `<span style="background:#dbeafe;color:#1d4ed8;padding:2px 7px;border-radius:4px;font-weight:700;font-size:11px">▲ Contango (Normal)</span>`;

  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" style="display:block;width:100%;max-width:${W}px">
    ${defs}
    ${grid}
    ${area}
    ${line}
    ${dots}
  </svg>`;

  return `
  <div style="margin-top:16px;padding-top:14px;border-top:1px solid #e5e7eb">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;flex-wrap:wrap;gap:6px">
      <span style="font-size:10px;text-transform:uppercase;color:#9ca3af;letter-spacing:.05em;font-weight:600">📉 VIX Terminstruktur</span>
      ${structureBadge}
    </div>
    ${svg}
    <div style="font-size:10px;color:#9ca3af;margin-top:3px">9D · 30D · 3M · 6M · 1Y — CBOE Indizes via Yahoo Finance${vts.fetched_at ? ` · ${new Date(vts.fetched_at).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}` : ""}</div>
  </div>`;
}

// ── Fear & Greed Index — CNN-Style Gauge ────────────────────────────────────

function formatFearGreed(fg) {
  if (!fg) return "";

  const score = fg.score;

  // Smooth CNN-Farbgradient interpolieren
  const lerpColor = (c1, c2, t) => {
    const r = Math.round(c1[0] + (c2[0] - c1[0]) * t);
    const g = Math.round(c1[1] + (c2[1] - c1[1]) * t);
    const b = Math.round(c1[2] + (c2[2] - c1[2]) * t);
    return `rgb(${r},${g},${b})`;
  };
  // Farbstützpunkte: Extreme Fear → Fear → Neutral → Greed → Extreme Greed
  const stops = [
    [0,   [138, 11,  11]],
    [25,  [217, 34,  34]],
    [46,  [229, 115, 26]],
    [54,  [229, 195, 26]],
    [75,  [82,  173, 52]],
    [100, [33,  110, 26]],
  ];
  const getColor = (pct) => {
    for (let i = 0; i < stops.length - 1; i++) {
      const [s1, c1] = stops[i], [s2, c2] = stops[i + 1];
      if (pct >= s1 && pct <= s2) return lerpColor(c1, c2, (pct - s1) / (s2 - s1));
    }
    return "#333";
  };
  const scoreCol = getColor(score);

  // SVG-Dimensionen
  const W = 280, H = 168;
  const CX = W / 2, CY = 144, R = 112, STROKE = 24;

  // 60 Gradient-Segmente für smooth Arc
  const arcSegs = Array.from({ length: 60 }, (_, i) => {
    const t1 = i / 60 * 100, t2 = (i + 1) / 60 * 100;
    const col = getColor((t1 + t2) / 2);
    const a1  = Math.PI * (1 - t1 / 100), a2 = Math.PI * (1 - t2 / 100);
    const x1  = (CX + R * Math.cos(a1)).toFixed(2), y1 = (CY - R * Math.sin(a1)).toFixed(2);
    const x2  = (CX + R * Math.cos(a2)).toFixed(2), y2 = (CY - R * Math.sin(a2)).toFixed(2);
    return `<path d="M${x1},${y1} A${R},${R} 0 0,0 ${x2},${y2}" fill="none" stroke="${col}" stroke-width="${STROKE}" stroke-linecap="butt"/>`;
  }).join("");

  // Weiße Trennlinien bei 0 / 25 / 50 / 75 / 100
  const ticks = [0, 25, 50, 75, 100].map((s) => {
    const a = Math.PI * (1 - s / 100);
    const r1 = R - STROKE / 2, r2 = R + STROKE / 2;
    return `<line x1="${(CX + r1 * Math.cos(a)).toFixed(1)}" y1="${(CY - r1 * Math.sin(a)).toFixed(1)}" x2="${(CX + r2 * Math.cos(a)).toFixed(1)}" y2="${(CY - r2 * Math.sin(a)).toFixed(1)}" stroke="white" stroke-width="2.5"/>`;
  }).join("");

  // Kategorie-Labels direkt auf dem Arc (weiß auf farbigem Hintergrund)
  const catLabels = [
    { pct: 12.5, lines: ["Ext.", "Angst"] },
    { pct: 35,   lines: ["Angst"] },
    { pct: 50,   lines: ["Neutral"] },
    { pct: 65,   lines: ["Gier"] },
    { pct: 87.5, lines: ["Ext.", "Gier"] },
  ].map(({ pct, lines }) => {
    const a  = Math.PI * (1 - pct / 100);
    const lx = (CX + R * Math.cos(a)).toFixed(1);
    const ly = (CY - R * Math.sin(a)).toFixed(1);
    const tspans = lines.length === 1
      ? `<tspan x="${lx}" y="${ly}" dominant-baseline="middle">${lines[0]}</tspan>`
      : `<tspan x="${lx}" y="${(parseFloat(ly) - 4).toFixed(1)}">${lines[0]}</tspan><tspan x="${lx}" dy="9">${lines[1]}</tspan>`;
    return `<text text-anchor="middle" font-size="7.5" fill="white" font-family="Arial,sans-serif" font-weight="700">${tspans}</text>`;
  }).join("");

  // Zeiger — korrekte Mathematik
  // score=0→angle=PI(links), score=50→angle=PI/2(oben), score=100→angle=0(rechts)
  const needleAngle = Math.PI * (1 - score / 100);
  const nLen = R - STROKE / 2 - 6;
  const nx = (CX + nLen * Math.cos(needleAngle)).toFixed(2);
  const ny = (CY - nLen * Math.sin(needleAngle)).toFixed(2);

  const needle = `
    <line x1="${CX}" y1="${CY}" x2="${nx}" y2="${ny}" stroke="#111" stroke-width="3.5" stroke-linecap="round"/>
    <circle cx="${CX}" cy="${CY}" r="9" fill="#111"/>
    <circle cx="${CX}" cy="${CY}" r="4.5" fill="white"/>`;

  // Score mittig im Bogen — Rating als HTML unter dem SVG (nie vom Zeiger verdeckt)
  const centerText = `
    <text x="${CX}" y="${(CY - 16).toFixed(1)}" text-anchor="middle" font-size="42" font-weight="900" fill="${scoreCol}" font-family="Arial,sans-serif">${score}</text>`;

  const gaugeSvg = `
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" style="display:block;width:100%;max-width:${W}px">
      ${arcSegs}
      ${ticks}
      ${catLabels}
      ${needle}
      ${centerText}
    </svg>
    <div style="text-align:center;margin-top:6px;font-size:13px;font-weight:800;letter-spacing:1.5px;color:${scoreCol};text-transform:uppercase">${fg.rating}</div>`;

  // Verlaufs-Tabelle rechts
  const delta1d = score - fg.prev_close;
  const delta1w = score - fg.prev_1week;
  const fmtD    = (d) => `${d >= 0 ? "+" : ""}${d}`;
  const dCol    = (d) => d > 3 ? "#16a34a" : d < -3 ? "#dc2626" : "#6b7280";

  return `
  <div style="margin-top:16px;padding-top:14px;border-top:1px solid #e5e7eb">
    <div style="font-size:10px;text-transform:uppercase;color:#9ca3af;letter-spacing:.05em;font-weight:600;margin-bottom:10px">😨 Fear &amp; Greed Index (CNN Markets)${fg.fetched_at ? ` &nbsp;·&nbsp; <span style="text-transform:none;font-weight:400">${new Date(fg.fetched_at).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}</span>` : ""}</div>
    <div style="display:flex;align-items:flex-start;gap:20px;flex-wrap:wrap">
      ${gaugeSvg}
      <div style="flex:1;min-width:130px;padding-top:20px">
        <table style="font-size:12px;border-collapse:collapse;width:100%">
          <tr style="border-bottom:1px solid #f3f4f6">
            <td style="padding:5px 10px 5px 0;color:#6b7280">Gestern</td>
            <td style="font-weight:700;color:${dCol(delta1d)}">${fg.prev_close} <span style="font-size:10px;font-weight:400">(${fmtD(delta1d)})</span></td>
          </tr>
          <tr style="border-bottom:1px solid #f3f4f6">
            <td style="padding:5px 10px 5px 0;color:#6b7280">1 Woche</td>
            <td style="font-weight:700;color:${dCol(delta1w)}">${fg.prev_1week} <span style="font-size:10px;font-weight:400">(${fmtD(delta1w)})</span></td>
          </tr>
          <tr>
            <td style="padding:5px 10px 5px 0;color:#6b7280">1 Monat</td>
            <td style="font-weight:600;color:#374151">${fg.prev_1month}</td>
          </tr>
        </table>
      </div>
    </div>
  </div>`;
}

// ── Buffett-Indikator HTML ────────────────────────────────────────────────────

function formatBuffettHtml(buffett) {
  if (!buffett) return "";

  const { ratio, mcap_bn, gdp_bn, mcap_date, gdp_date } = buffett;

  // Zonen dynamisch aus exponentieller Regression + absoluter SD (konsistent mit currentmarketvaluation.com)
  const T = buffett.trend ?? 147;
  const SD = buffett.sd_abs ?? 27;
  const b1lo = Math.round(T - SD);
  const b1hi = Math.round(T + SD);
  const b2lo = Math.round(T - 2 * SD);
  const b2hi = Math.round(T + 2 * SD);
  const zones = [
    { label: "Stark unterbewertet", range: `< ${b2lo}%`,        min: 0,    max: b2lo,    bg: "#052e16", text: "#d1fae5", border: "#16a34a" },
    { label: "Unterbewertet",       range: `${b2lo}–${b1lo}%`,  min: b2lo, max: b1lo,    bg: "#d1fae5", text: "#065f46", border: "#34d399" },
    { label: "Fair bewertet",       range: `${b1lo}–${b1hi}%`,  min: b1lo, max: b1hi,    bg: "#ecfdf5", text: "#065f46", border: "#6ee7b7" },
    { label: "Überbewertet",        range: `${b1hi}–${b2hi}%`,  min: b1hi, max: b2hi,    bg: "#fed7aa", text: "#9a3412", border: "#f97316" },
    { label: "Stark überbewertet",  range: `> ${b2hi}%`,         min: b2hi, max: Infinity, bg: "#fecaca", text: "#7f1d1d", border: "#ef4444" },
  ];

  const zone    = zones.find((z) => ratio >= z.min && ratio < z.max) ?? zones[zones.length - 1];
  const ratioStr = ratio.toFixed(1) + "%";
  // W5000 Index-Wert ≈ Mrd. USD Marktkapitalisierung → in Bio. USD umrechnen für Anzeige
  const mcapStr  = mcap_bn >= 1000
    ? `${(mcap_bn / 1000).toFixed(1)} Bio. USD`
    : `${mcap_bn.toFixed(0)} Mrd. USD`;
  // GDP von FRED ist in Mrd. USD (SAAR)
  const gdpStr   = gdp_bn >= 1000
    ? `${(gdp_bn / 1000).toFixed(1)} Bio. USD`
    : `${gdp_bn.toFixed(0)} Mrd. USD`;

  // Balken: Skala dynamisch, 20% Puffer über 2-SD-Grenze
  const BAR_MAX  = Math.round(b2hi * 1.2 / 10) * 10;
  const barPct   = Math.min((ratio / BAR_MAX) * 100, 100).toFixed(1);

  const chips = zones.map((z) => {
    const active = ratio >= z.min && ratio < z.max;
    return `<span style="display:inline-block;background:${z.bg};color:${z.text};border:${active ? `2px solid ${z.border}` : "2px solid transparent"};border-radius:3px;padding:1px 4px;font-size:8px;font-weight:${active ? "800" : "600"};white-space:nowrap;opacity:${active ? "1" : ".5"}">${z.label}</span>`;
  }).join("&nbsp;");

  return `
  <div style="margin-top:16px;padding-top:14px;border-top:1px solid #e5e7eb">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;flex-wrap:wrap;gap:4px">
      <span style="font-size:10px;text-transform:uppercase;color:#9ca3af;letter-spacing:.05em;font-weight:600">📊 Buffett-Indikator &nbsp;·&nbsp; Marktkapitalisierung / BIP</span>
      <span style="background:${zone.bg};color:${zone.text};border:1.5px solid ${zone.border};border-radius:4px;padding:2px 9px;font-size:10.5px;font-weight:800">${zone.label}</span>
    </div>

    <div style="display:flex;align-items:center;gap:14px;margin-bottom:10px">
      <div style="background:${zone.bg};color:${zone.text};border:1.5px solid ${zone.border};border-radius:8px;padding:6px 14px;font-size:30px;font-weight:900;letter-spacing:-1px;white-space:nowrap">${ratioStr}</div>
      <div style="font-size:11px;color:#6b7280;line-height:1.7">
        <div>🏦 Marktkapitalisierung (Wilshire 5000): <strong style="color:#374151">${mcapStr}</strong> <span style="font-size:9px">(${mcap_date})</span></div>
        <div>🏛 Nominales BIP (SAAR): <strong style="color:#374151">${gdpStr}</strong> <span style="font-size:9px">(${gdp_date})</span></div>
      </div>
    </div>

    <!-- Gauge-Balken mit dynamischen Zonen -->
    <div style="background:#f3f4f6;border-radius:4px;height:10px;overflow:hidden;margin-bottom:3px;position:relative">
      <div style="position:absolute;left:0;top:0;height:100%;width:${(b2lo/BAR_MAX*100).toFixed(0)}%;background:#16a34a"></div>
      <div style="position:absolute;left:${(b2lo/BAR_MAX*100).toFixed(0)}%;top:0;height:100%;width:${((b1lo-b2lo)/BAR_MAX*100).toFixed(0)}%;background:#34d399"></div>
      <div style="position:absolute;left:${(b1lo/BAR_MAX*100).toFixed(0)}%;top:0;height:100%;width:${((b1hi-b1lo)/BAR_MAX*100).toFixed(0)}%;background:#6ee7b7"></div>
      <div style="position:absolute;left:${(b1hi/BAR_MAX*100).toFixed(0)}%;top:0;height:100%;width:${((b2hi-b1hi)/BAR_MAX*100).toFixed(0)}%;background:#f97316"></div>
      <div style="position:absolute;left:${(b2hi/BAR_MAX*100).toFixed(0)}%;top:0;height:100%;width:${(100-(b2hi/BAR_MAX*100)).toFixed(0)}%;background:#ef4444"></div>
      <div style="position:absolute;left:${barPct}%;top:-1px;width:3px;height:12px;background:#1f2937;border-radius:2px;transform:translateX(-50%)"></div>
    </div>
    <div style="display:flex;font-size:8px;color:#9ca3af;margin-bottom:7px">
      <span style="width:${(b2lo/BAR_MAX*100).toFixed(0)}%;text-align:center">&lt;${b2lo}%</span>
      <span style="width:${((b1lo-b2lo)/BAR_MAX*100).toFixed(0)}%;text-align:center">${b2lo}–${b1lo}%</span>
      <span style="width:${((b1hi-b1lo)/BAR_MAX*100).toFixed(0)}%;text-align:center">${b1lo}–${b1hi}%</span>
      <span style="width:${((b2hi-b1hi)/BAR_MAX*100).toFixed(0)}%;text-align:center">${b1hi}–${b2hi}%</span>
      <span style="flex:1;text-align:center">&gt;${b2hi}%</span>
    </div>

    <!-- Zone-Chips -->
    <div style="display:flex;flex-wrap:nowrap;gap:3px;overflow:hidden">${chips}</div>
  </div>`;
}

export function formatMarketHtml(market) {
  if (!market?.regime) return "";

  const { regime, indices, vix } = market;

  // Regime-Farbe → Hintergrund
  const bgMap = {
    CONFIRMED_UPTREND:      { bg: "#f0fdf4", border: "#86efac", text: "#15803d" },
    UPTREND_UNDER_PRESSURE: { bg: "#fefce8", border: "#fde047", text: "#854d0e" },
    RALLY_ATTEMPT:          { bg: "#fff7ed", border: "#fdba74", text: "#9a3412" },
    DOWNTREND:              { bg: "#fef2f2", border: "#fca5a5", text: "#991b1b" },
    EXTREME_FEAR:           { bg: "#fef2f2", border: "#ef4444", text: "#7f1d1d" },
    UNKNOWN:                { bg: "#f9fafb", border: "#d1d5db", text: "#6b7280" },
  };
  const col = bgMap[regime.signal] || bgMap.UNKNOWN;

  // Index-Zeilen
  const indexRows = (indices || []).map((idx) => {
    const changeColor = (idx.change ?? 0) >= 0 ? "#16a34a" : "#dc2626";
    const changeArrow = (idx.change ?? 0) >= 0 ? "▲" : "▼";
    const changeStr   = idx.change !== null ? `${changeArrow} ${Math.abs(idx.change).toFixed(2)}%` : "–";

    // MA-Ampel
    const dot = (ok) => ok === null ? `<span style="color:#9ca3af">●</span>`
      : ok ? `<span style="color:#16a34a">●</span>`
           : `<span style="color:#dc2626">●</span>`;

    const pct1m = idx.perf1m !== null ? `${idx.perf1m > 0 ? "+" : ""}${idx.perf1m.toFixed(1)}%` : "–";
    const pct3m = idx.perf3m !== null ? `${idx.perf3m > 0 ? "+" : ""}${idx.perf3m.toFixed(1)}%` : "–";

    return `<tr>
      <td style="padding:6px 8px;font-weight:700;white-space:nowrap;font-size:13px">${idx.flag} ${idx.short}</td>
      <td style="padding:6px 8px;text-align:right;font-weight:600;font-size:13px;white-space:nowrap">${idx.close !== null ? idx.close.toLocaleString("de-DE", {maximumFractionDigits: 2}) : "–"}</td>
      <td style="padding:6px 8px;text-align:right;color:${changeColor};font-weight:600;font-size:12px;white-space:nowrap">${changeStr}</td>
      <td style="padding:6px 8px;text-align:center;font-size:13px;letter-spacing:2px">${dot(idx.aboveEma50)}${dot(idx.aboveSma150)}${dot(idx.aboveSma200)}</td>
      <td style="padding:6px 8px;text-align:right;font-size:12px;color:#6b7280;white-space:nowrap">${pct1m}</td>
      <td style="padding:6px 8px;text-align:right;font-size:12px;color:#6b7280;white-space:nowrap">${pct3m}</td>
    </tr>`;
  }).join("\n");

  const vixDisplay = vix?.close != null ? vix.close.toFixed(1) : "–";
  const vixColor   = !vix?.close ? "#6b7280"
    : vix.close < 15 ? "#16a34a"
    : vix.close < 25 ? "#d97706"
    : vix.close < 35 ? "#dc2626"
    : "#7f1d1d";

  // VIX-Zonen als Chips: aktive Zone hervorgehoben, inaktive gedimmt
  const vixZones = [
    { label: "😊 Gier",   range: "< 15",   active: vix?.close < 15,               bg: "#d1fae5", border: "#34d399", text: "#065f46" },
    { label: "😐 Normal", range: "15–25",  active: vix?.close >= 15 && vix?.close < 25, bg: "#fef9c3", border: "#fbbf24", text: "#854d0e" },
    { label: "😰 Angst",  range: "25–35",  active: vix?.close >= 25 && vix?.close < 35, bg: "#fed7aa", border: "#f97316", text: "#9a3412" },
    { label: "🚨 Panik",  range: "> 35",   active: vix?.close >= 35,              bg: "#fecaca", border: "#ef4444", text: "#7f1d1d" },
  ];
  const vixChips = vixZones.map((z) =>
    `<span style="display:inline-block;background:${z.bg};color:${z.text};border:${z.active ? `2px solid ${z.border}` : "2px solid transparent"};border-radius:4px;padding:2px 6px;font-size:10px;font-weight:${z.active ? "800" : "600"};white-space:nowrap;opacity:${z.active ? "1" : ".55"}">${z.label} <span style="font-weight:400">${z.range}</span></span>`
  ).join("&nbsp;");

  return `
  <div style="background:${col.bg};border:1.5px solid ${col.border};border-radius:8px;padding:16px 18px;margin-bottom:16px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
      <span style="font-size:22px">${regime.color}</span>
      <div>
        <div style="font-size:15px;font-weight:800;color:${col.text};letter-spacing:.03em">${regime.label}</div>
        <div style="font-size:12px;color:${col.text};opacity:.85;margin-top:2px">${regime.description}</div>
      </div>
    </div>
    <div style="background:rgba(0,0,0,.04);border-radius:5px;padding:7px 10px;font-size:11px;font-weight:700;color:${col.text};letter-spacing:.04em">
      📌 ${regime.action}
    </div>
  </div>

  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr>
      <th style="padding:6px 8px;text-align:left;font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;border-bottom:2px solid #e5e7eb;background:#f9fafb">Index</th>
      <th style="padding:6px 8px;text-align:right;font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;border-bottom:2px solid #e5e7eb;background:#f9fafb">Kurs</th>
      <th style="padding:6px 8px;text-align:right;font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;border-bottom:2px solid #e5e7eb;background:#f9fafb">Tag</th>
      <th style="padding:6px 8px;text-align:center;font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;border-bottom:2px solid #e5e7eb;background:#f9fafb" title="MA50 · MA150 · MA200">MA50·150·200</th>
      <th style="padding:6px 8px;text-align:right;font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;border-bottom:2px solid #e5e7eb;background:#f9fafb">1M %</th>
      <th style="padding:6px 8px;text-align:right;font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;border-bottom:2px solid #e5e7eb;background:#f9fafb">3M %</th>
    </tr></thead>
    <tbody>${indexRows}
      <tr style="border-top:1px solid #e5e7eb">
        <td style="padding:6px 8px;font-weight:700;font-size:13px;white-space:nowrap">${vixZones.find((z) => z.active)?.label.split(" ")[0] ?? "😨"} VIX</td>
        <td style="padding:6px 8px;text-align:right;font-weight:800;font-size:14px;color:${vixColor};white-space:nowrap">${vixDisplay}</td>
        <td colspan="4" style="padding:5px 8px">${vixChips}</td>
      </tr>
    </tbody>
  </table>
  <p style="font-size:10px;color:#9ca3af;margin-top:6px">● MA50 &nbsp;● MA150 &nbsp;● MA200 — grün = Kurs darüber, rot = darunter</p>

  ${formatPreMarketHtml(market.premarket)}
  ${formatBuffettHtml(market.buffett)}
  ${formatVixTermStructure(market.vix_term_structure)}
  ${formatFearGreed(market.fear_greed)}
  ${formatSectorHeatmapHtml(market.sectors)}`;
}
