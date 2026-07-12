#!/usr/bin/env node
// fetch-prices.js — Kursabruf via Yahoo Finance für Newsletter
// Läuft VOR claude -p und liefert verifizierte EUR-Kurse
// Aufruf: node fetch-prices.js --out <path>

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import YahooFinance from "yahoo-finance2";   // v3: default-Export ist eine Klasse

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env") });

// v3 API: Instanz erstellen, Survey-Hinweis unterdrücken
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

// ── Ausgabepfad ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = outIdx !== -1 ? args[outIdx + 1]
  : resolve(__dirname, "../tmp/preise_aktuell.json");

// ── Ticker-Mapping: interner Name → Yahoo-Finance-Symbol + Heimatwährung ─────
// Alle USD-Tickers werden mit EUR/USD in EUR umgerechnet
// EUR-Tickers bleiben direkt
const TICKERS = {
  // ── WACHSTUMSDEPOT ────────────────────────────────────────────────────────
  "AMZN":     { yf: "AMZN",      cur: "USD" },
  "ANET":     { yf: "ANET",      cur: "USD" },
  "AVGO":     { yf: "AVGO",      cur: "USD" },
  "BABA":     { yf: "BABA",      cur: "USD" },
  "BN":       { yf: "BN",        cur: "USD" },
  "BTQ":      { yf: "BTQ.V",     cur: "CAD" },
  "CARB":     { yf: "CARB.PA",   cur: "EUR" },
  "COIN":     { yf: "COIN",      cur: "USD" },
  "CRM":      { yf: "CRM",       cur: "USD" },
  "CRWD":     { yf: "CRWD",      cur: "USD" },
  "DASH":     { yf: "DASH",      cur: "USD" },
  "DOCN":     { yf: "DOCN",      cur: "USD" },
  "GOOGL":    { yf: "GOOGL",     cur: "USD" },
  "HIMS":     { yf: "HIMS",      cur: "USD" },
  "HSTECH":   { yf: "9067.HK",   cur: "HKD" },
  "IBM":      { yf: "IBM",       cur: "USD" },
  "IONQ":     { yf: "IONQ",      cur: "USD" },
  "KO":       { yf: "KO",        cur: "USD" },
  "MELI":     { yf: "MELI",      cur: "USD" },
  "META":     { yf: "META",      cur: "USD" },
  "MNST":     { yf: "MNST",      cur: "USD" },
  "MSFT":     { yf: "MSFT",      cur: "USD" },
  "NKE":      { yf: "NKE",       cur: "USD" },
  "NOW":      { yf: "NOW",       cur: "USD" },
  "NVDA":     { yf: "NVDA",      cur: "USD" },
  "PATH":     { yf: "PATH",      cur: "USD" },
  "PLTR":     { yf: "PLTR",      cur: "USD" },
  "PRY":      { yf: "PRY.MI",    cur: "EUR" },
  "PSTG":     { yf: "PSTG",      cur: "USD" },
  "PYPL":     { yf: "PYPL",      cur: "USD" },
  "QBTS":     { yf: "QBTS",      cur: "USD" },
  "SE":       { yf: "SE",        cur: "USD" },
  "SHOP":     { yf: "SHOP",      cur: "USD" },
  "SPGI":     { yf: "SPGI",      cur: "USD" },
  "TWLO":     { yf: "TWLO",      cur: "USD" },
  "VEEV":     { yf: "VEEV",      cur: "USD" },
  "VUL":      { yf: "VUL.AX",    cur: "AUD" },
  "VRNS":     { yf: "VRNS",      cur: "USD" },
  "YSN":      { yf: "YSN.DE",    cur: "EUR" },
  "000660":   { yf: "000660.KS", cur: "KRW" },
  "1177.HK":  { yf: "1177.HK",   cur: "HKD" },
  "1211.HK":  { yf: "1211.HK",   cur: "HKD" },
  "1810.HK":  { yf: "1810.HK",   cur: "HKD" },
  "700.HK":   { yf: "0700.HK",   cur: "HKD" },
  "9618.HK":  { yf: "9618.HK",   cur: "HKD" },
  "9888.HK":  { yf: "9888.HK",   cur: "HKD" },

  // ── DIVIDENDENDEPOT ───────────────────────────────────────────────────────
  "Altria":        { yf: "MO",        cur: "USD" },
  "DHL":           { yf: "DHL.DE",    cur: "EUR" },
  "Mercedes":      { yf: "MBG.DE",    cur: "EUR" },
  "Allianz":       { yf: "ALV.DE",    cur: "EUR" },
  "MunichRe":      { yf: "MUV2.DE",   cur: "EUR" },
  "TotalEnergies": { yf: "TTE.PA",    cur: "EUR" },
  "PepsiCo":       { yf: "PEP",       cur: "USD" },
  "Pfizer":        { yf: "PFE",       cur: "USD" },
  "RioTinto":      { yf: "RIO",       cur: "USD" },
  "JnJ":           { yf: "JNJ",       cur: "USD" },
  "LVMH":          { yf: "MC.PA",     cur: "EUR" },
  "Barratt":       { yf: "BTRW.L",    cur: "GBP" },
  "Carlsberg":     { yf: "CARL-B.CO", cur: "DKK" },
  "TRowe":         { yf: "TROW",      cur: "USD" },
  "BNP":           { yf: "BNP.PA",    cur: "EUR" },
  "RealtyIncome":  { yf: "O",         cur: "USD" },
  "BAT":           { yf: "BTI",       cur: "USD" },
  "Sanofi":        { yf: "SAN.PA",    cur: "EUR" },
  "Mastercard":    { yf: "MA",        cur: "USD" },
  "ATT":           { yf: "T",         cur: "USD" },
  "CME":           { yf: "CME",       cur: "USD" },
  "BBBiotech":     { yf: "BION.SW",   cur: "CHF" },
  "Nestle":        { yf: "NESN.SW",   cur: "CHF" },
  "NNGroup":       { yf: "NN.AS",     cur: "EUR" },
  "IronMountain":  { yf: "IRM",       cur: "USD" },
  "WalmartMex":    { yf: "WALMEX.MX", cur: "MXN" },
  "BankRakyat":    { yf: "BBRI.JK",   cur: "IDR" },
  "ChinaWater":    { yf: "0855.HK",   cur: "HKD" },
  "ASML":          { yf: "ASML.AS",   cur: "EUR" },
  "BroadcomDiv":   { yf: "AVGO",      cur: "USD" },
  "Evolution":     { yf: "EVO.ST",    cur: "SEK" },
  "GSK":           { yf: "GSK",       cur: "USD" },
  "NovoNordisk":   { yf: "NVO",       cur: "USD" },
  "BlackRock":     { yf: "BLK",       cur: "USD" },
  "Unilever":      { yf: "UNA.AS",    cur: "EUR" },
  "MagnumIceCream":{ yf: "CREAM.AS",  cur: "EUR" },
  "Roche":         { yf: "ROG.SW",    cur: "CHF" },
  "DaimlerTruck":  { yf: "DTG.DE",    cur: "EUR" },
  "EON":           { yf: "EOAN.DE",   cur: "EUR" },
  "LangSchwarz":   { yf: "LUS1.DE",   cur: "EUR" },

  // ── EDELMETALLE / KRYPTO (via Yahoo Finance) ──────────────────────────────
  "Gold_USD_oz":   { yf: "GC=F",      cur: "USD" },
  "Bitcoin_USD":   { yf: "BTC-USD",   cur: "USD" },
  "Ethereum_USD":  { yf: "ETH-USD",   cur: "USD" },
  "Silver_USD_oz": { yf: "SI=F",      cur: "USD" },

  // ── INDIZES ───────────────────────────────────────────────────────────────
  "DAX":           { yf: "^GDAXI",    cur: "EUR" },
  "SP500":         { yf: "^GSPC",     cur: "USD" },
  "Nasdaq100":     { yf: "^NDX",      cur: "USD" },
  "Nikkei225":     { yf: "^N225",     cur: "JPY" },
  "BrentOil":      { yf: "BZ=F",      cur: "USD" },
  "VIX":           { yf: "^VIX",      cur: "USD" },
};

