import { Buffer } from "node:buffer";
import express from "express";

import admin from "../admin.js";
import { requireUser } from "../utils/requireUser.js";

const router = express.Router();

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstNonEmptyString(values, fallback = "") {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return fallback;
}

function formatGarminWorkoutTitle(title = "") {
  const base = String(title || "").trim() || "Workout";
  if (/\bwith\s+be\b/i.test(base) || /^be\b/i.test(base)) return base;
  return `${base} with BE`.slice(0, 120);
}

const TOKEN_ENDPOINT =
  process.env.GARMIN_TOKEN_ENDPOINT ||
  "https://diauth.garmin.com/di-oauth2-service/oauth/token";
const TRAINING_WORKOUT_BASE =
  process.env.GARMIN_WORKOUT_API_BASE ||
  "https://apis.garmin.com/training-api/workout";
const TRAINING_WORKOUT_CREATE_URL =
  process.env.GARMIN_WORKOUT_CREATE_URL ||
  `${String(TRAINING_WORKOUT_BASE).replace(/\/+$/, "")}`;

function mapDuration(step = {}) {
  const rawType = String(
    step?.durationType || step?.garmin?.durationType || ""
  ).toLowerCase();
  const unit = String(step?.durationUnit || step?.garmin?.durationUnit || "").toLowerCase();
  const rawValue =
    toNum(step?.durationValue) ??
    toNum(step?.garmin?.durationValue) ??
    toNum(step?.durationSec) ??
    0;

  const isDistance =
    rawType.includes("distance") ||
    rawType.includes("km") ||
    rawType.includes("meter") ||
    unit.includes("km") ||
    unit === "m";

  if (isDistance) {
    let km = rawValue;
    if (unit === "m" || rawType === "distance" || rawType.includes("meter")) {
      km = rawValue / 1000;
    }
    if (!Number.isFinite(km) || km <= 0) km = 1;
    return { durationType: "Distance (km)", durationValue: Number(km.toFixed(3)) };
  }

  let min = rawValue;
  if (unit.includes("sec") || rawType === "time") {
    min = rawValue / 60;
  }
  if (!Number.isFinite(min) || min <= 0) min = 1;
  return { durationType: "Time (min)", durationValue: Number(min.toFixed(2)) };
}

function mapIntensity(step = {}) {
  const stepType = String(step?.stepType || "").toLowerCase();
  if (stepType.includes("warm")) return "warmup";
  if (stepType.includes("cool")) return "cooldown";
  if (stepType.includes("recover") || stepType.includes("rest")) return "none";

  const intensity = String(step?.intensityType || step?.intensity || "").toLowerCase();
  if (intensity.includes("warm")) return "warmup";
  if (intensity.includes("cool")) return "cooldown";
  return "active";
}

function normaliseStep(step = {}) {
  const { durationType, durationValue } = mapDuration(step);
  return {
    type: firstNonEmptyString([step?.type, step?.title, step?.label], "Run"),
    notes: firstNonEmptyString([step?.notes, step?.description], ""),
    durationType,
    durationValue,
    intensityType: mapIntensity(step),
  };
}

function normaliseSteps(steps = []) {
  if (!Array.isArray(steps) || !steps.length) return [];

  return steps
    .map((step) => {
      if (!step || typeof step !== "object") return null;

      const repeatCount =
        toNum(step?.repeatReps) ??
        toNum(step?.repeatCount) ??
        toNum(step?.garmin?.repeatCount) ??
        0;
      const inner = Array.isArray(step?.steps) ? step.steps : [];
      const isRepeat =
        Boolean(step?.isRepeat) ||
        String(step?.stepType || "").toLowerCase() === "repeat" ||
        (inner.length > 0 && repeatCount > 1);

      if (isRepeat && inner.length > 0) {
        return {
          isRepeat: true,
          repeatReps: Math.max(2, Math.round(repeatCount || 2)),
          steps: normaliseSteps(inner),
        };
      }

      return normaliseStep(step);
    })
    .filter(Boolean);
}

