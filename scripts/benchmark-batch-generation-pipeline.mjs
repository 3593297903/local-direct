import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({
  module: "commonjs",
  moduleResolution: "node",
});
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const {
  aggregateTimedReplays,
  assertBatchBenchmarkInvariants,
  createFrozenDashboardLocalAdapter,
  createBatchBenchmarkReport,
  runTimedBatchFixtureReplay,
  summarizeNumericSamples,
} = require("../lib/batch-generation-metrics.ts");

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OBSERVED_QUEUE_PAYLOAD_BYTES = Object.freeze({
  fileStorePending: Object.freeze({ p50: 89_675, p95: 169_349 }),
  legacyFlat: Object.freeze({ p50: 52_731, p95: 670_756 }),
});
const QUEUE_SCAN_COUNTS = Object.freeze([0, 100, 500, 1000]);
const VALID_JOB_STATUSES = new Set(["pending", "running", "completed", "failed"]);
const PAIRED_QUALITY_BENCHMARK_VERSION = "phase-3-quality-paired-v1";
const PAIRED_QUALITY_METRIC = "paired_trial_mean_ratio_cv_v1";

export async function runBenchmarkCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const fixtureNumber = args.fixture === "30" ? 30 : args.fixture === "20" ? 20 : 0;
  if (!fixtureNumber) throw new Error("--fixture must be 20 or 30");
  const iterations = positiveInteger(args.iterations, 400);
  const trialCount = positiveInteger(args.trials, 5);
  if (iterations !== 400) throw new Error("--iterations must be exactly 400 for an accepted Phase 3 quality report");
  if (trialCount !== 5) throw new Error("--trials must be exactly 5 for an accepted Phase 3 quality report");
  const warmups = 30;
  const taskRoot = path.resolve(scriptRoot);
  const baselineRoot = path.resolve(args["baseline-root"] || taskRoot);
  const fixtureModule = await import(pathToFileURL(path.join(
    taskRoot,
    "test",
    "fixtures",
    "batch-generation",
    `batch-generation-${fixtureNumber}-segment.mjs`,
  )).href);
  const fixture = fixtureModule.default;
  const fixtureHash = fixtureModule.computeFixtureHash(fixture);
  if (fixtureHash !== fixtureModule.FIXTURE_SHA256) throw new Error("Fixture integrity check failed");

  const baselineAdapter = loadPipelineAdapter(baselineRoot);
  const taskAdapter = loadPipelineAdapter(taskRoot);
  assertMatchingProductionSourceFingerprints(
    baselineAdapter.productionSourceFingerprint,
    taskAdapter.productionSourceFingerprint,
  );
  for (let iteration = 0; iteration < warmups; iteration += 1) {
    if (iteration % 2 === 0) {
      runTimedBatchFixtureReplay(fixture, baselineAdapter);
      runTimedBatchFixtureReplay(fixture, taskAdapter);
    } else {
      runTimedBatchFixtureReplay(fixture, taskAdapter);
      runTimedBatchFixtureReplay(fixture, baselineAdapter);
    }
  }

  const baselineRuns = [];
  const taskRuns = [];
  const pairedRuns = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const pairIndex = iteration + 1;
    let baselineRun;
    let taskRun;
    if (iteration % 2 === 0) {
      baselineRun = runTimedBatchFixtureReplay(fixture, baselineAdapter);
      taskRun = runTimedBatchFixtureReplay(fixture, taskAdapter);
    } else {
      taskRun = runTimedBatchFixtureReplay(fixture, taskAdapter);
      baselineRun = runTimedBatchFixtureReplay(fixture, baselineAdapter);
    }
    baselineRuns.push(baselineRun);
    taskRuns.push(taskRun);
    pairedRuns.push({
      pairIndex,
      order: pairIndex % 2 === 1 ? "baseline_first" : "task_first",
      baselineMs: baselineRun.timingsMs.full_local_pipeline_total,
      taskMs: taskRun.timingsMs.full_local_pipeline_total,
    });
  }

  const outputPath = path.resolve(args.output || path.join(
    taskRoot,
    ".tmp-batch-benchmark",
    `phase-0-fixture-${fixtureNumber}.json`,
  ));
  const skipQueueScan = args["skip-queue-scan"] === "true";
  const queueBenchmark = await resolveQueueBenchmarkForMode({
    skipQueueScan,
    outputRoot: path.dirname(outputPath),
    iterations,
    warmups,
    benchmarkQueueScans: benchmarkReadOnlyQueueScans,
  });
  const baselineAggregate = aggregateTimedReplays(baselineRuns);
  const taskAggregate = aggregateTimedReplays(taskRuns);
  Object.assign(taskAggregate.timingsMs, queueBenchmark.timingsMs);
  const quality = taskRuns.at(-1).quality;
  const report = createBatchBenchmarkReport({
    gitCommit: gitValue(taskRoot, ["rev-parse", "HEAD"]),
    branch: gitValue(taskRoot, ["branch", "--show-current"]),
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    fixtureId: fixture.fixtureId,
    fixtureHash,
    iterations,
    warmups,
    timingsMs: taskAggregate.timingsMs,
    payloadBytes: taskAggregate.payloadBytes,
    invocationCounters: taskRuns.at(-1).invocationCounters,
    quality,
    extensions: createBenchmarkExtensions(taskAdapter, quality, queueBenchmark.extensions),
    generatedAt: new Date().toISOString(),
  });
  const invariantResult = captureBenchmarkAssertion(() => assertBatchBenchmarkInvariants(report));
  const pipelineVariation = report.timingsMs.full_local_pipeline_total.coefficientOfVariation;

  const comparison = compareAggregates(baselineAggregate, taskAggregate);
  const pairedTimingEvidence = summarizePairedQualityTimingTrials(pairedRuns, {
    trialCount,
    pairsPerTrial: iterations / trialCount,
  });
  const qualityResult = captureBenchmarkAssertion(() => {
    assertReplayQualityNotRegressed(baselineRuns.at(-1).quality, quality);
  });
  const performanceAcceptance = evaluatePairedQualityPerformance({
    comparison,
    pairedTimingEvidence,
    invariantPassed: invariantResult.passed,
    qualityPassed: qualityResult.passed,
  });
  const finalReport = {
    ...report,
    qualityBenchmarkVersion: PAIRED_QUALITY_BENCHMARK_VERSION,
    baseline: {
      root: baselineRoot,
      gitCommit: gitValue(baselineRoot, ["rev-parse", "HEAD"]),
      timingsMs: baselineAggregate.timingsMs,
      payloadBytes: baselineAggregate.payloadBytes,
    },
    comparison,
    pairedTimingEvidence,
    performanceAcceptance,
    assertionDiagnostics: {
      invariants: invariantResult,
      quality: qualityResult,
    },
    environment: await collectEnvironment(taskRoot, { skipQueueScan }),
  };
  await writeQualityBenchmarkReport(outputPath, finalReport);
  console.log(JSON.stringify({
    reportPath: outputPath,
    fixtureId: report.fixtureId,
    fixtureHash: report.fixtureHash,
    p50: report.timingsMs.full_local_pipeline_total.p50,
    p95: report.timingsMs.full_local_pipeline_total.p95,
    coefficientOfVariation: pipelineVariation,
    invocationCounters: report.invocationCounters,
    quality: report.quality,
    extensions: report.extensions,
  }, null, 2));
  return finalReport;
}

