import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { getRoles, primaryRole, validateRoles, hasPermission, canAccessPage, roleLabels } from "../src/shared/permissions.js";
import { authorizeApiRequest } from "../src/server/authorization.js";

function allowed(roles, method, path) {
  return authorizeApiRequest({ method, _session: { role: "operator", roles } }, path.split("/").filter(Boolean)).allowed;
}

test("legacy roles migrate logically while explicit roles take precedence and unknown roles fail closed", () => {
  assert.deepEqual(getRoles({ role: "manager", roles_json: null }), ["manager"]);
  assert.deepEqual(getRoles({ role: "operator", roles_json: '["packing","procurement","packing"]' }), ["packing", "procurement"]);
  assert.deepEqual(getRoles({ role: "admin", roles: [] }), []);
  assert.deepEqual(getRoles({ role: "admin", roles_json: '[broken' }), []);
  assert.equal(hasPermission({ role: "unknown" }, "packing"), false);
  assert.throws(() => validateRoles([]), /至少选择一个/);
  assert.throws(() => validateRoles(["packing", "superuser"]), /不支持/);
});

test("roles grant the union, independent of order, with admin granting everything", () => {
  assert.equal(primaryRole(["packing", "manager"]), "manager");
  assert.equal(primaryRole(["procurement", "admin"]), "admin");
  for (const roles of [["packing", "procurement"], ["procurement", "packing"]]) {
    assert.equal(hasPermission(roles, "packing"), true);
    assert.equal(hasPermission(roles, "procurement"), true);
    assert.equal(hasPermission(roles, "operations"), false);
    assert.equal(hasPermission(roles, "inventory.review"), false);
  }
  assert.equal(hasPermission(["technical", "admin"], "arbitrary.permission"), true);
  assert.equal(roleLabels(["packing", "operations"]), "打包、运营");
});

test("packing can print and ship but cannot purchase, publish, edit inventory, approve or grant roles", () => {
  for (const [method, path] of [["GET", "/api/orders"], ["POST", "/api/orders/ship"], ["POST", "/api/orders/package-label"], ["POST", "/api/print/jobs"]]) assert.equal(allowed(["packing"], method, path), true, path);
  for (const path of ["/api/procurement/purchases", "/api/listing/drafts/batch-publish", "/api/products", "/api/people", "/api/inventory-product-naming/options/1"]) assert.equal(allowed(["packing"], "PUT", path), false, path);
  assert.equal(allowed(["packing"], "GET", "/api/finance-center/report"), false);
  assert.equal(allowed(["packing"], "GET", "/api/procurement/purchases"), false);
  assert.equal(hasPermission(["packing"], "procurement.request.submit"), true);
  assert.equal(allowed(["packing"], "POST", "/api/procurement/warehouse-requests"), true);
  assert.equal(allowed(["packing"], "POST", "/api/procurement/purchases"), false);
});

test("procurement and operations combine without granting approval or system access", () => {
  assert.equal(allowed(["procurement"], "POST", "/api/procurement/purchases"), true);
  assert.equal(allowed(["procurement"], "POST", "/api/listing/drafts"), false);
  assert.equal(allowed(["operations"], "POST", "/api/procurement/purchases"), false);
  assert.equal(allowed(["operations"], "POST", "/api/listing/drafts"), true);
  for (const path of ["/api/procurement/purchases", "/api/listing/drafts", "/api/products"]) assert.equal(allowed(["procurement", "operations"], "POST", path), true, path);
  assert.equal(allowed(["procurement", "operations"], "PUT", "/api/inventory-product-naming/options/1"), false);
  assert.equal(allowed(["procurement", "operations"], "POST", "/api/people"), false);
});

test("manager anywhere in the role list can approve and maintain names; a matching person name grants nothing", () => {
  assert.equal(hasPermission({ role: "packing", roles: ["packing", "manager"] }, "inventory.review"), true);
  assert.equal(allowed(["packing", "manager"], "PUT", "/api/inventory-product-naming/options/1"), true);
  assert.equal(allowed(["packing", "manager"], "PUT", "/api/inventory-product-requests/1"), true);
  assert.equal(authorizeApiRequest({method:"PUT",_session:{role:"operator",name:"核动力牛马"}},["api","inventory-product-naming","options","1"]).allowed,false);
});

test("technical can manage system tools but cannot assign roles, access finance or approve", () => {
  for (const path of ["/api/system-monitoring", "/api/scheduled-jobs", "/api/ai-provider/config"]) assert.equal(allowed(["technical"], "POST", path), true, path);
  for (const path of ["/api/people", "/api/finance-center", "/api/inventory-product-requests/1", "/api/listing/drafts"]) assert.equal(allowed(["technical"], "PUT", path), false, path);
  assert.equal(allowed(["technical", "admin"], "PUT", "/api/people/1"), true);
});

