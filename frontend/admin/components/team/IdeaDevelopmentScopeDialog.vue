<script setup>
import { computed, ref } from "vue";
import { ElMessage } from "element-plus";
import DevelopmentCatalogEntryDialog from "./DevelopmentCatalogEntryDialog.vue";
import { loadInventoryNamingOptions, loadInventoryVehicleCatalog } from "../../utils/inventory-naming-options.js";

const props = defineProps({ brands: Array, categories: Array, groups: Array, legacyBrand: String, legacyCategory: String });
const emit = defineEmits(["close", "selected", "catalog-updated"]);
const brandQuery = ref(""); const categoryQuery = ref("");
const catalogEntry = ref(null);
const catalogBrands = ref(props.brands || []); const catalogCategories = ref(props.categories || []);
async function catalogSaved(result) {
  catalogEntry.value = null;
  try {
    [catalogBrands.value, catalogCategories.value] = await Promise.all([loadInventoryVehicleCatalog({ force: true }), loadInventoryNamingOptions({ type: "category" }, { force: true })]);
    emit("catalog-updated", { brands: catalogBrands.value, categories: catalogCategories.value });
    if (result.brand) brandQuery.value = result.brand;
    if (result.kind === "category" && !result.pending) categoryQuery.value = result.value;
    if (result.model && editing.value?.brand === result.brand) {
      const brand = catalogBrands.value.find(row => row.name === result.brand);
      const model = brand?.models.find(row => row.name === result.model);
      if (model && !modelRows.value.some(row => row.model_id === Number(model.id))) modelRows.value.push({ model_id: Number(model.id), model: model.name, target: 10, selected: true });
    }
  } catch (error) { ElMessage.error(error.message || "目录已保存，但刷新失败，请关闭坐标表后重新打开"); }
}
const cells = ref([]); const checked = ref([]); const editing = ref(null); const modelRows = ref([]); const uniformTarget = ref(10);
const key = (brand, category) => JSON.stringify([brand, category]);
const newKey = () => Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16).padStart(8, "0")).join("-");
for (const group of props.groups || []) {
  for (const model of group.models || []) {
    const brand = model.brand || group.brand; const category = model.category || group.category;
    let cell = cells.value.find(row => row.brand === brand && row.category === category);
    if (!cell) { cell = { brand, category, scope: model.scope || group.scope || (brand === "非汽车" ? "non_automotive" : "automotive"), groupKey: group.key, models: [] }; cells.value.push(cell); }
    cell.models.push({ ...model });
  }
}
const allBrands = computed(() => [...catalogBrands.value, { name: "非汽车", models: [{ id: 0, name: "非汽车" }] }]);
const visibleBrands = computed(() => allBrands.value.filter(row => `${row.name} ${row.nameZh || ""} ${row.label || ""} ${row.models.map(model => model.name).join(' ')}`.toLowerCase().includes(brandQuery.value.trim().toLowerCase())));
const visibleCategories = computed(() => catalogCategories.value.filter(row => row.value.includes(categoryQuery.value.trim())));
const taskKeys = computed(() => [...new Set(cells.value.map(row => row.groupKey))]);
const total = computed(() => cells.value.reduce((sum, cell) => sum + cell.models.reduce((n, row) => n + Number(row.target || 0), 0), 0));
function selectedCell(brand, category) { return cells.value.find(row => row.brand === brand && row.category === category); }
function configure(brand, category) {
  const cell = selectedCell(brand.name, category);
  editing.value = { brand: brand.name, category, scope: brand.name === "非汽车" ? "non_automotive" : "automotive", groupKey: cell?.groupKey || newKey() };
  const models = [...brand.models];
  for (const saved of cell?.models || []) if (!models.some(model => Number(model.id) === saved.model_id)) models.push({ id: saved.model_id, name: saved.model });
  modelRows.value = models.map(model => {
    const saved = cell?.models.find(row => row.model_id === Number(model.id));
    return { ...saved, model_id: Number(model.id), model: model.name, target: saved?.target || 10, selected: Boolean(saved) || brand.name === "非汽车" };
  });
}
function editCell(cell) { configure(allBrands.value.find(row => row.name === cell.brand) || { name: cell.brand, models: [] }, cell.category); }
function applyCell() {
  const models = modelRows.value.filter(row => row.selected);
  if (!models.length) return ElMessage.warning("请至少选择一个车型");
  if (models.some(row => !Number.isInteger(row.target) || row.target < 1)) return ElMessage.warning("请为每个车型填写大于 0 的整数 SKU 目标");
  const value = { ...editing.value, models: models.map(({ selected, ...row }) => ({ ...row, brand: editing.value.brand, category: editing.value.category, scope: editing.value.scope })) };
  const index = cells.value.findIndex(row => row.brand === value.brand && row.category === value.category);
  if (index < 0) cells.value.push(value); else cells.value[index] = value;
  editing.value = null;
}
function removeCell(cell) {
  cells.value = cells.value.filter(row => row !== cell);
  checked.value = checked.value.filter(value => value !== key(cell.brand, cell.category));
}
function merge() {
  const rows = cells.value.filter(row => checked.value.includes(key(row.brand, row.category)));
  if (rows.length < 2) return;
  const firstKey = rows[0].groupKey;
  const groupKey = cells.value.some(row => row.groupKey === firstKey && !rows.includes(row)) ? newKey() : firstKey;
  rows.forEach(row => { row.groupKey = groupKey; }); checked.value = [];
}
function split() {
  const seen = new Set();
  cells.value.forEach(row => {
    if (checked.value.includes(key(row.brand, row.category))) {
      if (seen.has(row.groupKey) || cells.value.some(other => other !== row && other.groupKey === row.groupKey && !checked.value.includes(key(other.brand, other.category)))) row.groupKey = newKey();
      seen.add(row.groupKey);
    }
  }); checked.value = [];
}
function confirm() {
  if (!cells.value.length) return ElMessage.warning("请从坐标表至少选择一个开发范围");
  emit("selected", taskKeys.value.map(groupKey => ({ key: groupKey, models: cells.value.filter(row => row.groupKey === groupKey).flatMap(row => row.models) })));
}
</script>

