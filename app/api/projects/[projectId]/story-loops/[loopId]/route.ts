import { NextRequest } from "next/server";
import { proxyNestProjectPatch } from "@/lib/nest-projects-proxy";

export async function PATCH(request: NextRequest, context: { params: Promise<{ projectId: string; loopId: string }> }) {
  const params = await context.params;
  return proxyNestProjectPatch(request, params.projectId, `story-loops/${params.loopId}`);
}
