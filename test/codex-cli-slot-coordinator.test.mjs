import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("every Codex CLI worker uses the global slot coordinator and a per-worker singleton", async () => {
  const coordinator = await readFile(path.join(process.cwd(), "scripts", "codex-cli-slot-coordinator.mjs"), "utf8");
  const workers = [
    ["season-pack-codex-worker.mjs", "season_pack", "season-pack-worker"],
    ["video-prompt-codex-worker.mjs", "single_generation", "video-prompt-worker"],
    ["event-coverage-codex-worker.mjs", "coverage_judge", "event-coverage-worker"],
    ["prompt-safety-codex-worker.mjs", "safety_rewrite", "prompt-safety-worker"],
    ["storyboard-codex-worker.mjs", "visual_asset", "storyboard-worker"],
    ["visual-asset-codex-worker.mjs", "visual_asset", "visual-asset-worker"],
    ["video-prompt-pack-codex-worker.mjs", "render_pack", "video-prompt-pack-worker"],
    ["batch-segment-repair-codex-worker.mjs", "path_repair", "batch-segment-repair-worker"],
  ];

  assert.match(coordinator, /CODEX_CLI_MAX_SLOTS/);
  assert.match(coordinator, /CODEX_CLI_PRIMARY_RESERVED_SLOTS/);
  assert.match(coordinator, /selectCodexSlotGrants/);
  assert.match(coordinator, /staleMs/);
  for (const [fileName, role, lockName] of workers) {
    const source = await readFile(path.join(process.cwd(), "scripts", fileName), "utf8");
    assert.match(source, /import \{ withCodexCliSlot \} from "\.\/codex-cli-slot-coordinator\.mjs";/, fileName);
    assert.match(source, new RegExp(`withCodexCliSlot\\("${role}"`), fileName);
    assert.match(source, /import \{ acquireWorkerFleetLock \} from "\.\/worker-singleton-lock\.mjs";/, fileName);
    assert.match(source, new RegExp(`acquireWorkerFleetLock\\("${lockName}"`), fileName);
  }
});
