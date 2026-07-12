// test-yf.mjs — Yahoo Finance v3 Verbindungstest
import YahooFinance from 'yahoo-finance2';  // Default-Export (v3)
import { writeFileSync } from 'fs';

const yf = new YahooFinance();

const OUT = '/Users/macbook-robse/tradingview-mcp-jackson/tmp/yf_test_result.json';
const results = {};

const tests = [
  ['YSN.DE',   'Secunet (XETRA)'],
  ['EURUSD=X', 'EUR/USD FX'],
  ['^N225',    'Nikkei 225'],
  ['NVDA',     'Nvidia (USD)'],
  ['ALV.DE',   'Allianz (EUR)'],
  ['MBG.DE',   'Mercedes (EUR)'],
  ['0700.HK',  'Tencent (HKD)'],
  ['BTC-USD',  'Bitcoin'],
];

for (const [sym, name] of tests) {
  try {
    const q = await yf.quote(sym, {}, { validateResult: false });
    const price = q?.regularMarketPrice;
    const cur   = q?.currency;
    results[sym] = { name, price, cur };
    process.stdout.write(`✅ ${name.padEnd(20)} ${sym.padEnd(12)} = ${price} ${cur}\n`);
  } catch (e) {
    results[sym] = { name, error: e.message.slice(0, 80) };
    process.stdout.write(`❌ ${name.padEnd(20)} ${sym.padEnd(12)} → ${e.message.slice(0, 60)}\n`);
  }
}

writeFileSync(OUT, JSON.stringify(results, null, 2));
process.stdout.write(`\n💾 Ergebnis: ${OUT}\n`);
