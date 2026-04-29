import { useCallback, useEffect, useMemo, useState } from "react";
import {
  apiCreatePadelSplitParticipantPayment,
  apiFetchPadelGameRecord,
  apiFetchProfile,
  apiUpdatePadelGameRecord,
  type PadelGamePlayer,
  type PadelGameRecord,
  type UserProfileType,
} from "../../utils/apiClient";
import {
  CUSTOM_FIELD_IDS,
  getCustomFieldValue,
  getLetterGrade,
  parseNumericLevel,
} from "../../utils/customFields";
import { CABINET_URL } from "../../consts/api_config";
import { PAYMENT_REF_QUERY_KEY } from "../../utils/paymentSync";

type JoinDecision = "JOINED" | "WAITLIST" | "DECLINED" | "NONE";

interface GameJoinPageProps {
  gameId: string;
  cabinetUrl?: string | null;
}

const DEFAULT_CABINET_URL = CABINET_URL;
const DEFAULT_MAX_PLAYERS = 4;
const OPEN_GAME_QUERY_KEY = "openGameId";
const SPLIT_JOIN_QUERY_KEY = "splitJoin";

function normalizePhone(value: string | null | undefined): string | null {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toDateLabel(dateValue: string | null | undefined): string {
  if (!dateValue) return "Дата не указана";
  const parsed = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return "Дата не указана";
  return parsed.toLocaleDateString("ru-RU", {
    weekday: "long",
    day: "2-digit",
    month: "long",
  });
}

function formatPrice(value: number): string {
  return value.toLocaleString("ru-RU");
}

function dedupePlayers(players: PadelGamePlayer[]): PadelGamePlayer[] {
  const map = new Map<string, PadelGamePlayer>();
  players.forEach((player, index) => {
    const phoneKey = normalizePhone(player.phone);
    const idKey = player.id?.trim() || "";
    const key = phoneKey || idKey || `idx-${index}`;
    map.set(key, player);
  });
  return Array.from(map.values());
}

function removePlayer(players: PadelGamePlayer[], phoneNorm: string, userId: string | null): PadelGamePlayer[] {
  return players.filter((player) => {
    const playerPhone = normalizePhone(player.phone);
    if (playerPhone && playerPhone === phoneNorm) return false;
    if (userId && player.id && player.id === userId) return false;
    return true;
  });
}

function buildMyPlayer(profile: UserProfileType): PadelGamePlayer {
  const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim();
  const explicitGrade = getCustomFieldValue(profile, CUSTOM_FIELD_IDS.lkPadelLevel);
  const numeric = parseNumericLevel(getCustomFieldValue(profile, CUSTOM_FIELD_IDS.lkPadelLevelNumeric));

  return {
    id: profile.id ?? null,
    name: fullName || "Игрок",
    phone: profile.phone ?? null,
    photo: profile.photo ?? null,
    rating: explicitGrade ?? (numeric != null ? getLetterGrade(numeric) : null),
    ratingNumeric: numeric,
    source: "INVITE_LINK",
    status: "CONFIRMED",
  };
}

function resolveMyDecision(game: PadelGameRecord | null, profile: UserProfileType | null): JoinDecision {
  if (!game || !profile) return "NONE";
  const myPhone = normalizePhone(profile.phone);
  if (!myPhone) return "NONE";

  const inParticipants = (game.participants ?? []).some(
    (player) => normalizePhone(player.phone) === myPhone,
  );
  if (inParticipants) return "JOINED";

  const inWaitlist = (game.waitlist ?? []).some(
    (player) => normalizePhone(player.phone) === myPhone,
  );
  if (inWaitlist) return "WAITLIST";

  const metadata = game.metadata;
  if (isRecord(metadata) && isRecord(metadata.joinResponses) && isRecord(metadata.joinResponses[myPhone])) {
    const status = String((metadata.joinResponses[myPhone] as Record<string, unknown>).status || "").toUpperCase();
    if (status === "DECLINED") return "DECLINED";
  }

  return "NONE";
}

function resolveMaxPlayers(game: PadelGameRecord): number {
  const inviteLimit = game.invite?.maxPlayers;
  if (typeof inviteLimit === "number" && Number.isFinite(inviteLimit) && inviteLimit > 0) {
    return Math.floor(inviteLimit);
  }

  const metadata = game.metadata;
  if (isRecord(metadata)) {
    const fromMeta = metadata.maxPlayers;
    if (typeof fromMeta === "number" && Number.isFinite(fromMeta) && fromMeta > 0) {
      return Math.floor(fromMeta);
    }
  }

  return DEFAULT_MAX_PLAYERS;
}

function resolveWaitlistEnabled(game: PadelGameRecord): boolean {
  if (typeof game.invite?.waitlistEnabled === "boolean") {
    return game.invite.waitlistEnabled;
  }
  const metadata = game.metadata;
  if (isRecord(metadata) && typeof metadata.waitlistEnabled === "boolean") {
    return metadata.waitlistEnabled;
  }
  return true;
}

function resolveSplitPaymentMetadata(game: PadelGameRecord | null): Record<string, unknown> | null {
  if (!game || !isRecord(game.metadata)) return null;
  const splitPayment = game.metadata.splitPayment;
  return isRecord(splitPayment) ? splitPayment : null;
}

function isSplitPaymentGame(game: PadelGameRecord | null): boolean {
  if (!game) return false;
  if (game.settings?.payMode === "split") return true;
  const splitPayment = resolveSplitPaymentMetadata(game);
  return Boolean(splitPayment?.enabled);
}

function getSplitShareAmount(game: PadelGameRecord | null): number | null {
  const splitPayment = resolveSplitPaymentMetadata(game);
  const value = splitPayment?.shareAmount;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getSplitShareCount(game: PadelGameRecord | null): number | null {
  const splitPayment = resolveSplitPaymentMetadata(game);
  const value = splitPayment?.shareCount;
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return null;
}

function findMySplitPayment(game: PadelGameRecord, profile: UserProfileType): Record<string, unknown> | null {
  const splitPayment = resolveSplitPaymentMetadata(game);
  const payments = Array.isArray(splitPayment?.payments) ? splitPayment.payments : [];
  const myPhone = normalizePhone(profile.phone);
  const myId = profile.id ?? null;

  for (const item of payments) {
    if (!isRecord(item)) continue;
    const itemPhone = normalizePhone(
      typeof item.phoneNorm === "string"
        ? item.phoneNorm
        : (typeof item.phone === "string" ? item.phone : null),
    );
    const itemId = typeof item.clientId === "string" ? item.clientId : null;
    if (myPhone && itemPhone === myPhone) return item;
    if (myId && itemId === myId) return item;
  }

  return null;
}

function buildCurrentJoinUrl(extraParams: Record<string, string>): string | null {
  if (typeof window === "undefined") return null;
  try {
    const url = new URL(window.location.href);
    Object.entries(extraParams).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
    return url.toString();
  } catch {
    return window.location.href || null;
  }
}

function generatePaymentRef(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function cleanSplitJoinQuery(): void {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete(PAYMENT_REF_QUERY_KEY);
    url.searchParams.delete(SPLIT_JOIN_QUERY_KEY);
    window.history.replaceState(window.history.state, "", url.toString());
  } catch {
    // ignore history cleanup failures
  }
}

function mergeRecord(base: PadelGameRecord, incoming: PadelGameRecord): PadelGameRecord {
  return {
    ...base,
    ...incoming,
    organizer: incoming.organizer ?? base.organizer ?? null,
    participants: incoming.participants ?? base.participants ?? [],
    waitlist: incoming.waitlist ?? base.waitlist ?? [],
    invite: incoming.invite ?? base.invite ?? null,
    booking: incoming.booking ?? base.booking ?? null,
    payment: incoming.payment ?? base.payment ?? null,
    metadata: incoming.metadata ?? base.metadata ?? null,
  };
}

function resolveInviteCabinetUrl(value: string | null | undefined): string {
  const fallback = (DEFAULT_CABINET_URL || "").trim();
  const raw = (value || "").trim();
  if (!raw) return fallback;

  try {
    return new URL(raw, typeof window !== "undefined" ? window.location.origin : undefined).toString();
  } catch {
    return raw || fallback;
  }
}

function buildCabinetGameUrl(cabinetUrl: string | null | undefined, gameId: string): string {
  const targetUrl = resolveInviteCabinetUrl(cabinetUrl);

  try {
    const parsed = new URL(targetUrl, window.location.origin);
    parsed.searchParams.set(OPEN_GAME_QUERY_KEY, gameId);
    return parsed.toString();
  } catch {
    const join = targetUrl.includes("?") ? "&" : "?";
    return `${targetUrl}${join}${OPEN_GAME_QUERY_KEY}=${encodeURIComponent(gameId)}`;
  }
}

function buildCabinetHomeUrl(cabinetUrl: string | null | undefined): string {
  return resolveInviteCabinetUrl(cabinetUrl);
}

export default function GameJoinPage({ gameId, cabinetUrl = DEFAULT_CABINET_URL }: GameJoinPageProps) {
  const [profile, setProfile] = useState<UserProfileType | null>(null);
  const [game, setGame] = useState<PadelGameRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<"join" | "decline" | null>(null);
  const [confirmingSplitPaymentRef, setConfirmingSplitPaymentRef] = useState<string | null>(null);
  const [comment, setComment] = useState("");

  const loadData = useCallback(async () => {
    const normalizedGameId = gameId.trim();
    if (!normalizedGameId) {
      setError("Не передан идентификатор игры");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const [profileResult, gameResult] = await Promise.all([
      apiFetchProfile(),
      apiFetchPadelGameRecord(normalizedGameId),
    ]);

    if (profileResult.data) {
      setProfile(profileResult.data);
    }

    if (gameResult.data) {
      setGame(gameResult.data);
    } else {
      setError(gameResult.error?.message || "Игра не найдена");
    }

    setLoading(false);
  }, [gameId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const myDecision = useMemo(() => resolveMyDecision(game, profile), [game, profile]);
  const statusLabel = useMemo(() => {
    switch (myDecision) {
      case "JOINED":
        return "Вы в составе игры";
      case "WAITLIST":
        return isSplitPaymentGame(game) ? "Ожидается оплата участия" : "Вы в листе ожидания";
      case "DECLINED":
        return "Вы отказались от игры";
      default:
        return "Вы пока не присоединились";
    }
  }, [game, myDecision]);

  const confirmSplitJoinPayment = useCallback(
    async (paymentRef: string) => {
      if (!game || !profile || !isSplitPaymentGame(game)) return;

      const myPhoneNorm = normalizePhone(profile.phone);
      if (!myPhoneNorm) {
        setDecisionError("В профиле отсутствует номер телефона");
        return;
      }

      setConfirmingSplitPaymentRef(paymentRef);
      setDecisionError(null);

      const freshRecordResult = await apiFetchPadelGameRecord(game.id);
      const actualGame = freshRecordResult.data ?? game;
      const myPlayer = buildMyPlayer(profile);
      let participants = dedupePlayers(actualGame.participants ?? []);
      let waitlist = dedupePlayers(actualGame.waitlist ?? []);
      const maxPlayers = resolveMaxPlayers(actualGame);

      participants = removePlayer(participants, myPhoneNorm, profile.id ?? null);
      waitlist = removePlayer(waitlist, myPhoneNorm, profile.id ?? null);

      if (participants.length < maxPlayers) {
        participants.push({
          ...myPlayer,
          source: "INVITE_LINK",
          status: "CONFIRMED",
        });
      } else {
        waitlist.push({
          ...myPlayer,
          source: "INVITE_LINK",
          status: "WAITLIST",
        });
      }

      const nowIso = new Date().toISOString();
      const metadata: Record<string, unknown> = isRecord(actualGame.metadata)
        ? { ...actualGame.metadata }
        : {};
      const splitPaymentMeta = resolveSplitPaymentMetadata(actualGame) ?? {};
      const currentPayments = Array.isArray(splitPaymentMeta.payments)
        ? splitPaymentMeta.payments.filter((item) => isRecord(item))
        : [];
      metadata.splitPayment = {
        ...splitPaymentMeta,
        enabled: true,
        status: "ACTIVE",
        payments: currentPayments.map((item) => {
          const itemRef = typeof item.paymentRef === "string" ? item.paymentRef.trim() : "";
          const itemPhone = normalizePhone(
            typeof item.phoneNorm === "string"
              ? item.phoneNorm
              : (typeof item.phone === "string" ? item.phone : null),
          );
          if (itemRef !== paymentRef && itemPhone !== myPhoneNorm) return item;
          return {
            ...item,
            status: "PAID",
            paidAt: nowIso,
          };
        }),
      };

      const joinResponses = isRecord(metadata.joinResponses)
        ? { ...metadata.joinResponses as Record<string, unknown> }
        : {};
      joinResponses[myPhoneNorm] = {
        status: "JOINED",
        updatedAt: nowIso,
        playerName: myPlayer.name,
        playerId: myPlayer.id ?? null,
        paymentRef,
      };
      metadata.joinResponses = joinResponses;
      metadata.lastJoinUpdateAt = nowIso;

      const updateResult = await apiUpdatePadelGameRecord(actualGame.id, {
        participants,
        waitlist,
        metadata,
      });

      if (updateResult.error) {
        setConfirmingSplitPaymentRef(null);
        setDecisionError(updateResult.error.message || "Не удалось подтвердить оплату участия");
        return;
      }

      cleanSplitJoinQuery();
      setConfirmingSplitPaymentRef(null);
      window.location.href = buildCabinetGameUrl(cabinetUrl, actualGame.id);
    },
    [cabinetUrl, game, profile],
  );

  useEffect(() => {
    if (!game || !profile || confirmingSplitPaymentRef) return;
    if (typeof window === "undefined") return;

    try {
      const url = new URL(window.location.href);
      const splitJoin = url.searchParams.get(SPLIT_JOIN_QUERY_KEY);
      const paymentRef = url.searchParams.get(PAYMENT_REF_QUERY_KEY)?.trim() || "";
      if (splitJoin === "paid" && paymentRef) {
        void confirmSplitJoinPayment(paymentRef);
      }
    } catch {
      // ignore malformed callback URL
    }
  }, [confirmSplitJoinPayment, confirmingSplitPaymentRef, game, profile]);

  const applyDecision = useCallback(
    async (target: "join" | "decline") => {
      if (!game || !profile) {
        setDecisionError("Не удалось определить профиль или игру");
        return;
      }

      const myPhoneNorm = normalizePhone(profile.phone);
      if (!myPhoneNorm) {
        setDecisionError("В профиле отсутствует номер телефона");
        return;
      }

      setSubmitting(target);
      setDecisionError(null);

      const freshRecordResult = await apiFetchPadelGameRecord(game.id);
      const actualGame = freshRecordResult.data ?? game;

      const myPlayer = buildMyPlayer(profile);
      let participants = dedupePlayers(actualGame.participants ?? []);
      let waitlist = dedupePlayers(actualGame.waitlist ?? []);

      participants = removePlayer(participants, myPhoneNorm, profile.id ?? null);
      waitlist = removePlayer(waitlist, myPhoneNorm, profile.id ?? null);

      const maxPlayers = resolveMaxPlayers(actualGame);
      const waitlistEnabled = resolveWaitlistEnabled(actualGame);
      let appliedStatus: JoinDecision = "NONE";

      if (target === "join" && isSplitPaymentGame(actualGame)) {
        const existingPayment = findMySplitPayment(actualGame, profile);
        const existingPaymentStatus = String(existingPayment?.status || "").trim().toUpperCase();
        const existingPaymentUrl =
          typeof existingPayment?.paymentUrl === "string" ? existingPayment.paymentUrl.trim() : "";

        if (existingPaymentStatus === "PAYMENT_PENDING" && existingPaymentUrl) {
          setSubmitting(null);
          window.location.href = existingPaymentUrl;
          return;
        }

        const booking = actualGame.booking;
        const shareCountRaw = getSplitShareCount(actualGame);
        const shareCount = shareCountRaw === 2 ? 2 : 4;
        const shareAmount = getSplitShareAmount(actualGame) ?? (shareCount === 2 ? 500 : 250);
        const paymentRef = generatePaymentRef();
        const successUrl = buildCurrentJoinUrl({
          [PAYMENT_REF_QUERY_KEY]: paymentRef,
          [SPLIT_JOIN_QUERY_KEY]: "paid",
        });
        const splitPaymentMeta = resolveSplitPaymentMetadata(actualGame) ?? {};
        const currentPayments = Array.isArray(splitPaymentMeta.payments)
          ? splitPaymentMeta.payments.filter((item) => isRecord(item))
          : [];
        const usedSpots = new Set<number>(
          currentPayments
            .map((item) => (typeof item.spot === "number" && Number.isFinite(item.spot) ? Math.floor(item.spot) : null))
            .filter((item): item is number => item !== null && item > 0),
        );
        let nextSpot: number | null = null;
        for (let candidate = 1; candidate <= Math.max(maxPlayers, shareCount); candidate += 1) {
          if (!usedSpots.has(candidate)) {
            nextSpot = candidate;
            break;
          }
        }

        if (!booking?.date || !booking.timeFrom || !booking.timeTo || !booking.studioId || !booking.roomId) {
          setSubmitting(null);
          setDecisionError("В игре нет данных для оплаты участия");
          return;
        }

        const paymentResult = await apiCreatePadelSplitParticipantPayment(actualGame.id, {
          date: booking.date,
          fromTime: booking.timeFrom,
          toTime: booking.timeTo,
          studioId: booking.studioId,
          roomId: booking.roomId,
          clientId: profile.id ?? null,
          clientPhone: profile.phone ?? null,
          paymentRef,
          baseRedirectUrl: successUrl,
          successUrl,
          failUrl: successUrl,
          shareCount,
          shareAmount,
          maxClientsCount: Math.max(maxPlayers, shareCount),
          spot: nextSpot,
        });

        if (paymentResult.error || !paymentResult.data) {
          setSubmitting(null);
          setDecisionError(paymentResult.error?.message || "Не удалось создать оплату участия");
          return;
        }

        const isPaidWithoutRedirect = !paymentResult.data.paymentUrl && paymentResult.data.toPay <= 0;
        if (!paymentResult.data.paymentUrl && !isPaidWithoutRedirect) {
          setSubmitting(null);
          setDecisionError("Не удалось получить ссылку на оплату участия");
          return;
        }

        const nowIso = new Date().toISOString();
        const paymentStatus = isPaidWithoutRedirect ? "PAID" : "PAYMENT_PENDING";
        if (isPaidWithoutRedirect && participants.length < maxPlayers) {
          participants.push({
            ...myPlayer,
            source: "INVITE_LINK",
            status: "CONFIRMED",
          });
          appliedStatus = "JOINED";
        } else {
          waitlist.push({
            ...myPlayer,
            source: "INVITE_LINK",
            status: "PENDING",
          });
          appliedStatus = "WAITLIST";
        }

        const metadata: Record<string, unknown> = isRecord(actualGame.metadata)
          ? { ...actualGame.metadata }
          : {};
        const joinResponses = isRecord(metadata.joinResponses)
          ? { ...metadata.joinResponses as Record<string, unknown> }
          : {};
        joinResponses[myPhoneNorm] = {
          status: paymentStatus,
          comment: comment.trim() || null,
          updatedAt: nowIso,
          playerName: myPlayer.name,
          playerId: myPlayer.id ?? null,
          paymentRef,
        };
        metadata.joinResponses = joinResponses;
        metadata.lastJoinUpdateAt = nowIso;
        metadata.splitPayment = {
          ...splitPaymentMeta,
          enabled: true,
          status: "ACTIVE",
          shareCount,
          shareAmount,
          bookingIds: [
            ...new Set([
              ...(Array.isArray(splitPaymentMeta.bookingIds) ? splitPaymentMeta.bookingIds : []),
              paymentResult.data.bookingId,
            ].filter(Boolean)),
          ],
          payments: [
            ...currentPayments.filter((item) => {
              const itemPhone = normalizePhone(
                typeof item.phoneNorm === "string"
                  ? item.phoneNorm
                  : (typeof item.phone === "string" ? item.phone : null),
              );
              const itemId = typeof item.clientId === "string" ? item.clientId : null;
              if (myPhoneNorm && itemPhone === myPhoneNorm) return false;
              if (profile.id && itemId === profile.id) return false;
              return true;
            }),
            {
              role: "PARTICIPANT",
              status: paymentStatus,
              paymentRef,
              clientId: profile.id ?? null,
              phone: profile.phone ?? null,
              phoneNorm: myPhoneNorm,
              bookingId: paymentResult.data.bookingId,
              productId: paymentResult.data.productId,
              transactionId: paymentResult.data.transactionId,
              paymentUrl: paymentResult.data.paymentUrl,
              amount: paymentResult.data.toPay,
              amountMinor: paymentResult.data.toPayMinor,
              spot: paymentResult.data.spot ?? nextSpot,
              createdAt: nowIso,
              paidAt: isPaidWithoutRedirect ? nowIso : null,
            },
          ],
        };

        const updateResult = await apiUpdatePadelGameRecord(actualGame.id, {
          participants,
          waitlist,
          metadata,
        });

        if (updateResult.error) {
          setSubmitting(null);
          setDecisionError(updateResult.error.message || "Не удалось сохранить оплату участия");
          return;
        }

        if (isPaidWithoutRedirect) {
          setSubmitting(null);
          window.location.href = buildCabinetGameUrl(cabinetUrl, actualGame.id);
          return;
        }

        setSubmitting(null);
        window.location.href = paymentResult.data.paymentUrl || buildCabinetGameUrl(cabinetUrl, actualGame.id);
        return;
      }

      if (target === "join") {
        if (participants.length < maxPlayers) {
          participants.push({
            ...myPlayer,
            source: "INVITE_LINK",
            status: "CONFIRMED",
          });
          appliedStatus = "JOINED";
        } else if (waitlistEnabled) {
          waitlist.push({
            ...myPlayer,
            source: "INVITE_LINK",
            status: "WAITLIST",
          });
          appliedStatus = "WAITLIST";
        } else {
          setSubmitting(null);
          setDecisionError("В игре нет свободных мест");
          return;
        }
      } else {
        appliedStatus = "DECLINED";
      }

      const nowIso = new Date().toISOString();
      const metadata: Record<string, unknown> = isRecord(actualGame.metadata)
        ? { ...actualGame.metadata }
        : {};
      const joinResponses = isRecord(metadata.joinResponses)
        ? { ...metadata.joinResponses as Record<string, unknown> }
        : {};
      joinResponses[myPhoneNorm] = {
        status: appliedStatus,
        comment: comment.trim() || null,
        updatedAt: nowIso,
        playerName: myPlayer.name,
        playerId: myPlayer.id ?? null,
      };
      metadata.joinResponses = joinResponses;
      metadata.lastJoinUpdateAt = nowIso;

      const updateResult = await apiUpdatePadelGameRecord(actualGame.id, {
        participants,
        waitlist,
        metadata,
      });

      if (updateResult.error) {
        setDecisionError(updateResult.error.message || "Не удалось обновить участие");
        setSubmitting(null);
        return;
      }

      const reloaded = await apiFetchPadelGameRecord(actualGame.id);
      if (reloaded.data) {
        setGame(reloaded.data);
      } else if (updateResult.data) {
        setGame(mergeRecord(actualGame, updateResult.data));
      }

      if (target === "join") {
        setSubmitting(null);
        window.location.href = buildCabinetGameUrl(cabinetUrl, actualGame.id);
        return;
      }

      setSubmitting(null);
      window.location.href = buildCabinetHomeUrl(cabinetUrl);
    },
    [cabinetUrl, comment, game, profile],
  );

  if (loading) {
    return (
      <div className="app-container game-container">
        <div className="game-empty">Загружаем данные игры...</div>
      </div>
    );
  }

  if (error || !game) {
    return (
      <div className="app-container game-container">
        <div className="page-header">
          <div className="page-title">Приглашение в игру</div>
        </div>
        <div className="game-section">
          <div className="game-empty game-pay-error">{error || "Игра не найдена"}</div>
        </div>
        <div className="game-section">
          <button
            className="section-cta"
            type="button"
            onClick={() => {
              window.location.href = buildCabinetHomeUrl(cabinetUrl);
            }}
          >
            Перейти в личный кабинет
          </button>
        </div>
      </div>
    );
  }

  const dateLabel = toDateLabel(game.booking?.date);
  const timeLabel =
    game.booking?.timeFrom && game.booking?.timeTo
      ? `${game.booking.timeFrom} - ${game.booking.timeTo}`
      : "Время уточняется";
  const courtLabel = game.booking?.roomName || "Корт";
  const stationLabel = game.booking?.studioName || "Станция";
  const alreadyJoined = myDecision === "JOINED";
  const splitPaymentGame = isSplitPaymentGame(game);
  const splitShareAmount = getSplitShareAmount(game);
  const splitShareCount = getSplitShareCount(game);
  const showJoinedActions = alreadyJoined;
  const canJoin = submitting === null && !alreadyJoined && !confirmingSplitPaymentRef;
  const canDecline = submitting === null && !confirmingSplitPaymentRef;
  const joinButtonLabel = splitPaymentGame
    ? (submitting === "join"
        ? "Готовим оплату..."
        : `Оплатить участие${splitShareAmount != null ? ` · ${formatPrice(splitShareAmount)} ₽` : ""}`)
    : (submitting === "join" ? "Сохраняем..." : "Присоединиться");

  return (
    <div className="app-container game-container game-join-container">
      <div className="page-header">
        <div className="page-title">Приглашение в игру</div>
      </div>

      <div className="game-section">
        <div className="details-card">
          <div className="details-row">
            <div>
              <div className="details-date details-date-capitalize">{dateLabel}</div>
              <div className="details-time">{timeLabel}</div>
              <div className="details-time details-time-strong">{courtLabel}</div>
              <div className="details-time">{stationLabel}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="game-section">
        <div className="game-join-status">{statusLabel}</div>
        {confirmingSplitPaymentRef && (
          <div className="game-empty">Подтверждаем оплату участия...</div>
        )}
        {splitPaymentGame && splitShareAmount != null && (
          <div className="game-split-join-summary">
            <span>{formatPrice(splitShareAmount)} ₽ за участие</span>
            {splitShareCount != null && <span>{splitShareCount === 2 ? "2 команды" : "4 игрока"}</span>}
          </div>
        )}
      </div>

      {!showJoinedActions && (
        <div className="game-section">
          <div className="game-section-title">Комментарий к ответу</div>
          <textarea
            className="game-input game-join-comment"
            placeholder="Например: буду с партнером / опоздаю на 10 минут"
            value={comment}
            onChange={(event) => setComment(event.target.value.slice(0, 300))}
          />
        </div>
      )}

      {decisionError && (
        <div className="game-section">
          <div className="game-empty game-pay-error">{decisionError}</div>
        </div>
      )}

      <div className="game-section game-join-actions">
        {showJoinedActions ? (
          <>
            <button
              className="section-cta"
              type="button"
              onClick={() => {
                window.location.href = buildCabinetGameUrl(cabinetUrl, game.id);
              }}
            >
              Перейти в игру
            </button>
            <button
              className="section-cta section-cta-secondary"
              type="button"
              disabled={!canDecline}
              onClick={() => {
                void applyDecision("decline");
              }}
            >
              {submitting === "decline" ? "Сохраняем..." : "Выйти из игры"}
            </button>
            <button
              className="section-cta section-cta-secondary"
              type="button"
              onClick={() => {
                window.location.href = buildCabinetHomeUrl(cabinetUrl);
              }}
            >
              Перейти в личный кабинет
            </button>
          </>
        ) : (
          <>
            {!alreadyJoined && (
              <button
                className="section-cta"
                type="button"
                disabled={!canJoin}
                onClick={() => {
                  void applyDecision("join");
                }}
              >
                {joinButtonLabel}
              </button>
            )}
            <button
              className="section-cta section-cta-secondary"
              type="button"
              disabled={!canDecline}
              onClick={() => {
                void applyDecision("decline");
              }}
            >
              {submitting === "decline" ? "Сохраняем..." : "Отказаться от игры"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
