import { NextRequest } from "next/server";
import { proxyNestProjectsGet, proxyNestProjectsPost } from "@/lib/nest-projects-proxy";

export async function GET(request: NextRequest) {
  return proxyNestProjectsGet(request);
}

export async function POST(request: NextRequest) {
  return proxyNestProjectsPost(request);
}
