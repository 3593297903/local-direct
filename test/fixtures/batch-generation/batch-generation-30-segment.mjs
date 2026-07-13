import {
  canonicalizeFixture,
  cloneFixture,
  computeFixtureHash,
  createBatchGenerationFixture,
} from "./shared.mjs";

const fixture = createBatchGenerationFixture({
  fixtureId: "representative-30-segment",
  segmentCount: 30,
});

export const FIXTURE_SHA256 = "fce6446a006fa187a83deeb3afae69f5b8ae3c0df473cad944209100f364d569";
export { canonicalizeFixture, cloneFixture, computeFixtureHash };
export default fixture;
