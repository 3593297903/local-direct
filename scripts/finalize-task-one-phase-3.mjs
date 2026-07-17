import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PHASE_THREE_START_COMMIT = "de4443c09cbf34bc68bf8dbb0123391376025d47";
const EXPECTED_FIXTURES = Object.freeze({
  20: Object.freeze({
    fixtureHash: "4b65de1642f5d7cf318f14f818116a16dd4a1460b4269f4bb3b2f84c330706b3",
    canonicalPromptDigest: "d87ab779ae42679b1f2c980a3a877af52b1d27201e139c008791a32f8b1f2dc6",
    localPatchOperations: 57,
  }),
  30: Object.freeze({
    fixtureHash: "0329520be9b13f8548c2a338b3169d19bf58f3eb3ef61ec9c3fa3f86a8a6e216",
    canonicalPromptDigest: "5d7906a72dd17ce792d4059b4607a4ae01ca9a825182b320c165e7c0afa876ab",
    localPatchOperations: 147,
  }),
});
const MODEL_KINDS = Object.freeze([
  "season_pack",
  "render_pack",
  "single_generation",
  "path_repair",
  "coverage_judge",
  "safety_rewrite",
  "contract_correction",
]);
export const PHASE_THREE_REQUIRED_COMMAND_IDS = Object.freeze([
  "phase-three-focused-tests",
  "phase-two-regression-tests",
  "contract-preflight-benchmark",
  "phase-two-lifecycle-benchmark",
  "benchmark-20",
  "benchmark-30",
  "typecheck",
  "api-typecheck",
  "full-tests",
  "api-build",
  "frontend-build",
  "git-diff-check",
  "git-status-clean",
  "git-ancestor",
  "git-merge-tree",
]);
const ALLOWED_CHANGED_FILES = new Set([
  "app/api/video-prompt-packs/jobs/route.ts",
  "components/DashboardClient.tsx",
  "lib/batch-contract-preflight.ts",
  "lib/batch-event-feature-flags.ts",
  "lib/batch-render-operation.ts",
  "lib/batch-render-scheduler.ts",
  "lib/batch-repair-scheduler.ts",
  "lib/batch-segment-contract.ts",
  "lib/batch-segment-progress.ts",
  "lib/codex-prompt-input-compiler.ts",
  "lib/segment-batch-cache.ts",
  "lib/video-prompt-pack-codex-queue.ts",
  "scripts/benchmark-phase-3-contract-preflight.mjs",
  "scripts/finalize-task-one-phase-3.mjs",
  "test/batch-event-feature-flags.test.mjs",
  "test/batch-generation-regression.test.mjs",
  "test/batch-render-scheduler.test.mjs",
  "test/batch-segment-contract.test.mjs",
  "test/codex-finalization-v1-compatibility.test.mjs",
  "test/codex-finalization-v1-migration.test.mjs",
  "test/codex-prompt-input-compiler.test.mjs",
  "test/episode-batch-dashboard.test.mjs",
  "test/helpers/authoritative-render-pack-fixture.mjs",
  "test/task-one-contract-preflight.test.mjs",
  "test/task-one-render-refresh-recovery.test.mjs",
  "test/task-one-render-operation.test.mjs",
  "test/task-one-state-reducer.test.mjs",
  "test/task-two-render-pack-atomic-claim.test.mjs",
  "test/video-prompt-pack-codex-api.test.mjs",
  "test/video-prompt-pack-codex-queue.test.mjs",
]);

