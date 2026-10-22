<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Delete, Position, Refresh, Search, View } from "@element-plus/icons-vue";
import { apiClient, currentApiCacheScope } from "../../utils/api";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import QuickFissionVehiclePicker from "../../components/listing/QuickFissionVehiclePicker.vue";
import { openAiVariantLabWindow } from "../../utils/ai-variant-lab-window";
import { shanghaiDateTimeText } from "../../utils/shanghai-date";
import { parseQuickTargets, vehicleTargetKey } from "../../utils/ai-variant-quick-targets.js";

const loading = ref(false);
const detailLoading = ref(false);
const detailError = ref("");
const detailRow = ref(null);
const detailVisible = ref(false);
const detailTab = ref("reuse");
const cases = ref([]);
const selectedCases = ref([]);
const activeCase = ref(null);
const deletingCaseNo = ref("");
const batchDeleting = ref(false);
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
const vehicleCatalog = reactive({ brands: [], loading: false, error: "" });
const manualTargetExpanded = ref(false);
const historyLoading = ref(false);
let detailRequest = 0;
const vehicleSource = computed(() => activeCase.value?.source_value || variantContract.value.source_value || "");
const isVehicleCase = computed(() => !["color_swap", "audience_variant", "logo_swap"].includes(activeCase.value?.variant_type));
const selectedTargets = computed({
  get: () => parseTargetValues(quickReuse.targetValues).filter(target => !isVehicleCase.value || vehicleTargetKey(target) !== vehicleTargetKey(vehicleSource.value)),
  set: values => { quickReuse.targetValues = parseQuickTargets(values).join("\n"); }
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
  window.addEventListener("erp:auth-scope-changed", resetDetail);
  void loadCases();
});

