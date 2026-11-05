import { listingTenantLookup } from "./listing-tenant-scope.js";

async function queryCollectorBrowserMysql(sql, params) {
  const { mysqlQuery } = await import("../mysql-pool.js");
  return mysqlQuery(sql, params);
}

function denied() {
  return Object.assign(new Error("当前 Seller 店铺不属于有效的插件企业，请切换到本企业的有效店铺后重试"), {
    status: 403,
    statusCode: 403,
    code: "COLLECTOR_BROWSER_SHOP_FORBIDDEN"
  });
}

// tenantKey comes from the verified plugin principal, never a request selector.
export async function resolveCollectorBrowserShop(companyId, tenantKey = "admin", query = queryCollectorBrowserMysql) {
  const company = typeof companyId === "string" || typeof companyId === "number" ? String(companyId).trim() : "";
  const key = typeof tenantKey === "string" || typeof tenantKey === "number" ? String(tenantKey).trim() : "";
  if (!company || company.length > 128 || !key) throw denied();
  let lookup;
  try {
    lookup = listingTenantLookup(key);
  } catch {
    throw denied();
  }
  // Numeric shop ownership is authoritative. Only the resolved default tenant
  // retains the reviewed legacy NULL ownership used by existing shop workflows.
  // Resolve and check both rows in one read so ownership changes are never cached.
  const shops = await query(`SELECT s.id AS shop_id, s.name AS shop_name, s.ozon_client_id AS company_id
    FROM tenants t JOIN shops s
      ON (s.tenant_id = t.id OR (BINARY t.slug = BINARY 'default' AND s.tenant_id IS NULL))
    WHERE ${lookup.column === "slug" ? "BINARY t.slug = BINARY ?" : "t.id = ?"}
      AND t.status = 'active' AND t.subscription_status IN ('active', 'trial')
      AND (t.subscription_expires_at IS NULL OR t.subscription_expires_at > UTC_TIMESTAMP())
      AND s.status = 'active' AND BINARY s.ozon_client_id = BINARY ?
    ORDER BY s.id ASC LIMIT 1`, [lookup.value, company]);
  const shop = shops[0];
  const shopId = Number(shop?.shop_id);
  if (!Number.isSafeInteger(shopId) || shopId <= 0 || String(shop.company_id || "").trim() !== company) throw denied();
  return { shop_id: shopId, shop_name: String(shop.shop_name || ""), company_id: company };
}
