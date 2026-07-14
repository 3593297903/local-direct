import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  finalizePhaseZeroEvidence,
  writeJsonEvidence,
} from "./finalize-task-one-phase-0r.mjs";

const TASK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_DIFF_BASE = "11092635551e4e667cc135322cbb536d6b58fe20";
const EXPECTED_BASELINE_COMMIT = "697e2c9aa77d009b2ac5b0f240e0ffa49292e005";
const ALLOWED_POSTGRES_SKIP =
  "twenty concurrent PostgreSQL saves create one version and replay the same ids";
const GENERATED_EVIDENCE_FILES = [
  "acceptance.json",
  "artifact-analysis-1.json",
  "artifact-analysis-2.json",
  "benchmark-20.json",
  "benchmark-30.json",
  "external-verification.json",
  "final-verification.json",
  "fixture-manifest-20.json",
  "fixture-manifest-30.json",
  "green-tests.txt",
];

export async function runPhaseZeroVerification({ evidenceRoot, baselineRoot }) {
  const resolvedEvidenceRoot = path.resolve(evidenceRoot);
  const resolvedBaselineRoot = path.resolve(baselineRoot);
  const logsRoot = path.join(resolvedEvidenceRoot, "logs");
  await mkdir(resolvedEvidenceRoot, { recursive: true });
  await rm(logsRoot, { recursive: true, force: true });
  await mkdir(logsRoot, { recursive: true });
  for (const file of GENERATED_EVIDENCE_FILES) {
    await rm(path.join(resolvedEvidenceRoot, file), { force: true });
  }

  const taskCommit = readGitValue(TASK_ROOT, ["rev-parse", "HEAD"]);
  const baselineCommit = readGitValue(resolvedBaselineRoot, ["rev-parse", "HEAD"]);
  const npmCli = resolveNpmCli();
  const commands = createCommandPlan({
    evidenceRoot: resolvedEvidenceRoot,
    baselineRoot: resolvedBaselineRoot,
    npmCli,
  });
  const records = [];
  for (const command of commands) {
    const record = await executeVerificationCommand(command, {
      evidenceRoot: resolvedEvidenceRoot,
      baselineRoot: resolvedBaselineRoot,
    });
    records.push(record);
    process.stdout.write(`${record.commandId}: ${record.passed ? "passed" : "failed"} (${record.exitCode})\n`);
    if (record.commandId === "focused-tests") {
      const focusedLog = await readFile(path.join(resolvedEvidenceRoot, record.logPath));
      await writeUtf8WithoutBom(path.join(resolvedEvidenceRoot, "green-tests.txt"), focusedLog);
    }
  }

  const externalVerification = {
    schemaVersion: 1,
    runnerVersion: "phase-0r-full-verification-v1",
    taskCommit,
    baselineCommit,
    expectedBaselineCommit: EXPECTED_BASELINE_COMMIT,
    commands: records,
  };
  await writeJsonEvidence(
    path.join(resolvedEvidenceRoot, "external-verification.json"),
    externalVerification,
  );
  const acceptance = await finalizePhaseZeroEvidence({
    evidenceRoot: resolvedEvidenceRoot,
    baselineRoot: resolvedBaselineRoot,
    taskRoot: TASK_ROOT,
  });
  return { acceptance, externalVerification };
}

