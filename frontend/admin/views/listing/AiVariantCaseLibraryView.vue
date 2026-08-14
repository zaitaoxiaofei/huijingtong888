<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Delete, Position, Refresh, Search, View } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import { openAiVariantLabWindow } from "../../utils/ai-variant-lab-window";
import { shanghaiDateTimeText } from "../../utils/shanghai-date";

const loading = ref(false);
const detailLoading = ref(false);
const detailVisible = ref(false);
const detailTab = ref("reuse");
const cases = ref([]);
const activeCase = ref(null);
const deletingCaseNo = ref("");
const viewportHeight = ref(typeof window === "undefined" ? 900 : window.innerHeight);

const filters = reactive({
  keyword: "",
  status: "",
  variantType: ""
});

const pagination = reactive({
  page: 1,
  pageSize: 20,
  total: 0
});

const quickReuse = reactive({
  targetValues: "",
  offerPrefix: ""
});

const tableHeight = computed(() => Math.max(360, viewportHeight.value - 430));
const activeCaseJson = computed(() => activeCase.value?.case_json || {});
const listingSnapshot = computed(() => activeCaseJson.value.listing_template_snapshot || {});
const sampleAssets = computed(() => activeCaseJson.value.sample_assets || {});
const sampleOutputs = computed(() => activeCaseJson.value.sample_outputs || {});
const productFacts = computed(() => activeCaseJson.value.product_facts || {});
const variantContract = computed(() => activeCaseJson.value.variant_contract || {});
const sourceTrace = computed(() => activeCaseJson.value.source_trace || {});

onMounted(() => {
  updateViewportHeight();
  window.addEventListener("resize", updateViewportHeight);
  void loadCases();
});

onUnmounted(() => {
  window.removeEventListener("resize", updateViewportHeight);
});

function updateViewportHeight() {
  viewportHeight.value = window.innerHeight || viewportHeight.value;
}

async function loadCases() {
  loading.value = true;
  try {
    const params = new URLSearchParams({
      page: String(pagination.page),
      pageSize: String(pagination.pageSize)
    });
    if (filters.keyword) params.set("keyword", filters.keyword);
    if (filters.status) params.set("status", filters.status);
    if (filters.variantType) params.set("variantType", filters.variantType);
    const result = await apiClient.get(`/api/ai-variant-lab/cases?${params.toString()}`, { noCache: true });
    cases.value = result.cases || [];
    pagination.total = Number(result.total ?? cases.value.length);
    pagination.page = Number(result.page || pagination.page);
    pagination.pageSize = Number(result.pageSize || pagination.pageSize);
  } catch (error) {
    ElMessage.error(error.message || "加载案例库失败");
  } finally {
    loading.value = false;
  }
}

async function openDetail(row, tab = "overview") {
  if (!row?.case_no) return;
  detailVisible.value = true;
  detailTab.value = tab;
  detailLoading.value = true;
  try {
    const result = await apiClient.get(`/api/ai-variant-lab/cases/${encodeURIComponent(row.case_no)}`, { noCache: true });
    activeCase.value = result.case || row;
    quickReuse.targetValues = "";
    quickReuse.offerPrefix = "";
  } catch (error) {
    ElMessage.error(error.message || "加载案例详情失败");
  } finally {
    detailLoading.value = false;
  }
}

function searchCases() {
  pagination.page = 1;
  void loadCases();
}

function resetFilters() {
  filters.keyword = "";
  filters.status = "";
  filters.variantType = "";
  pagination.page = 1;
  void loadCases();
}

function changePage(page) {
  pagination.page = page;
  void loadCases();
}

function changePageSize(pageSize) {
  pagination.pageSize = pageSize;
  pagination.page = 1;
  void loadCases();
}

function startQuickReuse(row = activeCase.value) {
  const caseNo = String(row?.case_no || "").trim();
  const targets = parseTargetValues(quickReuse.targetValues);
  if (!caseNo) {
    ElMessage.warning("请先选择一个案例。");
    return;
  }
  if (!targets.length) {
    ElMessage.warning("请先填写要裂变的新型号，一行一个。");
    return;
  }
  openAiVariantLabWindow({
    source: "case",
    caseNo,
    caseTargets: targets.join("\n"),
    offerPrefix: quickReuse.offerPrefix,
    importAt: Date.now()
  });
  ElMessage.success("已打开 AI 裂变生成队列");
}

