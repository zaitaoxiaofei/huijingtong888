import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");

test("exception workbench reuses one filtered base across page sizes", () => {
  const keySource = source.match(/function exceptionWorkbenchCacheKeyMysql[\s\S]*?return `exception-workbench:[\s\S]*?\n}/)?.[0] || "";
  assert.doesNotMatch(keySource, /"page"|"pageSize"|"page_size"/);
  assert.match(source, /buildExceptionWorkbenchMysql\(\{ \.\.\.query, _unpaged: true }\)/);
  assert.match(source, /return paginateExceptionWorkbenchMysql\(basePayload, query\)/);
  assert.match(source, /rows: allRows\.slice\(start, start \+ pageSize\)/);
  assert.match(source, /pageSize: 300/);
});
