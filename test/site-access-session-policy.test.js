import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const configSource = fs.readFileSync(new URL("../src/config.js", import.meta.url), "utf8");
const accessSource = fs.readFileSync(new URL("../src/server/access.js", import.meta.url), "utf8");
const serverSource = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const responseSource = fs.readFileSync(new URL("../src/http/response.js", import.meta.url), "utf8");

test("site access gate remembers validated browsers for 30 days by default", () => {
  assert.match(configSource, /siteAccessSessionHours: readNumberEnv\("SITE_ACCESS_SESSION_HOURS", 720\)/);
  assert.match(accessSource, /config\.siteAccessSessionHours \|\| 720/);
  assert.match(serverSource, /maxAge: getSiteAccessCookieMaxAgeSeconds\(\)/);
});

test("site access cookie keeps browser security attributes", () => {
  assert.match(serverSource, /sameSite: "Lax"/);
  assert.match(serverSource, /secure: siteAccessUsesSecureCookie\(req\)/);
  assert.match(responseSource, /options\.httpOnly !== false/);
});
