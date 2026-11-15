<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { Delete, Edit, Plus, View } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";
import ErpFilterBar from "../../components/ErpFilterBar.vue";
import ErpPageHeader from "../../components/ErpPageHeader.vue";
import ErpPeriodSwitcher from "../../components/ErpPeriodSwitcher.vue";
import { shanghaiDateKey, shanghaiDateText } from "../../utils/shanghai-date.js";
import { billingDateRange } from "../../utils/billing-period.js";
import BillingSourceRecords from "./BillingSourceRecords.vue";
import { buildBillingGroups } from "./billing-groups.js";
import BillingMetricLabel from "./BillingMetricLabel.vue";
import { billingMetrics } from "./billing-metrics.js";
import { billingExpenseCategories, billingExpenseCategoryLabel, summarizeBillingExpenses } from "./billing-expense-categories.js";
import { formatInteger, formatMoney } from "./profit-utils.js";

const route = useRoute();
const router = useRouter();
let abortController = null;

function initialDateRange() { return billingDateRange(route.query, shanghaiDateKey()); }

const state = reactive({
  loading: false,
  dateRange: initialDateRange(),
  shopId: String(route.query.shopId || "all"),
  companyId: String(route.query.companyId || "all"),
  shops: [],
  companies: [],
  assignments: [],
  month: { summary: {}, shops: [], expenses: [] }
});

const expenseDialog = ref(false);
const expenseDrawer = ref(false);
const expenseCategoryFilter = ref("");
const capitalDrawer = ref(false);
const groupDrawer = ref(false);
const groupKey = ref("operating");
const showEmptyGroupItems = ref(false);
const sourceDrawer = ref(false);
const sourceKind = ref("platform");
const orderRecordDrawer = ref(false);
const recordItem = ref(null);
const orderRecords = reactive({ loading: false, error: "", rows: [], total: 0, page: 1, keyword: "" });
let recordController;
const sourceFilters = computed(() => ({ from: state.dateRange[0], to: state.dateRange[1], shopId: String(state.shopId || "all"), companyId: state.companyId }));
const savingExpense = ref(false);
const expenseForm = reactive({
  id: "",
  company_id: "",
  shop_id: "",
  expense_date: shanghaiDateKey(),
  category: "other",
  description: "",
  amount_cny: 0,
  paid_by: "",
  is_advance_payment: false,
  advanced_by: "",
  payment_reference: ""
});

const selectedPeriodTitle = computed(() => `${state.dateRange?.[0] || "-"} 至 ${state.dateRange?.[1] || "-"}`);
const selectedSummary = computed(() => state.month?.summary || {});
const procurementInventory = computed(() => state.month?.procurement_inventory || {});
const aiUsage = computed(() => state.month?.ai_usage || {});
const aiUsagePeople = computed(() => Array.isArray(aiUsage.value.people) ? aiUsage.value.people : []);
const billingGroups = computed(() => buildBillingGroups(selectedSummary.value, expenseRows.value));
const incomeGroup = computed(() => billingGroups.value[0]);
const expenseGroups = computed(() => billingGroups.value.slice(1));
const selectedGroup = computed(() => billingGroups.value.find(item => item.key === groupKey.value));
const visibleGroupItems = computed(() => (selectedGroup.value?.children || []).filter(item => showEmptyGroupItems.value || item.source !== "expenses" || item.amount !== 0));
const classifiedExpenseTotal = computed(() => expenseGroups.value.reduce((sum, group) => sum + group.amount, 0));
const unclassifiedDifference = computed(() => Math.round((Number(selectedSummary.value.revenue || 0) - Number(selectedSummary.value.net_profit || 0) - classifiedExpenseTotal.value) * 100) / 100);
function openGroup(group) { groupKey.value = group.key; showEmptyGroupItems.value = false; groupDrawer.value = true; }
function openSource(source = "platform") { sourceKind.value = source; sourceDrawer.value = true; }
async function loadOrderRecords() {
  recordController?.abort(); recordController = new AbortController(); const signal = recordController.signal;
  orderRecords.loading = true; orderRecords.error = "";
  try {
    const result = await apiClient.get(`/api/monthly-billing-orders?${new URLSearchParams({ ...sourceFilters.value, page: orderRecords.page, pageSize: 30, keyword: orderRecords.keyword })}`, { signal, noCache: true });
    if (!signal.aborted) { orderRecords.rows = result.rows || []; orderRecords.total = Number(result.total || 0); }
  } catch (error) { if (!signal.aborted) { orderRecords.error = error.message || "订单明细读取失败"; orderRecords.rows = []; orderRecords.total = 0; } }
  finally { if (recordController?.signal === signal) orderRecords.loading = false; }
}
function showGroupItem(item) {
  if (item.source === "expenses") return showExpenses(item.key);
  if (item.source === "advertising") return openSource("advertising");
  if (item.source === "unavailable") return openSource();
  recordItem.value = item; orderRecords.page = 1; orderRecords.keyword = ""; orderRecords.rows = []; orderRecordDrawer.value = true; loadOrderRecords();
}
const shopRows = computed(() => (state.month?.shops || []).map(row => {
  const groups = buildBillingGroups(row, expenseRows.value.filter(expense => String(expense.shop_id || "") === String(row.shop_id)));
  const byKey = Object.fromEntries(groups.map(group => [group.key, group.amount]));
  return { ...row, operating_expense: byKey.operating, personnel_expense: byKey.personnel, funds_expense: byKey.funds, grouped_expense_total: groups.slice(1).reduce((sum, group) => sum + group.amount, 0) };
}));
const expenseRows = computed(() => state.month?.expenses || []);
const expenseBreakdown = computed(() => summarizeBillingExpenses(expenseRows.value));
const visibleExpenseRows = computed(() => expenseRows.value.filter((row) => !expenseCategoryFilter.value || (row.category || "other") === expenseCategoryFilter.value));
function showExpenses(category = "") { expenseCategoryFilter.value = category; expenseDrawer.value = true; }
const aiSubscription = computed(() => expenseBreakdown.value.find((item) => item.value === "ai_subscription")?.amount || 0);

function formatAiMoney(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? amount.toFixed(3) : "0.000";
}

function formatRatio(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : "0.0%";
}