export function evaluatePhaseThreeAcceptance(input) {
  const checks = [];
  const taskCommit = input?.taskCommit;
  const baselineCommit = input?.baselineCommit;
  const sourceFingerprint = input?.sourceFingerprint;
  const reports = input?.reports || {};
  const commandResults = input?.commandResults || {};
  const git = input?.git || {};

  checks.push(
    check("identity.taskCommit", isHash(taskCommit)),
    check("identity.baselineCommit", isHash(baselineCommit)),
    check("commands.schemaVersion", commandResults.schemaVersion === 1),
    check("commands.taskCommit", commandResults.taskCommit === taskCommit),
    check("commands.baselineCommit", commandResults.baselineCommit === baselineCommit),
  );

  const commands = Array.isArray(commandResults.commands) ? commandResults.commands : [];
  const observedCommandIds = commands.map((command) => command?.commandId);
  checks.push(
    check("commands.unique", observedCommandIds.length === new Set(observedCommandIds).size),
    check("commands.count", commands.length === PHASE_THREE_REQUIRED_COMMAND_IDS.length),
    check("commands.known", observedCommandIds.every((commandId) => PHASE_THREE_REQUIRED_COMMAND_IDS.includes(commandId))),
  );
  for (const commandId of PHASE_THREE_REQUIRED_COMMAND_IDS) {
    const matches = commands.filter((command) => command?.commandId === commandId);
    checks.push(
      check(`command.${commandId}.count`, matches.length === 1),
      check(`command.${commandId}.passed`, matches[0]?.passed === true && matches[0]?.exitCode === 0),
    );
  }

  checks.push(...contractPreflightChecks(reports.contractPreflight, taskCommit, sourceFingerprint));
  checks.push(...lifecycleChecks(reports.lifecycle));
  checks.push(...qualityChecks(reports.benchmark20, 20, taskCommit, baselineCommit));
  checks.push(...qualityChecks(reports.benchmark30, 30, taskCommit, baselineCommit));

  const mergeCommand = commands.find((command) => command?.commandId === "git-merge-tree");
  const changedFiles = Array.isArray(git.changedFiles) ? git.changedFiles : [];
  checks.push(
    check("git.branch", git.branch === "task-quality-pipeline-fix"),
    check("git.clean", git.statusShort === ""),
    check("git.diffCheck", git.diffCheckExitCode === 0),
    check("git.ancestor", git.ancestorExitCode === 0),
    check("git.mergeTreeExit", git.mergeTreeExitCode === 0),
    check("git.mergeTreeHash", isTreeHash(git.mergeTreeHash)),
    check("git.mergeTreeCommandHash", mergeCommand?.summary?.treeHash === git.mergeTreeHash),
    check("git.changedFilesPresent", changedFiles.length > 0),
    check("git.changedFilesAllowed", changedFiles.every((file) => ALLOWED_CHANGED_FILES.has(file))),
  );

  const failedRequiredCheckIds = checks.filter((item) => !item.passed).map((item) => item.id);
  return {
    schemaVersion: 1,
    phase: "3",
    generatedAt: new Date().toISOString(),
    status: failedRequiredCheckIds.length ? "rejected" : "accepted",
    taskCommit: taskCommit || null,
    baselineCommit: baselineCommit || null,
    checks,
    failedRequiredCheckIds,
    summaries: {
      contractPreflight: summarizeContract(reports.contractPreflight),
      lifecycle: summarizeLifecycle(reports.lifecycle),
      quality20: summarizeQuality(reports.benchmark20),
      quality30: summarizeQuality(reports.benchmark30),
      git,
    },
  };
}

export async function writePhaseThreeAcceptance(target, input) {
  const acceptance = evaluatePhaseThreeAcceptance(input);
  await mkdir(path.dirname(path.resolve(target)), { recursive: true });
  await writeFile(target, `${JSON.stringify(acceptance, null, 2)}\n`, "utf8");
  const bytes = await readFile(target);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error("Phase 3 acceptance JSON contains UTF-8 BOM");
  }
  const parsed = JSON.parse(bytes.toString("utf8"));
  if (parsed.status !== acceptance.status || parsed.taskCommit !== acceptance.taskCommit) {
    throw new Error("Phase 3 acceptance JSON read-back mismatch");
  }
  return acceptance;
}

