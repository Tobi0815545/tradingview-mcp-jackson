#!/usr/bin/env node
/**
 * daily-brief-email.js
 * Runs the CANSLIM morning/daily brief and sends it as HTML email via Gmail.
 *
 * Modes (via --mode=<mode>):
 *   morning   — 08:00 Uhr: Pre-Market, Markt-Regime, Watchlist (kein Opening Bell)
 *   daily     — 16:00 Uhr: Opening Bell + vollständiges Briefing
 *   ob-update — 17:30 Uhr: Sendet Update-Mail wenn Opening Bell nachgeladen
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import nodemailer from "nodemailer";
import { runBrief } from "../src/core/morning.js";
import { runScan } from "../src/core/scanner.js";
import { runMarketCheck, fetchWeeklyPerformance, fetchWatchlistStage2, fetchWatchlistRsi } from "../src/core/market.js";
import { runOpeningBell } from "../src/core/opening-bell.js";
import { fetchCalendar } from "../src/core/calendar.js";
import { fetchWatchlistNews } from "../src/core/news.js";

// ── Modus erkennen ───────────────────────────────────────────────────────────

const modeArg = process.argv.find((a) => a.startsWith("--mode="));
// Einmaliger Versand um 16:00 Uhr — kein Morgen-Modus mehr.
// --mode=ob-update bleibt für den 17:30-Retry (Opening Bell Nachlieferung).
const MODE = modeArg ? modeArg.split("=")[1] : "daily";

const OB_STATE_FILE = "/tmp/.brief-ob-state.json";

// ── TradingView Auto-Start ───────────────────────────────────────────────────

const TV_BINARY = "/Applications/TradingView.app/Contents/MacOS/TradingView";
const CDP_URL   = "http://127.0.0.1:9222/json/version";

async function isCdpAlive() {
  try {
    const res = await fetch(CDP_URL, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureTradingViewRunning() {
  if (await isCdpAlive()) {
    console.log("✅ TradingView läuft bereits (CDP aktiv).");
    await waitForUiReady();
    return;
  }

  console.log("🚀 TradingView nicht gefunden — starte mit CDP…");

  // Bestehende Instanz ohne CDP beenden
  try {
    const kill = spawn("pkill", ["-f", "TradingView"], { stdio: "ignore" });
    await new Promise((r) => kill.on("close", r));
    await new Promise((r) => setTimeout(r, 2000));
  } catch {}

  // TradingView mit CDP starten
  const tv = spawn(TV_BINARY, ["--remote-debugging-port=9222"], {
    detached: true,
    stdio: "ignore",
  });
  tv.unref();

  // Warten bis CDP antwortet (max. 60 Sekunden)
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await isCdpAlive()) {
      console.log("\n✅ TradingView gestartet und CDP bereit.");
      // Warten bis die Chart-UI vollständig geladen ist (Watchlist-Button muss sichtbar sein)
      console.log("⏳ Warte auf vollständiges UI-Laden…");
      await waitForUiReady();
      return;
    }
    process.stdout.write(".");
  }
  throw new Error("TradingView hat CDP nach 60 Sekunden nicht geöffnet.");
}

/** Wartet bis der Watchlist-Button im DOM sichtbar ist (max. 45s). */
async function waitForUiReady(maxMs = 45_000) {
  const { default: CDP } = await import("chrome-remote-interface");
  const deadline = Date.now() + maxMs;
  let client;
  try {
    while (Date.now() < deadline) {
      try {
        if (!client) client = await CDP({ port: 9222 });
        const { result } = await client.Runtime.evaluate({
          expression: `!!document.querySelector('[data-name="watchlists-button"]')`,
          returnByValue: true,
        });
        if (result?.value === true) {
          console.log("✅ UI bereit (Watchlist-Button gefunden).");
          // Noch 2s warten für Animationen
          await new Promise((r) => setTimeout(r, 2000));
          return;
        }
      } catch { /* CDP nicht bereit oder DOM noch nicht geladen */ }
      process.stdout.write("·");
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.warn("\n⚠️  UI-Button nach 45s nicht gefunden — fahre trotzdem fort.");
  } finally {
    try { await client?.close(); } catch {}
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// .env manuell laden
const envPath = resolve(ROOT, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

const GMAIL_USER   = process.env.GMAIL_USER;
const GMAIL_APP_PW = process.env.GMAIL_APP_PASSWORD;
const RECIPIENT    = process.env.BRIEF_RECIPIENT || "willems.robert@gmail.com";

if (!GMAIL_USER || !GMAIL_APP_PW) {
  console.error("❌ .env fehlt oder GMAIL_USER/GMAIL_APP_PASSWORD nicht gesetzt.");
  process.exit(1);
}

// ── HTML formatieren ─────────────────────────────────────────────────────────

function trend(changePct) {
  const n = parseFloat(String(changePct).replace(",", ".").replace("%", ""));
  if (isNaN(n)) return "–";
  const color = n >= 0 ? "#16a34a" : "#dc2626";
  const arrow = n >= 0 ? "▲" : "▼";
  // Ensure % sign is always shown
  const display = String(changePct).includes("%") ? changePct : `${n.toFixed(2)}%`;
  return `<span style="color:${color}">${arrow} ${display}</span>`;
}

// Parse volume strings like "776.37K", "1.46M", "2.3B", "2,62K" → absolute number
// Handles European decimal comma: "2,62K" → 2620, not 262000
function parseVolume(val) {
  if (typeof val === "number") return val;
  const s = String(val ?? "").trim();
  // Replace comma decimal separator with dot BEFORE stripping non-numeric chars
  const normalized = s.replace(",", ".");
  const n = parseFloat(normalized.replace(/[^0-9.]/g, ""));
  if (isNaN(n)) return 0;
  if (/K/i.test(s)) return n * 1_000;
  if (/M/i.test(s)) return n * 1_000_000;
  if (/B/i.test(s)) return n * 1_000_000_000;
  return n;
}

function stars(changePct) {
  const n = parseFloat(String(changePct).replace(",", ".").replace("%", ""));
  if (isNaN(n)) return "⭐";
  if (n >= 10) return "⭐⭐⭐⭐⭐";
  if (n >= 5)  return "⭐⭐⭐⭐";
  if (n >= 0)  return "⭐⭐⭐";
  if (n >= -15) return "⭐⭐";
  return "⭐";
}

// ── RS-Trend State (Wöchentlicher Vergleich) ─────────────────────────────────

const RS_STATE_FILE = "/tmp/.brief-rs-history.json";

function loadRsHistory() {
  try {
    if (existsSync(RS_STATE_FILE)) return JSON.parse(readFileSync(RS_STATE_FILE, "utf8"));
  } catch {}
  return null;
}

function saveRsHistory(rsMap) {
  try {
    const today = new Date().toISOString().split("T")[0];
    writeFileSync(RS_STATE_FILE, JSON.stringify({ date: today, rs: Object.fromEntries(rsMap) }));
  } catch {}
}

/** Gibt ↑ ↓ oder → zurück basierend auf Δ RS */
function rsTrend(currentRs, history, symbol) {
  if (!history) return "";
  const old = history.rs?.[symbol];
  if (old == null || currentRs == null || isNaN(currentRs)) return "";
  const delta = currentRs - old;
  if (delta > 0.3)  return `<span style="color:#16a34a;font-size:10px" title="RS +${delta.toFixed(1)} vs. letzte Woche">↑</span>`;
  if (delta < -0.3) return `<span style="color:#dc2626;font-size:10px" title="RS ${delta.toFixed(1)} vs. letzte Woche">↓</span>`;
  return `<span style="color:#9ca3af;font-size:10px" title="RS stabil">→</span>`;
}

// ── Pre-Market HTML ───────────────────────────────────────────────────────────

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

function formatSectorHeatmapHtml(sectors) {
  if (!sectors?.length) return "";

  // Bereits von fetchSectorPerformance() absteigend sortiert
  const sorted = sectors;

  // Farb-Mapping für Heatmap-Zellen — 7 Stufen je Seite für klare Abstufung
  const heatColor = (pct) => {
    if (pct == null) return { bg: "#f9fafb", text: "#6b7280" };
    if (pct >=  7)   return { bg: "#052e16", text: "#d1fae5" }; // extrem stark grün
    if (pct >=  4)   return { bg: "#14532d", text: "#bbf7d0" }; // sehr stark grün
    if (pct >=  2)   return { bg: "#15803d", text: "#fff"    }; // stark grün
    if (pct >=  1)   return { bg: "#16a34a", text: "#fff"    }; // mittel grün
    if (pct >=  0.3) return { bg: "#86efac", text: "#14532d" }; // leicht grün
    if (pct > -0.3)  return { bg: "#f3f4f6", text: "#374151" }; // neutral
    if (pct >= -1)   return { bg: "#fecaca", text: "#7f1d1d" }; // leicht rot
    if (pct >= -2)   return { bg: "#f87171", text: "#fff"    }; // mittel rot
    if (pct >= -4)   return { bg: "#dc2626", text: "#fff"    }; // stark rot
    if (pct >= -7)   return { bg: "#991b1b", text: "#fff"    }; // sehr stark rot
    return                   { bg: "#7f1d1d", text: "#fecaca" }; // extrem rot
  };

  // 2 Reihen: max 6 Sektoren pro Zeile — kein horizontaler Überlauf
  const row1 = sorted.slice(0, 6);
  const row2 = sorted.slice(6);

  const renderRow = (items) => items.map((s) => {
    const wStr = s.perf_week != null ? `${s.perf_week >= 0 ? "+" : ""}${s.perf_week.toFixed(1)}%` : "–";
    const dStr = s.perf_day  != null ? `${s.perf_day  >= 0 ? "+" : ""}${s.perf_day.toFixed(1)}%`  : null;
    const { bg, text } = heatColor(s.perf_week);
    // Tages-Farbe für kleinen Badge
    const dayColor = s.perf_day == null ? "#9ca3af"
      : s.perf_day >= 0.3 ? "#16a34a"
      : s.perf_day <= -0.3 ? "#dc2626"
      : "#6b7280";
    return `<td style="padding:3px 2px;text-align:center;width:${(100/6).toFixed(2)}%">
      <div style="background:${bg};color:${text};border-radius:5px;padding:5px 2px 4px">
        <div style="font-size:12px">${s.icon}</div>
        <div style="font-size:7.5px;margin-bottom:2px;white-space:nowrap;opacity:.85;font-weight:600">${s.label}</div>
        <div style="font-size:11px;font-weight:800;line-height:1.2">${wStr}</div>
        ${dStr != null
          ? `<div style="font-size:9px;font-weight:600;color:${s.perf_week != null && Math.abs(s.perf_week) < 3 ? dayColor : "inherit"};opacity:.8;line-height:1.3">${dStr}</div>`
          : `<div style="font-size:8px;opacity:.4;line-height:1.3">Tag –</div>`}
      </div>
    </td>`;
  }).join("");

  return `
  <div style="margin-top:16px;padding-top:14px;border-top:1px solid #e5e7eb">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:7px">
      <div style="font-size:10px;text-transform:uppercase;color:#9ca3af;letter-spacing:.05em;font-weight:600">
        🗺 Sektor-Performance (S&amp;P 500)
      </div>
      <div style="display:flex;gap:5px;font-size:9px;align-items:center">
        <span style="background:#14532d;color:#fff;border-radius:3px;padding:1px 5px;font-weight:700">&gt;4%</span>
        <span style="background:#16a34a;color:#fff;border-radius:3px;padding:1px 5px;font-weight:700">1–4%</span>
        <span style="background:#86efac;color:#14532d;border-radius:3px;padding:1px 5px;font-weight:700">0–1%</span>
        <span style="background:#f3f4f6;color:#374151;border-radius:3px;padding:1px 5px;font-weight:700">±0</span>
        <span style="background:#f87171;color:#fff;border-radius:3px;padding:1px 5px;font-weight:700">-1–4%</span>
        <span style="background:#991b1b;color:#fff;border-radius:3px;padding:1px 5px;font-weight:700">&lt;-4%</span>
      </div>
    </div>
    <div style="font-size:9px;color:#9ca3af;margin-bottom:5px">Groß = Woche &nbsp;·&nbsp; Klein = Heute</div>
    <table style="width:100%;border-collapse:separate;border-spacing:2px 3px">
      <tr>${renderRow(row1)}</tr>
      ${row2.length ? `<tr>${renderRow(row2)}</tr>` : ""}
    </table>
  </div>`;
}

// ── Wochenrückblick HTML (Freitags) ──────────────────────────────────────────

function formatWochenruckblickHtml(symbols, weeklyPerfMap) {
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
        <td style="padding:5px 8px;color:#6b7280;font-size:11px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.daily?.quote?.description ?? ""}</td>
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
    <div style="font-size:10px;color:#9ca3af;margin-top:3px">9D · 30D · 3M · 6M · 1Y — CBOE Indizes via Yahoo Finance</div>
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
    <div style="font-size:10px;text-transform:uppercase;color:#9ca3af;letter-spacing:.05em;font-weight:600;margin-bottom:10px">😨 Fear &amp; Greed Index (CNN Markets)</div>
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

function formatMarketHtml(market) {
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
        <td style="padding:6px 8px;font-weight:700;font-size:13px;white-space:nowrap">😨 VIX</td>
        <td style="padding:6px 8px;text-align:right;font-weight:800;font-size:14px;color:${vixColor};white-space:nowrap">${vixDisplay}</td>
        <td colspan="4" style="padding:5px 8px">${vixChips}</td>
      </tr>
    </tbody>
  </table>
  <p style="font-size:10px;color:#9ca3af;margin-top:6px">● MA50 &nbsp;● MA150 &nbsp;● MA200 — grün = Kurs darüber, rot = darunter</p>

  ${formatVixTermStructure(market.vix_term_structure)}
  ${formatFearGreed(market.fear_greed)}
  ${formatSectorHeatmapHtml(market.sectors)}`;
}

function formatOpeningBellHtml(ob) {
  if (!ob?.success || !ob.video) {
    const errMsg = ob?.error || "Nicht verfügbar";
    return `<p style="color:#9ca3af;font-size:12px">🎙 Markus Koch Opening Bell: ${errMsg}</p>`;
  }

  // Titel-basiert erkennen ob Opening oder Closing Bell
  const isClosingBell = /closing\s*bell/i.test(ob.video.title ?? "");
  const bellLabel     = isClosingBell ? "Markus Koch Closing Bell" : "Markus Koch Opening Bell";

  const pubDate = new Date(ob.video.published).toLocaleDateString("de-DE", {
    weekday: "short", day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  // Kein Transkript → nur Titel + Link
  if (!ob.transcript_available || !ob.info) {
    return `
    <div style="border-top:1px solid #e5e7eb;margin-top:14px;padding-top:12px">
      <div style="font-size:13px;font-weight:700;margin-bottom:6px">
        🎙 ${bellLabel} · <a href="${ob.video.url}" style="color:#1d4ed8;text-decoration:none">${ob.video.title}</a>
        <span style="font-size:11px;color:#9ca3af;font-weight:400"> · ${pubDate}</span>
      </div>
      <p style="font-size:12px;color:#9ca3af;margin:0">Transkript nicht verfügbar — Video direkt ansehen.</p>
    </div>`;
  }

  const { movements, fedSentences, stocks, sentiment, sentimentEmoji } = ob.info;

  // Bewegungen: Claude-Stichpunkte mit Markdown-Bold → HTML
  const renderMovement = (m) => m
    .replace(/^\*([^*]+):\*\*/, "<strong>$1:</strong>")   // *Label:** (Tippfehler-Variante)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");   // **Label**

  const movBlock = movements.length
    ? movements.map((m, i) => `
        <tr>
          <td style="padding:4px 6px 4px 0;color:#9ca3af;font-size:11px;vertical-align:top;white-space:nowrap;font-weight:600">${i + 1}.</td>
          <td style="padding:4px 0 4px 6px;color:#1f2937;font-size:12px;line-height:1.6">${renderMovement(m)}</td>
        </tr>`).join("")
    : `<tr><td colspan="2" style="color:#9ca3af;font-size:12px;padding:4px 0">Keine Marktbewegungen extrahiert</td></tr>`;

  // Fed / Makro: vollständige Sätze
  const fedBlock = fedSentences.length
    ? fedSentences.map((s) => `
        <div style="display:flex;gap:6px;margin-bottom:5px">
          <span style="color:#6b7280;font-size:12px;flex-shrink:0">▸</span>
          <span style="font-size:12px;color:#374151;line-height:1.5">${s}</span>
        </div>`).join("")
    : "";

  // Einzelaktien
  const stockBlock = stocks.length
    ? `<div style="margin-top:8px;padding-top:8px;border-top:1px solid #f3f4f6;font-size:11px;color:#6b7280">
        <span style="text-transform:uppercase;letter-spacing:.05em;font-size:10px">Einzelwerte: </span>${stocks.join(" &nbsp;·&nbsp; ")}
       </div>`
    : "";

  return `
  <div style="border-top:1px solid #e5e7eb;margin-top:16px;padding-top:14px">

    <!-- Header: Titel + Datum + Sentiment -->
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:10px;flex-wrap:wrap">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:800;margin-bottom:2px">🎙 ${bellLabel}</div>
        <a href="${ob.video.url}" style="font-size:12px;color:#1d4ed8;text-decoration:none;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${ob.video.title}">${ob.video.title}</a>
        <div style="font-size:11px;color:#9ca3af;margin-top:1px">${pubDate}</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-size:18px">${sentimentEmoji}</div>
        <div style="font-size:11px;font-weight:700;color:#374151">${sentiment}</div>
      </div>
    </div>

    <!-- Marktbewegungen -->
    ${movements.length ? `
    <div style="margin-bottom:10px">
      <div style="font-size:10px;text-transform:uppercase;color:#9ca3af;letter-spacing:.05em;margin-bottom:5px;font-weight:600">Marktbewegungen</div>
      <table style="width:100%;border-collapse:collapse">${movBlock}</table>
    </div>` : ""}

    <!-- Fed / Makro -->
    ${fedSentences.length ? `
    <div style="margin-bottom:8px">
      <div style="font-size:10px;text-transform:uppercase;color:#9ca3af;letter-spacing:.05em;margin-bottom:5px;font-weight:600">Fed / Makro</div>
      ${fedBlock}
    </div>` : ""}

    ${stockBlock}

    <div style="margin-top:8px">
      <a href="${ob.video.url}" style="font-size:11px;color:#6b7280;text-decoration:none">▶ Vollständiges Video ansehen →</a>
    </div>
  </div>`;
}

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
    const nameCell = `<span title="${r.name}">${truncName}</span><br><span style="font-size:9px;color:#9ca3af">${r.market}</span>`;
    const td = (content, extra = "") =>
      `<td style="padding:5px 4px;font-size:11px;overflow:hidden;${extra}">${content}</td>`;

    // Numeric score instead of star emojis (saves column space)
    const scoreNum   = r.stars ?? 0;
    const scoreColor = scoreNum >= 4 ? "#16a34a" : scoreNum >= 3 ? "#d97706" : "#6b7280";
    const scoreDisp  = `<span style="font-weight:800;font-size:13px;color:${scoreColor}">${scoreNum}</span>`;

    return `<tr style="border-bottom:1px solid #f3f4f6">
      ${td(scoreDisp, "text-align:center")}
      ${td(`<span style="font-weight:700;font-size:12px">${truncTicker}</span>${exchange ? `<br><span style="font-size:9px;color:#9ca3af">${exchange}</span>` : ""}`)}
      ${td(nameCell, "line-height:1.3")}
      ${td(r.price != null ? Number(r.price).toLocaleString("de-DE", {maximumFractionDigits: 2}) : "–", `text-align:right;font-weight:600;font-size:12px`)}
      ${td(`<span style="color:${dayColor};font-weight:700">${dayDisplay}</span>`, "text-align:right")}
      ${td(`<span style="color:${perfColor};font-weight:600">${r.perf_3m}</span>`, "text-align:right")}
      ${td(`<span style="color:${epsColor}">${r.eps_growth}</span>`, "text-align:right")}
      ${showShortFloat ? td(`<span style="color:${sfColor}">${sfDisplay}</span>`, "text-align:right") : ""}
      ${td(`<span style="color:${mcapColor};font-weight:600">${r.market_cap}</span>`, "text-align:right")}
      ${td(h52Display, "text-align:right;color:#6b7280")}
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

function formatScannerHtml(scanData) {
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

// ── Kalender-Block ───────────────────────────────────────────────────────────

// ── Stage-2 Gesundheits-Meter ─────────────────────────────────────────────────

function calcStage2Info(symbolsScanned, stage2Map) {
  if (!stage2Map?.size) return null;
  let count = 0, total = 0;
  for (const s of symbolsScanned) {
    // Versuche full symbol, dann nur Ticker (Fallback bei Exchange-Prefix-Mismatch)
    const ticker = s.symbol.split(":").pop();
    const val = stage2Map.get(s.symbol) ?? stage2Map.get(ticker);
    if (val !== undefined) { total++; if (val) count++; }
  }
  return total > 0 ? { count, total, pct: Math.round((count / total) * 100) } : null;
}

function formatCalendarHtml(calData) {
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

  const impDot = (imp) => imp >= 3
    ? `<span style="color:#dc2626;font-size:10px;margin-right:3px">●</span>`
    : `<span style="color:#d97706;font-size:10px;margin-right:3px">●</span>`;

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
      let valHtml = "";
      if (e.actual && e.forecast) {
        const aNum = parseFloat(String(e.actual).replace(",", "."));
        const fNum = parseFloat(String(e.forecast).replace(",", "."));
        const beat = !isNaN(aNum) && !isNaN(fNum) ? aNum > fNum : null;
        const bg   = beat === null ? "#eff6ff"   : beat ? "#f0fdf4" : "#fef2f2";
        const bc   = beat === null ? "#bfdbfe"   : beat ? "#bbf7d0" : "#fecaca";
        const col  = beat === null ? "#1d4ed8"   : beat ? "#16a34a" : "#dc2626";
        const valTxt = `<strong style="color:${col}">${e.actual}${e.unit}</strong>`
          + ` <span style="color:#9ca3af;font-weight:400">vs. ${e.forecast}${e.unit}</span>`;
        return `<div style="display:inline-flex;align-items:center;gap:5px;background:${bg};border:1px solid ${bc};border-radius:5px;padding:3px 8px;margin:2px;font-size:11px;font-weight:700">
          <span>${e.flag} ${e.time !== "–" ? `<span style="color:#9ca3af;font-weight:400;font-size:10px">${e.time}</span> ` : ""}</span>
          <span style="font-weight:600;color:#374151;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${e.event}">${e.event}</span>
          <span style="white-space:nowrap">${valTxt}</span>
        </div>`;
      } else if (e.actual) {
        return `<div style="display:inline-flex;align-items:center;gap:5px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:5px;padding:3px 8px;margin:2px;font-size:11px;font-weight:700">
          <span>${e.flag}</span>
          <span style="font-weight:600;color:#374151;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${e.event}</span>
          <strong style="color:#1d4ed8">${e.actual}${e.unit}</strong>
        </div>`;
      } else {
        // Nur Erwartungswert (noch nicht veröffentlicht)
        const timeStr = e.time !== "–" ? `<span style="color:#9ca3af;font-weight:400">${e.time}</span> ` : "";
        const forecastStr = e.forecast ? ` · <span style="color:#6b7280">${e.forecast}${e.unit} erw.</span>` : "";
        return `<div style="display:inline-flex;align-items:center;gap:5px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:5px;padding:3px 8px;margin:2px;font-size:11px">
          <span>${e.flag} ${timeStr}<span style="color:#374151;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${e.event}${forecastStr}</span></span>
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
        const vsF  = !isNaN(fNum) ? ` <span style="color:#9ca3af;font-weight:400">vs. ${e.eps_estimate}</span>` : "";
        return `<span style="display:inline-block;background:${bg};color:${col};border:1px solid ${bc};border-radius:4px;padding:2px 7px;font-size:11px;font-weight:700;margin:2px">
          📣 ${e.symbol} <span style="font-weight:400;color:#6b7280">${e.time_label}</span> · <strong>${e.eps_actual}</strong>${vsF}
        </span>`;
      }
      return `<span style="display:inline-block;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;border-radius:4px;padding:2px 7px;font-size:11px;font-weight:700;margin:2px">
        📣 ${e.symbol} <span style="font-weight:400;color:#6b7280">${e.time_label}${e.eps_estimate ? ` · ~${e.eps_estimate}` : ""}</span>
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

// ── Watchlist Breaking News ───────────────────────────────────────────────────

function formatWatchlistNewsHtml(news) {
  if (!news?.length) return "";

  const fmtAge = (date) => {
    if (!date) return "";
    const diffMs = Date.now() - date.getTime();
    const h = diffMs / 3_600_000;
    if (h < 1)   return `${Math.round(diffMs / 60_000)} Min.`;
    if (h < 24)  return `${Math.round(h)} Std.`;
    return date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
  };

  const items = news.map((n) => `
    <div style="padding:7px 0;border-bottom:1px solid #f3f4f6">
      <div style="display:flex;gap:8px;align-items:flex-start">
        <span style="background:#1e40af;color:white;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700;white-space:nowrap;flex-shrink:0">${n.symbol}</span>
        <div style="flex:1;min-width:0">
          <a href="${n.url}" style="color:#1f2937;text-decoration:none;font-size:12px;line-height:1.4;display:block">${n.title}</a>
          <div style="font-size:10px;color:#9ca3af;margin-top:2px">${n.publisher}${n.time ? ` &nbsp;·&nbsp; ${fmtAge(n.time)}` : ""}</div>
        </div>
      </div>
    </div>`
  ).join("");

  return items;
}

function formatHtml(data, scanData, marketData, obData, calData, mode = "daily", rsHistory = null, stage2Map = null, weeklyPerfMap = null, wlNews = null, rsiMap = null) {
  const date = new Date(data.generated_at).toLocaleDateString("de-DE", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  const time = new Date(data.generated_at).toLocaleTimeString("de-DE");
  const isFriday = new Date().getDay() === 5;
  const stage2Info = calcStage2Info(data.symbols_scanned || [], stage2Map);

  // Wochenrückblick (Freitag) vorbereiten
  const weeklyPerfHtml = isFriday && weeklyPerfMap?.size
    ? formatWochenruckblickHtml(data.symbols_scanned || [], weeklyPerfMap)
    : "";

  const rows = (data.symbols_scanned || []).map((s) => {
    if (s.error) {
      return `<tr><td style="font-weight:bold">${s.symbol}</td>
        <td colspan="6" style="color:#dc2626;font-size:12px">${s.error}</td></tr>`;
    }

    const d     = s.daily || {};
    const q     = d.quote || {};
    const inds  = (d.indicators || {}).studies || [];
    const ohlcv = d.ohlcv_summary || {};

    const macd   = inds.find((i) => i.name.includes("Convergence"))?.values || {};
    const vol    = inds.find((i) => i.name === "Volume")?.values || {};
    const mansf  = inds.find((i) => i.name.includes("Mansfield"))?.values || {};
    const rsi14  = inds.find((i) => i.name.includes("Relative Strength Index") || i.name === "RSI")?.values || {};
    const vwma   = inds.find((i) => i.name.includes("Weighted"))?.values || {};

    const price     = q.close ?? "–";

    // Tagesveränderung: aus last_5_bars berechnen (vorletzter Close → letzter Close)
    // getQuote() liefert kein change_pct — muss aus OHLCV errechnet werden
    const lastBars  = ohlcv.last_5_bars || [];
    const barToday  = lastBars[lastBars.length - 1];
    const barPrev   = lastBars[lastBars.length - 2];
    const dailyCh   = (barToday?.close != null && barPrev?.close != null && barPrev.close !== 0)
      ? ((barToday.close - barPrev.close) / barPrev.close * 100)
      : null;

    const perfCh    = ohlcv.change_pct ?? "–";
    const macdH     = Object.values(macd)[0] ?? "–";
    const volNow    = Object.values(vol)[0] ?? "–";
    const volMa     = Object.values(vol)[1] ?? "–";
    const rsVal       = Object.values(mansf)[0];
    const rsiChartVal = Object.values(rsi14)[0];
    // Fallback-Kette: Mansfield (Chart) → RSI (Chart) → RSI via TV Scanner
    const rsiScanVal  = rsiMap ? (rsiMap.get(s.symbol) ?? rsiMap.get(s.symbol.split(":").pop())) : null;
    const rsiVal      = (rsiChartVal != null && !isNaN(rsiChartVal)) ? rsiChartVal : rsiScanVal;
    const useRsi      = rsVal == null || isNaN(rsVal);
    const rsDisplay   = useRsi
      ? ((rsiVal != null && !isNaN(rsiVal))
          ? `${Number(rsiVal).toFixed(1)}<span style="font-size:9px;color:#9ca3af"> RSI</span>`
          : "–")
      : Number(rsVal).toFixed(2);

    const macdColor = String(macdH).startsWith("−") || String(macdH).startsWith("-")
      ? "#dc2626" : "#16a34a";

    // Volume-Alert: Highlight bei Volumen > 150% des Durchschnitts
    // parseVolume() konvertiert K/M/B korrekt (z.B. "776K" und "1.46M" werden beide zu absoluten Zahlen)
    const volNum   = parseVolume(volNow);
    const volMaNum = parseVolume(volMa);
    const volAlert = volMaNum > 0 && volNum > volMaNum * 1.5;
    const volStyle = volAlert
      ? "font-size:11px;color:#d97706;padding:5px 4px;white-space:nowrap;font-weight:700;text-align:right;overflow:hidden"
      : "font-size:11px;color:#6b7280;padding:5px 4px;white-space:nowrap;text-align:right;overflow:hidden";
    const volLabel = volAlert ? `🔥 ${volNow}<br><span style="color:#9ca3af;font-weight:400">MA ${volMa}</span>` : `${volNow}<br><span style="color:#9ca3af">MA ${volMa}</span>`;

    // RS-Trend vs. letzte Woche
    const rsTrendHtml = rsTrend(rsVal, rsHistory, s.symbol);

    const displayTicker = s.symbol.split(":").pop() || s.symbol;
    const displayName   = q.description || "";

    // Zeilen-Hintergrund: orangegelb bei Volume-Alert
    const rowBg = volAlert ? "background:#fffbeb" : "";

    const truncName = displayName.length > 22 ? displayName.slice(0, 20) + "…" : displayName;
    return `<tr style="border-bottom:1px solid #f3f4f6;${rowBg}">
      <td style="font-weight:700;padding:5px 4px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${displayTicker}</td>
      <td style="color:#6b7280;font-size:11px;padding:5px 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${displayName}">${truncName}</td>
      <td style="text-align:right;font-weight:600;padding:5px 4px;font-size:12px;overflow:hidden">${price}</td>
      <td style="text-align:right;padding:5px 4px;font-size:12px;overflow:hidden">${dailyCh !== null ? trend(dailyCh) : "–"}</td>
      <td style="text-align:right;padding:5px 4px;font-size:11px;color:#6b7280;overflow:hidden">${trend(perfCh)}</td>
      <td style="text-align:right;color:${macdColor};padding:5px 4px;font-size:11px;overflow:hidden">${macdH}</td>
      <td style="${volStyle}">${volLabel}</td>
      <td style="text-align:right;font-size:11px;padding:5px 4px;overflow:hidden;white-space:nowrap">${rsDisplay}&nbsp;${rsTrendHtml}</td>
      <td style="text-align:center;padding:5px 4px;font-size:12px;white-space:nowrap">${stars(dailyCh ?? perfCh)}</td>
    </tr>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;background:#f3f4f6;margin:0;padding:16px}
  .wrap{max-width:680px;margin:0 auto}
  .card{background:#fff;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.08);padding:20px 18px;margin-bottom:14px;overflow:hidden}
  h1{margin:0 0 4px;font-size:20px;font-weight:700}
  h2{margin:0 0 4px;font-size:17px;font-weight:700}
  .sub{color:#6b7280;font-size:12px;margin:0 0 14px;line-height:1.5}
  table{width:100%;border-collapse:collapse;font-size:12px}
  .brief-table{table-layout:fixed;width:100%}
  .brief-table th{background:#f9fafb;text-align:left;padding:5px 4px;font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:.04em;border-bottom:2px solid #e5e7eb;white-space:nowrap;overflow:hidden}
  .brief-table td{padding:5px 4px;border-bottom:1px solid #f3f4f6;vertical-align:middle;overflow:hidden}
  .brief-table tr:last-child td{border-bottom:none}
  .brief-table tr:hover td{background:#fafafa}
  .footer{text-align:center;font-size:11px;color:#9ca3af;margin-top:10px;padding-bottom:8px}
</style>
</head>
<body><div class="wrap">

  <div class="card">
    <h1>🌍 Markt-Regime</h1>
    <p class="sub">${new Date(data.generated_at).toLocaleDateString("de-DE", { weekday:"long", day:"2-digit", month:"long", year:"numeric" })} &nbsp;·&nbsp; ${new Date(data.generated_at).toLocaleTimeString("de-DE")} &nbsp;·&nbsp; 📈 Briefing</p>
    ${formatMarketHtml(marketData)}
    ${formatOpeningBellHtml(obData)}
  </div>

  <div class="card">
    <h2>📅 Wochenkalender</h2>
    <p class="sub" style="margin-bottom:10px">KW ab ${calData?.week_label ?? ""} · Wichtige Makro-Ereignisse &amp; Watchlist-Earnings</p>
    ${formatCalendarHtml(calData)}
  </div>

  <div class="card">
    <h1>📈 Briefing – Watchlist (CANSLIM)</h1>
    <p class="sub">Watchlist: <strong>${data.watchlist_name || "–"}</strong> &nbsp;·&nbsp; ${(data.symbols_scanned || []).length} Symbole
    ${stage2Info ? ` &nbsp;·&nbsp; <span style="font-weight:700;color:${stage2Info.pct >= 70 ? "#16a34a" : stage2Info.pct >= 40 ? "#d97706" : "#dc2626"}">Stage-2-Health: ${stage2Info.count}/${stage2Info.total} (${stage2Info.pct}%)</span>` : ""}
    </p>

    <table class="brief-table">
      <colgroup>
        <col style="width:50px">
        <col style="width:105px">
        <col style="width:62px">
        <col style="width:55px">
        <col style="width:50px">
        <col style="width:55px">
        <col style="width:88px">
        <col style="width:65px">
        <col style="width:66px">
      </colgroup>
      <thead><tr>
        <th>Symbol</th>
        <th>Name</th>
        <th style="text-align:right">Kurs</th>
        <th style="text-align:right">Tag %</th>
        <th style="text-align:right">60T %</th>
        <th style="text-align:right">MACD-H</th>
        <th style="text-align:right">Volumen</th>
        <th style="text-align:right">RSI (14) ⟆</th>
        <th style="text-align:center">⭐</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${isFriday && weeklyPerfHtml ? weeklyPerfHtml : ""}
  </div>

  <div class="card">
    <h2>🔍 CANSLIM Scanner · Top 5 USA + Top 5 Europa</h2>
    <p class="sub">Beste neue Kandidaten aus US + Europa · Sortiert nach ⭐ → MCap → 3M%</p>
    ${formatScannerHtml(scanData)}
  </div>

  ${wlNews?.length ? `
  <div class="card">
    <h2>📰 Breaking News – Watchlist</h2>
    <p class="sub" style="margin-bottom:8px">Aktuellste Meldungen zu deinen Watchlist-Werten</p>
    ${formatWatchlistNewsHtml(wlNews)}
  </div>` : ""}

  <div class="footer">
    CANSLIM Swing Trading · TradingView MCP · Keine Anlageberatung<br>
    <a href="https://tradingview.com" style="color:#9ca3af">TradingView öffnen</a>
  </div>
</div></body></html>`;
}

// ── Email senden ─────────────────────────────────────────────────────────────

async function sendEmail(html, count, regime, mode = "daily") {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PW },
  });

  const date = new Date().toLocaleDateString("de-DE", {
    weekday: "short", day: "2-digit", month: "2-digit", year: "numeric",
  });

  const regimeShort = regime ? ` · ${regime.color} ${regime.label}` : "";
  const prefix = mode === "ob-update" ? "🔄 Opening Bell Update" : "📈 Briefing";

  await transporter.sendMail({
    from: `"TradingView Brief" <${GMAIL_USER}>`,
    to: RECIPIENT,
    subject: `${prefix} ${date} · ${count} Setups${regimeShort}`,
    html,
  });
}

// ── OB-State (Opening Bell Verfügbarkeit tracken) ────────────────────────────

function readObState() {
  try {
    if (existsSync(OB_STATE_FILE)) {
      return JSON.parse(readFileSync(OB_STATE_FILE, "utf8"));
    }
  } catch {}
  return null;
}

function writeObState(ob_available, mode) {
  try {
    const today = new Date().toISOString().split("T")[0];
    writeFileSync(OB_STATE_FILE, JSON.stringify({ date: today, ob_available, mode, sent_at: new Date().toISOString() }));
  } catch {}
}

// ── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`[${new Date().toISOString()}] Brief gestartet (Modus: ${MODE})…`);

  // ── Modus: ob-update — Nur senden wenn OB jetzt verfügbar und vorher gefehlt ──
  if (MODE === "ob-update") {
    const state = readObState();
    const today = new Date().toISOString().split("T")[0];
    if (!state || state.date !== today || state.ob_available === true) {
      console.log("ℹ️  OB-Update: Kein Update nötig (OB war bereits verfügbar oder kein State).");
      process.exit(0);
    }
    console.log("🔄 OB war nicht verfügbar — versuche erneut…");
    try {
      const obData = await runOpeningBell();
      if (!obData?.success || !obData?.transcript_available) {
        console.log("ℹ️  Opening Bell immer noch nicht verfügbar — kein Update.");
        process.exit(0);
      }
      console.log(`✅ Opening Bell jetzt verfügbar: "${obData.video?.title?.slice(0, 60)}"`);

      // Minimales Update-Email nur mit OB-Inhalt senden
      const obHtml = `<!DOCTYPE html><html><head><meta charset="utf-8">
      <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f3f4f6;margin:0;padding:16px}
      .wrap{max-width:700px;margin:0 auto}.card{background:#fff;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.08);padding:22px 20px;margin-bottom:14px}
      h1{margin:0 0 4px;font-size:18px;font-weight:700}</style></head>
      <body><div class="wrap"><div class="card">
        <h1>🔄 Opening Bell Update</h1>
        <p style="color:#6b7280;font-size:12px;margin:0 0 12px">Nachgereicht zum Daily Brief vom ${new Date().toLocaleDateString("de-DE")}</p>
        ${formatOpeningBellHtml(obData)}
      </div></div></body></html>`;

      const transporter = nodemailer.createTransport({ service: "gmail", auth: { user: GMAIL_USER, pass: GMAIL_APP_PW } });
      await transporter.sendMail({
        from: `"TradingView Brief" <${GMAIL_USER}>`,
        to: RECIPIENT,
        subject: `🔄 Opening Bell Update ${new Date().toLocaleDateString("de-DE")} · ${obData.info?.sentiment ?? ""}`,
        html: obHtml,
      });
      writeObState(true, "ob-update");
      console.log(`✅ OB-Update gesendet an ${RECIPIENT}`);
    } catch (err) {
      console.error("❌ OB-Update Fehler:", err.message);
    }
    process.exit(0);
  }

  // ── Normaler Ablauf: morning oder daily ──────────────────────────────────
  try {
    // TradingView + Market + Opening Bell (nur im daily-Modus) + Kalender parallel starten
    const parallelTasks = [
      ensureTradingViewRunning(),
      runMarketCheck(),
      runOpeningBell(),
    ];
    const [tvResult, marketResult, obResult] = await Promise.allSettled(parallelTasks);

    if (tvResult.status === "rejected") throw tvResult.reason;

    const marketData = marketResult.status === "fulfilled" ? marketResult.value : null;
    if (marketData?.success) {
      console.log(`✅ Market Check: ${marketData.regime.color} ${marketData.regime.label} · VIX ${marketData.vix?.close?.toFixed(1) ?? "–"}`);
    } else {
      console.warn("⚠️  Market Check fehlgeschlagen:", marketResult.reason?.message || marketData?.error);
    }

    const obData = obResult.status === "fulfilled" ? obResult.value : null;
    if (obData?.success && obData?.transcript_available) {
      console.log(`✅ Opening Bell: "${obData.video?.title?.slice(0, 60)}" · ${obData.info?.sentimentEmoji || ""} ${obData.info?.sentiment || ""}`);
    } else {
      console.warn("⚠️  Opening Bell nicht verfügbar — wird ggf. nachgereicht (17:30).");
    }

    // Brief + Scanner + Kalender parallel
    const watchlistSymbols = []; // wird nach runBrief befüllt
    const [briefResult, scanResult] = await Promise.allSettled([
      runBrief(),
      runScan({ markets: "all", min_stars: 3, top: 20 }),
    ]);

    const data = briefResult.status === "fulfilled" ? briefResult.value : null;
    if (!data?.success) throw new Error(data?.error || briefResult.reason?.message || "Brief fehlgeschlagen");

    const scanData = scanResult.status === "fulfilled" ? scanResult.value : null;
    if (scanData) {
      console.log(`✅ Scanner: 🇺🇸 ${scanData.us_results?.length ?? 0} US + 🌍 ${scanData.europe_results?.length ?? 0} EU aus ${scanData.total_raw} gescannt.`);
    } else {
      console.warn("⚠️  Scanner fehlgeschlagen:", scanResult.reason?.message);
    }

    const symbols = (data.symbols_scanned || []).map((s) => s.symbol);

    // RS-History laden (für Trend-Vergleich)
    const rsHistory = loadRsHistory();

    // RS-Werte aus Brief extrahieren und speichern
    const currentRsMap = new Map();
    for (const s of data.symbols_scanned || []) {
      const mansf  = (s.daily?.indicators?.studies || []).find((i) => i.name?.includes("Mansfield"));
      const rsVal  = Object.values(mansf?.values || {})[0];
      if (rsVal != null) currentRsMap.set(s.symbol, rsVal);
    }
    if (currentRsMap.size > 0) saveRsHistory(currentRsMap);

    // Kalender, Stage-2-Check, Wochenperformance, News parallel laden
    const isFridayMode = new Date().getDay() === 5;
    const [calResult, stage2Result, weeklyPerfResult, wlNewsResult, rsiResult] = await Promise.allSettled([
      fetchCalendar(symbols),
      fetchWatchlistStage2(symbols),
      isFridayMode ? fetchWeeklyPerformance(symbols) : Promise.resolve(new Map()),
      fetchWatchlistNews(symbols, 12),
      fetchWatchlistRsi(symbols),
    ]);

    const calData    = calResult.status === "fulfilled"       ? calResult.value       : null;
    const stage2Map  = stage2Result.status === "fulfilled"    ? stage2Result.value    : new Map();
    const weeklyPerf = weeklyPerfResult.status === "fulfilled"? weeklyPerfResult.value: new Map();
    const wlNews     = wlNewsResult.status === "fulfilled"    ? wlNewsResult.value    : [];
    const rsiMap     = rsiResult.status === "fulfilled"       ? rsiResult.value       : new Map();
    console.log(`✅ RSI: ${rsiMap?.size ?? 0} Werte via TV Scanner.`);

    if (calData) {
      console.log(`✅ Kalender: ${calData.events?.length ?? 0} Ereignisse · ${calData.earnings?.length ?? 0} Earnings (Woche).`);
    }
    const stage2Count = [...(stage2Map?.values() ?? [])].filter(Boolean).length;
    console.log(`✅ Stage-2: ${stage2Count}/${stage2Map?.size ?? 0} Watchlist-Aktien im Uptrend.`);
    console.log(`✅ News: ${wlNews?.length ?? 0} WL-Headlines.`);
    if (isFridayMode && weeklyPerf.size) {
      console.log(`✅ Wochenrückblick: ${weeklyPerf.size} Symbole geladen.`);
    }

    const count = symbols.length;
    console.log(`✅ Brief: ${count} Symbole. Sende Email…`);

    const html = formatHtml(data, scanData, marketData, obData, calData, MODE, rsHistory, stage2Map, weeklyPerf, wlNews, rsiMap);
    await sendEmail(html, count, marketData?.regime, MODE);
    console.log(`✅ Email erfolgreich an ${RECIPIENT} gesendet.`);

    // OB-State speichern (für 17:30 Retry)
    if (MODE === "daily") {
      const obAvailable = !!(obData?.success && obData?.transcript_available);
      writeObState(obAvailable, "daily");
      if (!obAvailable) {
        console.log("ℹ️  OB-State gespeichert: nicht verfügbar → Retry um 17:30 Uhr.");
      }
    }

  } catch (err) {
    console.error("❌ Fehler:", err.message);
    process.exit(1);
  }
})();
