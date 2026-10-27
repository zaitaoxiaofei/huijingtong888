import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { planReleaseDatabase } from "../scripts/plan-release-database.mjs";

async function fixture(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "release-db-plan-"));
  try {
    await fs.mkdir(path.join(root, "scripts"));
    for (const name of ["migrate-listing-frozen-content.mjs", "migrate-order-profit-calculation-versions.mjs"]) {
      await fs.writeFile(path.join(root, "scripts", name), "fixture");
    }
    await callback(root);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("installed schemas are inspected without running apply or scanning profit business rows", async () => {
  await fixture(async root => {
    const calls = [];
    const plan = await planReleaseDatabase({ root, database: "fixture_db", socketPath: path.join(root, "mysql.sock"),
      run: async (executable, args, options) => {
        calls.push({ executable, args, options });
        return { stdout: JSON.stringify({ mode: "dry-run", table_exists: true, changes_database: false }) };
      },
      inspectProfit: async options => { assert.equal(options.database, "fixture_db"); return { missing_tables: [] }; },
    });
    assert.deepEqual(plan.pending_migrations, []);
    assert.equal(plan.checked_migrations.length, 2);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(1), ["--database=fixture_db", `--mysql-admin-socket=${path.join(root, "mysql.sock")}`]);
    assert.equal(calls[0].options.env.DB_NAME, "fixture_db");
    assert.equal(calls[0].options.cwd, root);
    assert.ok(calls[0].options.timeout <= 60000);
  });
});

test("a missing table is pending even though its inspection reports changes_database false", async () => {
  await fixture(async root => {
    const plan = await planReleaseDatabase({ root, database: "fixture_db", socketPath: path.join(root, "mysql.sock"),
      run: async () => ({ stdout: JSON.stringify({ mode: "dry-run", table_exists: false, changes_database: false }) }),
      inspectProfit: async () => ({ missing_tables: ["order_profit_calc_revisions"] }),
    });
    assert.deepEqual(plan.pending_migrations, ["migrate-listing-frozen-content.mjs", "migrate-order-profit-calculation-versions.mjs"]);
  });
});

test("a failed or malformed inspection aborts the plan and redacts raw database output", async () => {
  await fixture(async root => {
    for (const run of [async () => ({ stdout: "PRIVATE_DATABASE_CONTENT" }), async () => { throw Error("PRIVATE_DATABASE_CONTENT"); }]) {
      let profitReached = false;
      await assert.rejects(planReleaseDatabase({ root, database: "fixture_db", socketPath: path.join(root, "mysql.sock"), run,
        inspectProfit: async () => { profitReached = true; return { missing_tables: [] }; },
      }), error => error.message.includes("migrate-listing-frozen-content.mjs") && !error.message.includes("PRIVATE_DATABASE_CONTENT"));
      assert.equal(profitReached, false);
    }
  });
});

test("missing explicit database or administrator socket is rejected before executing a probe", async () => {
  let called = false;
  await assert.rejects(planReleaseDatabase({ root: process.cwd(), database: "fixture_db", socketPath: "relative.sock",
    run: async () => { called = true; },
  }), /Explicit database/);
  assert.equal(called, false);
});

test("a current-release directory link still executes guarded migration CLI entry points", async () => {
  await fixture(async root => {
    const alias = path.join(root, "current");
    await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    await fs.writeFile(path.join(root, "scripts", "migrate-listing-frozen-content.mjs"), `
      import {pathToFileURL} from 'node:url';
      if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify({mode:'dry-run',table_exists:true,changes_database:false}));
    `);
    const plan = await planReleaseDatabase({ root: alias, database: "fixture_db", socketPath: path.join(root, "mysql.sock"),
      inspectProfit: async () => ({ missing_tables: [] }),
    });
    assert.deepEqual(plan.pending_migrations, []);
    assert.equal(plan.checked_migrations.length, 2);
  });
});
