import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const { createBatchRepairScheduler } = require("../lib/batch-repair-scheduler.ts");

test("repair scheduler overlaps later render work and deduplicates fingerprints", async () => {
  const started = [];
  const releases = [];
  const scheduler = createBatchRepairScheduler({
    maxConcurrency: 3,
    execute: async (task) => {
      started.push(task.segmentIndex);
      await new Promise((resolve) => releases.push(resolve));
      return task.segmentIndex;
    },
  });

  assert.equal(scheduler.enqueue({ segmentIndex: 1, fingerprint: "1:a", payload: {} }), true);
  assert.equal(scheduler.enqueue({ segmentIndex: 1, fingerprint: "1:a", payload: {} }), false);
  assert.equal(scheduler.enqueue({ segmentIndex: 2, fingerprint: "2:a", payload: {} }), true);
  assert.equal(scheduler.enqueue({ segmentIndex: 3, fingerprint: "3:a", payload: {} }), true);
  assert.equal(scheduler.enqueue({ segmentIndex: 4, fingerprint: "4:a", payload: {} }), true);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started.sort((a, b) => a - b), [1, 2, 3]);
  assert.equal(scheduler.snapshot().activeCount, 3);
  releases.splice(0).forEach((release) => release());
  await new Promise((resolve) => setImmediate(resolve));
  releases.splice(0).forEach((release) => release());
  await scheduler.waitForIdle();
  assert.deepEqual(started.sort((a, b) => a - b), [1, 2, 3, 4]);
});

test("one hundred deterministic scheduling samples never exceed three active repairs", async () => {
  for (let sample = 0; sample < 100; sample += 1) {
    let active = 0;
    let peak = 0;
    const scheduler = createBatchRepairScheduler({
      maxConcurrency: 3,
      execute: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
      },
    });
    const count = 1 + (sample % 30);
    for (let index = 1; index <= count; index += 1) {
      scheduler.enqueue({ segmentIndex: index, fingerprint: `${sample}:${index}`, payload: {} });
    }
    await scheduler.waitForIdle();
    assert.ok(peak <= 3, `sample ${sample} reached ${peak}`);
    assert.equal(scheduler.snapshot().completedCount, count);
  }
});
