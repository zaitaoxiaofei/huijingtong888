<script setup>
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Download, Upload, Refresh } from "@element-plus/icons-vue";
import { apiClient, currentApiCacheScope } from "../../utils/api";
import { useAuthStore } from "../../stores/auth";
import { canReviewFinance } from "../../../../src/shared/finance-submissions.js";
import { shanghaiDateTimeText } from "../../utils/shanghai-date.js";

const props = defineProps({ kind: { type: String, default: "reimbursement" }, month: {type:String,default:""}, companyId:{type:String,default:"all"} });
const emit = defineEmits(["changed"]);
const auth = useAuthStore();
const payroll = computed(() => props.kind === "payroll");
const reviewer = computed(() => canReviewFinance(auth.user));
const allowed = computed(() => Boolean(auth.user?.tenant?.id) && (!payroll.value || reviewer.value));
const label = computed(() => payroll.value ? "工资" : "报销");
const rows = ref([]), status = ref(""), loading = ref(false), busy = ref(false), fileInput = ref(null);
const preview = ref(null), upload = ref(null), detail = ref(null), detailOpen = ref(false), errorText = ref("");
let generation = 0, listSequence = 0, detailSequence = 0, controller;
const money = value => Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const statusText = value => ({ pending: "待审批", approved: "已通过", rejected: "已退回" })[value] || value;
const picture = image => `data:image/${image.extension};base64,${image.base64}`;
function current(token) { return token === generation && allowed.value; }
const templatePath = computed(() => `/api/finance-submissions/template?${new URLSearchParams({kind:props.kind,...(payroll.value?{month:props.month,company_id:props.companyId}:{})})}`);
const mismatchedMonth = computed(() => payroll.value && props.month && preview.value?.items?.some(row => row.month !== props.month));
async function download(path, name) {
  try {
    const token = generation;
    const response = await apiClient.blobResponse(path);
    if (!current(token)) return;
    const url = URL.createObjectURL(response.blob), anchor = document.createElement("a");
    anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { ElMessage.error(error.message || "下载失败"); }
}
async function load() {
  if (!allowed.value) return;
  const token = generation, sequence = ++listSequence;
  controller?.abort(); controller = new AbortController();
  loading.value = true;
  try {
    const result = await apiClient.get(`/api/finance-submissions/list?kind=${props.kind}&status=${status.value}`, { noCache: true, signal: controller.signal });
    if (current(token) && sequence === listSequence) rows.value = result;
  } catch (error) { if (current(token) && error.name !== "AbortError") ElMessage.error(error.message); }
  finally { if (current(token) && sequence === listSequence) loading.value = false; }
}
async function importFile(event) {
  const file = event.target.files?.[0]; event.target.value = "";
  preview.value = null; upload.value = null; errorText.value = "";
  if (!file) return;
  if (!/\.xlsx$/i.test(file.name) || file.size > 8 * 1024 * 1024) { errorText.value = "请上传不超过8MB的 .xlsx 表格"; return; }
  const token = generation;
  busy.value = true;
  try {
    const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = () => reject(new Error("读取文件失败")); reader.readAsDataURL(file); });
    if (!current(token)) return;
    const payload = { kind: props.kind, file_name: file.name, base64 };
    const result = await apiClient.post("/api/finance-submissions/preview", payload);
    if (!current(token)) return;
    upload.value = payload; preview.value = result;
  } catch (error) { if (current(token)) errorText.value = error.message; }
  finally { if (current(token)) busy.value = false; }
}
async function submit() {
  if (!upload.value || busy.value) return;
  const token = generation;
  busy.value = true; errorText.value = "";
  try {
    await apiClient.post("/api/finance-submissions/submit", upload.value);
    if (!current(token)) return;
    preview.value = null; upload.value = null;
    ElMessage.success(`${label.value}申请提交成功，等待审批`); await load(); emit("changed");
  } catch (error) { if (current(token)) errorText.value = error.message; }
  finally { if (current(token)) busy.value = false; }
}
async function showDetail(row) {
  const token = generation, sequence = ++detailSequence;
  detail.value = null; detailOpen.value = true;
  try {
    const result = await apiClient.get(`/api/finance-submissions/detail?id=${row.id}`, { noCache: true });
    if (current(token) && sequence === detailSequence && detailOpen.value) detail.value = result;
  } catch (error) { if (current(token) && sequence === detailSequence) { detailOpen.value = false; ElMessage.error(error.message); } }
}
async function review(nextStatus) {
  const token = generation, id = detail.value?.id;
  try {
    let note = "";
    if (nextStatus === "rejected") note = (await ElMessageBox.prompt("请说明需要补充或修改的内容", "退回申请", { confirmButtonText: "确认退回", cancelButtonText: "取消", inputValidator: value => Boolean(value?.trim()) || "请填写退回原因" })).value;
    else await ElMessageBox.confirm("审批通过后，申请金额将计入对应日期的经营账单。", "确认审批通过", { type: "warning", confirmButtonText: "确认通过", cancelButtonText: "取消" });
    if (!current(token)) return;
    busy.value = true;
    await apiClient.post("/api/finance-submissions/review", { id, status: nextStatus, note });
    if (!current(token)) return;
    detailOpen.value = false; detail.value = null;
    ElMessage.success(nextStatus === "approved" ? "审批已通过" : "申请已退回"); await load(); emit("changed");
  } catch (error) { if (current(token) && error !== "cancel" && error !== "close") ElMessage.error(error.message || "审批失败"); }
  finally { if (current(token)) busy.value = false; }
}
watch(() => [auth.user?.id, auth.user?.tenant?.id, currentApiCacheScope(), props.kind, allowed.value, reviewer.value], () => {
  generation++; controller?.abort(); rows.value = []; preview.value = null; upload.value = null; detail.value = null; detailOpen.value = false; busy.value = false; errorText.value = "";
  load();
}, { immediate: true });
onBeforeUnmount(() => { generation++; controller?.abort(); });
</script>

