# TradingView MCP — Claude Instructions

68 tools for reading and controlling a live TradingView Desktop chart via CDP (port 9222).

## Decision Tree — Which Tool When

### "What's on my chart right now?"
1. `chart_get_state` → symbol, timeframe, chart type, list of all indicators with entity IDs
2. `data_get_study_values` → current numeric values from all visible indicators (RSI, MACD, BBands, EMAs, etc.)
3. `quote_get` → real-time price, OHLC, volume for current symbol

### "What levels/lines/labels are showing?"
Custom Pine indicators draw with `line.new()`, `label.new()`, `table.new()`, `box.new()`. These are invisible to normal data tools. Use:

1. `data_get_pine_lines` → horizontal price levels drawn by indicators (deduplicated, sorted high→low)
2. `data_get_pine_labels` → text annotations with prices (e.g., "PDH 24550", "Bias Long ✓")
3. `data_get_pine_tables` → table data formatted as rows (e.g., session stats, analytics dashboards)
4. `data_get_pine_boxes` → price zones / ranges as {high, low} pairs

Use `study_filter` parameter to target a specific indicator by name substring (e.g., `study_filter: "Profiler"`).

### "Give me price data"
- `data_get_ohlcv` with `summary: true` → compact stats (high, low, range, change%, avg volume, last 5 bars)
- `data_get_ohlcv` without summary → all bars (use `count` to limit, default 100)
- `quote_get` → single latest price snapshot

### "Analyze my chart" (full report workflow)
1. `quote_get` → current price
2. `data_get_study_values` → all indicator readings
3. `data_get_pine_lines` → key price levels from custom indicators
4. `data_get_pine_labels` → labeled levels with context (e.g., "Settlement", "ASN O/U")
5. `data_get_pine_tables` → session stats, analytics tables
6. `data_get_ohlcv` with `summary: true` → price action summary
7. `capture_screenshot` → visual confirmation

### "Change the chart"
- `chart_set_symbol` → switch ticker (e.g., "AAPL", "ES1!", "NYMEX:CL1!")
- `chart_set_timeframe` → switch resolution (e.g., "1", "5", "15", "60", "D", "W")
- `chart_set_type` → switch chart style (Candles, HeikinAshi, Line, Area, Renko, etc.)
- `chart_manage_indicator` → add or remove studies (use full name: "Relative Strength Index", not "RSI")
- `chart_scroll_to_date` → jump to a date (ISO format: "2025-01-15")
- `chart_set_visible_range` → zoom to exact date range (unix timestamps)

### "Work on Pine Script"
1. `pine_set_source` → inject code into editor
2. `pine_smart_compile` → compile with auto-detection + error check
3. `pine_get_errors` → read compilation errors
4. `pine_get_console` → read log.info() output
5. `pine_get_source` → read current code back (WARNING: can be very large for complex scripts)
6. `pine_save` → save to TradingView cloud
7. `pine_new` → create blank indicator/strategy/library
8. `pine_open` → load a saved script by name

### "Practice trading with replay"
1. `replay_start` with `date: "2025-03-01"` → enter replay mode
2. `replay_step` → advance one bar
3. `replay_autoplay` → auto-advance (set speed with `speed` param in ms)
4. `replay_trade` with `action: "buy"/"sell"/"close"` → execute trades
5. `replay_status` → check position, P&L, current date
6. `replay_stop` → return to realtime

### "Screen multiple symbols"
- `batch_run` with `symbols: ["ES1!", "NQ1!", "YM1!"]` and `action: "screenshot"` or `"get_ohlcv"`

### "Draw on the chart"
- `draw_shape` → horizontal_line, trend_line, rectangle, text (pass point + optional point2)
- `draw_list` → see what's drawn
- `draw_remove_one` → remove by ID
- `draw_clear` → remove all

### "Manage alerts"
- `alert_create` → set price alert (condition: "crossing", "greater_than", "less_than")
- `alert_list` → view active alerts
- `alert_delete` → remove alerts

### "Navigate the UI"
- `ui_open_panel` → open/close pine-editor, strategy-tester, watchlist, alerts, trading
- `ui_click` → click buttons by aria-label, text, or data-name
- `layout_switch` → load a saved layout by name
- `ui_fullscreen` → toggle fullscreen
- `capture_screenshot` → take a screenshot (regions: "full", "chart", "strategy_tester")

### "TradingView isn't running"
- `tv_launch` → auto-detect and launch TradingView with CDP on Mac/Win/Linux
- `tv_health_check` → verify connection is working

## Context Management Rules

These tools can return large payloads. Follow these rules to avoid context bloat:

1. **Always use `summary: true` on `data_get_ohlcv`** unless you specifically need individual bars
2. **Always use `study_filter`** on pine tools when you know which indicator you want — don't scan all studies unnecessarily
3. **Never use `verbose: true`** on pine tools unless the user specifically asks for raw drawing data with IDs/colors
4. **Avoid calling `pine_get_source`** on complex scripts — it can return 200KB+. Only read if you need to edit the code.
5. **Avoid calling `data_get_indicator`** on protected/encrypted indicators — their inputs are encoded blobs. Use `data_get_study_values` instead for current values.
6. **Use `capture_screenshot`** for visual context instead of pulling large datasets — a screenshot is ~300KB but gives you the full visual picture
7. **Call `chart_get_state` once** at the start to get entity IDs, then reference them — don't re-call repeatedly
8. **Cap your OHLCV requests** — `count: 20` for quick analysis, `count: 100` for deeper work, `count: 500` only when specifically needed

### Output Size Estimates (compact mode)
| Tool | Typical Output |
|------|---------------|
| `quote_get` | ~200 bytes |
| `data_get_study_values` | ~500 bytes (all indicators) |
| `data_get_pine_lines` | ~1-3 KB per study (deduplicated levels) |
| `data_get_pine_labels` | ~2-5 KB per study (capped at 50) |
| `data_get_pine_tables` | ~1-4 KB per study (formatted rows) |
| `data_get_pine_boxes` | ~1-2 KB per study (deduplicated zones) |
| `data_get_ohlcv` (summary) | ~500 bytes |
| `data_get_ohlcv` (100 bars) | ~8 KB |
| `capture_screenshot` | ~300 bytes (returns file path, not image data) |

## Tool Conventions

- All tools return `{ success: true/false, ... }`
- Entity IDs (from `chart_get_state`) are session-specific — don't cache across sessions
- Pine indicators must be **visible** on chart for pine graphics tools to read their data
- `chart_manage_indicator` requires **full indicator names**: "Relative Strength Index" not "RSI", "Moving Average Exponential" not "EMA", "Bollinger Bands" not "BB"
- Screenshots save to `screenshots/` directory with timestamps
- OHLCV capped at 500 bars, trades at 20 per request
- Pine labels capped at 50 per study by default (pass `max_labels` to override)

## Daily Brief — Zwei Versionen

### ⚡ Tages-Flash (täglich automatisch, schlank)
Enthält: Markt-Regime, Kalender, Watchlist-Tabelle, News (nach Symbol gruppiert), CANSLIM Scanner.
**Nicht** enthalten: Mario Lochner, Tradermacher, Lieblingstrade, Options-IV.
Laufzeit: ~1–1.5 Minuten.

**Automatic schedule (LaunchAgent, Mo–Fr):**
- 17:00 CEST → `--mode=flash` (Tages-Flash)

```bash
npm run flash          # --mode=flash  (Tages-Flash, 17:00)
npm run flash:closing  # --mode=flash-closing (Closing-Modus, 10:00)
```

### 📈 Deep Brief (nur auf konkrete Anfrage im Chat)
Enthält alles: Markt-Regime, **Mario Lochner**, Kalender, Watchlist-Tabelle, News, CANSLIM Scanner, **Tradermacher**, **Lieblingstrade**, Options-IV.
Laufzeit: ~2–3 Minuten.

**When the user explicitly asks for the full/deep brief:**
- "Schick mir den Deep Brief" / "vollständiger Brief"
- "brief jetzt" (ohne "flash") → Deep Brief verwenden

→ Use `--mode=daily` for the afternoon deep brief.
→ Use `--mode=closing` for the morning deep brief (Closing Bell vom Vortag).

```bash
npm run brief          # --mode=daily  (Deep Brief)
npm run brief:closing  # --mode=closing (Deep Brief, Closing)
```

For the weekly summary (Fridays):
```bash
npm run brief:weekly
```

Wait for `✅ Email erfolgreich gesendet` in the output before confirming to the user.

## Architecture

```
Claude Code ←→ MCP Server (stdio) ←→ CDP (localhost:9222) ←→ TradingView Desktop (Electron)
```

Pine graphics path: `study._graphics._primitivesCollection.dwglines.get('lines').get(false)._primitivesDataById`

## TradingView Desktop — Kritische Rendering-Erkenntnisse (2026-04-30)

### Zwei getrennte Layers — NUR der Datenstrom ist per JS steuerbar

TradingView Desktop (Electron) hat zwei vollständig getrennte Layers:

| Layer | Was | Steuerbar per CDP-JS? |
|-------|-----|----------------------|
| **Daten-Layer** | `_chartWidgetsDefs[i].chartWidget`, `_activeChartWidgetWV.value()` (Wrapper "gt"), `collection.setSymbol()` | ✅ Ja |
| **Render-Layer** | Sichtbare Canvas, Kerzen, Preisachse, Legendentitel | ❌ Nein |

Der Render-Layer ist im **Electron-Window-Target** (`file:///...app/window/index.html`) verankert und an das **Watchlist-selektierte Symbol** gebunden. Alle JS-API-Calls aktualisieren nur den Datenstrom, der Renderer bleibt immer auf dem Watchlist-Symbol.

