import assert from "node:assert/strict";
import test from "node:test";

test("global CLI slots start at four and reserve primary render capacity", async () => {
  const { resolveCodexCliSlotConfig, resolveCodexCliSlotCandidates } = await import("../scripts/codex-cli-slot-coordinator.mjs");
  const defaults = resolveCodexCliSlotConfig({});
  assert.equal(defaults.maxSlots, 4);
  assert.equal(defaults.primaryReservedSlots, 3);
  const clamped = resolveCodexCliSlotConfig({ CODEX_CLI_MAX_SLOTS: "9", CODEX_CLI_PRIMARY_RESERVED_SLOTS: "8" });
  assert.equal(clamped.maxSlots, 8);
  assert.equal(clamped.primaryReservedSlots, 7);
  assert.deepEqual(
    resolveCodexCliSlotCandidates("auxiliary", defaults, true),
    [4],
    "repair may occupy only one slot while render work exists",
  );
  assert.deepEqual(
    resolveCodexCliSlotCandidates("auxiliary", defaults, false),
    [4, 3, 2],
    "repair may use three slots only after render work drains",
  );
  assert.deepEqual(resolveCodexCliSlotCandidates("primary", defaults, true), [1, 2, 3, 4]);
  assert.deepEqual(
    resolveCodexCliSlotCandidates("primary", defaults, true, true),
    [1, 2, 3],
    "a waiting repair receives the fourth slot instead of starving behind continuous render work",
  );
});

test("the global CLI coordinator never runs more than four primary executions", async () => {
  const { withCodexCliSlot } = await import("../scripts/codex-cli-slot-coordinator.mjs");
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 20 }, (_, index) =>
    withCodexCliSlot("primary", `primary-${index}`, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
    })));
  assert.equal(peak <= 4, true);
  assert.equal(active, 0);
});
