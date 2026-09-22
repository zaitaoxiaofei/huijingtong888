<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { Boxes, ShoppingCart, Truck, ArrowLeft, Plus, Search } from "lucide-vue-next";
import { apiClient } from "../../utils/api.js";
import { loadInventoryNamingOptions, loadInventoryVehicleCatalog } from "../../utils/inventory-naming-options.js";
import DevelopmentCatalogEntryDialog from "./DevelopmentCatalogEntryDialog.vue";
import { shanghaiDateTimeText, shanghaiDateText, shanghaiDateKey } from "../../utils/shanghai-date.js";

const props = defineProps({ people: { type: Array, default: () => [] }, tasks: { type: Array, default: () => [] }, initialTask: { type: Object, default: null } });
const emit = defineEmits(["close", "saved"]);
const types = [
  { value: "product_development", label: "开发产品", text: "按品牌、核心品名和车型制定 SKU 目标", icon: Boxes },
  { value: "procurement_daily", label: "采购任务", text: "设置固定采购负责人，后续每日自动分配", icon: ShoppingCart },
  { value: "shipping_daily", label: "每日发货", text: "设置固定发货负责人，后续每日自动分配", icon: Truck }
];
const type = ref("product_development");
const step = ref(props.initialTask ? "matrix" : "type");
const loading = ref(false);
const loadError = ref("");
const brands = ref([]);
const scope = ref("automotive");
const nonAutomotiveBrand = { name: "非汽车", models: [{ id: 0, name: "非汽车" }] };
const categories = ref([]);
const catalogEntry = ref(null);
async function catalogSaved(result) {
  catalogEntry.value = null;
  await loadCatalog();
  if (result.brand) brandQuery.value = result.brand;
  if (result.kind === "category" && !result.pending) categoryQuery.value = result.value;
  if (result.model && configVisible.value && selectedBrand.value?.name === result.brand) {
    const model = brands.value.find(row => row.name === result.brand)?.models.find(row => row.name === result.model);
    if (model && !modelRows.value.some(row => Number(row.model_id) === Number(model.id))) modelRows.value.push({ model_id: Number(model.id), model: model.name, selected: true, target: 10, done: 0, drafts: [] });
  }
}
const brandQuery = ref("");
const categoryQuery = ref("");
const expandedBrands = ref(new Set());
const configVisible = ref(false);
const saving = ref(false);
const selectedBrand = ref(null);
const modelRows = ref([]);
const uniformTarget = ref(10);
const unallocatedDrafts = ref([]);
const allocationTarget = ref(null);
const modelKey = row => JSON.stringify([row.brand || selectedBrand.value?.name, row.category || form.category, row.model_id]);
const form = reactive({ title: "", owner_person_id: null, due_at: "", category: "", notes: "" });
const draftModel = ref(null);
const draftQuery = ref("");
const draftRows = ref([]);
const draftPage = ref(1);
const draftTotal = ref(0);
const draftLoading = ref(false);
const draftError = ref("");
let draftRequest = 0;
function withTimeout(promise, message, timeoutMs = 15_000) {
  let timer = null;
  return Promise.race([promise, new Promise((_, reject) => { timer = window.setTimeout(() => reject(new Error(message)), timeoutMs); })])
    .finally(() => { if (timer) window.clearTimeout(timer); });
}

function rank(row) {
  const tags = row.tags || [];
  return tags.includes("top_priority_model") ? 0 : row.priority === "high" ? 1 : tags.includes("priority_brand") ? 2 : tags.some((tag) => tag.startsWith("hot_")) ? 3 : 4;
}
const visibleBrands = computed(() => (scope.value === "non_automotive" ? [nonAutomotiveBrand] : brands.value).filter((row) => `${row.name} ${row.nameZh || ""} ${row.label} ${row.models.map((m) => m.name).join(' ')}`.toLowerCase().includes(brandQuery.value.trim().toLowerCase()))
  .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)));