test("menus and direct route access follow the same combined permissions", () => {
  assert.equal(canAccessPage(["packing"], "/orders"), true);
  assert.equal(canAccessPage(["packing"], "/procurement/workspace"), false);
  assert.equal(canAccessPage(["packing", "procurement"], "/procurement/workspace"), true);
  assert.equal(canAccessPage(["technical"], "/settings/system-monitoring"), true);
  assert.equal(canAccessPage(["technical"], "/settings"), false);
  assert.equal(canAccessPage(["technical"], "/finance/payroll"), false);
  assert.equal(canAccessPage(["technical", "admin"], "/finance/payroll"), true);
  const source = readFileSync(new URL("../frontend/admin/constants/navigation.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replaceAll("export ", "");
  const icons = Object.fromEntries("ChatDotRound Coin DataAnalysis Document Finished Goods House MagicStick Setting ShoppingCart Tools WarningFilled".split(" ").map(name => [name, null]));
  const context = vm.createContext({ ...icons, canAccessPage }); vm.runInContext(source, context);
  const menus = context.navigationMenusForRole({ roles: ["technical"] });
  const paths = menus.flatMap(menu => menu.children ? menu.children.map(child => child.route) : [menu.route]);
  assert.ok(paths.includes("/settings/system-monitoring")); assert.ok(!paths.includes("/settings")); assert.ok(!paths.includes("/orders"));
});

test("existing session reads current roles from people instead of stale session role", async () => {
  const source = readFileSync(new URL("../src/services/mysql-auth-session.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replaceAll("export ", "");
  let row = { person_id: 7, name: "old", role: "admin", current_name: "采购员", current_role: "procurement", roles_json: '["procurement","packing"]', expires_at: new Date(Date.now()+60000), created_at: new Date() };
  const context = vm.createContext({ getRoles, primaryRole, isMysqlPrimaryEnabled: () => true, ensurePeopleRolesSchemaMysql: async () => {}, mysqlExecute: async () => {}, mysqlQuery: async sql => { assert.match(sql, /JOIN people p.*p.active = 1/); return row ? [row] : []; } });
  vm.runInContext(source, context);
  const session = await context.getSessionMysql("token");
  assert.equal(hasPermission(session, "admin"), false);
  assert.equal(hasPermission(session, "packing"), true);
  row.roles_json = '["procurement"]';
  assert.equal(hasPermission(await context.getSessionMysql("token"), "packing"), false);
  row = null;
  assert.equal(await context.getSessionMysql("token"), null);
});

test("person writes store all selected roles and reject malformed role payloads", () => {
  const source = readFileSync(new URL("../src/services/people-roles.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replaceAll("export ", "");
  const context = vm.createContext({ getRoles, primaryRole, validateRoles }); vm.runInContext(source, context);
  const values = context.personRoleFields({ roles: ["packing", "manager"] });
  assert.equal(values.role, "manager"); assert.equal(values.roles_json, '["packing","manager"]');
  assert.equal(context.personRoleFields({}, {role:"admin",roles_json:'["admin","technical"]'}).roles_json, '["admin","technical"]');
  assert.equal(context.personRoleFields({role:"admin"}, {role:"admin",roles_json:'["admin","technical"]'}).roles_json, '["admin","technical"]');
  assert.throws(() => context.personRoleFields({roles:[]}), /至少选择/);
  assert.throws(() => context.personRoleFields({roles:["superuser"]}), /不支持/);
});

test("packing may register manual outbound but cannot spoof an arbitrary inventory adjustment", async () => {
  const { createOperationsRoutes } = await import("../src/server/routes/operations.js");
  let payload = {source_type:"manual_outbound", product_id:1, quantity:2}; let writes = 0;
  const routes = createOperationsRoutes({readJson:async()=>payload,services:{createInventoryMovement:async()=>{writes++;return {id:1};}}});
  const req = {_session:{roles:["packing"],personId:7}};
  assert.equal((await routes["POST /api/inventory/movements"](req)).id,1);
  payload={movement_type:"ADJUSTMENT",quantity_delta:999};
  await assert.rejects(routes["POST /api/inventory/movements"](req),/仅可登记手动出库/);
  assert.equal(writes,1);
});

test("person create and update SQL preserve the selected role combination", async () => {
  const cutover = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url),"utf8");
  const roleSource = readFileSync(new URL("../src/services/people-roles.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replaceAll("export ", "");
  const roleContext = vm.createContext({getRoles,primaryRole,validateRoles}); vm.runInContext(roleSource,roleContext);
  const writes=[];
  const context=vm.createContext({ensureMysqlCutoverEnabled(){},ensurePeopleTimestampSchemaMysql:async()=>{},ensurePeopleRolesSchemaMysql:async()=>{},personRoleFields:roleContext.personRoleFields,
    mysqlExecute:async(sql,params)=>{writes.push({sql,params});return {insertId:7};},mysqlQueryOne:async()=>({id:7,role:"operator",updated_at:"v1"}),assertFreshRecord(){},invalidateMasterDataCache(){},destroySessionsByPersonIdMysql:async()=>{}});
  const start=cutover.indexOf("export async function createPersonMysql"),end=cutover.indexOf("export async function deletePersonMysql",start);
  vm.runInContext(cutover.slice(start,end).replaceAll("export ",""),context);
  await context.createPersonMysql({name:"岗位人员",roles:["packing","procurement"],password:"Valid-Password"},()=>"hashed",()=>{});
  assert.match(writes[0].sql,/role, roles_json/);assert.equal(writes[0].params[3],'["packing","procurement"]');
  await context.updatePersonMysql(7,{name:"岗位人员",roles:["packing","manager"]},()=>"hashed",()=>{});
  assert.equal(writes[1].params[2],"manager");assert.equal(writes[1].params[3],'["packing","manager"]');
  await assert.rejects(context.updatePersonMysql(7,{name:"岗位人员",roles:["admin"],password:"weak"},()=>"hashed",()=>{throw new Error("密码不符合要求");}),/密码不符合要求/);
  assert.equal(writes.length,2);
});
