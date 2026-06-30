import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

test("project save proxy retries once without narrative state fields for stale Nest APIs", () => {
  const proxy = readFileSync("lib/nest-projects-proxy.ts", "utf8");

  assert.match(proxy, /const NARRATIVE_STATE_FIELDS = \["stateVector", "openLoops", "narrativeMemory", "qualityCheck"\]/);
  assert.match(proxy, /function shouldRetryWithoutNarrativeState/);
  assert.match(proxy, /function omitNarrativeStateFields/);
  assert.match(proxy, /postProjectToNestWithCompatibility/);
  assert.match(proxy, /shouldRetryWithoutNarrativeState\(first\.upstream, first\.payload\)/);
  assert.match(proxy, /omitNarrativeStateFields\(body\)/);
});
