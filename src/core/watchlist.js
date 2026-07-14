/**
 * Core watchlist logic.
 * Uses TradingView's internal widget API with DOM fallback.
 */
import { evaluate, evaluateAsync, getClient, clickAt } from '../connection.js';

export async function get() {
  // Try internal API first — reads from the active watchlist widget
  const symbols = await evaluate(`
    (function() {
      // Method 1: Try the watchlist widget's internal data
      try {
        var rightArea = document.querySelector('[class*="layout__area--right"]');
        if (!rightArea || rightArea.offsetWidth < 50) return { symbols: [], source: 'panel_closed' };
      } catch(e) {}

      // Method 2: Read data-symbol-full attributes from watchlist rows
      var results = [];
      var seen = {};
      var container = document.querySelector('[class*="layout__area--right"]');
      if (!container) return { symbols: [], source: 'no_container' };

      // Find all elements with symbol data attributes
      var symbolEls = container.querySelectorAll('[data-symbol-full]');
      for (var i = 0; i < symbolEls.length; i++) {
        var sym = symbolEls[i].getAttribute('data-symbol-full');
        if (!sym || seen[sym]) continue;
        seen[sym] = true;

        // Find the row and extract price data
        var row = symbolEls[i].closest('[class*="row"]') || symbolEls[i].parentElement;
        var cells = row ? row.querySelectorAll('[class*="cell"], [class*="column"]') : [];
        var nums = [];
        for (var j = 0; j < cells.length; j++) {
          var t = cells[j].textContent.trim();
          if (t && /^[\\-+]?[\\d,]+\\.?\\d*%?$/.test(t.replace(/[\\s,]/g, ''))) nums.push(t);
        }
        results.push({ symbol: sym, last: nums[0] || null, change: nums[1] || null, change_percent: nums[2] || null });
      }

      if (results.length > 0) return { symbols: results, source: 'data_attributes' };

      // Method 3: Scan for ticker-like text in the right panel
      var items = container.querySelectorAll('[class*="symbolName"], [class*="tickerName"], [class*="symbol-"]');
      for (var k = 0; k < items.length; k++) {
        var text = items[k].textContent.trim();
        if (text && /^[A-Z][A-Z0-9.:!]{0,20}$/.test(text) && !seen[text]) {
          seen[text] = true;
          results.push({ symbol: text, last: null, change: null, change_percent: null });
        }
      }

      return { symbols: results, source: results.length > 0 ? 'text_scan' : 'empty' };
    })()
  `);

  return {
    success: true,
    count: symbols?.symbols?.length || 0,
    source: symbols?.source || 'unknown',
    symbols: symbols?.symbols || [],
  };
}

// Panel-Expand-Funktion: öffnet das Watchlist-Panel via echtem CDP-Mausklick.
// JavaScript btn.click() reicht nicht — TradingView's Panel-Logik reagiert nur auf
// echte Mausereignisse (mousedown/mouseup). clickAt() sendet echte CDP Input Events.
async function expandWatchlistPanel() {
  const coords = await evaluate(`
    (function() {
      // Watchlist-Panel-Button finden (Sidebar Icon)
      var btn = document.querySelector('[aria-label="Watchlist, details, and news"]')
             || document.querySelector('[data-name="base"][aria-label]')
             || document.querySelector('[aria-label*="Watchlist"]');
      if (!btn) return null;
      var r = btn.getBoundingClientRect();
      if (r.width === 0) return null;
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
    })()
  `);
  if (!coords) return false;
  await clickAt(coords.x, coords.y);
  return true;
}

