import { useCallback, useEffect, useMemo, useState } from "react";
import {
  apiFetchPadelGameRecord,
  apiFetchProfile,
  apiUpdatePadelGameRecord,
  type PadelGamePlayer,
  type PadelGameRecord,
  type UserProfileType,
} from "../../utils/apiClient";
import { useAuth } from "../../context/AuthContext";
import {
  CUSTOM_FIELD_IDS,
  getCustomFieldValue,
  getLetterGrade,
  parseNumericLevel,
} from "../../utils/customFields";
import { CABINET_URL } from "../../consts/api_config";

type JoinDecision = "JOINED" | "WAITLIST" | "DECLINED" | "NONE";

interface GameJoinPageProps {
  gameId: string;
  cabinetUrl?: string | null;
}

const DEFAULT_CABINET_URL = CABINET_URL;
const DEFAULT_MAX_PLAYERS = 4;

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

export default function GameJoinPage({ gameId, cabinetUrl = DEFAULT_CABINET_URL }: GameJoinPageProps) {
  const { logout } = useAuth();
  const [profile, setProfile] = useState<UserProfileType | null>(null);
  const [game, setGame] = useState<PadelGameRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [decisionSuccess, setDecisionSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<"join" | "decline" | null>(null);
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
        return "Вы в листе ожидания";
      case "DECLINED":
        return "Вы отказались от игры";
      default:
        return "Вы пока не присоединились";
    }
  }, [myDecision]);

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
      setDecisionSuccess(null);

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

      if (appliedStatus === "JOINED") {
        setDecisionSuccess("Вы успешно присоединились к игре");
      } else if (appliedStatus === "WAITLIST") {
        setDecisionSuccess("Мест нет, вы добавлены в лист ожидания");
      } else {
        setDecisionSuccess("Вы отказались от участия");
      }

      setSubmitting(null);
    },
    [comment, game, profile],
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
              window.location.href = cabinetUrl || DEFAULT_CABINET_URL;
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
  const canJoin = submitting === null && !alreadyJoined;
  const canDecline = submitting === null;

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
      </div>

      <div className="game-section">
        <div className="game-section-title">Комментарий к ответу</div>
        <textarea
          className="game-input game-join-comment"
          placeholder="Например: буду с партнером / опоздаю на 10 минут"
          value={comment}
          onChange={(event) => setComment(event.target.value.slice(0, 300))}
        />
      </div>

      {decisionError && (
        <div className="game-section">
          <div className="game-empty game-pay-error">{decisionError}</div>
        </div>
      )}
      {decisionSuccess && (
        <div className="game-section">
          <div className="game-empty">{decisionSuccess}</div>
        </div>
      )}

      <div className="game-section game-join-actions">
        {!alreadyJoined && (
          <button
            className="section-cta"
            type="button"
            disabled={!canJoin}
            onClick={() => {
              void applyDecision("join");
            }}
          >
            {submitting === "join" ? "Сохраняем..." : "Присоединиться"}
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
      </div>

      <div className="game-section game-join-actions game-join-footer">
        <button
          className="section-cta"
          type="button"
          onClick={() => {
            window.location.href = cabinetUrl || DEFAULT_CABINET_URL;
          }}
        >
          Перейти в личный кабинет
        </button>
        <button
          className="section-cta section-cta-secondary"
          type="button"
          onClick={() => {
            logout();
          }}
        >
          Выйти
        </button>
      </div>
    </div>
  );
}
