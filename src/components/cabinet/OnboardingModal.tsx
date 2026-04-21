import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { Modal } from "../UI/Modal";
import { apiSaveOnboardingLevel } from "../../utils/apiClient";
import type { UserProfileType } from "../../utils/apiClient";
import {
  CUSTOM_FIELD_IDS,
  formatNumericField,
  getCustomFieldValue,
  getLetterGrade,
} from "../../utils/customFields";
import { identifyAnalyticsUser, trackAnalyticsEvent, trackClientError } from "../../utils/analytics";
import { resolveHashActionTarget, retriggerHashAction } from "../../utils/hashActions";

type ScoreOp =
  | { type: "add"; value: number }
  | { type: "mul"; value: number };

type Option = {
  id: string;
  label: string;
  score?: ScoreOp;
  base?: number;
  cap?: number;
};

type Question = {
  id: string;
  text: string;
  type: "single" | "multi";
  image?: string;
  options: Option[];
};

const ONBOARDING_IMAGE_BASE =
  (import.meta.env.VITE_ONBOARDING_IMAGE_BASE as string | undefined)?.replace(/\/$/, "")
  || "https://padlhub.su/lk/assets";

const onboardingImage = (num: number) => `${ONBOARDING_IMAGE_BASE}/${num}.webp`;

const BASE_QUESTION: Question = {
  id: "q1_1",
  text: "Опыт игры",
  type: "single",
  image: onboardingImage(1),
  options: [
    { id: "less_month", label: "Меньше месяца", base: 1 },
    { id: "less_year", label: "Меньше года", base: 2 },
    { id: "one_two_years", label: "1–2 года", base: 2.5 },
    { id: "more_three_years", label: "Больше 3-х лет", base: 3.5 },
  ],
};

const BRANCH_1: Question[] = [
  {
    id: "q1_2",
    text: "Был ли опыт в теннисе, сквоше, бадминтоне?",
    type: "single",
    image: onboardingImage(8),
    options: [
      { id: "no", label: "Нет", score: { type: "add", value: 0 } },
      { id: "less_year", label: "Меньше года", score: { type: "add", value: 0.3 } },
      { id: "more_year", label: "Больше года", score: { type: "add", value: 1 } },
      { id: "prize", label: "Был призером", score: { type: "add", value: 2 } },
    ],
  },
  {
    id: "q1_3",
    text: "Какова ваша основная цель? (можно выбрать несколько)",
    type: "multi",
    image: onboardingImage(4),
    options: [
      { id: "try_new", label: "Попробовать новое", score: { type: "add", value: 0 } },
      { id: "fitness", label: "Улучшить физ. подготовку", score: { type: "add", value: 0.1 } },
      { id: "community", label: "Найти новое сообщество/общение", score: { type: "add", value: 0 } },
      { id: "progress", label: "В перспективе тренироваться и прогрессировать", score: { type: "add", value: 0.2 } },
    ],
  },
  {
    id: "q1_4",
    text: "Насколько уверенно вы чувствуете себя в координационных видах спорта?",
    type: "single",
    image: onboardingImage(3),
    options: [
      { id: "hard", label: "Обычно сложно дается", score: { type: "add", value: 0 } },
      { id: "middle", label: "Средне", score: { type: "add", value: 0.1 } },
      { id: "fast", label: "Быстро осваиваю", score: { type: "add", value: 0.25 } },
    ],
  },
  {
    id: "q1_5",
    text: "Оцените свою физическую форму",
    type: "single",
    image: onboardingImage(9),
    options: [
      { id: "rest", label: "Сидеть и отдыхать", score: { type: "add", value: 0 } },
      { id: "sometimes", label: "Иногда активен", score: { type: "add", value: 0.15 } },
      { id: "regular", label: "Регулярно тренируюсь", score: { type: "add", value: 0.25 } },
    ],
  },
];

