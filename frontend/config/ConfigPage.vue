<script setup>
import { computed, defineExpose } from "vue";
import ConfigAccountCard from "./components/ConfigAccountCard.vue";
import ConfigFormulaCalculator from "./components/ConfigFormulaCalculator.vue";
import ConfigLogisticsRules from "./components/ConfigLogisticsRules.vue";
import ConfigPeopleTable from "./components/ConfigPeopleTable.vue";
import ConfigProfitRules from "./components/ConfigProfitRules.vue";
import ConfigRatesTable from "./components/ConfigRatesTable.vue";
import ConfigShopsTable from "./components/ConfigShopsTable.vue";
import ConfigSummaryBadges from "./components/ConfigSummaryBadges.vue";
import ConfigTabs from "./components/ConfigTabs.vue";
import { useConfigPage } from "./composables/useConfigPage.js";
import "./config-view.css";

const {
  vm,
  patch,
  setTab,
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
} = useConfigPage();

function update(payload = {}) {
  patch(payload);
}

defineExpose({ update });

const isShops = computed(() => vm.activeTab === "shops");
const isPeople = computed(() => vm.activeTab === "people");
const isRates = computed(() => vm.activeTab === "rates");
const isFormula = computed(() => vm.activeTab === "formula");
const isProfitRules = computed(() => vm.activeTab === "profitRules");
const isLogistics = computed(() => vm.activeTab === "logistics");
</script>

<template>
  <section class="vue-config-shell">
    <ConfigTabs :tabs="vm.tabs" :active-tab="vm.activeTab" @change="setTab" />

    <section class="vue-config-panel">
      <template v-if="isShops">
        <ConfigSummaryBadges :items="vm.summaries.shops" />
        <ConfigShopsTable :rows="vm.shops" @create="openCreateShop" @edit="editShop" @delete="deleteShop" />
      </template>

      <template v-else-if="isPeople">
        <ConfigSummaryBadges :items="vm.summaries.people" />
        <ConfigAccountCard :account="vm.account" @change-password="openChangePassword" />
        <ConfigPeopleTable
          :rows="vm.people"
          @create="openCreatePerson"
          @edit="editPerson"
          @disable="disablePerson"
          @delete="hardDeletePerson"
        />
      </template>

      <template v-else-if="isRates">
        <ConfigSummaryBadges :items="vm.summaries.rates" />
        <ConfigRatesTable :rows="vm.rates" @create="openCreateRate" />
      </template>

      <template v-else-if="isProfitRules">
        <ConfigProfitRules
          :metrics="vm.profitRules.metrics"
          :steps="vm.profitRules.steps"
          :finance-summary="vm.profitRules.financeSummary"
          :review-summary="vm.profitRules.reviewSummary"
          :review-rows="vm.profitRules.reviewRows"
          :review-selected-ids="vm.profitRules.reviewSelectedIds"
          @sync-finance="syncProfitFinance"
          @recalculate-historical="recalculateHistoricalProfit"
          @cleanup-loss="cleanupDeliveredReturnLoss"
          @refresh-review="refreshHistoricalProfitReview"
          @toggle-review-all="toggleHistoricalProfitSelectionAll"
          @toggle-review-row="toggleHistoricalProfitSelection($event.id, $event.checked)"
          @review-action="runHistoricalProfitAction"
          @open-review-order="openHistoricalProfitOrder"
        />
      </template>

      <template v-else-if="isFormula">
        <ConfigFormulaCalculator :initial-form="vm.formula.form" :result="vm.formula.result" @calculate="calculateFormula" />
      </template>

      <template v-else-if="isLogistics">
        <ConfigLogisticsRules
          :model="vm.logistics"
          @save-logistics="saveLogisticsRule"
          @reset-logistics="resetLogisticsRule"
          @edit-logistics="editLogisticsRule"
          @delete-logistics="deleteLogisticsRule"
          @save-cancellation="saveCancellationRule"
          @reset-cancellation="resetCancellationRule"
          @edit-cancellation="editCancellationRule"
          @delete-cancellation="deleteCancellationRule"
          @test-cancellation="testCancellationRule"
          @reset-tester="resetCancellationTester"
        />
      </template>
    </section>
  </section>
</template>
