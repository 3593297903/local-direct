import { DEFAULT_COVERAGE_POLICY_VERSION } from "./batch-segment-contract";
import type { BatchEventCoverageStage } from "./batch-segment-outcome-router";

export type BatchEventFeatureSnapshot = {
  contractV2: boolean;
  contractPreflightV2: boolean;
  coverageSidecar: boolean;
  coverageStage: BatchEventCoverageStage;
  emergencyStop: boolean;
  /** @deprecated Derived from coverageStage for older persisted jobs. */
  localGate: boolean;
  /** @deprecated Derived from coverageStage for older persisted jobs. */
  judge: boolean;
  coveragePolicyVersion: string;
  capturedAt: string;
};

type FeatureEnvironment = Record<string, string | undefined>;

export function createBatchEventFeatureSnapshot(
  environment: FeatureEnvironment = process.env,
  capturedAt = new Date().toISOString(),
): BatchEventFeatureSnapshot {
  const emergencyStop = readBoolean(environment.BATCH_EVENT_COVERAGE_EMERGENCY_STOP, false);
  const requestedStage = readCoverageStage(environment.BATCH_EVENT_COVERAGE_STAGE)
    || legacyCoverageStage(environment);
  const coverageStage = emergencyStop ? "shadow" : requestedStage;
  return {
    contractV2: readBoolean(environment.BATCH_EVENT_CONTRACT_V2, true),
    contractPreflightV2: readBoolean(environment.BATCH_CONTRACT_PREFLIGHT_V2, true),
    coverageSidecar: readBoolean(environment.BATCH_EVENT_COVERAGE_SIDECAR, true),
    coverageStage,
    emergencyStop,
    localGate: coverageStageUsesLocalGate(coverageStage),
    judge: coverageStageInvokesJudge(coverageStage),
    coveragePolicyVersion: cleanVersion(environment.BATCH_EVENT_COVERAGE_POLICY_VERSION),
    capturedAt,
  };
}

export function normalizeBatchEventFeatureSnapshot(
  value: Partial<BatchEventFeatureSnapshot> | null | undefined,
  fallbackCapturedAt = new Date().toISOString(),
): BatchEventFeatureSnapshot {
  const defaults = createBatchEventFeatureSnapshot({}, fallbackCapturedAt);
  if (!value || typeof value !== "object") return defaults;
  const emergencyStop = typeof value.emergencyStop === "boolean" ? value.emergencyStop : false;
  const normalizedStage = readCoverageStage(value.coverageStage)
    || legacySnapshotCoverageStage(value);
  const coverageStage = emergencyStop ? "shadow" : normalizedStage;
  return {
    contractV2: typeof value.contractV2 === "boolean" ? value.contractV2 : defaults.contractV2,
    contractPreflightV2: typeof value.contractPreflightV2 === "boolean"
      ? value.contractPreflightV2
      : defaults.contractPreflightV2,
    coverageSidecar: typeof value.coverageSidecar === "boolean" ? value.coverageSidecar : defaults.coverageSidecar,
    coverageStage,
    emergencyStop,
    localGate: coverageStageUsesLocalGate(coverageStage),
    judge: coverageStageInvokesJudge(coverageStage),
    coveragePolicyVersion: cleanVersion(value.coveragePolicyVersion),
    capturedAt: validTimestamp(value.capturedAt) ? value.capturedAt! : fallbackCapturedAt,
  };
}

export function coverageStageUsesLocalGate(stage: BatchEventCoverageStage) {
  return stage !== "shadow";
}

export function coverageStageInvokesJudge(stage: BatchEventCoverageStage) {
  return stage === "judge-shadow" || stage === "judge-active" || stage === "patch-active";
}

export function coverageStageUsesJudgeDecision(stage: BatchEventCoverageStage) {
  return stage === "judge-active" || stage === "patch-active";
}

export function coverageStageAllowsPatch(stage: BatchEventCoverageStage) {
  return stage === "patch-active";
}

function readBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined || value === "") return fallback;
  return value.trim().toLowerCase() === "true";
}

function readCoverageStage(value: unknown): BatchEventCoverageStage | null {
  const stage = String(value || "").trim().toLowerCase();
  return (["shadow", "local", "judge-shadow", "judge-active", "patch-active"] as string[]).includes(stage)
    ? stage as BatchEventCoverageStage
    : null;
}

function legacyCoverageStage(environment: FeatureEnvironment): BatchEventCoverageStage {
  const judge = readBoolean(environment.BATCH_EVENT_COVERAGE_JUDGE, false);
  const localGate = readBoolean(environment.BATCH_EVENT_COVERAGE_LOCAL_GATE, false);
  if (judge) return "judge-active";
  if (localGate) return "local";
  return "shadow";
}

function legacySnapshotCoverageStage(value: Partial<BatchEventFeatureSnapshot>): BatchEventCoverageStage {
  if (value.judge === true) return "judge-active";
  if (value.localGate === true) return "local";
  return "shadow";
}

function cleanVersion(value: unknown) {
  const version = String(value || "").trim();
  return version && version.length <= 120 ? version : DEFAULT_COVERAGE_POLICY_VERSION;
}

function validTimestamp(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
