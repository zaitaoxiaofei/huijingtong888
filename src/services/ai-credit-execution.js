import { createHash } from "node:crypto";

const digest = value => createHash("sha256").update(value).digest("hex");
function canonical(value, depth = 0, budget = { fields: 0 }) {
  if (depth > 64 || budget.fields > 20000) throw Object.assign(new Error("AI 请求结构过于复杂"), { status: 400, code: "AI_CREDIT_INPUT_INVALID" });
  if (Array.isArray(value)) { budget.fields += value.length; return value.map(item => canonical(item, depth + 1, budget)); }
  if (value && typeof value === "object" && [null, Object.prototype].includes(Object.getPrototypeOf(value))) {
    const keys = Object.keys(value).sort(); budget.fields += keys.length;
    if (keys.some(key => ["__proto__", "constructor", "prototype"].includes(key))) throw Object.assign(new Error("AI 请求包含无效字段"), { status: 400, code: "AI_CREDIT_INPUT_INVALID" });
    return Object.fromEntries(keys.map(key => [key, canonical(value[key], depth + 1, budget)]));
  }
  if (value === null || ["boolean", "string"].includes(typeof value) || typeof value === "number" && Number.isFinite(value)) return value;
  throw Object.assign(new Error("AI 请求包含不支持的数据"), { status: 400, code: "AI_CREDIT_INPUT_INVALID" });
}
const pending = task => Object.assign(new Error("AI 任务已提交，正在等待结果核对；请查询原任务，不要重新提交"), {
  status: 409, statusCode: 409, code: "AI_CREDIT_RESULT_PENDING", creditTaskId: task.id
});

