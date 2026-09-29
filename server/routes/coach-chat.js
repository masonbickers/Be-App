import { editablePlanFields, preparePlanActionResponse } from '../lib/coach/planActions.mjs';
import { Buffer } from 'node:buffer';
import { createLegacyMemoryBridge } from '../lib/coach/legacyMemoryBridge.js';
import { legacyMemoryRepositoryForUser } from '../lib/coach/legacyMemoryRepository.js';
import { selectMemories } from '../lib/coach/memory.js';
import { recentConversation } from '../lib/coach/context.js';
import { isInternalCoachReply } from '../../src/lib/chat/coachReply.js';
// server/routes/coach-chat.js
import express from "express";
import {
  OPENAI_COACH_CHAT_MODEL,
  OPENAI_FALLBACK_MODEL,
} from "../config/openaiModels.js";

function normaliseList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function extractWeeks(plan) {
  const candidates = [
    plan?.weeks,
    plan?.plan?.weeks,
    plan?.planData?.weeks,
    plan?.generatedPlan?.weeks,
    plan?.activePlan?.weeks,
    plan?.output?.weeks,
    plan?.result?.weeks,
    plan?.template?.weeks,
    plan?.program?.weeks,
    plan?.schedule?.weeks,
    plan?.payload?.weeks,
  ];

  for (const candidate of candidates) {
    const weeks = normaliseList(candidate);
    if (weeks.length) return weeks;
  }

  return [];
}

function summarisePlan(plan) {
  if (!plan) return null;

  const weeks = extractWeeks(plan);
  let sessionsCount = 0;
  let totalMinutes = 0;
  let totalKm = 0;
  const preview = [];

  weeks.forEach((week, weekIndex) => {
    const weekLabel =
      week?.title ||
      (week?.weekNumber != null ? `Week ${week.weekNumber}` : `Week ${weekIndex + 1}`);
    const days = normaliseList(week?.days);

    if (days.length) {
      days.forEach((day, dayIndex) => {
        const dayLabel = day?.day || day?.label || day?.name || `Day ${dayIndex + 1}`;
        const sessions = normaliseList(day?.sessions);

        sessions.forEach((session) => {
          sessionsCount += 1;
          const durationMin = Number(session?.targetDurationMin ?? session?.durationMin ?? 0) || 0;
          const distanceKm = Number(session?.targetDistanceKm ?? session?.distanceKm ?? 0) || 0;
          totalMinutes += durationMin;
          totalKm += distanceKm;

          if (preview.length < 8) {
            preview.push({
              week: weekLabel,
              day: dayLabel,
              title:
                session?.title ||
                session?.name ||
                session?.type ||
                session?.sessionType ||
                "Session",
              durationMin: durationMin || null,
              distanceKm: distanceKm || null,
            });
          }
        });
      });
      return;
    }

    const sessions = [
      ...normaliseList(week?.sessions),
      ...normaliseList(week?.workouts),
    ];

    sessions.forEach((session) => {
      sessionsCount += 1;
      const durationMin = Number(session?.targetDurationMin ?? session?.durationMin ?? 0) || 0;
      const distanceKm = Number(session?.targetDistanceKm ?? session?.distanceKm ?? 0) || 0;
      totalMinutes += durationMin;
      totalKm += distanceKm;

      if (preview.length < 8) {
        preview.push({
          week: weekLabel,
          day: weekLabel,
          title:
            session?.title ||
            session?.name ||
            session?.type ||
            session?.sessionType ||
            "Session",
          durationMin: durationMin || null,
          distanceKm: distanceKm || null,
        });
      }
    });
  });

  return {
    name: plan?.name || plan?.title || null,
    primaryActivity: plan?.primaryActivity || plan?.meta?.primaryActivity || null,
    goalPrimaryFocus: plan?.goalPrimaryFocus || plan?.meta?.goalPrimaryFocus || null,
    targetEventName: plan?.targetEventName || plan?.meta?.targetEventName || null,
    targetEventDate: plan?.targetEventDate || plan?.meta?.targetEventDate || null,
    weeksCount: weeks.length,
    sessionsCount,
    totalMinutes: Math.round(totalMinutes),
    totalKm: Number(totalKm.toFixed(1)),
    preview,
  };
}

const WEEKDAY_INDEX = {
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
};

function latestUserMessage(messages) {
  for (let i = (Array.isArray(messages) ? messages.length : 0) - 1; i >= 0; i -= 1) {
    const item = messages[i];
    if (item?.role === "user" && typeof item?.content === "string" && item.content.trim()) {
      return item.content.trim();
    }
  }
  return "";
}

function normaliseText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\u2019/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const NUTRITION_ESTIMATES = [
  {
    title: "Flat white",
    pluralTitle: "flat whites",
    aliases: ["flat white", "flatwhite"],
    calories: 120,
    protein: 6,
    carbs: 10,
    fat: 6,
    servingText: "1 regular cup",
    notes: "Estimated from a typical flat white with dairy milk.",
  },
  {
    title: "Latte",
    pluralTitle: "lattes",
    aliases: ["latte", "caffe latte", "cafe latte"],
    calories: 150,
    protein: 8,
    carbs: 12,
    fat: 7,
    servingText: "1 regular cup",
    notes: "Estimated from a regular latte with dairy milk.",
  },
  {
    title: "Cappuccino",
    pluralTitle: "cappuccinos",
    aliases: ["cappuccino"],
    calories: 100,
    protein: 5,
    carbs: 8,
    fat: 5,
    servingText: "1 regular cup",
    notes: "Estimated from a regular cappuccino with dairy milk.",
  },
  {
    title: "Americano",
    pluralTitle: "americanos",
    aliases: ["americano", "black coffee", "coffee"],
    calories: 5,
    protein: 0,
    carbs: 0,
    fat: 0,
    servingText: "1 cup",
    notes: "Estimated as black coffee without milk or sugar.",
  },
  {
    title: "Banana",
    pluralTitle: "bananas",
    aliases: ["banana"],
    calories: 105,
    protein: 1.3,
    carbs: 27,
    fat: 0.3,
    servingText: "1 medium banana",
    notes: "Estimated from a medium banana.",
  },
  {
    title: "Protein shake",
    pluralTitle: "protein shakes",
    aliases: ["protein shake", "whey shake"],
    calories: 140,
    protein: 25,
    carbs: 3,
    fat: 2,
    servingText: "1 serving",
    notes: "Estimated from a typical whey protein shake mixed with water.",
  },
  {
    title: "Oats",
    pluralTitle: "oats",
    aliases: ["oats", "porridge"],
    calories: 190,
    protein: 6,
    carbs: 32,
    fat: 4,
    servingText: "1 bowl",
    notes: "Estimated from a typical bowl of oats.",
  },
  {
    title: "Berries",
    pluralTitle: "berries",
    aliases: ["berries", "mixed berries"],
    calories: 60,
    protein: 1,
    carbs: 14,
    fat: 0.5,
    servingText: "1 handful",
    notes: "Estimated from a handful of mixed berries.",
  },
  {
    title: "Greek yoghurt",
    pluralTitle: "Greek yoghurt servings",
    aliases: ["greek yoghurt", "greek yogurt"],
    calories: 130,
    protein: 15,
    carbs: 8,
    fat: 4,
    servingText: "1 serving",
    notes: "Estimated from a serving of plain Greek yoghurt.",
  },
  {
    title: "Grilled chicken breast burger with chips",
    pluralTitle: "grilled chicken breast burgers with chips",
    aliases: [
      "grilled chicken breast burger with chips",
      "grilled chicken burger with chips",
      "chicken breast burger with chips",
      "chicken burger with chips",
      "chicken burger and chips",
    ],
    calories: 780,
    protein: 48,
    carbs: 82,
    fat: 28,
    servingText: "1 burger with 1 side of chips",
    notes: "Estimated from a grilled chicken burger with bun and a medium side of chips.",
  },
];
const NUTRITION_COMPONENT_ESTIMATES = [
  {
    aliases: ["chips", "fries"],
    title: "Chips",
    calories: 330,
    protein: 4,
    carbs: 45,
    fat: 15,
  },
  {
    aliases: ["chicken breast", "grilled chicken", "chicken"],
    title: "Chicken",
    calories: 220,
    protein: 36,
    carbs: 0,
    fat: 6,
  },
  {
    aliases: ["burger"],
    title: "Burger",
    calories: 390,
    protein: 22,
    carbs: 36,
    fat: 17,
  },
  {
    aliases: ["wrap"],
    title: "Wrap",
    calories: 280,
    protein: 12,
    carbs: 36,
    fat: 9,
  },
  {
    aliases: ["sandwich"],
    title: "Sandwich",
    calories: 330,
    protein: 16,
    carbs: 42,
    fat: 10,
  },
  {
    aliases: ["rice"],
    title: "Rice",
    calories: 240,
    protein: 5,
    carbs: 52,
    fat: 1,
  },
  {
    aliases: ["veg", "vegetables", "mixed veg", "mixed vegetables"],
    title: "Veg",
    calories: 80,
    protein: 3,
    carbs: 14,
    fat: 1,
  },
  {
    aliases: ["pasta"],
    title: "Pasta",
    calories: 360,
    protein: 12,
    carbs: 68,
    fat: 4,
  },
  {
    aliases: ["salad"],
    title: "Salad",
    calories: 180,
    protein: 8,
    carbs: 14,
    fat: 10,
  },
];
const NUTRITION_FOOD_KEYWORDS = [
  "americano",
  "banana",
  "burger",
  "cappuccino",
  "chicken",
  "chips",
  "coffee",
  "egg",
  "fries",
  "berries",
  "greek yoghurt",
  "greek yogurt",
  "latte",
  "oats",
  "pasta",
  "pizza",
  "porridge",
  "rice",
  "salad",
  "sandwich",
  "shake",
  "smoothie",
  "toast",
  "veg",
  "vegetables",
  "wrap",
  "yoghurt",
  "yogurt",
];

function normaliseNutritionSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9.\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCaseNutritionItem(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1).toLowerCase() : ""))
    .join(" ");
}

function inferNutritionMealType(text) {
  const clean = normaliseNutritionSearchText(text);
  if (/\bbreakfast\b/.test(clean)) return "Breakfast";
  if (/\blunch\b/.test(clean)) return "Lunch";
  if (/\bdinner\b|\btea\b/.test(clean)) return "Dinner";
  if (/\bsnack\b/.test(clean)) return "Snack";
  return "Unspecified";
}

function extractNutritionItemText(message) {
  const clean = normaliseNutritionSearchText(message);
  if (!clean) return "";

  const patterns = [
    /^(?:please\s+)?(?:can you\s+)?(?:add|log|track|record)\s+(?:my\s+)?(.+?)$/,
    /^(?:i\s+)?(?:just\s+)?(?:had|ate|drank)\s+(.+?)$/,
  ];

  for (const pattern of patterns) {
    const match = clean.match(pattern);
    if (match?.[1]) {
      return match[1]
        .replace(/\b(?:to|for)\s+(?:my\s+)?(?:day|today|nutrition|food log|diary|breakfast|lunch|dinner|snack)\b.*$/i, "")
        .replace(/\b(?:today|this morning|this afternoon|tonight)\b.*$/i, "")
        .replace(/^(?:a|an|one|some|my)\s+/, "")
        .trim();
    }
  }

  if (isLikelyStandaloneNutritionItem(message)) {
    return clean.replace(/^(?:a|an|one|some|my)\s+/, "").trim();
  }

  return "";
}

function isLikelyStandaloneNutritionItem(message) {
  const raw = String(message || "").trim();
  const clean = normaliseNutritionSearchText(raw);
  if (!clean || clean.length < 3 || clean.length > 90) return false;
  if (raw.includes("?")) return false;
  if (/^(?:what|why|how|when|where|should|can|could|would|will|do|does|is|are)\b/.test(clean)) {
    return false;
  }
  return NUTRITION_FOOD_KEYWORDS.some((keyword) => clean.includes(keyword));
}

function parseNutritionQuantity(text) {
  const clean = normaliseNutritionSearchText(text);
  const numeric = clean.match(/^(\d+(?:\.\d+)?)\s+/);
  if (numeric) {
    const count = Number(numeric[1]);
    if (Number.isFinite(count) && count > 0 && count <= 10) return count;
  }
  if (/^(?:two|couple)\s+/.test(clean)) return 2;
  if (/^three\s+/.test(clean)) return 3;
  return 1;
}

function findNutritionEstimate(itemText) {
  const clean = normaliseNutritionSearchText(itemText)
    .replace(/^(\d+(?:\.\d+)?|two|three|couple)\s+/, "")
    .replace(/^(?:a|an|one|some)\s+/, "")
    .trim();
  if (!clean) return null;

  return NUTRITION_ESTIMATES.find((estimate) =>
    estimate.aliases.some((alias) => {
      const cleanAlias = normaliseNutritionSearchText(alias);
      return clean === cleanAlias || clean.includes(cleanAlias);
    })
  );
}

function findExactNutritionEstimate(itemText) {
  const clean = normaliseNutritionSearchText(itemText)
    .replace(/^(\d+(?:\.\d+)?|two|three|couple)\s+/, "")
    .replace(/^(?:a|an|one|some)\s+/, "")
    .trim();
  if (!clean) return null;

  return (
    NUTRITION_ESTIMATES.find((estimate) =>
      estimate.aliases.some((alias) => clean === normaliseNutritionSearchText(alias))
    ) || null
  );
}

function findNutritionAliasMatch(clean, alias) {
  const cleanAlias = normaliseNutritionSearchText(alias);
  if (!clean || !cleanAlias) return null;
  const start = clean.indexOf(cleanAlias);
  if (start < 0) return null;
  const end = start + cleanAlias.length;
  const beforeOk = start === 0 || /\s/.test(clean[start - 1]);
  const afterOk = end === clean.length || /\s/.test(clean[end]);
  return beforeOk && afterOk ? { start, end, alias: cleanAlias } : null;
}

function collectNutritionItemMatches(itemText) {
  const clean = normaliseNutritionSearchText(itemText)
    .replace(/^(\d+(?:\.\d+)?|two|three|couple)\s+/, "")
    .replace(/^(?:a|an|one|some)\s+/, "")
    .trim();
  if (!clean || !isLikelyStandaloneNutritionItem(clean)) return [];

  const candidates = [];
  NUTRITION_ESTIMATES.forEach((estimate) => {
    estimate.aliases.forEach((alias) => {
      const match = findNutritionAliasMatch(clean, alias);
      if (!match) return;
      candidates.push({
        ...match,
        title: estimate.title,
        calories: estimate.calories,
        protein: estimate.protein,
        carbs: estimate.carbs,
        fat: estimate.fat,
        source: "estimate",
      });
    });
  });
  NUTRITION_COMPONENT_ESTIMATES.forEach((component) => {
    component.aliases.forEach((alias) => {
      const match = findNutritionAliasMatch(clean, alias);
      if (!match) return;
      candidates.push({
        ...match,
        title: component.title || titleCaseNutritionItem(match.alias),
        calories: component.calories,
        protein: component.protein,
        carbs: component.carbs,
        fat: component.fat,
        source: "component",
      });
    });
  });

  const selected = [];
  const seenTitles = new Set();
  candidates
    .sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))
    .forEach((candidate) => {
      const overlaps = selected.some(
        (item) => candidate.start < item.end && candidate.end > item.start
      );
      const titleKey = normaliseNutritionSearchText(candidate.title);
      if (overlaps || seenTitles.has(titleKey)) return;
      selected.push(candidate);
      seenTitles.add(titleKey);
    });

  return selected.sort((a, b) => a.start - b.start);
}

function joinNutritionTitles(titles) {
  return titles
    .map((title, index) => {
      const text = String(title || "").trim();
      if (index === 0) return text;
      return text ? text[0].toLowerCase() + text.slice(1) : text;
    })
    .filter(Boolean)
    .join(" + ");
}

function createCombinedNutritionEstimate(itemText) {
  const matches = collectNutritionItemMatches(itemText);
  if (matches.length < 2) return null;

  const totals = matches.reduce(
    (sum, item) => ({
      calories: sum.calories + item.calories,
      protein: sum.protein + item.protein,
      carbs: sum.carbs + item.carbs,
      fat: sum.fat + item.fat,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 }
  );
  const titles = matches.map((item) => item.title);

  return {
    title: joinNutritionTitles(titles),
    pluralTitle: joinNutritionTitles(titles),
    aliases: [normaliseNutritionSearchText(itemText)],
    calories: totals.calories,
    protein: totals.protein,
    carbs: totals.carbs,
    fat: totals.fat,
    servingText: `${matches.length} estimated items`,
    notes: `Estimated from: ${titles.join(", ")}. Review the numbers before adding.`,
    combinedItems: titles,
  };
}

function createComponentNutritionEstimate(itemText) {
  const clean = normaliseNutritionSearchText(itemText);
  if (!clean || !isLikelyStandaloneNutritionItem(clean)) return null;

  const matched = [];
  NUTRITION_COMPONENT_ESTIMATES.forEach((component) => {
    const hasComponent = component.aliases.some((alias) =>
      clean.includes(normaliseNutritionSearchText(alias))
    );
    if (hasComponent) matched.push(component);
  });

  if (!matched.length) return null;

  const totals = matched.reduce(
    (sum, item) => ({
      calories: sum.calories + item.calories,
      protein: sum.protein + item.protein,
      carbs: sum.carbs + item.carbs,
      fat: sum.fat + item.fat,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 }
  );

  if (totals.calories < 80) return null;

  return {
    title: titleCaseNutritionItem(clean),
    pluralTitle: titleCaseNutritionItem(clean),
    aliases: [clean],
    calories: totals.calories,
    protein: totals.protein,
    carbs: totals.carbs,
    fat: totals.fat,
    servingText: "1 estimated serving",
    notes: "Estimated from recognised meal components. Review the numbers before adding.",
  };
}

function createNutritionDraftFromText(message) {
  const itemText = extractNutritionItemText(message);
  if (!itemText) return null;

  const estimate =
    findExactNutritionEstimate(itemText) ||
    createCombinedNutritionEstimate(itemText) ||
    findNutritionEstimate(itemText) ||
    createComponentNutritionEstimate(itemText);
  if (!estimate) return null;

  const quantity = parseNutritionQuantity(itemText);
  const isCombined = Array.isArray(estimate.combinedItems) && estimate.combinedItems.length > 1;
  const multiplier = !isCombined && Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
  const title =
    multiplier > 1
      ? `${multiplier} ${estimate.pluralTitle || `${estimate.title.toLowerCase()}s`}`
      : estimate.title;

  return {
    title: titleCaseNutritionItem(title),
    mealType: inferNutritionMealType(message),
    calories: Math.round(estimate.calories * multiplier),
    protein: Number((estimate.protein * multiplier).toFixed(1)),
    carbs: Number((estimate.carbs * multiplier).toFixed(1)),
    fat: Number((estimate.fat * multiplier).toFixed(1)),
    servingText: multiplier > 1 ? `${multiplier} servings` : estimate.servingText,
    notes: estimate.notes,
    source: "coach_chat",
  };
}

function sentenceCaseMemoryText(value) {
  const text = cleanCoachText(value);
  if (!text) return "";
  return text[0].toUpperCase() + text.slice(1);
}

function extractMemorySaveText(message) {
  const raw = String(message || "").trim();
  if (!raw) return "";
  const clean = normaliseText(raw);
  const patterns = [
    /^(?:please\s+)?remember(?:\s+(?:that|this|my))?\s+(.+)$/,
    /^(?:please\s+)?save(?:\s+(?:that|this|my))?\s+(.+)$/,
    /^(?:please\s+)?note(?:\s+(?:that|this|my))?\s+(.+)$/,
    /^(?:please\s+)?keep in mind(?:\s+that)?\s+(.+)$/,
  ];

  for (const pattern of patterns) {
    const match = clean.match(pattern);
    if (!match?.[1]) continue;
    return sentenceCaseMemoryText(
      match[1]
        .replace(/^(?:that|this|my)\s+/, "")
        .replace(/[.!?]+$/g, "")
    );
  }

  return "";
}

function memorySaveCategory(memoryText) {
  const clean = normaliseText(memoryText);
  if (
    clean.includes("pain") ||
    clean.includes("sore") ||
    clean.includes("injury") ||
    clean.includes("niggle") ||
    clean.includes("knee") ||
    clean.includes("ankle") ||
    clean.includes("back") ||
    clean.includes("shoulder")
  ) {
    return "injury";
  }
  if (
    clean.includes("prefer") ||
    clean.includes("hate") ||
    clean.includes("like") ||
    clean.includes("better") ||
    clean.includes("morning") ||
    clean.includes("treadmill") ||
    clean.includes("breakfast")
  ) {
    return "preference";
  }
  return "general";
}

function buildMemorySaveResponse(message) {
  const memoryText = extractMemorySaveText(message);
  if (!memoryText) return null;
  const category = memorySaveCategory(memoryText);
  const reply = `Saved — I'll remember that ${memoryText[0].toLowerCase()}${memoryText.slice(1)}.`;
  const coachActions = [
    {
      id: "memory-save-1",
      type: "memory_save",
      status: "pending",
      autoApply: true,
      title: "Coach memory saved",
      summary: memoryText,
      reason: "Saving this helps the coach personalise future training advice.",
      payload: {
        text: memoryText,
        category,
        source: "coach_chat",
      },
    },
  ];

  return {
    reply,
    updatedPlan: null,
    nutritionDraft: null,
    coachActions,
    raw: JSON.stringify({ reply, updatedPlan: null, nutritionDraft: null, coachActions }),
  };
}

function cleanCoachText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/([.!?]){2,}/g, "$1")
    .trim();
}

