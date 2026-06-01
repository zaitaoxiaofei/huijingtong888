import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStartupPageUrl,
  openStartupPage,
  resolveOpenPageCommand
} from "../scripts/open-startup-page.mjs";

test("startup page URL points at the admin login route", () => {
  assert.equal(
    buildStartupPageUrl("http://localhost:8787"),
    "http://localhost:8787/admin.html#/login"
  );
});

test("startup page opener uses native platform commands", () => {
  assert.deepEqual(resolveOpenPageCommand("http://localhost:8787/admin.html#/login", "darwin"), {
    command: "open",
    args: ["http://localhost:8787/admin.html#/login"]
  });
  assert.deepEqual(resolveOpenPageCommand("http://localhost:8787/admin.html#/login", "win32"), {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "start", "\"\"", "http://localhost:8787/admin.html#/login"]
  });
  assert.deepEqual(resolveOpenPageCommand("http://localhost:8787/admin.html#/login", "linux"), {
    command: "xdg-open",
    args: ["http://localhost:8787/admin.html#/login"]
  });
});

test("startup page opener can be disabled with OZON_OPEN_STARTUP_PAGE=0", () => {
  const opened = openStartupPage("http://localhost:8787", {
    env: { OZON_OPEN_STARTUP_PAGE: "0" },
    spawnFn() {
      throw new Error("spawn should not be called");
    }
  });

  assert.equal(opened, "");
});

test("startup page opener launches detached browser command", () => {
  const calls = [];
  const opened = openStartupPage("http://localhost:8787", {
    platform: "darwin",
    env: {},
    spawnFn(command, args, options) {
      calls.push({ command, args, options });
      return { unref() {} };
    }
  });

  assert.equal(opened, "http://localhost:8787/admin.html#/login");
  assert.deepEqual(calls, [{
    command: "open",
    args: ["http://localhost:8787/admin.html#/login"],
    options: { detached: true, stdio: "ignore" }
  }]);
});

test("startup page opener does not fail server startup when browser command fails", () => {
  const opened = openStartupPage("http://localhost:8787", {
    env: {},
    spawnFn() {
      throw new Error("open command is unavailable");
    }
  });

  assert.equal(opened, "");
});