### CDP-Targets in TradingView Desktop

```
03FFB6981B8E7C360D01187BB3C5A57F  → https://de.tradingview.com/chart/...  (Chart-Page, unser CDP-Target)
9977867C54BDA451735FC140052EAD22  → file:///…/app/window/index.html        (Electron-Window, Render-Layer)
CC88E8B507BBF4ED676AD7A8569F6720  → file:///…/app/tooltip/index.html       (Tooltip)
057456627898A3D61D85EE8AFE70B961  → file:///…/app/browser-api-container/   (Browser API)
```

`connection.js` verbindet sich zum **Chart-Page**-Target (tradingview.com/chart). Dessen JS-Kontext enthält `window.TradingViewApi`, `window.TradingView`, etc.

### Interne API-Objekte

```javascript
// Daten-Layer (per CDP-JS steuerbar):
window.TradingViewApi._chartWidgetCollection          // Chart-Widget-Collection
window.TradingViewApi._chartWidgetCollection._chartWidgetsDefs[0].chartWidget  // chartWidget (cw)
window.TradingViewApi._activeChartWidgetWV.value()    // "gt"-Wrapper (Typ: gt)
window.TradingViewApi._chartWidgetCollection.setSymbol(sym)  // → _setSymbolImpl()

// gt-Wrapper-Methoden (setSymbol, setVisibleRange, onSymbolChanged, ...):
// gt.symbol() gibt den Datenstrom-Symbol zurück (NICHT was visuell gerendert wird)
// gt.setSymbol(sym) wechselt Datenstrom, aber NICHT den Renderer

// Zeichnungen / Shapes → operieren auf Datenstrom-Symbol:
window.TradingViewApi._activeChartWidgetWV.value().getAllShapes()  // Shapes auf Datenstrom-Symbol
```

### Was funktioniert / was nicht

| Methode | Datenstrom-Symbol | Visueller Renderer |
|---------|------------------|--------------------|
| `cw.setSymbol(sym, {})` | ✅ wechselt | ❌ kein Effekt |
| `collection.setSymbol(sym)` → `_setSymbolImpl` | ✅ wechselt | ❌ kein Effekt |
| `gt.setSymbol(sym)` | ✅ wechselt | ❌ kein Effekt |
| Symbol-Suche-Dialog-Klick (CDP clickAt) | ✅ wechselt | ❌ kein Effekt¹ |
| Watchlist-Klick (CDP clickAt) | ✅ wechselt | ❌ kein Effekt¹ |
| `drawShape()` / `clearAll()` / `createPositionLine()` | ✅ auf Datenstrom-Symbol | — |

¹ Keiner der getesteten CDP-Ansätze konnte den Electron-Render-Layer aktualisieren.

### Lösung: Custom Chart-Renderer (`renderTradeChart`)

Da der Render-Layer nicht steuerbar ist, generiert `favorite-trade.js` das Chart-Bild direkt aus OHLCV-Daten via **Browser-Canvas-API**:

```javascript
// favorite-trade.js: renderTradeChart(bars, setup, ticker, voigt, candidate)
// → Candlestick-PNG mit Entry/Stop/Target, Voigt-Levels, Titelleiste
// → Gespeichert in screenshots/favtrade_${ticker}.png
// → Base64 in screenshotBase64 für Email-Embedding
```

**Vorteile gegenüber CDP-Screenshot:**
- Immer korrektes Symbol (unabhängig von Watchlist-Bindung)
- Entry/Stop/Target immer klar sichtbar im richtigen Preisbereich
- Schneller (kein Warten auf TradingView-Render)
- Enthält Voigt-Metadata direkt im Titel

## Watchlist-Sync — Kritische Erkenntnisse (2026-05-27)

### TradingView Dropdown-Menus sind portal overlays (`position: fixed`)

TradingView rendert alle Dropdown-Menus (inkl. Watchlist-Switcher) als portal overlay mit `position: fixed`.
Bei `position: fixed` ist `el.offsetParent === null` — **das bedeutet NICHT unsichtbar!**

**Falsch (altes Muster):**
```javascript
if (el.children.length > 0 || !el.offsetParent) continue; // ❌ überspringt fixed-Elemente
```

**Richtig (nach Fix):**
```javascript
var r = el.getBoundingClientRect();
if (r.width < 5 || r.height < 5) continue; // ✅ funktioniert auch bei position:fixed
```

→ Gilt für **alle** UI-Interaktionen mit TradingView-Dropdowns, Menus, Overlays.

### Watchlist-Cache (`rules-watchlist-cache.json`)

- Wird bei jedem erfolgreichen `runBrief()` automatisch via `saveWlCache()` aktualisiert
- Dient als Fallback wenn TradingView nicht erreichbar ist
- Bei veraltetem Cache manuell mit `node --input-type=module` + `watchlistCore.switchTo()` aktualisieren
