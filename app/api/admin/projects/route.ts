import { NextRequest } from "next/server";
import { proxyAdminProjectsList } from "@/lib/nest-admin-proxy";

export async function GET(request: NextRequest) {
  return proxyAdminProjectsList(request);
}
