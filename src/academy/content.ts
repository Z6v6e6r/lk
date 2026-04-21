export type AcademyTestDefinition = {
  id: string;
  title: string;
  goal: string;
  metric: string;
  muscles: string;
  duration: string;
};

export type AcademyAchievementDefinition = {
  id: string;
  title: string;
  description: string;
  target: number;
  metric: "trainings" | "visits" | "communities" | "subscriptions";
};

export type AcademyNewsDefinition = {
  id: string;
  label: string;
  date: string;
  title: string;
  cta: string;
  size: "compact" | "feature" | "medium";
  tone: "violet" | "indigo" | "midnight";
};

export const ACADEMY_TESTS: AcademyTestDefinition[] = [
  {
    id: "sprint-30",
    title: "30 метров - спринт",
    goal: "Оценить скоростно-силовые способности игрока",
    metric: "Максимальная скорость и минимальное время",
    muscles: "Ягодичные, задняя поверхность бедра, квадрицепс, икроножные",
    duration: "45 мин на 25 человек",
  },
  {
    id: "countermovement-jump",
    title: "Countermovement Jump",
    goal: "Оценить высоту прыжка с определенной технической позиции",
    metric: "Высота прыжка",
    muscles: "Большая, средняя и малая ягодичные мышцы",
    duration: "45 мин на 25 человек",
  },
  {
    id: "five-ten-five",
    title: "5-10-5",
    goal: "Оценить способность к смене направления движения",
    metric: "Минимальное время",
    muscles: "Приводящие, отводящие, голеностоп, квадрицепс, ягодичные",
    duration: "45 мин на 25 человек",
  },
  {
    id: "five-zero-five",
    title: "5-0-5",
    goal: "Оценить способность резко тормозить и снова ускоряться",
    metric: "Минимальное время",
    muscles: "Средняя ягодичная, квадрицепс, задняя поверхность бедра",
    duration: "45 мин на 25 человек",
  },
  {
    id: "length-jump",
    title: "Length Jump",
    goal: "Оценить длину прыжка",
    metric: "Длина прыжка в сантиметрах",
    muscles: "Ягодичные, передняя и задняя поверхность бедра, икроножные",
    duration: "30 мин на 25 человек",
  },
  {
    id: "reactive-t-test",
    title: "Reactive T-Test",
    goal: "Оценить реакцию на внешний стимул и смену направления движения",
    metric: "Минимальное время",
    muscles: "Квадрицепс, передняя и задняя поверхность бедра, приводящие и отводящие",
    duration: "60 мин на 25 человек",
  },
];

export const ACADEMY_ACHIEVEMENTS: AcademyAchievementDefinition[] = [
  {
    id: "first-step",
    title: "Первый шаг",
    description: "Пройти первые 5 тренировок и закрепиться в ритме академии.",
    target: 5,
    metric: "trainings",
  },
  {
    id: "game-rhythm",
    title: "Ритм посещений",
    description: "Собрать 12 посещений и показать стабильность в работе.",
    target: 12,
    metric: "visits",
  },
  {
    id: "team-player",
    title: "Командный дух",
    description: "Вступить хотя бы в одно сообщество команды или группы.",
    target: 1,
    metric: "communities",
  },
  {
    id: "season-ready",
    title: "Готов к сезону",
    description: "Активировать абонемент и открыть регулярный цикл занятий.",
    target: 1,
    metric: "subscriptions",
  },
];

export const ACADEMY_NEWS: AcademyNewsDefinition[] = [
  {
    id: "spring-camp",
    label: "Акция",
    date: "15/03/2026",
    title: "Весенние сборы поколения F",
    cta: "Читать",
    size: "compact",
    tone: "violet",
  },
  {
    id: "academy-open-day",
    label: "Акция",
    date: "18/03/2026",
    title: "Открытая тренировка и просмотр составов",
    cta: "Читать",
    size: "feature",
    tone: "indigo",
  },
  {
    id: "testing-week",
    label: "Акция",
    date: "22/03/2026",
    title: "Неделя тестирования скорости и реакции",
    cta: "Читать",
    size: "medium",
    tone: "midnight",
  },
];
