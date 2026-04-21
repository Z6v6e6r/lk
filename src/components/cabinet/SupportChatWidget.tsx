import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { Modal } from "../UI/Modal";
import {
  apiCreateSupportDialogEvent,
  apiFetchOnboardingStations,
  apiFetchSupportDialogMessages,
  apiFetchSupportDialogs,
} from "../../utils/apiClient";
import type {
  Studio,
  SupportDialog,
  SupportDialogMessage,
  UserProfileType,
} from "../../utils/apiClient";
import { trackAnalyticsEvent } from "../../utils/analytics";
import { SUPPORT_WEB_CONNECTOR } from "../../consts/api_config";

const SUPPORT_CHANNEL = "WEB";
const SUPPORT_CONNECTOR = SUPPORT_WEB_CONNECTOR;
const SUPPORT_MESSAGES_LIMIT = 15;
const SUPPORT_POLL_INTERVAL_MS = 12000;

type SupportStationOption = {
  id: string;
  name: string;
  city: string | null;
  address: string | null;
  hasDialog: boolean;
};

interface SupportChatWidgetProps {
  profile: UserProfileType;
  connector?: string;
  requireStationSelection?: boolean;
  title?: string;
  introText?: string;
}

function getProfileDisplayName(profile: UserProfileType): string {
  const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim();
  if (fullName) return fullName;
  return `Клиент ${profile.phone}`;
}

function resolveSelectedStationId(
  currentStationId: string | null,
  dialogs: SupportDialog[],
  stations: Studio[],
): string | null {
  if (currentStationId) {
    const existsInDialogs = dialogs.some((dialog) => dialog.stationId === currentStationId);
    const existsInStations = stations.some((station) => station.id === currentStationId);
    if (existsInDialogs || existsInStations) {
      return currentStationId;
    }
  }

  return dialogs.find((dialog) => dialog.stationId && dialog.stationId !== "UNASSIGNED")?.stationId ?? null;
}

function pickDialogByStation(dialogs: SupportDialog[], stationId: string | null): SupportDialog | null {
  if (!stationId) return null;
  return dialogs.find((dialog) => dialog.stationId === stationId) ?? null;
}

function resolveActiveDialog(dialogs: SupportDialog[], stationId: string | null): SupportDialog | null {
  if (stationId) {
    return pickDialogByStation(dialogs, stationId);
  }

  return dialogs[0] ?? null;
}

function upsertDialog(dialogs: SupportDialog[], nextDialog: SupportDialog): SupportDialog[] {
  const withoutCurrent = dialogs.filter((dialog) => dialog.id !== nextDialog.id);
  return [nextDialog, ...withoutCurrent].sort((left, right) => (right.updatedTs ?? 0) - (left.updatedTs ?? 0));
}

function upsertMessage(messages: SupportDialogMessage[], nextMessage: SupportDialogMessage): SupportDialogMessage[] {
  const withoutCurrent = messages.filter((message) => message.id !== nextMessage.id);
  return [...withoutCurrent, nextMessage]
    .sort((left, right) => left.createdTs - right.createdTs)
    .slice(-SUPPORT_MESSAGES_LIMIT);
}

function mergeMessages(messages: SupportDialogMessage[]): SupportDialogMessage[] {
  const uniq = new Map<string, SupportDialogMessage>();
  messages.forEach((message) => {
    uniq.set(message.id, message);
  });
  return Array.from(uniq.values())
    .sort((left, right) => left.createdTs - right.createdTs)
    .slice(-SUPPORT_MESSAGES_LIMIT);
}

function resolveMessageTarget(message: SupportDialogMessage, stationNameById: Map<string, string>): string {
  if (message.stationName) return message.stationName;
  if (message.stationId) {
    return stationNameById.get(message.stationId) ?? "Станция";
  }
  return "Станция";
}