export async function finalizePhaseThree({ evidenceRoot, baselineRoot, taskRoot = SCRIPT_ROOT }) {
  const resolvedEvidenceRoot = path.resolve(evidenceRoot);
  const resolvedBaselineRoot = path.resolve(baselineRoot);
  const taskCommit = gitValue(taskRoot, ["rev-parse", "HEAD"]);
  const baselineCommit = gitValue(resolvedBaselineRoot, ["rev-parse", "HEAD"]);
  const commandResults = await readJsonSafe(path.join(resolvedEvidenceRoot, "verification-results.json")) || {};
  const reports = {
    contractPreflight: await readJsonSafe(path.join(resolvedEvidenceRoot, "contract-preflight-benchmark.json")),
    lifecycle: await readJsonSafe(path.join(resolvedEvidenceRoot, "phase-2-lifecycle-regression.json")),
    benchmark20: await readJsonSafe(path.join(resolvedEvidenceRoot, "benchmark-20.json")),
    benchmark30: await readJsonSafe(path.join(resolvedEvidenceRoot, "benchmark-30.json")),
  };
  const statusShort = gitValue(taskRoot, ["status", "--short"]);
  const changedFiles = gitValue(taskRoot, ["diff", "--name-only", `${PHASE_THREE_START_COMMIT}..HEAD`])
    .split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const commands = Array.isArray(commandResults.commands) ? commandResults.commands : [];
  const mergeCommand = commands.find((command) => command?.commandId === "git-merge-tree");
  const sourceFingerprint = await productionSourceFingerprint(taskRoot);
  const input = {
    taskCommit,
    baselineCommit,
    sourceFingerprint,
    reports,
    commandResults,
    git: {
      branch: gitValue(taskRoot, ["branch", "--show-current"]),
      statusShort,
      diffCheckExitCode: commandExit(commandResults, "git-diff-check"),
      ancestorExitCode: commandExit(commandResults, "git-ancestor"),
      mergeTreeExitCode: commandExit(commandResults, "git-merge-tree"),
      mergeTreeHash: mergeCommand?.summary?.treeHash || null,
      changedFiles,
    },
  };
  const acceptance = await writePhaseThreeAcceptance(path.join(resolvedEvidenceRoot, "acceptance.json"), input);
  if (acceptance.status !== "accepted") process.exitCode = 1;
  return acceptance;
}

function contractPreflightChecks(report, taskCommit, sourceFingerprint) {
  const timingEvidence = inspectContractTimingEvidence(report);
  return [
    check("contract.report", Boolean(report && typeof report === "object")),
    check("contract.benchmarkVersion", report?.benchmarkVersion === "phase-3-contract-preflight-v2"),
    check("contract.gitCommit", report?.gitCommit === taskCommit),
    check("contract.sourceFingerprint", isSha256(sourceFingerprint) && report?.sourceFingerprint === sourceFingerprint),
    check("contract.contracts", report?.contracts === 30),
    check("contract.iterations", report?.iterations === 1_000 && report?.totalIterations === 1_000),
    check("contract.trialShape", timingEvidence.trialShape),
    check("contract.sampleConservation", timingEvidence.sampleConservation),
    check("contract.sampleDigest", timingEvidence.sampleDigest),
    check("contract.trialDigest", timingEvidence.trialDigest),
    check("contract.rawSummaryIntegrity", timingEvidence.rawSummaryIntegrity),
    check("contract.trialSummaryIntegrity", timingEvidence.trialSummaryIntegrity),
    check("contract.rawCvRecorded", timingEvidence.rawCvRecorded),
    check("contract.attempts", report?.metrics?.attempts === 30),
    check("contract.invalid", report?.metrics?.invalid === 0),
    check("contract.semanticStable", report?.semanticDigestStable === true),
    check("contract.noMutation", report?.sourceMutationCount === 0),
    check("contract.noEarlyOperation", report?.operationCountBeforePreflight === 0),
    check("contract.noCanceledNeighbors", report?.canceledValidNeighbors === 0),
    check("contract.noTamperedCreate", report?.tamperedQueueCreates === 0),
    check("contract.noModelCalls", zeroCallObject(report?.calls)),
    check("contract.p95", finiteAtMost(report?.rawTimingsMs?.p95, 100)),
    check("contract.p99", finiteAtMost(report?.rawTimingsMs?.p99, 200)),
    check("contract.max", finiteAtMost(report?.rawTimingsMs?.max, 300)),
    check("contract.trialMeanCv", finiteAtMost(report?.stability?.coefficientOfVariation, 0.15)),
    ...representativeContractSetChecks(report, 20),
    ...representativeContractSetChecks(report, 30),
  ];
}

