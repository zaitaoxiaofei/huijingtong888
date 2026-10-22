import assert from "node:assert/strict";
import test from "node:test";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";
import { migrateTenantTeamTasks, TEAM_TENANT_TABLES } from "../scripts/migrate-tenant-team-tasks.mjs";

const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;
const session = id => ({ personId: 7, tenant: { id, slug: id === 1 ? "default" : `enterprise-${id}` } });

test("real task center isolates tasks, development records, people, products and operational statistics", {
  skip: !socketPath && "Requires the isolated TENANT_TEST_MYSQL_SOCKET"
}, async t => {
  const fixture = await createTenantMysqlFixture("team");
  let closeMysqlPool;
  try {
    fixture.useEnvironment();
    const query = fixture.query;
    const tenantColumns = await query("SHOW COLUMNS FROM tenants");
    if (!tenantColumns.some(column=>column.Field==="subscription_status")) await query("ALTER TABLE tenants ADD COLUMN subscription_status VARCHAR(32) NOT NULL DEFAULT 'active'");
    if (!tenantColumns.some(column=>column.Field==="subscription_expires_at")) await query("ALTER TABLE tenants ADD COLUMN subscription_expires_at DATETIME NULL");
    await query("INSERT INTO tenants (id, slug, name) VALUES (1, 'default', 'Default'), (2, 'enterprise-2', 'A'), (3, 'enterprise-3', 'B')");
    await query("INSERT INTO people (id, name, role) VALUES (7, 'Shared operator', 'operations'), (20, 'A owner', 'operations'), (30, 'B owner', 'operations')");
    await query("INSERT INTO tenant_members (tenant_id, person_id, business_roles_json) VALUES (1, 7, JSON_ARRAY('operations')), (2, 7, JSON_ARRAY('operations')), (3, 7, JSON_ARRAY('operations')), (2, 20, JSON_ARRAY('operations')), (3, 30, JSON_ARRAY('operations'))");
    await query("INSERT INTO shops (id, tenant_id, name) VALUES (10, NULL, 'Legacy'), (11, 1, 'Default'), (20, 2, 'A'), (30, 3, 'B')");
    await query("INSERT INTO products (id, tenant_id, name, inventory_category, product_type) VALUES (100, NULL, 'Legacy', 'DefaultCategory', 'main'), (110, 1, 'Default', 'DefaultCategory', 'main'), (200, 2, 'A', 'ACategory', 'main'), (300, 3, 'B', 'BCategory', 'main')");
    ({ closeMysqlPool } = await import("../src/mysql-pool.js"));
    const listing = await import("../src/services/listing-automation.js");
    await listing.ensureListingAutomationSchema();
    const team = await import("../src/services/team-tasks.js");
    const { withTeamTenantSession } = await import("../src/services/team-task-tenant.js");
    const inTenant = (id, operation) => withTeamTenantSession(session(id), operation);
    const tasks = new Map(), projects = new Map(), candidates = new Map(), ideas = new Map();
    await query("CREATE TABLE IF NOT EXISTS product_components (product_id BIGINT, component_product_id BIGINT, quantity DECIMAL(18,4), active TINYINT DEFAULT 1)");
    for (const [key, id] of [["admin", 1001], ["2", 2001], ["3", 3001]]) {
      await query("INSERT INTO listing_drafts (id, tenant_id, template_id, product_name, status, created_by_person_id, template_payload_json, manual_facts_json, source_images_json, source_urls_json, ai_payload_json) VALUES (?, ?, 0, ?, 'draft', 7, '{}', '{}', '[]', '[]', '{}')", [id, key, `Draft ${key}`]);
    }

    await t.test("A/B/default task CRUD ignores client tenant/actor and rejects foreign references", async () => {
      for (const id of [1, 2, 3]) {
        const created = await inTenant(id, () => team.createTeamTaskMysql({ title: `Task ${id}`, type: "custom", tenant_id: "3", owner_person_id: 7 }, 30));
        tasks.set(id, created.id);
        const [row] = await query("SELECT tenant_id, created_by_person_id FROM team_tasks WHERE id=?", [created.id]);
        assert.equal(row.tenant_id, id === 1 ? "admin" : String(id));
        assert.equal(row.created_by_person_id, 7);
      }
      for (const id of [1, 2]) {
        await assert.rejects(inTenant(id, () => team.updateTeamTaskMysql(tasks.get(3), { title: "foreign" })), /任务不存在/);
        await assert.rejects(inTenant(id, () => team.deleteTeamTaskMysql(tasks.get(3))), { statusCode: 404 });
        await assert.rejects(inTenant(id, () => team.createTeamTaskMysql({ title: "foreign owner", owner_person_id: 30 })), /不存在或已停用/);
      }
      await inTenant(2, () => team.updateTeamTaskMysql(tasks.get(2), { title: "Updated A", type: "custom", owner_person_id: 20 }));
      assert.equal((await query("SELECT title FROM team_tasks WHERE id=?", [tasks.get(2)]))[0].title, "Updated A");
      assert.equal((await query("SELECT title FROM team_tasks WHERE id=?", [tasks.get(3)]))[0].title, "Task 3");
    });

    await t.test("projects and candidates read/write only current enterprise and owned products", async () => {
      for (const id of [1, 2, 3]) {
        const project = await inTenant(id, () => team.createDevelopmentProjectMysql({ name: `Project ${id}`, owner_person_id: 7 }, 30));
        projects.set(id, project.id);
        const candidate = await inTenant(id, () => team.createDevelopmentCandidateMysql({ title: `Candidate ${id}`, product_id: id * 100, project_id: project.id }, 30));
        candidates.set(id, candidate.id);
        assert.deepEqual((await inTenant(id, () => team.developmentProjectsMysql())).map(row => row.name), [`Project ${id}`]);
        assert.deepEqual((await inTenant(id, () => team.developmentCandidatesMysql())).map(row => row.product_id), [id * 100]);
      }
      for (const id of [1, 2]) {
        await assert.rejects(inTenant(id, () => team.updateDevelopmentProjectMysql(projects.get(3), { name: "foreign" })), { statusCode: 404 });
        await assert.rejects(inTenant(id, () => team.deleteDevelopmentCandidateMysql(candidates.get(3))), { statusCode: 404 });
        await assert.rejects(inTenant(id, () => team.createDevelopmentCandidateMysql({ title: "foreign product", product_id: 300 })), /不存在或已停用/);
        await assert.rejects(inTenant(id, () => team.updateDevelopmentCandidateMysql(candidates.get(id), { title: "foreign ref", product_id: 300 })), { statusCode: 404 });
        await assert.rejects(inTenant(id, () => team.createTeamTaskMysql({ title: "foreign project", project_id: projects.get(3) })), { statusCode: 404 });
      }
      await inTenant(2, () => team.updateDevelopmentProjectMysql(projects.get(2), { name: "A renamed" }));
      await inTenant(2, () => team.updateDevelopmentCandidateMysql(candidates.get(2), { title: "A candidate renamed", product_id: 200, project_id: projects.get(2) }));
    });

    await t.test("ideas, their product/draft links, and default inventory categories stay private", async () => {
      for (const id of [1, 2, 3]) {
        const idea = await inTenant(id, () => team.createDevelopmentIdeaMysql({ title: `Idea ${id}`, assignee_person_id: 7, development_brand: "非汽车", development_category: ["", "DefaultCategory", "ACategory", "BCategory"][id] }, 30));
        ideas.set(id, idea.id);
        await inTenant(id, () => team.linkDevelopmentIdeaDraftMysql(idea.id, { draft_id: id * 1000 + 1 }));
        await inTenant(id, () => team.linkDevelopmentIdeaMysql(idea.id, { product_id: id * 100 }, 30));
        const rows = await inTenant(id, () => team.developmentIdeasMysql({ include_tasks: "0" }));
        assert.deepEqual(rows.map(row => row.title), [`Idea ${id}`]);
        assert.deepEqual(rows[0].drafts.map(row => row.id), [id * 1000 + 1]);
      }
      for (const id of [1, 2]) {
        await assert.rejects(inTenant(id, () => team.linkDevelopmentIdeaDraftMysql(ideas.get(id), { draft_id: 3001 })), /不存在或已删除/);
        await assert.rejects(inTenant(id, () => team.linkDevelopmentIdeaMysql(ideas.get(id), { product_id: 300 })), /不存在或已停用/);
        await assert.rejects(inTenant(id, () => team.deleteDevelopmentIdeaMysql(ideas.get(3))), { statusCode: 404 });
        await assert.rejects(inTenant(id, () => team.claimDevelopmentIdeaMysql(ideas.get(3), 30)), /不存在/);
        const categories = await inTenant(id, () => team.developmentInventoryCategoriesMysql());
        assert.deepEqual(categories.map(row => row.name), [id === 1 ? "DefaultCategory" : "ACategory"]);
      }
    });

    await t.test("owners, heatmap coordinates and priority writes cannot collide across enterprises", async () => {
      for (const id of [1, 2, 3]) {
        await inTenant(id, () => team.setTeamOperationalOwnerMysql({ type: "shipping_daily", owner_person_id: 7 }));
        await inTenant(id, () => team.saveDevelopmentHeatmapOrdersMysql({ period_key: "month:2026-10", dimension: "brand", entries: [{ coordinate_key: '["a","b","c","d"]', sequence: id, marked: true }] }, 30));
      }
      for (const id of [1, 2, 3]) {
        const rows = await inTenant(id, () => team.developmentHeatmapOrdersMysql({ period_key: "month:2026-10" }));
        assert.equal(rows[0].sequence, id);
        assert.equal((await inTenant(id, () => team.teamOperationalOwnersMysql())).rows.length, 2);
      }
      await query("UPDATE team_tasks SET work_type='product_development' WHERE id=?", [tasks.get(3)]);
      await assert.rejects(inTenant(1, () => team.updateDevelopmentTaskPriorityMysql({ task_ids: [tasks.get(3)], priority: "high" })), /部分开发任务/);
      await inTenant(3, () => team.updateDevelopmentTaskPriorityMysql({ task_ids: [tasks.get(3)], priority: "high" }));
      await assert.rejects(inTenant(2, () => team.setTeamOperationalOwnerMysql({ type: "shipping_daily", owner_person_id: 30 })), /不存在或已停用/);
      assert.equal((await query("SELECT COUNT(DISTINCT tenant_id) AS n FROM product_development_heatmap_orders"))[0].n, 3);
    });

    await t.test("daily auto tasks and operational order details count only current enterprise shops", async () => {
      for (const [id, shops] of [[1, [10, 11]], [2, [20]], [3, [30]]]) {
        for (const shop of shops) {
          await query("INSERT INTO orders (id, shop_id, posting_number, status, ordered_at) VALUES (?, ?, ?, 'awaiting_packaging', DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 DAY))", [shop, shop, `order-${shop}`]);
          await query("INSERT INTO order_items (id, order_id, ozon_sku, quantity) VALUES (?, ?, ?, 1)", [shop, shop, `sku-${shop}`]);
          await query("INSERT INTO procurement_requests (tenant_id, source_order_id, source_order_item_id, product_id, raw_name, quantity, status) VALUES (?, ?, ?, ?, ?, 1, 'pending')", [id, shop, shop, id * 100, `request-${shop}`]);
        }
        await inTenant(id, () => team.warmTeamTasksRuntimeMysql());
        const rows = await inTenant(id, () => team.teamTasksMysql());
        const shipping = rows.find(row => row.type === "shipping_daily");
        assert.ok(shipping, JSON.stringify(rows));
        assert.equal(shipping.target, shops.length);
        const detail = await inTenant(id, () => team.teamTaskOperationalDetailsMysql(shipping.id));
        assert.deepEqual(detail.rows.map(row => row.order_id).sort(), shops);
        const procurement = rows.find(row => row.type === "procurement_daily");
        assert.equal(procurement.target, shops.length);
        const procurementDetail = await inTenant(id, () => team.teamTaskOperationalDetailsMysql(procurement.id));
        assert.deepEqual(procurementDetail.rows.map(row => row.order_id).sort(), shops);
      }
      const foreignTask = (await query("SELECT id FROM team_tasks WHERE tenant_id='3' AND work_type='shipping_daily'"))[0].id;
      await assert.rejects(inTenant(1, () => team.teamTaskOperationalDetailsMysql(foreignTask)), /任务不存在/);
    });

    await t.test("migration dry-run is read-only and compound keys are verified on repeat apply", async () => {
      const preview = await migrateTenantTeamTasks(fixture.connection);
      assert.equal(preview.tables.filter(row => row.exists).length, 9);
      await migrateTenantTeamTasks(fixture.connection, { apply: true });
      await migrateTenantTeamTasks(fixture.connection, { apply: true });
      for (const [table] of TEAM_TENANT_TABLES) assert.ok((await query(`SHOW COLUMNS FROM ${table}`)).some(row => row.Field === "tenant_id"));
    });

    await t.test("missing, revoked and expired memberships cannot establish task context", async () => {
      await assert.rejects(team.teamTasksMysql(), { statusCode: 403 });
      await assert.rejects(withTeamTenantSession(null, () => team.teamTasksMysql()), { statusCode: 403 });
      await query("UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=7");
      await assert.rejects(inTenant(2, () => team.teamTasksMysql()), { statusCode: 403 });
      await query("UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=7");
      await query("UPDATE tenants SET subscription_expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 DAY) WHERE id=2");
      await assert.rejects(inTenant(2, () => team.teamTasksMysql()), { statusCode: 403 });
    });
  } finally {
    if (closeMysqlPool) await closeMysqlPool();
    await fixture.cleanup();
  }
});
