import { createHmac } from "crypto";
import https from "https";
import { existsSync, readFileSync, writeFileSync } from "fs";

// Load .env
readFileSync(new URL(".env", import.meta.url), "utf8")
  .split("\n")
  .forEach((line) => {
    const [k, ...v] = line.split("=");
    if (k && !k.startsWith("#") && v.length)
      process.env[k.trim()] = v.join("=").trim();
  });

const API_KEY = process.env.BITGET_API_KEY;
const SECRET_KEY = process.env.BITGET_SECRET_KEY;
const PASSPHRASE = process.env.BITGET_PASSPHRASE;

const SYMBOL = "XRPUSDT"; // XRP/USDT spot — low price, above min order size
const INTERVAL_MS = 10000; // 10 seconds
const TOTAL_TRADES = 6;

// ── Risikomanagement ─────────────────────────────────────────────
const MAX_POSITION_PCT = 0.25; // max. 25% des GESAMT-Portfoliowerts (USDT+XRP) pro Trade
const STOP_LOSS_PCT = 0.01;    // Market-Sell sobald Kurs 1% unter Kaufpreis fällt
const MAX_RUN_LOSS_PCT = 0.02; // ab 2% kumuliertem Verlust im Lauf: keine neuen Käufe mehr

// ── BitGet helpers ──────────────────────────────────────────────
function sign(ts, method, path, body = "") {
  return createHmac("sha256", SECRET_KEY)
    .update(ts + method + path + body)
    .digest("base64");
}

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const ts = Date.now().toString();
    const bodyStr = body ? JSON.stringify(body) : "";
    const sig = sign(ts, method, path, bodyStr);
    const req = https.request(
      {
        hostname: "api.bitget.com",
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          "ACCESS-KEY": API_KEY,
          "ACCESS-SIGN": sig,
          "ACCESS-TIMESTAMP": ts,
          "ACCESS-PASSPHRASE": PASSPHRASE,
          locale: "en-US",
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(JSON.parse(d)));
      },
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Market data ─────────────────────────────────────────────────
async function getCandles(symbol, limit = 30) {
  // 1-minute candles from BitGet
  const res = await request(
    "GET",
    `/api/v2/spot/market/candles?symbol=${symbol}&granularity=1min&limit=${limit}`,
  );
  // returns [[ts, open, high, low, close, vol], ...]
  return (res.data || []).map((c) => ({
    ts: parseInt(c[0]),
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    vol: parseFloat(c[5]),
  }));
}

async function getPrice(symbol) {
  const res = await request(
    "GET",
    `/api/v2/spot/market/tickers?symbol=${symbol}`,
  );
  return parseFloat(res.data?.[0]?.lastPr || 0);
}

async function getBalances() {
  const res = await request("GET", "/api/v2/spot/account/assets");
  const usdt = res.data?.find((a) => a.coin === "USDT");
  const xrp = res.data?.find((a) => a.coin === "XRP");
  return {
    usdt: parseFloat(usdt?.available || 0),
    xrp: parseFloat(xrp?.available || 0),
  };
}

// ── Indicators ──────────────────────────────────────────────────
function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(closes, period = 3) {
  if (closes.length < period + 1) return 50;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function calcVWAP(candles) {
  // Session VWAP approximation (all candles provided)
  let cumTPV = 0,
    cumVol = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.vol;
    cumVol += c.vol;
  }
  return cumVol === 0 ? candles[candles.length - 1].close : cumTPV / cumVol;
}

// ── Signal logic (mirrors Pine Script) ─────────────────────────
function getSignal(candles) {
  const closes = candles.map((c) => c.close);
  const last = closes[closes.length - 1];

  const ema8 = calcEMA(closes, 8);
  const rsi3 = calcRSI(closes, 3);
  const vwap = calcVWAP(candles);

  const bullBias = last > vwap && last > ema8;
  const bearBias = last < vwap && last < ema8;

  let signal = "flat";
  if (bullBias && rsi3 < 30) signal = "buy";
  else if (bearBias && rsi3 > 70) signal = "sell";

  return { signal, last, ema8, rsi3, vwap };
}

// ── Risikomanagement (reine Funktionen, kein Netzwerk) ───────────

