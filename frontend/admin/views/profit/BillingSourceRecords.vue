<script setup>
import BillingMetricLabel from "./BillingMetricLabel.vue";
import { computed, onBeforeUnmount, reactive, watch } from "vue";
import { apiClient } from "../../utils/api";
import { shanghaiDateText } from "../../utils/shanghai-date.js";
import { formatMoney } from "./profit-utils.js";
const props = defineProps({ filters: { type: Object, required: true }, source: { type: String, default: "platform" } });
const state = reactive({ loading: false, error: "", groups: [], rows: [], total: 0, page: 1, itemName: "" });
let controller;
const projectLabels = {
  SaleAccrual: "销售入账", SaleCommission: "销售佣金", Acquiring: "支付收单手续费", PayPerClick: "点击广告费",
  LastMile: "末端配送费", LastMileCourier: "快递末端配送费", LastMilePickUpPoint: "自提点配送费",
  RfbsGlobalDelivery: "跨境物流费", OzonGlobalLogisticsDelivery: "Ozon全球物流费", InternationalLogisticDelta: "国际物流费用调整",
  Logistic: "物流服务费", Shipment: "发运服务费", BackwardShipment: "逆向运输费", ReturnFlowLogistic: "退货物流费",
  RfbsEasyReturn: "RFBS退货服务费", RfbsServiceFee: "RFBS服务费"
};
function projectLabel(name) { return ad.value ? name : projectLabels[name] || name; }
function projectHint(name) { return ad.value ? "广告报表中的原始活动或商品名称。" : projectLabels[name] ? `Ozon原始项目：${name}；金额保留原始记账正负。` : "平台原始项目，具体含义待核实；不自动认定为额外收入。"; }
const ad = computed(() => props.source === "advertising");
async function load() {
  controller?.abort(); controller = new AbortController(); const signal = controller.signal;
  state.loading = true; state.error = "";
  try {
    const payload = await apiClient.get(`/api/monthly-billing-source-records?${new URLSearchParams({ ...props.filters, source: props.source, page: state.page, pageSize: 30, itemName: state.itemName })}`, { signal, noCache: true });
    if (signal.aborted) return;
    state.groups = payload.groups || []; state.rows = payload.rows || []; state.total = Number(payload.total || 0);
  } catch (error) { if (!signal.aborted) { state.error = error.message || "账单读取失败"; state.groups = []; state.rows = []; state.total = 0; } }
  finally { if (controller?.signal === signal) state.loading = false; }
}
function selectType(name) { state.itemName = name; state.page = 1; load(); }
watch(() => [props.filters.from, props.filters.to, props.filters.shopId, props.filters.companyId, props.source], () => { state.itemName = ""; state.page = 1; state.groups = []; state.rows = []; load(); }, { immediate: true });
onBeforeUnmount(() => controller?.abort());
</script>
<template>
  <div v-loading="state.loading" class="source-records">
    <p>{{ ad ? '广告报表按发生日期列示；有报表金额时替换订单广告成本，不叠加扣费。' : '以下为已同步的 Ozon 原始账单，按入账日期列示；保留原始名称和记账正负，不与订单成本再次相加。' }}</p>
    <el-alert v-if="state.error" type="error" :closable="false" :title="state.error" />
    <el-table :data="state.groups" border stripe empty-text="所选范围暂无已同步的记录">
      <el-table-column prop="item_name" :label="ad ? '广告活动 / 商品' : '原始账单项目'" min-width="240"><template #default="{ row }"><BillingMetricLabel :label="projectLabel(row.item_name)" :hint="projectHint(row.item_name)" /><small v-if="!ad && projectLabels[row.item_name]" class="original-name">{{ row.item_name }}</small></template></el-table-column>
      <el-table-column prop="record_count" label="笔数" width="80" />
      <el-table-column label="金额（CNY）" width="140" align="right"><template #default="{ row }">{{ row.amount_cny == null ? '待换算' : formatMoney(row.amount_cny) }}</template></el-table-column>
      <el-table-column label="具体记录" width="100"><template #default="{ row }"><el-button link type="primary" @click="selectType(row.item_name)">查看记录</el-button></template></el-table-column>
    </el-table>
    <div class="record-heading"><strong>{{ state.itemName || '全部原始记录' }}</strong><el-button v-if="state.itemName" link type="primary" @click="selectType('')">查看全部</el-button></div>
    <el-table :data="state.rows" border stripe empty-text="暂无匹配记录">
      <el-table-column label="日期" width="112"><template #default="{ row }">{{ shanghaiDateText(row.record_date) }}</template></el-table-column>
      <el-table-column prop="shop_name" label="店铺" min-width="130" />
      <el-table-column prop="item_name" label="项目" min-width="200"><template #default="{ row }"><BillingMetricLabel :label="projectLabel(row.item_name)" :hint="projectHint(row.item_name)" /></template></el-table-column>
      <el-table-column :prop="ad ? 'ozon_sku' : 'posting_number'" :label="ad ? '商品SKU' : '订单号'" min-width="160" />
      <el-table-column v-if="!ad" prop="operation_id" label="账单流水号" min-width="180" />
      <el-table-column label="原币金额" width="130" align="right"><template #default="{ row }">{{ row.original_amount == null ? '未提供' : formatMoney(row.original_amount) + ' ' + row.currency_code }}</template></el-table-column>
      <el-table-column label="金额（CNY）" width="140" align="right"><template #default="{ row }">{{ row.amount_cny == null ? '待换算' : formatMoney(row.amount_cny) }}</template></el-table-column>
    </el-table>
    <el-pagination v-model:current-page="state.page" :page-size="30" :total="state.total" layout="total, prev, pager, next" @current-change="load" />
  </div>
</template>
<style scoped>
.original-name { display: block; margin-top: 4px; color: var(--erp-detail-text-regular, #64748b); }
.source-records { display: grid; gap: 16px; }
.source-records > p { margin: 0; line-height: 1.6; color: var(--erp-detail-text-regular, #64748b); }
.record-heading { display: flex; gap: 12px; align-items: center; }
</style>
