import { NextRequest } from "next/server";
import { proxyAdminUserCreate, proxyAdminUsersList } from "@/lib/nest-admin-proxy";

export async function GET(request: NextRequest) {
  return proxyAdminUsersList(request);
}

export async function POST(request: NextRequest) {
  return proxyAdminUserCreate(request);
}