const BRANCH_2: Question[] = [
  {
    id: "q2_2",
    text: "Тренировались ли с тренером?",
    type: "single",
    image: onboardingImage(2),
    options: [
      { id: "no", label: "Нет", score: { type: "mul", value: 1 } },
      { id: "few", label: "Пару раз", score: { type: "mul", value: 1.1 } },
      { id: "regular", label: "Да, на постоянной основе", score: { type: "mul", value: 1.2 } },
    ],
  },
  {
    id: "q2_3",
    text: "Ваши основные удары (бандэха, вибора)?",
    type: "single",
    image: onboardingImage(6),
    options: [
      { id: "learn", label: "Осваиваю, часто ошибаюсь", score: { type: "mul", value: 0.95 } },
      { id: "ok", label: "Выполняю, но без точности", score: { type: "mul", value: 1 } },
      { id: "stable", label: "Стабильно попадаю в игру", score: { type: "mul", value: 1.1 } },
    ],
  },
  {
    id: "q2_4",
    text: "Как часто играете у сетки?",
    type: "single",
    image: onboardingImage(3),
    options: [
      { id: "back", label: "Предпочитаю играть с задней линии", score: { type: "mul", value: 0.95 } },
      { id: "sometimes", label: "Иногда выхожу", score: { type: "mul", value: 1 } },
      { id: "net", label: "Стараюсь занимать сетку при возможности", score: { type: "mul", value: 1.1 } },
    ],
  },
  {
    id: "q2_5",
    text: "Сколько игр в месяц?",
    type: "single",
    image: onboardingImage(9),
    options: [
      { id: "1_3", label: "1–3", score: { type: "mul", value: 0.9 } },
      { id: "4_8", label: "4–8", score: { type: "mul", value: 1 } },
      { id: "8_plus", label: ">8", score: { type: "mul", value: 1.1 } },
    ],
  },
];

const BRANCH_3: Question[] = [
  {
    id: "q3_1",
    text: "Как оцениваете свой уровень?",
    type: "single",
    image: onboardingImage(9),
    options: [
      { id: "2_3", label: "2–3", score: { type: "add", value: 0 }, cap: 3 },
      { id: "3_4", label: "3–4", score: { type: "add", value: 0.5 }, cap: 4 },
      { id: "4_5", label: "4–5", score: { type: "add", value: 1.5 }, cap: 5 },
      { id: "5_6", label: "5–6", score: { type: "add", value: 2.5 }, cap: 6 },
    ],
  },
  {
    id: "q3_2",
    text: "Есть опыт участия в турнирах?",
    type: "single",
    image: onboardingImage(3),
    options: [
      { id: "yes", label: "Да", score: { type: "mul", value: 1.1 } },
      { id: "no", label: "Нет", score: { type: "mul", value: 1 } },
    ],
  },
  {
    id: "q3_3",
    text: "Используете ли вы свечу (лоб) как тактическое оружие?",
    type: "single",
    image: onboardingImage(4),
    options: [
      { id: "rare", label: "Редко", score: { type: "mul", value: 0.95 } },
      { id: "sometimes", label: "Иногда, чтобы выиграть время", score: { type: "mul", value: 1 } },
      { id: "regular", label: "Регулярно, чтобы сместить соперников с сетки", score: { type: "mul", value: 1.1 } },
    ],
  },
  {
    id: "q3_4",
    text: "Владеете ударом с задней стенки (contrapared)?",
    type: "single",
    image: onboardingImage(6),
    options: [
      { id: "no", label: "Нет", score: { type: "mul", value: 0.95 } },
      { id: "unstable", label: "Пробую, но нестабильно", score: { type: "mul", value: 1 } },
      { id: "yes", label: "Да, уверенно", score: { type: "mul", value: 1.1 } },
    ],
  },
  {
    id: "q3_5",
    text: "Сколько игр в месяц?",
    type: "single",
    image: onboardingImage(2),
    options: [
      { id: "1_4", label: "1–4", score: { type: "mul", value: 0.85 } },
      { id: "4_8", label: "4–8", score: { type: "mul", value: 1 } },
      { id: "8_plus", label: ">8", score: { type: "mul", value: 1.1 } },
    ],
  },
  {
    id: "q3_6",
    text: "Сколько турниров в месяц?",
    type: "single",
    image: onboardingImage(7),
    options: [
      { id: "0", label: "0", score: { type: "mul", value: 0.9 } },
      { id: "1_3", label: "1–3", score: { type: "mul", value: 1 } },
      { id: "3_plus", label: ">3", score: { type: "mul", value: 1.1 } },
    ],
  },
];

