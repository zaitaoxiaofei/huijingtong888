import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
function loadFunction(name, next, globals = {}) {
  const position = source.indexOf(`function ${name}(`);
  const start = source.slice(position - 6, position) === 'async ' ? position - 6 : position;
  const end = source.indexOf(`\n${next}`, start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(`(${source.slice(start, end)})`, globals);
}
const cancel = loadFunction('customerMessageTaskCancellationReasonMysql', 'function customerMessageTaskRecordScenario', {
  customerMessageIsDelivered: row => Boolean(row.delivered_at)
});
const task = { scenario: 'order_promo', scheduled_at: new Date() };
const order = (status, seconds = 60) => ({ status, ordered_at: new Date(Date.now() - seconds * 1000) });

test('promotion reminder only sends for fresh unshipped paid orders after thirty seconds', async () => {
  for (const status of ['awaiting_packaging', 'awaiting_registration', 'awaiting_approve']) {
    assert.equal(await cancel(task, order(status)), '');
  }
  for (const row of [order('cancelled'), order('delivered'), order('awaiting_deliver'), order('awaiting_packaging', 3601), order('awaiting_packaging', 10), { status: 'awaiting_packaging', ordered_at: 'invalid' }]) {
    assert.ok(await cancel(task, row));
  }
});

test('new template preserves order identity and states an additional two to four weeks without guaranteed delivery', () => {
  const templates = loadFunction('defaultCustomerMessageTemplatesMysql', 'function splitCustomerMessageTemplateText')();
  const promo = templates.find(row => row.scenario === 'order_promo');
  assert.equal(promo.enabled, false);
  assert.match(promo.template_text, /{{posting_number}}/);
  assert.match(promo.template_text, /{{product_summary}}/);
  assert.match(promo.template_text, /2–4 недели больше/);
  assert.match(promo.template_translation, /额外延迟 2–4 周/);
  assert.match(promo.template_translation, /愿意等待，无需额外操作/);
  assert.match(promo.template_translation, /发货前/);
  assert.ok(templates.some(row => row.scenario === 'order_created'));
});

test('materialization schedules once per order, excludes historical orders and does not require Push for promotion reminders', async () => {
  const sql = [];
  const materialize = loadFunction('materializeCustomerMessageTasksMysql', 'async function customerMessageTaskCancellationReasonMysql', {
    ensureMysqlCutoverEnabled() {},
    ensureCustomerMessageTablesMysql: async () => {},
    assertCustomerMessageAccess: async () => {},
    cancelIneligibleCustomerMessageTasksMysql: async () => 0,
    customerMessageShopSql: () => 'owned_shop',
    customerMessageTemplateSql: () => 'owned_template',
    mysqlExecute: async statement => { sql.push(statement); return { affectedRows: 1 }; }
  });
  const result = await materialize();
  assert.equal(result.promo, 1);
  const promo = sql.find(statement => statement.includes("'order_promo', 1, 'pending'"));
  assert.match(promo, /INSERT IGNORE/);
  assert.match(promo, /INTERVAL 30 SECOND/);
  assert.match(promo, /o.ordered_at>=cms.promo_automation_enabled_at/);
  assert.match(promo, /cms.automation_person_id IS NOT NULL/);
  assert.match(promo, /owned_shop/);
  assert.match(promo, /owned_template/);
  assert.match(promo, /NOT EXISTS.*customer_message_records/s);
  assert.doesNotMatch(promo, /webhook_last_received_at/);
});

test('an order-specific missing-chat response does not disable every message for the shop', () => {
  const classify = loadFunction('customerChatCapabilityFromError', 'async function updateCustomerChatCapabilityMysql');
  assert.equal(classify({ status: 404, message: 'chat not found' }).permanent, false);
  assert.equal(classify({ status: 401 }).capability, 'credentials_error');
  assert.equal(classify({ status: 403 }).permanent, true);
});

test('saving an enabled template stores the current operator and repairs only missing-authorization failures', async () => {
  const writes = [];
  const save = loadFunction('updateCustomerMessageTemplateMysql', 'export async function deleteCustomerMessageTemplateMysql', {
    ensureMysqlCutoverEnabled() {},
    assertCustomerMessageAccess: async ({ shopId } = {}) => {
      if (shopId && shopId !== 22) throw Object.assign(new Error('foreign shop'), { statusCode: 404 });
      return { scope: { id: 2 }, session: { personId: 7 } };
    },
    ensureCustomerMessageTablesMysql: async () => {},
    defaultCustomerMessageTemplatesMysql: () => [],
    splitCustomerMessageTemplateText: text => ({ template_text: text, template_translation: '' }),
    mysqlExecute: async (sql, values) => { writes.push({ sql, values }); },
    mysqlQuery: async () => [{ shop_id: 22, enabled_scenarios: '[]' }],
    customerMessageTemplateSql: () => 'tenant_id=2',
    customerMessageShopSql: () => 'owned_shop',
    customerMessageSettingsMysql: async () => ({}),
    shopsMysql: async () => [{ id: 22 }],
    parseJsonOrNull: JSON.parse,
    CUSTOMER_MESSAGE_TYPES: new Set(['order_promo']),
    CUSTOMER_MESSAGE_AUTOMATION_ACTIVATION_COLUMNS: { order_promo: 'promo_automation_enabled_at' }
  });
  await assert.rejects(save({ scenario: 'order_promo', template_text: 'Hello', enabled: true, shop_ids: [33] }), { statusCode: 404 });
  assert.equal(writes.length, 0);
  await save({ scenario: 'order_promo', template_text: 'Hello', enabled: true, shop_ids: [22], automation_person_id: 999 });
  const principal = writes.find(row => row.sql.includes('SET automation_person_id='));
  assert.deepEqual(Array.from(principal.values), [7, 22]);
  const recovery = writes.find(row => row.sql.includes("status='retry'"));
  assert.match(recovery.sql, /status='failed' AND person_id IS NULL/);
  assert.match(recovery.sql, /last_error='自动消息未保存运营授权/);
  assert.deepEqual(Array.from(recovery.values), [7, 22, 'order_promo']);
  writes.length = 0;
  await save({ scenario: 'order_promo', template_text: 'Hello', shop_ids: [22] });
  const templateWrite = writes.find(row => row.sql.includes('INSERT INTO customer_message_templates'));
  assert.equal(templateWrite.values[4], 0);
  assert.ok(!writes.some(row => row.sql.includes('SET automation_person_id=')));
  assert.ok(!writes.some(row => row.sql.includes('SET chat_enabled=1')));
  assert.ok(!writes.some(row => row.sql.includes("SET send_mode='auto'")));
});
