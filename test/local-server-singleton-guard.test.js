import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("local server launcher refuses duplicate IPv4 or IPv6 listeners", () => {
  const source = fs.readFileSync(
    new URL("../scripts/start-server-local.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /isPortInUse\("127\.0\.0\.1"\)/);
  assert.match(source, /isPortInUse\("::1"\)/);
  assert.match(source, /occupied\.some\(Boolean\)/);
  assert.match(source, /refusing to start a duplicate instance/);
  assert.ok(
    source.indexOf("occupied.some(Boolean)") < source.indexOf('import("../src/server.js")'),
    "the duplicate guard must run before the application server is imported",
  );
});
