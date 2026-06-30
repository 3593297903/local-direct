import { NextRequest } from "next/server";
import { proxyNestAuthMe } from "@/lib/nest-auth-proxy";

export async function GET(request: NextRequest) {
  return proxyNestAuthMe(request);
}
