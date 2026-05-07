import type { PadelGamePlayer, PadelGameRecord } from "./apiClient";

const INVITE_TITLE = "Присоединяйся к игре";
const INVITE_LINK_LABEL = "Ссылка на игру";
const PREVIEW_WIDTH = 416;
const PREVIEW_HEIGHT = 224;
const PREVIEW_MAX_PLAYERS = 4;
const RATING_LABELS = ["D", "D+", "C", "C+", "B", "B+", "A"] as const;

const RATING_RING_COLOR: Record<(typeof RATING_LABELS)[number], string> = {
  D: "#94A0B8",
  "D+": "#798BFF",
  C: "#4E8CF6",
  "C+": "#3DB4D0",
  B: "#33B38A",
  "B+": "#F2A84B",
  A: "#E77353",
};

type PreviewPlayer = {
  name: string;
  rating: string | null;
  photo: string | null;
};

function isHuaweiLikeDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = (navigator.userAgent || "").toLowerCase();
  return ua.includes("huawei") || ua.includes("honor") || ua.includes("hmscore");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function capitalize(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function getPlayerInitials(name: string): string {
  const normalized = name.trim();
  if (!normalized) return "•";
  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();
}

function normalizePlayerRatingLabel(value: string | null | undefined): (typeof RATING_LABELS)[number] | null {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return null;

  if (RATING_LABELS.includes(raw as (typeof RATING_LABELS)[number])) {
    return raw as (typeof RATING_LABELS)[number];
  }

  const compact = raw.replace(/\s+/g, "");
  if (RATING_LABELS.includes(compact as (typeof RATING_LABELS)[number])) {
    return compact as (typeof RATING_LABELS)[number];
  }

  const numeric = Number.parseFloat(raw.replace(",", "."));
  if (Number.isFinite(numeric)) {
    const index = Math.max(0, Math.min(RATING_LABELS.length - 1, Math.round(numeric) - 1));
    return RATING_LABELS[index] ?? null;
  }

  return null;
}

function getPlayerRatingProgress(label: (typeof RATING_LABELS)[number] | null): number | null {
  if (!label) return null;
  const index = RATING_LABELS.findIndex((item) => item === label);
  if (index < 0) return null;
  if (RATING_LABELS.length <= 1) return 1;
  return (index + 1) / RATING_LABELS.length;
}

function getRingColor(label: (typeof RATING_LABELS)[number] | null): string {
  if (!label) return "#D8DDE8";
  return RATING_RING_COLOR[label] ?? "#7353D9";
}

function formatDateLabel(dateValue: string | null | undefined): string {
  if (!dateValue) return "Дата будет назначена";
  const parsed = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return "Дата будет назначена";

  const weekday = capitalize(parsed.toLocaleDateString("ru-RU", { weekday: "long" }));
  const day = parsed.toLocaleDateString("ru-RU", { day: "2-digit" });
  const month = capitalize(parsed.toLocaleDateString("ru-RU", { month: "long" }));
  return `${weekday}, ${day} ${month}`;
}

function formatTimeLabel(
  from: string | null | undefined,
  to: string | null | undefined,
): string {
  const safeFrom = (from || "").trim();
  const safeTo = (to || "").trim();
  if (safeFrom && safeTo) return `${safeFrom} • ${safeTo}`;
  if (safeFrom) return `${safeFrom} • —`;
  if (safeTo) return `— • ${safeTo}`;
  return "Время уточняется";
}

function formatDurationLabel(durationMinutes: number | null | undefined): string {
  return durationMinutes && durationMinutes > 0 ? `${durationMinutes} мин` : "Не указана";
}

function formatInviteDateLabel(game: PadelGameRecord | null | undefined): string {
  const dateLabel = formatDateLabel(game?.booking?.date);
  const from = (game?.booking?.timeFrom || "").trim();
  const to = (game?.booking?.timeTo || "").trim();
  if (from && to) return `${dateLabel}, ${from} - ${to}`;
  if (from) return `${dateLabel}, ${from}`;
  if (to) return `${dateLabel}, ${to}`;
  return dateLabel;
}

function formatInviteLevelLabel(game: PadelGameRecord | null | undefined): string {
  if (!game?.settings?.ratingGame) return "Без уровня";

  const min = (game.settings.minRating || "").trim();
  const max = (game.settings.maxRating || "").trim();
  if (min && max) return `${min}/${max}`;
  if (min) return min;
  if (max) return max;
  return "Уровень не указан";
}

function buildInviteMessage(
  inviteUrlRaw: string,
  game?: PadelGameRecord | null,
): {
  plainText: string;
  htmlText: string;
  title: string;
} {
  const inviteUrl = inviteUrlRaw.trim();
  const studioName = (game?.booking?.studioName || "").trim() || "Не указана";
  const roomName = (game?.booking?.roomName || "").trim() || "Не указан";
  const dateLabel = formatInviteDateLabel(game);
  const durationLabel = formatDurationLabel(game?.booking?.durationMinutes);
  const levelLabel = formatInviteLevelLabel(game);
  const lines = [
    `${INVITE_TITLE}:`,
    `Станция: ${studioName}`,
    `Корт: ${roomName}`,
    `Дата: ${dateLabel}`,
    `Продолжительность: ${durationLabel}`,
    `Уровень: ${levelLabel}`,
    `${INVITE_LINK_LABEL}: ${inviteUrl}`,
  ];
  const htmlParts = [
    `<div>${escapeHtml(INVITE_TITLE)}:</div>`,
    `<div style="margin-top:6px;">Станция: ${escapeHtml(studioName)}</div>`,
    `<div>Корт: ${escapeHtml(roomName)}</div>`,
    `<div>Дата: ${escapeHtml(dateLabel)}</div>`,
    `<div>Продолжительность: ${escapeHtml(durationLabel)}</div>`,
    `<div>Уровень: ${escapeHtml(levelLabel)}</div>`,
    `<div style="margin-top:8px;"><a href="${escapeHtml(inviteUrl)}">${escapeHtml(`${INVITE_LINK_LABEL}: ${inviteUrl}`)}</a></div>`,
  ];

  return {
    plainText: lines.join("\n"),
    htmlText: htmlParts.join(""),
    title: INVITE_TITLE,
  };
}

function copyPlainTextFallback(text: string): boolean {
  if (typeof document === "undefined") return false;

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

async function writePlainTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (copyPlainTextFallback(text)) {
    return;
  }

  throw new Error("Clipboard API is not available");
}

function getGamePlayers(game: PadelGameRecord | null | undefined): PreviewPlayer[] {
  const participants = Array.isArray(game?.participants) ? game.participants : [];
  const organizer = game?.organizer
    ? {
        id: game.organizer.id ?? null,
        name: game.organizer.name || "Организатор",
        phone: game.organizer.phone ?? null,
        photo: game.organizer.photo ?? null,
        rating: game.organizer.rating ?? null,
      }
    : null;

  const sourcePlayers = participants.length > 0
    ? participants
    : organizer
      ? [organizer as PadelGamePlayer]
      : [];

  const mapped = sourcePlayers
    .slice(0, PREVIEW_MAX_PLAYERS)
    .map((player, index) => ({
      name: (player.name || "").trim() || `Игрок ${index + 1}`,
      rating: (player.rating || "").trim() || null,
      photo: (player.photo || "").trim() || null,
    }));

  while (mapped.length < PREVIEW_MAX_PLAYERS) {
    mapped.push({
      name: "",
      rating: null,
      photo: null,
    });
  }

  return mapped;
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const limitedRadius = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
  ctx.beginPath();
  ctx.moveTo(x + limitedRadius, y);
  ctx.lineTo(x + width - limitedRadius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + limitedRadius);
  ctx.lineTo(x + width, y + height - limitedRadius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - limitedRadius, y + height);
  ctx.lineTo(x + limitedRadius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - limitedRadius);
  ctx.lineTo(x, y + limitedRadius);
  ctx.quadraticCurveTo(x, y, x + limitedRadius, y);
  ctx.closePath();
}

function fillRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  fillStyle: string,
) {
  ctx.save();
  ctx.fillStyle = fillStyle;
  roundedRectPath(ctx, x, y, width, height, radius);
  ctx.fill();
  ctx.restore();
}

function strokeRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  strokeStyle: string,
) {
  ctx.save();
  ctx.strokeStyle = strokeStyle;
  roundedRectPath(ctx, x, y, width, height, radius);
  ctx.stroke();
  ctx.restore();
}

function fitText(
  ctx: CanvasRenderingContext2D,
  value: string,
  maxWidth: number,
): string {
  const safe = value.trim();
  if (!safe) return "";
  if (ctx.measureText(safe).width <= maxWidth) return safe;

  let end = safe.length;
  while (end > 1) {
    const candidate = `${safe.slice(0, end).trim()}…`;
    if (ctx.measureText(candidate).width <= maxWidth) {
      return candidate;
    }
    end -= 1;
  }
  return "…";
}

async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/png");
  });
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") {
        resolve(result);
        return;
      }
      reject(new Error("Failed to read clipboard image"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read clipboard image"));
    reader.readAsDataURL(blob);
  });
}

async function loadImage(url: string): Promise<HTMLImageElement | null> {
  if (!url) return null;
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

async function createInvitePreviewBlob(
  game: PadelGameRecord | null | undefined,
): Promise<Blob | null> {
  if (typeof document === "undefined") return null;

  const canvas = document.createElement("canvas");
  const scale = 2;
  canvas.width = PREVIEW_WIDTH * scale;
  canvas.height = PREVIEW_HEIGHT * scale;

  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(scale, scale);

  const dateLabel = formatDateLabel(game?.booking?.date);
  const timeLabel = formatTimeLabel(game?.booking?.timeFrom, game?.booking?.timeTo);
  const levelTag = game?.settings?.ratingGame ? "Уровень" : "Без уровня";
  const durationTag = game?.booking?.durationMinutes
    ? `${game.booking.durationMinutes} мин`
    : "— мин";
  const ratingTag =
    game?.settings?.minRating && game?.settings?.maxRating
      ? `${game.settings.minRating}/${game.settings.maxRating}`
      : "D+/B";
  const players = getGamePlayers(game);

  fillRoundedRect(ctx, 0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT, 18, "#EEF1F7");
  fillRoundedRect(ctx, 6, 6, PREVIEW_WIDTH - 12, PREVIEW_HEIGHT - 12, 16, "#F4F6FB");
  strokeRoundedRect(ctx, 6, 6, PREVIEW_WIDTH - 12, PREVIEW_HEIGHT - 12, 16, "rgba(24, 27, 42, 0.14)");

  ctx.fillStyle = "#1E2235";
  ctx.font = "700 22px 'Arial'";
  ctx.fillText(dateLabel, 18, 40);

  ctx.fillStyle = "#666A7A";
  ctx.font = "500 16px 'Arial'";
  ctx.fillText(timeLabel, 18, 68);

  const tagY = 28;
  fillRoundedRect(ctx, 304, tagY, 92, 26, 10, "#ECE7FF");
  ctx.fillStyle = "#6950E6";
  ctx.font = "700 14px 'Arial'";
  ctx.fillText(levelTag, 332, tagY + 18);

  fillRoundedRect(ctx, 304, tagY + 34, 92, 26, 10, "#ECE7FF");
  ctx.fillStyle = "#6950E6";
  ctx.fillText(durationTag, 330, tagY + 52);

  fillRoundedRect(ctx, 304, tagY + 68, 92, 26, 10, "#ECE7FF");
  ctx.fillStyle = "#6950E6";
  ctx.fillText(ratingTag, 336, tagY + 86);

  const avatarStartX = 32;
  const avatarY = 116;
  const avatarStep = 58;
  const avatarOuterRadius = 22;
  const avatarInnerRadius = 18;

  for (let index = 0; index < players.length; index += 1) {
    const player = players[index];
    const levelLabel = normalizePlayerRatingLabel(player.rating);
    const levelProgress = getPlayerRatingProgress(levelLabel);
    const ringColor = getRingColor(levelLabel);
    const centerX = avatarStartX + index * avatarStep;
    const centerY = avatarY;

    ctx.save();
    ctx.strokeStyle = "#DCE1EB";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(centerX, centerY, avatarOuterRadius - 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    if (levelProgress != null) {
      ctx.save();
      ctx.strokeStyle = ringColor;
      ctx.lineCap = "round";
      ctx.lineWidth = 4;
      ctx.beginPath();
      const start = -Math.PI / 2;
      const end = start + Math.PI * 2 * levelProgress;
      ctx.arc(centerX, centerY, avatarOuterRadius - 2, start, end);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.beginPath();
    ctx.arc(centerX, centerY, avatarInnerRadius, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();

    const photo = player.photo ? await loadImage(player.photo) : null;
    if (photo) {
      ctx.drawImage(
        photo,
        centerX - avatarInnerRadius,
        centerY - avatarInnerRadius,
        avatarInnerRadius * 2,
        avatarInnerRadius * 2,
      );
    } else {
      ctx.fillStyle = player.name ? "#7A69F9" : "#D8DCE8";
      ctx.fillRect(
        centerX - avatarInnerRadius,
        centerY - avatarInnerRadius,
        avatarInnerRadius * 2,
        avatarInnerRadius * 2,
      );
      if (player.name) {
        const initials = getPlayerInitials(player.name);
        ctx.fillStyle = "#FFFFFF";
        ctx.font = "700 16px 'Arial'";
        const textWidth = ctx.measureText(initials).width;
        ctx.fillText(initials, centerX - textWidth / 2, centerY + 6);
      }
    }
    ctx.restore();

    if (levelLabel) {
      ctx.font = "700 12px 'Arial'";
      const badgeTextWidth = ctx.measureText(levelLabel).width;
      const badgeWidth = Math.max(30, Math.ceil(badgeTextWidth + 14));
      fillRoundedRect(ctx, centerX - badgeWidth / 2 + 16, centerY + 16, badgeWidth, 18, 8, "#1E2235");
      ctx.fillStyle = "#FFFFFF";
      ctx.fillText(levelLabel, centerX - badgeTextWidth / 2 + 16, centerY + 29);
    }
  }

  const studioName = (game?.booking?.studioName || "").trim() || "Станция не указана";
  const roomName = (game?.booking?.roomName || "").trim() || "Корт не указан";

  fillRoundedRect(ctx, 18, 160, 380, 46, 14, "#E7E0FF");
  ctx.fillStyle = "#654EE4";
  ctx.font = "700 16px 'Arial'";
  const stationLabel = fitText(ctx, studioName, 350);
  ctx.fillText(stationLabel, 30, 180);

  ctx.fillStyle = "#6D7284";
  ctx.font = "600 13px 'Arial'";
  const courtLabel = fitText(ctx, `Корт: ${roomName}`, 350);
  ctx.fillText(courtLabel, 30, 198);

  return canvasToBlob(canvas);
}

export async function copyGameInviteClipboardPayload(
  inviteUrlRaw: string,
  game?: PadelGameRecord | null,
  options?: { includePreviewImage?: boolean },
): Promise<void> {
  const inviteUrl = inviteUrlRaw.trim();
  if (!inviteUrl) {
    throw new Error("Invite URL is empty");
  }

  const includePreviewImage = options?.includePreviewImage === true;
  const inviteMessage = buildInviteMessage(inviteUrl, game);

  const previewBlob = includePreviewImage
    ? await createInvitePreviewBlob(game)
    : null;
  const previewDataUrl = previewBlob ? await blobToDataUrl(previewBlob) : null;
  const htmlParts = [inviteMessage.htmlText];

  if (includePreviewImage && previewDataUrl) {
    htmlParts.push(
      `<div style="margin-top:10px;"><img src="${escapeHtml(previewDataUrl)}" alt="Приглашение в игру" width="${PREVIEW_WIDTH}" height="${PREVIEW_HEIGHT}" /></div>`,
    );
  }

  const clipboardItemCtor =
    typeof window !== "undefined" && "ClipboardItem" in window
      ? (window as unknown as { ClipboardItem: typeof ClipboardItem }).ClipboardItem
      : null;

  if (clipboardItemCtor && navigator.clipboard?.write) {
    try {
      const payload: Record<string, Blob> = {
        "text/plain": new Blob([inviteMessage.plainText], { type: "text/plain" }),
        "text/html": new Blob([htmlParts.join("")], { type: "text/html" }),
      };

      if (includePreviewImage && previewBlob) {
        payload["image/png"] = previewBlob;
      }

      await navigator.clipboard.write([new clipboardItemCtor(payload)]);
      return;
    } catch {
      // fallback to plain text below
    }
  }

  await writePlainTextToClipboard(inviteMessage.plainText);
}

type ShareOrCopyOptions = {
  includePreviewImage?: boolean;
  preferNativeShare?: boolean;
};

export async function shareOrCopyGameInvitePayload(
  inviteUrlRaw: string,
  game?: PadelGameRecord | null,
  options?: ShareOrCopyOptions,
): Promise<"shared" | "copied"> {
  const inviteUrl = inviteUrlRaw.trim();
  if (!inviteUrl) {
    throw new Error("Invite URL is empty");
  }

  const preferNativeShare = options?.preferNativeShare !== false;
  const includePreviewImage = options?.includePreviewImage === true;
  const inviteMessage = buildInviteMessage(inviteUrl, game);
  const avoidFileShare = isHuaweiLikeDevice();

  if (preferNativeShare && typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      const shareWithTextAndUrlData: ShareData = {
        title: inviteMessage.title,
        text: inviteMessage.plainText,
        url: inviteUrl,
      };

      if (
        typeof navigator.canShare !== "function"
        || navigator.canShare(shareWithTextAndUrlData)
      ) {
        await navigator.share(shareWithTextAndUrlData);
        return "shared";
      }

      if (!avoidFileShare && includePreviewImage && typeof File !== "undefined") {
        const previewBlob = await createInvitePreviewBlob(game);
        if (previewBlob) {
          const previewFile = new File([previewBlob], "padlhub-invite.png", {
            type: "image/png",
            lastModified: Date.now(),
          });
          const shareWithFileAndTextData: ShareData = {
            files: [previewFile],
            title: inviteMessage.title,
            text: inviteMessage.plainText,
            url: inviteUrl,
          };

          if (
            typeof navigator.canShare !== "function"
            || navigator.canShare(shareWithFileAndTextData)
          ) {
            await navigator.share(shareWithFileAndTextData);
            try {
              await copyGameInviteClipboardPayload(inviteUrl, game, {
                includePreviewImage: false,
              });
            } catch {
              // ignore clipboard errors after successful share
            }
            return "shared";
          }
        }
      }

      await navigator.share({
        title: inviteMessage.title,
        text: inviteMessage.plainText,
      });
      return "shared";
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      if (name === "AbortError") {
        throw error;
      }
      // fallback to clipboard below
    }
  }

  await copyGameInviteClipboardPayload(inviteUrl, game, {
    includePreviewImage: false,
  });
  return "copied";
}
