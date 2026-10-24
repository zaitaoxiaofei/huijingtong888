import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("explicit empty environment credentials never inherit a local dotenv credential", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-config-explicit-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, ".env"), "DB_PASSWORD=fixture-file-value\nCONFIG_FIXTURE_ONLY=from-file\n", "utf8");
  const moduleUrl = new URL("../src/config.js", import.meta.url).href;
  const script = `const {config}=await import(${JSON.stringify(moduleUrl)});if(config.dbPassword!==''||process.env.CONFIG_FIXTURE_ONLY!=='from-file')process.exit(2);`;
  const environment = { ...process.env, DB_CLIENT: "mysql", DB_HOST: "localhost", DB_NAME: "isolated_config_fixture", DB_USER: "root", DB_PASSWORD: "" };
  delete environment.CONFIG_FIXTURE_ONLY;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: directory, env: environment, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, "The explicit blank password must win; absent variables may come from .env");
});
