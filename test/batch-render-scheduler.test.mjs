import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({
  module: "commonjs",
  moduleResolution: "node",
});

const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const {
  buildRenderPacks,
  chooseRenderScheduleProfile,
  scoreSegmentRisk,
} = require("../lib/batch-render-scheduler.ts");

function makeSegments(count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => ({
    episodeIndex: index + 1,
    input: {
      sourceText: `Segment ${index + 1} ordinary daily story beat.`,
      shotCount: 4,
      segmentContract: {
        segmentIndex: index + 1,
        title: `Segment ${index + 1}`,
        sourceText: `Segment ${index + 1} ordinary daily story beat.`,
        durationSeconds: 12,
        shotCount: 4,
        requiredEvents: ["ordinary event"],
        forbiddenFutureEvents: [],
        characters: [],
        locations: [],
        props: [],
        requiredShotBeats: [{ shotNumber: 1, beat: "ordinary event", visualFocus: "room" }],
        safetyPolicy: { avoidTerms: [], rewriteHints: {} },
        contractHash: `sc_${index + 1}`,
      },
      ...overrides.input,
    },
    ...overrides,
  }));
}

test("ordinary segments use fast balanced packs without a delayed tail wave", () => {
  const schedule = buildRenderPacks(makeSegments(19));

  assert.equal(schedule.profile, "FAST");
  assert.equal(schedule.concurrency, 4);
  assert.deepEqual(schedule.packs.map((pack) => pack.length), [5, 5, 5, 4]);
});

test("low-risk batches can still balance into four clean packs", () => {
  const schedule = buildRenderPacks(makeSegments(16));

  assert.equal(schedule.profile, "FAST");
  assert.equal(schedule.concurrency, 4);
  assert.deepEqual(schedule.packs.map((pack) => pack.length), [4, 4, 4, 4]);
});

test("investigative and compliance-risk material uses smaller packs without lowering max scheduler concurrency", () => {
  const riskText = "\u5211\u4fa6 \u516c\u5b89 \u8b66\u65b9 \u5c38\u4f53 \u8840";
  const schedule = buildRenderPacks(
    makeSegments(20, {
      input: {
        sourceText: riskText,
        segmentContract: {
          segmentIndex: 1,
          title: "Risk segment",
          sourceText: riskText,
          durationSeconds: 12,
          shotCount: 4,
          requiredEvents: ["event one", "event two", "event three", "event four"],
          forbiddenFutureEvents: ["future one", "future two"],
          characters: [],
          locations: [],
          props: [],
          requiredShotBeats: [{ shotNumber: 1, beat: "event one", visualFocus: "room" }],
          safetyPolicy: { avoidTerms: [], rewriteHints: {} },
          contractHash: "sc_risk",
        },
      },
    }),
  );

  assert.equal(schedule.profile, "STRICT");
  assert.equal(schedule.concurrency, 4);
  assert.ok(schedule.packs.every((pack) => pack.length <= 2));
});

test("heavy consistency requirements use single-segment rendering", () => {
  const heavyContract = {
    segmentIndex: 1,
    title: "Heavy segment",
    sourceText: "\u5211\u4fa6 \u516c\u5b89 \u8b66\u65b9 \u5c38\u4f53 \u8840",
    durationSeconds: 15,
    shotCount: 6,
    requiredEvents: ["event one", "event two", "event three", "event four", "event five"],
    forbiddenFutureEvents: ["future one", "future two"],
    characters: ["A", "B", "C", "D"],
    locations: ["room", "street"],
    props: ["photo", "phone"],
    requiredShotBeats: [
      { shotNumber: 1, beat: "event one", visualFocus: "room" },
      { shotNumber: 2, beat: "event two", visualFocus: "street" },
      { shotNumber: 3, beat: "event three", visualFocus: "photo" },
      { shotNumber: 4, beat: "event four", visualFocus: "phone" },
      { shotNumber: 5, beat: "event five", visualFocus: "face" },
      { shotNumber: 6, beat: "event six", visualFocus: "door" },
    ],
    safetyPolicy: { avoidTerms: [], rewriteHints: {} },
    contractHash: "sc_heavy",
  };

  assert.equal(scoreSegmentRisk({ segmentContract: heavyContract }).score >= 6, true);
  assert.equal(chooseRenderScheduleProfile([{ segmentContract: heavyContract }]), "SINGLE");

  const schedule = buildRenderPacks(makeSegments(5, { input: { segmentContract: heavyContract } }));
  assert.equal(schedule.profile, "SINGLE");
  assert.equal(schedule.concurrency, 4);
  assert.deepEqual(schedule.packs.map((pack) => pack.length), [1, 1, 1, 1, 1]);
});

test("failed render retry can force single-segment packs", () => {
  const schedule = buildRenderPacks(makeSegments(3), { forceProfile: "SINGLE" });

  assert.equal(schedule.profile, "SINGLE");
  assert.equal(schedule.concurrency, 4);
  assert.deepEqual(schedule.packs.map((pack) => pack.length), [1, 1, 1]);
});

test("mixed-risk batches keep high-risk segments in small packs while allowing low-risk packs to stay larger", () => {
  const segments = makeSegments(10);
  segments[3].input.sourceText = "\u5211\u4fa6 \u516c\u5b89 \u8b66\u65b9 \u5c38\u4f53 \u8840";
  segments[3].input.segmentContract = {
    ...segments[3].input.segmentContract,
    sourceText: segments[3].input.sourceText,
    requiredEvents: ["event one", "event two", "event three", "event four"],
    forbiddenFutureEvents: ["future one", "future two"],
  };

  const schedule = buildRenderPacks(segments);
  const packWithRiskSegment = schedule.packs.find((pack) => pack.some((segment) => segment.episodeIndex === 4));

  assert.equal(schedule.concurrency, 4);
  assert.ok(schedule.packs.every((pack) => pack.length <= 5));
  assert.ok(packWithRiskSegment);
  assert.ok(packWithRiskSegment.length <= 2);
});
