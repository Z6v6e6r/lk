import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const DOC_PATH = "docs/TOURNAMENT_HISTORY_REQUEST_STORM_ALERT.md";
const HISTORY_PATH = "/lk/tournaments/americano/history";

const ALERT_THRESHOLDS = Object.freeze({
  identityWindowRequestsWarning: 600,
  identityWindowRequestsCritical: 2_000,
  identityHourRequestsCritical: 10_000,
  routeWindowRequestsWarning: 2_000,
  routeWindowRequestsCritical: 5_000,
  routeHourRequestsCritical: 25_000,
  windowMs: 10 * 60 * 1000,
  hourMs: 60 * 60 * 1000,
});

type AlertSeverity = "warning" | "critical";

interface ParsedHistoryRequest {
  remoteAddress: string;
  timestampMs: number;
  method: string;
  status: number;
  tournamentId: string;
}

interface StormAlert {
  rule: string;
  severity: AlertSeverity;
  count: number;
  threshold: number;
  windowStartMs: number;
  remoteAddress?: string;
  tournamentId?: string;
}

const MONTH_INDEX: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

function parseNginxTimestamp(value: string): number {
  const match = value.match(
    /^(\d{2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/,
  );
  assert.ok(match, `unsupported nginx timestamp: ${value}`);

  const [, day, month, year, hour, minute, second, offsetSign, offsetHour, offsetMinute] = match;
  const monthIndex = MONTH_INDEX[month];
  assert.notEqual(monthIndex, undefined, `unsupported nginx month: ${month}`);

  const utcMs = Date.UTC(
    Number(year),
    monthIndex,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const offsetMinutes = Number(offsetHour) * 60 + Number(offsetMinute);
  const offsetDirection = offsetSign === "+" ? 1 : -1;
  return utcMs - offsetDirection * offsetMinutes * 60 * 1000;
}

function parseHistoryRequestLogLine(line: string): ParsedHistoryRequest | null {
  const match = line.match(/^(\S+) \S+ \S+ \[([^\]]+)\] "([A-Z]+) ([^" ]+) HTTP\/[^"]+" (\d{3})/);
  if (!match) return null;

  const [, remoteAddress, rawTimestamp, method, requestTarget, rawStatus] = match;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(requestTarget, "https://padlhub.su");
  } catch {
    return null;
  }

  if (parsedUrl.pathname !== HISTORY_PATH) return null;

  return {
    remoteAddress,
    timestampMs: parseNginxTimestamp(rawTimestamp),
    method,
    status: Number(rawStatus),
    tournamentId: parsedUrl.searchParams.get("tournamentId")?.trim() || "__missing__",
  };
}

function bucketStart(timestampMs: number, windowMs: number): number {
  return Math.floor(timestampMs / windowMs) * windowMs;
}

function addCount(counts: Map<string, number>, key: string) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function pushThresholdAlert(
  alerts: StormAlert[],
  params: {
    count: number;
    critical: number;
    warning?: number;
    rule: string;
    windowStartMs: number;
    remoteAddress?: string;
    tournamentId?: string;
  },
) {
  if (params.count >= params.critical) {
    alerts.push({
      rule: params.rule,
      severity: "critical",
      count: params.count,
      threshold: params.critical,
      windowStartMs: params.windowStartMs,
      remoteAddress: params.remoteAddress,
      tournamentId: params.tournamentId,
    });
    return;
  }

  if (params.warning !== undefined && params.count >= params.warning) {
    alerts.push({
      rule: `${params.rule}Warning`,
      severity: "warning",
      count: params.count,
      threshold: params.warning,
      windowStartMs: params.windowStartMs,
      remoteAddress: params.remoteAddress,
      tournamentId: params.tournamentId,
    });
  }
}

