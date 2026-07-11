import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { archiveCodexTaskJobs } from "../scripts/archive-codex-tasks.mjs";

test("archives v2 terminal jobs but preserves active job ids referenced by batch cache", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "localdirector-v2-archive-"));
  const queueName = ".tmp-video-prompt-pack-codex";
  const completedDir = join(rootDir, queueName, "completed");
  await writeJob(completedDir, "active.json", {
    id: "active",
    status: "completed",
    completedAt: "2026-06-01T00:10:00.000Z",
  });
  await writeJob(completedDir, "inactive.json", {
    id: "inactive",
    status: "completed",
    completedAt: "2026-06-01T00:10:00.000Z",
  });
  await writeJob(join(rootDir, ".tmp-segment-batch-cache"), "batch.json", {
    schemaVersion: 1,
    activeJobIds: ["active"],
  });
  try {
    const summary = await archiveCodexTaskJobs({
      rootDir,
      olderThanDays: 7,
      now: new Date("2026-07-05T00:00:00.000Z"),
      queues: [queueName],
    });
    assert.equal(summary.archived, 1);
    assert.equal(summary.protected, 1);
    assert.equal(existsSync(join(completedDir, "active.json")), true);
    assert.equal(existsSync(join(completedDir, "inactive.json")), false);
    assert.equal(existsSync(join(rootDir, queueName, "archive", "completed", "inactive.json")), true);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

async function writeJob(jobsDir, fileName, job) {
  await mkdir(jobsDir, { recursive: true });
  await writeFile(join(jobsDir, fileName), JSON.stringify(job, null, 2), "utf8");
}
