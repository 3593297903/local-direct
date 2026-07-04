import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { archiveCodexTaskJobs } from "../scripts/archive-codex-tasks.mjs";

test("archives only old completed or failed Codex task job files", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "localdirector-archive-"));
  const queueName = ".tmp-video-prompt-pack-codex";
  const jobsDir = join(rootDir, queueName, "jobs");
  await writeJob(jobsDir, "old-completed.json", {
    id: "old-completed",
    status: "completed",
    createdAt: "2026-06-01T00:00:00.000Z",
    completedAt: "2026-06-01T00:10:00.000Z",
  });
  await writeJob(jobsDir, "old-failed.json", {
    id: "old-failed",
    status: "failed",
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:05:00.000Z",
  });
  await writeJob(jobsDir, "recent-completed.json", {
    id: "recent-completed",
    status: "completed",
    createdAt: "2026-07-03T00:00:00.000Z",
    completedAt: "2026-07-03T00:10:00.000Z",
  });
  await writeJob(jobsDir, "old-running.json", {
    id: "old-running",
    status: "running",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:10:00.000Z",
  });

  try {
    const summary = await archiveCodexTaskJobs({
      rootDir,
      olderThanDays: 7,
      now: new Date("2026-07-05T00:00:00.000Z"),
      queues: [queueName],
    });

    assert.equal(summary.archived, 2);
    assert.equal(existsSync(join(jobsDir, "old-completed.json")), false);
    assert.equal(existsSync(join(jobsDir, "old-failed.json")), false);
    assert.equal(existsSync(join(rootDir, queueName, "archive", "jobs", "old-completed.json")), true);
    assert.equal(existsSync(join(rootDir, queueName, "archive", "jobs", "old-failed.json")), true);
    assert.equal(existsSync(join(jobsDir, "recent-completed.json")), true);
    assert.equal(existsSync(join(jobsDir, "old-running.json")), true);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("package exposes a Codex task archive command", async () => {
  const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
  assert.equal(pkg.scripts["codex:archive-tasks"], "node scripts/archive-codex-tasks.mjs");
});

async function writeJob(jobsDir, fileName, job) {
  await import("node:fs/promises").then(({ mkdir }) => mkdir(jobsDir, { recursive: true }));
  await writeFile(join(jobsDir, fileName), JSON.stringify(job, null, 2), "utf8");
}
