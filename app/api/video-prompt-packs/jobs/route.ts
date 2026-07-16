import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  CONTRACT_PREFLIGHT_MISMATCH_CODE,
  CONTRACT_PREFLIGHT_REQUIRED_CODE,
  createVideoPromptPackCodexJob,
  toVideoPromptPackCodexJobStatusDto,
} from "@/lib/video-prompt-pack-codex-queue";
import { CODEX_QUOTA_EXHAUSTED_CODE, assertCodexRuntimeAvailable } from "@/lib/codex-runtime-state";
import type { SegmentContract } from "@/lib/batch-segment-contract";
import {
  CONTRACT_PROMPT_COMPILER_VERSION,
  type ContractSemanticManifest,
} from "@/lib/codex-prompt-input-compiler";
import { fileJobRouteError } from "@/lib/file-job-route-error";
import {
  assertCodexFinalizationV2CreateEnabled,
  CODEX_FINALIZATION_V2_CREATE_PAUSED_CODE,
} from "@/lib/codex-job-finalization";

export const runtime = "nodejs";

const CompiledContractSchema = z.object({
  status: z.enum(["ready", "compacted"]),
  compilerVersion: z.literal(CONTRACT_PROMPT_COMPILER_VERSION),
  segmentIndex: z.number().int().min(1),
  contractHash: z.string().min(1).max(256),
  text: z.string().min(1),
  byteLength: z.number().int().min(1),
  maxBytes: z.number().int().min(1),
  sectionBytes: z.object({
    identity: z.number().int().min(0),
    requiredEventSlots: z.number().int().min(0),
    forbiddenFutureEvents: z.number().int().min(0),
    characterLocks: z.number().int().min(0),
    requiredShotBeats: z.number().int().min(0),
    safetyPolicy: z.number().int().min(0),
    executionMetadata: z.number().int().min(0),
  }).strict(),
  compactedFields: z.array(z.string()),
  semanticManifest: z.custom<ContractSemanticManifest>(
    (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value),
    "semanticManifest must be an object",
  ),
}).strict();

const CONTRACT_PREFLIGHT_ERROR_CODES = new Set([
  CONTRACT_PREFLIGHT_REQUIRED_CODE,
  CONTRACT_PREFLIGHT_MISMATCH_CODE,
  "CONTRACT_BUDGET_EXCEEDED",
  "CONTRACT_HASH_INVALID",
  "CONTRACT_SCHEMA_INVALID",
]);

const SegmentSchema = z.object({
  episodeIndex: z.number().int().min(1),
  title: z.string().min(1),
  script: z.string().min(5).max(50_000),
  renderInputScript: z.string().min(5).max(50_000),
  duration: z.string().min(1),
  shotCount: z.number().int().min(1).max(12).optional(),
  segmentContract: z.custom<SegmentContract>(
    (value) => value === undefined || (Boolean(value) && typeof value === "object" && !Array.isArray(value)),
    "segmentContract must be an object",
  ).optional(),
  compiledContract: CompiledContractSchema.optional(),
});

const RequestSchema = z.object({
  batchId: z.string().min(1).max(240).regex(/^[A-Za-z0-9._:-]+$/),
  operationToken: z.string().min(1).max(240).regex(/^[A-Za-z0-9._:-]+$/),
  idempotencyKey: z.string().min(1).max(400),
  projectId: z.string().uuid().optional(),
  mode: z.enum(["standard", "strictUtf8"]).optional(),
  coverageSidecarEnabled: z.boolean().optional(),
  segments: z.array(SegmentSchema).min(1).max(5),
}).strict();

export async function POST(request: NextRequest) {
  try {
    const body = RequestSchema.parse(await request.json());
    assertCodexFinalizationV2CreateEnabled();
    await assertCodexRuntimeAvailable();
    const job = await createVideoPromptPackCodexJob(body);
    return NextResponse.json({ ok: true, job: toVideoPromptPackCodexJobStatusDto(job) }, { status: 201 });
  } catch (error: any) {
    if (error instanceof z.ZodError && error.issues.some((issue) => issue.path.includes("compiledContract"))) {
      return NextResponse.json(
        {
          ok: false,
          code: CONTRACT_PREFLIGHT_MISMATCH_CODE,
          errorCode: CONTRACT_PREFLIGHT_MISMATCH_CODE,
          segmentIndexes: [],
          error: "Compiled contract envelope is invalid",
        },
        { status: 400 },
      );
    }
    if (CONTRACT_PREFLIGHT_ERROR_CODES.has(error?.code)) {
      return NextResponse.json(
        {
          ok: false,
          code: error.code,
          errorCode: error.code,
          segmentIndexes: Array.isArray(error?.segmentIndexes) ? error.segmentIndexes : [],
          error: error.message,
        },
        { status: 400 },
      );
    }
    if (error?.code === CODEX_FINALIZATION_V2_CREATE_PAUSED_CODE) {
      return NextResponse.json(
        { ok: false, code: CODEX_FINALIZATION_V2_CREATE_PAUSED_CODE, errorCode: CODEX_FINALIZATION_V2_CREATE_PAUSED_CODE, error: error.message },
        { status: 503 },
      );
    }
    const isQuotaError = error?.code === CODEX_QUOTA_EXHAUSTED_CODE || String(error?.message || "").includes(CODEX_QUOTA_EXHAUSTED_CODE);
    if (isQuotaError) {
      return NextResponse.json(
        { ok: false, error: error?.message || "Codex is unavailable", code: CODEX_QUOTA_EXHAUSTED_CODE },
        { status: 429 },
      );
    }
    return fileJobRouteError(error, "Video prompt render pack Codex job creation failed");
  }
}
