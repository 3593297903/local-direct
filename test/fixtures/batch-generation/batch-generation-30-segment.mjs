import {
  canonicalizeFixture,
  cloneFixture,
  computeFixtureHash,
  createBatchGenerationFixture,
  createFixtureManifest,
} from "./shared.mjs";
import { OBSERVED_SHAPE_PROFILE_30 } from "./shape-profiles.mjs";

const fixture = createBatchGenerationFixture({
  fixtureId: "representative-30-segment",
  segmentCount: 30,
  shapeProfile: OBSERVED_SHAPE_PROFILE_30,
});

export const FIXTURE_SHA256 = "1beaf759c8c16c75f712d75b8d27f502c9b9ba4e12f8c92d3f0fd7f607fe5108";
export const FIXTURE_MANIFEST = createFixtureManifest(fixture, OBSERVED_SHAPE_PROFILE_30, {
  count: 30,
  min: 1443,
  p50: 1447,
  p95: 1455,
  max: 2441,
});
export { canonicalizeFixture, cloneFixture, computeFixtureHash };
export default fixture;
