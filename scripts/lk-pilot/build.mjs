import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const artifacts = { "booking.js": "scripts/lk-pilot/vite.config.ts" };

const rawOut = process.argv[2];
const pageUrl = new URL(process.argv[3] ?? "https://padlhub.ru/lk_pilot");
const output = rawOut && path.resolve(rawOut);
if (!output || pageUrl.pathname !== "/lk_pilot" || pageUrl.search || pageUrl.hash
  || pageUrl.username || pageUrl.password
  || (pageUrl.origin !== "https://padlhub.ru" && !["127.0.0.1", "localhost"].includes(pageUrl.hostname))) {
  throw new Error("Usage: node scripts/lk-pilot/build.mjs NEW_OUTPUT_DIRECTORY [PILOT_PAGE_URL]");
}
const forbidden = ["dist", "dist-dev", "public"].map((dir) => path.join(repo, dir));
if (forbidden.some((dir) => output === dir || output.startsWith(dir + path.sep))) {
  throw new Error("Choose a separate pilot output directory");
}
await mkdir(output, { mode: 0o700 });

const run = (args, env = process.env) => execFileSync(process.execPath, args, {
  cwd: repo,
  env,
  stdio: "inherit",
});
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const sourceDirty = Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim());
const version = createHash("sha256").update(sourceCommit).update(new Date().toISOString()).digest("hex").slice(0, 24);

for (const [asset, config] of Object.entries(artifacts)) {
  const folder = path.dirname(asset);
  run([
    "node_modules/vite/bin/vite.js", "build", "--config", config, "--outDir", path.join(output, folder),
    "--no-emptyOutDir",
  ], {
    ...process.env,
    VITE_LK_READ_ONLY_PILOT: "true",
    VITE_FIREBASE_ANALYTICS_ENABLED: "false",
    VITE_CABINET_URL: pageUrl.href,
    VITE_SUCCESS_URL: pageUrl.href,
    VITE_FAIL_URL: pageUrl.href,
    VITE_LK1_RESIDENCY_PREVIEW_ONLY: "true",
  });
}

for (const file of ["bootstrap.mjs", "policy.mjs"]) {
  await cp(path.join(repo, "scripts/lk-pilot", file), path.join(output, file));
}

const SHA = "sha384";
const manifest = { channel: "lk1-pilot", version, sourceCommit, sourceDirty, assets: {} };
for (const file of Object.keys(artifacts)) {
  const contents = await readFile(path.join(output, file));
  manifest.assets[file] = `${SHA}-${createHash(SHA).update(contents).digest("base64")}`;
}

const fonts = await readdir(path.join(repo, "src/fonts"));
await mkdir(path.join(output, "fonts"), { recursive: true });
for (const file of fonts.filter((file) => file.endsWith(".woff2"))) {
  await cp(path.join(repo, "src/fonts", file), path.join(output, "fonts", file));
}
await writeFile(path.join(output, "release.json"), JSON.stringify(manifest, null, 2) + "\n");
const assetOrigin = pageUrl.hostname === "padlhub.ru" ? "https://padlhub.su" : pageUrl.origin;
const bootstrapIntegrity = "sha384-" + createHash("sha384").update(
  await readFile(path.join(output, "bootstrap.mjs")),
).digest("base64");
const tildaHead = [
  '<meta name="robots" content="noindex, nofollow">',
  `<meta http-equiv="Content-Security-Policy" content="connect-src ${assetOrigin}/lk-pilot/ ${assetOrigin}/lk-pilot-api https://kc.vivacrm.ru/realms/clients/protocol/openid-connect/token; script-src 'unsafe-inline' ${assetOrigin}/lk-pilot/ https://static.tildacdn.com https://static.tildacdn.pub; form-action 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'">`,
].join("\n") + "\n";
const tildaBlock = [
  '<div id="root">Загружаем тестовый ЛК…</div>',
  `<script type="module" src="${assetOrigin}/lk-pilot/${version}/bootstrap.mjs" integrity="${bootstrapIntegrity}" crossorigin="anonymous"></script>`,
].join("\n") + "\n";
await writeFile(path.join(output, "tilda-head.html"), tildaHead);
await writeFile(path.join(output, "tilda-block.html"), tildaBlock);
await writeFile(path.join(output, "local.html"),
  `<!doctype html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Тестовый ЛК</title>${tildaHead}</head><body>${tildaBlock}</body></html>\n`);
console.log(`LK1 pilot ${version}: ${output}`);
