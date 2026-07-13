import {
  canonicalizeFixture,
  cloneFixture,
  computeFixtureHash,
  createBatchGenerationFixture,
} from "./shared.mjs";

const fixture = createBatchGenerationFixture({
  fixtureId: "observed-20-segment",
  segmentCount: 20,
});

export const FIXTURE_SHA256 = "a53d9512cb3939763de8cb174b88c5681a23cf460770292d7298d3935ea3b347";
export { canonicalizeFixture, cloneFixture, computeFixtureHash };
export default fixture;
