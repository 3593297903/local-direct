import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("global Codex slots reserve capacity for primary rendering", async () => {
  const coordinator = await readFile(path.join(process.cwd(), "scripts", "codex-cli-slot-coordinator.mjs"), "utf8");
  const renderWorker = await readFile(path.join(process.cwd(), "scripts", "video-prompt-pack-codex-worker.mjs"), "utf8");
  const judgeWorker = await readFile(path.join(process.cwd(), "scripts", "event-coverage-codex-worker.mjs"), "utf8");
  const repairWorker = await readFile(path.join(process.cwd(), "scripts", "batch-segment-repair-codex-worker.mjs"), "utf8");

  assert.match(coordinator, /CODEX_CLI_MAX_SLOTS/);
  assert.match(coordinator, /CODEX_CLI_PRIMARY_RESERVED_SLOTS/);
  assert.match(coordinator, /await fsp\.mkdir\(slotPath\)/);
  assert.match(coordinator, /staleMs/);
  assert.match(renderWorker, /withCodexCliSlot\("primary"/);
  assert.match(judgeWorker, /withCodexCliSlot\("auxiliary"/);
  assert.match(repairWorker, /withCodexCliSlot\("auxiliary"/);
});
