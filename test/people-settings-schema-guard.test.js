import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mysqlCutoverSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const initMysqlSchemaSource = readFileSync(new URL("../scripts/init-mysql-schema.mjs", import.meta.url), "utf8");

test("people management ensures timestamp columns before reading or mutating people", () => {
  assert.match(mysqlCutoverSource, /async function ensurePeopleTimestampSchemaMysql\(\)/);
  assert.match(mysqlCutoverSource, /ALTER TABLE people ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP/);
  assert.match(mysqlCutoverSource, /export async function peopleMysql\(\) \{[\s\S]*?await ensurePeopleTimestampSchemaMysql\(\);/);
  assert.match(mysqlCutoverSource, /export async function createPersonMysql[\s\S]*?await ensurePeopleTimestampSchemaMysql\(\);/);
  assert.match(mysqlCutoverSource, /export async function updatePersonMysql[\s\S]*?await ensurePeopleTimestampSchemaMysql\(\);/);
  assert.match(mysqlCutoverSource, /UPDATE people SET name = \?, username = \?, role = \?, active = \?, updated_at = CURRENT_TIMESTAMP WHERE id = \?/);
});

test("fresh MySQL schema creates people.updated_at", () => {
  assert.match(initMysqlSchemaSource, /CREATE TABLE IF NOT EXISTS people \([\s\S]*updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP/);
  assert.match(initMysqlSchemaSource, /ALTER TABLE people ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP/);
});
