import { NextResponse } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdminSessionCookie } from "@/lib/admin-auth";
import { shouldUseSecureCookie } from "@/lib/cookie-security";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const expectedPassword = process.env.ADMIN_LIBRARY_PASSWORD || "";
  const expectedUsername = process.env.ADMIN_LIBRARY_USERNAME || "";

  if (!expectedUsername || !expectedPassword) {
    return NextResponse.json({ ok: false, error: "后台账号未配置" }, { status: 500 });
  }

  if (username !== expectedUsername || password !== expectedPassword) {
    return NextResponse.json({ ok: false, error: "账号或密码不正确" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(ADMIN_SESSION_COOKIE, createAdminSessionCookie(expectedPassword), {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookie(),
    path: "/",
    maxAge: 60 * 60 * 8,
  });
  return response;
}
