import {
  canonicalizeFixture,
  cloneFixture,
  computeFixtureHash,
  createBatchGenerationFixture,
  createFixtureManifest,
} from "./shared.mjs";
import { OBSERVED_SHAPE_PROFILE_20 } from "./shape-profiles.mjs";

const fixture = createBatchGenerationFixture({
  fixtureId: "observed-20-segment",
  segmentCount: 20,
  shapeProfile: OBSERVED_SHAPE_PROFILE_20,
});

export const FIXTURE_SHA256 = "bb422cc0398457da43398e2e7f29a48289e39a909b987389314124b80d463f69";
export const FIXTURE_MANIFEST = createFixtureManifest(fixture, OBSERVED_SHAPE_PROFILE_20, {
  count: 20,
  min: 1444,
  p50: 1447,
  p95: 1455,
  max: 2441,
});
export { canonicalizeFixture, cloneFixture, computeFixtureHash };
export default fixture;
