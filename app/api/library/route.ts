import { NextResponse } from "next/server";
import { KnowledgeType } from "@/types";
import { filterKnowledgeItems, getMergedKnowledgeItems } from "@/lib/library-store";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q") || "";
  const type = searchParams.get("type") as KnowledgeType | null;
  const items = filterKnowledgeItems(await getMergedKnowledgeItems(), q, type || undefined);
  return NextResponse.json({ ok: true, items });
}
