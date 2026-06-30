import { NextRequest, NextResponse } from "next/server";
import { shouldUseSecureCookie } from "@/lib/cookie-security";

export const NEST_AUTH_TOKEN_COOKIE = "vd_access_token";

type NestAuthData = {
  accessToken?: string;
  user?: unknown;
  [key: string]: unknown;
};

type NestResponse = {
  ok?: boolean;
  data?: NestAuthData;
  error?: string;
  message?: string | string[];
};

function getNestApiBaseUrl() {
  return (process.env.NEST_API_BASE_URL || "http://localhost:4000/api").replace(/\/+$/, "");
}

function formatUpstreamError(payload: NestResponse | null, fallback: string) {
  const message = payload?.error || payload?.message || fallback;
  return Array.isArray(message) ? message.join("; ") : message;
}

async function readJson(response: Response): Promise<NestResponse | null> {
  try {
    return (await response.json()) as NestResponse;
  } catch {
    return null;
  }
}

function authServiceUnavailableResponse() {
  return NextResponse.json(
    {
      ok: false,
      error: "Auth service is unavailable. Start the Nest API with npm run api:dev and check NEST_API_BASE_URL.",
    },
    { status: 502 },
  );
}

async function fetchAuthUpstream(url: string, init: RequestInit) {
  try {
    return await fetch(url, init);
  } catch (error) {
    void error;
    return null;
  }
}

export function clearNestAuthCookie(response: NextResponse) {
  response.cookies.set(NEST_AUTH_TOKEN_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookie(),
    path: "/",
    maxAge: 0,
  });
  return response;
}

export async function proxyNestAuthGet(action: "captcha") {
  const upstream = await fetchAuthUpstream(`${getNestApiBaseUrl()}/auth/${action}`, {
    method: "GET",
    cache: "no-store",
  });
  if (!upstream) return authServiceUnavailableResponse();
  const payload = await readJson(upstream);

  if (!upstream.ok || !payload?.ok) {
    return NextResponse.json(
      { ok: false, error: formatUpstreamError(payload, "Auth service request failed") },
      { status: upstream.status || 502 },
    );
  }

  return NextResponse.json({ ok: true, data: payload.data || null });
}

export async function proxyNestAuthPlainBody(request: NextRequest, action: "send-code") {
  const upstream = await fetchAuthUpstream(`${getNestApiBaseUrl()}/auth/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(await request.json()),
    cache: "no-store",
  });
  if (!upstream) return authServiceUnavailableResponse();
  const payload = await readJson(upstream);

  if (!upstream.ok || !payload?.ok) {
    return NextResponse.json(
      { ok: false, error: formatUpstreamError(payload, "Auth service request failed") },
      { status: upstream.status || 502 },
    );
  }

  return NextResponse.json({ ok: true, data: payload.data || null });
}

export async function proxyNestAuthWithBody(request: NextRequest, action: "login" | "register" | "reset-password") {
  const upstream = await fetchAuthUpstream(`${getNestApiBaseUrl()}/auth/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(await request.json()),
    cache: "no-store",
  });
  if (!upstream) return authServiceUnavailableResponse();
  const payload = await readJson(upstream);

  if (!upstream.ok || !payload?.ok) {
    return NextResponse.json(
      { ok: false, error: formatUpstreamError(payload, "Auth service request failed") },
      { status: upstream.status || 502 },
    );
  }

  const accessToken = payload.data?.accessToken;
  if (!accessToken) {
    return NextResponse.json({ ok: false, error: "Auth service did not return an access token" }, { status: 502 });
  }

  const response = NextResponse.json({ ok: true, user: payload.data?.user || null });
  response.cookies.set(NEST_AUTH_TOKEN_COOKIE, accessToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookie(),
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return response;
}

export async function proxyNestAuthMe(request: NextRequest) {
  const token = request.cookies.get(NEST_AUTH_TOKEN_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const upstream = await fetchAuthUpstream(`${getNestApiBaseUrl()}/auth/me`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!upstream) return authServiceUnavailableResponse();
  const payload = await readJson(upstream);

  if (!upstream.ok || !payload?.ok) {
    const response = NextResponse.json(
      { ok: false, error: formatUpstreamError(payload, "Auth session is invalid") },
      { status: upstream.status || 401 },
    );
    if (upstream.status === 401) clearNestAuthCookie(response);
    return response;
  }

  return NextResponse.json({ ok: true, user: payload.data?.user || null });
}