function buildFitSession(workout = {}) {
  const steps = normaliseSteps(workout?.steps);
  if (steps.length) {
    return { segments: steps };
  }

  const totalDurationSec = toNum(workout?.totalDurationSec) ?? 0;
  const totalDistanceKm = toNum(workout?.totalDistanceKm) ?? 0;

  if (totalDistanceKm > 0) {
    return {
      segments: [
        {
          type: "Run",
          notes: "",
          durationType: "Distance (km)",
          durationValue: Number(totalDistanceKm.toFixed(3)),
          intensityType: "active",
        },
      ],
    };
  }

  const min = Math.max(1, Math.round(totalDurationSec / 60));
  return {
    segments: [
      {
        type: "Run",
        notes: "",
        durationType: "Time (min)",
        durationValue: min,
        intensityType: "active",
      },
    ],
  };
}

function normaliseSport(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "RUNNING";
  if (raw.includes("run")) return "RUNNING";
  if (raw.includes("cycl")) return "CYCLING";
  if (raw.includes("swim")) return "SWIMMING";
  if (raw.includes("walk")) return "WALKING";
  if (raw.includes("row")) return "ROWING";
  if (raw.includes("strength")) return "STRENGTH_TRAINING";
  return raw.toUpperCase();
}

function normaliseApiStep(step = {}) {
  if (!step || typeof step !== "object") return null;

  const innerSteps = Array.isArray(step?.steps)
    ? step.steps.map((item) => normaliseApiStep(item)).filter(Boolean)
    : [];

  const repeatCountRaw =
    toNum(step?.repeatCount) ??
    toNum(step?.repeatReps) ??
    toNum(step?.repeat) ??
    toNum(step?.reps) ??
    toNum(step?.garmin?.repeatCount) ??
    toNum(step?.garmin?.reps) ??
    0;

  const stepType = String(step?.stepType || step?.type || "").trim().toLowerCase();
  const isRepeat =
    Boolean(step?.isRepeat) ||
    stepType === "repeat" ||
    (innerSteps.length > 0 && repeatCountRaw > 1);

  if (isRepeat && innerSteps.length > 0) {
    return {
      stepType: "repeat",
      repeatCount: Math.max(2, Math.round(repeatCountRaw || 2)),
      steps: innerSteps,
      notes: firstNonEmptyString([step?.notes, step?.description], ""),
    };
  }

  return {
    ...step,
    steps: innerSteps,
  };
}

function isRepeatApiStep(step = {}) {
  if (!step || typeof step !== "object") return false;
  if (String(step?.stepType || step?.type || "").trim().toLowerCase() === "repeat") return true;
  return Array.isArray(step?.steps) && step.steps.length > 0 && Number(step?.repeatCount || 0) > 1;
}

function mapTrainingDuration(step = {}) {
  const duration = step?.duration && typeof step.duration === "object" ? step.duration : null;
  const durationTypeRaw = String(
    step?.durationType || step?.garmin?.durationType || duration?.type || ""
  )
    .trim()
    .toLowerCase();
  const durationUnit = String(
    step?.durationUnit || step?.garmin?.durationUnit || duration?.unit || ""
  )
    .trim()
    .toLowerCase();
  const rawValue =
    toNum(step?.durationValue) ??
    toNum(step?.garmin?.durationValue) ??
    toNum(duration?.seconds) ??
    toNum(duration?.meters) ??
    toNum(step?.durationSec) ??
    toNum(step?.durationMin) ??
    toNum(step?.distanceKm) ??
    null;

  if (
    durationTypeRaw === "time" ||
    durationTypeRaw === "time (min)" ||
    durationTypeRaw.includes("sec") ||
    durationUnit.includes("sec")
  ) {
    const sec =
      durationTypeRaw === "time (min)" || durationUnit === "min"
        ? Math.round((rawValue || 0) * 60)
        : Math.round(rawValue || 0);
    if (sec > 0) return { durationType: "TIME", durationValue: sec };
  }

  if (
    durationTypeRaw === "distance" ||
    durationTypeRaw === "distance (km)" ||
    durationTypeRaw.includes("meter") ||
    durationUnit === "m" ||
    durationUnit === "km"
  ) {
    const meters =
      durationTypeRaw === "distance (km)" || durationUnit === "km"
        ? Math.round((rawValue || 0) * 1000)
        : Math.round(rawValue || 0);
    if (meters > 0) return { durationType: "DISTANCE", durationValue: meters };
  }

  if (Number.isFinite(Number(step?.restSec)) && Number(step.restSec) > 0) {
    return { durationType: "TIME", durationValue: Math.round(Number(step.restSec)) };
  }

  return { durationType: "OPEN" };
}

