import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { computed, reactive } from "vue";
import { isImportCandidateVisible, normalizeImportCandidate, normalizeImportRows } from "../frontend/admin/utils/ai-product-import.js";

const source = readFileSync(new URL("../frontend/admin/components/listing/AiProductImportDialog.vue", import.meta.url), "utf8");

function dialog(get) {
  const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;\n/gm, "");
  const errors = [];
  const imports = [];
  const create = new Function("computed", "reactive", "apiClient", "useAuthStore", "defineProps", "defineEmits", "defineExpose", "ElMessage", "normalizeImportCandidate", "normalizeImportRows", "isImportCandidateVisible",
    `${script}\nreturn { state, open, loadRows, confirm };`);
  const instance = create(computed, reactive, { get }, () => ({ user: { id: 12 } }), () => ({}), () => (...args) => imports.push(args), () => {}, { error: (message) => errors.push(message) }, normalizeImportCandidate, normalizeImportRows, isImportCandidateVisible);
  instance.state.source = "draft";
  return { ...instance, errors, imports };
}

test("draft picker requests current payloads ordered by creation with all filters", async () => {
  const instance = dialog(async (url, options) => {
    const params = new URL(url, "http://localhost").searchParams;
    assert.equal(params.has("lightweight"), false);
    assert.equal(params.get("sortBy"), "created_at");
    assert.equal(params.get("pageSize"), "12");
    assert.equal(params.get("creatorId"), "12");
    assert.equal(params.get("shopId"), "2");
    assert.equal(params.get("startDate"), "2026-09-16");
    assert.equal(options.noCache, true);
    return { total: 1, rows: [{ id: 22, product_name: "Old summary", template_payload: { editable_payload: { title: "Latest title" } }, effective_images: ["/main.jpg", "/detail.jpg"] }] };
  });
  Object.assign(instance.state, { creatorId: "12", shopId: "2", startDate: "2026-09-16" });
  await instance.loadRows();
  assert.deepEqual(instance.errors, []);
  assert.equal(instance.state.rows[0].title, "Latest title");
  assert.deepEqual(instance.state.rows[0].detailImages, ["/detail.jpg"]);
});

test("a late list response cannot replace a newer search or selection", async () => {
  const pending = [];
  const instance = dialog(() => new Promise((resolve) => pending.push(resolve)));
  const older = instance.loadRows();
  instance.state.keyword = "new";
  const newer = instance.loadRows();
  pending[1]({ rows: [{ id: 2, product_name: "New search" }] });
  await newer;
  instance.state.selected = instance.state.rows[0];
  pending[0]({ rows: [{ id: 1, product_name: "Old search" }] });
  await older;
  assert.equal(instance.state.rows[0].sourceId, "2");
  assert.equal(instance.state.selected.sourceId, "2");
});

test("confirm imports fresh detail without merging the prior list snapshot", async () => {
  const instance = dialog(async () => ({ id: 5, effective_images: ["/fresh.jpg"], template_payload: { editable_payload: { title: "Fresh title" } } }));
  instance.state.selected = normalizeImportCandidate({ id: 5, effective_images: ["/old.jpg"], template_payload_json: JSON.stringify({ editable_payload: { title: "Old title" } }) }, "draft");
  await instance.confirm();
  assert.equal(instance.imports[0][1].title, "Fresh title");
  assert.equal(instance.imports[0][1].imageUrl, "/fresh.jpg");
});

test("detail fetch failure keeps the dialog open and never imports stale data", async () => {
  const instance = dialog(async () => { throw new Error("详情读取失败"); });
  instance.state.visible = true;
  instance.state.selected = normalizeImportCandidate({ id: 5, product_name: "Stale" }, "draft");
  await instance.confirm();
  assert.equal(instance.imports.length, 0);
  assert.equal(instance.state.visible, true);
  assert.equal(instance.state.loading, false);
  assert.deepEqual(instance.errors, ["详情读取失败"]);
});


test("reopening clears the previous list before draft filter options arrive", async () => {
  const pending = [];
  const instance = dialog((url) => {
    if (url.startsWith("/api/listing/drafts?")) return Promise.resolve({ rows: [], total: 0 });
    return new Promise((resolve) => pending.push(resolve));
  });
  instance.state.rows = [{ id: "stale" }];
  instance.state.selected = instance.state.rows[0];
  const opening = instance.open("draft", { defaultDraftScope: "mine" });
  assert.equal(instance.state.rows.length, 0);
  assert.equal(instance.state.selected, null);
  assert.equal(instance.state.loading, true);
  pending.forEach((resolve) => resolve([]));
  await opening;
  assert.equal(instance.state.loading, false);
});
