import { detectOrderLogisticsCarrier } from "./order-logistics-carrier.js";

const METHOD_FIELDS = ["id", "name", "warehouse", "warehouse_id", "tpl_provider", "tpl_provider_id", "provider_id"];
const ANALYTICS_FIELDS = ["warehouse", "warehouse_id", "tpl_provider", "tpl_provider_id", "provider_id"];
const RAW_FIELDS = ["warehouse_name", "tpl_provider", "tpl_provider_id", "provider_id"];

function rawPosting(posting = {}) {
  return posting.raw && typeof posting.raw === "object" ? posting.raw : posting;
}

function hasValue(value) {
  return typeof value === "string" ? Boolean(value.trim()) : typeof value === "number" && Number.isFinite(value);
}

function firstValue(...values) {
  return values.find(hasValue);
}

export function hasMeaningfulPostingMethod(posting = {}) {
  const name = rawPosting(posting).delivery_method?.name;
  return typeof name === "string" && Boolean(name.trim()) && !/^(?:fbp\s*)+$/i.test(name.trim());
}

export function isFbpPosting(posting = {}) {
  const raw = rawPosting(posting);
  return [posting.fulfillment_schema, posting.fulfillment_type_key, posting.logistics_fulfillment_type, raw.fulfillment_schema]
    .some((value) => String(value || "").trim().toUpperCase() === "FBP")
    || /\bfbp\b/i.test(String(raw.delivery_method?.name || ""));
}

function providerId(raw = {}) {
  return firstValue(raw.delivery_method?.tpl_provider_id, raw.delivery_method?.provider_id,
    raw.tpl_provider_id, raw.provider_id, raw.analytics_data?.tpl_provider_id, raw.analytics_data?.provider_id);
}

function changed(previous, incoming) {
  return hasValue(previous) && hasValue(incoming) && String(previous).trim().toLowerCase() !== String(incoming).trim().toLowerCase();
}

function logisticsIdentityChanged(previous, incoming) {
  return changed(providerId(previous), providerId(incoming))
    || changed(previous.delivery_method?.id, incoming.delivery_method?.id)
    || changed(previous.delivery_method?.warehouse_id, incoming.delivery_method?.warehouse_id)
    || changed(detectOrderLogisticsCarrier(previous.delivery_method?.name), detectOrderLogisticsCarrier(incoming.delivery_method?.name))
    || changed(firstValue(previous.delivery_method?.tpl_provider, previous.tpl_provider, previous.analytics_data?.tpl_provider),
      firstValue(incoming.delivery_method?.tpl_provider, incoming.tpl_provider, incoming.analytics_data?.tpl_provider));
}

function fillMissing(previous = {}, incoming = {}, fields, genericMethodName = false) {
  previous ||= {};
  incoming ||= {};
  const result = { ...incoming };
  for (const field of fields) {
    const missing = !hasValue(result[field]) || (genericMethodName && field === "name" && /^(?:fbp\s*)+$/i.test(String(result[field]).trim()));
    const usefulPrevious = hasValue(previous[field]) && !(genericMethodName && field === "name" && /^(?:fbp\s*)+$/i.test(String(previous[field]).trim()));
    if (missing && usefulPrevious) result[field] = previous[field];
  }
  return result;
}

// The caller must already scope both snapshots to the same shop and posting.
// Status, products, financial data and cancellation always belong to incoming.
export function mergeOrderPostingLogistics(previousPosting = {}, incomingPosting = {}) {
  if (!isFbpPosting(previousPosting) && !isFbpPosting(incomingPosting)) return incomingPosting;
  const previous = rawPosting(previousPosting);
  const incoming = rawPosting(incomingPosting);
  const mayInherit = !logisticsIdentityChanged(previous, incoming);
  const raw = mayInherit ? fillMissing(previous, incoming, RAW_FIELDS) : { ...incoming };
  if (mayInherit) {
    const method = fillMissing(previous.delivery_method, incoming.delivery_method, METHOD_FIELDS, true);
    const analytics = fillMissing(previous.analytics_data, incoming.analytics_data, ANALYTICS_FIELDS);
    if (Object.keys(method).length) raw.delivery_method = method;
    if (Object.keys(analytics).length) raw.analytics_data = analytics;
  }
  raw.fulfillment_schema = "FBP";
  const result = { ...incomingPosting, fulfillment_schema: "FBP", raw };
  const sparseFbp = isFbpPosting(incomingPosting) && !hasMeaningfulPostingMethod(incomingPosting);
  for (const field of ["tracking_number", "external_tracking_url"]) {
    const mayInheritTracking = mayInherit && sparseFbp && !Object.hasOwn(incoming, field);
    const value = firstValue(incomingPosting[field], incoming[field],
      ...(mayInheritTracking ? [previousPosting[field], previous[field]] : []));
    if (value !== undefined) {
      result[field] = value;
      raw[field] = value;
    }
  }
  return result;
}
