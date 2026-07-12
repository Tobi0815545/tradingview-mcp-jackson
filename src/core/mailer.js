import nodemailer from "nodemailer";

// ── Email senden ─────────────────────────────────────────────────────────────
// GMAIL_USER/GMAIL_APP_PASSWORD/BRIEF_RECIPIENT werden bewusst erst hier zur
// Aufrufzeit aus process.env gelesen (nicht als Modul-Top-Level-Konstante) —
// der Aufrufer lädt die .env-Datei erst nach dem Import-Block.
export async function sendEmail(html, count, regime, mode = "daily", favoriteTradeData = null) {
  const GMAIL_USER   = process.env.GMAIL_USER;
  const GMAIL_APP_PW = process.env.GMAIL_APP_PASSWORD;
  const RECIPIENT    = process.env.BRIEF_RECIPIENT || "willems.robert@gmail.com";

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PW },
  });

  const date = new Date().toLocaleDateString("de-DE", {
    weekday: "short", day: "2-digit", month: "2-digit", year: "numeric",
  });

  const regimeShort = regime ? ` · ${regime.color} ${regime.label}` : "";
  const prefix = mode === "closing"         ? "🌙 Closing Bell"
               : mode === "flash"           ? "⚡ Tages-Flash"
               : mode === "flash-closing"   ? "⚡ Tages-Flash · Closing"
               : "📈 Deep Brief";

  const mailOptions = {
    from: `"TradingView Brief" <${GMAIL_USER}>`,
    to: RECIPIENT,
    subject: `${prefix} ${date} · ${count} Setups${regimeShort}`,
    html,
    attachments: [],
  };

  // Chart-Screenshot als Inline-Attachment (CID: favtrade_chart)
  if (favoriteTradeData?.success && favoriteTradeData?.screenshotBase64) {
    mailOptions.attachments.push({
      filename: "favtrade_chart.png",
      content: favoriteTradeData.screenshotBase64,
      encoding: "base64",
      cid: "favtrade_chart",   // referenziert via src="cid:favtrade_chart" im HTML
    });
  }

  await transporter.sendMail(mailOptions);
}
