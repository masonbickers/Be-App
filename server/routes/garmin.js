// server/routes/garmin.js
import crypto from "crypto";
import express from "express";
import admin from "../admin.js";
import { requireUser } from "../utils/requireUser.js";

const router = express.Router();

function base64url(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest();
}

function randomString(len = 64) {
  return base64url(crypto.randomBytes(len)).slice(0, 96);
}

// --- Redirect helpers ---
function defaultDeepLinkOk() {
  return process.env.APP_DEEPLINK_SUCCESS || "version10app://garmin-linked";
}

function defaultDeepLinkFail() {
  return process.env.APP_DEEPLINK_FAIL || "version10app://garmin-linked";
}

function withQuery(url, paramsObj) {
  const hasQ = url.includes("?");
  const qs = new URLSearchParams(paramsObj).toString();
  return url + (hasQ ? "&" : "?") + qs;
}

function isAllowedAppReturn(url) {
  return (
    typeof url === "string" &&
    (url.startsWith("version10app://") || url.startsWith("exp://"))
  );
}

function pickBestReturnUrl(preferred, fallback) {
  if (isAllowedAppReturn(preferred)) return preferred;
  if (isAllowedAppReturn(fallback)) return fallback;
  return defaultDeepLinkOk();
}

/**
 * Store PKCE verifier by state so callback can complete exchange.
 */
async function putState(state, payload) {
  const db = admin.firestore();
  await db.collection("garmin_oauth_states").doc(state).set({
    ...payload,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAtMs: Date.now() + 15 * 60 * 1000,
  });
}

async function getState(state) {
  const db = admin.firestore();
  const ref = db.collection("garmin_oauth_states").doc(state);
  const snap = await ref.get();
  if (!snap.exists) return null;

  const data = snap.data();
  if (data?.expiresAtMs && Date.now() > Number(data.expiresAtMs)) return null;

  return { ref, data };
}

async function deleteStateByRef(ref) {
  try {
    await ref.delete();
  } catch (e) {
    console.warn("Garmin state delete failed:", e?.message || e);
  }
}

const TOKEN_ENDPOINT = "https://diauth.garmin.com/di-oauth2-service/oauth/token";
const USER_ID_ENDPOINT = "https://apis.garmin.com/wellness-api/rest/user/id";

function hasAnyActivityCredentialEnv() {
  return !!(
    process.env.GARMIN_ACTIVITY_CLIENT_ID ||
    process.env.GARMIN_ACTIVITY_CLIENT_SECRET ||
    process.env.GARMIN_ACTIVITY_REDIRECT_URI
  );
}

function hasAnyTrainingCredentialEnv() {
  return !!(
    process.env.GARMIN_TRAINING_CLIENT_ID ||
    process.env.GARMIN_TRAINING_CLIENT_SECRET ||
    process.env.GARMIN_TRAINING_REDIRECT_URI
  );
}

