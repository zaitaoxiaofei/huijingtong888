import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const clientSource = readFileSync(new URL("../src/ozonClient.js", import.meta.url), "utf8");
const serviceSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const runtimeSource = readFileSync(new URL("../src/services/mysql-runtime-services.js", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const routeSource = readFileSync(new URL("../src/server/routes/operations.js", import.meta.url), "utf8");
const viewSource = readFileSync(new URL("../frontend/admin/views/orders/CustomerMessagesView.vue", import.meta.url), "utf8");
const settingsViewSource = readFileSync(new URL("../frontend/admin/views/settings/SettingsView.vue", import.meta.url), "utf8");

test("customer chat client starts an order chat and sends through documented Ozon endpoints", () => {
  assert.match(clientSource, /export async function startOzonCustomerChat/);
  assert.match(clientSource, /"\/v1\/chat\/start"/);
  assert.match(clientSource, /export async function sendOzonCustomerChatMessage/);
  assert.match(clientSource, /"\/v1\/chat\/send\/message"/);
});

test("automatic customer messages are opt-in and gated by verified chat capability", () => {
  assert.match(serviceSource, /chat_enabled TINYINT\(1\) NOT NULL DEFAULT 0/);
  assert.match(serviceSource, /chat_capability VARCHAR\(32\) NOT NULL DEFAULT 'unchecked'/);
  assert.match(serviceSource, /cms\.chat_enabled = 1 AND cms\.send_mode = 'auto' AND cms\.chat_capability = 'available'/);
  assert.match(serviceSource, /OZON_CUSTOMER_MESSAGE_SEND_ENABLED !== "1"/);
  assert.match(routeSource, /customer-message-settings\/shop\/check-capability/);
  assert.match(runtimeSource, /checkCustomerMessageShopCapability/);
});

test("three priority messages use durable idempotent delayed tasks", () => {
  assert.match(serviceSource, /reminder_step INT NOT NULL DEFAULT 1/);
  assert.match(serviceSource, /UNIQUE KEY uniq_customer_message_task \(shop_id, order_id, scenario, reminder_step\)/);
  assert.match(serviceSource, /trigger_condition VARCHAR\(64\) NOT NULL DEFAULT ''/);
  assert.match(serviceSource, /delay_hours INT NOT NULL DEFAULT 1/);
  assert.match(serviceSource, /SELECT 1 AS reminder_step UNION ALL SELECT 2 UNION ALL SELECT 3/);
  assert.match(serviceSource, /CASE schedule\.reminder_step WHEN 1 THEN cmt\.delay_hours WHEN 2 THEN 24 ELSE 72 END\) HOUR/);
  assert.match(serviceSource, /pickup_automation_enabled_at DATETIME NULL/);
  assert.match(serviceSource, /review_automation_enabled_at DATETIME NULL/);
  assert.match(serviceSource, /passport_automation_enabled_at DATETIME NULL/);
  assert.match(serviceSource, /COALESCE\(o\.last_status_changed_at, o\.ordered_at\) >= cms\.pickup_automation_enabled_at/);
  assert.match(serviceSource, /review_automation_enabled_at IS NOT NULL/);
  assert.match(serviceSource, /passport_automation_enabled_at IS NOT NULL/);
  assert.match(serviceSource, /const pickupAutomationEnabledAt = activationTimestamp\("pickup_notice"\)/);
  assert.match(serviceSource, /pickup_automation_enabled_at = VALUES\(pickup_automation_enabled_at\)/);
  assert.match(serviceSource, /scenario IN \('pickup_notice','review_request','passport_reminder'\)/);
  assert.match(serviceSource, /customerMessageTaskCancellationReasonMysql/);
  assert.match(serviceSource, /attempts >= 5/);
  assert.match(serviceSource, /status='sending'.*status IN \('pending','retry'\)/s);
});

test("automatic sending revalidates Ozon status and records scenarios consistently", () => {
  assert.match(serviceSource, /async function refreshCustomerMessageOrderFromOzonMysql/);
  assert.match(serviceSource, /fetchOzonPostingByNumber\(shop, order\.posting_number, \{ signal: controller\.signal \}\)/);
  assert.match(serviceSource, /order = await refreshCustomerMessageOrderFromOzonMysql\(shop, order\)/);
  assert.match(serviceSource, /function customerMessageTaskRecordScenario/);
  assert.match(serviceSource, /task\.scenario === "pickup_notice"/);
  assert.match(serviceSource, /customerMessageTaskAlreadySentMysql/);
  assert.match(serviceSource, /同一订单的本次消息已经人工或自动发送/);
  assert.match(serviceSource, /OZON_CUSTOMER_MESSAGE_AUTO_BATCH_LIMIT \|\| 10/);
  assert.match(serviceSource, /posting_received\|received/);
  assert.match(serviceSource, /Boolean\(row\.delivered_at\)/);
});

test("three priority templates use safer natural copy and remain opt-in by default", () => {
  assert.match(serviceSource, /Для получения может понадобиться паспорт или код получения/);
  assert.match(serviceSource, /Если вы уже получили этот заказ/);
  assert.match(serviceSource, /другого отправления или подарка нет/);
  assert.match(serviceSource, /Не отправляйте паспортные данные в чате/);
  assert.match(serviceSource, /поделитесь, пожалуйста, впечатлением в отзыве на Ozon/);
  assert.match(serviceSource, /scenario: "pickup_notice"[\s\S]*?enabled: false/);
  assert.match(serviceSource, /scenario: "review_request"[\s\S]*?enabled: false/);
  assert.match(serviceSource, /scenario: "passport_reminder"[\s\S]*?enabled: false/);
});

test("customer message dispatcher scans every ten minutes and UI exposes status", () => {
  assert.match(serverSource, /key: "customer_message_dispatch"[\s\S]*intervalMinutes: 10/);
  assert.match(serverSource, /FOREGROUND_DEFERRAL_BOUNDED_JOBS = new Set\(\[[\s\S]*"customer_message_dispatch"/);
  assert.match(serverSource, /services\.processCustomerMessageTasks\(\{ limit: 30 \}\)/);
  assert.match(serverSource, /const result = await services\.processCustomerMessageTasks[\s\S]*const webhookResult = await services\.processOzonWebhookEvents\(\{ limit: 10 \}\)/);
  assert.match(viewSource, /消息模板/);
  assert.match(viewSource, /发送记录/);
  assert.doesNotMatch(viewSource, /店铺权限/);
  assert.doesNotMatch(settingsViewSource, /shop-customer-message-config/);
  assert.doesNotMatch(settingsViewSource, /pickup_delay_hours/);
  assert.doesNotMatch(settingsViewSource, /review_delay_hours/);
  assert.match(viewSource, /trigger_condition/);
  assert.match(viewSource, /delay_hours/);
  assert.match(viewSource, /row\.scheduled_at/);
  assert.match(viewSource, /row\.last_error/);
});

test("legacy activation timestamps written as Beijing wall time are repaired to UTC", () => {
  assert.match(serviceSource, /SET \$\{activationColumn\}=DATE_SUB\(\$\{activationColumn\}, INTERVAL 8 HOUR\)/);
  assert.match(serviceSource, /\$\{activationColumn\} > DATE_ADD\(UTC_TIMESTAMP\(\), INTERVAL 5 MINUTE\)/);
});

test("send records combine manual tests and automatic tasks with an explicit send method", () => {
  assert.match(serviceSource, /async function customerMessageSendRecordsMysql/);
  assert.match(serviceSource, /FROM customer_message_manual_tests m/);
  assert.match(serviceSource, /FROM customer_message_records r/);
  assert.match(serviceSource, /NOT EXISTS \(\s*SELECT 1 FROM customer_message_manual_tests manual_match/s);
  assert.match(serviceSource, /NOT EXISTS \(\s*SELECT 1 FROM customer_message_tasks task_match/s);
  assert.match(serviceSource, /'manual' AS send_method/);
  assert.match(serviceSource, /'auto' AS send_method/);
  assert.match(serviceSource, /e\.event_status IN \('pending','sending','retry','sent','failed','cancelled'\)/);
  assert.match(serviceSource, /send_method_label: row\.send_method === "manual" \? "人工" : "自动"/);
  assert.match(viewSource, /view: "send_records"/);
  assert.match(viewSource, /sendMethodFilter/);
  assert.match(viewSource, /row\.send_method_label/);
  assert.match(viewSource, /placeholder="店铺"/);
  assert.doesNotMatch(viewSource, /已接入 Push 的店铺/);
});

test("one public Ozon webhook identifies shops and stores idempotent events", () => {
  assert.match(serverSource, /parts\[1\] === "webhooks" && parts\[2\] === "ozon"/);
  assert.match(serviceSource, /eventType === "TYPE_PING"[\s\S]*version: "1\.0"[\s\S]*name: "Ozon Seller API"[\s\S]*time: new Date\(\)\.toISOString\(\)/);
  assert.match(serviceSource, /CREATE TABLE IF NOT EXISTS ozon_webhook_events/);
  assert.match(serviceSource, /UNIQUE KEY uniq_ozon_webhook_event \(event_key\)/);
  assert.match(serviceSource, /processing_started_at DATETIME NULL/);
  assert.match(serviceSource, /status='processing'[\s\S]*DATE_SUB\(NOW\(\), INTERVAL 15 MINUTE\)/);
  assert.match(serviceSource, /服务中断后自动恢复处理/);
  assert.match(serviceSource, /ozon_seller_id=\?/);
  assert.match(serviceSource, /syncOzonPostingsByNumberMysql/);
  assert.match(serviceSource, /TYPE_POSTING_CANCELLED/);
  assert.match(serviceSource, /function scheduleOzonWebhookDrainMysql\(delayMs = 0\)/);
  assert.match(serviceSource, /processOzonWebhookEventsMysql\(\{ limit: 10 \}\)/);
  assert.match(serviceSource, /reason: "already_processing"/);
  assert.doesNotMatch(serviceSource, /processOzonWebhookEventsMysql\(\{ limit: 1, event_key: eventKey \}\)/);
  assert.doesNotMatch(settingsViewSource, /https:\/\/erp\.hjt888\.xyz\/api\/webhooks\/ozon/);
});

test("template editor inserts variables and assigns each template to selected shops", () => {
  assert.match(viewSource, /insertTemplateVariable/);
  assert.match(viewSource, /shop_ids: \[\]/);
  assert.match(viewSource, /templateDialogVisible/);
  assert.match(viewSource, /shopConfigDialogVisible/);
  assert.match(viewSource, /openShopConfig/);
  assert.match(viewSource, /availableTemplateScenarios/);
  assert.match(viewSource, /passport_reminder/);
  assert.match(viewSource, /shipment_delay/);
  assert.match(viewSource, /visibleAutomationTemplates/);
  assert.match(viewSource, /filteredAutomationTemplates/);
  assert.match(viewSource, /templatePageSize/);
  assert.match(viewSource, /global-pagination-bar/);
  assert.match(viewSource, /\.customer-message-page \{[^}]*height: calc\(100dvh - 96px\)[^}]*overflow: hidden/);
  assert.match(viewSource, /\.customer-message-section \{[^}]*flex: 1 1 auto[^}]*min-height: 0/);
  assert.match(viewSource, /deleteTemplate/);
  assert.match(viewSource, /配置店铺/);
  assert.match(viewSource, /模板安全测试/);
  assert.match(routeSource, /customer-message-settings\/template\/test/);
  assert.match(serviceSource, /status, read_state, message_text\)[\s\S]*'test_draft'/);
  assert.doesNotMatch(viewSource, /人工客服辅助模板/);
  assert.doesNotMatch(viewSource, /同步真实聊天/);
  assert.match(serviceSource, /Array\.isArray\(body\.shop_ids\)/);
  assert.match(serviceSource, /scenarios\.add\(scenario\)/);
  assert.match(serviceSource, /deleteCustomerMessageTemplateMysql/);
  assert.match(serviceSource, /label: "护照资料提醒"/);
  assert.match(serviceSource, /label: "超时发货提醒"/);
  assert.match(serviceSource, /customer_message_templates \(scenario, name, label, enabled/);
  assert.match(serviceSource, /enabled TINYINT\(1\) NOT NULL DEFAULT 0/);
  assert.match(routeSource, /req\.method === "DELETE".*parts\[1\] === "customer-message-settings".*parts\[2\] === "template"/s);
});

test("upcoming customer messages are limited to three safe workflows and push-enabled shops", () => {
  const manualSendSource = serviceSource.slice(
    serviceSource.indexOf("export async function sendCustomerMessageManualTestMysql"),
    serviceSource.indexOf("export async function translateCustomerMessageRuMysql")
  );
  assert.match(serviceSource, /customerMessageUpcomingCandidatesMysql/);
  assert.match(serviceSource, /one_candidate_per_order: true/);
  assert.match(serviceSource, /due_only: false/);
  assert.match(serviceSource, /includes_scheduled: true/);
  assert.doesNotMatch(serviceSource, /SELECT 1 AS reminder_step, 0 AS delay_hours UNION ALL SELECT 2,24 UNION ALL SELECT 3,72/);
  assert.match(serviceSource, /INTERVAL 3 DAY/);
  assert.match(serviceSource, /INTERVAL 1 DAY/);
  assert.match(serviceSource, /cms\.webhook_last_received_at IS NOT NULL/);
  assert.match(serviceSource, /FROM customer_message_tasks t[\s\S]*cmt\.enabled=1 AND cmt\.deleted=0/);
  assert.match(serviceSource, /t\.status IN \('pending','retry'\)/);
  assert.match(serviceSource, /cancelIneligibleCustomerMessageTasksMysql/);
  assert.match(serviceSource, /订单已经签收/);
  assert.match(serviceSource, /签收时间过久，为避免打扰不再发送/);
  assert.match(viewSource, /value: 'upcoming'/);
  assert.match(viewSource, /即将发送/);
  assert.match(serviceSource, /等待计划时间/);
  assert.match(viewSource, /paged-table-shell/);
  assert.match(viewSource, /height="100%"/);
  assert.match(viewSource, /primaryAutomationScenarioKeys/);
  assert.doesNotMatch(viewSource, /<el-option label="超时取货（人工）"/);
  assert.match(viewSource, /manual-test-send/);
  assert.match(routeSource, /customer-messages\/manual-test-send/);
  assert.match(serviceSource, /OZON_CUSTOMER_MESSAGE_MANUAL_TEST_ENABLED !== "1"/);
  assert.match(serviceSource, /UNIQUE KEY uniq_customer_message_manual_candidate \(candidate_key\)/);
  assert.match(serviceSource, /发送前无法从 Ozon 复核订单状态/);
  assert.match(manualSendSource, /refreshCustomerMessageOrderFromOzonMysql\(shop, order\)/);
  assert.doesNotMatch(manualSendSource, /syncOzonPostingsByNumberMysql/);
  assert.match(serviceSource, /Ozon 最新状态显示订单已签收，已阻止发送取货提醒/);
});
