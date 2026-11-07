import { createHash } from "node:crypto";
import { assertProfitFormulaSupported } from "./profit-formulas/registry.js";

const volatileKeys = new Set(["updated_at", "last_synced_at", "synced_at", "synced_at_ms", "fetched_at", "collected_at", "refreshed_at", "recorded_at"]);
const privateKey = /(?:password|secret|token|cookie|authorization|buyer|customer|recipient|address|phone|email)/i;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => JSON.stringify(value);
const parse = (value, fallback = null) => { try { return typeof value === "string" ? JSON.parse(value) : value ?? fallback; } catch { return fallback; } };
const rows = (result) => Array.isArray(result?.[0]) ? result[0] : result;
const resultHeader = (result) => Array.isArray(result) ? result[0] : result;
const pointerFor = (layer) => layer === "actual" ? "current_actual_revision_id" : "current_estimate_revision_id";

export function profitCalculationTenantKey(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? String(number) : "admin";
}

export function normalizeProfitCalculationSnapshot(value, key = "") {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Profit calculation inputs must contain finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    const normalized = value.map((item) => normalizeProfitCalculationSnapshot(item));
    // Finance facts form a set. Item/variant arrays may carry meaningful order.
    return /finance|financial/i.test(key) ? normalized.sort((a, b) => json(a).localeCompare(json(b))) : normalized;
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().filter((field) => !volatileKeys.has(field) && !privateKey.test(field))
      .map((field) => [field, normalizeProfitCalculationSnapshot(value[field], field)]));
  }
  return value;
}

export function profitCalculationFingerprint(value) {
  return hash(json(normalizeProfitCalculationSnapshot(value)));
}

function scope(input) {
  const orderItemId = Number(input.orderItemId);
  const orderId = Number(input.orderId);
  if (!Number.isSafeInteger(orderItemId) || orderItemId <= 0 || !Number.isSafeInteger(orderId) || orderId <= 0) {
    throw new Error("Profit calculation requires an order ID and item ID");
  }
  if (input.tenantId === undefined || input.tenantId === null || input.tenantId === "") throw new Error("Profit calculation requires authoritative tenant ownership");
  return { tenantKey: profitCalculationTenantKey(input.tenantId), orderItemId, orderId };
}

async function lockState(connection, input, create = true) {
  const { tenantKey, orderItemId, orderId } = scope(input);
  if (input.initialFormulaVersion !== undefined) assertProfitFormulaSupported(input.initialFormulaVersion);
  // Duplicate-key INSERT IGNORE takes a shared record lock. Concurrent writers
  // then deadlock while both upgrade it in SELECT FOR UPDATE. A no-op upsert
  // obtains the exclusive lock immediately and preserves every existing field.
  if (create && input.initialFormulaVersion === "V2") {
    assertProfitFormulaSupported(input.initialFormulaVersion);
    await connection.execute(`INSERT INTO order_profit_calc_state
      (tenant_key, order_item_id, order_id, formula_version, legacy_baseline) VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE order_item_id = VALUES(order_item_id)`,
    [tenantKey, orderItemId, orderId, input.initialFormulaVersion, input.legacy ? 1 : 0]);
  } else if (create) await connection.execute(`INSERT INTO order_profit_calc_state
    (tenant_key, order_item_id, order_id, formula_version, legacy_baseline) VALUES (?, ?, ?, 'V1', ?)
    ON DUPLICATE KEY UPDATE order_item_id = VALUES(order_item_id)`,
  [tenantKey, orderItemId, orderId, input.legacy ? 1 : 0]);
  const [state] = rows(await connection.query(`SELECT * FROM order_profit_calc_state
    WHERE tenant_key = ? AND order_item_id = ? FOR UPDATE`, [tenantKey, orderItemId]));
  if (!state || Number(state.order_id) !== orderId) throw new Error("Profit calculation state does not belong to the order");
  assertProfitFormulaSupported(state.formula_version);
  return state;
}

// The provider must begin/commit/rollback the WHOLE business transaction for
// every invocation. Never pass an existing connection or a statement runner.
// A deadlock can have rolled back all earlier writes, not just the failed SQL.
export async function retryProfitCalculationTransaction(transaction, callback, { maxAttempts = 3, sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const attempts = Math.min(5, Math.max(1, Number(maxAttempts) || 3));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await transaction(callback); }
    catch (error) {
      if ((error?.code !== "ER_LOCK_DEADLOCK" && Number(error?.errno) !== 1213) || attempt === attempts) throw error;
      await sleepImpl(attempt * 25);
    }
  }
}