// ── Währungspaare für EUR-Umrechnung ─────────────────────────────────────────
// Yahoo Finance: EURUSD=X gibt EUR/USD (wie viele USD pro 1 EUR)
// Für X→EUR: kurs_lokal / (EUR/X-Rate) = kurs_lokal * (1/EURX=X)
// Deshalb speichern wir den Kehrwert: toEUR[CUR] = 1 / yahooRate
const FX_SYMBOLS = {
  "USD": "EURUSD=X",   // EUR/USD — Kehrwert = USD→EUR
  "GBP": "EURGBP=X",   // EUR/GBP — Kehrwert = GBP→EUR
  "CHF": "EURCHF=X",   // EUR/CHF — Kehrwert = CHF→EUR
  "HKD": "EURHKD=X",   // EUR/HKD — Kehrwert = HKD→EUR
  "CAD": "EURCAD=X",   // EUR/CAD — Kehrwert = CAD→EUR
  "AUD": "EURAUD=X",   // EUR/AUD — Kehrwert = AUD→EUR
  "KRW": "EURKRW=X",   // EUR/KRW — Kehrwert = KRW→EUR
  "DKK": "EURDKK=X",   // EUR/DKK — Kehrwert = DKK→EUR
  "SEK": "EURSEK=X",   // EUR/SEK — Kehrwert = SEK→EUR
  "MXN": "EURMXN=X",   // EUR/MXN — Kehrwert = MXN→EUR
  "IDR": "EURIDR=X",   // EUR/IDR — Kehrwert = IDR→EUR
  "JPY": "EURJPY=X",   // EUR/JPY — Kehrwert = JPY→EUR
  "EUR": null,
};

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Intelligentes Runden: kleine Werte (< 0.01) auf 6 Stellen, sonst 2
const round2 = (n) => {
  if (!n || isNaN(n)) return n;
  if (Math.abs(n) < 0.01) return Math.round(n * 1_000_000) / 1_000_000;
  if (Math.abs(n) < 1)    return Math.round(n * 10_000)    / 10_000;
  return Math.round(n * 100) / 100;
};

