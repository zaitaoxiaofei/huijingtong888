import assert from "node:assert/strict";
import test from "node:test";
import { runEnterpriseMessagesMigration } from "../scripts/migrate-enterprise-messages.mjs";

test("administrator dry-run inspects the explicit socket and database without application credentials or writes", async () => {
  const statements = [];
  let options, ended = 0;
  const report = await runEnterpriseMessagesMigration({ socketPath: "/isolated/mysql.sock", database: "isolated_release_plan", createConnection: async value => {
    options = value;
    return {
      query: async sql => { statements.push(sql); return [[], []]; },
      end: async () => { ended++; }
    };
  } });
  assert.deepEqual(options, { socketPath: "/isolated/mysql.sock", user: "root", database: "isolated_release_plan" });
  assert.deepEqual(statements, ["SHOW TABLES LIKE 'enterprise_direct_messages'", "SHOW FULL COLUMNS FROM people LIKE 'account_kind'"]);
  assert.deepEqual(report, { mode: "dry-run", changes_database: false, exists: false, ready: false, account_kind: { exists: false, ready: false } });
  assert.equal(ended, 1);
});

test("a failed administrator inspection closes its dedicated connection", async () => {
  let ended = 0;
  await assert.rejects(runEnterpriseMessagesMigration({ socketPath: "/isolated/mysql.sock", database: "isolated_release_plan", createConnection: async () => ({
    query: async () => { throw new Error("fixture metadata unavailable"); },
    end: async () => { ended++; }
  }) }), /fixture metadata unavailable/);
  assert.equal(ended, 1);
});

test("invalid target and apply without a local administrator socket cannot open a connection", async () => {
  const createConnection = async () => { throw new Error("must not connect"); };
  await assert.rejects(runEnterpriseMessagesMigration({ database: "bad target", socketPath: "/isolated/mysql.sock", createConnection }), /valid database/);
  await assert.rejects(runEnterpriseMessagesMigration({ apply: true, database: "isolated_release_plan", createConnection }), /explicit local/);
});
