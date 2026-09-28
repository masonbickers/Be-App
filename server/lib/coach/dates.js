export function validTimeZone(value) {
  try {
    if (typeof value === 'string' && value.length <= 64) {
      new Intl.DateTimeFormat('en', {
        timeZone: value
      }).format();
      return value;
    }
  } catch {}
  return 'UTC';
}
export function calendarDay(value, timeZone = 'UTC') {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (value == null) return null;
  const date = value?.toDate?.() || new Date(value?.seconds ? value.seconds * 1000 : value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const part = k => parts.find(p => p.type === k)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export const moveDay = (day, offset) => new Date(Date.parse(day + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