async function fetchQuote(symbol, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const q = await yf.quote(symbol, {}, { validateResult: false });
      return q?.regularMarketPrice ?? null;
    } catch {
      if (i < retries - 1) await sleep(1000);
    }
  }
  return null;
}

// ── Hauptprogramm ─────────────────────────────────────────────────────────────
console.log("📊 Kursabruf gestartet —", new Date().toLocaleString("de-DE"));

// 1. Wechselkurse laden (toEUR[CUR] = Faktor um Lokalwert in EUR umzurechnen)
console.log("💱 Wechselkurse...");
const toEUR = { EUR: 1 };
for (const [cur, sym] of Object.entries(FX_SYMBOLS)) {
  if (!sym) continue;
  const eurPerX = await fetchQuote(sym);  // z.B. EURUSD=X = 1.163 (EUR/USD)
  if (eurPerX && eurPerX > 0) {
    toEUR[cur] = round2(1 / eurPerX);     // USD→EUR = 1 / 1.163 = 0.8599
    process.stdout.write(`  ${cur}→EUR: ×${toEUR[cur]} (aus ${sym}=${eurPerX})\n`);
  } else {
    console.warn(`  ⚠️  ${cur} Kurs nicht verfügbar`);
  }
  await sleep(150);
}

// 2. Alle Kurse abrufen
console.log("\n📈 Aktienkurse...");
const preise = {};
const fehler = [];
let count = 0;

for (const [key, cfg] of Object.entries(TICKERS)) {
  const raw = await fetchQuote(cfg.yf);
  const cur = cfg.cur;
  count++;

  if (raw === null || raw === undefined) {
    fehler.push({ key, symbol: cfg.yf });
    preise[key] = null;
    process.stdout.write(`  ❌ ${key} (${cfg.yf}) — nicht verfügbar\n`);
  } else {
    const fxRate = toEUR[cur] ?? null;
    const eur = cur === "EUR" ? round2(raw)
      : (fxRate ? round2(raw * fxRate) : null);

    preise[key] = {
      kurs_lokal: round2(raw),
      waehrung: cur,
      kurs_eur: eur,
    };
    const status = eur != null ? `€${eur}` : `${raw} ${cur} (kein FX)`;
    process.stdout.write(`  ✅ ${key.padEnd(16)} ${cfg.yf.padEnd(14)} ${status}\n`);
  }

  // Rate-Limit-Schutz: kurze Pause alle 10 Abfragen
  if (count % 10 === 0) await sleep(500);
  else await sleep(80);
}

// 3. Ergebnis-JSON aufbauen
const now = new Date();
const kw = Math.ceil((((now - new Date(now.getFullYear(), 0, 1)) / 86400000)
  + new Date(now.getFullYear(), 0, 1).getDay() + 1) / 7);

const output = {
  meta: {
    abgerufen: now.toISOString(),
    KW: kw,
    YEAR: now.getFullYear(),
    datum: now.toLocaleDateString("de-DE"),
    quelle: "Yahoo Finance (yahoo-finance2)",
    fehler_count: fehler.length,
    fehler: fehler.map(f => `${f.key} (${f.symbol})`),
  },
  fx_rates: toEUR,
  preise,
};

// 4. Datei schreiben
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(output, null, 2), "utf8");

console.log(`\n✅ ${count - fehler.length}/${count} Kurse erfolgreich abgerufen`);
if (fehler.length > 0) {
  console.warn(`⚠️  ${fehler.length} Ticker nicht verfügbar:`,
    fehler.map(f => f.key).join(", "));
}
console.log(`💾 Gespeichert: ${OUT}`);
