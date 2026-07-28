#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { MongoClient } from "mongodb";

const DEFAULT_ASSIGNMENTS = "docs/ab-leto-trainer-qr-assignment.csv";
const QR_CODE_PATTERN = /^TR-(?:00[1-9]|0[1-4]\d|050)$/;
const argv = process.argv.slice(2);

const getArg = (name, fallback = null) => {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
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

const readAssignments = (filePath) => {
  const lines = fs.readFileSync(filePath, "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim());
  const headers = parseCsvLine(lines.shift() || "");
  return lines.map((line) => Object.fromEntries(
    headers.map((header, index) => [header, parseCsvLine(line)[index] || ""]),
  ));
};

const readMongoUri = () => {
  const flowPath = path.resolve(getArg("--flow", "node-red/modular/source.flow.json"));
  const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
  const mongo = flow.find((node) => node?.type === "mongodb4-client" && String(node?.uri || "").includes("/games"));
  if (!mongo?.uri) throw new Error(`MongoDB URI not found in ${flowPath}`);
  return mongo.uri;
};

const parseBoundary = (value, endOfDay) => {
  if (!value) return null;
  const candidate = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+03:00`
    : value;
  const timestamp = Date.parse(candidate);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid date: ${value}`);
  return new Date(timestamp).toISOString();
};

const csvCell = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;

if (argv.includes("--help")) {
  console.log("Usage: node scripts/report_ab_leto_trainer_qr.mjs [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--out FILE.csv] [--flow FILE]");
  process.exit(0);
}

const assignments = readAssignments(path.resolve(getArg("--assignments", DEFAULT_ASSIGNMENTS)));
const codes = assignments.map((row) => String(row.qrCode || "").trim().toUpperCase());
if (codes.length !== 50 || codes.some((code) => !QR_CODE_PATTERN.test(code)) || new Set(codes).size !== 50) {
  throw new Error("Assignment table must contain 50 unique QR codes TR-001 through TR-050");
}
const from = parseBoundary(getArg("--from"), false);
const to = parseBoundary(getArg("--to"), true);
const range = {
  ...(from ? { $gte: from } : {}),
  ...(to ? { $lte: to } : {}),
};
const client = new MongoClient(readMongoUri(), { serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000 });

try {
  await client.connect();
  const db = client.db(getArg("--db", "games"));
  const [events, sales] = await Promise.all([
    db.collection("events").find({
      event: "subscription_page_opened",
      "payload.storefront": "ab_leto",
      "payload.trainerQrCode": { $in: codes },
      ...(Object.keys(range).length ? { timestamp: range } : {}),
    }, { projection: { _id: 0, timestamp: 1, sessionId: 1, "payload.trainerQrCode": 1 } }).toArray(),
    db.collection("lk_tournament_subscription_sales").find({
      status: "PAID",
      trainerQrCode: { $in: codes },
      ...(Object.keys(range).length ? { paidAt: range } : {}),
    }, { projection: { _id: 0, trainerQrCode: 1, paymentRef: 1 } }).toArray(),
  ]);

  const eventsByCode = new Map(codes.map((code) => [code, []]));
  for (const event of events) {
    const code = String(event?.payload?.trainerQrCode || "").trim().toUpperCase();
    eventsByCode.get(code)?.push(event);
  }
  const purchasesByCode = new Map(codes.map((code) => [code, new Set()]));
  for (const sale of sales) {
    const code = String(sale?.trainerQrCode || "").trim().toUpperCase();
    const paymentRef = String(sale?.paymentRef || "").trim();
    if (paymentRef) purchasesByCode.get(code)?.add(paymentRef);
  }

  const report = assignments.map((assignment) => {
    const code = assignment.qrCode.trim().toUpperCase();
    const pageEvents = eventsByCode.get(code) || [];
    const uniqueSessions = new Set(pageEvents.map((event) => String(event.sessionId || "")).filter(Boolean)).size;
    const paidPurchases = purchasesByCode.get(code)?.size || 0;
    return {
      number: assignment.number,
      qrCode: code,
      trainerFullName: assignment.trainerFullName,
      landingUrl: assignment.landingUrl,
      clicks: pageEvents.length,
      pageOpens: pageEvents.length,
      uniqueSessions,
      paidPurchases,
      conversionPercent: uniqueSessions ? Number(((paidPurchases / uniqueSessions) * 100).toFixed(2)) : 0,
    };
  });
  const headers = Object.keys(report[0]);
  const csv = [headers.map(csvCell).join(","), ...report.map((row) => headers.map((header) => csvCell(row[header])).join(",")), ""].join("\n");
  const output = getArg("--out");
  if (output) fs.writeFileSync(path.resolve(output), csv, "utf8");
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), period: { from, to }, report }, null, 2));
} finally {
  await client.close();
}
