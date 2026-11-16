<script setup>
import { billingProfitTotals } from "../../../../src/shared/billing-profit.js";
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { Delete, Edit, Plus, View } from "@element-plus/icons-vue";
import { apiClient, currentApiCacheScope } from "../../utils/api";
import { shanghaiDateKey, shanghaiDateText } from "../../utils/shanghai-date.js";
import { billingDateRange, billingCalendarRange, billingCalendarSelection } from "../../utils/billing-period.js";
import BillingSourceRecords from "./BillingSourceRecords.vue";
import { buildBillingGroups } from "./billing-groups.js";
import BillingMetricLabel from "./BillingMetricLabel.vue";
import { billingMetrics } from "./billing-metrics.js";
import { billingExpenseCategories, billingExpenseCategoryLabel, summarizeBillingExpenses } from "./billing-expense-categories.js";
import { formatInteger, formatMoney } from "./profit-utils.js";

const FinanceImportPanel=defineAsyncComponent(()=>import("../../components/finance/FinanceImportPanel.vue"));
const reviewSubmissionId=ref(null);
const pendingPayrollBatches=computed(()=>[...new Set(visiblePayroll.value.filter(r=>r.approval_status==='pending').map(r=>r.submission_id).filter(Boolean))]);
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

const initialCalendar=billingCalendarSelection(state.dateRange),quickYear=ref(initialCalendar.year),quickMonth=ref(initialCalendar.month);
function selectCalendarYear(value){quickMonth.value='';if(value){state.dateRange=billingCalendarRange(value);applyBillingFilters();}}
function selectCalendarMonth(value){if(quickYear.value){state.dateRange=billingCalendarRange(quickYear.value,value||'');applyBillingFilters();}}
function selectCustomRange(){quickYear.value='';quickMonth.value='';}
function syncCalendar(){const value=billingCalendarSelection(state.dateRange);quickYear.value=value.year;quickMonth.value=value.month;}
const formatAmountInput=value=>value==null||value===''?'':String(value).replace(/\B(?=(\d{3})+(?!\d))/g,',');
const parseAmountInput=value=>String(value??'').replace(/,/g,'');
const entryProgress=computed(()=>Number(selectedSummary.value.order_count)>0?Number(selectedSummary.value.accrued_order_count||0)/Number(selectedSummary.value.order_count):0);
const expenseDialog = ref(false);
const expenseDrawer = ref(false);
const evidenceOpen=ref(false),evidenceRows=ref([]),evidenceLoading=ref(false),evidenceError=ref(''),evidencePage=ref(1),evidencePageSize=ref(20);
let evidenceController;
async function showEvidence(row){evidenceController?.abort();evidenceController=new AbortController();const signal=evidenceController.signal,scope=currentApiCacheScope();evidenceRows.value=row.fee_evidence||[];evidenceError.value='';evidencePage.value=1;evidenceLoading.value=false;evidenceOpen.value=true;if(evidenceRows.value.length)return;evidenceLoading.value=true;
 try{const result=await apiClient.post('/api/finance-center/ozon-posting-accruals',{shop_id:row.shop_id,order_ids:[row.order_id]},{signal});if(signal.aborted||scope!==currentApiCacheScope())return;evidenceRows.value=(result.rows||[]).flatMap(p=>(p.accruals||[]).map(r=>({operation_date:r.accrual_date,service_name:r.type_name||r.type_id,operation_id:'官方接口未提供流水ID',posting_number:p.posting_number,currency_code:r.accrued.currency,amount:Number(r.accrued.amount),amount_cny:null,source_endpoint:result.source_endpoint})));if(!evidenceRows.value.length)evidenceError.value='官方子单接口未返回费用；不代表整单费用为0，仍需核对母单和按日账单。';}catch(error){if(!signal.aborted&&scope===currentApiCacheScope())evidenceError.value=error.message||'官方账单暂未读取';}finally{if(evidenceController?.signal===signal)evidenceLoading.value=false;}
}
function drillOrders(row){Object.assign(orderRecords,{groupBy:"order",page:1,productId:row.product_id||"",sku:row.product_id?"":row.ozon_sku,skuShopId:row.shop_id});loadOrderRecords();}
function clearDrill(){Object.assign(orderRecords,{productId:"",sku:"",skuShopId:"",page:1});loadOrderRecords();}
const withdrawalOpen=ref(false);
const expenseCategoryFilter = ref("");
const expensePage=ref(1),expensePageSize=ref(20);
const capitalDrawer = ref(false);
const shopsOpen = ref(false), aiOpen = ref(false), settlementOpen = ref(false), payrollOpen = ref(false);
const payrollRows = ref([]), payrollLoading = ref(false), payrollError = ref(''), payrollMonth = ref('period');
const payrollMonths = computed(()=>[...new Set(payrollRows.value.map(row=>row.month))].sort().reverse());
const payrollDetails = computed(()=>payrollMonth.value==='period'?visiblePayroll.value:payrollRows.value.filter(row=>(payrollMonth.value==='all'||row.month===payrollMonth.value)&&(state.companyId==='all'||String(row.company_id)===state.companyId)));
watch(payrollOpen,open=>{if(open)payrollMonth.value=visiblePayroll.value.length?'period':'all';});
const payrollCost = row => Math.round((Number(row.base||0)+Number(row.employer||0))*100)/100;
const visiblePayroll = computed(() => payrollRows.value.filter(row => row.month>=state.dateRange[0].slice(0,7) && row.month<=state.dateRange[1].slice(0,7) && (state.companyId==='all'||String(row.company_id)===state.companyId)));
const pendingPayroll = computed(() => visiblePayroll.value.filter(row=>row.approval_status==='pending'&&!row.cost_confirmed&&Number(row.paid_amount||0)<=0).reduce((n,row)=>n+Math.round(payrollCost(row)*100),0)/100);
async function loadPayroll(signal) {
  payrollLoading.value=true;payrollError.value='';payrollRows.value=[];
  try {
    const from=Number(state.dateRange[0].slice(0,4)),to=Number(state.dateRange[1].slice(0,4));
    if(to-from>1)throw new Error('工资明细请按一年或相邻两年查看');
    const results=await Promise.all(Array.from({length:to-from+1},(_,i)=>apiClient.get('/api/finance-submissions/payroll-ledger?'+new URLSearchParams({year:String(from+i),company_id:state.companyId}),{signal,noCache:true})));
    if(!signal.aborted)payrollRows.value=results.flatMap(data=>data.rows||[]);
  }catch(error){if(!signal.aborted)payrollError.value=error.message||'工资记录暂未读取，请重试';}
  finally{if(!signal.aborted)payrollLoading.value=false;}
}

