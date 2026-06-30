import { NextRequest } from "next/server";
import { proxyAdminLogsList } from "@/lib/nest-admin-proxy";

export async function GET(request: NextRequest) {
  return proxyAdminLogsList(request);
}
