import assert from "node:assert/strict";
import test from "node:test";

import { executeMysqlStatementWithRetry } from "../src/mysql-pool.js";

test("single MySQL writes retry deadlock victims", async () => {
  let attempts = 0;
  const delays = [];
  const connection = {
    async execute() {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("Deadlock found when trying to get lock");
        error.code = "ER_LOCK_DEADLOCK";
        throw error;
      }
      return [{ affectedRows: 1 }];
    }
  };

  const result = await executeMysqlStatementWithRetry(connection, "UPDATE example SET value = 1", [], {
    sleepImpl: async (ms) => delays.push(ms)
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [100, 200]);
  assert.equal(result.affectedRows, 1);
});

test("single MySQL writes do not retry unrelated errors", async () => {
  let attempts = 0;
  const expected = Object.assign(new Error("bad data"), { code: "ER_BAD_NULL_ERROR" });
  const connection = {
    async execute() {
      attempts += 1;
      throw expected;
    }
  };

  await assert.rejects(
    executeMysqlStatementWithRetry(connection, "INSERT INTO example VALUES (?)", [null], { sleepImpl: async () => {} }),
    expected
  );
  assert.equal(attempts, 1);
});
