import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("batch segment repair worker requests strict repairs-only JSON", () => {
  assert.equal(existsSync("scripts/batch-segment-repair-codex-worker.mjs"), true);
  const source = readFileSync("scripts/batch-segment-repair-codex-worker.mjs", "utf8");
  const packageJson = readFileSync("package.json", "utf8");
  assert.match(packageJson, /batch-segment-repair:codex-worker/);
  assert.match(source, /\/api\/batch-segment-repair\/jobs\/claim/);
  assert.match(source, /repairs-only/i);
  assert.match(source, /assertRepairPatchJson/);
  assert.match(source, /withCodexCliSlot\("auxiliary"/);
  assert.doesNotMatch(source, /complete video prompt result/i);
});
