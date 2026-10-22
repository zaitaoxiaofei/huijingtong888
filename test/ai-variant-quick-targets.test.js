import assert from "node:assert/strict";
import test from "node:test";
import { availableQuickTargets, parseQuickTargets, quickTargetHistory, quickTargetsFromQuery, vehicleTargetKey } from "../frontend/admin/utils/ai-variant-quick-targets.js";

test("quick targets preserve a real catalog model containing slash and deduplicate normalized labels", () => {
  assert.deepEqual(parseQuickTargets("CHANGAN UNI-S / CS55 Plus\nTENET T7， tenet   t7 ; ＴＥＮＥＴ T7\nOMODA C5"), ["CHANGAN UNI-S / CS55 Plus", "TENET T7", "OMODA C5"]);
  assert.equal(vehicleTargetKey(" ＴＥＮＥＴ  T7 "), "tenet t7");
});

test("history matches complete target names and never treats T4 as T4 Plus", () => {
  const history = [{ target_value: "TENET  T4", status: "completed" }];
  assert.equal(quickTargetHistory("tenet t4", history).status, "completed");
  assert.equal(quickTargetHistory("TENET T4 Plus", history), null);
  assert.equal(quickTargetHistory("OTHER T4", history), null);
});

test("structured quick-case handoff preserves slash model names and rejects damaged payloads", () => {
  assert.deepEqual(quickTargetsFromQuery({ caseTargetValues: JSON.stringify(["CHANGAN UNI-S / CS55 Plus", "TENET T7"]) }), ["CHANGAN UNI-S / CS55 Plus", "TENET T7"]);
  assert.equal(quickTargetsFromQuery({ caseTargets: "TENET T7" }), null);
  assert.deepEqual(quickTargetsFromQuery({ caseTargetValues: "broken", caseTargets: "stale" }), []);
  assert.deepEqual(quickTargetsFromQuery({ caseTargetValues: '[{"model":"invalid"}]' }), []);
});

test("bulk selection excludes source, completed and working targets while allowing failed retries", () => {
  const models = ["TENET T4", "TENET T7", "TENET T8", "TENET T9", "TENET T10"].map(fullName => ({ fullName }));
  const history = [{ target_value: "TENET T7", status: "completed" }, { target_value: "TENET T8", status: "in_progress" }, { target_value: "TENET T9", status: "failed" }];
  assert.deepEqual(availableQuickTargets(models, "tenet t4", history), ["TENET T9", "TENET T10"]);
});