function inspectContractTimingEvidence(report) {
  const samples = Array.isArray(report?.rawSamplesMs) ? report.rawSamplesMs : [];
  const trials = Array.isArray(report?.trials) ? report.trials : [];
  const rawSamplesValid = samples.length === 1_000
    && samples.every((value) => Number.isFinite(value) && value >= 0);
  const expectedRaw = rawSamplesValid ? summarizeTimingValues(samples) : null;
  const trialShape = report?.trialCount === 5
    && report?.iterationsPerTrial === 200
    && trials.length === 5
    && trials.every((trial, index) => (
      trial?.trialIndex === index + 1
      && trial?.sampleCount === 200
      && [trial?.p50, trial?.p95, trial?.mean, trial?.max]
        .every((value) => Number.isFinite(value) && value >= 0)
    ));
  const expectedTrials = rawSamplesValid
    ? Array.from({ length: 5 }, (_, index) => {
      const timing = summarizeTimingValues(samples.slice(index * 200, (index + 1) * 200));
      return {
        trialIndex: index + 1,
        sampleCount: 200,
        p50: timing.p50,
        p95: timing.p95,
        mean: timing.mean,
        max: timing.max,
      };
    })
    : [];
  const trialValuesMatch = trialShape
    && expectedTrials.every((expected, index) => sameTimingTrial(trials[index], expected));
  const expectedTrialMeans = expectedTrials.map((trial) => trial.mean);
  const expectedStability = expectedTrialMeans.length === 5
    ? summarizeTimingValues(expectedTrialMeans)
    : null;
  const stability = report?.stability;
  const stabilityMatches = trialValuesMatch
    && stability?.metric === "trial_mean_coefficient_of_variation_v1"
    && stability?.trialCount === 5
    && stability?.iterationsPerTrial === 200
    && stability?.totalSampleCount === 1_000
    && sameNumberArray(stability?.trialMeans, expectedTrialMeans)
    && sameFiniteNumber(stability?.meanOfTrialMeans, expectedStability?.mean)
    && sameFiniteNumber(stability?.standardDeviationOfTrialMeans, expectedStability?.standardDeviation)
    && sameFiniteNumber(stability?.coefficientOfVariation, expectedStability?.coefficientOfVariation);
  const conservation = report?.sampleConservation;
  const trialSampleCount = trials.reduce((total, trial) => total + (Number.isInteger(trial?.sampleCount) ? trial.sampleCount : 0), 0);
  return {
    trialShape,
    sampleConservation: rawSamplesValid
      && trialShape
      && trialSampleCount === 1_000
      && conservation?.expectedSampleCount === 1_000
      && conservation?.rawSampleCount === 1_000
      && conservation?.trialSampleCount === 1_000
      && conservation?.preserved === true,
    sampleDigest: rawSamplesValid
      && isSha256(report?.sampleDigest)
      && report.sampleDigest === hashJson(samples),
    trialDigest: trialShape
      && isSha256(report?.trialDigest)
      && report.trialDigest === hashJson(trials),
    rawSummaryIntegrity: rawSamplesValid && sameTimingSummary(report?.rawTimingsMs, expectedRaw),
    trialSummaryIntegrity: stabilityMatches,
    rawCvRecorded: Number.isFinite(report?.rawTimingsMs?.coefficientOfVariation)
      && report.rawTimingsMs.coefficientOfVariation >= 0,
  };
}

function summarizeTimingValues(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] || 0;
  const mean = sorted.reduce((total, value) => total + value, 0) / Math.max(1, sorted.length);
  const variance = sorted.reduce((total, value) => total + ((value - mean) ** 2), 0) / Math.max(1, sorted.length);
  const standardDeviation = Math.sqrt(variance);
  return {
    count: sorted.length,
    min: sorted[0] || 0,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1) || 0,
    mean,
    standardDeviation,
    coefficientOfVariation: mean ? standardDeviation / mean : 0,
  };
}

function sameTimingSummary(actual, expected) {
  return Boolean(actual && expected)
    && actual.count === expected.count
    && ["min", "p50", "p95", "p99", "max", "mean", "standardDeviation", "coefficientOfVariation"]
      .every((key) => sameFiniteNumber(actual[key], expected[key]));
}

function sameTimingTrial(actual, expected) {
  return actual?.trialIndex === expected.trialIndex
    && actual?.sampleCount === expected.sampleCount
    && ["p50", "p95", "mean", "max"].every((key) => sameFiniteNumber(actual?.[key], expected[key]));
}