const visibleCategories = computed(() => categories.value.filter((row) => row.value.includes(categoryQuery.value.trim())));
const selectedModels = computed(() => modelRows.value.filter((row) => row.selected));
const totalTarget = computed(() => selectedModels.value.reduce((sum, row) => sum + Number(row.target || 0), 0));
const allSelected = computed(() => modelRows.value.length > 0 && modelRows.value.every((row) => row.selected));
const dailyOwnerId = ref(null);
const dailyTermUntil = ref(null);
const dailyOwners = ref([]);
const ownersLoading = ref(false);
const ownersError = ref("");
const ownerFor = value => dailyOwners.value.find(row => row.type === value);
const dailyOwnerName = computed(() => ownerFor(type.value)?.owner_name || "尚未设置");
function ownerTermText(value) {
  const owner = ownerFor(value);
  if (!owner?.owner_person_id) return "尚未分配";
  if (Number(owner.term_expired)) return "已到期，待确认 · 暂沿用原负责人";
  return owner.term_until ? `负责至 ${shanghaiDateText(owner.term_until)}（北京时间）` : "长期负责 · 未设截止日期";
}
function setOneMonth() {
  const [year, month, day] = shanghaiDateKey().split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  dailyTermUntil.value = shanghaiDateKey(new Date(Date.UTC(year, month, Math.min(day, lastDay))));
}
async function loadDailyOwners() {
  ownersLoading.value = true; ownersError.value = "";
  try {
    const result = await apiClient.get("/api/team/operational-owners", { noCache: true });
    dailyOwners.value = result.rows;
  } catch (error) { ownersError.value = error.message || "固定负责人加载失败，请重试"; }
  finally { ownersLoading.value = false; }
}
async function loadDailyOwner() {
  await loadDailyOwners();
  const current = ownerFor(type.value);
  dailyOwnerId.value = current?.owner_person_id ? Number(current.owner_person_id) : null;
  dailyTermUntil.value = current?.term_until || null;
}
async function saveDailyOwner() {
  if (!dailyOwnerId.value) return ElMessage.warning("请选择固定负责人");
  saving.value = true;
  try {
    await apiClient.put("/api/team/operational-owners", { type: type.value, owner_person_id: dailyOwnerId.value, term_until: dailyTermUntil.value || null });
    ElMessage.success("固定负责人已保存，当天及后续每日任务将自动分配给此人");
    emit("saved");
  } catch (error) { ElMessage.error(error.message || "固定负责人保存失败"); }
  finally { saving.value = false; }
}
const existingCounts = computed(() => {
  const counts = new Map();
  for (const task of props.tasks) {
    const scopes = task.development_scopes || [{ brand: task.development_plan?.brand || task.development_brand, category: task.development_plan?.category || task.development_category }];
    for (const key of new Set(scopes.filter(row => row.brand && row.category).map(row => `${row.brand}\n${row.category}`))) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
});
const completionText = computed(() => selectedModels.value.map((row) => `${row.brand ? `${row.brand} · ${row.category} · ` : ""}${row.model}：${Number(row.target || 0)} 个 SKU`).join("；"));
function toggleBrand(name) {
  const next = new Set(expandedBrands.value);
  next.has(name) ? next.delete(name) : next.add(name);
  expandedBrands.value = next;
}
async function loadCatalog() {
  loading.value = true; loadError.value = "";
  try {
    const [brandRows, categoryRows] = await withTimeout(Promise.all([loadInventoryVehicleCatalog({ force: true }), loadInventoryNamingOptions({ type: "category" }, { force: true })]), "车型或核心品名目录加载超时，请检查网络后重试。");
    brands.value = brandRows;
    categories.value = categoryRows;
  } catch (error) { loadError.value = error.message || "品牌和核心品名加载失败，请重试"; }
  finally { loading.value = false; }
}
async function nextStep() {
  step.value = type.value === "product_development" ? "matrix" : "daily";
  if (step.value === "matrix" && !brands.value.length) await loadCatalog();
  if (step.value === "daily") await loadDailyOwner();
}
function configure(brand, category, existing = null) {
  selectedBrand.value = brand;
  form.category = category;
  form.title = existing?.title || `${brand.name} ${category}开发`;
  form.owner_person_id = existing?.owner_person_id || null;
  form.due_at = existing?.due_at || "";
  form.notes = existing?.development_plan?.notes || "";
  unallocatedDrafts.value = (existing?.development_plan?.unallocated_drafts || []).map(row => ({ ...row }));
  if (existing?.development_plan?.models.some(row => row.brand || row.category)) {
    modelRows.value = existing.development_plan.models.map(row => ({ ...row, selected: true, drafts: (row.drafts || []).map(draft => ({ ...draft })) }));
    configVisible.value = true;
    return;
  }
  const saved = new Map((existing?.development_plan?.models || []).map((row) => [row.model_id, row]));
  const models = [...brand.models];
  for (const row of saved.values()) if (!models.some((model) => Number(model.id) === row.model_id)) models.push({ id: row.model_id, name: row.model });
  modelRows.value = models.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "en", { numeric: true })).map((model) => {
    const row = saved.get(Number(model.id));
    return { model_id: Number(model.id), model: model.name, selected: Boolean(row) || scope.value === "non_automotive", target: row?.target || 10, done: row?.done || 0, drafts: (row?.drafts || []).map((draft) => ({ ...draft })) };
  });
  configVisible.value = true;
}
function closeConfig() {
  if (saving.value) return;
  configVisible.value = false;
  if (props.initialTask) emit("close");
}
function setAll(value) { modelRows.value.forEach((row) => { row.selected = value; }); }
function applyTarget() { selectedModels.value.forEach((row) => { row.target = uniformTarget.value; }); }
async function save() {
  if (!form.title.trim()) return ElMessage.warning("请填写任务名称");
  if (!selectedModels.value.length) return ElMessage.warning("请至少勾选一个车型");
  if (!form.owner_person_id) return ElMessage.warning("请选择任务负责人");
  if (!form.due_at) return ElMessage.warning("请选择计划完成日期（北京时间）");
  if (selectedModels.value.some((row) => !Number.isInteger(row.target) || row.target < 1)) return ElMessage.warning("请为每个勾选车型填写大于 0 的整数 SKU 目标");
  saving.value = true;
  try {
    const related = { kind: "development_matrix", brand: selectedBrand.value.name, scope: scope.value, category: form.category, notes: form.notes,
      unallocated_draft_ids: [...unallocatedDrafts.value.map(row => row.id), ...modelRows.value.filter(row => !row.selected).flatMap(row => row.drafts.map(draft => draft.id))],
      models: selectedModels.value.map((row) => ({ ...(row.brand ? { brand: row.brand, category: row.category, scope: row.scope } : {}), model_id: row.model_id, model: row.model, target: row.target, draft_ids: row.drafts.map((draft) => draft.id) })) };
    const payload = { title: form.title.trim(), type: "product_development", owner_person_id: form.owner_person_id, due_at: form.due_at,
      period: props.initialTask?.period || "week", priority: props.initialTask?.priority || "medium", start_at: props.initialTask?.start_at || "", related };
    if (props.initialTask) await apiClient.put(`/api/team/tasks/${props.initialTask.id}`, payload);
    else await apiClient.post("/api/team/tasks", payload);
    ElMessage.success(props.initialTask ? "开发任务已更新" : "开发任务已创建");
    emit("saved");
  } catch (error) { ElMessage.error(error.message || "保存失败，请重试"); }
  finally { saving.value = false; }
}
function allocateDraft(draft) {
  const row = selectedModels.value.find(model => modelKey(model) === allocationTarget.value);
  if (!row) return ElMessage.warning("请选择历史成果所属的品牌、类目和车型");
  if (!row.drafts.some(item => item.id === draft.id)) row.drafts.push({ ...draft });
  unallocatedDrafts.value = unallocatedDrafts.value.filter(item => item.id !== draft.id);
}
function openDrafts(row) {
  if (!form.owner_person_id) return ElMessage.warning("请先选择负责人，再关联该人员创建的草稿");
  draftModel.value = row; draftPage.value = 1; draftQuery.value = ""; draftRows.value = [];
  loadDrafts();
}
async function loadDrafts() {
  const request = ++draftRequest;
  draftLoading.value = true; draftError.value = "";
  try {
    const params = new URLSearchParams({ paged: "1", lightweight: "1", page: String(draftPage.value), pageSize: "10", sortBy: "created_at", creatorId: String(form.owner_person_id), query: draftQuery.value.trim() });
    const result = await apiClient.get(`/api/listing/drafts?${params}`, { noCache: true });
    if (request !== draftRequest) return;
    draftRows.value = result?.rows || []; draftTotal.value = Number(result?.total || 0);
  } catch (error) { if (request === draftRequest) { draftRows.value = []; draftTotal.value = 0; draftError.value = error.message || "草稿加载失败，请重试"; } }
  finally { if (request === draftRequest) draftLoading.value = false; }
}
function draftAssignedElsewhere(id) { return modelRows.value.some((row) => row !== draftModel.value && row.selected && row.drafts.some((draft) => draft.id === Number(id))); }
function toggleDraft(draft) {
  const row = draftModel.value; const id = Number(draft.id);
  if (row.drafts.some((item) => item.id === id)) row.drafts = row.drafts.filter((item) => item.id !== id);
  else { row.drafts.push({ id, title: draft.product_name || `草稿 #${id}` }); unallocatedDrafts.value = unallocatedDrafts.value.filter(item => item.id !== id); }
}
onMounted(async () => {
  if (!props.initialTask) { await loadDailyOwners(); return; }
  await loadCatalog();
  if (loadError.value) return;
  const plan = props.initialTask.development_plan;
  scope.value = plan.scope || "automotive";
  const brand = scope.value === "non_automotive" ? nonAutomotiveBrand : brands.value.find((row) => row.name === plan.brand) || { name: plan.brand, models: [] };
  configure(brand, plan.category, props.initialTask);
});
</script>