function createCommandPlan({ evidenceRoot, baselineRoot, npmCli }) {
  const node = process.execPath;
  const git = "git";
  const npmRun = (commandId, script) => ({
    commandId,
    executable: node,
    args: [npmCli, "run", script],
  });
  return [
    {
      commandId: "focused-tests",
      executable: node,
      args: [
        "--test",
        "test/batch-generation-invocation-ledger.test.mjs",
        "test/batch-generation-regression.test.mjs",
      ],
    },
    {
      commandId: "benchmark-20",
      executable: node,
      args: [
        "scripts/benchmark-batch-generation-pipeline.mjs",
        "--fixture=20",
        "--iterations=400",
        `--baseline-root=${baselineRoot}`,
        `--output=${path.join(evidenceRoot, "benchmark-20.json")}`,
      ],
    },
    {
      commandId: "benchmark-30",
      executable: node,
      args: [
        "scripts/benchmark-batch-generation-pipeline.mjs",
        "--fixture=30",
        "--iterations=400",
        `--baseline-root=${baselineRoot}`,
        `--output=${path.join(evidenceRoot, "benchmark-30.json")}`,
      ],
    },
    {
      commandId: "artifact-analysis-1",
      executable: node,
      args: [
        "scripts/analyze-batch-job-artifacts.mjs",
        `--root=${baselineRoot}`,
        `--output=${path.join(evidenceRoot, "artifact-analysis-1.json")}`,
      ],
    },
    {
      commandId: "artifact-analysis-2",
      executable: node,
      args: [
        "scripts/analyze-batch-job-artifacts.mjs",
        `--root=${baselineRoot}`,
        `--output=${path.join(evidenceRoot, "artifact-analysis-2.json")}`,
      ],
    },
    npmRun("typecheck", "typecheck"),
    npmRun("api-typecheck", "api:typecheck"),
    npmRun("full-tests", "test"),
    npmRun("api-build", "api:build"),
    npmRun("frontend-build", "build"),
    {
      commandId: "privacy-safe",
      executable: node,
      args: [
        "--test",
        "--test-name-pattern=representative fixtures remain synthetic and privacy-safe",
        "test/batch-generation-regression.test.mjs",
      ],
    },
    {
      commandId: "git-diff-check",
      executable: git,
      args: ["diff", "--check", `${EXPECTED_DIFF_BASE}..HEAD`],
    },
    {
      commandId: "git-status-clean",
      executable: git,
      args: ["status", "--short"],
    },
    {
      commandId: "git-ancestor",
      executable: git,
      args: ["merge-base", "--is-ancestor", EXPECTED_BASELINE_COMMIT, "HEAD"],
    },
    {
      commandId: "git-merge-tree",
      executable: git,
      args: ["merge-tree", "--write-tree", "agent/batch-pipeline-stability", "HEAD"],
    },
  ];
}

