import { NextResponse } from "next/server";
import { readSegmentBatchCache, writeSegmentBatchCache } from "@/lib/segment-batch-cache";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ batchId: string }> }) {
  try {
    const { batchId } = await context.params;
    return NextResponse.json({ ok: true, cache: await readSegmentBatchCache(batchId) });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || "Segment batch cache read failed" }, { status: 400 });
  }
}

export async function PUT(request: Request, context: { params: Promise<{ batchId: string }> }) {
  try {
    const { batchId } = await context.params;
    const body = await request.json();
    if (body?.batchId !== batchId) throw new Error("Segment batch cache batchId mismatch");
    return NextResponse.json({ ok: true, cache: await writeSegmentBatchCache(body) });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || "Segment batch cache write failed" }, { status: 400 });
  }
}
