import { NextResponse } from "next/server";
import { isAdminRequestAuthorized } from "@/lib/admin-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return NextResponse.json({ ok: true, authenticated: isAdminRequestAuthorized(request) });
}