function paceTextFromSecPerKm(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return null;
  const mins = Math.floor(n / 60);
  const secs = Math.round(n % 60);
  return `${mins}:${String(secs).padStart(2, "0")}/km`;
}

function paceRangeSummary(step = {}) {
  const min = toNum(step?.targetValue?.minSecPerKm);
  const max = toNum(step?.targetValue?.maxSecPerKm);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) return null;
  const fast = paceTextFromSecPerKm(min);
  const slow = paceTextFromSecPerKm(max);
  if (!fast || !slow) return null;
  return fast === slow ? `Pace ${fast}` : `Pace ${fast}-${slow}`;
}

function hrRangeSummary(step = {}) {
  const min = toNum(step?.targetValue?.minBpm ?? step?.targetValue?.min);
  const max = toNum(step?.targetValue?.maxBpm ?? step?.targetValue?.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) return null;
  return `HR ${Math.round(min)}-${Math.round(max)} bpm`;
}

function buildTrainingTarget(step = {}) {
  const targetType = String(step?.targetType || "").trim().toLowerCase();
  const hrMin = toNum(step?.targetValue?.minBpm ?? step?.targetValue?.min);
  const hrMax = toNum(step?.targetValue?.maxBpm ?? step?.targetValue?.max);
  if (
    (targetType.includes("hr") || (hrMin != null && hrMax != null)) &&
    Number.isFinite(hrMin) &&
    Number.isFinite(hrMax) &&
    hrMin > 0 &&
    hrMax > 0
  ) {
    const stepType = String(step?.stepType || step?.type || "").trim().toLowerCase();
    const inferredZone =
      stepType.includes("warm") || stepType.includes("cool") || stepType.includes("recover")
        ? 1
        : 2;
    return {
      targetType: "HEART_RATE",
      targetZone: inferredZone,
      targetValue: Math.round((hrMin + hrMax) / 2),
    };
  }

  const minSec = toNum(step?.targetValue?.minSecPerKm);
  const maxSec = toNum(step?.targetValue?.maxSecPerKm);
  if (
    targetType === "pace_range" &&
    Number.isFinite(minSec) &&
    Number.isFinite(maxSec) &&
    minSec > 0 &&
    maxSec > 0
  ) {
    const slowSpeed = 1000 / maxSec;
    const fastSpeed = 1000 / minSec;
    const targetValue = (slowSpeed + fastSpeed) / 2;
    return {
      targetType: "SPEED",
      targetValue: Number(targetValue.toFixed(3)),
    };
  }

  return { targetType: "OPEN" };
}

function mapTrainingIntensity(step = {}) {
  const stepType = String(step?.stepType || step?.type || "").trim().toLowerCase();
  if (stepType.includes("warm")) return "WARMUP";
  if (stepType.includes("cool")) return "COOLDOWN";
  if (stepType.includes("recover") || stepType.includes("rest")) return "RECOVERY";
  return "ACTIVE";
}

