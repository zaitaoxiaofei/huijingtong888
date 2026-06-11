<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { CopyDocument, Delete, MagicStick, Plus, Refresh, Search, Star, View } from "@element-plus/icons-vue";
import {
  createAiPromptTemplate,
  deleteAiPromptTemplate,
  duplicateAiPromptTemplate,
  listAiPromptTemplates,
  renderAiPromptTemplate,
  setDefaultAiPromptTemplate,
  updateAiPromptTemplate
} from "../../api/settings/aiPromptTemplates";

const assetStages = [
  {
    key: "main_image",
    label: "主图",
    scene: "main_image_variant",
    mode: "image_to_image",
    summary: "先抓点击",
    objective: "提升点击率，强化主体、车型、材质和第一眼卖点。",
    examples: ["高点击主图", "白底清晰图", "车型替换图"],
    promptLabel: "主图生成要求"
  },
  {
    key: "detail_image",
    label: "详情图",
    scene: "detail_image",
    mode: "image_to_image",
    summary: "再提转化",
    objective: "解释卖点、安装、尺寸、材质和套装信息，降低买家决策成本。",
    examples: ["卖点说明图", "安装步骤图", "尺寸对比图"],
    promptLabel: "详情图生成要求"
  },
  {
    key: "title",
    label: "标题",
    scene: "title_generation",
    mode: "text",
    summary: "补搜索词",
    objective: "覆盖品牌、车型、类目、材质和功能词，提高搜索曝光。",
    examples: ["高搜索标题", "车型前置标题", "类目长尾标题"],
    promptLabel: "标题生成规则"
  },
  {
    key: "tags",
    label: "标签",
    scene: "tag_generation",
    mode: "text",
    summary: "扩关键词",
    objective: "围绕品牌、车型、类目、材质、功能和使用场景扩展搜索标签。",
    examples: ["品牌车型标签", "类目标签", "材质功能标签"],
    promptLabel: "标签生成规则"
  },
  {
    key: "description",
    label: "描述",
    scene: "description_generation",
    mode: "text",
    summary: "讲清价值",
    objective: "把适配关系、卖点、安装和购买理由写清楚，服务详情页与富文本。",
    examples: ["卖点描述", "适配说明", "富文本草稿"],
    promptLabel: "描述生成规则"
  }
];

const extraScenes = [
  { label: "Logo/文字替换", value: "logo_text_replace", assetKey: "main_image", mode: "inpaint" },
  { label: "全局负向规则", value: "global_negative", assetKey: "main_image", mode: "global" }
];

const sceneOptions = [
  ...assetStages.map((item) => ({ label: item.label, value: item.scene, assetKey: item.key, mode: item.mode })),
  ...extraScenes
];

const modeOptions = [
  { label: "图生图", value: "image_to_image" },
  { label: "文生图", value: "text_to_image" },
  { label: "局部替换", value: "inpaint" },
  { label: "文本生成", value: "text" },
  { label: "全局规则", value: "global" }
];

const ratioOptions = ["3:4", "1:1", "4:5", "16:9"];
const defaultVariables = [
  "product_name",
  "brand",
  "target_brand",
  "target_model",
  "ozon_category",
  "material",
  "color",
  "selling_points",
  "main_image_style",
  "detail_image_type",
  "title_keywords",
  "tags_keywords",
  "description_points",
  "user_prompt",
  "ratio"
];

const loading = ref(false);
const saving = ref(false);
const templates = ref([]);
const activeId = ref(null);
const query = reactive({
  keyword: "",
  asset: "main_image",
  enabled: ""
});

const form = reactive(createEmptyForm());
const preview = reactive({
  visible: false,
  loading: false,
  positive: "",
  negative: "",
  missing: []
});

const sceneMap = computed(() => new Map(sceneOptions.map((item) => [item.value, item])));
const modeMap = computed(() => new Map(modeOptions.map((item) => [item.value, item.label])));
const activeAsset = computed(() => assetStages.find((item) => item.key === query.asset) || assetStages[0]);
const activeSceneValues = computed(() => sceneOptions.filter((item) => item.assetKey === activeAsset.value.key).map((item) => item.value));
const activeTemplates = computed(() => templates.value.filter((item) => activeSceneValues.value.includes(item.scene)));
const activeTemplate = computed(() => templates.value.find((item) => item.id === activeId.value) || null);