export function summarizePairedQualityTimingTrials(pairs, options) {
  const trialCount = Number(options?.trialCount);
  const pairsPerTrial = Number(options?.pairsPerTrial);
  if (!Number.isInteger(trialCount) || trialCount <= 0
    || !Number.isInteger(pairsPerTrial) || pairsPerTrial <= 0) {
    throw new Error("Paired quality timing requires positive integer trialCount and pairsPerTrial");
  }
  const expectedPairCount = trialCount * pairsPerTrial;
  if (!Array.isArray(pairs) || pairs.length !== expectedPairCount) {
    throw new Error(`Paired quality timing pair conservation failed: expected ${expectedPairCount}, received ${pairs?.length ?? 0}`);
  }

  const rawPairs = pairs.map((pair, index) => {
    const pairIndex = index + 1;
    const expectedOrder = pairIndex % 2 === 1 ? "baseline_first" : "task_first";
    if (pair?.pairIndex !== pairIndex) {
      throw new Error(`Paired quality timing pairIndex must be contiguous at ${pairIndex}`);
    }
    if (pair?.order !== expectedOrder) {
      throw new Error(`Paired quality timing order mismatch at pairIndex ${pairIndex}`);
    }
    if (!Number.isFinite(pair?.baselineMs) || pair.baselineMs <= 0
      || !Number.isFinite(pair?.taskMs) || pair.taskMs <= 0) {
      throw new Error(`Paired quality timing values must be finite positive numbers at pairIndex ${pairIndex}`);
    }
    return {
      pairIndex,
      order: expectedOrder,
      baselineMs: pair.baselineMs,
      taskMs: pair.taskMs,
    };
  });

  const baselineSamples = rawPairs.map((pair) => pair.baselineMs);
  const taskSamples = rawPairs.map((pair) => pair.taskMs);
  const trials = Array.from({ length: trialCount }, (_, trialOffset) => {
    const trialPairs = rawPairs.slice(
      trialOffset * pairsPerTrial,
      (trialOffset + 1) * pairsPerTrial,
    );
    const baselineFirstCount = trialPairs.filter((pair) => pair.order === "baseline_first").length;
    const taskFirstCount = trialPairs.filter((pair) => pair.order === "task_first").length;
    if (baselineFirstCount !== pairsPerTrial / 2 || taskFirstCount !== pairsPerTrial / 2) {
      throw new Error(`Paired quality timing trial ${trialOffset + 1} is not order-balanced`);
    }
    const baseline = summarizePairedSamples(trialPairs.map((pair) => pair.baselineMs));
    const task = summarizePairedSamples(trialPairs.map((pair) => pair.taskMs));
    return {
      trialIndex: trialOffset + 1,
      pairCount: trialPairs.length,
      baselineFirstCount,
      taskFirstCount,
      baseline: pickTrialTimingSummary(baseline),
      task: pickTrialTimingSummary(task),
      taskToBaselineMeanRatio: task.mean / baseline.mean,
    };
  });
  const trialRatios = trials.map((trial) => trial.taskToBaselineMeanRatio);
  const ratioSummary = summarizePairedSamples(trialRatios);
  const baselineFirstCount = rawPairs.filter((pair) => pair.order === "baseline_first").length;
  const taskFirstCount = rawPairs.length - baselineFirstCount;
  const trialPairCount = trials.reduce((total, trial) => total + trial.pairCount, 0);

  return {
    metric: PAIRED_QUALITY_METRIC,
    totalPairs: rawPairs.length,
    trialCount,
    pairsPerTrial,
    rawPairs,
    baselineRawTimingsMs: summarizePairedSamples(baselineSamples),
    taskRawTimingsMs: summarizePairedSamples(taskSamples),
    trials,
    stability: {
      metric: PAIRED_QUALITY_METRIC,
      trialRatios,
      meanRatio: ratioSummary.mean,
      standardDeviationOfRatios: ratioSummary.standardDeviation,
      coefficientOfVariation: ratioSummary.coefficientOfVariation,
      maxTrialRatio: ratioSummary.max,
    },
    orderConservation: {
      baselineFirstCount,
      taskFirstCount,
      balanced: baselineFirstCount === taskFirstCount,
    },
    sampleConservation: {
      expectedPairCount,
      rawPairCount: rawPairs.length,
      baselineSampleCount: baselineSamples.length,
      taskSampleCount: taskSamples.length,
      trialPairCount,
      preserved: rawPairs.length === expectedPairCount
        && baselineSamples.length === expectedPairCount
        && taskSamples.length === expectedPairCount
        && trialPairCount === expectedPairCount,
    },
    pairDigest: hashJson(rawPairs),
    trialDigest: hashJson(trials),
  };
}

