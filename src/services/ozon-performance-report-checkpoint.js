import { createHash, randomUUID } from 'node:crypto';
import { withMysqlTransaction } from '../mysql-pool.js';
import { assertAdvertisingShop } from './advertising-tenant-context.js';
import { pendingPerformanceReport } from './ozon-performance-report.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const credentialVersion = shop => digest([String(shop.performance_client_id || '').trim(), String(shop.performance_client_secret || '').trim()]);
const denied = () => Object.assign(new Error('广告报表恢复已停止：店铺授权或广告密钥已变化，请重新检查店铺配置。'), { statusCode: 403 });

// Only a small receipt is stored, never tokens, credentials or report contents.
// The row claim survives process death; network I/O never runs inside a transaction.
export function createPerformanceReportCheckpoints({ shop, authorize = assertAdvertisingShop, transaction = withMysqlTransaction, now = Date.now }) {
  const shopId = Number(shop.id), version = credentialVersion(shop);
  async function scoped(operation) {
    const scope = await authorize(shopId);
    const prefix = `ozon.ad.report:${scope.id}:${shopId}:${version}:`;
    return transaction(async connection => {
      const [rows] = await connection.execute('SELECT tenant_id, status, performance_client_id, performance_client_secret FROM shops WHERE id = ? FOR UPDATE', [shopId]);
      const current = rows[0];
      if (!current || current.status !== 'active' || credentialVersion(current) !== version
        || !(Number(current.tenant_id) === scope.id || (scope.isDefault && current.tenant_id == null))) throw denied();
      return operation(connection, prefix);
    });
  }
  function canonical(payload) {
    const result = { campaigns: [...new Set(payload.campaigns.map(String))].sort(), dateFrom: payload.dateFrom, dateTo: payload.dateTo, groupBy: payload.groupBy };
    if (!result.campaigns.length || result.campaigns.some(id => !/^\d+$/.test(id))
      || !/^\d{4}-\d{2}-\d{2}$/.test(result.dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(result.dateTo)
      || result.dateFrom > result.dateTo || result.groupBy !== 'DATE') throw new Error('广告报表查询范围无效');
    return result;
  }
  async function change(handle, update) {
    return scoped(async (connection, prefix) => {
      if (handle.key !== prefix + digest(canonical(handle.payload))) throw denied();
      const [rows] = await connection.execute('SELECT value_json FROM system_settings WHERE `key` = ? FOR UPDATE', [handle.key]);
      if (!rows[0]) return false;
      const value = JSON.parse(rows[0].value_json);
      if (value.attempt !== handle.attempt) return false;
      const next = update(value);
      if (next === null) await connection.execute('DELETE FROM system_settings WHERE `key` = ?', [handle.key]);
      else await connection.execute('UPDATE system_settings SET value_json = ?, updated_at = UTC_TIMESTAMP() WHERE `key` = ?', [JSON.stringify({ ...next, updated_at: now() }), handle.key]);
      return true;
    });
  }
  return {
    async list() {
      return scoped(async (connection, prefix) => {
        const [rows] = await connection.execute('SELECT `key`, value_json FROM system_settings WHERE `key` LIKE ? ORDER BY updated_at LIMIT 20', [prefix + '%']);
        return rows.map(row => {
          const value = JSON.parse(row.value_json), payload = canonical(value.payload);
          if (row.key !== prefix + digest(payload)) throw new Error('广告报表恢复记录无效');
          return { ...value, key: row.key, payload };
        });
      });
    },
    async claim(payload, endpoint) {
      payload = canonical(payload);
      if (!['/api/client/statistics/json', '/api/client/statistics/products/json'].includes(endpoint)) throw new Error('广告报表接口无效');
      return scoped(async (connection, prefix) => {
        const key = prefix + digest(payload);
        const [rows] = await connection.execute('SELECT value_json FROM system_settings WHERE `key` = ? FOR UPDATE', [key]);
        if (rows[0]) {
          const value = JSON.parse(rows[0].value_json);
          if (!value.uuid || value.next_poll_at > now()) throw pendingPerformanceReport(value);
          return { ...value, key, resumed: true };
        }
        const value = { payload, endpoint, attempt: randomUUID(), state: 'creating', created_at: now(), updated_at: now() };
        await connection.execute('INSERT INTO system_settings (`key`, value_json) VALUES (?, ?)', [key, JSON.stringify(value)]);
        return { ...value, key, resumed: false };
      });
    },
    async save(handle, uuid) {
      if (typeof uuid !== 'string' || !uuid.trim() || uuid.length > 200) throw new Error('广告报表 UUID 无效');
      if (!await change(handle, value => ({ ...value, uuid, state: 'pending' }))) throw pendingPerformanceReport();
    },
    async defer(handle, retryAfterMs = 0) {
      await change(handle, value => ({ ...value, next_poll_at: now() + Math.max(60000, Number(retryAfterMs) || 0) }));
    },
    async rejected(handle) { await change(handle, () => null); },
    async unknown(handle) { await change(handle, value => ({ ...value, state: 'unknown' })); },
    async complete(handle) {
      // Called only after parsing and the daily-row import have succeeded.
      await change(handle, value => value.uuid && value.uuid === handle.uuid ? null : value);
    }
  };
}
