import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const {
  buildPreflightedRenderPacks,
  preflightSegmentContracts,
} = require("../lib/batch-contract-preflight.ts");
const {
  createRenderOperationDraftFromPreflightPack,
  validateRenderOperation,
} = require("../lib/batch-render-operation.ts");
const {
  buildSegmentContractHash,
  normalizeSegmentContract,
} = require("../lib/batch-segment-contract.ts");

function makeContract(segmentIndex, overrides = {}) {
  const sourceText = overrides.sourceText || `Segment ${segmentIndex} source text with evidence verification.`;
  const contract = normalizeSegmentContract({
    segmentIndex,
    title: `Segment ${segmentIndex}`,
    sourceText,
    durationSeconds: 12,
    shotCount: 4,
    requiredEvents: [`Verify evidence ${segmentIndex}`],
    requiredEventSlots: [{
      id: `event_${segmentIndex}`,
      label: `Verify evidence ${segmentIndex}`,
      importance: "blocking",
      anchorGroups: [["investigator"], [`evidence ${segmentIndex}`]],
      conceptGroups: [["verify", "confirm"]],
      contradictionGroups: [["not verified"]],
      evidenceSelectors: [{ source: "storyboard", shotNumber: "any", fields: ["visual"], requireExecutableShot: true }],
      repairTargets: [{ shotNumber: "best_match", field: "visual" }],
    }],
    forbiddenFutureEvents: [`Segment ${segmentIndex + 1} outcome`],
    characterLocks: [{
      characterId: "investigator",
      displayName: "Investigator",
      factKey: "identity",
      expectedValue: "investigator",
      mode: "must_not_contradict",
      contradictionSignals: [["civilian"]],
    }],
    requiredShotBeats: Array.from({ length: 4 }, (_, offset) => ({
      shotNumber: offset + 1,
      timeRange: `${offset * 3}s-${(offset + 1) * 3}s`,
      beat: `Shot ${offset + 1} advances evidence verification`,
      visualFocus: `Segment ${segmentIndex} shot ${offset + 1}`,
    })),
    safetyPolicy: { avoidTerms: [], rewriteHints: {} },
    ...overrides,
  }, {
    segmentIndex,
    fallbackTitle: `Segment ${segmentIndex}`,
    fallbackSourceText: sourceText,
    fallbackDurationSeconds: 12,
    fallbackShotCount: 4,
  });
  return { ...contract, contractHash: buildSegmentContractHash(contract) };
}

function makeItem(segmentIndex, contract = makeContract(segmentIndex)) {
  return {
    episodeIndex: segmentIndex,
    input: {
      title: contract.title,
      sourceText: contract.sourceText,
      duration: `${contract.durationSeconds}s`,
      shotCount: contract.shotCount,
      segmentContract: contract,
    },
  };
}

const preflightOptions = {
  getSegmentIndex: (item) => item.episodeIndex,
  getSourceText: (item) => item.input.sourceText,
  getContract: (item) => item.input.segmentContract,
  getScheduleSegment: (entry) => ({
    sourceText: entry.item.input.sourceText,
    shotCount: entry.item.input.shotCount,
    segmentContract: entry.item.input.segmentContract,
  }),
};

function makeOverflowContract(segmentIndex) {
  const semantic = "required blocking event semantic ".repeat(240);
  return makeContract(segmentIndex, {
    requiredEventSlots: [{
      id: `overflow_${segmentIndex}`,
      label: semantic,
      importance: "blocking",
      anchorGroups: [["investigator"], ["evidence"]],
      conceptGroups: [[semantic]],
      contradictionGroups: [["event did not happen"]],
      evidenceSelectors: [{ source: "storyboard", shotNumber: "any", fields: ["visual"], requireExecutableShot: true }],
      repairTargets: [{ shotNumber: "best_match", field: "visual" }],
    }],
  });
}

test("oversized B splits A/B/C into contiguous eligible runs without joining A to C", () => {
  const items = [makeItem(1), makeItem(2, makeOverflowContract(2)), makeItem(3)];
  const plan = preflightSegmentContracts(items, preflightOptions);

  assert.deepEqual(plan.eligibleRuns.map((run) => run.map((entry) => entry.item.episodeIndex)), [[1], [3]]);
  assert.deepEqual(plan.invalid.map((entry) => entry.item.episodeIndex), [2]);
  assert.equal(plan.invalid[0].preflight.reasonCode, "CONTRACT_BUDGET_EXCEEDED");
  assert.equal(plan.metrics.attempts, 3);
  assert.equal(plan.metrics.invalid, 1);

  const schedule = buildPreflightedRenderPacks(plan, preflightOptions);
  assert.deepEqual(schedule.packs.map((pack) => pack.entries.map((entry) => entry.item.episodeIndex)), [[1], [3]]);
  assert.equal(schedule.packs.some((pack) => pack.entries.length === 2), false);
});

