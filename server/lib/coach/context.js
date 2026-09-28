import { isoDay, num, text, freshness } from './metrics.js';
import { budgetConversation } from './continuity.js';
export function recentConversation(messages) {
  // Budget by content, not turn count: short discussions should not forget a
  // decision merely because ten messages have passed.
  return budgetConversation(messages, { budget: 12000 }).messages;
}
const pick = (row, keys) => Object.fromEntries(keys.filter(k => row[k] != null && row[k] !== '').map(k => [k, typeof row[k] === 'string' ? text(row[k]) : Array.isArray(row[k]) ? row[k].filter(x => typeof x === 'string').slice(0, 7).map(x => text(x, 80)) : typeof row[k] === 'number' ? num(row[k]) : undefined]).filter(([, v]) => v !== undefined));
export async function buildSnapshot(repo, {
  today,
  authName
} = {}) {
  const [profile, prefs, nutrition, weight, goals, plans] = await Promise.all([repo.profile(), repo.preferences(), repo.nutrition(), repo.latestWeight(), repo.goals(), repo.activePlanHeads()]);
  const athlete = {
    ...nutrition,
    ...profile.athleteProfile,
    ...prefs
  };
  const dob = typeof athlete.dobISO === "string" && isoDay(athlete.dobISO) === athlete.dobISO ? athlete.dobISO : null;
  const age = dob && dob <= today ? Number(today.slice(0, 4)) - Number(dob.slice(0, 4)) - (today.slice(5) < dob.slice(5) ? 1 : 0) : null;
  const firstName = text(profile.firstName || profile.name?.split(' ')[0] || profile.displayName?.split(' ')[0] || authName?.split(' ')[0], 40);
  return {
    profile: {
      ...(firstName ? {
        firstName
      } : {}),
      ...pick(athlete, ['age', 'sex', 'heightCm']),
      ...(age != null && age >= 0 && age <= 120 ? {
        age,
        ageSource: 'derived_from_dobISO'
      } : {})
    },
    preferences: pick({
      ...profile.trainingPreferences,
      ...profile.athleteProfile,
      ...prefs
    }, ['trainingBackground', 'currentAbility', 'goalPrimaryFocus', 'goalDistance', 'targetEventName', 'targetEventDate', 'injuries', 'constraints', 'notesForCoach', 'trainingDays', 'daysPerWeek']),
    activePlans: plans.map(p => pick(p, ['name', 'primaryActivity', 'kind', 'goalPrimaryFocus', 'targetEventName', 'targetEventDate'])),
    goals: pick(goals, ['weeklyRuns', 'weeklySessions', 'weeklyRunKm', 'weeklyMinutes', 'weeklyStrengthMinutes']),
    nutrition: pick(nutrition, ['goalType', 'dailyCalories', 'proteinTarget', 'carbTarget', 'fatTarget', 'extraNotes', 'updatedAt']),
    weight: num(weight.weight) != null && (!weight.unit || weight.unit === 'kg') ? {
      weightKg: num(weight.weight),
      date: isoDay(weight.date),
      freshness: freshness([weight], today)
    } : {
      state: 'missing',
      ...(num(athlete.weightKg) != null ? {
        profileWeightKg: num(athlete.weightKg)
      } : {}),
      ...(num(nutrition.weightKg) != null ? {
        targetCalculationWeightKg: num(nutrition.weightKg)
      } : {})
    },
    sources: {
      garmin: {
        connected: profile.garmin?.connected === true,
        latestSync: null
      }
    },
    freshness: {
      profileUpdated: isoDay(profile.updatedAt),
      preferencesUpdated: isoDay(prefs.athleteProfileUpdatedAt || prefs.updatedAt),
      nutritionUpdated: isoDay(nutrition.updatedAt),
      goalsUpdated: isoDay(goals.updatedAt)
    },
    asOf: today
  };
}
