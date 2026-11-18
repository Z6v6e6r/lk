#!/usr/bin/env node
// Assembles the install packet from the reviewed sources and current evidence.
// It never deploys, imports, uploads or publishes anything.
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const out = path.resolve(outIndex >= 0 && args[outIndex + 1] ? args[outIndex + 1]
  : path.join(root, "outputs", "residency-pilot-install-" + new Date().toISOString().slice(0, 10).replace(/-/g, "")));
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
function copyTree(from, to, skip = new Set()) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target, skip);
    else copy(source, target);
  }
}
const dist = path.join(root, "dist", "bundle.js");
if (!fs.existsSync(dist)) { console.error("dist/bundle.js is missing; run vite build first"); process.exit(2); }
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
copyTree(path.join(root, "node-red/custom-nodes/residency-lifecycle-api"), path.join(out, "custom-node"), new Set(["node_modules"]));
copy(path.join(root, "node-red/imports/lk_residency_lifecycle.import.json"), path.join(out, "lk_residency_lifecycle.import.json"));
for (const name of ["apply-indexes.js", "preimage-check.mjs", "readback.sh", "discount-preview.mjs", "env.template"]) {
  copy(path.join(root, "scripts/pilot-composition", name), path.join(out, name));
}
copy(path.join(root, "docs/residency-pilot-install.md"), path.join(out, "INSTALL.md"));
copy(path.join(root, "docs/residency-pilot-acceptance.md"), path.join(out, "ACCEPTANCE.md"));
const evidence = path.join(root, "docs/evidence/residency-pilot/isolated-composition-20261118");
for (const name of ["README.md", "hashes.txt", "e2e-scenarios.json", "backend-http.txt", "environment.txt", "indexes.json"]) {
  copy(path.join(evidence, name), path.join(out, "evidence", name));
}
copy(dist, path.join(out, "frontend/bundle.js"));
const head = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
const release = { version: "prepared-not-published", sourceCommit: head, generatedAt: new Date().toISOString(),
  bundleSha256: sha256(dist), bundleBytes: fs.statSync(dist).size, note: "Prepared artifact. Not published; publication is a separate owner-approved operation." };
fs.writeFileSync(path.join(out, "frontend/release.json"), JSON.stringify(release, null, 2) + "\n");
fs.writeFileSync(path.join(out, "README.md"), `# Residency LK1 pilot install packet

Prepared from commit \`${head}\`; not deployed or published.

1. Read INSTALL.md (preconditions, preimage, indexes, env, apply order, readback, rollback).
2. Run \`node preimage-check.mjs --flows <private flows.json> --expect-nodes 5678 --expect-http-in 316\`.
3. Apply \`apply-indexes.js\` and the env from \`env.template\` (placeholders only).
4. Use \`readback.sh\` after the import/restart.
5. \`discount-preview.mjs\` is a read-only discount check; it never books or charges.
6. Evidence from the isolated run is in \`evidence/\`; frontend artifacts are in \`frontend/\`
   and are marked \`prepared-not-published\`.
`);
const files = [];
(function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(path.relative(out, full));
  }
})(out);
files.sort();
const sums = files.map((file) => sha256(path.join(out, file)) + "  " + file).join("\n") + "\n";
fs.writeFileSync(path.join(out, "SHA256SUMS"), sums);
console.log(JSON.stringify({ out, files: files.length, sourceCommit: head, bundleSha256: release.bundleSha256,
  bundleBytes: release.bundleBytes, sha256sums: sha256(path.join(out, "SHA256SUMS")) }, null, 1));