function sessionActivityText(session) {
  return normaliseText(
    [
      session?.planKind,
      session?.primaryActivity,
      session?.activityType,
      session?.sessionType,
      session?.type,
      session?.workout?.sport,
      session?.title,
      session?.name,
    ].join(" ")
  );
}

function isStrengthLikeSession(session) {
  const text = sessionActivityText(session);
  return /\b(strength|gym|weight|weights|weighttraining|push|pull|legs|upper|lower|bench|dumbbell|press|squat|deadlift|hyrox)\b/.test(text);
}

function meaningfulSessionDistanceKm(session) {
  const distance = Number(session?.distanceKm ?? session?.actualDistanceKm ?? session?.plannedDistanceKm);
  if (!Number.isFinite(distance) || distance <= 0) return null;
  if (isStrengthLikeSession(session)) return null;
  return Number(distance.toFixed(distance >= 10 ? 1 : 2)).toString().replace(/\.0$/, "");
}

function meaningfulSessionDurationMin(session) {
  const duration = Number(session?.durationMin ?? session?.actualDurationMin ?? session?.targetDurationMin);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return Math.round(duration);
}

function formatSessionDetail(session, { includeDate = false } = {}) {
  if (!session) return null;

  const title = String(session?.title || session?.name || "Session").trim();
  const bits = [];
  if (includeDate && session?.dateLabel) bits.push(session.dateLabel);
  bits.push(title);
  const distanceKm = meaningfulSessionDistanceKm(session);
  const durationMin = meaningfulSessionDurationMin(session);
  if (distanceKm != null) bits.push(`${distanceKm} km`);
  else if (durationMin != null) bits.push(`${durationMin} min`);
  return cleanCoachText(bits.filter(Boolean).join(" · "));
}

function formatSessionCoachLine(session, { includeDate = false } = {}) {
  if (!session) return null;

  const title = String(session?.title || session?.name || "Session").trim();
  const bits = [];
  if (includeDate && session?.dateLabel) bits.push(session.dateLabel);
  bits.push(title);
  const distanceKm = meaningfulSessionDistanceKm(session);
  const durationMin = meaningfulSessionDurationMin(session);
  if (distanceKm != null) bits.push(`${distanceKm} km`);
  else if (durationMin != null) bits.push(`${durationMin} min`);

  const effort = cleanCoachText(session?.notes || session?.description || "");
  const main = bits.filter(Boolean).join(" - ");
  return cleanCoachText(effort ? `${main}. ${effort}` : main);
}

function compactSessionMetric(session) {
  const distanceKm = meaningfulSessionDistanceKm(session);
  if (distanceKm != null) return `${distanceKm} km`;

  const durationMin = meaningfulSessionDurationMin(session);
  if (durationMin != null) return `${durationMin} min`;

  const target = firstNonEmptyString([
    session?.target,
    session?.mainSet,
    session?.prescription,
    session?.summary,
  ]);
  if (!target) return "";
  return cleanCoachText(target).replace(/\bconsistency edit\b.*$/i, "").trim();
}

const COMPACT_WEEK_PLACEHOLDER_STATUSES = new Set([
  "?",
  "❔",
  "❓",
  "�",
  "？",
  "unknown",
  "n/a",
  "na",
  "none",
  "--",
]);

function isCompactWeekPlaceholderStatus(value) {
  const text = String(value || "").trim();
  if (!text) return true;
  const withoutVariationSelectors = text.replace(/\uFE0F/g, "");
  return (
    COMPACT_WEEK_PLACEHOLDER_STATUSES.has(withoutVariationSelectors.toLowerCase()) ||
    /^[?❔❓�？]+$/.test(withoutVariationSelectors)
  );
}

function compactStatusMarker(session) {
  const rawStatus = statusTextForSession(session);
  if (isCompactWeekPlaceholderStatus(rawStatus)) {
    return "";
  }

  const status = classifySessionStatus(session);
  if (status === "completed") return "completed";
  if (status === "skipped") return "skipped";
  if (status === "moved") return "moved";
  return "";
}

function displayableCompactWeekPart(value) {
  const text = String(value || "").trim();
  if (isCompactWeekPlaceholderStatus(text)) return "";
  return text;
}

