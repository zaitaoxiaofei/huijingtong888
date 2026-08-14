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
import { formatInteger, formatMoney } from "./profit-utils.js";

const route = useRoute();
const router = useRouter();
let abortController = null;

function initialDateRange() {
  const today = shanghaiDateKey();
  const legacyMonth = `${route.query.year || today.slice(0, 4)}-${String(route.query.month || route.query.selectedMonth || today.slice(5, 7)).padStart(2, "0")}`;
  const lastDay = new Date(Number(legacyMonth.slice(0, 4)), Number(legacyMonth.slice(5, 7)), 0).getDate();
  const legacyTo = legacyMonth === today.slice(0, 7) ? today : `${legacyMonth}-${String(lastDay).padStart(2, "0")}`;
  return [String(route.query.from || `${legacyMonth}-01`), String(route.query.to || legacyTo)];
}

const state = reactive({
  loading: false,
  dateRange: initialDateRange(),
  shopId: String(route.query.shopId || "all"),
  shops: [],
  companies: [],
  assignments: [],
  month: { summary: {}, shops: [], expenses: [] }
});

const expenseDialog = ref(false);
const expenseDrawer = ref(false);
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
const shopRows = computed(() => state.month?.shops || []);
const expenseRows = computed(() => state.month?.expenses || []);

function formatRatio(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : "0.0%";
}

function formatShare(value) {
  const revenue = Number(selectedSummary.value.revenue || 0);
  return revenue ? formatRatio(Number(value || 0) / revenue) : "-";
}

const summaryCards = computed(() => [
  { label: "总收益", value: selectedSummary.value.revenue, suffix: "CNY", tone: "income" },
  { label: "净利润", value: selectedSummary.value.net_profit, suffix: "CNY", tone: Number(selectedSummary.value.net_profit || 0) >= 0 ? "profit" : "loss" },
  { label: "净利润率", display: formatRatio(selectedSummary.value.net_profit_margin), tone: "ratio" },
  { label: "订单利润", value: selectedSummary.value.profit, suffix: "未扣广告与人工", tone: "normal" },
  { label: "已结算利润", value: selectedSummary.value.accrued_profit, suffix: `${formatInteger(selectedSummary.value.accrued_order_count)} 单`, tone: "settled" },
  { label: "待结算利润", value: selectedSummary.value.pending_profit, suffix: `${formatInteger(selectedSummary.value.pending_order_count)} 单`, tone: "pending" },
  { label: "订单数", display: formatInteger(selectedSummary.value.order_count), suffix: "单", tone: "normal" }
]);

const formulaRows = computed(() => {
  const row = selectedSummary.value;
  return [
    { label: "总收益", value: row.revenue, sign: "+", tone: "income" },
    { label: "采购成本", value: row.purchase_cost, sign: "−" },
    { label: "国内物流", value: row.domestic_shipping_cost, sign: "−" },
    { label: "国际物流", value: row.international_shipping_cost, sign: "−" },
    { label: "包装处理", value: row.packaging_cost, sign: "−" },
    { label: "Ozon佣金", value: row.commission_fee, sign: "−" },
    { label: "Ozon服务费", value: row.ozon_service_fee, sign: "−" },
    { label: "其他费用", value: row.other_fee, sign: "−" },
    { label: "广告费用", value: row.advertising_cost, sign: "−", tone: "ad" },
    { label: "退货损失", value: row.return_loss, sign: "−", tone: "risk" },
    { label: "人工账单", value: row.manual_expense, sign: "−", tone: "manual", action: true },
    { label: "工资", value: row.salary_expense, sign: "−", tone: "salary", action: true }
  ];
});

const formulaText = computed(() => formulaRows.value.map((item) => item.label).join(" − ").replace("总收益 −", "总收益 −"));

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
      shopId: String(state.shopId || "all")
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
      shopId: shop?.shop_id ? String(shop.shop_id) : String(state.shopId || "all")
    }
  };
}