<template>
  <section v-if="allowed" class="finance-import-panel">
    <div class="import-toolbar">
      <div><h2>{{ payroll ? '工资表导入' : '填写表格，上传报销' }}</h2><p>{{ payroll ? '读取公司抬头与工资月份，核对后提交审批；人工成本为基本工资加单位承担费用。' : '下载企业模板，填写费用并插入凭证截图，上传核对后提交待审批。' }}</p></div>
      <div class="buttons">
        <el-button :icon="Download" @click="download(templatePath, `企业${label}模板.xlsx`)">下载{{ label }}模板</el-button>
        <el-button type="primary" :icon="Upload" :loading="busy" @click="fileInput?.click()">{{ payroll ? '上传工资表' : '上传报销表' }}</el-button>
        <input ref="fileInput" type="file" accept=".xlsx" hidden @change="importFile">
      </div>
    </div>
    <el-alert v-if="!payroll" type="info" :closable="false" title="每行一笔费用；在G列插入普通PNG/JPEG截图，图片左上角放在对应行。支持多张，每次最多100笔、8MB。审批通过不代表已付款。" />
    <el-alert v-else type="info" :closable="false" title="支持现有19列工资表及多个公司、月份工作表；读取表内金额，不套用统一社保比例。同公司同月份不重复导入；已退回批次可修改后重新上传。" />
    <el-alert v-if="payroll&&month" type="info" :closable="false" :title="`当前补录 ${month}：模板已带入月份；上传原工资表时仍按表内公司和年月记账。`" />
    <el-alert v-if="mismatchedMonth" type="warning" :closable="false" title="上传表内包含其他月份，请核对预览中的费用日期；系统不会把历史工资自动改到当前月份。" />
    <el-alert v-if="errorText" type="error" :closable="false" :title="errorText" show-icon />
    <el-card v-if="preview" shadow="never" class="preview-card">
      <div class="import-toolbar"><div><h3>核对导入内容 · {{ preview.item_count }} 笔</h3><p>{{ upload.file_name }} · {{ payroll ? '公司人工成本' : '报销合计' }} ¥{{ money(preview.total_amount) }}</p></div><div class="buttons"><el-button :disabled="busy" @click="preview=null; upload=null">取消</el-button><el-button :disabled="busy" type="primary" :loading="busy" @click="submit">确认提交待审批</el-button></div></div>
      <el-table :data="preview.items" max-height="420" stripe>
        <el-table-column prop="person_name" label="姓名" width="100" /><el-table-column prop="company_name" label="公司" min-width="210" /><el-table-column prop="expense_date" label="费用日期" width="120" /><el-table-column prop="category" label="类别" width="110" /><el-table-column prop="description" label="事由" min-width="170" />
        <el-table-column label="金额（元）" width="130" align="right"><template #default="{row}">{{ money(row.amount) }}</template></el-table-column>
        <el-table-column v-if="!payroll" label="凭证截图" width="160"><template #default="{row}"><el-image v-for="(image, index) in row.images" :key="index" class="receipt" :src="picture(image)" :preview-src-list="row.images.map(picture)" :initial-index="index" preview-teleported fit="contain" /></template></el-table-column>
        <el-table-column v-if="payroll" label="实发工资" width="130"><template #default="{row}">{{ money(row.net) }}</template></el-table-column>
      </el-table>
    </el-card>
    <div class="import-toolbar records-heading"><div><h3>{{ reviewer ? '全部申请' : '我的申请' }}</h3><p>显示最近200条；点击查看明细，可下载含截图的Excel记录。</p></div><div class="buttons"><el-select v-model="status" aria-label="审批状态" placeholder="全部状态" style="width:140px" @change="load"><el-option label="全部状态" value="" /><el-option label="待审批" value="pending" /><el-option label="已通过" value="approved" /><el-option label="已退回" value="rejected" /></el-select><el-button :icon="Refresh" @click="load">刷新</el-button></div></div>
    <el-table v-loading="loading" :data="rows" stripe empty-text="暂无申请，填写模板后即可上传">
      <el-table-column prop="id" label="编号" width="80" /><el-table-column prop="applicant_name" label="提交人" width="110" /><el-table-column prop="file_name" label="表格" min-width="180" /><el-table-column prop="item_count" label="笔数" width="75" />
      <el-table-column label="金额（元）" width="140" align="right"><template #default="{row}">{{ money(row.total_amount) }}</template></el-table-column>
      <el-table-column label="状态" width="100"><template #default="{row}"><el-tag :type="row.status === 'approved' ? 'success' : row.status === 'rejected' ? 'danger' : 'warning'">{{ statusText(row.status) }}</el-tag></template></el-table-column>
      <el-table-column label="提交时间" width="180"><template #default="{row}">{{ shanghaiDateTimeText(row.created_at, {assumeUtcWhenNaive:true}) }}</template></el-table-column>
      <el-table-column label="操作" width="160"><template #default="{row}"><el-button link type="primary" @click="showDetail(row)">{{ reviewer && row.status==='pending' ? '查看并审批' : '查看明细' }}</el-button><el-button link @click="download(`/api/finance-submissions/export?id=${row.id}`, `${label}明细-${row.id}.xlsx`)">导出</el-button></template></el-table-column>
    </el-table>
    <el-drawer v-model="detailOpen" :title="`${label}申请详情`" size="min(100%, 1050px)" destroy-on-close>
      <template v-if="detail">
        <div class="detail-summary"><el-tag>{{ statusText(detail.status) }}</el-tag><strong>{{ detail.applicant_name }} · {{ detail.item_count }}笔 · ¥{{ money(detail.total_amount) }}</strong><p v-if="detail.review_note">审批意见：{{ detail.review_note }}</p></div>
        <article v-for="item in detail.items" :key="item.id" class="detail-item">
          <div><strong>{{ item.person_name }} · {{ item.company_name }}</strong><p>{{ item.expense_date }} · {{ item.category }} · {{ item.description }}</p><p v-if="item.note">备注：{{ item.note }}</p><b>¥{{ money(item.amount) }}</b></div>
          <p v-if="payroll">基本工资 ¥{{ money(item.base) }} ＋ 单位缴费 ¥{{ money(item.employer) }}；个人缴费 ¥{{ money(item.employee) }}，个税 ¥{{ money(item.tax) }}，实发 ¥{{ money(item.net) }}</p>
          <el-image v-for="(image, index) in item.images" :key="index" class="detail-receipt" :src="picture(image)" :preview-src-list="item.images.map(picture)" :initial-index="index" preview-teleported fit="contain" />
        </article>
      </template>
      <template #footer><div v-if="detail" class="buttons"><el-button @click="download(`/api/finance-submissions/export?id=${detail.id}`, `${label}明细-${detail.id}.xlsx`)">导出明细与截图</el-button><template v-if="reviewer && detail.status==='pending'"><el-button :disabled="busy" @click="review('rejected')">退回修改</el-button><el-button type="primary" :loading="busy" :disabled="busy" @click="review('approved')">审批通过</el-button></template></div></template>
    </el-drawer>
  </section>
</template>

<style scoped>
.finance-import-panel{display:grid;gap:18px}.import-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}.import-toolbar h2,.import-toolbar h3{margin:0 0 8px}.import-toolbar p,.detail-item p{color:var(--el-text-color-secondary);margin:6px 0}.buttons{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.receipt{width:58px;height:58px;margin:3px}.detail-receipt{width:180px;height:150px;margin:12px 12px 0 0}.detail-item{padding:20px 0;border-bottom:1px solid var(--el-border-color-lighter)}.detail-summary{padding-bottom:18px;border-bottom:1px solid var(--el-border-color)}.detail-summary strong{margin-left:12px}.records-heading{margin-top:8px}
</style>
