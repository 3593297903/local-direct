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

export const FIXTURE_SHA256 = "885938e67b19c57e1b86c6d481ea6be28588f69c57f7d7719174c859154391cc";
export const FIXTURE_MANIFEST = createFixtureManifest(fixture, OBSERVED_SHAPE_PROFILE_20, {
  count: 20,
  min: 1740,
  p50: 1745,
  p95: 1754,
  max: 2550,
});
export { canonicalizeFixture, cloneFixture, computeFixtureHash };
export default fixture;