function formatMessageTime(createdAt: string | null, createdTs: number): string {
  const source = createdAt || (createdTs > 0 ? new Date(createdTs).toISOString() : null);
  if (!source) return "";

  const parsed = new Date(source);
  if (!Number.isFinite(parsed.getTime())) return "";

  return parsed.toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isAdminMessage(message: SupportDialogMessage): boolean {
  return message.authorType === "ADMIN" || message.direction === "OUTBOUND";
}

function isServiceMessage(message: SupportDialogMessage): boolean {
  const type = (message.eventType || "").toUpperCase();
  return type !== "MESSAGE" && type !== "ADMIN_REPLY" && type !== "TEXT";
}

function isMatchingClientEcho(
  message: SupportDialogMessage | null | undefined,
  expectedText: string,
  expectedStationId: string | null,
): message is SupportDialogMessage {
  if (!message) return false;
  if (isAdminMessage(message) || isServiceMessage(message)) return false;
  if ((message.text || "").trim() !== expectedText) return false;
  return (message.stationId || "") === (expectedStationId || "");
}

export function SupportChatWidget({
  profile,
  connector = SUPPORT_CONNECTOR,
  requireStationSelection = true,
  title = "Чат с администратором",
  introText = "Выберите станцию и напишите администратору. Сообщения сохраняются по вашему номеру телефона и доступны в админке.",
}: SupportChatWidgetProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [floatingBottomOffset, setFloatingBottomOffset] = useState(20);
  const [supportUnavailable, setSupportUnavailable] = useState(false);
  const [stations, setStations] = useState<Studio[]>([]);
  const [dialogs, setDialogs] = useState<SupportDialog[]>([]);
  const [messages, setMessages] = useState<SupportDialogMessage[]>([]);
  const [selectedStationId, setSelectedStationId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [isLoadingStations, setIsLoadingStations] = useState(false);
  const [isLoadingDialogs, setIsLoadingDialogs] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const lastSubmitRef = useRef<{ stationId: string; text: string; at: number } | null>(null);
  const dialogsRef = useRef<SupportDialog[]>([]);

  const displayName = useMemo(() => getProfileDisplayName(profile), [profile]);
  const isYandexBrowser = useMemo(() => {
    if (typeof window === "undefined") return false;
    return /YaBrowser/i.test(window.navigator.userAgent);
  }, []);
  const floatingStackStyle = useMemo(
    () =>
      ({
        "--support-chat-bottom-offset": `${floatingBottomOffset}px`,
      }) as CSSProperties,
    [floatingBottomOffset],
  );

  const stationOptions = useMemo<SupportStationOption[]>(() => {
    const map = new Map<string, SupportStationOption>();

    stations.forEach((station) => {
      map.set(station.id, {
        id: station.id,
        name: station.name,
        city: station.city ?? null,
        address: station.address ?? null,
        hasDialog: false,
      });
    });

    dialogs.forEach((dialog) => {
      if (!dialog.stationId || dialog.stationId === "UNASSIGNED") return;
      const current = map.get(dialog.stationId);
      if (current) {
        map.set(dialog.stationId, { ...current, hasDialog: true });
        return;
      }
      map.set(dialog.stationId, {
        id: dialog.stationId,
        name: dialog.stationName || "Станция",
        city: null,
        address: null,
        hasDialog: true,
      });
    });

    return Array.from(map.values()).sort((left, right) => {
      if (left.hasDialog !== right.hasDialog) {
        return Number(right.hasDialog) - Number(left.hasDialog);
      }
      return left.name.localeCompare(right.name, "ru");
    });
  }, [dialogs, stations]);

  const stationNameById = useMemo(
    () => new Map(stationOptions.map((station) => [station.id, station.name])),
    [stationOptions],
  );

  const selectedDialog = useMemo(
    () => pickDialogByStation(dialogs, selectedStationId),
    [dialogs, selectedStationId],
  );

  const activeDialog = useMemo(
    () => resolveActiveDialog(dialogs, selectedStationId),
    [dialogs, selectedStationId],
  );

  const loadStations = useCallback(async (quiet = false) => {
    if (!quiet) setIsLoadingStations(true);

    const result = await apiFetchOnboardingStations();
    if (result.data && result.data.length > 0) {
      setStations(result.data);
      setLoadError(null);
    } else if (!quiet) {
      setLoadError(result.error?.message || "Не удалось загрузить станции для чата.");
    }

    if (!quiet) setIsLoadingStations(false);
    return result.data ?? [];
  }, []);

  const loadDialogs = useCallback(async (quiet = false) => {
    if (!quiet) setIsLoadingDialogs(true);

    const result = await apiFetchSupportDialogs({
      phone: profile.phone,
      channel: SUPPORT_CHANNEL,
      includeClosed: true,
    });

    if (result.data) {
      const nextDialogs = result.data.dialogs;
      const hasCurrentDialogs = dialogsRef.current.length > 0;
      const shouldKeepCurrent = quiet && nextDialogs.length === 0 && hasCurrentDialogs;
      if (!shouldKeepCurrent) {
        setDialogs(nextDialogs);
      }
      setLoadError(null);
      setSupportUnavailable(false);
      if (!quiet) setIsLoadingDialogs(false);
      return shouldKeepCurrent ? dialogsRef.current : nextDialogs;
    }

    if (result.error?.status === 404) {
      setSupportUnavailable(true);
    }

    if (!quiet) {
      setLoadError(
        result.error?.status === 404
          ? "Чат поддержки ещё не развернут на этом сервере. Нужен деплой маршрутов /lk/support или /api/support."
          : (result.error?.message || "Не удалось загрузить переписку."),
      );
      setIsLoadingDialogs(false);
    }
    return [] as SupportDialog[];
  }, [profile.phone]);

  useEffect(() => {
    dialogsRef.current = dialogs;
  }, [dialogs]);

  const loadMessages = useCallback(async (dialogToLoad: SupportDialog | null, quiet = false) => {
    if (!quiet) setIsLoadingMessages(true);

    if (!dialogToLoad) {
      setMessages([]);
      setLoadError(null);
      if (!quiet) setIsLoadingMessages(false);
      return [] as SupportDialogMessage[];
    }

    const result = await apiFetchSupportDialogMessages({
      dialogId: dialogToLoad.id,
      limit: SUPPORT_MESSAGES_LIMIT,
    });

    if (result.data) {
      const nextMessages = mergeMessages(result.data.messages);
      setMessages(nextMessages);
      setLoadError(null);
      if (!quiet) setIsLoadingMessages(false);
      return nextMessages;
    }

    if (!quiet) {
      setLoadError(result.error?.message || "Не удалось загрузить сообщения.");
      setIsLoadingMessages(false);
    }

    return [] as SupportDialogMessage[];
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    trackAnalyticsEvent("support_chat_opened", {
      channel: SUPPORT_CHANNEL,
      clientId: profile.id,
    });

    let cancelled = false;
    const bootstrap = async () => {
      void loadStations();
      await loadDialogs();
      if (cancelled) return;
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [isOpen, loadDialogs, loadMessages, loadStations, profile.id]);

  useEffect(() => {
    if (!isOpen) return;
    setSelectedStationId((current) => resolveSelectedStationId(current, dialogs, stations));
  }, [dialogs, isOpen, stations]);

  useEffect(() => {
    if (!isOpen) return;

    void loadMessages(activeDialog);
  }, [activeDialog, isOpen, loadMessages, selectedStationId]);

  useEffect(() => {
    if (!isOpen) return;
    if (supportUnavailable) return;

    let cancelled = false;
    const poll = async () => {
      const nextDialogs = await loadDialogs(true);
      if (cancelled) return;

      const nextStationId = resolveSelectedStationId(selectedStationId, nextDialogs, stations);
      const nextDialog = resolveActiveDialog(nextDialogs, nextStationId);
      await loadMessages(nextDialog, true);
    };

    const timerId = window.setInterval(() => {
      if (document.hidden) return;
      void poll();
    }, SUPPORT_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timerId);
    };
  }, [isOpen, loadDialogs, loadMessages, selectedStationId, stations, supportUnavailable]);

  useEffect(() => {
    if (!isOpen) return;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [isOpen, messages.length]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const baseOffset = isYandexBrowser ? 88 : 20;
    const visualViewport = window.visualViewport;

    const updateFloatingOffset = () => {
      if (!visualViewport) {
        setFloatingBottomOffset(baseOffset);
        return;
      }

      const viewportInset = Math.max(
        0,
        window.innerHeight - (visualViewport.height + visualViewport.offsetTop),
      );

      setFloatingBottomOffset(baseOffset + viewportInset);
    };

    updateFloatingOffset();

    visualViewport?.addEventListener("resize", updateFloatingOffset);
    visualViewport?.addEventListener("scroll", updateFloatingOffset);
    window.addEventListener("resize", updateFloatingOffset);
    window.addEventListener("orientationchange", updateFloatingOffset);

    return () => {
      visualViewport?.removeEventListener("resize", updateFloatingOffset);
      visualViewport?.removeEventListener("scroll", updateFloatingOffset);
      window.removeEventListener("resize", updateFloatingOffset);
      window.removeEventListener("orientationchange", updateFloatingOffset);
    };
  }, [isYandexBrowser]);

  const handleSelectStation = (stationId: string) => {
    setSelectedStationId(stationId);
    setLoadError(null);
    setSendError(null);

      trackAnalyticsEvent("support_chat_station_selected", {
        clientId: profile.id,
        stationId,
        channel: SUPPORT_CHANNEL,
        connector,
      });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const text = draft.trim();
    if (!text) return;

    if (supportUnavailable) {
      setSendError("Чат пока недоступен: support backend не опубликован на сервере.");
      return;
    }

    if (requireStationSelection && !selectedStationId) {
      setSendError("Выберите станцию, чтобы начать диалог.");
      return;
    }

    const stationName = selectedStationId
      ? stationNameById.get(selectedStationId) ?? selectedDialog?.stationName ?? "Станция"
      : null;
    const now = Date.now();
    const previousSubmit = lastSubmitRef.current;
    if (
      previousSubmit
      && previousSubmit.stationId === (selectedStationId ?? "__academy__")
      && previousSubmit.text === text
      && now - previousSubmit.at < 1800
    ) {
      return;
    }
    lastSubmitRef.current = {
      stationId: selectedStationId ?? "__academy__",
      text,
      at: now,
    };

    setIsSending(true);
    setSendError(null);

    const result = await apiCreateSupportDialogEvent({
      connector,
      channel: SUPPORT_CHANNEL,
      direction: "INBOUND",
      authorType: "CLIENT",
      eventType: "MESSAGE",
      text,
      phone: profile.phone,
      primaryPhone: profile.phone,
      displayName,
      clientName: displayName,
      senderName: displayName,
      userId: profile.id,
      clientId: profile.id,
      senderId: profile.id,
      channelUserId: profile.id,
      chatId: `lk:${profile.id}`,
      externalThreadId: `lk:${profile.id}:${selectedStationId ?? "academy"}`,
      stationId: selectedStationId,
      stationName,
      authStatus: "AUTHORIZED",
      workflowState: "READY",
      metadata: {
        source: "lk_support_widget",
        surface: "cabinet",
      },
    });

    if (result.error || !result.data) {
      setSendError(result.error?.message || "Не удалось отправить сообщение.");
      setIsSending(false);
      return;
    }

    let nextDialogsForReload = dialogsRef.current;

    if (result.data.dialog) {
      setDialogs((current) => upsertDialog(current, result.data.dialog as SupportDialog));
      nextDialogsForReload = upsertDialog(nextDialogsForReload, result.data.dialog as SupportDialog);
    } else {
      nextDialogsForReload = await loadDialogs(true);
    }

    const echoedMessage = result.data.message;
    const dialogForReload =
      (result.data.dialog as SupportDialog | null)
      ?? resolveActiveDialog(nextDialogsForReload, selectedStationId);

    if (isMatchingClientEcho(echoedMessage, text, selectedStationId)) {
      setMessages((current) => upsertMessage(current, echoedMessage));
    } else {
      await loadMessages(dialogForReload, true);
    }

    setDraft("");
    setIsSending(false);

      trackAnalyticsEvent("support_chat_message_sent", {
      clientId: profile.id,
      stationId: selectedStationId,
      channel: SUPPORT_CHANNEL,
      connector,
      dialogId: result.data.dialog?.id ?? null,
    });
  };

  return (
    <>
      <div className="support-chat-fab-stack" style={floatingStackStyle}>
        <button
          type="button"
          className="support-chat-fab"
          aria-label="Открыть чат с администратором"
          title={title}
          onClick={() => {
            setSupportUnavailable(false);
            setLoadError(null);
            setSendError(null);
            setSelectedStationId(null);
            setMessages([]);
            setIsOpen(true);
          }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M7 17.5H6.2C4.985 17.5 4 16.515 4 15.3V6.7C4 5.485 4.985 4.5 6.2 4.5H14.8C16.015 4.5 17 5.485 17 6.7V7.5"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M10 9.5H17.8C19.015 9.5 20 10.485 20 11.7V16.8C20 18.015 19.015 19 17.8 19H13.9L10.5 21.5V19H10C8.785 19 7.8 18.015 7.8 16.8V11.7C7.8 10.485 8.785 9.5 10 9.5Z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <a
          className="support-chat-max-link"
          href="https://max.ru/id7722810381_bot"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Открыть MAX-бота поддержки"
          title="MAX-бот поддержки"
        >
          <img
            className="support-chat-max-logo"
            src="https://max.ru/favicon.ico"
            alt="MAX"
          />
        </a>
      </div>

      <Modal isOpen={isOpen} onClose={() => setIsOpen(false)} title={title}>
        <div className="support-chat-modal">
          <div className="support-chat-intro">{introText}</div>

          {(requireStationSelection || stationOptions.length > 0 || isLoadingStations) && (
            <div className="support-chat-stations">
              {stationOptions.length > 0 ? (
                stationOptions.map((station) => (
                  <button
                    key={station.id}
                    type="button"
                    className={`support-chat-station-btn${selectedStationId === station.id ? " active" : ""}`}
                    onClick={() => handleSelectStation(station.id)}
                  >
                    <span>{station.name}</span>
                    {station.hasDialog && <span className="support-chat-station-mark">история</span>}
                  </button>
                ))
              ) : (
                <div className="support-chat-inline-note">
                  {isLoadingStations
                    ? "Загружаем станции..."
                    : requireStationSelection
                      ? "Станции для чата пока недоступны."
                      : "Можно написать без выбора станции."}
                </div>
              )}
            </div>
          )}

          {loadError && (
            <div className="support-chat-error" role="alert">
              {loadError}
            </div>
          )}

          <div className="support-chat-thread">
            {(isLoadingDialogs || isLoadingMessages) && messages.length === 0 ? (
              <div className="support-chat-empty">Загружаем переписку...</div>
            ) : messages.length === 0 ? (
              <div className="support-chat-empty">История пока пустая. Напишите сообщение администратору.</div>
            ) : (
              messages.map((message) => {
                if (isServiceMessage(message)) {
                  return (
                    <div key={message.id} className="support-chat-service-message">
                      {message.text}
                    </div>
                  );
                }

                const adminMessage = isAdminMessage(message);

                return (
                  <div
                    key={message.id}
                    className={`support-chat-message-row${adminMessage ? " admin" : " mine"}`}
                  >
                    <div
                      className={`support-chat-message-bubble${adminMessage ? " admin" : " mine"}`}
                    >
                      <div className="support-chat-message-author">
                        {adminMessage ? (message.sender?.name || "Администратор") : "Вы"}
                      </div>
                      {!adminMessage && (
                        <div className="support-chat-message-target">
                          Отправлено в: {resolveMessageTarget(message, stationNameById)}
                        </div>
                      )}
                      <div className="support-chat-message-text">{message.text}</div>
                      <div className="support-chat-message-time">
                        {formatMessageTime(message.createdAt, message.createdTs)}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          <form className="support-chat-composer" onSubmit={handleSubmit}>
            {sendError && (
              <div className="support-chat-error" role="alert">
                {sendError}
              </div>
            )}
            <div className="support-chat-composer-main">
              <textarea
                className="support-chat-textarea"
                placeholder={
                  supportUnavailable
                    ? "Чат временно недоступен на этом стенде"
                    : selectedStationId || !requireStationSelection
                    ? "Напишите сообщение администратору..."
                    : "Сначала выберите станцию"
                }
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  if (sendError) setSendError(null);
                }}
                rows={2}
                disabled={supportUnavailable || (requireStationSelection && !selectedStationId) || isSending}
              />
              <button
                type="submit"
                className="support-chat-send-btn"
                disabled={
                  supportUnavailable
                  || (requireStationSelection && !selectedStationId)
                  || !draft.trim()
                  || isSending
                }
              >
                {isSending ? "Отправка..." : "Отправить"}
              </button>
            </div>
          </form>
        </div>
      </Modal>
    </>
  );
}
