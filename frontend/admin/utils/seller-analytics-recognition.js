export function isSellerAnalyticsValidationReady(validation, expectedStoreId) {
  return validation?.ok === true && validation.plugin_online === true
    && String(validation.current_company_id || "") === String(expectedStoreId || "")
    && Boolean(expectedStoreId);
}

export function isSellerAnalyticsStoreMismatch(validation, request, expectedStoreId) {
  if (["store_identity_unverified", "missing_plugin_company"].includes(validation?.code)) return false;
  if (validation?.code === "company_mismatch") return true;
  const currentStoreId = String(request?.current_company_id || validation?.current_company_id || "");
  return request?.status === "mismatch" && Boolean(currentStoreId)
    && Boolean(expectedStoreId) && currentStoreId !== String(expectedStoreId);
}

export async function waitForSellerAnalyticsPreparation({
  requestId,
  expectedStoreId,
  readValidation,
  wait,
  now = Date.now,
  timeoutMs = 120000,
  pollMs = 3000,
  isCurrent = () => true,
  onValidation = () => {}
}) {
  const expectedRequestId = String(requestId || "");
  if (!expectedRequestId) throw new Error("店铺识别请求没有返回编号，请重试");
  const deadline = now() + timeoutMs;
  let validation = null;
  while (now() < deadline) {
    if (!isCurrent()) return { status: "cancelled", validation };
    validation = await readValidation();
    const request = validation?.prepare_request;
    if (request?.id && String(request.id) !== expectedRequestId) {
      return { status: "superseded", validation, request };
    }
    if (String(request?.id || "") === expectedRequestId) {
      onValidation(validation);
      if (request.status === "mismatch" || request.status === "failed") {
        return { status: request.status, validation, request };
      }
      if (request.status === "ready" && isSellerAnalyticsValidationReady(validation, expectedStoreId)) {
        return { status: "ready", validation, request };
      }
    }
    await wait(Math.min(pollMs, Math.max(0, deadline - now())));
  }
  return { status: "timeout", validation, request: validation?.prepare_request };
}
