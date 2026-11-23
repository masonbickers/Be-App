// server/routes/nutrition.js
import express from "express";
import {
  getFoodDetailsCached,
  searchFoodsCached,
} from "../lib/nutrition/foodCatalogCache.js";

/* ----------------------------------------------------------------------------
   Helpers
---------------------------------------------------------------------------- */

// calorie calc from macros (always used to enforce consistency)
function macroCalories(p, c, f) {
  const pp = Number.isFinite(p) ? p : 0;
  const cc = Number.isFinite(c) ? c : 0;
  const ff = Number.isFinite(f) ? f : 0;
  return Math.round(pp * 4 + cc * 4 + ff * 9);
}

// Fallback used if OpenAI fails
function makeDummyFromText(text) {
  const baseTitle =
    text && text.trim().length ? text.trim().slice(0, 80) : "Quick logged meal";

  // neutral “average meal” assumption
  const calories = 350;

  const protein = Math.round((calories * 0.25) / 4);
  const carbs = Math.round((calories * 0.5) / 4);
  const fat = Math.round((calories * 0.25) / 9);

  return {
    title: baseTitle,
    calories,
    protein,
    carbs,
    fat,
    fibre: 4,
    sugar: 8,
    saturatedFat: 3,
    polyunsaturatedFat: 2,
    monounsaturatedFat: 4,
    transFat: 0,
    cholesterol: 60, // mg
    sodium: 300, // mg
    potassium: 350, // mg
    vitaminA: 150, // µg RAE (approx)
    vitaminC: 10, // mg
    calcium: 80, // mg
    iron: 2, // mg
    notes:
      "Fallback estimate generated without full model response. Adjust based on portion size and label data if available.",
  };
}

// Normalise + correct OpenAI output
function normaliseNutrition(entry) {
  if (!entry) return entry;

  let {
    calories,
    protein = 0,
    carbs = 0,
    fat = 0,
    fibre,
    sugar,
    saturatedFat,
    polyunsaturatedFat,
    monounsaturatedFat,
    transFat,
    cholesterol,
    sodium,
    potassium,
    vitaminA,
    vitaminC,
    calcium,
    iron,
    title,
    notes,
  } = entry;

  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  protein = toNum(protein);
  carbs = toNum(carbs);
  fat = toNum(fat);

  // calories always derived from macros for consistency
  const derived = macroCalories(protein, carbs, fat);
  calories = derived > 0 ? derived : toNum(calories);

  fibre = fibre != null ? toNum(fibre) : undefined;
  sugar = sugar != null ? toNum(sugar) : undefined;

  saturatedFat = saturatedFat != null ? toNum(saturatedFat) : undefined;
  polyunsaturatedFat =
    polyunsaturatedFat != null ? toNum(polyunsaturatedFat) : undefined;
  monounsaturatedFat =
    monounsaturatedFat != null ? toNum(monounsaturatedFat) : undefined;
  transFat = transFat != null ? toNum(transFat) : undefined;

  cholesterol = cholesterol != null ? toNum(cholesterol) : undefined;
  sodium = sodium != null ? toNum(sodium) : undefined;
  potassium = potassium != null ? toNum(potassium) : undefined;

  vitaminA = vitaminA != null ? toNum(vitaminA) : undefined;
  vitaminC = vitaminC != null ? toNum(vitaminC) : undefined;
  calcium = calcium != null ? toNum(calcium) : undefined;
  iron = iron != null ? toNum(iron) : undefined;

  return {
    title: title || "Logged meal",
    calories: Math.round(calories),
    protein: Math.round(protein),
    carbs: Math.round(carbs),
    fat: Math.round(fat),

    // fibre / sugar
    fibre: fibre != null ? Math.round(fibre) : undefined,
    sugar: sugar != null ? Math.round(sugar) : undefined,

    // fat breakdown (g)
    saturatedFat: saturatedFat != null ? Math.round(saturatedFat) : undefined,
    polyunsaturatedFat:
      polyunsaturatedFat != null
        ? Math.round(polyunsaturatedFat)
        : undefined,
    monounsaturatedFat:
      monounsaturatedFat != null ? Math.round(monounsaturatedFat) : undefined,
    transFat: transFat != null ? Math.round(transFat) : undefined,

    // cholesterol / electrolytes / minerals (mg-ish)
    cholesterol: cholesterol != null ? Math.round(cholesterol) : undefined,
    sodium: sodium != null ? Math.round(sodium) : undefined,
    potassium: potassium != null ? Math.round(potassium) : undefined,

    // vitamins & minerals
    vitaminA: vitaminA != null ? Math.round(vitaminA) : undefined,
    vitaminC: vitaminC != null ? Math.round(vitaminC) : undefined,
    calcium: calcium != null ? Math.round(calcium) : undefined,
    iron: iron != null ? Math.round(iron) : undefined,

    notes: notes || "",
  };
}

function parseJsonObjectLoose(content, fallback = {}) {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return content;
  }
  if (typeof content !== "string" || !content.trim()) return fallback;

  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : fallback;
  } catch {
    // Continue to loose extraction below.
  }

  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return fallback;

  try {
    const parsed = JSON.parse(match[0]);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : fallback;
  } catch {
    return fallback;
  }
}

