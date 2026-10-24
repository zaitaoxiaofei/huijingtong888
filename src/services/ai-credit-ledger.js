import { randomUUID } from "node:crypto";
import { authorizeBusinessTaskSession, assertBusinessTaskPermission } from "./business-task-tenant.js";

const MAX_POINTS = 1_000_000_000_000;
const FINAL = new Set(["succeeded", "failed"]);
const error = (message, code = "AI_CREDIT_CONFLICT", status = 409) => Object.assign(new Error(message), { code, status, statusCode: status });
function integer(value, name, { min = 0, max = MAX_POINTS } = {}) {
  if (!(typeof value === "number" || typeof value === "string" && /^\d+$/.test(value))) throw error(`${name}必须为整数`, "AI_CREDIT_INVALID", 400);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw error(`${name}超出允许范围`, "AI_CREDIT_INVALID", 400);
  return result;
}
function token(value, name, max = 128) {
  if (typeof value !== "string" || !new RegExp(`^[A-Za-z0-9_.:/-]{1,${max}}$`).test(value)) throw error(`${name}无效`, "AI_CREDIT_INVALID", 400);
  return value;
}
function text(value, name, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) throw error(`${name}无效`, "AI_CREDIT_INVALID", 400);
  return value.trim();
}
function hash(value) {
  if (!/^[a-f0-9]{64}$/.test(String(value || ""))) throw error("内容摘要无效", "AI_CREDIT_INVALID", 400);
  return value;
}
const rows = async (connection, sql, params = []) => (await connection.execute(sql, params))[0];
const taskView = row => ({ ...row, requested_results: Number(row.requested_results), successful_results: Number(row.successful_results),
  points_per_result: Number(row.points_per_result), reserved_points: Number(row.reserved_points), charged_points: Number(row.charged_points) });

