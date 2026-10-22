import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import mysql from "mysql2/promise";
import { preparePeopleAccountKind } from "../src/services/people-account-kind.js";
import { ACCOUNT_KIND_AUDIT_SQL, applyAccountKindReview } from "../scripts/lib/people-account-kind-review.mjs";

test("reviewed account kinds preserve business identities and roll back classification and session changes together", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires an explicitly isolated MySQL socket", timeout: 30000
}, async () => {
  const database = `ozon_account_kind_test_${randomBytes(8).toString("hex")}`;
  const connection = await mysql.createConnection({ socketPath: process.env.TENANT_TEST_MYSQL_SOCKET, user: "root" });
  let created = false;
  try {
    await connection.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`); created = true;
    await connection.changeUser({ database });
    const query = async (sql, params = []) => (await connection.execute(sql, params))[0];
    for (const sql of [
      "CREATE TABLE people (id BIGINT PRIMARY KEY, name VARCHAR(64), username VARCHAR(64), active TINYINT DEFAULT 1)",
      "CREATE TABLE platform_grants (person_id BIGINT, role VARCHAR(32), active TINYINT)",
      "CREATE TABLE tenant_members (tenant_id BIGINT, person_id BIGINT, role VARCHAR(32), active TINYINT)",
      "CREATE TABLE sessions (id VARCHAR(64) PRIMARY KEY, person_id BIGINT)",
      "INSERT INTO people VALUES (1,'Reviewer','reviewer',1),(20,'Automation','job',1),(21,'Real colleague','e2e',1)",
      "INSERT INTO platform_grants VALUES (1,'super_admin',1)",
      "INSERT INTO tenant_members VALUES (1,20,'member',1),(2,20,'member',1),(1,21,'member',1)",
      "INSERT INTO sessions VALUES ('system-session',20),('real-session',21)"
    ]) await query(sql);
    await preparePeopleAccountKind(query); await preparePeopleAccountKind(query); await query(ACCOUNT_KIND_AUDIT_SQL);
    assert.deepEqual((await query("SELECT account_kind FROM people ORDER BY id")).map(row => row.account_kind), ["person", "person", "person"]);
    const review = { version: 1, reviewed_by_person_id: 1, reason: "Verified fixture automation identity", accounts: [{ person_id: 20, expected_account_kind: "person", account_kind: "system" }] };
    async function apply(manifest) {
      await connection.beginTransaction();
      try { const result = await applyAccountKindReview(connection, manifest); await connection.commit(); return result; }
      catch (error) { await connection.rollback(); throw error; }
    }
    await assert.rejects(apply({ ...review, accounts: [...review.accounts, { person_id: 21, expected_account_kind: "system", account_kind: "person" }] }), /expected kind changed/);
    assert.equal((await query("SELECT account_kind FROM people WHERE id=20"))[0].account_kind, "person");
    assert.equal((await query("SELECT COUNT(*) AS n FROM sessions"))[0].n, 2);
    assert.deepEqual(await apply(review), { changed_person_ids: [20], revoked_sessions: 1 });
    assert.equal((await query("SELECT account_kind FROM people WHERE id=21"))[0].account_kind, "person", "a system-looking username is preserved as a real colleague");
    assert.equal((await query("SELECT COUNT(*) AS n FROM tenant_members"))[0].n, 3);
    assert.equal((await query("SELECT COUNT(*) AS n FROM platform_grants"))[0].n, 1);
    assert.equal((await query("SELECT COUNT(*) AS n FROM people_account_kind_audit"))[0].n, 1);
    assert.deepEqual((await query("SELECT person_id FROM sessions")).map(row => row.person_id), [21]);
    await query("INSERT INTO sessions VALUES ('restored-automation-session',20)");
    await connection.query("CREATE TRIGGER reject_kind_audit BEFORE INSERT ON people_account_kind_audit FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fixture audit failure'");
    await assert.rejects(apply({ ...review, accounts: [{ person_id: 20, expected_account_kind: "system", account_kind: "person" }] }), /fixture audit failure/);
    assert.equal((await query("SELECT account_kind FROM people WHERE id=20"))[0].account_kind, "system");
    assert.equal((await query("SELECT COUNT(*) AS n FROM sessions WHERE person_id=20"))[0].n, 1);
  } finally {
    if (created) await connection.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await connection.end();
  }
});
