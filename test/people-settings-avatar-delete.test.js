import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const settingsViewSource = fs.readFileSync(new URL("../frontend/admin/views/settings/SettingsView.vue", import.meta.url), "utf8");
const enterprisePeopleSource = fs.readFileSync(new URL("../frontend/admin/views/settings/EnterprisePersonnelPanel.vue", import.meta.url), "utf8");
const operationsRouteSource = fs.readFileSync(new URL("../src/server/routes/operations.js", import.meta.url), "utf8");
const adminLayoutSource = fs.readFileSync(new URL("../frontend/admin/layouts/AdminLayout.vue", import.meta.url), "utf8");
const sessionSource = fs.readFileSync(new URL("../src/server/session.js", import.meta.url), "utf8");
const authSessionSource = fs.readFileSync(new URL("../src/services/mysql-auth-session.js", import.meta.url), "utf8");

test("shared rules no longer duplicate global personnel administration and enterprise profiles retain avatars", () => {
  assert.doesNotMatch(settingsViewSource, /personDialog|person_avatar|\/api\/people/);
  assert.match(enterprisePeopleSource, /avatar_url: form\.avatar_url\.trim\(\)/);
  assert.match(enterprisePeopleSource, /apiClient\.put\(`\/api\/enterprise\/people\/\$\{form\.id\}`/);
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
  assert.match(enterprisePeopleSource, /if \(!editing\.value \|\| form\.password\.trim\(\)\) payload\.password = form\.password/);
});

test("shared settings cannot hard-delete an account while the legacy maintenance endpoint remains separate", () => {
  assert.doesNotMatch(settingsViewSource, /hard=1|hardDeletePerson|personDialog/);
  assert.match(operationsRouteSource, /url\.searchParams\.get\("hard"\) === "1"\) await services\.hardDeletePerson/);
});