function openOrderDetails(shop = null) {
  router.push(detailRoute(shop));
}

function defaultCompanyId(shopId = "") {
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
    description: "",
    amount_cny: 0,
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
    ElMessage.success("人工账单已保存，净利润已更新");
    await loadData();
  } catch (error) {
    ElMessage.error(error.message || "人工账单保存失败");
  } finally {
    savingExpense.value = false;
  }
}

async function removeExpense(row) {
  try {
    await ElMessageBox.confirm(`确认删除“${row.description || row.category}”这笔费用？`, "删除人工账单", { type: "warning" });
    await apiClient.delete(`/api/finance-center/expenses/${row.id}`);
    ElMessage.success("人工账单已删除");
    await loadData();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "人工账单删除失败");
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
      shopId: String(state.shopId || "all")
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
  () => [route.query.from, route.query.to, route.query.shopId],
  ([from, to, shopId], previous) => {
    if (!previous) return;
    const nextRange = [String(from || state.dateRange[0]), String(to || state.dateRange[1])];
    const nextShopId = String(shopId || state.shopId || "all");
    if (nextRange[0] === state.dateRange[0] && nextRange[1] === state.dateRange[1] && nextShopId === state.shopId) return;
    state.dateRange = nextRange;
    state.shopId = nextShopId;
    loadData();
  }
);
onBeforeUnmount(() => abortController?.abort());
</script>

