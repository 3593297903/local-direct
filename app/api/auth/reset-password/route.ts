import { NextRequest } from "next/server";
import { proxyNestAuthWithBody } from "@/lib/nest-auth-proxy";

export async function POST(request: NextRequest) {
  return proxyNestAuthWithBody(request, "reset-password");
}
