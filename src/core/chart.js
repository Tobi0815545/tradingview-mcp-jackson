/**
 * Core chart control logic.
 */
import { evaluate, evaluateAsync, escapeJS } from '../connection.js';
import { waitForChartReady } from '../wait.js';

// CHART_API: für Indicators, Studies, Drawings (getAllStudies, createStudy, etc.)
const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

// CHART_WIDGET: für Symbol- und Timeframe-Switching (visuelles Chart-Rendering)
// _chartWidgetsDefs[activeIndex].chartWidget ist der korrekte Handle für den sichtbaren Chart.
// _activeChartWidgetWV aktualisiert nur den internen JS-State, triggert aber kein Re-Render.
const CHART_WIDGET = '(function(){ var c=window.TradingViewApi._chartWidgetCollection; return c._chartWidgetsDefs[c._activeIndex||0].chartWidget; })()';

export async function getState() {
  const state = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var cw = ${CHART_WIDGET};
      var studies = [];
      try {
        var allStudies = chart.getAllStudies();
        studies = allStudies.map(function(s) {
          return { id: s.id, name: s.name || s.title || 'unknown' };
        });
      } catch(e) {}
      return {
        symbol: cw.getSymbol(),
        resolution: cw.getResolution(),
        chartType: chart.chartType(),
        studies: studies,
      };
    })()
  `);
  return { success: true, ...state };
}

export async function setSymbol({ symbol, waitTimeout = 10000 }) {
  // Retry up to 3 times — TradingView can throw "Value is null" inside _symbolSource
  // when the chart is temporarily in an inconsistent state (e.g., after scanner finishes).
  const MAX_ATTEMPTS = 3;
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // Progressive delay: 2s after 1st fail, 4s after 2nd fail
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
    try {
      await evaluateAsync(`
        (function() {
          var cw = ${CHART_WIDGET};
          return new Promise(function(resolve, reject) {
            try {
              cw.setSymbol('${escapeJS(symbol)}', {});
              setTimeout(resolve, 800);
            } catch(e) {
              reject(e);
            }
          });
        })()
      `);
      const ready = await waitForChartReady(symbol, null, waitTimeout);
      return { success: true, symbol, chart_ready: ready };
    } catch (err) {
      lastErr = err;
      console.warn(`setSymbol attempt ${attempt + 1}/${MAX_ATTEMPTS} failed: ${err.message}`);
    }
  }
  throw lastErr;
}

export async function setTimeframe({ timeframe }) {
  await evaluate(`
    (function() {
      var cw = ${CHART_WIDGET};
      cw.setResolution('${escapeJS(timeframe)}', {});
    })()
  `);
  const ready = await waitForChartReady(null, timeframe);
  return { success: true, timeframe, chart_ready: ready };
}

export async function setType({ chart_type }) {
  const typeMap = {
    'Bars': 0, 'Candles': 1, 'Line': 2, 'Area': 3,
    'Renko': 4, 'Kagi': 5, 'PointAndFigure': 6, 'LineBreak': 7,
    'HeikinAshi': 8, 'HollowCandles': 9,
  };
  const typeNum = typeMap[chart_type] ?? Number(chart_type);
  if (isNaN(typeNum)) {
    throw new Error(`Unknown chart type: ${chart_type}. Use a name (Candles, Line, etc.) or number (0-9).`);
  }
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setChartType(${typeNum});
    })()
  `);
  return { success: true, chart_type, type_num: typeNum };
}

export async function manageIndicator({ action, indicator, entity_id, inputs: inputsRaw }) {
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;

  if (action === 'add') {
    const inputArr = inputs ? Object.entries(inputs).map(([k, v]) => ({ id: k, value: v })) : [];
    const before = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.createStudy('${escapeJS(indicator)}', false, false, ${JSON.stringify(inputArr)});
      })()
    `);
    await new Promise(r => setTimeout(r, 1500));
    const after = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    const newIds = (after || []).filter(id => !(before || []).includes(id));
    return { success: newIds.length > 0, action: 'add', indicator, entity_id: newIds[0] || null, new_study_count: newIds.length };
  } else if (action === 'remove') {
    if (!entity_id) throw new Error('entity_id required for remove action. Use chart_get_state to find study IDs.');
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.removeEntity('${escapeJS(entity_id)}');
      })()
    `);
    return { success: true, action: 'remove', entity_id };
  } else {
    throw new Error('action must be "add" or "remove"');
  }
}

