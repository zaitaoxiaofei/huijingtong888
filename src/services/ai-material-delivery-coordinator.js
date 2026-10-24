import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { authorizeBusinessTaskSession, assertBusinessTaskPermission } from "./business-task-tenant.js";
import { prepareAiMaterialStages, validatePreparedMaterialStage } from "./ai-material-stage-preparation.js";

const permits = new AsyncLocalStorage();
const digest = value => createHash("sha256").update(value).digest("hex");
const fail = (message, code = "AI_MATERIAL_DELIVERY_PENDING", status = 409) => Object.assign(new Error(message), { code, status, statusCode: status });
const rows = async (connection, sql, values = []) => (await connection.execute(sql, values))[0];
function canonical(value, depth = 0, budget = { fields: 0 }) {
  if (depth > 48 || budget.fields > 20000) throw fail("素材检查点结构过于复杂", "AI_MATERIAL_CHECKPOINT_INVALID");
  if (Array.isArray(value)) { budget.fields += value.length; return value.map(item => canonical(item, depth + 1, budget)); }
  if (value && typeof value === "object" && [null, Object.prototype].includes(Object.getPrototypeOf(value))) {
    const keys = Object.keys(value).sort(); budget.fields += keys.length;
    if (keys.some(key => ["__proto__", "constructor", "prototype"].includes(key))) throw fail("素材检查点包含无效字段", "AI_MATERIAL_CHECKPOINT_INVALID");
    return Object.fromEntries(keys.map(key => [key, canonical(value[key], depth + 1, budget)]));
  }
  if (value === null || ["string", "boolean"].includes(typeof value) || typeof value === "number" && Number.isFinite(value)) return value;
  throw fail("素材检查点必须为明确的 JSON 数据", "AI_MATERIAL_CHECKPOINT_INVALID");
}
function serialize(value) {
  const text = JSON.stringify(canonical(value));
  if (!text || Buffer.byteLength(text) > 2 * 1024 * 1024) throw fail("素材检查点内容无效或过大", "AI_MATERIAL_CHECKPOINT_INVALID");
  // Persist only JSON data. Functions/undefined/NaN must not change a replay.
  if (JSON.stringify(canonical(JSON.parse(text))) !== text) throw fail("素材检查点内容不可稳定保存", "AI_MATERIAL_CHECKPOINT_INVALID");
  return text;
}
const json = value => value == null ? {} : typeof value === "string" ? JSON.parse(value) : value;
function privateTask(parent, sequence, purpose, inputSha256) {
  const hex = digest(`${parent.id}:${sequence}:${purpose}`);
  return { id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`,
    tenant_id: Number(parent.tenant_id), input_sha256: inputSha256 };
}

// Only this server coordinator can install the context. An adapter must call
// this again after its own queue and before every POST/poll; no HTTP parameter
// or a caller's claimed wallet ID grants a provider capability.
export async function assertAiMaterialDeliveryPermit({ stage, parentTaskId } = {}) {
  const permit = permits.getStore();
  if (!permit || stage && stage !== permit.stage || parentTaskId && parentTaskId !== permit.parentTaskId) {
    throw fail("素材供应商请求缺少当前交付任务授权", "AI_MATERIAL_PROVIDER_FORBIDDEN", 403);
  }
  await permit.check();
  return { stage: permit.stage, parentTaskId: permit.parentTaskId, tenantId: permit.tenantId, actorId: permit.actorId };
}

// Isolated main_only orchestration. Not registered in legacy workers or HTTP
// routes. All injected loaders/adapters are trusted server configuration.
export function createAiMaterialDeliveryCoordinator({ transaction, ledger, resultStore, loadDraft, resolveProvider,
  verifyImage, priceKey = "material.main_only", leaseMs = 120000, maxCandidates = 2, maxStageAttempts = 2 }) {
  if (![transaction, loadDraft, resolveProvider, verifyImage].every(value => typeof value === "function")
    || !ledger || !resultStore?.recover || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 900000
    || !Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 3
    || !Number.isSafeInteger(maxStageAttempts) || maxStageAttempts < 1 || maxStageAttempts > 3) throw new Error("Invalid material delivery dependencies");

  return async function execute(session, itemId) {
    if (!Number.isSafeInteger(Number(itemId)) || Number(itemId) <= 0) throw fail("素材记录编号无效", "AI_MATERIAL_DELIVERY_INVALID", 400);
    const leaseToken = randomUUID();
    let parent, financialAttempt, prepared, current, workflow;

    async function locked(connection, { requireLease = true, checkSource = true, checkWallet = false, authorize = true } = {}) {
      // Wallet writers use tenant -> member/task locks. Keep the same order;
      // never hold a SQL transaction over an upstream request.
      const [tenant] = await rows(connection, "SELECT id,slug FROM tenants WHERE id = ? FOR UPDATE", [Number(session?.tenant?.id)]);
      if (!tenant || tenant.slug !== session?.tenant?.slug) throw fail("素材企业上下文无效", "TENANT_TASK_ACCESS_DENIED", 403);
      const key = tenant.slug === "default" ? "admin" : String(tenant.id);
      const [item] = await rows(connection, `SELECT i.*, b.created_by_person_id AS batch_actor
        FROM ai_material_optimization_items i JOIN ai_material_optimization_batches b ON b.tenant_id=i.tenant_id AND b.batch_no=i.batch_no
        WHERE i.id=? AND i.tenant_id=? FOR UPDATE`, [Number(itemId), key]);
      if (!item || Number(item.created_by_person_id) !== Number(session.personId) || Number(item.batch_actor) !== Number(session.personId)) {
        throw fail("素材记录不属于当前企业和原操作人", "AI_MATERIAL_DELIVERY_NOT_FOUND", 404);
      }
      if (authorize) {
        const authorized = await authorizeBusinessTaskSession(session, (sql, values) => rows(connection, `${sql.trim()} FOR SHARE`, values));
        assertBusinessTaskPermission(authorized, "operations");
      }
      const checkpoint = json(item.checkpoint_json);
      const saved = checkpoint.final_delivery_v1;
      if (saved && (saved.version !== "material-final-v1" || !Array.isArray(saved.attempts)
        || !Number.isSafeInteger(saved.sequence) || saved.sequence < 0)) throw fail("素材交付检查点格式无效", "AI_MATERIAL_CHECKPOINT_INVALID");
      const [clock] = await rows(connection, "SELECT UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS clock_ms");
      const now = Number(clock.clock_ms);
      if (requireLease && (saved?.lease?.token !== leaseToken || Number(saved.lease.until) <= now)) throw fail("素材任务执行权已变更，请查询原任务", "AI_MATERIAL_LEASE_LOST");
      if (requireLease && current && (item.status !== "running" || Number(item.attempts) !== current.businessAttempt
        || item.result_draft_id != null)) throw fail("素材任务已暂停、取消或由其他流程接管", "AI_MATERIAL_BUSINESS_STOPPED");
      let source;
      if (checkSource) {
        const [owned] = await rows(connection, "SELECT * FROM listing_drafts WHERE id=? AND COALESCE(tenant_id,'admin')=? AND status<>'deleted' FOR SHARE", [item.source_draft_id, key]);
        if (!owned) throw fail("来源草稿已删除或企业归属已变更", "AI_MATERIAL_SOURCE_CHANGED");
        source = await loadDraft(connection, owned);
        const definition = prepareAiMaterialStages(item, { draft: source, operatorFacts: json(item.operator_facts_json) });
        // A mutable URL is not a content snapshot. The trusted loader supplies
        // verified file digests or immutable object-store versions, never a hash
        // guessed from a filename. It must not fetch remote media under locks.
        const identities = source.effective_image_identities;
        if (!Array.isArray(identities) || identities.length !== source.effective_images.length || identities.some((identity, index) =>
          !identity || identity.url !== source.effective_images[index]
          || !/^[a-f0-9]{64}$/.test(identity.contentSha256 || "") && !(typeof identity.immutableVersion === "string"
            && identity.immutableVersion.length > 0 && identity.immutableVersion.length <= 256 && !/[\x00-\x1f]/.test(identity.immutableVersion)))) {
          throw fail("来源图片尚未保存可核验的内容摘要或不可变版本，请先完成素材快照", "AI_MATERIAL_SOURCE_UNFROZEN");
        }
        const descriptor = { ...definition, inputSha256: digest(serialize({ definitionSha256: definition.inputSha256, media: identities })) };
        if (item.optimization_scope !== "main_only") throw fail("积分素材当前仅支持最终主图交付", "AI_CREDIT_CAPABILITY_DISABLED");
        if (saved && (saved.inputSha256 !== descriptor.inputSha256 || saved.deliveryKey !== descriptor.deliveryKey)) throw fail("来源草稿已变更，请先核对原交付任务", "AI_MATERIAL_SOURCE_CHANGED");
        if (prepared && prepared.inputSha256 !== descriptor.inputSha256) throw fail("来源草稿已变更", "AI_MATERIAL_SOURCE_CHANGED");
        prepared = descriptor;
      }
      if (checkWallet) {
        const [task] = await rows(connection, `SELECT t.*,a.status AS account_status FROM ai_credit_tasks t
          JOIN ai_credit_accounts a ON a.tenant_id=t.tenant_id WHERE t.id=? AND t.tenant_id=? FOR SHARE`, [parent.id, tenant.id]);
        if (!task || Number(task.created_by_person_id) !== Number(session.personId) || task.input_sha256 !== prepared.inputSha256
          || Number(task.requested_results) !== 1 || task.price_key !== priceKey || task.account_status !== "active"
          || !["running", "unknown"].includes(task.status) || saved?.taskId !== task.id) throw fail("原积分交付任务已不可执行", "AI_MATERIAL_PARENT_BLOCKED");
      }
      return { item, checkpoint, saved, now, source, connection };
    }
    async function update(callback, options) {
      return transaction(async connection => {
        const state = await locked(connection, options);
        const value = await callback(state);
        if (state.saved) {
          if (state.saved.lease?.token === leaseToken && options?.requireLease !== false) state.saved.lease.until = state.now + leaseMs;
          state.checkpoint.final_delivery_v1 = state.saved;
          await rows(connection, "UPDATE ai_material_optimization_items SET checkpoint_json=? WHERE id=? AND tenant_id=?", [serialize(state.checkpoint), Number(itemId), state.item.tenant_id]);
          workflow = state.saved;
        }
        return value;
      });
    }
    const assertCurrent = () => update(() => {}, { checkWallet: true });
    const pending = () => fail("素材交付尚待核对，积分继续预占；请恢复原任务，不要重复创建");
    const stageTask = attempt => privateTask(parent, attempt.sequence, "result", attempt.inputSha256);
    async function saveReceipt(attempt, receipt) {
      if (typeof receipt !== "string" || !receipt.trim() || receipt.length > 250 || /[\x00-\x1f]/.test(receipt)) throw fail("供应商回执无效", "AI_MATERIAL_RECEIPT_INVALID");
      // An immutable fact may arrive after revocation or lease expiry. Preserve
      // it under the original attempt only; it grants no further provider call.
      await update(state => {
        const saved = state.saved?.attempts.find(value => value.sequence === attempt.sequence);
        if (state.saved?.taskId !== parent.id || !saved || saved.bindingId !== attempt.bindingId || saved.inputSha256 !== attempt.inputSha256
          || saved.receipt && saved.receipt !== receipt) throw fail("供应商回执与原尝试不一致", "AI_MATERIAL_RECEIPT_INVALID");
        saved.receipt = receipt;
      }, { requireLease: false, checkSource: false, authorize: false });
    }
    async function saveCost(attempt, { micros, currency }) {
      if (!Number.isSafeInteger(micros) || micros < 0 || micros > 1_000_000_000_000 || !/^[A-Z]{3}$/.test(currency || "")) throw fail("供应商实际成本无效", "AI_MATERIAL_COST_INVALID");
      await update(state => {
        const saved = state.saved?.attempts.find(value => value.sequence === attempt.sequence);
        if (state.saved?.taskId !== parent.id || !saved || saved.bindingId !== attempt.bindingId || saved.inputSha256 !== attempt.inputSha256
          || saved.cost && (saved.cost.micros !== micros || saved.cost.currency !== currency)) throw fail("供应商成本与原尝试不一致", "AI_MATERIAL_COST_INVALID");
        saved.cost = { micros, currency };
      }, { requireLease: false, checkSource: false, authorize: false });
    }
    function supplierCosts() {
      const totals = {};
      for (const attempt of workflow.attempts) if (attempt.cost) {
        totals[attempt.cost.currency] = (totals[attempt.cost.currency] || 0) + attempt.cost.micros;
        if (!Number.isSafeInteger(totals[attempt.cost.currency]) || totals[attempt.cost.currency] > 1_000_000_000_000) throw fail("供应商累计成本需要核对", "AI_MATERIAL_COST_INVALID");
      }
      const currencies = Object.keys(totals);
      // Missing supplier usage is unknown, never a zero-cost request. Keep
      // mixed currencies separate instead of inventing an exchange rate.
      return workflow.attempts.every(attempt => attempt.cost) && currencies.length === 1
        ? { supplierCostMicros: totals[currencies[0]], supplierCurrency: currencies[0] } : {};
    }
    async function markUnknown() {
      await update(state => {
        const active = state.saved.attempts.find(value => value.status === "submitted");
        if (active) active.status = "unknown";
        state.saved.status = "unknown";
      }, { checkSource: false, authorize: false }).catch(() => {});
      // One composite attempt stays held across all internal checkpoints.
      if (parent && financialAttempt) await ledger.recordOutcome(session, parent.id, { attemptId: financialAttempt.id,
        outcome: "unknown", outcomeSha256: digest(`material-pending:${parent.id}`) }).catch(() => {});
    }
    async function requireReconciliation(reason) {
      await update(state => {
        state.saved.status = "unknown"; state.saved.requiresReconciliation = true; state.saved.reconciliationReason = reason;
      }, { checkSource: false, authorize: false });
      throw Object.assign(fail("素材交付与已核定账务结果不一致，需要平台核对；原账未改动，本次不声明退款或交付成功",
        "AI_MATERIAL_RECONCILIATION_REQUIRED"), { creditTaskId: parent.id });
    }
    async function finishFailure(reason) {
      await assertCurrent();
      const settled = await ledger.recordOutcome(session, parent.id, { attemptId: financialAttempt.id, outcome: "failed",
        receipt: financialAttempt.provider_receipt, verifiedReceipt: true, outcomeSha256: digest(`material-failed:${parent.id}:${reason}`), ...supplierCosts() });
      if (settled.status !== "failed" || settled.billing_conflict) return requireReconciliation("failure-outcome-conflicts-with-wallet");
      await update(state => { state.saved.status = "failed"; state.saved.failure = reason; }, { checkSource: false });
      throw Object.assign(fail("未交付有效主图，已释放本次预占积分", "AI_CREDIT_TASK_FAILED", 502), { creditTaskId: settled.id });
    }
    async function verify(stage, result, attempt, recovered = false) {
      if (stage === "main") {
        const before = serialize(result);
        const accepted = await verifyImage(result, { task: stageTask(attempt), parentTask: parent });
        if (recovered && serialize(accepted) !== before) throw fail("已保存图片验证不得改写原内容", "AI_MATERIAL_RESULT_INVALID");
        return accepted;
      }
      if (!validatePreparedMaterialStage(prepared, stage, result).accepted) throw fail("供应商阶段结果未通过原始结构校验", "AI_MATERIAL_RESULT_INVALID");
      return result;
    }
    async function readStage(attempt) {
      const result = await resultStore.read(attempt.resultReference, attempt.resultSha256, stageTask(attempt));
      return verify(attempt.stage, result, attempt, true);
    }
    async function verifyFinal(result) {
      const main = workflow.attempts.find(value => value.sequence === result?.mainAttempt?.sequence && value.stage === "main" && value.status === "succeeded");
      const review = workflow.attempts.find(value => value.stage === "review-main" && value.candidate === result?.candidate && value.status === "succeeded");
      if (result?.deliverable !== "main_only" || result.sourceSha256 !== prepared.inputSha256 || !main || !review
        || main.candidate !== result.candidate || serialize(result.mainImage) !== serialize(await readStage(main))
        || result.review !== await readStage(review) || !JSON.parse(result.review).pass) throw fail("最终主图交付与原检查点不一致", "AI_MATERIAL_RESULT_INVALID");
    }
    async function settleFinal(result, saved) {
      await verifyFinal(result);
      await assertCurrent();
      const task = await ledger.recordOutcome(session, parent.id, { attemptId: financialAttempt.id, outcome: "succeeded", successfulResults: 1,
        receipt: financialAttempt.provider_receipt, verifiedStoredResult: true, resultReference: saved.reference, resultSha256: saved.sha256,
        outcomeSha256: saved.sha256, ...supplierCosts() });
      if (task.status !== "succeeded" || task.billing_conflict) return requireReconciliation("success-outcome-conflicts-with-wallet");
      await update(state => { state.saved.status = "succeeded"; state.saved.finalReference = saved.reference; state.saved.finalSha256 = saved.sha256; });
      return { task, result };
    }
    async function runStage(stage, candidate, payload) {
      let attempt = workflow.attempts.filter(value => value.stage === stage && value.candidate === candidate).at(-1);
      if (attempt?.status === "succeeded") return readStage(attempt);
      const used = workflow.attempts.filter(value => value.stage === stage && value.candidate === candidate).length;
      if (attempt?.status === "failed" && used >= maxStageAttempts) return finishFailure(`stage:${stage}`);
      const adapter = await resolveProvider(stage, attempt && attempt.status !== "failed" ? { bindingId: attempt.bindingId, model: attempt.model } : null);
      if (!adapter || !/^[A-Za-z0-9_.:/-]{1,80}$/.test(adapter.bindingId || "") || typeof adapter.model !== "string" || !adapter.model || adapter.model.length > 160
        || typeof adapter.submit !== "function") throw pending();
      if (attempt && attempt.status !== "failed" && (adapter.bindingId !== attempt.bindingId || adapter.model !== attempt.model)) throw pending();
      if (!attempt || attempt.status === "failed") {
        const input = serialize(payload), inputSha256 = digest(input);
        attempt = await update(async state => {
          const sequence = Number(state.saved.sequence || 0) + 1;
          const inputTask = privateTask(parent, sequence, "input", inputSha256);
          const savedInput = await resultStore.write(inputTask, JSON.parse(input));
          const next = { sequence, stage, candidate, status: "submitted", bindingId: adapter.bindingId, model: adapter.model, inputSha256, cost: null,
            inputTaskId: inputTask.id, inputReference: savedInput.reference, inputResultSha256: savedInput.sha256 };
          state.saved.sequence = sequence; state.saved.attempts.push(next); state.saved.status = "running";
          return next;
        }, { checkWallet: true });
      }
      const originalInput = await resultStore.read(attempt.inputReference, attempt.inputResultSha256,
        { id: attempt.inputTaskId, tenant_id: parent.tenant_id, input_sha256: attempt.inputSha256 });
      if (digest(serialize(originalInput)) !== attempt.inputSha256) throw fail("阶段输入与原摘要不一致", "AI_MATERIAL_CHECKPOINT_INVALID");
      const stored = await resultStore.recover(stageTask(attempt));
      const completionTask = privateTask(parent, attempt.sequence, "completion", attempt.inputSha256);
      let completion = await resultStore.recover(completionTask), result, definitelyCompleted = false;
      if (stored) result = await verify(stage, stored.result, attempt, true);
      else if (completion) {
        if (completion.result?.protocol !== "material-stage-completion-v1" || completion.result.bindingId !== attempt.bindingId
          || completion.result.model !== attempt.model || completion.result.receipt && completion.result.receipt !== attempt.receipt) {
          throw fail("阶段完成证明不属于原尝试", "AI_MATERIAL_RESULT_INVALID");
        }
        result = completion.result.result; definitelyCompleted = true;
      } else {
        const context = { stage, candidate, task: stageTask(attempt), parentTask: parent,
          onReceipt: receipt => saveReceipt(attempt, receipt), onCost: cost => saveCost(attempt, cost), assertAuthorized: assertAiMaterialDeliveryPermit };
        const permit = { stage, parentTaskId: parent.id, tenantId: Number(parent.tenant_id), actorId: Number(session.personId), check: async () => {
          await assertCurrent();
          const active = workflow.attempts.find(value => value.sequence === attempt.sequence);
          if (!active || !["submitted", "unknown"].includes(active.status) || active.stage !== stage || active.bindingId !== adapter.bindingId) throw pending();
        } };
        try {
          result = await permits.run(permit, async () => {
            await assertAiMaterialDeliveryPermit();
            if (attempt.receipt) {
              if (typeof adapter.query !== "function") throw pending();
              const checked = await adapter.query(attempt.receipt, context);
              if (checked?.status === "failed") throw Object.assign(new Error("Explicit supplier failure"), { definiteFailure: true });
              if (checked?.status !== "succeeded") throw pending();
              definitelyCompleted = true;
              return checked.result;
            }
            // A submitted marker from a previous execution has no receipt:
            // acceptance is unknown. Never issue its POST again.
            if (attempt.sequence <= Number(current.sequenceAtClaim || 0)) throw pending();
            const submitted = await adapter.submit(originalInput, context);
            if (submitted?.status === "succeeded" && Object.hasOwn(submitted, "result")) {
              definitelyCompleted = true;
              return submitted.result;
            }
            return submitted;
          });
        } catch (error) {
          if (error?.definiteFailure !== true) throw error;
          await update(state => { const saved = state.saved.attempts.find(value => value.sequence === attempt.sequence); saved.status = "failed"; }, { checkSource: false });
          return runStage(stage, candidate, payload);
        }
      }
      if (!stored) {
        if (definitelyCompleted && !completion) {
          const original = workflow.attempts.find(value => value.sequence === attempt.sequence);
          completion = await resultStore.write(completionTask, { protocol: "material-stage-completion-v1", bindingId: attempt.bindingId,
            model: attempt.model, receipt: original.receipt || null, result });
        }
        try { result = await verify(stage, result, attempt); }
        catch (error) {
          // A trusted adapter's explicit terminal success proves a completed
          // text call, even if its raw JSON is unusable. Preserve that reply;
          // the platform bears internal retries. Transport errors, unreadable
          // media and storage failures are not inferred terminal failures.
          if (!definitelyCompleted || stage === "main" || error.code !== "AI_MATERIAL_RESULT_INVALID") throw error;
          await update(state => {
            const saved = state.saved.attempts.find(value => value.sequence === attempt.sequence);
            saved.status = "failed"; saved.failureKind = "completed-invalid-structure";
            saved.completionTaskId = completionTask.id; saved.completionReference = completion.reference; saved.completionSha256 = completion.sha256;
          }, { checkWallet: true });
          return runStage(stage, candidate, payload);
        }
      }
      // Store before checkpoint; an interrupted SQL write is recovered from
      // this immutable private file, never by issuing another supplier POST.
      const saved = stored || await resultStore.write(stageTask(attempt), result);
      await update(state => {
        const completed = state.saved.attempts.find(value => value.sequence === attempt.sequence);
        completed.status = "succeeded"; completed.resultReference = saved.reference; completed.resultSha256 = saved.sha256;
        state.saved.status = "running";
      }, { checkWallet: true });
      return result;
    }

    try {
      current = await update(state => {
        if (state.item.result_draft_id != null || !state.saved && state.item.status !== "queued"
          || state.saved && (state.item.status !== "running" || Number(state.item.attempts) !== state.saved.businessAttempt)) {
          throw fail("素材记录已停止或由其他流程处理，请先核对原任务", "AI_MATERIAL_BUSINESS_STOPPED");
        }
        if (state.saved?.lease?.token && state.saved.lease.until > state.now) throw fail("同一素材交付正在执行，请稍后查询", "AI_MATERIAL_DELIVERY_BUSY");
        if (state.saved && (state.saved.policy?.maxCandidates !== maxCandidates || state.saved.policy?.maxStageAttempts !== maxStageAttempts)) {
          throw fail("原交付任务的候选或重试策略已变化，请恢复原策略后核对", "AI_MATERIAL_POLICY_CHANGED");
        }
        if (!state.saved && Object.keys(state.checkpoint).length) throw fail("旧任务检查点需要单独审阅，不能自动转入积分交付", "AI_MATERIAL_LEGACY_CHECKPOINT");
        state.saved ||= { version: "material-final-v1", deliveryKey: prepared.deliveryKey, inputSha256: prepared.inputSha256,
          status: "prepared", sequence: 0, candidate: 1, attempts: [], policy: { maxCandidates, maxStageAttempts } };
        state.saved.lease = { token: leaseToken, until: state.now + leaseMs };
        state.saved.businessAttempt = Number(state.item.attempts) + 1;
        return rows(state.connection, "UPDATE ai_material_optimization_items SET status='running',attempts=? WHERE id=? AND tenant_id=?",
          [state.saved.businessAttempt, Number(itemId), state.item.tenant_id]).then(() => ({ source: state.source,
          sequenceAtClaim: state.saved.sequence, item: state.item, businessAttempt: state.saved.businessAttempt }));
      }, { requireLease: false });
      parent = await ledger.reserve(session, { idempotencyKey: `material:${digest(prepared.deliveryKey)}`, inputSha256: prepared.inputSha256, priceKey, results: 1 });
      await update(state => {
        if (state.saved.taskId && state.saved.taskId !== parent.id) throw fail("素材检查点的积分任务不一致", "AI_MATERIAL_PARENT_BLOCKED");
        state.saved.taskId = parent.id;
      });
      if (workflow.requiresReconciliation === true) return await requireReconciliation(workflow.reconciliationReason || "reviewed-wallet-conflict");
      if (parent.status === "failed") {
        await update(state => { state.saved.status = "failed"; state.saved.failure ||= "recovered-wallet-failure"; });
        throw fail("原素材任务已终结，请核对后创建新任务", "AI_CREDIT_TASK_FAILED");
      }
      if (parent.status === "succeeded") {
        let result;
        try {
          result = await resultStore.read(parent.result_reference, parent.result_sha256, parent);
          await verifyFinal(result);
        } catch {
          // A platform-reviewed successful bill may refer to an externally
          // verified result rather than this coordinator's final package. Keep
          // that bill intact; never fabricate a local delivery from it.
          return await requireReconciliation("settled-success-has-no-verified-local-delivery");
        }
        // Money may have committed before the final business checkpoint.
        // Repair the latter from the immutable, reverified delivery; never bill
        // or submit again merely because its post-settlement SQL failed.
        await update(state => { state.saved.status = "succeeded"; state.saved.finalReference = parent.result_reference; state.saved.finalSha256 = parent.result_sha256; });
        return { task: parent, result };
      }
      financialAttempt = await ledger.latestAttempt(session, parent.id);
      if (!financialAttempt) financialAttempt = await ledger.startAttempt(session, parent.id,
        { attemptKey: "material-final-v1", provider: "material-coordinator-v1", model: "main_only-v1" });
      else if (financialAttempt.provider !== "material-coordinator-v1" || financialAttempt.model !== "main_only-v1") throw pending();
      const workflowReceipt = `material-item:${itemId}:${prepared.inputSha256}`;
      await ledger.recordReceipt(session, parent.id, { attemptId: financialAttempt.id, receipt: workflowReceipt });
      financialAttempt.provider_receipt = workflowReceipt;
      const savedFinal = await resultStore.recover(parent);
      if (savedFinal) return await settleFinal(savedFinal.result, savedFinal);
      const source = { draftId: prepared.sourceDraftId, images: current.source.effective_images, operatorFacts: json(current.item.operator_facts_json),
        mediaIdentities: current.source.effective_image_identities, title: current.source.product_name || "", sourceSha256: prepared.inputSha256 };
      const analysis = await runStage("analysis", 0, { source });
      const plan = await runStage("plan", 0, { source, analysis });
      for (let candidate = Number(workflow.candidate || 1); candidate <= maxCandidates; candidate++) {
        const prior = workflow.attempts.filter(value => value.stage === "review-main" && value.status === "succeeded" && value.candidate === candidate - 1).at(-1);
        const correction = prior ? JSON.parse(await readStage(prior)).corrections_en : "";
        const mainImage = await runStage("main", candidate, { source, analysis, plan, correction, candidate });
        const review = await runStage("review-main", candidate, { source, analysis, plan, mainImage, candidate });
        if (!JSON.parse(review).pass) {
          if (candidate === maxCandidates) return await finishFailure("review-rejected");
          await update(state => { state.saved.candidate = candidate + 1; }, { checkWallet: true });
          continue;
        }
        const mainAttempt = workflow.attempts.filter(value => value.stage === "main" && value.candidate === candidate && value.status === "succeeded").at(-1);
        const result = { deliverable: "main_only", sourceSha256: prepared.inputSha256, mainImage, mainAttempt, review, candidate };
        await assertCurrent();
        const saved = await resultStore.write(parent, result);
        return await settleFinal(result, saved);
      }
      throw pending();
    } catch (error) {
      if (parent && financialAttempt && error.code !== "AI_CREDIT_TASK_FAILED") await markUnknown();
      throw error;
    } finally {
      // Fencing prevents a late worker from clearing its successor's lease.
      await update(state => {
        if (state.saved?.lease?.token !== leaseToken) throw fail("素材执行权已变更", "AI_MATERIAL_LEASE_LOST");
        state.saved.lease = null;
      }, { requireLease: false, checkSource: false, authorize: false }).catch(() => {});
    }
  };
}