export function evaluatePairedQualityPerformance({
  comparison,
  pairedTimingEvidence,
  invariantPassed,
  qualityPassed,
}) {
  const fullPipeline = comparison?.full_local_pipeline_total || {};
  const stability = pairedTimingEvidence?.stability || {};
  const checks = [
    acceptanceCheck("quality.invariants", invariantPassed, invariantPassed, true),
    acceptanceCheck("quality.no_regression", qualityPassed, qualityPassed, true),
    acceptanceCheck("comparison.p50_ratio", fullPipeline.p50Ratio <= 1.05, fullPipeline.p50Ratio, 1.05),
    acceptanceCheck("comparison.p95_ratio", fullPipeline.p95Ratio <= 1.05, fullPipeline.p95Ratio, 1.05),
    acceptanceCheck("paired.mean_ratio", stability.meanRatio <= 1.05, stability.meanRatio, 1.05),
    acceptanceCheck(
      "paired.trial_ratio_cv",
      stability.coefficientOfVariation <= 0.15,
      stability.coefficientOfVariation,
      0.15,
    ),
    acceptanceCheck("paired.max_trial_ratio", stability.maxTrialRatio <= 1.10, stability.maxTrialRatio, 1.10),
  ];
  const failedCheckIds = checks.filter((check) => !check.passed).map((check) => check.id);
  return {
    status: failedCheckIds.length ? "rejected" : "accepted",
    checks,
    failedCheckIds,
  };
}

