import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const SCAN_DIRS = ["app", "components", "lib", "scripts", "test"];
const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".ts", ".tsx"]);
const SKIP_FILES = new Set([path.join(ROOT, "test", "encoding-quality.test.mjs")]);

const MOJIBAKE_FRAGMENTS = [
  "骞跺彂",
  "涓撲笟",
  "鐢靛奖",
  "鍒嗛暅",
  "缃戠粶",
  "閲嶈瘯",
  "绗?",
  "闆?",
  "绉?",
  "鏃?",
  "瑙嗛",
  "鎻愮ず",
  "鐢熸垚",
  "姝ｅ湪",
  "宸插",
  "鍦?",
  "涓€",
  "鍚?",
  "缂?",
  "锟",
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === ".next" || entry.startsWith(".tmp-")) continue;
      yield* walk(fullPath);
      continue;
    }
    if (TEXT_EXTENSIONS.has(path.extname(entry)) && !SKIP_FILES.has(fullPath)) {
      yield fullPath;
    }
  }
}

test("source files do not contain common UTF-8 mojibake fragments", () => {
  const offenders = [];

  for (const dir of SCAN_DIRS) {
    for (const filePath of walk(path.join(ROOT, dir))) {
      const text = readFileSync(filePath, "utf8");
      for (const fragment of MOJIBAKE_FRAGMENTS) {
        if (text.includes(fragment)) {
          offenders.push(`${path.relative(ROOT, filePath)} contains ${JSON.stringify(fragment)}`);
        }
      }
    }
  }

  assert.deepEqual(offenders, []);
});
