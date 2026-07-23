import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_BASELINE_COMMIT = "697e2c9aa77d009b2ac5b0f240e0ffa49292e005";
const EXPECTED_ADAPTER_VERSION = "frozen-dashboard-local-v2";
const EXPECTED_PRODUCTION_FINGERPRINT = "805aa2b46f96d33fd89c5fa4a82a8d7390bde1983c0f62139a988e0d2a78a237";
const MODEL_KINDS = Object.freeze([
  "season_pack",
  "render_pack",
  "single_generation",
  "path_repair",
  "coverage_judge",
  "safety_rewrite",
  "contract_correction",
]);
export const PHASE_ZERO_REQUIRED_COMMAND_IDS = Object.freeze([
  "focused-tests",
  "benchmark-20",
  "benchmark-30",
  "artifact-analysis-1",
  "artifact-analysis-2",
  "typecheck",
  "api-typecheck",
  "full-tests",
  "api-build",
  "frontend-build",
  "privacy-safe",
  "git-diff-check",
  "git-status-clean",
  "git-ancestor",
  "git-merge-tree",
]);
const ALLOWED_POSTGRES_SKIP =
  "twenty concurrent PostgreSQL saves create one version and replay the same ids";
const FIXTURE_EXPECTATIONS = Object.freeze({
  20: Object.freeze({
    fixtureId: "observed-20-segment",
    fixtureHash: "4b65de1642f5d7cf318f14f818116a16dd4a1460b4269f4bb3b2f84c330706b3",
    localPatchOperations: 57,
    warning: 156,
    risk: 102,
  }),
  30: Object.freeze({
    fixtureId: "representative-30-segment",
    fixtureHash: "0329520be9b13f8548c2a338b3169d19bf58f3eb3ef61ec9c3fa3f86a8a6e216",
    localPatchOperations: 147,
    warning: 201,
    risk: 184,
  }),
});

export async function writeJsonEvidence(target, value) {
  await mkdir(path.dirname(path.resolve(target)), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  const bytes = await readFile(target);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error(`JSON evidence contains UTF-8 BOM: ${target}`);
  }
  const text = bytes.toString("utf8");
  if (text.trimStart()[0] !== "{") throw new Error(`JSON evidence must start with an object: ${target}`);
  JSON.parse(text);
}

export function evaluateRequiredChecks(checks) {
  const normalizedChecks = checks.map((check) => ({
    required: check.required !== false,
    ...check,
    passed: check.passed === true,
  }));
  const failedRequiredCheckIds = normalizedChecks
    .filter((check) => check.required && !check.passed)
    .map((check) => check.id);
  return {
    status: failedRequiredCheckIds.length ? "rejected" : "accepted",
    requiredCheckCount: normalizedChecks.filter((check) => check.required).length,
    passedRequiredCheckCount: normalizedChecks.filter((check) => check.required && check.passed).length,
    failedRequiredCheckIds,
    checks: normalizedChecks,
  };
}

export function buildBenchmarkIdentityChecks(report, expected, label) {
  return [
    exactCheck(`${label}.gitCommit`, expected.taskCommit, report?.gitCommit),
    exactCheck(`${label}.baselineCommit`, expected.baselineCommit, report?.baseline?.gitCommit),
    exactCheck(`${label}.fixtureHash`, expected.fixtureHash, report?.fixtureHash),
    exactCheck(`${label}.adapterVersion`, expected.adapterVersion, report?.extensions?.adapterVersion),
    exactCheck(
      `${label}.productionSourceFingerprint`,
      expected.productionSourceFingerprint,
      report?.extensions?.productionSourceFingerprint,
    ),
  ];
}

