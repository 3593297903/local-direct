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

export const FIXTURE_SHA256 = "5697a3a48df12ad4be78056871dbbc84e702b56a83f89f13ab82ce1c21835db2";
export const FIXTURE_MANIFEST = createFixtureManifest(fixture, OBSERVED_SHAPE_PROFILE_30, {
  count: 30,
  min: 2020,
  p50: 2031,
  p95: 2527,
  max: 2548,
});
export { canonicalizeFixture, cloneFixture, computeFixtureHash };
export default fixture;