// Call only inside an existing transaction, with its mysql2 connection. This
// module never opens another connection or commits the caller's transaction.
export async function ensureOrderProfitCalculationState(connection, input) {
  let state = await lockState(connection, input);
  if (!input.legacy) return state;
  if (!state.legacy_baseline && Number(state.revision_count || 0) > 0) return state;
  if (!state.legacy_baseline) {
    const { tenantKey, orderItemId } = scope(input);
    await connection.execute("UPDATE order_profit_calc_state SET legacy_baseline = 1 WHERE tenant_key = ? AND order_item_id = ?", [tenantKey, orderItemId]);
    state = { ...state, legacy_baseline: 1 };
  }
  for (const [layer, output] of [["estimate", input.baselineEstimate], ["actual", input.baselineActual]]) {
    if (output === undefined || output === null || state[pointerFor(layer)]) continue;
    const recorded = await recordOrderProfitCalculation(connection, {
      ...input, layer, formulaVersion: state.formula_version, legacyBaseline: true,
      inputCompleteness: "legacy_unknown", inputs: { input_completeness: "legacy_unknown" },
      outputs: output, source: "legacy_baseline", reason: "Preserved existing values without recalculation",
      rateVersion: input.rateVersion ?? null, costVersion: input.costVersion ?? null
    });
    state = recorded.state;
  }
  return state;
}

