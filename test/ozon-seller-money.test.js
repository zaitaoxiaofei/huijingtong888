import assert from "node:assert/strict";
import test from "node:test";
import { resolveOzonSellerMoney } from "../src/services/ozon-seller-money.js";

test("selected seller monetary objects preserve decimal precision and their own currency", () => {
  for (const key of ["price", "value", "amount"]) {
    assert.deepEqual(resolveOzonSellerMoney({ price: { [key]: "12,3456789", currency: "CNY" } }, "posting.products"),
      { amount: 12.3456789, verified: true, currency: "CNY", source: "posting.products.price" });
  }
  assert.deepEqual(resolveOzonSellerMoney({ seller_price: { amount: 0, currency_code: "cny" }, currency_code: " CNY " }, "posting.products", "seller_price"),
    { amount: 0, verified: true, currency: "CNY", source: "posting.products.seller_price" });
});

test("only the selected owner's primitive amount and currency_code are paired", () => {
  assert.deepEqual(resolveOzonSellerMoney({ price: "1 234,50001", currency_code: "RUB" }, "posting.products"),
    { amount: 1234.50001, verified: true, currency: "RUB", source: "posting.products.price" });
  const financialData = { price: { value: "42.00001", currency: "CNY" }, currency_code: "CNY" };
  assert.deepEqual(resolveOzonSellerMoney(financialData, "posting.products.financial_data"),
    { amount: 42.00001, verified: true, currency: "CNY", source: "posting.products.financial_data.price" });
});

test("customer RUB prices and commission currencies cannot change a selected CNY seller price", () => {
  const input = { price: { price: "123.450001", currency: "CNY" }, seller_price: { price: "123.45", currency: "CNY" },
    customer_price: { price: "1500", currency: "RUB" }, customer_currency_code: "RUB",
    financial_data: { price: { price: "1499", currency: "RUB" }, commission: { currency: "RUB" }, commissions_currency_code: "RUB" } };
  const before = JSON.stringify(input);
  assert.equal(resolveOzonSellerMoney(input, "posting.products").currency, "CNY");
  assert.equal(resolveOzonSellerMoney(input, "posting.products").amount, 123.450001);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(resolveOzonSellerMoney({ price: "123.45", ...Object.fromEntries(Object.entries(input).filter(([key]) => key !== "price")) }, "posting.products"),
    { amount: 123.45, verified: false, currency: "", source: "posting.products.price" });
});

test("conflicting selected price/owner currencies and contradictory amount fields stay unknown", () => {
  for (const owner of [
    { price: { price: 10, currency: "CNY" }, currency_code: "RUB" },
    { price: { price: 10, currency_code: "CNY", currency: "RUB" } },
    { price: { price: 10, value: 12, currency: "CNY" } },
    { price: { price: 10, currency: 1 } }, { price: { price: 10, currency: " " }, currency_code: "CNY" }
  ]) {
    const result = resolveOzonSellerMoney(owner, "posting.products");assert.equal(result.verified, false);assert.equal(result.currency, "");
  }
});

test("missing, nonnumeric, negative and unsafe amounts never become verified zero", () => {
  for (const price of [undefined, null, "", " ", "abc", "100 RUB", false, [], {}, { currency: "CNY" }, { price: -1, currency: "CNY" }, "9007199254740993", Infinity]) {
    const result = resolveOzonSellerMoney({ price, currency_code: "CNY" }, "posting.products");
    assert.equal(result.verified, false);assert.equal(result.amount, null);
  }
});

test("explicit unsupported seller currencies remain evidence for the downstream policy to block", () => {
  assert.deepEqual(resolveOzonSellerMoney({ price: { price: "10.000001", currency: "USD" } }, "posting.products"),
    { amount: 10.000001, verified: true, currency: "USD", source: "posting.products.price" });
  assert.equal(resolveOzonSellerMoney({ price: { price: 10, currency: "CNY" } }, "").verified, false);
});
