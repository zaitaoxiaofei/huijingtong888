import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const settingsViewSource = fs.readFileSync(new URL("../frontend/admin/views/settings/SettingsView.vue", import.meta.url), "utf8");
const operationsRouteSource = fs.readFileSync(new URL("../src/server/routes/operations.js", import.meta.url), "utf8");
const adminLayoutSource = fs.readFileSync(new URL("../frontend/admin/layouts/AdminLayout.vue", import.meta.url), "utf8");
const sessionSource = fs.readFileSync(new URL("../src/server/session.js", import.meta.url), "utf8");
const authSessionSource = fs.readFileSync(new URL("../src/services/mysql-auth-session.js", import.meta.url), "utf8");

test("people settings uploads and displays square avatars", () => {
  assert.match(settingsViewSource, /uploadListingMedia\(squareFile,\s*\{\s*source_module: "person_avatar"/s);
  assert.match(settingsViewSource, /Math\.min\(image\.naturalWidth, image\.naturalHeight\)/);
  assert.match(settingsViewSource, /canvas\.getContext\("2d"\)\.drawImage/);
  assert.match(settingsViewSource, /canvas\.toBlob\(resolve, "image\/webp", 0\.9\)/);
  assert.match(settingsViewSource, /<el-avatar :src="row\.avatar_url"/);
  assert.match(settingsViewSource, /personDialog\.form\.avatar_url = result\.publishUrl \|\| result\.url \|\| result\.previewUrl/);
});

test("current user avatar is returned and displayed in the admin header", () => {
  assert.match(authSessionSource, /SELECT id, name, username, role, roles_json, avatar_url, active, password_hash FROM people/);
  assert.match(sessionSource, /avatar_url: row\.avatar_url \|\| ""/);
  assert.match(adminLayoutSource, /<el-avatar :src="authStore\.user\?\.avatar_url"/);
  assert.match(adminLayoutSource, /@click="openProfileDialog"/);
  assert.match(adminLayoutSource, /:preview-src-list="\[profileForm\.avatar_url\]"/);
  assert.match(adminLayoutSource, /uploadProfileAvatar/);
  assert.match(adminLayoutSource, /apiClient\.put\("\/api\/auth\/profile"/);
  assert.match(adminLayoutSource, /apiClient\.post\("\/api\/auth\/change-password"/);
  assert.match(sessionSource, /PUT \/api\/auth\/profile/);
  assert.match(authSessionSource, /UPDATE people SET name = \?, avatar_url = \?, updated_at = CURRENT_TIMESTAMP WHERE id = \?/);
});

test("editing a person omits an unchanged password", () => {
  assert.match(settingsViewSource, /personDialog\.mode === "edit" && !String\(payload\.password \|\| ""\)\.trim\(\)\) delete payload\.password/);
});

test("people settings uses the hard-delete endpoint instead of deactivation", () => {
  assert.match(settingsViewSource, /apiClient\.delete\(`\/api\/people\/\$\{row\.id\}\?hard=1`\)/);
  assert.match(settingsViewSource, />删除<\/el-button>/);
  assert.match(operationsRouteSource, /url\.searchParams\.get\("hard"\) === "1"\) await services\.hardDeletePerson/);
});
