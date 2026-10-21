export function openEnterpriseMessage(reference = null) {
  window.dispatchEvent(new CustomEvent("erp:open-private-message", { detail: { reference } }));
}
