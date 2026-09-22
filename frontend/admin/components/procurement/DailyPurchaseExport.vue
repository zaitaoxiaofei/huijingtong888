<script setup>
import { ref } from "vue";
import { ElMessage } from "element-plus";
import { apiClient } from "../../utils/api.js";
import { shanghaiDateKey } from "../../utils/shanghai-date.js";
import { copyToClipboard } from "../../utils/clipboard.js";
import { buildDailyPurchaseWorkbook, dailyPurchaseSummary } from "../../utils/procurement-daily-report.js";

const date = ref(shanghaiDateKey());
const busy = ref(false);
const visible = ref(false);
const summary = ref("");

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
  if (!date.value || busy.value) return;
  busy.value = true;
  const selectedDate = date.value;
  try {
    const result = await apiClient.get(`/api/procurement/daily-report?date=${encodeURIComponent(selectedDate)}`, { routeScoped: false });
    if (!result.rows.length) {
      ElMessage.info(`${selectedDate} 暂无已确认采购记录`);
      return;
    }
    summary.value = dailyPurchaseSummary(selectedDate, result.rows);
    visible.value = true;
    const { workbook, missingImages } = await buildDailyPurchaseWorkbook(selectedDate, result.rows, loadImage);
    const buffer = await workbook.xlsx.writeBuffer();
    const url = URL.createObjectURL(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `每日采购清单-${selectedDate}.xlsx`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    if (missingImages) ElMessage.warning(`清单已导出，${missingImages} 条明细图片不可用，已在表格中标注`);
    else ElMessage.success("每日采购清单已导出，可复制总结发到微信");
  } catch (error) {
    ElMessage.error(error.message || "每日采购清单导出失败，请重试");
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
    <el-date-picker v-model="date" type="date" value-format="YYYY-MM-DD" :clearable="false" :disabled="busy" aria-label="每日采购清单日期" style="width: 145px" />
    <el-button :loading="busy" :disabled="!date" @click="exportDaily">导出每日采购清单</el-button>
    <el-dialog v-if="visible" v-model="visible" title="微信采购总结" width="680px" append-to-body>
      <p>按所选日期的北京时间统计全部正式采购记录，不受工作台筛选或分页影响。货款与运费分别列示。</p>
      <el-input v-model="summary" type="textarea" :rows="14" readonly aria-label="微信采购总结" />
      <template #footer><el-button @click="visible = false">关闭</el-button><el-button type="primary" @click="copySummary">复制微信总结</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.daily-purchase-export { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
</style>