function sanitiseCompactWeekOverview(text) {
  return String(text || "")
    .replace(/\s*·\s*(?:[?❔❓�？]\uFE0F*)+(?=\s*(?:\/|\n|$))/g, "")
    .replace(/\s*\((?:[?❔❓�？]\uFE0F*)+\)(?=\s*(?:\/|\n|$))/g, "")
    .replace(/(\s—\s*)(?:[?❔❓�？]\uFE0F*)+(?=\s*(?:\/|\n|$))/g, "$1")
    .replace(/(^|\n)(?:[?❔❓�？]\uFE0F*)+\s*(?=\n|$)/g, "$1")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

function compactWeekDateLabel(session) {
  const label = firstNonEmptyString([
    session?.dateLabel,
    session?.dayLabel,
    session?.displayDate,
    session?.date,
    session?.isoDate,
  ]);
  if (label) {
    return label.replace(/\b2026\b/g, "").replace(/\s+/g, " ").trim();
  }

  const dayName = firstNonEmptyString([session?.day, session?.weekday, session?.name]);
  if (dayName) return dayName;

  const dayIndex = Number(session?.dayIndex);
  if (Number.isInteger(dayIndex) && dayIndex >= 0 && dayIndex <= 6) {
    const labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    return labels[dayIndex];
  }

  return "Day";
}

function compactWeekSessionText(session) {
  const title = cleanCoachText(
    session?.title ||
      session?.name ||
      session?.sessionName ||
      session?.sessionTitle ||
      session?.type ||
      session?.sessionType ||
      "Session"
  );
  const metric = compactSessionMetric(session);
  const status = compactStatusMarker(session);
  return [title, metric, status].map(displayableCompactWeekPart).filter(Boolean).join(" · ");
}

function buildCompactWeekOverview(currentWeekSchedule, clock) {
  const sessions = (Array.isArray(currentWeekSchedule) ? currentWeekSchedule : []).filter(Boolean);
  if (!sessions.length) {
    return [
      `This week starts from ${clock?.todayLabel || "today"}.`,
      "",
      "I do not have any scheduled sessions loaded for this week.",
    ].join("\n");
  }

  const grouped = [];
  const indexByLabel = new Map();
  sessions.forEach((session) => {
    const label = compactWeekDateLabel(session);
    if (!indexByLabel.has(label)) {
      indexByLabel.set(label, grouped.length);
      grouped.push({ label, sessions: [] });
    }
    grouped[indexByLabel.get(label)].sessions.push(session);
  });

  return sanitiseCompactWeekOverview([
    "Here's your week:",
    "",
    ...grouped.map((group) => {
      const items = group.sessions.map(compactWeekSessionText).filter(Boolean);
      return `${group.label} — ${items.join(" / ")}`;
    }),
    "",
    "Main focus: keep the quality high and don't chase extra volume.",
  ].join("\n"));
}

function isActivePlanQuestion(text) {
  return (
    text.includes("what plan am i currently on") ||
    text.includes("what plan am i on") ||
    text.includes("which plan am i on") ||
    text.includes("what is my current plan") ||
    text.includes("what's my current plan") ||
    text.includes("what programme am i following") ||
    text.includes("what program am i following") ||
    text.includes("what training plan am i on") ||
    text.includes("what training plan am i following") ||
    text.includes("what plan am i following")
  );
}

function isWeeklyFocusQuestion(text) {
  return (
    text.includes("what should i focus on this week") ||
    text.includes("how should i approach this week") ||
    text.includes("what is the main goal this week") ||
    text.includes("what's the main goal this week") ||
    text.includes("what should i prioritise this week") ||
    text.includes("what should i prioritize this week") ||
    text.includes("weekly focus") ||
    (text.includes("this week") &&
      (text.includes("focus") ||
        text.includes("approach") ||
        text.includes("main goal") ||
        text.includes("priority") ||
        text.includes("prioritise") ||
        text.includes("prioritize")))
  );
}

function isGeneralTrainingAdviceQuestion(text) {
  const asksHowOrAdvice =
    text.includes("how ") ||
    text.includes("how can") ||
    text.includes("how do") ||
    text.includes("what is the best way") ||
    text.includes("what should i be careful") ||
    text.includes("be careful") ||
    text.includes("tips") ||
    text.includes("advice") ||
    text.includes("structure") ||
    text.includes("program");
  const trainingTopic =
    text.includes("running") ||
    text.includes("run training") ||
    text.includes("runner") ||
    text.includes("hill") ||
    text.includes("hills") ||
    text.includes("running form") ||
    text.includes("run form") ||
    text.includes("running technique") ||
    text.includes("technique") ||
    text.includes("strength training") ||
    text.includes("lifting") ||
    text.includes("gym") ||
    text.includes("mobility") ||
    text.includes("conditioning") ||
    text.includes("fitness") ||
    text.includes("endurance") ||
    text.includes("speed") ||
    text.includes("faster") ||
    text.includes("pace") ||
    text.includes("5k") ||
    text.includes("injured") ||
    text.includes("stronger");

  return (
    (asksHowOrAdvice && trainingTopic) ||
    text.includes("how can i improve my 5k") ||
    text.includes("how do i improve my 5k") ||
    text.includes("improve my 5k time") ||
    text.includes("improve my 5 k time") ||
    text.includes("get better at 5k") ||
    text.includes("run a faster 5k") ||
    text.includes("how do i run faster") ||
    text.includes("how can i run faster") ||
    text.includes("how do i get faster") ||
    text.includes("how can i get faster") ||
    text.includes("build speed safely") ||
    text.includes("how can i build endurance") ||
    text.includes("how do i build endurance") ||
    text.includes("build endurance") ||
    text.includes("build my endurance") ||
    text.includes("how do i get stronger") ||
    text.includes("how can i get stronger") ||
    text.includes("get stronger") ||
    text.includes("improve my pace") ||
    text.includes("improve my running") ||
    text.includes("become a better runner")
  );
}

function titleForActivePlan(plan) {
  return firstNonEmptyString([
    plan?.name,
    plan?.title,
    plan?.planName,
    plan?.planTitle,
    plan?.summary?.name,
    plan?.meta?.name,
    plan?.meta?.title,
  ]);
}

function focusForActivePlan(plan, summary) {
  return firstNonEmptyString([
    plan?.goalPrimaryFocus,
    plan?.primaryGoal,
    plan?.goal,
    plan?.focus,
    plan?.weekFocus,
    plan?.currentWeekFocus,
    plan?.phase,
    plan?.block,
    plan?.meta?.goalPrimaryFocus,
    plan?.meta?.primaryGoal,
    plan?.meta?.focus,
    plan?.meta?.phase,
    summary?.goalPrimaryFocus,
    summary?.primaryActivity,
  ]);
}

function structureForActivePlan(currentWeekSchedule, summary) {
  const sessions = (Array.isArray(currentWeekSchedule) ? currentWeekSchedule : []).filter(Boolean);
  if (sessions.length) {
    const runCount = sessions.filter((session) => !isStrengthLikeSession(session)).length;
    const strengthCount = sessions.filter(isStrengthLikeSession).length;
    const bits = [];
    if (runCount) bits.push(`${runCount} run${runCount === 1 ? "" : "s"}`);
    if (strengthCount) bits.push(`${strengthCount} strength session${strengthCount === 1 ? "" : "s"}`);
    if (bits.length) return `${bits.join(" + ")} this week`;
    return `${sessions.length} session${sessions.length === 1 ? "" : "s"} this week`;
  }

  const summarySessions = Number(summary?.sessionsCount);
  if (Number.isFinite(summarySessions) && summarySessions > 0) {
    return `${summarySessions} planned session${summarySessions === 1 ? "" : "s"} loaded`;
  }

  return "";
}

function weekLabelForActivePlan(clock, currentWeekSchedule) {
  const sessions = (Array.isArray(currentWeekSchedule) ? currentWeekSchedule : []).filter(Boolean);
  const first = compactWeekDateLabel(sessions[0] || {});
  const last = compactWeekDateLabel(sessions[sessions.length - 1] || {});
  if (first && last && first !== "Day" && last !== "Day" && first !== last) {
    return `${first}–${last}`;
  }
  return clock?.todayLabel ? `the week of ${clock.todayLabel}` : "";
}

function buildActivePlanReply({ clock, training, currentWeekSchedule, todaySchedule, context }) {
  const activePlans = Array.isArray(training?.activePlans)
    ? training.activePlans.filter(Boolean)
    : [];
  const summary = context?.activePlanSummary || null;
  const primaryPlan = activePlans[0] || summary || null;

  if (!primaryPlan && !currentWeekSchedule.length) {
    return "I do not have an active plan loaded right now.";
  }

  const name = titleForActivePlan(primaryPlan);
  const weekLabel = weekLabelForActivePlan(clock, currentWeekSchedule);
  const focus = focusForActivePlan(primaryPlan, summary);
  const structure = structureForActivePlan(currentWeekSchedule, summary);
  const today = (Array.isArray(todaySchedule) ? todaySchedule : []).find(Boolean);
  const todayName = today ? cleanCoachText(today?.title || today?.name || today?.sessionTitle || "today's session") : "";

  const lines = [
    name
      ? `You're currently on ${name}${weekLabel ? ` for ${weekLabel}` : ""}.`
      : `You're currently on your active training plan${weekLabel ? ` for ${weekLabel}` : ""}.`,
  ];

  if (focus) lines.push(`Main focus: ${cleanCoachText(focus)}.`);
  if (structure) lines.push(`Structure: ${structure}.`);
  if (todayName) lines.push(`Today is ${todayName}, but that is just one part of the wider plan.`);

  return lines.join("\n");
}

function formatCompletedSessionFact(session) {
  if (!session) return null;

  const bits = [
    session?.dateLabel || session?.date || null,
    session?.name || session?.title || "Completed session",
    session?.type || null,
    session?.durationMin ? `${session.durationMin} min` : null,
    session?.distanceKm ? `${session.distanceKm} km` : null,
    session?.strength?.loggedExercises
      ? `${session.strength.loggedExercises} exercises`
      : null,
    session?.strength?.totalSets ? `${session.strength.totalSets} sets` : null,
  ].filter(Boolean);

  const exerciseNames = Array.isArray(session?.strength?.exercises)
    ? session.strength.exercises
        .slice(0, 5)
        .map((item) => item?.name)
        .filter(Boolean)
    : [];
  const takeaways = Array.isArray(session?.analysis?.keyTakeaways)
    ? session.analysis.keyTakeaways.filter(Boolean).slice(0, 3)
    : [];

  return [
    bits.join(" · "),
    exerciseNames.length ? `Exercises: ${exerciseNames.join(", ")}` : null,
    session?.analysis?.summary ? `Summary: ${session.analysis.summary}` : null,
    takeaways.length ? `Takeaways: ${takeaways.join("; ")}` : null,
    session?.analysis?.recoveryImpact
      ? `Recovery impact: ${session.analysis.recoveryImpact}`
      : null,
    session?.analysis?.coachRecommendation
      ? `Coach recommendation: ${session.analysis.coachRecommendation}`
      : null,
  ]
    .filter(Boolean)
    .join(". ");
}

function firstNonEmptyString(values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function sessionDateKey(session) {
  const raw = firstNonEmptyString([
    session?.date,
    session?.isoDate,
    session?.completedAt,
    session?.statusAt,
    session?.startIso,
    session?.startedAt,
    session?.updatedAt,
    session?.createdAt,
  ]);
  const isoMatch = raw.match(/\d{4}-\d{2}-\d{2}/);
  return isoMatch ? isoMatch[0] : "";
}

function sessionIdentityKeys(session) {
  return [
    session?.sessionKey,
    session?.linkedSessionId,
    session?.linkedTrainSessionId,
    session?.id,
    session?.trainSessionId,
    session?.lastTrainSessionId,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function titleToken(session) {
  return normaliseText(
    session?.title ||
      session?.name ||
      session?.sessionName ||
      session?.sessionTitle ||
      session?.type ||
      session?.sessionType ||
      ""
  );
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sessionsAreLikelySame(planned, completed) {
  if (!planned || !completed) return false;

  const plannedKeys = sessionIdentityKeys(planned);
  const completedKeys = new Set(sessionIdentityKeys(completed));
  if (plannedKeys.some((key) => completedKeys.has(key))) return true;

  const samePlanPosition =
    String(planned?.planId || "").trim() &&
    String(planned?.planId || "").trim() === String(completed?.planId || "").trim() &&
    Number(planned?.weekIndex) === Number(completed?.weekIndex) &&
    Number(planned?.dayIndex) === Number(completed?.dayIndex) &&
    Number(planned?.sessionIndex) === Number(completed?.sessionIndex);
  if (samePlanPosition) return true;

  const plannedTitle = titleToken(planned);
  const completedTitle = titleToken(completed);
  if (!plannedTitle || !completedTitle || plannedTitle !== completedTitle) return false;

  const plannedDistance = numberOrNull(planned?.distanceKm ?? planned?.actualDistanceKm);
  const completedDistance = numberOrNull(completed?.distanceKm ?? completed?.actualDistanceKm);
  if (
    plannedDistance != null &&
    completedDistance != null &&
    Math.abs(plannedDistance - completedDistance) <= 0.2
  ) {
    return true;
  }

  const plannedDuration = numberOrNull(planned?.durationMin ?? planned?.actualDurationMin);
  const completedDuration = numberOrNull(completed?.durationMin ?? completed?.actualDurationMin);
  if (
    plannedDuration != null &&
    completedDuration != null &&
    Math.abs(plannedDuration - completedDuration) <= 5
  ) {
    return true;
  }

  return false;
}

function statusTextForSession(session) {
  return normaliseText(
    firstNonEmptyString([
      session?.status,
      session?.sessionStatus,
      session?.state,
      session?.logStatus,
      session?.completionStatus,
      session?.matchStatus,
      session?.draft?.status,
    ])
  ).replace(/[\s-]+/g, "_");
}

function hasSessionStatusSignal(session) {
  return Boolean(
    statusTextForSession(session) ||
      session?.completed === true ||
      session?.completedAt ||
      session?.skipped === true ||
      session?.skippedAt ||
      session?.movedToSessionKey ||
      session?.movedToDate ||
      session?.rescheduledToDate ||
      session?.rescheduledToIso ||
      session?.draft
  );
}

function classifySessionStatus(session) {
  const status = statusTextForSession(session);
  const haystack = normaliseText(
    [
      status,
      session?.statusLabel,
      session?.title,
      session?.name,
      session?.sessionType,
      session?.type,
    ].join(" ")
  );

  if (
    status.includes("complete") ||
    status.includes("completed") ||
    status.includes("logged") ||
    status.includes("linked") ||
    status.includes("done") ||
    session?.completed === true ||
    !!session?.completedAt
  ) {
    return "completed";
  }

  if (
    status.includes("skip") ||
    status.includes("missed") ||
    status.includes("cancel") ||
    session?.skipped === true ||
    !!session?.skippedAt
  ) {
    return "skipped";
  }

  if (
    status.includes("moved") ||
    status.includes("rescheduled") ||
    status.includes("deferred") ||
    status.includes("postponed") ||
    !!session?.movedToSessionKey ||
    !!session?.movedToDate ||
    !!session?.rescheduledToDate ||
    !!session?.rescheduledToIso
  ) {
    return "moved";
  }

  if (status.includes("progress") || status.includes("active") || status.includes("started")) {
    return "in_progress";
  }

  if (/\b(rest|recovery day)\b/.test(haystack)) return "rest";
  if (!hasSessionStatusSignal(session)) return "unknown";
  if (
    status.includes("fresh") ||
    status.includes("planned") ||
    status.includes("pending") ||
    status.includes("not_started") ||
    status.includes("scheduled") ||
    status.includes("incomplete") ||
    status.includes("due")
  ) {
    return "due";
  }

  return "unknown";
}

function movedTargetText(session) {
  const target = firstNonEmptyString([
    session?.movedToDate,
    session?.rescheduledToDate,
    session?.rescheduledToIso,
    session?.movedToIso,
    session?.movedToSessionKey,
  ]);
  if (!target) return "";
  const dateMatch = target.match(/\d{4}-\d{2}-\d{2}/);
  return dateMatch ? dateMatch[0] : target;
}

function todayCompletedSessions(training, clock) {
  const todayIso = String(clock?.todayIso || "").slice(0, 10);
  const recentCompletedSessions = Array.isArray(training?.recentCompletedSessions)
    ? training.recentCompletedSessions.filter(Boolean)
    : [];
  const lastCompletedSession = training?.lastCompletedSession ? [training.lastCompletedSession] : [];
  const seen = new Set();

  return [...lastCompletedSession, ...recentCompletedSessions].filter((session) => {
    const key = sessionIdentityKeys(session)[0] || `${sessionDateKey(session)}:${titleToken(session)}`;
    if (seen.has(key)) return false;
    seen.add(key);

    const sessionDay = sessionDateKey(session);
    if (todayIso && sessionDay) return sessionDay === todayIso;
    if (clock?.todayLabel && session?.dateLabel) {
      return String(session.dateLabel).trim() === String(clock.todayLabel).trim();
    }
    return false;
  });
}

function buildTodaySessionState(todaySchedule, completedToday) {
  const rows = (Array.isArray(todaySchedule) ? todaySchedule : [])
    .filter(Boolean)
    .map((session) => ({
      session,
      status: classifySessionStatus(session),
      matchedCompletedSession: null,
    }));

  const matchedLogs = new Set();
  completedToday.forEach((completedSession, completedIndex) => {
    const alreadyMatched = rows.some((row) =>
      row.matchedCompletedSession
        ? sessionsAreLikelySame(row.matchedCompletedSession, completedSession)
        : false
    );
    if (alreadyMatched) {
      matchedLogs.add(completedIndex);
      return;
    }

    const matchIndex = rows.findIndex((row) =>
      sessionsAreLikelySame(row.session, completedSession)
    );
    if (matchIndex >= 0) {
      rows[matchIndex] = {
        ...rows[matchIndex],
        status: "completed",
        matchedCompletedSession: rows[matchIndex].matchedCompletedSession || completedSession,
      };
      matchedLogs.add(completedIndex);
    }
  });

  if (
    rows.length === 1 &&
    completedToday.length === 1 &&
    !["completed", "skipped", "moved", "rest"].includes(rows[0].status)
  ) {
    rows[0] = {
      ...rows[0],
      status: "completed",
      matchedCompletedSession: completedToday[0],
    };
    matchedLogs.add(0);
  }

  return {
    rows,
    unmatchedCompleted: completedToday.filter((_, index) => !matchedLogs.has(index)),
  };
}

function statusLabelForTodayRow(row) {
  if (row?.status === "completed") return "completed";
  if (row?.status === "skipped") return "skipped";
  if (row?.status === "moved") {
    const target = movedTargetText(row.session);
    return target ? `moved to ${target}` : "moved";
  }
  if (row?.status === "in_progress") return "in progress";
  if (row?.status === "rest") return "recovery";
  if (row?.status === "due") return "still to do";
  return "status not confirmed";
}

function formatTodayRow(row) {
  const line = formatSessionCoachLine(row?.session) || "Session";
  return `${line} (${statusLabelForTodayRow(row)})`;
}

function sectionLines(title, rows, formatter = formatTodayRow) {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  if (!list.length) return [];
  const heading = String(title || "").trim();
  return [
    ...(heading ? [heading] : []),
    ...list.map((row) => `- ${formatter(row)}`),
  ];
}

function sessionDisplayName(session) {
  return cleanCoachText(
    session?.title ||
      session?.name ||
      session?.sessionName ||
      session?.sessionTitle ||
      session?.type ||
      session?.sessionType ||
      "session"
  );
}

function formatInlineSessionNames(rowsOrSessions) {
  const names = (Array.isArray(rowsOrSessions) ? rowsOrSessions : [])
    .map((item) => sessionDisplayName(item?.session || item))
    .filter(Boolean);
  if (!names.length) return "session";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function userStatesCompletedPremise(text) {
  return (
    text.includes("if i already completed") ||
    text.includes("if i've already completed") ||
    text.includes("if i have already completed") ||
    text.includes("already completed it") ||
    text.includes("already completed today") ||
    text.includes("already done it") ||
    text.includes("already done today")
  );
}

function buildTodayPlanReply({ text, clock, training, todaySchedule }) {
  const todayLabel = clock?.todayLabel || "today";
  const completedToday = todayCompletedSessions(training, clock);
  const { rows, unmatchedCompleted } = buildTodaySessionState(todaySchedule, completedToday);
  const dueRows = rows.filter((row) => row.status === "due" || row.status === "in_progress");
  const unknownRows = rows.filter((row) => row.status === "unknown");
  const plannedOrUnknownRows = [...dueRows, ...unknownRows];
  const completedRows = rows.filter((row) => row.status === "completed");
  const skippedRows = rows.filter((row) => row.status === "skipped");
  const movedRows = rows.filter((row) => row.status === "moved");
  const restRows = rows.filter((row) => row.status === "rest");
  const completedEvidence = completedRows.length ? completedRows : unmatchedCompleted;
  const hasCompletedEvidence = completedRows.length > 0 || unmatchedCompleted.length > 0;
  const asksAlreadyTrained =
    text.includes("already trained") ||
    text.includes("already completed") ||
    text.includes("completed today") ||
    text.includes("done today") ||
    text.includes("did i train today") ||
    text.includes("have i trained today") ||
    text.includes("have i already trained") ||
    text.includes("have i already completed");
  const asksShouldStillDo =
    text.includes("should i still") ||
    text.includes("do today") ||
    text.includes("repeat");
  const completedPremise = userStatesCompletedPremise(text);

  if (asksShouldStillDo) {
    if (completedPremise || hasCompletedEvidence) {
      return [
        "No — if you've already completed today's planned session, don't repeat it.",
        "",
        hasCompletedEvidence
          ? `Completed today: ${formatInlineSessionNames(completedEvidence)}.`
          : null,
        "Focus on recovery, mobility, steps, or an easy walk.",
      ]
        .filter(Boolean)
        .join("\n");
    }

    if (dueRows.length) {
      return [
        `If you haven't completed it yet, do the planned ${formatInlineSessionNames(dueRows)} session and keep it controlled.`,
      ].join("\n");
    }

    if (unknownRows.length) {
      return [
        `I can see today's ${formatInlineSessionNames(unknownRows)} session, but I can't confirm it has been logged as completed yet.`,
        "",
        "If you have completed it, don't repeat it. If you have not, do the planned work and keep it controlled.",
      ].join("\n");
    }
  }

  if (asksAlreadyTrained) {
    if (hasCompletedEvidence && !plannedOrUnknownRows.length) {
      return [
        `Yes — you've already completed today's ${formatInlineSessionNames(completedEvidence)} session.`,
        "Keep the rest of the day easy unless you've planned extra recovery work.",
      ].join("\n");
    }

    if (hasCompletedEvidence && plannedOrUnknownRows.length) {
      return [
        `Yes — you've completed ${formatInlineSessionNames(completedEvidence)} today.`,
        "",
        ...sectionLines("Still planned or not confirmed:", plannedOrUnknownRows),
      ].join("\n");
    }

    if (dueRows.length && !unknownRows.length) {
      return [
        `Not yet — today's ${formatInlineSessionNames(dueRows)} session is still planned.`,
      ].join("\n");
    }

    if (unknownRows.length) {
      return [
        `I can see today's ${formatInlineSessionNames(unknownRows)} session, but I can't confirm it has been logged as completed yet.`,
      ].join("\n");
    }

    if (skippedRows.length || movedRows.length) {
      return [
        "I do not have a completed session logged for today.",
        "",
        ...sectionLines("Skipped:", skippedRows),
        ...sectionLines("Moved or rescheduled:", movedRows),
      ].join("\n");
    }

    return "I do not have a completed session logged for today.";
  }

  if (!rows.length) {
    if (completedToday.length) {
      return [
        asksAlreadyTrained
          ? "Yes - you have already logged training today."
          : `Today is ${todayLabel}.`,
        "",
        ...sectionLines(
          "Completed today:",
          completedToday,
          (session) => formatSessionCoachLine(session) || formatCompletedSessionFact(session) || "Completed session"
        ),
        "",
        "I do not have another planned session for today. Keep the rest of the day recovery-focused: mobility, an easy walk, stretching, and nutrition.",
      ].join("\n");
    }

    return [
      `Today is ${todayLabel}.`,
      "",
      "I do not have a planned session for you today in the loaded plan.",
      "",
      "Use it as a recovery day, or ask me for an optional light session if you feel fresh.",
    ].join("\n");
  }

  if (!plannedOrUnknownRows.length) {
    const allCompleted = completedRows.length === rows.length;

    if (allCompleted) {
      return [
        asksShouldStillDo
          ? "No - today's planned training is already complete."
          : asksAlreadyTrained
          ? "Yes - you have already completed today's planned training."
          : `Today is ${todayLabel}. Today's planned training is already complete.`,
        "",
        ...sectionLines("Completed:", completedRows),
        ...sectionLines(
          unmatchedCompleted.length ? "Other training logged today:" : "",
          unmatchedCompleted,
          (session) => formatSessionCoachLine(session) || formatCompletedSessionFact(session) || "Completed session"
        ).filter(Boolean),
        "",
        "No need to repeat it. Make the rest of today recovery-focused: mobility, an easy walk, stretching, and nutrition.",
      ].join("\n");
    }

    if (movedRows.length && !completedRows.length && !skippedRows.length) {
      return [
        `Today is ${todayLabel}.`,
        "",
        ...sectionLines("Today's planned training has been moved or rescheduled:", movedRows),
        "",
        "Follow the updated scheduled day rather than doing it today.",
      ].join("\n");
    }

    if (skippedRows.length && !completedRows.length && !movedRows.length) {
      return [
        `Today is ${todayLabel}.`,
        "",
        ...sectionLines("Today's planned training is marked skipped:", skippedRows),
        "",
        "Treat today as recovery unless you want help rescheduling it.",
      ].join("\n");
    }

    if (restRows.length && !completedRows.length && !skippedRows.length && !movedRows.length) {
      return [
        `Today is ${todayLabel}.`,
        "",
        "Your plan has today down as recovery.",
        "",
        "Keep it easy: mobility, a walk, stretching, and good nutrition.",
      ].join("\n");
    }

    return [
      `Today is ${todayLabel}. Today's planned training is already resolved.`,
      "",
      ...sectionLines("Completed:", completedRows),
      ...sectionLines("Skipped:", skippedRows),
      ...sectionLines("Moved or rescheduled:", movedRows),
      ...sectionLines("Recovery:", restRows),
      "",
      "There is nothing else planned to complete today.",
    ].join("\n");
  }

  return [
    completedRows.length || unmatchedCompleted.length
      ? "You have already completed part of today's training."
      : `Today is ${todayLabel}.`,
    "",
    ...sectionLines("Still to do:", dueRows),
    ...sectionLines("Planned today:", unknownRows),
    ...sectionLines("Already completed:", completedRows),
    ...sectionLines(
      unmatchedCompleted.length ? "Other training logged today:" : "",
      unmatchedCompleted,
      (session) => formatSessionCoachLine(session) || formatCompletedSessionFact(session) || "Completed session"
    ).filter(Boolean),
    ...sectionLines("Skipped:", skippedRows),
    ...sectionLines("Moved or rescheduled:", movedRows),
    "",
    "Do only the remaining planned work. Do not repeat anything already completed.",
  ].join("\n");
}

function shouldForegroundTodayContext(message) {
  const text = normaliseText(message);
  if (!text) return false;
  const intent = latestUserIntentHint(text);
  if (["limited_time", "readiness_recovery", "schedule_reschedule"].includes(intent)) {
    return true;
  }
  if (
    text.includes("today") ||
    text.includes("tonight") ||
    text.includes("this morning") ||
    text.includes("this afternoon") ||
    text.includes("current session") ||
    text.includes("current workout") ||
    text.includes("today's session") ||
    text.includes("todays session") ||
    text.includes("today's workout") ||
    text.includes("todays workout") ||
    text.includes("what should i train") ||
    text.includes("what do i have")
  ) {
    return true;
  }
  return false;
}

function shouldUseBroadAdviceContext(message) {
  const text = normaliseText(message);
  if (!text) return false;
  return latestUserIntentHint(text) === "general_training_advice" && !shouldForegroundTodayContext(text);
}

function buildLiveContextFacts(context, latestUserText = "") {
  const lines = [];
  const clock = context?.clock || null;
  const training = context?.training || {};
  const foregroundToday = shouldForegroundTodayContext(latestUserText);
  const broadAdviceContext = shouldUseBroadAdviceContext(latestUserText);
  const todaySchedule = Array.isArray(training?.todaySchedule)
    ? training.todaySchedule.filter(Boolean)
    : [];
  const currentWeekSchedule = Array.isArray(training?.currentWeekSchedule)
    ? training.currentWeekSchedule.filter(Boolean)
    : [];
  const activePlans = Array.isArray(training?.activePlans)
    ? training.activePlans.filter(Boolean)
    : [];
  const garminActivities = training?.garminActivities || null;
  const lastCompletedSession = training?.lastCompletedSession || null;
  const recentCompletedSessions = Array.isArray(training?.recentCompletedSessions)
    ? training.recentCompletedSessions.filter(Boolean)
    : [];
  const recentGarmin = Array.isArray(garminActivities?.recent)
    ? garminActivities.recent.filter(Boolean)
    : [];

  if (clock?.todayLabel || clock?.localTime || clock?.timezone) {
    lines.push(
      [
        "Local now:",
        clock?.todayLabel || null,
        clock?.localTime ? `at ${clock.localTime}` : null,
        clock?.timezone ? `(${clock.timezone})` : null,
      ]
        .filter(Boolean)
        .join(" ")
    );
  }

  if (activePlans.length) {
    lines.push(
      `Active plans: ${activePlans
        .map((plan) =>
          [plan?.name || "Plan", plan?.kind ? `(${plan.kind})` : null]
            .filter(Boolean)
            .join(" ")
        )
        .join(" | ")}`
    );
  }

  if (broadAdviceContext) {
    lines.push(
      "Broad advice mode: answer the user's training topic directly. Today, tomorrow, week schedule, recent sessions, and nutrition context are intentionally not foregrounded."
    );
    return lines.join("\n");
  }

  if (todaySchedule.length && foregroundToday) {
    const completedToday = todayCompletedSessions(training, clock);
    const { rows } = buildTodaySessionState(todaySchedule, completedToday);
    lines.push(`Today's sessions: ${rows.map(formatTodayRow).join(" | ")}`);
  } else if (todaySchedule.length) {
    lines.push(
      "Today/session context exists in USER_CONTEXT_JSON but is background only for this latest question; do not open with today's session, do not summarise it, and mention it only if directly relevant after answering the user's topic."
    );
  } else if (clock?.todayLabel && foregroundToday) {
    lines.push("Today's sessions: none scheduled in the loaded plan.");
  }

  if (currentWeekSchedule.length) {
    lines.push(
      `This week: ${currentWeekSchedule
        .slice(0, 10)
        .map((item) => formatSessionDetail(item, { includeDate: true }))
        .join(" | ")}`
    );
  }

  if (lastCompletedSession || recentCompletedSessions.length) {
    const last = lastCompletedSession || recentCompletedSessions[0];
    const lastFact = formatCompletedSessionFact(last);
    if (lastFact) {
      lines.push(`Last completed app session: ${lastFact}`);
    }
    if (recentCompletedSessions.length > 1) {
      lines.push(
        `Recent completed app sessions: ${recentCompletedSessions
          .slice(0, 5)
          .map(formatCompletedSessionFact)
          .filter(Boolean)
          .join(" | ")}`
      );
    }
  }

  if (garminActivities?.storedCount || recentGarmin.length) {
    const last7 = garminActivities?.last7d || {};
    const summary = [
      `${garminActivities.storedCount || recentGarmin.length} stored Garmin activities`,
      last7.count ? `${last7.count} in the last 7 days` : null,
      last7.distanceKm ? `${last7.distanceKm} km in 7 days` : null,
      last7.durationMin ? `${last7.durationMin} min in 7 days` : null,
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(`Garmin activity history: ${summary}.`);
    if (recentGarmin.length) {
      lines.push(
        `Recent Garmin activities: ${recentGarmin
          .slice(0, 6)
          .map((item) =>
            [
              item?.date || item?.startIso || null,
              item?.name || item?.type || "Garmin activity",
              item?.distanceKm ? `${item.distanceKm} km` : null,
              item?.durationMin ? `${item.durationMin} min` : null,
              item?.averageHeartRate ? `${item.averageHeartRate} bpm avg HR` : null,
            ]
              .filter(Boolean)
              .join(" · ")
          )
          .join(" | ")}`
      );
    }
  }

  return lines.filter(Boolean).join("\n");
}

const URGENT_TRAINING_SAFETY_REPLY =
  "Stop training immediately. Chest pain with dizziness can be serious. Do not continue the workout. If symptoms are severe, unusual, or do not settle quickly, seek urgent medical help or call emergency services.";

const COMMON_TRAINING_INJURY_REPLIES = {
  knee:
    "Don't push through knee pain. Stop or reduce running for now, switch to low-impact work such as cycling/walking if pain-free, and keep any strength work controlled. If the pain is sharp, worsening, swollen, changes your gait, or doesn't improve with rest, get it checked by a physio or medical professional.",
  ankle:
    "Don't push through ankle pain. Stop or reduce running for now, switch to low-impact work such as cycling or walking only if pain-free, and avoid anything that changes your stride. If the pain is sharp, worsening, swollen, affects your gait, or doesn't improve with rest, get it checked by a physio or medical professional.",
  shin:
    "Don't push through shin pain. Reduce or stop running for now, avoid hard surfaces and speed work, and use pain-free low-impact training instead. If the pain is sharp, worsening, localised, swollen, or doesn't improve with rest, get it checked by a physio or medical professional.",
  back:
    "Don't push through back pain during lifting. Stop heavy pulls or loaded movements for now, keep any movement controlled and pain-free, and avoid forcing range or load. If the pain is sharp, worsening, travels down your leg, causes weakness/numbness, or doesn't improve with rest, get it checked by a physio or medical professional.",
  shoulder:
    "Don't push through shoulder pain when pressing. Stop or reduce pressing for now, use pain-free ranges only, and keep any upper-body strength work controlled. If the pain is sharp, worsening, unstable, swollen, or doesn't improve with rest, get it checked by a physio or medical professional.",
  general:
    "Don't push through pain during exercise. Stop or reduce the painful movement for now, switch to pain-free low-impact work if appropriate, and keep any training controlled. If the pain is sharp, worsening, swollen, changes how you move, or doesn't improve with rest, get it checked by a physio or medical professional.",
};

function isUrgentTrainingSafetyPrompt(text) {
  const hasTrainingContext =
    text.includes("training") ||
    text.includes("train") ||
    text.includes("workout") ||
    text.includes("exercise") ||
    text.includes("running") ||
    text.includes("run") ||
    text.includes("session") ||
    text.includes("keep going") ||
    text.includes("continue");
  const hasChestPain =
    text.includes("chest pain") ||
    text.includes("chest hurts") ||
    text.includes("chest hurt") ||
    text.includes("chest tight") ||
    text.includes("tight chest") ||
    text.includes("chest tightness") ||
    text.includes("chest pressure") ||
    text.includes("pressure in my chest") ||
    text.includes("pressure in chest");
  const hasDizziness =
    text.includes("dizzy") ||
    text.includes("dizziness") ||
    text.includes("lightheaded") ||
    text.includes("light headed");
  const hasFaintingOrCollapse =
    text.includes("fainting") ||
    text.includes("fainted") ||
    text.includes("faint") ||
    text.includes("pass out") ||
    text.includes("passing out") ||
    text.includes("black out") ||
    text.includes("blacking out") ||
    text.includes("collapse") ||
    text.includes("collapsed");
  const hasSevereBreathing =
    text.includes("severe shortness of breath") ||
    text.includes("very short of breath") ||
    text.includes("can't breathe") ||
    text.includes("cant breathe") ||
    text.includes("struggling to breathe") ||
    text.includes("severe breathlessness");
  const hasSevereExerciseSymptoms =
    hasTrainingContext &&
    text.includes("severe") &&
    (text.includes("symptom") ||
      text.includes("pain") ||
      text.includes("breath") ||
      text.includes("dizzy"));

  return (
    (hasChestPain && (hasDizziness || hasTrainingContext)) ||
    (hasDizziness && hasFaintingOrCollapse) ||
    hasFaintingOrCollapse ||
    hasSevereBreathing ||
    hasSevereExerciseSymptoms
  );
}

function hasNegatedPainSignal(text) {
  return (
    text.includes("no pain") ||
    text.includes("not in pain") ||
    text.includes("without pain") ||
    text.includes("doesn't hurt") ||
    text.includes("doesnt hurt") ||
    text.includes("does not hurt")
  );
}

function hasTrainingPainSignal(text) {
  return (
    text.includes("pain") ||
    text.includes("hurts") ||
    text.includes("hurt") ||
    text.includes("ache") ||
    text.includes("aches") ||
    text.includes("sore") ||
    text.includes("injury") ||
    text.includes("injured")
  );
}

function hasCommonTrainingContext(text) {
  return (
    text.includes("run") ||
    text.includes("running") ||
    text.includes("train") ||
    text.includes("training") ||
    text.includes("workout") ||
    text.includes("exercise") ||
    text.includes("lifting") ||
    text.includes("lift") ||
    text.includes("deadlift") ||
    text.includes("squat") ||
    text.includes("press") ||
    text.includes("pressing") ||
    text.includes("during") ||
    text.includes("when i")
  );
}

function commonTrainingInjuryReply(text) {
  if (!hasTrainingPainSignal(text) || hasNegatedPainSignal(text)) return null;

  const hasTrainingContext = hasCommonTrainingContext(text);
  const hasKnee = text.includes("knee");
  const hasAnkle = text.includes("ankle");
  const hasShin = text.includes("shin");
  const hasBack = text.includes("back") || text.includes("lower back");
  const hasShoulder = text.includes("shoulder") || text.includes("rotator cuff");

  if (hasKnee && (hasTrainingContext || text.includes("runner"))) {
    return COMMON_TRAINING_INJURY_REPLIES.knee;
  }

  if (hasAnkle && hasTrainingContext) {
    return COMMON_TRAINING_INJURY_REPLIES.ankle;
  }

  if (hasShin && hasTrainingContext) {
    return COMMON_TRAINING_INJURY_REPLIES.shin;
  }

  if (hasBack && hasTrainingContext) {
    return COMMON_TRAINING_INJURY_REPLIES.back;
  }

  if (hasShoulder && hasTrainingContext) {
    return COMMON_TRAINING_INJURY_REPLIES.shoulder;
  }

  const asksAboutPainDuringExercise =
    (text.includes("pain during") ||
      text.includes("hurts during") ||
      text.includes("hurt during") ||
      text.includes("pain when i") ||
      text.includes("hurts when i") ||
      text.includes("hurt when i")) &&
    hasTrainingContext;

  if (asksAboutPainDuringExercise) {
    return COMMON_TRAINING_INJURY_REPLIES.general;
  }

  return null;
}

function isMissedSessionPrompt(text) {
  const mentionsSession =
    text.includes("session") ||
    text.includes("workout") ||
    text.includes("training") ||
    text.includes("run") ||
    text.includes("gym");
  const missedSignal =
    text.includes("missed") ||
    text.includes("miss ") ||
    text.includes("skipped") ||
    text.includes("skip ") ||
    text.includes("couldn't do") ||
    text.includes("couldnt do") ||
    text.includes("didn't do") ||
    text.includes("didnt do") ||
    text.includes("did not do");

  return mentionsSession && missedSignal;
}

function isAiLedTrainingAdjustmentPrompt(text) {
  const tiredSignal =
    text.includes("tired") ||
    text.includes("fatigued") ||
    text.includes("exhausted") ||
    text.includes("sore") ||
    text.includes("slept badly") ||
    text.includes("bad sleep") ||
    text.includes("poor sleep");
  const limitedTimeSignal =
    (text.includes("only have") ||
      text.includes("only got") ||
      text.includes("limited time") ||
      text.includes("short on time")) &&
    /\b\d+\s*(?:min|mins|minute|minutes)\b/.test(text);
  const moveSignal =
    text.includes("move today's session") ||
    text.includes("move todays session") ||
    text.includes("move my session") ||
    text.includes("reschedule today's session") ||
    text.includes("reschedule todays session") ||
    text.includes("reschedule my session");

  return tiredSignal || limitedTimeSignal || moveSignal;
}

function buildMissedSessionAdvice({ clock, training, todaySchedule }) {
  const todayLabel = clock?.todayLabel || "today";
  const completedToday = todayCompletedSessions(training, clock || {});
  const { rows, unmatchedCompleted } = buildTodaySessionState(todaySchedule, completedToday);
  const completedRows = rows.filter((row) => row.status === "completed");
  const remainingRows = rows.filter((row) =>
    ["due", "in_progress", "unknown"].includes(row.status)
  );
  const skippedRows = rows.filter((row) => row.status === "skipped");
  const completedEvidence = completedRows.length ? completedRows : unmatchedCompleted;

  if (completedEvidence.length && !remainingRows.length) {
    return [
      `It looks like today's ${formatInlineSessionNames(completedEvidence)} session is marked as completed. If that's right, you don't need to make it up.`,
      "",
      "If you meant a different session or the log is wrong, don't double up aggressively. Either do a shorter controlled version, move it to tomorrow, or continue with the next planned session.",
    ].join("\n");
  }

  if (completedEvidence.length && remainingRows.length) {
    return [
      `It looks like you've completed ${formatInlineSessionNames(completedEvidence)} today, but ${formatInlineSessionNames(remainingRows)} still appears planned or not confirmed.`,
      "",
      "If that is the session you missed, don't double up aggressively. Do a shorter controlled version, move it to tomorrow, or continue with the next planned session.",
    ].join("\n");
  }

  if (remainingRows.length) {
    return [
      `If you missed today's ${formatInlineSessionNames(remainingRows)} session, don't double up aggressively.`,
      "",
      "Either do a shorter controlled version, move it to tomorrow, or continue with the next planned session. Keep the next 24 hours controlled rather than trying to force the work back in.",
    ].join("\n");
  }

  if (skippedRows.length) {
    return [
      `Today's ${formatInlineSessionNames(skippedRows)} session is marked as skipped.`,
      "",
      "Don't double up aggressively. Either move it to tomorrow if it still fits, or continue with the next planned session and keep the week controlled.",
    ].join("\n");
  }

  return [
    `I don't see a planned session for ${todayLabel}.`,
    "",
    "If you missed a workout, don't double up aggressively. Either do a shorter controlled version, move it to tomorrow, or continue with the next planned session.",
  ].join("\n");
}

function tryDeterministicCoachReply(message, context) {
  const text = normaliseText(message);
  if (!text) return null;

  if (isUrgentTrainingSafetyPrompt(text)) {
    return URGENT_TRAINING_SAFETY_REPLY;
  }

  const clock = context?.clock || null;
  const training = context?.training || {};
  const activePlans = Array.isArray(training?.activePlans)
    ? training.activePlans.filter(Boolean)
    : [];
  const todaySchedule = Array.isArray(training?.todaySchedule)
    ? training.todaySchedule.filter(Boolean)
    : [];
  const currentWeekSchedule = Array.isArray(training?.currentWeekSchedule)
    ? training.currentWeekSchedule.filter(Boolean)
    : [];

  const asksDay =
    text.includes("what day is it") ||
    text.includes("what day is today") ||
    text.includes("what's the day");
  const asksDate =
    text.includes("what date is it") ||
    text.includes("what's the date") ||
    text.includes("what is the date");
  const asksTime =
    text.includes("what time is it") ||
    text.includes("what's the time") ||
    text.includes("what is the time now");

  if ((asksDay || asksDate || asksTime) && clock) {
    const lines = [];
    if (clock?.todayLabel) lines.push(`It is ${clock.todayLabel}.`);
    if (asksTime && clock?.localTime) lines.push(`Local time is ${clock.localTime}.`);
    if (clock?.timezone) lines.push(`Timezone: ${clock.timezone}.`);
    return lines.filter(Boolean).join("\n");
  }

  if (latestUserIntentHint(text) === "schedule_reschedule") {
    return null;
  }

  const asksAlreadyTrainedToday =
    text.includes("already trained") ||
    text.includes("already completed") ||
    text.includes("completed today") ||
    text.includes("done today") ||
    text.includes("did i train today") ||
    text.includes("have i trained today") ||
    text.includes("have i already trained") ||
    text.includes("have i already completed");

  const asksShouldStillDoTodayWorkout =
    text.includes("should i still") ||
    text.includes("still do today") ||
    text.includes("do today's workout") ||
    text.includes("do todays workout") ||
    text.includes("repeat today") ||
    userStatesCompletedPremise(text);

  if (asksAlreadyTrainedToday || asksShouldStillDoTodayWorkout) {
    return buildTodayPlanReply({ text, clock: clock || {}, training, todaySchedule });
  }

  if (isAiLedTrainingAdjustmentPrompt(text)) {
    return null;
  }

  if (isActivePlanQuestion(text)) {
    return buildActivePlanReply({
      clock: clock || {},
      training,
      currentWeekSchedule,
      todaySchedule,
      context,
    });
  }

  const asksTodayPlan =
    text.includes("what should i train") ||
    text.includes("what do i have today") ||
    text.includes("what training do i have today") ||
    text.includes("what workout do i have today") ||
    text.includes("what session do i have today") ||
    text.includes("what is today's session") ||
    text.includes("what's today's session") ||
    text.includes("what is todays session") ||
    text.includes("what's todays session") ||
    text.includes("what is today's workout") ||
    text.includes("what's today's workout") ||
    text.includes("what is todays workout") ||
    text.includes("what's todays workout") ||
    text.includes("what's on today") ||
    text.includes("what is on today");

  if (asksTodayPlan) {
    return buildTodayPlanReply({ text, clock: clock || {}, training, todaySchedule });
  }

  const asksThisWeek =
    (text.includes("this week") &&
      (text.includes("session") ||
        text.includes("workout") ||
        text.includes("training") ||
        text.includes("plan") ||
        text.includes("have") ||
        text.includes("show"))) ||
    text.includes("sessions do i have this week") ||
    text.includes("week looking like") ||
    text.includes("weekly plan") ||
    text.includes("week's plan");

  if (asksThisWeek && clock) {
    return buildCompactWeekOverview(currentWeekSchedule, clock);
  }

  const weekdayMatch = Object.keys(WEEKDAY_INDEX).find((day) => text.includes(day));
  const asksSpecificDay =
    !!weekdayMatch &&
    (text.includes("what do i have") ||
      text.includes("what session") ||
      text.includes("what workout") ||
      text.includes("what training") ||
      text.includes("on "));

  if (asksSpecificDay) {
    const dayIndex = WEEKDAY_INDEX[weekdayMatch];
    const daySessions = currentWeekSchedule.filter(
      (item) => Number(item?.dayIndex) === dayIndex
    );

    if (!daySessions.length) {
      return [
        `I do not have a scheduled session for ${weekdayMatch[0].toUpperCase()}${weekdayMatch.slice(1)} in the loaded current week.`,
        "",
        "Treat it as recovery unless you manually add or move a session.",
      ].join("\n");
    }

    return [
      `On ${weekdayMatch[0].toUpperCase()}${weekdayMatch.slice(1)}, you have:`,
      ...daySessions.map((item) => `- ${formatSessionCoachLine(item, { includeDate: true })}`),
      "",
      "Stick to the target unless your recovery says otherwise.",
    ].join("\n");
  }

  return null;
}

function deterministicResponseSource(message) {
  const text = normaliseText(message);
  if (isUrgentTrainingSafetyPrompt(text)) return "deterministic_safety";
  if (
    text.includes("already trained") ||
    text.includes("already completed") ||
    text.includes("completed today") ||
    text.includes("done today") ||
    text.includes("did i train today") ||
    text.includes("have i trained today") ||
    text.includes("have i already trained") ||
    text.includes("have i already completed") ||
    text.includes("should i still") ||
    text.includes("still do today") ||
    text.includes("do today's workout") ||
    text.includes("do todays workout") ||
    text.includes("repeat today") ||
    userStatesCompletedPremise(text) ||
    text.includes("what should i train") ||
    text.includes("what do i have today") ||
    text.includes("what training do i have today") ||
    text.includes("what workout do i have today") ||
    text.includes("what session do i have today") ||
    text.includes("what is today's session") ||
    text.includes("what's today's session") ||
    text.includes("what is todays session") ||
    text.includes("what's todays session") ||
    text.includes("what is today's workout") ||
    text.includes("what's today's workout") ||
    text.includes("what is todays workout") ||
    text.includes("what's todays workout") ||
    text.includes("what's on today") ||
    text.includes("what is on today")
  ) {
    return "deterministic_status";
  }
  return "deterministic_summary";
}

export function __coachChatDeterministicReplyForTest(message, context) {
  return tryDeterministicCoachReply(message, context);
}

export function __coachChatLatestPriorityForTest(messages) {
  const trimmedMessages = (Array.isArray(messages) ? messages : [])
    .filter(
      (message) =>
        (message?.role === "user" || message?.role === "assistant") &&
        typeof message?.content === "string" &&
        message.content.trim()
    )
    .map((message) => ({
      role: message.role,
      content: String(message.content || "").trim(),
    }));
  const latestUserText = latestUserMessage(trimmedMessages);

  return {
    latestUserText,
    intent: latestUserIntentHint(latestUserText),
    instruction: latestUserPriorityInstruction(latestUserText),
    previousConversationContext: buildRecentConversationContext(
      trimmedMessages,
      latestUserText,
      8
    ),
  };
}

export function __coachChatLocalFallbackForTest(message, context) {
  return buildLocalCoachFallbackReply(message, context);
}

export function __coachChatRouteFallbackForTest(message, context, error = null) {
  return buildCoachChatFallbackResponse(message, context, error);
}

export function __coachChatNutritionDraftForTest(message) {
  return createNutritionDraftFromText(message);
}

export function __coachChatMemorySaveForTest(message) {
  return buildMemorySaveResponse(message);
}

export function __coachChatResponseDiagnosticsForTest({
  responseSource,
  latestUserText,
  context,
  openAiError = null,
}) {
  return coachResponseDiagnostics({
    responseSource,
    latestUserText,
    context,
    openAiError,
  });
}

export function __coachChatReplyPolicyViolationForTest(reply, latestUserText, context = null) {
  return coachChatReplyPolicyViolation(reply, latestUserText, context);
}

export function __coachChatLiveContextFactsForTest(context, latestUserText = "") {
  return buildLiveContextFacts(context, latestUserText);
}

export function __coachChatForegroundsTodayForTest(message) {
  return shouldForegroundTodayContext(message);
}

export function __coachChatContextForLatestMessageForTest(
  context,
  latestUserText = "",
  compact = false
) {
  return contextForLatestMessage(context, null, latestUserText, compact);
}

function safeStringify(value, maxChars = 16000) {
  try {
    const json = JSON.stringify(value, null, 2);
    if (json.length <= maxChars) return json;
    return `${json.slice(0, maxChars)}\n... [truncated]`;
  } catch {
    return "";
  }
}

function byteSize(value) {
  try {
    return Buffer.byteLength(
      typeof value === "string" ? value : JSON.stringify(value ?? null),
      "utf8"
    );
  } catch {
    return 0;
  }
}

function openAIErrorInfo(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    status: error?.status || error?.response?.status || null,
    code: error?.code || error?.error?.code || null,
    type: error?.type || error?.error?.type || null,
  };
}

function hasCoachMemoryContext(context) {
  const memory = context?.athleteProfile?.coachMemory;
  return Array.isArray(memory)
    ? memory.some((item) => item?.text || item?.category)
    : !!memory;
}

function hasActivePlanContext(context) {
  const training = context?.training || {};
  return !!(
    context?.activePlanSummary ||
    training?.activePlan ||
    (Array.isArray(training?.activePlans) && training.activePlans.length)
  );
}

function hasNutritionContext(context) {
  return !!context?.nutrition;
}

function hasTodaySessionContext(context) {
  const training = context?.training || {};
  return !!(
    training?.todaySession ||
    (Array.isArray(training?.todaySchedule) && training.todaySchedule.length)
  );
}

function addDaysIso(isoDate, days) {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate))) return null;
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function sessionMatchesIsoDate(session, isoDate) {
  if (!session || !isoDate) return false;
  return [
    session?.isoDate,
    session?.date,
    session?.dateKey,
    session?.scheduledDate,
    session?.startDate,
  ].some((value) => String(value || "").slice(0, 10) === isoDate);
}

function hasTomorrowSessionContext(context) {
  const training = context?.training || {};
  const tomorrowIso = addDaysIso(context?.clock?.todayIso, 1);
  if (
    training?.tomorrowSession ||
    (Array.isArray(training?.tomorrowSchedule) && training.tomorrowSchedule.length)
  ) {
    return true;
  }
  return ["currentWeekSchedule", "exactSchedule", "upcomingSessions"].some((key) =>
    Array.isArray(training?.[key])
      ? training[key].some((session) => sessionMatchesIsoDate(session, tomorrowIso))
      : false
  );
}

function coachResponseDiagnostics({
  responseSource,
  latestUserText,
  context,
  previousConversationHas30MinPrompt = false,
  openAiError = null,
}) {
  const highPriorityContext = contextForLatestMessage(context, null, latestUserText, false);
  return {
    latestUserMessage: String(latestUserText || "").slice(0, 240),
    responseSource,
    detectedIntent: latestUserIntentHint(latestUserText),
    foregroundTodayContext: shouldForegroundTodayContext(latestUserText),
    nutritionContextIncluded: hasNutritionContext(highPriorityContext),
    todaySessionIncludedInHighPriorityContext: hasTodaySessionContext(highPriorityContext),
    tomorrowSessionIncludedInHighPriorityContext: hasTomorrowSessionContext(highPriorityContext),
    coachMemoryIncluded: hasCoachMemoryContext(context),
    previousConversationHas30MinPrompt: !!previousConversationHas30MinPrompt,
    responsePath: responseSource?.startsWith("ai")
      ? "ai"
      : responseSource === "local_fallback"
        ? "fallback"
        : "deterministic_or_action",
    activePlanIncluded: hasActivePlanContext(context),
    latestMessagePrioritised: true,
    openAiFailed: !!openAiError,
    openAiError: openAiError ? openAIErrorInfo(openAiError) : null,
  };
}

function logCoachResponse(diagnostics) {
  console.info("[coach-chat] response", diagnostics);
}

function withCoachResponseMetadata(payload, diagnostics) {
  const base = payload && typeof payload === "object" ? payload : {};
  let rawObject = null;
  if (typeof base.raw === "string" && base.raw.trim()) {
    try {
      rawObject = JSON.parse(base.raw);
    } catch {
      rawObject = { raw: base.raw };
    }
  }
  const enrichedRaw = {
    ...(rawObject || {
      reply: base.reply || "",
      updatedPlan: base.updatedPlan || null,
      nutritionDraft: base.nutritionDraft || null,
      coachActions: base.coachActions || [],
    }),
    responseSource: diagnostics.responseSource,
    detectedIntent: diagnostics.detectedIntent,
    latestUserMessage: diagnostics.latestUserMessage,
    foregroundTodayContext: diagnostics.foregroundTodayContext,
    nutritionContextIncluded: diagnostics.nutritionContextIncluded,
    todaySessionIncludedInHighPriorityContext:
      diagnostics.todaySessionIncludedInHighPriorityContext,
    tomorrowSessionIncludedInHighPriorityContext:
      diagnostics.tomorrowSessionIncludedInHighPriorityContext,
    coachMemoryIncluded: diagnostics.coachMemoryIncluded,
    previousConversationHas30MinPrompt: diagnostics.previousConversationHas30MinPrompt,
    responsePath: diagnostics.responsePath,
    activePlanIncluded: diagnostics.activePlanIncluded,
    latestMessagePrioritised: diagnostics.latestMessagePrioritised,
    openAiFailed: diagnostics.openAiFailed,
    openAiError: diagnostics.openAiError,
  };

  return {
    ...base,
    responseSource: diagnostics.responseSource,
    detectedIntent: diagnostics.detectedIntent,
    raw: JSON.stringify(enrichedRaw),
  };
}

function sendCoachResponse(res, payload, diagnosticsInput) {
  const diagnostics = coachResponseDiagnostics(diagnosticsInput);
  const responsePayload = withCoachResponseMetadata(payload, diagnostics);
  logCoachResponse({
    ...diagnostics,
    responsePreview: String(responsePayload?.reply || "").slice(0, 220),
  });
  return res.json(responsePayload);
}

function compactCoachContext(context, planSummary = null) {
  const training = context?.training || {};
  const nutrition = context?.nutrition || {};
  const athleteProfile = context?.athleteProfile || {};

  return {
    clock: context?.clock || null,
    activePlanSummary: context?.activePlanSummary || planSummary || null,
    athleteProfile: {
      goal: athleteProfile?.goal || athleteProfile?.primaryGoal || null,
      injuries: athleteProfile?.injuries || athleteProfile?.constraints || null,
      coachMemory: athleteProfile?.coachMemory || null,
    },
    training: {
      todaySession: training?.todaySession || null,
      todaySchedule: normaliseList(training?.todaySchedule).slice(0, 4),
      currentWeekSchedule: normaliseList(training?.currentWeekSchedule).slice(0, 10),
      recentCompletedSessions: normaliseList(training?.recentCompletedSessions).slice(0, 6),
      lastCompletedSession: training?.lastCompletedSession || null,
    },
    nutrition: nutrition
      ? {
          targets: nutrition?.targets || nutrition?.dailyTargets || null,
          today: nutrition?.today || nutrition?.todayTotals || nutrition?.currentDay || null,
        }
      : null,
  };
}

function clonePlainObject(value) {
  if (!value || typeof value !== "object") return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function isNutritionIntentHint(intent) {
  return [
    "post_training_nutrition",
    "fat_loss_performance",
    "protein_target",
    "pre_run_fuelling",
    "general_nutrition",
  ].includes(intent);
}

function shouldIncludeNutritionContext(latestUserText) {
  return isNutritionIntentHint(latestUserIntentHint(latestUserText));
}

function latestMentionsInjuryMemoryTopic(latestUserText) {
  const latest = normaliseText(latestUserText);
  if (!latest) return false;
  return (
    latest.includes("knee") ||
    latest.includes("hill") ||
    latest.includes("hills") ||
    latest.includes("injury") ||
    latest.includes("injured") ||
    latest.includes("pain") ||
    latest.includes("sore") ||
    latest.includes("soreness") ||
    latest.includes("terrain") ||
    latest.includes("downhill") ||
    latest.includes("uphill") ||
    latest.includes("running risk") ||
    latest.includes("risk of injury") ||
    latest.includes("injury risk") ||
    latest.includes("without getting injured") ||
    latest.includes("without injury") ||
    latest.includes("speed safely") ||
    latest.includes("build speed safely")
  );
}

function latestMentionsMorningTimingTopic(latestUserText) {
  const latest = normaliseText(latestUserText);
  if (!latest) return false;
  return (
    latest.includes("schedule") ||
    latest.includes("when should") ||
    latest.includes("best time") ||
    latest.includes("what time") ||
    latest.includes("time of day") ||
    latest.includes("morning") ||
    latest.includes("evening") ||
    latest.includes("routine") ||
    latest.includes("hard session") ||
    latest.includes("harder session") ||
    latest.includes("quality session") ||
    latest.includes("when to train")
  );
}

function filterCoachMemoryForLatestMessage(memory, latestUserText) {
  const recallRequest = /\b(?:remember|memory|memories)\b|what (?:do you know|did i tell you) about me/i.test(latestUserText);
  const eligible = (Array.isArray(memory) ? memory : []).filter(item => {
    const injury = /knee|hill|injur|pain|sore|terrain/i.test(String(item?.text || ''));
    return !injury || recallRequest || latestMentionsInjuryMemoryTopic(latestUserText);
  });
  return selectMemories(eligible, latestUserText);
}

function isCasualMorningPreferenceStatement(text) {
  const clean = normaliseText(text);
  if (!clean) return false;
  if (extractMemorySaveText(clean)) return false;
  return (
    /\b(?:i\s+)?(?:usually|often|generally|normally)?\s*(?:feel|train|perform|run|lift)\s+(?:better|best|good|stronger)\b/.test(clean) &&
    clean.includes("morning")
  );
}

function isReadinessRecoveryPrompt(text) {
  const clean = normaliseText(text);
  if (!clean) return false;
  return (
    clean.includes("tired") ||
    clean.includes("fatigued") ||
    clean.includes("fatigue") ||
    clean.includes("slept badly") ||
    clean.includes("bad sleep") ||
    clean.includes("poor sleep") ||
    clean.includes("run down") ||
    clean.includes("rundown") ||
    clean.includes("feel flat") ||
    clean.includes("feeling flat") ||
    clean.includes("legs feel heavy") ||
    clean.includes("heavy legs") ||
    clean.includes("legs are heavy") ||
    clean.includes("feel heavy") ||
    clean.includes("low energy") ||
    clean.includes("drained") ||
    clean.includes("worn out") ||
    clean.includes("beat up") ||
    clean.includes("sore")
  );
}

function contextForLatestMessage(context, planSummary = null, latestUserText = "", compact = false) {
  const base = compact ? compactCoachContext(context, planSummary) : clonePlainObject(context || {});
  const shaped = clonePlainObject(base || {});

  if (!shouldIncludeNutritionContext(latestUserText)) {
    delete shaped.nutrition;
  }

  const coachMemory = shaped?.athleteProfile?.coachMemory;
  if (Array.isArray(coachMemory)) {
    const relevantMemory = filterCoachMemoryForLatestMessage(coachMemory, latestUserText);
    shaped.athleteProfile = {
      ...(shaped.athleteProfile || {}),
      coachMemory: relevantMemory,
    };
  }

  if (shouldUseBroadAdviceContext(latestUserText)) {
    const training = shaped?.training || {};
    const activePlanBackground = {};
    if (training?.activePlan) activePlanBackground.activePlan = training.activePlan;
    if (Array.isArray(training?.activePlans) && training.activePlans.length) {
      activePlanBackground.activePlans = training.activePlans.slice(0, 3);
    }
    shaped.training = activePlanBackground;
  }

  return shaped;
}

function planForLatestMessage(plan, planSummary = null, latestUserText = "", compact = false) {
  if (compact || shouldUseBroadAdviceContext(latestUserText)) {
    return compactPlanForCoach(plan, planSummary);
  }
  return plan;
}

function compactPlanForCoach(plan, planSummary = null) {
  if (!plan) return null;
  if (planSummary) return planSummary;
  return summarisePlan(plan) || {
    name: plan?.name || plan?.title || null,
    primaryActivity: plan?.primaryActivity || plan?.kind || null,
  };
}

function latestUserIntentHint(text) {
  const clean = normaliseText(text);
  if (extractMemorySaveText(clean)) {
    return "memory_save";
  }

  const mentionsSessionOrWorkout =
    clean.includes("session") ||
    clean.includes("workout") ||
    clean.includes("run") ||
    clean.includes("training") ||
    clean.includes("it");
  if (
    clean.includes("move today's session") ||
    clean.includes("move todays session") ||
    clean.includes("move my session") ||
    clean.includes("move workout") ||
    clean.includes("move my workout") ||
    clean.includes("move my run") ||
    clean.includes("reschedule") ||
    clean.includes("shift session") ||
    clean.includes("shift my session") ||
    clean.includes("shift workout") ||
    clean.includes("shift my run") ||
    clean.includes("do today's workout tomorrow") ||
    clean.includes("do todays workout tomorrow") ||
    clean.includes("do today's session tomorrow") ||
    clean.includes("do todays session tomorrow") ||
    (mentionsSessionOrWorkout && clean.includes("instead") && clean.includes("tomorrow")) ||
    (mentionsSessionOrWorkout && clean.includes("to friday")) ||
    (mentionsSessionOrWorkout && clean.includes("to monday")) ||
    (mentionsSessionOrWorkout && clean.includes("to tuesday")) ||
    (mentionsSessionOrWorkout && clean.includes("to wednesday")) ||
    (mentionsSessionOrWorkout && clean.includes("to thursday")) ||
    (mentionsSessionOrWorkout && clean.includes("to saturday")) ||
    (mentionsSessionOrWorkout && clean.includes("to sunday"))
  ) {
    return "schedule_reschedule";
  }

  if (
    clean.includes("when should i schedule") ||
    clean.includes("when should i do") ||
    clean.includes("when should i plan") ||
    clean.includes("best time") ||
    clean.includes("best day") ||
    clean.includes("what time should") ||
    clean.includes("what day should") ||
    clean.includes("schedule my harder") ||
    clean.includes("schedule hard") ||
    clean.includes("harder sessions") ||
    clean.includes("hard sessions") ||
    clean.includes("quality sessions") ||
    clean.includes("time my workouts") ||
    clean.includes("time my sessions")
  ) {
    return "schedule_timing";
  }

  if (
    clean.includes("lose fat") ||
    clean.includes("fat loss") ||
    clean.includes("drop fat") ||
    clean.includes("body composition") ||
    clean.includes("cut weight") ||
    clean.includes("cutting") ||
    (clean.includes("performance") &&
      (clean.includes("calorie") ||
        clean.includes("deficit") ||
        clean.includes("weight") ||
        clean.includes("fat")))
  ) {
    return "fat_loss_performance";
  }

  if (
    clean.includes("hit my protein") ||
    clean.includes("protein target") ||
    clean.includes("protein goal") ||
    clean.includes("enough protein") ||
    clean.includes("more protein")
  ) {
    return "protein_target";
  }

  if (
    clean.includes("before a run") ||
    clean.includes("before my run") ||
    clean.includes("before running") ||
    clean.includes("pre run") ||
    clean.includes("pre-run") ||
    clean.includes("before speed") ||
    clean.includes("before intervals")
  ) {
    return "pre_run_fuelling";
  }

  if (
    clean.includes("after training") ||
    clean.includes("after my workout") ||
    clean.includes("after workout") ||
    clean.includes("post training") ||
    clean.includes("post-training") ||
    clean.includes("post workout") ||
    clean.includes("post-workout")
  ) {
    return "post_training_nutrition";
  }

  if (
    clean.includes("eat") ||
    clean.includes("food") ||
    clean.includes("meal") ||
    clean.includes("nutrition") ||
    clean.includes("protein") ||
    clean.includes("carb") ||
    clean.includes("fuel") ||
    clean.includes("hydrate")
  ) {
    return "general_nutrition";
  }

  if (
    clean.includes("only have") ||
    clean.includes("short on time") ||
    clean.includes("limited time") ||
    /\b\d+\s*(?:min|mins|minute|minutes)\b/.test(clean)
  ) {
    return "limited_time";
  }

  if (isWeeklyFocusQuestion(clean)) {
    return "weekly_focus";
  }

  if (isReadinessRecoveryPrompt(clean)) {
    return "readiness_recovery";
  }

  if (isGeneralTrainingAdviceQuestion(clean)) {
    return "general_training_advice";
  }

  return "general";
}

function buildRecentConversationContext(trimmedMessages, latestUserText, limit = 200) {
  // Only remove the latest turn itself. Topic filters discarded general facts
  // and pronoun follow-ups before the model could resolve their meaning.
  const prior = trimmedMessages.filter((message, index) =>
    !(index === trimmedMessages.length - 1 && message.role === "user") &&
    !isInternalCoachReply(message.content)
  );
  return recentConversation(prior).slice(-limit);
}

function contextBoundaryInstruction(latestUserText) {
  const intent = latestUserIntentHint(latestUserText);
  const includeNutrition = shouldIncludeNutritionContext(latestUserText);
  const foregroundToday = shouldForegroundTodayContext(latestUserText);
  const lines = [
    "CONTEXT_BOUNDARIES:",
    "- The final user message is the task. Other context can personalise the answer, but must not become the answer.",
  ];

  if (!includeNutrition) {
    lines.push(
      "- Nutrition context has been omitted or should be ignored because the latest message is not asking about food, fuelling, macros, body composition, or diet.",
      "- Do not add nutrition, calories, protein, carbs, hydration, or meal advice unless it directly answers the latest message."
    );
  }

  if (!foregroundToday) {
    lines.push(
      "- Today/session context is background only for this latest message.",
      "- Do not open with today's session or turn broad coaching advice into today's workout summary."
    );
  }

  if (isCasualMorningPreferenceStatement(latestUserText)) {
    lines.push(
      "- The latest message is a casual time-of-day preference, not a memory-save command.",
      "- Acknowledge the morning preference and suggest using mornings for harder or higher-focus sessions where possible.",
      "- Do not mention saved injury, knee, hill, pain, soreness, or terrain memory because the latest message is not about those topics.",
      "- Do not return a memory_save action unless the user explicitly asks you to remember, save, note, or keep it in mind."
    );
  }

  if (intent === "general_training_advice") {
    lines.push(
      "- For broad training advice, lead with the training principle and practical drills/progression for the requested topic.",
      "- Saved memory may personalise one short caveat, but must not dominate or change the topic unless the latest message specifically asks about that memory topic.",
      "- Context priority: latest user goal/topic first, relevant plan context second, saved memory as a brief modifier, today/session context only if asked or genuinely needed."
    );
  }

  if (intent === "readiness_recovery") {
    lines.push(
      "- This is a readiness/recovery question. Start with the user's current state, not today's planned session.",
      "- Give conservative decision-making first: easy warm-up check, downgrade if symptoms persist, reduce intensity/volume, or recover.",
      "- Today/session context may be mentioned only after the readiness advice, as a possible modification."
    );
  }

  if (intent === "schedule_timing") {
    lines.push(
      "- This is a scheduling/timing question. Answer when to place harder sessions directly.",
      "- Use relevant saved preferences, such as morning workout preference, when choosing timing.",
      "- Do not answer a previous nutrition, protein, meal, or fuelling topic."
    );
  }

  return lines.join("\n");
}

function previousConversationHasLimitedTimePrompt(trimmedMessages, latestUserText) {
  const latest = String(latestUserText || "").trim();
  return (Array.isArray(trimmedMessages) ? trimmedMessages : []).some((message, index) => {
    if (index === trimmedMessages.length - 1 && message?.role === "user") return false;
    const content = String(message?.content || "").trim();
    if (!content || content === latest) return false;
    const text = normaliseText(content);
    return (
      text.includes("30 minutes") ||
      text.includes("30 mins") ||
      text.includes("only have 30") ||
      text.includes("short on time") ||
      text.includes("limited time")
    );
  });
}

function latestUserPriorityInstruction(latestUserText) {
  const intent = latestUserIntentHint(latestUserText);
  const foregroundToday = shouldForegroundTodayContext(latestUserText);
  const isNutritionIntent = isNutritionIntentHint(intent);
  const lines = [
    "LATEST_USER_MESSAGE_PRIORITY:",
    "- HARD RULE: Answer the latest user message, using earlier turns to resolve follow-ups, references and remembered decisions.",
    "- Answer the latest user message directly.",
    "- Preserve facts and decisions from conversation history while giving the latest ask priority.",
    "- Short follow-ups and pronouns may refer to earlier turns without repeating the topic.",
    "- Answer the latest user intent. Do not reuse the format, topic, or recommendation from the previous assistant reply unless the latest message asks for a follow-up.",
    `- Latest user intent hint: ${intent}.`,
    "- Saved memory relevance rule: knee/hill soreness memory may only influence prompts about knees, hills, injury, pain/soreness, running terrain, uphill/downhill work, or running injury risk.",
    "- Saved memory relevance rule: morning workout preference may only influence prompts about scheduling, time of day, when to train, hard-session placement, or routine.",
  ];

  if (!foregroundToday) {
    lines.push(
      "- The latest message is not primarily asking about today's session. Treat today's session as background context only.",
      "- Do not start by describing today's workout/session.",
      "- Mention today's session only if it genuinely improves the answer after answering the user's actual question."
    );
  }

  if (isNutritionIntent) {
    lines.push(
      "- This is a nutrition question. Answer with food/fuelling guidance first.",
      "- Do not provide a timed mobility, recovery, or workout plan unless the user asks for activity.",
      "- Use training context only to personalise the nutrition advice."
    );
  }

  if (intent === "memory_save") {
    lines.push(
      "- This is an explicit memory-save request. Do not answer with generic coaching advice.",
      "- Return a memory_save coachAction with autoApply true so the app saves it immediately."
    );
  }

  if (isCasualMorningPreferenceStatement(latestUserText)) {
    lines.push(
      "- This is a casual preference statement, not an explicit memory-save command.",
      "- Acknowledge that mornings seem to work better for the user.",
      "- Suggest scheduling harder or higher-focus sessions in the morning where possible.",
      "- Do not create or suggest an auto-applied memory_save action.",
      "- Do not mention knee, hill, pain, soreness, injury, terrain, uphill, or downhill memory unless the latest message asks about those topics."
    );
  }

  if (intent === "post_training_nutrition") {
    lines.push(
      "- This is post-training nutrition. Include protein + carbs + fluids, practical food examples, and a useful protein range when appropriate.",
      "- Do not answer as a general fat-loss strategy unless the user asks about fat loss."
    );
  }

  if (intent === "fat_loss_performance") {
    lines.push(
      "- This is a fat-loss plus performance strategy question, not a post-training meal question.",
      "- Do not give a meal-list-only answer.",
      "- Explain the strategy: small calorie deficit, high protein, carbs around training, consistent strength work, recovery, and tracking.",
      "- You must mention keeping strength training consistent.",
      "- You must mention tracking weight, measurements, performance, or weekly trends.",
      "- Mention avoiding aggressive calorie cuts if performance, recovery, or mood drops.",
      "- Food examples are optional and secondary; the main answer should be strategy."
    );
  }

  if (intent === "protein_target") {
    lines.push(
      "- This is a protein-target question. Give practical protein servings across the day and simple examples.",
      "- Keep training-plan context secondary."
    );
  }

  if (intent === "pre_run_fuelling") {
    lines.push(
      "- This is pre-run fuelling. Give timing-based options for 2-3 hours before and 30-60 minutes before running.",
      "- Mention easy carbs and avoiding heavy high-fat foods right before running."
    );
  }

  if (intent === "general_nutrition") {
    lines.push(
      "- This is general nutrition advice. Give practical food guidance before discussing plan context."
    );
  }

  if (intent === "limited_time") {
    lines.push(
      "- This is a time-constraint question. Give a practical time-boxed training or recovery structure first."
    );
  }

  if (intent === "readiness_recovery") {
    lines.push(
      "- This is a readiness/recovery question. Answer the fatigue/readiness concern first.",
      "- Do not open with today's workout/session.",
      "- Start with assessment and downgrade logic: warm up easily, check whether the heaviness/fatigue improves, reduce intensity or volume if it does not, and choose recovery/easy work if needed.",
      "- Today's session can be mentioned only after that, and only as something to modify or downgrade.",
      "- Do not prescribe today's intervals or hard work as the default when the user reports heavy legs, feeling run down, tired, flat, or fatigued."
    );
  }

  if (intent === "weekly_focus") {
    lines.push(
      "- This is a weekly strategy/focus question. Give the strategic weekly focus first.",
      "- Mention consistency and quality before extra volume.",
      "- Highlight the key sessions from this week if available, such as speed work, HM pace, and long run.",
      "- Do not list every session in detail.",
      "- Mention recovery, sleep, and fuelling briefly as supports."
    );
  }

  if (intent === "schedule_timing") {
    lines.push(
      "- This is a scheduling/timing question. Answer the scheduling question directly.",
      "- Recommend placing harder sessions when the user is most fresh and can recover well.",
      "- If saved memory says the user prefers morning workouts, use that preference when relevant.",
      "- Do not mention protein, calories, meals, macros, fuelling, or nutrition unless the latest message asks about nutrition.",
      "- Do not continue a previous nutrition/protein answer."
    );
  }

  if (intent === "general_training_advice") {
    lines.push(
      "- This is a general coaching question. Answer the coaching question directly.",
      "- Context priority for this answer: 1) latest user question, 2) relevant active-plan context, 3) saved memory as a brief modifier only, 4) today's session only if the latest message asks about today or the current workout.",
      "- Do not open with today's workout/session.",
      "- Use the active plan only as background context, not as the main answer.",
      "- Do not describe today's session unless the latest message explicitly asks about today's workout or the current session.",
      "- Do not introduce food, fuelling, hydration, calorie, macro, or diet advice unless the latest user message explicitly asks about food, fuelling, energy availability, recovery nutrition, body composition, or diet.",
      "- Use saved coach memory only when it is relevant to the specific training topic; do not change the topic because of memory.",
      "- If saved memory is relevant, mention it briefly as one caveat or adjustment after the main answer. Do not make the whole answer about the memory unless the user specifically asks about that memory topic.",
      "- If the user asks about improving 5K or running faster, cover speed/interval work, tempo or threshold work, easy aerobic volume, consistency, strength training, recovery, and pacing.",
      "- If the user asks how to get faster without getting injured or how to build speed safely, answer as broad speed development plus injury prevention: gradual progression, easy runs easy, one or two quality sessions, strength, recovery, deloads, and warning signs.",
      "- If the user asks about hill running or a running skill, answer that skill directly with practical technique and progression advice.",
      "- If the user asks about endurance, cover easy aerobic volume, gradual progression, long easy work, recovery, and consistency.",
      "- If the user asks about strength, cover progressive overload, good technique, key compound lifts, sensible load progression, and recovery."
    );
  }

  if (intent === "schedule_reschedule") {
    lines.push(
      "- This is a schedule movement/rescheduling question. Answer whether moving it is sensible before describing today's session.",
      "- Check tomorrow's planned session from USER_CONTEXT_JSON.training.currentWeekSchedule, todaySchedule, exactSchedule, and LIVE_CONTEXT_FACTS where available.",
      "- If tomorrow already has a hard session, warn against stacking both sessions on the same day.",
      "- Suggest sensible options: do a shorter controlled version today, move today's session to the next easier/rest day, or keep tomorrow's hard session as priority.",
      "- You must include at least two practical options, not only one recommendation.",
      "- If tomorrow has a hard session, the preferred option should usually be moving today's session to the next easier/rest day rather than stacking it tomorrow.",
      "- Do not simply tell the user to complete today as scheduled.",
      "- Do not claim the plan has been changed unless an action card is returned and the user confirms.",
      "- If a change seems reasonable but needs confirmation, ask a concise confirmation question such as 'Want me to move it?'"
    );
  }

  return lines.join("\n");
}

function buildCoachChatMessages({
  systemPrompt,
  mergedContext,
  liveContextFacts,
  plan,
  planSummary,
  trimmedMessages,
  compact = false,
}) {
  const latestUserText = latestUserMessage(trimmedMessages);
  const contextForModel = contextForLatestMessage(
    mergedContext,
    planSummary,
    latestUserText,
    compact
  );
  const planForModel = planForLatestMessage(plan, planSummary, latestUserText, compact);
  const contextLimit = compact ? 5500 : 14000;
  const planLimit = compact ? 4500 : 18000;
  const planEditInstruction = `PLAN_EDIT_CONTRACT: updatedPlan must be null. For a requested plan change, return planEdits as [{"path":"/existing/path","valueJson":"40"}] using the exact editable paths supplied below and a plan_update coachAction. The server builds the complete updated plan. Update all duration representations of the selected session consistently (minutes vs seconds, workout totals and timed steps), preserving warmup/cooldown and unrelated sessions. Never invent a path or return a plan_update without executable edits. If the session cannot be identified, ask for clarification. All edits remain proposals requiring the user to apply them. This contract overrides the older full-plan examples.`;

  const messageLimit = 200;
  const recentContext = buildRecentConversationContext(
    trimmedMessages,
    latestUserText,
    messageLimit
  );

  return [
    { role: "system", content: systemPrompt },
    {
      role: "system",
      content: "USER_CONTEXT_JSON:\n" + safeStringify(contextForModel, contextLimit),
    },
    ...(liveContextFacts
      ? [
          {
            role: "system",
            content: "LIVE_CONTEXT_FACTS:\n" + liveContextFacts,
          },
        ]
      : []),
    {
      role: "system",
      content: "CURRENT_PLAN_JSON:\n" + safeStringify(planForModel, planLimit),
    },
    {
      role: "system",
      content: contextBoundaryInstruction(latestUserText),
    },
    {
      role: "system",
      content: latestUserPriorityInstruction(latestUserText),
    },
    {
      role: "system",
      content:
        "FINAL_LATEST_MESSAGE_RULE: Answer the latest user message below. Resolve follow-ups using earlier turns; when the topic changes, answer the new topic.",
    },
    { role: "system", content: planEditInstruction },
    ...(plan ? [{ role: "system", content: "EXACT_EDITABLE_PLAN_FIELDS (data):\n" + JSON.stringify(editablePlanFields(plan, mergedContext?.clock?.todayIso)) }] : []),
    ...recentContext,
    {
      role: "user",
      content: latestUserText,
    },
  ];
}

function completionContent(completion) {
  return completion?.choices?.[0]?.message?.content?.trim() || "";
}

function responsesOutputText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const output = Array.isArray(payload?.output) ? payload.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      const text = part?.text || part?.output_text;
      if (typeof text === "string" && text.trim()) return text.trim();
    }
  }

  return "";
}

async function createCoachChatResponsesFetchFallback({
  model,
  systemPrompt,
  mergedContext,
  liveContextFacts,
  plan,
  planSummary,
  trimmedMessages,
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000);
  const latestUserText = latestUserMessage(trimmedMessages);
  const compactContext = contextForLatestMessage(
    mergedContext,
    planSummary,
    latestUserText,
    true
  );
  const compactPlan = compactPlanForCoach(plan, planSummary);
  const requestBody = {
    model,
    input: buildCoachChatMessages({systemPrompt,mergedContext,liveContextFacts,plan,planSummary,trimmedMessages,compact:true}),
  };

  console.info("[coach-chat] OpenAI direct responses request", {
    model,
    payloadBytes: byteSize(requestBody),
    messages: trimmedMessages.length,
    contextBytes: byteSize(compactContext),
    planBytes: byteSize(compactPlan),
  });

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const text = await response.text();
    console.info("[coach-chat] OpenAI direct responses status", {
      model,
      status: response.status,
      ok: response.ok,
      outputBytes: byteSize(text),
    });

    if (!response.ok) {
      const error = new Error(`OpenAI responses request failed with ${response.status}`);
      error.status = response.status;
      error.responseText = text.slice(0, 1000);
      throw error;
    }

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    const outputText = responsesOutputText(parsed);
    if (!outputText) throw new Error("OpenAI responses request returned an empty reply.");
    return {
      choices: [
        {
          message: {
            content: outputText,
          },
        },
      ],
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function createCoachChatCompletionWithRetry({
  openai,
  primaryModel,
  fallbackModel,
  systemPrompt,
  mergedContext,
  liveContextFacts,
  plan,
  planSummary,
  trimmedMessages,
}) {
  const fullMessages = buildCoachChatMessages({
    systemPrompt,
    mergedContext,
    liveContextFacts,
    plan,
    planSummary,
    trimmedMessages,
    compact: false,
  });
  const fullPayloadBytes = byteSize({ model: primaryModel, messages: fullMessages });
  const useCompactFirst = fullPayloadBytes > 52000;
  const attempts = [
    {
      model: primaryModel,
      compact: useCompactFirst,
      reason: useCompactFirst ? "initial_compact_large_payload" : "initial",
    },
    {
      model: fallbackModel || primaryModel,
      compact: true,
      reason: "retry_compact",
    },
  ];

  let lastError = null;

  for (const attempt of attempts) {
    const messagesForAttempt = attempt.compact
      ? buildCoachChatMessages({
          systemPrompt,
          mergedContext,
          liveContextFacts,
          plan,
          planSummary,
          trimmedMessages,
          compact: true,
        })
      : fullMessages;
    const requestBody = {
      model: attempt.model,
      messages: messagesForAttempt,
      temperature: 0.35,
      response_format: { type: "json_object" },
    };
    const diagnostics = {
      model: attempt.model,
      compact: attempt.compact,
      reason: attempt.reason,
      payloadBytes: byteSize(requestBody),
      messages: messagesForAttempt.length,
      contextBytes: byteSize(mergedContext),
      planBytes: byteSize(plan),
    };

    console.info("[coach-chat] OpenAI request", diagnostics);

    try {
      const completion = await openai.chat.completions.create(requestBody, {
        timeout: 35000,
        maxRetries: 0,
      });
      console.info("[coach-chat] OpenAI response", {
        model: attempt.model,
        compact: attempt.compact,
        status: "ok",
        outputBytes: byteSize(completionContent(completion)),
      });
      return {
        completion,
        responseSource: attempt.reason.startsWith("initial") ? "ai_primary" : "ai_retry",
      };
    } catch (error) {
      lastError = error;
      console.warn("[coach-chat] OpenAI request failed", {
        ...diagnostics,
        error: openAIErrorInfo(error),
      });
    }
  }

  try {
    const completion = await createCoachChatResponsesFetchFallback({
      model: fallbackModel || primaryModel,
      systemPrompt,
      mergedContext,
      liveContextFacts,
      plan,
      planSummary,
      trimmedMessages,
    });
    return {
      completion,
      responseSource: "ai_responses_fallback",
    };
  } catch (error) {
    lastError = error;
    console.warn("[coach-chat] OpenAI direct responses fallback failed", {
      error: openAIErrorInfo(error),
      responseText: error?.responseText || null,
    });
  }

  throw lastError || new Error("OpenAI request failed");
}

function firstTodaySessionName(context) {
  const training = context?.training || {};
  const todaySchedule = normaliseList(training?.todaySchedule);
  const first = todaySchedule.find(Boolean) || training?.todaySession || null;
  return first ? sessionDisplayName(first) : "";
}

function keyWeeklySessionNames(context) {
  const training = context?.training || {};
  const sessions = normaliseList(training?.currentWeekSchedule);
  const keySessions = [];
  const seen = new Set();

  for (const session of sessions) {
    const title = cleanCoachText(
      session?.title ||
        session?.name ||
        session?.sessionName ||
        session?.sessionTitle ||
        session?.type ||
        session?.sessionType ||
        ""
    );
    if (!title) continue;

    const text = normaliseText(
      [
        title,
        session?.kind,
        session?.planKind,
        session?.sessionType,
        session?.type,
        session?.workout?.kind,
      ].join(" ")
    );
    const isKey =
      text.includes("speed") ||
      text.includes("interval") ||
      text.includes("tempo") ||
      text.includes("threshold") ||
      text.includes("hm pace") ||
      text.includes("half marathon pace") ||
      text.includes("long run") ||
      text.includes("long");

    if (!isKey) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    keySessions.push(title);
    if (keySessions.length >= 3) break;
  }

  return keySessions;
}

function coachMemorySnippets(context, limit = 3, latestUserText = "") {
  const memory = context?.athleteProfile?.coachMemory;
  if (!Array.isArray(memory)) return [];
  const relevantMemory = latestUserText
    ? filterCoachMemoryForLatestMessage(memory, latestUserText)
    : memory;
  return relevantMemory
    .map((item) => cleanCoachText(item?.text || item?.category || ""))
    .filter(Boolean)
    .slice(0, limit);
}

function activePlanLabel(context) {
  const training = context?.training || {};
  return cleanCoachText(
    context?.activePlanSummary?.name ||
      training?.activePlan?.name ||
      training?.activePlan?.title ||
      normaliseList(training?.activePlans)[0]?.name ||
      normaliseList(training?.activePlans)[0]?.title ||
      ""
  );
}

function appendMemoryContextLine(lines, context, latestUserText = "") {
  const snippets = coachMemorySnippets(context, 3, latestUserText);
  if (snippets.length) {
    const naturalLines = snippets.map((snippet) => naturalMemoryPersonalisationLine(snippet));
    lines.push("", ...naturalLines.filter(Boolean));
  }
  return lines;
}

function naturalMemoryPersonalisationLine(snippet) {
  const text = cleanCoachText(snippet);
  const clean = normaliseText(text);
  if (!text) return "";

  if (clean.includes("morning")) {
    return "Since you prefer morning workouts, place the sessions that need the most focus earlier in the day when possible.";
  }

  if (clean.includes("knee") && clean.includes("hill")) {
    return "Since your knee can get sore after hills, be careful with hill and downhill load as you build up.";
  }

  if (clean.includes("knee")) {
    return "Since your knee can be a limiter, build gradually and back off if pain changes your stride or lingers.";
  }

  if (clean.includes("treadmill")) {
    return "Since treadmill runs are not your favourite, use outdoor or varied routes when that still fits the goal.";
  }

  return `Keep your preference in mind: ${text}.`;
}

function relevantCoachMemorySnippetForPrompt(context, latestUserText) {
  const snippets = coachMemorySnippets(context, 5, latestUserText);
  const latest = normaliseText(latestUserText);
  if (!snippets.length || !latest) return "";

  if (latestMentionsMorningTimingTopic(latestUserText)) {
    return snippets.find((snippet) => /\bmorning\b/i.test(snippet)) || "";
  }

  if (latestMentionsInjuryMemoryTopic(latestUserText)) {
    return snippets.find((snippet) => /\b(?:knee|hill|hills|injur|pain|sore)\b/i.test(snippet)) || "";
  }

  return "";
}

function appendBriefMemoryModifier(lines, context, latestUserText = "") {
  const snippet = relevantCoachMemorySnippetForPrompt(context, latestUserText);
  if (snippet) {
    const naturalLine = naturalMemoryPersonalisationLine(snippet);
    if (naturalLine) lines.push("", naturalLine);
  }
  return lines;
}

function replyFirstContentLine(reply) {
  return String(reply || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .find(Boolean) || "";
}

function replyMentionsDisallowedNutrition(reply, latestUserText) {
  if (shouldIncludeNutritionContext(latestUserText)) return false;
  const text = normaliseText(reply);
  return /\b(nutrition|protein|carb|carbs|calorie|calories|meal|food|fuel|fuelling|fueling|hydrate|hydration|fluids)\b/.test(text);
}

function replyContainsInternalPolicyLanguage(reply) {
  const text = normaliseText(reply);
  return (
    text.includes("brief modifier") ||
    text.includes("saved memory") ||
    text.includes("saved note") ||
    text.includes("policy") ||
    text.includes("context") ||
    text.includes("modifier") ||
    text.includes("do not let it override") ||
    text.includes("main training goal") ||
    text.includes("internal instruction") ||
    text.includes("user_context_json") ||
    text.includes("current_plan_json")
  );
}

function replyStartsWithTodayContext(reply) {
  const firstLine = normaliseText(replyFirstContentLine(reply));
  return (
    firstLine.includes("today's") ||
    firstLine.includes("todays") ||
    firstLine.includes("today is") ||
    firstLine.includes("today you have") ||
    firstLine.includes("your session today") ||
    firstLine.includes("speed: 5 x 1200m")
  );
}

function replyHasReadinessDowngradeAdvice(reply) {
  const text = normaliseText(reply);
  const terms = ["warm-up", "warm up", "reassess", "easy", "downgrade", "reduce", "recovery", "rest", "mobility"];
  return terms.filter((term) => text.includes(term)).length >= 2;
}

function replyMemoryTopicMentions(reply) {
  return (normaliseText(reply).match(/\b(?:knee|hill|hills)\b/g) || []).length;
}

function latestMessageAsksMemoryTopic(latestUserText) {
  const latest = normaliseText(latestUserText);
  return latest.includes("knee") || latest.includes("hill");
}

function latestMessageNeedsInjuryMemoryModifier(latestUserText, context) {
  const latest = normaliseText(latestUserText);
  const asksSpeedSafety =
    latest.includes("speed safely") ||
    latest.includes("build speed") ||
    latest.includes("get faster") ||
    latest.includes("without getting injured") ||
    latest.includes("without injury");
  if (!asksSpeedSafety || latestMessageAsksMemoryTopic(latestUserText)) return false;
  return coachMemorySnippets(context, 5, latestUserText).some((snippet) =>
    /\b(?:knee|hill|hills)\b/i.test(snippet)
  );
}

function replyMemoryDominates(reply, latestUserText) {
  const intent = latestUserIntentHint(latestUserText);
  if (intent !== "general_training_advice") return false;
  if (latestMessageAsksMemoryTopic(latestUserText)) return false;
  return replyMemoryTopicMentions(reply) > 3;
}

function replyUsesIrrelevantInjuryMemory(reply, latestUserText) {
  if (latestMentionsInjuryMemoryTopic(latestUserText)) return false;
  return replyMemoryTopicMentions(reply) > 0;
}

function replyMissesCasualMorningPreference(reply, latestUserText) {
  if (!isCasualMorningPreferenceStatement(latestUserText)) return false;
  return !/\bmornings?\b/i.test(reply);
}

function coachChatReplyPolicyViolation(reply, latestUserText, context = null) {
  const intent = latestUserIntentHint(latestUserText);

  if (replyContainsInternalPolicyLanguage(reply)) {
    return "reply_contains_internal_policy_language";
  }

  if (replyMentionsDisallowedNutrition(reply, latestUserText)) {
    return "non_nutrition_reply_mentions_nutrition";
  }

  if (replyUsesIrrelevantInjuryMemory(reply, latestUserText)) {
    return "reply_uses_irrelevant_injury_memory";
  }

  if (replyMissesCasualMorningPreference(reply, latestUserText)) {
    return "reply_misses_casual_morning_preference";
  }

  if (intent === "readiness_recovery") {
    if (replyStartsWithTodayContext(reply)) return "readiness_reply_starts_with_today_context";
    if (!replyHasReadinessDowngradeAdvice(reply)) return "readiness_reply_missing_downgrade_advice";
  }

  if (intent === "general_training_advice" && !shouldForegroundTodayContext(latestUserText)) {
    if (replyStartsWithTodayContext(reply)) return "broad_training_reply_starts_with_today_context";
    if (replyMemoryDominates(reply, latestUserText)) return "broad_training_reply_memory_dominates";
    if (
      latestMessageNeedsInjuryMemoryModifier(latestUserText, context) &&
      replyMemoryTopicMentions(reply) === 0
    ) {
      return "broad_training_reply_missing_relevant_memory_modifier";
    }
  }

  return null;
}

function buildWeeklyFocusFallbackReply(context) {
  const keySessions = keyWeeklySessionNames(context);
  const keyLine = keySessions.length
    ? `Protect the key sessions: ${keySessions.join(", ")}.`
    : "Protect the key sessions and keep the easy work genuinely easy.";

  return [
    "This week, focus on consistency and quality rather than extra volume.",
    "",
    keyLine,
    "Keep strength work controlled, avoid chasing soreness, and use recovery, sleep, and fuelling to stay fresh.",
  ].join("\n");
}

function buildLocalCoachFallbackReply(message, context) {
  const text = normaliseText(message);
  const intent = latestUserIntentHint(text);
  const sessionName = firstTodaySessionName(context);
  const todayPhrase = sessionName ? `today's ${sessionName} session` : "today's planned session";
  const planName = activePlanLabel(context);
  const foregroundToday = shouldForegroundTodayContext(text);
  const injuryReply = commonTrainingInjuryReply(text);

  if (injuryReply) {
    return appendMemoryContextLine([injuryReply], context, text).join("\n");
  }

  if (isWeeklyFocusQuestion(text)) {
    return buildWeeklyFocusFallbackReply(context);
  }

  if (isCasualMorningPreferenceStatement(text)) {
    return [
      "That makes sense. If mornings consistently feel better, use that as your default for the sessions that need the most focus.",
      "",
      "- Put harder runs, strength work, or key sessions earlier in the day when possible",
      "- Keep easier recovery work for later if your schedule needs it",
      "- Watch whether sleep, warm-up time, and stress are part of why mornings feel better",
      "- I will not save this as a coach memory unless you explicitly ask me to remember it",
    ].join("\n");
  }

  if (intent === "fat_loss_performance") {
    return appendMemoryContextLine(
      [
        "Aim for fat loss without letting training quality collapse.",
        "",
        "- Use a small calorie deficit, not an aggressive cut",
        "- Keep protein high across the day",
        "- Put most carbs around harder sessions",
        "- Keep strength work consistent",
        "- Track weekly weight trend, measurements, recovery, and performance",
        "- If performance drops hard, bring calories or carbs back up slightly",
      ],
      context,
      text
    ).join("\n");
  }

  if (intent === "post_training_nutrition" || intent === "general_nutrition") {
    return [
      "Prioritise simple fuelling first.",
      "",
      "- Protein: aim for a solid serving",
      "- Carbs: add more if the session was hard, long, or you have quality work soon",
      "- Fluids: rehydrate and add electrolytes if you sweated heavily",
      "",
      "Good options: Greek yoghurt with fruit, eggs on toast, chicken/rice/veg, a tuna wrap, or a protein shake plus banana.",
    ].join("\n");
  }

  if (intent === "protein_target") {
    return [
      "Hit protein by spreading it across the day instead of saving it all for dinner.",
      "",
      "- Aim for 3-5 protein servings across the day",
      "- Use simple anchors: eggs, Greek yoghurt, chicken, fish, lean meat, tofu, beans, or whey",
      "- Put 25-40g protein in main meals when possible",
      "- Add an easy top-up snack if you are short: yoghurt, shake, cottage cheese, tuna, or jerky",
      "- Keep carbs around training so performance does not suffer",
    ].join("\n");
  }

  if (intent === "pre_run_fuelling") {
    return [
      "Fuel the run without making your stomach work too hard.",
      "",
      "- 2-3 hours before: a normal carb-based meal with some protein",
      "- 30-60 minutes before: a small easy-carb snack if needed",
      "- Avoid heavy, high-fat foods right before running",
      "",
      "Examples: toast and banana, oats, rice with lean protein, or a small cereal bar before shorter runs.",
    ].join("\n");
  }

  if (intent === "schedule_timing") {
    return appendMemoryContextLine(
      [
        "Schedule harder sessions when you can be freshest and recover properly.",
        "",
        "- Put hard runs, intervals, heavy strength, or long efforts after easier/rest days",
        "- Keep at least 24-48 hours between the hardest sessions where possible",
        "- Use easier days for recovery, mobility, or low-intensity work",
        "- If mornings suit you best, place key sessions in the morning and keep later training easier",
        "- Avoid stacking hard sessions late in the day if it affects sleep or recovery",
      ],
      context,
      text
    ).join("\n");
  }

  if (isGeneralTrainingAdviceQuestion(text)) {
    if (
      text.includes("faster") ||
      text.includes("speed safely") ||
      text.includes("without getting injured") ||
      text.includes("without injury")
    ) {
      return appendBriefMemoryModifier(
        [
          "Build speed by progressing the work you can recover from, not by forcing every run harder.",
          "",
          "- Keep easy runs genuinely easy so you can absorb the hard sessions",
          "- Add one or two quality sessions per week, such as intervals and tempo or threshold work",
          "- Progress volume or intensity gradually rather than both at once",
          "- Keep strength training consistent for calves, hips, hamstrings, glutes, and trunk",
          "- Use recovery weeks or deloads before niggles become injuries",
          "- Back off if pain changes your stride, worsens during the run, or lingers into the next day",
        ],
        context,
        text
      ).join("\n");
    }

    if (text.includes("form") || text.includes("technique")) {
      return appendMemoryContextLine(
        [
          "Improve running form by making it relaxed, quick, and repeatable.",
          "",
          "- Run tall with a slight forward lean from the ankles",
          "- Keep your cadence light and avoid overstriding",
          "- Let your arms swing back and forward, not across your body",
          "- Add short strides after easy runs to practise smooth mechanics",
          "- Use drills like A-skips, high knees, and fast feet in warm-ups",
          "- Change one cue at a time so it becomes natural",
        ],
        context,
        text
      ).join("\n");
    }

    if (text.includes("hill")) {
      return appendMemoryContextLine(
        [
          "Get better at hills by combining technique, strength, and controlled exposure.",
          "",
          "- Shorten your stride and keep cadence quick on climbs",
          "- Lean slightly from the ankles, not by folding at the waist",
          "- Drive the arms to help rhythm without sprinting too early",
          "- Start with short hill reps or rolling routes once a week",
          "- Jog or walk down easy so the quality stays high",
          "- Build gradually; do not turn every hilly run into a race",
        ],
        context,
        text
      ).join("\n");
    }

    if (text.includes("5k") || text.includes("run faster") || text.includes("pace")) {
      return appendMemoryContextLine(
        [
          "To improve your 5K, build the basics consistently.",
          "",
          "- Keep easy runs genuinely easy to build aerobic volume",
          "- Do one quality speed or interval session each week",
          "- Add tempo or threshold work for sustained pace",
          "- Keep strength training consistent for durability",
          "- Recover well so the quality sessions are actually high quality",
        ],
        context,
        text
      ).join("\n");
    }

    if (text.includes("endurance")) {
      return appendMemoryContextLine(
        [
          "Build endurance with steady consistency, not big jumps.",
          "",
          "- Increase easy aerobic volume gradually",
          "- Keep one longer easy session most weeks",
          "- Avoid turning every run into a hard run",
          "- Sleep, fuel, and recover enough to absorb the work",
        ],
        context,
        text
      ).join("\n");
    }

    if (text.includes("stronger")) {
      return appendMemoryContextLine(
        [
          "Get stronger by progressing the basics consistently.",
          "",
          "- Use good technique on key compound lifts",
          "- Add load, reps, or sets gradually",
          "- Keep hard sets controlled and repeatable",
          "- Recover well between hard sessions",
        ],
        context,
        text
      ).join("\n");
    }
  }

  if (text.includes("missed") || text.includes("skipped")) {
    return appendMemoryContextLine(
      [
        "Do not try to make up a missed session by cramming extra hard work in.",
        "",
        `If ${todayPhrase} was missed, either move the key part to the next easy/rest day or continue with the next planned session.`,
        "Keep the next hard workout high quality rather than stacking fatigue.",
        "If missing sessions is becoming a pattern, reduce the week slightly instead of chasing the plan.",
      ],
      context,
      text
    ).join("\n");
  }

  if (/\b\d+\s*(?:min|mins|minute|minutes)\b/.test(text) || text.includes("only have")) {
    return appendMemoryContextLine(
      [
      "Use the time you have and keep it controlled.",
      "",
      `If ${todayPhrase} is still planned, do the highest-value part rather than rushing the whole thing:`,
      "- 5 min warm-up",
      "- 20 min main work at controlled effort",
      "- 5 min easy cooldown or mobility",
      "",
      "Skip accessories or extra volume today. Do not try to cram the full session into 30 minutes.",
      ],
      context,
      text
    ).join("\n");
  }

  if (
    isReadinessRecoveryPrompt(text)
  ) {
    return appendMemoryContextLine(
      [
        "Treat heavy or flat legs as a readiness signal first.",
        "",
        "- Start with an easy 10-15 minute warm-up and reassess",
        "- If your legs loosen up, keep the session controlled rather than forcing peak pace",
        "- If they stay heavy, downgrade to easy running, mobility, walking, or recovery",
        "- Reduce intensity or volume before you sacrifice the next key session",
        `- If ${todayPhrase} is planned, modify it rather than treating the intervals as mandatory`,
      ],
      context,
      text
    ).join("\n");
  }

  if (text.includes("move") || text.includes("reschedule") || text.includes("tomorrow")) {
    return [
      "Moving a session is usually fine if it keeps the week consistent.",
      "",
      "Do not stack two hard sessions back to back. Move the session to tomorrow only if tomorrow is easy enough, or continue with the next planned session and keep the week controlled.",
    ].join("\n");
  }

  if (text.includes("week")) {
    return [
      "Keep the week simple and consistent.",
      "",
      "- Prioritise the key planned sessions",
      "- Keep easy work genuinely easy",
      "- Avoid making up missed work aggressively",
      "- Adjust down if recovery is poor",
    ].join("\n");
  }

  return appendMemoryContextLine(
    [
      "Answer the latest question directly and keep the next step practical.",
      "",
      planName
        ? `Use ${planName} as background, but answer what the user just asked.`
        : "Use the available training details, but do not invent missing plan details.",
      foregroundToday && sessionName
        ? `For today, ${sessionName} is the key session to consider.`
        : null,
      "If the user is asking for advice, give one conservative next step and one adjustment option.",
    ].filter(Boolean),
    context,
    text
  ).join("\n");
}

function buildCoachChatFallbackResponse(message, context, error = null) {
  const reply = buildLocalCoachFallbackReply(message, context);
  return {
    reply,
    updatedPlan: null,
    nutritionDraft: null,
    coachActions: [],
    raw: JSON.stringify({
      reply,
      updatedPlan: null,
      nutritionDraft: null,
      coachActions: [],
      source: "local_fallback",
      error: error ? openAIErrorInfo(error) : null,
    }),
  };
}

function fallbackMessageFromRequestBody(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const trimmedMessages = messages
    .filter(
      (message) =>
        (message?.role === "user" || message?.role === "assistant") &&
        typeof message?.content === "string" &&
        message.content.trim()
    )
    .slice(-200)
    .map((message) => ({
      role: message.role,
      content: String(message.content || "").trim(),
    }));
  return latestUserMessage(trimmedMessages);
}

function fallbackContextFromRequestBody(body) {
  const context = body?.context && typeof body.context === "object" ? body.context : {};
  const nutrition = body?.nutrition && typeof body.nutrition === "object" ? body.nutrition : null;
  let planSummary = null;
  try {
    planSummary = summarisePlan(body?.plan);
  } catch {
    planSummary = null;
  }
  return {
    ...context,
    ...(nutrition ? { nutrition } : {}),
    ...(planSummary ? { activePlanSummary: planSummary } : {}),
  };
}

function extractJsonObject(raw = "") {
  const text = String(raw || "").trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {}

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;

  try {
    return JSON.parse(text.slice(first, last + 1));
  } catch {
    return null;
  }
}

/**
 * Coach chat route for Train-R.
 *
 * Request body:
 * {
 *   messages: [{ role: "user" | "assistant", content: string, attachments?: [] }],
 *   plan?: object | null,
 *   nutrition?: object | null,
 *   context?: object | null
 * }
 *
 * Response:
 * {
 *   reply: string,
 *   updatedPlan: object | null,
 *   nutritionDraft: object | null,
 *   raw: string
 * }
 */
export default function coachChatRoute(openai, {getRepository=legacyMemoryRepositoryForUser}={}) {
  const router = express.Router();
  router.use(createLegacyMemoryBridge({getRepository}));
  const coachChatModel = OPENAI_COACH_CHAT_MODEL;

  if (!openai) {
    console.warn("[coach-chat] OpenAI client not configured.");
  }

  router.post("/", async (req, res) => {
    try {
      const { messages, plan, nutrition, context } = req.body || {};

      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({
          error: "Request body must include a non-empty 'messages' array.",
        });
      }

      const trimmedMessages = messages
        .filter(
          (m) =>
            (m?.role === "user" || m?.role === "assistant") &&
            typeof m?.content === "string" &&
            (m.content.trim() || Array.isArray(m?.attachments))
        )
        .slice(-200)
        .map((m) => ({
          role: m.role,
          content: String(m.content || "").trim(),
          attachments: Array.isArray(m?.attachments)
            ? m.attachments
                .filter((attachment) => attachment?.type === "image" && attachment?.url)
                .slice(0, 1)
                .map((attachment) => ({
                  type: "image",
                  url: String(attachment.url || ""),
                  mimeType: attachment.mimeType ? String(attachment.mimeType) : null,
                  fileName: attachment.fileName ? String(attachment.fileName) : null,
                }))
            : [],
        }));

      const planSummary = summarisePlan(plan);
      const mergedContext = {
        ...(context && typeof context === "object" ? context : {}),
        ...(nutrition ? { nutrition } : {}),
        ...(planSummary ? { activePlanSummary: planSummary } : {}),
      };
      const latestUserText = latestUserMessage(trimmedMessages);
      const previousConversationHas30MinPrompt = previousConversationHasLimitedTimePrompt(
        trimmedMessages,
        latestUserText
      );
      const responseDiagnosticsBase = {
        latestUserText,
        context: mergedContext,
        previousConversationHas30MinPrompt,
      };

      const memorySaveResponse = buildMemorySaveResponse(latestUserText);
      if (memorySaveResponse) {
        return sendCoachResponse(res, memorySaveResponse, {
          ...responseDiagnosticsBase,
          responseSource: "action_card",
        });
      }

      if (!openai) {
        console.warn("[coach-chat] OpenAI client not configured; returning local fallback.");
        return sendCoachResponse(
          res,
          buildCoachChatFallbackResponse(latestUserText, mergedContext),
          {
            ...responseDiagnosticsBase,
            responseSource: "local_fallback",
            openAiError: new Error("OpenAI client not configured"),
          }
        );
      }

      const latestUserWithAttachment = [...trimmedMessages]
        .reverse()
        .find((m) => m.role === "user" && Array.isArray(m.attachments) && m.attachments.length);
      if (latestUserWithAttachment) {
        const reply =
          "I've attached the image, but image analysis is not enabled yet. Describe what you want me to look at and I'll help from there.";
        return sendCoachResponse(
          res,
          {
            reply,
            updatedPlan: null,
            nutritionDraft: null,
            coachActions: [],
            raw: JSON.stringify({ reply, updatedPlan: null, nutritionDraft: null, coachActions: [] }),
          },
          {
            ...responseDiagnosticsBase,
            responseSource: "deterministic_summary",
          }
        );
      }
      const localNutritionDraft = createNutritionDraftFromText(latestUserText);
      if (localNutritionDraft) {
        const reply = `I prepared an estimate for ${localNutritionDraft.title}. Review it before adding it to today.`;
        return sendCoachResponse(
          res,
          {
            reply,
            updatedPlan: null,
            nutritionDraft: localNutritionDraft,
            coachActions: [],
            raw: JSON.stringify({ reply, updatedPlan: null, nutritionDraft: localNutritionDraft }),
          },
          {
            ...responseDiagnosticsBase,
            responseSource: "action_card",
          }
        );
      }

      const deterministicReply = tryDeterministicCoachReply(
        latestUserText,
        mergedContext
      );

      if (deterministicReply) {
        return sendCoachResponse(
          res,
          {
            reply: deterministicReply,
            updatedPlan: null,
            nutritionDraft: null,
            coachActions: [],
            raw: JSON.stringify({ reply: deterministicReply, updatedPlan: null, nutritionDraft: null }),
          },
          {
            ...responseDiagnosticsBase,
            responseSource: deterministicResponseSource(latestUserText),
          }
        );
      }

      const systemPrompt = `
You are Train-R's AI coach.

Behave more like ChatGPT than a generic app bot:
- natural, direct, helpful, and context-aware
- answer the user's question first
- keep replies concise by default
- write for mobile reading, not desktop reading
- sound like a coach in conversation, not a notification or template

AI-FIRST ROUTING:
- For normal fitness, training, nutrition, recovery, plan advice, and general coaching questions, answer naturally using the AI model.
- Use the user's plan, today, week, nutrition, and profile context to personalise the answer, not to replace the answer.
- Do not simply describe today's session unless the latest user message explicitly asks what today's session/workout/training is.
- For broad questions, give principles plus practical next steps.
- For plan changes, explain options and ask for confirmation before claiming anything changed.

STYLE RULES:
- Do not answer in one dense paragraph unless the user explicitly asks for that format.
- Use short sentences.
- Break ideas onto separate lines.
- Prefer bullets for advice, recommendations, tradeoffs, and summaries.
- Prefer numbered steps when explaining what to do next.
- Keep each bullet to one idea where possible.
- Start with a short direct answer, then break the rest down.
- Leave a blank line between short sections when it improves readability.
- Avoid fluff, filler, and repeated phrasing.
- Avoid generic sign-offs like "Enjoy your run", "You've got this", or "Let me know if..."
- Do not repeat the user's exact wording unless needed for clarity.
- Avoid markdown tables.
- If the question is simple, answer in 1 to 4 short lines.
- If the answer is longer, use this default shape:
  1. one short answer sentence
  2. 3 to 6 short bullets
  3. one short next-step line if useful

You know the user's live context:
- training plan
- exact current schedule when provided
- current local date/time when provided
- recent training sessions
- nutrition targets and intake
- body metrics and weight trend
- saved coach memory, profile notes, injuries, constraints when provided

Grounding rules:
- Treat USER_CONTEXT_JSON and CURRENT_PLAN_JSON as the source of truth.
- If USER_CONTEXT_JSON.clock is present, treat it as the source of truth for the user's current local day, date, time, and timezone.
- If USER_CONTEXT_JSON.training.exactSchedule or USER_CONTEXT_JSON.training.activePlans is present, treat that as the user's exact current plan and current session layout, including moved sessions and recent plan edits.
- Prefer exactSchedule/currentWeekSchedule/todaySchedule over older conversational memory.
- When talking about days, use the provided isoDate/dateLabel if available, not just the weekday name.
- If the user asks what day/date/time it is today or now, answer directly from USER_CONTEXT_JSON.clock and do not invent or infer another calendar date.
- If a data point is missing, say you do not have it.
- Do not invent meals, sessions, injuries, or targets.
- If the user asks about nutrition, use their real targets/intake where available.
- If the user asks about training or recovery, use their recent sessions and current plan where available.
- If the user asks for their last completed session/workout, first use USER_CONTEXT_JSON.training.lastCompletedSession or recentCompletedSessions. Only fall back to Garmin activity history or planned schedule if no completed app session is available.
- If USER_CONTEXT_JSON.training.garminActivities is present, use it as imported Garmin activity history for recent completed workouts.
- If USER_CONTEXT_JSON.athleteProfile.coachMemory is present, use it as saved long-term user preference/constraint context.
- If the user asks for changes to their plan, you may update it conservatively.

Adaptive constraint rules:
- If the user says they only have limited time today, are short on time, are tired, slept badly, feel run down, or asks whether to move today's session, answer that exact constraint first.
- Do not turn these prompts into a tomorrow-plan summary.
- Mention tomorrow's session only briefly as context for why today's recommendation should be lighter or more controlled.
- First decide whether today's planned session is completed, incomplete, unknown, or missing using USER_CONTEXT_JSON.training.todaySchedule, todaySession, recentCompletedSessions, and LIVE_CONTEXT_FACTS.
- If today's planned session is already completed, tell them not to add more hard work. Suggest a practical recovery/prep use of the time.
- If today's planned session is incomplete, give a shortened version of today's planned session that fits the available time.
- If status is unknown, state the uncertainty and give both paths briefly: if complete, recovery/prep; if incomplete, shortened controlled version.
- For "I only have 30 minutes today" or similar, include a concrete 30-minute structure with timings.
- The timed structure is required. Do not answer limited-time prompts with only general advice.
- If today's session is complete, the timed structure should be recovery/prep based, for example easy walk/bike, mobility, light core/stretching, and preparation for the next session.
- If today's session is incomplete, the timed structure should be a shortened controlled version of today's session, not a summary of tomorrow.
- For tired or bad-sleep prompts, reduce volume or intensity first. Use the warm-up as a decision point.
- For moving-session prompts, explain whether moving it is sensible and avoid stacking hard sessions back to back.
- Keep the answer practical and specific. Do not simply list upcoming sessions.

Nutrition advice rules:
- If the user asks what to eat, how to fuel, how to hit protein, what to eat before a run, what to eat after training, what to eat tonight, or how to lose fat while keeping performance, answer the nutrition question first.
- Do not turn nutrition prompts into a training-plan summary.
- Use training context only to personalise the advice after giving the food/fuelling answer.
- For post-training nutrition, mention protein + carbs + fluids.
- For post-training protein, give a practical range when useful, usually around 25-40g protein.
- For hard running, speed work, long runs, or another demanding session soon, recommend enough carbs to refuel and avoid going too low-carb.
- For pre-run nutrition, give timing-based options: larger meal 2-3 hours before, small carb snack 30-60 minutes before if needed, and avoid heavy high-fat foods right before running.
- For "what should I eat tonight", give a simple plate or meal options based on recovery, next session, and goals.
- For "how do I hit my protein", give practical protein servings and examples across the day.
- For fat loss with performance, recommend a modest calorie deficit, high protein, carbs around training, and avoiding aggressive under-fuelling.
- Include simple food examples, not just macro concepts.
- Keep the answer concise and practical: 3-6 examples or bullets is enough.

Nutrition logging rules:
- If the user explicitly asks to add, log, track, or record food/drink to their day, return a nutritionDraft.
- If the user sends only a food or drink name, treat it as a request to prepare a nutritionDraft for approval.
- Logging a specific food/drink does not require nutrition targets or current intake data.
- Do not ask for nutrition targets before preparing a draft for a named item.
- Do not say the food has been logged. It still needs user approval in the app.
- If the user gives enough detail for a reasonable estimate, produce a conservative estimate using typical UK/EU nutrition values.
- If the item or serving is too ambiguous, ask one short clarifying question and set nutritionDraft to null.
- Use mealType "Breakfast", "Lunch", "Dinner", "Snack", or "Unspecified".
- Use grams for protein/carbs/fat and kcal for calories.
- Keep source as "coach_chat".

Plan update rules:
- Only return a non-null updatedPlan when the user is explicitly asking to change, move, reduce, increase, or adapt their plan.
- Keep the same overall plan structure.
- Respect progression and avoid reckless jumps in volume or intensity.
- If you are not changing the plan, updatedPlan must be null.
- Prefer coachActions for proposed app writes. Do not claim a change, meal, session edit, or memory has been saved until the user approves the action card.
- When the user asks to change/save/log/remember something, include a coachActions item with a clear summary, reason, before/after when available, and payload needed by the app.

Weekly check-in rules:
- If the user message starts with "Weekly check-in completed", treat the Answers section as structured athlete feedback for this week.
- Use USER_CONTEXT_JSON.training.currentWeekSchedule, recentCompletedSessions, lastCompletedSession, nutrition, and coachMemory to review the week. Do not invent completion counts, pain, sleep, sessions, or meals.
- Reply with a concise weekly review, next week focus, and only the most useful adjustment recommendations.
- If pain, niggles, injury concern, schedule limits, travel, or recurring constraints are reported, consider a memory_save coachAction so the user can approve saving that context.
- If the user reports tired, very tired, poor sleep, too much, busy week, less time, travel, too hard, too long, or too intense, consider a conservative plan_update or session_edit coachAction.
- If no change is needed, return coachActions: [].
- Never say the plan, session, or memory has been changed until the user applies the action card.

Daily readiness rules:
- If the user message starts with "Daily readiness check-in completed", treat the Answers section and Local readiness label as structured feedback for today.
- Use USER_CONTEXT_JSON.training.todaySession, todaySchedule, currentWeekSchedule, nutrition, recentCompletedSessions, and coachMemory. Do not invent sleep, soreness, pain, sessions, or meals.
- Reply with a readiness rating, what to do today, and whether today's session should stay as planned, be made easier, moved, or replaced with recovery.
- If the user is tired, sore, has poor sleep, or high fatigue but no pain, consider a conservative session_edit coachAction to make today's session easier.
- If the user reports sharp pain or pain during movement, give cautious advice, avoid telling them to push through, and consider a memory_save coachAction.
- If the user cannot train today or should move today's work, consider session_edit or plan_update only when the target can be identified from context.
- If no change is needed, return coachActions: [].
- Never say the plan, session, or memory has been changed until the user applies the action card.

Safety:
- Be conservative with injury advice.
- Encourage professional help for severe, persistent, or escalating pain.

RESPONSE FORMAT:
Return VALID JSON ONLY with this exact shape:
{
  "reply": "chat reply text",
  "updatedPlan": null,
  "nutritionDraft": null,
  "coachActions": []
}

If you are changing the plan:
{
  "reply": "chat reply text explaining this needs approval",
  "updatedPlan": { ...full updated plan object... },
  "nutritionDraft": null,
  "coachActions": [
    {
      "id": "plan-update-1",
      "type": "plan_update",
      "status": "pending",
      "title": "Update your plan?",
      "summary": "Short change summary",
      "reason": "Why this is sensible",
      "dateKey": "YYYY-MM-DD if relevant",
      "targetId": "active plan id if known",
      "before": {},
      "after": {},
      "payload": {}
    }
  ]
}

If you are preparing a nutrition item for approval:
{
  "reply": "chat reply text telling the user to review and approve the estimate",
  "updatedPlan": null,
  "nutritionDraft": {
    "title": "Flat white",
    "mealType": "Snack",
    "calories": 120,
    "protein": 6,
    "carbs": 10,
    "fat": 6,
    "servingText": "1 regular cup",
    "notes": "Estimated from a typical flat white.",
    "source": "coach_chat"
  },
  "coachActions": []
}

Allowed coachActions types:
- plan_update: proposed active plan/schedule update. Payload may include updatedPlan, planId, planCollection.
- meal_log: proposed meal. Payload must include title, mealType, calories, protein, carbs, fat, servingText, notes, source.
- session_edit: proposed simple saved session edit. Payload must include targetCollection ("sessionLogs" or "trainSessions"), targetId, and updates.
- memory_save: proposed coach memory. Payload must include text and category.
      `.trim();

      const liveContextFacts = buildLiveContextFacts(mergedContext, latestUserText);
      const openAiRequestStartedAt = Date.now();
      try {
        const { completion, responseSource } = await createCoachChatCompletionWithRetry({
          openai,
          primaryModel: coachChatModel,
          fallbackModel: OPENAI_FALLBACK_MODEL,
          systemPrompt,
          mergedContext,
          liveContextFacts,
          plan,
          planSummary,
          trimmedMessages,
        });

        const raw = completionContent(completion);
        const parsed = preparePlanActionResponse(extractJsonObject(raw), plan);

        const reply =
          typeof parsed?.reply === "string" && parsed.reply.trim()
            ? parsed.reply.trim()
            : raw || buildLocalCoachFallbackReply(latestUserText, mergedContext);

        const updatedPlan =
          parsed && Object.prototype.hasOwnProperty.call(parsed, "updatedPlan")
            ? parsed.updatedPlan
            : null;
        const nutritionDraft =
          parsed && Object.prototype.hasOwnProperty.call(parsed, "nutritionDraft")
            ? parsed.nutritionDraft
            : null;
        const coachActions = Array.isArray(parsed?.coachActions)
          ? parsed.coachActions.filter((action) => action && typeof action === "object")
          : [];
        const safeUpdatedPlan =
          updatedPlan && typeof updatedPlan === "object" ? updatedPlan : null;
        const safeNutritionDraft =
          nutritionDraft && typeof nutritionDraft === "object" ? nutritionDraft : null;
        const policyViolation =
          !safeUpdatedPlan && !safeNutritionDraft && coachActions.length === 0
            ? coachChatReplyPolicyViolation(reply, latestUserText, mergedContext)
            : null;

        if (policyViolation) {
          const fallbackReply = buildLocalCoachFallbackReply(latestUserText, mergedContext);
          const fallbackRaw = JSON.stringify({
            reply: fallbackReply,
            updatedPlan: null,
            nutritionDraft: null,
            coachActions: [],
            source: "ai_policy_fallback",
            originalResponseSource: responseSource,
            policyViolation,
            originalReplyPreview: reply.slice(0, 500),
          });

          console.warn("[coach-chat] AI reply replaced by policy fallback", {
            responseSource,
            policyViolation,
            latestUserText: latestUserText.slice(0, 240),
            originalReplyPreview: reply.slice(0, 240),
          });

          return sendCoachResponse(
            res,
            {
              reply: fallbackReply,
              updatedPlan: null,
              nutritionDraft: null,
              coachActions: [],
              raw: fallbackRaw,
            },
            {
              ...responseDiagnosticsBase,
              responseSource: "ai_policy_fallback",
            }
          );
        }

        return sendCoachResponse(
          res,
          {
            reply,
            updatedPlan: safeUpdatedPlan,
            nutritionDraft: safeNutritionDraft,
            coachActions,
            raw,
          },
          {
            ...responseDiagnosticsBase,
            responseSource,
          }
        );
      } catch (openAiError) {
        const reply = openAiError?.code === 'PLAN_EDIT_INVALID'
          ? "I couldn't prepare a valid plan change, so nothing has been saved. Please ask me again with the session date and the duration you want."
          : buildLocalCoachFallbackReply(latestUserText, mergedContext);
        const raw = JSON.stringify({
          reply,
          updatedPlan: null,
          nutritionDraft: null,
          coachActions: [],
          source: "local_fallback",
          openAiError: openAIErrorInfo(openAiError),
        });
        console.warn("[coach-chat] returning local fallback after OpenAI failures", {
          elapsedMs: Date.now() - openAiRequestStartedAt,
          error: openAIErrorInfo(openAiError),
          fallbackBytes: byteSize(reply),
        });

        return sendCoachResponse(
          res,
          {
            reply,
            updatedPlan: null,
            nutritionDraft: null,
            coachActions: [],
            raw,
          },
          {
            ...responseDiagnosticsBase,
            responseSource: "local_fallback",
            openAiError,
          }
        );
      }
    } catch (err) {
      console.error("[coach-chat] error:", err);
      const fallbackMessage = fallbackMessageFromRequestBody(req.body || {});
      if (fallbackMessage) {
        const fallbackContext = fallbackContextFromRequestBody(req.body || {});
        const payload = buildCoachChatFallbackResponse(fallbackMessage, fallbackContext, err);
        console.warn("[coach-chat] returning route-level local fallback after error", {
          error: openAIErrorInfo(err),
          fallbackBytes: byteSize(payload.reply),
        });
        return sendCoachResponse(res, payload, {
          responseSource: "local_fallback",
          latestUserText: fallbackMessage,
          context: fallbackContext,
          previousConversationHas30MinPrompt: previousConversationHasLimitedTimePrompt(
            Array.isArray(req.body?.messages) ? req.body.messages : [],
            fallbackMessage
          ),
          openAiError: err,
        });
      }
      return res.status(500).json({
        error: "Something went wrong in coach-chat.",
        details: err?.message || String(err),
      });
    }
  });

  return router;
}
