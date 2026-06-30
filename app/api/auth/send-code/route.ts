import { NextRequest } from "next/server";
import { proxyNestAuthPlainBody } from "@/lib/nest-auth-proxy";

export async function POST(request: NextRequest) {
  return proxyNestAuthPlainBody(request, "send-code");
}
