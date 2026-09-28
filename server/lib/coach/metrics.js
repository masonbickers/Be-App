import { calendarDay } from './dates.js';
export const num = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
export const text = (value, max = 200) => typeof value === 'string' ? value.trim().slice(0, max) : undefined;
export function isoDay(value) {
  if (value == null) return null;
  const d = value?.toDate?.() || new Date(value?.seconds ? value.seconds * 1000 : value);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}
export const round = n => Math.round(n * 100) / 100;
export function freshness(rows, today, dateOf = row => isoDay(row.date), threshold = 7) {
  const latestDate = rows.map(dateOf).filter(Boolean).sort().at(-1) || null;
  const daysSinceLatest = latestDate ? Math.max(0, Math.round((Date.parse(today) - Date.parse(latestDate)) / 86400000)) : null;
  return {
    latestDate,
    daysSinceLatest,
    state: latestDate ? daysSinceLatest > threshold ? 'stale' : 'current' : 'missing',
    scope: 'returned records; not proof of last provider sync'
  };
}
export function weightTrend(rows) {
  const byDay = new Map();
  for (const r of rows) { const values=byDay.get(r.date)||[];values.push(r.weightKg);byDay.set(r.date,values); }
  const sorted = [...byDay].map(([date,values])=>[date,values.reduce((sum,value)=>sum+value,0)/values.length]).sort((a, b) => a[0].localeCompare(b[0]));
  if (sorted.length < 4) return {
    status: 'insufficient_data'
  };
  const first = Date.parse(sorted[0][0]),
    last = Date.parse(sorted.at(-1)[0]);
  if (last - first < 14 * 86400000) return {
    status: 'insufficient_data'
  };
  const a = sorted.filter(([d]) => Date.parse(d) < first + 7 * 86400000),
    b = sorted.filter(([d]) => Date.parse(d) > last - 7 * 86400000);
  if (a.length < 2 || b.length < 2) return {
    status: 'insufficient_data'
  };
  const mean = xs => xs.reduce((sum, x) => sum + x[1], 0) / xs.length;
  const center = xs => xs.reduce((sum, x) => sum + Date.parse(x[0]), 0) / xs.length;
  const change = mean(b) - mean(a);
  return {
    status: 'available',
    firstWindowAverageKg: round(mean(a)),
    lastWindowAverageKg: round(mean(b)),
    changeKg: round(change),
    kgPerWeek: round(change / ((center(b) - center(a)) / 604800000)),
    firstWindowDays: a.length,
    lastWindowDays: b.length,
    method: 'means of measured days in first and last seven-day windows; no interpolation'
  };
}
export function runningSummary(rows) {
  const weeks = new Map();
  let km = 0,
    seconds = 0;
  for (const r of rows) {
    if (r.distanceKm == null) continue;
    const day = new Date(r.date + 'T00:00:00Z');
    day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
    const key = isoDay(day);
    weeks.set(key, (weeks.get(key) || 0) + r.distanceKm);
    km += r.distanceKm;
    if (r.durationSeconds != null) seconds += r.durationSeconds;
  }
  return {
    totalKm: round(km),
    totalDurationSeconds: seconds,
    weeks: [...weeks].sort().map(([weekStart, distanceKm]) => ({
      weekStart,
      distanceKm: round(distanceKm)
    })),
    note: 'Only recorded activities; absent weeks are not proof of no exercise.'
  };
}
export function nutritionDays(meals, timeZone = "UTC") {
  const days = new Map();
  for (const m of meals) {
    const date = calendarDay(m.date, timeZone);
    if (!date) continue;
    const d = days.get(date) || {
      date,
      calories: 0,
      protein: 0,
      carbs: 0,
      fat: 0,
      meals: 0,
      missingMacros: 0,
      unknownMacros: []
    };
    for (const key of ['calories', 'protein', 'carbs', 'fat']) {
      const n = num(m[key]);
      if (n === null || n < 0) {
        d.missingMacros++;
        if (!d.unknownMacros.includes(key)) d.unknownMacros.push(key);
      } else d[key] += n;
    }
    d.meals++;
    days.set(date, d);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map(d => ({
    ...d,
    ...Object.fromEntries(['calories', 'protein', 'carbs', 'fat'].map(k => [k, d.unknownMacros.includes(k) ? null : round(d[k])]))
  }));
}
