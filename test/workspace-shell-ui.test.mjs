import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("sidebar collapses by default, expands on hover, and highlights routes", async () => {
  const sidebarSource = await readFile(join(process.cwd(), "components", "Sidebar.tsx"), "utf8");

  assert.match(sidebarSource, /usePathname/);
  assert.match(sidebarSource, /useSearchParams/);
  assert.match(sidebarSource, /group\/sidebar/);
  assert.match(sidebarSource, /w-\[4\.25rem\]/);
  assert.match(sidebarSource, /group-hover\/sidebar:w-48/);
  assert.match(sidebarSource, /isActiveNavItem/);
  assert.doesNotMatch(sidebarSource, /index === 0/);
});

test("reference motion cards keep video previews paused until hover", async () => {
  const dashboardSource = await readFile(join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");
  const referenceButton = dashboardSource.match(/function ReferenceItemButton[\s\S]*?function ReferenceSection/)?.[0] || "";

  assert.match(referenceButton, /PreviewAnimation/);
  assert.match(referenceButton, /playback="hover"/);
});

test("library admin can copy an item into a new editable draft", async () => {
  const librarySource = await readFile(join(process.cwd(), "components", "LibraryClient.tsx"), "utf8");

  assert.match(librarySource, /type AdminMode = "idle" \| "edit" \| "copy" \| "delete"/);
  assert.match(librarySource, /createKnowledgeItemCopyDraft/);
  assert.match(librarySource, /mode === "copy"/);
  assert.match(librarySource, /<Copy className="h-4 w-4" \/>/);
});

test("front library pages do not expose an admin login button", async () => {
  const librarySource = await readFile(join(process.cwd(), "components", "LibraryClient.tsx"), "utf8");
  const adminLibrarySource = await readFile(join(process.cwd(), "components", "AdminLibraryClient.tsx"), "utf8");

  assert.doesNotMatch(librarySource, /LogIn/);
  assert.doesNotMatch(librarySource, /setLoginOpen/);
  assert.doesNotMatch(librarySource, /function LoginModal/);
  assert.match(librarySource, /fetch\("\/api\/admin\/session"\)/);
  assert.match(librarySource, /<Edit3 className="h-4 w-4" \/>/);
  assert.match(librarySource, /<PlusCircle className="h-4 w-4" \/>/);
  assert.match(librarySource, /deleteChecked/);

  assert.match(adminLibrarySource, /\/api\/admin\/login/);
  assert.match(adminLibrarySource, /Local Admin/);
});
