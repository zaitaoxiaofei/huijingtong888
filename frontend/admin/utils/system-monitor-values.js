export function monitorNumber(value) {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "string" && !value.trim()) return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function monitorBytesText(value) {
  const bytes = monitorNumber(value);
  if (bytes === null) return "未采集";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0, amount = Math.abs(bytes);
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
  return `${bytes < 0 ? "-" : ""}${amount.toFixed(index >= 3 ? 2 : 1)} ${units[index]}`;
}

export function monitorGrowthText(value) {
  const bytes = monitorNumber(value);
  if (bytes === null) return "未采集";
  if (!bytes) return "无明显增长";
  return `${bytes > 0 ? "+" : ""}${monitorBytesText(bytes)}`;
}

export function monitorDiskShareText(value, total) {
  const bytes = monitorNumber(value), capacity = monitorNumber(total);
  if (bytes === null || capacity === null || capacity <= 0) return "未采集";
  return `${(bytes / capacity * 100).toFixed(1)}%`;
}
