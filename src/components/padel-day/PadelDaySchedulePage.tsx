import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthForm } from "../auth/AuthForm";
import { useAuth } from "../../context/AuthContext";
import {
  apiAcquirePadelDayGuard,
  apiConfirmPadelDayGuard,
  apiFetchPadelDayBookings,
  apiFetchPadelDaySlots,
  apiJoinPadelDayWaitlist,
  apiReleasePadelDayGuard,
  createPadelDayIdempotencyKey,
  extractPadelDayTransactionId,
  PADEL_DAY_TARGET_DATE,
} from "../../utils/padelDayApi";
import {
  getVisiblePadelDaySlots,
  hasSelectableSlot,
  type PadelDaySlot,
} from "../../utils/padelDayScheduleModel";
import {
  apiCreateTournamentVivaTransaction,
  apiFetchTournamentVivaCheckout,
  type TournamentVivaCheckout,
  type TournamentVivaProduct,
} from "../../utils/tournamentSignupApi";
import "./PadelDaySchedulePage.css";

type Props = {
  onBack?: () => void;
};

function formatEventDate(date: string) {
  const parsed = new Date(`${date}T12:00:00`);
  return parsed.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
  });
}

type StationDetails = {
  phone: string;
  pageUrl: string;
};

const DEFAULT_STATION_DETAILS: StationDetails = {
  phone: "+7 (499) 110-77-35",
  pageUrl: "https://padlhub.ru/padelday",
};

const PADEL_DAY_DOCUMENTS_URL = "https://padlhub.ru/docs";
const PADEL_DAY_SUBSCRIPTION_URL = "https://padlhub.ru/ab_leto";

const STATION_DETAILS_BY_NAME: Record<string, StationDetails> = {
  "терехово": {
    phone: "+7 (499) 110-77-35",
    pageUrl: "https://padlhub.ru/terekhovo",
  },
};

function getStationDetails(studioName: string) {
  return STATION_DETAILS_BY_NAME[studioName.trim().toLocaleLowerCase("ru-RU")]
    || DEFAULT_STATION_DETAILS;
}

function buildRouteUrl(address: string) {
  return `https://yandex.ru/maps/?rtext=~${encodeURIComponent(address)}&rtt=auto`;
}

function formatPlaces(value: number) {
  const lastTwo = value % 100;
  const last = value % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return "мест";
  if (last === 1) return "место";
  if (last >= 2 && last <= 4) return "места";
  return "мест";
}

