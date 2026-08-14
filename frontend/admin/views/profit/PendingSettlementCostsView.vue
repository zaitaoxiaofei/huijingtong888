<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { Edit, Refresh, Search } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api.js";
import ErpFilterBar from "../../components/ErpFilterBar.vue";
import ErpPageHeader from "../../components/ErpPageHeader.vue";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import OrdersPage from "../../../orders/OrdersPage.vue";
import { formatInteger, formatMoney } from "./profit-utils.js";
import { shanghaiDateTimeText } from "../../utils/shanghai-date.js";

const router = useRouter();
const route = useRoute();
let controller = null;
const orderInventoryBridge = ref(null);
const state = reactive({ loading: false, recalculating: "", rows: [], shops: [], total: 0, itemTotal: 0, totalPages: 1, summary: {}, filters: { shopId: "all", keyword: "", missing: "all", page: 1, pageSize: 50 } });
const missingOptions = [
  { value: "all", label: "全部缺失项" }, { value: "purchase", label: "采购成本" },
  { value: "international", label: "国际运费" }, { value: "commission", label: "净佣金" },
  { value: "collecting", label: "净收单费" }
];
const reasonLabels = { purchase: "采购成本待同步", international: "国际运费缺失", commission: "净佣金缺失/已冲回", collecting: "净收单费缺失/已冲回" };
const cards = computed(() => [
  { label: "待处理库存商品", value: state.summary.products }, { label: "关联订单商品行", value: state.summary.items },
  { label: "采购成本待同步", value: state.summary.purchase }, { label: "国际运费缺失", value: state.summary.international },
  { label: "平台费用缺失", value: Number(state.summary.commission || 0) + Number(state.summary.collecting || 0) }
]);
const feeDefinitions = [
  ["sale_amount_cny", "销售收入", "income"], ["purchase_cost_cny", "采购成本"], ["domestic_shipping_cny", "国内运费"],
  ["international_shipping_cny", "国际运费"], ["packaging_cost_cny", "包装处理费"], ["commission_fee_cny", "Ozon 佣金"],
  ["collecting_fee_cny", "收单费"], ["ozon_service_fee_cny", "Ozon 服务费"], ["return_loss_cny", "售后/退货损失"],
  ["advertising_cost_cny", "广告费"], ["other_fee_cny", "其他费用"], ["cost_total_cny", "成本合计", "total"],
  ["estimated_profit", "预估利润", "profit"], ["calculated_profit_cny", "当前可计算利润", "profit"]
];
function feeRows(row) { return feeDefinitions.map(([key, label, tone]) => ({ key, label, value: Number(row[key] || 0), tone, missing: row.missing_reasons?.includes({ purchase_cost_cny: "purchase", international_shipping_cny: "international", commission_fee_cny: "commission", collecting_fee_cny: "collecting" }[key]) })); }
function params() { return new URLSearchParams({ shopId: state.filters.shopId, keyword: state.filters.keyword, missing: state.filters.missing, page: String(state.filters.page), pageSize: String(state.filters.pageSize) }); }
async function loadData() { controller?.abort(); controller = new AbortController(); const signal = controller.signal; state.loading = true; try { const data = await apiClient.get(`/api/pending-settlement-costs?${params()}`, { signal, noCache: true }); if (signal.aborted) return; Object.assign(state, { rows: data.rows || [], shops: data.shops || [], total: Number(data.total || 0), itemTotal: Number(data.itemTotal || 0), totalPages: Number(data.totalPages || 1), summary: data.summary || {} }); } catch (error) { if (error?.name !== "AbortError") ElMessage.error(error.message || "待结算成本加载失败"); } finally { if (controller?.signal === signal) { controller = null; state.loading = false; } } }
function search() { state.filters.page = 1; loadData(); }
function editInventory(row) { const returnTo = route.fullPath || "/profit/pending-settlement-costs"; router.push({ path: "/inventory/products", query: { productId: String(row.product_id), openEdit: "1", recalculateAfterSave: "1", returnTo, source: "pending-settlement-costs" } }); }
async function openOrderInventoryDialog(row, action = "bind") {
  const order = row.orders?.find((item) => item.online_product_id) || row.orders?.[0] || {};
  await orderInventoryBridge.value?.openInventoryDialog?.({
    orderId: Number(order.order_id || 0),
    sku: String(order.ozon_sku || row.skus?.[0] || ""),
    action
  });
}
async function handleInventoryCompleted() {
  ElMessage.success("库存处理完成，已返回待结算成本");
  await loadData();
}
function orderStatusText(row) {
  const value = String(row.status || row.tracking_stage || row.logistics_status || "").toLowerCase();
  if (value.includes("delivered") || value.includes("posting_received")) return "已签收";
  if (value.includes("cancel")) return "已取消";
  if (value.includes("deliver")) return "配送中";
  return row.status || row.tracking_stage || "-";
}
function bindingStatus(row) {
  if (row.binding_status === "invalid") return { label: "绑定已失效", type: "danger", hint: "SKU 曾有绑定记录，但对应库存商品已删除或停用，需要重新绑定或创建库存。" };
  if (!row.product_id) return { label: "未绑定库存", type: "warning", hint: "该店铺 SKU 尚未绑定库存商品，因此无法取得采购成本。" };
  if (!row.purchase_inventory_available) return { label: "已绑定，采购价未填", type: "danger", hint: "库存绑定正常，但库存商品没有采购价格，请编辑库存。" };
  if (row.missing_reasons?.includes("purchase")) return { label: "已绑定，成本待同步", type: "warning", hint: "库存已有采购价，但订单成本快照尚未同步，可批量重算。" };
  return { label: "库存已绑定", type: "success", hint: "库存绑定正常，当前待处理的是其他结算费用。" };
}
async function recalculateProduct(row) { if (!row.product_id) return editInventory(row); state.recalculating = row.group_key; try { const result = await apiClient.post(`/api/products/${row.product_id}/recalculate-profits`, { only_missing_purchase: 1 }); const updated = Number(result?.updated || 0); updated > 0 ? ElMessage.success(`已批量重算 ${updated} 个成本待同步订单商品行`) : ElMessage.warning("当前商品没有采购成本待同步订单"); await loadData(); } catch (error) { ElMessage.error(error.message || "批量重算失败"); } finally { state.recalculating = ""; } }
function openOrder(row) { router.push({ path: "/orders", query: { orderId: String(row.order_id) } }); }
onMounted(loadData); onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <div class="page-stack pending-page">
    <div class="order-inventory-bridge" aria-hidden="true"><OrdersPage ref="orderInventoryBridge" @inventory-completed="handleInventoryCompleted" /></div>
    <ErpPageHeader title="待结算成本" description="按库存商品归并问题订单；修改一次库存并批量重算后，所有关联订单会同步更新。展开商品可查看每笔订单的全部费用。">
      <template #actions><el-button class="erp-btn erp-btn-secondary" @click="router.push('/profit/inventory-risks')">库存利润风险</el-button><el-button class="erp-btn erp-btn-secondary" @click="router.push('/profit/order-item-variances')">订单商品行差异</el-button></template>
    </ErpPageHeader>
    <section class="summary-strip"><div v-for="card in cards" :key="card.label"><span>{{ card.label }}</span><strong>{{ formatInteger(card.value) }}</strong></div></section>
    <ErpFilterBar class="filter-band"><el-form inline>
      <el-form-item label="店铺"><el-select v-model="state.filters.shopId" filterable style="width:180px"><el-option label="全部店铺" value="all" /><el-option v-for="shop in state.shops" :key="shop.id" :label="shop.name" :value="String(shop.id)" /></el-select></el-form-item>
      <el-form-item label="缺失项"><el-select v-model="state.filters.missing" style="width:190px"><el-option v-for="item in missingOptions" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
      <el-form-item label="搜索"><el-input v-model="state.filters.keyword" clearable placeholder="订单号、SKU、库存商品名" style="width:250px" @keyup.enter="search" /></el-form-item>
      <el-form-item><el-button type="primary" :icon="Search" @click="search">查询</el-button><el-button :icon="Refresh" @click="loadData">刷新</el-button></el-form-item>
    </el-form></ErpFilterBar>
    <section class="table-section" v-loading="state.loading">
      <div class="section-heading"><div><h2>待处理库存商品</h2><p>一行代表一个库存商品；展开后查看受影响订单及完整费用。</p></div><span>共 {{ formatInteger(state.total) }} 个商品，{{ formatInteger(state.itemTotal) }} 个订单商品行</span></div>
      <el-table :data="state.rows" stripe border height="650" table-layout="fixed" row-key="group_key">
        <el-table-column type="expand" width="48" fixed="left"><template #default="{ row: group }"><div class="orders-panel"><div class="orders-head"><strong>关联订单与全部费用</strong><span>订单信息与订单页面保持同一口径；继续展开订单可查看全部费用。</span></div><el-table :data="group.orders" border size="small" max-height="520">
          <el-table-column type="expand" width="44"><template #default="{ row }"><div class="fee-panel"><el-table :data="feeRows(row)" border size="small" class="fee-table"><el-table-column prop="label" label="费用项目" min-width="180" /><el-table-column label="金额（CNY）" width="150" align="right"><template #default="{ row: fee }"><strong :class="[{ missing: fee.missing }, fee.tone]">{{ fee.missing ? '待处理 · ' : '' }}{{ formatMoney(fee.value) }}</strong></template></el-table-column><el-table-column label="数据状态" min-width="220"><template #default="{ row: fee }">{{ fee.missing ? "阻止结算，需要处理" : "已取得" }}</template></el-table-column></el-table></div></template></el-table-column>
          <el-table-column label="图片" width="72"><template #default="{ row }"><ProductImagePreview :src="row.image_url" :preview-list="row.image_url ? [row.image_url] : []" size="small" /></template></el-table-column>
          <el-table-column label="订单 / 商品" min-width="330"><template #default="{ row }"><button class="order-link" @click="openOrder(row)"><strong>{{ row.posting_number }}</strong><span>{{ row.ozon_name || row.product_name }}</span><small>SKU {{ row.ozon_sku }} · 数量 {{ row.quantity || 1 }}</small></button></template></el-table-column>
          <el-table-column label="店铺" width="135"><template #default="{ row }">{{ row.shop_name || '-' }}</template></el-table-column>
          <el-table-column label="下单时间" width="165"><template #default="{ row }">{{ shanghaiDateTimeText(row.ordered_at) }}</template></el-table-column>
          <el-table-column label="签收时间" width="165"><template #default="{ row }">{{ shanghaiDateTimeText(row.delivered_at) }}</template></el-table-column>
          <el-table-column label="订单状态" width="105"><template #default="{ row }"><el-tag type="success" effect="plain" size="small">{{ orderStatusText(row) }}</el-tag></template></el-table-column>
          <el-table-column label="物流状态" width="145"><template #default="{ row }">{{ row.logistics_status || row.tracking_stage || '-' }}</template></el-table-column>
          <el-table-column label="跟踪号" min-width="165"><template #default="{ row }">{{ row.tracking_number || '-' }}</template></el-table-column>
          <el-table-column label="地区" width="130"><template #default="{ row }">{{ row.buyer_region || '-' }}</template></el-table-column>
          <el-table-column label="销售收入" width="105" align="right"><template #default="{ row }">{{ formatMoney(row.sale_amount_cny) }}</template></el-table-column>
          <el-table-column label="成本合计" width="105" align="right"><template #default="{ row }">{{ formatMoney(row.cost_total_cny) }}</template></el-table-column>
          <el-table-column label="缺失项" min-width="220"><template #default="{ row }"><div class="reason-list"><el-tag v-for="reason in row.missing_reasons" :key="reason" type="danger" effect="plain" size="small">{{ reasonLabels[reason] }}</el-tag></div></template></el-table-column>
        </el-table></div></template></el-table-column>
        <el-table-column label="库存商品" min-width="420" fixed="left"><template #default="{ row }"><div class="product-with-image"><ProductImagePreview :src="row.image_url" :preview-list="row.image_url ? [row.image_url] : []" size="portrait" /><div class="product-cell"><strong>{{ row.product_name }}</strong><span v-if="row.product_code">货号 {{ row.product_code }}</span><small>SKU {{ row.skus.join('、') || '-' }} · {{ row.shops.join('、') }}</small><div class="binding-state"><el-tag :type="bindingStatus(row).type" effect="plain" size="small">{{ bindingStatus(row).label }}</el-tag><span>{{ bindingStatus(row).hint }}</span></div></div></div></template></el-table-column>
        <el-table-column label="当前库存采购成本" width="155" align="right"><template #default="{ row }"><strong :class="{ available: row.purchase_inventory_available }">{{ row.purchase_inventory_available ? formatMoney(row.inventory_purchase_unit_cny) : '未填写' }}</strong></template></el-table-column>
        <el-table-column label="影响订单" width="105" align="right"><template #default="{ row }">{{ formatInteger(row.order_count) }}</template></el-table-column>
        <el-table-column label="销售收入合计" width="125" align="right"><template #default="{ row }">{{ formatMoney(row.sale_amount_cny) }}</template></el-table-column>
        <el-table-column label="当前成本合计" width="125" align="right"><template #default="{ row }">{{ formatMoney(row.cost_total_cny) }}</template></el-table-column>
        <el-table-column label="缺失项" min-width="245"><template #default="{ row }"><div class="reason-list"><el-tag v-for="reason in row.missing_reasons" :key="reason" :type="reason === 'purchase' && row.purchase_inventory_available ? 'warning' : 'danger'" effect="plain" size="small">{{ reasonLabels[reason] }}</el-tag></div></template></el-table-column>
        <el-table-column label="处理" width="250" fixed="right"><template #default="{ row }"><div class="actions"><template v-if="!row.product_id"><el-button size="small" type="primary" :icon="Edit" @click="openOrderInventoryDialog(row, 'bind')">绑定库存</el-button><el-button size="small" @click="openOrderInventoryDialog(row, 'create')">创建库存</el-button></template><el-button v-else size="small" type="primary" :icon="Edit" @click="editInventory(row)">编辑库存</el-button><el-button size="small" :disabled="!row.product_id" :loading="state.recalculating === row.group_key" @click="recalculateProduct(row)">批量重算</el-button></div></template></el-table-column>
      </el-table>
      <PageFooterPagination :total="state.total" :page="state.filters.page" :page-size="state.filters.pageSize" :total-pages="state.totalPages" @update:page="value => { state.filters.page = value; loadData(); }" @update:page-size="value => { state.filters.pageSize = value; state.filters.page = 1; loadData(); }" />
    </section>
  </div>
