#!/bin/bash
# weekly-newsletter.sh — Wöchentlicher Marktbrief via claude -p + Gmail
# Läuft via LaunchAgent jeden Freitag um 22:15 Uhr

set -euo pipefail

# ── Paths ────────────────────────────────────────────────────────────────────
PROJECT=/Users/macbook-robse/tradingview-mcp-jackson
LOG="$PROJECT/logs/newsletter.log"
ERR="$PROJECT/logs/newsletter-error.log"
CLAUDE=/opt/homebrew/bin/claude
NODE=$(command -v node || echo /opt/homebrew/bin/node)
BRIEFING_DIR="/Users/macbook-robse/Library/CloudStorage/GoogleDrive-willems.robert@gmail.com/Meine Ablage/MORNING-BRIEFING"

# ── Kalenderwoche & Datum ─────────────────────────────────────────────────────
KW=$(date +%V | sed 's/^0//')
YEAR=$(date +%Y)
DATE_DE=$(date '+%d. %B %Y')
OUTFILE="$PROJECT/tmp/newsletter_KW${KW}_${YEAR}_ipad.html"
PRICE_FILE="$PROJECT/tmp/preise_KW${KW}_${YEAR}.json"
LAST_WEEK_PRICES="$PROJECT/data/preise_letzte_woche.json"

mkdir -p "$PROJECT/tmp" "$PROJECT/data"
rm -f "$OUTFILE" "$PRICE_FILE"

log() { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] $*" >> "$LOG"; }
log "Newsletter KW${KW}/${YEAR} gestartet"

# ── Schritt 1: Aktuelle Kurse via Yahoo Finance abrufen ──────────────────────
PRICE_FILE_CURRENT="$PROJECT/tmp/preise_KW${KW}_${YEAR}.json"
log "Kursabruf gestartet (Yahoo Finance)..."

if "$NODE" "$PROJECT/scripts/fetch-prices.js" --out "$PRICE_FILE_CURRENT" >> "$LOG" 2>> "$ERR"; then
  PREIS_COUNT=$(grep -c '"kurs_eur"' "$PRICE_FILE_CURRENT" 2>/dev/null || echo "?")
  log "Kursabruf abgeschlossen (${PREIS_COUNT} Positionen)"
else
  log "⚠️  Kursabruf fehlgeschlagen — claude -p nutzt WebSearch als Fallback"
fi

# ── Vorwochenpreise laden (für Wochenvergleich in Tabellen) ──────────────────
if [ -f "$LAST_WEEK_PRICES" ]; then
  VORWOCHE_JSON=$(cat "$LAST_WEEK_PRICES")
  VORWOCHE_HINWEIS="Vorwochenpreise für Wochenvergleich (Spalte '1W%' in Tabellen):
${VORWOCHE_JSON}
Berechne je Position: 1W% = (aktueller_kurs - vorwoche_kurs) / vorwoche_kurs * 100"
  log "Vorwochenpreise geladen ($(wc -c < "$LAST_WEEK_PRICES" | tr -d ' ') Bytes)"
else
  VORWOCHE_HINWEIS="Keine Vorwochenpreise verfügbar — Spalte '1W%' in Tabellen weglassen oder mit '—' füllen."
  log "Keine Vorwochenpreise — erster Lauf oder Daten fehlen"
fi

# ── claude -p: Newsletter generieren (mit Retry-Logik) ───────────────────────
# Leere MCP-Config: kein TradingView-Server → kein Blocking beim Start
MAX_RETRIES=3
RETRY_WAIT=300   # 5 Minuten zwischen Versuchen