<template>
  <el-dialog :model-value="true" title="选择开发范围与任务分组" width="96vw" align-center append-to-body :close-on-click-modal="false" class="idea-scope-dialog" @close="emit('close')">
    <p class="scope-copy">横向是类目，纵向是品牌。可连续选择多个交叉格，再配置车型与数量。默认每个品牌＋类目生成一个任务，勾选下方范围可合并开发。</p>
    <el-alert v-if="!groups?.length && legacyBrand && legacyCategory" type="info" :closable="false" :title="`原开发范围：${legacyBrand} · ${legacyCategory}。请在坐标表补选车型；已有成果会保留。`" />
    <div class="scope-search"><el-button @click="catalogEntry={kind:'category'}">＋ 新增类目</el-button><el-button @click="catalogEntry={kind:'brand'}">＋ 新增品牌</el-button><el-button @click="catalogEntry={kind:'model'}">＋ 新增车型</el-button><el-input v-model="brandQuery" clearable placeholder="搜索品牌或车型" /><el-input v-model="categoryQuery" clearable placeholder="筛选核心品名" /></div>
    <div class="scope-matrix"><table><thead><tr><th>品牌 / 核心品名</th><th v-for="category in visibleCategories" :key="category.value">{{ category.value }}</th></tr></thead><tbody>
      <tr v-for="brand in visibleBrands" :key="brand.name"><th>{{ brand.name }}<small>{{ brand.name === '非汽车' ? '无需车型' : `${brand.models.length} 个车型` }}</small><el-button v-if="brand.name !== '非汽车'" link type="primary" @click="catalogEntry={kind:'model',brand:brand.name}">＋ 添加车型</el-button></th><td v-for="category in visibleCategories" :key="category.value"><button type="button" :disabled="!brand.models.length" :class="{ selected: selectedCell(brand.name, category.value) }" :aria-label="`${brand.name} · ${category.value}，选择车型`" @click="configure(brand, category.value)"><template v-if="selectedCell(brand.name, category.value)">已选 {{ selectedCell(brand.name, category.value).models.length }} 个车型<br /><small>编辑范围</small></template><template v-else>＋ 选择开发</template></button></td></tr>
    </tbody></table><el-empty v-if="!visibleBrands.length || !visibleCategories.length" description="没有匹配的品牌或类目，请调整搜索" /></div>
    <div class="scope-toolbar"><strong>已选 {{ cells.length }} 个范围 · {{ taskKeys.length }} 个任务 · {{ total }} 个 SKU</strong><div><el-button :disabled="checked.length < 2" @click="merge">合并勾选范围</el-button><el-button :disabled="!checked.length" @click="split">按品牌＋类目拆分</el-button></div></div>
    <div class="scope-selection"><el-checkbox-group v-model="checked"><div v-for="cell in cells" :key="key(cell.brand, cell.category)" class="scope-row"><el-checkbox :value="key(cell.brand, cell.category)" :aria-label="`勾选 ${cell.brand} ${cell.category}`" /><el-tag>任务 {{ taskKeys.indexOf(cell.groupKey) + 1 }}</el-tag><div><strong>{{ cell.brand }} · {{ cell.category }}</strong><small>{{ cell.models.map(row => `${row.model} × ${row.target}`).join('；') }}</small></div><el-button link type="primary" @click="editCell(cell)">编辑车型</el-button><el-button link type="danger" @click="removeCell(cell)">移除</el-button></div></el-checkbox-group><el-empty v-if="!cells.length" description="点击上方交叉格开始选择" :image-size="45" /></div>
    <template #footer><span class="scope-copy">所有任务使用灵感中设置的负责人和截止时间，创建后可分别调整。</span><el-button @click="emit('close')">取消</el-button><el-button type="primary" :disabled="!cells.length" @click="confirm">确定范围 · {{ taskKeys.length }} 个任务</el-button></template>
  </el-dialog>
  <el-dialog v-if="editing" :model-value="true" :title="`${editing.brand} · ${editing.category} · 选择车型`" width="min(760px, 94vw)" align-center append-to-body :close-on-click-modal="false" @close="editing = null">
    <div class="scope-toolbar"><el-checkbox :model-value="modelRows.every(row => row.selected)" @change="value => modelRows.forEach(row => row.selected = value)">全部车型</el-checkbox><div><el-input-number v-model="uniformTarget" :min="1" :max="100000" :precision="0" /><el-button @click="modelRows.filter(row => row.selected).forEach(row => row.target = uniformTarget)">统一已选目标</el-button></div></div>
    <el-button v-if="editing.brand !== '非汽车'" link type="primary" @click="catalogEntry={kind:'model',brand:editing.brand}">目录中没有？新增该品牌车型</el-button><div class="scope-models"><div v-for="row in modelRows" :key="row.model_id" class="scope-row"><el-checkbox v-model="row.selected">{{ row.model }}</el-checkbox><el-input-number v-model="row.target" :disabled="!row.selected" :min="1" :max="100000" :precision="0" /><span>个 SKU</span></div></div>
    <template #footer><el-button @click="editing = null">取消</el-button><el-button type="primary" @click="applyCell">加入开发范围</el-button></template>
  </el-dialog>
  <DevelopmentCatalogEntryDialog v-if="catalogEntry" :kind="catalogEntry.kind" :brand="catalogEntry.brand || ''" :brands="catalogBrands" @close="catalogEntry=null" @saved="catalogSaved" />