// Kaufgröße in USDT: min. aus verfügbarem USDT-Bestand und MAX_POSITION_PCT
// des GESAMT-Portfoliowerts (USDT + XRP-Bestand zum aktuellen Kurs). Verhindert,
// dass ein einzelner Trade den Großteil des Kontos riskiert (vorher: 90% des
// reinen USDT-Bestands, ohne Rücksicht auf bereits gehaltenes XRP).
export function computeBuySizeUsdt(bals, price, maxPositionPct = MAX_POSITION_PCT) {
  const totalValue = bals.usdt + bals.xrp * price;
  return Math.max(0, Math.min(bals.usdt, totalValue * maxPositionPct));
}

// true, sobald der aktuelle Kurs stopLossPct unter dem Kaufpreis liegt —
// überschreibt das normale Signal (RSI/VWAP), sobald eine Position offen ist.
export function shouldStopLoss(currentPrice, buyPrice, stopLossPct = STOP_LOSS_PCT) {
  if (!buyPrice) return false;
  return currentPrice <= buyPrice * (1 - stopLossPct);
}

// true, sobald der kumulierte realisierte Verlust im aktuellen Lauf die
// maxLossPct-Schwelle des Portfoliowerts zu Laufbeginn erreicht — blockiert
// weitere Käufe (bestehende Positionen können weiterhin per Stop-Loss geschlossen werden).
export function circuitBreakerTripped(runningPnlUsdt, startingTotalValue, maxLossPct = MAX_RUN_LOSS_PCT) {
  if (!startingTotalValue) return false;
  return runningPnlUsdt <= -(startingTotalValue * maxLossPct);
}

// ── Order helpers ───────────────────────────────────────────────
async function placeOrder(side, size) {
  const body = {
    symbol: SYMBOL,
    side,
    orderType: "market",
    force: "gtc",
    size,
  };
  return request("POST", "/api/v2/spot/trade/place-order", body);
}

async function getOrderFill(orderId) {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await request(
      "GET",
      `/api/v2/spot/trade/orderInfo?orderId=${orderId}&symbol=${SYMBOL}`,
    );
    const fill = parseFloat(res.data?.baseVolume || 0);
    if (fill > 0) return fill;
  }
  return 0;
}

// BitGet locks newly purchased assets against immediate resale (anti-wash-trading).
// This retries the sell, parsing the actually-available amount from the error
// message until the lock lifts or we time out.
async function placeSellWithRetry(qty, maxRetries = 12, retryDelayMs = 3000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const size = (Math.floor(qty * 10000) / 10000).toFixed(4);
    const res = await placeOrder("sell", size);

    if (res.code === "00000")
      return { ok: true, res, soldQty: parseFloat(size) };

    // Parse available qty from lock error: "0.001234XRP can be used at most"
    const lockMatch = res.msg?.match(/([\d.]+)XRP can be used at most/i);
    if (lockMatch) {
      const available = parseFloat(lockMatch[1]);
      console.log(
        `  🔒 Lock active — only ${available} XRP tradeable. Retry ${attempt}/${maxRetries} in ${retryDelayMs / 1000}s...`,
      );
      await new Promise((r) => setTimeout(r, retryDelayMs));
      continue;
    }

    // Any other error — don't retry
    return { ok: false, res, soldQty: 0 };
  }
  return {
    ok: false,
    res: { msg: "Sell lock never lifted after retries" },
    soldQty: 0,
  };
}

