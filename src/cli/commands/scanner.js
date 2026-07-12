import { register } from "../router.js";
import * as core from "../../core/scanner.js";

register("scan", {
  description: "CANSLIM-Scanner: Scannt US + Europa nach 5-Sterne-Setups (TradingView Scanner API)",
  options: {
    markets: {
      type: "string",
      short: "m",
      description: "Märkte: all | us | europe | germany | france | uk | switzerland (Standard: all)",
    },
    stars: {
      type: "string",
      short: "s",
      description: "Mindest-Sterne 1–5 (Standard: 2)",
    },
    top: {
      type: "string",
      short: "t",
      description: "Max. Ergebnisse (Standard: 20)",
    },
  },
  handler: async ({ markets = "all", stars = "2", top = "20" }) =>
    core.runScan({
      markets,
      min_stars: parseFloat(stars),
      top: parseInt(top, 10),
    }),
});
