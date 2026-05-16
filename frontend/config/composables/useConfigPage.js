import { computed, reactive } from "vue";
import {
  calculateFormula,
  changeConfigTab,
  cleanupDeliveredReturnLoss,
  deleteCancellationRule,
  deleteLogisticsRule,
  deleteShop,
  disablePerson,
  editCancellationRule,
  editLogisticsRule,
  editPerson,
  editShop,
  hardDeletePerson,
  openChangePassword,
  openCreatePerson,
  openCreateRate,
  openCreateShop,
  openHistoricalProfitOrder,
  recalculateHistoricalProfit,
  refreshHistoricalProfitReview,
  resetCancellationRule,
  resetCancellationTester,
  resetLogisticsRule,
  runHistoricalProfitAction,
  saveCancellationRule,
  saveLogisticsRule,
  syncProfitFinance,
  testCancellationRule,
  toggleHistoricalProfitSelection,
  toggleHistoricalProfitSelectionAll
} from "../services/config-service.js";

export function useConfigPage() {
  const vm = reactive({
    title: "系统设置",
    subtitle: "",
    activeTab: "shops",
    tabs: [],
    account: { name: "-", role: "-" },
    shops: [],
    people: [],
    rates: [],
    exchangeRate: null,
    formula: {
      form: {},
      result: {
        metrics: [],
        channels: [],
        error: ""
      }
    },
    profitRules: {
      metrics: {},
      steps: [],
      financeSummary: {
        badges: [],
        rows: []
      },
      reviewSummary: {},
      reviewRows: [],
      reviewSelectedIds: []
    },
    logistics: {
      logisticsForm: {},
      logisticsRows: [],
      cancellationForm: {},
      cancellationRows: [],
      testerForm: {},
      testerResult: null
    },
    summaries: {
      shops: [],
      people: [],
      rates: []
    }
  });

  const activeTabLabel = computed(() => vm.tabs.find((item) => item.value === vm.activeTab)?.label || "系统设置");

  function patch(payload = {}) {
    vm.title = String(payload.title || vm.title);
    vm.subtitle = String(payload.subtitle || "");
    vm.activeTab = String(payload.activeTab || vm.activeTab);
    vm.tabs = Array.isArray(payload.tabs) ? payload.tabs : [];
    vm.account = {
      name: String(payload.account?.name || "-"),
      role: String(payload.account?.role || "-")
    };
    vm.shops = Array.isArray(payload.shops) ? payload.shops : [];
    vm.people = Array.isArray(payload.people) ? payload.people : [];
    vm.rates = Array.isArray(payload.rates) ? payload.rates : [];
    vm.exchangeRate = payload.exchangeRate || null;
    vm.formula = {
      form: payload.formula?.form || {},
      result: {
        metrics: Array.isArray(payload.formula?.result?.metrics) ? payload.formula.result.metrics : [],
        channels: Array.isArray(payload.formula?.result?.channels) ? payload.formula.result.channels : [],
        error: String(payload.formula?.result?.error || "")
      }
    };
    vm.profitRules = {
      metrics: payload.profitRules?.metrics || {},
      steps: Array.isArray(payload.profitRules?.steps) ? payload.profitRules.steps : [],
      financeSummary: {
        badges: Array.isArray(payload.profitRules?.financeSummary?.badges) ? payload.profitRules.financeSummary.badges : [],
        rows: Array.isArray(payload.profitRules?.financeSummary?.rows) ? payload.profitRules.financeSummary.rows : []
      },
      reviewSummary: payload.profitRules?.reviewSummary || {},
      reviewRows: Array.isArray(payload.profitRules?.reviewRows) ? payload.profitRules.reviewRows : [],
      reviewSelectedIds: Array.isArray(payload.profitRules?.reviewSelectedIds) ? payload.profitRules.reviewSelectedIds : []
    };
    vm.logistics = {
      logisticsForm: payload.logistics?.logisticsForm || {},
      logisticsRows: Array.isArray(payload.logistics?.logisticsRows) ? payload.logistics.logisticsRows : [],
      cancellationForm: payload.logistics?.cancellationForm || {},
      cancellationRows: Array.isArray(payload.logistics?.cancellationRows) ? payload.logistics.cancellationRows : [],
      testerForm: payload.logistics?.testerForm || {},
      testerResult: payload.logistics?.testerResult || null
    };
    vm.summaries = {
      shops: Array.isArray(payload.summaries?.shops) ? payload.summaries.shops : [],
      people: Array.isArray(payload.summaries?.people) ? payload.summaries.people : [],
      rates: Array.isArray(payload.summaries?.rates) ? payload.summaries.rates : []
    };
  }

  return {
    vm,
    activeTabLabel,
    patch,
    setTab: (tab) => changeConfigTab(tab),
    openCreateShop,
    openCreatePerson,
    openCreateRate,
    openChangePassword,
    editShop,
    deleteShop,
    editPerson,
    disablePerson,
    hardDeletePerson,
    calculateFormula,
    syncProfitFinance,
    recalculateHistoricalProfit,
    cleanupDeliveredReturnLoss,
    refreshHistoricalProfitReview,
    toggleHistoricalProfitSelectionAll,
    toggleHistoricalProfitSelection,
    runHistoricalProfitAction,
    openHistoricalProfitOrder,
    saveLogisticsRule,
    resetLogisticsRule,
    editLogisticsRule,
    deleteLogisticsRule,
    saveCancellationRule,
    resetCancellationRule,
    editCancellationRule,
    deleteCancellationRule,
    testCancellationRule,
    resetCancellationTester
  };
}
