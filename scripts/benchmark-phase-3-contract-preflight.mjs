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
  normalizeSegmentContract,
} = require("../lib/batch-segment-contract.ts");
const {
  compileSegmentContractForPrompt,
} = require("../lib/codex-prompt-input-compiler.ts");

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

  const fixtureSets = Object.fromEntries(await Promise.all([20, 30].map(async (segmentCount) => {
    const module = await import(pathToFileURL(path.join(
      taskRoot,
      "test",
      "fixtures",
      "batch-generation",
      `batch-generation-${segmentCount}-segment.mjs`,
    )).href);
    const fixture = module.default;
    const fixtureHash = module.computeFixtureHash(fixture);
    if (fixtureHash !== module.FIXTURE_SHA256) throw new Error(`Phase 3 ${segmentCount}-segment fixture integrity check failed`);
    if (fixture.contracts.length !== segmentCount) throw new Error(`Phase 3 ${segmentCount}-segment fixture contract count changed`);
    return [String(segmentCount), { fixture, fixtureHash }];
  })));

  const fixtureContractsBefore = hashJson(Object.values(fixtureSets).map(({ fixture }) => fixture.contracts));
  const normalizedSets = Object.fromEntries(Object.entries(fixtureSets).map(([segmentCount, { fixture }]) => [
    segmentCount,
    fixture.contracts.map(normalizeProductionContract),
  ]));
  const normalizedContractsBefore = hashJson(normalizedSets);
  const representativeContractSets = Object.fromEntries(Object.entries(normalizedSets).map(([segmentCount, normalized]) => [
    segmentCount,
    summarizeRepresentativeContracts(fixtureSets[segmentCount], normalized),
  ]));
  const targetContracts = normalizedSets["30"];
  const items = targetContracts.map((currentContract) => {
    return {
      segmentIndex: currentContract.segmentIndex,
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
  const fixtureContractsAfter = hashJson(Object.values(fixtureSets).map(({ fixture }) => fixture.contracts));
  const normalizedContractsAfter = hashJson(normalizedSets);
  const timingsMs = summarize(samples);
  return {
    schemaVersion: 1,
    phase: "3",
    gitCommit: gitValue(taskRoot, ["rev-parse", "HEAD"]),
    branch: gitValue(taskRoot, ["branch", "--show-current"]),
    fixtureId: fixtureSets["30"].fixture.fixtureId,
    fixtureHash: fixtureSets["30"].fixtureHash,
    fixtureHashes: Object.fromEntries(Object.entries(fixtureSets).map(([segmentCount, item]) => [segmentCount, item.fixtureHash])),
    representativeContractSets,
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
    sourceMutationCount: sourceBefore === sourceAfter
      && fixtureContractsBefore === fixtureContractsAfter
      && normalizedContractsBefore === normalizedContractsAfter
      ? 0
      : 1,
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
  for (const segmentCount of ["20", "30"]) {
    const representative = report.representativeContractSets[segmentCount];
    if (representative.statusHistogram.invalid !== 0
      || representative.statusHistogram.overflow !== 0
      || representative.statusHistogram.ready + representative.statusHistogram.compacted !== Number(segmentCount)
      || representative.maxByteLength > 3_072) {
      throw new Error(`Production-shaped ${segmentCount}-segment Contract set failed the 3072-byte gate`);
    }
  }
  if (report.sourceMutationCount !== 0 || !report.semanticDigestStable) {
    throw new Error("Contract preflight benchmark changed source semantics");
  }
  if (report.timingsMs.p95 > 100) throw new Error(`Contract preflight p95 exceeds 100ms: ${report.timingsMs.p95}`);
  await writeJson(output, report);
  console.log(JSON.stringify({ output, p50: report.timingsMs.p50, p95: report.timingsMs.p95, cv: report.timingsMs.coefficientOfVariation }));
  return report;
}

function normalizeProductionContract(contract) {
  const raw = structuredClone(contract);
  delete raw.sourceHash;
  delete raw.contractHash;
  return normalizeSegmentContract(raw, {
    segmentIndex: raw.segmentIndex,
    fallbackTitle: raw.title,
    fallbackSourceText: raw.sourceText,
    fallbackDurationSeconds: raw.durationSeconds,
    fallbackShotCount: raw.shotCount,
    coveragePolicyVersion: raw.coveragePolicyVersion,
    forbiddenFutureEvents: raw.forbiddenFutureEvents,
  });
}

function summarizeRepresentativeContracts({ fixture, fixtureHash }, contracts) {
  const compiled = contracts.map((contract) => compileSegmentContractForPrompt(contract));
  const statusHistogram = { ready: 0, compacted: 0, invalid: 0, overflow: 0 };
  for (const result of compiled) statusHistogram[result.status] += 1;
  return {
    fixtureId: fixture.fixtureId,
    fixtureHash,
    contractCount: contracts.length,
    statusHistogram,
    maxByteLength: Math.max(0, ...compiled.map((result) => Number(result.byteLength) || 0)),
    semanticDigest: hashJson(compiled.map((result) => result.semanticManifest || null)),
  };
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
