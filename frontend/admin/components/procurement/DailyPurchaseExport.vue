<script setup>
import { computed, ref } from "vue";
import { ElMessage } from "element-plus";
import { apiClient, currentApiCacheScope } from "../../utils/api.js";
import { shanghaiDateKey } from "../../utils/shanghai-date.js";
import { copyToClipboard } from "../../utils/clipboard.js";
import { buildDailyPurchaseWorkbook } from "../../utils/procurement-daily-report.js";

const props = defineProps({
  filters: { type: Object, default: () => ({}) }
});

const today = shanghaiDateKey();
const dateRange = ref([today, today]);
const busy = ref(false);
const visible = ref(false);
const rangeVisible = ref(false);
const summary = ref("");
const hasFilters = computed(() => [...reportQuery().keys()].some((key) => key !== "dateFrom" && key !== "dateTo"));

function reportQuery() {
  const [dateFrom, dateTo] = Array.isArray(dateRange.value) ? dateRange.value : [];
  const params = new URLSearchParams({ dateFrom: dateFrom || today, dateTo: dateTo || dateFrom || today });
  for (const [key, value] of Object.entries({
    query: props.filters.query,
    demandType: props.filters.demandType,
    bindingStatus: props.filters.bindingStatus,
    personId: props.filters.personId,
    supplierId: props.filters.supplierId,
    sourceType: props.filters.sourceType,
    inventoryCategory: props.filters.inventoryCategory,
    productName: props.filters.productName,
    vehicleBrand: props.filters.vehicleBrand,
    vehicleModel: Array.isArray(props.filters.vehicleModel) ? props.filters.vehicleModel.join(",") : props.filters.vehicleModel,
    accessoryName: props.filters.accessoryName,
    color: props.filters.color,
    material: Array.isArray(props.filters.material) ? props.filters.material.join(",") : props.filters.material,
    process: props.filters.process
  })) {
    const text = String(value ?? "").trim();
    if (text && text !== "all") params.set(key, text);
  }
  return params;
}

async function loadImage(productId) {
  const blob = await apiClient.blob(`/api/products/${Number(productId)}/image?thumb=1&w=180`, { signal: AbortSignal.timeout(15000) });
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 168;
    const context = canvas.getContext("2d");
    const scale = Math.max(canvas.width / bitmap.width, canvas.height / bitmap.height);
    context.drawImage(bitmap, (canvas.width - bitmap.width * scale) / 2, (canvas.height - bitmap.height * scale) / 2, bitmap.width * scale, bitmap.height * scale);
    return canvas.toDataURL("image/png");
  } finally {
    bitmap.close();
  }
}

async function exportDaily() {
  if (!Array.isArray(dateRange.value) || dateRange.value.length !== 2 || busy.value) return;
  busy.value = true;
  const [dateFrom, dateTo] = dateRange.value;
  const dateLabel = dateFrom === dateTo ? dateFrom : `${dateFrom} 至 ${dateTo}`;
  const scope = currentApiCacheScope();
  try {
    const result = await apiClient.get(`/api/procurement/daily-report?${reportQuery().toString()}`, { routeScoped: false });
    if (scope !== currentApiCacheScope()) return;
    if (!result.rows.length) {
      ElMessage.info(`${dateLabel}${hasFilters.value ? " 在当前筛选条件下" : ""}暂无已确认采购记录`);
      return;
    }
    const { workbook, missingImages, summary: dailySummaries } = await buildDailyPurchaseWorkbook({ dateFrom, dateTo }, result.rows, loadImage);
    if (scope !== currentApiCacheScope()) return;
    summary.value = dailySummaries;
    rangeVisible.value = false;
    visible.value = true;
    const buffer = await workbook.xlsx.writeBuffer();
    if (scope !== currentApiCacheScope()) return;
    const url = URL.createObjectURL(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `采购清单-${dateFrom}${dateFrom === dateTo ? "" : `至${dateTo}`}.xlsx`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    if (missingImages) ElMessage.warning(`清单已导出，${missingImages} 条明细图片不可用，已在表格中标注`);
    else ElMessage.success("采购清单已按天导出，可复制总结发到微信");
  } catch (error) {
    if (scope === currentApiCacheScope()) ElMessage.error(error.message || "采购清单导出失败，请重试");
  } finally {
    busy.value = false;
  }
}

async function copySummary() {
  if (await copyToClipboard(summary.value)) ElMessage.success("已复制，可粘贴到微信");
  else ElMessage.warning("复制失败，请在文本框中全选复制");
}
</script>

<template>
  <div class="daily-purchase-export">
    <el-button :loading="busy" @click="rangeVisible = true">导出采购记录</el-button>
    <el-dialog v-if="rangeVisible" v-model="rangeVisible" title="导出采购记录" width="min(560px, 94vw)" append-to-body :close-on-click-modal="false" :show-close="!busy" :close-on-press-escape="!busy">
      <p>选择已确认采购记录的采购时间（北京时间）。{{ hasFilters ? "导出沿用工作台当前联合筛选，不受当前分页影响。" : "导出所选日期内全部正式采购记录，不受工作台需求分类、库存缺口或当前分页影响。" }}多个日期导出为一个 Excel，每天一个以日期命名的 Sheet，无采购记录的日期也单独列出。</p>
      <el-form label-position="top"><el-form-item label="采购时间范围">
        <el-date-picker v-model="dateRange" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" :clearable="false" :disabled="busy" aria-label="采购清单时间范围" class="daily-purchase-export__range" />
      </el-form-item></el-form>
      <template #footer><el-button :disabled="busy" @click="rangeVisible = false">取消</el-button><el-button type="primary" :loading="busy" :disabled="!dateRange?.length" @click="exportDaily">确认导出</el-button></template>
    </el-dialog>
    <el-dialog v-if="visible" v-model="visible" title="微信采购总结" width="680px" append-to-body>
      <p>按北京时间逐日统计{{ hasFilters ? "工作台当前联合筛选下的" : "所选日期内全部" }}正式采购记录，不受当前分页影响。Excel 每天一个 Sheet，货款与运费分别列示；下方总结也按天分开。</p>
      <el-input v-model="summary" type="textarea" :rows="14" readonly aria-label="微信采购总结" />
      <template #footer><el-button @click="visible = false">关闭</el-button><el-button type="primary" @click="copySummary">复制微信总结</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.daily-purchase-export { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.daily-purchase-export__range { width: 245px; }
</style>