test("valid A and C create operations while invalid B creates none", () => {
  const plan = preflightSegmentContracts(
    [makeItem(1), makeItem(2, makeOverflowContract(2)), makeItem(3)],
    preflightOptions,
  );
  const schedule = buildPreflightedRenderPacks(plan, preflightOptions);
  const operations = schedule.packs.map((pack, index) => createRenderOperationDraftFromPreflightPack({
    batchId: "batch-preflight",
    operationToken: `operation-${index + 1}`,
    pack,
    reconciliationContext: {
      sourceText: "Complete source text",
      segments: pack.entries.map(({ item }) => ({
        episodeIndex: item.episodeIndex,
        title: item.input.title,
        sourceText: item.input.sourceText,
        duration: item.input.duration,
        shotCount: item.input.shotCount,
        segmentContract: item.input.segmentContract,
      })),
    },
    now: "2026-07-16T00:00:00.000Z",
  }));

  assert.deepEqual(operations.map((operation) => operation.segmentIndexes), [[1], [3]]);
  assert.equal(operations.flatMap((operation) => operation.segmentIndexes).includes(2), false);
});

test("compacted contracts remain in their contiguous eligible run", () => {
  const compacted = makeContract(2, {
    sourceText: "Source text already travels independently in the render script. ".repeat(180),
  });
  const plan = preflightSegmentContracts([makeItem(1), makeItem(2, compacted), makeItem(3)], preflightOptions);

  assert.equal(plan.invalid.length, 0);
  assert.equal(plan.eligibleRuns.length, 1);
  assert.deepEqual(plan.eligibleRuns[0].map((entry) => entry.item.episodeIndex), [1, 2, 3]);
  assert.equal(plan.eligibleRuns[0][1].preflight.compile.status, "compacted");
  assert.equal(plan.eligibleRuns[0][1].preflight.reasonCode, "CONTRACT_PREFLIGHT_COMPACTED");
});

test("explicitly isolated valid contracts stay original Render Packs", () => {
  const options = {
    ...preflightOptions,
    shouldIsolate: (_item, preflight) => preflight.segmentIndex === 2,
  };
  const plan = preflightSegmentContracts([makeItem(1), makeItem(2), makeItem(3)], options);
  const schedule = buildPreflightedRenderPacks(plan, options);

  assert.deepEqual(plan.isolated.map((entry) => entry.item.episodeIndex), [2]);
  assert.deepEqual(schedule.packs.map((pack) => pack.entries.map((entry) => entry.item.episodeIndex)), [[1], [2], [3]]);
  assert.equal(schedule.packs[1].kind, "render_pack");
  assert.equal(schedule.packs[1].isolated, true);
  assert.equal(schedule.packs[1].repair, false);
  assert.equal(schedule.packs[1].singleGeneration, false);
});

test("operation draft persists exact compiled creation payload and rejects tampering", () => {
  const item = makeItem(1);
  const plan = preflightSegmentContracts([item], preflightOptions);
  const [pack] = buildPreflightedRenderPacks(plan, preflightOptions).packs;
  const input = {
    batchId: "batch-preflight",
    operationToken: "operation-stable",
    pack,
    reconciliationContext: {
      sourceText: "Complete source text",
      segments: [{
        episodeIndex: item.episodeIndex,
        title: item.input.title,
        sourceText: item.input.sourceText,
        duration: item.input.duration,
        shotCount: item.input.shotCount,
        segmentContract: item.input.segmentContract,
      }],
    },
    now: "2026-07-16T00:00:00.000Z",
  };
  const first = createRenderOperationDraftFromPreflightPack(input);
  const retry = createRenderOperationDraftFromPreflightPack(input);

  assert.deepEqual(first, retry);
  assert.equal(first.state, "creating");
  assert.equal(first.creationContext.segments[0].compiledContract.text, pack.entries[0].preflight.compile.text);
  assert.equal(first.idempotencyKey, retry.idempotencyKey);

  const tampered = structuredClone(first);
  tampered.creationContext.segments[0].compiledContract.text += "tampered";
  assert.throws(() => validateRenderOperation(tampered), /creationContext|compiled/i);
});