export async function validateExternalVerification({
  evidenceRoot,
  externalVerification,
  expectedTaskCommit,
  expectedBaselineCommit,
  readError = null,
}) {
  const resolvedEvidenceRoot = path.resolve(evidenceRoot);
  const document = externalVerification && typeof externalVerification === "object"
    ? externalVerification
    : {};
  const commands = Array.isArray(document.commands) ? document.commands : [];
  const commandIds = commands.map((command) => command?.commandId);
  const checks = [
    exactCheck("external.readable", null, readError),
    exactCheck("external.document", true, Boolean(externalVerification && typeof externalVerification === "object")),
    exactCheck("external.schemaVersion", 1, document.schemaVersion),
    exactCheck("external.taskCommit", expectedTaskCommit, document.taskCommit),
    exactCheck("external.baselineCommit", expectedBaselineCommit, document.baselineCommit),
    exactCheck("external.commandsArray", true, Array.isArray(document.commands)),
    exactCheck("external.commandIdsUnique", commandIds.length, new Set(commandIds).size),
  ];
  const commandSummaries = [];

  for (const commandId of PHASE_ZERO_REQUIRED_COMMAND_IDS) {
    const matches = commands.filter((command) => command?.commandId === commandId);
    const command = matches[0] || {};
    const prefix = `external.command.${commandId}`;
    checks.push(
      exactCheck(`${prefix}.count`, 1, matches.length),
      exactCheck(`${prefix}.exitCode`, 0, command.exitCode),
      exactCheck(`${prefix}.passed`, true, command.passed),
      exactCheck(
        `${prefix}.argv`,
        true,
        Array.isArray(command.argv) && command.argv.length > 0
          && command.argv.every((entry) => typeof entry === "string" && entry.length > 0),
      ),
    );

    const logValidation = await validateExternalLog({
      evidenceRoot: resolvedEvidenceRoot,
      commandId,
      logPath: command.logPath,
      expectedSha256: command.logSha256,
    });
    checks.push(...logValidation.checks);
    const semanticChecks = buildExternalCommandSemanticChecks(commandId, command.summary);
    checks.push(...semanticChecks);
    const commandAcceptance = evaluateRequiredChecks([
      exactCheck(`${prefix}.commandPresent`, 1, matches.length),
      exactCheck(`${prefix}.commandExitCode`, 0, command.exitCode),
      exactCheck(`${prefix}.commandPassed`, true, command.passed),
      ...logValidation.checks,
      ...semanticChecks,
    ]);
    commandSummaries.push({
      commandId,
      argv: Array.isArray(command.argv) ? command.argv : [],
      exitCode: Number.isInteger(command.exitCode) ? command.exitCode : null,
      reportedPassed: command.passed === true,
      verifiedPassed: commandAcceptance.status === "accepted",
      logPath: typeof command.logPath === "string" ? command.logPath : null,
      logSha256: typeof command.logSha256 === "string" ? command.logSha256 : null,
      summary: command.summary && typeof command.summary === "object" ? command.summary : {},
    });
  }

  const acceptance = evaluateRequiredChecks(checks);
  return {
    checks,
    summary: {
      schemaVersion: document.schemaVersion ?? null,
      taskCommit: document.taskCommit ?? null,
      baselineCommit: document.baselineCommit ?? null,
      requiredCommandCount: PHASE_ZERO_REQUIRED_COMMAND_IDS.length,
      observedCommandCount: commands.length,
      failedRequiredCheckIds: acceptance.failedRequiredCheckIds,
      status: acceptance.status,
      commands: commandSummaries,
    },
  };
}

async function validateExternalLog({ evidenceRoot, commandId, logPath, expectedSha256 }) {
  const prefix = `external.command.${commandId}.log`;
  const relativePathValid = typeof logPath === "string"
    && logPath.length > 0
    && !path.isAbsolute(logPath);
  const resolvedLogPath = relativePathValid ? path.resolve(evidenceRoot, logPath) : null;
  const lexicalRelative = resolvedLogPath ? path.relative(evidenceRoot, resolvedLogPath) : "";
  const lexicalInside = Boolean(
    resolvedLogPath
      && lexicalRelative
      && lexicalRelative !== ".."
      && !lexicalRelative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(lexicalRelative),
  );
  let bytes = null;
  let readError = null;
  let realInside = false;
  if (lexicalInside) {
    try {
      const [realRoot, realLog] = await Promise.all([
        realpath(evidenceRoot),
        realpath(resolvedLogPath),
      ]);
      const realRelative = path.relative(realRoot, realLog);
      realInside = Boolean(
        realRelative
          && realRelative !== ".."
          && !realRelative.startsWith(`..${path.sep}`)
          && !path.isAbsolute(realRelative),
      );
      if (realInside) bytes = await readFile(realLog);
    } catch (error) {
      readError = error instanceof Error ? error.message : String(error);
    }
  }
  const actualSha256 = bytes
    ? createHash("sha256").update(bytes).digest("hex")
    : null;
  const text = bytes ? bytes.toString("utf8") : "";
  const utf8WithoutBom = Boolean(
    bytes
      && !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
      && !text.includes("\uFFFD"),
  );
  const expectedHashValid = typeof expectedSha256 === "string" && /^[a-f0-9]{64}$/i.test(expectedSha256);
  return {
    checks: [
      exactCheck(`${prefix}.relativePath`, true, relativePathValid),
      exactCheck(`${prefix}.insideEvidenceRoot`, true, lexicalInside && realInside),
      exactCheck(`${prefix}.readable`, null, readError),
      exactCheck(`${prefix}.exists`, true, Boolean(bytes)),
      exactCheck(`${prefix}.sha256Format`, true, expectedHashValid),
      exactCheck(`${prefix}.sha256`, expectedHashValid ? expectedSha256.toLowerCase() : null, actualSha256),
      exactCheck(`${prefix}.utf8WithoutBom`, true, utf8WithoutBom),
      exactCheck(`${prefix}.privacySafe`, false, containsSensitiveLogMaterial(text)),
    ],
  };
}