</template>

<style scoped>
.scope-copy{color:#64748b;line-height:1.7;font-size:13px}.scope-search,.scope-toolbar,.scope-toolbar>div{display:flex;align-items:center;gap:12px}.scope-search{margin:14px 0;flex-wrap:wrap}.scope-search .el-input{max-width:300px}.scope-matrix{max-height:38vh;overflow:auto;border:1px solid #e2e8f0;border-radius:10px}.scope-matrix table{border-collapse:separate;border-spacing:0;width:100%}.scope-matrix th,.scope-matrix td{min-width:150px;border-right:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0}.scope-matrix th{background:#f1f5f9;padding:14px;color:#475569;font-size:13px;white-space:nowrap;position:sticky;top:0;z-index:2}.scope-matrix tr>th:first-child{left:0;z-index:1}.scope-matrix thead th:first-child{z-index:3}.scope-matrix small{display:block;font-weight:400;color:#64748b;margin-top:5px}.scope-matrix td>button{width:100%;min-height:66px;border:0;background:white;color:#3b82f6;cursor:pointer}.scope-matrix td>button.selected{background:#eaf3ff;color:#2563eb}.scope-matrix td>button:hover{background:#eff6ff;outline:2px solid #93c5fd;outline-offset:-2px}.scope-matrix td>button:disabled{color:#cbd5e1;cursor:not-allowed}.scope-toolbar{justify-content:space-between;margin:16px 0;flex-wrap:wrap}.scope-toolbar strong{color:#334155}.scope-selection{max-height:25vh;overflow:auto}.scope-row{display:flex;align-items:center;gap:12px;padding:10px 6px;border-bottom:1px solid #edf1f7}.scope-row>div{flex:1;min-width:0}.scope-row strong,.scope-row small{display:block;line-height:1.7}.scope-row strong{font-size:13px;color:#334155}.scope-row small{font-size:12px;color:#64748b}.scope-models{max-height:50vh;overflow:auto}.scope-models .el-checkbox{flex:1}.scope-models .el-input-number{flex:none;width:140px}
</style>