async function executeVerificationCommand(command, { evidenceRoot, baselineRoot }) {
  const result = spawnSync(command.executable, command.args, {
    cwd: TASK_ROOT,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  const exitCode = Number.isInteger(result.status) ? result.status : -1;
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const processError = result.error instanceof Error ? result.error.message : "";
  const summary = summarizeCommand(command.commandId, { stdout, stderr, exitCode });
  const passed = exitCode === 0 && summary.semanticPassed === true;
  const logPath = `logs/${String(recordsIndex(command.commandId)).padStart(2, "0")}-${command.commandId}.log`;
  const logBody = sanitizeLogText([
    `commandId: ${command.commandId}`,
    `argv: ${JSON.stringify([command.executable, ...command.args])}`,
    `exitCode: ${exitCode}`,
    processError ? `processError: ${processError}` : "",
    "stdout:",
    stdout,
    "stderr:",
    stderr,
  ].filter(Boolean).join("\n"), { evidenceRoot, baselineRoot });
  const logBytes = Buffer.from(`${logBody.trimEnd()}\n`, "utf8");
  await writeUtf8WithoutBom(path.join(evidenceRoot, logPath), logBytes);
  return {
    commandId: command.commandId,
    argv: [command.executable, ...command.args],
    exitCode,
    passed,
    logPath,
    logSha256: createHash("sha256").update(logBytes).digest("hex"),
    summary: stripSemanticMarker(summary),
  };
}

function summarizeCommand(commandId, { stdout, stderr, exitCode }) {
  const combined = `${stdout}\n${stderr}`;
  if (commandId === "focused-tests") {
    const testSummary = parseNodeTestSummary(combined);
    return {
      semanticPassed: testSummary.fail === 0 && testSummary.skipped === 0 && testSummary.pass > 0,
      testSummary,
    };
  }
  if (commandId === "full-tests") {
    const testSummary = parseNodeTestSummary(combined);
    return {
      semanticPassed: isAllowedFullTestSummary(testSummary),
      testSummary,
    };
  }
  if (commandId === "privacy-safe") {
    const testSummary = parseNodeTestSummary(combined);
    const privacySafe = exitCode === 0
      && testSummary.fail === 0
      && testSummary.pass > 0
      && /[✔✓]\s+representative fixtures remain synthetic and privacy-safe/u.test(combined);
    return { semanticPassed: privacySafe, privacySafe, testSummary };
  }
  if (commandId === "git-diff-check" || commandId === "git-status-clean") {
    const clean = exitCode === 0 && stdout.trim() === "" && stderr.trim() === "";
    return { semanticPassed: clean, clean };
  }
  if (commandId === "git-ancestor") {
    const isAncestor = exitCode === 0;
    return { semanticPassed: isAncestor, isAncestor };
  }
  if (commandId === "git-merge-tree") {
    const treeHash = stdout.split(/\r?\n/).map((line) => line.trim())
      .find((line) => /^[a-f0-9]{40}$/i.test(line)) || null;
    return { semanticPassed: exitCode === 0 && Boolean(treeHash), treeHash };
  }
  return { semanticPassed: exitCode === 0 };
}

function parseNodeTestSummary(output) {
  const metric = (label) => {
    const matches = [...output.matchAll(new RegExp(`(?:^|\\n)[^\\n]*\\b${label}\\s+(\\d+)`, "g"))];
    return matches.length ? Number(matches.at(-1)[1]) : -1;
  };
  const skippedTests = output.split(/\r?\n/)
    .filter((line) => /# SKIP\s*$/u.test(line))
    .map((line) => line.replace(/\s+# SKIP\s*$/u, "")
      .replace(/^[^\p{L}\p{N}]+/u, "")
      .replace(/\s+\([^()]*ms\)\s*$/u, "")
      .trim());
  return {
    tests: metric("tests"),
    pass: metric("pass"),
    fail: metric("fail"),
    skipped: metric("skipped"),
    skippedTests,
  };
}

function isAllowedFullTestSummary(summary) {
  if (summary.tests <= 0 || summary.pass <= 0 || summary.fail !== 0) return false;
  if (summary.tests !== summary.pass + summary.fail + summary.skipped) return false;
  if (summary.skipped === 0) return summary.skippedTests.length === 0;
  return summary.skipped === 1
    && summary.skippedTests.length === 1
    && summary.skippedTests[0] === ALLOWED_POSTGRES_SKIP;
}

function stripSemanticMarker(summary) {
  const { semanticPassed: _semanticPassed, ...safeSummary } = summary;
  return safeSummary;
}

function sanitizeLogText(value, { evidenceRoot, baselineRoot }) {
  const replacements = [
    [TASK_ROOT, "<TASK_ROOT>"],
    [evidenceRoot, "<EVIDENCE_ROOT>"],
    [baselineRoot, "<BASELINE_ROOT>"],
  ];
  return String(value).split(/\r?\n/).map((line) => {
    if (/(?:OPENAI_API_KEY|DATABASE_URL|REDIS_URL|ADMIN_PASSWORD|AUTH_SECRET|API_TOKEN)\s*[:=]/i.test(line)) {
      return "[REDACTED_ENVIRONMENT_VALUE]";
    }
    if (/["']?(?:fullVideoPrompt|sourceText|promptText|optimizedScript)["']?\s*:/i.test(line)
      || /Season pack task prompt|完整原文|用户输入正文/i.test(line)) {
      return "[REDACTED_PROMPT_CONTENT]";
    }
    return replacements.reduce(
      (current, [source, replacement]) => replaceAllInsensitive(current, source, replacement),
      line,
    );
  }).join("\n");
}

function replaceAllInsensitive(value, search, replacement) {
  if (!search) return value;
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value.replace(new RegExp(escaped, "gi"), replacement);
}

async function writeUtf8WithoutBom(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  const withoutBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    ? bytes.subarray(3)
    : bytes;
  await writeFile(target, withoutBom);
  const written = await readFile(target);
  if (written[0] === 0xef && written[1] === 0xbb && written[2] === 0xbf) {
    throw new Error(`UTF-8 BOM detected in verification evidence: ${target}`);
  }
}

function recordsIndex(commandId) {
  const ids = [
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
  ];
  return ids.indexOf(commandId) + 1;
}

function readGitValue(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function resolveNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);
  const located = spawnSync("where.exe", ["npm.cmd"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (located.status === 0) {
    for (const commandPath of located.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
      candidates.push(path.join(path.dirname(commandPath), "node_modules", "npm", "bin", "npm-cli.js"));
    }
  }
  const npmCli = candidates.find((candidate) => existsSync(candidate));
  if (!npmCli) throw new Error("Unable to locate npm-cli.js without invoking a shell");
  return npmCli;
}

function parseArguments(argv) {
  const values = Object.fromEntries(argv.map((argument) => {
    const match = argument.match(/^--([^=]+)=(.*)$/);
    if (!match) throw new Error(`Unsupported argument: ${argument}`);
    return [match[1], match[2]];
  }));
  if (!values["evidence-root"]) throw new Error("Missing --evidence-root=<path>");
  if (!values["baseline-root"]) throw new Error("Missing --baseline-root=<path>");
  return { evidenceRoot: values["evidence-root"], baselineRoot: values["baseline-root"] };
}

const isCli = path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url));
if (isCli) {
  try {
    const result = await runPhaseZeroVerification(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({
      status: result.acceptance.status,
      failedRequiredCheckIds: result.acceptance.failedRequiredCheckIds,
    }, null, 2)}\n`);
    if (result.acceptance.status !== "accepted") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
