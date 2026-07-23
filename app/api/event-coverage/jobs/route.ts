import { NextResponse } from "next/server";
import { z } from "zod";
import { enqueueEventCoverageJudgeWave } from "@/lib/event-coverage-wave-aggregator";
import { CODEX_QUOTA_EXHAUSTED_CODE, assertCodexRuntimeAvailable } from "@/lib/codex-runtime-state";

export const runtime = "nodejs";

const GroupSchema = z.array(z.array(z.string().min(1).max(200)).min(1).max(20)).max(20);
const CharacterLockSchema = z.object({
  characterId: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200),
  factKey: z.string().min(1).max(200),
  expectedValue: z.string().min(1).max(500),
  mode: z.literal("must_not_contradict"),
  contradictionSignals: GroupSchema,
  appliesFromSegment: z.number().int().min(1).max(30).optional(),
  appliesThroughSegment: z.number().int().min(1).max(30).optional(),
});
const EvidenceSelectorSchema = z.object({
  source: z.enum(["optimizedScript", "storyboard"]),
  shotNumber: z.union([z.number().int().min(1).max(20), z.literal("any")]).optional(),
  fields: z.array(z.enum(["visual", "dialogue", "shotPurpose", "videoPrompt", "firstFramePrompt", "lastFramePrompt"])).max(6),
  requireExecutableShot: z.boolean(),
});
const RequestSchema = z.object({
  batchId: z.string().min(1).max(200),
  renderRound: z.union([z.string().min(1).max(200), z.number().int().min(0).max(1000)]),
  cases: z.array(z.object({
    segmentIndex: z.number().int().min(1).max(30),
    slotId: z.string().min(1).max(200),
    label: z.string().min(1).max(500),
    importance: z.literal("blocking"),
    contractHash: z.string().min(1).max(200),
    resultHash: z.string().min(1).max(200),
    anchorGroups: GroupSchema,
    conceptGroups: GroupSchema,
    contradictionGroups: GroupSchema,
    sourceExcerpt: z.string().min(1).max(4_000),
    characterLocks: z.array(CharacterLockSchema).max(20),
    forbiddenFutureEvents: z.array(z.string().min(1).max(500)).max(20),
    evidenceSelectors: z.array(EvidenceSelectorSchema).max(20),
    inspectedFields: z.array(z.object({
      path: z.string().min(1).max(200),
      text: z.string().min(1).max(4_000),
    })).min(1).max(20),
  })).min(1).max(20),
});

export async function POST(request: Request) {
  try {
    await assertCodexRuntimeAvailable();
    const job = await enqueueEventCoverageJudgeWave(RequestSchema.parse(await request.json()));
    return NextResponse.json({ ok: true, job }, { status: 201 });
  } catch (error: any) {
    const quota = error?.code === CODEX_QUOTA_EXHAUSTED_CODE || String(error?.message || "").includes(CODEX_QUOTA_EXHAUSTED_CODE);
    return NextResponse.json({ ok: false, error: error?.message || "Event coverage judge job creation failed", code: quota ? CODEX_QUOTA_EXHAUSTED_CODE : undefined }, { status: quota ? 429 : 400 });
  }
}