function sameNumberArray(actual, expected) {
  return Array.isArray(actual)
    && Array.isArray(expected)
    && actual.length === expected.length
    && actual.every((value, index) => sameFiniteNumber(value, expected[index]));
}

function sameFiniteNumber(actual, expected) {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
  return Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected));
}

function representativeContractSetChecks(report, count) {
  const representative = report?.representativeContractSets?.[String(count)];
  const histogram = representative?.statusHistogram;
  const ready = histogram?.ready;
  const compacted = histogram?.compacted;
  const invalid = histogram?.invalid;
  const overflow = histogram?.overflow;
  const histogramValues = [ready, compacted, invalid, overflow];
  return [
    check(`contract.representative${count}.report`, Boolean(representative && typeof representative === "object")),
    check(`contract.representative${count}.count`, representative?.contractCount === count),
    check(
      `contract.representative${count}.histogram`,
      histogramValues.every((value) => Number.isInteger(value) && value >= 0),
    ),
    check(`contract.representative${count}.invalid`, invalid === 0),
    check(`contract.representative${count}.overflow`, overflow === 0),
    check(`contract.representative${count}.resolved`, ready + compacted === count),
    check(
      `contract.representative${count}.maxBytes`,
      Number.isInteger(representative?.maxByteLength)
        && representative.maxByteLength > 0
        && representative.maxByteLength <= 3_072,
    ),
    check(`contract.representative${count}.semanticDigest`, isSha256(representative?.semanticDigest)),
  ];
}

function lifecycleChecks(report) {
  const calls = report?.calls || {
    model: report?.scenario?.modelCalls,
    judge: report?.scenario?.judgeCalls,
    repair: report?.scenario?.repairCalls,
    fallback: report?.scenario?.fallbackCalls,
    singleGeneration: report?.scenario?.singleGenerationCalls,
  };
  return [
    check("lifecycle.report", Boolean(report && typeof report === "object")),
    check("lifecycle.accepted", report?.status === "accepted"),
    check(
      "lifecycle.concurrency",
      Number.isFinite(Number(report?.physicalCoordinator?.maxActive ?? report?.maxActive))
        && Number(report?.physicalCoordinator?.maxActive ?? report?.maxActive) >= 1
        && Number(report?.physicalCoordinator?.maxActive ?? report?.maxActive) <= 4,
    ),
    check("lifecycle.starvation", Number(report?.physicalCoordinator?.starvationCount ?? report?.starvationCount) === 0),
    check("lifecycle.lockTimeout", Number(report?.physicalCoordinator?.lockTimeoutCount ?? report?.lockTimeoutCount) === 0),
    check("lifecycle.noCalls", zeroCallObject(calls)),
  ];
}

function qualityChecks(report, count, taskCommit, baselineCommit) {
  const expected = EXPECTED_FIXTURES[count];
  const canonicalHashes = report?.extensions?.canonicalPromptHashes;
  const digest = Array.isArray(canonicalHashes) ? hashJson(canonicalHashes) : null;
  const invocationCounters = report?.invocationCounters || {};
  return [
    check(`quality${count}.report`, Boolean(report && typeof report === "object")),
    check(`quality${count}.gitCommit`, report?.gitCommit === taskCommit),
    check(`quality${count}.baselineCommit`, report?.baseline?.gitCommit === baselineCommit),
    check(`quality${count}.fixtureHash`, report?.fixtureHash === expected.fixtureHash),
    check(`quality${count}.accepted`, report?.quality?.accepted === count),
    check(`quality${count}.blocked`, report?.quality?.blocked === 0),
    check(`quality${count}.needsReview`, report?.quality?.needsReview === 0),
    check(`quality${count}.promptFloor`, Number(report?.quality?.promptLengths?.min) >= 900),
    check(`quality${count}.patches`, report?.extensions?.localPatchOperations === expected.localPatchOperations),
    check(`quality${count}.canonicalCount`, Array.isArray(canonicalHashes) && canonicalHashes.length === count),
    check(`quality${count}.canonicalDigest`, digest === expected.canonicalPromptDigest),
    check(
      `quality${count}.noModelCalls`,
      MODEL_KINDS.every((kind) => invocationCounters[kind] && Number(invocationCounters[kind].executing) === 0),
    ),
    check(`quality${count}.p50Ratio`, finiteAtMost(report?.comparison?.full_local_pipeline_total?.p50Ratio, 1.05)),
    check(`quality${count}.p95Ratio`, finiteAtMost(report?.comparison?.full_local_pipeline_total?.p95Ratio, 1.05)),
    check(`quality${count}.queueScanSkipped`, report?.extensions?.queueScanStatus === "skipped_unchanged_scope"),
  ];
}