// A provider adapter owns all actual upstream calls; it must distinguish a
// definite rejection from a timeout/unknown acceptance. Internal retries share
// this single customer quote. Result storage must be private and durable.
export function createAiCreditExecutor({ ledger, resultStore, providers, authorize, maxAttempts = 2 }) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new Error("Invalid AI attempt limit");
  return async function execute(session, input) {
    const provider = providers[input.capability];
    if (!provider) throw Object.assign(new Error("尚未开通此 AI 积分能力"), { status: 409, code: "AI_CREDIT_CAPABILITY_DISABLED" });
    const payload = canonical(input.payload);
    const serialized = JSON.stringify({ capability: input.capability, payload });
    if (Buffer.byteLength(serialized) > 20 * 1024 * 1024) throw Object.assign(new Error("AI 请求过大"), { status: 413 });
    await authorize(session);
    const task = await ledger.reserve(session, { idempotencyKey: input.idempotencyKey, inputSha256: digest(serialized),
      priceKey: provider.priceKey, results: 1 });
    if (task.status === "succeeded") {
      await authorize(session);
      return { task, result: await resultStore.read(task.result_reference, task.result_sha256, task) };
    }
    if (task.status === "failed") throw Object.assign(new Error("该 AI 任务已明确失败并释放积分；新任务请使用新的提交编号"), { status: 409, code: "AI_CREDIT_TASK_FAILED", creditTaskId: task.id });
    let recovery = null;
    if (["running", "unknown"].includes(task.status)) {
      recovery = await ledger.latestAttempt(session, task.id);
      if (recovery && ["submitted", "unknown"].includes(recovery.status) && typeof resultStore.recover === "function" && typeof provider.verifySavedResult === "function") {
        const candidate = await resultStore.recover(task);
        if (candidate) {
          await authorize(session);
          const original = JSON.stringify(candidate.result);
          const result = await provider.verifySavedResult(candidate.result, { session, task });
          if (JSON.stringify(result) !== original) throw Object.assign(new Error("AI 保存结果验证不得改写原内容"), { status: 409, code: "AI_CREDIT_RESULT_INVALID" });
          const settled = await ledger.recordOutcome(session, task.id, { attemptId: recovery.id, outcome: "succeeded",
            receipt: recovery.provider_receipt || null, verifiedStoredResult: true, successfulResults: 1,
            resultReference: candidate.reference, resultSha256: candidate.sha256, outcomeSha256: candidate.sha256 });
          await authorize(session);
          return { task: settled, result };
        }
      }
      if (!recovery?.provider_receipt || typeof provider.query !== "function") throw pending(task);
      if (recovery.provider !== provider.name || recovery.model !== provider.model) throw pending(task);
      await authorize(session);
      const checked = await provider.query(recovery.provider_receipt, { session, task });
      if (!checked || checked.status === "pending") throw pending(task);
      if (checked.status === "failed") {
        await ledger.recordOutcome(session, task.id, { attemptId: recovery.id, receipt: recovery.provider_receipt,
          verifiedReceipt: true, outcome: "failed", outcomeSha256: digest("confirmed-failed:" + recovery.provider_receipt) });
        throw Object.assign(new Error("供应商确认任务失败，积分已释放"), { status: 502, code: "AI_CREDIT_TASK_FAILED", creditTaskId: task.id });
      }
      if (checked.status !== "succeeded") throw pending(task);
      return saveAndSettle(checked.result, recovery, true);
    }
    const last = await ledger.latestAttempt(session, task.id);
    if (last?.status === "succeeded") {
      const current = await ledger.task(session, task.id);
      if (current.status !== "succeeded") throw pending(current);
      await authorize(session);
      return { task: current, result: await resultStore.read(current.result_reference, current.result_sha256, current) };
    }
    if (["submitted", "unknown"].includes(last?.status)) throw pending(task);
    if (Number(last?.attempt_number || 0) >= maxAttempts) {
      await ledger.releaseUnsubmitted(session, task.id);
      throw Object.assign(new Error("AI 重试已结束，积分已释放"), { status: 502, code: "AI_CREDIT_TASK_FAILED", creditTaskId: task.id });
    }
    for (let index = Number(last?.attempt_number || 0) + 1; index <= maxAttempts; index += 1) {
      let attempt;
      try {
        // Authorize outside and again inside the wallet transaction, including
        // every retry. A cancellation/revocation cannot authorize the next call.
        await authorize(session);
        attempt = await ledger.startAttempt(session, task.id, { attemptKey: String(index), provider: provider.name, model: provider.model });
      } catch (error) {
        if (error?.code === "AI_CREDIT_SUBMISSION_BLOCKED") throw pending(task);
        if (!attempt) await ledger.releaseUnsubmitted(session, task.id).catch(() => {});
        throw error;
      }
      if (!attempt.should_submit) throw pending(task);
      let result;
      try {
        result = await provider.submit(payload, { session, task, attempt, onReceipt: receipt => ledger.recordReceipt(session, task.id, { attemptId: attempt.id, receipt }) });
      } catch (error) {
        const definite = error?.definiteFailure === true;
        const retryable = definite && error?.retryable === true && index < maxAttempts;
        await ledger.recordOutcome(session, task.id, { attemptId: attempt.id,
          outcome: definite ? "failed" : "unknown", retryable, outcomeSha256: digest(`failure:${attempt.id}:${String(error?.code || "unknown")}`) });
        if (retryable) continue;
        if (!definite) throw pending(task);
        throw Object.assign(new Error("AI 生成失败，积分已释放"), { status: 502, code: "AI_CREDIT_TASK_FAILED", creditTaskId: task.id });
      }
      return saveAndSettle(result, attempt, false);
    }
    async function saveAndSettle(result, attempt, verifiedReceipt) {
      // A storage/settlement failure deliberately leaves the submitted marker:
      // no refund, blind retry, or success response without a durable result.
      const saved = await resultStore.write(task, result);
      const settled = await ledger.recordOutcome(session, task.id, { attemptId: attempt.id, outcome: "succeeded",
        receipt: attempt.provider_receipt || null, verifiedReceipt, successfulResults: 1,
        resultReference: saved.reference, resultSha256: saved.sha256, outcomeSha256: saved.sha256 });
      await authorize(session);
      return { task: settled, result };
    }
  };
}