export async function recordOrderProfitCalculation(connection, input) {
  const { tenantKey, orderItemId, orderId } = scope(input);
  if (!["estimate", "actual"].includes(input.layer)) throw new Error("Profit calculation layer must be estimate or actual");
  const state = await lockState(connection, input);
  const formulaVersion = assertProfitFormulaSupported(input.formulaVersion === undefined ? state.formula_version : input.formulaVersion,
    { operation: input.layer === "actual" ? "finance" : "estimate" });
  if (formulaVersion !== state.formula_version) throw new Error("A formula upgrade requires an explicit supported version migration");
  const pointer = pointerFor(input.layer);
  const current = state[pointer] ? rows(await connection.query(`SELECT * FROM order_profit_calc_revisions
    WHERE tenant_key = ? AND order_item_id = ? AND id = ?`, [tenantKey, orderItemId, state[pointer]]))[0] : null;
  const inputs = normalizeProfitCalculationSnapshot(input.inputs ?? {});
  const outputs = normalizeProfitCalculationSnapshot(input.outputs ?? {});
  const rateVersion = normalizeProfitCalculationSnapshot(input.rateVersion ?? null);
  const costVersion = normalizeProfitCalculationSnapshot(input.costVersion ?? null);
  const inputHash = profitCalculationFingerprint({ formula_version: formulaVersion, inputs, rate_version: rateVersion, cost_version: costVersion });
  const outputHash = profitCalculationFingerprint(outputs);
  const commandId = String(input.commandId || "").trim();
  if (commandId.length > 128) throw new Error("Profit calculation command ID exceeds 128 characters");
  if (current && !commandId && current.input_hash === inputHash && current.output_hash === outputHash) {
    return { changed: false, revision: current, state, reason: "unchanged" };
  }
  if (current?.legacy_baseline && input.preserveBaseline && !commandId) {
    return { changed: false, revision: current, state, reason: "legacy_baseline_preserved" };
  }
  // Include the parent in automatic keys: A -> B -> A is a genuine new state.
  // Explicit commands retain their key across retries even after later writes.
  const idempotencyKey = hash(commandId ? `command:${commandId}` : json([state[pointer] || null, inputHash, outputHash]));
  const existing = rows(await connection.query(`SELECT * FROM order_profit_calc_revisions
    WHERE tenant_key = ? AND order_item_id = ? AND layer = ? AND idempotency_key = ?`,
  [tenantKey, orderItemId, input.layer, idempotencyKey]))[0];
  if (existing) {
    if (existing.input_hash !== inputHash || existing.output_hash !== outputHash) {
      throw Object.assign(new Error("Profit calculation command was retried with different business values"), { code: "PROFIT_CALCULATION_IDEMPOTENCY_CONFLICT" });
    }
    return { changed: false, revision: existing, state, reason: "duplicate_command" };
  }
  const revisionNo = Number(state.revision_count || 0) + 1;
  const inserted = resultHeader(await connection.execute(`INSERT INTO order_profit_calc_revisions
    (tenant_key, order_item_id, order_id, revision_no, layer, formula_version, legacy_baseline,
      input_completeness, input_hash, output_hash, idempotency_key, rate_version_json, cost_version_json,
      inputs_json, outputs_json, parent_revision_id, source, reason, actor_id, command_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    tenantKey, orderItemId, orderId, revisionNo, input.layer, formulaVersion, input.legacyBaseline ? 1 : 0,
    input.inputCompleteness || "complete", inputHash, outputHash, idempotencyKey, json(rateVersion), json(costVersion),
    json(inputs), json(outputs), state[pointer] || null, input.source || "calculation", input.reason || "",
    Number(input.actorId) > 0 ? Number(input.actorId) : null, commandId || null
  ]));
  const revision = { id: Number(inserted.insertId), tenant_key: tenantKey, order_item_id: orderItemId, order_id: orderId,
    revision_no: revisionNo, layer: input.layer, formula_version: formulaVersion, input_hash: inputHash, output_hash: outputHash,
    legacy_baseline: input.legacyBaseline ? 1 : 0 };
  await connection.execute(`UPDATE order_profit_calc_state SET ${pointer} = ?, revision_count = ?, updated_at = CURRENT_TIMESTAMP
    WHERE tenant_key = ? AND order_item_id = ?`, [revision.id, revisionNo, tenantKey, orderItemId]);
  const nextState = { ...state, [pointer]: revision.id, revision_count: revisionNo };
  if (input.project) await input.project({ connection, revision, state: nextState });
  return { changed: true, revision, state: nextState, reason: "recorded" };
}

export async function getPinnedProfitFormulaVersion(deps, orderItemId) {
  if (deps.tenantId === undefined) throw new Error("Profit version lookup requires authoritative tenant ownership");
  const [state] = rows(await deps.query(`SELECT formula_version FROM order_profit_calc_state
    WHERE tenant_key = ? AND order_item_id = ?`, [profitCalculationTenantKey(deps.tenantId), Number(orderItemId)]));
  return state ? assertProfitFormulaSupported(state.formula_version) : "V1";
}

export async function readOrderProfitCalculationVersions(deps, { tenantId, orderId, limitPerItem = 20 }) {
  if (tenantId === undefined) throw new Error("Profit history lookup requires authoritative tenant ownership");
  const tenantKey = profitCalculationTenantKey(tenantId);
  const states = rows(await deps.query(`SELECT * FROM order_profit_calc_state WHERE tenant_key = ? AND order_id = ? ORDER BY order_item_id`, [tenantKey, Number(orderId)]));
  const limit = Math.min(100, Math.max(1, Number(limitPerItem) || 20));
  const items = [];
  for (const state of states) {
    assertProfitFormulaSupported(state.formula_version);
    const history = rows(await deps.query(`SELECT * FROM order_profit_calc_revisions WHERE tenant_key = ? AND order_item_id = ? ORDER BY revision_no DESC LIMIT ?`,
      [tenantKey, state.order_item_id, limit]));
    const decode = row => row ? ({ ...row, legacy_baseline: Boolean(row.legacy_baseline),
      rate_version: parse(row.rate_version_json), cost_version: parse(row.cost_version_json),
      inputs: parse(row.inputs_json, {}), outputs: parse(row.outputs_json, {}) }) : null;
    const [firstEstimate] = state.formula_version === "V2" ? rows(await deps.query(`SELECT * FROM order_profit_calc_revisions
      WHERE tenant_key = ? AND order_item_id = ? AND layer = 'estimate' AND formula_version = 'V2'
        AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(inputs_json, '$.estimate.fxPending')), 'false') <> 'true'
      ORDER BY revision_no LIMIT 1`, [tenantKey, state.order_item_id])) : [];
    items.push({ ...state, legacy_baseline: Boolean(state.legacy_baseline), history_count: Number(state.revision_count || 0),
      truncated: Number(state.revision_count || 0) > history.length,
      ...(state.formula_version === "V2" ? { first_estimate_revision: decode(firstEstimate) } : {}),
      revisions: history.map(decode) });
  }
  return { available: items.length > 0, items };
}