const summaryCards = computed(() => [
  { metric: "order_count", label: billingMetrics.order_count.label, display: formatInteger(selectedSummary.value.order_count), suffix: "单", tone: "normal" },
  { metric: "revenue", label: billingMetrics.revenue.label, value: selectedSummary.value.revenue, suffix: "CNY", tone: "income" },
  { metric: "net_profit", label: billingMetrics.net_profit.label, value: selectedSummary.value.net_profit, suffix: "CNY", tone: Number(selectedSummary.value.net_profit || 0) >= 0 ? "profit" : "loss" },
  { metric: "net_profit_margin", label: billingMetrics.net_profit_margin.label, display: formatRatio(selectedSummary.value.net_profit_margin), tone: "ratio" },
  { metric: "profit", label: billingMetrics.profit.label, value: selectedSummary.value.profit, suffix: "未扣公司经营与人员费用", tone: "normal" },
  { metric: "accrued_profit", label: billingMetrics.accrued_profit.label, value: selectedSummary.value.accrued_profit, suffix: `${formatInteger(selectedSummary.value.accrued_order_count)} 单`, tone: "settled" },
  { metric: "pending_profit", label: billingMetrics.pending_profit.label, value: selectedSummary.value.pending_profit, suffix: `${formatInteger(selectedSummary.value.pending_order_count)} 单`, tone: "pending" },
  { metric: "ai_cost", label: billingMetrics.ai_cost.label, display: `${formatAiMoney(aiUsage.value.cost)} RMB`, suffix: `${formatInteger(aiUsage.value.request_count)} 次调用`, tone: "ai" }
]);

const procurementCards = computed(() => {
  const row = procurementInventory.value;
  return [
    { metric: "purchase_cost", label: billingMetrics.purchase_cost.label, value: selectedSummary.value.purchase_cost, hint: "随本期有效订单计入利润" },
    { metric: "purchase_total_amount", label: billingMetrics.purchase_total_amount.label, value: row.purchase_total_amount, hint: `${formatInteger(row.purchase_order_count)} 张已确认采购单` },
    { metric: "purchase_goods_amount", label: billingMetrics.purchase_goods_amount.label, value: row.purchase_goods_amount, hint: `${formatInteger(row.purchase_quantity)} 件` },
    { metric: "purchase_shipping_amount", label: billingMetrics.purchase_shipping_amount.label, value: row.purchase_shipping_amount, hint: "已包含在本期采购支出中" },
    { metric: "inbound_amount", label: billingMetrics.inbound_amount.label, value: row.inbound_amount, hint: `${formatInteger(row.inbound_quantity)} 件` }
  ];
});

const inventoryCards = computed(() => {
  const row = procurementInventory.value;
  return [
    { metric: "inventory_total_value", label: billingMetrics.inventory_total_value.label, value: row.inventory_total_value, quantity: null, total: true },
    { metric: "local_inventory_value", label: billingMetrics.local_inventory_value.label, value: row.local_inventory_value, quantity: row.local_inventory_quantity },
    { metric: "fbp_inventory_value", label: billingMetrics.fbp_inventory_value.label, value: row.fbp_inventory_value, quantity: row.fbp_inventory_quantity },
    { metric: "in_transit_value", label: billingMetrics.in_transit_value.label, value: row.in_transit_value, quantity: row.in_transit_quantity }
  ];
});

function shiftMonth(offset) {
  const [from, to] = state.dateRange || [];
  const shift = (value) => {
    const date = new Date(`${value}T00:00:00+08:00`);
    date.setMonth(date.getMonth() + Number(offset || 0));
    return shanghaiDateKey(date);
  };
  state.dateRange = [shift(from), shift(to)];
  applyBillingFilters();
}

function applyBillingFilters() {
  router.replace({
    path: route.path,
    query: {
      ...route.query,
      from: state.dateRange[0],
      to: state.dateRange[1],
      shopId: String(state.shopId || "all"),
      companyId: state.companyId
    }
  });
  loadData();
}

function detailRoute(shop = null) {
  return {
    path: "/profit/monthly-billing",
    query: {
      tab: "orders",
      from: state.dateRange[0],
      to: state.dateRange[1],
      shopId: shop?.shop_id ? String(shop.shop_id) : String(state.shopId || "all"),
      companyId: state.companyId
    }
  };
}

function openOrderDetails(shop = null) {
  router.push(detailRoute(shop));
}

function defaultCompanyId(shopId = "") {
  if (state.companyId !== "all") return String(state.companyId);
  const assignment = state.assignments.find((item) => String(item.shop_id) === String(shopId || state.shopId));
  return String(assignment?.company_id || state.companies[0]?.id || "");
}

function resetExpenseForm(category = "other") {
  Object.assign(expenseForm, {
    id: "",
    company_id: defaultCompanyId(),
    shop_id: state.shopId === "all" ? "" : String(state.shopId),
    expense_date: state.dateRange?.[0] || shanghaiDateKey(),
    category,
    description: category === "ai_subscription" ? "GPT Pro（1个账号，5倍Token，本期订阅）" : "",
    amount_cny: category === "ai_subscription" ? 700 : 0,
    paid_by: "",
    is_advance_payment: false,
    advanced_by: "",
    payment_reference: ""
  });
}

function openExpense(row = null, category = "other") {
  resetExpenseForm(category);
  if (row) {
    Object.assign(expenseForm, {
      id: row.id,
      company_id: String(row.company_id || defaultCompanyId(row.shop_id)),
      shop_id: row.shop_id ? String(row.shop_id) : "",
      expense_date: String(row.expense_date || "").slice(0, 10),
      category: row.category || "other",
      description: row.description || "",
      amount_cny: Number(row.amount_cny || 0),
      paid_by: row.paid_by || "",
      is_advance_payment: Boolean(row.is_advance_payment),
      advanced_by: row.advanced_by || "",
      payment_reference: row.payment_reference || ""
    });
  }
  expenseDialog.value = true;
}

