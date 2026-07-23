import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("event coverage judge exposes strict create, poll, claim, complete, and fail routes", async () => {
  const files = [
    "app/api/event-coverage/jobs/route.ts",
    "app/api/event-coverage/jobs/[jobId]/route.ts",
    "app/api/event-coverage/jobs/claim/route.ts",
    "app/api/event-coverage/jobs/[jobId]/complete/route.ts",
    "app/api/event-coverage/jobs/[jobId]/fail/route.ts",
  ];
  for (const file of files) {
    const source = await readFile(path.join(process.cwd(), file), "utf8");
    assert.match(source, /event-coverage-(?:codex-queue|wave-aggregator)/);
  }
});
