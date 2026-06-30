import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

test("API infrastructure doctor script documents Docker, database, Redis, migration, and import checks", () => {
  const scriptPath = "scripts/check-api-infra.mjs";
  assert.equal(existsSync(scriptPath), true);

  const script = readFileSync(scriptPath, "utf8");
  assert.match(script, /docker compose/);
  assert.match(script, /postgres/);
  assert.match(script, /redis/);
  assert.match(script, /prisma migrate/);
  assert.match(script, /library:import/);

  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(packageJson.scripts["infra:check"], "node scripts/check-api-infra.mjs");
});

test("API infrastructure doctor can emit machine-readable diagnostics without requiring Docker", () => {
  const output = execFileSync(process.execPath, ["scripts/check-api-infra.mjs", "--json"], {
    encoding: "utf8",
  });
  const result = JSON.parse(output);

  assert.equal(result.ok, typeof result.ok === "boolean" ? result.ok : undefined);
  assert.equal(Array.isArray(result.checks), true);
  assert.equal(result.checks.some((check) => check.name === "docker"), true);
  assert.equal(result.nextCommands.includes("npm run docker:up"), true);
  assert.equal(result.nextCommands.includes("npm run prisma:migrate"), true);
  assert.equal(result.nextCommands.includes("npm run library:import"), true);
});
