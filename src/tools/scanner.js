import { z } from "zod";
import { jsonResult } from "./_format.js";
import * as core from "../core/scanner.js";

export function registerScannerTools(server) {
  server.tool(
    "canslim_scan",
    "Scannt US- und europäische Märkte nach CANSLIM 5-Sterne-Setups. Verwendet die TradingView Scanner API. Gibt eine nach Bewertung sortierte Rangliste zurück.",
    {
      markets: z
        .enum(["all", "us", "europe", "germany", "france", "uk", "switzerland", "netherlands", "austria"])
        .optional()
        .default("all")
        .describe("Welche Märkte scannen: 'all', 'us', 'europe' oder einzelner Markt"),
      min_stars: z
        .number()
        .min(1).max(5)
        .optional()
        .default(2)
        .describe("Mindest-Sterne für die Ausgabe (1–5, Standard: 2)"),
      top: z
        .number()
        .min(1).max(100)
        .optional()
        .default(20)
        .describe("Maximale Anzahl Ergebnisse (Standard: 20)"),
    },
    async ({ markets, min_stars, top } = {}) => {
      try {
        return jsonResult(await core.runScan({ markets, min_stars, top }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );
}
