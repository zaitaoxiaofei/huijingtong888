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