// Pollt evaluate(checkExpr) bis truthy oder maxMs erreicht ist, statt blind maxMs zu warten.
// Gleiche Zeitobergrenze wie ein fester setTimeout(maxMs), aber schnelleres Fortfahren
// sobald der DOM-Zustand tatsächlich bereit ist (vermeidet Race-Conditions bei langsamem
// Rendering UND unnötige Verzögerung im Normalfall). Poll-Intervall 200ms wie in wait.js.
async function pollUntil(checkExpr, maxMs, intervalMs = 200) {
  const deadline = Date.now() + maxMs;
  let result = null;
  while (Date.now() < deadline) {
    result = await evaluate(checkExpr);
    if (result) return result;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return result;
}

export async function switchTo({ name }) {
  const { getClient } = await import('../connection.js');

  async function hoverClick(x, y) {
    const c = await getClient();
    await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y, button: 'none' });
    await new Promise(r => setTimeout(r, 200));
    await c.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 50));
    await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  async function pressEscape() {
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape' });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape' });
  }

  // ── Schritt 1: Panel per CSS auf 420px einfrieren (verhindert Auto-Kollaps) ──
  await evaluate(`
    (function() {
      var ra = document.querySelector('[class*="layout__area--right"]');
      if (ra) {
        ra.style.setProperty('width', '420px', 'important');
        ra.style.setProperty('min-width', '420px', 'important');
        ra.style.setProperty('flex', 'none', 'important');
      }
    })()
  `);

  // ── Schritt 2: Watchlist-Panel öffnen ──
  // dispatchEvent('click') öffnet das Panel, aber zeigt ggf. den zuletzt aktiven Tab (z.B. Chats).
  // Wir müssen sicherstellen, dass der Watchlist-Tab aktiv ist.
  for (let panelAttempt = 0; panelAttempt < 3; panelAttempt++) {
    // Prüfe ob Watchlist-Tab bereits sichtbar
    const wlCheck = await evaluate(`
      (function() {
        var wl = document.querySelector('[data-name="watchlists-button"]');
        if (wl && wl.getBoundingClientRect().width > 5) return { found: true };
        // Panel offen? Und wenn ja, welcher Tab?
        var ra = document.querySelector('[class*="layout__area--right"]');
        var panelW = ra ? ra.getBoundingClientRect().width : 0;
        return { found: false, panelOpen: panelW > 50 };
      })()
    `);
    if (wlCheck?.found) break;

    if (wlCheck?.panelOpen) {
      // Panel offen aber falscher Tab → schließen, dann base öffnen
      await evaluate(`document.querySelector('[data-name="base"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
      await new Promise(r => setTimeout(r, 500));
    }
    // base klicken → Watchlist-Tab öffnen
    await evaluate(`document.querySelector('[data-name="base"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await pollUntil(
      `!!(document.querySelector('[data-name="watchlists-button"]') && document.querySelector('[data-name="watchlists-button"]').getBoundingClientRect().width > 5)`,
      1500,
    );
  }

  // ── Schritt 3: Prüfen ob gewünschte Watchlist bereits aktiv ist ──
  const activeWl = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="watchlists-button"]');
      if (!btn) return null;
      var r = btn.getBoundingClientRect();
      if (r.width < 5 || r.height < 5) return null;
      var textEl = btn.querySelector('[class*="titleRow"], [class*="headerMenu"]');
      var text = (textEl || btn).textContent.trim();
      return { text: text, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
    })()
  `);

  if (!activeWl) throw new Error('Watchlist button not found');

  if (activeWl.text.toUpperCase() === name.toUpperCase()) {
    return { success: true, watchlist: name, alreadyActive: true };
  }

  // ── Schritt 4: Kontextmenü öffnen via Hover+Click auf watchlists-button ──
  let switcherCoords = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    switcherCoords = await evaluate(`
      (function() {
        var btn = document.querySelector('[data-name="watchlists-button"]');
        if (!btn) return null;
        var r = btn.getBoundingClientRect();
        if (r.width < 5 || r.height < 5) return null;
        return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
      })()
    `);
    if (switcherCoords) break;
    if (attempt % 3 === 0) {
      await evaluate(`document.querySelector('[data-name="base"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    }
    await new Promise(r => setTimeout(r, 800));
  }
  if (!switcherCoords) throw new Error('Watchlist switcher button not found after 10 attempts');

  await hoverClick(switcherCoords.x, switcherCoords.y);
  await pollUntil(
    `(function() {
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.children.length > 0) continue;
        var r = el.getBoundingClientRect();
        if (r.width < 5 || r.height < 5) continue;
        if (/^Liste öffnen|^Open list/i.test(el.textContent.trim())) return true;
      }
      return false;
    })()`,
    1500,
  );

  // ── Schritt 5: "Liste öffnen..." im Kontextmenü finden und klicken ──
  const openListCoords = await evaluate(`
    (function() {
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.children.length > 0) continue;
        var r = el.getBoundingClientRect();
        if (r.width < 5 || r.height < 5) continue;
        var t = el.textContent.trim();
        if (/^Liste öffnen|^Open list/i.test(t)) {
          return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), text: t };
        }
      }
      return null;
    })()
  `);

  if (!openListCoords) {
    await pressEscape();
    throw new Error('Menu item "Liste öffnen..." not found in context menu');
  }

  await hoverClick(openListCoords.x, openListCoords.y);
  await pollUntil(
    `(function() {
      var all = document.querySelectorAll('span, div');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.children.length > 0) continue;
        var r = el.getBoundingClientRect();
        if (r.width >= 5 && r.height >= 5 && r.left >= 1000) return true;
      }
      return false;
    })()`,
    2000,
  );

  // ── Schritt 6: Watchlist im Dialog finden und klicken ──
  // WICHTIG: auf die Koordinaten des gefundenen Leaf-Elements selbst klicken, NICHT auf
  // einen hochgewanderten Elternknoten. Bei Zeilen mit Zusatz-UI (z.B. "hasExpand"-Klasse
  // bei Options-verknüpften Watchlists, die einen "Mehr über Optionen"-Button einblenden)
  // ist die Zeile breiter als der Text — das Zentrum eines hochgewanderten Elternknotens
  // landet dann auf einem unsichtbaren Backdrop-Overlay statt auf der eigentlichen Zeile,
  // wodurch der Klick registriert wird (kein Fehler), aber die Watchlist NICHT wechselt.
  // Ein Klick auf den Text selbst bubbled im DOM zuverlässig zum Row-Click-Handler.
  const itemCoords = await evaluate(`
    (function(targetName) {
      var upper = targetName.toUpperCase();
      var all = document.querySelectorAll('span, div, li');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.children.length > 0) continue;
        var r = el.getBoundingClientRect();
        if (r.width < 5 || r.height < 5) continue;
        if (el.textContent.trim().toUpperCase() !== upper) continue;
        // Im Dialog-Bereich? (nicht der Button-Text selbst)
        if (r.left < 1000) continue;
        return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), matched: el.textContent.trim() };
      }
      var vis = [];
      var all2 = document.querySelectorAll('span, div');
      for (var j = 0; j < all2.length; j++) {
        var el2 = all2[j];
        if (el2.children.length > 0) continue;
        var r2 = el2.getBoundingClientRect();
        if (r2.width < 5 || r2.height < 5 || r2.left < 1000) continue;
        var t2 = el2.textContent.trim();
        if (t2.length > 1 && t2.length < 50) vis.push(t2);
      }
      return { found: false, visible: [...new Set(vis)].slice(0, 30) };
    })(${JSON.stringify(name)})
  `);

  if (!itemCoords || itemCoords.found === false) {
    await pressEscape();
    throw new Error(`Watchlist "${name}" not found in dialog. Visible: ${(itemCoords?.visible ?? []).slice(0,12).join(', ')}`);
  }

  await hoverClick(itemCoords.x, itemCoords.y);
  await new Promise(r => setTimeout(r, 1500));

  return { success: true, watchlist: name };
}