</template>

<style scoped>
.order-inventory-bridge{position:fixed;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none}
.pending-page{gap:18px;padding-bottom:24px}.summary-strip{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border:1px solid #dfe3e8;border-radius:6px;background:#fff}.summary-strip>div{padding:14px 16px;border-right:1px solid #eaecf0}.summary-strip>div:last-child{border-right:0}.summary-strip span{display:block;color:#667085;font-size:12px}.summary-strip strong{display:block;margin-top:5px;font-size:22px}.filter-band{padding:14px 16px 2px;border:1px solid #dfe3e8;border-radius:6px;background:#fff}.filter-band :deep(.el-form-item){margin-bottom:12px}.section-heading{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:12px;gap:16px}.section-heading h2{margin:0 0 4px;font-size:17px}.section-heading p,.section-heading>span,.orders-head span{margin:0;color:#667085}.product-with-image{display:flex;align-items:center;gap:10px;min-width:0}.product-cell,.order-link{display:flex;width:100%;min-width:0;flex-direction:column;gap:4px}.product-cell span,.product-cell small,.order-link small{color:#667085}.product-cell strong,.product-cell>span,.product-cell small,.order-link span,.order-link small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.binding-state{display:flex;align-items:center;gap:6px;min-width:0}.binding-state>span{font-size:12px;white-space:normal}.order-link{border:0;padding:0;background:transparent;text-align:left;cursor:pointer}.order-link strong{color:#175cd3}.reason-list,.actions{display:flex;flex-wrap:wrap;gap:6px}.orders-panel{padding:14px 18px 20px;background:#f8fafc}.orders-head{display:flex;flex-direction:column;gap:4px;margin-bottom:12px}.fee-panel{padding:12px 18px;background:#f8fafc}.fee-table{max-width:680px}.missing{color:#b42318}.available,.income{color:#175cd3}.profit{color:#067647}.total{font-weight:700}:deep(.el-table th.el-table__cell){background:#f8fafc;color:#475467}:deep(.el-pagination){margin-top:14px;justify-content:flex-end}@media(max-width:1100px){.summary-strip{grid-template-columns:repeat(2,minmax(0,1fr))}.summary-strip>div{border-bottom:1px solid #eaecf0}.section-heading{align-items:flex-start;flex-direction:column}}
</style>
