import { NextRequest } from "next/server";
import { proxyNestProjectDelete, proxyNestProjectGet, proxyNestProjectVersionDelete } from "@/lib/nest-projects-proxy";

export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const params = await context.params;
  return proxyNestProjectGet(request, params.projectId);
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const params = await context.params;
  const versionId = request.nextUrl.searchParams.get("versionId");
  if (versionId) return proxyNestProjectVersionDelete(request, params.projectId, versionId);
  return proxyNestProjectDelete(request, params.projectId);
}