const groupNames = { goods:'商品成本', logistics:'物流费用', platform:'平台费用', operating:'日常经营', personnel:'人员费用', funds:'支付费用' };
const itemNames = {purchase_cost:'采购成本',international_shipping_cost:'跨境配送',commission_fee:'佣金',ozon_service_fee:'服务费',advertising_cost:'广告',packaging_cost:'包装',ai_subscription:'AI 订阅',other_fee:'Ozon收单费'};
const inlineItems = group => group.children.filter(item => item.source !== 'expenses' || item.amount !== 0 || item.key === 'fbp_stocking_shipping');
function toolbarCommand(command) {
  if(command==='overview') router.push('/finance-center');
  if(command==='ai') aiOpen.value=true;
  if(command==='capital') capitalDrawer.value=true;
  if(command==='payroll') router.push({path:'/finance/payroll',query:{month:state.dateRange[0].slice(0,7),companyId:state.companyId,action:'import'}});
}




const sourceDrawer = ref(false);
const sourceKind = ref("platform");
const orderRecordDrawer = ref(false);
const recordItem = ref(null);
const orderRecords = reactive({ loading: false, error: "", rows: [], total: 0, page: 1, keyword: "", outcomeType:"",groupBy:"order",pageSize:20,sortBy:"amount",sortOrder:"desc",summary:{},productId:"",sku:"",skuShopId:"",recordSource:"orders" });
let recordController;
const recordCache=new Map();
const fastCostFields=new Set(['purchase_cost','domestic_shipping_cost','international_shipping_cost','packaging_cost','commission_fee','ozon_service_fee','other_fee']);
const isCostRecord=computed(()=>fastCostFields.has(recordItem.value?.key));
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
const selectedSummary = computed(() => ({...(state.month?.summary||{}),...billingProfitTotals(state.month?.summary||{},expenseRows.value)}));
const procurementInventory = computed(() => state.month?.procurement_inventory || {});
const aiUsage = computed(() => state.month?.ai_usage || {});
const aiUsagePeople = computed(() => Array.isArray(aiUsage.value.people) ? aiUsage.value.people : []);
const billingGroups = computed(() => buildBillingGroups(selectedSummary.value, expenseRows.value));
const incomeGroup = computed(() => billingGroups.value[0]);
const expenseGroups = computed(() => billingGroups.value.slice(1));
const classifiedExpenseTotal = computed(() => expenseGroups.value.reduce((sum, group) => sum + group.amount, 0));
const unclassifiedDifference = computed(() => selectedSummary.value.net_profit==null?null:Math.round((Number(selectedSummary.value.revenue || 0) - Number(selectedSummary.value.net_profit || 0) - classifiedExpenseTotal.value) * 100) / 100);
function openSource(source = "platform") { sourceKind.value = source; sourceDrawer.value = true; }
async function loadOrderRecords() {
  recordController?.abort();recordController=new AbortController();const signal=recordController.signal,scope=currentApiCacheScope();
  const params=new URLSearchParams({...sourceFilters.value,page:orderRecords.page,pageSize:orderRecords.pageSize,recordSource:orderRecords.recordSource,groupBy:orderRecords.groupBy,metric:recordItem.value?.key||'',sortBy:orderRecords.sortBy,sortOrder:orderRecords.sortOrder,productId:orderRecords.productId,sku:orderRecords.sku,skuShopId:orderRecords.skuShopId,keyword:orderRecords.keyword,outcomeType:orderRecords.outcomeType,field:fastCostFields.has(recordItem.value?.key)?recordItem.value.key:''});
  const key=scope+':'+params,cached=recordCache.get(key);
  orderRecords.error='';orderRecords.rows=[];
  if(cached&&Date.now()-cached.at<15000){Object.assign(orderRecords,{...cached.data,loading:false});return;}
  orderRecords.loading=true;
  try{
    const result=await apiClient.get('/api/monthly-billing-orders?'+params,{signal,noCache:true});
    if(!signal.aborted&&scope===currentApiCacheScope()){
      const data={rows:(result.rows||[]).map(row=>({...row,recognized_loss:row.recognized_loss??Math.max(0,-Number(row.profit||0))})),total:Number(result.total||0),summary:result.summary||{}};
      Object.assign(orderRecords,data);recordCache.set(key,{at:Date.now(),data});if(recordCache.size>8)recordCache.delete(recordCache.keys().next().value);
    }
  }catch(error){if(!signal.aborted&&scope===currentApiCacheScope())orderRecords.error=error.message||'订单明细读取失败';}
  finally{if(recordController?.signal===signal)orderRecords.loading=false;}
}

