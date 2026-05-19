import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetchProfile, type UserProfileType } from "../../utils/apiClient";
import {
  CUSTOM_FIELD_IDS,
  getCustomFieldValue,
  getLetterGrade,
  parseNumericLevel,
} from "../../utils/customFields";
import { AvatarProgress } from "./AvatarProgress";

interface LevelsInfoPageProps {
  onBack: () => void;
  profile?: UserProfileType;
}

type LevelBand = {
  grade: string;
  min: number;
  max: number;
  label: string;
  title: string;
};

type DStep = {
  label: string;
  title: string;
  range: string;
};

const LEVEL_BANDS: LevelBand[] = [
  { grade: "A", min: 5.5, max: 7, label: "Рейтинг 5.5+", title: "экспертный" },
  { grade: "B+", min: 4.7, max: 5.5, label: "Рейтинг 4.7–5.5", title: "продвинутый+" },
  { grade: "B", min: 4, max: 4.7, label: "Рейтинг 4.0–4.7", title: "сильный" },
  { grade: "C+", min: 3.5, max: 4, label: "Рейтинг 3.5–4.0", title: "уверенный+" },
  { grade: "C", min: 3, max: 3.5, label: "Рейтинг 3.0–3.5", title: "уверенный" },
  { grade: "D+", min: 2, max: 3, label: "Рейтинг 2.0–3.0", title: "базовый+" },
  { grade: "D", min: 1, max: 2, label: "Рейтинг 1.0–2.0", title: "начальный" },
];

const STEP_TITLES = ["начальный", "развивающийся", "уверенный", "продвинутый"] as const;

const LEVEL_COLORS: Record<string, { from: string; to: string; ring: string }> = {
  A: { from: "#8F63FF", to: "#6E52FF", ring: "#734CFF" },
  "B+": { from: "#A053FF", to: "#8B34FF", ring: "#8E37FF" },
  B: { from: "#B62CFF", to: "#9426F7", ring: "#972AF9" },
  "C+": { from: "#D735FF", to: "#B720FF", ring: "#B723FF" },
  C: { from: "#FF3E7D", to: "#E2266A", ring: "#E22C70" },
  "D+": { from: "#FF5A2A", to: "#FF4A0F", ring: "#FF4F1B" },
  D: { from: "#FF8900", to: "#F77400", ring: "#F77900" },
};

function getInitials(profile: UserProfileType | null): string {
  const first = profile?.firstName?.[0] || "";
  const last = profile?.lastName?.[0] || "";
  return `${first}${last}`.trim() || "?";
}

