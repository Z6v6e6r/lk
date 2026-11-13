export function tournamentAutoFinishNotice(params: Record<string, unknown> | null | undefined): string | null {
  const timing = params?.autoFinish;
  if (!timing || typeof timing !== 'object') return null;
  const record = timing as Record<string, unknown>;
  if (record.version !== 1) return null;
  if (record.reason === 'time_limit') return params?.fpr6x25 && record.durationMs === 225 * 60_000
    ? 'Турнир завершён автоматически через 3 часа 45 минут после запуска.'
    : 'Турнир завершён автоматически через 3 часа после запуска.';
  if (record.reason) return null;
  const date = new Date(String(record.deadlineAt));
  if (!Number.isFinite(date.getTime())) return null;
  const results = params?.fpr6x25 ? 'В итоги войдут закрытые общие раунды.' : 'В итоги войдут сохранённые результаты.';
  return `Автоматическое завершение: ${date.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}. ${results}`;
}
