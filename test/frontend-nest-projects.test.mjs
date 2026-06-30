import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

test("Next projects route proxies authenticated project reads and writes to NestJS", () => {
  const helperPath = "lib/nest-projects-proxy.ts";
  assert.equal(existsSync(helperPath), true, `${helperPath} should exist`);

  const helper = readFileSync(helperPath, "utf8");
  assert.match(helper, /NEST_AUTH_TOKEN_COOKIE/);
  assert.match(helper, /Authorization.*Bearer/);
  assert.match(helper, /\/projects/);
  assert.match(helper, /mapAnalysisResultToNestProjectBody/);
  assert.match(helper, /originalScript/);
  assert.match(helper, /storyboard\.map/);

  const route = readFileSync("app/api/projects/route.ts", "utf8");
  assert.doesNotMatch(route, /supabase/i);
  assert.match(route, /proxyNestProjectsGet\(request\)/);
  assert.match(route, /proxyNestProjectsPost\(request\)/);
  assert.match(route, /export async function GET\(request: NextRequest\)/);
  assert.match(route, /export async function POST\(request: NextRequest\)/);
});
