import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("Nest API configures a larger JSON body limit for saved prompt payloads", () => {
  const main = readFileSync("apps/api/src/main.ts", "utf8");

  assert.match(main, /from "express"/, "main.ts should import express body parsers");
  assert.match(main, /bodyParser:\s*false/, "Nest default body parser should be disabled before custom limits are applied");
  assert.match(main, /API_JSON_BODY_LIMIT/, "body limit should be configurable through API_JSON_BODY_LIMIT");
  assert.match(main, /json\(\{\s*limit:\s*bodyLimit\s*\}\)/s, "JSON parser should use the configured body limit");
  assert.match(main, /urlencoded\(\{\s*extended:\s*true,\s*limit:\s*bodyLimit\s*\}\)/s, "urlencoded parser should use the configured body limit");
});
