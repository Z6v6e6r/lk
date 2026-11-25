import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isPilotPostBodyAllowed, readPilotTarget } from "./policy.mjs";

const staticPath = /^\/lk-pilot\/([a-f0-9]{24})\/((?:subscription-storefront\/)?[a-zA-Z0-9_-]+\.m?js|release\.json|fonts\/[a-zA-Z0-9_.-]+\.woff2)$/;
const mime = { ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".woff2": "font/woff2" };
const allowHeaders = ["accept", "authorization", "content-type"];

function error(response, status, code) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ code }));
}

async function requestBody(request, limit = 65536) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("Pilot body is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createPilotServer({ directory, pageOrigin, forward }) {
  const localPage = new URL(pageOrigin).hostname === "127.0.0.1";
  const requestUpstream = forward ?? (pageOrigin === "https://padlhub.ru" ? fetch : async () =>
    Response.json({ code: "LK_PILOT_OFFLINE" }, { status: 503 }));
  let manifest;
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const requestOrigin = request.headers.origin;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Vary", "Origin");
      if (requestOrigin === pageOrigin) response.setHeader("Access-Control-Allow-Origin", pageOrigin);

      if (request.method === "GET" && url.pathname === "/lk-test" && localPage) {
        const page = await readFile(path.join(directory, "local.html"));
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
        return;
      }
      if (localPage && url.pathname === "/favicon.ico") return response.writeHead(204).end();
      const asset = url.pathname.match(staticPath);
      if (request.method === "GET" && asset) {
        const [, version, local] = asset;
        manifest ??= await readFile(path.join(directory, "release.json"), "utf8").then(JSON.parse);
        if (manifest.version !== version) return error(response, 404, "LK_PILOT_RELEASE_NOT_FOUND");
        const file = await readFile(path.join(directory, local));
        response.writeHead(200, { "content-type": mime[path.extname(local)] }).end(file);
        return;
      }
      if (url.pathname !== "/lk-pilot-api" || url.search) return error(response, 404, "LK_PILOT_ROUTE_NOT_FOUND");
      const sameOriginLocalRead = localPage && !requestOrigin && request.method === "GET"
        && request.headers.host === new URL(pageOrigin).host && request.headers["sec-fetch-site"] === "same-origin";
      if (requestOrigin !== pageOrigin && !sameOriginLocalRead) {
        return error(response, 403, "LK_PILOT_ORIGIN_NOT_ALLOWED");
      }
      const method = request.method === "OPTIONS" ? request.headers["access-control-request-method"] : request.method;
      if (request.method === "OPTIONS") {
        if (method !== "GET" && method !== "POST") return error(response, 405, "LK_PILOT_REQUEST_BLOCKED");
        response.writeHead(204, {
          "Access-Control-Allow-Methods": method,
          "Access-Control-Allow-Headers": [...allowHeaders, "x-lk-pilot-target"].join(", "),
        }).end();
        return;
      }

      const target = readPilotTarget(request.headers["x-lk-pilot-target"], method);
      if (!target) return error(response, 405, "LK_PILOT_REQUEST_BLOCKED");

      let body;
      if (method === "POST") {
        if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? "")) {
          return error(response, 415, "LK_PILOT_JSON_REQUIRED");
        }
        body = await requestBody(request);
        let json;
        try { json = JSON.parse(body.toString()); } catch { return error(response, 400, "LK_PILOT_INVALID_JSON"); }
        if (!isPilotPostBodyAllowed(target, json)) return error(response, 405, "LK_PILOT_REQUEST_BLOCKED");
        body = Buffer.from(JSON.stringify(json));
      }
      const headers = Object.fromEntries(allowHeaders.flatMap((name) =>
        typeof request.headers[name] === "string" ? [[name, request.headers[name]]] : [],
      ));
      headers.origin = pageOrigin;
      if (target.origin === "https://padlhub.su" && target.pathname.startsWith("/api/tournaments")) {
        headers["x-padlhub-auth-source"] = "lk-keycloak";
        headers["x-padlhub-tenant-key"] = "iSkq6G";
      }
      // The Node-RED quote pipeline has its own 28-second deadline. Keep the
      // short timeout for every other upstream and forward each request once.
      const isSubscriptionQuote = method === "POST" && target.origin === "https://padlhub.su"
        && target.pathname === "/lk/subscriptions/game-price-preview";
      if (response.destroyed) return;
      const downstream = new AbortController();
      response.once("close", () => {
        if (!response.writableEnded) downstream.abort();
      });
      const signal = AbortSignal.any([downstream.signal, AbortSignal.timeout(isSubscriptionQuote ? 29_000 : 8_000)]);
      const upstream = await requestUpstream(target, { method, headers, body, redirect: "manual", signal });
      if (upstream.status >= 300 && upstream.status < 400) return error(response, 502, "LK_PILOT_UPSTREAM_REDIRECT");
      if (!(upstream.headers.get("content-type") ?? "").includes("application/json")) {
        return error(response, 502, "LK_PILOT_UPSTREAM_RESPONSE");
      }
      const data = await upstream.text();
      response.writeHead(upstream.status, { "content-type": "application/json" }).end(data);
    } catch (failure) {
      if (response.destroyed) return;
      if (failure.name === "TimeoutError") return error(response, 504, "LK_PILOT_UPSTREAM_TIMEOUT");
      if (failure.code === "ENOENT") return error(response, 404, "LK_PILOT_ARTIFACT_NOT_FOUND");
      error(response, 502, "LK_PILOT_UNAVAILABLE");
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.argv[2] && path.resolve(process.argv[2]);
  const port = Number(process.argv[3] ?? 24927);
  const pageOrigin = process.argv[4] ?? "https://padlhub.ru";
  if (!directory || !Number.isSafeInteger(port) || !["https://padlhub.ru", "http://127.0.0.1:24927"].includes(pageOrigin)) {
    throw new Error("Usage: node scripts/lk-pilot/server.mjs OUTPUT_DIR [PORT] [PAGE_ORIGIN]");
  }
  createPilotServer({ directory, pageOrigin }).listen(port, "127.0.0.1");
}
