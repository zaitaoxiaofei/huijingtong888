import assert from "node:assert/strict";
import test from "node:test";
import { summarizeBillingExpenses, billingExpenseCategoryLabel } from "../frontend/admin/views/profit/billing-expense-categories.js";

test("operating expense breakdown keeps fixed AI, utilities, subsidies and salary distinct without duplicating totals", () => {
  const rows = [
    { category: "ai_subscription", amount_cny: "700.00" },
    { category: "rent", amount_cny: 2000 },
    { category: "utilities", amount_cny: 10.10 },
    { category: "utilities", amount_cny: 20.20 },
    { category: "subsidy", amount_cny: 100 },
    { category: "salary", amount_cny: 5000 },
    { category: "legacy_fee", amount_cny: 7 },
    { category: null, amount_cny: 3 }
  ];
  const result = summarizeBillingExpenses(rows);
  const category = (key) => result.find((item) => item.value === key);
  assert.equal(category("ai_subscription").amount, 700);
  assert.equal(category("utilities").amount, 30.30);
  assert.equal(category("utilities").count, 2);
  assert.equal(category("software").amount, 0);
  assert.equal(category("salary").amount, 5000);
  assert.equal(category("other").amount, 3);
  assert.equal(category("legacy_fee").amount, 7);
  assert.equal(result.reduce((sum, item) => sum + Math.round(item.amount * 100), 0), 784030);
  assert.equal(billingExpenseCategoryLabel("rent"), "场地租金");
});