function evaluateTournamentHistoryRequestStorm(lines: string[]): StormAlert[] {
  const routeWindowCounts = new Map<string, number>();
  const routeHourCounts = new Map<string, number>();
  const identityWindowCounts = new Map<string, number>();
  const identityHourCounts = new Map<string, number>();

  for (const line of lines) {
    const parsed = parseHistoryRequestLogLine(line);
    if (!parsed || parsed.method !== "GET") continue;

    const windowStartMs = bucketStart(parsed.timestampMs, ALERT_THRESHOLDS.windowMs);
    const hourStartMs = bucketStart(parsed.timestampMs, ALERT_THRESHOLDS.hourMs);
    addCount(routeWindowCounts, String(windowStartMs));
    addCount(routeHourCounts, String(hourStartMs));
    addCount(
      identityWindowCounts,
      [windowStartMs, parsed.remoteAddress, parsed.tournamentId].join("\t"),
    );
    addCount(
      identityHourCounts,
      [hourStartMs, parsed.remoteAddress, parsed.tournamentId].join("\t"),
    );
  }

  const alerts: StormAlert[] = [];

  for (const [key, count] of routeWindowCounts.entries()) {
    pushThresholdAlert(alerts, {
      count,
      critical: ALERT_THRESHOLDS.routeWindowRequestsCritical,
      warning: ALERT_THRESHOLDS.routeWindowRequestsWarning,
      rule: "TournamentHistoryRouteStorm",
      windowStartMs: Number(key),
    });
  }

  for (const [key, count] of routeHourCounts.entries()) {
    if (count >= ALERT_THRESHOLDS.routeHourRequestsCritical) {
      alerts.push({
        rule: "TournamentHistoryRouteStormHourly",
        severity: "critical",
        count,
        threshold: ALERT_THRESHOLDS.routeHourRequestsCritical,
        windowStartMs: Number(key),
      });
    }
  }

  for (const [key, count] of identityWindowCounts.entries()) {
    const [rawWindowStartMs, remoteAddress, tournamentId] = key.split("\t");
    pushThresholdAlert(alerts, {
      count,
      critical: ALERT_THRESHOLDS.identityWindowRequestsCritical,
      warning: ALERT_THRESHOLDS.identityWindowRequestsWarning,
      rule: "TournamentHistoryIdentityRequestStorm",
      windowStartMs: Number(rawWindowStartMs),
      remoteAddress,
      tournamentId,
    });
  }

  for (const [key, count] of identityHourCounts.entries()) {
    if (count >= ALERT_THRESHOLDS.identityHourRequestsCritical) {
      const [rawWindowStartMs, remoteAddress, tournamentId] = key.split("\t");
      alerts.push({
        rule: "TournamentHistoryIdentityRequestStormHourly",
        severity: "critical",
        count,
        threshold: ALERT_THRESHOLDS.identityHourRequestsCritical,
        windowStartMs: Number(rawWindowStartMs),
        remoteAddress,
        tournamentId,
      });
    }
  }

  return alerts.sort((left, right) => {
    if (left.severity !== right.severity) return left.severity === "critical" ? -1 : 1;
    if (left.rule !== right.rule) return left.rule.localeCompare(right.rule);
    return right.count - left.count;
  });
}

function nginxTimestampAt(secondOffset: number): string {
  const minute = Math.floor(secondOffset / 60);
  const second = secondOffset % 60;
  return `28/Jun/2026:11:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")} +0300`;
}

function historyLogLine(params: {
  index?: number;
  remoteAddress?: string;
  tournamentId?: string;
  path?: string;
  status?: number;
  secondOffset?: number;
} = {}): string {
  const index = params.index ?? 0;
  const remoteAddress = params.remoteAddress ?? "95.165.157.255";
  const tournamentId = params.tournamentId ?? "6c4d1403-b250-4d96-91bf-b7c1fd99343a";
  const secondOffset = params.secondOffset ?? index % 600;
  const path = params.path ?? `${HISTORY_PATH}?tournamentId=${encodeURIComponent(tournamentId)}`;
  const status = params.status ?? 304;

  return `${remoteAddress} - - [${nginxTimestampAt(secondOffset)}] "GET ${path} HTTP/1.1" ${status} 0 "https://padlhub.ru/lk_new" "Mozilla/5.0"`;
}