function formatHourMinute(isoLike) {
  const d = new Date(isoLike || Date.now());
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fallbackAnalyseDay({ goal, totals }) {
  const goalCals = safeNumber(goal?.dailyCalories, 0);
  const cals = safeNumber(totals?.calories, 0);
  const protein = safeNumber(totals?.protein, 0);
  const carbs = safeNumber(totals?.carbs, 0);
  const fat = safeNumber(totals?.fat, 0);

  if (!cals && !protein && !carbs && !fat) {
    return "No intake logged yet. Start with a balanced meal and build from there.";
  }

  const bits = [];
  if (goalCals > 0) {
    const pct = Math.round((cals / goalCals) * 100);
    if (pct < 80) bits.push("Energy is trending low versus your daily target.");
    else if (pct > 120)
      bits.push("Energy is trending high versus your daily target.");
    else bits.push("Energy is broadly aligned with your daily target.");
  }

  if (protein < 90) bits.push("Protein likely needs another quality serving.");
  if (carbs < 150) bits.push("Carb intake may be low for performance and recovery.");
  if (fat > 120) bits.push("Fat intake is quite high; trim dense extras later.");

  if (!bits.length) {
    bits.push("Intake looks balanced so far. Keep meals steady and protein anchored.");
  }

  return bits.slice(0, 3).join(" ");
}

function fallbackTrainingMatchLegacy({
  goal,
  totals,
  dayProgressPct,
  nowISO,
  foodQuality,
  mealTiming,
}) {
  const goalCals = safeNumber(goal?.dailyCalories, 0);
  const cals = safeNumber(totals?.calories, 0);
  const protein = safeNumber(totals?.protein, 0);
  const carbs = safeNumber(totals?.carbs, 0);
  const pct = clamp(safeNumber(dayProgressPct, 1), 0.05, 1);
  const useSoFar = pct < 0.995;
  const expectedPct = clamp(Math.pow(pct, 0.85), 0.1, 1);
  const expectedCals = goalCals > 0 ? Math.round(goalCals * expectedPct) : 0;

  const compareTarget = goalCals > 0 ? (useSoFar ? expectedCals : goalCals) : 0;
  const diffRatio =
    compareTarget > 0 ? (cals - compareTarget) / Math.max(1, compareTarget) : 0;
  const absDiff = Math.abs(diffRatio);

  let grade = "B";
  if (absDiff <= 0.12) grade = "A";
  else if (absDiff <= 0.22) grade = "B";
  else if (absDiff <= 0.38) grade = "C";
  else grade = "D";

  let summary = "Fuel is mostly aligned with training demands.";
  if (grade === "A")
    summary = "Fueling is well aligned with the demands of your day.";
  if (grade === "C")
    summary = "Fueling is somewhat mismatched; tighten timing and carb intake.";
  if (grade === "D")
    summary =
      "Fueling is significantly mismatched and may hurt training quality or recovery.";

  const tips = [];
  if (goalCals > 0) {
    if (diffRatio < -0.2) {
      tips.push("Add a carb + protein meal now to close the energy gap.");
    } else if (diffRatio > 0.2) {
      tips.push("Keep remaining meals lighter and protein-focused.");
    } else {
      tips.push("Keep portions steady to stay on target.");
    }
  }

  if (protein < 90) tips.push("Aim for another 25–40g protein serving today.");
  if (carbs < 160) tips.push("Add practical carbs around training and recovery.");

  const fq = String(foodQuality?.grade || "").toUpperCase();
  if (fq === "C" || fq === "D") {
    tips.push("Swap one ultra-processed item for whole-food carbs + fruit/veg.");
  }

  const loggedParts = Array.isArray(mealTiming?.filledParts)
    ? mealTiming.filledParts.length
    : 0;
  if (loggedParts <= 1) {
    tips.push("Spread intake across more of the day to improve timing.");
  }

  const clock = formatHourMinute(nowISO);
  const dayType = useSoFar ? `So far (${clock || "now"})` : "That day";
  const timeMeta = goalCals
    ? `Expected by now: ~${expectedCals} kcal`
    : "Set a calorie goal for tighter fuel matching.";

  return {
    grade,
    dayType,
    summary,
    tips: tips.slice(0, 4),
    timeMeta,
  };
}

/* ----------------------------------------------------------------------------
   Fuel Match helpers
---------------------------------------------------------------------------- */

function safeNumber(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function safeIso(d) {
  if (!d) return null;
  try {
    const x = new Date(d);
    return Number.isNaN(x.getTime()) ? null : x.toISOString();
  } catch {
    return null;
  }
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function parseMealTimeIso(meal) {
  // support either ISO strings or Firestore Timestamp objects passed from client
  const raw = meal?.date || meal?.time || meal?.timestamp;
  if (!raw) return null;

  // if client already serialised Timestamp.toISOString()
  if (typeof raw === "string") return safeIso(raw);

  // if they accidentally send {seconds, nanoseconds}
  if (raw?.seconds) return safeIso(raw.seconds * 1000);

  return null;
}

function parseSessionStartIso(s) {
  const raw = s?.startTime || s?.start || s?.startISO || s?.time;
  if (!raw) return null;
  if (typeof raw === "string") return safeIso(raw);
  if (raw?.seconds) return safeIso(raw.seconds * 1000);
  return null;
}

function minutesBetween(aIso, bIso) {
  const a = new Date(aIso).getTime();
  const b = new Date(bIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 60000);
}

function summariseTrainingLoad(sessions = []) {
  // simple heuristic: points by type + intensity + duration
  let points = 0;

  for (const s of sessions) {
    const type = String(s?.type || "").toLowerCase();
    const intensity = String(s?.intensity || "").toLowerCase();
    const dur = safeNumber(s?.durationMin, safeNumber(s?.duration, 0));

    let typeMult = 1.0;
    if (type.includes("run")) typeMult = 1.2;
    if (type.includes("interval") || type.includes("speed")) typeMult = 1.35;
    if (type.includes("tempo") || type.includes("threshold")) typeMult = 1.3;
    if (type.includes("hyrox")) typeMult = 1.25;
    if (type.includes("strength")) typeMult = 1.05;

    let intMult = 1.0;
    if (intensity.includes("easy")) intMult = 0.9;
    if (intensity.includes("moderate")) intMult = 1.0;
    if (intensity.includes("hard")) intMult = 1.2;
    if (intensity.includes("max") || intensity.includes("very hard"))
      intMult = 1.3;

    points += dur * typeMult * intMult;
  }

  // bucket it
  if (points <= 0) return { bucket: "none", points: 0 };
  if (points < 50) return { bucket: "light", points: Math.round(points) };
  if (points < 90) return { bucket: "moderate", points: Math.round(points) };
  return { bucket: "high", points: Math.round(points) };
}

function fallbackFuelMatch({ goal, totals, meals, sessions, nowLocalISO }) {
  const goalCals = safeNumber(goal?.dailyCalories, 0);
  const cals = safeNumber(totals?.calories, 0);
  const protein = safeNumber(totals?.protein, 0);
  const carbs = safeNumber(totals?.carbs, 0);

  const load = summariseTrainingLoad(sessions);
  const hasTraining = Array.isArray(sessions) && sessions.length > 0;

  // grade heuristic
  let grade = "C";
  let summary = "Decent base, but fuel timing and carbs could be smarter.";
  let timing =
    "Try to place most carbs around your session (pre/intra/post) rather than late random snacking.";
  let actions = [
    "Aim for 25–40g protein per meal.",
    "Add a carb portion around training (rice, oats, potatoes, fruit).",
    "Include fruit/veg and fluids + electrolytes.",
  ];

  // calorie alignment
  if (goalCals > 0 && cals > 0) {
    const diff = Math.abs(cals - goalCals) / goalCals;
    if (diff <= 0.1) grade = "B";
    if (diff <= 0.06) grade = "A";
    if (diff > 0.25) grade = "D";
  }

  // load adjustments
  if (load.bucket === "high") {
    summary =
      "High training day: prioritise carbs and recovery protein to match demand.";
    actions = [
      "Pre: 30–60g carbs 1–3h before training.",
      "Post: 25–40g protein + 60–90g carbs within 2h.",
      "Hydrate: add electrolytes if you sweat heavily.",
    ];
    if (carbs < 200) grade = grade === "A" ? "B" : grade; // likely under-fuelled
  } else if (!hasTraining) {
    summary =
      "Rest day: keep protein high and carbs matched to appetite and steps.";
    actions = [
      "Keep protein consistent (25–40g per meal).",
      "Choose higher-fibre carbs and fruit/veg.",
      "Don’t force huge carbs late if no training.",
    ];
    timing =
      "On rest days, spread meals evenly and avoid big sugar hits late evening.";
  }

  // crude time-of-day note
  const now = new Date(nowLocalISO || Date.now());
  const hour = Number.isNaN(now.getTime()) ? null : now.getHours();
  let timeNote = "";
  if (hour != null) {
    if (hour < 11) timeNote = "Morning check: think pre-fuel if training later.";
    else if (hour < 16)
      timeNote = "Midday check: ensure carbs/protein before afternoon training.";
    else timeNote = "Evening check: prioritise recovery + avoid late junk calories.";
  }

  return {
    grade,
    summary,
    timing,
    targets: {
      carbs_g_per_kg:
        load.bucket === "high"
          ? "5–7"
          : load.bucket === "moderate"
          ? "4–6"
          : "3–5",
      protein_g_per_kg: "1.6–2.2",
      pre_fuel: "30–60g carbs + 10–20g protein 1–3h pre",
      intra_fuel: load.bucket === "high" ? "30–60g carbs per hour if >75min" : "Not needed for short sessions",
      post_fuel: "25–40g protein + carbs to restore glycogen",
    },
    actions,
    notes: timeNote,
    meta: {
      trainingLoad: load,
      totals: { calories: cals, protein, carbs },
      mealsCount: Array.isArray(meals) ? meals.length : 0,
      sessionsCount: Array.isArray(sessions) ? sessions.length : 0,
    },
  };
}

/* ----------------------------------------------------------------------------
   Factory – inject OpenAI instance from index.js
---------------------------------------------------------------------------- */

export default function createNutritionRoutes(openai, { fetchProduct = fetch, barcodeTimeoutMs = 8000 } = {}) {
  const router = express.Router();
  // ---------------------------------------------------------------------------
  // /nutrition/search — unified global food search (deterministic providers)
  // ---------------------------------------------------------------------------
  router.get("/search", async (req, res) => {
    try {
      const q = String(req.query.q || "").trim();
      if (!q || q.length < 2) return res.json({ results: [] });

      const { results, cacheMeta } = await searchFoodsCached({
        query: q,
        limit: 30,
      });
      return res.json({ results, cacheMeta });
    } catch (err) {
      console.error("[nutrition/search] error", err);
      return res.status(500).json({
        error: "Failed to search foods",
        detail: err?.message,
      });
    }
  });

  // ---------------------------------------------------------------------------
  // /nutrition/food-details — deterministic per-serving/per-100g nutrients
  // ---------------------------------------------------------------------------
  router.get("/food-details", async (req, res) => {
    try {
      const provider = String(req.query.provider || "").trim();
      const id = String(req.query.id || "").trim();
      const name = String(req.query.name || "").trim();

      if (!id && !name) {
        return res.status(400).json({
          error: "Missing id or name query parameter",
        });
      }

      const details = await getFoodDetailsCached({ provider, id, name });
      return res.json(details);
    } catch (err) {
      console.error("[nutrition/food-details] error", err);
      const message = String(err?.message || "");
      const status = /not found|no matching food/i.test(message) ? 404 : 500;
      return res.status(status).json({
        error: "Failed to load food details",
        detail: err?.message,
      });
    }
  });

  // ---------------------------------------------------------------------------
  // /nutrition/estimate-macros — from meal photo
  // ---------------------------------------------------------------------------
  router.post("/estimate-macros", async (req, res) => {
    const { imageBase64 } = req.body || {};

    if (!imageBase64 || typeof imageBase64 !== "string") {
      return res.status(400).json({ error: "imageBase64 is required" });
    }

    // No OpenAI – fallback
    if (!openai)
      return res.json(normaliseNutrition(makeDummyFromText("Photo meal")));

    try {
      const systemPrompt = `
You are a UK/EU clinical nutrition estimator.

Input: a PHOTO of a meal.
You MUST:
- Identify all major ingredients.
- Estimate realistic portion sizes in grams or millilitres.
- Use typical UK/EU food composition averages (e.g. UK labels / EU tables).
- Derive macros (protein, carbohydrates, fat).
- Recalculate calories using: calories = protein*4 + carbs*4 + fat*9.
- Also estimate:
  - fibre, sugar
  - saturated fat, polyunsaturated fat, monounsaturated fat, trans fat
  - cholesterol
  - sodium, potassium
  - vitamin A, vitamin C, calcium, iron
- Be conservative but realistic with high-calorie ingredients (sauces, oils, dressings).

Return ONLY valid JSON in the format:
{
  "title": "short human-readable description",
  "calories": <number>,
  "protein": <number>,              // grams
  "carbs": <number>,                // grams
  "fat": <number>,                  // grams
  "fibre": <number>,                // grams (approx),
  "sugar": <number>,                // grams,
  "saturatedFat": <number>,         // grams,
  "polyunsaturatedFat": <number>,   // grams,
  "monounsaturatedFat": <number>,   // grams,
  "transFat": <number>,             // grams,
  "cholesterol": <number>,          // mg,
  "sodium": <number>,               // mg,
  "potassium": <number>,            // mg,
  "vitaminA": <number>,             // µg RAE approx,
  "vitaminC": <number>,             // mg,
  "calcium": <number>,              // mg,
  "iron": <number>,                 // mg,
  "notes": "very short explanation of key assumptions (portion sizes, sauces, drinks, etc.)"
}
`.trim();

      const resp = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: systemPrompt }],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Estimate total macros, calories and micronutrients for this meal using UK/EU values.",
              },
              {
                type: "input_image",
                image_url: `data:image/jpeg;base64,${imageBase64}`,
              },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "MealEstimate",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                calories: { type: "number" },
                protein: { type: "number" },
                carbs: { type: "number" },
                fat: { type: "number" },
                fibre: { type: "number" },
                sugar: { type: "number" },
                saturatedFat: { type: "number" },
                polyunsaturatedFat: { type: "number" },
                monounsaturatedFat: { type: "number" },
                transFat: { type: "number" },
                cholesterol: { type: "number" },
                sodium: { type: "number" },
                potassium: { type: "number" },
                vitaminA: { type: "number" },
                vitaminC: { type: "number" },
                calcium: { type: "number" },
                iron: { type: "number" },
                notes: { type: "string" },
              },
              required: ["title", "calories", "protein", "carbs", "fat"],
            },
          },
        },
      });

      const jsonText = resp.output_text || "{}";
      let raw;
      try {
        raw = JSON.parse(jsonText);
      } catch {
        raw = null;
      }

      return raw
        ? res.json(normaliseNutrition(raw))
        : res.json(normaliseNutrition(makeDummyFromText("Photo meal")));
    } catch (err) {
      console.error("[nutrition/estimate-macros] error", err);
      return res.json(normaliseNutrition(makeDummyFromText("Photo meal")));
    }
  });

  // ---------------------------------------------------------------------------
  // /nutrition/describe-meal — from text description
  // ---------------------------------------------------------------------------
  router.post("/describe-meal", async (req, res) => {
    const { text } = req.body || {};
    if (!text || typeof text !== "string")
      return res.status(400).json({ error: "text is required" });

    if (!openai) return res.json(normaliseNutrition(makeDummyFromText(text)));

    try {
      const systemPrompt = `
You are a UK/EU-trained nutrition estimator.

Input: a free-text description of a meal or snack.

You MUST:
- Identify the main ingredients and typical UK/EU portion sizes.
- Use realistic serving sizes (e.g. 1 bagel, 30g whey, 250ml milk, 1 medium banana).
- Apply typical UK/EU nutritional averages (food labels / composition tables).
- Derive total protein, carbs, and fat in grams.
- Recalculate calories using: calories = protein*4 + carbs*4 + fat*9.
- Also estimate:
  - fibre, sugar
  - saturated fat, polyunsaturated fat, monounsaturated fat, trans fat
  - cholesterol
  - sodium, potassium
  - vitamin A, vitamin C, calcium, iron

Return ONLY valid JSON in the exact format:
{
  "title": "short description of the meal",
  "calories": <number>,
  "protein": <number>,
  "carbs": <number>,
  "fat": <number>,
  "fibre": <number>,
  "sugar": <number>,
  "saturatedFat": <number>,
  "polyunsaturatedFat": <number>,
  "monounsaturatedFat": <number>,
  "transFat": <number>,
  "cholesterol": <number>,
  "sodium": <number>,
  "potassium": <number>,
  "vitaminA": <number>,
  "vitaminC": <number>,
  "calcium": <number>,
  "iron": <number>,
  "notes": "brief explanation of assumptions (portion sizes, sauces, drinks, etc.)"
}
`.trim();

      const resp = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: systemPrompt }],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `Meal description (UK/EU context): ${text}`,
              },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "MealFromText",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                calories: { type: "number" },
                protein: { type: "number" },
                carbs: { type: "number" },
                fat: { type: "number" },
                fibre: { type: "number" },
                sugar: { type: "number" },
                saturatedFat: { type: "number" },
                polyunsaturatedFat: { type: "number" },
                monounsaturatedFat: { type: "number" },
                transFat: { type: "number" },
                cholesterol: { type: "number" },
                sodium: { type: "number" },
                potassium: { type: "number" },
                vitaminA: { type: "number" },
                vitaminC: { type: "number" },
                calcium: { type: "number" },
                iron: { type: "number" },
                notes: { type: "string" },
              },
              required: [
                "title",
                "calories",
                "protein",
                "carbs",
                "fat",
                "fibre",
                "sugar",
                "saturatedFat",
                "polyunsaturatedFat",
                "monounsaturatedFat",
                "transFat",
                "cholesterol",
                "sodium",
                "potassium",
                "vitaminA",
                "vitaminC",
                "calcium",
                "iron",
                "notes",
              ],
            },
          },
        },
      });

      const jsonText = resp.output_text || "{}";
      let raw;
      try {
        raw = JSON.parse(jsonText);
      } catch {
        raw = null;
      }

      return raw
        ? res.json(normaliseNutrition(raw))
        : res.json(normaliseNutrition(makeDummyFromText(text)));
    } catch (err) {
      console.error("[nutrition/describe-meal] error", err);
      return res.json(normaliseNutrition(makeDummyFromText(text)));
    }
  });

  // ---------------------------------------------------------------------------
  // /nutrition/analyse-day — short daily summary text (legacy compatibility)
  // ---------------------------------------------------------------------------
  router.post("/analyse-day", async (req, res) => {
    const { goal, totals } = req.body || {};

    if (!goal || !totals) {
      return res
        .status(400)
        .json({ error: "goal and totals are required in request body" });
    }

    const fallback = fallbackAnalyseDay({ goal, totals });
    if (!openai) return res.json({ analysis: fallback });

    try {
      const systemPrompt = `
You are a performance nutrition coach.
Given daily targets and totals consumed so far, write ONE concise coaching paragraph.
Rules:
- Focus only on calories/macros balance and practical next-step guidance.
- Keep it non-judgmental and specific.
- Max 60 words.
- Do not output markdown or bullets.
      `.trim();

      const payload = {
        goal: {
          dailyCalories: safeNumber(goal?.dailyCalories, 0),
          proteinTarget: safeNumber(goal?.proteinTarget ?? goal?.proteinG, 0),
          carbTarget: safeNumber(
            goal?.carbTarget ?? goal?.carbsG ?? goal?.carbG,
            0
          ),
          fatTarget: safeNumber(goal?.fatTarget ?? goal?.fatG, 0),
        },
        totals: {
          calories: safeNumber(totals?.calories, 0),
          protein: safeNumber(totals?.protein, 0),
          carbs: safeNumber(totals?.carbs, 0),
          fat: safeNumber(totals?.fat, 0),
        },
      };

      const response = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: [
          { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
          {
            role: "user",
            content: [{ type: "input_text", text: JSON.stringify(payload) }],
          },
        ],
      });

      const analysis = String(response.output_text || "").trim() || fallback;
      return res.json({ analysis });
    } catch (err) {
      console.error("[nutrition/analyse-day] error", err);
      return res.json({ analysis: fallback });
    }
  });

  // ---------------------------------------------------------------------------
  // /nutrition/plan-goal — daily calorie & macro targets
  // ---------------------------------------------------------------------------
  router.post("/plan-goal", async (req, res) => {
    const {
      sex = "male",
      age,
      heightCm,
      weightKg,
      activityLevel = "moderate",
      goalType = "maintenance",
      extraNotes = "",
    } = req.body || {};

    const ageNum = Number(age);
    const hNum = Number(heightCm);
    const wNum = Number(weightKg);

    const invalidAge = !Number.isFinite(ageNum) || ageNum < 12 || ageNum > 100;
    const invalidHeight = !Number.isFinite(hNum) || hNum < 120 || hNum > 230;
    const invalidWeight = !Number.isFinite(wNum) || wNum < 35 || wNum > 300;

    if (invalidAge || invalidHeight || invalidWeight) {
      return res.status(400).json({
        error:
          "Invalid inputs. Expected age 12-100, heightCm 120-230, weightKg 35-300.",
      });
    }

    const fallbackCalc = () => {
      const sexAdj = String(sex).toLowerCase().startsWith("f") ? -161 : 5;
      const bmr = 10 * wNum + 6.25 * hNum - 5 * ageNum + sexAdj;
      const mult =
        activityLevel === "sedentary"
          ? 1.2
          : activityLevel === "light"
          ? 1.375
          : activityLevel === "moderate"
          ? 1.55
          : 1.725;

      let cals = bmr * mult;
      if (goalType === "fat_loss") cals -= 400;
      if (goalType === "muscle_gain") cals += 250;
      cals = Math.max(1400, cals);

      const proteinG = Math.round(wNum * 2);
      const fatG = Math.round((0.25 * cals) / 9);
      const carbsG = Math.round((cals - proteinG * 4 - fatG * 9) / 4);

      return {
        dailyCalories: Math.round(cals),
        proteinG,
        carbsG,
        fatG,
        notes:
          "Calculated locally using Mifflin-St Jeor and standard activity multipliers.",
      };
    };

    if (!openai) return res.json(fallbackCalc());

    try {
      const systemPrompt = `
You are a UK/EU sports nutrition coach.

Given: sex, age, height (cm), weight (kg), activity level and goal type.
Use Mifflin-St Jeor BMR and realistic activity multipliers.
Adjust:
- fat_loss: ~400 kcal deficit
- muscle_gain: ~250 kcal surplus

Return ONLY:
{
  "dailyCalories": <number>,
  "proteinG": <number>,
  "carbsG": <number>,
  "fatG": <number>,
  "notes": "short explanation of reasoning"
}
`.trim();

      const userPrompt = {
        sex,
        age: ageNum,
        heightCm: hNum,
        weightKg: wNum,
        activityLevel,
        goalType,
        extraNotes,
      };

      const resp = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: [
          { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
          { role: "user", content: [{ type: "input_text", text: JSON.stringify(userPrompt) }] },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "NutritionGoal",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                dailyCalories: { type: "number" },
                proteinG: { type: "number" },
                carbsG: { type: "number" },
                fatG: { type: "number" },
                notes: { type: "string" },
              },
              required: ["dailyCalories", "proteinG", "carbsG", "fatG"],
            },
          },
        },
      });

      const jsonText = resp.output_text || "{}";
      let raw;
      try {
        raw = JSON.parse(jsonText);
      } catch {
        raw = null;
      }

      if (!raw) return res.json(fallbackCalc());

      return res.json({
        dailyCalories: Math.round(raw.dailyCalories),
        proteinG: Math.round(raw.proteinG),
        carbsG: Math.round(raw.carbsG),
        fatG: Math.round(raw.fatG),
        notes: raw.notes || "",
      });
    } catch (err) {
      console.error("[nutrition/plan-goal] error", err);
      return res.json(fallbackCalc());
    }
  });

  // ---------------------------------------------------------------------------
  // /nutrition/food-quality — short, real food-quality assessment (whole day)
  // ---------------------------------------------------------------------------
  router.post("/food-quality", async (req, res) => {
    try {
      const { goal, totals, meals } = req.body || {};

      if (!goal || !totals || !Array.isArray(meals)) {
        return res.status(400).json({
          error: "Missing goal, totals or meals in request body",
        });
      }

      const fallbackQuality = () => {
        const goalCals = Number(goal.dailyCalories || 0);
        const dayCals = Number(totals.calories || 0);

        let grade = "C";
        let summary = "Mixed day: some good choices, some weaker ones.";
        let detail =
          "- Push protein at each meal.\n" +
          "- Add more fruit/veg and high-fibre carbs.\n" +
          "- Trim obvious junk and liquid calories.";

        if (goalCals > 0 && dayCals > 0) {
          const diffRatio = Math.abs(dayCals - goalCals) / goalCals;
          if (diffRatio <= 0.08) {
            grade = "B";
            summary = "Calories near target, food quality okay overall.";
          } else if (diffRatio > 0.3) {
            grade = "D";
            summary = "Calories far from target, food quality needs work.";
          }
        }

        return { grade, summary, detail };
      };

      // No OpenAI – heuristic fallback
      if (!openai) {
        return res.json(fallbackQuality());
      }

      const systemPrompt = `
You are a sports nutrition coach assessing REAL FOOD QUALITY for a Hyrox/endurance athlete.

You receive:
- "goal": daily calorie + macro targets and preferences.
- "totals": actual daily intake (calories, protein, carbs, fat).
- "meals": array with titles, macros and notes.

Analyse ALL of this and focus on:
- How whole/ minimally processed vs ultra-processed the day is.
- Protein quality + spread through the day.
- Fibre / fruit / veg vs sugary snacks and desserts.
- Smart carb use around training vs random high-sugar hits.
- Obvious junk: takeaways, deep fried foods, sweets, pastries, alcohol, sugary drinks.

GRADE RULE OF THUMB:
- A: Mostly whole foods, high + well spread protein, good fruit/veg, close-ish to calories.
- B: Decent base, some processed/junk or slightly low protein/fibre.
- C: Lots of processed food OR low protein, limited fruit/veg.
- D: Very processed day, poor protein, far from calorie target.

Return STRICT JSON:
{
  "grade": "A" | "B" | "C" | "D",
  "summary": "ONE short sentence on overall food quality (max ~18 words).",
  "detail": "2–3 short bullets separated by \\n, each max ~12 words, with specific improvements."
}
Do NOT talk about training plan or unrelated advice. Only nutrition quality.
`.trim();

      const userContent = JSON.stringify({ goal, totals, meals }, null, 2);

      const completion = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Here is today's nutrition data:\n\n${userContent}`,
          },
        ],
        temperature: 0.2,
      });

      const content = completion.choices?.[0]?.message?.content;
      const parsed = parseJsonObjectLoose(content, {});

      const fb = fallbackQuality();

      const grade = parsed.grade || fb.grade;
      const summary = parsed.summary || fb.summary;
      const detail = parsed.detail || fb.detail;

      const responsePayload = { grade, summary, detail };

      console.log("[nutrition/food-quality] response", responsePayload);

      return res.json(responsePayload);
    } catch (err) {
      console.error("[nutrition/food-quality] error", err);
      return res.status(500).json({
        error: "Failed to generate food quality",
        detail: err?.message,
      });
    }
  });

  // ---------------------------------------------------------------------------
  // /nutrition/meal-quality — analyse a single FOOD item
  // ---------------------------------------------------------------------------
  router.post("/meal-quality", async (req, res) => {
    try {
      const { meal } = req.body || {};

      if (!meal) {
        return res.status(400).json({ error: "meal payload is required" });
      }

      const fallback = () => {
        return {
          grade: "B",
          summary: "Solid food choice overall with a few easy ways to improve.",
          detail:
            "- Good macro profile for most goals.\n" +
            "- Add fruit/veg or fibre alongside when possible.\n" +
            "- Use portion size to match calorie needs.",
        };
      };

      if (!openai) {
        return res.json(fallback());
      }

      const systemPrompt = `
You are a UK/EU sports nutrition coach.

You are analysing a SINGLE FOOD ITEM (or very simple combo), not a whole day.
Examples: "450g 0% Skyr yoghurt", "banana", "bagel with butter", "15g honey".

You receive a JSON object with:
- title (string)
- mealType (Breakfast/Lunch/Dinner/Snack or empty)
- calories, protein, carbs, fat (numbers)
- fibre, sugar, saturatedFat, polyunsaturatedFat, monounsaturatedFat, transFat
- cholesterol, sodium, potassium, vitaminA, vitaminC, calcium, iron
- notes (free-text assumptions or context)

Your job is to judge how good this FOOD is as a CHOICE for a hybrid / Hyrox athlete,
balancing both performance nutrition and satisfaction/enjoyment.

Consider:
- Is it mainly protein, carb or fat?
- How filling / satiating is it likely to be?
- When is it most useful? (e.g. post-training, pre-race, evening snack).
- Key upsides (e.g. high protein, micronutrient rich, low sugar).
- Key downsides (e.g. very calorie dense, mostly sugar, low protein).
- The role it can play:
  - everyday staple,
  - performance fuel,
  - or occasional “treat / satisfaction” food.

GRADE GUIDE (for this single food):
- A: Very strong everyday or performance choice in sensible portions.
- B: Decent choice with a couple of caveats (portions / context).
- C: Fine occasionally; limited benefit or easy to overdo.
- D: Mostly junk or very unhelpful if eaten regularly.

Return STRICT JSON:
{
  "grade": "A" | "B" | "C" | "D",
  "summary": "ONE clear sentence describing this FOOD as a choice (including its role).",
  "detail": "2–4 short bullets separated by \\n with pros, cons, when to use, how often."
}
`.trim();

      const userContent = JSON.stringify(meal, null, 2);

      const completion = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Here is the FOOD to analyse:\n\n${userContent}` },
        ],
        temperature: 0.25,
      });

      const content = completion.choices?.[0]?.message?.content;
      const parsed = parseJsonObjectLoose(content, {});

      const fb = fallback();

      const grade = parsed.grade || fb.grade;
      const summary = parsed.summary || fb.summary;
      const detail = parsed.detail || fb.detail;

      return res.json({ grade, summary, detail });
    } catch (err) {
      console.error("[nutrition/meal-quality] error", err);
      return res.status(500).json({
        error: "Failed to analyse food",
        detail: err?.message,
      });
    }
  });

  // ---------------------------------------------------------------------------
  // /nutrition/training-match — legacy compatibility shape used by older UI
  // ---------------------------------------------------------------------------
  router.post("/training-match", async (req, res) => {
    try {
      const {
        goal,
        totals,
        dayProgressPct,
        nowISO,
        foodQuality,
        mealTiming,
      } = req.body || {};

      if (!goal || !totals) {
        return res.status(400).json({
          error: "Missing goal or totals in request body",
        });
      }

      return res.json(
        fallbackTrainingMatchLegacy({
          goal,
          totals,
          dayProgressPct,
          nowISO,
          foodQuality,
          mealTiming,
        })
      );
    } catch (err) {
      console.error("[nutrition/training-match] error", err);
      return res.status(500).json({
        error: "Failed to generate training match",
        detail: err?.message,
      });
    }
  });

  // ---------------------------------------------------------------------------
  // /nutrition/barcode-lookup — basic barcode nutrition lookup
  // ---------------------------------------------------------------------------
  router.post("/barcode-lookup", async (req, res) => {
    try {
      const barcode = String(req.body?.barcode || "").trim();
      if (!/^\d{8,18}$/.test(barcode)) {
        return res.status(400).json({ error: "Valid numeric barcode is required" });
      }

      const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(
        barcode
      )}.json`;
      const response = await fetchProduct(url, { signal: AbortSignal.timeout(barcodeTimeoutMs) });
      if (!response.ok) {
        return res.status(503).json({ code: 'BARCODE_PROVIDER_UNAVAILABLE', error: 'Barcode lookup is unavailable. Enter this food manually.' });
      }

      const data = await response.json();
      const product = data?.product;
      if (!product || data?.status !== 1) {
        return res.status(404).json({ error: "No product found for barcode" });
      }

      const toNum = (v) => {
        if (v == null || String(v).trim() === '') return NaN;
        const n = Number(String(v).replace(",", "."));
        return Number.isFinite(n) && n >= 0 ? n : NaN;
      };
      const round = (n) => Math.round(n * 10) / 10;

      const n = product?.nutriments || {};

      const per100g = {
        calories: toNum(n["energy-kcal_100g"] ?? n.energy_kcal_100g),
        protein: toNum(n["proteins_100g"] ?? n.proteins_100g),
        carbs: toNum(n["carbohydrates_100g"] ?? n.carbohydrates_100g),
        fat: toNum(n["fat_100g"] ?? n.fat_100g),
      };

      if (Object.values(per100g).some(value => !Number.isFinite(value)) ||
        per100g.calories > 950 || per100g.protein + per100g.carbs + per100g.fat > 115) {
        return res.status(422).json({ code: 'NUTRITION_LABEL_INCOMPLETE', error: 'This barcode has incomplete nutrition information. Enter the label manually.' });
      }

      const servingRaw = String(product?.serving_size || "").trim();
      const servingMatch = servingRaw.match(/(\d+(?:[.,]\d+)?)\s*(g|ml)\b/i);
      const directServing = {
        calories: toNum(n['energy-kcal_serving'] ?? n.energy_kcal_serving),
        protein: toNum(n.proteins_serving),
        carbs: toNum(n.carbohydrates_serving),
        fat: toNum(n.fat_serving),
      };
      const directComplete = Object.values(directServing).every(Number.isFinite);
      const servingUnit = servingMatch?.[2]?.toLowerCase() || 'g';
      if (servingUnit === 'ml' && !directComplete) {
        return res.status(422).json({ code: 'NUTRITION_SERVING_UNCLEAR', error: 'This liquid serving cannot be verified from per-100g values. Enter the label manually.' });
      }
      const servingSizeG = servingMatch ? toNum(servingMatch[1]) : 0;
      const servingSize = servingSizeG > 0 ? servingSizeG : 100;
      const factor = servingSizeG > 0 ? servingSizeG / 100 : 1;

      const scaledServing = {
        calories: Math.round(per100g.calories * factor),
        protein: round(per100g.protein * factor),
        carbs: round(per100g.carbs * factor),
        fat: round(per100g.fat * factor),
      };
      const perServing = directComplete ? { ...directServing, calories: Math.round(directServing.calories) } : scaledServing;

      return res.json({
        title:
          product?.product_name_en ||
          product?.product_name ||
          product?.generic_name_en ||
          product?.generic_name ||
          "Food item",
        brand: product?.brands || "",
        servingSize,
        servingUnit,
        macrosPerServing: perServing,
        macrosPer100g: { ...per100g, calories: Math.round(per100g.calories) },
        nutritionComplete: true,
        source: "openfoodfacts",
        barcode,
      });
    } catch (err) {
      console.warn("[nutrition/barcode-lookup] unavailable", err?.name || err?.code || 'error');
      return res.status(503).json({ code: 'BARCODE_PROVIDER_UNAVAILABLE', error: 'Barcode lookup is unavailable. Enter this food manually.' });
    }
  });

  // ---------------------------------------------------------------------------
  // /nutrition/fuel-match — analyse food vs training (time-of-day aware)
  // ---------------------------------------------------------------------------
  router.post("/fuel-match", async (req, res) => {
    try {
      const { dateISO, timezone, nowLocalISO, goal, totals, meals, sessions } =
        req.body || {};

      if (!goal || !totals || !Array.isArray(meals) || !Array.isArray(sessions)) {
        return res.status(400).json({
          error: "Missing goal, totals, meals, or sessions in request body",
        });
      }

      // normalise meals/sessions a bit for robustness
      const safeMeals = meals.map((m) => {
        const iso = parseMealTimeIso(m) || null;
        return {
          title: String(m?.title || ""),
          mealType: String(m?.mealType || ""),
          calories: safeNumber(m?.calories, 0),
          protein: safeNumber(m?.protein, 0),
          carbs: safeNumber(m?.carbs, 0),
          fat: safeNumber(m?.fat, 0),
          notes: String(m?.notes || ""),
          timeISO: iso,
        };
      });

      const safeSessions = sessions.map((s) => {
        const startIso = parseSessionStartIso(s) || null;
        return {
          title: String(s?.title || "Session"),
          type: String(s?.type || "Training"),
          intensity: String(s?.intensity || ""),
          durationMin: safeNumber(s?.durationMin, safeNumber(s?.duration, 0)),
          distanceKm: safeNumber(s?.distanceKm, safeNumber(s?.distance, 0)),
          startTimeISO: startIso,
          endTimeISO: safeIso(s?.endTime || s?.endISO || null),
          notes: String(s?.notes || ""),
        };
      });

      const load = summariseTrainingLoad(safeSessions);

      // fallback response if no openai
      if (!openai) {
        return res.json(
          fallbackFuelMatch({
            goal,
            totals,
            meals: safeMeals,
            sessions: safeSessions,
            nowLocalISO,
          })
        );
      }

      const systemPrompt = `
You are a UK/EU performance nutrition coach for hybrid / Hyrox / endurance athletes.

Your task: Analyse "food vs training" for a SINGLE DAY, taking time-of-day into account.

You receive:
- goal: dailyCalories + macro targets (and potentially other preferences)
- totals: total calories/protein/carbs/fat consumed so far for that day
- meals: array of meals INCLUDING timeISO where available
- sessions: array of training sessions INCLUDING startTimeISO where available
- timezone and nowLocalISO for context

You MUST:
1) Evaluate whether the day is under-fuelled / well-fuelled / over-fuelled relative to training demand.
2) Evaluate timing:
   - Pre-fuel: carbs + protein before key session(s)
   - Intra: carbs during long/hard sessions (>75 min or hard)
   - Post: protein + carbs within ~2 hours after
   - Evening: avoid huge late calorie dump unless training late
3) Consider "current time":
   - If it's early day, give "so far" guidance (what to eat next).
   - If it's late day, give recovery guidance + tomorrow setup.
4) Give simple actionable recommendations with UK foods.

Return STRICT JSON ONLY:
{
  "grade": "A"|"B"|"C"|"D",
  "summary": "1 short sentence on overall fuel match.",
  "timing": "1–3 short lines explaining timing vs session(s).",
  "targets": {
    "carbs_g_per_kg": "range string, e.g. 4–6",
    "protein_g_per_kg": "range string, e.g. 1.6–2.2",
    "pre_fuel": "concise instruction",
    "intra_fuel": "concise instruction",
    "post_fuel": "concise instruction"
  },
  "actions": ["3–6 short bullet actions"],
  "notes": "OPTIONAL: 1 short line about current time-of-day context"
}

IMPORTANT:
- Use the provided sessions to infer training demand.
- If there are no sessions, treat it as a rest day and grade accordingly.
- Be realistic: do not prescribe extreme diets.
- Avoid medical claims.
`.trim();

      const userPayload = {
        dateISO,
        timezone,
        nowLocalISO,
        goal,
        totals,
        meals: safeMeals,
        sessions: safeSessions,
        trainingLoad: load,
      };

      const completion = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(userPayload, null, 2) },
        ],
        temperature: 0.2,
      });

      const content = completion.choices?.[0]?.message?.content || "{}";
      const parsed = parseJsonObjectLoose(content, {});

      // enforce shape + safe fallbacks
      const fb = fallbackFuelMatch({
        goal,
        totals,
        meals: safeMeals,
        sessions: safeSessions,
        nowLocalISO,
      });

      const grade = parsed.grade || fb.grade;
      const summary = parsed.summary || fb.summary;
      const timing = parsed.timing || fb.timing;

      const targets = parsed.targets || fb.targets;
      const actions =
        Array.isArray(parsed.actions) && parsed.actions.length
          ? parsed.actions.slice(0, 8)
          : fb.actions;

      const notes = parsed.notes || fb.notes;

      return res.json({
        grade,
        summary,
        timing,
        targets,
        actions,
        notes,
        meta: fb.meta, // includes trainingLoad + counts; helpful for debugging UI
      });
    } catch (err) {
      console.error("[nutrition/fuel-match] error", err);
      return res.status(500).json({
        error: "Failed to generate fuel match",
        detail: err?.message,
      });
    }
  });

  return router;
}