function formatPrice(product: TournamentVivaProduct) {
  if (product.cost == null) return "Выбрать";
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(product.cost / 100)} ₽`;
}

function pickProduct(products: TournamentVivaProduct[]) {
  return products.find((product) => product.type === "SERVICE") || products[0] || null;
}

export default function PadelDaySchedulePage({ onBack }: Props) {
  const { isAuthenticated, isLoading: authLoading, isRestoringSession } = useAuth();
  const [slots, setSlots] = useState<PadelDaySlot[]>([]);
  const [selectedStudioId, setSelectedStudioId] = useState<string | null>(null);
  const [selectedTimeKeys, setSelectedTimeKeys] = useState<string[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<PadelDaySlot | null>(null);
  const [selectedStation, setSelectedStation] = useState<Pick<PadelDaySlot, "studioName" | "studioAddress"> | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(true);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [purchaseLoading, setPurchaseLoading] = useState(false);
  const [product, setProduct] = useState<TournamentVivaProduct | null>(null);
  const [profile, setProfile] = useState<TournamentVivaCheckout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [waitlistOpen, setWaitlistOpen] = useState(false);
  const [waitlistLoading, setWaitlistLoading] = useState(false);
  const [waitlistError, setWaitlistError] = useState<string | null>(null);
  const [waitlistForm, setWaitlistForm] = useState({
    firstName: "",
    lastName: "",
    phone: "",
    personalDataConsent: false,
    offerConsent: false,
  });
  const requestVersion = useRef(0);

  const loadSchedule = useCallback(async () => {
    const version = ++requestVersion.current;
    setScheduleLoading(true);
    setError(null);

    const bookingsResult = isAuthenticated ? await apiFetchPadelDayBookings() : null;
    if (version !== requestVersion.current) return;
    if (bookingsResult?.error) {
      setError(bookingsResult.error.message || "Не удалось проверить ваши записи");
    }
    const scheduleResult = await apiFetchPadelDaySlots(
      PADEL_DAY_TARGET_DATE,
      bookingsResult?.data?.content || [],
    );
    if (version !== requestVersion.current) return;
    setScheduleLoading(false);
    if (scheduleResult.error) {
      setSlots([]);
      setError(scheduleResult.error.message || "Не удалось загрузить расписание");
      return;
    }
    setSlots(scheduleResult.data || []);
  }, [isAuthenticated]);

  useEffect(() => {
    if (authLoading || isRestoringSession) return;
    void loadSchedule();
  }, [authLoading, isRestoringSession, loadSchedule]);

  useEffect(() => {
    setProduct(null);
    setProfile(null);
    setError(null);
    setNotice(null);
    if (!selectedSlot || !isAuthenticated) return;

    let cancelled = false;
    setCheckoutLoading(true);
    void apiFetchTournamentVivaCheckout(selectedSlot.id, { tournament: selectedSlot.raw })
      .then((result) => {
        if (cancelled) return;
        setCheckoutLoading(false);
        if (result.error || !result.data) {
          setError(result.error?.message || "Не удалось получить вариант оплаты");
          return;
        }
        const selectedProduct = pickProduct(result.data.oneTimes);
        if (!selectedProduct) {
          setError("Для этой записи не настроена разовая услуга «День падела»");
          return;
        }
        setProfile(result.data);
        setProduct(selectedProduct);
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, selectedSlot]);

  const studios = useMemo(() => {
    const values = new Map<string, string>();
    slots.forEach((slot) => values.set(slot.studioId, slot.studioName));
    return [...values.entries()].sort((a, b) => a[1].localeCompare(b[1], "ru"));
  }, [slots]);

  const times = useMemo(() => [...new Set(slots.map((slot) => slot.timeKey))].sort(), [slots]);
  const visibleSlots = useMemo(() => getVisiblePadelDaySlots(slots, {
    studioId: selectedStudioId,
    timeKeys: selectedTimeKeys,
  }), [selectedStudioId, selectedTimeKeys, slots]);
  const ownSlot = slots.find((slot) => slot.isMine) || null;

  const chooseStudio = (studioId: string | null) => {
    const next = selectedStudioId === studioId ? null : studioId;
    setSelectedStudioId(next);
    if (next) setSelectedTimeKeys((current) => current.filter((timeKey) => hasSelectableSlot(slots, next, timeKey)));
  };

  const chooseTime = (timeKey: string) => {
    setSelectedTimeKeys((current) => (
      current.includes(timeKey)
        ? current.filter((value) => value !== timeKey)
        : [...current, timeKey].sort()
    ));
  };

  const submitWaitlist = async () => {
    if (waitlistLoading) return;
    if (!waitlistForm.firstName.trim() || !waitlistForm.lastName.trim() || !waitlistForm.phone.trim()) {
      setWaitlistError("Укажите имя, фамилию и телефон");
      return;
    }
    if (!waitlistForm.personalDataConsent || !waitlistForm.offerConsent) {
      setWaitlistError("Подтвердите согласие на обработку данных и оферту");
      return;
    }

    setWaitlistLoading(true);
    setWaitlistError(null);
    const result = await apiJoinPadelDayWaitlist(waitlistForm);
    setWaitlistLoading(false);
    if (result.error || !result.data?.ok) {
      setWaitlistError(result.error?.message || "Не удалось добавить в лист ожидания. Попробуйте ещё раз.");
      return;
    }
    setWaitlistOpen(false);
    setWaitlistForm({ firstName: "", lastName: "", phone: "", personalDataConsent: false, offerConsent: false });
    setNotice("Вы добавлены в лист ожидания. Мы свяжемся с вами перед следующим праздником.");
  };

  const startPurchase = async () => {
    if (!selectedSlot || !product || !profile?.profile || purchaseLoading) return;
    if (ownSlot && ownSlot.id !== selectedSlot.id) {
      setError(`У вас уже есть запись: ${ownSlot.timeLabel}, ${ownSlot.studioName}`);
      return;
    }

    setPurchaseLoading(true);
    setError(null);
    setNotice(null);
    const idempotencyKey = createPadelDayIdempotencyKey(selectedSlot.id);
    const guardResult = await apiAcquirePadelDayGuard({
      exerciseId: selectedSlot.id,
      eventDate: PADEL_DAY_TARGET_DATE,
      idempotencyKey,
    });
    if (guardResult.error || !guardResult.data?.guardId) {
      setPurchaseLoading(false);
      setError(guardResult.error?.message || "Не удалось подтвердить доступность записи");
      await loadSchedule();
      return;
    }

    const guardId = guardResult.data.guardId;
    const transactionResult = await apiCreateTournamentVivaTransaction({
      exerciseId: selectedSlot.id,
      studioId: profile.studioId,
      clientPhone: profile.profile.phone,
      clientId: profile.profile.id,
      profile: profile.profile,
      product,
      exercise: profile.exercise,
      tournament: selectedSlot.raw,
    });

    if (transactionResult.error || !transactionResult.data) {
      const transactionId = extractPadelDayTransactionId(transactionResult.error?.raw);
      if (transactionId || (transactionResult.status != null && transactionResult.status < 400)) {
        await apiConfirmPadelDayGuard(guardId, { idempotencyKey, transactionId });
      } else if (transactionResult.status != null && transactionResult.status >= 400 && transactionResult.status < 500) {
        await apiReleasePadelDayGuard(guardId, idempotencyKey);
      }
      setPurchaseLoading(false);
      setError(transactionResult.error?.message || "Не удалось создать оплату");
      return;
    }

    const transactionId = extractPadelDayTransactionId(transactionResult.data.raw);
    await apiConfirmPadelDayGuard(guardId, {
      idempotencyKey,
      transactionId,
      bookingId: transactionResult.data.bookingId,
      paymentUrl: transactionResult.data.paymentUrl,
    });
    setPurchaseLoading(false);

    if (transactionResult.data.paymentUrl) {
      window.location.assign(transactionResult.data.paymentUrl);
      return;
    }

    setNotice("Запись подтверждена");
    setSelectedSlot(null);
    await loadSchedule();
  };

  if (authLoading || isRestoringSession) {
    return <div className="padel-day-state">Проверяем авторизацию…</div>;
  }

  return (
    <main className="padel-day-page">
      <header className="padel-day-header">
        {onBack ? <button className="padel-day-back" type="button" onClick={onBack}>←</button> : null}
        <div>
          <h1>ДЕНЬ ПАДЕЛА от ПадлхАБ <span className="padel-day-event-date">{formatEventDate(PADEL_DAY_TARGET_DATE)}</span></h1>
          <ul className="padel-day-benefits">
            <li>Продолжительность пробной тренировки 45 мин</li>
            <li>Записаться можно только 1 раз</li>
            <li>Ракетки и мячи предоставляются клубом</li>
          </ul>
        </div>
      </header>

      {ownSlot ? (
        <section className="padel-day-own" aria-live="polite">
          <strong>Ваша запись: {ownSlot.timeLabel}</strong>
          <span>{ownSlot.studioName}</span>
          {ownSlot.paymentUrl ? (
            <a href={ownSlot.paymentUrl}>Продолжить оплату</a>
          ) : null}
        </section>
      ) : null}

      <section className="padel-day-filters" aria-label="Фильтры расписания">
        <div>
          <h2>Станция</h2>
          <div className="padel-day-chips">
            {studios.map(([studioId, studioName]) => {
              const enabled = selectedTimeKeys.length === 0
                || selectedTimeKeys.some((timeKey) => hasSelectableSlot(slots, studioId, timeKey));
              return (
                <button
                  key={studioId}
                  type="button"
                  className={selectedStudioId === studioId ? "is-active" : ""}
                  disabled={!enabled}
                  onClick={() => chooseStudio(studioId)}
                  aria-pressed={selectedStudioId === studioId}
                >
                  {studioName}{selectedStudioId === studioId ? <span className="padel-day-chip-remove" aria-hidden="true">×</span> : null}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <div className="padel-day-filter-heading"><h2>Время</h2></div>
          <div className="padel-day-chips padel-day-chips--time">
            {times.map((timeKey) => {
              const enabled = hasSelectableSlot(slots, selectedStudioId, timeKey);
              return (
                <button
                  key={timeKey}
                  type="button"
                  className={selectedTimeKeys.includes(timeKey) ? "is-active" : ""}
                  disabled={!enabled}
                  onClick={() => chooseTime(timeKey)}
                  aria-pressed={selectedTimeKeys.includes(timeKey)}
                >
                  {timeKey}{selectedTimeKeys.includes(timeKey) ? <span className="padel-day-chip-remove" aria-hidden="true">×</span> : null}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {error ? <div className="padel-day-message padel-day-message--error" role="alert">{error}</div> : null}
      {notice ? <div className="padel-day-message" role="status">{notice}</div> : null}

      {scheduleLoading ? (
        <div className="padel-day-state">Загружаем расписание…</div>
      ) : slots.length === 0 ? (
        <div className="padel-day-state">
          Расписание Padel Day на эту дату ещё не опубликовано.
        </div>
      ) : visibleSlots.length === 0 ? (
        <div className="padel-day-state">По выбранным фильтрам свободных мест нет.</div>
      ) : (
        <section className="padel-day-list" aria-label="Доступные записи">
          {visibleSlots.map((slot) => (
            <article key={slot.id} className={`padel-day-card${slot.isMine ? " is-mine" : ""}`}>
              <div className="padel-day-card-time">
                {slot.timeLabel.split("–").map((time, index) => <span key={`${slot.id}-${time}`}>{index > 0 ? time : time}</span>)}
              </div>
              <div className="padel-day-card-main">
                <h3>{slot.studioName}</h3>
                {slot.studioAddress ? (
                  <button
                    className="padel-day-station-link"
                    type="button"
                    onClick={() => setSelectedStation({ studioName: slot.studioName, studioAddress: slot.studioAddress })}
                  >
                    {slot.studioAddress}
                  </button>
                ) : <p>Адрес уточняется</p>}
              </div>
              <div className="padel-day-card-actions">
                <span>{slot.isMine ? "Вы записаны" : `${slot.spotsLeft} ${formatPlaces(slot.spotsLeft)}`}</span>
                <button
                  type="button"
                  disabled={slot.isMine || Boolean(ownSlot && ownSlot.id !== slot.id)}
                  onClick={() => setSelectedSlot(slot)}
                >
                  {slot.isMine ? "Записаны" : ownSlot ? "Недоступно" : "Записаться"}
                </button>
              </div>
            </article>
          ))}
        </section>
      )}

      <section className="padel-day-waitlist-callout" aria-labelledby="padel-day-waitlist-title">
        <div>
          <h2 id="padel-day-waitlist-title">Не нашли подходящее время?</h2>
          <p>Добавьтесь в лист ожидания — мы свяжемся с вами перед следующим праздником.</p>
        </div>
        <button type="button" onClick={() => { setWaitlistError(null); setWaitlistOpen(true); }}>В лист ожидания</button>
      </section>

      <section className="padel-day-subscription-promo" aria-labelledby="padel-day-subscription-title">
        <div>
          <h2 id="padel-day-subscription-title">Уже играешь в падел?</h2>
          <p>Тогда подписки ПадлхАБ созданы для тебя.</p>
        </div>
        <a className="padel-day-subscription-promo-button" href={PADEL_DAY_SUBSCRIPTION_URL}>Забрать подписку</a>
      </section>

      {selectedSlot ? (
        <div className="padel-day-modal-backdrop" role="presentation" onMouseDown={() => !purchaseLoading && setSelectedSlot(null)}>
          <section className="padel-day-modal" role="dialog" aria-modal="true" aria-label="Запись на Padel Day" onMouseDown={(event) => event.stopPropagation()}>
            <button className="padel-day-modal-close" type="button" onClick={() => setSelectedSlot(null)} aria-label="Закрыть">×</button>
            <p className="padel-day-eyebrow">Запись на День Падела {formatEventDate(PADEL_DAY_TARGET_DATE)}</p>
            <h2>{selectedSlot.timeLabel}</h2>
            <p>{selectedSlot.studioName}</p>

            {!isAuthenticated ? (
              <div className="padel-day-auth">
                <p>Войдите, чтобы проверить ограничение и продолжить запись.</p>
                <AuthForm onLogin={() => undefined} />
              </div>
            ) : checkoutLoading ? (
              <div className="padel-day-state">Проверяем услугу…</div>
            ) : product ? (
              <button className="padel-day-purchase" type="button" disabled={purchaseLoading} onClick={() => void startPurchase()}>
                {purchaseLoading ? "Проверяем запись…" : `Оплатить ${formatPrice(product)}`}
              </button>
            ) : null}
          </section>
        </div>
      ) : null}

      {selectedStation?.studioAddress ? (
        <div className="padel-day-modal-backdrop" role="presentation" onMouseDown={() => setSelectedStation(null)}>
          <section className="padel-day-modal padel-day-station-modal" role="dialog" aria-modal="true" aria-label={`Контакты станции ${selectedStation.studioName}`} onMouseDown={(event) => event.stopPropagation()}>
            <button className="padel-day-modal-close" type="button" onClick={() => setSelectedStation(null)} aria-label="Закрыть">×</button>
            <p className="padel-day-eyebrow">Станция ПадлхАБ</p>
            <h2>{selectedStation.studioName}</h2>
            <p className="padel-day-station-address">{selectedStation.studioAddress}</p>
            <div className="padel-day-station-actions">
              <a href={`tel:${getStationDetails(selectedStation.studioName).phone.replace(/\D/g, "")}`}>{getStationDetails(selectedStation.studioName).phone}</a>
              <a href={getStationDetails(selectedStation.studioName).pageUrl} target="_blank" rel="noreferrer">Страница станции</a>
              <a className="padel-day-purchase" href={buildRouteUrl(selectedStation.studioAddress)} target="_blank" rel="noreferrer">Построить маршрут</a>
            </div>
          </section>
        </div>
      ) : null}

      {waitlistOpen ? (
        <div className="padel-day-modal-backdrop" role="presentation" onMouseDown={() => !waitlistLoading && setWaitlistOpen(false)}>
          <section className="padel-day-modal padel-day-waitlist-modal" role="dialog" aria-modal="true" aria-labelledby="padel-day-waitlist-modal-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="padel-day-modal-close" type="button" onClick={() => setWaitlistOpen(false)} aria-label="Закрыть" disabled={waitlistLoading}>×</button>
            <h2 id="padel-day-waitlist-modal-title">Лист ожидания</h2>
            <p>Оставьте контакты, и мы сообщим о следующем Дне Падела.</p>
            <form className="padel-day-waitlist-form" onSubmit={(event) => { event.preventDefault(); void submitWaitlist(); }}>
              <label>Имя<input value={waitlistForm.firstName} onChange={(event) => setWaitlistForm((current) => ({ ...current, firstName: event.target.value }))} autoComplete="given-name" required /></label>
              <label>Фамилия<input value={waitlistForm.lastName} onChange={(event) => setWaitlistForm((current) => ({ ...current, lastName: event.target.value }))} autoComplete="family-name" required /></label>
              <label>Телефон<input type="tel" inputMode="tel" value={waitlistForm.phone} onChange={(event) => setWaitlistForm((current) => ({ ...current, phone: event.target.value }))} autoComplete="tel" required /></label>
              <label className="padel-day-consent"><input type="checkbox" checked={waitlistForm.personalDataConsent} onChange={(event) => setWaitlistForm((current) => ({ ...current, personalDataConsent: event.target.checked }))} />Согласен на обработку персональных данных</label>
              <label className="padel-day-consent"><input type="checkbox" checked={waitlistForm.offerConsent} onChange={(event) => setWaitlistForm((current) => ({ ...current, offerConsent: event.target.checked }))} />Принимаю условия <a href={PADEL_DAY_DOCUMENTS_URL} target="_blank" rel="noreferrer">оферты</a></label>
              {waitlistError ? <p className="padel-day-waitlist-error" role="alert">{waitlistError}</p> : null}
              <button className="padel-day-purchase" type="submit" disabled={waitlistLoading}>{waitlistLoading ? "Сохраняем…" : "В лист ожидания"}</button>
              <a className="padel-day-privacy-link" href={PADEL_DAY_DOCUMENTS_URL} target="_blank" rel="noreferrer">Политика обработки персональных данных</a>
            </form>
          </section>
        </div>
      ) : null}
    </main>
  );
}