function showGroupItem(item) {
  if(item.source==='ai_usage'){aiOpen.value=true;return;}
  if (item.source === 'withdrawal') {withdrawalOpen.value=true;return;}
  if (item.source === 'aftersale') return showLossRecords('returns');
  if (item.source === "expenses") return showExpenses(item.key);
  if (item.source === "advertising") return openSource("advertising");
  if (item.source === "unavailable") return openSource();
  Object.assign(orderRecords,{outcomeType:"",recordSource:"orders",groupBy:item.key==='purchase_cost'?'inventory':'order',productId:"",sku:"",skuShopId:"",summary:{}}); recordItem.value = item; orderRecords.page = 1; orderRecords.keyword = ""; orderRecords.rows = []; orderRecordDrawer.value = true; loadOrderRecords();
}
function showLossRecords(outcomeType) {
  recordItem.value={key:'recognized_loss',label:outcomeType==='returns'?'退货 / 拒收':'取消订单'};
  Object.assign(orderRecords,{outcomeType,sortBy:outcomeType==='returns'?'quantity':'amount',sortOrder:"desc",recordSource:"orders",groupBy:"inventory",productId:"",sku:"",skuShopId:"",summary:{}});orderRecords.page=1;orderRecords.keyword='';orderRecords.rows=[];orderRecordDrawer.value=true;loadOrderRecords();
}
const shopRows = computed(() => (state.month?.shops || []).map(row => {
  const groups = buildBillingGroups(row, expenseRows.value.filter(expense => String(expense.shop_id || "") === String(row.shop_id)));
  const byKey = Object.fromEntries(groups.map(group => [group.key, group.amount]));
  return { ...row, operating_expense: byKey.operating, personnel_expense: byKey.personnel, funds_expense: byKey.funds, grouped_expense_total: groups.slice(1).reduce((sum, group) => sum + group.amount, 0) };
}));
const expenseRows = computed(() => state.month?.expenses || []);
const expenseBreakdown = computed(() => summarizeBillingExpenses(expenseRows.value));
const correctionDialog=ref(false),correctionSaving=ref(false),correctionForm=reactive({order_id:null,field:'',company_id:'',base:0,amount:0,revision:0,reason:'',projection_delta:0});
const editableOrderField = computed(()=>['domestic_shipping_cost','packaging_cost'].includes(recordItem.value?.key));
const editableExpenseCategory = computed(()=>recordItem.value?.key==='domestic_shipping_cost'?'domestic_shipping':recordItem.value?.key==='packaging_cost'?'packaging':recordItem.value?.key==='other_fee'?'order_payment':'other');
function orderAdjustment(row) { return expenseRows.value.find(e=>e.source_type==='billing_cost_adjustment'&&Number(e.cost_order_id)===Number(row.order_id)&&e.cost_field===recordItem.value?.key); }
function orderCost(row) {return Math.round((Number(row.billing_costs?.[recordItem.value?.key]??row[recordItem.value?.key]??0)+(row.adjustments_included?0:Number(orderAdjustment(row)?.amount_cny||0)))*100)/100;}
function openCostCorrection(row,remove=false) {
  const adjustment=orderAdjustment(row);
  Object.assign(correctionForm,{order_id:row.order_id,field:recordItem.value.key,company_id:String(adjustment?.company_id||defaultCompanyId(row.shop_id)),base:Number(row[recordItem.value.key]||0),projection_delta:Number(row.billing_costs?.[recordItem.value.key]??row[recordItem.value.key]??0)-Number(row[recordItem.value.key]||0)-(row.adjustments_included?Number(adjustment?.amount_cny||0):0),amount:remove?0:orderCost(row),revision:Number(adjustment?.cost_revision||0),reason:remove?'移除该笔账单费用':''});
  correctionDialog.value=true;
}
async function saveCostCorrection(action='save') {
  correctionSaving.value=true;
  try{await apiClient.post('/api/finance-submissions/billing-cost',{order_id:correctionForm.order_id,field:correctionForm.field,company_id:Number(correctionForm.company_id),expected_base:correctionForm.base,expected_revision:correctionForm.revision,amount:correctionForm.amount-Number(correctionForm.projection_delta||0),reason:correctionForm.reason,action});correctionDialog.value=false;ElMessage.success('费用已更新');await loadData();await loadOrderRecords();}catch(error){ElMessage.error(error.message||'费用保存失败');}finally{correctionSaving.value=false;}
}
function editExpense(row) {
  if(row.source_type==='payroll_void'){ElMessage.info('这是已作废工资的审计冲销，请在工资管理查看原批次');return;}
  if(row.source_type==='billing_cost_adjustment') { Object.assign(correctionForm,{order_id:row.cost_order_id,field:row.cost_field,company_id:String(row.company_id),base:Number(row.cost_base),amount:Number(row.cost_base)+Number(row.amount_cny),revision:Number(row.cost_revision),projection_delta:0,reason:''});correctionDialog.value=true;return; }
  if(row.source_type==='finance_submission') {router.push({path:row.category==='salary'?'/finance/payroll':'/finance/reimbursements',query:{companyId:String(row.company_id),month:String(row.expense_date).slice(0,7)}});return;}
  openExpense(row);
}
const visibleExpenseRows = computed(() => expenseRows.value.filter((row) => !expenseCategoryFilter.value || (row.category || "other") === expenseCategoryFilter.value));
function showExpenses(category = "") { expenseCategoryFilter.value = category;expensePage.value=1; expenseDrawer.value = true; }
const aiSubscription = computed(() => expenseBreakdown.value.find((item) => item.value === "ai_subscription")?.amount || 0);

function formatAiMoney(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? amount.toLocaleString('zh-CN',{minimumFractionDigits:3,maximumFractionDigits:3}) : '0.000';
}

function formatRatio(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : "0.0%";
}


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