<template>
  <el-dialog :model-value="true" :title="initialTask ? '编辑开发任务' : '新增任务'" :width="step === 'matrix' ? 'min(1320px, 96vw)' : 'min(850px, 94vw)'" align-center append-to-body class="task-create-dialog" :close-on-click-modal="false" :close-on-press-escape="!saving" :show-close="!saving" @close="emit('close')">
    <template v-if="!initialTask">
      <div v-if="step === 'type'" class="type-step">
        <p class="step-copy">选择任务类型</p>
        <el-alert v-if="ownersError" :title="ownersError" type="error" :closable="false"><el-button link @click="loadDailyOwners">重新加载负责人</el-button></el-alert>
        <div class="creation-types">
          <button v-for="item in types" :key="item.value" type="button" :class="{ active: type === item.value }" :aria-pressed="type === item.value" @click="type = item.value">
            <component :is="item.icon" :size="30" /><strong>{{ item.label }}</strong><span>{{ item.text }}</span>
            <span v-if="item.value !== 'product_development'" class="type-owner" :class="{ expired: Number(ownerFor(item.value)?.term_expired) }">
              <b>{{ ownersLoading ? '正在读取负责人…' : ownersError ? '负责人读取失败' : `负责人：${ownerFor(item.value)?.owner_name || '尚未设置'}` }}</b>
              <span v-if="!ownersLoading && !ownersError">{{ ownerTermText(item.value) }}</span>
            </span><small>{{ type === item.value ? '已选择' : '选择类型' }}</small>
          </button>
        </div>
      </div>
      <template v-else-if="step === 'matrix'">
        <div class="matrix-heading"><div><el-button link :disabled="loading || saving" @click="step = 'type'"><ArrowLeft :size="16" /> 返回任务类型</el-button><h3>从品牌与核心品名开始</h3><p>点击交叉格，选择车型并分配 SKU 目标。推荐顺序来自现有目录优先级。</p></div><el-tag>开发产品</el-tag></div>
        <div class="matrix-search"><el-button @click="catalogEntry={kind:'category'}">＋ 新增类目</el-button><el-button @click="catalogEntry={kind:'brand'}">＋ 新增品牌</el-button><el-button @click="catalogEntry={kind:'model'}">＋ 新增车型</el-button><el-select v-model="scope" aria-label="开发范围" style="width:140px" @change="brandQuery = ''"><el-option label="汽车" value="automotive" /><el-option label="非汽车" value="non_automotive" /></el-select><el-input v-model="brandQuery" clearable placeholder="搜索品牌或车型"><template #prefix><Search :size="16" /></template></el-input><el-input v-model="categoryQuery" clearable placeholder="筛选核心品名" /><span>{{ visibleBrands.length }} 个品牌 · {{ visibleCategories.length }} 个核心品名</span></div>
        <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" show-icon><el-button link @click="loadCatalog">重新加载</el-button></el-alert>
        <div v-loading="loading" class="development-matrix">
          <table v-if="visibleBrands.length && visibleCategories.length"><thead><tr><th>{{ scope === 'non_automotive' ? '非汽车 / 核心品名' : '汽车品牌 / 核心品名' }}</th><th v-for="category in visibleCategories" :key="category.value">{{ category.value }}</th></tr></thead><tbody>
            <tr v-for="brand in visibleBrands" :key="brand.name"><th><button type="button" class="brand-toggle" :aria-expanded="expandedBrands.has(brand.name)" @click="toggleBrand(brand.name)"><span>{{ expandedBrands.has(brand.name) ? '▾' : '▸' }}</span><div><strong>{{ brand.name }}</strong><small>{{ scope === 'non_automotive' ? '无需车型' : `${brand.models.length} 个车型` }}</small></div></button><el-button v-if="scope !== 'non_automotive'" link type="primary" @click="catalogEntry={kind:'model',brand:brand.name}">＋ 添加车型</el-button><div v-if="expandedBrands.has(brand.name)" class="brand-models">{{ brand.models.map(model => model.name).join(' · ') || '暂无车型' }}</div></th>
              <td v-for="category in visibleCategories" :key="category.value"><button type="button" class="matrix-cell" :disabled="!brand.models.length" :aria-label="`${brand.name} · ${category.value}，配置开发任务`" @click="configure(brand, category.value)"><Plus :size="17" /><span>配置任务</span><small v-if="existingCounts.get(`${brand.name}\n${category.value}`)">已有 {{ existingCounts.get(`${brand.name}\n${category.value}`) }} 个任务</small></button></td>
            </tr>
          </tbody></table>
          <el-empty v-else-if="!loading && !loadError" description="没有匹配的品牌或核心品名，请调整搜索或先维护目录" />
        </div>
      </template>
      <template v-else>
        <el-button link :disabled="loading || saving" @click="step = 'type'"><ArrowLeft :size="16" /> 返回任务类型</el-button>
        <div v-loading="ownersLoading">
          <h3>{{ type === 'procurement_daily' ? '采购任务' : '每日发货' }} · 固定负责人</h3>
          <p class="step-copy">当天及后续每日任务自动分配给此人。截止日期当天仍有效，到期后提示重新确认；未重新设置时继续沿用原负责人。历史任务保留原归属。</p>
          <el-alert v-if="ownersError" :title="ownersError" type="error" :closable="false"><el-button link @click="loadDailyOwner">重新加载</el-button></el-alert>
          <template v-else>
            <p>当前固定负责人：{{ dailyOwnerName }}</p>
            <el-alert v-if="Number(ownerFor(type)?.term_expired)" title="负责期限已到期，请重新确认负责人和截止日期；未确认前继续由原负责人负责。" type="warning" :closable="false" show-icon />
            <el-form label-position="top">
              <el-form-item label="固定负责人" required><el-select v-model="dailyOwnerId" filterable placeholder="选择固定负责人" aria-label="固定负责人"><el-option v-for="person in people" :key="person.id" :label="person.name" :value="person.id" /></el-select></el-form-item>
              <el-form-item label="负责截止日期（北京时间，选填）">
                <div class="owner-term-input"><el-date-picker v-model="dailyTermUntil" type="date" value-format="YYYY-MM-DD" placeholder="不设期限，长期负责" /><el-button @click="setOneMonth">从今天起一个月</el-button><el-button @click="dailyTermUntil = null">长期负责</el-button></div>
              </el-form-item>
            </el-form>
          </template>
        </div>
      </template>
    </template>
    <div v-else v-loading="loading" class="edit-loading"><el-alert v-if="loadError" :title="loadError" type="error" :closable="false" show-icon><template #default><el-button link @click="loadCatalog">重新加载</el-button></template></el-alert><span v-else>正在打开车型配置…</span></div>
    <template #footer><el-button :disabled="saving" @click="emit('close')">取消</el-button><el-button v-if="step === 'type'" type="primary" @click="nextStep">下一步</el-button><el-button v-if="step === 'daily'" type="primary" :loading="saving" :disabled="ownersLoading || !!ownersError" @click="saveDailyOwner">保存固定负责人</el-button></template>
  </el-dialog>

  <el-dialog v-if="configVisible" :model-value="configVisible" :title="initialTask?.source_idea_id ? '编辑灵感开发任务' : `${selectedBrand.name} · ${form.category}`" width="min(960px, 94vw)" align-center append-to-body :close-on-click-modal="false" :close-on-press-escape="!saving" :show-close="!saving" class="development-config-dialog" @close="closeConfig">
    <p class="config-intro">{{ scope === 'non_automotive' ? '非汽车开发无需选择车型，直接设置该核心品名的 SKU 完成目标。' : '选择本次开发的车型，每个车型分别设置 SKU 完成目标。' }}</p>
    <div v-if="unallocatedDrafts.length" class="completion-rule"><strong>历史成果待分配（{{ unallocatedDrafts.length }} 份）</strong><p>这些草稿尚未指定车型，已保留但暂不计入车型进度。请选择实际归属后分配。</p><el-select v-model="allocationTarget" filterable placeholder="选择成果所属的品牌、类目和车型" style="width:100%"><el-option v-for="row in selectedModels" :key="modelKey(row)" :value="modelKey(row)" :label="`${row.brand || selectedBrand.name} · ${row.category || form.category} · ${row.model}`" /></el-select><div v-for="draft in unallocatedDrafts" :key="draft.id" style="margin-top:8px">{{ draft.title }} · {{ draft.count }} 个 SKU <el-button link type="primary" @click="allocateDraft(draft)">分配到所选车型</el-button></div></div>
    <el-form label-position="top">
      <el-form-item label="任务名称" required><el-input v-model="form.title" maxlength="255" /></el-form-item>
      <el-button v-if="scope !== 'non_automotive' && !initialTask?.source_idea_id" link type="primary" @click="catalogEntry={kind:'model',brand:selectedBrand.name}">目录中没有？新增该品牌车型</el-button>
      <div class="model-actions"><el-checkbox :model-value="allSelected" :indeterminate="selectedModels.length > 0 && !allSelected" @change="setAll">{{ scope === 'non_automotive' ? '非汽车开发' : '全部车型' }}</el-checkbox><div><span>统一目标</span><el-input-number v-model="uniformTarget" :min="1" :max="100000" :precision="0" controls-position="right" /><el-button :disabled="!selectedModels.length" @click="applyTarget">应用到已选</el-button></div></div>
      <div class="model-table"><table><thead><tr><th>{{ scope === 'non_automotive' ? '开发范围' : '选择车型' }}</th><th>目标 SKU 数</th><th v-if="initialTask">已完成</th><th v-if="initialTask">成果草稿</th></tr></thead><tbody><tr v-for="row in modelRows" :key="modelKey(row)" :class="{ selected: row.selected }"><td><el-checkbox v-model="row.selected">{{ row.brand ? `${row.brand} · ${row.category} · ` : '' }}{{ row.model }}</el-checkbox></td><td><el-input-number v-if="row.selected" v-model="row.target" :min="1" :max="100000" :precision="0" controls-position="right" /><span v-else class="model-placeholder">勾选后设置数量</span></td><td v-if="initialTask">{{ row.done }} / {{ row.target }}</td><td v-if="initialTask"><el-button link type="primary" :disabled="!row.selected" @click="openDrafts(row)">关联草稿（{{ row.drafts.length }}）</el-button></td></tr></tbody></table></div>
      <div class="model-summary">已选 <b>{{ selectedModels.length }}</b> {{ scope === 'non_automotive' ? '个开发范围' : '个车型' }}，合计 <b>{{ totalTarget }}</b> 个 SKU</div>
      <div class="config-fields"><el-form-item label="负责人" required><el-select v-model="form.owner_person_id" filterable placeholder="选择负责人"><el-option v-for="person in people" :key="person.id" :label="person.name" :value="person.id" /></el-select></el-form-item><el-form-item label="计划完成日期（北京时间）" required><el-date-picker v-model="form.due_at" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" /></el-form-item></div>
      <div class="completion-rule"><strong>完成标准</strong><p>{{ completionText || '勾选车型后自动生成完成标准' }}</p><small>按每个车型关联草稿中的变体数量计数，店铺副本不重复计数。所有车型分别达标后任务完成。{{ initialTask ? '草稿关联变更将在保存任务后生效。' : '创建后打开任务详情即可按车型关联负责人创建的草稿。' }}</small></div>
      <el-form-item label="补充要求（选填）"><el-input v-model="form.notes" type="textarea" :rows="2" maxlength="2000" placeholder="例如：颜色、材质、款式或验收要求" /></el-form-item>
    </el-form>
    <template #footer><el-button :disabled="saving" @click="closeConfig">{{ initialTask ? '取消' : '返回表格' }}</el-button><el-button type="primary" :loading="saving" @click="save">{{ initialTask ? '保存任务' : `创建任务 · ${totalTarget} 个 SKU` }}</el-button></template>
  </el-dialog>

  <el-dialog v-if="draftModel" :model-value="true" :title="`${draftModel.brand || selectedBrand.name} · ${draftModel.category || form.category} · ${draftModel.model} · 关联成果草稿`" width="min(800px, 92vw)" append-to-body :close-on-click-modal="false" @close="draftModel = null">
    <el-alert title="请确认草稿属于当前车型和核心品名。一份草稿只能分配给一个车型，混合车型的草稿请拆分后关联。" type="info" :closable="false" />
    <div class="linked-drafts"><el-tag v-for="draft in draftModel.drafts" :key="draft.id" closable @close="draftModel.drafts = draftModel.drafts.filter(item => item.id !== draft.id)">{{ draft.title }}</el-tag></div>
    <div class="draft-search"><el-input v-model="draftQuery" clearable placeholder="搜索草稿名称或编号" @keyup.enter="draftPage = 1; loadDrafts()" /><el-button @click="draftPage = 1; loadDrafts()">搜索</el-button></div>
    <el-alert v-if="draftError" :title="draftError" type="error" :closable="false"><el-button link @click="loadDrafts">重试</el-button></el-alert>
    <div v-loading="draftLoading" class="draft-results"><div v-for="draft in draftRows" :key="draft.id" class="draft-row"><el-checkbox :aria-label="`选择草稿 ${draft.product_name || draft.id}`" :model-value="draftModel.drafts.some(item => item.id === Number(draft.id))" :disabled="draftAssignedElsewhere(draft.id)" @change="toggleDraft(draft)" /><div><strong>{{ draft.product_name || `草稿 #${draft.id}` }}</strong><small>#{{ draft.id }} · {{ shanghaiDateTimeText(draft.created_at, { assumeUtcWhenNaive: true }) }}<template v-if="draftAssignedElsewhere(draft.id)"> · 已分配给其他车型</template></small></div></div><el-empty v-if="!draftLoading && !draftRows.length && !draftError" description="该负责人暂无匹配草稿" /></div>
    <el-pagination v-if="draftTotal > 10" v-model:current-page="draftPage" :page-size="10" :total="draftTotal" layout="prev, pager, next" @current-change="loadDrafts" />
    <template #footer><el-button type="primary" @click="draftModel = null">完成选择，返回任务</el-button></template>
  </el-dialog>
  <DevelopmentCatalogEntryDialog v-if="catalogEntry" :kind="catalogEntry.kind" :brand="catalogEntry.brand || ''" :brands="brands" @close="catalogEntry=null" @saved="catalogSaved" />
