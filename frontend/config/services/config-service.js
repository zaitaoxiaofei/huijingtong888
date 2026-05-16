export function configBridge() {
  return window.OzonConfigVueBridge || {};
}

export function bridgeCall(name, ...args) {
  return configBridge()?.[name]?.(...args);
}

export async function changeConfigTab(tab) {
  return bridgeCall("setTab", tab);
}

export async function openCreateShop() {
  return bridgeCall("openCreateShop");
}

export async function openCreatePerson() {
  return bridgeCall("openCreatePerson");
}

export async function openCreateRate() {
  return bridgeCall("openCreateRate");
}

export async function openChangePassword() {
  return bridgeCall("openChangePassword");
}

export async function editShop(id) {
  return bridgeCall("editShop", id);
}

export async function deleteShop(id) {
  return bridgeCall("deleteShop", id);
}

export async function editPerson(id) {
  return bridgeCall("editPerson", id);
}

export async function disablePerson(id) {
  return bridgeCall("disablePerson", id);
}

export async function hardDeletePerson(id) {
  return bridgeCall("hardDeletePerson", id);
}

export async function syncProfitFinance() {
  return bridgeCall("syncProfitFinance");
}

export async function recalculateHistoricalProfit() {
  return bridgeCall("recalculateHistoricalProfit");
}

export async function cleanupDeliveredReturnLoss() {
  return bridgeCall("cleanupDeliveredReturnLoss");
}

export async function calculateFormula(payload) {
  return bridgeCall("calculateFormula", payload);
}

export async function refreshHistoricalProfitReview() {
  return bridgeCall("refreshHistoricalProfitReview");
}

export async function toggleHistoricalProfitSelectionAll(checked) {
  return bridgeCall("toggleHistoricalProfitSelectionAll", checked);
}

export async function toggleHistoricalProfitSelection(id, checked) {
  return bridgeCall("toggleHistoricalProfitSelection", id, checked);
}

export async function runHistoricalProfitAction(action) {
  return bridgeCall("runHistoricalProfitAction", action);
}

export async function openHistoricalProfitOrder(orderId) {
  return bridgeCall("openHistoricalProfitOrder", orderId);
}

export async function saveLogisticsRule(payload) {
  return bridgeCall("saveLogisticsRule", payload);
}

export async function resetLogisticsRule() {
  return bridgeCall("resetLogisticsRule");
}

export async function editLogisticsRule(id) {
  return bridgeCall("editLogisticsRule", id);
}

export async function deleteLogisticsRule(id) {
  return bridgeCall("deleteLogisticsRule", id);
}

export async function saveCancellationRule(payload) {
  return bridgeCall("saveCancellationRule", payload);
}

export async function resetCancellationRule() {
  return bridgeCall("resetCancellationRule");
}

export async function editCancellationRule(id) {
  return bridgeCall("editCancellationRule", id);
}

export async function deleteCancellationRule(id) {
  return bridgeCall("deleteCancellationRule", id);
}

export async function testCancellationRule(payload) {
  return bridgeCall("testCancellationRule", payload);
}

export async function resetCancellationTester() {
  return bridgeCall("resetCancellationTester");
}
