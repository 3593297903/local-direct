import {
  canonicalizeFixture,
  cloneFixture,
  computeFixtureHash,
  createBatchGenerationFixture,
  createFixtureManifest,
  replayFixtureThroughProductionPipeline,
} from "./shared.mjs";
import { OBSERVED_SHAPE_PROFILE_30 } from "./shape-profiles.mjs";

const fixture = createBatchGenerationFixture({
  fixtureId: "representative-30-segment",
  segmentCount: 30,
  shapeProfile: OBSERVED_SHAPE_PROFILE_30,
});

export const FIXTURE_SHA256 = "0329520be9b13f8548c2a338b3169d19bf58f3eb3ef61ec9c3fa3f86a8a6e216";
const liveReplay = replayFixtureThroughProductionPipeline(fixture);
export const FIXTURE_MANIFEST = createFixtureManifest(fixture, OBSERVED_SHAPE_PROFILE_30, {
  count: 30,
  min: 2020,
  p50: 2031,
  p95: 2527,
  max: 2548,
}, liveReplay);
export { canonicalizeFixture, cloneFixture, computeFixtureHash };
export default fixture;
