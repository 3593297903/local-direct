import { createHmac, timingSafeEqual } from "node:crypto";

export const ADMIN_SESSION_COOKIE = "ai_video_admin";

function signSession(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function getCookieValue(request: Request, name: string) {
  const cookieHeader = request.headers.get("cookie") || "";
  const cookies = cookieHeader.split(";").map((item) => item.trim());
  const prefix = `${name}=`;
  const found = cookies.find((item) => item.startsWith(prefix));
  return found ? decodeURIComponent(found.slice(prefix.length)) : "";
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function createAdminSessionCookie(
  configuredPassword = process.env.ADMIN_LIBRARY_PASSWORD || "",
  sessionSecret = process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_LIBRARY_TOKEN || configuredPassword,
) {
  const expiresAt = Date.now() + 1000 * 60 * 60 * 8;
  const payload = `admin.${expiresAt}`;
  return `${payload}.${signSession(`${payload}.${configuredPassword}`, sessionSecret)}`;
}

export function isAdminSessionCookieValid(
  cookieValue: string,
  configuredPassword = process.env.ADMIN_LIBRARY_PASSWORD || "",
  sessionSecret = process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_LIBRARY_TOKEN || configuredPassword,
) {
  const parts = cookieValue.split(".");
  if (parts.length !== 3) return false;
  const [role, expiresAtRaw, signature] = parts;
  if (role !== "admin") return false;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const expected = signSession(`${role}.${expiresAtRaw}.${configuredPassword}`, sessionSecret);
  return safeEqual(signature, expected);
}

export function isAdminRequestAuthorized(
  request: Request,
  configuredToken = process.env.ADMIN_LIBRARY_TOKEN || "",
  configuredPassword = process.env.ADMIN_LIBRARY_PASSWORD || "",
  sessionSecret = process.env.ADMIN_SESSION_SECRET || configuredToken || configuredPassword,
) {
  const token = configuredToken.trim();
  const password = configuredPassword.trim();
  if (!token && !password) return process.env.NODE_ENV !== "production";

  const url = new URL(request.url);
  const queryToken = url.searchParams.get("adminToken") || "";
  const headerToken = request.headers.get("x-admin-token") || "";
  const authHeader = request.headers.get("authorization") || "";
  const sessionCookie = getCookieValue(request, ADMIN_SESSION_COOKIE);

  return (
    (!!token && (queryToken === token || headerToken === token || authHeader === `Bearer ${token}`)) ||
    (!!password && isAdminSessionCookieValid(sessionCookie, password, sessionSecret))
  );
}
