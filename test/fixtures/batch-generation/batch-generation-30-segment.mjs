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

export const FIXTURE_SHA256 = "3d1394865514b49d97ea06cf9dd6857f0f5e9544b4b9990783d1195ae52bc4d2";
export const FIXTURE_MANIFEST = createFixtureManifest(fixture, OBSERVED_SHAPE_PROFILE_30, {
  count: 30,
  min: 1443,
  p50: 1447,
  p95: 1455,
  max: 2441,
});
export { canonicalizeFixture, cloneFixture, computeFixtureHash };
export default fixture;
