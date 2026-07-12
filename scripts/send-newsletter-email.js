#!/usr/bin/env node
// send-newsletter-email.js — HTML-Newsletter via Gmail versenden
// Aufruf: node send-newsletter-email.js --file <path> --kw <n> --year <year>

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env") });

const require = createRequire(import.meta.url);
const nodemailer = require("nodemailer");

// ── Args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

const file = get("--file");
const kw   = get("--kw");
const year = get("--year");

if (!file || !kw || !year) {
  console.error("Usage: send-newsletter-email.js --file <path> --kw <n> --year <year>");
  process.exit(1);
}

// ── Credentials ──────────────────────────────────────────────────────────────
const { GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;
const RECIPIENT = process.env.BRIEF_RECIPIENT || "willems.robert@gmail.com";

if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
  console.error("❌ GMAIL_USER / GMAIL_APP_PASSWORD fehlen in .env");
  process.exit(1);
}

// ── HTML laden ───────────────────────────────────────────────────────────────
const html = readFileSync(file, "utf8");

if (!html.trim().startsWith("<!DOCTYPE") && !html.trim().startsWith("<html")) {
  console.error("❌ Datei enthält kein valides HTML (beginnt nicht mit <!DOCTYPE html>)");
  process.exit(1);
}

// ── Versenden ─────────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
});

const dateLong = new Date().toLocaleDateString("de-DE", {
  weekday: "long", day: "2-digit", month: "long", year: "numeric",
});

await transporter.sendMail({
  from: `"Wöchentlicher Marktbrief" <${GMAIL_USER}>`,
  to: RECIPIENT,
  subject: `📊 Marktbrief KW${kw}/${year} · ${dateLong}`,
  html,
});

console.log(`✅ Marktbrief KW${kw}/${year} an ${RECIPIENT} versendet`);
