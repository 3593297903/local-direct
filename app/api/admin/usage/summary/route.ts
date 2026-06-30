import { NextRequest } from "next/server";
import { proxyAdminUsageSummary } from "@/lib/nest-admin-proxy";

export async function GET(request: NextRequest) {
  return proxyAdminUsageSummary(request);
}
