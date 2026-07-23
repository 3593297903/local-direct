import {
  canonicalizeFixture,
  cloneFixture,
  computeFixtureHash,
  createBatchGenerationFixture,
  createFixtureManifest,
  replayFixtureThroughProductionPipeline,
} from "./shared.mjs";
import { OBSERVED_SHAPE_PROFILE_20 } from "./shape-profiles.mjs";

const fixture = createBatchGenerationFixture({
  fixtureId: "observed-20-segment",
  segmentCount: 20,
  shapeProfile: OBSERVED_SHAPE_PROFILE_20,
});

export const FIXTURE_SHA256 = "4b65de1642f5d7cf318f14f818116a16dd4a1460b4269f4bb3b2f84c330706b3";
const liveReplay = replayFixtureThroughProductionPipeline(fixture);
export const FIXTURE_MANIFEST = createFixtureManifest(fixture, OBSERVED_SHAPE_PROFILE_20, {
  count: 20,
  min: 1740,
  p50: 1745,
  p95: 1754,
  max: 2550,
}, liveReplay);
export { canonicalizeFixture, cloneFixture, computeFixtureHash };
export default fixture;
