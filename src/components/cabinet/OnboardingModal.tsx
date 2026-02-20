import { useEffect, useMemo, useState } from "react";
import { Modal } from "../UI/Modal";
import { apiUpdateCustomFields } from "../../utils/apiClient";
import type { UserProfileType } from "../../utils/apiClient";

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

const BASE_QUESTION: Question = {
  id: "q1_1",
  text: "Опыт игры",
  type: "single",
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
    options: [
      { id: "yes", label: "Да", score: { type: "mul", value: 1.1 } },
      { id: "no", label: "Нет", score: { type: "mul", value: 1 } },
    ],
  },
  {
    id: "q3_3",
    text: "Используете ли вы свечу (лоб) как тактическое оружие?",
    type: "single",
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
    options: [
      { id: "style", label: "Играю в своем стиле", score: { type: "mul", value: 1 } },
      { id: "tempo", label: "Могу менять темп и тактику по ходу матча", score: { type: "mul", value: 1.1 } },
    ],
  },
  {
    id: "q4_5",
    text: "Сколько игр в месяц?",
    type: "single",
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
  onboardingFieldIndex: number;
  gamesLink: string;
  tournamentsLink: string;
  onProfileUpdated: () => void;
}

export function OnboardingModal({
  isOpen,
  onClose,
  profile,
  onboardingFieldIndex,
  gamesLink,
  tournamentsLink,
  onProfileUpdated,
}: OnboardingModalProps) {
  const existingRating = profile.customFields?.[onboardingFieldIndex]?.value?.[0];
  const hasRating = existingRating !== undefined && existingRating !== null && existingRating !== "";
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  const [doneScore, setDoneScore] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const experienceAnswer = answers.q1_1?.[0];
  const branchKey = experienceAnswer ? BRANCH_BY_EXPERIENCE[experienceAnswer] : null;

  const questions = useMemo(() => {
    if (!branchKey) return [BASE_QUESTION];
    return [BASE_QUESTION, ...BRANCH_QUESTIONS[branchKey]];
  }, [branchKey]);

  useEffect(() => {
    if (!isOpen) {
      setCurrentIndex(0);
      setAnswers({});
      setDoneScore(null);
      setError(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (currentIndex >= questions.length) {
      setCurrentIndex(Math.max(questions.length - 1, 0));
    }
  }, [currentIndex, questions.length]);

  const currentQuestion = questions[currentIndex];
  const selected = answers[currentQuestion?.id || ""] || [];

  const isMulti = currentQuestion?.type === "multi";
  const canNext = currentQuestion && selected.length > 0;
  const isLast = currentIndex === questions.length - 1;

  const handleSelect = (optionId: string) => {
    if (!currentQuestion) return;
    setAnswers((prev) => {
      if (currentQuestion.id === BASE_QUESTION.id) {
        return { [BASE_QUESTION.id]: [optionId] };
      }
      const prevSel = prev[currentQuestion.id] || [];
      if (currentQuestion.type === "multi") {
        const exists = prevSel.includes(optionId);
        const nextSel = exists ? prevSel.filter((id) => id !== optionId) : [...prevSel, optionId];
        return { ...prev, [currentQuestion.id]: nextSel };
      }
      return { ...prev, [currentQuestion.id]: [optionId] };
    });
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

    const rounded = Math.round(score * 10) / 10;
    return rounded.toFixed(1).replace(/\.0$/, "");
  };

  const handleFinish = async () => {
    const finalScore = computeScore();
    setDoneScore(finalScore);
    setSaving(true);
    setError(null);

    try {
      const updatedCustomFields = Array.isArray(profile.customFields)
        ? [...profile.customFields]
        : [];
      const currentField = updatedCustomFields[onboardingFieldIndex] || {};
      updatedCustomFields[onboardingFieldIndex] = {
        ...currentField,
        value: [finalScore],
      };

      const res = await apiUpdateCustomFields(updatedCustomFields);
      if (res.status === 200 || res.status === 204) {
        onProfileUpdated();
      } else {
        setError("Не удалось сохранить рейтинг. Попробуйте позже.");
      }
    } catch {
      setError("Не удалось сохранить рейтинг. Попробуйте позже.");
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  if (hasRating) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title="Онбординг">
        <div className="onboarding-body">
          <div className="onboarding-title">Онбординг уже пройден</div>
          <p className="onboarding-text">
            Ваш рейтинг можно верифицировать у администратора или участвуя в играх и турнирах.
          </p>
          <div className="onboarding-links">
            <a className="onboarding-link" href={gamesLink} target="_blank" rel="noopener noreferrer">
              Перейти к играм
            </a>
            <a className="onboarding-link" href={tournamentsLink} target="_blank" rel="noopener noreferrer">
              Перейти к турнирам
            </a>
          </div>
        </div>
      </Modal>
    );
  }

  if (doneScore) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title="Онбординг">
        <div className="onboarding-body">
          <div className="onboarding-title">Готово!</div>
          <p className="onboarding-text">Ваш рейтинг: <strong>{doneScore}</strong></p>
          <div className="onboarding-actions">
            <button className="btn-primary" onClick={onClose}>Закрыть</button>
          </div>
          {error && <div className="onboarding-error">{error}</div>}
        </div>
      </Modal>
    );
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Онбординг">
      <div className="onboarding-body">
        <div className="onboarding-progress">
          Вопрос {currentIndex + 1} из {questions.length}
        </div>
        <div className="onboarding-image">
          {currentQuestion?.image ? (
            <img src={currentQuestion.image} alt="" />
          ) : (
            <span>Изображение будет добавлено</span>
          )}
        </div>
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
            onClick={() => setCurrentIndex((prev) => Math.max(prev - 1, 0))}
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
              onClick={() => setCurrentIndex((prev) => Math.min(prev + 1, questions.length - 1))}
              disabled={!canNext}
            >
              Далее
            </button>
          )}
        </div>
        {error && <div className="onboarding-error">{error}</div>}
      </div>
    </Modal>
  );
}