function formatNumber(value: number | null, fractionDigits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const rounded = Number(value.toFixed(fractionDigits));
  return rounded.toLocaleString("ru-RU", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

function findBandByGrade(grade: string | null): LevelBand | null {
  if (!grade) return null;
  return LEVEL_BANDS.find((band) => band.grade === grade) ?? null;
}

function formatStepRangeValue(value: number): string {
  return value.toFixed(2);
}

function buildStepLabels(grade: string): string[] {
  const normalized = grade.trim().toUpperCase();
  const hasPlus = normalized.endsWith("+");
  const base = hasPlus ? normalized.slice(0, -1) : normalized;

  return Array.from({ length: 4 }, (_, index) => {
    const indexPart = index === 0 ? "" : String(index);
    const plusPart = hasPlus ? "+" : "";
    return `${base}${indexPart}${plusPart}`;
  });
}

function buildStepsForBand(band: LevelBand, grade: string): DStep[] {
  const labels = buildStepLabels(grade);
  const span = (band.max - band.min) / 4;

  return labels.map((label, index) => {
    const start = band.min + span * index;
    const rawEnd = band.min + span * (index + 1);
    const end = index === 3 ? band.max : rawEnd;
    return {
      label,
      title: STEP_TITLES[index],
      range: `${formatStepRangeValue(start)}–${formatStepRangeValue(end)}`,
    };
  });
}

export default function LevelsInfoPage({
  onBack,
  profile: initialProfile,
}: LevelsInfoPageProps) {
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const [profile, setProfile] = useState<UserProfileType | null>(initialProfile ?? null);
  const [loading, setLoading] = useState(!initialProfile);
  const [avatarError, setAvatarError] = useState(false);
  const [showScrollHint, setShowScrollHint] = useState(false);

  useEffect(() => {
    setProfile(initialProfile ?? null);
    if (initialProfile) {
      setLoading(false);
      return;
    }
    setLoading(true);
    apiFetchProfile()
      .then((res) => {
        if (res.data) setProfile(res.data);
      })
      .finally(() => setLoading(false));
  }, [initialProfile]);

  useEffect(() => {
    setAvatarError(false);
  }, [profile?.photo]);

  useEffect(() => {
    if (loading) return;
    const layoutEl = layoutRef.current;
    if (!layoutEl) return;

    const overlayScroller = layoutEl.closest(".lk-overlay");
    const docScroller = document.scrollingElement;
    const scroller = (overlayScroller instanceof HTMLElement
      ? overlayScroller
      : (docScroller instanceof HTMLElement ? docScroller : null));
    if (!scroller) return;

    const useWindowScrollTarget = scroller === document.documentElement || scroller === document.body;
    const scrollTarget: EventTarget = useWindowScrollTarget ? window : scroller;
    let dismissed = false;

    const getScrollTop = (): number => (useWindowScrollTarget ? window.scrollY : scroller.scrollTop);
    const getViewportHeight = (): number => (useWindowScrollTarget ? window.innerHeight : scroller.clientHeight);
    const getScrollableHeight = (): number => scroller.scrollHeight - getViewportHeight();
    const isScrollable = (): boolean => getScrollableHeight() > 72;
    const isNearBottom = (): boolean => getScrollableHeight() - getScrollTop() < 24;
    const isNearTop = (): boolean => getScrollTop() < 8;

    const updateHint = () => {
      if (dismissed || !isScrollable() || isNearBottom()) {
        setShowScrollHint(false);
        return;
      }
      setShowScrollHint(isNearTop());
    };

    const onScroll = () => {
      if (getScrollTop() > 18) {
        dismissed = true;
      }
      updateHint();
    };

    const onResize = () => {
      updateHint();
    };

    const rafId = window.requestAnimationFrame(updateHint);
    const hideTimerId = window.setTimeout(() => {
      dismissed = true;
      setShowScrollHint(false);
    }, 7000);

    scrollTarget.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);

    return () => {
      scrollTarget.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(hideTimerId);
    };
  }, [loading]);

  const levelData = useMemo(() => {
    const rawNumeric = profile
      ? getCustomFieldValue(profile, CUSTOM_FIELD_IDS.lkPadelLevelNumeric)
      : null;
    const numeric = parseNumericLevel(rawNumeric ?? undefined);
    const fallbackLetter = profile
      ? (getCustomFieldValue(profile, CUSTOM_FIELD_IDS.lkPadelLevel) || "").trim().toUpperCase()
      : "";
    const grade = numeric != null ? getLetterGrade(numeric) : (fallbackLetter || null);
    const band = findBandByGrade(grade);

    const progress = (() => {
      if (numeric == null || !band) return 0;
      const span = band.max - band.min;
      if (span <= 0) return 0;
      const value = Math.max(band.min, Math.min(band.max, numeric));
      return Math.max(0, Math.min(1, (value - band.min) / span));
    })();

    return {
      numeric,
      grade,
      band,
      progress,
      progressPercent: progress * 100,
      color: LEVEL_COLORS[grade || ""] ?? LEVEL_COLORS.A,
      numericLabel: numeric != null
        ? numeric.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : "—",
    };
  }, [profile]);

  const stepsData = useMemo(() => {
    const fallbackBand = LEVEL_BANDS[LEVEL_BANDS.length - 1];
    const band = levelData.band ?? fallbackBand;
    const grade = levelData.grade || band.grade;
    const steps = buildStepsForBand(band, grade);
    const currentStepIndex = Math.min(
      steps.length - 1,
      Math.max(0, Math.floor(levelData.progress * steps.length)),
    );
    const currentStep = steps[currentStepIndex] ?? steps[0];

    return {
      grade,
      steps,
      currentStepLabel: currentStep?.label ?? grade,
      currentStepTitle: currentStep?.title ?? STEP_TITLES[0],
    };
  }, [levelData.band, levelData.grade, levelData.progress]);

  if (loading) {
    return <div className="loading">Загрузка...</div>;
  }

  const fullName = [profile?.firstName, profile?.lastName].filter(Boolean).join(" ");
  const hasPhoto = Boolean(profile?.photo) && !avatarError;

  return (
    <div className="levels-layout" ref={layoutRef}>
      <div className="levels-card levels-card--headline">
        <button type="button" className="levels-close-button" aria-label="Закрыть" onClick={onBack}>×</button>
        <h1 className="levels-headline-title">Как устроены уровни игроков</h1>
        <p className="levels-headline-subtitle">Памятка по уровню, подуровням и прогрессу на аватарке</p>
      </div>

      <div className="levels-top-grid">
        <section className="levels-card levels-section-card">
          <h2 className="levels-section-title">1. Основные уровни</h2>
          <div className="levels-ratings-table">
            {LEVEL_BANDS.map((band) => {
              const palette = LEVEL_COLORS[band.grade] ?? LEVEL_COLORS.A;
              const isCurrent = Boolean(levelData.grade) && levelData.grade === band.grade;
              return (
                <div key={band.grade} className={`levels-rating-row${isCurrent ? " is-current" : ""}`}>
                  <span>{band.label}</span>
                  <span
                    className="levels-grade-pill"
                    style={{
                      background: `linear-gradient(132deg, ${palette.from} 0%, ${palette.to} 100%)`,
                    }}
                  >
                    {band.grade}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="levels-card levels-section-card">
          <h2 className="levels-section-title">2. Каждый уровень делится на 4 ступени</h2>
          <p className="levels-section-copy">
            Чтобы прогресс было проще понимать, внутри уровня есть 4 подуровня:{" "}
            {stepsData.steps[0]?.label}, {stepsData.steps[1]?.label}, {stepsData.steps[2]?.label} и{" "}
            {stepsData.steps[3]?.label}.
          </p>
          <div className="levels-steps-grid">
            {stepsData.steps.map((step) => (
              <article key={step.label} className="levels-step-card">
                <div className="levels-step-label">{step.label}</div>
                <div className="levels-step-title">{step.title}</div>
                <div className="levels-step-range">{step.range}</div>
              </article>
            ))}
          </div>
          <div className="levels-inline-note">
            <span className="levels-inline-note-icon">i</span>
            <span>Показано на примере вашего уровня: {stepsData.grade}.</span>
          </div>
        </section>
      </div>

      <section className="levels-card levels-card--diagram">
        <h2 className="levels-section-title">3. Как читать прогресс на аватарке</h2>

        <div className="levels-avatar-zone">
          <div className="levels-avatar-callout levels-avatar-callout--left-top">Цвет кольца = текущий уровень</div>
          <div className="levels-avatar-callout levels-avatar-callout--right-top">шкала делится на 4 условные ступени прогресса</div>
          <div className="levels-avatar-callout levels-avatar-callout--left-bottom">Текущий уровень</div>
          <div className="levels-avatar-callout levels-avatar-callout--right-bottom">
            Заполнение кольца = прогресс внутри уровня
          </div>

          <div className="levels-avatar-preview">
            <AvatarProgress
              imageUrl={hasPhoto ? profile?.photo : null}
              level={levelData.grade || "—"}
              progress={levelData.progressPercent}
              segments={4}
              size={260}
              initials={getInitials(profile)}
              ringColor={levelData.color.ring}
              labelGradientFrom={levelData.color.from}
              labelGradientTo={levelData.color.to}
              onImageError={() => setAvatarError(true)}
            />
          </div>
        </div>

        <div className="levels-example-box">
          <span className="levels-example-icon">★</span>
          <p>
            уровень <b>{levelData.numericLabel}</b> = фактический подуровень <b>{stepsData.currentStepLabel}</b>{" "}
            ({stepsData.currentStepTitle}), кольцо заполнено на <b>{formatNumber(levelData.progressPercent, 1)}%</b>.
          </p>
        </div>

        <div className="levels-benefits">
          <article className="levels-benefit">
            <div className="levels-benefit-icon levels-benefit-icon--purple">🏆</div>
            <div className="levels-benefit-title">Уровень растет</div>
            <div className="levels-benefit-copy">после удачных игр и турниров</div>
          </article>
          <article className="levels-benefit">
            <div className="levels-benefit-icon levels-benefit-icon--pink">📊</div>
            <div className="levels-benefit-title">Подуровни помогают</div>
            <div className="levels-benefit-copy">видеть прогресс внутри уровня</div>
          </article>
          <article className="levels-benefit">
            <div className="levels-benefit-icon levels-benefit-icon--orange">◔</div>
            <div className="levels-benefit-title">Чем полнее кольцо,</div>
            <div className="levels-benefit-copy">тем ближе следующий уровень</div>
          </article>
        </div>

        {fullName && <div className="levels-user-caption">Ваш профиль: {fullName}</div>}
      </section>

      {showScrollHint && (
        <div className="levels-scroll-hint" aria-hidden="true">
          <span className="levels-scroll-hint-text">Листайте вниз</span>
          <span className="levels-scroll-hint-arrow">⌄</span>
        </div>
      )}
    </div>
  );
}
