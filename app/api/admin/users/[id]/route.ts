import { NextRequest } from "next/server";
import { proxyAdminUserDelete, proxyAdminUserGet, proxyAdminUserPatch } from "@/lib/nest-admin-proxy";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return proxyAdminUserGet(request, id);
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return proxyAdminUserPatch(request, id);
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return proxyAdminUserDelete(request, id);
}