function buildExternalCommandSemanticChecks(commandId, summaryValue) {
  const summary = summaryValue && typeof summaryValue === "object" ? summaryValue : {};
  const checks = [];
  if (commandId === "focused-tests") {
    checks.push(...buildTestSummaryChecks(commandId, summary.testSummary, { allowPostgresSkip: false }));
  }
  if (commandId === "full-tests") {
    checks.push(...buildTestSummaryChecks(commandId, summary.testSummary, { allowPostgresSkip: true }));
  }
  if (commandId === "privacy-safe") {
    const testSummary = summary.testSummary && typeof summary.testSummary === "object"
      ? summary.testSummary
      : {};
    checks.push(
      exactCheck("external.command.privacy-safe.result", true, summary.privacySafe),
      exactCheck(
        "external.command.privacy-safe.testsPresent",
        true,
        Number.isInteger(Number(testSummary.tests)) && Number(testSummary.tests) > 0,
      ),
      exactCheck("external.command.privacy-safe.failures", 0, Number(testSummary.fail)),
      exactCheck(
        "external.command.privacy-safe.passesPresent",
        true,
        Number.isInteger(Number(testSummary.pass)) && Number(testSummary.pass) > 0,
      ),
    );
  }
  if (commandId === "git-diff-check" || commandId === "git-status-clean") {
    checks.push(exactCheck(`external.command.${commandId}.clean`, true, summary.clean));
  }
  if (commandId === "git-ancestor") {
    checks.push(exactCheck("external.command.git-ancestor.result", true, summary.isAncestor));
  }
  if (commandId === "git-merge-tree") {
    checks.push(exactCheck(
      "external.command.git-merge-tree.treeHash",
      true,
      typeof summary.treeHash === "string" && /^[a-f0-9]{40}$/i.test(summary.treeHash),
    ));
  }
  return checks;
}

function buildTestSummaryChecks(commandId, value, { allowPostgresSkip }) {
  const summary = value && typeof value === "object" ? value : {};
  const tests = Number(summary.tests);
  const passed = Number(summary.pass);
  const failed = Number(summary.fail);
  const skipped = Number(summary.skipped);
  const skippedTests = Array.isArray(summary.skippedTests) ? summary.skippedTests : [];
  const allowedSkips = skipped === 0
    ? skippedTests.length === 0
    : allowPostgresSkip
      && skipped === 1
      && skippedTests.length === 1
      && skippedTests[0] === ALLOWED_POSTGRES_SKIP;
  return [
    exactCheck(`external.command.${commandId}.testsPresent`, true, Number.isInteger(tests) && tests > 0),
    exactCheck(`external.command.${commandId}.failures`, 0, failed),
    exactCheck(`external.command.${commandId}.passesPresent`, true, Number.isInteger(passed) && passed > 0),
    exactCheck(`external.command.${commandId}.skipsAllowed`, true, allowedSkips),
    exactCheck(`external.command.${commandId}.testConservation`, tests, passed + failed + skipped),
  ];
}

