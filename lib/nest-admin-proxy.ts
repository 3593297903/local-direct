import { NextRequest, NextResponse } from "next/server";
import { isAdminRequestAuthorized } from "@/lib/admin-auth";
import { NEST_AUTH_TOKEN_COOKIE } from "@/lib/nest-auth-proxy";

type NestResponse = Record<string, unknown> & {
  ok?: boolean;
  data?: unknown;
  error?: string;
  message?: string | string[];
};

function getNestApiBaseUrl() {
  return (process.env.NEST_API_BASE_URL || "http://localhost:4000/api").replace(/\/+$/, "");
}

function getBearerToken(request: NextRequest) {
  return request.cookies.get(NEST_AUTH_TOKEN_COOKIE)?.value;
}

function getInternalAdminToken() {
  return (
    process.env.ADMIN_INTERNAL_TOKEN ||
    process.env.ADMIN_SESSION_SECRET ||
    process.env.ADMIN_LIBRARY_TOKEN ||
    ""
  ).trim();
}

function formatUpstreamError(payload: NestResponse | null, fallback: string) {
  const message = payload ? payload.error || payload.message || fallback : fallback;
  return Array.isArray(message) ? message.join("; ") : message;
}

async function readJson(response: Response): Promise<NestResponse | null> {
  try {
    return (await response.json()) as NestResponse;
  } catch {
    return null;
  }
}

async function forward(request: NextRequest, path: string, init: { method: string; body?: unknown }) {
  const token = getBearerToken(request);
  const localAdminAuthorized = isAdminRequestAuthorized(request);
  if (!token && !localAdminAuthorized) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const headers: Record<string, string> = {};
  if (localAdminAuthorized) {
    const internalAdminToken = getInternalAdminToken();
    if (!internalAdminToken) {
      return NextResponse.json(
        {
          ok: false,
          error: "ADMIN_SESSION_SECRET is required for local admin proxy access.",
        },
        { status: 500 },
      );
    }
    headers["x-internal-admin-token"] = internalAdminToken;
  } else if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${getNestApiBaseUrl()}/admin/${path}`, {
      method: init.method,
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Admin service is unavailable. Start the Nest API with npm run api:dev." },
      { status: 502 },
    );
  }

  const payload = await readJson(upstream);
  if (!upstream.ok || !payload || !payload.ok) {
    return NextResponse.json(
      { ok: false, error: formatUpstreamError(payload, "Admin request failed") },
      { status: upstream.status || 502 },
    );
  }
  return NextResponse.json({ ok: true, data: payload.data ?? null });
}

export function proxyAdminUsersList(request: NextRequest) {
  const search = request.nextUrl.search || "";
  return forward(request, `users${search}`, { method: "GET" });
}

export async function proxyAdminUserCreate(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  return forward(request, "users", { method: "POST", body });
}

export function proxyAdminUserGet(request: NextRequest, id: string) {
  return forward(request, `users/${encodeURIComponent(id)}`, { method: "GET" });
}

export async function proxyAdminUserPatch(request: NextRequest, id: string) {
  const body = await request.json().catch(() => ({}));
  return forward(request, `users/${encodeURIComponent(id)}`, { method: "PATCH", body });
}

export function proxyAdminUserDelete(request: NextRequest, id: string) {
  return forward(request, `users/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function proxyAdminProjectsList(request: NextRequest) {
  const search = request.nextUrl.search || "";
  return forward(request, `projects${search}`, { method: "GET" });
}

export function proxyAdminProjectGet(request: NextRequest, id: string) {
  return forward(request, `projects/${encodeURIComponent(id)}`, { method: "GET" });
}

export function proxyAdminProjectDelete(request: NextRequest, id: string) {
  return forward(request, `projects/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function proxyAdminUsageSummary(request: NextRequest) {
  return forward(request, "usage/summary", { method: "GET" });
}

export function proxyAdminUsageEvents(request: NextRequest) {
  const search = request.nextUrl.search || "";
  return forward(request, `usage/events${search}`, { method: "GET" });
}

export function proxyAdminLogsList(request: NextRequest) {
  const search = request.nextUrl.search || "";
  return forward(request, `logs${search}`, { method: "GET" });
}