export async function getVisibleRange() {
  const result = await evaluate(`
    (function() {
      var cw = (function(){
        var c = window.TradingViewApi._chartWidgetCollection;
        return c._chartWidgetsDefs[c._activeIndex || 0].chartWidget;
      })();
      var m  = cw.model();
      var ts = m.timeScale();
      try {
        var barsRange = ts.visibleBarsStrictRange ? ts.visibleBarsStrictRange() : null;
        // Fallback: try chart API for high-level range
        var chart = ${CHART_API};
        var apiRange = chart.getVisibleRange ? chart.getVisibleRange() : null;
        return { visible_range: apiRange, bars_range: barsRange };
      } catch(e) {
        return { visible_range: null, bars_range: null, error: e.message };
      }
    })()
  `);
  return { success: true, visible_range: result?.visible_range, bars_range: result?.bars_range };
}

export async function setVisibleRange({ from, to, extraBarsRight = 0 }) {
  await evaluate(`
    (function() {
      // WICHTIG: CHART_WIDGET (der visuell gerenderte Chart) verwenden, NICHT CHART_API._chartWidget.
      // CHART_API ist ein WV-Wrapper mit eigenem internem _chartWidget — Änderungen dort
      // wirken sich NICHT auf den sichtbaren Chart aus.
      var cw = (function(){
        var c = window.TradingViewApi._chartWidgetCollection;
        return c._chartWidgetsDefs[c._activeIndex || 0].chartWidget;
      })();
      var m  = cw.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx   = bars.lastIndex();

      // Auto-detect timestamp unit: TradingView internal bars may store unix seconds
      // OR milliseconds depending on version. Check first bar to decide.
      var firstVal  = bars.valueAt(startIdx);
      var firstTime = (firstVal && firstVal[0]) ? firstVal[0] : 0;
      var scale     = firstTime > 1e12 ? 1000 : 1;
      var fromScaled = ${Number(from) || 0} * scale;
      var toScaled   = ${Number(to) || 0}   * scale;

      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= fromScaled && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= toScaled) toIdx = i;
      }
      // extraBarsRight: leerer Raum rechts des letzten Bars (für R/R-Zonen sichtbar)
      ts.zoomToBarsRange(fromIdx, toIdx + ${Number(extraBarsRight) || 0});
    })()
  `);
  await new Promise(r => setTimeout(r, 500));
  const actual = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      try { var r = chart.getVisibleRange(); return { from: r.from || 0, to: r.to || 0 }; }
      catch(e) { return { from: 0, to: 0, error: e.message }; }
    })()
  `);
  return { success: true, requested: { from, to }, actual: actual || { from: 0, to: 0 } };
}

export async function scrollToDate({ date }) {
  let timestamp;
  if (/^\d+$/.test(date)) timestamp = Number(date);
  else timestamp = Math.floor(new Date(date).getTime() / 1000);
  if (isNaN(timestamp)) throw new Error(`Could not parse date: ${date}. Use ISO format (2024-01-15) or unix timestamp.`);

  const resolution = await evaluate(`${CHART_API}.resolution()`);
  let secsPerBar = 60;
  const res = String(resolution);
  if (res === 'D' || res === '1D') secsPerBar = 86400;
  else if (res === 'W' || res === '1W') secsPerBar = 604800;
  else if (res === 'M' || res === '1M') secsPerBar = 2592000;
  else { const mins = parseInt(res, 10); if (!isNaN(mins)) secsPerBar = mins * 60; }

  const halfWindow = 25 * secsPerBar;
  const from = timestamp - halfWindow;
  const to = timestamp + halfWindow;

  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${from} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${to}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await new Promise(r => setTimeout(r, 500));
  return { success: true, date, centered_on: timestamp, resolution, window: { from, to } };
}

export async function symbolInfo() {
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var info = chart.symbolExt();
      return {
        symbol: info.symbol, full_name: info.full_name, exchange: info.exchange,
        description: info.description, type: info.type, pro_name: info.pro_name,
        typespecs: info.typespecs, resolution: chart.resolution(), chart_type: chart.chartType()
      };
    })()
  `);
  return { success: true, ...result };
}

export async function symbolSearch({ query, type }) {
  // Use TradingView's public symbol search REST API (works without auth)
  const params = new URLSearchParams({
    text: query,
    hl: '1',
    exchange: '',
    lang: 'en',
    search_type: type || '',
    domain: 'production',
  });

  const resp = await fetch(`https://symbol-search.tradingview.com/symbol_search/v3/?${params}`, {
    headers: { 'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/' },
  });
  if (!resp.ok) throw new Error(`Symbol search API returned ${resp.status}`);
  const data = await resp.json();

  const strip = s => (s || '').replace(/<\/?em>/g, '');
  const results = (data.symbols || data || []).slice(0, 15).map(r => ({
    symbol: strip(r.symbol),
    description: strip(r.description),
    exchange: r.exchange || r.prefix || '',
    type: r.type || '',
    full_name: r.exchange ? `${r.exchange}:${strip(r.symbol)}` : strip(r.symbol),
  }));

  return { success: true, query, source: 'rest_api', results, count: results.length };
}
