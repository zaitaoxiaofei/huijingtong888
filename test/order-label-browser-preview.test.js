import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("order label browser preview bypasses server rasterization", () => {
  const frontend = fs.readFileSync(path.join(root, "frontend", "orders", "services", "orders-service.js"), "utf8");
  const route = fs.readFileSync(path.join(root, "src", "server", "routes", "orders.js"), "utf8");

  assert.match(frontend, /order_ids:\s*printIds,[\s\S]*?browser_preview:\s*true/);
  assert.match(route, /body\.browser_preview === true\s*\? label\.buffer\s*:\s*await serverTransformPdfForPaper/);
});

test("order label PDF merge follows the requested order id sequence", () => {
  const service = fs.readFileSync(path.join(root, "src", "services", "mysql-cutover.js"), "utf8");

  assert.match(service, /sortRowsByInputMysql\(rawRows, ids, "id"\)/);
  assert.match(service, /for \(const row of rows\)/);
  assert.match(service, /mergePdfBuffersMysql\(orderedResults\.map\(\(item\) => item\.buffer\)\)/);
});

test("batch label preview reverses the selected order sequence for convenient tearing", () => {
  const frontendService = fs.readFileSync(path.join(root, "frontend", "orders", "services", "orders-service.js"), "utf8");

  assert.match(frontendService, /const printIds = ids\.length > 1 \? \[\.\.\.ids\]\.reverse\(\) : ids/);
  assert.match(frontendService, /order_ids:\s*printIds/);
  assert.match(frontendService, /orderIds:\s*printedIds\.length \? printedIds : printIds/);
});
