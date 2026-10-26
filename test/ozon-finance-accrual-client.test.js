import assert from "node:assert/strict";
import test from "node:test";
import { fetchOzonDailyAccruals, OZON_FINANCE_ACCRUAL_TYPES_ENDPOINT as TYPES, OZON_FINANCE_ACCRUAL_DAY_ENDPOINT as DAY } from "../src/services/ozon-finance-accrual-client.js";

const shop = { id: 10, tenant_id: 1 };
const types = { accrual_types: [{ id: 1, name: "Acquiring", description: "Collecting fee" }, { id: 2, name: "MarketplaceCommission", description: "Official type" }] };
const row = (id = 10, amount = "-1") => ({ accrual_id: id, date: "2026-10-25", total_amount: { amount, currency: "RUB" } });
const basic = request => fetchOzonDailyAccruals(shop, { from: "2026-10-25", to: "2026-10-25", request });

test("daily client uses exact typed POST payloads, Beijing inclusive dates and one type request", async () => {
  const calls = [];let gates = 0;
  const result = await fetchOzonDailyAccruals(shop, { from: "2026-10-24T16:00:00Z", to: "2026-10-26", beforeRequest: async () => { gates++;return shop; },
    request: async (path, payload, options) => { calls.push({ path, payload });assert.equal(options.method, "POST");assert.equal(options.shop, shop);return path === TYPES ? types : { accruals: [], last_id: "" }; } });
  assert.deepEqual(calls, [{ path: TYPES, payload: {} }, { path: DAY, payload: { date: "2026-10-25", last_id: "" } }, { path: DAY, payload: { date: "2026-10-26", last_id: "" } }]);
  assert.equal(gates, 3);assert.equal(result.requests, 3);assert.equal(result.days, 2);assert.equal(result.fetched, 0);assert.equal(result.source_endpoint, DAY);assert.deepEqual(result.types, types.accrual_types);
});

test("opaque nonempty cursors continue even after an empty page, and identical repeated IDs deduplicate", async () => {
  let page = 0;const cursors = [];
  const result = await basic(async (path, payload) => {
    if (path === TYPES) return types;cursors.push(payload.last_id);page++;
    return page === 1 ? { accruals: [row()], last_id: "cursor-A" } : page === 2 ? { accruals: [], last_id: "cursor-B" }
      : { accruals: [{ total_amount: { currency: "RUB", amount: "-1" }, date: "2026-10-25", accrual_id: 10 }, row(11)], last_id: "" };
  });
  assert.deepEqual(cursors, ["", "cursor-A", "cursor-B"]);assert.equal(result.fetched, 2);assert.equal(result.accruals.length, 2);assert.equal(result.requests, 4);
});

test("range and pagination limits reject before network I/O", async () => {
  for (const options of [{ from: "2026-01-01", to: "2026-02-01" }, { from: "2026-10-26", to: "2026-10-25" }, { from: "2026-02-30", to: "2026-03-01" }, { from: null, to: "2026-10-25" }, { from: "2026-10-25", to: "2026-10-25", maxPagesPerDay: 101 }]) {
    await assert.rejects(fetchOzonDailyAccruals(shop, { ...options, request: () => { throw Error("must not request"); } }), error => ["OZON_FINANCE_ACCRUAL_DATE_INVALID", "OZON_FINANCE_ACCRUAL_PAGE_LIMIT"].includes(error.code));
  }
});

test("malformed official response shapes and ambiguous type IDs never report empty success", async () => {
  for (const malformed of [{}, { accrual_types: null }, { accrual_types: [] }, { accrual_types: [{ type_id: 1, name: "wrong primary field" }] }, { accrual_types: [{ id: 1, description: "missing name" }] }, { accrual_types: [{ id: 1, name: "A" }, { id: 1, name: "B" }] }]) {
    await assert.rejects(basic(async () => malformed));
  }
  for (const malformed of [{}, { accruals: {}, last_id: "" }, { accruals: [] }, { accruals: [], last_id: null }, { accruals: [null], last_id: "" }, { accruals: [{ id: 1 }], last_id: "" }, { accruals: [row(Number.MAX_SAFE_INTEGER + 1)], last_id: "" }]) {
    await assert.rejects(basic(async path => path === TYPES ? types : malformed), { code: "OZON_FINANCE_ACCRUAL_SCHEMA_INVALID" });
  }
});

