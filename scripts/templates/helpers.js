import { readFileSync, writeFileSync, existsSync } from "node:fs";

export function esc(s) { return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

export function trend(changePct) {
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
export function parseVolume(val) {
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

// ── MACD-Histogramm aus OHLCV-Bars berechnen ─────────────────────────────────
// Fallback wenn TradingView data_get_study_values MACD nicht liefert
// (Sub-Pane-Indikatoren werden von der API nicht erfasst)
export function calcMacdFromBars(bars) {
  if (!bars || bars.length < 35) return null;
  const closes = bars.map(b => b.close);
  const k12 = 2 / 13, k26 = 2 / 27, k9 = 2 / 10;
  // EMA-12
  let ema12 = closes.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
  for (let i = 12; i < 26; i++) ema12 = closes[i] * k12 + ema12 * (1 - k12);
  // EMA-26
  let ema26 = closes.slice(0, 26).reduce((a, b) => a + b, 0) / 26;
  // MACD-Linie ab Bar 26
  const macdLine = [];
  for (let i = 26; i < closes.length; i++) {
    ema12 = closes[i] * k12 + ema12 * (1 - k12);
    ema26 = closes[i] * k26 + ema26 * (1 - k26);
    macdLine.push(ema12 - ema26);
  }
  if (macdLine.length < 9) return null;
  // Signal-Linie = EMA(9) der MACD-Linie
  let signal = macdLine.slice(0, 9).reduce((a, b) => a + b, 0) / 9;
  for (let i = 9; i < macdLine.length; i++) signal = macdLine[i] * k9 + signal * (1 - k9);
  return macdLine.at(-1) - signal; // Histogramm = MACD − Signal
}

// ── Volumen-Formatierung ──────────────────────────────────────────────────────
export function formatVol(n) {
  if (!n || isNaN(n)) return null;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "K";
  return n.toFixed(0);
}

// ── RS-Trend State (Wöchentlicher Vergleich) ─────────────────────────────────

const RS_STATE_FILE = "/tmp/.brief-rs-history.json";

export function loadRsHistory() {
  try {
    if (existsSync(RS_STATE_FILE)) return JSON.parse(readFileSync(RS_STATE_FILE, "utf8"));
  } catch {}
  return null;
}

export function saveRsHistory(rsMap) {
  try {
    const today = new Date().toISOString().split("T")[0];
    writeFileSync(RS_STATE_FILE, JSON.stringify({ date: today, rs: Object.fromEntries(rsMap) }));
  } catch {}
}

/** Gibt ↑ ↓ oder → zurück basierend auf Δ RS */
export function rsTrend(currentRs, history, symbol) {
  if (!history) return "";
  const old = history.rs?.[symbol];
  if (old == null || currentRs == null || isNaN(currentRs)) return "";
  const delta = currentRs - old;
  if (delta > 0.3)  return `<span style="color:#16a34a;font-size:10px" title="RS +${delta.toFixed(1)} vs. letzte Woche">↑</span>`;
  if (delta < -0.3) return `<span style="color:#dc2626;font-size:10px" title="RS ${delta.toFixed(1)} vs. letzte Woche">↓</span>`;
  return `<span style="color:#9ca3af;font-size:10px" title="RS stabil">→</span>`;
}

// ── Stage-2 Gesundheits-Meter ─────────────────────────────────────────────────
export function calcStage2Info(symbolsScanned, stage2Map) {
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

// Rundet einen Zahlen-String auf max. 2 Dezimalstellen; nicht-numerische Strings bleiben unverändert
export function fmtCalNum(val) {
  if (val == null) return null;
  const s = String(val).trim();
  const n = parseFloat(s.replace(",", "."));
  if (isNaN(n)) return s;                    // z.B. "N/A" oder leerer String
  // Nur runden wenn mehr als 2 Dezimalstellen vorhanden
  const decimals = (s.split(".")[1] ?? s.split(",")[1] ?? "").length;
  return decimals > 2 ? n.toFixed(2) : s;
}
