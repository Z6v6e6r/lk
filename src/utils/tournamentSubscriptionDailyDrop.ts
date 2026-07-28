export const TOURNAMENT_SUBSCRIPTION_DAILY_DROP_TIME_ZONE = "Europe/Moscow";
export const TOURNAMENT_SUBSCRIPTION_DAILY_DROP_HOUR = 10;

interface ZonedDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const moscowDateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: TOURNAMENT_SUBSCRIPTION_DAILY_DROP_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function readMoscowDateTimeParts(date: Date): ZonedDateTimeParts {
  const values = new Map(
    moscowDateTimeFormatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );

  return {
    year: values.get("year") || 0,
    month: values.get("month") || 0,
    day: values.get("day") || 0,
    hour: values.get("hour") || 0,
    minute: values.get("minute") || 0,
    second: values.get("second") || 0,
  };
}

function moscowDateTimeToEpochMs(parts: ZonedDateTimeParts) {
  const targetAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  let candidateMs = targetAsUtc;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidateParts = readMoscowDateTimeParts(new Date(candidateMs));
    const candidateAsUtc = Date.UTC(
      candidateParts.year,
      candidateParts.month - 1,
      candidateParts.day,
      candidateParts.hour,
      candidateParts.minute,
      candidateParts.second,
    );
    const correctionMs = targetAsUtc - candidateAsUtc;
    candidateMs += correctionMs;
    if (correctionMs === 0) break;
  }

  return candidateMs;
}

export function resolveNextTournamentSubscriptionDailyDropAt(now: Date = new Date()) {
  const localNow = readMoscowDateTimeParts(now);
  let targetDay = {
    year: localNow.year,
    month: localNow.month,
    day: localNow.day,
  };
  let nextDropAtMs = moscowDateTimeToEpochMs({
    ...targetDay,
    hour: TOURNAMENT_SUBSCRIPTION_DAILY_DROP_HOUR,
    minute: 0,
    second: 0,
  });

  if (nextDropAtMs <= now.getTime()) {
    const nextLocalDay = new Date(Date.UTC(targetDay.year, targetDay.month - 1, targetDay.day + 1));
    targetDay = {
      year: nextLocalDay.getUTCFullYear(),
      month: nextLocalDay.getUTCMonth() + 1,
      day: nextLocalDay.getUTCDate(),
    };
    nextDropAtMs = moscowDateTimeToEpochMs({
      ...targetDay,
      hour: TOURNAMENT_SUBSCRIPTION_DAILY_DROP_HOUR,
      minute: 0,
      second: 0,
    });
  }

  return new Date(nextDropAtMs);
}

export function formatTournamentSubscriptionDropCountdown(nextDropAtMs: number, nowMs: number) {
  const totalSeconds = Math.max(0, Math.ceil((nextDropAtMs - nowMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}