</template>

<style scoped>
.creation-types .type-owner{display:grid;gap:6px;width:100%;padding-top:12px;border-top:1px solid #e2e8f0;color:#475569}.type-owner b{font-size:14px}.creation-types .type-owner span{font-size:12px;line-height:1.6}.creation-types .type-owner.expired{color:#b45309}.owner-term-input{display:flex;flex-wrap:wrap;gap:8px;align-items:center}

.step-copy{margin:0 0 20px;color:#64748b;line-height:1.7}.creation-types{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding:8px 0 20px}.creation-types button{display:flex;flex-direction:column;align-items:flex-start;gap:16px;min-height:205px;padding:24px;border:1px solid #dce4ef;border-radius:14px;background:#fff;text-align:left;cursor:pointer;color:#64748b}.creation-types button.active{border-color:#3b82f6;background:#eff6ff;box-shadow:0 0 0 1px #3b82f6}.creation-types strong{font-size:19px;color:#1e293b}.creation-types span{font-size:13px;line-height:1.7}.creation-types small{margin-top:auto;color:#2563eb}.matrix-heading{display:flex;justify-content:space-between;align-items:center}.matrix-heading h3{margin:12px 0 6px;color:#1e293b;font-size:21px}.matrix-heading p{color:#64748b;margin:0;font-size:13px}.matrix-search{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:20px 0 14px}.matrix-search .el-input{width:250px}.matrix-search>span{margin-left:auto;color:#94a3b8;font-size:12px}.development-matrix{max-height:55vh;min-height:240px;overflow:auto;border:1px solid #e2e8f0;border-radius:10px}.development-matrix table,.model-table table{width:100%;border-collapse:separate;border-spacing:0}.development-matrix th,.development-matrix td{min-width:156px;border-right:1px solid #e7edf5;border-bottom:1px solid #e7edf5}.development-matrix thead th{position:sticky;top:0;z-index:2;height:50px;background:#f5f8fd;font-size:13px;color:#475569;padding:0 14px;white-space:nowrap}.development-matrix tr>th:first-child{position:sticky;left:0;min-width:190px;width:190px;background:#f8fafc;z-index:1;text-align:left}.development-matrix thead th:first-child{z-index:3;background:#edf3fb}.brand-toggle{display:flex;gap:10px;align-items:center;width:100%;padding:18px 16px;border:0;background:transparent;color:#334155;text-align:left;cursor:pointer}.brand-toggle>div{display:grid;gap:5px}.brand-toggle strong{font-size:14px}.brand-toggle small{font-size:12px;color:#94a3b8;font-weight:400}.brand-models{max-width:200px;padding:0 16px 16px;color:#64748b;line-height:1.7;font-size:12px;font-weight:400}.matrix-cell{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:6px;min-height:76px;width:100%;padding:10px;border:0;background:white;color:#4776b0;cursor:pointer}.matrix-cell:hover,.matrix-cell:focus-visible{background:#eff6ff;color:#2563eb;outline:2px solid #93c5fd;outline-offset:-2px}.matrix-cell:disabled{color:#cbd5e1;cursor:not-allowed}.matrix-cell small{width:100%;color:#94a3b8;font-size:11px}.daily-options{display:grid;gap:10px;max-height:50vh;overflow:auto}.daily-options button{display:flex;align-items:center;justify-content:space-between;padding:18px;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc;text-align:left;cursor:pointer;color:#2563eb}.daily-options button>div{display:grid;gap:8px}.daily-options strong{color:#334155}.daily-options div>span{font-size:12px;color:#64748b}.config-intro{margin:0 0 20px;color:#64748b}.model-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 10px}.model-actions>div{display:flex;align-items:center;gap:10px;color:#64748b;font-size:12px}.model-actions .el-input-number{width:110px}.model-table{max-height:32vh;overflow:auto;border:1px solid #e2e8f0;border-radius:10px}.model-table th{position:sticky;top:0;background:#f5f8fd;z-index:1;font-weight:500;color:#64748b;font-size:12px}.model-table th,.model-table td{text-align:left;padding:12px 18px;border-bottom:1px solid #edf1f7}.model-table tr.selected{background:#f8fbff}.model-table .el-input-number{width:135px}.model-placeholder{font-size:12px;color:#94a3b8}.model-summary{padding:12px 0 20px;color:#64748b;font-size:13px}.model-summary b{color:#2563eb;font-size:17px}.config-fields{display:grid;grid-template-columns:1fr 1fr;gap:20px}.config-fields .el-date-editor{width:100%}.completion-rule{padding:16px;margin-bottom:18px;background:#f0f6ff;border:1px solid #dce9ff;border-radius:10px}.completion-rule strong{color:#315884;font-size:13px}.completion-rule p{margin:8px 0;color:#334155;line-height:1.7}.completion-rule small{color:#64748b;line-height:1.7;display:block}.edit-loading{min-height:120px;display:grid;place-items:center;color:#94a3b8}.linked-drafts{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}.linked-drafts .el-tag{max-width:100%;height:auto;white-space:normal}.draft-search{display:flex;gap:10px;margin:14px 0}.draft-results{min-height:140px;max-height:40vh;overflow:auto}.draft-results .draft-row{display:flex;gap:12px;align-items:center;padding:14px 8px;border-bottom:1px solid #edf1f7}.draft-results .draft-row>div{display:grid;gap:6px}.draft-results strong{font-size:13px;color:#334155}.draft-results small{font-size:12px;color:#94a3b8}:global(.task-create-dialog),:global(.development-config-dialog){border-radius:16px}:global(.development-config-dialog .el-dialog__body){max-height:74vh;overflow:auto}@media(max-width:720px){.creation-types{grid-template-columns:1fr}.creation-types button{min-height:130px;padding:16px;gap:8px}.matrix-search{flex-wrap:wrap}.matrix-search .el-input{width:100%}.matrix-search>span{margin-left:0}.config-fields{grid-template-columns:1fr;gap:0}.model-actions{align-items:flex-start;flex-direction:column}.model-table th,.model-table td{padding:10px}.matrix-heading p{line-height:1.7}}
</style>

<style>
/* Task matrix viewport layout */
.task-create-dialog:has(.development-matrix) {
  width: 96vw !important;
  max-width: 96vw;
  height: 94vh;
  max-height: 94vh;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}
.task-create-dialog:has(.development-matrix) > .el-dialog__header,
.task-create-dialog:has(.development-matrix) > .el-dialog__footer {
  flex: 0 0 auto;
}
.task-create-dialog:has(.development-matrix) > .el-dialog__body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  max-height: none;
  overflow: hidden;
}
.task-create-dialog:has(.development-matrix) .matrix-heading,
.task-create-dialog:has(.development-matrix) .matrix-search,
.task-create-dialog:has(.development-matrix) .el-alert {
  flex: 0 0 auto;
}
.task-create-dialog:has(.development-matrix) .development-matrix {
  flex: 1 1 auto;
  min-height: 0;
  max-height: none;
}
</style>
