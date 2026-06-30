import { NextResponse } from "next/server";
import { clearNestAuthCookie } from "@/lib/nest-auth-proxy";

export async function POST() {
  return clearNestAuthCookie(NextResponse.json({ ok: true }));
}
