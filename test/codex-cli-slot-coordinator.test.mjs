import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("every Codex CLI worker uses the global slot coordinator and a per-worker singleton", async () => {
  const coordinator = await readFile(path.join(process.cwd(), "scripts", "codex-cli-slot-coordinator.mjs"), "utf8");
  const workers = [
    ["season-pack-codex-worker.mjs", "primary", "season-pack-worker"],
    ["video-prompt-codex-worker.mjs", "primary", "video-prompt-worker"],
    ["event-coverage-codex-worker.mjs", "auxiliary", "event-coverage-worker"],
    ["prompt-safety-codex-worker.mjs", "auxiliary", "prompt-safety-worker"],
    ["storyboard-codex-worker.mjs", "auxiliary", "storyboard-worker"],
    ["visual-asset-codex-worker.mjs", "auxiliary", "visual-asset-worker"],
    ["video-prompt-pack-codex-worker.mjs", "primary", "video-prompt-pack-worker"],
    ["batch-segment-repair-codex-worker.mjs", "auxiliary", "batch-segment-repair-worker"],
  ];

  assert.match(coordinator, /CODEX_CLI_MAX_SLOTS/);
  assert.match(coordinator, /CODEX_CLI_PRIMARY_RESERVED_SLOTS/);
  assert.match(coordinator, /await fsp\.mkdir\(slotPath\)/);
  assert.match(coordinator, /staleMs/);
  for (const [fileName, role, lockName] of workers) {
    const source = await readFile(path.join(process.cwd(), "scripts", fileName), "utf8");
    assert.match(source, /import \{ withCodexCliSlot \} from "\.\/codex-cli-slot-coordinator\.mjs";/, fileName);
    assert.match(source, new RegExp(`withCodexCliSlot\\("${role}"`), fileName);
    assert.match(source, /import \{ acquireWorkerFleetLock \} from "\.\/worker-singleton-lock\.mjs";/, fileName);
    assert.match(source, new RegExp(`acquireWorkerFleetLock\\("${lockName}"`), fileName);
  }
});