/** CSS-Pin nach get() entfernen — Panel kehrt in normalen Zustand zurück */
export async function unpinPanel() {
  await evaluate(`
    (function() {
      var ra = document.querySelector('[class*="layout__area--right"]');
      if (ra) {
        ra.style.removeProperty('width');
        ra.style.removeProperty('min-width');
        ra.style.removeProperty('flex');
      }
    })()
  `).catch(() => {});
}

export async function add({ symbol }) {
  // Use keyboard shortcut to open symbol search in watchlist, type symbol, press Enter
  const c = await getClient();

  // First ensure watchlist panel is open
  const panelState = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="base-watchlist-widget-button"]')
        || document.querySelector('[aria-label*="Watchlist"]');
      if (!btn) return { error: 'Watchlist button not found' };
      var isActive = btn.getAttribute('aria-pressed') === 'true'
        || btn.classList.toString().indexOf('Active') !== -1
        || btn.classList.toString().indexOf('active') !== -1;
      if (!isActive) { btn.click(); return { opened: true }; }
      return { opened: false };
    })()
  `);

  if (panelState?.error) throw new Error(panelState.error);
  if (panelState?.opened) await new Promise(r => setTimeout(r, 500));

  // Click the "Add symbol" button (various selectors)
  const addClicked = await evaluate(`
    (function() {
      var selectors = [
        '[data-name="add-symbol-button"]',
        '[aria-label="Add symbol"]',
        '[aria-label*="Add symbol"]',
        'button[class*="addSymbol"]',
      ];
      for (var s = 0; s < selectors.length; s++) {
        var btn = document.querySelector(selectors[s]);
        if (btn) { var br = btn.getBoundingClientRect(); if (br.width >= 5 && br.height >= 5) { btn.click(); return { found: true, selector: selectors[s] }; } }
      }
      // Fallback: find + button in right panel
      var container = document.querySelector('[class*="layout__area--right"]');
      if (container) {
        var buttons = container.querySelectorAll('button');
        for (var i = 0; i < buttons.length; i++) {
          var ariaLabel = buttons[i].getAttribute('aria-label') || '';
          if (/add.*symbol/i.test(ariaLabel) || buttons[i].textContent.trim() === '+') {
            buttons[i].click();
            return { found: true, method: 'fallback' };
          }
        }
      }
      return { found: false };
    })()
  `);

  if (!addClicked?.found) throw new Error('Add symbol button not found in watchlist panel');
  await new Promise(r => setTimeout(r, 300));

  // Type the symbol into the search input
  await c.Input.insertText({ text: symbol });
  await new Promise(r => setTimeout(r, 500));

  // Press Enter to select the first result
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  await new Promise(r => setTimeout(r, 300));

  // Press Escape to close search
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });

  return { success: true, symbol, action: 'added' };
}
