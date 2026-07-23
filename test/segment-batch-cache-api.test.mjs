import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("segment batch cache API supports durable get and put", async () => {
  const source = await readFile(path.join(process.cwd(), "app/api/segment-batch-cache/[batchId]/route.ts"), "utf8");
  assert.match(source, /readSegmentBatchCache/);
  assert.match(source, /writeSegmentBatchCache/);
  assert.match(source, /export async function GET/);
  assert.match(source, /export async function PUT/);
});