const BRANCH_4: Question[] = [
  {
    id: "q4_1",
    text: "Как оцениваете свой уровень игры?",
    type: "single",
    image: onboardingImage(9),
    options: [
      { id: "2_3", label: "2–3", score: { type: "add", value: -1 }, cap: 3 },
      { id: "3_4", label: "3–4", score: { type: "add", value: 0 }, cap: 4 },
      { id: "4_5", label: "4–5", score: { type: "add", value: 1 }, cap: 5 },
      { id: "5_6", label: "5–6", score: { type: "add", value: 2 }, cap: 6 },
    ],
  },
  {
    id: "q4_2",
    text: "Ваш коронный удар / тактическая схема?",
    type: "single",
    image: onboardingImage(3),
    options: [
      { id: "none", label: "Нет явного коронного", score: { type: "mul", value: 1 } },
      { id: "net", label: "Игра от сетки (бандэха, вибора)", score: { type: "mul", value: 1.05 } },
      { id: "attack", label: "Атакующая игра (смэш, х3)", score: { type: "mul", value: 1.05 } },
      { id: "tactical", label: "Тактическая игра (свечи, низкие отскоки)", score: { type: "mul", value: 1.1 } },
    ],
  },
  {
    id: "q4_3",
    text: "Как вы работаете в паре?",
    type: "single",
    image: onboardingImage(4),
    options: [
      { id: "solo", label: "Каждый сам за себя", score: { type: "mul", value: 0.95 } },
      { id: "cover", label: "Стараемся подстраховывать", score: { type: "mul", value: 1 } },
      { id: "schemes", label: "Используем простые схемы (смена позиций)", score: { type: "mul", value: 1.05 } },
      { id: "combos", label: "Имеем отработанные комбинации", score: { type: "mul", value: 1.1 } },
    ],
  },
  {
    id: "q4_4",
    text: "Насколько ваша игра вариативна?",
    type: "single",
    image: onboardingImage(6),
    options: [
      { id: "style", label: "Играю в своем стиле", score: { type: "mul", value: 1 } },
      { id: "tempo", label: "Могу менять темп и тактику по ходу матча", score: { type: "mul", value: 1.1 } },
    ],
  },
  {
    id: "q4_5",
    text: "Сколько игр в месяц?",
    type: "single",
    image: onboardingImage(2),
    options: [
      { id: "1_4", label: "1–4", score: { type: "mul", value: 0.9 } },
      { id: "4_8", label: "4–8", score: { type: "mul", value: 1 } },
      { id: "8_plus", label: ">8", score: { type: "mul", value: 1.1 } },
    ],
  },
  {
    id: "q4_6",
    text: "Сколько турниров в месяц?",
    type: "single",
    image: onboardingImage(7),
    options: [
      { id: "0", label: "0", score: { type: "mul", value: 0.9 } },
      { id: "1_3", label: "1–3", score: { type: "mul", value: 1 } },
      { id: "3_plus", label: ">3", score: { type: "mul", value: 1.1 } },
    ],
  },
];

type BranchKey = "b1" | "b2" | "b3" | "b4";

const BRANCH_BY_EXPERIENCE: Record<string, BranchKey> = {
  less_month: "b1",
  less_year: "b2",
  one_two_years: "b3",
  more_three_years: "b4",
};

const BRANCH_QUESTIONS: Record<BranchKey, Question[]> = {
  b1: BRANCH_1,
  b2: BRANCH_2,
  b3: BRANCH_3,
  b4: BRANCH_4,
};

interface OnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  profile: UserProfileType;
  gamesLink: string;
  trainingLink: string;
  tournamentsLink: string;
  onProfileUpdated: (payload: { levelLetter: string; levelNumeric: string }) => void;
}

