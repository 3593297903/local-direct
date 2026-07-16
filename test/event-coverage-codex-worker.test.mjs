import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("event coverage worker emits decisions only and defaults to one concurrent wave", async () => {
  const worker = await readFile(path.join(process.cwd(), "scripts/event-coverage-codex-worker.mjs"), "utf8");
  const pkg = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));
  assert.equal(pkg.scripts["event-coverage:codex-worker"], "node scripts/event-coverage-codex-worker.mjs");
  assert.match(worker, /EVENT_COVERAGE_CODEX_CONCURRENCY, 1/);
  assert.match(worker, /decisions-only/i);
  assert.match(worker, /withCodexCliSlot\("coverage_judge"/);
  assert.doesNotMatch(worker, /requestAnalysisWithContext/);
});