// ── Main loop ───────────────────────────────────────────────────
async function main() {
  console.log(`\n🤖 BTC Scalper — VWAP + RSI(3) + EMA(8)`);
  console.log(
    `Symbol: ${SYMBOL} | ${TOTAL_TRADES} trades × ${INTERVAL_MS / 1000}s\n`,
  );

  const log = [];
  let holding = "usdt";
  let lastBuyXrpQty = 0;
  let buyPrice = null;        // Einstiegspreis der offenen Position (für Stop-Loss)
  let buyUsdtSpent = 0;       // Kostenbasis der offenen Position (für PnL-Tracking)
  let startingTotalValue = null;
  let runningPnlUsdt = 0;     // kumulierter realisierter Gewinn/Verlust im Lauf
  let circuitBreakerHit = false;

  for (let i = 1; i <= TOTAL_TRADES; i++) {
    const ts = new Date().toISOString();
    const candles = await getCandles(SYMBOL, 30);
    const { signal, last, ema8, rsi3, vwap } = getSignal(candles);
    const bals = await getBalances();

    if (startingTotalValue == null) startingTotalValue = bals.usdt + bals.xrp * last;

    console.log(`[${i}/${TOTAL_TRADES}] ${ts}`);
    console.log(
      `  Price: $${last.toFixed(4)} | EMA8: ${ema8.toFixed(4)} | RSI3: ${rsi3.toFixed(1)} | VWAP: ${vwap.toFixed(4)}`,
    );
    console.log(
      `  USDT: $${bals.usdt.toFixed(4)} | XRP: ${bals.xrp.toFixed(4)} | Signal: ${signal.toUpperCase()} | Lauf-PnL: $${runningPnlUsdt.toFixed(4)}`,
    );

    let side, size, label, stopLoss = false;
    const entry = {
      tick: i,
      timestamp: ts,
      price: last,
      ema8,
      rsi3,
      vwap,
      signal,
      orderPlaced: false,
    };

    // Stop-Loss hat Vorrang vor dem normalen Signal, sobald eine Position offen ist.
    if (holding === "xrp" && lastBuyXrpQty >= 1 && shouldStopLoss(last, buyPrice)) {
      side = "sell";
      stopLoss = true;
      size = (Math.floor(lastBuyXrpQty * 10000) / 10000).toFixed(4);
      label = `STOP-LOSS SELL ${size} XRP (Kurs $${last.toFixed(4)} ≤ ${(STOP_LOSS_PCT * 100).toFixed(1)}% unter Kauf $${buyPrice.toFixed(4)})`;
      holding = "usdt";
    } else if (
      signal === "buy" &&
      holding === "usdt" &&
      bals.usdt >= 1 &&
      !circuitBreakerTripped(runningPnlUsdt, startingTotalValue)
    ) {
      side = "buy";
      const buySizeUsdt = computeBuySizeUsdt(bals, last);
      if (buySizeUsdt < 1) {
        const reason = `buy size $${buySizeUsdt.toFixed(4)} below min order size (${(MAX_POSITION_PCT * 100).toFixed(0)}% Positions-Cap)`;
        console.log(`  ⏭  Skip — ${reason}\n`);
        entry.skipped = true;
        entry.skipReason = reason;
        log.push(entry);
        if (i < TOTAL_TRADES) await new Promise((r) => setTimeout(r, INTERVAL_MS));
        continue;
      }
      size = buySizeUsdt.toFixed(4);
      label = `BUY XRP with $${size} USDT (${(MAX_POSITION_PCT * 100).toFixed(0)}% Portfolio-Cap)`;
      holding = "xrp";
    } else if (signal === "sell" && holding === "xrp" && lastBuyXrpQty >= 1) {
      side = "sell";
      size = (Math.floor(lastBuyXrpQty * 10000) / 10000).toFixed(4);
      label = `SELL ${size} XRP → USDT`;
      holding = "usdt";
    } else {
      let reason;
      if (signal === "buy" && circuitBreakerTripped(runningPnlUsdt, startingTotalValue)) {
        reason = `circuit breaker tripped (Lauf-Verlust ≥ ${(MAX_RUN_LOSS_PCT * 100).toFixed(1)}%) — keine neuen Käufe`;
        circuitBreakerHit = true;
      } else {
        reason =
          signal === "flat"
            ? "no signal — conditions not met"
            : `signal=${signal} but holding=${holding} (waiting for right side)`;
      }
      console.log(`  ⏭  Skip — ${reason}\n`);
      entry.skipped = true;
      entry.skipReason = reason;
      log.push(entry);
      if (i < TOTAL_TRADES)
        await new Promise((r) => setTimeout(r, INTERVAL_MS));
      continue;
    }

    console.log(`  → ${label}`);
    entry.side = side;
    entry.size = size;
    entry.stopLoss = stopLoss;

    if (side === "buy") {
      const res = await placeOrder("buy", size);
      const ok = res.code === "00000";
      const orderId = res.data?.orderId;
      entry.orderId = orderId || res.msg;
      entry.orderPlaced = ok;

      if (ok) {
        console.log(`  ✅ BUY PLACED — ${orderId}`);
        lastBuyXrpQty = await getOrderFill(orderId);
        buyPrice = last;
        buyUsdtSpent = parseFloat(size);
        console.log(
          `  📦 Filled: ${lastBuyXrpQty.toFixed(4)} XRP — waiting for lock to clear...`,
        );
        entry.filledQty = lastBuyXrpQty;
      } else {
        console.log(`  ❌ Rejected: ${res.msg}`);
        holding = "usdt";
      }
    } else {
      // Use retry loop — handles BitGet's anti-wash-trading lock automatically
      const { ok, res, soldQty } = await placeSellWithRetry(lastBuyXrpQty);
      entry.orderId = res.data?.orderId || res.msg;
      entry.orderPlaced = ok;

      if (ok) {
        const proceeds = soldQty * last;
        const pnl = proceeds - buyUsdtSpent;
        runningPnlUsdt += pnl;
        entry.pnlUsdt = +pnl.toFixed(4);
        console.log(
          `  ✅ SELL PLACED — ${entry.orderId} (${soldQty.toFixed(4)} XRP) | PnL: $${pnl.toFixed(4)} | Lauf-PnL: $${runningPnlUsdt.toFixed(4)}`,
        );
        lastBuyXrpQty = 0;
        buyPrice = null;
        buyUsdtSpent = 0;
      } else {
        console.log(`  ❌ Sell failed: ${res.msg}`);
        holding = "xrp"; // still holding
      }
    }

    log.push(entry);

    if (i < TOTAL_TRADES) {
      const waitMs =
        side === "buy" ? Math.max(INTERVAL_MS - 5000, 4000) : INTERVAL_MS;
      console.log(`  ⏱  Next in ${waitMs / 1000}s...\n`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  // Offene Position am Lauf-Ende zwangsschließen — vorher blieb eine noch gehaltene
  // Position beim Skript-Ende einfach unbeaufsichtigt offen liegen.
  if (holding === "xrp" && lastBuyXrpQty >= 1) {
    console.log(`\n🔚 Lauf beendet, Position noch offen — Force-Close ${lastBuyXrpQty.toFixed(4)} XRP...`);
    const { ok, res, soldQty } = await placeSellWithRetry(lastBuyXrpQty);
    const forceClosePrice = await getPrice(SYMBOL);
    const entry = {
      tick: TOTAL_TRADES + 1,
      timestamp: new Date().toISOString(),
      side: "sell",
      forceClose: true,
      orderPlaced: ok,
      orderId: res.data?.orderId || res.msg,
    };
    if (ok) {
      const pnl = soldQty * forceClosePrice - buyUsdtSpent;
      runningPnlUsdt += pnl;
      entry.pnlUsdt = +pnl.toFixed(4);
      console.log(`  ✅ FORCE-CLOSE PLACED — ${entry.orderId} (${soldQty.toFixed(4)} XRP) | PnL: $${pnl.toFixed(4)}`);
      holding = "usdt";
    } else {
      console.log(`  ❌ Force-Close fehlgeschlagen: ${res.msg} — Position bleibt offen, manuell prüfen!`);
    }
    log.push(entry);
  }

  if (circuitBreakerHit) {
    console.log(`\n🛑 Circuit-Breaker ausgelöst — Lauf-Verlust erreichte ${(MAX_RUN_LOSS_PCT * 100).toFixed(1)}% des Startwerts.`);
  }

  const final = await getBalances();
  const price = await getPrice(SYMBOL);
  const totalValue = final.usdt + final.xrp * price;
  console.log(`\n📊 Final:`);
  console.log(`  USDT: $${final.usdt.toFixed(4)}`);
  console.log(
    `  XRP: ${final.xrp.toFixed(4)} (≈$${(final.xrp * price).toFixed(4)})`,
  );
  console.log(`  Total est. value: $${totalValue.toFixed(4)}`);

  const placed = log.filter((e) => e.orderPlaced).length;
  console.log(`\n✅ Done — ${placed}/${TOTAL_TRADES} orders placed.\n`);

  const existing = existsSync("safety-check-log.json")
    ? JSON.parse(readFileSync("safety-check-log.json", "utf8"))
    : [];
  writeFileSync(
    "safety-check-log.json",
    JSON.stringify([...existing, ...log], null, 2),
  );
}

// Nur bei direktem Aufruf ("node scalper-run.js") starten, nicht beim Import
// (z.B. durch Tests, die nur die reinen Risiko-Funktionen oben testen wollen —
// ein versehentlicher main()-Lauf würde echte Trades mit echtem Geld auslösen).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fatal:", err.message);
    process.exit(1);
  });
}
