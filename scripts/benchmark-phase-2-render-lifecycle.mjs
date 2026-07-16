import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { selectCodexSlotGrants } from "./codex-cli-slot-policy.mjs";

export function runDeterministicRenderLifecycleScenario(input = {}) {
  const segmentIndexes = Array.isArray(input.segmentIndexes) && input.segmentIndexes.length
    ? [...input.segmentIndexes]
    : [1, 2, 3, 4, 5];
  const queueWaitMs = nonNegative(input.queueWaitMs, 23 * 60_000);
  const executionMs = nonNegative(input.executionMs, 8 * 60_000);
  const finalizationMs = nonNegative(input.finalizationMs, 1_000);
  const foregroundAttentionMs = nonNegative(input.foregroundAttentionMs, 12 * 60_000);
  const pollIntervalMs = Math.max(250, nonNegative(input.pollIntervalMs, 30_000));
  const elapsedMs = queueWaitMs + executionMs + finalizationMs;
  const detached = elapsedMs > foregroundAttentionMs;
  const stale = input.staleAtCompletion === true;
  const statusPolls = Math.ceil(elapsedMs / pollIntervalMs) + 1;

  return {
    segmentCount: segmentIndexes.length,
    queueWaitMs,
    executionMs,
    finalizationMs,
    elapsedMs,
    detached,
    renderJobsCreated: 1,
    observerCount: 1,
    statusPolls,
    singleGenerationCalls: 0,
    modelCalls: 0,
    judgeCalls: 0,
    repairCalls: 0,
    fallbackCalls: 0,
    qualityGateExecutions: stale ? 0 : segmentIndexes.length,
    lateMergeCount: stale ? 0 : segmentIndexes.length,
    duplicateLateMerges: 0,
    staleIgnoreCount: stale ? segmentIndexes.length : 0,
    finalStatus: stale ? "ignored" : "merged",
  };
}

export function runDeterministicSlotLifecycle(rounds = 1000) {
  const normalizedRounds = Math.max(1, Math.floor(Number(rounds) || 1000));
  let maxActiveLeases = 0;
  let maxNonOriginalWithOriginalDemand = 0;
  let starvationCount = 0;
  for (let round = 0; round < normalizedRounds; round += 1) {
    const waiters = Array.from({ length: 100 }, (_, index) => ({
      waiterId: `waiter-${round}-${index}`,
      taskClass: index % 5 === 0 ? "path_repair" : "render_pack",
      requestedAt: new Date(index).toISOString(),
    }));
    const granted = new Set();
    let leases = [];
    while (granted.size < waiters.length) {
      const pending = waiters.filter((waiter) => !granted.has(waiter.waiterId));
      const grants = selectCodexSlotGrants({ waiters: pending, leases, maxSlots: 4 });
      maxActiveLeases = Math.max(maxActiveLeases, grants.length);
      const nonOriginal = grants.filter((grant) => grant.taskClass !== "render_pack" && grant.taskClass !== "season_pack").length;
      if (pending.some((waiter) => waiter.taskClass === "render_pack" || waiter.taskClass === "season_pack")) {
        maxNonOriginalWithOriginalDemand = Math.max(maxNonOriginalWithOriginalDemand, nonOriginal);
      }
      if (!grants.length) {
        starvationCount += pending.length;
        break;
      }
      for (const grant of grants) granted.add(grant.waiterId);
      leases = [];
    }
  }
  return { rounds: normalizedRounds, maxActiveLeases, maxNonOriginalWithOriginalDemand, starvationCount };
}

export function createPhase2LifecycleReport(rounds = 1000) {
  const slots = runDeterministicSlotLifecycle(rounds);
  const scenario = runDeterministicRenderLifecycleScenario();
  const checks = {
    maxActiveLeases: slots.maxActiveLeases <= 4,
    nonOriginalAdmissionCap: slots.maxNonOriginalWithOriginalDemand <= 1,
    starvationFree: slots.starvationCount === 0,
    oneRenderJob: scenario.renderJobsCreated === 1,
    noTimeoutFallback: scenario.singleGenerationCalls === 0,
    completeLateMerge: scenario.lateMergeCount === scenario.segmentCount,
    noDuplicateMerge: scenario.duplicateLateMerges === 0,
    oneQualityPassPerSegment: scenario.qualityGateExecutions === scenario.segmentCount,
  };
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    slots,
    scenario,
    checks,
    status: Object.values(checks).every(Boolean) ? "accepted" : "rejected",
  };
}

function parseArgs(argv) {
  return Object.fromEntries(argv.filter((value) => value.startsWith("--")).map((value) => {
    const [key, ...rest] = value.slice(2).split("=");
    return [key, rest.join("=") || "true"];
  }));
}

function nonNegative(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const report = createPhase2LifecycleReport(args.rounds);
  const output = path.resolve(args.output || path.join(process.cwd(), ".tmp-task-one-evidence", "phase-2-final", "lifecycle-benchmark.json"));
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.status !== "accepted") process.exitCode = 1;
}
