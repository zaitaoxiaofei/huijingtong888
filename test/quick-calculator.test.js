import test from "node:test";
import assert from "node:assert/strict";
import { calculateExpression } from "../frontend/admin/utils/quick-calculator.js";

test("quick accounting respects decimal input, precedence, brackets and negative amounts", () => {
  assert.equal(calculateExpression("20 × 18.5 + 12"), "382");
  assert.equal(calculateExpression("(20 - 3) * 18.5 + 12"), "326.5");
  assert.equal(calculateExpression("0.1 + 0.2"), "0.3");
  assert.equal(calculateExpression("-(10 + 2) ÷ 3"), "-4");
  assert.equal(calculateExpression("200 * 15%"), "30");
  assert.equal(calculateExpression("1e+12 + 1"), "1000000000001");
});
test("calculator rejects incomplete, unsafe, excessive and non-finite expressions", () => {
  for (const value of ["", "2+", "1/0", "(1+2", "1+2)", "2(3)", "globalThis.alert(1)", "1;2", "1e999", "9999999999999999", "1".repeat(257)]) {
    assert.throws(() => calculateExpression(value));
  }
});
