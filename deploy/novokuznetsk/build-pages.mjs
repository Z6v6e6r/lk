import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";

const here = new URL("./", import.meta.url);
const repo = fileURLToPath(new URL("../../", here));
const club = JSON.parse(await readFile(new URL("club.json", here), "utf8"));
const routes = {
  lk: "Личный кабинет",
  finde_game: "Найти игру",
  game_create: "Создать игру",
  community_join: "Вступить в сообщество",
  game_join: "Присоединиться к игре",
};

const [outDir, mode, configArg] = process.argv.slice(2);
if (!outDir || !isAbsolute(outDir) || !["--preview", "--release"].includes(mode) || !configArg) {
  throw new Error("Usage: node deploy/novokuznetsk/build-pages.mjs /absolute/new-directory --preview http://127.0.0.1:PORT | --release config.json");
}

function httpsUrl(value, label) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be an HTTPS URL without credentials, query or fragment`);
  }
  return url.href.replace(/\/$/, "");
}

let pageOrigin = club.siteOrigin;
let apiBase = "https://api.vivacrm.ru";
let keycloakBase = "https://kc.vivacrm.ru";
let assetBase;
let backendBase;
let cabinetUrl;
let gamesMasterServiceId = club.masterServiceId;
let consentVersion;
let offerUrl;
let privacyUrl;

if (mode === "--preview") {
  const url = new URL(configArg);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || configArg !== url.origin) {
    throw new Error("Use a loopback origin with an explicit port for the preview");
  }
  pageOrigin = url.origin;
  apiBase = `${pageOrigin}/viva`;
  keycloakBase = `${pageOrigin}/keycloak`;
  assetBase = `${pageOrigin}/assets`;
  backendBase = `${pageOrigin}/novokuznetsk`;
  cabinetUrl = `${pageOrigin}/lk`;
  gamesMasterServiceId = "00000000-0000-4000-8000-000000000042";
  consentVersion = "preview";
  offerUrl = `${pageOrigin}/fixture-offer`;
  privacyUrl = `${pageOrigin}/fixture-privacy`;
} else {
  const config = JSON.parse(await readFile(configArg, "utf8"));
  assetBase = httpsUrl(config.assetBase, "assetBase");
  backendBase = httpsUrl(config.backendBase, "backendBase");
  cabinetUrl = httpsUrl(config.cabinetUrl, "cabinetUrl");
  consentVersion = config.consentVersion;
  offerUrl = httpsUrl(config.offerUrl, "offerUrl");
  privacyUrl = httpsUrl(config.privacyUrl, "privacyUrl");
  if (!backendBase.endsWith("/novokuznetsk") || new URL(cabinetUrl).origin !== pageOrigin
    || new URL(offerUrl).origin !== pageOrigin || new URL(privacyUrl).origin !== pageOrigin
    || typeof consentVersion !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(consentVersion)) {
    throw new Error("Release config requires the /novokuznetsk API, the club cabinet and versioned consent documents");
  }
}

const env = {
  VITE_TENANT_KEY: club.tenantKey,
  VITE_API_BASE: apiBase,
  VITE_KEYCLOAK_BASE: keycloakBase,
  VITE_SERV2: backendBase,
  VITE_SERV2_FALLBACK: backendBase,
  VITE_LK_PINNED_API_BASE: backendBase,
  VITE_LK_PINNED_AUTH_MODE: "viva",
  VITE_PHAB_API_BASE: backendBase,
  VITE_SUPPORT_API_BASE: backendBase,
  VITE_PUSH_REGISTRATION_URL: `${backendBase}/push/register`,
  VITE_PUSH_UNREGISTRATION_URL: `${backendBase}/push/unregister`,
  VITE_CABINET_URL: cabinetUrl,
  VITE_ACADEMY_CABINET_URL: cabinetUrl,
  VITE_SUCCESS_URL: cabinetUrl,
  VITE_FAIL_URL: cabinetUrl,
  VITE_PUBLIC_INVITE_ORIGIN: pageOrigin,
  VITE_PUBLIC_INVITE_PATH: "/game_join",
  VITE_PUBLIC_GAME_FIND_PATH: "/finde_game",
  VITE_PUBLIC_GAME_CREATE_PATH: "/game_create",
  VITE_PUBLIC_COMMUNITY_JOIN_PATH: "/community_join",
  VITE_PUBLIC_CLUB_NAME: club.stationName,
  VITE_CLUB_ON_SITE_BOOKING: "true",
  VITE_ONBOARDING_IMAGE_BASE: `${assetBase}/onboarding`,
  VITE_PUBLIC_GAME_STATION_ID: club.stationId,
  VITE_PUBLIC_GAME_STATION_NAME: club.stationName,
  VITE_GAME_BOOKING_UTC_OFFSET: club.utcOffset,
  VITE_PUBLIC_GAME_TIME_ZONE: club.timeZone,
  VITE_GAME_SPLIT_PAYMENT_ENABLED: "false",
  VITE_FIREBASE_ANALYTICS_ENABLED: "false",
  VITE_AUTH_CONSENT_VERSION: consentVersion,
  VITE_AUTH_CONSENT_OFFER_URL: offerUrl,
  VITE_AUTH_CONSENT_PRIVACY_URL: privacyUrl,
  VITE_GAMES_MASTER_SERVICE_ID: gamesMasterServiceId,
};
for (const overlay of ["GAMES", "COMMUNITIES", "ONBOARDING", "LEVELS_INFO", "TOURNAMENTS", "TOURNAMENT_SIGNUP"]) {
  const bundleFile = overlay.toLowerCase().replaceAll("_", "-") + ".js";
  env[`VITE_${overlay}_BUNDLE_URL`] = `${assetBase}/${bundleFile}`;
}

await mkdir(outDir);
const assetsDir = join(outDir, "assets");
for (const name of Object.keys(process.env).filter((name) => name.startsWith("VITE_"))) delete process.env[name];
Object.assign(process.env, env);

for (const [entry, outputFile] of [
  ["tenants/padel-prime/main", "padel-prime-lk.js"],
  ["tenants/padel-prime/games", "games.js"],
  ["communities", "communities.js"],
  ["onboarding", "onboarding.js"],
  ["levels-info", "levels-info.js"],
]) {
  await build({
    root: repo,
    configFile: false,
    publicDir: false,
    envFile: false,
    plugins: [react(), cssInjectedByJsPlugin()],
    define: {
      "process.env": {},
      "process.env.NODE_ENV": JSON.stringify("production"),
      __PADLHUB_JUMP_WIDGET_URL__: JSON.stringify(""),
      __PADLHUB_EXHIBITION_WIDGET_URL__: JSON.stringify(""),
    },
    mode: "novokuznetsk",
    build: {
      outDir: assetsDir,
      emptyOutDir: false,
      cssCodeSplit: false,
      lib: {
        name: "PadelPrimeLK",
        formats: ["iife"],
        entry: join(repo, "src", `${entry}.tsx`),
        fileName: () => outputFile,
      },
    },
  });
}

await mkdir(join(assetsDir, "onboarding"));
for (let number = 1; number <= 9; number++) {
  const filename = `${number}.webp`;
  await copyFile(join(repo, "фото онбординг", filename), join(assetsDir, "onboarding", filename));
}

execFileSync(process.execPath, [join(repo, "scripts/write-release.mjs"), assetsDir, "release.json"],
  { cwd: repo, stdio: "inherit" });
const template = await readFile(new URL("tilda-block.template.html", here), "utf8");
const loaderConfig = JSON.stringify({ assetBase, pageOrigin }).replaceAll("<", "\\u003c");
const block = template.replace("__LK_PAGE_CONFIG__", () => loaderConfig);
await writeFile(join(outDir, "tilda-block.html"), block);
for (const [route, title] of Object.entries(routes)) {
  await mkdir(join(outDir, route));
  await writeFile(join(outDir, route, "index.html"), `<!doctype html>
<html lang="ru" data-theme="padel-prime">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · Падел Прайм Новокузнецк</title>
</head>
<body style="margin:0">
${block}
</body>
</html>
`);
}