export async function writeQualityBenchmarkReport(outputPath, finalReport) {
  await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(finalReport, null, 2)}\n`, "utf8");
  const parsed = JSON.parse(await readFile(outputPath, "utf8"));
  if (parsed?.performanceAcceptance?.status !== "accepted") {
    const failed = parsed?.performanceAcceptance?.failedCheckIds || ["performanceAcceptance"];
    throw new Error(`Quality benchmark rejected: ${failed.join(", ")}`);
  }
  return parsed;
}

function summarizePairedSamples(values) {
  if (!Array.isArray(values) || !values.length || values.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error("Paired timing summary requires finite positive samples");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const mean = sorted.reduce((total, value) => total + value, 0) / sorted.length;
  const variance = sorted.reduce((total, value) => total + ((value - mean) ** 2), 0) / sorted.length;
  const standardDeviation = Math.sqrt(variance);
  return {
    count: sorted.length,
    min: sorted[0],
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    p99: nearestRank(sorted, 0.99),
    max: sorted.at(-1),
    mean,
    standardDeviation,
    coefficientOfVariation: mean ? standardDeviation / mean : 0,
  };
}

function nearestRank(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function pickTrialTimingSummary(summary) {
  return {
    p50: summary.p50,
    p95: summary.p95,
    p99: summary.p99,
    max: summary.max,
    mean: summary.mean,
  };
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function acceptanceCheck(id, passed, actual, limit) {
  return { id, passed: passed === true, actual, limit };
}

function captureBenchmarkAssertion(run) {
  try {
    run();
    return { passed: true, error: null };
  } catch (error) {
    return { passed: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function assertMatchingProductionSourceFingerprints(baselineFingerprint, taskFingerprint) {
  if (baselineFingerprint === taskFingerprint) return;
  throw new Error(
    "Dashboard pipeline source fingerprint differs between baseline and task; review and upgrade Frozen Adapter first",
  );
}

function loadPipelineAdapter(root) {
  return createFrozenDashboardLocalAdapter(root);
}

function createBenchmarkExtensions(adapter, quality, queueExtensions) {
  const modelPromptLengths = [...quality.modelPromptLengths].sort((left, right) => left - right);
  const at = (fraction) => modelPromptLengths[
    Math.min(modelPromptLengths.length - 1, Math.max(0, Math.ceil(modelPromptLengths.length * fraction) - 1))
  ] || 0;
  return {
    adapterVersion: adapter.adapterVersion,
    productionSourceFingerprint: adapter.productionSourceFingerprint,
    canonicalPromptHashes: quality.canonicalPromptHashes,
    modelPromptLengths: {
      min: modelPromptLengths[0] || 0,
      p50: at(0.5),
      p95: at(0.95),
      max: modelPromptLengths.at(-1) || 0,
    },
    localPatchOperations: quality.localPatchOperations,
    localPatchSegments: quality.localPatchSegments,
    uniquePatchPaths: quality.uniquePatchPaths,
    routeDecisionCounts: quality.routeDecisionCounts,
    findingCounts: quality.findingCounts,
    queueScanStatus: queueExtensions.queueScanStatus,
    queueScanSemantics: queueExtensions.queueScanSemantics,
    queueLayout: queueExtensions.queueLayout,
    queueCandidateScans: queueExtensions.layouts,
  };
}

export async function resolveQueueBenchmarkForMode({
  skipQueueScan,
  outputRoot,
  iterations,
  warmups,
  benchmarkQueueScans = benchmarkReadOnlyQueueScans,
}) {
  if (skipQueueScan) {
    return {
      timingsMs: {},
      extensions: {
        queueScanStatus: "skipped_unchanged_scope",
        queueScanSemantics: "candidate_discovery_covered_once_by_the_full_test_suite",
        queueLayout: [],
        layouts: {},
      },
    };
  }
  const benchmark = await benchmarkQueueScans(outputRoot, iterations, warmups);
  return {
    ...benchmark,
    extensions: {
      ...benchmark.extensions,
      queueScanStatus: "measured",
    },
  };
}

export async function benchmarkReadOnlyQueueScans(outputRoot, iterations, warmups, options = {}) {
  const runId = String(options.runId || process.pid).replace(/[^A-Za-z0-9._-]+/g, "-");
  const root = path.join(outputRoot, `queue-scan-${runId}`);
  const payloadProfile = options.payloadProfile || OBSERVED_QUEUE_PAYLOAD_BYTES;
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  try {
    const timingsMs = {};
    const layouts = {
      file_store_pending_scan: {},
      legacy_flat_job_scan: {},
    };
    for (const count of QUEUE_SCAN_COUNTS) {
      const countRoot = path.join(root, String(count));
      const fileStoreDirectory = path.join(countRoot, "file-store", "pending");
      const legacyDirectory = path.join(countRoot, "legacy-flat");
      await writeSyntheticQueueLayout(
        fileStoreDirectory,
        count,
        "file_store_pending_scan",
        payloadProfile.fileStorePending,
      );
      await writeSyntheticQueueLayout(
        legacyDirectory,
        count,
        "legacy_flat_job_scan",
        payloadProfile.legacyFlat,
      );

      const fileStoreMeasurement = await measureQueueCandidateScan({
        directory: fileStoreDirectory,
        layout: "file_store_pending_scan",
        iterations,
        warmups,
      });
      const legacyMeasurement = await measureQueueCandidateScan({
        directory: legacyDirectory,
        layout: "legacy_flat_job_scan",
        iterations,
        warmups,
      });
      timingsMs[`queue_claim_${count}`] = fileStoreMeasurement.timingMs;
      layouts.file_store_pending_scan[String(count)] = fileStoreMeasurement.metadata;
      layouts.legacy_flat_job_scan[String(count)] = legacyMeasurement.metadata;
    }
    return {
      timingsMs,
      extensions: {
        queueScanSemantics: "candidate_discovery_only: readdir -> read -> JSON.parse -> validate -> createdAt sort -> select",
        queueLayout: ["file_store_pending_scan", "legacy_flat_job_scan"],
        layouts,
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeSyntheticQueueLayout(directory, count, layout, payloadProfile) {
  await mkdir(directory, { recursive: true });
  const batchSize = 25;
  for (let offset = 0; offset < count; offset += batchSize) {
    const pendingWrites = [];
    for (let index = offset; index < Math.min(count, offset + batchSize); index += 1) {
      const status = layout === "file_store_pending_scan"
        ? "pending"
        : index % 7 === 0
          ? "completed"
          : index % 11 === 0
            ? "running"
            : index % 13 === 0
              ? "failed"
              : "pending";
      const createdAt = new Date(Date.UTC(2026, 6, 14, 12, 0, 0) + (count - index) * 1000).toISOString();
      const targetBytes = index % 20 === 0 ? payloadProfile.p95 : payloadProfile.p50;
      const value = {
        id: `${layout}-${String(index).padStart(4, "0")}`,
        status,
        createdAt,
        updatedAt: createdAt,
        sourceHash: "1".repeat(64),
        contractHash: "2".repeat(64),
        segmentIndexes: [index + 1],
      };
      const body = serializeSyntheticJob(value, targetBytes);
      pendingWrites.push(writeFile(
        path.join(directory, `historical-${String(index).padStart(4, "0")}.json`),
        body,
        "utf8",
      ));
    }
    await Promise.all(pendingWrites);
  }
  await writeFile(path.join(directory, "malformed.json"), "{malformed-json}\n", "utf8");
}

function serializeSyntheticJob(value, targetBytes) {
  const withPadding = { ...value, payloadPadding: "" };
  const base = `${JSON.stringify(withPadding)}\n`;
  const missingBytes = Math.max(0, Number(targetBytes) - Buffer.byteLength(base, "utf8"));
  withPadding.payloadPadding = "x".repeat(missingBytes);
  return `${JSON.stringify(withPadding)}\n`;
}

async function measureQueueCandidateScan({ directory, layout, iterations, warmups }) {
  for (let warmup = 0; warmup < warmups; warmup += 1) {
    await scanQueueDirectoryReadOnly(directory, { layout, order: "oldest" });
  }
  let attempts = 0;
  let timingMs;
  let metadata;
  do {
    const samples = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const startedAt = performance.now();
      metadata = await scanQueueDirectoryReadOnly(directory, { layout, order: "oldest" });
      samples.push(performance.now() - startedAt);
    }
    timingMs = summarizeNumericSamples(samples);
    attempts += 1;
  } while (iterations > 1 && timingMs.coefficientOfVariation > 0.2 && attempts < 2);
  return {
    timingMs,
    metadata: {
      ...metadata,
      timingMs,
      measurementAttempts: attempts,
      environmentStable: timingMs.coefficientOfVariation <= 0.2,
    },
  };
}

export async function scanQueueDirectoryReadOnly(directory, options = {}) {
  const layout = options.layout === "legacy_flat_job_scan"
    ? "legacy_flat_job_scan"
    : "file_store_pending_scan";
  const order = options.order === "newest" ? "newest" : "oldest";
  const names = (await readdir(directory))
    .filter((name) => name.toLowerCase().endsWith(".json"))
    .sort((left, right) => left.localeCompare(right));
  const candidates = [];
  let parsedFileCount = 0;
  let invalidFileCount = 0;
  let candidatePayloadBytes = 0;
  for (const name of names) {
    const raw = await readFile(path.join(directory, name), "utf8");
    candidatePayloadBytes += Buffer.byteLength(raw, "utf8");
    let value;
    try {
      value = JSON.parse(raw);
      parsedFileCount += 1;
    } catch {
      invalidFileCount += 1;
      continue;
    }
    const id = typeof value?.id === "string" ? value.id.trim() : "";
    const status = typeof value?.status === "string" ? value.status.trim().toLowerCase() : "";
    const createdAtMs = Date.parse(typeof value?.createdAt === "string" ? value.createdAt : "");
    if (!id || !VALID_JOB_STATUSES.has(status) || !Number.isFinite(createdAtMs)) {
      invalidFileCount += 1;
      continue;
    }
    if (status !== "pending") continue;
    candidates.push({ id, name, createdAt: value.createdAt, createdAtMs });
  }
  candidates.sort((left, right) => (
    left.createdAtMs - right.createdAtMs
      || left.id.localeCompare(right.id)
      || left.name.localeCompare(right.name)
  ));
  const selected = order === "newest" ? candidates.at(-1) : candidates[0];
  return {
    queueLayout: layout,
    parsedFileCount,
    invalidFileCount,
    candidateCount: candidates.length,
    candidatePayloadBytes,
    selectedJobId: selected?.id || null,
    selectedCreatedAt: selected?.createdAt || null,
  };
}

async function collectEnvironment(root, options = {}) {
  const packageJson = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(root, "package.json"), "utf8"));
  return {
    npmVersion: commandVersion("npm.cmd", ["--version"]),
    nextVersion: packageJson.dependencies?.next || packageJson.devDependencies?.next || "unknown",
    typescriptVersion: packageJson.devDependencies?.typescript || packageJson.dependencies?.typescript || "unknown",
    operatingSystem: `${os.type()} ${os.release()} ${os.arch()}`,
    systemFreeMemoryBytes: os.freemem(),
    currentNodeRssBytes: process.memoryUsage().rss,
    idleNextProcesses: readNextProcessMemory(root),
    configuration: {
      globalPrimarySlotCapacity: positiveInteger(process.env.CODEX_CLI_MAX_SLOTS, 4),
      globalPrimaryReservedSlots: positiveInteger(process.env.CODEX_CLI_PRIMARY_RESERVED_SLOTS, 3),
      renderWorkerConcurrency: positiveInteger(process.env.VIDEO_PROMPT_PACK_CODEX_CONCURRENCY, 4),
      singleWorkerConcurrency: positiveInteger(process.env.VIDEO_PROMPT_CODEX_CONCURRENCY, 3),
      coverageStage: process.env.BATCH_EVENT_COVERAGE_STAGE || "shadow",
      timeoutsMs: {
        seasonPack: positiveInteger(process.env.SEASON_PACK_CODEX_TASK_TIMEOUT_MS, 60 * 60_000),
        renderPack: positiveInteger(process.env.VIDEO_PROMPT_PACK_CODEX_TASK_TIMEOUT_MS, 30 * 60_000),
        singleRender: positiveInteger(process.env.VIDEO_PROMPT_CODEX_TASK_TIMEOUT_MS, 20 * 60_000),
        repairFrontend: 12 * 60_000,
        repairFinalObservation: 30 * 60_000,
        cliSlotWait: positiveInteger(process.env.CODEX_CLI_SLOT_WAIT_TIMEOUT_MS, 30 * 60_000),
      },
    },
    queueFiles: options.skipQueueScan
      ? { status: "skipped_unchanged_scope" }
      : await collectQueueFileStats(root),
  };
}

async function collectQueueFileStats(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && /^\.tmp-.*(?:codex|segment-batch-cache)/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const stats = {};
  for (const directory of directories) stats[directory] = await countJsonFiles(path.join(root, directory));
  return stats;
}

async function countJsonFiles(root) {
  let count = 0;
  let bytes = 0;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        count += 1;
        bytes += (await stat(target)).size;
      }
    }
  }
  return { count, bytes };
}

function readNextProcessMemory(root) {
  if (process.platform !== "win32") return [];
  const escapedRoot = root.replace(/'/g, "''");
  const command = [
    "$items = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" |",
    `Where-Object { $_.CommandLine -like '*${escapedRoot}*' -and $_.CommandLine -match 'next(?:-server|\\s+dev)' } |`,
    "Select-Object ProcessId, WorkingSetSize;",
    "@($items) | ConvertTo-Json -Compress",
  ].join(" ");
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    return output ? JSON.parse(output) : [];
  } catch {
    return [];
  }
}

function compareAggregates(baseline, task) {
  const keys = new Set([...Object.keys(baseline.timingsMs), ...Object.keys(task.timingsMs)]);
  return Object.fromEntries([...keys].map((key) => {
    const baselineTiming = baseline.timingsMs[key];
    const taskTiming = task.timingsMs[key];
    return [key, {
      baselineP50: baselineTiming?.p50 || 0,
      baselineP95: baselineTiming?.p95 || 0,
      taskP50: taskTiming?.p50 || 0,
      taskP95: taskTiming?.p95 || 0,
      p50Ratio: baselineTiming?.p50 ? taskTiming.p50 / baselineTiming.p50 : 1,
      p95Ratio: baselineTiming?.p95 ? taskTiming.p95 / baselineTiming.p95 : 1,
    }];
  }));
}

function assertReplayQualityNotRegressed(baseline, task) {
  const minimum = (values) => Math.min(...values);
  if (task.accepted < baseline.accepted || task.blocked > baseline.blocked) {
    throw new Error("Frozen task quality route counts regressed from baseline");
  }
  if (task.missingRequiredFields > baseline.missingRequiredFields) {
    throw new Error("Frozen task introduced missing required fields");
  }
  if (minimum(task.promptLengths) < minimum(baseline.promptLengths)) {
    throw new Error("Frozen task canonical prompt length regressed from baseline");
  }
}

function parseArgs(argv) {
  return Object.fromEntries(argv.map((argument) => {
    if (argument === "--skip-queue-scan") return ["skip-queue-scan", "true"];
    const match = argument.match(/^--([^=]+)=(.*)$/);
    if (!match) throw new Error(`Unsupported argument: ${argument}`);
    return [match[1], match[2]];
  }));
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function gitValue(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function commandVersion(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  runBenchmarkCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
