import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("all order sync entry points allow long-running imports", async () => {
  const source = await readFile(new URL("../frontend/orders/composables/useOrdersPage.js", import.meta.url), "utf8");

  assert.match(source, /runOrderSync\(url, body, messages, \{ timeoutMs = 30 \* 60 \* 1000 \} = \{\}\)/);
  assert.match(source, /runOrderSync\("\/api\/sync\/ozon", body,[\s\S]*?\{ timeoutMs: 30 \* 60 \* 1000 \}\)/);
  assert.match(source, /const taskId = String\(started\?\.task_id \|\| ""\)/);
  assert.match(source, /cache: "no-store"/);
  assert.match(source, /status\?\.task_id/);
  assert.match(source, /task\?\.result \? \{ \.\.\.task, \.\.\.task\.result \} : task/);
  assert.match(source, /本次同步超过 \$\{timeoutMinutes\} 分钟/);
  assert.doesNotMatch(source, /本次同步超过 5 分钟/);
});
