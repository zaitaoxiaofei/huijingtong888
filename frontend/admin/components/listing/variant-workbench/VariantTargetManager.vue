<script setup>
import { computed, reactive, ref } from "vue";
import { Plus, Rank } from "@element-plus/icons-vue";
import ProductImagePreview from "../../ProductImagePreview.vue";

const props = defineProps({
  variantType: { type: String, default: "multi_model" },
  targets: { type: Array, default: () => [] },
  mainImagePlans: { type: Array, default: () => [] },
  products: { type: Array, default: () => [] },
  templates: { type: Array, default: () => [] },
  selectedBase: { type: Object, default: null }
});

const emit = defineEmits(["add-targets", "add-plan", "remove", "reorder"]);

const pasteDialog = ref(false);
const templateDialog = ref(false);
const importDialog = ref(false);
const pasteText = ref("");
const manual = reactive({ brand: "", model: "" });
const selectedTemplateKeys = ref([]);
const selectedProductRows = ref([]);
const dragId = ref("");

const rows = computed(() => props.variantType === "same_model_main_image" ? props.mainImagePlans : props.targets);
const isMainPlan = computed(() => props.variantType === "same_model_main_image");

function display(row) {
  return isMainPlan.value ? row.name : (row.displayName || [row.brand, row.model].filter(Boolean).join(" "));
}

function addManual() {
  const text = [manual.brand, manual.model].filter(Boolean).join(" ").trim();
  if (!text) return;
  emit("add-targets", [text]);
  manual.brand = "";
  manual.model = "";
}

function applyPaste() {
  const lines = pasteText.value
    .split(/\r?\n|[,，;]/)
    .map((item) => item.trim())
    .filter(Boolean);
  emit("add-targets", lines);
  pasteText.value = "";
  pasteDialog.value = false;
}

function toggleTemplate(key) {
  selectedTemplateKeys.value = selectedTemplateKeys.value.includes(key)
    ? selectedTemplateKeys.value.filter((item) => item !== key)
    : [...selectedTemplateKeys.value, key];
}

function applyTemplates() {
  const nextRows = [];
  props.templates.forEach((group) => {
    group.models.forEach((model) => {
      const key = `${group.brand}-${model}`;
      if (selectedTemplateKeys.value.includes(key)) nextRows.push(`${group.brand} ${model}`);
    });
  });
  emit("add-targets", nextRows);
  templateDialog.value = false;
}

function applyImport() {
  emit("add-targets", selectedProductRows.value.map((row) => ({
    brand: row.brand || "",
    model: row.vehicle_model || "",
    displayName: row.vehicle_model || row.name || "",
    logoText: row.vehicle_model || ""
  })));
  importDialog.value = false;
}

function addPlan(style = "高级原厂风") {
  emit("add-plan", { name: style, style });
}

function onDrop(targetId) {
  if (!dragId.value || dragId.value === targetId) return;
  const ids = rows.value.map((item) => item.id);
  const from = ids.indexOf(dragId.value);
  const to = ids.indexOf(targetId);
  if (from < 0 || to < 0) return;
  const [moved] = ids.splice(from, 1);
  ids.splice(to, 0, moved);
  emit("reorder", ids);
  dragId.value = "";
}
</script>