// No table creation on the money path. An explicit migration installs the schema.
// This boundary is server-only: browsers cannot report supplier outcomes or settle.
export function createAiCreditLedger({ transaction }) {
  if (typeof transaction !== "function") throw new Error("AI credits require transactional storage");
  async function platform(session, connection) {
    if (session?.platform_role !== "super_admin") throw error("仅平台超级管理员可以管理积分", "AI_CREDIT_FORBIDDEN", 403);
    const found = await rows(connection, `SELECT pg.person_id FROM platform_grants pg
      JOIN people p ON p.id = pg.person_id AND p.active = 1
      WHERE pg.person_id = ? AND pg.role = 'super_admin' AND pg.active = 1 FOR SHARE`, [integer(session.personId, "操作人", { min: 1, max: Number.MAX_SAFE_INTEGER })]);
    if (!found.length) throw error("平台授权已撤销", "AI_CREDIT_FORBIDDEN", 403);
  }
  async function member(session, connection, write = false) {
    const current = await authorizeBusinessTaskSession(session, (sql, params) => rows(connection, `${sql.trim()} FOR SHARE`, params));
    if (write) assertBusinessTaskPermission(current, "operations");
    return current;
  }
  function tenantId(session) { return integer(session?.tenant?.id, "企业", { min: 1, max: Number.MAX_SAFE_INTEGER }); }
  async function lockTenant(connection, id) {
    if (!(await rows(connection, "SELECT id FROM tenants WHERE id = ? FOR UPDATE", [id])).length) throw error("企业不存在", "AI_CREDIT_NOT_FOUND", 404);
  }
  async function account(connection, id, active = false) {
    const found = await rows(connection, "SELECT * FROM ai_credit_accounts WHERE tenant_id = ? FOR UPDATE", [id]);
    if (!found.length || active && found[0].status !== "active") throw error("企业 AI 积分账户尚未开通", "AI_CREDIT_ACCOUNT_DISABLED", 409);
    return found[0];
  }
  async function entry(connection, wallet, { key, taskId = null, kind, availableDelta, frozenDelta, actor, reason }) {
    const available = integer(Number(wallet.available_points) + availableDelta, "可用积分");
    const frozen = integer(Number(wallet.frozen_points) + frozenDelta, "冻结积分");
    await rows(connection, `INSERT INTO ai_credit_entries
      (tenant_id, entry_key, task_id, kind, available_delta, frozen_delta, available_after, frozen_after, created_by_person_id, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [wallet.tenant_id, key, taskId, kind, availableDelta, frozenDelta, available, frozen, actor, reason]);
    await rows(connection, "UPDATE ai_credit_accounts SET available_points = ?, frozen_points = ? WHERE tenant_id = ?", [available, frozen, wallet.tenant_id]);
    wallet.available_points = available; wallet.frozen_points = frozen;
  }
  async function ownedTask(connection, session, id) {
    const tenant = tenantId(session);
    await lockTenant(connection, tenant);
    const found = await rows(connection, "SELECT * FROM ai_credit_tasks WHERE id = ? AND tenant_id = ? FOR UPDATE", [token(id, "任务", 36), tenant]);
    if (!found.length || Number(found[0].created_by_person_id) !== Number(session.personId)) throw error("任务不存在", "AI_CREDIT_NOT_FOUND", 404);
    return found[0];
  }
  async function settle(connection, task, successfulResults, resultReference, resultHash, actor, reason) {
    if (FINAL.has(task.status)) throw error("任务已经结算");
    const count = integer(successfulResults, "成功结果数", { max: Number(task.requested_results) });
    const charged = integer(count * Number(task.points_per_result), "扣除积分");
    const wallet = await account(connection, task.tenant_id);
    await entry(connection, wallet, { key: `settle:${task.id}`, taskId: task.id, kind: count ? "settle" : "release",
      availableDelta: Number(task.reserved_points) - charged, frozenDelta: -Number(task.reserved_points), actor, reason });
    await rows(connection, `UPDATE ai_credit_tasks SET status = ?, successful_results = ?, charged_points = ?,
      result_reference = ?, result_sha256 = ? WHERE id = ? AND tenant_id = ?`,
    [count ? "succeeded" : "failed", count, charged, resultReference, resultHash, task.id, task.tenant_id]);
    return taskView({ ...task, status: count ? "succeeded" : "failed", successful_results: count, charged_points: charged,
      result_reference: resultReference, result_sha256: resultHash });
  }
  return {
    async configureAccount(session, input) {
      const id = integer(input.tenantId, "企业", { min: 1, max: Number.MAX_SAFE_INTEGER });
      if (!["active", "disabled"].includes(input.status)) throw error("账户状态无效", "AI_CREDIT_INVALID", 400);
      return transaction(async connection => {
        await lockTenant(connection, id); await platform(session, connection);
        await rows(connection, "INSERT INTO ai_credit_accounts (tenant_id, account_key, status) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE status = VALUES(status)", [id, randomUUID(), input.status]);
        // Independent durable opt-in prevents a missing/disabled wallet table
        // from silently turning a paying enterprise back into internal mode.
        await rows(connection, `UPDATE tenants SET feature_flags_json = JSON_SET(COALESCE(feature_flags_json, JSON_OBJECT()),
          '$.ai_credits_opted_in', JSON_EXTRACT('true', '$')) WHERE id = ?`, [id]);
        return account(connection, id);
      });
    },
    async createPrice(session, input) {
      const key = token(input.priceKey, "价格标识", 80), version = integer(input.version, "价格版本", { min: 1, max: 4294967295 });
      const points = integer(input.pointsPerResult, "单个结果积分", { min: 1 });
      return transaction(async connection => {
        await platform(session, connection);
        await rows(connection, `INSERT INTO ai_credit_prices (id, price_key, version, points_per_result, created_by_person_id)
          VALUES (?, ?, ?, ?, ?)`, [randomUUID(), key, version, points, session.personId]);
        return { price_key: key, version, points_per_result: points };
      });
    },
    async recharge(session, input) {
      const id = integer(input.tenantId, "企业", { min: 1, max: Number.MAX_SAFE_INTEGER });
      const points = integer(input.points, "充值积分", { min: 1 });
      const key = `recharge:${token(input.reference, "收款编号")}`, reason = text(input.reason, "充值依据", 500);
      return transaction(async connection => {
        await lockTenant(connection, id); await platform(session, connection);
        const wallet = await account(connection, id);
        const previous = await rows(connection, "SELECT * FROM ai_credit_entries WHERE tenant_id = ? AND entry_key = ?", [id, key]);
        if (previous.length) {
          if (Number(previous[0].available_delta) !== points || previous[0].reason !== reason) throw error("同一收款编号内容不同");
          return { ...wallet, replayed: true };
        }
        await entry(connection, wallet, { key, kind: "recharge", availableDelta: points, frozenDelta: 0, actor: session.personId, reason });
        return { ...wallet, replayed: false };
      });
    },
    async wallet(session) {
      return transaction(async connection => {
        await member(session, connection);
        const found = await rows(connection, "SELECT tenant_id, account_key, status, available_points, frozen_points, updated_at FROM ai_credit_accounts WHERE tenant_id = ?", [tenantId(session)]);
        return found[0] || { tenant_id: tenantId(session), status: "disabled", available_points: 0, frozen_points: 0 };
      });
    },
    async entries(session, { before = Number.MAX_SAFE_INTEGER, limit = 30 } = {}) {
      return transaction(async connection => {
        await member(session, connection);
        const size = integer(limit, "分页大小", { min: 1, max: 100 });
        return rows(connection, `SELECT id, task_id, kind, available_delta, frozen_delta, available_after, frozen_after, reason, created_at
          FROM ai_credit_entries WHERE tenant_id = ? AND id < ? ORDER BY id DESC LIMIT ${size}`, [tenantId(session), integer(before, "分页游标", { min: 1, max: Number.MAX_SAFE_INTEGER })]);
      });
    },
    async reserve(session, input) {
      const key = token(input.idempotencyKey, "任务去重标识"), priceKey = token(input.priceKey, "价格标识", 80);
      const digest = hash(input.inputSha256), quantity = integer(input.results ?? 1, "结果数量", { min: 1, max: 100 });
      return transaction(async connection => {
        const id = tenantId(session); await lockTenant(connection, id); await member(session, connection, true);
        const existing = await rows(connection, "SELECT * FROM ai_credit_tasks WHERE tenant_id = ? AND idempotency_key = ? FOR UPDATE", [id, key]);
        if (existing.length) {
          const task = existing[0];
          if (Number(task.created_by_person_id) !== Number(session.personId) || task.input_sha256 !== digest || task.price_key !== priceKey || Number(task.requested_results) !== quantity) throw error("同一任务标识的内容不同");
          return { ...taskView(task), replayed: true };
        }
        const wallet = await account(connection, id, true);
        const prices = await rows(connection, "SELECT * FROM ai_credit_prices WHERE price_key = ? ORDER BY version DESC LIMIT 1 FOR SHARE", [priceKey]);
        if (!prices.length) throw error("该 AI 能力尚未设置积分价格", "AI_CREDIT_PRICE_UNAVAILABLE", 409);
        const price = prices[0], required = integer(Number(price.points_per_result) * quantity, "预占积分");
        if (Number(wallet.available_points) < required) throw error("AI 积分不足，请联系企业负责人充值", "AI_CREDIT_INSUFFICIENT", 402);
        const taskId = randomUUID();
        await rows(connection, `INSERT INTO ai_credit_tasks (id, tenant_id, created_by_person_id, idempotency_key, input_sha256,
          price_id, price_key, price_version, points_per_result, requested_results, reserved_points) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [taskId, id, session.personId, key, digest, price.id, priceKey, price.version, price.points_per_result, quantity, required]);
        await entry(connection, wallet, { key: `reserve:${taskId}`, taskId, kind: "reserve", availableDelta: -required, frozenDelta: required,
          actor: session.personId, reason: `${priceKey} v${price.version}` });
        const [task] = await rows(connection, "SELECT * FROM ai_credit_tasks WHERE id = ?", [taskId]);
        return { ...taskView(task), replayed: false };
      });
    },
    async startAttempt(session, taskId, input) {
      const key = token(input.attemptKey, "尝试标识"), provider = text(input.provider, "服务商", 80), model = text(input.model, "模型", 160);
      return transaction(async connection => {
        const task = await ownedTask(connection, session, taskId); await member(session, connection, true);
        await account(connection, task.tenant_id, true);
        const previous = await rows(connection, "SELECT * FROM ai_credit_attempts WHERE task_id = ? AND attempt_key = ?", [task.id, key]);
        if (previous.length) {
          if (previous[0].provider !== provider || previous[0].model !== model) throw error("同一尝试标识的服务商不同");
          return { ...previous[0], should_submit: false };
        }
        if (task.status !== "reserved") throw error("任务正在执行、已结算或结果待核对，不能重新提交", "AI_CREDIT_SUBMISSION_BLOCKED");
        const id = randomUUID();
        const [sequence] = await rows(connection, "SELECT COALESCE(MAX(attempt_number),0) AS last_attempt FROM ai_credit_attempts WHERE task_id = ?", [task.id]);
        const attemptNumber = Number(sequence.last_attempt) + 1;
        // Commit this marker before making the network call. A restart must query
        // the original receipt or require reconciliation, never blindly resubmit.
        await rows(connection, "INSERT INTO ai_credit_attempts (id, task_id, attempt_key, attempt_number, provider, model) VALUES (?, ?, ?, ?, ?, ?)", [id, task.id, key, attemptNumber, provider, model]);
        await rows(connection, "UPDATE ai_credit_tasks SET status = 'running' WHERE id = ? AND tenant_id = ?", [task.id, task.tenant_id]);
        return { id, task_id: task.id, attempt_number: attemptNumber, status: "submitted", should_submit: true };
      });
    },
    async recordOutcome(session, taskId, input) {
      if (!["succeeded", "failed", "unknown"].includes(input.outcome)) throw error("结果状态无效", "AI_CREDIT_INVALID", 400);
      const attemptId = token(input.attemptId, "尝试", 36), outcomeHash = hash(input.outcomeSha256);
      const receipt = input.receipt ? text(input.receipt, "供应商回执", 250) : null;
      const resultReference = input.resultReference ? text(input.resultReference, "结果引用", 500) : null;
      const resultHash = input.resultSha256 ? hash(input.resultSha256) : null;
      const cost = input.supplierCostMicros == null ? null : integer(input.supplierCostMicros, "供应商成本");
      const currency = input.supplierCurrency == null ? null : String(input.supplierCurrency);
      if (currency !== null && !/^[A-Z]{3}$/.test(currency) || (cost === null) !== (currency === null)) throw error("供应商成本币种无效", "AI_CREDIT_INVALID", 400);
      if (input.outcome === "succeeded" && (!resultReference || !resultHash)) throw error("成功结果缺少引用和摘要", "AI_CREDIT_INVALID", 400);
      if (input.outcome === "succeeded") integer(input.successfulResults, "核实成功结果数", { min: 1, max: 100 });
      return transaction(async connection => {
        const task = await ownedTask(connection, session, taskId);
        const [attempt] = await rows(connection, "SELECT * FROM ai_credit_attempts WHERE id = ? AND task_id = ? FOR UPDATE", [attemptId, task.id]);
        if (!attempt) throw error("尝试不存在", "AI_CREDIT_NOT_FOUND", 404);
        if (receipt && attempt.provider_receipt && receipt !== attempt.provider_receipt) throw error("供应商回执与已保存值不同");
        // Only the server executor may attest a durable, independently checked
        // local result. No HTTP route accepts either recovery attestation.
        const verifiedLocal = input.verifiedStoredResult === true && input.outcome === "succeeded"
          && resultReference === `credit-result:${task.id}` && resultHash === outcomeHash;
        const verifiedRecovery = attempt.status === "unknown" && (verifiedLocal || input.verifiedReceipt === true && receipt && receipt === attempt.provider_receipt);
        if (attempt.status !== "submitted" && !verifiedRecovery) {
          if (attempt.status !== input.outcome || attempt.outcome_sha256 !== outcomeHash) throw error("供应商结果已记录，需核对原回执");
          if (input.outcome === "succeeded" && (Number(task.successful_results) !== Number(input.successfulResults)
            || task.result_reference !== resultReference || task.result_sha256 !== resultHash)) throw error("重复结果的结算内容不同");
          return { ...taskView(task), replayed: true };
        }
        if (input.outcome === "succeeded") integer(input.successfulResults, "核实成功结果数", { min: 1, max: Number(task.requested_results) });
        const finalized = FINAL.has(task.status);
        const billingConflict = finalized && (task.status !== input.outcome || input.outcome === "succeeded" && (
          Number(task.successful_results) !== Number(input.successfulResults) || task.result_sha256 !== resultHash));
        await rows(connection, `UPDATE ai_credit_attempts SET status = ?, provider_receipt = ?, outcome_sha256 = ?,
          supplier_cost_micros = ?, supplier_currency = ?, billing_conflict = ? WHERE id = ? AND task_id = ?`,
        [input.outcome, receipt || attempt.provider_receipt, outcomeHash, cost, currency, billingConflict ? 1 : 0, attempt.id, task.id]);
        if (finalized) return { ...taskView(task), late_result_recorded: true, billing_conflict: Boolean(billingConflict) };
        if (input.outcome === "unknown") {
          await rows(connection, "UPDATE ai_credit_tasks SET status = 'unknown' WHERE id = ? AND tenant_id = ?", [task.id, task.tenant_id]);
          return taskView({ ...task, status: "unknown" });
        }
        if (input.outcome === "failed" && input.retryable === true) {
          await rows(connection, "UPDATE ai_credit_tasks SET status = 'reserved' WHERE id = ? AND tenant_id = ?", [task.id, task.tenant_id]);
          return taskView({ ...task, status: "reserved" });
        }
        // Recording an already-submitted result is allowed after membership
        // revocation: it settles an existing fact, never authorizes a new call.
        return settle(connection, task, input.outcome === "succeeded" ? input.successfulResults : 0,
          resultReference, resultHash, session.personId, "供应商确定结果结算");
      });
    },
    async recordReceipt(session, taskId, input) {
      const attemptId = token(input.attemptId, "尝试", 36), receipt = text(input.receipt, "供应商回执", 250);
      return transaction(async connection => {
        const task = await ownedTask(connection, session, taskId);
        const [attempt] = await rows(connection, "SELECT * FROM ai_credit_attempts WHERE id = ? AND task_id = ? FOR UPDATE", [attemptId, task.id]);
        if (!attempt) throw error("尝试不存在", "AI_CREDIT_NOT_FOUND", 404);
        if (attempt.provider_receipt && attempt.provider_receipt !== receipt) throw error("供应商回执已保存，不能替换");
        if (!attempt.provider_receipt && attempt.status !== "submitted") throw error("尝试已终结，不能新增回执");
        if (!attempt.provider_receipt) await rows(connection, "UPDATE ai_credit_attempts SET provider_receipt = ? WHERE id = ? AND task_id = ?", [receipt, attempt.id, task.id]);
        return { task_id: task.id, attempt_id: attempt.id, receipt };
      });
    },
    async releaseUnsubmitted(session, taskId) {
      return transaction(async connection => {
        const task = await ownedTask(connection, session, taskId);
        if (task.status === "failed") return taskView(task);
        if (task.status !== "reserved") throw error("已提交或结果未知，不能直接释放积分");
        return settle(connection, task, 0, null, null, session.personId, "尚未提交或明确失败后取消");
      });
    },
    async reconcile(session, input) {
      const id = integer(input.tenantId, "企业", { min: 1, max: Number.MAX_SAFE_INTEGER });
      const taskId = token(input.taskId, "任务", 36), reason = text(input.reason, "核对依据", 500);
      return transaction(async connection => {
        await lockTenant(connection, id); await platform(session, connection);
        const [task] = await rows(connection, "SELECT * FROM ai_credit_tasks WHERE id = ? AND tenant_id = ? FOR UPDATE", [taskId, id]);
        if (!task) throw error("任务不存在", "AI_CREDIT_NOT_FOUND", 404);
        if (!["unknown", "running"].includes(task.status)) throw error("仅待核对或中断任务可人工结算");
        const count = integer(input.successfulResults, "核实成功数", { max: Number(task.requested_results) });
        return settle(connection, task, count, count ? text(input.resultReference, "结果引用", 500) : null,
          count ? hash(input.resultSha256) : null, session.personId, reason);
      });
    },
    async task(session, id) {
      return transaction(async connection => {
        await member(session, connection);
        const [task] = await rows(connection, "SELECT * FROM ai_credit_tasks WHERE id = ? AND tenant_id = ?", [token(id, "任务", 36), tenantId(session)]);
        if (!task) throw error("任务不存在", "AI_CREDIT_NOT_FOUND", 404);
        return taskView(task);
      });
    },
    async latestAttempt(session, id) {
      return transaction(async connection => {
        const task = await ownedTask(connection, session, id); await member(session, connection, true);
        const [attempt] = await rows(connection, "SELECT * FROM ai_credit_attempts WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1", [task.id]);
        return attempt || null;
      });
    },
    async audit(session) {
      return transaction(async connection => {
        await member(session, connection);
        // Lock the wallet so one audit cannot mix pre/post settlement snapshots.
        const wallet = await account(connection, tenantId(session));
        const [sum] = await rows(connection, `SELECT COALESCE(SUM(available_delta), 0) AS available_points,
          COALESCE(SUM(frozen_delta), 0) AS frozen_points FROM ai_credit_entries WHERE tenant_id = ?`, [tenantId(session)]);
        return { tenant_id: tenantId(session), consistent: Number(wallet.available_points) === Number(sum.available_points)
          && Number(wallet.frozen_points) === Number(sum.frozen_points), available_points: Number(wallet.available_points), frozen_points: Number(wallet.frozen_points) };
      });
    }
  };
}
