#!/bin/bash
# start-tradingview-cdp.sh
# Startet TradingView immer mit CDP (Port 9222) — wird vom LaunchAgent aufgerufen.
# Wenn TradingView bereits mit CDP läuft, passiert nichts.

TV_BIN="/Applications/TradingView.app/Contents/MacOS/TradingView"
CDP_PORT=9222

# Prüfen ob CDP bereits aktiv
if curl -s --max-time 2 "http://localhost:${CDP_PORT}/json/list" > /dev/null 2>&1; then
    echo "TradingView läuft bereits mit CDP (Port ${CDP_PORT}) — kein Neustart nötig."
    exit 0
fi

# Bestehende TradingView-Instanz (ohne CDP) beenden
if pgrep -f "TradingView" > /dev/null 2>&1; then
    echo "TradingView läuft ohne CDP — beende und starte neu mit CDP..."
    pkill -f "TradingView" 2>/dev/null || true
    sleep 3
fi

# TradingView detached im Hintergrund starten (wie der Brief-Script es macht)
# WICHTIG: nohup + disown damit der Prozess nach Shell-Exit weiterläuft
echo "Starte TradingView mit --remote-debugging-port=${CDP_PORT}..."
nohup "${TV_BIN}" --remote-debugging-port=${CDP_PORT} > /dev/null 2>&1 &
disown $!

# Kurz warten bis CDP-Port offen ist (max 30s)
for i in $(seq 1 15); do
    sleep 2
    if curl -s --max-time 1 "http://localhost:${CDP_PORT}/json/list" > /dev/null 2>&1; then
        echo "✅ TradingView mit CDP bereit (${i}×2s gewartet)."
        exit 0
    fi
done
echo "⚠️  CDP nach 30s noch nicht erreichbar — TradingView läuft aber im Hintergrund."
exit 0
