/**
 * logger.js — Leichtgewichtiger, einheitlicher Logger mit Scope-Prefix und Log-Level.
 *
 * Ersetzt verstreute console.log/warn/error-Aufrufe durch eine gemeinsame Stelle,
 * ohne den bestehenden Stil (Emojis, deutsche Meldungen) zu verändern — nur ein
 * "[scope]"-Prefix und optionale Level-Filterung via LOG_LEVEL env var kommen dazu.
 *
 * Nutzung: const log = createLogger("mailer"); log.warn("...");
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function currentMinLevel() {
  return LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
}

export function createLogger(scope) {
  const prefix = `[${scope}]`;
  const emit = (level, consoleFn) => (...args) => {
    if (LEVELS[level] < currentMinLevel()) return;
    consoleFn(prefix, ...args);
  };
  return {
    debug: emit("debug", console.log),
    info:  emit("info", console.log),
    warn:  emit("warn", console.warn),
    error: emit("error", console.error),
  };
}