test("tournament history request storm doc pins the external alert spec", () => {
  const doc = fs.readFileSync(DOC_PATH, "utf8");

  assert.match(doc, /Do not add this as a frontend analytics event/);
  assert.match(doc, /TournamentHistoryIdentityRequestStorm/);
  assert.match(doc, />= 2000 requests in 10m/);
  assert.match(doc, />= 10000 requests in 1h/);
  assert.match(doc, /TournamentHistoryRouteStorm/);
  assert.match(doc, />= 5000 requests in 10m/);
  assert.match(doc, />= 25000 requests in 1h/);
  assert.match(doc, /TournamentHistoryIdentityRequestStormWarning/);
  assert.match(doc, />= 600 requests in 10m/);
  assert.match(doc, /TournamentHistoryRouteStormWarning/);
  assert.match(doc, /log_format lk_tournament_history_json/);
  assert.match(doc, /limit_req_zone \$binary_remote_addr\$arg_tournamentId/);
  assert.match(doc, /node-red\/modular\/imports-tournaments-active\//);
  assert.match(doc, /tournaments\.createIndex/);
  assert.match(doc, /tournaments_tournamentId_1/);
  assert.match(doc, /IXSCAN/);
  assert.match(doc, /COLLSCAN/);
});

test("history access-log parser extracts route identity from nginx combined logs", () => {
  const parsed = parseHistoryRequestLogLine(historyLogLine()) as ParsedHistoryRequest;

  assert.equal(parsed.remoteAddress, "95.165.157.255");
  assert.equal(parsed.method, "GET");
  assert.equal(parsed.status, 304);
  assert.equal(parsed.tournamentId, "6c4d1403-b250-4d96-91bf-b7c1fd99343a");
  assert.equal(parsed.timestampMs, Date.parse("2026-06-28T08:00:00.000Z"));
});

test("low traffic and unrelated LK routes do not trigger the storm alert", () => {
  const lines = [
    ...Array.from({ length: ALERT_THRESHOLDS.identityWindowRequestsWarning - 1 }, (_, index) =>
      historyLogLine({ index }),
    ),
    ...Array.from({ length: 4_000 }, (_, index) =>
      historyLogLine({
        index,
        remoteAddress: `10.0.${Math.floor(index / 250)}.${index % 250}`,
        path: "/lk/tournaments/participants?exerciseId=6c4d1403-b250-4d96-91bf-b7c1fd99343a",
      }),
    ),
  ];

  assert.deepEqual(evaluateTournamentHistoryRequestStorm(lines), []);
});

test("one IP hammering one tournamentId triggers critical identity alert", () => {
  const lines = Array.from({ length: ALERT_THRESHOLDS.identityWindowRequestsCritical }, (_, index) =>
    historyLogLine({ index }),
  );

  const alerts = evaluateTournamentHistoryRequestStorm(lines);
  const identityAlert = alerts.find((alert) => alert.rule === "TournamentHistoryIdentityRequestStorm");

  assert.equal(identityAlert?.severity, "critical");
  assert.equal(identityAlert?.count, ALERT_THRESHOLDS.identityWindowRequestsCritical);
  assert.equal(identityAlert?.threshold, ALERT_THRESHOLDS.identityWindowRequestsCritical);
  assert.equal(identityAlert?.remoteAddress, "95.165.157.255");
  assert.equal(identityAlert?.tournamentId, "6c4d1403-b250-4d96-91bf-b7c1fd99343a");
});

test("distributed request storms still trigger route-level critical alert", () => {
  const lines = Array.from({ length: ALERT_THRESHOLDS.routeWindowRequestsCritical }, (_, index) =>
    historyLogLine({
      index,
      remoteAddress: `10.42.${Math.floor(index / 250)}.${index % 250}`,
      tournamentId: `distributed-${index}`,
    }),
  );

  const alerts = evaluateTournamentHistoryRequestStorm(lines);
  const routeAlert = alerts.find((alert) => alert.rule === "TournamentHistoryRouteStorm");

  assert.equal(routeAlert?.severity, "critical");
  assert.equal(routeAlert?.count, ALERT_THRESHOLDS.routeWindowRequestsCritical);
  assert.equal(routeAlert?.threshold, ALERT_THRESHOLDS.routeWindowRequestsCritical);
});

test("sustained one-hour client loop triggers hourly identity alert below 10m critical rate", () => {
  const lines = Array.from({ length: ALERT_THRESHOLDS.identityHourRequestsCritical }, (_, index) =>
    historyLogLine({ index, secondOffset: index % 3600 }),
  );

  const alerts = evaluateTournamentHistoryRequestStorm(lines);
  const hourlyAlert = alerts.find(
    (alert) => alert.rule === "TournamentHistoryIdentityRequestStormHourly",
  );

  assert.equal(hourlyAlert?.severity, "critical");
  assert.equal(hourlyAlert?.count, ALERT_THRESHOLDS.identityHourRequestsCritical);
  assert.equal(hourlyAlert?.threshold, ALERT_THRESHOLDS.identityHourRequestsCritical);
});