function mapTrainingStepType(step = {}) {
  const stepType = String(step?.stepType || step?.type || "").trim().toLowerCase();
  if (stepType.includes("warm")) return "Warmup";
  if (stepType.includes("cool")) return "Cooldown";
  if (stepType.includes("recover") || stepType.includes("rest")) return "Recovery";
  return "Main Set";
}

function buildTrainingDescription(step = {}) {
  const summaryParts = [
    firstNonEmptyString(
      [step?.description, step?.notes, step?.title, step?.name, step?.type, step?.label],
      ""
    ),
    paceRangeSummary(step),
    hrRangeSummary(step),
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  return firstNonEmptyString([summaryParts.join(" · ")], "").slice(0, 240);
}

function buildTrainingLeafStep(step = {}, stepOrder = 1) {
  const duration = mapTrainingDuration(step);
  const target = buildTrainingTarget(step);
  const payload = {
    type: "WorkoutStep",
    stepOrder,
    stepType: mapTrainingStepType(step),
    intensity: mapTrainingIntensity(step),
    targetType: target.targetType,
  };

  if (duration.durationType && duration.durationType !== "OPEN") {
    payload.durationType = duration.durationType;
    payload.durationValue = duration.durationValue;
  } else {
    payload.durationType = "OPEN";
  }

  if (target.targetType !== "OPEN") {
    if (target.targetValue != null) payload.targetValue = target.targetValue;
    if (target.targetZone != null) payload.targetZone = target.targetZone;
  }

  const description = buildTrainingDescription(step);
  if (description) payload.description = description;

  return payload;
}

function buildTrainingSteps(steps = []) {
  const list = Array.isArray(steps) ? steps : [];
  const built = [];

  for (const rawStep of list) {
    const step = normaliseApiStep(rawStep);
    if (!step) continue;

    if (isRepeatApiStep(step)) {
      const repeatCount = Math.max(1, Math.round(Number(step?.repeatCount || 1)));
      const innerRaw = Array.isArray(step?.steps) ? step.steps : [];
      const innerSteps = buildTrainingSteps(innerRaw);
      if (innerSteps.length) {
        for (let i = 0; i < repeatCount; i += 1) {
          for (const innerStep of innerSteps) {
            built.push({ ...innerStep, stepOrder: built.length + 1 });
          }
        }
      }
      continue;
    }

    built.push(buildTrainingLeafStep(step, built.length + 1));
  }

  return built;
}

function computeTrainingStepTotals(steps = []) {
  const totals = { durationSec: 0, distanceMeters: 0 };
  for (const step of steps) {
    const current = normaliseApiStep(step);
    if (!current) continue;
    if (isRepeatApiStep(current)) {
      const repeatCount = Math.max(1, Math.round(Number(current.repeatCount || 1)));
      const nestedTotals = computeTrainingStepTotals(current.steps || []);
      totals.durationSec += nestedTotals.durationSec * repeatCount;
      totals.distanceMeters += nestedTotals.distanceMeters * repeatCount;
      continue;
    }

    const duration = mapTrainingDuration(current);
    if (duration.durationType === "TIME" && Number.isFinite(duration.durationValue)) {
      totals.durationSec += Math.max(0, Math.round(duration.durationValue));
    }
    if (duration.durationType === "DISTANCE" && Number.isFinite(duration.durationValue)) {
      totals.distanceMeters += Math.max(0, Math.round(duration.durationValue));
    }
  }
  return totals;
}

function buildTrainingApiWorkoutPayload(workout = {}, { title = "Workout", sessionKey = "", scheduledDate = "" } = {}) {
  const normalizedSport = normaliseSport(workout?.sport || workout?.sessionType || "running");
  const baseSteps = Array.isArray(workout?.steps)
    ? workout.steps.map((step) => normaliseApiStep(step)).filter(Boolean)
    : [];
  let builtSteps = buildTrainingSteps(baseSteps);

  if (!builtSteps.length) {
    const fallbackDurationSec = toNum(workout?.totalDurationSec) ?? toNum(workout?.estimatedDurationInSecs) ?? 0;
    const fallbackDistanceMeters =
      toNum(workout?.estimatedDistanceMeters) ??
      (toNum(workout?.totalDistanceKm) != null ? Math.round(Number(workout.totalDistanceKm) * 1000) : 0);

    if (fallbackDistanceMeters > 0 || fallbackDurationSec > 0) {
      builtSteps = buildTrainingSteps([
        {
          type: title || "Run",
          stepType: "run",
          durationType: fallbackDistanceMeters > 0 ? "distance" : "time",
          durationValue: fallbackDistanceMeters > 0 ? fallbackDistanceMeters : fallbackDurationSec,
          durationUnit: fallbackDistanceMeters > 0 ? "m" : "sec",
          notes: firstNonEmptyString([workout?.description, workout?.notes], ""),
        },
      ]);
    }
  }
  const derivedTotals = computeTrainingStepTotals(baseSteps);

  const estimatedDurationInSecs =
    toNum(workout?.totalDurationSec) ??
    toNum(workout?.estimatedDurationInSecs) ??
    (derivedTotals.durationSec > 0 ? derivedTotals.durationSec : null);
  const estimatedDistanceInMeters =
    toNum(workout?.estimatedDistanceMeters) ??
    (toNum(workout?.totalDistanceKm) != null ? Math.round(Number(workout.totalDistanceKm) * 1000) : null) ??
    (derivedTotals.distanceMeters > 0 ? derivedTotals.distanceMeters : null);

  const description = firstNonEmptyString([workout?.description, workout?.notes], "");

  const payload = {
    workoutName: title,
    sport: normalizedSport,
    steps: builtSteps,
  };

  if (description) payload.description = description.slice(0, 240);

  return payload;
}

async function loadGarminIntegration(uid) {
  const snap = await admin.firestore().collection("users").doc(String(uid)).get();
  if (!snap.exists) return null;
  const integrations = snap.data()?.integrations || {};
  const key = integrations.garminTraining ? "garminTraining" : "garmin";
  return integrations[key] ? { key, integration: integrations[key] } : null;
}

async function saveGarminIntegration(uid, integrationKey, integration) {
  await admin.firestore().collection("users").doc(String(uid)).set(
    {
      integrations: { [integrationKey]: integration },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

function safeSnippet(text, max = 400) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  return raw.slice(0, max);
}

const GARMIN_RECONNECT_ERROR = "Reconnect Training sync in Settings → Garmin, then send this workout again.";

async function requireGarminReconnect(uid, integrationKey, garmin) {
  const db = admin.firestore();
  const ref = db.collection("users").doc(String(uid));
  const marked = await db.runTransaction(async transaction => {
    const snap = await transaction.get(ref);
    const current = snap.data()?.integrations?.[integrationKey];
    // A concurrent reconnect/refresh must not be disabled by an older request.
    if (!current || current.refreshToken !== garmin.refreshToken || current.accessToken !== garmin.accessToken) return false;
    transaction.set(ref, {
      integrations: { [integrationKey]: { connected: false, reconnectRequired: true, connectionError: "GARMIN_RECONNECT_REQUIRED" } },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return true;
  });
  return marked
    ? { ok: false, httpStatus: 401, code: "GARMIN_RECONNECT_REQUIRED", error: GARMIN_RECONNECT_ERROR }
    : { ok: false, httpStatus: 409, code: "GARMIN_CONNECTION_CHANGED", error: "Your Garmin connection changed. Try sending this workout again." };
}

async function refreshAccessTokenIfNeeded(uid, integrationKey, garmin) {
  if (!garmin) return { ok: false, error: "No Garmin integration" };
  const accessToken = String(garmin.accessToken || "").trim();
  const refreshToken = String(garmin.refreshToken || "").trim();
  const expiresAtMs = Number(garmin.expiresAtMs || 0);
  if (!accessToken) return { ok: false, error: "Missing Garmin access token" };
  const now = Date.now();
  if (!expiresAtMs || now < expiresAtMs) return { ok: true, accessToken };

  const refreshLifetime = Number(garmin.refreshTokenExpiresIn || 0);
  const refreshIssuedAt = Math.max(Number(garmin.linkedAtMs || 0), Number(garmin.refreshedAtMs || 0));
  const refreshExpiresAt = Number(garmin.refreshTokenExpiresAtMs || 0)
    || (refreshLifetime > 0 && refreshIssuedAt > 0 ? refreshIssuedAt + refreshLifetime * 1000 : 0);
  if (!refreshToken || (refreshExpiresAt > 0 && now >= refreshExpiresAt)) {
    return requireGarminReconnect(uid, integrationKey, garmin);
  }

  // Refresh with the client that issued this grant, including legacy connections.
  const profile = garmin.credentialProfile || (integrationKey === "garminTraining" ? "training" : "default");
  const prefix = profile === "training" ? "GARMIN_TRAINING" : profile === "health" ? "GARMIN_HEALTH" : "GARMIN";
  const clientId = String(process.env[`${prefix}_CLIENT_ID`] || process.env.GARMIN_CLIENT_ID || "").trim();
  const clientSecret = String(process.env[`${prefix}_CLIENT_SECRET`] || process.env.GARMIN_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) {
    return { ok: false, httpStatus: 503, code: "GARMIN_TOKEN_REFRESH_FAILED", error: "Garmin connection renewal is unavailable. Please try again later." };
  }
  const resp = await fetch(TOKEN_ENDPOINT, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }).toString(),
    signal: AbortSignal.timeout(15000),
  });
  const tokenJson = await resp.json().catch(() => ({}));
  if (!resp.ok || !tokenJson?.access_token) {
    // Garmin's error_description can contain the refresh token. Never return/log it.
    const invalidGrant = tokenJson.error === "invalid_grant";
    console.warn("[garmin/token-refresh]", { status: resp.status, profile, invalidGrant });
    if (invalidGrant) return requireGarminReconnect(uid, integrationKey, garmin);
    return { ok: false, httpStatus: 503, code: "GARMIN_TOKEN_REFRESH_FAILED", error: "Garmin connection renewal failed. Please try again later.", status: resp.status };
  }
  const expiresInSec = Number(tokenJson.expires_in || 0);
  const newRefreshLifetime = Number(tokenJson.refresh_token_expires_in || 0);
  const updated = {
    ...garmin, accessToken: tokenJson.access_token,
    refreshToken: tokenJson.refresh_token || refreshToken,
    tokenType: tokenJson.token_type || garmin.tokenType || "bearer",
    scope: tokenJson.scope || garmin.scope || null,
    expiresAtMs: now + Math.max(0, expiresInSec - 600) * 1000,
    refreshedAtMs: now, tokenEndpoint: TOKEN_ENDPOINT,
    connected: true, reconnectRequired: false, connectionError: null,
    ...(newRefreshLifetime > 0 ? {
      refreshTokenExpiresIn: newRefreshLifetime,
      refreshTokenExpiresAtMs: now + newRefreshLifetime * 1000,
    } : {}),
  };
  await saveGarminIntegration(uid, integrationKey, updated);
  return { ok: true, accessToken: updated.accessToken, refreshed: true };
}

router.post("/send-workout", requireUser, async (req, res) => {
  try {
    const requesterUid = String(req.user?.uid || "").trim();
    const bodyUserId = String(req.body?.userId || "").trim();
    const uid = bodyUserId || requesterUid;

    if (!uid) {
      return res.status(400).json({ ok: false, error: "Missing userId" });
    }

    if (requesterUid && uid !== requesterUid) {
      return res.status(403).json({ ok: false, error: "Cannot send workout for another user" });
    }

    const workout = req.body?.workout;
    if (!workout || typeof workout !== "object") {
      return res.status(400).json({ ok: false, error: "Missing workout payload" });
    }

    const sessionTitle = firstNonEmptyString(
      [req.body?.title, req.body?.workout?.name, req.body?.sessionKey],
      "Workout"
    );
    const title = formatGarminWorkoutTitle(sessionTitle);
    const sessionKey = firstNonEmptyString([req.body?.sessionKey], "");
    const scheduledDate = firstNonEmptyString(
      [req.body?.scheduledDate, req.body?.date, req.body?.workout?.scheduledDate],
      ""
    );
    let existingSessionLog = null;
    if (sessionKey) {
      const existingSessionLogSnap = await admin
        .firestore()
        .collection("users")
        .doc(uid)
        .collection("sessionLogs")
        .doc(sessionKey)
        .get();
      existingSessionLog = existingSessionLogSnap.exists
        ? existingSessionLogSnap.data() || {}
        : null;
    }

    const existingWorkoutId = firstNonEmptyString(
      [req.body?.garminWorkoutId, existingSessionLog?.garminSync?.workoutId],
      ""
    );
    const existingGarminStatus = String(existingSessionLog?.garminSync?.status || "")
      .trim()
      .toLowerCase();

    if (existingWorkoutId && existingGarminStatus === "sent") {
      return res.json({
        ok: true,
        synced: true,
        alreadySynced: true,
        createdWorkoutId: existingWorkoutId,
        message: "Workout already sent to your watch.",
      });
    }

    const entry = await loadGarminIntegration(uid);
    const garmin = entry?.integration;
    if (garmin?.reconnectRequired) {
      return res.status(401).json({ ok: false, code: "GARMIN_RECONNECT_REQUIRED", error: GARMIN_RECONNECT_ERROR });
    }
    if (!garmin?.connected || !garmin?.accessToken) {
      return res.status(409).json({
        ok: false,
        error: "Garmin is not connected for this account",
      });
    }

    const tokenResult = await refreshAccessTokenIfNeeded(uid, entry.key, garmin);
    if (!tokenResult.ok) {
      return res.status(tokenResult.httpStatus || 401).json({
        ok: false,
        code: tokenResult.code,
        error: tokenResult.error,
        status: tokenResult.status || 401,
        details: tokenResult.details || null,
      });
    }

    const createUrl = String(TRAINING_WORKOUT_CREATE_URL || "").trim();
    if (!createUrl) {
      return res.status(500).json({
        ok: false,
        error: "Garmin workout create URL is not configured",
      });
    }

    const garminWorkout = buildTrainingApiWorkoutPayload(workout, {
      title,
      sessionKey,
      scheduledDate,
    });
    if (!Array.isArray(garminWorkout?.steps) || !garminWorkout.steps.length) {
      return res.status(400).json({
        ok: false,
        error: "Garmin workout payload is empty",
      });
    }

    const uploadResp = await fetch(createUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenResult.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(garminWorkout),
    });

    console.log("[garmin/send-workout] create payload summary:", {
      title,
      sport: garminWorkout?.sport,
      stepCount: Array.isArray(garminWorkout?.steps) ? garminWorkout.steps.length : 0,
      firstStep: garminWorkout?.steps?.[0] || null,
    });

    const uploadText = await uploadResp.text().catch(() => "");
    let uploadJson = null;
    if (uploadText) {
      try {
        uploadJson = JSON.parse(uploadText);
      } catch {}
    }

    if (!uploadResp.ok) {
      return res.status(502).json({
        ok: false,
        error: "Garmin workout create failed",
        status: uploadResp.status,
        details: safeSnippet(uploadText || JSON.stringify(uploadJson || {})),
      });
    }

    const createdWorkoutId =
      uploadJson?.workoutId ??
      uploadJson?.id ??
      uploadJson?.workout?.workoutId ??
      null;

    const garminSyncPayload = {
      provider: "garmin",
      source: "training_api",
      status: "sent",
      title,
      workoutId: createdWorkoutId,
      syncedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const resolvedTrainSessionId = firstNonEmptyString(
      [req.body?.trainSessionId, existingSessionLog?.lastTrainSessionId],
      ""
    );
    if (sessionKey || resolvedTrainSessionId) {
      const userRef = admin.firestore().collection("users").doc(uid);
      const batch = admin.firestore().batch();

      let linkedTrainSessionId = resolvedTrainSessionId || "";

      if (sessionKey) {
        const sessionLogRef = userRef.collection("sessionLogs").doc(sessionKey);
        const existingSessionLogSnap = existingSessionLog
          ? { exists: true }
          : await sessionLogRef.get();
        const existingSessionLogData = existingSessionLog
          ? existingSessionLog
          : existingSessionLogSnap.exists
          ? existingSessionLogSnap.data() || {}
          : {};

        linkedTrainSessionId =
          linkedTrainSessionId ||
          firstNonEmptyString([existingSessionLogData?.lastTrainSessionId], "");

        const sessionLogPatch = {
          sessionKey,
          garminSync: garminSyncPayload,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        if (!existingSessionLogSnap.exists) {
          sessionLogPatch.createdAt = admin.firestore.FieldValue.serverTimestamp();
        }

        batch.set(sessionLogRef, sessionLogPatch, { merge: true });
      }

      if (linkedTrainSessionId) {
        batch.set(
          userRef.collection("trainSessions").doc(linkedTrainSessionId),
          {
            garminSync: garminSyncPayload,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }

      await batch.commit();
    }

    await admin
      .firestore()
      .collection("users")
      .doc(uid)
      .collection("garmin_workout_syncs")
      .add({
        sessionKey: sessionKey || null,
        title,
        uploadedAtMs: Date.now(),
        uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
        uploadUrl: createUrl,
        refreshedToken: !!tokenResult.refreshed,
        responseStatus: uploadResp.status,
        responseSnippet: safeSnippet(uploadText || JSON.stringify(uploadJson || {})),
        garminWorkoutId: createdWorkoutId,
      });

    return res.json({
      ok: true,
      synced: true,
      createdWorkoutId,
    });
  } catch (error) {
    console.error("[garmin/send-workout] error:", error?.message || error);
    return res.status(500).json({
      ok: false,
      error: "Failed to send workout to Garmin",
      details: error?.message || String(error),
    });
  }
});

router.post("/export-fit", requireUser, async (req, res) => {
  try {
    const requesterUid = String(req.user?.uid || "").trim();
    const bodyUserId = String(req.body?.userId || "").trim();
    const uid = bodyUserId || requesterUid;
    if (requesterUid && uid !== requesterUid) {
      return res.status(403).json({ ok: false, error: "Cannot export workout for another user" });
    }

    const workout = req.body?.workout;
    if (!workout || typeof workout !== "object") {
      return res.status(400).json({ ok: false, error: "Missing workout payload" });
    }

    const title = firstNonEmptyString(
      [req.body?.title, req.body?.workout?.name, req.body?.sessionKey],
      "Workout"
    );
    const { generateFitWorkout } = await import("../garmin/fitGenerator.js");
    const fitSession = buildFitSession(workout);
    const rawFit = generateFitWorkout(fitSession, title);
    const fitBuffer = Buffer.isBuffer(rawFit) ? rawFit : Buffer.from(rawFit);

    const safeName = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "workout";

    res.setHeader("Content-Type", "application/x-garmin-fit");
    res.setHeader("Content-Disposition", `attachment; filename=\"${safeName}.fit\"`);
    res.setHeader("Content-Length", String(fitBuffer.length));
    return res.end(fitBuffer, "binary");
  } catch (error) {
    console.error("[garmin/export-fit] error:", error?.message || error);
    return res.status(500).json({
      ok: false,
      error: "Failed to export FIT workout",
    });
  }
});

export default router;
