const SERVICE_CLASSES = [
  ["Premium Big", /premium\s+big/i],
  ["Premium Small", /premium\s+small/i],
  ["Extra Small", /extra\s+small/i],
  ["Budget", /budget/i],
  ["Big", /(^|\s)big(\s|$)/i],
  ["Small", /(^|\s)small(\s|$)/i]
];

function parsedPayload(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
}

function rawPosting(posting = {}) {
  if (posting.raw && typeof posting.raw === "object") return posting.raw;
  const payload = parsedPayload(posting.raw_json);
  if (payload.raw && typeof payload.raw === "object") return payload.raw;
  return Object.keys(payload).length ? payload : posting;
}

export function resolveOrderFreightDescriptor(posting = {}) {
  const raw = rawPosting(posting);
  const deliveryMethod = raw.delivery_method || posting.delivery_method || {};
  const analytics = raw.analytics_data || posting.analytics_data || {};
  const text = [
    deliveryMethod.name,
    deliveryMethod.tpl_provider,
    deliveryMethod.warehouse,
    analytics.tpl_provider,
    analytics.warehouse,
    raw.tpl_provider,
    posting.delivery_method_name,
    posting.logistics_channel,
    posting.warehouse_name
  ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  if (!text) return null;

  const carrier = /\bguoo\b/i.test(text) ? "GUOO" : (/\bcel\b/i.test(text) ? "CEL" : "");
  const channel = /\beconomy\b/i.test(text)
    ? "economy"
    : (/\bstandard\b/i.test(text) ? "standard" : (/\bexpress\b/i.test(text) ? "express" : ""));
  const serviceClass = SERVICE_CLASSES.find(([, pattern]) => pattern.test(text))?.[0] || "";
  if (!carrier || !channel || !serviceClass) return null;
  return { carrier, channel, serviceClass, sourceText: text };
}