const filteredTemplates = computed(() => {
  const keyword = query.keyword.trim().toLowerCase();
  return activeTemplates.value.filter((item) => {
    if (query.enabled !== "" && Number(item.enabled) !== Number(query.enabled)) return false;
    if (!keyword) return true;
    return [item.name, item.description, item.positive_prompt, item.negative_prompt]
      .some((value) => String(value || "").toLowerCase().includes(keyword));
  });
});

const statCards = computed(() => assetStages.map((asset) => {
  const scenes = sceneOptions.filter((item) => item.assetKey === asset.key).map((item) => item.value);
  const count = templates.value.filter((item) => scenes.includes(item.scene)).length;
  const enabled = templates.value.filter((item) => scenes.includes(item.scene) && item.enabled).length;
  return { ...asset, count, enabled };
}));

const variableText = computed({
  get: () => form.variables.join("\n"),
  set: (value) => {
    form.variables = String(value || "")
      .split(/[\n,，]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
});

function createEmptyForm() {
  return {
    id: null,
    name: "",
    scene: "main_image_variant",
    mode: "image_to_image",
    description: "",
    positive_prompt: "",
    negative_prompt: "",
    variables: [...defaultVariables],
    default_ratio: "3:4",
    default_count: 1,
    is_default: 0,
    enabled: 1,
    sort_order: 100,
    updatedAt: ""
  };
}

function sceneLabel(scene) {
  return sceneMap.value.get(scene)?.label || scene || "-";
}

function sceneAssetKey(scene) {
  return sceneMap.value.get(scene)?.assetKey || "main_image";
}

function resetForm(payload = createEmptyForm()) {
  Object.assign(form, createEmptyForm(), payload, {
    variables: Array.isArray(payload.variables) && payload.variables.length ? [...payload.variables] : [...defaultVariables],
    default_count: Number(payload.default_count || payload.defaultCount || 1),
    is_default: Number(payload.is_default || payload.isDefault || 0),
    enabled: Number(payload.enabled ?? 1),
    sort_order: Number(payload.sort_order || payload.sortOrder || 0),
    updatedAt: payload.updated_at || payload.updatedAt || ""
  });
}

function selectTemplate(item) {
  activeId.value = item.id;
  query.asset = sceneAssetKey(item.scene);
  resetForm(item);
}

function createNewTemplate(assetKey = query.asset) {
  const asset = assetStages.find((item) => item.key === assetKey) || assetStages[0];
  activeId.value = null;
  resetForm({
    ...createEmptyForm(),
    scene: asset.scene,
    mode: asset.mode,
    name: `${asset.label}模板`,
    description: asset.objective
  });
}

function selectAsset(assetKey) {
  query.asset = assetKey;
  const first = filteredTemplates.value[0] || activeTemplates.value[0];
  if (first) selectTemplate(first);
  else createNewTemplate(assetKey);
}

async function loadTemplates() {
  loading.value = true;
  try {
    templates.value = await listAiPromptTemplates();
    const matched = activeId.value ? templates.value.find((item) => item.id === activeId.value) : null;
    if (matched) selectTemplate(matched);
    else selectAsset(query.asset);
  } catch (error) {
    ElMessage.error(error.message || "AI提示词库加载失败");
  } finally {
    loading.value = false;
  }
}

function normalizePayload() {
  return {
    ...form,
    variables: [...form.variables],
    default_count: Number(form.default_count || 1),
    is_default: Number(form.is_default || 0),
    enabled: Number(form.enabled || 0),
    sort_order: Number(form.sort_order || 0)
  };
}

async function saveTemplate() {
  if (!form.name.trim()) {
    ElMessage.warning("请先填写策略名称");
    return;
  }
  saving.value = true;
  try {
    const payload = normalizePayload();
    const saved = form.id
      ? await updateAiPromptTemplate(form.id, payload)
      : await createAiPromptTemplate(payload);
    ElMessage.success("提示词模板已保存");
    activeId.value = saved.id;
    await loadTemplates();
  } catch (error) {
    ElMessage.error(error.message || "保存失败");
  } finally {
    saving.value = false;
  }
}

async function duplicateTemplate(item = activeTemplate.value) {
  if (!item?.id) return;
  try {
    const saved = await duplicateAiPromptTemplate(item.id);
    ElMessage.success("已复制模板");
    activeId.value = saved.id;
    await loadTemplates();
  } catch (error) {
    ElMessage.error(error.message || "复制失败");
  }
}

async function markDefault(item = activeTemplate.value) {
  if (!item?.id) return;
  try {
    const saved = await setDefaultAiPromptTemplate(item.id);
    activeId.value = saved.id;
    ElMessage.success("已设为默认模板");
    await loadTemplates();
  } catch (error) {
    ElMessage.error(error.message || "设置默认失败");
  }
}

async function removeTemplate(item = activeTemplate.value) {
  if (!item?.id) return;
  try {
    await ElMessageBox.confirm(`确认删除「${item.name}」？`, "删除提示词模板", {
      type: "warning",
      confirmButtonText: "删除",
      cancelButtonText: "取消"
    });
  } catch {
    return;
  }
  try {
    await deleteAiPromptTemplate(item.id);
    ElMessage.success("已删除模板");
    activeId.value = null;
    await loadTemplates();
  } catch (error) {
    ElMessage.error(error.message || "删除失败");
  }
}

function createPreviewVariables() {
  return Object.fromEntries(form.variables.map((key) => [key, sampleVariableValue(key)]));
}

function sampleVariableValue(key) {
  const samples = {
    product_name: "汽车门槛条",
    brand: "TENET",
    target_brand: "TENET",
    target_model: "T7",
    ozon_category: "汽车内饰配件",
    material: "不锈钢",
    color: "银色",
    selling_points: "防刮耐磨、无损安装、贴合原车弧度",
    main_image_style: "高点击电商主图",
    detail_image_type: "安装步骤图",
    title_keywords: "TENET T7 门槛条 防刮 不锈钢",
    tags_keywords: "TENET T7, 门槛条, 汽车配件, 防刮",
    description_points: "材质、安装方式、适配车型、套装数量",
    user_prompt: "主体更清晰，突出金属质感，避免水印",
    ratio: form.default_ratio
  };
  return samples[key] || key;
}

async function previewTemplate() {
  preview.visible = true;
  preview.loading = true;
  try {
    const result = await renderAiPromptTemplate({
      template: normalizePayload(),
      variables: createPreviewVariables()
    });
    preview.positive = result.finalPositivePrompt || "";
    preview.negative = result.finalNegativePrompt || "";
    preview.missing = result.missingVariables || [];
  } catch (error) {
    ElMessage.error(error.message || "预览失败");
  } finally {
    preview.loading = false;
  }
}

watch(() => form.scene, (scene) => {
  const sceneConfig = sceneMap.value.get(scene);
  if (sceneConfig?.mode && !form.id) form.mode = sceneConfig.mode;
});

onMounted(loadTemplates);
</script>

<template>
  <main class="ai-prompt-library">
    <section class="page-head">
      <div>
        <span>商品 AI 资产库</span>
        <h1>AI提示词库</h1>
        <p>按主图、详情图、标题、标签、描述沉淀模板，让 AI优化新版直接调用成熟提示词。</p>
      </div>
      <div class="head-actions">
        <el-button class="erp-btn erp-btn-secondary" :icon="Refresh" :loading="loading" @click="loadTemplates">刷新</el-button>
        <el-button class="erp-btn erp-btn-primary" :icon="Plus" @click="createNewTemplate()">新建模板</el-button>
      </div>
    </section>

    <section class="asset-tabs" aria-label="AI提示词资产类型">
      <button
        v-for="item in statCards"
        :key="item.key"
        type="button"
        :class="{ active: query.asset === item.key }"
        @click="selectAsset(item.key)"
      >
        <span>{{ item.summary }}</span>
        <strong>{{ item.label }}</strong>
        <em>{{ item.enabled }} 个启用 / {{ item.count }} 个模板</em>
      </button>
    </section>

    <section class="asset-context">
      <div>
        <span>{{ activeAsset.label }}业务逻辑</span>
        <strong>{{ activeAsset.objective }}</strong>
      </div>
      <ul>
        <li v-for="item in activeAsset.examples" :key="item">{{ item }}</li>
      </ul>
    </section>

    <section class="library-workbench">
      <aside class="template-column">
        <div class="column-tools">
          <el-input v-model="query.keyword" :prefix-icon="Search" clearable placeholder="搜索当前资产模板" />
          <el-segmented
            v-model="query.enabled"
            :options="[
              { label: '全部', value: '' },
              { label: '启用', value: 1 },
              { label: '停用', value: 0 }
            ]"
          />
        </div>

        <div v-loading="loading" class="template-list">
          <button
            v-for="item in filteredTemplates"
            :key="item.id"
            type="button"
            :class="{ active: item.id === activeId }"
            @click="selectTemplate(item)"
          >
            <span>{{ sceneLabel(item.scene) }} · {{ modeMap.get(item.mode) || item.mode }}</span>
            <strong>{{ item.name }}</strong>
            <em>{{ item.description || "未填写业务说明" }}</em>
            <small>
              <el-tag v-if="item.is_default" size="small" type="success">默认</el-tag>
              <el-tag v-if="!item.enabled" size="small" type="info">停用</el-tag>
            </small>
          </button>
          <el-empty v-if="!loading && !filteredTemplates.length" description="当前资产暂无模板" />
        </div>
      </aside>

      <section class="editor-pane">
        <div class="editor-toolbar">
          <div>
            <span>{{ form.id ? `策略 ID ${form.id}` : "新建策略" }}</span>
            <strong>{{ form.name || "未命名策略" }}</strong>
          </div>
          <div>
            <el-button class="erp-btn erp-btn-secondary" :icon="View" @click="previewTemplate">预览</el-button>
            <el-button class="erp-btn erp-btn-secondary" :icon="CopyDocument" :disabled="!form.id" @click="duplicateTemplate()">复制</el-button>
            <el-button class="erp-btn erp-btn-secondary" :icon="Star" :disabled="!form.id" @click="markDefault()">默认</el-button>
            <el-button class="erp-btn erp-btn-danger" :icon="Delete" :disabled="!form.id" @click="removeTemplate()">删除</el-button>
            <el-button class="erp-btn erp-btn-primary" :loading="saving" :icon="MagicStick" @click="saveTemplate">保存</el-button>
          </div>
        </div>

        <el-form label-position="top" class="editor-form">
          <section class="business-form">
            <el-form-item class="field-name" label="策略名称">
              <el-input v-model="form.name" maxlength="120" show-word-limit placeholder="例如：门槛条主图-高点击原厂风" />
            </el-form-item>
            <el-form-item label="适用资产">
              <el-select v-model="form.scene">
                <el-option v-for="item in sceneOptions" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
            </el-form-item>
            <el-form-item label="生成模式">
              <el-select v-model="form.mode">
                <el-option v-for="item in modeOptions" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
            </el-form-item>
            <el-form-item label="默认比例">
              <el-select v-model="form.default_ratio">
                <el-option v-for="item in ratioOptions" :key="item" :label="item" :value="item" />
              </el-select>
            </el-form-item>
            <el-form-item label="默认数量">
              <el-input-number v-model="form.default_count" :min="1" :max="8" controls-position="right" />
            </el-form-item>
            <el-form-item label="排序">
              <el-input-number v-model="form.sort_order" :min="-999999" :max="999999" controls-position="right" />
            </el-form-item>
            <el-form-item class="field-description" label="业务说明">
              <el-input
                v-model="form.description"
                type="textarea"
                :rows="2"
                placeholder="写清适合什么类目、什么问题、什么生成方向。"
              />
            </el-form-item>
            <div class="field-switches">
              <el-checkbox v-model="form.enabled" :true-value="1" :false-value="0">启用模板</el-checkbox>
              <el-checkbox v-model="form.is_default" :true-value="1" :false-value="0">作为当前资产默认模板</el-checkbox>
            </div>
          </section>

          <section class="prompt-editor">
            <div class="prompt-block">
              <div>
                <strong>{{ activeAsset.promptLabel }}</strong>
                <span>写给 AI 的核心生成任务，尽量按产品信息、场景、构图、卖点、输出要求分行。</span>
              </div>
              <el-input
                v-model="form.positive_prompt"
                type="textarea"
                :rows="18"
                placeholder="例如：使用参考图作为商品主体；保留结构和材质；突出车型、材质、核心卖点；生成适合 Ozon 的电商图。"
              />
            </div>

            <div class="prompt-block">
              <div>
                <strong>禁止事项</strong>
                <span>统一管理水印、虚假认证、错误文字、主体变形、误导性元素等限制。</span>
              </div>
              <el-input
                v-model="form.negative_prompt"
                type="textarea"
                :rows="18"
                placeholder="例如：No watermark. No fake certification. No distorted product shape. No unreadable text."
              />
            </div>

            <div class="prompt-block variable-row">
              <div>
                <strong>变量维护</strong>
                <span>变量会在 AI优化新版调用模板时由商品信息自动填充。</span>
              </div>
              <el-input v-model="variableText" type="textarea" :rows="4" placeholder="每行一个变量名，例如 product_name、target_model、selling_points。" />
            </div>
          </section>
        </el-form>
      </section>
    </section>

    <el-dialog v-model="preview.visible" title="Prompt 预览" width="860px" align-center>
      <div v-loading="preview.loading" class="preview-dialog">
        <el-alert v-if="preview.missing.length" type="warning" :closable="false" show-icon>
          <template #title>缺少变量：{{ preview.missing.join("、") }}</template>
        </el-alert>
        <article>
          <strong>正向 Prompt</strong>
          <pre>{{ preview.positive || "-" }}</pre>
        </article>
        <article>
          <strong>负向 Prompt</strong>
          <pre>{{ preview.negative || "-" }}</pre>
        </article>
      </div>
    </el-dialog>
  </main>
</template>

<style scoped>
.ai-prompt-library {
  display: grid;
  grid-template-rows: auto auto auto minmax(0, 1fr);
  gap: 12px;
  min-height: 100%;
  padding: 16px;
  background: #f5f7fb;
}

.page-head,
.asset-context,
.library-workbench {
  border: 1px solid #e4eaf2;
  border-radius: 8px;
  background: #fff;
}

.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  padding: 16px;
}

