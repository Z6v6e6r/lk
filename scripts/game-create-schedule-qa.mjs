import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  GameCreateScheduleReadError,
  readGameCreateSchedule,
} from "./lib/gameCreateScheduleRead.mjs";

const route = "/lk/integrations/v1/game-create-schedule";
const queries = new Set(["stationId", "day", "durationMinutes", "slotId"]);

export function createGameCreateScheduleServer(options = {}) {
  const limits = new Map();
  return createServer({ maxHeaderSize: 16384 }, async (req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "private, no-store");
    const correlationId = /^[a-zA-Z0-9._:-]{8,128}$/.test(
      req.headers["x-correlation-id"] ?? "",
    )
      ? req.headers["x-correlation-id"]
      : randomUUID();
    res.setHeader("X-Correlation-ID", correlationId);
    const send = (status, value) => {
      if (res.destroyed) return;
      res.statusCode = status;
      res.end(JSON.stringify(value));
    };
    const abort = new AbortController();
    res.once("close", () => abort.abort());
    try {
      if (!req.url?.startsWith("/") || req.url.length > 512)
        return send(400, { code: "GAME_CREATE_SCHEDULE_QUERY_INVALID" });
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== route || req.method !== "GET")
        return send(404, { code: "NOT_FOUND" });
      const keys = [...url.searchParams.keys()];
      if (
        new Set(keys).size !== keys.length ||
        keys.some((key) => !queries.has(key))
      )
        return send(400, { code: "GAME_CREATE_SCHEDULE_QUERY_INVALID" });
      const bearer = req.headers.authorization;
      if (!/^Bearer [A-Za-z\d._~-]{20,12000}$/.test(bearer ?? ""))
        return send(401, { code: "GAME_CREATE_SCHEDULE_AUTH_REQUIRED" });
      const verifiedActor = options.verifyDelegation?.({
        delegation: req.headers["x-subscription-actor-delegation"],
        url,
        bearer,
        correlationId,
      });
      if (options.verifyDelegation && !verifiedActor)
        return send(401, { code: "GAME_CREATE_SCHEDULE_AUTH_REQUIRED" });
      const now = Date.now();
      for (const [key, entry] of limits) {
        if (entry.until <= now) limits.delete(key);
      }
      const key = verifiedActor
        ? verifiedActor.tenantId + ":" + verifiedActor.sub
        : createHash("sha256").update(bearer).digest("hex");
      const existing = limits.get(key);
      if ((existing?.count ?? 0) >= 24 || (!existing && limits.size >= 128))
        return send(429, { code: "GAME_CREATE_SCHEDULE_RATE_LIMITED" });
      limits.set(key, {
        count: (existing?.count ?? 0) + 1,
        until: existing?.until ?? now + 60000,
      });
      return send(
        200,
        await readGameCreateSchedule(
          {
            query: Object.fromEntries(url.searchParams),
            authorization: bearer,
            correlationId,
            signal: abort.signal,
            includeSubscriptionQuote:
              req.headers["x-lk2-schedule-features"] === "subscription-quote",
          },
          options,
        ),
      );
    } catch (error) {
      const known = error instanceof GameCreateScheduleReadError;
      return send(known ? error.status : 503, {
        code: known ? error.message : "GAME_CREATE_SCHEDULE_UNAVAILABLE",
      });
    }
  });
}

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  const port = Number(process.env.LK1_GAME_CREATE_QA_PORT ?? 24811);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid QA port");
  createGameCreateScheduleServer().listen(port, "127.0.0.1", () => {
    process.stdout.write(`LK1 schedule QA listening on 127.0.0.1:${port}\n`);
  });
}