<template>
  <section class="work-card">
    <div class="section-head">
      <span>02</span>
      <strong>{{ isMainPlan ? "主图方案" : "目标车型" }}</strong>
    </div>

    <div v-if="isMainPlan" class="plan-actions">
      <el-button class="erp-btn erp-btn-secondary" @click="addPlan('高级原厂风')">高级原厂风</el-button>
      <el-button class="erp-btn erp-btn-secondary" @click="addPlan('白底清晰风')">白底清晰风</el-button>
      <el-button class="erp-btn erp-btn-secondary" @click="addPlan('安装场景风')">安装场景风</el-button>
      <el-button class="erp-btn erp-btn-primary" type="primary" :icon="Plus" @click="addPlan('自定义 Prompt')">添加方案</el-button>
    </div>

    <div v-else class="target-actions">
      <el-input v-model="manual.brand" placeholder="品牌" />
      <el-input v-model="manual.model" placeholder="车型" @keyup.enter="addManual" />
      <el-button class="erp-btn erp-btn-primary" type="primary" :icon="Plus" @click="addManual">添加车型</el-button>
      <el-button class="erp-btn erp-btn-secondary" @click="pasteDialog = true">批量粘贴</el-button>
      <el-button class="erp-btn erp-btn-secondary" @click="templateDialog = true">常用模板</el-button>
      <el-button class="erp-btn erp-btn-secondary" @click="importDialog = true">从选品表导入</el-button>
    </div>

    <div class="target-chip-list">
      <div
        v-for="row in rows"
        :key="row.id"
        class="target-chip"
        draggable="true"
        @dragstart="dragId = row.id"
        @dragover.prevent
        @drop="onDrop(row.id)"
      >
        <el-icon><Rank /></el-icon>
        <span>{{ display(row) }}</span>
        <button type="button" aria-label="删除" @click="$emit('remove', row.id)">×</button>
      </div>
      <div v-if="!rows.length" class="empty-inline">还没有目标，先添加车型或主图方案。</div>
    </div>

    <el-dialog v-model="pasteDialog" title="批量粘贴车型" width="560px" align-center>
      <el-input v-model="pasteText" type="textarea" :rows="10" placeholder="TENET T4&#10;TENET T7&#10;BELGEE X70" />
      <template #footer>
        <el-button class="erp-btn erp-btn-secondary" @click="pasteDialog = false">取消</el-button>
        <el-button class="erp-btn erp-btn-primary" type="primary" @click="applyPaste">加入列表</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="templateDialog" title="常用车型模板" width="720px" align-center>
      <div class="template-grid">
        <section v-for="group in templates" :key="group.brand">
          <strong>{{ group.brand }}</strong>
          <div>
            <el-check-tag
              v-for="model in group.models"
              :key="`${group.brand}-${model}`"
              :checked="selectedTemplateKeys.includes(`${group.brand}-${model}`)"
              @change="toggleTemplate(`${group.brand}-${model}`)"
            >
              {{ model }}
            </el-check-tag>
          </div>
        </section>
      </div>
      <template #footer>
        <el-button class="erp-btn erp-btn-secondary" @click="templateDialog = false">取消</el-button>
        <el-button class="erp-btn erp-btn-primary" type="primary" @click="applyTemplates">一键加入</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="importDialog" title="从选品表导入车型" width="880px" align-center>
      <el-table :data="products" max-height="420" border stripe @selection-change="selectedProductRows = $event">
        <el-table-column type="selection" width="46" />
        <el-table-column label="商品" min-width="260">
          <template #default="{ row }">
            <div class="product-line">
              <ProductImagePreview :src="row.image_url" size="square" fit="cover" />
              <span><strong>{{ row.name }}</strong><em>{{ row.selection_id || row.code }}</em></span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="vehicle_model" label="车型" min-width="180" />
      </el-table>
      <template #footer>
        <el-button class="erp-btn erp-btn-secondary" @click="importDialog = false">取消</el-button>
        <el-button class="erp-btn erp-btn-primary" type="primary" @click="applyImport">导入车型</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.work-card {
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.78);
  box-shadow: 0 12px 28px rgba(15, 23, 42, 0.06);
  padding: 14px;
}

.section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.section-head span {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  background: #0f172a;
  color: #fff;
  font-size: 12px;
  font-weight: 700;
}

.target-actions {
  display: grid;
  grid-template-columns: 1fr 1fr auto auto auto auto;
  gap: 8px;
  margin-bottom: 12px;
}

.plan-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.target-chip-list {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  min-height: 58px;
  padding: 10px;
  border-radius: 8px;
  background: #f3f7fb;
  border: 1px dashed #cbd5e1;
}

.target-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 100%;
  height: 34px;
  padding: 0 8px;
  border-radius: 7px;
  background: #0f172a;
  color: #fff;
  cursor: grab;
}

.target-chip span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.target-chip button {
  border: 0;
  background: transparent;
  color: #cbd5e1;
  cursor: pointer;
  font-size: 17px;
}

.empty-inline {
  color: #64748b;
  font-size: 13px;
}

.template-grid {
  display: grid;
  gap: 14px;
}

.template-grid section {
  display: grid;
  grid-template-columns: 90px minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}

.template-grid section > div {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.product-line {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
}

.product-line span {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.product-line strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.product-line em {
  color: #64748b;
  font-size: 12px;
  font-style: normal;
}

@media (max-width: 1400px) {
  .target-actions {
    grid-template-columns: 1fr 1fr;
  }
}
</style>
