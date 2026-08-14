import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("desktop startup wrappers use the shared start:all entrypoint", () => {
  const windowsStart = fs.readFileSync("start.bat", "utf8");
  const macStart = fs.readFileSync("start-ozon-erp.command", "utf8");

  assert.match(windowsStart, /npm\s+run\s+start:all/i);
  assert.doesNotMatch(windowsStart, /scripts[\\/]start-with-build\.mjs/i);
  assert.match(macStart, /npm\s+run\s+start:all/);
});

test("macOS command wrapper is executable", { skip: process.platform === "win32" }, () => {
  const mode = fs.statSync("start-ozon-erp.command").mode;

  assert.notEqual(mode & 0o111, 0);
});

test("Windows MySQL helper keeps its dedicated local MySQL flow", () => {
  const mysqlStart = fs.readFileSync("start-mysql.bat", "utf8");

  assert.match(mysqlStart, /scripts\\start-local-mysql\.ps1/i);
  assert.match(mysqlStart, /-StartTunnel/i);
  assert.match(mysqlStart, /-StartApp/i);
});

test("start:all skips Electron unless explicitly enabled", () => {
  const startAll = fs.readFileSync("scripts/start-all.mjs", "utf8");
  const windowsStart = fs.readFileSync("start.bat", "utf8");

  assert.match(startAll, /process\.env\.OZON_START_ELECTRON\s*===\s*"1"/);
  assert.match(startAll, /Electron startup skipped/);
  assert.match(startAll, /npmBin,\s*\["exec",\s*"electron",\s*"--",\s*"\."\]/);
  assert.doesNotMatch(windowsStart, /Electron/i);
});

test("startup scripts refuse protected ERP ports unless explicitly authorized", () => {
  const startAll = fs.readFileSync("scripts/start-all.mjs", "utf8");
  const startWithBuild = fs.readFileSync("scripts/start-with-build.mjs", "utf8");
  const mysqlHelper = fs.readFileSync("scripts/start-local-mysql.ps1", "utf8");

  for (const source of [startAll, startWithBuild]) {
    assert.match(source, /protectedPorts\s*=\s*new Set\(\[8787,\s*8087\]\)/);
    assert.match(source, /ALLOW_PROTECTED_PORT_OPERATION/);
    assert.match(source, /Use PORT=8788 for local verification/);
  }

  assert.match(mysqlHelper, /\$env:PORT\s*=\s*"8788"/);
  assert.doesNotMatch(mysqlHelper, /\$env:PORT\s*=\s*if\s*\(\$StartTunnel\)\s*\{\s*"8787"\s*\}/);
});
