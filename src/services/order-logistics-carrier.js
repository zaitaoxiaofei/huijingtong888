export function detectOrderLogisticsCarrier(value = "") {
  const text = String(value || "").toLowerCase();
  if (/(^|[^a-z0-9])ogl(?=$|[^a-z0-9])/.test(text)) return "ogl";
  if (/(^|[^a-z0-9])guoo(?=$|[^a-z0-9])/.test(text)) return "guoo";
  if (/(^|[^a-z0-9])(?:cel|hunchun|hch-pd|hch-cr)(?=$|[^a-z0-9])/.test(text)) return "cel";
  if (/(^|[^a-z0-9])(?:postal|china post)(?=$|[^a-z0-9])/.test(text) || text.includes("邮政")) return "postal";
  return "";
}