async function saveExpense() {
  if (!expenseForm.company_id || !expenseForm.expense_date || !expenseForm.description.trim()) {
    ElMessage.warning("请填写归属公司、发生日期和项目名称");
    return;
  }
  if (Number(expenseForm.amount_cny || 0) <= 0) {
    ElMessage.warning("费用金额必须大于 0");
    return;
  }
  savingExpense.value = true;
  try {
    await apiClient.post("/api/finance-center/expenses", {
      ...expenseForm,
      company_id: Number(expenseForm.company_id),
      shop_id: expenseForm.shop_id ? Number(expenseForm.shop_id) : null,
      currency_code: "CNY",
      original_amount: Number(expenseForm.amount_cny || 0),
      exchange_rate: 1,
      amount_cny: Number(expenseForm.amount_cny || 0),
      advanced_by: expenseForm.is_advance_payment ? expenseForm.advanced_by : "",
      voucher_status: "missing"
    });
    expenseDialog.value = false;
    ElMessage.success("经营费用已保存，净利润已更新");
    await loadData();
  } catch (error) {
    ElMessage.error(error.message || "经营费用保存失败");
  } finally {
    savingExpense.value = false;
  }
}

async function removeExpense(row) {
  try {
    await ElMessageBox.confirm(`确认删除“${row.description || row.category}”这笔费用？`, "删除经营费用", { type: "warning" });
    await apiClient.delete(`/api/finance-center/expenses/${row.id}`);
    ElMessage.success("经营费用已删除");
    await loadData();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "经营费用删除失败");
  }
}

async function loadData() {
  abortController?.abort();
  abortController = new AbortController();
  const { signal } = abortController;
  state.loading = true;
  try {
    const params = new URLSearchParams({
      from: state.dateRange[0],
      to: state.dateRange[1],
      shopId: String(state.shopId || "all"),
      companyId: state.companyId
    });
    const [payload, financeMeta] = await Promise.all([
      apiClient.get(`/api/monthly-billing-details?${params.toString()}`, { signal }),
      apiClient.get("/api/finance-center/companies", { signal })
    ]);
    if (signal.aborted) return;
    state.shops = Array.isArray(payload?.shops) ? payload.shops : [];
    state.month = payload?.selected || payload?.months?.[0] || { summary: {}, shops: [], expenses: [] };
    state.companies = Array.isArray(financeMeta?.companies) ? financeMeta.companies : [];
    state.assignments = Array.isArray(financeMeta?.assignments) ? financeMeta.assignments : [];
  } catch (error) {
    if (error?.name === "AbortError") return;
    ElMessage.error(error.message || "月度账单加载失败");
  } finally {
    if (abortController?.signal === signal) {
      abortController = null;
      state.loading = false;
    }
  }
}

function handleReset() {
  state.dateRange = initialDateRange();
  state.shopId = "all";
  applyBillingFilters();
}

onMounted(loadData);
watch(
  () => [route.query.from, route.query.to, route.query.shopId, route.query.companyId, route.query.year, route.query.month, route.query.selectedMonth],
  ([from, to, shopId, companyId], previous) => {
    if (!previous || route.path !== "/profit/monthly-billing") return;
    const nextRange = initialDateRange();
    const nextShopId = String(shopId || "all");
    const nextCompanyId = String(companyId || "all");
    if (nextRange[0] === state.dateRange[0] && nextRange[1] === state.dateRange[1] && nextShopId === state.shopId && nextCompanyId === state.companyId) return;
    state.dateRange = nextRange;
    state.shopId = nextShopId;
    state.companyId = nextCompanyId;
    loadData();
  }
);
watch(sourceFilters, () => { if (orderRecordDrawer.value) { orderRecords.page = 1; loadOrderRecords(); } });
onBeforeUnmount(() => { abortController?.abort(); recordController?.abort(); });
</script>

