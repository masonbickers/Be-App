function getBearerToken(req) {
  const header = String(req?.headers?.authorization || "").trim();
  if (!header.toLowerCase().startsWith("bearer ")) return "";
  return header.slice(7).trim();
}

let cachedAuth = null;
async function getAdminAuth() {
  if (cachedAuth) return cachedAuth;
  const { default: admin } = await import("../admin.js");
  cachedAuth = admin.auth();
  return cachedAuth;
}

export function createRequireUser(verifyToken) {
  return async function requireUser(req, res, next) {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({
        error: "Missing Authorization Bearer token",
      });
    }

    try {
      const decoded = await verifyToken(token);
      if (decoded.firebase?.sign_in_provider === "password" && decoded.email_verified !== true) {
        return res.status(403).json({
          code: "EMAIL_VERIFICATION_REQUIRED",
          error: "Verify your email address before continuing.",
        });
      }
      req.user = decoded;
      return next();
    } catch {
      return res.status(401).json({
        error: "Invalid or expired Authorization token",
      });
    }
  };
}

export const requireUser = createRequireUser(async (token) => {
  const auth = await getAdminAuth();
  return auth.verifyIdToken(token);
});