<template>
  <div class="page-stack monthly-billing-page">
    <el-card shadow="never" class="page-card billing-filter-card">
      <ErpPageHeader title="月度经营账单" description="汇总收入、经营成本、结算状态与净利润。">
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
          <span>净利润已扣除广告、人工账单和工资；待结算为订单结算状态，不重复扣减。</span>
        </div>
        <div class="head-actions">
          <el-button class="erp-btn erp-btn-secondary" :icon="Plus" @click="openExpense(null, 'other')">补录费用</el-button>
          <el-button class="erp-btn erp-btn-primary" type="primary" :icon="View" @click="openOrderDetails()">订单明细</el-button>
        </div>
      </div>

      <div class="summary-grid">
        <div v-for="item in summaryCards" :key="item.label" class="summary-card" :class="`is-${item.tone}`">
          <span>{{ item.label }}</span>
          <strong>{{ item.display ?? formatMoney(item.value) }}</strong>
          <small>{{ item.suffix }}</small>
        </div>
      </div>

      <div class="profit-workspace">
        <div class="formula-card">
          <div class="formula-heading">
            <div>
              <strong>净利润计算公式</strong>
              <p>{{ formulaText }}</p>
            </div>
            <div class="net-result" :class="{ negative: Number(selectedSummary.net_profit || 0) < 0 }">
              <span>本月净利润</span>
              <strong>¥{{ formatMoney(selectedSummary.net_profit) }}</strong>
              <small>净利润率 {{ formatRatio(selectedSummary.net_profit_margin) }}</small>
            </div>
          </div>
          <div class="formula-list">
            <div v-for="item in formulaRows" :key="item.label" class="formula-row" :class="`is-${item.tone || 'cost'}`">
              <span class="formula-sign">{{ item.sign }}</span>
              <span class="formula-label">{{ item.label }}</span>
              <button v-if="item.action" type="button" class="detail-link" @click="expenseDrawer = true">明细</button>
              <span v-else class="formula-spacer" />
              <small>占总收益 {{ formatShare(item.value) }}</small>
              <strong>¥{{ formatMoney(item.value) }}</strong>
            </div>
          </div>
          <div class="formula-total">
            <span>=</span>
            <strong>净利润</strong>
            <small>{{ formatRatio(selectedSummary.net_profit_margin) }}</small>
            <b>¥{{ formatMoney(selectedSummary.net_profit) }}</b>
          </div>
        </div>

        <aside class="settlement-card">
          <strong>结算状态</strong>
          <p>按 Ozon 财务入账状态区分；待结算单独展示，不作为成本再次扣除。</p>
          <div class="settlement-value is-settled">
            <span>已结算订单利润</span>
            <b>¥{{ formatMoney(selectedSummary.accrued_profit) }}</b>
          </div>
          <div class="settlement-meta">
            <span>已结算订单</span>
            <strong>{{ formatInteger(selectedSummary.accrued_order_count) }} 单</strong>
          </div>
          <div class="settlement-value is-pending">
            <span>待结算利润预估</span>
            <b>¥{{ formatMoney(selectedSummary.pending_profit) }}</b>
          </div>
          <div class="settlement-meta">
            <span>待结算订单</span>
            <strong>{{ formatInteger(selectedSummary.pending_order_count) }} 单</strong>
          </div>
          <div class="settlement-meta">
            <span>已结算利润占比</span>
            <strong>{{ formatRatio(selectedSummary.settlement_rate) }}</strong>
          </div>
          <el-alert type="info" :closable="false" show-icon>
            <template #title>公司共用人工费用只计入总体净利润，不自动分摊到店铺。</template>
          </el-alert>
        </aside>
      </div>
    </section>

    <section v-loading="state.loading" class="shop-section">
      <div class="section-head">
        <div>
          <strong>{{ selectedPeriodTitle }} 各店铺账单</strong>
          <span>主表突出经营结果；详细订单成本可进入明细查看。</span>
        </div>
      </div>
      <el-table :data="shopRows" stripe border class="erp-data-table shop-table" table-layout="fixed">
        <el-table-column prop="shop_name" label="店铺" min-width="160" fixed="left" />
        <el-table-column prop="revenue" label="总收益" min-width="118" align="right">
          <template #default="{ row }">{{ formatMoney(row.revenue) }}</template>
        </el-table-column>
        <el-table-column label="总成本" min-width="118" align="right">
          <template #default="{ row }">{{ formatMoney(Number(row.total_cost || 0) + Number(row.manual_expense || 0) + Number(row.salary_expense || 0)) }}</template>
        </el-table-column>
        <el-table-column prop="net_profit" label="净利润" min-width="118" align="right">
          <template #default="{ row }"><strong :class="{ 'negative-money': Number(row.net_profit || 0) < 0 }">{{ formatMoney(row.net_profit) }}</strong></template>
        </el-table-column>
        <el-table-column label="净利润率" width="106" align="right">
          <template #default="{ row }">{{ formatRatio(row.revenue ? Number(row.net_profit || 0) / Number(row.revenue) : 0) }}</template>
        </el-table-column>
        <el-table-column prop="manual_expense" label="人工账单" min-width="112" align="right">
          <template #default="{ row }">{{ formatMoney(row.manual_expense) }}</template>
        </el-table-column>
        <el-table-column prop="salary_expense" label="工资" min-width="104" align="right">
          <template #default="{ row }">{{ formatMoney(row.salary_expense) }}</template>
        </el-table-column>
        <el-table-column prop="accrued_profit" label="已结算利润" min-width="118" align="right">
          <template #default="{ row }"><span class="settled-money">{{ formatMoney(row.accrued_profit) }}</span></template>
        </el-table-column>
        <el-table-column prop="pending_profit" label="待结算利润" min-width="118" align="right">
          <template #default="{ row }"><span class="pending-money">{{ formatMoney(row.pending_profit) }}</span></template>
        </el-table-column>
        <el-table-column prop="order_count" label="订单数" width="92" align="right">
          <template #default="{ row }">{{ formatInteger(row.order_count) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="108" fixed="right">
          <template #default="{ row }">
            <el-button class="erp-btn-link" link type="primary" :icon="View" @click="openOrderDetails(row)">明细</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <el-drawer v-model="expenseDrawer" title="人工账单与工资明细" size="860px">
      <div class="drawer-toolbar">
        <span>共 {{ expenseRows.length }} 笔，工资与其他人工费用分别汇总。</span>
        <el-button type="primary" :icon="Plus" @click="openExpense()">新增费用</el-button>
      </div>
      <el-table :data="expenseRows" stripe border>
        <el-table-column prop="expense_date" label="时间" width="112">
          <template #default="{ row }">{{ shanghaiDateText(row.expense_date) }}</template>
        </el-table-column>
        <el-table-column prop="description" label="项目" min-width="170" />
        <el-table-column label="类型" width="100">
          <template #default="{ row }">{{ row.category === "salary" ? "工资" : "人工费用" }}</template>
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
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" :icon="Edit" @click="openExpense(row)">编辑</el-button>
            <el-button link type="danger" :icon="Delete" @click="removeExpense(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-drawer>

    <el-dialog v-model="expenseDialog" :title="expenseForm.id ? '编辑人工账单' : '补录人工账单'" width="680px" align-center>
      <el-form label-position="top">
        <div class="expense-form-grid">
          <el-form-item label="项目/费用名称" class="wide-field">
            <el-input v-model="expenseForm.description" placeholder="例如：临时包装工、办公用品、6月工资" />
          </el-form-item>
          <el-form-item label="费用类型">
            <el-select v-model="expenseForm.category">
              <el-option label="其他人工费用" value="other" />
              <el-option label="办公" value="office" />
              <el-option label="房租" value="rent" />
              <el-option label="软件" value="software" />
              <el-option label="差旅" value="travel" />
              <el-option label="银行手续费" value="bank" />
              <el-option label="临时用工" value="temporary_labor" />
              <el-option label="工资" value="salary" />
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
.billing-filter-card :deep(.el-card__body) { padding: 0; }
.section-head { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.section-head span, .formula-heading p, .settlement-card p { margin: 4px 0 0; color: #64748b; font-size: 12px; }
.billing-controls { margin-left: auto; }
.head-actions { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.billing-filters { display: flex; flex-wrap: nowrap; align-items: center; margin: 0; }
.billing-filters :deep(.el-form-item) { margin-right: 14px; margin-bottom: 0; }
.billing-filters :deep(.el-form-item__label) { padding-right: 7px; color: #64748b; font-size: 12px; }
.billing-filters .billing-filter-actions { margin-right: 0; margin-left: 2px; }
.billing-overview, .shop-section { border: 1px solid #e2e8f0; border-radius: 12px; background: #fff; overflow: hidden; }
.section-head { padding: 15px 18px; border-bottom: 1px solid #e2e8f0; }
.section-head strong { display: block; color: #0f172a; font-size: 15px; }
.summary-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 12px; padding: 16px 18px; }
.summary-card { min-height: 88px; padding: 13px 15px; border: 1px solid #e2e8f0; border-radius: 10px; background: #f8fafc; }
.summary-card span, .summary-card small { display: block; color: #64748b; font-size: 12px; }
.summary-card strong { display: block; margin: 8px 0 3px; color: #0f172a; font-size: 20px; }
.summary-card.is-income strong { color: #0f766e; }
.summary-card.is-profit strong { color: #15803d; }
.summary-card.is-loss strong, .negative-money { color: #dc2626 !important; }
.summary-card.is-pending strong, .pending-money { color: #d97706; }
.profit-workspace { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 16px; padding: 0 18px 18px; }
.formula-card, .settlement-card { border: 1px solid #e2e8f0; border-radius: 12px; background: #fff; }
.formula-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 16px 18px; border-bottom: 1px solid #e2e8f0; background: linear-gradient(135deg, #f8fafc, #eff6ff); }
.formula-heading > div:first-child { min-width: 0; }
.formula-heading p { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.net-result { min-width: 180px; text-align: right; }
.net-result span, .net-result small { display: block; color: #64748b; font-size: 12px; }
.net-result strong { display: block; margin: 3px 0; color: #15803d; font-size: 24px; }
.net-result.negative strong { color: #dc2626; }
.formula-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.formula-row { display: grid; grid-template-columns: 24px minmax(90px, 1fr) 42px 100px 112px; align-items: center; gap: 6px; padding: 11px 14px; border-bottom: 1px solid #f1f5f9; }
.formula-row:nth-child(odd) { border-right: 1px solid #f1f5f9; }
.formula-sign { color: #94a3b8; font-weight: 800; }
.formula-label { color: #334155; font-weight: 600; }
.formula-row small { color: #94a3b8; text-align: right; }
.formula-row > strong { color: #334155; text-align: right; }
.formula-row.is-income .formula-sign, .formula-row.is-income > strong { color: #0f766e; }
.formula-row.is-ad > strong { color: #7c3aed; }
.formula-row.is-risk > strong, .formula-row.is-manual > strong, .formula-row.is-salary > strong { color: #b45309; }
.detail-link { padding: 0; border: 0; background: none; color: #2563eb; cursor: pointer; font-size: 12px; }
.formula-spacer { display: block; }
.formula-total { display: grid; grid-template-columns: 24px 1fr 100px 150px; gap: 8px; align-items: center; padding: 15px 18px; background: #f0fdf4; color: #166534; }
.formula-total small, .formula-total b { text-align: right; }
.formula-total b { font-size: 20px; }
.settlement-card { padding: 18px; }
.settlement-value { margin: 14px 0 0; padding: 15px; border-radius: 10px; }
.settlement-value.is-settled { background: #ecfdf5; }
.settlement-value.is-pending { background: #fff7ed; }
.settlement-value span { display: block; font-size: 12px; }
.settlement-value b { display: block; margin-top: 5px; font-size: 23px; }
.settlement-value.is-settled span, .settled-money { color: #047857; }
.settlement-value.is-settled b { color: #059669; }
.settlement-value.is-pending span { color: #9a3412; }
.settlement-value.is-pending b { color: #c2410c; }
.settlement-meta { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #f1f5f9; color: #475569; font-size: 13px; }
.settlement-card :deep(.el-alert) { margin-top: 16px; }
.shop-table { border-top: 0; }
.drawer-toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; color: #64748b; font-size: 13px; }
.expense-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; }
.expense-form-grid .wide-field { grid-column: 1 / -1; }
.expense-form-grid :deep(.el-input-number), .expense-form-grid :deep(.el-date-editor), .expense-form-grid :deep(.el-select) { width: 100%; }
:global(:root[data-theme="dark"] .billing-overview), :global(:root[data-theme="dark"] .shop-section), :global(:root[data-theme="dark"] .formula-card), :global(:root[data-theme="dark"] .settlement-card), :global(:root[data-theme="dark"] .summary-card) { border-color: rgba(148, 163, 184, .24); background: rgba(15, 23, 42, .72); }
:global(:root[data-theme="dark"] .formula-heading) { background: rgba(30, 41, 59, .84); }
:global(:root[data-theme="dark"] .formula-label), :global(:root[data-theme="dark"] .formula-row > strong), :global(:root[data-theme="dark"] .section-head strong), :global(:root[data-theme="dark"] .billing-toolbar-row h2), :global(:root[data-theme="dark"] .summary-card strong) { color: #e2e8f0; }
@media (max-width: 1280px) {
  .summary-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .profit-workspace { grid-template-columns: 1fr; }
  .billing-filters { flex-wrap: wrap; }
}
@media (max-width: 780px) {
  .section-head, .formula-heading { align-items: stretch; flex-direction: column; }
  .billing-filters { align-items: stretch; flex-direction: column; }
  .billing-filters :deep(.el-form-item) { margin: 0 0 10px; }
  .summary-grid, .formula-list, .expense-form-grid { grid-template-columns: 1fr; }
  .formula-row:nth-child(odd) { border-right: 0; }
  .profit-workspace { padding: 0 12px 12px; }
}
</style>