.page-head span,
.asset-context span,
.editor-toolbar span,
.template-list button span,
.prompt-block span {
  color: #667085;
  font-size: 12px;
}

.page-head h1 {
  margin: 3px 0;
  color: #101828;
  font-size: 24px;
}

.page-head p,
.asset-context strong {
  margin: 0;
  color: #475467;
  line-height: 1.5;
}

.head-actions,
.editor-toolbar > div:last-child {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.asset-tabs {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
}

.asset-tabs button {
  display: grid;
  gap: 4px;
  min-height: 82px;
  padding: 12px;
  border: 1px solid #e4eaf2;
  border-radius: 8px;
  background: #fff;
  color: #344054;
  text-align: left;
  cursor: pointer;
}

.asset-tabs button.active {
  border-color: #409eff;
  background: #eef6ff;
  color: #175cd3;
}

.asset-tabs span,
.asset-tabs em {
  color: #667085;
  font-size: 12px;
  font-style: normal;
}

.asset-tabs strong {
  color: #101828;
  font-size: 20px;
}

.asset-context {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 12px 16px;
}

.asset-context div {
  display: grid;
  gap: 3px;
}

.asset-context ul {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
  margin: 0;
  padding: 0;
  list-style: none;
}

.asset-context li {
  padding: 5px 9px;
  border-radius: 999px;
  background: #f2f4f7;
  color: #344054;
  font-size: 12px;
}

.library-workbench {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  min-height: 0;
  overflow: hidden;
}

.template-column {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-height: 0;
  border-right: 1px solid #edf1f7;
}

.column-tools {
  display: grid;
  gap: 10px;
  padding: 12px;
  border-bottom: 1px solid #edf1f7;
}

.template-list {
  display: grid;
  align-content: start;
  gap: 8px;
  min-height: 0;
  overflow: auto;
  padding: 12px;
}

.template-list button {
  display: grid;
  gap: 5px;
  width: 100%;
  padding: 12px;
  border: 1px solid #e4eaf2;
  border-radius: 8px;
  background: #fbfdff;
  color: #344054;
  text-align: left;
  cursor: pointer;
}

.template-list button.active {
  border-color: #409eff;
  background: #eef6ff;
}

.template-list strong {
  overflow: hidden;
  color: #101828;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.template-list em {
  display: -webkit-box;
  overflow: hidden;
  color: #667085;
  font-size: 12px;
  font-style: normal;
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.template-list small {
  display: flex;
  gap: 6px;
  min-height: 22px;
}

.editor-pane {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
}

.editor-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid #edf1f7;
}

.editor-toolbar > div:first-child {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.editor-toolbar strong {
  overflow: hidden;
  color: #101828;
  font-size: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.editor-form {
  display: grid;
  gap: 12px;
  min-height: 0;
  overflow: auto;
  padding: 12px;
}

.business-form {
  display: grid;
  grid-template-columns: minmax(260px, 1.25fr) 150px 150px 128px 116px 116px;
  gap: 10px;
  align-items: stretch;
  padding: 12px;
  border: 1px solid #edf1f7;
  border-radius: 8px;
  background: #fbfdff;
}

.business-form :deep(.el-form-item) {
  margin-bottom: 0;
}

.business-form :deep(.el-form-item__label) {
  min-height: 22px;
  padding-bottom: 4px;
  line-height: 18px;
}

.business-form :deep(.el-input),
.business-form :deep(.el-select),
.business-form :deep(.el-input-number) {
  width: 100%;
}

.business-form :deep(.el-input__wrapper),
.business-form :deep(.el-select__wrapper),
.business-form :deep(.el-input-number .el-input__wrapper) {
  min-height: 32px;
}

.field-description {
  grid-column: 1 / span 4;
}

.field-switches {
  display: flex;
  align-items: center;
  gap: 18px;
  grid-column: span 2;
  min-height: 56px;
  padding-top: 22px;
}

.prompt-editor {
  display: grid;
  gap: 10px;
}

.prompt-block {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr);
  gap: 8px;
  align-items: stretch;
  min-width: 0;
  padding: 12px;
  border: 1px solid #edf1f7;
  border-radius: 8px;
  background: #fff;
}

.prompt-block > div {
  display: grid;
  gap: 5px;
  align-content: start;
  padding-top: 2px;
}

.prompt-block strong {
  color: #344054;
  font-size: 14px;
}

.prompt-block :deep(.el-textarea__inner) {
  min-height: 210px !important;
  resize: vertical;
}

.variable-row :deep(.el-textarea__inner) {
  min-height: 92px !important;
}

.preview-dialog {
  display: grid;
  gap: 12px;
}

.preview-dialog article {
  display: grid;
  gap: 8px;
}

.preview-dialog strong {
  color: #344054;
}

pre {
  max-height: 300px;
  overflow: auto;
  margin: 0;
  padding: 12px;
  border-radius: 8px;
  background: #f6f8fb;
  color: #344054;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

@media (max-width: 1280px) {
  .asset-tabs {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .library-workbench {
    grid-template-columns: 290px minmax(0, 1fr);
  }

  .business-form {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .field-description,
  .field-switches {
    grid-column: 1 / -1;
  }

  .prompt-block {
    grid-template-columns: 160px minmax(0, 1fr);
  }
}

@media (max-width: 860px) {
  .page-head,
  .editor-toolbar,
  .asset-context {
    align-items: stretch;
    grid-template-columns: 1fr;
    flex-direction: column;
  }

  .asset-context ul {
    justify-content: flex-start;
  }

  .asset-tabs,
  .library-workbench,
  .business-form,
  .prompt-block {
    grid-template-columns: 1fr;
  }

  .field-description,
  .field-switches {
    grid-column: auto;
  }

  .field-switches {
    min-height: auto;
    padding-top: 0;
  }

  .template-column {
    border-right: 0;
    border-bottom: 1px solid #edf1f7;
  }
}
</style>
