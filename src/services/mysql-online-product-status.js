export function isRealOnlineProductSkuMysql(value) {
  const text = String(value || "").trim();
  return Boolean(text && /^\d+$/.test(text));
}

export function isOnlineProductSupplyStateMysql(row = {}) {
  const status = String(row.status || "").toLowerCase();
  const visibility = String(row.visibility || "").toLowerCase();
  return (
    status.includes("ready")
    || status.includes("created")
    || visibility.includes("empty_stock")
    || visibility.includes("ready_to_supply")
    || visibility.includes("to_supply")
  );
}

export function onlineStatusKeyMysql(row = {}) {
  const status = String(row.status || "").toLowerCase();
  const visibility = String(row.visibility || "").toLowerCase();
  const hasStockSnapshot = Number(row.stock_snapshot_count || 0) > 0;
  const isOzonSupplyState = isOnlineProductSupplyStateMysql(row);
  const hasRealSku = isRealOnlineProductSkuMysql(row.ozon_sku);
  const fbsAvailable = Number(row.fbs_available || 0);
  const fbsPresent = Number(row.fbs_present || 0);
  if (Number(row.archived || 0) || status.includes("archive") || visibility.includes("archive")) return "archived";
  if (status.includes("error") || status.includes("fail") || visibility.includes("failed") || visibility.includes("banned")) return "error";
  if (status.includes("moder") || status.includes("edit") || status.includes("validation") || visibility.includes("pending")) return "moderation";
  if (visibility.includes("hidden") || visibility.includes("blocked") || visibility.includes("removed_from_sale") || status.includes("hidden") || status.includes("offline")) return "hidden";
  if (hasRealSku && isOzonSupplyState && hasStockSnapshot && (fbsAvailable > 0 || fbsPresent > 0)) return "selling";
  if (hasRealSku && isOzonSupplyState && hasStockSnapshot && fbsAvailable <= 0) return "zero_stock";
  if (isOzonSupplyState && !hasRealSku) return "other";
  if (status.includes("ready") || status.includes("created") || visibility.includes("ready_to_supply") || visibility.includes("empty_stock")) return "ready";
  if (status.includes("online") || status.includes("active") || status.includes("sell") || visibility.includes("in_sale") || visibility.includes("visible") || visibility.includes("moderated")) return "selling";
  return "other";
}

export function onlineStatusDisplayRankMysql(row = {}) {
  const key = onlineStatusKeyMysql(row);
  if (key === "selling") return 0;
  if (key === "ready") return 1;
  if (key === "moderation") return 2;
  if (key === "error") return 3;
  if (key === "hidden") return 4;
  if (key === "archived") return 5;
  return 6;
}

export function onlineStatusKeySqlMysql(alias = "op", stockAlias = "stock") {
  const status = `LOWER(COALESCE(${alias}.status, ''))`;
  const visibility = `LOWER(COALESCE(${alias}.visibility, ''))`;
  const ozonSku = `COALESCE(${alias}.ozon_sku, '')`;
  const hasRealSku = `(${ozonSku} REGEXP '^[0-9]+$')`;
  const fbsPresent = `COALESCE(${stockAlias}.fbs_present, 0)`;
  const fbsAvailable = `COALESCE(${stockAlias}.fbs_available, 0)`;
  const stockSnapshotCount = `COALESCE(${stockAlias}.stock_snapshot_count, 0)`;
  const supplyState = `(${status} LIKE '%ready%' OR ${status} LIKE '%created%' OR ${visibility} LIKE '%empty_stock%' OR ${visibility} LIKE '%ready_to_supply%' OR ${visibility} LIKE '%to_supply%')`;
  return `
    CASE
      WHEN COALESCE(${alias}.archived, 0) <> 0 OR ${status} LIKE '%archive%' OR ${visibility} LIKE '%archive%' THEN 'archived'
      WHEN ${status} LIKE '%error%' OR ${status} LIKE '%fail%' OR ${visibility} LIKE '%failed%' OR ${visibility} LIKE '%banned%' THEN 'error'
      WHEN ${status} LIKE '%moder%' OR ${status} LIKE '%edit%' OR ${status} LIKE '%validation%' OR ${visibility} LIKE '%pending%' THEN 'moderation'
      WHEN ${visibility} LIKE '%hidden%' OR ${visibility} LIKE '%blocked%' OR ${visibility} LIKE '%removed_from_sale%' OR ${status} LIKE '%hidden%' OR ${status} LIKE '%offline%' THEN 'hidden'
      WHEN ${hasRealSku} AND ${supplyState} AND ${stockSnapshotCount} > 0 AND (${fbsAvailable} > 0 OR ${fbsPresent} > 0) THEN 'selling'
      WHEN ${hasRealSku} AND ${supplyState} AND ${stockSnapshotCount} > 0 AND ${fbsAvailable} <= 0 THEN 'zero_stock'
      WHEN ${supplyState} AND NOT ${hasRealSku} THEN 'other'
      WHEN ${status} LIKE '%ready%' OR ${status} LIKE '%created%' OR ${visibility} LIKE '%ready_to_supply%' OR ${visibility} LIKE '%empty_stock%' THEN 'ready'
      WHEN ${status} LIKE '%online%' OR ${status} LIKE '%active%' OR ${status} LIKE '%sell%' OR ${visibility} LIKE '%in_sale%' OR ${visibility} LIKE '%visible%' OR ${visibility} LIKE '%moderated%' THEN 'selling'
      ELSE 'other'
    END
  `;
}

export function onlineProductMatchesStatusMysql(row = {}, status = "all") {
  const key = onlineStatusKeyMysql(row);
  if (!status || status === "all") return true;
  if (status === "ready_for_sale") return key === "ready" || key === "zero_stock";
  return key === status;
}

export function onlineStatusCountsMysql(rows = []) {
  const counts = { all: rows.length, ready_for_sale: 0, zero_stock: 0, selling: 0, ready: 0, error: 0, moderation: 0, hidden: 0, archived: 0, other: 0 };
  for (const row of rows) {
    const key = onlineStatusKeyMysql(row);
    counts[key] = Number(counts[key] || 0) + 1;
  }
  counts.ready_for_sale = Number(counts.ready || 0) + Number(counts.zero_stock || 0);
  return counts;
}
