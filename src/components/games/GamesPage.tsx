import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  GameCourtOption,
  GameTimeSlot,
  PadelGameChatMessage,
  PadelGamePlayer,
  PadelGameRecord,
  PadelGameRecordPayload,
  Studio,
} from "../../utils/apiClient";
import {
  apiCreatePadelGameRecord,
  apiFetchPadelGameChatMessages,
  apiFetchPadelGameRecord,
  apiFetchPadelGamesByPhone,
  apiMarkPadelGameChatRead,
  apiPayMasterService,
  apiSendPadelGameChatMessage,
  apiFetchMasterServicePrice,
  apiFetchMasterServiceTimeslots,
  apiFetchOnboardingStations,
  apiFetchProfile,
} from "../../utils/apiClient";
import {
  CUSTOM_FIELD_IDS,
  getCustomFieldValue,
  getLetterGrade,
  parseNumericLevel,
} from "../../utils/customFields";
import {
  GAMES_BUNDLE_URL,
  PUBLIC_INVITE_ORIGIN,
  PUBLIC_INVITE_PATH,
} from "../../consts/api_config";

interface GamesPageProps {
  onBack: () => void;
  openChat?: boolean;
  openGameId?: string | null;
}

type Step = "create" | "place" | "time" | "details" | "chat";

const RATING_LABELS = ["D", "D+", "C", "C+", "B", "B+", "A"];

const DAYS_BEFORE_TODAY = 0;
const DAYS_AFTER_TODAY = 14;
const TODAY_DATE_INDEX = DAYS_BEFORE_TODAY;
const MAX_GAME_PLAYERS = 4;
const PENDING_GAME_DRAFT_KEY = "padlhub.pendingPaidGameDraft.v1";
const PAYMENT_REF_QUERY_KEY = "phPaymentRef";
const PUBLIC_GAMES_ORIGIN_FALLBACK = "https://padlhub.su";
const INVITE_JOIN_PATH = PUBLIC_INVITE_PATH;

function formatPrice(value: number): string {
  return value.toLocaleString("ru-RU");
}

function formatCourtsLabel(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  let word = "кортов";

  if (mod100 < 11 || mod100 > 14) {
    if (mod10 === 1) word = "корт";
    else if (mod10 >= 2 && mod10 <= 4) word = "корта";
  }

  return `Панорамик: ${count} ${word}`;
}

function extractCourtOrder(name: string): number | null {
  const bySign = name.match(/№\s*(\d+)/i);
  if (bySign) {
    const value = Number.parseInt(bySign[1], 10);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

function formatDateLocalIso(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local");
}

function resolvePublicGamesOrigin(current: URL): string {
  const isLocalHost = isLocalHostname(current.hostname);

  if (!isLocalHost) {
    return current.origin;
  }

  const fromBundle = (GAMES_BUNDLE_URL || "").trim();
  if (fromBundle) {
    try {
      const parsed = new URL(fromBundle);
      if (!isLocalHostname(parsed.hostname)) {
        return parsed.origin;
      }
    } catch {
      // fallback below
    }
  }

  return PUBLIC_GAMES_ORIGIN_FALLBACK;
}

function normalizeInviteUrl(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (typeof window === "undefined") return raw;

  try {
    const currentUrl = new URL(window.location.href);
    const parsed = new URL(raw, currentUrl.origin);
    const hasJoinGame = Boolean(parsed.searchParams.get("joinGame")?.trim());

    if (hasJoinGame) {
      const normalized = new URL(INVITE_JOIN_PATH, PUBLIC_INVITE_ORIGIN);
      parsed.searchParams.forEach((paramValue, key) => {
        normalized.searchParams.set(key, paramValue);
      });
      return normalized.toString();
    }

    if (!isLocalHostname(parsed.hostname)) {
      return parsed.toString();
    }

    const publicOrigin = resolvePublicGamesOrigin(currentUrl);
    const normalized = new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, publicOrigin);
    return normalized.toString();
  } catch {
    return raw;
  }
}

function buildBaseRedirectUrl(
  fromDate: string,
  extraParams: Record<string, string | null | undefined> = {},
): string | null {
  if (typeof window === "undefined") return null;
  try {
    const currentUrl = new URL(window.location.href);
    const publicOrigin = resolvePublicGamesOrigin(currentUrl);
    const url = new URL(`${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`, publicOrigin);
    const instanceNameRaw = url.searchParams.get("instanceName") || "PadlTerekhovo";
    const instanceName = instanceNameRaw.trim() || "PadlTerekhovo";
    url.searchParams.set(`${instanceName}_date`, fromDate);
    url.searchParams.set("instanceName", instanceName);
    Object.entries(extraParams).forEach(([key, value]) => {
      if (value == null || !key.trim()) return;
      url.searchParams.set(key, value);
    });
    return `${url.origin}${url.pathname}?${url.searchParams.toString()}`;
  } catch {
    return window.location.href || null;
  }
}

function buildInviteFallbackUrl(gameId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const url = new URL(INVITE_JOIN_PATH, PUBLIC_INVITE_ORIGIN);
    url.searchParams.set("joinGame", gameId);
    return `${url.origin}${url.pathname}?${url.searchParams.toString()}`;
  } catch {
    return null;
  }
}

function generatePaymentRef(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

type PendingPaidGameDraft = {
  paymentRef: string;
  payload: PadelGameRecordPayload;
};

type MatchSnapshot = {
  studioName: string | null;
  roomName: string | null;
  date: string | null;
  timeFrom: string | null;
  timeTo: string | null;
  durationMinutes: number | null;
  amount: number | null;
};

function toDateKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const directDate = value.match(/^(\d{4}-\d{2}-\d{2})/);
  if (directDate?.[1]) return directDate[1];
  const fromIso = value.match(/(\d{4}-\d{2}-\d{2})T/);
  if (fromIso?.[1]) return fromIso[1];
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatDateLocalIso(parsed);
}

function toTimeKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const direct = value.match(/^(\d{2}:\d{2})/);
  if (direct?.[1]) return direct[1];
  const fromIso = value.match(/T(\d{2}:\d{2})/);
  if (fromIso?.[1]) return fromIso[1];
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${String(parsed.getHours()).padStart(2, "0")}:${String(parsed.getMinutes()).padStart(2, "0")}`;
}

function buildMatchSnapshotFromPayload(payload: PadelGameRecordPayload): MatchSnapshot {
  const date =
    toDateKey(payload.booking.date) ??
    toDateKey(payload.booking.timeFromIso) ??
    toDateKey(payload.booking.timeToIso);
  const timeFrom = toTimeKey(payload.booking.timeFrom) ?? toTimeKey(payload.booking.timeFromIso);
  const timeTo = toTimeKey(payload.booking.timeTo) ?? toTimeKey(payload.booking.timeToIso);

  return {
    studioName: payload.booking.studioName ?? null,
    roomName: payload.booking.roomName ?? null,
    date,
    timeFrom,
    timeTo,
    durationMinutes: payload.booking.durationMinutes ?? null,
    amount: payload.payment.amount ?? null,
  };
}

function buildMatchSnapshotFromRecord(record: PadelGameRecord): MatchSnapshot | null {
  if (!record.booking && !record.payment) return null;
  const booking = record.booking;
  return {
    studioName: booking?.studioName ?? null,
    roomName: booking?.roomName ?? null,
    date: toDateKey(booking?.date),
    timeFrom: toTimeKey(booking?.timeFrom),
    timeTo: toTimeKey(booking?.timeTo),
    durationMinutes: booking?.durationMinutes ?? null,
    amount: record.payment?.amount ?? null,
  };
}

function mergeMatchSnapshots(current: MatchSnapshot | null, incoming: MatchSnapshot | null) {
  if (!incoming) return current;
  if (!current) return incoming;
  return {
    studioName: incoming.studioName ?? current.studioName,
    roomName: incoming.roomName ?? current.roomName,
    date: incoming.date ?? current.date,
    timeFrom: incoming.timeFrom ?? current.timeFrom,
    timeTo: incoming.timeTo ?? current.timeTo,
    durationMinutes: incoming.durationMinutes ?? current.durationMinutes,
    amount: incoming.amount ?? current.amount,
  };
}

function upsertPadelGameRecord(
  current: PadelGameRecord[],
  incoming: PadelGameRecord,
): PadelGameRecord[] {
  const normalizedIncomingInvite = normalizeInviteUrl(incoming.inviteUrl);
  const existingIndex = current.findIndex((item) => item.id === incoming.id);
  if (existingIndex < 0) {
    return [{ ...incoming, inviteUrl: normalizedIncomingInvite }, ...current];
  }

  const existing = current[existingIndex];
  const normalizedExistingInvite = normalizeInviteUrl(existing.inviteUrl);
  const merged: PadelGameRecord = {
    ...existing,
    ...incoming,
    inviteUrl: normalizedIncomingInvite ?? normalizedExistingInvite,
    status: incoming.status ?? existing.status,
    organizer: incoming.organizer ?? existing.organizer ?? null,
    settings: incoming.settings ?? existing.settings ?? null,
    participants:
      incoming.participants && incoming.participants.length > 0
        ? incoming.participants
        : (existing.participants ?? []),
    waitlist:
      incoming.waitlist && incoming.waitlist.length > 0
        ? incoming.waitlist
        : (existing.waitlist ?? []),
    chatUrl: incoming.chatUrl ?? existing.chatUrl ?? null,
    metadata: incoming.metadata ?? existing.metadata ?? null,
    booking: incoming.booking ?? existing.booking ?? null,
    payment: incoming.payment ?? existing.payment ?? null,
  };

  const next = [...current];
  next[existingIndex] = merged;
  return next;
}

function getPlayerInitials(name: string | null | undefined): string {
  const value = (name || "").trim();
  if (!value) return "";
  return value
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();
}

function getDateBadge(dateValue: string | null) {
  if (!dateValue) {
    return { month: "—", day: "—" };
  }
  const parsed = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return { month: "—", day: "—" };
  }
  return {
    month: parsed
      .toLocaleDateString("ru-RU", { month: "short" })
      .replace(".", "")
      .toUpperCase(),
    day: parsed.toLocaleDateString("ru-RU", { day: "2-digit" }),
  };
}

function formatGameCardDate(dateValue: string | null): string {
  if (!dateValue) return "Дата не указана";
  const parsed = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return "Дата не указана";
  return parsed.toLocaleDateString("ru-RU", {
    weekday: "long",
    day: "2-digit",
    month: "long",
  });
}

function normalizePhoneForGame(value: string | null | undefined): string | null {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

function addMinutesToTime(timeValue: string, minutesToAdd: number): string {
  const [hoursRaw, minutesRaw] = timeValue.split(":");
  const hours = Number.parseInt(hoursRaw ?? "", 10);
  const minutes = Number.parseInt(minutesRaw ?? "", 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return timeValue;

  const dayMinutes = 24 * 60;
  const total = hours * 60 + minutes + minutesToAdd;
  const normalized = ((total % dayMinutes) + dayMinutes) % dayMinutes;
  const nextHours = String(Math.floor(normalized / 60)).padStart(2, "0");
  const nextMinutes = String(normalized % 60).padStart(2, "0");
  return `${nextHours}:${nextMinutes}`;
}

function mergeChatMessages(
  current: PadelGameChatMessage[],
  incoming: PadelGameChatMessage[],
): PadelGameChatMessage[] {
  const keyFor = (message: PadelGameChatMessage) => {
    const sender = message.sender?.phoneNorm || message.sender?.id || "unknown";
    return `${message.createdTs}|${sender}|${message.text}`;
  };

  const bucket = new Map<string, PadelGameChatMessage>();
  [...current, ...incoming].forEach((message) => {
    bucket.set(keyFor(message), message);
  });

  return Array.from(bucket.values()).sort((left, right) => left.createdTs - right.createdTs);
}

function formatChatTime(value: string | null, fallbackTs: number): string {
  const parsed = value ? new Date(value) : new Date(fallbackTs || Date.now());
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function isPanoramicCourtName(roomName: string): boolean {
  return /панорам|panoramic/i.test(roomName);
}

interface StudioMapPoint extends Studio {
  lat: number;
  lng: number;
}

const NEAREST_MAP_STUDIOS_LIMIT = 5;

let leafletLoader: Promise<any> | null = null;

function toFloat(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function hasValidCoordinates(lat: unknown, lng: unknown): lat is number {
  const parsedLat = toFloat(lat);
  const parsedLng = toFloat(lng);
  if (parsedLat === null || parsedLng === null) return false;
  return Math.abs(parsedLat) <= 90 && Math.abs(parsedLng) <= 180;
}

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function distanceBetweenPointsMeters(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
) {
  const earthRadius = 6371000;
  const dLat = toRadians(toLat - fromLat);
  const dLng = toRadians(toLng - fromLng);
  const lat1 = toRadians(fromLat);
  const lat2 = toRadians(toLat);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadius * c;
}

function pickNearestStudiosForViewport(
  studios: StudioMapPoint[],
  userLocation: { lat: number; lng: number },
  limit: number,
) {
  if (studios.length <= limit) return studios;
  return studios
    .map((studio) => ({
      studio,
      distance: distanceBetweenPointsMeters(
        userLocation.lat,
        userLocation.lng,
        studio.lat,
        studio.lng,
      ),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, Math.max(1, limit))
    .map((entry) => entry.studio);
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function geocodeStudio(studio: Studio, signal: AbortSignal) {
  const parts = [studio.address, studio.city, studio.country, studio.name]
    .map((part) => (part || "").trim())
    .filter(Boolean);
  if (!parts.length) return null;

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("q", parts.join(", "));

  const response = await fetch(url.toString(), {
    method: "GET",
    signal,
    headers: { "Accept-Language": "ru" },
  });
  if (!response.ok) return null;

  const payload = (await response.json().catch(() => null)) as Array<{
    lat?: string;
    lon?: string;
  }> | null;
  const first = Array.isArray(payload) ? payload[0] : null;
  if (!first) return null;

  const lat = toFloat(first.lat);
  const lng = toFloat(first.lon);
  if (!hasValidCoordinates(lat, lng) || lat === null || lng === null) return null;
  return { lat, lng };
}

function loadLeaflet() {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("window is undefined"));
  }

  const withLeaflet = window as Window & { L?: any };
  if (withLeaflet.L) return Promise.resolve(withLeaflet.L);
  if (leafletLoader) return leafletLoader;

  leafletLoader = new Promise((resolve, reject) => {
    if (!document.getElementById("leaflet-css")) {
      const link = document.createElement("link");
      link.id = "leaflet-css";
      link.rel = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(link);
    }

    const existing = document.getElementById("leaflet-js");
    if (existing) {
      existing.addEventListener("load", () => resolve((window as Window & { L?: any }).L));
      existing.addEventListener("error", () => reject(new Error("Leaflet script load failed")));
      return;
    }

    const script = document.createElement("script");
    script.id = "leaflet-js";
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    script.async = true;
    script.onload = () => resolve((window as Window & { L?: any }).L);
    script.onerror = () => reject(new Error("Leaflet script load failed"));
    document.body.appendChild(script);
  });

  return leafletLoader;
}

function getGeoErrorMessage(error: GeolocationPositionError): string {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return "Разрешите доступ к геопозиции в браузере";
    case error.POSITION_UNAVAILABLE:
      return "Местоположение недоступно";
    case error.TIMEOUT:
      return "Не удалось определить местоположение (таймаут)";
    default:
      return "Не удалось определить местоположение";
  }
}

export default function GamesPage({ onBack, openGameId = null, openChat = false }: GamesPageProps) {
  const [step, setStep] = useState<Step>("create");
  const [studios, setStudios] = useState<Studio[]>([]);
  const [timeslots, setTimeslots] = useState<GameTimeSlot[]>([]);
  const [loadingTimeslots, setLoadingTimeslots] = useState(false);
  const [timeslotsError, setTimeslotsError] = useState<string | null>(null);
  const [studiosQuery, setStudiosQuery] = useState("");
  const [studio, setStudio] = useState<Studio | null>(null);
  const [duration, setDuration] = useState(60);
  const [dateIndex, setDateIndex] = useState(TODAY_DATE_INDEX);
  const [time, setTime] = useState<string | null>(null);
  const [courtId, setCourtId] = useState<string | null>(null);
  const [slotPrice, setSlotPrice] = useState<number | null>(null);
  const [loadingSlotPrice, setLoadingSlotPrice] = useState(false);
  const [loadingPay, setLoadingPay] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [ratingGame, setRatingGame] = useState(true);
  const [minRating, setMinRating] = useState(1);
  const [maxRating, setMaxRating] = useState(4);
  const [isPrivate, setIsPrivate] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<PadelGameChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatRefreshing, setChatRefreshing] = useState(false);
  const [chatSending, setChatSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatDraft, setChatDraft] = useState("");
  const [gameRecordId, setGameRecordId] = useState<string | null>(null);
  const [gameRecordStatus, setGameRecordStatus] = useState<string | null>(null);
  const [gamePaymentUrl, setGamePaymentUrl] = useState<string | null>(null);
  const [gamePaid, setGamePaid] = useState<boolean | null>(null);
  const [gameSnapshot, setGameSnapshot] = useState<MatchSnapshot | null>(null);
  const [checkingGameStatus, setCheckingGameStatus] = useState(false);
  const [retryingPayment, setRetryingPayment] = useState(false);
  const [gameRecordError, setGameRecordError] = useState<string | null>(null);
  const [restoringPaidGame, setRestoringPaidGame] = useState(false);
  const [participants, setParticipants] = useState<PadelGamePlayer[]>([]);
  const [waitlistPlayers, setWaitlistPlayers] = useState<PadelGamePlayer[]>([]);
  const [waitlistEnabled, setWaitlistEnabled] = useState(true);
  const [loadingStudios, setLoadingStudios] = useState(false);
  const [studiosError, setStudiosError] = useState<string | null>(null);
  const [createdGames, setCreatedGames] = useState<PadelGameRecord[]>([]);
  const [loadingCreatedGames, setLoadingCreatedGames] = useState(false);
  const [createdGamesError, setCreatedGamesError] = useState<string | null>(null);
  const [copiedGameInviteId, setCopiedGameInviteId] = useState<string | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [profilePhone, setProfilePhone] = useState<string | null>(null);
  const [profileName, setProfileName] = useState("Организатор");
  const [profileGrade, setProfileGrade] = useState("D+");
  const [profilePhoto, setProfilePhoto] = useState<string | null>(null);
  const [ringFraction, setRingFraction] = useState(0);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [mapLoading, setMapLoading] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [locatingUser, setLocatingUser] = useState(false);
  const [userLocationError, setUserLocationError] = useState<string | null>(null);
  const [userLocation, setUserLocation] = useState<{
    lat: number;
    lng: number;
    accuracy: number;
  } | null>(null);
  const [geocodeLoading, setGeocodeLoading] = useState(false);
  const [geocodedCoords, setGeocodedCoords] = useState<Record<string, { lat: number; lng: number }>>({});
  const [avatarError, setAvatarError] = useState(false);
  const mapHostRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<any | null>(null);
  const mapMarkersRef = useRef<any | null>(null);
  const timeDateRowRef = useRef<HTMLDivElement | null>(null);
  const geocodingIdsRef = useRef<Set<string>>(new Set());
  const userLocationRequestedRef = useRef(false);
  const autoLocationAttemptedRef = useRef(false);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);

  const dates = useMemo(() => {
    const base = new Date();
    const totalDays = DAYS_BEFORE_TODAY + DAYS_AFTER_TODAY + 1;
    return Array.from({ length: totalDays }).map((_, i) => {
      const d = new Date(base);
      d.setDate(base.getDate() + (i - DAYS_BEFORE_TODAY));
      return d;
    });
  }, []);

  useEffect(() => {
    if (step !== "place") return;

    let alive = true;
    setLoadingStudios(true);
    setStudiosError(null);

    apiFetchOnboardingStations()
      .then((res) => {
        if (!alive) return;
        const nextStudios = Array.isArray(res.data) ? res.data : [];
        setStudios(nextStudios);
        setStudio((prev) =>
          prev && nextStudios.some((station) => station.id === prev.id) ? prev : null,
        );
        if (res.error) {
          setStudiosError(res.error.message || "Не удалось загрузить станции");
        }
      })
      .catch(() => {
        if (!alive) return;
        setStudios([]);
        setStudiosError("Не удалось загрузить станции");
      })
      .finally(() => {
        if (alive) setLoadingStudios(false);
      });

    return () => {
      alive = false;
    };
  }, [step]);

  useEffect(() => {
    apiFetchProfile().then((res) => {
      if (!res.data) return;
      const fullName = [res.data.firstName, res.data.lastName]
        .filter(Boolean)
        .join(" ");
      setProfileId(res.data.id ?? null);
      setProfilePhone(res.data.phone ?? null);
      setProfileName(fullName || "Организатор");
      setProfilePhoto(res.data.photo ?? null);

      const explicitGrade = getCustomFieldValue(
        res.data,
        CUSTOM_FIELD_IDS.lkPadelLevel,
      );
      const numericValue = parseNumericLevel(
        getCustomFieldValue(res.data, CUSTOM_FIELD_IDS.lkPadelLevelNumeric),
      );
      const gradeFallback: Record<string, number> = {
        D: 2.0,
        "D+": 2.5,
        C: 3.0,
        "C+": 3.5,
        B: 4.2,
        "B+": 5.0,
        A: 6.0,
      };
      const numeric =
        numericValue ??
        (explicitGrade && gradeFallback[explicitGrade]
          ? gradeFallback[explicitGrade]
          : null);
      const fraction =
        numeric != null
          ? Math.max(0, Math.min(1, numeric - Math.floor(numeric)))
          : 0;
      setRingFraction(fraction);
      if (explicitGrade) {
        setProfileGrade(explicitGrade);
      } else if (numeric !== null) {
        setProfileGrade(getLetterGrade(numeric));
      }

      setParticipants([
        {
          id: res.data.id ?? null,
          name: fullName || "Организатор",
          phone: res.data.phone ?? null,
          photo: res.data.photo ?? null,
          rating: explicitGrade ?? (numeric !== null ? getLetterGrade(numeric) : null),
          source: "ORGANIZER",
          status: "CONFIRMED",
        },
      ]);
    });
  }, []);

  useEffect(() => {
    const phone = (profilePhone || "").trim();
    if (!phone) return;

    let alive = true;
    setLoadingCreatedGames(true);
    setCreatedGamesError(null);

    apiFetchPadelGamesByPhone(phone, profileId)
      .then((result) => {
        if (!alive) return;
        setCreatedGames(Array.isArray(result.data) ? result.data : []);
        if (result.error) {
          setCreatedGamesError(result.error.message || "Не удалось загрузить игры");
        }
      })
      .catch(() => {
        if (!alive) return;
        setCreatedGames([]);
        setCreatedGamesError("Не удалось загрузить игры");
      })
      .finally(() => {
        if (alive) setLoadingCreatedGames(false);
      });

    return () => {
      alive = false;
    };
  }, [profilePhone, profileId]);

  const filteredStudios = studios.filter((s) => {
    if (!studiosQuery.trim()) return true;
    const q = studiosQuery.toLowerCase();
    return (
      s.name.toLowerCase().includes(q) ||
      s.address.toLowerCase().includes(q) ||
      s.city.toLowerCase().includes(q)
    );
  });

  const studiosByCity = useMemo(() => {
    const groups = new Map<string, Studio[]>();
    filteredStudios.forEach((item) => {
      const city = item.city.trim() || "Другой город";
      const current = groups.get(city) ?? [];
      current.push(item);
      groups.set(city, current);
    });
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b, "ru"));
  }, [filteredStudios]);

  const mapStudios = useMemo<StudioMapPoint[]>(() => {
    return filteredStudios.flatMap((item) => {
      const fallback = geocodedCoords[item.id];
      const latSource = hasValidCoordinates(item.lat, item.lng) ? toFloat(item.lat) : fallback?.lat ?? null;
      const lngSource = hasValidCoordinates(item.lat, item.lng) ? toFloat(item.lng) : fallback?.lng ?? null;
      if (latSource === null || lngSource === null) return [];
      return [{ ...item, lat: latSource, lng: lngSource }];
    });
  }, [filteredStudios, geocodedCoords]);

  const durationScopedSlots = useMemo<GameTimeSlot[]>(() => {
    if (timeslots.length === 0) return [];
    return timeslots.filter(
      (slot) => slot.durationMinutes == null || slot.durationMinutes >= duration,
    );
  }, [timeslots, duration]);

  const availableCourts = useMemo<GameCourtOption[]>(() => {
    if (durationScopedSlots.length === 0) return [];
    const scoped = time
      ? durationScopedSlots.filter((slot) => slot.time === time)
      : durationScopedSlots;
    const map = new Map<string, GameCourtOption>();
    scoped.forEach((slot) => {
      const current = map.get(slot.roomId);
      if (!current) {
        map.set(slot.roomId, {
          id: slot.roomId,
          name: slot.roomName || "Корт",
          price: slot.price ?? null,
        });
        return;
      }
      if (current.price == null && slot.price != null) {
        map.set(slot.roomId, { ...current, price: slot.price });
      }
    });
    return Array.from(map.values()).sort((a, b) => {
      const aOrder = extractCourtOrder(a.name);
      const bOrder = extractCourtOrder(b.name);
      if (aOrder !== null && bOrder !== null) return aOrder - bOrder;
      if (aOrder !== null) return -1;
      if (bOrder !== null) return 1;
      return a.name.localeCompare(b.name, "ru");
    });
  }, [durationScopedSlots, time]);

  const availableTimeSlots = useMemo<string[]>(() => {
    if (durationScopedSlots.length === 0) return [];
    const scoped = courtId
      ? durationScopedSlots.filter((slot) => slot.roomId === courtId)
      : durationScopedSlots;
    const unique = Array.from(new Set(scoped.map((slot) => slot.time)));
    return unique.sort((a, b) => a.localeCompare(b, "ru"));
  }, [durationScopedSlots, courtId]);
  const studioSubServiceIds = studio?.subServiceIds ?? [];
  const studioSubServiceKey = studioSubServiceIds.join(",");
  const studioPreferredSubServiceId = studio?.preferredSubServiceId ?? null;

  useEffect(() => {
    if (!courtId) return;
    if (availableCourts.some((court) => court.id === courtId)) return;
    setCourtId(null);
  }, [availableCourts, courtId]);

  useEffect(() => {
    if (!time) return;
    if (availableTimeSlots.includes(time)) return;
    setTime(null);
  }, [availableTimeSlots, time]);

  useEffect(() => {
    if (!timeDateRowRef.current) return;
    const activeButton = timeDateRowRef.current.querySelector<HTMLButtonElement>(
      `[data-date-index="${dateIndex}"]`,
    );
    if (!activeButton) return;
    activeButton.scrollIntoView({
      behavior: "smooth",
      inline: "center",
      block: "nearest",
    });
  }, [dateIndex, step]);

  useEffect(() => {
    if (step !== "time" || !studio) return;
    const targetDate = dates[dateIndex];
    if (!targetDate) return;

    let alive = true;
    setLoadingTimeslots(true);
    setTimeslotsError(null);

    apiFetchMasterServiceTimeslots(formatDateLocalIso(targetDate), {
      studioId: studio.id,
      masterServiceId: studio.masterServiceId ?? null,
      preferredSubServiceId: studioPreferredSubServiceId ?? studioSubServiceIds[0] ?? null,
      preferredSubServiceIds: studioSubServiceIds,
    })
      .then((res) => {
        if (!alive) return;
        const nextSlots = (Array.isArray(res.data) ? res.data : []).filter((slot) =>
          isPanoramicCourtName(slot.roomName),
        );
        setTimeslots(nextSlots);
        if (res.error) {
          setTimeslotsError(res.error.message || "Не удалось загрузить расписание кортов");
        }
      })
      .catch(() => {
        if (!alive) return;
        setTimeslots([]);
        setTimeslotsError("Не удалось загрузить расписание кортов");
      })
      .finally(() => {
        if (alive) setLoadingTimeslots(false);
      });

    return () => {
      alive = false;
    };
  }, [
    step,
    studio?.id,
    studio?.masterServiceId,
    studioPreferredSubServiceId,
    studioSubServiceKey,
    dateIndex,
    dates,
  ]);

  const requestUserLocation = useCallback(() => {
    if (typeof window === "undefined" || !navigator.geolocation) {
      setUserLocationError("Геолокация не поддерживается");
      return;
    }

    userLocationRequestedRef.current = true;
    setLocatingUser(true);
    setUserLocationError(null);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setUserLocation({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
        setLocatingUser(false);
      },
      (error) => {
        setLocatingUser(false);
        setUserLocationError(getGeoErrorMessage(error));
        userLocationRequestedRef.current = false;
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 60_000,
      },
    );
  }, []);

  useEffect(() => {
    if (step !== "place" || !mapOpen) return;
    if (userLocation || locatingUser || autoLocationAttemptedRef.current) return;
    autoLocationAttemptedRef.current = true;
    requestUserLocation();
  }, [step, mapOpen, userLocation, locatingUser, requestUserLocation]);

  useEffect(() => {
    if (step !== "place" || !mapOpen) return;

    const missing = filteredStudios.filter((item) => {
      if (hasValidCoordinates(item.lat, item.lng)) return false;
      if (geocodedCoords[item.id]) return false;
      if (geocodingIdsRef.current.has(item.id)) return false;
      return true;
    });

    if (missing.length === 0) {
      setGeocodeLoading(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setGeocodeLoading(true);

    (async () => {
      for (const item of missing) {
        geocodingIdsRef.current.add(item.id);
        const coords = await geocodeStudio(item, controller.signal).catch(() => null);
        if (cancelled) return;
        if (coords) {
          setGeocodedCoords((prev) => (prev[item.id] ? prev : { ...prev, [item.id]: coords }));
        }
        await delay(150);
      }
    })()
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setGeocodeLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [step, mapOpen, filteredStudios, geocodedCoords]);

  useEffect(() => {
    if (step !== "place" || !mapOpen) return;
    const host = mapHostRef.current;
    if (!host) return;

    let cancelled = false;
    setMapLoading(true);
    setMapError(null);

    loadLeaflet()
      .then((L) => {
        if (cancelled) return;

        if (!mapInstanceRef.current) {
          mapInstanceRef.current = L.map(host, {
            zoomControl: true,
            attributionControl: false,
          });
          L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19,
          }).addTo(mapInstanceRef.current);
          mapMarkersRef.current = L.layerGroup().addTo(mapInstanceRef.current);
        }

        const map = mapInstanceRef.current;
        if (!mapMarkersRef.current) {
          mapMarkersRef.current = L.layerGroup().addTo(map);
        }
        const markers = mapMarkersRef.current;
        markers.clearLayers();

        if (mapStudios.length === 0 && !userLocation) {
          map.setView([55.751244, 37.618423], 10);
          window.setTimeout(() => map.invalidateSize(), 0);
          setMapLoading(false);
          return;
        }

        const bounds: Array<[number, number]> = [];
        const studiosForViewport = userLocation
          ? pickNearestStudiosForViewport(
              mapStudios,
              { lat: userLocation.lat, lng: userLocation.lng },
              NEAREST_MAP_STUDIOS_LIMIT,
            )
          : mapStudios;
        mapStudios.forEach((item) => {
          const selected = item.id === studio?.id;
          const marker = L.circleMarker([item.lat, item.lng], {
            radius: selected ? 9 : 7,
            color: selected ? "#7353d9" : "#4b5563",
            fillColor: selected ? "#7353d9" : "#ffffff",
            fillOpacity: 1,
            weight: 2,
          });
          marker.bindTooltip(item.name, { direction: "top", offset: [0, -8] });
          marker.on("click", () => {
            setStudio(item);
            setStep("create");
            setMapOpen(false);
          });
          marker.addTo(markers);
        });

        studiosForViewport.forEach((item) => {
          bounds.push([item.lat, item.lng]);
        });

        if (userLocation) {
          const meMarker = L.circleMarker([userLocation.lat, userLocation.lng], {
            radius: 8,
            color: "#0284c7",
            fillColor: "#0ea5e9",
            fillOpacity: 1,
            weight: 2,
          });
          meMarker.bindTooltip("Вы здесь", { direction: "top", offset: [0, -8] });
          meMarker.addTo(markers);
          if (Number.isFinite(userLocation.accuracy) && userLocation.accuracy > 0) {
            L.circle([userLocation.lat, userLocation.lng], {
              radius: userLocation.accuracy,
              color: "#0ea5e9",
              fillColor: "#38bdf8",
              fillOpacity: 0.14,
              weight: 1,
            }).addTo(markers);
          }
          bounds.push([userLocation.lat, userLocation.lng]);
        }

        if (bounds.length === 1) {
          map.setView(bounds[0], 12);
        } else {
          map.fitBounds(bounds, { padding: [24, 24], maxZoom: 13 });
        }

        window.setTimeout(() => map.invalidateSize(), 0);
        setMapLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setMapError("Не удалось загрузить карту");
        setMapLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [step, mapOpen, mapStudios, studio?.id, userLocation]);

  useEffect(() => {
    if (step === "place" && mapOpen) return;
    autoLocationAttemptedRef.current = false;
    userLocationRequestedRef.current = false;
    if (!mapInstanceRef.current) return;
    mapInstanceRef.current.remove();
    mapInstanceRef.current = null;
    mapMarkersRef.current = null;
  }, [step, mapOpen]);

  useEffect(() => {
    const requestedGameId = openGameId?.trim() || "";
    if (!requestedGameId) return;

    setGameRecordError(null);
    setGameRecordId(requestedGameId);
    setGameRecordStatus(null);
    setInviteLink(null);
    setGameSnapshot(null);
    setChatMessages([]);
    setChatError(null);
    setChatDraft("");
    setStep(openChat ? "chat" : "details");
  }, [openGameId, openChat]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const paymentRef = url.searchParams.get(PAYMENT_REF_QUERY_KEY)?.trim() || "";
    if (!paymentRef) return;

    const rawDraft = window.sessionStorage.getItem(PENDING_GAME_DRAFT_KEY);
    if (!rawDraft) return;

    let parsedDraft: PendingPaidGameDraft | null = null;
    try {
      const decoded = JSON.parse(rawDraft) as PendingPaidGameDraft;
      if (decoded && decoded.paymentRef === paymentRef && decoded.payload) {
        parsedDraft = decoded;
      }
    } catch {
      parsedDraft = null;
    }
    if (!parsedDraft) return;

    let alive = true;
    setRestoringPaidGame(true);
    setGameRecordError(null);
    const draftSnapshot = buildMatchSnapshotFromPayload(parsedDraft.payload);
    setGameSnapshot(draftSnapshot);
    setGamePaymentUrl(parsedDraft.payload.payment?.paymentUrl ?? null);
    setGamePaid(parsedDraft.payload.payment?.paid ?? null);

    const cleanupUrl = () => {
      url.searchParams.delete(PAYMENT_REF_QUERY_KEY);
      const search = url.searchParams.toString();
      const nextUrl = `${url.pathname}${search ? `?${search}` : ""}`;
      window.history.replaceState({}, "", nextUrl);
    };

    (async () => {
      const createResult = await apiCreatePadelGameRecord(parsedDraft.payload);
      if (!alive) return;
      if (createResult.data?.id) {
        const createdId = createResult.data.id;
        const fallbackInviteUrl = buildInviteFallbackUrl(createdId);
        const nextInviteLink =
          createResult.data.inviteUrl ??
          parsedDraft.payload.invite?.inviteUrl ??
          fallbackInviteUrl ??
          null;
        const recordSnapshot = buildMatchSnapshotFromRecord(createResult.data);
        setGameRecordId(createdId);
        setGameRecordStatus(createResult.data.status ?? parsedDraft.payload.status ?? "PAID");
        setInviteLink(normalizeInviteUrl(nextInviteLink));
        setGameSnapshot((prev) => mergeMatchSnapshots(prev, recordSnapshot));
        if (createResult.data.payment?.paymentUrl) {
          setGamePaymentUrl(createResult.data.payment.paymentUrl);
        }
        if (createResult.data.payment?.paid !== undefined && createResult.data.payment?.paid !== null) {
          setGamePaid(createResult.data.payment.paid);
        }
        if (createResult.data.payment?.amount != null) {
          setSlotPrice(createResult.data.payment.amount);
        }
        const fallbackRecord: PadelGameRecord = {
          id: createdId,
          inviteUrl: normalizeInviteUrl(nextInviteLink),
          status: createResult.data.status ?? parsedDraft.payload.status ?? "PAID",
          organizer: {
            id: parsedDraft.payload.organizer.id ?? null,
            name: parsedDraft.payload.organizer.name ?? null,
            phone: parsedDraft.payload.organizer.phone ?? null,
            photo: parsedDraft.payload.organizer.photo ?? null,
            rating: parsedDraft.payload.organizer.rating ?? null,
          },
          settings: {
            ratingGame: parsedDraft.payload.settings?.ratingGame ?? null,
            minRating: parsedDraft.payload.settings?.minRating ?? null,
            maxRating: parsedDraft.payload.settings?.maxRating ?? null,
            isPrivate: parsedDraft.payload.settings?.isPrivate ?? null,
          },
          participants: Array.isArray(parsedDraft.payload.participants)
            ? parsedDraft.payload.participants
            : [],
          waitlist: Array.isArray(parsedDraft.payload.waitlist)
            ? parsedDraft.payload.waitlist
            : [],
          chatUrl: null,
          metadata: parsedDraft.payload.metadata ?? null,
          booking: {
            studioName: draftSnapshot.studioName,
            roomName: draftSnapshot.roomName,
            date: draftSnapshot.date,
            timeFrom: draftSnapshot.timeFrom,
            timeTo: draftSnapshot.timeTo,
            durationMinutes: draftSnapshot.durationMinutes,
          },
          payment: {
            amount:
              createResult.data.payment?.amount ??
              parsedDraft.payload.payment.amount ??
              null,
            paymentUrl:
              createResult.data.payment?.paymentUrl ??
              parsedDraft.payload.payment.paymentUrl ??
              null,
            paid:
              createResult.data.payment?.paid ??
              parsedDraft.payload.payment.paid ??
              null,
          },
        };
        const nextRecord: PadelGameRecord = {
          ...fallbackRecord,
          ...createResult.data,
          organizer: createResult.data.organizer ?? fallbackRecord.organizer,
          settings: createResult.data.settings ?? fallbackRecord.settings,
          participants:
            createResult.data.participants && createResult.data.participants.length > 0
              ? createResult.data.participants
              : fallbackRecord.participants,
          waitlist:
            createResult.data.waitlist && createResult.data.waitlist.length > 0
              ? createResult.data.waitlist
              : fallbackRecord.waitlist,
          metadata: createResult.data.metadata ?? fallbackRecord.metadata,
          chatUrl: createResult.data.chatUrl ?? fallbackRecord.chatUrl,
          booking: createResult.data.booking ?? fallbackRecord.booking,
          payment: createResult.data.payment ?? fallbackRecord.payment,
        };
        setCreatedGames((prev) => upsertPadelGameRecord(prev, nextRecord));
        setParticipants(
          Array.isArray(parsedDraft.payload.participants)
            ? parsedDraft.payload.participants
            : [],
        );
        setWaitlistPlayers(
          Array.isArray(parsedDraft.payload.waitlist)
            ? parsedDraft.payload.waitlist
            : [],
        );
        setWaitlistEnabled(parsedDraft.payload.invite?.waitlistEnabled !== false);
        setStep("details");
      } else {
        setGameRecordError(
          createResult.error?.message || "Не удалось создать запись игры после оплаты",
        );
      }

      window.sessionStorage.removeItem(PENDING_GAME_DRAFT_KEY);
      cleanupUrl();
      setRestoringPaidGame(false);
    })();

    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if ((step !== "details" && step !== "chat") || !gameRecordId) return;

    let alive = true;
    setCheckingGameStatus(true);

    apiFetchPadelGameRecord(gameRecordId)
      .then((result) => {
        if (!alive) return;
        if (result.data) {
          const fetchedRecord = result.data;
          if (fetchedRecord.status) {
            setGameRecordStatus(fetchedRecord.status);
          }
          if (fetchedRecord.inviteUrl) {
            setInviteLink(normalizeInviteUrl(fetchedRecord.inviteUrl));
          }
          if (fetchedRecord.payment?.amount != null) {
            setSlotPrice(fetchedRecord.payment.amount);
          }
          if (fetchedRecord.payment?.paymentUrl) {
            setGamePaymentUrl(fetchedRecord.payment.paymentUrl);
          }
          if (fetchedRecord.payment?.paid !== undefined && fetchedRecord.payment?.paid !== null) {
            setGamePaid(fetchedRecord.payment.paid);
          }
          const snapshotFromRecord = buildMatchSnapshotFromRecord(fetchedRecord);
          setGameSnapshot((prev) => mergeMatchSnapshots(prev, snapshotFromRecord));
          setCreatedGames((prev) => upsertPadelGameRecord(prev, fetchedRecord));
          if (!result.error) {
            setGameRecordError(null);
          }
          return;
        }

        if (result.error) {
          setGameRecordError(result.error.message || "Не удалось получить статус оплаты игры");
        }
      })
      .catch(() => {
        if (!alive) return;
        setGameRecordError("Не удалось получить статус оплаты игры");
      })
      .finally(() => {
        if (alive) setCheckingGameStatus(false);
      });

    return () => {
      alive = false;
    };
  }, [step, gameRecordId]);

  const selectedCourt = availableCourts.find((c) => c.id === courtId);
  const selectedDate = dates[dateIndex];
  const selectedSlot = useMemo<GameTimeSlot | null>(() => {
    if (!courtId || !time) return null;
    const candidates = durationScopedSlots.filter(
      (slot) => slot.roomId === courtId && slot.time === time,
    );
    if (candidates.length === 0) return null;
    const byDuration = candidates.find((slot) => slot.durationMinutes === duration);
    if (byDuration) return byDuration;
    const withSubService = candidates.find((slot) => slot.subServiceIds.length > 0);
    return withSubService ?? candidates[0];
  }, [durationScopedSlots, courtId, time, duration]);
  const dateLabel = selectedDate
    ? selectedDate.toLocaleDateString("ru-RU", { day: "numeric", month: "long" })
    : "";
  const badgeMonth = selectedDate
    ? selectedDate
        .toLocaleDateString("ru-RU", { month: "short" })
        .replace(".", "")
        .toUpperCase()
    : "";
  const badgeDay = selectedDate
    ? selectedDate.toLocaleDateString("ru-RU", { day: "2-digit" })
    : "";

  useEffect(() => {
    if (!studio || !selectedDate || !courtId || !time || !selectedSlot) {
      setSlotPrice(null);
      setLoadingSlotPrice(false);
      return;
    }

    const subServiceIds =
      selectedSlot.subServiceIds.length > 0
        ? selectedSlot.subServiceIds
        : (studioSubServiceIds.length
            ? studioSubServiceIds
            : (studioPreferredSubServiceId ? [studioPreferredSubServiceId] : []));

    let alive = true;
    setLoadingSlotPrice(true);
    setSlotPrice(null);

    const fromTime = time;
    const toTime = addMinutesToTime(fromTime, duration);
    const fromDate = formatDateLocalIso(selectedDate);

    apiFetchMasterServicePrice({
      date: fromDate,
      fromTime,
      toTime,
      studioId: studio.id,
      roomId: courtId,
      subServiceIds,
      masterServiceId: studio.masterServiceId ?? null,
    })
      .then((res) => {
        if (!alive) return;
        if (typeof res.data === "number") {
          setSlotPrice(res.data);
          return;
        }
        setSlotPrice(null);
      })
      .catch(() => {
        if (!alive) return;
        setSlotPrice(null);
      })
      .finally(() => {
        if (alive) setLoadingSlotPrice(false);
      });

    return () => {
      alive = false;
    };
  }, [
    studio?.id,
    studio?.masterServiceId,
    studioPreferredSubServiceId,
    studioSubServiceKey,
    selectedDate,
    courtId,
    time,
    duration,
    selectedSlot?.id,
    selectedSlot?.subServiceIds,
  ]);

  const canCreate = Boolean(studio);
  const ratingRangeLabel = `${RATING_LABELS[minRating]} - ${RATING_LABELS[maxRating]}`;
  const ratingSubLabel = ratingGame
    ? "Игра влияет на рейтинг участников"
    : "Игра не влияет на рейтинг участников";
  const minPercent = (minRating / (RATING_LABELS.length - 1)) * 100;
  const maxPercent = (maxRating / (RATING_LABELS.length - 1)) * 100;

  const initials = profileName
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const ringSegments = 135;
  const filledSegments = Math.round(ringFraction * ringSegments);
  const noPanoramicSlots = !loadingTimeslots && !timeslotsError && timeslots.length === 0;
  const noDurationSlots =
    !loadingTimeslots &&
    !timeslotsError &&
    timeslots.length > 0 &&
    durationScopedSlots.length === 0;
  const noTimeSlotsForSelection =
    !loadingTimeslots &&
    !timeslotsError &&
    !noPanoramicSlots &&
    !noDurationSlots &&
    availableTimeSlots.length === 0;
  const noCourtsForSelection =
    !loadingTimeslots &&
    !timeslotsError &&
    !noPanoramicSlots &&
    !noDurationSlots &&
    availableCourts.length === 0;
  const canProceedToPayment = Boolean(studio && selectedDate && selectedCourt && selectedSlot && time);
  const paymentAmount = slotPrice ?? selectedSlot?.price ?? selectedCourt?.price ?? null;
  const paymentTitle = loadingPay
    ? "Оплатить · подготовка..."
    : loadingSlotPrice
      ? "Оплатить · расчет..."
    : paymentAmount != null && paymentAmount > 0
      ? `Оплатить · ${formatPrice(paymentAmount)} ₽`
      : "Оплатить · — ₽";
  const paymentStationCourt = studio && selectedCourt
    ? `${studio.name} · ${selectedCourt.name}`
    : "Выберите станцию и корт";
  const paymentTimeRange = time
    ? `${time} - ${addMinutesToTime(time, duration)} · ${duration} мин`
    : "Выберите время начала";
  const gameStatusUpper = (gameRecordStatus ?? "").trim().toUpperCase();
  const paidByStatus = gameStatusUpper.includes("PAID") || gameStatusUpper.includes("PAYED");
  const unpaidByStatus =
    gameStatusUpper.includes("PENDING") ||
    gameStatusUpper.includes("UNPAID") ||
    gameStatusUpper.includes("NOT_PAID");
  const isGamePaid = gamePaid ?? (paidByStatus ? true : unpaidByStatus ? false : null);
  const detailsDateKey = gameSnapshot?.date ?? (selectedDate ? formatDateLocalIso(selectedDate) : null);
  const detailsDateValue = detailsDateKey ? new Date(`${detailsDateKey}T00:00:00`) : null;
  const detailsDateLabel = detailsDateValue
    ? detailsDateValue.toLocaleDateString("ru-RU", {
        weekday: "long",
        day: "2-digit",
        month: "long",
      })
    : "Дата не указана";
  const detailsBadgeMonth = detailsDateValue
    ? detailsDateValue
        .toLocaleDateString("ru-RU", { month: "short" })
        .replace(".", "")
        .toUpperCase()
    : badgeMonth;
  const detailsBadgeDay = detailsDateValue
    ? detailsDateValue.toLocaleDateString("ru-RU", { day: "2-digit" })
    : badgeDay;
  const detailsTimeFrom = gameSnapshot?.timeFrom ?? time ?? null;
  const detailsDurationMinutes = gameSnapshot?.durationMinutes ?? duration;
  const detailsTimeTo =
    gameSnapshot?.timeTo ??
    (detailsTimeFrom ? addMinutesToTime(detailsTimeFrom, detailsDurationMinutes) : null);
  const detailsStudioName = gameSnapshot?.studioName ?? studio?.name ?? "Станция";
  const detailsRoomName = gameSnapshot?.roomName ?? selectedCourt?.name ?? "Корт";
  const detailsAmount = gameSnapshot?.amount ?? paymentAmount;
  const gamesForFeed = useMemo(() => {
    const toTimestamp = (game: PadelGameRecord) => {
      const date = game.booking?.date || "9999-12-31";
      const fromTime = game.booking?.timeFrom || "23:59";
      const parsed = new Date(`${date}T${fromTime.length === 5 ? `${fromTime}:00` : fromTime}`);
      if (Number.isNaN(parsed.getTime())) return Number.MAX_SAFE_INTEGER;
      return parsed.getTime();
    };

    return [...createdGames].sort((left, right) => toTimestamp(left) - toTimestamp(right));
  }, [createdGames]);
  const activeGameRecord = useMemo(
    () => (gameRecordId ? createdGames.find((item) => item.id === gameRecordId) ?? null : null),
    [createdGames, gameRecordId],
  );
  const canCurrentUserSendChat = useMemo(() => {
    const myPhone = normalizePhoneForGame(profilePhone);
    if (!myPhone) return false;
    if (!activeGameRecord) return true;

    const phones = new Set<string>();
    const pushPhone = (value: string | null | undefined) => {
      const normalized = normalizePhoneForGame(value);
      if (normalized) {
        phones.add(normalized);
      }
    };
    const pushFromUnknownArray = (value: unknown) => {
      if (!Array.isArray(value)) return;
      value.forEach((item) => {
        if (typeof item === "string") {
          pushPhone(item);
        }
      });
    };

    pushPhone(activeGameRecord.organizer?.phone ?? null);
    activeGameRecord.participants?.forEach((player) => pushPhone(player.phone));
    activeGameRecord.waitlist?.forEach((player) => pushPhone(player.phone));

    const metadata = activeGameRecord.metadata;
    if (metadata) {
      pushFromUnknownArray(metadata.allRelatedPhones);
      pushFromUnknownArray(metadata.participantPhones);
      pushFromUnknownArray(metadata.waitlistPhones);
      pushFromUnknownArray(metadata.invitedPhones);
    }

    if (phones.size === 0) return true;
    return phones.has(myPhone);
  }, [activeGameRecord, profilePhone]);

  const handleMasterServicePay = useCallback(async () => {
    if (!studio || !selectedDate || !courtId || !time || !selectedSlot) return;

    setLoadingPay(true);
    setPayError(null);
    setGameRecordError(null);

    const fromDate = formatDateLocalIso(selectedDate);
    const fromTime = time;
    const toTime = addMinutesToTime(fromTime, duration);
    const subServiceIds =
      selectedSlot.subServiceIds.length > 0
        ? selectedSlot.subServiceIds
        : (studioSubServiceIds.length
            ? studioSubServiceIds
            : (studioPreferredSubServiceId ? [studioPreferredSubServiceId] : []));
    const paymentRef = generatePaymentRef();
    const baseRedirectUrl = buildBaseRedirectUrl(fromDate, {
      [PAYMENT_REF_QUERY_KEY]: paymentRef,
    });

    let clientId = profileId;
    let clientPhone = profilePhone;
    if (!clientId || !clientPhone) {
      const profileResult = await apiFetchProfile();
      clientId = profileResult.data?.id ?? null;
      clientPhone = profileResult.data?.phone ?? null;
      if (profileResult.data?.id) setProfileId(profileResult.data.id);
      if (profileResult.data?.phone) setProfilePhone(profileResult.data.phone);
    }

    const paymentResult = await apiPayMasterService({
      date: fromDate,
      fromTime,
      toTime,
      studioId: studio.id,
      roomId: courtId,
      subServiceIds,
      masterServiceId: studio.masterServiceId ?? null,
      clientId,
      clientPhone,
      baseRedirectUrl,
    });

    if (paymentResult.data?.toPay && paymentResult.data.toPay > 0) {
      setSlotPrice(paymentResult.data.toPay);
    }

    if (paymentResult.data?.paymentUrl) {
      const normalizedParticipants = participants.length > 0
        ? participants
        : [
            {
              id: clientId ?? null,
              name: profileName || "Организатор",
              phone: clientPhone ?? null,
              photo: profilePhoto ?? null,
              rating: profileGrade ?? null,
              source: "ORGANIZER" as const,
              status: "CONFIRMED" as const,
            },
          ];
      const organizerPlayer =
        normalizedParticipants.find((player) => player.source === "ORGANIZER") ??
        normalizedParticipants[0] ?? {
          id: clientId ?? null,
          name: profileName || "Организатор",
          phone: clientPhone ?? null,
          photo: profilePhoto ?? null,
          rating: profileGrade ?? null,
        };
      const draftPayload: PadelGameRecordPayload = {
        tenantKey: null,
        status: "PAID",
        organizer: {
          id: clientId ?? organizerPlayer.id ?? null,
          name: profileName || organizerPlayer.name || "Организатор",
          phone: clientPhone ?? organizerPlayer.phone ?? null,
          photo: profilePhoto ?? organizerPlayer.photo ?? null,
          rating: profileGrade ?? organizerPlayer.rating ?? null,
        },
        booking: {
          studioId: studio.id,
          studioName: studio.name,
          masterServiceId: studio.masterServiceId ?? null,
          subServiceIds,
          roomId: courtId,
          roomName: selectedCourt?.name ?? "Корт",
          date: fromDate,
          timeFrom: fromTime,
          timeTo: toTime,
          timeFromIso: `${fromDate}T${fromTime}:00+03:00`,
          timeToIso: `${fromDate}T${toTime}:00+03:00`,
          durationMinutes: duration,
          slotId: selectedSlot.id ?? null,
        },
        payment: {
          amount: paymentResult.data.toPay ?? paymentAmount ?? null,
          paymentUrl: paymentResult.data.paymentUrl,
          paymentMethod: "WIDGET",
          baseRedirectUrl,
          paid: true,
        },
        settings: {
          ratingGame,
          minRating: RATING_LABELS[minRating] ?? null,
          maxRating: RATING_LABELS[maxRating] ?? null,
          isPrivate,
          payMode: "self",
        },
        invite: {
          inviteUrl: null,
          waitlistEnabled,
          maxPlayers: MAX_GAME_PLAYERS,
        },
        participants: normalizedParticipants.slice(0, MAX_GAME_PLAYERS),
        waitlist: waitlistPlayers,
        metadata: {
          paymentRef,
          source: "games_widget",
        },
      };

      try {
        window.sessionStorage.setItem(
          PENDING_GAME_DRAFT_KEY,
          JSON.stringify({ paymentRef, payload: draftPayload } satisfies PendingPaidGameDraft),
        );
      } catch {
        // Ignore storage issues: payment redirect should still work.
      }

      window.location.href = paymentResult.data.paymentUrl;
      return;
    }

    setPayError(paymentResult.error?.message ?? "Не удалось сформировать ссылку на оплату");
    setLoadingPay(false);
  }, [
    studio?.id,
    studio?.masterServiceId,
    studioPreferredSubServiceId,
    studioSubServiceKey,
    studio?.name,
    selectedDate,
    courtId,
    selectedCourt?.name,
    time,
    duration,
    profileId,
    profilePhone,
    profileName,
    profileGrade,
    profilePhoto,
    paymentAmount,
    ratingGame,
    minRating,
    maxRating,
    isPrivate,
    participants,
    waitlistEnabled,
    waitlistPlayers,
    selectedSlot?.id,
    selectedSlot?.subServiceIds,
  ]);

  useEffect(() => {
    setPayError(null);
  }, [studio?.id, selectedDate, courtId, time, duration, selectedSlot?.id]);

  useEffect(() => {
    if (isGamePaid === true) {
      setRetryingPayment(false);
    }
  }, [isGamePaid]);

  const handleCreateGame = () => {
    if (!studio) {
      setStep("place");
      return;
    }
    setStep("time");
  };

  const handleCopyInvite = async () => {
    if (!inviteLink) return;
    try {
      await navigator.clipboard?.writeText(inviteLink);
      setInviteCopied(true);
      window.setTimeout(() => setInviteCopied(false), 1600);
    } catch {
      setInviteCopied(false);
    }
  };

  const handleOpenGameFromFeed = useCallback((game: PadelGameRecord) => {
    setGameRecordError(null);
    setGameRecordId(game.id);
    setGameRecordStatus(game.status ?? null);
    setInviteLink(normalizeInviteUrl(game.inviteUrl));
    setGamePaymentUrl(game.payment?.paymentUrl ?? null);
    setGamePaid(game.payment?.paid ?? null);
    if (game.payment?.amount != null) {
      setSlotPrice(game.payment.amount);
    }
    setGameSnapshot(buildMatchSnapshotFromRecord(game));
    setStep("details");
  }, []);

  const handleCopyInviteFromFeed = useCallback(async (game: PadelGameRecord) => {
    const url = normalizeInviteUrl(game.inviteUrl) || "";
    if (!url) return;
    try {
      await navigator.clipboard?.writeText(url);
      setCopiedGameInviteId(game.id);
      window.setTimeout(() => {
        setCopiedGameInviteId((prev) => (prev === game.id ? null : prev));
      }, 1600);
    } catch {
      setCopiedGameInviteId(null);
    }
  }, []);

  const loadChatMessages = useCallback(
    async (mode: "initial" | "refresh" = "initial") => {
      if (!gameRecordId || !profilePhone) return;

      if (mode === "initial") {
        setChatLoading(true);
        setChatError(null);
      } else {
        setChatRefreshing(true);
      }

      const result = await apiFetchPadelGameChatMessages({
        gameId: gameRecordId,
        phone: profilePhone,
        limit: 100,
      });

      if (result.data) {
        setChatMessages((prev) => mergeChatMessages(prev, result.data?.messages ?? []));
        const lastMessage = result.data.messages[result.data.messages.length - 1];
        if (lastMessage?.createdTs) {
          void apiMarkPadelGameChatRead({
            gameId: gameRecordId,
            phone: profilePhone,
            lastReadTs: lastMessage.createdTs,
          });
        }
      } else if (result.error) {
        setChatError(result.error.message || "Не удалось загрузить чат");
      }

      if (mode === "initial") {
        setChatLoading(false);
      } else {
        setChatRefreshing(false);
      }
    },
    [gameRecordId, profilePhone],
  );

  useEffect(() => {
    if (step !== "chat" || !gameRecordId || !profilePhone) return;
    let alive = true;

    loadChatMessages("initial").catch(() => {
      if (!alive) return;
      setChatError("Не удалось загрузить чат");
      setChatLoading(false);
    });

    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void loadChatMessages("refresh");
    }, 7000);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [step, gameRecordId, profilePhone, loadChatMessages]);

  useEffect(() => {
    if (step !== "chat") return;
    if (!chatBottomRef.current) return;
    chatBottomRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [step, chatMessages.length]);

  const handleSendChatMessage = useCallback(async () => {
    const text = chatDraft.trim();
    if (!text || !gameRecordId || !profilePhone || chatSending) return;

    setChatSending(true);
    setChatError(null);

    const sendResult = await apiSendPadelGameChatMessage({
      gameId: gameRecordId,
      senderPhone: profilePhone,
      senderName: profileName,
      senderId: profileId,
      text,
    });

    const sentMessage = sendResult.data;
    if (sentMessage) {
      setChatMessages((prev) => mergeChatMessages(prev, [sentMessage]));
      setChatDraft("");
      void apiMarkPadelGameChatRead({
        gameId: gameRecordId,
        phone: profilePhone,
        lastReadTs: sentMessage.createdTs || Date.now(),
      });
    } else {
      setChatError(sendResult.error?.message || "Не удалось отправить сообщение");
    }

    setChatSending(false);
  }, [chatDraft, chatSending, gameRecordId, profileId, profileName, profilePhone]);

  const handleOpenGameChat = useCallback((game: PadelGameRecord) => {
    setGameRecordError(null);
    setGameRecordId(game.id);
    setGameRecordStatus(game.status ?? null);
    setInviteLink(normalizeInviteUrl(game.inviteUrl));
    setGamePaymentUrl(game.payment?.paymentUrl ?? null);
    setGamePaid(game.payment?.paid ?? null);
    setGameSnapshot(buildMatchSnapshotFromRecord(game));
    setChatMessages([]);
    setChatError(null);
    setChatDraft("");
    setStep("chat");
  }, []);

  const handleRetryPayment = useCallback(() => {
    if (!gamePaymentUrl) {
      setGameRecordError("Ссылка на оплату не найдена");
      return;
    }
    setRetryingPayment(true);
    window.location.href = gamePaymentUrl;
  }, [gamePaymentUrl]);

  if (step === "place") {
    return (
      <div className="app-container game-container">
        <div className="page-header">
          <button className="page-back" onClick={() => setStep("create")} type="button">
            ← Назад
          </button>
          <div className="page-title">Выберите место</div>
        </div>

        <div className="game-search">
          <input
            className="game-input"
            placeholder="Найти станцию"
            value={studiosQuery}
            onChange={(e) => setStudiosQuery(e.target.value)}
          />
        </div>

        <div className="game-stack">
          <button
            className="game-card"
            onClick={() => setMapOpen((prev) => !prev)}
            type="button"
          >
            <div className="game-card-row">
              <div>
                <div className="game-card-title">Найти на карте</div>
                <div className="game-card-sub">Клубы рядом с вами</div>
              </div>
              <span className="game-card-arrow">›</span>
            </div>
          </button>
          {mapOpen && (
            <div className="game-map">
              <div ref={mapHostRef} className="game-map-canvas"></div>
              <button
                className="game-map-locate"
                onClick={requestUserLocation}
                type="button"
                disabled={locatingUser}
              >
                {locatingUser ? "Ищем вас..." : "Мое местоположение"}
              </button>
              {mapLoading && <div className="game-map-overlay">Загружаем карту...</div>}
              {!mapLoading && mapError && <div className="game-map-overlay">{mapError}</div>}
              {!mapLoading && !mapError && mapStudios.length === 0 && !userLocation && (
                <div className="game-map-overlay">Координаты станций не найдены</div>
              )}
              {geocodeLoading && !mapError && (
                <div className="game-map-hint">Уточняем координаты...</div>
              )}
              {userLocationError && !mapError && (
                <div className="game-map-hint game-map-hint-error">{userLocationError}</div>
              )}
            </div>
          )}
        </div>

        <div className="game-section">
          <div className="game-section-title">
            {studiosQuery.trim() ? "Результаты поиска" : "Станции по городам"}
          </div>
          {loadingStudios && <div className="game-empty">Загрузка...</div>}
          {!loadingStudios && studiosError && <div className="game-empty">{studiosError}</div>}
          {!loadingStudios && !studiosError && studiosByCity.length === 0 && (
            <div className="game-empty">Ничего не найдено</div>
          )}
          {!loadingStudios &&
            !studiosError &&
            studiosByCity.map(([city, cityStudios]) => (
              <div key={city} className="game-city-group">
                <div className="game-city-title">{city}</div>
                <div className="game-city-cards">
                  {cityStudios.map((s) => (
                    <button
                      key={s.id}
                      className={`game-card ${studio?.id === s.id ? "selected" : ""}`}
                      onClick={() => {
                        setStudio(s);
                        setStep("create");
                      }}
                      type="button"
                    >
                      <div className="game-card-title">{s.name}</div>
                      {s.address && <div className="game-card-sub">{s.address}</div>}
                      <div className="game-card-sub">
                        {typeof s.panoramicCourtsCount === "number"
                          ? formatCourtsLabel(s.panoramicCourtsCount)
                          : "Панорамик: —"}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
        </div>
      </div>
    );
  }

  if (step === "time") {
    return (
      <div className="app-container game-container">
        <div className="page-header">
          <button className="page-back" onClick={() => setStep("create")} type="button">
            ← Назад
          </button>
          <div className="page-title">Дата и время</div>
        </div>

        <div className="game-section">
          <div className="game-section-title">Продолжительность</div>
          <div className="duration-row">
            {[60, 90, 120].map((d) => (
              <button
                key={d}
                className={`duration-chip ${duration === d ? "active" : ""}`}
                onClick={() => setDuration(d)}
                type="button"
              >
                {d} мин
              </button>
            ))}
          </div>
        </div>

        <div className="game-section">
          <div className="game-section-title">Дата и время начала игры</div>
          <div className="date-row" ref={timeDateRowRef}>
            {dates.map((d, i) => {
              const monthLabel = d
                .toLocaleDateString("ru-RU", { month: "short" })
                .replace(".", "")
                .trim()
                .slice(0, 3)
                .toUpperCase();
              const weekdayLabel = d
                .toLocaleDateString("ru-RU", { weekday: "short" })
                .replace(".", "")
                .toUpperCase();
              const dayLabel = d.toLocaleDateString("ru-RU", { day: "2-digit" });

              return (
                <div key={d.toISOString()} className="date-item">
                  <div className="date-weekday">{weekdayLabel}</div>
                  <button
                    className={`date-chip ${dateIndex === i ? "active" : ""}`}
                    data-date-index={i}
                    onClick={() => {
                      setDateIndex(i);
                      setTime(null);
                    }}
                    type="button"
                  >
                    <div className="booking-date-badge">
                      <div className="booking-date-badge-month">{monthLabel}</div>
                      <div className="booking-date-badge-day">{dayLabel}</div>
                    </div>
                  </button>
                </div>
              );
            })}
          </div>
          <div className="time-grid">
            {loadingTimeslots && <div className="game-empty">Загрузка времени...</div>}
            {!loadingTimeslots && timeslotsError && (
              <div className="game-empty">{timeslotsError}</div>
            )}
            {noPanoramicSlots && (
              <div className="game-empty">На выбранную дату нет свободных панорамик-слотов</div>
            )}
            {noDurationSlots && (
              <div className="game-empty">Для выбранной продолжительности нет свободных слотов</div>
            )}
            {noTimeSlotsForSelection && (
              <div className="game-empty">Нет доступного времени для выбранного корта</div>
            )}
            {!loadingTimeslots &&
              availableTimeSlots.map((slot) => (
                <button
                  key={slot}
                  className={`time-chip ${time === slot ? "active" : ""}`}
                  onClick={() => setTime(slot)}
                  type="button"
                >
                  {slot}
                </button>
              ))}
          </div>
        </div>

        <div className="game-section">
          <div className="game-section-title">Корты</div>
          <div className="game-stack">
            {loadingTimeslots && <div className="game-empty">Загрузка кортов...</div>}
            {!loadingTimeslots && timeslotsError && (
              <div className="game-empty">{timeslotsError}</div>
            )}
            {noPanoramicSlots && (
              <div className="game-empty">Панорамик-корты недоступны на выбранную дату</div>
            )}
            {noDurationSlots && (
              <div className="game-empty">Для выбранной продолжительности корты недоступны</div>
            )}
            {noCourtsForSelection && (
              <div className="game-empty">Нет доступных кортов для выбранного времени</div>
            )}
            {!loadingTimeslots &&
              availableCourts.map((court) => (
                <button
                  key={court.id}
                  className={`game-card ${courtId === court.id ? "selected" : ""}`}
                  onClick={() => {
                    setCourtId(court.id);
                  }}
                  type="button"
                >
                  <div className="game-card-title">{court.name}</div>
                </button>
              ))}
          </div>
        </div>

        <button
          className={`game-submit game-submit-booking ${canProceedToPayment ? "active" : ""}`}
          onClick={handleMasterServicePay}
          type="button"
          disabled={!canProceedToPayment || loadingPay}
        >
          <span className="game-submit-main">{paymentTitle}</span>
          <span className="game-submit-meta">{paymentStationCourt}</span>
          <span className="game-submit-meta">{paymentTimeRange}</span>
        </button>
        {payError && <div className="game-empty game-pay-error">{payError}</div>}
      </div>
    );
  }

  if (step === "chat") {
    const chatTitle = detailsRoomName || "Чат игры";
    const chatSubtitle = [
      detailsStudioName || null,
      detailsDateKey || null,
      detailsTimeFrom && detailsTimeTo ? `${detailsTimeFrom} - ${detailsTimeTo}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const canSendChatMessage = Boolean(
      chatDraft.trim() && !chatSending && profilePhone && canCurrentUserSendChat,
    );
    const chatPlaceholder = !profilePhone
      ? "Нет телефона профиля"
      : canCurrentUserSendChat
        ? "Введите сообщение"
        : "В чат могут писать только участники игры";

    return (
      <div className="app-container game-container game-chat-container">
        <div className="page-header">
          <button
            className="page-back"
            onClick={() => setStep(gameRecordId ? "details" : "create")}
            type="button"
          >
            ← Назад
          </button>
          <div className="page-title">Чат игры</div>
        </div>

        <div className="game-section game-chat-meta">
          <div className="game-card-title">{chatTitle}</div>
          <div className="game-card-sub">{chatSubtitle || "Матч"}</div>
        </div>

        <div className="game-section game-chat-section">
          {chatLoading && <div className="game-empty">Загрузка чата...</div>}
          {!chatLoading && chatMessages.length === 0 && (
            <div className="game-empty">Сообщений пока нет. Напишите первым.</div>
          )}
          {!chatLoading && (
            <div className="game-chat-list">
              {chatMessages.map((message) => {
                const senderPhone = (message.sender?.phoneNorm || "").replace(/\D/g, "");
                const myPhone = (profilePhone || "").replace(/\D/g, "");
                const isMine = senderPhone && myPhone && senderPhone === myPhone;
                const senderName = message.sender?.name || (isMine ? "Вы" : "Игрок");
                return (
                  <div
                    key={`${message.createdTs}-${senderPhone}-${message.text}`}
                    className={`game-chat-message ${isMine ? "mine" : ""}`}
                  >
                    <div className="game-chat-author">{senderName}</div>
                    <div className="game-chat-text">{message.text}</div>
                    <div className="game-chat-time">
                      {formatChatTime(message.createdAt, message.createdTs)}
                    </div>
                  </div>
                );
              })}
              <div ref={chatBottomRef} />
            </div>
          )}
          {chatError && <div className="game-empty game-pay-error">{chatError}</div>}
          {chatRefreshing && !chatLoading && (
            <div className="game-chat-refresh">Обновляем сообщения...</div>
          )}
        </div>

        <div className="game-chat-input-row">
          <input
            className="game-input game-chat-input"
            placeholder={chatPlaceholder}
            value={chatDraft}
            onChange={(event) => setChatDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleSendChatMessage();
              }
            }}
            disabled={!profilePhone || !canCurrentUserSendChat || chatSending}
          />
          <button
            className="section-cta game-chat-send"
            type="button"
            onClick={() => {
              void handleSendChatMessage();
            }}
            disabled={!canSendChatMessage}
          >
            {chatSending ? "..." : "Отпр."}
          </button>
        </div>
        {!canCurrentUserSendChat && profilePhone && (
          <div className="game-chat-note">Чтобы писать в чат, нужно вступить в игру.</div>
        )}
      </div>
    );
  }

  if (step === "details") {
    const paymentStatusLabel = isGamePaid === true ? "Оплата подтверждена" : "Нет оплаты";
    const paymentStatusClass = isGamePaid === true ? "paid" : "unpaid";
    const paymentStatusIcon = isGamePaid === true ? "✓" : "!";

    return (
      <div className="app-container game-container">
        <div className="page-header">
          <button className="page-back" onClick={onBack} type="button">
            ← Назад
          </button>
          <div className="page-title">Детали матча</div>
        </div>

        <div className="game-section">
          <div className="game-section-title">Корт забронирован</div>
          {(restoringPaidGame || checkingGameStatus) && (
            <div className="game-empty">Проверяем статус игры...</div>
          )}
          {gameRecordError && <div className="game-empty game-pay-error">{gameRecordError}</div>}
          <div className="details-card">
            <div className="details-row">
              <div>
                <div className="details-date details-date-capitalize">{detailsDateLabel}</div>
                <div className="details-time">
                  {detailsTimeFrom && detailsTimeTo
                    ? `${detailsTimeFrom} • ${detailsTimeTo}`
                    : "Время не указано"}
                  {detailsDurationMinutes ? ` • ${detailsDurationMinutes} мин` : ""}
                </div>
                <div className="details-time details-time-strong">{detailsRoomName}</div>
                <div className="details-time">{detailsStudioName}</div>
                <div className="details-time">
                  {detailsAmount != null && detailsAmount > 0
                    ? `${formatPrice(detailsAmount)} ₽`
                    : "Цена уточняется"}
                </div>
              </div>
              <div className="details-date-badge">
                <span className="details-date-month">{detailsBadgeMonth}</span>
                <span className="details-date-day">{detailsBadgeDay}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="game-section">
          <div className={`match-payment-status ${paymentStatusClass}`}>
            <div className="match-payment-status-main">{paymentStatusLabel}</div>
            <div className="match-payment-status-icon">{paymentStatusIcon}</div>
          </div>

          {isGamePaid !== true && (
            <button
              className="section-cta"
              onClick={handleRetryPayment}
              type="button"
              disabled={retryingPayment || !gamePaymentUrl}
            >
              {retryingPayment ? "Открываем оплату..." : "Оплатить"}
            </button>
          )}

          {isGamePaid === true && (
            <button
              className="section-cta"
              onClick={handleCopyInvite}
              type="button"
              disabled={!inviteLink}
            >
              {inviteCopied ? "Ссылка скопирована" : "Пригласить в игру"}
            </button>
          )}

          {gameRecordId && (
            <button
              className="section-cta section-cta-secondary"
              onClick={() => {
                setChatMessages([]);
                setChatError(null);
                setStep("chat");
              }}
              type="button"
            >
              Чат игры
            </button>
          )}

          {inviteLink && <div className="invite-status">{inviteLink}</div>}
          {gameRecordId && (
            <div className="game-empty">
              Игра #{gameRecordId}
              {gameRecordStatus ? ` · ${gameRecordStatus}` : ""}
            </div>
          )}
        </div>

        <button className="game-submit active" onClick={onBack} type="button">
          Отлично
        </button>
      </div>
    );
  }

  return (
    <div className="app-container game-container">
      <div className="page-header">
        <button className="page-back" onClick={onBack} type="button">
          Закрыть
        </button>
        <div className="page-title">Создание игры</div>
      </div>

      <div className="game-section game-created-section">
        <div className="game-section-title">Мои игры</div>
        {loadingCreatedGames && <div className="game-empty">Загружаем созданные игры...</div>}
        {!loadingCreatedGames && createdGamesError && (
          <div className="game-empty">{createdGamesError}</div>
        )}
        {!loadingCreatedGames && !createdGamesError && gamesForFeed.length === 0 && (
          <div className="game-empty">У вас пока нет созданных игр</div>
        )}
        <div className="game-created-list">
          {gamesForFeed.map((game) => {
            const dateTitle = formatGameCardDate(game.booking?.date ?? null);
            const badge = getDateBadge(game.booking?.date ?? null);
            const timeFrom = game.booking?.timeFrom ?? "—:—";
            const timeTo = game.booking?.timeTo ?? "—:—";
            const ratingTag = game.settings?.ratingGame ? "Рейтинговый" : "Без рейтинга";
            const durationTag = game.booking?.durationMinutes
              ? `${game.booking.durationMinutes} мин`
              : null;
            const ratingRangeTag =
              game.settings?.minRating && game.settings?.maxRating
                ? `${game.settings.minRating}/${game.settings.maxRating}`
                : null;
            const organizerPlayer: PadelGamePlayer | null = game.organizer
              ? {
                  id: game.organizer.id ?? null,
                  name: game.organizer.name || "Организатор",
                  phone: game.organizer.phone ?? null,
                  photo: game.organizer.photo ?? null,
                  rating: game.organizer.rating ?? null,
                  source: "ORGANIZER",
                  status: "CONFIRMED",
                }
              : null;
            const participants = game.participants && game.participants.length > 0
              ? game.participants
              : (organizerPlayer ? [organizerPlayer] : []);
            const playerSlots = Array.from({ length: MAX_GAME_PLAYERS }, (_, index) => (
              participants[index] ?? null
            ));

            return (
              <div
                key={game.id}
                className="game-created-card"
                onClick={() => handleOpenGameFromFeed(game)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    handleOpenGameFromFeed(game);
                  }
                }}
              >
                <div className="game-created-head">
                  <div className="game-created-date">{dateTitle}</div>
                  <div className="booking-date-badge game-created-date-badge">
                    <div className="booking-date-badge-month">{badge.month}</div>
                    <div className="booking-date-badge-day">{badge.day}</div>
                  </div>
                </div>
                <div className="game-created-time">{`${timeFrom} • ${timeTo}`}</div>
                <div className="game-created-tags">
                  <span className="game-created-tag">{ratingTag}</span>
                  {durationTag && <span className="game-created-tag">{durationTag}</span>}
                  {ratingRangeTag && <span className="game-created-tag">{ratingRangeTag}</span>}
                </div>
                <div className="game-created-players">
                  {playerSlots.map((player, index) => {
                    const initials = getPlayerInitials(player?.name);
                    const isConfirmed = player?.status === "CONFIRMED" || !player?.status;
                    return (
                      <div key={`${game.id}-slot-${index}`} className="game-created-player">
                        <span className="game-created-player-mark">
                          {isConfirmed ? "●" : "◷"}
                        </span>
                        {player?.photo ? (
                          <img src={player.photo} alt={player.name} className="game-created-player-avatar" />
                        ) : (
                          <div className="game-created-player-avatar game-created-player-fallback">
                            {initials}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="game-created-actions">
                  <button
                    className="game-created-action game-created-action-secondary"
                    type="button"
                    disabled={!game.inviteUrl}
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleCopyInviteFromFeed(game);
                    }}
                  >
                    {copiedGameInviteId === game.id ? "Скопировано" : "Пригласить в игру"}
                  </button>
                  <button
                    className="game-created-action"
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleOpenGameChat(game);
                    }}
                  >
                    Чат
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="game-stack">
        <button className="game-card game-card-place-step game-card-step1" onClick={() => setStep("place")} type="button">
          <span className="game-card-step-corner">Шаг 1</span>
          <div className="game-card-row">
            <div>
              <div className="game-card-title">
                {studio ? studio.name : "Выберите станцию"}
              </div>
              {studio && <div className="game-card-sub">{studio.address}</div>}
            </div>
            <span className="game-card-arrow">›</span>
          </div>
        </button>

        <button
          className={`game-card game-card-place-step ${studio ? "" : "disabled"}`}
          onClick={() => {
            if (!studio) return;
            setStep("time");
          }}
          type="button"
          disabled={!studio}
        >
          <span className="game-card-step-corner">Шаг 2</span>
          <div className="game-card-row">
            <div>
              <div className="game-card-title">
                {time && selectedDate ? `Забронировано на ${dateLabel}` : "Выбери корт и время"}
              </div>
              {time && selectedCourt && (
                <div className="game-card-sub">{`${time}, ${duration} мин · ${selectedCourt.name}`}</div>
              )}
            </div>
            <span className="game-card-arrow">›</span>
          </div>
        </button>

        <div className="game-toggle-row">
          <div>
            <div className="game-toggle-title">Игра на рейтинг</div>
            <div className="game-toggle-sub">{ratingSubLabel}</div>
          </div>
          <button
            className={`switch ${ratingGame ? "on" : ""}`}
            onClick={() => setRatingGame((v) => !v)}
            type="button"
            aria-label="toggle rating"
          >
            <span />
          </button>
        </div>

        <div className="rating-card">
          <div className="game-card-title">Допустимый рейтинг соперников</div>
          <div className="rating-range">{ratingRangeLabel}</div>
          <div className="rating-slider">
            <div
              className="rating-rail"
              style={
                {
                  "--min": `${minPercent}%`,
                  "--max": `${maxPercent}%`,
                } as CSSProperties
              }
            />
            <input
              className="rating-range rating-range-min"
              type="range"
              min={0}
              max={RATING_LABELS.length - 1}
              value={minRating}
              onChange={(e) =>
                setMinRating(Math.min(Number(e.target.value), maxRating))
              }
            />
            <input
              className="rating-range rating-range-max"
              type="range"
              min={0}
              max={RATING_LABELS.length - 1}
              value={maxRating}
              onChange={(e) =>
                setMaxRating(Math.max(Number(e.target.value), minRating))
              }
            />
            <div className="rating-labels">
              {RATING_LABELS.map((label, idx) => (
                <span
                  key={label}
                  className={idx >= minRating && idx <= maxRating ? "active" : ""}
                >
                  {label}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="team-card">
          <div className="game-card-title">Команда</div>
          <div className="team-row">
            <div className="team-member">
              <div className="team-avatar-wrapper">
                <svg className="team-avatar-ring" viewBox="0 0 60 60">
                  <circle
                    cx="30"
                    cy="30"
                    r="27"
                    fill="none"
                    stroke="#e5e7eb"
                    strokeWidth="4"
                  />
                  {Array.from({ length: ringSegments }, (_, idx) => {
                    const i = idx + 1;
                    const t = i / ringSegments;
                    const power = Math.pow(t, 3);
                    const segmentLength = 127 / ringSegments;
                    const start = idx * segmentLength;
                    const r = Math.round(180 + power * (53 - 180));
                    const g = Math.round(150 + power * (63 - 150));
                    const b = Math.round(255 + power * (185 - 255));
                    const isActive = idx < filledSegments;
                    return (
                      <circle
                        key={i}
                        cx="30"
                        cy="30"
                        r="27"
                        fill="none"
                        stroke={isActive ? `rgb(${r},${g},${b})` : "transparent"}
                        strokeWidth={isActive ? 0.3 + power * 10 : 0}
                        strokeDasharray={`${segmentLength} 169`}
                        strokeDashoffset={-start}
                        strokeLinecap="butt"
                        transform="rotate(90 30 30)"
                      />
                    );
                  })}
                </svg>
                {profilePhoto && !avatarError ? (
                  <img
                    src={profilePhoto}
                    alt="Аватар"
                    className="team-avatar-img"
                    onError={() => setAvatarError(true)}
                  />
                ) : (
                  <div className="team-avatar-fallback">
                    {initials || "Вы"}
                  </div>
                )}
                <div className="team-avatar-badge">{profileGrade}</div>
              </div>
              <div className="team-name">{profileName}</div>
              <span className="team-badge">Вы</span>
            </div>
            {[1, 2, 3].map((i) => (
              <div key={i} className="team-member empty">
                <div className="team-avatar">+</div>
                <div className="team-name">Слот</div>
              </div>
            ))}
          </div>
        </div>

        <div className="game-toggle-row">
          <div>
            <div className="game-toggle-title">Приватная</div>
            <div className="game-toggle-sub">
              Присоединиться смогут только те, у кого есть ссылка
            </div>
          </div>
          <button
            className={`switch ${isPrivate ? "on" : ""}`}
            onClick={() => setIsPrivate((v) => !v)}
            type="button"
            aria-label="toggle private"
          >
            <span />
          </button>
        </div>
      </div>

      <button
        className={`game-submit ${canCreate ? "active" : ""}`}
        onClick={handleCreateGame}
        type="button"
        disabled={!canCreate}
      >
        Продолжить
      </button>
    </div>
  );
}
