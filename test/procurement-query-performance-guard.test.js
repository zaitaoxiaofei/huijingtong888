import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");

test("grouped procurement pages select product ids before loading detail joins", () => {
  assert.match(source, /await procurementGroupedPageIdsMysql\(query\)/);
  assert.match(source, /WHERE pr\.product_id IN \(/);
  assert.match(source, /MAX\(pr\.created_at\) AS latest_created_at/);
  assert.match(source, /ORDER BY latest_created_at DESC, product_id DESC LIMIT \? OFFSET \?/);
  assert.match(source, /SELECT COUNT\(\*\) AS total FROM \(\$\{groupedSql\}\) grouped_procurement/);
});

test("dashboard procurement alerts use the compact request projection", () => {
  assert.match(source, /const compact = String\(query\.compact \|\| ""\) === "1"/);
  assert.match(source, /const requestColumns = compact[\s\S]*?: "pr\.\*"/);
  assert.match(source, /\$\{compact \? "''" : "p\.image_url"\} AS product_image_url/);
  assert.match(source, /procurementRequestsMysql\(\{ grouped: "1", paged: "1", compact: "1", page: 1, pageSize: 8 \}\)/);
  assert.match(source, /const procurementRows = \(procurement\.rows \|\| \[\]\)\.map\(\(item\) => \(\{[\s\S]*?product_name: item\.product_name \|\| ""[\s\S]*?overdue: Boolean\(item\.overdue\)/);
});

test("procurement details and inbound lists sort by latest activity", () => {
  assert.match(source, /ORDER BY COALESCE\(pr\.updated_at, pr\.created_at\) DESC, pr\.created_at DESC, pr\.id DESC/);
  assert.match(source, /await ensureInboundRecordTimestampSchemaMysql\(\)/);
  assert.match(source, /ORDER BY COALESCE\(ir\.updated_at, ir\.created_at\) DESC, ir\.created_at DESC, ir\.id DESC/);
});
