import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

test("user account nav fetches session state and exposes signed-in and signed-out actions", () => {
  const path = "components/UserAccountNav.tsx";
  assert.equal(existsSync(path), true, `${path} should exist`);

  const source = readFileSync(path, "utf8");
  assert.match(source, /fetch\("\/api\/auth\/me"/);
  assert.match(source, /\/api\/auth\/logout/);
  assert.match(source, /\/login/);
  assert.match(source, /\/login\?mode=register/);
  assert.match(source, /user\.email \|\| user\.phone/);
  assert.match(source, /isAuthenticated/);
});

test("signed-in account menu opens on click and only shows logout", () => {
  const source = readFileSync("components/UserAccountNav.tsx", "utf8");

  assert.match(source, /setMenuOpen/);
  assert.match(source, /aria-expanded=\{menuOpen\}/);
  assert.match(source, /onClick=\{\(\) => setMenuOpen\(\(open\) => !open\)\}/);
  assert.match(source, /用户中心/);
  assert.doesNotMatch(source, /group-hover:visible/);
  assert.doesNotMatch(source, /href="\/projects"/);
});

test("workspace pages mount the shared user account nav", () => {
  const pages = [
    "app/page.tsx",
    "app/dashboard/page.tsx",
    "app/library/page.tsx",
    "app/projects/page.tsx",
  ];

  for (const pagePath of pages) {
    const source = readFileSync(pagePath, "utf8");
    assert.match(source, /UserAccountNav/, `${pagePath} should import or render UserAccountNav`);
    assert.match(source, /<UserAccountNav/, `${pagePath} should render UserAccountNav`);
  }
});

test("login page can open directly in register mode from the account nav", () => {
  const source = readFileSync("app/login/page.tsx", "utf8");

  assert.match(source, /useSearchParams/);
  assert.match(source, /searchParams\.get\("mode"\)/);
  assert.match(source, /"register"/);
});