function applyBillingFilters() {
  router.replace({
    path: route.path,
    query: {
      ...route.query,
      year:undefined,month:undefined,selectedMonth:undefined,
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
    voucher_status:"missing",
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
      payment_reference: row.payment_reference || "",
      voucher_status:row.voucher_status||"missing"
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
      voucher_status: expenseForm.voucher_status||"missing"
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
  if(row.source_type==='payroll_void'){ElMessage.info('工资冲销记录保留审计，不能在此删除');return;}
  try {
    await ElMessageBox.confirm(row.source_type==='billing_cost_adjustment'?'删除这条更正后，会恢复来源订单的费用金额。确认删除？':`确认删除“${row.description || row.category}”这笔费用？`, "删除经营费用", { type: "warning" });
    if(row.source_type==='billing_cost_adjustment') await apiClient.post('/api/finance-submissions/billing-cost',{order_id:row.cost_order_id,field:row.cost_field,company_id:Number(row.company_id),expected_base:Number(row.cost_base),expected_revision:Number(row.cost_revision),action:'restore',reason:'删除费用更正，恢复来源金额'});
    else if(row.source_type==='finance_submission'){editExpense(row);return;}
    else await apiClient.delete(`/api/finance-center/expenses/${row.id}`);
    ElMessage.success("经营费用已删除");
    await loadData();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "经营费用删除失败");
  }
}

async function loadData() {
  recordCache.clear();
  abortController?.abort();
  abortController = new AbortController();
  const { signal } = abortController;
  state.loading = true;
  try {
    loadPayroll(signal);
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
  state.dateRange = billingCalendarRange(shanghaiDateKey().slice(0,4),shanghaiDateKey().slice(5,7));
  syncCalendar();
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
    syncCalendar();
    state.shopId = nextShopId;
    state.companyId = nextCompanyId;
    loadData();
  }
);
watch(sourceFilters, () => { if (orderRecordDrawer.value) { orderRecords.page = 1; loadOrderRecords(); } });
watch(()=>currentApiCacheScope(),()=>{recordCache.clear();evidenceController?.abort();evidenceRows.value=[];evidenceOpen.value=false;recordController?.abort();abortController?.abort();Object.assign(orderRecords,{rows:[],summary:{},total:0,productId:"",sku:"",skuShopId:""});payrollRows.value=[];state.month={summary:{},shops:[],expenses:[]};state.companyId='all';state.shopId='all';loadData();});
window.addEventListener("erp:finance-changed",loadData);
onBeforeUnmount(() => {window.removeEventListener("erp:finance-changed",loadData);evidenceController?.abort(); abortController?.abort(); recordController?.abort(); recordCache.clear(); });
</script>

<template>
  <div class="page-stack monthly-billing-page">
    <section class="billing-toolbar">
      <h1>经营账单</h1>
      <el-date-picker v-model="quickYear" type="year" value-format="YYYY" format="YYYY年" placeholder="年份" clearable aria-label="账单年份" class="year-input" :disabled-date="date=>date.getFullYear()<2000||date.getFullYear()>2099" @change="selectCalendarYear"/>
      <el-select v-model="quickMonth" :disabled="!quickYear" aria-label="账单月份" placeholder="月份" class="month-input" @change="selectCalendarMonth"><el-option label="全年" value=""/><el-option v-for="month in 12" :key="month" :label="month+'月'" :value="String(month)"/></el-select>
      <el-date-picker v-model="state.dateRange" @change="selectCustomRange" type="daterange" value-format="YYYY-MM-DD" range-separator="至" :clearable="false" aria-label="统计时间" class="period-input" />
      <el-select v-model="state.companyId" filterable aria-label="公司" class="company-input"><el-option label="全部公司" value="all"/><el-option v-for="company in state.companies" :key="company.id" :label="company.name" :value="String(company.id)"/></el-select>
      <el-select v-model="state.shopId" filterable aria-label="店铺" class="shop-input"><el-option label="全部店铺" value="all"/><el-option v-for="shop in state.shops" :key="shop.id" :label="shop.name" :value="String(shop.id)"/></el-select>
      <el-button type="primary" :loading="state.loading" @click="applyBillingFilters">查询</el-button>
      <el-button @click="handleReset">重置</el-button>
      <div class="toolbar-links"><el-button :icon="Plus" @click="openExpense(null,'other')">录入费用</el-button><el-dropdown @command="toolbarCommand"><el-button>更多 ▾</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item command="overview">年度总览</el-dropdown-item><el-dropdown-item command="capital">采购与库存</el-dropdown-item><el-dropdown-item command="ai">AI 用量</el-dropdown-item><el-dropdown-item command="payroll">工资归档</el-dropdown-item></el-dropdown-menu></template></el-dropdown></div>
    </section>
    <section v-loading="state.loading" class="billing-overview">
      <el-alert v-if="selectedSummary.income_pending_count" :title="selectedSummary.income_pending_count+'单已收到官方退货状态，但退款收入账单尚未对齐；净利润暂标待核定。'" type="warning" :closable="false"/>
      <div class="summary-grid">
        <button class="summary-card interactive" @click="openOrderDetails()"><BillingMetricLabel label="订单" :hint="billingMetrics.order_count.hint"/><strong>{{formatInteger(selectedSummary.order_count)}}</strong><small>查看订单 →</small></button>
        <button class="summary-card interactive" @click="showGroupItem(incomeGroup.children[0])"><BillingMetricLabel label="营业额" :hint="billingMetrics.revenue.hint"/><strong>¥{{formatMoney(selectedSummary.revenue)}}</strong><small>查看收入 →</small></button>
        <div class="summary-card"><BillingMetricLabel metric="order_profit"/><strong>¥{{formatMoney(selectedSummary.order_profit)}}</strong><small>订单相关费用已扣除</small></div>
        <div class="summary-card is-profit"><BillingMetricLabel label="净利润" :hint="billingMetrics.net_profit.hint"/><strong :class="{'negative-money':Number(selectedSummary.net_profit)<0}">{{selectedSummary.net_profit==null?'待核定':'¥'+formatMoney(selectedSummary.net_profit)}}</strong><small>{{selectedSummary.net_profit_margin==null?'待核定':formatRatio(selectedSummary.net_profit_margin)}} 净利率</small></div>
        <button class="summary-card interactive" @click="shopsOpen=true"><span>店铺</span><strong>{{shopRows.length}}</strong><small>查看账单 →</small></button>
        <button class="summary-card interactive" @click="settlementOpen=true"><BillingMetricLabel label="入账进度" hint="已入账订单数 ÷ 所选范围的订单总数，按Ozon财务记录识别，不是银行到账比例。取消订单可能不产生入账记录。"/><strong>{{formatRatio(entryProgress)}}</strong><small>查看结算 →</small></button>

      </div>
      <div class="profit-workspace">
        <div class="formula-card">

          <div class="expense-panels">
            <article v-for="group in expenseGroups" :key="group.key" class="expense-panel">
              <header><BillingMetricLabel :label="groupNames[group.key]" :hint="group.hint"/><strong>{{group.amount==null?'待核定':'¥'+formatMoney(group.amount)}}</strong></header>
              <div v-for="item in inlineItems(group)" :key="item.key" class="expense-line"><BillingMetricLabel :label="itemNames[item.key] || item.label" :hint="item.hint"/><el-button link type="primary" @click="showGroupItem(item)">{{item.amount==null?(item.source==='ai_usage'?'待核定':'未拆分'):formatMoney(item.amount)}} <span class="amount-arrow">→</span></el-button></div>
              <div v-if="!inlineItems(group).length && group.key!=='personnel'" class="empty-expense">暂无已入账费用</div>
              <template v-if="group.key==='personnel'">
                <div v-if="pendingPayroll" class="expense-line pending-payroll"><BillingMetricLabel label="待确认入账工资" hint="金额已填报或已登记发放，但尚未确认入账。点击下方批次可在本页核对并计入费用。"/><span>¥{{formatMoney(pendingPayroll)}}</span></div>
                <span v-if="payrollError" class="payroll-hint">工资暂未读取</span><span v-else-if="!payrollLoading && !visiblePayroll.length" class="payroll-hint">所选月份暂无工资记录</span>
                <el-button link type="primary" class="payroll-entry" :loading="payrollLoading" @click="payrollOpen=true">工资明细<span v-if="visiblePayroll.length">（{{visiblePayroll.length}}条）</span> →</el-button>
                <el-button v-for="id in pendingPayrollBatches" :key="id" link type="primary" @click="reviewSubmissionId=id">核对并入账 · 批次{{id}} →</el-button>
                <span class="payroll-hint">已发放工资按归属月计成本，审批后不重复扣除</span>
              </template>
            </article>
          </div>
          <div class="loss-review"><BillingMetricLabel label="退货与取消" hint="这里核对订单记录的损失；商品、运费等若已在上方列支，不再重复加减。缺少来源或尚未入账的损失仍需另行核对。未履约取消不默认记为损失。"/><el-button link type="primary" @click="showLossRecords('returns')">退货 / 拒收 →</el-button><el-button link type="primary" @click="showLossRecords('cancelled_pre_fulfillment')">取消订单 →</el-button><small>核对已计入费用，避免重复扣除</small></div>
          <el-tooltip placement="top"><template #content>分类差额保留待核对，不重复扣费。退货损失可能含货值与运费，不作为另一类支出相加。</template><p v-if="unclassifiedDifference" class="group-note">待核对差额 ¥{{formatMoney(unclassifiedDifference)}} ⓘ</p></el-tooltip>
        </div>
      </div>
    </section>
    <FinanceImportPanel v-if="reviewSubmissionId" kind="payroll" :submission-id="reviewSubmissionId" @closed="reviewSubmissionId=null" @changed="loadData"/>
    <el-dialog v-model="withdrawalOpen" title="提现手续费" width="min(92vw,680px)" destroy-on-close>
      <p>按公司和月份汇总；平台回款余值 = 营业额 − 佣金 − 平台物流/配送 − 服务费 − Ozon收单费 − 广告 − 平台售后费用。</p>
      <p>回款基数 <strong>¥{{formatMoney(selectedSummary.withdrawal_base)}}</strong> × 1.2% = <strong>¥{{formatMoney(selectedSummary.withdrawal_estimate)}}</strong></p>
      <p>本期计费 ¥{{formatMoney(selectedSummary.withdrawal_fee)}}（{{selectedSummary.withdrawal_source!=='estimated'?'已登记实际费用，替换估算':'按1.2%估算'}}）。采购、国内运费、包装、工资不进入提现基数；旧预估提现费已从可拆分的订单混合手续费中移出。</p>
      <el-button type="primary" @click="openExpense(null,'withdrawal')">登记实际提现费</el-button><el-button @click="showExpenses('withdrawal')">实际费用记录</el-button>
    </el-dialog>
    <el-dialog v-model="payrollOpen" title="工资明细" width="min(96vw, 1120px)" destroy-on-close>
      <p class="payroll-hint">工资按所选公司和月份展示；账单支出按实际记账日期统计。公司共用工资不自动分摊到店铺。</p>
      <el-alert v-if="payrollError" :title="payrollError" type="warning" :closable="false"/>
      <el-select v-model="payrollMonth" aria-label="工资月份" style="width:180px;margin:12px 0"><el-option label="所选期间" value="period"/><el-option label="全年工资" value="all"/><el-option v-for="month in payrollMonths" :key="month" :label="month" :value="month"/></el-select>
      <el-table v-loading="payrollLoading" :data="payrollDetails" max-height="60vh" empty-text="所选公司和月份暂无工资记录">
        <el-table-column prop="company_name" label="公司" min-width="160"/><el-table-column prop="month" label="月份" width="100"/><el-table-column prop="person_name" label="员工" width="100"/>
        <el-table-column label="基本工资" align="right" width="120"><template #default="{row}">{{formatMoney(row.base)}}</template></el-table-column>
        <el-table-column label="公司缴费" align="right" width="120"><template #default="{row}">{{formatMoney(row.employer)}}</template></el-table-column>
        <el-table-column label="公司成本" align="right" width="120"><template #default="{row}">{{formatMoney(payrollCost(row))}}</template></el-table-column>
        <el-table-column label="已登记发放" width="120" align="right"><template #default="{row}">{{formatMoney(row.paid_amount)}}</template></el-table-column><el-table-column label="未发差额" width="120" align="right"><template #default="{row}">{{formatMoney(row.remaining_amount)}}</template></el-table-column>
        <el-table-column label="入账状态" width="130"><template #default="{row}"><el-tag :type="row.approval_status==='approved'||row.cost_confirmed||Number(row.paid_amount||0)>0?'success':'warning'">{{row.approval_status==='approved'?'已入账':Number(row.paid_amount||0)>0?'已发待归档':row.cost_confirmed?'已确认待归档':'待确认'}}</el-tag></template></el-table-column>
        <el-table-column label="操作" width="110"><template #default="{row}"><el-button link type="primary" @click="router.push({path:'/finance/payroll',query:{month:row.month,companyId:String(row.company_id)}})">查看原记录</el-button></template></el-table-column>
      </el-table>
    </el-dialog>
    <el-dialog v-model="settlementOpen" title="结算" width="min(94vw, 520px)" destroy-on-close>
        <aside class="settlement-card">
          <p>按 Ozon 财务入账记录统计订单数量，不表示货款已到账。</p>
          <div class="settlement-meta"><span>已入账</span><strong>{{formatInteger(selectedSummary.accrued_order_count)}} 单</strong></div>
          <div class="settlement-meta"><span>待入账</span><strong>{{formatInteger(selectedSummary.pending_order_count)}} 单</strong></div>
          <div class="settlement-meta"><BillingMetricLabel label="其他订单" hint="取消等尚无明确财务入账状态的订单，不默认记为已入账。"/><strong>{{formatInteger(Math.max(0,Number(selectedSummary.order_count||0)-Number(selectedSummary.accrued_order_count||0)-Number(selectedSummary.pending_order_count||0)))}} 单</strong></div>
        </aside>
    </el-dialog>

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

    <el-dialog v-model="shopsOpen" title="店铺账单" width="min(96vw, 1500px)" destroy-on-close>
    <section v-if="shopsOpen" v-loading="state.loading" class="shop-section">
      <div class="section-head">
        <div>
          <strong>{{ selectedPeriodTitle }}</strong>
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
          <template #default="{ row }"><strong :class="{ 'negative-money': Number(row.net_profit || 0) < 0 }">{{ row.net_profit==null?'待核定':formatMoney(row.net_profit) }}</strong></template>
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

    </el-dialog>
    <el-dialog v-model="aiOpen" title="AI 用量" width="min(96vw, 1120px)" destroy-on-close>
    <section v-if="aiOpen" v-loading="state.loading" class="ai-usage-section"><p v-if="selectedSummary.ai_cost_company_id">图片费用归属：{{state.companies.find(c=>Number(c.id)===Number(selectedSummary.ai_cost_company_id))?.name||'已配置公司'}}；本账单按量成本 {{selectedSummary.ai_usage_cost==null?'待核定':formatMoney(selectedSummary.ai_usage_cost)}} 元，固定AI费用 {{formatMoney(selectedSummary.ai_fixed_cost)}} 元。</p><p v-if="selectedSummary.ai_cost_fallback_months?.length">无调用记录月份按已确认估算：{{selectedSummary.ai_cost_fallback_months.join('、')}}。</p>
      <div class="section-head">
        <div>
          <strong>{{ selectedPeriodTitle }}</strong>
          <span>按量生图按操作人员统计，不受店铺筛选影响；固定订阅按上方日期、公司和店铺筛选。</span>
        </div>
      </div>
      <div class="ai-usage-summary">
        <article><BillingMetricLabel label="企业图片调用估算" hint="这里展示原始图片调用费用，不含固定订阅及历史缺失月份补估。"/><strong>{{aiUsage.available===false?'待核定':formatAiMoney(aiUsage.cost)+' RMB'}}</strong></article>
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

    </el-dialog>

    <el-drawer v-model="orderRecordDrawer" :title="(recordItem?.label || '') + '明细'" size="min(100%, 1060px)" destroy-on-close @closed="recordController?.abort()">
      <div v-loading="orderRecords.loading" class="group-detail">
        <div v-if="editableOrderField" class="drawer-toolbar"><el-button type="primary" @click="openExpense(null,editableExpenseCategory)">新增费用</el-button><el-button @click="showExpenses(editableExpenseCategory)">补充与更正记录</el-button></div>
        <el-radio-group v-if="recordItem?.key==='purchase_cost'" v-model="orderRecords.recordSource" @change="orderRecords.page=1;orderRecords.productId='';orderRecords.sku='';orderRecords.groupBy='inventory';loadOrderRecords()"><el-radio-button value="orders">订单商品成本</el-radio-button><el-radio-button value="procurement" :disabled="state.companyId!=='all'||state.shopId!=='all'">实际采购支出</el-radio-button></el-radio-group>
        <p v-if="orderRecords.recordSource==='procurement'">按采购完成日期统计全企业实际采购；关联SKU仅用于查询，不重复分摊采购数量。切换公司或店铺时请使用订单商品成本。</p>
        <p v-else>{{orderRecords.outcomeType?'按下单日期统计同一批订单；损益按关联订单费用分摊，保留未核定的预估成本。官方缺项标为待核对，冲回保留负数，不再重复扣损失总额。':recordItem?.key==='purchase_cost'?'这里统计订单消耗的商品成本，不是全部采购付款；支持按库存或SKU汇总。':'来源金额保留原订单记录，账单金额体现官方冲回及人工更正。'}}</p>
        <div class="drawer-toolbar"><el-select v-model="orderRecords.groupBy" aria-label="汇总方式" style="width:150px" @change="orderRecords.page=1;loadOrderRecords()"><el-option label="按库存汇总" value="inventory"/><el-option v-if="orderRecords.recordSource!=='procurement'" label="按SKU汇总" value="sku"/><el-option label="按订单查看" value="order"/></el-select><el-select v-model="orderRecords.sortBy" aria-label="排序字段" style="width:130px" @change="orderRecords.page=1;loadOrderRecords()"><el-option :label="orderRecords.outcomeType?'净损失':'金额'" value="amount"/><el-option label="订单数" value="order_count"/><el-option :label="orderRecords.outcomeType==='returns'?'退货件数':'件数'" value="quantity"/><el-option v-if="orderRecords.outcomeType" :label="orderRecords.outcomeType==='returns'?'退货率':'取消率'" value="rate"/></el-select><el-select v-model="orderRecords.sortOrder" aria-label="排序方向" style="width:100px" @change="orderRecords.page=1;loadOrderRecords()"><el-option label="从高到低" value="desc"/><el-option label="从低到高" value="asc"/></el-select><el-button v-if="orderRecords.productId||orderRecords.sku" @click="clearDrill">清除商品筛选</el-button></div>
        <div v-if="orderRecords.outcomeType||recordItem?.key==='purchase_cost'" class="drill-summary">
          <div><span>订单 / 件数</span><strong>{{formatInteger(orderRecords.summary.order_count)}} / {{orderRecords.summary.quantity==null?'待核实':formatInteger(orderRecords.summary.quantity)}}</strong></div>
          <div><span>{{orderRecords.outcomeType?'原订单金额':orderRecords.recordSource==='procurement'?'实际采购货款':'采购成本'}}</span><strong>¥{{formatMoney(orderRecords.outcomeType?orderRecords.summary.order_amount:orderRecords.summary.amount)}}</strong></div>
          <div v-if="orderRecords.recordSource==='procurement'"><span>采购运费</span><strong>¥{{formatMoney(orderRecords.summary.logistics_loss)}}</strong></div>
          <template v-if="orderRecords.outcomeType"><div><span>净损益</span><strong>¥{{formatMoney(orderRecords.summary.net_profit)}}</strong></div><div><span>货值成本</span><strong>¥{{formatMoney(orderRecords.summary.goods_loss)}}</strong></div><div><span>物流及退货费</span><strong>¥{{formatMoney(orderRecords.summary.logistics_loss)}}</strong></div><div><span>佣金净扣款</span><strong>¥{{formatMoney(orderRecords.summary.commission_loss)}}</strong></div></template>
        </div>
        <el-alert v-if="orderRecords.outcomeType&&orderRecords.summary.pending_count" :title="orderRecords.summary.pending_count+'单的官方费用尚未齐全，仍含预估；未把缺项视为0。货值是否追回仍需核对。'" type="warning" :closable="false"/>
        <el-input v-model="orderRecords.keyword" clearable placeholder="搜索订单号、SKU或库存" @change="orderRecords.page = 1; loadOrderRecords()" />
        <el-alert v-if="orderRecords.error" :title="orderRecords.error" type="error" :closable="false" />
        <el-table :data="orderRecords.rows" stripe border>
          <el-table-column v-if="orderRecords.outcomeType||recordItem?.key==='purchase_cost'" label="图片" width="85"><template #default="{row}"><el-image v-if="row.image_url" :src="row.image_url" :preview-src-list="[row.image_url]" preview-teleported fit="cover" style="width:64px;height:84px"/><span v-else>无图</span></template></el-table-column>
          <el-table-column v-if="orderRecords.groupBy==='order'" label="下单日期" width="115"><template #default="{row}">{{shanghaiDateText(row.ordered_at)}}</template></el-table-column>
          <el-table-column v-if="orderRecords.groupBy==='order'" prop="posting_number" label="订单号" min-width="175"/>
          <el-table-column v-if="orderRecords.outcomeType||recordItem?.key==='purchase_cost'||orderRecords.groupBy!=='order'" label="商品 / 库存" min-width="210"><template #default="{row}"><strong>{{row.inventory_name||row.product_name||'未绑定库存'}}</strong><div>库存ID：{{row.inventory_number||row.product_id||'未绑定'}}</div><small>SKU：{{row.ozon_skus||row.ozon_sku||'-'}}</small></template></el-table-column>
          <el-table-column v-if="orderRecords.groupBy!=='inventory'" prop="shop_name" label="店铺" min-width="120"/>
          <el-table-column v-if="orderRecords.groupBy!=='order'" prop="order_count" :label="orderRecords.outcomeType==='returns'?'退货单数':'订单数'" width="90"/>
          <el-table-column v-if="orderRecords.outcomeType||recordItem?.key==='purchase_cost'" prop="quantity" :label="orderRecords.outcomeType==='returns'?'退货件数':'件数'" width="90"><template #default="{row}">{{row.quantity==null?'待核实':formatInteger(row.quantity)}}</template></el-table-column>
          <el-table-column v-if="orderRecords.outcomeType&&orderRecords.groupBy!=='order'" :label="orderRecords.outcomeType==='returns'?'退货率':'取消率'" width="130"><template #header><BillingMetricLabel :label="orderRecords.outcomeType==='returns'?'退货率':'取消率'" hint="件数口径：该库存退货或取消件数÷同一筛选期间该库存全部下单件数。下方另列订单数；近期结果尚未完整。"/></template><template #default="{row}">{{row.rate==null?'待核实':formatRatio(row.rate)}}<small> / {{formatInteger(row.base_quantity)}}件</small><small>订单：{{row.order_count}} / {{row.base_order_count}}</small></template></el-table-column>
          <el-table-column v-if="recordItem?.key==='other_fee'" label="Ozon项目" min-width="200"><template #default="{row}">{{row.fee_evidence?.filter(r=>r.category==='collecting_fee').map(r=>r.service_name).filter((v,i,a)=>a.indexOf(v)===i).join('、')||'收单费预估，待官方核对'}}<small>Acquiring / MarketplaceRedistributionOfAcquiringOperation</small></template></el-table-column>
          <el-table-column v-if="orderRecords.groupBy==='order'" label="费用依据" width="130"><template #default="{row}">{{row.reconciliation_status==='official'?'官方净额':row.reconciliation_status==='recorded'?'已入账':row.reconciliation_status==='partial'?'部分官方 / 待核对':'订单预估 / 待核对'}}</template></el-table-column>
          <el-table-column v-if="orderRecords.groupBy==='order'&&isCostRecord&&orderRecords.recordSource!=='procurement'" label="原订单成本" width="120" align="right"><template #default="{row}">{{formatMoney(row[recordItem?.key])}}</template></el-table-column>
          <el-table-column :label="orderRecords.outcomeType?'分摊净损失（负数为收益）':'账单金额（CNY）'" min-width="150" align="right"><template #default="{row}">{{formatMoney(orderRecords.groupBy==='order'&&editableOrderField?orderCost(row):row.amount)}}</template></el-table-column>
          <el-table-column label="操作" min-width="160" fixed="right"><template #default="{row}"><el-button v-if="orderRecords.groupBy!=='order'" link type="primary" @click="drillOrders(row)">看订单</el-button><template v-else><el-button v-if="orderRecords.recordSource!=='procurement'" link type="primary" @click="showEvidence(row)">核对账单</el-button><template v-if="editableOrderField&&!orderRecords.outcomeType"><el-button link type="primary" @click="openCostCorrection(row)">编辑</el-button><el-button link type="danger" @click="openCostCorrection(row,true)">删除</el-button></template></template></template></el-table-column>
        </el-table>
        <el-pagination v-model:current-page="orderRecords.page" v-model:page-size="orderRecords.pageSize" :page-sizes="[20,50,100]" :total="orderRecords.total" layout="total, sizes, prev, pager, next" @size-change="orderRecords.page=1;loadOrderRecords()" @current-change="loadOrderRecords" />
      </div>
    </el-drawer>

    <el-dialog v-model="evidenceOpen" @closed="evidenceController?.abort()" title="官方账单依据" width="min(96vw,1200px)" destroy-on-close>
      <p>Ozon原始账单按操作日保留正负：负数是扣款，正数是冲回或入账。母单费用按原订单权重分摊；缺少其他项目不代表其费用为0。</p>
      <el-alert v-if="evidenceError" :title="evidenceError" type="warning" :closable="false"/><el-table v-loading="evidenceLoading" :data="evidenceRows.slice((evidencePage-1)*evidencePageSize,evidencePage*evidencePageSize)" border><el-table-column prop="operation_date" label="账单日期" width="115"><template #default="{row}">{{shanghaiDateText(row.operation_date)}}</template></el-table-column><el-table-column prop="service_name" label="Ozon原始项目" min-width="150"/><el-table-column prop="operation_id" label="账单流水号" min-width="220"/><el-table-column prop="posting_number" label="关联货件 / 母单" min-width="170"/><el-table-column label="原币金额" min-width="130"><template #default="{row}">{{formatMoney(row.amount)}} {{row.currency_code}}</template></el-table-column><el-table-column label="人民币净额" min-width="120"><template #default="{row}">{{row.amount_cny==null?'未换算':formatMoney(row.amount_cny)}}</template></el-table-column><el-table-column prop="source_endpoint" label="来源接口" min-width="240"/></el-table><el-pagination v-model:current-page="evidencePage" v-model:page-size="evidencePageSize" :page-sizes="[20,50,100]" :total="evidenceRows.length" layout="total, sizes, prev, pager, next"/>
    </el-dialog>
    <el-drawer v-model="sourceDrawer" :title="sourceKind === 'advertising' ? '广告费用明细' : 'Ozon 原始账单明细'" size="min(100%, 1160px)" destroy-on-close>
      <BillingSourceRecords v-if="sourceDrawer" :filters="sourceFilters" :source="sourceKind" />
      <el-button v-if="sourceKind === 'advertising'" style="margin-top:16px" @click="showGroupItem({ key: 'advertising_cost', label: '订单广告成本', source: 'orders' })">查看订单广告成本（报表无金额时的回退值）</el-button>
    </el-drawer>

    <el-drawer v-model="expenseDrawer" :title="expenseCategoryFilter ? billingExpenseCategoryLabel(expenseCategoryFilter) + '明细' : '经营费用与工资明细'" size="min(100%, 1160px)">
      <div class="drawer-toolbar">
        <span>共 {{ visibleExpenseRows.length }} 笔，按具体类型汇总；工资单独统计。</span>
        <el-button type="primary" :icon="Plus" @click="openExpense(null, expenseCategoryFilter || 'other')">新增费用</el-button>
      </div>
      <el-button v-if="expenseCategoryFilter" link type="primary" @click="expenseCategoryFilter = ''">查看全部费用</el-button>
      <el-table :data="visibleExpenseRows.slice((expensePage-1)*expensePageSize,expensePage*expensePageSize)" stripe border>
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
            <el-button link type="primary" :icon="Edit" @click="editExpense(row)">编辑</el-button>
            <el-button link type="danger" :icon="Delete" @click="removeExpense(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination v-model:current-page="expensePage" v-model:page-size="expensePageSize" :page-sizes="[20,50,100]" :total="visibleExpenseRows.length" layout="total, sizes, prev, pager, next"/>
    </el-drawer>

    <el-dialog v-model="correctionDialog" title="更正费用" width="min(94vw,520px)" :close-on-click-modal="!correctionSaving">
      <el-alert type="info" :closable="false" title="填写这笔费用的最终金额；填0表示移除。系统保留来源金额并记录更正差额，只扣一次。"/>
      <el-form label-position="top"><el-form-item label="公司"><el-select v-model="correctionForm.company_id"><el-option v-for="company in state.companies" :key="company.id" :label="company.name" :value="String(company.id)"/></el-select></el-form-item><el-form-item label="账单金额"><el-input-number v-model="correctionForm.amount" aria-label="更正后金额" :formatter="formatAmountInput" :parser="parseAmountInput" :min="0" :precision="2"/></el-form-item><el-form-item label="原因"><el-input v-model="correctionForm.reason" aria-label="更正原因" type="textarea" maxlength="500"/></el-form-item></el-form>
      <template #footer><el-button @click="correctionDialog=false">取消</el-button><el-button type="primary" :loading="correctionSaving" @click="saveCostCorrection()">保存</el-button></template>
    </el-dialog>
    <el-dialog v-model="expenseDialog" :title="expenseForm.id ? '编辑经营费用' : '补录经营费用'" width="680px" align-center>
      <el-form label-position="top">
        <div class="expense-form-grid">
          <el-form-item label="项目/费用名称" class="wide-field">
            <el-input v-model="expenseForm.description" :placeholder="expenseForm.category==='fbp_stocking_shipping'?'例如：11月16日FBP备货快递费，可备注批次或运单号':'例如：GPT Pro订阅、水电费、团建、餐补'" />
          </el-form-item>
          <el-form-item label="费用类型">
            <el-select v-model="expenseForm.category">
              <el-option v-for="item in billingExpenseCategories" :key="item.value" :label="item.label" :value="item.value"><BillingMetricLabel :label="item.label" :hint="item.hint" /></el-option>
            </el-select>
          </el-form-item>
          <el-form-item label="费用金额（CNY）">
            <el-input-number v-model="expenseForm.amount_cny" :formatter="formatAmountInput" :parser="parseAmountInput" :precision="2" :min="0" controls-position="right" />
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
            <el-select v-model="expenseForm.company_id" :disabled="Boolean(expenseForm.id)">
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
.summary-grid.aligned-summary{grid-template-columns:repeat(5,minmax(0,1fr))}.billing-secondary{display:flex;gap:24px;flex-wrap:wrap;margin:12px 0 18px}@media(max-width:900px){.summary-grid.aligned-summary{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>

<style scoped>
.billing-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:var(--el-bg-color);border:1px solid var(--el-border-color-lighter);border-radius:12px;padding:16px 20px}.billing-toolbar h1{font-size:18px;margin:0 14px 0 0;white-space:nowrap}.billing-toolbar .period-input{width:260px;flex:0 0 260px}.company-input{width:190px}.shop-input{width:170px}.toolbar-links{display:flex;gap:10px;margin-left:auto}.billing-toolbar .el-button+.el-button{margin-left:0}
.summary-grid{grid-template-columns:repeat(5,minmax(0,1fr));padding:20px;gap:12px}.summary-card{font:inherit;text-align:left;border-radius:10px;background:var(--el-fill-color-lighter);min-height:100px}.summary-card.interactive{cursor:pointer}.summary-card.interactive:hover{border-color:var(--el-color-primary-light-5);background:var(--el-color-primary-light-9)}.summary-card.is-profit strong{font-size:28px}.summary-card small{color:var(--el-text-color-secondary)}
.profit-workspace{display:block;padding:0 20px 20px}.formula-card{border:none}.income-group{display:flex;justify-content:space-between;border:1px solid var(--el-color-success-light-8);border-radius:10px;padding:17px 20px;margin-bottom:16px}.income-group .el-button{font-size:24px;font-weight:700;color:var(--el-color-success)}.expense-panels{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.expense-panel{border:1px solid var(--el-border-color-lighter);border-radius:10px;padding:16px 18px}.expense-panel header{display:flex;align-items:center;justify-content:space-between;padding-bottom:12px;margin-bottom:6px;border-bottom:1px solid var(--el-border-color-extra-light);font-size:15px}.expense-panel header strong{font-variant-numeric:tabular-nums}.expense-line{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:34px;font-size:13px}.expense-line .el-button{font-variant-numeric:tabular-nums}.amount-arrow{color:var(--el-text-color-placeholder);margin-left:5px}.empty-expense,.payroll-hint{color:var(--el-text-color-secondary);font-size:12px}.empty-expense{padding:10px 0}.payroll-hint{display:block;margin-top:6px;line-height:1.6}.payroll-entry{margin-top:10px}.settlement-card{border:none;padding:0}.shop-section,.ai-usage-section{border:none;border-radius:0}.shop-section .section-head,.ai-usage-section .section-head{padding-top:0}
@media(max-width:1100px){.expense-panels{grid-template-columns:repeat(2,minmax(0,1fr))}.toolbar-links{margin-left:0}.summary-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:650px){.expense-panels{grid-template-columns:1fr}.summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.billing-toolbar{padding:12px}.company-input,.shop-input{width:calc(50% - 8px)}}
</style>

<style scoped>
.billing-toolbar :deep(.el-date-editor--daterange){flex:0 0 270px;width:270px;max-width:270px}.expense-panel header .el-button{font-weight:700}.summary-card.is-profit .negative-money{color:var(--el-color-danger)}
</style>

<style scoped>.pending-payroll{color:var(--el-color-warning);border-top:1px dashed var(--el-border-color-lighter);padding-top:7px;margin-top:5px}.pending-payroll span{font-variant-numeric:tabular-nums}</style>

<style scoped>.summary-grid{grid-template-columns:repeat(6,minmax(0,1fr))}@media(max-width:1100px){.summary-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:650px){.summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}</style>

<style scoped>.loss-review{display:flex;align-items:center;gap:24px;padding:16px 4px 0;flex-wrap:wrap}.loss-review small{color:var(--el-text-color-secondary)}</style>

<style scoped>.billing-toolbar .year-input{width:110px;flex:0 0 110px}.billing-toolbar .month-input{width:90px;flex:0 0 90px}.billing-toolbar .company-input{width:155px}.billing-toolbar .shop-input{width:145px}.billing-toolbar :deep(.el-date-editor--daterange){width:250px;max-width:250px;flex:0 0 250px}</style>

<style scoped>.drill-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:16px 0}.drill-summary>div{padding:12px;background:var(--el-fill-color-light);border-radius:6px}.drill-summary span{display:block;font-size:12px;color:var(--el-text-color-secondary)}.drill-summary strong{display:block;margin-top:6px;font-size:18px}</style>