function getGarminOAuthConfig(profile = "activity") {
  const useActivity = profile === "activity" && hasAnyActivityCredentialEnv();
  const useTraining = profile === "training" && hasAnyTrainingCredentialEnv();
  const useHealth = profile === "health";

  const config = useActivity
    ? {
        profile: "activity",
        integrationKey: "garminActivity",
        clientId: process.env.GARMIN_ACTIVITY_CLIENT_ID,
        clientSecret: process.env.GARMIN_ACTIVITY_CLIENT_SECRET,
        redirectUri:
          process.env.GARMIN_ACTIVITY_REDIRECT_URI ||
          process.env.GARMIN_REDIRECT_URI,
        missingClientMessage:
          "Missing GARMIN_ACTIVITY_CLIENT_ID or GARMIN_ACTIVITY_REDIRECT_URI",
        missingSecretMessage:
          "Missing GARMIN_ACTIVITY_CLIENT_ID, GARMIN_ACTIVITY_CLIENT_SECRET, or GARMIN_ACTIVITY_REDIRECT_URI",
      }
    : useTraining
      ? {
          profile: "training",
          integrationKey: "garminTraining",
          clientId: process.env.GARMIN_TRAINING_CLIENT_ID,
          clientSecret: process.env.GARMIN_TRAINING_CLIENT_SECRET,
          redirectUri:
            process.env.GARMIN_TRAINING_REDIRECT_URI ||
            process.env.GARMIN_REDIRECT_URI,
          missingClientMessage:
            "Missing GARMIN_TRAINING_CLIENT_ID or GARMIN_TRAINING_REDIRECT_URI",
          missingSecretMessage:
            "Missing GARMIN_TRAINING_CLIENT_ID, GARMIN_TRAINING_CLIENT_SECRET, or GARMIN_TRAINING_REDIRECT_URI",
        }
    : useHealth
    ? {
        profile: "health",
        integrationKey: "garmin",
        clientId: process.env.GARMIN_HEALTH_CLIENT_ID || process.env.GARMIN_CLIENT_ID,
        clientSecret:
          process.env.GARMIN_HEALTH_CLIENT_SECRET || process.env.GARMIN_CLIENT_SECRET,
        redirectUri:
          process.env.GARMIN_HEALTH_REDIRECT_URI || process.env.GARMIN_REDIRECT_URI,
        missingClientMessage:
          "Missing GARMIN_HEALTH_CLIENT_ID/GARMIN_CLIENT_ID or GARMIN_HEALTH_REDIRECT_URI/GARMIN_REDIRECT_URI",
        missingSecretMessage:
          "Missing GARMIN_HEALTH_CLIENT_ID/GARMIN_CLIENT_ID, GARMIN_HEALTH_CLIENT_SECRET/GARMIN_CLIENT_SECRET, or GARMIN_HEALTH_REDIRECT_URI/GARMIN_REDIRECT_URI",
      }
    : {
        profile: "default",
        integrationKey: "garmin",
        clientId: process.env.GARMIN_CLIENT_ID,
        clientSecret: process.env.GARMIN_CLIENT_SECRET,
        redirectUri: process.env.GARMIN_REDIRECT_URI,
        missingClientMessage: "Missing GARMIN_CLIENT_ID or GARMIN_REDIRECT_URI",
        missingSecretMessage:
          "Missing GARMIN_CLIENT_ID, GARMIN_CLIENT_SECRET, or GARMIN_REDIRECT_URI",
      };

  return config;
}

