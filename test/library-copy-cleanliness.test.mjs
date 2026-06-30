import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const FRONT_FACING_FIELDS = ["description", "tags", "useCase", "avoid", "prompt"];
const FORBIDDEN_COPY_TERMS = [
  "来源",
  "来源于",
  "来源文件",
  "示例素材",
  "公版素材",
  "公例素材",
  "素材库",
  "参考素材",
  "适合作为",
  "用于作为",
  "主分类",
  "核心手法",
  "来源片段",
  "高光",
  ".mp4",
];

test("library front-facing copy does not expose internal source notes", async () => {
  const raw = await readFile(join(process.cwd(), "data", "knowledge-items.json"), "utf8");
  const items = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  const violations = [];

  for (const item of items) {
    for (const field of FRONT_FACING_FIELDS) {
      const value = Array.isArray(item[field]) ? item[field].join(" ") : String(item[field] || "");
      for (const term of FORBIDDEN_COPY_TERMS) {
        if (value.includes(term)) violations.push(`${item.id}.${field}: ${term}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});
