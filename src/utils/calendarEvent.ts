import { GAME_BOOKING_UTC_OFFSET } from "../consts/api_config";
import type { Booking, PadelGameRecord } from "./apiClient";
import { resolveGameBookingTimes } from "./bookingEndTime";

const CALENDAR_MIME_TYPE = "text/calendar;charset=utf-8";
const MOSCOW_UTC_OFFSET_HOURS = 3;
const DEFAULT_GAME_DURATION_MINUTES = 90;

type CalendarDraft = {
  title: string;
  description: string;
  location: string | null;
  startAt: Date;
  endAt: Date;
  fileName: string;
  url?: string | null;
};

function trimString(value: string | null | undefined): string | null {
  const normalized = String(value || "").trim();
  return normalized ? normalized : null;
}

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function formatUtcStamp(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  const hours = String(value.getUTCHours()).padStart(2, "0");
  const minutes = String(value.getUTCMinutes()).padStart(2, "0");
  const seconds = String(value.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}

function parseIsoLikeToUtc(valueRaw: string | null | undefined): Date | null {
  const value = trimString(valueRaw);
  if (!value) return null;

  if (/[zZ]$|[+-]\d{2}:\d{2}$|[+-]\d{4}$/.test(value)) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }

  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;

  return new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]) - MOSCOW_UTC_OFFSET_HOURS,
    Number(match[5]),
    Number(match[6] || "0"),
  ));
}

function sanitizeFileName(fileName: string): string {
  return fileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildIcsContent(draft: CalendarDraft): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Padel Hub//Calendar Invite//RU",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${Date.now()}-${Math.random().toString(36).slice(2, 10)}@padlhub`,
    `DTSTAMP:${formatUtcStamp(new Date())}`,
    `DTSTART:${formatUtcStamp(draft.startAt)}`,
    `DTEND:${formatUtcStamp(draft.endAt)}`,
    `SUMMARY:${escapeIcsText(draft.title)}`,
    `DESCRIPTION:${escapeIcsText(draft.description)}`,
  ];

  if (draft.location) {
    lines.push(`LOCATION:${escapeIcsText(draft.location)}`);
  }
  if (draft.url) {
    lines.push(`URL:${escapeIcsText(draft.url)}`);
  }

  lines.push("END:VEVENT", "END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

async function presentCalendarFile(draft: CalendarDraft): Promise<void> {
  const icsContent = buildIcsContent(draft);
  const file = new File([icsContent], sanitizeFileName(draft.fileName), {
    type: CALENDAR_MIME_TYPE,
    lastModified: Date.now(),
  });

  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    const shareData: ShareData = {
      files: [file],
      title: draft.title,
      text: "Добавить событие в календарь",
    };
    try {
      if (typeof navigator.canShare !== "function" || navigator.canShare(shareData)) {
        await navigator.share(shareData);
        return;
      }
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      if (name === "AbortError") return;
    }
  }

  if (typeof document === "undefined") return;

  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildLocation(studioName: string | null, address: string | null): string | null {
  const parts = [studioName, address].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(", ") : null;
}

function buildBookingDraft(booking: Booking): CalendarDraft | null {
  const startAt = parseIsoLikeToUtc(booking.exercise?.timeFrom ?? null);
  const endAt = parseIsoLikeToUtc(booking.exercise?.timeTo ?? null);
  if (!startAt || !endAt) return null;

  const directionName =
    trimString(booking.exercise?.direction?.name)
    ?? trimString(booking.exercise?.type?.name)
    ?? "Событие Padel HUB";
  const studioName = trimString(booking.exercise?.studio?.name);
  const studioAddress = trimString(booking.exercise?.studio?.address);
  const roomName = trimString(booking.exercise?.room?.name);
  const trainer = booking.exercise?.trainers?.[0];
  const trainerName = trainer
    ? [trimString(trainer.firstName), trimString(trainer.lastName)].filter(Boolean).join(" ")
    : null;
  const title = studioName ? `${directionName} • ${studioName}` : directionName;
  const descriptionLines = [
    studioName ? `Станция: ${studioName}` : null,
    roomName ? `Корт: ${roomName}` : null,
    trainerName ? `Тренер: ${trainerName}` : null,
    studioAddress ? `Адрес: ${studioAddress}` : null,
  ].filter((value): value is string => Boolean(value));
  const datePart = trimString(booking.exercise?.timeFrom)?.slice(0, 10)?.replace(/-/g, "") || "event";

  return {
    title,
    description: descriptionLines.join("\n") || title,
    location: buildLocation(studioName, studioAddress),
    startAt,
    endAt,
    fileName: `padlhub-booking-${datePart}.ics`,
  };
}

function buildGameDraft(game: PadelGameRecord): CalendarDraft | null {
  const date = trimString(game.booking?.date);
  const { startTs, endTs } = resolveGameBookingTimes(game.booking, GAME_BOOKING_UTC_OFFSET);
  if (startTs === null) return null;

  const durationMinutes = game.booking?.durationMinutes;
  const fallbackDuration = durationMinutes && durationMinutes > 0 ? durationMinutes : DEFAULT_GAME_DURATION_MINUTES;
  const startAt = new Date(startTs);
  const endAt = new Date(endTs ?? startTs + fallbackDuration * 60 * 1000);

  const studioName = trimString(game.booking?.studioName);
  const roomName = trimString(game.booking?.roomName);
  const levelLabel = game.settings?.ratingGame
    ? [trimString(game.settings.minRating), trimString(game.settings.maxRating)].filter(Boolean).join(" / ") || "Игра на уровень"
    : "Без ограничения по уровню";
  const inviteUrl = trimString(game.inviteUrl);
  const title = studioName ? `Игра • ${studioName}` : "Игра в Padel HUB";
  const descriptionLines = [
    studioName ? `Станция: ${studioName}` : null,
    roomName ? `Корт: ${roomName}` : null,
    levelLabel ? `Формат: ${levelLabel}` : null,
    inviteUrl ? `Ссылка на игру: ${inviteUrl}` : null,
  ].filter((value): value is string => Boolean(value));
  const datePart = date?.replace(/-/g, "") || "game";

  return {
    title,
    description: descriptionLines.join("\n") || title,
    location: buildLocation(studioName, null),
    startAt,
    endAt,
    fileName: `padlhub-game-${datePart}.ics`,
    url: inviteUrl,
  };
}

export async function addBookingToCalendar(booking: Booking): Promise<void> {
  const draft = buildBookingDraft(booking);
  if (!draft) return;
  await presentCalendarFile(draft);
}

export async function addGameToCalendar(game: PadelGameRecord | null | undefined): Promise<void> {
  if (!game) return;
  const draft = buildGameDraft(game);
  if (!draft) return;
  await presentCalendarFile(draft);
}
