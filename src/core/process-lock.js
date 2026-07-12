import { readFileSync, writeFileSync, openSync, closeSync, existsSync, unlinkSync } from "node:fs";

// ── Prozess-Guard (verhindert parallele Instanzen) ───────────────────────────

const LOCK_FILE = "/tmp/.brief-running.lock";

export function acquireLock() {
  // Atomar: O_EXCL schlägt fehl wenn Datei bereits existiert (kein TOCTOU-Fenster).
  try {
    const fd = openSync(LOCK_FILE, "wx");   // wx = write + exclusive create
    closeSync(fd);
    writeFileSync(LOCK_FILE, String(process.pid), "utf8");
  } catch {
    // Datei existiert bereits — prüfen ob der Prozess noch läuft
    try {
      const pid = parseInt(readFileSync(LOCK_FILE, "utf8").trim(), 10);
      try {
        process.kill(pid, 0); // Signal 0 = nur Existenz prüfen, nicht killen
        console.error(`⚠️  Brief läuft bereits (PID ${pid}) — Abbruch.`);
        process.exit(0);
      } catch {
        // Prozess tot → veraltetes Lock-File atomar ersetzen
        console.log(`🔓 Veraltetes Lock-File (PID ${pid} nicht mehr aktiv) — wird überschrieben.`);
        try {
          unlinkSync(LOCK_FILE);
          const fd2 = openSync(LOCK_FILE, "wx");
          closeSync(fd2);
          writeFileSync(LOCK_FILE, String(process.pid), "utf8");
        } catch {
          console.error("⚠️  Lock-File konnte nicht atomar ersetzt werden — Abbruch.");
          process.exit(1);
        }
      }
    } catch {
      // Lock-File unlesbar → überschreiben
      writeFileSync(LOCK_FILE, String(process.pid), "utf8");
    }
  }
}

export function releaseLock() {
  try {
    if (existsSync(LOCK_FILE)) {
      const pid = parseInt(readFileSync(LOCK_FILE, "utf8").trim(), 10);
      if (pid === process.pid) unlinkSync(LOCK_FILE);
    }
  } catch { /* ignorieren */ }
}