<template>
  <div class="page-stack monthly-billing-page">
    <el-card shadow="never" class="page-card billing-filter-card">
      <ErpPageHeader title="经营账单" description="汇总所选日期范围的收入、成本与净利润，点击金额项目查看明细。">
        <template #actions>
          <ErpFilterBar class="billing-controls">
          <el-form inline class="billing-filters">
            <el-form-item label="统计时间">
              <el-date-picker
                v-model="state.dateRange"
                type="daterange"
                value-format="YYYY-MM-DD"
                range-separator="至"
                start-placeholder="开始日期"
                end-placeholder="结束日期"
                :clearable="false"
                style="width: 260px"
              />
            </el-form-item>
            <el-form-item label="公司"><el-select v-model="state.companyId" filterable style="width:240px"><el-option label="全部公司" value="all" /><el-option v-for="company in state.companies" :key="company.id" :label="company.name" :value="String(company.id)" /></el-select></el-form-item>
            <el-form-item label="店铺">
              <el-select v-model="state.shopId" filterable style="width: 210px">
                <el-option label="全部店铺" value="all" />
                <el-option v-for="shop in state.shops" :key="shop.id" :label="shop.name" :value="String(shop.id)" />
              </el-select>
            </el-form-item>
            <el-form-item class="billing-filter-actions">
              <el-button class="erp-btn erp-btn-primary" type="primary" :loading="state.loading" @click="applyBillingFilters">查询</el-button>
              <el-button class="erp-btn erp-btn-secondary" @click="handleReset">重置</el-button>
            </el-form-item>
          </el-form>
            <template #actions>
              <ErpPeriodSwitcher
                :period="selectedPeriodTitle"
                caption="当前统计区间"
                @previous="shiftMonth(-1)"
                @next="shiftMonth(1)"
              />
            </template>
          </ErpFilterBar>
        </template>
      </ErpPageHeader>
    </el-card>

    <section v-loading="state.loading" class="billing-overview">
      <div class="section-head">
        <div>
          <strong>{{ selectedPeriodTitle }} 经营结果</strong>
          <span>经营净利润已扣订单成本及录入费用；待结算利润不重复扣减。</span>
        </div>
        <div class="head-actions">
          <el-button class="erp-btn erp-btn-secondary" @click="router.push('/finance-center')">返回年度总览</el-button>
          <el-button class="erp-btn erp-btn-secondary" @click="capitalDrawer = true">采购支出与库存资金</el-button>
          <el-button class="erp-btn erp-btn-secondary" :icon="Plus" @click="openExpense(null, 'other')">补录费用</el-button>
          <el-button class="erp-btn erp-btn-secondary" @click="router.push({path:'/finance/payroll',query:{month:state.dateRange[0].slice(0,7),companyId:state.companyId,action:'import'}})">补录本月工资</el-button>
          <el-button class="erp-btn erp-btn-primary" type="primary" :icon="View" @click="openOrderDetails()">订单明细</el-button>
        </div>
      </div>

      <div class="summary-grid">
        <div v-for="item in summaryCards" :key="item.label" class="summary-card" :class="`is-${item.tone}`">
          <BillingMetricLabel :metric="item.metric" />
          <strong>{{ item.display ?? formatMoney(item.value) }}</strong>
          <small>{{ item.suffix }}</small>
        </div>
      </div>

      <div class="profit-workspace">
        <div class="formula-card">
          <div class="formula-heading">
            <div>
              <strong>收入与费用明细</strong>
              <p>收入与支出分开展示；点击明细可查看子项金额和具体记录。</p>
            </div>
            <div class="net-result" :class="{ negative: Number(selectedSummary.net_profit || 0) < 0 }">
              <BillingMetricLabel metric="net_profit" />
              <strong>¥{{ formatMoney(selectedSummary.net_profit) }}</strong>
              <small><BillingMetricLabel metric="net_profit_margin" /> {{ formatRatio(selectedSummary.net_profit_margin) }}</small>
            </div>
          </div>
          <div class="income-group">
            <BillingMetricLabel :label="incomeGroup.label" :hint="incomeGroup.hint" />
            <el-button link type="primary" @click="openGroup(incomeGroup)">明细</el-button>
            <strong>¥{{ formatMoney(incomeGroup.amount) }}</strong>
          </div>
          <div class="expense-group-heading">支出分类</div>
          <div class="formula-list">
            <div v-for="group in expenseGroups" :key="group.key" class="group-row">
              <BillingMetricLabel :label="group.label" :hint="group.hint" />
              <el-button link type="primary" @click="openGroup(group)">明细</el-button>
              <strong>¥{{ formatMoney(group.amount) }}</strong>
            </div>
          </div>
          <p v-if="unclassifiedDifference" class="group-note">分类支出与现有净利润口径相差 ¥{{ formatMoney(unclassifiedDifference) }}，保留为待核对差额，不额外扣费。</p>
          <p class="group-note">退货损失汇总 ¥{{ formatMoney(selectedSummary.return_loss) }} 仅供参考，可能包含货值和运费，不作为第七类支出重复相加。</p>
          <div class="formula-total">
            <span>=</span>
            <strong><BillingMetricLabel metric="net_profit" /></strong>
            <small>{{ formatRatio(selectedSummary.net_profit_margin) }}</small>
            <b>¥{{ formatMoney(selectedSummary.net_profit) }}</b>
          </div>
        </div>

        <aside class="settlement-card">
          <strong>结算状态</strong>
          <p>按 Ozon 财务入账状态区分；待结算单独展示，不作为成本再次扣除。</p>
          <div class="settlement-value is-settled">
            <BillingMetricLabel metric="accrued_profit" />
            <b>¥{{ formatMoney(selectedSummary.accrued_profit) }}</b>
          </div>
          <div class="settlement-meta">
            <BillingMetricLabel metric="accrued_order_count" />
            <strong>{{ formatInteger(selectedSummary.accrued_order_count) }} 单</strong>
          </div>
          <div class="settlement-value is-pending">
            <BillingMetricLabel metric="pending_profit" />
            <b>¥{{ formatMoney(selectedSummary.pending_profit) }}</b>
          </div>
          <div class="settlement-meta">
            <BillingMetricLabel metric="pending_order_count" />
            <strong>{{ formatInteger(selectedSummary.pending_order_count) }} 单</strong>
          </div>
          <div class="settlement-meta">
            <BillingMetricLabel metric="settlement_rate" />
            <strong>{{ formatRatio(selectedSummary.settlement_rate) }}</strong>
          </div>
          <el-alert type="info" :closable="false" show-icon>
            <template #title>公司共用经营费用只计入总体净利润，不自动分摊到店铺。</template>
          </el-alert>
        </aside>
      </div>
    </section>

    <el-drawer v-model="capitalDrawer" title="采购支出与库存资金" size="min(100%, 1050px)" destroy-on-close>
    <section v-loading="state.loading" class="capital-section">
      <div class="section-head">
        <div>
          <strong>采购支出与库存资金</strong>
          <span>采购支出按北京时间确认采购日期统计；库存占用为当前快照，不参与上方订单利润的重复扣减。</span>
        </div>
      </div>
      <div class="capital-workspace">
        <div class="capital-panel">
          <div class="capital-panel__title">
            <strong>本期采购</strong>
            <span>区分“卖掉多少成本”和“实际采购花了多少”</span>
          </div>
          <div class="capital-metric-grid procurement-metric-grid">
            <article v-for="item in procurementCards" :key="item.label" class="capital-metric">
              <BillingMetricLabel :metric="item.metric" />
              <strong>¥{{ formatMoney(item.value) }}</strong>
              <small>{{ item.hint }}</small>
            </article>
          </div>
        </div>
        <div class="capital-panel">
          <div class="capital-panel__title">
            <strong>当前库存占用</strong>
            <span>国内仓按可用数量计价；单价采用最新采购落地成本，缺失时回退商品采购成本</span>
          </div>
          <div class="capital-metric-grid inventory-metric-grid">
            <article v-for="item in inventoryCards" :key="item.label" class="capital-metric" :class="{ 'is-total': item.total }">
              <BillingMetricLabel :metric="item.metric" />
              <strong>{{ item.value==null?'待核实':`¥${formatMoney(item.value)}` }}</strong>
              <small>{{ item.total ? '国内可用 + FBP + 在途' : item.quantity==null?'数量待核实':`${formatInteger(item.quantity)} 件` }}</small>
            </article>
          </div>
        </div>
      </div>
      <el-alert type="warning" :closable="false" show-icon class="capital-alert">
        <template #title>未经过采购确认或平台订单尚未关联到采购单的支出不会进入本期采购支出，请及时在采购工作台补录或关联。</template>
      </el-alert>
    </section>

    </el-drawer>

    <section v-loading="state.loading" class="shop-section">
      <div class="section-head">
        <div>
          <strong>{{ selectedPeriodTitle }} 各店铺账单</strong>
          <span>主表突出经营结果；详细订单成本可进入明细查看。</span>
        </div>
      </div>
      <el-table :data="shopRows" stripe border class="erp-data-table shop-table" table-layout="fixed">
        <el-table-column prop="shop_name" label="店铺" min-width="160" fixed="left" />
        <el-table-column prop="revenue" :label="billingMetrics.revenue.label" min-width="118" align="right"><template #header><BillingMetricLabel metric="revenue" /></template>
          <template #default="{ row }">{{ formatMoney(row.revenue) }}</template>
        </el-table-column>
        <el-table-column :label="billingMetrics.grouped_expense_total.label" min-width="118" align="right"><template #header><BillingMetricLabel metric="grouped_expense_total" /></template>
          <template #default="{ row }">{{ formatMoney(row.grouped_expense_total) }}</template>
        </el-table-column>
        <el-table-column prop="net_profit" :label="billingMetrics.net_profit.label" min-width="118" align="right"><template #header><BillingMetricLabel metric="net_profit" /></template>
          <template #default="{ row }"><strong :class="{ 'negative-money': Number(row.net_profit || 0) < 0 }">{{ formatMoney(row.net_profit) }}</strong></template>
        </el-table-column>
        <el-table-column :label="billingMetrics.net_profit_margin.label" width="106" align="right"><template #header><BillingMetricLabel metric="net_profit_margin" /></template>
          <template #default="{ row }">{{ formatRatio(row.revenue ? Number(row.net_profit || 0) / Number(row.revenue) : 0) }}</template>
        </el-table-column>
        <el-table-column prop="operating_expense" :label="billingMetrics.operating_expense.label" min-width="112" align="right"><template #header><BillingMetricLabel metric="operating_expense" /></template>
          <template #default="{ row }">{{ formatMoney(row.operating_expense) }}</template>
        </el-table-column>
        <el-table-column prop="personnel_expense" :label="billingMetrics.personnel_expense.label" min-width="104" align="right"><template #header><BillingMetricLabel metric="personnel_expense" /></template>
          <template #default="{ row }">{{ formatMoney(row.personnel_expense) }}</template>
        </el-table-column>
        <el-table-column prop="funds_expense" :label="billingMetrics.funds_expense.label" min-width="140" align="right"><template #header><BillingMetricLabel metric="funds_expense" /></template><template #default="{ row }">{{ formatMoney(row.funds_expense) }}</template></el-table-column>
        <el-table-column prop="accrued_profit" :label="billingMetrics.accrued_profit.label" min-width="118" align="right"><template #header><BillingMetricLabel metric="accrued_profit" /></template>
          <template #default="{ row }"><span class="settled-money">{{ formatMoney(row.accrued_profit) }}</span></template>
        </el-table-column>
        <el-table-column prop="pending_profit" :label="billingMetrics.pending_profit.label" min-width="118" align="right"><template #header><BillingMetricLabel metric="pending_profit" /></template>
          <template #default="{ row }"><span class="pending-money">{{ formatMoney(row.pending_profit) }}</span></template>
        </el-table-column>
        <el-table-column prop="order_count" :label="billingMetrics.order_count.label" width="92" align="right"><template #header><BillingMetricLabel metric="order_count" /></template>
          <template #default="{ row }">{{ formatInteger(row.order_count) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="108" fixed="right">
          <template #default="{ row }">
            <el-button class="erp-btn-link" link type="primary" :icon="View" @click="openOrderDetails(row)">明细</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <section v-loading="state.loading" class="ai-usage-section">
      <div class="section-head">
        <div>
          <strong>{{ selectedPeriodTitle }} AI 费用与用量</strong>
          <span>按量生图按操作人员统计，不受店铺筛选影响；固定订阅按上方日期、公司和店铺筛选。</span>
        </div>
      </div>
      <div class="ai-usage-summary">
        <article><BillingMetricLabel metric="ai_cost" /><strong>{{ formatAiMoney(aiUsage.cost) }} RMB</strong></article>
        <article><BillingMetricLabel metric="ai_subscription" /><strong>{{ formatMoney(aiSubscription) }} CNY</strong><el-button link type="primary" @click="openExpense(null, 'ai_subscription')">录入 ChatGPT Pro 等订阅</el-button></article>
        <article><BillingMetricLabel metric="request_count" /><strong>{{ formatInteger(aiUsage.request_count) }} 次</strong></article>
        <article><BillingMetricLabel metric="generated_count" /><strong>{{ formatInteger(aiUsage.generated_count) }} 张</strong></article>
        <article><BillingMetricLabel metric="unresolved_count" /><strong>{{ formatInteger(aiUsage.unresolved_count) }} 次</strong></article>
      </div>
      <el-table :data="aiUsagePeople" stripe border class="erp-data-table ai-usage-table" table-layout="fixed" empty-text="本期暂无 AI 生图调用">
        <el-table-column prop="person_name" label="操作人员" min-width="150" fixed="left" />
        <el-table-column prop="request_count" :label="billingMetrics.request_count.label" min-width="110" align="right"><template #header><BillingMetricLabel metric="request_count" /></template></el-table-column>
        <el-table-column prop="generated_count" :label="billingMetrics.generated_count.label" min-width="110" align="right"><template #header><BillingMetricLabel metric="generated_count" /></template></el-table-column>
        <el-table-column prop="unresolved_count" :label="billingMetrics.unresolved_count.label" min-width="130" align="right"><template #header><BillingMetricLabel metric="unresolved_count" /></template></el-table-column>
        <el-table-column prop="task_count" :label="billingMetrics.task_count.label" min-width="100" align="right"><template #header><BillingMetricLabel metric="task_count" /></template></el-table-column>
        <el-table-column :label="billingMetrics.ai_cost.label" min-width="130" align="right"><template #header><BillingMetricLabel metric="ai_cost" /></template>
          <template #default="{ row }"><strong class="ai-money">{{ formatAiMoney(row.cost) }} RMB</strong></template>
        </el-table-column>
      </el-table>
      <el-alert type="info" :closable="false" show-icon class="ai-usage-alert">
        <template #title>按量消耗按生图请求次数 × 0.038 RMB 估算，尚未扣除净利润。固定订阅需每月录入，GPT Pro 默认 1 个账号、5 倍 Token，每月约 700 元，可按实际付款修改；按所选日期、公司及店铺的已录入费用统计，保存后扣除一次；公司共用费用不分摊至店铺。请勿与软件订阅重复录入。</template>
      </el-alert>
    </section>

    <el-drawer v-model="groupDrawer" :title="selectedGroup?.label + '明细'" size="min(100%, 960px)" destroy-on-close>
      <div v-if="selectedGroup" class="group-detail">
        <p>{{ selectedPeriodTitle }} · 合计 ¥{{ formatMoney(selectedGroup.amount) }}</p>
        <el-checkbox v-if="selectedGroup.children.some(item => item.source === 'expenses')" v-model="showEmptyGroupItems">显示未发生的手工费用项目</el-checkbox>
        <el-table :data="visibleGroupItems" stripe border empty-text="本期暂无已录入支出，可勾选查看全部项目">
          <el-table-column label="费用 / 收入子项" min-width="180"><template #default="{ row }"><BillingMetricLabel :label="row.label" :hint="row.hint" /></template></el-table-column>
          <el-table-column prop="hint" label="具体内容" min-width="270" />
          <el-table-column label="金额（CNY）" width="140" align="right"><template #default="{ row }">{{ row.amount == null ? '未获取' : formatMoney(row.amount) }}</template></el-table-column>
          <el-table-column label="明细记录" width="120"><template #default="{ row }"><el-button link type="primary" @click="showGroupItem(row)">{{ row.source === 'unavailable' ? '查原始账单' : '查看记录' }}</el-button></template></el-table-column>
        </el-table>
        <el-alert v-if="groupKey === 'logistics'" type="info" :closable="false" title="跨境及平台配送费在现有订单成本中合并保存；国际、末端等单项请查看原始账单，未拆分金额不显示为0。" />
        <el-alert v-if="groupKey === 'income'" type="info" :closable="false" title="平台奖励、补贴尚未独立识别，不额外计入收入；原始账单中的补偿可能已经包含在销售收入内。" />
        <el-button v-if="['income','platform','logistics','funds'].includes(groupKey)" @click="openSource()">查看 Ozon 原始账单各项金额</el-button>
        <el-button v-if="['operating','personnel','funds'].includes(groupKey)" type="primary" :icon="Plus" @click="openExpense(null, groupKey === 'personnel' ? 'team_building' : groupKey === 'funds' ? 'withdrawal' : 'other')">录入费用</el-button>
      </div>
    </el-drawer>

    <el-drawer v-model="orderRecordDrawer" :title="(recordItem?.label || '') + ' · 订单记录'" size="min(100%, 1060px)" destroy-on-close @closed="recordController?.abort()">
      <div v-loading="orderRecords.loading" class="group-detail">
        <p>按下单日期和当前公司、店铺筛选列示订单，展示每笔订单对应项目的金额，包含零金额记录。</p>
        <el-input v-model="orderRecords.keyword" clearable placeholder="搜索订单号、店铺或状态" @change="orderRecords.page = 1; loadOrderRecords()" />
        <el-alert v-if="orderRecords.error" :title="orderRecords.error" type="error" :closable="false" />
        <el-table :data="orderRecords.rows" stripe border>
          <el-table-column label="下单日期" width="115"><template #default="{ row }">{{ shanghaiDateText(row.ordered_at) }}</template></el-table-column>
          <el-table-column prop="posting_number" label="订单号" min-width="175" />
          <el-table-column prop="shop_name" label="店铺" min-width="130" />
          <el-table-column prop="product_name" label="商品" min-width="200" />
          <el-table-column label="结算状态" width="110"><template #default="{ row }">{{ row.settlement_state === 'finance_accrued' ? '已结算' : '预估 / 待核实' }}</template></el-table-column>
          <el-table-column :label="recordItem?.label + '（CNY）'" min-width="160" align="right"><template #default="{ row }">{{ formatMoney(row[recordItem?.key]) }}</template></el-table-column>
        </el-table>
        <el-pagination v-model:current-page="orderRecords.page" :page-size="30" :total="orderRecords.total" layout="total, prev, pager, next" @current-change="loadOrderRecords" />
      </div>
    </el-drawer>

    <el-drawer v-model="sourceDrawer" :title="sourceKind === 'advertising' ? '广告费用明细' : 'Ozon 原始账单明细'" size="min(100%, 1160px)" destroy-on-close>
      <BillingSourceRecords v-if="sourceDrawer" :filters="sourceFilters" :source="sourceKind" />
      <el-button v-if="sourceKind === 'advertising'" style="margin-top:16px" @click="showGroupItem({ key: 'advertising_cost', label: '订单广告成本', source: 'orders' })">查看订单广告成本（报表无金额时的回退值）</el-button>
    </el-drawer>

    <el-drawer v-model="expenseDrawer" :title="expenseCategoryFilter ? billingExpenseCategoryLabel(expenseCategoryFilter) + '明细' : '经营费用与工资明细'" size="min(100%, 1160px)">
      <div class="drawer-toolbar">
        <span>共 {{ visibleExpenseRows.length }} 笔，按具体类型汇总；工资单独统计。</span>
        <el-button type="primary" :icon="Plus" @click="openExpense()">新增费用</el-button>
      </div>
      <el-button v-if="expenseCategoryFilter" link type="primary" @click="expenseCategoryFilter = ''">查看全部费用</el-button>
      <el-table :data="visibleExpenseRows" stripe border>
        <el-table-column prop="expense_date" label="时间" width="112">
          <template #default="{ row }">{{ shanghaiDateText(row.expense_date) }}</template>
        </el-table-column>
        <el-table-column prop="description" label="项目" min-width="170" />
        <el-table-column prop="company_name" label="公司" min-width="130"><template #default="{ row }">{{ row.company_name || '-' }}</template></el-table-column>
        <el-table-column prop="counterparty" label="收款方 / 人员" min-width="140"><template #default="{ row }">{{ row.counterparty || '-' }}</template></el-table-column>
        <el-table-column label="类型" width="100">
          <template #default="{ row }"><BillingMetricLabel :label="billingExpenseCategoryLabel(row.category)" :hint="billingExpenseCategories.find(item => item.value === row.category)?.hint || '历史费用类型'" /></template>
        </el-table-column>
        <el-table-column prop="shop_name" label="归属" width="120">
          <template #default="{ row }">{{ row.shop_name || "公司共用" }}</template>
        </el-table-column>
        <el-table-column label="费用" width="110" align="right">
          <template #default="{ row }">{{ formatMoney(row.amount_cny) }}</template>
        </el-table-column>
        <el-table-column label="支付/替付" min-width="140">
          <template #default="{ row }">
            {{ row.is_advance_payment ? `替付：${row.advanced_by || "-"}` : (row.paid_by || "-") }}
          </template>
        </el-table-column>
        <el-table-column prop="payment_reference" label="付款参考" min-width="150"><template #default="{ row }">{{ row.payment_reference || '-' }}</template></el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" :icon="Edit" @click="openExpense(row)">编辑</el-button>
            <el-button link type="danger" :icon="Delete" @click="removeExpense(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-drawer>

    <el-dialog v-model="expenseDialog" :title="expenseForm.id ? '编辑经营费用' : '补录经营费用'" width="680px" align-center>
      <el-form label-position="top">
        <div class="expense-form-grid">
          <el-form-item label="项目/费用名称" class="wide-field">
            <el-input v-model="expenseForm.description" placeholder="例如：GPT Pro订阅、水电费、团建、餐补" />
          </el-form-item>
          <el-form-item label="费用类型">
            <el-select v-model="expenseForm.category">
              <el-option v-for="item in billingExpenseCategories" :key="item.value" :label="item.label" :value="item.value"><BillingMetricLabel :label="item.label" :hint="item.hint" /></el-option>
            </el-select>
          </el-form-item>
          <el-form-item label="费用金额（CNY）">
            <el-input-number v-model="expenseForm.amount_cny" :precision="2" :min="0" controls-position="right" />
          </el-form-item>
          <el-form-item label="发生时间">
            <el-date-picker v-model="expenseForm.expense_date" type="date" value-format="YYYY-MM-DD" />
          </el-form-item>
          <el-form-item label="归属店铺">
            <el-select v-model="expenseForm.shop_id" clearable placeholder="公司共用">
              <el-option v-for="shop in state.shops" :key="shop.id" :label="shop.name" :value="String(shop.id)" />
            </el-select>
          </el-form-item>
          <el-form-item label="归属公司">
            <el-select v-model="expenseForm.company_id">
              <el-option v-for="company in state.companies" :key="company.id" :label="company.name" :value="String(company.id)" />
            </el-select>
          </el-form-item>
          <el-form-item label="支付人">
            <el-input v-model="expenseForm.paid_by" placeholder="公司账户或支付人员" />
          </el-form-item>
          <el-form-item class="wide-field">
            <el-checkbox v-model="expenseForm.is_advance_payment">由人员先行替付</el-checkbox>
          </el-form-item>
          <el-form-item v-if="expenseForm.is_advance_payment" label="替付人员">
            <el-input v-model="expenseForm.advanced_by" placeholder="填写替付人员姓名" />
          </el-form-item>
          <el-form-item label="付款流水/回单">
            <el-input v-model="expenseForm.payment_reference" placeholder="可选" />
          </el-form-item>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="expenseDialog = false">取消</el-button>
        <el-button type="primary" :loading="savingExpense" @click="saveExpense">保存并重算</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.monthly-billing-page { gap: 16px; }
