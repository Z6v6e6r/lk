import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../../context/AuthContext";
import type { GameTimeSlot, Studio } from "../../../utils/apiClient";
import {
  apiFetchMasterServiceTimeslots,
  apiFetchOnboardingStations,
} from "../../../utils/apiClient";
import {
  apiConfirmCompositeBooking,
  apiCreateCompositeBooking,
  apiFetchCompositeOptions,
  type CompositeApiCandidate,
  type CompositeBookingRecord,
} from "./compositeApi";
import type { CompositeTargetDuration } from "./compositeSlotBuilder";
import "./CompositeGameCreatePage.css";

type CompositeGameCreatePageProps = {
  onBack?: () => void;
  presetStudioId?: string | null;
  presetStudioName?: string | null;
  cabinetUrl?: string | null;
};

type DateOption = {
  key: string;
  date: Date;
  dayLabel: string;
  monthLabel: string;
  weekdayLabel: string;
};

const TARGET_DURATIONS: CompositeTargetDuration[] = [60, 90, 120];
const DEFAULT_TOTAL_DAYS = 15;

function formatDateLocalIso(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatPrice(value: number | null): string {
  if (value == null) return "Стоимость уточняется";
  return `${value.toLocaleString("ru-RU")} ₽`;
}

function normalizeComparable(value: string | null | undefined): string {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .trim();
}

function buildDateOptions(totalDays = DEFAULT_TOTAL_DAYS): DateOption[] {
  const today = new Date();
  return Array.from({ length: totalDays }).map((_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() + index);
    return {
      key: formatDateLocalIso(date),
      date,
      dayLabel: date.toLocaleDateString("ru-RU", { day: "2-digit" }),
      monthLabel: date.toLocaleDateString("ru-RU", { month: "short" }).replace(".", "").toUpperCase(),
      weekdayLabel: date.toLocaleDateString("ru-RU", { weekday: "short" }).replace(".", ""),
    };
  });
}

function findStudioByPreset(
  studios: Studio[],
  presetStudioId: string | null | undefined,
  presetStudioName: string | null | undefined,
): Studio | null {
  const normalizedId = normalizeComparable(presetStudioId);
  if (normalizedId) {
    const byId = studios.find((studio) => normalizeComparable(studio.id) === normalizedId);
    if (byId) return byId;
  }

  const normalizedName = normalizeComparable(presetStudioName);
  if (!normalizedName) return null;

  return studios.find((studio) => {
    const comparableName = normalizeComparable(studio.name);
    const comparableAddress = normalizeComparable(studio.address);
    return comparableName === normalizedName
      || comparableName.includes(normalizedName)
      || comparableAddress.includes(normalizedName);
  }) ?? null;
}

function getStationMeta(studio: Studio): string {
  return [studio.city, studio.address].filter(Boolean).join(" · ") || "Станция";
}

