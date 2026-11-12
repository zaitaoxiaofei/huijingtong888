import { credentialVersion, createOzonCredentialHealth, healthSettingKey, publicHealth } from './ozon-credential-health.js';
import { resolveInventoryTenantScope, inventoryTenantSql } from './inventory-tenant-scope.js';
import { effectiveTenantMembershipRole } from './tenant-membership-authority.js';
import { broadcastGlobalEvent } from '../server/notifications.js';

async function query(sql, params = []) { return (await import('../mysql-pool.js')).mysqlQuery(sql, params); }
const parse = value => typeof value === 'string' ? JSON.parse(value) : value || {};
const messages = {
  invalid: 'Ozon 店铺密钥已失效，请在企业店铺中更新密钥；订单、库存、商品和财务数据可能未更新。',
  expired: 'Ozon 店铺密钥已到期，请立即更新并补同步中断期间的数据。',
  missing: '店铺缺少 Ozon Client ID 或有效 API Key，请在企业店铺中配置。',
  forbidden: 'Ozon 拒绝授权检查，请核查密钥权限；本次不能确认授权有效。',
  offer_required: 'Ozon 店铺需要在卖家后台接受最新协议，完成后请重新检查授权。',
  check_failed: 'Ozon 授权检查暂未成功，不能据此判定密钥过期；请检查网络及服务后重试。',
  unknown_expiry: 'Ozon 未返回可确认的密钥到期时间，请到卖家后台核查；系统不会推算到期日。'
};

export const ozonCredentialHealth = createOzonCredentialHealth({ repository: {
  async mutate(shop, change) {
    const { withMysqlTransaction } = await import('../mysql-pool.js');
    const scope = await resolveInventoryTenantScope(shop.health_tenant_id);
    const recipients = [];
    const result = await withMysqlTransaction(async connection => {
      const q = async (sql, params = []) => (await connection.execute(sql, params))[0];
      const [current] = await q(`SELECT s.* FROM shops s JOIN tenants t ON t.id = ?
        WHERE s.id = ? AND ${inventoryTenantSql(scope, 's')} AND s.status = 'active'
        AND t.status = 'active' AND t.subscription_status IN ('active','trial')
        AND (t.subscription_expires_at IS NULL OR t.subscription_expires_at > UTC_TIMESTAMP()) FOR UPDATE`, [scope.id, shop.id]);
      if (!current || credentialVersion(current) !== credentialVersion(shop)) return null;
      const key = healthSettingKey(scope.id, shop.id);
      const [row] = await q('SELECT value_json FROM system_settings WHERE `key` = ? FOR UPDATE', [key]);
      const stored = parse(row?.value_json);
      const saved = stored.version === credentialVersion(current) ? stored : { sync: stored.sync || {} };
      const update = change(saved);
      if (!update) return null;
      await q('INSERT INTO system_settings (`key`, value_json, updated_at) VALUES (?, ?, UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), updated_at = UTC_TIMESTAMP()', [key, JSON.stringify(update.value)]);
      const preservedPrefix = update.notice ? `${scope.id}:ozon-key:${shop.id}:${credentialVersion(current)}:${update.notice.stage}:${update.notice.day}:` : 'none:';
      if (update.resolve) await q(`UPDATE system_notifications SET status = 'resolved', resolved_at = UTC_TIMESTAMP()
        WHERE tenant_id = ? AND entity_type = 'ozon_credential' AND entity_id = ? AND status != 'resolved'
        AND notification_type = 'ozon_credential_health' AND dedupe_key NOT LIKE ?`, [scope.id, String(shop.id), `${preservedPrefix}%`]);
      if (update.notice) {
        const people = await q(`SELECT p.id, p.role AS legacy_role, p.roles_json, tm.role AS tenant_role, tm.business_roles_json,
          t.slug AS tenant_slug FROM tenant_members tm JOIN people p ON p.id = tm.person_id AND p.active = 1
          JOIN tenants t ON t.id = tm.tenant_id WHERE tm.tenant_id = ? AND tm.active = 1`, [scope.id]);
        const notice = update.notice;
        const expiryText = notice.expires_at ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(new Date(notice.expires_at)) : '';
        const text = (messages[notice.status] || `Ozon 店铺密钥将在 ${notice.days} 天内到期，请提前在企业店铺更新并重新检查授权。`) + (expiryText ? ` 到期时间：${expiryText}（北京时间）。` : '');
        for (const person of people.filter(p => Number(p.id) === Number(current.user_id) || ['owner','admin'].includes(effectiveTenantMembershipRole(p)))) {
          const dedupe = `${scope.id}:ozon-key:${shop.id}:${credentialVersion(current)}:${notice.stage}:${notice.day}:${person.id}`;
          const write = await q(`INSERT IGNORE INTO system_notifications
            (tenant_id, recipient_person_id, notification_type, title, content, severity, route, entity_type, entity_id, dedupe_key, status, created_at)
            VALUES (?, ?, 'ozon_credential_health', ?, ?, ?, '/tenant-shops', 'ozon_credential', ?, ?, 'unread', UTC_TIMESTAMP())`,
          [scope.id, person.id, `店铺「${current.name}」授权提醒`, text, ['invalid','expired','missing'].includes(notice.status) ? 'error' : 'warning', String(shop.id), dedupe]);
          if (write.affectedRows) recipients.push(person.id);
        }
      }
      return update.result || { saved: true };
    });
    for (const personId of recipients) broadcastGlobalEvent('system-notification', { refresh: true }, { personId, tenantId: scope.id });
    return result;
  }
} });