export function OnboardingModal({
  isOpen,
  onClose,
  profile,
  gamesLink: _gamesLink,
  trainingLink,
  tournamentsLink,
  onProfileUpdated,
}: OnboardingModalProps) {
  const existingRating = getCustomFieldValue(profile, CUSTOM_FIELD_IDS.lkPadelLevelNumeric);
  const hasRating = existingRating !== undefined && existingRating !== null && existingRating !== "";
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  const [doneScore, setDoneScore] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readyQuestionId, setReadyQuestionId] = useState<string | null>(null);

  const experienceAnswer = answers.q1_1?.[0];
  const branchKey = experienceAnswer ? BRANCH_BY_EXPERIENCE[experienceAnswer] : null;

  const questions = useMemo(() => {
    if (!branchKey) return [BASE_QUESTION];
    return [BASE_QUESTION, ...BRANCH_QUESTIONS[branchKey]];
  }, [branchKey]);

  const handleClose = () => {
    trackAnalyticsEvent("onboarding_closed", {
      clientId: profile.id,
      stage: doneScore ? "done" : hasRating ? "already_completed" : "in_progress",
      currentQuestionId: currentQuestion?.id ?? null,
      currentQuestionIndex: currentQuestion ? currentIndex + 1 : null,
    });
    onClose();
  };

  const handleLinkClick = (
    event: MouseEvent<HTMLAnchorElement>,
    href: string,
    destination: "training" | "tournaments",
    source: "already_completed" | "completed",
  ) => {
    trackAnalyticsEvent("onboarding_link_click", {
      clientId: profile.id,
      destination,
      source,
    });

    const hashActionTarget = resolveHashActionTarget(href);
    if (!hashActionTarget) return;

    event.preventDefault();
    handleClose();
    window.setTimeout(() => {
      retriggerHashAction(hashActionTarget);
    }, 0);
  };

  useEffect(() => {
    if (!isOpen) {
      setCurrentIndex(0);
      setAnswers({});
      setDoneScore(null);
      setError(null);
      setReadyQuestionId(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    identifyAnalyticsUser({
      clientId: profile.id,
      phone: profile.phone,
      onboardingCompleted: hasRating,
      levelNumeric: existingRating ?? null,
    });
    trackAnalyticsEvent("onboarding_opened", {
      clientId: profile.id,
      onboardingAlreadyCompleted: hasRating,
      existingLevelNumeric: existingRating ?? null,
    });
  }, [isOpen, hasRating, existingRating, profile.id, profile.phone]);

  useEffect(() => {
    if (currentIndex >= questions.length) {
      setCurrentIndex(Math.max(questions.length - 1, 0));
    }
  }, [currentIndex, questions.length]);

  const currentQuestion = questions[currentIndex];
  const selected = answers[currentQuestion?.id || ""] || [];
  const isQuestionReady = !!currentQuestion && readyQuestionId === currentQuestion.id;

  useEffect(() => {
    if (!isOpen || !currentQuestion || hasRating || doneScore) return;
    trackAnalyticsEvent("onboarding_question_viewed", {
      clientId: profile.id,
      questionId: currentQuestion.id,
      questionIndex: currentIndex + 1,
      totalQuestions: questions.length,
      branch: branchKey ?? null,
    });
  }, [
    branchKey,
    currentIndex,
    currentQuestion,
    doneScore,
    hasRating,
    isOpen,
    profile.id,
    questions.length,
  ]);

  useEffect(() => {
    if (!isOpen || !currentQuestion) return;

    if (!currentQuestion.image) {
      setReadyQuestionId(currentQuestion.id);
      return;
    }

    setReadyQuestionId(null);
    let cancelled = false;
    const preloadImage = new Image();

    preloadImage.onload = () => {
      if (!cancelled) setReadyQuestionId(currentQuestion.id);
    };
    preloadImage.onerror = () => {
      if (!cancelled) setReadyQuestionId(currentQuestion.id);
    };
    preloadImage.src = currentQuestion.image;

    return () => {
      cancelled = true;
    };
  }, [isOpen, currentQuestion]);

  const isMulti = currentQuestion?.type === "multi";
  const canNext = currentQuestion && selected.length > 0;
  const isLast = currentIndex === questions.length - 1;

  const handleSelect = (optionId: string) => {
    if (!currentQuestion) return;
    const currentSelection = answers[currentQuestion.id] || [];
    let nextSelection: string[] = [optionId];

    if (currentQuestion.id === BASE_QUESTION.id) {
      nextSelection = [optionId];
    } else if (currentQuestion.type === "multi") {
      const exists = currentSelection.includes(optionId);
      nextSelection = exists
        ? currentSelection.filter((id) => id !== optionId)
        : [...currentSelection, optionId];
    }

    trackAnalyticsEvent("onboarding_answer_selected", {
      clientId: profile.id,
      questionId: currentQuestion.id,
      questionType: currentQuestion.type,
      selectedOptions: nextSelection,
    });

    setAnswers((prev) => {
      if (currentQuestion.id === BASE_QUESTION.id) {
        return { [BASE_QUESTION.id]: [optionId] };
      }
      if (currentQuestion.type === "multi") {
        return { ...prev, [currentQuestion.id]: nextSelection };
      }
      return { ...prev, [currentQuestion.id]: [optionId] };
    });
  };

  const handleBack = () => {
    trackAnalyticsEvent("onboarding_back_clicked", {
      clientId: profile.id,
      questionId: currentQuestion?.id ?? null,
      questionIndex: currentIndex + 1,
    });
    setCurrentIndex((prev) => Math.max(prev - 1, 0));
  };

  const handleNext = () => {
    trackAnalyticsEvent("onboarding_next_clicked", {
      clientId: profile.id,
      questionId: currentQuestion?.id ?? null,
      questionIndex: currentIndex + 1,
    });
    setCurrentIndex((prev) => Math.min(prev + 1, questions.length - 1));
  };

  const computeScore = () => {
    const baseAnswer = answers[BASE_QUESTION.id]?.[0];
    const baseOpt = BASE_QUESTION.options.find((o) => o.id === baseAnswer);
    let score = baseOpt?.base ?? 0;
    let cap: number | null = null;

    questions.forEach((q) => {
      if (q.id === BASE_QUESTION.id) return;
      const selectedIds = answers[q.id] || [];
      selectedIds.forEach((id) => {
        const opt = q.options.find((o) => o.id === id);
        if (!opt?.score) return;
        if (opt.score.type === "add") score += opt.score.value;
        if (opt.score.type === "mul") score *= opt.score.value;
        if (opt.cap !== undefined) cap = opt.cap;
      });
    });

    if (cap != null) score = Math.min(score, cap);
    return score;
  };

  const handleFinish = async () => {
    const finalScore = computeScore();
    const letterScore = getLetterGrade(finalScore);
    const numericScore = formatNumericField(finalScore);
    trackAnalyticsEvent("onboarding_submit_started", {
      clientId: profile.id,
      answeredQuestions: Object.keys(answers).length,
      totalQuestions: questions.length,
      finalLevelLetter: letterScore,
      finalLevelNumeric: numericScore,
    });
    setDoneScore(letterScore);
    setSaving(true);
    setError(null);

    try {
      const res = await apiSaveOnboardingLevel({
        clientId: profile.id,
        phone: profile.phone,
        levelLetter: letterScore,
        levelNumeric: numericScore,
      });
      if (!res.error && (res.status === 200 || res.status === 204)) {
        identifyAnalyticsUser({
          clientId: profile.id,
          phone: profile.phone,
          onboardingCompleted: true,
          levelLetter: letterScore,
          levelNumeric: numericScore,
        });
        trackAnalyticsEvent("onboarding_submit_success", {
          clientId: profile.id,
          status: res.status,
          finalLevelLetter: letterScore,
          finalLevelNumeric: numericScore,
        });
        onProfileUpdated({ levelLetter: letterScore, levelNumeric: numericScore });
      } else {
        trackClientError(
          "onboarding.save_failed",
          new Error(`Failed to save onboarding result: HTTP ${res.status}`),
          {
            clientId: profile.id,
            status: res.status,
          },
          { handled: true, severity: "error" },
        );
        trackAnalyticsEvent("onboarding_submit_failed", {
          clientId: profile.id,
          status: res.status,
        });
        setError("Не удалось сохранить рейтинг. Попробуйте позже.");
      }
    } catch (err) {
      trackClientError(
        "onboarding.save_exception",
        err,
        { clientId: profile.id },
        { handled: true, severity: "error" },
      );
      trackAnalyticsEvent("onboarding_submit_failed", {
        clientId: profile.id,
        error: err instanceof Error ? err.message : String(err),
      });
      setError("Не удалось сохранить рейтинг. Попробуйте позже.");
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  const titleText = hasRating ? "Верифицируй свой уровень" : "Определи свой уровень";

  if (hasRating) {
    return (
      <Modal isOpen={isOpen} onClose={handleClose} title={titleText}>
        <div className="onboarding-body">
          <div className="onboarding-title">Онбординг уже пройден</div>
          <p className="onboarding-text">
            Повторное прохождение недоступно. Рейтинг можно верифицировать у администратора
            или участвуя в групповых тренировках и турнирах.
          </p>
          <div className="onboarding-links">
            <a
              className="onboarding-link"
              href={trainingLink}
              target={resolveHashActionTarget(trainingLink) ? undefined : "_blank"}
              rel={resolveHashActionTarget(trainingLink) ? undefined : "noopener noreferrer"}
              onClick={(event) =>
                handleLinkClick(event, trainingLink, "training", "already_completed")}
            >
              Групповые тренировки
            </a>
            <a
              className="onboarding-link"
              href={tournamentsLink}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) =>
                handleLinkClick(event, tournamentsLink, "tournaments", "already_completed")}
            >
              Турниры
            </a>
          </div>
        </div>
      </Modal>
    );
  }

  if (doneScore) {
    return (
      <Modal isOpen={isOpen} onClose={handleClose} title={titleText}>
        <div className="onboarding-body">
          <div className="onboarding-title">Готово!</div>
          <p className="onboarding-text">Ваш уровень {doneScore}</p>
          <p className="onboarding-text">
            Если вы не согласны, вы можете верифицировать его на тренировке или при участии в турнире.
          </p>
          <div className="onboarding-links">
            <a
              className="onboarding-link"
              href={trainingLink}
              target={resolveHashActionTarget(trainingLink) ? undefined : "_blank"}
              rel={resolveHashActionTarget(trainingLink) ? undefined : "noopener noreferrer"}
              onClick={(event) =>
                handleLinkClick(event, trainingLink, "training", "completed")}
            >
              Перейти к тренировкам
            </a>
            <a
              className="onboarding-link"
              href={tournamentsLink}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) =>
                handleLinkClick(event, tournamentsLink, "tournaments", "completed")}
            >
              Перейти к турнирам
            </a>
          </div>
          <div className="onboarding-actions">
            <button className="btn-primary" onClick={handleClose}>Закрыть</button>
          </div>
          {error && <div className="onboarding-error">{error}</div>}
        </div>
      </Modal>
    );
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={titleText}>
      <div className="onboarding-body">
        <div className="onboarding-progress">
          Вопрос {currentIndex + 1} из {questions.length}
        </div>
        <div className="onboarding-image">
          {currentQuestion?.image ? (
            <>
              <img
                src={currentQuestion.image}
                alt=""
                className={isQuestionReady ? "onboarding-image-ready" : "onboarding-image-loading"}
              />
              {!isQuestionReady && <span className="onboarding-image-placeholder">Загрузка фото...</span>}
            </>
          ) : (
            <span>Изображение будет добавлено</span>
          )}
        </div>
        {isQuestionReady ? (
          <>
            <div className="onboarding-question">{currentQuestion?.text}</div>
            <div className="onboarding-options">
              {currentQuestion?.options.map((opt) => {
                const isSelected = selected.includes(opt.id);
                return (
                  <button
                    key={opt.id}
                    type="button"
                    className={`onboarding-option ${isSelected ? "selected" : ""}`}
                    onClick={() => handleSelect(opt.id)}
                  >
                    <span className="onboarding-option-label">{opt.label}</span>
                    {isMulti && (
                      <span className={`onboarding-check ${isSelected ? "on" : ""}`}></span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="onboarding-actions">
              <button
                className="btn-secondary"
                onClick={handleBack}
                disabled={currentIndex === 0}
              >
                Назад
              </button>
              {isLast ? (
                <button className="btn-primary" onClick={handleFinish} disabled={!canNext || saving}>
                  {saving ? "Сохранение..." : "Получить рейтинг"}
                </button>
              ) : (
                <button
                  className="btn-primary"
                  onClick={handleNext}
                  disabled={!canNext}
                >
                  Далее
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="onboarding-question-loading">Загрузка вопроса...</div>
        )}
        {error && <div className="onboarding-error">{error}</div>}
      </div>
    </Modal>
  );
}
