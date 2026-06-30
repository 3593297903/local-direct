import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { normalizeIdentifier } from "../scripts/promote-admin.mjs";

test("AdminGuard enforces JWT verification plus role ADMIN", () => {
  const guardPath = "apps/api/src/modules/auth/admin.guard.ts";
  assert.equal(existsSync(guardPath), true, "admin.guard.ts should exist");

  const guard = readFileSync(guardPath, "utf8");
  assert.match(guard, /extends JwtAuthGuard/);
  assert.match(guard, /x-internal-admin-token/);
  assert.match(guard, /ADMIN_SESSION_SECRET/);
  assert.match(guard, /super\.canActivate/);
  assert.match(guard, /role !== "ADMIN"/);
  assert.match(guard, /ForbiddenException/);
});

test("auth module registers and exports AdminGuard", () => {
  const mod = readFileSync("apps/api/src/modules/auth/auth.module.ts", "utf8");
  assert.match(mod, /import \{ AdminGuard \}/);
  assert.match(mod, /providers:\s*\[[^\]]*AdminGuard/s);
  assert.match(mod, /exports:\s*\[[^\]]*AdminGuard/s);
});

test("admin module imports AuthModule and exposes a guarded /me endpoint", () => {
  const mod = readFileSync("apps/api/src/modules/admin/admin.module.ts", "utf8");
  assert.match(mod, /AuthModule/);
  assert.match(mod, /imports:\s*\[[^\]]*AuthModule/s);

  const controller = readFileSync("apps/api/src/modules/admin/admin.controller.ts", "utf8");
  assert.match(controller, /@UseGuards\(AdminGuard\)/);
  assert.match(controller, /@Get\("me"\)/);
  assert.match(controller, /getCurrentUser/);
});

test("promote-admin normalizes email and phone identifiers", () => {
  assert.equal(normalizeIdentifier("  Admin@Example.com "), "admin@example.com");
  assert.equal(normalizeIdentifier(" 138 0000 0000 "), "13800000000");
  assert.equal(normalizeIdentifier(undefined), "");
});

test("promote-admin script targets the User.role field", () => {
  const script = readFileSync("scripts/promote-admin.mjs", "utf8");
  assert.match(script, /const role = revoke \? "USER" : "ADMIN"/);
  assert.match(script, /prisma\.user\.update/);
});

test("admin home page gates access on role ADMIN", () => {
  const page = readFileSync("app/admin/page.tsx", "utf8");
  assert.match(page, /AdminShell/);

  const shell = readFileSync("components/AdminShell.tsx", "utf8");
  assert.match(shell, /\/api\/admin\/session/);
  assert.match(shell, /\/api\/admin\/login/);
  assert.doesNotMatch(shell, /\/login\?next=/);
});