export async function ozonHealthShops(tenantId, shopId = null) {
  const scope = await resolveInventoryTenantScope(tenantId);
  const rows = await query(`SELECT s.* FROM shops s WHERE ${inventoryTenantSql(scope, 's')} AND s.status = 'active' AND s.platform = 'ozon'${shopId ? ' AND s.id = ?' : ''} ORDER BY s.id`, shopId ? [shopId] : []);
  return rows.map(shop => ({ ...shop, health_tenant_id: scope.id }));
}

export async function readOzonHealth(tenantId) {
  const shops = await ozonHealthShops(tenantId);
  if (!shops.length) return [];
  const keys = shops.map(shop => healthSettingKey(shop.health_tenant_id, shop.id));
  const rows = await query(`SELECT \`key\`, value_json FROM system_settings WHERE \`key\` IN (${keys.map(() => '?').join(',')})`, keys);
  const values = new Map(rows.map(row => [row.key, parse(row.value_json)]));
  return shops.map(shop => publicHealth(shop, values.get(healthSettingKey(shop.health_tenant_id, shop.id))));
}

export async function checkOzonHealth(tenantId, shopId, options = {}) {
  if (!Number.isSafeInteger(Number(shopId)) || Number(shopId) <= 0) throw Object.assign(new Error('请选择有效店铺'), { statusCode: 400 });
  const [shop] = await ozonHealthShops(tenantId, Number(shopId));
  if (!shop) throw Object.assign(new Error('店铺不存在、已停用或不属于当前企业'), { statusCode: 404 });
  await ozonCredentialHealth.check(shop, options);
  return (await readOzonHealth(tenantId)).find(row => row.shop_id === Number(shopId));
}

export async function checkTenantOzonHealth(tenantId) {
  const shops = await ozonHealthShops(tenantId);
  for (const shop of shops) await ozonCredentialHealth.check(shop);
  return { checked: shops.length };
}

export async function recordOzonSyncHealth(shop, tenantId, module, result) {
  // Metadata failure must never turn a successful business write into a retry.
  try { return await ozonCredentialHealth.recordSync({ ...shop, health_tenant_id: tenantId }, module, result); }
  catch { console.error(`Ozon 同步健康记录保存失败：店铺 #${Number(shop.id)}，模块 ${module}`); }
}