onUnmounted(() => {
  window.removeEventListener("resize", updateViewportHeight);
  window.removeEventListener("erp:auth-scope-changed", resetDetail);
  detailRequest += 1;
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
    selectedCases.value = [];
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
  const scope = currentApiCacheScope();
  const request = ++detailRequest;
  detailRow.value = row;
  detailError.value = "";
  historyLoading.value = false;
  activeCase.value = null;
  quickReuse.targetValues = "";
  quickReuse.offerPrefix = "";
  manualTargetExpanded.value = false;
  vehicleCatalog.brands = [];
  vehicleCatalog.error = "";
  detailVisible.value = true;
  detailTab.value = tab;
  detailLoading.value = true;
  void loadVehicleCatalog(request, scope);
  try {
    const result = await apiClient.get(`/api/ai-variant-lab/cases/${encodeURIComponent(row.case_no)}`, { noCache: true });
    if (request !== detailRequest || scope !== currentApiCacheScope()) return;
    activeCase.value = result.case || null;
  } catch (error) {
    if (request === detailRequest && scope === currentApiCacheScope()) {
      detailError.value = error.message || "加载案例详情失败，请重试。";
      ElMessage.error(detailError.value);
    }
  } finally {
    if (request === detailRequest) detailLoading.value = false;
  }
}

function resetDetail() {
  detailRequest += 1;
  detailVisible.value = false;
  activeCase.value = null;
  detailRow.value = null;
  detailError.value = "";
  quickReuse.targetValues = "";
  quickReuse.offerPrefix = "";
  vehicleCatalog.brands = [];
  vehicleCatalog.error = "";
  vehicleCatalog.loading = false;
  historyLoading.value = false;
  detailLoading.value = false;
}

async function loadVehicleCatalog(request, scope) {
  const currentScope = currentApiCacheScope();
  request ??= detailRequest;
  scope ??= currentScope;
  if (request !== detailRequest || scope !== currentScope || !detailVisible.value) return;
  vehicleCatalog.loading = true;
  try {
    const result = await apiClient.get("/api/ai-variant-lab/vehicle-catalog", { noCache: true });
    if (request !== detailRequest || scope !== currentApiCacheScope()) return;
    vehicleCatalog.brands = result.brands || [];
    vehicleCatalog.error = "";
  } catch (error) {
    if (request === detailRequest && scope === currentApiCacheScope()) vehicleCatalog.error = error.message || "车型库加载失败，可重试或手工补充。";
  } finally {
    if (request === detailRequest) vehicleCatalog.loading = false;
  }
}

async function refreshCaseHistory() {
  const scope = currentApiCacheScope();
  const caseNo = activeCase.value?.case_no;
  if (!caseNo) return;
  const request = detailRequest;
  historyLoading.value = true;
  try {
    const result = await apiClient.get(`/api/ai-variant-lab/cases/${encodeURIComponent(caseNo)}`, { noCache: true });
    if (request === detailRequest && scope === currentApiCacheScope()) activeCase.value = result.case || null;
  } catch (error) {
    if (request === detailRequest && scope === currentApiCacheScope()) ElMessage.error(error.message || "刷新裂变记录失败");
  } finally {
    if (request === detailRequest) historyLoading.value = false;
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
  const targets = selectedTargets.value;
  if (!caseNo) {
    ElMessage.warning("请先选择一个案例。");
    return;
  }
  if (!targets.length) {
    ElMessage.warning("请先勾选目标车型，或手工补充新型号。");
    return;
  }
  if (targets.length > 100) {
    ElMessage.warning("单次最多选择 100 个目标，请分批进入生成队列。");
    return;
  }
  openAiVariantLabWindow({
    source: "case",
    caseNo,
    caseTargets: targets.join("\n"),
    caseTargetValues: JSON.stringify(targets),
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

async function deleteSelectedCases() {
  const caseNos = selectedCases.value.map((row) => String(row?.case_no || "").trim()).filter(Boolean);
  if (!caseNos.length) return;
  const confirmed = await ElMessageBox.confirm(
    `确定删除选中的 ${caseNos.length} 个案例吗？删除后将不再出现在案例库列表中。`,
    "批量删除案例",
    { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" }
  ).then(() => true).catch(() => false);
  if (!confirmed) return;
  batchDeleting.value = true;
  try {
    const result = await apiClient.post("/api/ai-variant-lab/cases/batch-delete", { caseNos });
    const deleted = Number(result.deleted || 0);
    ElMessage.success(`已删除 ${deleted} 个案例`);
    if (activeCase.value && caseNos.includes(activeCase.value.case_no)) {
      detailVisible.value = false;
      activeCase.value = null;
    }
    if (cases.value.length === caseNos.length && pagination.page > 1) pagination.page -= 1;
    await loadCases();
  } catch (error) {
    ElMessage.error(error.message || "批量删除案例失败");
  } finally {
    batchDeleting.value = false;
  }
}

function onCaseSelectionChange(rows) {
  selectedCases.value = rows || [];
}

function parseTargetValues(value) {
  return parseQuickTargets(value);
}

function imageFromCase(row, key) {
  if (key === "source" && row?.source_image_url) return String(row.source_image_url).trim();
  if (key === "generated" && row?.generated_image_url) return firstStableUrl(row.generated_image_url);
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
        <h1>AI裂变案例库</h1>
        <p>沉淀可复用的成功案例，后续直接填写新型号进入 AI 裂变生成队列。</p>
      </div>
      <div class="header-actions">
        <el-button type="danger" plain :icon="Delete" :loading="batchDeleting" :disabled="!selectedCases.length" @click="deleteSelectedCases">批量删除{{ selectedCases.length ? ` (${selectedCases.length})` : "" }}</el-button>
        <el-button :icon="Refresh" :loading="loading" @click="loadCases">刷新</el-button>
      </div>
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
      <el-table v-loading="loading" :data="cases" border class="case-table" row-key="case_no" :height="tableHeight" @selection-change="onCaseSelectionChange">
        <el-table-column type="selection" width="48" fixed />
        <el-table-column label="参考图" width="156" fixed>
          <template #default="{ row }">
            <div class="image-pair">
              <el-image v-if="imageFromCase(row, 'source')" :src="imageFromCase(row, 'source')" fit="cover" lazy preview-teleported :preview-src-list="[imageFromCase(row, 'source')]">
                <template #error><span class="image-fallback">加载失败</span></template>
              </el-image>
              <span v-else>无图</span>
              <el-image v-if="imageFromCase(row, 'generated')" :src="imageFromCase(row, 'generated')" fit="cover" lazy preview-teleported :preview-src-list="[imageFromCase(row, 'generated')]">
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
            <el-tag :type="row.has_listing_template ? 'success' : 'warning'" effect="light">
              {{ row.has_listing_template ? "可关联草稿模板" : "缺少草稿模板" }}
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
        <div v-if="detailError" class="detail-error" role="alert">
          <span>{{ detailError }}</span>
          <el-button type="primary" plain :loading="detailLoading" @click="openDetail(detailRow, detailTab)">重新加载案例</el-button>
        </div>
        <el-tabs v-model="detailTab">
          <el-tab-pane label="快速裂变" name="reuse">
            <section class="quick-reuse-panel">
              <div class="quick-text">
                <h2>直接复用这个案例</h2>
                <p>勾选目标车型后，会打开独立 AI 裂变页，并直接进入最后的生成队列。</p>
              </div>
              <QuickFissionVehiclePicker
                v-if="activeCase && isVehicleCase"
                :key="activeCase.case_no"
                v-model="selectedTargets"
                :brands="vehicleCatalog.brands"
                :loading="vehicleCatalog.loading"
                :error="vehicleCatalog.error"
                :history="activeCase.target_history || []"
                :source-value="vehicleSource"
                @reload="loadVehicleCatalog()"
              />
              <div class="selected-target-heading">
                <strong>已选 {{ selectedTargets.length }} 个目标</strong>
                <div>
                  <el-button v-if="activeCase" link type="primary" :loading="historyLoading" @click="refreshCaseHistory">刷新记录</el-button>
                  <el-button v-if="selectedTargets.length" link @click="selectedTargets = []">清空</el-button>
                  <el-button link type="primary" @click="manualTargetExpanded = !manualTargetExpanded">{{ manualTargetExpanded ? "收起手工补充" : "手工补充" }}</el-button>
                </div>
              </div>
              <div v-if="selectedTargets.length" class="selected-target-chips">
                <el-tag v-for="target in selectedTargets" :key="vehicleTargetKey(target)" closable effect="plain" @close="selectedTargets = selectedTargets.filter(value => vehicleTargetKey(value) !== vehicleTargetKey(target))">{{ target }}</el-tag>
              </div>
              <el-input v-if="manualTargetExpanded || !isVehicleCase" v-model="quickReuse.targetValues" type="textarea" :rows="3" placeholder="一行一个新型号，例如：EXEED VX&#10;TENET T7&#10;OMODA C5" aria-label="手工补充目标车型" />
              <el-input v-model="quickReuse.offerPrefix" placeholder="货号前缀，选填；不填则由 AI 裂变页按车型生成" />
              <div class="dialog-actions">
                <el-button @click="detailVisible = false">取消</el-button>
                <el-button type="success" :icon="Position" :disabled="detailLoading || !activeCase || !selectedTargets.length" @click="startQuickReuse()">进入生成队列</el-button>
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
.case-library-page { display: flex; flex-direction: column; gap: 14px; min-height: calc(100dvh - 124px); padding: 18px; color: var(--erp-text-main, #172033); }
.page-header, .header-actions { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.page-header h1 { margin: 0 0 4px; font-size: 22px; font-weight: 700; letter-spacing: 0; }
.page-header p { margin: 0; color: var(--erp-text-regular, #64748b); line-height: 1.5; }
.filter-panel, .table-panel { background: var(--erp-surface, #fff); border: 1px solid var(--erp-border, #d9e2ef); border-radius: 8px; }
.filter-panel { display: flex; flex-wrap: wrap; gap: 10px; padding: 12px; align-items: center; }
.filter-panel .el-input { max-width: 380px; }
.filter-panel .el-select { width: 160px; }
.table-panel { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.case-table :deep(.el-table__header th) { background: var(--erp-surface-alt, #f8fafc); color: var(--erp-text-regular, #334155); font-weight: 700; }
.row-actions { display: flex; gap: 8px; justify-content: center; flex-wrap: nowrap; }
.image-pair, .sample-media { display: flex; gap: 8px; align-items: center; }
.image-pair .el-image, .image-pair span { width: 58px; height: 76px; border: 1px solid var(--erp-border, #dbe5ef); border-radius: 6px; background: var(--erp-surface-alt, #f8fafc); color: var(--erp-text-regular, #64748b); font-size: 12px; display: inline-flex; align-items: center; justify-content: center; overflow: hidden; }
.image-fallback { width: 100%; height: 100%; border: 0; border-radius: 0; }
.case-library-footer { margin-top: auto; border-top: 1px solid var(--erp-border-light, #edf2f7); }
.dialog-title { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dialog-title strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dialog-title span { color: var(--erp-text-regular, #64748b); font-size: 12px; }
.dialog-body { min-height: 420px; }
.detail-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; color: var(--erp-danger-text, #f56c6c); }
.quick-reuse-panel { display: grid; gap: 12px; }
.selected-target-heading { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.selected-target-chips { display: flex; flex-wrap: wrap; gap: 7px; }
.quick-text h2, .detail-section h2 { margin: 0 0 6px; font-size: 15px; letter-spacing: 0; }
.quick-text p { margin: 0; color: var(--erp-text-regular, #64748b); line-height: 1.5; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 10px; padding-top: 4px; }
.detail-grid-layout { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.detail-section { border: 1px solid var(--erp-border, #e1e8f2); border-radius: 8px; padding: 12px; background: var(--erp-surface-alt, #fbfdff); }
.detail-section.wide { grid-column: 1 / -1; }
.detail-grid { display: grid; grid-template-columns: 100px minmax(0, 1fr); gap: 8px 12px; margin: 0; }
.detail-grid dt { color: var(--erp-text-regular, #64748b); }
.detail-grid dd { margin: 0; color: var(--erp-text-main, #172033); overflow-wrap: anywhere; }
.sample-layout { display: grid; gap: 12px; }
.sample-media .el-image { width: 128px; height: 160px; border: 1px solid var(--erp-border, #dbe5ef); border-radius: 6px; }
.sample-media .image-fallback { display: inline-flex; align-items: center; justify-content: center; color: var(--erp-text-regular, #64748b); font-size: 12px; background: var(--erp-surface-alt, #f8fafc); }
@media (max-width: 760px) {
  .page-header, .filter-panel, .detail-grid-layout { display: grid; grid-template-columns: 1fr; }
  .filter-panel .el-input, .filter-panel .el-select { max-width: none; width: 100%; }
  .case-library-footer { overflow-x: auto; }
}
</style>