export default function CompositeGameCreatePage({
  onBack,
  presetStudioId = null,
  presetStudioName = null,
}: CompositeGameCreatePageProps) {
  const { phone } = useAuth();
  const [studios, setStudios] = useState<Studio[]>([]);
  const [loadingStudios, setLoadingStudios] = useState(false);
  const [studiosError, setStudiosError] = useState<string | null>(null);
  const [studioQuery, setStudioQuery] = useState("");
  const [selectedStudioId, setSelectedStudioId] = useState<string | null>(null);
  const [selectedDateKey, setSelectedDateKey] = useState(buildDateOptions(1)[0]?.key ?? "");
  const [selectedDuration, setSelectedDuration] = useState<CompositeTargetDuration>(60);
  const [rawTimeslots, setRawTimeslots] = useState<GameTimeSlot[]>([]);
  const [loadingTimeslots, setLoadingTimeslots] = useState(false);
  const [timeslotsError, setTimeslotsError] = useState<string | null>(null);
  const [allCandidates, setAllCandidates] = useState<CompositeApiCandidate[]>([]);
  const [loadingCompositeOptions, setLoadingCompositeOptions] = useState(false);
  const [compositeOptionsError, setCompositeOptionsError] = useState<string | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [submittingSelection, setSubmittingSelection] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submittedRecord, setSubmittedRecord] = useState<CompositeBookingRecord | null>(null);
  const [submittedMessage, setSubmittedMessage] = useState<string | null>(null);

  const dateOptions = useMemo(() => buildDateOptions(), []);

  const filteredStudios = useMemo(() => {
    const normalizedQuery = normalizeComparable(studioQuery);
    if (!normalizedQuery) return studios;
    return studios.filter((studio) => {
      const haystack = [
        studio.name,
        studio.city,
        studio.address,
      ].map((value) => normalizeComparable(value)).join(" ");
      return haystack.includes(normalizedQuery);
    });
  }, [studioQuery, studios]);

  const selectedStudio = useMemo(
    () => studios.find((studio) => studio.id === selectedStudioId) ?? null,
    [selectedStudioId, studios],
  );

  const filteredCandidates = useMemo(
    () => allCandidates.filter((candidate) => candidate.targetDurationMinutes === selectedDuration),
    [allCandidates, selectedDuration],
  );

  const selectedCandidate = useMemo(
    () => filteredCandidates.find((candidate) => candidate.id === selectedCandidateId) ?? null,
    [filteredCandidates, selectedCandidateId],
  );

  useEffect(() => {
    let alive = true;
    setLoadingStudios(true);
    setStudiosError(null);

    apiFetchOnboardingStations()
      .then((result) => {
        if (!alive) return;
        setStudios(Array.isArray(result.data) ? result.data : []);
        if (result.error) {
          setStudiosError(result.error.message || "Не удалось загрузить станции");
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
  }, []);

  useEffect(() => {
    if (selectedStudioId) return;
    if (studios.length === 0) return;

    const matchedStudio = findStudioByPreset(studios, presetStudioId, presetStudioName);
    if (matchedStudio) {
      setSelectedStudioId(matchedStudio.id);
      return;
    }

    if (presetStudioName) {
      setStudioQuery((previous) => previous || presetStudioName);
    }
  }, [presetStudioId, presetStudioName, selectedStudioId, studios]);

  useEffect(() => {
    if (!selectedStudio || !selectedDateKey) {
      setRawTimeslots([]);
      setTimeslotsError(null);
      setLoadingTimeslots(false);
      return;
    }

    let alive = true;
    setLoadingTimeslots(true);
    setTimeslotsError(null);
    setRawTimeslots([]);
    setAllCandidates([]);
    setCompositeOptionsError(null);
    setSelectedCandidateId(null);

    apiFetchMasterServiceTimeslots(selectedDateKey, {
      studioId: selectedStudio.id,
      masterServiceId: selectedStudio.masterServiceId ?? null,
      preferredSubServiceId: selectedStudio.preferredSubServiceId ?? null,
      preferredSubServiceIds: selectedStudio.subServiceIds ?? [],
    })
      .then((result) => {
        if (!alive) return;
        setRawTimeslots(Array.isArray(result.data) ? result.data : []);
        if (result.error) {
          setTimeslotsError(result.error.message || "Не удалось загрузить слоты");
        }
      })
      .catch(() => {
        if (!alive) return;
        setRawTimeslots([]);
        setTimeslotsError("Не удалось загрузить слоты");
      })
      .finally(() => {
        if (alive) setLoadingTimeslots(false);
      });

    return () => {
      alive = false;
    };
  }, [selectedDateKey, selectedStudio]);

  useEffect(() => {
    if (!selectedStudio || !selectedDateKey) {
      setAllCandidates([]);
      setLoadingCompositeOptions(false);
      setCompositeOptionsError(null);
      return;
    }
    if (loadingTimeslots) {
      setAllCandidates([]);
      setLoadingCompositeOptions(false);
      setCompositeOptionsError(null);
      return;
    }
    if (timeslotsError) {
      setAllCandidates([]);
      setLoadingCompositeOptions(false);
      setCompositeOptionsError(null);
      return;
    }
    if (rawTimeslots.length === 0) {
      setAllCandidates([]);
      setLoadingCompositeOptions(false);
      setCompositeOptionsError(null);
      return;
    }

    let alive = true;
    setLoadingCompositeOptions(true);
    setCompositeOptionsError(null);

    apiFetchCompositeOptions({
      stationId: selectedStudio.id,
      studioId: selectedStudio.id,
      date: selectedDateKey,
      slots: rawTimeslots,
    })
      .then((result) => {
        if (!alive) return;
        setAllCandidates(Array.isArray(result.data) ? result.data : []);
        if (result.error) {
          setCompositeOptionsError(result.error.message || "Не удалось построить составные варианты");
        }
      })
      .catch(() => {
        if (!alive) return;
        setAllCandidates([]);
        setCompositeOptionsError("Не удалось построить составные варианты");
      })
      .finally(() => {
        if (alive) setLoadingCompositeOptions(false);
      });

    return () => {
      alive = false;
    };
  }, [loadingTimeslots, rawTimeslots, selectedDateKey, selectedStudio, timeslotsError]);

  useEffect(() => {
    if (filteredCandidates.length === 0) {
      setSelectedCandidateId(null);
      return;
    }

    if (selectedCandidateId && filteredCandidates.some((candidate) => candidate.id === selectedCandidateId)) {
      return;
    }

    setSelectedCandidateId(filteredCandidates[0].id);
  }, [filteredCandidates, selectedCandidateId]);

  useEffect(() => {
    setSubmitError(null);
    setSubmittedRecord(null);
    setSubmittedMessage(null);
  }, [selectedCandidateId, selectedDateKey, selectedDuration, selectedStudioId]);

  async function handleCompositeSubmit() {
    if (!selectedStudio || !selectedCandidate) return;

    setSubmittingSelection(true);
    setSubmitError(null);
    setSubmittedRecord(null);
    setSubmittedMessage("Создаём isolated draft...");

    const createResult = await apiCreateCompositeBooking({
      stationId: selectedStudio.id,
      studioId: selectedStudio.id,
      date: selectedDateKey,
      clientPhone: phone || null,
      clientName: null,
      segments: selectedCandidate.segments,
    });

    if (createResult.error || !createResult.data?.id) {
      setSubmitError(createResult.error?.message || "Не удалось создать составную запись");
      setSubmittedMessage(null);
      setSubmittingSelection(false);
      return;
    }

    setSubmittedRecord(createResult.data);
    setSubmittedMessage("Draft создан, подтверждаем isolated state...");

    const confirmResult = await apiConfirmCompositeBooking(createResult.data.id);
    if (confirmResult.error) {
      setSubmitError(`Draft создан, но confirm не выполнен: ${confirmResult.error.message}`);
      setSubmittedMessage("Черновик создан, confirm не завершён");
      setSubmittingSelection(false);
      return;
    }

    if (confirmResult.data) {
      setSubmittedRecord(confirmResult.data);
    }
    setSubmittedMessage("Composite scenario сохранён в isolated namespace");
    setSubmittingSelection(false);
  }

  return (
    <div className="composite-create">
      <div className="composite-create__shell">
        <div className="composite-create__header">
          <button type="button" className="composite-create__back" onClick={onBack}>
            ← Назад
          </button>
          <div className="composite-create__eyebrow">Composite Slot Flow</div>
          <h1 className="composite-create__title">Составная запись на корт</h1>
          <p className="composite-create__lead">
            Новый isolated flow не затрагивает текущий `GamesPage`: он загружает raw timeslots,
            строит допустимые составные цепочки через отдельный backend namespace и сохраняет тестовый сценарий отдельно.
          </p>
        </div>

        <div className="composite-create__grid">
          <div className="composite-create__panel">
            <section className="composite-create__section">
              <h2 className="composite-create__section-title">1. Станция</h2>
              <p className="composite-create__section-subtitle">
                Выберите станцию. Preset из URL поддерживается, но не влияет на старый `/game_create`.
              </p>
              <input
                className="composite-create__search"
                type="search"
                value={studioQuery}
                onChange={(event) => setStudioQuery(event.target.value)}
                placeholder="Поиск по станции или адресу"
              />
              {loadingStudios && (
                <div className="composite-create__status is-loading">Загружаем станции...</div>
              )}
              {!loadingStudios && studiosError && (
                <div className="composite-create__status is-error">{studiosError}</div>
              )}
              {!loadingStudios && !studiosError && filteredStudios.length === 0 && (
                <div className="composite-create__placeholder">
                  По текущему фильтру станции не найдены.
                </div>
              )}
              {!loadingStudios && filteredStudios.length > 0 && (
                <div className="composite-create__station-list">
                  {filteredStudios.map((studio) => {
                    const isActive = studio.id === selectedStudioId;
                    return (
                      <button
                        key={studio.id}
                        type="button"
                        className={`composite-create__station-button${isActive ? " is-active" : ""}`}
                        onClick={() => setSelectedStudioId(studio.id)}
                      >
                        <span className="composite-create__station-name">{studio.name}</span>
                        <span className="composite-create__station-meta">{getStationMeta(studio)}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="composite-create__section">
              <h2 className="composite-create__section-title">2. Дата и длительность</h2>
              <p className="composite-create__section-subtitle">
                После выбора даты flow загружает raw `apiFetchMasterServiceTimeslots` и отправляет их в isolated
                `/lk/games/composite/options`, где backend применяет whitelist допустимых паттернов.
              </p>
              <div className="composite-create__date-list">
                {dateOptions.map((option) => {
                  const isActive = option.key === selectedDateKey;
                  return (
                    <button
                      key={option.key}
                      type="button"
                      className={`composite-create__date-button${isActive ? " is-active" : ""}`}
                      onClick={() => setSelectedDateKey(option.key)}
                    >
                      <span className="composite-create__date-day">{option.dayLabel}</span>
                      <span className="composite-create__date-month">{option.monthLabel}</span>
                      <span className="composite-create__helper">{option.weekdayLabel}</span>
                    </button>
                  );
                })}
              </div>
              <div className="composite-create__duration-list">
                {TARGET_DURATIONS.map((duration) => {
                  const isActive = duration === selectedDuration;
                  return (
                    <button
                      key={duration}
                      type="button"
                      className={`composite-create__duration-button${isActive ? " is-active" : ""}`}
                      onClick={() => setSelectedDuration(duration)}
                    >
                      <span className="composite-create__candidate-title">{duration} минут</span>
                      <span className="composite-create__duration-label">Целевая длина</span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="composite-create__section">
              <h2 className="composite-create__section-title">3. Candidate options</h2>
              <p className="composite-create__section-subtitle">
                Поддержаны только additive-паттерны: 60, 30+30, 60+30, 30+60, 60+60. Максимум 2 сегмента и 1 переход.
              </p>
              {selectedStudio == null && (
                <div className="composite-create__placeholder">
                  Сначала выберите станцию, чтобы загрузить слоты.
                </div>
              )}
              {selectedStudio != null && (loadingTimeslots || loadingCompositeOptions) && (
                <div className="composite-create__status is-loading">Загружаем raw timeslots...</div>
              )}
              {selectedStudio != null && !loadingTimeslots && timeslotsError && (
                <div className="composite-create__status is-error">{timeslotsError}</div>
              )}
              {selectedStudio != null && !loadingTimeslots && !timeslotsError && compositeOptionsError && (
                <div className="composite-create__status is-error">{compositeOptionsError}</div>
              )}
              {selectedStudio != null && !loadingTimeslots && !loadingCompositeOptions && !timeslotsError && !compositeOptionsError && filteredCandidates.length === 0 && (
                <div className="composite-create__placeholder">
                  Для выбранной станции и даты не найдено составных вариантов на {selectedDuration} минут.
                </div>
              )}
              {selectedStudio != null && !loadingTimeslots && !loadingCompositeOptions && filteredCandidates.length > 0 && (
                <>
                  <div className="composite-create__helper">
                    Raw slots: {rawTimeslots.length} · Server composite options: {filteredCandidates.length}
                  </div>
                  <div className="composite-create__candidate-list">
                    {filteredCandidates.map((candidate) => {
                      const isActive = candidate.id === selectedCandidateId;
                      return (
                        <button
                          key={candidate.id}
                          type="button"
                          className={`composite-create__candidate${isActive ? " is-active" : ""}`}
                          onClick={() => setSelectedCandidateId(candidate.id)}
                        >
                          <div className="composite-create__candidate-top">
                            <div>
                              <span className="composite-create__candidate-title">
                                {candidate.fromTime} - {candidate.toTime}
                              </span>
                              <span className="composite-create__candidate-meta">
                                {candidate.patternLabel} · {candidate.roomsLabel}
                              </span>
                            </div>
                            <span className="composite-create__candidate-price">{formatPrice(candidate.totalPrice)}</span>
                          </div>
                          <div className="composite-create__candidate-tags">
                            <span className="composite-create__tag">
                              {candidate.segmentCount} {candidate.segmentCount === 1 ? "сегмент" : "сегмента"}
                            </span>
                            <span className="composite-create__tag">
                              {candidate.transitionCount === 0 ? "Без перехода" : "1 переход"}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </section>
          </div>

          <div className="composite-create__panel">
            <section className="composite-create__section">
              <h2 className="composite-create__section-title">Summary</h2>
              <p className="composite-create__section-subtitle">
                Текущий isolated flow создаёт draft через `/lk/games/composite/create`, затем подтверждает его через
                `/lk/games/composite/confirm`. Оплата специально не трогает legacy namespace и пока не реализована.
              </p>
              {!selectedStudio && (
                <div className="composite-create__placeholder">
                  Сводка появится после выбора станции и подходящей цепочки.
                </div>
              )}
              {selectedStudio && selectedCandidate && (
                <div className="composite-create__summary-card">
                  <div className="composite-create__summary-header">
                    <div>
                      <h3 className="composite-create__summary-title">
                        {selectedStudio.name}
                      </h3>
                      <div className="composite-create__summary-meta">
                        {selectedDateKey} · {selectedCandidate.fromTime} - {selectedCandidate.toTime}
                      </div>
                    </div>
                    <div className="composite-create__summary-price">{formatPrice(selectedCandidate.totalPrice)}</div>
                  </div>
                  <div className="composite-create__summary-tags">
                    <span className="composite-create__tag">{selectedCandidate.patternLabel}</span>
                    <span className="composite-create__tag">{selectedCandidate.roomsLabel}</span>
                    <span className="composite-create__tag">
                      {selectedCandidate.transitionCount === 0 ? "Без перехода" : "1 переход"}
                    </span>
                  </div>
                  <div className="composite-create__summary-list">
                    {selectedCandidate.segments.map((segment, index) => (
                      <div key={`${segment.slotId}:${index}`} className="composite-create__summary-item">
                        <span className="composite-create__summary-label">Сегмент {index + 1}</span>
                        <span className="composite-create__candidate-title">
                          {segment.fromTime} - {segment.toTime}
                        </span>
                        <span className="composite-create__summary-meta">
                          {segment.roomName} · {segment.durationMinutes} мин · {formatPrice(segment.price)}
                        </span>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="composite-create__cta"
                    disabled={submittingSelection}
                    onClick={() => void handleCompositeSubmit()}
                  >
                    {submittingSelection ? (submittedMessage || "Сохраняем isolated scenario...") : "Сохранить isolated composite scenario"}
                  </button>
                  {submittedRecord && (
                    <div className="composite-create__status is-success">
                      Composite ID: {submittedRecord.id} · status: {submittedRecord.status} · payment: {submittedRecord.paymentStatus}
                    </div>
                  )}
                  {submitError && (
                    <div className="composite-create__status is-error">{submitError}</div>
                  )}
                  <div className="composite-create__note">
                    Новый flow пишет только в isolated namespace `lk_game_composites` и не затрагивает legacy `/lk/games`.
                  </div>
                </div>
              )}
              {selectedStudio && !selectedCandidate && !loadingTimeslots && !timeslotsError && (
                <div className="composite-create__placeholder">
                  На эту длительность пока нет подходящей цепочки из raw slots.
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