function containsSensitiveLogMaterial(text) {
  return /(?:OPENAI_API_KEY|DATABASE_URL|REDIS_URL|ADMIN_PASSWORD|AUTH_SECRET|API_TOKEN)\s*[:=]\s*\S+/i.test(text)
    || /["']?(?:fullVideoPrompt|sourceText|promptText|optimizedScript)["']?\s*:/i.test(text);
}

export async function finalizePhaseZeroEvidence({ evidenceRoot, baselineRoot, taskRoot = SCRIPT_ROOT }) {
  const resolvedEvidenceRoot = path.resolve(evidenceRoot);
  const resolvedBaselineRoot = path.resolve(baselineRoot);
  const taskCommit = gitValue(taskRoot, ["rev-parse", "HEAD"]);
  const actualBaselineCommit = gitValue(resolvedBaselineRoot, ["rev-parse", "HEAD"]);
  const externalRead = await readJsonOrError(path.join(
    resolvedEvidenceRoot,
    "external-verification.json",
  ));
  const externalValidation = await validateExternalVerification({
    evidenceRoot: resolvedEvidenceRoot,
    externalVerification: externalRead.value,
    expectedTaskCommit: taskCommit,
    expectedBaselineCommit: EXPECTED_BASELINE_COMMIT,
    readError: externalRead.error,
  });
  const checks = [
    exactCheck("baseline.currentCommit", EXPECTED_BASELINE_COMMIT, actualBaselineCommit),
    ...externalValidation.checks,
  ];
  const benchmarkReports = {};
  const manifests = {};

  for (const segmentCount of [20, 30]) {
    const key = String(segmentCount);
    const expected = FIXTURE_EXPECTATIONS[segmentCount];
    const benchmarkRead = await readJsonOrError(path.join(resolvedEvidenceRoot, `benchmark-${key}.json`));
    checks.push(presenceCheck(`benchmark-${key}.readable`, benchmarkRead.error));
    const report = benchmarkRead.value || {};
    benchmarkReports[key] = report;
    checks.push(...buildBenchmarkIdentityChecks(report, {
      taskCommit,
      baselineCommit: EXPECTED_BASELINE_COMMIT,
      fixtureHash: expected.fixtureHash,
      adapterVersion: EXPECTED_ADAPTER_VERSION,
      productionSourceFingerprint: EXPECTED_PRODUCTION_FINGERPRINT,
    }, `benchmark-${key}`));
    checks.push(
      exactCheck(`benchmark-${key}.fixtureId`, expected.fixtureId, report.fixtureId),
      minimumCheck(`benchmark-${key}.iterations`, report.iterations, 400),
      exactCheck(`benchmark-${key}.accepted`, segmentCount, report.quality?.accepted),
      exactCheck(`benchmark-${key}.blocked`, 0, report.quality?.blocked),
      exactCheck(`benchmark-${key}.needsReview`, 0, report.quality?.needsReview),
      minimumCheck(`benchmark-${key}.minimumPromptLength`, report.quality?.promptLengths?.min, 900),
      exactCheck(
        `benchmark-${key}.localPatchOperations`,
        expected.localPatchOperations,
        report.extensions?.localPatchOperations,
      ),
      exactCheck(`benchmark-${key}.warningFindings`, expected.warning, report.extensions?.findingCounts?.warning),
      exactCheck(`benchmark-${key}.riskFindings`, expected.risk, report.extensions?.findingCounts?.risk),
      exactCheck(`benchmark-${key}.blockingFindings`, 0, report.extensions?.findingCounts?.blocking),
      exactCheck(`benchmark-${key}.patchableFindings`, 0, report.extensions?.findingCounts?.patchable),
      upperBoundCheck(
        `benchmark-${key}.fullPipelineCoefficientOfVariation`,
        report.timingsMs?.full_local_pipeline_total?.coefficientOfVariation,
        0.15,
        true,
      ),
      upperBoundCheck(
        `benchmark-${key}.p50Ratio`,
        report.comparison?.full_local_pipeline_total?.p50Ratio,
        1.05,
      ),
      upperBoundCheck(
        `benchmark-${key}.p95Ratio`,
        report.comparison?.full_local_pipeline_total?.p95Ratio,
        1.05,
      ),
    );
    for (const kind of MODEL_KINDS) {
      checks.push(exactCheck(
        `benchmark-${key}.modelExecuting.${kind}`,
        0,
        report.invocationCounters?.[kind]?.executing,
      ));
    }

    const fixtureModule = await import(pathToFileURL(path.join(
      taskRoot,
      "test",
      "fixtures",
      "batch-generation",
      `batch-generation-${key}-segment.mjs`,
    )).href);
    const manifest = fixtureModule.FIXTURE_MANIFEST;
    manifests[key] = manifest;
    await writeJsonEvidence(path.join(resolvedEvidenceRoot, `fixture-manifest-${key}.json`), manifest);
    checks.push(
      exactCheck(`fixture-manifest-${key}.schemaVersion`, 3, manifest.fixtureSchemaVersion),
      exactCheck(`fixture-manifest-${key}.fixtureHash`, expected.fixtureHash, fixtureModule.computeFixtureHash(fixtureModule.default)),
      exactCheck(`fixture-manifest-${key}.accepted`, segmentCount, manifest.liveFullPipelineWorkload?.acceptedSegments),
      exactCheck(`fixture-manifest-${key}.blocked`, 0, manifest.liveFullPipelineWorkload?.blockedSegments),
      exactCheck(`fixture-manifest-${key}.needsReview`, 0, manifest.liveFullPipelineWorkload?.needsReviewSegments),
      exactCheck(`fixture-manifest-${key}.localPatchOperations`, expected.localPatchOperations, manifest.liveFullPipelineWorkload?.localPatchSummary?.total),
      exactCheck(`fixture-manifest-${key}.warningFindings`, expected.warning, manifest.liveFullPipelineWorkload?.findingSummary?.warning?.total),
      exactCheck(`fixture-manifest-${key}.riskFindings`, expected.risk, manifest.liveFullPipelineWorkload?.findingSummary?.risk?.total),
      exactCheck(`fixture-manifest-${key}.shapeAcceptance`, true, manifest.shapeAcceptance?.passed),
    );
    for (const kind of MODEL_KINDS) {
      checks.push(exactCheck(
        `fixture-manifest-${key}.modelExecuting.${kind}`,
        0,
        manifest.liveFullPipelineWorkload?.modelExecutingCounts?.[kind],
      ));
    }
  }

  const analyzerReports = [];
  for (const run of [1, 2]) {
    const analyzerRead = await readJsonOrError(path.join(resolvedEvidenceRoot, `artifact-analysis-${run}.json`));
    checks.push(presenceCheck(`artifact-analysis-${run}.readable`, analyzerRead.error));
    const report = analyzerRead.value || {};
    analyzerReports.push(report);
    const triState = summarizeAnalyzerTriState(report);
    checks.push(
      exactCheck(`artifact-analysis-${run}.triStateConservation`, true, triState.conservation),
      exactCheck(`artifact-analysis-${run}.unknownReasonConservation`, true, triState.unknownReasonConservation),
    );
  }
  const analyzerHashes = analyzerReports.map(stableAnalyzerHash);
  checks.push(exactCheck("artifact-analysis.doubleRunStable", analyzerHashes[0], analyzerHashes[1]));

  const acceptanceBase = evaluateRequiredChecks(checks);
  const analyzerSummary = analyzerReports.map((report, index) => ({
    run: index + 1,
    ...summarizeAnalyzerTriState(report),
    stableHash: analyzerHashes[index],
  }));
  const benchmarkSummary = Object.fromEntries([20, 30].map((segmentCount) => {
    const report = benchmarkReports[String(segmentCount)];
    const timing = report.timingsMs?.full_local_pipeline_total || {};
    const comparison = report.comparison?.full_local_pipeline_total || {};
    return [String(segmentCount), {
      p50: timing.p50 ?? null,
      p95: timing.p95 ?? null,
      coefficientOfVariation: timing.coefficientOfVariation ?? null,
      p50Ratio: comparison.p50Ratio ?? null,
      p95Ratio: comparison.p95Ratio ?? null,
      invocationCounters: report.invocationCounters || {},
    }];
  }));
  const manifestSummary = Object.fromEntries([20, 30].map((segmentCount) => {
    const manifest = manifests[String(segmentCount)];
    return [String(segmentCount), {
      observed: manifest.observedShapeProfile.findingSummary,
      live: manifest.liveFullPipelineWorkload.findingSummary,
      localPatchSummary: manifest.liveFullPipelineWorkload.localPatchSummary,
      observedVsLiveDeltas: manifest.observedVsLiveDeltas,
    }];
  }));
  const finalVerification = {
    schemaVersion: 1,
    status: acceptanceBase.status,
    taskCommit,
    baselineCommit: actualBaselineCommit,
    expectedBaselineCommit: EXPECTED_BASELINE_COMMIT,
    adapterVersion: EXPECTED_ADAPTER_VERSION,
    productionSourceFingerprint: EXPECTED_PRODUCTION_FINGERPRINT,
    benchmarkSummary,
    manifestSummary,
    artifactAnalyzer: analyzerSummary,
    externalVerificationSummary: externalValidation.summary,
    checks: acceptanceBase.checks,
  };
  const acceptance = {
    schemaVersion: 1,
    ...acceptanceBase,
    taskCommit,
    baselineCommit: actualBaselineCommit,
    evidenceRoot: resolvedEvidenceRoot,
    benchmarkSummary,
    fixtureManifestStatus: Object.fromEntries(
      Object.entries(manifests).map(([key, manifest]) => [key, manifest.shapeAcceptance.passed]),
    ),
    artifactAnalyzer: analyzerSummary,
    externalVerificationSummary: externalValidation.summary,
  };
  await writeJsonEvidence(path.join(resolvedEvidenceRoot, "final-verification.json"), finalVerification);
  await writeJsonEvidence(path.join(resolvedEvidenceRoot, "acceptance.json"), acceptance);
  return acceptance;
}

function summarizeAnalyzerTriState(report) {
  const summary = report.completedResultReferenceSummary || {};
  const referenced = Number(summary.referenced || 0);
  const orphan = Number(summary.orphan || 0);
  const unknown = Number(summary.unknown || 0);
  const classified = referenced + orphan + unknown;
  const completed = Array.isArray(report.matchingCompletedResults)
    ? report.matchingCompletedResults.length
    : 0;
  const unknownReasons = report.unknownCompletedResultReasonCounts || {};
  const unknownReasonTotal = Object.values(unknownReasons)
    .reduce((total, value) => total + Number(value || 0), 0);
  return {
    referenced,
    orphan,
    unknown,
    completed,
    classified,
    conservation: classified === completed,
    unknownReasons,
    unknownReasonTotal,
    unknownReasonConservation: unknownReasonTotal === unknown,
  };
}

function stableAnalyzerHash(report) {
  const stable = structuredClone(report || {});
  delete stable.generatedAt;
  return createHash("sha256").update(JSON.stringify(sortValue(stable)), "utf8").digest("hex");
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort((left, right) => left.localeCompare(right))
      .map((key) => [key, sortValue(value[key])]),
  );
}

