import { NextRequest } from "next/server";
import { proxyAdminUsageEvents } from "@/lib/nest-admin-proxy";

export async function GET(request: NextRequest) {
  return proxyAdminUsageEvents(request);
}
