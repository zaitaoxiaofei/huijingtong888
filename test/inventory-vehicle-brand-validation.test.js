import test from "node:test";
import assert from "node:assert/strict";

import { validateVehicleBrand } from "../src/services/inventory-product-naming.js";

test("vehicle brand validation accepts plain English names", () => {
  assert.equal(validateVehicleBrand("HONGQI"), "HONGQI");
  assert.equal(validateVehicleBrand("Belgee"), "BELGEE");
  assert.equal(validateVehicleBrand("VOYAH"), "VOYAH");
  assert.equal(validateVehicleBrand("HONG\u200BQI"), "HONGQI");
});

test("vehicle brand validation accepts legacy dictionary separators", () => {
  assert.equal(validateVehicleBrand("红旗|HONGQI"), "HONGQI");
  assert.equal(validateVehicleBrand("HONGQI|"), "HONGQI");
  assert.equal(validateVehicleBrand("|VOYAH"), "VOYAH");
});

test("vehicle brand validation still rejects names without English letters", () => {
  assert.throws(() => validateVehicleBrand("红旗"), /俄罗斯市场使用的英文名称/);
});