function exactCheck(id, expected, actual, required = true) {
  return { id, required, expected, actual, passed: Object.is(actual, expected) };
}

function minimumCheck(id, actual, minimum, required = true) {
  return {
    id,
    required,
    minimum,
    actual,
    passed: Number.isFinite(actual) && actual >= minimum,
  };
}

function upperBoundCheck(id, actual, maximum, exclusive = false, required = true) {
  return {
    id,
    required,
    maximum,
    exclusive,
    actual,
    passed: Number.isFinite(actual) && (exclusive ? actual < maximum : actual <= maximum),
  };
}

function presenceCheck(id, error) {
  return { id, required: true, error: error || null, passed: !error };
}

async function readJsonOrError(target) {
  try {
    return { value: JSON.parse(await readFile(target, "utf8")), error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function gitValue(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function parseArguments(argv) {
  const values = Object.fromEntries(argv.map((argument) => {
    const match = argument.match(/^--([^=]+)=(.*)$/);
    if (!match) throw new Error(`Unsupported argument: ${argument}`);
    return [match[1], match[2]];
  }));
  if (!values["evidence-root"]) throw new Error("Missing --evidence-root=<path>");
  if (!values["baseline-root"]) throw new Error("Missing --baseline-root=<path>");
  return {
    evidenceRoot: values["evidence-root"],
    baselineRoot: values["baseline-root"],
  };
}

const isCli = path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url));
if (isCli) {
  try {
    const acceptance = await finalizePhaseZeroEvidence(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({
      status: acceptance.status,
      failedRequiredCheckIds: acceptance.failedRequiredCheckIds,
    }, null, 2)}\n`);
    if (acceptance.status !== "accepted") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
