import { ref } from "vue";
import { currentApiCacheScope } from "./api.js";

// A legacy URL can request the dialog before the authenticated layout mounts.
// Keep this request in memory and bind it to the current login context.
export const membershipDialogRequest = ref(null);

export function requestMembershipDialog() {
  membershipDialogRequest.value = { scope: currentApiCacheScope() };
}

export function consumeMembershipDialogRequest() {
  const pending = membershipDialogRequest.value;
  membershipDialogRequest.value = null;
  return Boolean(pending && pending.scope === currentApiCacheScope());
}