async function deleteCase(row) {
  const caseNo = String(row?.case_no || "").trim();
  if (!caseNo) return;
  const confirmed = await ElMessageBox.confirm(
    `确定删除案例「${row.case_name || caseNo}」吗？删除后将不再出现在案例库列表中。`,
    "删除案例",
    { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" }
  ).then(() => true).catch(() => false);
  if (!confirmed) return;
  deletingCaseNo.value = caseNo;
  try {
    await apiClient.delete(`/api/ai-variant-lab/cases/${encodeURIComponent(caseNo)}`);
    ElMessage.success("案例已删除");
    if (activeCase.value?.case_no === caseNo) {
      detailVisible.value = false;
      activeCase.value = null;
    }
    await loadCases();
  } catch (error) {
    ElMessage.error(error.message || "删除案例失败");
  } finally {
    deletingCaseNo.value = "";
  }
}

function parseTargetValues(value) {
  const seen = new Set();
  return String(value || "")
    .split(/[,\n;，；、/|]+/)
    .map((item) => item.trim())
    .filter((item) => {
      const key = item.toLowerCase();
      if (!item || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function imageFromCase(row, key) {
  const payload = row?.case_json || {};
  const assets = payload.sample_assets || {};
  const sampleRows = Array.isArray(payload.sample_rows) ? payload.sample_rows : [];
  const firstSample = sampleRows[0] || {};
  if (key === "source") {
    return firstUrl(
      assets.source_image_url,
      payload.listing_template_snapshot?.media_context?.images?.[0],
      firstSample.row_snapshot?.source_main_image_url
    );
  }
  return firstStableUrl(
    firstSample.assets?.main_image?.publishUrl,
    firstSample.assets?.main_image?.url,
    firstSample.assets?.main_image?.localUrl,
    firstSample.assets?.main_image?.downloadUrl,
    assets.generated_main_image_asset_url,
    assets.generated_main_image_url,
    firstSample.generated_main_image_url,
    firstSample.generated_main_image_original_url
  );
}

function firstUrl(...values) {
  return values.map((value) => String(value || "").trim()).find(Boolean) || "";
}

function isTemporaryAiImageUrl(value) {
  return /\/api\/ai\/file\//i.test(String(value || ""));
}

function firstStableUrl(...values) {
  const urls = values.map((value) => String(value || "").trim()).filter(Boolean);
  return urls.find((value) => !isTemporaryAiImageUrl(value)) || urls[0] || "";
}

function templateHealthText(snapshot = {}) {
  if (snapshot.template_payload) return "可关联草稿模板";
  return "缺少草稿模板";
}

function variantTypeText(value) {
  return {
    vehicle_model_swap: "车型裂变",
    logo_swap: "Logo裂变",
    color_swap: "颜色裂变",
    audience_variant: "人群裂变"
  }[value] || value || "-";
}

function statusText(value) {
  return { active: "启用", pending: "待验证", disabled: "停用" }[value] || value || "-";
}

function statusTagType(value) {
  return { active: "success", pending: "warning", disabled: "info" }[value] || "info";
}

function tagsText(value) {
  return Array.isArray(value) ? value.join(", ") : String(value || "");
}
</script>

<template>
  <div class="case-library-page">
    <header class="page-header">
      <div>
        <h1>裂变案例</h1>
        <p>沉淀可复用的成功案例，后续直接填写新型号进入 AI 裂变生成队列。</p>
      </div>
      <el-button :icon="Refresh" :loading="loading" @click="loadCases">刷新</el-button>
    </header>

    <section class="filter-panel">
      <el-input v-model="filters.keyword" :prefix-icon="Search" clearable placeholder="搜索案例名称、产品、源车型、目标车型" @keyup.enter="searchCases" />
      <el-select v-model="filters.variantType" clearable placeholder="裂变类型">
        <el-option label="车型裂变" value="vehicle_model_swap" />
        <el-option label="Logo裂变" value="logo_swap" />
        <el-option label="颜色裂变" value="color_swap" />
        <el-option label="人群裂变" value="audience_variant" />
      </el-select>
      <el-select v-model="filters.status" clearable placeholder="状态">
        <el-option label="启用" value="active" />
        <el-option label="待验证" value="pending" />
        <el-option label="停用" value="disabled" />
      </el-select>
      <el-button type="primary" :loading="loading" @click="searchCases">查询</el-button>
      <el-button @click="resetFilters">重置</el-button>
    </section>

    <section class="table-panel">
      <el-table v-loading="loading" :data="cases" border class="case-table" row-key="case_no" :height="tableHeight">
        <el-table-column label="参考图" width="156" fixed>
          <template #default="{ row }">
            <div class="image-pair">
              <el-image v-if="imageFromCase(row, 'source')" :src="imageFromCase(row, 'source')" fit="cover" preview-teleported :preview-src-list="[imageFromCase(row, 'source')]">
                <template #error><span class="image-fallback">加载失败</span></template>
              </el-image>
              <span v-else>无图</span>
              <el-image v-if="imageFromCase(row, 'generated')" :src="imageFromCase(row, 'generated')" fit="cover" preview-teleported :preview-src-list="[imageFromCase(row, 'generated')]">
                <template #error><span class="image-fallback">加载失败</span></template>
              </el-image>
              <span v-else>未生成</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="case_name" label="案例名称" min-width="240" show-overflow-tooltip />
        <el-table-column prop="product_subject_name" label="产品类型" min-width="170" show-overflow-tooltip />
        <el-table-column label="裂变类型" width="120">
          <template #default="{ row }">{{ variantTypeText(row.variant_type) }}</template>
        </el-table-column>
        <el-table-column prop="source_value" label="源值" width="130" />
        <el-table-column prop="success_target_value" label="成功目标" width="130" />
        <el-table-column label="模板状态" width="140">
          <template #default="{ row }">
            <el-tag :type="row.case_json?.listing_template_snapshot?.template_payload ? 'success' : 'warning'" effect="light">
              {{ templateHealthText(row.case_json?.listing_template_snapshot || {}) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="usage_count" label="复用次数" width="90" align="center" />
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }"><el-tag :type="statusTagType(row.status)" effect="light">{{ statusText(row.status) }}</el-tag></template>
        </el-table-column>
        <el-table-column label="更新时间" width="180">
          <template #default="{ row }">{{ shanghaiDateTimeText(row.updated_at, { assumeUtcWhenNaive: true }) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="250" fixed="right" align="center">
          <template #default="{ row }">
            <div class="row-actions">
              <el-button size="small" :icon="View" @click="openDetail(row, 'overview')">详情</el-button>
              <el-button size="small" type="success" :icon="Position" @click="openDetail(row, 'reuse')">快速裂变</el-button>
              <el-button size="small" type="danger" plain :icon="Delete" :loading="deletingCaseNo === row.case_no" @click="deleteCase(row)">删除</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>

      <PageFooterPagination
        class="case-library-footer"
        :total="pagination.total"
        :page="pagination.page"
        :page-size="pagination.pageSize"
        :page-sizes="[10, 20, 50, 100]"
        @update:page="changePage"
        @update:pageSize="changePageSize"
      />
    </section>

    <el-dialog v-model="detailVisible" width="980px" class="case-detail-dialog" destroy-on-close>
      <template #header>
        <div class="dialog-title">
          <strong>{{ activeCase?.case_name || "案例详情" }}</strong>
          <span>{{ activeCase?.case_no || "" }}</span>
        </div>
      </template>

      <div v-loading="detailLoading" class="dialog-body">
        <el-tabs v-model="detailTab">
          <el-tab-pane label="快速裂变" name="reuse">
            <section class="quick-reuse-panel">
              <div class="quick-text">
                <h2>直接复用这个案例</h2>
                <p>填写新型号后，会打开独立 AI 裂变页，并直接进入最后的生成队列。</p>
              </div>
              <el-input v-model="quickReuse.targetValues" type="textarea" :rows="5" placeholder="一行一个新型号，例如：EXEED VX&#10;TENET T7&#10;OMODA C5" />
              <el-input v-model="quickReuse.offerPrefix" placeholder="货号前缀，选填；不填则由 AI 裂变页按车型生成" />
              <div class="dialog-actions">
                <el-button @click="detailVisible = false">取消</el-button>
                <el-button type="success" :icon="Position" :disabled="detailLoading" @click="startQuickReuse()">进入生成队列</el-button>
              </div>
            </section>
          </el-tab-pane>

          <el-tab-pane label="案例详情" name="overview">
            <div class="detail-grid-layout">
              <section class="detail-section">
                <h2>案例概览</h2>
                <dl class="detail-grid">
                  <dt>产品</dt><dd>{{ activeCase?.product_subject_name || "-" }}</dd>
                  <dt>裂变类型</dt><dd>{{ variantTypeText(activeCase?.variant_type) }}</dd>
                  <dt>变量位</dt><dd>{{ activeCase?.variable_slot || "-" }}</dd>
                  <dt>源值</dt><dd>{{ activeCase?.source_value || "-" }}</dd>
                  <dt>成功目标</dt><dd>{{ activeCase?.success_target_value || "-" }}</dd>
                  <dt>状态</dt><dd>{{ statusText(activeCase?.status) }}</dd>
                </dl>
              </section>

              <section class="detail-section">
                <h2>草稿模板资产</h2>
                <dl class="detail-grid">
                  <dt>草稿 ID</dt><dd>{{ listingSnapshot.source_draft_id || "-" }}</dd>
                  <dt>模板 ID</dt><dd>{{ listingSnapshot.source_template_id || "-" }}</dd>
                  <dt>店铺</dt><dd>{{ (listingSnapshot.source_shop_ids || []).join(", ") || "-" }}</dd>
                  <dt>模板快照</dt><dd>{{ listingSnapshot.template_payload ? "已保存" : "缺失" }}</dd>
                </dl>
              </section>

              <section class="detail-section wide">
                <h2>产品事实</h2>
                <el-descriptions :column="1" border size="small">
                  <el-descriptions-item label="产品类型">{{ productFacts.product_type || "-" }}</el-descriptions-item>
                  <el-descriptions-item label="固定事实">{{ tagsText(productFacts.keep_facts || productFacts.fixed_facts_zh) || "-" }}</el-descriptions-item>
                  <el-descriptions-item label="禁止变化">{{ tagsText(productFacts.forbidden_changes) || "-" }}</el-descriptions-item>
                </el-descriptions>
              </section>

              <section class="detail-section wide">
                <h2>裂变契约</h2>
                <el-descriptions :column="1" border size="small">
                  <el-descriptions-item label="替换区域">{{ tagsText(variantContract.replace_zones) || "-" }}</el-descriptions-item>
                  <el-descriptions-item label="保护区域">{{ tagsText(variantContract.preserve_zones) || "-" }}</el-descriptions-item>
                  <el-descriptions-item label="操作备注">{{ variantContract.operator_note || "-" }}</el-descriptions-item>
                </el-descriptions>
              </section>
            </div>
          </el-tab-pane>

          <el-tab-pane label="成功样例" name="sample">
            <section class="sample-layout">
              <div class="sample-media">
                <el-image v-if="imageFromCase(activeCase, 'source')" :src="imageFromCase(activeCase, 'source')" fit="cover" preview-teleported :preview-src-list="[imageFromCase(activeCase, 'source')]">
                  <template #error><span class="image-fallback">加载失败</span></template>
                </el-image>
                <el-image v-if="imageFromCase(activeCase, 'generated')" :src="imageFromCase(activeCase, 'generated')" fit="cover" preview-teleported :preview-src-list="[imageFromCase(activeCase, 'generated')]">
                  <template #error><span class="image-fallback">加载失败</span></template>
                </el-image>
              </div>
              <el-descriptions :column="1" border size="small">
                <el-descriptions-item label="标题">{{ sampleOutputs.title_ru || "-" }}</el-descriptions-item>
                <el-descriptions-item label="标签">{{ tagsText(sampleOutputs.tags_ru) || "-" }}</el-descriptions-item>
                <el-descriptions-item label="描述">{{ sampleOutputs.description_ru || "-" }}</el-descriptions-item>
              </el-descriptions>
            </section>
          </el-tab-pane>

          <el-tab-pane label="来源链路" name="trace">
            <section class="detail-section">
              <dl class="detail-grid">
                <dt>识别编号</dt><dd>{{ sourceTrace.analysis_no || "-" }}</dd>
                <dt>批次编号</dt><dd>{{ sourceTrace.batch_job_no || "-" }}</dd>
                <dt>来源</dt><dd>{{ sourceTrace.source_type || "-" }}</dd>
              </dl>
            </section>
          </el-tab-pane>
        </el-tabs>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.case-library-page { display: flex; flex-direction: column; gap: 14px; min-height: calc(100dvh - 124px); padding: 18px; color: #172033; }
.page-header { display: flex; justify-content: space-between; align-items: center; gap: 18px; }
.page-header h1 { margin: 0 0 4px; font-size: 22px; font-weight: 700; letter-spacing: 0; }
.page-header p { margin: 0; color: #64748b; line-height: 1.5; }
.filter-panel, .table-panel { background: #fff; border: 1px solid #d9e2ef; border-radius: 8px; }
.filter-panel { display: flex; flex-wrap: wrap; gap: 10px; padding: 12px; align-items: center; }
.filter-panel .el-input { max-width: 380px; }
.filter-panel .el-select { width: 160px; }
.table-panel { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.case-table :deep(.el-table__header th) { background: #f8fafc; color: #334155; font-weight: 700; }
.row-actions { display: flex; gap: 8px; justify-content: center; flex-wrap: nowrap; }
.image-pair, .sample-media { display: flex; gap: 8px; align-items: center; }
.image-pair .el-image, .image-pair span { width: 58px; height: 76px; border: 1px solid #dbe5ef; border-radius: 6px; background: #f8fafc; color: #64748b; font-size: 12px; display: inline-flex; align-items: center; justify-content: center; overflow: hidden; }
.image-fallback { width: 100%; height: 100%; border: 0; border-radius: 0; }
.case-library-footer { margin-top: auto; border-top: 1px solid #edf2f7; }
.dialog-title { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dialog-title strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dialog-title span { color: #64748b; font-size: 12px; }
.dialog-body { min-height: 420px; }
.quick-reuse-panel { display: grid; gap: 12px; }
.quick-text h2, .detail-section h2 { margin: 0 0 6px; font-size: 15px; letter-spacing: 0; }
.quick-text p { margin: 0; color: #64748b; line-height: 1.5; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 10px; padding-top: 4px; }
.detail-grid-layout { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.detail-section { border: 1px solid #e1e8f2; border-radius: 8px; padding: 12px; background: #fbfdff; }
.detail-section.wide { grid-column: 1 / -1; }
.detail-grid { display: grid; grid-template-columns: 100px minmax(0, 1fr); gap: 8px 12px; margin: 0; }
.detail-grid dt { color: #64748b; }
.detail-grid dd { margin: 0; color: #172033; overflow-wrap: anywhere; }
.sample-layout { display: grid; gap: 12px; }
.sample-media .el-image { width: 128px; height: 160px; border: 1px solid #dbe5ef; border-radius: 6px; }
.sample-media .image-fallback { display: inline-flex; align-items: center; justify-content: center; color: #64748b; font-size: 12px; background: #f8fafc; }
@media (max-width: 760px) {
  .page-header, .filter-panel, .detail-grid-layout { display: grid; grid-template-columns: 1fr; }
  .filter-panel .el-input, .filter-panel .el-select { max-width: none; width: 100%; }
  .case-library-footer { overflow-x: auto; }
}
</style>
