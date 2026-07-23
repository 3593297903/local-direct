import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS ||= JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");
const { readCodexRuntimeHealthForOwner } = require("../lib/codex-runtime-health.ts");

const runtimeModule = await import("../scripts/codex-runtime-health.mjs");
const {
  validateCodexRuntime,
  writeCodexRuntimeEnvironmentHealth,
  writeCodexWorkerHeartbeat,
  readCodexRuntimeHealth,
} = runtimeModule;

test("Codex runtime validation rejects invalid YAML, oversized descriptions, and missing frontmatter", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "localdirector-runtime-invalid-"));
  try {
    const skills = path.join(root, "skills");
    await mkdir(path.join(skills, "yaml-bad"), { recursive: true });
    await mkdir(path.join(skills, "too-long"), { recursive: true });
    await mkdir(path.join(skills, "no-frontmatter"), { recursive: true });
    await writeFile(
      path.join(skills, "yaml-bad", "SKILL.md"),
      "---\nname: yaml-bad\ndescription: invalid value: mapping\n---\n# Bad\n",
      "utf8",
    );
    await writeFile(
      path.join(skills, "too-long", "SKILL.md"),
      `---\nname: too-long\ndescription: "${"x".repeat(1025)}"\n---\n# Long\n`,
      "utf8",
    );
    await writeFile(path.join(skills, "no-frontmatter", "SKILL.md"), "# Missing\n", "utf8");

    const result = await validateCodexRuntime({
      skillRoots: [skills],
      codexVersion: "codex-cli-test",
      configRoot: root,
      checkedAt: "2026-07-10T00:00:00.000Z",
    });

    assert.equal(result.status, "invalid");
    assert.deepEqual(
      new Set(result.errors.map((item) => item.code)),
      new Set(["INVALID_YAML", "DESCRIPTION_TOO_LONG", "MISSING_FRONTMATTER"]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex runtime environment is published once and worker heartbeats never rewrite it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "localdirector-runtime-valid-"));
  try {
    const skills = path.join(root, "skills");
    const skillDir = path.join(skills, "valid-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: valid-skill\ndescription: A valid test skill.\n---\n# Valid\n",
      "utf8",
    );

    const health = await validateCodexRuntime({
      skillRoots: [skills],
      codexVersion: "codex-cli-test",
      configRoot: root,
      checkedAt: "2026-07-10T01:00:00.000Z",
    });
    assert.equal(health.status, "healthy");
    assert.equal(health.errors.length, 0);
    assert.ok(health.runtimeFingerprint);

    await writeCodexRuntimeEnvironmentHealth({ rootDir: root, health });
    await Promise.all([
      writeCodexWorkerHeartbeat({
        rootDir: root,
        workerName: "season-pack",
        health: { ...health, checkedAt: "2026-07-10T01:00:01.000Z" },
        heartbeatAt: "2026-07-10T01:00:05.000Z",
      }),
      writeCodexWorkerHeartbeat({
        rootDir: root,
        workerName: "video-prompt-pack",
        health: { ...health, checkedAt: "2026-07-10T01:00:02.000Z" },
        heartbeatAt: "2026-07-10T01:00:06.000Z",
      }),
    ]);
    const published = await readCodexRuntimeHealth({ rootDir: root, workerName: "season-pack" });
    const secondWorker = await readCodexRuntimeHealth({ rootDir: root, workerName: "video-prompt-pack" });
    const environmentFile = JSON.parse(await readFile(
      path.join(root, ".tmp-codex-runtime", "environment.json"),
      "utf8",
    ));
    assert.equal(environmentFile.checkedAt, "2026-07-10T01:00:00.000Z");
    assert.equal(published.worker?.workerName, "season-pack");
    assert.equal(published.worker?.heartbeatAt, "2026-07-10T01:00:05.000Z");
    assert.equal(secondWorker.worker?.workerName, "video-prompt-pack");
    assert.equal(secondWorker.worker?.heartbeatAt, "2026-07-10T01:00:06.000Z");

    const workerFiles = await readdir(path.join(root, ".tmp-codex-runtime", "workers"));
    assert.ok(workerFiles.some((name) => /^season-pack\.\d+\.json$/.test(name)));
    assert.ok(workerFiles.some((name) => /^video-prompt-pack\.\d+\.json$/.test(name)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex runtime reader selects the freshest heartbeat for duplicate worker instances", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "localdirector-runtime-workers-"));
  try {
    const runtimeRoot = path.join(root, ".tmp-codex-runtime");
    const workerRoot = path.join(runtimeRoot, "workers");
    await mkdir(workerRoot, { recursive: true });
    const health = {
      schemaVersion: 1,
      status: "healthy",
      checkedAt: "2026-07-10T01:00:00.000Z",
      codexVersion: "codex-cli-test",
      configRoot: root,
      skillRoots: [],
      skillCount: 0,
      runtimeFingerprint: "fingerprint-1",
      errors: [],
    };
    await writeCodexRuntimeEnvironmentHealth({ rootDir: root, health });
    await writeFile(path.join(workerRoot, "season-pack.111.json"), JSON.stringify({
      schemaVersion: 1,
      workerName: "season-pack",
      pid: 111,
      heartbeatAt: "2026-07-10T01:00:05.000Z",
      runtimeFingerprint: "fingerprint-1",
      status: "healthy",
      environment: health,
    }), "utf8");
    await writeFile(path.join(workerRoot, "season-pack.222.json"), JSON.stringify({
      schemaVersion: 1,
      workerName: "season-pack",
      pid: 222,
      heartbeatAt: "2026-07-10T01:00:08.000Z",
      runtimeFingerprint: "fingerprint-1",
      status: "healthy",
      environment: health,
    }), "utf8");

    const published = await readCodexRuntimeHealth({ rootDir: root, workerName: "season-pack" });
    assert.equal(published.worker?.pid, 222);
    assert.equal(published.worker?.heartbeatAt, "2026-07-10T01:00:08.000Z");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex runtime reader can target the exact worker instance across PID reuse", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "localdirector-runtime-owner-"));
  try {
    const runtimeRoot = path.join(root, ".tmp-codex-runtime");
    const workerRoot = path.join(runtimeRoot, "workers");
    await mkdir(workerRoot, { recursive: true });
    const health = {
      schemaVersion: 1,
      status: "healthy",
      checkedAt: "2026-07-10T01:00:00.000Z",
      codexVersion: "codex-cli-test",
      configRoot: root,
      skillRoots: [],
      skillCount: 0,
      runtimeFingerprint: "fingerprint-owner",
      errors: [],
    };
    await writeCodexRuntimeEnvironmentHealth({ rootDir: root, health });
    await writeFile(path.join(workerRoot, "season-pack.new-instance.json"), JSON.stringify({
      schemaVersion: 1,
      workerName: "season-pack",
      workerInstanceId: "season-pack-new-instance",
      pid: 777,
      heartbeatAt: new Date().toISOString(),
      runtimeFingerprint: "fingerprint-owner",
      status: "healthy",
      environment: health,
    }), "utf8");

    const current = await readCodexRuntimeHealth({
      rootDir: root,
      workerName: "season-pack",
      workerInstanceId: "season-pack-new-instance",
    });
    const replaced = await readCodexRuntimeHealth({
      rootDir: root,
      workerName: "season-pack",
      workerInstanceId: "season-pack-old-instance",
    });
    assert.equal(current.worker?.workerInstanceId, "season-pack-new-instance");
    assert.equal(replaced.worker, null, "a reused PID must not make a different worker instance healthy");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy owner health matches exact PID heartbeats without weakening UUID ownership", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "localdirector-runtime-legacy-owner-"));
  try {
    const runtimeRoot = path.join(root, ".tmp-codex-runtime");
    const workerRoot = path.join(runtimeRoot, "workers");
    await mkdir(workerRoot, { recursive: true });
    const now = Date.parse("2026-07-15T01:00:30.000Z");
    const environment = {
      schemaVersion: 1,
      status: "healthy",
      checkedAt: "2026-07-15T01:00:00.000Z",
      codexVersion: "codex-cli-test",
      runtimeFingerprint: "legacy-owner-fingerprint",
      errors: [],
    };
    await writeFile(path.join(runtimeRoot, "environment.json"), JSON.stringify(environment), "utf8");
    const writeHeartbeat = (fileName, value) => writeFile(
      path.join(workerRoot, fileName),
      JSON.stringify({
        schemaVersion: 1,
        heartbeatAt: "2026-07-15T01:00:20.000Z",
        runtimeFingerprint: environment.runtimeFingerprint,
        status: "healthy",
        environment,
        ...value,
      }),
      "utf8",
    );
    await Promise.all([
      writeHeartbeat("season-pack.700.json", { workerName: "season-pack", pid: 700 }),
      writeHeartbeat("video-prompt-pack.800.json", { workerName: "video-prompt-pack", pid: 800 }),
      writeHeartbeat("season-pack.uuid.json", {
        workerName: "season-pack",
        workerInstanceId: "61eb697b-d823-43e2-9f57-87ee249a22cc",
        pid: 700,
      }),
    ]);

    const seasonLegacy = await readCodexRuntimeHealthForOwner("season-pack", "season-pack-700", {
      rootDir: root,
      now,
      maxAgeMs: 60_000,
    });
    const renderLegacy = await readCodexRuntimeHealthForOwner("video-prompt-pack", "video-prompt-pack-800", {
      rootDir: root,
      now,
      maxAgeMs: 60_000,
    });
    const wrongPid = await readCodexRuntimeHealthForOwner("season-pack", "season-pack-701", {
      rootDir: root,
      now,
      maxAgeMs: 60_000,
    });
    const exactUuid = await readCodexRuntimeHealthForOwner(
      "season-pack",
      "61eb697b-d823-43e2-9f57-87ee249a22cc",
      { rootDir: root, now, maxAgeMs: 60_000 },
    );

    assert.equal(seasonLegacy.status, "healthy");
    assert.equal(seasonLegacy.matchKind, "legacy_pid");
    assert.equal(seasonLegacy.worker?.pid, 700);
    assert.equal(renderLegacy.status, "healthy");
    assert.equal(renderLegacy.matchKind, "legacy_pid");
    assert.equal(renderLegacy.worker?.pid, 800);
    assert.equal(wrongPid.status, "missing");
    assert.equal(wrongPid.matchKind, "none");
    assert.equal(exactUuid.status, "healthy");
    assert.equal(exactUuid.matchKind, "worker_instance");
    assert.equal(exactUuid.worker?.workerInstanceId, "61eb697b-d823-43e2-9f57-87ee249a22cc");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy owner health distinguishes stale exact owners from unverifiable custom owners", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "localdirector-runtime-legacy-stale-"));
  try {
    const runtimeRoot = path.join(root, ".tmp-codex-runtime");
    const workerRoot = path.join(runtimeRoot, "workers");
    await mkdir(workerRoot, { recursive: true });
    const environment = {
      schemaVersion: 1,
      status: "healthy",
      checkedAt: "2026-07-15T01:00:00.000Z",
      codexVersion: "codex-cli-test",
      runtimeFingerprint: "legacy-stale-fingerprint",
      errors: [],
    };
    await writeFile(path.join(runtimeRoot, "environment.json"), JSON.stringify(environment), "utf8");
    await writeFile(path.join(workerRoot, "season-pack.700.json"), JSON.stringify({
      schemaVersion: 1,
      workerName: "season-pack",
      pid: 700,
      heartbeatAt: "2026-07-15T00:50:00.000Z",
      runtimeFingerprint: environment.runtimeFingerprint,
      status: "healthy",
      environment,
    }), "utf8");
    await writeFile(path.join(workerRoot, "season-pack.900.json"), JSON.stringify({
      schemaVersion: 1,
      workerName: "season-pack",
      pid: 900,
      heartbeatAt: "2026-07-15T01:00:20.000Z",
      runtimeFingerprint: environment.runtimeFingerprint,
      status: "healthy",
      environment,
    }), "utf8");

    const stale = await readCodexRuntimeHealthForOwner("season-pack", "season-pack-700", {
      rootDir: root,
      now: Date.parse("2026-07-15T01:00:30.000Z"),
      maxAgeMs: 60_000,
    });
    const custom = await readCodexRuntimeHealthForOwner("season-pack", "legacy-custom-owner", {
      rootDir: root,
      now: Date.parse("2026-07-15T01:00:30.000Z"),
      maxAgeMs: 60_000,
    });

    assert.equal(stale.status, "stale");
    assert.equal(stale.matchKind, "legacy_pid");
    assert.equal(stale.worker?.pid, 700);
    assert.equal(custom.status, "unverifiable");
    assert.equal(custom.matchKind, "none");
    assert.equal(custom.worker?.pid, 900);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy single-file worker heartbeat remains readable during upgrade", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "localdirector-runtime-legacy-worker-"));
  try {
    const health = {
      schemaVersion: 1,
      status: "healthy",
      checkedAt: "2026-07-10T01:00:00.000Z",
      codexVersion: "codex-cli-test",
      configRoot: root,
      skillRoots: [],
      skillCount: 0,
      runtimeFingerprint: "fingerprint-legacy",
      errors: [],
    };
    await writeCodexRuntimeEnvironmentHealth({ rootDir: root, health });
    const workerRoot = path.join(root, ".tmp-codex-runtime", "workers");
    await mkdir(workerRoot, { recursive: true });
    await writeFile(path.join(workerRoot, "season-pack.json"), JSON.stringify({
      schemaVersion: 1,
      workerName: "season-pack",
      pid: 333,
      heartbeatAt: "2026-07-10T01:00:05.000Z",
      runtimeFingerprint: "fingerprint-legacy",
      status: "healthy",
    }), "utf8");

    const published = await readCodexRuntimeHealth({ rootDir: root, workerName: "season-pack" });
    assert.equal(published.worker?.pid, 333);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker heartbeat still carries its validated runtime snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "localdirector-runtime-snapshot-"));
  try {
    const health = {
      schemaVersion: 1,
      status: "healthy",
      checkedAt: "2026-07-10T01:00:00.000Z",
      codexVersion: "codex-cli-test",
      configRoot: root,
      skillRoots: [],
      skillCount: 0,
      runtimeFingerprint: "fingerprint-snapshot",
      errors: [],
    };
    await writeCodexWorkerHeartbeat({
      rootDir: root,
      workerName: "season-pack",
      health,
      heartbeatAt: "2026-07-10T01:00:05.000Z",
    });
    const published = await readCodexRuntimeHealth({ rootDir: root, workerName: "season-pack" });
    assert.equal(published.environment?.runtimeFingerprint, "fingerprint-snapshot");
    assert.equal(published.worker?.workerName, "season-pack");
    assert.equal(published.worker?.environment?.runtimeFingerprint, "fingerprint-snapshot");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex runtime validation blocks an unavailable CLI", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "localdirector-runtime-cli-"));
  try {
    const result = await validateCodexRuntime({
      skillRoots: [],
      codexVersion: "codex-unavailable",
      configRoot: root,
      checkedAt: "2026-07-10T01:30:00.000Z",
    });
    assert.equal(result.status, "invalid");
    assert.equal(result.errors[0]?.code, "CODEX_CLI_UNAVAILABLE");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex runtime health API and workers use the shared preflight", async () => {
  const route = await readFile(path.join(process.cwd(), "app/api/codex-runtime/health/route.ts"), "utf8");
  const seasonWorker = await readFile(path.join(process.cwd(), "scripts/season-pack-codex-worker.mjs"), "utf8");
  const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));

  assert.match(route, /readCodexRuntimeHealth/);
  assert.match(route, /CODEX_SKILL_CONFIG_INVALID/);
  assert.match(seasonWorker, /startCodexWorkerRuntimeHealth/);
  assert.match(seasonWorker, /workerInstanceId/);
  assert.equal(packageJson.scripts["codex:runtime-check"], "node scripts/codex-runtime-check.mjs");
});