function summarizeContract(report) {
  return report ? {
    benchmarkVersion: report.benchmarkVersion,
    metrics: report.metrics,
    representativeContractSets: report.representativeContractSets,
    rawTimingsMs: report.rawTimingsMs,
    trials: report.trials,
    stability: report.stability,
    sampleDigest: report.sampleDigest,
    trialDigest: report.trialDigest,
    sampleConservation: report.sampleConservation,
    calls: report.calls,
  } : null;
}

function summarizeLifecycle(report) {
  return report ? { status: report.status, scenario: report.scenario, physicalCoordinator: report.physicalCoordinator } : null;
}

function summarizeQuality(report) {
  if (!report) return null;
  const hashes = report.extensions?.canonicalPromptHashes;
  return {
    fixtureId: report.fixtureId,
    fixtureHash: report.fixtureHash,
    accepted: report.quality?.accepted,
    blocked: report.quality?.blocked,
    needsReview: report.quality?.needsReview,
    localPatchOperations: report.extensions?.localPatchOperations,
    canonicalPromptDigest: Array.isArray(hashes) ? hashJson(hashes) : null,
    p50: report.timingsMs?.full_local_pipeline_total?.p50,
    p95: report.timingsMs?.full_local_pipeline_total?.p95,
    p50Ratio: report.comparison?.full_local_pipeline_total?.p50Ratio,
    p95Ratio: report.comparison?.full_local_pipeline_total?.p95Ratio,
  };
}

function zeroCallObject(value) {
  return Boolean(value && typeof value === "object")
    && ["model", "judge", "repair", "fallback", "singleGeneration"].every((key) => Number(value[key]) === 0);
}

function check(id, passed) {
  return { id, required: true, passed: passed === true };
}

function finiteAtMost(value, limit) {
  return Number.isFinite(Number(value)) && Number(value) <= limit;
}

function isHash(value) {
  return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
}

function isTreeHash(value) {
  return isHash(value);
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function commandExit(results, commandId) {
  const commands = Array.isArray(results?.commands) ? results.commands : [];
  const command = commands.find((item) => item?.commandId === commandId);
  return Number.isInteger(command?.exitCode) ? command.exitCode : 1;
}

async function readJson(target) {
  return JSON.parse(await readFile(target, "utf8"));
}

async function readJsonSafe(target) {
  try {
    return await readJson(target);
  } catch {
    return null;
  }
}

async function productionSourceFingerprint(root) {
  const files = [
    "lib/codex-prompt-input-compiler.ts",
    "lib/batch-contract-preflight.ts",
    "lib/batch-render-scheduler.ts",
  ];
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(path.join(root, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function gitValue(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
}

function parseArgs(argv) {
  return Object.fromEntries(argv.filter((arg) => arg.startsWith("--") && arg.includes("=")).map((arg) => {
    const index = arg.indexOf("=");
    return [arg.slice(2, index), arg.slice(index + 1)];
  }));
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args["evidence-root"] || !args["baseline-root"]) {
    console.error("Usage: node scripts/finalize-task-one-phase-3.mjs --evidence-root=<path> --baseline-root=<path>");
    process.exitCode = 1;
  } else {
    finalizePhaseThree({ evidenceRoot: args["evidence-root"], baselineRoot: args["baseline-root"] })
      .then((acceptance) => console.log(JSON.stringify({ status: acceptance.status, failed: acceptance.failedRequiredCheckIds })))
      .catch((error) => {
        console.error(error instanceof Error ? error.stack || error.message : String(error));
        process.exitCode = 1;
      });
  }
}