.income-group, .group-row { display: grid; grid-template-columns: minmax(130px, 1fr) 60px 130px; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--erp-detail-border, #e2e8f0); }
.income-group { color: var(--erp-detail-success-text, #0f766e); background: var(--erp-detail-success-soft, #f0fdf4); }
.group-row > strong, .income-group > strong { text-align: right; }
.expense-group-heading { padding: 14px 18px 0; font-weight: 600; }
.group-note { padding: 0 18px; color: var(--erp-detail-text-regular, #64748b); font-size: 12px; line-height: 1.6; }
.group-detail { display: grid; gap: 16px; }
.group-detail > p { color: var(--erp-detail-text-regular, #64748b); margin: 0; line-height: 1.6; }
.billing-filter-card :deep(.el-card__body) { padding: 0; }
.section-head { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.section-head span, .formula-heading p, .settlement-card p { margin: 4px 0 0; color: var(--erp-detail-text-regular, #64748b); font-size: 12px; }
.billing-controls { margin-left: auto; }
.head-actions { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.billing-filters { display: flex; flex-wrap: nowrap; align-items: center; margin: 0; }
.billing-filters :deep(.el-form-item) { margin-right: 14px; margin-bottom: 0; }
.billing-filters :deep(.el-form-item__label) { padding-right: 7px; color: var(--erp-detail-text-regular, #64748b); font-size: 12px; }
.billing-filters .billing-filter-actions { margin-right: 0; margin-left: 2px; }
.billing-overview, .ai-usage-section, .capital-section, .shop-section { border: 1px solid var(--erp-detail-border, #e2e8f0); border-radius: 12px; background: var(--erp-detail-surface, #fff); overflow: hidden; }
.ai-usage-summary { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; padding: 16px 18px; }
.ai-usage-summary article { padding: 13px 15px; border: 1px solid var(--erp-detail-border, #e2e8f0); border-radius: 10px; background: var(--erp-detail-surface-alt, #f8fafc); }
.ai-usage-summary span { display: block; color: var(--erp-detail-text-regular, #64748b); font-size: 12px; }
.ai-usage-summary strong { display: block; margin-top: 7px; color: var(--erp-detail-text-main, #0f172a); font-size: 19px; }
.ai-usage-summary article:first-child { border-color: var(--erp-detail-primary-border, #ddd6fe); background: var(--erp-detail-surface-alt, #f5f3ff); }
.ai-usage-summary article:first-child strong, .summary-card.is-ai strong, .ai-money { color: var(--erp-detail-primary, #7c3aed); }
.ai-usage-table { border-top: 1px solid var(--erp-detail-border, #e2e8f0); }
.ai-usage-alert { margin: 14px 18px 16px; }
.capital-workspace { display: grid; grid-template-columns: 1.25fr 1fr; gap: 14px; padding: 16px 18px 10px; }
.capital-panel { min-width: 0; padding: 15px; border: 1px solid var(--erp-detail-border, #e2e8f0); border-radius: 10px; background: var(--erp-detail-surface-alt, #f8fafc); }
.capital-panel__title { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 13px; }
.capital-panel__title strong { color: var(--erp-detail-text-main, #0f172a); font-size: 15px; }
.capital-panel__title span, .capital-metric span, .capital-metric small { color: var(--erp-detail-text-regular, #64748b); font-size: 12px; }
.capital-metric-grid { display: grid; gap: 10px; }
.procurement-metric-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.inventory-metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.capital-metric { min-width: 0; padding: 12px; border: 1px solid var(--erp-detail-border, #e2e8f0); border-radius: 9px; background: var(--erp-detail-surface, #fff); }
.capital-metric span, .capital-metric small { display: block; }
.capital-metric strong { display: block; margin: 7px 0 5px; color: var(--erp-detail-text-main, #0f172a); font-size: 18px; }
.capital-metric.is-total { border-color: var(--erp-detail-primary-border, #bfdbfe); background: var(--erp-detail-primary-soft, #eff6ff); }
.capital-metric.is-total strong { color: var(--erp-detail-primary, #1d4ed8); }
.capital-alert { margin: 0 18px 16px; }
.section-head { padding: 15px 18px; border-bottom: 1px solid var(--erp-detail-border, #e2e8f0); }
.section-head strong { display: block; color: var(--erp-detail-text-main, #0f172a); font-size: 15px; }
.summary-grid { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: 10px; padding: 16px 18px; }
.summary-card { min-height: 88px; padding: 13px 15px; border: 1px solid var(--erp-detail-border, #e2e8f0); border-radius: 10px; background: var(--erp-detail-surface-alt, #f8fafc); }
.summary-card span, .summary-card small { display: block; color: var(--erp-detail-text-regular, #64748b); font-size: 12px; }
.summary-card strong { display: block; margin: 8px 0 3px; color: var(--erp-detail-text-main, #0f172a); font-size: 20px; }
.summary-card.is-income strong { color: var(--erp-detail-success-text, #0f766e); }
.summary-card.is-profit strong { color: var(--erp-detail-success-text, #15803d); }
.summary-card.is-loss strong, .negative-money { color: var(--erp-detail-danger-text, #dc2626) !important; }
.summary-card.is-pending strong, .pending-money { color: var(--erp-detail-warning-text, #d97706); }
.profit-workspace { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 16px; padding: 0 18px 18px; }
.formula-card, .settlement-card { border: 1px solid var(--erp-detail-border, #e2e8f0); border-radius: 12px; background: var(--erp-detail-surface, #fff); }
.formula-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 16px 18px; border-bottom: 1px solid var(--erp-detail-border, #e2e8f0); background: linear-gradient(135deg, var(--erp-detail-surface-alt, #f8fafc), var(--erp-detail-primary-soft, #eff6ff)); }
.formula-heading > div:first-child { min-width: 0; }
.formula-heading p { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.net-result { min-width: 180px; text-align: right; }
.net-result span, .net-result small { display: block; color: var(--erp-detail-text-regular, #64748b); font-size: 12px; }
.net-result strong { display: block; margin: 3px 0; color: var(--erp-detail-success-text, #15803d); font-size: 24px; }
.net-result.negative strong { color: var(--erp-detail-danger-text, #dc2626); }
.formula-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.formula-total { display: grid; grid-template-columns: 24px 1fr 100px 150px; gap: 8px; align-items: center; padding: 15px 18px; background: var(--erp-detail-surface-alt, #f0fdf4); color: var(--erp-detail-success-text, #166534); }
.formula-total small, .formula-total b { text-align: right; }
.formula-total b { font-size: 20px; }
.settlement-card { padding: 18px; }
.settlement-value { margin: 14px 0 0; padding: 15px; border-radius: 10px; }
.settlement-value.is-settled { background: var(--erp-detail-surface-alt, #ecfdf5); }
.settlement-value.is-pending { background: var(--erp-detail-warning-bg, #fff7ed); }
.settlement-value span { display: block; font-size: 12px; }
.settlement-value b { display: block; margin-top: 5px; font-size: 23px; }
.settlement-value.is-settled span, .settled-money { color: var(--erp-detail-success-text, #047857); }
.settlement-value.is-settled b { color: var(--erp-detail-success-text, #059669); }
.settlement-value.is-pending span { color: var(--erp-detail-danger-text, #9a3412); }
.settlement-value.is-pending b { color: var(--erp-detail-danger-text, #c2410c); }
.settlement-meta { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--erp-detail-border, #f1f5f9); color: var(--erp-detail-text-regular, #475569); font-size: 13px; }
.settlement-card :deep(.el-alert) { margin-top: 16px; }
.shop-table { border-top: 0; }
.drawer-toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; color: var(--erp-detail-text-regular, #64748b); font-size: 13px; }
.expense-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; }
.expense-form-grid .wide-field { grid-column: 1 / -1; }
.expense-form-grid :deep(.el-input-number), .expense-form-grid :deep(.el-date-editor), .expense-form-grid :deep(.el-select) { width: 100%; }
:global(:root[data-theme="dark"] .billing-overview), :global(:root[data-theme="dark"] .ai-usage-section), :global(:root[data-theme="dark"] .capital-section), :global(:root[data-theme="dark"] .shop-section), :global(:root[data-theme="dark"] .formula-card), :global(:root[data-theme="dark"] .settlement-card), :global(:root[data-theme="dark"] .summary-card), :global(:root[data-theme="dark"] .ai-usage-summary article), :global(:root[data-theme="dark"] .capital-panel), :global(:root[data-theme="dark"] .capital-metric) { border-color: var(--erp-detail-border, rgba(148, 163, 184, .24)); background: rgba(15, 23, 42, .72); }
:global(:root[data-theme="dark"] .formula-heading) { background: rgba(30, 41, 59, .84); }
:global(:root[data-theme="dark"] .section-head strong), :global(:root[data-theme="dark"] .billing-toolbar-row h2), :global(:root[data-theme="dark"] .summary-card strong), :global(:root[data-theme="dark"] .capital-panel__title strong), :global(:root[data-theme="dark"] .capital-metric strong) { color: var(--erp-detail-text-secondary, #e2e8f0); }
@media (max-width: 1280px), (max-width: 1366px) and (any-pointer: coarse) {
  .summary-grid, .ai-usage-summary { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .capital-workspace { grid-template-columns: 1fr; }
  .profit-workspace { grid-template-columns: 1fr; }
  .billing-filters { flex-wrap: wrap; }
}
@media (max-width: 780px) {
  .section-head, .formula-heading { align-items: stretch; flex-direction: column; }
  .billing-filters { align-items: stretch; flex-direction: column; }
  .billing-filters :deep(.el-form-item) { margin: 0 0 10px; }
  .summary-grid, .ai-usage-summary, .formula-list, .expense-form-grid, .procurement-metric-grid, .inventory-metric-grid { grid-template-columns: 1fr; }
  .profit-workspace { padding: 0 12px 12px; }
}
</style>
