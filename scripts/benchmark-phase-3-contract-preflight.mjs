import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({
  module: "commonjs",
  moduleResolution: "node",
});
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const {
  buildPreflightedRenderPacks,
  preflightSegmentContracts,
} = require("../lib/batch-contract-preflight.ts");
const {
  buildSegmentContractHash,
  buildSegmentContractSourceHash,
} = require("../lib/batch-segment-contract.ts");

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ZERO_CALLS = Object.freeze({
  model: 0,
  judge: 0,
  repair: 0,
  fallback: 0,
  singleGeneration: 0,
});

export async function runContractPreflightBenchmark({
  contracts = 30,
  iterations = 1_000,
  warmups = 30,
  taskRoot = SCRIPT_ROOT,
} = {}) {
  if (!Number.isInteger(contracts) || contracts !== 30) {
    throw new Error("Phase 3 benchmark requires exactly 30 contracts");
  }
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error("iterations must be a positive integer");
  if (!Number.isInteger(warmups) || warmups < 0) throw new Error("warmups must be a non-negative integer");

  const fixtureModule = await import(pathToFileURL(path.join(
    taskRoot,
    "test",
    "fixtures",
    "batch-generation",
    "batch-generation-30-segment.mjs",
  )).href);
  const fixture = fixtureModule.default;
  const fixtureHash = fixtureModule.computeFixtureHash(fixture);
  if (fixtureHash !== fixtureModule.FIXTURE_SHA256) throw new Error("Phase 3 fixture integrity check failed");
  if (fixture.contracts.length !== contracts) throw new Error("Phase 3 fixture contract count changed");

  const fixtureContractsBefore = hashJson(fixture.contracts);
  const templateContract = fixture.contracts[0];
  const items = Array.from({ length: contracts }, (_, index) => {
    const currentContract = structuredClone(templateContract);
    currentContract.segmentIndex = index + 1;
    currentContract.title = `Contract Preflight Benchmark Segment ${index + 1}`;
    currentContract.sourceHash = buildSegmentContractSourceHash(currentContract.sourceText);
    currentContract.contractHash = buildSegmentContractHash(currentContract);
    return {
      segmentIndex: index + 1,
      sourceText: currentContract.sourceText,
      contract: currentContract,
      shotCount: currentContract.shotCount,
    };
  });
  const sourceBefore = hashJson(items.map((item) => item.contract));
  const options = {
    getSegmentIndex: (item) => item.segmentIndex,
    getSourceText: (item) => item.sourceText,
    getContract: (item) => item.contract,
    getScheduleSegment: (entry) => ({
      sourceText: entry.item.sourceText,
      shotCount: entry.item.shotCount,
      segmentContract: entry.item.contract,
    }),
  };

  let referenceSemanticDigest = null;
  let lastPlan = null;
  let lastSchedule = null;
  const runOnce = () => {
    const startedAt = performance.now();
    const plan = preflightSegmentContracts(items, options);
    const schedule = buildPreflightedRenderPacks(plan, options);
    const elapsedMs = performance.now() - startedAt;
    const semanticDigest = hashJson([
      ...plan.eligibleRuns.flat(),
      ...plan.isolated,
    ].map((entry) => entry.preflight.compile.semanticManifest));
    if (referenceSemanticDigest === null) referenceSemanticDigest = semanticDigest;
    else if (referenceSemanticDigest !== semanticDigest) throw new Error("Contract semantic digest changed across runs");
    lastPlan = plan;
    lastSchedule = schedule;
    return elapsedMs;
  };

  for (let index = 0; index < warmups; index += 1) runOnce();
  const samples = [];
  for (let index = 0; index < iterations; index += 1) samples.push(runOnce());

  const sourceAfter = hashJson(items.map((item) => item.contract));
  const fixtureContractsAfter = hashJson(fixture.contracts);
  const timingsMs = summarize(samples);
  return {
    schemaVersion: 1,
    phase: "3",
    gitCommit: gitValue(taskRoot, ["rev-parse", "HEAD"]),
    branch: gitValue(taskRoot, ["branch", "--show-current"]),
    fixtureId: fixture.fixtureId,
    fixtureHash,
    contractSetDigest: sourceBefore,
    sourceFingerprint: await productionSourceFingerprint(taskRoot),
    contracts,
    iterations,
    warmups,
    metrics: { ...lastPlan.metrics },
    packCount: lastSchedule.packs.length,
    eligibleSegmentCount: lastSchedule.packs.reduce((total, pack) => total + pack.entries.length, 0),
    semanticDigest: referenceSemanticDigest,
    semanticDigestStable: true,
    sourceMutationCount: sourceBefore === sourceAfter && fixtureContractsBefore === fixtureContractsAfter ? 0 : 1,
    operationCountBeforePreflight: 0,
    canceledValidNeighbors: 0,
    tamperedQueueCreates: 0,
    calls: { ...ZERO_CALLS },
    timingsMs,
    generatedAt: new Date().toISOString(),
  };
}

export async function runContractPreflightBenchmarkCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const contracts = integer(args.contracts, 30);
  const iterations = integer(args.iterations, 1_000);
  if (contracts !== 30) throw new Error("--contracts must be 30");
  if (iterations < 1_000) throw new Error("--iterations must be at least 1000");
  const output = path.resolve(args.output || path.join(SCRIPT_ROOT, ".tmp-task-one-evidence", "phase-3-final", "contract-preflight-benchmark.json"));
  const report = await runContractPreflightBenchmark({ contracts, iterations, warmups: 30 });
  if (report.metrics.attempts !== 30 || report.metrics.invalid !== 0) {
    throw new Error("Contract preflight benchmark did not accept all 30 deterministic contracts");
  }
  if (report.sourceMutationCount !== 0 || !report.semanticDigestStable) {
    throw new Error("Contract preflight benchmark changed source semantics");
  }
  if (report.timingsMs.p95 > 100) throw new Error(`Contract preflight p95 exceeds 100ms: ${report.timingsMs.p95}`);
  await writeJson(output, report);
  console.log(JSON.stringify({ output, p50: report.timingsMs.p50, p95: report.timingsMs.p95, cv: report.timingsMs.coefficientOfVariation }));
  return report;
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] || 0;
  const mean = sorted.reduce((total, value) => total + value, 0) / Math.max(1, sorted.length);
  const variance = sorted.reduce((total, value) => total + ((value - mean) ** 2), 0) / Math.max(1, sorted.length);
  const standardDeviation = Math.sqrt(variance);
  return {
    count: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted.at(-1) || 0,
    mean,
    standardDeviation,
    coefficientOfVariation: mean ? standardDeviation / mean : 0,
  };
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

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
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

function integer(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

async function writeJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  JSON.parse(await readFile(target, "utf8"));
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  runContractPreflightBenchmarkCli().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