CLAUDE_SUCCESS=false
for ATTEMPT in 1 2 3; do
  log "Versuch ${ATTEMPT}/${MAX_RETRIES} — claude -p startet..."

  if (cd "$BRIEFING_DIR" && "$CLAUDE" -p \
    --permission-mode bypassPermissions \
    --mcp-config "$PROJECT/.mcp-newsletter.json" \
    --add-dir "$PROJECT/tmp" \
    --model sonnet \
    --max-turns 80 \
    "Erstelle den vollständigen wöchentlichen Marktbrief für KW${KW}/${YEAR} (${DATE_DE}, nach US-Börsenschluss).

## VERIFIZIERTE KURSE (Yahoo Finance, Stand: ${DATE_DE})
$([ -f "$PRICE_FILE_CURRENT" ] && echo "Die Datei ${PRICE_FILE_CURRENT} enthält verifizierte Echtzeitkurse für alle Depot-Positionen (in EUR). Lies diese Datei und verwende die Werte direkt — KEIN eigener WebSearch für Kurse nötig!" || echo "Kursdatei nicht verfügbar — bitte Kurse via WebSearch abrufen.")

## Workflow:
1. $([ -f "$PRICE_FILE_CURRENT" ] && echo "Lies die Kursdatei ${PRICE_FILE_CURRENT} für alle Depot-Positionen (bereits in EUR)" || echo "Hole alle Kurse via WebSearch")
2. Hole Marktdaten (Indizes, Makro, News) via WebSearch: DAX, S&P 500, Nasdaq, VIX, EUR/USD, Inflation, EZB/Fed, Rohstoffe
3. Recherchiere aktuelle News/Earnings je Position via WebSearch
4. Berechne alle Renditen gemäß CLAUDE.md (Einstandskurse in CLAUDE.md hinterlegt)
5. ${VORWOCHE_HINWEIS}
6. Generiere das vollständige HTML (alle 13 Sektionen) gemäß CLAUDE.md
7. Schreibe das HTML (NUR reines HTML, beginnend mit <!DOCTYPE html>, endend mit </html>) via Write-Tool in:
   ${OUTFILE}

Kein Markdown, keine Code-Blöcke, kein erklärender Text in der Ausgabedatei." \
    >> "$LOG" 2>> "$ERR"); then

    CLAUDE_SUCCESS=true
    log "Versuch ${ATTEMPT} erfolgreich"
    break
  else
    EXIT_CODE=$?
    log "Versuch ${ATTEMPT} fehlgeschlagen (Exit-Code: ${EXIT_CODE})"
    if [ "$ATTEMPT" -lt "$MAX_RETRIES" ]; then
      log "Warte ${RETRY_WAIT}s bis zum nächsten Versuch..."
      sleep "$RETRY_WAIT"
    fi
  fi
done

if [ "$CLAUDE_SUCCESS" = false ]; then
  log "FEHLER: Alle ${MAX_RETRIES} Versuche fehlgeschlagen — Abbruch"
  echo "[$(date '+%Y-%m-%dT%H:%M:%S')] FEHLER: claude -p nach ${MAX_RETRIES} Versuchen nicht erfolgreich" >> "$ERR"
  exit 1
fi

# ── Prüfen ob HTML generiert wurde ───────────────────────────────────────────
if [ ! -f "$OUTFILE" ] || [ ! -s "$OUTFILE" ]; then
  log "FEHLER: HTML-Datei nicht erstellt — Abbruch"
  echo "[$(date '+%Y-%m-%dT%H:%M:%S')] FEHLER: ${OUTFILE} fehlt oder leer" >> "$ERR"
  exit 1
fi

SIZE=$(wc -c < "$OUTFILE" | tr -d ' ')
log "HTML generiert (${SIZE} Bytes) — Versand läuft..."

# ── Email versenden ───────────────────────────────────────────────────────────
"$NODE" "$PROJECT/scripts/send-newsletter-email.js" \
  --file "$OUTFILE" \
  --kw "$KW" \
  --year "$YEAR" \
  >> "$LOG" 2>> "$ERR"

log "✅ Newsletter KW${KW}/${YEAR} erfolgreich versendet"

# ── Preise für Vorwochenvergleich nächste Woche speichern ────────────────────
if [ -f "$PRICE_FILE" ] && [ -s "$PRICE_FILE" ]; then
  cp "$PRICE_FILE" "$LAST_WEEK_PRICES"
  log "Preise für KW${KW}/${YEAR} gespeichert → wird nächste Woche als Vorwochenvergleich verwendet"
else
  log "⚠️  Preise-JSON nicht gefunden — Vorwochenvergleich nächste Woche nicht möglich"
fi
