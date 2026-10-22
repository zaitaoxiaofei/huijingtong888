import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const page = readFileSync(new URL("../frontend/admin/views/selection/SelectionView.vue", import.meta.url), "utf8");
test("selection business picker uses the filtered enterprise people contract and retains owner IDs", async () => {
  const requests = [], state = { people: [], suppliers: [], logisticsRules: [] };
  const context = vm.createContext({ state, normalizePagedRows: rows => rows, ElMessage: { warning: message => assert.fail(message) }, apiClient: {
    get: async url => {
      requests.push(url);
      if (url === "/api/people") return [{ id: 12, name: "Real colleague", active: 1 }, { id: 13, name: "Disabled", active: 0 }];
      return [];
    }
  } });
  vm.runInContext(page.slice(page.indexOf("async function loadSelectionMetaData("), page.indexOf("async function refreshSelectionSummary(")), context);
  assert.equal(await context.loadSelectionMetaData(), true);
  assert.deepEqual(Array.from(state.people, person => person.id), [12]);
  assert.ok(requests.includes("/api/people"));
  assert.ok(!page.includes('apiClient.get("/api/tenants/members")'), "both metadata loading paths must use the business people selector");
});
