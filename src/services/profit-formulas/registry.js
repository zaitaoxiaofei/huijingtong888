import * as v1 from "./v1/profit.js";
import * as outcome from "./v1/order-outcome.js";
import * as aggregation from "./v1/aggregation.js";
import * as v2 from "./v2/profit.js";
import * as aggregationV2 from "./v2/aggregation.js";
import * as outcomeV2 from "./v2/order-outcome.js";
import * as outcomeV3 from "./v3/order-outcome.js";
import * as aggregationV3 from "./v3/aggregation.js";
import * as outcomeV4 from "./v4/order-outcome.js";

// V1 is a frozen dependency closure. Define V2 in a separate directory only
// after both estimated and finance/aftersale semantics have been approved.
const formulas = Object.freeze({
  V1: Object.freeze({ version: "V1", ...v1, ...aggregation, outcome }),
  V2: Object.freeze({ version: "V2", ...v2, ...aggregationV2, outcome: outcomeV2 }),
  V3: Object.freeze({ version: "V3", ...v1, ...aggregationV3, outcome: outcomeV3 }),
  V4: Object.freeze({ version: "V4", ...v2, ...aggregationV3, outcome: outcomeV4 })
});

export function assertProfitFormulaSupported(version, { operation = "estimate" } = {}) {
  const normalized = String(version || "").trim();
  if (!Object.hasOwn(formulas, normalized)) {
    throw Object.assign(new Error(`Unsupported profit formula version: ${normalized || "missing"} (${operation})`), {
      code: "UNSUPPORTED_PROFIT_FORMULA_VERSION", statusCode: 409
    });
  }
  // Finance and outcome allocation currently live in mysql-cutover. V2 must
  // acquire its own explicit branch there before this guard can accept it.
  if (operation === "historical_repair" && normalized !== "V1") {
    throw Object.assign(new Error(`Profit ${operation} formula is not implemented: ${normalized}`), {
      code: "UNSUPPORTED_PROFIT_FORMULA_VERSION", statusCode: 409
    });
  }
  return normalized;
}

export function getProfitFormula(version) {
  return formulas[assertProfitFormulaSupported(version)];
}

export function registeredProfitFormulaVersions() {
  return Object.keys(formulas);
}

export function usesDailyProfitFx(version) { return version === 'V2' || version === 'V4'; }
