import { spawn, execSync } from "node:child_process";

// ── TradingView Auto-Start ───────────────────────────────────────────────────

const TV_BINARY = "/Applications/TradingView.app/Contents/MacOS/TradingView";
const CDP_URL   = "http://127.0.0.1:9222/json/version";

export async function isCdpAlive() {
  try {
    const res = await fetch(CDP_URL, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function activateTradingView() {
  if (process.platform !== "darwin") return;
  try {
    execSync('osascript -e \'tell application "TradingView" to activate\'', { timeout: 5000 });
    await new Promise(r => setTimeout(r, 1000));
  } catch (e) {
    console.warn("⚠️  TradingView konnte nicht in den Vordergrund gebracht werden:", e.message?.split("\n")[0]);
  }
}

export async function ensureTradingViewRunning() {
  if (await isCdpAlive()) {
    console.log("✅ TradingView läuft bereits (CDP aktiv).");
    await activateTradingView();
    await waitForUiReady();
    await ensureChartLoaded();
    await waitForUiReady(60_000);
    return;
  }

  console.log("🚀 TradingView nicht gefunden — starte mit CDP…");

  // Bestehende Instanz ohne CDP beenden
  try {
    const kill = spawn("pkill", ["-f", "TradingView.app/Contents/MacOS/TradingView"], { stdio: "ignore" });
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
      console.log("⏳ Warte auf vollständiges UI-Laden…");
      await activateTradingView();
      await waitForUiReady();
      await ensureChartLoaded();
      // Nach Navigation (ensureChartLoaded) nochmal UI-Bereitschaft prüfen —
      // die Seite wurde neu geladen und braucht Zeit für Watchlist-Button etc.
      await waitForUiReady(60_000);
      return;
    }
    process.stdout.write(".");
  }
  throw new Error("TradingView hat CDP nach 60 Sekunden nicht geöffnet.");
}

/**
 * Prüft ob ein Chart geladen ist (TradingViewApi verfügbar).
 * Falls nicht (z.B. "Neuer Tab"-Zustand), wird das zuletzt gespeicherte
 * Layout automatisch aus dem Supercharts-Menü geöffnet.
 */
export async function ensureChartLoaded(maxWaitMs = 60_000) {
  const { default: CDP } = await import("chrome-remote-interface");
  let client;

  // Hilfsfunktion: frische CDP-Verbindung herstellen (mit Retry nach Seiten-Navigation)
  async function freshConnect(retries = 8, delayMs = 3000) {
    for (let i = 0; i < retries; i++) {
      try {
        if (client) { try { await client.close(); } catch {} client = null; }
        client = await CDP({ port: 9222 });
        return true;
      } catch { await new Promise(r => setTimeout(r, delayMs)); }
    }
    return false;
  }

  try {
    if (!await freshConnect()) {
      console.warn("⚠️  ensureChartLoaded: CDP nicht erreichbar.");
      return;
    }

    // Prüfen ob Chart-API bereits verfügbar
    const { result: apiCheck } = await client.Runtime.evaluate({
      expression: `!!(window.TradingViewApi && window.TradingViewApi._activeChartWidgetWV)`,
      returnByValue: true,
    });

    if (apiCheck?.value === true) {
      console.log("✅ Chart API verfügbar — Chart ist geladen.");
      return;
    }

    // Chart API nicht verfügbar → zur Chart-URL navigieren
    console.warn("⚠️  Kein Chart geladen — navigiere zu TradingView Chart…");
    await new Promise((r) => setTimeout(r, 1000));

    // Erst nach vorhandenen Chart-Links im DOM suchen
    let navTarget = null;
    try {
      const { result: layoutLinks } = await client.Runtime.evaluate({
        expression: `
          (function() {
            var links = Array.from(document.querySelectorAll('a[href*="/chart/"]'));
            if (links.length > 0) return links[0].href;
            var cards = Array.from(document.querySelectorAll('[class*="layoutCard"],[class*="chart-card"],[class*="layout-card"]'));
            if (cards.length > 0) { cards[0].click(); return 'clicked_card'; }
            return null;
          })()
        `,
        returnByValue: true,
      });
      navTarget = layoutLinks?.value ?? null;
    } catch {}

    if (navTarget === 'clicked_card') {
      console.log("✅ Layout-Karte geklickt.");
    } else {
      const url = (navTarget && navTarget !== 'clicked_card')
        ? navTarget
        : 'https://www.tradingview.com/chart/';
      // Navigation startet — WebSocket-Verbindung wird dabei getrennt (readyState → CLOSED)
      try {
        const safeUrl = url.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        await client.Runtime.evaluate({ expression: `window.location.href = '${safeUrl}'`, returnByValue: true });
      } catch { /* Normale WebSocket-Trennung nach Navigation — ignorieren */ }
      console.log(`✅ Navigiere zu: ${url}`);

      // Alten Client schließen — WebSocket ist nach Navigation ohnehin tot
      try { await client.close(); } catch {}
      client = null;

      // Kurz warten bis Seite zu laden beginnt
      await new Promise((r) => setTimeout(r, 5000));
    }

    // Warten bis Chart-API auf der neuen Seite verfügbar ist (max. maxWaitMs)
    // Nach Navigation muss frisch reconnectet werden
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      try {
        if (!client) {
          client = await CDP({ port: 9222 });
          await client.Runtime.enable();
        }
        const { result: ready } = await client.Runtime.evaluate({
          expression: `!!(window.TradingViewApi && window.TradingViewApi._activeChartWidgetWV)`,
          returnByValue: true,
        });
        if (ready?.value === true) {
          console.log("✅ Chart nach Navigation geladen.");
          await new Promise((r) => setTimeout(r, 3000));
          return;
        }
        // Login-Seite erkennen (Session abgelaufen)
        const { result: loc } = await client.Runtime.evaluate({
          expression: `window.location.href`,
          returnByValue: true,
        });
        if (loc?.value && /\/accounts\/signin/i.test(loc.value)) {
          console.warn("⚠️  TradingView Session abgelaufen — Login-Seite erkannt.");
          break;
        }
      } catch {
        // WebSocket noch nicht bereit (Seite lädt noch) — neu verbinden
        try { await client?.close(); } catch {}
        client = null;
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      process.stdout.write("·");
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.warn("\n⚠️  Chart nach 60s immer noch nicht geladen — Brief wird trotzdem fortgesetzt.");
  } catch (e) {
    console.warn(`⚠️  ensureChartLoaded: ${e.message}`);
  } finally {
    try { await client?.close(); } catch {}
  }
}

/** Wartet bis das Chart-Canvas im DOM sichtbar ist (max. 45s).
 *  pane-canvas ist zuverlässiger als watchlists-button, weil das Panel ein Flyout ist
 *  und watchlists-button nur kurz sichtbar ist wenn das Panel offen ist.
 */
export async function waitForUiReady(maxMs = 45_000) {
  const { default: CDP } = await import("chrome-remote-interface");
  const deadline = Date.now() + maxMs;
  let client;
  try {
    while (Date.now() < deadline) {
      try {
        if (!client) client = await CDP({ port: 9222 });
        const { result } = await client.Runtime.evaluate({
          expression: `!!document.querySelector('[data-name="pane-canvas"]')`,
          returnByValue: true,
        });
        if (result?.value === true) {
          console.log("✅ UI bereit (Chart-Canvas gefunden).");
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
