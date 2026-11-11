const categories = { rent: 'Выбрать манеж', games: 'Сборные игры', events: 'Мероприятия' };
export function buildInquiry({ category, name, request, arena = '', date = '', plan = '' }) {
  if (!Object.hasOwn(categories, category)) throw new Error('Выберите тему запроса.');
  name = String(name || '').trim(); request = String(request || '').trim();
  if (!name || name.length > 60) throw new Error('Укажите имя — до 60 символов.');
  if (request.length < 10 || request.length > 700) throw new Error('Опишите запрос: от 10 до 700 символов.');
  const dateValue = date ? new Date(`${date}T12:00:00Z`) : null;
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(dateValue.getTime()) || dateValue.toISOString().slice(0, 10) !== date)) throw new Error('Проверьте желаемую дату.');
  const details = [
    `Имя: ${name}`,
    `Станция: ${String(arena || 'Помогите выбрать').slice(0, 140)}`,
    date ? `Дата: ${date.split('-').reverse().join('.')}` : ''
  ].filter(Boolean).join('\n');
  return [
    `ЗАЯВКА · ${categories[category]}`,
    details,
    `Запрос:\n${request}`,
    plan ? `План игры:\n${String(plan).slice(0, 800)}` : '',
    'Родина'
  ].filter(Boolean).join('\n\n');
}
export function managerLink(text = '') {
  // Native Telegram clients decode percent escapes but may keep form-style
  // '+' spaces literally. Encode spaces as %20 and actual plus signs as %2B.
  return 'https://t.me/ffc_manager' + (text ? '?text=' + encodeURIComponent(text) : '');
}
export function managerAppLink(text = '') {
  return 'tg://resolve?domain=ffc_manager' + (text ? '&text=' + encodeURIComponent(text) : '');
}
