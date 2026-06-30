import { NextResponse } from "next/server";

export async function GET() {
  // Replace with database-backed usage counting when billing is enabled.
  return NextResponse.json({
    ok: true,
    plan: "Free",
    usedToday: 0,
    dailyLimit: 3,
    remaining: 3,
  });
}
