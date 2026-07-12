import { evaluate } from './connection.js';

const DEFAULT_TIMEOUT = 10000;
const POLL_INTERVAL = 200;

export async function waitForChartReady(expectedSymbol = null, expectedTf = null, timeout = DEFAULT_TIMEOUT) {
  const start = Date.now();
  let lastBarCount = -1;
  let stableCount = 0;

  while (Date.now() - start < timeout) {
    const state = await evaluate(`
      (function() {
        // Check for loading spinner
        var spinner = document.querySelector('[class*="loader"]')
          || document.querySelector('[class*="loading"]')
          || document.querySelector('[data-name="loading"]');
        var isLoading = spinner && spinner.offsetParent !== null;

        // Get current symbol AND last loaded close price via chartWidget API.
        // cw.getSymbol() reflects the JS-requested symbol (updates immediately).
        // lastClose from the series data model reflects the VISUALLY LOADED data —
        // this changes only after the chart has actually fetched + rendered new bars.
        var currentSymbol = '';
        var lastClose     = -1;
        var barCount      = -1;
        try {
          var coll = window.TradingViewApi._chartWidgetCollection;
          var cw   = coll._chartWidgetsDefs[coll._activeIndex || 0].chartWidget;
          currentSymbol = cw.getSymbol() || '';
          // Try to read last bar close from the data model (confirms visual data load)
          try {
            var model  = cw._chartWidget.model();
            var series = model.mainSeries();
            var barsObj = series.bars();
            var lastIdx = barsObj.lastIndex();
            if (lastIdx >= 0) {
              var lastBar = barsObj.valueAt(lastIdx);
              // Bar format: [time, open, high, low, close, volume] or similar
              if (lastBar && lastBar.length >= 5) lastClose = lastBar[4];
              barCount = lastIdx - barsObj.firstIndex();
            }
          } catch(e2) {
            // Fallback: count DOM elements with "bar" in class — unreliable but better than nothing
            try { barCount = document.querySelectorAll('[class*="bar"]').length; } catch {}
          }
        } catch(e) {}

        return { isLoading: !!isLoading, barCount: barCount, lastClose: lastClose, currentSymbol: currentSymbol };
      })()
    `);

    if (!state) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    // Not ready if still loading
    if (state.isLoading) {
      stableCount = 0;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    // Check symbol match if expected
    // DOM shows bare ticker (e.g. "0NUX"), expectedSymbol may be "NYSE:0NUX" or "LSIN_DLY:0NUX"
    // Strip exchange prefix and _DLY suffix before comparing.
    // If DOM element is empty (not found yet), treat as "not ready" too.
    if (expectedSymbol) {
      const rawTicker = expectedSymbol.includes(':') ? expectedSymbol.split(':').pop() : expectedSymbol;
      const expectedTicker = rawTicker.toUpperCase();
      if (!state.currentSymbol || !state.currentSymbol.toUpperCase().includes(expectedTicker)) {
        stableCount = 0;
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
        continue;
      }
    }

    // Check bar count stability
    if (state.barCount === lastBarCount && state.barCount > 0) {
      stableCount++;
    } else {
      stableCount = 0;
    }
    lastBarCount = state.barCount;

    if (stableCount >= 2) {
      return true;
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  // Timeout — return true anyway, caller should verify
  return false;
}
