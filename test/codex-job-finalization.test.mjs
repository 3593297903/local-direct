import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({
  module: "commonjs",
  moduleResolution: "node",
});
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");
const {
  CodexJobFinalizationError,
  createJobStagingDirectory,
  publishFinalizedJob,
  readAndValidateFinalManifest,
  writeFinalManifest,
} = require("../lib/codex-job-finalization.ts");

function makeTempRoot() {
  return path.join(os.tmpdir(), `localdirector-finalization-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function makeStaging(rootDir, overrides = {}) {
  const identity = {
    rootDir,
    namespace: ".tmp-finalization-test",
    jobId: "job-001",
    taskClass: "render_pack",
    leaseId: "11111111-1111-4111-8111-111111111111",
    fencingToken: 3,
    sourceHash: sha256("source"),
    contractHash: sha256("contract"),
    segmentIndexes: [1],
    resultHash: sha256("canonical-result"),
    ...overrides,
  };
  const stagingDir = await createJobStagingDirectory(identity);
  writeFileSync(path.join(stagingDir, "episode-001.json"), JSON.stringify({ title: "第一段" }), "utf8");
  return { identity, stagingDir };
}

test("final manifest rejects output paths that escape the staging directory", async () => {
  const rootDir = makeTempRoot();
  try {
    const { identity, stagingDir } = await makeStaging(rootDir);
    await assert.rejects(
      () => writeFinalManifest({
        ...identity,
        stagingDir,
        codexExitCode: 0,
        outputFiles: [{ relativePath: "../outside.json", kind: "render_result" }],
      }),
      (error) => error instanceof CodexJobFinalizationError && error.code === "FINALIZATION_SCHEMA_INVALID",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("final manifest detects output tampering through byte length and sha256", async () => {
  const rootDir = makeTempRoot();
  try {
    const { identity, stagingDir } = await makeStaging(rootDir);
    await writeFinalManifest({
      ...identity,
      stagingDir,
      codexExitCode: 0,
      outputFiles: [{ relativePath: "episode-001.json", kind: "render_result" }],
    });
    writeFileSync(path.join(stagingDir, "episode-001.json"), JSON.stringify({ title: "被篡改" }), "utf8");

    await assert.rejects(
      () => readAndValidateFinalManifest({ directory: stagingDir, expected: identity }),
      (error) => error instanceof CodexJobFinalizationError && error.code === "FINALIZATION_HASH_MISMATCH",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("final manifest rejects a stale lease or fencing token", async () => {
  const rootDir = makeTempRoot();
  try {
    const { identity, stagingDir } = await makeStaging(rootDir);
    await writeFinalManifest({
      ...identity,
      stagingDir,
      codexExitCode: 0,
      outputFiles: [{ relativePath: "episode-001.json", kind: "render_result" }],
    });

    await assert.rejects(
      () => readAndValidateFinalManifest({
        directory: stagingDir,
        expected: { ...identity, fencingToken: identity.fencingToken + 1 },
      }),
      (error) => error instanceof CodexJobFinalizationError && error.code === "FINALIZATION_STALE_FENCE",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("atomic publication retries transient Windows rename failures and exposes one immutable result", async () => {
  const rootDir = makeTempRoot();
  try {
    const { identity, stagingDir } = await makeStaging(rootDir);
    await writeFinalManifest({
      ...identity,
      stagingDir,
      codexExitCode: 0,
      outputFiles: [{ relativePath: "episode-001.json", kind: "render_result" }],
    });

    let attempts = 0;
    const resultRef = await publishFinalizedJob({
      ...identity,
      stagingDir,
      retryDelaysMs: [0, 0, 0],
      renameImpl: async (source, destination) => {
        attempts += 1;
        if (attempts < 3) {
          const error = new Error("busy");
          error.code = "EPERM";
          throw error;
        }
        const { rename } = await import("node:fs/promises");
        await rename(source, destination);
      },
    });

    assert.equal(attempts, 3);
    assert.equal(resultRef.resultHash, identity.resultHash);
    assert.match(resultRef.relativePath, /results\/job-001\/[a-f0-9]{64}$/);
    const publishedDir = path.join(rootDir, identity.namespace, ...resultRef.relativePath.split("/"));
    assert.equal(JSON.parse(readFileSync(path.join(publishedDir, "episode-001.json"), "utf8")).title, "第一段");
    const validated = await readAndValidateFinalManifest({ directory: publishedDir, expected: identity });
    assert.equal(validated.resultHash, identity.resultHash);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