/** Save tokens under user */
async function saveGarminIntegration(uid, integration, integrationKey = "garmin") {
  const db = admin.firestore();
  await db.collection("users").doc(uid).set(
    {
      integrations: { [integrationKey]: integration },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function safeJson(resp) {
  try {
    return await resp.json();
  } catch {
    return {};
  }
}

async function buildGarminAuthUrl({ uid, requestedReturnUrl, profile = "health" }) {
  const oauthConfig = getGarminOAuthConfig(profile);
  const { clientId, redirectUri } = oauthConfig;

  if (!clientId || !redirectUri) {
    const error = new Error(oauthConfig.missingClientMessage);
    error.statusCode = 500;
    throw error;
  }

  const safeRedirectToApp = pickBestReturnUrl(
    requestedReturnUrl,
    defaultDeepLinkOk()
  );

  const state = base64url(crypto.randomBytes(24));
  const codeVerifier = randomString(64);
  const codeChallenge = base64url(sha256(codeVerifier));

  await putState(state, {
    uid,
    codeVerifier,
    credentialProfile: oauthConfig.profile,
    integrationKey: oauthConfig.integrationKey,
    redirectToApp: safeRedirectToApp,
  });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    redirect_uri: redirectUri,
    state,
  });

  return {
    authUrl: `https://connect.garmin.com/oauth2Confirm?${params.toString()}`,
    credentialProfile: oauthConfig.profile,
    redirectUri,
    returnUrl: safeRedirectToApp,
  };
}

router.post("/start-url", requireUser, async (req, res) => {
  try {
    const uid = String(req.user?.uid || "").trim();
    const requestedReturnUrl = String(req.body?.returnUrl || "").trim();
    const requestedProfile = String(req.body?.profile || "health").trim();
    if (!uid) return res.status(401).json({ error: "Unauthenticated user" });

    const safeProfile =
      requestedProfile === "activity"
        ? "activity"
        : requestedProfile === "training"
          ? "training"
        : requestedProfile === "health"
          ? "health"
          : "default";

    const result = await buildGarminAuthUrl({
      uid,
      requestedReturnUrl,
      profile: safeProfile,
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    console.error("Garmin start-url error:", error?.message || error);
    return res
      .status(error?.statusCode || 500)
      .json({ error: error?.message || "Failed to start Garmin OAuth" });
  }
});

/**
 * Local-development fallback. Production app builds use POST /auth/garmin/start-url.
 */
router.get("/start", async (req, res) => {
  try {
    if (process.env.NODE_ENV === "production") {
      return res.status(410).send("Use POST /auth/garmin/start-url.");
    }

    const { uid, redirectToApp, returnUrl } = req.query;
    if (!uid) return res.status(400).send("Missing uid");

    const requestedReturnUrl =
      typeof redirectToApp === "string"
        ? redirectToApp
        : typeof returnUrl === "string"
        ? returnUrl
        : "";

    const { authUrl, redirectUri, returnUrl: safeRedirectToApp } =
      await buildGarminAuthUrl({
        uid: String(uid),
        requestedReturnUrl,
      });

    console.log("Garmin start:", {
      uid: String(uid),
      redirectUri,
      requestedReturnUrl,
      safeRedirectToApp,
      authUrl,
    });

    return res.redirect(authUrl);
  } catch (e) {
    console.error("Garmin start error:", e);
    return res.status(500).send("Failed to start Garmin OAuth");
  }
});

/**
 * GET /auth/garmin/callback?code=...&state=...
 */
router.get("/callback", async (req, res) => {
  try {
    const { code, state, error } = req.query;

    console.log("Garmin callback query:", req.query);

    // If Garmin returns an oauth error before we can look up state,
    // use the configured fallback deep link.
    if (error && !state) {
      const failUrl = defaultDeepLinkFail();
      return res.redirect(
        withQuery(failUrl, {
          success: "0",
          reason: "oauth_error",
          error: String(error),
        })
      );
    }

    if (!state) {
      const failUrl = defaultDeepLinkFail();
      return res.redirect(
        withQuery(failUrl, {
          success: "0",
          reason: "missing_state",
        })
      );
    }

    const stateRecord = await getState(String(state));
    const stateData = stateRecord?.data || null;
    const stateRef = stateRecord?.ref || null;

    const appReturnUrl = pickBestReturnUrl(
      stateData?.redirectToApp,
      defaultDeepLinkFail()
    );

    if (error) {
      console.warn("Garmin oauth returned error:", error);
      if (stateRef) await deleteStateByRef(stateRef);
      return res.redirect(
        withQuery(appReturnUrl, {
          success: "0",
          reason: "oauth_error",
          error: String(error),
        })
      );
    }

    if (!code) {
      if (stateRef) await deleteStateByRef(stateRef);
      return res.redirect(
        withQuery(appReturnUrl, {
          success: "0",
          reason: "missing_code",
        })
      );
    }

    if (!stateData?.uid || !stateData?.codeVerifier) {
      if (stateRef) await deleteStateByRef(stateRef);
      return res.redirect(
        withQuery(appReturnUrl, {
          success: "0",
          reason: "invalid_or_expired_state",
        })
      );
    }

    const oauthConfig = getGarminOAuthConfig(
      stateData?.credentialProfile || "default"
    );
    const { clientId, clientSecret, redirectUri } = oauthConfig;

    if (!clientId || !clientSecret || !redirectUri) {
      console.error("Garmin callback misconfig:", {
        credentialProfile: oauthConfig.profile,
        hasClientId: !!clientId,
        hasClientSecret: !!clientSecret,
        hasRedirectUri: !!redirectUri,
      });
      if (stateRef) await deleteStateByRef(stateRef);
      return res.redirect(
        withQuery(appReturnUrl, {
          success: "0",
          reason: "server_misconfig",
          profile: oauthConfig.profile,
        })
      );
    }

    const tokenParams = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code: String(code),
      code_verifier: String(stateData.codeVerifier),
      redirect_uri: redirectUri,
    });

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10000);

    const tokenResp = await fetch(
      TOKEN_ENDPOINT,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenParams.toString(),
        signal: controller.signal,
      }
    ).finally(() => clearTimeout(t));

    const tokenJson = await safeJson(tokenResp);

    console.log("Garmin token exchange:", {
      status: tokenResp.status,
      ok: tokenResp.ok,
      hasAccessToken: !!tokenJson?.access_token,
    });

    if (!tokenResp.ok || !tokenJson?.access_token) {
      console.error("Garmin token error:", tokenResp.status, tokenJson);
      if (stateRef) await deleteStateByRef(stateRef);
      return res.redirect(
        withQuery(appReturnUrl, {
          success: "0",
          reason: "token_exchange_failed",
          status: String(tokenResp.status),
        })
      );
    }

    // Try to fetch Garmin userId
    let garminUserId = null;
    try {
      const idCtrl = new AbortController();
      const idT = setTimeout(() => idCtrl.abort(), 10000);

      const idResp = await fetch(
        USER_ID_ENDPOINT,
        {
          headers: { Authorization: `Bearer ${tokenJson.access_token}` },
          signal: idCtrl.signal,
        }
      ).finally(() => clearTimeout(idT));

      const idJson = await safeJson(idResp);

      if (idResp.ok) {
        garminUserId = idJson?.userId || null;
      } else {
        console.warn("Garmin user id fetch failed:", idResp.status, idJson);
      }
    } catch (e) {
      console.warn("Garmin user id fetch threw:", e?.message || e);
    }

    const now = Date.now();
    const expiresInSec = Number(tokenJson.expires_in || 0);
    const expiresAtMs = now + Math.max(0, expiresInSec - 600) * 1000;

    await saveGarminIntegration(stateData.uid, {
      connected: true,
      reconnectRequired: false,
      connectionError: null,
      garminUserId,
      accessToken: tokenJson.access_token,
      refreshToken: tokenJson.refresh_token,
      scope: tokenJson.scope || null,
      tokenType: tokenJson.token_type || "bearer",
      expiresAtMs,
      refreshTokenExpiresIn: tokenJson.refresh_token_expires_in || null,
      refreshTokenExpiresAtMs: Number(tokenJson.refresh_token_expires_in) > 0
        ? now + Number(tokenJson.refresh_token_expires_in) * 1000 : null,
      credentialProfile: oauthConfig.profile,
      apiProduct: oauthConfig.profile,
      linkedAtMs: now,
      tokenEndpoint: TOKEN_ENDPOINT,
      userIdEndpointAttempted: USER_ID_ENDPOINT,
    }, stateData.integrationKey || oauthConfig.integrationKey);

    if (stateRef) await deleteStateByRef(stateRef);

    console.log("Garmin success redirect:", {
      appReturnUrl,
      garminUserId,
      uid: stateData.uid,
    });

    return res.redirect(withQuery(appReturnUrl, { success: "1" }));
  } catch (e) {
    console.error("Garmin callback error:", e);
    return res.redirect(
      withQuery(defaultDeepLinkFail(), {
        success: "0",
        reason: "server_error",
      })
    );
  }
});

export default router;
