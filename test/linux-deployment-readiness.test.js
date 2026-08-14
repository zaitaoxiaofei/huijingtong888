import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const packageSource = fs.readFileSync(new URL("../scripts/package-deploy.mjs", import.meta.url), "utf8");
const service = fs.readFileSync(new URL("../deploy/linux/ozon-erp.service.example", import.meta.url), "utf8");
const nginx = fs.readFileSync(new URL("../deploy/linux/nginx-ozon-erp.conf.example", import.meta.url), "utf8");
const envExample = fs.readFileSync(new URL("../deploy/linux/ozon-erp.env.example", import.meta.url), "utf8");
const mysqlSchema = fs.readFileSync(new URL("../scripts/init-mysql-schema.mjs", import.meta.url), "utf8");
const listingAutomation = fs.readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");

test("deployment artifacts exclude real environment secrets by default", () => {
  assert.match(packageSource, /OZON_DEPLOY_INCLUDE_ENV === "1"/);
  assert.match(packageSource, /if \(includeEnv\) filesToCopy\.unshift\("\.env"\)/);
  assert.doesNotMatch(packageSource, /const filesToCopy = \[\s*"\.env"/);
});

test("deployment artifacts include database initialization scripts", () => {
  assert.match(packageSource, /const directoriesToCopy = \[[\s\S]*"scripts"/);
  assert.match(packageSource, /const managedDeployPaths = \[[\s\S]*"scripts"/);
});

test("fresh MySQL schema indexes reference columns in their owning tables", () => {
  assert.match(mysqlSchema, /CREATE TABLE IF NOT EXISTS shops[\s\S]*KEY idx_shops_user_id \(user_id\)/);
  assert.match(mysqlSchema, /CREATE TABLE IF NOT EXISTS system_setting_changes[\s\S]*KEY idx_system_setting_changes_person \(updated_by_person_id\)/);
  assert.doesNotMatch(mysqlSchema, /CREATE TABLE IF NOT EXISTS system_setting_changes[\s\S]{0,500}idx_shops_user_id/);
});

test("listing automation can create drafts in a fresh database", () => {
  assert.match(listingAutomation, /CREATE TABLE IF NOT EXISTS listing_drafts[\s\S]*created_by_person_id BIGINT NULL[\s\S]*idx_listing_drafts_owner_status \(created_by_person_id, status, updated_at\)/);
});

test("Linux service is memory-bounded and only starts the packaged server", () => {
  assert.match(service, /NODE_OPTIONS=--max-old-space-size=768/);
  assert.match(service, /ExecStart=\/usr\/bin\/node src\/server\.js/);
  assert.match(service, /EnvironmentFile=\/etc\/ozon-erp\/ozon-erp\.env/);
});

test("Nginx proxies to a loopback-only application port", () => {
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:3000/);
  assert.match(envExample, /HOST=127\.0\.0\.1/);
  assert.match(envExample, /DB_POOL_MAX=10/);
  assert.match(envExample, /SCHEDULED_JOBS_ENABLED=false/);
});
