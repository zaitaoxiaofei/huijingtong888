export function detectOrderLogisticsCarrier(value = "") {
  const text = String(value || "").toLowerCase();
  if (text.includes("guoo")) return "guoo";
  if (text.includes("cel") || text.includes("hunchun") || text.includes("hch-pd") || text.includes("hch-cr")) return "cel";
  if (text.includes("postal") || text.includes("china post") || text.includes("邮政")) return "postal";
  return "";
}
