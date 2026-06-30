import { NextRequest } from "next/server";
import { proxyAdminProjectDelete, proxyAdminProjectGet } from "@/lib/nest-admin-proxy";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return proxyAdminProjectGet(request, id);
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return proxyAdminProjectDelete(request, id);
}
