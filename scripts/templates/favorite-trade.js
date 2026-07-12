import { esc } from "./helpers.js";

// Auto-extracted aus daily-brief-email.js — Lieblingstrade-Block

export function formatFavoriteTradeHtml(ft) {
  if (!ft?.success || !ft.candidate || !ft.setup) {
    return "";
  }

  const { candidate, setup, comment, screenshotBase64, voigt, positionSizing } = ft;
  const ticker = candidate.symbol.includes(":") ? candidate.symbol.split(":").pop() : candidate.symbol;
  const stars  = "⭐".repeat(candidate.stars ?? 0) + "☆".repeat(5 - (candidate.stars ?? 0));

  const riskPct  = ((setup.risk / setup.entry) * 100).toFixed(1);
  const gainPct  = ((setup.target - setup.entry) / setup.entry * 100).toFixed(1);

  // Positionsgrößen-Anzeige (1% Risiko-Regel)
  const ps = positionSizing ?? null;

  const imgHtml = screenshotBase64
    ? `<img src="cid:favtrade_chart" style="width:100%;border-radius:6px;margin:12px 0;display:block" alt="Chart ${ticker}">`
    : `<div style="background:#f3f4f6;border-radius:6px;padding:20px;text-align:center;color:#9ca3af;font-size:12px;margin:12px 0">📷 Chart nicht verfügbar</div>`;

  return `
  <div style="border-top:3px solid #1d4ed8;margin-top:0;padding-top:0">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#1e3a5f 0%,#1d4ed8 100%);border-radius:8px 8px 0 0;padding:14px 16px;color:white;margin:-1px -1px 0">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;opacity:.75;margin-bottom:4px">🤖 Mein Lieblingstrade heute</div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
        <div>
          <span style="font-size:22px;font-weight:900">${ticker}</span>
          ${candidate.name ? `<span style="font-size:13px;opacity:.8;margin-left:8px">${esc(candidate.name)}</span>` : ""}
        </div>
        <div style="font-size:16px;letter-spacing:-1px">${stars}</div>
      </div>
    </div>

    <!-- Setup-Karten -->
    <div style="display:flex;gap:8px;margin:12px 0;flex-wrap:wrap">
      <div style="flex:1;min-width:80px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:8px 10px;text-align:center">
        <div style="font-size:9px;text-transform:uppercase;color:#15803d;font-weight:700;letter-spacing:.05em">Entry</div>
        <div style="font-size:16px;font-weight:800;color:#15803d">${setup.entry.toFixed(2)}</div>
      </div>
      <div style="flex:1;min-width:80px;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:8px 10px;text-align:center">
        <div style="font-size:9px;text-transform:uppercase;color:#dc2626;font-weight:700;letter-spacing:.05em">Stop</div>
        <div style="font-size:16px;font-weight:800;color:#dc2626">${setup.stop.toFixed(2)}</div>
        <div style="font-size:10px;color:#dc2626;opacity:.75">−${riskPct}%${setup.source === "voigt" && setup.correctionLow ? ` · SW-Tief ${setup.correctionLow.toFixed(2)}` : ""}</div>
      </div>
      <div style="flex:1;min-width:80px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:8px 10px;text-align:center">
        <div style="font-size:9px;text-transform:uppercase;color:#1d4ed8;font-weight:700;letter-spacing:.05em">Ziel</div>
        <div style="font-size:16px;font-weight:800;color:#1d4ed8">${setup.target.toFixed(2)}</div>
        <div style="font-size:10px;color:#1d4ed8;opacity:.75">+${gainPct}%${
          setup.source === "voigt" && setup.targetSource
            ? ` · ${setup.targetSource === "measured_move" ? "Measured Move" : setup.targetSource === "swing_high" ? "SW-High" : `min ${setup.minCrv}:1`}`
            : ""
        }</div>
      </div>
      <div style="flex:1;min-width:80px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:8px 10px;text-align:center">
        <div style="font-size:9px;text-transform:uppercase;color:#374151;font-weight:700;letter-spacing:.05em">CRV</div>
        <div style="font-size:16px;font-weight:800;color:#374151">${((setup.target - setup.entry) / setup.risk).toFixed(1)}:1</div>
        <div style="font-size:10px;color:#6b7280">${
          setup.source === "voigt"
            ? `📐 Voigt Qual.${setup.setupQuality} (min ${setup.minCrv}:1)`
            : setup.source === "pine"
              ? "📌 Pine-Level"
              : `ATR ${setup.atr?.toFixed(2)}`
        }</div>
      </div>
      ${ps ? `
      <div style="flex:1;min-width:80px;background:#faf5ff;border:1px solid #e9d5ff;border-radius:6px;padding:8px 10px;text-align:center">
        <div style="font-size:9px;text-transform:uppercase;color:#7c3aed;font-weight:700;letter-spacing:.05em">Position</div>
        <div style="font-size:16px;font-weight:800;color:#7c3aed">${ps.shares} Stk.</div>
        <div style="font-size:10px;color:#7c3aed;opacity:.8">€${ps.positionValue.toFixed(0)} · ${ps.positionPct}%</div>
        <div style="font-size:9px;color:${ps.riskExceeded ? "#dc2626" : "#9ca3af"};margin-top:2px;font-weight:${ps.riskExceeded ? "700" : "400"}">max. −€${ps.maxLoss.toFixed(0)} (${ps.riskPct}%)${ps.riskExceeded ? " ⚠️ über 1%-Budget" : ""}</div>
      </div>` : ""}
    </div>

    <!-- Chart Screenshot -->
    ${imgHtml}

    <!-- Voigt Swing Analyse Badge -->
    ${voigt ? (() => {
      const v = voigt;
      const regimeEmoji = v.weeklyRegime === "GRÜN" ? "🟢" : v.weeklyRegime === "GELB" ? "🟡" : "🔴";
      const qualColor   = v.setupQuality === "A" ? "#15803d" : v.setupQuality === "B" ? "#b45309" : "#dc2626";
      const qualBg      = v.setupQuality === "A" ? "#f0fdf4" : v.setupQuality === "B" ? "#fffbeb" : "#fef2f2";
      const corrTxt     = v.correction.durationStatus === "ok"
        ? `${v.correction.duration}T ✓`
        : `${v.correction.duration}T (${v.correction.durationStatus})`;
      const volTxt      = v.correction.volDecreasing ? "Vol↓ ✓" : "Vol↑ ✗";
      const trendTxt    = v.hasTrend ? "HH+HL ✓" : "kein HH/HL ✗";
      return `
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0;padding:8px 10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px">
      <div style="font-size:10px;text-transform:uppercase;color:#64748b;font-weight:700;letter-spacing:.05em;white-space:nowrap">📐 Voigt</div>
      <span style="font-size:13px;font-weight:800">${regimeEmoji} ${v.weeklyRegime}</span>
      <span style="background:${qualBg};color:${qualColor};font-size:11px;font-weight:700;padding:2px 7px;border-radius:4px;border:1px solid ${qualColor}40">Qual.${v.setupQuality}</span>
      <span style="font-size:11px;color:#374151">${trendTxt}</span>
      <span style="font-size:11px;color:#374151">Korr. ${corrTxt} · ${volTxt}</span>
      ${v.setupActive
        ? `<span style="background:#dcfce7;color:#15803d;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px">✅ Setup aktiv</span>`
        : `<span style="background:#f3f4f6;color:#6b7280;font-size:10px;font-weight:600;padding:2px 7px;border-radius:4px">⏳ Warten</span>`}
    </div>`;
    })() : ""}

    <!-- Claude-Kommentar -->
    ${comment ? `
    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:10px 12px;margin-top:4px">
      <div style="font-size:10px;text-transform:uppercase;color:#92400e;font-weight:700;letter-spacing:.05em;margin-bottom:5px">🤖 Meine Einschätzung</div>
      <div style="font-size:12px;color:#1f2937;line-height:1.7">${esc(comment).replace(/\n/g, "<br>")}</div>
    </div>` : ""}

    <div style="font-size:10px;color:#9ca3af;margin-top:8px;font-style:italic">
      Kein Anlageberatung · ATR-basiertes Setup · Stops immer respektieren.
    </div>
  </div>`;
}
