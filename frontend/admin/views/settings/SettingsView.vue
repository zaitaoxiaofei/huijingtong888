<script setup>

import { computed, onMounted, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { isPlatformAdmin } from "../../../../src/shared/permissions.js";
import { useAuthStore } from "../../stores/auth";
import { apiClient } from "../../utils/api";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import { shanghaiDateDaysAgo, shanghaiDateKey, shanghaiDateTimeText } from "../../utils/shanghai-date";
const props = defineProps({ section: { type: String, default: "cancel" } });
const activeSection = computed(() => props.section === "logistics" ? "logistics" : "cancel");
const auth = useAuthStore();
const canEdit = computed(() => isPlatformAdmin(auth.user));
const loading = ref(false);
const logisticsDialogVisible = ref(false), logisticsDialogSubmitting = ref(false), logisticsFormRef = ref();
const cancellationDialogVisible = ref(false), cancellationDialogSubmitting = ref(false), cancellationFormRef = ref();
const reasonReview = reactive({ from: shanghaiDateDaysAgo(89), to: shanghaiDateKey(), pending: [], classified: [], types: [], loading: false, truncated: false, visible: false, saving: false, form: { original: "", reason_id: "", reason_code: "", note: "" } });
const state = reactive({ logisticsRules: [], cancellationRules: [], filters: { logisticsQuery: "", logisticsStatus: "all", logisticsVersionStatus: "all", logisticsPage: 1, logisticsPageSize: 20, cancellationQuery: "", cancellationStatus: "all", cancellationPage: 1, cancellationPageSize: 10 } });
const currentSectionMeta = computed(() => activeSection.value === "logistics" ? { title: "物流设置", description: "平台统一维护运费版本，企业成员可查看当前可用规则。" } : { title: "取消规则设置", description: "核查未收录原因并人工归类，保留原始原因，不重算历史利润。" });
const logisticsDialog = reactive({ mode: "create", form: createDefaultLogisticsForm() });
const cancellationDialog = reactive({ mode: "create", form: createDefaultCancellationForm() });
const logisticsFormRules = { name: [{ required: true, message: "请输入规则名称", trigger: "blur" }] };
const cancellationFormRules = { name: [{ required: true, message: "请输入规则名称", trigger: "blur" }], match_text: [{ required: true, message: "请输入匹配文本", trigger: "blur" }] };
const logisticsDialogTitle = computed(() => ({ create: "新增物流规则", version: "新增运费版本", edit: "编辑物流规则" }[logisticsDialog.mode]));
const cancellationDialogTitle = computed(() => cancellationDialog.mode === "create" ? "新增取消规则" : "编辑取消规则");
const filteredLogisticsRules = computed(() => state.logisticsRules.filter(row => { const f = state.filters, q = f.logisticsQuery.trim().toLowerCase(); return (f.logisticsStatus === "all" || (f.logisticsStatus === "active") === (Number(row.enabled) !== 0)) && (f.logisticsVersionStatus === "all" || logisticsVersionStatus(row).key === f.logisticsVersionStatus) && (!q || [row.name,row.carrier,row.channel,row.mode,row.note].join(" ").toLowerCase().includes(q)); }));
const filteredCancellationRules = computed(() => state.cancellationRules.filter(row => { const f = state.filters, q = f.cancellationQuery.trim().toLowerCase(); return (f.cancellationStatus === "all" || (f.cancellationStatus === "active") === (Number(row.enabled) !== 0)) && (!q || [row.name,row.match_text,row.reason_label,row.reason_group_label,row.note].join(" ").toLowerCase().includes(q)); }));
const logisticsTotal = computed(() => filteredLogisticsRules.value.length), cancellationTotal = computed(() => filteredCancellationRules.value.length);
const pagedLogisticsRules = computed(() => paginate(filteredLogisticsRules.value,state.filters.logisticsPage,state.filters.logisticsPageSize));
const pagedCancellationRules = computed(() => paginate(filteredCancellationRules.value,state.filters.cancellationPage,state.filters.cancellationPageSize));
const logisticsVersionGroups = computed(() => { const groups = new Map(); for (const row of state.logisticsRules) { const key = Number(row.version_group_id || row.id); if (!groups.has(key)) groups.set(key,[]); groups.get(key).push(row); } for (const rows of groups.values()) rows.sort((a,b) => new Date(a.effective_from || 0) - new Date(b.effective_from || 0)); return groups; });
async function refreshSettingsData() { const section = activeSection.value; loading.value = true; try { const path = section === "logistics" ? "/api/logistics-rules" : "/api/order-cancellation-rules"; const rows = await apiClient.get(path, { noCache: true }); state[section === "logistics" ? "logisticsRules" : "cancellationRules"] = Array.isArray(rows) ? rows : []; if (section === "cancel") await loadReasonReview(); } catch(error) { ElMessage.error(error.message || "规则加载失败"); } finally { loading.value = false; } }
async function loadReasonReview() {
  reasonReview.loading = true;
  try {
    const result = await apiClient.get(`/api/order-cancellation-rules/unclassified?${new URLSearchParams({ from: reasonReview.from, to: reasonReview.to })}`, { noCache: true });
    Object.assign(reasonReview, { pending: result.pending || [], classified: result.classified || [], types: result.types || [], truncated: Boolean(result.truncated) });
  } catch (error) { ElMessage.error(error.message || "未收录原因加载失败"); }
  finally { reasonReview.loading = false; }
}
function openReasonClassification(row) { reasonReview.form = { original: row.original, reason_id: row.original ? "" : String(row.reason_id || ""), reason_code: "", note: "" }; reasonReview.visible = true; }
async function saveReasonClassification() {
  if (!reasonReview.form.reason_code) { ElMessage.warning("请选择原因类型"); return; }
  reasonReview.saving = true;
  try { const payload = { ...reasonReview.form }; if (!payload.reason_id) delete payload.reason_id; await apiClient.post("/api/order-cancellation-rules/classifications", payload); reasonReview.visible = false; ElMessage.success("原因分类已保存，历史利润未变更"); await refreshSettingsData(); }
  catch (error) { ElMessage.error(error.message || "分类保存失败"); }
  finally { reasonReview.saving = false; }
}
onMounted(refreshSettingsData);
watch(activeSection, refreshSettingsData);

function createDefaultLogisticsForm() {
  return {
    id: null,
    updated_at: "",
    name: "",
    carrier: "CEL",
    channel: "standard",
    mode: "per_gram",
    min_weight_g: 0,
    max_weight_g: 500,
    min_price_rub: 0,
    max_price_rub: 999999,
    base_fee_cny: 0,
    per_gram_cny: 0.026,
    per_ticket_cny: 0,
    enabled: 1,
    source_rule_id: null,
    effective_from: "",
    filter_keywords: "",
    note: ""
  };
}

function createDefaultCancellationForm() {
  return {
    id: null,
    updated_at: "",
    name: "",
    match_text: "",
    match_mode: "contains",
    initiator_label: "",
    reason_label: "",
    reason_code: "other",
    reason_group_label: "其他取消/退货原因",
    priority: 100,
    enabled: 1,
    accounting_hint: "",
    note: ""
  };
}

function paginate(rows, page, pageSize) {
  const start = (page - 1) * pageSize;
  return rows.slice(start, start + pageSize);
}

function logisticsVersionStatus(row) {
  const now = Date.now();
  const parseUtc = (value, fallback) => {
    if (!value) return fallback;
    const text = String(value);
    return new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text.replace(" ", "T")}Z`).getTime();
  };
  const from = parseUtc(row.effective_from, 0);
  const to = parseUtc(row.effective_to, Infinity);
  if (from > now) return { key: "pending", label: "待生效", type: "warning" };
  if (to <= now) return { key: "expired", label: "已过期", type: "info" };
  return { key: "current", label: "当前版本", type: "success" };
}

function logisticsVersionMeta(row) {
  const rows = logisticsVersionGroups.value.get(Number(row.version_group_id || row.id)) || [row];
  const index = Math.max(0, rows.findIndex((item) => Number(item.id) === Number(row.id)));
  return { number: index + 1, total: rows.length, previous: index > 0 ? rows[index - 1] : null };
}

function logisticsRateDelta(row, field) {
  const previous = logisticsVersionMeta(row).previous;
  const previousValue = Number(previous?.[field] || 0);
  if (!previous || previousValue <= 0) return "";
  const percent = ((Number(row[field] || 0) - previousValue) / previousValue) * 100;
  return `${percent >= 0 ? "+" : ""}${percent.toFixed(1)}%`;
}

function logisticsEffectiveFromText(row) {
  const raw = row?.effective_from;
  if (!raw) return "历史起点";
  const timestamp = new Date(raw).getTime();
  if (Number.isFinite(timestamp) && timestamp <= Date.parse("1970-01-02T00:00:00Z")) return "历史起点";
  return shanghaiDateTimeText(raw, { assumeUtcWhenNaive: true });
}

function openCreateLogisticsDialog() {
  logisticsDialog.mode = "create";
  logisticsDialog.form = createDefaultLogisticsForm();
  logisticsDialogVisible.value = true;
}

function openEditLogisticsDialog(row) {
  logisticsDialog.mode = "edit";
  logisticsDialog.form = {
    ...createDefaultLogisticsForm(),
    ...row,
    id: row.id,
    enabled: Number(row.enabled ?? 1)
  };
  logisticsDialogVisible.value = true;
}

function openVersionLogisticsDialog(row) {
  logisticsDialog.mode = "version";
  logisticsDialog.form = {
    ...createDefaultLogisticsForm(),
    ...row,
    id: null,
    updated_at: "",
    source_rule_id: Number(row.id),
    effective_from: `${shanghaiDateKey(new Date(Date.now() + 86400000))} 00:00`,
    enabled: 1
  };
  logisticsDialogVisible.value = true;
}

async function submitLogisticsDialog() {
  await logisticsFormRef.value?.validate();
  logisticsDialogSubmitting.value = true;
  try {
    const payload = {
      ...logisticsDialog.form,
      min_weight_g: Number(logisticsDialog.form.min_weight_g || 0),
      max_weight_g: Number(logisticsDialog.form.max_weight_g || 0),
      min_price_rub: Number(logisticsDialog.form.min_price_rub || 0),
      max_price_rub: Number(logisticsDialog.form.max_price_rub || 0),
      base_fee_cny: Number(logisticsDialog.form.base_fee_cny || 0),
      per_gram_cny: Number(logisticsDialog.form.per_gram_cny || 0),
      per_ticket_cny: Number(logisticsDialog.form.per_ticket_cny || 0),
      enabled: Number(logisticsDialog.form.enabled ?? 1)
    };
    if (logisticsDialog.mode === "create" || logisticsDialog.mode === "version") {
      await apiClient.post("/api/logistics-rules", payload);
      ElMessage.success(logisticsDialog.mode === "version" ? "新运费版本已新增" : "物流规则已新增");
    } else {
      await apiClient.put(`/api/logistics-rules/${logisticsDialog.form.id}`, payload);
      ElMessage.success("物流规则已更新");
    }
    logisticsDialogVisible.value = false;
    await refreshSettingsData();
  } catch (error) {
    ElMessage.error(error.message || "物流规则保存失败");
  } finally {
    logisticsDialogSubmitting.value = false;
  }
}

function clearLogisticsForm() {
  logisticsDialog.form = createDefaultLogisticsForm();
  logisticsFormRef.value?.clearValidate?.();
}

function closeLogisticsDialog() {
  logisticsDialogVisible.value = false;
}

async function toggleLogisticsRule(row) {
  const nextEnabled = Number(row.enabled) === 0 ? 1 : 0;
  const actionText = nextEnabled === 0 ? "停用" : "启用";
  try {
    await ElMessageBox.confirm(`确认${actionText}物流规则「${row.name || row.id}」吗？`, `${actionText}确认`, {
      type: "warning",
      confirmButtonText: `确认${actionText}`,
      cancelButtonText: "取消"
    });
    await apiClient.put(`/api/logistics-rules/${row.id}`, {
      ...row,
      enabled: nextEnabled
    });
    ElMessage.success(`物流规则已${actionText}`);
    await refreshSettingsData();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || `${actionText}失败`);
  }
}

async function deleteLogisticsRule(row) {
  try {
    await ElMessageBox.confirm(`确认永久删除物流规则「${row.name || row.id}」的 V${logisticsVersionMeta(row).number} 吗？已被商品或订单引用的版本不会被删除。`, "删除物流规则", {
      type: "warning",
      confirmButtonText: "确认删除",
      cancelButtonText: "取消"
    });
    await apiClient.delete(`/api/logistics-rules/${row.id}`);
    ElMessage.success("物流规则已删除");
    await refreshSettingsData();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "物流规则删除失败");
  }
}

function resetLogisticsFilters() {
  state.filters.logisticsQuery = "";
  state.filters.logisticsStatus = "all";
  state.filters.logisticsVersionStatus = "all";
  state.filters.logisticsPage = 1;
}

function openCreateCancellationDialog() {
  cancellationDialog.mode = "create";
  cancellationDialog.form = createDefaultCancellationForm();
  cancellationDialogVisible.value = true;
}

function openEditCancellationDialog(row) {
  cancellationDialog.mode = "edit";
  cancellationDialog.form = {
    ...createDefaultCancellationForm(),
    ...row,
    id: row.id,
    priority: Number(row.priority ?? 100),
    enabled: Number(row.enabled ?? 1)
  };
  cancellationDialogVisible.value = true;
}

async function submitCancellationDialog() {
  await cancellationFormRef.value?.validate();
  cancellationDialogSubmitting.value = true;
  try {
    const payload = {
      ...cancellationDialog.form,
      priority: Number(cancellationDialog.form.priority || 0),
      enabled: Number(cancellationDialog.form.enabled ?? 1)
    };
    if (cancellationDialog.mode === "create") {
      await apiClient.post("/api/order-cancellation-rules", payload);
      ElMessage.success("取消规则已新增");
    } else {
      await apiClient.put(`/api/order-cancellation-rules/${cancellationDialog.form.id}`, payload);
      ElMessage.success("取消规则已更新");
    }
    cancellationDialogVisible.value = false;
    await refreshSettingsData();
  } catch (error) {
    ElMessage.error(error.message || "取消规则保存失败");
  } finally {
    cancellationDialogSubmitting.value = false;
  }
}

function clearCancellationForm() {
  cancellationDialog.form = createDefaultCancellationForm();
  cancellationFormRef.value?.clearValidate?.();
}

function closeCancellationDialog() {
  cancellationDialogVisible.value = false;
}

async function toggleCancellationRule(row) {
  const nextEnabled = Number(row.enabled) === 0 ? 1 : 0;
  const actionText = nextEnabled === 0 ? "停用" : "启用";
  try {
    await ElMessageBox.confirm(`确认${actionText}取消规则「${row.name || row.id}」吗？`, `${actionText}确认`, {
      type: "warning",
      confirmButtonText: `确认${actionText}`,
      cancelButtonText: "取消"
    });
    await apiClient.put(`/api/order-cancellation-rules/${row.id}`, {
      ...row,
      enabled: nextEnabled
    });
    ElMessage.success(`取消规则已${actionText}`);
    await refreshSettingsData();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || `${actionText}失败`);
  }
}

function resetCancellationFilters() {
  state.filters.cancellationQuery = "";
  state.filters.cancellationStatus = "all";
  state.filters.cancellationPage = 1;
}
</script>
<template>
<div class="page-stack settings-page">
<el-card v-if="activeSection === 'cancel'" shadow="never" class="page-card">
  <template #header><div class="page-card-header"><div><strong>未收录原因</strong><span>待归类 {{ reasonReview.pending.length }} 类，已人工归类 {{ reasonReview.classified.length }} 类；不改原始原因或历史利润。</span></div></div></template>
  <el-form inline><el-form-item label="最近出现日期"><el-date-picker v-model="reasonReview.from" type="date" value-format="YYYY-MM-DD" placeholder="开始日期" /></el-form-item><el-form-item><el-date-picker v-model="reasonReview.to" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" /></el-form-item><el-form-item><el-button :loading="reasonReview.loading" @click="loadReasonReview">查询</el-button></el-form-item></el-form>
  <el-alert v-if="reasonReview.truncated" type="warning" :closable="false" title="本次原因类别较多，仅显示最近 1000 类，请缩小日期范围继续核查。" />
  <el-tabs>
    <el-tab-pane :label="`待归类 ${reasonReview.pending.length}`"><el-table v-loading="reasonReview.loading" :data="reasonReview.pending" max-height="320" border empty-text="当前范围没有未归类原因"><el-table-column label="Ozon 原始原因" min-width="300"><template #default="{ row }">{{ row.original || '原文待同步，可按官方代码归类' }}</template></el-table-column><el-table-column prop="reason_id" label="官方原因代码" width="140" /><el-table-column prop="order_count" label="订单数" width="90" /><el-table-column label="最近出现（北京时间）" width="190"><template #default="{ row }">{{ shanghaiDateTimeText(row.last_seen_at, { assumeUtcWhenNaive: true }) }}</template></el-table-column><el-table-column label="操作" width="120"><template #default="{ row }"><el-button link type="primary" @click="openReasonClassification(row)">人工归类</el-button></template></el-table-column></el-table></el-tab-pane>
    <el-tab-pane :label="`已归类 ${reasonReview.classified.length}`"><el-table :data="reasonReview.classified" max-height="320" border empty-text="暂无人工归类"><el-table-column prop="original" label="Ozon 原始原因" min-width="300" /><el-table-column prop="classification.reason_label" label="已核对类型" min-width="200" /><el-table-column prop="order_count" label="订单数" width="90" /></el-table></el-tab-pane>
  </el-tabs>
</el-card>
<el-card v-if="activeSection === 'logistics'" shadow="never" class="page-card settings-list-card">
          <template #header>
            <div class="page-card-header">
              <div>
                <strong>{{ currentSectionMeta.title }}</strong>
                <span>{{ currentSectionMeta.description }}</span>
              </div>
              <div class="settings-header-actions">
                <el-button class="erp-btn erp-btn-secondary" @click="refreshSettingsData">刷新</el-button>
                <el-button class="erp-btn erp-btn-primary" type="primary" v-if="canEdit" @click="openCreateLogisticsDialog">新增物流规则</el-button>
              </div>
            </div>
          </template>

          <div class="filter-panel">
            <el-form inline>
              <el-form-item label="关键词">
                <el-input v-model="state.filters.logisticsQuery" clearable placeholder="规则名 / 物流商 / 渠道 / 模式" style="width: 320px" @keyup.enter="state.filters.logisticsPage = 1" />
              </el-form-item>
              <el-form-item label="状态">
                <el-select v-model="state.filters.logisticsStatus" style="width: 160px">
                  <el-option label="全部状态" value="all" />
                  <el-option label="启用" value="active" />
                  <el-option label="停用" value="inactive" />
                </el-select>
              </el-form-item>
              <el-form-item label="版本">
                <el-select v-model="state.filters.logisticsVersionStatus" style="width: 150px">
                  <el-option label="全部版本" value="all" />
                  <el-option label="当前版本" value="current" />
                  <el-option label="待生效" value="pending" />
                  <el-option label="已过期" value="expired" />
                </el-select>
              </el-form-item>
              <el-form-item>
                <el-button class="erp-btn erp-btn-primary" type="primary" @click="state.filters.logisticsPage = 1">查询</el-button>
                <el-button class="erp-btn erp-btn-secondary" @click="resetLogisticsFilters">重置</el-button>
              </el-form-item>
            </el-form>
          </div>

          <div class="settings-table-wrap">
            <el-table v-loading="loading" :data="pagedLogisticsRules" stripe border class="erp-data-table">
              <el-table-column label="规则" min-width="240" fixed="left">
                <template #default="{ row }">
                  <div class="settings-cell-stack">
                    <div class="logistics-rule-title">
                      <strong>{{ row.name || "-" }}</strong>
                      <el-tag size="small" effect="plain">V{{ logisticsVersionMeta(row).number }}</el-tag>
                    </div>
                    <span class="muted-text">{{ row.carrier || "-" }} / {{ row.channel || "-" }} / {{ row.mode === "fixed" ? "固定费用" : "按克重" }}</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="匹配范围" min-width="200">
                <template #default="{ row }">
                  <div class="settings-cell-stack">
                    <span>克重：{{ Number(row.min_weight_g || 0) }} - {{ Number(row.max_weight_g || 0) }} g</span>
                    <span class="muted-text">售价：{{ Number(row.min_price_rub || 0) }} - {{ Number(row.max_price_rub || 0) }} RUB</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="费用" min-width="200">
                <template #default="{ row }">
                  <div class="settings-cell-stack">
                    <span>基础费：{{ Number(row.base_fee_cny || 0).toFixed(3) }}</span>
                    <span>每克：{{ Number(row.per_gram_cny || 0).toFixed(4) }} <b v-if="logisticsRateDelta(row, 'per_gram_cny')" class="rate-delta">{{ logisticsRateDelta(row, "per_gram_cny") }}</b></span>
                    <span>每票：{{ Number(row.per_ticket_cny || 0).toFixed(3) }} <b v-if="logisticsRateDelta(row, 'per_ticket_cny')" class="rate-delta">{{ logisticsRateDelta(row, "per_ticket_cny") }}</b></span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="生效时间（北京时间）" min-width="190">
                <template #default="{ row }">
                  <div class="settings-cell-stack">
                    <el-tag :type="logisticsVersionStatus(row).type" effect="light">{{ logisticsVersionStatus(row).label }}</el-tag>
                    <strong class="logistics-effective-time">{{ logisticsEffectiveFromText(row) }}</strong>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="失效时间（北京时间）" min-width="180">
                <template #default="{ row }">
                  <span :class="row.effective_to ? 'logistics-expiry-time' : 'muted-text'">{{ row.effective_to ? shanghaiDateTimeText(row.effective_to, { assumeUtcWhenNaive: true }) : "长期有效" }}</span>
                </template>
              </el-table-column>
              <el-table-column label="状态" width="100" align="center">
                <template #default="{ row }">
                  <el-tag :type="Number(row.enabled) !== 0 ? 'success' : 'info'" effect="light">{{ Number(row.enabled) !== 0 ? "启用" : "停用" }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column v-if="canEdit" label="操作" width="300" fixed="right">
                <template #default="{ row }">
                  <div class="table-actions">
                    <el-button class="erp-btn-link" link type="primary" :disabled="Boolean(row.effective_to)" @click="openVersionLogisticsDialog(row)">新增版本</el-button>
                    <el-button class="erp-btn-link" link type="primary" @click="openEditLogisticsDialog(row)">编辑</el-button>
                    <el-button class="erp-btn-link" link :type="Number(row.enabled) !== 0 ? 'danger' : 'success'" @click="toggleLogisticsRule(row)">{{ Number(row.enabled) !== 0 ? "停用" : "启用" }}</el-button>
                    <el-button class="erp-btn-link" link type="danger" @click="deleteLogisticsRule(row)">删除</el-button>
                  </div>
                </template>
              </el-table-column>
            </el-table>
          </div>

          <PageFooterPagination
            :total="logisticsTotal"
            :page="state.filters.logisticsPage"
            :page-size="state.filters.logisticsPageSize"
            @update:page="state.filters.logisticsPage = $event"
            @update:pageSize="state.filters.logisticsPageSize = $event; state.filters.logisticsPage = 1"
          />
        </el-card>

        <el-card v-else shadow="never" class="page-card settings-list-card">
          <template #header>
            <div class="page-card-header">
              <div>
                <strong>{{ currentSectionMeta.title }}</strong>
                <span>{{ currentSectionMeta.description }}</span>
              </div>
              <div class="settings-header-actions">
                <el-button class="erp-btn erp-btn-secondary" @click="refreshSettingsData">刷新</el-button>
                <el-button class="erp-btn erp-btn-primary" type="primary" @click="openCreateCancellationDialog">新增取消规则</el-button>
              </div>
            </div>
          </template>

          <div class="filter-panel">
            <el-form inline>
              <el-form-item label="关键词">
                <el-input v-model="state.filters.cancellationQuery" clearable placeholder="规则名 / 匹配文本 / 原因标签" style="width: 320px" @keyup.enter="state.filters.cancellationPage = 1" />
              </el-form-item>
              <el-form-item label="状态">
                <el-select v-model="state.filters.cancellationStatus" style="width: 160px">
                  <el-option label="全部状态" value="all" />
                  <el-option label="启用" value="active" />
                  <el-option label="停用" value="inactive" />
                </el-select>
              </el-form-item>
              <el-form-item>
                <el-button class="erp-btn erp-btn-primary" type="primary" @click="state.filters.cancellationPage = 1">查询</el-button>
                <el-button class="erp-btn erp-btn-secondary" @click="resetCancellationFilters">重置</el-button>
              </el-form-item>
            </el-form>
          </div>

          <div class="settings-table-wrap">
            <el-table v-loading="loading" :data="pagedCancellationRules" stripe border class="erp-data-table">
              <el-table-column label="规则" min-width="220" fixed="left">
                <template #default="{ row }">
                  <div class="settings-cell-stack">
                    <strong>{{ row.name || "-" }}</strong>
                    <span class="muted-text">{{ row.reason_group_label || "-" }}</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="匹配条件" min-width="260">
                <template #default="{ row }">
                  <div class="settings-cell-stack">
                    <span>{{ row.match_text || "-" }}</span>
                    <span class="muted-text">{{ row.match_mode || "contains" }}</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="业务标签" min-width="240">
                <template #default="{ row }">
                  <div class="settings-cell-stack">
                    <span>取消方：{{ row.initiator_label || "-" }}</span>
                    <span class="muted-text">原因：{{ row.reason_label || "-" }} / {{ row.reason_code || "-" }}</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column prop="priority" label="优先级" width="100" align="center" />
              <el-table-column label="状态" width="100" align="center">
                <template #default="{ row }">
                  <el-tag :type="Number(row.enabled) !== 0 ? 'success' : 'info'" effect="light">{{ Number(row.enabled) !== 0 ? "启用" : "停用" }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="180" fixed="right">
                <template #default="{ row }">
                  <div class="table-actions">
                    <el-button class="erp-btn-link" link type="primary" @click="openEditCancellationDialog(row)">编辑</el-button>
                    <el-button class="erp-btn-link" link :type="Number(row.enabled) !== 0 ? 'danger' : 'success'" @click="toggleCancellationRule(row)">{{ Number(row.enabled) !== 0 ? "停用" : "启用" }}</el-button>
                  </div>
                </template>
              </el-table-column>
            </el-table>
          </div>

          <PageFooterPagination
            :total="cancellationTotal"
            :page="state.filters.cancellationPage"
            :page-size="state.filters.cancellationPageSize"
            :page-sizes="[10, 20, 50]"
            @update:page="state.filters.cancellationPage = $event"
            @update:pageSize="state.filters.cancellationPageSize = $event; state.filters.cancellationPage = 1"
          />
    </el-card>

    <el-dialog v-if="canEdit" v-model="logisticsDialogVisible" :title="logisticsDialogTitle" width="860px" align-center class="erp-centered-dialog" destroy-on-close @closed="clearLogisticsForm">
      <el-form ref="logisticsFormRef" :model="logisticsDialog.form" :rules="logisticsFormRules" label-width="120px">
        <el-row :gutter="18">
          <el-col :span="12"><el-form-item label="规则名称" prop="name"><el-input v-model="logisticsDialog.form.name" placeholder="例如：中国邮政 500g 以下" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="物流商"><el-input v-model="logisticsDialog.form.carrier" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="渠道"><el-input v-model="logisticsDialog.form.channel" /></el-form-item></el-col>
          <el-col v-if="logisticsDialog.mode === 'version'" :span="12"><el-form-item label="生效时间" required><el-date-picker v-model="logisticsDialog.form.effective_from" type="datetime" value-format="YYYY-MM-DD HH:mm" format="YYYY-MM-DD HH:mm" placeholder="按北京时间选择" style="width: 100%" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="计费模式"><el-select v-model="logisticsDialog.form.mode" :disabled="logisticsDialog.mode === 'edit'"><el-option label="按克重" value="per_gram" /><el-option label="固定费用" value="fixed" /></el-select></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="最小克重"><el-input-number v-model="logisticsDialog.form.min_weight_g" :disabled="logisticsDialog.mode === 'edit'" :min="0" :precision="0" :step="1" controls-position="right" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="最大克重"><el-input-number v-model="logisticsDialog.form.max_weight_g" :disabled="logisticsDialog.mode === 'edit'" :min="0" :precision="0" :step="1" controls-position="right" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="最低售价(RUB)"><el-input-number v-model="logisticsDialog.form.min_price_rub" :disabled="logisticsDialog.mode === 'edit'" :min="0" :precision="0" :step="1" controls-position="right" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="最高售价(RUB)"><el-input-number v-model="logisticsDialog.form.max_price_rub" :disabled="logisticsDialog.mode === 'edit'" :min="0" :precision="0" :step="1" controls-position="right" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="基础费用(RMB)"><el-input-number v-model="logisticsDialog.form.base_fee_cny" :disabled="logisticsDialog.mode === 'edit'" :min="0" :precision="3" :step="0.001" controls-position="right" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="每克费用(RMB)"><el-input-number v-model="logisticsDialog.form.per_gram_cny" :disabled="logisticsDialog.mode === 'edit'" :min="0" :precision="4" :step="0.0001" controls-position="right" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="每票费用(RMB)"><el-input-number v-model="logisticsDialog.form.per_ticket_cny" :disabled="logisticsDialog.mode === 'edit'" :min="0" :precision="3" :step="0.001" controls-position="right" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="状态"><el-select v-model="logisticsDialog.form.enabled"><el-option label="启用" :value="1" /><el-option label="停用" :value="0" /></el-select></el-form-item></el-col>
          <el-col :span="24"><el-form-item label="筛选关键词"><el-input v-model="logisticsDialog.form.filter_keywords" type="textarea" :rows="3" placeholder="一行一个，保存后用于订单列表物流筛选匹配" /></el-form-item></el-col>
          <el-col :span="24"><el-form-item label="备注"><el-input v-model="logisticsDialog.form.note" type="textarea" :rows="3" placeholder="可选" /></el-form-item></el-col>
        </el-row>
      </el-form>
      <template #footer>
        <div class="erp-dialog-footer">
          <el-button class="erp-btn erp-btn-secondary" @click="closeLogisticsDialog">取消</el-button>
          <el-button class="erp-btn erp-btn-primary" type="primary" :loading="logisticsDialogSubmitting" @click="submitLogisticsDialog">保存</el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="cancellationDialogVisible" :title="cancellationDialogTitle" width="860px" align-center class="erp-centered-dialog" destroy-on-close @closed="clearCancellationForm">
      <el-form ref="cancellationFormRef" :model="cancellationDialog.form" :rules="cancellationFormRules" label-width="120px">
        <el-row :gutter="18">
          <el-col :span="12"><el-form-item label="规则名称" prop="name"><el-input v-model="cancellationDialog.form.name" placeholder="例如：买家未取货" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="匹配文本" prop="match_text"><el-input v-model="cancellationDialog.form.match_text" placeholder="例如：не забрал" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="匹配模式"><el-select v-model="cancellationDialog.form.match_mode"><el-option label="包含" value="contains" /><el-option label="完全等于" value="equals" /><el-option label="前缀匹配" value="starts_with" /><el-option label="正则" value="regex" /></el-select></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="取消方标签"><el-input v-model="cancellationDialog.form.initiator_label" placeholder="买家 / 卖家 / 平台" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="原因标签"><el-input v-model="cancellationDialog.form.reason_label" placeholder="例如：买家未取货" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="原因类型"><el-select v-model="cancellationDialog.form.reason_code" filterable><el-option v-for="type in reasonReview.types" :key="type.value" :label="type.label" :value="type.value" /><el-option label="其他 / 待归类" value="other" /></el-select></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="原因分组"><el-input v-model="cancellationDialog.form.reason_group_label" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="优先级"><el-input-number v-model="cancellationDialog.form.priority" :min="0" :precision="0" :step="1" controls-position="right" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="状态"><el-select v-model="cancellationDialog.form.enabled"><el-option label="启用" :value="1" /><el-option label="停用" :value="0" /></el-select></el-form-item></el-col>
          <el-col :span="24"><el-form-item label="口径说明"><el-input v-model="cancellationDialog.form.accounting_hint" type="textarea" :rows="2" placeholder="例如：通常不计入有效销售，真实损失按拒收模型处理" /></el-form-item></el-col>
          <el-col :span="24"><el-form-item label="备注"><el-input v-model="cancellationDialog.form.note" type="textarea" :rows="2" placeholder="可选" /></el-form-item></el-col>
        </el-row>
      </el-form>
      <template #footer>
        <div class="erp-dialog-footer">
          <el-button class="erp-btn erp-btn-secondary" @click="closeCancellationDialog">取消</el-button>
          <el-button class="erp-btn erp-btn-primary" type="primary" :loading="cancellationDialogSubmitting" @click="submitCancellationDialog">保存</el-button>
        </div>
      </template>
    </el-dialog>
<el-dialog v-if="activeSection === 'cancel'" v-model="reasonReview.visible" title="人工归类原始取消原因" width="640px" destroy-on-close>
  <el-form label-width="110px"><el-form-item label="原始原因"><el-input :model-value="reasonReview.form.original || `原文待同步，官方代码：${reasonReview.form.reason_id}`" type="textarea" :rows="3" readonly /></el-form-item><el-form-item label="归入类型" required><el-select v-model="reasonReview.form.reason_code" filterable placeholder="选择已收录的原因类型" style="width:100%"><el-option v-for="type in reasonReview.types" :key="type.value" :label="type.label" :value="type.value" /></el-select></el-form-item><el-form-item label="核对备注"><el-input v-model="reasonReview.form.note" maxlength="300" type="textarea" /></el-form-item></el-form>
  <p class="muted-text">分类采用精确匹配并保留 Ozon 原始原因，不执行历史利润重算。</p>
  <template #footer><el-button @click="reasonReview.visible = false">取消</el-button><el-button type="primary" :loading="reasonReview.saving" @click="saveReasonClassification">保存分类</el-button></template>
</el-dialog>
</div>
</template>
<style scoped>
.settings-page{gap:12px}.settings-list-card{min-height:520px;display:flex;flex-direction:column}.settings-table-wrap{overflow:auto}.settings-header-actions,.table-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.settings-cell-stack{display:flex;flex-direction:column;gap:4px}.logistics-rule-title{display:flex;gap:8px;align-items:center}.rate-delta{color:var(--el-color-warning)}.muted-text{color:var(--el-text-color-secondary)}
@media (max-width: 767px) {
  .settings-page { gap: 8px; }
  .settings-list-card { min-height: 0; }
  .settings-header-actions { align-items: stretch; flex-direction: column; width: 100%; }
  .settings-header-actions :deep(.el-button) { width: 100%; margin-left: 0; }
  .settings-page :deep(.el-form-item) { display: block; }
  .settings-page :deep(.el-form-item__label) { width: auto !important; height: auto; margin-bottom: 6px; text-align: left; }
  .settings-page :deep(.el-form-item__content) { margin-left: 0 !important; }
  .settings-page :deep(.el-date-editor) { max-width: 100%; }
}
</style>