test("cursor loops, page exhaustion and conflicting repeated accruals fail before normalization", async () => {
  for (const mode of ["loop", "limit", "conflict"]) {
    let pages = 0, normalized = 0;
    await assert.rejects(fetchOzonDailyAccruals(shop, { from: "2026-10-25", to: "2026-10-25", maxPagesPerDay: 2,
      normalizeAccrual: value => { normalized++;return value; }, request: async path => {
        if (path === TYPES) return types;pages++;
        return mode === "conflict" ? { accruals: [row(10, pages === 1 ? "-1" : "-2")], last_id: pages === 1 ? "next" : "" }
          : { accruals: [], last_id: mode === "loop" ? "same" : "cursor-" + pages };
      } }), { code: mode === "loop" ? "OZON_FINANCE_ACCRUAL_CURSOR_LOOP" : mode === "limit" ? "OZON_FINANCE_ACCRUAL_PAGE_LIMIT" : "OZON_FINANCE_ACCRUAL_ID_CONFLICT" });
    assert.equal(normalized, 0);assert.equal(pages, 2);
  }
});

test("abort and revoked access stop before the next HTTP request, including requester retries", async () => {
  const controller = new AbortController();controller.abort();let calls = 0;
  await assert.rejects(fetchOzonDailyAccruals(shop, { from: "2026-10-25", to: "2026-10-25", signal: controller.signal, request: async () => { calls++;return types; } }), { name: "AbortError" });assert.equal(calls, 0);
  let gates = 0;calls = 0;
  const revoked = Object.assign(new Error("membership revoked"), { code: "TENANT_MEMBER_DISABLED" });
  await assert.rejects(fetchOzonDailyAccruals(shop, { from: "2026-10-25", to: "2026-10-25", beforeRequest: async () => { if (++gates === 2) throw revoked; },
    request: async (path, payload, options) => { calls++;await options.beforeRequest();throw Error("must not reach an HTTP retry"); } }), error => error === revoked);assert.equal(calls, 1);
  const during = new AbortController();calls = 0;
  await assert.rejects(fetchOzonDailyAccruals(shop, { from: "2026-10-25", to: "2026-10-25", signal: during.signal,
    request: async () => { calls++;during.abort();return types; } }), { name: "AbortError" });assert.equal(calls, 1);
});

test("429 and normalization failures propagate without implicit retry, fallback or discarded facts", async () => {
  const limited = Object.assign(new Error("HTTP 429"), { status: 429 });let calls = 0;
  await assert.rejects(basic(async () => { calls++;throw limited; }), error => error === limited);assert.equal(calls, 1);
  for (const normalizeAccrual of [() => null, () => [], () => undefined]) {
    await assert.rejects(fetchOzonDailyAccruals(shop, { from: "2026-10-25", to: "2026-10-25", normalizeAccrual,
      request: async path => path === TYPES ? types : { accruals: [row()], last_id: "" } }), { code: "OZON_FINANCE_ACCRUAL_NORMALIZE_INVALID" });
  }
  const normalized = await fetchOzonDailyAccruals(shop, { from: "2026-10-25", to: "2026-10-25", normalizeAccrual: (raw, context) => {
    assert.equal(context.typeById.get("1").name, "Acquiring");assert.equal(context.sourceEndpoint, DAY);return { operation_id: "accrual_by_day:" + raw.accrual_id, reconciliation: { ok: false }, raw_json: raw };
  }, request: async path => path === TYPES ? types : { accruals: [row()], last_id: "" } });
  assert.equal(normalized.accruals[0].reconciliation.ok, false);assert.equal(normalized.fetched, 1);
});
