#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import QRCode from "qrcode";

const ROOT = process.cwd();
const ASSIGNMENTS_PATH = path.join(ROOT, "docs/ab-leto-trainer-qr-assignment.csv");
const OUTPUT_DIR = path.join(ROOT, "docs/ab-leto-trainer-qr");
const codes = Array.from({ length: 50 }, (_, index) => `TR-${String(index + 1).padStart(3, "0")}`);

const csvCell = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

const ensureAssignments = () => {
  if (fs.existsSync(ASSIGNMENTS_PATH)) return;
  const rows = [
    ["number", "qrCode", "trainerFullName", "landingUrl"],
    ...codes.map((code, index) => [
      index + 1,
      code,
      "",
      `https://padlhub.ru/ab_leto?qr=${code}`,
    ]),
  ];
  fs.mkdirSync(path.dirname(ASSIGNMENTS_PATH), { recursive: true });
  fs.writeFileSync(ASSIGNMENTS_PATH, `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`, "utf8");
};

const parseCsvLine = (line) => {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
};

const readRows = () => {
  const lines = fs.readFileSync(ASSIGNMENTS_PATH, "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim());
  const headers = parseCsvLine(lines.shift() || "");
  const rows = lines.map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
  });
  if (rows.length !== 50 || new Set(rows.map((row) => row.qrCode)).size !== 50) {
    throw new Error("The assignment table must contain exactly 50 unique QR codes");
  }
  return rows;
};

const rowsToRegistry = (rows) => {
  const headers = ["number", "qrCode", "trainerFullName", "landingUrl", "clicks", "uniqueSessions", "paidPurchases", "conversionPercent"];
  return `${[headers, ...rows.map((row) => [row.number, row.qrCode, row.trainerFullName, row.landingUrl, "", "", "", ""])]
    .map((row) => row.map(csvCell).join(","))
    .join("\n")}\n`;
};

const tableHtml = (rows) => `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Лето.Падел — QR тренеров</title>
<style>body{font-family:Arial,sans-serif;color:#18181b}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;font-size:12px;text-align:left}th{background:#f3f4f6}.qr{width:88px;height:88px}.code{font-family:monospace;font-weight:bold}@media print{@page{size:A4 landscape;margin:8mm}tr{break-inside:avoid}}</style>
</head><body><h1>Лето.Падел — 50 QR-кодов тренеров</h1><p>ФИО заполняется в <code>ab-leto-trainer-qr-assignment.csv</code>, затем повторно запустите генератор.</p>
<table><thead><tr><th>№</th><th>QR SVG</th><th>QR PNG</th><th>Код</th><th>ФИО тренера</th><th>Ссылка</th><th>Переходы</th><th>Покупки</th></tr></thead><tbody>
${rows.map((row) => `<tr><td>${escapeHtml(row.number)}</td><td><img class="qr" src="${escapeHtml(row.qrCode)}.svg" alt="${escapeHtml(row.qrCode)} SVG"></td><td><img class="qr" src="${escapeHtml(row.qrCode)}.png" alt="${escapeHtml(row.qrCode)} PNG"></td><td class="code">${escapeHtml(row.qrCode)}</td><td>${escapeHtml(row.trainerFullName)}</td><td>${escapeHtml(row.landingUrl)}</td><td>—</td><td>—</td></tr>`).join("\n")}
</tbody></table></body></html>`;

ensureAssignments();
const rows = readRows();
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
for (const row of rows) {
  await QRCode.toFile(path.join(OUTPUT_DIR, `${row.qrCode}.png`), row.landingUrl, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 768,
  });
  const svg = await QRCode.toString(row.landingUrl, { type: "svg", errorCorrectionLevel: "M", margin: 2, width: 768 });
  fs.writeFileSync(path.join(OUTPUT_DIR, `${row.qrCode}.svg`), svg, "utf8");
}
fs.writeFileSync(path.join(OUTPUT_DIR, "registry.csv"), rowsToRegistry(rows), "utf8");
fs.writeFileSync(path.join(OUTPUT_DIR, "table.html"), tableHtml(rows), "utf8");
console.log(JSON.stringify({ ok: true, rows: rows.length, outputDir: OUTPUT_DIR }, null, 2));
