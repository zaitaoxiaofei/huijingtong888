import { ref } from "vue";
import { currentApiCacheScope } from "./api.js";

export const exchangeRateDialogRequest = ref(null);

export function requestExchangeRateDialog() {
  exchangeRateDialogRequest.value = { scope: currentApiCacheScope() };
}

export function consumeExchangeRateDialogRequest() {
  const pending = exchangeRateDialogRequest.value;
  exchangeRateDialogRequest.value = null;
  return Boolean(pending && pending.scope === currentApiCacheScope());
}
