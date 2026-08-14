import assert from "node:assert/strict";
import test from "node:test";

import {
  currentEffectiveLogisticsRules,
  isLogisticsRuleEffective,
  resolveCurrentLogisticsRule
} from "../frontend/admin/utils/effective-logistics-rules.js";

const oldRule = {
  id: 10,
  version_group_id: 10,
  enabled: 1,
  effective_from: "1970-01-01T00:00:00.000Z",
  effective_to: "2026-07-23T16:00:00.000Z",
  per_gram_cny: 0.01768,
  per_ticket_cny: 37.44
};
const currentRule = {
  id: 11,
  version_group_id: 10,
  enabled: 1,
  effective_from: "2026-07-23T16:00:00.000Z",
  effective_to: null,
  per_gram_cny: 0.0191,
  per_ticket_cny: 40.44
};

test("effective rules use Beijing time boundaries", () => {
  assert.equal(isLogisticsRuleEffective(oldRule, "2026-07-23T15:59:59Z"), true);
  assert.equal(isLogisticsRuleEffective(oldRule, "2026-07-23T16:00:00Z"), false);
  assert.equal(isLogisticsRuleEffective(currentRule, "2026-07-23T16:00:00Z"), true);
});

test("inventory resolves an old binding to the currently effective version", () => {
  const at = "2026-07-27T00:00:00+08:00";
  assert.deepEqual(currentEffectiveLogisticsRules([oldRule, currentRule], at).map((rule) => rule.id), [11]);
  assert.equal(resolveCurrentLogisticsRule([oldRule, currentRule], oldRule.id, at)?.id, currentRule.id);
});
